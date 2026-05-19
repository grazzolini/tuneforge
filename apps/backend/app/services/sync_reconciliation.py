from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import (
    Artifact,
    Project,
    SyncDeleteTombstone,
    SyncEntityRevision,
    SyncLocalIdentity,
    SyncTrustedPeer,
)
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_manifest import _coerce_project_manifest
from app.services.sync_revisions import revision_payload_sha256, sanitize_revision_payload
from app.services.sync_trust import LOCAL_IDENTITY_ID
from app.utils.hashing import file_sha256

SYNC_RECONCILIATION_STATUSES = (
    "noop",
    "identical_content",
    "missing_local_bytes",
    "remote_available",
    "missing_provider",
    "deleted",
    "conflicted",
)

ACTION_APPLY_DELETE_TOMBSTONE = "apply_delete_tombstone"
ACTION_IMPORT_PROJECT_MANIFEST = "import_project_manifest"
ACTION_IMPORT_ENTITY_REVISION = "import_entity_revision"
ACTION_FETCH_ARTIFACT_CONTENT = "fetch_artifact_content"
ACTION_IMPORT_ARTIFACT_MANIFEST = "import_artifact_manifest"
ACTION_UPSERT_PROJECT_STATUS = "upsert_project_status"
ACTION_RECORD_CONFLICT = "record_conflict"
ACTION_NOOP = "noop"

ITEM_PROJECT = "project"
ITEM_ARTIFACT = "artifact"
ITEM_ENTITY_REVISION = "entity_revision"
ITEM_DELETE_TOMBSTONE = "delete_tombstone"

PROJECT_SYNC_STATUS_LOCAL = "local"
PROJECT_SYNC_STATUS_SYNCING = "syncing"
PROJECT_SYNC_STATUS_REMOTE_AVAILABLE = "remote_available"
PROJECT_SYNC_STATUS_DOWNLOADING = "downloading"
PROJECT_SYNC_STATUS_MISSING = "missing"
PROJECT_SYNC_STATUS_DELETED = "deleted"
PROJECT_SYNC_STATUS_CONFLICTED = "conflicted"
PROJECT_SYNC_STATUSES = (
    PROJECT_SYNC_STATUS_LOCAL,
    PROJECT_SYNC_STATUS_SYNCING,
    PROJECT_SYNC_STATUS_REMOTE_AVAILABLE,
    PROJECT_SYNC_STATUS_DOWNLOADING,
    PROJECT_SYNC_STATUS_MISSING,
    PROJECT_SYNC_STATUS_DELETED,
    PROJECT_SYNC_STATUS_CONFLICTED,
)

_STATUS_PRECEDENCE = {
    "noop": 0,
    "identical_content": 10,
    "remote_available": 20,
    "missing_local_bytes": 30,
    "missing_provider": 40,
    "conflicted": 50,
    "deleted": 60,
}

_ACTION_PRIORITY = {
    ACTION_APPLY_DELETE_TOMBSTONE: 0,
    ACTION_RECORD_CONFLICT: 10,
    ACTION_UPSERT_PROJECT_STATUS: 15,
    ACTION_FETCH_ARTIFACT_CONTENT: 20,
    ACTION_IMPORT_PROJECT_MANIFEST: 30,
    ACTION_IMPORT_ARTIFACT_MANIFEST: 40,
    ACTION_IMPORT_ENTITY_REVISION: 50,
    ACTION_NOOP: 100,
}

_MISSING = object()


@dataclass(frozen=True)
class SyncReconciliationSummary:
    status_counts: dict[str, int]
    total_items: int
    total_actions: int
    total_conflicts: int


@dataclass(frozen=True)
class SyncReconciliationItem:
    item_type: str
    item_id: str
    project_id: str | None
    status: str
    action_type: str | None = None
    content_sha256: str | None = None
    chosen_provider_device_id: str | None = None
    reason: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SyncReconciliationAction:
    action_type: str
    item_type: str
    item_id: str
    priority: int
    project_id: str | None = None
    content_sha256: str | None = None
    provider_device_id: str | None = None
    reason: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SyncReconciliationPlan:
    summary: SyncReconciliationSummary
    items: list[SyncReconciliationItem]
    actions: list[SyncReconciliationAction]


@dataclass(frozen=True)
class _RemoteProject:
    project_id: str
    source_sha256: str | None
    raw: Any


@dataclass(frozen=True)
class _RemoteArtifact:
    artifact_id: str
    project_id: str
    content_sha256: str | None
    size_bytes: int | None
    type: str | None
    format: str | None
    relative_path: str | None
    raw: Any


@dataclass(frozen=True)
class _RemoteEntityRevision:
    revision_id: str
    project_id: str
    entity_type: str
    entity_id: str
    base_revision_id: str | None
    source_artifact_id: str | None
    content_sha256: str | None
    raw: Any


@dataclass(frozen=True)
class _RemoteTombstone:
    tombstone_id: str
    sync_group_id: str | None
    project_id: str
    target_type: str
    target_id: str
    author_device_id: str | None
    deleted_at: Any
    raw: Any


@dataclass(frozen=True)
class _RemoteRequest:
    projects: dict[str, _RemoteProject]
    artifacts: dict[str, _RemoteArtifact]
    entity_revisions: dict[str, _RemoteEntityRevision]
    tombstones: list[_RemoteTombstone]
    project_manifests_by_id: dict[str, Any]
    manifest_artifact_ids_by_project: dict[str, frozenset[str]]
    manifest_revision_ids_by_project: dict[str, frozenset[str]]
    provider_device_ids_by_content_sha256: dict[str, tuple[str, ...]]


@dataclass(frozen=True)
class _LocalState:
    identity: SyncLocalIdentity | None
    trusted_device_ids: frozenset[str]
    projects: dict[str, Project]
    artifacts: dict[str, Artifact]
    artifacts_by_content_sha256: dict[str, tuple[Artifact, ...]]
    entity_revisions: dict[str, SyncEntityRevision]
    entity_revisions_by_entity: dict[tuple[str, str, str], tuple[SyncEntityRevision, ...]]
    tombstones: tuple[SyncDeleteTombstone, ...]


def plan_sync_reconciliation(
    session: Session,
    request: object | Mapping[str, Any],
) -> SyncReconciliationPlan:
    """Build a deterministic, read-only sync reconciliation plan."""

    local = _load_local_state(session)
    remote = _coerce_remote_request(request, trusted_device_ids=local.trusted_device_ids)

    items_by_key: dict[tuple[str, str], SyncReconciliationItem] = {}
    actions: list[SyncReconciliationAction] = []

    valid_remote_tombstones: list[_RemoteTombstone] = []
    ignored_remote_tombstones: list[tuple[_RemoteTombstone, str]] = []
    for tombstone in remote.tombstones:
        valid, reason = _validate_remote_tombstone(tombstone, local)
        if valid:
            valid_remote_tombstones.append(tombstone)
        else:
            ignored_remote_tombstones.append((tombstone, reason))

    effective_tombstones = _effective_tombstone_targets(local.tombstones, valid_remote_tombstones)

    for tombstone, reason in sorted(ignored_remote_tombstones, key=lambda item: _remote_tombstone_sort_key(item[0])):
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_DELETE_TOMBSTONE,
                item_id=tombstone.tombstone_id,
                project_id=tombstone.project_id,
                status="noop",
                action_type=ACTION_NOOP,
                reason=reason,
                details=_tombstone_details(tombstone),
            ),
        )

    for tombstone in sorted(valid_remote_tombstones, key=_remote_tombstone_sort_key):
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=tombstone.target_type,
                item_id=tombstone.target_id,
                project_id=tombstone.project_id,
                status="deleted",
                action_type=ACTION_APPLY_DELETE_TOMBSTONE,
                reason="A valid delete tombstone wins over remote manifests.",
                details=_tombstone_details(tombstone),
            ),
        )
        actions.append(
            _action(
                ACTION_APPLY_DELETE_TOMBSTONE,
                item_type=tombstone.target_type,
                item_id=tombstone.target_id,
                project_id=tombstone.project_id,
                reason="Apply valid sync delete tombstone before imports or fetches.",
                details=_tombstone_details(tombstone),
            )
        )

    for project in sorted(remote.projects.values(), key=lambda project: project.project_id):
        _plan_project(
            project,
            remote=remote,
            local=local,
            effective_tombstones=effective_tombstones,
            items_by_key=items_by_key,
            actions=actions,
        )

    for artifact in sorted(remote.artifacts.values(), key=lambda artifact: (artifact.project_id, artifact.artifact_id)):
        planned_project_ids = _planned_project_ids(actions)
        if (
            artifact.project_id in remote.project_manifests_by_id
            and artifact.artifact_id in remote.manifest_artifact_ids_by_project.get(artifact.project_id, frozenset())
            and not _is_deleted(ITEM_ARTIFACT, artifact.artifact_id, artifact.project_id, effective_tombstones)
        ):
            continue
        _plan_artifact(
            artifact,
            remote=remote,
            local=local,
            effective_tombstones=effective_tombstones,
            planned_project_ids=planned_project_ids,
            items_by_key=items_by_key,
            actions=actions,
        )

    planned_artifact_project_ids = _planned_artifact_project_ids(actions)
    planned_revision_ids = set(local.entity_revisions)
    planned_remote_revisions_by_id: dict[str, _RemoteEntityRevision] = {}
    for revision in _sorted_remote_entity_revisions(remote.entity_revisions.values()):
        if (
            revision.project_id in remote.project_manifests_by_id
            and revision.revision_id in remote.manifest_revision_ids_by_project.get(revision.project_id, frozenset())
            and not _is_deleted(
                ITEM_ENTITY_REVISION,
                revision.revision_id,
                revision.project_id,
                effective_tombstones,
            )
        ):
            continue
        if _plan_entity_revision(
            revision,
            local=local,
            effective_tombstones=effective_tombstones,
            planned_revision_ids=frozenset(planned_revision_ids),
            planned_remote_revisions_by_id=planned_remote_revisions_by_id,
            planned_artifact_project_ids=planned_artifact_project_ids,
            items_by_key=items_by_key,
            actions=actions,
        ):
            planned_revision_ids.add(revision.revision_id)
            if revision.revision_id not in local.entity_revisions:
                planned_remote_revisions_by_id[revision.revision_id] = revision

    items = sorted(items_by_key.values(), key=_item_sort_key)
    deduped_actions = _dedupe_actions(actions)
    summary = _summarize(items, deduped_actions)
    return SyncReconciliationPlan(summary=summary, items=items, actions=deduped_actions)


