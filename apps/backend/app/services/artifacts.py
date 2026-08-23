from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Artifact, Job
from app.services.project_storage import queue_project_storage_reconciliation
from app.services.stem_models import STEM_ARTIFACT_TYPES
from app.services.sync_tombstones import record_artifact_delete_tombstone
from app.utils.hashing import file_sha256
from app.utils.ids import new_artifact_id

REGENERABLE_ARTIFACT_TYPES = {
    "analysis_json",
    "lyrics",
    "preview_mix",
    "waveform_cache",
} | STEM_ARTIFACT_TYPES


def _artifact_size_bytes(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def refresh_artifact_file_metadata(artifact: Artifact, path: Path) -> None:
    resolved_path = path.resolve()
    artifact.path = str(resolved_path)
    artifact.size_bytes = _artifact_size_bytes(resolved_path)
    artifact.content_sha256 = file_sha256(resolved_path)


def register_artifact(
    session: Session,
    *,
    project_id: str,
    artifact_type: str,
    artifact_format: str,
    path: Path,
    artifact_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    cache_key: str | None = None,
    generated_by: str = "unknown",
    can_delete: bool | None = None,
    can_regenerate: bool | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> Artifact:
    resolved_path = path.resolve()
    artifact_kwargs: dict[str, Any] = {}
    if created_at is not None:
        artifact_kwargs["created_at"] = created_at
    if updated_at is not None:
        artifact_kwargs["updated_at"] = updated_at
    artifact = Artifact(
        id=artifact_id or new_artifact_id(),
        project_id=project_id,
        type=artifact_type,
        format=artifact_format,
        path=str(resolved_path),
        content_sha256=file_sha256(resolved_path),
        size_bytes=_artifact_size_bytes(resolved_path),
        generated_by=generated_by,
        can_delete=artifact_type != "source_audio" if can_delete is None else can_delete,
        can_regenerate=(
            artifact_type in REGENERABLE_ARTIFACT_TYPES if can_regenerate is None else can_regenerate
        ),
        metadata_json=metadata or {},
        cache_key=cache_key,
        **artifact_kwargs,
    )
    session.add(artifact)
    session.flush()
    return artifact


def find_cached_artifact(session: Session, *, cache_key: str) -> Artifact | None:
    stmt = select(Artifact).where(Artifact.cache_key == cache_key)
    artifact = session.scalar(stmt)
    if artifact and Path(artifact.path).exists():
        return artifact
    return None


def prune_project_artifacts(
    session: Session,
    *,
    project_id: str,
    artifact_type: str,
    keep_artifact_id: str,
) -> None:
    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.type == artifact_type,
        Artifact.id != keep_artifact_id,
    )
    for artifact in session.scalars(stmt):
        session.delete(artifact)
    queue_project_storage_reconciliation(session, project_id)


def _has_pending_audio_job(session: Session, *, project_id: str) -> bool:
    pending_audio_job_types = ("chords", "stems", "export")
    stmt = select(Job.id).where(
        Job.project_id == project_id,
        Job.type.in_(pending_audio_job_types),
        Job.status.in_(("pending", "running")),
    )
    return session.scalar(stmt) is not None


def delete_project_artifact(session: Session, *, project_id: str, artifact_id: str) -> None:
    from app.services.projects import get_mutable_project

    get_mutable_project(session, project_id)
    artifact = session.get(Artifact, artifact_id)
    if artifact is None or artifact.project_id != project_id:
        raise AppError("ARTIFACT_NOT_FOUND", "Artifact does not belong to this project.", status_code=404)
    if artifact.type == "source_audio":
        raise AppError("INVALID_REQUEST", "Source audio cannot be deleted from a project.")
    if artifact.type in STEM_ARTIFACT_TYPES and _has_pending_audio_job(session, project_id=project_id):
        raise AppError(
            "ARTIFACT_BUSY",
            "Stem artifacts cannot be deleted while chord, stem, or export jobs are pending or running.",
            status_code=409,
        )
    if artifact.type == "preview_mix" and _has_pending_audio_job(session, project_id=project_id):
        raise AppError(
            "ARTIFACT_BUSY",
            "Practice mixes cannot be deleted while chord, stem, or export jobs are pending or running.",
            status_code=409,
        )
    if artifact.type in STEM_ARTIFACT_TYPES:
        record_artifact_delete_tombstone(session, artifact)
        session.delete(artifact)
        queue_project_storage_reconciliation(session, project_id)
        return
    if artifact.type != "preview_mix":
        raise AppError("INVALID_REQUEST", "Only saved practice mixes and stem tracks can be deleted.")

    stmt = select(Artifact).where(
        Artifact.project_id == project_id,
        Artifact.type.in_(tuple(STEM_ARTIFACT_TYPES)),
    )
    related_stems = [
        stem
        for stem in session.scalars(stmt)
        if stem.metadata_json.get("source_artifact_id") == artifact.id
    ]

    for stem in related_stems:
        record_artifact_delete_tombstone(session, stem)
        session.delete(stem)

    record_artifact_delete_tombstone(session, artifact)
    session.delete(artifact)
    queue_project_storage_reconciliation(session, project_id)
