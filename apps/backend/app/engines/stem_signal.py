from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.engines.audio_signal import AudioSignalThresholds, inspect_audio_signal_file

PEAK_THRESHOLD = 1e-3
RMS_THRESHOLD = 5e-5
ACTIVE_DURATION_THRESHOLD_SECONDS = 0.20
ANALYSIS_WINDOW_SECONDS = 0.05
STEM_SIGNAL_THRESHOLDS = AudioSignalThresholds(
    peak=PEAK_THRESHOLD,
    rms=RMS_THRESHOLD,
    active_duration_seconds=ACTIVE_DURATION_THRESHOLD_SECONDS,
    window_seconds=ANALYSIS_WINDOW_SECONDS,
)


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
    summary = inspect_audio_signal_file(
        path,
        STEM_SIGNAL_THRESHOLDS,
        max_duration_seconds=max_duration_seconds,
    )

    return StemSignalSummary(
        has_signal=summary.has_signal,
        peak=summary.peak,
        rms=summary.rms,
        active_duration_seconds=summary.active_duration_seconds,
        inspected_duration_seconds=summary.inspected_duration_seconds,
        sample_rate=summary.sample_rate,
        channels=summary.channels,
    )
