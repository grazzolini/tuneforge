from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Project, SyncDeleteTombstone
from app.services.sync_manifest import (
    hydrate_project_analysis_result_from_artifact,
    import_staged_project_manifest,
)
from app.services.sync_project_status import update_project_sync_status
from app.services.sync_reconciliation import (
    ACTION_APPLY_DELETE_TOMBSTONE,
    ACTION_FETCH_ARTIFACT_CONTENT,
    ACTION_IMPORT_ARTIFACT_MANIFEST,
    ACTION_IMPORT_ENTITY_REVISION,
    ACTION_IMPORT_PROJECT_MANIFEST,
    ACTION_NOOP,
    ACTION_RECORD_CONFLICT,
    ACTION_UPSERT_PROJECT_STATUS,
    ITEM_ENTITY_REVISION,
    ITEM_PROJECT,
    SyncReconciliationAction,
    SyncReconciliationPlan,
    plan_sync_reconciliation,
)
from app.services.sync_staging import cleanup_staged_artifacts, require_staged_artifact
from app.services.sync_tombstones import apply_delete_tombstone

APPLY_STATUS_APPLIED = "applied"
APPLY_STATUS_SATISFIED = "satisfied"
APPLY_STATUS_SKIPPED = "skipped"
APPLY_STATUS_FAILED = "failed"

_MISSING = object()


@dataclass(frozen=True)
class SyncReconciliationApplySummary:
    planned_actions: int
    applied_actions: int
    satisfied_actions: int
    skipped_actions: int
    failed_actions: int


@dataclass(frozen=True)
class SyncReconciliationApplyActionResult:
    action: SyncReconciliationAction
    status: str
    reason: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SyncReconciliationApplyResult:
    summary: SyncReconciliationApplySummary
    plan: SyncReconciliationPlan
    results: list[SyncReconciliationApplyActionResult]


@dataclass(frozen=True)
class _ApplyContext:
    project_manifests_by_id: dict[str, object]
    tombstones_by_id: dict[str, object]
    tombstones_by_target: dict[tuple[str, str], object]
    staging_root: str | None
    use_content_addressed_staging: bool


def apply_sync_reconciliation(
    session: Session,
    request: object | Mapping[str, Any],
) -> SyncReconciliationApplyResult:
    context = _apply_context(request)
    plan = _with_staged_manifest_import_actions(
        session,
        plan_sync_reconciliation(session, request),
        context,
    )
    results = [_apply_action_in_savepoint(session, action, context) for action in plan.actions]
    results.extend(_hydrate_imported_project_analysis(session, context, results))
    if context.use_content_addressed_staging:
        _cleanup_imported_content_addressed_staging(session, context)
    return SyncReconciliationApplyResult(
        summary=_summarize_apply_results(plan, results),
        plan=plan,
        results=results,
    )


def _apply_action_in_savepoint(
    session: Session,
    action: SyncReconciliationAction,
    context: _ApplyContext,
) -> SyncReconciliationApplyActionResult:
    try:
        with session.begin_nested():
            return _apply_action(session, action, context)
    except AppError as exc:
        return SyncReconciliationApplyActionResult(
            action=action,
            status=APPLY_STATUS_FAILED,
            reason=exc.message,
            details=_error_details(action, exc),
        )


def _apply_action(
    session: Session,
    action: SyncReconciliationAction,
    context: _ApplyContext,
) -> SyncReconciliationApplyActionResult:
    if action.action_type == ACTION_NOOP:
        return _result(action, APPLY_STATUS_SATISFIED, "Action is already satisfied.")
    if action.action_type == ACTION_FETCH_ARTIFACT_CONTENT:
        return _verify_staged_artifact(session, action)
    if action.action_type == ACTION_IMPORT_PROJECT_MANIFEST:
        return _import_project_manifest(session, action, context)
    if action.action_type == ACTION_APPLY_DELETE_TOMBSTONE:
        return _apply_delete_tombstone_action(session, action, context)
    if action.action_type == ACTION_UPSERT_PROJECT_STATUS:
        return _upsert_project_status(session, action, context)
    if action.action_type == ACTION_IMPORT_ARTIFACT_MANIFEST:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Standalone artifact manifest import is not available through existing sync services.",
        )
    if action.action_type == ACTION_IMPORT_ENTITY_REVISION:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Standalone entity revision import is not available through existing sync services.",
            details={"supported_path": "Include the revision in a staged project manifest."},
        )
    if action.action_type == ACTION_RECORD_CONFLICT:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Conflict persistence is not available through existing sync services.",
        )
    return _result(action, APPLY_STATUS_SKIPPED, "Reconciliation action type is not supported.")


