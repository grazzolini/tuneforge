from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.errors import AppError
from app.models import AnalysisResult, Artifact, Job, Project
from app.services import analysis as analysis_service
from app.services.artifacts import register_artifact
from app.services.paths import ensure_project_dirs
from app.services.stem_signal_metadata import STEM_SIGNAL_METADATA_KEY, STEM_SIGNAL_METADATA_VERSION

from .conftest import wait_for_job


def test_analysis_job_persists_results(client, sample_rhythmic_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_rhythmic_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    import_analyze_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "analyze"
    )
    import_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, import_analyze_job["id"], timeout=90.0)["status"] == "completed"
    assert wait_for_job(client, import_chord_job["id"], timeout=90.0)["status"] == "completed"

    job = client.post(
        f"/api/v1/projects/{project['id']}/analyze",
        json={"include_tempo": False, "force": False},
    ).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["beat_backend"] == "built-in"
    assert final_job["beat_input"] == "source"
    assert final_job["runtime_device"] == "cpu"
    assert final_job["duration_seconds"] is not None

    analysis = client.get(f"/api/v1/projects/{project['id']}/analysis").json()["analysis"]
    assert analysis["estimated_reference_hz"] is not None
    assert analysis["tuning_offset_cents"] is not None
    assert analysis["estimated_key"] is not None
    assert analysis["timing"] is not None
    assert analysis["analysis_version"] == "v3"
    assert analysis["timing"]["beats_per_bar"] == 4
    assert analysis["timing"]["beats"][0]["beat_in_bar"] == 1

    artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    analysis_artifacts = [artifact for artifact in artifacts if artifact["type"] == "analysis_json"]
    assert len(analysis_artifacts) == 1
    assert analysis["source_artifact_id"] == source_artifact["id"]
    assert analysis_artifacts[0]["metadata"]["source_artifact_id"] == source_artifact["id"]
    analysis_payload = json.loads(Path(analysis_artifacts[0]["path"]).read_text(encoding="utf-8"))
    assert analysis_payload["timing"] == analysis["timing"]

    refresh_job = client.post(
        f"/api/v1/projects/{project['id']}/analyze",
        json={"include_tempo": False, "force": False},
    ).json()["job"]
    assert wait_for_job(client, refresh_job["id"])["status"] == "completed"

    refreshed_artifacts = client.get(f"/api/v1/projects/{project['id']}/artifacts").json()["artifacts"]
    assert len([artifact for artifact in refreshed_artifacts if artifact["type"] == "analysis_json"]) == 1


def test_analysis_passes_latest_source_drums_and_bass_stems_only(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
    monkeypatch,
):
    assert client is not None
    project_id = "analysis_source_stem_project"
    source_drums_path = tmp_path / "source-drums.wav"
    source_bass_path = tmp_path / "source-bass.wav"
    preview_drums_path = tmp_path / "preview-drums.wav"
    preview_bass_path = tmp_path / "preview-bass.wav"
    for path in (
        source_drums_path,
        source_bass_path,
        preview_drums_path,
        preview_bass_path,
    ):
        path.write_bytes(path.name.encode("utf-8"))

    _seed_project_with_source_stems(
        project_id=project_id,
        source_path=sample_audio_file,
        source_drums_path=source_drums_path,
        source_bass_path=source_bass_path,
        preview_drums_path=preview_drums_path,
        preview_bass_path=preview_bass_path,
    )

    captured: dict[str, object] = {}

    def fake_analyze_track(track_path: Path, *, source_stem_paths: tuple[Path, ...] | None = None):
        captured["track_path"] = track_path
        captured["source_stem_paths"] = source_stem_paths
        return {
            "estimated_key": "C major",
            "key_confidence": 0.8,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 120.0,
            "timing": _timing_payload(),
        }

    monkeypatch.setattr(analysis_service, "analyze_track", fake_analyze_track)

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        analysis = analysis_service.analyze_project(session, project)
        session.commit()

    assert analysis.source_artifact_id == "art_analysis_source"
    assert captured["track_path"] == sample_audio_file
    assert captured["source_stem_paths"] == (source_drums_path, source_bass_path)


