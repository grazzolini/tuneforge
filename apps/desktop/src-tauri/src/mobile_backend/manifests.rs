use super::storage_cleanup::{
    capture_owned_project_file, cleanup_owned_project_files, move_owned_project_file,
    prepare_owned_project_file, project_storage_mutation_guard, require_owned_project_file,
    OwnedProjectFile,
};
use super::*;
use crate::native_audio::decode::probe_mobile_durable_audio;

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
    let created_at = metadata
        .created_at
        .map(|value| normalize_sync_timestamp_utc(&value, "project created_at"))
        .transpose()?
        .unwrap_or_else(|| timestamp.clone());
    let updated_at = metadata
        .updated_at
        .map(|value| normalize_sync_timestamp_utc(&value, "project updated_at"))
        .transpose()?
        .unwrap_or_else(|| timestamp.clone());
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
) -> Result<bool, String> {
    let target_type = normalize_tombstone_target_type(&tombstone.target_type);
    let deleted_at = normalize_sync_timestamp_utc(&tombstone.deleted_at, "tombstone deleted_at")?;
    let created_at = normalize_sync_timestamp_utc(&tombstone.created_at, "tombstone created_at")?;
    let updated_at = normalize_sync_timestamp_utc(&tombstone.updated_at, "tombstone updated_at")?;
    let existing_deleted_at: Option<String> = connection
        .query_row(
            "SELECT deleted_at FROM sync_delete_tombstones WHERE sync_group_id = ?1 AND target_type = ?2 AND target_id = ?3",
            params![
                &tombstone.sync_group_id,
                &target_type,
                &tombstone.target_id
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(existing_deleted_at) = existing_deleted_at {
        let existing_deleted_at =
            parse_sync_timestamp_utc(&existing_deleted_at, "existing tombstone deleted_at")?;
        let incoming_deleted_at = parse_sync_timestamp_utc(&deleted_at, "tombstone deleted_at")?;
        if incoming_deleted_at <= existing_deleted_at {
            return Ok(false);
        }
    }
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
                    &target_type,
                    tombstone.target_id,
                    tombstone.author_device_id,
                    deleted_at,
                    prior_metadata_json,
                    created_at,
                    updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
    Ok(true)
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
    upsert_delete_tombstone(connection, &tombstone).map(|_| ())
}

pub(super) fn apply_delete_tombstone(
    connection: &Connection,
    tombstone: &SyncDeleteTombstoneSchema,
) -> Result<(), String> {
    validate_remote_delete_tombstone(connection, tombstone)?;
    if local_tombstone_superseded_by_live_target(connection, tombstone)? {
        return Ok(());
    }
    if !upsert_delete_tombstone(connection, tombstone)? {
        return Ok(());
    }
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
        .is_some_and(|live_at| sync_timestamp_is_newer_or_equal(live_at, &tombstone.deleted_at)))
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
                        normalize_sync_timestamp_utc(&revision.created_at, "revision created_at")?,
                        normalize_sync_timestamp_utc(&revision.updated_at, "revision updated_at")?,
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

fn hydrate_lyrics_revision(
    connection: &Connection,
    revision: &SyncProjectManifestEntityRevisionSchema,
) -> Result<(), String> {
    let parsed = mobile_lyrics_revision_payload(revision)?;
    if let Some(source_artifact_id) = &parsed.source_artifact_id {
        if !source_artifact_belongs_to_project(
            connection,
            &revision.project_id,
            source_artifact_id,
        )? {
            return Err(
                "Lyrics revision source_artifact_id must belong to the manifest project."
                    .to_string(),
            );
        }
    }
    let source_segments_json =
        serde_json::to_string(&parsed.source_segments).map_err(|error| error.to_string())?;
    let segments_json =
        serde_json::to_string(&parsed.segments).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO lyrics_transcripts (project_id, backend, source_artifact_id, source_kind, requested_device, device, model_name, language, language_override, source_segments_json, segments_json, has_user_edits, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(project_id) DO UPDATE SET backend = excluded.backend, source_artifact_id = excluded.source_artifact_id, source_kind = excluded.source_kind, requested_device = excluded.requested_device, device = excluded.device, model_name = excluded.model_name, language = excluded.language, language_override = excluded.language_override, source_segments_json = excluded.source_segments_json, segments_json = excluded.segments_json, has_user_edits = excluded.has_user_edits, created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                &revision.project_id,
                parsed.backend,
                parsed.source_artifact_id,
                parsed.source_kind,
                parsed.requested_device,
                parsed.device,
                parsed.model_name,
                parsed.language,
                parsed.language_override,
                source_segments_json,
                segments_json,
                if parsed.has_user_edits { 1_i64 } else { 0_i64 },
                parsed.created_at,
                parsed.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_project_metadata_revision_state(
    project: &mut ProjectSchema,
    revision: &SyncProjectManifestEntityRevisionSchema,
) -> Result<(), String> {
    let payload = &revision.payload;
    if payload
        .get("project_id")
        .and_then(Value::as_str)
        .is_some_and(|project_id| project_id != revision.project_id)
    {
        return Err("Project metadata revision belongs to a different project.".to_string());
    }
    let display_name = match payload.get("display_name") {
        Some(Value::String(value)) if !value.trim().is_empty() => value.trim().to_string(),
        Some(_) => {
            return Err(
                "Project metadata revision display_name must be a non-empty string.".to_string(),
            )
        }
        None => project.display_name.clone(),
    };
    let source_key_override = match payload.get("source_key_override") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) => None,
        Some(_) => {
            return Err(
                "Project metadata revision source_key_override must be a string or null."
                    .to_string(),
            )
        }
        None => project.source_key_override.clone(),
    };
    if let Some(value) = payload.get("source_sha256") {
        let source_sha256 = value.as_str().ok_or_else(|| {
            "Project metadata revision source_sha256 must be a string.".to_string()
        })?;
        validate_project_source_identity(&revision.project_id, Some(source_sha256))?;
        if project.source_sha256.as_deref() != Some(source_sha256) {
            return Err("Project metadata revision conflicts with the project source.".to_string());
        }
    }
    let duration_seconds = match payload.get("duration_seconds") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_f64().ok_or_else(|| {
            "Project metadata revision duration_seconds must be a number or null.".to_string()
        })?),
        None => project.duration_seconds,
    };
    let integer_field = |name: &str, current: Option<i64>| -> Result<Option<i64>, String> {
        match payload.get(name) {
            Some(Value::Null) => Ok(None),
            Some(value) => value.as_i64().map(Some).ok_or_else(|| {
                format!("Project metadata revision {name} must be an integer or null.")
            }),
            None => Ok(current),
        }
    };
    project.display_name = display_name;
    project.source_key_override = source_key_override;
    project.duration_seconds = duration_seconds;
    project.sample_rate = integer_field("sample_rate", project.sample_rate)?;
    project.channels = integer_field("channels", project.channels)?;
    project.updated_at = normalize_sync_timestamp_utc(&revision.updated_at, "revision updated_at")?;
    Ok(())
}

