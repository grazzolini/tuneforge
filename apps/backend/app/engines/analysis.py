from __future__ import annotations

from pathlib import Path
from typing import TypedDict

import numpy as np

from app.engines.audio_features import HarmonicFeatures, active_chroma_mean, extract_harmonic_features
from app.engines.chords import ChordSegment, detect_chords_from_features

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


class AnalysisPayload(TypedDict):
    estimated_key: str | None
    key_confidence: float | None
    estimated_reference_hz: float | None
    tuning_offset_cents: float | None
    tempo_bpm: float | None


def analyze_track(source_path: Path) -> AnalysisPayload:
    features = extract_harmonic_features(source_path)
    if features.signal.size == 0:
        return {
            "estimated_key": None,
            "key_confidence": None,
            "estimated_reference_hz": None,
            "tuning_offset_cents": None,
            "tempo_bpm": None,
        }

    chord_timeline = detect_chords_from_features(features)
    estimated_key, key_confidence = _estimate_key(features, chord_timeline)
    return {
        "estimated_key": estimated_key,
        "key_confidence": key_confidence,
        "estimated_reference_hz": features.estimated_reference_hz,
        "tuning_offset_cents": features.tuning_offset_cents,
        "tempo_bpm": features.tempo_bpm,
    }


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
