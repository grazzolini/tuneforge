from __future__ import annotations

import hashlib
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.models import (
    Artifact,
    ChordTimeline,
    LyricsTranscript,
    Project,
    SyncDeleteTombstone,
    SyncEntityRevision,
    SyncLocalIdentity,
    SyncTrustedPeer,
)
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_reconciliation import (
    ACTION_APPLY_DELETE_TOMBSTONE,
    ACTION_FETCH_ARTIFACT_CONTENT,
    ACTION_IMPORT_ARTIFACT_MANIFEST,
    ACTION_IMPORT_ENTITY_REVISION,
    ACTION_IMPORT_PROJECT_MANIFEST,
    ACTION_NOOP,
    ACTION_RECORD_CONFLICT,
    ACTION_UPSERT_PROJECT_STATUS,
    ITEM_ARTIFACT,
    ITEM_DELETE_TOMBSTONE,
    ITEM_ENTITY_REVISION,
    ITEM_PROJECT,
    SyncReconciliationAction,
    SyncReconciliationItem,
    SyncReconciliationPlan,
    plan_sync_reconciliation,
)
from app.services.sync_revisions import revision_payload_sha256, sanitize_revision_payload


@pytest.fixture()
def db_session() -> Any:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_artifact_classification_uses_recorded_metadata_and_trusted_provider_choice(
    db_session: Session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_local", source_sha256=_sha("source"))
    identical_hash, identical_size = _write_file(tmp_path / "identical.wav", b"same bytes")
    local_conflict_hash, _ = _write_file(tmp_path / "conflict.wav", b"local conflict")
    size_mismatch_hash, size_mismatch_size = _write_file(
        tmp_path / "size-mismatch.wav",
        b"size mismatch",
    )
    missing_file_path = tmp_path / "missing-file.wav"
    missing_file_hash, missing_file_size = _write_file(missing_file_path, b"missing file")
    truncated_file_path = tmp_path / "truncated-file.wav"
    truncated_file_hash, truncated_file_size = _write_file(truncated_file_path, b"full artifact content")
    remote_hash = _sha("remote")
    untrusted_hash = _sha("untrusted")
    missing_provider_hash = _sha("missing provider")

    _add_artifact(
        db_session,
        artifact_id="art_identical",
        project_id=project.id,
        path=tmp_path / "identical.wav",
        content_sha256=identical_hash,
        size_bytes=identical_size,
    )
    _add_artifact(
        db_session,
        artifact_id="art_size_mismatch",
        project_id=project.id,
        path=tmp_path / "size-mismatch.wav",
        content_sha256=size_mismatch_hash,
        size_bytes=size_mismatch_size,
    )
    _add_artifact(
        db_session,
        artifact_id="art_missing_file",
        project_id=project.id,
        path=missing_file_path,
        content_sha256=missing_file_hash,
        size_bytes=missing_file_size,
    )
    _add_artifact(
        db_session,
        artifact_id="art_truncated_file",
        project_id=project.id,
        path=truncated_file_path,
        content_sha256=truncated_file_hash,
        size_bytes=truncated_file_size,
    )
    _add_artifact(
        db_session,
        artifact_id="art_conflict",
        project_id=project.id,
        path=tmp_path / "conflict.wav",
        content_sha256=local_conflict_hash,
        size_bytes=(tmp_path / "conflict.wav").stat().st_size,
    )
    db_session.commit()
    missing_file_path.unlink()
    truncated_file_path.write_bytes(b"truncated")

    request = {
        "remote_library": {
            "projects": [
                {
                    "project_id": project.id,
                    "display_name": project.display_name,
                    "source_sha256": project.source_sha256,
                }
            ],
            "artifacts": [
                _artifact_manifest(project.id, "art_identical", identical_hash, identical_size),
                _artifact_manifest(project.id, "art_size_mismatch", size_mismatch_hash, size_mismatch_size + 1),
                _artifact_manifest(project.id, "art_missing_file", missing_file_hash, missing_file_size),
                _artifact_manifest(project.id, "art_truncated_file", truncated_file_hash, truncated_file_size),
                _artifact_manifest(project.id, "art_remote_available", remote_hash, 64),
                _artifact_manifest(project.id, "art_missing_provider", missing_provider_hash, 64),
                _artifact_manifest(project.id, "art_conflict", _sha("remote conflict"), 64),
                _artifact_manifest(project.id, "art_duplicate_content", identical_hash, identical_size),
                _artifact_manifest(project.id, "art_untrusted_only", untrusted_hash, 64),
            ],
        },
        "peer_inventory": [
            {
                "device_id": "peer-b",
                "available_content_hashes": [
                    size_mismatch_hash,
                    missing_file_hash,
                    truncated_file_hash,
                    remote_hash,
                ],
            },
            {
                "device_id": "peer-a",
                "available_content_hashes": [
                    size_mismatch_hash,
                    missing_file_hash,
                    truncated_file_hash,
                    remote_hash,
                ],
            },
            {"device_id": "peer-revoked", "available_content_hashes": [untrusted_hash]},
            {"device_id": "peer-untrusted", "available_content_hashes": [untrusted_hash]},
        ],
    }

    monkeypatch.setattr(
        "app.services.sync_reconciliation.file_sha256",
        _fail_planner_file_sha256,
        raising=False,
    )
    plan = plan_sync_reconciliation(db_session, request)

    assert _item(plan, ITEM_PROJECT, project.id).status == "noop"
    assert _item(plan, ITEM_ARTIFACT, "art_identical").status == "identical_content"
    missing_local = _item(plan, ITEM_ARTIFACT, "art_size_mismatch")
    assert missing_local.status == "missing_local_bytes"
    assert missing_local.chosen_provider_device_id == "peer-a"
    missing_file = _item(plan, ITEM_ARTIFACT, "art_missing_file")
    assert missing_file.status == "missing_local_bytes"
    assert missing_file.chosen_provider_device_id == "peer-a"
    truncated_file = _item(plan, ITEM_ARTIFACT, "art_truncated_file")
    assert truncated_file.status == "missing_local_bytes"
    assert truncated_file.chosen_provider_device_id == "peer-a"
    remote_available = _item(plan, ITEM_ARTIFACT, "art_remote_available")
    assert remote_available.status == "remote_available"
    assert remote_available.chosen_provider_device_id == "peer-a"
    assert _item(plan, ITEM_ARTIFACT, "art_missing_provider").status == "missing_provider"
    assert _item(plan, ITEM_ARTIFACT, "art_untrusted_only").status == "missing_provider"
    assert _item(plan, ITEM_ARTIFACT, "art_conflict").status == "conflicted"
    duplicate = _item(plan, ITEM_ARTIFACT, "art_duplicate_content")
    assert duplicate.status == "identical_content"
    assert duplicate.action_type == ACTION_IMPORT_ARTIFACT_MANIFEST

    fetch_actions = {
        action.item_id: action
        for action in plan.actions
        if action.action_type == ACTION_FETCH_ARTIFACT_CONTENT
    }
    assert fetch_actions["art_size_mismatch"].provider_device_id == "peer-a"
    assert fetch_actions["art_missing_file"].provider_device_id == "peer-a"
    assert fetch_actions["art_truncated_file"].provider_device_id == "peer-a"
    assert fetch_actions["art_remote_available"].provider_device_id == "peer-a"
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_conflict") is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_missing_file") is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_truncated_file") is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_duplicate_content") is not None


def test_generated_analysis_same_hash_noops_even_when_remote_timestamp_is_newer(
    db_session: Session,
    tmp_path: Path,
) -> None:
    local_generated_at = datetime(2026, 1, 1, tzinfo=UTC)
    remote_generated_at = datetime(2026, 1, 2, tzinfo=UTC)
    analysis_hash = _sha("same generated analysis")
    request = _seed_generated_analysis_divergence(
        db_session,
        tmp_path,
        local_analysis_hash=analysis_hash,
        remote_analysis_hash=analysis_hash,
        local_generated_at=local_generated_at,
        remote_generated_at=remote_generated_at,
    )

    plan = plan_sync_reconciliation(db_session, request)

    analysis_item = _item(plan, ITEM_ARTIFACT, "art_generated_analysis")
    assert analysis_item.status == "identical_content"
    assert analysis_item.action_type == ACTION_NOOP
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_generated_analysis") is None


def test_generated_analysis_remote_newer_fetches_and_imports_without_conflict(
    db_session: Session,
    tmp_path: Path,
) -> None:
    local_hash = _sha("local generated analysis")
    remote_hash = _sha("remote generated analysis")
    request = _seed_generated_analysis_divergence(
        db_session,
        tmp_path,
        local_analysis_hash=local_hash,
        remote_analysis_hash=remote_hash,
        local_generated_at=datetime(2026, 1, 1, tzinfo=UTC),
        remote_generated_at=datetime(2026, 1, 2, tzinfo=UTC),
    )

    plan = plan_sync_reconciliation(db_session, request)

    analysis_item = _item(plan, ITEM_ARTIFACT, "art_generated_analysis")
    assert analysis_item.status == "remote_available"
    assert analysis_item.action_type == ACTION_FETCH_ARTIFACT_CONTENT
    assert analysis_item.chosen_provider_device_id == "peer-a"
    assert analysis_item.details["artifact_type"] == "analysis_json"
    assert analysis_item.details["artifact_id"] == "art_generated_analysis"
    assert analysis_item.details["local_content_sha256"] == local_hash
    assert analysis_item.details["remote_content_sha256"] == remote_hash
    assert analysis_item.details["generated_divergence_resolvable"] is True
    assert analysis_item.details["resolution"] == "fetch_remote"
    assert _item(plan, ITEM_PROJECT, "proj_generated_analysis").status == "noop"
    assert plan.summary.total_conflicts == 0
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_generated_analysis") is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_generated_analysis") is not None


@pytest.mark.parametrize(
    ("remote_generated_at", "expected_reason"),
    [
        (datetime(2025, 12, 31, tzinfo=UTC), "Local analysis_json generation timestamp is newer."),
        (datetime(2026, 1, 1, tzinfo=UTC), "Analysis generation timestamps tie; keeping local analysis_json."),
    ],
)
def test_generated_analysis_local_newer_or_tie_keeps_local_noop(
    db_session: Session,
    tmp_path: Path,
    remote_generated_at: datetime,
    expected_reason: str,
) -> None:
    local_hash = _sha("kept local generated analysis")
    remote_hash = _sha(f"remote generated analysis {remote_generated_at.isoformat()}")
    request = _seed_generated_analysis_divergence(
        db_session,
        tmp_path,
        local_analysis_hash=local_hash,
        remote_analysis_hash=remote_hash,
        local_generated_at=datetime(2026, 1, 1, tzinfo=UTC),
        remote_generated_at=remote_generated_at,
    )

    plan = plan_sync_reconciliation(db_session, request)

    analysis_item = _item(plan, ITEM_ARTIFACT, "art_generated_analysis")
    assert analysis_item.status == "noop"
    assert analysis_item.action_type == ACTION_NOOP
    assert analysis_item.reason == expected_reason
    assert analysis_item.details["generated_divergence_resolvable"] is True
    assert analysis_item.details["resolution"] == "keep_local"
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_generated_analysis") is None