def _verify_staged_artifact(
    session: Session,
    action: SyncReconciliationAction,
) -> SyncReconciliationApplyActionResult:
    if action.content_sha256 is None:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Fetch action does not identify content_sha256.",
        )
    try:
        staged_artifact = require_staged_artifact(session, content_sha256=action.content_sha256)
    except AppError as exc:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Required artifact content is not staged locally.",
            details={"error_code": exc.code, "error_details": exc.details},
        )
    return _result(
        action,
        APPLY_STATUS_SATISFIED,
        "Required artifact content is staged and verified locally.",
        details={
            "content_sha256": staged_artifact.content_sha256,
            "size_bytes": staged_artifact.size_bytes,
            "provider_device_id": staged_artifact.provider_device_id,
        },
    )


def _import_project_manifest(
    session: Session,
    action: SyncReconciliationAction,
    context: _ApplyContext,
) -> SyncReconciliationApplyActionResult:
    project_id = action.project_id or action.item_id
    manifest = context.project_manifests_by_id.get(project_id)
    if manifest is None:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Project manifest is not present in the apply request.",
        )

    if context.use_content_addressed_staging:
        missing = _missing_content_addressed_artifacts(session, manifest)
        if missing:
            return _result(
                action,
                APPLY_STATUS_SKIPPED,
                "Project manifest import is waiting for staged artifact content.",
                details={"missing_artifacts": missing},
            )

    project = import_staged_project_manifest(
        session,
        manifest=manifest,
        staging_root=context.staging_root,
        use_content_addressed_staging=context.use_content_addressed_staging,
    )
    return _result(
        action,
        APPLY_STATUS_APPLIED,
        "Project manifest was imported through the sync manifest service.",
        details={"project_id": project.id},
    )


def _apply_delete_tombstone_action(
    session: Session,
    action: SyncReconciliationAction,
    context: _ApplyContext,
) -> SyncReconciliationApplyActionResult:
    tombstone = _tombstone_for_action(session, action, context)
    if tombstone is None:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Delete tombstone is not present in the apply request.",
        )

    apply_delete_tombstone(session, tombstone)
    return _result(
        action,
        APPLY_STATUS_APPLIED,
        "Delete tombstone was applied through the sync tombstone service.",
        details={
            "tombstone_id": tombstone.id,
            "target_type": tombstone.target_type,
            "target_id": tombstone.target_id,
            "project_id": tombstone.project_id,
            "persisted_tombstone": tombstone in session,
        },
    )


def _upsert_project_status(
    session: Session,
    action: SyncReconciliationAction,
    context: _ApplyContext,
) -> SyncReconciliationApplyActionResult:
    project_id = action.project_id or action.item_id
    project_status = _string_from_mapping(action.details, "project_status")
    if project_status is None:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Project status action does not include a project_status.",
        )

    manifest_or_metadata = context.project_manifests_by_id.get(project_id)
    if manifest_or_metadata is None:
        remote_metadata = _mapping_from_mapping(action.details, "remote_metadata")
        if remote_metadata is not None and _string_from_mapping(remote_metadata, "display_name") is not None:
            manifest_or_metadata = remote_metadata

    if session.get(Project, project_id) is None and manifest_or_metadata is None:
        return _result(
            action,
            APPLY_STATUS_SKIPPED,
            "Project status placeholder requires project metadata.",
        )

    status_details = _mapping_from_mapping(action.details, "status_details") or {}
    required_artifact_ids, provider_device_ids = _status_artifact_and_provider_ids(action, status_details)
    project = update_project_sync_status(
        session,
        project_id=project_id,
        sync_status=project_status,
        sync_status_reason=action.reason,
        sync_required_artifact_ids=required_artifact_ids,
        sync_provider_device_ids=provider_device_ids,
        sync_conflict_count=1 if project_status == "conflicted" else 0,
        manifest=manifest_or_metadata,
    )
    return _result(
        action,
        APPLY_STATUS_APPLIED,
        "Project sync status was updated through the sync status service.",
        details={
            "project_id": project.id,
            "sync_status": project.sync_status,
            "sync_required_artifact_ids": project.sync_required_artifact_ids,
            "sync_provider_device_ids": project.sync_provider_device_ids,
        },
    )


