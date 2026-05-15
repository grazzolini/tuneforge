from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any, TypeAlias, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ChordTimeline, LyricsTranscript, Project, SongSection, SyncEntityRevision, utcnow
from app.services.sync_metadata import sanitize_sync_metadata
from app.services.sync_trust import get_or_create_local_identity
from app.utils.ids import new_id

RevisionPayload: TypeAlias = dict[str, Any]

CURRENT_REVISION_STATE = "active"
SUPERSEDED_REVISION_STATE = "superseded"
PROJECT_METADATA_ENTITY_TYPE = "project_metadata"
CHORDS_ENTITY_TYPE = "chords"
LYRICS_ENTITY_TYPE = "lyrics"
SECTION_ENTITY_TYPE = "section"
REGENERATION_ENTITY_TYPE = "regeneration"

_WINDOWS_ABSOLUTE_PATH_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")
_UNC_PATH_PATTERN = re.compile(r"^\\\\")
_DROP = object()


def record_project_metadata_revision(
    session: Session,
    project: Project,
    revision_type: str = "metadata_change",
    base_revision_id: str | None = None,
) -> SyncEntityRevision:
    payload = sanitize_revision_payload(
        {
            "project_id": project.id,
            "display_name": project.display_name,
            "source_key_override": project.source_key_override,
            "source_sha256": project.source_sha256,
            "duration_seconds": project.duration_seconds,
            "sample_rate": project.sample_rate,
            "channels": project.channels,
        }
    )
    return _record_entity_revision(
        session,
        project_id=project.id,
        entity_type=PROJECT_METADATA_ENTITY_TYPE,
        entity_id=project.id,
        revision_type=revision_type,
        payload=payload,
        metadata={},
        source_artifact_id=None,
        base_revision_id=base_revision_id,
    )


def record_chord_revision(
    session: Session,
    chords: ChordTimeline,
    revision_type: str = "generated",
    base_revision_id: str | None = None,
) -> SyncEntityRevision:
    payload = sanitize_revision_payload(
        {
            "project_id": chords.project_id,
            "backend": chords.backend,
            "source_kind": chords.source_kind,
            "has_user_edits": chords.has_user_edits,
            "source_segments": chords.source_segments_json or [],
            "segments": chords.segments_json or [],
            "timeline": chords.timeline_json or [],
        }
    )
    metadata = sanitize_revision_payload(chords.metadata_json or {})
    return _record_entity_revision(
        session,
        project_id=chords.project_id,
        entity_type=CHORDS_ENTITY_TYPE,
        entity_id=chords.project_id,
        revision_type=revision_type,
        payload=payload,
        metadata=metadata,
        source_artifact_id=chords.source_artifact_id,
        base_revision_id=base_revision_id,
    )


def record_lyrics_revision(
    session: Session,
    lyrics: LyricsTranscript,
    revision_type: str = "generated",
    base_revision_id: str | None = None,
) -> SyncEntityRevision:
    payload = sanitize_revision_payload(
        {
            "project_id": lyrics.project_id,
            "backend": lyrics.backend,
            "source_kind": lyrics.source_kind,
            "requested_device": lyrics.requested_device,
            "device": lyrics.device,
            "model_name": lyrics.model_name,
            "language": lyrics.language,
            "has_user_edits": lyrics.has_user_edits,
            "source_segments": lyrics.source_segments_json or [],
            "segments": lyrics.segments_json or [],
        }
    )
    return _record_entity_revision(
        session,
        project_id=lyrics.project_id,
        entity_type=LYRICS_ENTITY_TYPE,
        entity_id=lyrics.project_id,
        revision_type=revision_type,
        payload=payload,
        metadata={},
        source_artifact_id=lyrics.source_artifact_id,
        base_revision_id=base_revision_id,
    )


