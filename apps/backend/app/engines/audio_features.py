from __future__ import annotations

import warnings
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

ANALYSIS_SAMPLE_RATE = 22_050
ANALYSIS_HOP_LENGTH = 512


@dataclass(frozen=True)
class HarmonicFeatures:
    signal: np.ndarray
    harmonic_signal: np.ndarray
    percussive_signal: np.ndarray
    sample_rate: int
    hop_length: int
    duration_seconds: float
    chroma_cqt: np.ndarray
    chroma_cens: np.ndarray
    rms: np.ndarray
    times: np.ndarray
    active_frame_mask: np.ndarray
    beat_frames: np.ndarray
    tempo_bpm: float | None
    estimated_reference_hz: float | None
    tuning_offset_cents: float | None
    tuning_bins: float | None


def load_mono_signal(source_path: Path) -> tuple[np.ndarray, int]:
    signal, sample_rate = sf.read(source_path, always_2d=False)
    if signal.ndim > 1:
        signal = signal.mean(axis=1)
    return signal.astype(np.float32), int(sample_rate)


def extract_harmonic_features(source_path: Path) -> HarmonicFeatures:
    signal, source_sample_rate = load_mono_signal(source_path)
    if signal.size == 0:
        return _empty_features()

    analysis_signal = _resample_for_analysis(signal, source_sample_rate)
    duration_seconds = float(analysis_signal.size / ANALYSIS_SAMPLE_RATE)
    harmonic_signal, percussive_signal = _split_harmonic_percussive(analysis_signal)
    tuning_bins = _estimate_tuning_bins(harmonic_signal)
    tuning_offset_cents = None if tuning_bins is None else float(tuning_bins * 100.0)
    estimated_reference_hz = (
        None if tuning_bins is None else float(440.0 * (2.0 ** (float(tuning_bins) / 12.0)))
    )

    chroma_cqt = _compute_chroma_cqt(harmonic_signal, tuning_bins)
    chroma_cens = _compute_chroma_cens(harmonic_signal, tuning_bins, chroma_cqt)
    rms = _match_frame_count(
        _compute_rms(analysis_signal),
        chroma_cqt.shape[1],
    )
    active_frame_mask = _active_mask(rms)
    times = librosa.frames_to_time(
        np.arange(chroma_cqt.shape[1]),
        sr=ANALYSIS_SAMPLE_RATE,
        hop_length=ANALYSIS_HOP_LENGTH,
    )
    tempo_bpm, beat_frames = _estimate_tempo_and_beats(percussive_signal, analysis_signal)
    beat_frames = beat_frames[beat_frames < chroma_cqt.shape[1]]

    return HarmonicFeatures(
        signal=analysis_signal,
        harmonic_signal=harmonic_signal,
        percussive_signal=percussive_signal,
        sample_rate=ANALYSIS_SAMPLE_RATE,
        hop_length=ANALYSIS_HOP_LENGTH,
        duration_seconds=duration_seconds,
        chroma_cqt=chroma_cqt,
        chroma_cens=chroma_cens,
        rms=rms,
        times=times,
        active_frame_mask=active_frame_mask,
        beat_frames=beat_frames.astype(np.int64),
        tempo_bpm=tempo_bpm,
        estimated_reference_hz=estimated_reference_hz,
        tuning_offset_cents=tuning_offset_cents,
        tuning_bins=tuning_bins,
    )


def combined_chroma(features: HarmonicFeatures) -> np.ndarray:
    if features.chroma_cqt.size == 0:
        return features.chroma_cqt
    return (0.65 * features.chroma_cqt + 0.35 * features.chroma_cens).astype(np.float32)


def active_chroma_mean(features: HarmonicFeatures) -> np.ndarray:
    chroma = combined_chroma(features)
    if chroma.size == 0:
        return np.zeros(12, dtype=np.float32)

    active = features.active_frame_mask
    if active.any():
        weights = features.rms[active].astype(np.float32)
        if float(weights.sum()) > 0.0:
            return np.average(chroma[:, active], axis=1, weights=weights).astype(np.float32)
        return chroma[:, active].mean(axis=1).astype(np.float32)
    return chroma.mean(axis=1).astype(np.float32)


