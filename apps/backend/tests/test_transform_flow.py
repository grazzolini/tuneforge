from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import pytest
import soundfile as sf
from sqlalchemy import select

from app.db import SessionLocal
from app.errors import JobCancelledError
from app.models import Artifact, Project
from app.services.transformations import export_artifacts

from .conftest import import_project_without_jobs, wait_for_job


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


def _create_export_fixture(
    tmp_path: Path,
    *,
    project_id: str,
    artifact_id: str,
    source_bytes: bytes = b"source audio bytes",
) -> tuple[str, str, Path]:
    source_path = tmp_path / f"{artifact_id}.wav"
    source_path.write_bytes(source_bytes)
    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Export Fixture",
            source_path=str(source_path),
            imported_path=str(source_path),
        )
        source_artifact = Artifact(
            id=artifact_id,
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
    return project_id, artifact_id, source_path


def test_preview_generation_cache_and_export(client, sample_audio_file: Path):
    project = import_project_without_jobs(sample_audio_file)

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


def test_export_uses_exact_destination_file_path(client, tmp_path: Path):
    project_id, artifact_id, source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_exact_destination",
        artifact_id="art_export_exact_destination",
    )
    selected_path = tmp_path / "exports" / "selected-name.custom"

    export_job = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [artifact_id],
            "mixdown_mode": "copy",
            "output_format": "wav",
            "destination_file_path": str(selected_path),
        },
    ).json()["job"]

    export_final = wait_for_job(client, export_job["id"])
    assert export_final["status"] == "completed"
    assert selected_path.read_bytes() == source_path.read_bytes()
    assert not (selected_path.parent / f"{source_path.stem}.wav").exists()

    artifacts = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    exported = next(artifact for artifact in artifacts if artifact["type"] == "export_mix")
    assert Path(exported["path"]) == selected_path.resolve()


def test_export_rejects_existing_explicit_destination_without_overwrite(client, tmp_path: Path):
    project_id, artifact_id, _source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_conflict",
        artifact_id="art_export_conflict",
        source_bytes=b"new bytes",
    )
    selected_path = tmp_path / "exports" / "selected.wav"
    selected_path.parent.mkdir(parents=True)
    selected_path.write_bytes(b"existing bytes")

    response = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [artifact_id],
            "mixdown_mode": "copy",
            "output_format": "wav",
            "destination_file_path": str(selected_path),
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EXPORT_DESTINATION_EXISTS"
    assert selected_path.read_bytes() == b"existing bytes"


def test_export_overwrites_existing_explicit_destination_when_requested(client, tmp_path: Path):
    project_id, artifact_id, _source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_overwrite",
        artifact_id="art_export_overwrite",
        source_bytes=b"replacement bytes",
    )
    selected_path = tmp_path / "exports" / "selected.wav"
    selected_path.parent.mkdir(parents=True)
    selected_path.write_bytes(b"existing bytes")

    export_job = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [artifact_id],
            "mixdown_mode": "copy",
            "output_format": "wav",
            "destination_file_path": str(selected_path),
            "overwrite_existing": True,
        },
    ).json()["job"]

    export_final = wait_for_job(client, export_job["id"])
    assert export_final["status"] == "completed"
    assert selected_path.read_bytes() == b"replacement bytes"


def test_export_batch_preserves_order_and_rejects_cross_audio_set(client, tmp_path: Path):
    project_id, source_id, source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_batch",
        artifact_id="art_mix_one",
    )
    stem_path = tmp_path / "vocals.wav"
    stem_path.write_bytes(source_path.read_bytes())
    other_mix_path = tmp_path / "other.wav"
    other_mix_path.write_bytes(source_path.read_bytes())
    with SessionLocal() as session:
        session.add_all(
            [
                Artifact(
                    id="art_vocals",
                    project_id=project_id,
                    type="vocal_stem",
                    format="wav",
                    path=str(stem_path),
                    generated_by="test",
                    metadata_json={"source_artifact_id": source_id},
                ),
                Artifact(
                    id="art_mix_two",
                    project_id=project_id,
                    type="preview_mix",
                    format="wav",
                    path=str(other_mix_path),
                    generated_by="test",
                    metadata_json={},
                ),
            ]
        )
        session.commit()

    export_root = tmp_path / "batch"
    created = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [source_id, "art_vocals"],
            "output_format": "wav",
            "filename_base": "Practice / Export",
            "destination": {"type": "folder", "target": str(export_root), "overwrite": False},
        },
    )
    assert created.status_code == 200
    final = wait_for_job(client, created.json()["job"]["id"])
    assert final["status"] == "completed"
    assert final["export_result"]["outcome"] == "completed"
    assert [item["artifact_id"] for item in final["export_result"]["items"]] == [source_id, "art_vocals"]
    assert sorted(path.name for path in export_root.iterdir()) == [
        "Practice - Export - Practice Mix 1 - Vocals.wav",
        "Practice - Export - Practice Mix 1.wav",
    ]

    rejected = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [source_id, "art_mix_two"],
            "output_format": "wav",
            "filename_base": "Rejected",
            "destination": {"type": "folder", "target": str(tmp_path / "rejected")},
        },
    )
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "EXPORT_AUDIO_SET_MISMATCH"


