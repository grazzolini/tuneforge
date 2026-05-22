from __future__ import annotations

import json
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import UTC, datetime
from json import JSONDecodeError
from pathlib import Path, PurePosixPath
from typing import Any, cast

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Artifact, Project, SyncTrustedPeer
from app.services.sync_manifest import (
    SyncArtifactManifest,
    SyncProjectManifest,
    _coerce_project_manifest,
    _validate_project_manifest_schema_version,
    export_project_manifest,
)
from app.services.sync_reconciliation_apply import (
    SyncReconciliationApplyResult,
    apply_sync_reconciliation,
)
from app.services.sync_staging import stage_sync_artifact
from app.services.sync_trust import get_or_create_local_identity
from app.utils.hashing import file_sha256

SYNC_BUNDLE_KIND = "tuneforge.sync_bundle"
SYNC_BUNDLE_VERSION = "1"
SYNC_BUNDLE_METADATA_FILE = "bundle.json"
DEFAULT_PROVIDER_DEVICE_ID = "sync-bundle"
HEX_DIGITS = frozenset("0123456789abcdef")
SYNC_BUNDLE_ALLOWED_TOP_LEVEL_NAMES = frozenset(
    {SYNC_BUNDLE_METADATA_FILE, "projects", "blobs"}
)
SYNC_BUNDLE_ALLOWED_SYNC_METADATA_NAMES = frozenset({".stfolder", ".stignore"})
SYNC_BUNDLE_UNSAFE_NAME_FRAGMENTS = (
    "sqlite",
    "settings",
    "appdata",
    "app-data",
)
SYNC_BUNDLE_UNSAFE_NAMES = frozenset(
    {
        ".tuneforge",
        "cache",
        "caches",
        "log",
        "logs",
        "models",
        "model",
        "application support",
    }
)
SYNC_BUNDLE_UNSAFE_SUFFIXES = frozenset(
    {
        ".bin",
        ".cache",
        ".ckpt",
        ".db",
        ".db3",
        ".log",
        ".model",
        ".onnx",
        ".pickle",
        ".pkl",
        ".pt",
        ".pth",
        ".safetensors",
        ".shm",
        ".sqlite",
        ".sqlite3",
        ".wal",
    }
)


@dataclass(frozen=True)
class SyncBundleProjectEntry:
    project_id: str
    path: str
    content_sha256: str
    size_bytes: int


@dataclass(frozen=True)
class SyncBundleBlobEntry:
    content_sha256: str
    size_bytes: int
    path: str
    project_ids: list[str] = field(default_factory=list)
    artifact_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SyncBundleExportResult:
    bundle_root: Path
    metadata_path: Path
    project_manifests: list[SyncBundleProjectEntry]
    blobs: list[SyncBundleBlobEntry]
    peer_inventory: list[dict[str, Any]]

    @property
    def project_count(self) -> int:
        return len(self.project_manifests)

    @property
    def artifact_count(self) -> int:
        return len(self.blobs)

    @property
    def blob_count(self) -> int:
        return len(self.blobs)

    @property
    def total_bytes(self) -> int:
        return sum(blob.size_bytes for blob in self.blobs)

    @property
    def content_sha256s(self) -> list[str]:
        return [blob.content_sha256 for blob in self.blobs]


@dataclass(frozen=True)
class SyncBundleImportResult:
    bundle_root: Path
    metadata_path: Path
    project_manifests: list[SyncProjectManifest]
    staged_artifact_count: int
    total_bytes: int
    apply_result: SyncReconciliationApplyResult
    peer_inventory: list[dict[str, Any]]

    @property
    def project_count(self) -> int:
        return len(self.project_manifests)

    @property
    def blob_count(self) -> int:
        return self.staged_artifact_count


