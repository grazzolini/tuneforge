from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

from tuneforge_music_core import call as music_core_call


@dataclass(frozen=True)
class ParsedChordLabel:
    raw_label: str
    root_pitch_class: int | None
    quality: str | None
    bass_pitch_class: int | None
    bass_degree: str | None
    display_label: str
    is_no_chord: bool = False
    is_unknown: bool = False


def parse_chord_label(raw_label: str) -> ParsedChordLabel:
    return ParsedChordLabel(**music_core_call({"operation": "backendParseChord", "input": raw_label}))


def normalize_chord_quality(quality: str | None) -> str | None:
    return cast(str | None, music_core_call({"operation": "backendNormalizeQuality", "input": quality}))


def chord_label_to_segment(
    raw_label: str,
    *,
    start_seconds: float,
    end_seconds: float,
    confidence: float | None = None,
) -> dict[str, Any]:
    return cast(dict[str, Any], music_core_call({
        "operation": "backendChordSegment",
        "input": raw_label,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "confidence": confidence,
    }))


def format_chord_display(
    root_pitch_class: int | None,
    quality: str | None,
    bass_pitch_class: int | None = None,
) -> str:
    return cast(str, music_core_call({
        "operation": "backendFormatChord",
        "root": root_pitch_class,
        "quality": quality,
        "bass": bass_pitch_class,
    }))
