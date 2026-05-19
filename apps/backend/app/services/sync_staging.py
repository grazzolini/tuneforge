from __future__ import annotations

import shutil
import tempfile
from collections.abc import Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import AppError
from app.models import SyncStagedArtifact, utcnow
from app.utils.hashing import file_sha256

HEX_DIGITS = frozenset("0123456789abcdef")
STAGING_REFERENCES_METADATA_KEY = "_sync_staging_references"


@dataclass(frozen=True)
class SyncStagedArtifactDTO:
    content_sha256: str
    size_bytes: int
    relative_path: str
    provider_device_id: str | None
    metadata: dict[str, Any]
    verified_at: datetime
    created_at: datetime
    updated_at: datetime
    resolved_path: Path


def stage_sync_artifact(
    session: Session,
    *,
    source_path: Path | str,
    content_sha256: str,
    size_bytes: int,
    provider_device_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> SyncStagedArtifactDTO:
    normalized_sha256 = _normalize_content_sha256(content_sha256)
    _validate_size_bytes(size_bytes)
    source = Path(source_path).expanduser().resolve(strict=False)
    _verify_source_file(source, content_sha256=normalized_sha256, size_bytes=size_bytes)

    relative_path = _relative_path_for_hash(normalized_sha256)
    destination_path = _staging_root() / Path(relative_path)
    if not _staged_path_matches(destination_path, content_sha256=normalized_sha256, size_bytes=size_bytes):
        _copy_verified_source(source, destination_path)

    public_metadata = dict(metadata) if metadata is not None else None
    next_reference = _reference_from_metadata(public_metadata, provider_device_id)
    now = utcnow()
    record = session.get(SyncStagedArtifact, normalized_sha256)
    if record is None:
        metadata_json: dict[str, Any] = public_metadata or {}
        if next_reference is not None:
            metadata_json[STAGING_REFERENCES_METADATA_KEY] = [next_reference]
        record = SyncStagedArtifact(
            content_sha256=normalized_sha256,
            size_bytes=size_bytes,
            relative_path=relative_path,
            provider_device_id=provider_device_id,
            metadata_json=metadata_json,
            verified_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(record)
    else:
        existing_metadata = record.metadata_json if isinstance(record.metadata_json, dict) else {}
        references = _staging_references(existing_metadata)
        if next_reference is not None:
            references = _merge_staging_references(references, next_reference)
        record.size_bytes = size_bytes
        record.relative_path = relative_path
        record.provider_device_id = provider_device_id
        if metadata is not None:
            metadata_json = public_metadata or {}
            if references:
                metadata_json[STAGING_REFERENCES_METADATA_KEY] = references
            record.metadata_json = metadata_json
        elif record.metadata_json is None:
            metadata_json = {}
            if references:
                metadata_json[STAGING_REFERENCES_METADATA_KEY] = references
            record.metadata_json = metadata_json
        elif next_reference is not None:
            metadata_json = dict(existing_metadata)
            metadata_json[STAGING_REFERENCES_METADATA_KEY] = references
            record.metadata_json = metadata_json
        record.verified_at = now
        record.updated_at = now

    session.flush()
    return _verify_staged_record(record, expected_size_bytes=size_bytes)


def get_staged_artifact_path(session: Session, *, content_sha256: str) -> Path:
    return require_staged_artifact(session, content_sha256=content_sha256).resolved_path


def cleanup_staged_artifacts(
    session: Session,
    *,
    content_sha256s: Iterable[str] = (),
    references: Iterable[Mapping[str, Any]] = (),
) -> int:
    removed = 0
    staging_root = _staging_root().resolve(strict=False)
    normalized_hashes: set[str] = set()
    for content_sha256 in content_sha256s:
        try:
            normalized_hashes.add(_normalize_content_sha256(content_sha256))
        except AppError:
            continue
    references_by_hash: dict[str, list[dict[str, str]]] = {}
    for reference in references:
        raw_content_sha256 = reference.get("content_sha256")
        if not isinstance(raw_content_sha256, str):
            continue
        try:
            normalized_sha256 = _normalize_content_sha256(raw_content_sha256)
        except AppError:
            continue
        cleanup_reference = _cleanup_reference_from_mapping(reference)
        if cleanup_reference is not None:
            references_by_hash.setdefault(normalized_sha256, []).append(cleanup_reference)
        normalized_hashes.add(normalized_sha256)

    for content_sha256 in sorted(normalized_hashes):
        record = session.get(SyncStagedArtifact, content_sha256)
        if record is None:
            continue
        metadata = record.metadata_json if isinstance(record.metadata_json, dict) else {}
        remaining_references = _remove_staging_references(
            _staging_references(metadata),
            references_by_hash.get(content_sha256, []),
        )
        if remaining_references:
            metadata_json = dict(metadata)
            metadata_json[STAGING_REFERENCES_METADATA_KEY] = remaining_references
            record.metadata_json = metadata_json
            record.updated_at = utcnow()
            continue
        if STAGING_REFERENCES_METADATA_KEY in metadata and content_sha256 not in references_by_hash:
            continue
        try:
            resolved_path = _resolve_staged_relative_path(record.relative_path)
        except AppError:
            continue
        try:
            resolved_path.unlink(missing_ok=True)
        except OSError:
            continue
        session.delete(record)
        removed += 1
        _remove_empty_staging_dirs(resolved_path.parent, staging_root)

    session.flush()
    return removed


def require_staged_artifact(
    session: Session,
    *,
    content_sha256: str,
    size_bytes: int | None = None,
) -> SyncStagedArtifactDTO:
    normalized_sha256 = _normalize_content_sha256(content_sha256)
    if size_bytes is not None:
        _validate_size_bytes(size_bytes)
    record = session.get(SyncStagedArtifact, normalized_sha256)
    if record is None:
        raise AppError(
            "SYNC_STAGING_ARTIFACT_NOT_FOUND",
            "Sync artifact has not been staged locally.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"content_sha256": normalized_sha256},
        )
    return _verify_staged_record(record, expected_size_bytes=size_bytes)


def _normalize_content_sha256(content_sha256: str) -> str:
    normalized = content_sha256.strip().lower()
    if len(normalized) != 64 or any(character not in HEX_DIGITS for character in normalized):
        raise AppError(
            "SYNC_STAGING_HASH_INVALID",
            "Sync staged artifact content_sha256 must be a full SHA-256 hex digest.",
            details={"content_sha256": content_sha256},
        )
    return normalized


def _validate_size_bytes(size_bytes: int) -> None:
    if size_bytes < 0:
        raise AppError(
            "SYNC_STAGING_SIZE_INVALID",
            "Sync staged artifact size_bytes must be non-negative.",
            details={"size_bytes": size_bytes},
        )


def _verify_source_file(source_path: Path, *, content_sha256: str, size_bytes: int) -> None:
    actual_size = _file_size(source_path)
    if actual_size is None:
        _raise_source_unreadable(source_path)
    if actual_size != size_bytes:
        raise AppError(
            "SYNC_STAGING_SOURCE_SIZE_MISMATCH",
            "Source artifact size does not match the requested staged artifact size.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "source_path": str(source_path),
                "expected_size_bytes": size_bytes,
                "actual_size_bytes": actual_size,
            },
        )

    actual_sha256 = file_sha256(source_path)
    if actual_sha256 is None:
        _raise_source_unreadable(source_path)
    if actual_sha256 != content_sha256:
        raise AppError(
            "SYNC_STAGING_SOURCE_HASH_MISMATCH",
            "Source artifact SHA-256 does not match the requested staged artifact hash.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "source_path": str(source_path),
                "expected_sha256": content_sha256,
                "actual_sha256": actual_sha256,
            },
        )


