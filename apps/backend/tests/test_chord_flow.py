from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.config import get_settings
from app.db import SessionLocal
from app.models import SongSection, TabImport
from app.services.artifacts import register_artifact
from app.services.chord_backends import ChordDetectionResult
from app.services.chords import detect_project_chords, project_chord_detection_source
from app.services.projects import get_project
from app.services.stem_signal_metadata import (
    STEM_SIGNAL_METADATA_KEY,
    STEM_SIGNAL_METADATA_VERSION,
    stem_signal_analysis_usable,
)

from .conftest import wait_for_job


@pytest.fixture(autouse=True)
def _stub_unrelated_import_handlers(monkeypatch, isolated_data_dir):
    monkeypatch.setenv("TUNEFORGE_DEFAULT_CHORD_BACKEND", "tuneforge-fast")
    get_settings.cache_clear()
    for handler in ("_handle_analyze", "_handle_stems", "_handle_lyrics"):
        monkeypatch.setattr(
            f"app.services.jobs.InProcessJobRunner.{handler}",
            lambda *_args: SimpleNamespace(artifact_ids=[], runtime_device=None),
        )


def _segment(label: str, *, confidence: float, pitch_class: int, quality: str) -> dict[str, Any]:
    return {
        "start_seconds": 0.0,
        "end_seconds": 4.0,
        "label": label,
        "confidence": confidence,
        "pitch_class": pitch_class,
        "quality": quality,
    }


def _stem_signal_metadata(
    *,
    has_signal: bool,
    version: int = STEM_SIGNAL_METADATA_VERSION,
    include_usability: bool = True,
    usable: bool | None = None,
    analysis_version: int = 1,
) -> dict[str, Any]:
    peak = 0.4 if has_signal else 0.0
    rms = 0.2 if has_signal else 0.0
    active_duration = 2.0 if has_signal else 0.0
    stem_signal: dict[str, Any] = {
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
    if include_usability:
        analysis_usable = has_signal if usable is None else usable
        stem_signal["analysis_usability"] = {
            "version": analysis_version,
            "usable": analysis_usable,
            "reason": "usable"
            if analysis_usable
            else ("absolute_no_signal" if not has_signal else "relative_leakage"),
            "rms_ratio": 1.0 if has_signal else 0.0,
            "rms_db_below_reference": 0.0 if has_signal else None,
            "active_ratio": 1.0 if has_signal else 0.0,
            "peak_ratio": 1.0 if has_signal else 0.0,
            "reference": {
                "max_rms": rms,
                "max_active_duration_seconds": active_duration,
                "max_peak": peak,
            },
            "thresholds": {
                "min_rms_ratio": 0.10,
                "min_active_ratio": 0.20,
                "clear_absent_rms_ratio": 0.01,
            },
        }
    return {
        STEM_SIGNAL_METADATA_KEY: stem_signal
    }


def _forbid_chord_signal_inspection(monkeypatch) -> None:
    def raise_if_called(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("chord flow must only read persisted stem_signal metadata")

    monkeypatch.setattr("app.services.stem_signal_metadata.build_stem_signal_metadata", raise_if_called)
    monkeypatch.setattr("app.services.stem_signal_metadata.inspect_audio_signal_file", raise_if_called)
    monkeypatch.setattr("app.engines.audio_signal.inspect_audio_signal_file", raise_if_called)


def test_stem_signal_analysis_usability_rejects_raw_no_signal_with_usable_flag():
    metadata = _stem_signal_metadata(has_signal=False, usable=True)

    assert stem_signal_analysis_usable(metadata) is False


def test_chord_job_persists_timeline(client, sample_chord_audio_file: Path, monkeypatch):
    monkeypatch.setattr(
        "app.services.chord_backends.crema_dependency_status",
        lambda **_kwargs: (False, "crema is not installed"),
    )

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"], timeout=90.0)["status"] == "completed"

    initial = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert initial["project_id"] == project["id"]
    assert initial["backend"] == "tuneforge-fast"
    assert len(initial["timeline"]) >= 3
    assert initial["source_segments"] == initial["timeline"]
    assert initial["has_user_edits"] is False
    initial_created_at = initial["created_at"]
    initial_updated_at = initial["updated_at"]

    job = client.post(
        f"/api/v1/projects/{project['id']}/chords",
        json={"backend": "default", "backend_fallback_from": "crema-advanced", "force": True},
    ).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["chord_backend"] == "tuneforge-fast"
    assert final_job["chord_backend_fallback_from"] == "crema-advanced"
    assert final_job["runtime_device"] == "cpu"
    assert final_job["duration_seconds"] is not None

    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert chords["project_id"] == project["id"]
    assert chords["backend"] == "tuneforge-fast"
    assert len(chords["timeline"]) >= 3
    assert len(chords["source_segments"]) >= 3
    assert chords["has_user_edits"] is False
    assert chords["metadata"]["backend_fallback_from"] == "crema-advanced"
    assert chords["metadata"]["runtime_device"] == "cpu"
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


def test_import_chord_job_uses_requested_advanced_backend_when_available(
    client,
    sample_chord_audio_file: Path,
    monkeypatch,
):
    monkeypatch.setattr("app.services.chord_backends.crema_dependency_status", lambda **_kwargs: (True, None))
    monkeypatch.setattr("app.services.chord_backends.crema_runtime_device", lambda: "cpu")
    monkeypatch.setattr(
        "app.services.chord_backends.crema_model_metadata",
        lambda: {"backend_id": "crema-advanced", "engine": "crema-test"},
    )
    monkeypatch.setattr(
        "app.services.chord_backends.detect_crema_chord_timeline",
        lambda _: [_segment("D/F#", confidence=0.91, pitch_class=2, quality="major")],
    )

    project = client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_chord_audio_file),
            "copy_into_project": True,
            "chord_backend": "crema-advanced",
        },
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert initial_chord_job["chord_backend"] == "crema-advanced"

    final_job = wait_for_job(client, initial_chord_job["id"], timeout=90.0)
    assert final_job["status"] == "completed"
    assert final_job["chord_backend"] == "crema-advanced"
    assert final_job["chord_backend_fallback_from"] is None

    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert chords["backend"] == "crema-advanced"
    assert chords["metadata"]["backend_fallback_from"] is None
    assert chords["metadata"]["runtime_device"] == "cpu"
    assert [segment["label"] for segment in chords["timeline"]] == ["D/F#"]