def test_reanalysis_updates_analysis_artifact_sync_metadata(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
    monkeypatch,
):
    del client
    project_id = "analysis_metadata_project"
    source_drums_path = tmp_path / "metadata-source-drums.wav"
    source_bass_path = tmp_path / "metadata-source-bass.wav"
    preview_drums_path = tmp_path / "metadata-preview-drums.wav"
    preview_bass_path = tmp_path / "metadata-preview-bass.wav"
    for path in (
        source_drums_path,
        source_bass_path,
        preview_drums_path,
        preview_bass_path,
    ):
        path.write_bytes(path.name.encode("utf-8"))

    _seed_project_with_source_stems(
        project_id=project_id,
        source_path=sample_audio_file,
        source_drums_path=source_drums_path,
        source_bass_path=source_bass_path,
        preview_drums_path=preview_drums_path,
        preview_bass_path=preview_bass_path,
    )

    timestamps = iter(
        [
            "2026-01-02T03:04:05+00:00",
            "2026-01-03T03:04:05+00:00",
        ]
    )
    monkeypatch.setattr(analysis_service, "_analysis_generated_at_iso", lambda: next(timestamps))

    def fake_analyze_track(track_path: Path, *, source_stem_paths: tuple[Path, ...] | None = None):
        assert track_path == sample_audio_file
        assert source_stem_paths == (source_drums_path, source_bass_path)
        return {
            "estimated_key": "C major",
            "key_confidence": 0.8,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 120.0,
            "timing": _timing_payload(source="built-in"),
        }

    def fake_beat_this(
        track_path: Path,
        *,
        source_stem_paths: tuple[Path, ...] | None = None,
        duration_seconds: float | None = None,
    ):
        assert track_path == sample_audio_file
        assert source_stem_paths is None
        assert duration_seconds == 4.0
        return {
            "estimated_key": "D minor",
            "key_confidence": 0.7,
            "estimated_reference_hz": 441.0,
            "tuning_offset_cents": 1.5,
            "tempo_bpm": 90.0,
            "timing": _timing_payload(source="beat-this"),
        }

    monkeypatch.setattr(analysis_service, "analyze_track", fake_analyze_track)
    monkeypatch.setattr(analysis_service, "beat_this_dependency_status", lambda: (True, None))
    monkeypatch.setattr(analysis_service, "analyze_track_with_beat_this", fake_beat_this)

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        analysis_service.analyze_project(session, project)
        first_artifact = _analysis_artifact(session, project_id)
        source_artifact = session.get(Artifact, "art_analysis_source")
        drums_artifact = session.get(Artifact, "art_source_drums")
        bass_artifact = session.get(Artifact, "art_source_bass")
        assert source_artifact is not None
        assert drums_artifact is not None
        assert bass_artifact is not None
        expected_source_sha = source_artifact.content_sha256
        expected_stem_sha256s = [drums_artifact.content_sha256, bass_artifact.content_sha256]
        first_artifact_id = first_artifact.id
        first_content_sha256 = first_artifact.content_sha256
        session.commit()

    expected_common_metadata = {
        "analysis_version": "v3",
        "source_artifact_id": "art_analysis_source",
        "source_artifact_sha256": expected_source_sha,
    }
    expected_built_in_metadata = {
        **expected_common_metadata,
        "source_stem_artifact_ids": ["art_source_drums", "art_source_bass"],
        "source_stem_content_sha256s": expected_stem_sha256s,
    }
    expected_beat_this_metadata = {
        **expected_common_metadata,
        "source_stem_artifact_ids": [],
        "source_stem_content_sha256s": [],
    }
    first_payload = _analysis_payload(first_artifact)
    assert first_artifact.metadata_json == {
        "analysis_generated_at": "2026-01-02T03:04:05+00:00",
        "analysis_backend": "built-in",
        **expected_built_in_metadata,
    }
    assert {key: first_payload[key] for key in first_artifact.metadata_json} == first_artifact.metadata_json

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        analysis_service.analyze_project(session, project, beat_backend="beat-this")
        second_artifact = _analysis_artifact(session, project_id)
        session.commit()

    second_payload = _analysis_payload(second_artifact)
    assert second_artifact.id == first_artifact_id
    assert second_artifact.content_sha256 != first_content_sha256
    assert second_artifact.metadata_json == {
        "analysis_generated_at": "2026-01-03T03:04:05+00:00",
        "analysis_backend": "beat-this",
        **expected_beat_this_metadata,
    }
    assert {key: second_payload[key] for key in second_artifact.metadata_json} == second_artifact.metadata_json
    assert second_payload["estimated_key"] == "D minor"


