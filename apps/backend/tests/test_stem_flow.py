from __future__ import annotations

from pathlib import Path

import soundfile as sf

from app.errors import AppError

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
        return {"engine": "demucs", "model": model, "device": device}

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

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    vocal_artifact = next(artifact for artifact in artifacts if artifact["type"] == "vocal_stem")
    instrumental_artifact = next(artifact for artifact in artifacts if artifact["type"] == "instrumental_stem")

    assert vocal_artifact["metadata"]["mode"] == "two_stem"
    assert instrumental_artifact["metadata"]["engine"] == "demucs"
    assert vocal_artifact["metadata"]["model"] == "htdemucs_ft"
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
    assert wait_for_job(client, preview_stem_job["id"])["status"] == "completed"

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
    assert seen_sources == [source_artifact["path"], preview_artifact["path"]]


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
