from __future__ import annotations

import importlib.util
from collections.abc import Callable, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

import numpy as np

from app.engines.analysis import (
    BEATS_PER_BAR,
    DEFAULT_METER,
    AnalysisPayload,
    AnalysisTimingBeatPayload,
    AnalysisTimingPayload,
    _timing_bars,
    _timing_beat_bar_index,
    analyze_track,
)

BEAT_THIS_CHECKPOINT = "small0"
BEAT_THIS_SOURCE = "beat-this"
DOWNBEAT_TOLERANCE_BEAT_FRACTION = 0.3
MIN_DOWNBEAT_TOLERANCE_SECONDS = 0.08
MAX_DOWNBEAT_TOLERANCE_SECONDS = 0.22
SUPPORTED_BEATS_PER_BAR = frozenset({3, 4, 6})

File2BeatsCallable = Callable[[str], tuple[Any, Any]]


class BeatThisRuntimeError(RuntimeError):
    pass


def beat_this_dependency_status() -> tuple[bool, str | None]:
    if importlib.util.find_spec("beat_this") is None:
        return False, "Install the optional advanced-beats dependency to use Advanced Beat Analysis."
    return True, None


def analyze_track_with_beat_this(
    source_path: Path,
    *,
    source_stem_paths: Sequence[Path] | None = None,
    duration_seconds: float | None = None,
) -> AnalysisPayload:
    payload = analyze_track(source_path, source_stem_paths=source_stem_paths)
    timing = detect_beat_this_timing(source_path, duration_seconds=duration_seconds)
    if timing is None:
        raise BeatThisRuntimeError("Advanced Beat Analysis did not produce usable beat timing.")

    payload["timing"] = timing
    tempo_bpm = _tempo_bpm_from_timing(timing)
    if tempo_bpm is not None:
        payload["tempo_bpm"] = tempo_bpm
    return payload


def detect_beat_this_timing(
    source_path: Path,
    *,
    duration_seconds: float | None = None,
) -> AnalysisTimingPayload | None:
    try:
        raw_beats, raw_downbeats = _get_file2beats()(str(source_path))
    except BeatThisRuntimeError:
        raise
    except Exception as exc:
        raise BeatThisRuntimeError("Advanced Beat Analysis failed while running beat-this.") from exc

    beat_times = _clean_seconds_array(raw_beats, duration_seconds=duration_seconds)
    if beat_times.size < 2:
        return None

    downbeat_times = _clean_seconds_array(raw_downbeats, duration_seconds=duration_seconds)
    downbeat_indices = _nearest_downbeat_indices(beat_times, downbeat_times)
    downbeat_offset = int(downbeat_indices[0]) % _infer_beats_per_bar(downbeat_indices)
    beats_per_bar = _infer_beats_per_bar(downbeat_indices)
    meter = _meter_for_beats_per_bar(beats_per_bar)
    beats: list[AnalysisTimingBeatPayload] = [
        {
            "index": index,
            "seconds": round(float(seconds), 6),
            "bar_index": _timing_beat_bar_index(index, downbeat_offset, beats_per_bar),
            "beat_in_bar": ((index - downbeat_offset) % beats_per_bar) + 1,
        }
        for index, seconds in enumerate(beat_times.tolist())
    ]
    grid_duration_seconds = _timing_duration_seconds(beat_times, duration_seconds)
    bars = _timing_bars(beats, grid_duration_seconds)
    if not bars:
        return None

    return {
        "beats_per_bar": beats_per_bar,
        "source": BEAT_THIS_SOURCE,
        "meter": meter,
        "meter_confidence": 1.0 if downbeat_times.size >= 2 else 0.0,
        "downbeat_source": BEAT_THIS_SOURCE,
        "downbeat_confidence": 1.0 if downbeat_times.size > 0 else 0.0,
        "beats": beats,
        "bars": bars,
    }


@lru_cache(maxsize=1)
def _get_file2beats() -> File2BeatsCallable:
    try:
        from beat_this.inference import File2Beats
    except Exception as exc:
        raise BeatThisRuntimeError(
            "Advanced Beat Analysis requires the optional beat-this package."
        ) from exc

    try:
        return cast(
            File2BeatsCallable,
            File2Beats(checkpoint_path=BEAT_THIS_CHECKPOINT, device="cpu", dbn=False),
        )
    except Exception as exc:
        raise BeatThisRuntimeError("Advanced Beat Analysis could not load the beat-this model.") from exc


