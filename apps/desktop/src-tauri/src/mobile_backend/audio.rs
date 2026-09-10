use super::storage_cleanup::{
    capture_owned_project_file, cleanup_owned_project_files, move_owned_project_file,
    prepare_owned_project_file, project_storage_mutation_guard,
};
use super::*;

struct MobileAudioFeatures {
    duration_seconds: f64,
    sample_rate: i64,
    channels: i64,
    pitch_classes: [f64; 12],
    estimated_reference_hz: Option<f64>,
    tuning_offset_cents: Option<f64>,
}

fn read_audio_features(path: &Path) -> Result<MobileAudioFeatures, String> {
    const MAX_ANALYSIS_SECONDS: usize = 30;
    let audio = read_mobile_audio(path)?;
    if audio.sample_rate == 0 || audio.channels == 0 {
        return Err("Decoded audio contained invalid stream metadata.".to_string());
    }
    if audio.samples.is_empty() {
        return Err("Decoded audio contained no samples.".to_string());
    }

    let max_samples = audio
        .samples
        .len()
        .min(audio.sample_rate as usize * MAX_ANALYSIS_SECONDS);
    let samples = audio.samples[..max_samples]
        .iter()
        .map(|sample| *sample as f64)
        .collect::<Vec<_>>();

    let tuning_offset_cents = estimate_tuning_offset_cents(&samples, audio.sample_rate as f64);
    Ok(MobileAudioFeatures {
        duration_seconds: audio.samples.len() as f64 / audio.sample_rate as f64,
        sample_rate: audio.sample_rate as i64,
        channels: audio.channels as i64,
        pitch_classes: pitch_class_energy(&samples, audio.sample_rate as f64),
        estimated_reference_hz: tuning_offset_cents
            .map(|cents| 440.0 * 2.0_f64.powf(cents / 1200.0)),
        tuning_offset_cents,
    })
}

fn estimate_tuning_offset_cents(samples: &[f64], sample_rate: f64) -> Option<f64> {
    const WINDOW_SAMPLES: usize = 4096;
    const WINDOW_COUNT: usize = 3;
    const MIN_RMS: f64 = 1.0e-5;
    const MIN_MIDI: i32 = 36;
    const MAX_MIDI: i32 = 84;
    const STEP_CENTS: i32 = 2;

    if !sample_rate.is_finite() || sample_rate <= 0.0 || samples.len() < WINDOW_SAMPLES {
        return None;
    }
    let mean_square =
        samples.iter().map(|sample| sample * sample).sum::<f64>() / samples.len() as f64;
    if !mean_square.is_finite() || mean_square.sqrt() < MIN_RMS {
        return None;
    }

    let last_start = samples.len() - WINDOW_SAMPLES;
    let starts = (0..WINDOW_COUNT)
        .map(|index| index * last_start / (WINDOW_COUNT - 1))
        .collect::<Vec<_>>();
    let offsets = (-50..=50).step_by(STEP_CENTS as usize).collect::<Vec<_>>();
    let mut scores = vec![0.0; offsets.len()];
    for (offset_index, offset_cents) in offsets.iter().enumerate() {
        for midi_note in MIN_MIDI..=MAX_MIDI {
            let frequency = 440.0
                * 2.0_f64
                    .powf((f64::from(midi_note) - 69.0 + f64::from(*offset_cents) / 100.0) / 12.0);
            if frequency >= sample_rate * 0.48 {
                continue;
            }
            let coefficient = 2.0 * (2.0 * std::f64::consts::PI * frequency / sample_rate).cos();
            for start in &starts {
                let mut q1 = 0.0;
                let mut q2 = 0.0;
                for (index, sample) in samples[*start..*start + WINDOW_SAMPLES].iter().enumerate() {
                    let phase =
                        2.0 * std::f64::consts::PI * index as f64 / (WINDOW_SAMPLES - 1) as f64;
                    let windowed = sample * (0.5 - 0.5 * phase.cos());
                    let q0 = coefficient * q1 - q2 + windowed;
                    q2 = q1;
                    q1 = q0;
                }
                scores[offset_index] += (q1 * q1 + q2 * q2 - coefficient * q1 * q2).max(0.0);
            }
        }
    }

    let best_index = scores
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))?
        .0;
    if scores[best_index] <= 0.0 {
        return None;
    }
    let mut cents = f64::from(offsets[best_index]);
    if best_index > 0 && best_index + 1 < scores.len() {
        let left = scores[best_index - 1].ln_1p();
        let center = scores[best_index].ln_1p();
        let right = scores[best_index + 1].ln_1p();
        let denominator = left - 2.0 * center + right;
        if denominator.abs() > f64::EPSILON {
            cents += 0.5 * (left - right) / denominator * f64::from(STEP_CENTS);
        }
    }
    cents.is_finite().then_some(cents.clamp(-50.0, 50.0))
}

