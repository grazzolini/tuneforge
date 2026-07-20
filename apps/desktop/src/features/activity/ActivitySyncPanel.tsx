import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import {
  api,
  countSyncProjectResultsByStatus,
  isFinalSyncProjectResult,
  mergeSyncProjectResults,
  syncCanonicalSummaryMessage,
  syncRunCanonicalCounts,
  syncRunCanonicalSummaryMessage,
  type SyncPairingPayloadSchema,
  type SyncNearbyPeer,
  type SyncNearbyPeerTrustStatus,
  type SyncPreflightBlockingJob,
  type SyncPreflightResponse,
  type SyncTransportLifecycleEvent,
  type SyncTransportProjectResult,
  type SyncTransportRunStatus,
  type SyncTransportStatus,
  type SyncTransportTransferResult,
  type SyncTrustedPeerSchema,
} from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime } from "../../lib/datetime";
import { scanPairingQrCode } from "../../lib/pairingQrScanner";
import {
  getPowerInhibitionVersion,
  readPowerInhibitionStatus,
  refreshPowerInhibitionStatus,
  subscribePowerInhibition,
  syncPowerProtectionMessage,
} from "../../lib/powerInhibition";
import {
  decodePairingCode,
  encodePairingCode,
  pairingCodeIsExpired,
  pairingFingerprint,
} from "./syncPairingCode";

const PAIRING_OFFER_TTL_SECONDS = 600;
const SYNC_LISTENER_POLL_INTERVAL_MS = 2000;
const DESKTOP_SLEEP_CHECK_INTERVAL_MS = 10_000;
const DESKTOP_SLEEP_ELAPSED_THRESHOLD_MS = 90_000;
const EMPTY_NEARBY_PEERS: SyncNearbyPeer[] = [];
const PROJECT_MUTATION_QUERY_KEYS = [
  ["projects"],
  ["project"],
  ["lyrics"],
  ["chords"],
  ["analysis"],
  ["sections"],
  ["artifacts"],
  ["jobs"],
] as const;
const SYNC_PROJECT_MUTATION_STATUSES = new Set(["applied", "conflicted", "deleted", "imported"]);
const SYNC_MANIFEST_EXPORT_ERROR_STATUS = "manifest_export_error";
const SYNC_EVIDENCE_FILE_EXTENSIONS = "wav|mp3|flac|m4a|aac|ogg|aiff|aif|json|sqlite|db|txt|csv|log|zip|png|jpe?g";
const SYNC_EVIDENCE_QUOTED_PATH_PATTERN = new RegExp(
  `(^|[\\s(])(["'])((?:file:\\/\\/(?:localhost)?(?:[A-Za-z]:[\\\\/]|\\/)?|[A-Za-z]:[\\\\/]|\\/)[^"'\\r\\n]*)\\2`,
  "gi",
);
const SYNC_EVIDENCE_PATH_WITH_EXTENSION_PATTERN = new RegExp(
  `(^|[\\s(])((?:file:\\/\\/(?:localhost)?(?:[A-Za-z]:[\\\\/]|\\/)?|[A-Za-z]:[\\\\/]|\\/)[^"'\\r\\n,;)]*?\\.(?:${SYNC_EVIDENCE_FILE_EXTENSIONS})\\b)`,
  "gi",
);
const SYNC_EVIDENCE_FILE_URI_PATTERN = /\bfile:\/\/[^\s"'<>),;]+/gi;
const SYNC_EVIDENCE_WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'<>),;]+(?:[\\/][^\s"'<>),;]+)*/g;
const SYNC_EVIDENCE_POSIX_PATH_PATTERN = /(^|[\s(])\/[^\s"'<>),;]+(?:\/[^\s"'<>),;]+)*/g;
const SYNC_EVIDENCE_FILENAME_PATTERN = new RegExp(
  `\\b[^/\\\\\\s]+\\.(?:${SYNC_EVIDENCE_FILE_EXTENSIONS})\\b`,
  "gi",
);
const SYNC_EVIDENCE_RAW_ID_TOKEN_PATTERN =
  /\b(?:device|proj|art|session|run|project|artifact|sync)_[A-Za-z0-9][A-Za-z0-9._:-]*\b/gi;
const SYNC_EVIDENCE_SAFE_PHASES = new Set([
  "artifact_cleanup", "artifact_staging", "artifact_staging_check", "artifact_transfer", "initiator_import",
  "local_manifest_export", "manifest_exchange", "peer_authentication", "peer_connect", "planning",
  "reconciliation_apply", "reconciliation_apply_project", "reconciliation_plan", "reconciliation_staging",
  "responder_import", "serve_artifact_requests",
]);
const SYNC_EVIDENCE_PHASE_ALIASES = new Map([
  ["network_receive", "artifact_transfer"], ["staging_post", "artifact_staging"],
  ["staging_apply_plan", "reconciliation_staging"], ["backend_staging", "artifact_staging"],
]);
const SYNC_EVIDENCE_PROBLEM_STATUSES = new Set(["failed", "completed_with_errors", "conflicted", "error", "errored"]);
const SYNC_EVIDENCE_SAFE_RAW_TOKENS = new Set([
  ...SYNC_EVIDENCE_SAFE_PHASES,
  ...Array.from(SYNC_EVIDENCE_PROBLEM_STATUSES).flatMap((status) =>
    [`run_status_${status}`, `project_status_${status}`, `artifact_status_${status}`]),
  "failed_project_count", "conflicted_project_count", "manifest_export_error_count",
  "project_failed_count", "project_counter_failed_count", "run_outcome",
]);
const SYNC_EVIDENCE_HASH_TOKEN_PATTERN =
  /(?<![A-Za-z0-9])(?:sha(?:-?256)?|hash|checksum)[_:.-][A-Za-z0-9][A-Za-z0-9._:-]*\b|(?<![A-Za-z0-9])[a-f0-9]{32,}(?![A-Za-z0-9])/gi;
const SYNC_EVIDENCE_SAFE_HASH_TOKENS = new Set(["checksum_mismatch", "hash_retry_pending", "sha256_mismatch"]);
const SYNC_NOW_FAILURE_ENDPOINT_TOKEN_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;

type PairingOutputKind = "offer" | "response";
type PairingOutput = {
  kind: PairingOutputKind;
  code: string;
  rawJson: string;
  payload: SyncPairingPayloadSchema;
  state: "waiting" | "answer received";
};
type SyncNowRequest = {
  deviceId: string;
  endpointHints?: string[];
};
type SyncLifecycleRecordOptions = {
  message?: string;
  refreshListener?: boolean;
  updateListenerStatus?: boolean;
};
type RetryableSyncInterruption = {
  peerDeviceId: string;
  endpointHints?: string[];
  code: string;
  guidance: string | null;
};
type SyncRetrySource = {
  retryable_interruption_code?: string | null;
  retryable_interruption_peer_device_id?: string | null;
  retry_guidance?: string | null;
  last_lifecycle_event?: SyncTransportLifecycleEvent | null;
  lifecycle_events?: SyncTransportLifecycleEvent[];
  peer_device_id?: string | null;
  remote_device_id?: string | null;
};

function statusLabel(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return "Unknown";
  }
  return normalized
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function syncEvidencePhase(value: string | null | undefined) {
  const rawPhase = value?.trim().toLowerCase() ?? null;
  const phase = rawPhase ? SYNC_EVIDENCE_PHASE_ALIASES.get(rawPhase) ?? rawPhase : null;
  return phase && SYNC_EVIDENCE_SAFE_PHASES.has(phase) ? phase : phase ? "phase_redacted" : null;
}

function statusClassName(value: string | null | undefined) {
  return (value?.trim().toLowerCase() || "unknown").replace(/[^a-z0-9_-]+/g, "_");
}

function transportLabel(value: string | null | undefined) {
  const raw = value?.trim().toLowerCase();
  let normalized = raw;
  if (raw?.startsWith("tuneforge-sync+iroh")) {
    normalized = "iroh";
  } else if (raw?.startsWith("tuneforge-sync+tcp")) {
    normalized = "tcp";
  }
  if (!normalized) {
    return null;
  }
  if (normalized === "iroh") {
    return "Iroh";
  }
  if (normalized === "tcp") {
    return "TCP";
  }
  if (normalized === "auto") {
    return "Auto";
  }
  return statusLabel(normalized);
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = normalizeApiDateTime(value);
  if (Number.isNaN(new Date(normalized).getTime())) {
    return null;
  }
  return formatLocalDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function copyToClipboard(value: string, source?: HTMLTextAreaElement | null) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to the visible text area below.
    }
  }
  if (source && typeof document.execCommand === "function") {
    source.focus();
    source.select();
    return document.execCommand("copy");
  }
  return false;
}

function syncEvidenceFileName(capturedAt: string) {
  return `tuneforge-sync-evidence-${capturedAt.replace(/[:.]/g, "-")}.json`;
}

function downloadSyncEvidenceJson(fileName: string, json: string) {
  const blob = new Blob([json], { type: "application/json" });
  const downloadUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    window.URL.revokeObjectURL(downloadUrl);
  }, 5000);
}

async function saveSyncEvidenceJson(fileName: string, json: string) {
  try {
    return await invoke<boolean | null>("write_sync_evidence_file", {
      contents: json,
      defaultFileName: fileName,
    }) === true;
  } catch {
    throw new Error("Could not export sync evidence. Choose another location and try again.");
  }
}

function peerLabel(peer: SyncTrustedPeerSchema) {
  return peer.display_name?.trim() || peer.device_id;
}

function peerEndpointSummary(peer: SyncTrustedPeerSchema) {
  return peer.endpoint_hints?.length ? peer.endpoint_hints.join(", ") : "No endpoint hints";
}

function nearbyPeerLabel(peer: SyncNearbyPeer) {
  return peer.display_name?.trim() || peer.device_id || "Nearby TuneForge device";
}

function nearbyPeerEndpointSummary(peer: SyncNearbyPeer) {
  return peer.endpoint_hints.length ? peer.endpoint_hints.join(", ") : "No endpoint hints";
}

function nearbyPeerFingerprint(peer: SyncNearbyPeer, trustedPeer: SyncTrustedPeerSchema | null) {
  return peer.short_fingerprint?.trim() ||
    pairingFingerprint({
      device_id: peer.device_id ?? trustedPeer?.device_id,
      public_key: peer.public_key ?? trustedPeer?.public_key,
    });
}

function nearbyTrustedDeviceId(peer: SyncNearbyPeer) {
  return peer.trusted_peer_device_id ?? peer.device_id ?? null;
}

function nearbyTrustStatus(
  peer: SyncNearbyPeer,
  trustedPeer: SyncTrustedPeerSchema | null,
): SyncNearbyPeerTrustStatus {
  if (peer.trust_status === "mismatch") {
    return "mismatch";
  }
  if (!trustedPeer) {
    return "unknown";
  }
  if (peer.public_key && trustedPeer.public_key && peer.public_key !== trustedPeer.public_key) {
    return "mismatch";
  }
  return peer.trust_status === "unknown" ? "match" : peer.trust_status;
}

function nearbyTrustLabel(value: SyncNearbyPeerTrustStatus) {
  if (value === "match") {
    return "Trusted";
  }
  if (value === "mismatch") {
    return "Trust mismatch";
  }
  return "Unknown";
}

function pairingPayloadLabel(payload: SyncPairingPayloadSchema) {
  return payload.display_name?.trim() || payload.device_id;
}

function pairingOutputForPayload(kind: PairingOutputKind, payload: SyncPairingPayloadSchema): PairingOutput {
  return {
    kind,
    code: encodePairingCode(payload),
    rawJson: JSON.stringify(payload, null, 2),
    payload,
    state: kind === "offer" ? "waiting" : "answer received",
  };
}

function parsePairingInput(value: string) {
  const payload = decodePairingCode(value);
  if (pairingCodeIsExpired(payload)) {
    throw new Error("Pairing payload expired.");
  }
  return payload;
}

function syncStatusText(status: SyncTransportRunStatus | null | undefined, peersById: Map<string, SyncTrustedPeerSchema>) {
  if (!status) {
    return "No sync run yet.";
  }
  const peer = status.peer_device_id ? peersById.get(status.peer_device_id) : null;
  const peerName = peer ? peerLabel(peer) : status.peer_device_id ?? "peer";
  if (status.error) {
    return `${statusLabel(status.status)} for ${peerName}: ${
      syncVisibleNativeDetailText(status.error, "details redacted.") ?? "details redacted."
    }`;
  }
  const canonicalSummary = syncRunCanonicalSummaryMessage(status);
  const explicitMessage = status.message?.trim() || null;
  if (["failed", "error", "errored"].includes(status.status.trim().toLowerCase()) && explicitMessage) {
    return syncNowFailureStatusMessage(explicitMessage);
  }
  const canonicalCounts = syncRunCanonicalCounts(status);
  const explicitMessageIsCanonical = Boolean(
    explicitMessage && canonicalCounts && explicitMessage === syncCanonicalSummaryMessage(canonicalCounts),
  );
  const noProjectChanges = canonicalCounts &&
    canonicalCounts.importedProjectCount === 0 &&
    canonicalCounts.appliedProjectCount === 0 &&
    canonicalCounts.deletedProjectCount === 0 &&
    typeof canonicalCounts.skippedProjectCount === "number" &&
    canonicalCounts.conflictedProjectCount === 0 &&
    canonicalCounts.failedProjectCount === 0;
  if (canonicalSummary && noProjectChanges) {
    return `No project changes. ${canonicalSummary}`;
  }
  if (canonicalSummary) {
    return canonicalSummary;
  }
  if (explicitMessage && (explicitMessageIsCanonical || !syncNowFailureDetailIsSensitive(explicitMessage))) {
    return explicitMessage;
  }
  return explicitMessage
    ? `${statusLabel(status.status)} for ${peerName}: details redacted.`
    : `${statusLabel(status.status)} for ${peerName}.`;
}

function retryableLifecycleEvent(source: SyncRetrySource | null | undefined) {
  if (!source) {
    return null;
  }
  const events = [
    source.last_lifecycle_event,
    ...[...(source.lifecycle_events ?? [])].reverse(),
  ];
  return events.find((event): event is SyncTransportLifecycleEvent => Boolean(event?.retryable)) ?? null;
}

function hasSyncRetryField(source: SyncRetrySource | null | undefined, key: keyof SyncRetrySource) {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function retryableInterruptionFromSource(
  source: SyncRetrySource | null | undefined,
  peersById: Map<string, SyncTrustedPeerSchema>,
  trustedNearbyPeerByDeviceId: Map<string, SyncNearbyPeer>,
): RetryableSyncInterruption | null {
  const lifecycleEvent = retryableLifecycleEvent(source);
  const hasExplicitCode = hasSyncRetryField(source, "retryable_interruption_code");
  const hasExplicitPeer = hasSyncRetryField(source, "retryable_interruption_peer_device_id");
  const hasExplicitGuidance = hasSyncRetryField(source, "retry_guidance");
  const hasExplicitInterruptionState = hasExplicitCode || hasExplicitPeer || hasExplicitGuidance;
  const code = hasExplicitInterruptionState
    ? source?.retryable_interruption_code ?? null
    : lifecycleEvent?.interruption_code ?? null;
  const peerDeviceId = hasExplicitInterruptionState
    ? source?.retryable_interruption_peer_device_id ?? null
    : lifecycleEvent?.peer_device_id ??
      source?.peer_device_id ??
      source?.remote_device_id ??
      null;
  if (!code || !peerDeviceId || !peersById.has(peerDeviceId)) {
    return null;
  }
  const endpointHints = trustedNearbyPeerByDeviceId.get(peerDeviceId)?.endpoint_hints;
  return {
    peerDeviceId,
    endpointHints: endpointHints?.length ? endpointHints : undefined,
    code,
    guidance: hasExplicitInterruptionState
      ? source?.retry_guidance ?? null
      : lifecycleEvent?.retry_guidance ?? null,
  };
}

function retryableInterruptionText(interruption: RetryableSyncInterruption) {
  return syncVisibleNativeDetailText(interruption.guidance, `${statusLabel(interruption.code)}. Retry when peer is reachable.`) ||
    `${statusLabel(interruption.code)}. Retry when peer is reachable.`;
}

const SYNC_SAFE_LIBRARY_PREFLIGHT_ISSUES = new Set([
  "missing source hash project",
  "missing source hash projects",
  "invalid source hash project",
  "invalid source hash projects",
  "duplicate source hash project",
  "duplicate source hash projects",
  "noncanonical project id",
  "noncanonical project ids",
]);

const SYNC_SAFE_TRANSPORT_PHASES = new Set([
  "artifact request/transfer",
  "local manifest export",
  "manifest exchange",
  "reconciliation plan",
  "reconciliation staging",
  "serve artifact requests",
]);

function syncTransportFailurePrefixIsKnownSafe(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  if (normalized === "sync transport failed" || normalized === "sync transport stalled") {
    return true;
  }
  const match = normalized.match(/^sync transport (.+) (failed|stalled)$/);
  return Boolean(match && SYNC_SAFE_TRANSPORT_PHASES.has(match[1] ?? ""));
}

function syncTransportFailurePrefix(message: string) {
  const separatorIndex = message.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }
  const prefix = message.slice(0, separatorIndex).trim();
  return syncTransportFailurePrefixIsKnownSafe(prefix) ? prefix : null;
}

