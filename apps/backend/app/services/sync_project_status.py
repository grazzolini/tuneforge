from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Artifact, Project, utcnow
from app.utils.hashing import file_sha256

SYNC_PROJECT_STATUSES = {
    "local",
    "syncing",
    "remote_available",
    "downloading",
    "missing",
    "deleted",
    "conflicted",
}
LOCAL_SYNC_STATUS = "local"
SyncProjectStatus = Literal[
    "local",
    "syncing",
    "remote_available",
    "downloading",
    "missing",
    "deleted",
    "conflicted",
]


def sync_editable_for_status(sync_status: str | None) -> bool:
    return (sync_status or LOCAL_SYNC_STATUS) == LOCAL_SYNC_STATUS


def project_sync_editable(project: Project) -> bool:
    return sync_editable_for_status(project.sync_status)


def require_project_sync_editable(project: Project) -> None:
    if project_sync_editable(project):
        return
    raise AppError(
        "PROJECT_SYNC_LOCKED",
        "Project is still syncing and cannot be edited.",
        status_code=status.HTTP_409_CONFLICT,
        details=project_sync_lock_details(project),
    )


def project_sync_lock_details(project: Project) -> dict[str, Any]:
    return {
        "project_id": project.id,
        "sync_status": project.sync_status,
        "sync_status_reason": project.sync_status_reason,
        "sync_required_artifact_ids": project.sync_required_artifact_ids,
        "sync_provider_device_ids": project.sync_provider_device_ids,
        "sync_conflict_count": project.sync_conflict_count,
    }


