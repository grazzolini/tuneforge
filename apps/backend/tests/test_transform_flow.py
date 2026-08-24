from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import pytest
import soundfile as sf
from pydantic import ValidationError
from sqlalchemy import select

import app.services.transformations as transformations_service
from app.db import SessionLocal
from app.errors import JobCancelledError
from app.models import AnalysisResult, Artifact, ChordTimeline, Job, LyricsTranscript, Project
from app.schemas import ExportResultSchema
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


def _add_document_fixture(project_id: str) -> None:
    lyrics_segments = [
        {
            "start_seconds": 10.0,
            "end_seconds": 20.0,
            "text": "Hello brave world\r\nAgain",
            "words": [
                {"start_seconds": 10.0, "end_seconds": 11.0, "text": "Hello"},
                {"start_seconds": 12.0, "end_seconds": 13.0, "text": "brave"},
                {"start_seconds": 15.0, "end_seconds": 16.0, "text": "world"},
            ],
        },
        {"start_seconds": 30.0, "end_seconds": 35.0, "text": "Last line", "words": []},
    ]
    chord_segments = [
        {"start_seconds": 2.0, "end_seconds": 4.0, "label": "Am"},
        {"start_seconds": 10.5, "end_seconds": 11.0, "label": "A#", "display_label": "Bb"},
        {"start_seconds": 11.5, "end_seconds": 12.0, "label": "C"},
        {"start_seconds": 14.0, "end_seconds": 15.0, "label": "F"},
        {"start_seconds": 25.0, "end_seconds": 26.0, "label": "G"},
    ]
    with SessionLocal() as session:
        session.add_all(
            [
                LyricsTranscript(
                    project_id=project_id,
                    source_segments_json=[{"text": "stale source"}],
                    segments_json=lyrics_segments,
                ),
                ChordTimeline(
                    project_id=project_id,
                    source_segments_json=[{"label": "stale source"}],
                    segments_json=chord_segments,
                ),
            ]
        )
        session.commit()


def _document_context(artifact_id: str, mode: str = "auto") -> dict[str, str]:
    return {
        "document_audio_set_artifact_id": artifact_id,
        "document_chord_display_mode": mode,
    }


def test_preview_generation_cache_and_export(client, sample_audio_file: Path):
    project = import_project_without_jobs(sample_audio_file)

    analyze_job = client.post(
        f"/api/v1/projects/{project['id']}/analyze",
        json={"include_tempo": False, "force": False, "beat_backend": "built-in"},
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


@pytest.mark.parametrize("output_format", ["wav", "flac", "mp3", "m4a"])
def test_preview_mix_encodes_selected_durable_format(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
    output_format: str,
) -> None:
    source_path = tmp_path / f"preview-{output_format}.wav"
    source_path.write_bytes(sample_audio_file.read_bytes() + output_format.encode())
    project = import_project_without_jobs(source_path)

    response = client.post(
        f"/api/v1/projects/{project['id']}/preview",
        json={"transpose": {"semitones": 1}, "output_format": output_format},
    )
    assert response.status_code == 200
    final_job = wait_for_job(client, response.json()["job"]["id"])
    assert final_job["status"] == "completed"

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    preview = next(artifact for artifact in artifacts if artifact["type"] == "preview_mix")
    assert preview["format"] == output_format
    assert Path(preview["path"]).suffix == f".{output_format}"


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


def test_generated_document_request_validation_and_availability(client, tmp_path: Path):
    project_id, _artifact_id, _source = _create_export_fixture(
        tmp_path,
        project_id="proj_export_document_validation",
        artifact_id="art_export_document_validation",
    )
    destination = {"type": "single_file", "target": str(tmp_path / "lyrics.txt")}

    duplicate = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={"generated_document_ids": ["lyrics", "lyrics"], "destination": destination},
    )
    assert duplicate.status_code == 422

    missing_lyrics = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={"generated_document_ids": ["lyrics"], "destination": destination},
    )
    assert missing_lyrics.status_code == 422
    assert missing_lyrics.json()["error"]["code"] == "EXPORT_LYRICS_UNAVAILABLE"

    with SessionLocal() as session:
        session.add(
            LyricsTranscript(
                project_id=project_id,
                source_segments_json=[],
                segments_json=[{"text": "Lyrics"}],
            )
        )
        session.commit()
    missing_chords = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "generated_document_ids": ["lyrics_with_chords"],
            "destination": destination,
            **_document_context("art_export_document_validation"),
        },
    )
    assert missing_chords.status_code == 422
    assert missing_chords.json()["error"]["code"] == "EXPORT_CHORDS_UNAVAILABLE"

    legacy = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={"generated_document_ids": ["lyrics"], "destination_file_path": str(tmp_path / "legacy.txt")},
    )
    assert legacy.status_code == 422

    openapi = client.get("/openapi.json").json()
    schemas = openapi["components"]["schemas"]
    assert schemas["GeneratedExportDocumentId"] == {
        "type": "string",
        "enum": ["lyrics", "lyrics_with_chords"],
    }
    assert schemas["ExportRequest"]["anyOf"] == [
        {"$ref": "#/components/schemas/ExportRequestWithoutChordDocument"},
        {"$ref": "#/components/schemas/ExportRequestWithChordDocument"},
    ]
    without_chords = schemas["ExportRequestWithoutChordDocument"]
    with_chords = schemas["ExportRequestWithChordDocument"]
    assert "required" not in without_chords
    assert with_chords["required"] == [
        "generated_document_ids",
        "document_audio_set_artifact_id",
        "document_chord_display_mode",
    ]
    assert with_chords["properties"]["generated_document_ids"]["anyOf"][0]["prefixItems"] == [
        {"type": "string", "const": "lyrics_with_chords"}
    ]
    assert with_chords["properties"]["document_chord_display_mode"]["enum"] == [
        "auto",
        "sharps",
        "flats",
        "neutral",
        "dual",
    ]
    assert schemas["ExportResultItemSchema"]["anyOf"] == [
        {"$ref": "#/components/schemas/ExportAudioResultItemSchema"},
        {"$ref": "#/components/schemas/ExportGeneratedDocumentResultItemSchema"},
    ]
    export_responses = openapi["paths"]["/api/v1/projects/{project_id}/export"]["post"]["responses"]
    assert export_responses["422"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ErrorResponse"
    }

    result_item = {
        "output_name": "Export.txt",
        "status": "completed",
        "progress": 100,
    }
    for invalid_source in (
        {},
        {"artifact_id": "artifact", "generated_document_id": "lyrics"},
    ):
        with pytest.raises(ValidationError):
            ExportResultSchema.model_validate({
                "outcome": "completed",
                "total_count": 1,
                "completed_count": 1,
                "failed_count": 0,
                "items": [{**result_item, **invalid_source}],
            })


