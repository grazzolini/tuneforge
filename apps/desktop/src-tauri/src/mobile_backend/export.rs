use super::storage::{
    begin_export_finalizing, complete_export_job, create_running_job, export_cancel_requested,
    fail_export_job, hex_digest, update_export_job_progress,
};
use super::*;
use crate::native_audio::android_export::encode_android_m4a;
use std::io::Write;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct MobileExportRequest {
    artifact_ids: Vec<String>,
    output_format: String,
    #[serde(default)]
    filename_base: Option<String>,
    destination: MobileExportDestination,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct MobileExportDestination {
    #[serde(rename = "type")]
    destination_type: String,
    target: String,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Clone)]
struct MobileExportPlan {
    project_id: String,
    source: ArtifactSchema,
    source_path: PathBuf,
    target: String,
    overwrite: bool,
    output_name: String,
}

fn safe_filename_base(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || "\\/:*?\"<>|".contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '.'])
        .chars()
        .take(120)
        .collect::<String>();
    if sanitized.is_empty() {
        "TuneForge Export".to_string()
    } else {
        sanitized
    }
}

fn stem_label(artifact_type: &str) -> Option<&'static str> {
    match artifact_type {
        "vocal_stem" => Some("Vocals"),
        "drums_stem" => Some("Drums"),
        "bass_stem" => Some("Bass"),
        "guitar_stem" => Some("Guitar"),
        "piano_stem" => Some("Piano"),
        "instrumental_stem" => Some("Instrumental"),
        "other_stem" => Some("Other"),
        _ => None,
    }
}

