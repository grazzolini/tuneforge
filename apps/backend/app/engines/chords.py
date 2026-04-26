from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict, cast

import numpy as np

from app.engines.audio_features import (
    ANALYSIS_HOP_LENGTH,
    HarmonicFeatures,
    combined_chroma,
    extract_harmonic_features,
)

DISPLAY_NOTE_NAMES = np.array(
    ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"],
    dtype=object,
)
MIN_WINDOW_SECONDS = 0.38
FIXED_WINDOW_SECONDS = 0.55
LOW_ENERGY_THRESHOLD = 0.045
MIN_BLIP_SECONDS = 0.55
LOW_CONFIDENCE_BLIP = 0.38


@dataclass(frozen=True)
class ChordShape:
    quality: str
    suffix: str
    intervals: tuple[tuple[int, float], ...]
    complexity_penalty: float = 0.0


@dataclass(frozen=True)
class ChordTemplate:
    pitch_class: int
    quality: str
    label: str
    vector: np.ndarray
    complexity_penalty: float


@dataclass(frozen=True)
class WindowObservation:
    start_frame: int
    end_frame: int
    start_seconds: float
    end_seconds: float
    energy: float
    chroma: np.ndarray
    scores: np.ndarray


class ChordSegment(TypedDict):
    start_seconds: float
    end_seconds: float
    label: str
    confidence: float | None
    pitch_class: int | None
    quality: str | None


CHORD_SHAPES: tuple[ChordShape, ...] = (
    ChordShape("major", "", ((0, 1.0), (4, 0.88), (7, 0.76))),
    ChordShape("minor", "m", ((0, 1.0), (3, 0.88), (7, 0.76))),
    ChordShape("7", "7", ((0, 1.0), (4, 0.86), (7, 0.72), (10, 0.58)), 0.02),
    ChordShape("maj7", "maj7", ((0, 1.0), (4, 0.86), (7, 0.72), (11, 0.58)), 0.02),
    ChordShape("m7", "m7", ((0, 1.0), (3, 0.86), (7, 0.72), (10, 0.58)), 0.02),
    ChordShape("sus2", "sus2", ((0, 1.0), (2, 0.82), (7, 0.74)), 0.015),
    ChordShape("sus4", "sus4", ((0, 1.0), (5, 0.82), (7, 0.74)), 0.015),
    ChordShape("dim", "dim", ((0, 1.0), (3, 0.84), (6, 0.72)), 0.02),
)


def _template_vector(intervals: tuple[tuple[int, float], ...], pitch_class: int) -> np.ndarray:
    vector = np.zeros(12, dtype=np.float32)
    for interval, weight in intervals:
        vector[(pitch_class + interval) % 12] = weight
    norm = float(np.linalg.norm(vector))
    if norm > 0.0:
        vector /= norm
    return vector


def _format_chord_label(pitch_class: int, quality: str) -> str:
    note_name = str(DISPLAY_NOTE_NAMES[pitch_class % 12])
    if quality == "major":
        return note_name
    if quality == "minor":
        return f"{note_name}m"
    return f"{note_name}{quality}"


CHORD_TEMPLATES = tuple(
    ChordTemplate(
        pitch_class=pitch_class,
        quality=shape.quality,
        label=f"{DISPLAY_NOTE_NAMES[pitch_class]}{shape.suffix}",
        vector=_template_vector(shape.intervals, pitch_class),
        complexity_penalty=shape.complexity_penalty,
    )
    for shape in CHORD_SHAPES
    for pitch_class in range(12)
)
NONE_STATE_INDEX = len(CHORD_TEMPLATES)


def detect_chord_timeline(source_path: Path) -> list[ChordSegment]:
    features = extract_harmonic_features(source_path)
    return detect_chords_from_features(features)


def detect_chords_from_features(features: HarmonicFeatures) -> list[ChordSegment]:
    if features.signal.size == 0 or features.duration_seconds <= 0.0:
        return []

    observations = _window_observations(features)
    if not observations:
        if _is_low_energy(features):
            return [_no_chord_segment(0.0, features.duration_seconds)]
        return []

    state_path = _viterbi_smooth(observations)
    raw_segments = _segments_from_path(observations, state_path)
    return _simplify_low_confidence_extensions(_merge_low_confidence_blips(raw_segments))


