from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, cast

from app.config import get_settings
from app.dependency_diagnostics import missing_host_tool_error
from app.errors import AppError, JobCancelledError

DurableAudioFormat = Literal["wav", "flac", "mp3", "m4a"]
DURABLE_AUDIO_FORMATS: tuple[DurableAudioFormat, ...] = ("wav", "flac", "mp3", "m4a")

ENCODING_PROFILES: dict[DurableAudioFormat, tuple[str, ...]] = {
    "wav": ("-c:a", "pcm_s16le"),
    "flac": ("-c:a", "flac", "-compression_level", "5"),
    "mp3": ("-c:a", "libmp3lame", "-b:a", "192k"),
    "m4a": ("-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k", "-f", "mp4"),
}

_ENCODING_REQUIREMENTS: dict[DurableAudioFormat, tuple[str, str]] = {
    "wav": ("pcm_s16le", "wav"),
    "flac": ("flac", "flac"),
    "mp3": ("libmp3lame", "mp3"),
    "m4a": ("aac", "mp4"),
}


@lru_cache(maxsize=1)
def probe_encoding_formats() -> dict[DurableAudioFormat, tuple[bool, str | None]]:
    ffmpeg_path = get_settings().ffmpeg_path
    try:
        encoders = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
        muxers = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-muxers"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        reason = "Configured FFmpeg is unavailable."
        return {output_format: (False, reason) for output_format in DURABLE_AUDIO_FORMATS}

    capabilities: dict[DurableAudioFormat, tuple[bool, str | None]] = {}
    for output_format, (encoder, muxer) in _ENCODING_REQUIREMENTS.items():
        encoder_available = any(
            len(parts) >= 2 and parts[1] == encoder
            for line in encoders.splitlines()
            if (parts := line.split())
        )
        muxer_available = any(
            len(parts) >= 2 and muxer in parts[1].split(",")
            for line in muxers.splitlines()
            if (parts := line.split())
        )
        available = encoder_available and muxer_available
        capabilities[output_format] = (
            available,
            None if available else f"Configured FFmpeg cannot encode {output_format.upper()} audio.",
        )
    return capabilities


def encoding_profile(output_format: str) -> tuple[str, ...]:
    if output_format not in DURABLE_AUDIO_FORMATS:
        raise AppError("INVALID_REQUEST", "Unsupported audio format.", status_code=422)
    return ENCODING_PROFILES[cast(DurableAudioFormat, output_format)]


def require_encoding_available(output_format: DurableAudioFormat) -> None:
    available, reason = probe_encoding_formats()[output_format]
    if not available:
        raise AppError(
            "AUDIO_ENCODING_UNAVAILABLE",
            reason or f"Configured FFmpeg cannot encode {output_format.upper()} audio.",
            status_code=422,
            details={"format": output_format},
        )


def encode_audio(
    source_path: Path,
    destination_path: Path,
    output_format: DurableAudioFormat,
    *,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        get_settings().ffmpeg_path,
        "-y",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "-map",
        "0:a:0",
        "-vn",
        *encoding_profile(output_format),
        str(destination_path),
    ]
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except FileNotFoundError as exc:
        raise missing_host_tool_error(
            tool="ffmpeg",
            operation="audio_encoding",
            impact="encode durable audio",
        ) from exc
    if register_process:
        register_process(process)
    try:
        while process.poll() is None:
            if should_cancel and should_cancel():
                process.terminate()
                raise JobCancelledError()
            try:
                process.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                continue
    finally:
        if unregister_process:
            unregister_process()
    if process.returncode != 0:
        raise AppError("PROCESSING_FAILED", "FFmpeg failed to encode audio.")


def probe_audio_file(path: Path) -> dict[str, Any]:
    command = [
        get_settings().ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,profile,channels,sample_rate",
        "-show_entries",
        "format=format_name",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout or "{}")
    except FileNotFoundError as exc:
        raise missing_host_tool_error(
            tool="ffprobe",
            operation="audio_validation",
            impact="validate encoded audio",
        ) from exc
    except (json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        raise AppError("INVALID_AUDIO_FILE", "Audio file is unreadable.", status_code=422) from exc
    if not isinstance(payload, dict):
        raise AppError("INVALID_AUDIO_FILE", "Audio file is unreadable.", status_code=422)
    return payload


def validate_audio_file(
    path: Path,
    output_format: DurableAudioFormat,
    *,
    require_suffix: bool = True,
) -> None:
    if require_suffix and path.suffix.lower() != f".{output_format}":
        raise AppError("INVALID_AUDIO_FILE", "Audio filename does not match its declared format.", status_code=422)
    payload = probe_audio_file(path)
    streams = payload.get("streams")
    fmt = payload.get("format")
    if not isinstance(streams, list) or not streams or not isinstance(fmt, dict):
        raise AppError("INVALID_AUDIO_FILE", "Audio file is unreadable.", status_code=422)
    stream = streams[0]
    if not isinstance(stream, dict):
        raise AppError("INVALID_AUDIO_FILE", "Audio file is unreadable.", status_code=422)
    codec = stream.get("codec_name")
    profile = stream.get("profile")
    format_name = fmt.get("format_name")
    format_names = (
        {name.strip().lower() for name in format_name.split(",")}
        if isinstance(format_name, str)
        else set()
    )
    expected = {
        "wav": ("pcm_s16le", {"wav"}),
        "flac": ("flac", {"flac"}),
        "mp3": ("mp3", {"mp3"}),
        "m4a": ("aac", {"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}),
    }[output_format]
    try:
        valid_dimensions = int(stream.get("channels", 0)) > 0 and int(stream.get("sample_rate", 0)) > 0
    except (TypeError, ValueError):
        valid_dimensions = False
    valid_profile = output_format != "m4a" or profile == "LC"
    if (
        codec != expected[0]
        or not format_names.intersection(expected[1])
        or not valid_dimensions
        or not valid_profile
    ):
        raise AppError(
            "INVALID_AUDIO_FILE",
            f"Audio file is not valid {output_format.upper()} audio.",
            status_code=422,
        )
