from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.routes import sync as sync_routes
from app.db import SessionLocal
from app.models import Project


@dataclass(frozen=True)
class StagedArtifactFixture:
    content_sha256: str
    size_bytes: int
    relative_path: str
    provider_device_id: str | None
    metadata: dict[str, Any]
    verified_at: datetime
    created_at: datetime
    updated_at: datetime
    resolved_path: str


def _staged_artifact(
    *,
    content_sha256: str,
    size_bytes: int,
    relative_path: str = "sync-artifacts/ab/cd/artifact.bin",
    provider_device_id: str | None = "device-local",
    metadata: dict[str, Any] | None = None,
    resolved_path: Path | None = None,
) -> StagedArtifactFixture:
    timestamp = datetime(2026, 5, 15, 12, 0, tzinfo=UTC)
    return StagedArtifactFixture(
        content_sha256=content_sha256,
        size_bytes=size_bytes,
        relative_path=relative_path,
        provider_device_id=provider_device_id,
        metadata=metadata or {},
        verified_at=timestamp,
        created_at=timestamp,
        updated_at=timestamp,
        resolved_path=str(resolved_path or Path("/tmp/tuneforge-private/artifact.bin")),
    )


def _manifest_payload(content_sha256: str, *, project_id: str = "proj_sync_api_import") -> dict[str, Any]:
    timestamp = datetime(2026, 5, 15, 12, 0, tzinfo=UTC).isoformat()
    return {
        "schema_version": "1",
        "exported_at": timestamp,
        "project": {
            "project_id": project_id,
            "display_name": "Staged API Import",
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
                "project_id": project_id,
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


def test_stage_sync_artifact_api_returns_record_without_absolute_path(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"staged artifact")
    content_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
    captured: dict[str, Any] = {}

    def fake_stage_sync_artifact(
        session: Any,
        *,
        source_path: str,
        content_sha256: str,
        size_bytes: int,
        provider_device_id: str | None,
        metadata: dict[str, Any],
    ) -> StagedArtifactFixture:
        captured.update(
            {
                "source_path": source_path,
                "content_sha256": content_sha256,
                "size_bytes": size_bytes,
                "provider_device_id": provider_device_id,
                "metadata": metadata,
            }
        )
        return _staged_artifact(
            content_sha256=content_sha256,
            size_bytes=size_bytes,
            provider_device_id=provider_device_id,
            metadata=metadata,
            resolved_path=tmp_path / "data" / "sync-artifacts" / content_sha256,
        )

    monkeypatch.setattr(sync_routes, "_stage_sync_artifact", fake_stage_sync_artifact)

    response = client.post(
        "/api/v1/sync/artifacts/staging",
        json={
            "source_path": str(source_path),
            "content_sha256": content_sha256,
            "size_bytes": source_path.stat().st_size,
            "provider_device_id": "device-a",
            "metadata": {"role": "source"},
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {
        "content_sha256",
        "size_bytes",
        "relative_path",
        "provider_device_id",
        "metadata",
        "verified_at",
        "created_at",
        "updated_at",
    }
    assert payload["content_sha256"] == content_sha256
    assert payload["size_bytes"] == source_path.stat().st_size
    assert payload["provider_device_id"] == "device-a"
    assert payload["metadata"] == {"role": "source"}
    assert payload["relative_path"] == "sync-artifacts/ab/cd/artifact.bin"
    assert payload["verified_at"].endswith("Z")
    assert payload["created_at"].endswith("Z")
    assert payload["updated_at"].endswith("Z")
    assert "+00:00" not in payload["verified_at"]
    assert "+00:00" not in payload["created_at"]
    assert "+00:00" not in payload["updated_at"]
    assert str(source_path) not in json.dumps(payload)
    assert str(tmp_path) not in json.dumps(payload)
    assert "resolved_path" not in payload
    assert captured == {
        "source_path": str(source_path),
        "content_sha256": content_sha256,
        "size_bytes": source_path.stat().st_size,
        "provider_device_id": "device-a",
        "metadata": {"role": "source"},
    }


def test_get_sync_staged_artifact_api_returns_staged_metadata(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    content_sha256 = hashlib.sha256(b"existing staged artifact").hexdigest()
    captured: dict[str, Any] = {}

    def fake_require_staged_artifact(
        session: Any,
        *,
        content_sha256: str,
    ) -> StagedArtifactFixture:
        captured["content_sha256"] = content_sha256
        return _staged_artifact(
            content_sha256=content_sha256,
            size_bytes=24,
            provider_device_id="device-b",
            metadata={"format": "wav", "verified_by": "api-test"},
            resolved_path=tmp_path / "hidden" / content_sha256,
        )

    monkeypatch.setattr(sync_routes, "_require_staged_artifact", fake_require_staged_artifact)

    response = client.get(f"/api/v1/sync/artifacts/staging/{content_sha256}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["content_sha256"] == content_sha256
    assert payload["size_bytes"] == 24
    assert payload["provider_device_id"] == "device-b"
    assert payload["metadata"] == {"format": "wav", "verified_by": "api-test"}
    assert str(tmp_path) not in json.dumps(payload)
    assert "resolved_path" not in payload
    assert captured == {"content_sha256": content_sha256}


@pytest.mark.parametrize("endpoint", ["projects/import", "reconciliation/apply"])
@pytest.mark.parametrize("existing_project", [False, True], ids=["fresh", "merge"])
@pytest.mark.parametrize("staging_override", ["root", "relative", "root_and_relative", "null_mode"])
def test_sync_http_import_rejects_untrusted_staging_before_service_execution(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
    existing_project: bool,
    staging_override: str,
) -> None:
    from app.services import sync_manifest as sync_manifest_service

    outside_root = tmp_path / "outside-staging"
    outside_root.mkdir()
    sentinel = outside_root / "sentinel.bin"
    sentinel.write_bytes(b"outside sentinel")
    content_sha256 = hashlib.sha256(b"outside sentinel").hexdigest()
    manifest = _manifest_payload(content_sha256)
    if existing_project:
        with SessionLocal() as session:
            session.add(Project(
                id=manifest["project"]["project_id"],
                display_name="Existing project",
                source_sha256=content_sha256,
                source_path=str(sentinel),
                imported_path=str(sentinel),
                duration_seconds=1.0,
                sample_rate=44100,
                channels=2,
            ))
            session.commit()

    def unexpected_service_call(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("Invalid HTTP staging reached service/filesystem execution")

    monkeypatch.setattr(
        sync_manifest_service,
        "import_staged_project_manifest",
        unexpected_service_call,
    )
    monkeypatch.setattr(sync_routes, "apply_sync_reconciliation", unexpected_service_call)
    if endpoint == "projects/import":
        request_payload: dict[str, Any] = {"manifest": manifest}
    else:
        request_payload = {
            "remote_library": {"projects": [], "artifacts": []},
            "project_manifests": [manifest],
            "peer_inventory": [],
        }
    if staging_override in {"root", "root_and_relative"}:
        request_payload["staging_root"] = str(outside_root)
    if staging_override in {"relative", "root_and_relative"}:
        request_payload["use_content_addressed_staging"] = False
    if staging_override == "null_mode":
        request_payload["use_content_addressed_staging"] = None

    response = client.post(f"/api/v1/sync/{endpoint}", json=request_payload)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    error_fields = {error["loc"][-1] for error in response.json()["error"]["details"]["errors"]}
    assert error_fields <= {"staging_root", "use_content_addressed_staging"}
    assert error_fields
    assert sentinel.read_bytes() == b"outside sentinel"
    assert list(outside_root.iterdir()) == [sentinel]
    with SessionLocal() as session:
        project = session.get(Project, manifest["project"]["project_id"])
        if existing_project:
            assert project is not None
            assert project.display_name == "Existing project"
        else:
            assert project is None


@pytest.mark.parametrize("staging_fields", [{}, {"staging_root": None, "use_content_addressed_staging": True}])
def test_sync_project_import_api_allows_content_addressed_payload_without_staging_root(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
    staging_fields: dict[str, Any],
) -> None:
    from app.services import sync_manifest as sync_manifest_service

    content_sha256 = hashlib.sha256(b"content addressed staging").hexdigest()
    project_id = f"proj_sha256_{content_sha256}"
    captured: dict[str, Any] = {}

    def fake_import_staged_project_manifest(
        session: Any,
        *,
        manifest: dict[str, Any],
        staging_root: str | None,
        use_content_addressed_staging: bool,
    ) -> Project:
        captured.update(
            {
                "manifest": manifest,
                "staging_root": staging_root,
                "use_content_addressed_staging": use_content_addressed_staging,
            }
        )
        project = Project(
            id=manifest["project"]["project_id"],
            display_name=manifest["project"]["display_name"],
            source_key_override=manifest["project"]["source_key_override"],
            source_sha256=manifest["project"]["source_sha256"],
            source_path=str(tmp_path / "imported.wav"),
            imported_path=str(tmp_path / "imported.wav"),
            duration_seconds=manifest["project"]["duration_seconds"],
            sample_rate=manifest["project"]["sample_rate"],
            channels=manifest["project"]["channels"],
        )
        session.add(project)
        session.flush()
        return project

    monkeypatch.setattr(
        sync_manifest_service,
        "import_staged_project_manifest",
        fake_import_staged_project_manifest,
    )

    response = client.post(
        "/api/v1/sync/projects/import",
        json={
            "manifest": _manifest_payload(content_sha256, project_id=project_id),
            **staging_fields,
        },
    )

    assert response.status_code == 200
    assert response.json()["project"]["id"] == project_id
    assert captured["manifest"]["project"]["source_sha256"] == content_sha256
    assert captured["staging_root"] is None
    assert captured["use_content_addressed_staging"] is True
