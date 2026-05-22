from __future__ import annotations

from pathlib import Path
from typing import TypedDict

import numpy as np

from app.engines.audio_features import HarmonicFeatures, active_chroma_mean, extract_harmonic_features
from app.engines.chords import ChordSegment, detect_chords_from_features

BEATS_PER_BAR = 4
MIN_DOWNBEAT_INFERENCE_BEATS = BEATS_PER_BAR * 2
DOWNBEAT_PROXIMITY_BEAT_FRACTION = 0.28
MIN_DOWNBEAT_PROXIMITY_SECONDS = 0.08
MAX_DOWNBEAT_PROXIMITY_SECONDS = 0.22
DOWNBEAT_CHORD_WEIGHT = 0.58
DOWNBEAT_ACCENT_WEIGHT = 0.42
DOWNBEAT_MIN_SCORE = 0.32
DOWNBEAT_MIN_SCORE_MARGIN = 0.1
DOWNBEAT_MIN_ZERO_MARGIN = 0.14
BEAT_PHASE_SHORT_INTERVAL_RATIO = 0.68
BEAT_PHASE_PAUSE_GAP_RATIO = 1.8
BEAT_PHASE_MIN_BURST_INTERVALS = 2
BEAT_PHASE_MAX_BURST_INTERVALS = 12
BEAT_PHASE_LOCAL_CONTEXT_INTERVALS = BEAT_PHASE_MAX_BURST_INTERVALS
BEAT_PHASE_BOOKEND_MIN_RATIO = 0.72
BEAT_PHASE_MAX_BURST_GRID_STEPS = BEATS_PER_BAR
BEAT_PHASE_MIN_LOCAL_TEMPO_INTERVALS = BEATS_PER_BAR + 2
BEAT_PHASE_LOCAL_TEMPO_MAX_DEVIATION_RATIO = 0.2

MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float32,
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float32,
)
NOTE_NAMES = np.array(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])

MAJOR_DIATONIC_QUALITIES: dict[int, set[str]] = {
    0: {"major", "maj7", "sus2", "sus4"},
    2: {"minor", "m7"},
    4: {"minor", "m7"},
    5: {"major", "maj7", "sus2", "sus4"},
    7: {"major", "7", "sus2", "sus4"},
    9: {"minor", "m7"},
    11: {"dim"},
}
MINOR_DIATONIC_QUALITIES: dict[int, set[str]] = {
    0: {"minor", "m7"},
    2: {"dim"},
    3: {"major", "maj7"},
    5: {"minor", "m7", "sus2", "sus4"},
    7: {"minor", "major", "7", "sus2", "sus4"},
    8: {"major", "maj7"},
    10: {"major", "7"},
}


class AnalysisTimingBeatPayload(TypedDict):
    index: int
    seconds: float
    bar_index: int
    beat_in_bar: int


class AnalysisTimingBarPayload(TypedDict):
    index: int
    start_seconds: float
    end_seconds: float


class AnalysisTimingPayload(TypedDict):
    beats_per_bar: int
    source: str
    beats: list[AnalysisTimingBeatPayload]
    bars: list[AnalysisTimingBarPayload]


class AnalysisPayload(TypedDict):
    estimated_key: str | None
    key_confidence: float | None
    estimated_reference_hz: float | None
    tuning_offset_cents: float | None
    tempo_bpm: float | None
    timing: AnalysisTimingPayload | None


def analyze_track(source_path: Path) -> AnalysisPayload:
    features = extract_harmonic_features(source_path)
    if features.signal.size == 0:
        return {
            "estimated_key": None,
            "key_confidence": None,
            "estimated_reference_hz": None,
            "tuning_offset_cents": None,
            "tempo_bpm": None,
            "timing": None,
        }

    chord_timeline = detect_chords_from_features(features)
    estimated_key, key_confidence = _estimate_key(features, chord_timeline)
    return {
        "estimated_key": estimated_key,
        "key_confidence": key_confidence,
        "estimated_reference_hz": features.estimated_reference_hz,
        "tuning_offset_cents": features.tuning_offset_cents,
        "tempo_bpm": features.tempo_bpm,
        "timing": _build_timing_payload(features, chord_timeline),
    }


