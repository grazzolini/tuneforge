from __future__ import annotations

import builtins
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.dependency_diagnostics import (
    DEMUCS_DEPENDENCY_REMEDIATION,
    HOST_FFMPEG_REMEDIATION,
    WHISPER_DEPENDENCY_REMEDIATION,
)
from app.engines import lyrics, stems, transform
from app.errors import AppError
from app.services import metadata
from app.services.stem_models import resolve_stem_model


def test_missing_ffprobe_returns_host_tool_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"not inspected")

    def fail_run(*_args: object, **_kwargs: object) -> object:
        raise FileNotFoundError("ffprobe")

    monkeypatch.setattr(metadata.subprocess, "run", fail_run)

    with pytest.raises(AppError) as exc_info:
        metadata.extract_audio_metadata(source_path)

    assert exc_info.value.code == "DEPENDENCY_MISSING"
    assert exc_info.value.message == (
        "ffprobe is missing, so TuneForge cannot inspect audio metadata before import."
    )
    assert exc_info.value.details == {
        "dependency": "ffprobe",
        "operation": "metadata extraction",
        "remediation": HOST_FFMPEG_REMEDIATION,
    }


def test_missing_ffmpeg_transform_returns_host_tool_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_popen(*_args: object, **_kwargs: object) -> object:
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(transform.subprocess, "Popen", fail_popen)

    with pytest.raises(AppError) as exc_info:
        transform.run_ffmpeg_transform(
            tmp_path / "source.wav",
            tmp_path / "output.wav",
            sample_rate=44_100,
            total_cents=100.0,
            output_format="wav",
        )

    assert exc_info.value.message == "ffmpeg is missing, so TuneForge cannot create transformed audio."
    assert exc_info.value.details == {
        "dependency": "ffmpeg",
        "operation": "audio transform",
        "remediation": HOST_FFMPEG_REMEDIATION,
    }


def test_demucs_worker_failure_reports_safe_cache_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeDemucsProcess:
        returncode = 1
        stdout = None
        stderr = None

        def poll(self) -> int:
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return "", "sha256 mismatch in /Users/private/.cache/torch/checkpoints/model.th"

        def kill(self) -> None:
            raise AssertionError("completed process should not be killed")

    monkeypatch.setattr(stems.importlib.util, "find_spec", lambda _name: object())
    monkeypatch.setattr(stems.subprocess, "Popen", lambda *_args, **_kwargs: FakeDemucsProcess())

    with pytest.raises(AppError) as exc_info:
        stems.separate_two_stems(
            tmp_path / "source.wav",
            tmp_path / "vocals.wav",
            tmp_path / "instrumental.wav",
            model="htdemucs_ft",
        )

    assert exc_info.value.message == "Demucs model cache is corrupt, so TuneForge cannot separate stems."
    assert exc_info.value.details == {
        "dependency": "demucs",
        "operation": "stem separation",
        "remediation": "Re-run local setup to replace Demucs model assets, then retry stem separation.",
        "cache_status": "corrupt",
    }
    assert "/Users/private" not in str(exc_info.value.details)


def test_demucs_worker_missing_torch_reports_dependency_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeDemucsProcess:
        returncode = 1
        stdout = None
        stderr = None

        def poll(self) -> int:
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return "", "ModuleNotFoundError: No module named 'torch'"

        def kill(self) -> None:
            raise AssertionError("completed process should not be killed")

    monkeypatch.setattr(stems.importlib.util, "find_spec", lambda _name: object())
    monkeypatch.setattr(stems.subprocess, "Popen", lambda *_args, **_kwargs: FakeDemucsProcess())

    with pytest.raises(AppError) as exc_info:
        stems.separate_two_stems(
            tmp_path / "source.wav",
            tmp_path / "vocals.wav",
            tmp_path / "instrumental.wav",
            model="htdemucs_ft",
        )

    assert exc_info.value.code == "DEPENDENCY_MISSING"
    assert exc_info.value.message == "Demucs is unavailable, so TuneForge cannot separate stems."
    assert exc_info.value.details == {
        "dependency": "pytorch",
        "operation": "stem separation",
        "remediation": DEMUCS_DEPENDENCY_REMEDIATION,
    }


def test_whisper_missing_runtime_reports_safe_dependency_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        lyrics.importlib.util,
        "find_spec",
        lambda module_name: object() if module_name == "torch" else None,
    )

    with pytest.raises(AppError) as exc_info:
        lyrics.transcribe_project_lyrics_in_process(
            tmp_path / "source.wav",
            model_name="turbo",
            requested_device="cpu",
            download_root=tmp_path / "whisper-cache",
        )

    assert exc_info.value.message == "Whisper is unavailable, so TuneForge cannot generate lyrics."
    assert exc_info.value.details == {
        "dependency": "openai-whisper",
        "operation": "lyrics generation",
        "remediation": "Install the local backend lyrics dependencies, then retry lyrics generation.",
    }


