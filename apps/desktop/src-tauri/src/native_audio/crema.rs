#![cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]

use serde::Deserialize;
use serde_json::{json, Value};

use super::decode::DecodedAudio;
use super::harmony::{
    crema_quality_contains, degree_name, format_chord_with_suffix, parse_crema_model_label, round3,
    sharp_pitch_class, CremaModelLabel, PitchSpelling,
};

const OUTPUT_WIDTHS: [usize; 4] = [170, 12, 13, 13];
const CLASSES_SHA256: &str = "e319b684db4725df87ab52c8c7b6df46508af23077c4b0a7dc662a6cbe6228c1";
#[derive(Clone, Deserialize)]
pub struct RuntimeState {
    schema_version: u32,
    source: SourceState,
    preprocessing: PreprocessingState,
    decoder: DecoderState,
}

#[derive(Clone, Deserialize)]
struct SourceState {
    name: String,
    version: String,
}

#[derive(Clone, Deserialize)]
struct PreprocessingState {
    #[serde(rename = "type")]
    kind: String,
    sample_rate: u32,
    hop_length: usize,
    fmin: f64,
    harmonics: Vec<u32>,
    octaves: usize,
    oversample: usize,
    output_shape: Vec<Option<usize>>,
}

#[derive(Clone, Deserialize)]
struct DecoderState {
    sample_rate: u32,
    hop_length: usize,
    labels: Vec<String>,
    classes_sha256: String,
    transition: TransitionState,
}

#[derive(Clone, Deserialize)]
struct TransitionState {
    encoding: String,
    shape: Vec<usize>,
    diagonal: f64,
    off_diagonal: f64,
}

pub fn parse_runtime_state(raw: &str) -> Result<RuntimeState, String> {
    let state: RuntimeState =
        serde_json::from_str(raw).map_err(|_| "CREMA_RUNTIME_STATE_INVALID".to_string())?;
    let labels_hash = sha256_lines(&state.decoder.labels);
    let valid = state.schema_version == 1
        && state.source.name == "crema"
        && state.source.version == "0.2.0"
        && state.preprocessing.kind == "hcqt-magnitude"
        && state.preprocessing.sample_rate == 44_100
        && state.preprocessing.hop_length == 4_096
        && (state.preprocessing.fmin - 32.703_195_662_574_83).abs() < f64::EPSILON
        && state.preprocessing.harmonics == [1, 2]
        && state.preprocessing.octaves == 6
        && state.preprocessing.oversample == 3
        && state.preprocessing.output_shape == [None, Some(216), Some(2)]
        && state.decoder.sample_rate == 44_100
        && state.decoder.hop_length == 4_096
        && state.decoder.labels.len() == 170
        && state.decoder.classes_sha256 == CLASSES_SHA256
        && labels_hash == CLASSES_SHA256
        && state.decoder.transition.encoding == "uniform-off-diagonal"
        && state.decoder.transition.shape == [170, 170]
        && state.decoder.transition.diagonal.is_finite()
        && state.decoder.transition.off_diagonal.is_finite();
    valid
        .then_some(state)
        .ok_or_else(|| "CREMA_RUNTIME_STATE_UNSUPPORTED".to_string())
}

pub fn preprocess_hcqt(
    audio: &DecodedAudio,
    state: &RuntimeState,
) -> Result<(Vec<f32>, usize), String> {
    preprocess_hcqt_with_cancel(audio, state, &|| false)
}

pub(crate) fn preprocess_hcqt_with_cancel<F>(
    audio: &DecodedAudio,
    state: &RuntimeState,
    should_cancel: &F,
) -> Result<(Vec<f32>, usize), String>
where
    F: Fn() -> bool,
{
    if audio.sample_rate == 0 || audio.samples.is_empty() {
        return Err("CREMA_AUDIO_INVALID".to_string());
    }
    let signal = if audio.sample_rate == state.preprocessing.sample_rate {
        audio.samples.clone()
    } else {
        super::soxr::resample_hq(
            &audio.samples,
            audio.sample_rate,
            state.preprocessing.sample_rate,
        )
        .map_err(|_| "CREMA_PREPROCESSING_FAILED".to_string())?
    };
    if should_cancel() {
        return Err("CREMA_CANCELLED".to_string());
    }
    let frames = ((signal.len() as f64 / state.preprocessing.sample_rate as f64)
        * state.preprocessing.sample_rate as f64
        / state.preprocessing.hop_length as f64)
        .floor() as usize;
    if frames == 0 {
        return Err("CREMA_AUDIO_TOO_SHORT".to_string());
    }
    let bins = state.preprocessing.octaves * 12 * state.preprocessing.oversample;
    let mut output = vec![0.0_f32; frames * bins * state.preprocessing.harmonics.len()];
    for (harmonic_index, harmonic) in state.preprocessing.harmonics.iter().enumerate() {
        if should_cancel() {
            return Err("CREMA_CANCELLED".to_string());
        }
        let cqt = super::harmonic_features::constant_q_magnitude_with_cancel(
            &signal,
            state.preprocessing.sample_rate,
            state.preprocessing.hop_length,
            state.preprocessing.fmin * *harmonic as f64,
            bins,
            12 * state.preprocessing.oversample,
            should_cancel,
        )
        .map_err(|error| {
            if error == "AUDIO_ANALYSIS_CANCELLED" {
                "CREMA_CANCELLED".to_string()
            } else {
                "CREMA_PREPROCESSING_FAILED".to_string()
            }
        })?;
        let peak = cqt
            .iter()
            .flat_map(|values| values.iter().take(frames))
            .map(|value| *value as f32)
            .fold(0.0_f32, f32::max);
        let reference_db = 10.0_f32 * (peak * peak).max(1.0e-10).log10();
        for frame in 0..frames {
            for bin in 0..bins {
                let magnitude = cqt
                    .get(bin)
                    .and_then(|values| values.get(frame))
                    .map(|value| *value as f32)
                    .unwrap_or(0.0);
                let power = magnitude * magnitude;
                let db = (10.0_f32 * power.max(1.0e-10).log10() - reference_db).max(-80.0);
                output[(frame * bins + bin) * 2 + harmonic_index] = db;
            }
        }
    }
    Ok((output, frames))
}