@pytest.mark.parametrize(
    ("missing_side", "expected_local_source", "expected_remote_source"),
    [
        ("local", "missing", "metadata.analysis_generated_at"),
        ("remote", "metadata.analysis_generated_at", "missing"),
    ],
)
def test_generated_analysis_missing_generation_metadata_keeps_local_noop(
    db_session: Session,
    tmp_path: Path,
    missing_side: str,
    expected_local_source: str,
    expected_remote_source: str,
) -> None:
    request = _seed_generated_analysis_divergence(
        db_session,
        tmp_path,
        local_analysis_hash=_sha("local generated analysis missing timestamp"),
        remote_analysis_hash=_sha(f"remote generated analysis missing {missing_side} timestamp"),
        local_generated_at=None if missing_side == "local" else datetime(2026, 1, 1, tzinfo=UTC),
        remote_generated_at=None if missing_side == "remote" else datetime(2026, 1, 2, tzinfo=UTC),
    )

    plan = plan_sync_reconciliation(db_session, request)

    analysis_item = _item(plan, ITEM_ARTIFACT, "art_generated_analysis")
    assert analysis_item.status == "noop"
    assert analysis_item.action_type == ACTION_NOOP
    assert analysis_item.reason == "Analysis generation timestamp is missing; keeping local analysis_json."
    assert analysis_item.details["resolution"] == "keep_local"
    assert analysis_item.details["local_resolution_timestamp_source"] == expected_local_source
    assert analysis_item.details["remote_resolution_timestamp_source"] == expected_remote_source
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_generated_analysis") is None


@pytest.mark.parametrize(
    ("case", "expected_detail"),
    [
        ("non_regenerable", "Both analysis_json artifacts must be marked regenerable."),
        ("source_mismatch", "Analysis source artifact content hash differs."),
    ],
)
def test_generated_analysis_unresolvable_divergence_stays_conflicted(
    db_session: Session,
    tmp_path: Path,
    case: str,
    expected_detail: str,
) -> None:
    source_hash = _sha("generated analysis source")
    request = _seed_generated_analysis_divergence(
        db_session,
        tmp_path,
        local_analysis_hash=_sha("local unresolvable analysis"),
        remote_analysis_hash=_sha(f"remote unresolvable analysis {case}"),
        local_generated_at=datetime(2026, 1, 1, tzinfo=UTC),
        remote_generated_at=datetime(2026, 1, 2, tzinfo=UTC),
        local_can_regenerate=case != "non_regenerable",
        remote_source_hash=_sha("remote changed source") if case == "source_mismatch" else source_hash,
    )

    plan = plan_sync_reconciliation(db_session, request)

    analysis_item = _item(plan, ITEM_ARTIFACT, "art_generated_analysis")
    assert analysis_item.status == "conflicted"
    assert analysis_item.action_type == ACTION_RECORD_CONFLICT
    assert analysis_item.details["artifact_type"] == "analysis_json"
    assert analysis_item.details["artifact_id"] == "art_generated_analysis"
    assert analysis_item.details["local_content_sha256"] == _sha("local unresolvable analysis")
    assert analysis_item.details["remote_content_sha256"] == _sha(f"remote unresolvable analysis {case}")
    assert analysis_item.details["generated_divergence_resolvable"] is False
    assert analysis_item.details["generated_divergence_unresolvable_reason"] == expected_detail
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_generated_analysis") is None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_generated_analysis") is not None
    if case == "source_mismatch":
        source_item = _item(plan, ITEM_ARTIFACT, "art_generated_source")
        assert source_item.status == "conflicted"
        assert source_item.details["artifact_type"] == "source_audio"


def test_issue120_three_peer_group_uses_online_trusted_provider_deterministically(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    now = datetime.now(UTC)
    db_session.add(
        SyncTrustedPeer(
            device_id="peer-c",
            sync_group_id="group-a",
            display_name="Peer C",
            public_key="pub-peer-c",
            endpoint_hints_json=[],
            trusted_at=now,
            revoked_at=None,
            created_at=now,
            updated_at=now,
        )
    )
    project = _add_project(db_session, "proj_issue120_three_peer", source_sha256=_sha("issue120 source"))
    online_hash = _sha("issue120 online artifact")
    untrusted_only_hash = _sha("issue120 untrusted artifact")
    db_session.commit()

    base_request = {
        "remote_library": {
            "projects": [{"project_id": project.id, "source_sha256": project.source_sha256}],
            "artifacts": [
                _artifact_manifest(project.id, "art_issue120_online", online_hash, 64),
                _artifact_manifest(project.id, "art_issue120_untrusted_only", untrusted_only_hash, 64),
            ],
        },
    }

    all_online_plan = plan_sync_reconciliation(
        db_session,
        {
            **base_request,
            "peer_inventory": [
                {"device_id": "peer-c", "available_content_hashes": [online_hash]},
                {"device_id": "peer-b", "available_content_hashes": [online_hash]},
                {"device_id": "peer-a", "available_content_hashes": [online_hash]},
                {"device_id": "peer-revoked", "available_content_hashes": [online_hash, untrusted_only_hash]},
                {"device_id": "peer-untrusted", "available_content_hashes": [online_hash, untrusted_only_hash]},
            ],
        },
    )

    all_online_item = _item(all_online_plan, ITEM_ARTIFACT, "art_issue120_online")
    assert all_online_item.status == "remote_available"
    assert all_online_item.chosen_provider_device_id == "peer-a"
    all_online_fetch = _action(
        all_online_plan,
        ACTION_FETCH_ARTIFACT_CONTENT,
        ITEM_ARTIFACT,
        "art_issue120_online",
    )
    assert all_online_fetch is not None
    assert all_online_fetch.provider_device_id == "peer-a"
    all_online_import = _action(
        all_online_plan,
        ACTION_IMPORT_ARTIFACT_MANIFEST,
        ITEM_ARTIFACT,
        "art_issue120_online",
    )
    assert all_online_import is not None
    assert all_online_import.provider_device_id == "peer-a"

    first_provider_absent_plan = plan_sync_reconciliation(
        db_session,
        {
            **base_request,
            "peer_inventory": [
                {"device_id": "peer-c", "available_content_hashes": [online_hash]},
                {"device_id": "peer-b", "available_content_hashes": [online_hash]},
                {"device_id": "peer-revoked", "available_content_hashes": [online_hash, untrusted_only_hash]},
                {"device_id": "peer-untrusted", "available_content_hashes": [online_hash, untrusted_only_hash]},
            ],
        },
    )

    switched_item = _item(first_provider_absent_plan, ITEM_ARTIFACT, "art_issue120_online")
    assert switched_item.status == "remote_available"
    assert switched_item.chosen_provider_device_id == "peer-b"
    switched_fetch = _action(
        first_provider_absent_plan,
        ACTION_FETCH_ARTIFACT_CONTENT,
        ITEM_ARTIFACT,
        "art_issue120_online",
    )
    assert switched_fetch is not None
    assert switched_fetch.provider_device_id == "peer-b"
    switched_import = _action(
        first_provider_absent_plan,
        ACTION_IMPORT_ARTIFACT_MANIFEST,
        ITEM_ARTIFACT,
        "art_issue120_online",
    )
    assert switched_import is not None
    assert switched_import.provider_device_id == "peer-b"
    untrusted_only = _item(first_provider_absent_plan, ITEM_ARTIFACT, "art_issue120_untrusted_only")
    assert untrusted_only.status == "missing_provider"
    assert (
        _action(
            first_provider_absent_plan,
            ACTION_FETCH_ARTIFACT_CONTENT,
            ITEM_ARTIFACT,
            "art_issue120_untrusted_only",
        )
        is None
    )
    assert (
        _action(
            first_provider_absent_plan,
            ACTION_IMPORT_ARTIFACT_MANIFEST,
            ITEM_ARTIFACT,
            "art_issue120_untrusted_only",
        )
        is None
    )


def test_valid_tombstones_apply_first_and_untrusted_tombstones_are_noop(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_tombstones", source_sha256=_sha("source"))
    artifact_hash, artifact_size = _write_file(tmp_path / "deleted.wav", b"deleted bytes")
    import_hash = _sha("import")
    deleted_project_source = _sha("deleted project")
    _add_artifact(
        db_session,
        artifact_id="art_deleted",
        project_id=project.id,
        path=tmp_path / "deleted.wav",
        content_sha256=artifact_hash,
        size_bytes=artifact_size,
    )
    db_session.commit()

    valid_tombstone = _tombstone(
        tombstone_id="tomb_art_deleted",
        project_id=project.id,
        target_type=ITEM_ARTIFACT,
        target_id="art_deleted",
        author_device_id="peer-a",
    )
    deleted_project_tombstone = _tombstone(
        tombstone_id="tomb_project_deleted",
        project_id="proj_deleted_remote",
        target_type=ITEM_PROJECT,
        target_id="proj_deleted_remote",
        author_device_id="dev-local",
    )
    wrong_group_tombstone = _tombstone(
        tombstone_id="tomb_wrong_group",
        project_id=project.id,
        target_type=ITEM_ARTIFACT,
        target_id="art_wrong_group",
        author_device_id="peer-a",
        sync_group_id="other-group",
    )
    revoked_tombstone = _tombstone(
        tombstone_id="tomb_revoked",
        project_id=project.id,
        target_type=ITEM_ARTIFACT,
        target_id="art_revoked",
        author_device_id="peer-revoked",
    )
    stale_deleted_project_manifest = _project_manifest("proj_deleted_remote", deleted_project_source)
    stale_deleted_project_manifest["project"]["created_at"] = datetime(2026, 1, 1, tzinfo=UTC)
    stale_deleted_project_manifest["project"]["updated_at"] = datetime(2026, 1, 1, tzinfo=UTC)
    request = {
        "remote_library": {
            "projects": [
                {"project_id": project.id, "source_sha256": project.source_sha256},
                {"project_id": "proj_deleted_remote", "source_sha256": deleted_project_source},
            ],
            "artifacts": [
                _artifact_manifest(project.id, "art_deleted", _sha("remote update"), artifact_size),
                _artifact_manifest(project.id, "art_import", import_hash, 64),
            ],
            "delete_tombstones": [
                valid_tombstone,
                wrong_group_tombstone,
                revoked_tombstone,
                deleted_project_tombstone,
            ],
        },
        "project_manifests": [stale_deleted_project_manifest],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [import_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    assert _item(plan, ITEM_ARTIFACT, "art_deleted").status == "deleted"
    assert _item(plan, ITEM_PROJECT, "proj_deleted_remote").status == "deleted"
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_wrong_group").status == "noop"
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_wrong_group").action_type == ACTION_NOOP
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_revoked").status == "noop"
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, "proj_deleted_remote") is None
    deleted_status = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, "proj_deleted_remote")
    assert deleted_status is not None
    assert deleted_status.details["project_status"] == "deleted"
    assert deleted_status.details["create_placeholder"] is False
    assert all(
        action.action_type == ACTION_APPLY_DELETE_TOMBSTONE
        for action in plan.actions[:2]
    )
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_wrong_group") is None
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_revoked") is None


def test_newer_project_manifest_wins_over_older_local_project_tombstone(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("reimported source")
    project_id = source_hash_to_project_id(source_hash)
    deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    reimported_at = datetime(2026, 1, 2, tzinfo=UTC)
    db_session.add(
        SyncDeleteTombstone(
            id="tomb_old_local_project",
            sync_group_id="group-a",
            project_id=project_id,
            target_type=ITEM_PROJECT,
            target_id=project_id,
            author_device_id="peer-a",
            deleted_at=deleted_at,
            created_at=deleted_at,
            updated_at=deleted_at,
            prior_metadata_json={"display_name": "Old Project"},
        )
    )
    db_session.flush()
    manifest = _project_manifest(project_id, source_hash)
    manifest["project"]["created_at"] = reimported_at
    manifest["project"]["updated_at"] = reimported_at

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    project_item = _item(plan, ITEM_PROJECT, project_id)
    assert project_item.status == "remote_available"
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_PROJECT, project_id) is None
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is not None


def test_older_remote_project_tombstone_does_not_delete_newer_local_project(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("local reimported source")
    project_id = source_hash_to_project_id(source_hash)
    project = _add_project(db_session, project_id, source_sha256=source_hash)
    project.updated_at = datetime(2026, 1, 2, tzinfo=UTC)
    deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    db_session.flush()

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [
                    {
                        "tombstone_id": "tomb_old_remote_project",
                        "sync_group_id": "group-a",
                        "project_id": project_id,
                        "target_type": ITEM_PROJECT,
                        "target_id": project_id,
                        "author_device_id": "peer-a",
                        "deleted_at": deleted_at,
                        "prior_metadata": {},
                        "created_at": deleted_at,
                        "updated_at": deleted_at,
                    }
                ],
            },
            "project_manifests": [],
            "peer_inventory": [],
        },
    )

    tombstone_item = _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_old_remote_project")
    assert tombstone_item.status == "noop"
    assert "older than a live project" in tombstone_item.reason
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_PROJECT, project_id) is None