fn primary_audio_set(
    connection: &Connection,
    project_id: &str,
    artifact: &ArtifactSchema,
) -> Result<ArtifactSchema, String> {
    if matches!(artifact.r#type.as_str(), "source_audio" | "preview_mix") {
        return Ok(artifact.clone());
    }
    if stem_label(&artifact.r#type).is_none() {
        return Err("Android can export only audio tracks and stems.".to_string());
    }
    let parent_id = artifact
        .metadata
        .get("source_artifact_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Selected stem is missing its audio set.".to_string())?;
    connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1 AND project_id = ?2 AND type IN ('source_audio', 'preview_mix')"),
            params![parent_id, project_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Selected stem audio set is unavailable.".to_string())
}

fn audio_set_label(
    connection: &Connection,
    project_id: &str,
    primary: &ArtifactSchema,
) -> Result<String, String> {
    if primary.r#type == "source_audio" {
        return Ok("Source".to_string());
    }
    let index = connection
        .query_row(
            "SELECT COUNT(*) FROM artifacts WHERE project_id = ?1 AND type = 'preview_mix' AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))",
            params![project_id, primary.created_at, primary.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(format!("Practice Mix {}", index.max(1)))
}

fn prepare_export_plan(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    payload: Value,
) -> Result<(MobileExportPlan, Value), String> {
    let request: MobileExportRequest = serde_json::from_value(payload)
        .map_err(|_| "Android export request is invalid.".to_string())?;
    if request.artifact_ids.len() != 1 || request.artifact_ids[0].trim().is_empty() {
        return Err("Android exports exactly one audio file at a time.".to_string());
    }
    if request.output_format != "m4a" {
        return Err("Android currently exports only M4A audio.".to_string());
    }
    if request.destination.destination_type != "single_file" {
        return Err("Android currently exports to one picker-selected file.".to_string());
    }
    if !request.destination.target.starts_with("content://") {
        return Err("Android export requires a file selected with the system picker.".to_string());
    }
    let source = connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1 AND project_id = ?2"),
            params![request.artifact_ids[0], project_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Selected audio is unavailable.".to_string())?;
    let project_name = connection
        .query_row(
            "SELECT display_name FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    let primary = primary_audio_set(connection, project_id, &source)?;
    let context = audio_set_label(connection, project_id, &primary)?;
    let stem = stem_label(&source.r#type)
        .map(|label| format!(" - {label}"))
        .unwrap_or_default();
    let output_name = format!(
        "{} - {context}{stem}.m4a",
        safe_filename_base(request.filename_base.as_deref().unwrap_or(&project_name))
    );
    let source_path = PathBuf::from(&source.path);
    if !source_path.is_file() || !source_path.starts_with(project_root_path(root, project_id)?) {
        return Err("Selected audio is not available in project storage.".to_string());
    }
    let plan = MobileExportPlan {
        project_id: project_id.to_string(),
        source,
        source_path,
        target: request.destination.target.clone(),
        overwrite: request.destination.overwrite,
        output_name: output_name.clone(),
    };
    let job_payload = json!({
        "stage_label": "Preparing audio",
        "export_request": request,
        "export_result": {
            "outcome": "failed",
            "total_count": 1,
            "completed_count": 0,
            "failed_count": 0,
            "items": [{
                "artifact_id": plan.source.id,
                "status": "pending",
                "progress": 0,
                "output_name": output_name,
                "result_artifact_id": null,
                "error": null
            }]
        }
    });
    Ok((plan, job_payload))
}

fn persist_provider_file(
    app: &AppHandle,
    target: &str,
    staged_path: &Path,
    overwrite: bool,
) -> Result<(String, i64), String> {
    let selection = target
        .parse::<FilePath>()
        .map_err(|_| "Android picker destination is invalid.".to_string())?;
    let original = read_provider_bytes(app, selection.clone())?;
    ensure_provider_overwrite(&original, overwrite)?;
    with_provider_rollback(
        overwrite,
        || write_and_verify_provider_file(app, selection.clone(), staged_path),
        || restore_provider_bytes(app, selection.clone(), &original),
    )
}

fn ensure_provider_overwrite(original: &[u8], overwrite: bool) -> Result<(), String> {
    if !original.is_empty() && !overwrite {
        Err("The picker-selected Android file already exists.".to_string())
    } else {
        Ok(())
    }
}

fn with_provider_rollback<T>(
    overwrite: bool,
    operation: impl FnOnce() -> Result<T, String>,
    rollback: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    let result = operation();
    if result.is_err() && overwrite {
        rollback()?;
    }
    result
}

fn read_provider_bytes(app: &AppHandle, selection: FilePath) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    let mut reader = app
        .fs()
        .open(selection, options)
        .map_err(|_| "Could not inspect the picker-selected Android file.".to_string())?;
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not inspect the picker-selected Android file.".to_string())?;
    Ok(bytes)
}

fn restore_provider_bytes(
    app: &AppHandle,
    selection: FilePath,
    original: &[u8],
) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).truncate(true).create(true);
    let mut writer = app
        .fs()
        .open(selection, options)
        .map_err(|_| "Could not restore the picker-selected Android file.".to_string())?;
    writer
        .write_all(original)
        .and_then(|_| writer.flush())
        .and_then(|_| writer.sync_all())
        .map_err(|_| "Could not restore the picker-selected Android file.".to_string())
}

fn write_and_verify_provider_file(
    app: &AppHandle,
    selection: FilePath,
    staged_path: &Path,
) -> Result<(String, i64), String> {
    let mut staged = fs::File::open(staged_path)
        .map_err(|_| "Could not read Android export staging.".to_string())?;
    let mut write_options = OpenOptions::new();
    write_options.write(true).truncate(true).create(true);
    let mut writer = app
        .fs()
        .open(selection.clone(), write_options)
        .map_err(|_| "Could not write the picker-selected Android file.".to_string())?;
    let mut hasher = Sha256::new();
    let mut size_bytes = 0i64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = staged
            .read(&mut buffer)
            .map_err(|_| "Could not read Android export staging.".to_string())?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|_| "Could not write the picker-selected Android file.".to_string())?;
        hasher.update(&buffer[..read]);
        size_bytes = size_bytes
            .checked_add(
                i64::try_from(read)
                    .map_err(|_| "Android export is too large to register.".to_string())?,
            )
            .ok_or_else(|| "Android export is too large to register.".to_string())?;
    }
    writer
        .flush()
        .and_then(|_| writer.sync_all())
        .map_err(|_| "Could not finish the picker-selected Android file.".to_string())?;
    drop(writer);
    drop(staged);

    let mut read_options = OpenOptions::new();
    read_options.read(true);
    let mut provider = app
        .fs()
        .open(selection, read_options)
        .map_err(|_| "Could not verify the picker-selected Android file.".to_string())?;
    let mut staged = fs::File::open(staged_path)
        .map_err(|_| "Could not reopen Android export staging.".to_string())?;
    let mut staged_buffer = [0u8; 64 * 1024];
    let mut provider_buffer = [0u8; 64 * 1024];
    loop {
        let staged_read = staged
            .read(&mut staged_buffer)
            .map_err(|_| "Could not verify Android export staging.".to_string())?;
        let provider_read = provider
            .read(&mut provider_buffer)
            .map_err(|_| "Could not verify the picker-selected Android file.".to_string())?;
        if staged_read != provider_read
            || staged_buffer[..staged_read] != provider_buffer[..provider_read]
        {
            return Err(
                "Picker-selected Android file failed exact readback verification.".to_string(),
            );
        }
        if staged_read == 0 {
            break;
        }
    }
    Ok((hex_digest(&hasher.finalize()), size_bytes))
}

