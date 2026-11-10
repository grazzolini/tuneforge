from __future__ import annotations

import math
import unicodedata
from collections import Counter
from typing import Any

import numpy as np

from app.engines.chord_labels import parse_chord_label

LABELS = ["start", "end", "intro", "outro", "break", "bridge", "inst", "solo", "verse", "chorus"]


def _lyric_token(text: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(text)).casefold()
    return "".join(
        character for character in normalized if character.isalnum() or unicodedata.category(character).startswith("M")
    )


def refine_sections(raw: dict[str, Any], cues: dict[str, Any]) -> list[dict[str, Any]]:
    """Refine ordered section occurrences using timing, harmony, lyric, and vocal cues."""
    segments = [dict(s) for s in raw["segments"]]
    energy = np.asarray(raw["vocal_energy"])
    section_activation = np.asarray(raw["segment_activation"])
    label_activation = np.asarray(raw["label_activation"])
    duration = max(float(s["end_seconds"]) for s in segments)

    def number(value: object) -> float | None:
        if (
            isinstance(value, (float, int))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and 0 <= value <= duration
        ):
            return float(value)
        return None

    def interval(item: dict[str, Any]) -> tuple[float, float] | None:
        start, end = number(item.get("start_seconds")), number(item.get("end_seconds"))
        return (start, end) if start is not None and end is not None and start < end else None

    beats = [value for item in cues["beats"] if (value := number(item)) is not None]
    bars = [value for item in cues["bars"] if (value := number(item)) is not None]
    chords = [
        item
        for item in cues["chords"]
        if number(item[0]) is not None and number(item[1]) is not None and item[0] < item[1]
    ]
    actual_chord_labels = set()
    for label in {str(chord[2]) for chord in chords}:
        parsed = parse_chord_label(label)
        if parsed.root_pitch_class is not None and not parsed.is_no_chord and not parsed.is_unknown:
            actual_chord_labels.add(label)
    phrases = [times[0] for item in cues["lyrics"] if (times := interval(item)) is not None]
    words = [
        (times[0], times[1], _lyric_token(word.get("text", "")))
        for segment in cues["lyrics"]
        for word in segment.get("words", [])
        if (times := interval(word)) is not None
    ]

    def chord_at(time: float) -> str:
        return next((str(c[2]) for c in chords if c[0] <= time < c[1]), "N")

    def proximity(values: list[float], time: float, scale: float) -> float:
        return math.exp(-min((abs(v - time) for v in values), default=999) / scale)

    def terms(time: float, original: float) -> dict[str, float]:
        index = min(len(energy) - 1, max(0, int(time * 10)))
        before, after = energy[max(0, index - 10) : index], energy[index : index + 10]
        vocal = (
            float(abs(before.mean() - after.mean()) / (max(before.mean(), after.mean()) + 1e-9))
            if len(before) and len(after)
            else 0.0
        )
        left = Counter(chord_at(t) for t in np.linspace(max(0, time - 2), max(0, time - 0.01), 20))
        right = Counter(chord_at(t) for t in np.linspace(time, time + 2, 20))
        change = sum(abs(left[k] - right[k]) for k in left.keys() | right.keys()) / 40 if chords else 0.0
        return {
            "model": 0.35 * float(section_activation[min(len(section_activation) - 1, max(0, round(time * 100)))]),
            "bar": 0.20 * proximity(bars, time, 0.12),
            "beat": 0.10 * proximity(beats, time, 0.08),
            "chord": 0.20 * change,
            "lyrics": 0.10 * proximity(phrases, time, 0.25),
            "vocal": 0.05 * vocal,
            "shift_cost": -0.15 * abs(time - original) / 0.75,
        }

    for i in range(1, len(segments)):
        old = float(raw["segments"][i]["start_seconds"])
        candidates = {old, *(v for v in beats + bars + phrases + [c[0] for c in chords] if abs(v - old) <= 0.75)}
        candidates = {
            v for v in candidates if segments[i - 1]["start_seconds"] + 1 < v < segments[i]["end_seconds"] - 1
        }
        original = terms(old, old)
        best, new = sum(original.values()), old
        for value in sorted(candidates):
            score = sum(terms(value, old).values())
            if score > best + 1e-12:
                best, new = score, value
        if best - sum(original.values()) < 0.05:
            new = old
        segments[i - 1]["end_seconds"], segments[i]["start_seconds"] = new, new

    features: list[dict[str, Any]] = []
    for segment in segments:
        start, end = segment["start_seconds"], segment["end_seconds"]
        values = energy[max(0, int(start * 10)) : min(len(energy), max(1, int(end * 10)))]
        features.append(
            {
                "chords": [chord_at(t) for t in np.linspace(start + 0.001, end - 0.001, 32)] if chords else [],
                "words": {w[2] for w in words if w[2] and start <= 0.5 * (w[0] + w[1]) < end},
                "vocal": float(np.mean(values > raw["vocal_threshold"])) if len(values) else 0.0,
            }
        )
    count = len(segments)
    chord_similarity, lyric_similarity = np.zeros((count, count)), np.zeros((count, count))

    for i, a in enumerate(features):
        for j, other in enumerate(features[:i]):
            overlap = [
                (left, right)
                for left, right in zip(a["chords"], other["chords"], strict=True)
                if left in actual_chord_labels and right in actual_chord_labels
            ]
            chord = sum(left == right for left, right in overlap) / len(overlap) if overlap else 0.0
            lyric = (
                len(a["words"] & other["words"]) / len(a["words"] | other["words"])
                if a["words"] and other["words"]
                else None
            )
            chord_similarity[i, j] = chord_similarity[j, i] = chord or 0.0
            lyric_similarity[i, j] = lyric_similarity[j, i] = lyric or 0.0
    for i, segment in enumerate(segments):
        start = max(0, int(segment["start_seconds"] * 100))
        end = min(label_activation.shape[1], max(start + 1, int(segment["end_seconds"] * 100)))
        probabilities = label_activation[:, start:end].mean(axis=1, dtype=np.float64)
        original = raw["segments"][i]["label"]
        label = original
        lyric, chord, vocal = float(lyric_similarity[i].max()), float(chord_similarity[i].max()), features[i]["vocal"]
        adjustments = {
            "chorus": 0.07 * lyric + 0.05 * chord,
            "verse": 0.07 * (1 - lyric) if features[i]["words"] and vocal > 0.25 else 0.0,
        }
        margin = float(abs(probabilities[8] - probabilities[9]))
        if original in {"verse", "chorus"} and margin <= 0.15:
            alternative = "verse" if original == "chorus" else "chorus"
            if (
                probabilities[LABELS.index(alternative)] + adjustments[alternative]
                >= probabilities[LABELS.index(original)] + adjustments[original] + 0.03
            ):
                label = alternative
            elif margin < 0.02 and max(adjustments.values()) == 0:
                label = "uncertain"
        segment["label"] = label
    return segments
