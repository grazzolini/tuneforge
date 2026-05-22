from __future__ import annotations

import warnings
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

ANALYSIS_SAMPLE_RATE = 22_050
ANALYSIS_HOP_LENGTH = 512
MIN_DETECTED_BEATS = 4
WEAK_DETECTED_BEATS = 8
MIN_BEAT_INTERVAL_SECONDS = 0.25
MAX_BEAT_INTERVAL_SECONDS = 2.0


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

    primary_signal = percussive_signal if _has_analysis_energy(percussive_signal) else fallback_signal

    static_tempo_raw, static_beat_frames = _beat_track(primary_signal)
    if _beat_track_is_weak(static_beat_frames) and primary_signal is not fallback_signal:
        static_tempo_raw, static_beat_frames = _beat_track(fallback_signal)

    dynamic_tempo_raw, dynamic_beat_frames = _dynamic_beat_track(primary_signal)
    if _beat_track_is_weak(dynamic_beat_frames) and primary_signal is not fallback_signal:
        fallback_dynamic_tempo_raw, fallback_dynamic_beat_frames = _dynamic_beat_track(fallback_signal)
        if _beat_track_quality(fallback_dynamic_beat_frames) >= _beat_track_quality(dynamic_beat_frames):
            dynamic_tempo_raw = fallback_dynamic_tempo_raw
            dynamic_beat_frames = fallback_dynamic_beat_frames

    tempo_raw, beat_frames = _select_beat_track(
        static_tempo_raw,
        static_beat_frames,
        dynamic_tempo_raw,
        dynamic_beat_frames,
    )

    tempo = _tempo_value(tempo_raw)
    if _beat_track_is_weak(beat_frames) or tempo is None:
        tempo_bpm = _onset_tempo(fallback_signal)
    else:
        tempo_bpm = round(_normalize_tempo(tempo), 2)
    return tempo_bpm, np.asarray(beat_frames, dtype=np.int64)


def _has_analysis_energy(signal: np.ndarray) -> bool:
    return signal.size >= ANALYSIS_SAMPLE_RATE and float(np.max(np.abs(signal), initial=0.0)) > 1e-5


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
    return np.asarray(tempo_raw, dtype=np.float64), _clean_beat_frames(beat_frames)


def _dynamic_beat_track(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if signal.size < ANALYSIS_SAMPLE_RATE:
        return np.zeros(1, dtype=np.float64), np.zeros(0, dtype=np.int64)
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=FutureWarning)
        warnings.filterwarnings("ignore", category=UserWarning)
        try:
            onset_envelope = librosa.onset.onset_strength(
                y=signal,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
            )
            if not _has_onset_energy(onset_envelope, minimum_count=MIN_DETECTED_BEATS):
                return np.zeros(1, dtype=np.float64), np.zeros(0, dtype=np.int64)
            tempo_dynamic = librosa.feature.tempo(
                onset_envelope=onset_envelope,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
                aggregate=None,
                std_bpm=4.0,
            )
            tempo_dynamic = _sanitize_dynamic_tempo(tempo_dynamic, onset_envelope.size)
            if tempo_dynamic.size == 0:
                return np.zeros(1, dtype=np.float64), np.zeros(0, dtype=np.int64)
            tempo_raw, beat_frames = librosa.beat.beat_track(
                onset_envelope=onset_envelope,
                sr=ANALYSIS_SAMPLE_RATE,
                hop_length=ANALYSIS_HOP_LENGTH,
                bpm=tempo_dynamic,
                trim=False,
            )
            beat_frames = _fill_skipped_onset_beats(beat_frames, onset_envelope)
        except Exception:
            return np.zeros(1, dtype=np.float64), np.zeros(0, dtype=np.int64)

    tempo_values = np.asarray(tempo_raw, dtype=np.float64).reshape(-1)
    if tempo_values.size == 0:
        tempo_values = tempo_dynamic
    return tempo_values, _clean_beat_frames(beat_frames)


