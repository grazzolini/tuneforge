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
    updated_at: String,
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
    stage: Option<String>,
    stage_label: Option<String>,
    source_artifact_id: Option<String>,
    result_artifact_ids: Vec<String>,
    chord_backend: Option<String>,
    chord_backend_fallback_from: Option<String>,
    chord_source: Option<String>,
    error_message: Option<String>,
    runtime_device: Option<String>,
    runtime_detail: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    duration_seconds: Option<f64>,
    export_result: Option<Value>,
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
    language_override: Option<String>,
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
    #[serde(default = "default_true")]
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

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct SyncTrustedPeerEndpointHintsRequest {
    endpoint_hints: Vec<String>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn payload_lyrics_language_override(payload: &Value) -> Result<Option<String>, String> {
    match payload.get("language_override") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                return Ok(None);
            }
            if LYRICS_LANGUAGE_OVERRIDE_CODES.contains(&normalized.as_str()) {
                Ok(Some(normalized))
            } else {
                Err(LYRICS_LANGUAGE_OVERRIDE_ERROR.to_string())
            }
        }
        Some(_) => Err("language_override must be a string or null.".to_string()),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn no_lyrics_transcript_metadata() -> (
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
    Option<String>,
) {
    (
        LYRICS_BACKEND_NONE,
        LYRICS_SOURCE_KIND_INSTRUMENTAL,
        None,
        None,
        None,
    )
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
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    created_at: String,
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
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
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    created_at: String,
    #[serde(default, deserialize_with = "deserialize_optional_sync_timestamp")]
    updated_at: Option<String>,
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
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    deleted_at: String,
    #[serde(default)]
    prior_metadata: Value,
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    created_at: String,
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
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
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    created_at: String,
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
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
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    created_at: String,
    #[serde(default, deserialize_with = "deserialize_optional_sync_timestamp")]
    updated_at: Option<String>,
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
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    created_at: String,
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
    updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProjectManifestSchema {
    schema_version: String,
    #[serde(deserialize_with = "deserialize_sync_timestamp")]
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
    #[serde(default, deserialize_with = "deserialize_optional_sync_timestamp")]
    created_at: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_sync_timestamp")]
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

#[cfg(test)]
mod tests {
    use super::ProjectImportRequest;

    #[test]
    fn project_import_request_defaults_copy_into_project_to_true() {
        let request: ProjectImportRequest =
            serde_json::from_str(r#"{"source_path":"/music/song.wav"}"#).unwrap();

        assert!(request.copy_into_project);
    }
}