def update_project_sync_status(
    session: Session,
    *,
    project_id: str,
    sync_status: str,
    sync_status_reason: str | None = None,
    sync_required_artifact_ids: Sequence[str] | None = None,
    sync_provider_device_ids: Sequence[str] | None = None,
    sync_conflict_count: int | None = None,
    manifest: object | Mapping[str, Any] | None = None,
) -> Project:
    normalized_status = _normalize_sync_status(sync_status)
    project = session.get(Project, project_id)
    if project is None:
        if manifest is None:
            raise AppError(
                "SYNC_PROJECT_STATUS_MANIFEST_REQUIRED",
                "A project manifest is required to create a sync project placeholder.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        project = _project_placeholder_from_manifest(project_id=project_id, manifest=manifest)
        session.add(project)
        session.flush()

    required_artifact_ids = _normalize_string_list(sync_required_artifact_ids)
    provider_device_ids = _normalize_string_list(sync_provider_device_ids)
    conflict_count = 0 if sync_conflict_count is None else max(sync_conflict_count, 0)

    if normalized_status == LOCAL_SYNC_STATUS:
        _require_local_project_bytes_verified(
            session,
            project=project,
            required_artifact_ids=required_artifact_ids or project.sync_required_artifact_ids,
        )
        _set_project_sync_fields(
            project,
            sync_status=LOCAL_SYNC_STATUS,
            sync_status_reason=None,
            sync_required_artifact_ids=[],
            sync_provider_device_ids=[],
            sync_conflict_count=0,
        )
    else:
        _set_project_sync_fields(
            project,
            sync_status=normalized_status,
            sync_status_reason=_normalize_reason(sync_status_reason),
            sync_required_artifact_ids=required_artifact_ids,
            sync_provider_device_ids=provider_device_ids,
            sync_conflict_count=conflict_count,
        )

    session.flush()
    return project


def mark_project_sync_local(session: Session, project: Project) -> Project:
    _require_local_project_bytes_verified(
        session,
        project=project,
        required_artifact_ids=project.sync_required_artifact_ids,
    )
    _set_project_sync_fields(
        project,
        sync_status=LOCAL_SYNC_STATUS,
        sync_status_reason=None,
        sync_required_artifact_ids=[],
        sync_provider_device_ids=[],
        sync_conflict_count=0,
    )
    session.flush()
    return project


def _set_project_sync_fields(
    project: Project,
    *,
    sync_status: str,
    sync_status_reason: str | None,
    sync_required_artifact_ids: list[str],
    sync_provider_device_ids: list[str],
    sync_conflict_count: int,
) -> None:
    project.sync_status = sync_status
    project.sync_status_reason = sync_status_reason
    project.sync_required_artifact_ids_json = sync_required_artifact_ids
    project.sync_provider_device_ids_json = sync_provider_device_ids
    project.sync_conflict_count = sync_conflict_count
    project.sync_status_updated_at = utcnow()


def _normalize_sync_status(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in SYNC_PROJECT_STATUSES:
        raise AppError(
            "SYNC_PROJECT_STATUS_INVALID",
            "Project sync status is not supported.",
            status_code=status.HTTP_400_BAD_REQUEST,
            details={"sync_status": value, "supported_statuses": sorted(SYNC_PROJECT_STATUSES)},
        )
    return normalized


def _normalize_string_list(values: Sequence[str] | None) -> list[str]:
    if values is None:
        return []
    normalized = []
    seen = set()
    for value in values:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        normalized.append(cleaned)
        seen.add(cleaned)
    return normalized


def _normalize_reason(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _project_placeholder_from_manifest(
    *,
    project_id: str,
    manifest: object | Mapping[str, Any],
) -> Project:
    project_payload = _field(manifest, "project", default=manifest)
    manifest_project_id = _required_string(project_payload, "project_id")
    if manifest_project_id != project_id:
        raise AppError(
            "SYNC_PROJECT_STATUS_MANIFEST_MISMATCH",
            "Project manifest does not match the requested project.",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id, "manifest_project_id": manifest_project_id},
        )

    now = utcnow()
    created_at = _datetime_field(project_payload, "created_at") or now
    updated_at = _datetime_field(project_payload, "updated_at") or now
    return Project(
        id=project_id,
        display_name=_required_string(project_payload, "display_name"),
        source_key_override=_string_field(project_payload, "source_key_override"),
        source_sha256=_string_field(project_payload, "source_sha256"),
        source_path="",
        imported_path="",
        duration_seconds=_float_or_none(_field(project_payload, "duration_seconds")),
        sample_rate=_int_or_none(_field(project_payload, "sample_rate")),
        channels=_int_or_none(_field(project_payload, "channels")),
        created_at=created_at,
        updated_at=updated_at,
    )


def _require_local_project_bytes_verified(
    session: Session,
    *,
    project: Project,
    required_artifact_ids: Sequence[str],
) -> None:
    artifact_ids = _normalize_string_list(required_artifact_ids)
    if not artifact_ids:
        source_artifact = session.scalar(
            select(Artifact)
            .where(Artifact.project_id == project.id)
            .where(Artifact.type == "source_audio")
            .order_by(Artifact.created_at.asc(), Artifact.id.asc())
        )
        if source_artifact is None:
            raise _local_bytes_error(project.id, ["source_audio"])
        _verify_artifact_file(source_artifact)
        return

    missing: list[str] = []
    for artifact_id in artifact_ids:
        artifact = session.get(Artifact, artifact_id)
        if artifact is None or artifact.project_id != project.id:
            missing.append(artifact_id)
            continue
        try:
            _verify_artifact_file(artifact)
        except AppError:
            missing.append(artifact_id)
    if missing:
        raise _local_bytes_error(project.id, missing)


def _verify_artifact_file(artifact: Artifact) -> None:
    path = Path(artifact.path).expanduser().resolve(strict=False)
    if not path.exists():
        raise _local_bytes_error(artifact.project_id, [artifact.id])
    if artifact.size_bytes != path.stat().st_size:
        raise _local_bytes_error(artifact.project_id, [artifact.id])
    if artifact.content_sha256:
        actual_sha256 = file_sha256(path)
        if actual_sha256 != artifact.content_sha256:
            raise _local_bytes_error(artifact.project_id, [artifact.id])


def _local_bytes_error(project_id: str, missing_artifact_ids: Sequence[str]) -> AppError:
    return AppError(
        "SYNC_PROJECT_STATUS_LOCAL_BYTES_UNVERIFIED",
        "Project cannot be marked local until required artifact bytes are verified.",
        status_code=status.HTTP_409_CONFLICT,
        details={"project_id": project_id, "required_artifact_ids": list(missing_artifact_ids)},
    )


def _field(source: object, name: str, *, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def _required_string(source: object, name: str) -> str:
    value = _string_field(source, name)
    if value is None:
        raise AppError(
            "SYNC_PROJECT_STATUS_MANIFEST_INVALID",
            "Project manifest is missing required placeholder metadata.",
            status_code=status.HTTP_400_BAD_REQUEST,
            details={"field": name},
        )
    return value


def _string_field(source: object, name: str) -> str | None:
    value = _field(source, name)
    return value if isinstance(value, str) else None


def _datetime_field(source: object, name: str) -> datetime | None:
    value = _field(source, name)
    return value if isinstance(value, datetime) else None


def _float_or_none(value: object) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    return None


def _int_or_none(value: object) -> int | None:
    if isinstance(value, int):
        return value
    return None