pub fn decode_outputs(
    outputs: &[Vec<f32>; 4],
    frames: usize,
    state: &RuntimeState,
) -> Result<Vec<Value>, String> {
    for (output, width) in outputs.iter().zip(OUTPUT_WIDTHS) {
        if output.len() != frames * width || output.iter().any(|value| !value.is_finite()) {
            return Err("CREMA_OUTPUT_SHAPE_INVALID".to_string());
        }
    }
    let path = viterbi(&outputs[0], frames, &state.decoder.transition)?;
    let mut timeline = Vec::new();
    let mut ends = (0..frames.saturating_sub(1))
        .filter(|index| path[*index + 1] != path[*index])
        .collect::<Vec<_>>();
    ends.push(frames);
    let mut previous_end: isize = -1;
    let mut start = 0;
    for marker in ends {
        let length = marker as isize - previous_end;
        let end = start + length as usize;
        let state_index = path[start];
        let last_probability_frame = end.min(frames - 1);
        let confidence = (start..=last_probability_frame)
            .map(|frame| f64::from(outputs[0][frame * 170 + state_index]))
            .sum::<f64>()
            / (last_probability_frame - start + 1) as f64;
        let mut raw_label = state.decoder.labels[state_index].clone();
        if matches!(
            parse_crema_model_label(&raw_label),
            CremaModelLabel::Chord(_)
        ) {
            let root = raw_label.split(':').next().unwrap_or("");
            let root_index = sharp_pitch_class(root)
                .ok_or_else(|| "CREMA_RUNTIME_STATE_UNSUPPORTED".to_string())?;
            let bass = geometric_bass(&outputs[3], start, last_probability_frame + 1);
            let relative = if bass < 12 {
                (bass + 12 - root_index) % 12
            } else {
                0
            };
            if relative != 0 && crema_quality_contains(&raw_label, relative) {
                raw_label.push('/');
                raw_label.push_str(degree_name(relative).unwrap());
            }
        }
        timeline.push(chord_segment(
            &raw_label,
            start as f64 * state.decoder.hop_length as f64 / state.decoder.sample_rate as f64,
            end as f64 * state.decoder.hop_length as f64 / state.decoder.sample_rate as f64,
            round3(confidence),
        ));
        start += length as usize;
        previous_end = marker as isize;
    }
    Ok(merge_adjacent(timeline))
}

fn viterbi(tag: &[f32], frames: usize, transition: &TransitionState) -> Result<Vec<usize>, String> {
    if frames == 0 {
        return Ok(Vec::new());
    }
    let count = 170;
    let tiny = f32::MIN_POSITIVE as f64;
    let diagonal = (transition.diagonal + tiny).ln();
    let off = (transition.off_diagonal + tiny).ln();
    let mut previous = vec![0.0; count];
    let mut pointers = vec![0_u8; frames * count];
    for state in 0..count {
        previous[state] = (f64::from(tag[state]) + tiny).ln();
    }
    for frame in 1..frames {
        let (best_index, best_value) = previous
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1))
            .map(|(i, v)| (i, *v))
            .unwrap();
        let mut current = vec![0.0; count];
        for state in 0..count {
            let stay = previous[state] + diagonal;
            let switch = best_value + off;
            let selected = if stay >= switch { state } else { best_index };
            pointers[frame * count + state] = selected as u8;
            current[state] = (f64::from(tag[frame * count + state]) + tiny).ln() + stay.max(switch);
        }
        previous = current;
    }
    let mut path = vec![0; frames];
    path[frames - 1] = previous
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))
        .unwrap()
        .0;
    for frame in (0..frames - 1).rev() {
        path[frame] = pointers[(frame + 1) * count + path[frame + 1]] as usize;
    }
    Ok(path)
}

fn chord_segment(raw: &str, start: f64, end: f64, confidence: f64) -> Value {
    match parse_crema_model_label(raw) {
        CremaModelLabel::NoChord => {
            json!({"start_seconds": round3(start), "end_seconds": round3(end), "label": "N.C.",
            "display_label": "N.C.", "raw_label": raw, "confidence": confidence, "pitch_class": Value::Null,
            "root_pitch_class": Value::Null, "quality": "no_chord", "bass_pitch_class": Value::Null,
            "bass_degree": Value::Null})
        }
        CremaModelLabel::Unknown => {
            json!({"start_seconds": round3(start), "end_seconds": round3(end), "label": "X",
            "display_label": "X", "raw_label": raw, "confidence": confidence, "pitch_class": Value::Null,
            "root_pitch_class": Value::Null, "quality": Value::Null, "bass_pitch_class": Value::Null,
            "bass_degree": Value::Null})
        }
        CremaModelLabel::Chord(chord) => {
            let display = format_chord_with_suffix(
                chord.root_pitch_class as i64,
                chord.suffix,
                chord.bass_pitch_class.map(|pitch| pitch as i64),
                PitchSpelling::Sharps,
            );
            json!({"start_seconds": round3(start), "end_seconds": round3(end), "label": display,
                "display_label": display, "raw_label": raw, "confidence": confidence,
                "pitch_class": chord.root_pitch_class, "root_pitch_class": chord.root_pitch_class,
                "quality": chord.quality, "bass_pitch_class": chord.bass_pitch_class,
                "bass_degree": chord.bass_degree})
        }
    }
}

