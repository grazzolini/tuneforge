import createClient from "openapi-fetch";
import { invoke } from "@tauri-apps/api/core";
import type { components, MobileCapabilities, paths } from "@tuneforge/shared-types";
import { normalizeApiDateTime } from "./datetime";

const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8765";
let apiBaseUrl = DEFAULT_API_BASE_URL;
let runtimeInitPromise: Promise<string> | null = null;

type ErrorResponse = {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
};
type ValidationErrorResponse = {
  detail?: Array<{
    loc: Array<string | number>;
    msg: string;
    type: string;
    input?: unknown;
    ctx?: Record<string, unknown>;
  }>;
};
export type HealthResponse = components["schemas"]["HealthResponse"];
export type ProjectSchema = components["schemas"]["ProjectSchema"];
export type AnalysisSchema = components["schemas"]["AnalysisSchema"];
export type AnalysisResponse = components["schemas"]["AnalysisResponse"];
export type AnalysisRequest = components["schemas"]["AnalysisRequest"];
export type BeatAnalysisBackend = NonNullable<AnalysisRequest["beat_backend"]>;
export type ChordResponse = components["schemas"]["ChordResponse"];
export type ChordSegmentSchema = components["schemas"]["ChordSegmentSchema"];
export type LyricsResponse = components["schemas"]["LyricsResponse"];
export type LyricsSegmentSchema = components["schemas"]["LyricsSegmentSchema"];
export type LyricsWordSchema = components["schemas"]["LyricsWordSchema"];
export type ArtifactSchema = components["schemas"]["ArtifactSchema"];
export type JobSchema = components["schemas"]["JobSchema"];
export type JobsResponse = components["schemas"]["JobsResponse"];
export type BulkJobType = components["schemas"]["BulkJobRequest"]["job_type"];
export type BulkJobRequest = components["schemas"]["BulkJobRequest"];
export type BulkJobsResponse = components["schemas"]["BulkJobsResponse"];
export type ListProjectsParams = NonNullable<paths["/api/v1/projects"]["get"]["parameters"]["query"]>;
export type ListJobsParams = NonNullable<paths["/api/v1/jobs"]["get"]["parameters"]["query"]>;
export type PreviewRequest = components["schemas"]["PreviewRequest"];
export type RetuneRequest = components["schemas"]["RetuneRequest"];
export type ExportRequest = components["schemas"]["ExportRequest"];
export type ExportCapabilities = components["schemas"]["ExportCapabilitiesSchema"];
export type ExportCapabilitiesResponse = components["schemas"]["ExportCapabilitiesResponse"];
export type ProjectUpdateRequest = components["schemas"]["ProjectUpdateRequest"];
export type ProjectImportRequest = components["schemas"]["ProjectImportRequest"];
export type StemRequest = components["schemas"]["StemRequest"];
export type StemModelSchema = components["schemas"]["StemModelSchema"];
export type StemModelsResponse = components["schemas"]["StemModelsResponse"];
export type ChordRequest = components["schemas"]["ChordRequest"];
export type BeatBackendSchema = components["schemas"]["BeatBackendSchema"];
export type BeatBackendsResponse = components["schemas"]["BeatBackendsResponse"];
export type ChordBackendSchema = components["schemas"]["ChordBackendSchema"];
export type ChordBackendsResponse = components["schemas"]["ChordBackendsResponse"];
export type LyricsGenerateRequest = components["schemas"]["LyricsGenerateRequest"];
export type LyricsUpdateRequest = components["schemas"]["LyricsUpdateRequest"];
export type SongSectionSchema = components["schemas"]["SongSectionSchema"];
export type SongSectionsResponse = components["schemas"]["SongSectionsResponse"];
export type TabImportApplyRequest = components["schemas"]["TabImportApplyRequest"];
export type TabImportApplyResponse = components["schemas"]["TabImportApplyResponse"];
export type TabImportCreateRequest = components["schemas"]["TabImportCreateRequest"];
export type TabImportResponse = components["schemas"]["TabImportResponse"];
export type TabImportSchema = components["schemas"]["TabImportSchema"];
export type TabSuggestionGroupSchema = components["schemas"]["TabSuggestionGroupSchema"];
export type TabSuggestionSchema = components["schemas"]["TabSuggestionSchema"];
export type SyncLocalIdentitySchema = components["schemas"]["SyncLocalIdentitySchema"];
export type SyncLocalIdentityResponse = components["schemas"]["SyncLocalIdentityResponse"];
export type SyncPairingOfferRequest = components["schemas"]["SyncPairingOfferRequest"];
export type SyncPairingOfferResponse = components["schemas"]["SyncPairingOfferResponse"];
export type SyncPairingPayloadSchema = components["schemas"]["SyncPairingPayloadSchema"];
export type SyncPairingAnswerRequest = components["schemas"]["SyncPairingAnswerRequest"];
export type SyncPairingAnswerResponse = components["schemas"]["SyncPairingAnswerResponse"];
export type SyncTrustedPeerCreateRequest = components["schemas"]["SyncTrustedPeerCreateRequest"];
export type SyncTrustedPeerResponse = components["schemas"]["SyncTrustedPeerResponse"];
export type SyncTrustedPeerSchema = components["schemas"]["SyncTrustedPeerSchema"];
export type SyncTrustedPeersResponse = components["schemas"]["SyncTrustedPeersResponse"];
type GeneratedSyncPreflightResponse = components["schemas"]["SyncPreflightResponse"];
export type SyncPreflightBlockingJob = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  type: string;
  status: string;
  progress: number;
  started_at: string | null;
  updated_at: string;
};
export type SyncPreflightJobState = {
  state: "ready" | "busy";
  running_job_count: number;
  pending_job_count: number;
  blocking_job_count: number;
  blocking_job_counts: Record<string, number>;
  blocking_jobs: SyncPreflightBlockingJob[];
  blocking_jobs_truncated: boolean;
  guidance: string[];
};
export type SyncPreflightResponse = GeneratedSyncPreflightResponse & {
  library_ok: boolean;
  job_state: SyncPreflightJobState;
};
export type RuntimeCapabilities = MobileCapabilities | null;
export type ProjectSyncSummary = {
  state: string;
  label: string;
  isLocal: boolean;
  isLocked: boolean;
  showBadge: boolean;
  lockReason: string | null;
};
export type SyncTransportMetricMap = Record<string, number>;
export type SyncTransportPhaseTiming = {
  phase?: string | null;
  project_id?: string | null;
  artifact_id?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  throughput_bytes_per_second?: number | null;
};
export type SyncTransportTiming = Record<string, unknown> | Record<string, unknown>[];
export type SyncLifecycleEventRequest = {
  kind: string;
  occurredAt?: string | null;
  message?: string | null;
};
export type SyncTransportLifecycleEvent = {
  kind: string;
  occurred_at?: string | null;
  message?: string | null;
  retryable: boolean;
  interruption_code?: string | null;
  retry_guidance?: string | null;
  peer_device_id?: string | null;
  run_id?: string | null;
};
type SyncTransportDiagnosticField =
  | "credit_wait_ms_total"
  | "credit_wait_ms_max"
  | "credit_wait_events"
  | "credit_hold_ms_total"
  | "credit_hold_ms_max"
  | "stage_queue_wait_ms_total"
  | "stage_queue_wait_ms_max"
  | "stage_queue_wait_events"
  | "stream_open_ms_total"
  | "stream_open_ms_max"
  | "stream_open_events"
  | "sender_write_ms_total"
  | "sender_write_ms_max"
  | "sender_write_events"
  | "receiver_read_ms_total"
  | "receiver_read_ms_max"
  | "receiver_read_events"
  | "receiver_hash_ms_total"
  | "receiver_hash_ms_max"
  | "receiver_hash_events"
  | "receiver_temp_write_ms_total"
  | "receiver_temp_write_ms_max"
  | "receiver_temp_write_events"
  | "staging_post_ms_total"
  | "staging_post_ms_max"
  | "staging_post_events";
type SyncTransportDiagnosticValues = Partial<Record<SyncTransportDiagnosticField, number | null>>;
export type SyncTransportRunStatus = {
  run_id?: string | null;
  session_id?: string | null;
  peer_device_id?: string | null;
  remote_device_id?: string | null;
  direction?: string | null;
  selected_transport?: string | null;
  fallback_reason?: string | null;
  fallback_code?: string | null;
  attempted_transports?: string[];
  nearby_peers?: SyncNearbyPeer[];
  status: string;
  message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_seconds?: number | null;
  duration_ms?: number | null;
  timing?: SyncTransportTiming | null;
  phase_timings?: SyncTransportPhaseTiming[];
  transfer_counts?: SyncTransportMetricMap;
  total_received_bytes?: number | null;
  total_served_bytes?: number | null;
  time_to_first_artifact_ms?: number | null;
  throughput_bytes_per_second?: number | null;
  scratch_peak_bytes?: number | null;
  staging_peak_bytes?: number | null;
  max_active_streams?: number | null;
  credit_grants?: number | null;
  credit_revokes?: number | null;
  last_lifecycle_event?: SyncTransportLifecycleEvent | null;
  lifecycle_events?: SyncTransportLifecycleEvent[];
  retryable_interruption_code?: string | null;
  retryable_interruption_peer_device_id?: string | null;
  retry_guidance?: string | null;
  error?: string | null;
  project_results: SyncTransportProjectResult[];
  project_results_complete?: boolean;
  manifest_errors: SyncTransportManifestError[];
  manifest_errors_complete?: boolean;
  received_artifacts: SyncTransportTransferResult[];
  received_artifacts_complete?: boolean;
  served_artifact_requests?: number | null;
  local_manifest_count?: number | null;
  remote_manifest_count?: number | null;
  imported_project_count?: number | null;
  applied_project_count?: number | null;
  deleted_project_count?: number | null;
  skipped_project_count?: number | null;
  conflicted_project_count?: number | null;
  failed_project_count?: number | null;
  manifest_export_error_count?: number | null;
  total_project_count?: number | null;
} & SyncTransportDiagnosticValues;
export type SyncTransportProjectResult = {
  project_id: string;
  run_id?: string | null;
  session_id?: string | null;
  status: string;
  phase?: string | null;
  action?: string | null;
  message?: string | null;
  is_final?: boolean | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_seconds?: number | null;
  duration_ms?: number | null;
  timing?: SyncTransportTiming | null;
  counters?: SyncTransportMetricMap;
  imported_count?: number | null;
  applied_count?: number | null;
  deleted_count?: number | null;
  satisfied_count?: number | null;
  skipped_count?: number | null;
  failed_count?: number | null;
  received_artifact_count?: number | null;
  reused_artifact_count?: number | null;
};
export type SyncTransportManifestError = {
  project_id: string;
  message: string;
};
export type SyncTransportTransferResult = {
  artifact_id: string;
  content_sha256?: string | null;
  size_bytes?: number | null;
  status: string;
  message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  throughput_bytes_per_second?: number | null;
};
export type SyncNearbyPeerTrustStatus = "match" | "mismatch" | "unknown";
export type SyncNearbyPeer = {
  device_id?: string | null;
  display_name?: string | null;
  public_key?: string | null;
  short_fingerprint?: string | null;
  trust_status: SyncNearbyPeerTrustStatus;
  trusted_peer_device_id?: string | null;
  endpoint_hints: string[];
  last_seen_at?: string | null;
};
export type SyncTransportStatus = {
  active: boolean;
  status: string;
  endpoint_hints: string[];
  nearby_peers: SyncNearbyPeer[];
  active_run_id?: string | null;
  active_phase?: string | null;
  active_message?: string | null;
  active_progress_at?: string | null;
  active_elapsed_ms?: number | null;
  last_status?: string | null;
  last_error?: string | null;
  fallback_code?: string | null;
  last_lifecycle_event?: SyncTransportLifecycleEvent | null;
  lifecycle_events?: SyncTransportLifecycleEvent[];
  retryable_interruption_code?: string | null;
  retryable_interruption_peer_device_id?: string | null;
  retry_guidance?: string | null;
  last_sync?: SyncTransportRunStatus | null;
  updated_at?: string | null;
};
export type SyncTransportSyncNowOptions = {
  endpointHint?: string | null;
  endpointHints?: string[];
};