def test_document_only_export_uses_current_database_text_without_ffmpeg(
    client,
    monkeypatch,
    tmp_path: Path,
):
    project_id, _artifact_id, source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_documents_only",
        artifact_id="art_export_documents_only",
    )
    _add_document_fixture(project_id)
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        artifact = session.get(Artifact, "art_export_documents_only")
        assert project is not None
        assert artifact is not None
        project.source_key_override = "2:major"
        artifact.metadata_json = {"transpose": {"semitones": -1}}
        session.add(AnalysisResult(project_id=project_id, estimated_key="C major"))
        session.commit()
    source_path.with_name("lyrics.json").write_text('{"segments":[{"text":"stale snapshot"}]}')
    monkeypatch.setattr(
        "app.services.transformations.run_ffmpeg_transform",
        lambda *args, **kwargs: pytest.fail("Document-only export must not invoke FFmpeg."),
    )
    export_root = tmp_path / "documents-only"
    response = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "generated_document_ids": ["lyrics", "lyrics_with_chords"],
            **_document_context("art_export_documents_only"),
            "filename_base": "Current Song",
            "destination": {"type": "folder", "target": str(export_root)},
        },
    )
    assert response.status_code == 200
    final = wait_for_job(client, response.json()["job"]["id"])
    assert final["status"] == "completed"
    assert [item["generated_document_id"] for item in final["export_result"]["items"]] == [
        "lyrics",
        "lyrics_with_chords",
    ]
    assert all(item["artifact_id"] is None for item in final["export_result"]["items"])
    assert (export_root / "Current Song - Lyrics.txt").read_bytes() == (
        b"Hello brave world\nAgain\nLast line\n"
    )
    assert (export_root / "Current Song - Lyrics and Chords.txt").read_text() == (
        "Bbm\n\n"
        "B     Db    Gb\n"
        "Hello brave world\nAgain\n\n"
        "Ab\n\n"
        "Last line\n"
    )
    with SessionLocal() as session:
        job = session.get(Job, response.json()["job"]["id"])
        assert job is not None
        assert job.payload_json["document_chord_context"] == {
            "transpose_semitones": 1,
            "active_key": {"pitch_class": 1, "mode": "major"},
            "display_mode": "auto",
        }
    assert not list(export_root.glob("tuneforge-export-*"))

    with SessionLocal() as session:
        receipts = list(
            session.scalars(
                select(Artifact).where(
                    Artifact.project_id == project_id,
                    Artifact.type == "export_mix",
                )
            )
        )
        assert [receipt.format for receipt in receipts] == ["txt", "txt"]
        assert all("text" not in str(receipt.metadata_json).lower() for receipt in receipts)
        assert {receipt.metadata_json["generated_document_id"] for receipt in receipts} == {
            "lyrics",
            "lyrics_with_chords",
        }

    deleted = client.delete(f"/api/v1/projects/{project_id}")
    assert deleted.status_code == 200
    assert (export_root / "Current Song - Lyrics.txt").exists()
    assert (export_root / "Current Song - Lyrics and Chords.txt").exists()


