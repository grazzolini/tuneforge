from __future__ import annotations

import math
import operator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

MAX_READ_FRAMES = 65_536


@dataclass(frozen=True)
class AudioSignalThresholds:
    peak: float
    rms: float
    active_duration_seconds: float
    window_seconds: float

    def __post_init__(self) -> None:
        _validate_non_negative("peak", self.peak)
        _validate_non_negative("rms", self.rms)
        _validate_non_negative("active_duration_seconds", self.active_duration_seconds)
        if not math.isfinite(self.window_seconds) or self.window_seconds <= 0.0:
            raise ValueError("window_seconds must be finite and positive.")


@dataclass(frozen=True)
class AudioSignalSummary:
    has_signal: bool
    peak: float
    rms: float
    active_duration_seconds: float
    inspected_duration_seconds: float
    active_ratio: float
    sample_rate: int
    channels: int
    bins: tuple[float, ...] | None = None


def inspect_audio_signal(
    path: Path,
    thresholds: AudioSignalThresholds,
    *,
    max_duration_seconds: float | None = None,
    bin_count: int | None = None,
) -> AudioSignalSummary:
    return inspect_audio_signal_file(
        path,
        thresholds,
        max_duration_seconds=max_duration_seconds,
        bin_count=bin_count,
    )


def inspect_audio_signal_file(
    path: Path,
    thresholds: AudioSignalThresholds,
    *,
    max_duration_seconds: float | None = None,
    bin_count: int | None = None,
) -> AudioSignalSummary:
    normalized_bin_count = _normalize_bin_count(bin_count)

    with sf.SoundFile(path, mode="r") as audio:
        sample_rate = int(audio.samplerate)
        channels = int(audio.channels)
        inspected_frame_limit = _resolve_inspected_frame_limit(
            int(audio.frames),
            sample_rate,
            max_duration_seconds,
        )
        accumulator = _AudioSignalAccumulator(
            sample_rate=sample_rate,
            channels=channels,
            thresholds=thresholds,
            bin_count=normalized_bin_count,
            inspected_frame_limit=inspected_frame_limit,
        )
        read_frames = min(_window_frames(sample_rate, thresholds.window_seconds), MAX_READ_FRAMES)
        remaining_frames = inspected_frame_limit

        while remaining_frames > 0:
            frames_to_read = min(read_frames, remaining_frames)
            block = audio.read(frames_to_read, dtype="float32", always_2d=True)
            frame_count = int(block.shape[0])
            if frame_count == 0:
                break

            accumulator.add_block(block)
            remaining_frames -= frame_count

    return accumulator.summary()


def inspect_audio_signal_array(
    signal: np.ndarray,
    sample_rate: int,
    thresholds: AudioSignalThresholds,
    *,
    max_duration_seconds: float | None = None,
    bin_count: int | None = None,
) -> AudioSignalSummary:
    frames = _as_frame_channel_array(signal)
    sample_rate = _normalize_sample_rate(sample_rate)
    normalized_bin_count = _normalize_bin_count(bin_count)
    inspected_frame_limit = _resolve_inspected_frame_limit(
        int(frames.shape[0]),
        sample_rate,
        max_duration_seconds,
    )
    accumulator = _AudioSignalAccumulator(
        sample_rate=sample_rate,
        channels=int(frames.shape[1]),
        thresholds=thresholds,
        bin_count=normalized_bin_count,
        inspected_frame_limit=inspected_frame_limit,
    )
    window_frames = _window_frames(sample_rate, thresholds.window_seconds)
    offset = 0
    remaining_frames = inspected_frame_limit

    while remaining_frames > 0:
        frame_count = min(window_frames, remaining_frames)
        accumulator.add_block(frames[offset : offset + frame_count])
        offset += frame_count
        remaining_frames -= frame_count

    return accumulator.summary()