def _load_local_state(session: Session) -> _LocalState:
    identity = session.get(SyncLocalIdentity, LOCAL_IDENTITY_ID)
    trusted_device_ids: frozenset[str]
    if identity is None:
        trusted_device_ids = frozenset()
    else:
        trusted_device_ids = frozenset(
            peer.device_id
            for peer in session.scalars(
                select(SyncTrustedPeer)
                .where(SyncTrustedPeer.revoked_at.is_(None))
                .where(SyncTrustedPeer.sync_group_id == identity.sync_group_id)
                .order_by(SyncTrustedPeer.device_id.asc())
            )
        )

    projects = {
        project.id: project
        for project in session.scalars(select(Project).order_by(Project.id.asc()))
    }
    artifacts = {
        artifact.id: artifact
        for artifact in session.scalars(select(Artifact).order_by(Artifact.project_id.asc(), Artifact.id.asc()))
    }
    artifacts_by_hash: dict[str, list[Artifact]] = {}
    for artifact in artifacts.values():
        content_hash = _normalize_sha256(artifact.content_sha256)
        if content_hash is not None:
            artifacts_by_hash.setdefault(content_hash, []).append(artifact)

    revisions = {
        revision.id: revision
        for revision in session.scalars(
            select(SyncEntityRevision).order_by(
                SyncEntityRevision.project_id.asc(),
                SyncEntityRevision.entity_type.asc(),
                SyncEntityRevision.entity_id.asc(),
                SyncEntityRevision.id.asc(),
            )
        )
    }
    revisions_by_entity: dict[tuple[str, str, str], list[SyncEntityRevision]] = {}
    for revision in revisions.values():
        key = (revision.project_id, revision.entity_type, revision.entity_id)
        revisions_by_entity.setdefault(key, []).append(revision)

    tombstones = tuple(
        session.scalars(
            select(SyncDeleteTombstone).order_by(
                SyncDeleteTombstone.project_id.asc(),
                SyncDeleteTombstone.target_type.asc(),
                SyncDeleteTombstone.target_id.asc(),
                SyncDeleteTombstone.deleted_at.asc(),
                SyncDeleteTombstone.id.asc(),
            )
        )
    )

    return _LocalState(
        identity=identity,
        trusted_device_ids=trusted_device_ids,
        projects=projects,
        artifacts=artifacts,
        artifacts_by_content_sha256={
            content_hash: tuple(sorted(rows, key=lambda artifact: (artifact.project_id, artifact.id)))
            for content_hash, rows in artifacts_by_hash.items()
        },
        entity_revisions=revisions,
        entity_revisions_by_entity={
            key: tuple(sorted(rows, key=lambda revision: revision.id))
            for key, rows in revisions_by_entity.items()
        },
        tombstones=tombstones,
    )


def _has_imported_local_project(local: _LocalState, project_id: str) -> bool:
    project = local.projects.get(project_id)
    return project is not None and not _is_sync_project_placeholder(project)


def _is_sync_project_placeholder(project: Project) -> bool:
    source_path = (project.source_path or "").strip()
    imported_path = (project.imported_path or "").strip()
    return (
        not source_path
        or not imported_path
        or source_path.startswith("sync-placeholder:")
        or imported_path.startswith("sync-placeholder:")
    )


def _coerce_remote_request(
    request: object | Mapping[str, Any],
    *,
    trusted_device_ids: frozenset[str],
) -> _RemoteRequest:
    library = _first_field(
        request,
        "remote_library",
        "remote_library_manifest",
        "library_manifest",
        "library",
        default=request,
    )

    project_manifests = _collect_project_manifests(request, library)
    projects = _remote_projects(library, project_manifests)
    artifacts = _remote_artifacts(library, project_manifests)
    revisions = _remote_entity_revisions(library, project_manifests)
    tombstones = _remote_tombstones(library, project_manifests)
    inventory_source = _first_field(
        request,
        "peer_inventory",
        "peer_inventories",
        "inventory",
        default=_first_field(library, "peer_inventory", "peer_inventories", "inventory", default=[]),
    )

    return _RemoteRequest(
        projects=projects,
        artifacts=artifacts,
        entity_revisions=revisions,
        tombstones=tombstones,
        project_manifests_by_id={
            project_id: manifest
            for project_id, manifest in (
                (_project_id_from_manifest(manifest), manifest)
                for manifest in project_manifests
            )
            if project_id is not None
        },
        manifest_artifact_ids_by_project=_manifest_artifact_ids_by_project(project_manifests),
        manifest_revision_ids_by_project=_manifest_revision_ids_by_project(project_manifests),
        provider_device_ids_by_content_sha256=_provider_inventory(
            inventory_source,
            trusted_device_ids=trusted_device_ids,
        ),
    )


def _manifest_artifact_ids_by_project(project_manifests: Iterable[Any]) -> dict[str, frozenset[str]]:
    artifact_ids_by_project: dict[str, set[str]] = {}
    for manifest in project_manifests:
        project_id = _project_id_from_manifest(manifest)
        if project_id is None:
            continue
        artifact_ids = {
            artifact.artifact_id
            for artifact in _manifest_artifacts(manifest)
        }
        if artifact_ids:
            artifact_ids_by_project[project_id] = artifact_ids
    return {
        project_id: frozenset(artifact_ids)
        for project_id, artifact_ids in artifact_ids_by_project.items()
    }


def _manifest_revision_ids_by_project(project_manifests: Iterable[Any]) -> dict[str, frozenset[str]]:
    revision_ids_by_project: dict[str, set[str]] = {}
    for manifest in project_manifests:
        project_id = _project_id_from_manifest(manifest)
        if project_id is None:
            continue
        revision_ids = {
            revision.revision_id
            for revision in _manifest_entity_revisions(manifest)
        }
        if revision_ids:
            revision_ids_by_project[project_id] = revision_ids
    return {
        project_id: frozenset(revision_ids)
        for project_id, revision_ids in revision_ids_by_project.items()
    }


def _collect_project_manifests(request: object, library: object) -> list[Any]:
    manifests: list[Any] = []
    for source in (request, library):
        for name in ("project_manifest", "project_manifests", "manifests"):
            manifests.extend(_list_field(source, name))

        for project in _list_field(source, "projects"):
            nested_manifest = _first_field(project, "manifest", "project_manifest", default=None)
            if nested_manifest is not None:
                manifests.append(nested_manifest)

    by_project_id: dict[str, Any] = {}
    fallback: list[Any] = []
    for manifest in manifests:
        project_id = _project_id_from_manifest(manifest)
        if project_id is None:
            fallback.append(manifest)
            continue
        by_project_id[project_id] = manifest
    return [by_project_id[key] for key in sorted(by_project_id)] + fallback


def _remote_projects(library: object, project_manifests: Iterable[Any]) -> dict[str, _RemoteProject]:
    projects: dict[str, _RemoteProject] = {}
    for raw_project in _list_field(library, "projects"):
        project = _coerce_remote_project(raw_project)
        if project is not None:
            projects[project.project_id] = project

    for manifest in project_manifests:
        project = _coerce_remote_project(_first_field(manifest, "project", default=manifest))
        if project is not None:
            projects[project.project_id] = project

    return projects


