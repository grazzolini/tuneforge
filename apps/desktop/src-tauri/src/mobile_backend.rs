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
pub struct VersionInfo {
    package_version: String,
    git_ref: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HealthResponse {
    name: String,
    version: String,
    backend_version: VersionInfo,
    frontend_version: VersionInfo,
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
    total: usize,
    limit: usize,
    offset: usize,
    has_more: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct ListProjectsParams {
    search: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
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
    total: usize,
    limit: usize,
    offset: usize,
    has_more: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct ListJobsParams {
    status: Option<Vec<String>>,
    project_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
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
mobile_stub!(mobile_list_projects, ProjectsResponse, app: AppHandle, params: Option<ListProjectsParams>);
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
mobile_stub!(mobile_list_jobs, JobsResponse, app: AppHandle, params: Option<ListJobsParams>);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_job, JobResponse, app: AppHandle, job_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_cancel_job, JobResponse, app: AppHandle, job_id: String);

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use crate::native_audio::decode::{
        read_mobile_audio, read_resampled_mono_audio, write_mono_pcm_wav,
    };
    use android_system_properties::AndroidSystemProperties;
    use chrono::{SecondsFormat, Utc};
    use rusqlite::{params, Connection, OptionalExtension, Row};
    use serde_json::json;
    use std::{
        fs, io,
        path::{Path, PathBuf},
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
    const DEFAULT_PROJECTS_LIMIT: usize = 50;
    const MAX_PROJECTS_LIMIT: usize = 200;
    const DEFAULT_JOBS_LIMIT: usize = 50;
    const MAX_JOBS_LIMIT: usize = 200;

    #[derive(Clone)]
    struct WhisperModel {
        path: PathBuf,
        name: &'static str,
        max_recommended_model: &'static str,
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

    fn normalized_projects_limit(value: Option<i64>) -> Result<usize, String> {
        let limit = value.unwrap_or(DEFAULT_PROJECTS_LIMIT as i64);
        if limit < 1 {
            return Err("Project list limit must be at least 1.".to_string());
        }
        if limit > MAX_PROJECTS_LIMIT as i64 {
            return Err(format!(
                "Project list limit must be less than or equal to {MAX_PROJECTS_LIMIT}."
            ));
        }
        Ok(limit as usize)
    }

    fn normalized_projects_offset(value: Option<i64>) -> Result<usize, String> {
        let offset = value.unwrap_or(0);
        if offset < 0 {
            return Err("Project list offset must be at least 0.".to_string());
        }
        Ok(offset as usize)
    }

    fn normalized_jobs_limit(value: Option<i64>) -> Result<usize, String> {
        let limit = value.unwrap_or(DEFAULT_JOBS_LIMIT as i64);
        if limit < 1 {
            return Err("Job list limit must be at least 1.".to_string());
        }
        if limit > MAX_JOBS_LIMIT as i64 {
            return Err(format!(
                "Job list limit must be less than or equal to {MAX_JOBS_LIMIT}."
            ));
        }
        Ok(limit as usize)
    }

    fn normalized_jobs_offset(value: Option<i64>) -> Result<usize, String> {
        let offset = value.unwrap_or(0);
        if offset < 0 {
            return Err("Job list offset must be at least 0.".to_string());
        }
        Ok(offset as usize)
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

    fn existing_playback_proxy_path(project_root: &Path) -> Option<PathBuf> {
        let playback_path = project_root.join("playback").join("source-playback.wav");
        playback_path.is_file().then_some(playback_path)
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

    fn ensure_source_playback_proxy_metadata(
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

        let project_root = root.join("projects").join(project_id);
        let playback_path = existing_playback_proxy_path(&project_root).or_else(|| {
            create_playback_proxy_if_needed(&project_root, Path::new(&project.imported_path))
        });
        if let Some(playback_path) = playback_path {
            attach_playback_proxy_metadata(connection, &source_artifact.id, &playback_path)?;
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
        let audio = read_resampled_mono_audio(source_path, WHISPER_SAMPLE_RATE)?;
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
        let package_version = env!("CARGO_PKG_VERSION").to_string();
        let git_ref = option_env!("TUNEFORGE_GIT_REF")
            .unwrap_or("unknown")
            .to_string();
        let version_info = VersionInfo {
            package_version,
            git_ref: git_ref.clone(),
        };
        Ok(HealthResponse {
            name: "Tuneforge Mobile".to_string(),
            version: git_ref,
            backend_version: version_info.clone(),
            frontend_version: version_info,
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
        params: Option<ListProjectsParams>,
    ) -> Result<ProjectsResponse, String> {
        let params = params.unwrap_or_default();
        let limit = normalized_projects_limit(params.limit)?;
        let offset = normalized_projects_offset(params.offset)?;
        let connection = db(&app)?;
        let needle = params
            .search
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let limit = limit as i64;
        let offset = offset as i64;
        let (projects, total) = if needle.is_empty() {
            let total = connection
                .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|error| error.to_string())?;
            let mut statement = connection
                .prepare(
                    "SELECT id, display_name, source_key_override, source_path, imported_path, duration_seconds, sample_rate, channels, created_at, updated_at FROM projects ORDER BY updated_at DESC, id DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![limit, offset], row_project)
                .map_err(|error| error.to_string())?;
            let mut projects = Vec::new();
            for row in rows {
                projects.push(row.map_err(|error| error.to_string())?);
            }
            (projects, total as usize)
        } else {
            let like_term = format!("%{needle}%");
            let total = connection
                .query_row(
                    "SELECT COUNT(*) FROM projects WHERE lower(display_name) LIKE ?1 OR lower(source_path) LIKE ?1 OR lower(imported_path) LIKE ?1",
                    params![&like_term],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())?;
            let mut statement = connection
                .prepare(
                    "SELECT id, display_name, source_key_override, source_path, imported_path, duration_seconds, sample_rate, channels, created_at, updated_at FROM projects WHERE lower(display_name) LIKE ?1 OR lower(source_path) LIKE ?1 OR lower(imported_path) LIKE ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![&like_term, limit, offset], row_project)
                .map_err(|error| error.to_string())?;
            let mut projects = Vec::new();
            for row in rows {
                projects.push(row.map_err(|error| error.to_string())?);
            }
            (projects, total as usize)
        };
        let limit = limit as usize;
        let offset = offset as usize;
        let has_more = offset.saturating_add(projects.len()) < total;
        Ok(ProjectsResponse {
            projects,
            total,
            limit,
            offset,
            has_more,
        })
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
        let root = app_data_root(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        ensure_source_playback_proxy_metadata(&connection, &root, &project_id)?;
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
    pub fn mobile_list_jobs(
        app: AppHandle,
        params: Option<ListJobsParams>,
    ) -> Result<JobsResponse, String> {
        let params = params.unwrap_or_default();
        let limit = normalized_jobs_limit(params.limit)?;
        let offset = normalized_jobs_offset(params.offset)?;
        let status_filters = params.status.unwrap_or_default();
        let connection = db(&app)?;
        let mut statement = connection
            .prepare(
                r#"
                SELECT id, project_id, type, status, progress, source_artifact_id, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at
                FROM jobs
                ORDER BY
                    CASE
                        WHEN status = 'running' THEN 0
                        WHEN status = 'pending' THEN 1
                        WHEN status IN ('completed', 'cancelled', 'failed') THEN 2
                        ELSE 3
                    END ASC,
                    CASE WHEN status = 'running' THEN COALESCE(started_at, created_at) END ASC,
                    CASE WHEN status = 'running' THEN id END ASC,
                    CASE WHEN status = 'pending' THEN created_at END ASC,
                    CASE WHEN status = 'pending' THEN id END ASC,
                    CASE WHEN status IN ('completed', 'cancelled', 'failed') THEN COALESCE(completed_at, updated_at) END DESC,
                    CASE WHEN status IN ('completed', 'cancelled', 'failed') THEN id END DESC,
                    updated_at DESC,
                    id DESC
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], row_job)
            .map_err(|error| error.to_string())?;
        let mut jobs = Vec::new();
        for row in rows {
            let job = row.map_err(|error| error.to_string())?;
            let status_matches = status_filters.is_empty()
                || status_filters.iter().any(|status| status == &job.status);
            let project_matches = params.project_id.as_ref().map_or(true, |project_id| {
                job.project_id.as_deref() == Some(project_id.as_str())
            });
            if status_matches && project_matches {
                jobs.push(job);
            }
        }
        let total = jobs.len();
        let jobs = jobs
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let has_more = offset.saturating_add(jobs.len()) < total;
        Ok(JobsResponse {
            jobs,
            total,
            limit,
            offset,
            has_more,
        })
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