@pytest.mark.parametrize(
    ("backend_id", "status_function", "reason"),
    [
        ("crema-advanced", "crema_dependency_status", "crema is not installed"),
        (
            "lv-chordia-submission",
            "lv_chordia_dependency_status",
            "LV Chordia is not installed in this desktop package",
        ),
    ],
)
def test_import_chord_job_falls_back_when_requested_backend_is_unavailable(
    client,
    sample_chord_audio_file: Path,
    monkeypatch,
    backend_id: str,
    status_function: str,
    reason: str,
):
    monkeypatch.setattr(
        f"app.services.chord_backends.{status_function}",
        lambda **_kwargs: (False, reason),
    )

    project = client.post(
        "/api/v1/projects/import",
        json={
            "source_path": str(sample_chord_audio_file),
            "copy_into_project": True,
            "chord_backend": backend_id,
        },
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert initial_chord_job["chord_backend"] == "tuneforge-fast"
    assert initial_chord_job["chord_backend_fallback_from"] == backend_id

    final_job = wait_for_job(client, initial_chord_job["id"], timeout=90.0)
    assert final_job["status"] == "completed"
    assert final_job["chord_backend"] == "tuneforge-fast"
    assert final_job["chord_backend_fallback_from"] == backend_id

    chords = client.get(f"/api/v1/projects/{project['id']}/chords").json()
    assert chords["backend"] == "tuneforge-fast"
    assert chords["metadata"]["backend_fallback_from"] == backend_id


@pytest.mark.parametrize("backend_id", ["tuneforge-fast", "crema-advanced"])
@pytest.mark.parametrize(
    ("stem_has_signal", "expected_label", "expected_detection_source"),
    [
        (True, "G", "source+stem"),
        (False, "Em", "source"),
    ],
)
def test_chord_refresh_uses_signal_bearing_source_stems_only_for_augmentation(
    client,
    sample_chord_audio_file: Path,
    tmp_path: Path,
    monkeypatch,
    backend_id: str,
    stem_has_signal: bool,
    expected_label: str,
    expected_detection_source: str,
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
            metadata={
                "source_artifact_id": mix_artifact.id,
                "source_artifact_type": "preview_mix",
                **_stem_signal_metadata(has_signal=True),
            },
            generated_by="demucs",
        )
        register_artifact(
            session,
            project_id=project_model.id,
            artifact_type="instrumental_stem",
            artifact_format="wav",
            path=source_stem_path,
            metadata={
                "source_artifact_id": source_artifact.id,
                "source_artifact_type": "source_audio",
                **_stem_signal_metadata(has_signal=stem_has_signal),
            },
            generated_by="demucs",
        )
        session.commit()

    _forbid_chord_signal_inspection(monkeypatch)
    detected_paths: list[Path] = []

    def fake_resolve_chord_backend(requested_backend: str, *, require_available: bool = False):
        del require_available
        selected_backend_id = "crema-advanced" if requested_backend == "crema-advanced" else "tuneforge-fast"
        return SimpleNamespace(
            id=selected_backend_id,
            label="Advanced Chords" if selected_backend_id == "crema-advanced" else "Built-in Chords",
            capabilities=SimpleNamespace(),
        )

    def fake_detect_timeline(path: Path, selected_backend_id: str) -> ChordDetectionResult:
        assert selected_backend_id == backend_id
        detected_paths.append(path)
        if path == source_stem_path:
            segments = [_segment("G", confidence=0.88, pitch_class=7, quality="major")]
            return ChordDetectionResult(segments=segments, backend_id=selected_backend_id, metadata={})
        if path == mix_stem_path:
            segments = [_segment("F", confidence=0.95, pitch_class=5, quality="major")]
            return ChordDetectionResult(segments=segments, backend_id=selected_backend_id, metadata={})
        segments = [_segment("Em", confidence=0.35, pitch_class=4, quality="minor")]
        return ChordDetectionResult(segments=segments, backend_id=selected_backend_id, metadata={})

    monkeypatch.setattr("app.services.chords.resolve_chord_backend", fake_resolve_chord_backend)
    monkeypatch.setattr("app.services.chords._detect_timeline", fake_detect_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        assert project_chord_detection_source(project_model, backend=backend_id) == expected_detection_source
        chords = detect_project_chords(session, project_model, backend=backend_id, force=True)
        session.commit()

    assert chords.backend == backend_id
    assert chords.source_artifact_id == source_artifact.id
    assert [segment["label"] for segment in chords.source_segments_json] == ["Em"]
    assert [segment["label"] for segment in chords.segments_json] == [expected_label]
    assert (source_stem_path in detected_paths) is stem_has_signal
    assert mix_stem_path not in detected_paths


def test_chord_refresh_ignores_instrumental_stem_with_non_source_artifact_type(
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

    wrong_source_type_stem_path = tmp_path / "wrong-source-type-instrumental.wav"
    wrong_source_type_stem_path.write_bytes(b"bad-stem")

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        source_artifact = next(artifact for artifact in project_model.artifacts if artifact.type == "source_audio")
        register_artifact(
            session,
            project_id=project_model.id,
            artifact_type="instrumental_stem",
            artifact_format="wav",
            path=wrong_source_type_stem_path,
            metadata={
                "source_artifact_id": source_artifact.id,
                "source_artifact_type": "preview_mix",
                **_stem_signal_metadata(has_signal=True),
            },
            generated_by="demucs",
        )
        session.commit()

    _forbid_chord_signal_inspection(monkeypatch)
    detected_paths: list[Path] = []

    def fake_detect_timeline(path: Path, selected_backend_id: str) -> ChordDetectionResult:
        detected_paths.append(path)
        return ChordDetectionResult(
            segments=[_segment("Em", confidence=0.35, pitch_class=4, quality="minor")],
            backend_id=selected_backend_id,
            metadata={},
        )

    monkeypatch.setattr("app.services.chords._detect_timeline", fake_detect_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        assert project_chord_detection_source(project_model) == "source"
        chords = detect_project_chords(session, project_model, force=True)
        session.commit()

    assert [segment["label"] for segment in chords.source_segments_json] == ["Em"]
    assert [segment["label"] for segment in chords.segments_json] == ["Em"]
    assert wrong_source_type_stem_path not in detected_paths


def test_chord_refresh_uses_temporary_six_stem_non_vocal_mix(
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

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        source_artifact = next(artifact for artifact in project_model.artifacts if artifact.type == "source_audio")
        metadata_by_source = {
            "drums": _stem_signal_metadata(has_signal=True),
            "bass": _stem_signal_metadata(has_signal=False),
            "guitar": _stem_signal_metadata(has_signal=True),
            "piano": {"source_artifact_type": "preview_mix", **_stem_signal_metadata(has_signal=True)},
            "other": _stem_signal_metadata(has_signal=True, version=0),
        }
        for source, artifact_type in [
            ("drums", "drums_stem"),
            ("bass", "bass_stem"),
            ("guitar", "guitar_stem"),
            ("piano", "piano_stem"),
            ("other", "other_stem"),
        ]:
            path = tmp_path / f"{source}.wav"
            path.write_bytes(source.encode("utf-8"))
            register_artifact(
                session,
                project_id=project_model.id,
                artifact_type=artifact_type,
                artifact_format="wav",
                path=path,
                metadata={
                    "source_artifact_id": source_artifact.id,
                    "source_artifact_type": "source_audio",
                    "stem_model": "htdemucs_6s",
                    "stem_source": source,
                    **metadata_by_source[source],
                },
                generated_by="demucs",
            )
        session.commit()

    _forbid_chord_signal_inspection(monkeypatch)
    temp_mix_paths: list[Path] = []

    def fake_mix_audio_files(
        source_paths: list[Path],
        output_path: Path,
        *,
        subtype: str = "FLOAT",
        block_size: int = 0,
    ):
        assert subtype == "FLOAT"
        assert [path.name for path in source_paths] == ["drums.wav", "guitar.wav"]
        output_path.write_bytes(b"non-vocal")
        temp_mix_paths.append(output_path)

    def fake_detect_timeline(path: Path, selected_backend_id: str) -> ChordDetectionResult:
        del selected_backend_id
        if path in temp_mix_paths:
            assert path.exists()
            return ChordDetectionResult(
                segments=[_segment("G", confidence=0.88, pitch_class=7, quality="major")],
                backend_id="tuneforge-fast",
                metadata={},
            )
        return ChordDetectionResult(
            segments=[_segment("Em", confidence=0.35, pitch_class=4, quality="minor")],
            backend_id="tuneforge-fast",
            metadata={},
        )

    monkeypatch.setattr("app.services.chords.mix_audio_files", fake_mix_audio_files)
    monkeypatch.setattr("app.services.chords._detect_timeline", fake_detect_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        assert project_chord_detection_source(project_model) == "source+stem"
        chords = detect_project_chords(session, project_model, force=True)
        session.commit()

    assert [segment["label"] for segment in chords.source_segments_json] == ["Em"]
    assert [segment["label"] for segment in chords.segments_json] == ["G"]
    assert temp_mix_paths
    assert all(not path.exists() for path in temp_mix_paths)


def test_chord_refresh_skips_six_stem_mix_without_signal_bearing_non_vocal_stems(
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

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        source_artifact = next(artifact for artifact in project_model.artifacts if artifact.type == "source_audio")
        metadata_by_source = {
            "drums": {},
            "bass": _stem_signal_metadata(has_signal=False),
            "guitar": _stem_signal_metadata(has_signal=True, version=0),
            "piano": {STEM_SIGNAL_METADATA_KEY: {"version": STEM_SIGNAL_METADATA_VERSION, "has_signal": True}},
            "other": _stem_signal_metadata(has_signal=True, include_usability=False),
        }
        for source, artifact_type in [
            ("drums", "drums_stem"),
            ("bass", "bass_stem"),
            ("guitar", "guitar_stem"),
            ("piano", "piano_stem"),
            ("other", "other_stem"),
        ]:
            path = tmp_path / f"{source}.wav"
            path.write_bytes(source.encode("utf-8"))
            register_artifact(
                session,
                project_id=project_model.id,
                artifact_type=artifact_type,
                artifact_format="wav",
                path=path,
                metadata={
                    "source_artifact_id": source_artifact.id,
                    "source_artifact_type": "source_audio",
                    "stem_model": "htdemucs_6s",
                    "stem_source": source,
                    **metadata_by_source[source],
                },
                generated_by="demucs",
            )
        session.commit()

    _forbid_chord_signal_inspection(monkeypatch)

    def fail_mix_audio_files(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("six-stem mix should not run without signal-bearing stems")

    def fake_detect_timeline(path: Path, selected_backend_id: str) -> ChordDetectionResult:
        del path
        return ChordDetectionResult(
            segments=[_segment("Em", confidence=0.35, pitch_class=4, quality="minor")],
            backend_id=selected_backend_id,
            metadata={},
        )

    monkeypatch.setattr("app.services.chords.mix_audio_files", fail_mix_audio_files)
    monkeypatch.setattr("app.services.chords._detect_timeline", fake_detect_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        assert project_chord_detection_source(project_model) == "source"
        chords = detect_project_chords(session, project_model, force=True)
        session.commit()

    assert [segment["label"] for segment in chords.source_segments_json] == ["Em"]
    assert [segment["label"] for segment in chords.segments_json] == ["Em"]


def test_chord_refresh_preserves_user_edits_without_overwrite(
    client,
    sample_chord_audio_file: Path,
    monkeypatch,
):
    monkeypatch.setattr(
        "app.services.chord_backends.crema_dependency_status",
        lambda **_kwargs: (False, "crema is not installed"),
    )

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

    def fake_detect_timeline(path: Path, backend_id: str) -> ChordDetectionResult:
        assert backend_id == "tuneforge-fast"
        calls.append(path)
        segments = [_segment("G", confidence=0.88, pitch_class=7, quality="major")]
        return ChordDetectionResult(segments=segments, backend_id=backend_id, metadata={})

    monkeypatch.setattr("app.services.chords._detect_timeline", fake_detect_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        chords = detect_project_chords(session, project_model, force=True)
        session.commit()

    assert calls == []
    assert chords.has_user_edits is True
    assert chords.source_kind == "user-edited"
    assert chords.segments_json == [edited_segment]

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        chords = detect_project_chords(session, project_model, force=True, overwrite_user_edits=True)
        session.commit()

    assert calls
    assert chords.has_user_edits is False
    assert [segment["label"] for segment in chords.segments_json] == ["G"]


def test_chord_refresh_clears_current_tab_state(client, sample_chord_audio_file: Path, monkeypatch):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_chord_audio_file), "copy_into_project": True},
    ).json()["project"]

    initial_jobs = client.get("/api/v1/jobs").json()["jobs"]
    initial_chord_job = next(
        job for job in initial_jobs if job["project_id"] == project["id"] and job["type"] == "chords"
    )
    assert wait_for_job(client, initial_chord_job["id"])["status"] == "completed"

    with SessionLocal() as session:
        session.add(
            TabImport(
                id="tab_test",
                project_id=project["id"],
                raw_text="Key: D",
                parser_version="test",
                status="applied",
                parsed_json={},
                proposal_json={},
            )
        )
        session.add(
            SongSection(
                id="sec_test",
                project_id=project["id"],
                tab_import_id="tab_test",
                label="Verse",
                source="tab",
                metadata_json={},
            )
        )
        session.commit()

    def fake_detect_timeline(path: Path, backend_id: str) -> ChordDetectionResult:
        del path
        return ChordDetectionResult(
            segments=[_segment("G", confidence=0.88, pitch_class=7, quality="major")],
            backend_id=backend_id,
            metadata={},
        )

    monkeypatch.setattr("app.services.chords._detect_timeline", fake_detect_timeline)

    with SessionLocal() as session:
        project_model = get_project(session, project["id"])
        detect_project_chords(session, project_model, force=True)
        assert session.get(TabImport, "tab_test") is None
        assert session.get(SongSection, "sec_test") is None
        session.commit()