def test_repeated_project_tombstone_is_noop_after_local_delete_applied(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("already deleted remote project")
    project_id = source_hash_to_project_id(source_hash)
    stale_at = datetime(2026, 1, 1, tzinfo=UTC)
    deleted_at = datetime(2026, 1, 2, tzinfo=UTC)
    db_session.add(
        SyncDeleteTombstone(
            id="tomb_known_project_delete",
            sync_group_id="group-a",
            project_id=project_id,
            target_type=ITEM_PROJECT,
            target_id=project_id,
            author_device_id="peer-a",
            deleted_at=deleted_at,
            prior_metadata_json={"display_name": "Deleted Project"},
            created_at=deleted_at,
            updated_at=deleted_at,
        )
    )
    db_session.commit()
    remote_project = {
        "project_id": project_id,
        "display_name": "Deleted Project",
        "source_sha256": source_hash,
        "created_at": stale_at,
        "updated_at": stale_at,
    }
    tombstone = _tombstone(
        tombstone_id="tomb_known_project_delete",
        project_id=project_id,
        target_type=ITEM_PROJECT,
        target_id=project_id,
        author_device_id="peer-a",
    )
    tombstone["deleted_at"] = deleted_at
    tombstone["created_at"] = deleted_at
    tombstone["updated_at"] = deleted_at

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [remote_project],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [tombstone],
            },
            "project_manifests": [],
            "peer_inventory": [],
        },
    )

    tombstone_item = _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_known_project_delete")
    assert tombstone_item.status == "noop"
    assert tombstone_item.reason == "Delete tombstone is already applied locally."
    project_item = _item(plan, ITEM_PROJECT, project_id)
    assert project_item.status == "noop"
    assert project_item.reason == "Project delete tombstone is already applied locally."
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_PROJECT, project_id) is None
    assert _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, project_id) is None
    assert plan.summary.status_counts["deleted"] == 0


def test_reimported_project_supersedes_older_child_tombstones_for_missing_old_ids(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("reimported child tombstone source")
    project_id = source_hash_to_project_id(source_hash)
    deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    reimported_at = datetime(2026, 1, 2, tzinfo=UTC)
    project = _add_project(db_session, project_id, source_sha256=source_hash)
    project.created_at = reimported_at
    project.updated_at = reimported_at
    db_session.add_all(
        [
            SyncDeleteTombstone(
                id="tomb_old_local_artifact",
                sync_group_id="group-a",
                project_id=project_id,
                target_type=ITEM_ARTIFACT,
                target_id="art_old_deleted_stem",
                author_device_id="dev-local",
                deleted_at=deleted_at,
                prior_metadata_json={"artifact_id": "art_old_deleted_stem"},
                created_at=deleted_at,
                updated_at=deleted_at,
            ),
            SyncDeleteTombstone(
                id="tomb_old_local_revision",
                sync_group_id="group-a",
                project_id=project_id,
                target_type=ITEM_ENTITY_REVISION,
                target_id="rev_old_deleted_chords",
                author_device_id="dev-local",
                deleted_at=deleted_at,
                prior_metadata_json={"revision_id": "rev_old_deleted_chords"},
                created_at=deleted_at,
                updated_at=deleted_at,
            ),
        ]
    )
    db_session.commit()
    manifest = _project_manifest(project_id, source_hash)
    manifest["project"]["created_at"] = reimported_at
    manifest["project"]["updated_at"] = reimported_at
    remote_artifact_tombstone = _tombstone(
        tombstone_id="tomb_old_remote_artifact",
        project_id=project_id,
        target_type=ITEM_ARTIFACT,
        target_id="art_old_deleted_stem",
        author_device_id="peer-a",
    )
    remote_revision_tombstone = _tombstone(
        tombstone_id="tomb_old_remote_revision",
        project_id=project_id,
        target_type=ITEM_ENTITY_REVISION,
        target_id="rev_old_deleted_chords",
        author_device_id="peer-a",
    )
    for tombstone in (remote_artifact_tombstone, remote_revision_tombstone):
        tombstone["deleted_at"] = deleted_at
        tombstone["created_at"] = deleted_at
        tombstone["updated_at"] = deleted_at

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [remote_artifact_tombstone, remote_revision_tombstone],
            },
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_old_remote_artifact").status == "noop"
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_old_remote_revision").status == "noop"
    assert all(item.status != "deleted" for item in plan.items)
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_old_deleted_stem") is None
    assert (
        _action(
            plan,
            ACTION_APPLY_DELETE_TOMBSTONE,
            ITEM_ENTITY_REVISION,
            "rev_old_deleted_chords",
        )
        is None
    )


def test_remote_reimported_project_supersedes_older_remote_child_tombstone_without_local_project(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("remote reimported child tombstone source")
    project_id = source_hash_to_project_id(source_hash)
    deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    reimported_at = datetime(2026, 1, 2, tzinfo=UTC)
    newer_deleted_at = datetime(2026, 1, 3, tzinfo=UTC)
    manifest = _project_manifest(project_id, source_hash)
    manifest["project"]["created_at"] = reimported_at
    manifest["project"]["updated_at"] = reimported_at
    older_tombstone = _tombstone(
        tombstone_id="tomb_older_remote_child",
        project_id=project_id,
        target_type=ITEM_ARTIFACT,
        target_id="art_older_deleted_stem",
        author_device_id="peer-a",
    )
    newer_tombstone = _tombstone(
        tombstone_id="tomb_newer_remote_child",
        project_id=project_id,
        target_type=ITEM_ARTIFACT,
        target_id="art_newer_deleted_stem",
        author_device_id="peer-a",
    )
    older_tombstone["deleted_at"] = deleted_at
    older_tombstone["created_at"] = deleted_at
    older_tombstone["updated_at"] = deleted_at
    newer_tombstone["deleted_at"] = newer_deleted_at
    newer_tombstone["created_at"] = newer_deleted_at
    newer_tombstone["updated_at"] = newer_deleted_at

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [manifest["project"]],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [older_tombstone, newer_tombstone],
            },
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "remote_available"
    older_item = _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_older_remote_child")
    assert older_item.status == "noop"
    assert older_item.reason == "Delete tombstone is older than a live sync target."
    newer_item = _item(plan, ITEM_ARTIFACT, "art_newer_deleted_stem")
    assert newer_item.status == "deleted"
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_older_deleted_stem") is None
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_newer_deleted_stem") is not None


def test_entity_revision_ancestry_imports_descendants_and_lww_siblings(
    db_session: Session,
    tmp_path: Path,
) -> None:
    del tmp_path
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_revisions", source_sha256=_sha("source"))
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_base",
        content_sha256=_sha("base"),
        base_revision_id=None,
    )
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_existing",
        content_sha256=_revision_payload_sha("rev_existing"),
        base_revision_id="rev_base",
    )
    db_session.commit()

    request = {
        "remote_library": {
            "projects": [{"project_id": project.id, "source_sha256": project.source_sha256}],
            "entity_revisions": [
                _revision_manifest(
                    project.id,
                    revision_id="rev_existing",
                    content_sha256=_revision_payload_sha("rev_existing"),
                    base_revision_id="rev_base",
                ),
                _revision_manifest(
                    project.id,
                    revision_id="rev_a_remote_grandchild",
                    content_sha256=_revision_payload_sha("rev_a_remote_grandchild"),
                    base_revision_id="rev_z_remote_descendant",
                ),
                _revision_manifest(
                    project.id,
                    revision_id="rev_z_remote_descendant",
                    content_sha256=_revision_payload_sha("rev_z_remote_descendant"),
                    base_revision_id="rev_existing",
                ),
                _revision_manifest(
                    project.id,
                    revision_id="rev_remote_sibling",
                    content_sha256=_revision_payload_sha("rev_remote_sibling"),
                    base_revision_id="rev_base",
                ),
            ],
        }
    }

    plan = plan_sync_reconciliation(db_session, request)

    assert _item(plan, ITEM_ENTITY_REVISION, "rev_existing").status == "identical_content"
    descendant = _item(plan, ITEM_ENTITY_REVISION, "rev_z_remote_descendant")
    assert descendant.status == "remote_available"
    assert descendant.action_type == ACTION_IMPORT_ENTITY_REVISION
    grandchild = _item(plan, ITEM_ENTITY_REVISION, "rev_a_remote_grandchild")
    assert grandchild.status == "remote_available"
    assert grandchild.action_type == ACTION_IMPORT_ENTITY_REVISION
    sibling = _item(plan, ITEM_ENTITY_REVISION, "rev_remote_sibling")
    assert sibling.status == "remote_available"
    assert sibling.action_type == ACTION_IMPORT_ENTITY_REVISION
    import_revision_action_ids = [
        action.item_id
        for action in plan.actions
        if action.action_type == ACTION_IMPORT_ENTITY_REVISION
    ]
    assert import_revision_action_ids.index("rev_z_remote_descendant") < import_revision_action_ids.index(
        "rev_a_remote_grandchild"
    )
    assert _action(plan, ACTION_IMPORT_ENTITY_REVISION, ITEM_ENTITY_REVISION, "rev_remote_sibling") is not None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ENTITY_REVISION, "rev_remote_sibling") is None


def test_entity_revision_lww_imports_newer_same_base_sibling(
    db_session: Session,
    tmp_path: Path,
) -> None:
    del tmp_path
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_revision_lww_remote", source_sha256=_sha("source"))
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    local_time = datetime(2026, 1, 2, tzinfo=UTC)
    remote_time = datetime(2026, 1, 3, tzinfo=UTC)
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_lww_remote_base",
        content_sha256=_sha("base"),
        base_revision_id=None,
        created_at=base_time,
        updated_at=base_time,
    )
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_lww_remote_local",
        content_sha256=_revision_payload_sha("rev_lww_remote_local"),
        base_revision_id="rev_lww_remote_base",
        created_at=local_time,
        updated_at=local_time,
    )
    db_session.commit()

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [{"project_id": project.id, "source_sha256": project.source_sha256}],
                "entity_revisions": [
                    _revision_manifest(
                        project.id,
                        revision_id="rev_lww_remote_newer",
                        content_sha256=_revision_payload_sha("rev_lww_remote_newer"),
                        base_revision_id="rev_lww_remote_base",
                        created_at=remote_time,
                        updated_at=remote_time,
                    )
                ],
            }
        },
    )

    item = _item(plan, ITEM_ENTITY_REVISION, "rev_lww_remote_newer")
    assert item.status == "remote_available"
    assert item.action_type == ACTION_IMPORT_ENTITY_REVISION
    assert item.reason == "Remote entity revision is newer than the divergent local revision."
    assert item.details["local_revision_id"] == "rev_lww_remote_local"
    assert item.details["remote_revision_id"] == "rev_lww_remote_newer"
    assert _action(plan, ACTION_IMPORT_ENTITY_REVISION, ITEM_ENTITY_REVISION, "rev_lww_remote_newer") is not None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ENTITY_REVISION, "rev_lww_remote_newer") is None