def _remote_artifacts(library: object, project_manifests: Iterable[Any]) -> dict[str, _RemoteArtifact]:
    artifacts: dict[str, _RemoteArtifact] = {}
    for raw_artifact in _list_field(library, "artifacts"):
        artifact = _coerce_remote_artifact(raw_artifact)
        if artifact is not None:
            artifacts[artifact.artifact_id] = artifact

    for manifest in project_manifests:
        for raw_artifact in _list_field(manifest, "artifacts"):
            artifact = _coerce_remote_artifact(raw_artifact)
            if artifact is not None:
                artifacts[artifact.artifact_id] = artifact

    return artifacts


def _remote_entity_revisions(
    library: object,
    project_manifests: Iterable[Any],
) -> dict[str, _RemoteEntityRevision]:
    revisions: dict[str, _RemoteEntityRevision] = {}
    for raw_revision in _list_field(library, "entity_revisions", "revisions"):
        revision = _coerce_remote_revision(raw_revision)
        if revision is not None:
            revisions[revision.revision_id] = revision

    for manifest in project_manifests:
        for raw_revision in _list_field(manifest, "entity_revisions", "revisions"):
            revision = _coerce_remote_revision(raw_revision)
            if revision is not None:
                revisions[revision.revision_id] = revision

    return revisions


def _remote_tombstones(library: object, project_manifests: Iterable[Any]) -> list[_RemoteTombstone]:
    tombstones_by_key: dict[tuple[str, str, str, str], _RemoteTombstone] = {}
    for source in (library, *project_manifests):
        for raw_tombstone in _list_field(source, "delete_tombstones", "tombstones"):
            tombstone = _coerce_remote_tombstone(raw_tombstone)
            if tombstone is None:
                continue
            key = (
                tombstone.tombstone_id,
                tombstone.sync_group_id or "",
                tombstone.target_type,
                tombstone.target_id,
            )
            tombstones_by_key[key] = tombstone

    return [tombstones_by_key[key] for key in sorted(tombstones_by_key)]


def _provider_inventory(
    inventory: object,
    *,
    trusted_device_ids: frozenset[str],
) -> dict[str, tuple[str, ...]]:
    providers_by_hash: dict[str, set[str]] = {}
    for device_id, content_hash in _iter_inventory_availability(inventory):
        if device_id not in trusted_device_ids:
            continue
        normalized_hash = _normalize_sha256(content_hash)
        if normalized_hash is None:
            continue
        providers_by_hash.setdefault(normalized_hash, set()).add(device_id)

    return {
        content_hash: tuple(sorted(device_ids))
        for content_hash, device_ids in sorted(providers_by_hash.items())
    }


def _iter_inventory_availability(inventory: object) -> Iterable[tuple[str, str]]:
    if isinstance(inventory, Mapping):
        device_id = _str_field(inventory, "device_id", "provider_device_id", "peer_device_id")
        if device_id is not None:
            yield from _iter_peer_inventory(device_id, inventory)
            return
        for key, value in inventory.items():
            if isinstance(key, str) and not _looks_like_inventory_field_name(key):
                yield from _iter_peer_inventory(key, value)
            else:
                yield from _iter_inventory_availability(value)
        return

    if isinstance(inventory, str) or not isinstance(inventory, (list, tuple)):
        return

    for entry in _as_list(inventory):
        device_id = _str_field(entry, "device_id", "provider_device_id", "peer_device_id")
        if device_id is not None:
            yield from _iter_peer_inventory(device_id, entry)
        elif isinstance(entry, (list, tuple, Mapping)):
            yield from _iter_inventory_availability(entry)


def _iter_peer_inventory(device_id: str, entry: object) -> Iterable[tuple[str, str]]:
    if isinstance(entry, str):
        yield device_id, entry
        return
    if isinstance(entry, (list, tuple)):
        for value in entry:
            if isinstance(value, str):
                yield device_id, value
                continue
            content_hash = _str_field(value, "content_sha256", "sha256", "content_hash")
            if content_hash is not None and _inventory_entry_is_available(value):
                yield device_id, content_hash
        return

    direct_hash = _str_field(entry, "content_sha256", "sha256", "content_hash")
    if direct_hash is not None and _inventory_entry_is_available(entry):
        yield device_id, direct_hash

    for name in (
        "content_sha256s",
        "content_hashes",
        "available_content_sha256",
        "available_content_sha256s",
        "available_content_hashes",
        "available_content",
        "available_artifacts",
        "artifacts",
    ):
        for value in _list_field(entry, name):
            if isinstance(value, str):
                yield device_id, value
                continue
            content_hash = _str_field(value, "content_sha256", "sha256", "content_hash")
            if content_hash is not None and _inventory_entry_is_available(value):
                yield device_id, content_hash


def _inventory_entry_is_available(entry: object) -> bool:
    status = _str_field(entry, "status", "availability", default=None)
    if status is None:
        available = _first_field(entry, "available", default=None)
        return not isinstance(available, bool) or available
    return status in {"available", "local", "ready", "present"}


def _looks_like_inventory_field_name(key: str) -> bool:
    return key in {
        "peer_inventory",
        "peer_inventories",
        "inventory",
        "providers",
        "available_content",
    }


