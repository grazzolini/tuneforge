from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
import soundfile as sf
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.db import SessionLocal
from app.errors import AppError, JobCancelledError
from app.models import Job
from app.services.artifacts import register_artifact
from app.services.projects import get_project, import_project
from app.utils.ids import new_id

from .conftest import wait_for_job


def _create_project_without_import_jobs(source_path: Path) -> str:
    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=True,
            display_name=None,
        )
        project_id = project.id
        session.commit()
    return project_id


def test_default_stem_generation_creates_six_stem_artifacts(client, sample_stereo_audio_file: Path, monkeypatch):
    def fake_separate_sources(
        source_path: Path,
        output_paths: dict[str, Path],
        *,
        model: str,
        device: str,
        model_repo=None,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        signal, sample_rate = sf.read(source_path, always_2d=True)
        for index, output_path in enumerate(output_paths.values(), start=1):
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(output_path, signal * (index / 10), sample_rate)
        if on_progress:
            on_progress(98)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_sources", fake_separate_sources)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "output_format": "wav", "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])

    assert final_job["status"] == "completed"
    assert final_job["runtime_device"] == "cpu"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    stem_artifacts = [artifact for artifact in artifacts if artifact["metadata"].get("stem_model") == "htdemucs_6s"]
    assert {artifact["type"] for artifact in stem_artifacts} == {
        "vocal_stem",
        "drums_stem",
        "bass_stem",
        "guitar_stem",
        "piano_stem",
        "other_stem",
    }
    assert not [artifact for artifact in artifacts if artifact["type"] == "instrumental_stem"]
    assert {artifact["metadata"]["stem_source"] for artifact in stem_artifacts} == {
        "vocals",
        "drums",
        "bass",
        "guitar",
        "piano",
        "other",
    }
    assert stem_job["stem_model"] == "htdemucs_6s"
    assert stem_job["stem_model_label"] == "Default (6 stems model)"
    assert final_job["stem_model"] == "htdemucs_6s"
    assert final_job["stem_model_label"] == "Default (6 stems model)"

    drums_artifact = next(artifact for artifact in stem_artifacts if artifact["type"] == "drums_stem")
    drums_path = Path(drums_artifact["path"])
    assert drums_path.exists()

    for job in client.get("/api/v1/jobs").json()["jobs"]:
        if job["project_id"] == project["id"] and job["type"] == "chords":
            assert wait_for_job(client, job["id"])["status"] == "completed"

    delete_response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{drums_artifact['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json()["deleted"] is True
    assert not drums_path.exists()

    remaining_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    assert not [artifact for artifact in remaining_artifacts if artifact["id"] == drums_artifact["id"]]


def test_rebuilding_six_stems_with_two_stems_prunes_previous_model_artifacts(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    def fake_separate_sources(
        source_path: Path,
        output_paths: dict[str, Path],
        *,
        model: str,
        device: str,
        model_repo=None,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        signal, sample_rate = sf.read(source_path, always_2d=True)
        for index, output_path in enumerate(output_paths.values(), start=1):
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(output_path, signal * (index / 10), sample_rate)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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

    monkeypatch.setattr("app.services.stems.separate_sources", fake_separate_sources)
    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    six_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, six_job["id"])["status"] == "completed"

    artifacts_after_six = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts_after_six if artifact["type"] == "source_audio")
    six_stems = [
        artifact
        for artifact in artifacts_after_six
        if artifact["metadata"].get("source_artifact_id") == source_artifact["id"]
        and artifact["metadata"].get("stem_model") == "htdemucs_6s"
    ]
    six_paths = [Path(artifact["path"]) for artifact in six_stems]
    assert len(six_stems) == 6
    assert all(path.exists() for path in six_paths)

    two_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": True},
    ).json()["job"]
    assert wait_for_job(client, two_job["id"])["status"] == "completed"

    artifacts_after_two = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_stems = [
        artifact
        for artifact in artifacts_after_two
        if artifact["metadata"].get("source_artifact_id") == source_artifact["id"]
        and artifact["type"].endswith("_stem")
    ]
    assert {artifact["type"] for artifact in source_stems} == {"vocal_stem", "instrumental_stem"}
    assert {artifact["metadata"]["stem_model"] for artifact in source_stems} == {"htdemucs_ft"}
    assert all(not path.exists() for path in six_paths)


def test_rebuilding_two_stems_with_six_stems_prunes_previous_model_artifacts(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    def fake_separate_sources(
        source_path: Path,
        output_paths: dict[str, Path],
        *,
        model: str,
        device: str,
        model_repo=None,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        signal, sample_rate = sf.read(source_path, always_2d=True)
        for index, output_path in enumerate(output_paths.values(), start=1):
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(output_path, signal * (index / 10), sample_rate)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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

    monkeypatch.setattr("app.services.stems.separate_sources", fake_separate_sources)
    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    two_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, two_job["id"])["status"] == "completed"

    artifacts_after_two = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts_after_two if artifact["type"] == "source_audio")
    two_stems = [
        artifact
        for artifact in artifacts_after_two
        if artifact["metadata"].get("source_artifact_id") == source_artifact["id"]
        and artifact["metadata"].get("stem_model") == "htdemucs_ft"
    ]
    two_paths = [Path(artifact["path"]) for artifact in two_stems]
    assert len(two_stems) == 2
    assert all(path.exists() for path in two_paths)

    six_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "stems", "stem_model": "htdemucs_6s", "output_format": "wav", "force": True},
    ).json()["job"]
    assert wait_for_job(client, six_job["id"])["status"] == "completed"

    artifacts_after_six = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_stems = [
        artifact
        for artifact in artifacts_after_six
        if artifact["metadata"].get("source_artifact_id") == source_artifact["id"]
        and artifact["type"].endswith("_stem")
    ]
    assert {artifact["type"] for artifact in source_stems} == {
        "vocal_stem",
        "drums_stem",
        "bass_stem",
        "guitar_stem",
        "piano_stem",
        "other_stem",
    }
    assert {artifact["metadata"]["stem_model"] for artifact in source_stems} == {"htdemucs_6s"}
    assert all(not path.exists() for path in two_paths)