def test_lyrics_with_chords_rejects_invalid_or_mixed_document_audio_sets(client, tmp_path: Path):
    project_id, artifact_id, source_path = _create_export_fixture(
        tmp_path,
        project_id="proj_export_document_audio_set",
        artifact_id="art_document_audio_set",
    )
    _add_document_fixture(project_id)
    other_path = tmp_path / "other-mix.wav"
    other_path.write_bytes(source_path.read_bytes())
    stem_path = tmp_path / "document-stem.wav"
    stem_path.write_bytes(source_path.read_bytes())
    with SessionLocal() as session:
        session.add_all(
            [
                Artifact(
                    id="art_other_document_set",
                    project_id=project_id,
                    type="preview_mix",
                    format="wav",
                    path=str(other_path),
                    generated_by="test",
                    metadata_json={},
                ),
                Artifact(
                    id="art_document_stem",
                    project_id=project_id,
                    type="vocal_stem",
                    format="wav",
                    path=str(stem_path),
                    generated_by="test",
                    metadata_json={"source_artifact_id": artifact_id},
                ),
            ]
        )
        session.commit()

    single_destination = {"type": "single_file", "target": str(tmp_path / "document.txt")}
    missing_context = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={"generated_document_ids": ["lyrics_with_chords"], "destination": single_destination},
    )
    assert missing_context.status_code == 422

    stem_context = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "generated_document_ids": ["lyrics_with_chords"],
            "destination": single_destination,
            **_document_context("art_document_stem"),
        },
    )
    assert stem_context.status_code == 400
    assert stem_context.json()["error"]["code"] == "INVALID_REQUEST"

    mixed_context = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [artifact_id],
            "generated_document_ids": ["lyrics_with_chords"],
            "destination": {"type": "zip", "target": str(tmp_path / "mixed.zip")},
            **_document_context("art_other_document_set"),
        },
    )
    assert mixed_context.status_code == 400
    assert mixed_context.json()["error"]["code"] == "EXPORT_AUDIO_SET_MISMATCH"


def test_mixed_export_zip_orders_audio_before_documents_and_sanitizes_metadata(client, tmp_path: Path):
    project_id, artifact_id, _source = _create_export_fixture(
        tmp_path,
        project_id="proj_export_mixed_documents",
        artifact_id="art_export_mixed_documents",
    )
    _add_document_fixture(project_id)
    archive_path = tmp_path / "Mixed Song - Export.zip"
    response = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "artifact_ids": [artifact_id],
            "generated_document_ids": ["lyrics_with_chords"],
            **_document_context(artifact_id),
            "output_format": "wav",
            "filename_base": "Mixed Song",
            "destination": {"type": "zip", "target": str(archive_path)},
        },
    )
    final = wait_for_job(client, response.json()["job"]["id"])
    assert final["status"] == "completed"
    assert [
        (item["artifact_id"], item["generated_document_id"])
        for item in final["export_result"]["items"]
    ] == [(artifact_id, None), (None, "lyrics_with_chords")]
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.namelist() == [
            "Mixed Song - Practice Mix 1.wav",
            "Mixed Song - Lyrics and Chords.txt",
        ]
    with SessionLocal() as session:
        receipt = session.get(Artifact, final["result_artifact_ids"][0])
        assert receipt is not None
        assert receipt.metadata_json == {
            "source_artifact_ids": [artifact_id],
            "generated_document_ids": ["lyrics_with_chords"],
            "output_names": [
                "Mixed Song - Practice Mix 1.wav",
                "Mixed Song - Lyrics and Chords.txt",
            ],
            "contained_format": "mixed",
        }


