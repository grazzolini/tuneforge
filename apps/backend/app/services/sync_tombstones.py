from __future__ import annotations

import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Artifact, Project, SyncDeleteTombstone, SyncEntityRevision, utcnow
from app.services.paths import project_root
from app.services.sync_revisions import sanitize_revision_payload
from app.services.sync_trust import get_or_create_local_identity
from app.utils.ids import new_id

PROJECT_TARGET_TYPE = "project"
ARTIFACT_TARGET_TYPE = "artifact"
ENTITY_REVISION_TARGET_TYPE = "entity_revision"


def record_project_delete_tombstone(session: Session, project: Project) -> SyncDeleteTombstone:
    return _record_delete_tombstone(
        session,
        project_id=project.id,
        target_type=PROJECT_TARGET_TYPE,
        target_id=project.id,
        prior_metadata={
            "project_id": project.id,
            "display_name": project.display_name,
            "source_sha256": project.source_sha256,
            "duration_seconds": project.duration_seconds,
            "sample_rate": project.sample_rate,
            "channels": project.channels,
            "created_at": project.created_at,
            "updated_at": project.updated_at,
        },
    )


def record_artifact_delete_tombstone(session: Session, artifact: Artifact) -> SyncDeleteTombstone:
    return _record_delete_tombstone(
        session,
        project_id=artifact.project_id,
        target_type=ARTIFACT_TARGET_TYPE,
        target_id=artifact.id,
        prior_metadata={
            "artifact_id": artifact.id,
            "project_id": artifact.project_id,
            "type": artifact.type,
            "format": artifact.format,
            "content_sha256": artifact.content_sha256,
            "size_bytes": artifact.size_bytes,
            "generated_by": artifact.generated_by,
            "can_delete": artifact.can_delete,
            "can_regenerate": artifact.can_regenerate,
            "metadata": artifact.metadata_json or {},
            "cache_key": artifact.cache_key,
            "created_at": artifact.created_at,
        },
    )


def record_entity_revision_delete_tombstone(
    session: Session,
    revision: SyncEntityRevision,
) -> SyncDeleteTombstone:
    return _record_delete_tombstone(
        session,
        project_id=revision.project_id,
        target_type=ENTITY_REVISION_TARGET_TYPE,
        target_id=revision.id,
        prior_metadata={
            "revision_id": revision.id,
            "project_id": revision.project_id,
            "entity_type": revision.entity_type,
            "entity_id": revision.entity_id,
            "revision_type": revision.revision_type,
            "base_revision_id": revision.base_revision_id,
            "source_artifact_id": revision.source_artifact_id,
            "content_sha256": revision.content_sha256,
            "author_device_id": revision.author_device_id,
            "state": revision.state,
            "metadata": revision.metadata_json or {},
            "payload": revision.payload_json or {},
            "created_at": revision.created_at,
            "updated_at": revision.updated_at,
        },
    )


def apply_delete_tombstone(session: Session, tombstone: SyncDeleteTombstone) -> None:
    if tombstone.target_type == PROJECT_TARGET_TYPE:
        project = session.get(Project, tombstone.target_id)
        if project is None or project.id != tombstone.project_id:
            return
        root = project_root(project.id)
        session.delete(project)
        session.flush()
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        return

    if tombstone.target_type == ARTIFACT_TARGET_TYPE:
        artifact = session.get(Artifact, tombstone.target_id)
        if artifact is None or artifact.project_id != tombstone.project_id:
            return
        artifact_path = Path(artifact.path)
        session.delete(artifact)
        _cleanup_artifact_path(artifact_path)
        session.flush()
        return

    if tombstone.target_type == ENTITY_REVISION_TARGET_TYPE:
        revision = session.get(SyncEntityRevision, tombstone.target_id)
        if revision is None or revision.project_id != tombstone.project_id:
            return
        session.delete(revision)
        session.flush()


def _record_delete_tombstone(
    session: Session,
    *,
    project_id: str,
    target_type: str,
    target_id: str,
    prior_metadata: Mapping[str, Any],
) -> SyncDeleteTombstone:
    identity = get_or_create_local_identity(session)
    existing = session.scalar(
        select(SyncDeleteTombstone).where(
            SyncDeleteTombstone.sync_group_id == identity.sync_group_id,
            SyncDeleteTombstone.target_type == target_type,
            SyncDeleteTombstone.target_id == target_id,
        )
    )
    now = utcnow()
    sanitized_metadata = sanitize_revision_payload(prior_metadata)
    if existing is not None:
        existing.project_id = project_id
        existing.author_device_id = identity.device_id
        existing.prior_metadata_json = sanitized_metadata
        existing.updated_at = now
        session.flush()
        return existing

    tombstone = SyncDeleteTombstone(
        id=new_id("del"),
        sync_group_id=identity.sync_group_id,
        project_id=project_id,
        target_type=target_type,
        target_id=target_id,
        author_device_id=identity.device_id,
        deleted_at=now,
        prior_metadata_json=sanitized_metadata,
        created_at=now,
        updated_at=now,
    )
    session.add(tombstone)
    session.flush()
    return tombstone


def _cleanup_artifact_path(path: Path) -> None:
    if path.exists():
        path.unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass
