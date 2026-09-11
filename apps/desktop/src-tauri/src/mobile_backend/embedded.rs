use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{rngs::SysRng, TryRng};
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
use tauri::{AppHandle, Manager};

#[path = "identity.rs"]
mod identity;
#[path = "manifests.rs"]
mod manifests;
#[path = "reconciliation.rs"]
mod reconciliation;
#[path = "staging_cleanup.rs"]
mod staging_cleanup;
#[path = "storage.rs"]
mod storage;
#[path = "storage_cleanup.rs"]
mod storage_cleanup;
#[path = "transport_bridge.rs"]
mod transport_bridge;

use self::staging_cleanup::reconcile_staged_artifacts_after_commit;
use self::storage::*;
use self::storage_cleanup::reconcile_project_storage_after_commit;
use identity::{
    active_trusted_device_ids, ensure_local_identity, local_identity, trim_optional_string,
};
use manifests::{
    apply_delete_tombstone, hydrate_imported_read_models, import_entity_revisions,
    import_sync_project_manifest, local_tombstone_superseded_by_live_target,
    normalize_tombstone_target_type, record_local_delete_tombstone, update_project_sync_status,
    validate_manifest_delete_tombstones, validate_project_manifest_identity,
    validate_remote_delete_tombstone,
};

pub use identity::{
    mobile_answer_sync_pairing_offer, mobile_create_sync_pairing_offer, mobile_get_sync_identity,
    mobile_list_sync_trusted_peers, mobile_revoke_sync_trusted_peer,
    mobile_sign_transport_handshake, mobile_trust_sync_peer,
    mobile_update_sync_trusted_peer_endpoint_hints,
};
pub use manifests::{
    mobile_get_sync_metadata, mobile_get_sync_project_manifest, mobile_import_sync_project,
    mobile_update_sync_project_status,
};
pub use reconciliation::{mobile_apply_sync_reconciliation, mobile_plan_sync_reconciliation};
pub use storage::{
    mobile_cancel_job, mobile_delete_artifact, mobile_delete_project, mobile_get_health,
    mobile_get_job, mobile_get_project, mobile_get_sync_staged_artifact, mobile_import_project,
    mobile_list_artifacts, mobile_list_jobs, mobile_list_projects,
    mobile_register_sync_staged_reference, mobile_stage_sync_artifact,
    mobile_sync_transport_artifact_file, mobile_update_project,
};
pub use transport_bridge::{
    mobile_sync_transport_create_pairing_offer_value, mobile_sync_transport_local_identity_value,
    mobile_sync_transport_metadata_value, mobile_sync_transport_project_manifest_value,
    mobile_sync_transport_reconciliation_apply_value,
    mobile_sync_transport_reconciliation_plan_value, mobile_sync_transport_stage_artifact_value,
    mobile_sync_transport_staged_artifact_value, mobile_sync_transport_trusted_peers_value,
    mobile_sync_transport_update_trusted_peer_endpoint_hints_value,
};

const LOCAL_IDENTITY_ID: &str = "local";
const DEFAULT_LOCAL_DISPLAY_NAME: &str = "TuneForge Device";
const DEVICE_ID_PREFIX: &str = "dev_ed25519_";
const SYNC_GROUP_ID_PREFIX: &str = "syncgrp_";
const PAIRING_PREFIX: &str = "pair_";
const SECRET_HASH_PREFIX: &str = "sha256_";
const PAIRING_SECRET_HASH_CONTEXT: &[u8] = b"tuneforge.sync.pairing_secret.v1\0";
const DEFAULT_PAIRING_TTL_SECONDS: i64 = 600;
const MAX_PAIRING_TTL_SECONDS: i64 = 3600;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
