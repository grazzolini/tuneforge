from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from fastapi import status

from app.errors import AppError


def extract_audio_metadata(source_path: Path) -> dict[str, Any]:
    if not source_path.exists():
        raise AppError(
            "INVALID_REQUEST",
            f"Source file does not exist: {source_path}",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    command = [
        "ffprobe",
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
        raise AppError(
            "DEPENDENCY_MISSING",
            "ffprobe is required for metadata extraction.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise AppError(
            "UNSUPPORTED_AUDIO_FORMAT",
            "Could not read audio metadata from the provided file.",
            status_code=status.HTTP_400_BAD_REQUEST,
            details={"stderr": exc.stderr.strip()},
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


def normalize_media_to_wav(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-vn",
        str(destination_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise AppError(
            "DEPENDENCY_MISSING",
            "ffmpeg is required to import mp4 and webm sources.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise AppError(
            "PROCESSING_FAILED",
            "Could not extract audio from the imported media file.",
            status_code=status.HTTP_400_BAD_REQUEST,
            details={"stderr": exc.stderr.strip()},
        ) from exc
