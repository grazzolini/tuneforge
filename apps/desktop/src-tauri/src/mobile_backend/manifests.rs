use super::*;

pub(super) fn normalize_sync_status(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "local" | "syncing" | "remote_available" | "downloading" | "missing" | "deleted"
        | "conflicted" => Ok(normalized),
        _ => Err("Project sync status is not supported.".to_string()),
    }
}

pub(super) fn normalize_string_ids(values: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for value in values.unwrap_or_default() {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err("Sync ID lists cannot contain empty values.".to_string());
        }
        normalized.push(trimmed.to_string());
    }
    Ok(normalized)
}

pub(super) fn metadata_from_status_payload(
    project_id: &str,
    payload: &SyncProjectStatusUpdateRequest,
) -> Result<Option<SyncProjectStatusProjectMetadataSchema>, String> {
    if payload.manifest.is_some() && payload.project.is_some() {
        return Err("Provide either manifest or project metadata, not both.".to_string());
    }
    if let Some(manifest) = &payload.manifest {
        if manifest.project.project_id != project_id {
            return Err("Project manifest metadata belongs to a different project.".to_string());
        }
        validate_project_source_identity(
            &manifest.project.project_id,
            Some(&manifest.project.source_sha256),
        )?;
        return Ok(Some(SyncProjectStatusProjectMetadataSchema {
            project_id: manifest.project.project_id.clone(),
            display_name: manifest.project.display_name.clone(),
            source_key_override: manifest.project.source_key_override.clone(),
            source_sha256: Some(manifest.project.source_sha256.clone()),
            duration_seconds: manifest.project.duration_seconds,
            sample_rate: manifest.project.sample_rate,
            channels: manifest.project.channels,
            created_at: Some(manifest.project.created_at.clone()),
            updated_at: Some(manifest.project.updated_at.clone()),
        }));
    }
    if let Some(project) = &payload.project {
        if project.project_id != project_id {
            return Err("Project metadata belongs to a different project.".to_string());
        }
        validate_project_source_identity(&project.project_id, project.source_sha256.as_deref())?;
        return Ok(Some(project.clone()));
    }
    Ok(None)
}