def test_project_import_carries_beat_backend_to_initial_analysis_job(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    enqueued: list[str] = []
    monkeypatch.setattr(client.app.state.job_runner, "enqueue", enqueued.append)

    response = client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_audio_file),
            "copy_into_project": False,
            "beat_backend": "beat-this",
        },
    )

    assert response.status_code == 200
    project_id = response.json()["project"]["id"]
    with SessionLocal() as session:
        jobs = list(session.scalars(select(Job).where(Job.project_id == project_id)))
    analyze_job = next(job for job in jobs if job.type == "analyze")
    assert analyze_job.payload_json["beat_backend"] == "beat-this"
    assert analyze_job.payload_json["beat_input"] == "source"
    assert analyze_job.id in enqueued


def test_analysis_uses_beat_this_backend_when_requested(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    del client
    project_id = "analysis_beat_this_project"
    _seed_analysis_project(project_id, sample_audio_file)
    captured: dict[str, object] = {}

    def fake_analyze_track_with_beat_this(
        track_path: Path,
        *,
        source_stem_paths: tuple[Path, ...] | None = None,
        duration_seconds: float | None = None,
    ):
        captured["track_path"] = track_path
        captured["source_stem_paths"] = source_stem_paths
        captured["duration_seconds"] = duration_seconds
        return {
            "estimated_key": "D minor",
            "key_confidence": 0.7,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 90.0,
            "timing": _timing_payload(source="beat-this"),
        }

    monkeypatch.setattr(analysis_service, "beat_this_dependency_status", lambda: (True, None))
    monkeypatch.setattr(analysis_service, "analyze_track_with_beat_this", fake_analyze_track_with_beat_this)

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        analysis = analysis_service.analyze_project(session, project, beat_backend="beat-this")
        session.commit()

    assert captured == {
        "track_path": sample_audio_file,
        "source_stem_paths": None,
        "duration_seconds": 4.0,
    }
    assert analysis.estimated_key == "D minor"
    assert analysis.tempo_bpm == 90.0
    assert analysis.timing_json["source"] == "beat-this"


def test_analysis_beat_this_uses_source_only_even_when_source_stems_have_signal_metadata(
    client,
    sample_audio_file: Path,
    tmp_path: Path,
    monkeypatch,
):
    del client
    project_id = "analysis_beat_this_source_only_project"
    source_drums_path = tmp_path / "beat-this-source-drums.wav"
    source_bass_path = tmp_path / "beat-this-source-bass.wav"
    preview_drums_path = tmp_path / "beat-this-preview-drums.wav"
    preview_bass_path = tmp_path / "beat-this-preview-bass.wav"
    _write_paths(source_drums_path, source_bass_path, preview_drums_path, preview_bass_path)
    _seed_project_with_source_stems(
        project_id=project_id,
        source_path=sample_audio_file,
        source_drums_path=source_drums_path,
        source_bass_path=source_bass_path,
        preview_drums_path=preview_drums_path,
        preview_bass_path=preview_bass_path,
        source_drums_metadata=_stem_signal_metadata(has_signal=True),
        source_bass_metadata=_stem_signal_metadata(has_signal=True),
    )
    _forbid_analysis_signal_inspection(monkeypatch)
    monkeypatch.setattr(analysis_service, "beat_this_dependency_status", lambda: (True, None))
    captured: dict[str, object] = {}

    def fake_analyze_track_with_beat_this(
        track_path: Path,
        *,
        source_stem_paths: tuple[Path, ...] | None = None,
        duration_seconds: float | None = None,
    ):
        captured["track_path"] = track_path
        captured["source_stem_paths"] = source_stem_paths
        captured["duration_seconds"] = duration_seconds
        return {
            "estimated_key": "D minor",
            "key_confidence": 0.7,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 90.0,
            "timing": _timing_payload(source="beat-this"),
        }

    monkeypatch.setattr(analysis_service, "analyze_track_with_beat_this", fake_analyze_track_with_beat_this)

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        analysis_service.analyze_project(session, project, beat_backend="beat-this")
        session.commit()

    assert captured == {
        "track_path": sample_audio_file,
        "source_stem_paths": None,
        "duration_seconds": 4.0,
    }


def test_analysis_beat_this_backend_fails_when_dependency_is_missing(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    del client
    project_id = "analysis_beat_this_unavailable_project"
    _seed_analysis_project(project_id, sample_audio_file)
    monkeypatch.setattr(analysis_service, "beat_this_dependency_status", lambda: (False, "beat-this is not installed"))

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        with pytest.raises(AppError, match="beat-this is not installed"):
            analysis_service.analyze_project(session, project, beat_backend="beat-this")


def test_analysis_beat_this_backend_reports_runtime_failure(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    del client
    project_id = "analysis_beat_this_runtime_failure_project"
    _seed_analysis_project(project_id, sample_audio_file)
    monkeypatch.setattr(analysis_service, "beat_this_dependency_status", lambda: (True, None))

    def fail_beat_this_analysis(*_args, **_kwargs):
        raise analysis_service.BeatThisRuntimeError("Advanced Beat Analysis could not load the beat-this model.")

    monkeypatch.setattr(analysis_service, "analyze_track_with_beat_this", fail_beat_this_analysis)

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        with pytest.raises(AppError) as exc_info:
            analysis_service.analyze_project(session, project, beat_backend="beat-this")

    assert exc_info.value.code == "ADVANCED_BEAT_BACKEND_FAILED"
    assert "could not load" in exc_info.value.message


def test_analysis_timing_patch_updates_current_grid_and_reanalysis_overwrites(
    client,
    sample_audio_file: Path,
    monkeypatch,
):
    project_id = "analysis_timing_patch_project"
    _seed_analysis_project(project_id, sample_audio_file)

    response = client.patch(
        f"/api/v1/projects/{project_id}/analysis/timing",
        json={"action": "set_bar_1_beat_1", "playhead_seconds": 1.1},
    )

    assert response.status_code == 200
    timing = response.json()["analysis"]["timing"]
    assert timing["source"] == "user_corrected"
    assert timing["beats_per_bar"] == 4
    assert timing["beats"][2] == {
        "index": 2,
        "seconds": 1.0,
        "bar_index": 1,
        "beat_in_bar": 1,
    }
    assert timing["beats"][0]["bar_index"] == 0
    assert timing["beats"][0]["beat_in_bar"] == 3
    _assert_timing_bar_indexes_are_nonnegative(timing)

    shifted_response = client.patch(
        f"/api/v1/projects/{project_id}/analysis/timing",
        json={"action": "shift_right"},
    )

    assert shifted_response.status_code == 200
    shifted_timing = shifted_response.json()["analysis"]["timing"]
    assert shifted_timing["source"] == "user_corrected"
    assert shifted_timing["beats"][3]["bar_index"] == 1
    assert shifted_timing["beats"][3]["beat_in_bar"] == 1
    _assert_timing_bar_indexes_are_nonnegative(shifted_timing)

    meter_response = client.patch(
        f"/api/v1/projects/{project_id}/analysis/timing",
        json={"action": "set_meter", "beats_per_bar": 6},
    )

    assert meter_response.status_code == 200
    meter_timing = meter_response.json()["analysis"]["timing"]
    assert meter_timing["source"] == "user_corrected"
    assert meter_timing["beats_per_bar"] == 6
    assert meter_timing["meter"] == "6/8"
    assert meter_timing["beats"][3]["bar_index"] == 1
    assert meter_timing["beats"][3]["beat_in_bar"] == 1
    _assert_timing_bar_indexes_are_nonnegative(meter_timing)

    artifact = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"][0]
    artifact_payload = json.loads(Path(artifact["path"]).read_text(encoding="utf-8"))
    assert artifact_payload["timing"] == meter_timing

    monkeypatch.setattr(
        analysis_service,
        "analyze_track",
        lambda _path: {
            "estimated_key": "G major",
            "key_confidence": 0.9,
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
            "tempo_bpm": 120.0,
            "timing": _timing_payload(source="detected"),
        },
    )
    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        analysis_service.analyze_project(session, project)
        session.commit()

    refreshed = client.get(f"/api/v1/projects/{project_id}/analysis").json()["analysis"]["timing"]
    assert refreshed["source"] == "detected"
    assert refreshed["beats_per_bar"] == 4


def test_analysis_timing_shift_left_from_first_visible_downbeat_creates_pickup(
    client,
    sample_audio_file: Path,
):
    project_id = "analysis_timing_shift_left_boundary_project"
    _seed_analysis_project(
        project_id,
        sample_audio_file,
        timing=_first_visible_downbeat_timing_payload(),
    )

    response = client.patch(
        f"/api/v1/projects/{project_id}/analysis/timing",
        json={"action": "shift_left"},
    )

    assert response.status_code == 200
    timing = response.json()["analysis"]["timing"]
    assert timing["source"] == "user_corrected"
    assert timing["beats"][0] == {
        "index": 0,
        "seconds": 0.0,
        "bar_index": 0,
        "beat_in_bar": 2,
    }
    assert timing["beats"][1]["bar_index"] == 0
    assert timing["beats"][1]["beat_in_bar"] == 3
    assert timing["beats"][2]["bar_index"] == 0
    assert timing["beats"][2]["beat_in_bar"] == 4
    assert timing["beats"][3]["bar_index"] == 1
    assert timing["beats"][3]["beat_in_bar"] == 1
    _assert_timing_bar_indexes_are_nonnegative(timing)

    restored_response = client.patch(
        f"/api/v1/projects/{project_id}/analysis/timing",
        json={"action": "shift_right"},
    )

    assert restored_response.status_code == 200
    restored_timing = restored_response.json()["analysis"]["timing"]
    original_timing = _first_visible_downbeat_timing_payload()
    assert restored_timing["beats"] == original_timing["beats"]
    assert restored_timing["bars"] == original_timing["bars"]
    _assert_timing_bar_indexes_are_nonnegative(restored_timing)


def test_analysis_timing_patch_rejects_unsupported_meter(
    client,
    sample_audio_file: Path,
):
    project_id = "analysis_timing_invalid_meter_project"
    _seed_analysis_project(project_id, sample_audio_file)

    response = client.patch(
        f"/api/v1/projects/{project_id}/analysis/timing",
        json={"action": "set_meter", "beats_per_bar": 5},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    persisted_timing = client.get(f"/api/v1/projects/{project_id}/analysis").json()["analysis"]["timing"]
    assert persisted_timing["beats_per_bar"] == 4

    with SessionLocal() as session:
        project = session.get(Project, project_id)
        assert project is not None
        with pytest.raises(AppError, match="beats_per_bar must be one of 3, 4, or 6"):
            analysis_service.correct_analysis_timing(
                session,
                project=project,
                action="set_meter",
                beats_per_bar=5,
            )


def _seed_analysis_project(project_id: str, source_path: Path, *, timing: dict | None = None) -> None:
    ensure_project_dirs(project_id)
    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Timing Patch Project",
            source_path=str(source_path),
            imported_path=str(source_path),
            duration_seconds=4.0,
        )
        analysis = AnalysisResult(
            project_id=project_id,
            estimated_key="C major",
            key_confidence=0.8,
            estimated_reference_hz=440.0,
            tuning_offset_cents=0.0,
            tempo_bpm=120.0,
            timing_json=timing or _timing_payload(),
            analysis_version="v3",
        )
        session.add_all([project, analysis])
        session.commit()


def _seed_project_with_source_stems(
    *,
    project_id: str,
    source_path: Path,
    source_drums_path: Path,
    source_bass_path: Path,
    preview_drums_path: Path,
    preview_bass_path: Path,
    source_drums_metadata: dict[str, Any] | None = None,
    source_bass_metadata: dict[str, Any] | None = None,
) -> None:
    ensure_project_dirs(project_id)
    created_at = datetime(2026, 1, 1, tzinfo=UTC)
    with SessionLocal() as session:
        project = Project(
            id=project_id,
            display_name="Source Stem Analysis Project",
            source_path=str(source_path),
            imported_path=str(source_path),
            duration_seconds=4.0,
        )
        session.add(project)
        source_artifact = register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_analysis_source",
            artifact_type="source_audio",
            artifact_format="wav",
            path=source_path,
            metadata={},
            generated_by="import",
            can_delete=False,
            can_regenerate=False,
            created_at=created_at,
        )
        preview_artifact = register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_analysis_preview",
            artifact_type="preview_mix",
            artifact_format="wav",
            path=source_path,
            metadata={"source_artifact_id": source_artifact.id},
            generated_by="ffmpeg",
            created_at=created_at + timedelta(seconds=1),
        )
        register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_source_drums",
            artifact_type="drums_stem",
            artifact_format="wav",
            path=source_drums_path,
            metadata=_source_stem_artifact_metadata(source_artifact.id, source_drums_metadata),
            generated_by="demucs",
            created_at=created_at + timedelta(seconds=2),
        )
        register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_source_bass",
            artifact_type="bass_stem",
            artifact_format="wav",
            path=source_bass_path,
            metadata=_source_stem_artifact_metadata(source_artifact.id, source_bass_metadata),
            generated_by="demucs",
            created_at=created_at + timedelta(seconds=3),
        )
        register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_preview_drums",
            artifact_type="drums_stem",
            artifact_format="wav",
            path=preview_drums_path,
            metadata={"source_artifact_id": preview_artifact.id, "source_artifact_type": "preview_mix"},
            generated_by="demucs",
            created_at=created_at + timedelta(seconds=4),
        )
        register_artifact(
            session,
            project_id=project_id,
            artifact_id="art_preview_bass",
            artifact_type="bass_stem",
            artifact_format="wav",
            path=preview_bass_path,
            metadata={"source_artifact_id": preview_artifact.id, "source_artifact_type": "preview_mix"},
            generated_by="demucs",
            created_at=created_at + timedelta(seconds=5),
        )
        session.commit()