def _window_observations(features: HarmonicFeatures) -> list[WindowObservation]:
    chroma = combined_chroma(features)
    frame_count = chroma.shape[1]
    if frame_count == 0:
        return []

    boundaries = _window_boundaries(features, frame_count)
    peak_rms = float(np.max(features.rms)) if features.rms.size else 0.0
    observations: list[WindowObservation] = []
    for start_frame, end_frame in zip(boundaries[:-1], boundaries[1:], strict=True):
        if end_frame <= start_frame:
            continue
        window_chroma = _weighted_window_chroma(features, chroma, start_frame, end_frame)
        energy = _window_energy(features, start_frame, end_frame, peak_rms)
        observations.append(
            WindowObservation(
                start_frame=start_frame,
                end_frame=end_frame,
                start_seconds=round(start_frame * ANALYSIS_HOP_LENGTH / features.sample_rate, 3),
                end_seconds=round(
                    min(features.duration_seconds, end_frame * ANALYSIS_HOP_LENGTH / features.sample_rate),
                    3,
                ),
                energy=energy,
                chroma=window_chroma,
                scores=_template_scores(window_chroma, energy),
            )
        )
    return observations


def _window_boundaries(features: HarmonicFeatures, frame_count: int) -> list[int]:
    min_step_frames = max(1, int(round(MIN_WINDOW_SECONDS * features.sample_rate / features.hop_length)))
    if features.beat_frames.size >= 4:
        boundaries = [0]
        for beat_frame in features.beat_frames.tolist():
            if beat_frame - boundaries[-1] >= min_step_frames:
                boundaries.append(int(beat_frame))
        if frame_count - boundaries[-1] >= min_step_frames:
            boundaries.append(frame_count)
        else:
            boundaries[-1] = frame_count
        if len(boundaries) >= 3:
            return _dedupe_boundaries(boundaries, frame_count)

    fixed_step_frames = max(1, int(round(FIXED_WINDOW_SECONDS * features.sample_rate / features.hop_length)))
    boundaries = list(range(0, frame_count, fixed_step_frames))
    if boundaries[-1] != frame_count:
        boundaries.append(frame_count)
    return _dedupe_boundaries(boundaries, frame_count)


def _dedupe_boundaries(boundaries: list[int], frame_count: int) -> list[int]:
    deduped: list[int] = []
    for boundary in boundaries:
        bounded = max(0, min(frame_count, int(boundary)))
        if not deduped or bounded > deduped[-1]:
            deduped.append(bounded)
    if not deduped or deduped[0] != 0:
        deduped.insert(0, 0)
    if deduped[-1] != frame_count:
        deduped.append(frame_count)
    return deduped


def _weighted_window_chroma(
    features: HarmonicFeatures,
    chroma: np.ndarray,
    start_frame: int,
    end_frame: int,
) -> np.ndarray:
    window = chroma[:, start_frame:end_frame]
    if window.size == 0:
        return np.zeros(12, dtype=np.float32)

    active_mask = features.active_frame_mask[start_frame:end_frame]
    rms = features.rms[start_frame:end_frame]
    if active_mask.any() and float(rms[active_mask].sum()) > 0.0:
        vector = np.average(window[:, active_mask], axis=1, weights=rms[active_mask])
    elif float(rms.sum()) > 0.0:
        vector = np.average(window, axis=1, weights=rms)
    else:
        vector = window.mean(axis=1)

    vector = np.nan_to_num(vector.astype(np.float32), copy=False)
    norm = float(np.linalg.norm(vector))
    if norm <= 0.0:
        return np.zeros(12, dtype=np.float32)
    return (vector / norm).astype(np.float32)


def _window_energy(features: HarmonicFeatures, start_frame: int, end_frame: int, peak_rms: float) -> float:
    if peak_rms <= 0.0 or features.rms.size == 0:
        return 0.0
    window_rms = features.rms[start_frame:end_frame]
    if window_rms.size == 0:
        return 0.0
    return float(np.clip(float(np.mean(window_rms)) / peak_rms, 0.0, 1.0))


