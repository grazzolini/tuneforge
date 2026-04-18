from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Artifact
from app.utils.ids import new_id


def register_artifact(
    session: Session,
    *,
    project_id: str,
    artifact_type: str,
    artifact_format: str,
    path: Path,
    metadata: dict[str, Any] | None = None,
    cache_key: str | None = None,
) -> Artifact:
    artifact = Artifact(
        id=new_id("art"),
        project_id=project_id,
        type=artifact_type,
        format=artifact_format,
        path=str(path.resolve()),
        metadata_json=metadata or {},
        cache_key=cache_key,
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
        artifact_path = Path(artifact.path)
        session.delete(artifact)
        if artifact_path.exists():
            artifact_path.unlink(missing_ok=True)
