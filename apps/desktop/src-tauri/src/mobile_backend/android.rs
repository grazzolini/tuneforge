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
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use whisper_rs::{
    install_logging_hooks, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

#[path = "audio.rs"]
mod audio;
#[path = "identity.rs"]
mod identity;
#[path = "lyrics.rs"]
mod lyrics;
#[path = "manifests.rs"]
mod manifests;
#[path = "reconciliation.rs"]
mod reconciliation;
#[path = "storage.rs"]
mod storage;
#[path = "transport_bridge.rs"]
mod transport_bridge;

use self::storage::*;
use audio::{ensure_source_playback_proxy_metadata, spawn_playback_proxy_generation};
use identity::{
    active_trusted_device_ids, ensure_local_identity, local_identity, trim_optional_string,
};
use lyrics::find_whisper_model;
use manifests::{
    apply_delete_tombstone, import_entity_revisions, import_sync_project_manifest,
    local_tombstone_superseded_by_live_target, normalize_tombstone_target_type,
    record_local_delete_tombstone, update_project_sync_status, validate_manifest_delete_tombstones,
    validate_project_manifest_identity, validate_remote_delete_tombstone,
};

pub use audio::{
    mobile_get_analysis, mobile_get_chords, mobile_submit_analyze, mobile_submit_chords,
    mobile_submit_preview, mobile_submit_retune, mobile_submit_stems, mobile_submit_transpose,
};
pub use identity::{
    mobile_answer_sync_pairing_offer, mobile_create_sync_pairing_offer, mobile_get_sync_identity,
    mobile_list_sync_trusted_peers, mobile_revoke_sync_trusted_peer,
    mobile_sign_transport_handshake, mobile_trust_sync_peer,
};
pub use lyrics::{mobile_get_lyrics, mobile_submit_lyrics, mobile_update_lyrics};
pub use manifests::{
    mobile_get_sync_metadata, mobile_get_sync_project_manifest, mobile_import_sync_project,
    mobile_update_sync_project_status,
};
pub use reconciliation::{mobile_apply_sync_reconciliation, mobile_plan_sync_reconciliation};
pub use storage::{
    mobile_cancel_job, mobile_delete_artifact, mobile_delete_project, mobile_get_health,
    mobile_get_job, mobile_get_project, mobile_get_sync_staged_artifact, mobile_import_project,
    mobile_list_artifacts, mobile_list_jobs, mobile_list_projects, mobile_stage_sync_artifact,
    mobile_submit_export, mobile_sync_transport_artifact_file, mobile_update_project,
};
pub use transport_bridge::{
    mobile_sync_transport_create_pairing_offer_value, mobile_sync_transport_local_identity_value,
    mobile_sync_transport_metadata_value, mobile_sync_transport_project_manifest_value,
    mobile_sync_transport_reconciliation_apply_value,
    mobile_sync_transport_reconciliation_plan_value, mobile_sync_transport_stage_artifact_value,
    mobile_sync_transport_staged_artifact_value, mobile_sync_transport_trusted_peers_value,
};

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const WHISPER_MODEL_DIR: &str = "models/whisper";
const WHISPER_MODEL_MISSING: &str =
        "Side-load a Whisper ggml model into app storage at models/whisper/ggml-base.bin or models/whisper/ggml-tiny.bin to enable local lyrics.";
const LOCAL_IDENTITY_ID: &str = "local";
const DEFAULT_LOCAL_DISPLAY_NAME: &str = "TuneForge Device";
const DEVICE_ID_PREFIX: &str = "dev_ed25519_";
const SYNC_GROUP_ID_PREFIX: &str = "syncgrp_";
const PAIRING_PREFIX: &str = "pair_";
const SECRET_HASH_PREFIX: &str = "sha256_";
const PAIRING_SECRET_HASH_CONTEXT: &[u8] = b"tuneforge.sync.pairing_secret.v1\0";
const DEFAULT_PAIRING_TTL_SECONDS: i64 = 600;
const MAX_PAIRING_TTL_SECONDS: i64 = 3600;
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
