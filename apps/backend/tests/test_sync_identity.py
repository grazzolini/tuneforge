from __future__ import annotations

from pathlib import Path

import pytest

from app.db import SessionLocal
from app.models import Artifact, Project
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
    assert payload["total_projects"] == 1
    assert payload["ready_projects"] == 1
    assert payload["missing_source_hash_projects"] == 0
    assert payload["invalid_source_hash_projects"] == 0
    assert payload["duplicate_source_hash_projects"] == 0
    assert payload["noncanonical_project_id_projects"] == 0
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


def test_sync_preflight_resolves_missing_hash_from_source_path(client, sample_audio_file: Path) -> None:
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
    assert payload["ok"] is True
    assert payload["projects"][0]["status"] == "ready"
    assert payload["projects"][0]["source_sha256"] == expected_hash
    assert payload["projects"][0]["expected_project_id"] == source_hash_to_project_id(expected_hash)
    assert payload["projects"][0]["source_hash_source"] == "source_path"


def test_sync_preflight_prefers_imported_copy_over_changed_source_path(client, tmp_path: Path) -> None:
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
    assert project["status"] == "ready"
    assert project["source_sha256"] == expected_hash
    assert project["source_hash_source"] == "source_artifact_path"


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
    original_copy = sample_audio_file
    normalized_proxy = sample_audio_file.parent / "proxy.wav"
    normalized_proxy.write_bytes(b"normalized proxy bytes")
    with SessionLocal() as session:
        project = Project(
            id=source_hash_to_project_id(expected_hash),
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
