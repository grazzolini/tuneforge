from __future__ import annotations

from pathlib import Path

import soundfile as sf

from .conftest import wait_for_job


def test_stem_generation_creates_vocal_and_instrumental_artifacts(client, sample_stereo_audio_file: Path):
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
    vocal_artifact = next(artifact for artifact in artifacts if artifact["type"] == "vocal_stem")
    instrumental_artifact = next(artifact for artifact in artifacts if artifact["type"] == "instrumental_stem")

    assert vocal_artifact["metadata"]["mode"] == "two_stem"
    assert instrumental_artifact["metadata"]["engine"] in {"mid-side-v1", "mono-fallback"}
    assert Path(vocal_artifact["path"]).exists()
    assert Path(instrumental_artifact["path"]).exists()

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