def _template_scores(chroma: np.ndarray, energy: float) -> np.ndarray:
    scores = np.empty(len(CHORD_TEMPLATES) + 1, dtype=np.float32)
    chroma_norm = float(np.linalg.norm(chroma))
    if energy < LOW_ENERGY_THRESHOLD or chroma_norm <= 0.0:
        scores[:NONE_STATE_INDEX] = -0.15
        scores[NONE_STATE_INDEX] = 0.95
        return scores

    for index, template in enumerate(CHORD_TEMPLATES):
        scores[index] = float(np.dot(chroma, template.vector)) - template.complexity_penalty
    _penalize_weak_extensions(scores, chroma)
    scores[NONE_STATE_INDEX] = 0.08 if energy >= LOW_ENERGY_THRESHOLD else 0.95
    return scores


def _penalize_weak_extensions(scores: np.ndarray, chroma: np.ndarray) -> None:
    index_by_quality = {
        (template.pitch_class, template.quality): index for index, template in enumerate(CHORD_TEMPLATES)
    }
    for pitch_class in range(12):
        major_score = float(scores[index_by_quality[(pitch_class, "major")]])
        minor_score = float(scores[index_by_quality[(pitch_class, "minor")]])
        _require_clear_extension(
            chroma,
            scores,
            index_by_quality[(pitch_class, "7")],
            major_score,
            chord_tones=(0, 4, 7),
            color_tone=10,
        )
        _require_clear_extension(
            chroma,
            scores,
            index_by_quality[(pitch_class, "maj7")],
            major_score,
            chord_tones=(0, 4, 7),
            color_tone=11,
        )
        _require_clear_extension(
            chroma,
            scores,
            index_by_quality[(pitch_class, "m7")],
            minor_score,
            chord_tones=(0, 3, 7),
            color_tone=10,
        )
        suspended_baseline = max(major_score, minor_score)
        _require_clear_suspension(
            chroma,
            scores,
            index_by_quality[(pitch_class, "sus2")],
            suspended_baseline,
            pitch_class,
            suspended_tone=2,
        )
        _require_clear_suspension(
            chroma,
            scores,
            index_by_quality[(pitch_class, "sus4")],
            suspended_baseline,
            pitch_class,
            suspended_tone=5,
        )


def _require_clear_extension(
    chroma: np.ndarray,
    scores: np.ndarray,
    extension_index: int,
    baseline_score: float,
    *,
    chord_tones: tuple[int, int, int],
    color_tone: int,
) -> None:
    template = CHORD_TEMPLATES[extension_index]
    body = [float(chroma[(template.pitch_class + interval) % 12]) for interval in chord_tones]
    color = float(chroma[(template.pitch_class + color_tone) % 12])
    if min(body) < 0.14 or color < 0.16 or color < min(body) * 0.75:
        scores[extension_index] = np.float32(baseline_score - 0.02)


def _require_clear_suspension(
    chroma: np.ndarray,
    scores: np.ndarray,
    extension_index: int,
    baseline_score: float,
    pitch_class: int,
    *,
    suspended_tone: int,
) -> None:
    root = float(chroma[pitch_class % 12])
    fifth = float(chroma[(pitch_class + 7) % 12])
    suspended = float(chroma[(pitch_class + suspended_tone) % 12])
    third = max(float(chroma[(pitch_class + 3) % 12]), float(chroma[(pitch_class + 4) % 12]))
    if min(root, fifth, suspended) < 0.14 or suspended < third * 1.15:
        scores[extension_index] = np.float32(baseline_score - 0.02)


