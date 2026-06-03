from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import Any

from sqlalchemy import select

from app.db import SessionLocal
from app.engines.lyrics import LyricsTranscription
from app.errors import AppError
from app.models import LyricsTranscript, SyncEntityRevision
from app.services.artifacts import register_artifact
from app.services.paths import project_analysis_dir
from app.services.projects import import_project
from app.services.stem_signal_metadata import STEM_SIGNAL_METADATA_KEY, STEM_SIGNAL_METADATA_VERSION
from app.services.stems import StemGenerationResult

from .conftest import wait_for_job


def _first_source_artifact_id(client, project_id: str) -> str:
    artifacts = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    return next(artifact["id"] for artifact in artifacts if artifact["type"] == "source_audio")


def _create_project_without_import_jobs(source_path: Path) -> str:
    with SessionLocal() as session:
        project = import_project(
            session,
            source_path=str(source_path),
            copy_into_project=True,
            display_name=None,
        )
        project_id = project.id
        session.commit()
    return project_id


def _stem_signal_metadata(*, usable: bool) -> dict[str, Any]:
    peak = 0.4 if usable else 0.0
    rms = 0.2 if usable else 0.0
    active_duration = 2.0 if usable else 0.0
    return {
        STEM_SIGNAL_METADATA_KEY: {
            "version": STEM_SIGNAL_METADATA_VERSION,
            "has_signal": usable,
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
            "analysis_usability": {
                "version": 1,
                "usable": usable,
                "reason": "usable" if usable else "absolute_no_signal",
                "rms_ratio": 1.0 if usable else 0.0,
                "rms_db_below_reference": 0.0 if usable else None,
                "active_ratio": 1.0 if usable else 0.0,
                "peak_ratio": 1.0 if usable else 0.0,
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
            },
        },
    }


def _register_source_vocal_stem(
    *,
    project_id: str,
    source_artifact_id: str,
    path: Path,
    created_at: datetime,
    usable: bool = True,
    stem_model: str = "htdemucs_ft",
) -> str:
    mode = "six_stems" if stem_model == "htdemucs_6s" else "two_stems"
    with SessionLocal() as session:
        artifact = register_artifact(
            session,
            project_id=project_id,
            artifact_type="vocal_stem",
            artifact_format="wav",
            path=path,
            metadata={
                "mode": mode,
                "stem_model": stem_model,
                "stem_source": "vocals",
                "source_artifact_id": source_artifact_id,
                "source_artifact_type": "source_audio",
                **_stem_signal_metadata(usable=usable),
            },
            generated_by="demucs",
            can_delete=True,
            can_regenerate=True,
        )
        artifact.created_at = created_at
        artifact_id = artifact.id
        session.commit()
    return artifact_id


def test_import_queues_lyrics_generation(client, monkeypatch, sample_audio_file: Path):
    # Keep this lyrics assertion independent from runtime of other import jobs queued ahead of it.
    monkeypatch.setattr("app.services.jobs.analyze_project", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "app.services.jobs.detect_project_chords",
        lambda *_args, **_kwargs: SimpleNamespace(metadata_json={}),
    )
    monkeypatch.setattr(
        "app.services.jobs.generate_stems",
        lambda *_args, **_kwargs: StemGenerationResult(artifacts=[], generated_this_job=False),
    )

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    jobs = client.get("/api/v1/jobs").json()["jobs"]
    lyrics_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "lyrics")
    assert wait_for_job(client, lyrics_job["id"])["status"] == "completed"

    payload = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert payload["project_id"] == project["id"]
    assert payload["segments"][0]["text"] == "Test lyric"
    assert payload["source_segments"][0]["text"] == "Test lyric"
    assert payload["has_user_edits"] is False


def test_running_lyrics_cancel_does_not_persist_transcript_or_snapshot(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    started = Event()

    def fake_transcription(*_args, should_cancel=None, **_kwargs):
        started.set()
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if should_cancel and should_cancel():
                return LyricsTranscription(
                    backend="openai-whisper",
                    requested_device="cpu",
                    device="cpu",
                    model="turbo",
                    language="en",
                    segments=[
                        {
                            "start_seconds": 0.0,
                            "end_seconds": 1.0,
                            "text": "Should not persist",
                        }
                    ],
                )
            time.sleep(0.01)
        raise AssertionError("lyrics cancellation was not observed")

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)

    project_id = _create_project_without_import_jobs(sample_audio_file)

    lyrics_job = client.post(
        f"/api/v1/projects/{project_id}/lyrics",
        json={"force": True},
    ).json()["job"]
    assert started.wait(timeout=2.0)

    response = client.post(f"/api/v1/jobs/{lyrics_job['id']}/cancel")
    assert response.status_code == 200
    assert wait_for_job(client, lyrics_job["id"])["status"] == "cancelled"

    payload = client.get(f"/api/v1/projects/{project_id}/lyrics").json()
    assert payload["backend"] is None
    assert payload["segments"] == []
    with SessionLocal() as session:
        assert session.get(LyricsTranscript, project_id) is None
    assert not (project_analysis_dir(project_id) / "lyrics.json").exists()