fn install_playback_proxy(
    connection: &Connection,
    root: &Path,
    project_root: &Path,
    source_path: &Path,
    artifact_id: &str,
) -> Result<Option<PathBuf>, String> {
    let format = source_format(source_path);
    if !matches!(format.as_str(), "webm" | "mkv" | "mka") {
        return Ok(None);
    }

    let playback_dir = project_root.join("playback");
    let playback_path = playback_dir.join("source-playback.wav");
    let decoded = if playback_path.is_file() {
        None
    } else {
        let audio = match read_mobile_audio(source_path) {
            Ok(audio) if !audio.samples.is_empty() && audio.sample_rate != 0 => audio,
            _ => return Ok(None),
        };
        Some(audio)
    };

    let _storage_guard = project_storage_mutation_guard();
    let playback_path = prepare_owned_project_file(root, project_root, &playback_path)?;
    let pending = if playback_path.is_file() {
        None
    } else {
        let Some(audio) = decoded else {
            return Ok(None);
        };
        let temporary_path = playback_dir.join(format!(".{}.wav", new_id("playback")));
        let temporary_path = prepare_owned_project_file(root, project_root, &temporary_path)?;
        if write_mono_pcm_wav(&temporary_path, &audio).is_err() {
            if let Ok(file) = capture_owned_project_file(root, project_root, &temporary_path) {
                cleanup_owned_project_files(std::slice::from_ref(&file));
            }
            return Ok(None);
        }
        Some(capture_owned_project_file(
            root,
            project_root,
            &temporary_path,
        )?)
    };

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let mut published = None;
    let publish_result = (|| -> Result<(), String> {
        attach_playback_proxy_metadata(connection, artifact_id, &playback_path)?;
        if let Some(pending) = &pending {
            published = Some(move_owned_project_file(pending, &playback_path)?);
        }
        Ok(())
    })();
    if let Err(message) = publish_result {
        let _ = connection.execute_batch("ROLLBACK");
        if let Some(published) = published.as_ref() {
            cleanup_owned_project_files(std::slice::from_ref(published));
        }
        if let Some(pending) = pending.as_ref() {
            cleanup_owned_project_files(std::slice::from_ref(pending));
        }
        return Err(message);
    }
    if let Err(error) = connection.execute_batch("COMMIT") {
        let _ = connection.execute_batch("ROLLBACK");
        if let Some(published) = published.as_ref() {
            cleanup_owned_project_files(std::slice::from_ref(published));
        }
        return Err(error.to_string());
    }
    Ok(Some(playback_path))
}

pub(super) fn spawn_playback_proxy_generation(
    root: PathBuf,
    project_root: PathBuf,
    source_path: PathBuf,
    artifact_id: String,
) {
    if !matches!(source_format(&source_path).as_str(), "webm" | "mkv" | "mka") {
        return;
    }

    thread::spawn(move || {
        let Ok(connection) = db_at_root(&root) else {
            return;
        };
        if let Ok(project_id) = connection.query_row(
            "SELECT project_id FROM artifacts WHERE id = ?1",
            params![artifact_id],
            |row| row.get::<_, String>(0),
        ) {
            if install_playback_proxy(
                &connection,
                &root,
                &project_root,
                &source_path,
                &artifact_id,
            )
            .is_ok_and(|path| path.is_some())
            {
                reconcile_project_storage_after_commit(&connection, &root, &project_id);
            }
        }
    });
}

