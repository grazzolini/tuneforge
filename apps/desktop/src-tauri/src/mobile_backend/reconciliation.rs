use super::*;

fn reconciliation_action(
    action_type: &str,
    item_type: &str,
    item_id: &str,
    project_id: Option<String>,
    content_sha256: Option<String>,
    provider_device_id: Option<String>,
    reason: &str,
    details: Value,
) -> SyncReconciliationActionSchema {
    SyncReconciliationActionSchema {
        action_type: action_type.to_string(),
        item_type: item_type.to_string(),
        item_id: item_id.to_string(),
        project_id,
        content_sha256,
        provider_device_id,
        reason: Some(reason.to_string()),
        priority: action_priority(action_type),
        details,
    }
}

fn reconciliation_item(
    item_type: &str,
    item_id: &str,
    project_id: Option<String>,
    status: &str,
    action_type: Option<&str>,
    content_sha256: Option<String>,
    provider_device_id: Option<String>,
    reason: &str,
    details: Value,
) -> SyncReconciliationItemSchema {
    SyncReconciliationItemSchema {
        item_type: item_type.to_string(),
        item_id: item_id.to_string(),
        project_id,
        status: status.to_string(),
        action_type: action_type.map(ToString::to_string),
        content_sha256,
        chosen_provider_device_id: provider_device_id,
        reason: Some(reason.to_string()),
        details,
    }
}

fn providers_by_hash(
    connection: &Connection,
    peer_inventory: &[SyncPeerInventoryEntrySchema],
) -> Result<HashMap<String, String>, String> {
    let trusted = active_trusted_device_ids(connection)?;
    let mut providers = HashMap::new();
    for inventory in peer_inventory {
        if !trusted.contains(&inventory.device_id) {
            continue;
        }
        for content_sha256 in &inventory.available_content_sha256 {
            if let Ok(normalized) = normalize_sha256(content_sha256, "content_sha256") {
                providers
                    .entry(normalized)
                    .or_insert_with(|| inventory.device_id.clone());
            }
        }
    }
    Ok(providers)
}

fn local_content_available(
    connection: &Connection,
    root: &Path,
    content_sha256: &str,
    size_bytes: i64,
) -> bool {
    if get_staged_artifact(connection, root, content_sha256, Some(size_bytes)).is_ok() {
        return true;
    }
    let mut statement = match connection.prepare(&format!(
        "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE content_sha256 = ?1"
    )) {
        Ok(statement) => statement,
        Err(_) => return false,
    };
    let rows = match statement.query_map(params![content_sha256], row_artifact) {
        Ok(rows) => rows,
        Err(_) => return false,
    };
    for row in rows.flatten() {
        if row.size_bytes != size_bytes {
            continue;
        }
        if Path::new(&row.path).is_file()
            && file_sha256(Path::new(&row.path)).ok().as_deref() == Some(content_sha256)
        {
            return true;
        }
    }
    false
}

fn manifest_by_project_id(
    manifests: &[SyncProjectManifestSchema],
) -> HashMap<String, SyncProjectManifestSchema> {
    manifests
        .iter()
        .cloned()
        .map(|manifest| (manifest.project.project_id.clone(), manifest))
        .collect()
}

fn tombstones_for_request(
    remote_library: &SyncReconciliationRemoteLibrarySchema,
    manifests: &[SyncProjectManifestSchema],
) -> Vec<SyncDeleteTombstoneSchema> {
    let mut tombstones = remote_library.delete_tombstones.clone();
    for manifest in manifests {
        if validate_manifest_delete_tombstone_targets(manifest).is_ok() {
            tombstones.extend(manifest.delete_tombstones.clone());
        }
    }
    tombstones
}

