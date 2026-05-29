from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

PEAK_THRESHOLD = 1e-3
RMS_THRESHOLD = 5e-5
ACTIVE_DURATION_THRESHOLD_SECONDS = 0.20
ANALYSIS_WINDOW_SECONDS = 0.05


@dataclass(frozen=True)
class StemSignalSummary:
    has_signal: bool
    peak: float
    rms: float
    active_duration_seconds: float
    inspected_duration_seconds: float
    sample_rate: int = 0
    channels: int = 0


def inspect_stem_signal(
    path: Path,
    *,
    max_duration_seconds: float | None = None,
) -> StemSignalSummary:
    if max_duration_seconds is not None and (
        not math.isfinite(max_duration_seconds) or max_duration_seconds < 0.0
    ):
        raise ValueError("max_duration_seconds must be finite and non-negative.")

    with sf.SoundFile(path, mode="r") as audio:
        sample_rate = int(audio.samplerate)
        channels = int(audio.channels)
        max_frames = None if max_duration_seconds is None else int(max_duration_seconds * sample_rate)
        window_frames = max(1, int(round(sample_rate * ANALYSIS_WINDOW_SECONDS)))

        peak = 0.0
        square_sum = 0.0
        inspected_frames = 0
        active_frames = 0
        remaining_frames = max_frames

        while remaining_frames is None or remaining_frames > 0:
            frames_to_read = window_frames if remaining_frames is None else min(window_frames, remaining_frames)
            block = audio.read(frames_to_read, dtype="float32", always_2d=True)
            frame_count = int(block.shape[0])
            if frame_count == 0:
                break

            frame_magnitudes = np.max(np.abs(block), axis=1).astype(np.float64, copy=False)
            window_peak = float(np.max(frame_magnitudes))
            window_square_sum = float(np.sum(frame_magnitudes * frame_magnitudes))
            window_rms = math.sqrt(window_square_sum / frame_count)

            peak = max(peak, window_peak)
            square_sum += window_square_sum
            inspected_frames += frame_count
            if window_peak >= PEAK_THRESHOLD and window_rms >= RMS_THRESHOLD:
                active_frames += int(np.count_nonzero(frame_magnitudes >= RMS_THRESHOLD))

            if remaining_frames is not None:
                remaining_frames -= frame_count

    rms = math.sqrt(square_sum / inspected_frames) if inspected_frames > 0 else 0.0
    active_duration_seconds = active_frames / sample_rate if inspected_frames > 0 else 0.0
    inspected_duration_seconds = inspected_frames / sample_rate if inspected_frames > 0 else 0.0
    has_signal = (
        peak >= PEAK_THRESHOLD
        and rms >= RMS_THRESHOLD
        and active_duration_seconds >= ACTIVE_DURATION_THRESHOLD_SECONDS
    )

    return StemSignalSummary(
        has_signal=has_signal,
        peak=peak,
        rms=rms,
        active_duration_seconds=active_duration_seconds,
        inspected_duration_seconds=inspected_duration_seconds,
        sample_rate=sample_rate,
        channels=channels,
    )
