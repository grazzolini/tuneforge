from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.routes import sync as sync_routes
from app.db import SessionLocal
from app.models import Project
from app.services.sync_revisions import revision_payload_sha256


def test_sync_reconciliation_plan_api_returns_service_plan(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content_sha256 = "a" * 64
    captured: dict[str, Any] = {}

    def fake_plan_sync_reconciliation(session: Any, payload: Any) -> dict[str, Any]:
        captured["session"] = session
        captured["payload"] = payload
        return {
            "summary": {
                "total_items": 2,
                "total_actions": 2,
                "total_conflicts": 1,
                "status_counts": {
                    "remote_available": 1,
                    "conflicted": 1,
                },
            },
            "items": [
                {
                    "item_type": "project",
                    "item_id": "proj_remote",
                    "project_id": "proj_remote",
                    "status": "remote_available",
                    "action_type": "import_project_manifest",
                    "content_sha256": content_sha256,
                    "chosen_provider_device_id": "device-peer",
                    "reason": "Remote project is not present locally.",
                    "details": {"manifest_index": 0},
                },
                {
                    "item_type": "entity_revision",
                    "item_id": "rev_conflict",
                    "project_id": "proj_remote",
                    "status": "conflicted",
                    "action_type": "record_conflict",
                    "content_sha256": "b" * 64,
                    "chosen_provider_device_id": None,
                    "reason": "Both peers edited the same entity.",
                    "details": {"local_revision_id": "rev_local"},
                },
            ],
            "actions": [
                {
                    "action_type": "import_project_manifest",
                    "item_type": "project",
                    "item_id": "proj_remote",
                    "project_id": "proj_remote",
                    "content_sha256": content_sha256,
                    "provider_device_id": "device-peer",
                    "reason": "Import the remote project manifest.",
                    "priority": 10,
                    "details": {"manifest_index": 0},
                },
                {
                    "action_type": "record_conflict",
                    "item_type": "entity_revision",
                    "item_id": "rev_conflict",
                    "project_id": "proj_remote",
                    "content_sha256": "b" * 64,
                    "provider_device_id": None,
                    "reason": "Surface a user-resolvable conflict.",
                    "priority": 20,
                    "details": {"local_revision_id": "rev_local"},
                },
            ],
        }

    monkeypatch.setattr(sync_routes, "plan_sync_reconciliation", fake_plan_sync_reconciliation)

    response = client.post(
        "/api/v1/sync/reconciliation/plan",
        json={
            "remote_library": _metadata_payload(content_sha256),
            "project_manifests": [_project_manifest_payload(content_sha256)],
            "peer_inventory": [
                {
                    "device_id": "device-peer",
                    "available_content_sha256": [content_sha256],
                    "metadata": {"display_name": "Studio Laptop"},
                }
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"] == {
        "total_items": 2,
        "total_actions": 2,
        "total_conflicts": 1,
        "status_counts": {
            "remote_available": 1,
            "conflicted": 1,
        },
    }
    assert payload["items"][0] == {
        "item_type": "project",
        "item_id": "proj_remote",
        "project_id": "proj_remote",
        "status": "remote_available",
        "action_type": "import_project_manifest",
        "content_sha256": content_sha256,
        "chosen_provider_device_id": "device-peer",
        "reason": "Remote project is not present locally.",
        "details": {"manifest_index": 0},
    }
    assert payload["actions"][0] == {
        "action_type": "import_project_manifest",
        "item_type": "project",
        "item_id": "proj_remote",
        "project_id": "proj_remote",
        "content_sha256": content_sha256,
        "provider_device_id": "device-peer",
        "reason": "Import the remote project manifest.",
        "priority": 10,
        "details": {"manifest_index": 0},
    }

    captured_payload = captured["payload"]
    assert captured["session"] is not None
    assert captured_payload.remote_library.projects[0].project_id == "proj_remote"
    assert captured_payload.remote_library.delete_tombstones == []
    assert captured_payload.project_manifests[0].project.project_id == "proj_remote"
    assert captured_payload.peer_inventory[0].device_id == "device-peer"
    assert captured_payload.peer_inventory[0].available_content_sha256 == [content_sha256]
    assert captured_payload.peer_inventory[0].metadata == {"display_name": "Studio Laptop"}


def test_sync_reconciliation_plan_request_defaults_project_manifests_and_peer_metadata(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_plan_sync_reconciliation(session: Any, payload: Any) -> dict[str, Any]:
        captured["payload"] = payload
        return _empty_plan()

    monkeypatch.setattr(sync_routes, "plan_sync_reconciliation", fake_plan_sync_reconciliation)

    response = client.post(
        "/api/v1/sync/reconciliation/plan",
        json={
            "remote_library": {
                "projects": [],
                "artifacts": [],
            },
            "peer_inventory": [
                {
                    "device_id": "device-empty",
                    "available_content_sha256": [],
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == _empty_plan()
    captured_payload = captured["payload"]
    assert captured_payload.remote_library.delete_tombstones == []
    assert captured_payload.project_manifests == []
    assert captured_payload.peer_inventory[0].metadata == {}


def test_sync_reconciliation_plan_requires_peer_inventory_content_list(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/v1/sync/reconciliation/plan",
        json={
            "remote_library": {
                "projects": [],
                "artifacts": [],
            },
            "peer_inventory": [
                {
                    "device_id": "device-missing-content-list",
                }
            ],
        },
    )

    assert response.status_code == 422


def test_sync_reconciliation_plan_api_accepts_library_entity_revisions(
    client: TestClient,
) -> None:
    with SessionLocal() as session:
        session.add(
            Project(
                id="proj_api",
                display_name="API Project",
                source_sha256="d" * 64,
                source_path="/tmp/proj_api.wav",
                imported_path="/tmp/proj_api.wav",
            )
        )
        session.commit()

    response = client.post(
        "/api/v1/sync/reconciliation/plan",
        json={
            "remote_library": {
                "projects": [],
                "artifacts": [],
                "entity_revisions": [_revision_payload("rev_api_remote")],
            },
            "peer_inventory": [],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["items"] == [
        {
            "item_type": "entity_revision",
            "item_id": "rev_api_remote",
            "project_id": "proj_api",
            "status": "remote_available",
            "action_type": "import_entity_revision",
            "content_sha256": revision_payload_sha256({"timeline": []}),
            "chosen_provider_device_id": None,
            "reason": "Remote entity revision can be imported.",
            "details": {"base_revision_id": None},
        }
    ]
    assert payload["actions"][0]["action_type"] == "import_entity_revision"
    assert payload["actions"][0]["item_id"] == "rev_api_remote"


def _empty_plan() -> dict[str, Any]:
    return {
        "summary": {
            "total_items": 0,
            "total_actions": 0,
            "total_conflicts": 0,
            "status_counts": {},
        },
        "items": [],
        "actions": [],
    }


def _revision_payload(revision_id: str) -> dict[str, Any]:
    timestamp = _timestamp()
    return {
        "revision_id": revision_id,
        "project_id": "proj_api",
        "entity_type": "chords",
        "entity_id": "proj_api",
        "revision_type": "manual",
        "base_revision_id": None,
        "author_device_id": "device-peer",
        "source_artifact_id": None,
        "content_sha256": revision_payload_sha256({"timeline": []}),
        "state": "active",
        "metadata": {},
        "payload": {"timeline": []},
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def _metadata_payload(content_sha256: str) -> dict[str, Any]:
    timestamp = _timestamp()
    return {
        "projects": [
            {
                "project_id": "proj_remote",
                "display_name": "Remote Project",
                "source_key_override": None,
                "source_sha256": content_sha256,
                "duration_seconds": 1.0,
                "sample_rate": 44100,
                "channels": 2,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        ],
        "artifacts": [
            {
                "artifact_id": "art_source",
                "project_id": "proj_remote",
                "type": "source",
                "format": "wav",
                "relative_path": "source/input.wav",
                "content_sha256": content_sha256,
                "size_bytes": 12,
                "generated_by": "import",
                "can_delete": False,
                "can_regenerate": False,
                "cache_key": None,
                "metadata": {},
                "created_at": timestamp,
            }
        ],
    }


def _project_manifest_payload(content_sha256: str) -> dict[str, Any]:
    timestamp = _timestamp()
    return {
        "schema_version": "1",
        "exported_at": timestamp,
        "project": {
            "project_id": "proj_remote",
            "display_name": "Remote Project",
            "source_key_override": None,
            "source_sha256": content_sha256,
            "duration_seconds": 1.0,
            "sample_rate": 44100,
            "channels": 2,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
        "artifacts": [
            {
                "artifact_id": "art_source",
                "project_id": "proj_remote",
                "type": "source",
                "format": "wav",
                "relative_path": "source/input.wav",
                "content_sha256": content_sha256,
                "size_bytes": 12,
                "generated_by": "import",
                "can_delete": False,
                "can_regenerate": False,
                "cache_key": None,
                "metadata": {},
                "created_at": timestamp,
            }
        ],
    }


def _timestamp() -> str:
    return datetime(2026, 5, 18, 12, 0, tzinfo=UTC).isoformat()
