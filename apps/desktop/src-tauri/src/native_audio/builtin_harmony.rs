#![cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]

use serde_json::{json, Value};

use super::harmonic_features::{
    active_chroma_mean, combined_chroma, HarmonicFeatures, ANALYSIS_HOP_LENGTH,
    ANALYSIS_SAMPLE_RATE,
};
use super::harmony::{format_chord, format_key, quality_intervals, round3, KeyMode, PitchSpelling};

const MAJOR_PROFILE: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
#[derive(Clone)]
struct ChordEvidence {
    pitch_class: usize,
    quality: &'static str,
    start: f64,
    end: f64,
}

const CHORD_SHAPES: [(&str, &[f64], f64); 8] = [
    ("major", &[1.0, 0.88, 0.76], 0.0),
    ("minor", &[1.0, 0.88, 0.76], 0.0),
    ("7", &[1.0, 0.86, 0.72, 0.58], 0.02),
    ("maj7", &[1.0, 0.86, 0.72, 0.58], 0.02),
    ("m7", &[1.0, 0.86, 0.72, 0.58], 0.02),
    ("sus2", &[1.0, 0.82, 0.74], 0.015),
    ("sus4", &[1.0, 0.82, 0.74], 0.015),
    ("dim", &[1.0, 0.84, 0.72], 0.02),
];

#[derive(Clone)]
struct Template {
    pitch: usize,
    quality: &'static str,
    vector: [f64; 12],
    complexity: f64,
}

#[derive(Clone)]
struct Observation {
    start: usize,
    end: usize,
    chroma: [f64; 12],
    scores: Vec<f64>,
}

pub fn detect_chords(features: &HarmonicFeatures) -> Vec<Value> {
    if features.duration_seconds <= 0.0 {
        return Vec::new();
    }
    let chroma = combined_chroma(features);
    let templates = templates();
    let peak = features.rms.iter().copied().fold(0.0_f64, f64::max);
    let mut observations = Vec::new();
    for boundary in window_boundaries(features, chroma.len()).windows(2) {
        let (start, end) = (boundary[0], boundary[1]);
        let vector = weighted_chroma(features, &chroma, start, end);
        let energy = features.rms[start..end].iter().sum::<f64>() / (end - start).max(1) as f64;
        let relative_energy = if peak > 0.0 {
            (energy / peak).clamp(0.0, 1.0)
        } else {
            0.0
        };
        observations.push(Observation {
            start,
            end,
            chroma: vector,
            scores: template_scores(&templates, &vector, relative_energy),
        });
    }
    if observations.is_empty() {
        return Vec::new();
    }
    let path = smooth_path(&templates, &observations);
    let raw = segments_from_path(features, &templates, &observations, &path);
    simplify_low_confidence_extensions(merge_low_confidence_blips(raw))
}

fn window_boundaries(features: &HarmonicFeatures, frame_count: usize) -> Vec<usize> {
    if frame_count == 0 {
        return vec![0];
    }
    let minimum =
        ((0.38 * ANALYSIS_SAMPLE_RATE as f64 / ANALYSIS_HOP_LENGTH as f64).round() as usize).max(1);
    if features.beat_frames.len() >= 4 {
        let mut boundaries = vec![0];
        for &frame in &features.beat_frames {
            if frame.saturating_sub(*boundaries.last().unwrap()) >= minimum {
                boundaries.push(frame);
            }
        }
        if frame_count.saturating_sub(*boundaries.last().unwrap()) >= minimum {
            boundaries.push(frame_count);
        } else if let Some(last) = boundaries.last_mut() {
            *last = frame_count;
        }
        let boundaries = dedupe_boundaries(boundaries, frame_count);
        if boundaries.len() >= 3 {
            return boundaries;
        }
    }
    let step =
        ((0.55 * ANALYSIS_SAMPLE_RATE as f64 / ANALYSIS_HOP_LENGTH as f64).round() as usize).max(1);
    dedupe_boundaries(
        (0..frame_count)
            .step_by(step)
            .chain(std::iter::once(frame_count))
            .collect(),
        frame_count,
    )
}

fn dedupe_boundaries(boundaries: Vec<usize>, frame_count: usize) -> Vec<usize> {
    let mut result = Vec::new();
    for boundary in boundaries {
        let bounded = boundary.min(frame_count);
        if result.last().is_none_or(|previous| bounded > *previous) {
            result.push(bounded);
        }
    }
    if result.first() != Some(&0) {
        result.insert(0, 0);
    }
    if result.last() != Some(&frame_count) {
        result.push(frame_count);
    }
    result
}

pub fn estimate_key(
    features: &HarmonicFeatures,
    timeline: &[Value],
) -> (Option<String>, Option<f64>) {
    let chroma = active_chroma_mean(features);
    estimate_key_from_chroma_and_chords(&chroma, &chord_evidence(timeline))
}

