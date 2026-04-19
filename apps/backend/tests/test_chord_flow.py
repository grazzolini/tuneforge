from __future__ import annotations

from pathlib import Path

from .conftest import wait_for_job


def test_chord_job_persists_timeline(client, sample_chord_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert initial["project_id"] == project["id"]
    assert initial["timeline"] == []
    assert initial["backend"] is None

    job = client.post(
        f"/api/v1/projects/{project['id']}/chords",
        json={"backend": "default", "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"

    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert chords["project_id"] == project["id"]
    assert chords["backend"] == "default"
    assert len(chords["timeline"]) >= 3
    assert all(segment["end_seconds"] > segment["start_seconds"] for segment in chords["timeline"])
    assert all(segment["pitch_class"] is not None for segment in chords["timeline"])
    assert all(segment["quality"] in {"major", "minor"} for segment in chords["timeline"])

    labels = [segment["label"] for segment in chords["timeline"]]
    assert labels[0] == "C"
    assert any(label == "G" for label in labels)
    assert any(label == "Am" for label in labels)
    assert any(label == "F" for label in labels)
