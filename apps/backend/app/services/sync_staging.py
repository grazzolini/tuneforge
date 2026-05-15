from __future__ import annotations

import shutil
import tempfile
from collections.abc import Mapping
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

    now = utcnow()
    record = session.get(SyncStagedArtifact, normalized_sha256)
    if record is None:
        record = SyncStagedArtifact(
            content_sha256=normalized_sha256,
            size_bytes=size_bytes,
            relative_path=relative_path,
            provider_device_id=provider_device_id,
            metadata_json=dict(metadata) if metadata is not None else {},
            verified_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(record)
    else:
        record.size_bytes = size_bytes
        record.relative_path = relative_path
        record.provider_device_id = provider_device_id
        if metadata is not None:
            record.metadata_json = dict(metadata)
        elif record.metadata_json is None:
            record.metadata_json = {}
        record.verified_at = now
        record.updated_at = now

    session.flush()
    return _verify_staged_record(record, expected_size_bytes=size_bytes)


def get_staged_artifact_path(session: Session, *, content_sha256: str) -> Path:
    return require_staged_artifact(session, content_sha256=content_sha256).resolved_path


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
    return SyncStagedArtifactDTO(
        content_sha256=record.content_sha256,
        size_bytes=record.size_bytes,
        relative_path=record.relative_path,
        provider_device_id=record.provider_device_id,
        metadata=dict(metadata),
        verified_at=record.verified_at,
        created_at=record.created_at,
        updated_at=record.updated_at,
        resolved_path=resolved_path,
    )