def _missing_content_addressed_artifacts(
    session: Session,
    manifest: object,
) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    for artifact in _list_field(manifest, "artifacts"):
        artifact_id = _string_field(artifact, "artifact_id", "id")
        content_sha256 = _string_field(artifact, "content_sha256")
        size_bytes = _int_field(artifact, "size_bytes")
        if content_sha256 is None or size_bytes is None:
            missing.append(
                {
                    "artifact_id": artifact_id,
                    "content_sha256": content_sha256,
                    "reason": "Artifact manifest does not include content_sha256 and size_bytes.",
                }
            )
            continue
        try:
            require_staged_artifact(session, content_sha256=content_sha256, size_bytes=size_bytes)
        except AppError as exc:
            missing.append(
                {
                    "artifact_id": artifact_id,
                    "content_sha256": content_sha256,
                    "error_code": exc.code,
                }
            )
    return missing


def _cleanup_imported_content_addressed_staging(
    session: Session,
    context: _ApplyContext,
) -> None:
    imported_hashes: set[str] = set()
    pending_hashes: set[str] = set()
    imported_references: list[dict[str, Any]] = []
    for project_id, manifest in context.project_manifests_by_id.items():
        artifact_hashes = _manifest_artifact_hashes(manifest)
        if _project_is_imported(session, project_id):
            imported_hashes.update(artifact_hashes)
            imported_references.extend(_manifest_artifact_references(manifest))
        else:
            pending_hashes.update(artifact_hashes)

    cleanup_hashes = imported_hashes - pending_hashes
    cleanup_references = [
        reference
        for reference in imported_references
        if reference["content_sha256"] in cleanup_hashes
    ]
    if cleanup_hashes or cleanup_references:
        cleanup_staged_artifacts(
            session,
            content_sha256s=cleanup_hashes,
            references=cleanup_references,
        )


def _hydrate_imported_project_analysis(
    session: Session,
    context: _ApplyContext,
    results: list[SyncReconciliationApplyActionResult],
) -> list[SyncReconciliationApplyActionResult]:
    repair_results: list[SyncReconciliationApplyActionResult] = []
    imported_project_ids = {
        result.action.project_id or result.action.item_id
        for result in results
        if result.action.action_type == ACTION_IMPORT_PROJECT_MANIFEST
        and result.status == APPLY_STATUS_APPLIED
    }
    for project_id, manifest in context.project_manifests_by_id.items():
        if project_id in imported_project_ids:
            continue
        if not _project_is_imported(session, project_id) or not _manifest_has_analysis_artifact(manifest):
            continue
        action = SyncReconciliationAction(
            action_type=ACTION_NOOP,
            item_type=ITEM_PROJECT,
            item_id=project_id,
            project_id=project_id,
            content_sha256=_manifest_source_sha256(manifest),
            reason="Repair imported project analysis from a synced analysis artifact.",
            priority=30,
            details={"source": "analysis_json", "repair": "analysis_result"},
        )
        try:
            with session.begin_nested():
                hydrate_project_analysis_result_from_artifact(session, project_id)
            repair_results.append(
                _result(
                    action,
                    APPLY_STATUS_SATISFIED,
                    "Project analysis result is hydrated from the synced analysis artifact.",
                )
            )
        except AppError as exc:
            repair_results.append(
                SyncReconciliationApplyActionResult(
                    action=action,
                    status=APPLY_STATUS_FAILED,
                    reason=exc.message,
                    details=_error_details(action, exc),
                )
            )
    return repair_results