def test_lyrics_job_persists_transcript_and_update_preserves_timings(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    def fake_transcription(*_args, **_kwargs):
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language="en",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.2,
                    "text": "First line",
                    "words": [
                        {
                            "text": "First",
                            "start_seconds": 0.0,
                            "end_seconds": 0.5,
                            "confidence": 0.9,
                        }
                    ],
                },
                {
                    "start_seconds": 1.2,
                    "end_seconds": 2.4,
                    "text": "Second line",
                },
            ],
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    job = client.post(f"/api/v1/projects/{project['id']}/lyrics", json={"force": False}).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["runtime_device"] == "cpu"
    assert final_job["lyrics_source"] == "source_preferred"
    assert final_job["duration_seconds"] is not None

    created = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert created["backend"] == "openai-whisper"
    assert created["source_artifact_id"] == _first_source_artifact_id(client, project["id"])
    assert final_job["source_artifact_id"] == created["source_artifact_id"]
    assert created["requested_device"] == "cpu"
    assert created["device"] == "cpu"
    assert created["model_name"] == "turbo"
    assert created["language"] == "en"
    assert created["language_override"] is None
    assert created["segments"][0]["text"] == "First line"
    assert created["segments"][0]["words"][0]["text"] == "First"
    snapshot = json.loads((project_analysis_dir(project["id"]) / "lyrics.json").read_text(encoding="utf-8"))
    assert snapshot["language_override"] is None

    updated = client.put(
        f"/api/v1/projects/{project['id']}/lyrics",
        json={"segments": [{"text": "Edited first line"}, {"text": "Second line"}]},
    ).json()

    assert updated["segments"][0]["text"] == "Edited first line"
    assert updated["segments"][0]["start_seconds"] == 0.0
    assert updated["segments"][0]["end_seconds"] == 1.2
    assert [word["text"] for word in updated["segments"][0]["words"]] == ["Edited", "first", "line"]
    assert updated["segments"][0]["words"][0]["start_seconds"] == 0.0
    assert updated["segments"][0]["words"][-1]["end_seconds"] == 1.2
    assert updated["source_segments"][0]["text"] == "First line"
    assert updated["has_user_edits"] is True


def test_lyrics_generation_uses_usable_source_vocal_stem(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    transcribed_paths: list[Path] = []

    def fake_transcription(source_path: Path, *_args, **_kwargs):
        transcribed_paths.append(source_path)
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language="en",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "Vocal stem lyric",
                }
            ],
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)

    project_id = _create_project_without_import_jobs(sample_audio_file)
    source_artifact_id = _first_source_artifact_id(client, project_id)
    vocal_path = sample_audio_file.parent / "vocals.wav"
    vocal_path.write_bytes(sample_audio_file.read_bytes())
    vocal_id = _register_source_vocal_stem(
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        path=vocal_path,
        created_at=datetime(2026, 1, 2, tzinfo=UTC),
    )

    job = client.post(f"/api/v1/projects/{project_id}/lyrics", json={"force": True}).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["lyrics_source"] == "vocals"
    assert final_job["source_artifact_id"] == vocal_id

    created = client.get(f"/api/v1/projects/{project_id}/lyrics").json()
    assert transcribed_paths == [vocal_path]
    assert created["source_artifact_id"] == vocal_id
    assert created["source_kind"] == "vocal_stem"
    assert created["segments"][0]["text"] == "Vocal stem lyric"


