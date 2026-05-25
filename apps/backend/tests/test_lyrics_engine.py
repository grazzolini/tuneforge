from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.engines.lyrics import (
    LyricsTranscription,
    _transcribe_with_device,
    patch_whisper_timing_for_mps,
    resolve_whisper_device_candidates,
    resolve_whisper_model_candidates,
    transcribe_project_lyrics,
    transcribe_project_lyrics_in_process,
)
from app.errors import JobCancelledError


def make_fake_torch(*, has_mps: bool, has_cuda: bool):
    return SimpleNamespace(
        version=SimpleNamespace(cuda="13.0" if has_cuda else None),
        backends=SimpleNamespace(
            mps=SimpleNamespace(
                is_available=lambda: has_mps,
            )
        ),
        cuda=SimpleNamespace(
            is_available=lambda: has_cuda,
            get_arch_list=lambda: ["sm_75"] if has_cuda else [],
            device_count=lambda: 1 if has_cuda else 0,
            get_device_capability=lambda _index: (7, 5),
        ),
    )


def test_resolve_whisper_device_candidates_auto_prefers_mps_then_cpu():
    candidates = resolve_whisper_device_candidates(
        "auto",
        torch_module=make_fake_torch(has_mps=True, has_cuda=False),
    )
    assert candidates == ["mps", "cpu"]


def test_resolve_whisper_device_candidates_requested_unavailable_gpu_falls_back_to_cpu():
    candidates = resolve_whisper_device_candidates(
        "cuda",
        torch_module=make_fake_torch(has_mps=False, has_cuda=False),
    )
    assert candidates == ["cpu"]


def test_resolve_whisper_model_candidates_prefers_smaller_cuda_fallbacks_for_turbo():
    assert resolve_whisper_model_candidates("turbo", device="cuda") == ["turbo", "small", "base"]
    assert resolve_whisper_model_candidates("turbo", device="cpu") == ["turbo"]


def test_patch_whisper_timing_for_mps_uses_float32_cpu_dtw():
    calls: list[tuple[str, object]] = []

    class FakeTensor:
        device = SimpleNamespace(type="mps")

        def float(self):
            calls.append(("float", None))
            return self

        def cpu(self):
            calls.append(("cpu", None))
            return self

        def numpy(self):
            calls.append(("numpy", None))
            return "float32-array"

    def fake_original_dtw(x: object):
        calls.append(("original_dtw", x))
        return "original-result"

    def fake_dtw_cpu(x: object):
        calls.append(("dtw_cpu", x))
        return "patched-result"

    timing_module = SimpleNamespace(
        dtw=fake_original_dtw,
        dtw_cpu=fake_dtw_cpu,
    )

    patch_whisper_timing_for_mps(timing_module)

    result = timing_module.dtw(FakeTensor())

    assert result == "patched-result"
    assert calls == [
        ("float", None),
        ("cpu", None),
        ("numpy", None),
        ("dtw_cpu", "float32-array"),
    ]


def test_patch_whisper_timing_for_mps_keeps_original_dtw_for_non_mps():
    calls: list[tuple[str, object]] = []

    def fake_original_dtw(x: object):
        calls.append(("original_dtw", x))
        return "original-result"

    def fake_dtw_cpu(x: object):
        calls.append(("dtw_cpu", x))
        return "patched-result"

    timing_module = SimpleNamespace(
        dtw=fake_original_dtw,
        dtw_cpu=fake_dtw_cpu,
    )

    patch_whisper_timing_for_mps(timing_module)

    tensor = SimpleNamespace(device=SimpleNamespace(type="cpu"))
    result = timing_module.dtw(tensor)

    assert result == "original-result"
    assert calls == [("original_dtw", tensor)]


def test_transcribe_project_lyrics_falls_back_to_cpu(monkeypatch):
    attempted_devices: list[str] = []

    monkeypatch.setattr(
        "app.engines.lyrics._load_runtime",
        lambda: (make_fake_torch(has_mps=True, has_cuda=False), object()),
    )

    def fake_transcribe_with_device(
        source_path: Path,
        *,
        requested_device: str,
        model_name: str,
        device: str,
        download_root: Path,
        whisper_module: object,
        language_override: str | None = None,
    ) -> LyricsTranscription:
        attempted_devices.append(device)
        if device == "mps":
            raise RuntimeError("MPS kernel failed")
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device=requested_device,
            device=device,
            model=model_name,
            language="en",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.5,
                    "text": "Hello world",
                }
            ],
        )

    monkeypatch.setattr("app.engines.lyrics._transcribe_with_device", fake_transcribe_with_device)

    result = transcribe_project_lyrics_in_process(
        Path("/tmp/fake.wav"),
        model_name="turbo",
        requested_device="auto",
        download_root=Path("/tmp/lyrics-cache"),
    )

    assert attempted_devices == ["mps", "cpu"]
    assert result.device == "cpu"
    assert result.segments[0]["text"] == "Hello world"


