use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use tauri::AppHandle;

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const PROJECT_ID_PREFIX: &str = "proj_sha256_";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SYNC_PROJECT_MANIFEST_SCHEMA_VERSION: &str = "1";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SYNC_PAIRING_PROTOCOL_VERSION: &str = "tuneforge-sync-v1";
#[cfg(any(test, target_os = "android"))]
const TRANSPORT_HANDSHAKE_CHALLENGE_TYPE: &str = "transport_handshake";
#[cfg(any(test, target_os = "android"))]
const TRANSPORT_HANDSHAKE_MAX_TTL_SECONDS: i64 = 300;
#[cfg(any(test, target_os = "android"))]
const TRANSPORT_HANDSHAKE_CLOCK_SKEW_SECONDS: i64 = 30;
#[cfg(not(target_os = "android"))]
const MOBILE_UNAVAILABLE: &str = "Mobile embedded backend is only available in Android builds.";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const MOBILE_DB_VERSION: i64 = 2;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const DEFAULT_SYNC_STATUS: &str = "local";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const DEFAULT_SYNC_LIST_JSON: &str = "[]";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const MOBILE_CANCELLED_JOB_STATUS: &str = "cancelled";
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
    source_sha256: Option<String>,
    source_path: String,
    imported_path: String,
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
    sync_status: String,
    sync_status_reason: Option<String>,
    sync_editable: bool,
    sync_required_artifact_ids: Vec<String>,
    sync_provider_device_ids: Vec<String>,
    sync_conflict_count: i64,
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
    content_sha256: Option<String>,
    size_bytes: i64,
    generated_by: String,
    can_delete: bool,
    can_regenerate: bool,
    metadata: Value,
    cache_key: Option<String>,
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
    result_artifact_ids: Vec<String>,
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
    search: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncLocalIdentitySchema {
    device_id: String,
    sync_group_id: String,
    display_name: Option<String>,
    public_key: String,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Serialize)]
