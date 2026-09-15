#![cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]

use realfft::{
    num_complex::{Complex32, Complex64},
    RealFftPlanner,
};
use rustfft::FftPlanner;
#[cfg(test)]
use sha2::{Digest as _, Sha256};

use super::decode::DecodedAudio;
use super::soxr::resample_hq;

pub const ANALYSIS_SAMPLE_RATE: u32 = 22_050;
pub const ANALYSIS_HOP_LENGTH: usize = 512;
const STFT_SIZE: usize = 2_048;
const CQT_BINS_PER_OCTAVE: usize = 36;
const CQT_OCTAVES: usize = 7;
const CQT_FMIN: f64 = 32.703_195_662_574_83;

#[derive(Clone, Debug)]
pub struct HarmonicFeatures {
    pub duration_seconds: f64,
    pub chroma_cqt: Vec<[f64; 12]>,
    pub chroma_cens: Vec<[f64; 12]>,
    pub rms: Vec<f64>,
    pub active_frame_mask: Vec<bool>,
    pub beat_frames: Vec<usize>,
    pub estimated_reference_hz: Option<f64>,
    pub tuning_offset_cents: Option<f64>,
}

pub fn extract_harmonic_features_from_audio(
    source: &DecodedAudio,
) -> Result<HarmonicFeatures, String> {
    extract_harmonic_features_from_audio_with_cancel(source, &|| false)
}

pub fn extract_harmonic_features_from_audio_with_cancel<F>(
    source: &DecodedAudio,
    should_cancel: &F,
) -> Result<HarmonicFeatures, String>
where
    F: Fn() -> bool,
{
    if source.sample_rate == 0 || source.channels == 0 {
        return Err("Decoded audio contained invalid stream metadata.".to_string());
    }
    if source.samples.is_empty() {
        return Err("Decoded audio contained no samples.".to_string());
    }
    let signal = if source.sample_rate == ANALYSIS_SAMPLE_RATE {
        source.samples.clone()
    } else {
        resample_hq(&source.samples, source.sample_rate, ANALYSIS_SAMPLE_RATE)?
    };
    check_cancelled(should_cancel)?;
    let duration_seconds = source.samples.len() as f64 / source.sample_rate as f64;
    let (harmonic_signal, percussive_signal) =
        split_harmonic_percussive_with_cancel(&signal, should_cancel)?;
    check_cancelled(should_cancel)?;
    let tuning_offset_cents = estimate_tuning_offset_cents(&harmonic_signal, ANALYSIS_SAMPLE_RATE)?;
    check_cancelled(should_cancel)?;
    let estimated_reference_hz =
        tuning_offset_cents.map(|cents| 440.0 * 2.0_f64.powf(cents / 1_200.0));
    let chroma_cqt = recursive_cqt_chroma_with_cancel(
        &harmonic_signal,
        tuning_offset_cents.unwrap_or(0.0),
        should_cancel,
    )?;
    let rms = rms_frames(&signal, chroma_cqt.len());
    let chroma_cens = cens_frames(&chroma_cqt);
    let peak_rms = rms.iter().copied().fold(0.0_f64, f64::max);
    let median_rms = median(rms.iter().copied().collect());
    let threshold = (median_rms * 0.35).max(peak_rms * 0.04).max(1.0e-5);
    let active_frame_mask = rms
        .iter()
        .map(|value| peak_rms > 1.0e-6 && *value >= threshold)
        .collect();
    let beat_frames =
        estimate_internal_beat_frames_with_cancel(&percussive_signal, &signal, should_cancel)?
            .into_iter()
            .filter(|frame| *frame < chroma_cqt.len())
            .collect();
    Ok(HarmonicFeatures {
        duration_seconds,
        chroma_cqt,
        chroma_cens,
        rms,
        active_frame_mask,
        beat_frames,
        estimated_reference_hz,
        tuning_offset_cents,
    })
}

fn check_cancelled<F>(should_cancel: &F) -> Result<(), String>
where
    F: Fn() -> bool,
{
    if should_cancel() {
        Err("AUDIO_ANALYSIS_CANCELLED".to_string())
    } else {
        Ok(())
    }
}

pub fn combined_chroma(features: &HarmonicFeatures) -> Vec<[f64; 12]> {
    features
        .chroma_cqt
        .iter()
        .zip(&features.chroma_cens)
        .map(|(cqt, cens)| {
            std::array::from_fn(|index| {
                f64::from(0.65_f32 * cqt[index] as f32 + 0.35_f32 * cens[index] as f32)
            })
        })
        .collect()
}

pub fn active_chroma_mean(features: &HarmonicFeatures) -> [f64; 12] {
    let chroma = combined_chroma(features);
    let mut result = [0.0_f32; 12];
    let mut total_weight = 0.0_f32;
    for (index, frame) in chroma.iter().enumerate() {
        if features
            .active_frame_mask
            .get(index)
            .copied()
            .unwrap_or(false)
        {
            let weight = features.rms.get(index).copied().unwrap_or(0.0) as f32;
            for pitch in 0..12 {
                result[pitch] += frame[pitch] as f32 * weight;
            }
            total_weight += weight;
        }
    }
    if total_weight <= 0.0 {
        for frame in &chroma {
            for pitch in 0..12 {
                result[pitch] += frame[pitch] as f32;
            }
        }
        total_weight = chroma.len() as f32;
    }
    if total_weight > 0.0 {
        for value in &mut result {
            *value /= total_weight;
        }
    }
    result.map(f64::from)
}

fn stft(signal: &[f32]) -> Result<Vec<Vec<Complex64>>, String> {
    stft_with_cancel(signal, &|| false)
}

fn stft_with_cancel<F>(signal: &[f32], should_cancel: &F) -> Result<Vec<Vec<Complex64>>, String>
where
    F: Fn() -> bool,
{
    let frame_count = 1 + signal.len() / ANALYSIS_HOP_LENGTH;
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(STFT_SIZE);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let window = (0..STFT_SIZE)
        .map(|index| {
            0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / STFT_SIZE as f64).cos()
        })
        .collect::<Vec<_>>();
    let mut frames = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        if frame % 8 == 0 {
            check_cancelled(should_cancel)?;
        }
        let center = frame * ANALYSIS_HOP_LENGTH;
        let start = center as isize - STFT_SIZE as isize / 2;
        for index in 0..STFT_SIZE {
            let source_index = start + index as isize;
            let sample = if source_index < 0 || source_index as usize >= signal.len() {
                0.0
            } else {
                signal[source_index as usize]
            } as f64;
            input[index] = sample * window[index];
        }
        fft.process(&mut input, &mut spectrum)
            .map_err(|error| error.to_string())?;
        frames.push(spectrum.clone());
    }
    Ok(frames)
}

fn split_harmonic_percussive(signal: &[f32]) -> Result<(Vec<f32>, Vec<f32>), String> {
    split_harmonic_percussive_with_cancel(signal, &|| false)
}

fn split_harmonic_percussive_with_cancel<F>(
    signal: &[f32],
    should_cancel: &F,
) -> Result<(Vec<f32>, Vec<f32>), String>
where
    F: Fn() -> bool,
{
    check_cancelled(should_cancel)?;
    if signal.len() < ANALYSIS_HOP_LENGTH * 4 {
        return Ok((signal.to_vec(), vec![0.0; signal.len()]));
    }
    let spectrum = stft_with_cancel(signal, should_cancel)?;
    let frames = spectrum.len();
    let bins = STFT_SIZE / 2 + 1;
    let mut magnitudes = Vec::with_capacity(frames);
    for (frame, values) in spectrum.iter().enumerate() {
        if frame % 8 == 0 {
            check_cancelled(should_cancel)?;
        }
        magnitudes.push(values.iter().map(|value| value.norm()).collect::<Vec<_>>());
    }
    let mut harmonic_spectrum = spectrum.clone();
    let mut percussive_spectrum = spectrum;
    for frame in 0..frames {
        if frame % 4 == 0 {
            check_cancelled(should_cancel)?;
        }
        for bin in 0..bins {
            let harmonic = median(
                (-15..=15)
                    .map(|offset| magnitudes[reflect_index(frame as isize + offset, frames)][bin])
                    .collect(),
            );
            let percussive = median(
                (-15..=15)
                    .map(|offset| magnitudes[frame][reflect_index(bin as isize + offset, bins)])
                    .collect(),
            );
            let h2 = harmonic * harmonic;
            let p2 = percussive * percussive;
            let harmonic_mask = if h2 + p2 > 0.0 { h2 / (h2 + p2) } else { 0.0 };
            let p_margin = 5.0 * harmonic;
            let percussive_mask = if p2 + p_margin * p_margin > 0.0 {
                p2 / (p2 + p_margin * p_margin)
            } else {
                0.0
            };
            harmonic_spectrum[frame][bin] *= harmonic_mask;
            percussive_spectrum[frame][bin] *= percussive_mask;
        }
    }
    Ok((
        istft_with_cancel(&harmonic_spectrum, signal.len(), should_cancel)?,
        istft_with_cancel(&percussive_spectrum, signal.len(), should_cancel)?,
    ))
}