fn remote_projects_with_manifest_metadata(
    remote_library: &SyncReconciliationRemoteLibrarySchema,
    manifests: &[SyncProjectManifestSchema],
) -> Vec<SyncMetadataProjectSchema> {
    let mut projects = remote_library.projects.clone();
    let existing_ids = projects
        .iter()
        .map(|project| project.project_id.clone())
        .collect::<HashSet<_>>();
    for manifest in manifests {
        if existing_ids.contains(&manifest.project.project_id) {
            continue;
        }
        projects.push(SyncMetadataProjectSchema {
            project_id: manifest.project.project_id.clone(),
            display_name: manifest.project.display_name.clone(),
            source_key_override: manifest.project.source_key_override.clone(),
            source_sha256: Some(manifest.project.source_sha256.clone()),
            duration_seconds: manifest.project.duration_seconds,
            sample_rate: manifest.project.sample_rate,
            channels: manifest.project.channels,
            created_at: manifest.project.created_at.clone(),
            updated_at: manifest.project.updated_at.clone(),
        });
    }
    projects
}

fn add_conflict(
    items: &mut Vec<SyncReconciliationItemSchema>,
    actions: &mut Vec<SyncReconciliationActionSchema>,
    item_type: &str,
    item_id: &str,
    project_id: Option<String>,
    content_sha256: Option<String>,
    reason: &str,
    details: Value,
) {
    items.push(reconciliation_item(
        item_type,
        item_id,
        project_id.clone(),
        "conflicted",
        Some(ACTION_RECORD_CONFLICT),
        content_sha256.clone(),
        None,
        reason,
        details.clone(),
    ));
    actions.push(reconciliation_action(
        ACTION_RECORD_CONFLICT,
        item_type,
        item_id,
        project_id,
        content_sha256,
        None,
        reason,
        details,
    ));
}

fn summarize_plan(
    items: Vec<SyncReconciliationItemSchema>,
    mut actions: Vec<SyncReconciliationActionSchema>,
) -> SyncReconciliationPlanResponse {
    actions.sort_by(|left, right| {
        (
            left.priority,
            &left.action_type,
            &left.item_type,
            &left.item_id,
        )
            .cmp(&(
                right.priority,
                &right.action_type,
                &right.item_type,
                &right.item_id,
            ))
    });
    let mut status_counts = BTreeMap::new();
    for item in &items {
        *status_counts.entry(item.status.clone()).or_insert(0) += 1;
    }
    SyncReconciliationPlanResponse {
        summary: SyncReconciliationSummarySchema {
            total_items: items.len(),
            total_actions: actions.len(),
            total_conflicts: *status_counts.get("conflicted").unwrap_or(&0),
            status_counts,
        },
        items,
        actions,
    }
}