def record_section_revision(
    session: Session,
    section: SongSection,
    revision_type: str = "user_edit",
    base_revision_id: str | None = None,
) -> SyncEntityRevision:
    payload = sanitize_revision_payload(
        {
            "project_id": section.project_id,
            "section_id": section.id,
            "label": section.label,
            "start_seconds": section.start_seconds,
            "end_seconds": section.end_seconds,
            "source": section.source,
            "metadata": section.metadata_json or {},
        }
    )
    return _record_entity_revision(
        session,
        project_id=section.project_id,
        entity_type=SECTION_ENTITY_TYPE,
        entity_id=section.id,
        revision_type=revision_type,
        payload=payload,
        metadata={},
        source_artifact_id=None,
        base_revision_id=base_revision_id,
    )


def record_regeneration_revision(
    session: Session,
    *,
    project_id: str,
    entity_id: str,
    revision_type: str = "regenerated",
    base_revision_id: str | None = None,
    source_artifact_id: str | None = None,
    payload: Mapping[str, Any] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> SyncEntityRevision:
    revision_payload = sanitize_revision_payload(
        {
            "project_id": project_id,
            "entity_id": entity_id,
            "payload": dict(payload) if payload is not None else {},
        }
    )
    revision_metadata = sanitize_revision_payload(dict(metadata) if metadata is not None else {})
    return _record_entity_revision(
        session,
        project_id=project_id,
        entity_type=REGENERATION_ENTITY_TYPE,
        entity_id=entity_id,
        revision_type=revision_type,
        payload=revision_payload,
        metadata=revision_metadata,
        source_artifact_id=source_artifact_id,
        base_revision_id=base_revision_id,
    )


def list_project_entity_revisions(session: Session, project_id: str) -> list[SyncEntityRevision]:
    revisions = list(
        session.scalars(
            select(SyncEntityRevision)
            .where(SyncEntityRevision.project_id == project_id)
            .order_by(
                SyncEntityRevision.entity_type.asc(),
                SyncEntityRevision.entity_id.asc(),
                SyncEntityRevision.created_at.desc(),
                SyncEntityRevision.id.desc(),
            )
        )
    )
    current_by_entity: dict[tuple[str, str], SyncEntityRevision] = {}
    for revision in revisions:
        key = (revision.entity_type, revision.entity_id)
        existing = current_by_entity.get(key)
        if existing is None or _revision_precedes_existing(revision, existing):
            current_by_entity[key] = revision

    return sorted(
        current_by_entity.values(),
        key=lambda revision: (revision.entity_type, revision.entity_id),
    )


def current_entity_revision(
    session: Session,
    project_id: str,
    entity_type: str,
    entity_id: str,
) -> SyncEntityRevision | None:
    revisions = list(
        session.scalars(
            select(SyncEntityRevision)
            .where(
                SyncEntityRevision.project_id == project_id,
                SyncEntityRevision.entity_type == entity_type,
                SyncEntityRevision.entity_id == entity_id,
            )
            .order_by(SyncEntityRevision.created_at.desc(), SyncEntityRevision.id.desc())
        )
    )
    current_revision: SyncEntityRevision | None = None
    for revision in revisions:
        if current_revision is None or _revision_precedes_existing(revision, current_revision):
            current_revision = revision
    return current_revision


def _record_entity_revision(
    session: Session,
    *,
    project_id: str,
    entity_type: str,
    entity_id: str,
    revision_type: str,
    payload: RevisionPayload,
    metadata: RevisionPayload,
    source_artifact_id: str | None,
    base_revision_id: str | None,
) -> SyncEntityRevision:
    current_revision = current_entity_revision(session, project_id, entity_type, entity_id)
    resolved_base_revision_id = (
        base_revision_id
        if base_revision_id is not None
        else current_revision.id if current_revision is not None else None
    )
    _supersede_current_entity_revisions(session, project_id, entity_type, entity_id)

    now = utcnow()
    revision = SyncEntityRevision(
        id=new_id("rev"),
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id,
        revision_type=revision_type,
        base_revision_id=resolved_base_revision_id,
        author_device_id=get_or_create_local_identity(session).device_id,
        source_artifact_id=source_artifact_id,
        content_sha256=revision_payload_sha256(payload),
        state=CURRENT_REVISION_STATE,
        metadata_json=metadata,
        payload_json=payload,
        created_at=now,
        updated_at=now,
    )
    session.add(revision)
    session.flush()
    return revision


def _supersede_current_entity_revisions(
    session: Session,
    project_id: str,
    entity_type: str,
    entity_id: str,
) -> None:
    now = utcnow()
    revisions = session.scalars(
        select(SyncEntityRevision).where(
            SyncEntityRevision.project_id == project_id,
            SyncEntityRevision.entity_type == entity_type,
            SyncEntityRevision.entity_id == entity_id,
            SyncEntityRevision.state.in_((CURRENT_REVISION_STATE, "current")),
        )
    )
    for revision in revisions:
        revision.state = SUPERSEDED_REVISION_STATE
        revision.updated_at = now


def sanitize_revision_payload(value: Mapping[str, Any]) -> RevisionPayload:
    sanitized = _sanitize_sync_safe_value(sanitize_sync_metadata(dict(value)))
    if not isinstance(sanitized, dict):
        return {}
    return cast(RevisionPayload, sanitized)


def _sanitize_sync_safe_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        sanitized: dict[str, Any] = {}
        for key, child in value.items():
            if not isinstance(key, str) or _is_path_like_key(key):
                continue
            sanitized_child = _sanitize_sync_safe_value(child)
            if sanitized_child is not _DROP:
                sanitized[key] = sanitized_child
        return sanitized
    if isinstance(value, list):
        sanitized_items = [_sanitize_sync_safe_value(child) for child in value]
        return [child for child in sanitized_items if child is not _DROP]
    if isinstance(value, tuple):
        sanitized_items = [_sanitize_sync_safe_value(child) for child in value]
        return [child for child in sanitized_items if child is not _DROP]
    if isinstance(value, datetime):
        return _as_utc(value).isoformat()
    if isinstance(value, str) and _looks_like_local_absolute_path(value):
        return _DROP
    return value


def revision_payload_sha256(payload: RevisionPayload) -> str:
    return hashlib.sha256(_canonical_json_bytes(payload)).hexdigest()


def _canonical_json_bytes(payload: RevisionPayload) -> bytes:
    return json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _revision_precedes_existing(
    candidate: SyncEntityRevision,
    existing: SyncEntityRevision,
) -> bool:
    candidate_rank = _revision_state_rank(candidate.state)
    existing_rank = _revision_state_rank(existing.state)
    if candidate_rank != existing_rank:
        return candidate_rank < existing_rank
    if candidate.created_at != existing.created_at:
        return candidate.created_at > existing.created_at
    if candidate.updated_at != existing.updated_at:
        return candidate.updated_at > existing.updated_at
    return candidate.id > existing.id


def _revision_state_rank(state: str) -> int:
    if state in {CURRENT_REVISION_STATE, "current"}:
        return 0
    if state == "conflict":
        return 1
    if state == SUPERSEDED_REVISION_STATE:
        return 2
    return 3


def _is_path_like_key(key: str) -> bool:
    normalized = key.strip().lower().replace("-", "_")
    compact = normalized.replace("_", "")
    return normalized == "path" or normalized.endswith("_path") or compact.endswith("path") or compact in {
        "absolute_path",
        "local_path",
        "absolutepath",
        "localpath",
    }


def _looks_like_local_absolute_path(value: str) -> bool:
    if value.startswith("~/") or _WINDOWS_ABSOLUTE_PATH_PATTERN.match(value) is not None:
        return True
    if _UNC_PATH_PATTERN.match(value) is not None:
        return True
    try:
        return PurePosixPath(value).is_absolute()
    except ValueError:
        return False


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