def test_whisper_torch_import_failure_reports_dependency_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_import = builtins.__import__

    def fake_import(
        name: str,
        globals: dict[str, object] | None = None,
        locals: dict[str, object] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ) -> object:
        if name == "torch":
            raise ImportError("dlopen(/Users/private/libtorch.dylib): Library not loaded")
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(lyrics.importlib.util, "find_spec", lambda _name: object())
    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(AppError) as exc_info:
        lyrics.transcribe_project_lyrics_in_process(
            tmp_path / "source.wav",
            model_name="turbo",
            requested_device="cpu",
            download_root=tmp_path / "whisper-cache",
        )

    assert exc_info.value.code == "DEPENDENCY_MISSING"
    assert exc_info.value.details == {
        "dependency": "pytorch",
        "operation": "lyrics generation",
        "remediation": WHISPER_DEPENDENCY_REMEDIATION,
    }
    assert "/Users/private" not in str(exc_info.value.details)


def test_whisper_import_failure_reports_dependency_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_import = builtins.__import__
    fake_torch = SimpleNamespace()

    def fake_import(
        name: str,
        globals: dict[str, object] | None = None,
        locals: dict[str, object] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ) -> object:
        if name == "torch":
            return fake_torch
        if name == "whisper":
            raise ModuleNotFoundError("No module named 'tiktoken'")
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(lyrics.importlib.util, "find_spec", lambda _name: object())
    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(AppError) as exc_info:
        lyrics.transcribe_project_lyrics_in_process(
            tmp_path / "source.wav",
            model_name="turbo",
            requested_device="cpu",
            download_root=tmp_path / "whisper-cache",
        )

    assert exc_info.value.code == "DEPENDENCY_MISSING"
    assert exc_info.value.details == {
        "dependency": "openai-whisper",
        "operation": "lyrics generation",
        "remediation": WHISPER_DEPENDENCY_REMEDIATION,
    }


def test_whisper_runtime_failure_reports_safe_cache_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        cuda=SimpleNamespace(is_available=lambda: False),
    )

    class FakeWhisper:
        def load_model(self, *_args: object, **_kwargs: object) -> object:
            raise RuntimeError("checksum mismatch in /Users/private/.cache/whisper/turbo.pt")

    monkeypatch.setattr(lyrics, "_load_runtime", lambda: (fake_torch, FakeWhisper()))

    with pytest.raises(AppError) as exc_info:
        lyrics.transcribe_project_lyrics_in_process(
            tmp_path / "source.wav",
            model_name="turbo",
            requested_device="cpu",
            download_root=tmp_path / "whisper-cache",
        )

    assert exc_info.value.message == "Whisper model cache is corrupt, so TuneForge cannot generate lyrics."
    assert exc_info.value.details == {
        "dependency": "whisper",
        "operation": "lyrics generation",
        "remediation": "Re-run local setup to replace the Whisper model asset, then retry lyrics generation.",
        "cache_status": "corrupt",
    }
    assert "/Users/private" not in str(exc_info.value.details)


def test_lyrics_worker_dependency_payload_remains_dependency_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeLyricsProcess:
        returncode = 1
        stdout = None
        stderr = None

        def poll(self) -> int:
            return self.returncode

        def communicate(self) -> tuple[str, str]:
            return (
                json.dumps(
                    {
                        "ok": False,
                        "error": {
                            "code": "DEPENDENCY_MISSING",
                            "message": "Whisper is unavailable, so TuneForge cannot generate lyrics.",
                            "status_code": 500,
                            "details": {
                                "dependency": "pytorch",
                                "operation": "lyrics generation",
                                "remediation": WHISPER_DEPENDENCY_REMEDIATION,
                            },
                        },
                    }
                ),
                "private stderr should stay ignored",
            )

        def kill(self) -> None:
            raise AssertionError("completed process should not be killed")

    monkeypatch.setattr(lyrics.subprocess, "Popen", lambda *_args, **_kwargs: FakeLyricsProcess())

    with pytest.raises(AppError) as exc_info:
        lyrics.transcribe_project_lyrics(
            tmp_path / "source.wav",
            model_name="turbo",
            requested_device="cpu",
            download_root=tmp_path / "whisper-cache",
        )

    assert exc_info.value.code == "DEPENDENCY_MISSING"
    assert exc_info.value.message == "Whisper is unavailable, so TuneForge cannot generate lyrics."
    assert exc_info.value.details == {
        "dependency": "pytorch",
        "operation": "lyrics generation",
        "remediation": WHISPER_DEPENDENCY_REMEDIATION,
    }


def test_configured_demucs_cache_error_details_use_safe_fields(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TUNEFORGE_DEMUCS_MODEL_REPO", str(tmp_path / "missing-demucs"))
    from app.config import get_settings

    get_settings.cache_clear()

    with pytest.raises(AppError) as exc_info:
        resolve_stem_model("htdemucs_6s", require_available=True)

    assert exc_info.value.message == (
        "Bundled Demucs model assets are missing, so TuneForge cannot separate stems."
    )
    assert exc_info.value.details == {
        "dependency": "demucs",
        "operation": "stem separation",
        "remediation": "Re-run local setup to download Demucs model assets, then retry stem separation.",
        "cache_status": "missing",
    }
    assert str(tmp_path) not in str(exc_info.value.details)