class _AudioSignalAccumulator:
    def __init__(
        self,
        *,
        sample_rate: int,
        channels: int,
        thresholds: AudioSignalThresholds,
        bin_count: int | None,
        inspected_frame_limit: int,
    ) -> None:
        self._sample_rate = sample_rate
        self._channels = channels
        self._thresholds = thresholds
        self._bin_peaks = None if bin_count is None else np.zeros(bin_count, dtype=np.float64)
        self._frames_per_bin = (
            None if bin_count is None else max(1, math.ceil(max(inspected_frame_limit, 1) / bin_count))
        )
        self._window_frames = _window_frames(sample_rate, thresholds.window_seconds)
        self._peak = 0.0
        self._square_sum = 0.0
        self._inspected_frames = 0
        self._active_frames = 0
        self._pending_window_peak = 0.0
        self._pending_window_square_sum = 0.0
        self._pending_window_frames = 0
        self._pending_window_active_frames = 0

    def add_block(self, block: np.ndarray) -> None:
        frame_count = int(block.shape[0])
        if frame_count == 0:
            return

        frame_magnitudes = np.max(np.abs(block), axis=1).astype(np.float64, copy=False)
        self._update_bins(frame_magnitudes)

        self._peak = max(self._peak, float(np.max(frame_magnitudes)))
        window_square_sum = float(np.sum(frame_magnitudes * frame_magnitudes))
        self._square_sum += window_square_sum
        self._update_active_windows(frame_magnitudes)
        self._inspected_frames += frame_count

    def summary(self) -> AudioSignalSummary:
        rms = math.sqrt(self._square_sum / self._inspected_frames) if self._inspected_frames > 0 else 0.0
        active_frames = self._active_frames + self._pending_window_active_frame_count()
        active_duration_seconds = (
            active_frames / self._sample_rate if self._inspected_frames > 0 else 0.0
        )
        inspected_duration_seconds = (
            self._inspected_frames / self._sample_rate if self._inspected_frames > 0 else 0.0
        )
        active_ratio = (
            active_duration_seconds / inspected_duration_seconds
            if inspected_duration_seconds > 0.0
            else 0.0
        )
        has_signal = (
            self._peak >= self._thresholds.peak
            and rms >= self._thresholds.rms
            and active_duration_seconds >= self._thresholds.active_duration_seconds
        )

        return AudioSignalSummary(
            has_signal=has_signal,
            peak=self._peak,
            rms=rms,
            active_duration_seconds=active_duration_seconds,
            inspected_duration_seconds=inspected_duration_seconds,
            active_ratio=active_ratio,
            sample_rate=self._sample_rate,
            channels=self._channels,
            bins=None if self._bin_peaks is None else tuple(float(value) for value in self._bin_peaks),
        )

    def _update_bins(self, frame_magnitudes: np.ndarray) -> None:
        if self._bin_peaks is None or self._frames_per_bin is None:
            return

        bin_count = int(self._bin_peaks.shape[0])
        start_frame = self._inspected_frames
        stop_frame = start_frame + int(frame_magnitudes.shape[0])
        frame_indexes = np.arange(start_frame, stop_frame, dtype=np.int64)
        bin_indexes = np.minimum(frame_indexes // self._frames_per_bin, bin_count - 1)
        np.maximum.at(self._bin_peaks, bin_indexes, frame_magnitudes)

    def _update_active_windows(self, frame_magnitudes: np.ndarray) -> None:
        offset = 0
        frame_count = int(frame_magnitudes.shape[0])
        while offset < frame_count:
            available = min(frame_count - offset, self._window_frames - self._pending_window_frames)
            window_slice = frame_magnitudes[offset : offset + available]
            self._pending_window_peak = max(self._pending_window_peak, float(np.max(window_slice)))
            self._pending_window_square_sum += float(np.sum(window_slice * window_slice))
            self._pending_window_frames += available
            self._pending_window_active_frames += int(np.count_nonzero(window_slice >= self._thresholds.rms))
            if self._pending_window_frames == self._window_frames:
                self._active_frames += self._pending_window_active_frame_count()
                self._pending_window_peak = 0.0
                self._pending_window_square_sum = 0.0
                self._pending_window_frames = 0
                self._pending_window_active_frames = 0
            offset += available

    def _pending_window_active_frame_count(self) -> int:
        if self._pending_window_frames == 0:
            return 0
        window_rms = math.sqrt(self._pending_window_square_sum / self._pending_window_frames)
        if self._pending_window_peak < self._thresholds.peak or window_rms < self._thresholds.rms:
            return 0
        return self._pending_window_active_frames


def _as_frame_channel_array(signal: np.ndarray) -> np.ndarray:
    frames = np.asarray(signal)
    if frames.ndim == 1:
        return frames.reshape(-1, 1)
    if frames.ndim != 2:
        raise ValueError("signal must be a mono vector or a frame-by-channel array.")
    if frames.shape[1] <= 0:
        raise ValueError("signal must have at least one channel.")
    return frames


def _normalize_sample_rate(sample_rate: int) -> int:
    normalized_sample_rate = operator.index(sample_rate)
    if normalized_sample_rate <= 0:
        raise ValueError("sample_rate must be positive.")
    return normalized_sample_rate


def _normalize_bin_count(bin_count: int | None) -> int | None:
    if bin_count is None:
        return None

    normalized_bin_count = operator.index(bin_count)
    if normalized_bin_count <= 0:
        raise ValueError("bin_count must be positive.")
    return normalized_bin_count


def _resolve_inspected_frame_limit(
    total_frames: int,
    sample_rate: int,
    max_duration_seconds: float | None,
) -> int:
    if max_duration_seconds is None:
        return total_frames
    if not math.isfinite(max_duration_seconds) or max_duration_seconds < 0.0:
        raise ValueError("max_duration_seconds must be finite and non-negative.")
    return min(total_frames, int(max_duration_seconds * sample_rate))


def _window_frames(sample_rate: int, window_seconds: float) -> int:
    return max(1, int(round(sample_rate * window_seconds)))


def _validate_non_negative(name: str, value: float) -> None:
    if not math.isfinite(value) or value < 0.0:
        raise ValueError(f"{name} must be finite and non-negative.")
