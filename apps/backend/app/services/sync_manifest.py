from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, cast

from fastapi import status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import AppError
from app.models import Artifact, ChordTimeline, LyricsTranscript, Project, SongSection, SyncEntityRevision
from app.services.artifacts import register_artifact
from app.services.paths import ensure_project_dirs, project_root
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_metadata import project_relative_artifact_path, sanitize_sync_metadata
from app.services.sync_revisions import (
    CURRENT_REVISION_STATE,
    revision_payload_sha256,
    sanitize_revision_payload,
)
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
class SyncEntityRevisionManifest:
    revision_id: str
    project_id: str
    entity_type: str
    entity_id: str
    revision_type: str
    base_revision_id: str | None
    author_device_id: str
    source_artifact_id: str | None
    content_sha256: str
    state: str
    metadata: dict[str, Any]
    payload: dict[str, Any]
    created_at: datetime
    updated_at: datetime


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
    entity_revisions: list[SyncEntityRevisionManifest]
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
    entity_revisions = _list_project_entity_revisions(session, project_id=project.id)

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
        entity_revisions=[
            _export_entity_revision_manifest(revision)
            for revision in entity_revisions
        ],
        artifacts=[_export_artifact_manifest(artifact) for artifact in artifacts],
    )
    _validate_source_artifact_present(manifest)
    return manifest


def import_staged_project_manifest(
    session: Session,
    *,
    manifest: SyncProjectManifest | Mapping[str, Any] | object,
    staging_root: Path | str | None = None,
    use_content_addressed_staging: bool = False,
    staged_content_addressed: bool | None = None,
) -> Project:
    if staged_content_addressed is not None:
        flags_conflict = (
            use_content_addressed_staging is not False
            and use_content_addressed_staging != staged_content_addressed
        )
        if flags_conflict:
            raise AppError(
                "SYNC_MANIFEST_STAGING_MODE_CONFLICT",
                "Sync manifest import received conflicting staging mode flags.",
            )
        use_content_addressed_staging = staged_content_addressed

    project_manifest = _coerce_project_manifest(manifest)
    _validate_project_manifest_schema_version(project_manifest)
    _validate_project_manifest_identity(project_manifest)
    source_artifact = _validate_staged_import_source_artifact(project_manifest)
    _reject_duplicate_project_source(session, project_manifest)
    root = project_root(project_manifest.project_id).resolve(strict=False)
    staged_root = (
        None if staging_root is None else Path(staging_root).expanduser().resolve(strict=False)
    )
    verified_artifacts = _verify_staged_artifacts(
        session,
        project_manifest,
        staging_root=staged_root,
        project_root_path=root,
        use_content_addressed_staging=use_content_addressed_staging,
    )
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
        _import_entity_revisions(session, project_manifest)
        _hydrate_current_entity_revisions(session, project, project_manifest.entity_revisions)
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