def test_transcribe_project_lyrics_retries_smaller_model_on_cuda_oom(monkeypatch):
    attempts: list[tuple[str, str]] = []

    monkeypatch.setattr(
        "app.engines.lyrics._load_runtime",
        lambda: (make_fake_torch(has_mps=False, has_cuda=True), object()),
    )

    def fake_transcribe_with_device(
        source_path: Path,
        *,
        requested_device: str,
        model_name: str,
        device: str,
        download_root: Path,
        whisper_module: object,
        language_override: str | None = None,
    ) -> LyricsTranscription:
        attempts.append((device, model_name))
        if model_name == "turbo":
            raise RuntimeError("CUDA out of memory")
        return LyricsTranscription(
            backend="openai-whisper",
            requested_device=requested_device,
            device=device,
            model=model_name,
            language="pt",
            segments=[
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "Ola",
                }
            ],
        )

    monkeypatch.setattr("app.engines.lyrics._transcribe_with_device", fake_transcribe_with_device)

    result = transcribe_project_lyrics_in_process(
        Path("/tmp/fake.wav"),
        model_name="turbo",
        requested_device="auto",
        download_root=Path("/tmp/lyrics-cache"),
    )

    assert attempts == [("cuda", "turbo"), ("cuda", "small")]
    assert result.device == "cuda"
    assert result.model == "small"
    assert result.requested_device == "auto"


def test_transcribe_with_device_omits_language_for_auto_detect():
    class FakeWhisper:
        def __init__(self) -> None:
            self.transcribe_kwargs: dict[str, object] | None = None

        def load_model(self, model_name: str, *, device: str, download_root: str) -> str:
            return f"{model_name}:{device}:{download_root}"

        def transcribe(self, model: str, source_path: str, **kwargs: object) -> dict[str, object]:
            self.transcribe_kwargs = kwargs
            return {
                "language": None,
                "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
            }

    whisper = FakeWhisper()

    result = _transcribe_with_device(
        Path("/tmp/fake.wav"),
        requested_device="auto",
        model_name="turbo",
        device="cpu",
        download_root=Path("/tmp/lyrics-cache"),
        whisper_module=whisper,
    )

    assert whisper.transcribe_kwargs is not None
    assert "language" not in whisper.transcribe_kwargs
    assert result.language is None
    assert result.language_override is None


def test_transcribe_with_device_passes_language_override_and_falls_back_to_it():
    class FakeWhisper:
        def __init__(self) -> None:
            self.transcribe_kwargs: dict[str, object] | None = None

        def load_model(self, model_name: str, *, device: str, download_root: str) -> str:
            return f"{model_name}:{device}:{download_root}"

        def transcribe(self, model: str, source_path: str, **kwargs: object) -> dict[str, object]:
            self.transcribe_kwargs = kwargs
            return {
                "language": None,
                "segments": [{"start": 0.0, "end": 1.0, "text": "ola"}],
            }

    whisper = FakeWhisper()

    result = _transcribe_with_device(
        Path("/tmp/fake.wav"),
        requested_device="auto",
        model_name="turbo",
        device="cpu",
        download_root=Path("/tmp/lyrics-cache"),
        whisper_module=whisper,
        language_override="pt",
    )

    assert whisper.transcribe_kwargs is not None
    assert whisper.transcribe_kwargs["language"] == "pt"
    assert result.language == "pt"
    assert result.language_override == "pt"


def test_transcribe_project_lyrics_passes_language_override_to_worker(monkeypatch):
    class FakeProcess:
        returncode = 0

        def poll(self) -> int:
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return (
                json.dumps(
                    {
                        "ok": True,
                        "transcription": {
                            "backend": "openai-whisper",
                            "requested_device": "auto",
                            "device": "cpu",
                            "model": "turbo",
                            "language": "pt",
                            "language_override": "pt",
                            "segments": [],
                        },
                    }
                ),
                "",
            )

        def kill(self) -> None:
            raise AssertionError("completed process should not be killed")

    process = FakeProcess()
    commands: list[list[str]] = []

    def fake_popen(command: list[str], **_kwargs: object) -> FakeProcess:
        commands.append(command)
        return process

    monkeypatch.setattr("app.engines.lyrics.subprocess.Popen", fake_popen)

    result = transcribe_project_lyrics(
        Path("/tmp/fake.wav"),
        model_name="turbo",
        requested_device="auto",
        download_root=Path("/tmp/lyrics-cache"),
        language_override="pt",
    )

    assert commands[0][-2:] == ["--language", "pt"]
    assert result.language == "pt"
    assert result.language_override == "pt"


def test_transcribe_project_lyrics_cancels_subprocess(monkeypatch):
    class FakeProcess:
        returncode: int | None = None

        def __init__(self) -> None:
            self.terminated = False
            self.killed = False
            self.wait_timeouts: list[float | None] = []

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            self.terminated = True

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

        def wait(self, timeout: float | None = None) -> int:
            self.wait_timeouts.append(timeout)
            if self.killed:
                self.returncode = -9
                return self.returncode
            raise subprocess.TimeoutExpired(cmd="lyrics-worker", timeout=timeout or 0)

        def communicate(self) -> tuple[str, str]:
            return "", ""

    process = FakeProcess()
    commands: list[list[str]] = []

    def fake_popen(command: list[str], **_kwargs: object) -> FakeProcess:
        commands.append(command)
        return process

    registered: list[object] = []
    unregistered: list[bool] = []
    cancel_checks = iter([False, True])

    def should_cancel() -> bool:
        return next(cancel_checks, True)

    monkeypatch.setattr("app.engines.lyrics.subprocess.Popen", fake_popen)

    with pytest.raises(JobCancelledError):
        transcribe_project_lyrics(
            Path("/tmp/fake.wav"),
            model_name="turbo",
            requested_device="auto",
            download_root=Path("/tmp/lyrics-cache"),
            should_cancel=should_cancel,
            register_process=registered.append,
            unregister_process=lambda: unregistered.append(True),
        )

    assert commands[0][1:3] == ["-m", "app.engines.lyrics_worker"]
    assert "--language" not in commands[0]
    assert process.terminated is True
    assert process.killed is True
    assert process.wait_timeouts == [2.0, 2.0]
    assert registered == [process]
    assert unregistered == [True]
