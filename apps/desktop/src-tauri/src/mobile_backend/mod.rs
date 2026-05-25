use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

include!("constants.rs");
include!("schemas.rs");
include!("helpers.rs");

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
pub use android::{
    mobile_sign_transport_handshake, mobile_sync_transport_artifact_file,
    mobile_sync_transport_create_pairing_offer_value, mobile_sync_transport_local_identity_value,
    mobile_sync_transport_metadata_value, mobile_sync_transport_project_manifest_value,
    mobile_sync_transport_reconciliation_apply_value,
    mobile_sync_transport_reconciliation_plan_value, mobile_sync_transport_stage_artifact_value,
    mobile_sync_transport_staged_artifact_value, mobile_sync_transport_trusted_peers_value,
};

#[cfg(not(target_os = "android"))]
mod stubs;
#[cfg(not(target_os = "android"))]
pub use stubs::*;

macro_rules! android_command {
    ($name:ident, $ret:ty $(, $arg:ident : $ty:ty)*) => {
        #[cfg(target_os = "android")]
        #[tauri::command]
        pub fn $name($($arg: $ty,)*) -> Result<$ret, String> {
            android::$name($($arg,)*)
        }
    };
}

android_command!(mobile_capabilities, MobileCapabilities, app: tauri::AppHandle);
android_command!(mobile_get_health, HealthResponse, app: tauri::AppHandle);
android_command!(mobile_list_projects, ProjectsResponse, app: tauri::AppHandle, params: Option<ListProjectsParams>);
android_command!(mobile_import_project, ProjectResponse, app: tauri::AppHandle, payload: ProjectImportRequest);
android_command!(mobile_get_project, ProjectResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_update_project, ProjectResponse, app: tauri::AppHandle, project_id: String, payload: ProjectUpdateRequest);
android_command!(mobile_delete_project, DeleteResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_submit_analyze, JobResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_get_analysis, AnalysisResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_submit_chords, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_get_chords, ChordResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_submit_lyrics, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_get_lyrics, LyricsResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_update_lyrics, LyricsResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_submit_preview, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_submit_stems, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_submit_retune, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_submit_transpose, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_list_artifacts, ArtifactsResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_delete_artifact, DeleteResponse, app: tauri::AppHandle, project_id: String, artifact_id: String);
android_command!(mobile_submit_export, JobResponse, app: tauri::AppHandle, project_id: String, payload: Value);
android_command!(mobile_list_jobs, JobsResponse, app: tauri::AppHandle, params: Option<ListJobsParams>);
android_command!(mobile_get_job, JobResponse, app: tauri::AppHandle, job_id: String);
android_command!(mobile_cancel_job, JobResponse, app: tauri::AppHandle, job_id: String);
android_command!(mobile_get_sync_identity, SyncLocalIdentityResponse, app: tauri::AppHandle);
android_command!(mobile_create_sync_pairing_offer, SyncPairingOfferResponse, app: tauri::AppHandle, payload: Option<SyncPairingOfferRequest>);
android_command!(mobile_answer_sync_pairing_offer, SyncPairingAnswerResponse, app: tauri::AppHandle, payload: SyncPairingAnswerRequest);
android_command!(mobile_list_sync_trusted_peers, SyncTrustedPeersResponse, app: tauri::AppHandle);
android_command!(mobile_trust_sync_peer, SyncTrustedPeerResponse, app: tauri::AppHandle, payload: SyncTrustedPeerCreateRequest);
android_command!(mobile_revoke_sync_trusted_peer, SyncTrustedPeerResponse, app: tauri::AppHandle, device_id: String);
android_command!(mobile_get_sync_metadata, SyncMetadataResponse, app: tauri::AppHandle);
android_command!(mobile_get_sync_project_manifest, SyncProjectManifestResponse, app: tauri::AppHandle, project_id: String);
android_command!(mobile_update_sync_project_status, SyncProjectStatusUpdateResponse, app: tauri::AppHandle, project_id: String, payload: SyncProjectStatusUpdateRequest);
android_command!(mobile_stage_sync_artifact, SyncStagedArtifactSchema, app: tauri::AppHandle, payload: SyncArtifactStagingRequest);
android_command!(mobile_get_sync_staged_artifact, SyncStagedArtifactSchema, app: tauri::AppHandle, content_sha256: String);
android_command!(mobile_import_sync_project, SyncProjectImportResponse, app: tauri::AppHandle, payload: SyncProjectStagedImportRequest);
android_command!(mobile_plan_sync_reconciliation, SyncReconciliationPlanResponse, app: tauri::AppHandle, payload: SyncReconciliationPlanRequest);
android_command!(mobile_apply_sync_reconciliation, SyncReconciliationApplyResponse, app: tauri::AppHandle, payload: SyncReconciliationApplyRequest);
