from __future__ import annotations

from pathlib import Path
from typing import Any

from app.db import SessionLocal
from app.services.artifacts import register_artifact
from app.services.chords import detect_project_chords
from app.services.projects import get_project

from .conftest import wait_for_job


def _segment(label: str, *, confidence: float, pitch_class: int, quality: str) -> dict[str, Any]:
    return {
        "start_seconds": 0.0,
        "end_seconds": 4.0,
        "label": label,
        "confidence": confidence,
        "pitch_class": pitch_class,
        "quality": quality,
    }


def test_chord_job_persists_timeline(client, sample_chord_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"])["status"] == "completed"

    initial = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert initial["project_id"] == project["id"]
    assert initial["backend"] == "librosa"
    assert len(initial["timeline"]) >= 3
    assert initial["source_segments"] == initial["timeline"]
    assert initial["has_user_edits"] is False
    initial_created_at = initial["created_at"]
    initial_updated_at = initial["updated_at"]

    job = client.post(
        f"/api/v1/projects/{project['id']}/chords",
        json={"backend": "default", "force": True},
    ).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["runtime_device"] is None
    assert final_job["duration_seconds"] is not None

    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert chords["project_id"] == project["id"]
    assert chords["backend"] == "librosa"
    assert len(chords["timeline"]) >= 3
    assert len(chords["source_segments"]) >= 3
    assert chords["has_user_edits"] is False
    assert all(segment["end_seconds"] > segment["start_seconds"] for segment in chords["timeline"])
    assert all(segment["pitch_class"] is not None for segment in chords["timeline"])
    supported_qualities = {"major", "minor", "7", "maj7", "m7", "sus2", "sus4", "dim", None}
    assert all(segment["quality"] in supported_qualities for segment in chords["timeline"])
    assert chords["created_at"] == initial_created_at
    assert chords["updated_at"] != initial_updated_at

    labels = [segment["label"] for segment in chords["timeline"]]
    assert labels[0] == "C"
    assert any(label == "G" for label in labels)
    assert any(label == "Am" for label in labels)
    assert any(label == "F" for label in labels)


def test_chord_refresh_uses_source_stems_only_for_augmentation(
    client,
    sample_chord_audio_file: Path,
    tmp_path: Path,
    monkeypatch,
):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"])["status"] == "completed"

    source_stem_path = tmp_path / "source-instrumental.wav"
    source_stem_path.write_bytes(b"stem")
    mix_path = tmp_path / "mix.wav"
    mix_path.write_bytes(b"mix")
    mix_stem_path = tmp_path / "mix-instrumental.wav"
    mix_stem_path.write_bytes(b"mix-stem")

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        source_artifact = next(artifact for artifact in project_model.artifacts if artifact.type == "source_audio")
        mix_artifact = register_artifact(
            session,
            project_id=project_model.id,
            artifact_type="preview_mix",
            artifact_format="wav",
            path=mix_path,
            metadata={"source_artifact_id": source_artifact.id},
            generated_by="ffmpeg",
        )
        register_artifact(
            session,
            project_id=project_model.id,
            artifact_type="instrumental_stem",
            artifact_format="wav",
            path=mix_stem_path,
            metadata={"source_artifact_id": mix_artifact.id, "source_artifact_type": "preview_mix"},
            generated_by="demucs",
        )
        register_artifact(
            session,
            project_id=project_model.id,
            artifact_type="instrumental_stem",
            artifact_format="wav",
            path=source_stem_path,
            metadata={"source_artifact_id": source_artifact.id, "source_artifact_type": "source_audio"},
            generated_by="demucs",
        )
        session.commit()

    def fake_detect_chord_timeline(path: Path) -> list[dict[str, Any]]:
        if path == source_stem_path:
            return [_segment("G", confidence=0.88, pitch_class=7, quality="major")]
        if path == mix_stem_path:
            return [_segment("F", confidence=0.95, pitch_class=5, quality="major")]
        return [_segment("Em", confidence=0.35, pitch_class=4, quality="minor")]

    monkeypatch.setattr("app.services.chords.detect_chord_timeline", fake_detect_chord_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        chords = detect_project_chords(session, project_model, force=True)
        session.commit()

    assert chords.source_artifact_id == source_artifact.id
    assert [segment["label"] for segment in chords.source_segments_json] == ["Em"]
    assert [segment["label"] for segment in chords.segments_json] == ["G"]


def test_chord_refresh_preserves_user_edits_without_overwrite(
    client,
    sample_chord_audio_file: Path,
    monkeypatch,
):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"])["status"] == "completed"

    edited_segment = _segment("C", confidence=1.0, pitch_class=0, quality="major")
    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        assert project_model.chords is not None
        project_model.chords.segments_json = [edited_segment]
        project_model.chords.has_user_edits = True
        session.commit()

    calls: list[Path] = []

    def fake_detect_chord_timeline(path: Path) -> list[dict[str, Any]]:
        calls.append(path)
        return [_segment("G", confidence=0.88, pitch_class=7, quality="major")]

    monkeypatch.setattr("app.services.chords.detect_chord_timeline", fake_detect_chord_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        chords = detect_project_chords(session, project_model, force=True)
        session.commit()

    assert calls == []
    assert chords.has_user_edits is True
    assert chords.segments_json == [edited_segment]

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        chords = detect_project_chords(session, project_model, force=True, overwrite_user_edits=True)
        session.commit()

    assert calls
    assert chords.has_user_edits is False
    assert [segment["label"] for segment in chords.segments_json] == ["G"]