const LOCAL_SYNC_STATES = new Set(["local", "noop", "identical_content"]);
const PROJECT_SYNC_STATE_LABELS: Record<string, string> = {
  conflicted: "Conflicted",
  deleted: "Deleted",
  downloading: "Downloading",
  local: "Local",
  missing: "Missing",
  missing_local_bytes: "Missing Bytes",
  missing_provider: "Missing Provider",
  remote_available: "Not on this device",
  syncing: "Syncing",
  unreadable: "Unreadable",
};
const PROJECT_SYNC_LOCK_REASONS: Record<string, string> = {
  conflicted: "Resolve sync conflicts before editing this project.",
  deleted: "This project was deleted in the sync group and cannot be edited.",
  downloading: "This project is downloading required local data before edits are enabled.",
  missing: "Required project data is missing on this device.",
  missing_local_bytes: "Required project audio is missing on this device.",
  missing_provider: "No trusted synced device can provide the required project data.",
  remote_available: "Project data is on another synced device. Download it here before editing.",
  syncing: "This project is still syncing required local data before edits are enabled.",
  unreadable: "Project data exists here but cannot be read. Check the sync details before editing.",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function firstStringField(records: Array<Record<string, unknown> | null>, keys: string[]) {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function firstNullableStringField(records: Array<Record<string, unknown> | null>, keys: string[]) {
  let present = false;
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        continue;
      }
      present = true;
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return { present, value: value.trim() };
      }
    }
  }
  return { present, value: null };
}

function firstBooleanField(records: Array<Record<string, unknown> | null>, keys: string[]) {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
    }
  }
  return null;
}

function stringArrayField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    }
  }
  return [];
}

function numberField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstNumberField(records: Array<Record<string, unknown> | null>, keys: string[]) {
  for (const record of records) {
    const value = numberField(record, keys);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function nullableNumberField(record: Record<string, unknown> | null, keys: string[]) {
  let present = false;
  if (!record) {
    return { present, value: null };
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    present = true;
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return { present, value };
    }
  }
  return { present, value: null };
}

function dateTimeField(record: Record<string, unknown> | null, keys: string[]) {
  const value = firstStringField([record], keys);
  return value ? normalizeApiDateTime(value) : null;
}

function recordField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function recordOrRecordArrayField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    const recordValue = asRecord(value);
    if (recordValue) {
      return recordValue;
    }
    if (Array.isArray(value)) {
      const records = value.filter((item): item is Record<string, unknown> => asRecord(item) !== null);
      if (records.length === value.length) {
        return records;
      }
    }
  }
  return null;
}

function recordArrayOrObjectValuesField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null);
    }
    const valueRecord = asRecord(value);
    if (valueRecord) {
      const records = Object.values(valueRecord)
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null);
      if (records.length) {
        return records;
      }
    }
  }
  return [];
}

function recordArrayField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null);
    }
  }
  return [];
}

function normalizeSyncPreflightBlockingJob(value: unknown): SyncPreflightBlockingJob | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = firstStringField([record], ["id", "job_id", "jobId"]);
  if (!id) {
    return null;
  }
  return {
    id,
    project_id: firstStringField([record], ["project_id", "projectId"]),
    project_name: firstStringField(
      [record],
      ["project_name", "projectName", "project_display_name", "projectDisplayName"],
    ),
    type: firstStringField([record], ["type", "job_type", "jobType"]) ?? "job",
    status: firstStringField([record], ["status", "state"]) ?? "pending",
    progress: numberField(record, ["progress", "progress_percent", "progressPercent"]) ?? 0,
    started_at: dateTimeField(record, ["started_at", "startedAt"]),
    updated_at: dateTimeField(record, ["updated_at", "updatedAt"]) ?? "",
  };
}

function normalizeSyncPreflightJobCounts(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

function normalizeSyncPreflightJobState(value: unknown): SyncPreflightJobState {
  const record = asRecord(value);
  const rawBlockingJobs = Array.isArray(record?.blocking_jobs)
    ? record.blocking_jobs
    : Array.isArray(record?.blockingJobs)
      ? record.blockingJobs
      : [];
  const blockingJobs = rawBlockingJobs
    .map(normalizeSyncPreflightBlockingJob)
    .filter((job): job is SyncPreflightBlockingJob => job !== null);
  const blockingJobCounts = normalizeSyncPreflightJobCounts(record?.blocking_job_counts ?? record?.blockingJobCounts);
  const runningJobCount =
    numberField(record, ["running_job_count", "runningJobCount"]) ?? blockingJobCounts.running ?? 0;
  const pendingJobCount =
    numberField(record, ["pending_job_count", "pendingJobCount"]) ?? blockingJobCounts.pending ?? 0;
  const countedBlockingJobs = Object.values(blockingJobCounts).reduce((total, count) => total + count, 0);
  const explicitBlockingJobCount = numberField(record, ["blocking_job_count", "blockingJobCount"]);
  const blockingJobCount = explicitBlockingJobCount ?? (countedBlockingJobs || blockingJobs.length);
  const rawState = firstStringField([record], ["state", "status"]);
  const state = rawState === "ready" || rawState === "busy"
    ? rawState
    : blockingJobCount > 0 ? "busy" : "ready";
  return {
    state,
    running_job_count: runningJobCount,
    pending_job_count: pendingJobCount,
    blocking_job_count: blockingJobCount,
    blocking_job_counts: {
      ...blockingJobCounts,
      pending: blockingJobCounts.pending ?? pendingJobCount,
      running: blockingJobCounts.running ?? runningJobCount,
    },
    blocking_jobs: blockingJobs,
    blocking_jobs_truncated: firstBooleanField([record], ["blocking_jobs_truncated", "blockingJobsTruncated"]) ?? false,
    guidance: stringArrayField(record, ["guidance", "messages"]),
  };
}

function normalizeSyncPreflightResponse(response: GeneratedSyncPreflightResponse): SyncPreflightResponse {
  const record = asRecord(response);
  const jobState = normalizeSyncPreflightJobState(record?.job_state ?? record?.jobState);
  const libraryOk = firstBooleanField([record], ["library_ok", "libraryOk"]) ??
    (
      (record?.manual_cleanup_required === false || record?.manualCleanupRequired === false) &&
      (response.missing_source_hash_projects ?? 0) === 0 &&
      (response.invalid_source_hash_projects ?? 0) === 0 &&
      (response.duplicate_source_hash_projects ?? 0) === 0 &&
      (response.noncanonical_project_id_projects ?? 0) === 0
    );
  return {
    ...response,
    ok: Boolean(response.ok && libraryOk && jobState.blocking_job_count === 0),
    library_ok: libraryOk,
    job_state: jobState,
  };
}

function mobileReadySyncPreflightResponse(): GeneratedSyncPreflightResponse {
  return {
    ok: true,
    library_ok: true,
    total_projects: 0,
    ready_projects: 0,
    missing_source_hash_projects: 0,
    invalid_source_hash_projects: 0,
    duplicate_source_hash_projects: 0,
    noncanonical_project_id_projects: 0,
    projects: [],
    duplicate_groups: [],
    job_state: {
      state: "ready",
      running_job_count: 0,
      pending_job_count: 0,
      blocking_job_count: 0,
      blocking_job_counts: { running: 0, pending: 0 },
      blocking_jobs: [],
      blocking_jobs_truncated: false,
      guidance: [],
    },
    manual_cleanup_required: false,
    manual_cleanup_guidance: [],
  };
}

function normalizeMetricKey(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

const SYNC_TRANSPORT_EVIDENCE_METRIC_KEYS = new Set([
  "scratch_peak_bytes",
  "scratch_bytes_peak",
  "scratch_storage_peak_bytes",
  "staging_peak_bytes",
  "staging_bytes_peak",
  "staging_storage_peak_bytes",
  "max_active_streams",
  "active_streams_peak",
  "max_streams",
  "max_stream_count",
  "credit_grants",
  "credit_grant_count",
  "credit_grants_count",
  "credits_granted",
  "credit_revokes",
  "credit_revoke_count",
  "credit_revokes_count",
  "credit_revocations",
  "credit_revocation_count",
  "credits_revoked",
]);

const SYNC_TRANSPORT_DIAGNOSTIC_FIELDS: Array<[SyncTransportDiagnosticField, string[]]> = [
  ["credit_wait_ms_total", ["credit_wait_ms_total", "creditWaitMsTotal"]],
  ["credit_wait_ms_max", ["credit_wait_ms_max", "creditWaitMsMax"]],
  ["credit_wait_events", ["credit_wait_events", "creditWaitEvents"]],
  ["credit_hold_ms_total", ["credit_hold_ms_total", "creditHoldMsTotal"]],
  ["credit_hold_ms_max", ["credit_hold_ms_max", "creditHoldMsMax"]],
  ["stage_queue_wait_ms_total", ["stage_queue_wait_ms_total", "stageQueueWaitMsTotal"]],
  ["stage_queue_wait_ms_max", ["stage_queue_wait_ms_max", "stageQueueWaitMsMax"]],
  ["stage_queue_wait_events", ["stage_queue_wait_events", "stageQueueWaitEvents"]],
  ["stream_open_ms_total", ["stream_open_ms_total", "streamOpenMsTotal"]],
  ["stream_open_ms_max", ["stream_open_ms_max", "streamOpenMsMax"]],
  ["stream_open_events", ["stream_open_events", "streamOpenEvents"]],
  ["sender_write_ms_total", ["sender_write_ms_total", "senderWriteMsTotal"]],
  ["sender_write_ms_max", ["sender_write_ms_max", "senderWriteMsMax"]],
  ["sender_write_events", ["sender_write_events", "senderWriteEvents"]],
  ["receiver_read_ms_total", ["receiver_read_ms_total", "receiverReadMsTotal"]],
  ["receiver_read_ms_max", ["receiver_read_ms_max", "receiverReadMsMax"]],
  ["receiver_read_events", ["receiver_read_events", "receiverReadEvents"]],
  ["receiver_hash_ms_total", ["receiver_hash_ms_total", "receiverHashMsTotal"]],
  ["receiver_hash_ms_max", ["receiver_hash_ms_max", "receiverHashMsMax"]],
  ["receiver_hash_events", ["receiver_hash_events", "receiverHashEvents"]],
  ["receiver_temp_write_ms_total", ["receiver_temp_write_ms_total", "receiverTempWriteMsTotal"]],
  ["receiver_temp_write_ms_max", ["receiver_temp_write_ms_max", "receiverTempWriteMsMax"]],
  ["receiver_temp_write_events", ["receiver_temp_write_events", "receiverTempWriteEvents"]],
  ["staging_post_ms_total", ["staging_post_ms_total", "stagingPostMsTotal"]],
  ["staging_post_ms_max", ["staging_post_ms_max", "stagingPostMsMax"]],
  ["staging_post_events", ["staging_post_events", "stagingPostEvents"]],
];

function numericMetricsFromRecord(record: Record<string, unknown> | null) {
  const metrics: SyncTransportMetricMap = {};
  if (!record) {
    return metrics;
  }
  Object.entries(record).forEach(([key, value]) => {
    const metricKey = normalizeMetricKey(key);
    const looksLikeMetric =
      /(?:_count|_bytes|_ms|_seconds|_events)$/.test(metricKey) ||
      /_ms_(?:total|max)$/.test(metricKey) ||
      /_per_second$/.test(metricKey) ||
      metricKey.startsWith("count_") ||
      SYNC_TRANSPORT_EVIDENCE_METRIC_KEYS.has(metricKey);
    if (looksLikeMetric && typeof value === "number" && Number.isFinite(value)) {
      metrics[metricKey] = value;
    }
  });
  return metrics;
}

function syncMetricMap(record: Record<string, unknown>) {
  const explicitMetrics =
    recordField(record, ["counters", "counts", "metrics", "project_counters", "projectCounters"]);
  return {
    ...numericMetricsFromRecord(explicitMetrics),
    ...numericMetricsFromRecord(record),
  };
}

function syncTransportDiagnosticValues(records: Array<Record<string, unknown> | null>) {
  return Object.fromEntries(
    SYNC_TRANSPORT_DIAGNOSTIC_FIELDS.map(([field, keys]) => [
      field,
      firstNumberField(records, keys),
    ]),
  ) as Record<SyncTransportDiagnosticField, number | null>;
}

function timingField(record: Record<string, unknown>) {
  return recordOrRecordArrayField(record, [
    "timing",
    "timings",
    "timing_metrics",
    "timingMetrics",
    "phase_timings",
    "phaseTimings",
  ]);
}

function durationMsFromDateTimes(startedAt: string | null | undefined, completedAt: string | null | undefined) {
  if (!startedAt || !completedAt) {
    return null;
  }
  const startedTimestamp = Date.parse(normalizeApiDateTime(startedAt));
  const completedTimestamp = Date.parse(normalizeApiDateTime(completedAt));
  if (!Number.isFinite(startedTimestamp) || !Number.isFinite(completedTimestamp)) {
    return null;
  }
  const durationMs = completedTimestamp - startedTimestamp;
  return durationMs >= 0 ? durationMs : null;
}

function throughputFromBytesAndDuration(bytes: number | null | undefined, durationMs: number | null | undefined) {
  if (
    typeof bytes !== "number" ||
    !Number.isFinite(bytes) ||
    bytes < 0 ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }
  return (bytes * 1000) / durationMs;
}

function normalizeSyncPhaseTiming(value: unknown): SyncTransportPhaseTiming | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const startedAt = dateTimeField(record, ["started_at", "startedAt", "start_time", "startTime"]);
  const completedAt = dateTimeField(record, [
    "completed_at",
    "completedAt",
    "finished_at",
    "finishedAt",
    "end_time",
    "endTime",
  ]);
  const durationSeconds = numberField(record, [
    "duration_seconds",
    "durationSeconds",
    "elapsed_seconds",
    "elapsedSeconds",
  ]);
  const durationMs =
    numberField(record, ["duration_ms", "durationMs", "elapsed_ms", "elapsedMs"]) ??
    (durationSeconds === null ? null : durationSeconds * 1000) ??
    durationMsFromDateTimes(startedAt, completedAt);
  const timing: SyncTransportPhaseTiming = {
    phase: firstStringField([record], ["phase", "stage", "name"]),
    project_id: firstStringField([record], ["project_id", "projectId"]),
    artifact_id: firstStringField([record], ["artifact_id", "artifactId"]),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    throughput_bytes_per_second: numberField(record, [
      "throughput_bytes_per_second",
      "throughputBytesPerSecond",
      "bytes_per_second",
      "bytesPerSecond",
    ]),
  };
  const hasTimingValue = Object.values(timing).some((item) => item !== null && item !== undefined);
  return hasTimingValue ? timing : null;
}

function phaseTimingField(record: Record<string, unknown>) {
  return recordArrayOrObjectValuesField(record, [
    "phase_timings",
    "phaseTimings",
    "timings",
    "timing_metrics",
    "timingMetrics",
  ])
    .map((item) => normalizeSyncPhaseTiming(item))
    .filter((item): item is SyncTransportPhaseTiming => item !== null);
}

function normalizeProjectSyncState(value: string | null) {
  return value?.toLowerCase().replace(/[\s-]+/g, "_") ?? "local";
}

function syncReasonLooksUnreadable(reason: string | null) {
  const normalized = reason?.toLowerCase() ?? "";
  return /\b(unreadable|hash|sha-?256|checksum|decode|schema|malformed|corrupt)\b/.test(normalized);
}

function labelFromSyncState(state: string, reason: string | null) {
  if (syncReasonLooksUnreadable(reason)) {
    return PROJECT_SYNC_STATE_LABELS.unreadable;
  }
  return PROJECT_SYNC_STATE_LABELS[state] ??
    state
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
}

function defaultProjectLockReason(state: string, isLocal: boolean) {
  if (PROJECT_SYNC_LOCK_REASONS[state]) {
    return PROJECT_SYNC_LOCK_REASONS[state];
  }
  return isLocal
    ? "This project is locked until sync makes it editable."
    : "This project is not ready for local edits yet.";
}

export function getProjectSyncSummary(project: ProjectSchema | null | undefined): ProjectSyncSummary {
  if (!project) {
    return {
      state: "local",
      label: PROJECT_SYNC_STATE_LABELS.local,
      isLocal: true,
      isLocked: false,
      showBadge: false,
      lockReason: null,
    };
  }

  const projectRecord = project as ProjectSchema & Record<string, unknown>;
  const syncRecord =
    asRecord(projectRecord.sync) ??
    asRecord(projectRecord.sync_status) ??
    asRecord(projectRecord.sync_state);
  const state = normalizeProjectSyncState(
    firstStringField([projectRecord], ["sync_state", "sync_status", "syncState", "syncStatus"]) ??
      firstStringField(
        [syncRecord],
        ["sync_state", "sync_status", "syncState", "syncStatus", "state", "status"],
      ),
  );
  const isLocal = LOCAL_SYNC_STATES.has(state);
  const explicitLocked = firstBooleanField(
    [projectRecord, syncRecord],
    ["edit_locked", "is_edit_locked", "locked", "read_only", "readOnly"],
  );
  const explicitEditable = firstBooleanField(
    [projectRecord, syncRecord],
    ["sync_editable", "syncEditable", "can_edit", "editable", "is_editable", "canEdit"],
  );
  const isLocked = explicitLocked ?? (explicitEditable === null ? !isLocal : !explicitEditable);
  const statusReason = firstStringField(
    [projectRecord, syncRecord],
    [
      "edit_lock_reason",
      "lock_reason",
      "sync_status_reason",
      "syncStatusReason",
      "sync_lock_reason",
      "unavailable_reason",
      "reason",
      "message",
    ],
  );
  const label = labelFromSyncState(state, statusReason);
  const lockReason = isLocked ? statusReason ?? defaultProjectLockReason(state, isLocal) : null;

  return {
    state,
    label,
    isLocal,
    isLocked,
    showBadge: !isLocal || isLocked || label !== PROJECT_SYNC_STATE_LABELS.local,
    lockReason,
  };
}

function unsupportedRuntimeError(feature: string) {
  return new ApiError({
    code: "UNSUPPORTED_RUNTIME",
    message: `${feature} requires the desktop native runtime.`,
    details: {},
  });
}

async function invokeDesktopNative<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    throw unsupportedRuntimeError("Native sync transport");
  }
  return invoke<T>(command, args);
}

function normalizeTransportStatusToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeSyncTransportToken(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "iroh" || normalized.startsWith("tuneforge-sync+iroh")) {
    return "iroh";
  }
  if (normalized === "tcp" || normalized.startsWith("tuneforge-sync+tcp")) {
    return "tcp";
  }
  if (normalized === "auto") {
    return "auto";
  }
  return normalizeTransportStatusToken(normalized).replace(/\+/g, "_");
}

function normalizeNearbyPeerTrustStatus(record: Record<string, unknown>): SyncNearbyPeerTrustStatus {
  const explicit = firstStringField([
    record,
  ], [
    "trust_status",
    "trustStatus",
    "trust_state",
    "trustState",
    "trust",
    "match_status",
    "matchStatus",
  ]);
  const normalized = explicit ? normalizeTransportStatusToken(explicit) : null;
  if (normalized) {
    if (normalized.includes("mismatch") || normalized.includes("conflict")) {
      return "mismatch";
    }
    if (normalized.includes("match") || normalized === "trusted" || normalized === "known") {
      return "match";
    }
    if (normalized === "unknown" || normalized === "untrusted" || normalized === "new") {
      return "unknown";
    }
  }

  const trustMatches = firstBooleanField([
    record,
  ], ["trust_match", "trustMatch", "matches_trusted_peer", "matchesTrustedPeer"]);
  if (trustMatches !== null) {
    return trustMatches ? "match" : "mismatch";
  }
  const trusted = firstBooleanField([record], ["trusted", "is_trusted", "isTrusted"]);
  return trusted ? "match" : "unknown";
}

function normalizeNearbyPeer(value: unknown): SyncNearbyPeer | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const endpointHints = stringArrayField(record, [
    "endpoint_hints",
    "endpointHints",
    "endpoints",
    "current_endpoint_hints",
    "currentEndpointHints",
  ]);
  return {
    device_id: firstStringField([record], ["device_id", "deviceId", "id"]),
    display_name: firstStringField([record], ["display_name", "displayName", "name"]),
    public_key: firstStringField([record], ["public_key", "publicKey"]),
    short_fingerprint: firstStringField([
      record,
    ], [
      "short_fingerprint",
      "shortFingerprint",
      "fingerprint_short",
      "fingerprintShort",
      "fingerprint",
    ]),
    trust_status: normalizeNearbyPeerTrustStatus(record),
    trusted_peer_device_id: firstStringField([
      record,
    ], ["trusted_peer_device_id", "trustedPeerDeviceId", "trusted_device_id", "trustedDeviceId"]),
    endpoint_hints: endpointHints,
    last_seen_at: dateTimeField(record, [
      "last_seen_at",
      "lastSeenAt",
      "last_seen",
      "lastSeen",
      "observed_at",
      "observedAt",
      "discovered_at",
      "discoveredAt",
      "timestamp",
      "updated_at",
      "updatedAt",
    ]),
  };
}

function nearbyPeersField(record: Record<string, unknown>) {
  return recordArrayOrObjectValuesField(record, [
    "nearby_peers",
    "nearbyPeers",
    "discovered_peers",
    "discoveredPeers",
    "local_peers",
    "localPeers",
  ])
    .map((item) => normalizeNearbyPeer(item))
    .filter((item): item is SyncNearbyPeer => item !== null);
}

function normalizedEndpointHints(endpointHints: string[] | null | undefined) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  (endpointHints ?? []).forEach((hint) => {
    const trimmed = hint.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  });
  return normalized;
}

function normalizeSyncLifecycleEvent(value: unknown): SyncTransportLifecycleEvent | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const kind = firstStringField([record], ["kind", "event", "type"]);
  if (!kind) {
    return null;
  }
  return {
    kind: normalizeTransportStatusToken(kind),
    occurred_at: dateTimeField(record, [
      "occurred_at",
      "occurredAt",
      "timestamp",
      "created_at",
      "createdAt",
      "updated_at",
      "updatedAt",
    ]),
    message: firstStringField([record], ["message", "reason", "detail", "details"]),
    retryable: firstBooleanField([record], ["retryable", "can_retry", "canRetry"]) ?? false,
    interruption_code: firstStringField([
      record,
    ], [
      "interruption_code",
      "interruptionCode",
      "retryable_interruption_code",
      "retryableInterruptionCode",
      "code",
    ]),
    retry_guidance: firstStringField([record], ["retry_guidance", "retryGuidance", "guidance"]),
    peer_device_id: firstStringField([
      record,
    ], [
      "peer_device_id",
      "peerDeviceId",
      "retryable_interruption_peer_device_id",
      "retryableInterruptionPeerDeviceId",
      "device_id",
      "deviceId",
    ]),
    run_id: firstStringField([record], ["run_id", "runId", "sync_run_id", "syncRunId"]),
  };
}

function lifecycleEventsField(record: Record<string, unknown>) {
  return recordArrayField(record, ["lifecycle_events", "lifecycleEvents", "events"])
    .map((item) => normalizeSyncLifecycleEvent(item))
    .filter((item): item is SyncTransportLifecycleEvent => item !== null);
}

function lastLifecycleEventField(
  record: Record<string, unknown>,
  lifecycleEvents: SyncTransportLifecycleEvent[],
) {
  return normalizeSyncLifecycleEvent(record.last_lifecycle_event ?? record.lastLifecycleEvent ?? null) ??
    lifecycleEvents[lifecycleEvents.length - 1] ??
    null;
}

function syncLifecycleInterruptionFields(
  record: Record<string, unknown>,
  lifecycleEvents: SyncTransportLifecycleEvent[],
  lastLifecycleEvent: SyncTransportLifecycleEvent | null,
) {
  const retryableLifecycleEvent = [
    lastLifecycleEvent,
    ...[...lifecycleEvents].reverse(),
  ].find((event): event is SyncTransportLifecycleEvent => Boolean(event?.retryable));
  const explicitCode = firstNullableStringField([
    record,
  ], [
    "retryable_interruption_code",
    "retryableInterruptionCode",
    "interruption_code",
    "interruptionCode",
  ]);
  const explicitPeerDeviceId = firstNullableStringField([
    record,
  ], [
    "retryable_interruption_peer_device_id",
    "retryableInterruptionPeerDeviceId",
    "interruption_peer_device_id",
    "interruptionPeerDeviceId",
    "peer_device_id",
    "peerDeviceId",
  ]);
  const explicitGuidance = firstNullableStringField([
    record,
  ], [
    "retry_guidance",
    "retryGuidance",
    "retryable_interruption_guidance",
    "retryableInterruptionGuidance",
  ]);
  const explicitInterruptionState =
    explicitCode.present || explicitPeerDeviceId.present || explicitGuidance.present;
  return {
    retryable_interruption_code: explicitCode.value ??
      (explicitInterruptionState ? null : retryableLifecycleEvent?.interruption_code ?? null),
    retryable_interruption_peer_device_id: explicitPeerDeviceId.value ??
      (explicitInterruptionState ? null : retryableLifecycleEvent?.peer_device_id ?? null),
    retry_guidance: explicitGuidance.value ??
      (explicitInterruptionState ? null : retryableLifecycleEvent?.retry_guidance ?? null),
  };
}

const SYNC_PROJECT_RESULT_PROGRESS_STATES = new Set([
  "applying",
  "downloading",
  "exporting",
  "importing",
  "pending",
  "planning",
  "queued",
  "receiving",
  "running",
  "staging",
  "syncing",
  "transferring",
]);
const SYNC_PROJECT_RESULT_PROBLEM_STATES = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "completed_with_errors",
  "conflicted",
  "error",
  "failed",
]);
const SYNC_MANIFEST_EXPORT_ERROR_STATUS = "manifest_export_error";

function projectResultKey(result: SyncTransportProjectResult) {
  return result.project_id.trim() || "unknown";
}

export function isFinalSyncProjectResult(result: SyncTransportProjectResult) {
  if (result.is_final !== null && result.is_final !== undefined) {
    return result.is_final;
  }
  return !SYNC_PROJECT_RESULT_PROGRESS_STATES.has(result.status);
}