def test_stem_generation_creates_vocal_and_instrumental_artifacts(client, sample_stereo_audio_file: Path, monkeypatch):
    seen_sources: list[str] = []

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
    original_vocal_path = Path(vocal_artifact["path"])
    original_instrumental_path = Path(instrumental_artifact["path"])

    assert vocal_artifact["metadata"]["mode"] == "two_stems"
    assert instrumental_artifact["metadata"]["engine"] == "demucs"
    assert vocal_artifact["metadata"]["model"] == "htdemucs_ft"
    assert stem_job["source_artifact_id"] == source_artifact["id"]
    assert final_job["source_artifact_id"] == source_artifact["id"]
    assert vocal_artifact["metadata"]["source_artifact_id"] == source_artifact["id"]
    assert instrumental_artifact["metadata"]["source_artifact_id"] == source_artifact["id"]
    assert Path(vocal_artifact["path"]).exists()
    assert Path(instrumental_artifact["path"]).exists()
    assert Path(vocal_artifact["path"]).parent.parent.name == "htdemucs_ft"
    assert Path(vocal_artifact["path"]).parent.parent.parent.name == source_artifact["id"]

    vocal_signal, _ = sf.read(vocal_artifact["path"], always_2d=True)
    instrumental_signal, _ = sf.read(instrumental_artifact["path"], always_2d=True)
    assert vocal_signal.shape[1] == 2
    assert instrumental_signal.shape[1] == 2

    cached_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
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
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": True},
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
    assert not original_vocal_path.exists()
    assert not original_instrumental_path.exists()
    assert not original_vocal_path.parent.exists()

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
            "stem_model": "htdemucs_ft",
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


