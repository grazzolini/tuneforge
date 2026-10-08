from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisResult,
    Artifact,
    ChordTimeline,
    LyricsTranscript,
    Project,
    SongSection,
    SyncDeleteTombstone,
    SyncEntityRevision,
    utcnow,
)
from app.services.sync_metadata import sanitize_sync_metadata
from app.services.sync_trust import get_or_create_local_identity
from app.utils.ids import new_id

type RevisionPayload = dict[str, Any]

CURRENT_REVISION_STATE = "active"
SUPERSEDED_REVISION_STATE = "superseded"
PROJECT_METADATA_ENTITY_TYPE = "project_metadata"
CHORDS_ENTITY_TYPE = "chords"
ANALYSIS_ENTITY_TYPE = "analysis"
LYRICS_ENTITY_TYPE = "lyrics"
SECTION_ENTITY_TYPE = "section"
REGENERATION_ENTITY_TYPE = "regeneration"

_WINDOWS_ABSOLUTE_PATH_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")
_UNC_PATH_PATTERN = re.compile(r"^\\\\")
_DROP = object()


def record_analysis_revision(
    session: Session,
    analysis: AnalysisResult,
    revision_type: str = "generated",
) -> SyncEntityRevision:
    payload = sanitize_revision_payload(
        {
            "project_id": analysis.project_id,
            "source_artifact_id": analysis.source_artifact_id,
            "estimated_key": analysis.estimated_key,
            "key_confidence": analysis.key_confidence,
            "estimated_reference_hz": analysis.estimated_reference_hz,
            "tuning_offset_cents": analysis.tuning_offset_cents,
            "tempo_bpm": analysis.tempo_bpm,
            "timing": analysis.timing_json,
            "analysis_version": analysis.analysis_version,
            "created_at": analysis.created_at,
            "updated_at": analysis.updated_at,
        }
    )
    return _record_entity_revision(
        session,
        project_id=analysis.project_id,
        entity_type=ANALYSIS_ENTITY_TYPE,
        entity_id=analysis.project_id,
        revision_type=revision_type,
        payload=payload,
        metadata=sanitize_revision_payload(analysis.metadata_json or {}),
        source_artifact_id=analysis.source_artifact_id,
        base_revision_id=None,
        independent_snapshot=True,
        created_at=analysis.created_at,
        updated_at=analysis.updated_at,
    )


def materialize_result_revisions(session: Session, project_id: str | None = None) -> None:
    """Upgrade unversioned results without assigning the upgrade clock as their write time."""
    from app.services.sync_manifest import _export_entity_revision_manifest, _hydrate_current_entity_revisions

    get_or_create_local_identity(session)
    revision_query = select(SyncEntityRevision)
    project_query = select(Project).where(Project.sync_status != "deleted")
    if project_id is not None:
        revision_query = revision_query.where(SyncEntityRevision.project_id == project_id)
        project_query = project_query.where(Project.id == project_id)
    revisions = list(session.scalars(revision_query))
    by_entity: dict[tuple[str, str], list[SyncEntityRevision]] = {}
    for revision in revisions:
        by_entity.setdefault((revision.project_id, revision.entity_type), []).append(revision)
    deleted_projects = {
        tombstone.target_id: _as_utc(tombstone.deleted_at)
        for tombstone in session.scalars(
            select(SyncDeleteTombstone).where(SyncDeleteTombstone.target_type == "project")
        )
    }
    deleted_results = {
        (tombstone.project_id, tombstone.prior_metadata_json.get("entity_type"))
        for tombstone in session.scalars(
            select(SyncDeleteTombstone).where(SyncDeleteTombstone.target_type == "entity_revision")
        )
        if tombstone.prior_metadata_json.get("entity_id") == tombstone.project_id
        and isinstance(tombstone.prior_metadata_json.get("entity_type"), str)
    }
    for project in session.scalars(project_query):
        if deleted_projects.get(project.id, datetime.min.replace(tzinfo=UTC)) >= _as_utc(project.updated_at):
            continue
        for entity_type, model in (
            (ANALYSIS_ENTITY_TYPE, AnalysisResult),
            (CHORDS_ENTITY_TYPE, ChordTimeline),
            (LYRICS_ENTITY_TYPE, LyricsTranscript),
        ):
            existing = by_entity.get((project.id, entity_type), [])
            if existing:
                active = [revision for revision in existing if revision.state in {CURRENT_REVISION_STATE, "current"}]
                if active:
                    winner = max(active, key=revision_lww_key)
                    _hydrate_current_entity_revisions(session, project, [_export_entity_revision_manifest(winner)])
                else:
                    row = session.get(model, project.id)
                    if row is not None:
                        session.delete(row)
                continue
            result = session.get(model, project.id)
            if result is None:
                continue
            if (project.id, entity_type) in deleted_results:
                session.delete(result)
                continue
            if isinstance(result, AnalysisResult):
                _recover_legacy_analysis_metadata(session, result)
                revision = record_analysis_revision(session, result, revision_type="backfill")
            elif isinstance(result, ChordTimeline):
                revision = record_chord_revision(session, result, revision_type="backfill")
                revision.created_at = result.created_at
                revision.updated_at = result.updated_at or result.created_at
            elif isinstance(result, LyricsTranscript):
                revision = record_lyrics_revision(session, result, revision_type="backfill")
                revision.created_at = result.created_at
                revision.updated_at = result.updated_at
    session.flush()