def export_sync_bundle(
    session: Session,
    *,
    bundle_root: Path | str,
    project_ids: Sequence[str] | None = None,
    provider_device_id: str | None = None,
) -> SyncBundleExportResult:
    root = _export_bundle_root(bundle_root)
    _validate_export_bundle_root(root)
    root.mkdir(parents=True, exist_ok=True)
    _ensure_bundle_directory(root, "projects", label="projects directory")
    _ensure_bundle_directory(root, "blobs/sha256", label="blob directory")

    selected_project_ids = _project_ids_for_export(session, project_ids)
    project_entries: list[SyncBundleProjectEntry] = []
    blob_refs: dict[str, dict[str, set[str] | int | str]] = {}

    for project_id in selected_project_ids:
        manifest = export_project_manifest(session, project_id=project_id)
        manifest_payload = cast(dict[str, Any], _jsonable(manifest))

        manifest_relative_path = f"projects/{project_id}.json"
        manifest_path = _safe_bundle_write_path(
            root,
            manifest_relative_path,
            label="project manifest path",
        )
        _write_json_file(manifest_path, manifest_payload)
        manifest_hash, manifest_size = _verified_file_hash_and_size(
            manifest_path,
            expected_kind="project manifest",
        )
        project_entries.append(
            SyncBundleProjectEntry(
                project_id=project_id,
                path=manifest_relative_path,
                content_sha256=manifest_hash,
                size_bytes=manifest_size,
            )
        )

        for artifact_manifest in manifest.artifacts:
            source_path = _source_artifact_path(session, artifact_manifest)
            blob_path = _copy_blob(
                source_path,
                root=root,
                artifact=artifact_manifest,
            )
            refs = blob_refs.setdefault(
                artifact_manifest.content_sha256,
                {
                    "size_bytes": artifact_manifest.size_bytes,
                    "project_ids": set(),
                    "artifact_ids": set(),
                    "path": blob_path,
                },
            )
            if refs["size_bytes"] != artifact_manifest.size_bytes or refs["path"] != blob_path:
                raise AppError(
                    "SYNC_BUNDLE_DUPLICATE_BLOB_CONFLICT",
                    "Bundle contains conflicting metadata for the same content blob.",
                    status_code=status.HTTP_409_CONFLICT,
                    details={"content_sha256": artifact_manifest.content_sha256},
                )
            cast(set[str], refs["project_ids"]).add(artifact_manifest.project_id)
            cast(set[str], refs["artifact_ids"]).add(artifact_manifest.artifact_id)

    blobs = [
        SyncBundleBlobEntry(
            content_sha256=content_sha256,
            size_bytes=cast(int, refs["size_bytes"]),
            path=cast(str, refs["path"]),
            project_ids=sorted(cast(set[str], refs["project_ids"])),
            artifact_ids=sorted(cast(set[str], refs["artifact_ids"])),
        )
        for content_sha256, refs in sorted(blob_refs.items())
    ]
    content_sha256s = [blob.content_sha256 for blob in blobs]
    peer_inventory = _peer_inventory(
        provider_device_id or DEFAULT_PROVIDER_DEVICE_ID,
        content_sha256s,
    )
    metadata = {
        "kind": SYNC_BUNDLE_KIND,
        "version": SYNC_BUNDLE_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "provider_device_id": provider_device_id,
        "project_manifests": _jsonable(project_entries),
        "blobs": _jsonable(blobs),
        "content_sha256s": content_sha256s,
        "peer_inventory": peer_inventory,
    }
    metadata_path = _safe_bundle_write_path(
        root,
        SYNC_BUNDLE_METADATA_FILE,
        label="bundle metadata path",
    )
    _write_json_file(metadata_path, cast(dict[str, Any], metadata))

    return SyncBundleExportResult(
        bundle_root=root,
        metadata_path=metadata_path,
        project_manifests=project_entries,
        blobs=blobs,
        peer_inventory=peer_inventory,
    )


def import_sync_bundle(
    session: Session,
    *,
    bundle_root: Path | str,
    provider_device_id: str | None = None,
) -> SyncBundleImportResult:
    root = _bundle_root(bundle_root)
    metadata_path = root / SYNC_BUNDLE_METADATA_FILE
    metadata = _read_json_object(metadata_path, label="bundle metadata")
    _validate_bundle_metadata(metadata)
    stage_provider = _trusted_bundle_provider_device_id(
        session,
        metadata=metadata,
        provider_device_id=provider_device_id,
    )

    manifests, manifest_payloads = _read_bundle_manifests(root, metadata)
    blob_entries = _bundle_blob_entries(metadata)
    required_blobs = _required_blobs(manifests)
    required_hashes = set(required_blobs)
    _validate_blob_inventory(blob_entries, required_blobs)
    _validate_metadata_content_hashes(metadata, required_hashes)
    _validate_metadata_peer_inventory(metadata, required_hashes)
    _validate_selected_provider_peer_inventory(metadata, stage_provider, required_hashes)

    staged_count = 0
    for content_sha256, artifact in sorted(required_blobs.items()):
        blob = blob_entries[content_sha256]
        blob_path = _safe_bundle_path(root, blob["path"], label="blob path")
        _verify_blob_file(
            blob_path,
            content_sha256=content_sha256,
            size_bytes=artifact.size_bytes,
        )
        stage_sync_artifact(
            session,
            source_path=blob_path,
            content_sha256=content_sha256,
            size_bytes=artifact.size_bytes,
            provider_device_id=stage_provider,
            metadata={
                "source": "sync_bundle",
                "project_id": artifact.project_id,
                "artifact_id": artifact.artifact_id,
            },
        )
        staged_count += 1

    peer_inventory = _peer_inventory(stage_provider, sorted(required_blobs))
    apply_result = apply_sync_reconciliation(
        session,
        {
            "remote_library": _remote_library_from_manifests(manifest_payloads, peer_inventory),
            "project_manifests": manifest_payloads,
            "peer_inventory": peer_inventory,
            "use_content_addressed_staging": True,
        },
    )

    return SyncBundleImportResult(
        bundle_root=root,
        metadata_path=metadata_path,
        project_manifests=manifests,
        staged_artifact_count=staged_count,
        total_bytes=sum(blob["size_bytes"] for blob in blob_entries.values()),
        apply_result=apply_result,
        peer_inventory=peer_inventory,
    )


def _bundle_root(bundle_root: Path | str) -> Path:
    return Path(bundle_root).expanduser().resolve(strict=False)


def _export_bundle_root(bundle_root: Path | str) -> Path:
    root = Path(bundle_root).expanduser()
    if not root.is_absolute():
        root = Path.cwd() / root
    if root.is_symlink():
        raise _unsafe_export_root("Sync bundle root must not be a symlink.", path=root)
    return root.resolve(strict=False)


def _validate_export_bundle_root(root: Path) -> None:
    if not root.exists():
        return
    if root.is_symlink():
        raise _unsafe_export_root(
            "Sync bundle root must not be a symlink.",
            path=root,
        )
    if not root.is_dir():
        raise AppError(
            "SYNC_BUNDLE_EXPORT_ROOT_INVALID",
            "Sync bundle root must be a directory.",
            details={"path": str(root)},
        )

    try:
        existing_paths = sorted(root.rglob("*"), key=lambda path: path.as_posix())
    except OSError as exc:
        raise AppError(
            "SYNC_BUNDLE_EXPORT_ROOT_UNREADABLE",
            "Existing sync bundle root could not be inspected safely.",
            details={"path": str(root)},
        ) from exc

    for path in existing_paths:
        relative_path = path.relative_to(root)
        _validate_export_bundle_path(root, path, relative_path)


