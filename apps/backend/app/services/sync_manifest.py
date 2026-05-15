from __future__ import annotations

import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, cast

from fastapi import status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Artifact, Project
from app.services.artifacts import register_artifact
from app.services.paths import ensure_project_dirs, project_root
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_metadata import project_relative_artifact_path, sanitize_sync_metadata
from app.utils.hashing import file_sha256

SYNC_PROJECT_MANIFEST_SCHEMA_VERSION = "1"


@dataclass(frozen=True)
class SyncArtifactManifest:
    artifact_id: str
    project_id: str
    type: str
    format: str
    relative_path: str
    content_sha256: str
    size_bytes: int
    generated_by: str
    can_delete: bool
    can_regenerate: bool
    cache_key: str | None
    metadata: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True)
class SyncProjectManifestProject:
    project_id: str
    display_name: str
    source_key_override: str | None
    source_sha256: str
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class SyncProjectManifest:
    schema_version: str
    exported_at: datetime
    project: SyncProjectManifestProject
    artifacts: list[SyncArtifactManifest]

    @property
    def project_id(self) -> str:
        return self.project.project_id

    @property
    def display_name(self) -> str:
        return self.project.display_name

    @property
    def source_key_override(self) -> str | None:
        return self.project.source_key_override

    @property
    def source_sha256(self) -> str:
        return self.project.source_sha256

    @property
    def duration_seconds(self) -> float | None:
        return self.project.duration_seconds

    @property
    def sample_rate(self) -> int | None:
        return self.project.sample_rate

    @property
    def channels(self) -> int | None:
        return self.project.channels

    @property
    def created_at(self) -> datetime:
        return self.project.created_at

    @property
    def updated_at(self) -> datetime:
        return self.project.updated_at


@dataclass(frozen=True)
class _VerifiedStagedArtifact:
    manifest: SyncArtifactManifest
    staged_path: Path
    destination_path: Path


