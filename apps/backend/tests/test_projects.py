from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.db import SessionLocal
from app.errors import AppError
from app.models import Artifact, Project
from app.services.analysis import analyze_project
from app.services.paths import project_root
from app.services.projects import import_project
from app.services.sync_identity import source_hash_to_project_id, source_hash_to_project_storage_key
from app.utils.hashing import file_sha256
from tests.conftest import wait_for_job


def test_import_project_persists_metadata_and_source_artifact(client, sample_audio_file: Path):
    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    )

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["display_name"] == "fixture"
    assert project["source_key_override"] is None
    assert project["sample_rate"] == 44100
    assert project["channels"] == 1

    expected_hash = file_sha256(sample_audio_file)
    assert expected_hash is not None
    assert project["id"] == source_hash_to_project_id(expected_hash)

    data_root = get_settings().data_root
    imported_path = Path(project["imported_path"])
    assert imported_path.exists()
    assert imported_path.suffix == ".wav"
    assert str(imported_path).startswith(
        str(data_root / "projects" / source_hash_to_project_storage_key(expected_hash))
    )

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    assert source_artifact["format"] == "wav"
    assert source_artifact["size_bytes"] > 0
    assert source_artifact["generated_by"] == "import"
    assert source_artifact["can_delete"] is False
    assert source_artifact["can_regenerate"] is False
    assert source_artifact["metadata"]["source_path"] == str(sample_audio_file.resolve())
    assert source_artifact["metadata"]["original_format"] == "wav"
    assert "original_copy_path" not in source_artifact["metadata"]
    assert "content_sha256" not in source_artifact
    assert "source_sha256" not in project

    with SessionLocal() as session:
        project_row = session.get(Project, project["id"])
        artifact_row = session.get(Artifact, source_artifact["id"])
        assert project_row is not None
        assert artifact_row is not None
        assert project_row.source_sha256 == expected_hash
        assert artifact_row.content_sha256 == file_sha256(imported_path)


def test_import_project_rejects_duplicate_source_hash(client, sample_audio_file: Path):
    source_hash = file_sha256(sample_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)
    with SessionLocal() as session:
        session.add(
            Project(
                id=project_id,
                display_name="Existing Song",
                source_sha256=source_hash,
                source_path=str(sample_audio_file),
                imported_path=str(sample_audio_file),
            )
        )
        session.commit()

    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    )

    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "DUPLICATE_PROJECT_SOURCE",
        "message": 'This project is already imported with name "Existing Song".',
        "details": {"project_id": project_id, "project_name": "Existing Song"},
    }


def test_import_project_without_copy_still_materializes_internal_wav(
    sample_mp3_file: Path,
) -> None:
    source_path = sample_mp3_file
    expected_hash = file_sha256(source_path)
    assert expected_hash is not None
    original_path = source_path.resolve()

    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=False,
            display_name=None,
        )
        session.commit()
        session.refresh(project)

        imported_path = Path(project.imported_path)
        assert project.source_sha256 == expected_hash
        assert project.source_path == str(original_path)
        assert imported_path.exists()
        assert imported_path.suffix == ".wav"
        assert imported_path.is_relative_to(project_root(project.id))
        assert imported_path != original_path
        assert not (imported_path.parent / source_path.name).exists()

        source_artifact = next(artifact for artifact in project.artifacts if artifact.type == "source_audio")
        assert Path(source_artifact.path) == imported_path
        assert source_artifact.format == "wav"
        assert source_artifact.metadata_json["source_path"] == str(original_path)
        assert source_artifact.metadata_json["original_format"] == "mp3"
        assert "original_copy_path" not in source_artifact.metadata_json
        assert source_artifact.content_sha256 == file_sha256(imported_path)
        assert source_artifact.content_sha256 != expected_hash

        source_path.unlink()
        analysis = analyze_project(session, project)

        assert analysis.project_id == project.id
        assert imported_path.exists()


def test_import_project_with_deprecated_external_reference_still_rejects_duplicate_source_hash(
    sample_audio_file: Path,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "deprecated-original.wav"
    source_path.write_bytes(sample_audio_file.read_bytes() + b"deprecated-duplicate")
    duplicate_source = tmp_path / "same-audio-different-path.wav"
    duplicate_source.write_bytes(source_path.read_bytes())

    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=False,
            display_name="Original",
        )
        session.commit()

    with SessionLocal() as session:
        with pytest.raises(AppError) as exc:
            import_project(
                session,
                source_path=str(duplicate_source),
                copy_into_project=False,
                display_name="Duplicate",
            )

    assert exc.value.code == "DUPLICATE_PROJECT_SOURCE"
    assert exc.value.details == {"project_id": project.id, "project_name": "Original"}