def _manifest_has_analysis_artifact(manifest: object) -> bool:
    return any(
        _string_field(artifact, "type") == "analysis_json"
        for artifact in _list_field(manifest, "artifacts")
    )


def _manifest_artifact_hashes(manifest: object) -> set[str]:
    return {
        content_sha256
        for artifact in _list_field(manifest, "artifacts")
        if (content_sha256 := _string_field(artifact, "content_sha256")) is not None
    }


def _manifest_artifact_references(manifest: object) -> list[dict[str, Any]]:
    references: list[dict[str, Any]] = []
    for artifact in _list_field(manifest, "artifacts"):
        content_sha256 = _string_field(artifact, "content_sha256")
        project_id = _string_field(artifact, "project_id")
        artifact_id = _string_field(artifact, "artifact_id", "id")
        if content_sha256 is None or project_id is None or artifact_id is None:
            continue
        references.append(
            {
                "content_sha256": content_sha256,
                "project_id": project_id,
                "artifact_id": artifact_id,
            }
        )
    return references


def _tombstone_for_action(
    session: Session,
    action: SyncReconciliationAction,
    context: _ApplyContext,
) -> SyncDeleteTombstone | None:
    tombstone_id = _string_from_mapping(action.details, "tombstone_id")
    raw_tombstone = context.tombstones_by_id.get(tombstone_id) if tombstone_id is not None else None
    if raw_tombstone is None:
        raw_tombstone = context.tombstones_by_target.get((action.item_type, action.item_id))
    if raw_tombstone is None:
        return None

    raw_tombstone_id = _required_string(raw_tombstone, "tombstone_id", "id")
    persisted = session.get(SyncDeleteTombstone, raw_tombstone_id)
    if persisted is not None:
        return persisted

    tombstone = SyncDeleteTombstone(
        id=raw_tombstone_id,
        sync_group_id=_required_string(raw_tombstone, "sync_group_id"),
        project_id=_required_string(raw_tombstone, "project_id"),
        target_type=_normalize_target_type(_required_string(raw_tombstone, "target_type")),
        target_id=_required_string(raw_tombstone, "target_id"),
        author_device_id=_required_string(raw_tombstone, "author_device_id"),
        deleted_at=_datetime_field(raw_tombstone, "deleted_at") or _utcnow(),
        prior_metadata_json=_mapping_field(raw_tombstone, "prior_metadata", "prior_metadata_json") or {},
        created_at=_datetime_field(raw_tombstone, "created_at") or _utcnow(),
        updated_at=_datetime_field(raw_tombstone, "updated_at") or _utcnow(),
    )
    session.add(tombstone)
    session.flush()
    return tombstone


def _status_artifact_and_provider_ids(
    action: SyncReconciliationAction,
    status_details: Mapping[str, Any],
) -> tuple[list[str], list[str]]:
    artifact_ids: set[str] = set()
    provider_ids: set[str] = set()

    artifact_providers = status_details.get("artifact_providers")
    if isinstance(artifact_providers, Mapping):
        for artifact_id, provider_device_id in artifact_providers.items():
            if isinstance(artifact_id, str) and artifact_id:
                artifact_ids.add(artifact_id)
            if isinstance(provider_device_id, str) and provider_device_id:
                provider_ids.add(provider_device_id)

    raw_artifact_ids = status_details.get("artifact_ids")
    if isinstance(raw_artifact_ids, list):
        artifact_ids.update(item for item in raw_artifact_ids if isinstance(item, str) and item)

    if isinstance(action.provider_device_id, str) and action.provider_device_id:
        provider_ids.add(action.provider_device_id)

    return sorted(artifact_ids), sorted(provider_ids)


