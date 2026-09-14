use realfft::RealFftPlanner;
use rubato::{FftFixedInOut, Resampler};
use serde_json::{json, Value};

use super::decode::DecodedAudio;

pub const SAMPLE_RATE: u32 = 22_050;
pub const FFT_SIZE: usize = 1_024;
pub const HOP_LENGTH: usize = 441;
pub const MEL_BINS: usize = 128;
pub const MIN_FRAMES: usize = 13;
pub const CHUNK_FRAMES: usize = 1_500;
pub const BORDER_FRAMES: usize = 6;

#[derive(Debug, Clone)]
pub struct BeatThisResult {
    pub tempo_bpm: f64,
    pub timing: Value,
}

pub fn log_mel_spectrogram(audio: &DecodedAudio) -> Result<Vec<[f32; MEL_BINS]>, String> {
    if audio.sample_rate == 0 || audio.samples.is_empty() {
        return Err("Advanced Beat Analysis received empty audio.".to_string());
    }
    let mut samples = resample_bandlimited(&audio.samples, audio.sample_rate, SAMPLE_RATE)?;
    samples.resize(samples.len().max((MIN_FRAMES - 1) * HOP_LENGTH), 0.0);
    let frame_count = 1 + samples.len() / HOP_LENGTH;
    let filters = slaney_filters();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut features = Vec::with_capacity(frame_count);
    let normalization = (FFT_SIZE as f32).sqrt();

    for frame in 0..frame_count {
        let center = frame * HOP_LENGTH;
        for (index, value) in input.iter_mut().enumerate() {
            let source = center as isize + index as isize - (FFT_SIZE / 2) as isize;
            let sample = reflected_sample(&samples, source);
            let phase = 2.0 * std::f32::consts::PI * index as f32 / FFT_SIZE as f32;
            *value = sample * (0.5 - 0.5 * phase.cos());
        }
        fft.process(&mut input, &mut spectrum)
            .map_err(|error| format!("Advanced Beat Analysis FFT failed: {error}"))?;
        let magnitude = spectrum
            .iter()
            .map(|value| value.norm() / normalization)
            .collect::<Vec<_>>();
        let mut frame_features = [0.0; MEL_BINS];
        for (mel_index, filter) in filters.iter().enumerate() {
            let energy = filter
                .iter()
                .enumerate()
                .map(|(bin, weight)| magnitude[bin] * weight)
                .sum::<f32>();
            frame_features[mel_index] = (1_000.0 * energy).ln_1p();
        }
        features.push(frame_features);
    }
    Ok(features)
}

pub fn predict_chunks<F>(features: &[[f32; MEL_BINS]], mut run: F) -> Result<(Vec<f32>, Vec<f32>), String>
where
    F: FnMut(&[f32], usize) -> Result<(Vec<f32>, Vec<f32>), String>,
{
    if features.len() < MIN_FRAMES {
        return Err("Advanced Beat Analysis input has fewer than 13 frames.".to_string());
    }
    let starts = chunk_starts(features.len());
    let mut beat = vec![-1_000.0; features.len()];
    let mut downbeat = vec![-1_000.0; features.len()];
    for start in starts.into_iter().rev() {
        let frame_count = features.len().saturating_add(2 * BORDER_FRAMES).min(CHUNK_FRAMES);
        let mut input = vec![0.0; frame_count * MEL_BINS];
        for local in 0..frame_count {
            let source = start + local as isize;
            if source >= 0 && (source as usize) < features.len() {
                input[local * MEL_BINS..(local + 1) * MEL_BINS]
                    .copy_from_slice(&features[source as usize]);
            }
        }
        let (chunk_beat, chunk_downbeat) = run(&input, frame_count)?;
        if chunk_beat.len() != frame_count || chunk_downbeat.len() != frame_count {
            return Err("Advanced Beat Analysis returned an invalid output shape.".to_string());
        }
        let first = BORDER_FRAMES.min(frame_count);
        let last = frame_count.saturating_sub(BORDER_FRAMES);
        for local in first..last {
            let destination = start + local as isize;
            if destination >= 0 && (destination as usize) < features.len() {
                beat[destination as usize] = chunk_beat[local];
                downbeat[destination as usize] = chunk_downbeat[local];
            }
        }
    }
    Ok((beat, downbeat))
}