fn merge_adjacent(mut segments: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for segment in segments.drain(..) {
        if let Some(previous) = merged.last_mut().filter(|previous| {
            previous["root_pitch_class"] == segment["root_pitch_class"]
                && previous["quality"] == segment["quality"]
                && previous["bass_pitch_class"] == segment["bass_pitch_class"]
        }) {
            previous["end_seconds"] = segment["end_seconds"].clone();
            let confidence = match (
                previous["confidence"].as_f64(),
                segment["confidence"].as_f64(),
            ) {
                (None, confidence) => confidence,
                (confidence, None) => confidence,
                (Some(previous_confidence), Some(segment_confidence)) => {
                    let previous_duration = previous["end_seconds"].as_f64().unwrap_or(0.0)
                        - previous["start_seconds"].as_f64().unwrap_or(0.0);
                    let segment_duration = segment["end_seconds"].as_f64().unwrap_or(0.0)
                        - segment["start_seconds"].as_f64().unwrap_or(0.0);
                    Some(round3(
                        (previous_confidence * previous_duration
                            + segment_confidence * segment_duration)
                            / (previous_duration + segment_duration).max(1e-6),
                    ))
                }
            };
            previous["confidence"] = confidence.map_or(Value::Null, Value::from);
        } else {
            merged.push(segment);
        }
    }
    merged
}

fn geometric_bass(bass: &[f32], start: usize, end: usize) -> usize {
    (0..13)
        .max_by(|left, right| {
            let mean = |index: usize| {
                (start..end)
                    .map(|frame| {
                        f64::from(bass[frame * 13 + index])
                            .max(f32::MIN_POSITIVE as f64)
                            .ln()
                    })
                    .sum::<f64>()
                    / (end - start) as f64
            };
            mean(*left).total_cmp(&mean(*right))
        })
        .unwrap_or(12)
}
fn sha256_lines(labels: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(labels.join("\n").as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(target_os = "android")]
pub fn prepare_android_model(job_id: &str) -> Result<String, String> {
    use jni::objects::{Global, JObject, JString, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;
    let context = main_android_context().ok_or_else(|| "CREMA_RUNTIME_UNAVAILABLE".to_string())?;
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let job = env.new_string(job_id)?;
        let result = env
            .call_method(
                &activity,
                jni_str!("prepareTuneForgeCrema"),
                jni_sig!((JString) -> JString),
                &[JValue::Object(job.as_ref())],
            )?
            .into_object()?;
        JString::cast_local(env, result)?.try_to_string(env)
    })
    .map_err(|_| android_error(&take_error(&vm, context.context_jobject.cast(), job_id)))
}

#[cfg(target_os = "android")]
pub fn run_android_model(
    input: &[f32],
    frames: usize,
    job_id: &str,
) -> Result<[Vec<f32>; 4], String> {
    use jni::objects::{Global, JFloatArray, JObject, JObjectArray, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;
    let context = main_android_context().ok_or_else(|| "CREMA_RUNTIME_UNAVAILABLE".to_string())?;
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let values = JFloatArray::new(env, input.len())?;
        values.set_region(env, 0, input)?;
        let job = env.new_string(job_id)?;
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let result = env
            .call_method(
                &activity,
                jni_str!("runTuneForgeCrema"),
                jni_sig!("([FILjava/lang/String;)[[F"),
                &[
                    JValue::Object(values.as_ref()),
                    JValue::Int(frames as i32),
                    JValue::Object(job.as_ref()),
                ],
            )?
            .into_object()?;
        let arrays = JObjectArray::<JFloatArray>::cast_local(env, result)?;
        if arrays.len(env)? != 4 {
            return Err(jni::errors::Error::JniCall(
                jni::errors::JniError::InvalidArguments,
            ));
        }
        let mut output: [Vec<f32>; 4] = std::array::from_fn(|_| Vec::new());
        for index in 0..4 {
            let array = arrays.get_element(env, index)?;
            output[index as usize].resize(array.len(env)?, 0.0);
            array.get_region(env, 0, &mut output[index as usize])?;
        }
        Ok(output)
    })
    .map_err(|_| android_error(&take_error(&vm, context.context_jobject.cast(), job_id)))
}

#[cfg(target_os = "android")]
pub fn android_model_status() -> String {
    android_string_call("getTuneForgeCremaStatus", None)
        .unwrap_or_else(|_| "unavailable".to_string())
}
#[cfg(target_os = "android")]
pub fn cancel_android_model(job_id: &str) {
    let _ = android_string_call("cancelTuneForgeCrema", Some(job_id));
}

#[cfg(target_os = "android")]
fn android_string_call(method: &str, job_id: Option<&str>) -> Result<String, String> {
    use jni::objects::{Global, JObject, JString, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;
    let context = main_android_context().ok_or_else(|| "CREMA_RUNTIME_UNAVAILABLE".to_string())?;
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        if let Some(job_id) = job_id {
            debug_assert_eq!(method, "cancelTuneForgeCrema");
            let job = env.new_string(job_id)?;
            env.call_method(
                &activity,
                jni_str!("cancelTuneForgeCrema"),
                jni_sig!((JString) -> ()),
                &[JValue::Object(job.as_ref())],
            )?;
            return Ok(String::new());
        }
        debug_assert_eq!(method, "getTuneForgeCremaStatus");
        let result = env
            .call_method(
                &activity,
                jni_str!("getTuneForgeCremaStatus"),
                jni_sig!(() -> JString),
                &[],
            )?
            .into_object()?;
        JString::cast_local(env, result)?.try_to_string(env)
    })
    .map_err(|_| "CREMA_RUNTIME_UNAVAILABLE".to_string())
}

