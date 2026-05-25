
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
const MOBILE_DB_VERSION: i64 = 3;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const DEFAULT_SYNC_STATUS: &str = "local";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const DEFAULT_SYNC_LIST_JSON: &str = "[]";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const MOBILE_CANCELLED_JOB_STATUS: &str = "cancelled";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const LYRICS_LANGUAGE_OVERRIDE_CODES: &[&str] = &[
    "none", "en", "pt", "es", "fr", "de", "it", "ja", "ko", "zh", "hi",
];
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const LYRICS_LANGUAGE_OVERRIDE_ERROR: &str =
    "language_override must be null or one of none, en, pt, es, fr, de, it, ja, ko, zh, hi.";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const LYRICS_SOURCE_KIND_AI: &str = "ai";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const LYRICS_SOURCE_KIND_INSTRUMENTAL: &str = "instrumental";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const LYRICS_BACKEND_NONE: &str = "none";
#[cfg(target_os = "android")]
const GPU_REQUIRED: &str = "Local generation requires GPU acceleration on this device.";
#[cfg(target_os = "android")]
const LYRICS_NOT_WIRED: &str =
    "Mobile lyrics transcription is not wired yet; emulator mode only tests the submit flow.";
#[cfg(target_os = "android")]
const STEMS_NOT_WIRED: &str =
    "Mobile stem separation is not wired yet; emulator mode only tests the submit flow.";
