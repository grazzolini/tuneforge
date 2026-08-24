"""Privacy-preserving chord quality evaluation helpers.

This module deliberately owns a small, backend-independent chord projection.  It
does not reuse product display-label parsing: benchmark references and backend
predictions must be normalized by the same stable scorer contract.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import tempfile
import wave
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import soundfile as sf

SCHEMA_VERSION = "chord-quality-report-v1"
SCORER_VERSION = "chord-quality-scorer-v1"
PROJECTION_VERSION = "chord-projection-v1"
SYNTHETIC_VERSION = "synthetic-chords-v1"
BOUNDARY_TOLERANCE_SECONDS = 0.25
SAFE_STRATA = frozenset({"synthetic", "solo-guitar", "accompaniment", "full-mix"})
_NOTE_TO_PC = {
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
_SEVENTHS = frozenset({"7", "maj7", "m7", "dim7", "hdim7", "9", "maj9", "m9", "11", "13"})
_QUALITY_ALIASES = {
    "": ("major", None),
    "maj": ("major", None),
    "major": ("major", None),
    "min": ("minor", None),
    "m": ("minor", None),
    "minor": ("minor", None),
    "dim": ("diminished", None),
    "aug": ("augmented", None),
    "+": ("augmented", None),
    "sus2": ("sus2", None),
    "sus4": ("sus4", None),
    "5": ("power", None),
    "7": ("major", "7"),
    "maj7": ("major", "maj7"),
    "major7": ("major", "maj7"),
    "min7": ("minor", "m7"),
    "m7": ("minor", "m7"),
    "dim7": ("diminished", "dim7"),
    "hdim": ("diminished", "hdim7"),
    "hdim7": ("diminished", "hdim7"),
    "m7b5": ("diminished", "hdim7"),
    "min7b5": ("diminished", "hdim7"),
    "add9": ("major", "add9"),
    "maj9": ("major", "maj9"),
    "major9": ("major", "maj9"),
    "m9": ("minor", "m9"),
    "min9": ("minor", "m9"),
    "9": ("major", "9"),
    "11": ("major", "11"),
    "13": ("major", "13"),
}


@dataclass(frozen=True)
class ProjectedChord:
    root: int | None
    triad: str | None
    extension: str | None
    bass: int | None
    no_chord: bool = False


@dataclass(frozen=True)
class QualityTrack:
    dataset: str
    slot: str
    strata: tuple[str, ...]
    audio_path: Path
    reference: list[Any]
    timeline: bool
    extension_scoreable: bool
    bass_scoreable: bool
    audio_sha256: str | None = None
    public_provenance: dict[str, Any] | None = None


class ManifestError(ValueError):
    """A deliberately non-identifying manifest validation error."""


def project_chord(value: Mapping[str, Any] | str | None) -> ProjectedChord:
    """Project a source-neutral segment or label into the scorer vocabulary."""
    if value is None:
        return ProjectedChord(None, None, None, None)
    if isinstance(value, Mapping):
        label = value.get("raw_label", value.get("label"))
        quality = value.get("quality")
        root = value.get("root_pitch_class", value.get("pitch_class"))
        bass = value.get("bass_pitch_class")
        if quality == "no_chord" or label in {"N", "N.C.", "NC", "X"}:
            return ProjectedChord(None, None, None, None, quality == "no_chord" or label != "X")
        parsed = _project_label(label) if isinstance(label, str) else None
        root_pc = root if isinstance(root, int) and 0 <= root <= 11 else (parsed.root if parsed else None)
        bass_pc = bass if isinstance(bass, int) and 0 <= bass <= 11 else (parsed.bass if parsed else None)
        if parsed is not None and parsed.triad is not None:
            # Product segments often carry a deliberately coarse ``quality``.
            # The scorer's raw label retains extensions, omitted thirds, and bass.
            return ProjectedChord(root_pc, parsed.triad, parsed.extension, bass_pc if bass_pc is not None else root_pc)
        if isinstance(quality, str):
            triad, extension = _quality_from_text(quality)
            if triad is not None:
                return ProjectedChord(root_pc, triad, extension, bass_pc if bass_pc is not None else root_pc)
        if parsed is not None:
            return parsed
        return ProjectedChord(root_pc, None, None, bass_pc if bass_pc is not None else root_pc)
    if isinstance(value, str):
        return _project_label(value)
    return ProjectedChord(None, None, None, None)


def _project_label(label: str) -> ProjectedChord:
    text = label.strip()
    if text.upper() in {"N", "N.C.", "NC", "NO_CHORD"}:
        return ProjectedChord(None, None, None, None, True)
    match = re.fullmatch(r"([A-Ga-g])([#b]?)(?::)?([^/]*)?(?:/(.+))?", text)
    if match is None:
        return ProjectedChord(None, None, None, None)
    note, accidental, raw_quality, bass_text = match.groups()
    root = _NOTE_TO_PC.get((note + accidental).upper())
    if root is None:
        return ProjectedChord(None, None, None, None)
    triad, extension = _quality_from_text(raw_quality or "")
    bass = _bass_pitch_class(root, bass_text)
    return ProjectedChord(root, triad, extension, root if bass is None else bass)


def _quality_from_text(raw: str) -> tuple[str | None, str | None]:
    text = raw.strip().lower().replace(" ", "")
    if text.startswith("(") and text.endswith(")"):
        values = {part.strip() for part in text[1:-1].split(",")}
        if {"b3", "b5", "b7"}.issubset(values):
            if "9" in values:
                return "diminished", "hdim7"
            return "diminished", "hdim7"
        if {"1", "3", "5", "b7", "9", "13"}.issubset(values):
            return "major", "13"
        if {"1", "3", "5", "7", "9"}.issubset(values):
            return "major", "maj9"
        if {"1", "b3", "5", "b7", "9"}.issubset(values):
            return "minor", "m9"
        if {"1", "5", "b7"}.issubset(values):
            return "power", "7"
        if {"b3", "b5"}.issubset(values):
            return "diminished", None
        if "b3" in values:
            return "minor", None
        if "3" in values:
            return "major", None
        if "5" in values:
            return "power", None
        return None, None
    text = text.replace(":", "")
    direct = _QUALITY_ALIASES.get(text)
    if direct is not None:
        return direct
    # Harte labels can carry an explicit major/minor token before alterations.
    for prefix, projected in (("maj", "major"), ("min", "minor"), ("m", "minor")):
        if text.startswith(prefix):
            tail = text[len(prefix) :]
            extension = {
                "7": "maj7" if projected == "major" else "m7",
                "9": "maj9" if projected == "major" else "m9",
            }.get(tail)
            return projected, extension
    return None, None


def _bass_pitch_class(root: int, value: str | None) -> int | None:
    if not value:
        return None
    text = value.strip()
    note = _NOTE_TO_PC.get(text.upper())
    if note is not None:
        return note
    degree = {
        "1": 0,
        "b2": 1,
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
        "bb7": 9,
        "b7": 10,
        "7": 11,
        "b9": 13,
        "9": 14,
        "#9": 15,
        "b10": 15,
        "10": 16,
        "#10": 17,
        "11": 17,
        "#11": 18,
        "b13": 20,
        "13": 21,
    }.get(text.lower())
    return (root + degree) % 12 if degree is not None else None


def score_timeline(
    reference: Sequence[Mapping[str, Any]],
    prediction: Sequence[Mapping[str, Any]],
    *,
    extension_scoreable: bool = True,
    bass_scoreable: bool = True,
) -> dict[str, Any]:
    """Score a valid timeline. References fail closed; predictions are clamped."""
    ref = _validate_reference(reference)
    duration = float(ref[-1]["end_seconds"])
    pred = _clamp_prediction(prediction, duration)
    points = sorted({0.0, duration, *(_times(ref)), *(_times(pred))})
    correct: defaultdict[str, float] = defaultdict(float)
    wrong_spans = 0
    was_wrong = False
    for left, right in zip(points[:-1], points[1:], strict=True):
        if right <= left:
            continue
        actual, observed = _segment_at(ref, (left + right) / 2), _segment_at(pred, (left + right) / 2)
        a, b = project_chord(actual), project_chord(observed)
        weight = right - left
        explicit_nc_match = a.no_chord and b.no_chord
        equal_root = explicit_nc_match if a.no_chord or b.no_chord else a.root == b.root
        equal_quality = explicit_nc_match if a.no_chord or b.no_chord else a.triad == b.triad
        equal_extension = explicit_nc_match if a.no_chord or b.no_chord else a.extension == b.extension
        equal_bass = explicit_nc_match if a.no_chord or b.no_chord else a.bass == b.bass
        equal_full = equal_root and equal_quality and equal_extension and equal_bass and a.no_chord == b.no_chord
        correct["root"] += weight * equal_root
        correct["quality"] += weight * equal_quality
        correct["seventh_extension"] += weight * equal_extension
        correct["bass"] += weight * equal_bass
        correct["full"] += weight * equal_full
        correct["nc_correct"] += weight * (a.no_chord and b.no_chord)
        correct["nc_reference"] += weight * a.no_chord
        correct["nc_prediction"] += weight * b.no_chord
        wrong = not equal_full
        wrong_spans += int(wrong and not was_wrong)
        was_wrong = wrong
    matched, missed, extra = match_boundaries(_boundaries(ref), _boundaries(pred))
    return {
        "kind": "timeline",
        "duration_seconds": duration,
        "root": _bounded(correct["root"] / duration),
        "quality": _bounded(correct["quality"] / duration),
        "seventh_extension": _bounded(correct["seventh_extension"] / duration) if extension_scoreable else None,
        "seventh_extension_reason": None if extension_scoreable else "source_capability_unsupported",
        "bass": _bounded(correct["bass"] / duration) if bass_scoreable else None,
        "bass_reason": None if bass_scoreable else "source_capability_unsupported",
        "full": _bounded(correct["full"] / duration) if bass_scoreable and extension_scoreable else None,
        "full_reason": None if bass_scoreable and extension_scoreable else "source_capability_unsupported",
        "boundary": {"matched": matched, "reference": len(_boundaries(ref)), "prediction": len(_boundaries(pred))},
        "reference_segment_count": len(ref),
        "prediction_segment_count": len(pred),
        "wrong_spans": wrong_spans,
        "unmatched_boundaries": missed + extra,
        "nc": {
            "correct_seconds": correct["nc_correct"],
            "reference_seconds": correct["nc_reference"],
            "prediction_seconds": correct["nc_prediction"],
        },
    }


def score_sequence(
    reference: Sequence[Mapping[str, Any] | str], prediction: Sequence[Mapping[str, Any] | str]
) -> dict[str, Any]:
    left = _collapse([project_chord(item) for item in reference])
    right = _collapse([project_chord(item) for item in prediction])
    distance = _edit_distance(left, right)
    denominator = max(len(left), len(right))
    return {
        "kind": "sequence",
        "sequence_edit_similarity": _bounded(1.0 - distance / denominator) if denominator else 1.0,
        "root": None,
        "quality": None,
        "seventh_extension": None,
        "bass": None,
        "full": None,
        "timeline_reason": "untimed_reference",
        "reference_segment_count": len(left),
        "prediction_segment_count": len(right),
    }


def match_boundaries(
    reference: Sequence[float], prediction: Sequence[float], tolerance: float = BOUNDARY_TOLERANCE_SECONDS
) -> tuple[int, int, int]:
    # Ordered interval matching maximizes cardinality without crossing pairs.
    left = right = matched = 0
    while left < len(reference) and right < len(prediction):
        if prediction[right] < reference[left] - tolerance:
            right += 1
        elif prediction[right] > reference[left] + tolerance:
            left += 1
        else:
            matched += 1
            left += 1
            right += 1
    return matched, len(reference) - matched, len(prediction) - matched


def aggregate_scores(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    timelines = [row for row in rows if row.get("kind") == "timeline"]
    sequences = [row for row in rows if row.get("kind") == "sequence"]
    duration = sum(float(row["duration_seconds"]) for row in timelines)
    output: dict[str, Any] = {
        "track_count": len(timelines) + len(sequences),
        "timeline_track_count": len(timelines),
        "sequence_track_count": len(sequences),
        "duration_seconds": round(duration, 6),
    }
    for metric in ("root", "quality", "seventh_extension", "bass", "full"):
        supported = [row for row in timelines if row.get(metric) is not None]
        supported_duration = sum(float(row["duration_seconds"]) for row in supported)
        output[metric] = (
            _bounded(sum(float(row[metric]) * float(row["duration_seconds"]) for row in supported) / supported_duration)
            if supported_duration
            else None
        )
        output[f"{metric}_support_track_count"] = len(supported)
        output[f"{metric}_support_duration_seconds"] = round(supported_duration, 6)
        output[f"{metric}_reason"] = (
            None
            if len(supported) == len(timelines)
            else "partial_metric_support"
            if supported
            else "metric_unsupported_by_source"
        )
    boundary_matched = sum(int(row["boundary"]["matched"]) for row in timelines)
    boundary_reference = sum(int(row["boundary"]["reference"]) for row in timelines)
    boundary_prediction = sum(int(row["boundary"]["prediction"]) for row in timelines)
    precision = (
        boundary_matched / boundary_prediction if boundary_prediction else (1.0 if not boundary_reference else 0.0)
    )
    recall = boundary_matched / boundary_reference if boundary_reference else (1.0 if not boundary_prediction else 0.0)
    output["boundary_precision_250ms"] = _bounded(precision)
    output["boundary_recall_250ms"] = _bounded(recall)
    output["boundary_f1_250ms"] = _bounded(2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    nc_correct = sum(float(row["nc"]["correct_seconds"]) for row in timelines)
    nc_reference = sum(float(row["nc"]["reference_seconds"]) for row in timelines)
    nc_prediction = sum(float(row["nc"]["prediction_seconds"]) for row in timelines)
    output["nc_recall"] = _bounded(nc_correct / nc_reference) if nc_reference else 1.0
    output["nc_precision"] = (
        _bounded(nc_correct / nc_prediction) if nc_prediction else (1.0 if not nc_reference else 0.0)
    )
    output["reference_segment_count"] = sum(int(row["reference_segment_count"]) for row in timelines)
    output["prediction_segment_count"] = sum(int(row["prediction_segment_count"]) for row in timelines)
    output["segment_count_absolute_error"] = sum(
        abs(int(row["prediction_segment_count"]) - int(row["reference_segment_count"])) for row in timelines
    )
    output["segment_count_normalized_error"] = (
        _bounded(output["segment_count_absolute_error"] / output["reference_segment_count"])
        if output["reference_segment_count"]
        else None
    )
    output["correction_proxy_per_minute"] = (
        round((sum(int(row["wrong_spans"]) + int(row["unmatched_boundaries"]) for row in timelines) * 60 / duration), 6)
        if duration
        else None
    )
    output["sequence_edit_similarity"] = (
        _bounded(sum(float(row["sequence_edit_similarity"]) for row in sequences) / len(sequences))
        if sequences
        else None
    )
    return output


def load_manifest(path: Path, data_root: Path) -> list[QualityTrack]:
    """Load an external normalized manifest without exposing its identifiers."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError("manifest_invalid") from exc
    if not isinstance(payload, Mapping) or payload.get("schema_version") != "chord-quality-manifest-v1":
        raise ManifestError("manifest_schema_invalid")
    dataset = payload.get("dataset")
    entries = payload.get("tracks")
    if not isinstance(dataset, str) or not isinstance(entries, list) or not entries:
        raise ManifestError("manifest_contract_invalid")
    tracks: list[QualityTrack] = []
    for index, entry in enumerate(entries, 1):
        if not isinstance(entry, Mapping):
            raise ManifestError("manifest_contract_invalid")
        relative = entry.get("audio")
        digest = entry.get("sha256")
        strata = entry.get("strata")
        timeline = entry.get("timeline")
        sequence = entry.get("sequence")
        if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ManifestError("manifest_audio_invalid")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise ManifestError("manifest_hash_invalid")
        if (
            not isinstance(strata, list)
            or not strata
            or any(not isinstance(item, str) or item not in SAFE_STRATA for item in strata)
        ):
            raise ManifestError("manifest_strata_invalid")
        if (timeline is None) == (sequence is None) or not isinstance(
            timeline if timeline is not None else sequence, list
        ):
            raise ManifestError("manifest_reference_invalid")
        audio_path = (data_root / relative).resolve()
        if data_root.resolve() not in audio_path.parents or not audio_path.is_file() or _sha256(audio_path) != digest:
            raise ManifestError("manifest_audio_hash_invalid")
        raw_reference = timeline if timeline is not None else sequence
        assert isinstance(raw_reference, list)
        reference = list(raw_reference)
        if timeline is not None:
            _validate_reference(reference)
        tracks.append(
            QualityTrack(
                dataset,
                f"dataset_{index:03d}",
                tuple(sorted(strata)),
                audio_path,
                reference,
                timeline is not None,
                bool(entry.get("extension_scoreable", True)),
                bool(entry.get("bass_scoreable", False)),
                digest,
            )
        )
    return tracks