def _verify_staged_record(
    record: SyncStagedArtifact,
    *,
    expected_size_bytes: int | None,
) -> SyncStagedArtifactDTO:
    resolved_path = _resolve_staged_relative_path(record.relative_path)
    if expected_size_bytes is not None and record.size_bytes != expected_size_bytes:
        raise AppError(
            "SYNC_STAGING_RECORD_SIZE_MISMATCH",
            "Staged artifact record size does not match the requested size.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "content_sha256": record.content_sha256,
                "expected_size_bytes": expected_size_bytes,
                "actual_size_bytes": record.size_bytes,
            },
        )

    actual_size = _file_size(resolved_path)
    if actual_size is None:
        raise AppError(
            "SYNC_STAGING_FILE_MISSING",
            "Staged sync artifact file is missing or unreadable.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"content_sha256": record.content_sha256, "relative_path": record.relative_path},
        )
    if actual_size != record.size_bytes:
        raise AppError(
            "SYNC_STAGING_FILE_SIZE_MISMATCH",
            "Staged sync artifact file size does not match its database record.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "content_sha256": record.content_sha256,
                "relative_path": record.relative_path,
                "expected_size_bytes": record.size_bytes,
                "actual_size_bytes": actual_size,
            },
        )

    actual_sha256 = file_sha256(resolved_path)
    if actual_sha256 != record.content_sha256:
        raise AppError(
            "SYNC_STAGING_FILE_HASH_MISMATCH",
            "Staged sync artifact file SHA-256 does not match its database record.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "content_sha256": record.content_sha256,
                "relative_path": record.relative_path,
                "expected_sha256": record.content_sha256,
                "actual_sha256": actual_sha256,
            },
        )

    return _to_dto(record, resolved_path)


