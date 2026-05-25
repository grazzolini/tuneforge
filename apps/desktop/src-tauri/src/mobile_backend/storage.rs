use super::*;

#[derive(Clone, Debug)]
pub struct MobileSyncTransportArtifactFile {
    pub path: PathBuf,
    pub size_bytes: u64,
}
pub(super) const DEFAULT_PROJECTS_LIMIT: usize = 50;
pub(super) const MAX_PROJECTS_LIMIT: usize = 200;
pub(super) const DEFAULT_JOBS_LIMIT: usize = 50;
pub(super) const MAX_JOBS_LIMIT: usize = 200;
pub(super) const PROJECT_COLUMNS: &str = "id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, sync_status_reason, sync_required_artifact_ids_json, sync_provider_device_ids_json, sync_conflict_count, created_at, updated_at";
pub(super) const ARTIFACT_COLUMNS: &str = "id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at";
pub(super) const JOB_COLUMNS: &str = "id, project_id, type, status, progress, source_artifact_id, result_artifact_ids_json, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at";
pub(super) const SYNC_STAGED_ARTIFACT_COLUMNS: &str = "content_sha256, size_bytes, relative_path, provider_device_id, metadata_json, verified_at, created_at, updated_at";
pub(super) const SYNC_ENTITY_REVISION_COLUMNS: &str = "id, project_id, entity_type, entity_id, revision_type, base_revision_id, author_device_id, source_artifact_id, content_sha256, state, metadata_json, payload_json, created_at, updated_at";
pub(super) const SYNC_DELETE_TOMBSTONE_COLUMNS: &str = "id, sync_group_id, project_id, target_type, target_id, author_device_id, deleted_at, prior_metadata_json, created_at, updated_at";
pub(super) const MOBILE_CORE_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        source_key_override TEXT,
        source_sha256 TEXT,
        source_path TEXT NOT NULL,
        imported_path TEXT NOT NULL,
        duration_seconds REAL,
        sample_rate INTEGER,
        channels INTEGER,
        sync_status TEXT NOT NULL DEFAULT 'local',
        sync_status_reason TEXT,
        sync_required_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        sync_provider_device_ids_json TEXT NOT NULL DEFAULT '[]',
        sync_conflict_count INTEGER NOT NULL DEFAULT 0,
        sync_status_updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        format TEXT NOT NULL,
        path TEXT NOT NULL,
        content_sha256 TEXT,
        size_bytes INTEGER NOT NULL,
        generated_by TEXT NOT NULL,
        can_delete INTEGER NOT NULL,
        can_regenerate INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        cache_key TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL,
        source_artifact_id TEXT,
        result_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        runtime_device TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        cancel_requested INTEGER NOT NULL DEFAULT 0,
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
        language_override TEXT,
        source_segments_json TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        has_user_edits INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
"#;

