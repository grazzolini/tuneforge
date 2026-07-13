export const SYNC_PRIVACY_SAFE_PHASES = [
  "artifact_cleanup", "artifact_staging", "artifact_staging_check", "artifact_transfer", "initiator_import",
  "local_manifest_export", "manifest_exchange", "peer_authentication", "peer_connect", "planning",
  "reconciliation_apply", "reconciliation_apply_project", "reconciliation_plan", "reconciliation_staging",
  "responder_import", "serve_artifact_requests",
];

const PROBLEM_STATUSES = ["failed", "completed_with_errors", "conflicted", "error", "errored"];

export const SYNC_PRIVACY_SAFE_OPERATIONAL_TOKENS = [
  ...SYNC_PRIVACY_SAFE_PHASES,
  ...PROBLEM_STATUSES.flatMap((status) =>
    [`run_status_${status}`, `project_status_${status}`, `artifact_status_${status}`]),
  "failed_project_count", "conflicted_project_count", "manifest_export_error_count",
  "project_failed_count", "project_counter_failed_count", "run_outcome",
  "checksum_mismatch",
  "hash_retry_pending",
  "sha256_mismatch",
];

export const SYNC_PRIVACY_RAW_ID_TOKENS = [
  "device_shadow",
  "proj_shadow",
  "art_shadow",
  "run_shadow",
  "session_shadow",
  "project_shadow",
  "artifact_shadow",
  "sync_shadow",
];

export const SYNC_PRIVACY_HASH_TOKENS = [
  "checksum_mismatch_shadow",
  "hash_retry_pending_shadow",
  "sha256_mismatch_shadow",
  "content_sha256_deadbeefcafebabefeedface01234567",
  "content.hash_deadbeefcafebabefeedface01234567",
  "content-hash_deadbeefcafebabefeedface01234567",
  "abcdefabcdefabcdefabcdefabcdefab_checksum_mismatch",
  "sha256-deadbeef",
  "abcdefabcdefabcdefabcdefabcdefab",
  "hash_deadbeefcafebabefeedface01234567",
  "checksum_deadbeefcafebabe",
];
