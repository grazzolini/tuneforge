from __future__ import annotations

import argparse
import inspect
import json
import os
import re
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from app.engines import beat_this as beat_this_engine
from app.engines.analysis import AnalysisTimingPayload, analyze_track

AUDIO_EXTENSIONS = {".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"}
SAFE_NAME_PATTERN = re.compile(r"[^A-Za-z0-9._/-]+")
BUILT_IN_BACKEND_ID = "built-in"
BEAT_THIS_SMALL_BACKEND_ID = "beat-this-small0"
BEAT_THIS_FINAL_BACKEND_ID = "beat-this-final0"
DEFAULT_BENCHMARK_BACKENDS = (BUILT_IN_BACKEND_ID,)
COMPARISON_BENCHMARK_BACKENDS = (
    BUILT_IN_BACKEND_ID,
    BEAT_THIS_SMALL_BACKEND_ID,
    BEAT_THIS_FINAL_BACKEND_ID,
)
BEAT_THIS_BACKEND_CHECKPOINTS = {
    BEAT_THIS_SMALL_BACKEND_ID: "small0",
    BEAT_THIS_FINAL_BACKEND_ID: "final0",
}
BACKEND_ALIASES = {
    "default": BUILT_IN_BACKEND_ID,
    "detected": BUILT_IN_BACKEND_ID,
    "heuristic": BUILT_IN_BACKEND_ID,
    "built-in": BUILT_IN_BACKEND_ID,
    "tuneforge": BUILT_IN_BACKEND_ID,
    "tuneforge-built-in": BUILT_IN_BACKEND_ID,
    "beat-this-small0": BEAT_THIS_SMALL_BACKEND_ID,
    "beat-this-small": BEAT_THIS_SMALL_BACKEND_ID,
    "small0": BEAT_THIS_SMALL_BACKEND_ID,
    "small": BEAT_THIS_SMALL_BACKEND_ID,
    "beat-this-final0": BEAT_THIS_FINAL_BACKEND_ID,
    "beat-this-final": BEAT_THIS_FINAL_BACKEND_ID,
    "final0": BEAT_THIS_FINAL_BACKEND_ID,
    "final": BEAT_THIS_FINAL_BACKEND_ID,
    "full": BEAT_THIS_FINAL_BACKEND_ID,
}
BACKEND_LABELS = {
    BUILT_IN_BACKEND_ID: "built-in",
    BEAT_THIS_SMALL_BACKEND_ID: "beat-this small0",
    BEAT_THIS_FINAL_BACKEND_ID: "beat-this final0",
}


def build_benchmark_report(
    audio_paths: list[Path],
    *,
    audio_root: Path | None = None,
    include_relative_paths: bool = False,
    include_beats: bool = False,
    backend_ids: list[str] | None = None,
    include_warm_runs: bool | None = None,
) -> dict[str, Any]:
    resolved_audio_paths = [path.expanduser().resolve() for path in audio_paths]
    resolved_audio_root = audio_root.expanduser().resolve() if audio_root else None
    selected_backend_ids = _resolve_backend_ids(backend_ids)
    run_warm = len(selected_backend_ids) > 1 if include_warm_runs is None else include_warm_runs
    return {
        "benchmark": "tuneforge-timing-grid-heuristic",
        "benchmark_version": 2,
        "selected_backends": selected_backend_ids,
        "warm_runs": run_warm,
        "track_count": len(resolved_audio_paths),
        "tracks": [
            _benchmark_track(
                index,
                audio_path,
                audio_root=resolved_audio_root,
                include_relative_paths=include_relative_paths,
                include_beats=include_beats,
                backend_ids=selected_backend_ids,
                include_warm_runs=run_warm,
            )
            for index, audio_path in enumerate(resolved_audio_paths, start=1)
        ],
    }


