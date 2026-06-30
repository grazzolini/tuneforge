from __future__ import annotations

import json
import subprocess
import sys
from io import StringIO
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from app.db import SessionLocal
from app.engines.lyrics import (
    LyricsTranscription,
    _observe_whisper_tqdm_progress,
    _start_output_reader,
    _transcribe_with_device,
    patch_whisper_timing_for_mps,
    resolve_whisper_device_candidates,
    resolve_whisper_model_candidates,
    transcribe_project_lyrics,
    transcribe_project_lyrics_in_process,
)
from app.errors import AppError, JobCancelledError
from app.models import Job
from app.runtime_status import JOB_RUNTIME_EVENT_TYPE, runtime_event_payload
from app.services.jobs import InProcessJobRunner, JobExecutionContext


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
        on_runtime_event: object = None,
        progress_min: int = 20,
        progress_max: int = 85,
    ) -> LyricsTranscription:
        del on_runtime_event, progress_min, progress_max
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
        on_runtime_event: object = None,
        progress_min: int = 20,
        progress_max: int = 85,
    ) -> LyricsTranscription:
        del on_runtime_event, progress_min, progress_max
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


def test_transcribe_project_lyrics_retry_progress_advances_persisted_job(
    client: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del client

    class FakeProgressBar:
        def __init__(self, *, total: int) -> None:
            self.total = total
            self.n = 0

        def __enter__(self) -> FakeProgressBar:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def update(self, n: int = 1) -> None:
            self.n += n

    class FakeWhisper:
        def __init__(self) -> None:
            self.tqdm = SimpleNamespace(tqdm=FakeProgressBar)

        def load_model(self, model_name: str, *, device: str, download_root: str) -> tuple[str, str]:
            del download_root
            return model_name, device

        def transcribe(self, model: tuple[str, str], source_path: str, **kwargs: object) -> dict[str, object]:
            del source_path, kwargs
            _model_name, device = model
            with self.tqdm.tqdm(total=100) as progress_bar:
                if device == "mps":
                    progress_bar.update(95)
                    raise RuntimeError("MPS kernel failed")
                progress_bar.update(5)
            return {
                "language": "en",
                "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
            }

    monkeypatch.setattr(
        "app.engines.lyrics._load_runtime",
        lambda: (make_fake_torch(has_mps=True, has_cuda=False), FakeWhisper()),
    )
    runner = InProcessJobRunner(SessionLocal)
    with SessionLocal() as session:
        job = runner.create_job(session, project_id=None, job_type="test", payload={})
        job_id = job.id
        job.status = "running"
        session.commit()

    persisted_progress: list[int] = []

    def capture_runtime_event(payload: dict[str, object]) -> None:
        with SessionLocal() as session:
            context = JobExecutionContext(runner, job_id, session)
            context.handle_runtime_event(payload)
        if payload.get("progress") is None:
            return
        with SessionLocal() as session:
            persisted_job = session.get(Job, job_id)
            assert persisted_job is not None
            persisted_progress.append(persisted_job.progress)

    result = transcribe_project_lyrics_in_process(
        Path("/tmp/fake.wav"),
        model_name="turbo",
        requested_device="auto",
        download_root=Path("/tmp/lyrics-cache"),
        on_runtime_event=capture_runtime_event,
    )

    assert result.device == "cpu"
    assert result.segments[0]["text"] == "hello"
    assert persisted_progress == [20, 50, 52, 53]
    assert persisted_progress[-1] > persisted_progress[1]


def test_observe_whisper_tqdm_progress_maps_updates_to_runtime_events(monkeypatch: pytest.MonkeyPatch):
    class FakeProgressBar:
        def __init__(self, *, total: int) -> None:
            self.total = total
            self.n = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def update(self, n: int = 1) -> None:
            self.n += n

    transcribe_module = ModuleType("fake_whisper_transcribe_progress")
    transcribe_module.tqdm = SimpleNamespace(tqdm=FakeProgressBar)

    def fake_transcribe() -> None:
        return None

    fake_transcribe.__module__ = transcribe_module.__name__
    monkeypatch.setitem(sys.modules, transcribe_module.__name__, transcribe_module)
    whisper_module = SimpleNamespace(transcribe=fake_transcribe, tqdm=SimpleNamespace(tqdm=object()))
    original_tqdm = transcribe_module.tqdm.tqdm
    events: list[dict[str, object]] = []

    with _observe_whisper_tqdm_progress(whisper_module, on_runtime_event=events.append, device="cpu"):
        with transcribe_module.tqdm.tqdm(total=10) as progress_bar:
            progress_bar.update(1)
            progress_bar.update(4)
            progress_bar.update(5)

    assert transcribe_module.tqdm.tqdm is original_tqdm
    assert [event["progress"] for event in events] == [26, 52, 85]
    assert {event["stage"] for event in events} == {"processing"}
    assert {event["stage_label"] for event in events} == {"Transcribing lyrics on CPU."}
    assert {event["runtime_device"] for event in events} == {"cpu"}


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


def test_transcribe_with_device_first_use_loads_whisper_with_download_root(tmp_path: Path):
    calls: list[tuple[str, str, str]] = []

    class FakeWhisper:
        def load_model(self, model_name: str, *, device: str, download_root: str) -> str:
            calls.append((model_name, device, download_root))
            return "model"

        def transcribe(self, model: str, source_path: str, **kwargs: object) -> dict[str, object]:
            del model, source_path, kwargs
            return {
                "language": "en",
                "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
            }

    result = _transcribe_with_device(
        Path("/tmp/fake.wav"),
        requested_device="auto",
        model_name="tiny",
        device="cpu",
        download_root=tmp_path,
        whisper_module=FakeWhisper(),
    )

    assert calls == [("tiny", "cpu", str(tmp_path))]
    assert result.segments[0]["text"] == "hello"


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


def test_lyrics_output_reader_streams_only_runtime_events():
    runtime_payload = runtime_event_payload(
        stage="processing",
        stage_label="Transcribing lyrics on CPU.",
        runtime_device="cpu",
        progress=45,
    )
    pipe = StringIO(
        "\n".join(
            [
                "debug: /Users/private/song.wav",
                json.dumps({"text": "raw lyric that must not become status"}),
                json.dumps(runtime_payload),
                json.dumps({"type": JOB_RUNTIME_EVENT_TYPE, "stage_label": "/tmp/private.wav"}),
            ]
        )
        + "\n"
    )
    lines: list[str] = []
    events: list[dict[str, object]] = []

    thread = _start_output_reader(pipe, lines, events.append)

    assert thread is not None
    thread.join(timeout=1)
    assert events == [
        runtime_payload,
        {"type": JOB_RUNTIME_EVENT_TYPE, "stage_label": "/tmp/private.wav"},
    ]
    assert any("raw lyric" in line for line in lines)


def test_transcribe_project_lyrics_failure_does_not_expose_raw_worker_output(monkeypatch):
    class FakeProcess:
        returncode = 1

        def poll(self) -> int:
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return "/Users/private/song.wav\nraw lyric", "stderr with private path"

        def kill(self) -> None:
            raise AssertionError("completed process should not be killed")

    monkeypatch.setattr("app.engines.lyrics.subprocess.Popen", lambda *_args, **_kwargs: FakeProcess())

    with pytest.raises(AppError) as exc_info:
        transcribe_project_lyrics(
            Path("/tmp/fake.wav"),
            model_name="turbo",
            requested_device="auto",
            download_root=Path("/tmp/lyrics-cache"),
        )

    assert exc_info.value.message == "Lyrics generation failed."
    assert exc_info.value.details == {}


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
