use super::audio::{request_audio_job_cancellation, AudioJobCancellation};
use super::storage_cleanup::{
    capture_owned_project_file, cleanup_owned_project_files, prepare_owned_project_file,
};
use super::*;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const WHISPER_MODEL_NAME: &str = "large-v3-turbo";

pub(crate) fn request_lyrics_job_cancellation(job_id: &str) {
    request_audio_job_cancellation(job_id);
    crate::native_audio::whisper_model::cancel(job_id);
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

struct WhisperCallbacks {
    cancellation: Arc<AtomicBool>,
    root: PathBuf,
    job_id: String,
}

struct LyricsPreparedAudio {
    root: PathBuf,
    project_root: PathBuf,
    path: PathBuf,
}

impl LyricsPreparedAudio {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for LyricsPreparedAudio {
    fn drop(&mut self) {
        if let Ok(file) = capture_owned_project_file(&self.root, &self.project_root, &self.path) {
            cleanup_owned_project_files(&[file]);
        }
    }
}

unsafe extern "C" fn whisper_abort_callback(user_data: *mut c_void) -> bool {
    catch_unwind(AssertUnwindSafe(|| unsafe {
        (&*(user_data as *const WhisperCallbacks))
            .cancellation
            .load(Ordering::Relaxed)
    }))
    .unwrap_or(true)
}

unsafe extern "C" fn whisper_progress_callback(
    _context: *mut whisper_rs::whisper_rs_sys::whisper_context,
    _state: *mut whisper_rs::whisper_rs_sys::whisper_state,
    native_progress: i32,
    user_data: *mut c_void,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        let callbacks = &*(user_data as *const WhisperCallbacks);
        if let Ok(connection) = db_at_root(&callbacks.root) {
            let progress = 35 + (i64::from(native_progress).clamp(0, 100) * 50 / 100);
            let _ = update_job_stage(
                &connection,
                &callbacks.job_id,
                progress,
                "transcribing",
                "Transcribing lyrics",
            );
        }
    }));
}

fn aligned_tokens(
    segment: &WhisperSegment<'_>,
    text_token_eot: i32,
) -> Result<(Vec<AlignedTextToken>, usize), String> {
    let mut aligned = Vec::new();
    let mut text_token_count = 0;
    let mut missing_boundary_count = 0;
    let mut reversed_boundary_count = 0;
    for index in 0..segment.n_tokens() {
        let token = segment
            .get_token(index)
            .ok_or_else(|| "Whisper token index was out of bounds.".to_string())?;
        let data = token.token_data();
        if token.token_id() >= text_token_eot {
            continue;
        }
        text_token_count += 1;
        if data.t_dtw < 0 || data.t_dtw_end < 0 {
            missing_boundary_count += 1;
        } else if data.t_dtw_end < data.t_dtw {
            // Desktop's long-word correction can shorten the last token below
            // its own start while the regrouped multi-token word remains valid.
            reversed_boundary_count += 1;
        }
        aligned.push(AlignedTextToken {
            text: token
                .to_bytes()
                .map_err(|error| format!("Whisper returned invalid token text: {error}"))?
                .to_vec(),
            start_centiseconds: data.t_dtw,
            end_centiseconds: data.t_dtw_end,
            confidence: f64::from(data.p).clamp(0.0, 1.0),
        });
    }
    if missing_boundary_count > 0 {
        eprintln!(
            "Whisper DTW validation failed: missing={} reversed={} expected={} emitted={}",
            missing_boundary_count,
            reversed_boundary_count,
            text_token_count,
            aligned.len()
        );
        return Err("Whisper returned an incomplete DTW boundary sequence.".to_string());
    }
    let segment_text = segment
        .to_bytes()
        .map_err(|error| format!("Whisper returned invalid segment text: {error}"))?;
    validate_aligned_token_coverage(&aligned, text_token_count, segment_text)
        .map_err(ToString::to_string)?;
    Ok((aligned, reversed_boundary_count))
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
    mobile_lyrics_response(connection, project_id)
}

