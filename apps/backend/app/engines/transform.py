from __future__ import annotations

import math
import subprocess
from collections.abc import Callable
from pathlib import Path

from app.config import get_settings
from app.errors import AppError, JobCancelledError


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
    command = [
        get_settings().ffmpeg_path,
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-af",
        filter_graph,
        str(destination_path.with_suffix(f".{output_format}")),
    ]
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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

    stdout, stderr = proc.communicate()
    if proc.returncode != 0:
        raise AppError(
            "PROCESSING_FAILED",
            "FFmpeg failed to produce the requested artifact.",
            details={"stdout": stdout.strip(), "stderr": stderr.strip()},
        )
    if on_progress:
        on_progress(90)


def semitones_to_cents(semitones: int) -> float:
    return float(semitones * 100)


def cents_from_reference(source_reference_hz: float, target_reference_hz: float) -> float:
    if source_reference_hz <= 0 or target_reference_hz <= 0:
        raise AppError("INVALID_REQUEST", "Reference pitch values must be positive.")
    return float(1200.0 * math.log2(target_reference_hz / source_reference_hz))