function syncEvidencePatternMatches(pattern: RegExp, value: string) {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

function syncEvidenceHasUnsafeToken(value: string, pattern: RegExp, safeTokens: Set<string>) {
  return (value.match(pattern) ?? []).some((token) => !safeTokens.has(token.toLowerCase()));
}

function syncNowFailureTokenIsSensitive(token: string) {
  const lower = token.toLowerCase();
  return [
    token.includes("/"),
    token.includes("\\"),
    SYNC_NOW_FAILURE_ENDPOINT_TOKEN_PATTERN.test(token),
    lower.startsWith("dev_"),
    syncEvidenceHasUnsafeToken(token, SYNC_EVIDENCE_RAW_ID_TOKEN_PATTERN, SYNC_EVIDENCE_SAFE_RAW_TOKENS),
    syncEvidenceHasUnsafeToken(token, SYNC_EVIDENCE_HASH_TOKEN_PATTERN, SYNC_EVIDENCE_SAFE_HASH_TOKENS),
  ].some(Boolean);
}

function syncNowFailureDetailIsSensitive(message: string) {
  const prefix = syncTransportFailurePrefix(message);
  const detail = prefix ? message.slice(prefix.length + 1).trim() : message;
  const lower = detail.toLowerCase();
  if (
    lower.includes("://") ||
    lower.includes("tuneforge-sync+") ||
    lower.includes("content_sha256") ||
    lower.includes("source_path") ||
    lower.includes("imported_path") ||
    lower.includes("endpoint_hint") ||
    lower.includes("endpoint_hints") ||
    lower.includes("endpointhint") ||
    lower.includes("endpointhints") ||
    lower.includes("project_id") ||
    lower.includes("projectid") ||
    lower.includes("artifact_id") ||
    lower.includes("artifactid") ||
    lower.includes("device_id") ||
    lower.includes("deviceid")
  ) {
    return true;
  }
  if (syncEvidencePatternMatches(SYNC_EVIDENCE_FILENAME_PATTERN, detail)) {
    return true;
  }
  if (
    syncEvidenceHasUnsafeToken(detail, SYNC_EVIDENCE_RAW_ID_TOKEN_PATTERN, SYNC_EVIDENCE_SAFE_RAW_TOKENS) ||
    syncEvidenceHasUnsafeToken(detail, SYNC_EVIDENCE_HASH_TOKEN_PATTERN, SYNC_EVIDENCE_SAFE_HASH_TOKENS)
  ) {
    return true;
  }
  return detail
    .split(/\s+/)
    .map((token) => token.replace(/^["'()[\]{}<>,;]+|["'()[\]{}<>,;.:]+$/g, ""))
    .filter(Boolean)
    .some(syncNowFailureTokenIsSensitive);
}

function syncNowFailureRedactedSummary(message: string) {
  const prefix = syncTransportFailurePrefix(message);
  return prefix ? `${prefix}: details redacted.` : "Sync transport failed: details redacted.";
}

function syncLibraryPreflightDetailIsKnownSafe(detail: string) {
  if (detail === "Library preflight failed.") {
    return true;
  }
  const prefix = "Library preflight failed:";
  if (!detail.startsWith(prefix) || !detail.endsWith(".")) {
    return false;
  }
  const issues = detail.slice(prefix.length, -1).split(",");
  return issues.length > 0 && issues.every((issue) => {
    const match = issue.trim().match(/^\d+ (.+)$/);
    return Boolean(match && SYNC_SAFE_LIBRARY_PREFLIGHT_ISSUES.has(match[1]?.toLowerCase() ?? ""));
  });
}

function syncTransportRedactedDetailIsKnownSafe(detail: string) {
  const prefix = syncTransportFailurePrefix(detail);
  return Boolean(prefix && detail.slice(prefix.length + 1).trim().toLowerCase() === "details redacted.");
}

function syncNativeDetailIsKnownSafe(message: string) {
  const detail = message.trim();
  if (!detail || syncNowFailureDetailIsSensitive(detail)) {
    return false;
  }
  return detail.toLowerCase() === "artifact_transfer: timed out reading from iroh sync stream." ||
    /^sync completed with no project changes\.?$/i.test(detail) ||
    syncLibraryPreflightDetailIsKnownSafe(detail) ||
    syncTransportRedactedDetailIsKnownSafe(detail);
}

function syncNowFailureStatusMessage(message: string) {
  let detail = message.trim();
  if (detail === "Sync now failed.") {
    return "Sync now failed.";
  }
  if (detail.startsWith("Sync now failed:")) {
    detail = detail.slice("Sync now failed:".length).trim();
  }
  if (!detail) {
    return "Sync now failed.";
  }
  const safeDetail = syncNowFailureDetailIsSensitive(detail) ? syncNowFailureRedactedSummary(detail) : detail;
  return `Sync now failed: ${safeDetail}`;
}

function syncVisibleNativeDetailText(message: string | null | undefined, redactedText = "details redacted.") {
  const detail = message?.trim();
  if (!detail) {
    return null;
  }
  if (syncNowFailureDetailIsSensitive(detail)) {
    const redactedFailure = syncNowFailureRedactedSummary(detail);
    return syncTransportFailurePrefix(detail) ? redactedFailure : redactedText;
  }
  return detail;
}

function syncNowFailureText(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return syncNowFailureStatusMessage(message);
    }
  }
  if (typeof error === "string") {
    const message = error.trim();
    if (message) {
      return syncNowFailureStatusMessage(message);
    }
  }
  return "Sync now failed.";
}

function syncListenerLastErrorText(message: string | null | undefined) {
  const detail = message?.trim();
  if (!detail) {
    return null;
  }
  return syncVisibleNativeDetailText(detail, "Sync listener error: details redacted.");
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function syncPreflightLibraryIssueItems(preflight: SyncPreflightResponse) {
  const entries: Array<[number, string]> = [
    [preflight.missing_source_hash_projects, "missing source hash project"],
    [preflight.invalid_source_hash_projects, "invalid source hash project"],
    [preflight.duplicate_source_hash_projects, "duplicate source hash project"],
    [preflight.noncanonical_project_id_projects, "noncanonical project ID"],
  ];
  return entries
    .filter((entry): entry is [number, string] => entry[0] > 0)
    .map(([count, label]) => pluralize(count, label));
}

function syncPreflightLibraryIssueText(preflight: SyncPreflightResponse) {
  const issues = syncPreflightLibraryIssueItems(preflight);
  return issues.length ? issues.join(", ") : null;
}

function syncPreflightJobStatusSummary(preflight: SyncPreflightResponse) {
  const counts = preflight.job_state.blocking_job_counts;
  const entries: Array<[string, number]> = [
    ["running", counts.running ?? preflight.job_state.running_job_count],
    ["pending", counts.pending ?? preflight.job_state.pending_job_count],
    ...Object.entries(counts).filter(([status]) => status !== "running" && status !== "pending"),
  ];
  const ordered = entries.filter((entry): entry is [string, number] => entry[1] > 0);
  return ordered.length
    ? ordered.map(([status, count]) => `${count} ${statusLabel(status).toLowerCase()}`).join(", ")
    : null;
}

function syncPreflightBlockingTypeSummary(jobs: SyncPreflightBlockingJob[], truncated = false) {
  const counts = new Map<string, number>();
  jobs.forEach((job) => {
    counts.set(job.type, (counts.get(job.type) ?? 0) + 1);
  });
  const parts = Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${count} ${type}`);
  if (!parts.length) {
    return null;
  }
  const summary = parts.join(", ");
  return truncated ? `sample: ${summary} (first ${pluralize(jobs.length, "job")} shown)` : summary;
}

function syncPreflightJobSummary(preflight: SyncPreflightResponse) {
  const blockingCount = preflight.job_state.blocking_job_count;
  if (blockingCount === 0) {
    return "No blocking backend jobs.";
  }
  const statusSummary = syncPreflightJobStatusSummary(preflight);
  return `${pluralize(blockingCount, "blocking job")}${statusSummary ? ` (${statusSummary})` : ""}.`;
}

function syncPreflightBlockedText(preflight: SyncPreflightResponse) {
  if (!preflight.library_ok) {
    const issueText = syncPreflightLibraryIssueText(preflight);
    return `Library preflight failed${issueText ? `: ${issueText}` : ""}.`;
  }
  return "Local sync preflight failed.";
}

function syncPreflightUnavailableText(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return `Backend preflight unavailable: ${error.message.trim()}`;
  }
  return "Backend preflight unavailable.";
}

function syncPreflightReadinessLabel(preflight: SyncPreflightResponse | undefined, isError: boolean) {
  if (isError) {
    return "Unavailable";
  }
  if (!preflight) {
    return "Checking";
  }
  if (!preflight.library_ok) {
    return "Library Cleanup Required";
  }
  if (preflight.job_state.blocking_job_count > 0) {
    return "Ready With Jobs";
  }
  if (preflight.ok) {
    return "Ready";
  }
  return "Not Ready";
}

function syncResultKey(status: SyncTransportRunStatus | null | undefined) {
  if (!status) {
    return null;
  }
  const projectResults = mergeSyncProjectResults(status.project_results, status.manifest_errors);
  return JSON.stringify({
    run: status.run_id,
    session: status.session_id,
    peer: status.peer_device_id,
    remote: status.remote_device_id,
    started: status.started_at,
    completed: status.completed_at,
    durationSeconds: status.duration_seconds,
    durationMs: status.duration_ms,
    selectedTransport: status.selected_transport,
    fallbackReason: status.fallback_reason,
    fallbackCode: status.fallback_code,
    attemptedTransports: status.attempted_transports,
    retryableInterruptionCode: status.retryable_interruption_code,
    retryableInterruptionPeerDeviceId: status.retryable_interruption_peer_device_id,
    retryGuidance: status.retry_guidance,
    lastLifecycleEvent: status.last_lifecycle_event,
    lifecycleEvents: status.lifecycle_events ?? [],
    timeToFirstArtifactMs: status.time_to_first_artifact_ms,
    totalReceivedBytes: status.total_received_bytes,
    totalServedBytes: status.total_served_bytes,
    throughputBytesPerSecond: status.throughput_bytes_per_second,
    scratchPeakBytes: status.scratch_peak_bytes,
    stagingPeakBytes: status.staging_peak_bytes,
    maxActiveStreams: status.max_active_streams,
    creditGrants: status.credit_grants,
    creditRevokes: status.credit_revokes,
    transferCounts: status.transfer_counts,
    phaseTimings: status.phase_timings,
    status: status.status,
    message: status.message,
    projects: projectResults.map((result) => [
      result.project_id,
      result.status,
      result.message ?? null,
      result.completed_at ?? null,
      result.is_final ?? null,
      result.counters ?? null,
    ]),
    receivedArtifacts: status.received_artifacts.map((artifact) => [
      artifact.artifact_id,
      artifact.status,
      artifact.size_bytes ?? null,
      artifact.started_at ?? null,
      artifact.completed_at ?? null,
      artifact.duration_ms ?? null,
      artifact.throughput_bytes_per_second ?? null,
    ]),
    remoteManifests: status.remote_manifest_count,
    localManifests: status.local_manifest_count,
    importedProjects: status.imported_project_count,
    appliedProjects: status.applied_project_count,
    deletedProjects: status.deleted_project_count,
    skippedProjects: status.skipped_project_count,
    conflictedProjects: status.conflicted_project_count,
    failedProjects: status.failed_project_count,
    manifestExportErrors: status.manifest_export_error_count,
  });
}

function positiveSyncCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function syncEvidenceStatusIndicatesProblem(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return SYNC_EVIDENCE_PROBLEM_STATUSES.has(normalized ?? "");
}

function syncEvidenceValidation(
  status: SyncTransportRunStatus,
  mergedProjectResults: SyncTransportProjectResult[],
  artifactStatusCounts: Record<string, number>,
) {
  const issues = new Set<string>();
  const finalProjectResults = mergedProjectResults.filter(
    (result) => result.status !== SYNC_MANIFEST_EXPORT_ERROR_STATUS && isFinalSyncProjectResult(result),
  );
  const projectResultCountByStatus = countSyncProjectResultsByStatus(finalProjectResults);
  const hasFinalProjectResults = finalProjectResults.length > 0;
  const failedProjectCount = hasFinalProjectResults
    ? projectResultCountByStatus.failed ?? 0
    : status.failed_project_count;
  const conflictedProjectCount = hasFinalProjectResults
    ? projectResultCountByStatus.conflicted ?? 0
    : status.conflicted_project_count;
  if (syncEvidenceStatusIndicatesProblem(status.status)) {
    issues.add(`run_status_${status.status}`);
  }
  if (positiveSyncCount(failedProjectCount)) {
    issues.add("failed_project_count");
  }
  if (positiveSyncCount(conflictedProjectCount)) {
    issues.add("conflicted_project_count");
  }
  if (status.manifest_errors.length > 0) {
    issues.add("manifest_export_error_count");
  }
  if (positiveSyncCount(status.manifest_export_error_count)) {
    issues.add("manifest_export_error_count");
  }
  for (const result of finalProjectResults) {
    if (syncEvidenceStatusIndicatesProblem(result.status)) {
      issues.add(`project_status_${result.status}`);
    }
    if (positiveSyncCount(result.failed_count)) {
      issues.add("project_failed_count");
    }
    if (positiveSyncCount(result.counters?.failed_count)) {
      issues.add("project_counter_failed_count");
    }
  }
  for (const [artifactStatus, count] of Object.entries(artifactStatusCounts)) {
    if (positiveSyncCount(count) && syncEvidenceStatusIndicatesProblem(artifactStatus)) {
      issues.add(`artifact_status_${artifactStatus}`);
    }
  }
  const receivedCount = syncRunMetricValue(status, "received");
  if (status.received_artifacts_complete === true && receivedCount !== null &&
    (artifactStatusCounts.received ?? 0) !== receivedCount) {
    issues.add("received_artifact_count_mismatch");
  }
  return {
    ok: issues.size === 0,
    issues: Array.from(issues).sort(),
  };
}

function syncProjectResultMutatedLocalCache(result: SyncTransportProjectResult) {
  return SYNC_PROJECT_MUTATION_STATUSES.has(result.status) ||
    positiveSyncCount(result.imported_count) ||
    positiveSyncCount(result.applied_count) ||
    positiveSyncCount(result.deleted_count);
}

function syncResultMutatedLocalProjectCaches(status: SyncTransportRunStatus | null | undefined) {
  if (!status) {
    return false;
  }
  return positiveSyncCount(status.imported_project_count) ||
    positiveSyncCount(status.applied_project_count) ||
    positiveSyncCount(status.deleted_project_count) ||
    mergeSyncProjectResults(status.project_results, status.manifest_errors).some(syncProjectResultMutatedLocalCache);
}

function formatSyncDuration(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 1) {
    return `${Math.max(1, Math.round(seconds * 1000))} ms`;
  }
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function formatDurationMs(milliseconds: number | null | undefined) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  return formatSyncDuration(milliseconds / 1000);
}

function formatByteCount(bytes: number | null | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1000) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1_000_000) {
    const kilobytes = bytes / 1000;
    return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
  }
  const megabytes = bytes / 1_000_000;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

function formatThroughput(bytesPerSecond: number | null | undefined) {
  const formatted = formatByteCount(bytesPerSecond);
  return formatted ? `${formatted}/s` : null;
}

function formatInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return String(Math.round(value));
}

function syncRunDurationSeconds(status: SyncTransportRunStatus) {
  if (typeof status.duration_seconds === "number") {
    return status.duration_seconds;
  }
  if (typeof status.duration_ms === "number") {
    return status.duration_ms / 1000;
  }
  if (status.started_at && status.completed_at) {
    const startedAt = new Date(normalizeApiDateTime(status.started_at)).getTime();
    const completedAt = new Date(normalizeApiDateTime(status.completed_at)).getTime();
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
      return (completedAt - startedAt) / 1000;
    }
  }
  return null;
}

function syncRunProjectCounterText(status: SyncTransportRunStatus) {
  const counts = syncRunCanonicalCounts(status);
  if (!counts) {
    return null;
  }
  const counters: string[] = [];
  if (typeof counts.importedProjectCount === "number") {
    counters.push(`${counts.importedProjectCount} imported`);
  }
  if (typeof counts.appliedProjectCount === "number") {
    counters.push(`${counts.appliedProjectCount} applied`);
  }
  if (typeof counts.deletedProjectCount === "number") {
    counters.push(`${counts.deletedProjectCount} deleted`);
  }
  if (typeof counts.skippedProjectCount === "number") {
    counters.push(`${counts.skippedProjectCount} skipped`);
  }
  if (typeof counts.conflictedProjectCount === "number") {
    counters.push(`${counts.conflictedProjectCount} conflicted`);
  }
  if (typeof counts.failedProjectCount === "number") {
    counters.push(`${counts.failedProjectCount} failed`);
  }
  if (typeof counts.manifestExportErrorCount === "number") {
    counters.push(pluralize(counts.manifestExportErrorCount, "manifest export error"));
  }
  return counters.length ? counters.join(", ") : null;
}

function syncRunPeakText(label: string, bytes: number | null | undefined) {
  const formatted = formatByteCount(bytes);
  return formatted ? `${label} peak ${formatted}` : null;
}

type SyncRunEvidenceKey =
  | "scratch_peak_bytes"
  | "staging_peak_bytes"
  | "max_active_streams"
  | "credit_grants"
  | "credit_revokes";

function syncRunMetricValue(status: SyncTransportRunStatus, key: string) {
  const directValue = status[key as keyof SyncTransportRunStatus];
  if (typeof directValue === "number" && Number.isFinite(directValue)) {
    return directValue;
  }
  const metricValue = status.transfer_counts?.[key];
  if (typeof metricValue === "number" && Number.isFinite(metricValue)) {
    return metricValue;
  }
  return null;
}

function syncRunEvidenceValue(status: SyncTransportRunStatus, directKey: SyncRunEvidenceKey, metricKeys: string[]) {
  const directValue = syncRunMetricValue(status, directKey);
  if (typeof directValue === "number" && Number.isFinite(directValue)) {
    return directValue;
  }
  for (const key of metricKeys) {
    const metricValue = syncRunMetricValue(status, key);
    if (typeof metricValue === "number" && Number.isFinite(metricValue)) {
      return metricValue;
    }
  }
  return null;
}

function syncRunStreamText(status: SyncTransportRunStatus) {
  const streamCount = formatInteger(syncRunEvidenceValue(status, "max_active_streams", [
    "max_active_streams",
    "active_streams_peak",
    "max_streams",
    "max_stream_count",
  ]));
  if (!streamCount) {
    return null;
  }
  return `Max ${streamCount} ${streamCount === "1" ? "stream" : "streams"}`;
}

function syncRunCreditText(status: SyncTransportRunStatus) {
  const grants = formatInteger(syncRunEvidenceValue(status, "credit_grants", [
    "credit_grants",
    "credit_grant_count",
    "credit_grants_count",
    "credits_granted",
  ]));
  const revokes = formatInteger(syncRunEvidenceValue(status, "credit_revokes", [
    "credit_revokes",
    "credit_revoke_count",
    "credit_revokes_count",
    "credit_revocations",
    "credit_revocation_count",
    "credits_revoked",
  ]));
  const parts = [
    grants ? `${grants} grants` : null,
    revokes ? `${revokes} revokes` : null,
  ].filter((item): item is string => item !== null);
  return parts.length ? `Credits ${parts.join(", ")}` : null;
}

const SYNC_RUN_DIAGNOSTIC_GROUPS = [
  {
    label: "credit wait",
    totalKey: "credit_wait_ms_total",
    maxKey: "credit_wait_ms_max",
    eventsKey: "credit_wait_events",
  },
  {
    label: "credit hold",
    totalKey: "credit_hold_ms_total",
    maxKey: "credit_hold_ms_max",
  },
  {
    label: "queue wait",
    totalKey: "stage_queue_wait_ms_total",
    maxKey: "stage_queue_wait_ms_max",
    eventsKey: "stage_queue_wait_events",
  },
  {
    label: "stream open",
    totalKey: "stream_open_ms_total",
    maxKey: "stream_open_ms_max",
    eventsKey: "stream_open_events",
  },
  {
    label: "sender write",
    totalKey: "sender_write_ms_total",
    maxKey: "sender_write_ms_max",
    eventsKey: "sender_write_events",
  },
  {
    label: "receiver read",
    totalKey: "receiver_read_ms_total",
    maxKey: "receiver_read_ms_max",
    eventsKey: "receiver_read_events",
  },
  {
    label: "receiver hash",
    totalKey: "receiver_hash_ms_total",
    maxKey: "receiver_hash_ms_max",
    eventsKey: "receiver_hash_events",
  },
  {
    label: "temp write",
    totalKey: "receiver_temp_write_ms_total",
    maxKey: "receiver_temp_write_ms_max",
    eventsKey: "receiver_temp_write_events",
  },
  {
    label: "staging POST",
    totalKey: "staging_post_ms_total",
    maxKey: "staging_post_ms_max",
    eventsKey: "staging_post_events",
  },
] as const;

type SyncRunDiagnosticBottleneck = {
  label: string;
  totalValue: number;
  maxValue: number;
  eventValue: number;
};

function syncRunDiagnosticsText(status: SyncTransportRunStatus) {
  const bottlenecks = SYNC_RUN_DIAGNOSTIC_GROUPS.map<SyncRunDiagnosticBottleneck | null>((group) => {
    const totalValue = syncRunMetricValue(status, group.totalKey) ?? 0;
    const maxValue = syncRunMetricValue(status, group.maxKey) ?? 0;
    const eventValue = "eventsKey" in group
      ? (syncRunMetricValue(status, group.eventsKey) ?? 0)
      : 0;
    if (totalValue <= 0 && maxValue <= 0 && eventValue <= 0) {
      return null;
    }
    return {
      label: group.label,
      totalValue,
      maxValue,
      eventValue,
    };
  })
    .filter((item): item is SyncRunDiagnosticBottleneck => item !== null)
    .sort((left, right) => (
      right.totalValue - left.totalValue ||
      right.maxValue - left.maxValue ||
      right.eventValue - left.eventValue
    ));

  if (!bottlenecks.length) {
    return null;
  }

  const diagnostics = bottlenecks.map((diagnostic) => {
    const total = formatDurationMs(diagnostic.totalValue) ?? "0 ms";
    const events = formatInteger(diagnostic.eventValue);
    const max = formatDurationMs(diagnostic.maxValue);
    const details = [
      diagnostic.eventValue > 0 && events
        ? `${events} ${diagnostic.eventValue === 1 ? "event" : "events"}`
        : null,
      max ? `max ${max}` : null,
    ].filter((item): item is string => item !== null);
    return details.length
      ? `${diagnostic.label} ${total} (${details.join(", ")})`
      : `${diagnostic.label} ${total}`;
  });
  return `Diagnostics ${diagnostics.join("; ")}`;
}

function syncRunSlowestPhaseText(status: SyncTransportRunStatus) {
  const phaseDurations = new Map<string, { label: string; durationMs: number }>();
  status.phase_timings?.forEach((timing) => {
    if (!timing.phase || typeof timing.duration_ms !== "number" || !Number.isFinite(timing.duration_ms)) {
      return;
    }
    const key = timing.phase.trim().toLowerCase();
    const current = phaseDurations.get(key);
    const safePhase = syncEvidencePhase(timing.phase);
    phaseDurations.set(key, {
      label: safePhase === "phase_redacted" ? "Sync Phase" : statusLabel(safePhase),
      durationMs: (current?.durationMs ?? 0) + timing.duration_ms,
    });
  });
  const slowest = Array.from(phaseDurations.values())
    .sort((left, right) => right.durationMs - left.durationMs)[0];
  const formatted = formatDurationMs(slowest?.durationMs);
  return slowest && formatted ? `Largest aggregate phase ${slowest.label} ${formatted}` : null;
}

function syncRunSummaryText(status: SyncTransportRunStatus | null | undefined) {
  if (!status) {
    return null;
  }
  const parts: string[] = [];
  if (status.run_id) {
    parts.push(`Run ${status.run_id}`);
  } else if (status.session_id) {
    parts.push(`Session ${status.session_id}`);
  }
  const completedAt = formatTimestamp(status.completed_at);
  if (completedAt) {
    parts.push(`Completed ${completedAt}`);
  }
  const duration = formatSyncDuration(syncRunDurationSeconds(status));
  if (duration) {
    parts.push(`Duration ${duration}`);
  }
  const selectedTransport = transportLabel(status.selected_transport);
  if (selectedTransport) {
    parts.push(`Transport ${selectedTransport}`);
  }
  if (status.fallback_reason) {
    parts.push(`Fallback: ${syncVisibleNativeDetailText(status.fallback_reason, "details redacted.")}`);
  }
  if (status.fallback_code) {
    parts.push(`Fallback code ${status.fallback_code}`);
  }
  const counters = syncRunProjectCounterText(status);
  if (counters) {
    parts.push(counters);
  }
  const timeToFirstArtifact = formatDurationMs(status.time_to_first_artifact_ms);
  if (timeToFirstArtifact) {
    parts.push(`TTFA ${timeToFirstArtifact}`);
  }
  const profile = syncRunEvidenceProfile(status);
  if (profile.role === "no_op") {
    parts.push("No transfers");
  } else {
    const received = formatByteCount(profile.totalReceivedBytes);
    const sent = formatByteCount(profile.totalServedBytes);
    const receiveRate = formatThroughput(profile.receiveThroughput);
    const sendRate = formatThroughput(profile.sendThroughput);
    if (profile.receiverActive && received) parts.push(`${received} received`);
    if (profile.senderActive && sent) parts.push(`${sent} sent`);
    if (profile.receiverActive && receiveRate) parts.push(`Receive ${receiveRate}`);
    if (profile.senderActive && sendRate) parts.push(`Send ${sendRate}`);
    if (!receiveRate && !sendRate && profile.aggregateThroughput !== null) {
      const combinedRate = formatThroughput(profile.aggregateThroughput);
      if (combinedRate) parts.push(`Combined ${combinedRate}`);
    }
  }
  const slowestPhase = syncRunSlowestPhaseText(status);
  if (slowestPhase) {
    parts.push(slowestPhase);
  }
  [
    syncRunPeakText("Scratch", syncRunEvidenceValue(status, "scratch_peak_bytes", [
      "scratch_peak_bytes",
      "scratch_bytes_peak",
      "scratch_storage_peak_bytes",
    ])),
    syncRunPeakText("Staging", syncRunEvidenceValue(status, "staging_peak_bytes", [
      "staging_peak_bytes",
      "staging_bytes_peak",
      "staging_storage_peak_bytes",
    ])),
    syncRunStreamText(status),
    syncRunCreditText(status),
    syncRunDiagnosticsText(status),
  ].forEach((item) => {
    if (item) {
      parts.push(item);
    }
  });
  return parts.length ? parts.join(" | ") : null;
}

function projectCounterValue(result: SyncTransportProjectResult, key: keyof SyncTransportProjectResult) {
  const value = result[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function syncProjectCounterText(result: SyncTransportProjectResult) {
  const directCounters: Array<[string, number | null]> = [
    ["imported", projectCounterValue(result, "imported_count")],
    ["applied", projectCounterValue(result, "applied_count")],
    ["deleted", projectCounterValue(result, "deleted_count")],
    ["satisfied", projectCounterValue(result, "satisfied_count")],
    ["skipped", projectCounterValue(result, "skipped_count")],
    ["failed", projectCounterValue(result, "failed_count")],
    ["received", projectCounterValue(result, "received_artifact_count")],
    ["reused", projectCounterValue(result, "reused_artifact_count")],
  ];
  const counters = directCounters.filter((entry): entry is [string, number] => entry[1] !== null);
  if (!counters.length && result.counters) {
    Object.entries(result.counters)
      .filter(([key]) => key.endsWith("_count"))
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, value]) => {
        counters.push([key.replace(/_count$/, "").replace(/_/g, " "), value]);
      });
  }
  return counters.length
    ? `${counters.map(([label, value]) => `${value} ${label}`).join(", ")}.`
    : null;
}

function syncProjectResultText(result: SyncTransportProjectResult) {
  return result.message?.trim() || syncProjectCounterText(result) || `${statusLabel(result.status)}.`;
}

function syncProjectIdLabel(projectId: string) {
  const normalized = projectId.trim();
  if (normalized.length <= 30) {
    return normalized;
  }
  if (normalized.startsWith("proj_sha256_")) {
    return `${normalized.slice(0, 19)}...${normalized.slice(-8)}`;
  }
  return `${normalized.slice(0, 18)}...${normalized.slice(-8)}`;
}

function syncTransferMetricText(artifact: SyncTransportTransferResult) {
  const parts: string[] = [];
  const duration = formatDurationMs(artifact.duration_ms);
  if (duration) {
    parts.push(duration);
  }
  const throughput = formatThroughput(artifact.throughput_bytes_per_second);
  if (throughput) {
    parts.push(throughput);
  }
  return parts.length ? parts.join(" / ") : null;
}

type SyncEvidenceRedactionContext = {
  peerLabels: Map<string, string>;
  projectLabels: Map<string, string>;
  artifactLabels: Map<string, string>;
  tokenReplacements: Array<[string, string]>;
};

function createEvidenceLabelMap(
  values: Array<string | null | undefined>,
  prefix: string,
  separator = "_",
  options: { preserveOrder?: boolean } = {},
) {
  const labels = new Map<string, string>();
  const usableValues = values.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const orderedValues = options.preserveOrder
    ? usableValues
    : [...usableValues].sort((left, right) => left.localeCompare(right));
  orderedValues.forEach((value) => {
    if (!labels.has(value)) {
      labels.set(value, `${prefix}${separator}${labels.size + 1}`);
    }
  });
  return labels;
}

function createSyncEvidenceRedactionContext(
  status: SyncTransportRunStatus,
  extraPeerDeviceIds: Array<string | null | undefined> = [],
  extraRunIds: Array<string | null | undefined> = [],
): SyncEvidenceRedactionContext {
  const mergedProjectResults = mergeSyncProjectResults(status.project_results, status.manifest_errors);
  const peerLabels = createEvidenceLabelMap([
    status.peer_device_id,
    status.remote_device_id,
    status.retryable_interruption_peer_device_id,
    status.last_lifecycle_event?.peer_device_id,
    ...(status.lifecycle_events ?? []).map((event) => event.peer_device_id),
    ...extraPeerDeviceIds,
  ], "peer");
  const projectLabels = createEvidenceLabelMap([
    ...mergedProjectResults.map((result) => result.project_id),
    ...(status.phase_timings ?? []).map((timing) => timing.project_id),
  ], "Project", " ", { preserveOrder: true });
  const artifactLabels = createEvidenceLabelMap([
    ...status.received_artifacts.map((artifact) => artifact.artifact_id),
    ...(status.phase_timings ?? []).map((timing) => timing.artifact_id),
  ], "Artifact", " ", { preserveOrder: true });
  const runLabels = createEvidenceLabelMap([
    status.run_id,
    status.session_id,
    status.last_lifecycle_event?.run_id,
    ...(status.lifecycle_events ?? []).map((event) => event.run_id),
    ...extraRunIds,
  ], "Run", " ");
  const tokenReplacements = [
    ...Array.from(peerLabels.entries()),
    ...Array.from(projectLabels.entries()),
    ...Array.from(artifactLabels.entries()),
    ...Array.from(runLabels.entries()),
  ].sort(([left], [right]) => right.length - left.length);
  return {
    peerLabels,
    projectLabels,
    artifactLabels,
    tokenReplacements,
  };
}

function redactSyncEvidenceText(
  value: string | null | undefined,
  context: SyncEvidenceRedactionContext,
) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  let redacted = normalized;
  context.tokenReplacements.forEach(([rawValue, label]) => {
    redacted = redacted.split(rawValue).join(label);
  });
  redacted = redacted.replace(/\btuneforge-sync\+[a-z0-9_-]+:\/\/[^\s,;]+/gi, "[redacted_endpoint]");
  redacted = redacted.replace(
    SYNC_EVIDENCE_QUOTED_PATH_PATTERN,
    (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted_path]${quote}`,
  );
  redacted = redacted.replace(
    SYNC_EVIDENCE_PATH_WITH_EXTENSION_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted_path]`,
  );
  redacted = redacted.replace(SYNC_EVIDENCE_FILE_URI_PATTERN, "[redacted_path]");
  redacted = redacted.replace(SYNC_EVIDENCE_WINDOWS_PATH_PATTERN, "[redacted_path]");
  redacted = redacted.replace(
    SYNC_EVIDENCE_POSIX_PATH_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted_path]`,
  );
  redacted = redacted.replace(SYNC_EVIDENCE_FILENAME_PATTERN, "[redacted_filename]");
  redacted = redacted.replace(SYNC_EVIDENCE_RAW_ID_TOKEN_PATTERN, (token) =>
    SYNC_EVIDENCE_SAFE_RAW_TOKENS.has(token.toLowerCase()) ? token : "[redacted_id]");
  redacted = redacted.replace(SYNC_EVIDENCE_HASH_TOKEN_PATTERN, (token) =>
    SYNC_EVIDENCE_SAFE_HASH_TOKENS.has(token.toLowerCase()) ? token : "[redacted_hash]");
  return redacted;
}

function redactSyncEvidenceNativeDetailText(
  value: string | null | undefined,
  context: SyncEvidenceRedactionContext,
) {
  const detail = value?.trim();
  if (!detail) {
    return null;
  }
  return syncNativeDetailIsKnownSafe(detail)
    ? redactSyncEvidenceText(detail, context)
    : "details redacted.";
}

function syncEvidenceLifecycleEvent(
  event: SyncTransportLifecycleEvent | null | undefined,
  context: SyncEvidenceRedactionContext,
) {
  if (!event) {
    return null;
  }
  return {
    kind: event.kind,
    occurredAt: event.occurred_at ?? null,
    message: redactSyncEvidenceNativeDetailText(event.message, context),
    retryable: event.retryable,
    interruptionCode: event.interruption_code ?? null,
    retryGuidance: redactSyncEvidenceNativeDetailText(event.retry_guidance, context),
    peer: event.peer_device_id ? context.peerLabels.get(event.peer_device_id) ?? "peer_1" : null,
    hasRunId: Boolean(event.run_id),
  };
}

function syncEvidenceLifecycleEvents(
  events: SyncTransportLifecycleEvent[],
  context: SyncEvidenceRedactionContext,
) {
  return events
    .map((event) => syncEvidenceLifecycleEvent(event, context))
    .filter((event): event is NonNullable<ReturnType<typeof syncEvidenceLifecycleEvent>> => event !== null);
}

function syncEvidenceProjectCadence(status: SyncTransportRunStatus) {
  const appearances = new Map<string, string[]>();
  status.project_results.forEach((result) => {
    const timestamps = [result.started_at, result.completed_at].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (!timestamps.length) {
      return;
    }
    const existing = appearances.get(result.project_id) ?? [];
    appearances.set(result.project_id, existing.concat(timestamps));
  });
  status.phase_timings?.forEach((timing) => {
    if (!timing.project_id) {
      return;
    }
    const timestamps = [timing.started_at, timing.completed_at].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (!timestamps.length) {
      return;
    }
    const existing = appearances.get(timing.project_id) ?? [];
    appearances.set(timing.project_id, existing.concat(timestamps));
  });
  return appearances;
}

function sumSyncPhaseDurations(status: SyncTransportRunStatus, matcher: RegExp) {
  const total = status.phase_timings?.reduce((durationMs, timing) => {
    if (!timing.phase || typeof timing.duration_ms !== "number" || !matcher.test(timing.phase)) {
      return durationMs;
    }
    return durationMs + timing.duration_ms;
  }, 0) ?? 0;
  return total > 0 ? total : null;
}

function syncRunTotalEvidenceBytes(status: SyncTransportRunStatus, receivedCount: number | null) {
  const directReceived = typeof status.total_received_bytes === "number" &&
    Number.isFinite(status.total_received_bytes)
    ? status.total_received_bytes
    : null;
  if (directReceived !== null) {
    return directReceived;
  }
  const received = status.received_artifacts.filter((artifact) => artifact.status === "received");
  const rowsComplete = receivedCount !== null
    ? received.length === receivedCount : status.received_artifacts_complete === true;
  if (!rowsComplete || received.some((artifact) =>
    typeof artifact.size_bytes !== "number" || !Number.isFinite(artifact.size_bytes))) {
    return null;
  }
  return received.reduce((total, artifact) => total + (artifact.size_bytes ?? 0), 0);
}

function throughputFromEvidenceBytes(bytes: number | null, durationMs: number | null) {
  if (bytes === null || durationMs === null || durationMs <= 0) {
    return null;
  }
  return bytes / (durationMs / 1000);
}

type SyncApplyTimingEvidence = {
  wallClockMs: number | null;
  aggregateMs: number | null;
  semantics: string;
};

type SyncApplyTimingEntry = {
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

function syncEvidenceTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const timestamp = new Date(normalizeApiDateTime(value)).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function syncRunWallClockDurationMs(status: SyncTransportRunStatus) {
  const durationSeconds = syncRunDurationSeconds(status);
  return durationSeconds === null ? null : Math.round(durationSeconds * 1000);
}

function isSyncApplyPhaseName(phase: string | null | undefined) {
  const normalized = phase?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
  if (!normalized || /(^|_)(plan|planning|stage|staging)($|_)/.test(normalized)) {
    return false;
  }
  return normalized === "apply" ||
    normalized === "reconciliation_apply" ||
    normalized.startsWith("apply_") ||
    normalized.startsWith("reconciliation_apply_") ||
    normalized.endsWith("_apply");
}

function syncRunApplyTimingEvidence(
  status: SyncTransportRunStatus,
  mergedProjectResults: SyncTransportProjectResult[],
): SyncApplyTimingEvidence {
  const phaseApplyEntries = (status.phase_timings ?? [])
    .filter((timing) => isSyncApplyPhaseName(timing.phase))
    .map<SyncApplyTimingEntry>((timing) => ({
      startedAt: syncEvidenceTimestampMs(timing.started_at),
      completedAt: syncEvidenceTimestampMs(timing.completed_at),
      durationMs: typeof timing.duration_ms === "number" &&
          Number.isFinite(timing.duration_ms) &&
          timing.duration_ms >= 0
        ? timing.duration_ms
        : null,
    }));
  const projectApplyEntries = mergedProjectResults
    .filter((result) => ["applied", "deleted", "imported"].includes(result.status))
    .map<SyncApplyTimingEntry>((result) => ({
      startedAt: syncEvidenceTimestampMs(result.started_at),
      completedAt: syncEvidenceTimestampMs(result.completed_at),
      durationMs: typeof result.duration_ms === "number" &&
          Number.isFinite(result.duration_ms) &&
          result.duration_ms >= 0
        ? result.duration_ms
        : null,
    }));
  const entries = phaseApplyEntries.length ? phaseApplyEntries : projectApplyEntries;
  const aggregateDurations = entries.map((entry) => {
    const intervalDuration = entry.startedAt !== null && entry.completedAt !== null &&
        entry.completedAt >= entry.startedAt
      ? entry.completedAt - entry.startedAt
      : null;
    if (entry.durationMs !== null && intervalDuration !== null &&
        Math.abs(entry.durationMs - intervalDuration) > 1) {
      return null;
    }
    if (entry.durationMs !== null && intervalDuration !== null) {
      return Math.max(entry.durationMs, intervalDuration);
    }
    if (entry.durationMs !== null) {
      return entry.durationMs;
    }
    return intervalDuration;
  });
  const aggregateMs = entries.length > 0 && aggregateDurations.every((duration) => duration !== null)
    ? aggregateDurations.reduce((total, duration) => total + (duration ?? 0), 0)
    : null;
  let runStartedAt = syncEvidenceTimestampMs(status.started_at);
  let runCompletedAt = syncEvidenceTimestampMs(status.completed_at);
  const runDurationMs = syncRunWallClockDurationMs(status);
  if (runDurationMs !== null) {
    if (runStartedAt !== null && runCompletedAt === null) {
      runCompletedAt = runStartedAt + runDurationMs;
    } else if (runStartedAt === null && runCompletedAt !== null) {
      runStartedAt = runCompletedAt - runDurationMs;
    }
  }
  const intervalCandidates = entries
    .map((entry) => {
      if (entry.startedAt === null || entry.completedAt === null || entry.completedAt < entry.startedAt) {
        return null;
      }
      if (entry.durationMs !== null && Math.abs(entry.durationMs - (entry.completedAt - entry.startedAt)) > 1) {
        return null;
      }
      return [entry.startedAt, entry.completedAt] as const;
    });
  if (entries.length > 0 && intervalCandidates.every(
    (interval): interval is readonly [number, number] => interval !== null,
  )) {
    const intervals = intervalCandidates.slice().sort((left, right) => left[0] - right[0]);
    let unionDurationMs = 0;
    let [currentStart, currentEnd] = intervals[0]!;
    intervals.slice(1).forEach(([startedAt, completedAt]) => {
      if (startedAt <= currentEnd) {
        currentEnd = Math.max(currentEnd, completedAt);
        return;
      }
      unionDurationMs += currentEnd - currentStart;
      currentStart = startedAt;
      currentEnd = completedAt;
    });
    unionDurationMs += currentEnd - currentStart;
    const firstStartedAt = intervals[0]![0];
    const lastCompletedAt = intervals.reduce((latest, interval) => Math.max(latest, interval[1]), firstStartedAt);
    const runBoundsDurationMs = runStartedAt !== null && runCompletedAt !== null
      ? runCompletedAt - runStartedAt
      : null;
    const runBoundsConsistent = runBoundsDurationMs === null || (
      runBoundsDurationMs >= 0 &&
      runDurationMs !== null &&
      Math.abs(runBoundsDurationMs - runDurationMs) <= 1
    );
    const intervalsWithinRunBounds = intervals.every(([startedAt, completedAt]) =>
      (runStartedAt === null || startedAt >= runStartedAt) &&
      (runCompletedAt === null || completedAt <= runCompletedAt)
    );
    const unionWithinRunDuration = runDurationMs !== null &&
      unionDurationMs <= runDurationMs &&
      lastCompletedAt - firstStartedAt <= runDurationMs;
    if (runBoundsConsistent && intervalsWithinRunBounds && unionWithinRunDuration) {
      return {
        wallClockMs: unionDurationMs,
        aggregateMs,
        semantics: "wall_clock_interval_union_bounded_to_run",
      };
    }
  }

  if (aggregateMs !== null) {
    return {
      wallClockMs: null,
      aggregateMs,
      semantics: "aggregate_only",
    };
  }
  return {
    wallClockMs: null,
    aggregateMs: null,
    semantics: "not_reported",
  };
}

function syncRunTransferCountsEvidence(
  status: SyncTransportRunStatus,
  artifactStatusCounts: Record<string, number>,
) {
  const artifactsComplete = status.received_artifacts_complete ?? status.received_artifacts.length > 0;
  const inferredCount = (statusKey: string) => artifactsComplete ? artifactStatusCounts[statusKey] ?? 0 : null;
  return {
    requested: syncRunMetricValue(status, "requested") ?? (artifactsComplete ? status.received_artifacts.length : null),
    received: syncRunMetricValue(status, "received") ?? inferredCount("received"),
    skipped: syncRunMetricValue(status, "skipped") ?? syncRunMetricValue(status, "already_local") ??
      inferredCount("skipped"),
    already_staged: syncRunMetricValue(status, "already_staged") ?? inferredCount("already_staged"),
    failed: syncRunMetricValue(status, "failed") ?? inferredCount("failed"),
    retried: syncRunMetricValue(status, "retried") ?? syncRunMetricValue(status, "retries") ??
      (artifactsComplete ? 0 : null),
  };
}

function syncRunEvidenceProfile(status: SyncTransportRunStatus) {
  const artifactStatusCounts = status.received_artifacts.reduce<Record<string, number>>((counts, artifact) => {
    counts[artifact.status] = (counts[artifact.status] ?? 0) + 1;
    return counts;
  }, {});
  const transferCounts = syncRunTransferCountsEvidence(status, artifactStatusCounts);
  const canonicalCounts = syncRunCanonicalCounts(status);
  const mutationCounts = [canonicalCounts?.importedProjectCount, canonicalCounts?.appliedProjectCount,
    canonicalCounts?.deletedProjectCount];
  const mutationCount = mutationCounts.every((count): count is number => typeof count === "number")
    ? mutationCounts.reduce((total, count) => total + count, 0) : null;
  const totalReceivedBytes = syncRunTotalEvidenceBytes(status, syncRunMetricValue(status, "received")) ??
    (transferCounts.received === 0 ? 0 : null);
  const totalServedBytes = typeof status.total_served_bytes === "number" && Number.isFinite(status.total_served_bytes)
    ? status.total_served_bytes : status.served_artifact_requests === 0 ? 0 : null;
  const receiverCounts = Object.values(transferCounts);
  const receiverActive = receiverCounts.some(positiveSyncCount) || positiveSyncCount(mutationCount) ||
    positiveSyncCount(totalReceivedBytes);
  const senderActive = positiveSyncCount(status.served_artifact_requests) || positiveSyncCount(totalServedBytes);
  const noOp = receiverCounts.every((count) => count === 0) && mutationCount === 0 &&
    totalReceivedBytes === 0 && status.served_artifact_requests === 0 && totalServedBytes === 0;
  const role = receiverActive && senderActive ? "bidirectional" : receiverActive
    ? "receiver_or_import" : senderActive ? "sender_only" : noOp ? "no_op" : "unknown";
  const durationMs = status.duration_ms ?? (typeof status.duration_seconds === "number" ? status.duration_seconds * 1000 : null);
  return {
    role, receiverActive, senderActive, transferCounts, totalReceivedBytes, totalServedBytes,
    receiveThroughput: receiverActive ? throughputFromEvidenceBytes(totalReceivedBytes, durationMs) : null,
    sendThroughput: senderActive ? throughputFromEvidenceBytes(totalServedBytes, durationMs) : null,
    aggregateThroughput: status.throughput_bytes_per_second ?? null,
  };
}

function syncProjectAvailabilityGapMs(projectAppearances: Map<string, string[]>) {
  const firstSeen = Array.from(projectAppearances.values())
    .map((timestamps) => timestamps
      .map((timestamp) => new Date(normalizeApiDateTime(timestamp)).getTime())
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right)[0] ?? null)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (firstSeen.length <= 1) {
    return firstSeen.length === 1 ? 0 : null;
  }
  return Math.round(
    firstSeen.slice(1).reduce((total, timestamp, index) => total + (timestamp - firstSeen[index]!), 0) /
      (firstSeen.length - 1),
  );
}

function buildSyncEvidenceExport(
  status: SyncTransportRunStatus,
  options: {
    capturedAt: string;
    listenerActive: boolean;
    listenerStatus: string;
    listenerUpdatedAt: string | null | undefined;
    listenerActivePhase: string | null | undefined;
    listenerActiveMessage: string | null | undefined;
    listenerActiveProgressAt: string | null | undefined;
    listenerActiveElapsedMs: number | null | undefined;
    listenerLastStatus: string | null | undefined;
    listenerLastError: string | null | undefined;
    listenerLifecycleEvents: SyncTransportLifecycleEvent[];
    listenerLastLifecycleEvent: SyncTransportLifecycleEvent | null | undefined;
    listenerRetryableInterruptionCode: string | null | undefined;
    listenerRetryGuidance: string | null | undefined;
    showListenerSyncResult: boolean;
  },
) {
  const redactionContext = createSyncEvidenceRedactionContext(status, [
    options.listenerLastLifecycleEvent?.peer_device_id,
    ...options.listenerLifecycleEvents.map((event) => event.peer_device_id),
  ], [
    options.listenerLastLifecycleEvent?.run_id,
    ...options.listenerLifecycleEvents.map((event) => event.run_id),
  ]);
  const projectAppearances = syncEvidenceProjectCadence(status);
  const mergedProjectResults = mergeSyncProjectResults(status.project_results, status.manifest_errors);
  const finalProjectResults = mergedProjectResults.filter(
    (result) => result.status !== SYNC_MANIFEST_EXPORT_ERROR_STATUS && isFinalSyncProjectResult(result),
  );
  const artifactStatusCounts = status.received_artifacts.reduce<Record<string, number>>((counts, artifact) => {
    counts[artifact.status] = (counts[artifact.status] ?? 0) + 1;
    return counts;
  }, {});
  const projectRetryCount = status.project_results.reduce<Record<string, number>>((counts, result) => {
    counts[result.project_id] = (counts[result.project_id] ?? 0) + 1;
    return counts;
  }, {});
  const projectResultCountByStatus = countSyncProjectResultsByStatus(finalProjectResults);
  const canonicalCounts = syncRunCanonicalCounts(status);
  const evidenceProjectResultsByStatus = canonicalCounts
    ? canonicalCounts.projectResultsByStatus
    : projectResultCountByStatus;
  const evidenceImportedProjectCount = canonicalCounts?.importedProjectCount ?? null;
  const evidenceAppliedProjectCount = canonicalCounts?.appliedProjectCount ?? null;
  const evidenceDeletedProjectCount = canonicalCounts?.deletedProjectCount ?? null;
  const evidenceSkippedProjectCount = canonicalCounts?.skippedProjectCount ?? null;
  const evidenceConflictedProjectCount = canonicalCounts?.conflictedProjectCount ?? null;
  const evidenceFailedProjectCount = canonicalCounts?.failedProjectCount ?? null;
  const evidenceManifestExportErrorCount = canonicalCounts?.manifestExportErrorCount ?? null;
  const evidenceTotalProjectCount = canonicalCounts?.totalProjectCount ?? null;
  const profile = syncRunEvidenceProfile(status);
  const evidenceTransferCounts = profile.transferCounts;
  const redactedStatusMessage = redactSyncEvidenceText(status.message, redactionContext);
  const retryIndicators = {
    duplicateProjectEvents: Object.values(projectRetryCount).some((count) => count > 1),
    messageMentionsRetry: Boolean(redactedStatusMessage?.match(/\bretry|retried\b/i)),
  };
  const reusedArtifacts = positiveSyncCount(evidenceTransferCounts.already_staged);
  const reusedProjectArtifacts = mergedProjectResults.some((result) => positiveSyncCount(result.reused_artifact_count));
  const reuseIndicators = {
    reusedArtifacts,
    reusedProjectArtifacts,
    messageMentionsReuse: (reusedArtifacts || reusedProjectArtifacts) &&
      Boolean(redactedStatusMessage?.match(/\breused?|reuse\b/i)),
  };
  const stagingDurationMs = sumSyncPhaseDurations(status, /staging|stage/i) ??
    syncRunMetricValue(status, "staging_post_ms_total");
  const applyTimingEvidence = syncRunApplyTimingEvidence(status, mergedProjectResults);
  const durationMs = status.duration_ms ?? (
    typeof status.duration_seconds === "number" ? Math.round(status.duration_seconds * 1000) : null
  );
  const mutationCounts = [
    evidenceImportedProjectCount,
    evidenceAppliedProjectCount,
    evidenceDeletedProjectCount,
  ];
  const mutatedProjectCount = mutationCounts.every((count): count is number => count !== null)
    ? mutationCounts.reduce((total, count) => total + count, 0)
    : null;
  const projectImportsPerMinute = durationMs && durationMs > 0 && evidenceImportedProjectCount !== null
    ? evidenceImportedProjectCount / (durationMs / 60000)
    : null;
  const projectMutationsPerMinute = durationMs && durationMs > 0 && mutatedProjectCount !== null
    ? mutatedProjectCount / (durationMs / 60000)
    : null;
  const evidenceLifecycleEvents = [
    ...options.listenerLifecycleEvents,
    ...(status.lifecycle_events ?? []),
  ];
  const lastLifecycleEvent = status.last_lifecycle_event ?? options.listenerLastLifecycleEvent ?? null;
  const retryableInterruptionCode =
    status.retryable_interruption_code ?? options.listenerRetryableInterruptionCode ?? null;
  const retryGuidance = status.retry_guidance ?? options.listenerRetryGuidance ?? null;
  const validation = syncEvidenceValidation(status, mergedProjectResults, artifactStatusCounts);

  return {
    capturedAt: options.capturedAt,
    scenario: options.showListenerSyncResult ? "listener-last-sync" : "sync-now-result",
    source: {
      kind: options.showListenerSyncResult ? "listener.last_sync" : "sync_now",
      listenerActive: options.listenerActive,
      listenerStatus: options.listenerStatus,
      listenerUpdatedAt: options.listenerUpdatedAt ?? null,
    },
    run: {
      label: "Run 1",
      status: status.status,
      message: redactSyncEvidenceNativeDetailText(status.message, redactionContext),
      error: redactSyncEvidenceNativeDetailText(status.error, redactionContext),
      startedAt: status.started_at ?? null,
      completedAt: status.completed_at ?? null,
      durationMs: status.duration_ms ?? null,
      durationSeconds: status.duration_seconds ?? syncRunDurationSeconds(status),
      direction: status.direction ?? null,
      peer: status.peer_device_id ? redactionContext.peerLabels.get(status.peer_device_id) ?? "peer_1" : null,
      remotePeer: status.remote_device_id
        ? redactionContext.peerLabels.get(status.remote_device_id) ?? "peer_1"
        : null,
      hasRunId: Boolean(status.run_id),
      hasSessionId: Boolean(status.session_id),
    },
    transport: {
      selected_transport: status.selected_transport ?? null,
      selected: status.selected_transport ?? null,
      selectedLabel: transportLabel(status.selected_transport),
      candidate_transports: status.attempted_transports ?? [],
      attempted: status.attempted_transports ?? [],
      attemptedLabels: (status.attempted_transports ?? []).map((transport) => transportLabel(transport) ?? transport),
      fallback_code: status.fallback_code ?? null,
      fallback_reason: redactSyncEvidenceNativeDetailText(status.fallback_reason, redactionContext),
      fallback: {
        code: status.fallback_code ?? null,
        reason: redactSyncEvidenceNativeDetailText(status.fallback_reason, redactionContext),
      },
    },
    metrics: {
      network_receive_throughput_bytes_per_second: profile.receiveThroughput,
      network_send_throughput_bytes_per_second: profile.sendThroughput,
      backend_staging_throughput_bytes_per_second: throughputFromEvidenceBytes(
        profile.totalReceivedBytes,
        stagingDurationMs,
      ),
      reconciliation_apply_ms: applyTimingEvidence.wallClockMs,
      reconciliation_apply_aggregate_ms: applyTimingEvidence.aggregateMs,
      reconciliation_apply_timing: {
        wallClockField: "reconciliation_apply_ms",
        aggregateField: "reconciliation_apply_aggregate_ms",
        semantics: applyTimingEvidence.semantics,
      },
      project_imports_per_minute: projectImportsPerMinute,
      project_mutations_per_minute: projectMutationsPerMinute,
      project_availability_gap_ms: syncProjectAvailabilityGapMs(projectAppearances),
      total_received_bytes: profile.totalReceivedBytes,
      total_served_bytes: profile.totalServedBytes,
      received_artifacts_complete: status.received_artifacts_complete ?? null,
      ttfa_ms: status.time_to_first_artifact_ms ?? null,
      transfer_counts: evidenceTransferCounts,
      timeToFirstArtifactMs: status.time_to_first_artifact_ms ?? null,
      throughputBytesPerSecond: status.throughput_bytes_per_second ?? null,
      transferCounts: {
        statuses: artifactStatusCounts,
        counts: evidenceTransferCounts,
        servedArtifactRequests: status.served_artifact_requests ?? null,
        localManifestCount: status.local_manifest_count ?? null,
        remoteManifestCount: status.remote_manifest_count ?? null,
        importedProjectCount: evidenceImportedProjectCount,
        appliedProjectCount: evidenceAppliedProjectCount,
        deletedProjectCount: evidenceDeletedProjectCount,
        skippedProjectCount: evidenceSkippedProjectCount,
        conflictedProjectCount: evidenceConflictedProjectCount,
        failedProjectCount: evidenceFailedProjectCount,
        totalProjectCount: evidenceTotalProjectCount,
        manifestExportErrorCount: evidenceManifestExportErrorCount,
      },
      projectResultsByStatus: evidenceProjectResultsByStatus,
      retryIndicators,
      reuseIndicators,
      maxActiveStreams: syncRunEvidenceValue(status, "max_active_streams", [
        "max_active_streams",
        "active_streams_peak",
        "max_streams",
        "max_stream_count",
      ]),
      creditGrants: syncRunEvidenceValue(status, "credit_grants", [
        "credit_grants",
        "credit_grant_count",
        "credit_grants_count",
        "credits_granted",
      ]),
      creditRevokes: syncRunEvidenceValue(status, "credit_revokes", [
        "credit_revokes",
        "credit_revoke_count",
        "credit_revokes_count",
        "credit_revocation_count",
        "credits_revoked",
      ]),
      diagnostics: status.transfer_counts ?? null,
    },
    projects: mergedProjectResults.map((result) => {
      const projectTimestamps = (projectAppearances.get(result.project_id) ?? [])
        .map((timestamp) => new Date(normalizeApiDateTime(timestamp)).getTime())
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
      const cadenceMs = projectTimestamps.length > 1
        ? Math.round(
          projectTimestamps.slice(1).reduce((total, timestamp, index) => (
            total + (timestamp - projectTimestamps[index]!)
          ), 0) / (projectTimestamps.length - 1),
        )
        : null;
      return {
        label: redactionContext.projectLabels.get(result.project_id) ?? "Project 1",
        status: result.status,
        phase: syncEvidencePhase(result.phase),
        action: result.action ?? null,
        message: redactSyncEvidenceNativeDetailText(result.message, redactionContext),
        isFinal: result.is_final ?? null,
        startedAt: result.started_at ?? null,
        completedAt: result.completed_at ?? null,
        durationMs: result.duration_ms ?? null,
        durationSeconds: result.duration_seconds ?? null,
        counts: {
          imported: result.imported_count ?? null,
          applied: result.applied_count ?? null,
          deleted: result.deleted_count ?? null,
          satisfied: result.satisfied_count ?? null,
          skipped: result.skipped_count ?? null,
          failed: result.failed_count ?? null,
          receivedArtifacts: result.received_artifact_count ?? null,
          reusedArtifacts: result.reused_artifact_count ?? null,
        },
        appearance: {
          eventCount: projectTimestamps.length,
          firstSeenAt: projectTimestamps.length ? new Date(projectTimestamps[0]!).toISOString() : null,
          lastSeenAt: projectTimestamps.length
            ? new Date(projectTimestamps[projectTimestamps.length - 1]!).toISOString()
            : null,
          cadenceMs,
        },
      };
    }),
    artifacts: status.received_artifacts.map((artifact) => ({
      label: redactionContext.artifactLabels.get(artifact.artifact_id) ?? "Artifact 1",
      status: artifact.status,
      message: statusLabel(artifact.status),
      sizeBytes: artifact.size_bytes ?? null,
      startedAt: artifact.started_at ?? null,
      completedAt: artifact.completed_at ?? null,
      durationMs: artifact.duration_ms ?? null,
      throughputBytesPerSecond: artifact.throughput_bytes_per_second ?? null,
      reused: artifact.status === "already_staged",
    })),
    lifecycle: {
      events: syncEvidenceLifecycleEvents(evidenceLifecycleEvents, redactionContext),
      lastLifecycleEvent: syncEvidenceLifecycleEvent(lastLifecycleEvent, redactionContext),
      retryableInterruptionCode,
      retryGuidance: redactSyncEvidenceNativeDetailText(retryGuidance, redactionContext),
      listener: {
        active: options.listenerActive,
        status: options.listenerStatus,
        activePhase: syncEvidencePhase(options.listenerActivePhase),
        activeMessage: redactSyncEvidenceNativeDetailText(options.listenerActiveMessage, redactionContext),
        activeProgressAt: options.listenerActiveProgressAt ?? null,
        activeElapsedMs: options.listenerActiveElapsedMs ?? null,
        lastStatus: redactSyncEvidenceNativeDetailText(options.listenerLastStatus, redactionContext),
        hasLastError: Boolean(options.listenerLastError),
        updatedAt: options.listenerUpdatedAt ?? null,
        lastLifecycleEvent: syncEvidenceLifecycleEvent(options.listenerLastLifecycleEvent, redactionContext),
        retryableInterruptionCode: options.listenerRetryableInterruptionCode ?? null,
        retryGuidance: redactSyncEvidenceNativeDetailText(options.listenerRetryGuidance, redactionContext),
      },
      run: {
        lastLifecycleEvent: syncEvidenceLifecycleEvent(status.last_lifecycle_event, redactionContext),
        retryableInterruptionCode: status.retryable_interruption_code ?? null,
        retryGuidance: redactSyncEvidenceNativeDetailText(status.retry_guidance, redactionContext),
      },
      phaseTimings: (status.phase_timings ?? []).map((timing, index) => ({
        label: `phase_${index + 1}`,
        phase: syncEvidencePhase(timing.phase),
        project: timing.project_id ? redactionContext.projectLabels.get(timing.project_id) ?? "Project 1" : null,
        artifact: timing.artifact_id
          ? redactionContext.artifactLabels.get(timing.artifact_id) ?? "Artifact 1"
          : null,
        startedAt: timing.started_at ?? null,
        completedAt: timing.completed_at ?? null,
        durationMs: timing.duration_ms ?? null,
        throughputBytesPerSecond: timing.throughput_bytes_per_second ?? null,
      })),
    },
    storage: {
      scratch_peak_bytes: syncRunEvidenceValue(status, "scratch_peak_bytes", [
        "scratch_peak_bytes",
        "scratch_bytes_peak",
        "scratch_storage_peak_bytes",
      ]),
      staging_peak_bytes: syncRunEvidenceValue(status, "staging_peak_bytes", [
        "staging_peak_bytes",
        "staging_bytes_peak",
        "staging_storage_peak_bytes",
      ]),
      scratchPeakBytes: syncRunEvidenceValue(status, "scratch_peak_bytes", [
        "scratch_peak_bytes",
        "scratch_bytes_peak",
        "scratch_storage_peak_bytes",
      ]),
      stagingPeakBytes: syncRunEvidenceValue(status, "staging_peak_bytes", [
        "staging_peak_bytes",
        "staging_bytes_peak",
        "staging_storage_peak_bytes",
      ]),
    },
    validation: {
      schema: "tuneforge-sync-evidence-v1",
      scope: "run_outcome",
      ok: validation.ok,
      outcomeOk: validation.ok,
      issues: validation.issues,
      ui_visible: true,
      privacySafe: true,
      redactionCounts: {
        peers: redactionContext.peerLabels.size,
        projects: redactionContext.projectLabels.size,
        artifacts: redactionContext.artifactLabels.size,
      },
      omittedSensitiveCategories: [
        "network_locators",
        "user_labels",
        "pairing_material",
        "raw_identifiers",
        "paths_and_filenames",
        "file_or_audio_contents",
      ],
    },
  };
}

function syncProjectResultList(status: SyncTransportRunStatus | null | undefined) {
  const results = status ? mergeSyncProjectResults(status.project_results, status.manifest_errors) : [];
  if (!results.length) {
    return null;
  }
  return (
    <ul className="activity-sync-project-results" aria-label="Last sync project evidence">
      {results.map((result, index) => (
        <li
          className={`activity-sync-project-result activity-sync-project-result--${statusClassName(result.status)}`}
          key={`${result.project_id}-${result.status}-${index}`}
        >
          <span className="activity-sync-project-result__status">
            {statusLabel(result.status)}{isFinalSyncProjectResult(result) ? "" : " (event)"}
          </span>
          <span className="activity-sync-project-result__project" title={result.project_id}>
            {syncProjectIdLabel(result.project_id)}
          </span>
          <span className="activity-sync-project-result__message">{syncProjectResultText(result)}</span>
        </li>
      ))}
    </ul>
  );
}

function syncTransferResultList(status: SyncTransportRunStatus | null | undefined) {
  const results = status?.received_artifacts
    .map((artifact) => [artifact, syncTransferMetricText(artifact)] as const)
    .filter((entry): entry is readonly [SyncTransportTransferResult, string] => entry[1] !== null) ?? [];
  if (!results.length) {
    return null;
  }
  return (
    <ul className="activity-sync-transfer-results" aria-label="Last sync artifact transfers">
      {results.map(([artifact, metrics], index) => (
        <li className="activity-sync-transfer-result" key={`${artifact.artifact_id}-${index}`}>
          <span className="activity-sync-transfer-result__artifact" title={artifact.artifact_id}>
            {syncProjectIdLabel(artifact.artifact_id)}
          </span>
          <span className="activity-sync-transfer-result__metrics">{metrics}</span>
        </li>
      ))}
    </ul>
  );
}

function endpointList(endpointHints: string[]) {
  if (!endpointHints.length) {
    return <span>No listener endpoints announced.</span>;
  }
  return (
    <ul className="activity-sync-endpoints" aria-label="Listener endpoint hints">
      {endpointHints.map((hint) => (
        <li key={hint}>{hint}</li>
      ))}
    </ul>
  );
}

export function ActivitySyncPanel() {
  const queryClient = useQueryClient();
  const [pairingCodeDraft, setPairingCodeDraft] = useState("");
  const [rawPairingPayloadDraft, setRawPairingPayloadDraft] = useState("");
  const [pairingOutput, setPairingOutput] = useState<PairingOutput | null>(null);
  const [adoptSyncGroup, setAdoptSyncGroup] = useState(false);
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<SyncTransportRunStatus | null>(null);
  const [hiddenListenerSyncKey, setHiddenListenerSyncKey] = useState<string | null>(null);
  const [syncNowPolling, setSyncNowPolling] = useState(false);
  const [evidenceMessage, setEvidenceMessage] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
	useSyncExternalStore(
	  subscribePowerInhibition,
	  getPowerInhibitionVersion,
	  getPowerInhibitionVersion,
	);
	const powerInhibitionStatus = readPowerInhibitionStatus();
	  const pairingCodeOutputRef = useRef<HTMLTextAreaElement | null>(null);
	  const rawPairingOutputRef = useRef<HTMLTextAreaElement | null>(null);
	  const refreshedProjectSyncKeyRef = useRef<string | null>(null);
	  const desktopLifecycleLastObservedAtRef = useRef(Date.now());
	  const desktopLifecyclePassiveAwayRef = useRef(false);

  const identityQuery = useQuery({
    queryKey: ["sync", "identity"],
    queryFn: async () => (await api.getSyncIdentity()).identity,
  });
  const listenerQuery = useQuery({
    queryKey: ["sync", "listener"],
    queryFn: () => api.getSyncTransportStatus(),
    refetchInterval: (query) => {
      const status = query.state.data;
      return syncNowPolling || status?.active ? SYNC_LISTENER_POLL_INTERVAL_MS : false;
    },
  });
  const preflightQuery = useQuery({
    queryKey: ["sync", "preflight"],
    queryFn: () => api.getSyncPreflight(),
  });
  const peersQuery = useQuery({
    queryKey: ["sync", "trusted-peers"],
    queryFn: async () => (await api.listSyncTrustedPeers()).trusted_peers,
  });
  const mobileCapabilitiesQuery = useQuery({
    queryKey: ["runtime", "mobile-capabilities"],
    queryFn: () => api.getMobileCapabilities(),
  });

  const peersById = useMemo(
    () => new Map((peersQuery.data ?? []).map((peer) => [peer.device_id, peer])),
    [peersQuery.data],
  );
  const endpointHints = listenerQuery.data?.endpoint_hints ?? [];
  const nearbyPeers = listenerQuery.data?.nearby_peers ?? EMPTY_NEARBY_PEERS;
  const trustedNearbyPeerByDeviceId = useMemo(() => {
    const trustedNearbyPeers = new Map<string, SyncNearbyPeer>();
    nearbyPeers.forEach((peer) => {
      const trustedDeviceId = nearbyTrustedDeviceId(peer);
      const trustedPeer = trustedDeviceId ? peersById.get(trustedDeviceId) ?? null : null;
      if (trustedDeviceId && nearbyTrustStatus(peer, trustedPeer) === "match") {
        trustedNearbyPeers.set(trustedDeviceId, peer);
      }
    });
    return trustedNearbyPeers;
  }, [nearbyPeers, peersById]);
  const listenerActive = listenerQuery.data?.active ?? false;
	useEffect(() => {
	  if (!isTauri()) {
	    return;
	  }
	  void refreshPowerInhibitionStatus();
	  if (!listenerActive && !syncNowPolling) {
	    return;
	  }
	  const intervalId = window.setInterval(() => {
	    void refreshPowerInhibitionStatus();
	  }, SYNC_LISTENER_POLL_INTERVAL_MS);
	  return () => window.clearInterval(intervalId);
	}, [listenerActive, syncNowPolling]);
  const listenerStatus = listenerQuery.isError ? "unavailable" : listenerQuery.data?.status ?? "checking";
  const listenerSyncResult = listenerQuery.data?.last_sync ?? null;
  const listenerSyncKey = useMemo(() => syncResultKey(listenerSyncResult), [listenerSyncResult]);
  const showListenerSyncResult = listenerSyncResult !== null && listenerSyncKey !== hiddenListenerSyncKey;
  const listenerLastStatus = syncVisibleNativeDetailText(
    listenerQuery.data?.last_status,
    "Sync listener status: details redacted.",
  );
  const lastSyncStatus = listenerSyncResult
    ? syncStatusText(listenerSyncResult, peersById)
    : listenerLastStatus ?? syncStatusText(listenerSyncResult, peersById);
  const visibleSyncResult = showListenerSyncResult ? listenerSyncResult : lastSyncResult;
  const displayedLastSyncMessage = !showListenerSyncResult
    ? lastSyncMessage ?? lastSyncStatus
    : lastSyncStatus;
  const visibleSyncSummary = syncRunSummaryText(visibleSyncResult);
  const retryableInterruption = useMemo(() => {
    const sources: Array<SyncRetrySource | null | undefined> = [
      listenerQuery.data,
      visibleSyncResult,
    ];
    for (const source of sources) {
      const interruption = retryableInterruptionFromSource(
        source,
        peersById,
        trustedNearbyPeerByDeviceId,
      );
      if (interruption) {
        return interruption;
      }
    }
    return null;
  }, [listenerQuery.data, visibleSyncResult, peersById, trustedNearbyPeerByDeviceId]);
  const listenerLastErrorMessage = syncListenerLastErrorText(listenerQuery.data?.last_error);
  const pairingInputValue = pairingCodeDraft.trim() || rawPairingPayloadDraft.trim();
  const decodedPairingInput = useMemo(() => {
    if (!pairingInputValue) {
      return { error: null, payload: null };
    }
    try {
      return { error: null, payload: parsePairingInput(pairingInputValue) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Pairing payload is invalid.",
        payload: null,
      };
    }
  }, [pairingInputValue]);
	  const qrScanSupported = mobileCapabilitiesQuery.data?.platform === "android";
	  const isAndroidRuntime = mobileCapabilitiesQuery.data?.platform === "android";

  const refreshSyncQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sync", "listener"] }),
      queryClient.invalidateQueries({ queryKey: ["sync", "preflight"] }),
      queryClient.invalidateQueries({ queryKey: ["sync", "trusted-peers"] }),
    ]);
  }, [queryClient]);

	  const recordLifecycleEvent = useCallback(
	    async (kind: string, options: SyncLifecycleRecordOptions = {}) => {
	      const occurredAt = new Date().toISOString();
	      let status: SyncTransportStatus | null = null;
	      try {
	        status = await api.recordSyncLifecycleEvent({
	          kind,
	          occurredAt,
	          message: options.message,
	        });
	      } catch {
	        // Lifecycle recording is best-effort; still refresh listener state when requested.
	      }
      if (status && options.updateListenerStatus) {
        queryClient.setQueryData(["sync", "listener"], status);
      }
      if (options.refreshListener) {
        await queryClient.invalidateQueries({ queryKey: ["sync", "listener"] });
      }
    },
    [queryClient],
  );

  const refreshProjectMutationQueries = useCallback(async () => {
    await Promise.all(
      PROJECT_MUTATION_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }, [queryClient]);

	  useEffect(() => {
	    const markDesktopLifecycleObserved = () => {
	      desktopLifecycleLastObservedAtRef.current = Date.now();
	    };
	    const recordDesktopSuspensionIfNeeded = (wakeMessage: string) => {
	      const now = Date.now();
	      const elapsedMs = now - desktopLifecycleLastObservedAtRef.current;
	      desktopLifecycleLastObservedAtRef.current = now;
	      if (
	        isAndroidRuntime ||
	        desktopLifecyclePassiveAwayRef.current ||
	        document.visibilityState !== "visible" ||
	        elapsedMs < DESKTOP_SLEEP_ELAPSED_THRESHOLD_MS
	      ) {
	        return;
	      }
	      void (async () => {
	        await recordLifecycleEvent("sleep", {
	          message: `desktop suspended for ${Math.round(elapsedMs / 1000)} seconds`,
	          updateListenerStatus: true,
	        });
	        await recordLifecycleEvent("wake", {
	          message: wakeMessage,
	          refreshListener: true,
	          updateListenerStatus: true,
	        });
	      })();
	    };
	    const recordPassiveBackground = (message: string) => {
	      desktopLifecyclePassiveAwayRef.current = true;
	      markDesktopLifecycleObserved();
	      void recordLifecycleEvent("background", { message });
	    };
	    const recordAndroidBackground = (message: string) => {
	      void recordLifecycleEvent("android_background", {
	        message,
	        updateListenerStatus: true,
	      });
	    };
	    const recordAndroidScreenLock = (message: string) => {
	      void recordLifecycleEvent("android_screen_lock", {
	        message,
	        updateListenerStatus: true,
	      });
	    };
	    const recordForeground = (message: string) => {
	      const wasDesktopPassiveAway = desktopLifecyclePassiveAwayRef.current;
	      desktopLifecyclePassiveAwayRef.current = false;
	      if (!wasDesktopPassiveAway) {
	        recordDesktopSuspensionIfNeeded(message);
	      } else {
	        markDesktopLifecycleObserved();
	      }
	      void recordLifecycleEvent("foreground", {
	        message,
	        refreshListener: true,
	        updateListenerStatus: true,
	      });
	    };
	    const recordAndroidForeground = (message: string) => {
	      void recordLifecycleEvent("android_foreground", {
	        message,
	        refreshListener: true,
	        updateListenerStatus: true,
	      });
	    };
	    const handleVisibilityChange = () => {
	      if (document.visibilityState === "hidden") {
	        if (isAndroidRuntime) {
	          recordAndroidBackground("android background or screen lock");
	          return;
	        }
	        recordPassiveBackground("document hidden");
	        return;
	      }
	      if (document.visibilityState === "visible") {
	        if (isAndroidRuntime) {
	          recordAndroidForeground("android foreground");
	          return;
	        }
	        recordForeground("document visible");
	      }
	    };
	    const handleBlur = () => {
	      if (isAndroidRuntime) {
	        recordAndroidScreenLock("android window blurred");
	        return;
	      }
	      recordPassiveBackground("window blurred");
	    };
	    const handleFocus = () => {
	      if (isAndroidRuntime) {
	        recordAndroidForeground("android window focused");
	        return;
	      }
	      recordForeground("window focused");
	    };
    const handleOnline = () => {
      void recordLifecycleEvent("network_online", {
        message: "network online",
        refreshListener: true,
        updateListenerStatus: true,
      });
    };
    const handleOffline = () => {
      void recordLifecycleEvent("network_offline", {
        message: "network offline",
        updateListenerStatus: true,
      });
    };
	    const handlePageHide = () => {
	      if (isAndroidRuntime) {
	        recordAndroidBackground("android page hidden");
	        return;
	      }
	      recordPassiveBackground("page hidden");
	    };
	    const handlePageShow = () => {
	      if (isAndroidRuntime) {
	        recordAndroidForeground("android page shown");
	        return;
	      }
	      recordForeground("page shown");
	    };
	    const handleDesktopSleepCheck = () => {
	      recordDesktopSuspensionIfNeeded("desktop woke after suspension");
	    };

	    document.addEventListener("visibilitychange", handleVisibilityChange);
	    window.addEventListener("blur", handleBlur);
	    window.addEventListener("focus", handleFocus);
	    window.addEventListener("online", handleOnline);
	    window.addEventListener("offline", handleOffline);
	    window.addEventListener("pagehide", handlePageHide);
	    window.addEventListener("pageshow", handlePageShow);
	    const desktopSleepCheckId = window.setInterval(
	      handleDesktopSleepCheck,
	      DESKTOP_SLEEP_CHECK_INTERVAL_MS,
	    );
	    return () => {
	      document.removeEventListener("visibilitychange", handleVisibilityChange);
	      window.removeEventListener("blur", handleBlur);
	      window.removeEventListener("focus", handleFocus);
	      window.removeEventListener("online", handleOnline);
	      window.removeEventListener("offline", handleOffline);
	      window.removeEventListener("pagehide", handlePageHide);
	      window.removeEventListener("pageshow", handlePageShow);
	      window.clearInterval(desktopSleepCheckId);
	    };
	  }, [isAndroidRuntime, recordLifecycleEvent]);

  useEffect(() => {
    if (!listenerSyncKey || refreshedProjectSyncKeyRef.current === listenerSyncKey) {
      return;
    }
    refreshedProjectSyncKeyRef.current = listenerSyncKey;
    if (syncResultMutatedLocalProjectCaches(listenerSyncResult)) {
      void refreshProjectMutationQueries();
    }
  }, [listenerSyncKey, listenerSyncResult, refreshProjectMutationQueries]);

  const startListenerMutation = useMutation({
    mutationFn: () => api.startSyncListener(),
    onSuccess: async () => {
      setLastSyncMessage("Sync listener started.");
      setLastSyncResult(null);
      setHiddenListenerSyncKey(null);
      await refreshSyncQueries();
    },
  });
  const stopListenerMutation = useMutation({
    mutationFn: () => api.stopSyncListener(),
    onSuccess: async () => {
      setLastSyncMessage("Sync listener stopped.");
      setLastSyncResult(null);
      setHiddenListenerSyncKey(null);
      await refreshSyncQueries();
    },
  });
  const createPairingOfferMutation = useMutation({
    mutationFn: () =>
      api.createSyncPairingOffer({
        endpoint_hints: endpointHints,
        ttl_seconds: PAIRING_OFFER_TTL_SECONDS,
      }),
    onSuccess: async (response) => {
      const expiresAt = formatTimestamp(response.pairing_offer.expires_at);
      setPairingOutput(pairingOutputForPayload("offer", response.pairing_offer.payload));
      setPairingError(null);
      setPairingMessage(`Pairing offer waiting.${expiresAt ? ` Expires ${expiresAt}.` : ""}`);
    },
  });
  const answerPairingOfferMutation = useMutation({
    mutationFn: (offer: SyncPairingPayloadSchema) =>
      api.answerSyncPairingOffer({
        offer,
        endpoint_hints: endpointHints,
        adopt_sync_group: adoptSyncGroup,
      }),
    onSuccess: async (response) => {
      setPairingCodeDraft("");
      setRawPairingPayloadDraft("");
      setPairingOutput(pairingOutputForPayload("response", response.pairing_response));
      setPairingError(null);
      setPairingMessage(
        `Trusted ${peerLabel(response.trusted_peer)}. Pairing response ready for the offering device.`,
      );
      await refreshSyncQueries();
    },
    onError: () => {
      setPairingError("Could not answer the pairing offer.");
    },
  });
  const trustPeerMutation = useMutation({
    mutationFn: (payload: SyncPairingPayloadSchema) =>
      api.trustSyncPeer({ payload, adopt_sync_group: adoptSyncGroup }),
    onSuccess: async (response, payload) => {
      setPairingCodeDraft("");
      setRawPairingPayloadDraft("");
      setPairingError(null);
      setPairingMessage(`Trusted ${peerLabel(response.trusted_peer)}. Fingerprint ${pairingFingerprint(payload)}.`);
      await refreshSyncQueries();
    },
    onError: () => {
      setPairingError(
        "Could not trust the pairing response. If this is a peer offer, choose Answer Offer.",
      );
    },
  });
  const revokePeerMutation = useMutation({
    mutationFn: (deviceId: string) => api.revokeSyncTrustedPeer(deviceId),
    onSuccess: async (response) => {
      setLastSyncMessage(`Revoked ${peerLabel(response.trusted_peer)}.`);
      setLastSyncResult(null);
      setHiddenListenerSyncKey(null);
      await refreshSyncQueries();
    },
  });
	  const syncNowMutation = useMutation({
    networkMode: "always",
    mutationFn: async (request: SyncNowRequest) => {
      let preflight: SyncPreflightResponse;
      try {
        preflight = await api.getSyncPreflight();
        queryClient.setQueryData(["sync", "preflight"], preflight);
      } catch (error) {
        throw Object.assign(new Error(syncPreflightUnavailableText(error)), { cause: error });
      }
      if (!preflight.ok) {
        throw new Error(syncPreflightBlockedText(preflight));
      }
      setSyncNowPolling(true);
      void queryClient.invalidateQueries({ queryKey: ["sync", "listener"] });
      return request.endpointHints?.length
        ? api.syncTrustedPeerNow(request.deviceId, { endpointHints: request.endpointHints })
        : api.syncTrustedPeerNow(request.deviceId);
    },
    onMutate: () => {
      void queryClient.invalidateQueries({ queryKey: ["sync", "listener"] });
    },
	    onSuccess: async (status) => {
	      setLastSyncMessage(syncStatusText(status, peersById));
	      setLastSyncResult(status);
	      setHiddenListenerSyncKey(listenerSyncKey);
	      if (!status.retryable_interruption_code) {
	        queryClient.setQueryData<SyncTransportStatus | undefined>(
	          ["sync", "listener"],
	          (current) => current
	            ? {
	                ...current,
	                retryable_interruption_code: null,
	                retryable_interruption_peer_device_id: null,
	                retry_guidance: null,
	              }
	            : current,
	        );
	      }
	      const shouldRefreshProjectQueries = syncResultMutatedLocalProjectCaches(status);
	      if (shouldRefreshProjectQueries) {
	        refreshedProjectSyncKeyRef.current = syncResultKey(status);
      }
      await Promise.all([
        refreshSyncQueries(),
        shouldRefreshProjectQueries ? refreshProjectMutationQueries() : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      setLastSyncMessage(syncNowFailureText(error));
      setLastSyncResult(null);
      setHiddenListenerSyncKey(listenerSyncKey);
      void refreshSyncQueries();
    },
    onSettled: () => {
      setSyncNowPolling(false);
    },
  });
  const scanPairingQrMutation = useMutation({
    mutationFn: scanPairingQrCode,
    onSuccess: (value) => {
      setPairingCodeDraft(value);
      setRawPairingPayloadDraft("");
      setPairingError(null);
      setPairingMessage("QR code scanned. Confirm peer name and fingerprint before continuing.");
    },
    onError: (error) => {
      setPairingError(
        qrScanSupported
          ? error instanceof Error ? error.message : "Could not scan QR code."
          : "QR scanning is available on Android devices.",
      );
    },
  });

  function handlePairingCodeDraftChange(value: string) {
    setPairingCodeDraft(value);
    if (value.trim()) {
      setRawPairingPayloadDraft("");
    }
  }

  function handleRawPairingPayloadDraftChange(value: string) {
    setRawPairingPayloadDraft(value);
    if (value.trim()) {
      setPairingCodeDraft("");
    }
  }

  function handleCreatePairingOffer() {
    setPairingError(null);
    setPairingMessage(null);
    if (!listenerActive) {
      setPairingError("Start the listener before creating a pairing offer.");
      return;
    }
    createPairingOfferMutation.mutate();
  }

  function handleTrustPeer() {
    setPairingError(null);
    setPairingMessage(null);
    try {
      trustPeerMutation.mutate(parsePairingInput(pairingInputValue));
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing payload is invalid.");
    }
  }

  function handleAnswerPairingOffer() {
    setPairingError(null);
    setPairingMessage(null);
    try {
      answerPairingOfferMutation.mutate(parsePairingInput(pairingInputValue));
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing payload is invalid.");
    }
  }

  async function handleCopyPairingCode() {
    setPairingError(null);
    const label = pairingOutput?.kind === "response" ? "Pairing response" : "Pairing offer";
    if (!pairingOutput?.code.trim()) {
      setPairingError(`No ${label.toLowerCase()} to copy.`);
      return;
    }
    try {
      const copied = await copyToClipboard(pairingOutput.code, pairingCodeOutputRef.current);
      setPairingMessage(
        copied
          ? `${label} code copied.`
          : `${label} ready. Select the text from the box if clipboard access is unavailable.`,
      );
    } catch {
      setPairingMessage(`${label} ready. Select the text from the box if clipboard access is unavailable.`);
    }
  }

  async function handleCopyRawPairingPayload() {
    setPairingError(null);
    const label = pairingOutput?.kind === "response" ? "Pairing response raw JSON" : "Pairing offer raw JSON";
    if (!pairingOutput?.rawJson.trim()) {
      setPairingError(`No ${label.toLowerCase()} to copy.`);
      return;
    }
    try {
      const copied = await copyToClipboard(pairingOutput.rawJson, rawPairingOutputRef.current);
      setPairingMessage(
        copied
          ? `${label} copied.`
          : `${label} ready. Select the text from the box if clipboard access is unavailable.`,
      );
    } catch {
      setPairingMessage(`${label} ready. Select the text from the box if clipboard access is unavailable.`);
    }
  }

  function handleListenerToggle() {
    if (listenerActive) {
      stopListenerMutation.mutate();
      return;
    }
    startListenerMutation.mutate();
  }

  function buildCurrentSyncEvidenceFile() {
    if (!visibleSyncResult) {
      return null;
    }
    const capturedAt = new Date().toISOString();
    const payload = buildSyncEvidenceExport(visibleSyncResult, {
      capturedAt,
      listenerActive,
      listenerStatus,
      listenerUpdatedAt: listenerQuery.data?.updated_at,
      listenerActivePhase: listenerQuery.data?.active_phase ?? null,
      listenerActiveMessage: listenerQuery.data?.active_message ?? null,
      listenerActiveProgressAt: listenerQuery.data?.active_progress_at ?? null,
      listenerActiveElapsedMs: listenerQuery.data?.active_elapsed_ms ?? null,
      listenerLastStatus: listenerQuery.data?.last_status ?? null,
      listenerLastError: listenerQuery.data?.last_error ?? null,
      listenerLifecycleEvents: listenerQuery.data?.lifecycle_events ?? [],
      listenerLastLifecycleEvent: listenerQuery.data?.last_lifecycle_event ?? null,
      listenerRetryableInterruptionCode: listenerQuery.data?.retryable_interruption_code ?? null,
      listenerRetryGuidance: listenerQuery.data?.retry_guidance ?? null,
      showListenerSyncResult,
    });
    return {
      fileName: syncEvidenceFileName(capturedAt),
      json: JSON.stringify(payload, null, 2),
    };
  }

  async function handleCopySyncEvidence() {
    const evidence = buildCurrentSyncEvidenceFile();
    if (!evidence) {
      setEvidenceError("No sync result available to copy.");
      setEvidenceMessage(null);
      return;
    }
    try {
      const copied = await copyToClipboard(evidence.json);
      if (!copied) {
        setEvidenceMessage(null);
        setEvidenceError("Could not copy sync evidence.");
        return;
      }
      setEvidenceError(null);
      setEvidenceMessage("Sync evidence copied.");
    } catch {
      setEvidenceMessage(null);
      setEvidenceError("Could not copy sync evidence.");
    }
  }

  async function handleExportSyncEvidence() {
    const evidence = buildCurrentSyncEvidenceFile();
    if (!evidence) {
      setEvidenceError("No sync result available to export.");
      setEvidenceMessage(null);
      return;
    }
    setEvidenceError(null);
    setEvidenceMessage(null);

    try {
      if (isTauri()) {
        const saved = await saveSyncEvidenceJson(evidence.fileName, evidence.json);
        if (!saved) {
          return;
        }

        let copied: boolean;
        try {
          copied = await copyToClipboard(evidence.json);
        } catch {
          copied = false;
        }
        setEvidenceError(null);
        setEvidenceMessage(copied ? "Sync evidence exported and copied." : "Sync evidence exported.");
        return;
      }

      let copied: boolean;
      try {
        copied = await copyToClipboard(evidence.json);
      } catch {
        copied = false;
      }
      downloadSyncEvidenceJson(evidence.fileName, evidence.json);
      setEvidenceError(null);
      setEvidenceMessage(copied ? "Sync evidence exported and copied." : "Sync evidence exported.");
    } catch (error) {
      setEvidenceMessage(null);
      setEvidenceError(error instanceof Error ? error.message : "Could not export sync evidence.");
    }
  }

  const listenerMutationPending = startListenerMutation.isPending || stopListenerMutation.isPending;
  const pairingPayloadPending = answerPairingOfferMutation.isPending || trustPeerMutation.isPending;
  const pairingInputInvalid = Boolean(pairingInputValue && decodedPairingInput.error);
  const trustedPeers = peersQuery.data ?? [];
  const lastListenerUpdatedAt = formatTimestamp(listenerQuery.data?.updated_at);
  const currentSyncPhaseValue = syncEvidencePhase(listenerQuery.data?.active_phase);
  const currentSyncPhase = currentSyncPhaseValue === "phase_redacted"
    ? "Sync Phase"
    : currentSyncPhaseValue ? statusLabel(currentSyncPhaseValue) : null;
  const currentSyncMessage = syncVisibleNativeDetailText(
    listenerQuery.data?.active_message,
    "details redacted.",
  );
  const currentSyncProgressAt = formatTimestamp(listenerQuery.data?.active_progress_at);
  const currentSyncElapsed = formatDurationMs(listenerQuery.data?.active_elapsed_ms);
  const currentSyncDetails = [
    listenerQuery.data?.active_run_id ? `Run ${listenerQuery.data.active_run_id}` : null,
    currentSyncProgressAt ? `Progress ${currentSyncProgressAt}` : null,
    currentSyncElapsed ? `Elapsed ${currentSyncElapsed}` : null,
  ].filter((item): item is string => item !== null).join(" · ");
  const currentSyncText = currentSyncPhase && currentSyncMessage
    ? `${currentSyncPhase}: ${currentSyncMessage}`
    : currentSyncMessage ?? currentSyncPhase ?? "Sync in progress.";
  const showCurrentSyncProgress = Boolean(
    (listenerActive || syncNowPolling || syncNowMutation.isPending) &&
      (
        listenerQuery.data?.active_run_id ||
        currentSyncPhase ||
        currentSyncMessage ||
        currentSyncProgressAt ||
        currentSyncElapsed
      ),
  );
  const preflight = preflightQuery.data;
  const preflightReadiness = syncPreflightReadinessLabel(preflight, preflightQuery.isError);
  const preflightLibraryIssues = preflight ? syncPreflightLibraryIssueText(preflight) : null;
  const preflightJobText = preflight ? syncPreflightJobSummary(preflight) : "Checking backend jobs.";
  const preflightJobTypeText = preflight
    ? syncPreflightBlockingTypeSummary(
        preflight.job_state.blocking_jobs,
        preflight.job_state.blocking_jobs_truncated,
      )
    : null;
  const preflightGuidance = preflight
    ? Array.from(new Set([...preflight.manual_cleanup_guidance, ...preflight.job_state.guidance]))
    : [];
  const powerProtectionMessage = syncPowerProtectionMessage(powerInhibitionStatus);

  return (
    <section
      aria-labelledby="activity-sync-heading"
      className="panel activity-sync-panel"
      id="activity-sync-panel"
      role="tabpanel"
    >
      <div className="panel-heading activity-sync-panel__heading">
        <div>
          <h2 id="activity-sync-heading">Sync</h2>
          <p className="subpanel__copy">Native LAN transport lab for trusted desktop peers.</p>
        </div>
        <button
          className="button button--ghost button--small"
          disabled={listenerMutationPending}
          onClick={handleListenerToggle}
          type="button"
        >
          {listenerMutationPending ? "Updating..." : listenerActive ? "Stop Listener" : "Start Listener"}
        </button>
      </div>

      <div className="activity-sync-grid">
        <section className="activity-sync-section" aria-labelledby="activity-sync-listener-heading">
          <div className="activity-sync-section__header">
            <h3 id="activity-sync-listener-heading">Listener</h3>
            <div className="activity-sync-section__actions">
              {retryableInterruption ? (
                <button
                  className="button button--primary button--small"
                  disabled={syncNowMutation.isPending}
                  onClick={() => {
                    syncNowMutation.mutate({
                      deviceId: retryableInterruption.peerDeviceId,
                      endpointHints: retryableInterruption.endpointHints,
                    });
                  }}
                  type="button"
                >
                  {syncNowMutation.isPending &&
                    syncNowMutation.variables?.deviceId === retryableInterruption.peerDeviceId
                    ? "Retrying..."
                    : "Retry Sync"}
                </button>
              ) : null}
              <button
                className="button button--ghost button--small"
                disabled={!visibleSyncResult}
                onClick={handleCopySyncEvidence}
                type="button"
              >
                Copy Evidence
              </button>
              <button
                className="button button--ghost button--small"
                disabled={!visibleSyncResult}
                onClick={handleExportSyncEvidence}
                type="button"
              >
                Export Evidence
              </button>
            </div>
          </div>
          <dl className="activity-sync-facts">
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`activity-sync-status activity-sync-status--${statusClassName(listenerStatus)}`}>
                  {statusLabel(listenerStatus)}
                </span>
              </dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>
                {identityQuery.data?.display_name || identityQuery.data?.device_id || "Checking identity"}
              </dd>
            </div>
            <div>
              <dt>Endpoints</dt>
              <dd>{endpointList(endpointHints)}</dd>
            </div>
            {showCurrentSyncProgress ? (
              <div>
                <dt>Current Sync</dt>
                <dd className="activity-sync-last-sync">
                  <span>{currentSyncText}</span>
                  {currentSyncDetails ? <small>{currentSyncDetails}</small> : null}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Last Sync</dt>
              <dd className="activity-sync-last-sync">
                <span>{displayedLastSyncMessage}</span>
                {visibleSyncSummary ? <small>{visibleSyncSummary}</small> : null}
                {syncProjectResultList(visibleSyncResult)}
                {syncTransferResultList(visibleSyncResult)}
              </dd>
            </div>
            {lastListenerUpdatedAt ? (
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={normalizeApiDateTime(listenerQuery.data?.updated_at ?? "")}>
                    {lastListenerUpdatedAt}
                  </time>
                </dd>
              </div>
            ) : null}
          </dl>

          {listenerQuery.isError ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              Native sync transport is unavailable.
            </p>
          ) : null}
          {listenerLastErrorMessage ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              {listenerLastErrorMessage}
            </p>
          ) : null}
          {powerProtectionMessage ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              {powerProtectionMessage}
            </p>
          ) : null}
          {retryableInterruption ? (
            <p className="activity-sync-alert" role="status">
              {retryableInterruptionText(retryableInterruption)}
            </p>
          ) : null}
          {startListenerMutation.isError || stopListenerMutation.isError ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              Could not update the sync listener.
            </p>
          ) : null}
          {lastSyncMessage ? (
            <p className="activity-sync-alert" role="status">
              {lastSyncMessage}
            </p>
          ) : null}
          {evidenceMessage ? (
            <p className="activity-sync-alert" role="status">
              {evidenceMessage}
            </p>
          ) : null}
          {evidenceError ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              {evidenceError}
            </p>
          ) : null}
        </section>

        <section className="activity-sync-section" aria-labelledby="activity-sync-pairing-heading">
          <div className="activity-sync-section__header">
            <h3 id="activity-sync-pairing-heading">Pairing</h3>
            <button
              className="button button--ghost button--small"
              disabled={!listenerActive || createPairingOfferMutation.isPending}
              onClick={handleCreatePairingOffer}
              title={
                listenerActive
                  ? "Creates a fresh local pairing offer."
                  : "Start the listener before creating a pairing offer."
              }
              type="button"
            >
              {createPairingOfferMutation.isPending ? "Creating..." : "Create Pairing Offer"}
            </button>
          </div>

          {pairingOutput ? (
            <div className="activity-sync-pairing-output">
              <div className="activity-sync-pairing-output__meta">
                <span className="activity-sync-pairing-state">{pairingOutput.state}</span>
                <span>{pairingOutput.kind === "response" ? "Pairing response code" : "Local pairing code"}</span>
                <span>Fingerprint {pairingFingerprint(pairingOutput.payload)}</span>
              </div>
              <div className="activity-sync-pairing-output__body">
                <label className="activity-sync-field">
                  <span>{pairingOutput.kind === "response" ? "Pairing response code" : "Local pairing code"}</span>
                  <textarea
                    aria-label={pairingOutput.kind === "response" ? "Pairing response code" : "Local pairing code"}
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    ref={pairingCodeOutputRef}
                    value={pairingOutput.code}
                  />
                </label>
                <div
                  aria-label={
                    pairingOutput.kind === "response"
                      ? "Pairing response QR code"
                      : "Pairing offer QR code"
                  }
                  className="activity-sync-pairing-qr"
                  role="img"
                >
                  <QRCodeSVG
                    bgColor="#ffffff"
                    fgColor="#111827"
                    level="L"
                    marginSize={4}
                    size={288}
                    value={pairingOutput.code}
                  />
                </div>
              </div>
              <button
                className="button button--ghost button--small"
                onClick={handleCopyPairingCode}
                type="button"
              >
                {pairingOutput.kind === "response" ? "Copy Response Code" : "Copy Pairing Code"}
              </button>
            </div>
          ) : null}

          <label className="activity-sync-field">
            <span>Peer pairing code</span>
            <textarea
              aria-label="Peer pairing code"
              onChange={(event) => handlePairingCodeDraftChange(event.currentTarget.value)}
              placeholder="TFPAIR1..."
              value={pairingCodeDraft}
            />
          </label>

          {qrScanSupported ? (
            <div className="activity-sync-actions">
              <button
                className="button button--ghost button--small"
                disabled={scanPairingQrMutation.isPending}
                onClick={() => scanPairingQrMutation.mutate()}
                title="Scan a pairing QR code with this device camera."
                type="button"
              >
                {scanPairingQrMutation.isPending ? "Scanning..." : "Scan QR"}
              </button>
            </div>
          ) : null}

          {decodedPairingInput.payload ? (
            <div className="activity-sync-peer-preview" aria-label="Peer pairing confirmation">
              <strong>{pairingPayloadLabel(decodedPairingInput.payload)}</strong>
              <dl>
                <div>
                  <dt>Fingerprint</dt>
                  <dd>{pairingFingerprint(decodedPairingInput.payload)}</dd>
                </div>
                <div>
                  <dt>Device</dt>
                  <dd>{decodedPairingInput.payload.device_id}</dd>
                </div>
              </dl>
            </div>
          ) : null}
          {decodedPairingInput.error ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              {decodedPairingInput.error}
            </p>
          ) : null}

          <label className="activity-sync-checkbox">
            <input
              checked={adoptSyncGroup}
              onChange={(event) => setAdoptSyncGroup(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Adopt peer sync group for third-device join</span>
          </label>
          <div className="activity-sync-actions">
            <button
              className="button button--primary button--small"
              disabled={!pairingInputValue || pairingInputInvalid || pairingPayloadPending}
              onClick={handleAnswerPairingOffer}
              type="button"
            >
              {answerPairingOfferMutation.isPending ? "Answering..." : "Answer Offer"}
            </button>
            <button
              className="button button--ghost button--small"
              disabled={!pairingInputValue || pairingInputInvalid || pairingPayloadPending}
              onClick={handleTrustPeer}
              type="button"
            >
              {trustPeerMutation.isPending ? "Trusting..." : "Trust Response"}
            </button>
          </div>
          <details className="activity-sync-advanced">
            <summary>Advanced</summary>
            <label className="activity-sync-field">
              <span>Pasted raw JSON payload</span>
              <textarea
                aria-label="Pasted raw JSON payload"
                onChange={(event) => handleRawPairingPayloadDraftChange(event.currentTarget.value)}
                placeholder='{"device_id":"...","pairing_offer_id":"..."}'
                value={rawPairingPayloadDraft}
              />
            </label>
            {pairingOutput ? (
              <div className="activity-sync-field">
                <div className="activity-sync-field__header">
                  <label htmlFor="activity-sync-pairing-output-raw">
                    {pairingOutput.kind === "response" ? "Pairing response raw JSON" : "Local pairing offer raw JSON"}
                  </label>
                  <button
                    className="button button--ghost button--small"
                    onClick={handleCopyRawPairingPayload}
                    type="button"
                  >
                    {pairingOutput.kind === "response" ? "Copy Raw Response" : "Copy Raw Offer"}
                  </button>
                </div>
                <textarea
                  aria-label={
                    pairingOutput.kind === "response" ? "Pairing response raw JSON" : "Local pairing offer raw JSON"
                  }
                  id="activity-sync-pairing-output-raw"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  ref={rawPairingOutputRef}
                  value={pairingOutput.rawJson}
                />
              </div>
            ) : null}
          </details>
          {pairingMessage ? (
            <p className="activity-sync-alert" role="status">
              {pairingMessage}
            </p>
          ) : null}
          {pairingError || createPairingOfferMutation.isError ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              {pairingError ?? "Could not create a pairing offer."}
            </p>
          ) : null}
        </section>
      </div>

      <section className="activity-sync-section" aria-labelledby="activity-sync-preflight-heading">
        <div className="activity-sync-section__header">
          <h3 id="activity-sync-preflight-heading">Local Readiness</h3>
          <button
            className="button button--ghost button--small"
            disabled={preflightQuery.isFetching}
            onClick={() => {
              void preflightQuery.refetch();
            }}
            type="button"
          >
            {preflightQuery.isFetching ? "Checking..." : "Refresh"}
          </button>
        </div>

        <dl className="activity-sync-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`activity-sync-status activity-sync-status--${statusClassName(preflightReadiness)}`}>
                {preflightReadiness}
              </span>
            </dd>
          </div>
          <div>
            <dt>Library</dt>
            <dd>
              {preflight
                ? preflight.library_ok
                  ? `${preflight.ready_projects}/${preflight.total_projects} projects ready.`
                  : `Library preflight failed${preflightLibraryIssues ? `: ${preflightLibraryIssues}` : ""}.`
                : "Checking local library."}
            </dd>
          </div>
          <div>
            <dt>Backend Jobs</dt>
            <dd>{preflightJobText}</dd>
          </div>
          {preflightJobTypeText ? (
            <div>
              <dt>Job Types</dt>
              <dd>{preflightJobTypeText}</dd>
            </div>
          ) : null}
        </dl>

        {preflightQuery.isError ? (
          <p className="activity-sync-alert activity-sync-alert--error" role="alert">
            Backend preflight unavailable. Retry when the local backend responds.
          </p>
        ) : null}
        {preflight && !preflight.library_ok ? (
          <p className="activity-sync-alert activity-sync-alert--error" role="alert">
            Library preflight failed{preflightLibraryIssues ? `: ${preflightLibraryIssues}` : ""}.
          </p>
        ) : null}
        {preflight && preflight.job_state.blocking_job_count > 0 ? (
          <p className="activity-sync-alert" role="status">
            Backend jobs running: {preflightJobText}
          </p>
        ) : null}
        {preflightGuidance.map((guidance) => (
          <p className="activity-sync-alert" key={guidance} role="status">
            {guidance}
          </p>
        ))}
      </section>

      <section className="activity-sync-section activity-sync-section--nearby" aria-labelledby="activity-sync-nearby-heading">
        <div className="activity-sync-section__header">
          <h3 id="activity-sync-nearby-heading">Nearby Devices</h3>
          <span className="metric-label">{nearbyPeers.length} nearby</span>
        </div>

        {!nearbyPeers.length ? (
          <p className="activity-sync-empty">No nearby devices.</p>
        ) : null}
        {nearbyPeers.length ? (
          <ul className="activity-sync-peer-list" aria-label="Nearby sync devices">
            {nearbyPeers.map((nearbyPeer, index) => {
              const trustedDeviceId = nearbyTrustedDeviceId(nearbyPeer);
              const trustedPeer = trustedDeviceId ? peersById.get(trustedDeviceId) ?? null : null;
              const trustStatus = nearbyTrustStatus(nearbyPeer, trustedPeer);
              const canSync = trustStatus === "match" && trustedPeer !== null && nearbyPeer.endpoint_hints.length > 0;
              const isSyncing = syncNowMutation.isPending &&
                syncNowMutation.variables?.deviceId === trustedPeer?.device_id;
              const lastSeenAt = formatTimestamp(nearbyPeer.last_seen_at);

              return (
                <li
                  className="activity-sync-peer-row activity-sync-peer-row--nearby"
                  key={`${nearbyPeer.device_id ?? "nearby"}-${nearbyPeer.short_fingerprint ?? index}`}
                >
                  <div className="activity-sync-peer-row__main">
                    <strong>{nearbyPeerLabel(nearbyPeer)}</strong>
                    <dl>
                      <div>
                        <dt>Fingerprint</dt>
                        <dd>{nearbyPeerFingerprint(nearbyPeer, trustedPeer)}</dd>
                      </div>
                      <div>
                        <dt>Trust</dt>
                        <dd>
                          <span className={`activity-sync-trust activity-sync-trust--${trustStatus}`}>
                            {nearbyTrustLabel(trustStatus)}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Endpoints</dt>
                        <dd>{nearbyPeerEndpointSummary(nearbyPeer)}</dd>
                      </div>
                      {lastSeenAt ? (
                        <div>
                          <dt>Last Seen</dt>
                          <dd>
                            <time dateTime={normalizeApiDateTime(nearbyPeer.last_seen_at ?? "")}>
                              {lastSeenAt}
                            </time>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                  <div className="activity-sync-peer-row__actions">
                    <button
                      className="button button--ghost button--small"
                      disabled={!canSync || isSyncing}
                      onClick={() => {
                        if (trustedPeer) {
                          syncNowMutation.mutate({
                            deviceId: trustedPeer.device_id,
                            endpointHints: nearbyPeer.endpoint_hints,
                          });
                        }
                      }}
                      type="button"
                    >
                      {isSyncing
                        ? "Syncing..."
                        : canSync
                          ? "Sync Now"
                          : trustStatus === "mismatch"
                            ? "Trust Mismatch"
                            : "Pair Required"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section className="activity-sync-section activity-sync-section--peers" aria-labelledby="activity-sync-peers-heading">
        <div className="activity-sync-section__header">
          <h3 id="activity-sync-peers-heading">Trusted Peers</h3>
          <span className="metric-label">{trustedPeers.length} trusted</span>
        </div>

        {peersQuery.isLoading ? (
          <p className="activity-sync-alert" role="status">
            Loading trusted peers...
          </p>
        ) : null}
        {peersQuery.isError ? (
          <p className="activity-sync-alert activity-sync-alert--error" role="alert">
            Could not load trusted peers.
          </p>
        ) : null}
        {!peersQuery.isLoading && !peersQuery.isError && trustedPeers.length === 0 ? (
          <p className="activity-sync-empty">No trusted peers.</p>
        ) : null}
        {trustedPeers.length ? (
          <ul className="activity-sync-peer-list" aria-label="Trusted sync peers">
            {trustedPeers.map((peer) => {
              const nearbyPeer = trustedNearbyPeerByDeviceId.get(peer.device_id);
              const nearbyEndpointHints = nearbyPeer?.endpoint_hints ?? [];
              const isRevoking = revokePeerMutation.isPending && revokePeerMutation.variables === peer.device_id;
              const isSyncing = syncNowMutation.isPending && syncNowMutation.variables?.deviceId === peer.device_id;
              const trustedAt = formatTimestamp(peer.trusted_at);

              return (
                <li className="activity-sync-peer-row" key={peer.device_id}>
                  <div className="activity-sync-peer-row__main">
                    <strong>{peerLabel(peer)}</strong>
                    <dl>
                      <div>
                        <dt>Device</dt>
                        <dd>{peer.device_id}</dd>
                      </div>
                      <div>
                        <dt>Endpoints</dt>
                        <dd>{peerEndpointSummary(peer)}</dd>
                      </div>
                      {trustedAt ? (
                        <div>
                          <dt>Trusted</dt>
                          <dd>
                            <time dateTime={normalizeApiDateTime(peer.trusted_at)}>{trustedAt}</time>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                  <div className="activity-sync-peer-row__actions">
                    <button
                      className="button button--ghost button--small"
                      disabled={isSyncing}
                      onClick={() =>
                        syncNowMutation.mutate({
                          deviceId: peer.device_id,
                          endpointHints: nearbyEndpointHints.length ? nearbyEndpointHints : undefined,
                        })
                      }
                      type="button"
                    >
                      {isSyncing ? "Syncing..." : "Sync Now"}
                    </button>
                    <button
                      className="button button--ghost button--small"
                      disabled={isRevoking}
                      onClick={() => revokePeerMutation.mutate(peer.device_id)}
                      type="button"
                    >
                      {isRevoking ? "Revoking..." : "Revoke"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {revokePeerMutation.isError ? (
          <p className="activity-sync-alert activity-sync-alert--error" role="alert">
            Could not revoke the trusted peer.
          </p>
        ) : null}
        {syncNowMutation.isError ? (
          <p className="activity-sync-alert activity-sync-alert--error" role="alert">
            Could not run sync now.
          </p>
        ) : null}
      </section>
    </section>
  );
}