def _clean_seconds_array(values: Any, *, duration_seconds: float | None) -> np.ndarray:
    try:
        seconds = np.asarray(values, dtype=np.float64).reshape(-1)
    except (TypeError, ValueError):
        return np.zeros(0, dtype=np.float64)

    finite_seconds = seconds[np.isfinite(seconds)]
    bounded_seconds = finite_seconds[finite_seconds >= 0.0]
    if duration_seconds is not None and duration_seconds > 0.0:
        bounded_seconds = bounded_seconds[bounded_seconds <= duration_seconds + 1e-6]
    if bounded_seconds.size == 0:
        return np.zeros(0, dtype=np.float64)

    ordered_seconds = np.sort(bounded_seconds.astype(np.float64))
    deduped: list[float] = []
    for seconds_value in ordered_seconds.tolist():
        if not deduped or seconds_value - deduped[-1] >= 0.05:
            deduped.append(seconds_value)
    return np.asarray(deduped, dtype=np.float64)


def _nearest_downbeat_indices(beat_times: np.ndarray, downbeat_times: np.ndarray) -> np.ndarray:
    if downbeat_times.size == 0:
        return np.asarray([0], dtype=np.int64)

    tolerance_seconds = _downbeat_tolerance_seconds(beat_times)
    indices: list[int] = []
    for downbeat_seconds in downbeat_times.tolist():
        distances = np.abs(beat_times - float(downbeat_seconds))
        index = int(np.argmin(distances))
        if float(distances[index]) <= tolerance_seconds:
            indices.append(index)
    if not indices:
        return np.asarray([0], dtype=np.int64)
    return np.unique(np.asarray(indices, dtype=np.int64))


def _downbeat_tolerance_seconds(beat_times: np.ndarray) -> float:
    if beat_times.size < 2:
        return MIN_DOWNBEAT_TOLERANCE_SECONDS
    interval_seconds = float(np.median(np.diff(beat_times)))
    if not np.isfinite(interval_seconds) or interval_seconds <= 0.0:
        return MIN_DOWNBEAT_TOLERANCE_SECONDS
    return float(
        np.clip(
            interval_seconds * DOWNBEAT_TOLERANCE_BEAT_FRACTION,
            MIN_DOWNBEAT_TOLERANCE_SECONDS,
            MAX_DOWNBEAT_TOLERANCE_SECONDS,
        )
    )


def _infer_beats_per_bar(downbeat_indices: np.ndarray) -> int:
    if downbeat_indices.size >= 2:
        intervals = np.diff(downbeat_indices)
        candidates = intervals[(intervals >= 2) & (intervals <= 8)]
        if candidates.size > 0:
            beats_per_bar = int(round(float(np.median(candidates))))
            if beats_per_bar in SUPPORTED_BEATS_PER_BAR:
                return beats_per_bar
    return BEATS_PER_BAR


def _meter_for_beats_per_bar(beats_per_bar: int) -> str:
    if beats_per_bar == 3:
        return "3/4"
    if beats_per_bar == 6:
        return "6/8"
    return DEFAULT_METER


def _timing_duration_seconds(beat_times: np.ndarray, duration_seconds: float | None) -> float:
    if duration_seconds is not None and duration_seconds > 0.0:
        return duration_seconds
    if beat_times.size >= 2:
        return float(beat_times[-1] + np.median(np.diff(beat_times)))
    return float(beat_times[-1])


def _tempo_bpm_from_timing(timing: AnalysisTimingPayload) -> float | None:
    beat_seconds = [beat["seconds"] for beat in timing["beats"]]
    if len(beat_seconds) < 2:
        return None
    intervals = np.diff(np.asarray(beat_seconds, dtype=np.float64))
    intervals = intervals[(intervals > 0.0) & np.isfinite(intervals)]
    if intervals.size == 0:
        return None
    median_interval = float(np.median(intervals))
    if median_interval <= 0.0:
        return None
    return round(60.0 / median_interval, 3)