fn estimate_key_from_chroma_and_chords(
    chroma: &[f64; 12],
    chords: &[ChordEvidence],
) -> (Option<String>, Option<f64>) {
    if chroma.iter().map(|value| value * value).sum::<f64>().sqrt() <= 0.0 {
        return (None, None);
    }
    let normalized = zscore(&chroma.map(|value| value as f32));
    let mut profile_scores = [0.0_f32; 24];
    for pitch in 0..12 {
        profile_scores[pitch] =
            (correlation(&normalized, &rotate_profile(&MAJOR_PROFILE, pitch)) + 1.0) / 2.0;
        profile_scores[12 + pitch] =
            (correlation(&normalized, &rotate_profile(&MINOR_PROFILE, pitch)) + 1.0) / 2.0;
    }
    let chord_scores = chord_scores(chords);
    let combined = std::array::from_fn::<_, 24, _>(|index| {
        chord_scores.map_or(profile_scores[index], |scores| {
            0.78_f32 * profile_scores[index] + 0.22_f32 * scores[index]
        })
    });
    let best = first_max_index_f32(&combined).unwrap();
    let mut ordered = combined;
    ordered.sort_by(f32::total_cmp);
    let best_score = f64::from(combined[best]);
    let margin = (best_score - f64::from(ordered[22])).max(0.0);
    let mut confidence = (0.34 + margin * 4.2).clamp(0.0, 0.96);
    let relative = if best < 12 {
        12 + ((best + 9) % 12)
    } else {
        (best - 12 + 3) % 12
    };
    let relative_gap = best_score - f64::from(combined[relative]);
    if relative_gap < 0.035 {
        confidence *= 0.78;
    } else if relative_gap < 0.075 {
        confidence *= 0.9;
    }
    let (pitch, mode) = if best < 12 {
        (best, KeyMode::Major)
    } else {
        (best - 12, KeyMode::Minor)
    };
    let label = format_key(pitch as i64, mode, PitchSpelling::Sharps);
    (Some(label), Some(round3(confidence)))
}

fn chord_evidence(timeline: &[Value]) -> Vec<ChordEvidence> {
    timeline
        .iter()
        .filter_map(|segment| {
            let segment_quality = segment.get("quality")?.as_str()?;
            Some(ChordEvidence {
                pitch_class: segment.get("pitch_class")?.as_u64()? as usize,
                quality: CHORD_SHAPES
                    .iter()
                    .find(|(quality, _, _)| *quality == segment_quality)?
                    .0,
                start: segment.get("start_seconds")?.as_f64()?,
                end: segment.get("end_seconds")?.as_f64()?,
            })
        })
        .collect()
}

fn chord_scores(chords: &[ChordEvidence]) -> Option<[f32; 24]> {
    let mut scores = [0.0_f32; 24];
    let mut total = 0.0;
    for chord in chords {
        let duration = (chord.end - chord.start).max(0.0);
        if duration <= 0.0 {
            continue;
        }
        total += duration;
        for key in 0..12 {
            scores[key] +=
                (duration * compatibility(chord.pitch_class, chord.quality, key, false)) as f32;
            scores[12 + key] +=
                (duration * compatibility(chord.pitch_class, chord.quality, key, true)) as f32;
        }
    }
    if total <= 0.0 {
        None
    } else {
        for score in &mut scores {
            *score /= total as f32;
        }
        Some(scores)
    }
}

fn compatibility(chord: usize, quality: &str, key: usize, minor: bool) -> f64 {
    let degree = (chord + 12 - key) % 12;
    let expected: &[&str] = match (minor, degree) {
        (false, 0 | 5) => &["major", "maj7", "sus2", "sus4"],
        (false, 7) => &["major", "7", "sus2", "sus4"],
        (false, 2 | 4 | 9) => &["minor", "m7"],
        (false, 11) => &["dim"],
        (true, 0) => &["minor", "m7"],
        (true, 2) => &["dim"],
        (true, 3 | 8) => &["major", "maj7"],
        (true, 5) => &["minor", "m7", "sus2", "sus4"],
        (true, 7) => &["minor", "major", "7", "sus2", "sus4"],
        (true, 10) => &["major", "7"],
        _ => &[],
    };
    if expected.contains(&quality) {
        1.0
    } else if matches!(quality, "sus2" | "sus4")
        && expected
            .iter()
            .any(|value| matches!(*value, "major" | "minor" | "7"))
    {
        0.65
    } else if matches!(quality, "7" | "maj7" | "m7")
        && expected
            .iter()
            .any(|value| matches!(*value, "major" | "minor"))
    {
        0.55
    } else if !expected.is_empty() {
        0.35
    } else {
        0.0
    }
}

fn weighted_chroma(
    features: &HarmonicFeatures,
    chroma: &[[f64; 12]],
    start: usize,
    end: usize,
) -> [f64; 12] {
    let mut result = [0.0; 12];
    let mut weight = 0.0;
    for index in start..end {
        let current = if features.active_frame_mask[index] {
            features.rms[index]
        } else {
            0.0
        };
        if current <= 0.0 {
            continue;
        }
        for pitch in 0..12 {
            result[pitch] += chroma[index][pitch] * current;
        }
        weight += current;
    }
    if weight <= 0.0 {
        let rms_weight = features.rms[start..end].iter().sum::<f64>();
        for index in start..end {
            let current = if rms_weight > 0.0 {
                features.rms[index]
            } else {
                1.0
            };
            for pitch in 0..12 {
                result[pitch] += chroma[index][pitch] * current;
            }
        }
    }
    let norm = result.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm > 0.0 {
        for value in &mut result {
            *value = ((*value / norm) as f32) as f64;
        }
    }
    result
}