def test_omitted_stem_mode_uses_configured_default_model(client, sample_stereo_audio_file: Path, monkeypatch):
    monkeypatch.setenv("TUNEFORGE_STEM_MODEL", "htdemucs_ft")
    get_settings.cache_clear()

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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

    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, stem_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    stems = [artifact for artifact in artifacts if artifact["metadata"].get("stem_model") == "htdemucs_ft"]
    assert {artifact["type"] for artifact in stems} == {"vocal_stem", "instrumental_stem"}


def test_two_stem_mode_rejects_six_stem_model(client, sample_stereo_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_6s", "output_format": "wav"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_two_stem_mode_with_default_uses_two_stem_model(client, sample_stereo_audio_file: Path, monkeypatch):
    monkeypatch.setenv("TUNEFORGE_STEM_MODEL", "htdemucs_6s")
    get_settings.cache_clear()

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "default", "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, stem_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    stems = [artifact for artifact in artifacts if artifact["metadata"].get("stem_model") == "htdemucs_ft"]
    assert {artifact["type"] for artifact in stems} == {"vocal_stem", "instrumental_stem"}


def test_source_stem_generation_enqueues_chord_refresh_job(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
        if on_progress:
            on_progress(98)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"])["status"] == "completed"

    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, stem_job["id"])["status"] == "completed"

    source_stem_jobs = client.get("/api/v1/jobs").json()["jobs"]
    chord_refresh_jobs = [
        job
        for job in source_stem_jobs
        if job["project_id"] == project["id"] and job["type"] == "chords" and job["id"] != initial_chord_job["id"]
    ]
    assert len(chord_refresh_jobs) == 1
    assert chord_refresh_jobs[0]["chord_backend"] == "tuneforge-fast"
    assert chord_refresh_jobs[0]["chord_source"] == "source+stem"
    assert wait_for_job(client, chord_refresh_jobs[0]["id"])["status"] == "completed"

    preview_job = client.post(
        f"/api/v1/projects/{project['id']}/preview",
        json={"transpose": {"semitones": 1}, "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, preview_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_artifact = next(artifact for artifact in artifacts if artifact["type"] == "preview_mix")
    preview_stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={
            "mode": "two_stem",
            "stem_model": "htdemucs_ft",
            "output_format": "wav",
            "force": False,
            "source_artifact_id": preview_artifact["id"],
        },
    ).json()["job"]
    assert wait_for_job(client, preview_stem_job["id"])["status"] == "completed"

    preview_stem_jobs = client.get("/api/v1/jobs").json()["jobs"]
    assert (
        len(
            [
                job
                for job in preview_stem_jobs
                if job["project_id"] == project["id"] and job["type"] == "chords"
            ]
        )
        == 2
    )


def test_source_stems_do_not_refresh_edited_chords_without_overwrite(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
        if on_progress:
            on_progress(98)
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_stereo_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"])["status"] == "completed"

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        assert project_model.chords is not None
        project_model.chords.has_user_edits = True
        session.commit()

    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, stem_job["id"])["status"] == "completed"
    jobs_after_stems = client.get("/api/v1/jobs").json()["jobs"]
    assert len([job for job in jobs_after_stems if job["project_id"] == project["id"] and job["type"] == "chords"]) == 1

    rebuild_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={
            "mode": "two_stem",
            "stem_model": "htdemucs_ft",
            "output_format": "wav",
            "force": True,
            "overwrite_chord_edits": True,
        },
    ).json()["job"]
    assert wait_for_job(client, rebuild_job["id"])["status"] == "completed"
    jobs_after_rebuild = client.get("/api/v1/jobs").json()["jobs"]
    chord_jobs_after_rebuild = [
        job for job in jobs_after_rebuild if job["project_id"] == project["id"] and job["type"] == "chords"
    ]
    assert len(chord_jobs_after_rebuild) == 2


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
            metadata={
                "mode": "two_stems",
                "source_artifact_id": source_artifact["id"],
            },
        )
        session.commit()

        with pytest.raises(IntegrityError):
            register_artifact(
                session,
                project_id=project["id"],
                artifact_type="vocal_stem",
                artifact_format="wav",
                path=Path(source_artifact["path"]).with_name("duplicate_vocals.wav"),
                metadata={
                    "mode": "two_stems",
                    "source_artifact_id": source_artifact["id"],
                },
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
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, stem_job["id"])
    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Demucs is required for stem separation."


