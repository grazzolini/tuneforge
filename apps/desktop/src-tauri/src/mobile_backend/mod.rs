use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

#[cfg(all(test, not(target_os = "android")))]
use crate::native_audio::decode::{read_mobile_audio, write_mono_pcm_wav};
#[cfg(all(test, not(target_os = "android")))]
use chrono::{SecondsFormat, Utc};
#[cfg(all(test, not(target_os = "android")))]
use rusqlite::{params, Connection, OptionalExtension, Row};
#[cfg(all(test, not(target_os = "android")))]
use serde_json::json;
#[cfg(all(test, not(target_os = "android")))]
use sha2::{Digest, Sha256};
#[cfg(all(test, not(target_os = "android")))]
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    str::FromStr,
    thread,
    time::Instant,
};
#[cfg(all(test, not(target_os = "android")))]
use tauri::{AppHandle, Manager};
#[cfg(all(test, not(target_os = "android")))]
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

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
    mobile_sync_transport_reconciliation_plan_value,
    mobile_sync_transport_refresh_peer_endpoint_hints_value,
    mobile_sync_transport_stage_artifact_value, mobile_sync_transport_staged_artifact_value,
    mobile_sync_transport_trusted_peers_value,
    mobile_sync_transport_update_trusted_peer_endpoint_hints_value,
};

#[cfg(not(target_os = "android"))]
mod stubs;
#[cfg(not(target_os = "android"))]
pub use stubs::*;

#[cfg(all(test, not(target_os = "android")))]
#[allow(dead_code)]
#[path = "storage.rs"]
mod storage;
#[cfg(all(test, not(target_os = "android")))]
use self::storage::{
    app_data_root, create_completed_job, create_failed_job, db, db_at_root, file_sha256,
    find_existing_project_source, get_project_manifest, get_project_schema, get_source_artifact,
    get_staged_artifact, migrate_mobile_db, new_id, project_cleanup_root_path, project_root_path,
    relative_artifact_path, require_sync_editable_project, row_artifact, row_delete_tombstone,
    row_entity_revision, row_project, safe_relative_path, source_format, verify_staged_artifact,
    ARTIFACT_COLUMNS, PROJECT_COLUMNS, SYNC_DELETE_TOMBSTONE_COLUMNS, SYNC_ENTITY_REVISION_COLUMNS,
};

#[cfg(all(test, not(target_os = "android")))]
#[allow(dead_code)]
#[path = "storage_cleanup.rs"]
mod storage_cleanup;
#[cfg(all(test, not(target_os = "android")))]
use storage_cleanup::reconcile_project_storage_after_commit;

#[cfg(all(test, not(target_os = "android")))]
#[allow(dead_code)]
#[path = "audio.rs"]
mod audio;

#[cfg(all(test, not(target_os = "android")))]
#[allow(dead_code)]
#[path = "manifests.rs"]
mod manifests;
#[cfg(all(test, not(target_os = "android")))]
use manifests::{
    apply_delete_tombstone, hydrate_imported_read_models, import_entity_revisions,
    import_sync_project_manifest, local_tombstone_superseded_by_live_target,
    update_project_sync_status, validate_manifest_delete_tombstones,
    validate_project_manifest_identity, validate_remote_delete_tombstone,
};

#[cfg(all(test, not(target_os = "android")))]
#[allow(dead_code)]
#[path = "reconciliation.rs"]
mod reconciliation;

#[cfg(all(test, not(target_os = "android")))]
fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(all(test, not(target_os = "android")))]
fn ensure_local_identity(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO sync_local_identities (id, sync_group_id, device_id, display_name, public_key, private_key, created_at, updated_at)
             VALUES ('local', 'sync_group_mobile_test', 'device_mobile_test', 'TuneForge Test Device', 'public_test_key', 'private_test_key', ?1, ?1)",
            params![now_iso()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(all(test, not(target_os = "android")))]
fn local_identity(connection: &Connection) -> Result<SyncLocalIdentitySchema, String> {
    ensure_local_identity(connection)?;
    connection
        .query_row(
            "SELECT device_id, sync_group_id, display_name, public_key, created_at, updated_at FROM sync_local_identities WHERE id = 'local'",
            [],
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

#[cfg(all(test, not(target_os = "android")))]
fn active_trusted_device_ids(_connection: &Connection) -> Result<HashSet<String>, String> {
    Ok(HashSet::from([
        "device_peer_1".to_string(),
        "device_desktop_fixture".to_string(),
    ]))
}

#[cfg(all(test, not(target_os = "android")))]
fn trim_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

#[cfg(all(test, not(target_os = "android")))]
fn generation_unavailable_message(job_type: &str) -> &'static str {
    match job_type {
        "stems" => {
            "Mobile stem separation is not wired yet; emulator mode only tests the submit flow."
        }
        _ => MOBILE_UNAVAILABLE,
    }
}

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
