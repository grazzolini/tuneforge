from __future__ import annotations

import json
import re
from copy import deepcopy
from difflib import SequenceMatcher
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
from app.services.tab_state import clear_project_tab_state

WORD_RE = re.compile(r"\S+")


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
    if force:
        clear_project_tab_state(session, project_id=project.id)

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
            current_segment["words"] = retime_lyrics_words(current_segments[index], text)

        updated_segments.append(current_segment)

    lyrics.segments_json = cast(list[dict[str, Any]], updated_segments)
    lyrics.has_user_edits = updated_segments != source_segments
    session.flush()
    session.refresh(lyrics)
    _write_lyrics_snapshot(project_id=project.id, lyrics=lyrics)
    return lyrics


def persist_project_lyrics_segments(
    session: Session,
    *,
    project_id: str,
    segments: list[dict[str, Any]],
) -> LyricsTranscript:
    lyrics = session.get(LyricsTranscript, project_id)
    if lyrics is None:
        raise AppError("LYRICS_NOT_FOUND", "Lyrics have not been generated for this project.", status_code=404)

    lyrics.segments_json = cast(list[dict[str, Any]], deepcopy(segments))
    lyrics.has_user_edits = lyrics.segments_json != lyrics.source_segments_json
    session.flush()
    session.refresh(lyrics)
    _write_lyrics_snapshot(project_id=project_id, lyrics=lyrics)
    return lyrics


def retime_lyrics_segment_text(segment: dict[str, Any], text: str) -> dict[str, Any]:
    updated = dict(segment)
    updated["text"] = text
    updated["start_seconds"] = segment.get("start_seconds")
    updated["end_seconds"] = segment.get("end_seconds")
    updated["words"] = retime_lyrics_words(segment, text)
    return updated


def retime_lyrics_words(segment: dict[str, Any], text: str) -> list[dict[str, Any]]:
    new_tokens = [match.group(0) for match in WORD_RE.finditer(text)]
    if not new_tokens:
        return []

    words = [word for word in segment.get("words", []) if isinstance(word, dict)]
    timed_words = [
        word
        for word in words
        if isinstance(word.get("start_seconds"), int | float)
        and isinstance(word.get("end_seconds"), int | float)
    ]
    if not timed_words:
        start_seconds = _number_or_none(segment.get("start_seconds"))
        end_seconds = _number_or_none(segment.get("end_seconds"))
        if start_seconds is None or end_seconds is None or end_seconds <= start_seconds:
            return []
        return _spread_words(new_tokens, start_seconds, end_seconds)

    old_tokens = [str(word.get("text", "")) for word in timed_words]
    old_normalized = [_normalize_word(token) for token in old_tokens]
    new_normalized = [_normalize_word(token) for token in new_tokens]
    matcher = SequenceMatcher(a=old_normalized, b=new_normalized, autojunk=False)
    updated_words: list[dict[str, Any]] = []

    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        replacement_tokens = new_tokens[new_start:new_end]
        if not replacement_tokens:
            continue
        if tag == "equal":
            for old_index, token in zip(range(old_start, old_end), replacement_tokens, strict=True):
                updated_words.append(_word_with_text(timed_words[old_index], token))
            continue

        span_start, span_end = _timing_span_for_edit(timed_words, old_start, old_end, segment)
        if tag == "replace" and old_end - old_start == new_end - new_start:
            for old_index, token in zip(range(old_start, old_end), replacement_tokens, strict=True):
                updated_words.append(_word_with_text(timed_words[old_index], token))
            continue
        updated_words.extend(_spread_words(replacement_tokens, span_start, span_end))

    return updated_words


def _normalize_word(value: str) -> str:
    return re.sub(r"[^\w']+", "", value.lower())


def _number_or_none(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _word_with_text(word: dict[str, Any], text: str) -> dict[str, Any]:
    updated = dict(word)
    updated["text"] = text
    return updated


def _timing_span_for_edit(
    timed_words: list[dict[str, Any]],
    old_start: int,
    old_end: int,
    segment: dict[str, Any],
) -> tuple[float, float]:
    segment_start = _number_or_none(segment.get("start_seconds"))
    segment_end = _number_or_none(segment.get("end_seconds"))
    if old_start < old_end:
        first = timed_words[old_start]
        last = timed_words[old_end - 1]
        return float(first["start_seconds"]), float(last["end_seconds"])

    if old_start > 0:
        start = float(timed_words[old_start - 1]["end_seconds"])
    else:
        start = segment_start if segment_start is not None else float(timed_words[0]["start_seconds"])

    if old_start < len(timed_words):
        end = float(timed_words[old_start]["start_seconds"])
    else:
        end = segment_end if segment_end is not None else float(timed_words[-1]["end_seconds"])

    if end <= start:
        end = start + 0.05
    return start, end


def _spread_words(tokens: list[str], start_seconds: float, end_seconds: float) -> list[dict[str, Any]]:
    duration = max(end_seconds - start_seconds, 0.05)
    step = duration / len(tokens)
    return [
        {
            "text": token,
            "start_seconds": round(start_seconds + index * step, 3),
            "end_seconds": round(start_seconds + (index + 1) * step, 3),
            "confidence": None,
        }
        for index, token in enumerate(tokens)
    ]