def test_running_stem_cancel_after_subprocess_exit_marks_job_cancelled(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    project_id = _create_project_without_import_jobs(sample_stereo_audio_file)
    worker_sleeping = threading.Event()
    terminated = threading.Event()
    terminate_calls: list[str] = []
    original_sleep = time.sleep

    class FakeDemucsProcess:
        def __init__(self, *_args, **_kwargs) -> None:
            self.returncode: int | None = None
            self.stdout = None
            self.stderr = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            terminate_calls.append(threading.current_thread().name)
            self.returncode = -15
            terminated.set()

        def kill(self) -> None:
            self.returncode = -9
            terminated.set()

        def wait(self, timeout=None) -> int | None:
            terminated.wait(timeout)
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return "", "terminated"

    def fake_sleep(seconds: float) -> None:
        if threading.current_thread().name == "tuneforge-job-runner" and seconds == 0.25:
            worker_sleeping.set()
            terminated.wait(timeout=5)
            return
        original_sleep(seconds)

    monkeypatch.setattr("app.engines.stems.importlib.util.find_spec", lambda _name: object())
    monkeypatch.setattr("app.engines.stems.subprocess.Popen", FakeDemucsProcess)
    monkeypatch.setattr("app.engines.stems.time.sleep", fake_sleep)

    stem_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]

    assert worker_sleeping.wait(timeout=5)
    cancel_response = client.post(f"/api/v1/jobs/{stem_job['id']}/cancel")
    assert cancel_response.status_code == 200
    assert terminated.wait(timeout=5)

    final_job = wait_for_job(client, stem_job["id"])
    assert final_job["status"] == "cancelled"
    assert final_job["error_message"] is None
    assert terminate_calls


def test_demucs_nonzero_exit_after_cancel_raises_job_cancelled(tmp_path: Path, monkeypatch):
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"fake audio")
    poll_count = 0
    cancel_checks = 0

    class FakeDemucsProcess:
        returncode: int | None = None

        def poll(self) -> int | None:
            nonlocal poll_count
            poll_count += 1
            if poll_count == 1:
                return None
            self.returncode = -15
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

        def wait(self, timeout=None) -> int | None:
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return "", "terminated"

    def should_cancel() -> bool:
        nonlocal cancel_checks
        cancel_checks += 1
        return cancel_checks > 1

    monkeypatch.setattr("app.engines.stems.importlib.util.find_spec", lambda _name: object())
    monkeypatch.setattr("app.engines.stems.subprocess.Popen", lambda *_args, **_kwargs: FakeDemucsProcess())
    monkeypatch.setattr("app.engines.stems.time.sleep", lambda _seconds: None)

    from app.engines.stems import separate_two_stems

    with pytest.raises(JobCancelledError):
        separate_two_stems(
            source_path,
            tmp_path / "vocals.wav",
            tmp_path / "instrumental.wav",
            model="htdemucs_ft",
            should_cancel=should_cancel,
        )


def test_cancelled_stem_generation_removes_temp_outputs_without_artifact_rows(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    project_id = _create_project_without_import_jobs(sample_stereo_audio_file)
    monkeypatch.setenv("TUNEFORGE_STEM_MODEL", "htdemucs_ft")
    get_settings.cache_clear()
    ready_to_cancel = threading.Event()
    allow_return = threading.Event()
    temp_paths: list[Path] = []

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
        temp_paths.extend([vocal_path, instrumental_path])
        ready_to_cancel.set()
        if not allow_return.wait(timeout=5):
            raise AssertionError("Timed out waiting to release fake stem separation.")
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    stem_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]

    assert ready_to_cancel.wait(timeout=5)
    cancel_response = client.post(f"/api/v1/jobs/{stem_job['id']}/cancel")
    assert cancel_response.status_code == 200
    allow_return.set()

    final_job = wait_for_job(client, stem_job["id"])
    assert final_job["status"] == "cancelled"
    assert final_job["error_message"] is None
    assert temp_paths
    assert all(not path.exists() for path in temp_paths)

    artifacts = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    assert not [artifact for artifact in artifacts if artifact["type"].endswith("_stem")]


