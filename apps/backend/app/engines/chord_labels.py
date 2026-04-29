from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

NOTE_TO_PITCH_CLASS: dict[str, int] = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}

PITCH_CLASS_TO_SHARP = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
NO_CHORD_LABELS = {"N", "NC", "N.C.", "NO_CHORD", "NO-CHORD"}
UNKNOWN_CHORD_LABELS = {"X"}

QUALITY_ALIASES: dict[str, str] = {
    "": "major",
    "maj": "major",
    "major": "major",
    "min": "minor",
    "minor": "minor",
    "m": "minor",
    "dim": "dim",
    "diminished": "dim",
    "aug": "aug",
    "augmented": "aug",
    "+": "aug",
    "sus2": "sus2",
    "sus": "sus4",
    "sus4": "sus4",
    "7": "7",
    "dom7": "7",
    "maj7": "maj7",
    "major7": "maj7",
    "min7": "m7",
    "minor7": "m7",
    "m7": "m7",
    "dim7": "dim7",
    "hdim7": "hdim7",
    "half-diminished": "hdim7",
    "half-diminished7": "hdim7",
    "min7(b5)": "hdim7",
    "m7(b5)": "hdim7",
    "min7b5": "hdim7",
    "m7b5": "hdim7",
}

QUALITY_SUFFIXES: dict[str, str] = {
    "major": "",
    "minor": "m",
    "dim": "dim",
    "aug": "aug",
    "sus2": "sus2",
    "sus4": "sus4",
    "7": "7",
    "maj7": "maj7",
    "m7": "m7",
    "dim7": "dim7",
    "hdim7": "m7b5",
    "no_chord": "",
}

DEGREE_TO_SEMITONE: dict[str, int] = {
    "1": 0,
    "b2": 1,
    "#1": 1,
    "2": 2,
    "#2": 3,
    "b3": 3,
    "3": 4,
    "4": 5,
    "#4": 6,
    "b5": 6,
    "5": 7,
    "#5": 8,
    "b6": 8,
    "6": 9,
    "#6": 10,
    "b7": 10,
    "7": 11,
}

HARTE_LABEL_RE = re.compile(r"^([A-Ga-g](?:#|b)?)(?::([^/]+))?(?:/(.+))?$")
LEAD_SHEET_LABEL_RE = re.compile(
    r"^([A-Ga-g](?:#|b)?)(maj7|major7|M7|min7|minor7|m7|min|minor|maj|major|m|"
    r"dim7|dim|aug|sus2|sus4|sus|7|\+)?(?:/([A-Ga-g](?:#|b)?))?$"
)


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
    normalized = raw_label.strip()
    compact = normalized.upper().replace(" ", "")
    if compact in NO_CHORD_LABELS:
        return ParsedChordLabel(
            raw_label=raw_label,
            root_pitch_class=None,
            quality="no_chord",
            bass_pitch_class=None,
            bass_degree=None,
            display_label="N.C.",
            is_no_chord=True,
        )
    if compact in UNKNOWN_CHORD_LABELS:
        return ParsedChordLabel(
            raw_label=raw_label,
            root_pitch_class=None,
            quality=None,
            bass_pitch_class=None,
            bass_degree=None,
            display_label=normalized or raw_label,
            is_unknown=True,
        )

    match = HARTE_LABEL_RE.match(normalized)
    lead_sheet_match = LEAD_SHEET_LABEL_RE.match(normalized)
    if lead_sheet_match and (not match or match.group(2) is None and len(normalized) > len(lead_sheet_match.group(1))):
        root_name, quality_raw, bass_raw = lead_sheet_match.groups()
        return _parsed_chord_label_from_parts(
            raw_label=raw_label,
            normalized=normalized,
            root_name=root_name,
            quality_raw=quality_raw,
            bass_raw=bass_raw,
        )

    if not match:
        return ParsedChordLabel(
            raw_label=raw_label,
            root_pitch_class=None,
            quality=None,
            bass_pitch_class=None,
            bass_degree=None,
            display_label=normalized or raw_label,
            is_unknown=True,
        )

    root_name, quality_raw, bass_raw = match.groups()
    return _parsed_chord_label_from_parts(
        raw_label=raw_label,
        normalized=normalized,
        root_name=root_name,
        quality_raw=quality_raw,
        bass_raw=bass_raw,
    )