def _validate_export_bundle_path(root: Path, path: Path, relative_path: Path) -> None:
    if path.is_symlink():
        raise _unsafe_export_root(
            "Existing sync bundle root contains a symlink.",
            path=path,
            relative_path=relative_path,
        )

    _reject_unsafe_export_name(path, relative_path)

    parts = relative_path.parts
    if not parts:
        return

    top_level_name = parts[0]
    if top_level_name in SYNC_BUNDLE_ALLOWED_SYNC_METADATA_NAMES:
        _validate_export_sync_metadata_path(path, relative_path)
        return

    if top_level_name not in SYNC_BUNDLE_ALLOWED_TOP_LEVEL_NAMES:
        raise _unsafe_export_root(
            "Existing sync bundle root contains an unexpected top-level entry.",
            path=path,
            relative_path=relative_path,
        )

    if len(parts) == 1:
        if top_level_name == SYNC_BUNDLE_METADATA_FILE:
            if not path.is_file():
                raise _unsafe_export_root(
                    "Existing sync bundle metadata entry must be a file.",
                    path=path,
                    relative_path=relative_path,
                )
            return
        if not path.is_dir():
            raise _unsafe_export_root(
                "Existing sync bundle layout entry must be a directory.",
                path=path,
                relative_path=relative_path,
            )
        return

    if top_level_name == "projects":
        _validate_export_project_path(path, relative_path)
        return

    if top_level_name == "blobs":
        _validate_export_blob_path(path, relative_path)
        return

    raise _unsafe_export_root(
        "Existing sync bundle root contains an unexpected entry.",
        path=path,
        relative_path=relative_path,
    )


def _validate_export_sync_metadata_path(path: Path, relative_path: Path) -> None:
    parts = relative_path.parts
    if parts[0] == ".stignore":
        if len(parts) == 1 and path.is_file():
            return
        raise _unsafe_export_root(
            "Existing sync bundle .stignore entry must be a file.",
            path=path,
            relative_path=relative_path,
        )

    if parts[0] == ".stfolder":
        if len(parts) == 1 and (path.is_dir() or path.is_file()):
            return
    raise _unsafe_export_root(
        "Existing sync bundle Syncthing metadata entry is invalid.",
        path=path,
        relative_path=relative_path,
    )


def _validate_export_project_path(path: Path, relative_path: Path) -> None:
    parts = relative_path.parts
    if len(parts) != 2 or not path.is_file() or Path(parts[1]).suffix != ".json":
        raise _unsafe_export_root(
            "Existing sync bundle projects directory contains an unexpected entry.",
            path=path,
            relative_path=relative_path,
        )


def _validate_export_blob_path(path: Path, relative_path: Path) -> None:
    parts = relative_path.parts
    if len(parts) == 2:
        if parts[1] == "sha256" and path.is_dir():
            return
        raise _unsafe_export_root(
            "Existing sync bundle blobs directory contains an unexpected entry.",
            path=path,
            relative_path=relative_path,
        )

    if parts[1] != "sha256":
        raise _unsafe_export_root(
            "Existing sync bundle blobs directory contains an unexpected entry.",
            path=path,
            relative_path=relative_path,
        )

    if len(parts) == 3:
        if _is_sha256_prefix(parts[2]) and path.is_dir():
            return
        raise _unsafe_export_root(
            "Existing sync bundle sha256 directory contains an unexpected entry.",
            path=path,
            relative_path=relative_path,
        )

    if len(parts) == 4:
        if not _is_sha256_digest(parts[3]):
            raise _unsafe_export_root(
                "Existing sync bundle sha256 directory contains an unexpected blob entry.",
                path=path,
                relative_path=relative_path,
            )
        content_sha256 = parts[3].lower()
        if parts[2] == content_sha256[:2] and path.is_file():
            return
        raise _unsafe_export_root(
            "Existing sync bundle sha256 directory contains an unexpected blob entry.",
            path=path,
            relative_path=relative_path,
        )

    raise _unsafe_export_root(
        "Existing sync bundle blobs directory contains an unexpected nested entry.",
        path=path,
        relative_path=relative_path,
    )


def _reject_unsafe_export_name(path: Path, relative_path: Path) -> None:
    for part in relative_path.parts:
        normalized = part.casefold()
        suffix = Path(part).suffix.casefold()
        if (
            normalized in SYNC_BUNDLE_UNSAFE_NAMES
            or suffix in SYNC_BUNDLE_UNSAFE_SUFFIXES
            or any(fragment in normalized for fragment in SYNC_BUNDLE_UNSAFE_NAME_FRAGMENTS)
        ):
            raise _unsafe_export_root(
                "Existing sync bundle root contains unsafe app data.",
                path=path,
                relative_path=relative_path,
            )


def _unsafe_export_root(
    message: str,
    *,
    path: Path,
    relative_path: Path | None = None,
) -> AppError:
    details = {"path": str(path)}
    if relative_path is not None:
        details["relative_path"] = relative_path.as_posix()
    return AppError(
        "SYNC_BUNDLE_EXPORT_ROOT_UNSAFE",
        message,
        status_code=status.HTTP_409_CONFLICT,
        details=details,
    )


