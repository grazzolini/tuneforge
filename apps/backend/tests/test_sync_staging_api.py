from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.api.routes import sync as sync_routes
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


def test_sync_project_import_api_accepts_legacy_staging_root_payload(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    from app.services import sync_manifest as sync_manifest_service

    content_sha256 = hashlib.sha256(b"legacy staging root").hexdigest()
    staging_root = tmp_path / "staging"
    captured: dict[str, Any] = {}

    def fake_import_staged_project_manifest(
        session: Any,
        *,
        manifest: dict[str, Any],
        staging_root: str,
        use_content_addressed_staging: bool | None = None,
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
        json={"manifest": _manifest_payload(content_sha256), "staging_root": str(staging_root)},
    )

    assert response.status_code == 200
    assert response.json()["project"]["id"] == "proj_sync_api_import"
    assert captured["manifest"]["project"]["source_sha256"] == content_sha256
    assert captured["staging_root"] == str(staging_root)
    assert captured["use_content_addressed_staging"] is False


def test_sync_project_import_api_allows_content_addressed_payload_without_staging_root(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: Any,
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
            "use_content_addressed_staging": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["project"]["id"] == project_id
    assert captured["manifest"]["project"]["source_sha256"] == content_sha256
    assert captured["staging_root"] is None
    assert captured["use_content_addressed_staging"] is True