def _plan_project(
    project: _RemoteProject,
    *,
    remote: _RemoteRequest,
    local: _LocalState,
    effective_tombstones: frozenset[tuple[str, str]],
    items_by_key: dict[tuple[str, str], SyncReconciliationItem],
    actions: list[SyncReconciliationAction],
) -> None:
    if _is_deleted(ITEM_PROJECT, project.project_id, project.project_id, effective_tombstones):
        reason = "Project is covered by a sync delete tombstone."
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="deleted",
                action_type=ACTION_APPLY_DELETE_TOMBSTONE,
                reason=reason,
            ),
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_DELETED,
            reason=reason,
            content_sha256=project.source_sha256,
        )
        return

    local_project = local.projects.get(project.project_id)
    if local_project is not None:
        if (
            project.source_sha256 is not None
            and local_project.source_sha256 is not None
            and _normalize_sha256(local_project.source_sha256) != project.source_sha256
        ):
            _record_conflict(
                items_by_key,
                actions,
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                content_sha256=project.source_sha256,
                reason="Remote project has the same ID with a different source SHA-256.",
                details={
                    "local_source_sha256": local_project.source_sha256,
                    "remote_source_sha256": project.source_sha256,
                },
            )
            return
        if not _is_sync_project_placeholder(local_project):
            _upsert_item(
                items_by_key,
                SyncReconciliationItem(
                    item_type=ITEM_PROJECT,
                    item_id=project.project_id,
                    project_id=project.project_id,
                    status="noop",
                    action_type=ACTION_NOOP,
                    content_sha256=project.source_sha256,
                    reason="Project already exists locally.",
                ),
            )
            return

    manifest = remote.project_manifests_by_id.get(project.project_id)
    if manifest is None:
        reason = "Project manifest is required before import."
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="missing_provider",
                content_sha256=project.source_sha256,
                reason=reason,
            ),
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_MISSING,
            reason=reason,
            content_sha256=project.source_sha256,
        )
        return

    manifest_artifacts = _manifest_artifacts(manifest)
    source_artifact, source_error, source_details = _importable_source_artifact_for_manifest(manifest_artifacts)
    if source_error is not None:
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            content_sha256=project.source_sha256,
            reason=source_error,
            details=source_details,
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_CONFLICTED,
            reason=source_error,
            content_sha256=project.source_sha256,
            status_details=source_details,
        )
        return

    assert source_artifact is not None
    source_hash = source_artifact.content_sha256
    if source_hash is None:
        reason = "Project manifest does not identify required source content."
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="missing_provider",
                reason=reason,
            ),
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_MISSING,
            reason=reason,
            content_sha256=project.source_sha256,
        )
        return
    if project.source_sha256 is None:
        reason = "Project manifest does not include source SHA-256 identity metadata."
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="missing_provider",
                reason=reason,
            ),
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_MISSING,
            reason=reason,
            content_sha256=source_hash,
        )
        return
    try:
        expected_project_id = source_hash_to_project_id(project.source_sha256)
    except ValueError:
        details: dict[str, Any] = {"source_sha256": project.source_sha256}
        reason = "Project manifest source_sha256 must be a full SHA-256 hex digest."
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            content_sha256=project.source_sha256,
            reason=reason,
            details=details,
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_CONFLICTED,
            reason=reason,
            content_sha256=project.source_sha256,
            status_details=details,
        )
        return
    if project.project_id != expected_project_id:
        details = {
            "expected_project_id": expected_project_id,
            "source_sha256": project.source_sha256,
        }
        reason = "Project manifest project_id must be derived from source_sha256."
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            content_sha256=project.source_sha256,
            reason=reason,
            details=details,
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_CONFLICTED,
            reason=reason,
            content_sha256=project.source_sha256,
            status_details=details,
        )
        return

    manifest_revisions = _manifest_entity_revisions(manifest)
    manifest_error = _project_manifest_import_error(
        project=project,
        manifest=manifest,
        artifacts=manifest_artifacts,
        revisions=manifest_revisions,
        local=local,
        effective_tombstones=effective_tombstones,
    )
    if manifest_error is not None:
        reason, details = manifest_error
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            content_sha256=project.source_sha256,
            reason=reason,
            details=details,
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_CONFLICTED,
            reason=reason,
            content_sha256=project.source_sha256,
            status_details=details,
        )
        return

    missing_hash_artifact_ids = [
        artifact.artifact_id
        for artifact in manifest_artifacts
        if artifact.content_sha256 is None
    ]
    if missing_hash_artifact_ids:
        reason = "Project manifest contains artifacts without content SHA-256 metadata."
        details = {"artifact_ids": sorted(missing_hash_artifact_ids)}
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="missing_provider",
                content_sha256=source_hash,
                reason=reason,
                details=details,
            ),
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_MISSING,
            reason=reason,
            content_sha256=source_hash,
            status_details=details,
        )
        return

    available_artifacts = _manifest_artifact_availability(manifest_artifacts, remote=remote, local=local)
    missing_provider_artifacts = [
        artifact.artifact_id
        for artifact, local_artifact, provider_device_id in available_artifacts
        if local_artifact is None and provider_device_id is None
    ]
    if missing_provider_artifacts:
        reason = "No local bytes or trusted provider are available for every project manifest artifact."
        details = {"artifact_ids": sorted(missing_provider_artifacts)}
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="missing_provider",
                content_sha256=source_hash,
                reason=reason,
                details=details,
            ),
        )
        _append_project_status_action(
            actions,
            project,
            project_status=PROJECT_SYNC_STATUS_MISSING,
            reason=reason,
            content_sha256=source_hash,
            status_details=details,
        )
        return

    artifact_providers = {
        artifact.artifact_id: provider_device_id
        for artifact, local_artifact, provider_device_id in available_artifacts
        if local_artifact is None and provider_device_id is not None
    }
    local_artifact_ids = {
        artifact.artifact_id: local_artifact.id
        for artifact, local_artifact, _provider_device_id in available_artifacts
        if local_artifact is not None
    }
    if not artifact_providers:
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                status="identical_content",
                action_type=ACTION_IMPORT_PROJECT_MANIFEST,
                content_sha256=source_hash,
                reason="All project manifest artifact bytes are already verified locally.",
                details={
                    "local_artifact_ids": local_artifact_ids,
                    "manifest_artifact_count": len(manifest_artifacts),
                },
            ),
        )
        actions.append(
            _action(
                ACTION_IMPORT_PROJECT_MANIFEST,
                item_type=ITEM_PROJECT,
                item_id=project.project_id,
                project_id=project.project_id,
                content_sha256=source_hash,
                reason="Import project manifest using locally verified artifact content.",
                details={
                    "source_artifact_id": source_artifact.artifact_id if source_artifact else None,
                    "manifest_artifact_count": len(manifest_artifacts),
                },
            )
        )
        return

    chosen_provider_device_id = sorted(artifact_providers.values())[0]
    reason = "Every project manifest artifact is local or advertised by a trusted peer."
    details = {
        "artifact_providers": artifact_providers,
        "manifest_artifact_count": len(manifest_artifacts),
    }
    _upsert_item(
        items_by_key,
        SyncReconciliationItem(
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            status="remote_available",
            action_type=ACTION_IMPORT_PROJECT_MANIFEST,
            content_sha256=source_hash,
            chosen_provider_device_id=chosen_provider_device_id,
            reason=reason,
            details=details,
        ),
    )
    _append_project_status_action(
        actions,
        project,
        project_status=PROJECT_SYNC_STATUS_REMOTE_AVAILABLE,
        reason=reason,
        content_sha256=source_hash,
        provider_device_id=chosen_provider_device_id,
        status_details=details,
    )
    for artifact, local_artifact, provider_device_id in available_artifacts:
        if local_artifact is not None or provider_device_id is None or artifact.content_sha256 is None:
            continue
        actions.append(
            _action(
                ACTION_FETCH_ARTIFACT_CONTENT,
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=project.project_id,
                content_sha256=artifact.content_sha256,
                provider_device_id=provider_device_id,
                reason="Fetch project manifest artifact bytes before importing the project.",
            )
        )
    actions.append(
        _action(
            ACTION_IMPORT_PROJECT_MANIFEST,
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            content_sha256=source_hash,
            provider_device_id=chosen_provider_device_id,
            reason="Import project manifest after every required artifact is available.",
            details={
                "source_artifact_id": source_artifact.artifact_id if source_artifact else None,
                "manifest_artifact_count": len(manifest_artifacts),
            },
        )
    )


def _plan_artifact(
    artifact: _RemoteArtifact,
    *,
    remote: _RemoteRequest,
    local: _LocalState,
    effective_tombstones: frozenset[tuple[str, str]],
    planned_project_ids: frozenset[str],
    items_by_key: dict[tuple[str, str], SyncReconciliationItem],
    actions: list[SyncReconciliationAction],
) -> None:
    if _is_deleted(ITEM_ARTIFACT, artifact.artifact_id, artifact.project_id, effective_tombstones):
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                status="deleted",
                action_type=ACTION_APPLY_DELETE_TOMBSTONE,
                content_sha256=artifact.content_sha256,
                reason="Artifact is covered by a sync delete tombstone.",
            ),
        )
        return

    if artifact.content_sha256 is None:
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                status="missing_provider",
                reason="Remote artifact does not include a content SHA-256.",
            ),
        )
        return

    if (
        not _has_imported_local_project(local, artifact.project_id)
        and artifact.project_id not in planned_project_ids
    ):
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                status="missing_provider",
                content_sha256=artifact.content_sha256,
                reason=(
                    "Project must exist locally or have an importable project manifest before importing "
                    "an artifact."
                ),
            ),
        )
        return

    local_artifact = local.artifacts.get(artifact.artifact_id)
    if local_artifact is not None:
        local_hash = _normalize_sha256(local_artifact.content_sha256)
        if local_hash != artifact.content_sha256:
            _record_conflict(
                items_by_key,
                actions,
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                content_sha256=artifact.content_sha256,
                reason="Local and remote artifacts share an ID but have different content hashes.",
                details={
                    "local_content_sha256": local_hash,
                    "remote_content_sha256": artifact.content_sha256,
                },
            )
            return

        if _artifact_has_verified_content(local_artifact, artifact.content_sha256, artifact.size_bytes):
            _upsert_item(
                items_by_key,
                SyncReconciliationItem(
                    item_type=ITEM_ARTIFACT,
                    item_id=artifact.artifact_id,
                    project_id=artifact.project_id,
                    status="identical_content",
                    action_type=ACTION_NOOP,
                    content_sha256=artifact.content_sha256,
                    reason="Artifact bytes are already verified locally.",
                ),
            )
            return

        provider_device_id = _choose_provider(remote, artifact.content_sha256)
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                status="missing_local_bytes",
                action_type=ACTION_FETCH_ARTIFACT_CONTENT if provider_device_id is not None else None,
                content_sha256=artifact.content_sha256,
                chosen_provider_device_id=provider_device_id,
                reason="Local artifact metadata exists, but verified bytes are missing.",
            ),
        )
        if provider_device_id is not None:
            actions.append(
                _action(
                    ACTION_FETCH_ARTIFACT_CONTENT,
                    item_type=ITEM_ARTIFACT,
                    item_id=artifact.artifact_id,
                    project_id=artifact.project_id,
                    content_sha256=artifact.content_sha256,
                    provider_device_id=provider_device_id,
                    reason="Fetch artifact bytes from the selected trusted provider.",
                )
            )
        return

    duplicate = _verified_artifact_for_hash(local, artifact.content_sha256)
    if duplicate is not None:
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                status="identical_content",
                action_type=ACTION_IMPORT_ARTIFACT_MANIFEST,
                content_sha256=artifact.content_sha256,
                reason="Content hash is already verified under another local artifact ID.",
                details={"local_artifact_id": duplicate.id},
            ),
        )
        actions.append(
            _action(
                ACTION_IMPORT_ARTIFACT_MANIFEST,
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                content_sha256=artifact.content_sha256,
                reason="Import artifact manifest without fetching duplicate bytes.",
                details={"local_artifact_id": duplicate.id},
            )
        )
        return

    provider_device_id = _choose_provider(remote, artifact.content_sha256)
    if provider_device_id is not None:
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                status="remote_available",
                action_type=ACTION_FETCH_ARTIFACT_CONTENT,
                content_sha256=artifact.content_sha256,
                chosen_provider_device_id=provider_device_id,
                reason="Artifact content is advertised by a trusted peer.",
            ),
        )
        actions.append(
            _action(
                ACTION_FETCH_ARTIFACT_CONTENT,
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                content_sha256=artifact.content_sha256,
                provider_device_id=provider_device_id,
                reason="Fetch artifact bytes from the selected trusted provider.",
            )
        )
        actions.append(
            _action(
                ACTION_IMPORT_ARTIFACT_MANIFEST,
                item_type=ITEM_ARTIFACT,
                item_id=artifact.artifact_id,
                project_id=artifact.project_id,
                content_sha256=artifact.content_sha256,
                provider_device_id=provider_device_id,
                reason="Import artifact manifest after content is available.",
            )
        )
        return

    _upsert_item(
        items_by_key,
        SyncReconciliationItem(
            item_type=ITEM_ARTIFACT,
            item_id=artifact.artifact_id,
            project_id=artifact.project_id,
            status="missing_provider",
            content_sha256=artifact.content_sha256,
            reason="No local bytes or trusted provider are available for artifact content.",
        ),
    )


