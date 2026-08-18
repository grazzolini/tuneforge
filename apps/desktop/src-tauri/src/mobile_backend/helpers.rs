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
const ACTION_APPLY_DELETE_TOMBSTONE: &str = "apply_delete_tombstone";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_IMPORT_PROJECT_MANIFEST: &str = "import_project_manifest";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_IMPORT_ENTITY_REVISION: &str = "import_entity_revision";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_FETCH_ARTIFACT_CONTENT: &str = "fetch_artifact_content";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_IMPORT_ARTIFACT_MANIFEST: &str = "import_artifact_manifest";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_UPSERT_PROJECT_STATUS: &str = "upsert_project_status";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_RECORD_CONFLICT: &str = "record_conflict";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ACTION_NOOP: &str = "noop";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const STALE_LIVE_TOMBSTONE_NOOP_REASON: &str =
    "Delete tombstone is older than or equal to a live sync target.";

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn action_priority(action_type: &str) -> i64 {
    match action_type {
        ACTION_APPLY_DELETE_TOMBSTONE => 0,
        ACTION_RECORD_CONFLICT => 10,
        ACTION_UPSERT_PROJECT_STATUS => 15,
        ACTION_FETCH_ARTIFACT_CONTENT => 20,
        ACTION_IMPORT_PROJECT_MANIFEST => 30,
        ACTION_IMPORT_ARTIFACT_MANIFEST => 40,
        ACTION_IMPORT_ENTITY_REVISION => 50,
        ACTION_NOOP => 100,
        _ => 100,
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn plan_delete_tombstone_branch(
    tombstone: &SyncDeleteTombstoneSchema,
    superseded_by_live_target: bool,
) -> (
    SyncReconciliationItemSchema,
    Vec<SyncReconciliationActionSchema>,
    bool,
) {
    let target_type = normalize_tombstone_target_type(&tombstone.target_type);
    if superseded_by_live_target {
        return (
            SyncReconciliationItemSchema {
                item_type: target_type,
                item_id: tombstone.target_id.clone(),
                project_id: Some(tombstone.project_id.clone()),
                status: "noop".to_string(),
                action_type: Some(ACTION_NOOP.to_string()),
                content_sha256: None,
                chosen_provider_device_id: None,
                reason: Some(STALE_LIVE_TOMBSTONE_NOOP_REASON.to_string()),
                details: serde_json::json!({"tombstone_id": tombstone.tombstone_id}),
            },
            Vec::new(),
            false,
        );
    }

    let item = SyncReconciliationItemSchema {
        item_type: target_type.clone(),
        item_id: tombstone.target_id.clone(),
        project_id: Some(tombstone.project_id.clone()),
        status: "deleted".to_string(),
        action_type: Some(ACTION_APPLY_DELETE_TOMBSTONE.to_string()),
        content_sha256: None,
        chosen_provider_device_id: None,
        reason: Some("A valid delete tombstone wins over remote manifests.".to_string()),
        details: serde_json::json!({"tombstone_id": tombstone.tombstone_id}),
    };
    let action = SyncReconciliationActionSchema {
        action_type: ACTION_APPLY_DELETE_TOMBSTONE.to_string(),
        item_type: target_type,
        item_id: tombstone.target_id.clone(),
        project_id: Some(tombstone.project_id.clone()),
        content_sha256: None,
        provider_device_id: None,
        reason: Some("Apply valid sync delete tombstone before imports or fetches.".to_string()),
        priority: action_priority(ACTION_APPLY_DELETE_TOMBSTONE),
        details: serde_json::json!({"tombstone_id": tombstone.tombstone_id}),
    };
    (item, vec![action], true)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sync_timestamp_is_newer_or_equal(live_at: &str, deleted_at: &str) -> bool {
    let Ok(live_at) = parse_sync_timestamp_utc(live_at, "live_at") else {
        return false;
    };
    let Ok(deleted_at) = parse_sync_timestamp_utc(deleted_at, "deleted_at") else {
        return false;
    };
    live_at >= deleted_at
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_sync_timestamp_utc(
    value: &str,
    field_name: &str,
) -> Result<chrono::DateTime<chrono::Utc>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field_name} must be an ISO-8601 timestamp."));
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&chrono::Utc));
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f%:z") {
        return Ok(parsed.with_timezone(&chrono::Utc));
    }
    if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Ok(parsed.and_utc());
    }
    let sqlite_utc = value
        .strip_suffix(" UTC")
        .or_else(|| value.strip_suffix(" utc"))
        .unwrap_or(value);
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(sqlite_utc, "%Y-%m-%d %H:%M:%S%.f"))
        .map(|parsed| parsed.and_utc())
        .map_err(|_| format!("{field_name} must be an ISO-8601 timestamp."))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn format_sync_timestamp_utc(value: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::Timelike as _;

    let normalized = value
        .with_nanosecond(value.timestamp_subsec_micros() * 1_000)
        .unwrap_or(value);
    normalized.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn normalize_sync_timestamp_utc(value: &str, field_name: &str) -> Result<String, String> {
    parse_sync_timestamp_utc(value, field_name).map(format_sync_timestamp_utc)
}

fn deserialize_sync_timestamp<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    normalize_sync_timestamp_utc(&value, "timestamp").map_err(serde::de::Error::custom)
}