pub fn postprocess_timing(
    beat_logits: &[f32],
    downbeat_logits: &[f32],
    duration_seconds: f64,
) -> Result<BeatThisResult, String> {
    if beat_logits.len() != downbeat_logits.len() || beat_logits.is_empty() {
        return Err("ADVANCED_BEAT_BACKEND_FAILED: invalid model output.".to_string());
    }
    let beat_frames = peak_frames(beat_logits);
    if beat_frames.len() < 2 {
        return Err("ADVANCED_BEAT_BACKEND_FAILED: no usable beat timing was detected.".to_string());
    }
    let mut downbeat_frames = peak_frames(downbeat_logits);
    for value in &mut downbeat_frames {
        if let Some(nearest) = beat_frames.iter().min_by(|a, b| {
            (*a - *value).abs().total_cmp(&(*b - *value).abs())
        }) {
            *value = *nearest;
        }
    }
    downbeat_frames.dedup_by(|a, b| (*a - *b).abs() < f64::EPSILON);
    let beats_per_bar = infer_beats_per_bar(&beat_frames, &downbeat_frames);
    let downbeat_indices = nearest_beat_indices(&beat_frames, &downbeat_frames);
    let downbeat_offset = downbeat_indices.first().copied().unwrap_or(0) % beats_per_bar;
    let beat_seconds = beat_frames.iter().map(|frame| frame / 50.0).collect::<Vec<_>>();
    let intervals = beat_seconds.windows(2).map(|pair| pair[1] - pair[0]).collect::<Vec<_>>();
    let median_interval = median(&intervals);
    if !median_interval.is_finite() || median_interval <= 0.0 {
        return Err("ADVANCED_BEAT_BACKEND_FAILED: no usable tempo was detected.".to_string());
    }
    let tempo_bpm = (60_000.0 / median_interval).round() / 1_000.0;
    let beats = beat_seconds
        .iter()
        .enumerate()
        .map(|(index, seconds)| {
            let relative = index as isize - downbeat_offset as isize;
            let bar_index = relative.div_euclid(beats_per_bar as isize).max(0) as usize;
            json!({
                "index": index,
                "seconds": round_seconds(*seconds),
                "bar_index": bar_index,
                "beat_in_bar": relative.rem_euclid(beats_per_bar as isize) as usize + 1,
            })
        })
        .collect::<Vec<_>>();
    let mut bars = Vec::new();
    let downbeats = beats
        .iter()
        .filter(|beat| beat["beat_in_bar"].as_u64() == Some(1))
        .collect::<Vec<_>>();
    for (index, beat) in downbeats.iter().enumerate() {
        let start = beat["seconds"].as_f64().unwrap_or(0.0);
        let end = downbeats
            .get(index + 1)
            .and_then(|next| next["seconds"].as_f64())
            .unwrap_or(duration_seconds.max(start));
        if end > start {
            bars.push(json!({
                "index": beat["bar_index"],
                "start_seconds": round_seconds(start),
                "end_seconds": round_seconds(end),
            }));
        }
    }
    if bars.is_empty() {
        return Err("ADVANCED_BEAT_BACKEND_FAILED: no usable beat bars were detected.".to_string());
    }
    Ok(BeatThisResult {
        tempo_bpm,
        timing: json!({
            "beats_per_bar": beats_per_bar,
            "source": "beat-this",
            "meter": match beats_per_bar { 3 => "3/4", 6 => "6/8", _ => "4/4" },
            "meter_confidence": if downbeat_frames.len() >= 2 { 1.0 } else { 0.0 },
            "downbeat_source": "beat-this",
            "downbeat_confidence": if downbeat_frames.is_empty() { 0.0 } else { 1.0 },
            "beats": beats,
            "bars": bars,
        }),
    })
}