def export_project_manifest(session: Session, project_id: str) -> SyncProjectManifest:
    project = session.get(Project, project_id)
    if project is None:
        raise AppError(
            "SYNC_MANIFEST_PROJECT_NOT_FOUND",
            "Project not found for sync manifest export.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    source_sha256 = _required_source_sha256(project)
    artifacts = list(
        session.scalars(
            select(Artifact)
            .where(Artifact.project_id == project.id)
            .order_by(Artifact.created_at.asc(), Artifact.id.asc())
        )
    )

    manifest = SyncProjectManifest(
        schema_version=SYNC_PROJECT_MANIFEST_SCHEMA_VERSION,
        exported_at=datetime.now(UTC),
        project=SyncProjectManifestProject(
            project_id=project.id,
            display_name=project.display_name,
            source_key_override=project.source_key_override,
            source_sha256=source_sha256,
            duration_seconds=project.duration_seconds,
            sample_rate=project.sample_rate,
            channels=project.channels,
            created_at=project.created_at,
            updated_at=project.updated_at,
        ),
        artifacts=[_export_artifact_manifest(artifact) for artifact in artifacts],
    )
    _validate_source_artifact_matches_project_source(manifest)
    return manifest


def import_staged_project_manifest(
    session: Session,
    *,
    manifest: SyncProjectManifest | Mapping[str, Any] | object,
    staging_root: Path | str,
) -> Project:
    project_manifest = _coerce_project_manifest(manifest)
    _validate_project_manifest_schema_version(project_manifest)
    _validate_project_manifest_identity(project_manifest)
    _validate_source_artifact_matches_project_source(project_manifest)
    _reject_duplicate_project_source(session, project_manifest)
    root = project_root(project_manifest.project_id).resolve(strict=False)
    staged_root = Path(staging_root).expanduser().resolve(strict=False)
    verified_artifacts = _verify_staged_artifacts(project_manifest, staging_root=staged_root, project_root_path=root)
    source_artifact = _source_artifact_manifest(project_manifest)
    source_path = root / _safe_relative_path(source_artifact.relative_path)

    project = Project(
        id=project_manifest.project_id,
        display_name=project_manifest.display_name,
        source_key_override=project_manifest.source_key_override,
        source_sha256=project_manifest.source_sha256,
        source_path=str(source_path),
        imported_path=str(source_path),
        duration_seconds=project_manifest.duration_seconds,
        sample_rate=project_manifest.sample_rate,
        channels=project_manifest.channels,
        created_at=project_manifest.created_at,
        updated_at=project_manifest.updated_at,
    )
    session.add(project)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        _raise_duplicate_project_source(session, project_manifest.project_id, project_manifest.source_sha256, exc)

    ensure_project_dirs(project.id)
    copied_paths: list[Path] = []
    try:
        for verified_artifact in verified_artifacts:
            verified_artifact.destination_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(verified_artifact.staged_path, verified_artifact.destination_path)
            copied_paths.append(verified_artifact.destination_path)
        for verified_artifact in verified_artifacts:
            imported_artifact = register_artifact(
                session,
                project_id=project.id,
                artifact_type=verified_artifact.manifest.type,
                artifact_format=verified_artifact.manifest.format,
                path=verified_artifact.destination_path,
                artifact_id=verified_artifact.manifest.artifact_id,
                metadata=verified_artifact.manifest.metadata,
                cache_key=verified_artifact.manifest.cache_key,
                generated_by=verified_artifact.manifest.generated_by,
                can_delete=verified_artifact.manifest.can_delete,
                can_regenerate=verified_artifact.manifest.can_regenerate,
                created_at=verified_artifact.manifest.created_at,
            )
            if (
                imported_artifact.content_sha256 != verified_artifact.manifest.content_sha256
                or imported_artifact.size_bytes != verified_artifact.manifest.size_bytes
            ):
                raise AppError(
                    "SYNC_MANIFEST_IMPORTED_FILE_MISMATCH",
                    "A copied artifact file does not match its manifest.",
                    details={"artifact_id": verified_artifact.manifest.artifact_id},
                )
    except OSError as exc:
        _cleanup_copied_artifacts(copied_paths, root)
        raise AppError(
            "SYNC_MANIFEST_COPY_FAILED",
            "A staged artifact could not be copied into the local project store.",
        ) from exc
    except AppError:
        _cleanup_copied_artifacts(copied_paths, root)
        raise
    except IntegrityError as exc:
        _cleanup_copied_artifacts(copied_paths, root)
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_CONFLICT",
            "A synced artifact conflicts with an existing local artifact.",
            status_code=status.HTTP_409_CONFLICT,
        ) from exc
    except Exception:
        _cleanup_copied_artifacts(copied_paths, root)
        raise

    return project


def _export_artifact_manifest(artifact: Artifact) -> SyncArtifactManifest:
    relative_path = project_relative_artifact_path(artifact)
    if relative_path is None:
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_PATH_MISSING",
            "Artifact cannot be exported because it is not stored under the project root.",
            details={"artifact_id": artifact.id, "project_id": artifact.project_id},
        )
    if artifact.content_sha256 is None:
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_HASH_MISSING",
            "Artifact cannot be exported because it is missing a content SHA-256.",
            details={"artifact_id": artifact.id, "project_id": artifact.project_id},
        )

    artifact_path = Path(artifact.path).expanduser().resolve(strict=False)
    actual_size = _file_size(artifact_path)
    if actual_size is None:
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_FILE_UNREADABLE",
            "Artifact cannot be exported because its file is not readable.",
            details={"artifact_id": artifact.id, "project_id": artifact.project_id},
        )
    if actual_size != artifact.size_bytes:
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_SIZE_MISMATCH",
            "Artifact cannot be exported because its file size no longer matches metadata.",
            details={
                "artifact_id": artifact.id,
                "project_id": artifact.project_id,
                "expected_size_bytes": artifact.size_bytes,
                "actual_size_bytes": actual_size,
            },
        )

    actual_sha256 = file_sha256(artifact_path)
    if actual_sha256 is None:
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_FILE_UNREADABLE",
            "Artifact cannot be exported because its file is not readable.",
            details={"artifact_id": artifact.id, "project_id": artifact.project_id},
        )
    if actual_sha256 != artifact.content_sha256:
        raise AppError(
            "SYNC_MANIFEST_ARTIFACT_HASH_MISMATCH",
            "Artifact cannot be exported because its content SHA-256 no longer matches metadata.",
            details={
                "artifact_id": artifact.id,
                "project_id": artifact.project_id,
                "expected_sha256": artifact.content_sha256,
                "actual_sha256": actual_sha256,
            },
        )

    return SyncArtifactManifest(
        artifact_id=artifact.id,
        project_id=artifact.project_id,
        type=artifact.type,
        format=artifact.format,
        relative_path=relative_path,
        content_sha256=artifact.content_sha256,
        size_bytes=artifact.size_bytes,
        generated_by=artifact.generated_by,
        can_delete=artifact.can_delete,
        can_regenerate=artifact.can_regenerate,
        cache_key=artifact.cache_key,
        metadata=cast(dict[str, Any], sanitize_sync_metadata(artifact.metadata_json or {})),
        created_at=artifact.created_at,
    )