fn register_export_artifact(
    connection: &Connection,
    plan: &MobileExportPlan,
    content_sha256: &str,
    size_bytes: i64,
) -> Result<String, String> {
    let artifact_id = new_artifact_id()?;
    let timestamp = now_iso();
    let metadata = json!({
        "source_artifact_id": plan.source.id,
        "output_name": plan.output_name,
        "provider_verified": true
    });
    connection
        .execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at) VALUES (?1, ?2, 'export_mix', 'm4a', ?3, ?4, ?5, 'android-media-codec', 1, 0, ?6, NULL, ?7)",
            params![artifact_id, plan.project_id, plan.target, content_sha256, size_bytes, metadata.to_string(), timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(artifact_id)
}

fn run_export_job(app: AppHandle, root: PathBuf, job_id: String, plan: MobileExportPlan) {
    let started = Instant::now();
    let connection = match db_at_root(&root) {
        Ok(connection) => connection,
        Err(_) => return,
    };
    let staging = match project_root_path(&root, &plan.project_id) {
        Ok(project_root) => project_root
            .join("exports")
            .join(".staging")
            .join(format!("{job_id}.m4a")),
        Err(message) => {
            let _ = fail_export_job(
                &connection,
                &job_id,
                &message,
                started.elapsed().as_secs_f64(),
            );
            return;
        }
    };
    let result = (|| -> Result<String, String> {
        update_export_job_progress(&connection, &job_id, 10, "Encoding M4A")?;
        encode_android_m4a(
            &plan.source_path,
            &staging,
            &|| export_cancel_requested(&connection, &job_id).unwrap_or(true),
            &|progress| {
                let _ = update_export_job_progress(&connection, &job_id, progress, "Encoding M4A");
            },
        )?;
        if export_cancel_requested(&connection, &job_id)? {
            return Err("Export cancelled.".to_string());
        }
        update_export_job_progress(&connection, &job_id, 90, "Validating M4A")?;
        if fs::metadata(&staging)
            .map_err(|_| "Could not inspect Android export staging.".to_string())?
            .len()
            == 0
        {
            return Err("Android export staging is empty.".to_string());
        }
        if export_cancel_requested(&connection, &job_id)? {
            return Err("Export cancelled.".to_string());
        }
        begin_export_finalizing(&connection, &job_id)?;
        let (content_sha256, size_bytes) =
            persist_provider_file(&app, &plan.target, &staging, plan.overwrite)?;
        let result_artifact_id =
            register_export_artifact(&connection, &plan, &content_sha256, size_bytes)?;
        complete_export_job(
            &connection,
            &job_id,
            &plan.source.id,
            &result_artifact_id,
            &plan.output_name,
            started.elapsed().as_secs_f64(),
        )?;
        Ok(result_artifact_id)
    })();
    let _ = fs::remove_file(&staging);
    if let Err(message) = result {
        if message != "Export cancelled." {
            let _ = fail_export_job(
                &connection,
                &job_id,
                &message,
                started.elapsed().as_secs_f64(),
            );
        }
    }
    reconcile_project_storage_after_commit(&connection, &root, &plan.project_id);
}