fn templates() -> Vec<Template> {
    CHORD_SHAPES
        .iter()
        .flat_map(|(quality, weights, complexity)| {
            let intervals =
                quality_intervals(quality).expect("built-in chord quality has intervals");
            (0..12).map(move |pitch| {
                let mut vector = [0.0; 12];
                for (interval, weight) in intervals.iter().zip(*weights) {
                    vector[(pitch + interval) % 12] = (*weight as f32) as f64;
                }
                let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
                for value in &mut vector {
                    *value = ((*value / norm) as f32) as f64;
                }
                Template {
                    pitch,
                    quality,
                    vector,
                    complexity: *complexity,
                }
            })
        })
        .collect()
}

fn template_scores(templates: &[Template], chroma: &[f64; 12], energy: f64) -> Vec<f64> {
    if energy < 0.045 || chroma.iter().map(|value| value * value).sum::<f64>().sqrt() <= 0.0 {
        let mut scores = vec![-0.15; templates.len()];
        scores.push(0.95);
        return scores;
    }
    let mut scores = templates
        .iter()
        .map(|template| {
            ((chroma
                .iter()
                .zip(template.vector)
                .map(|(left, right)| left * right)
                .sum::<f64>()
                - template.complexity) as f32) as f64
        })
        .collect::<Vec<_>>();
    let index = |pitch: usize, quality: &str| {
        templates
            .iter()
            .position(|value| value.pitch == pitch && value.quality == quality)
            .unwrap()
    };
    for pitch in 0..12 {
        let major = scores[index(pitch, "major")];
        let minor = scores[index(pitch, "minor")];
        for (quality, baseline) in [("7", major), ("maj7", major), ("m7", minor)] {
            let selected = index(pitch, quality);
            let intervals = quality_intervals(quality).unwrap();
            let body =
                [intervals[0], intervals[1], intervals[2]].map(|tone| chroma[(pitch + tone) % 12]);
            let color = chroma[(pitch + intervals[3]) % 12];
            if body.iter().copied().fold(f64::INFINITY, f64::min) < 0.14
                || color < 0.16
                || color < body.iter().copied().fold(f64::INFINITY, f64::min) * 0.75
            {
                scores[selected] = ((baseline - 0.02) as f32) as f64;
            }
        }
        for quality in ["sus2", "sus4"] {
            let selected = index(pitch, quality);
            let tone = quality_intervals(quality).unwrap()[1];
            let root = chroma[pitch];
            let fifth = chroma[(pitch + 7) % 12];
            let suspended = chroma[(pitch + tone) % 12];
            let third = chroma[(pitch + 3) % 12].max(chroma[(pitch + 4) % 12]);
            if root.min(fifth).min(suspended) < 0.14 || suspended < third * 1.15 {
                scores[selected] = ((major.max(minor) - 0.02) as f32) as f64;
            }
        }
    }
    scores.push(0.08);
    scores
}

fn smooth_path(templates: &[Template], observations: &[Observation]) -> Vec<usize> {
    let none = templates.len();
    let states = none + 1;
    let mut previous = observations[0].scores.clone();
    let mut pointers = Vec::new();
    for observation in observations.iter().skip(1) {
        let mut current = vec![0.0; states];
        let mut back = vec![0; states];
        for state in 0..states {
            let (best, value) = first_max_pair_f64(
                (0..states)
                    .map(|prior| (prior, previous[prior] + transition(templates, prior, state))),
            )
            .unwrap();
            current[state] = value + observation.scores[state];
            back[state] = best;
        }
        previous = current;
        pointers.push(back);
    }
    let mut state = first_max_pair_f64((0..states).map(|index| (index, previous[index])))
        .unwrap()
        .0;
    let mut path = vec![state];
    for back in pointers.iter().rev() {
        state = back[state];
        path.push(state);
    }
    path.reverse();
    path
}

fn first_max_pair_f64(values: impl IntoIterator<Item = (usize, f64)>) -> Option<(usize, f64)> {
    let mut values = values.into_iter();
    let mut best = values.next()?;
    for candidate in values {
        if candidate.1.total_cmp(&best.1).is_gt() {
            best = candidate;
        }
    }
    Some(best)
}

fn first_max_index_f32(values: &[f32]) -> Option<usize> {
    let mut best = values.first().map(|value| (0, *value))?;
    for (index, value) in values.iter().copied().enumerate().skip(1) {
        if value.total_cmp(&best.1).is_gt() {
            best = (index, value);
        }
    }
    Some(best.0)
}

