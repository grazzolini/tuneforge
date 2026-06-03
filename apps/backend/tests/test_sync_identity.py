from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.db import SessionLocal
from app.models import Artifact, Job, Project, SyncDeleteTombstone
from app.services.paths import project_root
from app.services.sync_identity import (
    project_id_to_storage_key,
    source_hash_to_project_id,
    source_hash_to_project_storage_key,
)
from app.utils.hashing import file_sha256


def test_source_hash_to_project_id_normalizes_full_sha256() -> None:
    source_hash = "A" * 64

    assert source_hash_to_project_id(source_hash) == f"proj_sha256_{source_hash.lower()}"
    assert source_hash_to_project_storage_key(source_hash) == f"proj_{source_hash.lower()[:24]}"


@pytest.mark.parametrize("source_hash", ["", "abc", "g" * 64, "a" * 63, "a" * 65])
def test_source_hash_to_project_id_rejects_invalid_hashes(source_hash: str) -> None:
    with pytest.raises(ValueError, match="full SHA-256"):
        source_hash_to_project_id(source_hash)


def test_project_id_to_storage_key_maps_canonical_ids_and_preserves_legacy_ids() -> None:
    source_hash = "b" * 64

    assert project_id_to_storage_key(f"proj_sha256_{source_hash}") == f"proj_{source_hash[:24]}"
    assert project_id_to_storage_key("proj_legacy") == "proj_legacy"


def test_sync_preflight_reports_ready_projects(client, sample_audio_file: Path) -> None:
    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    project_id = source_hash_to_project_id(expected_hash)
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="fixture",
                source_sha256=expected_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["library_ok"] is True
    assert payload["total_projects"] == 1
    assert payload["ready_projects"] == 1
    assert payload["missing_source_hash_projects"] == 0
    assert payload["invalid_source_hash_projects"] == 0
    assert payload["duplicate_source_hash_projects"] == 0
    assert payload["noncanonical_project_id_projects"] == 0
    assert payload["job_state"] == {
        "state": "ready",
        "running_job_count": 0,
        "pending_job_count": 0,
        "blocking_job_count": 0,
        "blocking_job_counts": {"pending": 0, "running": 0},
        "blocking_jobs": [],
        "blocking_jobs_truncated": False,
        "guidance": [],
    }
    assert payload["manual_cleanup_required"] is False
    assert payload["projects"] == [
        {
            "project_id": project_id,
            "display_name": "fixture",
            "status": "ready",
            "source_sha256": expected_hash,
            "expected_project_id": source_hash_to_project_id(expected_hash),
            "expected_storage_key": source_hash_to_project_storage_key(expected_hash),
            "source_hash_source": "database",
            "reason": None,
        }
    ]