fn reflect_index(index: isize, length: usize) -> usize {
    if length <= 1 {
        return 0;
    }
    let period = (length * 2) as isize;
    let reflected = index.rem_euclid(period);
    if reflected < length as isize {
        reflected as usize
    } else {
        (period - reflected - 1) as usize
    }
}

fn istft(spectrum: &[Vec<Complex64>], length: usize) -> Result<Vec<f32>, String> {
    istft_with_cancel(spectrum, length, &|| false)
}

fn istft_with_cancel<F>(
    spectrum: &[Vec<Complex64>],
    length: usize,
    should_cancel: &F,
) -> Result<Vec<f32>, String>
where
    F: Fn() -> bool,
{
    let mut planner = RealFftPlanner::<f64>::new();
    let inverse = planner.plan_fft_inverse(STFT_SIZE);
    let window = (0..STFT_SIZE)
        .map(|index| {
            0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / STFT_SIZE as f64).cos()
        })
        .collect::<Vec<_>>();
    let mut padded = vec![0.0_f64; length + STFT_SIZE];
    let mut weights = vec![0.0_f64; padded.len()];
    for (frame, values) in spectrum.iter().enumerate() {
        if frame % 8 == 0 {
            check_cancelled(should_cancel)?;
        }
        let mut values = values.clone();
        let mut time = inverse.make_output_vec();
        inverse
            .process(&mut values, &mut time)
            .map_err(|error| error.to_string())?;
        let start = frame * ANALYSIS_HOP_LENGTH;
        for index in 0..STFT_SIZE {
            if start + index >= padded.len() {
                break;
            }
            let value = time[index] / STFT_SIZE as f64 * window[index];
            padded[start + index] += value;
            weights[start + index] += window[index] * window[index];
        }
    }
    for (value, weight) in padded.iter_mut().zip(weights) {
        if weight > 1.0e-12 {
            *value /= weight;
        }
    }
    Ok(padded[STFT_SIZE / 2..STFT_SIZE / 2 + length]
        .iter()
        .map(|value| *value as f32)
        .collect())
}

fn recursive_cqt_chroma(signal: &[f32], tuning_bins: f64) -> Result<Vec<[f64; 12]>, String> {
    recursive_cqt_chroma_with_cancel(signal, tuning_bins, &|| false)
}

fn recursive_cqt_chroma_with_cancel<F>(
    signal: &[f32],
    tuning_bins: f64,
    should_cancel: &F,
) -> Result<Vec<[f64; 12]>, String>
where
    F: Fn() -> bool,
{
    let tuned_fmin = CQT_FMIN * 2.0_f64.powf((tuning_bins / 100.0) / CQT_BINS_PER_OCTAVE as f64);
    let cqt = constant_q_magnitude_with_cancel(
        signal,
        ANALYSIS_SAMPLE_RATE,
        ANALYSIS_HOP_LENGTH,
        tuned_fmin,
        CQT_OCTAVES * CQT_BINS_PER_OCTAVE,
        CQT_BINS_PER_OCTAVE,
        should_cancel,
    )?;
    let frame_count = cqt.first().map(Vec::len).unwrap_or(0);
    let mut chroma = vec![[0.0; 12]; frame_count];
    for (bin, values) in cqt.iter().enumerate() {
        let pitch = ((bin + 1) / (CQT_BINS_PER_OCTAVE / 12)) % 12;
        for frame in 0..frame_count {
            chroma[frame][pitch] += values[frame];
        }
    }
    for frame in &mut chroma {
        let max = frame.iter().copied().fold(0.0_f64, f64::max);
        if max > 0.0 {
            for value in frame.iter_mut() {
                *value /= max;
            }
        }
        normalize_l2(frame);
    }
    Ok(chroma)
}

pub(crate) fn constant_q_magnitude(
    signal: &[f32],
    sample_rate: u32,
    hop_length: usize,
    fmin: f64,
    n_bins: usize,
    bins_per_octave: usize,
) -> Result<Vec<Vec<f64>>, String> {
    constant_q_magnitude_with_cancel(
        signal,
        sample_rate,
        hop_length,
        fmin,
        n_bins,
        bins_per_octave,
        &|| false,
    )
}

pub(crate) fn constant_q_magnitude_with_cancel<F>(
    signal: &[f32],
    sample_rate: u32,
    hop_length: usize,
    fmin: f64,
    n_bins: usize,
    bins_per_octave: usize,
    should_cancel: &F,
) -> Result<Vec<Vec<f64>>, String>
where
    F: Fn() -> bool,
{
    if signal.is_empty()
        || sample_rate == 0
        || hop_length == 0
        || n_bins == 0
        || bins_per_octave == 0
    {
        return Ok(Vec::new());
    }
    let ratio = 2.0_f64.powf(1.0 / bins_per_octave as f64);
    let alpha = (ratio * ratio - 1.0) / (ratio * ratio + 1.0);
    let q = 1.0 / alpha;
    let frequencies = (0..n_bins)
        .map(|bin| fmin * 2.0_f64.powf(bin as f64 / bins_per_octave as f64))
        .collect::<Vec<_>>();
    let n_octaves = n_bins.div_ceil(bins_per_octave);
    let window_bandwidth = 1.500_183_105_468_75;
    let cutoff = frequencies
        .iter()
        .map(|frequency| frequency * (1.0 + 0.5 * window_bandwidth / q))
        .fold(0.0_f64, f64::max);
    let spectral_downsamples =
        ((sample_rate as f64 / 2.0 / cutoff).log2().ceil() as isize - 2).max(0) as usize;
    let hop_downsamples = hop_length.trailing_zeros() as usize;
    let early_count = spectral_downsamples.min(hop_downsamples.saturating_sub(n_octaves - 1));
    let mut base_signal = signal.to_vec();
    let mut base_rate = sample_rate as f64;
    let mut base_hop = hop_length;
    if early_count > 0 {
        let factor = 1_u32 << early_count;
        base_signal = resample_hq(&base_signal, factor, 1)?;
        for sample in &mut base_signal {
            *sample = (f64::from(*sample) / (1.0 / factor as f64).sqrt()) as f32;
        }
        base_rate /= factor as f64;
        base_hop /= factor as usize;
    }
    let original_lengths = frequencies
        .iter()
        .map(|frequency| q * base_rate / frequency)
        .collect::<Vec<_>>();
    let mut responses = vec![Vec::new(); n_bins];
    let mut octave_signal = base_signal;
    let mut octave_rate = base_rate;
    let mut octave_hop = base_hop;
    for octave_from_top in 0..n_octaves {
        check_cancelled(should_cancel)?;
        let end = n_bins.saturating_sub(octave_from_top * bins_per_octave);
        let start = end.saturating_sub(bins_per_octave);
        let basis_scale = (base_rate / octave_rate).sqrt();
        let octave = cqt_octave_response(
            &octave_signal,
            octave_rate,
            octave_hop,
            &frequencies[start..end],
            q,
            basis_scale,
            &original_lengths[start..end],
            should_cancel,
        )?;
        responses[start..end].clone_from_slice(&octave);
        if octave_from_top + 1 < n_octaves {
            let next_frequency = frequencies[start - 1];
            if octave_hop % 2 != 0 || next_frequency > octave_rate / 5.0 {
                continue;
            }
            octave_signal = resample_hq(&octave_signal, 2, 1)?;
            for sample in &mut octave_signal {
                *sample = (f64::from(*sample) / 0.5_f64.sqrt()) as f32;
            }
            octave_rate /= 2.0;
            octave_hop /= 2;
        }
    }
    let frame_count = responses.iter().map(Vec::len).min().unwrap_or(0);
    for values in &mut responses {
        values.truncate(frame_count);
    }
    Ok(responses)
}

fn cqt_octave_response(
    signal: &[f32],
    sample_rate: f64,
    hop_length: usize,
    frequencies: &[f64],
    q: f64,
    basis_scale: f64,
    output_lengths: &[f64],
    should_cancel: &impl Fn() -> bool,
) -> Result<Vec<Vec<f64>>, String> {
    Ok(cqt_octave_complex_response(
        signal,
        sample_rate,
        hop_length,
        frequencies,
        q,
        basis_scale,
        output_lengths,
        should_cancel,
    )?
    .into_iter()
    .map(|row| {
        row.into_iter()
            .map(|value| f64::from(value.norm()))
            .collect()
    })
    .collect())
}