fn transition(templates: &[Template], previous: usize, current: usize) -> f64 {
    let none = templates.len();
    if previous == current {
        return 0.10;
    }
    if previous == none || current == none {
        return -0.08;
    }
    if templates[previous].pitch == templates[current].pitch {
        return -0.025;
    }
    if [2, 5, 7, 10].contains(&((templates[current].pitch + 12 - templates[previous].pitch) % 12)) {
        -0.075
    } else {
        -0.13
    }
}

fn builtin_chord_label(pitch: usize, quality: &str) -> String {
    format_chord(pitch as i64, quality, None, PitchSpelling::Dual)
        .expect("built-in chord quality has a display suffix")
}

fn segments_from_path(
    features: &HarmonicFeatures,
    templates: &[Template],
    observations: &[Observation],
    path: &[usize],
) -> Vec<Value> {
    let mut segments: Vec<Value> = Vec::new();
    let mut start_index = 0;
    for index in 1..=path.len() {
        if index < path.len() && path[index] == path[start_index] {
            continue;
        }
        let state = path[start_index];
        let first = &observations[start_index];
        let last = &observations[index - 1];
        let start =
            round3(first.start as f64 * ANALYSIS_HOP_LENGTH as f64 / ANALYSIS_SAMPLE_RATE as f64);
        let end = round3(
            (last.end as f64 * ANALYSIS_HOP_LENGTH as f64 / ANALYSIS_SAMPLE_RATE as f64)
                .min(features.duration_seconds),
        );
        let segment = if state == templates.len() {
            json!({"start_seconds":start,"end_seconds":end,"label":"N.C.","confidence":Value::Null,"pitch_class":Value::Null,"quality":Value::Null})
        } else {
            let template = &templates[state];
            let confidence = observations[start_index..index]
                .iter()
                .map(|observation| confidence(&observation.scores, state, templates.len()))
                .sum::<f64>()
                / (index - start_index) as f64;
            let (pitch, quality, label) = if template.quality == "m7"
                && minor_seventh_sounds_like_upper_triad(
                    template,
                    &observations[start_index..index],
                    state,
                    templates,
                ) {
                let pitch = (template.pitch + 3) % 12;
                (pitch, "major", builtin_chord_label(pitch, "major"))
            } else {
                (
                    template.pitch,
                    template.quality,
                    builtin_chord_label(template.pitch, template.quality),
                )
            };
            json!({"start_seconds":start,"end_seconds":end,"label":label,"confidence":round3(confidence),"pitch_class":pitch,"quality":quality})
        };
        segments.push(segment);
        start_index = index;
    }
    merge_adjacent(segments)
}

fn minor_seventh_sounds_like_upper_triad(
    template: &Template,
    observations: &[Observation],
    state: usize,
    templates: &[Template],
) -> bool {
    let mut chroma = [0.0; 12];
    for observation in observations {
        for pitch in 0..12 {
            chroma[pitch] += observation.chroma[pitch];
        }
    }
    if !observations.is_empty() {
        for value in &mut chroma {
            *value /= observations.len() as f64;
        }
    }
    let root = chroma[template.pitch];
    let upper = [
        chroma[(template.pitch + 3) % 12],
        chroma[(template.pitch + 7) % 12],
        chroma[(template.pitch + 10) % 12],
    ];
    if upper.into_iter().fold(f64::INFINITY, f64::min) < 0.16
        || root >= upper.into_iter().fold(f64::NEG_INFINITY, f64::max) * 0.9
    {
        return false;
    }
    let relative = templates
        .iter()
        .position(|candidate| {
            candidate.pitch == (template.pitch + 3) % 12 && candidate.quality == "major"
        })
        .unwrap();
    let average = |index: usize| {
        observations
            .iter()
            .map(|observation| observation.scores[index])
            .sum::<f64>()
            / observations.len().max(1) as f64
    };
    average(state) - average(relative) < 0.12
}

fn merge_adjacent(segments: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for segment in segments {
        if let Some(previous) = merged
            .last_mut()
            .filter(|previous| previous["label"] == segment["label"])
        {
            previous["end_seconds"] = segment["end_seconds"].clone();
            let confidence = merge_confidence(previous, &segment);
            previous["confidence"] = confidence.map_or(Value::Null, |value| json!(value));
        } else {
            merged.push(segment);
        }
    }
    merged
}

fn merge_confidence(first: &Value, second: &Value) -> Option<f64> {
    let a = first["confidence"].as_f64();
    let b = second["confidence"].as_f64();
    match (a, b) {
        (None, value) | (value, None) => value,
        (Some(a), Some(b)) => {
            let first_duration =
                first["end_seconds"].as_f64()? - first["start_seconds"].as_f64()?;
            let second_duration =
                second["end_seconds"].as_f64()? - second["start_seconds"].as_f64()?;
            Some(round3(
                (a * first_duration + b * second_duration)
                    / (first_duration + second_duration).max(1.0e-6),
            ))
        }
    }
}