def _verify_staged_artifacts(
    manifest: SyncProjectManifest,
    *,
    staging_root: Path,
    project_root_path: Path,
) -> list[_VerifiedStagedArtifact]:
    verified: list[_VerifiedStagedArtifact] = []
    destination_paths: set[Path] = set()
    artifact_ids: set[str] = set()

    for artifact in manifest.artifacts:
        if artifact.project_id != manifest.project_id:
            raise AppError(
                "SYNC_MANIFEST_ARTIFACT_PROJECT_MISMATCH",
                "Artifact manifest belongs to a different project.",
                details={"artifact_id": artifact.artifact_id, "project_id": artifact.project_id},
            )
        if artifact.artifact_id in artifact_ids:
            raise AppError(
                "SYNC_MANIFEST_DUPLICATE_ARTIFACT",
                "Project manifest contains duplicate artifact IDs.",
                details={"artifact_id": artifact.artifact_id},
            )
        artifact_ids.add(artifact.artifact_id)

        relative_path = _safe_relative_path(artifact.relative_path)
        staged_path = (staging_root / relative_path).resolve(strict=False)
        destination_path = (project_root_path / relative_path).resolve(strict=False)
        _ensure_child_path(staging_root, staged_path, "staged artifact")
        _ensure_child_path(project_root_path, destination_path, "destination artifact")
        if destination_path in destination_paths:
            raise AppError(
                "SYNC_MANIFEST_DUPLICATE_ARTIFACT_PATH",
                "Project manifest contains duplicate artifact relative paths.",
                details={"relative_path": artifact.relative_path},
            )
        destination_paths.add(destination_path)
        if destination_path.exists():
            raise AppError(
                "SYNC_MANIFEST_DESTINATION_EXISTS",
                "A synced artifact destination already exists.",
                status_code=status.HTTP_409_CONFLICT,
                details={"relative_path": artifact.relative_path},
            )

        _verify_staged_file(artifact, staged_path)
        verified.append(
            _VerifiedStagedArtifact(
                manifest=artifact,
                staged_path=staged_path,
                destination_path=destination_path,
            )
        )

    return verified


def _verify_staged_file(artifact: SyncArtifactManifest, staged_path: Path) -> None:
    actual_size = _file_size(staged_path)
    if actual_size is None:
        raise AppError(
            "SYNC_MANIFEST_STAGED_FILE_MISSING",
            "A staged artifact file is missing or unreadable.",
            details={"artifact_id": artifact.artifact_id, "relative_path": artifact.relative_path},
        )
    if actual_size != artifact.size_bytes:
        raise AppError(
            "SYNC_MANIFEST_STAGED_FILE_SIZE_MISMATCH",
            "A staged artifact file size does not match its manifest.",
            details={
                "artifact_id": artifact.artifact_id,
                "relative_path": artifact.relative_path,
                "expected_size_bytes": artifact.size_bytes,
                "actual_size_bytes": actual_size,
            },
        )

    actual_sha256 = file_sha256(staged_path)
    if actual_sha256 != artifact.content_sha256:
        raise AppError(
            "SYNC_MANIFEST_STAGED_FILE_HASH_MISMATCH",
            "A staged artifact file SHA-256 does not match its manifest.",
            details={
                "artifact_id": artifact.artifact_id,
                "relative_path": artifact.relative_path,
                "expected_sha256": artifact.content_sha256,
                "actual_sha256": actual_sha256,
            },
        )


