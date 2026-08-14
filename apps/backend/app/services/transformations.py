from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.chord_labels import parse_chord_label
from app.engines.transform import (
    cents_from_reference,
    probe_export_formats,
    run_ffmpeg_transform,
    semitones_to_cents,
)
from app.errors import AppError, JobCancelledError
from app.models import Artifact, ChordTimeline, LyricsTranscript, Project
from app.services.analysis import analyze_project
from app.services.artifacts import find_cached_artifact, register_artifact
from app.services.paths import project_exports_dir, project_previews_dir
from app.services.stem_models import STEM_ARTIFACT_TYPE_SOURCES, STEM_ARTIFACT_TYPES
from app.utils.hashing import stable_hash


@dataclass
class TransformPlan:
    artifact_type: str
    destination_path: Path
    output_format: str
    total_cents: float
    cache_key: str | None
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ExportBatchResult:
    artifact_ids: list[str]
    export_result: dict[str, Any]


_NOTE_TO_PITCH_CLASS = {
    "C": 0, "B#": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3,
    "E": 4, "FB": 4, "F": 5, "E#": 5, "F#": 6, "GB": 6, "G": 7,
    "G#": 8, "AB": 8, "A": 9, "A#": 10, "BB": 10, "B": 11, "CB": 11,
}
_SHARP_PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLAT_PITCH_CLASSES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
_NEUTRAL_PITCH_CLASSES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
_AUTO_KEY_FAMILIES = {
    "major": ("neutral", "flat", "sharp", "flat", "sharp", "flat", "sharp", "sharp", "flat", "sharp", "flat", "sharp"),
    "minor": ("flat", "sharp", "flat", "flat", "sharp", "flat", "sharp", "flat", "sharp", "neutral", "flat", "sharp"),
}
_CHORD_QUALITY_SUFFIXES = {
    "major": "", "minor": "m", "7": "7", "7b5": "7b5", "maj7": "maj7",
    "m7": "m7", "sus2": "sus2", "sus4": "sus4", "dim": "dim", "aug": "aug",
    "dim7": "dim7", "hdim7": "m7b5",
}


def _reference_cents(session: Session, project: Project, target_reference_hz: float) -> float:
    analysis = project.analysis or analyze_project(session, project)
    if analysis.estimated_reference_hz is None:
        raise AppError("PROCESSING_FAILED", "Could not determine the source tuning reference.")
    return cents_from_reference(analysis.estimated_reference_hz, target_reference_hz)


def _preview_cache_key(project_id: str, payload: dict[str, Any]) -> str:
    return stable_hash({"project_id": project_id, **payload})


def _ensure_not_cancelled(should_cancel: Callable[[], bool] | None) -> None:
    if should_cancel and should_cancel():
        raise JobCancelledError()


def _resolve_legacy_export_file_path(
    artifact: Artifact,
    *,
    output_format: str,
    destination_path: str | None,
    destination_file_path: str | None,
) -> Path:
    if destination_file_path:
        return Path(destination_file_path).expanduser().resolve()
    source_path = Path(artifact.path)
    root = (
        Path(destination_path).expanduser().resolve()
        if destination_path
        else project_exports_dir(artifact.project_id)
    )
    return root / f"{source_path.stem}.{output_format}"


def _new_sibling_temp_paths(target: Path, output_format: str) -> tuple[Path, Path]:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent,
        prefix="tuneforge-export-",
        delete=False,
    ) as temp_file:
        temp_base_path = Path(temp_file.name)
    temp_base_path.unlink(missing_ok=True)
    return temp_base_path, temp_base_path.with_suffix(f".{output_format}")


def ensure_export_destination_available(*, destination_file_path: str | None, overwrite_existing: bool) -> None:
    if not destination_file_path or overwrite_existing:
        return
    target = Path(destination_file_path).expanduser().resolve()
    if target.exists():
        raise AppError(
            "EXPORT_DESTINATION_EXISTS",
            "Export destination already exists.",
            status_code=status.HTTP_409_CONFLICT,
            details={"destination_file_path": str(target)},
        )


def export_capabilities() -> dict[str, Any]:
    formats = probe_export_formats()
    return {
        "platform": "desktop",
        "formats": [
            {"id": output_format, "available": available, "reason": reason}
            for output_format, (available, reason) in formats.items()
        ],
        "destinations": [
            {"id": destination, "available": True, "reason": None}
            for destination in ("single_file", "folder", "zip")
        ],
        "max_artifact_count": None,
    }


def _safe_filename_base(value: str) -> str:
    sanitized = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", value).strip(" .")
    sanitized = re.sub(r"\s+", " ", sanitized)
    return sanitized[:120] or "TuneForge Export"


