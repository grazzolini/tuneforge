import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  mergeSyncProjectResults,
  type SyncPairingPayloadSchema,
  type SyncTransportProjectResult,
  type SyncTransportRunStatus,
  type SyncTrustedPeerSchema,
} from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime } from "../../lib/datetime";

const PAIRING_OFFER_TTL_SECONDS = 600;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function requiredPairingString(
  payloadRecord: Record<string, unknown>,
  fieldName: keyof SyncPairingPayloadSchema,
): string {
  const value = payloadRecord[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Pairing payload is missing ${fieldName}.`);
  }
  return value;
}

function pairingEndpointHints(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((hint): hint is string => typeof hint === "string" && Boolean(hint.trim()))
  ) {
    throw new Error("Pairing payload endpoint_hints must be a list of strings.");
  }
  return value;
}

function parsePairingPayload(rawValue: string): SyncPairingPayloadSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("Pairing payload must be valid JSON.");
  }

  const parsedRecord = asRecord(parsed);
  const payloadRecord = asRecord(parsedRecord?.payload) ?? parsedRecord;
  if (!payloadRecord) {
    throw new Error("Pairing payload must be a JSON object.");
  }
  const displayName = payloadRecord.display_name;
  if (displayName !== undefined && displayName !== null && typeof displayName !== "string") {
    throw new Error("Pairing payload display_name must be a string.");
  }
  const expiresAt = requiredPairingString(payloadRecord, "expires_at");
  if (Number.isNaN(new Date(expiresAt).getTime())) {
    throw new Error("Pairing payload expires_at must be a valid date.");
  }

  return {
    sync_group_id: requiredPairingString(payloadRecord, "sync_group_id"),
    device_id: requiredPairingString(payloadRecord, "device_id"),
    display_name: displayName ?? null,
    public_key: requiredPairingString(payloadRecord, "public_key"),
    endpoint_hints: pairingEndpointHints(payloadRecord.endpoint_hints),
    protocol_version: requiredPairingString(payloadRecord, "protocol_version"),
    pairing_offer_id: requiredPairingString(payloadRecord, "pairing_offer_id"),
    pairing_secret: requiredPairingString(payloadRecord, "pairing_secret"),
    expires_at: expiresAt,
    signature: requiredPairingString(payloadRecord, "signature"),
  };
}

async function copyToClipboard(value: string) {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  await navigator.clipboard.writeText(value);
  return true;
}

function peerLabel(peer: SyncTrustedPeerSchema) {
  return peer.display_name?.trim() || peer.device_id;
}

function peerEndpointSummary(peer: SyncTrustedPeerSchema) {
  return peer.endpoint_hints?.length ? peer.endpoint_hints.join(", ") : "No endpoint hints";
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
    receivedArtifacts: status.received_artifacts.length,
    remoteManifests: status.remote_manifest_count,
    localManifests: status.local_manifest_count,
    importedProjects: status.imported_project_count,
    appliedProjects: status.applied_project_count,
    deletedProjects: status.deleted_project_count,
    skippedProjects: status.skipped_project_count,
    failedProjects: status.failed_project_count,
  });
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
  const counters = syncRunProjectCounterText(status);
  if (counters) {
    parts.push(counters);
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
  const [pairingPayloadDraft, setPairingPayloadDraft] = useState("");
  const [pairingOfferText, setPairingOfferText] = useState("");
  const [pairingOfferLabel, setPairingOfferLabel] = useState("Local pairing offer");
  const [adoptSyncGroup, setAdoptSyncGroup] = useState(false);
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<SyncTransportRunStatus | null>(null);
  const [hiddenListenerSyncKey, setHiddenListenerSyncKey] = useState<string | null>(null);

  const identityQuery = useQuery({
    queryKey: ["sync", "identity"],
    queryFn: async () => (await api.getSyncIdentity()).identity,
  });
  const listenerQuery = useQuery({
    queryKey: ["sync", "listener"],
    queryFn: () => api.getSyncTransportStatus(),
  });
  const peersQuery = useQuery({
    queryKey: ["sync", "trusted-peers"],
    queryFn: async () => (await api.listSyncTrustedPeers()).trusted_peers,
  });

  const peersById = useMemo(
    () => new Map((peersQuery.data ?? []).map((peer) => [peer.device_id, peer])),
    [peersQuery.data],
  );
  const endpointHints = listenerQuery.data?.endpoint_hints ?? [];
  const listenerActive = listenerQuery.data?.active ?? false;
  const listenerStatus = listenerQuery.isError ? "unavailable" : listenerQuery.data?.status ?? "checking";
  const listenerSyncResult = listenerQuery.data?.last_sync ?? null;
  const listenerSyncKey = useMemo(() => syncResultKey(listenerSyncResult), [listenerSyncResult]);
  const showListenerSyncResult = listenerSyncResult !== null && listenerSyncKey !== hiddenListenerSyncKey;
  const lastSyncStatus = listenerSyncResult
    ? syncStatusText(listenerSyncResult, peersById)
    : listenerQuery.data?.last_status ?? syncStatusText(listenerSyncResult, peersById);
  const visibleSyncResult = showListenerSyncResult ? listenerSyncResult : lastSyncResult ?? listenerSyncResult;
  const displayedLastSyncMessage = !showListenerSyncResult
    ? lastSyncMessage ?? lastSyncStatus
    : lastSyncStatus;
  const visibleSyncSummary = syncRunSummaryText(visibleSyncResult);

  const refreshSyncQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sync", "listener"] }),
      queryClient.invalidateQueries({ queryKey: ["sync", "trusted-peers"] }),
    ]);
  };

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
      const nextOfferText = JSON.stringify(response.pairing_offer.payload, null, 2);
      const expiresAt = formatTimestamp(response.pairing_offer.expires_at);
      setPairingOfferText(nextOfferText);
      setPairingOfferLabel("Local pairing offer");
      setPairingError(null);
      try {
        const copied = await copyToClipboard(nextOfferText);
        setPairingMessage(
          copied
            ? `Pairing offer copied.${expiresAt ? ` Expires ${expiresAt}.` : ""}`
            : `Pairing offer ready.${expiresAt ? ` Expires ${expiresAt}.` : ""}`,
        );
      } catch {
        setPairingMessage(`Pairing offer ready.${expiresAt ? ` Expires ${expiresAt}.` : ""}`);
      }
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
      const nextResponseText = JSON.stringify(response.pairing_response, null, 2);
      setPairingPayloadDraft("");
      setPairingOfferText(nextResponseText);
      setPairingOfferLabel("Pairing response");
      setPairingError(null);
      try {
        const copied = await copyToClipboard(nextResponseText);
        setPairingMessage(
          copied
            ? `Trusted ${peerLabel(response.trusted_peer)}. Pairing response copied.`
            : `Trusted ${peerLabel(response.trusted_peer)}. Pairing response ready.`,
        );
      } catch {
        setPairingMessage(`Trusted ${peerLabel(response.trusted_peer)}. Pairing response ready.`);
      }
      await refreshSyncQueries();
    },
    onError: () => {
      setPairingError("Could not answer the pairing offer.");
    },
  });
  const trustPeerMutation = useMutation({
    mutationFn: (payload: SyncPairingPayloadSchema) =>
      api.trustSyncPeer({ payload, adopt_sync_group: adoptSyncGroup }),
    onSuccess: async (response) => {
      setPairingPayloadDraft("");
      setPairingError(null);
      setPairingMessage(`Trusted ${peerLabel(response.trusted_peer)}.`);
      await refreshSyncQueries();
    },
    onError: () => {
      setPairingError("Could not trust the pairing payload.");
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
    mutationFn: (deviceId: string) => api.syncTrustedPeerNow(deviceId),
    onSuccess: async (status) => {
      setLastSyncMessage(syncStatusText(status, peersById));
      setLastSyncResult(status);
      setHiddenListenerSyncKey(listenerSyncKey);
      await refreshSyncQueries();
    },
    onError: () => {
      setLastSyncMessage("Sync now failed.");
      setLastSyncResult(null);
      setHiddenListenerSyncKey(null);
    },
  });

  function handleTrustPeer() {
    setPairingError(null);
      setPairingMessage(null);
    try {
      trustPeerMutation.mutate(parsePairingPayload(pairingPayloadDraft));
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing payload is invalid.");
    }
  }

  function handleAnswerPairingOffer() {
    setPairingError(null);
    setPairingMessage(null);
    try {
      answerPairingOfferMutation.mutate(parsePairingPayload(pairingPayloadDraft));
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing payload is invalid.");
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
  const trustedPeers = peersQuery.data ?? [];
  const lastListenerUpdatedAt = formatTimestamp(listenerQuery.data?.updated_at);

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
            <div>
              <dt>Last Sync</dt>
              <dd className="activity-sync-last-sync">
                <span>{displayedLastSyncMessage}</span>
                {visibleSyncSummary ? <small>{visibleSyncSummary}</small> : null}
                {syncProjectResultList(visibleSyncResult)}
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
              onClick={() => createPairingOfferMutation.mutate()}
              title={listenerActive ? undefined : "Start the listener before creating a pairing offer."}
              type="button"
            >
              {createPairingOfferMutation.isPending ? "Creating..." : "Copy Pairing Offer"}
            </button>
          </div>

          {pairingOfferText ? (
            <label className="activity-sync-field">
              <span>{pairingOfferLabel}</span>
              <textarea readOnly value={pairingOfferText} />
            </label>
          ) : null}

          <label className="activity-sync-field">
            <span>Peer offer or response payload</span>
            <textarea
              onChange={(event) => setPairingPayloadDraft(event.currentTarget.value)}
              placeholder='{"device_id":"...","pairing_offer_id":"..."}'
              value={pairingPayloadDraft}
            />
          </label>
          <label className="activity-sync-checkbox">
            <input
              checked={adoptSyncGroup}
              onChange={(event) => setAdoptSyncGroup(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Adopt peer sync group</span>
          </label>
          <div className="activity-sync-actions">
            <button
              className="button button--primary button--small"
              disabled={!pairingPayloadDraft.trim() || pairingPayloadPending}
              onClick={handleAnswerPairingOffer}
              type="button"
            >
              {answerPairingOfferMutation.isPending ? "Answering..." : "Answer Offer"}
            </button>
            <button
              className="button button--ghost button--small"
              disabled={!pairingPayloadDraft.trim() || pairingPayloadPending}
              onClick={handleTrustPeer}
              type="button"
            >
              {trustPeerMutation.isPending ? "Trusting..." : "Trust Response"}
            </button>
          </div>
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
              const isRevoking = revokePeerMutation.isPending && revokePeerMutation.variables === peer.device_id;
              const isSyncing = syncNowMutation.isPending && syncNowMutation.variables === peer.device_id;
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
                      onClick={() => syncNowMutation.mutate(peer.device_id)}
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