pub fn mobile_submit_export(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    let (plan, job_payload) = match prepare_export_plan(&connection, &root, &project_id, payload) {
        Ok(plan) => plan,
        Err(message) => {
            return Ok(JobResponse {
                job: create_failed_job(&connection, &project_id, "export", &message)?,
            });
        }
    };
    let job = create_running_job(
        &connection,
        &project_id,
        "export",
        Some(plan.source.id.clone()),
    )?;
    connection
        .execute(
            "UPDATE jobs SET payload_json = ?1 WHERE id = ?2",
            params![job_payload.to_string(), job.id],
        )
        .map_err(|error| error.to_string())?;
    let job_id = job.id.clone();
    let worker_app = app.clone();
    thread::spawn(move || run_export_job(worker_app, root, job_id, plan));
    Ok(JobResponse {
        job: mobile_get_job(app, job.id)?.job,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn request(overrides: Value) -> Value {
        let mut payload = json!({
            "artifact_ids": ["artifact-source"],
            "output_format": "m4a",
            "filename_base": "My Song",
            "destination": {
                "type": "single_file",
                "target": "content://picker/export.m4a",
                "overwrite": false
            }
        });
        for (key, value) in overrides.as_object().cloned().unwrap_or_default() {
            payload[key] = value;
        }
        payload
    }

    fn export_plan_fixture() -> (PathBuf, Connection, String) {
        let root = std::env::temp_dir().join(format!(
            "tuneforge-mobile-export-plan-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let connection = db_at_root(&root).unwrap();
        let project_id = format!("proj_sha256_{}", "a".repeat(64));
        let project_root = project_root_path(&root, &project_id).unwrap();
        fs::create_dir_all(project_root.join("source")).unwrap();
        let source = project_root.join("source/source.wav");
        fs::write(&source, b"synthetic").unwrap();
        let now = now_iso();
        connection.execute(
            "INSERT INTO projects (id, display_name, source_sha256, source_path, imported_path, created_at, updated_at) VALUES (?1, 'Project Default', ?2, ?3, ?3, ?4, ?4)",
            params![project_id, "a".repeat(64), source.to_string_lossy(), now],
        ).unwrap();
        connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('artifact-source', ?1, 'source_audio', 'wav', ?2, 9, 'test', 0, 0, '{}', ?3)",
            params![project_id, source.to_string_lossy(), now],
        ).unwrap();
        (root, connection, project_id)
    }

    #[test]
    fn sanitizes_android_export_names() {
        assert_eq!(safe_filename_base("  My:/  Take  "), "My-- Take");
        assert_eq!(safe_filename_base("..."), "TuneForge Export");
    }

    #[test]
    fn recognizes_supported_mobile_stems() {
        assert_eq!(stem_label("vocal_stem"), Some("Vocals"));
        assert_eq!(stem_label("analysis_json"), None);
    }

    #[test]
    fn provider_collision_requires_explicit_overwrite() {
        assert!(ensure_provider_overwrite(b"existing", false)
            .unwrap_err()
            .contains("already exists"));
        assert!(ensure_provider_overwrite(b"existing", true).is_ok());
        assert!(ensure_provider_overwrite(b"", false).is_ok());
    }

    #[test]
    fn provider_failure_restores_preexisting_content() {
        let restored = Cell::new(false);
        let result = with_provider_rollback::<()>(
            true,
            || Err("injected provider write failure".to_string()),
            || {
                restored.set(true);
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "injected provider write failure");
        assert!(restored.get());
    }

    #[test]
    fn optional_request_fields_default_to_project_name_and_no_overwrite() {
        let (root, connection, project_id) = export_plan_fixture();
        let payload = json!({
            "artifact_ids": ["artifact-source"],
            "output_format": "m4a",
            "destination": {
                "type": "single_file",
                "target": "content://picker/export.m4a"
            }
        });
        let (plan, _) = prepare_export_plan(&connection, &root, &project_id, payload).unwrap();
        assert_eq!(plan.output_name, "Project Default - Source.m4a");
        assert!(!plan.overwrite);
        let (plan, _) = prepare_export_plan(
            &connection,
            &root,
            &project_id,
            request(json!({
                "filename_base": null,
                "destination": {
                    "type": "single_file",
                    "target": "content://picker/export.m4a",
                    "overwrite": true
                }
            })),
        )
        .unwrap();
        assert_eq!(plan.output_name, "Project Default - Source.m4a");
        assert!(plan.overwrite);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_mobile_batch_format_and_destination_requests() {
        let connection = Connection::open_in_memory().unwrap();
        migrate_mobile_db(&connection).unwrap();
        let root = std::env::temp_dir();
        assert!(prepare_export_plan(
            &connection,
            &root,
            "project",
            request(json!({"artifact_ids": ["one", "two"]})),
        )
        .err()
        .unwrap()
        .contains("exactly one"));
        assert!(prepare_export_plan(
            &connection,
            &root,
            "project",
            request(json!({"output_format": "wav"})),
        )
        .err()
        .unwrap()
        .contains("only M4A"));
        assert!(prepare_export_plan(
            &connection,
            &root,
            "project",
            request(json!({"destination": {"type": "folder", "target": "content://picker/folder", "overwrite": false}})),
        )
        .err()
        .unwrap()
        .contains("one picker-selected file"));
    }
}