fn resample_bandlimited(samples: &[f32], input_rate: u32, output_rate: u32) -> Result<Vec<f32>, String> {
    if input_rate == output_rate {
        return Ok(samples.to_vec());
    }
    let mut resampler = FftFixedInOut::<f32>::new(input_rate as usize, output_rate as usize, 2_048, 1)
        .map_err(|error| format!("Advanced Beat Analysis resampler setup failed: {error}"))?;
    let input_frames = resampler.input_frames_next();
    let output_frames = resampler.output_frames_max();
    let delay = resampler.output_delay();
    let mut output = vec![Vec::new()];
    let mut offset = 0;
    while samples.len().saturating_sub(offset) >= input_frames {
        let chunk = [&samples[offset..offset + input_frames]];
        let frames = resampler
            .process(&chunk, None)
            .map_err(|error| format!("Advanced Beat Analysis resampling failed: {error}"))?;
        output[0].extend_from_slice(&frames[0]);
        offset += input_frames;
    }
    if offset < samples.len() {
        let chunk = [&samples[offset..]];
        let frames = resampler
            .process_partial(Some(&chunk), None)
            .map_err(|error| format!("Advanced Beat Analysis resampling failed: {error}"))?;
        output[0].extend_from_slice(&frames[0]);
    }
    let flushed = resampler
        .process_partial::<&[f32]>(None, None)
        .map_err(|error| format!("Advanced Beat Analysis resampling flush failed: {error}"))?;
    output[0].extend_from_slice(&flushed[0]);
    let expected = samples.len() * output_rate as usize / input_rate as usize;
    let start = delay.min(output[0].len());
    let end = (start + expected).min(output[0].len());
    let mut trimmed = output[0][start..end].to_vec();
    trimmed.resize(expected, 0.0);
    debug_assert!(output_frames > 0);
    Ok(trimmed)
}

fn reflected_sample(samples: &[f32], index: isize) -> f32 {
    if samples.len() < 2 {
        return samples.first().copied().unwrap_or(0.0);
    }
    let limit = samples.len() as isize;
    let mut index = index;
    while index < 0 || index >= limit {
        index = if index < 0 { -index } else { 2 * limit - index - 2 };
    }
    samples[index as usize]
}

fn hz_to_slaney_mel(frequency: f64) -> f64 {
    if frequency < 1_000.0 {
        frequency / (200.0 / 3.0)
    } else {
        15.0 + (frequency / 1_000.0).ln() / (6.4_f64.ln() / 27.0)
    }
}

fn slaney_mel_to_hz(mel: f32) -> f32 {
    if mel < 15.0 {
        mel * (200.0 / 3.0)
    } else {
        1_000.0 * ((mel - 15.0) * (6.4_f32.ln() / 27.0)).exp()
    }
}

fn slaney_filters() -> Vec<Vec<f32>> {
    let min_mel = hz_to_slaney_mel(30.0);
    let max_mel = hz_to_slaney_mel(11_000.0);
    let edges = (0..MEL_BINS + 2)
        .map(|index| {
            let mel = (min_mel + (max_mel - min_mel) * index as f64 /
                (MEL_BINS + 1) as f64) as f32;
            slaney_mel_to_hz(mel)
        })
        .collect::<Vec<_>>();
    (0..MEL_BINS)
        .map(|mel| {
            let mut filter = vec![0.0; FFT_SIZE / 2 + 1];
            for (bin, weight) in filter.iter_mut().enumerate() {
                let frequency = bin as f32 * SAMPLE_RATE as f32 / FFT_SIZE as f32;
                let lower = (frequency - edges[mel]) / (edges[mel + 1] - edges[mel]);
                let upper = (edges[mel + 2] - frequency) / (edges[mel + 2] - edges[mel + 1]);
                *weight = lower.min(upper).max(0.0);
            }
            filter
        })
        .collect()
}

