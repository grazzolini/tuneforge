from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from fastapi import status

from app.errors import AppError, JobCancelledError
from app.utils.torch_runtime import choose_torch_device, with_mps_fallback_env

LYRICS_WORKER_CANCEL_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True)
class LyricsTranscription:
    backend: str
    requested_device: str
    device: str
    model: str
    language: str | None
    segments: list[dict[str, Any]]


def lyrics_transcription_to_payload(transcription: LyricsTranscription) -> dict[str, Any]:
    return {
        "backend": transcription.backend,
        "requested_device": transcription.requested_device,
        "device": transcription.device,
        "model": transcription.model,
        "language": transcription.language,
        "segments": transcription.segments,
    }


def lyrics_transcription_from_payload(payload: dict[str, Any]) -> LyricsTranscription:
    language = payload.get("language")
    return LyricsTranscription(
        backend=str(payload.get("backend", "openai-whisper")),
        requested_device=str(payload.get("requested_device", "auto")),
        device=str(payload.get("device", "cpu")),
        model=str(payload.get("model", "")),
        language=language if isinstance(language, str) else None,
        segments=cast(list[dict[str, Any]], payload.get("segments", [])),
    )


def _require_dependency(module_name: str, message: str) -> None:
    if importlib.util.find_spec(module_name) is None:
        raise AppError(
            "DEPENDENCY_MISSING",
            message,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


def patch_whisper_timing_for_mps(timing_module: Any) -> None:
    if getattr(timing_module.dtw, "_tuneforge_mps_patch", False):
        return

    original_dtw = timing_module.dtw

    def _patched_dtw(x: Any) -> Any:
        device_type = getattr(getattr(x, "device", None), "type", None)
        if device_type == "mps":
            return timing_module.dtw_cpu(x.float().cpu().numpy())
        return original_dtw(x)

    patched_dtw = cast(Any, _patched_dtw)
    patched_dtw._tuneforge_mps_patch = True
    timing_module.dtw = patched_dtw


def _load_runtime() -> tuple[Any, Any]:
    _require_dependency("torch", "PyTorch is required for lyrics generation. Install the backend dependencies first.")
    _require_dependency(
        "whisper",
        "openai-whisper is required for lyrics generation. Install the backend dependencies first.",
    )
    os.environ.update(with_mps_fallback_env(os.environ))
    import torch  # type: ignore[import-not-found]
    import whisper  # type: ignore[import-not-found]
    from whisper import timing as whisper_timing  # type: ignore[import-not-found]

    patch_whisper_timing_for_mps(whisper_timing)

    return torch, whisper


CUDA_MODEL_FALLBACKS: dict[str, tuple[str, ...]] = {
    "turbo": ("small", "base"),
    "large-v3-turbo": ("small", "base"),
    "large": ("small", "base"),
    "large-v3": ("small", "base"),
    "large-v2": ("small", "base"),
    "large-v1": ("small", "base"),
    "medium": ("small", "base"),
    "small": ("base",),
}


def resolve_whisper_device_candidates(requested: str, *, torch_module: Any) -> list[str]:
    normalized = requested.strip().lower()
    if normalized == "auto":
        primary = choose_torch_device("auto", torch_module=torch_module)
        return [primary] if primary == "cpu" else [primary, "cpu"]
    if normalized == "cpu":
        return ["cpu"]
    try:
        resolved = choose_torch_device(normalized, torch_module=torch_module)
        return [resolved] if resolved == "cpu" else [resolved, "cpu"]
    except ValueError as exc:
        raise AppError("INVALID_REQUEST", str(exc), status_code=status.HTTP_400_BAD_REQUEST) from exc
    except RuntimeError:
        return ["cpu"]


def _coerce_float(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _normalize_segments(raw_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for raw_segment in raw_segments:
        text = str(raw_segment.get("text", "")).strip()
        if not text:
            continue

        segment: dict[str, Any] = {
            "start_seconds": _coerce_float(raw_segment.get("start")),
            "end_seconds": _coerce_float(raw_segment.get("end")),
            "text": text,
        }

        words: list[dict[str, Any]] = []
        for raw_word in raw_segment.get("words") or []:
            word_text = str(raw_word.get("word", "")).strip()
            if not word_text:
                continue
            words.append(
                {
                    "text": word_text,
                    "start_seconds": _coerce_float(raw_word.get("start")),
                    "end_seconds": _coerce_float(raw_word.get("end")),
                    "confidence": _coerce_float(raw_word.get("probability")),
                }
            )

        if words:
            segment["words"] = words
        segments.append(segment)
    return segments


def resolve_whisper_model_candidates(model_name: str, *, device: str) -> list[str]:
    if device != "cuda":
        return [model_name]
    fallbacks = CUDA_MODEL_FALLBACKS.get(model_name, ())
    return [model_name, *fallbacks]


def _is_cuda_memory_error(error: Exception) -> bool:
    message = str(error).lower()
    return "out of memory" in message or "cuda error: out of memory" in message


def _clear_cuda_cache(torch_module: Any) -> None:
    cuda = getattr(torch_module, "cuda", None)
    empty_cache = getattr(cuda, "empty_cache", None)
    if callable(empty_cache):
        empty_cache()


def _transcribe_with_device(
    source_path: Path,
    *,
    requested_device: str,
    model_name: str,
    device: str,
    download_root: Path,
    whisper_module: Any,
) -> LyricsTranscription:
    model = whisper_module.load_model(model_name, device=device, download_root=str(download_root))
    result = whisper_module.transcribe(
        model,
        str(source_path),
        verbose=False,
        condition_on_previous_text=False,
        word_timestamps=True,
        fp16=device == "cuda",
    )
    segments = _normalize_segments(result.get("segments", []))
    return LyricsTranscription(
        backend="openai-whisper",
        requested_device=requested_device,
        device=device,
        model=model_name,
        language=result.get("language"),
        segments=segments,
    )


def transcribe_project_lyrics_in_process(
    source_path: Path,
    *,
    model_name: str,
    requested_device: str,
    download_root: Path,
) -> LyricsTranscription:
    torch_module, whisper_module = _load_runtime()
    candidates = resolve_whisper_device_candidates(requested_device, torch_module=torch_module)
    errors: list[dict[str, str]] = []

    for device in candidates:
        model_candidates = resolve_whisper_model_candidates(model_name, device=device)
        for index, candidate_model in enumerate(model_candidates):
            try:
                return _transcribe_with_device(
                    source_path,
                    requested_device=requested_device,
                    model_name=candidate_model,
                    device=device,
                    download_root=download_root,
                    whisper_module=whisper_module,
                )
            except AppError:
                raise
            except Exception as exc:  # pragma: no cover - defensive fallback around whisper runtime
                errors.append({"device": device, "model": candidate_model, "message": str(exc)})
                should_retry_smaller_cuda_model = (
                    device == "cuda"
                    and index < len(model_candidates) - 1
                    and _is_cuda_memory_error(exc)
                )
                if should_retry_smaller_cuda_model:
                    _clear_cuda_cache(torch_module)
                    continue
                break
        if device == "cpu":
            break

    raise AppError(
        "PROCESSING_FAILED",
        "Lyrics generation failed.",
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        details={"errors": errors},
    )


def _worker_payload_from_stdout(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _terminate_cancelled_worker(process: subprocess.Popen[str]) -> None:
    process.terminate()
    try:
        process.wait(timeout=LYRICS_WORKER_CANCEL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=LYRICS_WORKER_CANCEL_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            pass


def _raise_worker_failure(
    payload: dict[str, Any] | None,
    *,
    stdout: str,
    stderr: str,
) -> None:
    error = payload.get("error") if payload else None
    if isinstance(error, dict):
        code = str(error.get("code", "PROCESSING_FAILED"))
        message = str(error.get("message", "Lyrics generation failed."))
        status_code = error.get("status_code")
        details = error.get("details")
        raise AppError(
            code,
            message,
            status_code=status_code if isinstance(status_code, int) else status.HTTP_500_INTERNAL_SERVER_ERROR,
            details=details if isinstance(details, dict) else {},
        )

    raise AppError(
        "PROCESSING_FAILED",
        "Lyrics generation failed.",
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        details={"stdout": stdout.strip(), "stderr": stderr.strip()},
    )


def transcribe_project_lyrics(
    source_path: Path,
    *,
    model_name: str,
    requested_device: str,
    download_root: Path,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> LyricsTranscription:
    if should_cancel and should_cancel():
        raise JobCancelledError()

    command = [
        sys.executable,
        "-m",
        "app.engines.lyrics_worker",
        "--source",
        str(source_path),
        "--model",
        model_name,
        "--requested-device",
        requested_device,
        "--download-root",
        str(download_root),
    ]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=with_mps_fallback_env(os.environ),
    )
    if register_process:
        register_process(process)

    try:
        while process.poll() is None:
            if should_cancel and should_cancel():
                _terminate_cancelled_worker(process)
                raise JobCancelledError()
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass

        stdout, stderr = process.communicate()
        if should_cancel and should_cancel():
            raise JobCancelledError()

        payload = _worker_payload_from_stdout(stdout)
        if process.returncode != 0:
            _raise_worker_failure(payload, stdout=stdout, stderr=stderr)

        transcription_payload = payload.get("transcription") if payload else None
        if not isinstance(transcription_payload, dict):
            raise AppError(
                "PROCESSING_FAILED",
                "Lyrics generation failed.",
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                details={"stdout": stdout.strip(), "stderr": stderr.strip()},
            )
        return lyrics_transcription_from_payload(transcription_payload)
    finally:
        if unregister_process:
            unregister_process()
        if process.poll() is None:
            process.kill()
