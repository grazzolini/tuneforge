#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn new_artifact_id() -> Result<String, String> {
    use rand::TryRng as _;

    let mut bytes = [0_u8; ARTIFACT_ID_RANDOM_BYTE_COUNT];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| format!("Could not generate artifact id: {error}"))?;
    let mut id = String::with_capacity(ARTIFACT_ID_PREFIX.len() + bytes.len() * 2);
    id.push_str(ARTIFACT_ID_PREFIX);
    for byte in bytes {
        use std::fmt::Write as _;

        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sync_editable(sync_status: &str) -> bool {
    sync_status == DEFAULT_SYNC_STATUS
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn normalize_sha256(value: &str, field_name: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64
        || normalized
            .as_bytes()
            .iter()
            .any(|byte| !byte.is_ascii_hexdigit())
    {
        return Err(format!("{field_name} must be a full SHA-256 hex digest."));
    }
    Ok(normalized)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn source_hash_to_project_id(source_sha256: &str) -> Result<String, String> {
    Ok(format!(
        "{PROJECT_ID_PREFIX}{}",
        normalize_sha256(source_sha256, "source_sha256")?
    ))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn safe_sync_relative_path_parts(relative_path: &str) -> Result<Vec<String>, String> {
    if relative_path.contains('\0') || relative_path.contains('\\') {
        return Err("Sync relative path is invalid.".to_string());
    }
    let parts = relative_path.split('/').collect::<Vec<_>>();
    if parts.is_empty()
        || relative_path.starts_with('/')
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err("Sync relative path is invalid.".to_string());
    }
    Ok(parts.into_iter().map(ToString::to_string).collect())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_manifest_source_audio_artifact(
    artifact: &SyncProjectManifestArtifactSchema,
    project_id: &str,
) -> Result<(), String> {
    if artifact.project_id != project_id {
        return Err(
            "Project manifest source_audio artifact belongs to a different project.".to_string(),
        );
    }
    if artifact.r#type != "source_audio" {
        return Err("Project manifest source_audio artifact has the wrong type.".to_string());
    }
    normalize_sha256(&artifact.content_sha256, "content_sha256")?;
    safe_sync_relative_path_parts(&artifact.relative_path)?;
    if !artifact.format.trim().eq_ignore_ascii_case("wav") {
        return Err("Project manifest source_audio artifact must use wav format.".to_string());
    }
    if !artifact
        .relative_path
        .to_ascii_lowercase()
        .ends_with(".wav")
    {
        return Err("Project manifest source_audio relative_path must end in .wav.".to_string());
    }
    Ok(())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn source_audio_artifact_for_project<'a>(
    artifacts: &'a [SyncProjectManifestArtifactSchema],
    project_id: &str,
) -> Result<&'a SyncProjectManifestArtifactSchema, String> {
    let mut artifacts = artifacts
        .iter()
        .filter(|artifact| artifact.project_id == project_id && artifact.r#type == "source_audio");
    let Some(artifact) = artifacts.next() else {
        return Err(
            "Project manifest requires exactly one source_audio artifact for the project."
                .to_string(),
        );
    };
    if artifacts.next().is_some() {
        return Err(
            "Project manifest requires exactly one source_audio artifact for the project."
                .to_string(),
        );
    }
    validate_manifest_source_audio_artifact(artifact, project_id)?;
    Ok(artifact)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn manifest_source_audio_artifact(
    manifest: &SyncProjectManifestSchema,
) -> Result<&SyncProjectManifestArtifactSchema, String> {
    source_audio_artifact_for_project(&manifest.artifacts, &manifest.project.project_id)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_sync_project_manifest_identity(
    manifest: &SyncProjectManifestSchema,
) -> Result<(), String> {
    if manifest.schema_version != SYNC_PROJECT_MANIFEST_SCHEMA_VERSION {
        return Err("Project manifest schema_version is not supported.".to_string());
    }
    let source_sha256 = normalize_sha256(&manifest.project.source_sha256, "source_sha256")?;
    let expected_project_id = source_hash_to_project_id(&source_sha256)?;
    if manifest.project.project_id != expected_project_id {
        return Err("Project manifest project_id must be derived from source_sha256.".to_string());
    }
    for artifact in &manifest.artifacts {
        if artifact.project_id != manifest.project.project_id {
            return Err("Project manifest artifact belongs to a different project.".to_string());
        }
        normalize_sha256(&artifact.content_sha256, "content_sha256")?;
        safe_sync_relative_path_parts(&artifact.relative_path)?;
    }
    manifest_source_audio_artifact(manifest)?;
    for revision in &manifest.entity_revisions {
        if revision.project_id != manifest.project.project_id {
            return Err(
                "Project manifest entity revision belongs to a different project.".to_string(),
            );
        }
        normalize_sha256(&revision.content_sha256, "content_sha256")?;
    }
    Ok(())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sync_staging_relative_path(content_sha256: &str) -> Result<String, String> {
    let normalized = normalize_sha256(content_sha256, "content_sha256")?;
    Ok(format!("sha256/{}/{}", &normalized[..2], normalized))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn string_list_from_json(raw: &str) -> Vec<String> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
enum MobileJobSortBy {
    Activity,
    CreatedAt,
    StartedAt,
    UpdatedAt,
    Status,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
enum MobileJobSortOrder {
    Asc,
    Desc,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn normalized_mobile_job_sort_by(value: Option<&str>) -> Result<MobileJobSortBy, String> {
    match value.unwrap_or("activity") {
        "activity" => Ok(MobileJobSortBy::Activity),
        "created_at" => Ok(MobileJobSortBy::CreatedAt),
        "started_at" => Ok(MobileJobSortBy::StartedAt),
        "updated_at" => Ok(MobileJobSortBy::UpdatedAt),
        "status" => Ok(MobileJobSortBy::Status),
        _ => Err(
            "Job sort_by must be one of activity, created_at, started_at, updated_at, or status."
                .to_string(),
        ),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn normalized_mobile_job_sort_order(
    value: Option<&str>,
) -> Result<Option<MobileJobSortOrder>, String> {
    match value {
        None => Ok(None),
        Some("asc") => Ok(Some(MobileJobSortOrder::Asc)),
        Some("desc") => Ok(Some(MobileJobSortOrder::Desc)),
        Some(_) => Err("Job sort_order must be asc or desc.".to_string()),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn compare_mobile_job_ids(left: &JobSchema, right: &JobSchema) -> Ordering {
    left.id.cmp(&right.id)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn compare_mobile_job_ids_descending(left: &JobSchema, right: &JobSchema) -> Ordering {
    right.id.cmp(&left.id)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn compare_mobile_job_timestamp(
    left: Option<&str>,
    right: Option<&str>,
    sort_order: MobileJobSortOrder,
) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => match sort_order {
            MobileJobSortOrder::Asc => left.cmp(right),
            MobileJobSortOrder::Desc => right.cmp(left),
        },
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_job_timestamp(job: &JobSchema, sort_by: MobileJobSortBy) -> Option<&str> {
    match sort_by {
        MobileJobSortBy::CreatedAt => Some(job.created_at.as_str()),
        MobileJobSortBy::StartedAt => job.started_at.as_deref(),
        MobileJobSortBy::UpdatedAt => Some(job.updated_at.as_str()),
        MobileJobSortBy::Activity | MobileJobSortBy::Status => None,
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_job_activity_group(job: &JobSchema) -> i32 {
    match job.status.as_str() {
        "running" => 0,
        "pending" => 1,
        "completed" | "cancelled" | "failed" => 2,
        _ => 3,
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_job_status_group(job: &JobSchema) -> i32 {
    match job.status.as_str() {
        "running" => 0,
        "pending" => 1,
        "completed" => 2,
        "cancelled" => 3,
        "failed" => 4,
        _ => 5,
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn compare_mobile_job_activity(left: &JobSchema, right: &JobSchema) -> Ordering {
    let left_group = mobile_job_activity_group(left);
    let right_group = mobile_job_activity_group(right);
    if left_group != right_group {
        return left_group.cmp(&right_group);
    }

    match left_group {
        0 => compare_mobile_job_timestamp(
            left.started_at
                .as_deref()
                .or(Some(left.created_at.as_str())),
            right
                .started_at
                .as_deref()
                .or(Some(right.created_at.as_str())),
            MobileJobSortOrder::Asc,
        )
        .then_with(|| compare_mobile_job_ids(left, right)),
        1 => left
            .created_at
            .cmp(&right.created_at)
            .then_with(|| compare_mobile_job_ids(left, right)),
        2 => compare_mobile_job_timestamp(
            left.completed_at
                .as_deref()
                .or(Some(left.updated_at.as_str())),
            right
                .completed_at
                .as_deref()
                .or(Some(right.updated_at.as_str())),
            MobileJobSortOrder::Desc,
        )
        .then_with(|| compare_mobile_job_ids_descending(left, right)),
        _ => compare_mobile_job_timestamp(
            Some(left.updated_at.as_str()),
            Some(right.updated_at.as_str()),
            MobileJobSortOrder::Desc,
        )
        .then_with(|| compare_mobile_job_ids_descending(left, right)),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn compare_mobile_job_status(
    left: &JobSchema,
    right: &JobSchema,
    sort_order: MobileJobSortOrder,
) -> Ordering {
    let left_group = mobile_job_status_group(left);
    let right_group = mobile_job_status_group(right);
    if left_group != right_group {
        return match sort_order {
            MobileJobSortOrder::Asc => left_group.cmp(&right_group),
            MobileJobSortOrder::Desc => right_group.cmp(&left_group),
        };
    }
    compare_mobile_job_activity(left, right)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn compare_mobile_jobs_for_params(
    left: &JobSchema,
    right: &JobSchema,
    sort_by: MobileJobSortBy,
    sort_order: Option<MobileJobSortOrder>,
) -> Ordering {
    match sort_by {
        MobileJobSortBy::Activity => compare_mobile_job_activity(left, right),
        MobileJobSortBy::Status => {
            compare_mobile_job_status(left, right, sort_order.unwrap_or(MobileJobSortOrder::Asc))
        }
        MobileJobSortBy::CreatedAt | MobileJobSortBy::StartedAt | MobileJobSortBy::UpdatedAt => {
            compare_mobile_job_timestamp(
                mobile_job_timestamp(left, sort_by),
                mobile_job_timestamp(right, sort_by),
                sort_order.unwrap_or(MobileJobSortOrder::Desc),
            )
            .then_with(|| compare_mobile_job_ids(left, right))
        }
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_job_matches_search(
    job: &JobSchema,
    normalized_search: &str,
    project_display_names: &std::collections::HashMap<String, String>,
) -> bool {
    if normalized_search.is_empty() {
        return true;
    }
    job.project_id
        .as_ref()
        .and_then(|project_id| project_display_names.get(project_id))
        .map(|display_name| {
            display_name
                .to_ascii_lowercase()
                .contains(normalized_search)
        })
        .unwrap_or(false)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_jobs_response_for_params(
    mut jobs: Vec<JobSchema>,
    params: &ListJobsParams,
    project_display_names: &std::collections::HashMap<String, String>,
    limit: usize,
    offset: usize,
) -> Result<JobsResponse, String> {
    let sort_by = normalized_mobile_job_sort_by(params.sort_by.as_deref())?;
    let sort_order = normalized_mobile_job_sort_order(params.sort_order.as_deref())?;
    if sort_by == MobileJobSortBy::Activity && sort_order.is_some() {
        return Err("sort_order is not valid when sort_by is activity.".to_string());
    }

    let normalized_search = params
        .search
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    jobs.retain(|job| {
        let status_matches = params.status.as_ref().map_or(true, |statuses| {
            statuses.is_empty() || statuses.iter().any(|status| status == &job.status)
        });
        let project_matches = params.project_id.as_ref().map_or(true, |project_id| {
            job.project_id.as_deref() == Some(project_id.as_str())
        });
        status_matches
            && project_matches
            && mobile_job_matches_search(job, &normalized_search, project_display_names)
    });
    jobs.sort_by(|left, right| compare_mobile_jobs_for_params(left, right, sort_by, sort_order));

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

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_canonical_project_id(project_id: &str) -> Result<String, String> {
    let trimmed = project_id.trim();
    let source_sha256 = trimmed
        .strip_prefix(PROJECT_ID_PREFIX)
        .ok_or_else(|| "project_id must use canonical proj_sha256_<64 hex> format.".to_string())?;
    let normalized = normalize_sha256(source_sha256, "project_id source SHA-256")?;
    let canonical = format!("{PROJECT_ID_PREFIX}{normalized}");
    if trimmed != canonical {
        return Err("project_id must use canonical proj_sha256_<64 hex> format.".to_string());
    }
    Ok(canonical)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_project_source_identity(
    project_id: &str,
    source_sha256: Option<&str>,
) -> Result<String, String> {
    let canonical_project_id = validate_canonical_project_id(project_id)?;
    if let Some(source_sha256) = source_sha256 {
        let expected_project_id = source_hash_to_project_id(source_sha256)?;
        if canonical_project_id != expected_project_id {
            return Err("project_id must be derived from source_sha256.".to_string());
        }
    }
    Ok(canonical_project_id)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn normalize_tombstone_target_type(target_type: &str) -> String {
    match target_type.trim().to_ascii_lowercase().as_str() {
        "revision" | "sync_entity_revision" => "entity_revision".to_string(),
        other => other.to_string(),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_manifest_delete_tombstone_targets(
    manifest: &SyncProjectManifestSchema,
) -> Result<(), String> {
    let live_artifact_ids = manifest
        .artifacts
        .iter()
        .map(|artifact| artifact.artifact_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let live_revision_ids = manifest
        .entity_revisions
        .iter()
        .map(|revision| revision.revision_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut tombstone_ids = std::collections::HashSet::new();
    let mut tombstone_targets = std::collections::HashSet::new();

    for tombstone in &manifest.delete_tombstones {
        let tombstone_id = tombstone.tombstone_id.trim();
        let target_id = tombstone.target_id.trim();
        if !tombstone_ids.insert(tombstone_id) {
            return Err("Project manifest contains duplicate delete tombstone IDs.".to_string());
        }

        let target_type = normalize_tombstone_target_type(&tombstone.target_type);
        if !tombstone_targets.insert((target_type.clone(), target_id)) {
            return Err(
                "Project manifest contains duplicate delete tombstone targets.".to_string(),
            );
        }

        let targets_live_record = match target_type.as_str() {
            "project" => target_id == manifest.project.project_id,
            "artifact" => live_artifact_ids.contains(target_id),
            "entity_revision" => live_revision_ids.contains(target_id),
            _ => false,
        };
        if targets_live_record {
            return Err(
                "Project manifest contains live targets covered by sync delete tombstones."
                    .to_string(),
            );
        }
    }

    Ok(())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn add_effective_tombstone_target(
    targets: &mut std::collections::HashSet<(String, String)>,
    tombstone: &SyncDeleteTombstoneSchema,
) {
    let target_type = normalize_tombstone_target_type(&tombstone.target_type);
    targets.insert((target_type.clone(), tombstone.target_id.clone()));
    if target_type == "project" {
        targets.insert(("project".to_string(), tombstone.project_id.clone()));
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sync_target_is_tombstoned(
    targets: &std::collections::HashSet<(String, String)>,
    item_type: &str,
    item_id: &str,
    project_id: &str,
) -> bool {
    targets.contains(&("project".to_string(), project_id.to_string()))
        || targets.contains(&(
            normalize_tombstone_target_type(item_type),
            item_id.to_string(),
        ))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn manifest_live_targets_covered_by_tombstones(
    manifest: &SyncProjectManifestSchema,
    targets: &std::collections::HashSet<(String, String)>,
) -> (Vec<String>, Vec<String>) {
    let project_id = &manifest.project.project_id;
    let artifact_ids = manifest
        .artifacts
        .iter()
        .filter(|artifact| {
            sync_target_is_tombstoned(targets, "artifact", &artifact.artifact_id, project_id)
        })
        .map(|artifact| artifact.artifact_id.clone())
        .collect();
    let revision_ids = manifest
        .entity_revisions
        .iter()
        .filter(|revision| {
            sync_target_is_tombstoned(
                targets,
                "entity_revision",
                &revision.revision_id,
                project_id,
            )
        })
        .map(|revision| revision.revision_id.clone())
        .collect();
    (artifact_ids, revision_ids)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sync_timestamp_is_newer(live_at: &str, deleted_at: &str) -> bool {
    let Ok(live_at) = chrono::DateTime::parse_from_rfc3339(live_at) else {
        return false;
    };
    let Ok(deleted_at) = chrono::DateTime::parse_from_rfc3339(deleted_at) else {
        return false;
    };
    live_at > deleted_at
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_delete_tombstone_required_fields(
    tombstone: &SyncDeleteTombstoneSchema,
) -> Result<(), String> {
    if tombstone.tombstone_id.trim().is_empty() {
        return Err("Remote delete tombstone tombstone_id must not be empty.".to_string());
    }
    for (field_name, value) in [
        ("deleted_at", tombstone.deleted_at.as_str()),
        ("created_at", tombstone.created_at.as_str()),
        ("updated_at", tombstone.updated_at.as_str()),
    ] {
        chrono::DateTime::parse_from_rfc3339(value).map_err(|_| {
            format!("Remote delete tombstone {field_name} must be an ISO-8601 timestamp.")
        })?;
    }
    Ok(())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn scoped_apply_project_ids(
    payload: &SyncReconciliationApplyRequest,
) -> std::collections::HashSet<String> {
    if !payload.project_ids.is_empty() {
        return payload.project_ids.iter().cloned().collect();
    }
    payload
        .project_manifests
        .iter()
        .map(|manifest| manifest.project.project_id.clone())
        .collect()
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn scoped_remote_library_for_project_ids(
    remote_library: &SyncReconciliationRemoteLibrarySchema,
    project_ids: &std::collections::HashSet<String>,
) -> SyncReconciliationRemoteLibrarySchema {
    if project_ids.is_empty() {
        return remote_library.clone();
    }
    SyncReconciliationRemoteLibrarySchema {
        projects: remote_library
            .projects
            .iter()
            .filter(|project| project_ids.contains(&project.project_id))
            .cloned()
            .collect(),
        artifacts: remote_library
            .artifacts
            .iter()
            .filter(|artifact| project_ids.contains(&artifact.project_id))
            .cloned()
            .collect(),
        entity_revisions: remote_library
            .entity_revisions
            .iter()
            .filter(|revision| project_ids.contains(&revision.project_id))
            .cloned()
            .collect(),
        delete_tombstones: remote_library
            .delete_tombstones
            .iter()
            .filter(|tombstone| project_ids.contains(&tombstone.project_id))
            .cloned()
            .collect(),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn scoped_project_manifests_for_project_ids(
    manifests: &[SyncProjectManifestSchema],
    project_ids: &std::collections::HashSet<String>,
) -> Vec<SyncProjectManifestSchema> {
    if project_ids.is_empty() {
        return manifests.to_vec();
    }
    manifests
        .iter()
        .filter(|manifest| project_ids.contains(&manifest.project.project_id))
        .cloned()
        .collect()
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn require_sync_editable_status(sync_status: &str) -> Result<(), String> {
    if sync_editable(sync_status) {
        return Ok(());
    }
    Err(format!(
        "Project is locked by sync status '{sync_status}' and cannot be edited locally."
    ))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_sync_placeholder_state(sync_status: &str, source_path: &str, imported_path: &str) -> bool {
    if !matches!(
        sync_status.trim().to_ascii_lowercase().as_str(),
        "remote_available" | "syncing" | "missing" | "downloading"
    ) {
        return false;
    }
    let source_path = source_path.trim();
    let imported_path = imported_path.trim();
    if source_path.is_empty() && imported_path.is_empty() {
        return true;
    }
    let source_placeholder = source_path
        .strip_prefix("sync-placeholder:")
        .filter(|value| !value.trim().is_empty());
    let imported_placeholder = imported_path
        .strip_prefix("sync-placeholder:")
        .filter(|value| !value.trim().is_empty());
    source_placeholder.is_some() && source_placeholder == imported_placeholder
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn safe_legacy_project_id_component(project_id: &str) -> Result<String, String> {
    let trimmed = project_id.trim();
    let parts = safe_sync_relative_path_parts(trimmed)?;
    if parts.len() != 1 || parts[0] != trimmed {
        return Err("Project ID is not safe for mobile project cleanup.".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn validate_remote_tombstone_identity(
    tombstone_sync_group_id: &str,
    tombstone_author_device_id: &str,
    local_sync_group_id: &str,
    local_device_id: &str,
    active_trusted_device_ids: &[String],
) -> Result<(), String> {
    let sync_group_id = tombstone_sync_group_id.trim();
    let author_device_id = tombstone_author_device_id.trim();
    if sync_group_id != local_sync_group_id.trim() {
        return Err("Remote delete tombstone belongs to a different sync group.".to_string());
    }
    if author_device_id.is_empty() {
        return Err("Remote delete tombstone author_device_id must not be empty.".to_string());
    }
    if author_device_id == local_device_id.trim()
        || active_trusted_device_ids
            .iter()
            .any(|device_id| device_id == author_device_id)
    {
        return Ok(());
    }
    Err("Remote delete tombstone author_device_id is not an active trusted peer.".to_string())
}

#[cfg(any(test, target_os = "android"))]
fn validate_transport_trusted_peer(
    trusted_peer: Option<&SyncTrustedPeerSchema>,
    local_sync_group_id: &str,
) -> Result<(), String> {
    let trusted_peer =
        trusted_peer.ok_or_else(|| "Trusted peer is not an active trusted peer.".to_string())?;
    if trusted_peer.revoked_at.is_some() {
        return Err("Trusted peer is not an active trusted peer.".to_string());
    }
    if trusted_peer.sync_group_id != local_sync_group_id {
        return Err("Trusted peer belongs to a different sync group.".to_string());
    }
    Ok(())
}

#[cfg(any(test, target_os = "android"))]
fn canonical_transport_handshake_challenge(
    challenge: &Value,
    local_device_id: &str,
    peer_device_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<std::collections::BTreeMap<String, Value>, String> {
    let protocol_version = transport_challenge_string(challenge, "protocol_version", 1, None)?;
    if protocol_version != SYNC_PAIRING_PROTOCOL_VERSION {
        return Err(
            "Transport handshake challenge uses an unsupported protocol version.".to_string(),
        );
    }

    let challenge_type = transport_challenge_string(challenge, "challenge_type", 1, None)?;
    if challenge_type != TRANSPORT_HANDSHAKE_CHALLENGE_TYPE {
        return Err("Transport handshake challenge_type is not supported.".to_string());
    }

    let requester_device_id =
        transport_challenge_string(challenge, "requester_device_id", 1, Some(128))?;
    if requester_device_id != peer_device_id {
        return Err(
            "Transport handshake requester_device_id must match the trusted peer.".to_string(),
        );
    }

    let responder_device_id =
        transport_challenge_string(challenge, "responder_device_id", 1, Some(128))?;
    if responder_device_id != local_device_id {
        return Err(
            "Transport handshake responder_device_id must match the local device.".to_string(),
        );
    }

    let session_id = transport_challenge_string(challenge, "session_id", 16, Some(128))?;
    let challenge_nonce = transport_challenge_string(challenge, "challenge_nonce", 16, Some(512))?;
    let issued_at = transport_challenge_datetime(challenge, "issued_at")?;
    let expires_at = transport_challenge_datetime(challenge, "expires_at")?;
    validate_transport_challenge_window(issued_at, expires_at, now)?;

    let mut canonical = std::collections::BTreeMap::new();
    canonical.insert(
        "challenge_nonce".to_string(),
        Value::String(challenge_nonce.to_string()),
    );
    canonical.insert(
        "challenge_type".to_string(),
        Value::String(TRANSPORT_HANDSHAKE_CHALLENGE_TYPE.to_string()),
    );
    canonical.insert(
        "expires_at".to_string(),
        Value::String(transport_handshake_iso(expires_at)),
    );
    canonical.insert(
        "issued_at".to_string(),
        Value::String(transport_handshake_iso(issued_at)),
    );
    canonical.insert(
        "protocol_version".to_string(),
        Value::String(SYNC_PAIRING_PROTOCOL_VERSION.to_string()),
    );
    canonical.insert(
        "requester_device_id".to_string(),
        Value::String(requester_device_id.to_string()),
    );
    canonical.insert(
        "responder_device_id".to_string(),
        Value::String(responder_device_id.to_string()),
    );
    canonical.insert(
        "session_id".to_string(),
        Value::String(session_id.to_string()),
    );
    Ok(canonical)
}

#[cfg(any(test, target_os = "android"))]
fn transport_handshake_challenge_json(
    challenge: &std::collections::BTreeMap<String, Value>,
) -> Result<String, String> {
    serde_json::to_string(challenge).map_err(|error| error.to_string())
}

#[cfg(any(test, target_os = "android"))]
fn transport_handshake_proof_value(
    local_device_id: &str,
    peer_device_id: &str,
    public_key: &str,
    challenge: std::collections::BTreeMap<String, Value>,
    canonical_challenge_json: String,
    signature: String,
    signed_at: chrono::DateTime<chrono::Utc>,
) -> Value {
    serde_json::json!({
        "protocol_version": SYNC_PAIRING_PROTOCOL_VERSION,
        "challenge_type": TRANSPORT_HANDSHAKE_CHALLENGE_TYPE,
        "local_device_id": local_device_id,
        "peer_device_id": peer_device_id,
        "public_key": public_key,
        "challenge": challenge,
        "canonical_challenge_json": canonical_challenge_json,
        "signature": signature,
        "signed_at": transport_handshake_iso(signed_at),
    })
}

#[cfg(any(test, target_os = "android"))]
fn transport_challenge_string<'a>(
    challenge: &'a Value,
    field: &str,
    min_length: usize,
    max_length: Option<usize>,
) -> Result<&'a str, String> {
    let value = challenge
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Transport handshake {field} must be a string."))?;
    if value != value.trim() || value.len() < min_length {
        return Err(format!("Transport handshake {field} must be canonical."));
    }
    if max_length.is_some_and(|max_length| value.len() > max_length) {
        return Err(format!("Transport handshake {field} is too long."));
    }
    Ok(value)
}

#[cfg(any(test, target_os = "android"))]
fn transport_challenge_datetime(
    challenge: &Value,
    field: &str,
) -> Result<chrono::DateTime<chrono::Utc>, String> {
    let value = challenge
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Transport handshake {field} must be an ISO-8601 timestamp."))?;
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
        .map_err(|_| format!("Transport handshake {field} must be an ISO-8601 timestamp."))
}

#[cfg(any(test, target_os = "android"))]
fn validate_transport_challenge_window(
    issued_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    if issued_at >= expires_at {
        return Err("Transport handshake issued_at must be before expires_at.".to_string());
    }
    if expires_at <= now {
        return Err("Transport handshake challenge has expired.".to_string());
    }
    if issued_at > now + chrono::Duration::seconds(TRANSPORT_HANDSHAKE_CLOCK_SKEW_SECONDS) {
        return Err("Transport handshake issued_at is too far in the future.".to_string());
    }
    if expires_at - issued_at > chrono::Duration::seconds(TRANSPORT_HANDSHAKE_MAX_TTL_SECONDS) {
        return Err("Transport handshake challenge lifetime is too long.".to_string());
    }
    Ok(())
}

#[cfg(any(test, target_os = "android"))]
fn transport_handshake_iso(value: chrono::DateTime<chrono::Utc>) -> String {
    let micros = value.timestamp_subsec_micros();
    if micros == 0 {
        value.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sanitize_sync_manifest_value(value: &Value) -> Value {
    sanitize_sync_manifest_value_optional(value).unwrap_or(Value::Null)
}

fn sanitize_sync_manifest_value_optional(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) => {
            let mut sanitized = serde_json::Map::new();
            for (key, child) in map {
                if should_drop_sync_manifest_key(key) {
                    continue;
                }
                if let Some(sanitized_child) = sanitize_sync_manifest_value_optional(child) {
                    sanitized.insert(key.clone(), sanitized_child);
                }
            }
            Some(Value::Object(sanitized))
        }
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .filter_map(sanitize_sync_manifest_value_optional)
                .collect(),
        )),
        Value::String(value)
            if looks_like_local_absolute_path(value)
                || looks_like_transport_internal_value(value) =>
        {
            None
        }
        _ => Some(value.clone()),
    }
}

fn should_drop_sync_manifest_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace('-', "_");
    let compact = normalized.replace('_', "");
    normalized == "path"
        || normalized.ends_with("_path")
        || compact.ends_with("path")
        || compact.contains("endpoint")
        || compact.contains("transport")
        || compact.contains("iroh")
        || compact.contains("blake3")
}

fn looks_like_local_absolute_path(value: &str) -> bool {
    if value.starts_with("~/") || value.starts_with('/') || value.starts_with("\\\\") {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && bytes[0].is_ascii_alphabetic()
}

fn looks_like_transport_internal_value(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("iroh://")
        || normalized.starts_with("tuneforge-sync+iroh://")
        || normalized.starts_with("blake3:")
}


#[cfg(test)]
mod mobile_backend_tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    fn mobile_test_job(
        id: &str,
        status: &str,
        project_id: Option<&str>,
        created_at: &str,
        updated_at: &str,
        started_at: Option<&str>,
        completed_at: Option<&str>,
    ) -> JobSchema {
        JobSchema {
            id: id.to_string(),
            project_id: project_id.map(ToString::to_string),
            r#type: "analyze".to_string(),
            status: status.to_string(),
            progress: 0,
            source_artifact_id: None,
            result_artifact_ids: Vec::new(),
            chord_backend: None,
            chord_backend_fallback_from: None,
            chord_source: None,
            error_message: None,
            runtime_device: None,
            started_at: started_at.map(ToString::to_string),
            completed_at: completed_at.map(ToString::to_string),
            duration_seconds: None,
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    fn mobile_test_manifest(project_id: &str, source_sha256: &str) -> SyncProjectManifestSchema {
        let artifact_id = format!("art_source_{project_id}");
        SyncProjectManifestSchema {
            schema_version: SYNC_PROJECT_MANIFEST_SCHEMA_VERSION.to_string(),
            exported_at: "2026-05-22T12:00:00.000Z".to_string(),
            project: SyncProjectManifestProjectSchema {
                project_id: project_id.to_string(),
                display_name: "Synced Song".to_string(),
                source_key_override: None,
                source_sha256: source_sha256.to_string(),
                duration_seconds: Some(12.0),
                sample_rate: Some(44_100),
                channels: Some(2),
                created_at: "2026-05-22T12:00:00.000Z".to_string(),
                updated_at: "2026-05-22T12:00:00.000Z".to_string(),
            },
            entity_revisions: vec![SyncProjectManifestEntityRevisionSchema {
                revision_id: format!("rev_{project_id}"),
                project_id: project_id.to_string(),
                entity_type: "lyrics".to_string(),
                entity_id: "lyrics-main".to_string(),
                revision_type: "snapshot".to_string(),
                base_revision_id: None,
                author_device_id: "device_peer_1".to_string(),
                source_artifact_id: Some(artifact_id.clone()),
                content_sha256: source_sha256.to_string(),
                state: "active".to_string(),
                metadata: json!({}),
                payload: json!({}),
                created_at: "2026-05-22T12:00:00.000Z".to_string(),
                updated_at: "2026-05-22T12:00:00.000Z".to_string(),
            }],
            artifacts: vec![SyncProjectManifestArtifactSchema {
                artifact_id,
                project_id: project_id.to_string(),
                r#type: "source_audio".to_string(),
                format: "wav".to_string(),
                relative_path: "source/source.wav".to_string(),
                content_sha256: source_sha256.to_string(),
                size_bytes: 12,
                generated_by: "sync".to_string(),
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
                created_at: "2026-05-22T12:00:00.000Z".to_string(),
            }],
            delete_tombstones: Vec::new(),
        }
    }

    fn mobile_test_tombstone(
        tombstone_id: &str,
        project_id: &str,
        target_type: &str,
        target_id: &str,
    ) -> SyncDeleteTombstoneSchema {
        SyncDeleteTombstoneSchema {
            tombstone_id: tombstone_id.to_string(),
            sync_group_id: "sync_group_1".to_string(),
            project_id: project_id.to_string(),
            target_type: target_type.to_string(),
            target_id: target_id.to_string(),
            author_device_id: "device_peer_1".to_string(),
            deleted_at: "2026-05-22T12:00:00.000Z".to_string(),
            prior_metadata: json!({}),
            created_at: "2026-05-22T12:00:00.000Z".to_string(),
            updated_at: "2026-05-22T12:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn mobile_new_artifact_id_uses_column_safe_hex_entropy() {
        let artifact_id = new_artifact_id().unwrap();
        let suffix = artifact_id.strip_prefix(ARTIFACT_ID_PREFIX).unwrap();

        assert_eq!(artifact_id.len(), 32);
        assert_eq!(suffix.len(), 28);
        assert!(
            suffix
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        );
    }

    #[test]
    fn mobile_manifest_accepts_distinct_source_hash_and_wav_artifact_hash() {
        let source_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let wav_sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let mut manifest = mobile_test_manifest(&project_id, source_sha256);
        manifest.artifacts[0].content_sha256 = wav_sha256.to_string();

        validate_sync_project_manifest_identity(&manifest).unwrap();

        let source_artifact = manifest_source_audio_artifact(&manifest).unwrap();
        assert_eq!(source_artifact.content_sha256, wav_sha256);
        assert_ne!(
            source_artifact.content_sha256,
            manifest.project.source_sha256
        );
    }

    #[test]
    fn mobile_manifest_schema_defaults_revision_and_tombstone_lists() {
        let source_sha256 = "1212121212121212121212121212121212121212121212121212121212121212";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let manifest: SyncProjectManifestSchema = serde_json::from_value(json!({
            "schema_version": SYNC_PROJECT_MANIFEST_SCHEMA_VERSION,
            "exported_at": "2026-05-22T12:00:00.000Z",
            "project": {
                "project_id": project_id,
                "display_name": "Schema Defaults",
                "source_key_override": null,
                "source_sha256": source_sha256,
                "duration_seconds": null,
                "sample_rate": null,
                "channels": null,
                "created_at": "2026-05-22T12:00:00.000Z",
                "updated_at": "2026-05-22T12:00:00.000Z"
            },
            "artifacts": [{
                "artifact_id": "art_source",
                "project_id": project_id,
                "type": "source_audio",
                "format": "wav",
                "relative_path": "source/source.wav",
                "content_sha256": source_sha256,
                "size_bytes": 1,
                "generated_by": "sync",
                "can_delete": false,
                "can_regenerate": false,
                "cache_key": null,
                "created_at": "2026-05-22T12:00:00.000Z"
            }]
        }))
        .unwrap();

        assert!(manifest.entity_revisions.is_empty());
        assert!(manifest.delete_tombstones.is_empty());
        validate_sync_project_manifest_identity(&manifest).unwrap();
    }

    #[test]
    fn mobile_manifest_rejects_missing_or_malformed_source_audio() {
        let source_sha256 = "abababababababababababababababababababababababababababababababab";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let manifest = mobile_test_manifest(&project_id, source_sha256);

        let mut missing_source = manifest.clone();
        missing_source.artifacts.clear();
        assert!(validate_sync_project_manifest_identity(&missing_source)
            .unwrap_err()
            .contains("exactly one source_audio artifact"));

        let mut duplicate_source = manifest.clone();
        duplicate_source
            .artifacts
            .push(duplicate_source.artifacts[0].clone());
        assert!(validate_sync_project_manifest_identity(&duplicate_source)
            .unwrap_err()
            .contains("exactly one source_audio artifact"));

        let mut bad_format = manifest.clone();
        bad_format.artifacts[0].format = "m4a".to_string();
        assert!(validate_sync_project_manifest_identity(&bad_format)
            .unwrap_err()
            .contains("wav format"));

        let mut bad_path = manifest;
        bad_path.artifacts[0].relative_path = "source/source.m4a".to_string();
        assert!(validate_sync_project_manifest_identity(&bad_path)
            .unwrap_err()
            .contains("end in .wav"));
    }

    #[test]
    fn mobile_manifest_rejects_source_identity_mismatch() {
        let source_sha256 = "1313131313131313131313131313131313131313131313131313131313131313";
        let other_sha256 = "1414141414141414141414141414141414141414141414141414141414141414";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let mut manifest = mobile_test_manifest(&project_id, source_sha256);

        manifest.project.source_sha256 = other_sha256.to_string();
        assert!(validate_sync_project_manifest_identity(&manifest)
            .unwrap_err()
            .contains("project_id must be derived from source_sha256"));
    }

    #[test]
    fn mobile_jobs_latest_params_filter_sort_and_paginate_before_response() {
        let jobs = vec![
            mobile_test_job(
                "job_match_old",
                "completed",
                Some("project_a"),
                "2026-05-22T10:00:00.000Z",
                "2026-05-22T10:10:00.000Z",
                None,
                None,
            ),
            mobile_test_job(
                "job_match_middle",
                "completed",
                Some("project_a"),
                "2026-05-22T10:00:00.000Z",
                "2026-05-22T10:20:00.000Z",
                None,
                None,
            ),
            mobile_test_job(
                "job_match_new",
                "completed",
                Some("project_a"),
                "2026-05-22T10:00:00.000Z",
                "2026-05-22T10:30:00.000Z",
                None,
                None,
            ),
            mobile_test_job(
                "job_status_excluded",
                "pending",
                Some("project_a"),
                "2026-05-22T10:00:00.000Z",
                "2026-05-22T10:40:00.000Z",
                None,
                None,
            ),
            mobile_test_job(
                "job_project_excluded",
                "completed",
                Some("project_b"),
                "2026-05-22T10:00:00.000Z",
                "2026-05-22T10:50:00.000Z",
                None,
                None,
            ),
            mobile_test_job(
                "job_search_excluded",
                "completed",
                Some("project_c"),
                "2026-05-22T10:00:00.000Z",
                "2026-05-22T11:00:00.000Z",
                None,
                None,
            ),
        ];
        let project_display_names = std::collections::HashMap::from([
            ("project_a".to_string(), "Needle Song".to_string()),
            ("project_b".to_string(), "Needle Song".to_string()),
            ("project_c".to_string(), "Other Song".to_string()),
        ]);
        let params = ListJobsParams {
            status: Some(vec!["completed".to_string()]),
            project_id: Some("project_a".to_string()),
            search: Some("  NEEDLE  ".to_string()),
            sort_by: Some("updated_at".to_string()),
            sort_order: None,
            limit: None,
            offset: None,
        };

        let response =
            mobile_jobs_response_for_params(jobs, &params, &project_display_names, 2, 1).unwrap();

        assert_eq!(
            response
                .jobs
                .iter()
                .map(|job| job.id.as_str())
                .collect::<Vec<_>>(),
            vec!["job_match_middle", "job_match_old"]
        );
        assert_eq!(response.total, 3);
        assert_eq!(response.limit, 2);
        assert_eq!(response.offset, 1);
        assert!(!response.has_more);
    }

    #[test]
    fn mobile_jobs_activity_sort_rejects_sort_order_like_http_api() {
        let params = ListJobsParams {
            sort_order: Some("desc".to_string()),
            ..ListJobsParams::default()
        };

        let error = match mobile_jobs_response_for_params(
            Vec::new(),
            &params,
            &std::collections::HashMap::new(),
            50,
            0,
        ) {
            Ok(_) => panic!("expected sort_order with activity sort to fail"),
            Err(error) => error,
        };
        assert!(error.contains("sort_order is not valid when sort_by is activity"));
    }

    #[test]
    fn mobile_manifest_tombstones_reject_duplicate_ids_and_targets() {
        let source_sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let mut duplicate_id_manifest = mobile_test_manifest(&project_id, source_sha256);
        duplicate_id_manifest.delete_tombstones = vec![
            mobile_test_tombstone("tomb_duplicate", &project_id, "artifact", "art_deleted_a"),
            mobile_test_tombstone("tomb_duplicate", &project_id, "artifact", "art_deleted_b"),
        ];

        assert!(
            validate_manifest_delete_tombstone_targets(&duplicate_id_manifest)
                .unwrap_err()
                .contains("duplicate delete tombstone IDs")
        );

        let mut duplicate_target_manifest = mobile_test_manifest(&project_id, source_sha256);
        duplicate_target_manifest.delete_tombstones = vec![
            mobile_test_tombstone("tomb_a", &project_id, "artifact", "art_deleted"),
            mobile_test_tombstone("tomb_b", &project_id, "artifact", "art_deleted"),
        ];

        assert!(
            validate_manifest_delete_tombstone_targets(&duplicate_target_manifest)
                .unwrap_err()
                .contains("duplicate delete tombstone targets")
        );
    }

    #[test]
    fn mobile_manifest_tombstones_reject_live_manifest_targets() {
        let source_sha256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let mut manifest = mobile_test_manifest(&project_id, source_sha256);
        let live_artifact_id = manifest.artifacts[0].artifact_id.clone();
        manifest.delete_tombstones = vec![mobile_test_tombstone(
            "tomb_live_artifact",
            &project_id,
            "artifact",
            &live_artifact_id,
        )];

        assert!(validate_manifest_delete_tombstone_targets(&manifest)
            .unwrap_err()
            .contains("live targets covered by sync delete tombstones"));
    }

    #[test]
    fn mobile_delete_tombstones_reject_blank_id_and_bad_timestamps() {
        let source_sha256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let mut blank_id = mobile_test_tombstone("", &project_id, "artifact", "art_deleted");

        assert!(validate_delete_tombstone_required_fields(&blank_id)
            .unwrap_err()
            .contains("tombstone_id must not be empty"));

        blank_id.tombstone_id = "tomb_bad_timestamp".to_string();
        blank_id.deleted_at = "not a timestamp".to_string();
        assert!(validate_delete_tombstone_required_fields(&blank_id)
            .unwrap_err()
            .contains("deleted_at must be an ISO-8601 timestamp"));

        let mut bad_created_at =
            mobile_test_tombstone("tomb_bad_created", &project_id, "artifact", "art_deleted");
        bad_created_at.created_at = "not a timestamp".to_string();
        assert!(validate_delete_tombstone_required_fields(&bad_created_at)
            .unwrap_err()
            .contains("created_at must be an ISO-8601 timestamp"));

        let mut bad_updated_at =
            mobile_test_tombstone("tomb_bad_updated", &project_id, "artifact", "art_deleted");
        bad_updated_at.updated_at = "not a timestamp".to_string();
        assert!(validate_delete_tombstone_required_fields(&bad_updated_at)
            .unwrap_err()
            .contains("updated_at must be an ISO-8601 timestamp"));
    }

    #[test]
    fn mobile_apply_scope_filters_plan_inputs_before_planning() {
        let selected_hash = "dededededededededededededededededededededededededededededededede";
        let unselected_hash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let selected_project_id = source_hash_to_project_id(selected_hash).unwrap();
        let unselected_project_id = source_hash_to_project_id(unselected_hash).unwrap();
        let selected_manifest = mobile_test_manifest(&selected_project_id, selected_hash);
        let unselected_manifest = mobile_test_manifest(&unselected_project_id, unselected_hash);
        let payload = SyncReconciliationApplyRequest {
            remote_library: SyncReconciliationRemoteLibrarySchema {
                projects: vec![
                    SyncMetadataProjectSchema {
                        project_id: selected_project_id.clone(),
                        display_name: "Selected".to_string(),
                        source_key_override: None,
                        source_sha256: Some(selected_hash.to_string()),
                        duration_seconds: None,
                        sample_rate: None,
                        channels: None,
                        created_at: "2026-05-22T12:00:00.000Z".to_string(),
                        updated_at: "2026-05-22T12:00:00.000Z".to_string(),
                    },
                    SyncMetadataProjectSchema {
                        project_id: unselected_project_id.clone(),
                        display_name: "Unselected".to_string(),
                        source_key_override: None,
                        source_sha256: Some(unselected_hash.to_string()),
                        duration_seconds: None,
                        sample_rate: None,
                        channels: None,
                        created_at: "2026-05-22T12:00:00.000Z".to_string(),
                        updated_at: "2026-05-22T12:00:00.000Z".to_string(),
                    },
                ],
                artifacts: Vec::new(),
                entity_revisions: vec![
                    selected_manifest.entity_revisions[0].clone(),
                    unselected_manifest.entity_revisions[0].clone(),
                ],
                delete_tombstones: vec![
                    mobile_test_tombstone(
                        "tomb_selected",
                        &selected_project_id,
                        "artifact",
                        "art_deleted_selected",
                    ),
                    mobile_test_tombstone(
                        "tomb_unselected",
                        &unselected_project_id,
                        "artifact",
                        "art_deleted_unselected",
                    ),
                ],
            },
            project_manifests: vec![selected_manifest, unselected_manifest],
            peer_inventory: Vec::new(),
            staging_root: None,
            use_content_addressed_staging: true,
            project_ids: vec![selected_project_id.clone()],
            include_timing_evidence: false,
        };

        let scoped_project_ids = scoped_apply_project_ids(&payload);
        let scoped_remote =
            scoped_remote_library_for_project_ids(&payload.remote_library, &scoped_project_ids);
        let scoped_manifests = scoped_project_manifests_for_project_ids(
            &payload.project_manifests,
            &scoped_project_ids,
        );

        assert_eq!(scoped_remote.projects.len(), 1);
        assert_eq!(scoped_remote.projects[0].project_id, selected_project_id);
        assert_eq!(scoped_remote.entity_revisions.len(), 1);
        assert_eq!(
            scoped_remote.entity_revisions[0].project_id,
            selected_project_id
        );
        assert_eq!(scoped_remote.delete_tombstones.len(), 1);
        assert_eq!(
            scoped_remote.delete_tombstones[0].project_id,
            selected_project_id
        );
        assert_eq!(scoped_manifests.len(), 1);
        assert_eq!(scoped_manifests[0].project.project_id, selected_project_id);
    }

    #[test]
    fn mobile_effective_tombstones_suppress_project_and_artifact_import_targets() {
        let source_sha256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let project_id = source_hash_to_project_id(source_sha256).unwrap();
        let manifest = mobile_test_manifest(&project_id, source_sha256);
        let artifact_id = manifest.artifacts[0].artifact_id.clone();
        let mut targets = std::collections::HashSet::new();

        add_effective_tombstone_target(
            &mut targets,
            &mobile_test_tombstone("tomb_project", &project_id, "project", &project_id),
        );
        assert!(sync_target_is_tombstoned(
            &targets,
            "project",
            &project_id,
            &project_id,
        ));
        assert!(sync_target_is_tombstoned(
            &targets,
            "artifact",
            &artifact_id,
            &project_id,
        ));

        targets.clear();
        add_effective_tombstone_target(
            &mut targets,
            &mobile_test_tombstone("tomb_artifact", &project_id, "artifact", &artifact_id),
        );
        let (artifact_ids, revision_ids) =
            manifest_live_targets_covered_by_tombstones(&manifest, &targets);
        assert_eq!(artifact_ids, vec![artifact_id]);
        assert!(revision_ids.is_empty());
    }

    #[test]
    fn mobile_stale_tombstone_filter_detects_newer_live_target_timestamp() {
        assert!(sync_timestamp_is_newer(
            "2026-01-02T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        ));
        assert!(!sync_timestamp_is_newer(
            "2026-01-01T00:00:00.000Z",
            "2026-01-02T00:00:00.000Z",
        ));
    }

    #[test]
    fn mobile_cancel_uses_contract_job_status_spelling() {
        assert_eq!(MOBILE_CANCELLED_JOB_STATUS, "cancelled");
    }

    #[test]
    fn mobile_lyrics_language_override_normalizes_auto_values() {
        assert_eq!(payload_lyrics_language_override(&json!({})).unwrap(), None);
        assert_eq!(
            payload_lyrics_language_override(&json!({"language_override": null})).unwrap(),
            None
        );
        assert_eq!(
            payload_lyrics_language_override(&json!({"language_override": "   "})).unwrap(),
            None
        );
    }

    #[test]
    fn mobile_lyrics_language_override_accepts_curated_codes() {
        assert_eq!(
            payload_lyrics_language_override(&json!({"language_override": "none"})).unwrap(),
            Some("none".to_string())
        );
        assert_eq!(
            payload_lyrics_language_override(&json!({"language_override": " PT "})).unwrap(),
            Some("pt".to_string())
        );
        assert_eq!(
            payload_lyrics_language_override(&json!({"language_override": "zh"})).unwrap(),
            Some("zh".to_string())
        );
    }

    #[test]
    fn mobile_lyrics_language_override_rejects_bad_values() {
        assert!(
            payload_lyrics_language_override(&json!({"language_override": "ru"}))
                .unwrap_err()
                .contains("language_override must be null or one of")
        );
        assert!(
            payload_lyrics_language_override(&json!({"language_override": 7}))
                .unwrap_err()
                .contains("language_override must be a string or null")
        );
    }

    #[test]
    fn mobile_lyrics_none_override_uses_instrumental_contract_metadata() {
        let (backend, source_kind, requested_device, device, model_name) =
            no_lyrics_transcript_metadata();

        assert_eq!(backend, "none");
        assert_eq!(source_kind, "instrumental");
        assert_eq!(requested_device, None);
        assert_eq!(device, None);
        assert_eq!(model_name, None);
    }

    #[test]
    fn mobile_sync_defaults_match_local_project_contract() {
        assert_eq!(MOBILE_DB_VERSION, 3);
        assert!(sync_editable(DEFAULT_SYNC_STATUS));
        assert!(!sync_editable("remote_available"));
        assert!(!sync_editable("conflicted"));
        assert!(require_sync_editable_status(DEFAULT_SYNC_STATUS).is_ok());
        assert!(require_sync_editable_status("remote_available")
            .unwrap_err()
            .contains("locked by sync status"));
    }

    #[test]
    fn mobile_sync_list_json_matches_desktop_string_list_semantics() {
        assert_eq!(
            string_list_from_json(r#"["art_a", 42, "art_b", null, ""]"#),
            vec!["art_a".to_string(), "art_b".to_string(), "".to_string()]
        );
        assert!(string_list_from_json("{}").is_empty());
        assert!(string_list_from_json("not json").is_empty());
    }

    #[test]
    fn mobile_sync_source_hash_maps_to_canonical_project_id() {
        let hash = "ABCDEFabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123";
        assert_eq!(
            normalize_sha256(hash, "source_sha256").unwrap(),
            "abcdefabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123"
        );
        assert_eq!(
            source_hash_to_project_id(hash).unwrap(),
            "proj_sha256_abcdefabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123"
        );
        assert!(source_hash_to_project_id("not-a-sha").is_err());
    }

    #[test]
    fn mobile_sync_project_ids_must_be_canonical_for_paths_and_placeholders() {
        let source_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let canonical_project_id = source_hash_to_project_id(source_sha256).unwrap();

        assert_eq!(
            validate_project_source_identity(&canonical_project_id, Some(source_sha256)).unwrap(),
            canonical_project_id
        );
        assert!(validate_canonical_project_id("../escape").is_err());
        assert!(validate_canonical_project_id(
            "proj_sha256_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
        .is_err());
        assert!(validate_project_source_identity(
            "proj_sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        )
        .is_err());
    }

    #[test]
    fn mobile_sync_relative_paths_reject_escape_forms() {
        assert_eq!(
            safe_sync_relative_path_parts("analysis/chords.json").unwrap(),
            vec!["analysis".to_string(), "chords.json".to_string()]
        );
        assert!(safe_sync_relative_path_parts("../escape.wav").is_err());
        assert!(safe_sync_relative_path_parts("/absolute.wav").is_err());
        assert!(safe_sync_relative_path_parts("source\\escape.wav").is_err());
        assert!(safe_sync_relative_path_parts("source//escape.wav").is_err());
        assert!(safe_sync_relative_path_parts("source/./escape.wav").is_err());
        assert!(safe_sync_relative_path_parts("source/\0escape.wav").is_err());
    }

    #[test]
    fn mobile_sync_staging_path_is_content_addressed() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            sync_staging_relative_path(hash).unwrap(),
            "sha256/01/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn mobile_sync_tombstone_identity_requires_group_and_active_author() {
        let trusted = vec!["peer-a".to_string()];

        assert!(validate_remote_tombstone_identity(
            "group-a",
            "peer-a",
            "group-a",
            "local-device",
            &trusted,
        )
        .is_ok());
        assert!(validate_remote_tombstone_identity(
            "group-a",
            "local-device",
            "group-a",
            "local-device",
            &trusted,
        )
        .is_ok());
        assert!(validate_remote_tombstone_identity(
            "group-b",
            "peer-a",
            "group-a",
            "local-device",
            &trusted,
        )
        .unwrap_err()
        .contains("different sync group"));
        assert!(validate_remote_tombstone_identity(
            "group-a",
            "revoked-peer",
            "group-a",
            "local-device",
            &trusted,
        )
        .unwrap_err()
        .contains("active trusted peer"));
    }

    #[test]
    fn mobile_transport_handshake_signing_uses_canonical_proof_shape() {
        let now = Utc
            .with_ymd_and_hms(2026, 5, 22, 12, 0, 1)
            .single()
            .unwrap();
        let challenge = json!({
            "protocol_version": SYNC_PAIRING_PROTOCOL_VERSION,
            "challenge_type": "transport_handshake",
            "session_id": "session-transport-0001",
            "challenge_nonce": "nonce-transport-0000000000000001",
            "requester_device_id": "dev_peer",
            "responder_device_id": "dev_local",
            "issued_at": "2026-05-22T12:00:00+00:00",
            "expires_at": "2026-05-22T12:01:00+00:00",
            "ignored": "not signed",
        });

        let canonical =
            canonical_transport_handshake_challenge(&challenge, "dev_local", "dev_peer", now)
                .unwrap();
        let canonical_json = transport_handshake_challenge_json(&canonical).unwrap();
        let proof = transport_handshake_proof_value(
            "dev_local",
            "dev_peer",
            "public-key",
            canonical,
            canonical_json.clone(),
            "signature".to_string(),
            now,
        );

        assert_eq!(
            canonical_json,
            r#"{"challenge_nonce":"nonce-transport-0000000000000001","challenge_type":"transport_handshake","expires_at":"2026-05-22T12:01:00+00:00","issued_at":"2026-05-22T12:00:00+00:00","protocol_version":"tuneforge-sync-v1","requester_device_id":"dev_peer","responder_device_id":"dev_local","session_id":"session-transport-0001"}"#
        );
        assert_eq!(proof["protocol_version"], SYNC_PAIRING_PROTOCOL_VERSION);
        assert_eq!(proof["challenge_type"], "transport_handshake");
        assert_eq!(proof["local_device_id"], "dev_local");
        assert_eq!(proof["peer_device_id"], "dev_peer");
        assert_eq!(proof["public_key"], "public-key");
        assert_eq!(proof["canonical_challenge_json"], canonical_json);
        assert_eq!(proof["signature"], "signature");
        assert_eq!(proof["signed_at"], "2026-05-22T12:00:01+00:00");
        assert!(proof["challenge"].get("ignored").is_none());
    }

    #[test]
    fn mobile_transport_handshake_rejects_unknown_peer_and_foreign_challenge() {
        assert!(validate_transport_trusted_peer(None, "sync_group_a")
            .unwrap_err()
            .contains("active trusted peer"));

        let revoked_peer = SyncTrustedPeerSchema {
            device_id: "dev_peer".to_string(),
            sync_group_id: "sync_group_a".to_string(),
            display_name: Some("Peer".to_string()),
            public_key: "public-key".to_string(),
            endpoint_hints: Vec::new(),
            trusted_at: "2026-05-22T12:00:00+00:00".to_string(),
            revoked_at: Some("2026-05-22T12:00:00+00:00".to_string()),
            updated_at: Some("2026-05-22T12:00:00+00:00".to_string()),
        };
        assert!(
            validate_transport_trusted_peer(Some(&revoked_peer), "sync_group_a")
                .unwrap_err()
                .contains("active trusted peer")
        );

        let now = Utc
            .with_ymd_and_hms(2026, 5, 22, 12, 0, 1)
            .single()
            .unwrap();
        let challenge = json!({
            "protocol_version": SYNC_PAIRING_PROTOCOL_VERSION,
            "challenge_type": "transport_handshake",
            "session_id": "session-transport-0001",
            "challenge_nonce": "nonce-transport-0000000000000001",
            "requester_device_id": "dev_peer",
            "responder_device_id": "dev_foreign",
            "issued_at": "2026-05-22T12:00:00+00:00",
            "expires_at": "2026-05-22T12:01:00+00:00",
        });

        assert!(
            canonical_transport_handshake_challenge(&challenge, "dev_local", "dev_peer", now,)
                .unwrap_err()
                .contains("local device")
        );
    }

    #[test]
    fn mobile_sync_placeholder_state_allows_only_metadata_placeholders() {
        for status in ["remote_available", "syncing", "missing", "downloading"] {
            assert!(is_sync_placeholder_state(status, "", ""));
            assert!(is_sync_placeholder_state(
                status,
                "sync-placeholder:proj_sha256_a",
                "sync-placeholder:proj_sha256_a",
            ));
            assert!(!is_sync_placeholder_state(
                status,
                "/tmp/source.wav",
                "/tmp/source.wav",
            ));
        }

        for status in [DEFAULT_SYNC_STATUS, "conflicted", "deleted"] {
            assert!(!is_sync_placeholder_state(status, "", ""));
            assert!(!is_sync_placeholder_state(
                status,
                "sync-placeholder:proj_sha256_a",
                "sync-placeholder:proj_sha256_a",
            ));
        }
        assert!(!is_sync_placeholder_state(
            "remote_available",
            "",
            "sync-placeholder:proj_sha256_a",
        ));
        assert!(!is_sync_placeholder_state(
            "remote_available",
            "sync-placeholder:proj_sha256_a",
            "sync-placeholder:proj_sha256_b",
        ));
    }

    #[test]
    fn mobile_sync_legacy_project_cleanup_component_rejects_path_escape() {
        assert_eq!(
            safe_legacy_project_id_component("proj_legacy_123").unwrap(),
            "proj_legacy_123"
        );
        assert!(safe_legacy_project_id_component("../escape").is_err());
        assert!(safe_legacy_project_id_component("nested/project").is_err());
        assert!(safe_legacy_project_id_component("source\\escape").is_err());
        assert!(safe_legacy_project_id_component(".").is_err());
    }

    #[test]
    fn mobile_sync_manifest_sanitizer_removes_paths_and_transport_internals() {
        let payload = json!({
            "label": "Verse",
            "source_path": "/Users/example/source.wav",
            "metadata": {
                "color": "blue",
                "absolutePath": "C:\\Users\\example\\source.wav",
                "endpoint_hints": ["tuneforge-sync+iroh://peer"],
                "transport_state": {"iroh_endpoint": "iroh://peer"},
                "notes": ["keep", "/tmp/leak.txt"]
            }
        });

        let sanitized = sanitize_sync_manifest_value(&payload);

        assert_eq!(sanitized["label"], "Verse");
        assert_eq!(sanitized["metadata"]["color"], "blue");
        assert!(sanitized.get("source_path").is_none());
        assert!(sanitized["metadata"].get("absolutePath").is_none());
        assert!(sanitized["metadata"].get("endpoint_hints").is_none());
        assert!(sanitized["metadata"].get("transport_state").is_none());
        assert_eq!(sanitized["metadata"]["notes"], json!(["keep"]));

        let prior_metadata = json!({
            "display_name": "Deleted Project",
            "source_path": "/Users/example/source.wav",
            "endpoint_hints": ["tuneforge-sync+iroh://peer"]
        });
        let sanitized_prior_metadata = sanitize_sync_manifest_value(&prior_metadata);
        assert_eq!(sanitized_prior_metadata["display_name"], "Deleted Project");
        assert!(sanitized_prior_metadata.get("source_path").is_none());
        assert!(sanitized_prior_metadata.get("endpoint_hints").is_none());
    }
}
