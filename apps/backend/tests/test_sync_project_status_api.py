from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.services.sync_identity import source_hash_to_project_id


def _create_project(tmp_path: Path, *, project_id: str) -> str:
    from app.db import SessionLocal
    from app.models import Project

    source_path = tmp_path / f"{project_id}.wav"
    source_path.write_bytes(b"sync status fixture")
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Sync Status Fixture",
                source_sha256="a" * 64,
                source_path=str(source_path),
                imported_path=str(source_path),
                duration_seconds=1.0,
                sample_rate=44100,
                channels=2,
            )
        )
        session.commit()
    return project_id


def test_project_schema_exposes_default_sync_status(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_id = _create_project(tmp_path, project_id="proj_sync_status_default")

    response = client.get(f"/api/v1/projects/{project_id}")

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["sync_status"] == "local"
    assert project["sync_status_reason"] is None
    assert project["sync_editable"] is True
    assert project["sync_required_artifact_ids"] == []
    assert project["sync_provider_device_ids"] == []
    assert project["sync_conflict_count"] == 0


def test_sync_project_status_update_persists_status_fields(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_id = _create_project(tmp_path, project_id="proj_sync_status_update")

    response = client.patch(
        f"/api/v1/sync/projects/{project_id}/status",
        json={
            "sync_status": "remote_available",
            "sync_status_reason": " Available from Studio Laptop ",
            "sync_required_artifact_ids": [" art_source ", "art_stems"],
            "sync_provider_device_ids": [" laptop-a "],
            "sync_conflict_count": 2,
        },
    )

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["sync_status"] == "remote_available"
    assert project["sync_status_reason"] == "Available from Studio Laptop"
    assert project["sync_editable"] is False
    assert project["sync_required_artifact_ids"] == ["art_source", "art_stems"]
    assert project["sync_provider_device_ids"] == ["laptop-a"]
    assert project["sync_conflict_count"] == 2
    assert project["created_at"].endswith("Z")
    assert project["updated_at"].endswith("Z")
    assert "+00:00" not in project["created_at"]
    assert "+00:00" not in project["updated_at"]

    detail_response = client.get(f"/api/v1/projects/{project_id}")
    assert detail_response.status_code == 200
    persisted_project = detail_response.json()["project"]
    assert persisted_project["sync_status"] == "remote_available"
    assert persisted_project["sync_editable"] is False
    assert persisted_project["sync_required_artifact_ids"] == ["art_source", "art_stems"]


def test_sync_project_status_update_rejects_unsupported_status(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_id = _create_project(tmp_path, project_id="proj_sync_status_invalid")

    response = client.patch(
        f"/api/v1/sync/projects/{project_id}/status",
        json={"sync_status": "paused"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_sync_project_status_update_creates_placeholder_from_project_metadata(
    client: TestClient,
) -> None:
    source_sha256 = "b" * 64
    project_id = source_hash_to_project_id(source_sha256)

    response = client.patch(
        f"/api/v1/sync/projects/{project_id}/status",
        json={
            "sync_status": "remote_available",
            "sync_status_reason": "Available from peer.",
            "sync_required_artifact_ids": ["art_source_audio"],
            "sync_provider_device_ids": ["peer-a"],
            "project": {
                "project_id": project_id,
                "display_name": "Remote Placeholder",
                "source_sha256": source_sha256,
                "duration_seconds": 12.5,
                "sample_rate": 44100,
                "channels": 2,
            },
        },
    )

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["id"] == project_id
    assert project["display_name"] == "Remote Placeholder"
    assert project["source_path"] == ""
    assert project["imported_path"] == ""
    assert project["sync_status"] == "remote_available"
    assert project["sync_editable"] is False
    assert project["sync_status_reason"] == "Available from peer."
    assert project["sync_required_artifact_ids"] == ["art_source_audio"]
    assert project["sync_provider_device_ids"] == ["peer-a"]


def test_sync_project_status_update_requires_metadata_for_missing_project(
    client: TestClient,
) -> None:
    response = client.patch(
        "/api/v1/sync/projects/proj_missing/status",
        json={"sync_status": "missing"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "SYNC_PROJECT_STATUS_MANIFEST_REQUIRED"