def _primary_audio_artifact(artifact: Artifact, artifacts_by_id: dict[str, Artifact]) -> Artifact | None:
    if artifact.type in {"source_audio", "preview_mix"}:
        return artifact
    if artifact.type not in STEM_ARTIFACT_TYPES:
        return None
    source_artifact_id = artifact.metadata_json.get("source_artifact_id")
    return artifacts_by_id.get(source_artifact_id) if isinstance(source_artifact_id, str) else None


def _practice_mix_label(session: Session, project_id: str, artifact_id: str) -> str:
    mixes = list(
        session.scalars(
            select(Artifact)
            .where(Artifact.project_id == project_id, Artifact.type == "preview_mix")
            .order_by(Artifact.created_at.asc(), Artifact.id.asc())
        )
    )
    return f"Practice Mix {next((index for index, mix in enumerate(mixes, 1) if mix.id == artifact_id), 1)}"


def _audio_set_label(session: Session, artifact: Artifact) -> str:
    return (
        "Source"
        if artifact.type == "source_audio"
        else _practice_mix_label(session, artifact.project_id, artifact.id)
    )


def _artifact_export_label(artifact: Artifact) -> str | None:
    source = STEM_ARTIFACT_TYPE_SOURCES.get(artifact.type)
    return source.replace("_", " ").title() if source else None


def _deduplicate_output_names(names: list[str]) -> list[str]:
    counts: dict[str, int] = {}
    deduplicated: list[str] = []
    for name in names:
        path = Path(name)
        key = name.casefold()
        counts[key] = counts.get(key, 0) + 1
        suffix = "" if counts[key] == 1 else f" ({counts[key]})"
        deduplicated.append(f"{path.stem}{suffix}{path.suffix}")
    return deduplicated


def _has_saved_lyrics(lyrics: LyricsTranscript | None) -> bool:
    return lyrics is not None and any(
        isinstance(segment, dict) and isinstance(segment.get("text"), str) and segment["text"].strip()
        for segment in lyrics.segments_json
    )


def _parse_key(value: str | None) -> tuple[int, str] | None:
    if not value:
        return None
    normalized = value.strip()
    serialized_match = re.fullmatch(r"(\d+):(major|minor)", normalized, re.IGNORECASE)
    if serialized_match:
        pitch_class = int(serialized_match.group(1))
        return (pitch_class, serialized_match.group(2).lower()) if 0 <= pitch_class <= 11 else None
    named_match = re.fullmatch(r"([A-Ga-g](?:#|b)?)\s*(major|minor|m)?", normalized)
    if not named_match:
        return None
    named_pitch_class = _NOTE_TO_PITCH_CLASS.get(named_match.group(1).upper())
    if named_pitch_class is None:
        return None
    return named_pitch_class, "minor" if (named_match.group(2) or "").lower() in {"minor", "m"} else "major"


def _semitone_delta(source_pitch_class: int, target_pitch_class: int) -> int:
    upward_distance = (target_pitch_class - source_pitch_class) % 12
    return upward_distance if upward_distance <= 6 else upward_distance - 12


def _mix_transpose_semitones(artifact: Artifact) -> int:
    if artifact.type != "preview_mix":
        return 0
    transpose = artifact.metadata_json.get("transpose")
    value = transpose.get("semitones") if isinstance(transpose, dict) else None
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def _resolved_document_chord_context(
    project: Project,
    *,
    audio_set: Artifact,
    display_mode: str,
) -> dict[str, Any]:
    detected_key = _parse_key(project.analysis.estimated_key if project.analysis is not None else None)
    override_key = _parse_key(project.source_key_override)
    source_key_correction = (
        _semitone_delta(detected_key[0], override_key[0])
        if detected_key is not None and override_key is not None
        else 0
    )
    mix_transpose = _mix_transpose_semitones(audio_set)
    spelling_key = override_key or detected_key
    active_key = (
        {"pitch_class": (spelling_key[0] + mix_transpose) % 12, "mode": spelling_key[1]}
        if spelling_key is not None
        else None
    )
    return {
        "transpose_semitones": source_key_correction + mix_transpose,
        "active_key": active_key,
        "display_mode": display_mode,
    }