def load_public_manifest(path: Path, data_root: Path) -> list[QualityTrack]:
    """Load a vendored public manifest via its stdlib-only dataset adapter."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError("manifest_invalid") from exc
    if not isinstance(payload, Mapping) or payload.get("schema_version") != "chord-public-manifest-v1":
        raise ManifestError("public_manifest_schema_invalid")
    _validate_public_manifest(payload)
    root = _public_data_root(payload, data_root)
    adapter = payload.get("adapter")
    if adapter == "guitarset-jams-v1":
        return _load_guitarset(payload, root)
    if adapter == "tiny-aam-arff-v1":
        return _load_tiny_aam(payload, root)
    raise ManifestError("public_manifest_adapter_invalid")


def _load_guitarset(payload: Mapping[str, Any], root: Path) -> list[QualityTrack]:
    pins = _public_selection_pins(payload, "selected_annotations", ("basename", "sha256", "audio_sha256"))
    annotations = root / "annotations"
    audio = root / "audio"
    paths = sorted(
        (path for path in annotations.glob("*.jams") if (audio / f"{path.stem}_mic.wav").is_file()),
        key=lambda item: hashlib.sha256(item.name.encode()).digest(),
    )[:6]
    if len(paths) != 6:
        raise ManifestError("public_dataset_selection_invalid")
    if [path.stem for path in paths] != [str(pin["basename"]) for pin in pins] or any(
        _sha256(path) != str(pin["sha256"]) or _sha256(audio / f"{path.stem}_mic.wav") != str(pin["audio_sha256"])
        for path, pin in zip(paths, pins, strict=True)
    ):
        raise ManifestError("public_dataset_pin_invalid")
    tracks: list[QualityTrack] = []
    provenance = _public_provenance(payload)
    for index, annotation in enumerate(paths, 1):
        try:
            data = json.loads(annotation.read_text(encoding="utf-8"))
            chord_annotations = [
                item
                for item in data.get("annotations", [])
                if item.get("namespace") == "chord"
                and "manual verification" in str(item.get("annotation_metadata", {}).get("data_source", "")).lower()
            ]
            if len(chord_annotations) != 1:
                raise ValueError
            timeline = [
                {
                    "start_seconds": float(row["time"]),
                    "end_seconds": float(row["time"]) + float(row["duration"]),
                    "label": str(row["value"]),
                }
                for row in chord_annotations[0]["data"]
            ]
            _validate_reference(timeline)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ManifestError("public_dataset_annotation_invalid") from exc
        tracks.append(
            QualityTrack(
                "guitarset",
                f"track_{index:03d}",
                ("solo-guitar",) if annotation.stem.endswith("_solo") else ("accompaniment",),
                audio / f"{annotation.stem}_mic.wav",
                timeline,
                True,
                True,
                True,
                None,
                provenance,
            )
        )
    return tracks


def _load_tiny_aam(payload: Mapping[str, Any], root: Path) -> list[QualityTrack]:
    pins = _public_selection_pins(
        payload, "selected_assets", ("id", "audio_sha256", "beatinfo_sha256", "segments_sha256")
    )
    audio_paths = sorted(
        [
            path
            for path in (root / "audio-mixes-mp3").glob("*_mix.mp3")
            if (root / "annotations" / f"{path.stem.removesuffix('_mix')}_beatinfo.arff").is_file()
            and (root / "annotations" / f"{path.stem.removesuffix('_mix')}_segments.arff").is_file()
        ],
        key=lambda item: hashlib.sha256(item.name.encode()).digest(),
    )[:6]
    if len(audio_paths) != 6:
        raise ManifestError("public_dataset_selection_invalid")
    if [path.stem.removesuffix("_mix") for path in audio_paths] != [str(pin["id"]) for pin in pins]:
        raise ManifestError("public_dataset_pin_invalid")
    tracks: list[QualityTrack] = []
    provenance = _public_provenance(payload)
    for index, (audio, pin) in enumerate(zip(audio_paths, pins, strict=True), 1):
        identifier = audio.stem.removesuffix("_mix")
        beat_path = root / "annotations" / f"{identifier}_beatinfo.arff"
        segment_path = root / "annotations" / f"{identifier}_segments.arff"
        if (
            _sha256(audio) != str(pin["audio_sha256"])
            or _sha256(beat_path) != str(pin["beatinfo_sha256"])
            or _sha256(segment_path) != str(pin["segments_sha256"])
        ):
            raise ManifestError("public_dataset_pin_invalid")
        rows = _arff_rows(beat_path)
        if not rows or any(len(row) != 4 for row in rows):
            raise ManifestError("public_dataset_annotation_invalid")
        try:
            duration = float(sf.info(str(audio)).duration)
            starts = [float(row[0]) for row in rows]
        except (RuntimeError, ValueError, IndexError) as exc:
            raise ManifestError("public_dataset_annotation_invalid") from exc
        timeline = [
            {
                "start_seconds": start,
                "end_seconds": starts[position + 1] if position + 1 < len(starts) else duration,
                "label": row[3],
            }
            for position, (start, row) in enumerate(zip(starts, rows, strict=True))
        ]
        _validate_reference(timeline)
        tracks.append(
            QualityTrack(
                "tiny-aam", f"track_{index:03d}", ("full-mix",), audio, timeline, True, True, False, None, provenance
            )
        )
    return tracks


def synthetic_tracks() -> list[QualityTrack]:
    """Create a deterministic, copyright-free acoustic fixture suite."""
    root = Path(tempfile.mkdtemp(prefix="tuneforge-chord-quality-"))
    specs = [("C", "G", "Am", "F"), ("C13", "Cmaj9", "Cm9", "C5"), ("N.C.", "C/E", "G:hdim7/5", "Cadd9/E")]
    tracks: list[QualityTrack] = []
    for index, labels in enumerate(specs, 1):
        path = root / f"fixture-{index}.wav"
        _write_synthetic_wav(path, labels)
        timeline = [
            {"start_seconds": float(step), "end_seconds": float(step + 1), "label": label}
            for step, label in enumerate(labels)
        ]
        tracks.append(QualityTrack("synthetic", f"track_{index:03d}", ("synthetic",), path, timeline, True, True, True))
    return tracks


def cleanup_synthetic_tracks(tracks: Sequence[QualityTrack]) -> None:
    for track in tracks:
        try:
            track.audio_path.unlink(missing_ok=True)
            track.audio_path.parent.rmdir()
        except OSError:
            pass


def _write_synthetic_wav(path: Path, labels: Sequence[str]) -> None:
    sample_rate, amplitude = 8_000, 6_000
    samples: list[int] = []
    for label in labels:
        chord = project_chord(label)
        tones = _synthetic_tones(chord)
        for frame in range(sample_rate):
            if not tones:
                samples.append(0)
                continue
            fade = min(1.0, frame / (sample_rate * 0.03), (sample_rate - frame - 1) / (sample_rate * 0.06))
            value = int(
                amplitude
                * fade
                * sum(math.sin(2 * math.pi * frequency * frame / sample_rate) for frequency in tones)
                / len(tones)
            )
            samples.append(value)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"".join(int(sample).to_bytes(2, "little", signed=True) for sample in samples))


def _synthetic_tones(chord: ProjectedChord) -> list[float]:
    if chord.no_chord or chord.root is None:
        return []
    triads = {
        "major": (0, 4, 7),
        "minor": (0, 3, 7),
        "diminished": (0, 3, 6),
        "augmented": (0, 4, 8),
        "sus2": (0, 2, 7),
        "sus4": (0, 5, 7),
        "power": (0, 7),
    }
    extensions = {
        "7": (10,),
        "maj7": (11,),
        "m7": (10,),
        "hdim7": (10,),
        "dim7": (9,),
        "add9": (14,),
        "9": (10, 14),
        "maj9": (11, 14),
        "m9": (10, 14),
        "11": (10, 14, 17),
        "13": (10, 14, 17, 21),
    }
    intervals = (*triads.get(chord.triad or "", (0,)), *extensions.get(chord.extension or "", ()))
    bass = chord.bass if chord.bass is not None else chord.root
    midi = [36 + bass, *(48 + chord.root + interval for interval in intervals)]
    return [440.0 * 2 ** ((note - 69) / 12) for note in midi]


def _validate_reference(segments: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        raise ManifestError("reference_empty")
    normalized: list[dict[str, Any]] = []
    expected = 0.0
    for segment in segments:
        try:
            start, end = float(segment["start_seconds"]), float(segment["end_seconds"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ManifestError("reference_timing_invalid") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start != expected or end <= start:
            raise ManifestError("reference_timeline_invalid")
        projected = project_chord(segment)
        if projected.root is None and not projected.no_chord:
            raise ManifestError("reference_label_invalid")
        normalized.append(dict(segment, start_seconds=start, end_seconds=end))
        expected = end
    return normalized


def _clamp_prediction(segments: Sequence[Mapping[str, Any]], duration: float) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for segment in segments:
        try:
            start, end = float(segment["start_seconds"]), float(segment["end_seconds"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end):
            raise ManifestError("prediction_timing_invalid")
        start, end = max(0.0, min(duration, start)), max(0.0, min(duration, end))
        if end > start:
            result.append(dict(segment, start_seconds=start, end_seconds=end))
    return sorted(result, key=lambda item: (float(item["start_seconds"]), float(item["end_seconds"])))


def _times(segments: Sequence[Mapping[str, Any]]) -> list[float]:
    return [float(segment[key]) for segment in segments for key in ("start_seconds", "end_seconds")]


def _segment_at(segments: Sequence[Mapping[str, Any]], point: float) -> Mapping[str, Any] | None:
    return next(
        (segment for segment in segments if float(segment["start_seconds"]) <= point < float(segment["end_seconds"])),
        None,
    )


def _boundaries(segments: Sequence[Mapping[str, Any]]) -> list[float]:
    return [float(segment["end_seconds"]) for segment in segments[:-1]]


def _collapse(values: Sequence[ProjectedChord]) -> list[ProjectedChord]:
    return [value for index, value in enumerate(values) if index == 0 or value != values[index - 1]]


def _edit_distance(left: Sequence[ProjectedChord], right: Sequence[ProjectedChord]) -> int:
    row = list(range(len(right) + 1))
    for index, item in enumerate(left, 1):
        next_row = [index]
        for column, other in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[column] + 1, row[column - 1] + (item != other)))
        row = next_row
    return row[-1]


def _bounded(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 6)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _arff_rows(path: Path) -> list[list[str]]:
    try:
        return [
            next(csv.reader([line], quotechar="'", skipinitialspace=True))
            for raw in path.read_text(encoding="utf-8").splitlines()
            if (line := raw.strip()) and not line.startswith("@")
        ]
    except (OSError, csv.Error) as exc:
        raise ManifestError("public_dataset_annotation_invalid") from exc


def _public_selection_pins(payload: Mapping[str, Any], name: str, keys: tuple[str, ...]) -> list[Mapping[str, Any]]:
    selection = payload.get("selection")
    pins = selection.get(name) if isinstance(selection, Mapping) else None
    if (
        not isinstance(pins, list)
        or len(pins) != 6
        or any(
            not isinstance(pin, Mapping)
            or any(
                not isinstance(pin.get(key), str)
                or (key.endswith("sha256") and re.fullmatch(r"[0-9a-f]{64}", str(pin[key])) is None)
                for key in keys
            )
            for pin in pins
        )
    ):
        raise ManifestError("public_manifest_pin_invalid")
    return pins


def _validate_public_manifest(payload: Mapping[str, Any]) -> None:
    if payload.get("dataset_version") != "1.1.0" or payload.get("license") != "CC BY 4.0":
        raise ManifestError("public_manifest_metadata_invalid")
    source = payload.get("official_source")
    pins = payload.get("archive_pins")
    selection = payload.get("selection")
    if not isinstance(source, str) or not source.startswith("https://doi.org/10.5281/zenodo."):
        raise ManifestError("public_manifest_source_invalid")
    if not isinstance(pins, list) or not pins or not isinstance(selection, Mapping) or selection.get("count") != 6:
        raise ManifestError("public_manifest_pin_invalid")
    for pin in pins:
        if (
            not isinstance(pin, Mapping)
            or pin.get("checksum_algorithm") != "md5"
            or not isinstance(pin.get("checksum"), str)
            or re.fullmatch(r"[0-9a-f]{32}", str(pin["checksum"])) is None
            or not isinstance(pin.get("bytes"), int)
            or int(pin["bytes"]) <= 0
        ):
            raise ManifestError("public_manifest_pin_invalid")


def _public_data_root(payload: Mapping[str, Any], data_root: Path) -> Path:
    subdir = payload.get("data_subdir")
    if not isinstance(subdir, str) or not subdir or Path(subdir).is_absolute() or ".." in Path(subdir).parts:
        raise ManifestError("public_manifest_data_root_invalid")
    root = data_root.resolve()
    candidate = (root / subdir).resolve()
    if root not in candidate.parents:
        raise ManifestError("public_manifest_data_root_invalid")
    return candidate


def _public_provenance(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "dataset": payload["dataset"],
        "version": payload["dataset_version"],
        "license": payload["license"],
        "source": payload["official_source"],
        "archive_checksums": [
            {"algorithm": pin["checksum_algorithm"], "checksum": pin["checksum"]} for pin in payload["archive_pins"]
        ],
        "selection_rule": payload["selection"]["rule"],
    }