def _source_artifact_manifest(manifest: SyncProjectManifest) -> SyncArtifactManifest:
    source_artifacts = [artifact for artifact in manifest.artifacts if artifact.type == "source_audio"]
    if not source_artifacts:
        raise AppError(
            "SYNC_MANIFEST_SOURCE_ARTIFACT_MISSING",
            "Project manifest does not contain a source audio artifact.",
        )
    if len(source_artifacts) > 1:
        raise AppError(
            "SYNC_MANIFEST_SOURCE_ARTIFACT_AMBIGUOUS",
            "Project manifest must contain exactly one source audio artifact.",
            details={"project_id": manifest.project_id, "source_artifact_count": len(source_artifacts)},
        )
    return source_artifacts[0]


def _validate_source_artifact_matches_project_source(manifest: SyncProjectManifest) -> None:
    source_artifact = _source_artifact_manifest(manifest)
    if source_artifact.content_sha256 != manifest.source_sha256:
        raise AppError(
            "SYNC_MANIFEST_SOURCE_ARTIFACT_HASH_MISMATCH",
            "Project manifest source artifact SHA-256 must match project source_sha256.",
            details={
                "project_id": manifest.project_id,
                "artifact_id": source_artifact.artifact_id,
                "source_sha256": manifest.source_sha256,
                "artifact_content_sha256": source_artifact.content_sha256,
            },
        )


def _required_source_sha256(project: Project) -> str:
    if project.source_sha256 is None:
        raise AppError(
            "SYNC_MANIFEST_SOURCE_HASH_MISSING",
            "Project cannot be exported for sync because it is missing source SHA-256 metadata.",
            details={"project_id": project.id},
        )
    normalized = project.source_sha256.strip().lower()
    try:
        expected_project_id = source_hash_to_project_id(normalized)
    except ValueError as exc:
        raise AppError(
            "SYNC_MANIFEST_SOURCE_HASH_INVALID",
            "Project cannot be exported for sync because its source SHA-256 is invalid.",
            details={"project_id": project.id},
        ) from exc
    if project.id != expected_project_id:
        raise AppError(
            "SYNC_MANIFEST_NONCANONICAL_PROJECT_ID",
            "Project cannot be exported for sync because its project ID is not canonical.",
            details={"project_id": project.id, "expected_project_id": expected_project_id},
        )
    return normalized


def _validate_project_manifest_identity(manifest: SyncProjectManifest) -> None:
    try:
        expected_project_id = source_hash_to_project_id(manifest.source_sha256)
    except ValueError as exc:
        raise _invalid_manifest("Project manifest source_sha256 must be a full SHA-256 hex digest.") from exc
    if manifest.project_id != expected_project_id:
        raise _invalid_manifest("Project manifest project_id must be derived from source_sha256.")


def _validate_project_manifest_schema_version(manifest: SyncProjectManifest) -> None:
    if manifest.schema_version != SYNC_PROJECT_MANIFEST_SCHEMA_VERSION:
        raise AppError(
            "SYNC_MANIFEST_SCHEMA_UNSUPPORTED",
            "Project manifest schema_version is not supported.",
            details={
                "schema_version": manifest.schema_version,
                "supported_schema_version": SYNC_PROJECT_MANIFEST_SCHEMA_VERSION,
            },
        )


