from __future__ import annotations

from pathlib import Path

import pytest

from app.config import get_settings
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

    data_root = get_settings().data_root
    imported_path = Path(project["imported_path"])
    assert imported_path.exists()
    assert str(imported_path).startswith(str(data_root / "projects"))

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    assert source_artifact["size_bytes"] > 0
    assert source_artifact["generated_by"] == "import"
    assert source_artifact["can_delete"] is False
    assert source_artifact["can_regenerate"] is False


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


def test_project_list_can_filter_by_search_term(client, sample_audio_file: Path, tmp_path: Path):
    second_source = tmp_path / "bass-riff.wav"
    second_source.write_bytes(sample_audio_file.read_bytes())

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
            "source_path": str(second_source),
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


@pytest.mark.parametrize("fixture_name", ["sample_mp4_file", "sample_webm_file"])
def test_container_imports_are_normalized_and_analyzable(client, request, fixture_name: str):
    source_path = request.getfixturevalue(fixture_name)
    response = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(source_path), "copy_into_project": True},
    )

    assert response.status_code == 200
    project = response.json()["project"]
    assert project["imported_path"].endswith(".wav")

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    assert source_artifact["format"] == "wav"
    assert source_artifact["metadata"]["original_format"] in {"mp4", "webm"}

    analyze_job = client.post(
        f"/api/v1/projects/{project['id']}/analyze",
        json={"include_tempo": False, "force": False},
    ).json()["job"]
    assert wait_for_job(client, analyze_job["id"])["status"] == "completed"