def _ensure_bundle_directory(root: Path, relative_path: str, *, label: str) -> None:
    directory = _safe_bundle_write_path(root, relative_path, label=label)
    if directory.exists() and not directory.is_dir():
        raise _unsafe_export_root(
            "Sync bundle path exists but is not a directory.",
            path=directory,
            relative_path=Path(relative_path),
        )
    directory.mkdir(parents=True, exist_ok=True)


def _project_ids_for_export(
    session: Session,
    project_ids: Sequence[str] | None,
) -> list[str]:
    if project_ids is None:
        return list(
            session.scalars(
                select(Project.id)
                .where(Project.sync_status != "deleted")
                .order_by(Project.created_at.asc(), Project.id.asc())
            )
        )

    selected: list[str] = []
    seen: set[str] = set()
    for project_id in project_ids:
        normalized = project_id.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        selected.append(normalized)
    return selected


def _source_artifact_path(
    session: Session,
    artifact_manifest: SyncArtifactManifest,
) -> Path:
    artifact = session.get(Artifact, artifact_manifest.artifact_id)
    if artifact is None or artifact.project_id != artifact_manifest.project_id:
        raise AppError(
            "SYNC_BUNDLE_ARTIFACT_MISSING",
            "Artifact listed by the sync manifest is missing from local storage metadata.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={
                "artifact_id": artifact_manifest.artifact_id,
                "project_id": artifact_manifest.project_id,
            },
        )
    if artifact.content_sha256 != artifact_manifest.content_sha256:
        raise AppError(
            "SYNC_BUNDLE_ARTIFACT_HASH_MISMATCH",
            "Artifact metadata changed after sync manifest export.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "artifact_id": artifact_manifest.artifact_id,
                "expected_sha256": artifact_manifest.content_sha256,
                "actual_sha256": artifact.content_sha256,
            },
        )
    if artifact.size_bytes != artifact_manifest.size_bytes:
        raise AppError(
            "SYNC_BUNDLE_ARTIFACT_SIZE_MISMATCH",
            "Artifact size metadata changed after sync manifest export.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "artifact_id": artifact_manifest.artifact_id,
                "expected_size_bytes": artifact_manifest.size_bytes,
                "actual_size_bytes": artifact.size_bytes,
            },
        )
    return Path(artifact.path).expanduser().resolve(strict=False)


def _copy_blob(
    source_path: Path,
    *,
    root: Path,
    artifact: SyncArtifactManifest,
) -> str:
    actual_size = _file_size(source_path)
    if actual_size is None:
        raise AppError(
            "SYNC_BUNDLE_SOURCE_BLOB_MISSING",
            "Artifact bytes listed by the sync manifest are missing.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={
                "artifact_id": artifact.artifact_id,
                "project_id": artifact.project_id,
            },
        )
    if actual_size != artifact.size_bytes:
        raise AppError(
            "SYNC_BUNDLE_SOURCE_BLOB_SIZE_MISMATCH",
            "Artifact bytes do not match sync manifest size.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "artifact_id": artifact.artifact_id,
                "expected_size_bytes": artifact.size_bytes,
                "actual_size_bytes": actual_size,
            },
        )
    actual_hash = file_sha256(source_path)
    if actual_hash != artifact.content_sha256:
        raise AppError(
            "SYNC_BUNDLE_SOURCE_BLOB_HASH_MISMATCH",
            "Artifact bytes do not match sync manifest SHA-256.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "artifact_id": artifact.artifact_id,
                "expected_sha256": artifact.content_sha256,
                "actual_sha256": actual_hash,
            },
        )

    relative_path = _blob_relative_path(artifact.content_sha256)
    destination = _safe_bundle_write_path(root, relative_path, label="blob path")
    if destination.exists():
        _verify_blob_file(
            destination,
            content_sha256=artifact.content_sha256,
            size_bytes=artifact.size_bytes,
            conflict_code="SYNC_BUNDLE_DUPLICATE_BLOB_CONFLICT",
        )
        return relative_path

    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(source_path, destination)
    except OSError as exc:
        raise AppError(
            "SYNC_BUNDLE_BLOB_COPY_FAILED",
            "Artifact bytes could not be copied into the sync bundle.",
            details={"artifact_id": artifact.artifact_id},
        ) from exc
    _verify_blob_file(
        destination,
        content_sha256=artifact.content_sha256,
        size_bytes=artifact.size_bytes,
    )
    return relative_path


def _read_bundle_manifests(
    root: Path,
    metadata: Mapping[str, Any],
) -> tuple[list[SyncProjectManifest], list[dict[str, Any]]]:
    manifests: list[SyncProjectManifest] = []
    payloads: list[dict[str, Any]] = []
    for entry in _project_entries(metadata):
        project_id = _required_string(entry, "project_id", label="project manifest entry")
        expected_path = f"projects/{project_id}.json"
        relative_path = _required_string(entry, "path", label="project manifest entry")
        if relative_path != expected_path:
            raise AppError(
                "SYNC_BUNDLE_PROJECT_MANIFEST_PATH_INVALID",
                "Bundle project manifest path does not match the expected layout.",
                details={"project_id": project_id, "path": relative_path},
            )
        manifest_path = _safe_bundle_path(root, relative_path, label="project manifest path")
        _verify_blob_file(
            manifest_path,
            content_sha256=_required_sha256(entry, "content_sha256"),
            size_bytes=_required_int(entry, "size_bytes", label="project manifest entry"),
            missing_code="SYNC_BUNDLE_PROJECT_MANIFEST_MISSING",
            size_code="SYNC_BUNDLE_PROJECT_MANIFEST_SIZE_MISMATCH",
            hash_code="SYNC_BUNDLE_PROJECT_MANIFEST_HASH_MISMATCH",
        )
        payload = _read_json_object(manifest_path, label="project manifest")
        manifest = _coerce_project_manifest(payload)
        _validate_project_manifest_schema_version(manifest)
        if manifest.project_id != project_id:
            raise AppError(
                "SYNC_BUNDLE_PROJECT_MANIFEST_ID_MISMATCH",
                "Bundle project manifest ID does not match bundle metadata.",
                details={
                    "expected_project_id": project_id,
                    "actual_project_id": manifest.project_id,
                },
            )
        manifests.append(manifest)
        payloads.append(payload)
    return manifests, payloads


