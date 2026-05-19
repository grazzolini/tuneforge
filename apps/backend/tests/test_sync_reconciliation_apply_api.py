from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Artifact, Project, SyncDeleteTombstone, SyncEntityRevision, SyncTrustedPeer
from app.services.sync_identity import source_hash_to_project_id
from app.services.sync_revisions import revision_payload_sha256
from app.services.sync_staging import stage_sync_artifact
from app.services.sync_trust import get_or_create_local_identity


def test_reconciliation_apply_imports_staged_project_manifest(
    client: TestClient,
    sample_audio_file: Path,
) -> None:
    identity = _ensure_identity_and_peer("peer-apply-a")
    content_sha256 = hashlib.sha256(sample_audio_file.read_bytes()).hexdigest()
    project_id = source_hash_to_project_id(content_sha256)
    manifest = _project_manifest(project_id, content_sha256, sample_audio_file.stat().st_size)
    _stage_source_audio(sample_audio_file, content_sha256=content_sha256, provider_device_id="peer-apply-a")

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [_remote_project(project_id, content_sha256)],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [],
            },
            "project_manifests": [manifest],
            "peer_inventory": [
                {
                    "device_id": "peer-apply-a",
                    "available_content_sha256": [content_sha256],
                    "metadata": {"display_name": "Peer Apply"},
                }
            ],
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["summary"]["skipped_actions"] == 0
    assert payload["summary"]["applied_actions"] >= 2
    assert payload["summary"]["satisfied_actions"] >= 1

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        assert project.sync_status == "local"
        assert session.get(Artifact, f"art_source_{project_id}") is not None
        imported_revision = session.get(SyncEntityRevision, "rev_apply_chords")
        assert imported_revision is not None
        assert imported_revision.author_device_id == "peer-apply-a"
        assert session.get(SyncTrustedPeer, "peer-apply-a").sync_group_id == identity.sync_group_id


def test_reconciliation_apply_applies_trusted_delete_tombstone(
    client: TestClient,
    tmp_path: Path,
) -> None:
    identity = _ensure_identity_and_peer("peer-apply-delete")
    project_id = "proj_apply_tombstone"
    artifact_path = tmp_path / "deleted.wav"
    artifact_path.write_bytes(b"delete me")
    content_sha256 = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    _add_project_artifact(project_id, artifact_path, content_sha256)
    now = datetime.now(UTC).isoformat()

    response = client.post(
        "/api/v1/sync/reconciliation/apply",
        json={
            "remote_library": {
                "projects": [],
                "artifacts": [],
                "entity_revisions": [],
                "delete_tombstones": [
                    {
                        "tombstone_id": "tomb_apply_artifact",
                        "sync_group_id": identity.sync_group_id,
                        "project_id": project_id,
                        "target_type": "artifact",
                        "target_id": "art_apply_deleted",
                        "author_device_id": "peer-apply-delete",
                        "deleted_at": now,
                        "prior_metadata": {},
                        "created_at": now,
                        "updated_at": now,
                    }
                ],
            },
            "project_manifests": [],
            "peer_inventory": [],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["failed_actions"] == 0
    assert payload["summary"]["applied_actions"] == 1
    assert payload["results"][0]["action"]["action_type"] == "apply_delete_tombstone"

    with SessionLocal() as session:
        assert session.get(Artifact, "art_apply_deleted") is None
        assert session.get(Project, project_id) is not None
        tombstone = session.get(SyncDeleteTombstone, "tomb_apply_artifact")
        assert tombstone is not None
        assert tombstone.target_type == "artifact"
        assert tombstone.target_id == "art_apply_deleted"
        assert tombstone.author_device_id == "peer-apply-delete"
    assert not artifact_path.exists()


def _ensure_identity_and_peer(peer_device_id: str) -> Any:
    now = datetime.now(UTC)
    with SessionLocal() as session:
        identity = get_or_create_local_identity(session)
        session.add(
            SyncTrustedPeer(
                device_id=peer_device_id,
                sync_group_id=identity.sync_group_id,
                display_name=peer_device_id,
                public_key=f"pub-{peer_device_id}",
                endpoint_hints_json=[],
                trusted_at=now,
                revoked_at=None,
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
        return identity


def _stage_source_audio(
    source_path: Path,
    *,
    content_sha256: str,
    provider_device_id: str,
) -> None:
    with SessionLocal() as session:
        stage_sync_artifact(
            session,
            source_path=source_path,
            content_sha256=content_sha256,
            size_bytes=source_path.stat().st_size,
            provider_device_id=provider_device_id,
            metadata={"role": "source_audio"},
        )
        session.commit()


def _add_project_artifact(project_id: str, artifact_path: Path, content_sha256: str) -> None:
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Apply Tombstone",
                source_sha256="a" * 64,
                source_path=str(artifact_path),
                imported_path=str(artifact_path),
            )
        )
        session.add(
            Artifact(
                id="art_apply_deleted",
                project_id=project_id,
                type="stem",
                format="wav",
                path=str(artifact_path),
                content_sha256=content_sha256,
                size_bytes=artifact_path.stat().st_size,
                generated_by="test",
                can_delete=True,
                can_regenerate=False,
                metadata_json={},
            )
        )
        session.commit()


def _remote_project(project_id: str, source_sha256: str) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    return {
        "project_id": project_id,
        "display_name": "Applied Remote Project",
        "source_key_override": None,
        "source_sha256": source_sha256,
        "duration_seconds": None,
        "sample_rate": None,
        "channels": None,
        "created_at": now,
        "updated_at": now,
    }


def _project_manifest(project_id: str, source_sha256: str, size_bytes: int) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    revision_payload = {"timeline": []}
    return {
        "schema_version": "1",
        "exported_at": now,
        "project": _remote_project(project_id, source_sha256),
        "artifacts": [
            {
                "artifact_id": f"art_source_{project_id}",
                "project_id": project_id,
                "type": "source_audio",
                "format": "wav",
                "relative_path": "source/input.wav",
                "content_sha256": source_sha256,
                "size_bytes": size_bytes,
                "generated_by": "sync",
                "can_delete": False,
                "can_regenerate": False,
                "cache_key": None,
                "metadata": {},
                "created_at": now,
            }
        ],
        "entity_revisions": [
            {
                "revision_id": "rev_apply_chords",
                "project_id": project_id,
                "entity_type": "chords",
                "entity_id": project_id,
                "revision_type": "manual",
                "base_revision_id": None,
                "author_device_id": "peer-apply-a",
                "source_artifact_id": None,
                "content_sha256": revision_payload_sha256(revision_payload),
                "state": "current",
                "metadata": {},
                "payload": revision_payload,
                "created_at": now,
                "updated_at": now,
            }
        ],
        "delete_tombstones": [],
    }