def test_cancelled_forced_stem_rebuild_preserves_existing_artifacts(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    project_id = _create_project_without_import_jobs(sample_stereo_audio_file)
    monkeypatch.setenv("TUNEFORGE_STEM_MODEL", "htdemucs_ft")
    get_settings.cache_clear()
    ready_to_cancel = threading.Event()
    allow_return = threading.Event()
    temp_paths: list[Path] = []
    separation_count = 0

    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
        on_progress=None,
        should_cancel=None,
        register_process=None,
        unregister_process=None,
    ):
        nonlocal separation_count
        separation_count += 1
        signal, sample_rate = sf.read(source_path, always_2d=True)
        vocal_path.parent.mkdir(parents=True, exist_ok=True)
        instrumental_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(vocal_path, signal * 0.7, sample_rate)
        sf.write(instrumental_path, signal * 0.3, sample_rate)
        if separation_count == 2:
            temp_paths.extend([vocal_path, instrumental_path])
            ready_to_cancel.set()
            if not allow_return.wait(timeout=5):
                raise AssertionError("Timed out waiting to release fake stem separation.")
        return {"engine": "demucs", "model": model, "requested_device": device, "device": "cpu"}

    monkeypatch.setattr("app.services.stems.separate_two_stems", fake_separate_two_stems)

    initial_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": False},
    ).json()["job"]
    assert wait_for_job(client, initial_job["id"])["status"] == "completed"

    artifacts_before = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    existing_stems = {
        artifact["type"]: artifact
        for artifact in artifacts_before
        if artifact["metadata"].get("stem_model") == "htdemucs_ft"
    }
    assert set(existing_stems) == {"vocal_stem", "instrumental_stem"}
    previous_rows = {
        artifact_type: (artifact["id"], Path(artifact["path"]))
        for artifact_type, artifact in existing_stems.items()
    }
    assert all(path.exists() for _artifact_id, path in previous_rows.values())

    rebuild_job = client.post(
        f"/api/v1/projects/{project_id}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav", "force": True},
    ).json()["job"]
    assert ready_to_cancel.wait(timeout=5)
    cancel_response = client.post(f"/api/v1/jobs/{rebuild_job['id']}/cancel")
    assert cancel_response.status_code == 200
    allow_return.set()

    final_job = wait_for_job(client, rebuild_job["id"])
    assert final_job["status"] == "cancelled"
    assert final_job["error_message"] is None
    assert temp_paths
    assert all(not path.exists() for path in temp_paths)

    artifacts_after = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    rebuilt_stems = {
        artifact["type"]: artifact
        for artifact in artifacts_after
        if artifact["metadata"].get("stem_model") == "htdemucs_ft"
    }
    assert set(rebuilt_stems) == {"vocal_stem", "instrumental_stem"}
    assert {
        artifact_type: (artifact["id"], Path(artifact["path"]))
        for artifact_type, artifact in rebuilt_stems.items()
    } == previous_rows
    assert all(path.exists() for _artifact_id, path in previous_rows.values())
    assert not [artifact for artifact in artifacts_after if Path(artifact["path"]) in temp_paths]


def test_deleting_practice_mix_removes_its_stems_only(client, sample_stereo_audio_file: Path, monkeypatch):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
        json={
            "mode": "two_stem",
            "stem_model": "htdemucs_ft",
            "output_format": "wav",
            "force": False,
            "source_artifact_id": source_artifact["id"],
        },
    ).json()["job"]
    assert wait_for_job(client, source_stem_job["id"])["status"] == "completed"

    preview_stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={
            "mode": "two_stem",
            "stem_model": "htdemucs_ft",
            "output_format": "wav",
            "force": False,
            "source_artifact_id": preview_artifact["id"],
        },
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

    stem_delete_response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{source_vocal['id']}")

    assert stem_delete_response.status_code == 200
    assert stem_delete_response.json() == {"deleted": True}
    assert not Path(source_vocal["path"]).exists()
    final_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    final_ids = {artifact["id"] for artifact in final_artifacts}
    assert source_vocal["id"] not in final_ids
    assert source_artifact["id"] in final_ids


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