def _validate_bundle_metadata(metadata: Mapping[str, Any]) -> None:
    if metadata.get("kind") != SYNC_BUNDLE_KIND:
        raise AppError(
            "SYNC_BUNDLE_KIND_INVALID",
            "Sync bundle metadata kind is not supported.",
            details={"kind": metadata.get("kind")},
        )
    if metadata.get("version") != SYNC_BUNDLE_VERSION:
        raise AppError(
            "SYNC_BUNDLE_VERSION_UNSUPPORTED",
            "Sync bundle metadata version is not supported.",
            details={
                "version": metadata.get("version"),
                "supported_version": SYNC_BUNDLE_VERSION,
            },
        )
    _project_entries(metadata)
    _bundle_blob_entries(metadata)
    if not isinstance(metadata.get("content_sha256s"), list):
        raise AppError(
            "SYNC_BUNDLE_CONTENT_HASHES_INVALID",
            "Sync bundle content_sha256s must be a list.",
        )
    if not isinstance(metadata.get("peer_inventory"), list):
        raise AppError(
            "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
            "Sync bundle peer_inventory must be a list.",
        )


def _project_entries(metadata: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    entries = metadata.get("project_manifests")
    if not isinstance(entries, list):
        raise AppError(
            "SYNC_BUNDLE_PROJECT_MANIFESTS_INVALID",
            "Sync bundle project_manifests must be a list.",
        )
    result: list[Mapping[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise AppError(
                "SYNC_BUNDLE_PROJECT_MANIFESTS_INVALID",
                "Sync bundle project manifest entries must be objects.",
            )
        result.append(entry)
    return result


def _bundle_blob_entries(metadata: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    raw_blobs = metadata.get("blobs")
    if not isinstance(raw_blobs, list):
        raise AppError(
            "SYNC_BUNDLE_BLOBS_INVALID",
            "Sync bundle blobs must be a list.",
        )

    blobs: dict[str, dict[str, Any]] = {}
    for raw_blob in raw_blobs:
        if not isinstance(raw_blob, Mapping):
            raise AppError(
                "SYNC_BUNDLE_BLOBS_INVALID",
                "Sync bundle blob entries must be objects.",
            )
        content_sha256 = _required_sha256(raw_blob, "content_sha256")
        size_bytes = _required_int(raw_blob, "size_bytes", label="blob entry")
        if size_bytes < 0:
            raise AppError(
                "SYNC_BUNDLE_BLOB_SIZE_INVALID",
                "Sync bundle blob size_bytes must be non-negative.",
                details={"content_sha256": content_sha256, "size_bytes": size_bytes},
            )
        path = _required_string(raw_blob, "path", label="blob entry")
        if path != _blob_relative_path(content_sha256):
            raise AppError(
                "SYNC_BUNDLE_BLOB_PATH_INVALID",
                "Sync bundle blob path does not match the expected layout.",
                details={"content_sha256": content_sha256, "path": path},
            )
        existing = blobs.get(content_sha256)
        if existing is not None and (
            existing["size_bytes"] != size_bytes or existing["path"] != path
        ):
            raise AppError(
                "SYNC_BUNDLE_DUPLICATE_BLOB_CONFLICT",
                "Bundle contains conflicting metadata for the same content blob.",
                status_code=status.HTTP_409_CONFLICT,
                details={"content_sha256": content_sha256},
            )
        blobs[content_sha256] = {
            "content_sha256": content_sha256,
            "size_bytes": size_bytes,
            "path": path,
        }
    return blobs


def _required_blobs(
    manifests: Sequence[SyncProjectManifest],
) -> dict[str, SyncArtifactManifest]:
    required: dict[str, SyncArtifactManifest] = {}
    sizes: dict[str, int] = {}
    for manifest in manifests:
        for artifact in manifest.artifacts:
            existing_size = sizes.get(artifact.content_sha256)
            if existing_size is not None and existing_size != artifact.size_bytes:
                raise AppError(
                    "SYNC_BUNDLE_DUPLICATE_BLOB_CONFLICT",
                    "Project manifests contain conflicting sizes for the same content blob.",
                    status_code=status.HTTP_409_CONFLICT,
                    details={"content_sha256": artifact.content_sha256},
                )
            sizes[artifact.content_sha256] = artifact.size_bytes
            required.setdefault(artifact.content_sha256, artifact)
    return required


def _validate_blob_inventory(
    blob_entries: Mapping[str, Mapping[str, Any]],
    required_blobs: Mapping[str, SyncArtifactManifest],
) -> None:
    bundle_hashes = set(blob_entries)
    required_hashes = set(required_blobs)
    if bundle_hashes != required_hashes:
        raise AppError(
            "SYNC_BUNDLE_BLOB_INVENTORY_MISMATCH",
            "Sync bundle blob inventory does not match project manifests.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "missing_content_sha256s": sorted(required_hashes - bundle_hashes),
                "unreferenced_content_sha256s": sorted(bundle_hashes - required_hashes),
            },
        )
    for content_sha256, artifact in required_blobs.items():
        blob = blob_entries[content_sha256]
        if blob["size_bytes"] != artifact.size_bytes:
            raise AppError(
                "SYNC_BUNDLE_BLOB_SIZE_MISMATCH",
                "Sync bundle blob metadata does not match project manifest size.",
                status_code=status.HTTP_409_CONFLICT,
                details={
                    "content_sha256": content_sha256,
                    "expected_size_bytes": artifact.size_bytes,
                    "actual_size_bytes": blob["size_bytes"],
                },
            )


def _validate_metadata_content_hashes(
    metadata: Mapping[str, Any],
    required_hashes: set[str],
) -> None:
    raw_hashes = metadata.get("content_sha256s")
    if not isinstance(raw_hashes, list):
        raise AppError(
            "SYNC_BUNDLE_CONTENT_HASHES_INVALID",
            "Sync bundle content_sha256s must be a list.",
        )
    content_hashes = {
        _normalize_sha256(content_sha256)
        for content_sha256 in raw_hashes
        if isinstance(content_sha256, str)
    }
    if len(content_hashes) != len(raw_hashes) or content_hashes != required_hashes:
        raise AppError(
            "SYNC_BUNDLE_CONTENT_HASHES_MISMATCH",
            "Sync bundle content_sha256s do not match project manifests.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "missing_content_sha256s": sorted(required_hashes - content_hashes),
                "unreferenced_content_sha256s": sorted(content_hashes - required_hashes),
            },
        )


def _validate_metadata_peer_inventory(
    metadata: Mapping[str, Any],
    required_hashes: set[str],
) -> None:
    raw_inventory = metadata.get("peer_inventory")
    if not isinstance(raw_inventory, list):
        raise AppError(
            "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
            "Sync bundle peer_inventory must be a list.",
        )
    inventory_hashes: set[str] = set()
    for entry in raw_inventory:
        if not isinstance(entry, Mapping):
            raise AppError(
                "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
                "Sync bundle peer_inventory entries must be objects.",
            )
        device_id = entry.get("device_id")
        if not isinstance(device_id, str) or not device_id.strip():
            raise AppError(
                "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
                "Sync bundle peer_inventory entries must include device_id.",
            )
        raw_hashes = entry.get("available_content_sha256")
        if not isinstance(raw_hashes, list):
            raise AppError(
                "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
                "Sync bundle peer_inventory entries must include available_content_sha256.",
            )
        for content_sha256 in raw_hashes:
            if not isinstance(content_sha256, str):
                raise AppError(
                    "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
                    "Sync bundle peer_inventory hashes must be strings.",
                )
            inventory_hashes.add(_normalize_sha256(content_sha256))

    if inventory_hashes != required_hashes:
        raise AppError(
            "SYNC_BUNDLE_PEER_INVENTORY_MISMATCH",
            "Sync bundle peer_inventory does not match project manifests.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "missing_content_sha256s": sorted(required_hashes - inventory_hashes),
                "unreferenced_content_sha256s": sorted(inventory_hashes - required_hashes),
            },
        )


def _validate_selected_provider_peer_inventory(
    metadata: Mapping[str, Any],
    provider_device_id: str,
    required_hashes: set[str],
) -> None:
    raw_inventory = metadata.get("peer_inventory")
    if not isinstance(raw_inventory, list):
        raise AppError(
            "SYNC_BUNDLE_PEER_INVENTORY_INVALID",
            "Sync bundle peer_inventory must be a list.",
        )

    provider_hashes: set[str] | None = None
    for entry in raw_inventory:
        if not isinstance(entry, Mapping):
            continue
        if _normalize_provider_device_id(entry.get("device_id")) != provider_device_id:
            continue

        raw_hashes = entry.get("available_content_sha256")
        if not isinstance(raw_hashes, list):
            continue
        if provider_hashes is None:
            provider_hashes = set()
        for content_sha256 in raw_hashes:
            if isinstance(content_sha256, str):
                provider_hashes.add(_normalize_sha256(content_sha256))

    provider_inventory_found = provider_hashes is not None
    missing_hashes = required_hashes - (provider_hashes or set())
    if provider_inventory_found and not missing_hashes:
        return

    raise AppError(
        "SYNC_BUNDLE_PROVIDER_INVENTORY_MISMATCH",
        "Selected sync bundle provider does not advertise required content hashes.",
        status_code=status.HTTP_409_CONFLICT,
        details={
            "provider_device_id": provider_device_id,
            "provider_inventory_found": provider_inventory_found,
            "missing_content_sha256s": sorted(missing_hashes),
        },
    )


def _verify_blob_file(
    path: Path,
    *,
    content_sha256: str,
    size_bytes: int,
    missing_code: str = "SYNC_BUNDLE_BLOB_MISSING",
    size_code: str = "SYNC_BUNDLE_BLOB_SIZE_MISMATCH",
    hash_code: str = "SYNC_BUNDLE_BLOB_HASH_MISMATCH",
    conflict_code: str | None = None,
) -> None:
    actual_size = _file_size(path)
    if actual_size is None:
        raise AppError(
            missing_code,
            "Sync bundle blob is missing.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"content_sha256": content_sha256},
        )
    if actual_size != size_bytes:
        raise AppError(
            conflict_code or size_code,
            "Sync bundle blob size does not match metadata.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "content_sha256": content_sha256,
                "expected_size_bytes": size_bytes,
                "actual_size_bytes": actual_size,
            },
        )
    actual_hash = file_sha256(path)
    if actual_hash != content_sha256:
        raise AppError(
            conflict_code or hash_code,
            "Sync bundle blob SHA-256 does not match metadata.",
            status_code=status.HTTP_409_CONFLICT,
            details={
                "content_sha256": content_sha256,
                "actual_sha256": actual_hash,
            },
        )


