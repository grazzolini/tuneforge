from __future__ import annotations

import warnings
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
NOTE_NAMES = np.array(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])


def _load_signal(source_path: Path) -> tuple[np.ndarray, int]:
    signal, sample_rate = sf.read(source_path, always_2d=False)
    if signal.ndim > 1:
        signal = signal.mean(axis=1)
    return signal.astype(np.float32), int(sample_rate)


def _estimate_tuning(signal: np.ndarray, sample_rate: int) -> tuple[float | None, float | None]:
    if signal.size == 0:
        return None, None
    window_size = min(signal.size, 131072)
    window = signal[:window_size] * np.hanning(window_size)
    spectrum = np.fft.rfft(window)
    frequencies = np.fft.rfftfreq(window_size, d=1.0 / sample_rate)
    mask = (frequencies >= 55.0) & (frequencies <= 1760.0)
    if not np.any(mask):
        return None, None
    magnitudes = np.abs(spectrum[mask])
    dominant_frequency = float(frequencies[mask][int(np.argmax(magnitudes))])
    midi = 69.0 + 12.0 * np.log2(dominant_frequency / 440.0)
    tuning_offset_cents = float((midi - round(midi)) * 100.0)
    estimated_reference_hz = float(440.0 * (2.0 ** (tuning_offset_cents / 1200.0)))
    return estimated_reference_hz, tuning_offset_cents


def _safe_fft_size(signal_size: int, preferred_n_fft: int) -> int:
    if signal_size <= 0:
        return preferred_n_fft
    if signal_size >= preferred_n_fft:
        return preferred_n_fft
    exponent = int(np.floor(np.log2(max(signal_size, 32))))
    return max(32, 2**exponent)


def analyze_track(source_path: Path) -> dict[str, float | str | None]:
    signal, sample_rate = _load_signal(source_path)
    if signal.size == 0:
        return {
            "estimated_key": None,
            "key_confidence": None,
            "estimated_reference_hz": None,
            "tuning_offset_cents": None,
            "tempo_bpm": None,
        }

    estimated_reference_hz, tuning_offset_cents = _estimate_tuning(signal, sample_rate)

    n_fft = _safe_fft_size(signal.size, 4096)
    hop_length = max(32, min(1024, n_fft // 4))
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=r"n_fft=.*too large for input signal of length=.*",
            category=UserWarning,
        )
        chroma = librosa.feature.chroma_stft(
            y=signal,
            sr=sample_rate,
            n_fft=n_fft,
            hop_length=hop_length,
        )
    chroma_mean = chroma.mean(axis=1)
    chroma_norm = chroma_mean / np.linalg.norm(chroma_mean, ord=2)
    major_scores = np.array([np.corrcoef(chroma_norm, np.roll(MAJOR_PROFILE, idx))[0, 1] for idx in range(12)])
    minor_scores = np.array([np.corrcoef(chroma_norm, np.roll(MINOR_PROFILE, idx))[0, 1] for idx in range(12)])
    major_idx = int(np.nanargmax(major_scores))
    minor_idx = int(np.nanargmax(minor_scores))
    major_score = float(np.nanmax(major_scores))
    minor_score = float(np.nanmax(minor_scores))

    if major_score >= minor_score:
        estimated_key = f"{NOTE_NAMES[major_idx]} major"
        key_confidence = max(0.0, min(1.0, (major_score + 1.0) / 2.0))
    else:
        estimated_key = f"{NOTE_NAMES[minor_idx]} minor"
        key_confidence = max(0.0, min(1.0, (minor_score + 1.0) / 2.0))

    return {
        "estimated_key": estimated_key,
        "key_confidence": key_confidence,
        "estimated_reference_hz": estimated_reference_hz,
        "tuning_offset_cents": tuning_offset_cents,
        "tempo_bpm": None,
    }