def test_entity_revision_lww_keeps_newer_local_same_base_sibling(
    db_session: Session,
    tmp_path: Path,
) -> None:
    del tmp_path
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_revision_lww_local", source_sha256=_sha("source"))
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    remote_time = datetime(2026, 1, 2, tzinfo=UTC)
    local_time = datetime(2026, 1, 3, tzinfo=UTC)
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_lww_local_base",
        content_sha256=_sha("base"),
        base_revision_id=None,
        created_at=base_time,
        updated_at=base_time,
    )
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_lww_local_current",
        content_sha256=_revision_payload_sha("rev_lww_local_current"),
        base_revision_id="rev_lww_local_base",
        created_at=local_time,
        updated_at=local_time,
    )
    db_session.commit()

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {
                "projects": [{"project_id": project.id, "source_sha256": project.source_sha256}],
                "entity_revisions": [
                    _revision_manifest(
                        project.id,
                        revision_id="rev_lww_local_older_remote",
                        content_sha256=_revision_payload_sha("rev_lww_local_older_remote"),
                        base_revision_id="rev_lww_local_base",
                        created_at=remote_time,
                        updated_at=remote_time,
                    )
                ],
            }
        },
    )

    item = _item(plan, ITEM_ENTITY_REVISION, "rev_lww_local_older_remote")
    assert item.status == "noop"
    assert item.action_type == ACTION_NOOP
    assert item.reason == "Local entity revision is newer than the divergent remote revision."
    assert _action(plan, ACTION_IMPORT_ENTITY_REVISION, ITEM_ENTITY_REVISION, "rev_lww_local_older_remote") is None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ENTITY_REVISION, "rev_lww_local_older_remote") is None


def test_existing_project_manifest_scoped_revision_does_not_create_standalone_conflict(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "legacy-hash-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "legacy-hash-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    dirty_payload = {
        "revision_id": "rev_legacy_hash",
        "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
        "source_path": str(tmp_path / "local-only.wav"),
    }
    safe_payload = sanitize_revision_payload(dirty_payload)
    legacy_hash = revision_payload_sha256(dirty_payload)
    canonical_hash = revision_payload_sha256(safe_payload)
    now = datetime.now(UTC)
    db_session.add(
        SyncEntityRevision(
            id="rev_legacy_hash",
            project_id=project_id,
            entity_type="chords",
            entity_id=project_id,
            revision_type="manual",
            base_revision_id=None,
            source_artifact_id=f"art_source_{project_id}",
            content_sha256=legacy_hash,
            author_device_id="dev-local",
            state="current",
            metadata_json={},
            payload_json=dirty_payload,
            created_at=now,
            updated_at=now,
        )
    )
    db_session.commit()

    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            {
                "revision_id": "rev_legacy_hash",
                "project_id": project_id,
                "entity_type": "chords",
                "entity_id": project_id,
                "revision_type": "manual",
                "base_revision_id": None,
                "author_device_id": "peer-a",
                "source_artifact_id": f"art_source_{project_id}",
                "content_sha256": canonical_hash,
                "state": "current",
                "metadata": {},
                "payload": safe_payload,
                "created_at": now,
                "updated_at": now,
            }
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [
                {"device_id": "peer-a", "available_content_hashes": [source_hash]}
            ],
        },
    )

    assert all(
        item.item_id != "rev_legacy_hash"
        for item in plan.items
        if item.item_type == ITEM_ENTITY_REVISION
    )
    assert plan.summary.total_conflicts == 0
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ENTITY_REVISION, "rev_legacy_hash") is None