pub struct SyncLocalIdentityResponse {
    identity: SyncLocalIdentitySchema,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncPairingPayloadSchema {
    sync_group_id: String,
    device_id: String,
    display_name: Option<String>,
    public_key: String,
    #[serde(default)]
    endpoint_hints: Vec<String>,
    protocol_version: String,
    pairing_offer_id: String,
    pairing_secret: String,
    expires_at: String,
    signature: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncPairingOfferSchema {
    payload: SyncPairingPayloadSchema,
    expires_at: String,
    ttl_seconds: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncPairingOfferRequest {
    #[serde(default)]
    endpoint_hints: Vec<String>,
    ttl_seconds: Option<i64>,
}

#[derive(Serialize)]
pub struct SyncPairingOfferResponse {
    pairing_offer: SyncPairingOfferSchema,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncPairingAnswerRequest {
    offer: SyncPairingPayloadSchema,
    #[serde(default)]
    endpoint_hints: Vec<String>,
    #[serde(default)]
    adopt_sync_group: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncTrustedPeerSchema {
    device_id: String,
    sync_group_id: String,
    display_name: Option<String>,
    public_key: String,
    endpoint_hints: Vec<String>,
    trusted_at: String,
    revoked_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncTrustedPeerCreateRequest {
    payload: SyncPairingPayloadSchema,
    #[serde(default)]
    adopt_sync_group: bool,
}

#[derive(Serialize)]
pub struct SyncTrustedPeerResponse {
    trusted_peer: SyncTrustedPeerSchema,
}

#[derive(Serialize)]
pub struct SyncPairingAnswerResponse {
    pairing_response: SyncPairingPayloadSchema,
    trusted_peer: SyncTrustedPeerSchema,
}

#[derive(Serialize)]
pub struct SyncTrustedPeersResponse {
    trusted_peers: Vec<SyncTrustedPeerSchema>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncMetadataProjectSchema {
    project_id: String,
    display_name: String,
    source_key_override: Option<String>,
    source_sha256: Option<String>,
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncMetadataArtifactSchema {
    artifact_id: String,
    project_id: String,
    r#type: String,
    format: String,
    relative_path: Option<String>,
    content_sha256: Option<String>,
    size_bytes: i64,
    generated_by: String,
    can_delete: bool,
    can_regenerate: bool,
    cache_key: Option<String>,
    metadata: Value,
    created_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncDeleteTombstoneSchema {
    tombstone_id: String,
    sync_group_id: String,
    project_id: String,
    target_type: String,
    target_id: String,
    author_device_id: String,
    deleted_at: String,
    #[serde(default)]
    prior_metadata: Value,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
pub struct SyncMetadataResponse {
    projects: Vec<SyncMetadataProjectSchema>,
    artifacts: Vec<SyncMetadataArtifactSchema>,
    delete_tombstones: Vec<SyncDeleteTombstoneSchema>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProjectManifestProjectSchema {
    project_id: String,
    display_name: String,
    source_key_override: Option<String>,
    source_sha256: String,
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProjectManifestArtifactSchema {
    artifact_id: String,
    project_id: String,
    r#type: String,
    format: String,
    relative_path: String,
    content_sha256: String,
    size_bytes: i64,
    generated_by: String,
    can_delete: bool,
    can_regenerate: bool,
    cache_key: Option<String>,
    #[serde(default)]
    metadata: Value,
    created_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProjectManifestEntityRevisionSchema {
    revision_id: String,
    project_id: String,
    entity_type: String,
    entity_id: String,
    revision_type: String,
    base_revision_id: Option<String>,
    author_device_id: String,
    source_artifact_id: Option<String>,
    content_sha256: String,
    state: String,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    payload: Value,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProjectManifestSchema {
    schema_version: String,
    exported_at: String,
    project: SyncProjectManifestProjectSchema,
    #[serde(default)]
    entity_revisions: Vec<SyncProjectManifestEntityRevisionSchema>,
    artifacts: Vec<SyncProjectManifestArtifactSchema>,
    #[serde(default)]
    delete_tombstones: Vec<SyncDeleteTombstoneSchema>,
}

#[derive(Serialize)]
pub struct SyncProjectManifestResponse {
    project_manifest: SyncProjectManifestSchema,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProjectStatusProjectMetadataSchema {
    project_id: String,
    display_name: String,
    source_key_override: Option<String>,
    source_sha256: Option<String>,
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    channels: Option<i64>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncProjectStatusUpdateRequest {
    sync_status: String,
    sync_status_reason: Option<String>,
    sync_required_artifact_ids: Option<Vec<String>>,
    sync_provider_device_ids: Option<Vec<String>>,
    sync_conflict_count: Option<i64>,
    manifest: Option<SyncProjectManifestSchema>,
    project: Option<SyncProjectStatusProjectMetadataSchema>,
}

#[derive(Serialize)]
pub struct SyncProjectStatusUpdateResponse {
    project: ProjectSchema,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncArtifactStagingRequest {
    source_path: String,
    content_sha256: String,
    size_bytes: i64,
    provider_device_id: Option<String>,
    #[serde(default)]
    metadata: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncStagedArtifactSchema {
    content_sha256: String,
    size_bytes: i64,
    relative_path: String,
    provider_device_id: Option<String>,
    metadata: Value,
    verified_at: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncProjectStagedImportRequest {
    manifest: SyncProjectManifestSchema,
    staging_root: Option<String>,
    use_content_addressed_staging: Option<bool>,
}

#[derive(Serialize)]
pub struct SyncProjectImportResponse {
    project: ProjectSchema,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncPeerInventoryEntrySchema {
    device_id: String,
    #[serde(default)]
    available_content_sha256: Vec<String>,
    #[serde(default)]
    metadata: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationRemoteLibrarySchema {
    #[serde(default)]
    projects: Vec<SyncMetadataProjectSchema>,
    #[serde(default)]
    artifacts: Vec<SyncMetadataArtifactSchema>,
    #[serde(default)]
    entity_revisions: Vec<SyncProjectManifestEntityRevisionSchema>,
    #[serde(default)]
    delete_tombstones: Vec<SyncDeleteTombstoneSchema>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncReconciliationPlanRequest {
    remote_library: SyncReconciliationRemoteLibrarySchema,
    #[serde(default)]
    project_manifests: Vec<SyncProjectManifestSchema>,
    #[serde(default)]
    peer_inventory: Vec<SyncPeerInventoryEntrySchema>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationSummarySchema {
    total_items: usize,
    total_actions: usize,
    total_conflicts: usize,
    status_counts: std::collections::BTreeMap<String, usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationItemSchema {
    item_type: String,
    item_id: String,
    project_id: Option<String>,
    status: String,
    action_type: Option<String>,
    content_sha256: Option<String>,
    chosen_provider_device_id: Option<String>,
    reason: Option<String>,
    details: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationActionSchema {
    action_type: String,
    item_type: String,
    item_id: String,
    project_id: Option<String>,
    content_sha256: Option<String>,
    provider_device_id: Option<String>,
    reason: Option<String>,
    priority: i64,
    #[serde(default)]
    details: Value,
}

#[derive(Clone, Serialize)]
pub struct SyncReconciliationPlanResponse {
    summary: SyncReconciliationSummarySchema,
    items: Vec<SyncReconciliationItemSchema>,
    actions: Vec<SyncReconciliationActionSchema>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncReconciliationApplyRequest {
    remote_library: SyncReconciliationRemoteLibrarySchema,
    #[serde(default)]
    project_manifests: Vec<SyncProjectManifestSchema>,
    #[serde(default)]
    peer_inventory: Vec<SyncPeerInventoryEntrySchema>,
    staging_root: Option<String>,
    #[serde(default = "default_true")]
    use_content_addressed_staging: bool,
    #[serde(default)]
    project_ids: Vec<String>,
    #[serde(default)]
    include_timing_evidence: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationApplySummarySchema {
    planned_actions: usize,
    applied_actions: usize,
    satisfied_actions: usize,
    skipped_actions: usize,
    failed_actions: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationApplyActionResultSchema {
    action: SyncReconciliationActionSchema,
    status: String,
    reason: Option<String>,
    details: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncReconciliationTimingEvidenceSchema {
    phase: String,
    duration_ms: f64,
    action_type: Option<String>,
    item_type: Option<String>,
    item_id: Option<String>,
    project_id: Option<String>,
    status: Option<String>,
    details: Value,
}

#[derive(Serialize)]
pub struct SyncReconciliationApplyResponse {
    summary: SyncReconciliationApplySummarySchema,
    plan: SyncReconciliationPlanResponse,
    results: Vec<SyncReconciliationApplyActionResultSchema>,
    timing_evidence: Vec<SyncReconciliationTimingEvidenceSchema>,
}

fn default_true() -> bool {
    true
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
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_sync_identity, SyncLocalIdentityResponse, app: AppHandle);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_create_sync_pairing_offer, SyncPairingOfferResponse, app: AppHandle, payload: Option<SyncPairingOfferRequest>);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_answer_sync_pairing_offer, SyncPairingAnswerResponse, app: AppHandle, payload: SyncPairingAnswerRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_list_sync_trusted_peers, SyncTrustedPeersResponse, app: AppHandle);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_trust_sync_peer, SyncTrustedPeerResponse, app: AppHandle, payload: SyncTrustedPeerCreateRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_revoke_sync_trusted_peer, SyncTrustedPeerResponse, app: AppHandle, device_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_sync_metadata, SyncMetadataResponse, app: AppHandle);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_sync_project_manifest, SyncProjectManifestResponse, app: AppHandle, project_id: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_update_sync_project_status, SyncProjectStatusUpdateResponse, app: AppHandle, project_id: String, payload: SyncProjectStatusUpdateRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_stage_sync_artifact, SyncStagedArtifactSchema, app: AppHandle, payload: SyncArtifactStagingRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_get_sync_staged_artifact, SyncStagedArtifactSchema, app: AppHandle, content_sha256: String);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_import_sync_project, SyncProjectImportResponse, app: AppHandle, payload: SyncProjectStagedImportRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_plan_sync_reconciliation, SyncReconciliationPlanResponse, app: AppHandle, payload: SyncReconciliationPlanRequest);
#[cfg(not(target_os = "android"))]
mobile_stub!(mobile_apply_sync_reconciliation, SyncReconciliationApplyResponse, app: AppHandle, payload: SyncReconciliationApplyRequest);

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use crate::native_audio::decode::{
        read_mobile_audio, read_resampled_mono_audio, write_mono_pcm_wav,
    };
    use android_system_properties::AndroidSystemProperties;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use chrono::{DateTime, Duration, SecondsFormat, Utc};
    use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
    use rand::{rngs::OsRng, RngCore};
    use rusqlite::{params, Connection, OptionalExtension, Row};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{BTreeMap, HashMap, HashSet},
        convert::TryInto,
        fs,
        io::{self, Read},
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
    const LOCAL_IDENTITY_ID: &str = "local";
    const DEFAULT_LOCAL_DISPLAY_NAME: &str = "TuneForge Device";
    const DEVICE_ID_PREFIX: &str = "dev_ed25519_";
    const SYNC_GROUP_ID_PREFIX: &str = "syncgrp_";
    const PROJECT_COLUMNS: &str = "id, display_name, source_key_override, source_sha256, source_path, imported_path, duration_seconds, sample_rate, channels, sync_status, sync_status_reason, sync_required_artifact_ids_json, sync_provider_device_ids_json, sync_conflict_count, created_at, updated_at";
    const ARTIFACT_COLUMNS: &str = "id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at";
    const JOB_COLUMNS: &str = "id, project_id, type, status, progress, source_artifact_id, result_artifact_ids_json, error_message, runtime_device, started_at, completed_at, duration_seconds, created_at, updated_at";
    const SYNC_STAGED_ARTIFACT_COLUMNS: &str = "content_sha256, size_bytes, relative_path, provider_device_id, metadata_json, verified_at, created_at, updated_at";
    const SYNC_ENTITY_REVISION_COLUMNS: &str = "id, project_id, entity_type, entity_id, revision_type, base_revision_id, author_device_id, source_artifact_id, content_sha256, state, metadata_json, payload_json, created_at, updated_at";
    const SYNC_DELETE_TOMBSTONE_COLUMNS: &str = "id, sync_group_id, project_id, target_type, target_id, author_device_id, deleted_at, prior_metadata_json, created_at, updated_at";
    const PAIRING_PREFIX: &str = "pair_";
    const SECRET_HASH_PREFIX: &str = "sha256_";
    const PAIRING_SECRET_HASH_CONTEXT: &[u8] = b"tuneforge.sync.pairing_secret.v1\0";
    const DEFAULT_PAIRING_TTL_SECONDS: i64 = 600;
    const MAX_PAIRING_TTL_SECONDS: i64 = 3600;
    const ACTION_APPLY_DELETE_TOMBSTONE: &str = "apply_delete_tombstone";
    const ACTION_IMPORT_PROJECT_MANIFEST: &str = "import_project_manifest";
    const ACTION_IMPORT_ENTITY_REVISION: &str = "import_entity_revision";
    const ACTION_FETCH_ARTIFACT_CONTENT: &str = "fetch_artifact_content";
    const ACTION_IMPORT_ARTIFACT_MANIFEST: &str = "import_artifact_manifest";
    const ACTION_UPSERT_PROJECT_STATUS: &str = "upsert_project_status";
    const ACTION_RECORD_CONFLICT: &str = "record_conflict";
    const ACTION_NOOP: &str = "noop";

    #[derive(Clone, Debug)]
    pub struct MobileSyncTransportArtifactFile {
        pub path: PathBuf,
        pub size_bytes: u64,
    }

    const MOBILE_CORE_SCHEMA_SQL: &str = r#"
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
            source_segments_json TEXT NOT NULL,
            segments_json TEXT NOT NULL,
            has_user_edits INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    "#;

    const MOBILE_SYNC_SCHEMA_SQL: &str = r#"
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
        migrate_mobile_db(&connection)?;
        ensure_local_identity(&connection)?;
        Ok(connection)
    }

    fn migrate_mobile_db(connection: &Connection) -> Result<(), String> {
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

    fn add_mobile_sync_columns(connection: &Connection) -> Result<(), String> {
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

    fn add_column_if_missing(
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

    fn table_has_column(
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

    fn ensure_local_identity(connection: &Connection) -> Result<(), String> {
        let existing = connection
            .query_row(
                "SELECT 1 FROM sync_local_identities WHERE id = ?1",
                params![LOCAL_IDENTITY_ID],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing.is_some() {
            return Ok(());
        }

        let mut private_key_bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut private_key_bytes);
        let signing_key = SigningKey::from_bytes(&private_key_bytes);
        let public_key_bytes = signing_key.verifying_key().to_bytes();
        let timestamp = now_iso();
        connection
            .execute(
                "INSERT INTO sync_local_identities (id, sync_group_id, device_id, display_name, public_key, private_key, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    LOCAL_IDENTITY_ID,
                    new_sync_group_id(),
                    derive_device_id(&public_key_bytes),
                    DEFAULT_LOCAL_DISPLAY_NAME,
                    encode_key(&public_key_bytes),
                    encode_key(&private_key_bytes),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn new_sync_group_id() -> String {
        let mut bytes = [0_u8; 16];
        OsRng.fill_bytes(&mut bytes);
        format!("{SYNC_GROUP_ID_PREFIX}{}", encode_key(&bytes))
    }

    fn derive_device_id(public_key_bytes: &[u8; 32]) -> String {
        let digest = Sha256::digest(public_key_bytes);
        format!("{DEVICE_ID_PREFIX}{}", encode_key(&digest))
    }

    fn encode_key(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decode_key(value: &str) -> Result<Vec<u8>, String> {
        URL_SAFE_NO_PAD
            .decode(value.trim())
            .map_err(|_| "Value must be URL-safe base64.".to_string())
    }

    fn new_prefixed_token(prefix: &str, byte_count: usize) -> String {
        let mut bytes = vec![0_u8; byte_count];
        OsRng.fill_bytes(&mut bytes);
        format!("{prefix}{}", encode_key(&bytes))
    }

    fn new_pairing_offer_id() -> String {
        new_prefixed_token(PAIRING_PREFIX, 16)
    }

    fn new_pairing_secret() -> String {
        new_prefixed_token(PAIRING_PREFIX, 32)
    }

    fn hash_pairing_secret(secret: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(PAIRING_SECRET_HASH_CONTEXT);
        hasher.update(secret.as_bytes());
        format!("{SECRET_HASH_PREFIX}{}", encode_key(&hasher.finalize()))
    }

    fn local_identity(connection: &Connection) -> Result<SyncLocalIdentitySchema, String> {
        ensure_local_identity(connection)?;
        connection
            .query_row(
                "SELECT device_id, sync_group_id, display_name, public_key, created_at, updated_at FROM sync_local_identities WHERE id = ?1",
                params![LOCAL_IDENTITY_ID],
                |row| {
                    Ok(SyncLocalIdentitySchema {
                        device_id: row.get(0)?,
                        sync_group_id: row.get(1)?,
                        display_name: Some(row.get::<_, String>(2)?),
                        public_key: row.get(3)?,
                        created_at: Some(row.get(4)?),
                        updated_at: Some(row.get(5)?),
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    fn normalize_endpoint_hints(endpoint_hints: Vec<String>) -> Result<Vec<String>, String> {
        let mut normalized = Vec::with_capacity(endpoint_hints.len());
        for hint in endpoint_hints {
            let trimmed = hint.trim();
            if trimmed.is_empty() {
                return Err("Pairing endpoint_hints cannot contain empty values.".to_string());
            }
            normalized.push(trimmed.to_string());
        }
        Ok(normalized)
    }

    fn trim_optional_string(value: Option<String>) -> Option<String> {
        value.and_then(|inner| {
            let trimmed = inner.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
    }

    fn parse_utc(value: &str, field_name: &str) -> Result<DateTime<Utc>, String> {
        DateTime::parse_from_rfc3339(value)
            .map(|parsed| parsed.with_timezone(&Utc))
            .map_err(|_| format!("{field_name} must be an ISO-8601 timestamp."))
    }

    fn pairing_iso(value: DateTime<Utc>) -> String {
        let micros = value.timestamp_subsec_micros();
        if micros == 0 {
            value.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
        } else {
            value.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
        }
    }

    fn signed_pairing_payload_json(payload: &SyncPairingPayloadSchema) -> Result<String, String> {
        let expires_at = pairing_iso(parse_utc(&payload.expires_at, "expires_at")?);
        let mut signed = BTreeMap::new();
        signed.insert(
            "device_id",
            Value::String(payload.device_id.trim().to_string()),
        );
        signed.insert(
            "display_name",
            payload
                .display_name
                .as_ref()
                .map(|value| Value::String(value.trim().to_string()))
                .unwrap_or(Value::Null),
        );
        signed.insert("endpoint_hints", json!(payload.endpoint_hints));
        signed.insert("expires_at", Value::String(expires_at));
        signed.insert(
            "pairing_offer_id",
            Value::String(payload.pairing_offer_id.trim().to_string()),
        );
        signed.insert(
            "pairing_secret",
            Value::String(payload.pairing_secret.trim().to_string()),
        );
        signed.insert(
            "protocol_version",
            Value::String(payload.protocol_version.trim().to_string()),
        );
        signed.insert(
            "public_key",
            Value::String(payload.public_key.trim().to_string()),
        );
        signed.insert(
            "sync_group_id",
            Value::String(payload.sync_group_id.trim().to_string()),
        );
        serde_json::to_string(&signed).map_err(|error| error.to_string())
    }

    fn sign_pairing_payload(
        private_key: &str,
        payload: &SyncPairingPayloadSchema,
    ) -> Result<String, String> {
        let message = signed_pairing_payload_json(payload)?;
        sign_canonical_payload(private_key, &message)
    }

    fn sign_canonical_payload(private_key: &str, message: &str) -> Result<String, String> {
        let private_key_bytes: [u8; 32] = decode_key(private_key)?
            .try_into()
            .map_err(|_| "Local private key is invalid.".to_string())?;
        let signing_key = SigningKey::from_bytes(&private_key_bytes);
        let signature = signing_key.sign(message.as_bytes());
        Ok(encode_key(&signature.to_bytes()))
    }

    fn validate_pairing_payload(
        payload: SyncPairingPayloadSchema,
    ) -> Result<SyncPairingPayloadSchema, String> {
        if payload.protocol_version.trim() != SYNC_PAIRING_PROTOCOL_VERSION {
            return Err("Pairing payload uses an unsupported protocol version.".to_string());
        }
        let endpoint_hints = normalize_endpoint_hints(payload.endpoint_hints)?;
        let display_name = trim_optional_string(payload.display_name)
            .or_else(|| Some("Trusted Device".to_string()));
        let expires_at = parse_utc(&payload.expires_at, "expires_at")?;
        if expires_at <= Utc::now() {
            return Err("Pairing payload has expired.".to_string());
        }

        let public_key_bytes: [u8; 32] = decode_key(&payload.public_key)?
            .try_into()
            .map_err(|_| "Pairing payload public_key is invalid.".to_string())?;
        let expected_device_id = derive_device_id(&public_key_bytes);
        if expected_device_id != payload.device_id.trim() {
            return Err("Pairing payload device_id does not match its public_key.".to_string());
        }
        let signature_bytes = decode_key(&payload.signature)?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| "Pairing payload signature is invalid.".to_string())?;
        let normalized = SyncPairingPayloadSchema {
            sync_group_id: payload.sync_group_id.trim().to_string(),
            device_id: payload.device_id.trim().to_string(),
            display_name,
            public_key: payload.public_key.trim().to_string(),
            endpoint_hints,
            protocol_version: payload.protocol_version.trim().to_string(),
            pairing_offer_id: payload.pairing_offer_id.trim().to_string(),
            pairing_secret: payload.pairing_secret.trim().to_string(),
            expires_at: pairing_iso(expires_at),
            signature: payload.signature.trim().to_string(),
        };
        if normalized.sync_group_id.is_empty()
            || normalized.pairing_offer_id.is_empty()
            || normalized.pairing_secret.is_empty()
        {
            return Err("Pairing payload contains empty required fields.".to_string());
        }
        let verifying_key = VerifyingKey::from_bytes(&public_key_bytes)
            .map_err(|_| "Pairing payload public_key is invalid.".to_string())?;
        let message = signed_pairing_payload_json(&normalized)?;
        verifying_key
            .verify(message.as_bytes(), &signature)
            .map_err(|_| "Pairing payload signature is invalid.".to_string())?;
        Ok(normalized)
    }

    fn validate_pairing_peer_identity(
        connection: &Connection,
        payload: &SyncPairingPayloadSchema,
        adopt_sync_group: bool,
    ) -> Result<(), String> {
        let identity = local_identity(connection)?;
        if payload.device_id == identity.device_id {
            return Err("Cannot trust this device's own pairing payload.".to_string());
        }
        if payload.sync_group_id != identity.sync_group_id {
            let active_peer_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_trusted_peers WHERE revoked_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !adopt_sync_group || active_peer_count > 0 {
                return Err("Pairing payload belongs to a different sync group.".to_string());
            }
            connection
                .execute(
                    "UPDATE sync_local_identities SET sync_group_id = ?1, updated_at = ?2 WHERE id = ?3",
                    params![payload.sync_group_id, now_iso(), LOCAL_IDENTITY_ID],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn upsert_trusted_peer(
        connection: &Connection,
        payload: &SyncPairingPayloadSchema,
    ) -> Result<SyncTrustedPeerSchema, String> {
        let now = now_iso();
        let existing_public_key_peer: Option<String> = connection
            .query_row(
                "SELECT device_id FROM sync_trusted_peers WHERE public_key = ?1",
                params![payload.public_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing_public_key_peer
            .as_deref()
            .is_some_and(|device_id| device_id != payload.device_id)
        {
            return Err(
                "Pairing payload public_key is already trusted for a different device.".to_string(),
            );
        }

        connection
            .execute(
                "INSERT INTO sync_trusted_peers (device_id, sync_group_id, display_name, public_key, endpoint_hints_json, trusted_at, revoked_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?6, ?6)
                 ON CONFLICT(device_id) DO UPDATE SET sync_group_id = excluded.sync_group_id, display_name = excluded.display_name, public_key = excluded.public_key, endpoint_hints_json = excluded.endpoint_hints_json, trusted_at = excluded.trusted_at, revoked_at = NULL, updated_at = excluded.updated_at",
                params![
                    payload.device_id,
                    payload.sync_group_id,
                    payload.display_name,
                    payload.public_key,
                    serde_json::to_string(&payload.endpoint_hints).map_err(|error| error.to_string())?,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
        get_trusted_peer(connection, &payload.device_id)
    }

    fn find_trusted_peer(
        connection: &Connection,
        device_id: &str,
    ) -> Result<Option<SyncTrustedPeerSchema>, String> {
        connection
            .query_row(
                "SELECT device_id, sync_group_id, display_name, public_key, endpoint_hints_json, trusted_at, revoked_at, updated_at FROM sync_trusted_peers WHERE device_id = ?1",
                params![device_id],
                row_trusted_peer,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    fn get_trusted_peer(
        connection: &Connection,
        device_id: &str,
    ) -> Result<SyncTrustedPeerSchema, String> {
        find_trusted_peer(connection, device_id)?
            .ok_or_else(|| "Trusted peer is unknown.".to_string())
    }

    fn row_project(row: &Row<'_>) -> rusqlite::Result<ProjectSchema> {
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

    fn row_artifact(row: &Row<'_>) -> rusqlite::Result<ArtifactSchema> {
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

    fn row_job(row: &Row<'_>) -> rusqlite::Result<JobSchema> {
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

    fn list_project_display_names(
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

    fn row_trusted_peer(row: &Row<'_>) -> rusqlite::Result<SyncTrustedPeerSchema> {
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

    fn row_staged_artifact(row: &Row<'_>) -> rusqlite::Result<SyncStagedArtifactSchema> {
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

    fn row_entity_revision(
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

    fn row_delete_tombstone(row: &Row<'_>) -> rusqlite::Result<SyncDeleteTombstoneSchema> {
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

    fn get_project_schema(
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

    fn require_sync_editable_project(
        connection: &Connection,
        project_id: &str,
    ) -> Result<ProjectSchema, String> {
        let project = get_project_schema(connection, project_id)?;
        require_sync_editable_status(&project.sync_status)?;
        Ok(project)
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
                &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 AND type = 'source_audio' ORDER BY created_at DESC LIMIT 1"),
                params![project_id],
                row_artifact,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Source audio is missing.".to_string())
    }

    fn project_root_path(root: &Path, project_id: &str) -> Result<PathBuf, String> {
        let canonical_project_id = validate_canonical_project_id(project_id)?;
        let projects_root = root.join("projects");
        let project_root = projects_root.join(canonical_project_id);
        if !project_root.starts_with(&projects_root) {
            return Err("Project path escapes the mobile app data root.".to_string());
        }
        Ok(project_root)
    }

    fn project_cleanup_root_path(root: &Path, project_id: &str) -> Result<PathBuf, String> {
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

    fn safe_relative_path(relative_path: &str) -> Result<PathBuf, String> {
        let mut path = PathBuf::new();
        for part in safe_sync_relative_path_parts(relative_path)? {
            path.push(part);
        }
        Ok(path)
    }

    fn ensure_mobile_project_dirs(root: &Path, project_id: &str) -> Result<(), String> {
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

    fn relative_artifact_path(root: &Path, artifact: &ArtifactSchema) -> Option<String> {
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

    fn manifest_artifact_from_artifact(
        root: &Path,
        artifact: ArtifactSchema,
    ) -> Result<SyncProjectManifestArtifactSchema, String> {
        let relative_path = relative_artifact_path(root, &artifact).ok_or_else(|| {
            "Project artifact path is outside the mobile app data root.".to_string()
        })?;
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

    fn project_source_sha256(project: &ProjectSchema) -> Result<String, String> {
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

    fn find_existing_project_source(
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

    fn list_project_artifacts(
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

    fn list_project_entity_revisions(
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

    fn list_project_delete_tombstones(
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

    fn sanitize_entity_revision_for_manifest(
        mut revision: SyncProjectManifestEntityRevisionSchema,
    ) -> SyncProjectManifestEntityRevisionSchema {
        revision.metadata = sanitize_sync_manifest_value(&revision.metadata);
        revision.payload = sanitize_sync_manifest_value(&revision.payload);
        revision
    }

    fn get_project_manifest(
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

    fn staged_artifact_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
        let relative = safe_relative_path(relative_path)?;
        let staging_root = root.join("sync").join("staging");
        let resolved = staging_root.join(relative);
        if !resolved.starts_with(&staging_root) {
            return Err("Staged artifact path escapes the mobile app data root.".to_string());
        }
        Ok(resolved)
    }

    fn verify_staged_artifact(
        root: &Path,
        staged: &SyncStagedArtifactSchema,
        expected_size_bytes: Option<i64>,
    ) -> Result<PathBuf, String> {
        if let Some(size_bytes) = expected_size_bytes {
            if size_bytes != staged.size_bytes {
                return Err(
                    "Staged artifact record size does not match requested size.".to_string()
                );
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

    fn get_staged_artifact(
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

    fn stage_sync_artifact(
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
                "Source artifact size does not match the requested staged artifact size."
                    .to_string(),
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

    fn normalize_sync_status(value: &str) -> Result<String, String> {
        let normalized = value.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "local" | "syncing" | "remote_available" | "downloading" | "missing" | "deleted"
            | "conflicted" => Ok(normalized),
            _ => Err("Project sync status is not supported.".to_string()),
        }
    }

    fn normalize_string_ids(values: Option<Vec<String>>) -> Result<Vec<String>, String> {
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

    fn metadata_from_status_payload(
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
            validate_project_source_identity(
                &project.project_id,
                project.source_sha256.as_deref(),
            )?;
            return Ok(Some(project.clone()));
        }
        Ok(None)
    }

    fn create_project_placeholder(
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

    fn verify_project_local_bytes(
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

    fn update_project_sync_status(
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

    fn local_sync_group_and_device(connection: &Connection) -> Result<(String, String), String> {
        let identity = local_identity(connection)?;
        Ok((identity.sync_group_id, identity.device_id))
    }

    fn normalize_tombstone_target_type(target_type: &str) -> String {
        match target_type.trim().to_ascii_lowercase().as_str() {
            "revision" | "sync_entity_revision" => "entity_revision".to_string(),
            other => other.to_string(),
        }
    }

    fn validate_remote_delete_tombstone(
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
            return Err(
                "Remote project delete tombstone target_id must match project_id.".to_string(),
            );
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

    fn validate_manifest_delete_tombstones(
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

    fn upsert_delete_tombstone(
        connection: &Connection,
        tombstone: &SyncDeleteTombstoneSchema,
    ) -> Result<(), String> {
        let target_type = normalize_tombstone_target_type(&tombstone.target_type);
        let prior_metadata_json =
            sanitize_sync_manifest_value(&tombstone.prior_metadata).to_string();
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

    fn record_local_delete_tombstone(
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

    fn apply_delete_tombstone(
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

    fn local_tombstone_superseded_by_live_target(
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

    fn validate_project_manifest_identity(
        manifest: &SyncProjectManifestSchema,
    ) -> Result<(), String> {
        validate_sync_project_manifest_identity(manifest)
    }

    fn import_entity_revisions(
        connection: &Connection,
        revisions: &[SyncProjectManifestEntityRevisionSchema],
    ) -> Result<(), String> {
        for revision in revisions {
            let existing_hash: Option<String> = connection
                .query_row(
                    "SELECT content_sha256 FROM sync_entity_revisions WHERE id = ?1",
                    params![revision.revision_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(existing_hash) = existing_hash {
                if existing_hash != revision.content_sha256 {
                    return Err(
                        "A synced entity revision conflicts with an existing local revision."
                            .to_string(),
                    );
                }
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

    fn artifact_staged_source_path(
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

    fn artifact_file_matches(path: &Path, content_sha256: &str, size_bytes: i64) -> bool {
        if !path.is_file() {
            return false;
        }
        let Ok(metadata) = fs::metadata(path) else {
            return false;
        };
        metadata.len() as i64 == size_bytes
            && file_sha256(path).ok().as_deref() == Some(content_sha256)
    }

    fn cleanup_copied_artifacts(paths: &[PathBuf]) {
        for path in paths {
            let _ = fs::remove_file(path);
        }
    }

    fn can_upgrade_project_placeholder(
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

    fn delete_project_rows(connection: &Connection, project_id: &str) -> Result<(), String> {
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

    fn discard_deleted_project_placeholders(
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

    fn clear_project_delete_tombstones_for_reimport(
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

    fn import_sync_project_manifest(
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
        let source_sha256 =
            normalize_sha256(&payload.manifest.project.source_sha256, "source_sha256")?;
        if let Some(existing) =
            find_existing_project_source(connection, &project_id, &source_sha256)?
        {
            if existing.id != project_id
                || existing
                    .source_sha256
                    .as_deref()
                    .is_some_and(|existing_hash| existing_hash != source_sha256.as_str())
            {
                return Err(
                    "A synced project manifest conflicts with an existing local project."
                        .to_string(),
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
                    "UPDATE projects SET sync_status = 'local', sync_status_reason = NULL, sync_required_artifact_ids_json = ?1, sync_provider_device_ids_json = ?1, sync_conflict_count = 0, sync_status_updated_at = ?2, updated_at = ?2 WHERE id = ?3",
                    params![DEFAULT_SYNC_LIST_JSON, &timestamp, &project_id],
                )
                .map_err(|error| error.to_string())?;
            for tombstone in &payload.manifest.delete_tombstones {
                apply_delete_tombstone(connection, tombstone)?;
            }
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

    fn active_trusted_device_ids(connection: &Connection) -> Result<HashSet<String>, String> {
        let identity = local_identity(connection)?;
        let mut statement = connection
            .prepare(
                "SELECT device_id FROM sync_trusted_peers WHERE revoked_at IS NULL AND sync_group_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![identity.sync_group_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        let mut device_ids = HashSet::new();
        for row in rows {
            device_ids.insert(row.map_err(|error| error.to_string())?);
        }
        Ok(device_ids)
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
            add_effective_tombstone_target(&mut effective_tombstone_targets, &tombstone);
            let reason = "A valid delete tombstone wins over remote manifests.";
            items.push(reconciliation_item(
                &normalize_tombstone_target_type(&tombstone.target_type),
                &tombstone.target_id,
                Some(tombstone.project_id.clone()),
                "deleted",
                Some(ACTION_APPLY_DELETE_TOMBSTONE),
                None,
                None,
                reason,
                json!({"tombstone_id": tombstone.tombstone_id}),
            ));
            actions.push(reconciliation_action(
                ACTION_APPLY_DELETE_TOMBSTONE,
                &normalize_tombstone_target_type(&tombstone.target_type),
                &tombstone.target_id,
                Some(tombstone.project_id.clone()),
                None,
                None,
                "Apply valid sync delete tombstone before imports or fetches.",
                json!({"tombstone_id": tombstone.tombstone_id}),
            ));
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
            let reason =
                "Every project manifest artifact is local or advertised by a trusted peer.";
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

    fn apply_reconciliation_action(
        connection: &Connection,
        root: &Path,
        action: SyncReconciliationActionSchema,
        payload: &SyncReconciliationApplyRequest,
    ) -> SyncReconciliationApplyActionResultSchema {
        let result = (|| -> Result<(&'static str, &'static str, Value), String> {
            match action.action_type.as_str() {
                ACTION_NOOP => Ok(("satisfied", "Action is already satisfied.", json!({}))),
                ACTION_FETCH_ARTIFACT_CONTENT => {
                    let content_sha256 = action.content_sha256.as_ref().ok_or_else(|| {
                        "Fetch action does not identify content_sha256.".to_string()
                    })?;
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
                            use_content_addressed_staging: Some(
                                payload.use_content_addressed_staging,
                            ),
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
                            use_content_addressed_staging: Some(
                                payload.use_content_addressed_staging,
                            ),
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
                    import_entity_revisions(connection, std::slice::from_ref(revision))?;
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
                                    && action.project_id.as_deref().map_or(true, |project_id| {
                                        project_id == tombstone.project_id
                                    })
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

        let project_root = project_root_path(root, project_id)?;
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

        let analysis_dir = project_root_path(root, &project.id)?.join("analysis");
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
        let content_sha256 = file_sha256(&analysis_path)?;
        connection
            .execute(
                "DELETE FROM artifacts WHERE project_id = ?1 AND type = 'analysis_json'",
                params![project.id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at)
                 VALUES (?1, ?2, 'analysis_json', 'json', ?3, ?4, ?5, 'analysis', 0, 1, ?6, NULL, ?7)",
                params![
                    new_id("art"),
                    project.id,
                    analysis_path.to_string_lossy().into_owned(),
                    content_sha256,
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

        let chord_path = project_root_path(root, &project.id)?
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
        let lyrics_path = project_root_path(root, &lyrics.project_id)?
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

    fn file_sha256(path: &Path) -> Result<String, String> {
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

    fn hex_digest(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
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
    pub fn mobile_get_sync_identity(app: AppHandle) -> Result<SyncLocalIdentityResponse, String> {
        let connection = db(&app)?;
        Ok(SyncLocalIdentityResponse {
            identity: local_identity(&connection)?,
        })
    }

    pub fn mobile_sign_transport_handshake(
        app: AppHandle,
        peer_device_id: String,
        challenge: Value,
    ) -> Result<Value, String> {
        if peer_device_id != peer_device_id.trim() || peer_device_id.is_empty() {
            return Err("peer_device_id must be canonical.".to_string());
        }
        if peer_device_id.len() > 128 {
            return Err("peer_device_id is too long.".to_string());
        }
        let connection = db(&app)?;
        let identity = local_identity(&connection)?;
        let trusted_peer = find_trusted_peer(&connection, &peer_device_id)?;
        validate_transport_trusted_peer(trusted_peer.as_ref(), &identity.sync_group_id)?;
        let canonical_challenge = canonical_transport_handshake_challenge(
            &challenge,
            &identity.device_id,
            &peer_device_id,
            Utc::now(),
        )?;
        let canonical_challenge_json = transport_handshake_challenge_json(&canonical_challenge)?;
        let private_key: String = connection
            .query_row(
                "SELECT private_key FROM sync_local_identities WHERE id = ?1",
                params![LOCAL_IDENTITY_ID],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let signature = sign_canonical_payload(&private_key, &canonical_challenge_json)?;
        Ok(transport_handshake_proof_value(
            &identity.device_id,
            &peer_device_id,
            &identity.public_key,
            canonical_challenge,
            canonical_challenge_json,
            signature,
            Utc::now(),
        ))
    }

    #[tauri::command]
    pub fn mobile_create_sync_pairing_offer(
        app: AppHandle,
        payload: Option<SyncPairingOfferRequest>,
    ) -> Result<SyncPairingOfferResponse, String> {
        let payload = payload.unwrap_or(SyncPairingOfferRequest {
            endpoint_hints: Vec::new(),
            ttl_seconds: None,
        });
        let ttl_seconds = payload.ttl_seconds.unwrap_or(DEFAULT_PAIRING_TTL_SECONDS);
        if ttl_seconds <= 0 || ttl_seconds > MAX_PAIRING_TTL_SECONDS {
            return Err(format!(
                "Pairing offer ttl_seconds must be between 1 and {MAX_PAIRING_TTL_SECONDS}."
            ));
        }
        let endpoint_hints = normalize_endpoint_hints(payload.endpoint_hints)?;
        let connection = db(&app)?;
        let identity = local_identity(&connection)?;
        let expires_at = Utc::now() + Duration::seconds(ttl_seconds);
        let expires_at_payload = pairing_iso(expires_at);
        let pairing_offer_id = new_pairing_offer_id();
        let pairing_secret = new_pairing_secret();
        let mut pairing_payload = SyncPairingPayloadSchema {
            sync_group_id: identity.sync_group_id.clone(),
            device_id: identity.device_id.clone(),
            display_name: identity.display_name.clone(),
            public_key: identity.public_key.clone(),
            endpoint_hints,
            protocol_version: SYNC_PAIRING_PROTOCOL_VERSION.to_string(),
            pairing_offer_id: pairing_offer_id.clone(),
            pairing_secret: pairing_secret.clone(),
            expires_at: expires_at_payload.clone(),
            signature: String::new(),
        };
        let private_key: String = connection
            .query_row(
                "SELECT private_key FROM sync_local_identities WHERE id = ?1",
                params![LOCAL_IDENTITY_ID],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        pairing_payload.signature = sign_pairing_payload(&private_key, &pairing_payload)?;
        connection
            .execute(
                "INSERT INTO sync_pairing_offers (id, secret_hash, endpoint_hints_json, expires_at, used_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                params![
                    pairing_offer_id,
                    hash_pairing_secret(&pairing_secret),
                    serde_json::to_string(&pairing_payload.endpoint_hints).map_err(|error| error.to_string())?,
                    expires_at_payload,
                    now_iso(),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(SyncPairingOfferResponse {
            pairing_offer: SyncPairingOfferSchema {
                payload: pairing_payload,
                expires_at: expires_at_payload,
                ttl_seconds: Some(ttl_seconds),
            },
        })
    }

    #[tauri::command]
    pub fn mobile_answer_sync_pairing_offer(
        app: AppHandle,
        payload: SyncPairingAnswerRequest,
    ) -> Result<SyncPairingAnswerResponse, String> {
        let connection = db(&app)?;
        let offer = validate_pairing_payload(payload.offer)?;
        validate_pairing_peer_identity(&connection, &offer, payload.adopt_sync_group)?;
        let trusted_peer = upsert_trusted_peer(&connection, &offer)?;
        let identity = local_identity(&connection)?;
        let private_key: String = connection
            .query_row(
                "SELECT private_key FROM sync_local_identities WHERE id = ?1",
                params![LOCAL_IDENTITY_ID],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let mut response = SyncPairingPayloadSchema {
            sync_group_id: identity.sync_group_id,
            device_id: identity.device_id,
            display_name: identity.display_name,
            public_key: identity.public_key,
            endpoint_hints: normalize_endpoint_hints(payload.endpoint_hints)?,
            protocol_version: SYNC_PAIRING_PROTOCOL_VERSION.to_string(),
            pairing_offer_id: offer.pairing_offer_id,
            pairing_secret: offer.pairing_secret,
            expires_at: offer.expires_at,
            signature: String::new(),
        };
        response.signature = sign_pairing_payload(&private_key, &response)?;
        Ok(SyncPairingAnswerResponse {
            pairing_response: response,
            trusted_peer,
        })
    }

    #[tauri::command]
    pub fn mobile_list_sync_trusted_peers(
        app: AppHandle,
    ) -> Result<SyncTrustedPeersResponse, String> {
        let connection = db(&app)?;
        let mut statement = connection
            .prepare(
                "SELECT device_id, sync_group_id, display_name, public_key, endpoint_hints_json, trusted_at, revoked_at, updated_at FROM sync_trusted_peers WHERE revoked_at IS NULL ORDER BY display_name ASC, device_id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], row_trusted_peer)
            .map_err(|error| error.to_string())?;
        let mut trusted_peers = Vec::new();
        for row in rows {
            trusted_peers.push(row.map_err(|error| error.to_string())?);
        }
        Ok(SyncTrustedPeersResponse { trusted_peers })
    }

    #[tauri::command]
    pub fn mobile_trust_sync_peer(
        app: AppHandle,
        payload: SyncTrustedPeerCreateRequest,
    ) -> Result<SyncTrustedPeerResponse, String> {
        let connection = db(&app)?;
        let pairing_payload = validate_pairing_payload(payload.payload)?;
        validate_pairing_peer_identity(&connection, &pairing_payload, payload.adopt_sync_group)?;
        let local_offer = connection
            .query_row(
                "SELECT secret_hash, expires_at, used_at FROM sync_pairing_offers WHERE id = ?1",
                params![pairing_payload.pairing_offer_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Pairing offer is unknown.".to_string())?;
        if local_offer.2.is_some() {
            return Err("Pairing offer has already been used.".to_string());
        }
        if parse_utc(&local_offer.1, "expires_at")? <= Utc::now() {
            return Err("Pairing offer has expired.".to_string());
        }
        if local_offer.0 != hash_pairing_secret(&pairing_payload.pairing_secret) {
            return Err("Pairing payload secret does not match the local offer.".to_string());
        }
        let trusted_peer = upsert_trusted_peer(&connection, &pairing_payload)?;
        connection
            .execute(
                "UPDATE sync_pairing_offers SET used_at = ?1 WHERE id = ?2",
                params![now_iso(), pairing_payload.pairing_offer_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(SyncTrustedPeerResponse { trusted_peer })
    }

    #[tauri::command]
    pub fn mobile_revoke_sync_trusted_peer(
        app: AppHandle,
        device_id: String,
    ) -> Result<SyncTrustedPeerResponse, String> {
        let connection = db(&app)?;
        let normalized = device_id.trim().to_string();
        if normalized.is_empty() {
            return Err("device_id must not be empty.".to_string());
        }
        let timestamp = now_iso();
        let updated = connection
            .execute(
                "UPDATE sync_trusted_peers SET revoked_at = ?1, updated_at = ?1 WHERE device_id = ?2",
                params![timestamp, normalized],
            )
            .map_err(|error| error.to_string())?;
        if updated == 0 {
            return Err("Trusted peer is unknown.".to_string());
        }
        Ok(SyncTrustedPeerResponse {
            trusted_peer: get_trusted_peer(&connection, &normalized)?,
        })
    }

    #[tauri::command]
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

    #[tauri::command]
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

    #[tauri::command]
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

    #[tauri::command]
    pub fn mobile_stage_sync_artifact(
        app: AppHandle,
        payload: SyncArtifactStagingRequest,
    ) -> Result<SyncStagedArtifactSchema, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        stage_sync_artifact(&connection, &root, payload)
    }

    #[tauri::command]
    pub fn mobile_get_sync_staged_artifact(
        app: AppHandle,
        content_sha256: String,
    ) -> Result<SyncStagedArtifactSchema, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        get_staged_artifact(&connection, &root, &content_sha256, None)
    }

    fn sync_transport_value<T: Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|error| error.to_string())
    }

    pub fn mobile_sync_transport_local_identity_value(app: AppHandle) -> Result<Value, String> {
        sync_transport_value(mobile_get_sync_identity(app)?)
    }

    pub fn mobile_sync_transport_trusted_peers_value(app: AppHandle) -> Result<Value, String> {
        sync_transport_value(mobile_list_sync_trusted_peers(app)?)
    }

    pub fn mobile_sync_transport_create_pairing_offer_value(
        app: AppHandle,
        endpoint_hints: Vec<String>,
        ttl_seconds: i64,
    ) -> Result<Value, String> {
        sync_transport_value(mobile_create_sync_pairing_offer(
            app,
            Some(SyncPairingOfferRequest {
                endpoint_hints,
                ttl_seconds: Some(ttl_seconds),
            }),
        )?)
    }

    pub fn mobile_sync_transport_metadata_value(app: AppHandle) -> Result<Value, String> {
        sync_transport_value(mobile_get_sync_metadata(app)?)
    }

    pub fn mobile_sync_transport_project_manifest_value(
        app: AppHandle,
        project_id: String,
    ) -> Result<Value, String> {
        sync_transport_value(mobile_get_sync_project_manifest(app, project_id)?)
    }

    pub fn mobile_sync_transport_staged_artifact_value(
        app: AppHandle,
        content_sha256: String,
    ) -> Result<Value, String> {
        sync_transport_value(mobile_get_sync_staged_artifact(app, content_sha256)?)
    }

    pub fn mobile_sync_transport_stage_artifact_value(
        app: AppHandle,
        body: Value,
    ) -> Result<Value, String> {
        let payload = serde_json::from_value::<SyncArtifactStagingRequest>(body)
            .map_err(|error| error.to_string())?;
        sync_transport_value(mobile_stage_sync_artifact(app, payload)?)
    }

    pub fn mobile_sync_transport_reconciliation_plan_value(
        app: AppHandle,
        body: Value,
    ) -> Result<Value, String> {
        let payload = serde_json::from_value::<SyncReconciliationPlanRequest>(body)
            .map_err(|error| error.to_string())?;
        sync_transport_value(mobile_plan_sync_reconciliation(app, payload)?)
    }

    pub fn mobile_sync_transport_reconciliation_apply_value(
        app: AppHandle,
        body: Value,
    ) -> Result<Value, String> {
        let payload = serde_json::from_value::<SyncReconciliationApplyRequest>(body)
            .map_err(|error| error.to_string())?;
        sync_transport_value(mobile_apply_sync_reconciliation(app, payload)?)
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
        let relative_path = relative_artifact_path(&root, &artifact).ok_or_else(|| {
            "Project artifact path is outside the mobile app data root.".to_string()
        })?;
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

    #[tauri::command]
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

    #[tauri::command]
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

    #[tauri::command]
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
        let existing_project =
            find_existing_project_source(&connection, &project_id, &source_sha256)?;
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

    #[tauri::command]
    pub fn mobile_delete_project(
        app: AppHandle,
        project_id: String,
    ) -> Result<DeleteResponse, String> {
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

    #[tauri::command]
    pub fn mobile_submit_analyze(
        app: AppHandle,
        project_id: String,
    ) -> Result<JobResponse, String> {
        let connection = db(&app)?;
        let root = app_data_root(&app)?;
        let project = require_sync_editable_project(&connection, &project_id)?;
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
        let project = require_sync_editable_project(&connection, &project_id)?;
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
        let project = require_sync_editable_project(&connection, &project_id)?;
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
        let _ = require_sync_editable_project(&connection, &project_id)?;
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
        let _ = require_sync_editable_project(&connection, &project_id)?;
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
        let _ = require_sync_editable_project(&connection, &project_id)?;
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
        let _ = require_sync_editable_project(&connection, &project_id)?;
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
        let _ = require_sync_editable_project(&connection, &project_id)?;
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

    #[tauri::command]
    pub fn mobile_delete_artifact(
        app: AppHandle,
        project_id: String,
        artifact_id: String,
    ) -> Result<DeleteResponse, String> {
        let connection = db(&app)?;
        let _ = require_sync_editable_project(&connection, &project_id)?;
        let artifact = connection
            .query_row(
                &format!(
                    "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1 AND project_id = ?2"
                ),
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

    #[tauri::command]
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

    #[tauri::command]
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

    #[tauri::command]
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

    #[tauri::command]
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
}

#[cfg(target_os = "android")]
pub use android::*;

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
    fn mobile_sync_defaults_match_local_project_contract() {
        assert_eq!(MOBILE_DB_VERSION, 2);
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