fn active_lyrics_job(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<JobSchema>, String> {
    connection
        .query_row(
            &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE project_id = ?1 AND type = 'lyrics' AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1"),
            params![project_id],
            row_job,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn stage_lyrics_snapshot(
    root: &Path,
    lyrics: &LyricsResponse,
) -> Result<(PathBuf, PathBuf), String> {
    let lyrics_path = project_root_path(root, &lyrics.project_id)?
        .join("analysis")
        .join("lyrics.json");
    if let Some(parent) = lyrics_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let staging_path = lyrics_path.with_file_name(format!(".lyrics-{}.tmp", new_id("snapshot")));
    fs::write(
        &staging_path,
        serde_json::to_vec_pretty(lyrics).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok((staging_path, lyrics_path))
}

fn promote_lyrics_snapshot(staged: &(PathBuf, PathBuf)) -> Result<(), String> {
    fs::rename(&staged.0, &staged.1).map_err(|error| error.to_string())
}

fn write_lyrics_snapshot(root: &Path, lyrics: &LyricsResponse) -> Result<(), String> {
    let staged = stage_lyrics_snapshot(root, lyrics)?;
    if let Err(error) = promote_lyrics_snapshot(&staged) {
        let _ = fs::remove_file(&staged.0);
        return Err(error);
    }
    Ok(())
}

fn upsert_lyrics_transcript(
    connection: &Connection,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    transcription: &MobileLyricsTranscription,
) -> Result<(), String> {
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
    Ok(())
}

fn store_lyrics_transcript(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    transcription: MobileLyricsTranscription,
) -> Result<LyricsResponse, String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    upsert_lyrics_transcript(&transaction, project, source_artifact, &transcription)?;
    let response = get_lyrics_response(&transaction, project.id.clone())?;
    let staged = stage_lyrics_snapshot(root, &response)?;
    if let Err(error) = transaction.commit().map_err(|error| error.to_string()) {
        let _ = fs::remove_file(&staged.0);
        return Err(error);
    }
    promote_lyrics_snapshot(&staged)?;
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
    model_path: &Path,
    language_override: Option<&str>,
    use_gpu: bool,
    root: &Path,
    job_id: &str,
    cancellation: &AudioJobCancellation,
) -> Result<MobileLyricsTranscription, String> {
    let audio = read_mobile_audio(source_path)?;
    if audio.samples.is_empty() {
        return Err("Imported audio did not contain samples for lyrics transcription.".to_string());
    }
    if audio.sample_rate != WHISPER_SAMPLE_RATE || audio.channels != 1 {
        return Err("Prepared lyrics audio was not 16 kHz mono PCM.".to_string());
    }
    install_logging_hooks();
    let mut context_params = WhisperContextParameters::default();
    context_params
        .use_gpu(use_gpu)
        .flash_attn(false)
        .dtw_parameters(DtwParameters {
            mode: DtwMode::ModelPreset {
                model_preset: DtwModelPreset::LargeV3Turbo,
            },
            ..DtwParameters::default()
        });
    let context = WhisperContext::new_with_params(model_path, context_params)
        .map_err(|error| format!("Whisper model could not be loaded: {error}"))?;
    let text_token_eot = context.token_eot();
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
    params.set_token_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_temperature(0.0);
    params.set_temperature_inc(0.2);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(0.6);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    let mut callbacks = Box::new(WhisperCallbacks {
        cancellation: cancellation.token(),
        root: root.to_path_buf(),
        job_id: job_id.to_string(),
    });
    let callback_ptr = (&mut *callbacks) as *mut WhisperCallbacks as *mut c_void;
    unsafe {
        params.set_abort_callback(Some(whisper_abort_callback));
        params.set_abort_callback_user_data(callback_ptr);
        params.set_progress_callback(Some(whisper_progress_callback));
        params.set_progress_callback_user_data(callback_ptr);
    }

    if let Err(error) = state.full(params, &audio.samples) {
        return if cancellation.requested() {
            Err("LYRICS_CANCELLED".to_string())
        } else {
            Err(format!("Whisper transcription failed: {error}"))
        };
    }
    if cancellation.requested() {
        return Err("LYRICS_CANCELLED".to_string());
    }

    // Native execution is serialized by the existing inference exclusion. The
    // native query remains truthful for successful silence with zero tokens.
    let actual_backend_type =
        unsafe { whisper_rs::whisper_rs_sys::whisper_last_full_backend_type() };

    let effective_language = whisper_rs::get_lang_str(state.full_lang_id_from_state())
        .map(ToString::to_string)
        .filter(|value| !value.is_empty());
    let detected_language = effective_language
        .clone()
        .filter(|_| language_override.is_none());
    let mut raw_segments = Vec::new();
    let mut all_tokens = Vec::new();
    let mut reversed_boundary_count = 0;
    for segment in state.as_iter() {
        let (tokens, segment_reversed_boundary_count) = aligned_tokens(&segment, text_token_eot)?;
        reversed_boundary_count += segment_reversed_boundary_count;
        let text = segment
            .to_str_lossy()
            .map_err(|error| format!("Whisper returned invalid transcript text: {error}"))?
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        if tokens.is_empty() {
            return Err(
                "Lyrics could not be generated because word timing was unavailable. Retry lyrics."
                    .to_string(),
            );
        }
        raw_segments.push((
            segment.start_timestamp() as f64 / 100.0,
            segment.end_timestamp() as f64 / 100.0,
            text,
            tokens.len(),
        ));
        all_tokens.extend(tokens);
    }

    let words = split_aligned_words(&all_tokens, effective_language.as_deref())
        .map_err(ToString::to_string)?;
    if let Err(error) = validate_aligned_word_boundaries(&words) {
        eprintln!(
            "Whisper DTW validation failed after word grouping: missing=0 reversed={} tokens={} words={}",
            reversed_boundary_count,
            all_tokens.len(),
            words.len()
        );
        return Err(error.to_string());
    }
    if !raw_segments.is_empty() && words.is_empty() {
        return Err(
            "Lyrics could not be generated because word timing was unavailable. Retry lyrics."
                .to_string(),
        );
    }
    let word_partitions = partition_aligned_words(
        words,
        &raw_segments
            .iter()
            .map(|segment| segment.3)
            .collect::<Vec<_>>(),
    )
    .map_err(ToString::to_string)?;
    let segments = raw_segments
        .into_iter()
        .zip(word_partitions)
        .map(|((start_seconds, end_seconds, text, _), words)| {
            json!({
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "text": text,
                "words": words.into_iter().map(|word| json!({
                    "text": word.text,
                    "start_seconds": word.start_centiseconds as f64 / 100.0,
                    "end_seconds": word.end_centiseconds as f64 / 100.0,
                    "confidence": word.confidence,
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();

    let actual_device =
        crate::native_audio::whisper_model::completed_backend_device(actual_backend_type)?;
    Ok(MobileLyricsTranscription {
        backend: "whisper.cpp",
        source_kind: LYRICS_SOURCE_KIND_AI,
        requested_device: Some(if use_gpu { "vulkan" } else { "cpu" }),
        device: actual_device,
        model_name: Some(WHISPER_MODEL_NAME.to_string()),
        language: detected_language,
        language_override: language_override.map(ToString::to_string),
        segments,
    })
}

fn run_lyrics_job(
    root: PathBuf,
    job_id: String,
    project: ProjectSchema,
    source_artifact: ArtifactSchema,
    language_override: Option<String>,
    expected_lyrics_revision: Option<String>,
) {
    let started = Instant::now();
    let connection = match db_at_root(&root) {
        Ok(connection) => connection,
        Err(_) => return,
    };

    let cancellation = AudioJobCancellation::begin(&job_id);
    let result = (|| {
        let setup_status = crate::native_audio::whisper_model::status();
        let (stage, label) = match setup_status.as_str() {
            "ready" => ("verifying", "Verifying Whisper Turbo"),
            "corrupt" => ("repairing", "Repairing and verifying Whisper Turbo"),
            _ => ("downloading", "Downloading Whisper Turbo"),
        };
        update_job_stage(&connection, &job_id, 1, stage, label)?;
        let model_path = prepare_whisper_model(&connection, &job_id, stage, label, &cancellation)?;
        if lyrics_cancel_requested(&connection, &job_id)? || cancellation.requested() {
            return Err("LYRICS_CANCELLED".to_string());
        }
        update_job_stage(&connection, &job_id, 20, "preparing", "Preparing audio")?;
        let prepared_audio = prepare_lyrics_audio(
            &connection,
            &root,
            &project,
            Path::new(&project.imported_path),
            &job_id,
            &cancellation,
        )?;
        ensure_source_unchanged(&connection, &project.id, &source_artifact.id)?;
        update_job_stage(&connection, &job_id, 30, "loading", "Loading Whisper Turbo")?;
        let (mut transcription, runtime_detail) =
            crate::native_audio::whisper_model::with_inference_lock(|| {
                if cancellation.requested() || lyrics_cancel_requested(&connection, &job_id)? {
                    return Err("LYRICS_CANCELLED".to_string());
                }
                crate::native_audio::whisper_model::transcribe_with_cpu_fallback(
                    |use_gpu| {
                        transcribe_project_lyrics(
                            prepared_audio.path(),
                            Path::new(&model_path),
                            language_override.as_deref(),
                            use_gpu,
                            &root,
                            &job_id,
                            &cancellation,
                        )
                    },
                    || cancellation.requested(),
                    || {
                        update_job_stage(
                            &connection,
                            &job_id,
                            32,
                            "fallback",
                            "Vulkan failed; retrying transcription on CPU",
                        )
                    },
                )
            })?;
        let runtime_detail = runtime_detail.or_else(|| {
            (transcription.requested_device == Some("vulkan")
                && transcription.device == Some("cpu"))
            .then_some("CPU execution; Vulkan was not used.")
        });
        transcription.requested_device = Some("auto");
        if lyrics_cancel_requested(&connection, &job_id)? || cancellation.requested() {
            return Err("LYRICS_CANCELLED".to_string());
        }
        ensure_source_unchanged(&connection, &project.id, &source_artifact.id)?;
        update_job_stage(&connection, &job_id, 90, "saving", "Saving lyrics")?;
        let device = transcription.device;
        finish_lyrics_job(
            &connection,
            &root,
            &job_id,
            &project,
            &source_artifact,
            transcription,
            started.elapsed().as_secs_f64(),
            device,
            runtime_detail,
            &cancellation,
            expected_lyrics_revision.as_deref(),
        )?;
        Ok::<Option<&'static str>, String>(device)
    })();

    let duration_seconds = started.elapsed().as_secs_f64();
    match result {
        Ok(_) => {
            reconcile_project_storage_after_commit(&connection, &root, &project.id);
        }
        Err(message) if message == "LYRICS_CANCELLED" => {}
        Err(message) => {
            let _ = fail_running_job(&connection, &job_id, &message, duration_seconds);
        }
    }
}

fn prepare_lyrics_audio(
    connection: &Connection,
    root: &Path,
    project: &ProjectSchema,
    source_path: &Path,
    job_id: &str,
    cancellation: &AudioJobCancellation,
) -> Result<LyricsPreparedAudio, String> {
    let project_root = project_root_path(root, &project.id)?;
    let requested_path = project_root
        .join("analysis")
        .join(format!(".lyrics-{job_id}.wav"));
    let path = prepare_owned_project_file(root, &project_root, &requested_path)?;
    register_job_staging_path(connection, job_id, &path)?;
    // Registration makes this path visible to concurrent storage reconciliation.
    // Prepare it again in case reconciliation removed an empty parent before the
    // job payload was updated.
    let path = prepare_owned_project_file(root, &project_root, &path)?;
    let prepared = LyricsPreparedAudio {
        root: root.to_path_buf(),
        project_root,
        path,
    };
    let mut should_cancel =
        || cancellation.requested() || lyrics_cancel_requested(connection, job_id).unwrap_or(true);
    let mut on_progress = |native_progress: i32| {
        let progress = 20 + i64::from(native_progress.clamp(0, 100)) * 9 / 100;
        let _ = update_job_stage(connection, job_id, progress, "preparing", "Preparing audio");
    };
    if let Err(error) = render_whisper_audio(
        source_path,
        prepared.path(),
        &mut should_cancel,
        &mut on_progress,
    ) {
        return if cancellation.requested() || lyrics_cancel_requested(connection, job_id)? {
            Err("LYRICS_CANCELLED".to_string())
        } else {
            Err(format!("Lyrics audio preparation failed: {error}"))
        };
    }
    probe_mobile_durable_audio(prepared.path(), "wav")?;
    Ok(prepared)
}

fn prepare_whisper_model(
    connection: &Connection,
    job_id: &str,
    stage: &str,
    label: &str,
    cancellation: &AudioJobCancellation,
) -> Result<String, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let prepare_job_id = job_id.to_string();
    thread::spawn(move || {
        let _ = sender.send(crate::native_audio::whisper_model::prepare(&prepare_job_id));
    });
    loop {
        match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
            Ok(result) => {
                crate::native_audio::whisper_model::clear_progress(job_id);
                return result;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if cancellation.requested() || lyrics_cancel_requested(connection, job_id)? {
                    crate::native_audio::whisper_model::cancel(job_id);
                }
                if let Some(download_progress) =
                    crate::native_audio::whisper_model::progress(job_id)
                {
                    let verifying = download_progress >= 100;
                    let stage_progress = if verifying {
                        download_progress.saturating_sub(100).clamp(0, 100)
                    } else {
                        download_progress.clamp(0, 100)
                    };
                    let progress = if verifying {
                        10 + i64::from(stage_progress) * 9 / 100
                    } else {
                        1 + i64::from(stage_progress) * 9 / 100
                    };
                    update_job_stage(
                        connection,
                        job_id,
                        progress,
                        if verifying { "verifying" } else { stage },
                        &format!(
                            "{} · {stage_progress}%",
                            if verifying {
                                "Installing and verifying Whisper Turbo"
                            } else {
                                label
                            }
                        ),
                    )?;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                crate::native_audio::whisper_model::clear_progress(job_id);
                return Err("Whisper Turbo setup stopped unexpectedly. Retry downloads the full model from the beginning.".to_string());
            }
        }
    }
}

fn lyrics_cancel_requested(connection: &Connection, job_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT cancel_requested != 0 OR status = 'cancelled' FROM jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn ensure_source_unchanged(
    connection: &Connection,
    project_id: &str,
    expected_source_id: &str,
) -> Result<(), String> {
    let current = get_source_artifact(connection, project_id)?;
    if current.id != expected_source_id {
        return Err(
            "Project audio changed while lyrics were being generated. Retry lyrics.".to_string(),
        );
    }
    Ok(())
}

fn finish_lyrics_job(
    connection: &Connection,
    root: &Path,
    job_id: &str,
    project: &ProjectSchema,
    source_artifact: &ArtifactSchema,
    transcription: MobileLyricsTranscription,
    duration_seconds: f64,
    device: Option<&str>,
    detail: Option<&str>,
    cancellation: &AudioJobCancellation,
    expected_lyrics_revision: Option<&str>,
) -> Result<(), String> {
    if cancellation.requested() {
        return Err("LYRICS_CANCELLED".to_string());
    }
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if lyrics_cancel_requested(&transaction, job_id)? {
        return Err("LYRICS_CANCELLED".to_string());
    }
    ensure_source_unchanged(&transaction, &project.id, &source_artifact.id)?;
    if lyrics_transcript_revision(&transaction, &project.id)?.as_deref() != expected_lyrics_revision
    {
        return Err(
            "Saved lyrics changed while this generation was running. The newer lyrics were preserved."
                .to_string(),
        );
    }
    upsert_lyrics_transcript(&transaction, project, source_artifact, &transcription)?;
    let timestamp = now_iso();
    let payload = json!({
        "stage": "complete",
        "stage_label": "Lyrics ready",
        "runtime_device": device,
        "runtime_detail": detail,
    });
    let updated = transaction.execute(
        "UPDATE jobs SET status = 'completed', progress = 100, payload_json = ?1, runtime_device = ?2, error_message = NULL, completed_at = ?3, duration_seconds = ?4, updated_at = ?3 WHERE id = ?5 AND status = 'running' AND cancel_requested = 0",
        params![payload.to_string(), device, timestamp, duration_seconds, job_id],
    ).map_err(|error| error.to_string())?;
    if updated != 1 || cancellation.requested() {
        return Err("LYRICS_CANCELLED".to_string());
    }
    let response = get_lyrics_response(&transaction, project.id.clone())?;
    let staged = stage_lyrics_snapshot(root, &response)?;
    if let Err(error) = transaction.commit().map_err(|error| error.to_string()) {
        let _ = fs::remove_file(&staged.0);
        return Err(error);
    }
    promote_lyrics_snapshot(&staged)?;
    Ok(())
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
    if let Some(job) = active_lyrics_job(&connection, &project_id)? {
        return Ok(JobResponse { job });
    }
    let existing = get_lyrics_response(&connection, project_id.clone())?;
    if !force && !existing.segments.is_empty() {
        return Ok(JobResponse {
            job: create_lyrics_completed_job(
                &connection,
                &project_id,
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
        let job = create_lyrics_completed_job(&connection, &project_id, Some(source_artifact.id))?;
        reconcile_project_storage_after_commit(&connection, &root, &project_id);
        return Ok(JobResponse { job });
    }
    let transaction =
        rusqlite::Transaction::new_unchecked(&connection, rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
    if let Some(job) = active_lyrics_job(&transaction, &project_id)? {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(JobResponse { job });
    }
    let expected_lyrics_revision = lyrics_transcript_revision(&transaction, &project_id)?;
    let job =
        create_lyrics_running_job(&transaction, &project_id, Some(source_artifact.id.clone()))?;
    let job_payload = json!({
        "language_override": language_override,
        "lyrics_revision": expected_lyrics_revision,
    });
    transaction
        .execute(
            "UPDATE jobs SET payload_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![job_payload.to_string(), job.updated_at, job.id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let job_id = job.id.clone();
    thread::spawn(move || {
        run_lyrics_job(
            root,
            job_id,
            project,
            source_artifact,
            language_override,
            expected_lyrics_revision,
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