def _sanitize_dynamic_tempo(tempo_raw: np.ndarray, frame_count: int) -> np.ndarray:
    tempo_values = np.asarray(tempo_raw, dtype=np.float64).reshape(-1)
    if tempo_values.size == 0:
        return np.zeros(0, dtype=np.float64)
    valid = np.isfinite(tempo_values) & (tempo_values > 0.0)
    if not bool(valid.any()):
        return np.zeros(0, dtype=np.float64)
    fill_value = float(np.median(tempo_values[valid]))
    tempo_values = np.where(valid, tempo_values, fill_value).astype(np.float64)
    if tempo_values.size == frame_count:
        return tempo_values.astype(np.float64)
    return _match_frame_count(tempo_values.astype(np.float32), frame_count).astype(np.float64)


def _select_beat_track(
    static_tempo_raw: np.ndarray,
    static_beat_frames: np.ndarray,
    dynamic_tempo_raw: np.ndarray,
    dynamic_beat_frames: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    dynamic_quality = _beat_track_quality(dynamic_beat_frames)
    if dynamic_quality <= 0.0:
        return static_tempo_raw, static_beat_frames

    static_quality = _beat_track_quality(static_beat_frames)
    if static_quality <= 0.0:
        return dynamic_tempo_raw, dynamic_beat_frames

    if (
        static_beat_frames.size >= WEAK_DETECTED_BEATS
        and dynamic_beat_frames.size < max(MIN_DETECTED_BEATS, int(static_beat_frames.size * 0.75))
    ):
        return static_tempo_raw, static_beat_frames

    static_interval_cv = _beat_interval_cv(static_beat_frames)
    dynamic_interval_cv = _beat_interval_cv(dynamic_beat_frames)
    if dynamic_interval_cv > static_interval_cv + 0.25 and dynamic_beat_frames.size <= static_beat_frames.size:
        return static_tempo_raw, static_beat_frames

    if dynamic_quality + 0.05 < static_quality:
        return static_tempo_raw, static_beat_frames
    return dynamic_tempo_raw, dynamic_beat_frames


def _beat_track_is_weak(beat_frames: np.ndarray) -> bool:
    return beat_frames.size < WEAK_DETECTED_BEATS or _beat_track_quality(beat_frames) <= 0.0


def _beat_track_quality(beat_frames: np.ndarray) -> float:
    cleaned_frames = _clean_beat_frames(beat_frames)
    if cleaned_frames.size < MIN_DETECTED_BEATS:
        return 0.0

    intervals = _beat_intervals_seconds(cleaned_frames)
    if intervals.size == 0:
        return 0.0
    plausible = (intervals >= MIN_BEAT_INTERVAL_SECONDS) & (intervals <= MAX_BEAT_INTERVAL_SECONDS)
    plausible_ratio = float(np.count_nonzero(plausible) / intervals.size)
    if plausible_ratio < 0.75:
        return 0.0

    count_score = min(float(cleaned_frames.size) / WEAK_DETECTED_BEATS, 2.0)
    stability_score = max(0.0, 1.0 - min(_beat_interval_cv(cleaned_frames), 1.0) * 0.35)
    return count_score * plausible_ratio * stability_score


def _fill_skipped_onset_beats(beat_frames: np.ndarray, onset_envelope: np.ndarray) -> np.ndarray:
    cleaned_frames = _clean_beat_frames(beat_frames)
    if cleaned_frames.size < 2 or onset_envelope.size == 0:
        return cleaned_frames

    peak = float(np.max(onset_envelope, initial=0.0))
    if peak <= 0.0:
        return cleaned_frames
    insertion_threshold = _onset_insertion_threshold(onset_envelope, peak)

    added_frames: list[int] = []
    for previous_frame, next_frame in zip(cleaned_frames[:-1], cleaned_frames[1:], strict=True):
        interval = int(next_frame - previous_frame)
        if interval * (ANALYSIS_HOP_LENGTH / ANALYSIS_SAMPLE_RATE) < 0.7:
            continue

        midpoint = int(previous_frame + interval // 2)
        search_radius = max(1, int(round(interval * 0.15)))
        candidate_frame, candidate_strength = _strongest_onset_near(
            onset_envelope,
            midpoint,
            search_radius,
        )
        previous_strength = _onset_strength_near(onset_envelope, int(previous_frame), search_radius)
        next_strength = _onset_strength_near(onset_envelope, int(next_frame), search_radius)
        reference_strength = max(previous_strength, next_strength, peak)
        if candidate_strength >= max(reference_strength * 0.1, insertion_threshold):
            added_frames.append(candidate_frame)

    if not added_frames:
        return cleaned_frames
    return _clean_beat_frames(np.concatenate([cleaned_frames, np.asarray(added_frames, dtype=np.int64)]))


def _onset_insertion_threshold(onset_envelope: np.ndarray, peak: float) -> float:
    active_onsets = onset_envelope[np.isfinite(onset_envelope) & (onset_envelope > 0.0)]
    if active_onsets.size == 0:
        return peak
    return max(peak * 0.1, float(np.percentile(active_onsets, 75.0)) * 1.5)


def _strongest_onset_near(
    onset_envelope: np.ndarray,
    frame: int,
    radius: int,
) -> tuple[int, float]:
    start = max(0, frame - radius)
    end = min(onset_envelope.size, frame + radius + 1)
    if start >= end:
        return frame, 0.0
    local = onset_envelope[start:end]
    local_index = int(np.argmax(local))
    candidate_frame = start + local_index
    return candidate_frame, float(local[local_index])


def _onset_strength_near(onset_envelope: np.ndarray, frame: int, radius: int) -> float:
    return _strongest_onset_near(onset_envelope, frame, radius)[1]


def _beat_interval_cv(beat_frames: np.ndarray) -> float:
    intervals = _beat_intervals_seconds(beat_frames)
    if intervals.size == 0:
        return 1.0
    median_interval = float(np.median(intervals))
    if median_interval <= 0.0:
        return 1.0
    return float(np.median(np.abs(intervals - median_interval)) / median_interval)


def _beat_intervals_seconds(beat_frames: np.ndarray) -> np.ndarray:
    cleaned_frames = _clean_beat_frames(beat_frames)
    if cleaned_frames.size < 2:
        return np.zeros(0, dtype=np.float64)
    intervals = np.diff(cleaned_frames).astype(np.float64) * (ANALYSIS_HOP_LENGTH / ANALYSIS_SAMPLE_RATE)
    return intervals[np.isfinite(intervals)]


def _clean_beat_frames(beat_frames: np.ndarray) -> np.ndarray:
    frames = np.asarray(beat_frames)
    if frames.size == 0:
        return np.zeros(0, dtype=np.int64)
    finite_frames = frames[np.isfinite(frames)]
    if finite_frames.size == 0:
        return np.zeros(0, dtype=np.int64)
    nonnegative_frames = finite_frames[finite_frames >= 0]
    if nonnegative_frames.size == 0:
        return np.zeros(0, dtype=np.int64)
    return np.unique(nonnegative_frames.astype(np.int64))


def _has_onset_energy(onset_envelope: np.ndarray, *, minimum_count: int) -> bool:
    peak = float(np.max(onset_envelope, initial=0.0))
    return peak > 0.0 and int(np.count_nonzero(onset_envelope > peak * 0.3)) >= minimum_count


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
            if not _has_onset_energy(onset_envelope, minimum_count=12):
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
    tempo_values = np.asarray(tempo_raw, dtype=np.float64).reshape(-1)
    tempo_values = tempo_values[np.isfinite(tempo_values) & (tempo_values > 0.0)]
    tempo = float(np.median(tempo_values)) if tempo_values.size else 0.0
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