def _build_timing_payload(
    features: HarmonicFeatures,
    chord_timeline: list[ChordSegment],
) -> AnalysisTimingPayload | None:
    if features.duration_seconds <= 0.0:
        return None

    beat_times = _detected_beat_times(features)
    source = "detected"
    if beat_times.size < BEATS_PER_BAR:
        beat_times = _fallback_beat_times(features.tempo_bpm, features.duration_seconds)
        source = "tempo_fallback"
    if beat_times.size < 2:
        return None

    downbeat_offset = (
        _infer_downbeat_offset(features, beat_times, chord_timeline) if source == "detected" else 0
    )
    beats: list[AnalysisTimingBeatPayload] = [
        {
            "index": index,
            "seconds": round(float(seconds), 6),
            "bar_index": _timing_beat_bar_index(index, downbeat_offset),
            "beat_in_bar": ((index - downbeat_offset) % BEATS_PER_BAR) + 1,
        }
        for index, seconds in enumerate(beat_times.tolist())
    ]
    bars = _timing_bars(beats, features.duration_seconds)
    if not bars:
        return None
    payload: AnalysisTimingPayload = {
        "beats_per_bar": BEATS_PER_BAR,
        "source": source,
        "beats": beats,
        "bars": bars,
    }
    return payload


def _detected_beat_times(features: HarmonicFeatures) -> np.ndarray:
    if features.beat_frames.size == 0 or features.times.size == 0:
        return np.zeros(0, dtype=np.float64)
    beat_frames = features.beat_frames[features.beat_frames < features.times.size]
    if beat_frames.size == 0:
        return np.zeros(0, dtype=np.float64)
    beat_times = features.times[beat_frames].astype(np.float64)
    return _stabilize_detected_beat_phase(
        _clean_beat_times(beat_times, features.duration_seconds)
    )


def _fallback_beat_times(tempo_bpm: float | None, duration_seconds: float) -> np.ndarray:
    if tempo_bpm is None or tempo_bpm <= 0.0 or duration_seconds <= 0.0:
        return np.zeros(0, dtype=np.float64)
    beat_seconds = 60.0 / tempo_bpm
    if beat_seconds <= 0.0:
        return np.zeros(0, dtype=np.float64)
    beat_times = np.arange(0.0, duration_seconds + beat_seconds * 0.5, beat_seconds)
    return _clean_beat_times(beat_times, duration_seconds)


def _clean_beat_times(beat_times: np.ndarray, duration_seconds: float) -> np.ndarray:
    finite_times = beat_times[np.isfinite(beat_times)]
    bounded_times = finite_times[
        (finite_times >= 0.0) & (finite_times <= duration_seconds + 1e-6)
    ]
    if bounded_times.size == 0:
        return np.zeros(0, dtype=np.float64)
    ordered_times = np.sort(bounded_times.astype(np.float64))
    deduped: list[float] = []
    for seconds in ordered_times.tolist():
        if not deduped or seconds - deduped[-1] >= 0.05:
            deduped.append(seconds)
    return np.asarray(deduped, dtype=np.float64)


def _stabilize_detected_beat_phase(beat_times: np.ndarray) -> np.ndarray:
    if beat_times.size < BEAT_PHASE_MIN_BURST_INTERVALS + 3:
        return beat_times

    intervals = np.diff(beat_times.astype(np.float64))
    if intervals.size < BEAT_PHASE_MIN_BURST_INTERVALS + 2:
        return beat_times

    local_references = _local_beat_interval_references(intervals)
    has_reference = np.isfinite(local_references) & (local_references > 0.0)
    short_intervals = (
        has_reference & (intervals <= local_references * BEAT_PHASE_SHORT_INTERVAL_RATIO)
    )
    pause_gaps = has_reference & (intervals > local_references * BEAT_PHASE_PAUSE_GAP_RATIO)

    keep = np.ones(beat_times.size, dtype=np.bool_)
    index = 0
    while index < intervals.size:
        if not short_intervals[index]:
            index += 1
            continue

        run_start = index
        while index + 1 < intervals.size and short_intervals[index + 1]:
            index += 1
        run_end = index
        _keep_projected_phase_candidates(
            beat_times,
            intervals,
            short_intervals,
            pause_gaps,
            local_references,
            run_start,
            run_end,
            keep,
        )
        index += 1

    if bool(np.all(keep)):
        return beat_times
    return beat_times[keep]