def _plan_entity_revision(
    revision: _RemoteEntityRevision,
    *,
    local: _LocalState,
    effective_tombstones: frozenset[tuple[str, str]],
    planned_revision_ids: frozenset[str],
    planned_remote_revisions_by_id: Mapping[str, _RemoteEntityRevision],
    planned_artifact_project_ids: Mapping[str, str],
    items_by_key: dict[tuple[str, str], SyncReconciliationItem],
    actions: list[SyncReconciliationAction],
) -> bool:
    if _is_deleted(ITEM_ENTITY_REVISION, revision.revision_id, revision.project_id, effective_tombstones):
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ENTITY_REVISION,
                item_id=revision.revision_id,
                project_id=revision.project_id,
                status="deleted",
                action_type=ACTION_APPLY_DELETE_TOMBSTONE,
                content_sha256=revision.content_sha256,
                reason="Entity revision is covered by a sync delete tombstone.",
            ),
        )
        return False

    local_revision = local.entity_revisions.get(revision.revision_id)
    if local_revision is not None:
        local_content_sha256 = _local_revision_content_sha256(local_revision)
        if local_content_sha256 == revision.content_sha256:
            _upsert_item(
                items_by_key,
                SyncReconciliationItem(
                    item_type=ITEM_ENTITY_REVISION,
                    item_id=revision.revision_id,
                    project_id=revision.project_id,
                    status="identical_content",
                    action_type=ACTION_NOOP,
                    content_sha256=revision.content_sha256,
                    reason="Entity revision already exists locally with the same content hash.",
                ),
            )
            return True

        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_ENTITY_REVISION,
            item_id=revision.revision_id,
            project_id=revision.project_id,
            content_sha256=revision.content_sha256,
            reason="Local and remote entity revisions share an ID but have different content hashes.",
            details={
                "local_content_sha256": local_content_sha256,
                "stored_local_content_sha256": local_revision.content_sha256,
                "remote_content_sha256": revision.content_sha256,
            },
        )
        return False

    if not _has_imported_local_project(local, revision.project_id):
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ENTITY_REVISION,
                item_id=revision.revision_id,
                project_id=revision.project_id,
                status="missing_provider",
                content_sha256=revision.content_sha256,
                reason="Project must exist locally before importing a standalone entity revision.",
                details={"base_revision_id": revision.base_revision_id},
            ),
        )
        return False

    if revision.base_revision_id is not None and revision.base_revision_id not in planned_revision_ids:
        _upsert_item(
            items_by_key,
            SyncReconciliationItem(
                item_type=ITEM_ENTITY_REVISION,
                item_id=revision.revision_id,
                project_id=revision.project_id,
                status="missing_provider",
                content_sha256=revision.content_sha256,
                reason="Base revision must exist locally or be planned before importing this entity revision.",
                details={"base_revision_id": revision.base_revision_id},
            ),
        )
        return False

    reference_error = _standalone_entity_revision_reference_error(
        revision,
        local=local,
        planned_remote_revisions_by_id=planned_remote_revisions_by_id,
        planned_artifact_project_ids=planned_artifact_project_ids,
    )
    if reference_error is not None:
        reason, details = reference_error
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_ENTITY_REVISION,
            item_id=revision.revision_id,
            project_id=revision.project_id,
            content_sha256=revision.content_sha256,
            reason=reason,
            details=details,
        )
        return False

    revision_manifest_error = _entity_revision_manifest_contract_error(revision)
    if revision_manifest_error is not None:
        reason, details = revision_manifest_error
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_ENTITY_REVISION,
            item_id=revision.revision_id,
            project_id=revision.project_id,
            content_sha256=revision.content_sha256,
            reason=reason,
            details=details,
        )
        return False

    divergent_revision = _divergent_local_revision(revision, local)
    if divergent_revision is not None:
        _record_conflict(
            items_by_key,
            actions,
            item_type=ITEM_ENTITY_REVISION,
            item_id=revision.revision_id,
            project_id=revision.project_id,
            content_sha256=revision.content_sha256,
            reason="Remote entity revision diverges from a local revision with the same base.",
            details={
                "base_revision_id": revision.base_revision_id,
                "local_revision_id": divergent_revision.id,
                "local_content_sha256": _local_revision_content_sha256(divergent_revision),
                "stored_local_content_sha256": divergent_revision.content_sha256,
                "remote_content_sha256": revision.content_sha256,
            },
        )
        return False

    _upsert_item(
        items_by_key,
        SyncReconciliationItem(
            item_type=ITEM_ENTITY_REVISION,
            item_id=revision.revision_id,
            project_id=revision.project_id,
            status="remote_available",
            action_type=ACTION_IMPORT_ENTITY_REVISION,
            content_sha256=revision.content_sha256,
            reason="Remote entity revision can be imported.",
            details={"base_revision_id": revision.base_revision_id},
        ),
    )
    actions.append(
        _action(
            ACTION_IMPORT_ENTITY_REVISION,
            item_type=ITEM_ENTITY_REVISION,
            item_id=revision.revision_id,
            project_id=revision.project_id,
            content_sha256=revision.content_sha256,
            reason="Import remote entity revision metadata.",
            details={"base_revision_id": revision.base_revision_id},
        )
    )
    return True


def _validate_remote_tombstone(tombstone: _RemoteTombstone, local: _LocalState) -> tuple[bool, str]:
    if local.identity is None:
        return False, "Ignored remote tombstone because the local sync identity is missing."
    if tombstone.sync_group_id != local.identity.sync_group_id:
        return False, "Ignored remote tombstone from a different sync group."
    if tombstone.author_device_id == local.identity.device_id:
        return True, ""
    if tombstone.author_device_id in local.trusted_device_ids:
        return True, ""
    return False, "Ignored remote tombstone from an untrusted or revoked author device."


def _project_manifest_import_error(
    *,
    project: _RemoteProject,
    manifest: object,
    artifacts: Iterable[_RemoteArtifact],
    revisions: Iterable[_RemoteEntityRevision],
    local: _LocalState,
    effective_tombstones: frozenset[tuple[str, str]],
) -> tuple[str, dict[str, Any]] | None:
    manifest_artifacts = list(artifacts)
    manifest_revisions = list(revisions)
    tombstoned_artifacts = [
        artifact.artifact_id
        for artifact in manifest_artifacts
        if _is_deleted(ITEM_ARTIFACT, artifact.artifact_id, project.project_id, effective_tombstones)
    ]
    tombstoned_revisions = [
        revision.revision_id
        for revision in manifest_revisions
        if _is_deleted(ITEM_ENTITY_REVISION, revision.revision_id, project.project_id, effective_tombstones)
    ]
    if tombstoned_artifacts or tombstoned_revisions:
        return (
            "Project manifest contains live targets covered by sync delete tombstones.",
            {
                "artifact_ids": sorted(tombstoned_artifacts),
                "revision_ids": sorted(tombstoned_revisions),
            },
        )

    artifact_error = _artifact_manifest_import_error(
        project=project,
        artifacts=manifest_artifacts,
    )
    if artifact_error is not None:
        return artifact_error

    try:
        _coerce_project_manifest(manifest)
    except AppError as exc:
        return exc.message, dict(exc.details)

    artifact_conflicts = [
        artifact.artifact_id
        for artifact in manifest_artifacts
        if artifact.artifact_id in local.artifacts
    ]
    if artifact_conflicts:
        return (
            "A synced artifact conflicts with an existing local artifact.",
            {"artifact_ids": sorted(artifact_conflicts)},
        )

    revision_ids = [revision.revision_id for revision in manifest_revisions]
    duplicate_revision_ids = _duplicates(revision_ids)
    if duplicate_revision_ids:
        return (
            "Project manifest contains duplicate entity revision IDs.",
            {"revision_ids": duplicate_revision_ids},
        )

    revision_conflicts = [
        revision.revision_id
        for revision in manifest_revisions
        if revision.revision_id in local.entity_revisions
    ]
    if revision_conflicts:
        return (
            "A synced entity revision conflicts with an existing local revision.",
            {"revision_ids": sorted(revision_conflicts)},
        )

    manifest_revisions_by_id = {
        revision.revision_id: revision
        for revision in manifest_revisions
    }
    manifest_artifacts_by_id = {
        artifact.artifact_id: artifact
        for artifact in manifest_artifacts
    }
    for revision in manifest_revisions:
        if revision.project_id != project.project_id:
            return (
                "Entity revision manifest belongs to a different project.",
                {"revision_id": revision.revision_id, "project_id": revision.project_id},
            )
        base_error = _entity_revision_base_reference_error(
            revision,
            project_id=project.project_id,
            local=local,
            manifest_revisions_by_id=manifest_revisions_by_id,
        )
        if base_error is not None:
            reason, details = base_error
            return reason, {"revision_id": revision.revision_id, **details}
        source_error = _entity_revision_source_artifact_reference_error(
            revision,
            project_id=project.project_id,
            manifest_artifacts_by_id=manifest_artifacts_by_id,
        )
        if source_error is not None:
            reason, details = source_error
            return reason, {"revision_id": revision.revision_id, **details}

    cycle_revision_ids = _cycle_revision_ids(manifest_revisions)
    if cycle_revision_ids:
        return (
            "Entity revision base_revision_id contains a cycle.",
            {"revision_ids": cycle_revision_ids},
        )

    return None