fn hydrate_project_metadata_revision(
    connection: &Connection,
    revision: &SyncProjectManifestEntityRevisionSchema,
) -> Result<(), String> {
    let mut project = get_project_schema(connection, &revision.project_id)?;
    apply_project_metadata_revision_state(&mut project, revision)?;
    connection
        .execute(
            "UPDATE projects SET display_name = ?1, source_key_override = ?2, duration_seconds = ?3, sample_rate = ?4, channels = ?5, updated_at = ?6 WHERE id = ?7",
            params![
                project.display_name,
                project.source_key_override,
                project.duration_seconds,
                project.sample_rate,
                project.channels,
                project.updated_at,
                revision.project_id,
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
    let project_metadata_revisions = {
        let mut statement = connection
            .prepare(
                &format!(
                    "SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE project_id = ?1 AND state IN ('active', 'current') AND entity_type = 'project_metadata' ORDER BY created_at ASC, id ASC"
                ),
            )
            .map_err(|error| error.to_string())?;
        let revisions = statement
            .query_map(params![project_id], row_entity_revision)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        revisions
    };
    match project_metadata_revisions.as_slice() {
        [] => {}
        [revision] => hydrate_project_metadata_revision(connection, revision)?,
        _ => {
            return Err(
                "Project manifest contains multiple current project_metadata revisions."
                    .to_string(),
            )
        }
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
    let lyrics_revision_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_entity_revisions WHERE project_id = ?1 AND entity_type IN ('lyrics', 'lyrics_transcript')",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let lyrics_revisions = {
        let mut statement = connection
            .prepare(
                &format!(
                    "SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE project_id = ?1 AND state IN ('active', 'current') AND entity_type IN ('lyrics', 'lyrics_transcript') ORDER BY created_at ASC, id ASC"
                ),
            )
            .map_err(|error| error.to_string())?;
        let revisions = statement
            .query_map(params![project_id], row_entity_revision)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        revisions
    };
    match lyrics_revisions.as_slice() {
        [] if lyrics_revision_count > 0 => {
            connection
                .execute(
                    "DELETE FROM lyrics_transcripts WHERE project_id = ?1",
                    params![project_id],
                )
                .map_err(|error| error.to_string())?;
        }
        [] => {}
        [revision] => hydrate_lyrics_revision(connection, revision)?,
        _ => {
            return Err("Project manifest contains multiple current lyrics revisions.".to_string())
        }
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
    merge: ManifestArtifactMerge,
    copy_source_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ManifestArtifactMerge {
    Insert,
    Update,
    Replace,
    KeepLocal,
}

pub(super) fn manifest_artifact_merge(
    connection: &Connection,
    artifact: &SyncProjectManifestArtifactSchema,
) -> Result<(ManifestArtifactMerge, Option<ArtifactSchema>), String> {
    let existing = connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"),
            params![artifact.artifact_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(existing_artifact) = existing else {
        return Ok((ManifestArtifactMerge::Insert, None));
    };
    if existing_artifact.project_id != artifact.project_id {
        return Err("A synced artifact conflicts with an existing local artifact.".to_string());
    }
    if existing_artifact.content_sha256.as_deref() == Some(&artifact.content_sha256) {
        if existing_artifact.size_bytes != artifact.size_bytes {
            return Err("A synced artifact conflicts with an existing local artifact.".to_string());
        }
        return Ok((ManifestArtifactMerge::Update, Some(existing_artifact)));
    }
    if durable_manifest_audio_format(artifact).is_some() {
        if !existing_artifact
            .r#type
            .trim()
            .eq_ignore_ascii_case(&artifact.r#type)
        {
            return Err("A synced artifact conflicts with an existing local artifact.".to_string());
        }
        let local_updated_at =
            parse_sync_timestamp_utc(&existing_artifact.updated_at, "local artifact updated_at")?;
        let remote_updated_at = parse_sync_timestamp_utc(
            artifact
                .updated_at
                .as_deref()
                .unwrap_or(&artifact.created_at),
            "artifact updated_at",
        )?;
        return if remote_updated_at > local_updated_at {
            Ok((ManifestArtifactMerge::Replace, Some(existing_artifact)))
        } else if remote_updated_at < local_updated_at {
            Ok((ManifestArtifactMerge::KeepLocal, Some(existing_artifact)))
        } else {
            Err("A synced artifact conflicts with an existing local artifact.".to_string())
        };
    }
    if existing_artifact.r#type.trim().to_ascii_lowercase()
        != artifact.r#type.trim().to_ascii_lowercase()
        || existing_artifact
            .r#type
            .trim()
            .eq_ignore_ascii_case("analysis_json")
        || !existing_artifact.can_regenerate
        || !artifact.can_regenerate
    {
        return Err("A synced artifact conflicts with an existing local artifact.".to_string());
    }
    let local_created_at =
        parse_sync_timestamp_utc(&existing_artifact.created_at, "local artifact created_at")?;
    let remote_created_at = parse_sync_timestamp_utc(&artifact.created_at, "artifact created_at")?;
    let merge = if remote_created_at > local_created_at {
        ManifestArtifactMerge::Replace
    } else {
        ManifestArtifactMerge::KeepLocal
    };
    Ok((merge, Some(existing_artifact)))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProjectManifestMismatch {
    ProjectCore,
    ArtifactMissing,
    ArtifactReplacement,
    ArtifactMetadata,
    RevisionMissing,
    RevisionMetadata,
}

pub(super) fn project_manifest_mismatch(
    connection: &Connection,
    root: &Path,
    manifest: &SyncProjectManifestSchema,
) -> Result<Option<ProjectManifestMismatch>, String> {
    let project = get_project_schema(connection, &manifest.project.project_id)?;
    let mut expected = project.clone();
    expected.display_name = manifest.project.display_name.clone();
    expected.source_key_override = manifest.project.source_key_override.clone();
    expected.source_sha256 = Some(manifest.project.source_sha256.clone());
    expected.duration_seconds = manifest.project.duration_seconds;
    expected.sample_rate = manifest.project.sample_rate;
    expected.channels = manifest.project.channels;
    expected.updated_at =
        normalize_sync_timestamp_utc(&manifest.project.updated_at, "manifest project updated_at")?;
    let mut current_metadata = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE project_id = ?1 AND entity_type = 'project_metadata' AND state IN ('active', 'current')"
            ))
            .map_err(|error| error.to_string())?;
        let revisions = statement
            .query_map(params![manifest.project.project_id], row_entity_revision)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        revisions
            .into_iter()
            .map(|revision| (revision.revision_id.clone(), revision))
            .collect::<BTreeMap<_, _>>()
    };
    for revision in manifest
        .entity_revisions
        .iter()
        .filter(|revision| revision.entity_type == "project_metadata")
    {
        if matches!(revision.state.as_str(), "active" | "current") {
            current_metadata.insert(revision.revision_id.clone(), revision.clone());
        } else {
            current_metadata.remove(&revision.revision_id);
        }
    }
    let current_metadata = current_metadata.into_values().collect::<Vec<_>>();
    match current_metadata.as_slice() {
        [] => {}
        [revision] => apply_project_metadata_revision_state(&mut expected, revision)?,
        _ => {
            return Err(
                "Project manifest contains multiple current project_metadata revisions."
                    .to_string(),
            )
        }
    }
    if project.display_name != expected.display_name
        || project.source_key_override != expected.source_key_override
        || project.source_sha256 != expected.source_sha256
        || project.duration_seconds != expected.duration_seconds
        || project.sample_rate != expected.sample_rate
        || project.channels != expected.channels
        || normalize_sync_timestamp_utc(&project.created_at, "project created_at")?
            != manifest.project.created_at
        || normalize_sync_timestamp_utc(&project.updated_at, "project updated_at")?
            != expected.updated_at
    {
        return Ok(Some(ProjectManifestMismatch::ProjectCore));
    }
    for artifact in &manifest.artifacts {
        let (merge, existing) = manifest_artifact_merge(connection, artifact)?;
        match merge {
            ManifestArtifactMerge::Insert => {
                return Ok(Some(ProjectManifestMismatch::ArtifactMissing));
            }
            ManifestArtifactMerge::Replace => {
                return Ok(Some(ProjectManifestMismatch::ArtifactReplacement));
            }
            ManifestArtifactMerge::KeepLocal => continue,
            ManifestArtifactMerge::Update => {}
        }
        let local = super::storage::manifest_artifact_from_artifact(
            root,
            existing.expect("update has artifact"),
        )?;
        let mut expected = artifact.clone();
        expected.metadata = sanitize_sync_manifest_value(&expected.metadata);
        if expected.updated_at.is_none() {
            expected.updated_at = Some(expected.created_at.clone());
        }
        if serde_json::to_value(local).map_err(|error| error.to_string())?
            != serde_json::to_value(expected).map_err(|error| error.to_string())?
        {
            return Ok(Some(ProjectManifestMismatch::ArtifactMetadata));
        }
    }
    for revision in &manifest.entity_revisions {
        let local = connection
            .query_row(
                &format!("SELECT {SYNC_ENTITY_REVISION_COLUMNS} FROM sync_entity_revisions WHERE id = ?1"),
                params![revision.revision_id],
                row_entity_revision,
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(local) = local else {
            return Ok(Some(ProjectManifestMismatch::RevisionMissing));
        };
        if local.content_sha256 != revision.content_sha256 {
            return Err(
                "A synced entity revision conflicts with an existing local revision.".to_string(),
            );
        }
        if serde_json::to_value(local).map_err(|error| error.to_string())?
            != serde_json::to_value(revision).map_err(|error| error.to_string())?
        {
            return Ok(Some(ProjectManifestMismatch::RevisionMetadata));
        }
    }
    Ok(None)
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

pub(super) fn reusable_local_artifact_path(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    content_sha256: &str,
    size_bytes: i64,
) -> Option<PathBuf> {
    let project_root = project_root_path(root, project_id).ok()?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 AND content_sha256 = ?2 AND size_bytes = ?3"
        ))
        .ok()?;
    let artifacts = statement
        .query_map(
            params![project_id, content_sha256, size_bytes],
            row_artifact,
        )
        .ok()?;
    for artifact in artifacts.flatten() {
        let path = PathBuf::from(artifact.path);
        let owned = match capture_owned_project_file(root, &project_root, &path) {
            Ok(owned) => owned,
            Err(_) => continue,
        };
        if require_owned_project_file(&owned).is_ok()
            && artifact_file_matches(&path, content_sha256, size_bytes)
        {
            return Some(path);
        }
    }
    None
}

fn rollback_manifest_files(
    copied: &[OwnedProjectFile],
    installed: &[OwnedProjectFile],
    backups: &mut Vec<(OwnedProjectFile, PathBuf)>,
) {
    cleanup_owned_project_files(copied);
    cleanup_owned_project_files(installed);
    for (backup, destination) in backups.drain(..).rev() {
        let _ = move_owned_project_file(&backup, &destination);
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
    let manifest_project_created_at = normalize_sync_timestamp_utc(
        &payload.manifest.project.created_at,
        "manifest project created_at",
    )?;
    let manifest_project_updated_at = normalize_sync_timestamp_utc(
        &payload.manifest.project.updated_at,
        "manifest project updated_at",
    )?;

    let mut prepared_artifacts = Vec::new();
    for artifact in &payload.manifest.artifacts {
        let destination_path = project_root.join(safe_relative_path(&artifact.relative_path)?);
        let (merge, existing_artifact) = manifest_artifact_merge(connection, artifact)?;
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
        let copy_source_path =
            if merge == ManifestArtifactMerge::KeepLocal || has_verified_destination {
                None
            } else if has_verified_existing {
                existing_artifact
                    .as_ref()
                    .map(|existing| PathBuf::from(&existing.path))
            } else if let Some(path) = reusable_local_artifact_path(
                connection,
                root,
                &artifact.project_id,
                &artifact.content_sha256,
                artifact.size_bytes,
            ) {
                Some(path)
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
            merge,
            copy_source_path,
        });
    }
    let source_path = prepared_artifacts
        .iter()
        .find(|prepared| prepared.manifest.artifact_id == source_artifact.artifact_id)
        .and_then(|prepared| {
            (prepared.merge == ManifestArtifactMerge::KeepLocal)
                .then(|| {
                    prepared
                        .existing
                        .as_ref()
                        .map(|artifact| PathBuf::from(&artifact.path))
                })
                .flatten()
                .or_else(|| Some(prepared.destination_path.clone()))
        })
        .ok_or_else(|| "Project manifest source artifact was not prepared.".to_string())?;

    let storage_guard = project_storage_mutation_guard();
    let mut copied_files = Vec::new();
    let mut installed_files = Vec::new();
    let mut backups = Vec::new();
    let copy_result = (|| -> Result<(), String> {
        for prepared in &prepared_artifacts {
            prepare_owned_project_file(root, &project_root, &prepared.destination_path)?;
            let Some(source_path) = &prepared.copy_source_path else {
                continue;
            };
            if prepared.merge != ManifestArtifactMerge::Replace {
                if prepared.destination_path.exists() {
                    return Err("A synced artifact destination already exists.".to_string());
                }
                fs::copy(source_path, &prepared.destination_path)
                    .map_err(|error| error.to_string())?;
                let copied =
                    capture_owned_project_file(root, &project_root, &prepared.destination_path)?;
                copied_files.push(copied);
                if !artifact_file_matches(
                    &prepared.destination_path,
                    &prepared.manifest.content_sha256,
                    prepared.manifest.size_bytes,
                ) {
                    return Err("A copied artifact file does not match its manifest.".to_string());
                }
                if let Some(format) = durable_manifest_audio_format(&prepared.manifest) {
                    probe_mobile_durable_audio(&prepared.destination_path, format).map_err(
                        |message| {
                            format!(
                                "Synced durable audio failed bounded {format} validation: {message}"
                            )
                        },
                    )?;
                }
                require_owned_project_file(copied_files.last().expect("copied file was recorded"))?;
                continue;
            }
            let mut candidate_path = project_root.join(format!(
                ".sync-incoming-{}-{}",
                prepared.manifest.artifact_id,
                new_id("artifact")
            ));
            if let Some(extension) = prepared.destination_path.extension() {
                candidate_path.set_extension(extension);
            }
            prepare_owned_project_file(root, &project_root, &candidate_path)?;
            if let Err(error) = fs::copy(source_path, &candidate_path) {
                let _ = fs::remove_file(&candidate_path);
                return Err(error.to_string());
            }
            let copied = capture_owned_project_file(root, &project_root, &candidate_path)?;
            if !artifact_file_matches(
                &candidate_path,
                &prepared.manifest.content_sha256,
                prepared.manifest.size_bytes,
            ) {
                cleanup_owned_project_files(std::slice::from_ref(&copied));
                return Err("A copied artifact file does not match its manifest.".to_string());
            }
            if let Some(format) = durable_manifest_audio_format(&prepared.manifest) {
                probe_mobile_durable_audio(&candidate_path, format).map_err(|message| {
                    cleanup_owned_project_files(std::slice::from_ref(&copied));
                    format!("Synced durable audio failed bounded {format} validation: {message}")
                })?;
            }
            require_owned_project_file(&copied)?;
            if prepared.destination_path.is_file() {
                let existing_destination =
                    capture_owned_project_file(root, &project_root, &prepared.destination_path)?;
                let backup_path = project_root.join(format!(
                    ".sync-backup-{}-{}",
                    prepared.manifest.artifact_id,
                    new_id("artifact")
                ));
                let backup = move_owned_project_file(&existing_destination, &backup_path)?;
                backups.push((backup, prepared.destination_path.clone()));
            }
            match move_owned_project_file(&copied, &prepared.destination_path) {
                Ok(installed) => installed_files.push(installed),
                Err(message) => {
                    cleanup_owned_project_files(std::slice::from_ref(&copied));
                    return Err(message);
                }
            }
        }
        Ok(())
    })();
    if let Err(message) = copy_result {
        rollback_manifest_files(&copied_files, &installed_files, &mut backups);
        return Err(message);
    }

    if let Err(error) = connection.execute_batch("BEGIN IMMEDIATE") {
        rollback_manifest_files(&copied_files, &installed_files, &mut backups);
        return Err(error.to_string());
    }
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
                            &manifest_project_created_at,
                            &manifest_project_updated_at,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
        } else {
            connection
                    .execute(
                        "UPDATE projects SET display_name = ?1, source_key_override = ?2, source_sha256 = ?3, imported_path = ?4, duration_seconds = ?5, sample_rate = ?6, channels = ?7, updated_at = ?8 WHERE id = ?9",
                        params![
                            &payload.manifest.project.display_name,
                            payload.manifest.project.source_key_override.as_ref(),
                            &source_sha256,
                            &source_path_string,
                            payload.manifest.project.duration_seconds,
                            payload.manifest.project.sample_rate,
                            payload.manifest.project.channels,
                            &manifest_project_updated_at,
                            &project_id,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
        }

        for tombstone in &payload.manifest.delete_tombstones {
            apply_delete_tombstone(connection, tombstone)?;
        }
        for prepared in &prepared_artifacts {
            if prepared.merge == ManifestArtifactMerge::KeepLocal {
                continue;
            }
            let artifact = &prepared.manifest;
            let destination_path = prepared.destination_path.to_string_lossy().into_owned();
            let metadata = sanitize_sync_manifest_value(&artifact.metadata).to_string();
            let artifact_created_at =
                normalize_sync_timestamp_utc(&artifact.created_at, "artifact created_at")?;
            let remote_artifact_updated_at = normalize_sync_timestamp_utc(
                artifact
                    .updated_at
                    .as_deref()
                    .unwrap_or(&artifact.created_at),
                "artifact updated_at",
            )?;
            let artifact_updated_at = if prepared.merge == ManifestArtifactMerge::Update {
                prepared
                    .existing
                    .as_ref()
                    .map(|existing| existing.updated_at.clone())
                    .filter(|local| {
                        parse_sync_timestamp_utc(local, "local artifact updated_at").is_ok_and(
                            |value| {
                                value
                                    > parse_sync_timestamp_utc(
                                        &remote_artifact_updated_at,
                                        "artifact updated_at",
                                    )
                                    .expect("normalized artifact timestamp")
                            },
                        )
                    })
                    .unwrap_or(remote_artifact_updated_at)
            } else {
                remote_artifact_updated_at
            };
            if prepared.existing.is_some() {
                connection
                        .execute(
                            "UPDATE artifacts SET project_id = ?1, type = ?2, format = ?3, path = ?4, content_sha256 = ?5, size_bytes = ?6, generated_by = ?7, can_delete = ?8, can_regenerate = ?9, metadata_json = ?10, cache_key = ?11, created_at = ?12, updated_at = ?13 WHERE id = ?14",
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
                                &artifact_created_at,
                                &artifact_updated_at,
                                &artifact.artifact_id,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
            } else {
                connection
                        .execute(
                            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                                &artifact_created_at,
                                &artifact_updated_at,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
            }
        }

        import_entity_revisions(connection, &payload.manifest.entity_revisions)?;
        connection
                .execute(
                    "UPDATE projects SET sync_status = 'local', sync_status_reason = ?1, sync_required_artifact_ids_json = ?2, sync_provider_device_ids_json = ?2, sync_conflict_count = 0, sync_status_updated_at = ?3 WHERE id = ?4",
                    params!["Synced from desktop.", DEFAULT_SYNC_LIST_JSON, &timestamp, &project_id],
                )
                .map_err(|error| error.to_string())?;
        hydrate_imported_read_models(connection, &project_id)?;
        Ok(())
    })();

    if let Err(message) = db_result {
        let _ = connection.execute_batch("ROLLBACK");
        rollback_manifest_files(&copied_files, &installed_files, &mut backups);
        return Err(message);
    }
    if let Err(error) = connection.execute_batch("COMMIT") {
        let _ = connection.execute_batch("ROLLBACK");
        rollback_manifest_files(&copied_files, &installed_files, &mut backups);
        return Err(error.to_string());
    }
    for (backup, _) in &backups {
        cleanup_owned_project_files(std::slice::from_ref(backup));
    }
    drop(storage_guard);
    reconcile_project_storage_after_commit(connection, root, &project_id);
    reconcile_staged_artifacts_after_commit(connection, root);
    get_project_schema(connection, &project_id)
}

pub(super) fn get_sync_metadata(
    connection: &Connection,
    root: &Path,
) -> Result<SyncMetadataResponse, String> {
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
            created_at: normalize_sync_timestamp_utc(&project.created_at, "project created_at")?,
            updated_at: normalize_sync_timestamp_utc(&project.updated_at, "project updated_at")?,
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
        if !super::storage::is_syncable_artifact_type(&artifact.r#type) {
            continue;
        }
        let relative_path = relative_artifact_path(root, &artifact);
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
            created_at: normalize_sync_timestamp_utc(&artifact.created_at, "artifact created_at")?,
            updated_at: Some(normalize_sync_timestamp_utc(
                &artifact.updated_at,
                "artifact updated_at",
            )?),
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
        let mut tombstone = row.map_err(|error| error.to_string())?;
        tombstone.deleted_at =
            normalize_sync_timestamp_utc(&tombstone.deleted_at, "tombstone deleted_at")?;
        tombstone.created_at =
            normalize_sync_timestamp_utc(&tombstone.created_at, "tombstone created_at")?;
        tombstone.updated_at =
            normalize_sync_timestamp_utc(&tombstone.updated_at, "tombstone updated_at")?;
        if super::storage::is_syncable_delete_tombstone(&tombstone)
            && !local_tombstone_superseded_by_live_target(connection, &tombstone)?
        {
            delete_tombstones.push(tombstone);
        }
    }
    Ok(SyncMetadataResponse {
        projects,
        artifacts,
        delete_tombstones,
    })
}

pub fn mobile_get_sync_metadata(app: AppHandle) -> Result<SyncMetadataResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    get_sync_metadata(&connection, &root)
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
    let root = app_data_root(&app)?;
    let project = update_project_sync_status(&connection, &project_id, payload)?;
    reconcile_project_storage_after_commit(&connection, &root, &project_id);
    Ok(SyncProjectStatusUpdateResponse { project })
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use serde_json::json;

    fn insert_trusted_peer(connection: &Connection, device_id: &str) -> String {
        migrate_mobile_db(connection).unwrap();
        ensure_local_identity(connection).unwrap();
        let identity = local_identity(connection).unwrap();
        connection
            .execute(
                "INSERT INTO sync_trusted_peers (device_id, sync_group_id, display_name, public_key, trusted_at, created_at, updated_at)
                 VALUES (?1, ?2, 'Peer', ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                params![device_id, identity.sync_group_id, format!("pubkey_{device_id}")],
            )
            .unwrap();
        identity.sync_group_id
    }

    fn tombstone_for(
        sync_group_id: &str,
        tombstone_id: &str,
        project_id: &str,
        target_type: &str,
        target_id: &str,
        deleted_at: &str,
    ) -> SyncDeleteTombstoneSchema {
        SyncDeleteTombstoneSchema {
            tombstone_id: tombstone_id.to_string(),
            sync_group_id: sync_group_id.to_string(),
            project_id: project_id.to_string(),
            target_type: target_type.to_string(),
            target_id: target_id.to_string(),
            author_device_id: "device_peer_1".to_string(),
            deleted_at: deleted_at.to_string(),
            prior_metadata: json!({}),
            created_at: deleted_at.to_string(),
            updated_at: deleted_at.to_string(),
        }
    }

    fn insert_live_sync_targets(connection: &Connection, project_id: &str, live_at: &str) {
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at)
                 VALUES (?1, 'Live', '', '', 'local', ?2, ?2)",
                params![project_id, live_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at)
                 VALUES ('art_live', ?1, 'preview_mix', 'wav', '/tmp/live.wav', 0, 'sync', 1, 1, '{}', ?2)",
                params![project_id, live_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sync_entity_revisions (id, project_id, entity_type, entity_id, revision_type, author_device_id, content_sha256, state, metadata_json, payload_json, created_at, updated_at)
                 VALUES ('rev_live', ?1, 'lyrics', 'lyrics', 'snapshot', 'device_local', ?2, 'active', '{}', '{}', ?3, ?3)",
                params![project_id, "a".repeat(64), live_at],
            )
            .unwrap();
    }

    fn metadata_revision(
        project_id: &str,
        revision_id: &str,
        state: &str,
        display_name: &str,
        updated_at: &str,
    ) -> SyncProjectManifestEntityRevisionSchema {
        SyncProjectManifestEntityRevisionSchema {
            revision_id: revision_id.to_string(),
            project_id: project_id.to_string(),
            entity_type: "project_metadata".to_string(),
            entity_id: project_id.to_string(),
            revision_type: "metadata_change".to_string(),
            base_revision_id: None,
            author_device_id: "device_peer_1".to_string(),
            source_artifact_id: None,
            content_sha256: revision_id
                .bytes()
                .fold(0_u8, u8::wrapping_add)
                .to_string()
                .repeat(64)
                .chars()
                .take(64)
                .collect(),
            state: state.to_string(),
            metadata: json!({}),
            payload: json!({
                "project_id": project_id,
                "display_name": display_name,
                "source_sha256": project_id.trim_start_matches(PROJECT_ID_PREFIX),
                "duration_seconds": 2.0,
                "sample_rate": 16_000,
                "channels": 2,
            }),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    fn metadata_manifest(
        project_id: &str,
        revisions: Vec<SyncProjectManifestEntityRevisionSchema>,
    ) -> SyncProjectManifestSchema {
        SyncProjectManifestSchema {
            schema_version: SYNC_PROJECT_MANIFEST_SCHEMA_VERSION.to_string(),
            exported_at: "2026-01-02T00:00:00Z".to_string(),
            project: SyncProjectManifestProjectSchema {
                project_id: project_id.to_string(),
                display_name: "Manifest name".to_string(),
                source_key_override: None,
                source_sha256: project_id.trim_start_matches(PROJECT_ID_PREFIX).to_string(),
                duration_seconds: Some(1.0),
                sample_rate: Some(8_000),
                channels: Some(1),
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-02T00:00:00Z".to_string(),
            },
            entity_revisions: revisions,
            artifacts: Vec::new(),
            delete_tombstones: Vec::new(),
        }
    }

    fn insert_manifest_project(connection: &Connection, manifest: &SyncProjectManifestSchema) {
        migrate_mobile_db(connection).unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '', '', ?5, ?6, ?7, 'local', ?8, ?9)",
                params![
                    manifest.project.project_id,
                    manifest.project.display_name,
                    manifest.project.source_key_override,
                    manifest.project.source_sha256,
                    manifest.project.duration_seconds,
                    manifest.project.sample_rate,
                    manifest.project.channels,
                    manifest.project.created_at,
                    manifest.project.updated_at,
                ],
            )
            .unwrap();
    }

    #[test]
    fn retained_local_current_metadata_keeps_replay_satisfied() {
        let connection = Connection::open_in_memory().unwrap();
        let project_id = source_hash_to_project_id(&"d".repeat(64)).unwrap();
        let manifest = metadata_manifest(&project_id, Vec::new());
        insert_manifest_project(&connection, &manifest);
        let local = metadata_revision(
            &project_id,
            "rev_metadata_local",
            "active",
            "Retained local name",
            "2026-01-03T00:00:00Z",
        );
        import_entity_revisions(&connection, &[local]).unwrap();
        hydrate_imported_read_models(&connection, &project_id).unwrap();

        assert!(
            project_manifest_mismatch(&connection, Path::new(""), &manifest)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn incoming_and_retained_local_currents_return_hydration_error() {
        let connection = Connection::open_in_memory().unwrap();
        let project_id = source_hash_to_project_id(&"e".repeat(64)).unwrap();
        let local = metadata_revision(
            &project_id,
            "rev_metadata_local",
            "active",
            "Local current",
            "2026-01-03T00:00:00Z",
        );
        let incoming = metadata_revision(
            &project_id,
            "rev_metadata_incoming",
            "current",
            "Incoming current",
            "2026-01-04T00:00:00Z",
        );
        let manifest = metadata_manifest(&project_id, vec![incoming]);
        insert_manifest_project(&connection, &manifest);
        import_entity_revisions(&connection, &[local]).unwrap();

        assert_eq!(
            project_manifest_mismatch(&connection, Path::new(""), &manifest).unwrap_err(),
            "Project manifest contains multiple current project_metadata revisions."
        );
    }

    #[test]
    fn multiple_incoming_currents_return_hydration_error() {
        let connection = Connection::open_in_memory().unwrap();
        let project_id = source_hash_to_project_id(&"f".repeat(64)).unwrap();
        let revisions = vec![
            metadata_revision(
                &project_id,
                "rev_metadata_one",
                "active",
                "First current",
                "2026-01-03T00:00:00Z",
            ),
            metadata_revision(
                &project_id,
                "rev_metadata_two",
                "current",
                "Second current",
                "2026-01-04T00:00:00Z",
            ),
        ];
        let manifest = metadata_manifest(&project_id, revisions);
        insert_manifest_project(&connection, &manifest);

        assert_eq!(
            project_manifest_mismatch(&connection, Path::new(""), &manifest).unwrap_err(),
            "Project manifest contains multiple current project_metadata revisions."
        );
    }

    #[test]
    fn stale_tombstone_apply_without_existing_tombstone_preserves_live_targets() {
        let connection = Connection::open_in_memory().unwrap();
        let sync_group_id = insert_trusted_peer(&connection, "device_peer_1");
        let project_id = source_hash_to_project_id(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
        let live_at = "2026-01-03T00:00:00Z";
        let incoming_stale = "2026-01-01T00:00:00Z";

        insert_live_sync_targets(&connection, &project_id, live_at);

        for (target_type, target_id, incoming_deleted_at) in [
            ("project", project_id.as_str(), incoming_stale),
            ("artifact", "art_live", live_at),
            ("entity_revision", "rev_live", incoming_stale),
        ] {
            let incoming = tombstone_for(
                &sync_group_id,
                &format!("tomb_incoming_no_existing_{target_type}"),
                &project_id,
                target_type,
                target_id,
                incoming_deleted_at,
            );
            apply_delete_tombstone(&connection, &incoming).unwrap();
        }

        let project_status: String = connection
            .query_row(
                "SELECT sync_status FROM projects WHERE id = ?1",
                params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        let artifact_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE id = 'art_live' AND project_id = ?1",
                params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        let revision_state: String = connection
            .query_row(
                "SELECT state FROM sync_entity_revisions WHERE id = 'rev_live' AND project_id = ?1",
                params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        let tombstone_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_delete_tombstones", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(project_status, "local");
        assert_eq!(artifact_count, 1);
        assert_eq!(revision_state, "active");
        assert_eq!(tombstone_count, 0);
    }

    #[test]
    fn stale_tombstone_apply_preserves_newer_live_targets() {
        let connection = Connection::open_in_memory().unwrap();
        let sync_group_id = insert_trusted_peer(&connection, "device_peer_1");
        let project_id = source_hash_to_project_id(
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        )
        .unwrap();
        let live_at = "2026-01-03T00:00:00Z";
        let existing_newer = "2026-01-02T00:00:00Z";
        let incoming_stale = "2026-01-01T00:00:00Z";

        insert_live_sync_targets(&connection, &project_id, live_at);

        for (target_type, target_id, existing_deleted_at, incoming_deleted_at) in [
            (
                "project",
                project_id.as_str(),
                existing_newer,
                incoming_stale,
            ),
            ("artifact", "art_live", existing_newer, incoming_stale),
            (
                "entity_revision",
                "rev_live",
                incoming_stale,
                incoming_stale,
            ),
        ] {
            let existing = tombstone_for(
                &sync_group_id,
                &format!("tomb_existing_{target_type}"),
                &project_id,
                target_type,
                target_id,
                existing_deleted_at,
            );
            assert!(upsert_delete_tombstone(&connection, &existing).unwrap());

            let incoming = tombstone_for(
                &sync_group_id,
                &format!("tomb_incoming_{target_type}"),
                &project_id,
                target_type,
                target_id,
                incoming_deleted_at,
            );
            apply_delete_tombstone(&connection, &incoming).unwrap();
        }

        let project_status: String = connection
            .query_row(
                "SELECT sync_status FROM projects WHERE id = ?1",
                params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        let artifact_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE id = 'art_live' AND project_id = ?1",
                params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        let revision_state: String = connection
            .query_row(
                "SELECT state FROM sync_entity_revisions WHERE id = 'rev_live' AND project_id = ?1",
                params![&project_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(project_status, "local");
        assert_eq!(artifact_count, 1);
        assert_eq!(revision_state, "active");
    }
}