def _parsed_chord_label_from_parts(
    *,
    raw_label: str,
    normalized: str,
    root_name: str,
    quality_raw: str | None,
    bass_raw: str | None,
) -> ParsedChordLabel:
    root_pitch_class = NOTE_TO_PITCH_CLASS.get(_normalize_note_name(root_name))
    if root_pitch_class is None:
        return ParsedChordLabel(
            raw_label=raw_label,
            root_pitch_class=None,
            quality=None,
            bass_pitch_class=None,
            bass_degree=None,
            display_label=normalized or raw_label,
            is_unknown=True,
        )

    quality = normalize_chord_quality(quality_raw)
    bass_pitch_class, bass_degree = _parse_bass(bass_raw, root_pitch_class)
    display_label = format_chord_display(root_pitch_class, quality, bass_pitch_class)
    return ParsedChordLabel(
        raw_label=raw_label,
        root_pitch_class=root_pitch_class,
        quality=quality,
        bass_pitch_class=bass_pitch_class,
        bass_degree=bass_degree,
        display_label=display_label,
    )


def normalize_chord_quality(quality: str | None) -> str | None:
    if quality is None:
        return "major"
    normalized = quality.strip().lower().replace(" ", "")
    if normalized in QUALITY_ALIASES:
        return QUALITY_ALIASES[normalized]
    if normalized.startswith("maj7"):
        return "maj7"
    if normalized.startswith(("min7", "m7")):
        return "m7"
    if normalized.startswith("maj"):
        return "major"
    if normalized.startswith(("min", "m")):
        return "minor"
    if normalized.startswith("dim7"):
        return "dim7"
    if normalized.startswith("dim"):
        return "dim"
    if normalized.startswith("aug"):
        return "aug"
    if normalized.startswith("sus2"):
        return "sus2"
    if normalized.startswith("sus4"):
        return "sus4"
    if normalized.startswith("7"):
        return "7"
    return normalized or None


def chord_label_to_segment(
    raw_label: str,
    *,
    start_seconds: float,
    end_seconds: float,
    confidence: float | None = None,
) -> dict[str, Any]:
    parsed = parse_chord_label(raw_label)
    return {
        "start_seconds": round(start_seconds, 3),
        "end_seconds": round(end_seconds, 3),
        "label": parsed.display_label,
        "display_label": parsed.display_label,
        "raw_label": parsed.raw_label,
        "confidence": confidence,
        "pitch_class": parsed.root_pitch_class,
        "root_pitch_class": parsed.root_pitch_class,
        "quality": parsed.quality,
        "bass_pitch_class": parsed.bass_pitch_class,
        "bass_degree": parsed.bass_degree,
    }


def format_chord_display(
    root_pitch_class: int | None,
    quality: str | None,
    bass_pitch_class: int | None = None,
) -> str:
    if root_pitch_class is None:
        return "N.C." if quality == "no_chord" else "X"
    root = PITCH_CLASS_TO_SHARP[root_pitch_class % 12]
    suffix = QUALITY_SUFFIXES.get(quality or "major", quality or "")
    label = f"{root}{suffix}"
    if bass_pitch_class is not None and bass_pitch_class % 12 != root_pitch_class % 12:
        label = f"{label}/{PITCH_CLASS_TO_SHARP[bass_pitch_class % 12]}"
    return label


def _parse_bass(bass_raw: str | None, root_pitch_class: int) -> tuple[int | None, str | None]:
    if bass_raw is None or not bass_raw.strip():
        return None, None
    normalized = bass_raw.strip()
    note_pitch_class = NOTE_TO_PITCH_CLASS.get(_normalize_note_name(normalized))
    if note_pitch_class is not None:
        return note_pitch_class, None

    degree = normalized.lower().replace(" ", "")
    semitone = DEGREE_TO_SEMITONE.get(degree)
    if semitone is None:
        return None, normalized
    return (root_pitch_class + semitone) % 12, degree


def _normalize_note_name(note_name: str) -> str:
    stripped = note_name.strip()
    if not stripped:
        return stripped
    return f"{stripped[0].upper()}{stripped[1:]}".replace("b", "B")
