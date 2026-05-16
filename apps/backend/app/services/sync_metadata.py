from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Artifact, Project, SyncDeleteTombstone
from app.services.paths import project_root

LOCAL_METADATA_PATH_KEYS = {
    "path",
    "source_path",
    "original_copy_path",
    "playback_path",
    "imported_path",
}


@dataclass(frozen=True)
class SyncMetadataProject:
    project_id: str
    display_name: str
    source_key_override: str | None
    source_sha256: str | None
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class SyncMetadataArtifact:
    artifact_id: str
    project_id: str
    type: str
    format: str
    relative_path: str | None
    content_sha256: str | None
    size_bytes: int
    generated_by: str
    can_delete: bool
    can_regenerate: bool
    cache_key: str | None
    metadata: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True)
class SyncMetadataDeleteTombstone:
    tombstone_id: str
    sync_group_id: str
    project_id: str
    target_type: str
    target_id: str
    author_device_id: str
    deleted_at: datetime
    prior_metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class SyncMetadataResult:
    projects: list[SyncMetadataProject]
    artifacts: list[SyncMetadataArtifact]
    delete_tombstones: list[SyncMetadataDeleteTombstone]


def get_sync_metadata(session: Session) -> SyncMetadataResult:
    projects = list(session.scalars(select(Project).order_by(Project.created_at.asc(), Project.id.asc())))
    artifacts = list(
        session.scalars(
            select(Artifact).order_by(
                Artifact.project_id.asc(),
                Artifact.created_at.asc(),
                Artifact.id.asc(),
            )
        )
    )
    delete_tombstones = _list_delete_tombstones(session)

    return SyncMetadataResult(
        projects=[_project_metadata(project) for project in projects],
        artifacts=[_artifact_metadata(artifact) for artifact in artifacts],
        delete_tombstones=[
            _delete_tombstone_metadata(tombstone)
            for tombstone in delete_tombstones
        ],
    )


def _project_metadata(project: Project) -> SyncMetadataProject:
    return SyncMetadataProject(
        project_id=project.id,
        display_name=project.display_name,
        source_key_override=project.source_key_override,
        source_sha256=project.source_sha256,
        duration_seconds=project.duration_seconds,
        sample_rate=project.sample_rate,
        channels=project.channels,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _artifact_metadata(artifact: Artifact) -> SyncMetadataArtifact:
    return SyncMetadataArtifact(
        artifact_id=artifact.id,
        project_id=artifact.project_id,
        type=artifact.type,
        format=artifact.format,
        relative_path=_project_relative_artifact_path(artifact),
        content_sha256=artifact.content_sha256,
        size_bytes=artifact.size_bytes,
        generated_by=artifact.generated_by,
        can_delete=artifact.can_delete,
        can_regenerate=artifact.can_regenerate,
        cache_key=artifact.cache_key,
        metadata=_sanitize_metadata(artifact.metadata_json or {}),
        created_at=artifact.created_at,
    )


def _delete_tombstone_metadata(tombstone: SyncDeleteTombstone) -> SyncMetadataDeleteTombstone:
    return SyncMetadataDeleteTombstone(
        tombstone_id=tombstone.id,
        sync_group_id=tombstone.sync_group_id,
        project_id=tombstone.project_id,
        target_type=tombstone.target_type,
        target_id=tombstone.target_id,
        author_device_id=tombstone.author_device_id,
        deleted_at=tombstone.deleted_at,
        prior_metadata=cast_metadata(tombstone.prior_metadata_json),
        created_at=tombstone.created_at,
        updated_at=tombstone.updated_at,
    )


def project_relative_artifact_path(artifact: Artifact) -> str | None:
    return _project_relative_artifact_path(artifact)


def sanitize_sync_metadata(value: Any) -> Any:
    return _sanitize_metadata(value)


def cast_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], _sanitize_metadata(value))


def _list_delete_tombstones(session: Session) -> list[SyncDeleteTombstone]:
    return list(
        session.scalars(
            select(SyncDeleteTombstone).order_by(
                SyncDeleteTombstone.project_id.asc(),
                SyncDeleteTombstone.target_type.asc(),
                SyncDeleteTombstone.target_id.asc(),
                SyncDeleteTombstone.deleted_at.asc(),
                SyncDeleteTombstone.id.asc(),
            )
        )
    )


def _project_relative_artifact_path(artifact: Artifact) -> str | None:
    try:
        root = project_root(artifact.project_id).resolve(strict=False)
        artifact_path = Path(artifact.path).expanduser().resolve(strict=False)
        return artifact_path.relative_to(root).as_posix()
    except (OSError, RuntimeError, ValueError):
        return None


def _sanitize_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _sanitize_metadata(child)
            for key, child in value.items()
            if not _is_local_path_key(key)
        }
    if isinstance(value, list):
        return [_sanitize_metadata(child) for child in value]
    return value


def _is_local_path_key(key: object) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.lower()
    if normalized == "relative_path":
        return False
    return normalized in LOCAL_METADATA_PATH_KEYS or normalized.endswith("_path")