def test_lyrics_generation_skips_newer_unusable_source_vocal_stem(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    transcribed_paths: list[Path] = []

    def fake_transcription(source_path: Path, *_args, **_kwargs):
        transcribed_paths.append(source_path)
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language="en",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "Older usable vocal lyric",
                }
            ],
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)

    project_id = _create_project_without_import_jobs(sample_audio_file)
    source_artifact_id = _first_source_artifact_id(client, project_id)
    older_vocal_path = sample_audio_file.parent / "older-usable-vocals.wav"
    newer_vocal_path = sample_audio_file.parent / "newer-unusable-vocals.wav"
    older_vocal_path.write_bytes(sample_audio_file.read_bytes())
    newer_vocal_path.write_bytes(sample_audio_file.read_bytes())
    older_vocal_id = _register_source_vocal_stem(
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        path=older_vocal_path,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        stem_model="htdemucs_ft",
    )
    newer_vocal_id = _register_source_vocal_stem(
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        path=newer_vocal_path,
        created_at=datetime(2026, 1, 2, tzinfo=UTC),
        usable=False,
        stem_model="htdemucs_6s",
    )

    job = client.post(f"/api/v1/projects/{project_id}/lyrics", json={"force": True}).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["lyrics_source"] == "vocals"
    assert final_job["source_artifact_id"] == older_vocal_id

    created = client.get(f"/api/v1/projects/{project_id}/lyrics").json()
    assert transcribed_paths == [older_vocal_path]
    assert created["source_artifact_id"] == older_vocal_id
    assert created["source_artifact_id"] != newer_vocal_id
    assert created["source_kind"] == "vocal_stem"


def test_lyrics_generation_falls_back_to_source_audio_without_usable_source_vocal_stem(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    transcribed_paths: list[Path] = []

    def fake_transcription(source_path: Path, *_args, **_kwargs):
        transcribed_paths.append(source_path)
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language="en",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "Source lyric",
                }
            ],
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)

    project_id = _create_project_without_import_jobs(sample_audio_file)
    artifacts = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    source_artifact = next(artifact for artifact in artifacts if artifact["type"] == "source_audio")
    missing_vocal_path = sample_audio_file.parent / "missing-vocals.wav"
    wrong_source_vocal_path = sample_audio_file.parent / "wrong-source-vocals.wav"
    wrong_source_vocal_path.write_bytes(sample_audio_file.read_bytes())
    _register_source_vocal_stem(
        project_id=project_id,
        source_artifact_id=source_artifact["id"],
        path=missing_vocal_path,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        stem_model="htdemucs_ft",
    )
    wrong_source_vocal_id = _register_source_vocal_stem(
        project_id=project_id,
        source_artifact_id="art_wrong_source",
        path=wrong_source_vocal_path,
        created_at=datetime(2026, 1, 2, tzinfo=UTC),
        stem_model="htdemucs_6s",
    )

    job = client.post(f"/api/v1/projects/{project_id}/lyrics", json={"force": True}).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["lyrics_source"] == "source_preferred"
    assert final_job["source_artifact_id"] == source_artifact["id"]

    created = client.get(f"/api/v1/projects/{project_id}/lyrics").json()
    assert transcribed_paths == [Path(source_artifact["path"])]
    assert created["source_artifact_id"] == source_artifact["id"]
    assert created["source_artifact_id"] != wrong_source_vocal_id
    assert created["source_kind"] == "ai"
    assert created["segments"][0]["text"] == "Source lyric"


def test_lyrics_language_override_reaches_service_and_persists_metadata(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    requested_languages: list[str | None] = []

    def fake_transcription(*_args, language_override=None, **_kwargs):
        requested_languages.append(language_override)
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device="cpu",
            device="cpu",
            model="turbo",
            language=None,
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "Ola mundo",
                }
            ],
            language_override=language_override,
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    job = client.post(
        f"/api/v1/projects/{project['id']}/lyrics",
        json={"force": True, "language_override": " PT "},
    ).json()["job"]
    assert wait_for_job(client, job["id"])["status"] == "completed"

    created = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert requested_languages[-1] == "pt"
    assert created["language"] == "pt"
    assert created["language_override"] == "pt"
    snapshot = json.loads((project_analysis_dir(project["id"]) / "lyrics.json").read_text(encoding="utf-8"))
    assert snapshot["language"] == "pt"
    assert snapshot["language_override"] == "pt"

    with SessionLocal() as session:
        lyrics = session.get(LyricsTranscript, project["id"])
        assert lyrics is not None
        assert lyrics.language_override == "pt"
        revision = session.scalars(
            select(SyncEntityRevision).where(
                SyncEntityRevision.project_id == project["id"],
                SyncEntityRevision.entity_type == "lyrics",
                SyncEntityRevision.state == "active",
            )
        ).one()
        assert revision.payload_json["language"] == "pt"
        assert revision.payload_json["language_override"] == "pt"