def summarize_report(report: dict[str, Any]) -> str:
    lines = [f"Timing benchmark: {report['track_count']} track(s)"]
    for track in report["tracks"]:
        label = _track_summary_label(track)
        backend_results = track.get("backend_results") or []
        if len(backend_results) <= 1:
            result = backend_results[0] if backend_results else track
            lines.append(_summarize_single_backend(label, result, track))
        else:
            duration = track.get("track_duration_seconds")
            lines.append(f"- {label}: duration {_seconds_label(duration)}")
            for result in backend_results:
                lines.append(
                    "  - {backend}: {summary}".format(
                        backend=result["backend_label"],
                        summary=_backend_summary(result),
                    )
                )
    return "\n".join(lines)


def _summarize_single_backend(label: str, result: dict[str, Any], track: dict[str, Any]) -> str:
    if not result["available"]:
        return f"- {label}: unavailable ({result['error']})"
    timing = result["timing"]
    runtime_seconds = result.get("runtime_seconds", track.get("analysis_runtime_seconds"))
    if not timing["available"]:
        return f"- {label}: {_seconds_label(runtime_seconds)}, no timing grid, tempo {result.get('tempo_bpm')}"
    return f"- {label}: {_backend_summary(result)}"


def _backend_summary(result: dict[str, Any]) -> str:
    if not result["available"]:
        return f"unavailable ({result['unavailable_reason']})"

    timing = result["timing"]
    if not timing["available"]:
        return (
            "{runtime:.3f}s, {ratio}, no timing grid, cold {cold}, warm {warm}, load {load}, "
            "cache {cache}".format(
                runtime=result["runtime_seconds"],
                ratio=_ratio_label(result["runtime_ratio"]),
                cold=_seconds_label(result["cold_runtime_seconds"]),
                warm=_seconds_label(result["warm_runtime_seconds"]),
                load=_seconds_label(result["model_load_runtime_seconds"]),
                cache=_cache_label(result["checkpoint_cache"]),
            )
        )

    return (
        "{runtime:.3f}s, {ratio}, cold {cold}, warm {warm}, load {load}, tempo {tempo}, "
        "{source}, {meter}, {beats} beats, {downbeats} downbeats, {bars} bars, "
        "first beats {first_beats}, gaps {gaps}, CV {cv}, MAD {mad}, "
        "anchor drift {drift}, alignment {alignment}, cache {cache}".format(
            runtime=result["runtime_seconds"],
            ratio=_ratio_label(result["runtime_ratio"]),
            cold=_seconds_label(result["cold_runtime_seconds"]),
            warm=_seconds_label(result["warm_runtime_seconds"]),
            load=_seconds_label(result["model_load_runtime_seconds"]),
            tempo=result["tempo_bpm"],
            source=timing["source"],
            meter=timing["meter"],
            beats=timing["beat_count"],
            downbeats=timing["downbeat_count"],
            bars=timing["bar_count"],
            first_beats=_first_beats_label(timing["first_beat_numbers"]),
            gaps=timing["large_gap_count"],
            cv=_number_label(timing["beat_interval_cv"]),
            mad=_number_label(timing["beat_interval_mad_ratio"]),
            drift=_single_anchor_drift_label(timing["single_anchor_drift_seconds"]),
            alignment=_reference_alignment_label(result.get("reference_alignment_to_built_in")),
            cache=_cache_label(result["checkpoint_cache"]),
        )
    )


