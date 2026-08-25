from __future__ import annotations

import argparse
import json
import re
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

import soundfile as sf

from app.benchmarks.chord_evaluation import (
    PROJECTION_VERSION,
    SCHEMA_VERSION,
    SCORER_VERSION,
    SYNTHETIC_VERSION,
    ManifestError,
    QualityTrack,
    aggregate_scores,
    cleanup_synthetic_tracks,
    load_manifest,
    load_public_manifest,
    score_sequence,
    score_timeline,
    synthetic_tracks,
)
from app.engines.crema_chords import clear_crema_model_cache
from app.engines.lv_chordia import clear_lv_chordia_session_cache
from app.services.audio_working import materialize_pcm_wav
from app.services.chord_backends import (
    CREMA_CHORD_BACKEND_ID,
    FAST_CHORD_BACKEND_ID,
    LV_CHORDIA_CHORD_BACKEND_ID,
    detect_with_chord_backend,
    resolve_chord_backend,
    resolve_chord_backend_id,
)

DEFAULT_BENCHMARK_BACKENDS = (FAST_CHORD_BACKEND_ID, CREMA_CHORD_BACKEND_ID)
SEVENTH_QUALITIES = {"7", "maj7", "m7", "dim7", "hdim7"}


def build_benchmark_report(audio_path: Path, backend_ids: list[str] | None = None) -> dict[str, Any]:
    resolved_audio_path = audio_path.expanduser().resolve()
    selected_backend_ids = backend_ids or list(DEFAULT_BENCHMARK_BACKENDS)
    return {
        "audio_path": str(resolved_audio_path),
        "track_duration_seconds": _track_duration_seconds(resolved_audio_path),
        "results": [_benchmark_backend(resolved_audio_path, backend_id) for backend_id in selected_backend_ids],
    }


