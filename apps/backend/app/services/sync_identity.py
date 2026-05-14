from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Artifact, Project
from app.utils.hashing import file_sha256

PROJECT_ID_PREFIX = "proj_sha256_"
PROJECT_STORAGE_KEY_PREFIX = "proj_"
PROJECT_STORAGE_HASH_LENGTH = 24
NORMALIZED_IMPORT_SOURCE_FORMATS = {"mp4", "webm"}
HEX_DIGITS = frozenset("0123456789abcdef")

SyncPreflightProjectStatus = Literal[
    "ready",
    "missing_source_hash",
    "invalid_source_hash",
    "duplicate_source_hash",
    "noncanonical_project_id",
]
SyncPreflightSourceHashSource = Literal[
    "database",
    "source_path",
    "original_copy_path",
    "source_artifact_path",
    "imported_path",
]


@dataclass(frozen=True)
class SyncPreflightProject:
    project_id: str
    display_name: str
    status: SyncPreflightProjectStatus
    source_sha256: str | None
    expected_project_id: str | None
    expected_storage_key: str | None
    source_hash_source: SyncPreflightSourceHashSource | None
    reason: str | None = None


@dataclass(frozen=True)
class SyncPreflightDuplicateProject:
    project_id: str
    display_name: str


@dataclass(frozen=True)
class SyncPreflightDuplicateGroup:
    source_sha256: str
    expected_project_id: str
    projects: list[SyncPreflightDuplicateProject]


@dataclass(frozen=True)
class SyncPreflightResult:
    ok: bool
    total_projects: int
    ready_projects: int
    missing_source_hash_projects: int
    invalid_source_hash_projects: int
    duplicate_source_hash_projects: int
    noncanonical_project_id_projects: int
    projects: list[SyncPreflightProject]
    duplicate_groups: list[SyncPreflightDuplicateGroup]
    manual_cleanup_required: bool
    manual_cleanup_guidance: list[str]


def source_hash_to_project_id(source_sha256: str) -> str:
    normalized = source_sha256.strip().lower()
    if len(normalized) != 64 or any(character not in HEX_DIGITS for character in normalized):
        raise ValueError("source_sha256 must be a full SHA-256 hex digest.")
    return f"{PROJECT_ID_PREFIX}{normalized}"


def source_hash_to_project_storage_key(source_sha256: str) -> str:
    normalized = source_sha256.strip().lower()
    source_hash_to_project_id(normalized)
    return f"{PROJECT_STORAGE_KEY_PREFIX}{normalized[:PROJECT_STORAGE_HASH_LENGTH]}"


def project_id_to_storage_key(project_id: str) -> str:
    if not project_id.startswith(PROJECT_ID_PREFIX):
        return project_id
    source_sha256 = project_id.removeprefix(PROJECT_ID_PREFIX)
    try:
        return source_hash_to_project_storage_key(source_sha256)
    except ValueError:
        return project_id


def run_sync_preflight(session: Session) -> SyncPreflightResult:
    projects = list(session.scalars(select(Project).order_by(Project.created_at.asc(), Project.id.asc())))
    source_artifacts = _source_artifacts_by_project(session)
    preflight_projects = [
        _project_preflight(project, source_artifacts.get(project.id))
        for project in projects
    ]
    duplicate_hashes = {
        source_sha256
        for source_sha256, count in Counter(
            project.source_sha256
            for project in preflight_projects
            if project.status in {"ready", "noncanonical_project_id"} and project.source_sha256 is not None
        ).items()
        if count > 1
    }

    final_projects = [
        _with_duplicate_status(project) if project.source_sha256 in duplicate_hashes else project
        for project in preflight_projects
    ]
    duplicate_groups = _duplicate_groups(final_projects, duplicate_hashes)
    missing_count = sum(1 for project in final_projects if project.status == "missing_source_hash")
    invalid_count = sum(1 for project in final_projects if project.status == "invalid_source_hash")
    duplicate_count = sum(1 for project in final_projects if project.status == "duplicate_source_hash")
    noncanonical_count = sum(1 for project in final_projects if project.status == "noncanonical_project_id")
    ready_count = sum(1 for project in final_projects if project.status == "ready")
    ok = missing_count == 0 and invalid_count == 0 and duplicate_count == 0 and noncanonical_count == 0

    return SyncPreflightResult(
        ok=ok,
        total_projects=len(final_projects),
        ready_projects=ready_count,
        missing_source_hash_projects=missing_count,
        invalid_source_hash_projects=invalid_count,
        duplicate_source_hash_projects=duplicate_count,
        noncanonical_project_id_projects=noncanonical_count,
        projects=final_projects,
        duplicate_groups=duplicate_groups,
        manual_cleanup_required=not ok,
        manual_cleanup_guidance=_manual_cleanup_guidance(
            missing_count=missing_count,
            invalid_count=invalid_count,
            duplicate_count=duplicate_count,
            noncanonical_count=noncanonical_count,
        ),
    )


def _source_artifacts_by_project(session: Session) -> dict[str, Artifact]:
    stmt = (
        select(Artifact)
        .where(Artifact.type == "source_audio")
        .order_by(Artifact.project_id.asc(), Artifact.created_at.asc(), Artifact.id.asc())
    )
    artifacts: dict[str, Artifact] = {}
    for artifact in session.scalars(stmt):
        artifacts.setdefault(artifact.project_id, artifact)
    return artifacts