fn chunk_starts(frame_count: usize) -> Vec<isize> {
    let mut starts = Vec::new();
    let mut start = -(BORDER_FRAMES as isize);
    while start < frame_count as isize - BORDER_FRAMES as isize {
        starts.push(start);
        start += (CHUNK_FRAMES - 2 * BORDER_FRAMES) as isize;
    }
    if frame_count > CHUNK_FRAMES - 2 * BORDER_FRAMES {
        if let Some(last) = starts.last_mut() {
            *last = frame_count as isize - (CHUNK_FRAMES - BORDER_FRAMES) as isize;
        }
    }
    starts
}

fn peak_frames(logits: &[f32]) -> Vec<f64> {
    let peaks = logits
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let start = index.saturating_sub(3);
            let end = (index + 4).min(logits.len());
            (*value > 0.0 && logits[start..end].iter().all(|candidate| *candidate <= *value))
                .then_some(index as f64)
        })
        .collect::<Vec<_>>();
    let mut deduped = Vec::new();
    for peak in peaks {
        if let Some(group) = deduped.last_mut() {
            let (mean, count): &mut (f64, usize) = group;
            if peak - *mean <= 1.0 {
                *count += 1;
                *mean += (peak - *mean) / *count as f64;
                continue;
            }
        }
        deduped.push((peak, 1));
    }
    deduped.into_iter().map(|(mean, _)| mean).collect()
}

fn nearest_beat_indices(beats: &[f64], downbeats: &[f64]) -> Vec<usize> {
    let mut indices = downbeats
        .iter()
        .filter_map(|downbeat| {
            beats.iter().enumerate().min_by(|(_, a), (_, b)| {
                (*a - *downbeat).abs().total_cmp(&(*b - *downbeat).abs())
            }).map(|(index, _)| index)
        })
        .collect::<Vec<_>>();
    if indices.is_empty() { indices.push(0); }
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn infer_beats_per_bar(beats: &[f64], downbeats: &[f64]) -> usize {
    let indices = nearest_beat_indices(beats, downbeats);
    let candidates = indices.windows(2).filter_map(|pair| {
        let distance = pair[1] - pair[0];
        (2..=8).contains(&distance).then_some(distance as f64)
    }).collect::<Vec<_>>();
    let inferred = median(&candidates).round() as usize;
    if matches!(inferred, 3 | 4 | 6) { inferred } else { 4 }
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() { return f64::NAN; }
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 { (values[middle - 1] + values[middle]) / 2.0 } else { values[middle] }
}

fn round_seconds(value: f64) -> f64 { (value * 1_000_000.0).round() / 1_000_000.0 }

#[cfg(target_os = "android")]
pub fn android_model_status() -> String {
    use jni::objects::{Global, JObject, JString};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let Some(context) = main_android_context() else { return "unavailable".to_string(); };
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return "unavailable".to_string();
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let result = env.call_method(
            &activity,
            jni_str!("getTuneForgeBeatThisStatus"),
            jni_sig!(() -> JString),
            &[],
        )?.into_object()?;
        JString::cast_local(env, result)?.try_to_string(env)
    }).unwrap_or_else(|_| "unavailable".to_string())
}

