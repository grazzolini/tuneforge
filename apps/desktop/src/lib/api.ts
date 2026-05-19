import createClient from "openapi-fetch";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { components, MobileCapabilities, paths } from "@tuneforge/shared-types";

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
export type ChordResponse = components["schemas"]["ChordResponse"];
export type ChordSegmentSchema = components["schemas"]["ChordSegmentSchema"];
export type LyricsResponse = components["schemas"]["LyricsResponse"];
export type LyricsSegmentSchema = components["schemas"]["LyricsSegmentSchema"];
export type LyricsWordSchema = components["schemas"]["LyricsWordSchema"];
export type ArtifactSchema = components["schemas"]["ArtifactSchema"];
export type JobSchema = components["schemas"]["JobSchema"];
export type PreviewRequest = components["schemas"]["PreviewRequest"];
export type RetuneRequest = components["schemas"]["RetuneRequest"];
export type ExportRequest = components["schemas"]["ExportRequest"];
export type ProjectUpdateRequest = components["schemas"]["ProjectUpdateRequest"];
export type StemRequest = components["schemas"]["StemRequest"];
export type StemModelSchema = components["schemas"]["StemModelSchema"];
export type StemModelsResponse = components["schemas"]["StemModelsResponse"];
export type ChordRequest = components["schemas"]["ChordRequest"];
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
export type RuntimeCapabilities = MobileCapabilities | null;
export type ProjectSyncSummary = {
  state: string;
  label: string;
  isLocal: boolean;
  isLocked: boolean;
  lockReason: string | null;
};
export type SyncTransportRunStatus = {
  peer_device_id?: string | null;
  remote_device_id?: string | null;
  status: string;
  message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  project_results: SyncTransportProjectResult[];
  manifest_errors: SyncTransportManifestError[];
  received_artifacts: SyncTransportTransferResult[];
  served_artifact_requests?: number | null;
  local_manifest_count?: number | null;
  remote_manifest_count?: number | null;
};
export type SyncTransportProjectResult = {
  project_id: string;
  status: string;
  message?: string | null;
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
};
export type SyncTransportStatus = {
  active: boolean;
  status: string;
  endpoint_hints: string[];
  last_status?: string | null;
  last_error?: string | null;
  last_sync?: SyncTransportRunStatus | null;
  updated_at?: string | null;
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
  remote_available: "Remote Available",
  syncing: "Syncing",
};
const PROJECT_SYNC_LOCK_REASONS: Record<string, string> = {
  conflicted: "Resolve sync conflicts before editing this project.",
  deleted: "This project was deleted in the sync group and cannot be edited.",
  downloading: "This project is downloading required local data before edits are enabled.",
  missing: "Required project data is missing on this device.",
  missing_local_bytes: "Required project audio is missing on this device.",
  missing_provider: "No trusted synced device can provide the required project data.",
  remote_available: "Required project data is available from another synced device and must be downloaded before editing.",
  syncing: "This project is still syncing required local data before edits are enabled.",
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

function normalizeProjectSyncState(value: string | null) {
  return value?.toLowerCase().replace(/[\s-]+/g, "_") ?? "local";
}

function labelFromSyncState(state: string) {
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
  const lockReason = isLocked
    ? firstStringField(
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
      ) ?? defaultProjectLockReason(state, isLocal)
    : null;

  return {
    state,
    label: labelFromSyncState(state),
    isLocal,
    isLocked,
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

function normalizeSyncProjectResult(
  value: unknown,
  fallbackStatus = "failed",
  fallbackMessage: string | null = null,
): SyncTransportProjectResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    project_id: firstStringField([record], ["project_id", "projectId", "id"]) ?? "unknown",
    status: normalizeTransportStatusToken(
      firstStringField([record], ["status", "state", "result"]) ?? fallbackStatus,
    ),
    message: firstStringField([record], ["message", "error", "reason"]) ?? fallbackMessage,
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
  return {
    artifact_id: firstStringField([record], ["artifact_id", "artifactId", "id"]) ?? "unknown",
    content_sha256: firstStringField([record], ["content_sha256", "contentSha256"]),
    size_bytes: numberField(record, ["size_bytes", "sizeBytes"]),
    status: normalizeTransportStatusToken(
      firstStringField([record], ["status", "state", "result"]) ?? "completed",
    ),
    message: firstStringField([record], ["message", "error", "reason"]),
  };
}

const SYNC_PROJECT_RESULT_PROBLEM_STATES = new Set(["completed_with_errors", "conflicted", "error", "failed"]);

function normalizeSyncRunStatus(value: unknown): SyncTransportRunStatus | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const manifestErrors = recordArrayField(record, ["manifest_errors", "manifestErrors"])
    .map((item) => normalizeSyncManifestError(item))
    .filter((item): item is SyncTransportManifestError => item !== null);
  const importedProjectResults = recordArrayField(record, ["project_results", "projectResults", "imported_projects", "importedProjects"])
    .map((item) => normalizeSyncProjectResult(item))
    .filter((item): item is SyncTransportProjectResult => item !== null);
  const manifestErrorProjectResults = manifestErrors.map((error) => ({
    project_id: error.project_id,
    status: "failed",
    message: error.message,
  }));
  const projectResults = [...importedProjectResults, ...manifestErrorProjectResults];
  const receivedArtifacts = recordArrayField(record, ["received_artifacts", "receivedArtifacts", "artifacts"])
    .map((item) => normalizeSyncTransferResult(item))
    .filter((item): item is SyncTransportTransferResult => item !== null);
  const localManifestCount = numberField(record, ["local_manifest_count", "localManifestCount"]);
  const remoteManifestCount = numberField(record, ["remote_manifest_count", "remoteManifestCount"]);
  const hasProjectProblems = projectResults.some((result) =>
    SYNC_PROJECT_RESULT_PROBLEM_STATES.has(result.status),
  );
  const status = firstStringField([record], ["status", "state"]) ??
    (manifestErrors.length > 0 || hasProjectProblems ? "completed_with_errors" : "completed");
  const summary =
    localManifestCount !== null || remoteManifestCount !== null
      ? `Exchanged ${localManifestCount ?? 0} local and ${remoteManifestCount ?? 0} remote manifest(s); processed ${projectResults.length} project(s), received ${receivedArtifacts.length} artifact(s).`
      : null;
  return {
    peer_device_id: firstStringField([record], ["peer_device_id", "peerDeviceId", "device_id", "deviceId"]),
    remote_device_id: firstStringField([record], ["remote_device_id", "remoteDeviceId"]),
    status,
    message: firstStringField([record], ["message", "status_message", "statusMessage"]) ?? summary,
    started_at: firstStringField([record], ["started_at", "startedAt"]),
    completed_at: firstStringField([record], ["completed_at", "completedAt"]),
    error: firstStringField([record], ["error", "last_error", "lastError"]),
    project_results: projectResults,
    manifest_errors: manifestErrors,
    received_artifacts: receivedArtifacts,
    served_artifact_requests: numberField(record, ["served_artifact_requests", "servedArtifactRequests"]),
    local_manifest_count: localManifestCount,
    remote_manifest_count: remoteManifestCount,
  };
}

function normalizeSyncTransportStatus(value: unknown): SyncTransportStatus {
  const record = asRecord(value);
  if (!record) {
    return {
      active: false,
      status: "unavailable",
      endpoint_hints: [],
      last_error: "Native sync transport returned an invalid status.",
    };
  }

  const active = firstBooleanField([record], ["active", "running", "listening", "is_listening", "isListening"]) ?? false;
  const status = firstStringField([record], ["status", "state", "listener_status", "listenerStatus"]) ??
    (active ? "listening" : "stopped");
  return {
    active,
    status,
    endpoint_hints: stringArrayField(record, ["endpoint_hints", "endpointHints", "endpoints"]),
    last_status: firstStringField([record], ["last_status", "lastStatus"]),
    last_error: firstStringField([record], ["last_error", "lastError", "error"]),
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

async function syncTrustedPeerNow(deviceId: string) {
  const result = normalizeSyncRunStatus(
    await invokeDesktopNative<unknown>("sync_transport_sync_now", { payload: { peerDeviceId: deviceId } }),
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
  getHealth: () => Promise<HealthResponse>;
  listProjects: (search?: string) => Promise<components["schemas"]["ProjectsResponse"]>;
  importProject: (body: components["schemas"]["ProjectImportRequest"]) => Promise<components["schemas"]["ProjectResponse"]>;
  getProject: (projectId: string) => Promise<components["schemas"]["ProjectResponse"]>;
  updateProject: (projectId: string, body: ProjectUpdateRequest) => Promise<components["schemas"]["ProjectResponse"]>;
  deleteProject: (projectId: string) => Promise<components["schemas"]["DeleteResponse"]>;
  analyzeProject: (projectId: string) => Promise<components["schemas"]["JobResponse"]>;
  getAnalysis: (projectId: string) => Promise<AnalysisResponse>;
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
  listJobs: () => Promise<components["schemas"]["JobsResponse"]>;
  getJob: (jobId: string) => Promise<components["schemas"]["JobResponse"]>;
  cancelJob: (jobId: string) => Promise<components["schemas"]["JobResponse"]>;
  getSyncIdentity: () => Promise<SyncLocalIdentityResponse>;
  createSyncPairingOffer: (body: SyncPairingOfferRequest) => Promise<SyncPairingOfferResponse>;
  answerSyncPairingOffer: (body: SyncPairingAnswerRequest) => Promise<SyncPairingAnswerResponse>;
  listSyncTrustedPeers: () => Promise<SyncTrustedPeersResponse>;
  trustSyncPeer: (body: SyncTrustedPeerCreateRequest) => Promise<SyncTrustedPeerResponse>;
  revokeSyncTrustedPeer: (deviceId: string) => Promise<SyncTrustedPeerResponse>;
  getSyncTransportStatus: () => Promise<SyncTransportStatus>;
  startSyncListener: () => Promise<SyncTransportStatus>;
  stopSyncListener: () => Promise<SyncTransportStatus>;
  syncTrustedPeerNow: (deviceId: string) => Promise<SyncTransportRunStatus>;
  streamArtifactUrl: (artifactId: string) => string;
};

let client = createClient<paths>({ baseUrl: apiBaseUrl });
const mobileArtifactPaths = new Map<string, string>();
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

function rememberArtifactPaths(artifacts: ArtifactSchema[]) {
  artifacts.forEach((artifact) => {
    const playbackPath =
      typeof artifact.metadata.playback_path === "string"
        ? artifact.metadata.playback_path
        : artifact.path;
    mobileArtifactPaths.set(artifact.id, playbackPath);
  });
}

function createHttpTuneForgeClient(): TuneForgeClient {
  return {
    getMobileCapabilities: async () => null,
    getHealth: () => unwrap(client.GET("/api/v1/health")),
    listProjects: (search?: string) =>
      unwrap(
        client.GET("/api/v1/projects", {
          params: search ? ({ query: { search } } as never) : undefined,
        }),
      ),
    importProject: (body: components["schemas"]["ProjectImportRequest"]) =>
      unwrap(client.POST("/api/v1/projects/import", { body })),
    getProject: (projectId: string) => unwrap(client.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    updateProject: (projectId: string, body: ProjectUpdateRequest) =>
      unwrap(client.PATCH("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } }, body })),
    deleteProject: (projectId: string) =>
      unwrap(client.DELETE("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    analyzeProject: (projectId: string) =>
      unwrap(
        client.POST("/api/v1/projects/{project_id}/analyze", {
          params: { path: { project_id: projectId } },
          body: { include_tempo: false, force: false },
        }),
      ),
    getAnalysis: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/analysis", { params: { path: { project_id: projectId } } })),
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
    listJobs: () => unwrap(client.GET("/api/v1/jobs")),
    getJob: (jobId: string) => unwrap(client.GET("/api/v1/jobs/{job_id}", { params: { path: { job_id: jobId } } })),
    cancelJob: (jobId: string) =>
      unwrap(client.POST("/api/v1/jobs/{job_id}/cancel", { params: { path: { job_id: jobId } } })),
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
    syncTrustedPeerNow,
    streamArtifactUrl: (artifactId: string) => `${getApiBaseUrl()}/api/v1/artifacts/${artifactId}/stream`,
  };
}

function createMobileTuneForgeClient(capabilities: MobileCapabilities): TuneForgeClient {
  return {
    getMobileCapabilities: async () => capabilities,
    getHealth: () => invokeMobile("mobile_get_health"),
    listProjects: (search?: string) => invokeMobile("mobile_list_projects", { search }),
    importProject: (body: components["schemas"]["ProjectImportRequest"]) =>
      invokeMobile("mobile_import_project", { payload: body }),
    getProject: (projectId: string) => invokeMobile("mobile_get_project", { projectId }),
    updateProject: (projectId: string, body: ProjectUpdateRequest) =>
      invokeMobile("mobile_update_project", { projectId, payload: body }),
    deleteProject: (projectId: string) => invokeMobile("mobile_delete_project", { projectId }),
    analyzeProject: (projectId: string) => invokeMobile("mobile_submit_analyze", { projectId }),
    getAnalysis: (projectId: string) => invokeMobile("mobile_get_analysis", { projectId }),
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
    listArtifacts: async (projectId: string) => {
      const response = await invokeMobile<components["schemas"]["ArtifactsResponse"]>("mobile_list_artifacts", { projectId });
      rememberArtifactPaths(response.artifacts);
      return response;
    },
    deleteArtifact: (projectId: string, artifactId: string) =>
      invokeMobile("mobile_delete_artifact", { projectId, artifactId }),
    createExport: (projectId: string, body: ExportRequest) =>
      invokeMobile("mobile_submit_export", { projectId, payload: body }),
    listJobs: () => invokeMobile("mobile_list_jobs"),
    getJob: (jobId: string) => invokeMobile("mobile_get_job", { jobId }),
    cancelJob: (jobId: string) => invokeMobile("mobile_cancel_job", { jobId }),
    getSyncIdentity: async () => {
      throw unsupportedRuntimeError("Sync identity");
    },
    createSyncPairingOffer: async () => {
      throw unsupportedRuntimeError("Sync pairing");
    },
    answerSyncPairingOffer: async () => {
      throw unsupportedRuntimeError("Sync pairing");
    },
    listSyncTrustedPeers: async () => {
      throw unsupportedRuntimeError("Trusted sync peers");
    },
    trustSyncPeer: async () => {
      throw unsupportedRuntimeError("Sync pairing");
    },
    revokeSyncTrustedPeer: async () => {
      throw unsupportedRuntimeError("Trusted sync peers");
    },
    getSyncTransportStatus: async () => {
      throw unsupportedRuntimeError("Native sync transport");
    },
    startSyncListener: async () => {
      throw unsupportedRuntimeError("Native sync transport");
    },
    stopSyncListener: async () => {
      throw unsupportedRuntimeError("Native sync transport");
    },
    syncTrustedPeerNow: async () => {
      throw unsupportedRuntimeError("Native sync transport");
    },
    streamArtifactUrl: (artifactId: string) => {
      const artifactPath = mobileArtifactPaths.get(artifactId);
      return artifactPath ? convertFileSrc(artifactPath) : "";
    },
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
  getHealth: () => activeClient.getHealth(),
  listProjects: (search?: string) => activeClient.listProjects(search),
  importProject: (body) => activeClient.importProject(body),
  getProject: (projectId: string) => activeClient.getProject(projectId),
  updateProject: (projectId: string, body: ProjectUpdateRequest) => activeClient.updateProject(projectId, body),
  deleteProject: (projectId: string) => activeClient.deleteProject(projectId),
  analyzeProject: (projectId: string) => activeClient.analyzeProject(projectId),
  getAnalysis: (projectId: string) => activeClient.getAnalysis(projectId),
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
  listJobs: () => activeClient.listJobs(),
  getJob: (jobId: string) => activeClient.getJob(jobId),
  cancelJob: (jobId: string) => activeClient.cancelJob(jobId),
  getSyncIdentity: () => activeClient.getSyncIdentity(),
  createSyncPairingOffer: (body: SyncPairingOfferRequest) => activeClient.createSyncPairingOffer(body),
  answerSyncPairingOffer: (body: SyncPairingAnswerRequest) => activeClient.answerSyncPairingOffer(body),
  listSyncTrustedPeers: () => activeClient.listSyncTrustedPeers(),
  trustSyncPeer: (body: SyncTrustedPeerCreateRequest) => activeClient.trustSyncPeer(body),
  revokeSyncTrustedPeer: (deviceId: string) => activeClient.revokeSyncTrustedPeer(deviceId),
  getSyncTransportStatus: () => activeClient.getSyncTransportStatus(),
  startSyncListener: () => activeClient.startSyncListener(),
  stopSyncListener: () => activeClient.stopSyncListener(),
  syncTrustedPeerNow: (deviceId: string) => activeClient.syncTrustedPeerNow(deviceId),
  streamArtifactUrl: (artifactId: string) => activeClient.streamArtifactUrl(artifactId),
};