fn cqt_octave_complex_response(
    signal: &[f32],
    sample_rate: f64,
    hop_length: usize,
    frequencies: &[f64],
    q: f64,
    basis_scale: f64,
    output_lengths: &[f64],
    should_cancel: &impl Fn() -> bool,
) -> Result<Vec<Vec<Complex32>>, String> {
    let (n_fft, mut basis) = cqt_fft_basis(sample_rate, frequencies, q);
    let bins = n_fft / 2 + 1;
    debug_assert!(basis.iter().all(|row| row.len() == bins));
    for row in &mut basis {
        for value in row {
            value.re = (f64::from(value.re) * basis_scale) as f32;
            value.im = (f64::from(value.im) * basis_scale) as f32;
        }
    }

    let frame_count = 1 + signal.len() / hop_length;
    let mut response = vec![vec![Complex32::new(0.0, 0.0); frame_count]; frequencies.len()];
    let mut frame_planner = RealFftPlanner::<f64>::new();
    let frame_fft = frame_planner.plan_fft_forward(n_fft);
    let mut input = frame_fft.make_input_vec();
    let mut spectrum = frame_fft.make_output_vec();
    for frame in 0..frame_count {
        if frame % 4 == 0 {
            check_cancelled(should_cancel)?;
        }
        let center = frame * hop_length;
        let start = center as isize - n_fft as isize / 2;
        for (index, value) in input.iter_mut().enumerate() {
            let source = start + index as isize;
            *value = if source >= 0 && (source as usize) < signal.len() {
                f64::from(signal[source as usize])
            } else {
                0.0
            };
        }
        frame_fft
            .process(&mut input, &mut spectrum)
            .map_err(|error| error.to_string())?;
        for (bin, row) in basis.iter().enumerate() {
            let mut projected = row
                .iter()
                .zip(&spectrum)
                .map(|(filter, value)| filter * Complex32::new(value.re as f32, value.im as f32))
                .sum::<Complex32>();
            let output_scale = output_lengths[bin].sqrt();
            projected.re = (f64::from(projected.re) / output_scale) as f32;
            projected.im = (f64::from(projected.im) / output_scale) as f32;
            response[bin][frame] = projected;
        }
    }
    Ok(response)
}

#[cfg(test)]
pub(crate) fn constant_q_complex_for_test(
    signal: &[f32],
    sample_rate: u32,
    hop_length: usize,
    fmin: f64,
    n_bins: usize,
    bins_per_octave: usize,
) -> Result<Vec<Vec<Complex32>>, String> {
    if signal.is_empty()
        || sample_rate == 0
        || hop_length == 0
        || n_bins == 0
        || bins_per_octave == 0
    {
        return Ok(Vec::new());
    }
    let ratio = 2.0_f64.powf(1.0 / bins_per_octave as f64);
    let alpha = (ratio * ratio - 1.0) / (ratio * ratio + 1.0);
    let q = 1.0 / alpha;
    let frequencies = (0..n_bins)
        .map(|bin| fmin * 2.0_f64.powf(bin as f64 / bins_per_octave as f64))
        .collect::<Vec<_>>();
    let n_octaves = n_bins.div_ceil(bins_per_octave);
    let window_bandwidth = 1.500_183_105_468_75;
    let cutoff = frequencies
        .iter()
        .map(|frequency| frequency * (1.0 + 0.5 * window_bandwidth / q))
        .fold(0.0_f64, f64::max);
    let spectral_downsamples =
        ((sample_rate as f64 / 2.0 / cutoff).log2().ceil() as isize - 2).max(0) as usize;
    let hop_downsamples = hop_length.trailing_zeros() as usize;
    let early_count = spectral_downsamples.min(hop_downsamples.saturating_sub(n_octaves - 1));
    let mut base_signal = signal.to_vec();
    let mut base_rate = sample_rate as f64;
    let mut base_hop = hop_length;
    if early_count > 0 {
        let factor = 1_u32 << early_count;
        base_signal = resample_hq(&base_signal, factor, 1)?;
        for sample in &mut base_signal {
            *sample = (f64::from(*sample) / (1.0 / factor as f64).sqrt()) as f32;
        }
        base_rate /= factor as f64;
        base_hop /= factor as usize;
    }
    let original_lengths = frequencies
        .iter()
        .map(|frequency| q * base_rate / frequency)
        .collect::<Vec<_>>();
    let mut responses = vec![Vec::new(); n_bins];
    let mut octave_signal = base_signal;
    let mut octave_rate = base_rate;
    let mut octave_hop = base_hop;
    for octave_from_top in 0..n_octaves {
        let end = n_bins.saturating_sub(octave_from_top * bins_per_octave);
        let start = end.saturating_sub(bins_per_octave);
        let basis_scale = (base_rate / octave_rate).sqrt();
        let octave = cqt_octave_complex_response(
            &octave_signal,
            octave_rate,
            octave_hop,
            &frequencies[start..end],
            q,
            basis_scale,
            &original_lengths[start..end],
            &|| false,
        )?;
        responses[start..end].clone_from_slice(&octave);
        if octave_from_top + 1 < n_octaves {
            let next_frequency = frequencies[start - 1];
            if octave_hop % 2 != 0 || next_frequency > octave_rate / 5.0 {
                continue;
            }
            octave_signal = resample_hq(&octave_signal, 2, 1)?;
            for sample in &mut octave_signal {
                *sample = (f64::from(*sample) / 0.5_f64.sqrt()) as f32;
            }
            octave_rate /= 2.0;
            octave_hop /= 2;
        }
    }
    let frame_count = responses.iter().map(Vec::len).min().unwrap_or(0);
    for values in &mut responses {
        values.truncate(frame_count);
    }
    Ok(responses)
}

#[cfg(test)]
pub(crate) struct CqtProjectionStageCapture {
    pub octave_from_top: usize,
    pub global_bin: usize,
    pub frame: usize,
    pub sample_rate: f64,
    pub hop_length: usize,
    pub n_fft: usize,
    pub basis_scale: f64,
    pub output_length: f64,
    pub octave_signal_sha256: String,
    pub fft_input_sha256: String,
    pub basis_indices: Vec<u32>,
    pub basis_values: Vec<Complex32>,
    pub spectrum: Vec<Complex32>,
    pub projected_before_output_scale: Complex32,
    pub projected_after_output_scale: Complex32,
}

#[cfg(test)]
pub(crate) fn capture_cqt_projection_stages_for_test(
    signal: &[f32],
    sample_rate: u32,
    hop_length: usize,
    fmin: f64,
    n_bins: usize,
    bins_per_octave: usize,
    coordinates: &[(usize, usize, usize)],
) -> Result<Vec<CqtProjectionStageCapture>, String> {
    let ratio = 2.0_f64.powf(1.0 / bins_per_octave as f64);
    let alpha = (ratio * ratio - 1.0) / (ratio * ratio + 1.0);
    let q = 1.0 / alpha;
    let frequencies = (0..n_bins)
        .map(|bin| fmin * 2.0_f64.powf(bin as f64 / bins_per_octave as f64))
        .collect::<Vec<_>>();
    let n_octaves = n_bins.div_ceil(bins_per_octave);
    let window_bandwidth = 1.500_183_105_468_75;
    let cutoff = frequencies
        .iter()
        .map(|frequency| frequency * (1.0 + 0.5 * window_bandwidth / q))
        .fold(0.0_f64, f64::max);
    let spectral_downsamples =
        ((sample_rate as f64 / 2.0 / cutoff).log2().ceil() as isize - 2).max(0) as usize;
    let hop_downsamples = hop_length.trailing_zeros() as usize;
    let early_count = spectral_downsamples.min(hop_downsamples.saturating_sub(n_octaves - 1));
    let mut base_signal = signal.to_vec();
    let mut base_rate = sample_rate as f64;
    let mut base_hop = hop_length;
    if early_count > 0 {
        let factor = 1_u32 << early_count;
        base_signal = resample_hq(&base_signal, factor, 1)?;
        for sample in &mut base_signal {
            *sample = (f64::from(*sample) / (1.0 / factor as f64).sqrt()) as f32;
        }
        base_rate /= factor as f64;
        base_hop /= factor as usize;
    }
    let original_lengths = frequencies
        .iter()
        .map(|frequency| q * base_rate / frequency)
        .collect::<Vec<_>>();
    let mut octave_signal = base_signal;
    let mut octave_rate = base_rate;
    let mut octave_hop = base_hop;
    let mut captures = Vec::with_capacity(coordinates.len());
    for octave_from_top in 0..n_octaves {
        let end = n_bins.saturating_sub(octave_from_top * bins_per_octave);
        let start = end.saturating_sub(bins_per_octave);
        let selected = coordinates
            .iter()
            .filter(|(octave, bin, _)| *octave == octave_from_top && (*bin >= start && *bin < end))
            .copied()
            .collect::<Vec<_>>();
        if !selected.is_empty() {
            let mut octave_signal_hasher = Sha256::new();
            for value in &octave_signal {
                octave_signal_hasher.update(value.to_le_bytes());
            }
            let octave_signal_sha256 = octave_signal_hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let (n_fft, mut basis) = cqt_fft_basis(octave_rate, &frequencies[start..end], q);
            let basis_scale = (base_rate / octave_rate).sqrt();
            for row in &mut basis {
                for value in row {
                    value.re = (f64::from(value.re) * basis_scale) as f32;
                    value.im = (f64::from(value.im) * basis_scale) as f32;
                }
            }
            let mut planner = RealFftPlanner::<f64>::new();
            let fft = planner.plan_fft_forward(n_fft);
            let mut input = fft.make_input_vec();
            let mut spectrum = fft.make_output_vec();
            for (_, global_bin, frame) in selected {
                let center = frame * octave_hop;
                let frame_start = center as isize - n_fft as isize / 2;
                for (index, value) in input.iter_mut().enumerate() {
                    let source = frame_start + index as isize;
                    *value = if source >= 0 && (source as usize) < octave_signal.len() {
                        f64::from(octave_signal[source as usize])
                    } else {
                        0.0
                    };
                }
                fft.process(&mut input, &mut spectrum)
                    .map_err(|error| error.to_string())?;
                let mut fft_input_hasher = Sha256::new();
                for value in &input {
                    fft_input_hasher.update(value.to_le_bytes());
                }
                let fft_input_sha256 = fft_input_hasher
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let spectrum = spectrum
                    .iter()
                    .map(|value| Complex32::new(value.re as f32, value.im as f32))
                    .collect::<Vec<_>>();
                let row = &basis[global_bin - start];
                let basis_indices = row
                    .iter()
                    .enumerate()
                    .filter_map(|(index, value)| {
                        (*value != Complex32::new(0.0, 0.0)).then_some(index as u32)
                    })
                    .collect::<Vec<_>>();
                let basis_values = basis_indices
                    .iter()
                    .map(|index| row[*index as usize])
                    .collect::<Vec<_>>();
                let projected_before_output_scale = row
                    .iter()
                    .zip(&spectrum)
                    .map(|(filter, value)| filter * value)
                    .sum::<Complex32>();
                let output_length = original_lengths[global_bin];
                let output_scale = output_length.sqrt();
                let projected_after_output_scale = Complex32::new(
                    (f64::from(projected_before_output_scale.re) / output_scale) as f32,
                    (f64::from(projected_before_output_scale.im) / output_scale) as f32,
                );
                captures.push(CqtProjectionStageCapture {
                    octave_from_top,
                    global_bin,
                    frame,
                    sample_rate: octave_rate,
                    hop_length: octave_hop,
                    n_fft,
                    basis_scale,
                    output_length,
                    octave_signal_sha256: octave_signal_sha256.clone(),
                    fft_input_sha256,
                    basis_indices,
                    basis_values,
                    spectrum,
                    projected_before_output_scale,
                    projected_after_output_scale,
                });
            }
        }
        if octave_from_top + 1 < n_octaves {
            let next_frequency = frequencies[start - 1];
            if octave_hop % 2 != 0 || next_frequency > octave_rate / 5.0 {
                continue;
            }
            octave_signal = resample_hq(&octave_signal, 2, 1)?;
            for sample in &mut octave_signal {
                *sample = (f64::from(*sample) / 0.5_f64.sqrt()) as f32;
            }
            octave_rate /= 2.0;
            octave_hop /= 2;
        }
    }
    Ok(captures)
}