function syncResultTime(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(normalizeApiDateTime(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function syncProjectResultTime(result: SyncTransportProjectResult) {
  return syncResultTime(result.completed_at) ?? syncResultTime(result.started_at);
}

function shouldReplaceSyncProjectResult(
  current: SyncTransportProjectResult,
  candidate: SyncTransportProjectResult,
) {
  const currentIsFinal = isFinalSyncProjectResult(current);
  const candidateIsFinal = isFinalSyncProjectResult(candidate);
  if (candidateIsFinal !== currentIsFinal) {
    return candidateIsFinal;
  }
  const currentTime = syncProjectResultTime(current);
  const candidateTime = syncProjectResultTime(candidate);
  if (currentTime !== null || candidateTime !== null) {
    if (currentTime === null) {
      return true;
    }
    if (candidateTime === null) {
      return false;
    }
    if (candidateTime !== currentTime) {
      return candidateTime > currentTime;
    }
  }
  return true;
}

export function mergeSyncProjectResults(
  projectResults: SyncTransportProjectResult[],
  manifestErrors: SyncTransportManifestError[] = [],
) {
  const merged = new Map<string, SyncTransportProjectResult>();
  projectResults.forEach((result) => {
    const key = projectResultKey(result);
    const current = merged.get(key);
    if (!current || shouldReplaceSyncProjectResult(current, result)) {
      merged.delete(key);
      merged.set(key, result);
    }
  });

  const projectsWithFinalResults = new Set(
    Array.from(merged.values())
      .filter((result) => isFinalSyncProjectResult(result))
      .map((result) => projectResultKey(result)),
  );
  manifestErrors.forEach((error) => {
    const key = error.project_id.trim() || "unknown";
    if (projectsWithFinalResults.has(key)) {
      return;
    }
    const result: SyncTransportProjectResult = {
      project_id: key,
      status: SYNC_MANIFEST_EXPORT_ERROR_STATUS,
      message: error.message,
      is_final: true,
    };
    const current = merged.get(key);
    if (!current || shouldReplaceSyncProjectResult(current, result)) {
      merged.delete(key);
      merged.set(key, result);
    }
  });

  return Array.from(merged.values());
}

export function countSyncProjectResultsByStatus(projectResults: SyncTransportProjectResult[]) {
  return projectResults.reduce<Record<string, number>>((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function syncMessageShouldYieldToCanonicalSummary(message: string | null | undefined) {
  const normalized = message?.trim();
  if (!normalized) {
    return false;
  }
  return /\b(?:imported|applied|deleted|skipped|failed|conflicted|received|served|offered)\s+\d+\b/i.test(normalized) ||
    /\b\d+\s+(?:local|remote)\s+manifest\(s\)\b/i.test(normalized) ||
    /\b\d+\s+manifest export error\(s\)\b/i.test(normalized) ||
    /\b(?:project|artifact|manifest) request\(s\)\b/i.test(normalized) ||
    /\bmanifest exchange completed\b/i.test(normalized) ||
    /\b\d+\s+project results?\b/i.test(normalized) ||
    /\bsync completed\b/i.test(normalized);
}

type SyncCanonicalSummaryCounts = {
  localManifestCount: number | null;
  remoteManifestCount: number | null;
  importedProjectCount: number | null;
  appliedProjectCount: number | null;
  deletedProjectCount: number | null;
  skippedProjectCount: number | null;
  conflictedProjectCount: number | null;
  failedProjectCount: number | null;
  receivedArtifactCount: number | null;
  reusedArtifactCount: number | null;
  failedTransferCount: number | null;
  hasCompleteTransferEvidence: boolean;
  manifestExportErrorCount: number | null;
};

export type SyncRunCanonicalCounts = SyncCanonicalSummaryCounts & {
  projectResultsByStatus: Record<string, number> | null;
  totalProjectCount: number | null;
};

type SyncRunCanonicalCountParts = {
  localManifestCount: number | null;
  remoteManifestCount: number | null;
  importedProjectCount: number | null;
  appliedProjectCount: number | null;
  deletedProjectCount: number | null;
  skippedProjectCount: number | null;
  conflictedProjectCount: number | null;
  failedProjectCount: number | null;
  totalProjectCount: number | null;
  manifestExportErrorCount: number | null;
  projectResults: SyncTransportProjectResult[];
  projectResultsComplete: boolean;
  manifestErrors: SyncTransportManifestError[];
  manifestErrorsComplete: boolean;
  receivedArtifacts: SyncTransportTransferResult[];
  receivedArtifactsComplete: boolean;
  transferCounts?: Record<string, number> | null;
};

export function syncCanonicalSummaryMessage(counts: SyncCanonicalSummaryCounts) {
  const count = (value: number | null) => value ?? "unknown";
  return `Exchanged ${count(counts.localManifestCount)} local and ${count(counts.remoteManifestCount)} remote manifest(s); final project outcomes: imported ${count(counts.importedProjectCount)}, applied ${count(counts.appliedProjectCount)}, deleted ${count(counts.deletedProjectCount)}, skipped ${count(counts.skippedProjectCount)}, conflicted ${count(counts.conflictedProjectCount)}, failed ${count(counts.failedProjectCount)}; transfers: received ${count(counts.receivedArtifactCount)}, reused/already staged ${count(counts.reusedArtifactCount)}, failed ${count(counts.failedTransferCount)}; manifest export errors (separate from final project outcomes): ${count(counts.manifestExportErrorCount)}.`;
}

function syncTransferCountValue(transferCounts: Record<string, number> | null | undefined, key: string) {
  const value = transferCounts?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function syncTransferCount(
  receivedArtifacts: SyncTransportTransferResult[],
  receivedArtifactsComplete: boolean,
  transferCounts: Record<string, number> | null | undefined,
  keys: string[],
  statuses: string[],
) {
  for (const key of keys) {
    const count = syncTransferCountValue(transferCounts, key);
    if (count !== null) {
      return count;
    }
  }
  return receivedArtifactsComplete
    ? receivedArtifacts.filter((artifact) => statuses.includes(artifact.status)).length
    : null;
}

function hasSyncTransferCount(
  transferCounts: Record<string, number> | null | undefined,
  keys: string[],
) {
  return keys.some((key) => syncTransferCountValue(transferCounts, key) !== null);
}

function syncRunCanonicalCountsFromParts(parts: SyncRunCanonicalCountParts): SyncRunCanonicalCounts | null {
  const finalProjectResults = mergeSyncProjectResults(parts.projectResults).filter(
    (result) =>
      result.status !== SYNC_MANIFEST_EXPORT_ERROR_STATUS && isFinalSyncProjectResult(result),
  );
  const rowProjectResultsByStatus = countSyncProjectResultsByStatus(finalProjectResults);
  const hasProjectResults = finalProjectResults.length > 0;
  const projectStatusCount = (statusKey: string, fallback: number | null) =>
    hasProjectResults
      ? rowProjectResultsByStatus[statusKey] ?? 0
      : fallback ?? (parts.projectResultsComplete ? 0 : null);
  const rawProjectCounts = [
    projectStatusCount("imported", parts.importedProjectCount),
    projectStatusCount("applied", parts.appliedProjectCount),
    projectStatusCount("deleted", parts.deletedProjectCount),
    projectStatusCount("skipped", parts.skippedProjectCount),
    projectStatusCount("conflicted", parts.conflictedProjectCount),
    projectStatusCount("failed", parts.failedProjectCount),
  ];
  const knownProjectCountTotal = rawProjectCounts.reduce<number>(
    (total, count) => total + (count ?? 0),
    0,
  );
  const suppliedTotalProjectCount = hasProjectResults ? finalProjectResults.length : parts.totalProjectCount;
  const omittedProjectCountsAreZero = !hasProjectResults && suppliedTotalProjectCount !== null &&
    knownProjectCountTotal === suppliedTotalProjectCount;
  const finalProjectCounts = rawProjectCounts.map((count) =>
    count ?? (omittedProjectCountsAreZero ? 0 : null)
  );
  const [
    importedProjectCount,
    appliedProjectCount,
    deletedProjectCount,
    skippedProjectCount,
    conflictedProjectCount,
    failedProjectCount,
  ] = finalProjectCounts;
  const totalProjectCount = suppliedTotalProjectCount ?? (
    finalProjectCounts.every((count): count is number => count !== null)
      ? finalProjectCounts.reduce((total, count) => total + count, 0)
      : null
  );
  const aggregateProjectResultsByStatus = [
    ["imported", importedProjectCount],
    ["applied", appliedProjectCount],
    ["deleted", deletedProjectCount],
    ["skipped", skippedProjectCount],
    ["conflicted", conflictedProjectCount],
    ["failed", failedProjectCount],
  ] as const;
  const projectResultsByStatus = hasProjectResults
    ? rowProjectResultsByStatus
    : finalProjectCounts.every((count) => count !== null)
      ? Object.fromEntries(
        aggregateProjectResultsByStatus.filter(([, count]) => typeof count === "number" && count > 0),
      ) as Record<string, number>
      : null;
  const concreteManifestExportErrorCount = Math.max(
    parts.manifestErrors.length,
    parts.projectResults.filter((result) => result.status === SYNC_MANIFEST_EXPORT_ERROR_STATUS).length,
  );
  const manifestExportErrorCount =
    concreteManifestExportErrorCount > 0
      ? concreteManifestExportErrorCount
      : parts.manifestExportErrorCount ?? (parts.manifestErrorsComplete ? 0 : null);
  const hasSummaryContext = [
    parts.localManifestCount,
    parts.remoteManifestCount,
    importedProjectCount,
    appliedProjectCount,
    deletedProjectCount,
    skippedProjectCount,
    conflictedProjectCount,
    failedProjectCount,
    manifestExportErrorCount,
  ].some((value) => value !== null && value !== undefined) ||
    parts.receivedArtifacts.length > 0 ||
    Object.keys(parts.transferCounts ?? {}).length > 0;
  if (!hasSummaryContext) {
    return null;
  }
  return {
    localManifestCount: parts.localManifestCount,
    remoteManifestCount: parts.remoteManifestCount,
    importedProjectCount,
    appliedProjectCount,
    deletedProjectCount,
    skippedProjectCount,
    conflictedProjectCount,
    failedProjectCount,
    receivedArtifactCount: syncTransferCount(
      parts.receivedArtifacts,
      parts.receivedArtifactsComplete,
      parts.transferCounts,
      ["received", "received_count", "received_artifact_count"],
      ["received"],
    ),
    reusedArtifactCount: syncTransferCount(
      parts.receivedArtifacts,
      parts.receivedArtifactsComplete,
      parts.transferCounts,
      ["already_staged", "reused", "reused_artifact_count"],
      ["already_staged", "reused"],
    ),
    failedTransferCount: syncTransferCount(
      parts.receivedArtifacts,
      parts.receivedArtifactsComplete,
      parts.transferCounts,
      ["failed", "failed_transfer_count"],
      ["failed"],
    ),
    hasCompleteTransferEvidence: parts.receivedArtifactsComplete || [
      ["received", "received_count", "received_artifact_count"],
      ["already_staged", "reused", "reused_artifact_count"],
      ["failed", "failed_transfer_count"],
    ].every((keys) => hasSyncTransferCount(parts.transferCounts, keys)),
    manifestExportErrorCount,
    projectResultsByStatus,
    totalProjectCount,
  };
}

export function syncRunCanonicalCounts(status: SyncTransportRunStatus) {
  return syncRunCanonicalCountsFromParts({
    localManifestCount: status.local_manifest_count ?? null,
    remoteManifestCount: status.remote_manifest_count ?? null,
    importedProjectCount: status.imported_project_count ?? null,
    appliedProjectCount: status.applied_project_count ?? null,
    deletedProjectCount: status.deleted_project_count ?? null,
    skippedProjectCount: status.skipped_project_count ?? null,
    conflictedProjectCount: status.conflicted_project_count ?? null,
    failedProjectCount: status.failed_project_count ?? null,
    totalProjectCount: status.total_project_count ?? null,
    manifestExportErrorCount: status.manifest_export_error_count ?? null,
    projectResults: status.project_results,
    projectResultsComplete: status.project_results_complete ?? status.project_results.length > 0,
    manifestErrors: status.manifest_errors,
    manifestErrorsComplete: status.manifest_errors_complete ?? status.manifest_errors.length > 0,
    receivedArtifacts: status.received_artifacts,
    receivedArtifactsComplete: status.received_artifacts_complete ?? status.received_artifacts.length > 0,
    transferCounts: status.transfer_counts,
  });
}

export function syncRunCanonicalSummaryMessage(status: SyncTransportRunStatus) {
  const counts = syncRunCanonicalCounts(status);
  return counts?.hasCompleteTransferEvidence ? syncCanonicalSummaryMessage(counts) : null;
}

function normalizeSyncProjectResult(
  value: unknown,
  fallbackStatus = "failed",
  fallbackMessage: string | null = null,
): SyncTransportProjectResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const counters = syncMetricMap(record);
  return {
    project_id: firstStringField([record], ["project_id", "projectId", "id"]) ?? "unknown",
    run_id: firstStringField([record], ["run_id", "runId", "sync_run_id", "syncRunId"]),
    session_id: firstStringField([record], ["session_id", "sessionId", "sync_session_id", "syncSessionId"]),
    status: normalizeTransportStatusToken(
      firstStringField([record], ["status", "state", "result"]) ?? fallbackStatus,
    ),
    phase: firstStringField([record], ["phase", "stage"]),
    action: firstStringField([record], ["action", "operation"]),
    message: firstStringField([record], ["message", "error", "reason"]) ?? fallbackMessage,
    is_final: firstBooleanField([record], ["is_final", "isFinal", "final"]),
    started_at: dateTimeField(record, ["started_at", "startedAt"]),
    completed_at: dateTimeField(record, ["completed_at", "completedAt", "finished_at", "finishedAt"]),
    duration_seconds: numberField(record, ["duration_seconds", "durationSeconds", "elapsed_seconds", "elapsedSeconds"]),
    duration_ms: numberField(record, ["duration_ms", "durationMs", "elapsed_ms", "elapsedMs"]),
    timing: timingField(record),
    counters,
    imported_count: numberField(record, ["imported_count", "importedCount"]),
    applied_count: numberField(record, ["applied_count", "appliedCount"]),
    deleted_count: numberField(record, ["deleted_count", "deletedCount"]),
    satisfied_count: numberField(record, ["satisfied_count", "satisfiedCount"]),
    skipped_count: numberField(record, ["skipped_count", "skippedCount"]),
    failed_count: numberField(record, ["failed_count", "failedCount"]),
    received_artifact_count: numberField(record, ["received_artifact_count", "receivedArtifactCount"]),
    reused_artifact_count: numberField(record, ["reused_artifact_count", "reusedArtifactCount"]),
  };
}

function normalizeSyncManifestError(value: unknown): SyncTransportManifestError | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const message = firstStringField([record], ["message", "error", "reason"]);
  if (!message) {
    return null;
  }
  return {
    project_id: firstStringField([record], ["project_id", "projectId", "id"]) ?? "unknown",
    message,
  };
}

function normalizeSyncTransferResult(value: unknown): SyncTransportTransferResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const startedAt = dateTimeField(record, ["started_at", "startedAt"]);
  const completedAt = dateTimeField(record, ["completed_at", "completedAt", "finished_at", "finishedAt"]);
  const durationMs =
    numberField(record, ["duration_ms", "durationMs", "elapsed_ms", "elapsedMs"]) ??
    durationMsFromDateTimes(startedAt, completedAt);
  return {
    artifact_id: firstStringField([record], ["artifact_id", "artifactId", "id"]) ?? "unknown",
    content_sha256: firstStringField([record], ["content_sha256", "contentSha256"]),
    size_bytes: numberField(record, ["size_bytes", "sizeBytes"]),
    status: normalizeTransportStatusToken(
      firstStringField([record], ["status", "state", "result"]) ?? "completed",
    ),
    message: firstStringField([record], ["message", "error", "reason"]),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    throughput_bytes_per_second: numberField(record, [
      "throughput_bytes_per_second",
      "throughputBytesPerSecond",
      "bytes_per_second",
      "bytesPerSecond",
    ]) ?? throughputFromBytesAndDuration(numberField(record, ["size_bytes", "sizeBytes"]), durationMs),
  };
}

function normalizedPhaseName(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
}

function transferTimingForArtifact(
  artifact: SyncTransportTransferResult,
  phaseTimings: SyncTransportPhaseTiming[],
) {
  const artifactTimings = phaseTimings.filter((timing) => timing.artifact_id === artifact.artifact_id);
  if (!artifactTimings.length) {
    return null;
  }
  return artifactTimings.find((timing) => normalizedPhaseName(timing.phase).includes("transfer")) ??
    artifactTimings.find((timing) => normalizedPhaseName(timing.phase).includes("staging_check")) ??
    artifactTimings[0];
}

function enrichSyncTransferResult(
  artifact: SyncTransportTransferResult,
  phaseTimings: SyncTransportPhaseTiming[],
) {
  const timing = transferTimingForArtifact(artifact, phaseTimings);
  if (!timing) {
    return artifact;
  }
  const startedAt = artifact.started_at ?? timing.started_at ?? null;
  const completedAt = artifact.completed_at ?? timing.completed_at ?? null;
  const durationMs =
    artifact.duration_ms ??
    timing.duration_ms ??
    durationMsFromDateTimes(startedAt, completedAt);
  const timingIsTransfer = normalizedPhaseName(timing.phase).includes("transfer");
  return {
    ...artifact,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    throughput_bytes_per_second:
      artifact.throughput_bytes_per_second ??
      timing.throughput_bytes_per_second ??
      (timingIsTransfer ? throughputFromBytesAndDuration(artifact.size_bytes, durationMs) : null),
  };
}

function sumArtifactBytes(artifacts: SyncTransportTransferResult[]) {
  let total = 0;
  let hasBytes = false;
  artifacts.forEach((artifact) => {
    if (
      artifact.status !== "failed" &&
      typeof artifact.size_bytes === "number" &&
      Number.isFinite(artifact.size_bytes) &&
      artifact.size_bytes >= 0
    ) {
      total += artifact.size_bytes;
      hasBytes = true;
    }
  });
  return hasBytes ? total : null;
}

function firstArtifactCompletedOffsetMs(
  runStartedAt: string | null,
  artifacts: SyncTransportTransferResult[],
  phaseTimings: SyncTransportPhaseTiming[],
) {
  if (!runStartedAt) {
    return null;
  }
  const runStartedTimestamp = Date.parse(normalizeApiDateTime(runStartedAt));
  if (!Number.isFinite(runStartedTimestamp)) {
    return null;
  }
  const ignoredArtifactIds = new Set(
    artifacts
      .filter((artifact) => artifact.status === "failed" || artifact.status === "already_staged")
      .map((artifact) => artifact.artifact_id),
  );
  const artifactCompletedTimestamps = [
    ...artifacts
      .filter((artifact) => !ignoredArtifactIds.has(artifact.artifact_id))
      .map((artifact) => syncResultTime(artifact.completed_at)),
    ...phaseTimings
      .filter(
        (timing) =>
          timing.artifact_id &&
          !ignoredArtifactIds.has(timing.artifact_id) &&
          normalizedPhaseName(timing.phase).includes("transfer"),
      )
      .map((timing) => syncResultTime(timing.completed_at)),
  ].filter((timestamp): timestamp is number => timestamp !== null && timestamp >= runStartedTimestamp);
  if (!artifactCompletedTimestamps.length) {
    return null;
  }
  return Math.min(...artifactCompletedTimestamps) - runStartedTimestamp;
}

export function normalizeSyncRunStatus(value: unknown): SyncTransportRunStatus | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const runId = firstStringField([record], ["run_id", "runId", "sync_run_id", "syncRunId", "id"]);
  const sessionId = firstStringField([record], ["session_id", "sessionId", "sync_session_id", "syncSessionId"]);
  const runStartedAt = dateTimeField(record, ["started_at", "startedAt"]);
  const runCompletedAt = dateTimeField(record, ["completed_at", "completedAt", "finished_at", "finishedAt"]);
  const phaseTimings = phaseTimingField(record);
  const projectResultKeys = [
    "project_results",
    "projectResults",
    "imported_projects",
    "importedProjects",
    "projects",
    "results",
  ];
  const projectResultsComplete = projectResultKeys.some((key) => Array.isArray(record[key]));
  const manifestErrorKeys = ["manifest_errors", "manifestErrors"];
  const manifestErrorsComplete = manifestErrorKeys.some((key) => Array.isArray(record[key]));
  const explicitManifestErrors = recordArrayField(record, manifestErrorKeys)
    .map((item) => normalizeSyncManifestError(item))
    .filter((item): item is SyncTransportManifestError => item !== null);
  const importedProjectResults = recordArrayField(record, projectResultKeys)
    .map((item) => normalizeSyncProjectResult(item))
    .filter((item): item is SyncTransportProjectResult => item !== null)
    .map((result) => ({
      ...result,
      run_id: result.run_id ?? runId,
      session_id: result.session_id ?? sessionId,
    }));
  const legacyManifestErrors = importedProjectResults.flatMap((result) =>
    result.status === SYNC_MANIFEST_EXPORT_ERROR_STATUS && result.message
      ? [{ project_id: result.project_id, message: result.message }]
      : [],
  );
  const manifestErrors = Array.from(
    new Map(
      [...explicitManifestErrors, ...legacyManifestErrors].map((error) => [
        `${error.project_id}\0${error.message}`,
        error,
      ]),
    ).values(),
  );
  const projectResults = mergeSyncProjectResults(
    importedProjectResults.filter((result) => result.status !== SYNC_MANIFEST_EXPORT_ERROR_STATUS),
  );
  const receivedArtifactKeys = ["received_artifacts", "receivedArtifacts", "artifacts"];
  const receivedArtifactsComplete = receivedArtifactKeys.some((key) => Array.isArray(record[key]));
  const receivedArtifacts = recordArrayField(record, receivedArtifactKeys)
    .map((item) => normalizeSyncTransferResult(item))
    .filter((item): item is SyncTransportTransferResult => item !== null)
    .map((item) => enrichSyncTransferResult(item, phaseTimings));
  const localManifestCount = numberField(record, ["local_manifest_count", "localManifestCount"]);
  const remoteManifestCount = numberField(record, ["remote_manifest_count", "remoteManifestCount"]);
  const explicitImportedProjectCount = numberField(record, ["imported_project_count", "importedProjectCount"]);
  const explicitAppliedProjectCount = numberField(record, ["applied_project_count", "appliedProjectCount"]);
  const explicitDeletedProjectCount = numberField(record, ["deleted_project_count", "deletedProjectCount"]);
  const explicitSkippedProjectCount = numberField(record, ["skipped_project_count", "skippedProjectCount"]);
  const explicitConflictedProjectCount = numberField(record, [
    "conflicted_project_count",
    "conflictedProjectCount",
  ]);
  const explicitFailedProjectCount = numberField(record, ["failed_project_count", "failedProjectCount"]);
  const explicitManifestExportErrorCount = numberField(record, [
    "manifest_export_error_count",
    "manifestExportErrorCount",
    "manifest_error_count",
    "manifestErrorCount",
  ]);
  const transferCountRecord = recordField(record, ["transfer_counts", "transferCounts"]);
  const explicitRunMetricRecord = recordField(record, ["counters", "counts", "metrics"]);
  const runMetricRecords = [record, transferCountRecord, explicitRunMetricRecord];
  const transferCounts = {
    ...numericMetricsFromRecord(record),
    ...numericMetricsFromRecord(explicitRunMetricRecord),
    ...numericMetricsFromRecord(transferCountRecord),
  };
  const canonicalCounts = syncRunCanonicalCountsFromParts({
    localManifestCount,
    remoteManifestCount,
    importedProjectCount: explicitImportedProjectCount,
    appliedProjectCount: explicitAppliedProjectCount,
    deletedProjectCount: explicitDeletedProjectCount,
    skippedProjectCount: explicitSkippedProjectCount,
    conflictedProjectCount: explicitConflictedProjectCount,
    failedProjectCount: explicitFailedProjectCount,
    totalProjectCount: numberField(record, ["total_project_count", "totalProjectCount", "project_count", "projectCount"]),
    manifestExportErrorCount: explicitManifestExportErrorCount,
    projectResults,
    projectResultsComplete,
    manifestErrors,
    manifestErrorsComplete,
    receivedArtifacts,
    receivedArtifactsComplete,
    transferCounts,
  });
  const importedProjectCount = canonicalCounts?.importedProjectCount ?? null;
  const appliedProjectCount = canonicalCounts?.appliedProjectCount ?? null;
  const deletedProjectCount = canonicalCounts?.deletedProjectCount ?? null;
  const skippedProjectCount = canonicalCounts?.skippedProjectCount ?? null;
  const conflictedProjectCount = canonicalCounts?.conflictedProjectCount ?? null;
  const failedProjectCount = canonicalCounts?.failedProjectCount ?? null;
  const manifestExportErrorCount = canonicalCounts?.manifestExportErrorCount ?? null;
  const totalProjectCount = canonicalCounts?.totalProjectCount ?? null;
  const diagnosticValues = syncTransportDiagnosticValues(runMetricRecords);
  const lifecycleEvents = lifecycleEventsField(record);
  const lastLifecycleEvent = lastLifecycleEventField(record, lifecycleEvents);
  const lifecycleInterruptionFields = syncLifecycleInterruptionFields(
    record,
    lifecycleEvents,
    lastLifecycleEvent,
  );
  const durationMs =
    numberField(record, ["duration_ms", "durationMs", "elapsed_ms", "elapsedMs"]) ??
    durationMsFromDateTimes(runStartedAt, runCompletedAt);
  const durationSeconds =
    numberField(record, ["duration_seconds", "durationSeconds", "elapsed_seconds", "elapsedSeconds"]) ??
    (durationMs === null ? null : durationMs / 1000);
  const totalReceivedBytes =
    numberField(record, ["total_received_bytes", "totalReceivedBytes", "received_bytes", "receivedBytes"]) ??
    numberField(transferCountRecord, ["total_received_bytes", "totalReceivedBytes", "received_bytes", "receivedBytes"]) ??
    sumArtifactBytes(receivedArtifacts);
  const totalServedBytes =
    numberField(record, ["total_served_bytes", "totalServedBytes", "served_bytes", "servedBytes", "sent_bytes", "sentBytes"]) ??
    numberField(transferCountRecord, [
      "total_served_bytes",
      "totalServedBytes",
      "served_bytes",
      "servedBytes",
      "sent_bytes",
      "sentBytes",
    ]);
  const totalTransferBytes =
    totalReceivedBytes === null && totalServedBytes === null
      ? null
      : (totalReceivedBytes ?? 0) + (totalServedBytes ?? 0);
  const throughputBytesPerSecond =
    numberField(record, [
      "throughput_bytes_per_second",
      "throughputBytesPerSecond",
      "bytes_per_second",
      "bytesPerSecond",
    ]) ??
    numberField(transferCountRecord, [
      "throughput_bytes_per_second",
      "throughputBytesPerSecond",
      "bytes_per_second",
      "bytesPerSecond",
    ]) ??
    throughputFromBytesAndDuration(totalTransferBytes, durationMs);
  const explicitTimeToFirstArtifactMs = nullableNumberField(record, [
    "time_to_first_artifact_ms",
    "timeToFirstArtifactMs",
    "ttfa_ms",
    "ttfaMs",
  ]);
  const timeToFirstArtifactMs = explicitTimeToFirstArtifactMs.present
    ? explicitTimeToFirstArtifactMs.value
    : firstArtifactCompletedOffsetMs(runStartedAt, receivedArtifacts, phaseTimings);
  const scratchPeakBytes = firstNumberField(runMetricRecords, [
    "scratch_peak_bytes",
    "scratchPeakBytes",
    "scratch_bytes_peak",
    "scratchBytesPeak",
    "scratch_storage_peak_bytes",
    "scratchStoragePeakBytes",
  ]);
  const stagingPeakBytes = firstNumberField(runMetricRecords, [
    "staging_peak_bytes",
    "stagingPeakBytes",
    "staging_bytes_peak",
    "stagingBytesPeak",
    "staging_storage_peak_bytes",
    "stagingStoragePeakBytes",
  ]);
  const maxActiveStreams = firstNumberField(runMetricRecords, [
    "max_active_streams",
    "maxActiveStreams",
    "active_streams_peak",
    "activeStreamsPeak",
    "max_streams",
    "maxStreams",
    "max_stream_count",
    "maxStreamCount",
  ]);
  const creditGrants = firstNumberField(runMetricRecords, [
    "credit_grants",
    "creditGrants",
    "credit_grant_count",
    "creditGrantCount",
    "credit_grants_count",
    "creditGrantsCount",
    "credits_granted",
    "creditsGranted",
  ]);
  const creditRevokes = firstNumberField(runMetricRecords, [
    "credit_revokes",
    "creditRevokes",
    "credit_revoke_count",
    "creditRevokeCount",
    "credit_revokes_count",
    "creditRevokesCount",
    "credit_revocations",
    "creditRevocations",
    "credit_revocation_count",
    "creditRevocationCount",
    "credits_revoked",
    "creditsRevoked",
  ]);
  const hasProjectProblems = (canonicalCounts?.failedProjectCount ?? 0) > 0 ||
    (canonicalCounts?.conflictedProjectCount ?? 0) > 0 ||
    Object.entries(canonicalCounts?.projectResultsByStatus ?? {}).some(
      ([projectStatus, count]) => count > 0 && SYNC_PROJECT_RESULT_PROBLEM_STATES.has(projectStatus),
    );
  const explicitError = firstStringField([record], ["error", "last_error", "lastError"]);
  const explicitStatus = firstStringField([record], ["status", "state"]);
  const hasManifestErrors = (manifestExportErrorCount ?? 0) > 0;
  let status = normalizeTransportStatusToken(
    explicitStatus ?? (hasManifestErrors || hasProjectProblems ? "completed_with_errors" : "completed"),
  );
  if (status === "completed" && (hasManifestErrors || hasProjectProblems)) {
    status = "completed_with_errors";
  }
  if (
    status === "completed_with_errors" &&
    !explicitError &&
    !hasProjectProblems &&
    !hasManifestErrors
  ) {
    status = "completed";
  }
  const summary = canonicalCounts?.hasCompleteTransferEvidence
    ? syncCanonicalSummaryMessage(canonicalCounts)
    : null;
  const explicitMessage = firstStringField([record], ["message", "status_message", "statusMessage"]);
  const message = explicitMessage && !(summary && syncMessageShouldYieldToCanonicalSummary(explicitMessage))
    ? explicitMessage
    : summary ?? explicitMessage;
  return {
    run_id: runId,
    session_id: sessionId,
    peer_device_id: firstStringField([record], ["peer_device_id", "peerDeviceId", "device_id", "deviceId"]),
    remote_device_id: firstStringField([record], ["remote_device_id", "remoteDeviceId"]),
    direction: firstStringField([record], ["direction", "role"]),
    selected_transport: normalizeSyncTransportToken(
      firstStringField([record], ["selected_transport", "selectedTransport"]),
    ),
    fallback_reason: firstStringField([record], ["fallback_reason", "fallbackReason"]),
    fallback_code: firstStringField([record], ["fallback_code", "fallbackCode"]),
    attempted_transports: stringArrayField(record, ["attempted_transports", "attemptedTransports"])
      .map((transport) => normalizeSyncTransportToken(transport))
      .filter((transport): transport is string => transport !== null),
    nearby_peers: nearbyPeersField(record),
    status,
    message,
    started_at: runStartedAt,
    completed_at: runCompletedAt,
    duration_seconds: durationSeconds,
    duration_ms: durationMs,
    timing: timingField(record),
    phase_timings: phaseTimings,
    transfer_counts: transferCounts,
    total_received_bytes: totalReceivedBytes,
    total_served_bytes: totalServedBytes,
    time_to_first_artifact_ms: timeToFirstArtifactMs,
    throughput_bytes_per_second: throughputBytesPerSecond,
    scratch_peak_bytes: scratchPeakBytes,
    staging_peak_bytes: stagingPeakBytes,
    max_active_streams: maxActiveStreams,
    credit_grants: creditGrants,
    credit_revokes: creditRevokes,
    last_lifecycle_event: lastLifecycleEvent,
    lifecycle_events: lifecycleEvents,
    ...lifecycleInterruptionFields,
    error: explicitError,
    project_results: projectResults,
    project_results_complete: projectResultsComplete,
    manifest_errors: manifestErrors,
    manifest_errors_complete: manifestErrorsComplete,
    received_artifacts: receivedArtifacts,
    received_artifacts_complete: receivedArtifactsComplete,
    served_artifact_requests: numberField(record, ["served_artifact_requests", "servedArtifactRequests"]),
    local_manifest_count: localManifestCount,
    remote_manifest_count: remoteManifestCount,
    imported_project_count: importedProjectCount,
    applied_project_count: appliedProjectCount,
    deleted_project_count: deletedProjectCount,
    skipped_project_count: skippedProjectCount,
    conflicted_project_count: conflictedProjectCount,
    failed_project_count: failedProjectCount,
    manifest_export_error_count: manifestExportErrorCount,
    total_project_count: totalProjectCount,
    ...diagnosticValues,
  };
}

export function normalizeSyncTransportStatus(value: unknown): SyncTransportStatus {
  const record = asRecord(value);
  if (!record) {
    return {
      active: false,
      status: "unavailable",
      endpoint_hints: [],
      nearby_peers: [],
      lifecycle_events: [],
      last_error: "Native sync transport returned an invalid status.",
    };
  }

  const active = firstBooleanField([record], ["active", "running", "listening", "is_listening", "isListening"]) ?? false;
  const status = firstStringField([record], ["status", "state", "listener_status", "listenerStatus"]) ??
    (active ? "listening" : "stopped");
  const activeProgressRecord = recordField(record, ["active_progress", "activeProgress", "current_progress", "currentProgress"]);
  const activeProgressRecords = [activeProgressRecord, record];
  const activeProgressAt = firstStringField(activeProgressRecords, [
    "active_progress_at",
    "activeProgressAt",
    "progress_at",
    "progressAt",
    "last_progress_at",
    "lastProgressAt",
    "updated_at",
    "updatedAt",
  ]);
  const lifecycleEvents = lifecycleEventsField(record);
  const lastLifecycleEvent = lastLifecycleEventField(record, lifecycleEvents);
  const lifecycleInterruptionFields = syncLifecycleInterruptionFields(
    record,
    lifecycleEvents,
    lastLifecycleEvent,
  );
  return {
    active,
    status,
    endpoint_hints: stringArrayField(record, ["endpoint_hints", "endpointHints", "endpoints"]),
    nearby_peers: nearbyPeersField(record),
    active_run_id: firstStringField(activeProgressRecords, [
      "active_run_id",
      "activeRunId",
      "run_id",
      "runId",
      "sync_run_id",
      "syncRunId",
    ]),
    active_phase: firstStringField(activeProgressRecords, [
      "active_phase",
      "activePhase",
      "phase",
      "current_phase",
      "currentPhase",
    ]),
    active_message: firstStringField(activeProgressRecords, [
      "active_message",
      "activeMessage",
      "message",
      "status_message",
      "statusMessage",
    ]),
    active_progress_at: activeProgressAt ? normalizeApiDateTime(activeProgressAt) : null,
    active_elapsed_ms: numberField(activeProgressRecord, [
      "active_elapsed_ms",
      "activeElapsedMs",
      "elapsed_ms",
      "elapsedMs",
    ]) ?? numberField(record, ["active_elapsed_ms", "activeElapsedMs", "elapsed_ms", "elapsedMs"]),
    last_status: firstStringField([record], ["last_status", "lastStatus"]),
    last_error: firstStringField([record], ["last_error", "lastError", "error"]),
    fallback_code: firstStringField([record], ["fallback_code", "fallbackCode"]),
    last_lifecycle_event: lastLifecycleEvent,
    lifecycle_events: lifecycleEvents,
    ...lifecycleInterruptionFields,
    last_sync: normalizeSyncRunStatus(record.last_sync ?? record.lastSync ?? null),
    updated_at: firstStringField([record], ["updated_at", "updatedAt"]),
  };
}

async function getSyncTransportStatus() {
  return normalizeSyncTransportStatus(await invokeDesktopNative<unknown>("sync_transport_status"));
}

async function startSyncListener() {
  return normalizeSyncTransportStatus(await invokeDesktopNative<unknown>("sync_transport_start_listener", { payload: {} }));
}

async function stopSyncListener() {
  return normalizeSyncTransportStatus(await invokeDesktopNative<unknown>("sync_transport_stop_listener"));
}

async function recordSyncLifecycleEvent(event: SyncLifecycleEventRequest) {
  const payload: Record<string, unknown> = { kind: event.kind };
  if (event.occurredAt !== undefined) {
    payload.occurredAt = event.occurredAt;
  }
  if (event.message !== undefined) {
    payload.message = event.message;
  }
  return normalizeSyncTransportStatus(
    await invokeDesktopNative<unknown>("sync_transport_record_lifecycle_event", { payload }),
  );
}

async function syncTrustedPeerNow(deviceId: string, options?: SyncTransportSyncNowOptions) {
  const endpointHints = normalizedEndpointHints(options?.endpointHints);
  const endpointHint = options?.endpointHint?.trim() || endpointHints[0];
  const payload: Record<string, unknown> = { peerDeviceId: deviceId, preferredTransport: "auto" };
  if (endpointHint) {
    payload.endpointHint = endpointHint;
  }
  if (endpointHints.length) {
    payload.endpointHints = endpointHints;
  }
  const result = normalizeSyncRunStatus(
    await invokeDesktopNative<unknown>("sync_transport_sync_now", {
      payload,
    }),
  );
  if (!result) {
    throw new Error("Native sync transport returned an invalid sync result.");
  }
  return result;
}

async function createNativeSyncPairingOffer(body: SyncPairingOfferRequest): Promise<SyncPairingOfferResponse> {
  const nativeResponse = asRecord(
    await invokeDesktopNative<unknown>("sync_transport_create_pairing_offer", {
      payload: { ttlSeconds: body.ttl_seconds },
    }),
  );
  const pairingOffer = asRecord(nativeResponse?.pairingOffer) ?? asRecord(nativeResponse?.pairing_offer);
  if (!pairingOffer) {
    throw new Error("Native sync transport returned an invalid pairing offer.");
  }
  if (asRecord(pairingOffer.pairing_offer)) {
    return pairingOffer as SyncPairingOfferResponse;
  }
  return { pairing_offer: pairingOffer as SyncPairingOfferResponse["pairing_offer"] };
}

export type TuneForgeClient = {
  getMobileCapabilities: () => Promise<RuntimeCapabilities>;
  ensureWebMediaTransport: () => Promise<void>;
  getHealth: () => Promise<HealthResponse>;
  getExportCapabilities: () => Promise<ExportCapabilitiesResponse>;
  listProjects: (params?: ListProjectsParams) => Promise<components["schemas"]["ProjectsResponse"]>;
  importProject: (body: ProjectImportRequest) => Promise<components["schemas"]["ProjectResponse"]>;
  getProject: (projectId: string) => Promise<components["schemas"]["ProjectResponse"]>;
  updateProject: (projectId: string, body: ProjectUpdateRequest) => Promise<components["schemas"]["ProjectResponse"]>;
  deleteProject: (projectId: string) => Promise<components["schemas"]["DeleteResponse"]>;
  analyzeProject: (projectId: string, body?: AnalysisRequest) => Promise<components["schemas"]["JobResponse"]>;
  getAnalysis: (projectId: string) => Promise<AnalysisResponse>;
  listBeatBackends: () => Promise<BeatBackendsResponse>;
  listChordBackends: () => Promise<ChordBackendsResponse>;
  listStemModels: () => Promise<StemModelsResponse>;
  createChords: (projectId: string, body: ChordRequest) => Promise<components["schemas"]["JobResponse"]>;
  getChords: (projectId: string) => Promise<ChordResponse>;
  createLyrics: (projectId: string, body: LyricsGenerateRequest) => Promise<components["schemas"]["JobResponse"]>;
  getLyrics: (projectId: string) => Promise<LyricsResponse>;
  updateLyrics: (projectId: string, body: LyricsUpdateRequest) => Promise<LyricsResponse>;
  createTabImport: (projectId: string, body: TabImportCreateRequest) => Promise<TabImportResponse>;
  getTabImport: (projectId: string, tabImportId: string) => Promise<TabImportResponse>;
  acceptTabImport: (
    projectId: string,
    tabImportId: string,
    body: TabImportApplyRequest,
  ) => Promise<TabImportApplyResponse>;
  listSections: (projectId: string) => Promise<SongSectionsResponse>;
  createPreview: (projectId: string, body: PreviewRequest) => Promise<components["schemas"]["JobResponse"]>;
  createStems: (projectId: string, body: StemRequest) => Promise<components["schemas"]["JobResponse"]>;
  createRetune: (projectId: string, body: RetuneRequest) => Promise<components["schemas"]["JobResponse"]>;
  createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) => Promise<components["schemas"]["JobResponse"]>;
  listArtifacts: (projectId: string) => Promise<components["schemas"]["ArtifactsResponse"]>;
  deleteArtifact: (projectId: string, artifactId: string) => Promise<components["schemas"]["DeleteResponse"]>;
  createExport: (projectId: string, body: ExportRequest) => Promise<components["schemas"]["JobResponse"]>;
  listJobs: (params?: ListJobsParams) => Promise<JobsResponse>;
  getJob: (jobId: string) => Promise<components["schemas"]["JobResponse"]>;
  cancelJob: (jobId: string) => Promise<components["schemas"]["JobResponse"]>;
  bulkJobs: (body: BulkJobRequest) => Promise<BulkJobsResponse>;
  getSyncPreflight: () => Promise<SyncPreflightResponse>;
  getSyncIdentity: () => Promise<SyncLocalIdentityResponse>;
  createSyncPairingOffer: (body: SyncPairingOfferRequest) => Promise<SyncPairingOfferResponse>;
  answerSyncPairingOffer: (body: SyncPairingAnswerRequest) => Promise<SyncPairingAnswerResponse>;
  listSyncTrustedPeers: () => Promise<SyncTrustedPeersResponse>;
  trustSyncPeer: (body: SyncTrustedPeerCreateRequest) => Promise<SyncTrustedPeerResponse>;
  revokeSyncTrustedPeer: (deviceId: string) => Promise<SyncTrustedPeerResponse>;
  getSyncTransportStatus: () => Promise<SyncTransportStatus>;
  startSyncListener: () => Promise<SyncTransportStatus>;
  stopSyncListener: () => Promise<SyncTransportStatus>;
  recordSyncLifecycleEvent: (event: SyncLifecycleEventRequest) => Promise<SyncTransportStatus>;
  syncTrustedPeerNow: (
    deviceId: string,
    options?: SyncTransportSyncNowOptions,
  ) => Promise<SyncTransportRunStatus>;
  streamArtifactUrl: (artifactId: string) => string;
};

let client = createClient<paths>({ baseUrl: apiBaseUrl });
const mobileChordBackendsResponse: ChordBackendsResponse = {
  backends: [
    {
      availability: "available",
      available: true,
      capabilities: {
        desktopOnly: false,
        estimatedSpeed: "medium",
        experimental: false,
        supportsConfidence: true,
        supportsInversions: false,
        supportsNoChord: true,
        supportsSevenths: true,
      },
      description: "TuneForge's built-in lightweight chord detector.",
      desktopOnly: false,
      experimental: false,
      id: "tuneforge-fast",
      label: "Built-in Chords",
      unavailable_reason: null,
    },
    {
      availability: "unavailable",
      available: false,
      capabilities: {
        desktopOnly: true,
        estimatedSpeed: "slow",
        experimental: true,
        supportsConfidence: true,
        supportsInversions: true,
        supportsNoChord: true,
        supportsSevenths: true,
      },
      description: "Optional crema chord detector for desktop builds.",
      desktopOnly: true,
      experimental: true,
      id: "crema-advanced",
      label: "Advanced Chords",
      unavailable_reason: "advanced chord backend is disabled on mobile",
    },
  ],
};
const mobileBeatBackendsResponse: BeatBackendsResponse = {
  backends: [
    {
      availability: "available",
      available: true,
      description: "TuneForge's built-in beat detector.",
      desktopOnly: false,
      experimental: false,
      id: "built-in",
      label: "Built-in Beat Analysis",
      runtime_device: "cpu",
      unavailable_reason: null,
    },
    {
      availability: "unavailable",
      available: false,
      description: "Optional beat-this beat detector for desktop builds.",
      desktopOnly: true,
      experimental: true,
      id: "beat-this",
      label: "Advanced Beat Analysis",
      runtime_device: "cpu",
      unavailable_reason: "advanced beat analysis is disabled on mobile",
    },
  ],
};
const mobileStemModelsResponse: StemModelsResponse = {
  models: [
    {
      availability: "unavailable",
      available: false,
      default: true,
      description: "Demucs six-source stem separation is not available on mobile.",
      id: "htdemucs_6s",
      label: "Default (6 stems model)",
      sourceCount: 6,
      sources: ["vocals", "drums", "bass", "guitar", "piano", "other"],
      unavailable_reason: "stem separation is disabled on mobile",
    },
    {
      availability: "unavailable",
      available: false,
      default: false,
      description: "Demucs two-source stem separation is not available on mobile.",
      id: "htdemucs_ft",
      label: "2 stems model",
      sourceCount: 2,
      sources: ["vocals", "instrumental"],
      unavailable_reason: "stem separation is disabled on mobile",
    },
  ],
};

export class ApiError extends Error {
  code: string;
  details: unknown;

  constructor(payload: ErrorResponse["error"]) {
    super(payload.message);
    this.code = payload.code;
    this.details = payload.details;
  }
}

function normalizeError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null && "error" in error) {
    const payload = error as ErrorResponse;
    return new ApiError(payload.error);
  }
  if (typeof error === "object" && error !== null && "detail" in error) {
    const payload = error as ValidationErrorResponse;
    const message = payload.detail?.[0]?.msg ?? "The request failed validation.";
    return new ApiError({ code: "INVALID_REQUEST", message, details: payload.detail ?? [] });
  }
  return new ApiError({ code: "UNKNOWN_ERROR", message: "The request failed.", details: error });
}

