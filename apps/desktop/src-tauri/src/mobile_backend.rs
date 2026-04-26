use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

#[cfg(not(target_os = "android"))]
const MOBILE_UNAVAILABLE: &str = "Mobile embedded backend is only available in Android builds.";
#[cfg(target_os = "android")]
const GPU_REQUIRED: &str = "Local generation requires GPU acceleration on this device.";
#[cfg(target_os = "android")]
const LYRICS_NOT_WIRED: &str =
    "Mobile lyrics transcription is not wired yet; emulator mode only tests the submit flow.";
#[cfg(target_os = "android")]
const STEMS_NOT_WIRED: &str =
    "Mobile stem separation is not wired yet; emulator mode only tests the submit flow.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCapabilities {
    platform: &'static str,
    media_backend: &'static str,
    is_emulator: bool,
    gpu_backend: Option<&'static str>,
    analysis_available: bool,
    basic_chords_available: bool,
    whisper_available: bool,
    stem_separation_available: bool,
    generation_testing_available: bool,
    max_recommended_model: Option<&'static str>,
    cpu_fallback_allowed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HealthResponse {
    name: String,
    version: String,
    status: String,
    api_base_url: String,
    data_root: String,
    default_export_format: String,
    preview_format: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectSchema {
    id: String,
    display_name: String,
    source_key_override: Option<String>,
    source_path: String,
    imported_path: String,
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
pub struct ProjectResponse {
    project: ProjectSchema,
}

#[derive(Serialize)]
pub struct ProjectsResponse {
    projects: Vec<ProjectSchema>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactSchema {
    id: String,
    project_id: String,
    r#type: String,
    format: String,
    path: String,
    size_bytes: i64,
    generated_by: String,
    can_delete: bool,
    can_regenerate: bool,
    metadata: Value,
    created_at: String,
}

#[derive(Serialize)]
pub struct ArtifactsResponse {
    artifacts: Vec<ArtifactSchema>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct JobSchema {
    id: String,
    project_id: Option<String>,
    r#type: String,
    status: String,
    progress: i64,
    source_artifact_id: Option<String>,
    chord_backend: Option<String>,
    chord_backend_fallback_from: Option<String>,
    chord_source: Option<String>,
    error_message: Option<String>,
    runtime_device: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    duration_seconds: Option<f64>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
pub struct JobResponse {
    job: JobSchema,
}

#[derive(Serialize)]
pub struct JobsResponse {
    jobs: Vec<JobSchema>,
}

#[derive(Serialize)]
pub struct DeleteResponse {
    deleted: bool,
}

#[derive(Serialize)]
pub struct AnalysisResponse {
    analysis: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ChordResponse {
    project_id: String,
    source_segments: Vec<Value>,
    timeline: Vec<Value>,
    backend: Option<String>,
    source_artifact_id: Option<String>,
    has_user_edits: bool,
    source_kind: String,
    metadata: Value,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LyricsResponse {
    project_id: String,
    backend: Option<String>,
    source_artifact_id: Option<String>,
    source_kind: Option<String>,
    requested_device: Option<String>,
    device: Option<String>,
    model_name: Option<String>,
    language: Option<String>,
    source_segments: Vec<Value>,
    segments: Vec<Value>,
    has_user_edits: bool,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct ProjectImportRequest {
    source_path: String,
    copy_into_project: bool,
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct ProjectUpdateRequest {
    display_name: Option<String>,
    source_key_override: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct EmptyPayload {}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn mobile_capabilities() -> Result<MobileCapabilities, String> {
    Err(MOBILE_UNAVAILABLE.to_string())
}

#[cfg(not(target_os = "android"))]
macro_rules! mobile_stub {
    ($name:ident, $ret:ty $(, $arg:ident : $ty:ty)*) => {
        #[tauri::command]
        pub fn $name($($arg: $ty,)*) -> Result<$ret, String> {
            $(let _ = $arg;)*
            Err(MOBILE_UNAVAILABLE.to_string())
        }
    };
}

#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_health, HealthResponse, app: AppHandle);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_list_projects, ProjectsResponse, app: AppHandle, search: Option<String>);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_import_project, ProjectResponse, app: AppHandle, payload: ProjectImportRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_project, ProjectResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_update_project, ProjectResponse, app: AppHandle, project_id: String, payload: ProjectUpdateRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_delete_project, DeleteResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_analyze, JobResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_analysis, AnalysisResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_chords, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_chords, ChordResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_lyrics, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_lyrics, LyricsResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_update_lyrics, LyricsResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_preview, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_stems, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_retune, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_transpose, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_list_artifacts, ArtifactsResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_delete_artifact, DeleteResponse, app: AppHandle, project_id: String, artifact_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_submit_export, JobResponse, app: AppHandle, project_id: String, payload: EmptyPayload);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_list_jobs, JobsResponse, app: AppHandle);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_job, JobResponse, app: AppHandle, job_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_cancel_job, JobResponse, app: AppHandle, job_id: String);

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use android_system_properties::AndroidSystemProperties;
    use chrono::{SecondsFormat, Utc};
    use rusqlite::{params, Connection, OptionalExtension, Row};
    use serde_json::json;
    use std::{
        ffi::{CStr, CString},
        fs, io, mem,
        os::{fd::AsRawFd, raw::c_char},
        path::{Path, PathBuf},
        ptr, slice,
        str::FromStr,
        thread,
        time::Instant,
    };
    use tauri::Manager;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
    use whisper_rs::{
        install_logging_hooks, FullParams, SamplingStrategy, WhisperContext,
        WhisperContextParameters,
    };

    const WHISPER_SAMPLE_RATE: u32 = 16_000;
    const WHISPER_MODEL_DIR: &str = "models/whisper";
    const WHISPER_MODEL_MISSING: &str =
        "Side-load a Whisper ggml model into app storage at models/whisper/ggml-base.bin or models/whisper/ggml-tiny.bin to enable local lyrics.";

    #[derive(Clone)]
    struct WhisperModel {
        path: PathBuf,
        name: &'static str,
        max_recommended_model: &'static str,
    }

    struct DecodedAudio {
        samples: Vec<f32>,
        sample_rate: u32,
        channels: u32,
    }

    struct MobileLyricsTranscription {
        backend: &'static str,
        requested_device: &'static str,
        device: &'static str,
        model_name: String,
        language: Option<String>,
        segments: Vec<Value>,
    }

    #[tauri::command]
    pub fn mobile_capabilities(app: AppHandle) -> Result<MobileCapabilities, String> {
        let root = app_data_root(&app)?;
        let whisper_model = find_whisper_model(&root);
        let is_emulator = is_android_emulator();
        Ok(MobileCapabilities {
            platform: "android",
            media_backend: "android_media_codec",
            is_emulator,
            gpu_backend: None,
            analysis_available: true,
            basic_chords_available: true,
            whisper_available: whisper_model.is_some(),
            stem_separation_available: false,
            generation_testing_available: generation_testing_available(is_emulator),
            max_recommended_model: whisper_model
                .as_ref()
                .map(|model| model.max_recommended_model),
            cpu_fallback_allowed: false,
        })
    }

    fn generation_testing_available(is_emulator: bool) -> bool {
        cfg!(debug_assertions) && is_emulator
    }

    fn is_android_emulator() -> bool {
        let properties = AndroidSystemProperties::new();
        if property_is(&properties, "ro.kernel.qemu", "1")
            || property_is(&properties, "ro.boot.qemu", "1")
        {
            return true;
        }

        [
            ("ro.hardware", &["goldfish", "ranchu"][..]),
            ("ro.product.board", &["goldfish", "ranchu"]),
            ("ro.product.device", &["generic", "emulator", "sdk_gphone"]),
            ("ro.product.model", &["sdk", "emulator"]),
            ("ro.product.name", &["sdk", "emulator"]),
        ]
        .iter()
        .any(|(name, needles)| property_contains_any(&properties, name, needles))
    }

    fn property_is(properties: &AndroidSystemProperties, name: &str, expected: &str) -> bool {
        properties
            .get(name)
            .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
    }

    fn property_contains_any(
        properties: &AndroidSystemProperties,
        name: &str,
        needles: &[&str],
    ) -> bool {
        properties.get(name).is_some_and(|value| {
            let normalized = value.to_ascii_lowercase();
            needles.iter().any(|needle| normalized.contains(needle))
        })
    }

    fn generation_unavailable_message(job_type: &str) -> &'static str {
        let is_emulator = is_android_emulator();
        if generation_testing_available(is_emulator) {
            match job_type {
                "lyrics" => LYRICS_NOT_WIRED,
                "stems" => STEMS_NOT_WIRED,
                _ => GPU_REQUIRED,
            }
        } else {
            GPU_REQUIRED
        }
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn new_id(prefix: &str) -> String {
        format!(
            "{prefix}_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        )
    }

    fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(root)
    }

    fn db(app: &AppHandle) -> Result<Connection, String> {
        let root = app_data_root(app)?;
        db_at_root(&root)
    }

    fn db_at_root(root: &Path) -> Result<Connection, String> {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let connection =
            Connection::open(root.join("mobile.sqlite3")).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    source_key_override TEXT,
                    source_path TEXT NOT NULL,
                    imported_path TEXT NOT NULL,
                    duration_seconds REAL,
                    sample_rate INTEGER,
                    channels INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    format TEXT NOT NULL,
                    path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    generated_by TEXT NOT NULL,
                    can_delete INTEGER NOT NULL,
                    can_regenerate INTEGER NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL,
                    source_artifact_id TEXT,
                    error_message TEXT,
                    runtime_device TEXT,
                    started_at TEXT,
                    completed_at TEXT,
                    duration_seconds REAL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS analysis_results (
                    project_id TEXT PRIMARY KEY,
                    source_artifact_id TEXT,
                    estimated_key TEXT,
                    key_confidence REAL,
                    estimated_reference_hz REAL,
                    tuning_offset_cents REAL,
                    tempo_bpm REAL,
                    analysis_version TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chord_timelines (
                    project_id TEXT PRIMARY KEY,
                    source_segments_json TEXT NOT NULL,
                    timeline_json TEXT NOT NULL,
                    backend TEXT,
                    source_artifact_id TEXT,
                    has_user_edits INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS lyrics_transcripts (
                    project_id TEXT PRIMARY KEY,
                    backend TEXT NOT NULL,
                    source_artifact_id TEXT,
                    source_kind TEXT NOT NULL,
                    requested_device TEXT,
                    device TEXT,
                    model_name TEXT,
                    language TEXT,
                    source_segments_json TEXT NOT NULL,
                    segments_json TEXT NOT NULL,
                    has_user_edits INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                "#,
            )
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn row_project(row: &Row<'_>) -> rusqlite::Result<ProjectSchema> {
        Ok(ProjectSchema {
            id: row.get(0)?,
            display_name: row.get(1)?,
            source_key_override: row.get(2)?,
            source_path: row.get(3)?,
            imported_path: row.get(4)?,
            duration_seconds: row.get(5)?,
            sample_rate: row.get(6)?,
            channels: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    }

    fn row_artifact(row: &Row<'_>) -> rusqlite::Result<ArtifactSchema> {
        let metadata_raw: String = row.get(9)?;
        Ok(ArtifactSchema {
            id: row.get(0)?,
            project_id: row.get(1)?,
            r#type: row.get(2)?,
            format: row.get(3)?,
            path: row.get(4)?,
            size_bytes: row.get(5)?,
            generated_by: row.get(6)?,
            can_delete: row.get::<_, i64>(7)? != 0,
            can_regenerate: row.get::<_, i64>(8)? != 0,
            metadata: serde_json::from_str(&metadata_raw).unwrap_or_else(|_| json!({})),
            created_at: row.get(10)?,
        })
    }

    fn row_job(row: &Row<'_>) -> rusqlite::Result<JobSchema> {
        Ok(JobSchema {
            id: row.get(0)?,
            project_id: row.get(1)?,
            r#type: row.get(2)?,
            status: row.get(3)?,
            progress: row.get(4)?,
            source_artifact_id: row.get(5)?,
            chord_backend: None,
            chord_backend_fallback_from: None,
            chord_source: None,
            error_message: row.get(6)?,
            runtime_device: row.get(7)?,
            started_at: row.get(8)?,
            completed_at: row.get(9)?,
            duration_seconds: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }

    fn get_project_schema(
        connection: &Connection,
        project_id: &str,
    ) -> Result<ProjectSchema, String> {
        connection
            .query_row(
                "SELECT id, display_name, source_key_override, source_path, imported_path, duration_seconds, sample_rate, channels, created_at, updated_at FROM projects WHERE id = ?1",
                params![project_id],
                row_project,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Project not found.".to_string())
    }

    fn create_failed_job(
        connection: &Connection,
        project_id: &str,
        job_type: &str,
        message: &str,
    ) -> Result<JobSchema, String> {
        let timestamp = now_iso();
        let job = JobSchema {
            id: new_id("job"),
            project_id: Some(project_id.to_string()),
            r#type: job_type.to_string(),
            status: "failed".to_string(),
            progress: 0,
            source_artifact_id: None,
            chord_backend: None,
            chord_backend_fallback_from: None,
            chord_source: None,
            error_message: Some(message.to_string()),
            runtime_device: None,
            started_at: Some(timestamp.clone()),
            completed_at: Some(timestamp.clone()),
            duration_seconds: Some(0.0),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        connection
            .execute(
                "INSERT INTO jobs (id, project_id, type, status, progress, source_artifact_id, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    job.id,
                    job.project_id,
                    job.r#type,
                    job.status,
                    job.progress,
                    job.source_artifact_id,
                    job.error_message,
                    job.runtime_device,
                    job.started_at,
                    job.completed_at,
                    job.duration_seconds,
                    job.created_at,
                    job.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(job)
    }

    fn create_completed_job(
        connection: &Connection,
        project_id: &str,
        job_type: &str,
        source_artifact_id: Option<String>,
    ) -> Result<JobSchema, String> {
        let timestamp = now_iso();
        let job = JobSchema {
            id: new_id("job"),
            project_id: Some(project_id.to_string()),
            r#type: job_type.to_string(),
            status: "completed".to_string(),
            progress: 100,
            source_artifact_id,
            chord_backend: None,
            chord_backend_fallback_from: None,
            chord_source: None,
            error_message: None,
            runtime_device: Some("cpu".to_string()),
            started_at: Some(timestamp.clone()),
            completed_at: Some(timestamp.clone()),
            duration_seconds: Some(0.0),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        connection
            .execute(
                "INSERT INTO jobs (id, project_id, type, status, progress, source_artifact_id, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    job.id,
                    job.project_id,
                    job.r#type,
                    job.status,
                    job.progress,
                    job.source_artifact_id,
                    job.error_message,
                    job.runtime_device,
                    job.started_at,
                    job.completed_at,
                    job.duration_seconds,
                    job.created_at,
                    job.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(job)
    }

    fn create_running_job(
        connection: &Connection,
        project_id: &str,
        job_type: &str,
        source_artifact_id: Option<String>,
    ) -> Result<JobSchema, String> {
        let timestamp = now_iso();
        let job = JobSchema {
            id: new_id("job"),
            project_id: Some(project_id.to_string()),
            r#type: job_type.to_string(),
            status: "running".to_string(),
            progress: 5,
            source_artifact_id,
            chord_backend: None,
            chord_backend_fallback_from: None,
            chord_source: None,
            error_message: None,
            runtime_device: Some("cpu".to_string()),
            started_at: Some(timestamp.clone()),
            completed_at: None,
            duration_seconds: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        connection
            .execute(
                "INSERT INTO jobs (id, project_id, type, status, progress, source_artifact_id, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    job.id,
                    job.project_id,
                    job.r#type,
                    job.status,
                    job.progress,
                    job.source_artifact_id,
                    job.error_message,
                    job.runtime_device,
                    job.started_at,
                    job.completed_at,
                    job.duration_seconds,
                    job.created_at,
                    job.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(job)
    }

    fn update_job_progress(
        connection: &Connection,
        job_id: &str,
        progress: i64,
    ) -> Result<(), String> {
        connection
            .execute(
                "UPDATE jobs SET progress = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('pending', 'running')",
                params![progress, now_iso(), job_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn complete_running_job(
        connection: &Connection,
        job_id: &str,
        duration_seconds: f64,
    ) -> Result<(), String> {
        let timestamp = now_iso();
        connection
            .execute(
                "UPDATE jobs SET status = 'completed', progress = 100, error_message = NULL, runtime_device = 'cpu', completed_at = ?1, duration_seconds = ?2, updated_at = ?1 WHERE id = ?3 AND status IN ('pending', 'running')",
                params![timestamp, duration_seconds, job_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn fail_running_job(
        connection: &Connection,
        job_id: &str,
        message: &str,
        duration_seconds: f64,
    ) -> Result<(), String> {
        let timestamp = now_iso();
        connection
            .execute(
                "UPDATE jobs SET status = 'failed', progress = 0, error_message = ?1, completed_at = ?2, duration_seconds = ?3, updated_at = ?2 WHERE id = ?4 AND status IN ('pending', 'running')",
                params![message, timestamp, duration_seconds, job_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn get_source_artifact(
        connection: &Connection,
        project_id: &str,
    ) -> Result<ArtifactSchema, String> {
        connection
            .query_row(
                "SELECT id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at FROM artifacts WHERE project_id = ?1 AND type = 'source_audio' ORDER BY created_at DESC LIMIT 1",
                params![project_id],
                row_artifact,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Source audio is missing.".to_string())
    }

    struct MobileAudioFeatures {
        duration_seconds: f64,
        sample_rate: i64,
        channels: i64,
        pitch_classes: [f64; 12],
    }

    fn read_mobile_audio(path: &Path) -> Result<DecodedAudio, String> {
        match read_wav_audio(path) {
            Ok(audio) => Ok(audio),
            Err(wav_error) => read_android_media_audio(path).map_err(|media_error| {
                format!(
                    "Mobile audio decode supports PCM WAV files and formats Android MediaCodec can decode. WAV decode failed: {wav_error}. Android MediaCodec decode failed: {media_error}"
                )
            }),
        }
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

    fn create_playback_proxy_if_needed(project_root: &Path, source_path: &Path) -> Option<PathBuf> {
        let format = source_format(source_path);
        if !matches!(format.as_str(), "webm" | "mkv" | "mka") {
            return None;
        }

        let audio = read_mobile_audio(source_path).ok()?;
        if audio.samples.is_empty() || audio.sample_rate == 0 {
            return None;
        }

        let playback_dir = project_root.join("playback");
        fs::create_dir_all(&playback_dir).ok()?;
        let playback_path = playback_dir.join("source-playback.wav");
        write_mono_pcm_wav(&playback_path, &audio).ok()?;
        Some(playback_path)
    }

    fn spawn_playback_proxy_generation(
        root: PathBuf,
        project_root: PathBuf,
        source_path: PathBuf,
        artifact_id: String,
    ) {
        if !matches!(source_format(&source_path).as_str(), "webm" | "mkv" | "mka") {
            return;
        }

        thread::spawn(move || {
            let Some(playback_path) = create_playback_proxy_if_needed(&project_root, &source_path)
            else {
                return;
            };
            let Ok(connection) = db_at_root(&root) else {
                return;
            };
            let _ = attach_playback_proxy_metadata(&connection, &artifact_id, &playback_path);
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
        let mut metadata =
            serde_json::from_str::<Value>(&metadata_json).unwrap_or_else(|_| json!({}));
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

    fn write_mono_pcm_wav(path: &Path, audio: &DecodedAudio) -> Result<(), String> {
        if audio.sample_rate == 0 {
            return Err("Decoded audio contained invalid stream metadata.".to_string());
        }
        let data_bytes = audio
            .samples
            .len()
            .checked_mul(2)
            .ok_or_else(|| "Decoded audio is too large for a playback proxy.".to_string())?;
        let riff_size = 36usize
            .checked_add(data_bytes)
            .ok_or_else(|| "Decoded audio is too large for a playback proxy.".to_string())?;
        let data_bytes = u32::try_from(data_bytes)
            .map_err(|_| "Decoded audio is too large for a playback proxy.".to_string())?;
        let riff_size = u32::try_from(riff_size)
            .map_err(|_| "Decoded audio is too large for a playback proxy.".to_string())?;
        let byte_rate = audio
            .sample_rate
            .checked_mul(2)
            .ok_or_else(|| "Decoded audio sample rate is invalid.".to_string())?;

        let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&riff_size.to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&audio.sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_bytes.to_le_bytes());

        for sample in &audio.samples {
            let scaled = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            bytes.extend_from_slice(&scaled.to_le_bytes());
        }

        fs::write(path, bytes).map_err(|error| error.to_string())
    }

    fn read_wav_audio(path: &Path) -> Result<DecodedAudio, String> {
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err("Not a PCM WAV file.".to_string());
        }

        let mut audio_format = 0u16;
        let mut channels = 0u16;
        let mut sample_rate = 0u32;
        let mut block_align = 0u16;
        let mut bits_per_sample = 0u16;
        let mut data_range: Option<(usize, usize)> = None;
        let mut offset = 12usize;
        while offset + 8 <= bytes.len() {
            let chunk_id = &bytes[offset..offset + 4];
            let chunk_size = read_u32_le(&bytes, offset + 4)
                .ok_or_else(|| "Invalid WAV chunk header.".to_string())?
                as usize;
            let chunk_start = offset + 8;
            let chunk_end = chunk_start.saturating_add(chunk_size);
            if chunk_end > bytes.len() {
                return Err("Invalid WAV chunk size.".to_string());
            }
            if chunk_id == b"fmt " {
                if chunk_size < 16 {
                    return Err("Invalid WAV fmt chunk.".to_string());
                }
                audio_format = read_u16_le(&bytes, chunk_start)
                    .ok_or_else(|| "Invalid WAV audio format.".to_string())?;
                channels = read_u16_le(&bytes, chunk_start + 2)
                    .ok_or_else(|| "Invalid WAV channel count.".to_string())?;
                sample_rate = read_u32_le(&bytes, chunk_start + 4)
                    .ok_or_else(|| "Invalid WAV sample rate.".to_string())?;
                block_align = read_u16_le(&bytes, chunk_start + 12)
                    .ok_or_else(|| "Invalid WAV block alignment.".to_string())?;
                bits_per_sample = read_u16_le(&bytes, chunk_start + 14)
                    .ok_or_else(|| "Invalid WAV bit depth.".to_string())?;
            } else if chunk_id == b"data" {
                data_range = Some((chunk_start, chunk_end));
            }
            offset = chunk_end + (chunk_size % 2);
        }

        if audio_format != 1 && audio_format != 3 {
            return Err("Lyrics WAV decode supports PCM and 32-bit float WAV files.".to_string());
        }
        if channels == 0 || sample_rate == 0 || block_align == 0 || bits_per_sample == 0 {
            return Err("Invalid WAV stream metadata.".to_string());
        }
        let (data_start, data_end) =
            data_range.ok_or_else(|| "WAV data chunk is missing.".to_string())?;
        let frame_count = (data_end - data_start) / block_align as usize;
        let bytes_per_sample = (bits_per_sample / 8) as usize;
        if bytes_per_sample == 0 {
            return Err("Invalid WAV bit depth.".to_string());
        }

        let mut samples = Vec::with_capacity(frame_count);
        for frame_index in 0..frame_count {
            let frame_start = data_start + frame_index * block_align as usize;
            let mut sum = 0.0;
            for channel_index in 0..channels as usize {
                let sample_offset = frame_start + channel_index * bytes_per_sample;
                sum += decode_wav_sample(&bytes, sample_offset, audio_format, bits_per_sample)?;
            }
            samples.push((sum / channels as f64).clamp(-1.0, 1.0) as f32);
        }

        Ok(DecodedAudio {
            samples,
            sample_rate,
            channels: channels as u32,
        })
    }

    struct MediaExtractorHandle {
        ptr: *mut ndk_sys::AMediaExtractor,
        data_source_file: Option<fs::File>,
    }

    impl MediaExtractorHandle {
        fn new() -> Result<Self, String> {
            let ptr = unsafe { ndk_sys::AMediaExtractor_new() };
            if ptr.is_null() {
                return Err("Android MediaExtractor could not be created.".to_string());
            }
            Ok(Self {
                ptr,
                data_source_file: None,
            })
        }

        fn set_data_source(&mut self, path: &Path) -> Result<(), String> {
            let file = fs::File::open(path).map_err(|error| {
                format!("Android MediaExtractor could not open the imported audio: {error}")
            })?;
            let length: ndk_sys::off64_t = file
                .metadata()
                .map_err(|error| {
                    format!("Android MediaExtractor could not inspect the imported audio: {error}")
                })?
                .len()
                .try_into()
                .map_err(|_| {
                    "Imported audio is too large for Android MediaExtractor.".to_string()
                })?;
            let fd_status = unsafe {
                ndk_sys::AMediaExtractor_setDataSourceFd(self.ptr, file.as_raw_fd(), 0, length)
            };
            if fd_status == ndk_sys::media_status_t::AMEDIA_OK {
                self.data_source_file = Some(file);
                return Ok(());
            }

            let path = CString::new(path.to_string_lossy().as_bytes())
                .map_err(|_| "Audio path contains an invalid null byte.".to_string())?;
            let status = unsafe { ndk_sys::AMediaExtractor_setDataSource(self.ptr, path.as_ptr()) };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android MediaExtractor could not open the imported audio.".to_string());
            }
            Ok(())
        }
    }

    impl Drop for MediaExtractorHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = ndk_sys::AMediaExtractor_delete(self.ptr);
            }
        }
    }

    struct MediaFormatHandle(*mut ndk_sys::AMediaFormat);

    impl MediaFormatHandle {
        fn from_track(extractor: &MediaExtractorHandle, index: usize) -> Result<Self, String> {
            let ptr = unsafe { ndk_sys::AMediaExtractor_getTrackFormat(extractor.ptr, index) };
            if ptr.is_null() {
                return Err("Android MediaExtractor returned an invalid track format.".to_string());
            }
            Ok(Self(ptr))
        }
    }

    impl Drop for MediaFormatHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = ndk_sys::AMediaFormat_delete(self.0);
            }
        }
    }

    struct MediaCodecHandle {
        ptr: *mut ndk_sys::AMediaCodec,
        started: bool,
    }

    impl MediaCodecHandle {
        fn new(mime: &str) -> Result<Self, String> {
            let mime = CString::new(mime)
                .map_err(|_| "Audio MIME type contains a null byte.".to_string())?;
            let ptr = unsafe { ndk_sys::AMediaCodec_createDecoderByType(mime.as_ptr()) };
            if ptr.is_null() {
                return Err("Android MediaCodec has no decoder for this audio format.".to_string());
            }
            Ok(Self {
                ptr,
                started: false,
            })
        }

        fn configure(&self, format: &MediaFormatHandle) -> Result<(), String> {
            let status = unsafe {
                ndk_sys::AMediaCodec_configure(
                    self.ptr,
                    format.0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    0,
                )
            };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android MediaCodec could not configure the audio decoder.".to_string());
            }
            Ok(())
        }

        fn start(&mut self) -> Result<(), String> {
            let status = unsafe { ndk_sys::AMediaCodec_start(self.ptr) };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android MediaCodec could not start the audio decoder.".to_string());
            }
            self.started = true;
            Ok(())
        }
    }

    impl Drop for MediaCodecHandle {
        fn drop(&mut self) {
            unsafe {
                if self.started {
                    let _ = ndk_sys::AMediaCodec_stop(self.ptr);
                }
                let _ = ndk_sys::AMediaCodec_delete(self.ptr);
            }
        }
    }

    fn media_format_string(
        format: &MediaFormatHandle,
        key: *const c_char,
    ) -> Result<Option<String>, String> {
        let mut value: *const c_char = ptr::null();
        let found = unsafe { ndk_sys::AMediaFormat_getString(format.0, key, &mut value) };
        if !found || value.is_null() {
            return Ok(None);
        }
        let value = unsafe { CStr::from_ptr(value) }
            .to_str()
            .map_err(|_| "Android media format contained invalid UTF-8.".to_string())?
            .to_string();
        Ok(Some(value))
    }

    fn media_format_i32(format: *mut ndk_sys::AMediaFormat, key: *const c_char) -> Option<i32> {
        let mut value = 0i32;
        let found = unsafe { ndk_sys::AMediaFormat_getInt32(format, key, &mut value) };
        found.then_some(value)
    }

    fn media_format_handle_i32(format: &MediaFormatHandle, key: *const c_char) -> Option<i32> {
        media_format_i32(format.0, key)
    }

    fn read_android_media_audio(path: &Path) -> Result<DecodedAudio, String> {
        const TIMEOUT_US: i64 = 10_000;
        const PCM_ENCODING_16BIT: i32 = 2;
        const PCM_ENCODING_FLOAT: i32 = 4;

        let mut extractor = MediaExtractorHandle::new()?;
        extractor.set_data_source(path)?;

        let track_count = unsafe { ndk_sys::AMediaExtractor_getTrackCount(extractor.ptr) };
        let mut selected_track = None;
        let mut selected_format = None;
        let mut selected_mime = None;
        for track_index in 0..track_count {
            let format = MediaFormatHandle::from_track(&extractor, track_index)?;
            let mime = media_format_string(&format, unsafe { ndk_sys::AMEDIAFORMAT_KEY_MIME })?;
            if mime
                .as_deref()
                .is_some_and(|value| value.starts_with("audio/"))
            {
                selected_track = Some(track_index);
                selected_mime = mime;
                selected_format = Some(format);
                break;
            }
        }

        let track_index = selected_track.ok_or_else(|| {
            "Android MediaExtractor did not find an audio track in the imported file.".to_string()
        })?;
        let format = selected_format
            .ok_or_else(|| "Android MediaExtractor lost the selected audio format.".to_string())?;
        let mime = selected_mime.ok_or_else(|| {
            "Android MediaExtractor did not report an audio MIME type.".to_string()
        })?;

        let sample_rate =
            media_format_handle_i32(&format, unsafe { ndk_sys::AMEDIAFORMAT_KEY_SAMPLE_RATE })
                .ok_or_else(|| {
                    "Android MediaExtractor did not report an audio sample rate.".to_string()
                })?;
        let channels =
            media_format_handle_i32(&format, unsafe { ndk_sys::AMEDIAFORMAT_KEY_CHANNEL_COUNT })
                .ok_or_else(|| {
                    "Android MediaExtractor did not report an audio channel count.".to_string()
                })?;
        if sample_rate <= 0 || channels <= 0 {
            return Err("Android MediaExtractor reported invalid audio metadata.".to_string());
        }

        let status = unsafe { ndk_sys::AMediaExtractor_selectTrack(extractor.ptr, track_index) };
        if status != ndk_sys::media_status_t::AMEDIA_OK {
            return Err("Android MediaExtractor could not select the audio track.".to_string());
        }

        let mut codec = MediaCodecHandle::new(&mime)?;
        codec.configure(&format)?;
        codec.start()?;

        let mut output_sample_rate = sample_rate;
        let mut output_channels = channels;
        let mut output_encoding = PCM_ENCODING_16BIT;
        let mut decoded = Vec::new();
        let mut input_eos = false;
        let mut output_eos = false;
        let mut idle_iterations = 0usize;

        while !output_eos {
            let mut made_progress = false;
            if !input_eos {
                let input_index =
                    unsafe { ndk_sys::AMediaCodec_dequeueInputBuffer(codec.ptr, TIMEOUT_US) };
                if input_index >= 0 {
                    let mut input_capacity = 0usize;
                    let input_buffer = unsafe {
                        ndk_sys::AMediaCodec_getInputBuffer(
                            codec.ptr,
                            input_index as usize,
                            &mut input_capacity,
                        )
                    };
                    if input_buffer.is_null() {
                        return Err(
                            "Android MediaCodec returned an invalid input buffer.".to_string()
                        );
                    }
                    let sample_size = unsafe {
                        ndk_sys::AMediaExtractor_readSampleData(
                            extractor.ptr,
                            input_buffer,
                            input_capacity,
                        )
                    };
                    if sample_size < 0 {
                        let status = unsafe {
                            ndk_sys::AMediaCodec_queueInputBuffer(
                                codec.ptr,
                                input_index as usize,
                                0,
                                0,
                                0,
                                ndk_sys::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM,
                            )
                        };
                        if status != ndk_sys::media_status_t::AMEDIA_OK {
                            return Err("Android MediaCodec could not queue audio end-of-stream."
                                .to_string());
                        }
                        input_eos = true;
                    } else {
                        let sample_time =
                            unsafe { ndk_sys::AMediaExtractor_getSampleTime(extractor.ptr) };
                        let sample_flags =
                            unsafe { ndk_sys::AMediaExtractor_getSampleFlags(extractor.ptr) };
                        let status = unsafe {
                            ndk_sys::AMediaCodec_queueInputBuffer(
                                codec.ptr,
                                input_index as usize,
                                0,
                                sample_size as usize,
                                sample_time.max(0) as u64,
                                sample_flags,
                            )
                        };
                        if status != ndk_sys::media_status_t::AMEDIA_OK {
                            return Err(
                                "Android MediaCodec could not queue compressed audio.".to_string()
                            );
                        }
                        unsafe {
                            ndk_sys::AMediaExtractor_advance(extractor.ptr);
                        }
                    }
                    made_progress = true;
                }
            }

            let mut info: ndk_sys::AMediaCodecBufferInfo = unsafe { mem::zeroed() };
            let output_index = unsafe {
                ndk_sys::AMediaCodec_dequeueOutputBuffer(codec.ptr, &mut info, TIMEOUT_US)
            };
            if output_index >= 0 {
                let mut output_capacity = 0usize;
                let output_buffer = unsafe {
                    ndk_sys::AMediaCodec_getOutputBuffer(
                        codec.ptr,
                        output_index as usize,
                        &mut output_capacity,
                    )
                };
                if output_buffer.is_null() {
                    return Err("Android MediaCodec returned an invalid output buffer.".to_string());
                }
                let offset = info.offset.max(0) as usize;
                let size = info.size.max(0) as usize;
                if size > 0 {
                    let end = offset.saturating_add(size);
                    if end > output_capacity {
                        return Err(
                            "Android MediaCodec returned an invalid output range.".to_string()
                        );
                    }
                    let output = unsafe { slice::from_raw_parts(output_buffer.add(offset), size) };
                    decoded.extend_from_slice(output);
                }
                if info.flags & ndk_sys::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM != 0 {
                    output_eos = true;
                }
                unsafe {
                    ndk_sys::AMediaCodec_releaseOutputBuffer(
                        codec.ptr,
                        output_index as usize,
                        false,
                    );
                }
                made_progress = true;
            } else if output_index == ndk_sys::AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED as isize {
                let output_format = unsafe { ndk_sys::AMediaCodec_getOutputFormat(codec.ptr) };
                if !output_format.is_null() {
                    output_sample_rate = media_format_i32(output_format, unsafe {
                        ndk_sys::AMEDIAFORMAT_KEY_SAMPLE_RATE
                    })
                    .unwrap_or(output_sample_rate);
                    output_channels = media_format_i32(output_format, unsafe {
                        ndk_sys::AMEDIAFORMAT_KEY_CHANNEL_COUNT
                    })
                    .unwrap_or(output_channels);
                    output_encoding = media_format_i32(output_format, unsafe {
                        ndk_sys::AMEDIAFORMAT_KEY_PCM_ENCODING
                    })
                    .unwrap_or(PCM_ENCODING_16BIT);
                    unsafe {
                        let _ = ndk_sys::AMediaFormat_delete(output_format);
                    }
                }
                made_progress = true;
            } else if output_index != ndk_sys::AMEDIACODEC_INFO_TRY_AGAIN_LATER as isize {
                return Err("Android MediaCodec failed while decoding audio.".to_string());
            }

            if made_progress {
                idle_iterations = 0;
            } else {
                idle_iterations += 1;
                if idle_iterations > 2_000 {
                    return Err("Android MediaCodec timed out while decoding audio.".to_string());
                }
            }
        }

        match output_encoding {
            PCM_ENCODING_16BIT => {
                pcm_i16_bytes_to_mono(&decoded, output_sample_rate, output_channels)
            }
            PCM_ENCODING_FLOAT => {
                pcm_f32_bytes_to_mono(&decoded, output_sample_rate, output_channels)
            }
            _ => Err("Android MediaCodec returned an unsupported PCM output encoding.".to_string()),
        }
    }

    fn pcm_i16_bytes_to_mono(
        bytes: &[u8],
        sample_rate: i32,
        channels: i32,
    ) -> Result<DecodedAudio, String> {
        if sample_rate <= 0 || channels <= 0 {
            return Err("Android MediaCodec returned invalid PCM metadata.".to_string());
        }
        let channel_count = channels as usize;
        let frame_bytes = channel_count
            .checked_mul(2)
            .ok_or_else(|| "Android MediaCodec returned invalid channel metadata.".to_string())?;
        if frame_bytes == 0 {
            return Err("Android MediaCodec returned invalid channel metadata.".to_string());
        }
        let frame_count = bytes.len() / frame_bytes;
        let mut samples = Vec::with_capacity(frame_count);
        for frame_index in 0..frame_count {
            let frame_start = frame_index * frame_bytes;
            let mut sum = 0.0f32;
            for channel_index in 0..channel_count {
                let sample_start = frame_start + channel_index * 2;
                let raw = i16::from_le_bytes(
                    bytes
                        .get(sample_start..sample_start + 2)
                        .ok_or_else(|| {
                            "Android MediaCodec returned truncated PCM data.".to_string()
                        })?
                        .try_into()
                        .map_err(|_| "Android MediaCodec returned invalid PCM data.".to_string())?,
                );
                sum += raw as f32 / i16::MAX as f32;
            }
            samples.push((sum / channel_count as f32).clamp(-1.0, 1.0));
        }
        Ok(DecodedAudio {
            samples,
            sample_rate: sample_rate as u32,
            channels: channels as u32,
        })
    }

    fn pcm_f32_bytes_to_mono(
        bytes: &[u8],
        sample_rate: i32,
        channels: i32,
    ) -> Result<DecodedAudio, String> {
        if sample_rate <= 0 || channels <= 0 {
            return Err("Android MediaCodec returned invalid PCM metadata.".to_string());
        }
        let channel_count = channels as usize;
        let frame_bytes = channel_count
            .checked_mul(4)
            .ok_or_else(|| "Android MediaCodec returned invalid channel metadata.".to_string())?;
        if frame_bytes == 0 {
            return Err("Android MediaCodec returned invalid channel metadata.".to_string());
        }
        let frame_count = bytes.len() / frame_bytes;
        let mut samples = Vec::with_capacity(frame_count);
        for frame_index in 0..frame_count {
            let frame_start = frame_index * frame_bytes;
            let mut sum = 0.0f32;
            for channel_index in 0..channel_count {
                let sample_start = frame_start + channel_index * 4;
                let raw = f32::from_le_bytes(
                    bytes
                        .get(sample_start..sample_start + 4)
                        .ok_or_else(|| {
                            "Android MediaCodec returned truncated PCM data.".to_string()
                        })?
                        .try_into()
                        .map_err(|_| "Android MediaCodec returned invalid PCM data.".to_string())?,
                );
                sum += raw;
            }
            samples.push((sum / channel_count as f32).clamp(-1.0, 1.0));
        }
        Ok(DecodedAudio {
            samples,
            sample_rate: sample_rate as u32,
            channels: channels as u32,
        })
    }

    fn read_lyrics_audio(path: &Path) -> Result<DecodedAudio, String> {
        let decoded = read_mobile_audio(path)?;
        Ok(DecodedAudio {
            samples: resample_mono(&decoded.samples, decoded.sample_rate, WHISPER_SAMPLE_RATE),
            sample_rate: WHISPER_SAMPLE_RATE,
            channels: 1,
        })
    }

    fn resample_mono(
        samples: &[f32],
        source_sample_rate: u32,
        target_sample_rate: u32,
    ) -> Vec<f32> {
        if samples.is_empty() || source_sample_rate == 0 || source_sample_rate == target_sample_rate
        {
            return samples.to_vec();
        }

        let output_len = ((samples.len() as f64) * target_sample_rate as f64
            / source_sample_rate as f64)
            .ceil()
            .max(1.0) as usize;
        let ratio = source_sample_rate as f64 / target_sample_rate as f64;
        let mut output = Vec::with_capacity(output_len);
        for index in 0..output_len {
            let source_position = index as f64 * ratio;
            let left_index = source_position.floor() as usize;
            let right_index = (left_index + 1).min(samples.len().saturating_sub(1));
            let fraction = (source_position - left_index as f64) as f32;
            let left = samples[left_index];
            let right = samples[right_index];
            output.push(left + (right - left) * fraction);
        }
        output
    }

    fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            bytes.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }

    fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            bytes.get(offset..offset + 4)?.try_into().ok()?,
        ))
    }

    fn decode_wav_sample(
        bytes: &[u8],
        offset: usize,
        audio_format: u16,
        bits_per_sample: u16,
    ) -> Result<f64, String> {
        match (audio_format, bits_per_sample) {
            (1, 8) => Ok((bytes
                .get(offset)
                .copied()
                .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                as f64
                - 128.0)
                / 128.0),
            (1, 16) => {
                let raw = i16::from_le_bytes(
                    bytes
                        .get(offset..offset + 2)
                        .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                        .try_into()
                        .map_err(|_| "Invalid WAV sample data.".to_string())?,
                );
                Ok(raw as f64 / i16::MAX as f64)
            }
            (1, 24) => {
                let sample = bytes
                    .get(offset..offset + 3)
                    .ok_or_else(|| "Invalid WAV sample data.".to_string())?;
                let raw =
                    (sample[0] as i32) | ((sample[1] as i32) << 8) | ((sample[2] as i32) << 16);
                let signed = if raw & 0x800000 != 0 {
                    raw | !0x00ff_ffff
                } else {
                    raw
                };
                Ok(signed as f64 / 8_388_608.0)
            }
            (1, 32) => {
                let raw = i32::from_le_bytes(
                    bytes
                        .get(offset..offset + 4)
                        .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                        .try_into()
                        .map_err(|_| "Invalid WAV sample data.".to_string())?,
                );
                Ok(raw as f64 / i32::MAX as f64)
            }
            (3, 32) => {
                let raw = f32::from_le_bytes(
                    bytes
                        .get(offset..offset + 4)
                        .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                        .try_into()
                        .map_err(|_| "Invalid WAV sample data.".to_string())?,
                );
                Ok(raw as f64)
            }
            _ => Err(
                "Mobile CPU analysis currently supports 8/16/24/32-bit PCM WAV files.".to_string(),
            ),
        }
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
                "INSERT INTO analysis_results (project_id, source_artifact_id, estimated_key, key_confidence, estimated_reference_hz, tuning_offset_cents, tempo_bpm, analysis_version, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?6)
                 ON CONFLICT(project_id) DO UPDATE SET source_artifact_id = excluded.source_artifact_id, estimated_key = excluded.estimated_key, key_confidence = excluded.key_confidence, estimated_reference_hz = excluded.estimated_reference_hz, tuning_offset_cents = excluded.tuning_offset_cents, tempo_bpm = excluded.tempo_bpm, analysis_version = excluded.analysis_version, created_at = excluded.created_at",
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

        let analysis_dir = root.join("projects").join(&project.id).join("analysis");
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
        connection
            .execute(
                "DELETE FROM artifacts WHERE project_id = ?1 AND type = 'analysis_json'",
                params![project.id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at)
                 VALUES (?1, ?2, 'analysis_json', 'json', ?3, ?4, 'analysis', 0, 1, ?5, ?6)",
                params![
                    new_id("art"),
                    project.id,
                    analysis_path.to_string_lossy().into_owned(),
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

    fn get_analysis_value(
        connection: &Connection,
        project_id: &str,
    ) -> Result<Option<Value>, String> {
        connection
            .query_row(
                "SELECT project_id, source_artifact_id, estimated_key, key_confidence, estimated_reference_hz, tuning_offset_cents, tempo_bpm, analysis_version, created_at FROM analysis_results WHERE project_id = ?1",
                params![project_id],
                |row| {
                    Ok(json!({
                        "project_id": row.get::<_, String>(0)?,
                        "source_artifact_id": row.get::<_, Option<String>>(1)?,
                        "estimated_key": row.get::<_, Option<String>>(2)?,
                        "key_confidence": row.get::<_, Option<f64>>(3)?,
                        "estimated_reference_hz": row.get::<_, Option<f64>>(4)?,
                        "tuning_offset_cents": row.get::<_, Option<f64>>(5)?,
                        "tempo_bpm": row.get::<_, Option<f64>>(6)?,
                        "analysis_version": row.get::<_, String>(7)?,
                        "created_at": row.get::<_, String>(8)?,
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
                "INSERT INTO chord_timelines (project_id, source_segments_json, timeline_json, backend, source_artifact_id, has_user_edits, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'mobile-cpu-basic', ?4, 0, ?5, ?5)
                 ON CONFLICT(project_id) DO UPDATE SET source_segments_json = excluded.source_segments_json, timeline_json = excluded.timeline_json, backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, has_user_edits = excluded.has_user_edits, updated_at = excluded.updated_at",
                params![
                    project.id,
                    timeline_json,
                    timeline_json,
                    source_artifact.id,
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

        let chord_path = root
            .join("projects")
            .join(&project.id)
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

    fn get_chord_response(
        connection: &Connection,
        project_id: String,
    ) -> Result<ChordResponse, String> {
        connection
            .query_row(
                "SELECT project_id, source_segments_json, timeline_json, backend, source_artifact_id, has_user_edits, created_at, updated_at FROM chord_timelines WHERE project_id = ?1",
                params![project_id],
                |row| {
                    let source_segments_raw: String = row.get(1)?;
                    let timeline_raw: String = row.get(2)?;
                    let source_segments = serde_json::from_str(&source_segments_raw).unwrap_or_default();
                    let timeline = serde_json::from_str(&timeline_raw).unwrap_or_default();
                    Ok(ChordResponse {
                        project_id: row.get(0)?,
                        source_segments,
                        timeline,
                        backend: row.get(3)?,
                        source_artifact_id: row.get(4)?,
                        has_user_edits: row.get::<_, i64>(5)? != 0,
                        source_kind: "generated".to_string(),
                        metadata: json!({}),
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
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

    fn find_whisper_model(root: &Path) -> Option<WhisperModel> {
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
                "SELECT project_id, backend, source_artifact_id, source_kind, requested_device, device, model_name, language, source_segments_json, segments_json, has_user_edits, created_at, updated_at FROM lyrics_transcripts WHERE project_id = ?1",
                params![project_id],
                |row| {
                    let source_segments_raw: String = row.get(8)?;
                    let segments_raw: String = row.get(9)?;
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
                        source_segments,
                        segments,
                        has_user_edits: row.get::<_, i64>(10)? != 0,
                        created_at: row.get(11)?,
                        updated_at: row.get(12)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .map(Ok)
            .unwrap_or_else(|| Ok(empty_lyrics(project_id)))
    }

    fn write_lyrics_snapshot(root: &Path, lyrics: &LyricsResponse) -> Result<(), String> {
        let lyrics_path = root
            .join("projects")
            .join(&lyrics.project_id)
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
                "INSERT INTO lyrics_transcripts (project_id, backend, source_artifact_id, source_kind, requested_device, device, model_name, language, source_segments_json, segments_json, has_user_edits, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'ai', ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)
                 ON CONFLICT(project_id) DO UPDATE SET backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, source_kind = excluded.source_kind, requested_device = excluded.requested_device, device = excluded.device, model_name = excluded.model_name, language = excluded.language, source_segments_json = excluded.source_segments_json, segments_json = excluded.segments_json, has_user_edits = excluded.has_user_edits, updated_at = excluded.updated_at",
                params![
                    project.id,
                    transcription.backend,
                    source_artifact.id,
                    transcription.requested_device,
                    transcription.device,
                    transcription.model_name,
                    transcription.language,
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
    ) -> Result<MobileLyricsTranscription, String> {
        let audio = read_lyrics_audio(source_path)?;
        if audio.samples.is_empty() {
            return Err(
                "Imported audio did not contain samples for lyrics transcription.".to_string(),
            );
        }

        install_logging_hooks();
        let context =
            WhisperContext::new_with_params(&model.path, WhisperContextParameters::default())
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
        params.set_language(None);
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

        Ok(MobileLyricsTranscription {
            backend: "whisper.cpp",
            requested_device: "cpu",
            device: "cpu",
            model_name: model.name.to_string(),
            language: whisper_rs::get_lang_str(state.full_lang_id_from_state())
                .map(ToString::to_string),
            segments,
        })
    }

    fn run_lyrics_job(
        root: PathBuf,
        job_id: String,
        project: ProjectSchema,
        source_artifact: ArtifactSchema,
        model: WhisperModel,
    ) {
        let started = Instant::now();
        let connection = match db_at_root(&root) {
            Ok(connection) => connection,
            Err(_) => return,
        };

        let result = (|| {
            update_job_progress(&connection, &job_id, 15)?;
            let transcription =
                transcribe_project_lyrics(Path::new(&project.imported_path), &model)?;
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
                let _ = complete_running_job(&connection, &job_id, duration_seconds);
            }
            Err(message) => {
                let _ = fail_running_job(&connection, &job_id, &message, duration_seconds);
            }
        }
    }

    fn is_android_file_uri(source_path: &str) -> bool {
        source_path.starts_with("content://") || source_path.starts_with("file://")
    }

    fn source_filename(app: &AppHandle, source_path: &str) -> String {
        if is_android_file_uri(source_path) {
            return app
                .path()
                .file_name(source_path)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "imported-audio".to_string());
        }

        Path::new(source_path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("imported-audio")
            .to_string()
    }

    fn source_stem(file_name: &str) -> String {
        Path::new(file_name)
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Imported Track")
            .to_string()
    }

    fn source_format(path: &Path) -> String {
        path.extension()
            .and_then(|extension| extension.to_str())
            .filter(|extension| !extension.is_empty())
            .unwrap_or("audio")
            .to_ascii_lowercase()
    }

    fn copy_source_into_project(
        app: &AppHandle,
        source_path: &str,
        target: &Path,
    ) -> Result<(), String> {
        if is_android_file_uri(source_path) {
            let mut options = OpenOptions::new();
            options.read(true);
            let source = FilePath::from_str(source_path).map_err(|error| error.to_string())?;
            let mut input = app
                .fs()
                .open(source, options)
                .map_err(|error| error.to_string())?;
            let mut output = fs::File::create(target).map_err(|error| error.to_string())?;
            io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
            return Ok(());
        }

        fs::copy(source_path, target).map_err(|error| error.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn mobile_get_health(app: AppHandle) -> Result<HealthResponse, String> {
        let root = app_data_root(&app)?;
        Ok(HealthResponse {
            name: "Tuneforge Mobile".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            status: "ok".to_string(),
            api_base_url: "mobile://embedded".to_string(),
            data_root: root.to_string_lossy().into_owned(),
            default_export_format: "m4a".to_string(),
            preview_format: "m4a".to_string(),
        })
    }

    #[tauri::command]
    pub fn mobile_list_projects(
        app: AppHandle,
        search: Option<String>,
    ) -> Result<ProjectsResponse, String> {
        let connection = db(&app)?;
        let mut statement = connection
            .prepare("SELECT id, display_name, source_key_override, source_path, imported_path, duration_seconds, sample_rate, channels, created_at, updated_at FROM projects ORDER BY updated_at DESC")
            .map_err(|error| error.to_string())?;
        let needle = search.unwrap_or_default().to_ascii_lowercase();
        let rows = statement
            .query_map([], row_project)
            .map_err(|error| error.to_string())?;
        let mut projects = Vec::new();
        for row in rows {
            let project = row.map_err(|error| error.to_string())?;
            if needle.is_empty()
                || project.display_name.to_ascii_lowercase().contains(&needle)
                || project.source_path.to_ascii_lowercase().contains(&needle)
                || project.imported_path.to_ascii_lowercase().contains(&needle)
            {
                projects.push(project);
            }
        }
        Ok(ProjectsResponse { projects })
    }

    #[tauri::command]
    pub fn mobile_import_project(
        app: AppHandle,
        payload: ProjectImportRequest,
    ) -> Result<ProjectResponse, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        let source_is_uri = is_android_file_uri(&payload.source_path);
        let source = PathBuf::from(&payload.source_path);
        if !source_is_uri && !source.exists() {
            return Err("Selected audio file does not exist.".to_string());
        }

        let project_id = new_id("proj");
        let project_root = root.join("projects").join(&project_id);
        let source_dir = project_root.join("source");
        fs::create_dir_all(&source_dir).map_err(|error| error.to_string())?;
        let source_file_name = source_filename(&app, &payload.source_path);
        let imported_path = if payload.copy_into_project || source_is_uri {
            let target = source_dir.join(&source_file_name);
            copy_source_into_project(&app, &payload.source_path, &target)?;
            target
        } else {
            source.clone()
        };
        let timestamp = now_iso();
        let display_name = payload
            .display_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| source_stem(&source_file_name));
        let project = ProjectSchema {
            id: project_id.clone(),
            display_name,
            source_key_override: None,
            source_path: payload.source_path.clone(),
            imported_path: imported_path.to_string_lossy().into_owned(),
            duration_seconds: None,
            sample_rate: None,
            channels: None,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        };
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_key_override, source_path, imported_path, duration_seconds, sample_rate, channels, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    project.id,
                    project.display_name,
                    project.source_key_override,
                    project.source_path,
                    project.imported_path,
                    project.duration_seconds,
                    project.sample_rate,
                    project.channels,
                    project.created_at,
                    project.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;

        let size_bytes = fs::metadata(&imported_path)
            .map(|metadata| metadata.len() as i64)
            .unwrap_or(0);
        let source_artifact_id = new_id("art");
        let artifact_metadata = json!({ "source_path": payload.source_path });

        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at)
                 VALUES (?1, ?2, 'source_audio', ?3, ?4, ?5, 'import', 0, 0, ?6, ?7)",
                params![
                    &source_artifact_id,
                    &project_id,
                    source_format(&imported_path),
                    imported_path.to_string_lossy().into_owned(),
                    size_bytes,
                    artifact_metadata.to_string(),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

        spawn_playback_proxy_generation(root, project_root, imported_path, source_artifact_id);

        Ok(ProjectResponse { project })
    }

    #[tauri::command]
    pub fn mobile_get_project(
        app: AppHandle,
        project_id: String,
    ) -> Result<ProjectResponse, String> {
        let connection = db(&app)?;
        Ok(ProjectResponse {
            project: get_project_schema(&connection, &project_id)?,
        })
    }

    #[tauri::command]
    pub fn mobile_update_project(
        app: AppHandle,
        project_id: String,
        payload: ProjectUpdateRequest,
    ) -> Result<ProjectResponse, String> {
        let connection = db(&app)?;
        let current = get_project_schema(&connection, &project_id)?;
        let display_name = payload.display_name.unwrap_or(current.display_name);
        let source_key_override = payload.source_key_override.or(current.source_key_override);
        connection
            .execute(
                "UPDATE projects SET display_name = ?1, source_key_override = ?2, updated_at = ?3 WHERE id = ?4",
                params![display_name, source_key_override, now_iso(), project_id],
            )
            .map_err(|error| error.to_string())?;
        mobile_get_project(app, project_id)
    }

    #[tauri::command]
    pub fn mobile_delete_project(
        app: AppHandle,
        project_id: String,
    ) -> Result<DeleteResponse, String> {
        let connection = db(&app)?;
        connection
            .execute(
                "DELETE FROM jobs WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM artifacts WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM lyrics_transcripts WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
            .map_err(|error| error.to_string())?;
        let root = app_data_root(&app)?.join("projects").join(project_id);
        if root.exists() {
            fs::remove_dir_all(root).map_err(|error| error.to_string())?;
        }
        Ok(DeleteResponse { deleted: true })
    }

    #[tauri::command]
    pub fn mobile_submit_analyze(
        app: AppHandle,
        project_id: String,
    ) -> Result<JobResponse, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        let project = get_project_schema(&connection, &project_id)?;
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
        Ok(JobResponse {
            job: create_completed_job(
                &connection,
                &project_id,
                "analyze",
                Some(source_artifact.id),
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_get_analysis(
        app: AppHandle,
        project_id: String,
    ) -> Result<AnalysisResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        Ok(AnalysisResponse {
            analysis: get_analysis_value(&connection, &project_id)?,
        })
    }

    #[tauri::command]
    pub fn mobile_submit_chords(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        let project = get_project_schema(&connection, &project_id)?;
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
        Ok(JobResponse {
            job: create_completed_job(
                &connection,
                &project_id,
                "chords",
                Some(source_artifact.id),
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_get_chords(app: AppHandle, project_id: String) -> Result<ChordResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        get_chord_response(&connection, project_id)
    }

    #[tauri::command]
    pub fn mobile_submit_lyrics(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        let project = get_project_schema(&connection, &project_id)?;
        let force = payload_force(&payload);
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
        let model = match find_whisper_model(&root) {
            Some(model) => model,
            None => {
                return Ok(JobResponse {
                    job: create_failed_job(
                        &connection,
                        &project_id,
                        "lyrics",
                        WHISPER_MODEL_MISSING,
                    )?,
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
        thread::spawn(move || run_lyrics_job(root, job_id, project, source_artifact, model));
        Ok(JobResponse { job })
    }

    #[tauri::command]
    pub fn mobile_get_lyrics(app: AppHandle, project_id: String) -> Result<LyricsResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        get_lyrics_response(&connection, project_id)
    }

    #[tauri::command]
    pub fn mobile_update_lyrics(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<LyricsResponse, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        update_lyrics_transcript(&connection, &root, project_id, &payload)
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
            source_segments: Vec::new(),
            segments: Vec::new(),
            has_user_edits: false,
            created_at: None,
            updated_at: None,
        }
    }

    #[tauri::command]
    pub fn mobile_submit_preview(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "preview",
                "Android MediaCodec preview export is not wired yet.",
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_submit_stems(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "stems",
                generation_unavailable_message("stems"),
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_submit_retune(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "retune",
                "Android MediaCodec retune export is not wired yet.",
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_submit_transpose(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "transpose",
                "Android MediaCodec transpose export is not wired yet.",
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_list_artifacts(
        app: AppHandle,
        project_id: String,
    ) -> Result<ArtifactsResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        let mut statement = connection
            .prepare("SELECT id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at FROM artifacts WHERE project_id = ?1 ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id], row_artifact)
            .map_err(|error| error.to_string())?;
        let mut artifacts = Vec::new();
        for row in rows {
            artifacts.push(row.map_err(|error| error.to_string())?);
        }
        Ok(ArtifactsResponse { artifacts })
    }

    #[tauri::command]
    pub fn mobile_delete_artifact(
        app: AppHandle,
        project_id: String,
        artifact_id: String,
    ) -> Result<DeleteResponse, String> {
        let connection = db(&app)?;
        let artifact = connection
            .query_row(
                "SELECT id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at FROM artifacts WHERE id = ?1 AND project_id = ?2",
                params![artifact_id, project_id],
                row_artifact,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Artifact does not belong to this project.".to_string())?;
        if !artifact.can_delete {
            return Err("This artifact cannot be deleted.".to_string());
        }
        if Path::new(&artifact.path).exists() {
            fs::remove_file(&artifact.path).map_err(|error| error.to_string())?;
        }
        connection
            .execute("DELETE FROM artifacts WHERE id = ?1", params![artifact.id])
            .map_err(|error| error.to_string())?;
        Ok(DeleteResponse { deleted: true })
    }

    #[tauri::command]
    pub fn mobile_submit_export(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(
                &connection,
                &project_id,
                "export",
                "Android Media3 export is not wired yet.",
            )?,
        })
    }

    #[tauri::command]
    pub fn mobile_list_jobs(app: AppHandle) -> Result<JobsResponse, String> {
        let connection = db(&app)?;
        let mut statement = connection
            .prepare("SELECT id, project_id, type, status, progress, source_artifact_id, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at FROM jobs ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], row_job)
            .map_err(|error| error.to_string())?;
        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row.map_err(|error| error.to_string())?);
        }
        Ok(JobsResponse { jobs })
    }

    #[tauri::command]
    pub fn mobile_get_job(app: AppHandle, job_id: String) -> Result<JobResponse, String> {
        let connection = db(&app)?;
        let job = connection
            .query_row(
                "SELECT id, project_id, type, status, progress, source_artifact_id, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at FROM jobs WHERE id = ?1",
                params![job_id],
                row_job,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Job not found.".to_string())?;
        Ok(JobResponse { job })
    }

    #[tauri::command]
    pub fn mobile_cancel_job(app: AppHandle, job_id: String) -> Result<JobResponse, String> {
        let connection = db(&app)?;
        connection
            .execute(
                "UPDATE jobs SET status = 'canceled', updated_at = ?1 WHERE id = ?2 AND status IN ('pending', 'running')",
                params![now_iso(), job_id],
            )
            .map_err(|error| error.to_string())?;
        mobile_get_job(app, job_id)
    }
}

#[cfg(target_os = "android")]
pub use android::*;