fn deserialize_optional_sync_timestamp<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    value
        .map(|inner| normalize_sync_timestamp_utc(&inner, "timestamp"))
        .transpose()
        .map_err(serde::de::Error::custom)
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
        parse_sync_timestamp_utc(value, field_name).map_err(|_| {
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

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct MobileChordRevisionPayload {
    backend: String,
    source_artifact_id: Option<String>,
    source_segments: Vec<Value>,
    segments: Vec<Value>,
    timeline: Vec<Value>,
    source_kind: String,
    metadata: Value,
    has_user_edits: bool,
    created_at: String,
    updated_at: String,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct MobileLyricsRevisionPayload {
    backend: String,
    source_artifact_id: Option<String>,
    source_kind: String,
    requested_device: Option<String>,
    device: Option<String>,
    model_name: Option<String>,
    language: Option<String>,
    language_override: Option<String>,
    source_segments: Vec<Value>,
    segments: Vec<Value>,
    has_user_edits: bool,
    created_at: String,
    updated_at: String,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct MobileAnalysisArtifactPayload {
    project_id: Option<String>,
    source_artifact_id: Option<String>,
    estimated_key: Option<String>,
    key_confidence: Option<f64>,
    estimated_reference_hz: Option<f64>,
    tuning_offset_cents: Option<f64>,
    tempo_bpm: Option<f64>,
    timing: Option<Value>,
    analysis_version: String,
    created_at: Option<String>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn require_payload_object<'a>(
    payload: &'a Value,
    context: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    payload
        .as_object()
        .ok_or_else(|| format!("{context} payload must be an object."))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_first<'a>(payload: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| payload.get(*name))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_optional_string_field(
    payload: &Value,
    name: &str,
    context: &str,
) -> Result<Option<String>, String> {
    require_payload_object(payload, context)?;
    match payload.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{context} field must be a string or null: {name}.")),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_optional_float_field(
    payload: &Value,
    name: &str,
    context: &str,
) -> Result<Option<f64>, String> {
    require_payload_object(payload, context)?;
    match payload.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| format!("{context} field must be numeric or null: {name}.")),
        Some(_) => Err(format!("{context} field must be numeric or null: {name}.")),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_bool_field(
    payload: &Value,
    name: &str,
    default: bool,
    context: &str,
) -> Result<bool, String> {
    require_payload_object(payload, context)?;
    match payload.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!(
            "{context} field must be a boolean or null: {name}."
        )),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_bool_field_with_missing_default(
    payload: &Value,
    name: &str,
    default: bool,
    context: &str,
) -> Result<bool, String> {
    require_payload_object(payload, context)?;
    match payload.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("{context} field must be a boolean: {name}.")),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_optional_timestamp_string(
    payload: &Value,
    name: &str,
    context: &str,
) -> Result<Option<String>, String> {
    let value = payload_optional_string_field(payload, name, context)?;
    value
        .map(|value| normalize_sync_timestamp_utc(&value, name))
        .transpose()
        .map_err(|_| format!("{context} field must be an ISO-8601 timestamp: {name}."))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_list_field(
    payload: &Value,
    names: &[&str],
    default: Option<Vec<Value>>,
    context: &str,
) -> Result<Vec<Value>, String> {
    require_payload_object(payload, context)?;
    let value = payload_first(payload, names);
    let Some(value) = value else {
        return Ok(default.unwrap_or_default());
    };
    let Some(values) = value.as_array() else {
        return Err(format!(
            "{context} field must be a list of objects: {}.",
            names[0]
        ));
    };
    if values.iter().any(|item| !item.is_object()) {
        return Err(format!(
            "{context} field must be a list of objects: {}.",
            names[0]
        ));
    }
    Ok(values.clone())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_mapping_field(
    payload: &Value,
    names: &[&str],
    default: Option<Value>,
    context: &str,
) -> Result<Value, String> {
    require_payload_object(payload, context)?;
    let value = payload_first(payload, names);
    let Some(value) = value else {
        return Ok(default.unwrap_or_else(|| serde_json::json!({})));
    };
    if !value.is_object() {
        return Err(format!("{context} field must be an object: {}.", names[0]));
    }
    Ok(value.clone())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_chord_revision_payload(
    revision: &SyncProjectManifestEntityRevisionSchema,
) -> Result<MobileChordRevisionPayload, String> {
    let context = "Chord entity revision payload";
    let segments = payload_list_field(
        &revision.payload,
        &["segments", "segments_json", "timeline"],
        None,
        context,
    )?;
    let timeline = payload_list_field(
        &revision.payload,
        &["timeline", "timeline_json"],
        Some(segments.clone()),
        context,
    )?;
    Ok(MobileChordRevisionPayload {
        backend: payload_optional_string_field(&revision.payload, "backend", context)?
            .unwrap_or_else(|| "default".to_string()),
        source_artifact_id: payload_optional_string_field(
            &revision.payload,
            "source_artifact_id",
            context,
        )?
        .or_else(|| revision.source_artifact_id.clone()),
        source_segments: payload_list_field(
            &revision.payload,
            &["source_segments", "source_segments_json"],
            None,
            context,
        )?,
        segments,
        timeline,
        source_kind: payload_optional_string_field(&revision.payload, "source_kind", context)?
            .unwrap_or_else(|| "generated".to_string()),
        metadata: payload_mapping_field(
            &revision.payload,
            &["metadata", "metadata_json"],
            Some(revision.metadata.clone()),
            context,
        )?,
        has_user_edits: payload_bool_field(&revision.payload, "has_user_edits", false, context)?,
        created_at: payload_optional_timestamp_string(&revision.payload, "created_at", context)?
            .unwrap_or_else(|| revision.created_at.clone()),
        updated_at: payload_optional_timestamp_string(&revision.payload, "updated_at", context)?
            .unwrap_or_else(|| revision.updated_at.clone()),
    })
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_lyrics_revision_payload(
    revision: &SyncProjectManifestEntityRevisionSchema,
) -> Result<MobileLyricsRevisionPayload, String> {
    let context = "Lyrics entity revision payload";
    Ok(MobileLyricsRevisionPayload {
        backend: payload_optional_string_field(&revision.payload, "backend", context)?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "openai-whisper".to_string()),
        source_artifact_id: payload_optional_string_field(
            &revision.payload,
            "source_artifact_id",
            context,
        )?
        .filter(|value| !value.is_empty())
        .or_else(|| revision.source_artifact_id.clone()),
        source_kind: payload_optional_string_field(&revision.payload, "source_kind", context)?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "ai".to_string()),
        requested_device: payload_optional_string_field(
            &revision.payload,
            "requested_device",
            context,
        )?,
        device: payload_optional_string_field(&revision.payload, "device", context)?,
        model_name: payload_optional_string_field(&revision.payload, "model_name", context)?,
        language: payload_optional_string_field(&revision.payload, "language", context)?,
        language_override: payload_lyrics_language_override(&revision.payload)?,
        source_segments: payload_list_field(
            &revision.payload,
            &["source_segments", "source_segments_json"],
            None,
            context,
        )?,
        segments: payload_list_field(
            &revision.payload,
            &["segments", "segments_json"],
            None,
            context,
        )?,
        has_user_edits: payload_bool_field_with_missing_default(
            &revision.payload,
            "has_user_edits",
            false,
            context,
        )?,
        created_at: payload_optional_timestamp_string(&revision.payload, "created_at", context)?
            .unwrap_or_else(|| revision.created_at.clone()),
        updated_at: payload_optional_timestamp_string(&revision.payload, "updated_at", context)?
            .unwrap_or_else(|| revision.updated_at.clone()),
    })
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mobile_analysis_artifact_payload(
    payload: &Value,
    artifact_metadata: &Value,
) -> Result<MobileAnalysisArtifactPayload, String> {
    let context = "Analysis artifact";
    Ok(MobileAnalysisArtifactPayload {
        project_id: payload_optional_string_field(payload, "project_id", context)?,
        source_artifact_id: payload_optional_string_field(payload, "source_artifact_id", context)?,
        estimated_key: payload_optional_string_field(payload, "estimated_key", context)?,
        key_confidence: payload_optional_float_field(payload, "key_confidence", context)?,
        estimated_reference_hz: payload_optional_float_field(
            payload,
            "estimated_reference_hz",
            context,
        )?,
        tuning_offset_cents: payload_optional_float_field(payload, "tuning_offset_cents", context)?,
        tempo_bpm: payload_optional_float_field(payload, "tempo_bpm", context)?,
        timing: match payload.get("timing") {
            None | Some(Value::Null) => None,
            Some(Value::Object(_)) => {
                Some(payload_mapping_field(payload, &["timing"], None, context)?)
            }
            Some(_) => {
                return Err("Analysis artifact field must be an object or null: timing.".to_string())
            }
        },
        analysis_version: payload_optional_string_field(payload, "analysis_version", context)?
            .or_else(|| {
                artifact_metadata
                    .get("analysis_version")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "v3".to_string()),
        created_at: payload_optional_timestamp_string(payload, "created_at", context)?,
    })
}

#[cfg(any(target_os = "android", test))]
fn mobile_lyrics_response(
    connection: &rusqlite::Connection,
    project_id: String,
) -> Result<LyricsResponse, String> {
    use rusqlite::OptionalExtension;

    connection
        .query_row(
            "SELECT project_id, backend, source_artifact_id, source_kind, requested_device, device, model_name, language, language_override, source_segments_json, segments_json, has_user_edits, created_at, updated_at FROM lyrics_transcripts WHERE project_id = ?1",
            rusqlite::params![project_id],
            |row| {
                let source_segments_raw: String = row.get(9)?;
                let segments_raw: String = row.get(10)?;
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
                    language_override: row.get(8)?,
                    source_segments,
                    segments,
                    has_user_edits: row.get::<_, i64>(11)? != 0,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(Ok)
        .unwrap_or_else(|| {
            Ok(LyricsResponse {
                project_id,
                backend: None,
                source_artifact_id: None,
                source_kind: None,
                requested_device: None,
                device: None,
                model_name: None,
                language: None,
                language_override: None,
                source_segments: Vec::new(),
                segments: Vec::new(),
                has_user_edits: false,
                created_at: None,
                updated_at: None,
            })
        })
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
            stage: None,
            stage_label: None,
            source_artifact_id: None,
            result_artifact_ids: Vec::new(),
            chord_backend: None,
            chord_backend_fallback_from: None,
            chord_source: None,
            error_message: None,
            runtime_device: None,
            runtime_detail: None,
            started_at: started_at.map(ToString::to_string),
            completed_at: completed_at.map(ToString::to_string),
            duration_seconds: None,
            export_result: None,
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

    #[cfg(not(target_os = "android"))]
    fn mobile_storage_contract_root(slug: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "tuneforge-mobile-storage-{slug}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[cfg(not(target_os = "android"))]
    fn write_mobile_contract_file(path: &std::path::Path, bytes: &[u8]) -> (String, i64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
        (storage::file_sha256(path).unwrap(), bytes.len() as i64)
    }

    #[cfg(not(target_os = "android"))]
    fn insert_mobile_contract_project(
        connection: &Connection,
        project_id: &str,
        source_sha256: &str,
        source_path: &std::path::Path,
    ) {
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, sync_status_reason, sync_required_artifact_ids_json, sync_provider_device_ids_json, sync_conflict_count, sync_status_updated_at, created_at, updated_at)
                 VALUES (?1, 'Desktop Sync Fixture', '2:major', ?2, ?3, ?3, 187.25, 48000, 2, 'local', NULL, '[]', '[]', 0, ?4, ?4, ?4)",
                rusqlite::params![
                    project_id,
                    source_sha256,
                    source_path.to_string_lossy().into_owned(),
                    "2026-05-22T12:00:00.000Z",
                ],
            )
            .unwrap();
    }

    #[cfg(not(target_os = "android"))]
    struct MobileContractArtifact<'a> {
        artifact_id: &'a str,
        project_id: &'a str,
        artifact_type: &'a str,
        format: &'a str,
        path: &'a std::path::Path,
        content_sha256: &'a str,
        size_bytes: i64,
        generated_by: &'a str,
        can_delete: bool,
        can_regenerate: bool,
        cache_key: Option<&'a str>,
        metadata: Value,
    }

    #[cfg(not(target_os = "android"))]
    fn insert_mobile_contract_artifact(
        connection: &Connection,
        artifact: MobileContractArtifact<'_>,
    ) {
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    artifact.artifact_id,
                    artifact.project_id,
                    artifact.artifact_type,
                    artifact.format,
                    artifact.path.to_string_lossy().into_owned(),
                    artifact.content_sha256,
                    artifact.size_bytes,
                    artifact.generated_by,
                    if artifact.can_delete { 1_i64 } else { 0_i64 },
                    if artifact.can_regenerate { 1_i64 } else { 0_i64 },
                    artifact.metadata.to_string(),
                    artifact.cache_key,
                    "2026-05-22T12:00:00.000Z",
                ],
            )
            .unwrap();
    }

    #[cfg(not(target_os = "android"))]
    fn insert_mobile_contract_revision(
        connection: &Connection,
        revision: &SyncProjectManifestEntityRevisionSchema,
    ) {
        connection
            .execute(
                "INSERT INTO sync_entity_revisions (id, project_id, entity_type, entity_id, revision_type, base_revision_id, author_device_id, source_artifact_id, content_sha256, state, metadata_json, payload_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                rusqlite::params![
                    &revision.revision_id,
                    &revision.project_id,
                    &revision.entity_type,
                    &revision.entity_id,
                    &revision.revision_type,
                    revision.base_revision_id.as_ref(),
                    &revision.author_device_id,
                    revision.source_artifact_id.as_ref(),
                    &revision.content_sha256,
                    &revision.state,
                    revision.metadata.to_string(),
                    revision.payload.to_string(),
                    &revision.created_at,
                    &revision.updated_at,
                ],
            )
            .unwrap();
    }

    #[cfg(not(target_os = "android"))]
    fn mobile_contract_revision(
        revision_id: &str,
        project_id: &str,
        entity_type: &str,
        revision_type: &str,
        content_sha256: &str,
        metadata: Value,
        payload: Value,
    ) -> SyncProjectManifestEntityRevisionSchema {
        SyncProjectManifestEntityRevisionSchema {
            revision_id: revision_id.to_string(),
            project_id: project_id.to_string(),
            entity_type: entity_type.to_string(),
            entity_id: project_id.to_string(),
            revision_type: revision_type.to_string(),
            base_revision_id: None,
            author_device_id: "device_desktop_fixture".to_string(),
            source_artifact_id: Some("art_source_audio".to_string()),
            content_sha256: content_sha256.to_string(),
            state: "active".to_string(),
            metadata,
            payload,
            created_at: "2026-05-22T12:00:00.000Z".to_string(),
            updated_at: "2026-05-22T12:00:00.000Z".to_string(),
        }
    }

    #[cfg(not(target_os = "android"))]
    fn mobile_lyrics_row_count(connection: &Connection, project_id: &str) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM lyrics_transcripts WHERE project_id = ?1",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[cfg(not(target_os = "android"))]
    fn mobile_generation_job_count(connection: &Connection, project_id: &str) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE project_id = ?1 AND type IN ('analyze', 'chords', 'lyrics')",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[cfg(not(target_os = "android"))]
    fn mobile_desktop_lyrics_payload(source_text: &str, current_text: &str) -> Value {
        json!({
            "project_id": "desktop-project",
            "backend": "whisper.cpp",
            "source_kind": "user-edited",
            "requested_device": "cpu",
            "device": "cpu",
            "model_name": "ggml-large-v3",
            "language": "en",
            "language_override": "en",
            "source_segments": [{
                "start_seconds": 0.0,
                "end_seconds": 1.25,
                "text": source_text,
                "words": [{
                    "text": source_text,
                    "start_seconds": 0.1,
                    "end_seconds": 1.0,
                    "confidence": 0.91
                }]
            }],
            "segments": [{
                "start_seconds": 0.0,
                "end_seconds": 1.25,
                "text": current_text,
                "words": [{
                    "text": current_text,
                    "start_seconds": 0.1,
                    "end_seconds": 1.0,
                    "confidence": 0.95
                }]
            }],
            "has_user_edits": source_text != current_text
        })
    }

    #[cfg(not(target_os = "android"))]
    fn mobile_lyrics_revision(
        revision_id: &str,
        project_id: &str,
        state: &str,
        source_artifact_id: Option<&str>,
        payload: Value,
    ) -> SyncProjectManifestEntityRevisionSchema {
        let content_sha256 = storage::hex_digest(&Sha256::digest(payload.to_string().as_bytes()));
        SyncProjectManifestEntityRevisionSchema {
            revision_id: revision_id.to_string(),
            project_id: project_id.to_string(),
            entity_type: "lyrics".to_string(),
            entity_id: project_id.to_string(),
            revision_type: "user_edit".to_string(),
            base_revision_id: None,
            author_device_id: "device_desktop_fixture".to_string(),
            source_artifact_id: source_artifact_id.map(ToString::to_string),
            content_sha256,
            state: state.to_string(),
            metadata: json!({"origin": "desktop"}),
            payload,
            created_at: "2026-05-22T12:03:00Z".to_string(),
            updated_at: "2026-05-22T12:04:00Z".to_string(),
        }
    }

    #[cfg(not(target_os = "android"))]
    fn mobile_lyrics_import_fixture(
        slug: &str,
    ) -> (
        std::path::PathBuf,
        Connection,
        String,
        SyncProjectManifestSchema,
    ) {
        let root = mobile_storage_contract_root(slug);
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = format!("tuneforge lyrics sync fixture {slug}").into_bytes();
        let source_sha256 = storage::hex_digest(&Sha256::digest(&source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let source_path = storage::project_root_path(&root, &project_id)
            .unwrap()
            .join("source")
            .join("source.wav");
        let (source_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, &source_bytes);
        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "sync",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
        );
        let manifest = SyncProjectManifestSchema {
            schema_version: SYNC_PROJECT_MANIFEST_SCHEMA_VERSION.to_string(),
            exported_at: "2026-05-22T12:05:00Z".to_string(),
            project: SyncProjectManifestProjectSchema {
                project_id: project_id.clone(),
                display_name: "Synced Lyrics".to_string(),
                source_key_override: None,
                source_sha256,
                duration_seconds: Some(12.0),
                sample_rate: Some(44_100),
                channels: Some(2),
                created_at: "2026-05-22T12:00:00Z".to_string(),
                updated_at: "2026-05-22T12:05:00Z".to_string(),
            },
            entity_revisions: Vec::new(),
            artifacts: vec![SyncProjectManifestArtifactSchema {
                artifact_id: "art_source_audio".to_string(),
                project_id: project_id.clone(),
                r#type: "source_audio".to_string(),
                format: "wav".to_string(),
                relative_path: "source/source.wav".to_string(),
                content_sha256: source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "sync".to_string(),
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
                created_at: "2026-05-22T12:00:00Z".to_string(),
            }],
            delete_tombstones: Vec::new(),
        };
        (root, connection, project_id, manifest)
    }

    #[cfg(not(target_os = "android"))]
    fn insert_mobile_contract_tombstone(connection: &Connection, project_id: &str) {
        connection
            .execute(
                "INSERT INTO sync_delete_tombstones (id, sync_group_id, project_id, target_type, target_id, author_device_id, deleted_at, prior_metadata_json, created_at, updated_at)
                 VALUES ('tomb_deleted_mix', 'sync_group_mobile_test', ?1, 'artifact', 'art_deleted_mix', 'device_desktop_fixture', ?2, ?3, ?4, ?4)",
                rusqlite::params![
                    project_id,
                    "2026-05-22T12:01:00.000Z",
                    json!({"type": "preview_mix", "stem_model": "htdemucs_ft"}).to_string(),
                    "2026-05-22T12:01:00.000Z",
                ],
            )
            .unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_storage_reads_desktop_shaped_sync_fixture() {
        let root = mobile_storage_contract_root("desktop-shaped-sync");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge deterministic source wav fixture";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        let analysis_path = project_root.join("analysis").join("analysis.json");
        let vocals_path = project_root.join("stems").join("vocals.wav");
        let drums_path = project_root.join("stems").join("drums.wav");
        let (source_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, source_bytes);
        let (analysis_sha256, analysis_size_bytes) = write_mobile_contract_file(
            &analysis_path,
            br#"{"project_id":"fixture","tempo_bpm":132.25,"timing":{"beats_per_bar":4,"source":"remote-detected","beats":[{"time_seconds":0.0,"beat_in_bar":1}],"bars":[{"index":1,"start_seconds":0.0,"end_seconds":1.75}]}}"#,
        );
        let (vocals_sha256, vocals_size_bytes) =
            write_mobile_contract_file(&vocals_path, b"deterministic vocals stem bytes");
        let (drums_sha256, drums_size_bytes) =
            write_mobile_contract_file(&drums_path, b"deterministic drums stem bytes");

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "import",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({"original_name": "desktop-fixture.wav"}),
            },
        );
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_analysis_json",
                project_id: &project_id,
                artifact_type: "analysis_json",
                format: "json",
                path: &analysis_path,
                content_sha256: &analysis_sha256,
                size_bytes: analysis_size_bytes,
                generated_by: "analysis",
                can_delete: false,
                can_regenerate: true,
                cache_key: None,
                metadata: json!({
                    "analysis_version": "v4",
                    "source_artifact_id": "art_source_audio",
                    "timing_summary": {"beats_per_bar": 4, "source": "remote-detected"}
                }),
            },
        );
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_vocals_stem",
                project_id: &project_id,
                artifact_type: "vocal_stem",
                format: "wav",
                path: &vocals_path,
                content_sha256: &vocals_sha256,
                size_bytes: vocals_size_bytes,
                generated_by: "stems",
                can_delete: true,
                can_regenerate: true,
                cache_key: Some("stem:art_source_audio:htdemucs_ft:vocals"),
                metadata: json!({
                    "source_artifact_id": "art_source_audio",
                    "stem_model": "htdemucs_ft",
                    "stem_name": "vocals",
                    "stem_signal": {
                        "active_duration_seconds": 185.0,
                        "sample_rate": 48000,
                        "channels": 2
                    }
                }),
            },
        );
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_drums_stem",
                project_id: &project_id,
                artifact_type: "drums_stem",
                format: "wav",
                path: &drums_path,
                content_sha256: &drums_sha256,
                size_bytes: drums_size_bytes,
                generated_by: "stems",
                can_delete: true,
                can_regenerate: true,
                cache_key: Some("stem:art_source_audio:htdemucs_ft:drums"),
                metadata: json!({
                    "source_artifact_id": "art_source_audio",
                    "stem_model": "htdemucs_ft",
                    "stem_name": "drums"
                }),
            },
        );

        let previous_chord_revision = SyncProjectManifestEntityRevisionSchema {
            revision_id: "rev_chords_previous".to_string(),
            state: "superseded".to_string(),
            source_artifact_id: Some("art_source_audio".to_string()),
            payload: json!({
                "project_id": project_id,
                "backend": "tuneforge-fast",
                "source_kind": "generated",
                "has_user_edits": false,
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}]
            }),
            ..mobile_contract_revision(
                "rev_chords_previous",
                &project_id,
                "chords",
                "generated",
                "1111111111111111111111111111111111111111111111111111111111111111",
                json!({}),
                json!({}),
            )
        };
        let mut current_chord_revision = mobile_contract_revision(
            "rev_chords_current",
            &project_id,
            "chords",
            "user_edit",
            "2222222222222222222222222222222222222222222222222222222222222222",
            json!({"reviewed": true, "confidence": 0.88}),
            json!({
                "project_id": project_id,
                "backend": "tuneforge-fast",
                "source_kind": "user-edited",
                "has_user_edits": true,
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Am"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Am"}]
            }),
        );
        current_chord_revision.base_revision_id = Some("rev_chords_previous".to_string());
        let lyrics_revision = mobile_contract_revision(
            "rev_lyrics_current",
            &project_id,
            "lyrics",
            "user_edit",
            "3333333333333333333333333333333333333333333333333333333333333333",
            json!({"edit_source": "desktop"}),
            json!({
                "project_id": project_id,
                "backend": "whisper.cpp",
                "source_artifact_id": "art_source_audio",
                "source_kind": "user-edited",
                "language": "en",
                "language_override": "en",
                "has_user_edits": true,
                "source_segments": [
                    {"start_seconds": 0.0, "end_seconds": 1.0, "text": "hello", "words": []}
                ],
                "segments": [
                    {"start_seconds": 0.0, "end_seconds": 1.0, "text": "hello sync", "words": []}
                ]
            }),
        );
        insert_mobile_contract_revision(&connection, &previous_chord_revision);
        insert_mobile_contract_revision(&connection, &current_chord_revision);
        insert_mobile_contract_revision(&connection, &lyrics_revision);
        insert_mobile_contract_tombstone(&connection, &project_id);

        let manifest = storage::get_project_manifest(&connection, &root, &project_id).unwrap();
        validate_sync_project_manifest_identity(&manifest).unwrap();
        let reparsed_manifest: SyncProjectManifestSchema =
            serde_json::from_value(serde_json::to_value(&manifest).unwrap()).unwrap();

        assert_eq!(reparsed_manifest.project.project_id, project_id);
        assert_eq!(reparsed_manifest.project.duration_seconds, Some(187.25));
        assert_eq!(reparsed_manifest.project.sample_rate, Some(48_000));
        assert_eq!(reparsed_manifest.project.channels, Some(2));

        let artifacts_by_id = reparsed_manifest
            .artifacts
            .iter()
            .map(|artifact| (artifact.artifact_id.as_str(), artifact))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            artifacts_by_id["art_analysis_json"].metadata["timing_summary"]["source"],
            "remote-detected"
        );
        assert_eq!(
            artifacts_by_id["art_vocals_stem"].metadata["stem_signal"]["sample_rate"],
            48_000
        );
        assert_eq!(
            artifacts_by_id["art_drums_stem"].metadata["stem_name"],
            "drums"
        );
        assert_eq!(
            artifacts_by_id["art_source_audio"].relative_path,
            "source/source.wav"
        );

        let revisions_by_id = reparsed_manifest
            .entity_revisions
            .iter()
            .map(|revision| (revision.revision_id.as_str(), revision))
            .collect::<std::collections::HashMap<_, _>>();
        let chord_revision = revisions_by_id["rev_chords_current"];
        assert_eq!(
            chord_revision.base_revision_id.as_deref(),
            Some("rev_chords_previous")
        );
        assert_eq!(chord_revision.metadata["reviewed"], true);
        assert_eq!(chord_revision.payload["source_kind"], "user-edited");
        assert_eq!(chord_revision.payload["has_user_edits"], true);
        assert_eq!(chord_revision.payload["timeline"][0]["label"], "Am");

        let lyrics_revision = revisions_by_id["rev_lyrics_current"];
        assert_eq!(lyrics_revision.payload["source_kind"], "user-edited");
        assert_eq!(lyrics_revision.payload["language_override"], "en");
        assert_eq!(lyrics_revision.payload["segments"][0]["text"], "hello sync");
        assert_eq!(lyrics_revision.metadata["edit_source"], "desktop");

        assert_eq!(reparsed_manifest.delete_tombstones.len(), 1);
        let tombstone = &reparsed_manifest.delete_tombstones[0];
        assert_eq!(tombstone.tombstone_id, "tomb_deleted_mix");
        assert_eq!(tombstone.target_type, "artifact");
        assert_eq!(tombstone.target_id, "art_deleted_mix");
        assert_eq!(tombstone.prior_metadata["stem_model"], "htdemucs_ft");

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_manifest_export_trusts_stored_artifact_hash_metadata() {
        let root = mobile_storage_contract_root("manifest-export-stored-hash");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge manifest export source bytes";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        let (_actual_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, source_bytes);
        let stored_content_sha256 =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: stored_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "import",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
        );

        let manifest = storage::get_project_manifest(&connection, &root, &project_id).unwrap();

        assert_eq!(manifest.artifacts.len(), 1);
        assert_eq!(manifest.artifacts[0].content_sha256, stored_content_sha256);
        assert_eq!(manifest.artifacts[0].size_bytes, source_size_bytes);
        assert_eq!(manifest.artifacts[0].relative_path, "source/source.wav");

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_sync_outputs_exclude_export_mix_history() {
        let root = mobile_storage_contract_root("sync-excludes-export-mix");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge sync source bytes";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        let preview_path = project_root.join("previews").join("preview.wav");
        let practice_path = project_root.join("previews").join("practice.wav");
        let missing_export_path = root
            .parent()
            .unwrap()
            .join(format!(
                "{project_id}-{}-missing-export.wav",
                std::process::id()
            ));
        let (source_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, source_bytes);
        let (preview_sha256, preview_size_bytes) =
            write_mobile_contract_file(&preview_path, b"preview mix bytes");
        let (practice_sha256, practice_size_bytes) =
            write_mobile_contract_file(&practice_path, b"practice mix bytes");
        let export_sha256 = "e".repeat(64);

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        for artifact in [
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "import",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
            MobileContractArtifact {
                artifact_id: "art_preview_mix",
                project_id: &project_id,
                artifact_type: "preview_mix",
                format: "wav",
                path: &preview_path,
                content_sha256: &preview_sha256,
                size_bytes: preview_size_bytes,
                generated_by: "preview",
                can_delete: true,
                can_regenerate: true,
                cache_key: Some("preview-cache-key"),
                metadata: json!({"kind": "preview"}),
            },
            MobileContractArtifact {
                artifact_id: "art_practice_mix",
                project_id: &project_id,
                artifact_type: "preview_mix",
                format: "wav",
                path: &practice_path,
                content_sha256: &practice_sha256,
                size_bytes: practice_size_bytes,
                generated_by: "stems",
                can_delete: true,
                can_regenerate: true,
                cache_key: Some("practice-cache-key"),
                metadata: json!({"kind": "practice_mix"}),
            },
            MobileContractArtifact {
                artifact_id: "art_export_mix",
                project_id: &project_id,
                artifact_type: "export_mix",
                format: "wav",
                path: &missing_export_path,
                content_sha256: &export_sha256,
                size_bytes: 123,
                generated_by: "export",
                can_delete: true,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({"destination": "external"}),
            },
        ] {
            insert_mobile_contract_artifact(&connection, artifact);
        }
        for (id, target_id, artifact_type) in [
            (
                "tomb_export_mix",
                "art_deleted_export_mix",
                "export_mix",
            ),
            (
                "tomb_preview_mix",
                "art_deleted_preview_mix",
                "preview_mix",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO sync_delete_tombstones (id, sync_group_id, project_id, target_type, target_id, author_device_id, deleted_at, prior_metadata_json, created_at, updated_at)
                     VALUES (?1, 'sync_group_mobile_test', ?2, 'artifact', ?3, 'device_mobile_test', '2026-07-14T12:00:00.000Z', ?4, '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z')",
                    params![id, &project_id, target_id, json!({"type": artifact_type}).to_string()],
                )
                .unwrap();
        }

        let manifest = storage::get_project_manifest(&connection, &root, &project_id).unwrap();
        let metadata = manifests::get_sync_metadata(&connection, &root).unwrap();
        let manifest_artifact_ids = manifest
            .artifacts
            .iter()
            .map(|artifact| artifact.artifact_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let metadata_artifact_ids = metadata
            .artifacts
            .iter()
            .map(|artifact| artifact.artifact_id.as_str())
            .collect::<std::collections::HashSet<_>>();

        for artifact_ids in [&manifest_artifact_ids, &metadata_artifact_ids] {
            assert_eq!(artifact_ids.len(), 3);
            assert!(artifact_ids.contains("art_source_audio"));
            assert!(artifact_ids.contains("art_preview_mix"));
            assert!(artifact_ids.contains("art_practice_mix"));
            assert!(!artifact_ids.contains("art_export_mix"));
        }
        for tombstones in [&manifest.delete_tombstones, &metadata.delete_tombstones] {
            assert_eq!(tombstones.len(), 1);
            assert_eq!(tombstones[0].tombstone_id, "tomb_preview_mix");
            assert_eq!(tombstones[0].target_id, "art_deleted_preview_mix");
        }
        let stored_export_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE id = 'art_export_mix'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_export_count, 1);
        let stored_tombstone_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_delete_tombstones", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored_tombstone_count, 2);

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_manifest_export_rejects_non_file_artifact_path() {
        let root = mobile_storage_contract_root("manifest-export-non-file");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge manifest export directory source";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        std::fs::create_dir_all(&source_path).unwrap();
        let directory_size = std::fs::metadata(&source_path).unwrap().len() as i64;

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_sha256,
                size_bytes: directory_size,
                generated_by: "import",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
        );

        let error = storage::get_project_manifest(&connection, &root, &project_id)
            .err()
            .expect("directory artifact path must not be exported");

        assert_eq!(error, "Project artifact path is not a file.");

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_manifest_import_updates_revision_state_and_hydrates_read_models() {
        let root = mobile_storage_contract_root("manifest-import-hydrates");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge manifest import source bytes";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        let analysis_path = project_root.join("analysis").join("analysis.json");
        let (source_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, source_bytes);
        let analysis_payload = json!({
            "project_id": project_id,
            "source_artifact_id": "art_source_audio",
            "estimated_key": "A minor",
            "key_confidence": 0.91,
            "estimated_reference_hz": null,
            "tuning_offset_cents": -2.75,
            "tempo_bpm": 132.25,
            "analysis_version": "desktop-v1",
            "created_at": "2026-05-22T12:02:00.000Z",
            "timing": {
                "source": "desktop",
                "beats": [{"time_seconds": 0.0}, {"time_seconds": 0.453}],
                "bars": [{"start_seconds": 0.0, "beat_count": 4}]
            }
        });
        let analysis_bytes = serde_json::to_vec(&analysis_payload).unwrap();
        let (analysis_sha256, analysis_size_bytes) =
            write_mobile_contract_file(&analysis_path, &analysis_bytes);

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "sync",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
        );

        let mut superseded_chords = mobile_contract_revision(
            "rev_chords_previous",
            &project_id,
            "chords",
            "generated",
            "1111111111111111111111111111111111111111111111111111111111111111",
            json!({}),
            json!({
                "backend": "desktop",
                "source_kind": "generated",
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}]
            }),
        );
        superseded_chords.state = "active".to_string();
        insert_mobile_contract_revision(&connection, &superseded_chords);

        let mut imported_superseded_chords = superseded_chords.clone();
        imported_superseded_chords.state = "superseded".to_string();
        imported_superseded_chords.updated_at = "2026-05-22T12:03:00.000Z".to_string();
        let mut current_chords = mobile_contract_revision(
            "rev_chords_current",
            &project_id,
            "chords",
            "user_edit",
            "2222222222222222222222222222222222222222222222222222222222222222",
            json!({"reviewed": true}),
            json!({
                "backend": "desktop",
                "source_kind": "user-edited",
                "has_user_edits": true,
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Am"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Am"}],
                "metadata": {"reviewed": true},
                "created_at": "2026-05-22T12:03:00.000Z",
                "updated_at": "2026-05-22T12:04:00.000Z"
            }),
        );
        current_chords.base_revision_id = Some("rev_chords_previous".to_string());
        current_chords.state = "active".to_string();

        let mut superseded_lyrics = mobile_lyrics_revision(
            "rev_lyrics_previous",
            &project_id,
            "superseded",
            Some("art_source_audio"),
            json!({
                "backend": "whisper.cpp",
                "source_kind": "ai",
                "requested_device": "cpu",
                "device": "cpu",
                "model_name": "ggml-base",
                "language": "en",
                "language_override": "en",
                "source_segments": [{
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "old",
                    "words": [{"text": "old", "start_seconds": 0.1, "end_seconds": 0.9}]
                }],
                "segments": [{
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "old",
                    "words": [{"text": "old", "start_seconds": 0.1, "end_seconds": 0.9}]
                }],
                "has_user_edits": false
            }),
        );
        superseded_lyrics.updated_at = "2026-05-22T12:03:00.000Z".to_string();
        let mut current_lyrics = mobile_lyrics_revision(
            "rev_lyrics_current",
            &project_id,
            "active",
            Some("art_source_audio"),
            json!({
                "backend": "whisper.cpp",
                "source_kind": "user-edited",
                "requested_device": null,
                "device": "cpu",
                "model_name": null,
                "language": "en",
                "language_override": null,
                "source_segments": [{
                    "start_seconds": 0.0,
                    "end_seconds": 1.25,
                    "text": "hello",
                    "words": [{
                        "text": "hello",
                        "start_seconds": 0.12,
                        "end_seconds": 0.88,
                        "confidence": 0.91
                    }]
                }],
                "segments": [{
                    "start_seconds": 0.0,
                    "end_seconds": 1.25,
                    "text": "hello sync",
                    "words": [
                        {
                            "text": "hello",
                            "start_seconds": 0.12,
                            "end_seconds": 0.6,
                            "confidence": 0.96
                        },
                        {
                            "text": "sync",
                            "start_seconds": 0.62,
                            "end_seconds": 1.1,
                            "confidence": null
                        }
                    ]
                }],
                "has_user_edits": true,
                "created_at": "2026-05-22T12:03:00.000Z",
                "updated_at": "2026-05-22T12:04:00.000Z"
            }),
        );
        current_lyrics.base_revision_id = Some("rev_lyrics_previous".to_string());

        let manifest = SyncProjectManifestSchema {
            schema_version: SYNC_PROJECT_MANIFEST_SCHEMA_VERSION.to_string(),
            exported_at: "2026-05-22T12:05:00.000Z".to_string(),
            project: SyncProjectManifestProjectSchema {
                project_id: project_id.clone(),
                display_name: "Synced Chords".to_string(),
                source_key_override: None,
                source_sha256: source_sha256.clone(),
                duration_seconds: Some(12.0),
                sample_rate: Some(44_100),
                channels: Some(2),
                created_at: "2026-05-22T12:00:00.000Z".to_string(),
                updated_at: "2026-05-22T12:05:00.000Z".to_string(),
            },
            entity_revisions: vec![
                imported_superseded_chords,
                current_chords,
                superseded_lyrics,
                current_lyrics,
            ],
            artifacts: vec![
                SyncProjectManifestArtifactSchema {
                    artifact_id: "art_source_audio".to_string(),
                    project_id: project_id.clone(),
                    r#type: "source_audio".to_string(),
                    format: "wav".to_string(),
                    relative_path: "source/source.wav".to_string(),
                    content_sha256: source_content_sha256,
                    size_bytes: source_size_bytes,
                    generated_by: "sync".to_string(),
                    can_delete: false,
                    can_regenerate: false,
                    cache_key: None,
                    metadata: json!({}),
                    created_at: "2026-05-22T12:00:00.000Z".to_string(),
                },
                SyncProjectManifestArtifactSchema {
                    artifact_id: "art_analysis_json".to_string(),
                    project_id: project_id.clone(),
                    r#type: "analysis_json".to_string(),
                    format: "json".to_string(),
                    relative_path: "analysis/analysis.json".to_string(),
                    content_sha256: analysis_sha256,
                    size_bytes: analysis_size_bytes,
                    generated_by: "analysis".to_string(),
                    can_delete: false,
                    can_regenerate: true,
                    cache_key: None,
                    metadata: json!({"analysis_version": "desktop-v1"}),
                    created_at: "2026-05-22T12:02:00.000Z".to_string(),
                },
            ],
            delete_tombstones: Vec::new(),
        };

        let imported_project = manifests::import_sync_project_manifest(
            &connection,
            &root,
            SyncProjectStagedImportRequest {
                manifest,
                staging_root: None,
                use_content_addressed_staging: Some(true),
            },
        )
        .unwrap();

        let previous_state: String = connection
            .query_row(
                "SELECT state FROM sync_entity_revisions WHERE id = 'rev_chords_previous'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let active_chord_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_revisions WHERE project_id = ?1 AND entity_type = 'chords' AND state IN ('active', 'current')",
                rusqlite::params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        let chord_response = audio::get_chord_response(&connection, project_id.clone()).unwrap();
        let analysis = audio::get_analysis_value(&connection, &project_id)
            .unwrap()
            .unwrap();
        let lyrics = mobile_lyrics_response(&connection, project_id.clone()).unwrap();
        let project = storage::get_project_schema(&connection, &project_id).unwrap();

        assert_eq!(previous_state, "superseded");
        assert_eq!(active_chord_count, 1);
        assert_eq!(chord_response.timeline[0]["label"], "Am");
        assert_eq!(chord_response.source_kind, "user-edited");
        assert!(chord_response.has_user_edits);
        assert_eq!(analysis["estimated_key"], "A minor");
        assert_eq!(analysis["tempo_bpm"], 132.25);
        assert_eq!(analysis["estimated_reference_hz"], Value::Null);
        assert_eq!(analysis["tuning_offset_cents"], -2.75);
        assert_eq!(analysis["timing"]["source"], "desktop");
        assert_eq!(analysis["timing"]["beats"][1]["time_seconds"], 0.453);
        assert_eq!(analysis["timing"]["bars"][0]["beat_count"], 4);
        assert_eq!(lyrics.backend.as_deref(), Some("whisper.cpp"));
        assert_eq!(lyrics.requested_device, None);
        assert_eq!(lyrics.model_name, None);
        assert_eq!(lyrics.language_override, None);
        assert_eq!(lyrics.source_segments[0]["words"][0]["text"], "hello");
        assert_eq!(lyrics.segments[0]["text"], "hello sync");
        assert_eq!(lyrics.segments[0]["words"][1]["text"], "sync");
        assert_eq!(lyrics.segments[0]["words"][1]["confidence"], Value::Null);
        assert!(lyrics.has_user_edits);
        assert_eq!(mobile_generation_job_count(&connection, &project_id), 0);
        assert_eq!(project.sync_status, "local");
        assert_eq!(
            project.sync_status_reason.as_deref(),
            Some("Synced from desktop.")
        );
        assert_eq!(imported_project.sync_status, "local");
        assert_eq!(
            imported_project.sync_status_reason.as_deref(),
            Some("Synced from desktop.")
        );

        drop(connection);
        let reopened = storage::db_at_root(&root).unwrap();
        let reopened_analysis = audio::get_analysis_value(&reopened, &project_id)
            .unwrap()
            .unwrap();
        let reopened_chords = audio::get_chord_response(&reopened, project_id.clone()).unwrap();
        let reopened_lyrics = mobile_lyrics_response(&reopened, project_id.clone()).unwrap();
        let reopened_project = storage::get_project_schema(&reopened, &project_id).unwrap();

        assert_eq!(reopened_analysis, analysis);
        assert_eq!(reopened_chords.timeline[0]["label"], "Am");
        assert!(reopened_chords.has_user_edits);
        assert_eq!(reopened_lyrics.source_segments, lyrics.source_segments);
        assert_eq!(reopened_lyrics.segments, lyrics.segments);
        assert_eq!(reopened_lyrics.created_at, lyrics.created_at);
        assert_eq!(reopened_lyrics.updated_at, lyrics.updated_at);
        assert_eq!(mobile_generation_job_count(&reopened, &project_id), 0);
        assert_eq!(
            reopened_project.sync_status_reason.as_deref(),
            Some("Synced from desktop.")
        );

        drop(reopened);
        if std::env::var_os("TUNEFORGE_KEEP_ANDROID_FIXTURE").is_some() {
            eprintln!("kept Android fixture at {}", root.display());
        } else {
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_reconciliation_import_revision_hydrates_chords_for_existing_project() {
        let root = mobile_storage_contract_root("reconciliation-revision-hydrates");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge reconciliation source bytes";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        let (source_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, source_bytes);

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);
        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "sync",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
        );

        let revision = mobile_contract_revision(
            "rev_remote_chords",
            &project_id,
            "chords",
            "user_edit",
            "3333333333333333333333333333333333333333333333333333333333333333",
            json!({"reviewed": true}),
            json!({
                "backend": "desktop",
                "source_kind": "user-edited",
                "has_user_edits": true,
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "F"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Dm"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Dm"}],
                "metadata": {"reviewed": true},
                "created_at": "2026-05-22T12:03:00.000Z",
                "updated_at": "2026-05-22T12:04:00.000Z"
            }),
        );
        assert!(audio::get_chord_response(&connection, project_id.clone())
            .unwrap()
            .timeline
            .is_empty());

        let action = SyncReconciliationActionSchema {
            action_type: "import_entity_revision".to_string(),
            item_type: "entity_revision".to_string(),
            item_id: revision.revision_id.clone(),
            project_id: Some(project_id.clone()),
            content_sha256: Some(revision.content_sha256.clone()),
            provider_device_id: None,
            reason: Some("Import entity revision into the existing project.".to_string()),
            priority: 50,
            details: json!({}),
        };
        let payload = SyncReconciliationApplyRequest {
            remote_library: SyncReconciliationRemoteLibrarySchema {
                projects: Vec::new(),
                artifacts: Vec::new(),
                entity_revisions: vec![revision],
                delete_tombstones: Vec::new(),
            },
            project_manifests: Vec::new(),
            peer_inventory: Vec::new(),
            staging_root: None,
            use_content_addressed_staging: true,
            project_ids: Vec::new(),
            include_timing_evidence: false,
        };

        let result =
            reconciliation::apply_reconciliation_action(&connection, &root, action, &payload);
        let chord_response = audio::get_chord_response(&connection, project_id).unwrap();

        assert_eq!(result.status, "applied");
        assert_eq!(chord_response.timeline[0]["label"], "Dm");
        assert_eq!(chord_response.source_kind, "user-edited");
        assert!(chord_response.has_user_edits);

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_reconciliation_revision_import_rolls_back_when_hydration_fails() {
        let root = mobile_storage_contract_root("reconciliation-revision-rollback");
        let connection = storage::db_at_root(&root).unwrap();
        let source_bytes = b"tuneforge reconciliation rollback source bytes";
        let source_sha256 = storage::hex_digest(&Sha256::digest(source_bytes));
        let project_id = source_hash_to_project_id(&source_sha256).unwrap();
        let project_root = storage::project_root_path(&root, &project_id).unwrap();
        let source_path = project_root.join("source").join("source.wav");
        let (source_content_sha256, source_size_bytes) =
            write_mobile_contract_file(&source_path, source_bytes);

        insert_mobile_contract_project(&connection, &project_id, &source_sha256, &source_path);

        let revision = mobile_contract_revision(
            "rev_remote_chords_retry",
            &project_id,
            "chords",
            "user_edit",
            "4444444444444444444444444444444444444444444444444444444444444444",
            json!({"reviewed": true}),
            json!({
                "backend": "desktop",
                "source_artifact_id": "art_source_audio",
                "source_kind": "user-edited",
                "has_user_edits": true,
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Bb"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Gm"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "Gm"}],
                "metadata": {"reviewed": true},
                "created_at": "2026-05-22T12:03:00.000Z",
                "updated_at": "2026-05-22T12:04:00.000Z"
            }),
        );
        let action = SyncReconciliationActionSchema {
            action_type: "import_entity_revision".to_string(),
            item_type: "entity_revision".to_string(),
            item_id: revision.revision_id.clone(),
            project_id: Some(project_id.clone()),
            content_sha256: Some(revision.content_sha256.clone()),
            provider_device_id: None,
            reason: Some("Import entity revision into the existing project.".to_string()),
            priority: 50,
            details: json!({}),
        };
        let payload = SyncReconciliationApplyRequest {
            remote_library: SyncReconciliationRemoteLibrarySchema {
                projects: Vec::new(),
                artifacts: Vec::new(),
                entity_revisions: vec![revision],
                delete_tombstones: Vec::new(),
            },
            project_manifests: Vec::new(),
            peer_inventory: Vec::new(),
            staging_root: None,
            use_content_addressed_staging: true,
            project_ids: Vec::new(),
            include_timing_evidence: false,
        };

        let failed_result = reconciliation::apply_reconciliation_action(
            &connection,
            &root,
            action.clone(),
            &payload,
        );
        let persisted_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_revisions WHERE id = ?1",
                rusqlite::params![&action.item_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(failed_result.status, "failed");
        assert!(failed_result
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("source_artifact_id must belong"));
        assert_eq!(persisted_count, 0);
        assert!(audio::get_chord_response(&connection, project_id.clone())
            .unwrap()
            .timeline
            .is_empty());

        insert_mobile_contract_artifact(
            &connection,
            MobileContractArtifact {
                artifact_id: "art_source_audio",
                project_id: &project_id,
                artifact_type: "source_audio",
                format: "wav",
                path: &source_path,
                content_sha256: &source_content_sha256,
                size_bytes: source_size_bytes,
                generated_by: "sync",
                can_delete: false,
                can_regenerate: false,
                cache_key: None,
                metadata: json!({}),
            },
        );

        let retry_result =
            reconciliation::apply_reconciliation_action(&connection, &root, action, &payload);
        let retry_persisted_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_revisions WHERE id = 'rev_remote_chords_retry'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let chord_response = audio::get_chord_response(&connection, project_id).unwrap();

        assert_eq!(retry_result.status, "applied");
        assert_eq!(retry_persisted_count, 1);
        assert_eq!(chord_response.timeline[0]["label"], "Gm");
        assert_eq!(chord_response.source_kind, "user-edited");
        assert!(chord_response.has_user_edits);

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mobile_new_artifact_id_uses_column_safe_hex_entropy() {
        let artifact_id = new_artifact_id().unwrap();
        let suffix = artifact_id.strip_prefix(ARTIFACT_ID_PREFIX).unwrap();

        assert_eq!(artifact_id.len(), 32);
        assert_eq!(suffix.len(), 28);
        assert!(suffix
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
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
    fn mobile_sync_timestamps_accept_legacy_sqlite_utc_and_normalize_to_z() {
        assert_eq!(
            normalize_sync_timestamp_utc("2026-07-03T22:05:09.301876", "tombstone deleted_at")
                .unwrap(),
            "2026-07-03T22:05:09.301876Z"
        );
        assert_eq!(
            normalize_sync_timestamp_utc("2026-05-22 12:34:56.123456", "tombstone deleted_at")
                .unwrap(),
            "2026-05-22T12:34:56.123456Z"
        );
        assert_eq!(
            normalize_sync_timestamp_utc("2026-05-22 12:34:56", "tombstone deleted_at").unwrap(),
            "2026-05-22T12:34:56Z"
        );
        assert_eq!(
            normalize_sync_timestamp_utc("2026-05-22 12:34:56 UTC", "tombstone deleted_at")
                .unwrap(),
            "2026-05-22T12:34:56Z"
        );
        assert_eq!(
            normalize_sync_timestamp_utc(
                "2026-05-22 09:34:56.123456-03:00",
                "tombstone deleted_at"
            )
            .unwrap(),
            "2026-05-22T12:34:56.123456Z"
        );
    }

    #[test]
    fn mobile_sync_timestamp_deserialize_reexports_legacy_tombstones_as_rfc3339_z() {
        let tombstone: SyncDeleteTombstoneSchema = serde_json::from_value(json!({
            "tombstone_id": "tomb_legacy",
            "sync_group_id": "sync_group_1",
            "project_id": "proj_1",
            "target_type": "artifact",
            "target_id": "art_1",
            "author_device_id": "device_peer_1",
            "deleted_at": "2026-05-22 12:34:56.123456",
            "prior_metadata": {},
            "created_at": "2026-05-22 12:34:55.000000",
            "updated_at": "2026-05-22 12:34:56.123456"
        }))
        .unwrap();

        assert_eq!(tombstone.deleted_at, "2026-05-22T12:34:56.123456Z");
        assert_eq!(tombstone.created_at, "2026-05-22T12:34:55Z");
        assert_eq!(tombstone.updated_at, "2026-05-22T12:34:56.123456Z");
        assert!(serde_json::to_value(tombstone)
            .unwrap()
            .get("deleted_at")
            .and_then(Value::as_str)
            .is_some_and(|value| value.ends_with('Z')));
    }

    #[test]
    fn mobile_sync_timestamp_deserialize_rejects_invalid_values() {
        let error = match serde_json::from_value::<SyncDeleteTombstoneSchema>(json!({
            "tombstone_id": "tomb_bad_timestamp",
            "sync_group_id": "sync_group_1",
            "project_id": "proj_1",
            "target_type": "artifact",
            "target_id": "art_1",
            "author_device_id": "device_peer_1",
            "deleted_at": "not a timestamp",
            "prior_metadata": {},
            "created_at": "2026-05-22T12:34:55Z",
            "updated_at": "2026-05-22T12:34:56Z"
        })) {
            Ok(_) => panic!("expected invalid timestamp to fail"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("ISO-8601 timestamp"));
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
    fn mobile_stale_tombstone_filter_detects_newer_or_equal_live_target_timestamp() {
        assert!(sync_timestamp_is_newer_or_equal(
            "2026-01-02T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        ));
        assert!(sync_timestamp_is_newer_or_equal(
            "2026-01-02T00:00:00.000Z",
            "2026-01-02T00:00:00.000Z",
        ));
        assert!(sync_timestamp_is_newer_or_equal(
            "2026-01-02T00:00:00.000Z",
            "2026-01-01 23:59:59.999999",
        ));
        assert!(sync_timestamp_is_newer_or_equal(
            "2026-01-02 00:00:00.000001",
            "2026-01-02T00:00:00Z",
        ));
        assert!(!sync_timestamp_is_newer_or_equal(
            "2026-01-01T00:00:00.000Z",
            "2026-01-02T00:00:00.000Z",
        ));
    }

    #[test]
    fn mobile_stale_tombstone_plan_entry_is_noop_without_apply_action() {
        let project_id = source_hash_to_project_id(
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        )
        .unwrap();
        let tombstone = mobile_test_tombstone(
            "tomb_plan_stale_project",
            &project_id,
            "project",
            &project_id,
        );

        let (item, actions, tombstone_is_effective) =
            plan_delete_tombstone_branch(&tombstone, true);

        assert_eq!(item.item_type, "project");
        assert_eq!(item.item_id, project_id);
        assert_eq!(item.project_id.as_deref(), Some(project_id.as_str()));
        assert_eq!(item.status, "noop");
        assert_eq!(item.action_type.as_deref(), Some(ACTION_NOOP));
        assert_eq!(
            item.reason.as_deref(),
            Some(STALE_LIVE_TOMBSTONE_NOOP_REASON)
        );
        assert!(!tombstone_is_effective);
        assert!(actions.is_empty());
        assert!(!actions
            .iter()
            .any(|action| action.action_type == ACTION_APPLY_DELETE_TOMBSTONE));
    }

    #[test]
    fn mobile_sync_timestamp_normalizes_high_precision_to_backend_microseconds() {
        assert_eq!(
            normalize_sync_timestamp_utc("2026-05-22T12:34:56.123456789Z", "tombstone deleted_at")
                .unwrap(),
            "2026-05-22T12:34:56.123456Z"
        );
        assert_eq!(
            normalize_sync_timestamp_utc(
                "2026-05-22T09:34:56.123456789-03:00",
                "tombstone deleted_at"
            )
            .unwrap(),
            "2026-05-22T12:34:56.123456Z"
        );
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
        assert_eq!(MOBILE_DB_VERSION, 4);
        assert!(sync_editable(DEFAULT_SYNC_STATUS));
        assert!(!sync_editable("remote_available"));
        assert!(!sync_editable("conflicted"));
        assert!(require_sync_editable_status(DEFAULT_SYNC_STATUS).is_ok());
        assert!(require_sync_editable_status("remote_available")
            .unwrap_err()
            .contains("locked by sync status"));
    }

    #[test]
    fn mobile_lyrics_revision_payload_preserves_desktop_fields_aliases_and_nulls() {
        let mut revision = mobile_lyrics_revision(
            "rev_lyrics_parser",
            "project",
            "active",
            Some("art_source"),
            json!({
                "backend": "whisper.cpp",
                "source_kind": "user-edited",
                "requested_device": null,
                "device": "cpu",
                "model_name": null,
                "language": "pt",
                "language_override": null,
                "source_segments_json": [{
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "ola",
                    "words": [{"text": "ola", "start_seconds": 0.1, "end_seconds": 0.9}]
                }],
                "segments_json": [{
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "olá",
                    "words": [{"text": "olá", "start_seconds": 0.1, "end_seconds": 0.9}]
                }],
                "has_user_edits": true,
                "created_at": "2026-05-22T09:03:00-03:00"
            }),
        );
        revision.updated_at = "2026-05-22T12:04:00Z".to_string();

        let parsed = mobile_lyrics_revision_payload(&revision).unwrap();

        assert_eq!(parsed.backend, "whisper.cpp");
        assert_eq!(parsed.source_artifact_id.as_deref(), Some("art_source"));
        assert_eq!(parsed.source_kind, "user-edited");
        assert_eq!(parsed.requested_device, None);
        assert_eq!(parsed.device.as_deref(), Some("cpu"));
        assert_eq!(parsed.model_name, None);
        assert_eq!(parsed.language.as_deref(), Some("pt"));
        assert_eq!(parsed.language_override, None);
        assert_eq!(parsed.source_segments[0]["words"][0]["text"], "ola");
        assert_eq!(parsed.segments[0]["text"], "olá");
        assert!(parsed.has_user_edits);
        assert_eq!(parsed.created_at, "2026-05-22T12:03:00Z");
        assert_eq!(parsed.updated_at, "2026-05-22T12:04:00Z");
    }

    #[test]
    fn mobile_lyrics_revision_payload_defaults_backend_compatible_fields() {
        let revision = mobile_lyrics_revision(
            "rev_lyrics_defaults",
            "project",
            "active",
            None,
            json!({}),
        );

        let parsed = mobile_lyrics_revision_payload(&revision).unwrap();

        assert_eq!(parsed.backend, "openai-whisper");
        assert_eq!(parsed.source_kind, "ai");
        assert!(parsed.source_segments.is_empty());
        assert!(parsed.segments.is_empty());
        assert!(!parsed.has_user_edits);
    }

    #[test]
    fn mobile_lyrics_revision_payload_matches_backend_empty_and_null_semantics() {
        let revision = mobile_lyrics_revision(
            "rev_lyrics_empty_strings",
            "project",
            "active",
            Some("art_source"),
            json!({
                "backend": "",
                "source_artifact_id": "",
                "source_kind": ""
            }),
        );

        let parsed = mobile_lyrics_revision_payload(&revision).unwrap();

        assert_eq!(parsed.backend, "openai-whisper");
        assert_eq!(parsed.source_artifact_id.as_deref(), Some("art_source"));
        assert_eq!(parsed.source_kind, "ai");

        let null_edits = mobile_lyrics_revision(
            "rev_lyrics_null_edits",
            "project",
            "active",
            None,
            json!({"has_user_edits": null}),
        );
        assert!(mobile_lyrics_revision_payload(&null_edits)
            .err()
            .expect("explicit null edit state must fail")
            .contains("field must be a boolean: has_user_edits"));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_manifest_import_hydrates_current_lyrics_and_persists_on_reopen() {
        let (root, connection, project_id, mut manifest) =
            mobile_lyrics_import_fixture("lyrics-current-persists");
        let superseded = mobile_lyrics_revision(
            "rev_lyrics_previous",
            &project_id,
            "superseded",
            Some("art_source_audio"),
            mobile_desktop_lyrics_payload("old", "old"),
        );
        let current_payload = mobile_desktop_lyrics_payload("hello", "hello sync");
        let expected_source_segments = current_payload["source_segments"].clone();
        let expected_segments = current_payload["segments"].clone();
        let current = mobile_lyrics_revision(
            "rev_lyrics_current",
            &project_id,
            "active",
            Some("art_source_audio"),
            current_payload,
        );
        manifest.entity_revisions = vec![superseded, current];

        manifests::import_sync_project_manifest(
            &connection,
            &root,
            SyncProjectStagedImportRequest {
                manifest,
                staging_root: None,
                use_content_addressed_staging: Some(true),
            },
        )
        .unwrap();

        let lyrics = mobile_lyrics_response(&connection, project_id.clone()).unwrap();
        assert_eq!(lyrics.backend.as_deref(), Some("whisper.cpp"));
        assert_eq!(lyrics.source_artifact_id.as_deref(), Some("art_source_audio"));
        assert_eq!(lyrics.source_kind.as_deref(), Some("user-edited"));
        assert_eq!(lyrics.requested_device.as_deref(), Some("cpu"));
        assert_eq!(lyrics.device.as_deref(), Some("cpu"));
        assert_eq!(lyrics.model_name.as_deref(), Some("ggml-large-v3"));
        assert_eq!(lyrics.language.as_deref(), Some("en"));
        assert_eq!(lyrics.language_override.as_deref(), Some("en"));
        assert_eq!(lyrics.source_segments, expected_source_segments.as_array().unwrap().clone());
        assert_eq!(lyrics.segments, expected_segments.as_array().unwrap().clone());
        assert!(lyrics.has_user_edits);
        assert_eq!(lyrics.created_at.as_deref(), Some("2026-05-22T12:03:00Z"));
        assert_eq!(lyrics.updated_at.as_deref(), Some("2026-05-22T12:04:00Z"));
        assert_eq!(mobile_generation_job_count(&connection, &project_id), 0);

        drop(connection);
        let reopened = storage::db_at_root(&root).unwrap();
        let reopened_lyrics = mobile_lyrics_response(&reopened, project_id.clone()).unwrap();
        assert_eq!(reopened_lyrics.segments, lyrics.segments);
        assert_eq!(reopened_lyrics.updated_at, lyrics.updated_at);
        drop(reopened);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_manifest_import_distinguishes_empty_and_absent_lyrics() {
        let (empty_root, empty_connection, empty_project_id, mut empty_manifest) =
            mobile_lyrics_import_fixture("lyrics-empty");
        empty_manifest.entity_revisions = vec![mobile_lyrics_revision(
            "rev_lyrics_empty",
            &empty_project_id,
            "active",
            Some("art_source_audio"),
            json!({
                "backend": "whisper.cpp",
                "source_kind": "ai",
                "requested_device": null,
                "device": null,
                "model_name": null,
                "language": null,
                "language_override": null,
                "source_segments": [],
                "segments": [],
                "has_user_edits": false
            }),
        )];
        manifests::import_sync_project_manifest(
            &empty_connection,
            &empty_root,
            SyncProjectStagedImportRequest {
                manifest: empty_manifest,
                staging_root: None,
                use_content_addressed_staging: Some(true),
            },
        )
        .unwrap();
        let empty_lyrics =
            mobile_lyrics_response(&empty_connection, empty_project_id.clone()).unwrap();
        assert_eq!(mobile_lyrics_row_count(&empty_connection, &empty_project_id), 1);
        assert!(empty_lyrics.source_segments.is_empty());
        assert!(empty_lyrics.segments.is_empty());
        assert!(!empty_lyrics.has_user_edits);
        assert_eq!(mobile_generation_job_count(&empty_connection, &empty_project_id), 0);

        let (absent_root, absent_connection, absent_project_id, absent_manifest) =
            mobile_lyrics_import_fixture("lyrics-absent");
        manifests::import_sync_project_manifest(
            &absent_connection,
            &absent_root,
            SyncProjectStagedImportRequest {
                manifest: absent_manifest,
                staging_root: None,
                use_content_addressed_staging: Some(true),
            },
        )
        .unwrap();
        let absent_lyrics =
            mobile_lyrics_response(&absent_connection, absent_project_id.clone()).unwrap();
        assert_eq!(mobile_lyrics_row_count(&absent_connection, &absent_project_id), 0);
        assert!(absent_lyrics.source_segments.is_empty());
        assert!(absent_lyrics.segments.is_empty());
        assert_eq!(absent_lyrics.backend, None);
        assert_eq!(mobile_generation_job_count(&absent_connection, &absent_project_id), 0);

        drop(empty_connection);
        drop(absent_connection);
        let _ = std::fs::remove_dir_all(&empty_root);
        let _ = std::fs::remove_dir_all(&absent_root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_reconciliation_removes_stale_lyrics_when_current_revision_is_superseded() {
        let (root, connection, project_id, mut active_manifest) =
            mobile_lyrics_import_fixture("lyrics-superseded-reconciliation");
        active_manifest.entity_revisions = vec![mobile_lyrics_revision(
            "rev_lyrics_current",
            &project_id,
            "active",
            Some("art_source_audio"),
            mobile_desktop_lyrics_payload("hello", "hello sync"),
        )];
        let mut superseded_revision = active_manifest.entity_revisions[0].clone();
        superseded_revision.state = "superseded".to_string();
        superseded_revision.updated_at = "2026-05-22T12:06:00Z".to_string();

        manifests::import_sync_project_manifest(
            &connection,
            &root,
            SyncProjectStagedImportRequest {
                manifest: active_manifest,
                staging_root: None,
                use_content_addressed_staging: Some(true),
            },
        )
        .unwrap();
        assert_eq!(mobile_lyrics_row_count(&connection, &project_id), 1);

        let result = reconciliation::apply_reconciliation_action(
            &connection,
            &root,
            SyncReconciliationActionSchema {
                action_type: "import_entity_revision".to_string(),
                item_type: "entity_revision".to_string(),
                item_id: superseded_revision.revision_id.clone(),
                project_id: Some(project_id.clone()),
                content_sha256: Some(superseded_revision.content_sha256.clone()),
                provider_device_id: None,
                reason: Some("Import superseded lyrics revision state.".to_string()),
                priority: 50,
                details: json!({}),
            },
            &SyncReconciliationApplyRequest {
                remote_library: SyncReconciliationRemoteLibrarySchema {
                    projects: Vec::new(),
                    artifacts: Vec::new(),
                    entity_revisions: vec![superseded_revision],
                    delete_tombstones: Vec::new(),
                },
                project_manifests: Vec::new(),
                peer_inventory: Vec::new(),
                staging_root: None,
                use_content_addressed_staging: true,
                project_ids: Vec::new(),
                include_timing_evidence: false,
            },
        );

        let lyrics = mobile_lyrics_response(&connection, project_id.clone()).unwrap();
        assert_eq!(result.status, "applied");
        assert_eq!(mobile_lyrics_row_count(&connection, &project_id), 0);
        assert_eq!(lyrics.backend, None);
        assert!(lyrics.source_segments.is_empty());
        assert!(lyrics.segments.is_empty());
        assert_eq!(mobile_generation_job_count(&connection, &project_id), 0);

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_reconciliation_preserves_unrevisioned_lyrics_for_unrelated_import() {
        let (root, connection, project_id, mut manifest) =
            mobile_lyrics_import_fixture("lyrics-unrelated-reconciliation");
        manifest.entity_revisions = vec![mobile_lyrics_revision(
            "rev_lyrics_local_seed",
            &project_id,
            "active",
            Some("art_source_audio"),
            mobile_desktop_lyrics_payload("local", "local edit"),
        )];
        manifests::import_sync_project_manifest(
            &connection,
            &root,
            SyncProjectStagedImportRequest {
                manifest,
                staging_root: None,
                use_content_addressed_staging: Some(true),
            },
        )
        .unwrap();
        let local_lyrics = mobile_lyrics_response(&connection, project_id.clone()).unwrap();
        connection
            .execute(
                "DELETE FROM sync_entity_revisions WHERE project_id = ?1",
                rusqlite::params![&project_id],
            )
            .unwrap();

        let mut metadata_revision = mobile_lyrics_revision(
            "rev_project_metadata",
            &project_id,
            "active",
            None,
            json!({"display_name": "Unrelated metadata"}),
        );
        metadata_revision.entity_type = "project_metadata".to_string();
        metadata_revision.revision_type = "metadata_change".to_string();
        let result = reconciliation::apply_reconciliation_action(
            &connection,
            &root,
            SyncReconciliationActionSchema {
                action_type: "import_entity_revision".to_string(),
                item_type: "entity_revision".to_string(),
                item_id: metadata_revision.revision_id.clone(),
                project_id: Some(project_id.clone()),
                content_sha256: Some(metadata_revision.content_sha256.clone()),
                provider_device_id: None,
                reason: Some("Import unrelated project metadata revision.".to_string()),
                priority: 50,
                details: json!({}),
            },
            &SyncReconciliationApplyRequest {
                remote_library: SyncReconciliationRemoteLibrarySchema {
                    projects: Vec::new(),
                    artifacts: Vec::new(),
                    entity_revisions: vec![metadata_revision],
                    delete_tombstones: Vec::new(),
                },
                project_manifests: Vec::new(),
                peer_inventory: Vec::new(),
                staging_root: None,
                use_content_addressed_staging: true,
                project_ids: Vec::new(),
                include_timing_evidence: false,
            },
        );

        let preserved = mobile_lyrics_response(&connection, project_id.clone()).unwrap();
        assert_eq!(result.status, "applied");
        assert_eq!(mobile_lyrics_row_count(&connection, &project_id), 1);
        assert_eq!(preserved.source_segments, local_lyrics.source_segments);
        assert_eq!(preserved.segments, local_lyrics.segments);
        assert_eq!(preserved.updated_at, local_lyrics.updated_at);
        assert_eq!(mobile_generation_job_count(&connection, &project_id), 0);

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_manifest_lyrics_hydration_failures_roll_back() {
        for (slug, revisions, expected_error) in [
            (
                "lyrics-duplicate",
                vec![
                    mobile_lyrics_revision(
                        "rev_lyrics_a",
                        "PROJECT_ID",
                        "active",
                        Some("art_source_audio"),
                        mobile_desktop_lyrics_payload("a", "a"),
                    ),
                    mobile_lyrics_revision(
                        "rev_lyrics_b",
                        "PROJECT_ID",
                        "current",
                        Some("art_source_audio"),
                        mobile_desktop_lyrics_payload("b", "b"),
                    ),
                ],
                "multiple current lyrics revisions",
            ),
            (
                "lyrics-foreign-source",
                vec![mobile_lyrics_revision(
                    "rev_lyrics_foreign",
                    "PROJECT_ID",
                    "active",
                    Some("art_foreign"),
                    mobile_desktop_lyrics_payload("a", "a"),
                )],
                "source_artifact_id must belong",
            ),
        ] {
            let (root, connection, project_id, mut manifest) = mobile_lyrics_import_fixture(slug);
            manifest.entity_revisions = revisions
                .into_iter()
                .map(|mut revision| {
                    revision.project_id = project_id.clone();
                    revision.entity_id = project_id.clone();
                    revision
                })
                .collect();
            let error = manifests::import_sync_project_manifest(
                &connection,
                &root,
                SyncProjectStagedImportRequest {
                    manifest,
                    staging_root: None,
                    use_content_addressed_staging: Some(true),
                },
            )
            .err()
            .expect("invalid lyrics manifest must fail");
            let revision_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_entity_revisions WHERE project_id = ?1",
                    rusqlite::params![&project_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(error.contains(expected_error), "unexpected error: {error}");
            assert_eq!(revision_count, 0);
            assert_eq!(mobile_lyrics_row_count(&connection, &project_id), 0);
            assert_eq!(mobile_generation_job_count(&connection, &project_id), 0);
            let project = storage::get_project_schema(&connection, &project_id).unwrap();
            assert_eq!(project.sync_status, "local");
            assert_eq!(project.sync_status_reason, None);
            drop(connection);
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mobile_reconciliation_lyrics_import_rolls_back_malformed_then_hydrates_valid() {
        let (root, connection, project_id, _) =
            mobile_lyrics_import_fixture("lyrics-reconciliation");
        let malformed = mobile_lyrics_revision(
            "rev_lyrics_malformed",
            &project_id,
            "active",
            Some("art_source_audio"),
            json!({
                "source_segments": [],
                "segments": "invalid"
            }),
        );
        let action_for = |revision: &SyncProjectManifestEntityRevisionSchema| {
            SyncReconciliationActionSchema {
                action_type: "import_entity_revision".to_string(),
                item_type: "entity_revision".to_string(),
                item_id: revision.revision_id.clone(),
                project_id: Some(project_id.clone()),
                content_sha256: Some(revision.content_sha256.clone()),
                provider_device_id: None,
                reason: Some("Import lyrics revision into the existing project.".to_string()),
                priority: 50,
                details: json!({}),
            }
        };
        let payload_for = |revision: SyncProjectManifestEntityRevisionSchema| {
            SyncReconciliationApplyRequest {
                remote_library: SyncReconciliationRemoteLibrarySchema {
                    projects: Vec::new(),
                    artifacts: Vec::new(),
                    entity_revisions: vec![revision],
                    delete_tombstones: Vec::new(),
                },
                project_manifests: Vec::new(),
                peer_inventory: Vec::new(),
                staging_root: None,
                use_content_addressed_staging: true,
                project_ids: Vec::new(),
                include_timing_evidence: false,
            }
        };

        let malformed_result = reconciliation::apply_reconciliation_action(
            &connection,
            &root,
            action_for(&malformed),
            &payload_for(malformed),
        );
        assert_eq!(malformed_result.status, "failed");
        assert!(malformed_result
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("field must be a list of objects: segments"));
        assert_eq!(mobile_lyrics_row_count(&connection, &project_id), 0);

        let valid = mobile_lyrics_revision(
            "rev_lyrics_valid",
            &project_id,
            "active",
            Some("art_source_audio"),
            mobile_desktop_lyrics_payload("hello", "hello synced"),
        );
        let valid_result = reconciliation::apply_reconciliation_action(
            &connection,
            &root,
            action_for(&valid),
            &payload_for(valid),
        );
        let revision_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_revisions WHERE project_id = ?1",
                rusqlite::params![&project_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(valid_result.status, "applied");
        assert_eq!(revision_count, 1);
        assert_eq!(
            mobile_lyrics_response(&connection, project_id.clone()).unwrap().segments[0]["text"],
            "hello synced"
        );
        assert_eq!(mobile_generation_job_count(&connection, &project_id), 0);

        drop(connection);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mobile_chord_revision_payload_accepts_desktop_field_aliases() {
        let revision = SyncProjectManifestEntityRevisionSchema {
            revision_id: "rev_chords".to_string(),
            project_id: "project".to_string(),
            entity_type: "chords".to_string(),
            entity_id: "chords-main".to_string(),
            revision_type: "snapshot".to_string(),
            base_revision_id: None,
            author_device_id: "device_peer_1".to_string(),
            source_artifact_id: Some("art_source".to_string()),
            content_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            state: "active".to_string(),
            metadata: json!({"reviewed": true}),
            payload: json!({
                "backend": "beat-this",
                "source_segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "C"}],
                "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "G"}],
                "timeline": [{"start_seconds": 0.0, "end_seconds": 1.0, "label": "legacy"}],
                "source_kind": "user-edited",
                "has_user_edits": true,
                "metadata": {"runtime_device": "cpu"},
                "created_at": "2026-05-22T12:00:00.000Z",
                "updated_at": "2026-05-22T12:01:00.000Z"
            }),
            created_at: "2026-05-22T11:00:00.000Z".to_string(),
            updated_at: "2026-05-22T11:01:00.000Z".to_string(),
        };

        let payload = mobile_chord_revision_payload(&revision).unwrap();

        assert_eq!(payload.backend, "beat-this");
        assert_eq!(payload.source_artifact_id.as_deref(), Some("art_source"));
        assert_eq!(payload.source_segments[0]["label"], "C");
        assert_eq!(payload.segments[0]["label"], "G");
        assert_eq!(payload.timeline[0]["label"], "legacy");
        assert_eq!(payload.source_kind, "user-edited");
        assert_eq!(payload.metadata["runtime_device"], "cpu");
        assert!(payload.has_user_edits);
        assert_eq!(payload.created_at, "2026-05-22T12:00:00Z");
        assert_eq!(payload.updated_at, "2026-05-22T12:01:00Z");
    }

    #[test]
    fn mobile_payload_timestamp_fields_normalize_legacy_naive_iso_t_to_z() {
        let payload = json!({
            "created_at": "2026-07-03T22:05:09.301876",
            "updated_at": "2026-07-03T22:06:09.301876"
        });

        assert_eq!(
            payload_optional_timestamp_string(&payload, "created_at", "Chord revision")
                .unwrap()
                .as_deref(),
            Some("2026-07-03T22:05:09.301876Z")
        );
        assert_eq!(
            payload_optional_timestamp_string(&payload, "updated_at", "Chord revision")
                .unwrap()
                .as_deref(),
            Some("2026-07-03T22:06:09.301876Z")
        );
    }

    #[test]
    fn mobile_analysis_artifact_payload_preserves_timing() {
        let payload = mobile_analysis_artifact_payload(
            &json!({
                "project_id": "project",
                "source_artifact_id": "art_source",
                "estimated_key": "C major",
                "key_confidence": 0.9,
                "estimated_reference_hz": 440.0,
                "tuning_offset_cents": -1.5,
                "tempo_bpm": 120.0,
                "created_at": "2026-05-22T12:00:00.000Z",
                "timing": {
                    "beats_per_bar": 4,
                    "source": "beat-this",
                    "beats": [{"time_seconds": 0.0, "beat_index": 0}],
                    "bars": []
                }
            }),
            &json!({"analysis_version": "v3"}),
        )
        .unwrap();

        assert_eq!(payload.project_id.as_deref(), Some("project"));
        assert_eq!(payload.source_artifact_id.as_deref(), Some("art_source"));
        assert_eq!(payload.estimated_key.as_deref(), Some("C major"));
        assert_eq!(payload.key_confidence, Some(0.9));
        assert_eq!(payload.estimated_reference_hz, Some(440.0));
        assert_eq!(payload.tuning_offset_cents, Some(-1.5));
        assert_eq!(payload.tempo_bpm, Some(120.0));
        assert_eq!(payload.timing.unwrap()["source"], "beat-this");
        assert_eq!(payload.analysis_version, "v3");
        assert_eq!(payload.created_at.as_deref(), Some("2026-05-22T12:00:00Z"));
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