def _verified_file_hash_and_size(path: Path, *, expected_kind: str) -> tuple[str, int]:
    size = _file_size(path)
    content_hash = file_sha256(path)
    if size is None or content_hash is None:
        raise AppError(
            "SYNC_BUNDLE_FILE_UNREADABLE",
            f"Sync bundle {expected_kind} could not be read after writing.",
        )
    return content_hash, size


def _safe_bundle_path(root: Path, relative_path: str, *, label: str) -> Path:
    safe_relative = _safe_bundle_relative_path(relative_path, label=label)
    path = (root / safe_relative).resolve(strict=False)
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise AppError(
            "SYNC_BUNDLE_PATH_INVALID",
            f"Sync bundle {label} escapes the bundle root.",
            details={"path": relative_path},
        ) from exc
    return path


def _safe_bundle_write_path(root: Path, relative_path: str, *, label: str) -> Path:
    safe_relative = _safe_bundle_relative_path(relative_path, label=label)
    path = root / safe_relative
    _reject_write_path_symlinks(root, path)
    resolved_path = path.resolve(strict=False)
    try:
        resolved_path.relative_to(root)
    except ValueError as exc:
        raise AppError(
            "SYNC_BUNDLE_PATH_INVALID",
            f"Sync bundle {label} escapes the bundle root.",
            details={"path": relative_path},
        ) from exc
    return resolved_path