#[cfg(target_os = "android")]
pub fn run_android_model(input: &[f32], frames: usize, job_id: &str) -> Result<(Vec<f32>, Vec<f32>), String> {
    use jni::objects::{Global, JFloatArray, JObject, JObjectArray, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let context = main_android_context().ok_or_else(|| {
        "ADVANCED_BEAT_BACKEND_FAILED: Android runtime unavailable.".to_string()
    })?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err("ADVANCED_BEAT_BACKEND_FAILED: Android runtime unavailable.".to_string());
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    let result = vm.attach_current_thread(|env| {
        let input_array = JFloatArray::new(env, input.len())?;
        input_array.set_region(env, 0, input)?;
        let job_id = env.new_string(job_id)?;
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let result = env.call_method(
            &activity,
            jni_str!("runTuneForgeBeatThis"),
            jni_sig!("([FILjava/lang/String;)[[F"),
            &[JValue::Object(input_array.as_ref()), JValue::Int(frames as i32), JValue::Object(job_id.as_ref())],
        )?.into_object()?;
        let outputs = JObjectArray::<JFloatArray>::cast_local(env, result)?;
        if outputs.len(env)? != 2 {
            return Err(jni::errors::Error::JniCall(jni::errors::JniError::InvalidArguments));
        }
        let beat_array = outputs.get_element(env, 0)?;
        let downbeat_array = outputs.get_element(env, 1)?;
        let mut beat = vec![0.0; beat_array.len(env)?];
        let mut downbeat = vec![0.0; downbeat_array.len(env)?];
        beat_array.get_region(env, 0, &mut beat)?;
        downbeat_array.get_region(env, 0, &mut downbeat)?;
        Ok((beat, downbeat))
    });
    result.map_err(|_| android_runtime_error(&take_android_model_error(&vm, context.context_jobject.cast(), job_id)))
}

#[cfg(target_os = "android")]
fn take_android_model_error(vm: &jni::JavaVM, activity_raw: jni::sys::jobject, job_id: &str) -> String {
    use jni::objects::{Global, JObject, JString, JValue};
    use jni::{jni_sig, jni_str};

    vm.attach_current_thread(|env| {
        env.exception_clear();
        let job_id = env.new_string(job_id)?;
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let result = env.call_method(
            &activity,
            jni_str!("takeTuneForgeBeatThisError"),
            jni_sig!((JString) -> JString),
            &[JValue::Object(job_id.as_ref())],
        )?.into_object()?;
        JString::cast_local(env, result)?.try_to_string(env)
    }).unwrap_or_else(|_| "BEAT_THIS_RUNTIME_FAILED".to_string())
}

fn android_runtime_error(code: &str) -> String {
    let detail = if code == "BEAT_THIS_CANCELLED" {
        return "ANALYSIS_CANCELLED".to_string();
    } else if code == "BEAT_THIS_MODEL_STORAGE_INSUFFICIENT" {
        "Not enough free space to install Advanced Beat Analysis. Free 9.4 MB, then retry."
    } else if matches!(code, "BEAT_THIS_MODEL_INTEGRITY_FAILED" | "BEAT_THIS_MODEL_SIZE_INVALID") {
        "The Advanced Beat Analysis model failed verification. Retry to repair the model."
    } else if code.starts_with("BEAT_THIS_MODEL_DOWNLOAD") {
        "Advanced Beat Analysis needs a one-time model download. Check your connection and retry; after installation, it works offline."
    } else if matches!(code,
        "BEAT_THIS_MODEL_STORAGE_UNAVAILABLE" | "BEAT_THIS_MODEL_STAGING_UNAVAILABLE" |
        "BEAT_THIS_MODEL_REPLACE_FAILED") {
        "Device storage is unavailable for the Advanced Beat Analysis model. Retry after checking available storage."
    } else if matches!(code, "BEAT_THIS_INPUT_SHAPE_INVALID" | "BEAT_THIS_OUTPUT_SHAPE_INVALID") {
        "The Advanced Beat Analysis model is incompatible with this app version."
    } else {
        "Advanced Beat Analysis could not run on this device. Retry analysis."
    };
    format!("ADVANCED_BEAT_BACKEND_FAILED: {detail}")
}

#[cfg(target_os = "android")]
pub fn cancel_android_model(job_id: &str) {
    use jni::objects::{Global, JObject, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let Some(context) = main_android_context() else { return; };
    if context.java_vm.is_null() || context.context_jobject.is_null() { return; }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    let _ = vm.attach_current_thread(|env| {
        let job_id = env.new_string(job_id)?;
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        env.call_method(
            &activity,
            jni_str!("cancelTuneForgeBeatThis"),
            jni_sig!((JString) -> ()),
            &[JValue::Object(job_id.as_ref())],
        )?;
        Ok::<(), jni::errors::Error>(())
    });
}

#[cfg(all(test, not(target_os = "android")))]
pub fn android_model_status() -> String { "unavailable".to_string() }

#[cfg(all(test, not(target_os = "android")))]
pub fn run_android_model(_input: &[f32], _frames: usize, _job_id: &str) -> Result<(Vec<f32>, Vec<f32>), String> {
    Err("ADVANCED_BEAT_BACKEND_FAILED: Android runtime unavailable.".to_string())
}

#[cfg(all(test, not(target_os = "android")))]
pub fn cancel_android_model(_job_id: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct LogMelFixture {
        sample_rate: u32,
        samples: Vec<f32>,
        features: Vec<Vec<f32>>,
    }

    fn tone(sample_rate: u32, seconds: f32) -> DecodedAudio {
        let frames = (sample_rate as f32 * seconds) as usize;
        DecodedAudio {
            samples: (0..frames).map(|index| (2.0 * std::f32::consts::PI * 440.0 * index as f32 / sample_rate as f32).sin()).collect(),
            sample_rate,
            channels: 1,
        }
    }

    #[test]
    fn android_runtime_codes_map_to_actionable_safe_messages() {
        assert_eq!(android_runtime_error("BEAT_THIS_CANCELLED"), "ANALYSIS_CANCELLED");
        let integrity = android_runtime_error("BEAT_THIS_MODEL_INTEGRITY_FAILED");
        assert!(integrity.contains("failed verification"));
        let unknown = android_runtime_error("/private/path JNI JavaException");
        assert!(unknown.contains("Retry analysis"));
        assert!(!unknown.contains("JNI"));
        assert!(!unknown.contains("/private/path"));
    }

    #[test]
    fn log_mel_supports_native_and_resampled_audio() {
        for sample_rate in [22_050, 44_100, 48_000] {
            let features = log_mel_spectrogram(&tone(sample_rate, 0.4)).unwrap();
            assert!(features.len() >= MIN_FRAMES);
            assert!(features.iter().flatten().all(|value| value.is_finite()));
        }
    }

    #[test]
    fn log_mel_matches_desktop_beat_this_oracle_at_source_rate() {
        let oracle: LogMelFixture = serde_json::from_str(include_str!(
            "fixtures/beat_this_logmel_22050.json"
        )).unwrap();
        let features = log_mel_spectrogram(&DecodedAudio {
            samples: oracle.samples,
            sample_rate: oracle.sample_rate,
            channels: 1,
        }).unwrap();
        assert_eq!(features.len(), oracle.features.len());
        let mut maximum_difference = 0.0_f32;
        let mut maximum_location = (0, 0);
        let mut maximum_values = (0.0, 0.0);
        let mut total_difference = 0.0_f32;
        let mut value_count = 0_usize;
        for (frame, (actual, expected)) in features.iter().zip(&oracle.features).enumerate() {
            assert_eq!(actual.len(), expected.len());
            for (bin, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                let difference = (actual - expected).abs();
                total_difference += difference;
                value_count += 1;
                if difference > maximum_difference {
                    maximum_difference = difference;
                    maximum_location = (frame, bin);
                    maximum_values = (*actual, *expected);
                }
            }
        }
        // Measured full-matrix maxima: 3.9537798e-4 on macOS arm64 and 4.3991453e-4 on Linux
        // x86_64. With identical f32 windowed input, divergence first appears after the
        // FFT/magnitude stage; model-runtime comparisons retain rtol=atol=1e-4.
        let mean_difference = total_difference / value_count as f32;
        assert!(maximum_difference <= 5.0e-4,
            "maximum full-matrix difference {maximum_difference}, mean {}, at frame {} bin {}: {} != {}",
            mean_difference, maximum_location.0, maximum_location.1,
            maximum_values.0, maximum_values.1);
        assert!(mean_difference <= 3.0e-5, "full-matrix mean difference {mean_difference}");
    }

    #[test]
    fn resampled_tones_preserve_structured_features() {
        let source = log_mel_spectrogram(&tone(22_050, 0.4)).unwrap();
        for sample_rate in [44_100, 48_000] {
            let candidate = log_mel_spectrogram(&tone(sample_rate, 0.4)).unwrap();
            assert_eq!(candidate.len(), source.len());
            let interior = source.iter().zip(&candidate).skip(2).take(source.len() - 4);
            let differences = interior
                .flat_map(|(left, right)| left.iter().zip(right))
                .map(|(left, right)| (left - right).abs())
                .collect::<Vec<_>>();
            let mean = differences.iter().sum::<f32>() / differences.len() as f32;
            assert!(mean <= 0.02, "{sample_rate} Hz mean feature difference {mean}");
            for (left, right) in source.iter().zip(&candidate).skip(2).take(source.len() - 4) {
                let left_peak = left.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
                let right_peak = right.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
                assert_eq!(left_peak, right_peak, "{sample_rate} Hz peak mel bin drifted");
            }
        }
    }

    #[test]
    fn log_mel_short_silence_is_valid() {
        let features = log_mel_spectrogram(&DecodedAudio { samples: vec![0.0; 32], sample_rate: 48_000, channels: 2 }).unwrap();
        assert_eq!(features.len(), MIN_FRAMES);
        assert!(features.iter().flatten().all(|value| *value == 0.0));
    }

    #[test]
    fn chunking_uses_dynamic_shapes_and_keep_first() {
        let features = vec![[1.0; MEL_BINS]; 3_010];
        let mut calls = Vec::new();
        let (beat, _) = predict_chunks(&features, |_, frames| {
            calls.push(frames);
            Ok((vec![calls.len() as f32; frames], vec![0.0; frames]))
        }).unwrap();
        assert_eq!(calls, vec![1_500, 1_500, 1_500]);
        assert_eq!(beat.len(), features.len());
        assert_eq!(beat[1_500], 2.0);
    }

    #[test]
    fn chunking_covers_every_frame_across_padding_boundaries() {
        for feature_count in [13, 100, 1_488, 1_489, 1_500, 1_501] {
            let features = vec![[1.0; MEL_BINS]; feature_count];
            let mut call_frames = Vec::new();
            let (beat, downbeat) = predict_chunks(&features, |_, frames| {
                call_frames.push(frames);
                Ok((vec![2.0; frames], vec![3.0; frames]))
            }).unwrap();
            assert!(beat.iter().all(|value| *value == 2.0), "uncovered beat frame at {feature_count}");
            assert!(downbeat.iter().all(|value| *value == 3.0), "uncovered downbeat frame at {feature_count}");
            assert!(call_frames.iter().all(|frames| (MIN_FRAMES..=CHUNK_FRAMES).contains(frames)));
        }
    }

    #[test]
    fn unusable_output_fails_advanced_backend() {
        let error = postprocess_timing(&[0.0; 13], &[0.0; 13], 1.0).unwrap_err();
        assert!(error.starts_with("ADVANCED_BEAT_BACKEND_FAILED"));
    }

    #[test]
    fn postprocess_builds_timing_grid() {
        let mut beat = vec![-1.0; 220];
        let mut downbeat = vec![-1.0; 220];
        for frame in (10..210).step_by(25) { beat[frame] = 2.0; }
        for frame in [10, 110] { downbeat[frame] = 2.0; }
        let result = postprocess_timing(&beat, &downbeat, 4.5).unwrap();
        assert_eq!(result.tempo_bpm, 120.0);
        assert_eq!(result.timing["beats_per_bar"], 4);
        assert_eq!(result.timing["beats"].as_array().unwrap().len(), 8);
    }
}
