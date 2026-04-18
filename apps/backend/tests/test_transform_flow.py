from __future__ import annotations

from pathlib import Path

from .conftest import wait_for_job


def test_preview_generation_cache_and_export(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    analyze_job = client.post(
        f"/api/v1/projects/{project['id']}/analyze",
        json={"include_tempo": False, "force": False},
    ).json()["job"]
    assert wait_for_job(client, analyze_job["id"])["status"] == "completed"

    preview_body = {
        "retune": {"target_reference_hz": 440.0},
        "transpose": {"semitones": -1},
        "output_format": "wav",
    }
    preview_job = client.post(f"/api/v1/projects/{project['id']}/preview", json=preview_body).json()["job"]
    preview_final = wait_for_job(client, preview_job["id"])
    assert preview_final["status"] == "completed"
    assert len(preview_final["result_artifact_ids_json"] if "result_artifact_ids_json" in preview_final else []) == 0

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_artifacts = [artifact for artifact in artifacts if artifact["type"] == "preview_mix"]
    assert len(preview_artifacts) == 1
    preview_artifact = preview_artifacts[0]
    assert Path(preview_artifact["path"]).exists()

    cached_job = client.post(f"/api/v1/projects/{project['id']}/preview", json=preview_body).json()["job"]
    assert wait_for_job(client, cached_job["id"])["status"] == "completed"
    cached_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    assert len([artifact for artifact in cached_artifacts if artifact["type"] == "preview_mix"]) == 1

    transposed_preview_job = client.post(
        f"/api/v1/projects/{project['id']}/preview",
        json={
            "retune": {"target_reference_hz": 440.0},
            "transpose": {"semitones": 2},
            "output_format": "wav",
        },
    ).json()["job"]
    assert wait_for_job(client, transposed_preview_job["id"])["status"] == "completed"
    replaced_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_artifacts = [artifact for artifact in replaced_artifacts if artifact["type"] == "preview_mix"]
    assert len(preview_artifacts) == 1
    current_preview_artifact = preview_artifacts[0]

    export_job = client.post(
        f"/api/v1/projects/{project['id']}/export",
        json={
            "artifact_ids": [current_preview_artifact["id"]],
            "mixdown_mode": "copy",
            "output_format": "mp3",
        },
    ).json()["job"]
    export_final = wait_for_job(client, export_job["id"])
    assert export_final["status"] == "completed"

    export_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    exported = [artifact for artifact in export_artifacts if artifact["type"] == "export_mix"]
    assert exported
    assert any(Path(artifact["path"]).suffix == ".mp3" for artifact in exported)
