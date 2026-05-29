from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.engines.stem_signal import inspect_stem_signal

SAMPLE_RATE = 44_100


def test_silent_wav_has_no_stem_signal(tmp_path: Path):
    path = _write_wav(tmp_path, "silence.wav", np.zeros(SAMPLE_RATE, dtype=np.float32))

    summary = inspect_stem_signal(path)

    assert _has_signal(summary) is False
    assert _float_metric(summary, "peak") == pytest.approx(0.0)
    assert _float_metric(summary, "rms") == pytest.approx(0.0)
    assert _float_metric(summary, "active_duration_seconds") == pytest.approx(0.0)
    assert _float_metric(summary, "inspected_duration_seconds") == pytest.approx(1.0)


def test_near_silent_low_amplitude_wav_has_no_stem_signal(tmp_path: Path):
    path = _write_wav(tmp_path, "near_silence.wav", _tone(duration_seconds=1.0, amplitude=2e-5))

    summary = inspect_stem_signal(path)

    assert _has_signal(summary) is False
    assert 0.0 < _float_metric(summary, "peak") < 1e-3
    assert 0.0 < _float_metric(summary, "rms") < 5e-5
    assert _float_metric(summary, "inspected_duration_seconds") == pytest.approx(1.0)


def test_short_transient_above_peak_is_not_enough_signal(tmp_path: Path):
    signal = np.zeros(SAMPLE_RATE, dtype=np.float32)
    signal[SAMPLE_RATE // 2] = 0.75
    path = _write_wav(tmp_path, "click.wav", signal)

    summary = inspect_stem_signal(path)

    assert _has_signal(summary) is False
    assert _float_metric(summary, "peak") > 0.5
    assert _float_metric(summary, "active_duration_seconds") < 0.20
    assert _float_metric(summary, "inspected_duration_seconds") == pytest.approx(1.0)


def test_repeated_sparse_clicks_do_not_accumulate_window_duration(tmp_path: Path):
    signal = np.zeros(SAMPLE_RATE, dtype=np.float32)
    window_frames = int(SAMPLE_RATE * 0.05)
    signal[[window_frames * index for index in range(4)]] = 0.05
    path = _write_wav(tmp_path, "repeated_clicks.wav", signal)

    summary = inspect_stem_signal(path)

    assert _has_signal(summary) is False
    assert _float_metric(summary, "peak") >= 1e-3
    assert _float_metric(summary, "rms") >= 5e-5
    assert _float_metric(summary, "active_duration_seconds") < 0.01
    assert _float_metric(summary, "inspected_duration_seconds") == pytest.approx(1.0)


def test_usable_mono_tone_has_stem_signal(tmp_path: Path):
    path = _write_wav(tmp_path, "mono_tone.wav", _tone(duration_seconds=1.0, amplitude=0.2))

    summary = inspect_stem_signal(path)

    assert _has_signal(summary) is True
    assert _float_metric(summary, "peak") > 0.15
    assert _float_metric(summary, "rms") > 0.10
    assert _float_metric(summary, "active_duration_seconds") >= 0.20
    assert _float_metric(summary, "inspected_duration_seconds") == pytest.approx(1.0)


def test_phase_opposed_stereo_tone_has_stem_signal(tmp_path: Path):
    mono = _tone(duration_seconds=1.0, amplitude=0.2)
    stereo = np.column_stack([mono, -mono])
    path = _write_wav(tmp_path, "phase_opposed_stereo.wav", stereo)

    summary = inspect_stem_signal(path)

    assert _has_signal(summary) is True
    assert _float_metric(summary, "peak") > 0.15
    assert _float_metric(summary, "rms") > 0.10
    assert _float_metric(summary, "active_duration_seconds") >= 0.20


def test_max_duration_seconds_limits_inspected_duration(tmp_path: Path):
    path = _write_wav(tmp_path, "long_tone.wav", _tone(duration_seconds=2.0, amplitude=0.2))

    full_summary = inspect_stem_signal(path)
    limited_summary = inspect_stem_signal(path, max_duration_seconds=0.25)

    assert _float_metric(full_summary, "inspected_duration_seconds") == pytest.approx(2.0)
    assert _float_metric(limited_summary, "inspected_duration_seconds") == pytest.approx(0.25)
    assert _float_metric(limited_summary, "inspected_duration_seconds") < _float_metric(
        full_summary,
        "inspected_duration_seconds",
    )
    assert _float_metric(limited_summary, "active_duration_seconds") <= _float_metric(
        limited_summary,
        "inspected_duration_seconds",
    )


def _tone(
    *,
    duration_seconds: float,
    amplitude: float,
    frequency_hz: float = 440.0,
) -> np.ndarray:
    timeline = np.linspace(0.0, duration_seconds, int(SAMPLE_RATE * duration_seconds), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * frequency_hz * timeline)).astype(np.float32)


def _write_wav(tmp_path: Path, filename: str, signal: np.ndarray) -> Path:
    path = tmp_path / filename
    sf.write(path, signal.astype(np.float32), SAMPLE_RATE, subtype="FLOAT")
    return path


def _has_signal(summary: object) -> bool:
    return bool(_metric(summary, "has_signal"))


def _float_metric(summary: object, name: str) -> float:
    return float(_metric(summary, name))


def _metric(summary: object, name: str) -> object:
    if isinstance(summary, Mapping):
        return summary[name]
    return getattr(summary, name)