fn cqt_fft_basis(sample_rate: f64, frequencies: &[f64], q: f64) -> (usize, Vec<Vec<Complex32>>) {
    let lengths = frequencies
        .iter()
        .map(|frequency| q * sample_rate / frequency)
        .collect::<Vec<_>>();
    let n_fft =
        (lengths.iter().copied().fold(0.0_f64, f64::max).ceil() as usize).next_power_of_two();
    let bins = n_fft / 2 + 1;
    let mut basis_planner = FftPlanner::<f32>::new();
    let basis_fft = basis_planner.plan_fft_forward(n_fft);
    let mut basis = Vec::with_capacity(frequencies.len());
    for (&frequency, &fractional_length) in frequencies.iter().zip(&lengths) {
        let first_sample = (-fractional_length / 2.0).floor() as isize;
        let last_sample = (fractional_length / 2.0).floor() as isize;
        let length = (last_sample - first_sample) as usize;
        let left_pad = (n_fft - length) / 2;
        let mut fft_input = vec![Complex32::new(0.0, 0.0); n_fft];
        let mut norm = 0.0_f64;
        let mut wavelet = Vec::with_capacity(length);
        for index in 0..length {
            let centered = (first_sample + index as isize) as f64;
            let window =
                0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / length as f64).cos();
            norm += window;
            let phase = 2.0 * std::f64::consts::PI * frequency * centered / sample_rate;
            wavelet.push((window * phase.cos(), window * phase.sin()));
        }
        if norm > 0.0 {
            for (index, (real_value, imaginary_value)) in wavelet.into_iter().enumerate() {
                fft_input[left_pad + index] =
                    Complex32::new((real_value / norm) as f32, (imaginary_value / norm) as f32);
            }
            let scale = fractional_length / n_fft as f64;
            for value in &mut fft_input {
                value.re = (f64::from(value.re) * scale) as f32;
                value.im = (f64::from(value.im) * scale) as f32;
            }
        }
        basis_fft.process(&mut fft_input);
        let mut row = fft_input[..bins].to_vec();
        sparsify_fft_row32(&mut row, 0.01);
        basis.push(row);
    }
    (n_fft, basis)
}

fn sparsify_fft_row32(row: &mut [Complex32], quantile: f32) {
    let norm = row.iter().map(|value| value.norm()).sum::<f32>();
    if norm <= 0.0 {
        return;
    }
    let mut magnitudes = row.iter().map(|value| value.norm()).collect::<Vec<_>>();
    magnitudes.sort_by(f32::total_cmp);
    let mut cumulative = 0.0;
    let mut threshold = magnitudes[0];
    for magnitude in magnitudes {
        cumulative += magnitude / norm;
        threshold = magnitude;
        if cumulative >= quantile {
            break;
        }
    }
    for value in row {
        if value.norm() < threshold {
            *value = Complex32::new(0.0, 0.0);
        }
    }
}

fn estimate_internal_beat_frames(
    percussive: &[f32],
    fallback: &[f32],
) -> Result<Vec<usize>, String> {
    estimate_internal_beat_frames_with_cancel(percussive, fallback, &|| false)
}

fn estimate_internal_beat_frames_with_cancel<F>(
    percussive: &[f32],
    fallback: &[f32],
    should_cancel: &F,
) -> Result<Vec<usize>, String>
where
    F: Fn() -> bool,
{
    check_cancelled(should_cancel)?;
    if fallback.len() < ANALYSIS_SAMPLE_RATE as usize {
        return Ok(Vec::new());
    }
    let primary = if has_analysis_energy(percussive) {
        percussive
    } else {
        fallback
    };
    let primary_static_onsets = onset_strength_with_cancel(primary, true, should_cancel)?;
    let primary_dynamic_onsets = onset_strength_with_cancel(primary, false, should_cancel)?;
    let fallback_onsets = if std::ptr::eq(primary, fallback) {
        None
    } else {
        Some((
            onset_strength_with_cancel(fallback, true, should_cancel)?,
            onset_strength_with_cancel(fallback, false, should_cancel)?,
        ))
    };

    let mut static_track = track_beats_with_cancel(&primary_static_onsets, false, should_cancel)?;
    if beat_track_is_weak(&static_track) {
        if let Some((onsets, _)) = &fallback_onsets {
            static_track = track_beats_with_cancel(onsets, false, should_cancel)?;
        }
    }
    let mut dynamic_track = fill_skipped_onset_beats(
        track_beats_with_cancel(&primary_dynamic_onsets, true, should_cancel)?,
        &primary_dynamic_onsets,
    );
    if beat_track_is_weak(&dynamic_track) {
        if let Some((_, onsets)) = &fallback_onsets {
            let candidate = fill_skipped_onset_beats(
                track_beats_with_cancel(onsets, true, should_cancel)?,
                onsets,
            );
            if beat_track_quality(&candidate) >= beat_track_quality(&dynamic_track) {
                dynamic_track = candidate;
            }
        }
    }
    Ok(select_beat_track(&static_track, &dynamic_track))
}

fn has_analysis_energy(signal: &[f32]) -> bool {
    signal.len() >= ANALYSIS_SAMPLE_RATE as usize
        && signal.iter().any(|sample| sample.abs() > 1.0e-5)
}

fn onset_strength(signal: &[f32], median_aggregate: bool) -> Result<Vec<f64>, String> {
    onset_strength_with_cancel(signal, median_aggregate, &|| false)
}