def _local_beat_interval_references(intervals: np.ndarray) -> np.ndarray:
    references = np.zeros(intervals.size, dtype=np.float64)
    for index in range(intervals.size):
        start = max(0, index - BEAT_PHASE_LOCAL_CONTEXT_INTERVALS)
        end = min(intervals.size, index + BEAT_PHASE_LOCAL_CONTEXT_INTERVALS + 1)
        references[index] = _upper_half_median(intervals[start:end])
    return references


def _upper_half_median(values: np.ndarray) -> float:
    clean_values = values[np.isfinite(values) & (values > 0.0)]
    if clean_values.size == 0:
        return 0.0
    ordered_values = np.sort(clean_values.astype(np.float64))
    return float(np.median(ordered_values[ordered_values.size // 2 :]))


def _keep_projected_phase_candidates(
    beat_times: np.ndarray,
    intervals: np.ndarray,
    short_intervals: np.ndarray,
    pause_gaps: np.ndarray,
    local_references: np.ndarray,
    run_start: int,
    run_end: int,
    keep: np.ndarray,
) -> None:
    run_interval_count = run_end - run_start + 1
    if not (
        BEAT_PHASE_MIN_BURST_INTERVALS
        <= run_interval_count
        <= BEAT_PHASE_MAX_BURST_INTERVALS
    ):
        return

    before_interval = run_start - 1
    after_interval = run_end + 1
    if after_interval >= intervals.size:
        return

    reference = _beat_phase_burst_reference(
        intervals,
        short_intervals,
        pause_gaps,
        local_references,
        run_start,
        run_end,
    )
    if reference <= 0.0:
        return
    if before_interval >= 0:
        if not _is_stable_phase_bookend(
            intervals[before_interval],
            pause_gaps[before_interval],
            reference,
        ):
            return
    if not _is_stable_phase_bookend(
        intervals[after_interval],
        pause_gaps[after_interval],
        reference,
    ):
        return

    candidate_indices = np.arange(run_start + 1, run_end + 2)
    expected_step_count = _projected_grid_step_count(
        beat_times,
        candidate_indices,
        anchor_seconds=float(beat_times[run_start]),
        reference_seconds=reference,
    )
    if (
        expected_step_count >= BEATS_PER_BAR
        and _is_consistent_local_tempo_phrase(intervals, run_start, run_end)
    ):
        return
    if expected_step_count > BEAT_PHASE_MAX_BURST_GRID_STEPS:
        return

    grid_indices = _closest_projected_grid_indices(
        beat_times,
        candidate_indices,
        anchor_seconds=float(beat_times[run_start]),
        reference_seconds=reference,
        expected_step_count=expected_step_count,
    )
    if len(grid_indices) >= candidate_indices.size:
        return

    keep[candidate_indices] = False
    keep[list(grid_indices)] = True


def _beat_phase_burst_reference(
    intervals: np.ndarray,
    short_intervals: np.ndarray,
    pause_gaps: np.ndarray,
    local_references: np.ndarray,
    run_start: int,
    run_end: int,
) -> float:
    start = max(0, run_start - BEAT_PHASE_LOCAL_CONTEXT_INTERVALS)
    end = min(intervals.size, run_end + BEAT_PHASE_LOCAL_CONTEXT_INTERVALS + 1)
    context_mask = ~(short_intervals[start:end] | pause_gaps[start:end])
    context_intervals = intervals[start:end][context_mask]
    reference = _upper_half_median(context_intervals)
    if reference > 0.0:
        return reference
    return _upper_half_median(local_references[run_start : run_end + 1])


def _is_stable_phase_bookend(interval: float, is_pause_gap: bool, reference: float) -> bool:
    if is_pause_gap or not np.isfinite(interval) or interval <= 0.0:
        return False
    return (
        interval >= reference * BEAT_PHASE_BOOKEND_MIN_RATIO
        and interval <= reference * BEAT_PHASE_PAUSE_GAP_RATIO
    )


def _is_consistent_local_tempo_phrase(
    intervals: np.ndarray,
    run_start: int,
    run_end: int,
) -> bool:
    run_intervals = intervals[run_start : run_end + 1]
    if run_intervals.size < BEAT_PHASE_MIN_LOCAL_TEMPO_INTERVALS:
        return False
    if not bool(np.all(np.isfinite(run_intervals) & (run_intervals > 0.0))):
        return False

    local_interval = float(np.median(run_intervals.astype(np.float64)))
    if local_interval <= 0.0:
        return False
    max_deviation = float(np.max(np.abs(run_intervals - local_interval)))
    return max_deviation <= local_interval * BEAT_PHASE_LOCAL_TEMPO_MAX_DEVIATION_RATIO


def _closest_projected_grid_indices(
    beat_times: np.ndarray,
    candidate_indices: np.ndarray,
    anchor_seconds: float,
    reference_seconds: float,
    expected_step_count: int,
) -> set[int]:
    if expected_step_count >= candidate_indices.size:
        return set(candidate_indices.tolist())

    candidate_seconds = beat_times[candidate_indices]
    grid_indices: set[int] = set()
    for step in range(1, expected_step_count + 1):
        target_seconds = anchor_seconds + reference_seconds * step
        distances = np.abs(candidate_seconds - target_seconds)
        for candidate_position in np.argsort(distances).tolist():
            candidate_index = int(candidate_indices[candidate_position])
            if candidate_index in grid_indices:
                continue
            grid_indices.add(candidate_index)
            break
    return grid_indices


def _projected_grid_step_count(
    beat_times: np.ndarray,
    candidate_indices: np.ndarray,
    anchor_seconds: float,
    reference_seconds: float,
) -> int:
    last_candidate_delta = float(beat_times[candidate_indices[-1]] - anchor_seconds)
    return max(1, int(round(last_candidate_delta / reference_seconds)))


def _timing_beat_bar_index(index: int, downbeat_offset: int) -> int:
    if downbeat_offset <= 0:
        return index // BEATS_PER_BAR
    if index < downbeat_offset:
        return 0
    return 1 + ((index - downbeat_offset) // BEATS_PER_BAR)


def _infer_downbeat_offset(
    features: HarmonicFeatures,
    beat_times: np.ndarray,
    chord_timeline: list[ChordSegment],
) -> int:
    if beat_times.size < MIN_DOWNBEAT_INFERENCE_BEATS:
        return 0

    beat_interval = _median_beat_interval(beat_times)
    if beat_interval <= 0.0:
        return 0

    proximity_seconds = _downbeat_proximity_seconds(beat_interval)
    chord_scores = _downbeat_chord_scores(beat_times, chord_timeline, proximity_seconds)
    accent_scores = _downbeat_accent_scores(features, beat_times, beat_interval)
    scores = DOWNBEAT_CHORD_WEIGHT * chord_scores + DOWNBEAT_ACCENT_WEIGHT * accent_scores

    best_offset = int(np.argmax(scores))
    if best_offset == 0:
        return 0

    best_score = float(scores[best_offset])
    second_score = float(np.max(np.delete(scores, best_offset)))
    if best_score < DOWNBEAT_MIN_SCORE:
        return 0
    if best_score - second_score < DOWNBEAT_MIN_SCORE_MARGIN:
        return 0
    if best_score - float(scores[0]) < DOWNBEAT_MIN_ZERO_MARGIN:
        return 0
    return best_offset


def _median_beat_interval(beat_times: np.ndarray) -> float:
    intervals = np.diff(beat_times.astype(np.float64))
    intervals = intervals[np.isfinite(intervals) & (intervals > 0.0)]
    if intervals.size == 0:
        return 0.0
    return float(np.median(intervals))


def _downbeat_proximity_seconds(beat_interval: float) -> float:
    return float(
        np.clip(
            beat_interval * DOWNBEAT_PROXIMITY_BEAT_FRACTION,
            MIN_DOWNBEAT_PROXIMITY_SECONDS,
            MAX_DOWNBEAT_PROXIMITY_SECONDS,
        )
    )


def _downbeat_chord_scores(
    beat_times: np.ndarray,
    chord_timeline: list[ChordSegment],
    proximity_seconds: float,
) -> np.ndarray:
    scores = np.zeros(BEATS_PER_BAR, dtype=np.float32)
    change_starts = _usable_chord_change_starts(beat_times, chord_timeline, proximity_seconds)
    if not change_starts:
        return scores

    for start_seconds in change_starts:
        distances = np.abs(beat_times - start_seconds)
        nearest_index = int(np.argmin(distances))
        distance = float(distances[nearest_index])
        if distance > proximity_seconds:
            continue
        offset = nearest_index % BEATS_PER_BAR
        scores[offset] += np.float32(1.0 - distance / proximity_seconds)

    return (scores / max(len(change_starts), 3)).astype(np.float32)


def _usable_chord_change_starts(
    beat_times: np.ndarray,
    chord_timeline: list[ChordSegment],
    proximity_seconds: float,
) -> list[float]:
    if not chord_timeline:
        return []

    first_beat_seconds = float(beat_times[0])
    initial_ignore_seconds = max(first_beat_seconds + proximity_seconds, proximity_seconds)
    starts: list[float] = []
    for index, segment in enumerate(chord_timeline):
        start_seconds = float(segment["start_seconds"])
        if not np.isfinite(start_seconds):
            continue
        if index == 0 and start_seconds <= initial_ignore_seconds:
            continue
        if start_seconds <= initial_ignore_seconds:
            continue
        starts.append(start_seconds)
    return starts


def _downbeat_accent_scores(
    features: HarmonicFeatures,
    beat_times: np.ndarray,
    beat_interval: float,
) -> np.ndarray:
    scores = np.zeros(BEATS_PER_BAR, dtype=np.float32)
    strengths = _beat_accent_strengths(features, beat_times, beat_interval)
    if strengths.size < MIN_DOWNBEAT_INFERENCE_BEATS:
        return scores

    beat_positions = np.arange(strengths.size) % BEATS_PER_BAR
    for offset in range(BEATS_PER_BAR):
        candidate_strengths = strengths[beat_positions == offset]
        other_strengths = strengths[beat_positions != offset]
        if candidate_strengths.size < 2 or other_strengths.size == 0:
            continue
        candidate_mean = float(np.mean(candidate_strengths))
        other_mean = float(np.mean(other_strengths))
        if candidate_mean <= other_mean:
            continue
        scores[offset] = np.float32((candidate_mean - other_mean) / max(candidate_mean, 1e-6))
    return scores


def _beat_accent_strengths(
    features: HarmonicFeatures,
    beat_times: np.ndarray,
    beat_interval: float,
) -> np.ndarray:
    rms_strengths = _rms_strengths_near_beats(features, beat_times, beat_interval)
    percussive_strengths = _percussive_strengths_near_beats(features, beat_times, beat_interval)
    if rms_strengths.size == 0:
        return percussive_strengths
    if percussive_strengths.size == 0:
        return rms_strengths
    return (0.5 * rms_strengths + 0.5 * percussive_strengths).astype(np.float32)


def _rms_strengths_near_beats(
    features: HarmonicFeatures,
    beat_times: np.ndarray,
    beat_interval: float,
) -> np.ndarray:
    if features.rms.size == 0 or features.times.size == 0:
        return np.zeros(0, dtype=np.float32)

    radius_seconds = float(np.clip(beat_interval * 0.18, 0.04, 0.12))
    radius_frames = max(1, int(round(radius_seconds * features.sample_rate / features.hop_length)))
    strengths: list[float] = []
    for seconds in beat_times.tolist():
        frame = int(np.searchsorted(features.times, float(seconds), side="left"))
        frame = max(0, min(frame, features.rms.size - 1))
        start_frame = max(0, frame - radius_frames)
        end_frame = min(features.rms.size, frame + radius_frames + 1)
        strengths.append(float(np.max(features.rms[start_frame:end_frame], initial=0.0)))
    return _normalize_positive_values(np.asarray(strengths, dtype=np.float32))


def _percussive_strengths_near_beats(
    features: HarmonicFeatures,
    beat_times: np.ndarray,
    beat_interval: float,
) -> np.ndarray:
    if features.percussive_signal.size == 0 or features.sample_rate <= 0:
        return np.zeros(0, dtype=np.float32)

    radius_samples = max(1, int(round(np.clip(beat_interval * 0.16, 0.035, 0.11) * features.sample_rate)))
    strengths: list[float] = []
    for seconds in beat_times.tolist():
        center_sample = int(round(float(seconds) * features.sample_rate))
        start_sample = max(0, center_sample - radius_samples)
        end_sample = min(features.percussive_signal.size, center_sample + radius_samples + 1)
        if end_sample <= start_sample:
            strengths.append(0.0)
            continue
        window = features.percussive_signal[start_sample:end_sample]
        strengths.append(float(np.sqrt(np.mean(np.square(window.astype(np.float32))))))
    return _normalize_positive_values(np.asarray(strengths, dtype=np.float32))


def _normalize_positive_values(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return np.zeros(0, dtype=np.float32)
    clean_values = np.nan_to_num(values.astype(np.float32), copy=False)
    positives = clean_values[clean_values > 0.0]
    if positives.size == 0:
        return np.zeros(clean_values.size, dtype=np.float32)
    reference = max(float(np.percentile(positives, 90.0)), float(np.max(positives)) * 0.25, 1e-6)
    return np.clip(clean_values / reference, 0.0, 1.0).astype(np.float32)


def _timing_bars(
    beats: list[AnalysisTimingBeatPayload],
    duration_seconds: float,
) -> list[AnalysisTimingBarPayload]:
    bars: list[AnalysisTimingBarPayload] = []
    downbeats = [beat for beat in beats if beat["beat_in_bar"] == 1]
    if not downbeats:
        return bars

    if beats[0]["beat_in_bar"] != 1:
        pickup_start_seconds = beats[0]["seconds"]
        pickup_end_seconds = downbeats[0]["seconds"]
        if pickup_end_seconds > pickup_start_seconds:
            bars.append(
                {
                    "index": 0,
                    "start_seconds": round(float(pickup_start_seconds), 6),
                    "end_seconds": round(float(pickup_end_seconds), 6),
                }
            )

    for downbeat_index, beat in enumerate(downbeats):
        start_seconds = beat["seconds"]
        end_seconds = (
            downbeats[downbeat_index + 1]["seconds"]
            if downbeat_index + 1 < len(downbeats)
            else max(duration_seconds, start_seconds)
        )
        if end_seconds <= start_seconds:
            continue
        bars.append(
            {
                "index": beat["bar_index"],
                "start_seconds": round(float(start_seconds), 6),
                "end_seconds": round(float(end_seconds), 6),
            }
        )
    return bars


def _estimate_key(
    features: HarmonicFeatures,
    chord_timeline: list[ChordSegment],
) -> tuple[str | None, float | None]:
    chroma = active_chroma_mean(features)
    if float(np.linalg.norm(chroma)) <= 0.0:
        return None, None

    profile_scores = _profile_key_scores(chroma)
    chord_scores = _chord_key_scores(chord_timeline)
    if chord_scores is None:
        combined_scores = profile_scores
    else:
        combined_scores = 0.78 * profile_scores + 0.22 * chord_scores

    best_index = int(np.argmax(combined_scores))
    best_score = float(combined_scores[best_index])
    ordered_scores = np.sort(combined_scores)
    second_score = float(ordered_scores[-2]) if ordered_scores.size > 1 else best_score
    margin = max(0.0, best_score - second_score)
    confidence = float(np.clip(0.34 + margin * 4.2, 0.0, 0.96))

    relative_gap = best_score - float(combined_scores[_relative_key_index(best_index)])
    if relative_gap < 0.035:
        confidence *= 0.78
    elif relative_gap < 0.075:
        confidence *= 0.9

    if best_index < 12:
        return f"{NOTE_NAMES[best_index]} major", round(confidence, 3)
    return f"{NOTE_NAMES[best_index - 12]} minor", round(confidence, 3)


def _profile_key_scores(chroma: np.ndarray) -> np.ndarray:
    normalized_chroma = _zscore(chroma)
    scores = []
    for pitch_class in range(12):
        scores.append(_correlation_score(normalized_chroma, np.roll(MAJOR_PROFILE, pitch_class)))
    for pitch_class in range(12):
        scores.append(_correlation_score(normalized_chroma, np.roll(MINOR_PROFILE, pitch_class)))
    return ((np.array(scores, dtype=np.float32) + 1.0) / 2.0).astype(np.float32)


def _chord_key_scores(chord_timeline: list[ChordSegment]) -> np.ndarray | None:
    scores = np.zeros(24, dtype=np.float32)
    total_duration = 0.0
    for segment in chord_timeline:
        pitch_class = segment["pitch_class"]
        quality = segment["quality"]
        if pitch_class is None or quality is None:
            continue
        duration = max(0.0, float(segment["end_seconds"]) - float(segment["start_seconds"]))
        if duration <= 0.0:
            continue
        total_duration += duration
        for key_pitch_class in range(12):
            scores[key_pitch_class] += duration * _compatibility_score(
                pitch_class,
                quality,
                key_pitch_class,
                "major",
            )
            scores[12 + key_pitch_class] += duration * _compatibility_score(
                pitch_class,
                quality,
                key_pitch_class,
                "minor",
            )

    if total_duration <= 0.0:
        return None
    return scores / total_duration


def _compatibility_score(
    chord_pitch_class: int,
    quality: str,
    key_pitch_class: int,
    mode: str,
) -> float:
    degree = (chord_pitch_class - key_pitch_class) % 12
    expected = MAJOR_DIATONIC_QUALITIES if mode == "major" else MINOR_DIATONIC_QUALITIES
    expected_qualities = expected.get(degree)
    if expected_qualities is None:
        return 0.0
    if quality in expected_qualities:
        return 1.0
    if quality in {"sus2", "sus4"} and expected_qualities & {"major", "minor", "7"}:
        return 0.65
    if quality in {"7", "maj7", "m7"} and expected_qualities & {"major", "minor"}:
        return 0.55
    return 0.35


def _relative_key_index(key_index: int) -> int:
    if key_index < 12:
        return 12 + ((key_index + 9) % 12)
    return (key_index - 12 + 3) % 12


def _correlation_score(chroma_zscore: np.ndarray, profile: np.ndarray) -> float:
    profile_zscore = _zscore(profile)
    denominator = float(np.linalg.norm(chroma_zscore) * np.linalg.norm(profile_zscore))
    if denominator <= 0.0:
        return 0.0
    return float(np.dot(chroma_zscore, profile_zscore) / denominator)


def _zscore(values: np.ndarray) -> np.ndarray:
    centered = values.astype(np.float32) - float(np.mean(values))
    std = float(np.std(centered))
    if std <= 0.0:
        return centered
    return centered / std
