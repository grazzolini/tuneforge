from __future__ import annotations

from pathlib import Path

from app.engines.lyrics import LyricsTranscription
from app.errors import AppError

from .conftest import wait_for_job


def _first_source_artifact_id(client, project_id: str) -> str:
    artifacts = client.get(f"/api/v1/projects/{project_id}/artifacts").json()["artifacts"]
    return next(artifact["id"] for artifact in artifacts if artifact["type"] == "source_audio")


def test_get_lyrics_returns_empty_payload_until_generated(client, sample_audio_file: Path):
    project = client.post(
        "/api/v1/projects/import",
        json={"source_path": str(sample_audio_file), "copy_into_project": True},
    ).json()["project"]

    payload = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert payload["project_id"] == project["id"]
    assert payload["segments"] == []
    assert payload["source_segments"] == []
    assert payload["has_user_edits"] is False


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
    assert wait_for_job(client, job["id"])["status"] == "completed"

    created = client.get(f"/api/v1/projects/{project['id']}/lyrics").json()
    assert created["backend"] == "openai-whisper"
    assert created["source_artifact_id"] == _first_source_artifact_id(client, project["id"])
    assert created["segments"][0]["text"] == "First line"
    assert created["segments"][0]["words"][0]["text"] == "First"

    updated = client.put(
        f"/api/v1/projects/{project['id']}/lyrics",
        json={"segments": [{"text": "Edited first line"}, {"text": "Second line"}]},
    ).json()

    assert updated["segments"][0]["text"] == "Edited first line"
    assert updated["segments"][0]["start_seconds"] == 0.0
    assert updated["segments"][0]["end_seconds"] == 1.2
    assert updated["segments"][0]["words"] == []
    assert updated["source_segments"][0]["text"] == "First line"
    assert updated["has_user_edits"] is True


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