#[cfg(target_os = "android")]
fn take_error(vm: &jni::JavaVM, raw: jni::sys::jobject, job_id: &str) -> String {
    use jni::objects::{Global, JObject, JString, JValue};
    use jni::{jni_sig, jni_str};
    vm.attach_current_thread(|env| {
        env.exception_clear();
        let job = env.new_string(job_id)?;
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&raw)? };
        let result = env
            .call_method(
                &activity,
                jni_str!("takeTuneForgeCremaError"),
                jni_sig!((JString) -> JString),
                &[JValue::Object(job.as_ref())],
            )?
            .into_object()?;
        JString::cast_local(env, result)?.try_to_string(env)
    })
    .unwrap_or_else(|_| "CREMA_RUNTIME_FAILED".to_string())
}
pub(crate) fn android_error(code: &str) -> String {
    if code == "CREMA_CANCELLED" {
        return "CHORDS_CANCELLED".to_string();
    }
    let detail = if code == "CREMA_MODEL_STORAGE_INSUFFICIENT" {
        "Not enough free space to install Advanced Chords. Free 4.3 MB, then retry."
    } else if code.contains("INTEGRITY") || code.contains("SIZE_INVALID") {
        "The Advanced Chords model files failed verification. Retry to repair them."
    } else if code.contains("DOWNLOAD") {
        "Advanced Chords needs a one-time 2.1 MB download. Check your connection and retry; after installation, it works offline."
    } else if code.contains("STORAGE") || code.contains("STAGING") || code.contains("REPLACE") {
        "Device storage is unavailable for Advanced Chords. Retry after checking available storage."
    } else if code.contains("SHAPE") || code.contains("STATE") {
        "The Advanced Chords model or runtime state is incompatible with this app version."
    } else {
        "Advanced Chords could not run on this device. Retry chord generation."
    };
    format!("ADVANCED_CHORD_BACKEND_FAILED: {detail}")
}