def test_document_export_cancellation_and_partial_cleanup(monkeypatch, tmp_path: Path):
    project_id, _artifact_id, _source = _create_export_fixture(
        tmp_path,
        project_id="proj_export_document_outcomes",
        artifact_id="art_export_document_outcomes",
    )
    _add_document_fixture(project_id)
    cancel_target = tmp_path / "cancelled.txt"
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        checks = iter([False, False, True])
        with pytest.raises(JobCancelledError):
            export_artifacts(
                session,
                project=project,
                artifact_ids=[],
                generated_document_ids=["lyrics"],
                lyrics_segments=list(project.lyrics.segments_json),
                chord_segments=list(project.chords.segments_json),
                output_format="wav",
                destination={"type": "single_file", "target": str(cancel_target)},
                output_names=["Cancelled - Lyrics.txt"],
                should_cancel=lambda: next(checks, True),
            )
        assert not cancel_target.exists()
        assert not list(cancel_target.parent.glob("tuneforge-export-*"))

    original_write = transformations_service._write_document_to_target

    def fail_second_document(**kwargs):
        if "Chords" in kwargs["target"].name:
            raise OSError("synthetic document failure")
        return original_write(**kwargs)

    monkeypatch.setattr(
        "app.services.transformations._write_document_to_target",
        fail_second_document,
    )
    folder = tmp_path / "partial-documents"
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        result = export_artifacts(
            session,
            project=project,
            artifact_ids=[],
            generated_document_ids=["lyrics", "lyrics_with_chords"],
            lyrics_segments=list(project.lyrics.segments_json),
            chord_segments=list(project.chords.segments_json),
            output_format="wav",
            destination={"type": "folder", "target": str(folder)},
            output_names=["Partial - Lyrics.txt", "Partial - Lyrics and Chords.txt"],
        )
        assert result.export_result["outcome"] == "partial"
        assert [item["status"] for item in result.export_result["items"]] == ["completed", "failed"]
    assert (folder / "Partial - Lyrics.txt").exists()
    assert not (folder / "Partial - Lyrics and Chords.txt").exists()
    assert not list(folder.glob("tuneforge-export-*"))


def test_document_only_job_failure_uses_generic_item_message(client, monkeypatch, tmp_path: Path):
    project_id, _artifact_id, _source = _create_export_fixture(
        tmp_path,
        project_id="proj_export_document_failure",
        artifact_id="art_export_document_failure",
    )
    _add_document_fixture(project_id)

    def fail_document_write(**_kwargs):
        raise OSError("synthetic document failure")

    monkeypatch.setattr(
        "app.services.transformations._write_document_to_target",
        fail_document_write,
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={
            "generated_document_ids": ["lyrics"],
            "filename_base": "Failed document",
            "destination": {
                "type": "single_file",
                "target": str(tmp_path / "Failed document - Lyrics.txt"),
            },
        },
    )
    assert response.status_code == 200
    final = wait_for_job(client, response.json()["job"]["id"])
    assert final["status"] == "failed"
    assert final["error_message"] == "No selected items could be exported."
    assert final["export_result"]["outcome"] == "failed"
    assert final["export_result"]["items"][0]["generated_document_id"] == "lyrics"


@pytest.mark.parametrize(
    ("display_mode", "expected"),
    [
        ("auto", "Db/Ab Db/Ab C/Gb N.C. mystery\n"),
        ("sharps", "C#/G# C#/G# C/F# N.C. mystery\n"),
        ("flats", "Db/Ab Db/Ab C/Gb N.C. mystery\n"),
        ("neutral", "C#/Ab C#/Ab C/F# N.C. mystery\n"),
        ("dual", "C#/G# / Db/Ab C#/G# / Db/Ab C/F# / C/Gb N.C. mystery\n"),
    ],
)
def test_lyrics_with_chords_gap_line_matches_playback_spelling_modes(
    display_mode: str,
    expected: str,
):
    assert transformations_service._lyrics_with_chords_text(
        [],
        [
            {"start_seconds": 0, "label": "C/G"},
            {"start_seconds": 0.25, "label": "C/G"},
            {
                "start_seconds": 0.5,
                "label": "B/F",
                "pitch_class": 11,
                "quality": "major",
                "bass_pitch_class": 5,
            },
            {"start_seconds": 1, "label": "N.C."},
            {"start_seconds": 2, "label": "mystery"},
        ],
        {
            "transpose_semitones": 1,
            "active_key": {"pitch_class": 1, "mode": "major"},
            "display_mode": display_mode,
        },
    ) == expected