def _artifact_manifest_import_error(
    *,
    project: _RemoteProject,
    artifacts: Iterable[_RemoteArtifact],
) -> tuple[str, dict[str, Any]] | None:
    manifest_artifacts = list(artifacts)
    duplicate_artifact_ids = _duplicates(artifact.artifact_id for artifact in manifest_artifacts)
    if duplicate_artifact_ids:
        return (
            "Project manifest contains duplicate artifact IDs.",
            {"artifact_ids": duplicate_artifact_ids},
        )

    relative_paths: set[str] = set()
    for artifact in manifest_artifacts:
        if artifact.project_id != project.project_id:
            return (
                "Artifact manifest belongs to a different project.",
                {"artifact_id": artifact.artifact_id, "project_id": artifact.project_id},
            )
        if artifact.content_sha256 is None or not _is_sha256(artifact.content_sha256):
            return (
                "Artifact manifest content_sha256 must be a full SHA-256 hex digest.",
                {"artifact_id": artifact.artifact_id},
            )
        if artifact.size_bytes is None or artifact.size_bytes < 0:
            return (
                "Artifact manifest size_bytes must be non-negative.",
                {"artifact_id": artifact.artifact_id, "size_bytes": artifact.size_bytes},
            )
        metadata = _first_field(artifact.raw, "metadata", default={})
        if not isinstance(metadata, Mapping):
            return (
                "Artifact manifest metadata must be an object.",
                {"artifact_id": artifact.artifact_id},
            )
        path_error = _manifest_relative_path_error(artifact.relative_path)
        if path_error is not None:
            return (
                path_error,
                {
                    "artifact_id": artifact.artifact_id,
                    "relative_path": artifact.relative_path,
                },
            )

        assert artifact.relative_path is not None
        normalized_path = PurePosixPath(artifact.relative_path).as_posix()
        if normalized_path in relative_paths:
            return (
                "Project manifest contains duplicate artifact relative paths.",
                {"relative_path": normalized_path},
            )
        relative_paths.add(normalized_path)

    return None


def _entity_revision_base_reference_error(
    revision: _RemoteEntityRevision,
    *,
    project_id: str,
    local: _LocalState,
    manifest_revisions_by_id: Mapping[str, _RemoteEntityRevision],
) -> tuple[str, dict[str, Any]] | None:
    if revision.base_revision_id is None:
        return None

    manifest_base = manifest_revisions_by_id.get(revision.base_revision_id)
    if manifest_base is not None:
        if (
            manifest_base.project_id != project_id
            or manifest_base.entity_type != revision.entity_type
            or manifest_base.entity_id != revision.entity_id
        ):
            return (
                "Entity revision base_revision_id must reference the same project entity.",
                {"base_revision_id": revision.base_revision_id},
            )
        return None

    existing_base = local.entity_revisions.get(revision.base_revision_id)
    if existing_base is None:
        return (
            "Entity revision base_revision_id does not exist in the manifest.",
            {"base_revision_id": revision.base_revision_id},
        )
    if (
        existing_base.project_id != project_id
        or existing_base.entity_type != revision.entity_type
        or existing_base.entity_id != revision.entity_id
    ):
        return (
            "Entity revision base_revision_id must reference the same project entity.",
            {"base_revision_id": revision.base_revision_id},
        )
    return None


def _entity_revision_source_artifact_reference_error(
    revision: _RemoteEntityRevision,
    *,
    project_id: str,
    manifest_artifacts_by_id: Mapping[str, _RemoteArtifact],
) -> tuple[str, dict[str, Any]] | None:
    if revision.source_artifact_id is None:
        return None
    artifact = manifest_artifacts_by_id.get(revision.source_artifact_id)
    if artifact is None:
        return (
            "Entity revision source_artifact_id does not exist in the manifest.",
            {"source_artifact_id": revision.source_artifact_id},
        )
    if artifact.project_id != project_id:
        return (
            "Entity revision source_artifact_id must belong to the manifest project.",
            {"source_artifact_id": revision.source_artifact_id},
        )
    return None


def _standalone_entity_revision_reference_error(
    revision: _RemoteEntityRevision,
    *,
    local: _LocalState,
    planned_remote_revisions_by_id: Mapping[str, _RemoteEntityRevision],
    planned_artifact_project_ids: Mapping[str, str],
) -> tuple[str, dict[str, Any]] | None:
    base_error = _entity_revision_base_reference_error(
        revision,
        project_id=revision.project_id,
        local=local,
        manifest_revisions_by_id=planned_remote_revisions_by_id,
    )
    if base_error is not None:
        reason, details = base_error
        return reason, {"revision_id": revision.revision_id, **details}

    source_error = _standalone_entity_revision_source_artifact_reference_error(
        revision,
        local=local,
        planned_artifact_project_ids=planned_artifact_project_ids,
    )
    if source_error is not None:
        reason, details = source_error
        return reason, {"revision_id": revision.revision_id, **details}
    return None


def _standalone_entity_revision_source_artifact_reference_error(
    revision: _RemoteEntityRevision,
    *,
    local: _LocalState,
    planned_artifact_project_ids: Mapping[str, str],
) -> tuple[str, dict[str, Any]] | None:
    if revision.source_artifact_id is None:
        return None

    local_artifact = local.artifacts.get(revision.source_artifact_id)
    if local_artifact is not None:
        if local_artifact.project_id != revision.project_id:
            return (
                "Entity revision source_artifact_id must belong to the manifest project.",
                {"source_artifact_id": revision.source_artifact_id},
            )
        return None

    planned_project_id = planned_artifact_project_ids.get(revision.source_artifact_id)
    if planned_project_id is None:
        return (
            "Entity revision source_artifact_id does not exist in the manifest.",
            {"source_artifact_id": revision.source_artifact_id},
        )
    if planned_project_id != revision.project_id:
        return (
            "Entity revision source_artifact_id must belong to the manifest project.",
            {"source_artifact_id": revision.source_artifact_id},
        )
    return None


def _entity_revision_manifest_contract_error(
    revision: _RemoteEntityRevision,
) -> tuple[str, dict[str, Any]] | None:
    if revision.content_sha256 is None or not _is_sha256(revision.content_sha256):
        return (
            "Entity revision manifest content_sha256 must be a full SHA-256 hex digest.",
            {"revision_id": revision.revision_id},
        )

    metadata = _first_field(revision.raw, "metadata", default={})
    if not isinstance(metadata, Mapping):
        return (
            "Entity revision manifest metadata must be an object.",
            {"revision_id": revision.revision_id},
        )
    payload = _first_field(revision.raw, "payload", default={})
    if not isinstance(payload, Mapping):
        return (
            "Entity revision manifest payload must be an object.",
            {"revision_id": revision.revision_id},
        )

    safe_metadata = sanitize_revision_payload(metadata)
    safe_payload = sanitize_revision_payload(payload)
    if safe_metadata != metadata or safe_payload != payload:
        return (
            "Entity revision manifest metadata and payload must be sync-safe.",
            {"revision_id": revision.revision_id},
        )
    if revision.content_sha256 != revision_payload_sha256(safe_payload):
        return (
            "Entity revision manifest content_sha256 must match payload.",
            {"revision_id": revision.revision_id},
        )
    return None


def _cycle_revision_ids(revisions: Iterable[_RemoteEntityRevision]) -> list[str]:
    pending = {revision.revision_id: revision for revision in revisions}
    while pending:
        ready = [
            revision_id
            for revision_id, revision in pending.items()
            if revision.base_revision_id not in pending
        ]
        if not ready:
            return sorted(pending)
        for revision_id in ready:
            del pending[revision_id]
    return []


