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

    Ok(MobileAudioFeatures {
        duration_seconds: audio.samples.len() as f64 / audio.sample_rate as f64,
        sample_rate: audio.sample_rate as i64,
        channels: audio.channels as i64,
        pitch_classes: pitch_class_energy(&samples, audio.sample_rate as f64),
    })
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
        "estimated_reference_hz": Value::Null,
        "tuning_offset_cents": Value::Null,
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
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?6)
             ON CONFLICT(project_id) DO UPDATE SET source_artifact_id = excluded.source_artifact_id, estimated_key = excluded.estimated_key, key_confidence = excluded.key_confidence, estimated_reference_hz = excluded.estimated_reference_hz, tuning_offset_cents = excluded.tuning_offset_cents, tempo_bpm = excluded.tempo_bpm, timing_json = excluded.timing_json, analysis_version = excluded.analysis_version, created_at = excluded.created_at",
            params![
                project.id,
                source_artifact.id,
                estimated_key,
                key_confidence,
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
    let _ = payload;
    let connection = db(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    Ok(JobResponse {
        job: create_failed_job(
            &connection,
            &project_id,
            "preview",
            "Android MediaCodec preview export is not wired yet.",
        )?,
    })
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
    let _ = payload;
    let connection = db(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    Ok(JobResponse {
        job: create_failed_job(
            &connection,
            &project_id,
            "retune",
            "Android MediaCodec retune export is not wired yet.",
        )?,
    })
}

pub fn mobile_submit_transpose(
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
            "transpose",
            "Android MediaCodec transpose export is not wired yet.",
        )?,
    })
}