def _viterbi_smooth(observations: list[WindowObservation]) -> list[int]:
    state_count = len(CHORD_TEMPLATES) + 1
    previous_scores = observations[0].scores.astype(np.float64)
    backpointers: list[np.ndarray] = []

    for observation in observations[1:]:
        current_scores = np.empty(state_count, dtype=np.float64)
        current_backpointers = np.empty(state_count, dtype=np.int64)
        for state_index in range(state_count):
            transitions = np.array(
                [
                    previous_scores[previous_index] + _transition_score(previous_index, state_index)
                    for previous_index in range(state_count)
                ],
                dtype=np.float64,
            )
            best_previous = int(np.argmax(transitions))
            current_scores[state_index] = transitions[best_previous] + float(observation.scores[state_index])
            current_backpointers[state_index] = best_previous
        previous_scores = current_scores
        backpointers.append(current_backpointers)

    state = int(np.argmax(previous_scores))
    path = [state]
    for current_backpointers in reversed(backpointers):
        state = int(current_backpointers[state])
        path.append(state)
    path.reverse()
    return path


def _transition_score(previous_index: int, current_index: int) -> float:
    if previous_index == current_index:
        return 0.10
    if previous_index == NONE_STATE_INDEX or current_index == NONE_STATE_INDEX:
        return -0.08

    previous = CHORD_TEMPLATES[previous_index]
    current = CHORD_TEMPLATES[current_index]
    if previous.pitch_class == current.pitch_class:
        return -0.025
    interval = (current.pitch_class - previous.pitch_class) % 12
    if interval in {2, 5, 7, 10}:
        return -0.075
    return -0.13


def _segments_from_path(observations: list[WindowObservation], state_path: list[int]) -> list[ChordSegment]:
    segments: list[ChordSegment] = []
    segment_start = 0
    current_state = state_path[0]

    for index in range(1, len(state_path) + 1):
        at_boundary = index == len(state_path)
        next_state = state_path[index] if not at_boundary else None
        if not at_boundary and next_state == current_state:
            continue

        start = observations[segment_start].start_seconds
        end = observations[index - 1].end_seconds
        segment_observations = observations[segment_start:index]
        segments.append(_segment_for_state(current_state, start, end, segment_observations))
        if not at_boundary:
            segment_start = index
            assert next_state is not None
            current_state = next_state

    return _merge_adjacent_same_label(segments)


def _segment_for_state(
    state_index: int,
    start_seconds: float,
    end_seconds: float,
    observations: list[WindowObservation],
) -> ChordSegment:
    if state_index == NONE_STATE_INDEX:
        return _no_chord_segment(start_seconds, end_seconds)

    template = CHORD_TEMPLATES[state_index]
    confidences = [_confidence_for_state(observation.scores, state_index) for observation in observations]
    label = template.label
    pitch_class = template.pitch_class
    quality = template.quality
    if template.quality == "m7" and _minor_seventh_sounds_like_upper_triad(template, observations, state_index):
        pitch_class = (template.pitch_class + 3) % 12
        quality = "major"
        label = _format_chord_label(pitch_class, quality)
    return {
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "label": label,
        "confidence": round(float(np.mean(confidences)), 3),
        "pitch_class": pitch_class,
        "quality": quality,
    }


def _minor_seventh_sounds_like_upper_triad(
    template: ChordTemplate,
    observations: list[WindowObservation],
    state_index: int,
) -> bool:
    chroma = _average_observation_chroma(observations)
    root = float(chroma[template.pitch_class % 12])
    upper_triad = (
        float(chroma[(template.pitch_class + 3) % 12]),
        float(chroma[(template.pitch_class + 7) % 12]),
        float(chroma[(template.pitch_class + 10) % 12]),
    )
    if min(upper_triad) < 0.16 or root >= max(upper_triad) * 0.9:
        return False

    relative_major_index = next(
        index
        for index, candidate in enumerate(CHORD_TEMPLATES)
        if candidate.pitch_class == (template.pitch_class + 3) % 12 and candidate.quality == "major"
    )
    average_scores = np.mean([observation.scores for observation in observations], axis=0)
    return bool(float(average_scores[state_index]) - float(average_scores[relative_major_index]) < 0.12)


def _average_observation_chroma(observations: list[WindowObservation]) -> np.ndarray:
    if not observations:
        return np.zeros(12, dtype=np.float32)
    return np.mean([observation.chroma for observation in observations], axis=0).astype(np.float32)


def _confidence_for_state(scores: np.ndarray, state_index: int) -> float:
    selected_score = float(scores[state_index])
    template_scores = np.delete(scores[:NONE_STATE_INDEX], state_index)
    second_score = float(np.max(template_scores)) if template_scores.size else selected_score
    confidence = (selected_score - second_score) * 4.0 + (selected_score - 0.58) * 1.2
    return float(np.clip(confidence, 0.0, 1.0))


