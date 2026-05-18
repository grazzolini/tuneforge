from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import AppError
from app.models import Project
from app.services.artifacts import register_artifact
from app.services.metadata import extract_audio_metadata, normalize_media_to_wav
from app.services.paths import ensure_project_dirs, project_root, project_source_dir
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_revisions import record_project_metadata_revision
from app.utils.hashing import file_sha256

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


def list_projects(session: Session, *, search: str | None = None) -> list[Project]:
    stmt = select(Project)
    normalized_search = (search or "").strip().lower()
    if normalized_search:
        like_term = f"%{normalized_search}%"
        stmt = stmt.where(
            or_(
                func.lower(Project.display_name).like(like_term),
                func.lower(Project.source_path).like(like_term),
                func.lower(Project.imported_path).like(like_term),
            )
        )

    stmt = stmt.order_by(Project.updated_at.desc())
    return list(session.scalars(stmt))


def get_project(session: Session, project_id: str) -> Project:
    project = session.get(Project, project_id)
    if not project:
        raise AppError("PROJECT_NOT_FOUND", "Project not found.", status_code=status.HTTP_404_NOT_FOUND)
    return project


def _duplicate_project_source_error(project_id: str, project_name: str) -> AppError:
    return AppError(
        "DUPLICATE_PROJECT_SOURCE",
        f'This project is already imported with name "{project_name}".',
        status_code=status.HTTP_409_CONFLICT,
        details={"project_id": project_id, "project_name": project_name},
    )


def _find_existing_source_project(
    session: Session,
    *,
    project_id: str,
    source_sha256: str,
) -> Project | None:
    existing_project = session.get(Project, project_id)
    if existing_project is not None:
        return existing_project
    return session.scalar(
        select(Project)
        .where(Project.source_sha256 == source_sha256)
        .order_by(Project.created_at.asc(), Project.id.asc())
    )


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
    source_sha256 = file_sha256(resolved_source)
    if source_sha256 is None:
        raise AppError(
            "SOURCE_HASH_UNAVAILABLE",
            "Could not compute a source hash for this file.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    project_id = source_hash_to_project_id(source_sha256)
    existing_project = _find_existing_source_project(
        session,
        project_id=project_id,
        source_sha256=source_sha256,
    )
    if existing_project is not None:
        raise _duplicate_project_source_error(existing_project.id, existing_project.display_name)

    destination_name = resolved_source.name
    source_dir = project_source_dir(project_id)
    imported_path = source_dir / destination_name
    artifact_format = resolved_source.suffix.lower().lstrip(".")
    artifact_metadata = {"source_path": str(resolved_source)}
    needs_normalization = artifact_format in NORMALIZED_IMPORT_FORMATS
    fallback_project_name = display_name or resolved_source.stem

    if needs_normalization:
        if copy_into_project:
            original_copy_path = source_dir / destination_name
            artifact_metadata["original_copy_path"] = str(original_copy_path)
        imported_path = source_dir / f"{resolved_source.stem}.wav"
        artifact_format = "wav"
        artifact_metadata["original_format"] = resolved_source.suffix.lower().lstrip(".")

    project = Project(
        id=project_id,
        display_name=fallback_project_name,
        source_sha256=source_sha256,
        source_path=str(resolved_source),
        imported_path=str(imported_path),
        duration_seconds=metadata["duration_seconds"],
        sample_rate=metadata["sample_rate"],
        channels=metadata["channels"],
    )
    session.add(project)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        existing_project = _find_existing_source_project(
            session,
            project_id=project_id,
            source_sha256=source_sha256,
        )
        if existing_project is not None:
            raise _duplicate_project_source_error(existing_project.id, existing_project.display_name) from exc
        raise _duplicate_project_source_error(project_id, fallback_project_name) from exc

    ensure_project_dirs(project_id)
    if needs_normalization:
        working_source = resolved_source
        if copy_into_project:
            original_copy_path = source_dir / destination_name
            shutil.copy2(resolved_source, original_copy_path)
            working_source = original_copy_path
        normalize_media_to_wav(working_source, imported_path)
    else:
        shutil.copy2(resolved_source, imported_path)

    register_artifact(
        session,
        project_id=project.id,
        artifact_type="source_audio",
        artifact_format=artifact_format,
        path=Path(project.imported_path),
        metadata=artifact_metadata,
        generated_by="import",
        can_delete=False,
        can_regenerate=False,
    )

    return project


def delete_project(session: Session, project_id: str) -> None:
    project = get_project(session, project_id)
    root = project_root(project.id)
    session.delete(project)
    session.flush()
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)


def update_project(session: Session, project_id: str, *, updates: dict[str, str | None]) -> Project:
    project = get_project(session, project_id)
    metadata_changed = False
    if "display_name" in updates:
        display_name = updates["display_name"]
        if display_name is not None:
            normalized_display_name = display_name.strip()
            if project.display_name != normalized_display_name:
                project.display_name = normalized_display_name
                metadata_changed = True
    if "source_key_override" in updates:
        source_key_override = updates["source_key_override"]
        normalized_source_key_override = (
            source_key_override.strip() if isinstance(source_key_override, str) else None
        )
        if project.source_key_override != normalized_source_key_override:
            project.source_key_override = normalized_source_key_override
            metadata_changed = True
    session.flush()
    if metadata_changed:
        record_project_metadata_revision(session, project=project, revision_type="metadata_change")
    return project