def test_stem_delete_rejects_when_audio_job_is_pending(client, sample_stereo_audio_file: Path, monkeypatch):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, stem_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    vocal_artifact = next(artifact for artifact in artifacts if artifact["type"] == "vocal_stem")

    with SessionLocal() as session:
        session.add(
            Job(
                id=new_id("job"),
                project_id=project["id"],
                type="chords",
                status="pending",
                progress=0,
                payload_json={},
                result_artifact_ids_json=[],
                cancel_requested=False,
            )
        )
        session.commit()

    response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{vocal_artifact['id']}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ARTIFACT_BUSY"


def test_preview_mix_delete_rejects_when_audio_job_is_pending(client, sample_stereo_audio_file: Path):
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
    preview_artifact = next(artifact for artifact in artifacts if artifact["type"] == "preview_mix")

    with SessionLocal() as session:
        session.add(
            Job(
                id=new_id("job"),
                project_id=project["id"],
                type="stems",
                status="pending",
                progress=0,
                payload_json={"source_artifact_id": preview_artifact["id"]},
                result_artifact_ids_json=[],
                cancel_requested=False,
            )
        )
        session.commit()

    response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{preview_artifact['id']}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ARTIFACT_BUSY"


def test_stem_delete_rejects_when_export_job_is_running(
    client,
    sample_stereo_audio_file: Path,
    monkeypatch,
):
    def fake_separate_two_stems(
        source_path: Path,
        vocal_path: Path,
        instrumental_path: Path,
        *,
        model: str,
        device: str,
        model_repo=None,
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
    stem_job = client.post(
        f"/api/v1/projects/{project['id']}/stems",
        json={"mode": "two_stem", "stem_model": "htdemucs_ft", "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, stem_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    vocal_artifact = next(artifact for artifact in artifacts if artifact["type"] == "vocal_stem")

    with SessionLocal() as session:
        session.add(
            Job(
                id=new_id("job"),
                project_id=project["id"],
                type="export",
                status="running",
                progress=42,
                payload_json={"artifact_ids": [vocal_artifact["id"]]},
                result_artifact_ids_json=[],
                cancel_requested=False,
            )
        )
        session.commit()

    response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{vocal_artifact['id']}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ARTIFACT_BUSY"


def test_preview_mix_delete_rejects_when_export_job_is_pending(
    client,
    sample_stereo_audio_file: Path,
):
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
    preview_artifact = next(artifact for artifact in artifacts if artifact["type"] == "preview_mix")

    with SessionLocal() as session:
        session.add(
            Job(
                id=new_id("job"),
                project_id=project["id"],
                type="export",
                status="pending",
                progress=0,
                payload_json={"artifact_ids": [preview_artifact["id"]]},
                result_artifact_ids_json=[],
                cancel_requested=False,
            )
        )
        session.commit()

    response = client.delete(f"/api/v1/projects/{project['id']}/artifacts/{preview_artifact['id']}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ARTIFACT_BUSY"


def test_mix_audio_files_closes_open_handles_when_later_open_fails(tmp_path: Path, monkeypatch):
    closed: list[str] = []

    class FakeHandle:
        def __init__(self, name: str) -> None:
            self.name = name

        def close(self) -> None:
            closed.append(self.name)

    def fake_sound_file(path: Path, *args, **kwargs):
        if path.name == "second.wav":
            raise OSError("open failed")
        return FakeHandle(path.name)

    monkeypatch.setattr("app.engines.stems.sf.SoundFile", fake_sound_file)

    with pytest.raises(OSError, match="open failed"):
        from app.engines.stems import mix_audio_files

        mix_audio_files([tmp_path / "first.wav", tmp_path / "second.wav"], tmp_path / "mix.wav")

    assert closed == ["first.wav"]