def summarize_report(report: dict[str, Any]) -> str:
    if report.get("schema_version") == SCHEMA_VERSION:
        lines = ["Chord quality benchmark"]
        for result in report.get("results", []):
            backend_id = result.get("backend_id", "backend")
            errors = result.get("error_count", 0)
            lines.append(f"- {backend_id}: quality evaluation, {errors} sanitized errors")
        return "\n".join(lines)
    lines = [
        f"Chord benchmark: {report['audio_path']}",
        f"Track duration: {report['track_duration_seconds']}",
    ]
    for result in report["results"]:
        if not result["available"]:
            lines.append(f"- {result['backend_id']}: unavailable ({result['unavailable_reason']})")
            continue
        lines.append(
            "- {backend_id}: cold {cold:.3f}s, warm {warm:.3f}s, {segments} segments, "
            "{qualities} qualities, sevenths {sevenths}, slash {slashes}, no-chord {no_chord}".format(
                backend_id=result["backend_id"],
                cold=result["cold_runtime_seconds"],
                warm=result["warm_runtime_seconds"],
                segments=result["number_of_chord_segments"],
                qualities=result["number_of_unique_chord_qualities"],
                sevenths=result["number_of_seventh_chords"],
                slashes=result["number_of_slash_or_inversion_chords"],
                no_chord=result["contains_no_chord_segments"],
            )
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark TuneForge chord detection backends.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--audio", type=Path, help="Path to an audio file.")
    mode.add_argument(
        "--quality-synthetic", action="store_true", help="Run deterministic synthetic quality evaluation."
    )
    mode.add_argument(
        "--quality-manifest",
        action="append",
        type=Path,
        dest="quality_manifests",
        help="Manifest path. Repeat for multiple manifests.",
    )
    parser.add_argument("--data-root", type=Path, help="Root used only to resolve quality-manifest audio paths.")
    parser.add_argument(
        "--backend",
        action="append",
        dest="backends",
        help="Backend id or alias. Repeat to benchmark multiple backends. Defaults to built-in and advanced.",
    )
    parser.add_argument("--json-only", action="store_true", help="Only write machine-readable JSON to stdout.")
    args = parser.parse_args(argv)

    backend_ids = [resolve_chord_backend_id(backend) for backend in args.backends] if args.backends else None
    if args.audio is not None:
        report = build_benchmark_report(args.audio, backend_ids)
    else:
        try:
            report = build_quality_report(
                synthetic=args.quality_synthetic,
                manifest_paths=args.quality_manifests or [],
                data_root=args.data_root,
                backend_ids=backend_ids,
            )
        except ManifestError as exc:
            sys.stderr.write(f"Chord quality benchmark failed: {exc}\n")
            return 2
    sys.stdout.write(json.dumps(report, indent=2))
    sys.stdout.write("\n")
    if not args.json_only:
        sys.stderr.write(summarize_report(report))
        sys.stderr.write("\n")
    return 0


def build_quality_report(
    *,
    synthetic: bool,
    manifest_paths: list[Path],
    data_root: Path | None,
    backend_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Run an anonymous quality report; never retain source identities or labels."""
    if not synthetic and (data_root is None or not manifest_paths):
        raise ManifestError("quality_data_root_required")
    selected_backend_ids = backend_ids or list(DEFAULT_BENCHMARK_BACKENDS)
    tracks = synthetic_tracks() if synthetic else _load_quality_tracks(manifest_paths, data_root)
    backends = {
        backend_id: resolve_chord_backend(backend_id, require_available=False) for backend_id in selected_backend_ids
    }
    try:
        per_backend: dict[str, list[dict[str, Any]]] = {backend_id: [] for backend_id in selected_backend_ids}
        errors: dict[str, int] = {backend_id: 0 for backend_id in selected_backend_ids}
        provenance = {
            backend.id: _safe_backend_provenance(backend.id, backend.label, backend.availability().available)
            for backend in backends.values()
        }
        for track in tracks:
            # Exactly one decode/materialization scope per track; every backend sees this path.
            try:
                with materialize_pcm_wav(track.audio_path) as working_path:
                    for backend in backends.values():
                        availability = backend.availability()
                        if not availability.available:
                            errors[backend.id] = errors.get(backend.id, 0) + 1
                            continue
                        try:
                            result = detect_with_chord_backend(working_path, backend.id)
                            provenance[backend.id] = _safe_backend_provenance(
                                backend.id, backend.label, True, result.metadata
                            )
                            score = (
                                score_timeline(
                                    track.reference,
                                    result.segments,
                                    extension_scoreable=track.extension_scoreable,
                                    bass_scoreable=track.bass_scoreable,
                                )
                                if track.timeline
                                else score_sequence(
                                    track.reference,
                                    [
                                        value
                                        if isinstance(value := segment.get("raw_label", segment.get("label")), str)
                                        else "?"
                                        for segment in result.segments
                                    ],
                                )
                            )
                            per_backend[backend.id].append(
                                {
                                    "dataset": track.dataset,
                                    "strata": track.strata,
                                    "score": score,
                                    "public_provenance": track.public_provenance,
                                }
                            )
                        except Exception:
                            errors[backend.id] = errors.get(backend.id, 0) + 1
            except Exception:
                for backend in backends.values():
                    errors[backend.id] = errors.get(backend.id, 0) + 1
        return _anonymous_quality_report(per_backend, errors, provenance)
    finally:
        if synthetic:
            cleanup_synthetic_tracks(tracks)


def _load_quality_tracks(paths: list[Path], data_root: Path | None) -> list[QualityTrack]:
    assert data_root is not None
    tracks: list[QualityTrack] = []
    for manifest_index, path in enumerate(paths, 1):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ManifestError("manifest_invalid") from exc
        schema = payload.get("schema_version") if isinstance(payload, dict) else None
        if schema == "chord-public-manifest-v1":
            tracks.extend(load_public_manifest(path, data_root))
        elif schema == "chord-quality-manifest-v1":
            external_dataset = f"dataset_{manifest_index:03d}"
            tracks.extend(
                QualityTrack(
                    external_dataset,
                    track.slot,
                    track.strata,
                    track.audio_path,
                    track.reference,
                    track.timeline,
                    track.extension_scoreable,
                    track.bass_scoreable,
                    track.audio_sha256,
                    track.public_provenance,
                )
                for track in load_manifest(path, data_root)
            )
        else:
            raise ManifestError("manifest_schema_invalid")
    return tracks


def _safe_backend_provenance(
    backend_id: str, label: str, available: bool, metadata: dict[str, Any] | None = None
) -> dict[str, Any]:
    safe_metadata: dict[str, str] = {}
    for key, value in (metadata or {}).items():
        if (
            key
            in {
                "engine",
                "analysis_version",
                "model",
                "model_version",
                "runtime_device",
                "crema_version",
                "tensorflow_version",
                "source_revision",
                "vocabulary",
                "checkpoint_count",
                "checkpoint_bytes",
            }
            and isinstance(value, (str, int, float))
            and _is_safe_provenance_value(str(value))
        ):
            safe_metadata[key] = str(value)[:80]
    return {"backend_id": backend_id, "backend_label": label, "available": available, "provenance": safe_metadata}


def _anonymous_quality_report(
    per_backend: dict[str, list[dict[str, Any]]],
    errors: dict[str, int],
    provenance: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for backend_id in sorted(per_backend):
        rows = per_backend[backend_id]
        datasets: dict[str, Any] = {}
        for dataset in sorted({str(row["dataset"]) for row in rows}):
            selected = [row["score"] for row in rows if row["dataset"] == dataset]
            strata: dict[str, Any] = {}
            for stratum in sorted({item for row in rows if row["dataset"] == dataset for item in row["strata"]}):
                strata[stratum] = aggregate_scores(
                    [row["score"] for row in rows if row["dataset"] == dataset and stratum in row["strata"]]
                )
            public_provenance = next(
                (row["public_provenance"] for row in rows if row["dataset"] == dataset and row["public_provenance"]),
                None,
            )
            datasets[dataset] = {
                "aggregate": aggregate_scores(selected),
                "strata": strata,
                **({"provenance": public_provenance} if public_provenance else {}),
            }
        results.append(
            {
                **provenance.get(backend_id, {"backend_id": backend_id, "available": False, "provenance": {}}),
                "datasets": datasets,
                "aggregate": aggregate_scores([row["score"] for row in rows]),
                "error_count": errors.get(backend_id, 0),
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "scorer": {
            "version": SCORER_VERSION,
            "projection_version": PROJECTION_VERSION,
            "synthetic_version": SYNTHETIC_VERSION,
            "tool_version": "app.benchmarks.chords-v1",
        },
        "results": results,
    }


def _is_safe_provenance_value(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_.+-]+", value)) and not any(
        token in value.lower() for token in ("private", "secret")
    )


def _benchmark_backend(audio_path: Path, backend_id: str) -> dict[str, Any]:
    backend = resolve_chord_backend(backend_id, require_available=False)
    availability = backend.availability()
    base: dict[str, Any] = {
        "backend_id": backend.id,
        "backend_label": backend.label,
        "available": availability.available,
        "unavailable_reason": availability.unavailable_reason,
    }
    if not availability.available:
        return {
            **base,
            "cold_runtime_seconds": None,
            "warm_runtime_seconds": None,
            "cold_peak_memory_bytes": None,
            "warm_peak_memory_bytes": None,
            "peak_memory_bytes": None,
            "number_of_chord_segments": 0,
            "number_of_unique_chord_qualities": 0,
            "number_of_seventh_chords": 0,
            "number_of_slash_or_inversion_chords": 0,
            "contains_no_chord_segments": False,
            "error": None,
        }

    if backend.id == CREMA_CHORD_BACKEND_ID:
        clear_crema_model_cache()
    elif backend.id == LV_CHORDIA_CHORD_BACKEND_ID:
        clear_lv_chordia_session_cache()

    try:
        cold = _timed_detect(audio_path, backend.id)
        warm = _timed_detect(audio_path, backend.id)
    except Exception as exc:  # pragma: no cover - command should report backend failures.
        return {
            **base,
            "available": False,
            "unavailable_reason": str(exc),
            "cold_runtime_seconds": None,
            "warm_runtime_seconds": None,
            "cold_peak_memory_bytes": None,
            "warm_peak_memory_bytes": None,
            "peak_memory_bytes": None,
            "number_of_chord_segments": 0,
            "number_of_unique_chord_qualities": 0,
            "number_of_seventh_chords": 0,
            "number_of_slash_or_inversion_chords": 0,
            "contains_no_chord_segments": False,
            "error": str(exc),
        }

    return {
        **base,
        "cold_runtime_seconds": cold["runtime_seconds"],
        "warm_runtime_seconds": warm["runtime_seconds"],
        "cold_peak_memory_bytes": cold["peak_memory_bytes"],
        "warm_peak_memory_bytes": warm["peak_memory_bytes"],
        "peak_memory_bytes": max(cold["peak_memory_bytes"], warm["peak_memory_bytes"]),
        **_segment_metrics(warm["segments"]),
        "error": None,
    }


def _timed_detect(audio_path: Path, backend_id: str) -> dict[str, Any]:
    tracemalloc.start()
    started_at = time.perf_counter()
    result = detect_with_chord_backend(audio_path, backend_id)
    runtime_seconds = time.perf_counter() - started_at
    _, peak_memory_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        "runtime_seconds": round(runtime_seconds, 6),
        "peak_memory_bytes": peak_memory_bytes,
        "segments": result.segments,
    }


def _segment_metrics(segments: list[dict[str, Any]]) -> dict[str, Any]:
    qualities = {
        quality
        for quality in (segment.get("quality") for segment in segments)
        if isinstance(quality, str) and quality != "no_chord"
    }
    return {
        "number_of_chord_segments": len(segments),
        "number_of_unique_chord_qualities": len(qualities),
        "number_of_seventh_chords": sum(1 for segment in segments if segment.get("quality") in SEVENTH_QUALITIES),
        "number_of_slash_or_inversion_chords": sum(1 for segment in segments if _has_bass_note(segment)),
        "contains_no_chord_segments": any(_is_no_chord(segment) for segment in segments),
    }


def _has_bass_note(segment: dict[str, Any]) -> bool:
    bass_pitch_class = segment.get("bass_pitch_class")
    root_pitch_class = segment.get("root_pitch_class", segment.get("pitch_class"))
    return isinstance(bass_pitch_class, int) and bass_pitch_class != root_pitch_class


def _is_no_chord(segment: dict[str, Any]) -> bool:
    return segment.get("quality") == "no_chord" or segment.get("label") == "N.C."


def _track_duration_seconds(audio_path: Path) -> float | None:
    try:
        info = sf.info(str(audio_path))
    except RuntimeError:
        return None
    if info.samplerate <= 0:
        return None
    return round(float(info.frames / info.samplerate), 3)


if __name__ == "__main__":
    raise SystemExit(main())