def _duplicates(values: Iterable[str]) -> list[str]:
    counts = Counter(values)
    return sorted(value for value, count in counts.items() if count > 1)


def _effective_tombstone_targets(
    local_tombstones: Iterable[SyncDeleteTombstone],
    remote_tombstones: Iterable[_RemoteTombstone],
) -> frozenset[tuple[str, str]]:
    targets: set[tuple[str, str]] = set()
    for local_tombstone in local_tombstones:
        target_type = _normalize_target_type(local_tombstone.target_type)
        targets.add((target_type, local_tombstone.target_id))
        if target_type == ITEM_PROJECT:
            targets.add((ITEM_PROJECT, local_tombstone.project_id))
    for remote_tombstone in remote_tombstones:
        targets.add((remote_tombstone.target_type, remote_tombstone.target_id))
        if remote_tombstone.target_type == ITEM_PROJECT:
            targets.add((ITEM_PROJECT, remote_tombstone.project_id))
    return frozenset(targets)


def _is_deleted(
    item_type: str,
    item_id: str,
    project_id: str,
    effective_tombstones: frozenset[tuple[str, str]],
) -> bool:
    if (ITEM_PROJECT, project_id) in effective_tombstones:
        return True
    return (item_type, item_id) in effective_tombstones


def _record_conflict(
    items_by_key: dict[tuple[str, str], SyncReconciliationItem],
    actions: list[SyncReconciliationAction],
    *,
    item_type: str,
    item_id: str,
    project_id: str,
    content_sha256: str | None,
    reason: str,
    details: dict[str, Any],
) -> None:
    _upsert_item(
        items_by_key,
        SyncReconciliationItem(
            item_type=item_type,
            item_id=item_id,
            project_id=project_id,
            status="conflicted",
            action_type=ACTION_RECORD_CONFLICT,
            content_sha256=content_sha256,
            reason=reason,
            details=details,
        ),
    )
    actions.append(
        _action(
            ACTION_RECORD_CONFLICT,
            item_type=item_type,
            item_id=item_id,
            project_id=project_id,
            content_sha256=content_sha256,
            reason=reason,
            details=details,
        )
    )


def _append_project_status_action(
    actions: list[SyncReconciliationAction],
    project: _RemoteProject,
    *,
    project_status: str,
    reason: str,
    content_sha256: str | None,
    provider_device_id: str | None = None,
    status_details: dict[str, Any] | None = None,
) -> None:
    actions.append(
        _action(
            ACTION_UPSERT_PROJECT_STATUS,
            item_type=ITEM_PROJECT,
            item_id=project.project_id,
            project_id=project.project_id,
            content_sha256=content_sha256,
            provider_device_id=provider_device_id,
            reason=reason,
            details={
                "project_status": project_status,
                "edit_locked": project_status != PROJECT_SYNC_STATUS_LOCAL,
                "create_placeholder": project_status != PROJECT_SYNC_STATUS_DELETED,
                "lock_reason": reason,
                "remote_metadata": _remote_project_metadata(project),
                "status_details": status_details or {},
            },
        )
    )


def _remote_project_metadata(project: _RemoteProject) -> dict[str, Any]:
    metadata: dict[str, Any] = {"project_id": project.project_id}
    for name in (
        "display_name",
        "source_key_override",
        "duration_seconds",
        "sample_rate",
        "channels",
        "created_at",
        "updated_at",
    ):
        value = _first_field(project.raw, name, default=None)
        if value is not None:
            metadata[name] = value
    if project.source_sha256 is not None:
        metadata["source_sha256"] = project.source_sha256
    return metadata


def _coerce_remote_project(raw: object) -> _RemoteProject | None:
    project_id = _str_field(raw, "project_id", "id")
    if project_id is None:
        return None
    return _RemoteProject(
        project_id=project_id,
        source_sha256=_normalize_sha256(_str_field(raw, "source_sha256")),
        raw=raw,
    )


def _coerce_remote_artifact(raw: object) -> _RemoteArtifact | None:
    artifact_id = _str_field(raw, "artifact_id", "id")
    project_id = _str_field(raw, "project_id")
    if artifact_id is None or project_id is None:
        return None
    return _RemoteArtifact(
        artifact_id=artifact_id,
        project_id=project_id,
        content_sha256=_normalize_sha256(_str_field(raw, "content_sha256")),
        size_bytes=_int_field(raw, "size_bytes"),
        type=_str_field(raw, "type", "artifact_type"),
        format=_str_field(raw, "format"),
        relative_path=_str_field(raw, "relative_path"),
        raw=raw,
    )


def _coerce_remote_revision(raw: object) -> _RemoteEntityRevision | None:
    revision_id = _str_field(raw, "revision_id", "id")
    project_id = _str_field(raw, "project_id")
    entity_type = _str_field(raw, "entity_type")
    entity_id = _str_field(raw, "entity_id")
    if revision_id is None or project_id is None or entity_type is None or entity_id is None:
        return None
    return _RemoteEntityRevision(
        revision_id=revision_id,
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id,
        base_revision_id=_str_field(raw, "base_revision_id"),
        source_artifact_id=_str_field(raw, "source_artifact_id"),
        content_sha256=_normalize_sha256(_str_field(raw, "content_sha256")),
        raw=raw,
    )


def _sorted_remote_entity_revisions(
    revisions: Iterable[_RemoteEntityRevision],
) -> list[_RemoteEntityRevision]:
    revisions_by_id = {revision.revision_id: revision for revision in revisions}
    visiting: set[str] = set()
    visited: set[str] = set()
    ordered: list[_RemoteEntityRevision] = []

    def visit(revision: _RemoteEntityRevision) -> None:
        if revision.revision_id in visited:
            return
        if revision.revision_id in visiting:
            visited.add(revision.revision_id)
            ordered.append(revision)
            return
        visiting.add(revision.revision_id)
        if revision.base_revision_id is not None:
            base_revision = revisions_by_id.get(revision.base_revision_id)
            if base_revision is not None:
                visit(base_revision)
        visiting.remove(revision.revision_id)
        visited.add(revision.revision_id)
        ordered.append(revision)

    for revision in sorted(
        revisions_by_id.values(),
        key=lambda value: (
            value.project_id,
            value.entity_type,
            value.entity_id,
            value.base_revision_id or "",
            value.revision_id,
        ),
    ):
        visit(revision)
    return ordered


def _coerce_remote_tombstone(raw: object) -> _RemoteTombstone | None:
    tombstone_id = _str_field(raw, "tombstone_id", "id")
    project_id = _str_field(raw, "project_id")
    target_type = _str_field(raw, "target_type")
    target_id = _str_field(raw, "target_id")
    if tombstone_id is None or project_id is None or target_type is None or target_id is None:
        return None
    return _RemoteTombstone(
        tombstone_id=tombstone_id,
        sync_group_id=_str_field(raw, "sync_group_id"),
        project_id=project_id,
        target_type=_normalize_target_type(target_type),
        target_id=target_id,
        author_device_id=_str_field(raw, "author_device_id"),
        deleted_at=_first_field(raw, "deleted_at", default=None),
        raw=raw,
    )


def _source_artifact_for_manifest(manifest: object) -> _RemoteArtifact | None:
    source_artifacts = [
        artifact
        for artifact in _manifest_artifacts(manifest)
        if artifact.type == "source_audio"
    ]
    if not source_artifacts:
        return None
    return sorted(source_artifacts, key=lambda artifact: artifact.artifact_id)[0]


def _importable_source_artifact_for_manifest(
    artifacts: Iterable[_RemoteArtifact],
) -> tuple[_RemoteArtifact | None, str | None, dict[str, Any]]:
    source_artifacts = [
        artifact
        for artifact in artifacts
        if artifact.type == "source_audio"
    ]
    if len(source_artifacts) != 1:
        return (
            None,
            "Project manifest must contain exactly one source_audio artifact.",
            {"source_artifact_count": len(source_artifacts)},
        )

    source_artifact = source_artifacts[0]
    if source_artifact.format != "wav":
        return (
            None,
            "Project manifest source_audio artifact format must be 'wav'.",
            {"artifact_id": source_artifact.artifact_id, "format": source_artifact.format},
        )
    path_error = _manifest_relative_path_error(source_artifact.relative_path)
    if path_error is not None:
        return (
            None,
            path_error,
            {
                "artifact_id": source_artifact.artifact_id,
                "relative_path": source_artifact.relative_path,
            },
        )
    assert source_artifact.relative_path is not None
    if PurePosixPath(source_artifact.relative_path).suffix.lower() != ".wav":
        return (
            None,
            "Project manifest source_audio artifact relative_path must end with .wav.",
            {
                "artifact_id": source_artifact.artifact_id,
                "relative_path": source_artifact.relative_path,
            },
        )
    return source_artifact, None, {}