def _merge_adjacent_same_label(segments: list[ChordSegment]) -> list[ChordSegment]:
    if not segments:
        return []

    merged: list[ChordSegment] = [cast(ChordSegment, dict(segments[0]))]
    for segment in segments[1:]:
        previous = merged[-1]
        if previous["label"] != segment["label"]:
            merged.append(cast(ChordSegment, dict(segment)))
            continue
        previous["end_seconds"] = segment["end_seconds"]
        previous["confidence"] = _merge_confidence(previous, segment)
    return merged


def _merge_low_confidence_blips(segments: list[ChordSegment]) -> list[ChordSegment]:
    merged = _merge_adjacent_same_label(segments)
    index = 0
    while index < len(merged):
        segment = merged[index]
        duration = float(segment["end_seconds"]) - float(segment["start_seconds"])
        confidence = segment["confidence"] if segment["confidence"] is not None else 1.0
        if duration >= MIN_BLIP_SECONDS or confidence >= LOW_CONFIDENCE_BLIP or len(merged) == 1:
            index += 1
            continue

        if index == 0:
            merged[1]["start_seconds"] = segment["start_seconds"]
            merged[1]["confidence"] = _merge_confidence(merged[1], segment)
        elif index == len(merged) - 1:
            merged[index - 1]["end_seconds"] = segment["end_seconds"]
            merged[index - 1]["confidence"] = _merge_confidence(merged[index - 1], segment)
        else:
            previous_confidence = merged[index - 1]["confidence"] or 0.0
            next_confidence = merged[index + 1]["confidence"] or 0.0
            if previous_confidence >= next_confidence:
                merged[index - 1]["end_seconds"] = segment["end_seconds"]
                merged[index - 1]["confidence"] = _merge_confidence(merged[index - 1], segment)
            else:
                merged[index + 1]["start_seconds"] = segment["start_seconds"]
                merged[index + 1]["confidence"] = _merge_confidence(merged[index + 1], segment)
        merged.pop(index)
        merged = _merge_adjacent_same_label(merged)
        index = max(index - 1, 0)
    return merged


def _simplify_low_confidence_extensions(segments: list[ChordSegment]) -> list[ChordSegment]:
    simplified: list[ChordSegment] = []
    for segment in segments:
        quality = segment["quality"]
        confidence = segment["confidence"] or 0.0
        pitch_class = segment["pitch_class"]
        threshold = 0.52 if quality in {"sus2", "sus4"} else 0.62
        if pitch_class is None or quality not in {"7", "maj7", "m7", "sus2", "sus4", "dim"} or confidence >= threshold:
            simplified.append(segment)
            continue
        next_quality = "minor" if quality in {"m7", "dim"} else "major"
        simplified.append(
            {
                **segment,
                "label": _format_chord_label(pitch_class, next_quality),
                "quality": next_quality,
            }
        )
    return _merge_adjacent_same_label(simplified)


def _merge_confidence(first: ChordSegment, second: ChordSegment) -> float | None:
    first_confidence = first["confidence"]
    second_confidence = second["confidence"]
    if first_confidence is None:
        return second_confidence
    if second_confidence is None:
        return first_confidence
    first_duration = float(first["end_seconds"]) - float(first["start_seconds"])
    second_duration = float(second["end_seconds"]) - float(second["start_seconds"])
    total_duration = max(first_duration + second_duration, 1e-6)
    return round(float((first_confidence * first_duration + second_confidence * second_duration) / total_duration), 3)


def _no_chord_segment(start_seconds: float, end_seconds: float) -> ChordSegment:
    return {
        "start_seconds": round(start_seconds, 3),
        "end_seconds": round(end_seconds, 3),
        "label": "N.C.",
        "confidence": None,
        "pitch_class": None,
        "quality": None,
    }


def _is_low_energy(features: HarmonicFeatures) -> bool:
    return features.rms.size == 0 or float(np.max(features.rms)) <= 1e-6