fn plan_sync_reconciliation_parts(
    connection: &Connection,
    root: &Path,
    remote_library: &SyncReconciliationRemoteLibrarySchema,
    manifests: &[SyncProjectManifestSchema],
    peer_inventory: &[SyncPeerInventoryEntrySchema],
) -> Result<SyncReconciliationPlanResponse, String> {
    let providers = providers_by_hash(connection, peer_inventory)?;
    let manifests_by_project = manifest_by_project_id(manifests);
    let mut items = Vec::new();
    let mut actions = Vec::new();
    let mut effective_tombstone_targets = HashSet::new();

    for tombstone in tombstones_for_request(remote_library, manifests) {
        if let Err(message) = validate_remote_delete_tombstone(connection, &tombstone) {
            items.push(reconciliation_item(
                &normalize_tombstone_target_type(&tombstone.target_type),
                &tombstone.target_id,
                Some(tombstone.project_id.clone()),
                "rejected",
                None,
                None,
                None,
                &message,
                json!({"tombstone_id": tombstone.tombstone_id}),
            ));
            continue;
        }
        let (item, planned_actions, tombstone_is_effective) = plan_delete_tombstone_branch(
            &tombstone,
            local_tombstone_superseded_by_live_target(connection, &tombstone)?,
        );
        if tombstone_is_effective {
            add_effective_tombstone_target(&mut effective_tombstone_targets, &tombstone);
        }
        items.push(item);
        actions.extend(planned_actions);
    }

    for project in remote_projects_with_manifest_metadata(remote_library, manifests) {
        if sync_target_is_tombstoned(
            &effective_tombstone_targets,
            "project",
            &project.project_id,
            &project.project_id,
        ) {
            continue;
        }
        let local_project = get_project_schema(connection, &project.project_id).ok();
        if let Some(local_project) = &local_project {
            if project.source_sha256.is_some()
                && local_project.source_sha256.is_some()
                && project.source_sha256 != local_project.source_sha256
            {
                add_conflict(
                    &mut items,
                    &mut actions,
                    "project",
                    &project.project_id,
                    Some(project.project_id.clone()),
                    project.source_sha256.clone(),
                    "Remote project has the same ID with a different source SHA-256.",
                    json!({
                        "local_source_sha256": local_project.source_sha256,
                        "remote_source_sha256": project.source_sha256,
                    }),
                );
                continue;
            }
            if local_project.sync_status == DEFAULT_SYNC_STATUS {
                items.push(reconciliation_item(
                    "project",
                    &project.project_id,
                    Some(project.project_id.clone()),
                    "noop",
                    Some(ACTION_NOOP),
                    project.source_sha256.clone(),
                    None,
                    "Project already exists locally.",
                    json!({}),
                ));
                continue;
            }
        }

        let Some(manifest) = manifests_by_project.get(&project.project_id) else {
            let reason = "Project manifest is required before import.";
            items.push(reconciliation_item(
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                "missing_provider",
                Some(ACTION_UPSERT_PROJECT_STATUS),
                project.source_sha256.clone(),
                None,
                reason,
                json!({}),
            ));
            actions.push(reconciliation_action(
                ACTION_UPSERT_PROJECT_STATUS,
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                project.source_sha256.clone(),
                None,
                reason,
                json!({"project_status": "missing", "remote_metadata": project}),
            ));
            continue;
        };
        if let Err(message) = validate_project_manifest_identity(manifest) {
            add_conflict(
                &mut items,
                &mut actions,
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                project.source_sha256.clone(),
                &message,
                json!({}),
            );
            continue;
        }
        if let Err(message) = validate_manifest_delete_tombstones(connection, manifest) {
            add_conflict(
                &mut items,
                &mut actions,
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                project.source_sha256.clone(),
                &message,
                json!({}),
            );
            continue;
        }
        let (tombstoned_artifacts, tombstoned_revisions) =
            manifest_live_targets_covered_by_tombstones(manifest, &effective_tombstone_targets);
        if !tombstoned_artifacts.is_empty() || !tombstoned_revisions.is_empty() {
            add_conflict(
                &mut items,
                &mut actions,
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                project.source_sha256.clone(),
                "Project manifest contains live targets covered by sync delete tombstones.",
                json!({
                    "artifact_ids": tombstoned_artifacts,
                    "revision_ids": tombstoned_revisions,
                }),
            );
            continue;
        }

        let mut artifact_providers = BTreeMap::new();
        let mut missing_provider_artifacts = Vec::new();
        for artifact in &manifest.artifacts {
            if local_content_available(
                connection,
                root,
                &artifact.content_sha256,
                artifact.size_bytes,
            ) {
                continue;
            }
            if let Some(provider) = providers.get(&artifact.content_sha256) {
                artifact_providers.insert(artifact.artifact_id.clone(), provider.clone());
            } else {
                missing_provider_artifacts.push(artifact.artifact_id.clone());
            }
        }

        if !missing_provider_artifacts.is_empty() {
            let reason = "No local bytes or trusted provider are available for every project manifest artifact.";
            items.push(reconciliation_item(
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                "missing_provider",
                Some(ACTION_UPSERT_PROJECT_STATUS),
                project.source_sha256.clone(),
                None,
                reason,
                json!({"artifact_ids": missing_provider_artifacts}),
            ));
            actions.push(reconciliation_action(
                ACTION_UPSERT_PROJECT_STATUS,
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                project.source_sha256.clone(),
                None,
                reason,
                json!({"project_status": "missing", "remote_metadata": project}),
            ));
            continue;
        }

        if artifact_providers.is_empty() {
            let reason = "All project manifest artifact bytes are already verified locally.";
            items.push(reconciliation_item(
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                "identical_content",
                Some(ACTION_IMPORT_PROJECT_MANIFEST),
                project.source_sha256.clone(),
                None,
                reason,
                json!({"manifest_artifact_count": manifest.artifacts.len()}),
            ));
            actions.push(reconciliation_action(
                ACTION_IMPORT_PROJECT_MANIFEST,
                "project",
                &project.project_id,
                Some(project.project_id.clone()),
                project.source_sha256.clone(),
                None,
                "Import project manifest using locally verified artifact content.",
                json!({}),
            ));
            continue;
        }

        let provider_device_id = artifact_providers.values().next().cloned();
        let reason = "Every project manifest artifact is local or advertised by a trusted peer.";
        items.push(reconciliation_item(
            "project",
            &project.project_id,
            Some(project.project_id.clone()),
            "remote_available",
            Some(ACTION_IMPORT_PROJECT_MANIFEST),
            project.source_sha256.clone(),
            provider_device_id.clone(),
            reason,
            json!({"artifact_providers": artifact_providers}),
        ));
        actions.push(reconciliation_action(
            ACTION_UPSERT_PROJECT_STATUS,
            "project",
            &project.project_id,
            Some(project.project_id.clone()),
            project.source_sha256.clone(),
            provider_device_id.clone(),
            reason,
            json!({
                "project_status": "remote_available",
                "remote_metadata": project,
                "provider_device_ids": provider_device_id.iter().cloned().collect::<Vec<_>>(),
                "required_artifact_ids": manifest.artifacts.iter().map(|artifact| artifact.artifact_id.clone()).collect::<Vec<_>>(),
            }),
        ));
        for artifact in &manifest.artifacts {
            if local_content_available(
                connection,
                root,
                &artifact.content_sha256,
                artifact.size_bytes,
            ) {
                continue;
            }
            if let Some(provider) = providers.get(&artifact.content_sha256) {
                actions.push(reconciliation_action(
                    ACTION_FETCH_ARTIFACT_CONTENT,
                    "artifact",
                    &artifact.artifact_id,
                    Some(project.project_id.clone()),
                    Some(artifact.content_sha256.clone()),
                    Some(provider.clone()),
                    "Fetch project manifest artifact bytes before importing the project.",
                    json!({}),
                ));
            }
        }
        actions.push(reconciliation_action(
            ACTION_IMPORT_PROJECT_MANIFEST,
            "project",
            &project.project_id,
            Some(project.project_id.clone()),
            project.source_sha256.clone(),
            provider_device_id,
            "Import project manifest after every required artifact is available.",
            json!({}),
        ));
    }

    for revision in &remote_library.entity_revisions {
        if sync_target_is_tombstoned(
            &effective_tombstone_targets,
            "entity_revision",
            &revision.revision_id,
            &revision.project_id,
        ) {
            continue;
        }
        let existing_hash: Option<String> = connection
            .query_row(
                "SELECT content_sha256 FROM sync_entity_revisions WHERE id = ?1",
                params![revision.revision_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(existing_hash) = existing_hash {
            if existing_hash == revision.content_sha256 {
                items.push(reconciliation_item(
                    "entity_revision",
                    &revision.revision_id,
                    Some(revision.project_id.clone()),
                    "noop",
                    Some(ACTION_NOOP),
                    Some(revision.content_sha256.clone()),
                    None,
                    "Entity revision already exists locally.",
                    json!({}),
                ));
            } else {
                add_conflict(
                    &mut items,
                    &mut actions,
                    "entity_revision",
                    &revision.revision_id,
                    Some(revision.project_id.clone()),
                    Some(revision.content_sha256.clone()),
                    "Remote entity revision conflicts with a local revision.",
                    json!({"local_content_sha256": existing_hash}),
                );
            }
            continue;
        }
        if get_project_schema(connection, &revision.project_id).is_ok() {
            items.push(reconciliation_item(
                "entity_revision",
                &revision.revision_id,
                Some(revision.project_id.clone()),
                "remote_available",
                Some(ACTION_IMPORT_ENTITY_REVISION),
                Some(revision.content_sha256.clone()),
                None,
                "Entity revision can be imported into an existing project.",
                json!({}),
            ));
            actions.push(reconciliation_action(
                ACTION_IMPORT_ENTITY_REVISION,
                "entity_revision",
                &revision.revision_id,
                Some(revision.project_id.clone()),
                Some(revision.content_sha256.clone()),
                None,
                "Import entity revision into the existing project.",
                json!({}),
            ));
        }
    }

    Ok(summarize_plan(items, actions))
}

fn apply_result(
    action: SyncReconciliationActionSchema,
    status: &str,
    reason: &str,
    details: Value,
) -> SyncReconciliationApplyActionResultSchema {
    SyncReconciliationApplyActionResultSchema {
        action,
        status: status.to_string(),
        reason: Some(reason.to_string()),
        details,
    }
}

fn project_status_metadata_from_action(
    action: &SyncReconciliationActionSchema,
) -> Option<SyncProjectStatusProjectMetadataSchema> {
    action
        .details
        .get("remote_metadata")
        .and_then(|metadata| {
            serde_json::from_value::<SyncMetadataProjectSchema>(metadata.clone()).ok()
        })
        .map(|metadata| SyncProjectStatusProjectMetadataSchema {
            project_id: metadata.project_id,
            display_name: metadata.display_name,
            source_key_override: metadata.source_key_override,
            source_sha256: metadata.source_sha256,
            duration_seconds: metadata.duration_seconds,
            sample_rate: metadata.sample_rate,
            channels: metadata.channels,
            created_at: Some(metadata.created_at),
            updated_at: Some(metadata.updated_at),
        })
}

fn persist_reconciliation_conflict(
    connection: &Connection,
    action: &SyncReconciliationActionSchema,
    payload: &SyncReconciliationApplyRequest,
) -> Result<ProjectSchema, String> {
    let project_id = action.project_id.as_deref().unwrap_or(&action.item_id);
    let current_conflict_count = get_project_schema(connection, project_id)
        .map(|project| project.sync_conflict_count)
        .unwrap_or(0);
    update_project_sync_status(
        connection,
        project_id,
        SyncProjectStatusUpdateRequest {
            sync_status: "conflicted".to_string(),
            sync_status_reason: action.reason.clone(),
            sync_required_artifact_ids: None,
            sync_provider_device_ids: None,
            sync_conflict_count: Some(current_conflict_count.saturating_add(1)),
            manifest: payload
                .project_manifests
                .iter()
                .find(|manifest| manifest.project.project_id == project_id)
                .cloned(),
            project: project_status_metadata_from_action(action),
        },
    )
}

pub(super) fn apply_reconciliation_action(
    connection: &Connection,
    root: &Path,
    action: SyncReconciliationActionSchema,
    payload: &SyncReconciliationApplyRequest,
) -> SyncReconciliationApplyActionResultSchema {
    let result = (|| -> Result<(&'static str, &'static str, Value), String> {
        match action.action_type.as_str() {
            ACTION_NOOP => Ok(("satisfied", "Action is already satisfied.", json!({}))),
            ACTION_FETCH_ARTIFACT_CONTENT => {
                let content_sha256 = action
                    .content_sha256
                    .as_ref()
                    .ok_or_else(|| "Fetch action does not identify content_sha256.".to_string())?;
                get_staged_artifact(connection, root, content_sha256, None)?;
                Ok((
                    "satisfied",
                    "Required artifact content is staged and verified locally.",
                    json!({}),
                ))
            }
            ACTION_IMPORT_PROJECT_MANIFEST => {
                let project_id = action.project_id.as_deref().unwrap_or(&action.item_id);
                let manifest = payload
                    .project_manifests
                    .iter()
                    .find(|manifest| manifest.project.project_id == project_id)
                    .ok_or_else(|| {
                        "Project manifest is not present in the apply request.".to_string()
                    })?;
                import_sync_project_manifest(
                    connection,
                    root,
                    SyncProjectStagedImportRequest {
                        manifest: manifest.clone(),
                        staging_root: payload.staging_root.clone(),
                        use_content_addressed_staging: Some(payload.use_content_addressed_staging),
                    },
                )?;
                Ok((
                    "applied",
                    "Project manifest was imported through the mobile sync manifest service.",
                    json!({"project_id": project_id}),
                ))
            }
            ACTION_IMPORT_ARTIFACT_MANIFEST => {
                let project_id = action.project_id.as_ref().ok_or_else(|| {
                    "Artifact import action does not include a project_id.".to_string()
                })?;
                let manifest = payload
                    .project_manifests
                    .iter()
                    .find(|manifest| manifest.project.project_id == *project_id)
                    .ok_or_else(|| {
                        "Project manifest is not present in the apply request.".to_string()
                    })?;
                import_sync_project_manifest(
                    connection,
                    root,
                    SyncProjectStagedImportRequest {
                        manifest: manifest.clone(),
                        staging_root: payload.staging_root.clone(),
                        use_content_addressed_staging: Some(payload.use_content_addressed_staging),
                    },
                )?;
                Ok((
                    "applied",
                    "Artifact manifest was imported through the mobile sync manifest service.",
                    json!({"project_id": project_id}),
                ))
            }
            ACTION_IMPORT_ENTITY_REVISION => {
                let revision = payload
                    .remote_library
                    .entity_revisions
                    .iter()
                    .chain(
                        payload
                            .project_manifests
                            .iter()
                            .flat_map(|manifest| manifest.entity_revisions.iter()),
                    )
                    .find(|revision| revision.revision_id == action.item_id)
                    .ok_or_else(|| {
                        "Entity revision is not present in the apply request.".to_string()
                    })?;
                connection
                    .execute_batch("BEGIN IMMEDIATE")
                    .map_err(|error| error.to_string())?;
                let import_result = (|| -> Result<(), String> {
                    import_entity_revisions(connection, std::slice::from_ref(revision))?;
                    hydrate_imported_read_models(connection, &revision.project_id)
                })();
                if let Err(message) = import_result {
                    let _ = connection.execute_batch("ROLLBACK");
                    return Err(message);
                }
                if let Err(error) = connection.execute_batch("COMMIT") {
                    let _ = connection.execute_batch("ROLLBACK");
                    return Err(error.to_string());
                }
                Ok((
                    "applied",
                    "Entity revision was imported into the existing project.",
                    json!({"revision_id": revision.revision_id}),
                ))
            }
            ACTION_APPLY_DELETE_TOMBSTONE => {
                let tombstone =
                    tombstones_for_request(&payload.remote_library, &payload.project_manifests)
                        .into_iter()
                        .find(|tombstone| {
                            normalize_tombstone_target_type(&tombstone.target_type)
                                == action.item_type
                                && tombstone.target_id == action.item_id
                                && action
                                    .project_id
                                    .as_deref()
                                    .map_or(true, |project_id| project_id == tombstone.project_id)
                        })
                        .ok_or_else(|| {
                            "Delete tombstone is not present in the apply request.".to_string()
                        })?;
                apply_delete_tombstone(connection, &tombstone)?;
                Ok((
                    "applied",
                    "Delete tombstone was applied through the mobile sync tombstone service.",
                    json!({"tombstone_id": tombstone.tombstone_id}),
                ))
            }
            ACTION_UPSERT_PROJECT_STATUS => {
                let project_id = action.project_id.as_deref().unwrap_or(&action.item_id);
                let project_status = action
                    .details
                    .get("project_status")
                    .and_then(Value::as_str)
                    .unwrap_or("remote_available")
                    .to_string();
                let remote_metadata = action.details.get("remote_metadata");
                let project_metadata = remote_metadata.and_then(|metadata| {
                    serde_json::from_value::<SyncMetadataProjectSchema>(metadata.clone()).ok()
                });
                let status_project =
                    project_metadata.map(|metadata| SyncProjectStatusProjectMetadataSchema {
                        project_id: metadata.project_id,
                        display_name: metadata.display_name,
                        source_key_override: metadata.source_key_override,
                        source_sha256: metadata.source_sha256,
                        duration_seconds: metadata.duration_seconds,
                        sample_rate: metadata.sample_rate,
                        channels: metadata.channels,
                        created_at: Some(metadata.created_at),
                        updated_at: Some(metadata.updated_at),
                    });
                let required_artifact_ids = action
                    .details
                    .get("required_artifact_ids")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    });
                let provider_device_ids = action
                    .details
                    .get("provider_device_ids")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    });
                update_project_sync_status(
                    connection,
                    project_id,
                    SyncProjectStatusUpdateRequest {
                        sync_status: project_status,
                        sync_status_reason: action.reason.clone(),
                        sync_required_artifact_ids: required_artifact_ids,
                        sync_provider_device_ids: provider_device_ids,
                        sync_conflict_count: Some(
                            if action.details.get("project_status").and_then(Value::as_str)
                                == Some("conflicted")
                            {
                                1
                            } else {
                                0
                            },
                        ),
                        manifest: payload
                            .project_manifests
                            .iter()
                            .find(|manifest| manifest.project.project_id == project_id)
                            .cloned(),
                        project: status_project,
                    },
                )?;
                Ok((
                    "applied",
                    "Project sync status was updated through the mobile sync status service.",
                    json!({"project_id": project_id}),
                ))
            }
            ACTION_RECORD_CONFLICT => {
                let project = persist_reconciliation_conflict(connection, &action, payload)?;
                Ok((
                    "applied",
                    "Project conflict status was recorded through the mobile sync status service.",
                    json!({
                        "project_id": project.id,
                        "sync_status": project.sync_status,
                        "sync_conflict_count": project.sync_conflict_count,
                    }),
                ))
            }
            _ => Ok((
                "skipped",
                "Reconciliation action type is not supported.",
                json!({}),
            )),
        }
    })();

    match result {
        Ok((status, reason, details)) => apply_result(action, status, reason, details),
        Err(message) => {
            let status = if action.action_type == ACTION_FETCH_ARTIFACT_CONTENT
                || message.contains("staged")
                || message.contains("not present")
            {
                "skipped"
            } else {
                "failed"
            };
            apply_result(action, status, &message, json!({}))
        }
    }
}