def _copy_verified_source(source_path: Path, destination_path: Path) -> None:
    temp_path: Path | None = None
    try:
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination_path.name}.",
            suffix=".tmp",
            dir=destination_path.parent,
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        shutil.copy2(source_path, temp_path)
        temp_path.replace(destination_path)
    except OSError as exc:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        raise AppError(
            "SYNC_STAGING_COPY_FAILED",
            "Source artifact could not be copied into sync staging.",
            details={"source_path": str(source_path), "destination_path": str(destination_path)},
        ) from exc


def _relative_path_for_hash(content_sha256: str) -> str:
    return str(PurePosixPath("sha256", content_sha256[:2], content_sha256))


def _staging_root() -> Path:
    return get_settings().data_root / "sync" / "staging"


def _resolve_staged_relative_path(relative_path: str) -> Path:
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise AppError(
            "SYNC_STAGING_RELATIVE_PATH_INVALID",
            "Staged sync artifact record contains an invalid relative path.",
            status_code=status.HTTP_409_CONFLICT,
            details={"relative_path": relative_path},
        )
    root = _staging_root().resolve(strict=False)
    resolved = (root / Path(relative_path)).resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise AppError(
            "SYNC_STAGING_RELATIVE_PATH_INVALID",
            "Staged sync artifact record points outside the sync staging root.",
            status_code=status.HTTP_409_CONFLICT,
            details={"relative_path": relative_path},
        ) from exc
    return resolved


def _staged_path_matches(destination_path: Path, *, content_sha256: str, size_bytes: int) -> bool:
    actual_size = _file_size(destination_path)
    if actual_size != size_bytes:
        return False
    return file_sha256(destination_path) == content_sha256


def _file_size(path: Path) -> int | None:
    try:
        if not path.is_file():
            return None
        return path.stat().st_size
    except OSError:
        return None