def _recover_legacy_analysis_metadata(session: Session, analysis: AnalysisResult) -> None:
    from pathlib import Path

    artifact = session.scalar(
        select(Artifact)
        .where(Artifact.project_id == analysis.project_id, Artifact.type == "analysis_json")
        .order_by(Artifact.updated_at.desc(), Artifact.id.desc())
    )
    metadata = dict(analysis.metadata_json or {})
    payload: dict[str, Any] = {}
    if artifact is not None:
        metadata = {**(artifact.metadata_json or {}), **metadata}
        try:
            raw = json.loads(Path(artifact.path).read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                payload = raw
        except OSError, ValueError:
            pass
    for key in (
        "analysis_generated_at",
        "analysis_backend",
        "analysis_version",
        "source_artifact_id",
        "source_artifact_sha256",
        "source_stem_artifact_ids",
        "source_stem_content_sha256s",
        "preprocessing",
    ):
        if key not in metadata and key in payload:
            metadata[key] = payload[key]
    generated_at = metadata.get("analysis_generated_at")
    try:
        recorded_at = datetime.fromisoformat(generated_at) if isinstance(generated_at, str) else None
    except ValueError:
        recorded_at = None
    analysis.updated_at = recorded_at or (artifact.updated_at if artifact is not None else analysis.created_at)
    analysis.metadata_json = sanitize_revision_payload(metadata)
    if analysis.source_artifact_id is None:
        source_id = metadata.get("source_artifact_id")
        source = session.get(Artifact, source_id) if isinstance(source_id, str) else None
        if source is not None and source.project_id == analysis.project_id:
            analysis.source_artifact_id = source.id


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
            "language_override": lyrics.language_override,
            "has_user_edits": lyrics.has_user_edits,
            "source_segments": lyrics.source_segments_json or [],
            "segments": lyrics.segments_json or [],
            "created_at": lyrics.created_at,
            "updated_at": lyrics.updated_at,
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
    independent_snapshot: bool = False,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> SyncEntityRevision:
    current_revision = current_entity_revision(session, project_id, entity_type, entity_id)
    resolved_base_revision_id = (
        base_revision_id
        if base_revision_id is not None
        else current_revision.id
        if current_revision is not None and not independent_snapshot
        else None
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
        created_at=created_at or now,
        updated_at=updated_at or now,
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


def revision_lww_key(revision: SyncEntityRevision) -> tuple[datetime, str, str]:
    return (_as_utc(revision.updated_at), revision.author_device_id, revision.id)


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
    return (
        normalized == "path"
        or normalized.endswith("_path")
        or compact.endswith("path")
        or compact
        in {
            "absolute_path",
            "local_path",
            "absolutepath",
            "localpath",
        }
    )


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