fn summarize_apply_results(
    planned_actions: usize,
    results: &[SyncReconciliationApplyActionResultSchema],
) -> SyncReconciliationApplySummarySchema {
    SyncReconciliationApplySummarySchema {
        planned_actions,
        applied_actions: results
            .iter()
            .filter(|result| result.status == "applied")
            .count(),
        satisfied_actions: results
            .iter()
            .filter(|result| result.status == "satisfied")
            .count(),
        skipped_actions: results
            .iter()
            .filter(|result| result.status == "skipped")
            .count(),
        failed_actions: results
            .iter()
            .filter(|result| result.status == "failed")
            .count(),
    }
}

pub fn mobile_plan_sync_reconciliation(
    app: AppHandle,
    payload: SyncReconciliationPlanRequest,
) -> Result<SyncReconciliationPlanResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    plan_sync_reconciliation_parts(
        &connection,
        &root,
        &payload.remote_library,
        &payload.project_manifests,
        &payload.peer_inventory,
    )
}

pub fn mobile_apply_sync_reconciliation(
    app: AppHandle,
    payload: SyncReconciliationApplyRequest,
) -> Result<SyncReconciliationApplyResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let scoped_project_ids = scoped_apply_project_ids(&payload);
    let scoped_payload = SyncReconciliationApplyRequest {
        remote_library: scoped_remote_library_for_project_ids(
            &payload.remote_library,
            &scoped_project_ids,
        ),
        project_manifests: scoped_project_manifests_for_project_ids(
            &payload.project_manifests,
            &scoped_project_ids,
        ),
        peer_inventory: payload.peer_inventory.clone(),
        staging_root: payload.staging_root.clone(),
        use_content_addressed_staging: payload.use_content_addressed_staging,
        project_ids: payload.project_ids.clone(),
        include_timing_evidence: payload.include_timing_evidence,
    };
    let plan = plan_sync_reconciliation_parts(
        &connection,
        &root,
        &scoped_payload.remote_library,
        &scoped_payload.project_manifests,
        &scoped_payload.peer_inventory,
    )?;
    let started = Instant::now();
    let mut results = Vec::new();
    for action in plan.actions.iter().cloned() {
        results.push(apply_reconciliation_action(
            &connection,
            &root,
            action,
            &scoped_payload,
        ));
    }
    let summary = summarize_apply_results(plan.actions.len(), &results);
    let timing_evidence = if payload.include_timing_evidence {
        vec![SyncReconciliationTimingEvidenceSchema {
            phase: "apply".to_string(),
            duration_ms: started.elapsed().as_secs_f64() * 1000.0,
            action_type: None,
            item_type: None,
            item_id: None,
            project_id: None,
            status: None,
            details: json!({"result_count": results.len()}),
        }]
    } else {
        Vec::new()
    };
    Ok(SyncReconciliationApplyResponse {
        summary,
        plan,
        results,
        timing_evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::path::Path;

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

    #[test]
    fn stale_live_tombstone_plans_noop_without_apply_action() {
        let connection = Connection::open_in_memory().unwrap();
        let sync_group_id = insert_trusted_peer(&connection, "device_peer_1");
        let project_id = source_hash_to_project_id(
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        )
        .unwrap();
        let live_at = "2026-01-02T00:00:00Z";
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at)
                 VALUES (?1, 'Live', '', '', 'local', ?2, ?2)",
                params![&project_id, live_at],
            )
            .unwrap();
        let remote_library = SyncReconciliationRemoteLibrarySchema {
            projects: Vec::new(),
            artifacts: Vec::new(),
            entity_revisions: Vec::new(),
            delete_tombstones: vec![SyncDeleteTombstoneSchema {
                tombstone_id: "tomb_plan_stale_project".to_string(),
                sync_group_id,
                project_id: project_id.to_string(),
                target_type: "project".to_string(),
                target_id: project_id.to_string(),
                author_device_id: "device_peer_1".to_string(),
                deleted_at: live_at.to_string(),
                prior_metadata: json!({}),
                created_at: live_at.to_string(),
                updated_at: live_at.to_string(),
            }],
        };

        let plan =
            plan_sync_reconciliation_parts(&connection, Path::new(""), &remote_library, &[], &[])
                .unwrap();

        assert_eq!(plan.actions.len(), 0);
        assert_eq!(plan.items.len(), 1);
        let item = &plan.items[0];
        assert_eq!(item.item_type, "project");
        assert_eq!(item.item_id, project_id);
        assert_eq!(item.status, "noop");
        assert_eq!(item.action_type.as_deref(), Some(ACTION_NOOP));
        assert_eq!(
            item.reason.as_deref(),
            Some("Delete tombstone is older than or equal to a live sync target.")
        );
        assert!(!plan.actions.iter().any(|action| {
            action.action_type == ACTION_APPLY_DELETE_TOMBSTONE && action.item_id == project_id
        }));
    }
}