def test_export_capabilities_advertise_destination_contract(client):
    response = client.get("/api/v1/export-capabilities")
    assert response.status_code == 200
    capabilities = response.json()["capabilities"]
    assert capabilities["platform"] == "desktop"
    assert capabilities["max_artifact_count"] is None
    assert [destination["id"] for destination in capabilities["destinations"]] == [
        "single_file",
        "folder",
        "zip",
    ]


def test_export_zip_publishes_one_archive_result(client, tmp_path: Path):
    project_id, mix_id, source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_zip",
        artifact_id="art_zip_mix",
    )
    vocal_path = tmp_path / "zip-vocals.wav"
    vocal_path.write_bytes(source_path.read_bytes())
    with SessionLocal() as session:
        session.add(
            Artifact(
                id="art_zip_vocals",
                project_id=project_id,
                type="vocal_stem",
                format="wav",
                path=str(vocal_path),
                generated_by="test",
                metadata_json={"source_artifact_id": mix_id},
            )
        )
        session.commit()

    archive_path = tmp_path / "Practice Mix 1.zip"
    job = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [mix_id, "art_zip_vocals"],
            "output_format": "wav",
            "filename_base": "Zip Test",
            "destination": {"type": "zip", "target": str(archive_path)},
        },
    ).json()["job"]
    final = wait_for_job(client, job["id"])
    assert final["status"] == "completed"
    assert len(final["result_artifact_ids"]) == 1
    assert {item["result_artifact_id"] for item in final["export_result"]["items"]} == {
        final["result_artifact_ids"][0]
    }
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.namelist() == [
            "Zip Test - Practice Mix 1.wav",
            "Zip Test - Practice Mix 1 - Vocals.wav",
        ]


def test_preview_mix_creation_does_not_auto_queue_stems(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    monkeypatch.setattr("app.services.stems.separate_sources", _fake_separate_sources)

    project = import_project_without_jobs(sample_audio_file)

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
    destination = tmp_path / "exports" / "selected.wav"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"existing audio bytes")

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
                destination={"type": "single_file", "target": str(destination), "overwrite": True},
                output_names=[destination.name],
                should_cancel=should_cancel,
            )

        export_count = session.scalar(
            select(Artifact).where(
                Artifact.project_id == project.id,
                Artifact.type == "export_mix",
            )
        )

    assert destination.read_bytes() == b"existing audio bytes"
    assert not list(destination.parent.glob("tuneforge-export-*"))
    assert export_count is None


def test_export_rechecks_collision_immediately_before_publish(monkeypatch, tmp_path: Path):
    project_id, artifact_id, _source = _create_export_fixture(
        tmp_path,
        project_id="proj_export_collision_race",
        artifact_id="art_export_collision_race",
    )
    destination = tmp_path / "exports" / "selected.wav"
    destination.parent.mkdir(parents=True)
    original_copy = shutil.copy2

    def copy_then_race(source: Path, target: Path):
        copied = original_copy(source, target)
        destination.write_bytes(b"created by another process")
        return copied

    monkeypatch.setattr("app.services.transformations.shutil.copy2", copy_then_race)

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        result = export_artifacts(
            session,
            project=project,
            artifact_ids=[artifact_id],
            output_format="wav",
            destination={"type": "single_file", "target": str(destination), "overwrite": False},
            output_names=[destination.name],
        )
        export_count = session.scalar(
            select(Artifact).where(
                Artifact.project_id == project_id,
                Artifact.type == "export_mix",
            )
        )

    assert destination.read_bytes() == b"created by another process"
    assert result.export_result["outcome"] == "failed"
    assert result.export_result["items"][0]["status"] == "failed"
    assert export_count is None
