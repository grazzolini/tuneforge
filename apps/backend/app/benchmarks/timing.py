from __future__ import annotations

import argparse
import json
import re
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from app.engines.analysis import AnalysisTimingPayload, analyze_track

AUDIO_EXTENSIONS = {".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"}
SAFE_NAME_PATTERN = re.compile(r"[^A-Za-z0-9._/-]+")


def build_benchmark_report(
    audio_paths: list[Path],
    *,
    audio_root: Path | None = None,
    include_relative_paths: bool = False,
    include_beats: bool = False,
) -> dict[str, Any]:
    resolved_audio_paths = [path.expanduser().resolve() for path in audio_paths]
    resolved_audio_root = audio_root.expanduser().resolve() if audio_root else None
    return {
        "benchmark": "tuneforge-timing-grid-heuristic",
        "track_count": len(resolved_audio_paths),
        "tracks": [
            _benchmark_track(
                index,
                audio_path,
                audio_root=resolved_audio_root,
                include_relative_paths=include_relative_paths,
                include_beats=include_beats,
            )
            for index, audio_path in enumerate(resolved_audio_paths, start=1)
        ],
    }


def summarize_report(report: dict[str, Any]) -> str:
    lines = [f"Timing benchmark: {report['track_count']} track(s)"]
    for track in report["tracks"]:
        if not track["available"]:
            lines.append(f"- {track['track_id']}: unavailable ({track['error']})")
            continue
        timing = track["timing"]
        if not timing["available"]:
            lines.append(
                "- {track_id}: {runtime:.3f}s, no timing grid, tempo {tempo}".format(
                    track_id=track["track_id"],
                    runtime=track["analysis_runtime_seconds"],
                    tempo=track["tempo_bpm"],
                )
            )
            continue
        lines.append(
            "- {track_id}: {runtime:.3f}s, {ratio}, tempo {tempo}, {source}, {meter}, "
            "{beats} beats, {bars} bars, downbeat {downbeat_confidence}, meter {meter_confidence}".format(
                track_id=track["track_id"],
                runtime=track["analysis_runtime_seconds"],
                ratio=_ratio_label(track["runtime_ratio"]),
                tempo=track["tempo_bpm"],
                source=timing["source"],
                meter=timing["meter"],
                beats=timing["beat_count"],
                bars=timing["bar_count"],
                downbeat_confidence=timing["downbeat_confidence"],
                meter_confidence=timing["meter_confidence"],
            )
        )
    return "\n".join(lines)


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

    report = build_benchmark_report(
        audio_paths,
        audio_root=audio_root,
        include_relative_paths=args.include_relative_paths,
        include_beats=args.include_beats,
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
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "track_id": f"track_{index:03d}",
        "relative_path": _relative_path(audio_path, audio_root) if include_relative_paths else None,
        **_track_metadata(audio_path),
    }
    tracemalloc.start()
    started_at = time.perf_counter()
    try:
        analysis = analyze_track(audio_path)
    except Exception as exc:  # pragma: no cover - command reports per-track failures.
        _, peak_memory_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        runtime_seconds = round(time.perf_counter() - started_at, 6)
        return {
            **base,
            "available": False,
            "error": _benchmark_error(exc),
            "analysis_runtime_seconds": runtime_seconds,
            "runtime_ratio": _runtime_ratio(runtime_seconds, base["track_duration_seconds"]),
            "peak_memory_bytes": peak_memory_bytes,
            "tempo_bpm": None,
            "timing": _empty_timing_metrics(include_beats=include_beats),
        }

    runtime_seconds = round(time.perf_counter() - started_at, 6)
    _, peak_memory_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        **base,
        "available": True,
        "error": None,
        "analysis_runtime_seconds": runtime_seconds,
        "runtime_ratio": _runtime_ratio(runtime_seconds, base["track_duration_seconds"]),
        "peak_memory_bytes": peak_memory_bytes,
        "tempo_bpm": analysis["tempo_bpm"],
        "timing": _timing_metrics(analysis["timing"], include_beats=include_beats),
    }


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


if __name__ == "__main__":
    raise SystemExit(main())