def _reject_write_path_symlinks(root: Path, path: Path) -> None:
    try:
        relative_path = path.relative_to(root)
    except ValueError as exc:
        raise AppError(
            "SYNC_BUNDLE_PATH_INVALID",
            "Sync bundle write path escapes the bundle root.",
            details={"path": str(path)},
        ) from exc

    current = root
    if current.is_symlink():
        raise _unsafe_export_root("Sync bundle root must not be a symlink.", path=current)
    for part in relative_path.parts:
        current = current / part
        if current.is_symlink():
            raise _unsafe_export_root(
                "Sync bundle write path contains a symlink.",
                path=current,
                relative_path=current.relative_to(root),
            )


def _safe_bundle_relative_path(relative_path: str, *, label: str) -> Path:
    if "\x00" in relative_path or "\\" in relative_path:
        raise _invalid_relative_path(relative_path, label=label)
    path = PurePosixPath(relative_path)
    if path.is_absolute() or not path.parts:
        raise _invalid_relative_path(relative_path, label=label)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise _invalid_relative_path(relative_path, label=label)
    return Path(*path.parts)


def _invalid_relative_path(relative_path: str, *, label: str) -> AppError:
    return AppError(
        "SYNC_BUNDLE_PATH_INVALID",
        f"Sync bundle {label} must be a safe relative path.",
        details={"path": relative_path},
    )


def _blob_relative_path(content_sha256: str) -> str:
    normalized = _normalize_sha256(content_sha256)
    return f"blobs/sha256/{normalized[:2]}/{normalized}"


def _normalize_sha256(content_sha256: str) -> str:
    normalized = content_sha256.strip().lower()
    if len(normalized) != 64 or any(character not in HEX_DIGITS for character in normalized):
        raise AppError(
            "SYNC_BUNDLE_HASH_INVALID",
            "Sync bundle content_sha256 must be a full SHA-256 hex digest.",
            details={"content_sha256": content_sha256},
        )
    return normalized


def _is_sha256_prefix(value: str) -> bool:
    return len(value) == 2 and all(character in HEX_DIGITS for character in value)


def _is_sha256_digest(value: str) -> bool:
    normalized = value.lower()
    return len(normalized) == 64 and all(character in HEX_DIGITS for character in normalized)


def _required_sha256(source: Mapping[str, Any], key: str) -> str:
    return _normalize_sha256(_required_string(source, key, label="bundle metadata"))