def _empty_features() -> HarmonicFeatures:
    empty_chroma = np.zeros((12, 0), dtype=np.float32)
    empty_frames = np.zeros(0, dtype=np.float32)
    return HarmonicFeatures(
        signal=np.zeros(0, dtype=np.float32),
        harmonic_signal=np.zeros(0, dtype=np.float32),
        percussive_signal=np.zeros(0, dtype=np.float32),
        sample_rate=ANALYSIS_SAMPLE_RATE,
        hop_length=ANALYSIS_HOP_LENGTH,
        duration_seconds=0.0,
        chroma_cqt=empty_chroma,
        chroma_cens=empty_chroma,
        rms=empty_frames,
        times=empty_frames,
        active_frame_mask=np.zeros(0, dtype=bool),
        beat_frames=np.zeros(0, dtype=np.int64),
        tempo_bpm=None,
        estimated_reference_hz=None,
        tuning_offset_cents=None,
        tuning_bins=None,
    )


def _resample_for_analysis(signal: np.ndarray, sample_rate: int) -> np.ndarray:
    if sample_rate == ANALYSIS_SAMPLE_RATE:
        return signal.astype(np.float32)
    return librosa.resample(
        y=signal.astype(np.float32),
        orig_sr=sample_rate,
        target_sr=ANALYSIS_SAMPLE_RATE,
    ).astype(np.float32)