def prepare_export_job_payload(
    session: Session,
    *,
    project: Project,
    request_payload: dict[str, Any],
) -> dict[str, Any]:
    artifact_ids = list(request_payload.get("artifact_ids", []))
    generated_document_ids = list(request_payload.get("generated_document_ids", []))
    artifacts = [session.get(Artifact, artifact_id) for artifact_id in artifact_ids]
    if any(artifact is None or artifact.project_id != project.id for artifact in artifacts):
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact does not belong to this project.", status_code=404)
    selected = [artifact for artifact in artifacts if artifact is not None]
    all_project_artifacts = {
        artifact.id: artifact
        for artifact in session.scalars(select(Artifact).where(Artifact.project_id == project.id))
    }
    primary_artifacts = [_primary_audio_artifact(artifact, all_project_artifacts) for artifact in selected]
    if any(primary is None for primary in primary_artifacts):
        raise AppError("INVALID_REQUEST", "Only source tracks, practice mixes, and their stems can be exported.")
    primary_ids = {primary.id for primary in primary_artifacts if primary is not None}
    if len(primary_ids) > 1:
        raise AppError("EXPORT_AUDIO_SET_MISMATCH", "Selected artifacts must belong to one audio set.")
    output_format = str(request_payload.get("output_format", "wav"))
    if artifact_ids:
        format_available, reason = probe_export_formats().get(output_format, (False, "Unsupported export format."))
        if not format_available:
            raise AppError("EXPORT_FORMAT_UNAVAILABLE", reason or "Export format is unavailable.", status_code=422)

    lyrics = session.get(LyricsTranscript, project.id)
    if generated_document_ids and not _has_saved_lyrics(lyrics):
        raise AppError(
            "EXPORT_LYRICS_UNAVAILABLE",
            "Saved lyrics are required to export project documents.",
            status_code=422,
        )
    chords = session.get(ChordTimeline, project.id)
    if "lyrics_with_chords" in generated_document_ids and (chords is None or not chords.segments_json):
        raise AppError(
            "EXPORT_CHORDS_UNAVAILABLE",
            "Saved chords are required to export lyrics with chords.",
            status_code=422,
        )

    document_audio_set: Artifact | None = None
    document_audio_set_id = request_payload.get("document_audio_set_artifact_id")
    if generated_document_ids and isinstance(document_audio_set_id, str):
        candidate = session.get(Artifact, document_audio_set_id)
        if candidate is None or candidate.project_id != project.id:
            raise AppError("ARTIFACT_NOT_FOUND", "Document audio set does not belong to this project.", status_code=404)
        if candidate.type not in {"source_audio", "preview_mix"}:
            raise AppError("INVALID_REQUEST", "Document audio set must be a source track or practice mix.")
        document_audio_set = candidate

    primary = next((primary for primary in primary_artifacts if primary is not None), None)
    if primary is not None and document_audio_set is not None and primary.id != document_audio_set.id:
        raise AppError(
            "EXPORT_AUDIO_SET_MISMATCH",
            "Selected audio and project documents must belong to one audio set.",
        )
    document_chord_context = None
    if "lyrics_with_chords" in generated_document_ids and document_audio_set is not None:
        document_chord_context = _resolved_document_chord_context(
            project,
            audio_set=document_audio_set,
            display_mode=str(request_payload["document_chord_display_mode"]),
        )
    destination = request_payload.get("destination")
    if isinstance(destination, dict):
        filename_base = _safe_filename_base(str(request_payload.get("filename_base") or project.display_name))
        context_label = _audio_set_label(session, primary) if primary is not None else None
        raw_names = [
            f"{filename_base} - {context_label}"
            f"{' - ' + label if (label := _artifact_export_label(artifact)) else ''}.{output_format}"
            for artifact in selected
        ]
        raw_names.extend(
            f"{filename_base} - {'Lyrics' if document_id == 'lyrics' else 'Lyrics and Chords'}.txt"
            for document_id in generated_document_ids
        )
        output_names = _deduplicate_output_names(raw_names)
        normalized_destination = {
            "type": str(destination.get("type")),
            "target": str(destination.get("target")),
            "overwrite": bool(destination.get("overwrite", False)),
        }
    else:
        artifact = selected[0]
        target = _resolve_legacy_export_file_path(
            artifact,
            output_format=output_format,
            destination_path=request_payload.get("destination_path"),
            destination_file_path=request_payload.get("destination_file_path"),
        )
        output_names = [target.name]
        normalized_destination = {
            "type": "single_file",
            "target": str(target),
            "overwrite": bool(request_payload.get("overwrite_existing", False)),
        }

    _preflight_export_destination(normalized_destination, output_names)
    return {
        "artifact_ids": artifact_ids,
        "generated_document_ids": generated_document_ids,
        "mixdown_mode": "copy",
        "output_format": output_format,
        "filename_base": _safe_filename_base(str(request_payload.get("filename_base") or project.display_name)),
        "destination": normalized_destination,
        "output_names": output_names,
        "audio_set_artifact_id": primary.id if primary is not None else None,
        **({"document_chord_context": document_chord_context} if document_chord_context is not None else {}),
    }