fn onset_strength_with_cancel<F>(
    signal: &[f32],
    median_aggregate: bool,
    should_cancel: &F,
) -> Result<Vec<f64>, String>
where
    F: Fn() -> bool,
{
    const MEL_BINS: usize = 128;
    let frame_count = 1 + signal.len() / ANALYSIS_HOP_LENGTH;
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(STFT_SIZE);
    let filters = slaney_mel_filters(MEL_BINS);
    let window = (0..STFT_SIZE)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * index as f64 / STFT_SIZE as f64;
            0.5 - 0.5 * phase.cos()
        })
        .collect::<Vec<_>>();
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut mel_db = vec![vec![0.0_f32; frame_count]; MEL_BINS];
    let mut peak_db = f32::NEG_INFINITY;
    for frame in 0..frame_count {
        if frame % 8 == 0 {
            check_cancelled(should_cancel)?;
        }
        let center = frame * ANALYSIS_HOP_LENGTH;
        let start = center as isize - STFT_SIZE as isize / 2;
        for (index, value) in input.iter_mut().enumerate() {
            let source = start + index as isize;
            let sample = if source >= 0 && (source as usize) < signal.len() {
                signal[source as usize]
            } else {
                0.0
            };
            *value = f64::from(sample) * window[index];
        }
        fft.process(&mut input, &mut spectrum)
            .map_err(|error| error.to_string())?;
        for (mel, filter) in filters.iter().enumerate() {
            let power = spectrum
                .iter()
                .zip(filter)
                .map(|(value, weight)| {
                    Complex32::new(value.re as f32, value.im as f32).norm_sqr() * *weight
                })
                .sum::<f32>();
            let db = 10.0_f32 * power.max(1.0e-10).log10();
            mel_db[mel][frame] = db;
            peak_db = peak_db.max(db);
        }
    }
    let floor = peak_db - 80.0;
    for row in &mut mel_db {
        for value in row {
            *value = value.max(floor);
        }
    }
    let mut envelope = vec![0.0_f64; frame_count];
    for frame in 1..frame_count {
        if frame % 32 == 0 {
            check_cancelled(should_cancel)?;
        }
        if frame + 2 < frame_count {
            let values = mel_db
                .iter()
                .map(|row| (row[frame] - row[frame - 1]).max(0.0))
                .collect::<Vec<_>>();
            let aggregate = if median_aggregate {
                median_f32(values)
            } else {
                values.iter().sum::<f32>() / MEL_BINS as f32
            };
            envelope[frame + 2] = f64::from(aggregate);
        }
    }
    Ok(envelope)
}

fn slaney_mel_filters(count: usize) -> Vec<Vec<f32>> {
    let hz_to_mel = |frequency: f64| {
        if frequency < 1_000.0 {
            frequency / (200.0 / 3.0)
        } else {
            15.0 + (frequency / 1_000.0).ln() / (6.4_f64.ln() / 27.0)
        }
    };
    let mel_to_hz = |mel: f64| {
        if mel < 15.0 {
            mel * (200.0 / 3.0)
        } else {
            1_000.0 * ((mel - 15.0) * (6.4_f64.ln() / 27.0)).exp()
        }
    };
    let min_mel = hz_to_mel(0.0);
    let max_mel = hz_to_mel(ANALYSIS_SAMPLE_RATE as f64 / 2.0);
    let edges = (0..count + 2)
        .map(|index| mel_to_hz(min_mel + (max_mel - min_mel) * index as f64 / (count + 1) as f64))
        .collect::<Vec<_>>();
    (0..count)
        .map(|mel| {
            let normalization = 2.0 / (edges[mel + 2] - edges[mel]);
            (0..STFT_SIZE / 2 + 1)
                .map(|bin| {
                    let frequency = bin as f64 * ANALYSIS_SAMPLE_RATE as f64 / STFT_SIZE as f64;
                    let lower = (frequency - edges[mel]) / (edges[mel + 1] - edges[mel]);
                    let upper = (edges[mel + 2] - frequency) / (edges[mel + 2] - edges[mel + 1]);
                    (lower.min(upper).max(0.0) * normalization) as f32
                })
                .collect()
        })
        .collect()
}

fn median_f32(mut values: Vec<f32>) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f32::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn track_beats(onsets: &[f64], dynamic: bool) -> Vec<usize> {
    track_beats_with_cancel(onsets, dynamic, &|| false).expect("cancellation is disabled")
}

fn track_beats_with_cancel<F>(
    onsets: &[f64],
    dynamic: bool,
    should_cancel: &F,
) -> Result<Vec<usize>, String>
where
    F: Fn() -> bool,
{
    if dynamic && !has_onset_energy(onsets, 4) {
        return Ok(Vec::new());
    }
    let tempi = tempo_estimates_with_cancel(
        onsets,
        dynamic,
        if dynamic { 4.0 } else { 1.0 },
        should_cancel,
    )?;
    if tempi.is_empty() {
        return Ok(Vec::new());
    }
    let frame_rate = ANALYSIS_SAMPLE_RATE as f64 / ANALYSIS_HOP_LENGTH as f64;
    let frames_per_beat = tempi
        .iter()
        .map(|tempo| round_ties_even(frame_rate * 60.0 / tempo).max(1.0) as usize)
        .collect::<Vec<_>>();
    Ok(beat_track_dp(onsets, &frames_per_beat))
}

fn tempo_estimates(onsets: &[f64], dynamic: bool, std_bpm: f64) -> Vec<f64> {
    tempo_estimates_with_cancel(onsets, dynamic, std_bpm, &|| false)
        .expect("cancellation is disabled")
}

fn tempo_estimates_with_cancel<F>(
    onsets: &[f64],
    dynamic: bool,
    std_bpm: f64,
    should_cancel: &F,
) -> Result<Vec<f64>, String>
where
    F: Fn() -> bool,
{
    const WINDOW: usize = 344;
    let half = WINDOW / 2;
    let window = (0..WINDOW)
        .map(|index| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / WINDOW as f64).cos())
        .collect::<Vec<_>>();
    let mut aggregate = vec![0.0; WINDOW];
    let mut per_frame = if dynamic {
        vec![vec![0.0; WINDOW]; onsets.len()]
    } else {
        Vec::new()
    };
    for frame in 0..onsets.len() {
        check_cancelled(should_cancel)?;
        let values = (0..WINDOW)
            .map(|index| {
                let source = frame as isize + index as isize - half as isize;
                let value = if source < 0 {
                    onsets[0] * (source + half as isize) as f64 / half as f64
                } else if source as usize >= onsets.len() {
                    onsets[onsets.len() - 1]
                        * (1.0 - (source as usize - onsets.len() + 1) as f64 / half as f64)
                } else {
                    onsets[source as usize]
                };
                value * window[index]
            })
            .collect::<Vec<_>>();
        let mut autocorrelation = vec![0.0; WINDOW];
        for lag in 0..WINDOW {
            autocorrelation[lag] = values[..WINDOW - lag]
                .iter()
                .zip(&values[lag..])
                .map(|(left, right)| left * right)
                .sum();
        }
        let norm = autocorrelation
            .iter()
            .copied()
            .map(f64::abs)
            .fold(0.0, f64::max);
        if norm > 0.0 {
            for value in &mut autocorrelation {
                *value /= norm;
            }
        }
        for (target, value) in aggregate.iter_mut().zip(&autocorrelation) {
            *target += *value;
        }
        if dynamic {
            per_frame[frame] = autocorrelation;
        }
    }
    if onsets.is_empty() {
        return Ok(Vec::new());
    }
    for value in &mut aggregate {
        *value /= onsets.len() as f64;
    }
    Ok(if dynamic {
        per_frame
            .into_iter()
            .map(|values| select_tempo(&values, std_bpm))
            .collect()
    } else {
        vec![select_tempo(&aggregate, std_bpm)]
    })
}