def _project_preflight(project: Project, source_artifact: Artifact | None) -> SyncPreflightProject:
    if project.source_sha256:
        try:
            normalized_hash = _normalize_source_hash(project.source_sha256)
        except ValueError:
            return SyncPreflightProject(
                project_id=project.id,
                display_name=project.display_name,
                status="invalid_source_hash",
                source_sha256=project.source_sha256,
                expected_project_id=None,
                expected_storage_key=None,
                source_hash_source="database",
                reason="Stored source_sha256 is not a full SHA-256 hex digest.",
            )
        return _project_preflight_with_hash(project, normalized_hash, "database")

    resolved = _resolve_missing_source_hash(project, source_artifact)
    if resolved is None:
        return SyncPreflightProject(
            project_id=project.id,
            display_name=project.display_name,
            status="missing_source_hash",
            source_sha256=None,
            expected_project_id=None,
            expected_storage_key=None,
            source_hash_source=None,
            reason="No readable canonical source file is available for this project.",
        )
    source_sha256, source = resolved
    return _project_preflight_with_hash(project, source_sha256, source)


def _project_preflight_with_hash(
    project: Project,
    source_sha256: str,
    source_hash_source: SyncPreflightSourceHashSource,
) -> SyncPreflightProject:
    expected_project_id = source_hash_to_project_id(source_sha256)
    expected_storage_key = source_hash_to_project_storage_key(source_sha256)
    if project.id != expected_project_id:
        return SyncPreflightProject(
            project_id=project.id,
            display_name=project.display_name,
            status="noncanonical_project_id",
            source_sha256=source_sha256,
            expected_project_id=expected_project_id,
            expected_storage_key=expected_storage_key,
            source_hash_source=source_hash_source,
            reason="Project ID is not derived from the source SHA-256.",
        )
    return SyncPreflightProject(
        project_id=project.id,
        display_name=project.display_name,
        status="ready",
        source_sha256=source_sha256,
        expected_project_id=expected_project_id,
        expected_storage_key=expected_storage_key,
        source_hash_source=source_hash_source,
    )


def _normalize_source_hash(source_sha256: str) -> str:
    normalized = source_sha256.strip().lower()
    source_hash_to_project_id(normalized)
    return normalized


def _resolve_missing_source_hash(
    project: Project,
    source_artifact: Artifact | None,
) -> tuple[str, SyncPreflightSourceHashSource] | None:
    original_copy_path = _original_copy_path(source_artifact)
    original_copy_hash = _path_hash(original_copy_path)
    if original_copy_hash is not None:
        return original_copy_hash, "original_copy_path"

    if not _uses_normalized_source_proxy(project, source_artifact):
        artifact_hash = _path_hash(source_artifact.path if source_artifact is not None else None)
        if artifact_hash is not None:
            return artifact_hash, "source_artifact_path"

        imported_path_hash = _path_hash(project.imported_path)
        if imported_path_hash is not None:
            return imported_path_hash, "imported_path"

    source_path_hash = _path_hash(project.source_path)
    if source_path_hash is not None:
        return source_path_hash, "source_path"

    return None


def _path_hash(raw_path: str | None) -> str | None:
    if not raw_path:
        return None
    return file_sha256(Path(raw_path))


def _original_copy_path(source_artifact: Artifact | None) -> str | None:
    if source_artifact is None:
        return None
    value = source_artifact.metadata_json.get("original_copy_path")
    return value if isinstance(value, str) else None


def _uses_normalized_source_proxy(project: Project, source_artifact: Artifact | None) -> bool:
    original_format = source_artifact.metadata_json.get("original_format") if source_artifact else None
    if isinstance(original_format, str) and original_format.lower() in NORMALIZED_IMPORT_SOURCE_FORMATS:
        return True
    source_format = Path(project.source_path).suffix.lower().lstrip(".")
    imported_format = Path(project.imported_path).suffix.lower().lstrip(".")
    return source_format in NORMALIZED_IMPORT_SOURCE_FORMATS and imported_format == "wav"


def _with_duplicate_status(project: SyncPreflightProject) -> SyncPreflightProject:
    return SyncPreflightProject(
        project_id=project.project_id,
        display_name=project.display_name,
        status="duplicate_source_hash",
        source_sha256=project.source_sha256,
        expected_project_id=project.expected_project_id,
        expected_storage_key=project.expected_storage_key,
        source_hash_source=project.source_hash_source,
        reason="Another project has the same source SHA-256.",
    )


def _duplicate_groups(
    projects: list[SyncPreflightProject],
    duplicate_hashes: set[str],
) -> list[SyncPreflightDuplicateGroup]:
    grouped_projects: dict[str, list[SyncPreflightDuplicateProject]] = defaultdict(list)
    for project in projects:
        if project.source_sha256 in duplicate_hashes and project.source_sha256 is not None:
            grouped_projects[project.source_sha256].append(
                SyncPreflightDuplicateProject(project_id=project.project_id, display_name=project.display_name)
            )

    return [
        SyncPreflightDuplicateGroup(
            source_sha256=source_sha256,
            expected_project_id=source_hash_to_project_id(source_sha256),
            projects=grouped_projects[source_sha256],
        )
        for source_sha256 in sorted(grouped_projects)
    ]


def _manual_cleanup_guidance(
    *,
    missing_count: int,
    invalid_count: int,
    duplicate_count: int,
    noncanonical_count: int,
) -> list[str]:
    guidance: list[str] = []
    if missing_count:
        guidance.append(
            "Restore the original source file or re-import affected projects so TuneForge can compute source hashes."
        )
    if invalid_count:
        guidance.append("Repair invalid project source hashes before enabling sync.")
    if duplicate_count:
        guidance.append(
            "Delete duplicate same-source projects or keep one canonical project before enabling sync."
        )
    if noncanonical_count:
        guidance.append("Re-import or migrate affected projects so project IDs use canonical source hashes.")
    return guidance