def test_lyrics_no_lyrics_override_clears_transcript_without_transcribing(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    project_id = _create_project_without_import_jobs(sample_audio_file)
    source_artifact_id = _first_source_artifact_id(client, project_id)
    vocal_path = sample_audio_file.parent / "no-lyrics-vocals.wav"
    vocal_path.write_bytes(sample_audio_file.read_bytes())
    vocal_stem_id = _register_source_vocal_stem(
        project_id=project_id,
        source_artifact_id=source_artifact_id,
        path=vocal_path,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    def fail_transcription(*_args, **_kwargs):
        raise AssertionError("lyrics transcription should not run for no-lyrics override")

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fail_transcription)

    job = client.post(
        f"/api/v1/projects/{project_id}/lyrics",
        json={"force": True, "language_override": "none"},
    ).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "completed"
    assert final_job["lyrics_source"] == "none"
    assert final_job["source_artifact_id"] == source_artifact_id

    created = client.get(f"/api/v1/projects/{project_id}/lyrics").json()
    assert created["backend"] == "none"
    assert created["source_artifact_id"] == source_artifact_id
    assert created["source_artifact_id"] != vocal_stem_id
    assert created["source_kind"] == "instrumental"
    assert created["language"] is None
    assert created["language_override"] == "none"
    assert created["source_segments"] == []
    assert created["segments"] == []
    assert created["has_user_edits"] is False

    snapshot = json.loads((project_analysis_dir(project_id) / "lyrics.json").read_text())
    assert snapshot["language_override"] == "none"
    assert snapshot["segments"] == []


def test_lyrics_language_override_invalid_code_rejected(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    response = client.post(
        f"/api/v1/projects/{project['id']}/lyrics",
        json={"force": True, "language_override": "ru"},
    )

    assert response.status_code == 422


def test_lyrics_short_circuit_ignores_override_when_force_false(
    client,
    monkeypatch,
    sample_audio_file: Path,
):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]
    jobs = client.get("/api/v1/jobs").json()["jobs"]
    lyrics_job = next(job for job in jobs if job["project_id"] == project["id"] and job["type"] == "lyrics")
    assert wait_for_job(client, lyrics_job["id"])["status"] == "completed"

    def fail_transcription(*_args, **_kwargs):
        raise AssertionError("existing lyrics should short-circuit without regeneration")

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fail_transcription)

    job = client.post(
        f"/api/v1/projects/{project['id']}/lyrics",
        json={"force": False, "language_override": "pt"},
    ).json()["job"]
    assert wait_for_job(client, job["id"])["status"] == "completed"

    refreshed = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert refreshed["segments"][0]["text"] == "Test lyric"
    assert refreshed["language_override"] is None


def test_force_regenerate_replaces_current_and_clears_edit_flag(client, monkeypatch, sample_audio_file: Path):
    responses = iter(
        [
            LyricsTranscription(
                backend="openai-whisper",
                requested_device="cpu",
                device="cpu",
                model="turbo",
                language="en",
                segments=[
                    {
                        "start_seconds": 0.0,
                        "end_seconds": 1.0,
                        "text": "Original line",
                    }
                ],
            ),
            LyricsTranscription(
                backend="openai-whisper",
                requested_device="cpu",
                device="cpu",
                model="turbo",
                language="en",
                segments=[
                    {
                        "start_seconds": 0.0,
                        "end_seconds": 1.0,
                        "text": "Regenerated line",
                    }
                ],
            ),
        ]
    )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", lambda *_args, **_kwargs: next(responses))

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    first_job = client.post(f"/api/v1/projects/{project['id']}/lyrics", json={"force": False}).json()["job"]
    assert wait_for_job(client, first_job["id"])["status"] == "completed"

    client.put(
        f"/api/v1/projects/{project['id']}/lyrics",
        json={"segments": [{"text": "Manual edit"}]},
    )

    second_job = client.post(f"/api/v1/projects/{project['id']}/lyrics", json={"force": True}).json()["job"]
    assert wait_for_job(client, second_job["id"])["status"] == "completed"

    refreshed = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert refreshed["segments"][0]["text"] == "Regenerated line"
    assert refreshed["source_segments"][0]["text"] == "Regenerated line"
    assert refreshed["has_user_edits"] is False


def test_lyrics_job_failure_surfaces_error_message(client, monkeypatch, sample_audio_file: Path):
    def fail_transcription(*_args, **_kwargs):
        raise AppError("PROCESSING_FAILED", "Lyrics model download failed.", status_code=500)

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fail_transcription)

    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    job = client.post(f"/api/v1/projects/{project['id']}/lyrics", json={"force": False}).json()["job"]
    final_job = wait_for_job(client, job["id"])
    assert final_job["status"] == "failed"
    assert final_job["error_message"] == "Lyrics model download failed."
    assert final_job["duration_seconds"] is not None