def test_existing_project_imports_missing_embedded_current_chords_and_lyrics(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-revisions-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-revisions-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    chord_payload = {
        "revision_id": "rev_embedded_current_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    lyrics_payload = {
        "revision_id": "rev_embedded_current_lyrics",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "text": "hello"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_embedded_current_chords",
                entity_type="chords",
                payload=chord_payload,
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_embedded_current_lyrics",
                entity_type="lyrics",
                payload=lyrics_payload,
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    chord_item = _item(plan, ITEM_ENTITY_REVISION, "rev_embedded_current_chords")
    assert chord_item.status == "remote_available"
    assert chord_item.action_type == ACTION_IMPORT_ENTITY_REVISION
    lyrics_item = _item(plan, ITEM_ENTITY_REVISION, "rev_embedded_current_lyrics")
    assert lyrics_item.status == "remote_available"
    assert lyrics_item.action_type == ACTION_IMPORT_ENTITY_REVISION
    assert _action(
        plan,
        ACTION_IMPORT_ENTITY_REVISION,
        ITEM_ENTITY_REVISION,
        "rev_embedded_current_chords",
    ) is not None
    assert _action(
        plan,
        ACTION_IMPORT_ENTITY_REVISION,
        ITEM_ENTITY_REVISION,
        "rev_embedded_current_lyrics",
    ) is not None


def test_existing_project_imports_remote_lyrics_over_empty_local_fillers(
    db_session: Session,
    tmp_path: Path,
) -> None:
    source_hash, source_size, project_id = _seed_existing_project_with_source(
        db_session,
        tmp_path,
        filename="embedded-empty-local-lyrics-source.wav",
    )
    db_session.add(
        LyricsTranscript(
            project_id=project_id,
            segments_json=[],
            source_segments_json=[],
            has_user_edits=False,
            language_override=None,
            source_kind="ai",
        )
    )
    local_payload = {"revision_id": "rev_empty_local_lyrics", "segments": []}
    _add_revision(
        db_session,
        project_id=project_id,
        revision_id="rev_empty_local_lyrics",
        content_sha256=revision_payload_sha256(local_payload),
        base_revision_id=None,
        entity_type="lyrics",
        payload=local_payload,
    )
    db_session.commit()

    remote_payload = {
        "revision_id": "rev_remote_current_lyrics_after_empty_local",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "text": "hello"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_remote_current_lyrics_after_empty_local",
                entity_type="lyrics",
                payload=remote_payload,
            )
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    lyrics_item = _item(plan, ITEM_ENTITY_REVISION, "rev_remote_current_lyrics_after_empty_local")
    assert lyrics_item.status == "remote_available"
    assert lyrics_item.action_type == ACTION_IMPORT_ENTITY_REVISION
    assert _action(
        plan,
        ACTION_IMPORT_ENTITY_REVISION,
        ITEM_ENTITY_REVISION,
        "rev_remote_current_lyrics_after_empty_local",
    ) is not None


@pytest.mark.parametrize(
    ("intentional_source", "payload"),
    [
        ("row", {"language_override": "none"}),
        ("row", {"source_kind": "instrumental"}),
        ("revision", {"language_override": "none"}),
        ("revision", {"source_kind": "instrumental"}),
    ],
)
def test_existing_project_keeps_intentional_no_lyrics_over_remote_embedded_lyrics(
    db_session: Session,
    tmp_path: Path,
    intentional_source: str,
    payload: dict[str, str],
) -> None:
    intentional_key = next(iter(payload))
    source_hash, source_size, project_id = _seed_existing_project_with_source(
        db_session,
        tmp_path,
        filename=f"embedded-intentional-no-lyrics-{intentional_source}-{intentional_key}.wav",
    )
    db_session.add(
        LyricsTranscript(
            project_id=project_id,
            segments_json=[],
            source_segments_json=[],
            has_user_edits=False,
            language_override=payload.get("language_override") if intentional_source == "row" else None,
            source_kind=payload.get("source_kind") if intentional_source == "row" else "ai",
        )
    )
    local_revision_id = f"rev_intentional_no_lyrics_{intentional_source}_{intentional_key}"
    local_updated_at = datetime(2026, 1, 3, tzinfo=UTC)
    remote_updated_at = datetime(2026, 1, 2, tzinfo=UTC)
    local_payload = {
        "revision_id": local_revision_id,
        "segments": [],
        **(payload if intentional_source == "revision" else {}),
    }
    _add_revision(
        db_session,
        project_id=project_id,
        revision_id=local_revision_id,
        content_sha256=revision_payload_sha256(local_payload),
        base_revision_id=None,
        entity_type="lyrics",
        payload=local_payload,
        created_at=local_updated_at,
        updated_at=local_updated_at,
    )
    db_session.commit()

    remote_payload = {
        "revision_id": "rev_remote_current_lyrics_blocked_by_intentional_local",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "text": "hello"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_remote_current_lyrics_blocked_by_intentional_local",
                entity_type="lyrics",
                payload=remote_payload,
                created_at=remote_updated_at,
                updated_at=remote_updated_at,
            )
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert all(
        item.item_id != "rev_remote_current_lyrics_blocked_by_intentional_local"
        for item in plan.items
        if item.item_type == ITEM_ENTITY_REVISION
    )
    assert _action(
        plan,
        ACTION_IMPORT_ENTITY_REVISION,
        ITEM_ENTITY_REVISION,
        "rev_remote_current_lyrics_blocked_by_intentional_local",
    ) is None


def test_existing_project_skips_empty_remote_embedded_lyrics_over_empty_local_row(
    db_session: Session,
    tmp_path: Path,
) -> None:
    source_hash, source_size, project_id = _seed_existing_project_with_source(
        db_session,
        tmp_path,
        filename="embedded-empty-remote-lyrics-source.wav",
    )
    db_session.add(
        LyricsTranscript(
            project_id=project_id,
            segments_json=[],
            source_segments_json=[],
            has_user_edits=False,
            language_override=None,
            source_kind="ai",
        )
    )
    db_session.commit()

    remote_payload = {
        "revision_id": "rev_remote_empty_lyrics",
        "segments": [],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_remote_empty_lyrics",
                entity_type="lyrics",
                payload=remote_payload,
            )
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert all(
        item.item_id != "rev_remote_empty_lyrics"
        for item in plan.items
        if item.item_type == ITEM_ENTITY_REVISION
    )
    assert _action(
        plan,
        ACTION_IMPORT_ENTITY_REVISION,
        ITEM_ENTITY_REVISION,
        "rev_remote_empty_lyrics",
    ) is None


def test_existing_project_imports_missing_embedded_revision_chain_in_order(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-revision-chain-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-revision-chain-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    base_payload = {
        "revision_id": "rev_embedded_base_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    current_payload = {
        "revision_id": "rev_embedded_current_child_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_embedded_base_chords",
                entity_type="chords",
                payload=base_payload,
                state="superseded",
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_embedded_current_child_chords",
                entity_type="chords",
                payload=current_payload,
                base_revision_id="rev_embedded_base_chords",
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    base_item = _item(plan, ITEM_ENTITY_REVISION, "rev_embedded_base_chords")
    assert base_item.status == "remote_available"
    assert base_item.action_type == ACTION_IMPORT_ENTITY_REVISION
    current_item = _item(plan, ITEM_ENTITY_REVISION, "rev_embedded_current_child_chords")
    assert current_item.status == "remote_available"
    assert current_item.action_type == ACTION_IMPORT_ENTITY_REVISION
    import_revision_action_ids = [
        action.item_id
        for action in plan.actions
        if action.action_type == ACTION_IMPORT_ENTITY_REVISION
    ]
    assert import_revision_action_ids.index("rev_embedded_base_chords") < import_revision_action_ids.index(
        "rev_embedded_current_child_chords"
    )


@pytest.mark.parametrize("case", ["bad_payload_hash", "missing_source_artifact"])
def test_existing_project_skips_embedded_revision_chain_when_current_is_invalid(
    db_session: Session,
    tmp_path: Path,
    case: str,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / f"embedded-invalid-chain-{case}.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / f"embedded-invalid-chain-{case}.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    base_payload = {
        "revision_id": f"rev_invalid_chain_base_{case}",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    current_payload = {
        "revision_id": f"rev_invalid_chain_current_{case}",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    current_revision = _current_revision_manifest(
        project_id,
        revision_id=f"rev_invalid_chain_current_{case}",
        entity_type="chords",
        payload=current_payload,
        base_revision_id=f"rev_invalid_chain_base_{case}",
        content_sha256=(
            _sha("invalid child payload hash")
            if case == "bad_payload_hash"
            else None
        ),
        source_artifact_id=(
            "art_missing_revision_source"
            if case == "missing_source_artifact"
            else None
        ),
    )
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id=f"rev_invalid_chain_base_{case}",
                entity_type="chords",
                payload=base_payload,
                state="superseded",
            ),
            current_revision,
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in (
        f"rev_invalid_chain_base_{case}",
        f"rev_invalid_chain_current_{case}",
    ):
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_skips_duplicate_embedded_current_revisions(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-duplicate-current-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-duplicate-current-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    first_payload = {
        "revision_id": "rev_duplicate_current_chords_a",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    second_payload = {
        "revision_id": "rev_duplicate_current_chords_b",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_duplicate_current_chords_a",
                entity_type="chords",
                payload=first_payload,
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_duplicate_current_chords_b",
                entity_type="chords",
                payload=second_payload,
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in ("rev_duplicate_current_chords_a", "rev_duplicate_current_chords_b"):
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_skips_duplicate_embedded_current_singleton_with_different_entity_ids(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-duplicate-singleton-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-duplicate-singleton-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    first_payload = {
        "revision_id": "rev_duplicate_singleton_chords_a",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    second_payload = {
        "revision_id": "rev_duplicate_singleton_chords_b",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_duplicate_singleton_chords_a",
                entity_type="chords",
                payload=first_payload,
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_duplicate_singleton_chords_b",
                entity_type="chords",
                entity_id="other-chord-entity",
                payload=second_payload,
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in ("rev_duplicate_singleton_chords_a", "rev_duplicate_singleton_chords_b"):
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_skips_embedded_chain_with_foreign_base(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-foreign-base-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-foreign-base-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    foreign_payload = {
        "revision_id": "rev_foreign_lyrics_base",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "text": "base"}],
    }
    current_payload = {
        "revision_id": "rev_current_chords_foreign_base",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_foreign_lyrics_base",
                entity_type="lyrics",
                payload=foreign_payload,
                state="superseded",
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_current_chords_foreign_base",
                entity_type="chords",
                payload=current_payload,
                base_revision_id="rev_foreign_lyrics_base",
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in ("rev_foreign_lyrics_base", "rev_current_chords_foreign_base"):
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_skips_embedded_chain_when_current_is_tombstoned(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-tombstoned-current-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-tombstoned-current-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    base_payload = {
        "revision_id": "rev_tombstone_chain_base_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    current_payload = {
        "revision_id": "rev_tombstone_chain_current_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_tombstone_chain_base_chords",
                entity_type="chords",
                payload=base_payload,
                state="superseded",
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_tombstone_chain_current_chords",
                entity_type="chords",
                payload=current_payload,
                base_revision_id="rev_tombstone_chain_base_chords",
            ),
        ],
    )
    manifest["delete_tombstones"] = [
        _tombstone(
            tombstone_id="tomb_current_chords",
            project_id=project_id,
            target_type=ITEM_ENTITY_REVISION,
            target_id="rev_tombstone_chain_current_chords",
            author_device_id="peer-a",
        )
    ]

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in ("rev_tombstone_chain_base_chords", "rev_tombstone_chain_current_chords"):
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_skips_embedded_current_revision_when_local_content_exists(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-local-content-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-local-content-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    db_session.add_all(
        [
            ChordTimeline(project_id=project_id),
            LyricsTranscript(
                project_id=project_id,
                segments_json=[{"start_seconds": 0.0, "end_seconds": 1.0, "text": "local"}],
            ),
        ]
    )
    db_session.commit()

    chord_payload = {
        "revision_id": "rev_local_content_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    lyrics_payload = {
        "revision_id": "rev_local_content_lyrics",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "text": "hello"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_local_content_chords",
                entity_type="chords",
                payload=chord_payload,
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_local_content_lyrics",
                entity_type="lyrics",
                payload=lyrics_payload,
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in ("rev_local_content_chords", "rev_local_content_lyrics"):
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_skips_embedded_current_revision_when_local_revision_exists(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-local-revision-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-local-revision-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    _add_revision(
        db_session,
        project_id=project_id,
        revision_id="rev_local_current_chords",
        content_sha256=_revision_payload_sha("rev_local_current_chords"),
        base_revision_id=None,
        created_at=datetime(2026, 1, 3, tzinfo=UTC),
        updated_at=datetime(2026, 1, 3, tzinfo=UTC),
    )
    db_session.commit()

    base_payload = {
        "revision_id": "rev_remote_base_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    remote_payload = {
        "revision_id": "rev_remote_current_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_remote_base_chords",
                entity_type="chords",
                payload=base_payload,
                state="superseded",
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
                updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_remote_current_chords",
                entity_type="chords",
                payload=remote_payload,
                base_revision_id="rev_remote_base_chords",
                created_at=datetime(2026, 1, 2, tzinfo=UTC),
                updated_at=datetime(2026, 1, 2, tzinfo=UTC),
            )
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    assert _item(plan, ITEM_PROJECT, project_id).status == "noop"
    for revision_id in ("rev_remote_base_chords", "rev_remote_current_chords"):
        assert all(
            item.item_id != revision_id
            for item in plan.items
            if item.item_type == ITEM_ENTITY_REVISION
        )
        assert _action(
            plan,
            ACTION_IMPORT_ENTITY_REVISION,
            ITEM_ENTITY_REVISION,
            revision_id,
        ) is None


def test_existing_project_imports_newer_embedded_current_revision_chain(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash, source_size = _write_file(tmp_path / "embedded-newer-revision-source.wav", b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(db_session, project_id, source_sha256=source_hash)
    _add_artifact(
        db_session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / "embedded-newer-revision-source.wav",
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    _add_revision(
        db_session,
        project_id=project_id,
        revision_id="rev_embedded_lww_local_chords",
        content_sha256=_revision_payload_sha("rev_embedded_lww_local_chords"),
        base_revision_id=None,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    db_session.commit()

    base_payload = {
        "revision_id": "rev_embedded_lww_remote_base_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
    }
    remote_payload = {
        "revision_id": "rev_embedded_lww_remote_current_chords",
        "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
    }
    manifest = _project_manifest(
        project_id,
        source_hash,
        source_size_bytes=source_size,
        extra_revisions=[
            _current_revision_manifest(
                project_id,
                revision_id="rev_embedded_lww_remote_base_chords",
                entity_type="chords",
                payload=base_payload,
                state="superseded",
                created_at=datetime(2026, 1, 2, tzinfo=UTC),
                updated_at=datetime(2026, 1, 2, tzinfo=UTC),
            ),
            _current_revision_manifest(
                project_id,
                revision_id="rev_embedded_lww_remote_current_chords",
                entity_type="chords",
                payload=remote_payload,
                base_revision_id="rev_embedded_lww_remote_base_chords",
                created_at=datetime(2026, 1, 3, tzinfo=UTC),
                updated_at=datetime(2026, 1, 3, tzinfo=UTC),
            ),
        ],
    )

    plan = plan_sync_reconciliation(
        db_session,
        {
            "remote_library": {},
            "project_manifests": [manifest],
            "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
        },
    )

    current_item = _item(plan, ITEM_ENTITY_REVISION, "rev_embedded_lww_remote_current_chords")
    assert current_item.status == "remote_available"
    assert current_item.action_type == ACTION_IMPORT_ENTITY_REVISION
    import_revision_action_ids = [
        action.item_id
        for action in plan.actions
        if action.action_type == ACTION_IMPORT_ENTITY_REVISION
    ]
    assert import_revision_action_ids.index("rev_embedded_lww_remote_base_chords") < import_revision_action_ids.index(
        "rev_embedded_lww_remote_current_chords"
    )
    assert _action(
        plan,
        ACTION_RECORD_CONFLICT,
        ITEM_ENTITY_REVISION,
        "rev_embedded_lww_remote_current_chords",
    ) is None


@pytest.mark.parametrize(
    ("case", "expected_reason"),
    [
        ("payload_hash_mismatch", "Entity revision manifest content_sha256 must match payload."),
        ("unsafe_metadata", "Entity revision manifest metadata and payload must be sync-safe."),
        ("unsafe_payload", "Entity revision manifest metadata and payload must be sync-safe."),
    ],
)
def test_library_entity_revisions_reject_invalid_payload_contract(
    db_session: Session,
    case: str,
    expected_reason: str,
) -> None:
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_library_revision_contract", source_sha256=_sha("library revisions"))
    _add_revision(
        db_session,
        project_id=project.id,
        revision_id="rev_base_library_contract",
        content_sha256=_sha("library base"),
        base_revision_id=None,
    )
    db_session.commit()
    revision_id = f"rev_library_{case}"
    revision = _revision_manifest(
        project.id,
        revision_id=revision_id,
        content_sha256=_revision_payload_sha(revision_id),
        base_revision_id="rev_base_library_contract",
    )
    if case == "payload_hash_mismatch":
        revision["content_sha256"] = _sha("wrong library revision payload")
    elif case == "unsafe_metadata":
        revision["metadata"] = {"local_path": "/tmp/private.wav"}
    elif case == "unsafe_payload":
        revision["payload"] = {"revision_id": revision_id, "absolute_path": "/tmp/private.wav"}

    request = {
        "remote_library": {
            "projects": [{"project_id": project.id, "source_sha256": project.source_sha256}],
            "entity_revisions": [revision],
        }
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_ENTITY_REVISION, revision_id)
    assert item.status == "conflicted"
    assert item.reason == expected_reason
    assert _action(plan, ACTION_IMPORT_ENTITY_REVISION, ITEM_ENTITY_REVISION, revision_id) is None


@pytest.mark.parametrize(
    ("case", "expected_reason"),
    [
        ("wrong_base_entity", "Entity revision base_revision_id must reference the same project entity."),
        ("missing_source_artifact", "Entity revision source_artifact_id does not exist in the manifest."),
        ("foreign_source_artifact", "Entity revision source_artifact_id must belong to the manifest project."),
    ],
)
def test_library_entity_revisions_reject_invalid_reference_contract(
    db_session: Session,
    tmp_path: Path,
    case: str,
    expected_reason: str,
) -> None:
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_library_reference_contract", source_sha256=_sha("library references"))
    if case == "wrong_base_entity":
        _add_revision(
            db_session,
            project_id=project.id,
            revision_id="rev_wrong_base_library_contract",
            content_sha256=_sha("library wrong base"),
            base_revision_id=None,
            entity_id="other_entity",
        )
    elif case == "foreign_source_artifact":
        other_project = _add_project(
            db_session,
            "proj_library_reference_other",
            source_sha256=_sha("library references other"),
        )
        artifact_hash, artifact_size = _write_file(tmp_path / "foreign-source.wav", b"foreign source")
        _add_artifact(
            db_session,
            artifact_id="art_foreign_source",
            project_id=other_project.id,
            path=tmp_path / "foreign-source.wav",
            content_sha256=artifact_hash,
            size_bytes=artifact_size,
            artifact_type="source_audio",
        )
    db_session.commit()

    revision_id = f"rev_library_{case}"
    revision = _revision_manifest(
        project.id,
        revision_id=revision_id,
        content_sha256=_revision_payload_sha(revision_id),
        base_revision_id="rev_wrong_base_library_contract" if case == "wrong_base_entity" else None,
    )
    if case == "missing_source_artifact":
        revision["source_artifact_id"] = "art_missing_source"
    elif case == "foreign_source_artifact":
        revision["source_artifact_id"] = "art_foreign_source"

    request = {
        "remote_library": {
            "projects": [{"project_id": project.id, "source_sha256": project.source_sha256}],
            "entity_revisions": [revision],
        }
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_ENTITY_REVISION, revision_id)
    assert item.status == "conflicted"
    assert item.reason == expected_reason
    assert _action(plan, ACTION_IMPORT_ENTITY_REVISION, ITEM_ENTITY_REVISION, revision_id) is None


def test_missing_project_import_requires_manifest_and_source_availability(
    db_session: Session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _add_identity_and_peers(db_session)
    existing_project = _add_project(db_session, "proj_existing", source_sha256=_sha("existing source"))
    duplicate_hash, duplicate_size = _write_file(tmp_path / "duplicate-source.wav", b"duplicate source")
    remote_provider_hash = _sha("provider source")
    missing_hash = _sha("missing source")
    no_manifest_hash = _sha("no manifest")
    no_manifest_artifact_hash = _sha("no manifest artifact")
    duplicate_project_id = source_hash_to_project_id(duplicate_hash)
    remote_provider_project_id = source_hash_to_project_id(remote_provider_hash)
    missing_project_id = source_hash_to_project_id(missing_hash)
    no_manifest_project_id = source_hash_to_project_id(no_manifest_hash)
    _add_artifact(
        db_session,
        artifact_id="art_existing_source",
        project_id=existing_project.id,
        path=tmp_path / "duplicate-source.wav",
        content_sha256=duplicate_hash,
        size_bytes=duplicate_size,
        artifact_type="source_audio",
    )
    db_session.commit()

    request = {
        "remote_library": {
            "projects": [
                {"project_id": duplicate_project_id, "source_sha256": duplicate_hash},
                {"project_id": remote_provider_project_id, "source_sha256": remote_provider_hash},
                {"project_id": missing_project_id, "source_sha256": missing_hash},
                {"project_id": no_manifest_project_id, "source_sha256": no_manifest_hash},
            ],
            "artifacts": [
                _artifact_manifest(no_manifest_project_id, "art_no_manifest", no_manifest_artifact_hash, 64),
            ],
        },
        "project_manifests": [
            _project_manifest(duplicate_project_id, duplicate_hash, source_size_bytes=duplicate_size),
            _project_manifest(remote_provider_project_id, remote_provider_hash),
            _project_manifest(missing_project_id, missing_hash),
        ],
        "peer_inventory": [
            {"device_id": "peer-a", "available_content_hashes": [remote_provider_hash, no_manifest_artifact_hash]},
        ],
    }

    monkeypatch.setattr(
        "app.services.sync_reconciliation.file_sha256",
        _fail_planner_file_sha256,
        raising=False,
    )
    plan = plan_sync_reconciliation(db_session, request)

    duplicate_project = _item(plan, ITEM_PROJECT, duplicate_project_id)
    assert duplicate_project.status == "identical_content"
    assert duplicate_project.action_type == ACTION_IMPORT_PROJECT_MANIFEST
    provider_project = _item(plan, ITEM_PROJECT, remote_provider_project_id)
    assert provider_project.status == "remote_available"
    assert provider_project.chosen_provider_device_id == "peer-a"
    assert _item(plan, ITEM_PROJECT, missing_project_id).status == "missing_provider"
    assert _item(plan, ITEM_PROJECT, no_manifest_project_id).status == "missing_provider"
    assert _item(plan, ITEM_ARTIFACT, "art_no_manifest").status == "missing_provider"
    provider_status = _action(
        plan,
        ACTION_UPSERT_PROJECT_STATUS,
        ITEM_PROJECT,
        remote_provider_project_id,
    )
    assert provider_status is not None
    assert provider_status.provider_device_id == "peer-a"
    assert provider_status.details["project_status"] == "remote_available"
    assert provider_status.details["edit_locked"] is True
    assert provider_status.details["remote_metadata"]["source_sha256"] == remote_provider_hash
    missing_status = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, missing_project_id)
    assert missing_status is not None
    assert missing_status.details["project_status"] == "missing"
    no_manifest_status = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, no_manifest_project_id)
    assert no_manifest_status is not None
    assert no_manifest_status.details["project_status"] == "missing"
    assert _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, duplicate_project_id) is None
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, duplicate_project_id) is not None
    assert (
        _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, f"art_source_{remote_provider_project_id}")
        is not None
    )
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, remote_provider_project_id) is not None
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_no_manifest") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_no_manifest") is None


def test_existing_sync_placeholder_still_plans_manifest_import(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("placeholder source")
    project_id = source_hash_to_project_id(source_hash)
    placeholder = Project(
        id=project_id,
        display_name="Remote Placeholder",
        source_sha256=source_hash,
        source_path="",
        imported_path="",
    )
    placeholder.sync_status = "remote_available"
    placeholder.sync_required_artifact_ids_json = [f"art_source_{project_id}"]
    placeholder.sync_provider_device_ids_json = ["peer-a"]
    db_session.add(placeholder)
    db_session.commit()

    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [_project_manifest(project_id, source_hash)],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    placeholder_item = _item(plan, ITEM_PROJECT, project_id)
    assert placeholder_item.status == "remote_available"
    assert placeholder_item.action_type == ACTION_IMPORT_PROJECT_MANIFEST
    status_action = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, project_id)
    assert status_action is not None
    assert status_action.details["project_status"] == "remote_available"
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, f"art_source_{project_id}") is not None
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, f"art_source_{project_id}") is None


def test_missing_project_import_requires_every_manifest_artifact_available(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("atomic source")
    stem_hash = _sha("atomic stem")
    blocked_source_hash = _sha("blocked source")
    blocked_stem_hash = _sha("blocked stem")
    available_project_id = source_hash_to_project_id(source_hash)
    blocked_project_id = source_hash_to_project_id(blocked_source_hash)

    request = {
        "remote_library": {
            "projects": [
                {"project_id": available_project_id, "source_sha256": source_hash},
                {"project_id": blocked_project_id, "source_sha256": blocked_source_hash},
            ]
        },
        "project_manifests": [
            _project_manifest(
                available_project_id,
                source_hash,
                extra_artifacts=[
                    _artifact_manifest(available_project_id, "art_stem_available", stem_hash, 64),
                ],
                extra_revisions=[
                    _revision_manifest(
                        available_project_id,
                        revision_id="rev_manifest_imported_with_project",
                        content_sha256=_revision_payload_sha("rev_manifest_imported_with_project"),
                        base_revision_id=None,
                    ),
                ],
            ),
            _project_manifest(
                blocked_project_id,
                blocked_source_hash,
                extra_artifacts=[
                    _artifact_manifest(blocked_project_id, "art_stem_blocked", blocked_stem_hash, 64),
                ],
            ),
        ],
        "peer_inventory": [
            {
                "device_id": "peer-a",
                "available_content_hashes": [source_hash, stem_hash, blocked_source_hash],
            },
        ],
    }

    plan = plan_sync_reconciliation(db_session, request)

    available_project = _item(plan, ITEM_PROJECT, available_project_id)
    assert available_project.status == "remote_available"
    available_status = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, available_project_id)
    assert available_status is not None
    assert available_status.details["project_status"] == "remote_available"
    assert available_status.details["status_details"]["artifact_providers"] == {
        f"art_source_{available_project_id}": "peer-a",
        "art_stem_available": "peer-a",
    }
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, f"art_source_{available_project_id}") is not None
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_stem_available") is not None
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, available_project_id) is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_stem_available") is None
    assert _action(
        plan,
        ACTION_IMPORT_ENTITY_REVISION,
        ITEM_ENTITY_REVISION,
        "rev_manifest_imported_with_project",
    ) is None

    blocked_project = _item(plan, ITEM_PROJECT, blocked_project_id)
    assert blocked_project.status == "missing_provider"
    assert blocked_project.details == {"artifact_ids": ["art_stem_blocked"]}
    blocked_status = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, blocked_project_id)
    assert blocked_status is not None
    assert blocked_status.details["project_status"] == "missing"
    assert blocked_status.details["status_details"] == {"artifact_ids": ["art_stem_blocked"]}
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, blocked_project_id) is None
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, f"art_source_{blocked_project_id}") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_stem_blocked") is None


@pytest.mark.parametrize(
    ("case", "expected_reason"),
    [
        ("missing_source", "Project manifest must contain exactly one source_audio artifact."),
        ("ambiguous_source", "Project manifest must contain exactly one source_audio artifact."),
        ("wrong_type", "Project manifest must contain exactly one source_audio artifact."),
        ("non_wav_format", "Project manifest source_audio artifact format must be 'wav'."),
        ("non_wav_relative_path", "Project manifest source_audio artifact relative_path must end with .wav."),
        ("unsafe_relative_path", "Sync manifest artifact relative path is invalid."),
        ("noncanonical_project_id", "Project manifest project_id must be derived from source_sha256."),
    ],
)
def test_missing_project_manifest_source_artifact_must_match_import_contract(
    db_session: Session,
    case: str,
    expected_reason: str,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha(f"{case} source")
    project_id = "proj_noncanonical" if case == "noncanonical_project_id" else source_hash_to_project_id(source_hash)
    manifest = _project_manifest(project_id, source_hash)
    if case == "missing_source":
        manifest["artifacts"] = []
    elif case == "ambiguous_source":
        manifest["artifacts"].append(
            _artifact_manifest(
                f"proj_{case}",
                f"art_source_extra_{case}",
                _sha(f"{case} extra"),
                64,
                artifact_type="source_audio",
            )
        )
    elif case == "wrong_type":
        manifest["artifacts"][0]["type"] = "source"
    elif case == "non_wav_format":
        manifest["artifacts"][0]["format"] = "mp3"
    elif case == "non_wav_relative_path":
        manifest["artifacts"][0]["relative_path"] = "source/input.mp3"
    elif case == "unsafe_relative_path":
        manifest["artifacts"][0]["relative_path"] = "../source/input.wav"

    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [manifest],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_PROJECT, project_id)
    assert item.status == "conflicted"
    assert item.action_type == ACTION_RECORD_CONFLICT
    assert item.reason == expected_reason
    status_action = _action(plan, ACTION_UPSERT_PROJECT_STATUS, ITEM_PROJECT, project_id)
    assert status_action is not None
    assert status_action.details["project_status"] == "conflicted"
    assert status_action.details["lock_reason"] == expected_reason
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is None
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_PROJECT, project_id) is not None


@pytest.mark.parametrize(
    ("case", "expected_reason"),
    [
        ("project_mismatch", "Artifact manifest belongs to a different project."),
        ("duplicate_id", "Project manifest contains duplicate artifact IDs."),
        ("duplicate_path", "Project manifest contains duplicate artifact relative paths."),
        ("unsafe_relative_path", "Sync manifest artifact relative path is invalid."),
        ("invalid_content_sha256", "Artifact manifest content_sha256 must be a full SHA-256 hex digest."),
        ("negative_size", "Artifact manifest size_bytes must be non-negative."),
        ("non_object_metadata", "Artifact manifest metadata must be an object."),
    ],
)
def test_missing_project_manifest_rejects_invalid_non_source_artifacts(
    db_session: Session,
    case: str,
    expected_reason: str,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha(f"{case} non-source source")
    stem_hash = _sha(f"{case} non-source stem")
    project_id = source_hash_to_project_id(source_hash)
    stem = _artifact_manifest(project_id, "art_invalid_non_source", stem_hash, 64)
    manifest = _project_manifest(project_id, source_hash, extra_artifacts=[stem])
    if case == "project_mismatch":
        stem["project_id"] = "proj_other"
    elif case == "duplicate_id":
        stem["artifact_id"] = f"art_source_{project_id}"
    elif case == "duplicate_path":
        stem["relative_path"] = manifest["artifacts"][0]["relative_path"]
    elif case == "unsafe_relative_path":
        stem["relative_path"] = "../stems/unsafe.wav"
    elif case == "invalid_content_sha256":
        stem["content_sha256"] = "not-a-sha"
    elif case == "negative_size":
        stem["size_bytes"] = -1
    elif case == "non_object_metadata":
        stem["metadata"] = []

    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [manifest],
        "peer_inventory": [
            {"device_id": "peer-a", "available_content_hashes": [source_hash, stem_hash]},
        ],
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_PROJECT, project_id)
    assert item.status == "conflicted"
    assert item.reason == expected_reason
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is None
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_invalid_non_source") is None


def test_missing_project_manifest_rejects_tombstoned_contained_targets(
    db_session: Session,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha("tombstoned contained target source")
    project_id = source_hash_to_project_id(source_hash)
    stale_manifest = _project_manifest(project_id, source_hash)
    tombstone_time = datetime.now(UTC) + timedelta(seconds=1)
    db_session.add(
        SyncDeleteTombstone(
            id="tomb_contained_artifact",
            sync_group_id="group-a",
            project_id=project_id,
            target_type=ITEM_ARTIFACT,
            target_id=f"art_source_{project_id}",
            author_device_id="dev-local",
            deleted_at=tombstone_time,
            prior_metadata_json={},
            created_at=tombstone_time,
            updated_at=tombstone_time,
        )
    )
    db_session.commit()

    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [stale_manifest],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_PROJECT, project_id)
    assert item.status == "conflicted"
    assert item.reason == "Project manifest contains live targets covered by sync delete tombstones."
    assert item.details == {"artifact_ids": [f"art_source_{project_id}"], "revision_ids": []}
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is None


def test_missing_project_manifest_rejects_local_artifact_and_revision_id_conflicts(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    existing_project = _add_project(db_session, "proj_existing_conflict", source_sha256=_sha("existing"))
    conflict_hash, conflict_size = _write_file(tmp_path / "conflict.wav", b"conflict artifact")
    _add_artifact(
        db_session,
        artifact_id="art_conflicting_id",
        project_id=existing_project.id,
        path=tmp_path / "conflict.wav",
        content_sha256=conflict_hash,
        size_bytes=conflict_size,
        artifact_type="source_audio",
    )
    _add_revision(
        db_session,
        project_id=existing_project.id,
        revision_id="rev_conflicting_id",
        content_sha256=_sha("existing revision"),
        base_revision_id=None,
    )
    db_session.commit()

    artifact_source_hash = _sha("artifact conflict source")
    artifact_project_id = source_hash_to_project_id(artifact_source_hash)
    artifact_conflict_manifest = _project_manifest(artifact_project_id, artifact_source_hash)
    artifact_conflict_manifest["artifacts"][0]["artifact_id"] = "art_conflicting_id"
    revision_source_hash = _sha("revision conflict source")
    revision_project_id = source_hash_to_project_id(revision_source_hash)
    revision_conflict_manifest = _project_manifest(
        revision_project_id,
        revision_source_hash,
        extra_revisions=[
            _revision_manifest(
                revision_project_id,
                revision_id="rev_conflicting_id",
                content_sha256=_revision_payload_sha("rev_conflicting_id"),
                base_revision_id=None,
            ),
        ],
    )
    request = {
        "remote_library": {
            "projects": [
                {"project_id": artifact_project_id, "source_sha256": artifact_source_hash},
                {"project_id": revision_project_id, "source_sha256": revision_source_hash},
            ],
        },
        "project_manifests": [artifact_conflict_manifest, revision_conflict_manifest],
        "peer_inventory": [
            {
                "device_id": "peer-a",
                "available_content_hashes": [artifact_source_hash, revision_source_hash],
            }
        ],
    }

    plan = plan_sync_reconciliation(db_session, request)

    artifact_item = _item(plan, ITEM_PROJECT, artifact_project_id)
    assert artifact_item.status == "conflicted"
    assert artifact_item.reason == "A synced artifact conflicts with an existing local artifact."
    assert artifact_item.details == {"artifact_ids": ["art_conflicting_id"]}
    revision_item = _item(plan, ITEM_PROJECT, revision_project_id)
    assert revision_item.status == "conflicted"
    assert revision_item.reason == "A synced entity revision conflicts with an existing local revision."
    assert revision_item.details == {"revision_ids": ["rev_conflicting_id"]}
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, artifact_project_id) is None
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, revision_project_id) is None


@pytest.mark.parametrize(
    ("case", "expected_reason"),
    [
        ("missing_base", "Entity revision base_revision_id does not exist in the manifest."),
        ("wrong_base_entity", "Entity revision base_revision_id must reference the same project entity."),
        ("missing_source_artifact", "Entity revision source_artifact_id does not exist in the manifest."),
        ("cycle", "Entity revision base_revision_id contains a cycle."),
    ],
)
def test_missing_project_manifest_rejects_invalid_embedded_entity_revisions(
    db_session: Session,
    case: str,
    expected_reason: str,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha(f"{case} revision source")
    project_id = source_hash_to_project_id(source_hash)
    if case == "missing_base":
        revisions = [
            _revision_manifest(
                project_id,
                revision_id="rev_missing_base",
                content_sha256=_revision_payload_sha("rev_missing_base"),
                base_revision_id="rev_does_not_exist",
            )
        ]
    elif case == "wrong_base_entity":
        revisions = [
            _revision_manifest(
                project_id,
                revision_id="rev_wrong_base",
                content_sha256=_revision_payload_sha("rev_wrong_base"),
                base_revision_id=None,
            ),
            {
                **_revision_manifest(
                    project_id,
                    revision_id="rev_wrong_child",
                    content_sha256=_revision_payload_sha("rev_wrong_child"),
                    base_revision_id="rev_wrong_base",
                ),
                "entity_id": "other_entity",
            },
        ]
    elif case == "missing_source_artifact":
        revisions = [
            {
                **_revision_manifest(
                    project_id,
                    revision_id="rev_missing_source_artifact",
                    content_sha256=_revision_payload_sha("rev_missing_source_artifact"),
                    base_revision_id=None,
                ),
                "source_artifact_id": "art_missing",
            }
        ]
    else:
        revisions = [
            _revision_manifest(
                project_id,
                revision_id="rev_cycle_a",
                content_sha256=_revision_payload_sha("rev_cycle_a"),
                base_revision_id="rev_cycle_b",
            ),
            _revision_manifest(
                project_id,
                revision_id="rev_cycle_b",
                content_sha256=_revision_payload_sha("rev_cycle_b"),
                base_revision_id="rev_cycle_a",
            ),
        ]
    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [
            _project_manifest(project_id, source_hash, extra_revisions=revisions),
        ],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_PROJECT, project_id)
    assert item.status == "conflicted"
    assert item.reason == expected_reason
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is None


@pytest.mark.parametrize(
    ("case", "expected_reason"),
    [
        ("unsafe_metadata", "Entity revision manifest metadata and payload must be sync-safe."),
        ("unsafe_payload", "Entity revision manifest metadata and payload must be sync-safe."),
    ],
)
def test_missing_project_manifest_rejects_invalid_revision_payload_contract(
    db_session: Session,
    case: str,
    expected_reason: str,
) -> None:
    _add_identity_and_peers(db_session)
    source_hash = _sha(f"{case} source")
    project_id = source_hash_to_project_id(source_hash)
    revision_id = f"rev_{case}"
    revision = _revision_manifest(
        project_id,
        revision_id=revision_id,
        content_sha256=_revision_payload_sha(revision_id),
        base_revision_id=None,
    )
    if case == "payload_hash_mismatch":
        revision["content_sha256"] = _sha("wrong revision payload")
    elif case == "unsafe_metadata":
        revision["metadata"] = {"local_path": "/tmp/private.wav"}
    elif case == "unsafe_payload":
        revision["payload"] = {"revision_id": revision_id, "absolute_path": "/tmp/private.wav"}

    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [
            _project_manifest(project_id, source_hash, extra_revisions=[revision]),
        ],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [source_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    item = _item(plan, ITEM_PROJECT, project_id)
    assert item.status == "conflicted"
    assert item.reason == expected_reason
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, project_id) is None


def test_repeated_planning_is_idempotent_and_does_not_write_identity_or_rows(
    db_session: Session,
) -> None:
    before_counts = _table_counts(db_session)
    request = {
        "remote_library": {
            "delete_tombstones": [
                _tombstone(
                    tombstone_id="tomb_without_identity",
                    project_id="proj_missing",
                    target_type=ITEM_PROJECT,
                    target_id="proj_missing",
                    author_device_id="peer-a",
                )
            ]
        }
    }

    first = plan_sync_reconciliation(db_session, request)
    second = plan_sync_reconciliation(db_session, request)

    assert asdict(first) == asdict(second)
    assert _item(first, ITEM_DELETE_TOMBSTONE, "tomb_without_identity").status == "noop"
    assert _table_counts(db_session) == before_counts
    assert db_session.scalar(select(func.count()).select_from(SyncLocalIdentity)) == 0
    assert list(db_session.new) == []
    assert list(db_session.dirty) == []
    assert list(db_session.deleted) == []


def _add_identity_and_peers(session: Session) -> None:
    now = datetime.now(UTC)
    session.add(
        SyncLocalIdentity(
            id="local",
            sync_group_id="group-a",
            device_id="dev-local",
            display_name="Local",
            public_key="pub-local",
            private_key="priv-local",
            created_at=now,
            updated_at=now,
        )
    )
    session.add_all(
        [
            SyncTrustedPeer(
                device_id="peer-b",
                sync_group_id="group-a",
                display_name="Peer B",
                public_key="pub-peer-b",
                endpoint_hints_json=[],
                trusted_at=now,
                revoked_at=None,
                created_at=now,
                updated_at=now,
            ),
            SyncTrustedPeer(
                device_id="peer-a",
                sync_group_id="group-a",
                display_name="Peer A",
                public_key="pub-peer-a",
                endpoint_hints_json=[],
                trusted_at=now,
                revoked_at=None,
                created_at=now,
                updated_at=now,
            ),
            SyncTrustedPeer(
                device_id="peer-revoked",
                sync_group_id="group-a",
                display_name="Peer Revoked",
                public_key="pub-peer-revoked",
                endpoint_hints_json=[],
                trusted_at=now,
                revoked_at=now,
                created_at=now,
                updated_at=now,
            ),
            SyncTrustedPeer(
                device_id="peer-other-group",
                sync_group_id="other-group",
                display_name="Peer Other",
                public_key="pub-peer-other",
                endpoint_hints_json=[],
                trusted_at=now,
                revoked_at=None,
                created_at=now,
                updated_at=now,
            ),
        ]
    )
    session.flush()


def _add_project(session: Session, project_id: str, *, source_sha256: str) -> Project:
    project = Project(
        id=project_id,
        display_name=project_id,
        source_sha256=source_sha256,
        source_path=f"/tmp/{project_id}.wav",
        imported_path=f"/tmp/{project_id}.wav",
    )
    session.add(project)
    session.flush()
    return project


def _add_artifact(
    session: Session,
    *,
    artifact_id: str,
    project_id: str,
    path: Path,
    content_sha256: str,
    size_bytes: int,
    artifact_type: str = "stem",
    artifact_format: str = "wav",
    can_regenerate: bool = False,
    metadata_json: dict[str, Any] | None = None,
    created_at: datetime | None = None,
) -> Artifact:
    artifact_kwargs: dict[str, Any] = {}
    if created_at is not None:
        artifact_kwargs["created_at"] = created_at
    artifact = Artifact(
        id=artifact_id,
        project_id=project_id,
        type=artifact_type,
        format=artifact_format,
        path=str(path),
        content_sha256=content_sha256,
        size_bytes=size_bytes,
        generated_by="test",
        can_delete=True,
        can_regenerate=can_regenerate,
        metadata_json=metadata_json or {},
        **artifact_kwargs,
    )
    session.add(artifact)
    session.flush()
    return artifact


def _seed_existing_project_with_source(
    session: Session,
    tmp_path: Path,
    *,
    filename: str,
) -> tuple[str, int, str]:
    _add_identity_and_peers(session)
    source_hash, source_size = _write_file(tmp_path / filename, b"source")
    project_id = source_hash_to_project_id(source_hash)
    _add_project(session, project_id, source_sha256=source_hash)
    _add_artifact(
        session,
        artifact_id=f"art_source_{project_id}",
        project_id=project_id,
        path=tmp_path / filename,
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
    )
    return source_hash, source_size, project_id


def _add_revision(
    session: Session,
    *,
    project_id: str,
    revision_id: str,
    content_sha256: str,
    base_revision_id: str | None,
    entity_id: str | None = None,
    source_artifact_id: str | None = None,
    entity_type: str = "chords",
    payload: dict[str, Any] | None = None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> SyncEntityRevision:
    now = datetime.now(UTC)
    payload_json = {"revision_id": revision_id} if payload is None else payload
    revision = SyncEntityRevision(
        id=revision_id,
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id or project_id,
        revision_type="manual",
        base_revision_id=base_revision_id,
        source_artifact_id=source_artifact_id,
        content_sha256=content_sha256,
        author_device_id="dev-local",
        state="current",
        metadata_json={},
        payload_json=payload_json,
        created_at=created_at or now,
        updated_at=updated_at or now,
    )
    session.add(revision)
    session.flush()
    return revision


def _seed_generated_analysis_divergence(
    session: Session,
    tmp_path: Path,
    *,
    local_analysis_hash: str,
    remote_analysis_hash: str,
    local_generated_at: datetime | None,
    remote_generated_at: datetime | None,
    local_can_regenerate: bool = True,
    remote_can_regenerate: bool = True,
    remote_source_hash: str | None = None,
) -> dict[str, Any]:
    _add_identity_and_peers(session)
    project_id = "proj_generated_analysis"
    source_artifact_id = "art_generated_source"
    stem_artifact_id = "art_generated_drums"
    analysis_artifact_id = "art_generated_analysis"
    source_hash = _sha("generated analysis source")
    source_size = 64
    stem_hash = _sha("generated analysis source stem")
    stem_size = 32
    source_path = tmp_path / "source.wav"
    stem_path = tmp_path / "drums.wav"
    analysis_path = tmp_path / "analysis.json"
    source_path.write_bytes(b"s" * source_size)
    stem_path.write_bytes(b"d" * stem_size)
    analysis_path.write_bytes(b"a" * 128)
    local_created_at = local_generated_at or datetime(2026, 1, 1, tzinfo=UTC)
    remote_created_at = remote_generated_at or datetime(2026, 1, 2, tzinfo=UTC)
    local_metadata = {"source_artifact_id": source_artifact_id}
    if local_generated_at is not None:
        local_metadata["analysis_generated_at"] = local_generated_at.isoformat()
    remote_metadata = {"source_artifact_id": source_artifact_id}
    if remote_generated_at is not None:
        remote_metadata["analysis_generated_at"] = remote_generated_at.isoformat()
    _add_project(session, project_id, source_sha256=source_hash)
    _add_artifact(
        session,
        artifact_id=source_artifact_id,
        project_id=project_id,
        path=source_path,
        content_sha256=source_hash,
        size_bytes=source_size,
        artifact_type="source_audio",
        can_regenerate=False,
    )
    _add_artifact(
        session,
        artifact_id=stem_artifact_id,
        project_id=project_id,
        path=stem_path,
        content_sha256=stem_hash,
        size_bytes=stem_size,
        artifact_type="drums_stem",
        can_regenerate=True,
        metadata_json={
            "source_artifact_id": source_artifact_id,
            "source_artifact_type": "source_audio",
        },
    )
    _add_artifact(
        session,
        artifact_id=analysis_artifact_id,
        project_id=project_id,
        path=analysis_path,
        content_sha256=local_analysis_hash,
        size_bytes=128,
        artifact_type="analysis_json",
        artifact_format="json",
        can_regenerate=local_can_regenerate,
        metadata_json=local_metadata,
        created_at=local_created_at,
    )
    session.commit()

    remote_source_hash = remote_source_hash or source_hash
    return {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
            "artifacts": [
                _artifact_manifest(
                    project_id,
                    source_artifact_id,
                    remote_source_hash,
                    source_size,
                    artifact_type="source_audio",
                    can_regenerate=False,
                    relative_path="source/source.wav",
                    created_at=remote_created_at,
                ),
                _artifact_manifest(
                    project_id,
                    stem_artifact_id,
                    stem_hash,
                    stem_size,
                    artifact_type="drums_stem",
                    can_regenerate=True,
                    metadata={
                        "source_artifact_id": source_artifact_id,
                        "source_artifact_type": "source_audio",
                    },
                    relative_path="stems/drums.wav",
                    created_at=remote_created_at,
                ),
                _artifact_manifest(
                    project_id,
                    analysis_artifact_id,
                    remote_analysis_hash,
                    128,
                    artifact_type="analysis_json",
                    artifact_format="json",
                    can_regenerate=remote_can_regenerate,
                    metadata=remote_metadata,
                    relative_path="analysis/analysis.json",
                    created_at=remote_created_at,
                ),
            ],
        },
        "peer_inventory": [
            {
                "device_id": "peer-a",
                "available_content_hashes": [remote_analysis_hash, remote_source_hash, stem_hash],
            }
        ],
    }


def _artifact_manifest(
    project_id: str,
    artifact_id: str,
    content_sha256: str,
    size_bytes: int,
    *,
    artifact_type: str = "stem",
    artifact_format: str = "wav",
    can_regenerate: bool = False,
    metadata: dict[str, Any] | None = None,
    relative_path: str | None = None,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    created = created_at or datetime.now(UTC)
    return {
        "artifact_id": artifact_id,
        "project_id": project_id,
        "type": artifact_type,
        "format": artifact_format,
        "relative_path": relative_path or f"stems/{artifact_id}.wav",
        "content_sha256": content_sha256,
        "size_bytes": size_bytes,
        "generated_by": "test",
        "can_delete": True,
        "can_regenerate": can_regenerate,
        "cache_key": None,
        "metadata": metadata or {},
        "created_at": created,
    }


def _project_manifest(
    project_id: str,
    source_sha256: str,
    *,
    source_size_bytes: int = 64,
    extra_artifacts: list[dict[str, Any]] | None = None,
    extra_revisions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    source_artifact_id = f"art_source_{project_id}"
    return {
        "schema_version": "1",
        "exported_at": now,
        "project": {
            "project_id": project_id,
            "display_name": project_id,
            "source_key_override": None,
            "source_sha256": source_sha256,
            "duration_seconds": None,
            "sample_rate": None,
            "channels": None,
            "created_at": now,
            "updated_at": now,
        },
        "artifacts": [
            _artifact_manifest(
                project_id,
                source_artifact_id,
                source_sha256,
                source_size_bytes,
                artifact_type="source_audio",
            )
        ]
        + (extra_artifacts or []),
        "entity_revisions": extra_revisions or [],
        "delete_tombstones": [],
    }


def _revision_manifest(
    project_id: str,
    *,
    revision_id: str,
    content_sha256: str,
    base_revision_id: str | None,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    created = created_at or now
    updated = updated_at or created
    return {
        "revision_id": revision_id,
        "project_id": project_id,
        "entity_type": "chords",
        "entity_id": project_id,
        "revision_type": "manual",
        "base_revision_id": base_revision_id,
        "author_device_id": "peer-a",
        "source_artifact_id": None,
        "content_sha256": content_sha256,
        "state": "current",
        "metadata": {},
        "payload": {"revision_id": revision_id},
        "created_at": created,
        "updated_at": updated,
    }


def _current_revision_manifest(
    project_id: str,
    *,
    revision_id: str,
    entity_type: str,
    payload: dict[str, Any],
    entity_id: str | None = None,
    base_revision_id: str | None = None,
    content_sha256: str | None = None,
    source_artifact_id: str | None = None,
    state: str = "current",
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    created = created_at or now
    updated = updated_at or created
    return {
        "revision_id": revision_id,
        "project_id": project_id,
        "entity_type": entity_type,
        "entity_id": entity_id or project_id,
        "revision_type": "generated",
        "base_revision_id": base_revision_id,
        "author_device_id": "peer-a",
        "source_artifact_id": source_artifact_id,
        "content_sha256": content_sha256 or revision_payload_sha256(payload),
        "state": state,
        "metadata": {},
        "payload": payload,
        "created_at": created,
        "updated_at": updated,
    }


def _tombstone(
    *,
    tombstone_id: str,
    project_id: str,
    target_type: str,
    target_id: str,
    author_device_id: str,
    sync_group_id: str = "group-a",
) -> dict[str, Any]:
    now = datetime.now(UTC)
    return {
        "tombstone_id": tombstone_id,
        "sync_group_id": sync_group_id,
        "project_id": project_id,
        "target_type": target_type,
        "target_id": target_id,
        "author_device_id": author_device_id,
        "deleted_at": now,
        "prior_metadata": {},
        "created_at": now,
        "updated_at": now,
    }


def _write_file(path: Path, contents: bytes) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return hashlib.sha256(contents).hexdigest(), len(contents)


def _fail_planner_file_sha256(path: Path) -> str:
    raise AssertionError(f"reconciliation planner must not hash local artifact bytes: {path}")


def _sha(seed: str) -> str:
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


def _revision_payload_sha(revision_id: str) -> str:
    return revision_payload_sha256({"revision_id": revision_id})


def _item(plan: SyncReconciliationPlan, item_type: str, item_id: str) -> SyncReconciliationItem:
    for item in plan.items:
        if item.item_type == item_type and item.item_id == item_id:
            return item
    raise AssertionError(f"Missing reconciliation item: {item_type}:{item_id}")


def _action(
    plan: SyncReconciliationPlan,
    action_type: str,
    item_type: str,
    item_id: str,
) -> SyncReconciliationAction | None:
    for action in plan.actions:
        if action.action_type == action_type and action.item_type == item_type and action.item_id == item_id:
            return action
    return None


def _table_counts(session: Session) -> dict[str, int]:
    models = (
        Artifact,
        Project,
        SyncDeleteTombstone,
        SyncEntityRevision,
        SyncLocalIdentity,
        SyncTrustedPeer,
    )
    return {
        model.__tablename__: int(session.scalar(select(func.count()).select_from(model)) or 0)
        for model in models
    }
