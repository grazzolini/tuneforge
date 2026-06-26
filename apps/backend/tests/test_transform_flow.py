from __future__ import annotations

from pathlib import Path

import pytest
import soundfile as sf
from sqlalchemy import select

from app.db import SessionLocal
from app.errors import JobCancelledError
from app.models import Artifact, Project
from app.services.transformations import export_artifacts

from .conftest import wait_for_job


def _fake_separate_sources(
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
    saved_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_artifacts = [artifact for artifact in saved_artifacts if artifact["type"] == "preview_mix"]
    assert len(preview_artifacts) == 2
    current_preview_artifact = next(
        artifact
        for artifact in preview_artifacts
        if artifact.get("metadata", {}).get("transpose", {}).get("semitones") == 2
    )

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


def test_preview_mix_creation_does_not_auto_queue_stems(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    monkeypatch.setattr("app.services.stems.separate_sources", _fake_separate_sources)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]
    import_stem_job = next(
        job
        for job in client.get("/api/v1/jobs").json()["jobs"]
        if job["project_id"] == project["id"] and job["type"] == "stems"
    )
    assert wait_for_job(client, import_stem_job["id"])["status"] == "completed"

    preview_job = client.post(
        f"/api/v1/projects/{project['id']}/preview",
        json={"transpose": {"semitones": 1}, "output_format": "wav"},
    ).json()["job"]
    assert wait_for_job(client, preview_job["id"])["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview_artifact = next(artifact for artifact in artifacts if artifact["type"] == "preview_mix")
    jobs = client.get("/api/v1/jobs").json()["jobs"]
    assert not [
        job
        for job in jobs
        if job["project_id"] == project["id"]
        and job["type"] == "stems"
        and job["source_artifact_id"] == preview_artifact["id"]
    ]


def test_same_format_export_cancelled_after_copy_skips_artifact_registration(client, tmp_path: Path):
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"source audio bytes")
    destination = tmp_path / "exports"

    with SessionLocal() as session:
        project = Project(
            id="proj_export_cancel",
            display_name="Export Cancel",
            source_path=str(source_path),
            imported_path=str(source_path),
        )
        source_artifact = Artifact(
            id="art_preview",
            project_id=project.id,
            type="preview_mix",
            format="wav",
            path=str(source_path),
            generated_by="test",
            can_delete=True,
            can_regenerate=True,
            metadata_json={},
        )
        session.add_all([project, source_artifact])
        session.commit()

        cancel_checks = iter([False, True])

        def should_cancel() -> bool:
            return next(cancel_checks, True)

        with pytest.raises(JobCancelledError):
            export_artifacts(
                session,
                project=project,
                artifact_ids=[source_artifact.id],
                output_format="wav",
                destination_path=str(destination),
                should_cancel=should_cancel,
            )

        export_count = session.scalar(
            select(Artifact).where(
                Artifact.project_id == project.id,
                Artifact.type == "export_mix",
            )
        )

    assert (destination / "source.wav").exists()
    assert export_count is None