def _reference_from_metadata(
    metadata: Mapping[str, Any] | None,
    provider_device_id: str | None,
) -> dict[str, str] | None:
    if metadata is None:
        return None
    project_id = metadata.get("project_id")
    artifact_id = metadata.get("artifact_id")
    if not isinstance(project_id, str) or not project_id:
        return None
    if not isinstance(artifact_id, str) or not artifact_id:
        return None
    reference = {"project_id": project_id, "artifact_id": artifact_id}
    if isinstance(provider_device_id, str) and provider_device_id:
        reference["provider_device_id"] = provider_device_id
    return reference


def _cleanup_reference_from_mapping(reference: Mapping[str, Any]) -> dict[str, str] | None:
    project_id = reference.get("project_id")
    artifact_id = reference.get("artifact_id")
    if not isinstance(project_id, str) or not project_id:
        return None
    if not isinstance(artifact_id, str) or not artifact_id:
        return None
    cleanup_reference = {"project_id": project_id, "artifact_id": artifact_id}
    provider_device_id = reference.get("provider_device_id")
    if isinstance(provider_device_id, str) and provider_device_id:
        cleanup_reference["provider_device_id"] = provider_device_id
    return cleanup_reference


def _staging_references(metadata: Mapping[str, Any]) -> list[dict[str, str]]:
    raw_references = metadata.get(STAGING_REFERENCES_METADATA_KEY)
    if not isinstance(raw_references, list):
        return []
    references: list[dict[str, str]] = []
    for raw_reference in raw_references:
        if isinstance(raw_reference, Mapping):
            reference = _cleanup_reference_from_mapping(raw_reference)
            if reference is not None:
                references.append(reference)
    return references


def _merge_staging_references(
    references: list[dict[str, str]],
    next_reference: dict[str, str],
) -> list[dict[str, str]]:
    if any(_same_reference(reference, next_reference) for reference in references):
        return references
    return [*references, next_reference]


def _remove_staging_references(
    references: list[dict[str, str]],
    cleanup_references: list[dict[str, str]],
) -> list[dict[str, str]]:
    if not cleanup_references:
        return references
    return [
        reference
        for reference in references
        if not any(_same_reference(reference, cleanup_reference) for cleanup_reference in cleanup_references)
    ]


def _same_reference(left: Mapping[str, str], right: Mapping[str, str]) -> bool:
    return (
        left.get("project_id") == right.get("project_id")
        and left.get("artifact_id") == right.get("artifact_id")
        and (
            "provider_device_id" not in left
            or "provider_device_id" not in right
            or left.get("provider_device_id") == right.get("provider_device_id")
        )
    )


def _remove_empty_staging_dirs(path: Path, staging_root: Path) -> None:
    current = path.resolve(strict=False)
    while current != staging_root:
        try:
            current.relative_to(staging_root)
        except ValueError:
            return
        with suppress(OSError):
            current.rmdir()
        parent = current.parent
        if parent == current:
            return
        current = parent


def _raise_source_unreadable(source_path: Path) -> None:
    try:
        exists = source_path.exists()
    except OSError:
        exists = False
    if not exists:
        raise AppError(
            "SYNC_STAGING_SOURCE_FILE_MISSING",
            "Source artifact file does not exist.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"source_path": str(source_path)},
        )
    raise AppError(
        "SYNC_STAGING_SOURCE_FILE_UNREADABLE",
        "Source artifact file is not readable.",
        details={"source_path": str(source_path)},
    )


def _to_dto(record: SyncStagedArtifact, resolved_path: Path) -> SyncStagedArtifactDTO:
    metadata = record.metadata_json if isinstance(record.metadata_json, dict) else {}
    public_metadata = dict(metadata)
    public_metadata.pop(STAGING_REFERENCES_METADATA_KEY, None)
    return SyncStagedArtifactDTO(
        content_sha256=record.content_sha256,
        size_bytes=record.size_bytes,
        relative_path=record.relative_path,
        provider_device_id=record.provider_device_id,
        metadata=public_metadata,
        verified_at=record.verified_at,
        created_at=record.created_at,
        updated_at=record.updated_at,
        resolved_path=resolved_path,
    )