def _required_string(source: Mapping[str, Any], key: str, *, label: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AppError(
            "SYNC_BUNDLE_FIELD_INVALID",
            f"Sync bundle {label} field is required.",
            details={"field": key},
        )
    return value


def _required_int(source: Mapping[str, Any], key: str, *, label: str) -> int:
    value = source.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise AppError(
            "SYNC_BUNDLE_FIELD_INVALID",
            f"Sync bundle {label} field must be an integer.",
            details={"field": key},
        )
    return value


def _read_json_object(path: Path, *, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AppError(
            "SYNC_BUNDLE_FILE_MISSING",
            f"Sync bundle {label} is missing.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"path": str(path)},
        ) from exc
    except (OSError, JSONDecodeError) as exc:
        raise AppError(
            "SYNC_BUNDLE_JSON_INVALID",
            f"Sync bundle {label} must be readable JSON.",
            details={"path": str(path)},
        ) from exc
    if not isinstance(payload, dict):
        raise AppError(
            "SYNC_BUNDLE_JSON_INVALID",
            f"Sync bundle {label} must be a JSON object.",
            details={"path": str(path)},
        )
    return payload


def _write_json_file(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            payload,
            ensure_ascii=True,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return _jsonable(asdict(cast(Any, value)))
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, Mapping):
        return {str(key): _jsonable(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(child) for child in value]
    return value


def _trusted_bundle_provider_device_id(
    session: Session,
    *,
    metadata: Mapping[str, Any],
    provider_device_id: str | None,
) -> str:
    provider_override = _normalize_provider_device_id(provider_device_id)
    if provider_device_id is not None and provider_override is None:
        raise AppError(
            "SYNC_BUNDLE_PROVIDER_INVALID",
            "Sync bundle provider device id must not be blank.",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    metadata_provider = _normalize_provider_device_id(metadata.get("provider_device_id"))
    inventory_provider_ids = _peer_inventory_provider_device_ids(metadata)
    if provider_override is not None:
        _validate_provider_override_matches_bundle(
            provider_override,
            metadata_provider=metadata_provider,
            inventory_provider_ids=inventory_provider_ids,
        )
        return _require_trusted_bundle_provider(
            session,
            provider_override,
            source="provider_override",
        )

    if metadata_provider is not None:
        return _require_trusted_bundle_provider(
            session,
            metadata_provider,
            source="bundle_metadata",
        )

    for inventory_provider_id in inventory_provider_ids:
        if _bundle_provider_is_trusted(session, inventory_provider_id):
            return inventory_provider_id

    raise AppError(
        "SYNC_BUNDLE_PROVIDER_UNTRUSTED",
        "Sync bundle provider is not a non-revoked trusted peer in this sync group.",
        status_code=status.HTTP_403_FORBIDDEN,
        details={
            "source": "peer_inventory",
            "provider_device_ids": inventory_provider_ids,
        },
    )


def _validate_provider_override_matches_bundle(
    provider_override: str,
    *,
    metadata_provider: str | None,
    inventory_provider_ids: list[str],
) -> None:
    if provider_override == metadata_provider or provider_override in inventory_provider_ids:
        return

    raise AppError(
        "SYNC_BUNDLE_PROVIDER_MISMATCH",
        "Sync bundle provider device id does not match the bundle provider identity.",
        status_code=status.HTTP_409_CONFLICT,
        details={
            "source": "bundle_metadata" if metadata_provider is not None else "peer_inventory",
            "provider_device_id": provider_override,
            "metadata_provider_device_id": metadata_provider,
            "peer_inventory_provider_device_ids": inventory_provider_ids,
        },
    )


def _require_trusted_bundle_provider(
    session: Session,
    provider_device_id: str,
    *,
    source: str,
) -> str:
    if _bundle_provider_is_trusted(session, provider_device_id):
        return provider_device_id
    raise AppError(
        "SYNC_BUNDLE_PROVIDER_UNTRUSTED",
        "Sync bundle provider is not a non-revoked trusted peer in this sync group.",
        status_code=status.HTTP_403_FORBIDDEN,
        details={
            "source": source,
            "provider_device_id": provider_device_id,
        },
    )


def _bundle_provider_is_trusted(session: Session, provider_device_id: str) -> bool:
    identity = get_or_create_local_identity(session)
    peer = session.get(SyncTrustedPeer, provider_device_id)
    return (
        peer is not None
        and peer.revoked_at is None
        and peer.sync_group_id == identity.sync_group_id
    )


def _peer_inventory_provider_device_ids(metadata: Mapping[str, Any]) -> list[str]:
    peer_inventory = metadata.get("peer_inventory")
    provider_ids: list[str] = []
    if isinstance(peer_inventory, list):
        for entry in peer_inventory:
            if isinstance(entry, Mapping):
                provider_id = _normalize_provider_device_id(entry.get("device_id"))
                if provider_id is not None and provider_id not in provider_ids:
                    provider_ids.append(provider_id)
    return provider_ids


def _normalize_provider_device_id(value: object) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        if normalized:
            return normalized
    return None


def _peer_inventory(
    provider_device_id: str,
    content_sha256s: Sequence[str],
) -> list[dict[str, Any]]:
    return [
        {
            "device_id": provider_device_id,
            "available_content_sha256": sorted(content_sha256s),
        }
    ]


def _remote_library_from_manifests(
    manifests: Sequence[Mapping[str, Any]],
    peer_inventory: list[dict[str, Any]],
) -> dict[str, Any]:
    projects: list[Any] = []
    artifacts: list[Any] = []
    entity_revisions: list[Any] = []
    delete_tombstones: list[Any] = []
    for manifest in manifests:
        project = manifest.get("project")
        if project is not None:
            projects.append(project)
        artifacts.extend(_list_field(manifest, "artifacts"))
        entity_revisions.extend(_list_field(manifest, "entity_revisions"))
        delete_tombstones.extend(_list_field(manifest, "delete_tombstones"))
    return {
        "projects": projects,
        "artifacts": artifacts,
        "entity_revisions": entity_revisions,
        "delete_tombstones": delete_tombstones,
        "peer_inventory": peer_inventory,
    }


def _list_field(source: Mapping[str, Any], key: str) -> list[Any]:
    value = source.get(key)
    return value if isinstance(value, list) else []


def _file_size(path: Path) -> int | None:
    try:
        if not path.is_file():
            return None
        return path.stat().st_size
    except OSError:
        return None
