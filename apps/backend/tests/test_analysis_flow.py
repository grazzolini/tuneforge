from __future__ import annotations

from pathlib import Path

from .conftest import wait_for_job


def test_analysis_job_persists_results(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    job = client.post(
        f"/api/v1/projects/{project['id']}/analyze",
        json={"include_tempo": False, "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"

    analysis = client.get(f"/api/v1/projects/{project['id']}/analysis").json()["analysis"]
    assert analysis["estimated_reference_hz"] is not None
    assert analysis["tuning_offset_cents"] is not None
    assert analysis["estimated_key"] is not None

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    assert any(artifact["type"] == "analysis_json" for artifact in artifacts)