def test_import_project_translates_duplicate_project_id_race(
    monkeypatch: pytest.MonkeyPatch,
    sample_audio_file: Path,
) -> None:
    race_audio_file = sample_audio_file.with_name("race-fixture.wav")
    race_audio_file.write_bytes(sample_audio_file.read_bytes() + b"race")
    source_hash = file_sha256(race_audio_file)
    assert source_hash is not None
    project_id = source_hash_to_project_id(source_hash)

    with SessionLocal() as session:
        def raise_duplicate_project_id(*args, **kwargs):
            raise IntegrityError("INSERT INTO projects", {}, Exception("duplicate project id"))

        monkeypatch.setattr(session, "flush", raise_duplicate_project_id)

        with pytest.raises(AppError) as exc:
            import_project(
                session,
                source_path=str(race_audio_file),
                copy_into_project=True,
                display_name=None,
            )

    assert exc.value.code == "DUPLICATE_PROJECT_SOURCE"
    assert exc.value.status_code == 409
    assert exc.value.message == 'This project is already imported with name "race-fixture".'
    assert exc.value.details == {"project_id": project_id, "project_name": "race-fixture"}
    assert not project_root(project_id).exists()


def test_import_project_enqueues_analysis_and_chords(client, sample_chord_audio_file: Path):
    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    )

    assert response.status_code == 200
    project = response.json()["project"]

    jobs = client.get("/api/v1/jobs").json()["jobs"]
    analyze_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "analyze")
    chord_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "chords")

    assert wait_for_job(client, analyze_job["id"])["status"] == "completed"
    completed_chord_job = wait_for_job(client, chord_job["id"])
    assert completed_chord_job["status"] == "completed"
    assert completed_chord_job["chord_backend"] == "tuneforge-fast"
    assert completed_chord_job["chord_source"] == "source"

    analysis = client.get(f"/api/v1/projects/{project['id']}/analysis").json()["analysis"]
    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()

    assert analysis is not None
    assert len(chords["timeline"]) >= 3


def test_project_can_be_renamed(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"display_name": "Practice Version"},
    )

    assert response.status_code == 200
    assert response.json()["project"]["display_name"] == "Practice Version"


def test_project_source_key_override_can_be_updated_and_cleared(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    update_response = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"source_key_override": "8:major"},
    )

    assert update_response.status_code == 200
    assert update_response.json()["project"]["source_key_override"] == "8:major"

    cleared_response = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"source_key_override": None},
    )

    assert cleared_response.status_code == 200
    assert cleared_response.json()["project"]["source_key_override"] is None


def test_project_list_can_filter_by_search_term(
    client,
    sample_audio_file: Path,
    sample_stereo_audio_file: Path,
):
    client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_audio_file),
            "copy_into_project": True,
            "display_name": "Choir Warmup",
        },
    )
    client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_stereo_audio_file),
            "copy_into_project": True,
            "display_name": "Bass Drill",
        },
    )

    response = client.get("/api/v1/projects", params={"search": "choir"})

    assert response.status_code == 200
    projects = response.json()["projects"]
    assert len(projects) == 1
    assert projects[0]["display_name"] == "Choir Warmup"


def test_retune_request_rejects_invalid_payload(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.post(
        f"/api/v1/projects/{project['id']}/retune",
        json={"target_reference_hz": 440.0, "target_cents_offset": 12.0},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize(
    ("fixture_name", "original_format"),
    [
        ("sample_audio_file", "wav"),
        ("sample_mp3_file", "mp3"),
        ("sample_flac_file", "flac"),
        ("sample_m4a_file", "m4a"),
        ("sample_aac_file", "aac"),
        ("sample_ogg_file", "ogg"),
        ("sample_mp4_file", "mp4"),
        ("sample_webm_file", "webm"),
    ],
)
def test_supported_imports_are_normalized_to_internal_wav(
    client,
    request,
    fixture_name: str,
    original_format: str,
):
    source_path = request.getfixturevalue(fixture_name)
    source_hash = file_sha256(source_path)
    assert source_hash is not None

    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(source_path), "copy_into_project": True},
    )

    assert response.status_code == 200
    project = response.json()["project"]
    imported_path = Path(project["imported_path"])
    assert imported_path.exists()
    assert imported_path.name == f"{source_path.stem}.wav"
    assert project["id"] == source_hash_to_project_id(source_hash)

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    assert source_artifact["format"] == "wav"
    assert source_artifact["metadata"]["source_path"] == str(source_path.resolve())
    assert source_artifact["metadata"]["original_format"] == original_format
    assert "original_copy_path" not in source_artifact["metadata"]
    if original_format != "wav":
        assert not (imported_path.parent / source_path.name).exists()

    with SessionLocal() as session:
        project_row = session.get(Project, project["id"])
        artifact_row = session.get(Artifact, source_artifact["id"])
        assert project_row is not None
        assert artifact_row is not None
        assert project_row.source_sha256 == source_hash
        assert artifact_row.content_sha256 == file_sha256(imported_path)
        if original_format != "wav":
            assert artifact_row.content_sha256 != source_hash