def _apply_context(request: object | Mapping[str, Any]) -> _ApplyContext:
    project_manifests = _list_field(request, "project_manifests")
    project_manifests_by_id = {
        project_id: manifest
        for project_id, manifest in (
            (_project_id_from_manifest(manifest), manifest)
            for manifest in project_manifests
        )
        if project_id is not None
    }

    remote_library = _field(request, "remote_library", default={})
    tombstones = [
        *(_list_field(remote_library, "delete_tombstones", "tombstones")),
        *(tombstone for manifest in project_manifests for tombstone in _list_field(manifest, "delete_tombstones")),
    ]
    tombstones_by_id: dict[str, object] = {}
    tombstones_by_target: dict[tuple[str, str], object] = {}
    for tombstone in tombstones:
        tombstone_id = _string_field(tombstone, "tombstone_id", "id")
        target_type = _normalize_target_type(_string_field(tombstone, "target_type") or "")
        target_id = _string_field(tombstone, "target_id")
        if tombstone_id is not None:
            tombstones_by_id[tombstone_id] = tombstone
        if target_type and target_id is not None:
            tombstones_by_target[(target_type, target_id)] = tombstone

    return _ApplyContext(
        project_manifests_by_id=project_manifests_by_id,
        tombstones_by_id=tombstones_by_id,
        tombstones_by_target=tombstones_by_target,
        staging_root=_string_field(request, "staging_root"),
        use_content_addressed_staging=_bool_field(request, "use_content_addressed_staging", default=True),
    )


def _with_staged_manifest_import_actions(
    session: Session,
    plan: SyncReconciliationPlan,
    context: _ApplyContext,
) -> SyncReconciliationPlan:
    staged_import_actions = _staged_manifest_import_actions(session, plan, context)
    if not staged_import_actions:
        return plan

    actions = [*plan.actions, *staged_import_actions]
    summary = type(plan.summary)(
        status_counts=plan.summary.status_counts,
        total_items=plan.summary.total_items,
        total_actions=len(actions),
        total_conflicts=plan.summary.total_conflicts,
    )
    return SyncReconciliationPlan(summary=summary, items=plan.items, actions=actions)


def _staged_manifest_import_actions(
    session: Session,
    plan: SyncReconciliationPlan,
    context: _ApplyContext,
) -> list[SyncReconciliationAction]:
    planned_import_project_ids = {
        action.project_id or action.item_id
        for action in plan.actions
        if action.action_type == ACTION_IMPORT_PROJECT_MANIFEST and action.item_type == ITEM_PROJECT
    }
    priority = _project_manifest_import_priority(plan)
    actions: list[SyncReconciliationAction] = []
    for project_id in sorted(context.project_manifests_by_id):
        if project_id in planned_import_project_ids:
            continue
        if _project_has_blocking_apply_action(plan, project_id):
            continue
        if _project_is_imported(session, project_id):
            continue
        manifest = context.project_manifests_by_id[project_id]
        actions.append(
            SyncReconciliationAction(
                action_type=ACTION_IMPORT_PROJECT_MANIFEST,
                item_type=ITEM_PROJECT,
                item_id=project_id,
                project_id=project_id,
                content_sha256=_manifest_source_sha256(manifest),
                provider_device_id=None,
                reason="Import project manifest using artifact content that is already staged locally.",
                priority=priority,
                details={
                    "source": "sync_staged_artifacts",
                    "staged_content_required": True,
                },
            )
        )
    return actions


def _project_has_blocking_apply_action(plan: SyncReconciliationPlan, project_id: str) -> bool:
    for action in plan.actions:
        if action.project_id != project_id and action.item_id != project_id:
            continue
        if action.action_type == ACTION_RECORD_CONFLICT:
            return True
        if action.action_type == ACTION_APPLY_DELETE_TOMBSTONE and action.item_type == ITEM_PROJECT:
            return True
        if (
            action.action_type == ACTION_UPSERT_PROJECT_STATUS
            and _string_from_mapping(action.details, "project_status") in {"conflicted", "deleted"}
        ):
            return True
    return False


def _project_is_imported(session: Session, project_id: str) -> bool:
    project = session.get(Project, project_id)
    if project is None:
        return False
    source_path = (project.source_path or "").strip()
    imported_path = (project.imported_path or "").strip()
    return bool(
        source_path
        and imported_path
        and not source_path.startswith("sync-placeholder:")
        and not imported_path.startswith("sync-placeholder:")
    )


