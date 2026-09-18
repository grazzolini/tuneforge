use super::storage_cleanup::{
    capture_owned_project_file, cleanup_owned_project_files, move_owned_project_file,
    prepare_owned_project_file, project_storage_mutation_guard,
};
use super::*;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock, Mutex,
};

static AUDIO_JOB_CANCELLATIONS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) struct AudioJobCancellation {
    job_id: String,
    token: Arc<AtomicBool>,
}

impl AudioJobCancellation {
    pub(super) fn begin(job_id: &str) -> Self {
        let mut cancellations = AUDIO_JOB_CANCELLATIONS.lock().unwrap();
        let token = cancellations
            .entry(job_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        Self {
            job_id: job_id.to_string(),
            token,
        }
    }

    pub(super) fn requested(&self) -> bool {
        self.token.load(Ordering::Relaxed)
    }

    pub(super) fn token(&self) -> Arc<AtomicBool> {
        self.token.clone()
    }
}

impl Drop for AudioJobCancellation {
    fn drop(&mut self) {
        AUDIO_JOB_CANCELLATIONS.lock().unwrap().remove(&self.job_id);
    }
}

pub(crate) fn request_audio_job_cancellation(job_id: &str) {
    AUDIO_JOB_CANCELLATIONS
        .lock()
        .unwrap()
        .entry(job_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::Relaxed);
}

struct MobileAudioFeatures {
    duration_seconds: f64,
    sample_rate: i64,
    channels: i64,
    estimated_reference_hz: Option<f64>,
    tuning_offset_cents: Option<f64>,
    harmony: crate::native_audio::harmonic_features::HarmonicFeatures,
}

fn read_audio_features(path: &Path) -> Result<MobileAudioFeatures, String> {
    read_audio_features_with_cancel(path, &|| false)
}

fn read_audio_features_with_cancel<F>(
    path: &Path,
    should_cancel: &F,
) -> Result<MobileAudioFeatures, String>
where
    F: Fn() -> bool,
{
    let audio = read_mobile_audio(path)?;
    if audio.sample_rate == 0 || audio.channels == 0 {
        return Err("Decoded audio contained invalid stream metadata.".to_string());
    }
    if audio.samples.is_empty() {
        return Err("Decoded audio contained no samples.".to_string());
    }

    if should_cancel() {
        return Err("AUDIO_ANALYSIS_CANCELLED".to_string());
    }
    let harmony =
        crate::native_audio::harmonic_features::extract_harmonic_features_from_audio_with_cancel(
            &audio,
            should_cancel,
        )?;
    Ok(MobileAudioFeatures {
        duration_seconds: audio.samples.len() as f64 / audio.sample_rate as f64,
        sample_rate: audio.sample_rate as i64,
        channels: audio.channels as i64,
        estimated_reference_hz: harmony.estimated_reference_hz,
        tuning_offset_cents: harmony.tuning_offset_cents,
        harmony,
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

fn beat_this_preprocessing_provenance() -> Value {
    json!({
        "id": "beat-this-logmel-chunk-v1",
        "resampler": {
            "library": "rubato",
            "version": "0.16.2",
            "method": "FftFixedInOut",
        },
        "sample_rate_hz": 22_050,
        "log_mel": {
            "version": 1,
            "fft_size": 1_024,
            "hop_length": 441,
            "mel_bins": 128,
            "mel_scale": "slaney",
            "min_hz": 30,
            "max_hz": 11_000,
            "magnitude": "log1p(1000*x)",
        },
        "chunking": {
            "version": 1,
            "frames": 1_500,
            "border_frames": 6,
            "last_chunk": "shifted",
            "overlap": "keep_first",
        },
    })
}

fn store_analysis_result(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    features: &MobileAudioFeatures,
    beat_result: Option<&crate::native_audio::beat_this::BeatThisResult>,
    beat_backend: &str,
    job_id: &str,
) -> Result<Value, String> {
    let timestamp = now_iso();
    let chord_evidence = crate::native_audio::builtin_harmony::detect_chords(&features.harmony);
    let (estimated_key, key_confidence) =
        crate::native_audio::builtin_harmony::estimate_key(&features.harmony, &chord_evidence);
    let analysis_version = if beat_result.is_some() {
        "mobile-beat-this-et14-v1"
    } else {
        "mobile-basic-v2"
    };
    let tempo_bpm = beat_result.map(|result| result.tempo_bpm);
    let timing = beat_result.map(|result| result.timing.clone());
    let preprocessing = beat_result
        .map(|_| beat_this_preprocessing_provenance())
        .unwrap_or(Value::Null);
    let analysis = json!({
        "project_id": project.id,
        "source_artifact_id": source_artifact.id,
        "estimated_key": estimated_key,
        "key_confidence": key_confidence,
        "estimated_reference_hz": features.estimated_reference_hz,
        "tuning_offset_cents": features.tuning_offset_cents,
        "tempo_bpm": tempo_bpm,
        "timing": timing,
        "analysis_version": analysis_version,
        "preprocessing": preprocessing.clone(),
        "created_at": timestamp,
    });

    let _storage_guard = project_storage_mutation_guard();
    let analysis_dir = project_root_path(root, &project.id)?.join("analysis");
    fs::create_dir_all(&analysis_dir).map_err(|error| error.to_string())?;
    let temporary_path = analysis_dir.join(format!(".{job_id}.json.tmp"));
    let analysis_path = analysis_dir.join(format!("{job_id}.json"));
    let bytes = serde_json::to_vec_pretty(&analysis).map_err(|error| error.to_string())?;
    let mut temporary = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary.sync_all().map_err(|error| error.to_string())?;
    drop(temporary);
    fs::rename(&temporary_path, &analysis_path).map_err(|error| error.to_string())?;
    let size_bytes = bytes.len() as i64;
    let content_sha256 = match file_sha256(&analysis_path) {
        Ok(hash) => hash,
        Err(message) => {
            let _ = fs::remove_file(&analysis_path);
            return Err(message);
        }
    };

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let publish = (|| -> Result<(), String> {
        let current_source: String = connection.query_row(
            "SELECT path FROM artifacts WHERE id = ?1 AND project_id = ?2 AND type = 'source_audio'",
            params![source_artifact.id, project.id],
            |row| row.get(0),
        ).map_err(|_| "Analysis source changed before publication.".to_string())?;
        if current_source != project.imported_path {
            return Err("Analysis source changed before publication.".to_string());
        }
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM jobs WHERE id = ?1 AND status = 'running' AND cancel_requested = 0",
            params![job_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if active != 1 {
            return Err("ANALYSIS_CANCELLED".to_string());
        }
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
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(project_id) DO UPDATE SET source_artifact_id = excluded.source_artifact_id, estimated_key = excluded.estimated_key, key_confidence = excluded.key_confidence, estimated_reference_hz = excluded.estimated_reference_hz, tuning_offset_cents = excluded.tuning_offset_cents, tempo_bpm = excluded.tempo_bpm, timing_json = excluded.timing_json, analysis_version = excluded.analysis_version, created_at = excluded.created_at",
            params![
                project.id,
                source_artifact.id,
                estimated_key,
                key_confidence,
                features.estimated_reference_hz,
                features.tuning_offset_cents,
                tempo_bpm,
                timing.as_ref().map(Value::to_string),
                analysis_version,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
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
                    "beat_backend": beat_backend,
                    "runtime": if beat_result.is_some() { "executorch-1.4.0-xnnpack" } else { "native-cpu" },
                    "model_revision": if beat_result.is_some() { Value::String("895b249c4ccabaedc0770b12935c2b7b2f60e145".to_string()) } else { Value::Null },
                    "model_sha256": if beat_result.is_some() { Value::String("03b512e135edeb4f4644a7f05fa13ae20ba676484997548f81118fec13d42293".to_string()) } else { Value::Null },
                    "preprocessing": preprocessing,
                })
                .to_string(),
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
        let payload_raw = connection
            .query_row(
                "SELECT payload_json FROM jobs WHERE id = ?1",
                params![job_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut payload = serde_json::from_str::<Value>(&payload_raw).unwrap_or_else(|_| json!({}));
        payload["stage"] = json!("complete");
        payload["stage_label"] = json!("Analysis complete");
        payload["runtime_detail"] = json!(if beat_result.is_some() {
            "ExecuTorch 1.4.0 XNNPACK"
        } else {
            "Native CPU"
        });
        let updated = connection.execute(
            "UPDATE jobs SET status = 'completed', progress = 100, payload_json = ?1, runtime_device = 'cpu', error_message = NULL, completed_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'running' AND cancel_requested = 0",
            params![payload.to_string(), now_iso(), job_id],
        ).map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("ANALYSIS_CANCELLED".to_string());
        }
        Ok(())
    })();
    match publish {
        Ok(()) => {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                let _ = fs::remove_file(&analysis_path);
                return Err(error.to_string());
            }
        }
        Err(message) => {
            let _ = connection.execute_batch("ROLLBACK");
            let _ = fs::remove_file(&analysis_path);
            return Err(message);
        }
    }
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

enum ChordStoreOutcome {
    Stored(ChordResponse),
    Preserved,
}

fn chord_snapshot_bytes(response: &ChordResponse) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(response).map_err(|error| error.to_string())
}

fn write_synced_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn repair_chord_snapshot(root: &Path, response: &ChordResponse) -> Result<(), String> {
    if response.created_at.is_none() {
        return Ok(());
    }
    let bytes = chord_snapshot_bytes(response)?;
    let _storage_guard = project_storage_mutation_guard();
    let analysis_dir = project_root_path(root, &response.project_id)?.join("analysis");
    fs::create_dir_all(&analysis_dir).map_err(|error| error.to_string())?;
    let chord_path = analysis_dir.join("chords.json");
    if fs::read(&chord_path).is_ok_and(|existing| existing == bytes) {
        return Ok(());
    }
    let temporary_path = analysis_dir.join(format!(".chords.repair.{}.tmp", new_id("snapshot")));
    write_synced_file(&temporary_path, &bytes)?;
    let result = fs::rename(&temporary_path, &chord_path).map_err(|error| error.to_string());
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn store_chord_timeline(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    timeline: Vec<Value>,
    backend: &str,
    metadata: Value,
    overwrite_user_edits: bool,
    runtime_detail: &str,
    duration_seconds: f64,
    job_id: &str,
) -> Result<ChordStoreOutcome, String> {
    let timestamp = now_iso();
    let timeline_json = serde_json::to_string(&timeline).map_err(|error| error.to_string())?;
    let created_at = connection
        .query_row(
            "SELECT created_at FROM chord_timelines WHERE project_id = ?1",
            params![project.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| timestamp.clone());
    let response = ChordResponse {
        project_id: project.id.clone(),
        source_segments: timeline.clone(),
        timeline,
        backend: Some(backend.to_string()),
        source_artifact_id: Some(source_artifact.id.clone()),
        has_user_edits: false,
        source_kind: "generated".to_string(),
        metadata,
        created_at: Some(created_at.clone()),
        updated_at: Some(timestamp.clone()),
    };
    let bytes = chord_snapshot_bytes(&response)?;
    let _storage_guard = project_storage_mutation_guard();
    let analysis_dir = project_root_path(root, &project.id)?.join("analysis");
    fs::create_dir_all(&analysis_dir).map_err(|error| error.to_string())?;
    let temporary_path = analysis_dir.join(format!(".chords.{job_id}.tmp"));
    let backup_path = analysis_dir.join(format!(".chords.{job_id}.backup"));
    let chord_path = analysis_dir.join("chords.json");
    write_synced_file(&temporary_path, &bytes)?;

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let mut backed_up = false;
    let mut published = false;
    let publish = (|| -> Result<ChordStoreOutcome, String> {
        let current_source: (String, String) = connection.query_row(
            "SELECT artifacts.path, projects.imported_path FROM artifacts JOIN projects ON projects.id = artifacts.project_id WHERE artifacts.id = ?1 AND artifacts.project_id = ?2 AND artifacts.type = 'source_audio'",
            params![source_artifact.id, project.id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Chord source changed before publication.".to_string())?;
        if current_source.0 != source_artifact.path || current_source.1 != project.imported_path {
            return Err("Chord source changed before publication.".to_string());
        }
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM jobs WHERE id = ?1 AND status = 'running' AND cancel_requested = 0",
            params![job_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if active != 1 {
            return Err("CHORDS_CANCELLED".to_string());
        }
        let has_user_edits = connection
            .query_row(
                "SELECT has_user_edits != 0 FROM chord_timelines WHERE project_id = ?1",
                params![project.id],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        if has_user_edits && !overwrite_user_edits {
            let payload_raw = connection
                .query_row(
                    "SELECT payload_json FROM jobs WHERE id = ?1",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())?;
            let mut payload =
                serde_json::from_str::<Value>(&payload_raw).unwrap_or_else(|_| json!({}));
            payload["stage"] = json!("complete");
            payload["stage_label"] = json!("Existing chords preserved");
            payload["runtime_detail"] = json!("Existing saved timeline");
            let updated = connection.execute(
                "UPDATE jobs SET status = 'completed', progress = 100, payload_json = ?1, runtime_device = 'cpu', error_message = NULL, completed_at = ?2, duration_seconds = ?3, updated_at = ?2 WHERE id = ?4 AND status = 'running' AND cancel_requested = 0",
                params![payload.to_string(), timestamp, duration_seconds, job_id],
            ).map_err(|error| error.to_string())?;
            if updated != 1 {
                return Err("CHORDS_CANCELLED".to_string());
            }
            return Ok(ChordStoreOutcome::Preserved);
        }
        if chord_path.exists() {
            fs::rename(&chord_path, &backup_path).map_err(|error| error.to_string())?;
            backed_up = true;
        }
        fs::rename(&temporary_path, &chord_path).map_err(|error| error.to_string())?;
        published = true;
        connection.execute(
            "INSERT INTO chord_timelines (project_id, source_segments_json, segments_json, timeline_json, backend, source_artifact_id, source_kind, metadata_json, has_user_edits, created_at, updated_at)
             VALUES (?1, ?2, ?2, ?2, ?3, ?4, 'generated', ?5, 0, ?6, ?7)
             ON CONFLICT(project_id) DO UPDATE SET source_segments_json = excluded.source_segments_json, segments_json = excluded.segments_json, timeline_json = excluded.timeline_json, backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, source_kind = excluded.source_kind, metadata_json = excluded.metadata_json, has_user_edits = excluded.has_user_edits, updated_at = excluded.updated_at",
            params![project.id, timeline_json, backend, source_artifact.id,
                response.metadata.to_string(), created_at, timestamp],
        ).map_err(|error| error.to_string())?;
        let payload_raw = connection
            .query_row(
                "SELECT payload_json FROM jobs WHERE id = ?1",
                params![job_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut payload = serde_json::from_str::<Value>(&payload_raw).unwrap_or_else(|_| json!({}));
        payload["stage"] = json!("complete");
        payload["stage_label"] = json!("Chord generation complete");
        payload["runtime_detail"] = json!(runtime_detail);
        let updated = connection.execute(
            "UPDATE jobs SET status = 'completed', progress = 100, payload_json = ?1, runtime_device = 'cpu', error_message = NULL, completed_at = ?2, duration_seconds = ?3, updated_at = ?2 WHERE id = ?4 AND status = 'running' AND cancel_requested = 0",
            params![payload.to_string(), timestamp, duration_seconds, job_id],
        ).map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("CHORDS_CANCELLED".to_string());
        }
        Ok(ChordStoreOutcome::Stored(response))
    })();
    match publish {
        Ok(outcome) => {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                if published {
                    let _ = fs::remove_file(&chord_path);
                }
                if backed_up {
                    let _ = fs::rename(&backup_path, &chord_path);
                }
                let _ = fs::remove_file(&temporary_path);
                return Err(error.to_string());
            }
            let _ = fs::remove_file(&backup_path);
            let _ = fs::remove_file(&temporary_path);
            Ok(outcome)
        }
        Err(message) => {
            let _ = connection.execute_batch("ROLLBACK");
            if published {
                let _ = fs::remove_file(&chord_path);
            }
            if backed_up {
                let _ = fs::rename(&backup_path, &chord_path);
            }
            let _ = fs::remove_file(&temporary_path);
            Err(message)
        }
    }
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

fn analysis_cancel_requested(connection: &Connection, job_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT cancel_requested != 0 OR status = 'cancelled' FROM jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn resolve_mobile_chord_backend(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("default").trim() {
        "default" | "fast" | "tuneforge-fast" | "librosa" => Ok("tuneforge-fast"),
        "advanced" | "crema" | "crema-advanced" => Ok("crema-advanced"),
        _ => Err("Selected chord backend is unavailable on Android.".to_string()),
    }
}

fn existing_chords_should_be_preserved(
    connection: &Connection,
    project_id: &str,
    backend: &str,
    force: bool,
    overwrite_user_edits: bool,
) -> Result<bool, String> {
    let existing = connection.query_row(
        "SELECT backend, has_user_edits != 0, segments_json FROM chord_timelines WHERE project_id = ?1",
        params![project_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?, row.get::<_, String>(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((existing_backend, has_user_edits, segments)) = existing else {
        return Ok(false);
    };
    if has_user_edits && !overwrite_user_edits {
        return Ok(true);
    }
    let has_segments =
        serde_json::from_str::<Vec<Value>>(&segments).is_ok_and(|value| !value.is_empty());
    Ok(has_segments
        && !force
        && !overwrite_user_edits
        && existing_backend.as_deref() == Some(backend))
}

fn finish_preserved_chord_job(
    connection: &Connection,
    job_id: &str,
    backend: &str,
) -> Result<(), String> {
    let timestamp = now_iso();
    let payload = json!({
        "chord_backend": backend,
        "stage": "complete",
        "stage_label": "Existing chords preserved",
        "runtime_detail": "Existing saved timeline",
    });
    connection.execute(
        "UPDATE jobs SET status = 'completed', progress = 100, payload_json = ?1, runtime_device = 'cpu', error_message = NULL, completed_at = ?2, duration_seconds = 0, updated_at = ?2 WHERE id = ?3",
        params![payload.to_string(), timestamp, job_id],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn run_chord_job(
    root: PathBuf,
    job_id: String,
    project: ProjectSchema,
    source_artifact: ArtifactSchema,
    backend: String,
    overwrite_user_edits: bool,
) {
    let started = Instant::now();
    let connection = match db_at_root(&root) {
        Ok(connection) => connection,
        Err(_) => return,
    };
    let cancellation = AudioJobCancellation::begin(&job_id);
    let result = (|| -> Result<(), String> {
        let (timeline, metadata, runtime_detail) = if backend == "crema-advanced" {
            let status = crate::native_audio::crema::android_model_status();
            let (progress, stage, label) = match status.as_str() {
                "ready" => (15, "verifying", "Verifying Advanced Chords model"),
                "corrupt" => (
                    10,
                    "repairing",
                    "Repairing and verifying Advanced Chords model",
                ),
                _ => (
                    10,
                    "downloading",
                    "Installing and verifying Advanced Chords model",
                ),
            };
            update_job_stage(&connection, &job_id, progress, stage, label)?;
            let state_raw = crate::native_audio::crema::prepare_android_model(&job_id)?;
            if analysis_cancel_requested(&connection, &job_id)? {
                return Err("CHORDS_CANCELLED".to_string());
            }
            let state = crate::native_audio::crema::parse_runtime_state(&state_raw)?;
            update_job_stage(
                &connection,
                &job_id,
                35,
                "preparing",
                "Preparing Advanced Chords features",
            )?;
            let decoded = read_mobile_audio(Path::new(&project.imported_path))?;
            let (input, frames) =
                crate::native_audio::crema::preprocess_hcqt_with_cancel(&decoded, &state, &|| {
                    cancellation.requested()
                })?;
            if analysis_cancel_requested(&connection, &job_id)? {
                return Err("CHORDS_CANCELLED".to_string());
            }
            update_job_stage(
                &connection,
                &job_id,
                65,
                "analyzing",
                "Analyzing chords with Crema",
            )?;
            let outputs = crate::native_audio::crema::run_android_model(&input, frames, &job_id)?;
            if analysis_cancel_requested(&connection, &job_id)? {
                return Err("CHORDS_CANCELLED".to_string());
            }
            let timeline = crate::native_audio::crema::decode_outputs(&outputs, frames, &state)?;
            (
                timeline,
                json!({
                    "backend_id": "crema-advanced",
                    "implementation": "crema-onnx",
                    "model_name": "crema",
                    "model_version": "0.2.0",
                    "model_revision": "895b249c4ccabaedc0770b12935c2b7b2f60e145",
                    "model_sha256": "a903f9709821fccebb31d4e93d7d783642faaa90859f45f308c0f9131cc7ca59",
                    "runtime_state_sha256": "3744bf9ecb47de7194cb9f250fba26678ea347911af32ec4813645d5e033aca2",
                    "runtime": "onnxruntime-android-1.29.0",
                    "provider": "CPUExecutionProvider",
                    "runtime_device": "cpu",
                }),
                "ONNX Runtime 1.29.0 CPU",
            )
        } else {
            update_job_stage(
                &connection,
                &job_id,
                15,
                "preparing",
                "Preparing chord features",
            )?;
            let features =
                read_audio_features_with_cancel(Path::new(&project.imported_path), &|| {
                    cancellation.requested()
                })?;
            if analysis_cancel_requested(&connection, &job_id)? {
                return Err("CHORDS_CANCELLED".to_string());
            }
            update_job_stage(&connection, &job_id, 65, "analyzing", "Analyzing chords")?;
            let timeline = crate::native_audio::builtin_harmony::detect_chords(&features.harmony);
            (
                timeline,
                json!({
                    "backend_id": "tuneforge-fast",
                    "engine": "native-chroma-template-viterbi",
                    "analysis_version": "v2",
                    "runtime_device": "cpu",
                }),
                "Native CPU",
            )
        };
        if analysis_cancel_requested(&connection, &job_id)? {
            return Err("CHORDS_CANCELLED".to_string());
        }
        update_job_stage(&connection, &job_id, 90, "saving", "Saving chords")?;
        let outcome = store_chord_timeline(
            &connection,
            &root,
            &project,
            &source_artifact,
            timeline,
            &backend,
            metadata,
            overwrite_user_edits,
            runtime_detail,
            started.elapsed().as_secs_f64(),
            &job_id,
        )?;
        if matches!(outcome, ChordStoreOutcome::Preserved) {
            reconcile_project_storage_after_commit(&connection, &root, &project.id);
            return Ok(());
        }
        reconcile_project_storage_after_commit(&connection, &root, &project.id);
        Ok(())
    })();
    if let Err(message) = result {
        if message == "CHORDS_CANCELLED"
            || message == "AUDIO_ANALYSIS_CANCELLED"
            || message == "CREMA_CANCELLED"
            || analysis_cancel_requested(&connection, &job_id).unwrap_or(false)
        {
            crate::native_audio::crema::cancel_android_model(&job_id);
            let timestamp = now_iso();
            let _ = connection.execute(
                "UPDATE jobs SET status = 'cancelled', progress = 0, error_message = NULL, completed_at = ?1, duration_seconds = ?2, updated_at = ?1 WHERE id = ?3 AND status IN ('pending', 'running', 'cancelled')",
                params![timestamp, started.elapsed().as_secs_f64(), job_id],
            );
        } else {
            let failure = if backend == "crema-advanced"
                && !message.starts_with("ADVANCED_CHORD_BACKEND_FAILED")
            {
                crate::native_audio::crema::android_error(&message)
            } else {
                message
            };
            let _ = fail_running_job(
                &connection,
                &job_id,
                &failure,
                started.elapsed().as_secs_f64(),
            );
        }
    }
}

fn run_analysis_job(
    root: PathBuf,
    job_id: String,
    project: ProjectSchema,
    source_artifact: ArtifactSchema,
    beat_backend: String,
) {
    let started = Instant::now();
    let connection = match db_at_root(&root) {
        Ok(connection) => connection,
        Err(_) => return,
    };
    let cancellation = AudioJobCancellation::begin(&job_id);
    let result = (|| -> Result<(), String> {
        update_job_stage(&connection, &job_id, 10, "decoding", "Preparing audio")?;
        let features = read_audio_features_with_cancel(Path::new(&project.imported_path), &|| {
            cancellation.requested()
        })?;
        if analysis_cancel_requested(&connection, &job_id)? {
            return Err("ANALYSIS_CANCELLED".to_string());
        }
        let beat_result = if beat_backend == "beat-this" {
            update_job_stage(
                &connection,
                &job_id,
                25,
                "features",
                "Preparing Beat This features",
            )?;
            let decoded = read_mobile_audio(Path::new(&project.imported_path))?;
            let spectrogram = crate::native_audio::beat_this::log_mel_spectrogram(&decoded)
                .map_err(|message| format!("ADVANCED_BEAT_BACKEND_FAILED: {message}"))?;
            let model_status = crate::native_audio::beat_this::android_model_status();
            let label = match model_status.as_str() {
                "ready" => "Loading model and running Advanced Beat Analysis",
                "corrupt" => "Repairing, verifying, and running Advanced Beat Analysis",
                _ => "Preparing, verifying, and running Advanced Beat Analysis",
            };
            update_job_stage(&connection, &job_id, 45, "model", label)?;
            let (beat, downbeat) =
                crate::native_audio::beat_this::predict_chunks(&spectrogram, |input, frames| {
                    if analysis_cancel_requested(&connection, &job_id).unwrap_or(true) {
                        crate::native_audio::beat_this::cancel_android_model(&job_id);
                        return Err("ANALYSIS_CANCELLED".to_string());
                    }
                    crate::native_audio::beat_this::run_android_model(input, frames, &job_id)
                })?;
            Some(crate::native_audio::beat_this::postprocess_timing(
                &beat,
                &downbeat,
                features.duration_seconds,
            )?)
        } else {
            None
        };
        if analysis_cancel_requested(&connection, &job_id)? {
            return Err("ANALYSIS_CANCELLED".to_string());
        }
        update_job_stage(&connection, &job_id, 90, "saving", "Saving analysis")?;
        store_analysis_result(
            &connection,
            &root,
            &project,
            &source_artifact,
            &features,
            beat_result.as_ref(),
            &beat_backend,
            &job_id,
        )?;
        reconcile_project_storage_after_commit(&connection, &root, &project.id);
        Ok(())
    })();
    if let Err(message) = result {
        if message == "ANALYSIS_CANCELLED"
            || message == "AUDIO_ANALYSIS_CANCELLED"
            || analysis_cancel_requested(&connection, &job_id).unwrap_or(false)
        {
            let timestamp = now_iso();
            let _ = connection.execute(
                "UPDATE jobs SET status = 'cancelled', progress = 0, error_message = NULL, completed_at = ?1, duration_seconds = ?2, updated_at = ?1 WHERE id = ?3 AND status IN ('pending', 'running', 'cancelled')",
                params![timestamp, started.elapsed().as_secs_f64(), job_id],
            );
        } else {
            let failure = if beat_backend == "beat-this"
                && !message.starts_with("ADVANCED_BEAT_BACKEND_FAILED")
            {
                format!("ADVANCED_BEAT_BACKEND_FAILED: {message}")
            } else {
                message
            };
            let _ = fail_running_job(
                &connection,
                &job_id,
                &failure,
                started.elapsed().as_secs_f64(),
            );
        }
    }
}

pub fn mobile_submit_analyze(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let source_artifact = get_source_artifact(&connection, &project_id)?;
    let beat_backend = payload
        .get("beat_backend")
        .and_then(Value::as_str)
        .unwrap_or("beat-this")
        .to_string();
    if !matches!(beat_backend.as_str(), "built-in" | "beat-this") {
        return Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "analyze",
                "Selected beat backend is unavailable on Android.",
            )?,
        });
    }
    if let Some(job) = connection.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE project_id = ?1 AND type = 'analyze' AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1"),
        params![project_id],
        row_job,
    ).optional().map_err(|error| error.to_string())? {
        return Ok(JobResponse { job });
    };
    let mut job = create_running_job(
        &connection,
        &project_id,
        "analyze",
        Some(source_artifact.id.clone()),
    )?;
    let mut job_payload = payload;
    job_payload["beat_backend"] = json!(beat_backend);
    job.beat_backend = Some(beat_backend.clone());
    job.analysis_request = Some(job_payload.clone());
    connection
        .execute(
            "UPDATE jobs SET payload_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![job_payload.to_string(), now_iso(), job.id],
        )
        .map_err(|error| error.to_string())?;
    let job_for_worker = job.clone();
    thread::spawn(move || {
        run_analysis_job(
            root,
            job_for_worker.id,
            project,
            source_artifact,
            beat_backend,
        )
    });
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
    mut payload: Value,
) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let source_artifact = get_source_artifact(&connection, &project_id)?;
    let backend = match resolve_mobile_chord_backend(
        payload
            .get("backend")
            .and_then(Value::as_str)
            .or_else(|| payload.get("chord_backend").and_then(Value::as_str)),
    ) {
        Ok(backend) => backend.to_string(),
        Err(message) => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "chords", &message)?,
            })
        }
    };
    if let Some(job) = connection.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE project_id = ?1 AND type = 'chords' AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1"),
        params![project_id], row_job,
    ).optional().map_err(|error| error.to_string())? {
        return Ok(JobResponse { job });
    }
    let force = payload
        .get("force")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let overwrite_user_edits = payload
        .get("overwrite_user_edits")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if existing_chords_should_be_preserved(
        &connection,
        &project_id,
        &backend,
        force,
        overwrite_user_edits,
    )? {
        let mut job = create_completed_job(
            &connection,
            &project_id,
            "chords",
            Some(source_artifact.id.clone()),
        )?;
        finish_preserved_chord_job(&connection, &job.id, &backend)?;
        job.chord_backend = Some(backend);
        job.chord_source = Some("source".to_string());
        job.stage = Some("complete".to_string());
        job.stage_label = Some("Existing chords preserved".to_string());
        job.runtime_detail = Some("Existing saved timeline".to_string());
        return Ok(JobResponse { job });
    }
    let mut job = create_running_job(
        &connection,
        &project_id,
        "chords",
        Some(source_artifact.id.clone()),
    )?;
    payload["chord_backend"] = json!(backend);
    payload["chord_source"] = json!("source");
    connection
        .execute(
            "UPDATE jobs SET payload_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![payload.to_string(), now_iso(), job.id],
        )
        .map_err(|error| error.to_string())?;
    job.chord_backend = Some(backend.clone());
    job.chord_source = Some("source".to_string());
    let job_for_worker = job.clone();
    thread::spawn(move || {
        run_chord_job(
            root,
            job_for_worker.id,
            project,
            source_artifact,
            backend,
            overwrite_user_edits,
        )
    });
    Ok(JobResponse { job })
}

pub fn mobile_get_chords(app: AppHandle, project_id: String) -> Result<ChordResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let _ = get_project_schema(&connection, &project_id)?;
    let response = get_chord_response(&connection, project_id)?;
    let _ = repair_chord_snapshot(&root, &response);
    Ok(response)
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
    use super::{
        beat_this_preprocessing_provenance, cache_source_reference_tuning, get_analysis_value,
        get_chord_response, repair_chord_snapshot, request_audio_job_cancellation, run_chord_job,
        store_analysis_result, store_chord_timeline, AudioJobCancellation, ChordStoreOutcome,
        MobileAudioFeatures,
    };
    use crate::mobile_backend::{
        create_running_job, db_at_root, get_project_schema, get_source_artifact, new_id, now_iso,
        row_job, JOB_COLUMNS,
    };
    use rusqlite::params;
    use serde_json::{json, Value};
    use std::fs;

    #[test]
    fn cancellation_token_handles_request_before_worker_start_and_clears_after_finish() {
        let job_id = new_id("cancel");
        request_audio_job_cancellation(&job_id);
        let cancellation = AudioJobCancellation::begin(&job_id);
        assert!(cancellation.requested());
        drop(cancellation);

        let next_run = AudioJobCancellation::begin(&job_id);
        assert!(!next_run.requested());
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

    #[test]
    fn analysis_persistence_guards_source_and_records_backend_provenance() {
        let project_id = format!("proj_sha256_{}", "0".repeat(64));
        let root = std::env::temp_dir().join(format!("tuneforge-analysis-{}", new_id("test")));
        let project_root = root.join("projects").join(&project_id);
        fs::create_dir_all(project_root.join("analysis")).unwrap();
        let source_path = project_root.join("source.wav");
        fs::write(&source_path, b"synthetic source marker").unwrap();
        let connection = db_at_root(&root).unwrap();
        let timestamp = now_iso();
        connection.execute(
            "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at) VALUES (?1, 'Synthetic', ?2, ?2, 'local', ?3, ?3)",
            params![project_id, source_path.to_string_lossy(), timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('source', ?1, 'source_audio', 'wav', ?2, 23, 'import', 0, 0, '{}', ?3)",
            params![project_id, source_path.to_string_lossy(), timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO analysis_results (project_id, source_artifact_id, estimated_key, tempo_bpm, timing_json, analysis_version, created_at) VALUES (?1, 'source', 'A minor', 120.0, '{\"beats\":[0.5]}', 'desktop-v4', ?2)",
            params![project_id, timestamp],
        ).unwrap();
        let project = get_project_schema(&connection, &project_id).unwrap();
        let source = get_source_artifact(&connection, &project_id).unwrap();
        let harmony = crate::native_audio::harmonic_features::extract_harmonic_features_from_audio(
            &crate::native_audio::decode::DecodedAudio {
                samples: (0..44_100)
                    .map(|index| {
                        (2.0 * std::f64::consts::PI * 440.0 * index as f64 / 22_050.0).sin() as f32
                            * 0.2
                    })
                    .collect(),
                sample_rate: 22_050,
                channels: 1,
            },
        )
        .unwrap();
        let features = MobileAudioFeatures {
            duration_seconds: 2.0,
            sample_rate: 22_050,
            channels: 1,
            estimated_reference_hz: Some(440.0),
            tuning_offset_cents: Some(0.0),
            harmony,
        };

        let cancelled =
            create_running_job(&connection, &project_id, "analyze", Some("source".into())).unwrap();
        connection
            .execute(
                "UPDATE jobs SET cancel_requested = 1 WHERE id = ?1",
                params![cancelled.id],
            )
            .unwrap();
        assert_eq!(
            store_analysis_result(
                &connection,
                &root,
                &project,
                &source,
                &features,
                None,
                "built-in",
                &cancelled.id,
            )
            .unwrap_err(),
            "ANALYSIS_CANCELLED",
        );
        assert!(!project_root
            .join(format!("analysis/{}.json", cancelled.id))
            .exists());
        let preserved: (String, f64, String) = connection.query_row(
            "SELECT estimated_key, tempo_bpm, timing_json FROM analysis_results WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(
            preserved,
            ("A minor".into(), 120.0, "{\"beats\":[0.5]}".into())
        );

        let changed_source =
            create_running_job(&connection, &project_id, "analyze", Some("source".into())).unwrap();
        connection
            .execute(
                "UPDATE artifacts SET path = 'replacement.wav' WHERE id = 'source'",
                [],
            )
            .unwrap();
        assert_eq!(
            store_analysis_result(
                &connection,
                &root,
                &project,
                &source,
                &features,
                None,
                "built-in",
                &changed_source.id,
            )
            .unwrap_err(),
            "Analysis source changed before publication.",
        );
        assert!(!project_root
            .join(format!("analysis/{}.json", changed_source.id))
            .exists());
        let preserved: (String, f64, String) = connection
            .query_row(
                "SELECT estimated_key, tempo_bpm, timing_json FROM analysis_results WHERE project_id = ?1",
                params![project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            preserved,
            ("A minor".into(), 120.0, "{\"beats\":[0.5]}".into())
        );
        connection
            .execute(
                "UPDATE artifacts SET path = ?1 WHERE id = 'source'",
                params![source_path.to_string_lossy()],
            )
            .unwrap();

        let retry =
            create_running_job(&connection, &project_id, "analyze", Some("source".into())).unwrap();
        let stored = store_analysis_result(
            &connection,
            &root,
            &project,
            &source,
            &features,
            None,
            "built-in",
            &retry.id,
        )
        .unwrap();
        assert!(stored["estimated_key"].is_string());
        assert!(stored["estimated_reference_hz"].is_number());
        assert!(stored["tuning_offset_cents"].is_number());
        assert!(stored["tempo_bpm"].is_null());
        assert!(stored["timing"].is_null());
        assert!(stored["preprocessing"].is_null());
        let status: (String, i64) = connection
            .query_row(
                "SELECT status, progress FROM jobs WHERE id = ?1",
                params![retry.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, ("completed".into(), 100));
        drop(connection);

        let reopened = db_at_root(&root).unwrap();
        let reloaded = get_analysis_value(&reopened, &project_id).unwrap().unwrap();
        assert!(reloaded["estimated_key"].is_string());
        assert!(reloaded["tempo_bpm"].is_null());
        assert!(reloaded["timing"].is_null());
        let metadata: String = reopened.query_row(
            "SELECT metadata_json FROM artifacts WHERE project_id = ?1 AND type = 'analysis_json'",
            params![project_id],
            |row| row.get(0),
        ).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(metadata["beat_backend"], "built-in");
        assert_eq!(metadata["runtime"], "native-cpu");
        assert!(metadata["model_sha256"].is_null());

        let advanced =
            create_running_job(&reopened, &project_id, "analyze", Some("source".into())).unwrap();
        let beat_result = crate::native_audio::beat_this::BeatThisResult {
            tempo_bpm: 120.0,
            timing: serde_json::json!({"beats": [], "bars": []}),
        };
        let stored = store_analysis_result(
            &reopened,
            &root,
            &project,
            &source,
            &features,
            Some(&beat_result),
            "beat-this",
            &advanced.id,
        )
        .unwrap();
        assert_eq!(
            stored["preprocessing"],
            beat_this_preprocessing_provenance()
        );
        assert_eq!(stored["preprocessing"]["resampler"]["version"], "0.16.2");
        assert_eq!(stored["preprocessing"]["sample_rate_hz"], 22_050);
        let metadata: String = reopened
            .query_row(
                "SELECT metadata_json FROM artifacts WHERE project_id = ?1 AND type = 'analysis_json'",
                params![project_id],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(metadata["preprocessing"], stored["preprocessing"]);
        assert_eq!(metadata["runtime"], "executorch-1.4.0-xnnpack");
        assert!(metadata["model_sha256"].is_string());
        drop(reopened);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chord_persistence_preserves_edits_and_guards_cancel_and_source_changes() {
        let project_id = format!("proj_sha256_{}", "1".repeat(64));
        let root = std::env::temp_dir().join(format!("tuneforge-chords-{}", new_id("test")));
        let project_root = root.join("projects").join(&project_id);
        fs::create_dir_all(project_root.join("analysis")).unwrap();
        let source_path = project_root.join("source.wav");
        fs::write(&source_path, b"synthetic source marker").unwrap();
        let chord_path = project_root.join("analysis/chords.json");
        fs::write(&chord_path, br#"{"timeline":[{"label":"Dm"}]}"#).unwrap();
        let connection = db_at_root(&root).unwrap();
        let timestamp = now_iso();
        connection.execute(
            "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at) VALUES (?1, 'Synthetic', ?2, ?2, 'local', ?3, ?3)",
            params![project_id, source_path.to_string_lossy(), timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('source', ?1, 'source_audio', 'wav', ?2, 23, 'import', 0, 0, '{}', ?3)",
            params![project_id, source_path.to_string_lossy(), timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO chord_timelines (project_id, source_segments_json, segments_json, timeline_json, backend, source_artifact_id, source_kind, metadata_json, has_user_edits, created_at, updated_at) VALUES (?1, '[{\"label\":\"Dm\"}]', '[{\"label\":\"Dm\"}]', '[{\"label\":\"Dm\"}]', 'crema-advanced', 'source', 'user-edited', '{}', 1, ?2, ?2)",
            params![project_id, timestamp],
        ).unwrap();
        let project = get_project_schema(&connection, &project_id).unwrap();
        let source = get_source_artifact(&connection, &project_id).unwrap();
        let preserved_job =
            create_running_job(&connection, &project_id, "chords", Some("source".into())).unwrap();
        let old_snapshot = fs::read(&chord_path).unwrap();
        let outcome = store_chord_timeline(
            &connection,
            &root,
            &project,
            &source,
            vec![json!({"label":"C","start_seconds":0.0,"end_seconds":1.0})],
            "tuneforge-fast",
            json!({"backend_id":"tuneforge-fast"}),
            false,
            "Native CPU",
            1.25,
            &preserved_job.id,
        )
        .unwrap();
        assert!(matches!(outcome, ChordStoreOutcome::Preserved));
        assert_eq!(fs::read(&chord_path).unwrap(), old_snapshot);
        let preserved: (String, i64, String) = connection.query_row(
            "SELECT backend, has_user_edits, segments_json FROM chord_timelines WHERE project_id = ?1",
            params![project_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(preserved.0, "crema-advanced");
        assert_eq!(preserved.1, 1);
        assert!(preserved.2.contains("Dm"));
        let preserved_job = connection
            .query_row(
                &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = ?1"),
                params![preserved_job.id],
                row_job,
            )
            .unwrap();
        assert_eq!(preserved_job.stage.as_deref(), Some("complete"));
        assert_eq!(
            preserved_job.stage_label.as_deref(),
            Some("Existing chords preserved")
        );
        assert_eq!(preserved_job.duration_seconds, Some(1.25));

        let changed_job =
            create_running_job(&connection, &project_id, "chords", Some("source".into())).unwrap();
        connection
            .execute(
                "UPDATE artifacts SET path = 'replacement.wav' WHERE id = 'source'",
                [],
            )
            .unwrap();
        assert_eq!(
            store_chord_timeline(
                &connection,
                &root,
                &project,
                &source,
                vec![json!({"label":"C"})],
                "tuneforge-fast",
                json!({}),
                true,
                "Native CPU",
                0.25,
                &changed_job.id,
            )
            .err()
            .unwrap(),
            "Chord source changed before publication."
        );
        assert_eq!(fs::read(&chord_path).unwrap(), old_snapshot);
        connection
            .execute(
                "UPDATE artifacts SET path = ?1 WHERE id = 'source'",
                params![source_path.to_string_lossy()],
            )
            .unwrap();

        let retry =
            create_running_job(&connection, &project_id, "chords", Some("source".into())).unwrap();
        let stored = store_chord_timeline(
            &connection,
            &root,
            &project,
            &source,
            vec![json!({"label":"C","start_seconds":0.0,"end_seconds":1.0})],
            "tuneforge-fast",
            json!({"backend_id":"tuneforge-fast"}),
            true,
            "Native CPU",
            0.5,
            &retry.id,
        )
        .unwrap();
        let ChordStoreOutcome::Stored(response) = stored else {
            panic!("expected stored timeline");
        };
        assert_eq!(response.backend.as_deref(), Some("tuneforge-fast"));
        let snapshot: Value = serde_json::from_slice(&fs::read(&chord_path).unwrap()).unwrap();
        assert_eq!(snapshot["backend"], "tuneforge-fast");
        assert_eq!(snapshot["timeline"][0]["label"], "C");
        fs::write(&chord_path, &old_snapshot).unwrap();
        repair_chord_snapshot(&root, &response).unwrap();
        let repaired: Value = serde_json::from_slice(&fs::read(&chord_path).unwrap()).unwrap();
        assert_eq!(repaired["timeline"][0]["label"], "C");

        let cancelled =
            create_running_job(&connection, &project_id, "chords", Some("source".into())).unwrap();
        connection
            .execute(
                "UPDATE jobs SET cancel_requested = 1 WHERE id = ?1",
                params![cancelled.id],
            )
            .unwrap();
        let stored_snapshot = fs::read(&chord_path).unwrap();
        assert_eq!(
            store_chord_timeline(
                &connection,
                &root,
                &project,
                &source,
                vec![json!({"label":"G"})],
                "tuneforge-fast",
                json!({}),
                true,
                "Native CPU",
                0.75,
                &cancelled.id,
            )
            .err()
            .unwrap(),
            "CHORDS_CANCELLED"
        );
        assert_eq!(fs::read(&chord_path).unwrap(), stored_snapshot);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn built_in_chord_job_runs_asynchronously_shaped_work_and_records_provenance() {
        let project_id = format!("proj_sha256_{}", "2".repeat(64));
        let root = std::env::temp_dir().join(format!("tuneforge-chord-job-{}", new_id("test")));
        let project_root = root.join("projects").join(&project_id);
        fs::create_dir_all(project_root.join("source")).unwrap();
        let source_path = project_root.join("source/source.wav");
        let sample_rate = 22_050_u32;
        let samples = (0..sample_rate as usize)
            .map(|index| {
                [261.625_565, 329.627_557, 391.995_436]
                    .iter()
                    .enumerate()
                    .map(|(rank, frequency)| {
                        ((2.0 * std::f64::consts::PI * frequency * index as f64
                            / sample_rate as f64)
                            .sin()
                            / (rank + 1) as f64) as f32
                            * 0.2
                    })
                    .sum()
            })
            .collect();
        crate::native_audio::decode::write_mono_pcm_wav(
            &source_path,
            &crate::native_audio::decode::DecodedAudio {
                samples,
                sample_rate,
                channels: 1,
            },
        )
        .unwrap();
        let connection = db_at_root(&root).unwrap();
        let timestamp = now_iso();
        connection.execute(
            "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at) VALUES (?1, 'Synthetic', ?2, ?2, 'local', ?3, ?3)",
            params![project_id, source_path.to_string_lossy(), timestamp],
        ).unwrap();
        connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('source', ?1, 'source_audio', 'wav', ?2, ?3, 'import', 0, 0, '{}', ?4)",
            params![project_id, source_path.to_string_lossy(), fs::metadata(&source_path).unwrap().len() as i64, timestamp],
        ).unwrap();
        let project = get_project_schema(&connection, &project_id).unwrap();
        let source = get_source_artifact(&connection, &project_id).unwrap();
        let job = create_running_job(&connection, &project_id, "chords", Some(source.id.clone()))
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET payload_json = ?1 WHERE id = ?2",
                params![
                    json!({"chord_backend":"tuneforge-fast","chord_source":"source"}).to_string(),
                    job.id
                ],
            )
            .unwrap();
        drop(connection);

        run_chord_job(
            root.clone(),
            job.id.clone(),
            project,
            source,
            "tuneforge-fast".into(),
            false,
        );

        let reopened = db_at_root(&root).unwrap();
        let stored_job = reopened
            .query_row(
                &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = ?1"),
                params![job.id],
                row_job,
            )
            .unwrap();
        assert_eq!(stored_job.status, "completed");
        assert_eq!(stored_job.progress, 100);
        assert_eq!(stored_job.chord_backend.as_deref(), Some("tuneforge-fast"));
        assert_eq!(stored_job.chord_backend_fallback_from, None);
        assert_eq!(stored_job.chord_source.as_deref(), Some("source"));
        assert_eq!(stored_job.stage.as_deref(), Some("complete"));
        assert!(stored_job
            .duration_seconds
            .is_some_and(|duration| duration > 0.0));
        let chords = get_chord_response(&reopened, project_id.clone()).unwrap();
        assert_eq!(chords.backend.as_deref(), Some("tuneforge-fast"));
        assert!(!chords.timeline.is_empty());
        assert_eq!(chords.metadata["backend_id"], "tuneforge-fast");
        assert_eq!(chords.metadata["runtime_device"], "cpu");
        let _ = fs::remove_dir_all(root);
    }
}
