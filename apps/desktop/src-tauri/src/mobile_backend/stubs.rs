use super::*;
use serde_json::Value;
use tauri::AppHandle;

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
mobile_stub!(mobile_submit_lyrics, JobResponse, app: AppHandle, project_id: String, payload: Value);
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