def _reject_duplicate_project_source(session: Session, manifest: SyncProjectManifest) -> None:
    existing_project = session.get(Project, manifest.project_id)
    if existing_project is None:
        existing_project = session.scalar(
            select(Project)
            .where(Project.source_sha256 == manifest.source_sha256)
            .order_by(Project.created_at.asc(), Project.id.asc())
        )
    if existing_project is not None:
        raise _duplicate_project_source_error(existing_project.id, existing_project.display_name)

    for artifact in manifest.artifacts:
        if session.get(Artifact, artifact.artifact_id) is not None:
            raise AppError(
                "SYNC_MANIFEST_ARTIFACT_CONFLICT",
                "A synced artifact conflicts with an existing local artifact.",
                status_code=status.HTTP_409_CONFLICT,
                details={"artifact_id": artifact.artifact_id},
            )


def _raise_duplicate_project_source(
    session: Session,
    project_id: str,
    source_sha256: str,
    exc: IntegrityError,
) -> None:
    existing_project = session.get(Project, project_id)
    if existing_project is None:
        existing_project = session.scalar(
            select(Project)
            .where(Project.source_sha256 == source_sha256)
            .order_by(Project.created_at.asc(), Project.id.asc())
        )
    if existing_project is not None:
        raise _duplicate_project_source_error(existing_project.id, existing_project.display_name) from exc
    raise _duplicate_project_source_error(project_id, project_id) from exc


def _duplicate_project_source_error(project_id: str, project_name: str) -> AppError:
    return AppError(
        "DUPLICATE_PROJECT_SOURCE",
        f'This project is already imported with name "{project_name}".',
        status_code=status.HTTP_409_CONFLICT,
        details={"project_id": project_id, "project_name": project_name},
    )


def _coerce_project_manifest(manifest: SyncProjectManifest | Mapping[str, Any] | object) -> SyncProjectManifest:
    if isinstance(manifest, SyncProjectManifest):
        return manifest

    project_source = _field(manifest, "project", default=None)
    project_fields = project_source if project_source is not None else manifest
    raw_artifacts = _field(manifest, "artifacts")
    if not isinstance(raw_artifacts, list):
        raise _invalid_manifest("Project manifest artifacts must be a list.")

    project_id = _required_str(project_fields, "project_id")
    source_sha256 = _required_str(project_fields, "source_sha256").strip().lower()

    project_manifest = SyncProjectManifest(
        schema_version=_optional_str(manifest, "schema_version") or SYNC_PROJECT_MANIFEST_SCHEMA_VERSION,
        exported_at=_optional_datetime(manifest, "exported_at") or datetime.now(UTC),
        project=SyncProjectManifestProject(
            project_id=project_id,
            display_name=_required_str(project_fields, "display_name"),
            source_key_override=_optional_str(project_fields, "source_key_override"),
            source_sha256=source_sha256,
            duration_seconds=_optional_float(project_fields, "duration_seconds"),
            sample_rate=_optional_int(project_fields, "sample_rate"),
            channels=_optional_int(project_fields, "channels"),
            created_at=_required_datetime(project_fields, "created_at"),
            updated_at=_required_datetime(project_fields, "updated_at"),
        ),
        artifacts=[_coerce_artifact_manifest(artifact) for artifact in raw_artifacts],
    )
    _validate_project_manifest_identity(project_manifest)
    return project_manifest


def _coerce_artifact_manifest(manifest: Mapping[str, Any] | object) -> SyncArtifactManifest:
    content_sha256 = _required_str(manifest, "content_sha256").strip().lower()
    if not _is_sha256(content_sha256):
        raise _invalid_manifest("Artifact manifest content_sha256 must be a full SHA-256 hex digest.")
    size_bytes = _required_int(manifest, "size_bytes")
    if size_bytes < 0:
        raise _invalid_manifest("Artifact manifest size_bytes must be non-negative.")

    metadata = _field(manifest, "metadata", default={})
    if not isinstance(metadata, dict):
        raise _invalid_manifest("Artifact manifest metadata must be an object.")

    return SyncArtifactManifest(
        artifact_id=_required_str(manifest, "artifact_id"),
        project_id=_required_str(manifest, "project_id"),
        type=_required_str(manifest, "type"),
        format=_required_str(manifest, "format"),
        relative_path=_required_str(manifest, "relative_path"),
        content_sha256=content_sha256,
        size_bytes=size_bytes,
        generated_by=_required_str(manifest, "generated_by"),
        can_delete=_required_bool(manifest, "can_delete"),
        can_regenerate=_required_bool(manifest, "can_regenerate"),
        cache_key=_optional_str(manifest, "cache_key"),
        metadata=metadata,
        created_at=_required_datetime(manifest, "created_at"),
    )