#[cfg(all(test, not(target_os = "android")))]
pub fn android_model_status() -> String {
    "unavailable".to_string()
}
#[cfg(all(test, not(target_os = "android")))]
pub fn prepare_android_model(_job_id: &str) -> Result<String, String> {
    Err("CREMA_RUNTIME_UNAVAILABLE".to_string())
}
#[cfg(all(test, not(target_os = "android")))]
pub fn run_android_model(
    _input: &[f32],
    _frames: usize,
    _job_id: &str,
) -> Result<[Vec<f32>; 4], String> {
    Err("CREMA_RUNTIME_UNAVAILABLE".to_string())
}
#[cfg(all(test, not(target_os = "android")))]
pub fn cancel_android_model(_job_id: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_audio::harmony::SHARP_PITCH_NAMES;
    use sha2::{Digest, Sha256};
    use std::path::Path;

    fn state(labels: Vec<String>) -> String {
        json!({"schema_version":1,"source":{"name":"crema","version":"0.2.0"},
        "preprocessing":{"type":"hcqt-magnitude","sample_rate":44100,"hop_length":4096,"fmin":32.70319566257483,
        "harmonics":[1,2],"octaves":6,"oversample":3,"output_shape":[null,216,2]},
        "decoder":{"sample_rate":44100,"hop_length":4096,"labels":labels,"classes_sha256":CLASSES_SHA256,
        "transition":{"encoding":"uniform-off-diagonal","shape":[170,170],"diagonal":0.957154635467057,"off_diagonal":0.00025352286705883413}}}).to_string()
    }
    fn labels() -> Vec<String> {
        let qualities = [
            "min", "maj", "dim", "aug", "min6", "maj6", "min7", "maj7", "7", "dim7", "hdim7",
            "minmaj7", "sus2", "sus4",
        ];
        let mut labels = vec!["N".to_string(), "X".to_string()];
        for pitch in SHARP_PITCH_NAMES {
            for quality in qualities {
                labels.push(format!("{pitch}:{quality}"));
            }
        }
        labels.sort();
        labels
    }
    #[test]
    fn runtime_error_never_exposes_runtime_detail() {
        let error = android_error("/private/path JNI failure");
        assert!(error.starts_with("ADVANCED_CHORD_BACKEND_FAILED"));
        assert!(!error.contains("JNI"));
        assert!(!error.contains("/private"));
    }
    #[test]
    fn malformed_runtime_state_fails_closed() {
        assert!(parse_runtime_state("{}").is_err());
        assert!(parse_runtime_state(&state(vec!["N".to_string(); 170])).is_err());
    }
    #[test]
    fn decoder_matches_frozen_desktop_timeline_boundaries_and_inversions() {
        let state = parse_runtime_state(&state(labels())).unwrap();
        let mut outputs: [Vec<f32>; 4] =
            std::array::from_fn(|index| vec![1.0e-8; 9 * OUTPUT_WIDTHS[index]]);
        for (frames, label, confidence) in [
            (&[0, 1][..], "C:maj7", 0.9),
            (&[2, 3], "G:7", 0.8),
            (&[4, 5], "N", 0.99),
            (&[6, 7, 8], "C:maj7", 0.85),
        ] {
            let label_index = state
                .decoder
                .labels
                .iter()
                .position(|value| value == label)
                .unwrap();
            for frame in frames {
                outputs[0][frame * 170 + label_index] = confidence;
            }
        }
        for frame in 0..9 {
            let sum = outputs[0][frame * 170..(frame + 1) * 170]
                .iter()
                .sum::<f32>();
            for value in &mut outputs[0][frame * 170..(frame + 1) * 170] {
                *value /= sum;
            }
            let bass = if frame < 2 || frame >= 6 {
                4
            } else if frame < 4 {
                5
            } else {
                12
            };
            outputs[3][frame * 13 + bass] = 1.0;
        }
        let timeline = decode_outputs(&outputs, 9, &state).unwrap();
        let projection = timeline
            .iter()
            .map(|segment| {
                (
                    segment["start_seconds"].as_f64().unwrap(),
                    segment["end_seconds"].as_f64().unwrap(),
                    segment["label"].as_str().unwrap().to_string(),
                    segment["confidence"].as_f64().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            projection,
            vec![
                (0.0, 0.186, "Cmaj7/E".into(), 0.667),
                (0.186, 0.372, "G7/F".into(), 0.667),
                (0.372, 0.557, "N.C.".into(), 0.667),
                (0.557, 0.929, "Cmaj7/E".into(), 1.0)
            ]
        );
    }

    #[test]
    fn runtime_vocabulary_normalizes_like_desktop() {
        let expected = [
            ("7", "7", "7"),
            ("aug", "aug", "aug"),
            ("dim", "dim", "dim"),
            ("dim7", "dim7", "dim7"),
            ("hdim7", "hdim7", "m7b5"),
            ("maj", "major", ""),
            ("maj6", "major", ""),
            ("maj7", "maj7", "maj7"),
            ("min", "minor", "m"),
            ("min6", "minor", "m"),
            ("min7", "m7", "m7"),
            ("minmaj7", "minor", "m"),
            ("sus2", "sus2", "sus2"),
            ("sus4", "sus4", "sus4"),
        ];
        for root in SHARP_PITCH_NAMES {
            for (raw_quality, quality, suffix) in expected {
                let raw = format!("{root}:{raw_quality}");
                let segment = chord_segment(&raw, 0.0, 1.0, 0.5);
                assert_eq!(segment["raw_label"], raw);
                assert_eq!(segment["quality"], quality);
                assert_eq!(segment["label"], format!("{root}{suffix}"));
            }
        }
        let no_chord = chord_segment("N", 0.0, 1.0, 0.5);
        assert_eq!(no_chord["label"], "N.C.");
        assert_eq!(no_chord["quality"], "no_chord");
        assert!(no_chord["root_pitch_class"].is_null());
        let unknown = chord_segment("X", 0.0, 1.0, 0.5);
        assert_eq!(unknown["label"], "X");
        assert!(unknown["quality"].is_null());
        assert!(unknown["root_pitch_class"].is_null());

        let inversion = chord_segment("C:minmaj7/3", 0.0, 1.0, 0.5);
        assert_eq!(inversion["label"], "Cm/E");
        assert_eq!(inversion["quality"], "minor");
        assert_eq!(inversion["bass_degree"], "3");
        assert_eq!(inversion["bass_pitch_class"], 4);

        let merged = merge_adjacent(vec![
            chord_segment("C:maj", 0.0, 1.0, 0.2),
            chord_segment("C:maj6", 1.0, 3.0, 0.8),
        ]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["end_seconds"], 3.0);
        assert_eq!(merged[0]["raw_label"], "C:maj");
        assert_eq!(merged[0]["quality"], "major");
        assert_eq!(merged[0]["confidence"], 0.44);

        let merged_with_missing_confidence = merge_adjacent(vec![
            chord_segment("C:maj", 0.0, 1.0, 0.2),
            chord_segment("C:maj6", 1.0, 3.0, 0.8),
        ]);
        let mut first_missing = merged_with_missing_confidence;
        first_missing[0]["confidence"] = Value::Null;
        let merged = merge_adjacent(vec![
            first_missing.remove(0),
            chord_segment("C:maj6", 3.0, 4.0, 0.8),
        ]);
        assert_eq!(merged[0]["confidence"], 0.8);
    }
    #[test]
    fn hcqt_matches_frozen_desktop_synthetic_reference() {
        let sample_rate = 8_000_u32;
        let frequencies = [
            65.406_391_325_149_66,
            130.812_782_650_299_3,
            164.813_778_456_434_96,
            195.997_717_990_874_63,
        ];
        let samples = (0..sample_rate as usize)
            .map(|frame| {
                let fade = 1.0_f64
                    .min(frame as f64 / (sample_rate as f64 * 0.03))
                    .min((sample_rate as usize - frame - 1) as f64 / (sample_rate as f64 * 0.06));
                let value = (6_000.0
                    * fade
                    * frequencies
                        .iter()
                        .map(|frequency| {
                            (2.0 * std::f64::consts::PI * frequency * frame as f64
                                / sample_rate as f64)
                                .sin()
                        })
                        .sum::<f64>()
                    / frequencies.len() as f64) as i16;
                value as f32 / 32_768.0
            })
            .collect();
        let state = parse_runtime_state(&state(labels())).unwrap();
        let (features, frames) = preprocess_hcqt(
            &DecodedAudio {
                samples,
                sample_rate,
                channels: 1,
            },
            &state,
        )
        .unwrap();
        assert_eq!(frames, 10);
        assert_eq!(features.len(), 10 * 216 * 2);
        for ((frame, bin, channel), expected) in [
            ((0, 0, 0), -59.071804),
            ((1, 36, 1), -4.4513607),
            ((5, 108, 0), -80.0),
            ((9, 215, 1), -80.0),
        ] {
            let actual = features[(frame * 216 + bin) * 2 + channel];
            assert!(
                (actual - expected).abs() <= 0.002,
                "feature[{frame},{bin},{channel}]={actual} != {expected}"
            );
        }
        let min = features.iter().copied().fold(f32::INFINITY, f32::min);
        let max = features.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let mean =
            features.iter().map(|value| f64::from(*value)).sum::<f64>() / features.len() as f64;
        let std = (features
            .iter()
            .map(|value| (f64::from(*value) - mean).powi(2))
            .sum::<f64>()
            / features.len() as f64)
            .sqrt();
        for (actual, expected) in [
            (f64::from(min), -80.0),
            (f64::from(max), 0.0),
            (mean, -67.447784),
            (std, 20.998577),
        ] {
            assert!(
                (actual - expected).abs() <= 0.002,
                "HCQT statistic {actual} != {expected}"
            );
        }
    }

    #[test]
    fn hcqt_matches_desktop_without_source_resampling() {
        let sample_rate = 44_100_u32;
        let frequencies = [
            65.406_391_325_149_66,
            261.625_565_300_598_6,
            329.627_556_912_869_9,
            391.995_435_981_749_27,
        ];
        let samples = (0..sample_rate as usize)
            .map(|frame| {
                let fade = 1.0_f64
                    .min(frame as f64 / (sample_rate as f64 * 0.03))
                    .min((sample_rate as usize - frame - 1) as f64 / (sample_rate as f64 * 0.06));
                let value = (6_000.0
                    * fade
                    * frequencies
                        .iter()
                        .map(|frequency| {
                            (2.0 * std::f64::consts::PI * frequency * frame as f64
                                / sample_rate as f64)
                                .sin()
                        })
                        .sum::<f64>()
                    / frequencies.len() as f64) as i16;
                value as f32 / 32_768.0
            })
            .collect();
        let state = parse_runtime_state(&state(labels())).unwrap();
        let (features, frames) = preprocess_hcqt(
            &DecodedAudio {
                samples,
                sample_rate,
                channels: 1,
            },
            &state,
        )
        .unwrap();
        assert_eq!(frames, 10);
        if let Ok(path) = std::env::var("TUNEFORGE_CREMA_HCQT_OUTPUT") {
            let bytes = features
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>();
            std::fs::write(path, bytes).unwrap();
        }
        let mean =
            features.iter().map(|value| f64::from(*value)).sum::<f64>() / features.len() as f64;
        let std = (features
            .iter()
            .map(|value| (f64::from(*value) - mean).powi(2))
            .sum::<f64>()
            / features.len() as f64)
            .sqrt();
        eprintln!(
            "selected={:?}; mean={mean}; std={std}",
            [(0, 0, 0), (1, 36, 1), (5, 108, 0), (9, 215, 1)]
                .map(|(frame, bin, channel)| features[(frame * 216 + bin) * 2 + channel])
        );
        for ((frame, bin, channel), expected) in [
            ((0, 0, 0), -80.0),
            ((1, 36, 1), -73.405_754),
            ((5, 108, 0), -6.024_432_7),
            ((9, 215, 1), -80.0),
        ] {
            let actual = features[(frame * 216 + bin) * 2 + channel];
            assert!(
                (actual - expected).abs() <= 0.002,
                "feature[{frame},{bin},{channel}]={actual} != {expected}"
            );
        }
        assert!((mean - -68.361_83).abs() <= 0.002, "HCQT mean {mean}");
        assert!((std - 19.680_384).abs() <= 0.002, "HCQT std {std}");
    }

    #[test]
    fn emits_real_file_hcqt_when_requested() {
        let Ok(audio_path) = std::env::var("TUNEFORGE_CREMA_REAL_AUDIO_INPUT") else {
            return;
        };
        let state_path = std::env::var("TUNEFORGE_CREMA_REAL_STATE_INPUT")
            .expect("real-file HCQT emission requires a runtime-state path");
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        std::fs::create_dir_all(&output_root).unwrap();
        let output_path = output_root.join("native-hcqt.f32");
        let audio = super::super::decode::read_mobile_audio(Path::new(&audio_path)).unwrap();
        let state_raw = std::fs::read_to_string(state_path).unwrap();
        let state = parse_runtime_state(&state_raw).unwrap();
        let (features, frames) = preprocess_hcqt(&audio, &state).unwrap();
        let signal = if audio.sample_rate == state.preprocessing.sample_rate {
            audio.samples.clone()
        } else {
            super::super::soxr::resample_hq(
                &audio.samples,
                audio.sample_rate,
                state.preprocessing.sample_rate,
            )
            .unwrap()
        };
        let decoded_bytes = signal
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        let bins = state.preprocessing.octaves * 12 * state.preprocessing.oversample;
        let mut magnitude_peaks = Vec::new();
        for harmonic in &state.preprocessing.harmonics {
            let cqt = super::super::harmonic_features::constant_q_magnitude(
                &signal,
                state.preprocessing.sample_rate,
                state.preprocessing.hop_length,
                state.preprocessing.fmin * *harmonic as f64,
                bins,
                12 * state.preprocessing.oversample,
            )
            .unwrap();
            let values = cqt
                .iter()
                .flat_map(|row| row.iter().take(frames))
                .map(|value| *value as f32)
                .collect::<Vec<_>>();
            magnitude_peaks.push(values.iter().copied().fold(0.0_f32, f32::max));
            let magnitude_bytes = values
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>();
            std::fs::write(
                output_root.join(format!("native-cqt-h{harmonic}.f32")),
                magnitude_bytes,
            )
            .unwrap();
        }
        let bytes = features
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        std::fs::write(&output_path, &bytes).unwrap();

        let min = features.iter().copied().fold(f32::INFINITY, f32::min);
        let max = features.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let mean =
            features.iter().map(|value| f64::from(*value)).sum::<f64>() / features.len() as f64;
        let std = (features
            .iter()
            .map(|value| (f64::from(*value) - mean).powi(2))
            .sum::<f64>()
            / features.len() as f64)
            .sqrt();
        let metadata_path = output_path.with_extension("json");
        std::fs::write(
            metadata_path,
            serde_json::to_vec_pretty(&json!({
                "sample_rate": audio.sample_rate,
                "channels": audio.channels,
                "decoded_samples": audio.samples.len(),
                "decoded_sha256": Sha256::digest(&decoded_bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
                "shape": [1, frames, 216, 2],
                "cqt_shape": [216, frames],
                "magnitude_peaks": magnitude_peaks,
                "sha256": Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
                "min": min,
                "max": max,
                "mean": mean,
                "std": std,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn emits_real_file_projected_cqt_when_requested() {
        if std::env::var_os("TUNEFORGE_CREMA_COMPLEX_CAPTURE").is_none() {
            return;
        }
        let audio_path = std::env::var("TUNEFORGE_CREMA_REAL_AUDIO_INPUT")
            .expect("complex CQT emission requires an audio path");
        let state_path = std::env::var("TUNEFORGE_CREMA_REAL_STATE_INPUT")
            .expect("complex CQT emission requires a runtime-state path");
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        std::fs::create_dir_all(&output_root).unwrap();
        let audio = super::super::decode::read_mobile_audio(Path::new(&audio_path)).unwrap();
        let state_raw = std::fs::read_to_string(state_path).unwrap();
        let state = parse_runtime_state(&state_raw).unwrap();
        let signal = if audio.sample_rate == state.preprocessing.sample_rate {
            audio.samples
        } else {
            super::super::soxr::resample_hq(
                &audio.samples,
                audio.sample_rate,
                state.preprocessing.sample_rate,
            )
            .unwrap()
        };
        let frames = signal.len() / state.preprocessing.hop_length;
        let bins = state.preprocessing.octaves * 12 * state.preprocessing.oversample;
        let mut native_peaks = Vec::new();
        let mut response_frames = Vec::new();
        for harmonic in &state.preprocessing.harmonics {
            let cqt = super::super::harmonic_features::constant_q_complex_for_test(
                &signal,
                state.preprocessing.sample_rate,
                state.preprocessing.hop_length,
                state.preprocessing.fmin * *harmonic as f64,
                bins,
                12 * state.preprocessing.oversample,
            )
            .unwrap();
            response_frames.push(cqt.first().map(Vec::len).unwrap_or(0));
            let projected = cqt
                .iter()
                .flat_map(|row| row.iter().take(frames))
                .copied()
                .collect::<Vec<_>>();
            let magnitudes = projected
                .iter()
                .map(|value| value.norm())
                .collect::<Vec<_>>();
            native_peaks.push(magnitudes.iter().copied().fold(0.0_f32, f32::max));
            let complex_bytes = projected
                .iter()
                .flat_map(|value| [value.re, value.im])
                .flat_map(f32::to_le_bytes)
                .collect::<Vec<_>>();
            let magnitude_bytes = magnitudes
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>();
            std::fs::write(
                output_root.join(format!("native-cqt-complex-h{harmonic}.f32")),
                complex_bytes,
            )
            .unwrap();
            std::fs::write(
                output_root.join(format!("native-cqt-norm-h{harmonic}.f32")),
                magnitude_bytes,
            )
            .unwrap();
        }
        std::fs::write(
            output_root.join("native-cqt-complex.json"),
            serde_json::to_vec_pretty(&json!({
                "sample_rate": state.preprocessing.sample_rate,
                "hop_length": state.preprocessing.hop_length,
                "harmonics": state.preprocessing.harmonics,
                "complex_layout": "harmonic files; bin-major, then frame, then [real, imaginary]",
                "complex_dtype": "little-endian float32",
                "complex_shape": [bins, frames, 2],
                "magnitude_layout": "harmonic files; bin-major, then frame",
                "magnitude_dtype": "little-endian float32",
                "magnitude_shape": [bins, frames],
                "response_frames_before_truncation": response_frames,
                "native_magnitude_peaks": native_peaks,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn emits_selected_real_file_cqt_stages_when_requested() {
        if std::env::var_os("TUNEFORGE_CREMA_STAGE_CAPTURE").is_none() {
            return;
        }
        let audio_path = std::env::var("TUNEFORGE_CREMA_REAL_AUDIO_INPUT")
            .expect("CQT stage capture requires an audio path");
        let state_path = std::env::var("TUNEFORGE_CREMA_REAL_STATE_INPUT")
            .expect("CQT stage capture requires a runtime-state path");
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        let manifest_path = output_root.join("cqt-projection-coordinate-manifest.json");
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
        let entries = manifest["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 48);
        let audio = super::super::decode::read_mobile_audio(Path::new(&audio_path)).unwrap();
        let state_raw = std::fs::read_to_string(state_path).unwrap();
        let state = parse_runtime_state(&state_raw).unwrap();
        let signal = if audio.sample_rate == state.preprocessing.sample_rate {
            audio.samples
        } else {
            super::super::soxr::resample_hq(
                &audio.samples,
                audio.sample_rate,
                state.preprocessing.sample_rate,
            )
            .unwrap()
        };
        let mut decoded_mono_hasher = Sha256::new();
        for value in &signal {
            decoded_mono_hasher.update(value.to_le_bytes());
        }
        let decoded_mono_sha256 = decoded_mono_hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let bins = state.preprocessing.octaves * 12 * state.preprocessing.oversample;
        let mut basis_indices = Vec::new();
        let mut basis_values = Vec::new();
        let mut spectra = Vec::new();
        let mut output_entries = Vec::new();
        for harmonic in &state.preprocessing.harmonics {
            let coordinates = entries
                .iter()
                .filter(|entry| entry["harmonic"].as_u64() == Some(u64::from(*harmonic)))
                .map(|entry| {
                    (
                        entry["octave_from_top"].as_u64().unwrap() as usize,
                        entry["global_bin"].as_u64().unwrap() as usize,
                        entry["frame"].as_u64().unwrap() as usize,
                    )
                })
                .collect::<Vec<_>>();
            let captures = super::super::harmonic_features::capture_cqt_projection_stages_for_test(
                &signal,
                state.preprocessing.sample_rate,
                state.preprocessing.hop_length,
                state.preprocessing.fmin * *harmonic as f64,
                bins,
                12 * state.preprocessing.oversample,
                &coordinates,
            )
            .unwrap();
            assert_eq!(captures.len(), coordinates.len());
            for capture in captures {
                let source = entries
                    .iter()
                    .find(|entry| {
                        entry["harmonic"].as_u64() == Some(u64::from(*harmonic))
                            && entry["octave_from_top"].as_u64()
                                == Some(capture.octave_from_top as u64)
                            && entry["global_bin"].as_u64() == Some(capture.global_bin as u64)
                            && entry["frame"].as_u64() == Some(capture.frame as u64)
                    })
                    .unwrap();
                let basis_index_offset = basis_indices.len();
                let basis_value_offset = basis_values.len();
                let spectrum_offset = spectra.len();
                basis_indices.extend_from_slice(&capture.basis_indices);
                basis_values.extend_from_slice(&capture.basis_values);
                spectra.extend_from_slice(&capture.spectrum);
                output_entries.push(json!({
                    "harmonic": harmonic,
                    "octave_from_top": capture.octave_from_top,
                    "global_bin": capture.global_bin,
                    "frame": capture.frame,
                    "selection": source["selection"],
                    "residual_abs": source["residual_abs"],
                    "sample_rate": capture.sample_rate,
                    "hop_length": capture.hop_length,
                    "n_fft": capture.n_fft,
                    "basis_scale": capture.basis_scale,
                    "output_length": capture.output_length,
                    "octave_signal_sha256": capture.octave_signal_sha256,
                    "fft_input_sha256": capture.fft_input_sha256,
                    "basis_index_offset": basis_index_offset,
                    "basis_value_offset": basis_value_offset,
                    "basis_nonzero": capture.basis_values.len(),
                    "spectrum_offset": spectrum_offset,
                    "spectrum_length": capture.spectrum.len(),
                    "projected_before_output_scale": [
                        capture.projected_before_output_scale.re,
                        capture.projected_before_output_scale.im,
                    ],
                    "projected_after_output_scale": [
                        capture.projected_after_output_scale.re,
                        capture.projected_after_output_scale.im,
                    ],
                }));
            }
        }
        assert_eq!(output_entries.len(), 48);
        let index_bytes = basis_indices
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        let complex_bytes = |values: &[realfft::num_complex::Complex32]| {
            values
                .iter()
                .flat_map(|value| [value.re, value.im])
                .flat_map(f32::to_le_bytes)
                .collect::<Vec<_>>()
        };
        std::fs::write(
            output_root.join("native-cqt-stage-basis-indices.u32"),
            index_bytes,
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-cqt-stage-basis-values.f32"),
            complex_bytes(&basis_values),
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-cqt-stage-spectra.f32"),
            complex_bytes(&spectra),
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-cqt-stage.json"),
            serde_json::to_vec_pretty(&json!({
                "schema_version": 1,
                "coordinate_count": output_entries.len(),
                "decoded_mono_sha256": decoded_mono_sha256,
                "basis_indices": {
                    "path": "native-cqt-stage-basis-indices.u32",
                    "dtype": "little-endian uint32",
                },
                "basis_values": {
                    "path": "native-cqt-stage-basis-values.f32",
                    "dtype": "little-endian complex64 interleaved [real, imaginary]",
                    "stage": "sparse basis after complex64 storage and float64 basis_scale multiply/cast",
                },
                "spectra": {
                    "path": "native-cqt-stage-spectra.f32",
                    "dtype": "little-endian complex64 interleaved [real, imaginary]",
                    "stage": "float64 real FFT stored as complex64 before projection",
                },
                "projection": {
                    "sum_order": "ascending FFT-bin order, complex32 multiply and accumulation",
                    "output_scale": "complex32 projection divided componentwise by sqrt(float64 output_length), then cast to complex32",
                },
                "entries": output_entries,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn replays_captured_cqt_projection_when_requested() {
        if std::env::var_os("TUNEFORGE_CREMA_STAGE_REPLAY").is_none() {
            return;
        }
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        let metadata: Value = serde_json::from_slice(
            &std::fs::read(output_root.join("native-cqt-stage.json")).unwrap(),
        )
        .unwrap();
        let read_f32 = |name: &str| {
            std::fs::read(output_root.join(name))
                .unwrap()
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>()
        };
        let indices = std::fs::read(output_root.join("native-cqt-stage-basis-indices.u32"))
            .unwrap()
            .chunks_exact(4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as usize)
            .collect::<Vec<_>>();
        let basis = read_f32("native-cqt-stage-basis-values.f32")
            .chunks_exact(2)
            .map(|value| realfft::num_complex::Complex32::new(value[0], value[1]))
            .collect::<Vec<_>>();
        let spectra = read_f32("native-cqt-stage-spectra.f32")
            .chunks_exact(2)
            .map(|value| realfft::num_complex::Complex32::new(value[0], value[1]))
            .collect::<Vec<_>>();
        for entry in metadata["entries"].as_array().unwrap() {
            let basis_offset = entry["basis_value_offset"].as_u64().unwrap() as usize;
            let index_offset = entry["basis_index_offset"].as_u64().unwrap() as usize;
            let nonzero = entry["basis_nonzero"].as_u64().unwrap() as usize;
            let spectrum_offset = entry["spectrum_offset"].as_u64().unwrap() as usize;
            let spectrum_length = entry["spectrum_length"].as_u64().unwrap() as usize;
            let projected = indices[index_offset..index_offset + nonzero]
                .iter()
                .zip(&basis[basis_offset..basis_offset + nonzero])
                .map(|(index, value)| value * spectra[spectrum_offset + *index])
                .sum::<realfft::num_complex::Complex32>();
            let before = entry["projected_before_output_scale"].as_array().unwrap();
            assert_eq!(
                projected.re.to_bits(),
                (before[0].as_f64().unwrap() as f32).to_bits()
            );
            assert_eq!(
                projected.im.to_bits(),
                (before[1].as_f64().unwrap() as f32).to_bits()
            );
            let output_scale = entry["output_length"].as_f64().unwrap().sqrt();
            let after = realfft::num_complex::Complex32::new(
                (f64::from(projected.re) / output_scale) as f32,
                (f64::from(projected.im) / output_scale) as f32,
            );
            let expected_after = entry["projected_after_output_scale"].as_array().unwrap();
            assert_eq!(
                after.re.to_bits(),
                (expected_after[0].as_f64().unwrap() as f32).to_bits()
            );
            assert_eq!(
                after.im.to_bits(),
                (expected_after[1].as_f64().unwrap() as f32).to_bits()
            );
            assert_eq!(
                spectrum_length,
                entry["n_fft"].as_u64().unwrap() as usize / 2 + 1
            );
        }
    }
}