async function unwrap<T>(promise: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    throw normalizeError(error);
  }
  if (!data) {
    throw new Error("The backend returned an empty response.");
  }
  return data;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeMobile<T>(command: string, args?: Record<string, unknown>) {
  return invoke<T>(command, args);
}

function createHttpTuneForgeClient(): TuneForgeClient {
  return {
    getMobileCapabilities: async () => null,
    ensureWebMediaTransport: async () => {},
    getHealth: () => unwrap(client.GET("/api/v1/health")),
    getExportCapabilities: () => unwrap(client.GET("/api/v1/export-capabilities")),
    listProjects: (params?: ListProjectsParams) =>
      unwrap(client.GET("/api/v1/projects", params ? { params: { query: params } } : undefined)),
    importProject: (body: ProjectImportRequest) =>
      unwrap(client.POST("/api/v1/projects/import", { body })),
    getProject: (projectId: string) => unwrap(client.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    updateProject: (projectId: string, body: ProjectUpdateRequest) =>
      unwrap(client.PATCH("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } }, body })),
    deleteProject: (projectId: string) =>
      unwrap(client.DELETE("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    analyzeProject: (projectId: string, request?: AnalysisRequest) =>
      unwrap(
        client.POST("/api/v1/projects/{project_id}/analyze", {
          params: { path: { project_id: projectId } },
          body: { include_tempo: false, force: false, ...request },
        }),
      ),
    getAnalysis: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/analysis", { params: { path: { project_id: projectId } } })),
    listBeatBackends: () => unwrap(client.GET("/api/v1/beat-backends")),
    listChordBackends: () => unwrap(client.GET("/api/v1/chord-backends")),
    listStemModels: () => unwrap(client.GET("/api/v1/stem-models")),
    createChords: (projectId: string, body: ChordRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/chords", { params: { path: { project_id: projectId } }, body })),
    getChords: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/chords", { params: { path: { project_id: projectId } } })),
    createLyrics: (projectId: string, body: LyricsGenerateRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/lyrics", { params: { path: { project_id: projectId } }, body })),
    getLyrics: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/lyrics", { params: { path: { project_id: projectId } } })),
    updateLyrics: (projectId: string, body: LyricsUpdateRequest) =>
      unwrap(client.PUT("/api/v1/projects/{project_id}/lyrics", { params: { path: { project_id: projectId } }, body })),
    createTabImport: (projectId: string, body: TabImportCreateRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/tabs/proposals", { params: { path: { project_id: projectId } }, body })),
    getTabImport: (projectId: string, tabImportId: string) =>
      unwrap(
        client.GET("/api/v1/projects/{project_id}/tabs/{tab_import_id}", {
          params: { path: { project_id: projectId, tab_import_id: tabImportId } },
        }),
      ),
    acceptTabImport: (projectId: string, tabImportId: string, body: TabImportApplyRequest) =>
      unwrap(
        client.POST("/api/v1/projects/{project_id}/tabs/{tab_import_id}/accept", {
          params: { path: { project_id: projectId, tab_import_id: tabImportId } },
          body,
        }),
      ),
    listSections: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/sections", { params: { path: { project_id: projectId } } })),
    createPreview: (projectId: string, body: PreviewRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/preview", { params: { path: { project_id: projectId } }, body })),
    createStems: (projectId: string, body: StemRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/stems", { params: { path: { project_id: projectId } }, body })),
    createRetune: (projectId: string, body: RetuneRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/retune", { params: { path: { project_id: projectId } }, body })),
    createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/transpose", { params: { path: { project_id: projectId } }, body })),
    listArtifacts: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/artifacts", { params: { path: { project_id: projectId } } })),
    deleteArtifact: (projectId: string, artifactId: string) =>
      unwrap(
        client.DELETE("/api/v1/projects/{project_id}/artifacts/{artifact_id}", {
          params: { path: { project_id: projectId, artifact_id: artifactId } },
        }),
      ),
    createExport: (projectId: string, body: ExportRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/export", { params: { path: { project_id: projectId } }, body })),
    listJobs: (params?: ListJobsParams) =>
      unwrap(client.GET("/api/v1/jobs", params ? { params: { query: params } } : undefined)),
    getJob: (jobId: string) => unwrap(client.GET("/api/v1/jobs/{job_id}", { params: { path: { job_id: jobId } } })),
    cancelJob: (jobId: string) =>
      unwrap(client.POST("/api/v1/jobs/{job_id}/cancel", { params: { path: { job_id: jobId } } })),
    bulkJobs: (body: BulkJobRequest) => unwrap(client.POST("/api/v1/jobs/bulk", { body })),
    getSyncPreflight: async () => normalizeSyncPreflightResponse(await unwrap(client.GET("/api/v1/sync/preflight"))),
    getSyncIdentity: () => unwrap(client.GET("/api/v1/sync/identity")),
    createSyncPairingOffer: (body: SyncPairingOfferRequest) =>
      isTauriRuntime()
        ? createNativeSyncPairingOffer(body)
        : unwrap(client.POST("/api/v1/sync/pairing/offers", { body })),
    answerSyncPairingOffer: (body: SyncPairingAnswerRequest) =>
      unwrap(client.POST("/api/v1/sync/pairing/responses", { body })),
    listSyncTrustedPeers: () => unwrap(client.GET("/api/v1/sync/trusted-peers")),
    trustSyncPeer: (body: SyncTrustedPeerCreateRequest) =>
      unwrap(client.POST("/api/v1/sync/trusted-peers", { body })),
    revokeSyncTrustedPeer: (deviceId: string) =>
      unwrap(
        client.DELETE("/api/v1/sync/trusted-peers/{device_id}", {
          params: { path: { device_id: deviceId } },
        }),
      ),
    getSyncTransportStatus,
    startSyncListener,
    stopSyncListener,
    recordSyncLifecycleEvent,
    syncTrustedPeerNow,
    streamArtifactUrl: (artifactId: string) => `${getApiBaseUrl()}/api/v1/artifacts/${artifactId}/stream`,
  };
}

function createMobileTuneForgeClient(capabilities: MobileCapabilities): TuneForgeClient {
  let mediaBaseUrl: string | null = null;
  let mediaInitialization: Promise<void> | null = null;
  const ensureWebMediaTransport = () => {
    if (mediaBaseUrl) {
      return Promise.resolve();
    }
    if (!mediaInitialization) {
      mediaInitialization = invokeMobile<string>("mobile_media_base_url")
        .then((baseUrl) => {
          if (!baseUrl) {
            throw new Error("Mobile media transport returned an invalid URL.");
          }
          mediaBaseUrl = baseUrl;
        })
        .catch((error: unknown) => {
          mediaInitialization = null;
          throw error;
        });
    }
    return mediaInitialization;
  };
  const requireSupportedMobileAnalysisBackend = (request?: { beat_backend?: BeatAnalysisBackend }) => {
    if (request?.beat_backend === "beat-this") {
      throw new ApiError({
        code: "UNSUPPORTED_RUNTIME",
        message: "Advanced beat analysis is not available on mobile yet.",
        details: { beat_backend: request.beat_backend },
      });
    }
  };

  return {
    getMobileCapabilities: async () => capabilities,
    ensureWebMediaTransport,
    getHealth: () => invokeMobile("mobile_get_health"),
    getExportCapabilities: async () => ({
      capabilities: {
        platform: "android",
        formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({
          id,
          available: false,
          reason: "Android audio export is not available in this build.",
        })),
        destinations: ["single_file", "folder", "zip"].map((id) => ({
          id,
          available: false,
          reason: "Android audio export is not available in this build.",
        })),
        max_artifact_count: 1,
      },
    }),
    listProjects: (params?: ListProjectsParams) =>
      invokeMobile("mobile_list_projects", { params: params ?? null }),
    importProject: async (body: ProjectImportRequest) => {
      requireSupportedMobileAnalysisBackend(body);
      return invokeMobile("mobile_import_project", { payload: body });
    },
    getProject: (projectId: string) => invokeMobile("mobile_get_project", { projectId }),
    updateProject: (projectId: string, body: ProjectUpdateRequest) =>
      invokeMobile("mobile_update_project", { projectId, payload: body }),
    deleteProject: (projectId: string) => invokeMobile("mobile_delete_project", { projectId }),
    analyzeProject: async (projectId: string, request?: AnalysisRequest) => {
      requireSupportedMobileAnalysisBackend(request);
      return invokeMobile("mobile_submit_analyze", { projectId });
    },
    getAnalysis: (projectId: string) => invokeMobile("mobile_get_analysis", { projectId }),
    listBeatBackends: async () => mobileBeatBackendsResponse,
    listChordBackends: async () => mobileChordBackendsResponse,
    listStemModels: async () => mobileStemModelsResponse,
    createChords: (projectId: string, body: ChordRequest) =>
      invokeMobile("mobile_submit_chords", { projectId, payload: body }),
    getChords: (projectId: string) => invokeMobile("mobile_get_chords", { projectId }),
    createLyrics: (projectId: string, body: LyricsGenerateRequest) =>
      invokeMobile("mobile_submit_lyrics", { projectId, payload: body }),
    getLyrics: (projectId: string) => invokeMobile("mobile_get_lyrics", { projectId }),
    updateLyrics: (projectId: string, body: LyricsUpdateRequest) =>
      invokeMobile("mobile_update_lyrics", { projectId, payload: body }),
    createTabImport: async () => {
      throw new ApiError({
        code: "UNSUPPORTED_RUNTIME",
        message: "Tab import is not available on mobile yet.",
        details: {},
      });
    },
    getTabImport: async () => {
      throw new ApiError({
        code: "UNSUPPORTED_RUNTIME",
        message: "Tab import is not available on mobile yet.",
        details: {},
      });
    },
    acceptTabImport: async () => {
      throw new ApiError({
        code: "UNSUPPORTED_RUNTIME",
        message: "Tab import is not available on mobile yet.",
        details: {},
      });
    },
    listSections: async () => ({ sections: [] }),
    createPreview: (projectId: string, body: PreviewRequest) =>
      invokeMobile("mobile_submit_preview", { projectId, payload: body }),
    createStems: (projectId: string, body: StemRequest) =>
      invokeMobile("mobile_submit_stems", { projectId, payload: body }),
    createRetune: (projectId: string, body: RetuneRequest) =>
      invokeMobile("mobile_submit_retune", { projectId, payload: body }),
    createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) =>
      invokeMobile("mobile_submit_transpose", { projectId, payload: body }),
    listArtifacts: (projectId: string) => invokeMobile("mobile_list_artifacts", { projectId }),
    deleteArtifact: (projectId: string, artifactId: string) =>
      invokeMobile("mobile_delete_artifact", { projectId, artifactId }),
    createExport: (projectId: string, body: ExportRequest) =>
      invokeMobile("mobile_submit_export", { projectId, payload: body }),
    listJobs: (params?: ListJobsParams) => invokeMobile("mobile_list_jobs", { params: params ?? null }),
    getJob: (jobId: string) => invokeMobile("mobile_get_job", { jobId }),
    cancelJob: (jobId: string) => invokeMobile("mobile_cancel_job", { jobId }),
    bulkJobs: async () => {
      throw unsupportedRuntimeError("Bulk jobs");
    },
    getSyncPreflight: async () =>
      normalizeSyncPreflightResponse(mobileReadySyncPreflightResponse()),
    getSyncIdentity: () => invokeMobile("mobile_get_sync_identity"),
    createSyncPairingOffer: (body: SyncPairingOfferRequest) =>
      invokeMobile("mobile_create_sync_pairing_offer", { payload: body }),
    answerSyncPairingOffer: (body: SyncPairingAnswerRequest) =>
      invokeMobile("mobile_answer_sync_pairing_offer", { payload: body }),
    listSyncTrustedPeers: () => invokeMobile("mobile_list_sync_trusted_peers"),
    trustSyncPeer: (body: SyncTrustedPeerCreateRequest) =>
      invokeMobile("mobile_trust_sync_peer", { payload: body }),
    revokeSyncTrustedPeer: (deviceId: string) =>
      invokeMobile("mobile_revoke_sync_trusted_peer", { deviceId }),
    getSyncTransportStatus,
    startSyncListener,
    stopSyncListener,
    recordSyncLifecycleEvent,
    syncTrustedPeerNow,
    streamArtifactUrl: (artifactId: string) =>
      mediaBaseUrl ? `${mediaBaseUrl}/artifacts/${encodeURIComponent(artifactId)}` : "",
  };
}

let activeClient = createHttpTuneForgeClient();

export async function initializeApi() {
  if (!runtimeInitPromise) {
    runtimeInitPromise = (async () => {
      if (!isTauriRuntime()) {
        return apiBaseUrl;
      }

      try {
        const capabilities = await invoke<MobileCapabilities>("mobile_capabilities");
        apiBaseUrl = "mobile://embedded";
        activeClient = createMobileTuneForgeClient(capabilities);
        return apiBaseUrl;
      } catch {
        activeClient = createHttpTuneForgeClient();
      }

      try {
        const resolved = await invoke<string>("backend_base_url");
        apiBaseUrl = resolved;
        client = createClient<paths>({ baseUrl: apiBaseUrl });
        activeClient = createHttpTuneForgeClient();
      } catch {
        apiBaseUrl = DEFAULT_API_BASE_URL;
        client = createClient<paths>({ baseUrl: apiBaseUrl });
        activeClient = createHttpTuneForgeClient();
      }

      return apiBaseUrl;
    })();
  }

  return runtimeInitPromise;
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export const api: TuneForgeClient = {
  getMobileCapabilities: () => activeClient.getMobileCapabilities(),
  ensureWebMediaTransport: () => activeClient.ensureWebMediaTransport(),
  getHealth: () => activeClient.getHealth(),
  getExportCapabilities: () => activeClient.getExportCapabilities(),
  listProjects: (params?: ListProjectsParams) => activeClient.listProjects(params),
  importProject: (body) => activeClient.importProject(body),
  getProject: (projectId: string) => activeClient.getProject(projectId),
  updateProject: (projectId: string, body: ProjectUpdateRequest) => activeClient.updateProject(projectId, body),
  deleteProject: (projectId: string) => activeClient.deleteProject(projectId),
  analyzeProject: (projectId: string, body?: AnalysisRequest) => activeClient.analyzeProject(projectId, body),
  getAnalysis: (projectId: string) => activeClient.getAnalysis(projectId),
  listBeatBackends: () => activeClient.listBeatBackends(),
  listChordBackends: () => activeClient.listChordBackends(),
  listStemModels: () => activeClient.listStemModels(),
  createChords: (projectId: string, body: ChordRequest) => activeClient.createChords(projectId, body),
  getChords: (projectId: string) => activeClient.getChords(projectId),
  createLyrics: (projectId: string, body: LyricsGenerateRequest) => activeClient.createLyrics(projectId, body),
  getLyrics: (projectId: string) => activeClient.getLyrics(projectId),
  updateLyrics: (projectId: string, body: LyricsUpdateRequest) => activeClient.updateLyrics(projectId, body),
  createTabImport: (projectId: string, body: TabImportCreateRequest) => activeClient.createTabImport(projectId, body),
  getTabImport: (projectId: string, tabImportId: string) => activeClient.getTabImport(projectId, tabImportId),
  acceptTabImport: (projectId: string, tabImportId: string, body: TabImportApplyRequest) =>
    activeClient.acceptTabImport(projectId, tabImportId, body),
  listSections: (projectId: string) => activeClient.listSections(projectId),
  createPreview: (projectId: string, body: PreviewRequest) => activeClient.createPreview(projectId, body),
  createStems: (projectId: string, body: StemRequest) => activeClient.createStems(projectId, body),
  createRetune: (projectId: string, body: RetuneRequest) => activeClient.createRetune(projectId, body),
  createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) => activeClient.createTranspose(projectId, body),
  listArtifacts: (projectId: string) => activeClient.listArtifacts(projectId),
  deleteArtifact: (projectId: string, artifactId: string) => activeClient.deleteArtifact(projectId, artifactId),
  createExport: (projectId: string, body: ExportRequest) => activeClient.createExport(projectId, body),
  listJobs: (params?: ListJobsParams) => activeClient.listJobs(params),
  getJob: (jobId: string) => activeClient.getJob(jobId),
  cancelJob: (jobId: string) => activeClient.cancelJob(jobId),
  bulkJobs: (body: BulkJobRequest) => activeClient.bulkJobs(body),
  getSyncPreflight: () => activeClient.getSyncPreflight(),
  getSyncIdentity: () => activeClient.getSyncIdentity(),
  createSyncPairingOffer: (body: SyncPairingOfferRequest) => activeClient.createSyncPairingOffer(body),
  answerSyncPairingOffer: (body: SyncPairingAnswerRequest) => activeClient.answerSyncPairingOffer(body),
  listSyncTrustedPeers: () => activeClient.listSyncTrustedPeers(),
  trustSyncPeer: (body: SyncTrustedPeerCreateRequest) => activeClient.trustSyncPeer(body),
  revokeSyncTrustedPeer: (deviceId: string) => activeClient.revokeSyncTrustedPeer(deviceId),
  getSyncTransportStatus: () => activeClient.getSyncTransportStatus(),
  startSyncListener: () => activeClient.startSyncListener(),
  stopSyncListener: () => activeClient.stopSyncListener(),
  recordSyncLifecycleEvent: (event: SyncLifecycleEventRequest) => activeClient.recordSyncLifecycleEvent(event),
  syncTrustedPeerNow: (deviceId: string, options?: SyncTransportSyncNowOptions) =>
    activeClient.syncTrustedPeerNow(deviceId, options),
  streamArtifactUrl: (artifactId: string) => activeClient.streamArtifactUrl(artifactId),
};
