from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.engines import audio_signal
from app.engines.audio_signal import (
    AudioSignalThresholds,
    inspect_audio_signal_array,
    inspect_audio_signal_file,
)

SAMPLE_RATE = 1_000
THRESHOLDS = AudioSignalThresholds(
    peak=0.01,
    rms=0.005,
    active_duration_seconds=0.20,
    window_seconds=0.10,
)


def test_silent_array_has_no_signal():
    summary = inspect_audio_signal_array(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, THRESHOLDS)

    assert summary.has_signal is False
    assert summary.peak == pytest.approx(0.0)
    assert summary.rms == pytest.approx(0.0)
    assert summary.active_duration_seconds == pytest.approx(0.0)
    assert summary.inspected_duration_seconds == pytest.approx(1.0)
    assert summary.active_ratio == pytest.approx(0.0)
    assert summary.sample_rate == SAMPLE_RATE
    assert summary.channels == 1
    assert summary.bins is None


def test_low_amplitude_array_has_no_signal():
    summary = inspect_audio_signal_array(np.full(SAMPLE_RATE, 0.002, dtype=np.float32), SAMPLE_RATE, THRESHOLDS)

    assert summary.has_signal is False
    assert 0.0 < summary.peak < THRESHOLDS.peak
    assert 0.0 < summary.rms < THRESHOLDS.rms
    assert summary.active_duration_seconds == pytest.approx(0.0)


def test_sparse_clicks_do_not_accumulate_window_duration():
    signal = np.zeros(SAMPLE_RATE, dtype=np.float32)
    signal[[0, 100, 200, 300]] = 0.5

    summary = inspect_audio_signal_array(signal, SAMPLE_RATE, THRESHOLDS)

    assert summary.has_signal is False
    assert summary.peak == pytest.approx(0.5)
    assert summary.rms > THRESHOLDS.rms
    assert summary.active_duration_seconds == pytest.approx(0.004)
    assert summary.active_ratio == pytest.approx(0.004)


def test_active_ratio_counts_active_frames_over_inspected_frames():
    signal = np.zeros(SAMPLE_RATE, dtype=np.float32)
    signal[:250] = 0.1

    summary = inspect_audio_signal_array(signal, SAMPLE_RATE, THRESHOLDS)

    assert summary.has_signal is True
    assert summary.active_duration_seconds == pytest.approx(0.25)
    assert summary.inspected_duration_seconds == pytest.approx(1.0)
    assert summary.active_ratio == pytest.approx(0.25)


def test_max_duration_seconds_limits_file_inspection(tmp_path: Path):
    path = _write_wav(tmp_path, "long_tone.wav", np.full(SAMPLE_RATE * 2, 0.1, dtype=np.float32))

    summary = inspect_audio_signal_file(path, THRESHOLDS, max_duration_seconds=0.25)

    assert summary.has_signal is True
    assert summary.active_duration_seconds == pytest.approx(0.25)
    assert summary.inspected_duration_seconds == pytest.approx(0.25)
    assert summary.active_ratio == pytest.approx(1.0)


def test_bins_report_peak_magnitude_per_inspected_time_bin():
    signal = np.zeros(SAMPLE_RATE, dtype=np.float32)
    signal[:500] = 0.2

    summary = inspect_audio_signal_array(signal, SAMPLE_RATE, THRESHOLDS, bin_count=4)

    assert summary.bins == pytest.approx((0.2, 0.2, 0.0, 0.0))


def test_bins_use_ceiling_frames_per_bin_for_uneven_counts():
    signal = np.arange(1, 11, dtype=np.float32)

    summary = inspect_audio_signal_array(signal, SAMPLE_RATE, THRESHOLDS, bin_count=4)

    assert summary.bins == pytest.approx((3.0, 6.0, 9.0, 10.0))


def test_file_reads_are_capped_without_splitting_logical_analysis_windows(
    monkeypatch: pytest.MonkeyPatch,
):
    sample_rate = 100_000
    samples = np.zeros(sample_rate, dtype=np.float32)
    samples[:100] = 1.0
    fake_audio = _FakeSoundFile(samples=samples, sample_rate=sample_rate)
    thresholds = AudioSignalThresholds(
        peak=0.5,
        rms=0.035,
        active_duration_seconds=0.0,
        window_seconds=1.0,
    )

    monkeypatch.setattr(audio_signal.sf, "SoundFile", lambda *_args, **_kwargs: fake_audio)

    summary = inspect_audio_signal_file(Path("fake.wav"), thresholds)

    assert fake_audio.read_sizes == [audio_signal.MAX_READ_FRAMES, sample_rate - audio_signal.MAX_READ_FRAMES]
    assert max(fake_audio.read_sizes) <= audio_signal.MAX_READ_FRAMES
    assert summary.rms == pytest.approx(np.sqrt(100 / sample_rate))
    assert summary.active_duration_seconds == pytest.approx(0.0)


def test_phase_opposed_stereo_uses_max_channel_magnitude():
    mono = np.full(SAMPLE_RATE, 0.1, dtype=np.float32)
    stereo = np.column_stack([mono, -mono])

    summary = inspect_audio_signal_array(stereo, SAMPLE_RATE, THRESHOLDS)

    assert summary.has_signal is True
    assert summary.channels == 2
    assert summary.peak == pytest.approx(0.1)
    assert summary.rms == pytest.approx(0.1)
    assert summary.active_duration_seconds == pytest.approx(1.0)


def _write_wav(tmp_path: Path, filename: str, signal: np.ndarray) -> Path:
    path = tmp_path / filename
    sf.write(path, signal.astype(np.float32), SAMPLE_RATE, subtype="FLOAT")
    return path


class _FakeSoundFile:
    def __init__(self, *, samples: np.ndarray, sample_rate: int) -> None:
        self.samplerate = sample_rate
        self.channels = 1
        self.frames = int(samples.shape[0])
        self.read_sizes: list[int] = []
        self._samples = samples.reshape(-1, 1).astype(np.float32)
        self._offset = 0

    def __enter__(self) -> _FakeSoundFile:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, frames: int, *, dtype: str, always_2d: bool) -> np.ndarray:
        assert dtype == "float32"
        assert always_2d is True
        self.read_sizes.append(frames)
        stop = min(self._offset + frames, self.frames)
        block = self._samples[self._offset : stop]
        self._offset = stop
        return block
