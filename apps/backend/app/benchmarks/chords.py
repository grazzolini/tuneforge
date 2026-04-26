from __future__ import annotations

import argparse
import json
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

import soundfile as sf

from app.engines.crema_chords import clear_crema_model_cache
from app.services.chord_backends import (
    CREMA_CHORD_BACKEND_ID,
    FAST_CHORD_BACKEND_ID,
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
    parser.add_argument("--audio", required=True, type=Path, help="Path to an audio file.")
    parser.add_argument(
        "--backend",
        action="append",
        dest="backends",
        help="Backend id or alias. Repeat to benchmark multiple backends. Defaults to built-in and advanced.",
    )
    parser.add_argument("--json-only", action="store_true", help="Only write machine-readable JSON to stdout.")
    args = parser.parse_args(argv)

    backend_ids = [resolve_chord_backend_id(backend) for backend in args.backends] if args.backends else None
    report = build_benchmark_report(args.audio, backend_ids)
    sys.stdout.write(json.dumps(report, indent=2))
    sys.stdout.write("\n")
    if not args.json_only:
        sys.stderr.write(summarize_report(report))
        sys.stderr.write("\n")
    return 0


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
