from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

# Test modules import app.db during collection, before fixtures run. Force that
# collection-time engine onto disposable storage instead of the user's app data.
_TEST_BOOTSTRAP_DIRECTORY = tempfile.TemporaryDirectory(prefix="tuneforge-pytest-")
_TEST_BOOTSTRAP_ROOT = Path(_TEST_BOOTSTRAP_DIRECTORY.name).resolve()
_TEST_BOOTSTRAP_DATA_ROOT = _TEST_BOOTSTRAP_ROOT / "data"
os.environ["TUNEFORGE_DATA_DIR"] = str(_TEST_BOOTSTRAP_DATA_ROOT)
os.environ["XDG_CACHE_HOME"] = str(_TEST_BOOTSTRAP_ROOT / "xdg-cache")

def pytest_sessionstart(session: pytest.Session) -> None:
    _ = session
    from app.config import ensure_data_dirs, get_settings
    from app.db import reconfigure_engine, run_migrations

    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    _ = session, exitstatus
    from app.db import get_engine

    get_engine().dispose()
    _TEST_BOOTSTRAP_DIRECTORY.cleanup()


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TUNEFORGE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TUNEFORGE_HOST", "127.0.0.1")
    monkeypatch.setenv("TUNEFORGE_PORT", "8765")
    monkeypatch.delenv("TUNEFORGE_DEMUCS_MODEL_REPO", raising=False)
    monkeypatch.delenv("TUNEFORGE_MODEL_BUNDLE_DIR", raising=False)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def fast_lyrics_engine(isolated_data_dir, monkeypatch: pytest.MonkeyPatch):
    from app.engines.lyrics import LyricsTranscription

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
                    "end_seconds": 1.0,
                    "text": "Test lyric",
                }
            ],
        )

    monkeypatch.setattr("app.services.lyrics.transcribe_project_lyrics", fake_transcription)


@pytest.fixture()
def client() -> TestClient:
    from app.main import app

    with TestClient(app) as current:
        yield current


def import_project_without_jobs(source_path: Path) -> dict[str, str]:
    from app.db import SessionLocal
    from app.services.projects import import_project

    with SessionLocal() as session:
        project = import_project(session, source_path=str(source_path), copy_into_project=True, display_name=None)
        session.commit()
        return {"id": project.id}


@pytest.fixture()
def sample_audio_file(tmp_path: Path) -> Path:
    sample_rate = 44100
    duration = 2.0
    timeline = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    signal = (
        0.4 * np.sin(2 * np.pi * 440.0 * timeline)
        + 0.25 * np.sin(2 * np.pi * 554.37 * timeline)
        + 0.2 * np.sin(2 * np.pi * 659.25 * timeline)
    )
    output_path = tmp_path / "fixture.wav"
    sf.write(output_path, signal, sample_rate)
    return output_path


@pytest.fixture()
def sample_rhythmic_audio_file(tmp_path: Path) -> Path:
    sample_rate = 22050
    duration = 8.0
    timeline = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    signal = (
        0.28 * np.sin(2 * np.pi * 261.63 * timeline)
        + 0.22 * np.sin(2 * np.pi * 329.63 * timeline)
        + 0.18 * np.sin(2 * np.pi * 392.0 * timeline)
    )
    interval = 0.5
    pulse = np.zeros_like(timeline)
    for start in np.arange(0.0, duration, interval):
        distance = np.abs(timeline - start)
        pulse += 0.26 * np.exp(-((distance / 0.012) ** 2))
    output_path = tmp_path / "fixture_rhythmic.wav"
    sf.write(output_path, (signal + pulse).astype(np.float32), sample_rate)
    return output_path


@pytest.fixture()
def sample_stereo_audio_file(tmp_path: Path) -> Path:
    sample_rate = 44100
    duration = 2.0
    timeline = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    center = 0.35 * np.sin(2 * np.pi * 440.0 * timeline)
    side = 0.2 * np.sin(2 * np.pi * 659.25 * timeline)
    stereo_signal = np.column_stack([center + side, center - side])
    output_path = tmp_path / "fixture_stereo.wav"
    sf.write(output_path, stereo_signal, sample_rate)
    return output_path


@pytest.fixture()
def sample_chord_audio_file(tmp_path: Path) -> Path:
    sample_rate = 22050
    segment_duration = 1.6
    fade_in = int(sample_rate * 0.03)
    fade_out = int(sample_rate * 0.08)
    chord_progression = [
        [261.63, 329.63, 392.0],
        [196.0, 246.94, 293.66],
        [220.0, 261.63, 329.63],
        [174.61, 220.0, 261.63],
    ]
    segments: list[np.ndarray] = []
    for frequencies in chord_progression:
        timeline = np.linspace(0, segment_duration, int(sample_rate * segment_duration), endpoint=False)
        envelope = np.ones_like(timeline)
        envelope[:fade_in] = np.linspace(0.0, 1.0, fade_in, endpoint=False)
        envelope[-fade_out:] = np.linspace(1.0, 0.0, fade_out, endpoint=False)
        signal = np.zeros_like(timeline)
        for frequency in frequencies:
            signal += 0.22 * np.sin(2 * np.pi * frequency * timeline)
            signal += 0.07 * np.sin(2 * np.pi * frequency * 2.0 * timeline)
        segments.append((signal * envelope).astype(np.float32))

    output_path = tmp_path / "fixture_chords.wav"
    sf.write(output_path, np.concatenate(segments), sample_rate)
    return output_path


def _transcode_fixture(source_path: Path, destination_path: Path, codec: str) -> Path:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-c:a",
        codec,
        str(destination_path),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    return destination_path


@pytest.fixture()
def sample_mp3_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.mp3", "libmp3lame")


@pytest.fixture()
def sample_flac_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.flac", "flac")


@pytest.fixture()
def sample_m4a_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.m4a", "aac")


@pytest.fixture()
def sample_aac_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.aac", "aac")


@pytest.fixture()
def sample_ogg_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.ogg", "libopus")


@pytest.fixture()
def sample_mp4_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.mp4", "aac")


@pytest.fixture()
def sample_webm_file(tmp_path: Path, sample_audio_file: Path) -> Path:
    return _transcode_fixture(sample_audio_file, tmp_path / "fixture.webm", "libopus")


def wait_for_job(client: TestClient, job_id: str, *, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    last_payload: dict | None = None
    while time.monotonic() < deadline:
        payload = client.get(f"/api/v1/jobs/{job_id}").json()["job"]
        last_payload = payload
        if payload["status"] in {"completed", "failed", "cancelled"}:
            return payload
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for job {job_id}: {last_payload}")
