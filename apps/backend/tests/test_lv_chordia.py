from __future__ import annotations

import hashlib
import socket
from pathlib import Path
from typing import Any

import pytest

from app.engines import lv_chordia as engine

lv_chordia = pytest.importorskip("lv_chordia")


@pytest.fixture(autouse=True)
def clear_sessions() -> None:
    engine.clear_lv_chordia_session_cache()
    yield
    engine.clear_lv_chordia_session_cache()


def test_annotation_normalization_handles_submission_vocabulary_edges() -> None:
    timeline = engine.lv_chordia_annotations_to_timeline(
        [
            {"start_time": 0.0, "end_time": 1.0, "chord": "C:maj7/3"},
            {"start_time": 1.0, "end_time": 2.0, "chord": "C:maj7/3"},
            {"start_time": 2.0, "end_time": 3.0, "chord": "N"},
            {"start_time": 3.0, "end_time": 3.0, "chord": "D:min"},
            {"start_time": "bad", "end_time": 4.0, "chord": "X"},
        ]
    )

    assert len(timeline) == 2
    assert timeline[0]["end_seconds"] == 2.0
    assert timeline[0]["label"] == "Cmaj7/E"
    assert timeline[0]["bass_pitch_class"] == 4
    assert timeline[1]["label"] == "N.C."


@pytest.mark.parametrize("failure", ["missing", "size", "sha256"])
def test_bundled_asset_validation_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure: str,
) -> None:
    payload = b"checkpoint"
    name = "model.sdict"
    model_path = tmp_path / name
    if failure != "missing":
        model_path.write_bytes(payload if failure != "size" else b"short")
    expected_sha = hashlib.sha256(payload if failure != "sha256" else b"other").hexdigest()
    monkeypatch.setattr(engine, "_EXPECTED_CHECKPOINTS", ((name, len(payload), expected_sha),))

    class FakeSession:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def cache_info(self) -> dict[str, Any]:
            return {
                "path": str(tmp_path),
                "entries": ({"name": name, "path": str(model_path)},),
            }

    monkeypatch.setattr(lv_chordia, "LVChordiaSession", FakeSession)

    invalid = engine.invalid_lv_chordia_model_asset_files()

    assert len(invalid) == 1
    assert invalid[0].reason == failure


def test_reuses_one_session_for_repeated_local_inference(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    audio_path = tmp_path / "fixture.wav"
    audio_path.write_bytes(b"synthetic")
    sessions: list[FakeSession] = []

    class FakeSession:
        def __init__(self, *, chord_dict_name: str, device: str) -> None:
            assert chord_dict_name == "submission"
            self.device = device
            self.load_count = 0
            self.infer_count = 0
            self.release_count = 0
            sessions.append(self)

        def load(self) -> None:
            self.load_count += 1

        def infer(self, path: str, vocabulary: str) -> list[dict[str, Any]]:
            assert Path(path) == audio_path.resolve()
            assert vocabulary == "submission"
            print(f"Inference on {path}")
            self.infer_count += 1
            return [{"start_time": 0.0, "end_time": 1.0, "chord": "C:maj"}]

        def release(self) -> None:
            self.release_count += 1

    monkeypatch.setattr(engine, "invalid_lv_chordia_model_asset_files", lambda: ())
    monkeypatch.setattr(engine, "lv_chordia_runtime_device", lambda: "cpu")
    monkeypatch.setattr(lv_chordia, "LVChordiaSession", FakeSession)

    results = [engine.detect_lv_chordia_timeline(audio_path) for _index in range(10)]

    assert len(sessions) == 1
    assert sessions[0].load_count == 1
    assert sessions[0].infer_count == 10
    assert all(result.runtime_device == "cpu" for result in results)
    assert capsys.readouterr().out == ""


def test_valid_local_inference_attempts_no_outbound_connection(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "fixture.wav"
    audio_path.write_bytes(b"synthetic")

    class FakeSession:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def load(self) -> None:
            pass

        def infer(self, _path: str, _vocabulary: str) -> list[dict[str, Any]]:
            return [{"start_time": 0.0, "end_time": 1.0, "chord": "C:maj"}]

        def release(self) -> None:
            pass

    def fail_outbound(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("LV Chordia inference attempted an outbound connection")

    monkeypatch.setattr(socket, "create_connection", fail_outbound)
    monkeypatch.setattr(engine, "invalid_lv_chordia_model_asset_files", lambda: ())
    monkeypatch.setattr(engine, "lv_chordia_runtime_device", lambda: "cpu")
    monkeypatch.setattr(lv_chordia, "LVChordiaSession", FakeSession)

    assert engine.detect_lv_chordia_timeline(audio_path).segments[0]["label"] == "C"


def test_failed_session_is_released_and_next_call_reloads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "fixture.wav"
    audio_path.write_bytes(b"synthetic")
    sessions: list[FakeSession] = []

    class FakeSession:
        def __init__(self, **_kwargs: Any) -> None:
            self.release_count = 0
            sessions.append(self)

        def load(self) -> None:
            pass

        def infer(self, _path: str, _vocabulary: str) -> list[dict[str, Any]]:
            if len(sessions) == 1:
                raise RuntimeError("cancelled")
            return [{"start_time": 0.0, "end_time": 1.0, "chord": "C:maj"}]

        def release(self) -> None:
            self.release_count += 1

    monkeypatch.setattr(engine, "invalid_lv_chordia_model_asset_files", lambda: ())
    monkeypatch.setattr(engine, "lv_chordia_runtime_device", lambda: "cpu")
    monkeypatch.setattr(lv_chordia, "LVChordiaSession", FakeSession)

    with pytest.raises(RuntimeError, match="cancelled"):
        engine.detect_lv_chordia_timeline(audio_path)
    result = engine.detect_lv_chordia_timeline(audio_path)

    assert len(sessions) == 2
    assert sessions[0].release_count == 1
    assert result.runtime_device == "cpu"


def test_accelerator_allocation_failure_retries_once_on_cpu(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "fixture.wav"
    audio_path.write_bytes(b"synthetic")
    sessions: list[FakeSession] = []

    class FakeSession:
        def __init__(self, *, chord_dict_name: str, device: str) -> None:
            self.device = device
            self.release_count = 0
            sessions.append(self)

        def load(self) -> None:
            pass

        def infer(self, _path: str, _vocabulary: str) -> list[dict[str, Any]]:
            if self.device == "mps":
                raise RuntimeError("MPS backend out of memory")
            return [{"start_time": 0.0, "end_time": 1.0, "chord": "C:maj"}]

        def release(self) -> None:
            self.release_count += 1

    monkeypatch.setattr(engine, "invalid_lv_chordia_model_asset_files", lambda: ())
    monkeypatch.setattr(engine, "lv_chordia_runtime_device", lambda: "mps")
    monkeypatch.setattr(lv_chordia, "LVChordiaSession", FakeSession)

    result = engine.detect_lv_chordia_timeline(audio_path)

    assert [session.device for session in sessions] == ["mps", "cpu"]
    assert sessions[0].release_count == 1
    assert result.runtime_device == "cpu"
    assert result.accelerator_fallback_from == "mps"


def test_requires_existing_local_file_before_session_use(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="existing local audio file"):
        engine.detect_lv_chordia_timeline(tmp_path / "https://example.invalid/audio.wav")