pub(super) fn create_project_placeholder(
    connection: &Connection,
    project_id: &str,
    metadata: SyncProjectStatusProjectMetadataSchema,
) -> Result<(), String> {
    validate_project_source_identity(project_id, metadata.source_sha256.as_deref())?;
    let timestamp = now_iso();
    let created_at = metadata.created_at.unwrap_or_else(|| timestamp.clone());
    let updated_at = metadata.updated_at.unwrap_or_else(|| timestamp.clone());
    connection
            .execute(
                "INSERT INTO projects (id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, sync_status_reason, sync_required_artifact_ids_json, sync_provider_device_ids_json, sync_conflict_count, sync_status_updated_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '', '', ?5, ?6, ?7, 'remote_available', NULL, ?8, ?8, 0, ?9, ?10, ?11)",
                params![
                    project_id,
                    metadata.display_name,
                    metadata.source_key_override,
                    metadata.source_sha256,
                    metadata.duration_seconds,
                    metadata.sample_rate,
                    metadata.channels,
                    DEFAULT_SYNC_LIST_JSON,
                    timestamp,
                    created_at,
                    updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn verify_project_local_bytes(
    connection: &Connection,
    required_artifact_ids: &[String],
) -> Result<(), String> {
    for artifact_id in required_artifact_ids {
        let artifact = connection
            .query_row(
                &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"),
                params![artifact_id],
                row_artifact,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Required local artifact metadata is missing.".to_string())?;
        let content_sha256 = artifact.content_sha256.ok_or_else(|| {
            "Required local artifact is missing content SHA-256 metadata.".to_string()
        })?;
        let metadata = fs::metadata(&artifact.path)
            .map_err(|_| "Required local artifact bytes are missing.".to_string())?;
        if metadata.len() as i64 != artifact.size_bytes {
            return Err("Required local artifact size does not match metadata.".to_string());
        }
        if file_sha256(Path::new(&artifact.path))?
            != normalize_sha256(&content_sha256, "content_sha256")?
        {
            return Err("Required local artifact SHA-256 does not match metadata.".to_string());
        }
    }
    Ok(())
}

pub(super) fn update_project_sync_status(
    connection: &Connection,
    project_id: &str,
    payload: SyncProjectStatusUpdateRequest,
) -> Result<ProjectSchema, String> {
    let project_id = validate_canonical_project_id(project_id)?;
    let sync_status = normalize_sync_status(&payload.sync_status)?;
    let placeholder_metadata = metadata_from_status_payload(&project_id, &payload)?;
    let status_reason = trim_optional_string(payload.sync_status_reason);
    let required_artifact_ids = normalize_string_ids(payload.sync_required_artifact_ids)?;
    let provider_device_ids = normalize_string_ids(payload.sync_provider_device_ids)?;
    let conflict_count = payload.sync_conflict_count.unwrap_or(0).max(0);

    if get_project_schema(connection, &project_id).is_err() {
        let metadata = placeholder_metadata.ok_or_else(|| {
            "A project manifest is required to create a sync project placeholder.".to_string()
        })?;
        create_project_placeholder(connection, &project_id, metadata)?;
    }

    if sync_status == DEFAULT_SYNC_STATUS {
        let current = get_project_schema(connection, &project_id)?;
        let required = if required_artifact_ids.is_empty() {
            current.sync_required_artifact_ids
        } else {
            required_artifact_ids
        };
        verify_project_local_bytes(connection, &required)?;
        connection
                .execute(
                    "UPDATE projects SET sync_status = 'local', sync_status_reason = NULL, sync_required_artifact_ids_json = ?1, sync_provider_device_ids_json = ?1, sync_conflict_count = 0, sync_status_updated_at = ?2, updated_at = ?2 WHERE id = ?3",
                    params![DEFAULT_SYNC_LIST_JSON, now_iso(), &project_id],
                )
                .map_err(|error| error.to_string())?;
    } else {
        connection
                .execute(
                    "UPDATE projects SET sync_status = ?1, sync_status_reason = ?2, sync_required_artifact_ids_json = ?3, sync_provider_device_ids_json = ?4, sync_conflict_count = ?5, sync_status_updated_at = ?6, updated_at = ?6 WHERE id = ?7",
                    params![
                        sync_status,
                        status_reason,
                        serde_json::to_string(&required_artifact_ids).map_err(|error| error.to_string())?,
                        serde_json::to_string(&provider_device_ids).map_err(|error| error.to_string())?,
                        conflict_count,
                        now_iso(),
                        &project_id,
                    ],
                )
                .map_err(|error| error.to_string())?;
    }
    get_project_schema(connection, &project_id)
}

pub(super) fn local_sync_group_and_device(
    connection: &Connection,
) -> Result<(String, String), String> {
    let identity = local_identity(connection)?;
    Ok((identity.sync_group_id, identity.device_id))
}

pub(super) fn normalize_tombstone_target_type(target_type: &str) -> String {
    match target_type.trim().to_ascii_lowercase().as_str() {
        "revision" | "sync_entity_revision" => "entity_revision".to_string(),
        other => other.to_string(),
    }
}

pub(super) fn validate_remote_delete_tombstone(
    connection: &Connection,
    tombstone: &SyncDeleteTombstoneSchema,
) -> Result<(), String> {
    validate_delete_tombstone_required_fields(tombstone)?;
    validate_canonical_project_id(&tombstone.project_id)?;
    let target_type = normalize_tombstone_target_type(&tombstone.target_type);
    if !matches!(
        target_type.as_str(),
        "project" | "artifact" | "entity_revision"
    ) {
        return Err("Remote delete tombstone target_type is not supported.".to_string());
    }
    if tombstone.target_id.trim().is_empty() {
        return Err("Remote delete tombstone target_id must not be empty.".to_string());
    }
    if target_type == "project" && tombstone.target_id != tombstone.project_id {
        return Err("Remote project delete tombstone target_id must match project_id.".to_string());
    }
    let identity = local_identity(connection)?;
    let active_trusted_device_ids = active_trusted_device_ids(connection)?
        .into_iter()
        .collect::<Vec<_>>();
    validate_remote_tombstone_identity(
        &tombstone.sync_group_id,
        &tombstone.author_device_id,
        &identity.sync_group_id,
        &identity.device_id,
        &active_trusted_device_ids,
    )
}

pub(super) fn validate_manifest_delete_tombstones(
    connection: &Connection,
    manifest: &SyncProjectManifestSchema,
) -> Result<(), String> {
    validate_manifest_delete_tombstone_targets(manifest)?;
    for tombstone in &manifest.delete_tombstones {
        if tombstone.project_id != manifest.project.project_id {
            return Err(
                "Project manifest delete tombstone belongs to a different project.".to_string(),
            );
        }
        validate_remote_delete_tombstone(connection, tombstone)?;
    }
    Ok(())
}

pub(super) fn upsert_delete_tombstone(
    connection: &Connection,
    tombstone: &SyncDeleteTombstoneSchema,
) -> Result<(), String> {
    let target_type = normalize_tombstone_target_type(&tombstone.target_type);
    let prior_metadata_json = sanitize_sync_manifest_value(&tombstone.prior_metadata).to_string();
    connection
            .execute(
                "INSERT INTO sync_delete_tombstones (id, sync_group_id, project_id, target_type, target_id, author_device_id, deleted_at, prior_metadata_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(sync_group_id, target_type, target_id) DO UPDATE SET project_id = excluded.project_id, author_device_id = excluded.author_device_id, deleted_at = excluded.deleted_at, prior_metadata_json = excluded.prior_metadata_json, updated_at = excluded.updated_at",
                params![
                    tombstone.tombstone_id,
                    tombstone.sync_group_id,
                    tombstone.project_id,
                    target_type,
                    tombstone.target_id,
                    tombstone.author_device_id,
                    tombstone.deleted_at,
                    prior_metadata_json,
                    tombstone.created_at,
                    tombstone.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn record_local_delete_tombstone(
    connection: &Connection,
    project_id: &str,
    target_type: &str,
    target_id: &str,
    prior_metadata: Value,
) -> Result<(), String> {
    let (sync_group_id, author_device_id) = local_sync_group_and_device(connection)?;
    let timestamp = now_iso();
    let tombstone = SyncDeleteTombstoneSchema {
        tombstone_id: new_id("tomb"),
        sync_group_id,
        project_id: project_id.to_string(),
        target_type: normalize_tombstone_target_type(target_type),
        target_id: target_id.to_string(),
        author_device_id,
        deleted_at: timestamp.clone(),
        prior_metadata,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    upsert_delete_tombstone(connection, &tombstone)
}

pub(super) fn apply_delete_tombstone(
    connection: &Connection,
    tombstone: &SyncDeleteTombstoneSchema,
) -> Result<(), String> {
    validate_remote_delete_tombstone(connection, tombstone)?;
    upsert_delete_tombstone(connection, tombstone)?;
    match normalize_tombstone_target_type(&tombstone.target_type).as_str() {
        "project" => {
            connection
                    .execute(
                        "UPDATE projects SET sync_status = 'deleted', sync_status_reason = ?1, sync_conflict_count = 0, sync_status_updated_at = ?2, updated_at = ?2 WHERE id = ?3",
                        params![
                            "Project was deleted by sync tombstone.",
                            now_iso(),
                            tombstone.project_id,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
        }
        "artifact" => {
            let artifact_path: Option<String> = connection
                .query_row(
                    "SELECT path FROM artifacts WHERE id = ?1 AND project_id = ?2",
                    params![tombstone.target_id, tombstone.project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(path) = artifact_path {
                let _ = fs::remove_file(path);
            }
            connection
                .execute(
                    "DELETE FROM artifacts WHERE id = ?1 AND project_id = ?2",
                    params![tombstone.target_id, tombstone.project_id],
                )
                .map_err(|error| error.to_string())?;
        }
        "entity_revision" => {
            connection
                    .execute(
                        "UPDATE sync_entity_revisions SET state = 'deleted', updated_at = ?1 WHERE id = ?2 AND project_id = ?3",
                        params![now_iso(), tombstone.target_id, tombstone.project_id],
                    )
                    .map_err(|error| error.to_string())?;
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn local_tombstone_superseded_by_live_target(
    connection: &Connection,
    tombstone: &SyncDeleteTombstoneSchema,
) -> Result<bool, String> {
    let target_type = normalize_tombstone_target_type(&tombstone.target_type);
    let live_timestamp: Option<String> = match target_type.as_str() {
            "project" => {
                if tombstone.target_id != tombstone.project_id {
                    return Ok(false);
                }
                connection
                    .query_row(
                        "SELECT updated_at FROM projects WHERE id = ?1 AND sync_status != 'deleted'",
                        params![tombstone.project_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
            }
            "artifact" => connection
                .query_row(
                    "SELECT created_at FROM artifacts WHERE id = ?1 AND project_id = ?2",
                    params![tombstone.target_id, tombstone.project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?,
            "entity_revision" => connection
                .query_row(
                    "SELECT updated_at FROM sync_entity_revisions WHERE id = ?1 AND project_id = ?2 AND state != 'deleted'",
                    params![tombstone.target_id, tombstone.project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?,
            _ => None,
        };
    Ok(live_timestamp
        .as_deref()
        .is_some_and(|live_at| sync_timestamp_is_newer(live_at, &tombstone.deleted_at)))
}

pub(super) fn validate_project_manifest_identity(
    manifest: &SyncProjectManifestSchema,
) -> Result<(), String> {
    validate_sync_project_manifest_identity(manifest)
}

pub(super) fn import_entity_revisions(
    connection: &Connection,
    revisions: &[SyncProjectManifestEntityRevisionSchema],
) -> Result<(), String> {
    for revision in revisions {
        let existing_revision = connection
            .query_row(
                &format!("SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE id = ?1"),
                params![revision.revision_id],
                row_entity_revision,
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(existing) = existing_revision {
            if existing.content_sha256 != revision.content_sha256 {
                return Err(
                    "A synced entity revision conflicts with an existing local revision."
                        .to_string(),
                );
            }
            if existing.project_id != revision.project_id
                || existing.entity_type != revision.entity_type
                || existing.entity_id != revision.entity_id
                || existing.revision_type != revision.revision_type
                || existing.author_device_id != revision.author_device_id
            {
                return Err(
                    "A synced entity revision conflicts with an existing local revision."
                        .to_string(),
                );
            }
            connection
                .execute(
                    "UPDATE sync_entity_revisions SET base_revision_id = ?1, source_artifact_id = ?2, state = ?3, metadata_json = ?4, payload_json = ?5, created_at = ?6, updated_at = ?7 WHERE id = ?8",
                    params![
                        revision.base_revision_id,
                        revision.source_artifact_id,
                        revision.state,
                        revision.metadata.to_string(),
                        revision.payload.to_string(),
                        revision.created_at,
                        revision.updated_at,
                        revision.revision_id,
                    ],
                )
                .map_err(|error| error.to_string())?;
            continue;
        }
        connection
                .execute(
                    "INSERT INTO sync_entity_revisions (id, project_id, entity_type, entity_id, revision_type, base_revision_id, source_artifact_id, content_sha256, author_device_id, state, metadata_json, payload_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        revision.revision_id,
                        revision.project_id,
                        revision.entity_type,
                        revision.entity_id,
                        revision.revision_type,
                        revision.base_revision_id,
                        revision.source_artifact_id,
                        revision.content_sha256,
                        revision.author_device_id,
                        revision.state,
                        revision.metadata.to_string(),
                        revision.payload.to_string(),
                        revision.created_at,
                        revision.updated_at,
                    ],
                )
                .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn source_artifact_belongs_to_project(
    connection: &Connection,
    project_id: &str,
    source_artifact_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM artifacts WHERE id = ?1 AND project_id = ?2",
            params![source_artifact_id, project_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())
        .map(|row| row.is_some())
}

fn hydrate_analysis_result_from_artifact(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    let analysis_artifact = connection
        .query_row(
            &format!(
                "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 AND type = 'analysis_json' ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            params![project_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(analysis_artifact) = analysis_artifact else {
        return Ok(());
    };
    let raw_payload = fs::read_to_string(&analysis_artifact.path)
        .map_err(|_| "Analysis artifact payload must be readable JSON.".to_string())?;
    let payload: Value = serde_json::from_str(&raw_payload)
        .map_err(|_| "Analysis artifact payload must be readable JSON.".to_string())?;
    let parsed = mobile_analysis_artifact_payload(&payload, &analysis_artifact.metadata)?;
    if parsed
        .project_id
        .as_deref()
        .is_some_and(|payload_project_id| payload_project_id != project_id)
    {
        return Err("Analysis artifact project_id must match the manifest project.".to_string());
    }
    if let Some(source_artifact_id) = &parsed.source_artifact_id {
        if !source_artifact_belongs_to_project(connection, project_id, source_artifact_id)? {
            return Err(
                "Analysis artifact source_artifact_id must belong to the manifest project."
                    .to_string(),
            );
        }
    }

    let timing_json = parsed.timing.map(|timing| timing.to_string());
    let created_at = parsed
        .created_at
        .unwrap_or_else(|| analysis_artifact.created_at.clone());
    connection
        .execute(
            "INSERT INTO analysis_results (project_id, source_artifact_id, estimated_key, key_confidence, estimated_reference_hz, tuning_offset_cents, tempo_bpm, timing_json, analysis_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(project_id) DO UPDATE SET source_artifact_id = excluded.source_artifact_id, estimated_key = excluded.estimated_key, key_confidence = excluded.key_confidence, estimated_reference_hz = excluded.estimated_reference_hz, tuning_offset_cents = excluded.tuning_offset_cents, tempo_bpm = excluded.tempo_bpm, timing_json = excluded.timing_json, analysis_version = excluded.analysis_version, created_at = excluded.created_at",
            params![
                project_id,
                parsed.source_artifact_id,
                parsed.estimated_key,
                parsed.key_confidence,
                parsed.estimated_reference_hz,
                parsed.tuning_offset_cents,
                parsed.tempo_bpm,
                timing_json,
                parsed.analysis_version,
                created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn hydrate_chord_revision(
    connection: &Connection,
    revision: &SyncProjectManifestEntityRevisionSchema,
) -> Result<(), String> {
    let parsed = mobile_chord_revision_payload(revision)?;
    if let Some(source_artifact_id) = &parsed.source_artifact_id {
        if !source_artifact_belongs_to_project(
            connection,
            &revision.project_id,
            source_artifact_id,
        )? {
            return Err(
                "Chord revision source_artifact_id must belong to the manifest project."
                    .to_string(),
            );
        }
    }
    let source_segments_json =
        serde_json::to_string(&parsed.source_segments).map_err(|error| error.to_string())?;
    let segments_json =
        serde_json::to_string(&parsed.segments).map_err(|error| error.to_string())?;
    let timeline_json =
        serde_json::to_string(&parsed.timeline).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO chord_timelines (project_id, source_segments_json, segments_json, timeline_json, backend, source_artifact_id, source_kind, metadata_json, has_user_edits, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(project_id) DO UPDATE SET source_segments_json = excluded.source_segments_json, segments_json = excluded.segments_json, timeline_json = excluded.timeline_json, backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, source_kind = excluded.source_kind, metadata_json = excluded.metadata_json, has_user_edits = excluded.has_user_edits, created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                &revision.project_id,
                source_segments_json,
                segments_json,
                timeline_json,
                parsed.backend,
                parsed.source_artifact_id,
                parsed.source_kind,
                parsed.metadata.to_string(),
                if parsed.has_user_edits { 1_i64 } else { 0_i64 },
                parsed.created_at,
                parsed.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn hydrate_imported_read_models(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    let project = get_project_schema(connection, project_id)?;
    if project.sync_status == "deleted" {
        return Ok(());
    }
    let mut statement = connection
        .prepare(
            &format!(
                "SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE project_id = ?1 AND state IN ('active', 'current') AND entity_type IN ('chords', 'chord_timeline') ORDER BY created_at ASC, id ASC"
            ),
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], row_entity_revision)
        .map_err(|error| error.to_string())?;
    let mut hydrated_chords = false;
    for row in rows {
        if hydrated_chords {
            return Err("Project manifest contains multiple current chords revisions.".to_string());
        }
        hydrate_chord_revision(connection, &row.map_err(|error| error.to_string())?)?;
        hydrated_chords = true;
    }
    hydrate_analysis_result_from_artifact(connection, project_id)
}

pub(super) fn artifact_staged_source_path(
    connection: &Connection,
    root: &Path,
    artifact: &SyncProjectManifestArtifactSchema,
    staging_root: Option<&Path>,
    use_content_addressed_staging: bool,
) -> Result<PathBuf, String> {
    if use_content_addressed_staging {
        let staged = get_staged_artifact(
            connection,
            root,
            &artifact.content_sha256,
            Some(artifact.size_bytes),
        )?;
        return verify_staged_artifact(root, &staged, Some(artifact.size_bytes));
    }
    let base = staging_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("sync").join("staging"));
    let staged_path = base.join(safe_relative_path(&artifact.relative_path)?);
    let metadata = fs::metadata(&staged_path)
        .map_err(|_| "Staged artifact file is missing or unreadable.".to_string())?;
    if metadata.len() as i64 != artifact.size_bytes {
        return Err("Staged artifact file size does not match manifest.".to_string());
    }
    if file_sha256(&staged_path)? != artifact.content_sha256 {
        return Err("Staged artifact file SHA-256 does not match manifest.".to_string());
    }
    Ok(staged_path)
}

struct PreparedManifestArtifact {
    manifest: SyncProjectManifestArtifactSchema,
    destination_path: PathBuf,
    existing: Option<ArtifactSchema>,
    staged_path: Option<PathBuf>,
}

pub(super) fn artifact_file_matches(path: &Path, content_sha256: &str, size_bytes: i64) -> bool {
    if !path.is_file() {
        return false;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.len() as i64 == size_bytes && file_sha256(path).ok().as_deref() == Some(content_sha256)
}

pub(super) fn cleanup_copied_artifacts(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

pub(super) fn import_sync_project_manifest(
    connection: &Connection,
    root: &Path,
    payload: SyncProjectStagedImportRequest,
) -> Result<ProjectSchema, String> {
    validate_project_manifest_identity(&payload.manifest)?;
    validate_manifest_delete_tombstones(connection, &payload.manifest)?;
    let project_id = validate_project_source_identity(
        &payload.manifest.project.project_id,
        Some(&payload.manifest.project.source_sha256),
    )?;
    let source_sha256 = normalize_sha256(&payload.manifest.project.source_sha256, "source_sha256")?;
    if let Some(existing) = find_existing_project_source(connection, &project_id, &source_sha256)? {
        if existing.id != project_id
            || existing
                .source_sha256
                .as_deref()
                .is_some_and(|existing_hash| existing_hash != source_sha256.as_str())
        {
            return Err(
                "A synced project manifest conflicts with an existing local project.".to_string(),
            );
        }
    }

    let staging_root = payload.staging_root.as_ref().map(PathBuf::from);
    let use_content_addressed_staging = payload.use_content_addressed_staging.unwrap_or(true);
    let project_root = project_root_path(root, &project_id)?;
    let timestamp = now_iso();
    let existing_project = get_project_schema(connection, &project_id).ok();
    let source_artifact = manifest_source_audio_artifact(&payload.manifest)?;
    let source_path = project_root.join(safe_relative_path(&source_artifact.relative_path)?);

    let mut prepared_artifacts = Vec::new();
    for artifact in &payload.manifest.artifacts {
        let destination_path = project_root.join(safe_relative_path(&artifact.relative_path)?);
        let existing_artifact = connection
            .query_row(
                &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"),
                params![artifact.artifact_id],
                row_artifact,
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(existing) = &existing_artifact {
            if existing.project_id != artifact.project_id
                || existing.content_sha256.as_deref() != Some(artifact.content_sha256.as_str())
                || existing.size_bytes != artifact.size_bytes
            {
                return Err(
                    "A synced artifact conflicts with an existing local artifact.".to_string(),
                );
            }
        }
        let has_verified_destination = artifact_file_matches(
            &destination_path,
            &artifact.content_sha256,
            artifact.size_bytes,
        );
        let has_verified_existing = existing_artifact.as_ref().is_some_and(|existing| {
            artifact_file_matches(
                Path::new(&existing.path),
                &artifact.content_sha256,
                artifact.size_bytes,
            )
        });
        let staged_path = if has_verified_destination || has_verified_existing {
            None
        } else {
            Some(artifact_staged_source_path(
                connection,
                root,
                artifact,
                staging_root.as_deref(),
                use_content_addressed_staging,
            )?)
        };
        prepared_artifacts.push(PreparedManifestArtifact {
            manifest: artifact.clone(),
            destination_path,
            existing: existing_artifact,
            staged_path,
        });
    }

    ensure_mobile_project_dirs(root, &project_id)?;
    let mut copied_paths = Vec::new();
    for prepared in &prepared_artifacts {
        let Some(staged_path) = &prepared.staged_path else {
            continue;
        };
        if let Some(parent) = prepared.destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(staged_path, &prepared.destination_path).map_err(|error| {
            cleanup_copied_artifacts(&copied_paths);
            error.to_string()
        })?;
        if !artifact_file_matches(
            &prepared.destination_path,
            &prepared.manifest.content_sha256,
            prepared.manifest.size_bytes,
        ) {
            cleanup_copied_artifacts(&copied_paths);
            return Err("A copied artifact file does not match its manifest.".to_string());
        }
        copied_paths.push(prepared.destination_path.clone());
    }

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let db_result = (|| -> Result<(), String> {
        let source_path_string = source_path.to_string_lossy().into_owned();
        if existing_project.is_none() {
            connection
                    .execute(
                        "INSERT INTO projects (id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, sync_status_reason, sync_required_artifact_ids_json, sync_provider_device_ids_json, sync_conflict_count, sync_status_updated_at, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, 'local', NULL, ?9, ?9, 0, ?10, ?11, ?12)",
                        params![
                            &project_id,
                            &payload.manifest.project.display_name,
                            payload.manifest.project.source_key_override.as_ref(),
                            &source_sha256,
                            &source_path_string,
                            payload.manifest.project.duration_seconds,
                            payload.manifest.project.sample_rate,
                            payload.manifest.project.channels,
                            DEFAULT_SYNC_LIST_JSON,
                            &timestamp,
                            &payload.manifest.project.created_at,
                            &payload.manifest.project.updated_at,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
        } else {
            connection
                    .execute(
                        "UPDATE projects SET display_name = ?1, source_key_override = ?2, source_sha256 = ?3, source_path = ?4, imported_path = ?4, duration_seconds = ?5, sample_rate = ?6, channels = ?7, updated_at = ?8 WHERE id = ?9",
                        params![
                            &payload.manifest.project.display_name,
                            payload.manifest.project.source_key_override.as_ref(),
                            &source_sha256,
                            &source_path_string,
                            payload.manifest.project.duration_seconds,
                            payload.manifest.project.sample_rate,
                            payload.manifest.project.channels,
                            &timestamp,
                            &project_id,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
        }

        for prepared in &prepared_artifacts {
            let artifact = &prepared.manifest;
            let destination_path = prepared.destination_path.to_string_lossy().into_owned();
            let metadata = sanitize_sync_manifest_value(&artifact.metadata).to_string();
            if prepared.existing.is_some() {
                connection
                        .execute(
                            "UPDATE artifacts SET project_id = ?1, type = ?2, format = ?3, path = ?4, content_sha256 = ?5, size_bytes = ?6, generated_by = ?7, can_delete = ?8, can_regenerate = ?9, metadata_json = ?10, cache_key = ?11, created_at = ?12 WHERE id = ?13",
                            params![
                                &artifact.project_id,
                                &artifact.r#type,
                                &artifact.format,
                                &destination_path,
                                &artifact.content_sha256,
                                artifact.size_bytes,
                                &artifact.generated_by,
                                if artifact.can_delete { 1_i64 } else { 0_i64 },
                                if artifact.can_regenerate { 1_i64 } else { 0_i64 },
                                &metadata,
                                artifact.cache_key.as_ref(),
                                &artifact.created_at,
                                &artifact.artifact_id,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
            } else {
                connection
                        .execute(
                            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                            params![
                                &artifact.artifact_id,
                                &artifact.project_id,
                                &artifact.r#type,
                                &artifact.format,
                                &destination_path,
                                &artifact.content_sha256,
                                artifact.size_bytes,
                                &artifact.generated_by,
                                if artifact.can_delete { 1_i64 } else { 0_i64 },
                                if artifact.can_regenerate { 1_i64 } else { 0_i64 },
                                &metadata,
                                artifact.cache_key.as_ref(),
                                &artifact.created_at,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
            }
        }

        import_entity_revisions(connection, &payload.manifest.entity_revisions)?;
        connection
                .execute(
                    "UPDATE projects SET sync_status = 'local', sync_status_reason = ?1, sync_required_artifact_ids_json = ?2, sync_provider_device_ids_json = ?2, sync_conflict_count = 0, sync_status_updated_at = ?3, updated_at = ?3 WHERE id = ?4",
                    params!["Synced from desktop.", DEFAULT_SYNC_LIST_JSON, &timestamp, &project_id],
                )
                .map_err(|error| error.to_string())?;
        for tombstone in &payload.manifest.delete_tombstones {
            apply_delete_tombstone(connection, tombstone)?;
        }
        hydrate_imported_read_models(connection, &project_id)?;
        Ok(())
    })();

    if let Err(message) = db_result {
        let _ = connection.execute_batch("ROLLBACK");
        cleanup_copied_artifacts(&copied_paths);
        return Err(message);
    }
    if let Err(error) = connection.execute_batch("COMMIT") {
        let _ = connection.execute_batch("ROLLBACK");
        cleanup_copied_artifacts(&copied_paths);
        return Err(error.to_string());
    }
    get_project_schema(connection, &project_id)
}

pub fn mobile_get_sync_metadata(app: AppHandle) -> Result<SyncMetadataResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let mut projects_statement = connection
            .prepare(&format!(
                "SELECT {PROJECT_COLUMNS} FROM projects WHERE sync_status != 'deleted' ORDER BY created_at ASC, id ASC"
            ))
            .map_err(|error| error.to_string())?;
    let project_rows = projects_statement
        .query_map([], row_project)
        .map_err(|error| error.to_string())?;
    let mut projects = Vec::new();
    for row in project_rows {
        let project = row.map_err(|error| error.to_string())?;
        projects.push(SyncMetadataProjectSchema {
            project_id: project.id,
            display_name: project.display_name,
            source_key_override: project.source_key_override,
            source_sha256: project.source_sha256,
            duration_seconds: project.duration_seconds,
            sample_rate: project.sample_rate,
            channels: project.channels,
            created_at: project.created_at,
            updated_at: project.updated_at,
        });
    }

    let mut artifacts_statement = connection
            .prepare(&format!(
                "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id IN (SELECT id FROM projects WHERE sync_status != 'deleted') ORDER BY project_id ASC, created_at ASC, id ASC"
            ))
            .map_err(|error| error.to_string())?;
    let artifact_rows = artifacts_statement
        .query_map([], row_artifact)
        .map_err(|error| error.to_string())?;
    let mut artifacts = Vec::new();
    for row in artifact_rows {
        let artifact = row.map_err(|error| error.to_string())?;
        let relative_path = relative_artifact_path(&root, &artifact);
        artifacts.push(SyncMetadataArtifactSchema {
            artifact_id: artifact.id.clone(),
            project_id: artifact.project_id.clone(),
            r#type: artifact.r#type,
            format: artifact.format,
            relative_path,
            content_sha256: artifact.content_sha256,
            size_bytes: artifact.size_bytes,
            generated_by: artifact.generated_by,
            can_delete: artifact.can_delete,
            can_regenerate: artifact.can_regenerate,
            cache_key: artifact.cache_key,
            metadata: sanitize_sync_manifest_value(&artifact.metadata),
            created_at: artifact.created_at,
        });
    }

    let mut tombstones_statement = connection
            .prepare(&format!(
                "SELECT {SYNC_DELETE_TOMBSTONE_COLUMNS} FROM sync_delete_tombstones ORDER BY project_id ASC, target_type ASC, target_id ASC, deleted_at ASC, id ASC"
            ))
            .map_err(|error| error.to_string())?;
    let tombstone_rows = tombstones_statement
        .query_map([], row_delete_tombstone)
        .map_err(|error| error.to_string())?;
    let mut delete_tombstones = Vec::new();
    for row in tombstone_rows {
        let tombstone = row.map_err(|error| error.to_string())?;
        if !local_tombstone_superseded_by_live_target(&connection, &tombstone)? {
            delete_tombstones.push(tombstone);
        }
    }
    Ok(SyncMetadataResponse {
        projects,
        artifacts,
        delete_tombstones,
    })
}

pub fn mobile_get_sync_project_manifest(
    app: AppHandle,
    project_id: String,
) -> Result<SyncProjectManifestResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    Ok(SyncProjectManifestResponse {
        project_manifest: get_project_manifest(&connection, &root, &project_id)?,
    })
}

pub fn mobile_update_sync_project_status(
    app: AppHandle,
    project_id: String,
    payload: SyncProjectStatusUpdateRequest,
) -> Result<SyncProjectStatusUpdateResponse, String> {
    let connection = db(&app)?;
    Ok(SyncProjectStatusUpdateResponse {
        project: update_project_sync_status(&connection, &project_id, payload)?,
    })
}

pub fn mobile_import_sync_project(
    app: AppHandle,
    payload: SyncProjectStagedImportRequest,
) -> Result<SyncProjectImportResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    Ok(SyncProjectImportResponse {
        project: import_sync_project_manifest(&connection, &root, payload)?,
    })
}