fn select_tempo(tempogram: &[f64], std_bpm: f64) -> f64 {
    let frame_rate = ANALYSIS_SAMPLE_RATE as f64 / ANALYSIS_HOP_LENGTH as f64;
    (1..tempogram.len())
        .filter_map(|lag| {
            let bpm = frame_rate * 60.0 / lag as f64;
            if bpm >= 320.0 {
                return None;
            }
            let prior = -0.5 * ((bpm.log2() - 120.0_f64.log2()) / std_bpm).powi(2);
            Some((bpm, (1.0 + 1.0e6 * tempogram[lag].max(0.0)).ln() + prior))
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map_or(0.0, |value| value.0)
}

fn beat_track_dp(onsets: &[f64], frames_per_beat: &[usize]) -> Vec<usize> {
    let onsets = onsets.iter().map(|value| *value as f32).collect::<Vec<_>>();
    let mean = onsets.iter().sum::<f32>() / onsets.len() as f32;
    let std = if onsets.len() > 1 {
        (onsets
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f32>()
            / (onsets.len() - 1) as f32)
            .sqrt()
    } else {
        0.0
    };
    let normalized = onsets
        .iter()
        .map(|value| value / (std + f32::MIN_POSITIVE))
        .collect::<Vec<_>>();
    let mut local = vec![0.0_f32; onsets.len()];
    for index in 0..onsets.len() {
        let period = frames_per_beat[if frames_per_beat.len() == 1 { 0 } else { index }];
        let kernel = 2 * period + 1;
        let start = (index + period + 1).saturating_sub(onsets.len());
        let end = (index + period).min(kernel);
        for kernel_index in start..end {
            let source = index + period - kernel_index;
            let offset = kernel_index as isize - period as isize;
            let weight = (-0.5_f32 * (offset as f32 * 32.0 / period as f32).powi(2)).exp();
            local[index] += weight * normalized[source];
        }
    }
    let threshold = 0.01 * local.iter().copied().fold(0.0, f32::max);
    let mut backlinks = vec![None; local.len()];
    let mut scores = vec![0.0_f64; local.len()];
    let mut first = true;
    for index in 0..local.len() {
        let period = frames_per_beat[if frames_per_beat.len() == 1 { 0 } else { index }];
        let mut best = None;
        let mut predecessor = index as isize - round_ties_even(period as f64 / 2.0) as isize;
        let stop = index as isize - 2 * period as isize - 1;
        while predecessor > stop {
            if predecessor < 0 {
                break;
            }
            let candidate_index = predecessor as usize;
            let candidate = scores[candidate_index]
                - 100.0 * (((index - candidate_index) as f64).ln() - (period as f64).ln()).powi(2);
            if best.is_none_or(|(_, score)| candidate > score) {
                best = Some((candidate_index, candidate));
            }
            predecessor -= 1;
        }
        scores[index] = f64::from(local[index]) + best.map_or(0.0, |value| value.1);
        if !(first && local[index] < threshold) {
            backlinks[index] = best.map(|value| value.0);
            first = false;
        }
    }
    let local_maxima = (0..scores.len())
        .filter(|&index| {
            (index == 0 || scores[index] > scores[index - 1])
                && (index + 1 == scores.len() || scores[index] >= scores[index + 1])
        })
        .collect::<Vec<_>>();
    let median_score = median(local_maxima.iter().map(|index| scores[*index]).collect());
    let Some(mut cursor) = local_maxima
        .into_iter()
        .rev()
        .find(|index| scores[*index] >= 0.5 * median_score)
    else {
        return Vec::new();
    };
    let mut beats = Vec::new();
    loop {
        beats.push(cursor);
        let Some(previous) = backlinks[cursor] else {
            break;
        };
        cursor = previous;
    }
    beats.reverse();
    trim_zero_score_beat_edges(beats, &local)
}

fn trim_zero_score_beat_edges(beats: Vec<usize>, local_scores: &[f32]) -> Vec<usize> {
    let Some(first) = local_scores.iter().position(|score| *score > 0.0) else {
        return Vec::new();
    };
    let last = local_scores.iter().rposition(|score| *score > 0.0).unwrap();
    beats
        .into_iter()
        .filter(|index| *index >= first && *index <= last)
        .collect()
}

fn round_ties_even(value: f64) -> f64 {
    let floor = value.floor();
    let fraction = value - floor;
    if (fraction - 0.5).abs() <= f64::EPSILON {
        if floor as i64 % 2 == 0 {
            floor
        } else {
            floor + 1.0
        }
    } else {
        value.round()
    }
}

fn has_onset_energy(onsets: &[f64], minimum: usize) -> bool {
    let peak = onsets.iter().copied().fold(0.0, f64::max);
    peak > 0.0 && onsets.iter().filter(|value| **value > peak * 0.3).count() >= minimum
}

fn beat_track_quality(frames: &[usize]) -> f64 {
    if frames.len() < 4 {
        return 0.0;
    }
    let intervals = frames
        .windows(2)
        .map(|pair| {
            (pair[1] - pair[0]) as f64 * ANALYSIS_HOP_LENGTH as f64 / ANALYSIS_SAMPLE_RATE as f64
        })
        .collect::<Vec<_>>();
    let plausible = intervals
        .iter()
        .filter(|value| **value >= 0.25 && **value <= 2.0)
        .count() as f64
        / intervals.len() as f64;
    if plausible < 0.75 {
        return 0.0;
    }
    let median_interval = median(intervals.clone());
    let deviation = if median_interval > 0.0 {
        median(
            intervals
                .iter()
                .map(|value| (value - median_interval).abs())
                .collect(),
        ) / median_interval
    } else {
        1.0
    };
    (frames.len() as f64 / 8.0).min(2.0) * plausible * (1.0 - deviation.min(1.0) * 0.35).max(0.0)
}

fn beat_track_is_weak(frames: &[usize]) -> bool {
    frames.len() < 8 || beat_track_quality(frames) <= 0.0
}

fn select_beat_track(static_track: &[usize], dynamic_track: &[usize]) -> Vec<usize> {
    let dynamic_quality = beat_track_quality(dynamic_track);
    if dynamic_quality <= 0.0 {
        return static_track.to_vec();
    }
    let static_quality = beat_track_quality(static_track);
    if static_quality <= 0.0 {
        return dynamic_track.to_vec();
    }
    if static_track.len() >= 8 && dynamic_track.len() < 4.max(static_track.len() * 3 / 4) {
        return static_track.to_vec();
    }
    if interval_cv(dynamic_track) > interval_cv(static_track) + 0.25
        && dynamic_track.len() <= static_track.len()
    {
        return static_track.to_vec();
    }
    if dynamic_quality + 0.05 < static_quality {
        static_track.to_vec()
    } else {
        dynamic_track.to_vec()
    }
}

fn interval_cv(frames: &[usize]) -> f64 {
    if frames.len() < 2 {
        return 1.0;
    }
    let intervals = frames
        .windows(2)
        .map(|pair| (pair[1] - pair[0]) as f64)
        .collect::<Vec<_>>();
    let center = median(intervals.clone());
    if center <= 0.0 {
        1.0
    } else {
        median(
            intervals
                .iter()
                .map(|value| (value - center).abs())
                .collect(),
        ) / center
    }
}

fn fill_skipped_onset_beats(mut frames: Vec<usize>, onsets: &[f64]) -> Vec<usize> {
    if frames.len() < 2 || onsets.is_empty() {
        return frames;
    }
    let peak = onsets.iter().copied().fold(0.0, f64::max);
    let mut active = onsets
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    if peak <= 0.0 || active.is_empty() {
        return frames;
    }
    active.sort_by(f64::total_cmp);
    let rank = (active.len() - 1) as f64 * 0.75;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    let percentile = active[lower] + (rank - lower as f64) * (active[upper] - active[lower]);
    let threshold = (peak * 0.1).max(percentile * 1.5);
    let mut added = Vec::new();
    for pair in frames.windows(2) {
        let interval = pair[1] - pair[0];
        if interval as f64 * ANALYSIS_HOP_LENGTH as f64 / (ANALYSIS_SAMPLE_RATE as f64) < 0.7 {
            continue;
        }
        let midpoint = pair[0] + interval / 2;
        let radius = round_ties_even(interval as f64 * 0.15).max(1.0) as usize;
        let start = midpoint.saturating_sub(radius);
        let end = (midpoint + radius + 1).min(onsets.len());
        let local = &onsets[start..end];
        let Some(offset) = first_max_index_f64(local) else {
            continue;
        };
        let strength = local[offset];
        if strength >= threshold {
            added.push(start + offset);
        }
    }
    frames.extend(added);
    frames.sort_unstable();
    frames.dedup();
    frames
}

fn first_max_index_f64(values: &[f64]) -> Option<usize> {
    let mut best = values.first().map(|value| (0, *value))?;
    for (index, value) in values.iter().copied().enumerate().skip(1) {
        if value.total_cmp(&best.1).is_gt() {
            best = (index, value);
        }
    }
    Some(best.0)
}

fn rms_frames(signal: &[f32], frame_count: usize) -> Vec<f64> {
    let frame_length = safe_fft_size(signal.len(), STFT_SIZE);
    (0..frame_count)
        .map(|frame| {
            let center = frame * ANALYSIS_HOP_LENGTH;
            let start = center as isize - frame_length as isize / 2;
            let sum = (0..frame_length)
                .map(|index| {
                    let position = start + index as isize;
                    if position >= 0 && (position as usize) < signal.len() {
                        signal[position as usize].powi(2)
                    } else {
                        0.0
                    }
                })
                .sum::<f32>();
            f64::from((sum / frame_length as f32).sqrt())
        })
        .collect()
}

fn safe_fft_size(signal_size: usize, preferred: usize) -> usize {
    if signal_size == 0 || signal_size >= preferred {
        return preferred;
    }
    signal_size.max(32).next_power_of_two()
        / if signal_size.max(32).is_power_of_two() {
            1
        } else {
            2
        }
}

fn cens_frames(chroma: &[[f64; 12]]) -> Vec<[f64; 12]> {
    let quantized = chroma
        .iter()
        .map(|frame| {
            std::array::from_fn(|pitch| {
                let sum = frame.iter().sum::<f64>();
                let value = if sum > 0.0 { frame[pitch] / sum } else { 0.0 };
                [0.4, 0.2, 0.1, 0.05]
                    .into_iter()
                    .filter(|threshold| value > *threshold)
                    .count() as f64
                    * 0.25
            })
        })
        .collect::<Vec<[f64; 12]>>();
    (0..quantized.len())
        .map(|index| {
            let mut frame = [0.0; 12];
            for offset in -21_i32..=21 {
                let candidate = index as i32 + offset;
                if candidate < 0 || candidate as usize >= quantized.len() {
                    continue;
                }
                let hann =
                    0.5 - 0.5 * (2.0 * std::f64::consts::PI * (offset + 21) as f64 / 42.0).cos();
                for pitch in 0..12 {
                    frame[pitch] += quantized[candidate as usize][pitch] * hann / 21.0;
                }
            }
            normalize_l2(&mut frame);
            frame
        })
        .collect()
}

fn normalize_l2(values: &mut [f64; 12]) {
    let norm = values.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm > 0.0 {
        for value in values {
            *value /= norm;
        }
    }
}

fn estimate_tuning_offset_cents(samples: &[f32], sample_rate: u32) -> Result<Option<f64>, String> {
    if samples.len() < ANALYSIS_HOP_LENGTH * 4
        || samples.iter().copied().map(f32::abs).fold(0.0, f32::max) < 1.0e-5
    {
        return Ok(None);
    }
    let spectrum = stft(samples)?;
    let mut candidates = Vec::new();
    for frame in spectrum {
        let magnitudes = frame.iter().map(|value| value.norm()).collect::<Vec<_>>();
        let frame_max = magnitudes.iter().copied().fold(0.0_f64, f64::max);
        for bin in 1..magnitudes.len() - 1 {
            let frequency = bin as f64 * sample_rate as f64 / STFT_SIZE as f64;
            if !(150.0..=4_000.0).contains(&frequency)
                || magnitudes[bin] < frame_max * 0.1
                || magnitudes[bin] <= magnitudes[bin - 1]
                || magnitudes[bin] < magnitudes[bin + 1]
            {
                continue;
            }
            let denominator = magnitudes[bin - 1] - 2.0 * magnitudes[bin] + magnitudes[bin + 1];
            let shift = if denominator.abs() > f64::EPSILON {
                0.5 * (magnitudes[bin - 1] - magnitudes[bin + 1]) / denominator
            } else {
                0.0
            };
            let interpolated_frequency =
                (bin as f64 + shift) * sample_rate as f64 / STFT_SIZE as f64;
            let magnitude =
                magnitudes[bin] + 0.25 * shift * (magnitudes[bin + 1] - magnitudes[bin - 1]);
            candidates.push((interpolated_frequency, magnitude));
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let median_magnitude = median(candidates.iter().map(|(_, magnitude)| *magnitude).collect());
    let mut histogram = [0_usize; 100];
    for (frequency, magnitude) in candidates {
        if magnitude < median_magnitude || frequency <= 0.0 {
            continue;
        }
        let mut residual = (12.0 * (frequency / 440.0).log2()).rem_euclid(1.0);
        if residual >= 0.5 {
            residual -= 1.0;
        }
        let bin = ((residual + 0.5) * 100.0).floor().clamp(0.0, 99.0) as usize;
        histogram[bin] += 1;
    }
    let best = histogram
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.cmp(right.1).then_with(|| right.0.cmp(&left.0)))
        .map(|(index, _)| index);
    Ok(best
        .filter(|index| histogram[*index] > 0)
        .map(|index| (-0.5 + index as f64 / 100.0).clamp(-0.5, 0.5) * 100.0))
}

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::cell::Cell;

    fn chord_audio(sample_rate: u32, root_midi: i32, minor: bool, cents: f64) -> DecodedAudio {
        let frames = sample_rate as usize * 3;
        let intervals = if minor { [0, 3, 7] } else { [0, 4, 7] };
        let samples = (0..frames)
            .map(|index| {
                intervals
                    .iter()
                    .enumerate()
                    .map(|(rank, interval)| {
                        let frequency = 440.0
                            * 2.0_f64
                                .powf((root_midi + interval - 69) as f64 / 12.0 + cents / 1_200.0);
                        ((2.0 * std::f64::consts::PI * frequency * index as f64
                            / sample_rate as f64)
                            .sin()
                            / (rank + 1) as f64) as f32
                    })
                    .sum::<f32>()
                    * 0.25
            })
            .collect();
        DecodedAudio {
            samples,
            sample_rate,
            channels: 1,
        }
    }

    #[test]
    fn tuning_tracks_detuned_synthetic_audio_with_half_cent_bound() {
        for (source_cents, desktop_cents) in [(-31.4, -33.0), (17.7, 21.0), (42.2, 43.0)] {
            let features =
                extract_harmonic_features_from_audio(&chord_audio(48_000, 57, false, source_cents))
                    .unwrap();
            assert!(
                (features.tuning_offset_cents.unwrap() - desktop_cents).abs() <= 0.5,
                "{} != {desktop_cents}",
                features.tuning_offset_cents.unwrap()
            );
            let expected_hz = 440.0 * 2.0_f64.powf(desktop_cents / 1_200.0);
            let allowed_hz = expected_hz * (2.0_f64.powf(0.5 / 1_200.0) - 1.0);
            assert!((features.estimated_reference_hz.unwrap() - expected_hz).abs() <= allowed_hz);
        }
    }

    #[test]
    fn tuning_peak_interpolation_matches_desktop_quarter_bin_correction() {
        let frequencies = [
            483.372_471_367_120_6,
            617.180_512_572_343_6,
            344.126_879_556_195_5,
        ];
        let amplitudes = [
            0.806_937_659_585_890_5,
            0.719_827_558_256_331_4,
            0.805_308_422_789_256_1,
        ];
        let samples = (0..ANALYSIS_SAMPLE_RATE as usize)
            .map(|index| {
                frequencies
                    .iter()
                    .zip(amplitudes)
                    .map(|(frequency, amplitude)| {
                        amplitude
                            * (2.0 * std::f64::consts::PI * frequency * index as f64
                                / ANALYSIS_SAMPLE_RATE as f64)
                                .sin()
                    })
                    .sum::<f64>() as f32
            })
            .collect::<Vec<_>>();
        let (harmonic, _) = split_harmonic_percussive(&samples).unwrap();
        let actual = estimate_tuning_offset_cents(&harmonic, ANALYSIS_SAMPLE_RATE)
            .unwrap()
            .unwrap();
        assert!((actual - -25.0).abs() <= 0.5, "{actual} != -25 cents");
    }

    #[test]
    fn internal_beat_frames_match_desktop_synthetic_click_oracle() {
        let mut signal = vec![0.0_f32; ANALYSIS_SAMPLE_RATE as usize * 8];
        let width = 96;
        let window = (0..width)
            .map(|index| {
                0.5_f32
                    - 0.5_f32
                        * (2.0 * std::f32::consts::PI * index as f32 / (width - 1) as f32).cos()
            })
            .collect::<Vec<_>>();
        for start in (ANALYSIS_SAMPLE_RATE as usize / 2..signal.len())
            .step_by(ANALYSIS_SAMPLE_RATE as usize / 2)
        {
            for (sample, value) in signal[start..].iter_mut().zip(&window) {
                *sample += *value;
            }
        }
        let frames = estimate_internal_beat_frames(&signal, &signal).unwrap();
        assert_eq!(
            frames,
            vec![23, 45, 66, 88, 109, 131, 152, 174, 195, 217, 238, 260, 282, 303, 325]
        );
    }

    #[test]
    fn skipped_onset_fill_uses_desktop_linear_percentile() {
        let mut onsets = vec![0.0; 121];
        onsets[0] = 5.0;
        for value in &mut onsets[1..=4] {
            *value = 1.0;
        }
        onsets[20] = 3.0;
        assert_eq!(
            fill_skipped_onset_beats(vec![0, 40, 80, 120], &onsets),
            vec![0, 40, 80, 120]
        );
    }

    #[test]
    fn onset_search_uses_desktop_first_argmax_and_ties_even_radius() {
        assert_eq!(first_max_index_f64(&[0.1, 0.8, 0.8, 0.2]), Some(1));
        assert_eq!(round_ties_even(4.5), 4.0);
        assert_eq!(round_ties_even(5.5), 6.0);
    }

    #[test]
    fn tempogram_uses_desktop_linear_ramp_edges() {
        let mut onsets = vec![0.0; 345];
        for index in (5..345).step_by(20) {
            onsets[index] = 1.0;
        }
        onsets[344] = 5.0;
        let static_track = track_beats(&onsets, false);
        let dynamic_track = fill_skipped_onset_beats(track_beats(&onsets, true), &onsets);
        assert_eq!(
            select_beat_track(&static_track, &dynamic_track),
            vec![
                5, 25, 45, 65, 85, 105, 125, 145, 165, 185, 205, 225, 245, 265, 285, 305, 325, 344
            ]
        );
    }

    #[test]
    fn desktop_cqt_six_decimal_diagnostic_matches_synthetic_a_major() {
        let features =
            extract_harmonic_features_from_audio(&chord_audio(48_000, 57, false, -31.4)).unwrap();
        let expected = [
            0.061368, 0.391343, 0.011278, 0.038295, 0.240324, 0.008669, 0.004835, 0.006736,
            0.134391, 0.871832, 0.020052, 0.004690,
        ];
        let mut actual_f32 = [0.0_f32; 12];
        for frame in &features.chroma_cqt {
            for pitch in 0..12 {
                actual_f32[pitch] += frame[pitch] as f32;
            }
        }
        let actual = actual_f32.map(|value| f64::from(value / features.chroma_cqt.len() as f32));
        for pitch in 0..12 {
            assert!(
                (actual[pitch] - expected[pitch]).abs() <= 0.5e-6,
                "pitch {pitch}: {} != {}; actual={actual:?}",
                actual[pitch],
                expected[pitch]
            );
        }
    }

    #[test]
    fn cqt_projection_matches_desktop_without_hpss_or_resampling() {
        let audio = chord_audio(ANALYSIS_SAMPLE_RATE, 57, false, -31.4);
        let chroma = recursive_cqt_chroma(&audio.samples, -33.0).unwrap();
        let expected = [
            0.063228, 0.392252, 0.014330, 0.040761, 0.242173, 0.011741, 0.008303, 0.009532,
            0.134442, 0.869062, 0.021823, 0.007133,
        ];
        let mut actual = [0.0; 12];
        for frame in &chroma {
            for pitch in 0..12 {
                actual[pitch] += frame[pitch] / chroma.len() as f64;
            }
        }
        for pitch in 0..12 {
            assert!(
                (actual[pitch] - expected[pitch]).abs() <= 0.002,
                "pitch {pitch}: {} != {}; actual={actual:?}",
                actual[pitch],
                expected[pitch]
            );
        }
    }

    #[test]
    fn emits_sparse_cqt_basis_stage_when_requested() {
        if std::env::var_os("TUNEFORGE_CQT_STAGE_OUTPUT").is_none() {
            return;
        }
        let bins_per_octave = 36;
        let ratio = 2.0_f64.powf(1.0 / bins_per_octave as f64);
        let q = 1.0 / ((ratio * ratio - 1.0) / (ratio * ratio + 1.0));
        let frequencies = (180..216)
            .map(|bin| CQT_FMIN * 2.0_f64.powf(bin as f64 / bins_per_octave as f64))
            .collect::<Vec<_>>();
        let (n_fft, basis) = cqt_fft_basis(11_025.0, &frequencies, q);
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        std::fs::create_dir_all(&output_root).unwrap();
        let bytes = basis
            .iter()
            .flatten()
            .flat_map(|value| [value.re, value.im])
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        std::fs::write(output_root.join("native-sparse-basis-complex64.f32"), bytes).unwrap();
        let signal = (0..11_025)
            .map(|index| {
                (0.3 * (2.0 * std::f64::consts::PI * 220.0 * index as f64 / 11_025.0).sin()
                    + 0.2 * (2.0 * std::f64::consts::PI * 659.255 * index as f64 / 11_025.0).sin())
                    as f32
            })
            .collect::<Vec<_>>();
        let hop_length = 512;
        let frame_count = 1 + signal.len() / hop_length;
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(n_fft);
        let mut input = fft.make_input_vec();
        let mut spectrum = fft.make_output_vec();
        let mut spectra = Vec::with_capacity(frame_count * (n_fft / 2 + 1));
        let mut projected = Vec::with_capacity(frame_count * basis.len());
        for frame in 0..frame_count {
            let center = frame * hop_length;
            let start = center as isize - n_fft as isize / 2;
            for (index, value) in input.iter_mut().enumerate() {
                let source = start + index as isize;
                *value = if source >= 0 && (source as usize) < signal.len() {
                    f64::from(signal[source as usize])
                } else {
                    0.0
                };
            }
            fft.process(&mut input, &mut spectrum).unwrap();
            let spectrum32 = spectrum
                .iter()
                .map(|value| Complex32::new(value.re as f32, value.im as f32))
                .collect::<Vec<_>>();
            spectra.extend_from_slice(&spectrum32);
            projected.extend(basis.iter().map(|row| {
                row.iter()
                    .zip(&spectrum32)
                    .map(|(filter, value)| filter * value)
                    .sum::<Complex32>()
            }));
        }
        let complex_bytes = |values: &[Complex32]| {
            values
                .iter()
                .flat_map(|value| [value.re, value.im])
                .flat_map(f32::to_le_bytes)
                .collect::<Vec<_>>()
        };
        std::fs::write(
            output_root.join("native-frame-spectra-complex64.f32"),
            complex_bytes(&spectra),
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-projected-complex64.f32"),
            complex_bytes(&projected),
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-sparse-basis.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "sample_rate": 11_025,
                "fmin": CQT_FMIN,
                "bins_per_octave": bins_per_octave,
                "first_global_bin": 180,
                "rows": basis.len(),
                "columns": n_fft / 2 + 1,
                "frames": frame_count,
                "hop_length": hop_length,
                "n_fft": n_fft,
                "q": q,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn emits_common_input_frame_fft_control_when_requested() {
        if std::env::var_os("TUNEFORGE_CQT_FFT_CONTROL").is_none() {
            return;
        }
        let n_fft = 1_024;
        let input = (0..n_fft)
            .map(|index| {
                let phase = index as f64;
                (0.31 * (2.0 * std::f64::consts::PI * 37.0 * phase / n_fft as f64).sin()
                    + 0.17 * (2.0 * std::f64::consts::PI * 113.0 * phase / n_fft as f64).cos()
                    + ((index * 73 % 101) as f64 - 50.0) * 1.0e-4) as f32
            })
            .collect::<Vec<_>>();
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(n_fft);
        let mut fft_input = input
            .iter()
            .map(|value| f64::from(*value))
            .collect::<Vec<_>>();
        let mut spectrum = fft.make_output_vec();
        fft.process(&mut fft_input, &mut spectrum).unwrap();
        let spectrum = spectrum
            .iter()
            .map(|value| Complex32::new(value.re as f32, value.im as f32))
            .collect::<Vec<_>>();
        let input_bytes = input
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        let spectrum_bytes = spectrum
            .iter()
            .flat_map(|value| [value.re, value.im])
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        std::fs::create_dir_all(&output_root).unwrap();
        std::fs::write(output_root.join("native-frame-fft-input.f32"), &input_bytes).unwrap();
        std::fs::write(
            output_root.join("native-frame-fft-spectrum.f32"),
            &spectrum_bytes,
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-frame-fft-control.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "n_fft": n_fft,
                "input_dtype": "little-endian float32",
                "input_sha256": Sha256::digest(&input_bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
                "fft_input_conversion": "float32 to float64",
                "fft_output_conversion": "complex128 to complex64",
                "spectrum_shape": [n_fft / 2 + 1, 2],
                "spectrum_sha256": Sha256::digest(&spectrum_bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn cqt_preprocessing_stops_when_cancellation_is_requested() {
        let checks = Cell::new(0);
        let cancelled = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        let result = constant_q_magnitude_with_cancel(
            &vec![0.1; 44_100],
            44_100,
            2_048,
            CQT_FMIN,
            216,
            36,
            &cancelled,
        );
        assert_eq!(result.unwrap_err(), "AUDIO_ANALYSIS_CANCELLED");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn hpss_stops_when_cancellation_is_requested() {
        let checks = Cell::new(0);
        let cancelled = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        let result = split_harmonic_percussive_with_cancel(&vec![0.1; 44_100], &cancelled);
        assert_eq!(result.unwrap_err(), "AUDIO_ANALYSIS_CANCELLED");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn beat_feature_extraction_stops_when_cancellation_is_requested() {
        let checks = Cell::new(0);
        let cancelled = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        let signal = vec![0.1; ANALYSIS_SAMPLE_RATE as usize * 2];
        let result = estimate_internal_beat_frames_with_cancel(&signal, &signal, &cancelled);
        assert_eq!(result.unwrap_err(), "AUDIO_ANALYSIS_CANCELLED");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn tempogram_stops_when_cancellation_is_requested() {
        let checks = Cell::new(0);
        let cancelled = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        let result = tempo_estimates_with_cancel(&vec![0.1; 345], true, 4.0, &cancelled);
        assert_eq!(result.unwrap_err(), "AUDIO_ANALYSIS_CANCELLED");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn beat_trimming_preserves_interior_zero_score_frames() {
        let mut local_scores = vec![0.0; 9];
        local_scores[2] = 1.0;
        local_scores[6] = 1.0;
        assert_eq!(
            trim_zero_score_beat_edges(vec![0, 2, 4, 6, 8], &local_scores),
            vec![2, 4, 6]
        );

        assert_eq!(
            trim_zero_score_beat_edges(vec![2, 4], &[0.0, 1.0, 0.0, 0.0, 1.0, 0.0]),
            vec![2, 4]
        );
    }

    #[test]
    fn hpss_matches_desktop_for_native_rate_synthetic_audio() {
        let audio = chord_audio(ANALYSIS_SAMPLE_RATE, 57, false, -31.4);
        let (harmonic, _) = split_harmonic_percussive(&audio.samples).unwrap();
        let rms = (harmonic
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum::<f64>()
            / harmonic.len() as f64)
            .sqrt();
        assert!((rms - 0.2058011).abs() <= 0.002, "harmonic rms {rms}");
        let indices = [0, 1, 511, 512, 1_024, 11_025, 33_075, 65_000, 66_149];
        let expected = [
            -0.001728, 0.015212, 0.128927, 0.133590, -0.028455, 0.042462, 0.195236, -0.030986,
            0.100153,
        ];
        for (index, expected) in indices.into_iter().zip(expected) {
            assert!(
                (f64::from(harmonic[index]) - expected).abs() <= 0.001,
                "harmonic[{index}]={} != {expected}",
                harmonic[index]
            );
        }
    }

    #[test]
    fn silence_has_no_tuning_and_no_active_chroma() {
        let features = extract_harmonic_features_from_audio(&DecodedAudio {
            samples: vec![0.0; 44_100],
            sample_rate: 44_100,
            channels: 2,
        })
        .unwrap();
        assert_eq!(features.tuning_offset_cents, None);
        assert!(features.active_frame_mask.iter().all(|active| !active));
        assert_eq!(active_chroma_mean(&features), [0.0; 12]);
    }
}
