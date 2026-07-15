use super::*;

#[derive(Clone)]
pub(super) struct WhisperModel {
    pub(super) path: PathBuf,
    pub(super) name: &'static str,
    pub(super) max_recommended_model: &'static str,
}

struct MobileLyricsTranscription {
    backend: &'static str,
    source_kind: &'static str,
    requested_device: Option<&'static str>,
    device: Option<&'static str>,
    model_name: Option<String>,
    language: Option<String>,
    language_override: Option<String>,
    segments: Vec<Value>,
}

pub(super) fn find_whisper_model(root: &Path) -> Option<WhisperModel> {
    [
        ("ggml-base.bin", "base", "base"),
        ("ggml-base.en.bin", "base.en", "base"),
        ("ggml-tiny.bin", "tiny", "tiny"),
        ("ggml-tiny.en.bin", "tiny.en", "tiny"),
    ]
    .into_iter()
    .find_map(|(file_name, name, max_recommended_model)| {
        let path = root.join(WHISPER_MODEL_DIR).join(file_name);
        path.is_file().then_some(WhisperModel {
            path,
            name,
            max_recommended_model,
        })
    })
}

fn payload_force(payload: &Value) -> bool {
    payload
        .get("force")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn get_lyrics_response(
    connection: &Connection,
    project_id: String,
) -> Result<LyricsResponse, String> {
    connection
        .query_row(
            "SELECT project_id, backend, source_artifact_id, source_kind, requested_device, device, model_name, language, language_override, source_segments_json, segments_json, has_user_edits, created_at, updated_at FROM lyrics_transcripts WHERE project_id = ?1",
            params![project_id],
            |row| {
                let source_segments_raw: String = row.get(9)?;
                let segments_raw: String = row.get(10)?;
                let source_segments =
                    serde_json::from_str(&source_segments_raw).unwrap_or_default();
                let segments = serde_json::from_str(&segments_raw).unwrap_or_default();
                Ok(LyricsResponse {
                    project_id: row.get(0)?,
                    backend: row.get(1)?,
                    source_artifact_id: row.get(2)?,
                    source_kind: row.get(3)?,
                    requested_device: row.get(4)?,
                    device: row.get(5)?,
                    model_name: row.get(6)?,
                    language: row.get(7)?,
                    language_override: row.get(8)?,
                    source_segments,
                    segments,
                    has_user_edits: row.get::<_, i64>(11)? != 0,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(Ok)
        .unwrap_or_else(|| Ok(empty_lyrics(project_id)))
}

fn write_lyrics_snapshot(root: &Path, lyrics: &LyricsResponse) -> Result<(), String> {
    let lyrics_path = project_root_path(root, &lyrics.project_id)?
        .join("analysis")
        .join("lyrics.json");
    if let Some(parent) = lyrics_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        lyrics_path,
        serde_json::to_vec_pretty(lyrics).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn store_lyrics_transcript(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    transcription: MobileLyricsTranscription,
) -> Result<LyricsResponse, String> {
    let timestamp = now_iso();
    let source_segments_json =
        serde_json::to_string(&transcription.segments).map_err(|error| error.to_string())?;
    let segments_json = source_segments_json.clone();
    connection
        .execute(
            "INSERT INTO lyrics_transcripts (project_id, backend, source_artifact_id, source_kind, requested_device, device, model_name, language, language_override, source_segments_json, segments_json, has_user_edits, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12)
             ON CONFLICT(project_id) DO UPDATE SET backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, source_kind = excluded.source_kind, requested_device = excluded.requested_device, device = excluded.device, model_name = excluded.model_name, language = excluded.language, language_override = excluded.language_override, source_segments_json = excluded.source_segments_json, segments_json = excluded.segments_json, has_user_edits = excluded.has_user_edits, updated_at = excluded.updated_at",
            params![
                project.id,
                transcription.backend,
                source_artifact.id,
                transcription.source_kind,
                transcription.requested_device,
                transcription.device,
                transcription.model_name,
                transcription.language,
                transcription.language_override,
                source_segments_json,
                segments_json,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
    let response = get_lyrics_response(connection, project.id.clone())?;
    write_lyrics_snapshot(root, &response)?;
    Ok(response)
}

fn payload_lyrics_edits(payload: &Value) -> Result<Vec<String>, String> {
    let segments = payload
        .get("segments")
        .and_then(Value::as_array)
        .ok_or_else(|| "Lyrics edits must include a segments array.".to_string())?;
    Ok(segments
        .iter()
        .map(|segment| {
            segment
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect())
}

fn update_lyrics_transcript(
    connection: &Connection,
    root: &Path,
    project_id: String,
    payload: &Value,
) -> Result<LyricsResponse, String> {
    let edits = payload_lyrics_edits(payload)?;
    let (source_segments, current_segments): (Vec<Value>, Vec<Value>) = connection
        .query_row(
            "SELECT source_segments_json, segments_json FROM lyrics_transcripts WHERE project_id = ?1",
            params![project_id],
            |row| {
                let source_segments_raw: String = row.get(0)?;
                let current_segments_raw: String = row.get(1)?;
                Ok((
                    serde_json::from_str(&source_segments_raw).unwrap_or_default(),
                    serde_json::from_str(&current_segments_raw).unwrap_or_default(),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Lyrics have not been generated for this project.".to_string())?;

    if edits.len() != current_segments.len() {
        return Err("Lyrics edits must preserve the existing segment count in v1.".to_string());
    }

    let mut updated_segments = Vec::with_capacity(current_segments.len());
    for (index, text) in edits.into_iter().enumerate() {
        let current_segment = &current_segments[index];
        let source_segment = source_segments.get(index);
        let mut updated = current_segment
            .as_object()
            .cloned()
            .unwrap_or_else(serde_json::Map::new);

        updated.insert("text".to_string(), Value::String(text.clone()));
        updated.insert(
            "start_seconds".to_string(),
            current_segment
                .get("start_seconds")
                .cloned()
                .unwrap_or(Value::Null),
        );
        updated.insert(
            "end_seconds".to_string(),
            current_segment
                .get("end_seconds")
                .cloned()
                .unwrap_or(Value::Null),
        );

        let source_text = source_segment
            .and_then(Value::as_object)
            .and_then(|segment| segment.get("text"))
            .and_then(Value::as_str);
        let current_text = current_segment.get("text").and_then(Value::as_str);
        if Some(text.as_str()) == source_text {
            if let Some(words) = source_segment.and_then(|segment| segment.get("words")) {
                updated.insert("words".to_string(), words.clone());
            } else {
                updated.remove("words");
            }
        } else if Some(text.as_str()) != current_text {
            updated.remove("words");
        }

        updated_segments.push(Value::Object(updated));
    }

    let has_user_edits = updated_segments != source_segments;
    let updated_segments_json =
        serde_json::to_string(&updated_segments).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE lyrics_transcripts SET segments_json = ?1, has_user_edits = ?2, updated_at = ?3 WHERE project_id = ?4",
            params![
                updated_segments_json,
                if has_user_edits { 1_i64 } else { 0_i64 },
                now_iso(),
                project_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    let response = get_lyrics_response(connection, project_id)?;
    write_lyrics_snapshot(root, &response)?;
    Ok(response)
}

fn transcribe_project_lyrics(
    source_path: &Path,
    model: &WhisperModel,
    language_override: Option<&str>,
) -> Result<MobileLyricsTranscription, String> {
    let audio = read_resampled_mono_audio(source_path, WHISPER_SAMPLE_RATE)?;
    if audio.samples.is_empty() {
        return Err("Imported audio did not contain samples for lyrics transcription.".to_string());
    }

    install_logging_hooks();
    let context = WhisperContext::new_with_params(&model.path, WhisperContextParameters::default())
        .map_err(|error| format!("Whisper model could not be loaded: {error}"))?;
    let mut state = context
        .create_state()
        .map_err(|error| format!("Whisper state could not be created: {error}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let thread_count = thread::available_parallelism()
        .map(|count| count.get().clamp(1, 4) as i32)
        .unwrap_or(2);
    params.set_n_threads(thread_count);
    params.set_translate(false);
    params.set_language(language_override);
    params.set_no_context(true);
    params.set_token_timestamps(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_temperature(0.0);

    state
        .full(params, &audio.samples)
        .map_err(|error| format!("Whisper transcription failed: {error}"))?;

    let mut segments = Vec::new();
    for segment in state.as_iter() {
        let text = segment
            .to_str_lossy()
            .map_err(|error| format!("Whisper returned invalid transcript text: {error}"))?
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        segments.push(json!({
            "start_seconds": segment.start_timestamp() as f64 / 100.0,
            "end_seconds": segment.end_timestamp() as f64 / 100.0,
            "text": text,
        }));
    }

    let language = whisper_rs::get_lang_str(state.full_lang_id_from_state())
        .map(ToString::to_string)
        .or_else(|| language_override.map(ToString::to_string));

    Ok(MobileLyricsTranscription {
        backend: "whisper.cpp",
        source_kind: LYRICS_SOURCE_KIND_AI,
        requested_device: Some("cpu"),
        device: Some("cpu"),
        model_name: Some(model.name.to_string()),
        language,
        language_override: language_override.map(ToString::to_string),
        segments,
    })
}

fn run_lyrics_job(
    root: PathBuf,
    job_id: String,
    project: ProjectSchema,
    source_artifact: ArtifactSchema,
    model: WhisperModel,
    language_override: Option<String>,
) {
    let started = Instant::now();
    let connection = match db_at_root(&root) {
        Ok(connection) => connection,
        Err(_) => return,
    };

    let result = (|| {
        update_job_progress(&connection, &job_id, 15)?;
        let transcription = transcribe_project_lyrics(
            Path::new(&project.imported_path),
            &model,
            language_override.as_deref(),
        )?;
        update_job_progress(&connection, &job_id, 90)?;
        store_lyrics_transcript(
            &connection,
            &root,
            &project,
            &source_artifact,
            transcription,
        )?;
        Ok::<(), String>(())
    })();

    let duration_seconds = started.elapsed().as_secs_f64();
    match result {
        Ok(()) => {
            if complete_running_job(&connection, &job_id, duration_seconds).is_ok() {
                reconcile_project_storage_after_commit(&connection, &root, &project.id);
            }
        }
        Err(message) => {
            let _ = fail_running_job(&connection, &job_id, &message, duration_seconds);
        }
    }
}
pub fn mobile_submit_lyrics(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let force = payload_force(&payload);
    let language_override = match payload_lyrics_language_override(&payload) {
        Ok(language_override) => language_override,
        Err(message) => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "lyrics", &message)?,
            });
        }
    };
    let existing = get_lyrics_response(&connection, project_id.clone())?;
    if !force && !existing.segments.is_empty() {
        return Ok(JobResponse {
            job: create_completed_job(
                &connection,
                &project_id,
                "lyrics",
                existing.source_artifact_id,
            )?,
        });
    }
    let source_artifact = match get_source_artifact(&connection, &project_id) {
        Ok(artifact) => artifact,
        Err(message) => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "lyrics", &message)?,
            });
        }
    };
    if language_override.as_deref() == Some("none") {
        let (backend, source_kind, requested_device, device, model_name) =
            no_lyrics_transcript_metadata();
        store_lyrics_transcript(
            &connection,
            &root,
            &project,
            &source_artifact,
            MobileLyricsTranscription {
                backend,
                source_kind,
                requested_device,
                device,
                model_name,
                language: None,
                language_override,
                segments: Vec::new(),
            },
        )?;
        let job =
            create_completed_job(&connection, &project_id, "lyrics", Some(source_artifact.id))?;
        reconcile_project_storage_after_commit(&connection, &root, &project_id);
        return Ok(JobResponse { job });
    }
    let model = match find_whisper_model(&root) {
        Some(model) => model,
        None => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "lyrics", WHISPER_MODEL_MISSING)?,
            });
        }
    };
    let job = create_running_job(
        &connection,
        &project_id,
        "lyrics",
        Some(source_artifact.id.clone()),
    )?;
    let job_id = job.id.clone();
    thread::spawn(move || {
        run_lyrics_job(
            root,
            job_id,
            project,
            source_artifact,
            model,
            language_override,
        )
    });
    Ok(JobResponse { job })
}

pub fn mobile_get_lyrics(app: AppHandle, project_id: String) -> Result<LyricsResponse, String> {
    let connection = db(&app)?;
    let _ = get_project_schema(&connection, &project_id)?;
    get_lyrics_response(&connection, project_id)
}

pub fn mobile_update_lyrics(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<LyricsResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    let response = update_lyrics_transcript(&connection, &root, project_id.clone(), &payload)?;
    reconcile_project_storage_after_commit(&connection, &root, &project_id);
    Ok(response)
}

fn empty_lyrics(project_id: String) -> LyricsResponse {
    LyricsResponse {
        project_id,
        backend: None,
        source_artifact_id: None,
        source_kind: None,
        requested_device: None,
        device: None,
        model_name: None,
        language: None,
        language_override: None,
        source_segments: Vec::new(),
        segments: Vec::new(),
        has_user_edits: false,
        created_at: None,
        updated_at: None,
    }
}
