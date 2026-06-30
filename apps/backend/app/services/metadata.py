from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from fastapi import status

from app.config import get_settings
from app.dependency_diagnostics import missing_host_tool_error
from app.errors import AppError


def extract_audio_metadata(source_path: Path) -> dict[str, Any]:
    if not source_path.exists():
        raise AppError(
            "INVALID_REQUEST",
            f"Source file does not exist: {source_path}",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    command = [
        get_settings().ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate,channels",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(source_path),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise missing_host_tool_error(
            tool="ffprobe",
            operation="metadata_extraction",
            impact="inspect audio metadata before import",
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise AppError(
            "UNSUPPORTED_AUDIO_FORMAT",
            "Could not read audio metadata from the provided file.",
            status_code=status.HTTP_400_BAD_REQUEST,
        ) from exc

    payload = json.loads(result.stdout or "{}")
    stream = (payload.get("streams") or [{}])[0]
    fmt = payload.get("format") or {}
    duration = fmt.get("duration")
    return {
        "duration_seconds": float(duration) if duration is not None else None,
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
        "channels": int(stream["channels"]) if stream.get("channels") else None,
    }


def normalize_audio_to_wav(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        get_settings().ffmpeg_path,
        "-y",
        "-i",
        str(source_path),
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "pcm_s16le",
        str(destination_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise missing_host_tool_error(
            tool="ffmpeg",
            operation="audio_import_normalization",
            impact="prepare imported audio for local processing",
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise AppError(
            "PROCESSING_FAILED",
            "Could not normalize imported audio to WAV.",
            status_code=status.HTTP_400_BAD_REQUEST,
        ) from exc