def collect_audio_paths(audio_dir: Path) -> list[Path]:
    resolved_audio_dir = audio_dir.expanduser().resolve()
    return sorted(
        (
            path
            for path in resolved_audio_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS
        ),
        key=lambda path: path.relative_to(resolved_audio_dir).as_posix(),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark TuneForge timing-grid heuristic analysis.")
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument(
        "--audio",
        action="append",
        type=Path,
        help="Path to an audio file. Repeat to benchmark multiple tracks.",
    )
    input_group.add_argument(
        "--audio-dir",
        "--track-dir",
        dest="audio_dir",
        type=Path,
        help="Directory of local, non-committed audio files.",
    )
    parser.add_argument("--limit", type=int, help="Maximum number of discovered tracks to analyze.")
    parser.add_argument("--include-beats", action="store_true", help="Include full detected beat payloads.")
    parser.add_argument(
        "--backend",
        action="append",
        dest="backends",
        help=(
            "Timing backend to benchmark. Repeat for multiple. Supported aliases include "
            "built-in, beat-this-small0, and beat-this-final0."
        ),
    )
    parser.add_argument(
        "--compare-beat-this",
        action="store_true",
        help="Compare built-in, beat-this small0, and beat-this final0 timing on each track.",
    )
    parser.add_argument(
        "--warm-runs",
        action="store_true",
        help="Run each selected backend twice and report cold/warm timings.",
    )
    parser.add_argument(
        "--include-relative-paths",
        action="store_true",
        help="Include sanitized paths relative to --audio-dir or each file parent in JSON output.",
    )
    parser.add_argument("--json-only", action="store_true", help="Only write machine-readable JSON to stdout.")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be >= 1")

    if args.audio_dir:
        audio_root = args.audio_dir.expanduser().resolve()
        if not audio_root.is_dir():
            parser.error("--audio-dir must be an existing directory")
        audio_paths = collect_audio_paths(audio_root)
        if args.limit is not None:
            audio_paths = audio_paths[: args.limit]
    else:
        audio_paths = args.audio or []
        audio_root = None

    requested_backends = list(COMPARISON_BENCHMARK_BACKENDS) if args.compare_beat_this else args.backends
    try:
        backend_ids = _resolve_backend_ids(requested_backends)
    except ValueError as exc:
        parser.error(str(exc))

    report = build_benchmark_report(
        audio_paths,
        audio_root=audio_root,
        include_relative_paths=args.include_relative_paths,
        include_beats=args.include_beats,
        backend_ids=backend_ids,
        include_warm_runs=args.warm_runs or args.compare_beat_this,
    )
    sys.stdout.write(json.dumps(report, indent=2))
    sys.stdout.write("\n")
    if not args.json_only:
        sys.stderr.write(summarize_report(report))
        sys.stderr.write("\n")
    return 0


def _benchmark_track(
    index: int,
    audio_path: Path,
    *,
    audio_root: Path | None,
    include_relative_paths: bool,
    include_beats: bool,
    backend_ids: list[str],
    include_warm_runs: bool,
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "track_id": f"track_{index:03d}",
        "relative_path": _relative_path(audio_path, audio_root) if include_relative_paths else None,
        **_track_metadata(audio_path),
    }
    backend_results = [
        _benchmark_timing_backend(
            audio_path,
            backend_id,
            duration_seconds=base["track_duration_seconds"],
            include_beats=include_beats,
            include_warm_runs=include_warm_runs,
        )
        for backend_id in backend_ids
    ]
    backend_results = _attach_reference_alignment(backend_results)
    legacy_result = _legacy_result(backend_results)
    return {
        **base,
        **_legacy_track_fields(legacy_result),
        "backend_results": backend_results,
    }


def _benchmark_timing_backend(
    audio_path: Path,
    backend_id: str,
    *,
    duration_seconds: float | None,
    include_beats: bool,
    include_warm_runs: bool,
) -> dict[str, Any]:
    checkpoint = BEAT_THIS_BACKEND_CHECKPOINTS.get(backend_id)
    base = {
        "backend_id": backend_id,
        "backend_label": BACKEND_LABELS[backend_id],
        "checkpoint": checkpoint,
    }
    cache_before = _checkpoint_cache_snapshot(checkpoint)
    tracemalloc.start()
    try:
        if checkpoint is not None:
            _clear_beat_this_model_cache()
        cold = _timed_timing_backend(audio_path, backend_id, duration_seconds=duration_seconds)
        warm = (
            _timed_timing_backend(audio_path, backend_id, duration_seconds=duration_seconds)
            if include_warm_runs
            else None
        )
    except Exception as exc:  # pragma: no cover - command reports per-track failures.
        _, peak_memory_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        cache_after = _checkpoint_cache_snapshot(checkpoint)
        return {
            **base,
            "available": False,
            "unavailable_reason": _unavailable_reason(exc),
            "error": _benchmark_error(exc),
            "runtime_seconds": None,
            "runtime_ratio": None,
            "cold_runtime_seconds": None,
            "warm_runtime_seconds": None,
            "cold_runtime_ratio": None,
            "warm_runtime_ratio": None,
            "model_load_runtime_seconds": None,
            "peak_memory_bytes": peak_memory_bytes,
            "cold_peak_memory_bytes": None,
            "warm_peak_memory_bytes": None,
            "tempo_bpm": None,
            "timing": _empty_timing_metrics(include_beats=include_beats),
            "checkpoint_cache": _checkpoint_cache_summary(checkpoint, cache_before, cache_after),
            "reference_alignment_to_built_in": None,
            "_reference_beat_seconds": [],
        }

    _, peak_memory_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    cache_after = _checkpoint_cache_snapshot(checkpoint)
    selected = warm or cold
    selected_timing = selected["timing"]
    return {
        **base,
        "available": True,
        "unavailable_reason": None,
        "error": None,
        "runtime_seconds": selected["runtime_seconds"],
        "runtime_ratio": _runtime_ratio(selected["runtime_seconds"], duration_seconds),
        "cold_runtime_seconds": cold["runtime_seconds"],
        "warm_runtime_seconds": warm["runtime_seconds"] if warm else None,
        "cold_runtime_ratio": _runtime_ratio(cold["runtime_seconds"], duration_seconds),
        "warm_runtime_ratio": _runtime_ratio(warm["runtime_seconds"], duration_seconds) if warm else None,
        "model_load_runtime_seconds": _model_load_runtime(cold, warm),
        "peak_memory_bytes": peak_memory_bytes,
        "cold_peak_memory_bytes": cold["peak_memory_bytes"],
        "warm_peak_memory_bytes": warm["peak_memory_bytes"] if warm else None,
        "tempo_bpm": selected["tempo_bpm"],
        "timing": _timing_metrics(selected_timing, include_beats=include_beats),
        "checkpoint_cache": _checkpoint_cache_summary(checkpoint, cache_before, cache_after),
        "reference_alignment_to_built_in": None,
        "_reference_beat_seconds": _beat_seconds(selected_timing),
    }


def _timed_timing_backend(
    audio_path: Path,
    backend_id: str,
    *,
    duration_seconds: float | None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    if backend_id == BUILT_IN_BACKEND_ID:
        analysis = analyze_track(audio_path)
        timing = analysis["timing"]
        tempo_bpm = analysis["tempo_bpm"]
    else:
        checkpoint = BEAT_THIS_BACKEND_CHECKPOINTS[backend_id]
        timing = _detect_beat_this_timing(
            audio_path,
            duration_seconds=duration_seconds,
            checkpoint=checkpoint,
        )
        tempo_bpm = _tempo_bpm_from_timing(timing)
    runtime_seconds = round(time.perf_counter() - started_at, 6)
    _, peak_memory_bytes = tracemalloc.get_traced_memory()
    return {
        "runtime_seconds": runtime_seconds,
        "peak_memory_bytes": peak_memory_bytes,
        "tempo_bpm": tempo_bpm,
        "timing": timing,
    }


def _detect_beat_this_timing(
    audio_path: Path,
    *,
    duration_seconds: float | None,
    checkpoint: str,
) -> AnalysisTimingPayload | None:
    detector = beat_this_engine.detect_beat_this_timing
    signature = inspect.signature(detector)
    supports_checkpoint = "checkpoint" in signature.parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
    if supports_checkpoint:
        return detector(audio_path, duration_seconds=duration_seconds, checkpoint=checkpoint)
    if checkpoint != "small0":
        raise RuntimeError("beat-this checkpoint selection is unavailable in this backend build")
    return detector(audio_path, duration_seconds=duration_seconds)


def _clear_beat_this_model_cache() -> None:
    get_file2beats = getattr(beat_this_engine, "_get_file2beats", None)
    cache_clear = getattr(get_file2beats, "cache_clear", None)
    if cache_clear is not None:
        cache_clear()


def _model_load_runtime(cold: dict[str, Any], warm: dict[str, Any] | None) -> float | None:
    if warm is None:
        return None
    cold_runtime = cold["runtime_seconds"]
    warm_runtime = warm["runtime_seconds"]
    if not isinstance(cold_runtime, (int, float)) or not isinstance(warm_runtime, (int, float)):
        return None
    return round(max(float(cold_runtime) - float(warm_runtime), 0.0), 6)


def _legacy_result(backend_results: list[dict[str, Any]]) -> dict[str, Any]:
    for result in backend_results:
        if result["backend_id"] == BUILT_IN_BACKEND_ID:
            return result
    return backend_results[0]


def _legacy_track_fields(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "available": result["available"],
        "error": result["error"],
        "analysis_runtime_seconds": result["runtime_seconds"],
        "runtime_ratio": result["runtime_ratio"],
        "peak_memory_bytes": result["peak_memory_bytes"],
        "tempo_bpm": result["tempo_bpm"],
        "timing": result["timing"],
    }


def _attach_reference_alignment(backend_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    built_in_beats: list[float] | None = None
    for result in backend_results:
        if result["backend_id"] == BUILT_IN_BACKEND_ID and result["available"]:
            beats = result.get("_reference_beat_seconds")
            if isinstance(beats, list) and beats:
                built_in_beats = beats
            break

    cleaned_results: list[dict[str, Any]] = []
    for result in backend_results:
        cleaned = dict(result)
        beat_seconds = cleaned.pop("_reference_beat_seconds", None)
        if result["backend_id"] in BEAT_THIS_BACKEND_CHECKPOINTS and built_in_beats is not None:
            cleaned["reference_alignment_to_built_in"] = _reference_alignment_metrics(
                beat_seconds if isinstance(beat_seconds, list) else None,
                built_in_beats,
            )
        else:
            cleaned["reference_alignment_to_built_in"] = None
        cleaned_results.append(cleaned)
    return cleaned_results


def _timing_metrics(timing: AnalysisTimingPayload | None, *, include_beats: bool) -> dict[str, Any]:
    if not timing:
        return _empty_timing_metrics(include_beats=include_beats)

    beats = timing["beats"]
    bars = timing["bars"]
    beat_seconds = np.asarray(
        [beat["seconds"] for beat in beats if _is_finite_number(beat["seconds"])],
        dtype=np.float64,
    )
    intervals = np.diff(beat_seconds) if beat_seconds.size >= 2 else np.zeros(0, dtype=np.float64)
    median_interval = float(np.median(intervals)) if intervals.size else None
    interval_mad_ratio = _interval_mad_ratio(intervals, median_interval)
    downbeat_count = sum(
        1
        for beat in beats
        if isinstance(beat["beat_in_bar"], int) and beat["beat_in_bar"] == 1
    )
    metrics: dict[str, Any] = {
        "available": bool(beats and bars),
        "source": timing.get("source"),
        "meter": timing.get("meter"),
        "beats_per_bar": timing.get("beats_per_bar"),
        "meter_confidence": timing.get("meter_confidence"),
        "downbeat_source": timing.get("downbeat_source"),
        "downbeat_confidence": timing.get("downbeat_confidence"),
        "beat_count": len(beats),
        "bar_count": len(bars),
        "downbeat_count": downbeat_count,
        "first_beat_seconds": round(float(beat_seconds[0]), 6) if beat_seconds.size else None,
        "last_beat_seconds": round(float(beat_seconds[-1]), 6) if beat_seconds.size else None,
        "median_beat_interval_seconds": None if median_interval is None else round(median_interval, 6),
        "mean_beat_interval_seconds": _interval_mean(intervals),
        "min_beat_interval_seconds": _interval_min(intervals),
        "max_beat_interval_seconds": _interval_max(intervals),
        "beat_interval_mad_ratio": interval_mad_ratio,
        "beat_interval_cv": _interval_cv(intervals),
        "large_gap_count": _large_gap_count(intervals, median_interval),
        "single_anchor_drift_seconds": _single_anchor_drift_metrics(beat_seconds, median_interval),
        "first_beat_numbers": [
            beat["beat_in_bar"]
            for beat in beats[:16]
            if isinstance(beat["beat_in_bar"], int)
        ],
    }
    if include_beats:
        metrics["beats"] = beats
    return metrics


def _empty_timing_metrics(*, include_beats: bool) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "available": False,
        "source": None,
        "meter": None,
        "beats_per_bar": None,
        "meter_confidence": None,
        "downbeat_source": None,
        "downbeat_confidence": None,
        "beat_count": 0,
        "bar_count": 0,
        "downbeat_count": 0,
        "first_beat_seconds": None,
        "last_beat_seconds": None,
        "median_beat_interval_seconds": None,
        "mean_beat_interval_seconds": None,
        "min_beat_interval_seconds": None,
        "max_beat_interval_seconds": None,
        "beat_interval_mad_ratio": None,
        "beat_interval_cv": None,
        "large_gap_count": 0,
        "single_anchor_drift_seconds": _empty_single_anchor_drift_metrics(),
        "first_beat_numbers": [],
    }
    if include_beats:
        metrics["beats"] = []
    return metrics


def _relative_path(audio_path: Path, audio_root: Path | None) -> str:
    root = audio_root or audio_path.parent
    try:
        relative_path = audio_path.relative_to(root).as_posix()
    except ValueError:
        relative_path = audio_path.name
    return _sanitize_relative_path(relative_path)


def _sanitize_relative_path(relative_path: str) -> str:
    return SAFE_NAME_PATTERN.sub("_", relative_path).strip("._-/") or "unnamed"


def _benchmark_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: analysis failed"


def _unavailable_reason(exc: Exception) -> str:
    if type(exc).__name__ == "BeatThisRuntimeError":
        return str(exc)
    message = str(exc)
    if message == "beat-this checkpoint selection is unavailable in this backend build":
        return message
    return _benchmark_error(exc)


def _tempo_bpm_from_timing(timing: AnalysisTimingPayload | None) -> float | None:
    if timing is None:
        return None
    beat_seconds = [
        beat["seconds"]
        for beat in timing["beats"]
        if _is_finite_number(beat["seconds"])
    ]
    if len(beat_seconds) < 2:
        return None
    intervals = np.diff(np.asarray(beat_seconds, dtype=np.float64))
    median_interval = float(np.median(intervals)) if intervals.size else 0.0
    if median_interval <= 0.0:
        return None
    return round(60.0 / median_interval, 3)


def _checkpoint_cache_snapshot(checkpoint: str | None) -> dict[str, Any] | None:
    if checkpoint is None:
        return None
    checkpoint_path = _torch_checkpoint_cache_path(checkpoint)
    size_bytes = checkpoint_path.stat().st_size if checkpoint_path.exists() else None
    return {
        "available": size_bytes is not None,
        "checkpoint_file": checkpoint_path.name,
        "size_bytes": size_bytes,
    }


def _torch_checkpoint_cache_path(checkpoint: str) -> Path:
    file_name = f"beat_this-{checkpoint}.ckpt"
    torch_home = os.environ.get("TORCH_HOME")
    if torch_home:
        return Path(torch_home).expanduser() / "hub" / "checkpoints" / file_name
    xdg_cache_home = os.environ.get("XDG_CACHE_HOME")
    if xdg_cache_home:
        return Path(xdg_cache_home).expanduser() / "torch" / "hub" / "checkpoints" / file_name
    return Path.home() / ".cache" / "torch" / "hub" / "checkpoints" / file_name


def _checkpoint_cache_summary(
    checkpoint: str | None,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> dict[str, Any]:
    if checkpoint is None:
        return {
            "available": False,
            "checkpoint_file": None,
            "cache_size_bytes_before": None,
            "cache_size_bytes_after": None,
            "downloaded_during_run": None,
            "behavior": "not_applicable",
        }
    before_size = before.get("size_bytes") if before else None
    after_size = after.get("size_bytes") if after else None
    downloaded = None
    if isinstance(after_size, int):
        downloaded = not isinstance(before_size, int) or after_size > before_size
    available = bool((before and before.get("available")) or (after and after.get("available")))
    return {
        "available": available,
        "checkpoint_file": after.get("checkpoint_file") if after else before.get("checkpoint_file") if before else None,
        "cache_size_bytes_before": before_size,
        "cache_size_bytes_after": after_size,
        "downloaded_during_run": downloaded,
        "behavior": _cache_behavior(available, downloaded),
    }


def _cache_behavior(available: bool, downloaded: bool | None) -> str:
    if not available:
        return "unknown"
    if downloaded is True:
        return "downloaded_or_cache_grew"
    if downloaded is False:
        return "cache_unchanged"
    return "observed"


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and np.isfinite(float(value))


def _interval_mad_ratio(intervals: np.ndarray, median_interval: float | None) -> float | None:
    if intervals.size == 0 or median_interval is None or median_interval <= 0.0:
        return None
    mad_ratio = float(np.median(np.abs(intervals - median_interval)) / median_interval)
    return round(mad_ratio, 6)


def _interval_mean(intervals: np.ndarray) -> float | None:
    return round(float(np.mean(intervals)), 6) if intervals.size else None


def _interval_min(intervals: np.ndarray) -> float | None:
    return round(float(np.min(intervals)), 6) if intervals.size else None


def _interval_max(intervals: np.ndarray) -> float | None:
    return round(float(np.max(intervals)), 6) if intervals.size else None


def _interval_cv(intervals: np.ndarray) -> float | None:
    if intervals.size < 2:
        return None
    mean_interval = float(np.mean(intervals))
    if mean_interval <= 0.0:
        return None
    return round(float(np.std(intervals) / mean_interval), 6)


def _beat_seconds(timing: AnalysisTimingPayload | None) -> list[float]:
    if timing is None:
        return []
    return [
        float(beat["seconds"])
        for beat in timing["beats"]
        if _is_finite_number(beat["seconds"])
    ]


def _single_anchor_drift_metrics(beat_seconds: np.ndarray, median_interval: float | None) -> dict[str, Any]:
    if beat_seconds.size < 2 or median_interval is None or median_interval <= 0.0:
        return _empty_single_anchor_drift_metrics()
    anchored_grid = beat_seconds[0] + np.arange(beat_seconds.size, dtype=np.float64) * median_interval
    absolute_residuals = np.abs(beat_seconds - anchored_grid)
    return {
        "median_absolute_residual_seconds": round(float(np.median(absolute_residuals)), 6),
        "p95_absolute_residual_seconds": round(float(np.percentile(absolute_residuals, 95)), 6),
        "max_absolute_residual_seconds": round(float(np.max(absolute_residuals)), 6),
    }


def _empty_single_anchor_drift_metrics() -> dict[str, Any]:
    return {
        "median_absolute_residual_seconds": None,
        "p95_absolute_residual_seconds": None,
        "max_absolute_residual_seconds": None,
    }


def _reference_alignment_metrics(
    beat_seconds: list[float] | None,
    reference_beat_seconds: list[float],
) -> dict[str, Any] | None:
    if not beat_seconds or not reference_beat_seconds:
        return None
    beats = np.sort(np.asarray(beat_seconds, dtype=np.float64))
    reference = np.sort(np.asarray(reference_beat_seconds, dtype=np.float64))
    if beats.size == 0 or reference.size == 0:
        return None

    positions = np.searchsorted(reference, beats)
    deltas: list[float] = []
    for beat, position in zip(beats, positions, strict=True):
        candidates = []
        if position < reference.size:
            candidates.append(abs(float(reference[position] - beat)))
        if position > 0:
            candidates.append(abs(float(beat - reference[position - 1])))
        if candidates:
            deltas.append(min(candidates))
    if not deltas:
        return None

    deltas_array = np.asarray(deltas, dtype=np.float64)
    return {
        "reference_backend_id": BUILT_IN_BACKEND_ID,
        "median_nearest_beat_delta_seconds": round(float(np.median(deltas_array)), 6),
        "p95_nearest_beat_delta_seconds": round(float(np.percentile(deltas_array, 95)), 6),
        "max_nearest_beat_delta_seconds": round(float(np.max(deltas_array)), 6),
        "beat_count_delta": int(beats.size - reference.size),
    }


def _large_gap_count(intervals: np.ndarray, median_interval: float | None) -> int:
    if intervals.size == 0 or median_interval is None or median_interval <= 0.0:
        return 0
    return int(np.count_nonzero(intervals > median_interval * 1.75))


def _track_metadata(audio_path: Path) -> dict[str, Any]:
    try:
        info = sf.info(str(audio_path))
    except RuntimeError:
        return {
            "track_duration_seconds": None,
            "sample_rate": None,
            "channels": None,
        }
    if info.samplerate <= 0:
        duration_seconds = None
    else:
        duration_seconds = round(float(info.frames / info.samplerate), 3)
    return {
        "track_duration_seconds": duration_seconds,
        "sample_rate": int(info.samplerate) if info.samplerate > 0 else None,
        "channels": int(info.channels) if info.channels > 0 else None,
    }


def _runtime_ratio(runtime_seconds: float, duration_seconds: Any) -> float | None:
    if not isinstance(duration_seconds, (int, float)) or duration_seconds <= 0.0:
        return None
    return round(float(runtime_seconds / duration_seconds), 6)


def _ratio_label(value: Any) -> str:
    return f"{value:.2f}x track" if isinstance(value, (int, float)) else "unknown ratio"


def _resolve_backend_ids(backend_ids: list[str] | None) -> list[str]:
    requested_backend_ids = backend_ids or list(DEFAULT_BENCHMARK_BACKENDS)
    resolved_backend_ids: list[str] = []
    for backend_id in requested_backend_ids:
        normalized = backend_id.strip().lower()
        resolved = BACKEND_ALIASES.get(normalized)
        if resolved is None:
            supported = ", ".join(COMPARISON_BENCHMARK_BACKENDS)
            raise ValueError(f"unsupported timing backend {backend_id!r}; expected one of {supported}")
        if resolved not in resolved_backend_ids:
            resolved_backend_ids.append(resolved)
    return resolved_backend_ids


def _track_summary_label(track: dict[str, Any]) -> str:
    relative_path = track.get("relative_path")
    if isinstance(relative_path, str) and relative_path:
        return f"{track['track_id']} ({relative_path})"
    return track["track_id"]


def _seconds_label(value: Any) -> str:
    return f"{value:.3f}s" if isinstance(value, (int, float)) else "unknown"


def _number_label(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, (int, float)) else "unknown"


def _single_anchor_drift_label(value: Any) -> str:
    if not isinstance(value, dict):
        return "unknown"
    median = _seconds_label(value.get("median_absolute_residual_seconds"))
    p95 = _seconds_label(value.get("p95_absolute_residual_seconds"))
    maximum = _seconds_label(value.get("max_absolute_residual_seconds"))
    return f"median {median}/p95 {p95}/max {maximum}"


def _reference_alignment_label(value: Any) -> str:
    if value is None:
        return "n/a"
    if not isinstance(value, dict):
        return "unknown"
    median = _seconds_label(value.get("median_nearest_beat_delta_seconds"))
    p95 = _seconds_label(value.get("p95_nearest_beat_delta_seconds"))
    count_delta = value.get("beat_count_delta")
    return f"built-in median {median}/p95 {p95}/count delta {count_delta}"


def _first_beats_label(values: Any) -> str:
    if not isinstance(values, list) or not values:
        return "none"
    return ",".join(str(value) for value in values[:8])


def _cache_label(cache: Any) -> str:
    if not isinstance(cache, dict):
        return "not_applicable"
    behavior = cache.get("behavior")
    after = cache.get("cache_size_bytes_after")
    downloaded = cache.get("downloaded_during_run")
    if isinstance(after, int):
        return f"{behavior}:{after} bytes:download {downloaded}"
    return str(behavior)


if __name__ == "__main__":
    raise SystemExit(main())