def _project_manifest_import_priority(plan: SyncReconciliationPlan) -> int:
    for action in plan.actions:
        if action.action_type == ACTION_IMPORT_PROJECT_MANIFEST:
            return action.priority
    return 30


def _manifest_source_sha256(manifest: object) -> str | None:
    project = _field(manifest, "project", default=manifest)
    project_source_sha256 = _string_field(project, "source_sha256")
    if project_source_sha256 is not None:
        return project_source_sha256
    for artifact in _list_field(manifest, "artifacts"):
        if _string_field(artifact, "type") == "source_audio":
            return _string_field(artifact, "content_sha256")
    return None


def _project_id_from_manifest(manifest: object) -> str | None:
    project = _field(manifest, "project", default=manifest)
    return _string_field(project, "project_id", "id")


def _summarize_apply_results(
    plan: SyncReconciliationPlan,
    results: list[SyncReconciliationApplyActionResult],
) -> SyncReconciliationApplySummary:
    return SyncReconciliationApplySummary(
        planned_actions=len(plan.actions),
        applied_actions=sum(1 for result in results if result.status == APPLY_STATUS_APPLIED),
        satisfied_actions=sum(1 for result in results if result.status == APPLY_STATUS_SATISFIED),
        skipped_actions=sum(1 for result in results if result.status == APPLY_STATUS_SKIPPED),
        failed_actions=sum(1 for result in results if result.status == APPLY_STATUS_FAILED),
    )


def _result(
    action: SyncReconciliationAction,
    status: str,
    reason: str,
    details: dict[str, Any] | None = None,
) -> SyncReconciliationApplyActionResult:
    return SyncReconciliationApplyActionResult(
        action=action,
        status=status,
        reason=reason,
        details=details or {},
    )


def _error_details(action: SyncReconciliationAction, exc: AppError) -> dict[str, Any]:
    return {
        "action_type": action.action_type,
        "item_type": action.item_type,
        "item_id": action.item_id,
        "project_id": action.project_id,
        "error_code": exc.code,
        "error_details": exc.details,
    }


def _field(source: object, name: str, *, default: object = _MISSING) -> Any:
    if isinstance(source, Mapping):
        value = source.get(name, default)
    else:
        model_dump = getattr(source, "model_dump", None)
        if callable(model_dump):
            dumped = model_dump(mode="python")
            value = dumped.get(name, default) if isinstance(dumped, Mapping) else default
        else:
            value = getattr(source, name, default)
    if value is _MISSING:
        raise KeyError(name)
    return value


def _list_field(source: object, *names: str) -> list[Any]:
    for name in names:
        value = _field(source, name, default=None)
        if value is None:
            continue
        if isinstance(value, list):
            return value
        if isinstance(value, tuple):
            return list(value)
        return []
    return []


def _string_field(source: object, *names: str) -> str | None:
    for name in names:
        value = _field(source, name, default=None)
        if isinstance(value, str):
            normalized = value.strip()
            if normalized:
                return normalized
    return None


def _required_string(source: object, *names: str) -> str:
    value = _string_field(source, *names)
    if value is None:
        expected = " or ".join(names)
        raise KeyError(expected)
    return value


def _string_from_mapping(source: Mapping[str, Any], name: str) -> str | None:
    value = source.get(name)
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _mapping_from_mapping(source: Mapping[str, Any], name: str) -> Mapping[str, Any] | None:
    value = source.get(name)
    return value if isinstance(value, Mapping) else None


def _mapping_field(source: object, *names: str) -> dict[str, Any] | None:
    for name in names:
        value = _field(source, name, default=None)
        if isinstance(value, Mapping):
            return dict(value)
    return None


def _int_field(source: object, name: str) -> int | None:
    value = _field(source, name, default=None)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _bool_field(source: object, name: str, *, default: bool) -> bool:
    value = _field(source, name, default=default)
    return value if isinstance(value, bool) else default


def _datetime_field(source: object, name: str) -> datetime | None:
    value = _field(source, name, default=None)
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    return None


def _normalize_target_type(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"revision", "entity", "sync_entity_revision"}:
        return ITEM_ENTITY_REVISION
    return normalized


def _utcnow() -> datetime:
    return datetime.now(UTC)