def _field(source: Mapping[str, Any] | object, name: str, *, default: Any = ...) -> Any:
    if isinstance(source, Mapping):
        if name in source:
            return source[name]
    elif hasattr(source, name):
        return getattr(source, name)
    if default is ...:
        raise _invalid_manifest(f"Project manifest is missing required field: {name}.")
    return default


def _required_str(source: Mapping[str, Any] | object, name: str) -> str:
    value = _field(source, name)
    if not isinstance(value, str) or not value:
        raise _invalid_manifest(f"Project manifest field must be a non-empty string: {name}.")
    return value


def _optional_str(source: Mapping[str, Any] | object, name: str) -> str | None:
    value = _field(source, name, default=None)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid_manifest(f"Project manifest field must be a string or null: {name}.")
    return value


def _required_bool(source: Mapping[str, Any] | object, name: str) -> bool:
    value = _field(source, name)
    if not isinstance(value, bool):
        raise _invalid_manifest(f"Project manifest field must be a boolean: {name}.")
    return value


def _required_int(source: Mapping[str, Any] | object, name: str) -> int:
    value = _field(source, name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise _invalid_manifest(f"Project manifest field must be an integer: {name}.")
    return value


def _optional_int(source: Mapping[str, Any] | object, name: str) -> int | None:
    value = _field(source, name, default=None)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise _invalid_manifest(f"Project manifest field must be an integer or null: {name}.")
    return value


def _optional_float(source: Mapping[str, Any] | object, name: str) -> float | None:
    value = _field(source, name, default=None)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _invalid_manifest(f"Project manifest field must be numeric or null: {name}.")
    return float(value)


def _required_datetime(source: Mapping[str, Any] | object, name: str) -> datetime:
    value = _field(source, name)
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise _invalid_manifest(f"Project manifest field must be an ISO datetime: {name}.") from exc
    raise _invalid_manifest(f"Project manifest field must be a datetime: {name}.")


def _optional_datetime(source: Mapping[str, Any] | object, name: str) -> datetime | None:
    value = _field(source, name, default=None)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise _invalid_manifest(f"Project manifest field must be an ISO datetime: {name}.") from exc
    raise _invalid_manifest(f"Project manifest field must be a datetime or null: {name}.")


def _is_sha256(value: str) -> bool:
    if len(value) != 64:
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


def _safe_relative_path(relative_path: str) -> Path:
    if "\x00" in relative_path or "\\" in relative_path:
        raise _invalid_relative_path(relative_path)
    path = PurePosixPath(relative_path)
    if path.is_absolute() or not path.parts:
        raise _invalid_relative_path(relative_path)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise _invalid_relative_path(relative_path)
    return Path(*path.parts)


def _ensure_child_path(root: Path, path: Path, label: str) -> None:
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise AppError(
            "SYNC_MANIFEST_RELATIVE_PATH_INVALID",
            f"Sync manifest {label} path escapes its root.",
        ) from exc


def _cleanup_copied_artifacts(copied_paths: list[Path], root: Path) -> None:
    parents: set[Path] = set()
    for path in reversed(copied_paths):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        parents.add(path.parent)

    for parent in sorted(parents, key=lambda current: len(current.parts), reverse=True):
        current = parent
        while current == root or root in current.parents:
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent


def _invalid_relative_path(relative_path: str) -> AppError:
    return AppError(
        "SYNC_MANIFEST_RELATIVE_PATH_INVALID",
        "Sync manifest artifact relative path is invalid.",
        details={"relative_path": relative_path},
    )


def _file_size(path: Path) -> int | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    if not path.is_file():
        return None
    return stat.st_size


def _invalid_manifest(message: str) -> AppError:
    return AppError("SYNC_MANIFEST_INVALID", message)
