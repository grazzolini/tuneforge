use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

#[cfg(not(target_os = "android"))]
const MOBILE_UNAVAILABLE: &str = "Mobile embedded backend is only available in Android builds.";
#[cfg(target_os = "android")]
const GPU_REQUIRED: &str = "Local generation requires GPU acceleration on this device.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCapabilities {
    platform: &'static str,
    media_backend: &'static str,
    gpu_backend: Option<&'static str>,
    whisper_available: bool,
    stem_separation_available: bool,
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
    timeline: Vec<Value>,
    backend: Option<String>,
    source_artifact_id: Option<String>,
    created_at: Option<String>,
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
    use chrono::{SecondsFormat, Utc};
    use rusqlite::{params, Connection, OptionalExtension, Row};
    use serde_json::json;
    use std::{
        fs, io,
        path::{Path, PathBuf},
        str::FromStr,
    };
    use tauri::Manager;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    #[tauri::command]
    pub fn mobile_capabilities() -> Result<MobileCapabilities, String> {
        Ok(MobileCapabilities {
            platform: "android",
            media_backend: "android_media_codec",
            gpu_backend: None,
            whisper_available: false,
            stem_separation_available: false,
            max_recommended_model: None,
            cpu_fallback_allowed: false,
        })
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
        let source_dir = root.join("projects").join(&project_id).join("source");
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
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at)
                 VALUES (?1, ?2, 'source_audio', ?3, ?4, ?5, 'import', 0, 0, ?6, ?7)",
                params![
                    new_id("art"),
                    project_id,
                    source_format(&imported_path),
                    imported_path.to_string_lossy().into_owned(),
                    size_bytes,
                    json!({ "source_path": payload.source_path }).to_string(),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;

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
        Ok(JobResponse {
            job: create_failed_job(&connection, &project_id, "analyze", GPU_REQUIRED)?,
        })
    }

    #[tauri::command]
    pub fn mobile_get_analysis(
        app: AppHandle,
        project_id: String,
    ) -> Result<AnalysisResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        Ok(AnalysisResponse { analysis: None })
    }

    #[tauri::command]
    pub fn mobile_submit_chords(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(&connection, &project_id, "chords", GPU_REQUIRED)?,
        })
    }

    #[tauri::command]
    pub fn mobile_get_chords(app: AppHandle, project_id: String) -> Result<ChordResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        Ok(ChordResponse {
            project_id,
            timeline: Vec::new(),
            backend: None,
            source_artifact_id: None,
            created_at: None,
        })
    }

    #[tauri::command]
    pub fn mobile_submit_lyrics(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<JobResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        Ok(JobResponse {
            job: create_failed_job(&connection, &project_id, "lyrics", GPU_REQUIRED)?,
        })
    }

    #[tauri::command]
    pub fn mobile_get_lyrics(app: AppHandle, project_id: String) -> Result<LyricsResponse, String> {
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        Ok(empty_lyrics(project_id))
    }

    #[tauri::command]
    pub fn mobile_update_lyrics(
        app: AppHandle,
        project_id: String,
        payload: Value,
    ) -> Result<LyricsResponse, String> {
        let _ = payload;
        let connection = db(&app)?;
        let _ = get_project_schema(&connection, &project_id)?;
        Ok(empty_lyrics(project_id))
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
            job: create_failed_job(&connection, &project_id, "stems", GPU_REQUIRED)?,
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
