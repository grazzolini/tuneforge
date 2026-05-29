import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import {
  api,
  mergeSyncProjectResults,
  type SyncPairingPayloadSchema,
  type SyncNearbyPeer,
  type SyncNearbyPeerTrustStatus,
  type SyncPreflightBlockingJob,
  type SyncPreflightResponse,
  type SyncTransportProjectResult,
  type SyncTransportRunStatus,
  type SyncTransportTransferResult,
  type SyncTrustedPeerSchema,
} from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime } from "../../lib/datetime";
import { scanPairingQrCode } from "../../lib/pairingQrScanner";
import {
  decodePairingCode,
  encodePairingCode,
  pairingCodeIsExpired,
  pairingFingerprint,
} from "./syncPairingCode";

const PAIRING_OFFER_TTL_SECONDS = 600;
const SYNC_LISTENER_POLL_INTERVAL_MS = 2000;
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
    return `${statusLabel(status.status)} for ${peerName}: ${status.error}`;
  }
  return status.message ?? `${statusLabel(status.status)} for ${peerName}.`;
}

function syncNowFailureText(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return `Sync now failed: ${message}`;
    }
  }
  if (typeof error === "string") {
    const message = error.trim();
    if (message) {
      return `Sync now failed: ${message}`;
    }
  }
  return "Sync now failed.";
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
    timeToFirstArtifactMs: status.time_to_first_artifact_ms,
    totalReceivedBytes: status.total_received_bytes,
    totalServedBytes: status.total_served_bytes,
    throughputBytesPerSecond: status.throughput_bytes_per_second,
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
    failedProjects: status.failed_project_count,
  });
}

function positiveSyncCount(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
  const counters: string[] = [];
  if (typeof status.imported_project_count === "number") {
    counters.push(`${status.imported_project_count} imported`);
  }
  if (typeof status.applied_project_count === "number") {
    counters.push(`${status.applied_project_count} applied`);
  }
  if (typeof status.deleted_project_count === "number") {
    counters.push(`${status.deleted_project_count} deleted`);
  }
  if (typeof status.skipped_project_count === "number") {
    counters.push(`${status.skipped_project_count} skipped`);
  }
  if (typeof status.failed_project_count === "number") {
    counters.push(`${status.failed_project_count} failed`);
  }
  return counters.length ? counters.join(", ") : null;
}

function syncRunTotalTransferBytes(status: SyncTransportRunStatus) {
  const receivedBytes = typeof status.total_received_bytes === "number" ? status.total_received_bytes : null;
  const servedBytes = typeof status.total_served_bytes === "number" ? status.total_served_bytes : null;
  if (receivedBytes === null && servedBytes === null) {
    return null;
  }
  return (receivedBytes ?? 0) + (servedBytes ?? 0);
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
    parts.push(`Fallback: ${status.fallback_reason}`);
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
  const totalTransferBytes = formatByteCount(syncRunTotalTransferBytes(status));
  if (totalTransferBytes) {
    parts.push(`${totalTransferBytes} total`);
  }
  const throughput = formatThroughput(status.throughput_bytes_per_second);
  if (throughput) {
    parts.push(throughput);
  }
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

function syncProjectResultList(status: SyncTransportRunStatus | null | undefined) {
  const results = status ? mergeSyncProjectResults(status.project_results, status.manifest_errors) : [];
  if (!results.length) {
    return null;
  }
  return (
    <ul className="activity-sync-project-results" aria-label="Last sync project results">
      {results.map((result, index) => (
        <li
          className={`activity-sync-project-result activity-sync-project-result--${statusClassName(result.status)}`}
          key={`${result.project_id}-${result.status}-${index}`}
        >
          <span className="activity-sync-project-result__status">{statusLabel(result.status)}</span>
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
  const pairingCodeOutputRef = useRef<HTMLTextAreaElement | null>(null);
  const rawPairingOutputRef = useRef<HTMLTextAreaElement | null>(null);
  const refreshedProjectSyncKeyRef = useRef<string | null>(null);

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
  const listenerStatus = listenerQuery.isError ? "unavailable" : listenerQuery.data?.status ?? "checking";
  const listenerSyncResult = listenerQuery.data?.last_sync ?? null;
  const listenerSyncKey = useMemo(() => syncResultKey(listenerSyncResult), [listenerSyncResult]);
  const showListenerSyncResult = listenerSyncResult !== null && listenerSyncKey !== hiddenListenerSyncKey;
  const lastSyncStatus = listenerSyncResult
    ? syncStatusText(listenerSyncResult, peersById)
    : listenerQuery.data?.last_status ?? syncStatusText(listenerSyncResult, peersById);
  const visibleSyncResult = showListenerSyncResult ? listenerSyncResult : lastSyncResult;
  const displayedLastSyncMessage = !showListenerSyncResult
    ? lastSyncMessage ?? lastSyncStatus
    : lastSyncStatus;
  const visibleSyncSummary = syncRunSummaryText(visibleSyncResult);
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

  const refreshSyncQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sync", "listener"] }),
      queryClient.invalidateQueries({ queryKey: ["sync", "preflight"] }),
      queryClient.invalidateQueries({ queryKey: ["sync", "trusted-peers"] }),
    ]);
  }, [queryClient]);

  const refreshProjectMutationQueries = useCallback(async () => {
    await Promise.all(
      PROJECT_MUTATION_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }, [queryClient]);

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

  const listenerMutationPending = startListenerMutation.isPending || stopListenerMutation.isPending;
  const pairingPayloadPending = answerPairingOfferMutation.isPending || trustPeerMutation.isPending;
  const pairingInputInvalid = Boolean(pairingInputValue && decodedPairingInput.error);
  const trustedPeers = peersQuery.data ?? [];
  const lastListenerUpdatedAt = formatTimestamp(listenerQuery.data?.updated_at);
  const currentSyncPhase = listenerQuery.data?.active_phase
    ? statusLabel(listenerQuery.data.active_phase)
    : null;
  const currentSyncMessage = listenerQuery.data?.active_message?.trim() || null;
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
          <h3 id="activity-sync-listener-heading">Listener</h3>
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
              <dd>{identityQuery.data?.display_name || identityQuery.data?.device_id || "Checking identity"}</dd>
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
          {listenerQuery.data?.last_error ? (
            <p className="activity-sync-alert activity-sync-alert--error" role="alert">
              {listenerQuery.data.last_error}
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