fn merge_low_confidence_blips(segments: Vec<Value>) -> Vec<Value> {
    let mut merged = merge_adjacent(segments);
    let mut index = 0;
    while index < merged.len() {
        let duration = merged[index]["end_seconds"].as_f64().unwrap_or(0.0)
            - merged[index]["start_seconds"].as_f64().unwrap_or(0.0);
        let confidence = merged[index]["confidence"].as_f64().unwrap_or(1.0);
        if duration >= 0.55 || confidence >= 0.38 || merged.len() == 1 {
            index += 1;
            continue;
        }
        let segment = merged[index].clone();
        let target = if index == 0 {
            1
        } else if index + 1 == merged.len() {
            index - 1
        } else if merged[index - 1]["confidence"].as_f64().unwrap_or(0.0)
            >= merged[index + 1]["confidence"].as_f64().unwrap_or(0.0)
        {
            index - 1
        } else {
            index + 1
        };
        if target < index {
            merged[target]["end_seconds"] = segment["end_seconds"].clone();
        } else {
            merged[target]["start_seconds"] = segment["start_seconds"].clone();
        }
        let confidence = merge_confidence(&merged[target], &segment);
        merged[target]["confidence"] = confidence.map_or(Value::Null, |value| json!(value));
        merged.remove(index);
        merged = merge_adjacent(merged);
        index = index.saturating_sub(1);
    }
    merged
}

fn simplify_low_confidence_extensions(segments: Vec<Value>) -> Vec<Value> {
    let simplified = segments
        .into_iter()
        .map(|mut segment| {
            let Some(quality) = segment["quality"].as_str() else {
                return segment;
            };
            let confidence = segment["confidence"].as_f64().unwrap_or(0.0);
            let threshold = if matches!(quality, "sus2" | "sus4") {
                0.52
            } else {
                0.62
            };
            if matches!(quality, "7" | "maj7" | "m7" | "sus2" | "sus4" | "dim")
                && confidence < threshold
            {
                let Some(pitch) = segment["pitch_class"].as_u64().map(|value| value as usize)
                else {
                    return segment;
                };
                let next = if matches!(quality, "m7" | "dim") {
                    "minor"
                } else {
                    "major"
                };
                segment["quality"] = json!(next);
                segment["label"] = json!(builtin_chord_label(pitch, next));
            }
            segment
        })
        .collect();
    merge_adjacent(simplified)
}

fn confidence(scores: &[f64], selected: usize, none: usize) -> f64 {
    let selected_score = scores[selected];
    let second = scores[..none]
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != selected)
        .map(|(_, value)| *value)
        .fold(f64::NEG_INFINITY, f64::max);
    ((selected_score - second) * 4.0 + (selected_score - 0.58) * 1.2).clamp(0.0, 1.0)
}

