from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, cast

from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Artifact, ChordTimeline, Project, utcnow
from app.services.chord_backends import (
    ChordDetectionResult,
    chord_backend_uses_source_instrumental_stem,
    detect_with_chord_backend,
    resolve_chord_backend,
    resolve_chord_backend_id,
)
from app.services.paths import project_analysis_dir
from app.services.tab_state import clear_project_tab_state


def detect_project_chords(
    session: Session,
    project: Project,
    *,
    backend: str = "default",
    backend_fallback_from: str | None = None,
    force: bool = False,
    overwrite_user_edits: bool = False,
) -> ChordTimeline:
    selected_backend = resolve_chord_backend(backend, require_available=True)
    selected_backend_id = selected_backend.id
    existing = session.get(ChordTimeline, project.id)
    if existing is not None and existing.has_user_edits and not overwrite_user_edits:
        existing.source_kind = "user-edited"
        return existing
    if (
        existing is not None
        and existing.segments_json
        and not force
        and not overwrite_user_edits
        and _same_backend(existing.backend, selected_backend_id)
    ):
        return existing

    source_artifact = _source_audio_artifact(project)
    source_path = Path(source_artifact.path) if source_artifact is not None else Path(project.imported_path)
    source_result = _detect_timeline(source_path, selected_backend_id)
    runtime_device = source_result.runtime_device
    source_timeline = source_result.segments
    augmented_timeline = (
        _augment_with_source_instrumental_stem(
            project,
            backend_id=selected_backend_id,
            source_artifact=source_artifact,
            source_timeline=source_timeline,
        )
        if chord_backend_uses_source_instrumental_stem(selected_backend_id)
        else source_timeline
    )
    updated_at = utcnow()
    clear_project_tab_state(session, project_id=project.id)

    if existing is None:
        existing = ChordTimeline(project_id=project.id, created_at=updated_at)
        session.add(existing)

    existing.backend = selected_backend_id
    existing.source_artifact_id = source_artifact.id if isinstance(source_artifact, Artifact) else None
    existing.source_segments_json = cast(list[dict[str, Any]], deepcopy(source_timeline))
    existing.segments_json = cast(list[dict[str, Any]], deepcopy(augmented_timeline))
    existing.timeline_json = cast(list[dict[str, Any]], deepcopy(augmented_timeline))
    existing.has_user_edits = False
    existing.source_kind = "generated"
    existing.metadata_json = {
        "backend_id": selected_backend_id,
        "backend_label": selected_backend.label,
        "backend_capabilities": selected_backend.capabilities.__dict__,
        "backend_fallback_from": backend_fallback_from,
        "runtime_device": runtime_device,
        "detection": source_result.metadata,
    }
    existing.updated_at = updated_at
    session.flush()
    session.refresh(existing)

    chord_path = project_analysis_dir(project.id) / "chords.json"
    chord_path.write_text(
        json.dumps(
            {
                "project_id": project.id,
                "backend": existing.backend,
                "source_artifact_id": existing.source_artifact_id,
                "source_segments": existing.source_segments_json,
                "timeline": existing.segments_json,
                "has_user_edits": existing.has_user_edits,
                "source_kind": existing.source_kind,
                "metadata": existing.metadata_json,
                "created_at": existing.created_at.isoformat(),
                "updated_at": existing.updated_at.isoformat() if existing.updated_at else None,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    return existing


def _source_audio_artifact(project: Project) -> Artifact | None:
    return next((artifact for artifact in project.artifacts if artifact.type == "source_audio"), None)


def project_chord_detection_source(project: Project, backend: str = "default") -> str:
    if not chord_backend_uses_source_instrumental_stem(backend):
        return "source"
    source_artifact = _source_audio_artifact(project)
    return "source+stem" if _source_instrumental_stem(project, source_artifact) is not None else "source"


def _source_instrumental_stem(project: Project, source_artifact: Artifact | None) -> Artifact | None:
    if source_artifact is None:
        return None
    instrumental_stems = [
        artifact
        for artifact in project.artifacts
        if artifact.type == "instrumental_stem"
        and Path(artifact.path).exists()
        and artifact.metadata_json.get("source_artifact_id") == source_artifact.id
    ]
    if instrumental_stems:
        return max(instrumental_stems, key=lambda artifact: artifact.created_at)
    return None


def _augment_with_source_instrumental_stem(
    project: Project,
    *,
    backend_id: str,
    source_artifact: Artifact | None,
    source_timeline: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    instrumental_stem = _source_instrumental_stem(project, source_artifact)
    if instrumental_stem is None or not source_timeline:
        return source_timeline

    stem_timeline = _detect_timeline(Path(instrumental_stem.path), backend_id).segments
    if not stem_timeline:
        return source_timeline

    augmented = [
        _augment_segment_with_stem(segment, stem_timeline)
        for segment in source_timeline
    ]
    return _merge_adjacent_same_label(augmented)


def _augment_segment_with_stem(
    source_segment: dict[str, Any],
    stem_timeline: list[dict[str, Any]],
) -> dict[str, Any]:
    stem_segment, overlap = _dominant_overlap(source_segment, stem_timeline)
    if stem_segment is None or overlap < 0.45:
        return dict(source_segment)

    if stem_segment.get("label") == source_segment.get("label"):
        return _merge_matching_segment_confidence(source_segment, stem_segment)

    source_confidence = _confidence_value(source_segment)
    stem_confidence = _confidence_value(stem_segment)
    if source_confidence < 0.52 and stem_confidence >= source_confidence + 0.14:
        return {
            **stem_segment,
            "start_seconds": source_segment["start_seconds"],
            "end_seconds": source_segment["end_seconds"],
            "confidence": round(min(1.0, stem_confidence * 0.92), 3),
        }

    return dict(source_segment)


def _dominant_overlap(
    source_segment: dict[str, Any],
    stem_timeline: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, float]:
    source_start = float(source_segment["start_seconds"])
    source_end = float(source_segment["end_seconds"])
    source_duration = max(source_end - source_start, 1e-6)
    best_segment: dict[str, Any] | None = None
    best_overlap = 0.0
    for stem_segment in stem_timeline:
        overlap = max(
            0.0,
            min(source_end, float(stem_segment["end_seconds"]))
            - max(source_start, float(stem_segment["start_seconds"])),
        )
        if overlap > best_overlap:
            best_segment = stem_segment
            best_overlap = overlap
    return best_segment, best_overlap / source_duration


def _merge_matching_segment_confidence(
    source_segment: dict[str, Any],
    stem_segment: dict[str, Any],
) -> dict[str, Any]:
    source_confidence = _confidence_value(source_segment)
    stem_confidence = _confidence_value(stem_segment)
    if source_confidence <= 0.0 and stem_confidence <= 0.0:
        return dict(source_segment)
    return {
        **source_segment,
        "confidence": round(
            max(source_confidence, stem_confidence) * 0.85
            + min(source_confidence, stem_confidence) * 0.15,
            3,
        ),
    }


def _merge_adjacent_same_label(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []
    merged = [dict(segments[0])]
    for segment in segments[1:]:
        previous = merged[-1]
        if previous.get("label") != segment.get("label"):
            merged.append(dict(segment))
            continue
        previous["end_seconds"] = segment["end_seconds"]
        previous["confidence"] = _weighted_confidence(previous, segment)
    return merged


def _weighted_confidence(first: dict[str, Any], second: dict[str, Any]) -> float | None:
    first_confidence = first.get("confidence")
    second_confidence = second.get("confidence")
    if first_confidence is None:
        return float(second_confidence) if isinstance(second_confidence, int | float) else None
    if second_confidence is None:
        return float(first_confidence) if isinstance(first_confidence, int | float) else None
    first_duration = float(first["end_seconds"]) - float(first["start_seconds"])
    second_duration = float(second["end_seconds"]) - float(second["start_seconds"])
    total_duration = max(first_duration + second_duration, 1e-6)
    return round(float((first_confidence * first_duration + second_confidence * second_duration) / total_duration), 3)


def _confidence_value(segment: dict[str, Any]) -> float:
    confidence = segment.get("confidence")
    if isinstance(confidence, int | float):
        return float(confidence)
    return 0.0


def _detect_timeline(source_path: Path, backend_id: str) -> ChordDetectionResult:
    return detect_with_chord_backend(source_path, backend_id)


def _same_backend(existing_backend: str | None, selected_backend_id: str) -> bool:
    if existing_backend is None:
        return False
    try:
        return resolve_chord_backend_id(existing_backend) == selected_backend_id
    except AppError:
        return existing_backend == selected_backend_id