def _source_stem_artifact_metadata(
    source_artifact_id: str,
    extra_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = {
        "source_artifact_id": source_artifact_id,
        "source_artifact_type": "source_audio",
    }
    if extra_metadata is not None:
        metadata.update(_json_clone(extra_metadata))
    return metadata


def _stem_signal_metadata(
    *,
    has_signal: bool,
    version: int = STEM_SIGNAL_METADATA_VERSION,
) -> dict[str, Any]:
    peak = 0.4 if has_signal else 0.0
    rms = 0.2 if has_signal else 0.0
    active_duration = 2.0 if has_signal else 0.0
    return {
        STEM_SIGNAL_METADATA_KEY: {
            "version": version,
            "has_signal": has_signal,
            "peak": peak,
            "rms": rms,
            "active_duration_seconds": active_duration,
            "inspected_duration_seconds": 4.0,
            "active_ratio": active_duration / 4.0,
            "sample_rate": 44_100,
            "channels": 2,
            "thresholds": {
                "peak": 0.001,
                "rms": 0.0005,
                "active_duration_seconds": 0.2,
                "window_seconds": 0.05,
            },
        }
    }


def _write_paths(*paths: Path) -> None:
    for path in paths:
        path.write_bytes(path.name.encode("utf-8"))


def _json_clone(value: dict[str, Any]) -> dict[str, Any]:
    cloned = json.loads(json.dumps(value))
    assert isinstance(cloned, dict)
    return cloned


def _forbid_analysis_signal_inspection(monkeypatch) -> None:
    def raise_if_called(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("analysis flow must only read persisted stem_signal metadata")

    monkeypatch.setattr("app.services.stem_signal_metadata.build_stem_signal_metadata", raise_if_called)
    monkeypatch.setattr("app.services.stem_signal_metadata.inspect_audio_signal_file", raise_if_called)
    monkeypatch.setattr("app.engines.audio_signal.inspect_audio_signal_file", raise_if_called)
    monkeypatch.setattr("app.engines.stem_signal.inspect_stem_signal", raise_if_called)


def _assert_timing_bar_indexes_are_nonnegative(timing: dict) -> None:
    assert all(beat["bar_index"] >= 0 for beat in timing["beats"])
    assert all(bar["index"] >= 0 for bar in timing["bars"])


def _analysis_artifact(session, project_id: str) -> Artifact:
    artifact = session.scalar(
        select(Artifact).where(
            Artifact.project_id == project_id,
            Artifact.type == "analysis_json",
        )
    )
    assert artifact is not None
    return artifact


def _analysis_payload(artifact: Artifact) -> dict:
    payload = json.loads(Path(artifact.path).read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def _timing_payload(*, source: str = "detected") -> dict:
    return {
        "beats_per_bar": 4,
        "source": source,
        "beats": [
            {"index": 0, "seconds": 0.0, "bar_index": 0, "beat_in_bar": 1},
            {"index": 1, "seconds": 0.5, "bar_index": 0, "beat_in_bar": 2},
            {"index": 2, "seconds": 1.0, "bar_index": 0, "beat_in_bar": 3},
            {"index": 3, "seconds": 1.5, "bar_index": 0, "beat_in_bar": 4},
            {"index": 4, "seconds": 2.0, "bar_index": 1, "beat_in_bar": 1},
            {"index": 5, "seconds": 2.5, "bar_index": 1, "beat_in_bar": 2},
        ],
        "bars": [
            {"index": 0, "start_seconds": 0.0, "end_seconds": 2.0},
            {"index": 1, "start_seconds": 2.0, "end_seconds": 4.0},
        ],
    }


def _first_visible_downbeat_timing_payload() -> dict:
    return {
        "beats_per_bar": 4,
        "source": "user_corrected",
        "meter": "4/4",
        "meter_confidence": 1.0,
        "downbeat_source": "user",
        "downbeat_confidence": 1.0,
        "beats": [
            {"index": 0, "seconds": 0.0, "bar_index": 1, "beat_in_bar": 1},
            {"index": 1, "seconds": 0.5, "bar_index": 1, "beat_in_bar": 2},
            {"index": 2, "seconds": 1.0, "bar_index": 1, "beat_in_bar": 3},
            {"index": 3, "seconds": 1.5, "bar_index": 1, "beat_in_bar": 4},
            {"index": 4, "seconds": 2.0, "bar_index": 2, "beat_in_bar": 1},
            {"index": 5, "seconds": 2.5, "bar_index": 2, "beat_in_bar": 2},
        ],
        "bars": [
            {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
            {"index": 2, "start_seconds": 2.0, "end_seconds": 4.0},
        ],
    }
