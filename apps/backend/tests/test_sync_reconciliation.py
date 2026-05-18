from __future__ import annotations

import hashlib
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.models import (
    Artifact,
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
    ITEM_ARTIFACT,
    ITEM_DELETE_TOMBSTONE,
    ITEM_ENTITY_REVISION,
    ITEM_PROJECT,
    SyncReconciliationAction,
    SyncReconciliationItem,
    SyncReconciliationPlan,
    plan_sync_reconciliation,
)
from app.services.sync_revisions import revision_payload_sha256


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


def test_artifact_classification_uses_verified_bytes_and_trusted_provider_choice(
    db_session: Session,
    tmp_path: Path,
) -> None:
    _add_identity_and_peers(db_session)
    project = _add_project(db_session, "proj_local", source_sha256=_sha("source"))
    identical_hash, identical_size = _write_file(tmp_path / "identical.wav", b"same bytes")
    local_conflict_hash, _ = _write_file(tmp_path / "conflict.wav", b"local conflict")
    missing_local_hash = _sha("missing local")
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
        artifact_id="art_missing_local_bytes",
        project_id=project.id,
        path=tmp_path / "missing.wav",
        content_sha256=missing_local_hash,
        size_bytes=32,
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
                _artifact_manifest(project.id, "art_missing_local_bytes", missing_local_hash, 32),
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
                "available_content_hashes": [missing_local_hash, remote_hash],
            },
            {
                "device_id": "peer-a",
                "available_content_hashes": [missing_local_hash, remote_hash],
            },
            {"device_id": "peer-revoked", "available_content_hashes": [untrusted_hash]},
            {"device_id": "peer-untrusted", "available_content_hashes": [untrusted_hash]},
        ],
    }

    plan = plan_sync_reconciliation(db_session, request)

    assert _item(plan, ITEM_PROJECT, project.id).status == "noop"
    assert _item(plan, ITEM_ARTIFACT, "art_identical").status == "identical_content"
    missing_local = _item(plan, ITEM_ARTIFACT, "art_missing_local_bytes")
    assert missing_local.status == "missing_local_bytes"
    assert missing_local.chosen_provider_device_id == "peer-a"
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
    assert fetch_actions["art_missing_local_bytes"].provider_device_id == "peer-a"
    assert fetch_actions["art_remote_available"].provider_device_id == "peer-a"
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ARTIFACT, "art_conflict") is not None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_duplicate_content") is not None


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
        "project_manifests": [
            _project_manifest("proj_deleted_remote", deleted_project_source),
        ],
        "peer_inventory": [{"device_id": "peer-a", "available_content_hashes": [import_hash]}],
    }

    plan = plan_sync_reconciliation(db_session, request)

    assert _item(plan, ITEM_ARTIFACT, "art_deleted").status == "deleted"
    assert _item(plan, ITEM_PROJECT, "proj_deleted_remote").status == "deleted"
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_wrong_group").status == "noop"
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_wrong_group").action_type == ACTION_NOOP
    assert _item(plan, ITEM_DELETE_TOMBSTONE, "tomb_revoked").status == "noop"
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, "proj_deleted_remote") is None
    assert all(
        action.action_type == ACTION_APPLY_DELETE_TOMBSTONE
        for action in plan.actions[:2]
    )
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_wrong_group") is None
    assert _action(plan, ACTION_APPLY_DELETE_TOMBSTONE, ITEM_ARTIFACT, "art_revoked") is None


def test_entity_revision_ancestry_imports_descendants_and_conflicts_siblings(
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
    assert sibling.status == "conflicted"
    assert sibling.action_type == ACTION_RECORD_CONFLICT
    import_revision_action_ids = [
        action.item_id
        for action in plan.actions
        if action.action_type == ACTION_IMPORT_ENTITY_REVISION
    ]
    assert import_revision_action_ids.index("rev_z_remote_descendant") < import_revision_action_ids.index(
        "rev_a_remote_grandchild"
    )
    assert _action(plan, ACTION_RECORD_CONFLICT, ITEM_ENTITY_REVISION, "rev_remote_sibling") is not None


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
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, duplicate_project_id) is not None
    assert (
        _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, f"art_source_{remote_provider_project_id}")
        is not None
    )
    assert _action(plan, ACTION_IMPORT_PROJECT_MANIFEST, ITEM_PROJECT, remote_provider_project_id) is not None
    assert _action(plan, ACTION_FETCH_ARTIFACT_CONTENT, ITEM_ARTIFACT, "art_no_manifest") is None
    assert _action(plan, ACTION_IMPORT_ARTIFACT_MANIFEST, ITEM_ARTIFACT, "art_no_manifest") is None


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
    db_session.add(
        SyncDeleteTombstone(
            id="tomb_contained_artifact",
            sync_group_id="group-a",
            project_id=project_id,
            target_type=ITEM_ARTIFACT,
            target_id=f"art_source_{project_id}",
            author_device_id="dev-local",
            deleted_at=datetime.now(UTC),
            prior_metadata_json={},
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
    )
    db_session.commit()

    request = {
        "remote_library": {
            "projects": [{"project_id": project_id, "source_sha256": source_hash}],
        },
        "project_manifests": [_project_manifest(project_id, source_hash)],
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
        ("payload_hash_mismatch", "Entity revision manifest content_sha256 must match payload."),
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
) -> Artifact:
    artifact = Artifact(
        id=artifact_id,
        project_id=project_id,
        type=artifact_type,
        format="wav",
        path=str(path),
        content_sha256=content_sha256,
        size_bytes=size_bytes,
        generated_by="test",
        can_delete=True,
        can_regenerate=False,
        metadata_json={},
    )
    session.add(artifact)
    session.flush()
    return artifact


def _add_revision(
    session: Session,
    *,
    project_id: str,
    revision_id: str,
    content_sha256: str,
    base_revision_id: str | None,
    entity_id: str | None = None,
    source_artifact_id: str | None = None,
) -> SyncEntityRevision:
    now = datetime.now(UTC)
    revision = SyncEntityRevision(
        id=revision_id,
        project_id=project_id,
        entity_type="chords",
        entity_id=entity_id or project_id,
        revision_type="manual",
        base_revision_id=base_revision_id,
        source_artifact_id=source_artifact_id,
        content_sha256=content_sha256,
        author_device_id="dev-local",
        state="current",
        metadata_json={},
        payload_json={"revision_id": revision_id},
        created_at=now,
        updated_at=now,
    )
    session.add(revision)
    session.flush()
    return revision


def _artifact_manifest(
    project_id: str,
    artifact_id: str,
    content_sha256: str,
    size_bytes: int,
    *,
    artifact_type: str = "stem",
) -> dict[str, Any]:
    return {
        "artifact_id": artifact_id,
        "project_id": project_id,
        "type": artifact_type,
        "format": "wav",
        "relative_path": f"stems/{artifact_id}.wav",
        "content_sha256": content_sha256,
        "size_bytes": size_bytes,
        "generated_by": "test",
        "can_delete": True,
        "can_regenerate": False,
        "cache_key": None,
        "metadata": {},
        "created_at": datetime.now(UTC),
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
) -> dict[str, Any]:
    now = datetime.now(UTC)
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
        "created_at": now,
        "updated_at": now,
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