pub(super) const MOBILE_SYNC_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS sync_local_identities (
        id TEXT PRIMARY KEY,
        sync_group_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (id = 'local')
    );
    CREATE INDEX IF NOT EXISTS ix_sync_local_identities_sync_group_id
        ON sync_local_identities(sync_group_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_local_identities_device_id
        ON sync_local_identities(device_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_local_identities_public_key
        ON sync_local_identities(public_key);

    CREATE TABLE IF NOT EXISTS sync_trusted_peers (
        device_id TEXT PRIMARY KEY,
        sync_group_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        endpoint_hints_json TEXT NOT NULL DEFAULT '[]',
        trusted_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_sync_trusted_peers_sync_group_id
        ON sync_trusted_peers(sync_group_id);
    CREATE INDEX IF NOT EXISTS ix_sync_trusted_peers_revoked_at
        ON sync_trusted_peers(revoked_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_trusted_peers_public_key
        ON sync_trusted_peers(public_key);

    CREATE TABLE IF NOT EXISTS sync_pairing_offers (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        endpoint_hints_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_sync_pairing_offers_expires_at
        ON sync_pairing_offers(expires_at);
    CREATE INDEX IF NOT EXISTS ix_sync_pairing_offers_used_at
        ON sync_pairing_offers(used_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_pairing_offers_secret_hash
        ON sync_pairing_offers(secret_hash);

    CREATE TABLE IF NOT EXISTS sync_staged_artifacts (
        content_sha256 TEXT PRIMARY KEY CHECK (length(content_sha256) = 64),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        relative_path TEXT NOT NULL,
        provider_device_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_sync_staged_artifacts_provider_device_id
        ON sync_staged_artifacts(provider_device_id);
    CREATE INDEX IF NOT EXISTS ix_sync_staged_artifacts_verified_at
        ON sync_staged_artifacts(verified_at);

    CREATE TABLE IF NOT EXISTS sync_entity_revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision_type TEXT NOT NULL,
        base_revision_id TEXT,
        source_artifact_id TEXT,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        author_device_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_sync_entity_revisions_project_entity
        ON sync_entity_revisions(project_id, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS ix_sync_entity_revisions_base_revision_id
        ON sync_entity_revisions(base_revision_id);
    CREATE INDEX IF NOT EXISTS ix_sync_entity_revisions_author_device_id
        ON sync_entity_revisions(author_device_id);
    CREATE INDEX IF NOT EXISTS ix_sync_entity_revisions_state
        ON sync_entity_revisions(state);

    CREATE TABLE IF NOT EXISTS sync_delete_tombstones (
        id TEXT PRIMARY KEY,
        sync_group_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        author_device_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        prior_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_delete_tombstones_group_target
        ON sync_delete_tombstones(sync_group_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS ix_sync_delete_tombstones_project_id
        ON sync_delete_tombstones(project_id);
    CREATE INDEX IF NOT EXISTS ix_sync_delete_tombstones_target
        ON sync_delete_tombstones(target_type, target_id);
    CREATE INDEX IF NOT EXISTS ix_sync_delete_tombstones_author_device_id
        ON sync_delete_tombstones(author_device_id);
    CREATE INDEX IF NOT EXISTS ix_sync_delete_tombstones_deleted_at
        ON sync_delete_tombstones(deleted_at);
"#;
pub(super) fn normalized_projects_limit(value: Option<i64>) -> Result<usize, String> {
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

pub(super) fn normalized_projects_offset(value: Option<i64>) -> Result<usize, String> {
    let offset = value.unwrap_or(0);
    if offset < 0 {
        return Err("Project list offset must be at least 0.".to_string());
    }
    Ok(offset as usize)
}

pub(super) fn normalized_jobs_limit(value: Option<i64>) -> Result<usize, String> {
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

pub(super) fn normalized_jobs_offset(value: Option<i64>) -> Result<usize, String> {
    let offset = value.unwrap_or(0);
    if offset < 0 {
        return Err("Job list offset must be at least 0.".to_string());
    }
    Ok(offset as usize)
}

pub(super) fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}_{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

pub(super) fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(super) fn db(app: &AppHandle) -> Result<Connection, String> {
    let root = app_data_root(app)?;
    db_at_root(&root)
}

pub(super) fn db_at_root(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let connection =
        Connection::open(root.join("mobile.sqlite3")).map_err(|error| error.to_string())?;
    migrate_mobile_db(&connection)?;
    ensure_local_identity(&connection)?;
    Ok(connection)
}

pub(super) fn migrate_mobile_db(connection: &Connection) -> Result<(), String> {
    let current_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    if current_version > MOBILE_DB_VERSION {
        return Err(format!(
            "Mobile database version {current_version} is newer than supported version {MOBILE_DB_VERSION}."
        ));
    }

    connection
        .execute_batch(MOBILE_CORE_SCHEMA_SQL)
        .map_err(|error| error.to_string())?;
    add_mobile_sync_columns(connection)?;
    connection
        .execute_batch(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_cache_key
                ON artifacts(cache_key)
                WHERE cache_key IS NOT NULL;
            "#,
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(MOBILE_SYNC_SCHEMA_SQL)
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "user_version", MOBILE_DB_VERSION)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn add_mobile_sync_columns(connection: &Connection) -> Result<(), String> {
    add_column_if_missing(connection, "projects", "source_sha256", "TEXT")?;
    add_column_if_missing(
        connection,
        "projects",
        "sync_status",
        "TEXT NOT NULL DEFAULT 'local'",
    )?;
    add_column_if_missing(connection, "projects", "sync_status_reason", "TEXT")?;
    add_column_if_missing(
        connection,
        "projects",
        "sync_required_artifact_ids_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        connection,
        "projects",
        "sync_provider_device_ids_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        connection,
        "projects",
        "sync_conflict_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        connection,
        "projects",
        "sync_status_updated_at",
        "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
    )?;
    add_column_if_missing(connection, "artifacts", "content_sha256", "TEXT")?;
    add_column_if_missing(connection, "artifacts", "cache_key", "TEXT")?;
    add_column_if_missing(
        connection,
        "lyrics_transcripts",
        "language_override",
        "TEXT",
    )?;
    add_column_if_missing(
        connection,
        "jobs",
        "result_artifact_ids_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        connection,
        "jobs",
        "payload_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    add_column_if_missing(
        connection,
        "jobs",
        "cancel_requested",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

pub(super) fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if table_has_column(connection, table, column)? {
        return Ok(());
    }
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    connection
        .execute(&sql, [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    for row in rows {
        if row.map_err(|error| error.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn row_project(row: &Row<'_>) -> rusqlite::Result<ProjectSchema> {
    let sync_status: String = row.get(9)?;
    let sync_required_artifact_ids_json: String = row
        .get::<_, Option<String>>(11)?
        .unwrap_or_else(|| DEFAULT_SYNC_LIST_JSON.to_string());
    let sync_provider_device_ids_json: String = row
        .get::<_, Option<String>>(12)?
        .unwrap_or_else(|| DEFAULT_SYNC_LIST_JSON.to_string());
    Ok(ProjectSchema {
        id: row.get(0)?,
        display_name: row.get(1)?,
        source_key_override: row.get(2)?,
        source_sha256: row.get(3)?,
        source_path: row.get(4)?,
        imported_path: row.get(5)?,
        duration_seconds: row.get(6)?,
        sample_rate: row.get(7)?,
        channels: row.get(8)?,
        sync_editable: sync_editable(&sync_status),
        sync_status,
        sync_status_reason: row.get(10)?,
        sync_required_artifact_ids: string_list_from_json(&sync_required_artifact_ids_json),
        sync_provider_device_ids: string_list_from_json(&sync_provider_device_ids_json),
        sync_conflict_count: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub(super) fn row_artifact(row: &Row<'_>) -> rusqlite::Result<ArtifactSchema> {
    let metadata_raw: String = row.get(10)?;
    Ok(ArtifactSchema {
        id: row.get(0)?,
        project_id: row.get(1)?,
        r#type: row.get(2)?,
        format: row.get(3)?,
        path: row.get(4)?,
        content_sha256: row.get(5)?,
        size_bytes: row.get(6)?,
        generated_by: row.get(7)?,
        can_delete: row.get::<_, i64>(8)? != 0,
        can_regenerate: row.get::<_, i64>(9)? != 0,
        metadata: serde_json::from_str(&metadata_raw).unwrap_or_else(|_| json!({})),
        cache_key: row.get(11)?,
        created_at: row.get(12)?,
    })
}

pub(super) fn row_job(row: &Row<'_>) -> rusqlite::Result<JobSchema> {
    let result_artifact_ids_json: String = row
        .get::<_, Option<String>>(6)?
        .unwrap_or_else(|| DEFAULT_SYNC_LIST_JSON.to_string());
    Ok(JobSchema {
        id: row.get(0)?,
        project_id: row.get(1)?,
        r#type: row.get(2)?,
        status: row.get(3)?,
        progress: row.get(4)?,
        source_artifact_id: row.get(5)?,
        result_artifact_ids: string_list_from_json(&result_artifact_ids_json),
        chord_backend: None,
        chord_backend_fallback_from: None,
        chord_source: None,
        error_message: row.get(7)?,
        runtime_device: row.get(8)?,
        started_at: row.get(9)?,
        completed_at: row.get(10)?,
        duration_seconds: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub(super) fn list_project_display_names(
    connection: &Connection,
) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT id, display_name FROM projects")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut display_names = HashMap::new();
    for row in rows {
        let (project_id, display_name) = row.map_err(|error| error.to_string())?;
        display_names.insert(project_id, display_name);
    }
    Ok(display_names)
}

pub(super) fn row_trusted_peer(row: &Row<'_>) -> rusqlite::Result<SyncTrustedPeerSchema> {
    let endpoint_hints_json: String = row.get(4)?;
    Ok(SyncTrustedPeerSchema {
        device_id: row.get(0)?,
        sync_group_id: row.get(1)?,
        display_name: row.get(2)?,
        public_key: row.get(3)?,
        endpoint_hints: string_list_from_json(&endpoint_hints_json),
        trusted_at: row.get(5)?,
        revoked_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub(super) fn row_staged_artifact(row: &Row<'_>) -> rusqlite::Result<SyncStagedArtifactSchema> {
    let metadata_raw: String = row.get(4)?;
    Ok(SyncStagedArtifactSchema {
        content_sha256: row.get(0)?,
        size_bytes: row.get(1)?,
        relative_path: row.get(2)?,
        provider_device_id: row.get(3)?,
        metadata: serde_json::from_str(&metadata_raw).unwrap_or_else(|_| json!({})),
        verified_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub(super) fn row_entity_revision(
    row: &Row<'_>,
) -> rusqlite::Result<SyncProjectManifestEntityRevisionSchema> {
    let metadata_raw: String = row.get(10)?;
    let payload_raw: String = row.get(11)?;
    Ok(SyncProjectManifestEntityRevisionSchema {
        revision_id: row.get(0)?,
        project_id: row.get(1)?,
        entity_type: row.get(2)?,
        entity_id: row.get(3)?,
        revision_type: row.get(4)?,
        base_revision_id: row.get(5)?,
        author_device_id: row.get(6)?,
        source_artifact_id: row.get(7)?,
        content_sha256: row.get(8)?,
        state: row.get(9)?,
        metadata: serde_json::from_str(&metadata_raw).unwrap_or_else(|_| json!({})),
        payload: serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({})),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub(super) fn row_delete_tombstone(row: &Row<'_>) -> rusqlite::Result<SyncDeleteTombstoneSchema> {
    let prior_metadata_raw: String = row.get(7)?;
    let prior_metadata =
        serde_json::from_str::<Value>(&prior_metadata_raw).unwrap_or_else(|_| json!({}));
    Ok(SyncDeleteTombstoneSchema {
        tombstone_id: row.get(0)?,
        sync_group_id: row.get(1)?,
        project_id: row.get(2)?,
        target_type: row.get(3)?,
        target_id: row.get(4)?,
        author_device_id: row.get(5)?,
        deleted_at: row.get(6)?,
        prior_metadata: sanitize_sync_manifest_value(&prior_metadata),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub(super) fn get_project_schema(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectSchema, String> {
    connection
        .query_row(
            &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"),
            params![project_id],
            row_project,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Project not found.".to_string())
}

pub(super) fn require_sync_editable_project(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectSchema, String> {
    let project = get_project_schema(connection, project_id)?;
    require_sync_editable_status(&project.sync_status)?;
    Ok(project)
}

pub(super) fn create_failed_job(
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
        result_artifact_ids: Vec::new(),
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
            "INSERT INTO jobs (id, project_id, type, status, progress, source_artifact_id, result_artifact_ids_json, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                job.id,
                job.project_id,
                job.r#type,
                job.status,
                job.progress,
                job.source_artifact_id,
                DEFAULT_SYNC_LIST_JSON,
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

pub(super) fn create_completed_job(
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
        result_artifact_ids: Vec::new(),
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
            "INSERT INTO jobs (id, project_id, type, status, progress, source_artifact_id, result_artifact_ids_json, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                job.id,
                job.project_id,
                job.r#type,
                job.status,
                job.progress,
                job.source_artifact_id,
                DEFAULT_SYNC_LIST_JSON,
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

pub(super) fn create_running_job(
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
        result_artifact_ids: Vec::new(),
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
            "INSERT INTO jobs (id, project_id, type, status, progress, source_artifact_id, result_artifact_ids_json, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                job.id,
                job.project_id,
                job.r#type,
                job.status,
                job.progress,
                job.source_artifact_id,
                DEFAULT_SYNC_LIST_JSON,
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

pub(super) fn update_job_progress(
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

pub(super) fn complete_running_job(
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

pub(super) fn fail_running_job(
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

pub(super) fn get_source_artifact(
    connection: &Connection,
    project_id: &str,
) -> Result<ArtifactSchema, String> {
    connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 AND type = 'source_audio' ORDER BY created_at DESC LIMIT 1"),
            params![project_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Source audio is missing.".to_string())
}

pub(super) fn project_root_path(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    let canonical_project_id = validate_canonical_project_id(project_id)?;
    let projects_root = root.join("projects");
    let project_root = projects_root.join(canonical_project_id);
    if !project_root.starts_with(&projects_root) {
        return Err("Project path escapes the mobile app data root.".to_string());
    }
    Ok(project_root)
}

pub(super) fn project_cleanup_root_path(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    if let Ok(project_root) = project_root_path(root, project_id) {
        return Ok(project_root);
    }
    let project_id = safe_legacy_project_id_component(project_id)?;
    let projects_root = root.join("projects");
    let project_root = projects_root.join(project_id);
    if !project_root.starts_with(&projects_root) {
        return Err("Project cleanup path escapes the mobile app data root.".to_string());
    }
    Ok(project_root)
}

pub(super) fn safe_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let mut path = PathBuf::new();
    for part in safe_sync_relative_path_parts(relative_path)? {
        path.push(part);
    }
    Ok(path)
}

pub(super) fn ensure_mobile_project_dirs(root: &Path, project_id: &str) -> Result<(), String> {
    let project_root = project_root_path(root, project_id)?;
    for directory in [
        project_root.clone(),
        project_root.join("source"),
        project_root.join("analysis"),
        project_root.join("previews"),
        project_root.join("stems"),
        project_root.join("exports"),
    ] {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn relative_artifact_path(root: &Path, artifact: &ArtifactSchema) -> Option<String> {
    let project_root = project_root_path(root, &artifact.project_id)
        .ok()?
        .canonicalize()
        .ok()
        .or_else(|| project_root_path(root, &artifact.project_id).ok());
    let artifact_path = Path::new(&artifact.path)
        .canonicalize()
        .ok()
        .or_else(|| Some(PathBuf::from(&artifact.path)))?;
    artifact_path
        .strip_prefix(project_root?)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

pub(super) fn manifest_artifact_from_artifact(
    root: &Path,
    artifact: ArtifactSchema,
) -> Result<SyncProjectManifestArtifactSchema, String> {
    let relative_path = relative_artifact_path(root, &artifact)
        .ok_or_else(|| "Project artifact path is outside the mobile app data root.".to_string())?;
    safe_relative_path(&relative_path)?;
    let content_sha256 = artifact
        .content_sha256
        .as_ref()
        .ok_or_else(|| "Project artifact is missing content SHA-256 metadata.".to_string())
        .and_then(|value| normalize_sha256(value, "content_sha256"))?;
    let actual_size = fs::metadata(&artifact.path)
        .map_err(|_| "Project artifact file is missing.".to_string())?
        .len() as i64;
    if actual_size != artifact.size_bytes {
        return Err("Project artifact file size does not match its metadata.".to_string());
    }
    let actual_sha256 = file_sha256(Path::new(&artifact.path))?;
    if actual_sha256 != content_sha256 {
        return Err("Project artifact file SHA-256 does not match its metadata.".to_string());
    }
    Ok(SyncProjectManifestArtifactSchema {
        artifact_id: artifact.id,
        project_id: artifact.project_id,
        r#type: artifact.r#type,
        format: artifact.format,
        relative_path,
        content_sha256,
        size_bytes: artifact.size_bytes,
        generated_by: artifact.generated_by,
        can_delete: artifact.can_delete,
        can_regenerate: artifact.can_regenerate,
        cache_key: artifact.cache_key,
        metadata: sanitize_sync_manifest_value(&artifact.metadata),
        created_at: artifact.created_at,
    })
}

pub(super) fn project_source_sha256(project: &ProjectSchema) -> Result<String, String> {
    let source_sha256 = project.source_sha256.as_ref().ok_or_else(|| {
        "Project cannot be exported for sync because it is missing source SHA-256 metadata."
            .to_string()
    })?;
    let normalized = normalize_sha256(source_sha256, "source_sha256")?;
    let expected_project_id = source_hash_to_project_id(&normalized)?;
    if project.id != expected_project_id {
        return Err(
            "Project cannot be exported for sync because its project ID is not canonical."
                .to_string(),
        );
    }
    Ok(normalized)
}

pub(super) fn find_existing_project_source(
    connection: &Connection,
    project_id: &str,
    source_sha256: &str,
) -> Result<Option<ProjectSchema>, String> {
    connection
        .query_row(
            &format!(
                "SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1 OR source_sha256 = ?2 ORDER BY created_at ASC, id ASC LIMIT 1"
            ),
            params![project_id, source_sha256],
            row_project,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub(super) fn list_project_artifacts(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ArtifactSchema>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 ORDER BY created_at ASC, id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], row_artifact)
        .map_err(|error| error.to_string())?;
    let mut artifacts = Vec::new();
    for row in rows {
        artifacts.push(row.map_err(|error| error.to_string())?);
    }
    Ok(artifacts)
}

pub(super) fn list_project_entity_revisions(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<SyncProjectManifestEntityRevisionSchema>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE project_id = ?1 ORDER BY entity_type ASC, entity_id ASC, created_at ASC, id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], row_entity_revision)
        .map_err(|error| error.to_string())?;
    let mut revisions = Vec::new();
    for row in rows {
        revisions.push(row.map_err(|error| error.to_string())?);
    }
    Ok(revisions)
}

pub(super) fn list_project_delete_tombstones(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<SyncDeleteTombstoneSchema>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {SYNC_DELETE_TOMBSTONE_COLUMNS} FROM sync_delete_tombstones WHERE project_id = ?1 ORDER BY target_type ASC, target_id ASC, deleted_at ASC, id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], row_delete_tombstone)
        .map_err(|error| error.to_string())?;
    let mut tombstones = Vec::new();
    for row in rows {
        let tombstone = row.map_err(|error| error.to_string())?;
        if !local_tombstone_superseded_by_live_target(connection, &tombstone)? {
            tombstones.push(tombstone);
        }
    }
    Ok(tombstones)
}

pub(super) fn sanitize_entity_revision_for_manifest(
    mut revision: SyncProjectManifestEntityRevisionSchema,
) -> SyncProjectManifestEntityRevisionSchema {
    revision.metadata = sanitize_sync_manifest_value(&revision.metadata);
    revision.payload = sanitize_sync_manifest_value(&revision.payload);
    revision
}

pub(super) fn get_project_manifest(
    connection: &Connection,
    root: &Path,
    project_id: &str,
) -> Result<SyncProjectManifestSchema, String> {
    let project = get_project_schema(connection, project_id)?;
    let source_sha256 = project_source_sha256(&project)?;
    let artifacts = list_project_artifacts(connection, project_id)?
        .into_iter()
        .map(|artifact| manifest_artifact_from_artifact(root, artifact))
        .collect::<Result<Vec<_>, _>>()?;
    source_audio_artifact_for_project(&artifacts, project_id)?;
    Ok(SyncProjectManifestSchema {
        schema_version: SYNC_PROJECT_MANIFEST_SCHEMA_VERSION.to_string(),
        exported_at: now_iso(),
        project: SyncProjectManifestProjectSchema {
            project_id: project.id,
            display_name: project.display_name,
            source_key_override: project.source_key_override,
            source_sha256,
            duration_seconds: project.duration_seconds,
            sample_rate: project.sample_rate,
            channels: project.channels,
            created_at: project.created_at,
            updated_at: project.updated_at,
        },
        entity_revisions: list_project_entity_revisions(connection, project_id)?
            .into_iter()
            .map(sanitize_entity_revision_for_manifest)
            .collect(),
        artifacts,
        delete_tombstones: list_project_delete_tombstones(connection, project_id)?,
    })
}

pub(super) fn staged_artifact_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(relative_path)?;
    let staging_root = root.join("sync").join("staging");
    let resolved = staging_root.join(relative);
    if !resolved.starts_with(&staging_root) {
        return Err("Staged artifact path escapes the mobile app data root.".to_string());
    }
    Ok(resolved)
}

pub(super) fn verify_staged_artifact(
    root: &Path,
    staged: &SyncStagedArtifactSchema,
    expected_size_bytes: Option<i64>,
) -> Result<PathBuf, String> {
    if let Some(size_bytes) = expected_size_bytes {
        if size_bytes != staged.size_bytes {
            return Err("Staged artifact record size does not match requested size.".to_string());
        }
    }
    let path = staged_artifact_path(root, &staged.relative_path)?;
    let metadata = fs::metadata(&path)
        .map_err(|_| "Staged sync artifact file is missing or unreadable.".to_string())?;
    if metadata.len() as i64 != staged.size_bytes {
        return Err(
            "Staged sync artifact file size does not match its database record.".to_string(),
        );
    }
    let actual_sha256 = file_sha256(&path)?;
    if actual_sha256 != staged.content_sha256 {
        return Err(
            "Staged sync artifact file SHA-256 does not match its database record.".to_string(),
        );
    }
    Ok(path)
}

pub(super) fn get_staged_artifact(
    connection: &Connection,
    root: &Path,
    content_sha256: &str,
    expected_size_bytes: Option<i64>,
) -> Result<SyncStagedArtifactSchema, String> {
    let normalized = normalize_sha256(content_sha256, "content_sha256")?;
    let staged = connection
        .query_row(
            &format!(
                "SELECT {SYNC_STAGED_ARTIFACT_COLUMNS} FROM sync_staged_artifacts WHERE content_sha256 = ?1"
            ),
            params![normalized],
            row_staged_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Sync artifact has not been staged locally.".to_string())?;
    let _ = verify_staged_artifact(root, &staged, expected_size_bytes)?;
    Ok(staged)
}

pub(super) fn stage_sync_artifact(
    connection: &Connection,
    root: &Path,
    payload: SyncArtifactStagingRequest,
) -> Result<SyncStagedArtifactSchema, String> {
    if payload.size_bytes < 0 {
        return Err("Sync staged artifact size_bytes must be non-negative.".to_string());
    }
    let content_sha256 = normalize_sha256(&payload.content_sha256, "content_sha256")?;
    let source_path = PathBuf::from(&payload.source_path);
    let metadata = fs::metadata(&source_path)
        .map_err(|_| "Source artifact is missing or unreadable.".to_string())?;
    if metadata.len() as i64 != payload.size_bytes {
        return Err(
            "Source artifact size does not match the requested staged artifact size.".to_string(),
        );
    }
    let actual_sha256 = file_sha256(&source_path)?;
    if actual_sha256 != content_sha256 {
        return Err(
            "Source artifact SHA-256 does not match the requested staged artifact hash."
                .to_string(),
        );
    }
    let relative_path = sync_staging_relative_path(&content_sha256)?;
    let destination_path = staged_artifact_path(root, &relative_path)?;
    let needs_copy = match fs::metadata(&destination_path) {
        Ok(existing_metadata) if existing_metadata.len() as i64 == payload.size_bytes => {
            file_sha256(&destination_path)? != content_sha256
        }
        Ok(_) => true,
        Err(_) => true,
    };
    if needs_copy {
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source_path, &destination_path).map_err(|error| error.to_string())?;
    }
    let timestamp = now_iso();
    connection
        .execute(
            "INSERT INTO sync_staged_artifacts (content_sha256, size_bytes, relative_path, provider_device_id, metadata_json, verified_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)
             ON CONFLICT(content_sha256) DO UPDATE SET size_bytes = excluded.size_bytes, relative_path = excluded.relative_path, provider_device_id = excluded.provider_device_id, metadata_json = excluded.metadata_json, verified_at = excluded.verified_at, updated_at = excluded.updated_at",
            params![
                content_sha256,
                payload.size_bytes,
                relative_path,
                payload.provider_device_id,
                payload.metadata.to_string(),
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
    get_staged_artifact(
        connection,
        root,
        &payload.content_sha256,
        Some(payload.size_bytes),
    )
}

pub fn mobile_stage_sync_artifact(
    app: AppHandle,
    payload: SyncArtifactStagingRequest,
) -> Result<SyncStagedArtifactSchema, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    stage_sync_artifact(&connection, &root, payload)
}

pub fn mobile_get_sync_staged_artifact(
    app: AppHandle,
    content_sha256: String,
) -> Result<SyncStagedArtifactSchema, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    get_staged_artifact(&connection, &root, &content_sha256, None)
}

pub(super) fn can_upgrade_project_placeholder(
    project: &ProjectSchema,
    project_id: &str,
    source_sha256: &str,
) -> bool {
    project.id == project_id
        && project
            .source_sha256
            .as_deref()
            .map_or(true, |existing_hash| existing_hash == source_sha256)
        && is_sync_placeholder_state(
            &project.sync_status,
            &project.source_path,
            &project.imported_path,
        )
}

pub(super) fn delete_project_rows(connection: &Connection, project_id: &str) -> Result<(), String> {
    for sql in [
        "DELETE FROM jobs WHERE project_id = ?1",
        "DELETE FROM artifacts WHERE project_id = ?1",
        "DELETE FROM lyrics_transcripts WHERE project_id = ?1",
        "DELETE FROM sync_entity_revisions WHERE project_id = ?1",
        "DELETE FROM sync_delete_tombstones WHERE project_id = ?1",
        "DELETE FROM projects WHERE id = ?1",
    ] {
        connection
            .execute(sql, params![project_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn discard_deleted_project_placeholders(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    source_sha256: &str,
) -> Result<(), String> {
    let placeholder_ids = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM projects WHERE sync_status = 'deleted' AND (id = ?1 OR source_sha256 = ?2) ORDER BY created_at ASC, id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id, source_sha256], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        let mut placeholder_ids = Vec::new();
        for row in rows {
            placeholder_ids.push(row.map_err(|error| error.to_string())?);
        }
        placeholder_ids
    };

    for placeholder_id in placeholder_ids {
        delete_project_rows(connection, &placeholder_id)?;
        if let Ok(project_root) = project_root_path(root, &placeholder_id) {
            if project_root.exists() {
                let _ = fs::remove_dir_all(project_root);
            }
        }
    }
    Ok(())
}

pub(super) fn clear_project_delete_tombstones_for_reimport(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM sync_delete_tombstones WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
pub(super) fn is_android_file_uri(source_path: &str) -> bool {
    source_path.starts_with("content://") || source_path.starts_with("file://")
}

pub(super) fn source_filename(app: &AppHandle, source_path: &str) -> String {
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

pub(super) fn source_stem(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Imported Track")
        .to_string()
}

pub(super) fn source_format(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .unwrap_or("audio")
        .to_ascii_lowercase()
}

pub(super) fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

pub(super) fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub(super) fn copy_source_into_project(
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
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE sync_status != 'deleted'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {PROJECT_COLUMNS} FROM projects WHERE sync_status != 'deleted' ORDER BY updated_at DESC, id DESC LIMIT ?1 OFFSET ?2"
            ))
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
                "SELECT COUNT(*) FROM projects WHERE sync_status != 'deleted' AND (lower(display_name) LIKE ?1 OR lower(source_path) LIKE ?1 OR lower(imported_path) LIKE ?1)",
                params![&like_term],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {PROJECT_COLUMNS} FROM projects WHERE sync_status != 'deleted' AND (lower(display_name) LIKE ?1 OR lower(source_path) LIKE ?1 OR lower(imported_path) LIKE ?1) ORDER BY updated_at DESC, id DESC LIMIT ?2 OFFSET ?3"
            ))
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

    let source_file_name = source_filename(&app, &payload.source_path);
    let needs_copy = payload.copy_into_project || source_is_uri;
    let temporary_import_path = if needs_copy {
        let temp_dir = root.join("sync").join("imports").join(new_id("import"));
        fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
        let temp_path = temp_dir.join(&source_file_name);
        copy_source_into_project(&app, &payload.source_path, &temp_path)?;
        Some(temp_path)
    } else {
        None
    };
    let hash_source_path = temporary_import_path.as_ref().unwrap_or(&source);
    let source_sha256 = file_sha256(hash_source_path)?;
    let project_id = source_hash_to_project_id(&source_sha256)?;
    discard_deleted_project_placeholders(&connection, &root, &project_id, &source_sha256)?;
    let existing_project = find_existing_project_source(&connection, &project_id, &source_sha256)?;
    let upgrading_placeholder = existing_project.as_ref().is_some_and(|project| {
        can_upgrade_project_placeholder(project, &project_id, &source_sha256)
    });
    if let Some(existing) = existing_project {
        if !upgrading_placeholder {
            if let Some(temp_path) = temporary_import_path {
                if let Some(parent) = temp_path.parent() {
                    let _ = fs::remove_dir_all(parent);
                }
            }
            return Err(format!(
                "This project is already imported with name \"{}\".",
                existing.display_name
            ));
        }
    }
    clear_project_delete_tombstones_for_reimport(&connection, &project_id)?;
    let project_root = project_root_path(&root, &project_id)?;
    let source_dir = project_root.join("source");
    fs::create_dir_all(&source_dir).map_err(|error| error.to_string())?;
    let imported_path = if let Some(temp_path) = temporary_import_path {
        let target = source_dir.join(&source_file_name);
        fs::rename(&temp_path, &target)
            .or_else(|_| {
                fs::copy(&temp_path, &target)?;
                fs::remove_file(&temp_path)
            })
            .map_err(|error| error.to_string())?;
        if let Some(parent) = temp_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
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
        source_sha256: Some(source_sha256.clone()),
        source_path: payload.source_path.clone(),
        imported_path: imported_path.to_string_lossy().into_owned(),
        duration_seconds: None,
        sample_rate: None,
        channels: None,
        sync_status: DEFAULT_SYNC_STATUS.to_string(),
        sync_status_reason: None,
        sync_editable: true,
        sync_required_artifact_ids: Vec::new(),
        sync_provider_device_ids: Vec::new(),
        sync_conflict_count: 0,
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
    };
    if upgrading_placeholder {
        connection
            .execute(
                "UPDATE projects SET display_name = ?1, source_key_override = ?2, source_sha256 = ?3, source_path = ?4, imported_path = ?5, duration_seconds = ?6, sample_rate = ?7, channels = ?8, sync_status = 'local', sync_status_reason = NULL, sync_required_artifact_ids_json = ?9, sync_provider_device_ids_json = ?9, sync_conflict_count = 0, sync_status_updated_at = ?10, updated_at = ?10 WHERE id = ?11",
                params![
                    project.display_name,
                    project.source_key_override,
                    project.source_sha256,
                    project.source_path,
                    project.imported_path,
                    project.duration_seconds,
                    project.sample_rate,
                    project.channels,
                    DEFAULT_SYNC_LIST_JSON,
                    timestamp,
                    project.id,
                ],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, sync_status_reason, sync_required_artifact_ids_json, sync_provider_device_ids_json, sync_conflict_count, sync_status_updated_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    project.id,
                    project.display_name,
                    project.source_key_override,
                    project.source_sha256,
                    project.source_path,
                    project.imported_path,
                    project.duration_seconds,
                    project.sample_rate,
                    project.channels,
                    project.sync_status,
                    project.sync_status_reason,
                    DEFAULT_SYNC_LIST_JSON,
                    DEFAULT_SYNC_LIST_JSON,
                    project.sync_conflict_count,
                    timestamp,
                    project.created_at,
                    project.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    let size_bytes = fs::metadata(&imported_path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    let source_artifact_id = new_id("art");
    let artifact_metadata = json!({ "source_path": payload.source_path });

    connection
        .execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at)
             VALUES (?1, ?2, 'source_audio', ?3, ?4, ?5, ?6, 'import', 0, 0, ?7, NULL, ?8)",
            params![
                &source_artifact_id,
                &project_id,
                source_format(&imported_path),
                imported_path.to_string_lossy().into_owned(),
                source_sha256,
                size_bytes,
                artifact_metadata.to_string(),
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;

    spawn_playback_proxy_generation(root, project_root, imported_path, source_artifact_id);

    Ok(ProjectResponse { project })
}

pub fn mobile_get_project(app: AppHandle, project_id: String) -> Result<ProjectResponse, String> {
    let connection = db(&app)?;
    Ok(ProjectResponse {
        project: get_project_schema(&connection, &project_id)?,
    })
}

pub fn mobile_update_project(
    app: AppHandle,
    project_id: String,
    payload: ProjectUpdateRequest,
) -> Result<ProjectResponse, String> {
    let connection = db(&app)?;
    let current = require_sync_editable_project(&connection, &project_id)?;
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

pub fn mobile_delete_project(app: AppHandle, project_id: String) -> Result<DeleteResponse, String> {
    let connection = db(&app)?;
    let project = require_sync_editable_project(&connection, &project_id)?;
    let root = app_data_root(&app)?;
    let project_root = project_cleanup_root_path(&root, &project_id)?;
    let artifacts = list_project_artifacts(&connection, &project_id)?;
    for artifact in &artifacts {
        record_local_delete_tombstone(
            &connection,
            &project_id,
            "artifact",
            &artifact.id,
            json!({
                "project_id": artifact.project_id,
                "type": artifact.r#type,
                "content_sha256": artifact.content_sha256,
                "size_bytes": artifact.size_bytes,
            }),
        )?;
    }
    for revision in list_project_entity_revisions(&connection, &project_id)? {
        record_local_delete_tombstone(
            &connection,
            &project_id,
            "entity_revision",
            &revision.revision_id,
            json!({
                "project_id": revision.project_id,
                "entity_type": revision.entity_type,
                "entity_id": revision.entity_id,
                "content_sha256": revision.content_sha256,
            }),
        )?;
    }
    record_local_delete_tombstone(
        &connection,
        &project_id,
        "project",
        &project_id,
        json!({
            "project_id": project.id,
            "display_name": project.display_name,
            "source_sha256": project.source_sha256,
        }),
    )?;
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
        .execute(
            "DELETE FROM sync_entity_revisions WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|error| error.to_string())?;
    if project_root.exists() {
        fs::remove_dir_all(project_root).map_err(|error| error.to_string())?;
    }
    Ok(DeleteResponse { deleted: true })
}

pub fn mobile_list_artifacts(
    app: AppHandle,
    project_id: String,
) -> Result<ArtifactsResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let _ = get_project_schema(&connection, &project_id)?;
    ensure_source_playback_proxy_metadata(&connection, &root, &project_id)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 ORDER BY created_at DESC"
        ))
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

pub fn mobile_delete_artifact(
    app: AppHandle,
    project_id: String,
    artifact_id: String,
) -> Result<DeleteResponse, String> {
    let connection = db(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    let artifact = connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1 AND project_id = ?2"),
            params![artifact_id, project_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Artifact does not belong to this project.".to_string())?;
    if !artifact.can_delete {
        return Err("This artifact cannot be deleted.".to_string());
    }
    record_local_delete_tombstone(
        &connection,
        &project_id,
        "artifact",
        &artifact.id,
        json!({
            "project_id": artifact.project_id,
            "type": artifact.r#type,
            "content_sha256": artifact.content_sha256,
            "size_bytes": artifact.size_bytes,
        }),
    )?;
    if Path::new(&artifact.path).exists() {
        fs::remove_file(&artifact.path).map_err(|error| error.to_string())?;
    }
    connection
        .execute("DELETE FROM artifacts WHERE id = ?1", params![artifact.id])
        .map_err(|error| error.to_string())?;
    Ok(DeleteResponse { deleted: true })
}

pub fn mobile_list_jobs(
    app: AppHandle,
    params: Option<ListJobsParams>,
) -> Result<JobsResponse, String> {
    let params = params.unwrap_or_default();
    let limit = normalized_jobs_limit(params.limit)?;
    let offset = normalized_jobs_offset(params.offset)?;
    let connection = db(&app)?;
    let project_display_names = list_project_display_names(&connection)?;
    let mut statement = connection
        .prepare(&format!("SELECT {JOB_COLUMNS} FROM jobs"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_job)
        .map_err(|error| error.to_string())?;
    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(row.map_err(|error| error.to_string())?);
    }
    mobile_jobs_response_for_params(jobs, &params, &project_display_names, limit, offset)
}

pub fn mobile_get_job(app: AppHandle, job_id: String) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let job = connection
        .query_row(
            &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = ?1"),
            params![job_id],
            row_job,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Job not found.".to_string())?;
    Ok(JobResponse { job })
}

pub fn mobile_cancel_job(app: AppHandle, job_id: String) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    connection
        .execute(
            "UPDATE jobs SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('pending', 'running')",
            params![MOBILE_CANCELLED_JOB_STATUS, now_iso(), job_id],
        )
        .map_err(|error| error.to_string())?;
    mobile_get_job(app, job_id)
}

pub fn mobile_submit_export(
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
            "export",
            "Android Media3 export is not wired yet.",
        )?,
    })
}

pub fn mobile_sync_transport_artifact_file(
    app: AppHandle,
    artifact_id: &str,
) -> Result<MobileSyncTransportArtifactFile, String> {
    if artifact_id.trim().is_empty() || artifact_id != artifact_id.trim() {
        return Err("artifact_id must be canonical.".to_string());
    }
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let artifact = connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"),
            params![artifact_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Artifact is unknown.".to_string())?;
    if artifact.size_bytes < 0 {
        return Err("Artifact size_bytes must be non-negative.".to_string());
    }
    let relative_path = relative_artifact_path(&root, &artifact)
        .ok_or_else(|| "Project artifact path is outside the mobile app data root.".to_string())?;
    safe_relative_path(&relative_path)?;
    let content_sha256 = artifact
        .content_sha256
        .as_deref()
        .ok_or_else(|| "Project artifact is missing content SHA-256 metadata.".to_string())
        .and_then(|value| normalize_sha256(value, "content_sha256"))?;
    let path = PathBuf::from(&artifact.path);
    let metadata = fs::metadata(&path)
        .map_err(|_| "Project artifact file is missing or unreadable.".to_string())?;
    if metadata.len() as i64 != artifact.size_bytes {
        return Err("Project artifact file size does not match its metadata.".to_string());
    }
    if file_sha256(&path)? != content_sha256 {
        return Err("Project artifact file SHA-256 does not match its metadata.".to_string());
    }
    Ok(MobileSyncTransportArtifactFile {
        path,
        size_bytes: artifact.size_bytes as u64,
    })
}