def _preflight_export_destination(destination: dict[str, Any], output_names: list[str]) -> None:
    target = Path(str(destination["target"])).expanduser().resolve()
    overwrite = bool(destination.get("overwrite", False))
    destination_type = destination["type"]
    if destination_type == "folder":
        if target.exists() and not target.is_dir():
            raise AppError("INVALID_REQUEST", "Export folder destination is not a directory.")
        collisions = [str(target / name) for name in output_names if (target / name).exists()]
        if collisions and not overwrite:
            raise AppError(
                "EXPORT_DESTINATION_EXISTS",
                "One or more export destinations already exist.",
                status_code=status.HTTP_409_CONFLICT,
                details={"destination_file_paths": collisions},
            )
        return
    if target.exists() and not overwrite:
        raise AppError(
            "EXPORT_DESTINATION_EXISTS",
            "Export destination already exists.",
            status_code=status.HTTP_409_CONFLICT,
            details={"destination_file_path": str(target)},
        )


def build_preview_plan(
    session: Session,
    *,
    project: Project,
    retune: dict[str, Any] | None,
    transpose: dict[str, Any] | None,
    output_format: str,
) -> tuple[TransformPlan, Artifact | None]:
    if output_format != get_settings().preview_format:
        raise AppError(
            "INVALID_REQUEST",
            f"Preview output must be {get_settings().preview_format}.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    total_cents = 0.0
    metadata: dict[str, Any] = {"retune": retune, "transpose": transpose}
    if retune:
        if retune.get("target_cents_offset") is not None:
            total_cents += float(retune["target_cents_offset"])
        else:
            total_cents += _reference_cents(session, project, float(retune["target_reference_hz"]))
    if transpose:
        total_cents += semitones_to_cents(int(transpose["semitones"]))
    if total_cents == 0:
        raise AppError("INVALID_REQUEST", "Preview requires at least one non-zero transform.")

    cache_key = _preview_cache_key(
        project.id,
        {"retune": retune or {}, "transpose": transpose or {}, "output_format": output_format},
    )
    cached = find_cached_artifact(session, cache_key=cache_key)
    destination = project_previews_dir(project.id) / f"{cache_key}.{output_format}"
    plan = TransformPlan(
        artifact_type="preview_mix",
        destination_path=destination,
        output_format=output_format,
        total_cents=total_cents,
        cache_key=cache_key,
        metadata={**metadata, "total_cents": total_cents},
    )
    return plan, cached


def build_single_transform_plan(
    session: Session,
    *,
    project: Project,
    transform_type: str,
    payload: dict[str, Any],
) -> TransformPlan:
    output_format = payload.get("output_format", get_settings().preview_format)
    preview_only = payload.get("preview_only", True)
    if transform_type == "retune":
        if payload.get("target_cents_offset") is not None:
            total_cents = float(payload["target_cents_offset"])
        else:
            total_cents = _reference_cents(session, project, float(payload["target_reference_hz"]))
    else:
        total_cents = semitones_to_cents(int(payload["semitones"]))

    root = project_previews_dir(project.id) if preview_only else project_exports_dir(project.id)
    artifact_type = "preview_mix" if preview_only else "export_mix"
    file_name = stable_hash({"project_id": project.id, "type": transform_type, "payload": payload})
    destination = root / f"{file_name}.{output_format}"
    return TransformPlan(
        artifact_type=artifact_type,
        destination_path=destination,
        output_format=output_format,
        total_cents=total_cents,
        cache_key=file_name if preview_only else None,
        metadata={"kind": transform_type, "payload": payload, "total_cents": total_cents},
    )


def execute_transform_plan(
    session: Session,
    *,
    project: Project,
    plan: TransformPlan,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> Artifact:
    source_path = Path(project.imported_path)
    sample_rate = project.sample_rate or 44100
    run_ffmpeg_transform(
        source_path,
        plan.destination_path.with_suffix(""),
        sample_rate,
        plan.total_cents,
        plan.output_format,
        on_progress=on_progress,
        should_cancel=should_cancel,
        register_process=register_process,
        unregister_process=unregister_process,
    )
    output_path = plan.destination_path.with_suffix(f".{plan.output_format}")
    artifact = register_artifact(
        session,
        project_id=project.id,
        artifact_type=plan.artifact_type,
        artifact_format=plan.output_format,
        path=output_path,
        metadata=plan.metadata,
        cache_key=plan.cache_key,
        generated_by="ffmpeg",
    )
    return artifact


def _export_one_to_target(
    *,
    source: Artifact,
    target: Path,
    output_format: str,
    overwrite: bool,
    sample_rate: int,
    should_cancel: Callable[[], bool] | None,
    register_process: Callable[[subprocess.Popen[str]], None] | None,
    unregister_process: Callable[[], None] | None,
    on_progress: Callable[[int], None] | None,
) -> None:
    source_path = Path(source.path)
    temp_base_path, temp_path = _new_sibling_temp_paths(target, output_format)
    try:
        if source.format == output_format:
            _ensure_not_cancelled(should_cancel)
            shutil.copy2(source_path, temp_path)
            if on_progress:
                on_progress(90)
            _ensure_not_cancelled(should_cancel)
        else:
            run_ffmpeg_transform(
                source_path,
                temp_base_path,
                sample_rate,
                0.0,
                output_format,
                on_progress=on_progress,
                should_cancel=should_cancel,
                register_process=register_process,
                unregister_process=unregister_process,
            )
            _ensure_not_cancelled(should_cancel)
        if target.exists() and not overwrite:
            raise AppError("EXPORT_DESTINATION_EXISTS", "An export destination already exists.", status_code=409)
        temp_path.replace(target)
    finally:
        temp_base_path.unlink(missing_ok=True)
        temp_path.unlink(missing_ok=True)


def _normalized_text_file(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
    return f"{normalized}\n"


def _lyrics_text(segments: list[dict[str, Any]]) -> str:
    return _normalized_text_file("\n".join(str(segment.get("text", "")) for segment in segments))


def _finite_number(value: object) -> float | None:
    if not isinstance(value, int | float):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _chord_label(segment: dict[str, Any]) -> str:
    display_label = segment.get("display_label")
    if isinstance(display_label, str) and display_label.strip():
        return display_label.strip()
    label = segment.get("label")
    return label.strip() if isinstance(label, str) else ""


def _pitch_class_label(
    pitch_class: int,
    *,
    active_key: dict[str, Any] | None,
    display_mode: str,
) -> str:
    normalized = pitch_class % 12
    if display_mode == "sharps":
        labels = _SHARP_PITCH_CLASSES
    elif display_mode == "flats":
        labels = _FLAT_PITCH_CLASSES
    elif display_mode == "auto" and active_key is not None:
        mode = str(active_key.get("mode", "major"))
        key_pitch_class = active_key.get("pitch_class")
        family = (
            _AUTO_KEY_FAMILIES.get(mode, _AUTO_KEY_FAMILIES["major"])[key_pitch_class % 12]
            if isinstance(key_pitch_class, int)
            else "neutral"
        )
        labels = _SHARP_PITCH_CLASSES if family == "sharp" else (
            _FLAT_PITCH_CLASSES if family == "flat" else _NEUTRAL_PITCH_CLASSES
        )
    else:
        labels = _NEUTRAL_PITCH_CLASSES
    return labels[normalized]


def _format_transposed_chord(
    *,
    root_pitch_class: int,
    quality: str,
    bass_pitch_class: int | None,
    transpose_semitones: int,
    active_key: dict[str, Any] | None,
    display_mode: str,
) -> str | None:
    suffix = _CHORD_QUALITY_SUFFIXES.get(quality)
    if suffix is None:
        return None
    root = (root_pitch_class + transpose_semitones) % 12
    bass = (bass_pitch_class + transpose_semitones) % 12 if bass_pitch_class is not None else None
    if display_mode == "dual":
        sharp_root = _SHARP_PITCH_CLASSES[root]
        flat_root = _FLAT_PITCH_CLASSES[root]
        sharp_bass = f"/{_SHARP_PITCH_CLASSES[bass]}" if bass is not None and bass != root else ""
        flat_bass = f"/{_FLAT_PITCH_CLASSES[bass]}" if bass is not None and bass != root else ""
        primary = f"{sharp_root}{suffix}{sharp_bass}"
        secondary = f"{flat_root}{suffix}{flat_bass}"
        return primary if primary == secondary else f"{primary} / {secondary}"
    root_label = _pitch_class_label(root, active_key=active_key, display_mode=display_mode)
    bass_label = (
        f"/{_pitch_class_label(bass, active_key=active_key, display_mode=display_mode)}"
        if bass is not None and bass != root
        else ""
    )
    return f"{root_label}{suffix}{bass_label}"


def _display_chord_segment(segment: dict[str, Any], context: dict[str, Any] | None) -> dict[str, Any]:
    if context is None:
        return segment
    transpose_semitones = context.get("transpose_semitones")
    display_mode = context.get("display_mode")
    active_key = context.get("active_key")
    if not isinstance(transpose_semitones, int) or display_mode not in {
        "auto", "sharps", "flats", "neutral", "dual",
    }:
        return segment
    root_pitch_class = segment.get("pitch_class")
    quality = segment.get("quality")
    bass_pitch_class = segment.get("bass_pitch_class")
    label = None
    if isinstance(root_pitch_class, int) and isinstance(quality, str):
        label = _format_transposed_chord(
            root_pitch_class=root_pitch_class,
            quality=quality,
            bass_pitch_class=bass_pitch_class if isinstance(bass_pitch_class, int) else None,
            transpose_semitones=transpose_semitones,
            active_key=active_key if isinstance(active_key, dict) else None,
            display_mode=display_mode,
        )
    if label is None:
        candidates = (segment.get("label"), segment.get("display_label"), segment.get("raw_label"))
        for candidate in candidates:
            if not isinstance(candidate, str) or not candidate.strip():
                continue
            parsed = parse_chord_label(candidate)
            if parsed.is_no_chord or parsed.is_unknown or parsed.root_pitch_class is None or parsed.quality is None:
                continue
            label = _format_transposed_chord(
                root_pitch_class=parsed.root_pitch_class,
                quality=parsed.quality,
                bass_pitch_class=parsed.bass_pitch_class,
                transpose_semitones=transpose_semitones,
                active_key=active_key if isinstance(active_key, dict) else None,
                display_mode=display_mode,
            )
            if label is not None:
                break
    return {**segment, "label": label, "display_label": label} if label is not None else segment


def _word_character_positions(text: str, words: list[object]) -> list[int | None]:
    cursor = 0
    positions: list[int | None] = []
    folded_text = text.casefold()
    for word in words:
        if not isinstance(word, dict):
            positions.append(None)
            continue
        raw_word = word.get("text")
        token = raw_word.strip() if isinstance(raw_word, str) else ""
        position = folded_text.find(token.casefold(), cursor) if token else -1
        if position < 0:
            positions.append(None)
            continue
        positions.append(position)
        cursor = position + len(token)
    return positions


def _chord_character_anchor(chord: dict[str, Any], lyric: dict[str, Any], text: str) -> int:
    chord_start = _finite_number(chord.get("start_seconds"))
    words = lyric.get("words")
    if chord_start is not None and isinstance(words, list) and words:
        timed_words: list[tuple[int, float, float]] = []
        for index, word in enumerate(words):
            if not isinstance(word, dict):
                continue
            start = _finite_number(word.get("start_seconds"))
            end = _finite_number(word.get("end_seconds"))
            if start is not None and end is not None and end >= start:
                timed_words.append((index, start, end))
        positions = _word_character_positions(text, words)
        if timed_words and any(index < len(positions) and positions[index] is not None for index, _, _ in timed_words):
            chosen = timed_words[-1][0]
            for index, start, end in timed_words:
                if chord_start < start or start <= chord_start < end:
                    chosen = index
                    break
            selected_position = positions[chosen] if chosen < len(positions) else None
            if selected_position is not None:
                return selected_position

    lyric_start = _finite_number(lyric.get("start_seconds"))
    lyric_end = _finite_number(lyric.get("end_seconds"))
    if chord_start is not None and lyric_start is not None and lyric_end is not None and lyric_end > lyric_start:
        ratio = min(1.0, max(0.0, (chord_start - lyric_start) / (lyric_end - lyric_start)))
        return min(max(len(text) - 1, 0), int(ratio * len(text)))
    return 0


def _anchored_chord_line(chords: list[dict[str, Any]], lyric: dict[str, Any], text: str) -> str:
    line = ""
    next_column = 0
    for chord in chords:
        label = _chord_label(chord)
        if not label:
            continue
        column = max(_chord_character_anchor(chord, lyric, text), next_column)
        line += " " * max(0, column - len(line)) + label
        next_column = len(line) + 1
    return line


def _lyrics_with_chords_text(
    lyrics_segments: list[dict[str, Any]],
    chord_segments: list[dict[str, Any]],
    chord_context: dict[str, Any] | None = None,
) -> str:
    ordered_chords = sorted(
        (
            _display_chord_segment(segment, chord_context)
            for segment in chord_segments
            if isinstance(segment, dict)
        ),
        key=lambda segment: (_finite_number(segment.get("start_seconds")) is None,
                             _finite_number(segment.get("start_seconds")) or 0),
    )
    lyric_chords: dict[int, list[dict[str, Any]]] = {}
    gap_chords: dict[int, list[dict[str, Any]]] = {}
    for chord in ordered_chords:
        chord_start = _finite_number(chord.get("start_seconds"))
        lyric_index = next(
            (
                index
                for index, lyric in enumerate(lyrics_segments)
                if chord_start is not None
                and (start := _finite_number(lyric.get("start_seconds"))) is not None
                and (end := _finite_number(lyric.get("end_seconds"))) is not None
                and start <= chord_start < end
            ),
            None,
        )
        if lyric_index is not None:
            lyric_chords.setdefault(lyric_index, []).append(chord)
            continue
        insertion_index = next(
            (
                index
                for index, lyric in enumerate(lyrics_segments)
                if chord_start is not None
                and (start := _finite_number(lyric.get("start_seconds"))) is not None
                and chord_start < start
            ),
            len(lyrics_segments),
        )
        gap_chords.setdefault(insertion_index, []).append(chord)

    blocks: list[str] = []
    for index in range(len(lyrics_segments) + 1):
        gap_line = " ".join(
            _chord_label(chord) for chord in gap_chords.get(index, []) if _chord_label(chord)
        )
        if gap_line:
            blocks.append(gap_line)
        if index >= len(lyrics_segments):
            continue
        lyric = lyrics_segments[index]
        text = str(lyric.get("text", "")).replace("\r\n", "\n").replace("\r", "\n")
        chord_line = _anchored_chord_line(lyric_chords.get(index, []), lyric, text)
        blocks.append(f"{chord_line}\n{text}" if chord_line else text)
    return _normalized_text_file("\n\n".join(blocks))


def _write_document_to_target(
    *,
    content: str,
    target: Path,
    overwrite: bool,
    should_cancel: Callable[[], bool] | None,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=target.parent,
        prefix="tuneforge-export-",
        suffix=".txt",
        delete=False,
    ) as temp:
        temp_path = Path(temp.name)
    try:
        temp_path.write_text(content, encoding="utf-8", newline="\n")
        _ensure_not_cancelled(should_cancel)
        if target.exists() and not overwrite:
            raise AppError("EXPORT_DESTINATION_EXISTS", "An export destination already exists.", status_code=409)
        temp_path.replace(target)
    finally:
        temp_path.unlink(missing_ok=True)


def _export_result_payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    completed_count = sum(item["status"] == "completed" for item in items)
    failed_count = sum(item["status"] == "failed" for item in items)
    outcome = "completed" if completed_count == len(items) else "partial" if completed_count else "failed"
    return {
        "outcome": outcome,
        "total_count": len(items),
        "completed_count": completed_count,
        "failed_count": failed_count,
        "items": [dict(item) for item in items],
    }


def export_artifacts(
    session: Session,
    *,
    project: Project,
    artifact_ids: list[str],
    output_format: str,
    destination: dict[str, Any],
    output_names: list[str],
    generated_document_ids: list[str] | None = None,
    lyrics_segments: list[dict[str, Any]] | None = None,
    chord_segments: list[dict[str, Any]] | None = None,
    document_chord_context: dict[str, Any] | None = None,
    on_progress: Callable[[int], None] | None = None,
    on_result: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> ExportBatchResult:
    generated_document_ids = generated_document_ids or []
    lyrics_segments = lyrics_segments or []
    chord_segments = chord_segments or []
    artifacts = [session.get(Artifact, artifact_id) for artifact_id in artifact_ids]
    invalid_sources = any(artifact is None for artifact in artifacts)
    if len(artifacts) + len(generated_document_ids) != len(output_names) or invalid_sources:
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact not found.", status_code=status.HTTP_404_NOT_FOUND)
    selected = [artifact for artifact in artifacts if artifact is not None]
    target = Path(str(destination["target"])).expanduser().resolve()
    destination_type = str(destination["type"])
    overwrite = bool(destination.get("overwrite", False))
    _preflight_export_destination(destination, output_names)
    sample_rate = project.sample_rate or 44100
    items: list[dict[str, Any]] = [
        {
            "artifact_id": artifact.id,
            "generated_document_id": None,
            "output_name": output_name,
            "status": "pending",
            "progress": 0,
            "result_artifact_id": None,
            "error": None,
        }
        for artifact, output_name in zip(selected, output_names[:len(selected)], strict=True)
    ]
    items.extend(
        {
            "artifact_id": None,
            "generated_document_id": document_id,
            "output_name": output_name,
            "status": "pending",
            "progress": 0,
            "result_artifact_id": None,
            "error": None,
        }
        for document_id, output_name in zip(
            generated_document_ids,
            output_names[len(selected):],
            strict=True,
        )
    )
    result_artifact_ids: list[str] = []

    def publish_result() -> None:
        if on_result:
            on_result(_export_result_payload(items))

    with tempfile.TemporaryDirectory(prefix="tuneforge-export-stage-") as stage_dir_name:
        stage_dir = Path(stage_dir_name)
        completed_outputs: list[tuple[Artifact | None, str | None, Path, str]] = []
        sources: list[tuple[Artifact | None, str | None]] = [
            *((artifact, None) for artifact in selected),
            *((None, document_id) for document_id in generated_document_ids),
        ]
        for index, ((artifact, document_id), output_name) in enumerate(zip(sources, output_names, strict=True)):
            _ensure_not_cancelled(should_cancel)
            item = items[index]
            item["status"] = "running"
            item["progress"] = 5
            publish_result()
            item_target = stage_dir / output_name if destination_type == "zip" else (
                target / output_name if destination_type == "folder" else target
            )

            def report_item_progress(value: int, *, item_index: int = index) -> None:
                items[item_index]["progress"] = min(99, max(0, value))
                if on_progress:
                    on_progress(int(((item_index + value / 100) / len(items)) * 85) + 10)
                publish_result()

            try:
                if artifact is not None:
                    _export_one_to_target(
                        source=artifact,
                        target=item_target,
                        output_format=output_format,
                        overwrite=overwrite,
                        sample_rate=sample_rate,
                        should_cancel=should_cancel,
                        register_process=register_process,
                        unregister_process=unregister_process,
                        on_progress=report_item_progress,
                    )
                else:
                    _ensure_not_cancelled(should_cancel)
                    content = (
                        _lyrics_text(lyrics_segments)
                        if document_id == "lyrics"
                        else _lyrics_with_chords_text(
                            lyrics_segments,
                            chord_segments,
                            document_chord_context,
                        )
                    )
                    _write_document_to_target(
                        content=content,
                        target=item_target,
                        overwrite=overwrite,
                        should_cancel=should_cancel,
                    )
                    report_item_progress(90)
            except JobCancelledError:
                item["status"] = "cancelled"
                publish_result()
                raise
            except (AppError, OSError):
                item["status"] = "failed"
                item["error"] = "Could not export this item."
                publish_result()
                continue

            item["status"] = "completed"
            item["progress"] = 100
            completed_outputs.append((artifact, document_id, item_target, output_name))
            if destination_type != "zip":
                exported = register_artifact(
                    session,
                    project_id=project.id,
                    artifact_type="export_mix",
                    artifact_format=output_format if artifact is not None else "txt",
                    path=item_target,
                    metadata={
                        **({"source_artifact_id": artifact.id} if artifact is not None else {
                            "generated_document_id": document_id,
                        }),
                        "output_name": output_name,
                    },
                    generated_by="ffmpeg" if artifact is not None else "tuneforge",
                    can_delete=True,
                    can_regenerate=False,
                )
                item["result_artifact_id"] = exported.id
                result_artifact_ids.append(exported.id)
            publish_result()

        if destination_type == "zip" and completed_outputs:
            _ensure_not_cancelled(should_cancel)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=target.parent,
                prefix="tuneforge-export-",
                suffix=".zip",
                delete=False,
            ) as temp:
                zip_path = Path(temp.name)
            try:
                with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for _artifact, _document_id, staged_path, output_name in completed_outputs:
                        archive.write(staged_path, arcname=output_name)
                _ensure_not_cancelled(should_cancel)
                if target.exists() and not overwrite:
                    _preflight_export_destination(destination, output_names)
                zip_path.replace(target)
            finally:
                zip_path.unlink(missing_ok=True)
            archive_artifact = register_artifact(
                session,
                project_id=project.id,
                artifact_type="export_mix",
                artifact_format="zip",
                path=target,
                metadata={
                    "source_artifact_ids": [
                        artifact.id for artifact, _, _, _ in completed_outputs if artifact is not None
                    ],
                    "generated_document_ids": [
                        document_id for _, document_id, _, _ in completed_outputs if document_id is not None
                    ],
                    "output_names": [output_name for _, _, _, output_name in completed_outputs],
                    "contained_format": (
                        "mixed" if artifact_ids and generated_document_ids
                        else "txt" if generated_document_ids
                        else output_format
                    ),
                },
                generated_by="ffmpeg",
                can_delete=True,
                can_regenerate=False,
            )
            result_artifact_ids.append(archive_artifact.id)
            for item in items:
                if item["status"] == "completed":
                    item["result_artifact_id"] = archive_artifact.id
            publish_result()

    export_result = _export_result_payload(items)
    return ExportBatchResult(artifact_ids=result_artifact_ids, export_result=export_result)