fn rotate_profile(profile: &[f64; 12], pitch: usize) -> [f32; 12] {
    std::array::from_fn(|index| profile[(index + 12 - pitch) % 12] as f32)
}
fn zscore(values: &[f32; 12]) -> [f32; 12] {
    let mean = values.iter().sum::<f32>() / 12.0;
    let variance = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f32>()
        / 12.0;
    if variance <= 0.0 {
        std::array::from_fn(|index| values[index] - mean)
    } else {
        let std = variance.sqrt();
        std::array::from_fn(|index| (values[index] - mean) / std)
    }
}
fn correlation(left: &[f32; 12], profile: &[f32; 12]) -> f32 {
    let right = zscore(profile);
    let denominator = left.iter().map(|value| value * value).sum::<f32>().sqrt()
        * right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if denominator <= 0.0 {
        0.0
    } else {
        left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>() / denominator
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_audio::decode::{read_mobile_audio, DecodedAudio};
    use crate::native_audio::harmonic_features::extract_harmonic_features_from_audio;
    use serde::Deserialize;
    use std::path::Path;

    #[derive(Deserialize)]
    struct HarmonicFeaturesFixture {
        duration_seconds: f64,
        chroma_cqt: Vec<[f64; 12]>,
        chroma_cens: Vec<[f64; 12]>,
        rms: Vec<f64>,
        active_frame_mask: Vec<bool>,
        beat_frames: Vec<usize>,
        estimated_reference_hz: Option<f64>,
        tuning_offset_cents: Option<f64>,
    }

    impl From<HarmonicFeaturesFixture> for HarmonicFeatures {
        fn from(value: HarmonicFeaturesFixture) -> Self {
            Self {
                duration_seconds: value.duration_seconds,
                chroma_cqt: value.chroma_cqt,
                chroma_cens: value.chroma_cens,
                rms: value.rms,
                active_frame_mask: value.active_frame_mask,
                beat_frames: value.beat_frames,
                estimated_reference_hz: value.estimated_reference_hz,
                tuning_offset_cents: value.tuning_offset_cents,
            }
        }
    }

    fn synthetic_chord(
        sample_rate: u32,
        root_midi: Option<i32>,
        minor: bool,
        cents: f64,
        seconds: f64,
    ) -> Vec<f32> {
        let length = (f64::from(sample_rate) * seconds).round() as usize;
        let Some(root_midi) = root_midi else {
            return vec![0.0; length];
        };
        let intervals = if minor { [0, 3, 7] } else { [0, 4, 7] };
        (0..length)
            .map(|index| {
                intervals
                    .iter()
                    .enumerate()
                    .map(|(rank, interval)| {
                        let frequency = 440.0
                            * 2.0_f64.powf(
                                f64::from(root_midi + interval - 69) / 12.0 + cents / 1_200.0,
                            );
                        (2.0 * std::f64::consts::PI * frequency * index as f64
                            / f64::from(sample_rate))
                        .sin()
                            / (rank + 1) as f64
                    })
                    .sum::<f64>() as f32
                    * 0.25
            })
            .collect()
    }

    #[test]
    fn emits_six_case_general_analysis_oracle_when_requested() {
        let cases = [
            (
                "a_major_48k_detuned",
                48_000,
                Some(57),
                false,
                -31.4,
                3.0,
                1,
            ),
            ("c_major_44100", 44_100, Some(60), false, 0.0, 3.0, 1),
            ("a_minor_22050", 22_050, Some(57), true, 0.0, 3.0, 1),
            ("a_minor_48k_stereo", 48_000, Some(57), true, 0.0, 3.0, 2),
            ("silence_44100", 44_100, None, false, 0.0, 3.0, 1),
            (
                "very_short_c_major_44100",
                44_100,
                Some(60),
                false,
                0.0,
                0.08,
                1,
            ),
        ];
        let results = cases
            .into_iter()
            .map(
                |(fixture, sample_rate, root_midi, minor, cents, seconds, channels)| {
                    let features = extract_harmonic_features_from_audio(&DecodedAudio {
                        samples: synthetic_chord(sample_rate, root_midi, minor, cents, seconds),
                        sample_rate,
                        channels,
                    })
                    .unwrap();
                    let timeline = detect_chords(&features);
                    let (estimated_key, key_confidence) = estimate_key(&features, &timeline);
                    let (evidence_absent_key, evidence_absent_key_confidence) =
                        estimate_key(&features, &[]);
                    json!({
                        "fixture": fixture,
                        "chroma_cqt": features.chroma_cqt,
                        "chroma_cens": features.chroma_cens,
                        "active_chroma_mean": active_chroma_mean(&features),
                        "estimated_key": estimated_key,
                        "key_confidence": key_confidence,
                        "evidence_absent_key": evidence_absent_key,
                        "evidence_absent_key_confidence": evidence_absent_key_confidence,
                        "estimated_reference_hz": features.estimated_reference_hz,
                        "tuning_offset_cents": features.tuning_offset_cents,
                        "normalized_builtin_timeline": timeline,
                    })
                },
            )
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 6);
        if let Some(path) = std::env::var_os("TUNEFORGE_ANDROID_ANALYSIS_OUTPUT") {
            std::fs::write(
                path,
                serde_json::to_vec_pretty(&json!({ "cases": results })).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn emits_real_file_general_analysis_when_requested() {
        let Ok(audio_path) = std::env::var("TUNEFORGE_CREMA_REAL_AUDIO_INPUT") else {
            return;
        };
        let audio = read_mobile_audio(Path::new(&audio_path)).unwrap();
        let features = extract_harmonic_features_from_audio(&audio).unwrap();
        let timeline = detect_chords(&features);
        let (estimated_key, key_confidence) = estimate_key(&features, &timeline);
        let (evidence_absent_key, evidence_absent_key_confidence) = estimate_key(&features, &[]);
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        std::fs::create_dir_all(&output_root).unwrap();
        std::fs::write(
            output_root.join("native-features-frame-major.json"),
            serde_json::to_vec_pretty(&json!({
                "duration_seconds": features.duration_seconds,
                "chroma_cqt": features.chroma_cqt,
                "chroma_cens": features.chroma_cens,
                "rms": features.rms,
                "active_frame_mask": features.active_frame_mask,
                "beat_frames": features.beat_frames,
                "estimated_reference_hz": features.estimated_reference_hz,
                "tuning_offset_cents": features.tuning_offset_cents,
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            output_root.join("native-general-analysis.json"),
            serde_json::to_vec_pretty(&json!({
                "active_chroma_mean": active_chroma_mean(&features),
                "beat_frames": features.beat_frames,
                "estimated_key": estimated_key,
                "key_confidence": key_confidence,
                "evidence_absent_key": evidence_absent_key,
                "evidence_absent_key_confidence": evidence_absent_key_confidence,
                "estimated_reference_hz": features.estimated_reference_hz,
                "tuning_offset_cents": features.tuning_offset_cents,
                "normalized_builtin_timeline": timeline,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn classifies_desktop_feature_fixture_when_requested() {
        let Ok(input_path) = std::env::var("TUNEFORGE_DESKTOP_FEATURES_INPUT") else {
            return;
        };
        let fixture: HarmonicFeaturesFixture =
            serde_json::from_slice(&std::fs::read(input_path).unwrap()).unwrap();
        let features = HarmonicFeatures::from(fixture);
        assert_eq!(features.chroma_cqt.len(), features.chroma_cens.len());
        assert_eq!(features.chroma_cqt.len(), features.rms.len());
        assert_eq!(features.chroma_cqt.len(), features.active_frame_mask.len());

        let chroma = combined_chroma(&features);
        let templates = templates();
        let peak = features.rms.iter().copied().fold(0.0_f64, f64::max);
        let boundaries = window_boundaries(&features, chroma.len());
        let observations = boundaries
            .windows(2)
            .map(|boundary| {
                let (start, end) = (boundary[0], boundary[1]);
                let vector = weighted_chroma(&features, &chroma, start, end);
                let energy =
                    features.rms[start..end].iter().sum::<f64>() / (end - start).max(1) as f64;
                let relative_energy = if peak > 0.0 {
                    (energy / peak).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                Observation {
                    start,
                    end,
                    chroma: vector,
                    scores: template_scores(&templates, &vector, relative_energy),
                }
            })
            .collect::<Vec<_>>();
        let path = smooth_path(&templates, &observations);
        let timeline = detect_chords(&features);
        let (estimated_key, key_confidence) = estimate_key(&features, &timeline);
        let (evidence_absent_key, evidence_absent_key_confidence) = estimate_key(&features, &[]);
        let diagnostic_observations = observations
            .iter()
            .map(|observation| {
                json!({
                    "start": observation.start,
                    "end": observation.end,
                    "chroma": observation.chroma,
                    "scores": observation.scores,
                })
            })
            .collect::<Vec<_>>();
        let path_labels = path
            .iter()
            .map(|state| {
                templates.get(*state).map_or_else(
                    || "N.C.".to_string(),
                    |template| builtin_chord_label(template.pitch, template.quality),
                )
            })
            .collect::<Vec<_>>();
        let output_root = crate::native_audio::test_support::analysis_diagnostics_dir();
        std::fs::create_dir_all(&output_root).unwrap();
        std::fs::write(
            output_root.join("native-from-desktop-features.json"),
            serde_json::to_vec_pretty(&json!({
                "window_boundaries": boundaries,
                "observations": diagnostic_observations,
                "path": path,
                "path_labels": path_labels,
                "estimated_key": estimated_key,
                "key_confidence": key_confidence,
                "evidence_absent_key": evidence_absent_key,
                "evidence_absent_key_confidence": evidence_absent_key_confidence,
                "normalized_builtin_timeline": timeline,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn desktop_feature_fixture_dto_accepts_required_frame_major_fields() {
        let fixture: HarmonicFeaturesFixture = serde_json::from_value(json!({
            "duration_seconds": 0.5,
            "chroma_cqt": vec![[0.0; 12]],
            "chroma_cens": vec![[0.0; 12]],
            "rms": [0.1],
            "active_frame_mask": [true],
            "beat_frames": [0],
            "estimated_reference_hz": 440.0,
            "tuning_offset_cents": 0.0,
        }))
        .unwrap();
        let features = HarmonicFeatures::from(fixture);
        assert_eq!(features.chroma_cqt.len(), 1);
        assert_eq!(features.chroma_cens.len(), 1);
        assert_eq!(features.rms, vec![0.1]);
        assert_eq!(features.active_frame_mask, vec![true]);
    }

    #[test]
    fn key_scoring_matches_desktop_profile_and_relative_confidence_oracles() {
        let major = [
            0.540557, 0.189732, 0.296315, 0.198240, 0.372784, 0.348101, 0.214583, 0.441739,
            0.203343, 0.311503, 0.194824, 0.245069,
        ];
        assert_eq!(
            estimate_key_from_chroma_and_chords(&major, &[]),
            (Some("C major".to_string()), Some(0.96))
        );
        let minor = [
            0.536422, 0.227117, 0.298286, 0.455977, 0.220270, 0.299134, 0.215195, 0.402531,
            0.337294, 0.227965, 0.283061, 0.268653,
        ];
        assert_eq!(
            estimate_key_from_chroma_and_chords(&minor, &[]).0,
            Some("C minor".to_string())
        );
    }

    #[test]
    fn beat_aligned_windows_match_desktop_chord_evidence_and_key_confidence() {
        let roots = [4, 2, 2, 4, 2, 0, 0, 11, 5, 9, 5, 0, 7, 5, 9, 9, 4, 11, 4, 2];
        let mut source_chroma = vec![[0.0_f32; 12]; 260];
        for (index, root) in roots.into_iter().enumerate() {
            for (interval, weight) in [(0, 1.0_f32), (4, 0.88_f32), (7, 0.76_f32)] {
                for frame in index * 13..(index + 1) * 13 {
                    source_chroma[frame][(root + interval) % 12] = weight;
                }
            }
        }
        for frame in &mut source_chroma {
            let norm = frame.iter().map(|value| value * value).sum::<f32>().sqrt();
            for value in frame {
                *value /= norm;
            }
        }
        let chroma = source_chroma
            .into_iter()
            .map(|frame| frame.map(f64::from))
            .collect::<Vec<_>>();
        let features = HarmonicFeatures {
            duration_seconds: 260.0 * ANALYSIS_HOP_LENGTH as f64 / ANALYSIS_SAMPLE_RATE as f64,
            chroma_cqt: chroma.clone(),
            chroma_cens: chroma,
            rms: vec![1.0; 260],
            active_frame_mask: vec![true; 260],
            beat_frames: (0..260).step_by(13).collect(),
            estimated_reference_hz: Some(440.0),
            tuning_offset_cents: Some(0.0),
        };
        assert_eq!(
            window_boundaries(&features, 260),
            vec![0, 26, 52, 78, 104, 130, 156, 182, 208, 234, 260]
        );
        let timeline = detect_chords(&features);
        assert_eq!(timeline.len(), 5, "{timeline:?}");
        assert_eq!(
            estimate_key(&features, &timeline),
            (Some("A minor".to_string()), Some(0.732)),
            "{timeline:?}"
        );

        let mut fixed_features = features;
        fixed_features.beat_frames.clear();
        assert_eq!(
            window_boundaries(&fixed_features, 260),
            vec![0, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240, 260]
        );
        let fixed_timeline = detect_chords(&fixed_features);
        assert_eq!(fixed_timeline.len(), 8, "{fixed_timeline:?}");
        assert_eq!(
            estimate_key(&fixed_features, &fixed_timeline),
            (Some("A minor".to_string()), Some(0.403))
        );
    }

    #[test]
    fn adjacent_and_blip_merges_match_desktop_boundary_first_confidence_order() {
        let adjacent = merge_adjacent(vec![
            json!({"start_seconds":0.0,"end_seconds":1.0,"label":"C","confidence":0.2}),
            json!({"start_seconds":1.0,"end_seconds":3.0,"label":"C","confidence":0.8}),
        ]);
        assert_eq!(adjacent.len(), 1);
        assert_eq!(adjacent[0]["end_seconds"], 3.0);
        assert_eq!(adjacent[0]["confidence"], 0.44);

        let blip = merge_low_confidence_blips(vec![
            json!({"start_seconds":0.0,"end_seconds":1.0,"label":"C","confidence":0.8}),
            json!({"start_seconds":1.0,"end_seconds":1.2,"label":"D","confidence":0.2}),
            json!({"start_seconds":1.2,"end_seconds":3.0,"label":"C","confidence":0.6}),
        ]);
        assert_eq!(blip.len(), 1);
        assert_eq!(blip[0]["end_seconds"], 3.0);
        assert_eq!(blip[0]["confidence"], 0.671);
    }

    #[test]
    fn equal_scores_use_desktop_first_argmax_semantics() {
        assert_eq!(first_max_index_f32(&[0.2, 0.8, 0.8, 0.1]), Some(1));
        assert_eq!(
            first_max_pair_f64([(0, 0.2), (1, 0.8), (2, 0.8), (3, 0.1)]),
            Some((1, 0.8))
        );

        let templates = vec![
            Template {
                pitch: 0,
                quality: "major",
                vector: [0.0; 12],
                complexity: 0.0,
            },
            Template {
                pitch: 0,
                quality: "minor",
                vector: [0.0; 12],
                complexity: 0.0,
            },
        ];
        let observations = vec![Observation {
            start: 0,
            end: 1,
            chroma: [0.0; 12],
            scores: vec![0.2, 0.2, -1.0],
        }];
        assert_eq!(smooth_path(&templates, &observations), vec![0]);
    }

    #[test]
    fn built_in_labels_keep_compact_dual_spelling() {
        assert_eq!(builtin_chord_label(1, "major"), "C#/Db");
        assert_eq!(builtin_chord_label(1, "minor"), "C#/Dbm");
    }

    #[test]
    fn synthetic_a_major_matches_desktop_key_and_builtin_timeline() {
        let sample_rate = 48_000;
        let cents = -31.4;
        let samples = (0..sample_rate * 3)
            .map(|index| {
                [0, 4, 7]
                    .iter()
                    .enumerate()
                    .map(|(rank, interval)| {
                        let frequency = 440.0
                            * 2.0_f64.powf(((57 + interval - 69) as f64) / 12.0 + cents / 1_200.0);
                        ((2.0 * std::f64::consts::PI * frequency * index as f64
                            / sample_rate as f64)
                            .sin()
                            / (rank + 1) as f64) as f32
                    })
                    .sum::<f32>()
                    * 0.25
            })
            .collect();
        let features = extract_harmonic_features_from_audio(&DecodedAudio {
            samples,
            sample_rate,
            channels: 1,
        })
        .unwrap();
        let timeline = detect_chords(&features);
        assert_eq!(timeline.len(), 1, "{timeline:?}");
        assert_eq!(timeline[0]["label"], "A", "{timeline:?}");
        assert_eq!(
            estimate_key(&features, &timeline),
            (Some("A major".to_string()), Some(0.744))
        );
        assert_eq!(timeline[0]["confidence"], 0.512, "{timeline:?}");
    }
}