def test_sync_preflight_uses_stored_source_hash_before_original_copy(client, tmp_path: Path) -> None:
    original_copy = tmp_path / "copy.wav"
    original_copy.write_bytes(b"copy bytes")
    stored_hash = "a" * 64
    project_id = source_hash_to_project_id(stored_hash)
    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Stored",
            source_sha256=stored_hash,
            source_path=str(tmp_path / "source.wav"),
            imported_path=str(tmp_path / "imported.wav"),
        )
        session.add(project)
        session.add(
            Artifact(
                id="art_stored_source",
                project_id=project.id,
                type="source_audio",
                format="wav",
                path=str(tmp_path / "proxy.wav"),
                metadata_json={"original_copy_path": str(original_copy)},
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["projects"][0]["source_sha256"] == stored_hash
    assert payload["projects"][0]["source_hash_source"] == "database"


def test_sync_preflight_blocks_pending_jobs_without_payload_leakage(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
) -> None:
    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    project_id = source_hash_to_project_id(expected_hash)
    updated_at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    secret_path = tmp_path / "secret-source.wav"
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Pending Fixture",
                source_sha256=expected_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.add(
            Job(
                id="job_pending_preflight",
                project_id=project_id,
                type="analyze",
                status="pending",
                progress=12,
                payload_json={
                    "source_path": str(secret_path),
                    "audio_data": "raw-audio-bytes",
                    "endpoint": "https://peer.example/sync",
                },
                created_at=updated_at,
                updated_at=updated_at,
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    assert str(tmp_path) not in response.text
    assert "raw-audio-bytes" not in response.text
    assert "peer.example" not in response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["library_ok"] is True
    assert payload["manual_cleanup_required"] is False
    assert payload["job_state"]["state"] == "busy"
    assert payload["job_state"]["pending_job_count"] == 1
    assert payload["job_state"]["running_job_count"] == 0
    assert payload["job_state"]["blocking_job_count"] == 1
    assert payload["job_state"]["blocking_job_counts"] == {"pending": 1, "running": 0}
    assert payload["job_state"]["blocking_jobs_truncated"] is False
    assert payload["job_state"]["guidance"] == [
        "Backend jobs are running. Sync can start, but backend work may delay sync endpoint responses."
    ]
    assert payload["job_state"]["blocking_jobs"] == [
        {
            "id": "job_pending_preflight",
            "project_id": project_id,
            "project_name": "Pending Fixture",
            "type": "analyze",
            "status": "pending",
            "progress": 12,
            "started_at": None,
            "updated_at": "2026-01-02T03:04:05",
        }
    ]


def test_sync_preflight_blocks_running_jobs(client, sample_audio_file: Path) -> None:
    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    project_id = source_hash_to_project_id(expected_hash)
    started_at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    updated_at = datetime(2026, 1, 2, 3, 5, 6, tzinfo=UTC)
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Running Fixture",
                source_sha256=expected_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.add(
            Job(
                id="job_running_preflight",
                project_id=project_id,
                type="stems",
                status="running",
                progress=50,
                payload_json={},
                created_at=started_at,
                started_at=started_at,
                updated_at=updated_at,
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["library_ok"] is True
    assert payload["job_state"]["state"] == "busy"
    assert payload["job_state"]["pending_job_count"] == 0
    assert payload["job_state"]["running_job_count"] == 1
    assert payload["job_state"]["blocking_job_count"] == 1
    assert payload["job_state"]["blocking_jobs"][0] == {
        "id": "job_running_preflight",
        "project_id": project_id,
        "project_name": "Running Fixture",
        "type": "stems",
        "status": "running",
        "progress": 50,
        "started_at": "2026-01-02T03:04:05",
        "updated_at": "2026-01-02T03:05:06",
    }


def test_sync_preflight_reports_pending_and_running_jobs_without_payload_leakage(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
) -> None:
    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    project_id = source_hash_to_project_id(expected_hash)
    started_at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    updated_at = datetime(2026, 1, 2, 3, 5, 6, tzinfo=UTC)
    pending_secret_path = tmp_path / "pending-secret.wav"
    running_secret_path = tmp_path / "running-secret.wav"
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Busy Fixture",
                source_sha256=expected_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.add_all(
            [
                Job(
                    id="job_pending_resume_preflight",
                    project_id=project_id,
                    type="analyze",
                    status="pending",
                    progress=10,
                    payload_json={
                        "source_path": str(pending_secret_path),
                        "token": "pending-secret-token",
                    },
                    created_at=started_at,
                    updated_at=updated_at,
                ),
                Job(
                    id="job_running_resume_preflight",
                    project_id=project_id,
                    type="stems",
                    status="running",
                    progress=55,
                    payload_json={
                        "render_path": str(running_secret_path),
                        "endpoint": "https://peer.example/sync",
                    },
                    created_at=started_at,
                    started_at=started_at,
                    updated_at=updated_at,
                ),
            ]
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    assert str(pending_secret_path) not in response.text
    assert str(running_secret_path) not in response.text
    assert "pending-secret-token" not in response.text
    assert "peer.example" not in response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["library_ok"] is True
    assert payload["manual_cleanup_required"] is False
    job_state = payload["job_state"]
    assert job_state["state"] == "busy"
    assert job_state["pending_job_count"] == 1
    assert job_state["running_job_count"] == 1
    assert job_state["blocking_job_count"] == 2
    assert job_state["blocking_job_counts"] == {"pending": 1, "running": 1}
    assert job_state["blocking_jobs_truncated"] is False
    assert job_state["guidance"] == [
        "Backend jobs are running. Sync can start, but backend work may delay sync endpoint responses."
    ]
    jobs_by_id = {job["id"]: job for job in job_state["blocking_jobs"]}
    assert set(jobs_by_id) == {"job_pending_resume_preflight", "job_running_resume_preflight"}
    assert jobs_by_id["job_pending_resume_preflight"]["status"] == "pending"
    assert jobs_by_id["job_running_resume_preflight"]["status"] == "running"
    assert all("payload" not in job and "payload_json" not in job for job in jobs_by_id.values())


def test_sync_preflight_caps_and_truncates_blocking_jobs(client) -> None:
    created_at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    with SessionLocal() as session:
        session.add_all(
            [
                Job(
                    id=f"job_cap_{index:02d}",
                    project_id=None,
                    type="export",
                    status="pending",
                    progress=index,
                    payload_json={"path": f"/tmp/private-{index}.wav"},
                    created_at=created_at,
                    updated_at=created_at,
                )
                for index in range(25)
            ]
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["library_ok"] is True
    assert payload["job_state"]["pending_job_count"] == 25
    assert payload["job_state"]["running_job_count"] == 0
    assert payload["job_state"]["blocking_job_count"] == 25
    assert payload["job_state"]["blocking_job_counts"] == {"pending": 25, "running": 0}
    assert len(payload["job_state"]["blocking_jobs"]) == 20
    assert payload["job_state"]["blocking_jobs_truncated"] is True
    assert {job["id"] for job in payload["job_state"]["blocking_jobs"]} == {
        f"job_cap_{index:02d}" for index in range(20)
    }
    assert "/tmp/private" not in response.text


def test_sync_metadata_exposes_sync_safe_project_and_artifact_metadata(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
) -> None:
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)
    root = project_root(project_id)
    project_artifact_path = root / "stems" / "vocals.wav"
    analysis_artifact_path = root / "analysis" / "analysis.json"
    external_artifact_path = tmp_path / "external.wav"
    project_artifact_path.parent.mkdir(parents=True, exist_ok=True)
    analysis_artifact_path.parent.mkdir(parents=True, exist_ok=True)
    project_artifact_path.write_bytes(b"project artifact")
    analysis_artifact_path.write_text(json.dumps({"project_id": project_id}), encoding="utf-8")
    external_artifact_path.write_bytes(b"external artifact")
    project_artifact_hash = file_sha256(project_artifact_path)
    analysis_artifact_hash = file_sha256(analysis_artifact_path)
    external_artifact_hash = file_sha256(external_artifact_path)
    assert project_artifact_hash is not None
    assert analysis_artifact_hash is not None
    assert external_artifact_hash is not None

    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Sync Fixture",
            source_key_override="8:major",
            source_sha256=source_hash,
            source_path=str(sample_audio_file),
            imported_path=str(sample_audio_file),
            duration_seconds=2.0,
            sample_rate=44100,
            channels=1,
        )
        session.add(project)
        session.flush()
        session.add_all(
            [
                Artifact(
                    id="art_project_safe",
                    project_id=project.id,
                    type="vocals",
                    format="wav",
                    path=str(project_artifact_path),
                    content_sha256=project_artifact_hash,
                    size_bytes=project_artifact_path.stat().st_size,
                    generated_by="stems",
                    can_delete=True,
                    can_regenerate=True,
                    cache_key="stem-cache-key",
                    metadata_json={
                        "source_path": str(sample_audio_file),
                        "stem_model": "htdemucs_6s",
                        "source_artifact_id": "art_source",
                        "retune": {
                            "target_cents_offset": 12.0,
                            "path": str(tmp_path / "retune.wav"),
                            "render_path": str(tmp_path / "render.wav"),
                        },
                        "nested": {
                            "playback_path": str(tmp_path / "playback.wav"),
                            "transpose": {"semitones": 2},
                        },
                        "items": [
                            {
                                "imported_path": str(tmp_path / "imported.wav"),
                                "stem_model": "htdemucs_6s",
                            },
                            {"source_artifact_id": "art_source"},
                        ],
                    },
                ),
                Artifact(
                    id="art_analysis_json",
                    project_id=project.id,
                    type="analysis_json",
                    format="json",
                    path=str(analysis_artifact_path),
                    content_sha256=analysis_artifact_hash,
                    size_bytes=analysis_artifact_path.stat().st_size,
                    generated_by="analysis",
                    can_delete=True,
                    can_regenerate=True,
                    metadata_json={
                        "analysis_generated_at": "2026-01-02T03:04:05+00:00",
                        "analysis_backend": "built-in",
                        "analysis_version": "v3",
                        "source_artifact_id": "art_source",
                        "source_artifact_sha256": source_hash,
                        "source_stem_artifact_ids": ["art_project_safe"],
                        "source_stem_content_sha256s": [project_artifact_hash],
                        "source_path": str(sample_audio_file),
                    },
                ),
                Artifact(
                    id="art_external",
                    project_id=project.id,
                    type="external_reference",
                    format="wav",
                    path=str(external_artifact_path),
                    content_sha256=external_artifact_hash,
                    size_bytes=external_artifact_path.stat().st_size,
                    generated_by="test",
                    can_delete=False,
                    can_regenerate=False,
                    metadata_json={
                        "original_copy_path": str(tmp_path / "copy.wav"),
                        "transpose": {"semitones": -1},
                    },
                ),
            ]
        )
        session.commit()

    response = client.get("/api/v1/sync/metadata")

    assert response.status_code == 200
    assert str(tmp_path) not in response.text
    payload = response.json()
    assert len(payload["projects"]) == 1
    project_payload = payload["projects"][0]
    assert project_payload["project_id"] == project_id
    assert project_payload["display_name"] == "Sync Fixture"
    assert project_payload["source_key_override"] == "8:major"
    assert project_payload["source_sha256"] == source_hash
    assert project_payload["duration_seconds"] == 2.0
    assert project_payload["sample_rate"] == 44100
    assert project_payload["channels"] == 1
    assert "source_path" not in project_payload
    assert "imported_path" not in project_payload

    artifacts = {artifact["artifact_id"]: artifact for artifact in payload["artifacts"]}
    assert set(artifacts) == {"art_project_safe", "art_analysis_json", "art_external"}
    safe_artifact = artifacts["art_project_safe"]
    assert safe_artifact["project_id"] == project_id
    assert safe_artifact["type"] == "vocals"
    assert safe_artifact["format"] == "wav"
    assert safe_artifact["relative_path"] == "stems/vocals.wav"
    assert safe_artifact["content_sha256"] == project_artifact_hash
    assert safe_artifact["size_bytes"] == project_artifact_path.stat().st_size
    assert safe_artifact["generated_by"] == "stems"
    assert safe_artifact["can_delete"] is True
    assert safe_artifact["can_regenerate"] is True
    assert safe_artifact["cache_key"] == "stem-cache-key"
    assert safe_artifact["metadata"] == {
        "stem_model": "htdemucs_6s",
        "source_artifact_id": "art_source",
        "retune": {"target_cents_offset": 12.0},
        "nested": {"transpose": {"semitones": 2}},
        "items": [{"stem_model": "htdemucs_6s"}, {"source_artifact_id": "art_source"}],
    }
    assert "path" not in safe_artifact
    assert "result_artifact_ids_json" not in safe_artifact

    analysis_artifact = artifacts["art_analysis_json"]
    assert analysis_artifact["relative_path"] == "analysis/analysis.json"
    assert analysis_artifact["content_sha256"] == analysis_artifact_hash
    assert analysis_artifact["metadata"] == {
        "analysis_generated_at": "2026-01-02T03:04:05+00:00",
        "analysis_backend": "built-in",
        "analysis_version": "v3",
        "source_artifact_id": "art_source",
        "source_artifact_sha256": source_hash,
        "source_stem_artifact_ids": ["art_project_safe"],
        "source_stem_content_sha256s": [project_artifact_hash],
    }

    external_artifact = artifacts["art_external"]
    assert external_artifact["relative_path"] is None
    assert external_artifact["metadata"] == {"transpose": {"semitones": -1}}


def test_sync_metadata_omits_deleted_projects_but_keeps_tombstones(
    client,
    sample_audio_file: Path,
) -> None:
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)

    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Deleted Sync Fixture",
            source_sha256=source_hash,
            source_path=str(sample_audio_file),
            imported_path=str(sample_audio_file),
            sync_status="deleted",
        )
        session.add(project)
        session.add(
            SyncDeleteTombstone(
                id="tomb_deleted_sync_project",
                sync_group_id="group-a",
                project_id=project_id,
                target_type="project",
                target_id=project_id,
                author_device_id="peer-a",
                deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
                prior_metadata_json={"display_name": "Deleted Sync Fixture"},
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/metadata")

    assert response.status_code == 200
    payload = response.json()
    assert payload["projects"] == []
    assert payload["artifacts"] == []
    assert [tombstone["tombstone_id"] for tombstone in payload["delete_tombstones"]] == [
        "tomb_deleted_sync_project"
    ]


def test_sync_metadata_omits_tombstones_superseded_by_live_targets(
    client,
    sample_audio_file: Path,
) -> None:
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)
    deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    live_at = datetime(2026, 1, 2, tzinfo=UTC)

    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Reimported Sync Fixture",
            source_sha256=source_hash,
            source_path=str(sample_audio_file),
            imported_path=str(sample_audio_file),
            created_at=live_at,
            updated_at=live_at,
        )
        session.add(project)
        session.add(
            Artifact(
                id="art_live_source",
                project_id=project_id,
                type="source_audio",
                format="wav",
                path=str(sample_audio_file),
                content_sha256=source_hash,
                size_bytes=sample_audio_file.stat().st_size,
                generated_by="import",
                can_delete=False,
                can_regenerate=False,
                created_at=live_at,
            )
        )
        session.add_all(
            [
                SyncDeleteTombstone(
                    id="tomb_superseded_project",
                    sync_group_id="group-a",
                    project_id=project_id,
                    target_type="project",
                    target_id=project_id,
                    author_device_id="peer-a",
                    deleted_at=deleted_at,
                    prior_metadata_json={"display_name": "Deleted Sync Fixture"},
                ),
                SyncDeleteTombstone(
                    id="tomb_superseded_artifact",
                    sync_group_id="group-a",
                    project_id=project_id,
                    target_type="artifact",
                    target_id="art_live_source",
                    author_device_id="peer-a",
                    deleted_at=deleted_at,
                    prior_metadata_json={"type": "source_audio"},
                ),
                SyncDeleteTombstone(
                    id="tomb_deleted_artifact",
                    sync_group_id="group-a",
                    project_id=project_id,
                    target_type="artifact",
                    target_id="art_deleted",
                    author_device_id="peer-a",
                    deleted_at=deleted_at,
                    prior_metadata_json={"type": "preview_mix"},
                ),
            ]
        )
        session.commit()

    response = client.get("/api/v1/sync/metadata")

    assert response.status_code == 200
    payload = response.json()
    assert [tombstone["tombstone_id"] for tombstone in payload["delete_tombstones"]] == [
        "tomb_deleted_artifact"
    ]


def test_sync_preflight_does_not_recover_missing_hash_from_source_path(
    client,
    sample_audio_file: Path,
) -> None:
    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    with SessionLocal() as session:
        project = Project(
            id=source_hash_to_project_id(expected_hash),
            display_name="Readable",
            source_sha256=None,
            source_path=str(sample_audio_file),
            imported_path=str(sample_audio_file.parent / "missing-imported.wav"),
        )
        session.add(project)
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["missing_source_hash_projects"] == 1
    assert payload["projects"][0]["status"] == "missing_source_hash"
    assert payload["projects"][0]["source_sha256"] is None
    assert payload["projects"][0]["expected_project_id"] is None
    assert payload["projects"][0]["source_hash_source"] is None


def test_sync_preflight_does_not_recover_missing_hash_from_runtime_artifacts(
    client,
    tmp_path: Path,
) -> None:
    external_source = tmp_path / "external.wav"
    imported_copy = tmp_path / "project-source.wav"
    external_source.write_bytes(b"changed external bytes")
    imported_copy.write_bytes(b"original imported bytes")
    expected_hash = file_sha256(imported_copy)
    assert expected_hash is not None
    assert file_sha256(external_source) != expected_hash

    with SessionLocal() as session:
        project = Project(
            id=source_hash_to_project_id(expected_hash),
            display_name="Copied",
            source_sha256=None,
            source_path=str(external_source),
            imported_path=str(imported_copy),
        )
        session.add(project)
        session.add(
            Artifact(
                id="art_copied",
                project_id=project.id,
                type="source_audio",
                format="wav",
                path=str(imported_copy),
                metadata_json={"source_path": str(external_source)},
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    project = response.json()["projects"][0]
    assert project["status"] == "missing_source_hash"
    assert project["source_sha256"] is None
    assert project["source_hash_source"] is None


def test_sync_preflight_reports_missing_source_hash(client, tmp_path: Path) -> None:
    missing_path = tmp_path / "missing.wav"
    with SessionLocal() as session:
        project = Project(
            id="proj_missing",
            display_name="Missing",
            source_sha256=None,
            source_path=str(missing_path),
            imported_path=str(missing_path),
        )
        session.add(project)
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["missing_source_hash_projects"] == 1
    assert payload["manual_cleanup_required"] is True
    assert payload["manual_cleanup_guidance"] == [
        "Restore the original source file or re-import affected projects so TuneForge can compute source hashes."
    ]
    assert payload["projects"][0]["status"] == "missing_source_hash"
    assert payload["projects"][0]["expected_project_id"] is None
    assert payload["projects"][0]["reason"] == "No readable original-byte source copy is available for this project."


def test_sync_preflight_reports_invalid_source_hash(client, sample_audio_file: Path) -> None:
    with SessionLocal() as session:
        project = Project(
            id="proj_invalid",
            display_name="Invalid",
            source_sha256="not-a-hash",
            source_path=str(sample_audio_file),
            imported_path=str(sample_audio_file),
        )
        session.add(project)
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["invalid_source_hash_projects"] == 1
    assert payload["projects"][0]["status"] == "invalid_source_hash"
    assert payload["projects"][0]["source_hash_source"] == "database"


def test_sync_preflight_reports_duplicate_source_hashes(client, sample_audio_file: Path) -> None:
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    with SessionLocal() as session:
        session.add_all(
            [
                Project(
                    id="proj_dup_1",
                    display_name="First",
                    source_sha256=source_hash,
                    source_path=str(sample_audio_file),
                    imported_path=str(sample_audio_file),
                ),
                Project(
                    id="proj_dup_2",
                    display_name="Second",
                    source_sha256=source_hash,
                    source_path=str(sample_audio_file),
                    imported_path=str(sample_audio_file),
                ),
            ]
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["duplicate_source_hash_projects"] == 2
    assert [project["status"] for project in payload["projects"]] == [
        "duplicate_source_hash",
        "duplicate_source_hash",
    ]
    assert payload["duplicate_groups"] == [
        {
            "source_sha256": source_hash,
            "expected_project_id": source_hash_to_project_id(source_hash),
            "projects": [
                {"project_id": "proj_dup_1", "display_name": "First"},
                {"project_id": "proj_dup_2", "display_name": "Second"},
            ],
        }
    ]
    assert payload["manual_cleanup_guidance"] == [
        "Delete duplicate same-source projects or keep one canonical project before enabling sync."
    ]


def test_sync_preflight_reports_noncanonical_project_id(client, sample_audio_file: Path) -> None:
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    with SessionLocal() as session:
        session.add(
            Project(
                id="proj_legacy",
                display_name="Legacy",
                source_sha256=source_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["noncanonical_project_id_projects"] == 1
    assert payload["projects"][0]["status"] == "noncanonical_project_id"
    assert payload["projects"][0]["expected_project_id"] == source_hash_to_project_id(source_hash)
    assert payload["manual_cleanup_guidance"] == [
        "Re-import or migrate affected projects so project IDs use canonical source hashes."
    ]


def test_sync_preflight_uses_original_copy_before_normalized_proxy(client, sample_audio_file: Path) -> None:
    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    project_id = source_hash_to_project_id(expected_hash)
    root = project_root(project_id)
    original_copy = root / "source" / "original.webm"
    original_copy.parent.mkdir(parents=True, exist_ok=True)
    original_copy.write_bytes(sample_audio_file.read_bytes())
    normalized_proxy = root / "source" / "proxy.wav"
    normalized_proxy.write_bytes(b"normalized proxy bytes")
    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Normalized",
            source_sha256=None,
            source_path=str(sample_audio_file.parent / "missing.webm"),
            imported_path=str(normalized_proxy),
        )
        session.add(project)
        session.add(
            Artifact(
                id="art_normalized",
                project_id=project.id,
                type="source_audio",
                format="wav",
                path=str(normalized_proxy),
                metadata_json={
                    "original_format": "webm",
                    "original_copy_path": str(original_copy),
                },
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    project = response.json()["projects"][0]
    assert project["status"] == "ready"
    assert project["source_sha256"] == expected_hash
    assert project["source_hash_source"] == "original_copy_path"


def test_sync_preflight_ignores_external_original_copy_path(client, tmp_path: Path) -> None:
    external_copy = tmp_path / "external-copy.wav"
    external_copy.write_bytes(b"external original bytes")
    external_hash = file_sha256(external_copy)
    assert external_hash is not None
    project_id = source_hash_to_project_id(external_hash)
    runtime_path = project_root(project_id) / "source" / "runtime.wav"
    runtime_path.parent.mkdir(parents=True, exist_ok=True)
    runtime_path.write_bytes(b"runtime bytes")

    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="External Copy",
            source_sha256=None,
            source_path=str(tmp_path / "missing.wav"),
            imported_path=str(runtime_path),
        )
        session.add(project)
        session.add(
            Artifact(
                id="art_external_copy",
                project_id=project.id,
                type="source_audio",
                format="wav",
                path=str(runtime_path),
                metadata_json={"original_copy_path": str(external_copy)},
            )
        )
        session.commit()

    response = client.get("/api/v1/sync/preflight")

    assert response.status_code == 200
    project = response.json()["projects"][0]
    assert project["status"] == "missing_source_hash"
    assert project["source_sha256"] is None
    assert project["source_hash_source"] is None
