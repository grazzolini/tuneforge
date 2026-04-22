from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, cast

from fastapi import status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.engines.lyrics import transcribe_project_lyrics
from app.errors import AppError
from app.models import Artifact, LyricsTranscript, Project
from app.schemas import LyricsEditSegmentSchema
from app.services.paths import project_analysis_dir


def _source_artifact(project: Project) -> Artifact | None:
    artifact = next((artifact for artifact in project.artifacts if artifact.type == "source_audio"), None)
    return artifact if isinstance(artifact, Artifact) else None


def _write_lyrics_snapshot(
    *,
    project_id: str,
    lyrics: LyricsTranscript,
) -> None:
    payload: dict[str, Any] = {
        "project_id": project_id,
        "backend": lyrics.backend,
        "source_artifact_id": lyrics.source_artifact_id,
        "source_kind": lyrics.source_kind,
        "requested_device": lyrics.requested_device,
        "device": lyrics.device,
        "model_name": lyrics.model_name,
        "language": lyrics.language,
        "source_segments": lyrics.source_segments_json,
        "segments": lyrics.segments_json,
        "has_user_edits": lyrics.has_user_edits,
        "created_at": lyrics.created_at.isoformat(),
        "updated_at": lyrics.updated_at.isoformat(),
    }

    lyrics_path = project_analysis_dir(project_id) / "lyrics.json"
    lyrics_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def generate_project_lyrics(session: Session, *, project: Project, force: bool = False) -> LyricsTranscript:
    existing = session.get(LyricsTranscript, project.id)
    if existing is not None and existing.segments_json and not force:
        return existing

    transcription = transcribe_project_lyrics(
        Path(project.imported_path),
        model_name=get_settings().lyrics_model,
        requested_device=get_settings().lyrics_device,
        download_root=get_settings().lyrics_cache_dir,
    )
    source_artifact = _source_artifact(project)

    if existing is None:
        existing = LyricsTranscript(project_id=project.id)
        session.add(existing)

    existing.backend = transcription.backend
    existing.source_artifact_id = source_artifact.id if source_artifact else None
    existing.source_kind = "ai"
    existing.requested_device = transcription.requested_device
    existing.device = transcription.device
    existing.model_name = transcription.model
    existing.language = transcription.language
    existing.source_segments_json = cast(list[dict[str, Any]], deepcopy(transcription.segments))
    existing.segments_json = cast(list[dict[str, Any]], deepcopy(transcription.segments))
    existing.has_user_edits = False
    session.flush()
    session.refresh(existing)

    _write_lyrics_snapshot(project_id=project.id, lyrics=existing)
    return existing


def update_project_lyrics(
    session: Session,
    *,
    project: Project,
    edits: list[LyricsEditSegmentSchema],
) -> LyricsTranscript:
    lyrics = session.get(LyricsTranscript, project.id)
    if lyrics is None:
        raise AppError("LYRICS_NOT_FOUND", "Lyrics have not been generated for this project.", status_code=404)

    current_segments = lyrics.segments_json
    source_segments = lyrics.source_segments_json
    if len(edits) != len(current_segments):
        raise AppError(
            "INVALID_REQUEST",
            "Lyrics edits must preserve the existing segment count in v1.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    updated_segments: list[dict[str, Any]] = []
    for index, edit in enumerate(edits):
        current_segment = dict(current_segments[index])
        source_segment = source_segments[index] if index < len(source_segments) else None
        text = edit.text
        current_segment["text"] = text
        current_segment["start_seconds"] = current_segments[index].get("start_seconds")
        current_segment["end_seconds"] = current_segments[index].get("end_seconds")

        if isinstance(source_segment, dict) and text == source_segment.get("text"):
            if "words" in source_segment:
                current_segment["words"] = deepcopy(source_segment["words"])
            else:
                current_segment.pop("words", None)
        elif text != current_segments[index].get("text"):
            current_segment.pop("words", None)

        updated_segments.append(current_segment)

    lyrics.segments_json = cast(list[dict[str, Any]], updated_segments)
    lyrics.has_user_edits = updated_segments != source_segments
    session.flush()
    session.refresh(lyrics)
    _write_lyrics_snapshot(project_id=project.id, lyrics=lyrics)
    return lyrics