def _split_harmonic_percussive(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if signal.size < ANALYSIS_HOP_LENGTH * 4:
        return signal, np.zeros_like(signal)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        harmonic_signal, percussive_signal = librosa.effects.hpss(signal, margin=(1.0, 5.0))
    return harmonic_signal.astype(np.float32), percussive_signal.astype(np.float32)


def _estimate_tuning_bins(signal: np.ndarray) -> float | None:
    if signal.size < ANALYSIS_HOP_LENGTH * 4 or float(np.max(np.abs(signal))) < 1e-5:
        return None
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        try:
            tuning = float(librosa.estimate_tuning(y=signal, sr=ANALYSIS_SAMPLE_RATE))
        except Exception:
            return None
    if not np.isfinite(tuning):
        return None
    return float(np.clip(tuning, -0.5, 0.5))


def _compute_chroma_cqt(signal: np.ndarray, tuning_bins: float | None) -> np.ndarray:
    if signal.size == 0:
        return np.zeros((12, 0), dtype=np.float32)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        try:
            chroma = librosa.feature.chroma_cqt(
                y=signal,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
                bins_per_octave=36,
                n_chroma=12,
                tuning=0.0 if tuning_bins is None else tuning_bins,
            )
        except Exception:
            n_fft = _safe_fft_size(signal.size, 4096)
            chroma = librosa.feature.chroma_stft(
                y=signal,
                sr=ANALYSIS_SAMPLE_RATE,
                n_fft=n_fft,
                hop_length=ANALYSIS_HOP_LENGTH,
                tuning=0.0 if tuning_bins is None else tuning_bins,
            )
    return _normalize_chroma(chroma)


def _compute_chroma_cens(
    signal: np.ndarray,
    tuning_bins: float | None,
    fallback_chroma: np.ndarray,
) -> np.ndarray:
    if signal.size == 0:
        return np.zeros((12, 0), dtype=np.float32)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        try:
            chroma = librosa.feature.chroma_cens(
                y=signal,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
                bins_per_octave=36,
                n_chroma=12,
                tuning=0.0 if tuning_bins is None else tuning_bins,
            )
        except Exception:
            chroma = fallback_chroma
    return _match_frame_count(_normalize_chroma(chroma), fallback_chroma.shape[1])


def _compute_rms(signal: np.ndarray) -> np.ndarray:
    if signal.size == 0:
        return np.zeros(0, dtype=np.float32)
    n_fft = _safe_fft_size(signal.size, 2048)
    return librosa.feature.rms(
        y=signal,
        frame_length=n_fft,
        hop_length=ANALYSIS_HOP_LENGTH,
    )[0].astype(np.float32)


def _estimate_tempo_and_beats(
    percussive_signal: np.ndarray,
    fallback_signal: np.ndarray,
) -> tuple[float | None, np.ndarray]:
    if fallback_signal.size < ANALYSIS_SAMPLE_RATE:
        return None, np.zeros(0, dtype=np.int64)
    tempo_raw, beat_frames = _beat_track(
        percussive_signal
        if float(np.max(np.abs(percussive_signal), initial=0.0)) > 1e-5
        else fallback_signal
    )
    if beat_frames.size < 8 and percussive_signal is not fallback_signal:
        tempo_raw, beat_frames = _beat_track(fallback_signal)

    tempo = _tempo_value(tempo_raw)
    if beat_frames.size < 8 or tempo is None:
        tempo_bpm = _onset_tempo(fallback_signal)
    else:
        tempo_bpm = round(_normalize_tempo(tempo), 2)
    return tempo_bpm, np.asarray(beat_frames, dtype=np.int64)


def _beat_track(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if signal.size < ANALYSIS_SAMPLE_RATE:
        return np.zeros(1, dtype=np.float64), np.zeros(0, dtype=np.int64)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        try:
            tempo_raw, beat_frames = librosa.beat.beat_track(
                y=signal,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
                trim=False,
            )
        except Exception:
            return np.zeros(1, dtype=np.float64), np.zeros(0, dtype=np.int64)
    return np.asarray(tempo_raw, dtype=np.float64), np.asarray(beat_frames, dtype=np.int64)


def _onset_tempo(signal: np.ndarray) -> float | None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=FutureWarning)
        warnings.filterwarnings("ignore", category=UserWarning)
        try:
            onset_envelope = librosa.onset.onset_strength(
                y=signal,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
            )
            peak = float(np.max(onset_envelope, initial=0.0))
            if peak <= 0.0 or int(np.count_nonzero(onset_envelope > peak * 0.3)) < 12:
                return None
            tempo_raw = librosa.feature.tempo(
                onset_envelope=onset_envelope,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
            )
        except Exception:
            return None
    tempo = _tempo_value(tempo_raw)
    if tempo is None:
        return None
    return round(_normalize_tempo(tempo), 2)


def _tempo_value(tempo_raw: float | np.ndarray) -> float | None:
    tempo = float(np.asarray(tempo_raw).reshape(-1)[0]) if np.asarray(tempo_raw).size else 0.0
    if not np.isfinite(tempo) or tempo <= 0.0:
        return None
    return tempo


def _normalize_tempo(tempo: float) -> float:
    normalized = tempo
    while normalized < 70.0:
        normalized *= 2.0
    while normalized > 180.0:
        normalized /= 2.0
    return normalized


def _active_mask(rms: np.ndarray) -> np.ndarray:
    if rms.size == 0:
        return np.zeros(0, dtype=bool)
    peak = float(np.max(rms))
    if peak <= 1e-6:
        return np.zeros(rms.size, dtype=bool)
    threshold = max(float(np.median(rms)) * 0.35, peak * 0.04, 1e-5)
    return rms >= threshold


def _normalize_chroma(chroma: np.ndarray) -> np.ndarray:
    if chroma.size == 0:
        return chroma.astype(np.float32)
    chroma = np.nan_to_num(chroma.astype(np.float32), copy=False)
    column_norms = np.linalg.norm(chroma, axis=0)
    active_columns = column_norms > 0.0
    chroma[:, active_columns] /= column_norms[active_columns]
    return chroma.astype(np.float32)


def _match_frame_count(values: np.ndarray, frame_count: int) -> np.ndarray:
    if values.ndim == 2:
        if values.shape[1] == frame_count:
            return values.astype(np.float32)
        if values.shape[1] > frame_count:
            return values[:, :frame_count].astype(np.float32)
        padding = np.repeat(values[:, -1:], frame_count - values.shape[1], axis=1) if values.shape[1] else np.zeros(
            (values.shape[0], frame_count),
            dtype=np.float32,
        )
        return np.concatenate([values, padding], axis=1).astype(np.float32)

    if values.shape[0] == frame_count:
        return values.astype(np.float32)
    if values.shape[0] > frame_count:
        return values[:frame_count].astype(np.float32)
    if values.shape[0] == 0:
        return np.zeros(frame_count, dtype=np.float32)
    padding = np.repeat(values[-1:], frame_count - values.shape[0])
    return np.concatenate([values, padding]).astype(np.float32)


def _safe_fft_size(signal_size: int, preferred_n_fft: int) -> int:
    if signal_size <= 0:
        return preferred_n_fft
    if signal_size >= preferred_n_fft:
        return preferred_n_fft
    exponent = int(np.floor(np.log2(max(signal_size, 32))))
    return max(32, 2**exponent)
