from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np
import soundfile as sf

from app.errors import AppError, JobCancelledError


def _ensure_stereo(signal: np.ndarray) -> np.ndarray:
    if signal.ndim == 1:
        return np.column_stack([signal, signal])
    if signal.shape[1] == 1:
        channel = signal[:, 0]
        return np.column_stack([channel, channel])
    return signal[:, :2]


def separate_two_stems(
    source_path: Path,
    vocal_path: Path,
    instrumental_path: Path,
    *,
    on_progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, object]:
    try:
        signal, sample_rate = sf.read(source_path, always_2d=False)
    except Exception as exc:  # pragma: no cover - soundfile forwards format-specific errors
        raise AppError("PROCESSING_FAILED", "Could not decode audio for stem separation.") from exc

    if should_cancel and should_cancel():
        raise JobCancelledError()

    stereo_signal = _ensure_stereo(np.asarray(signal, dtype=np.float32))
    vocal_path.parent.mkdir(parents=True, exist_ok=True)
    instrumental_path.parent.mkdir(parents=True, exist_ok=True)

    if stereo_signal.shape[1] < 2:
        vocals = np.column_stack([stereo_signal[:, 0], stereo_signal[:, 0]])
        instrumental = np.zeros_like(vocals)
        strategy = "mono-fallback"
    else:
        left = stereo_signal[:, 0]
        right = stereo_signal[:, 1]
        mid = 0.5 * (left + right)
        side = 0.5 * (left - right)
        vocals = np.column_stack([mid, mid])
        instrumental = np.column_stack([side, -side])
        strategy = "mid-side-v1"

    if on_progress:
        on_progress(45)
    if should_cancel and should_cancel():
        raise JobCancelledError()

    sf.write(vocal_path, vocals, sample_rate)
    if on_progress:
        on_progress(70)
    if should_cancel and should_cancel():
        raise JobCancelledError()

    sf.write(instrumental_path, instrumental, sample_rate)
    if on_progress:
        on_progress(90)

    return {
        "sample_rate": int(sample_rate),
        "channels": int(vocals.shape[1]),
        "engine": strategy,
    }