def _list_project_entity_revisions(
    session: Session,
    *,
    project_id: str,
) -> list[SyncEntityRevision]:
    return list(
        session.scalars(
            select(SyncEntityRevision)
            .where(SyncEntityRevision.project_id == project_id)
            .order_by(
                SyncEntityRevision.entity_type.asc(),
                SyncEntityRevision.entity_id.asc(),
                SyncEntityRevision.created_at.asc(),
                SyncEntityRevision.id.asc(),
            )
        )
    )


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

    if artifact.type == "source_audio":
        _validate_export_source_artifact(
            artifact=artifact,
            relative_path=relative_path,
            artifact_path=artifact_path,
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


def _export_entity_revision_manifest(revision: SyncEntityRevision) -> SyncEntityRevisionManifest:
    metadata = sanitize_revision_payload(revision.metadata_json or {})
    payload = sanitize_revision_payload(revision.payload_json or {})
    return SyncEntityRevisionManifest(
        revision_id=revision.id,
        project_id=revision.project_id,
        entity_type=revision.entity_type,
        entity_id=revision.entity_id,
        revision_type=revision.revision_type,
        base_revision_id=revision.base_revision_id,
        author_device_id=revision.author_device_id,
        source_artifact_id=revision.source_artifact_id,
        content_sha256=revision_payload_sha256(payload),
        state=revision.state,
        metadata=metadata,
        payload=payload,
        created_at=revision.created_at,
        updated_at=revision.updated_at,
    )


def _import_entity_revisions(session: Session, manifest: SyncProjectManifest) -> None:
    if not manifest.entity_revisions:
        return

    seen_revision_ids: set[str] = set()
    manifest_revisions_by_id = {
        revision.revision_id: revision for revision in manifest.entity_revisions
    }
    for revision in manifest.entity_revisions:
        if revision.project_id != manifest.project_id:
            raise AppError(
                "SYNC_MANIFEST_ENTITY_REVISION_PROJECT_MISMATCH",
                "Entity revision manifest belongs to a different project.",
                details={
                    "revision_id": revision.revision_id,
                    "project_id": revision.project_id,
                },
            )
        if revision.revision_id in seen_revision_ids:
            raise AppError(
                "SYNC_MANIFEST_DUPLICATE_ENTITY_REVISION",
                "Project manifest contains duplicate entity revision IDs.",
                details={"revision_id": revision.revision_id},
            )
        seen_revision_ids.add(revision.revision_id)

        _validate_entity_revision_base_reference(session, manifest.project_id, revision, manifest_revisions_by_id)
        _validate_entity_revision_source_artifact_reference(session, manifest.project_id, revision)


        if session.get(SyncEntityRevision, revision.revision_id) is not None:
            raise AppError(
                "SYNC_MANIFEST_ENTITY_REVISION_CONFLICT",
                "A synced entity revision conflicts with an existing local revision.",
                status_code=status.HTTP_409_CONFLICT,
                details={"revision_id": revision.revision_id},
            )

    for revision in _entity_revisions_in_dependency_order(manifest.entity_revisions):
        row = SyncEntityRevision(
            id=revision.revision_id,
            project_id=revision.project_id,
            entity_type=revision.entity_type,
            entity_id=revision.entity_id,
            revision_type=revision.revision_type,
            base_revision_id=revision.base_revision_id,
            author_device_id=revision.author_device_id,
            source_artifact_id=revision.source_artifact_id,
            content_sha256=revision.content_sha256,
            state=_normalize_revision_state(revision.state),
            metadata_json=deepcopy(revision.metadata),
            payload_json=deepcopy(revision.payload),
            created_at=revision.created_at,
            updated_at=revision.updated_at,
        )
        session.add(row)

    session.flush()


def _validate_entity_revision_base_reference(
    session: Session,
    project_id: str,
    revision: SyncEntityRevisionManifest,
    manifest_revisions_by_id: dict[str, SyncEntityRevisionManifest],
) -> None:
    if revision.base_revision_id is None:
        return

    manifest_base = manifest_revisions_by_id.get(revision.base_revision_id)
    if manifest_base is not None:
        if (
            manifest_base.project_id != project_id
            or manifest_base.entity_type != revision.entity_type
            or manifest_base.entity_id != revision.entity_id
        ):
            raise _invalid_manifest(
                "Entity revision base_revision_id must reference the same project entity."
            )
        return

    existing_base = session.get(SyncEntityRevision, revision.base_revision_id)
    if existing_base is None:
        raise _invalid_manifest("Entity revision base_revision_id does not exist in the manifest.")
    if (
        existing_base.project_id != project_id
        or existing_base.entity_type != revision.entity_type
        or existing_base.entity_id != revision.entity_id
    ):
        raise _invalid_manifest("Entity revision base_revision_id must reference the same project entity.")


def _validate_entity_revision_source_artifact_reference(
    session: Session,
    project_id: str,
    revision: SyncEntityRevisionManifest,
) -> None:
    if revision.source_artifact_id is None:
        return
    artifact = session.get(Artifact, revision.source_artifact_id)
    if artifact is None:
        raise _invalid_manifest("Entity revision source_artifact_id does not exist in the manifest.")
    if artifact.project_id != project_id:
        raise _invalid_manifest("Entity revision source_artifact_id must belong to the manifest project.")


def _entity_revisions_in_dependency_order(
    revisions: list[SyncEntityRevisionManifest],
) -> list[SyncEntityRevisionManifest]:
    pending = {revision.revision_id: revision for revision in revisions}
    ordered: list[SyncEntityRevisionManifest] = []
    while pending:
        ready = sorted(
            (
                revision
                for revision in pending.values()
                if revision.base_revision_id not in pending
            ),
            key=_entity_revision_sort_key,
        )
        if not ready:
            raise _invalid_manifest("Entity revision base_revision_id contains a cycle.")
        for revision in ready:
            ordered.append(revision)
            del pending[revision.revision_id]
    return ordered


def _entity_revision_sort_key(revision: SyncEntityRevisionManifest) -> tuple[str, str, datetime, str]:
    return (
        revision.entity_type,
        revision.entity_id,
        revision.created_at,
        revision.revision_id,
    )


def _hydrate_current_entity_revisions(
    session: Session,
    project: Project,
    revisions: list[SyncEntityRevisionManifest],
) -> None:
    current_revisions = [
        revision for revision in revisions if _is_current_revision_state(revision.state)
    ]
    singleton_current: set[str] = set()
    section_ids: set[str] = set()
    for revision in current_revisions:
        if revision.entity_type in {"project_metadata", "chords", "lyrics"}:
            if revision.entity_type in singleton_current:
                raise _invalid_manifest(
                    f"Project manifest contains multiple current {revision.entity_type} revisions."
                )
            singleton_current.add(revision.entity_type)
        elif revision.entity_type == "section":
            if revision.entity_id in section_ids:
                raise _invalid_manifest(
                    "Project manifest contains multiple current section revisions for the same entity."
                )
            section_ids.add(revision.entity_id)

    for revision in current_revisions:
        if revision.entity_type == "project_metadata":
            _hydrate_project_metadata_revision(project, revision)
        elif revision.entity_type == "chords":
            _hydrate_chord_revision(session, project, revision)
        elif revision.entity_type == "lyrics":
            _hydrate_lyrics_revision(session, project, revision)
        elif revision.entity_type == "section":
            _hydrate_section_revision(session, project, revision)

    session.flush()


def _is_current_revision_state(state: str) -> bool:
    return _normalize_revision_state(state) == CURRENT_REVISION_STATE


def _normalize_revision_state(state: str) -> str:
    normalized = state.strip().lower()
    if normalized == "current":
        return CURRENT_REVISION_STATE
    return normalized


def _hydrate_project_metadata_revision(
    project: Project,
    revision: SyncEntityRevisionManifest,
) -> None:
    payload = revision.payload
    if "display_name" in payload:
        display_name = payload["display_name"]
        if not isinstance(display_name, str) or not display_name.strip():
            raise _invalid_manifest("Project metadata revision display_name must be a non-empty string.")
        project.display_name = display_name.strip()
    if "source_key_override" in payload:
        source_key_override = payload["source_key_override"]
        if source_key_override is not None and not isinstance(source_key_override, str):
            raise _invalid_manifest("Project metadata revision source_key_override must be a string or null.")
        project.source_key_override = source_key_override
    project.updated_at = revision.updated_at


def _hydrate_chord_revision(
    session: Session,
    project: Project,
    revision: SyncEntityRevisionManifest,
) -> None:
    payload = revision.payload
    chords = session.get(ChordTimeline, project.id)
    if chords is None:
        chords = ChordTimeline(project_id=project.id, created_at=revision.created_at)
        session.add(chords)

    segments = _payload_list(payload, ("segments", "segments_json", "timeline"))
    timeline = _payload_list(payload, ("timeline", "timeline_json"), default=segments)
    chords.backend = _payload_optional_str(payload, "backend") or "default"
    chords.source_artifact_id = _payload_optional_str(payload, "source_artifact_id") or revision.source_artifact_id
    chords.source_segments_json = _payload_list(payload, ("source_segments", "source_segments_json"))
    chords.segments_json = segments
    chords.timeline_json = timeline
    chords.source_kind = _payload_optional_str(payload, "source_kind") or "generated"
    chords.has_user_edits = _payload_bool(payload, "has_user_edits", default=False)
    chords.metadata_json = _payload_mapping(
        payload,
        ("metadata", "metadata_json"),
        default=revision.metadata,
    )
    chords.created_at = _payload_datetime(payload, "created_at") or revision.created_at
    chords.updated_at = _payload_datetime(payload, "updated_at") or revision.updated_at


def _hydrate_lyrics_revision(
    session: Session,
    project: Project,
    revision: SyncEntityRevisionManifest,
) -> None:
    payload = revision.payload
    lyrics = session.get(LyricsTranscript, project.id)
    if lyrics is None:
        lyrics = LyricsTranscript(project_id=project.id, created_at=revision.created_at)
        session.add(lyrics)

    lyrics.backend = _payload_optional_str(payload, "backend") or "openai-whisper"
    lyrics.source_artifact_id = _payload_optional_str(payload, "source_artifact_id") or revision.source_artifact_id
    lyrics.source_kind = _payload_optional_str(payload, "source_kind") or "ai"
    lyrics.requested_device = _payload_optional_str(payload, "requested_device")
    lyrics.device = _payload_optional_str(payload, "device")
    lyrics.model_name = _payload_optional_str(payload, "model_name")
    lyrics.language = _payload_optional_str(payload, "language")
    lyrics.source_segments_json = _payload_list(payload, ("source_segments", "source_segments_json"))
    lyrics.segments_json = _payload_list(payload, ("segments", "segments_json"))
    lyrics.has_user_edits = _payload_bool(payload, "has_user_edits", default=False)
    lyrics.created_at = _payload_datetime(payload, "created_at") or revision.created_at
    lyrics.updated_at = _payload_datetime(payload, "updated_at") or revision.updated_at


def _hydrate_section_revision(
    session: Session,
    project: Project,
    revision: SyncEntityRevisionManifest,
) -> None:
    payload = revision.payload
    section_id = _payload_optional_str(payload, "id") or revision.entity_id
    if section_id != revision.entity_id:
        raise _invalid_manifest("Section revision payload id must match entity_id.")
    label = _payload_optional_str(payload, "label")
    if label is None or not label.strip():
        raise _invalid_manifest("Section revision label must be a non-empty string.")

    section = session.get(SongSection, section_id)
    if section is not None and section.project_id != project.id:
        raise _invalid_manifest("Section revision conflicts with another project.")
    if section is None:
        section = SongSection(id=section_id, project_id=project.id, created_at=revision.created_at)
        session.add(section)

    section.project_id = project.id
    section.tab_import_id = _payload_optional_str(payload, "tab_import_id")
    section.label = label.strip()
    section.start_seconds = _payload_optional_float(payload, "start_seconds")
    section.end_seconds = _payload_optional_float(payload, "end_seconds")
    section.source = _payload_optional_str(payload, "source") or "sync"
    section.metadata_json = _payload_mapping(payload, ("metadata", "metadata_json"))
    section.created_at = _payload_datetime(payload, "created_at") or revision.created_at
    section.updated_at = _payload_datetime(payload, "updated_at") or revision.updated_at


def _verify_staged_artifacts(
    session: Session,
    manifest: SyncProjectManifest,
    *,
    staging_root: Path | None,
    project_root_path: Path,
    use_content_addressed_staging: bool,
) -> list[_VerifiedStagedArtifact]:
    verified: list[_VerifiedStagedArtifact] = []
    destination_paths: set[Path] = set()
    artifact_ids: set[str] = set()

    if not use_content_addressed_staging and staging_root is None:
        raise AppError(
            "SYNC_MANIFEST_STAGING_ROOT_REQUIRED",
            "A staging root is required for relative staged artifact import.",
        )

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
        destination_path = (project_root_path / relative_path).resolve(strict=False)
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

        if use_content_addressed_staging:
            staged_path = _content_addressed_staged_path(session, artifact)
        else:
            assert staging_root is not None
            staged_path = (staging_root / relative_path).resolve(strict=False)
            _ensure_child_path(staging_root, staged_path, "staged artifact")
            _verify_staged_file(artifact, staged_path)
        if artifact.type == "source_audio":
            _validate_wav_source_file(
                artifact_id=artifact.artifact_id,
                project_id=artifact.project_id,
                relative_path=artifact.relative_path,
                path=staged_path,
            )

        verified.append(
            _VerifiedStagedArtifact(
                manifest=artifact,
                staged_path=staged_path,
                destination_path=destination_path,
            )
        )

    return verified


def _content_addressed_staged_path(session: Session, artifact: SyncArtifactManifest) -> Path:
    try:
        from app.services.sync_staging import require_staged_artifact
    except ModuleNotFoundError as exc:
        if exc.name == "app.services.sync_staging":
            raise AppError(
                "SYNC_STAGING_SERVICE_UNAVAILABLE",
                "Content-addressed sync staging is not available.",
            ) from exc
        raise

    staged_artifact = require_staged_artifact(
        session,
        content_sha256=artifact.content_sha256,
        size_bytes=artifact.size_bytes,
    )
    resolved_path = getattr(staged_artifact, "resolved_path", None)
    if not isinstance(resolved_path, Path):
        raise AppError(
            "SYNC_STAGING_ARTIFACT_PATH_INVALID",
            "A staged sync artifact resolved to an invalid local path.",
            details={"artifact_id": artifact.artifact_id},
        )
    return resolved_path


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


def _validate_source_artifact_present(manifest: SyncProjectManifest) -> None:
    _validate_staged_import_source_artifact(manifest)


def _validate_staged_import_source_artifact(manifest: SyncProjectManifest) -> SyncArtifactManifest:
    source_artifact = _source_artifact_manifest(manifest)
    if source_artifact.format != "wav":
        raise _invalid_manifest("Project manifest source_audio artifact format must be 'wav'.")

    relative_path = _safe_relative_path(source_artifact.relative_path)
    if relative_path.suffix.lower() != ".wav":
        raise _invalid_manifest("Project manifest source_audio artifact relative_path must end with .wav.")
    return source_artifact


def _validate_export_source_artifact(
    *,
    artifact: Artifact,
    relative_path: str,
    artifact_path: Path,
) -> None:
    if artifact.format != "wav":
        raise AppError(
            "SYNC_MANIFEST_SOURCE_ARTIFACT_UNSUPPORTED",
            "Project source audio artifact must be an app-managed WAV before sync export.",
            details={"artifact_id": artifact.id, "project_id": artifact.project_id, "format": artifact.format},
        )
    if PurePosixPath(relative_path).suffix.lower() != ".wav":
        raise AppError(
            "SYNC_MANIFEST_SOURCE_ARTIFACT_UNSUPPORTED",
            "Project source audio artifact must use a .wav relative path before sync export.",
            details={
                "artifact_id": artifact.id,
                "project_id": artifact.project_id,
                "relative_path": relative_path,
            },
        )
    _validate_wav_source_file(
        artifact_id=artifact.id,
        project_id=artifact.project_id,
        relative_path=relative_path,
        path=artifact_path,
    )


def _validate_wav_source_file(
    *,
    artifact_id: str,
    project_id: str,
    relative_path: str,
    path: Path,
) -> None:
    command = [
        get_settings().ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,channels,sample_rate",
        "-show_entries",
        "format=format_name",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout or "{}")
    except FileNotFoundError as exc:
        raise AppError(
            "DEPENDENCY_MISSING",
            "ffprobe is required to validate source audio artifacts for sync.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        ) from exc
    except (json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        raise _source_artifact_not_wav_error(
            artifact_id=artifact_id,
            project_id=project_id,
            relative_path=relative_path,
        ) from exc

    if not _is_wav_pcm_probe(payload):
        raise _source_artifact_not_wav_error(
            artifact_id=artifact_id,
            project_id=project_id,
            relative_path=relative_path,
        )


def _is_wav_pcm_probe(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    fmt = payload.get("format")
    streams = payload.get("streams")
    if not isinstance(fmt, dict) or not isinstance(streams, list) or not streams:
        return False
    stream = streams[0]
    if not isinstance(stream, dict):
        return False
    format_name = fmt.get("format_name")
    codec_name = stream.get("codec_name")
    if not isinstance(format_name, str) or not isinstance(codec_name, str):
        return False
    format_names = {name.strip().lower() for name in format_name.split(",")}
    return (
        "wav" in format_names
        and codec_name.startswith("pcm_")
        and _positive_int(stream.get("channels"))
        and _positive_int(stream.get("sample_rate"))
    )


def _positive_int(value: Any) -> bool:
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return False


def _source_artifact_not_wav_error(
    *,
    artifact_id: str,
    project_id: str,
    relative_path: str,
) -> AppError:
    return AppError(
        "SYNC_MANIFEST_SOURCE_ARTIFACT_NOT_WAV",
        "Project source audio artifact file must be a readable PCM WAV.",
        details={
            "artifact_id": artifact_id,
            "project_id": project_id,
            "relative_path": relative_path,
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
    raw_entity_revisions = _field(manifest, "entity_revisions", default=[])
    if not isinstance(raw_entity_revisions, list):
        raise _invalid_manifest("Project manifest entity_revisions must be a list.")

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
        entity_revisions=[
            _coerce_entity_revision_manifest(revision)
            for revision in raw_entity_revisions
        ],
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


def _coerce_entity_revision_manifest(manifest: Mapping[str, Any] | object) -> SyncEntityRevisionManifest:
    content_sha256 = _required_str(manifest, "content_sha256").strip().lower()
    if not _is_sha256(content_sha256):
        raise _invalid_manifest("Entity revision manifest content_sha256 must be a full SHA-256 hex digest.")

    metadata = _field(manifest, "metadata", default={})
    if not isinstance(metadata, dict):
        raise _invalid_manifest("Entity revision manifest metadata must be an object.")
    payload = _field(manifest, "payload", default={})
    if not isinstance(payload, dict):
        raise _invalid_manifest("Entity revision manifest payload must be an object.")
    safe_metadata = sanitize_revision_payload(metadata)
    safe_payload = sanitize_revision_payload(payload)
    if safe_metadata != metadata or safe_payload != payload:
        raise _invalid_manifest(
            "Entity revision manifest metadata and payload must be sync-safe."
        )
    if content_sha256 != revision_payload_sha256(safe_payload):
        raise _invalid_manifest("Entity revision manifest content_sha256 must match payload.")

    return SyncEntityRevisionManifest(
        revision_id=_required_str(manifest, "revision_id"),
        project_id=_required_str(manifest, "project_id"),
        entity_type=_required_str(manifest, "entity_type"),
        entity_id=_required_str(manifest, "entity_id"),
        revision_type=_required_str(manifest, "revision_type"),
        base_revision_id=_optional_str(manifest, "base_revision_id"),
        author_device_id=_required_str(manifest, "author_device_id"),
        source_artifact_id=_optional_str(manifest, "source_artifact_id"),
        content_sha256=content_sha256,
        state=_normalize_revision_state(_required_str(manifest, "state")),
        metadata=safe_metadata,
        payload=safe_payload,
        created_at=_required_datetime(manifest, "created_at"),
        updated_at=_required_datetime(manifest, "updated_at"),
    )


def _payload_optional_str(payload: Mapping[str, Any], name: str) -> str | None:
    value = payload.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid_manifest(f"Entity revision payload field must be a string or null: {name}.")
    return value


def _payload_bool(payload: Mapping[str, Any], name: str, *, default: bool) -> bool:
    value = payload.get(name, default)
    if not isinstance(value, bool):
        raise _invalid_manifest(f"Entity revision payload field must be a boolean: {name}.")
    return value


def _payload_optional_float(payload: Mapping[str, Any], name: str) -> float | None:
    value = payload.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _invalid_manifest(f"Entity revision payload field must be numeric or null: {name}.")
    return float(value)


def _payload_list(
    payload: Mapping[str, Any],
    names: tuple[str, ...],
    *,
    default: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    value = _payload_first(payload, names, default=[] if default is None else default)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise _invalid_manifest(f"Entity revision payload field must be a list of objects: {names[0]}.")
    return cast(list[dict[str, Any]], deepcopy(value))


def _payload_mapping(
    payload: Mapping[str, Any],
    names: tuple[str, ...],
    *,
    default: dict[str, Any] | None = None,
) -> dict[str, Any]:
    value = _payload_first(payload, names, default={} if default is None else default)
    if not isinstance(value, dict):
        raise _invalid_manifest(f"Entity revision payload field must be an object: {names[0]}.")
    return cast(dict[str, Any], deepcopy(value))


def _payload_datetime(payload: Mapping[str, Any], name: str) -> datetime | None:
    value = payload.get(name)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise _invalid_manifest(f"Entity revision payload field must be an ISO datetime: {name}.") from exc
    raise _invalid_manifest(f"Entity revision payload field must be a datetime or null: {name}.")


def _payload_first(payload: Mapping[str, Any], names: tuple[str, ...], *, default: Any) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
    return default


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
