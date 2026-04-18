from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import AppError
from app.models import Project
from app.services.artifacts import register_artifact
from app.services.metadata import extract_audio_metadata, normalize_media_to_wav
from app.services.paths import ensure_project_dirs, project_root, project_source_dir
from app.utils.ids import new_id

NORMALIZED_IMPORT_FORMATS = {"mp4", "webm"}


def _validate_import_path(source_path: Path) -> None:
    settings = get_settings()
    suffix = source_path.suffix.lower().lstrip(".")
    if suffix not in settings.supported_import_formats:
        raise AppError(
            "UNSUPPORTED_AUDIO_FORMAT",
            f"Unsupported audio format: {suffix or 'unknown'}",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def list_projects(session: Session) -> list[Project]:
    stmt = select(Project).order_by(Project.updated_at.desc())
    return list(session.scalars(stmt))


def get_project(session: Session, project_id: str) -> Project:
    project = session.get(Project, project_id)
    if not project:
        raise AppError("PROJECT_NOT_FOUND", "Project not found.", status_code=status.HTTP_404_NOT_FOUND)
    return project


def import_project(
    session: Session,
    *,
    source_path: str,
    copy_into_project: bool,
    display_name: str | None,
) -> Project:
    resolved_source = Path(source_path).expanduser().resolve()
    _validate_import_path(resolved_source)
    metadata = extract_audio_metadata(resolved_source)

    project_id = new_id("proj")
    ensure_project_dirs(project_id)
    destination_name = resolved_source.name
    source_dir = project_source_dir(project_id)
    imported_path = source_dir / destination_name
    artifact_format = resolved_source.suffix.lower().lstrip(".")
    artifact_metadata = {"source_path": str(resolved_source)}

    if artifact_format in NORMALIZED_IMPORT_FORMATS:
        working_source = resolved_source
        if copy_into_project:
            original_copy_path = source_dir / destination_name
            shutil.copy2(resolved_source, original_copy_path)
            working_source = original_copy_path
            artifact_metadata["original_copy_path"] = str(original_copy_path)
        imported_path = source_dir / f"{resolved_source.stem}.wav"
        normalize_media_to_wav(working_source, imported_path)
        artifact_format = "wav"
        artifact_metadata["original_format"] = resolved_source.suffix.lower().lstrip(".")
    else:
        if copy_into_project:
            shutil.copy2(resolved_source, imported_path)
        else:
            imported_path = resolved_source

    project = Project(
        id=project_id,
        display_name=display_name or resolved_source.stem,
        source_path=str(resolved_source),
        imported_path=str(imported_path),
        duration_seconds=metadata["duration_seconds"],
        sample_rate=metadata["sample_rate"],
        channels=metadata["channels"],
    )
    session.add(project)
    session.flush()

    register_artifact(
        session,
        project_id=project.id,
        artifact_type="source_audio",
        artifact_format=artifact_format,
        path=Path(project.imported_path),
        metadata=artifact_metadata,
    )

    return project


def delete_project(session: Session, project_id: str) -> None:
    project = get_project(session, project_id)
    root = project_root(project.id)
    session.delete(project)
    session.flush()
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)


def rename_project(session: Session, project_id: str, *, display_name: str) -> Project:
    project = get_project(session, project_id)
    project.display_name = display_name.strip()
    session.flush()
    return project
