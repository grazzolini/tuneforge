from __future__ import annotations

from pathlib import Path

import pytest
import soundfile as sf
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.errors import AppError
from app.services.artifacts import register_artifact

from .conftest import wait_for_job


def test_stem_generation_creates_vocal_and_instrumental_artifacts(client, sample_stereo_audio_file: Path, monkeypatch):
    seen_sources: list[str] = []

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        seen_sources.append(str(source_path))
        signal, sample_rate = sf.read(source_path, always_2d=True)
        vocal_path.parent.mkdir(parents=True, exist_ok=True)
        instrumental_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(vocal_path, signal * 0.7, sample_rate)
        sf.write(instrumental_path, signal * 0.3, sample_rate)
        if on_progress:
            on_progress(98)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "output_format": "wav", "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])
    assert final_job["status"] == "completed"
    assert final_job["runtime_device"] == "cpu"
    assert final_job["duration_seconds"] is not None

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    vocal_artifact = next(artifact for artifact in artifacts if artifact["type"] == "vocal_stem")
    instrumental_artifact = next(artifact for artifact in artifacts if artifact["type"] == "instrumental_stem")

    assert vocal_artifact["metadata"]["mode"] == "two_stem"
    assert instrumental_artifact["metadata"]["engine"] == "demucs"
    assert vocal_artifact["metadata"]["model"] == "htdemucs_ft"
    assert stem_job["source_artifact_id"] == source_artifact["id"]
    assert final_job["source_artifact_id"] == source_artifact["id"]
    assert vocal_artifact["metadata"]["source_artifact_id"] == source_artifact["id"]
    assert instrumental_artifact["metadata"]["source_artifact_id"] == source_artifact["id"]
    assert Path(vocal_artifact["path"]).exists()
    assert Path(instrumental_artifact["path"]).exists()
    assert Path(vocal_artifact["path"]).parent.name == source_artifact["id"]

    vocal_signal, _ = sf.read(vocal_artifact["path"], always_2d=True)
    instrumental_signal, _ = sf.read(instrumental_artifact["path"], always_2d=True)
    assert vocal_signal.shape[1] == 2
    assert instrumental_signal.shape[1] == 2

    cached_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, cached_job["id"])["status"] == "completed"

    cached_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    assert len([artifact for artifact in cached_artifacts if artifact["type"] == "vocal_stem"]) == 1
    assert len([artifact for artifact in cached_artifacts if artifact["type"] == "instrumental_stem"]) == 1
    assert seen_sources == [source_artifact["path"]]

    original_vocal_id = vocal_artifact["id"]
    original_instrumental_id = instrumental_artifact["id"]

    rebuild_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "output_format": "wav", "force": True},
    ).json()["job"]
    rebuilt_job = wait_for_job(client, rebuild_job["id"])
    assert rebuilt_job["status"] == "completed"
    assert rebuilt_job["runtime_device"] == "cpu"

    rebuilt_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    rebuilt_vocals = [artifact for artifact in rebuilt_artifacts if artifact["type"] == "vocal_stem"]
    rebuilt_instrumentals = [artifact for artifact in rebuilt_artifacts if artifact["type"] == "instrumental_stem"]
    assert len(rebuilt_vocals) == 1
    assert len(rebuilt_instrumentals) == 1
    assert rebuilt_vocals[0]["id"] == original_vocal_id
    assert rebuilt_instrumentals[0]["id"] == original_instrumental_id
    assert seen_sources == [source_artifact["path"], source_artifact["path"]]

    preview_job = client.post(
        f"/api/v1/projects/{project['id']}/preview",
        json={"transpose": {"semitones": 1}, "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, preview_job["id"])["status"] == "completed"

    artifacts_with_preview = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_artifact = next(artifact for artifact in artifacts_with_preview if artifact["type"] == "preview_mix")

    preview_stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={
            "mode": "two_stem",
            "output_format": "wav",
            "force": False,
            "source_artifact_id": preview_artifact["id"],
        },
    ).json()["job"]
    preview_final_job = wait_for_job(client, preview_stem_job["id"])
    assert preview_final_job["status"] == "completed"
    assert preview_stem_job["source_artifact_id"] == preview_artifact["id"]
    assert preview_final_job["source_artifact_id"] == preview_artifact["id"]

    all_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_vocals = [
        artifact
        for artifact in all_artifacts
        if artifact["type"] == "vocal_stem" and artifact["metadata"]["source_artifact_id"] == preview_artifact["id"]
    ]
    preview_instrumental = [
        artifact
        for artifact in all_artifacts
        if artifact["type"] == "instrumental_stem"
        and artifact["metadata"]["source_artifact_id"] == preview_artifact["id"]
    ]
    assert len(preview_vocals) == 1
    assert len(preview_instrumental) == 1
    assert len([artifact for artifact in all_artifacts if artifact["type"] == "vocal_stem"]) == 2
    assert len([artifact for artifact in all_artifacts if artifact["type"] == "instrumental_stem"]) == 2
    assert seen_sources == [source_artifact["path"], source_artifact["path"], preview_artifact["path"]]


def test_stem_artifact_unique_constraint_rejects_duplicates(client, sample_stereo_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")

    with SessionLocal() as session:
        register_artifact(
            session,
            project_id=project["id"],
            artifact_type="vocal_stem",
            artifact_format="wav",
            path=Path(source_artifact["path"]).with_name("first_vocals.wav"),
            metadata={"mode": "two_stem", "source_artifact_id": source_artifact["id"]},
        )
        session.commit()

        with pytest.raises(IntegrityError):
            register_artifact(
                session,
                project_id=project["id"],
                artifact_type="vocal_stem",
                artifact_format="wav",
                path=Path(source_artifact["path"]).with_name("duplicate_vocals.wav"),
                metadata={"mode": "two_stem", "source_artifact_id": source_artifact["id"]},
            )
            session.commit()
        session.rollback()


def test_stem_generation_reports_missing_dependency(client, sample_stereo_audio_file: Path, monkeypatch):
    def fake_separate_two_stems(*args, **kwargs):
        raise AppError("DEPENDENCY_MISSING", "Demucs is required for stem separation.")

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "output_format": "wav", "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])
    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Demucs is required for stem separation."


def test_deleting_practice_mix_removes_its_stems_only(client, sample_stereo_audio_file: Path, monkeypatch):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        signal, sample_rate = sf.read(source_path, always_2d=True)
        vocal_path.parent.mkdir(parents=True, exist_ok=True)
        instrumental_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(vocal_path, signal * 0.7, sample_rate)
        sf.write(instrumental_path, signal * 0.3, sample_rate)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    preview_job = client.post(
        f"/api/v1/projects/{project['id']}/preview",
        json={"transpose": {"semitones": 1}, "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, preview_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    preview_artifact = next(artifact for artifact in artifacts if artifact["type"] == "preview_mix")

    source_stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "output_format": "wav", "force": False, "source_artifact_id": source_artifact["id"]},
    ).json()["job"]
    assert wait_for_job(client, source_stem_job["id"])["status"] == "completed"

    preview_stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "output_format": "wav", "force": False, "source_artifact_id": preview_artifact["id"]},
    ).json()["job"]
    assert wait_for_job(client, preview_stem_job["id"])["status"] == "completed"

    artifacts_with_stems = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_vocal = next(
        artifact
        for artifact in artifacts_with_stems
        if artifact["type"] == "vocal_stem" and artifact["metadata"]["source_artifact_id"] == preview_artifact["id"]
    )
    preview_instrumental = next(
        artifact
        for artifact in artifacts_with_stems
        if artifact["type"] == "instrumental_stem"
        and artifact["metadata"]["source_artifact_id"] == preview_artifact["id"]
    )
    source_vocal = next(
        artifact
        for artifact in artifacts_with_stems
        if artifact["type"] == "vocal_stem" and artifact["metadata"]["source_artifact_id"] == source_artifact["id"]
    )

    assert Path(preview_artifact["path"]).exists()
    assert Path(preview_vocal["path"]).exists()
    assert Path(preview_instrumental["path"]).exists()
    assert Path(source_vocal["path"]).exists()

    response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{preview_artifact['id']}")

    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert not Path(preview_artifact["path"]).exists()
    assert not Path(preview_vocal["path"]).exists()
    assert not Path(preview_instrumental["path"]).exists()
    assert Path(source_vocal["path"]).exists()

    remaining_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    remaining_ids = {artifact["id"] for artifact in remaining_artifacts}
    assert preview_artifact["id"] not in remaining_ids
    assert preview_vocal["id"] not in remaining_ids
    assert preview_instrumental["id"] not in remaining_ids
    assert source_artifact["id"] in remaining_ids
    assert source_vocal["id"] in remaining_ids


def test_source_audio_cannot_be_deleted_from_project(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")

    response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{source_artifact['id']}")

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert response.json()["error"]["message"] == "Source audio cannot be deleted from a project."