def _manifest_relative_path_error(relative_path: str | None) -> str | None:
    if relative_path is None or "\x00" in relative_path or "\\" in relative_path:
        return "Sync manifest artifact relative path is invalid."
    path = PurePosixPath(relative_path)
    if path.is_absolute() or not path.parts:
        return "Sync manifest artifact relative path is invalid."
    if any(part in {"", ".", ".."} for part in path.parts):
        return "Sync manifest artifact relative path is invalid."
    return None


def _manifest_artifacts(manifest: object) -> list[_RemoteArtifact]:
    return [
        artifact
        for artifact in (_coerce_remote_artifact(raw) for raw in _list_field(manifest, "artifacts"))
        if artifact is not None
    ]


def _manifest_entity_revisions(manifest: object) -> list[_RemoteEntityRevision]:
    return [
        revision
        for revision in (_coerce_remote_revision(raw) for raw in _list_field(manifest, "entity_revisions", "revisions"))
        if revision is not None
    ]


def _manifest_artifact_availability(
    artifacts: Iterable[_RemoteArtifact],
    *,
    remote: _RemoteRequest,
    local: _LocalState,
) -> list[tuple[_RemoteArtifact, Artifact | None, str | None]]:
    availability: list[tuple[_RemoteArtifact, Artifact | None, str | None]] = []
    for artifact in sorted(artifacts, key=lambda value: value.artifact_id):
        if artifact.content_sha256 is None:
            availability.append((artifact, None, None))
            continue
        local_artifact = _verified_artifact_for_hash(
            local,
            artifact.content_sha256,
            size_bytes=artifact.size_bytes,
        )
        provider_device_id = None if local_artifact is not None else _choose_provider(remote, artifact.content_sha256)
        availability.append((artifact, local_artifact, provider_device_id))
    return availability


def _project_id_from_manifest(manifest: object) -> str | None:
    project = _first_field(manifest, "project", default=manifest)
    return _str_field(project, "project_id", "id")


def _choose_provider(remote: _RemoteRequest, content_sha256: str) -> str | None:
    providers = remote.provider_device_ids_by_content_sha256.get(content_sha256, ())
    return providers[0] if providers else None


def _planned_project_ids(actions: Iterable[SyncReconciliationAction]) -> frozenset[str]:
    return frozenset(
        action.item_id
        for action in actions
        if action.action_type == ACTION_IMPORT_PROJECT_MANIFEST and action.item_type == ITEM_PROJECT
    )


def _planned_artifact_project_ids(actions: Iterable[SyncReconciliationAction]) -> dict[str, str]:
    return {
        action.item_id: action.project_id
        for action in actions
        if action.action_type == ACTION_IMPORT_ARTIFACT_MANIFEST
        and action.item_type == ITEM_ARTIFACT
        and action.project_id is not None
    }


def _verified_artifact_for_hash(
    local: _LocalState,
    content_sha256: str,
    *,
    exclude_artifact_id: str | None = None,
    size_bytes: int | None = None,
) -> Artifact | None:
    for artifact in local.artifacts_by_content_sha256.get(content_sha256, ()):
        if artifact.id == exclude_artifact_id:
            continue
        if _artifact_has_verified_content(artifact, content_sha256, size_bytes):
            return artifact
    return None


def _artifact_has_verified_content(
    artifact: Artifact,
    content_sha256: str,
    size_bytes: int | None,
) -> bool:
    if _normalize_sha256(artifact.content_sha256) != content_sha256:
        return False
    artifact_path = Path(artifact.path).expanduser()
    if size_bytes is not None:
        try:
            if artifact_path.stat().st_size != size_bytes:
                return False
        except OSError:
            return False
    return file_sha256(artifact_path) == content_sha256


def _divergent_local_revision(
    remote_revision: _RemoteEntityRevision,
    local: _LocalState,
) -> SyncEntityRevision | None:
    key = (
        remote_revision.project_id,
        remote_revision.entity_type,
        remote_revision.entity_id,
    )
    for local_revision in local.entity_revisions_by_entity.get(key, ()):
        if local_revision.id == remote_revision.revision_id:
            continue
        if local_revision.base_revision_id != remote_revision.base_revision_id:
            continue
        if _local_revision_content_sha256(local_revision) == remote_revision.content_sha256:
            continue
        return local_revision
    return None


def _local_revision_content_sha256(revision: SyncEntityRevision) -> str | None:
    payload = revision.payload_json
    if isinstance(payload, Mapping):
        return revision_payload_sha256(sanitize_revision_payload(payload))
    return _normalize_sha256(revision.content_sha256)


def _upsert_item(
    items_by_key: dict[tuple[str, str], SyncReconciliationItem],
    item: SyncReconciliationItem,
) -> None:
    existing = items_by_key.get((item.item_type, item.item_id))
    if existing is None or _STATUS_PRECEDENCE[item.status] > _STATUS_PRECEDENCE[existing.status]:
        items_by_key[(item.item_type, item.item_id)] = item


def _action(
    action_type: str,
    *,
    item_type: str,
    item_id: str,
    project_id: str | None,
    content_sha256: str | None = None,
    provider_device_id: str | None = None,
    reason: str | None = None,
    details: dict[str, Any] | None = None,
) -> SyncReconciliationAction:
    return SyncReconciliationAction(
        action_type=action_type,
        item_type=item_type,
        item_id=item_id,
        project_id=project_id,
        content_sha256=content_sha256,
        provider_device_id=provider_device_id,
        reason=reason,
        priority=_ACTION_PRIORITY[action_type],
        details=details or {},
    )


def _dedupe_actions(actions: Iterable[SyncReconciliationAction]) -> list[SyncReconciliationAction]:
    seen: set[tuple[Any, ...]] = set()
    deduped: list[SyncReconciliationAction] = []
    for action in actions:
        key = _action_key(action)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(action)
    return sorted(deduped, key=lambda action: action.priority)


def _action_key(action: SyncReconciliationAction) -> tuple[Any, ...]:
    return (
        action.priority,
        action.action_type,
        action.project_id or "",
        action.item_type,
        action.item_id,
        action.content_sha256 or "",
        action.provider_device_id or "",
        _stable_json(action.details or {}),
    )


def _item_sort_key(item: SyncReconciliationItem) -> tuple[int, str, str, str, str]:
    item_type_order = {
        ITEM_DELETE_TOMBSTONE: 0,
        ITEM_PROJECT: 1,
        ITEM_ARTIFACT: 2,
        ITEM_ENTITY_REVISION: 3,
    }.get(item.item_type, 99)
    return (
        item_type_order,
        item.project_id or "",
        item.item_type,
        item.item_id,
        item.status,
    )


def _summarize(
    items: list[SyncReconciliationItem],
    actions: list[SyncReconciliationAction],
) -> SyncReconciliationSummary:
    counts = Counter(item.status for item in items)
    status_counts = {status: int(counts.get(status, 0)) for status in SYNC_RECONCILIATION_STATUSES}
    return SyncReconciliationSummary(
        status_counts=status_counts,
        total_items=len(items),
        total_actions=len(actions),
        total_conflicts=status_counts["conflicted"],
    )


def _remote_tombstone_sort_key(tombstone: _RemoteTombstone) -> tuple[str, str, str, str, str]:
    return (
        tombstone.project_id,
        tombstone.target_type,
        tombstone.target_id,
        _sortable_datetime(tombstone.deleted_at),
        tombstone.tombstone_id,
    )


def _tombstone_details(tombstone: _RemoteTombstone) -> dict[str, Any]:
    return {
        "tombstone_id": tombstone.tombstone_id,
        "sync_group_id": tombstone.sync_group_id,
        "author_device_id": tombstone.author_device_id,
        "target_type": tombstone.target_type,
        "target_id": tombstone.target_id,
        "deleted_at": _sortable_datetime(tombstone.deleted_at),
    }


def _normalize_target_type(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"revision", "entity"}:
        return ITEM_ENTITY_REVISION
    return normalized


def _normalize_sha256(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized or None


def _is_sha256(value: str) -> bool:
    if len(value) != 64:
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


def _first_field(source: object, *names: str, default: object = _MISSING) -> Any:
    for name in names:
        if isinstance(source, Mapping) and name in source:
            return source[name]
        if hasattr(source, name):
            return getattr(source, name)
    if default is _MISSING:
        return None
    return default


def _list_field(source: object, *names: str) -> list[Any]:
    value = _first_field(source, *names, default=[])
    return _as_list(value)


def _as_list(value: object) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        return list(value.values())
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _str_field(source: object, *names: str, default: str | None = None) -> str | None:
    value = _first_field(source, *names, default=default)
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    value = value.strip()
    return value or None


def _int_field(source: object, *names: str) -> int | None:
    value = _first_field(source, *names, default=None)
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


def _sortable_datetime(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if value is None:
        return ""
    return str(value)


def _stable_json(value: Mapping[str, Any]) -> str:
    return json.dumps(value, default=str, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