fn attach_playback_proxy_metadata(
    connection: &Connection,
    artifact_id: &str,
    playback_path: &Path,
) -> Result<(), String> {
    let metadata_json: String = connection
        .query_row(
            "SELECT metadata_json FROM artifacts WHERE id = ?1",
            params![artifact_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut metadata = serde_json::from_str::<Value>(&metadata_json).unwrap_or_else(|_| json!({}));
    metadata["playback_path"] = json!(playback_path.to_string_lossy().into_owned());
    metadata["playback_format"] = json!("wav");
    metadata["playback_generated_by"] = json!("android-mediacodec");
    connection
        .execute(
            "UPDATE artifacts SET metadata_json = ?1 WHERE id = ?2",
            params![metadata.to_string(), artifact_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn ensure_source_playback_proxy_metadata(
    connection: &Connection,
    root: &Path,
    project_id: &str,
) -> Result<(), String> {
    let project = get_project_schema(connection, project_id)?;
    let source_artifact = get_source_artifact(connection, project_id)?;
    if source_artifact
        .metadata
        .get("playback_path")
        .and_then(Value::as_str)
        .is_some_and(|path| Path::new(path).is_file())
    {
        return Ok(());
    }

    let project_root = project_root_path(root, project_id)?;
    if install_playback_proxy(
        connection,
        root,
        &project_root,
        Path::new(&project.imported_path),
        &source_artifact.id,
    )?
    .is_some()
    {
        reconcile_project_storage_after_commit(connection, root, project_id);
    }
    Ok(())
}

fn pitch_class_energy(samples: &[f64], sample_rate: f64) -> [f64; 12] {
    let mut energies = [0.0; 12];
    if samples.is_empty() || sample_rate <= 0.0 {
        return energies;
    }

    for midi_note in 36..85 {
        let frequency = 440.0 * 2.0_f64.powf((midi_note as f64 - 69.0) / 12.0);
        let normalized = frequency / sample_rate;
        if normalized >= 0.5 {
            continue;
        }
        let coeff = 2.0 * (2.0 * std::f64::consts::PI * normalized).cos();
        let mut q1 = 0.0;
        let mut q2 = 0.0;
        for sample in samples {
            let q0 = coeff * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }
        let power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
        energies[(midi_note % 12) as usize] += power.max(0.0);
    }

    let total: f64 = energies.iter().sum();
    if total > 0.0 {
        for energy in &mut energies {
            *energy /= total;
        }
    }
    energies
}

fn estimate_key(pitch_classes: &[f64; 12]) -> (Option<String>, Option<f64>) {
    const MAJOR_PROFILE: [f64; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MINOR_PROFILE: [f64; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];
    let total: f64 = pitch_classes.iter().sum();
    if total <= 0.0 {
        return (None, None);
    }

    let mut scored_keys = Vec::with_capacity(24);
    for pitch_class in 0..12 {
        scored_keys.push((
            key_label(pitch_class, "major"),
            profile_score(pitch_classes, &MAJOR_PROFILE, pitch_class),
        ));
        scored_keys.push((
            key_label(pitch_class, "minor"),
            profile_score(pitch_classes, &MINOR_PROFILE, pitch_class),
        ));
    }
    scored_keys.sort_by(|left, right| right.1.total_cmp(&left.1));
    let best = scored_keys.first().cloned();
    let second = scored_keys.get(1).map(|(_, score)| *score).unwrap_or(0.0);
    if let Some((label, score)) = best {
        let confidence = ((score - second).abs() / (score.abs() + 1.0)).clamp(0.0, 1.0);
        return (Some(label), Some(confidence));
    }
    (None, None)
}

fn profile_score(pitch_classes: &[f64; 12], profile: &[f64; 12], root: usize) -> f64 {
    let mut score = 0.0;
    for pitch_class in 0..12 {
        score += pitch_classes[pitch_class] * profile[(pitch_class + 12 - root) % 12];
    }
    score
}

fn detect_basic_chord(features: &MobileAudioFeatures) -> Value {
    let mut best: Option<(usize, &'static str, f64)> = None;
    for pitch_class in 0..12 {
        let major = chord_score(&features.pitch_classes, pitch_class, &[0, 4, 7]);
        let minor = chord_score(&features.pitch_classes, pitch_class, &[0, 3, 7]);
        for (quality, score) in [("major", major), ("minor", minor)] {
            if best
                .map(|(_, _, best_score)| score > best_score)
                .unwrap_or(true)
            {
                best = Some((pitch_class, quality, score));
            }
        }
    }

    let end_seconds = features.duration_seconds.max(0.1);
    if let Some((pitch_class, quality, score)) = best {
        if score > 0.0 {
            return json!({
                "start_seconds": 0.0,
                "end_seconds": end_seconds,
                "label": chord_label(pitch_class, quality),
                "confidence": score.clamp(0.0, 1.0),
                "pitch_class": pitch_class,
                "quality": quality,
            });
        }
    }

    json!({
        "start_seconds": 0.0,
        "end_seconds": end_seconds,
        "label": "N.C.",
        "confidence": 0.0,
        "pitch_class": Value::Null,
        "quality": Value::Null,
    })
}

fn chord_score(pitch_classes: &[f64; 12], root: usize, intervals: &[usize; 3]) -> f64 {
    let chord_energy: f64 = intervals
        .iter()
        .map(|interval| pitch_classes[(root + interval) % 12])
        .sum();
    let root_energy = pitch_classes[root];
    (root_energy * 0.5 + chord_energy) / 1.5
}

fn key_label(pitch_class: usize, mode: &str) -> String {
    format!("{} {mode}", pitch_name(pitch_class))
}

fn chord_label(pitch_class: usize, quality: &str) -> String {
    if quality == "minor" {
        format!("{}m", pitch_name(pitch_class))
    } else {
        pitch_name(pitch_class).to_string()
    }
}

fn pitch_name(pitch_class: usize) -> &'static str {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
    ];
    NAMES[pitch_class % 12]
}

fn store_analysis_result(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    features: &MobileAudioFeatures,
) -> Result<Value, String> {
    let timestamp = now_iso();
    let (estimated_key, key_confidence) = estimate_key(&features.pitch_classes);
    let analysis_version = "mobile-cpu-v1";
    let analysis = json!({
        "project_id": project.id,
        "source_artifact_id": source_artifact.id,
        "estimated_key": estimated_key,
        "key_confidence": key_confidence,
        "estimated_reference_hz": features.estimated_reference_hz,
        "tuning_offset_cents": features.tuning_offset_cents,
        "tempo_bpm": Value::Null,
        "timing": Value::Null,
        "analysis_version": analysis_version,
        "created_at": timestamp,
    });

    connection
        .execute(
            "UPDATE projects SET duration_seconds = ?1, sample_rate = ?2, channels = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                features.duration_seconds,
                features.sample_rate,
                features.channels,
                timestamp,
                project.id,
            ],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO analysis_results (project_id, source_artifact_id, estimated_key, key_confidence, estimated_reference_hz, tuning_offset_cents, tempo_bpm, timing_json, analysis_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8)
             ON CONFLICT(project_id) DO UPDATE SET source_artifact_id = excluded.source_artifact_id, estimated_key = excluded.estimated_key, key_confidence = excluded.key_confidence, estimated_reference_hz = excluded.estimated_reference_hz, tuning_offset_cents = excluded.tuning_offset_cents, tempo_bpm = excluded.tempo_bpm, timing_json = excluded.timing_json, analysis_version = excluded.analysis_version, created_at = excluded.created_at",
            params![
                project.id,
                source_artifact.id,
                estimated_key,
                key_confidence,
                features.estimated_reference_hz,
                features.tuning_offset_cents,
                analysis_version,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;

    let analysis_dir = project_root_path(root, &project.id)?.join("analysis");
    fs::create_dir_all(&analysis_dir).map_err(|error| error.to_string())?;
    let analysis_path = analysis_dir.join("analysis.json");
    fs::write(
        &analysis_path,
        serde_json::to_vec_pretty(&analysis).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let size_bytes = fs::metadata(&analysis_path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    let content_sha256 = file_sha256(&analysis_path)?;
    connection
        .execute(
            "DELETE FROM artifacts WHERE project_id = ?1 AND type = 'analysis_json'",
            params![project.id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at)
             VALUES (?1, ?2, 'analysis_json', 'json', ?3, ?4, ?5, 'analysis', 0, 1, ?6, NULL, ?7)",
            params![
                new_artifact_id()?,
                project.id,
                analysis_path.to_string_lossy().into_owned(),
                content_sha256,
                size_bytes,
                json!({
                    "analysis_version": analysis_version,
                    "source_artifact_id": source_artifact.id,
                })
                .to_string(),
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(analysis)
}

pub(super) fn get_analysis_value(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<Value>, String> {
    connection
        .query_row(
            "SELECT project_id, source_artifact_id, estimated_key, key_confidence, estimated_reference_hz, tuning_offset_cents, tempo_bpm, timing_json, analysis_version, created_at FROM analysis_results WHERE project_id = ?1",
            params![project_id],
            |row| {
                let timing_raw: Option<String> = row.get(7)?;
                let timing = timing_raw
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                Ok(json!({
                    "project_id": row.get::<_, String>(0)?,
                    "source_artifact_id": row.get::<_, Option<String>>(1)?,
                    "estimated_key": row.get::<_, Option<String>>(2)?,
                    "key_confidence": row.get::<_, Option<f64>>(3)?,
                    "estimated_reference_hz": row.get::<_, Option<f64>>(4)?,
                    "tuning_offset_cents": row.get::<_, Option<f64>>(5)?,
                    "tempo_bpm": row.get::<_, Option<f64>>(6)?,
                    "timing": timing,
                    "analysis_version": row.get::<_, String>(8)?,
                    "created_at": row.get::<_, String>(9)?,
                }))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn store_chord_timeline(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    features: &MobileAudioFeatures,
) -> Result<ChordResponse, String> {
    let timestamp = now_iso();
    let timeline = vec![detect_basic_chord(features)];
    let timeline_json = serde_json::to_string(&timeline).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO chord_timelines (project_id, source_segments_json, segments_json, timeline_json, backend, source_artifact_id, source_kind, metadata_json, has_user_edits, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3, 'mobile-cpu-basic', ?4, 'generated', '{}', 0, ?5, ?5)
             ON CONFLICT(project_id) DO UPDATE SET source_segments_json = excluded.source_segments_json, segments_json = excluded.segments_json, timeline_json = excluded.timeline_json, backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, source_kind = excluded.source_kind, metadata_json = excluded.metadata_json, has_user_edits = excluded.has_user_edits, updated_at = excluded.updated_at",
            params![
                project.id,
                timeline_json,
                timeline_json,
                source_artifact.id,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;

    let chord_path = project_root_path(root, &project.id)?
        .join("analysis")
        .join("chords.json");
    if let Some(parent) = chord_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let response = ChordResponse {
        project_id: project.id.clone(),
        source_segments: timeline.clone(),
        timeline,
        backend: Some("mobile-cpu-basic".to_string()),
        source_artifact_id: Some(source_artifact.id.clone()),
        has_user_edits: false,
        source_kind: "generated".to_string(),
        metadata: json!({}),
        created_at: Some(timestamp.clone()),
        updated_at: Some(timestamp),
    };
    fs::write(
        chord_path,
        serde_json::to_vec_pretty(&response).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(response)
}

pub(super) fn get_chord_response(
    connection: &Connection,
    project_id: String,
) -> Result<ChordResponse, String> {
    connection
        .query_row(
            "SELECT project_id, source_segments_json, segments_json, timeline_json, backend, source_artifact_id, source_kind, metadata_json, has_user_edits, created_at, updated_at FROM chord_timelines WHERE project_id = ?1",
            params![project_id],
            |row| {
                let source_segments_raw: String = row.get(1)?;
                let segments_raw: String = row.get(2)?;
                let timeline_raw: String = row.get(3)?;
                let metadata_raw: String = row.get(7)?;
                let source_segments = serde_json::from_str(&source_segments_raw).unwrap_or_default();
                let mut timeline: Vec<Value> = serde_json::from_str(&segments_raw).unwrap_or_default();
                if timeline.is_empty() {
                    timeline = serde_json::from_str(&timeline_raw).unwrap_or_default();
                }
                Ok(ChordResponse {
                    project_id: row.get(0)?,
                    source_segments,
                    timeline,
                    backend: row.get(4)?,
                    source_artifact_id: row.get(5)?,
                    has_user_edits: row.get::<_, i64>(8)? != 0,
                    source_kind: row.get(6)?,
                    metadata: serde_json::from_str(&metadata_raw).unwrap_or_else(|_| json!({})),
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(Ok)
        .unwrap_or_else(|| Ok(empty_chords(project_id)))
}

fn empty_chords(project_id: String) -> ChordResponse {
    ChordResponse {
        project_id,
        source_segments: Vec::new(),
        timeline: Vec::new(),
        backend: None,
        source_artifact_id: None,
        has_user_edits: false,
        source_kind: "generated".to_string(),
        metadata: json!({}),
        created_at: None,
        updated_at: None,
    }
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct MobileRetunePayload {
    target_reference_hz: Option<f64>,
    target_cents_offset: Option<f64>,
    #[serde(default = "default_true")]
    preview_only: bool,
    #[serde(default = "default_wav_format")]
    output_format: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct MobileTransposePayload {
    semitones: i32,
    #[serde(default = "default_true")]
    preview_only: bool,
    #[serde(default = "default_wav_format")]
    output_format: String,
}

#[cfg(target_os = "android")]
fn retune_cents(
    payload: &MobileRetunePayload,
    source_reference_hz: Option<f64>,
) -> Result<f64, String> {
    match (payload.target_reference_hz, payload.target_cents_offset) {
        (Some(target), None) if target.is_finite() && target > 0.0 => {
            let source = source_reference_hz
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| {
                    "Analyze source tuning before retuning to a reference frequency.".to_string()
                })?;
            Ok(1200.0 * (target / source).log2())
        }
        (None, Some(cents)) if cents.is_finite() => Ok(cents),
        _ => Err(
            "Android retune requires exactly one finite target reference or cents offset."
                .to_string(),
        ),
    }
}

#[cfg(target_os = "android")]
fn stored_source_reference_hz(
    connection: &Connection,
    project_id: &str,
    source_artifact_id: &str,
) -> Result<Option<f64>, String> {
    connection
        .query_row(
            "SELECT estimated_reference_hz FROM analysis_results WHERE project_id = ?1 AND source_artifact_id = ?2",
            params![project_id, source_artifact_id],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|error| error.to_string())
}

fn cache_source_reference_tuning(
    connection: &Connection,
    project_id: &str,
    source_artifact_id: &str,
    reference_hz: f64,
    tuning_offset_cents: f64,
) -> Result<(), String> {
    let existing_source = connection
        .query_row(
            "SELECT source_artifact_id FROM analysis_results WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match existing_source {
        Some(Some(existing)) if existing == source_artifact_id => {
            connection.execute(
                "UPDATE analysis_results SET estimated_reference_hz = ?1, tuning_offset_cents = ?2 WHERE project_id = ?3 AND source_artifact_id = ?4",
                params![reference_hz, tuning_offset_cents, project_id, source_artifact_id],
            )
            .map_err(|error| error.to_string())?;
        }
        None => {
            connection.execute(
                "INSERT INTO analysis_results (project_id, source_artifact_id, estimated_reference_hz, tuning_offset_cents, analysis_version, created_at) VALUES (?1, ?2, ?3, ?4, 'mobile-tuning-v1', ?5)",
                params![project_id, source_artifact_id, reference_hz, tuning_offset_cents, now_iso()],
            )
            .map_err(|error| error.to_string())?;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn resolve_source_reference_hz(
    connection: &Connection,
    project: &ProjectSchema,
    source: &ArtifactSchema,
) -> Result<f64, String> {
    if let Some(reference) = stored_source_reference_hz(connection, &project.id, &source.id)?
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        return Ok(reference);
    }
    let features = read_audio_features(Path::new(&project.imported_path))?;
    let reference = features.estimated_reference_hz.ok_or_else(|| {
        "Source tuning could not be established from the selected audio.".to_string()
    })?;
    cache_source_reference_tuning(
        connection,
        &project.id,
        &source.id,
        reference,
        features.tuning_offset_cents.unwrap_or(0.0),
    )?;
    Ok(reference)
}

#[cfg(target_os = "android")]
fn update_transform_job(
    connection: &Connection,
    job_id: &str,
    status: &str,
    progress: i64,
    result_artifact_id: Option<&str>,
    error: Option<&str>,
    started: Instant,
) -> Result<bool, String> {
    let timestamp = now_iso();
    let completed = matches!(status, "completed" | "failed" | "cancelled");
    connection
        .execute(
            "UPDATE jobs SET status = ?1, progress = ?2, result_artifact_ids_json = ?3, error_message = ?4, completed_at = CASE WHEN ?5 THEN ?6 ELSE completed_at END, duration_seconds = CASE WHEN ?5 THEN ?7 ELSE duration_seconds END, updated_at = ?6 WHERE id = ?8 AND (cancel_requested = 0 OR ?1 = 'cancelled')",
            params![
                status,
                progress,
                result_artifact_id.map_or_else(|| json!([]), |id| json!([id])).to_string(),
                error,
                completed,
                timestamp,
                started.elapsed().as_secs_f64(),
                job_id,
            ],
        )
        .map(|updated| updated == 1)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn transform_cancel_requested(connection: &Connection, job_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT cancel_requested != 0 OR status = 'cancelled' FROM jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
struct MobileTransformPlan {
    job_type: &'static str,
    output_format: String,
    pitch_cents: f64,
    preview_only: bool,
    metadata: Value,
}

#[cfg(target_os = "android")]
fn run_transform_job(
    root: PathBuf,
    project_id: String,
    source_path: PathBuf,
    source_artifact_id: String,
    job_id: String,
    plan: MobileTransformPlan,
) -> Result<(), String> {
    let connection = db_at_root(&root)?;
    let started = Instant::now();
    let project_root = project_root_path(&root, &project_id)?;
    let output_dir = project_root.join(if plan.preview_only {
        "previews"
    } else {
        "exports"
    });
    let output_path = output_dir.join(format!("{}.{}", job_id, plan.output_format));
    let temporary_path = output_dir.join(format!(".{}.{}", job_id, plan.output_format));
    let temporary_path = prepare_owned_project_file(&root, &project_root, &temporary_path)?;
    let format = AudioOutputFormat::parse(&plan.output_format)?;
    let render_result = render_audio(
        &source_path,
        &temporary_path,
        format,
        plan.pitch_cents,
        &mut || transform_cancel_requested(&connection, &job_id).unwrap_or(true),
        &mut |progress| {
            let _ = connection.execute(
                "UPDATE jobs SET progress = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'running' AND cancel_requested = 0",
                params![i64::from(progress.clamp(5, 90)), now_iso(), job_id],
            );
        },
    )
    .and_then(|rendered| {
        probe_mobile_durable_audio(&temporary_path, &plan.output_format).map(|()| rendered)
    });
    let rendered = match render_result {
        Ok(rendered) => rendered,
        Err(message) => {
            let _ = fs::remove_file(&temporary_path);
            let cancelled = transform_cancel_requested(&connection, &job_id)?;
            let status = if cancelled { "cancelled" } else { "failed" };
            let error = (!cancelled).then_some(message.as_str());
            let _ = update_transform_job(&connection, &job_id, status, 0, None, error, started)?;
            return Ok(());
        }
    };
    let temporary = capture_owned_project_file(&root, &project_root, &temporary_path)?;

    let storage_guard = project_storage_mutation_guard();
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let mut published = None;
    let publish = (|| -> Result<String, String> {
        if transform_cancel_requested(&connection, &job_id)? {
            return Err("TRANSFORM_CANCELLED".to_string());
        }
        let current_source: String = connection
            .query_row(
                "SELECT path FROM artifacts WHERE id = ?1 AND project_id = ?2 AND type = 'source_audio'",
                params![source_artifact_id, project_id],
                |row| row.get(0),
            )
            .map_err(|_| "Transform source is no longer owned by this project.".to_string())?;
        if current_source != source_path.to_string_lossy() {
            return Err("Transform source changed before publication.".to_string());
        }
        published = Some(move_owned_project_file(&temporary, &output_path)?);
        let artifact_id = new_artifact_id()?;
        let timestamp = now_iso();
        let mut artifact_metadata = plan.metadata.clone();
        artifact_metadata["output_sample_rate"] = json!(rendered.sample_rate);
        artifact_metadata["output_channels"] = json!(rendered.channels);
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ffmpeg', 1, ?8, ?9, NULL, ?10)",
                params![
                    artifact_id,
                    project_id,
                    if plan.preview_only { "preview_mix" } else { "export_mix" },
                    plan.output_format,
                    output_path.to_string_lossy(),
                    file_sha256(&output_path)?,
                    fs::metadata(&output_path).map_err(|error| error.to_string())?.len() as i64,
                    plan.preview_only,
                    artifact_metadata.to_string(),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        if !update_transform_job(
            &connection,
            &job_id,
            "completed",
            100,
            Some(&artifact_id),
            None,
            started,
        )? {
            return Err("TRANSFORM_CANCELLED".to_string());
        }
        Ok(artifact_id)
    })();
    let committed = match publish {
        Ok(_artifact_id) => {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                if let Some(file) = published.as_ref() {
                    cleanup_owned_project_files(std::slice::from_ref(file));
                }
                return Err(error.to_string());
            }
            true
        }
        Err(message) => {
            let _ = connection.execute_batch("ROLLBACK");
            if let Some(file) = published.as_ref() {
                cleanup_owned_project_files(std::slice::from_ref(file));
            }
            cleanup_owned_project_files(std::slice::from_ref(&temporary));
            let cancelled = message == "TRANSFORM_CANCELLED";
            let _ = update_transform_job(
                &connection,
                &job_id,
                if cancelled { "cancelled" } else { "failed" },
                0,
                None,
                (!cancelled).then_some(message.as_str()),
                started,
            )?;
            false
        }
    };
    drop(storage_guard);
    if committed {
        reconcile_project_storage_after_commit(&connection, &root, &project_id);
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn submit_transform(
    app: AppHandle,
    project_id: String,
    plan: MobileTransformPlan,
) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let source = get_source_artifact(&connection, &project_id)?;
    let _ = AudioOutputFormat::parse(&plan.output_format)?;
    if !plan.pitch_cents.is_finite() || plan.pitch_cents.abs() > 4800.0 {
        return Err(
            "Android audio transform requires a finite shift within four octaves.".to_string(),
        );
    }
    if plan.job_type == "preview" && plan.pitch_cents == 0.0 {
        return Err("Android preview requires at least one non-zero transform.".to_string());
    }
    let job = create_running_job(
        &connection,
        &project_id,
        plan.job_type,
        Some(source.id.clone()),
    )?;
    let project_root = project_root_path(&root, &project_id)?;
    let staging_dir = project_root.join(if plan.preview_only {
        "previews"
    } else {
        "exports"
    });
    let staging_path = staging_dir.join(format!(".{}.{}", job.id, plan.output_format));
    register_job_staging_path(&connection, &job.id, &staging_path)?;
    let job_for_worker = job.clone();
    thread::spawn(move || {
        let failure_root = root.clone();
        let failure_job_id = job_for_worker.id.clone();
        if let Err(message) = run_transform_job(
            root,
            project_id,
            PathBuf::from(project.imported_path),
            source.id,
            job_for_worker.id,
            plan,
        ) {
            if let Ok(connection) = db_at_root(&failure_root) {
                let timestamp = now_iso();
                let _ = connection.execute(
                    "UPDATE jobs SET status = 'failed', progress = 0, error_message = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3 AND status IN ('pending', 'running')",
                    params![message, timestamp, failure_job_id],
                );
            }
        }
    });
    Ok(JobResponse { job })
}

pub fn mobile_submit_analyze(app: AppHandle, project_id: String) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let source_artifact = get_source_artifact(&connection, &project_id)?;
    let features = match read_audio_features(Path::new(&project.imported_path)) {
        Ok(features) => features,
        Err(message) => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "analyze", &message)?,
            });
        }
    };
    store_analysis_result(&connection, &root, &project, &source_artifact, &features)?;
    let job = create_completed_job(
        &connection,
        &project_id,
        "analyze",
        Some(source_artifact.id),
    )?;
    reconcile_project_storage_after_commit(&connection, &root, &project_id);
    Ok(JobResponse { job })
}

pub fn mobile_get_analysis(app: AppHandle, project_id: String) -> Result<AnalysisResponse, String> {
    let connection = db(&app)?;
    let _ = get_project_schema(&connection, &project_id)?;
    Ok(AnalysisResponse {
        analysis: get_analysis_value(&connection, &project_id)?,
    })
}

pub fn mobile_submit_chords(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    let _ = payload;
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let source_artifact = get_source_artifact(&connection, &project_id)?;
    let features = match read_audio_features(Path::new(&project.imported_path)) {
        Ok(features) => features,
        Err(message) => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "chords", &message)?,
            });
        }
    };
    store_chord_timeline(&connection, &root, &project, &source_artifact, &features)?;
    let job = create_completed_job(&connection, &project_id, "chords", Some(source_artifact.id))?;
    reconcile_project_storage_after_commit(&connection, &root, &project_id);
    Ok(JobResponse { job })
}

pub fn mobile_get_chords(app: AppHandle, project_id: String) -> Result<ChordResponse, String> {
    let connection = db(&app)?;
    let _ = get_project_schema(&connection, &project_id)?;
    get_chord_response(&connection, project_id)
}

pub fn mobile_submit_preview(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    #[cfg(target_os = "android")]
    {
        let output_format = match payload.get("output_format") {
            None => "wav".to_string(),
            Some(Value::String(format)) => format.clone(),
            Some(_) => return Err("Android preview output_format must be a string.".to_string()),
        };
        let mut cents = 0.0;
        if let Some(retune) = payload.get("retune") {
            let retune: MobileRetunePayload = serde_json::from_value(retune.clone())
                .map_err(|_| "Android preview received an invalid retune selection.".to_string())?;
            let source_reference = if retune.target_reference_hz.is_some() {
                let connection = db(&app)?;
                let project = require_sync_editable_project(&connection, &project_id)?;
                let source = get_source_artifact(&connection, &project_id)?;
                Some(resolve_source_reference_hz(&connection, &project, &source)?)
            } else {
                None
            };
            cents += retune_cents(&retune, source_reference)?;
        }
        if let Some(transpose) = payload.get("transpose") {
            cents += transpose
                .get("semitones")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    "Android preview received invalid transpose semitones.".to_string()
                })? as f64
                * 100.0;
        }
        return submit_transform(
            app,
            project_id,
            MobileTransformPlan {
                job_type: "preview",
                output_format,
                pitch_cents: cents,
                preview_only: true,
                metadata: payload,
            },
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = payload;
        let connection = db(&app)?;
        let _ = require_sync_editable_project(&connection, &project_id)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "preview",
                "Android FFmpeg preview is unavailable in host tests.",
            )?,
        })
    }
}

pub fn mobile_submit_stems(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    let _ = payload;
    let connection = db(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    Ok(JobResponse {
        job: create_failed_job(
            &connection,
            &project_id,
            "stems",
            generation_unavailable_message("stems"),
        )?,
    })
}

pub fn mobile_submit_retune(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    #[cfg(target_os = "android")]
    {
        let parsed: MobileRetunePayload = serde_json::from_value(payload.clone())
            .map_err(|_| "Android retune received an invalid request.".to_string())?;
        let connection = db(&app)?;
        let project = require_sync_editable_project(&connection, &project_id)?;
        let source = get_source_artifact(&connection, &project_id)?;
        let source_reference_hz = parsed
            .target_reference_hz
            .map(|_| resolve_source_reference_hz(&connection, &project, &source))
            .transpose()?;
        drop(connection);
        return submit_transform(
            app,
            project_id,
            MobileTransformPlan {
                job_type: "retune",
                output_format: parsed.output_format.clone(),
                pitch_cents: retune_cents(&parsed, source_reference_hz)?,
                preview_only: parsed.preview_only,
                metadata: payload,
            },
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = payload;
        let connection = db(&app)?;
        let _ = require_sync_editable_project(&connection, &project_id)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "retune",
                "Android FFmpeg retune is unavailable in host tests.",
            )?,
        })
    }
}

pub fn mobile_submit_transpose(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    #[cfg(target_os = "android")]
    {
        let parsed: MobileTransposePayload = serde_json::from_value(payload.clone())
            .map_err(|_| "Android transpose received an invalid request.".to_string())?;
        return submit_transform(
            app,
            project_id,
            MobileTransformPlan {
                job_type: "transpose",
                output_format: parsed.output_format.clone(),
                pitch_cents: f64::from(parsed.semitones) * 100.0,
                preview_only: parsed.preview_only,
                metadata: payload,
            },
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = payload;
        let connection = db(&app)?;
        let _ = require_sync_editable_project(&connection, &project_id)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "transpose",
                "Android FFmpeg transpose is unavailable in host tests.",
            )?,
        })
    }
}

#[cfg(test)]
mod tuning_tests {
    use super::{cache_source_reference_tuning, estimate_tuning_offset_cents};
    use crate::mobile_backend::{db_at_root, new_id, now_iso};
    use rusqlite::params;
    use std::fs;

    fn sine(frequency: f64, sample_rate: usize) -> Vec<f64> {
        (0..sample_rate * 2)
            .map(|index| {
                (2.0 * std::f64::consts::PI * frequency * index as f64 / sample_rate as f64).sin()
                    * 0.5
            })
            .collect()
    }

    fn tuned_chord_with_percussion(reference_hz: f64, sample_rate: usize) -> Vec<f64> {
        let tuning = reference_hz / 440.0;
        let frequencies = [261.625_565, 329.627_557, 391.995_436];
        let mut noise = 0x1234_5678_u32;
        (0..sample_rate * 2)
            .map(|index| {
                noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let harmonic = frequencies
                    .iter()
                    .map(|frequency| {
                        (2.0 * std::f64::consts::PI * frequency * tuning * index as f64
                            / sample_rate as f64)
                            .sin()
                    })
                    .sum::<f64>()
                    * 0.16;
                let click_phase = index % (sample_rate / 4);
                let click = if click_phase < 64 {
                    (1.0 - click_phase as f64 / 64.0) * 0.15
                } else {
                    0.0
                };
                let noise_sample = (f64::from(noise >> 8) / f64::from(1_u32 << 24) - 0.5) * 0.01;
                harmonic + click + noise_sample
            })
            .collect()
    }

    #[test]
    fn estimates_flat_reference_tuning() {
        let cents = estimate_tuning_offset_cents(&sine(432.0, 22_050), 22_050.0).unwrap();
        assert!((cents + 31.77).abs() < 3.0, "estimated {cents} cents");
    }

    #[test]
    fn estimates_standard_reference_tuning() {
        let cents = estimate_tuning_offset_cents(&sine(440.0, 22_050), 22_050.0).unwrap();
        assert!(cents.abs() < 3.0, "estimated {cents} cents");
    }

    #[test]
    fn rejects_silence_as_a_tuning_reference() {
        assert!(estimate_tuning_offset_cents(&vec![0.0; 22_050], 22_050.0).is_none());
    }

    #[test]
    fn estimates_polyphonic_reference_under_percussion_and_noise() {
        let audio = tuned_chord_with_percussion(432.0, 22_050);
        let cents = estimate_tuning_offset_cents(&audio, 22_050.0).unwrap();
        assert!((cents + 31.77).abs() < 4.0, "estimated {cents} cents");
    }

    #[test]
    fn tuning_cache_preserves_existing_analysis_fields_and_snapshot() {
        let root = std::env::temp_dir().join(format!("tuneforge-tuning-cache-{}", new_id("test")));
        fs::create_dir_all(root.join("projects/project/analysis")).unwrap();
        let analysis_path = root.join("projects/project/analysis/analysis.json");
        fs::write(
            &analysis_path,
            br#"{"tempo_bpm":123,"estimated_key":"D major"}"#,
        )
        .unwrap();
        let connection = db_at_root(&root).unwrap();
        let timestamp = now_iso();
        connection.execute(
            "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at) VALUES ('project', 'Test', 'source.wav', 'source.wav', 'local', ?1, ?1)",
            params![timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('source', 'project', 'source_audio', 'wav', 'source.wav', 1, 'import', 0, 0, '{}', ?1)",
            params![timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO analysis_results (project_id, source_artifact_id, estimated_key, key_confidence, tempo_bpm, timing_json, analysis_version, created_at) VALUES ('project', 'source', 'D major', 0.8, 123.0, '{\"beats\":[1]}', 'desktop-v4', ?1)",
            params![timestamp],
        ).unwrap();

        cache_source_reference_tuning(&connection, "project", "source", 432.0, -31.77).unwrap();
        let row = connection.query_row(
            "SELECT source_artifact_id, estimated_key, key_confidence, estimated_reference_hz, tuning_offset_cents, tempo_bpm, timing_json, analysis_version FROM analysis_results WHERE project_id = 'project'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?, row.get::<_, f64>(4)?, row.get::<_, f64>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?)),
        ).unwrap();
        assert_eq!(row.0, "source");
        assert_eq!(row.1, "D major");
        assert_eq!(row.2, 0.8);
        assert_eq!(row.3, 432.0);
        assert_eq!(row.4, -31.77);
        assert_eq!(row.5, 123.0);
        assert_eq!(row.6, "{\"beats\":[1]}");
        assert_eq!(row.7, "desktop-v4");
        assert_eq!(
            fs::read(&analysis_path).unwrap(),
            br#"{"tempo_bpm":123,"estimated_key":"D major"}"#
        );
        let _ = fs::remove_dir_all(root);
    }
}
