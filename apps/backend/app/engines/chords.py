from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict, cast

import librosa
import numpy as np
import soundfile as sf

DISPLAY_NOTE_NAMES = np.array(
    ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"],
    dtype=object,
)
CHORD_SHAPES: dict[str, np.ndarray] = {
    "major": np.array([1.0, 0.0, 0.0, 0.0, 0.88, 0.0, 0.0, 0.72, 0.0, 0.0, 0.0, 0.0], dtype=np.float32),
    "minor": np.array([1.0, 0.0, 0.0, 0.88, 0.0, 0.0, 0.0, 0.72, 0.0, 0.0, 0.0, 0.0], dtype=np.float32),
}
SMOOTHING_WINDOW = 7
MIN_SEGMENT_SECONDS = 0.75


@dataclass(frozen=True)
class ChordTemplate:
    pitch_class: int
    quality: str
    label: str
    vector: np.ndarray


class ChordSegment(TypedDict):
    start_seconds: float
    end_seconds: float
    label: str
    confidence: float | None
    pitch_class: int | None
    quality: str | None


def _load_signal(source_path: Path) -> tuple[np.ndarray, int]:
    signal, sample_rate = sf.read(source_path, always_2d=False)
    if signal.ndim > 1:
        signal = signal.mean(axis=1)
    return signal.astype(np.float32), int(sample_rate)


def _format_chord_label(pitch_class: int, quality: str) -> str:
    note_name = str(DISPLAY_NOTE_NAMES[pitch_class % 12])
    return f"{note_name}m" if quality == "minor" else note_name


def _build_templates() -> tuple[ChordTemplate, ...]:
    templates: list[ChordTemplate] = []
    for quality, template in CHORD_SHAPES.items():
        for pitch_class in range(12):
            vector = np.roll(template, pitch_class).astype(np.float32)
            vector /= np.linalg.norm(vector)
            templates.append(
                ChordTemplate(
                    pitch_class=pitch_class,
                    quality=quality,
                    label=_format_chord_label(pitch_class, quality),
                    vector=vector,
                )
            )
    return tuple(templates)


CHORD_TEMPLATES = _build_templates()


def _smooth_chroma(chroma: np.ndarray) -> np.ndarray:
    if chroma.size == 0:
        return chroma
    kernel = np.ones(SMOOTHING_WINDOW, dtype=np.float32) / SMOOTHING_WINDOW
    return np.vstack([np.convolve(row, kernel, mode="same") for row in chroma]).astype(np.float32)


def _predict_chord(frame: np.ndarray) -> tuple[ChordTemplate, float]:
    frame_norm = float(np.linalg.norm(frame))
    if frame_norm <= 0.0 or not np.isfinite(frame_norm):
        return CHORD_TEMPLATES[0], 0.0
    normalized = frame / frame_norm
    scores = np.array([float(np.dot(normalized, template.vector)) for template in CHORD_TEMPLATES], dtype=np.float32)
    best_idx = int(np.argmax(scores))
    best_score = float(scores[best_idx])
    second_score = float(np.partition(scores, -2)[-2]) if scores.size > 1 else best_score
    confidence = max(0.0, min(1.0, (best_score - second_score) * 4.0))
    return CHORD_TEMPLATES[best_idx], confidence


def _merge_short_segments(segments: list[ChordSegment]) -> list[ChordSegment]:
    if not segments:
        return []

    merged: list[ChordSegment] = [cast(ChordSegment, dict(segments[0]))]
    for segment in segments[1:]:
        previous = merged[-1]
        duration = float(segment["end_seconds"]) - float(segment["start_seconds"])
        if previous["label"] == segment["label"] or duration < MIN_SEGMENT_SECONDS:
            previous["end_seconds"] = segment["end_seconds"]
            previous_confidence = previous["confidence"] or 0.0
            current_confidence = segment["confidence"] or 0.0
            previous["confidence"] = round((previous_confidence + current_confidence) / 2.0, 3)
            continue
        merged.append(cast(ChordSegment, dict(segment)))

    if len(merged) > 1:
        first_duration = float(merged[0]["end_seconds"]) - float(merged[0]["start_seconds"])
        if first_duration < MIN_SEGMENT_SECONDS:
            merged[1]["start_seconds"] = 0.0
            merged.pop(0)

    return merged


def detect_chord_timeline(source_path: Path) -> list[ChordSegment]:
    signal, sample_rate = _load_signal(source_path)
    if signal.size == 0:
        return []

    hop_length = 2048
    total_duration = float(signal.size / sample_rate)
    chroma = librosa.feature.chroma_cqt(y=signal, sr=sample_rate, hop_length=hop_length)
    if chroma.size == 0:
        return []
    chroma = _smooth_chroma(chroma)

    frame_predictions: list[tuple[ChordTemplate, float]] = [
        _predict_chord(chroma[:, index]) for index in range(chroma.shape[1])
    ]
    if not frame_predictions:
        return []

    raw_segments: list[ChordSegment] = []
    segment_start = 0
    current_template, _ = frame_predictions[0]
    for frame_index in range(1, len(frame_predictions) + 1):
        at_boundary = frame_index == len(frame_predictions)
        next_template = frame_predictions[frame_index][0] if not at_boundary else None
        if not at_boundary and next_template and next_template.label == current_template.label:
            continue

        start_seconds = round(segment_start * hop_length / sample_rate, 3)
        end_seconds = round(min(total_duration, frame_index * hop_length / sample_rate), 3)
        confidence = round(
            float(np.mean([prediction[1] for prediction in frame_predictions[segment_start:frame_index]])),
            3,
        )
        raw_segments.append(
            {
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "label": current_template.label,
                "confidence": confidence,
                "pitch_class": current_template.pitch_class,
                "quality": current_template.quality,
            }
        )
        if not at_boundary:
            segment_start = frame_index
            assert next_template is not None
            current_template = next_template

    return _merge_short_segments(raw_segments)
