from __future__ import annotations

import math
import subprocess
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.dependency_diagnostics import missing_host_tool_error
from app.errors import AppError, JobCancelledError

_EXPORT_PROFILES: dict[str, tuple[str, ...]] = {
    "wav": ("-c:a", "pcm_s16le"),
    "flac": ("-c:a", "flac", "-compression_level", "5"),
    "mp3": ("-c:a", "libmp3lame", "-b:a", "192k"),
    "m4a": ("-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k", "-f", "mp4"),
}

_EXPORT_REQUIREMENTS = {
    "wav": ("pcm_s16le", "wav"),
    "flac": ("flac", "flac"),
    "mp3": ("libmp3lame", "mp3"),
    "m4a": ("aac", "mp4"),
}


@lru_cache(maxsize=1)
def probe_export_formats() -> dict[str, tuple[bool, str | None]]:
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
        return {output_format: (False, reason) for output_format in _EXPORT_PROFILES}

    capabilities: dict[str, tuple[bool, str | None]] = {}
    for output_format, (encoder, muxer) in _EXPORT_REQUIREMENTS.items():
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
            None if available else f"Configured FFmpeg does not support {output_format.upper()} export.",
        )
    return capabilities


def export_profile(output_format: str) -> tuple[str, ...]:
    try:
        return _EXPORT_PROFILES[output_format]
    except KeyError as exc:
        raise AppError("INVALID_REQUEST", "Unsupported export format.", status_code=422) from exc


def _tempo_filters(tempo_ratio: float) -> list[str]:
    filters: list[str] = []
    remaining = tempo_ratio
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    filters.append(f"atempo={remaining:.10f}")
    return filters


def build_pitch_filter(sample_rate: int, total_cents: float) -> str:
    pitch_ratio = 2.0 ** (total_cents / 1200.0)
    filters = [
        f"asetrate={sample_rate}*{pitch_ratio:.10f}",
        f"aresample={sample_rate}",
        *_tempo_filters(1.0 / pitch_ratio),
    ]
    return ",".join(filters)


def run_ffmpeg_transform(
    source_path: Path,
    destination_path: Path,
    sample_rate: int,
    total_cents: float,
    output_format: str,
    *,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    register_process: Callable[[subprocess.Popen[str]], None] | None = None,
    unregister_process: Callable[[], None] | None = None,
) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    filter_graph = build_pitch_filter(sample_rate, total_cents)
    profile = export_profile(output_format)
    command = [
        get_settings().ffmpeg_path,
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-af",
        filter_graph,
        *profile,
        str(destination_path.with_suffix(f".{output_format}")),
    ]
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except FileNotFoundError as exc:
        raise missing_host_tool_error(
            tool="ffmpeg",
            operation="audio_transform",
            impact="create transformed audio",
        ) from exc
    if register_process:
        register_process(proc)
    if on_progress:
        on_progress(40)
    try:
        while proc.poll() is None:
            if should_cancel and should_cancel():
                proc.terminate()
                raise JobCancelledError()
            proc.wait(timeout=0.1)
    except subprocess.TimeoutExpired:
        while proc.poll() is None:
            if should_cancel and should_cancel():
                proc.terminate()
                raise JobCancelledError() from None
            continue
    finally:
        if unregister_process:
            unregister_process()

    proc.communicate()
    if proc.returncode != 0:
        raise AppError(
            "PROCESSING_FAILED",
            "FFmpeg failed to produce the requested artifact.",
        )
    if on_progress:
        on_progress(90)


def semitones_to_cents(semitones: int) -> float:
    return float(semitones * 100)


def cents_from_reference(source_reference_hz: float, target_reference_hz: float) -> float:
    if source_reference_hz <= 0 or target_reference_hz <= 0:
        raise AppError("INVALID_REQUEST", "Reference pitch values must be positive.")
    return float(1200.0 * math.log2(target_reference_hz / source_reference_hz))
