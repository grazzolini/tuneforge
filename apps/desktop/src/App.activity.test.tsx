import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileCapabilities } from "@tuneforge/shared-types";
import {
  mergeSyncProjectResults,
  normalizeSyncTransportStatus,
  syncRunCanonicalCounts,
  type JobSchema,
  type ProjectSchema,
  type SyncPairingPayloadSchema,
  type SyncPreflightResponse,
  type SyncTransportRunStatus,
} from "./lib/api";
import { encodePairingCode, pairingFingerprint } from "./features/activity/syncPairingCode";
import {
  mockCancelJob,
  mockConfirm,
  mockGetAnalysis,
  mockGetChords,
  mockGetLyrics,
  mockGetProject,
  mockGetMobileCapabilities,
  mockGetSyncIdentity,
  mockGetSyncTransportStatus,
  mockRecordSyncLifecycleEvent,
  mockAnswerSyncPairingOffer,
  mockCreateSyncPairingOffer,
  mockListSyncTrustedPeers,
  getMockInvoke,
  mockListArtifacts,
  mockStartSyncListener,
  mockStopSyncListener,
  mockScanPairingQrCode,
  mockListSections,
  mockSyncTrustedPeerNow,
  mockTrustSyncPeer,
  mockListJobs,
  mockBulkJobs,
  mockGetSyncPreflight,
  mockListProjects,
  renderApp,
  resetAppTestHarness,
  setJobs,
  setBeatBackends,
  setChordBackends,
  setProjects,
  setSyncPreflight,
  setSyncTransportStatus,
  setSyncTrustedPeers,
  triggerMockIntersectionObserver,
} from "./test/appTestHarness";

const mockClipboardWriteText = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mockClipboardWriteText,
}));

const irohTransportId = "tuneforge-sync+iroh";
const tcpTransportId = "tuneforge-sync+tcp";
const irohEndpointHint = `${irohTransportId}://device_peer_1`;
const tcpEndpointHint = `${tcpTransportId}://192.168.1.57:48625`;
const listenerTcpEndpointHint = `${tcpTransportId}://192.168.1.42:48625`;
const nearbyIrohEndpointHint = `${irohTransportId}://device_peer_1?direct=192.168.1.58%3A47620`;
const nearbyTcpEndpointHint = `${tcpTransportId}://192.168.1.58:48625?device_id=device_peer_1&v=1`;
const syncEndpointHints = [irohEndpointHint, tcpEndpointHint];
const listenerEndpointHints = [irohEndpointHint, listenerTcpEndpointHint];

type CanonicalSummaryCounts = Partial<Record<
  "local" | "remote" | "imported" | "applied" | "deleted" | "skipped" | "conflicted" | "failed" |
  "received" | "reused" | "failedTransfers" | "manifestErrors",
  number | "unknown"
>>;

function canonicalSummary(overrides: CanonicalSummaryCounts = {}) {
  const counts = {
    local: "unknown",
    remote: "unknown",
    imported: 0,
    applied: 0,
    deleted: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
    received: 0,
    reused: 0,
    failedTransfers: 0,
    manifestErrors: 0,
    ...overrides,
  };
  return `Exchanged ${counts.local} local and ${counts.remote} remote manifest(s); final project outcomes: imported ${counts.imported}, applied ${counts.applied}, deleted ${counts.deleted}, skipped ${counts.skipped}, conflicted ${counts.conflicted}, failed ${counts.failed}; transfers: received ${counts.received}, reused/already staged ${counts.reused}, failed ${counts.failedTransfers}; manifest export errors (separate from final project outcomes): ${counts.manifestErrors}.`;
}

const defaultSyncNowCanonicalSummary = canonicalSummary({
  local: 2,
  remote: 4,
  applied: 1,
  skipped: 1,
  conflicted: 1,
  failed: 1,
  received: 1,
  manifestErrors: 1,
});
const importedNoRemoteCanonicalSummary = canonicalSummary({ imported: 1 });
const importedOneRemoteCanonicalSummary = canonicalSummary({ local: 0, remote: 1, imported: 1 });
const listenerAppliedCanonicalSummary = canonicalSummary({ imported: 1, applied: 1, deleted: 1, conflicted: 1 });
const androidCapabilities: MobileCapabilities = {
  platform: "android",
  mediaBackend: "android_media_codec",
  isEmulator: false,
  gpuBackend: null,
  analysisAvailable: true,
  basicChordsAvailable: true,
  whisperAvailable: false,
  stemSeparationAvailable: false,
  generationTestingAvailable: false,
  maxRecommendedModel: null,
  cpuFallbackAllowed: false,
};

function project(overrides: Partial<ProjectSchema>): Record<string, unknown> {
  return {
    id: "proj_123",
    display_name: "Demo Song",
    source_key_override: null,
    source_path: "/tmp/demo.wav",
    imported_path: "/tmp/projects/demo.wav",
    duration_seconds: 182,
    sample_rate: 44100,
    channels: 2,
    created_at: "2026-04-18T13:16:00.000Z",
    updated_at: "2026-04-18T13:16:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<JobSchema>): Record<string, unknown> {
  return {
    id: "job_1",
    project_id: "proj_123",
    type: "preview",
    status: "completed",
    progress: 100,
    error_message: null,
    created_at: "2026-04-18T13:16:00.000Z",
    updated_at: "2026-04-18T13:16:00.000Z",
    ...overrides,
  };
}

function terminalHistoryJobs(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const jobNumber = index + 1;
    return job({
      id: `job_history_${String(jobNumber).padStart(3, "0")}`,
      type: `history_${String(jobNumber).padStart(3, "0")}`,
      status: "completed",
      progress: 100,
      completed_at: `2026-04-18T13:${String(59 - index).padStart(2, "0")}:00.000Z`,
      created_at: "2026-04-18T13:00:00.000Z",
      updated_at: `2026-04-18T13:${String(59 - index).padStart(2, "0")}:00.000Z`,
    });
  });
}

function pairingPayload(overrides: Partial<SyncPairingPayloadSchema> = {}): SyncPairingPayloadSchema {
  return {
    sync_group_id: "sync_group_local",
    device_id: "device_peer_1",
    display_name: "Laptop Rig",
    public_key: "pub_peer_1",
    endpoint_hints: syncEndpointHints,
    protocol_version: "tuneforge-sync-v1",
    pairing_offer_id: "pair_offer_peer_1",
    pairing_secret: "pair_secret_peer_1",
    expires_at: "2099-04-18T13:26:00.000Z",
    signature: "pair_signature_peer_1",
    ...overrides,
  };
}

function syncRunStatus(overrides: Partial<SyncTransportRunStatus> = {}): SyncTransportRunStatus {
  const hasCompleteAccounting = [
    "project_results",
    "manifest_errors",
    "imported_project_count",
    "applied_project_count",
    "deleted_project_count",
    "skipped_project_count",
    "conflicted_project_count",
    "failed_project_count",
    "manifest_export_error_count",
  ].some((key) => Object.prototype.hasOwnProperty.call(overrides, key));
  return {
    peer_device_id: "device_peer_1",
    remote_device_id: "device_peer_1",
    selected_transport: "iroh",
    attempted_transports: ["iroh"],
    status: "completed",
    message: "Sync completed.",
    error: null,
    project_results: [],
    manifest_errors: [],
    received_artifacts: [],
    ...(hasCompleteAccounting
      ? {
          project_results_complete: true,
          manifest_errors_complete: true,
          received_artifacts_complete: true,
        }
      : {}),
    ...overrides,
  };
}

function setEvidenceSyncResult(suffix: string) {
  setSyncTransportStatus({
    active: true,
    status: "listening",
    endpoint_hints: listenerEndpointHints,
    last_sync: syncRunStatus({
      run_id: `sync_run_${suffix}`,
      session_id: `sync_session_${suffix}`,
      message: `Imported proj_${suffix} from device_peer_1.`,
      project_results: [{
        project_id: `proj_${suffix}`,
        status: "imported",
        message: `Imported proj_${suffix}.`,
        imported_count: 1,
      }],
    }),
  });
}

function syncPreflight(overrides: Partial<SyncPreflightResponse> = {}): SyncPreflightResponse {
  return {
    ok: true,
    library_ok: true,
    total_projects: 1,
    ready_projects: 1,
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
    ...overrides,
  };
}

async function openSyncTab(user: ReturnType<typeof userEvent.setup>) {
  renderApp(["/activity"]);
  expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Sync" }));

  expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();
}

async function primeProjectDataQueries(
  queryClient: ReturnType<typeof renderApp>["queryClient"],
  projectId: string,
) {
  await Promise.all([
    queryClient.fetchQuery({
      queryKey: ["projects", ""],
      queryFn: () => mockListProjects({ limit: 50, offset: 0 }),
    }),
    queryClient.fetchQuery({
      queryKey: ["project", projectId],
      queryFn: async () => (await mockGetProject(projectId)).project,
    }),
    queryClient.fetchQuery({
      queryKey: ["lyrics", projectId],
      queryFn: () => mockGetLyrics(projectId),
    }),
    queryClient.fetchQuery({
      queryKey: ["chords", projectId],
      queryFn: () => mockGetChords(projectId),
    }),
    queryClient.fetchQuery({
      queryKey: ["analysis", projectId],
      queryFn: async () => (await mockGetAnalysis(projectId)).analysis,
    }),
    queryClient.fetchQuery({
      queryKey: ["sections", projectId],
      queryFn: () => mockListSections(projectId),
    }),
    queryClient.fetchQuery({
      queryKey: ["artifacts", projectId],
      queryFn: async () => (await mockListArtifacts(projectId)).artifacts,
    }),
    queryClient.fetchQuery({
      queryKey: ["jobs", { projectId, scope: "project", status: "active" }],
      queryFn: () =>
        mockListJobs({
          project_id: projectId,
          status: ["running", "pending"],
          limit: 200,
          offset: 0,
        }),
    }),
    queryClient.fetchQuery({
      queryKey: ["jobs", { projectId, scope: "project", status: "terminal" }],
      queryFn: () =>
        mockListJobs({
          project_id: projectId,
          status: ["completed", "failed", "cancelled"],
          limit: 50,
          offset: 0,
        }),
    }),
  ]);
}

function expectProjectDataQueriesInvalidationState(
  queryClient: ReturnType<typeof renderApp>["queryClient"],
  projectId: string,
  isInvalidated: boolean,
) {
  [
    ["projects", ""],
    ["project", projectId],
    ["lyrics", projectId],
    ["chords", projectId],
    ["analysis", projectId],
    ["sections", projectId],
    ["artifacts", projectId],
    ["jobs", { projectId, scope: "project", status: "active" }],
    ["jobs", { projectId, scope: "project", status: "terminal" }],
  ].forEach((queryKey) => {
    const queryState = queryClient.getQueryState(queryKey);
    expect(queryState, `Expected query ${JSON.stringify(queryKey)} to be primed`).toBeDefined();
    expect(queryState?.isInvalidated, `Expected query ${JSON.stringify(queryKey)} invalidation state`).toBe(
      isInvalidated,
    );
  });
}

function expectProjectDataQueriesInvalidated(
  queryClient: ReturnType<typeof renderApp>["queryClient"],
  projectId: string,
) {
  expectProjectDataQueriesInvalidationState(queryClient, projectId, true);
}

function expectProjectDataQueriesNotInvalidated(
  queryClient: ReturnType<typeof renderApp>["queryClient"],
  projectId: string,
) {
  expectProjectDataQueriesInvalidationState(queryClient, projectId, false);
}

async function exportEvidenceFromCurrentSyncResult(user: ReturnType<typeof userEvent.setup>) {
  let exportedBlob: Blob | null = null;
  const createObjectURL = vi.fn((blob: Blob) => {
    exportedBlob = blob;
    return "blob:sync-evidence";
  });
  const revokeObjectURL = vi.fn();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const originalSetTimeout = window.setTimeout.bind(window);
  const setTimeoutSpy = vi
    .spyOn(window, "setTimeout")
    .mockImplementation((handler: TimerHandler, timeout?: number) => {
      if (timeout === 5000 && typeof handler === "function") {
        handler();
        return 0;
      }
      return originalSetTimeout(handler, timeout);
    });
  Object.defineProperty(window.URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(window.URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });

  try {
    await user.click(screen.getByRole("button", { name: "Export Evidence" }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sync-evidence");
    expect(exportedBlob).not.toBeNull();
    return JSON.parse(await exportedBlob!.text()) as Record<string, unknown>;
  } finally {
    clickSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  }
}

type SyncEvidenceValidationResult = {
  ok: boolean;
  schemaPrivacyOk: boolean;
  errors: string[];
};

async function validateExportedEvidence(evidence: unknown): Promise<SyncEvidenceValidationResult> {
  // @ts-expect-error JS validator has no TypeScript declaration.
  const validator = await import("../../../scripts/sync-validation.mjs") as {
    validateEvidence: (value: unknown) => SyncEvidenceValidationResult;
  };
  return validator.validateEvidence(evidence);
}

function setDocumentVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

describe("Desktop app activity", () => {
  beforeEach(() => {
    resetAppTestHarness();
    mockClipboardWriteText.mockReset();
    mockClipboardWriteText.mockResolvedValue(undefined);
  });

  it("opens Activity from the sidebar with Jobs selected", async () => {
    const user = userEvent.setup();
    renderApp(["/"]);

    expect(await screen.findByRole("heading", { level: 1, name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Activity" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Jobs" })).toHaveAttribute("aria-selected", "true");
    expect(mockListJobs).toHaveBeenCalled();
    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("proj_123"));
  });

  it("requests active and terminal job pages separately", async () => {
    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();

    await waitFor(() => expect(mockListJobs).toHaveBeenCalledTimes(2));
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["running", "pending"],
      sort_by: "activity",
      limit: 200,
      offset: 0,
    });
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      sort_by: "activity",
      limit: 50,
      offset: 0,
    });
    expect(mockListJobs.mock.calls.some(([params]) => params === undefined)).toBe(false);
  });

  it("searches activity jobs by project name", async () => {
    setProjects([
      project({ id: "proj_choir", display_name: "Choir Practice" }),
      project({ id: "proj_drums", display_name: "Drum Study" }),
    ]);
    setJobs([
      job({
        id: "job_choir_active",
        project_id: "proj_choir",
        type: "stems",
        status: "running",
        progress: 50,
      }),
      job({
        id: "job_choir_history",
        project_id: "proj_choir",
        type: "lyrics",
        status: "completed",
        progress: 100,
      }),
      job({
        id: "job_drums",
        project_id: "proj_drums",
        type: "analyze",
        status: "completed",
        progress: 100,
      }),
      job({
        id: "job_no_project",
        project_id: null,
        type: "export",
        status: "completed",
        progress: 100,
      }),
    ]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "stems running job" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search jobs by project"), {
      target: { value: " choir " },
    });

    await waitFor(() =>
      expect(mockListJobs).toHaveBeenCalledWith({
        status: ["running", "pending"],
        sort_by: "activity",
        search: "choir",
        limit: 200,
        offset: 0,
      }),
    );
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      sort_by: "activity",
      search: "choir",
      limit: 50,
      offset: 0,
    });
    expect(await screen.findByRole("article", { name: "lyrics completed job" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "analyze completed job" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("article", { name: "export completed job" })).not.toBeInTheDocument();
  });

  it("resolves job project names from project details outside the first project page", async () => {
    const deepProjectId = "proj_055";
    setProjects(
      Array.from({ length: 55 }, (_, index) => {
        const projectNumber = index + 1;
        const projectId = `proj_${String(projectNumber).padStart(3, "0")}`;
        return project({
          id: projectId,
          display_name: projectId === deepProjectId ? "Deep Catalog Song" : `Catalog Song ${projectNumber}`,
        });
      }),
    );
    setJobs([
      job({
        id: "job_deep_project",
        project_id: deepProjectId,
        type: "lyrics",
        status: "completed",
        progress: 100,
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "lyrics completed job" });
    expect(within(row).getByRole("link", { name: "Open Deep Catalog Song project" })).toHaveAttribute(
      "href",
      `/projects/${deepProjectId}`,
    );
    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith(deepProjectId));
    expect(mockListProjects).not.toHaveBeenCalled();
  });

  it("falls back to the project ID when a job project no longer exists", async () => {
    setProjects([project({ id: "proj_123", display_name: "Demo Song" })]);
    setJobs([
      job({
        id: "job_deleted_project",
        project_id: "proj_deleted",
        type: "preview",
        status: "completed",
        progress: 100,
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "preview completed job" });
    expect(within(row).getByRole("link", { name: "Open proj_deleted project" })).toHaveAttribute(
      "href",
      "/projects/proj_deleted",
    );
    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("proj_deleted"));
    expect(mockListProjects).not.toHaveBeenCalled();
  });

  it("automatically loads additional active job pages", async () => {
    setJobs(
      Array.from({ length: 205 }, (_, index) => {
        const jobNumber = index + 1;
        return job({
          id: `job_active_${String(jobNumber).padStart(3, "0")}`,
          type: `active_${String(jobNumber).padStart(3, "0")}`,
          status: "running",
          progress: 25,
          started_at: `2026-04-18T13:${String(index % 60).padStart(2, "0")}:00.000Z`,
          created_at: `2026-04-18T13:${String(index % 60).padStart(2, "0")}:00.000Z`,
          updated_at: `2026-04-18T13:${String(index % 60).padStart(2, "0")}:00.000Z`,
        });
      }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "active_001 running job" })).toBeInTheDocument();
    expect(await screen.findByRole("article", { name: "active_205 running job" })).toBeInTheDocument();
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["running", "pending"],
      sort_by: "activity",
      limit: 200,
      offset: 200,
    });
  });

  it("switches between Activity Jobs and Sync tabs", async () => {
    const user = userEvent.setup();
    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Jobs" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Sync" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sync" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("list", { name: "Job queue" })).not.toBeInTheDocument();
    expect(mockGetSyncIdentity).toHaveBeenCalled();
    expect(mockGetSyncTransportStatus).toHaveBeenCalled();
    expect(mockListSyncTrustedPeers).toHaveBeenCalled();
  });

  it("answers a peer pairing offer", async () => {
    const user = userEvent.setup();
    const payload = pairingPayload();
    const compactCode = encodePairingCode(payload);
    await openSyncTab(user);

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: compactCode },
    });
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent("Laptop Rig");
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent(pairingFingerprint(payload));
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));

    await waitFor(() =>
      expect(mockAnswerSyncPairingOffer).toHaveBeenCalledWith({
        offer: expect.objectContaining({
          device_id: "device_peer_1",
          endpoint_hints: syncEndpointHints,
        }),
        endpoint_hints: [],
        adopt_sync_group: false,
      }),
    );
    expect(await screen.findByText("Laptop Rig")).toBeInTheDocument();
    expect(
      screen.getByText("Trusted Laptop Rig. Pairing response ready for the offering device."),
    ).toBeInTheDocument();
    expect(screen.getByText("answer received")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pairing response QR code" })).toBeInTheDocument();
    const responseCode = (screen.getByLabelText("Pairing response code") as HTMLTextAreaElement).value;
    expect(responseCode).toMatch(/^TFPAIR1\./);
    expect(responseCode).not.toContain('"device_id"');
  });

  it("creates a local pairing offer from the header without copying it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await openSyncTab(user);

    await user.click(screen.getByRole("button", { name: "Start Listener" }));
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Pairing Offer" }));

    await waitFor(() =>
      expect(mockCreateSyncPairingOffer).toHaveBeenCalledWith({
        endpoint_hints: listenerEndpointHints,
        ttl_seconds: 600,
      }),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByText(/Pairing offer waiting\./)).toBeInTheDocument();
    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Pairing Code" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pairing offer QR code" })).toBeInTheDocument();
    const offerCode = (screen.getByLabelText("Local pairing code") as HTMLTextAreaElement).value;
    expect(offerCode).toMatch(/^TFPAIR1\./);
    expect(offerCode).not.toContain('"signature"');
  });

  it("falls back to the visible pairing text when clipboard write rejects", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied."));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    await openSyncTab(user);

    await user.click(screen.getByRole("button", { name: "Start Listener" }));
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Pairing Offer" }));

    const output = (await screen.findByLabelText("Local pairing code")) as HTMLTextAreaElement;
    const focus = vi.spyOn(output, "focus");
    const select = vi.spyOn(output, "select");
    await user.click(screen.getByRole("button", { name: "Copy Pairing Code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenLastCalledWith(expect.stringMatching(/^TFPAIR1\./));
    expect(focus).toHaveBeenCalled();
    expect(select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByText("Pairing offer code copied.")).toBeInTheDocument();
  });

  it("copies the visible pairing response without creating a new offer", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const payload = pairingPayload();
    await openSyncTab(user);

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(payload) },
    });
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));

    expect(await screen.findByLabelText("Pairing response code")).toBeInTheDocument();
    mockCreateSyncPairingOffer.mockClear();
    await user.click(screen.getByRole("button", { name: "Copy Response Code" }));

    expect(mockCreateSyncPairingOffer).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenLastCalledWith(expect.stringMatching(/^TFPAIR1\./));
    expect(screen.getByText("Pairing response code copied.")).toBeInTheDocument();
  });

  it("trusts a peer from a pasted pairing response", async () => {
    const user = userEvent.setup();
    const payload = pairingPayload();
    await openSyncTab(user);

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(payload) },
    });
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent("Laptop Rig");
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent(pairingFingerprint(payload));
    await user.click(screen.getByRole("button", { name: "Trust Response" }));

    await waitFor(() =>
      expect(mockTrustSyncPeer).toHaveBeenCalledWith({
        payload: expect.objectContaining({
          device_id: "device_peer_1",
          endpoint_hints: syncEndpointHints,
        }),
        adopt_sync_group: false,
      }),
    );
    expect(await screen.findByText("Laptop Rig")).toBeInTheDocument();
    expect(screen.getByText(`Trusted Laptop Rig. Fingerprint ${pairingFingerprint(payload)}.`)).toBeInTheDocument();
  });

  it("keeps raw pairing JSON in Advanced and can answer from raw JSON", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const payload = pairingPayload();
    await openSyncTab(user);

    await user.click(screen.getByRole("button", { name: "Start Listener" }));
    await user.click(screen.getByRole("button", { name: "Create Pairing Offer" }));
    await user.click(screen.getByText("Advanced"));
    expect((await screen.findByLabelText("Local pairing offer raw JSON") as HTMLTextAreaElement).value)
      .toContain('"signature": "pair_signature_1"');
    await user.click(screen.getByRole("button", { name: "Copy Raw Offer" }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('"signature": "pair_signature_1"'));

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(pairingPayload({ device_id: "device_stale" })) },
    });
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent("device_stale");

    fireEvent.change(screen.getByLabelText("Pasted raw JSON payload"), {
      target: { value: JSON.stringify(payload) },
    });
    expect(screen.getByLabelText("Peer pairing code")).toHaveValue("");
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent(pairingFingerprint(payload));
    expect(screen.getByRole("checkbox", { name: "Adopt peer sync group for third-device join" }))
      .not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));
    await waitFor(() => expect(mockAnswerSyncPairingOffer).toHaveBeenCalledWith({
      offer: expect.objectContaining({ device_id: "device_peer_1" }),
      endpoint_hints: listenerEndpointHints,
      adopt_sync_group: false,
    }));
  });

  it("hides QR scanning on desktop", async () => {
    const user = userEvent.setup();
    await openSyncTab(user);

    expect(screen.queryByRole("button", { name: "Scan QR" })).not.toBeInTheDocument();
    expect(screen.queryByText("QR scanning is available on Android devices.")).not.toBeInTheDocument();
  });

  it("scans compact pairing codes on Android", async () => {
    const user = userEvent.setup();
    const payload = pairingPayload();
    const compactCode = encodePairingCode(payload);
    mockGetMobileCapabilities.mockResolvedValue(androidCapabilities);
    mockScanPairingQrCode.mockResolvedValue(compactCode);
    await openSyncTab(user);

    await waitFor(() => expect(screen.getByRole("button", { name: "Scan QR" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Scan QR" }));

    await waitFor(() => expect(mockScanPairingQrCode).toHaveBeenCalled());
    expect(screen.getByLabelText("Peer pairing code")).toHaveValue(compactCode);
    expect(screen.getByText("QR code scanned. Confirm peer name and fingerprint before continuing.")).toBeInTheDocument();
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent("Laptop Rig");
  });

  it("blocks invalid and expired pairing inputs", async () => {
    const user = userEvent.setup();
    await openSyncTab(user);

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: "not-json" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Pairing payload must be valid JSON.");
    expect(screen.getByRole("button", { name: "Answer Offer" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(pairingPayload({ expires_at: "2020-01-01T00:00:00.000Z" })) },
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Pairing payload expired."));
    expect(screen.getByRole("button", { name: "Trust Response" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));
    expect(mockAnswerSyncPairingOffer).not.toHaveBeenCalled();
  });

  it("starts and stops the native sync listener", async () => {
    const user = userEvent.setup();
    await openSyncTab(user);

    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Listener" }));

    await waitFor(() => expect(mockStartSyncListener).toHaveBeenCalled());
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    expect(screen.getByText(irohEndpointHint)).toBeInTheDocument();
    expect(screen.getByText(listenerTcpEndpointHint)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop Listener" }));

    await waitFor(() => expect(mockStopSyncListener).toHaveBeenCalled());
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
  });

  it("shows active sync progress and polls listener status while listening", async () => {
    const user = userEvent.setup();
    const intervalHandlers: Array<() => void | Promise<void>> = [];
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === 2000 && typeof handler === "function") {
          intervalHandlers.push(handler as () => void | Promise<void>);
          return 2000;
        }
        return 1;
      });
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

    try {
      setSyncTransportStatus({
        active: true,
        status: "listening",
        endpoint_hints: syncEndpointHints,
        active_run_id: "sync_run_active_1",
        active_phase: "artifact_transfer",
        active_message: "Receiving source audio.",
        active_progress_at: "2026-04-18T13:20:30.000Z",
        active_elapsed_ms: 2500,
      });

      await openSyncTab(user);

      expect(await screen.findByText("Artifact Transfer: Receiving source audio.")).toBeInTheDocument();
      expect(screen.getByText(/Run sync_run_active_1/)).toBeInTheDocument();
      expect(screen.getByText(/Progress Apr 18/)).toBeInTheDocument();
      expect(screen.getByText(/Elapsed 2\.5 s/)).toBeInTheDocument();
      await waitFor(() => expect(intervalHandlers.length).toBeGreaterThan(0));

      const initialStatusCalls = mockGetSyncTransportStatus.mock.calls.length;
      setSyncTransportStatus({
        active_message: "Applying remote changes.",
        active_progress_at: "2026-04-18T13:20:40.000Z",
        active_elapsed_ms: 3500,
      });
      await act(async () => {
        await intervalHandlers[intervalHandlers.length - 1]?.();
      });

      await waitFor(() =>
        expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(initialStatusCalls),
      );
      expect(await screen.findByText("Artifact Transfer: Applying remote changes.")).toBeInTheDocument();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("polls listener status while sync now is pending", async () => {
    const user = userEvent.setup();
    const intervalHandlers: Array<() => void | Promise<void>> = [];
    let resolveSyncNow: (status: SyncTransportRunStatus) => void = () => {
      throw new Error("Sync now promise was not captured.");
    };
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === 2000 && typeof handler === "function") {
          intervalHandlers.push(handler as () => void | Promise<void>);
          return 2000;
        }
        return 1;
      });
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

    try {
      setSyncTrustedPeers([
        {
          device_id: "device_peer_1",
          sync_group_id: "sync_group_local",
          display_name: "Laptop Rig",
          public_key: "pub_peer_1",
          endpoint_hints: syncEndpointHints,
          trusted_at: "2026-04-18T13:16:00.000Z",
        },
      ]);
      mockSyncTrustedPeerNow.mockImplementationOnce(
        () =>
          new Promise<SyncTransportRunStatus>((resolve) => {
            resolveSyncNow = resolve;
          }),
      );
      await openSyncTab(user);

      const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
      const peerRow = within(peers).getByText("Laptop Rig").closest("li");
      expect(peerRow).not.toBeNull();
      await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

      await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
      await waitFor(() => expect(intervalHandlers.length).toBeGreaterThan(0));

      const initialStatusCalls = mockGetSyncTransportStatus.mock.calls.length;
      setSyncTransportStatus({
        active: false,
        status: "stopped",
        active_run_id: "sync_run_pending_1",
        active_phase: "planning",
        active_message: "Planning sync.",
        active_progress_at: "2026-04-18T13:21:00.000Z",
        active_elapsed_ms: 750,
      });
      await act(async () => {
        await intervalHandlers[intervalHandlers.length - 1]?.();
      });

      await waitFor(() =>
        expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(initialStatusCalls),
      );
      expect(await screen.findByText("Planning: Planning sync.")).toBeInTheDocument();
      expect(screen.getByText(/Run sync_run_pending_1/)).toBeInTheDocument();

      const finishSyncNow = resolveSyncNow;
      await act(async () => {
        finishSyncNow(syncRunStatus({ message: "Pending sync completed." }));
      });

      expect(await screen.findAllByText("Pending sync completed.")).not.toHaveLength(0);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

	  it("records passive blur and hidden lifecycle events without showing retry", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    const retryableStatus = {
      active: false,
      status: "stopped",
      endpoint_hints: [],
      nearby_peers: [],
      last_lifecycle_event: {
        kind: "background",
        occurred_at: "2026-04-18T13:16:30.000Z",
        message: "window blurred",
        retryable: true,
        interruption_code: "network_offline",
        retry_guidance: "Retry with Laptop Rig.",
        peer_device_id: "device_peer_1",
        run_id: "sync_run_background_1",
      },
      lifecycle_events: [],
      retryable_interruption_code: "network_offline",
      retryable_interruption_peer_device_id: "device_peer_1",
      retry_guidance: "Retry with Laptop Rig.",
      last_sync: null,
      updated_at: "2026-04-18T13:16:30.000Z",
    };
    mockRecordSyncLifecycleEvent.mockResolvedValue(retryableStatus);

    try {
      await openSyncTab(user);
      mockRecordSyncLifecycleEvent.mockClear();

      fireEvent.blur(window);
      setDocumentVisibility("hidden");
      fireEvent(document, new Event("visibilitychange"));

      await waitFor(() => expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledTimes(2));
      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "background", message: "window blurred" }),
      );
      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "background", message: "document hidden" }),
      );
      expect(screen.queryByRole("button", { name: "Retry Sync" })).not.toBeInTheDocument();
    } finally {
      setDocumentVisibility("visible");
    }
	  });

	  it("records Android background and screen-lock lifecycle events without retrying active sync", async () => {
	    const user = userEvent.setup();
	    mockGetMobileCapabilities.mockResolvedValue(androidCapabilities);
	    setSyncTrustedPeers([
	      {
	        device_id: "device_peer_1",
	        sync_group_id: "sync_group_local",
	        display_name: "Laptop Rig",
	        public_key: "pub_peer_1",
	        endpoint_hints: syncEndpointHints,
	        trusted_at: "2026-04-18T13:16:00.000Z",
	      },
	    ]);
	    mockRecordSyncLifecycleEvent.mockImplementation(async (event) => {
	      const passiveStatus = {
	        active: true,
	        status: "listening",
	        endpoint_hints: listenerEndpointHints,
	        nearby_peers: [],
	        last_lifecycle_event: {
	          kind: event.kind,
	          occurred_at: event.occurredAt ?? "2026-04-18T13:16:30.000Z",
	          message: event.message ?? null,
	          retryable: false,
	          interruption_code: null,
	          retry_guidance: null,
	          peer_device_id: "device_peer_1",
	          run_id: "sync_run_android_lifecycle_1",
	        },
	        lifecycle_events: [],
	        retryable_interruption_code: null,
	        retryable_interruption_peer_device_id: null,
	        retry_guidance: null,
	        last_sync: null,
	        updated_at: "2026-04-18T13:16:30.000Z",
	      };
	      setSyncTransportStatus(passiveStatus);
	      return passiveStatus;
	    });

	    try {
	      await openSyncTab(user);
	      await waitFor(() => expect(screen.getByRole("button", { name: "Scan QR" })).toBeEnabled());
	      mockRecordSyncLifecycleEvent.mockClear();

	      fireEvent.blur(window);
	      setDocumentVisibility("hidden");
	      fireEvent(document, new Event("visibilitychange"));

	      await waitFor(() => expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledTimes(2));
	      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
	        expect.objectContaining({ kind: "android_screen_lock", message: "android window blurred" }),
	      );
	      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
	        expect.objectContaining({ kind: "android_background", message: "android background or screen lock" }),
	      );
	      expect(screen.queryByRole("button", { name: "Retry Sync" })).not.toBeInTheDocument();
	    } finally {
	      setDocumentVisibility("visible");
	    }
	  });

	  it("records desktop sleep and wake after a long visible timer gap", async () => {
	    const user = userEvent.setup();
	    const setIntervalSpy = vi.spyOn(window, "setInterval");
	    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
	    const dateNowSpy = vi.spyOn(Date, "now");
	    const intervalHandlers: Array<() => void> = [];
	    let now = 1_000_000;
	    dateNowSpy.mockImplementation(() => now);
	    setIntervalSpy.mockImplementation((handler: TimerHandler, timeout?: number) => {
	      if (timeout === 10_000 && typeof handler === "function") {
	        intervalHandlers.push(handler as () => void);
	      }
	      return 1;
	    });

	    try {
	      setDocumentVisibility("visible");
	      mockRecordSyncLifecycleEvent.mockResolvedValue({
	        active: true,
	        status: "listening",
	        endpoint_hints: listenerEndpointHints,
	        nearby_peers: [],
	        lifecycle_events: [],
	        last_sync: null,
	      });

	      await openSyncTab(user);
	      mockRecordSyncLifecycleEvent.mockClear();
	      expect(intervalHandlers.length).toBeGreaterThan(0);

	      now += 120_000;
	      await act(async () => {
	        intervalHandlers[intervalHandlers.length - 1]?.();
	      });

	      await waitFor(() => expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledTimes(2));
	      expect(mockRecordSyncLifecycleEvent).toHaveBeenNthCalledWith(
	        1,
	        expect.objectContaining({ kind: "sleep", message: "desktop suspended for 120 seconds" }),
	      );
	      expect(mockRecordSyncLifecycleEvent).toHaveBeenNthCalledWith(
	        2,
	        expect.objectContaining({ kind: "wake", message: "desktop woke after suspension" }),
	      );
	    } finally {
	      dateNowSpy.mockRestore();
	      setIntervalSpy.mockRestore();
	      clearIntervalSpy.mockRestore();
	      setDocumentVisibility("visible");
	    }
	  });

	  it("records offline lifecycle state and retries sync through preflight with nearby endpoints", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      nearby_peers: [
        {
          device_id: "device_peer_1",
          display_name: "Laptop Rig",
          public_key: "pub_peer_1",
          trust_status: "match",
          endpoint_hints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
        },
      ],
    });
    mockRecordSyncLifecycleEvent.mockImplementation(async (event) => {
      const retryableStatus = {
        active: true,
        status: "listening",
        endpoint_hints: listenerEndpointHints,
        nearby_peers: [
          {
            device_id: "device_peer_1",
            display_name: "Laptop Rig",
            public_key: "pub_peer_1",
            trust_status: "match",
            endpoint_hints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
          },
        ],
        last_lifecycle_event: {
          kind: event.kind,
          occurred_at: event.occurredAt ?? "2026-04-18T13:17:00.000Z",
          message: event.message ?? null,
          retryable: true,
          interruption_code: "network_offline",
          retry_guidance: "Network restored. Retry sync.",
          peer_device_id: "device_peer_1",
          run_id: "sync_run_offline_1",
        },
        lifecycle_events: [
          {
            kind: event.kind,
            occurred_at: event.occurredAt ?? "2026-04-18T13:17:00.000Z",
            message: event.message ?? null,
            retryable: true,
            interruption_code: "network_offline",
            retry_guidance: "Network restored. Retry sync.",
            peer_device_id: "device_peer_1",
            run_id: "sync_run_offline_1",
          },
        ],
        retryable_interruption_code: "network_offline",
        retryable_interruption_peer_device_id: "device_peer_1",
        retry_guidance: "Network restored. Retry sync.",
        last_sync: null,
        updated_at: "2026-04-18T13:17:00.000Z",
      };
      setSyncTransportStatus(retryableStatus);
      return retryableStatus;
    });

    await openSyncTab(user);
    mockRecordSyncLifecycleEvent.mockClear();
    mockGetSyncPreflight.mockClear();
    mockSyncTrustedPeerNow.mockClear();

    fireEvent(window, new Event("offline"));

    await waitFor(() =>
      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "network_offline", message: "network offline" }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Retry Sync" })).toBeInTheDocument();
    expect(screen.getByText("Network restored. Retry sync.")).toBeInTheDocument();

	    const retryButton = screen.getByRole("button", { name: "Retry Sync" });
	    expect(retryButton).toBeEnabled();
	    mockSyncTrustedPeerNow.mockImplementationOnce(async () => {
	      const result = syncRunStatus({
	        run_id: "sync_run_retry_success_1",
	        status: "completed",
	        message: "Retry completed.",
	        lifecycle_events: [],
	        retryable_interruption_code: null,
	        retryable_interruption_peer_device_id: null,
	        retry_guidance: null,
	      });
	      setSyncTransportStatus({
	        nearby_peers: [],
	        retryable_interruption_code: null,
	        retryable_interruption_peer_device_id: null,
	        retry_guidance: null,
	        last_sync: result,
	      });
	      return result;
	    });
	    fireEvent.click(retryButton);

    await waitFor(() => expect(mockGetSyncPreflight).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1", {
        endpointHints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
      }),
    );
	    expect(mockGetSyncPreflight.mock.invocationCallOrder[0]).toBeLessThan(
	      mockSyncTrustedPeerNow.mock.invocationCallOrder[0],
	    );
	    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry Sync" })).not.toBeInTheDocument());
	    expect(await screen.findAllByText("Retry completed.")).not.toHaveLength(0);
	  });

  it("records foreground and online lifecycle events while refreshing listener status", async () => {
    const user = userEvent.setup();
    mockRecordSyncLifecycleEvent.mockImplementation(async (event) => ({
      active: false,
      status: "stopped",
      endpoint_hints: [],
      nearby_peers: [],
      last_lifecycle_event: {
        kind: event.kind,
        occurred_at: event.occurredAt ?? "2026-04-18T13:18:00.000Z",
        message: event.message ?? null,
        retryable: false,
      },
      lifecycle_events: [],
      last_sync: null,
      updated_at: "2026-04-18T13:18:00.000Z",
    }));
    await openSyncTab(user);
    mockRecordSyncLifecycleEvent.mockClear();
    mockGetSyncTransportStatus.mockClear();

    fireEvent(window, new Event("online"));

    await waitFor(() =>
      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "network_online", message: "network online" }),
      ),
    );
    await waitFor(() => expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(0));

    mockGetSyncTransportStatus.mockClear();
    fireEvent.focus(window);

    await waitFor(() =>
      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "foreground", message: "window focused" }),
      ),
    );
    await waitFor(() => expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(0));

    mockGetSyncTransportStatus.mockClear();
    setDocumentVisibility("visible");
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(mockRecordSyncLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "foreground", message: "document visible" }),
      ),
    );
    await waitFor(() => expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(0));
  });

  it("shows nearby devices and syncs trusted matches with discovered endpoints", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
      {
        device_id: "device_peer_2",
        sync_group_id: "sync_group_local",
        display_name: "Old Laptop",
        public_key: "pub_peer_2",
        endpoint_hints: [],
        trusted_at: "2026-04-18T13:17:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      nearby_peers: [
        {
          device_id: "device_peer_1",
          display_name: "Laptop Rig",
          public_key: "pub_peer_1",
          short_fingerprint: "A1B2-C3D4-E5F6-7890",
          trust_status: "match",
          endpoint_hints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
          last_seen_at: "2026-04-18T13:19:00.000Z",
        },
        {
          device_id: "device_unknown",
          display_name: "Guest Phone",
          short_fingerprint: "1111-2222-3333-4444",
          trust_status: "unknown",
          endpoint_hints: ["tuneforge-sync+tcp://192.168.1.70:48625?device_id=device_unknown&v=1"],
          last_seen_at: "2026-04-18T13:18:00.000Z",
        },
        {
          device_id: "device_peer_2",
          display_name: "Old Laptop",
          public_key: "unexpected_pub_peer_2",
          short_fingerprint: "9999-8888-7777-6666",
          trust_status: "mismatch",
          endpoint_hints: ["tuneforge-sync+tcp://192.168.1.71:48625?device_id=device_peer_2&v=1"],
        },
      ],
    });
    await openSyncTab(user);

    const nearbyDevices = await screen.findByRole("list", { name: "Nearby sync devices" });
    const laptopRow = within(nearbyDevices).getByText("Laptop Rig").closest("li");
    const guestRow = within(nearbyDevices).getByText("Guest Phone").closest("li");
    const mismatchRow = within(nearbyDevices).getByText("Old Laptop").closest("li");
    expect(laptopRow).not.toBeNull();
    expect(guestRow).not.toBeNull();
    expect(mismatchRow).not.toBeNull();
    expect(within(laptopRow as HTMLElement).getByText("A1B2-C3D4-E5F6-7890")).toBeInTheDocument();
    expect(within(laptopRow as HTMLElement).getByText("Trusted")).toBeInTheDocument();
    expect(
      within(laptopRow as HTMLElement).getByText([nearbyIrohEndpointHint, nearbyTcpEndpointHint].join(", ")),
    ).toBeInTheDocument();
    expect(within(laptopRow as HTMLElement).getByText(/Apr 18/)).toBeInTheDocument();
    expect(within(guestRow as HTMLElement).getByText("Unknown")).toBeInTheDocument();
    expect(within(guestRow as HTMLElement).getByRole("button", { name: "Pair Required" })).toBeDisabled();
    expect(within(mismatchRow as HTMLElement).getByText("Trust mismatch")).toBeInTheDocument();
    expect(within(mismatchRow as HTMLElement).getByRole("button", { name: "Trust Mismatch" })).toBeDisabled();
    await user.click(within(laptopRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() =>
      expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1", {
        endpointHints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
      }),
    );
  });

  it("ready preflight allows sync now for a trusted peer", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    await openSyncTab(user);

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    expect(within(peerRow as HTMLElement).getByText("device_peer_1")).toBeInTheDocument();
    expect(within(peerRow as HTMLElement).getByText(syncEndpointHints.join(", "))).toBeInTheDocument();
    const preflightSection = screen.getByRole("heading", { name: "Local Readiness" }).closest("section");
    expect(preflightSection).not.toBeNull();
    expect(within(preflightSection as HTMLElement).getByText("Ready")).toBeInTheDocument();
    mockGetSyncPreflight.mockClear();

    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockGetSyncPreflight).toHaveBeenCalled());
    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(mockGetSyncPreflight.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncTrustedPeerNow.mock.invocationCallOrder[0],
    );
    expect(await screen.findAllByText(defaultSyncNowCanonicalSummary)).not.toHaveLength(0);
    expect(screen.queryByText("Manifest exchange completed with 4 project results.")).not.toBeInTheDocument();
    expect(screen.getByText(/Transport Iroh/)).toBeInTheDocument();

    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(4);
    expect(within(resultRows[0]).getByText("Applied")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("proj_imported")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("Reconciliation apply: 3 applied, 1 satisfied, 0 skipped, 0 failed.")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Skipped")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("proj_up_to_date")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("Conflicted")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("proj_conflict")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("Local lyrics conflict with the trusted peer revision.")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("Failed")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("proj_missing_audio")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("Peer did not provide the required source audio.")).toBeInTheDocument();
  });

  it("refreshes project data queries after sync now imports or applies project data", async () => {
    const user = userEvent.setup();
    const projectId = "proj_cache_target";
    setProjects([project({ id: projectId, display_name: "Cache Target" })]);
    setJobs([]);
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    mockSyncTrustedPeerNow.mockImplementationOnce(async (deviceId) =>
      syncRunStatus({
        peer_device_id: deviceId,
        remote_device_id: deviceId,
        selected_transport: irohTransportId,
        attempted_transports: [irohTransportId],
        status: "completed",
        message: "Applied and imported project data.",
        imported_project_count: 1,
        applied_project_count: 1,
        project_results: [
          {
            project_id: projectId,
            status: "applied",
            message: "Applied remote lyrics, chords, analysis, sections, artifacts, and jobs.",
          },
          {
            project_id: "proj_imported",
            status: "imported",
            message: "Imported project from trusted peer.",
          },
        ],
      }),
    );

    const { queryClient } = renderApp(["/activity"]);
    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Sync" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();
    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();

    await primeProjectDataQueries(queryClient, projectId);

    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText(canonicalSummary({ imported: 1, applied: 1 }))).not.toHaveLength(0);
    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(2);
    expect(within(resultRows[0]).getByText("Applied")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText(projectId)).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Imported")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("proj_imported")).toBeInTheDocument();

    expectProjectDataQueriesInvalidated(queryClient, projectId);
  });

  it("refreshes project data queries once for new listener-side sync results", async () => {
    const user = userEvent.setup();
    const projectId = "proj_listener_cache_target";
    setProjects([project({ id: projectId, display_name: "Listener Cache Target" })]);
    setJobs([]);
    const listenerLastSync = syncRunStatus({
      run_id: "listener_sync_run_cache_1",
      session_id: "listener_sync_session_cache_1",
      peer_device_id: "device_peer_1",
      remote_device_id: "device_peer_1",
      selected_transport: irohTransportId,
      attempted_transports: [irohTransportId],
      status: "completed_with_errors",
      message: "Listener applied cached project data.",
      imported_project_count: 1,
      applied_project_count: 1,
      deleted_project_count: 1,
      project_results: [
        {
          project_id: projectId,
          status: "applied",
          message: "Applied listener-side project data.",
        },
        {
          project_id: "proj_listener_imported",
          status: "imported",
          message: "Imported listener-side project data.",
        },
        {
          project_id: "proj_listener_deleted",
          status: "deleted",
          message: "Deleted listener-side project data.",
        },
        {
          project_id: "proj_listener_conflicted",
          status: "conflicted",
          message: "Conflicted listener-side project data.",
        },
      ],
      manifest_errors: [],
      received_artifacts: [],
      started_at: "2026-04-18T13:16:00.000Z",
      completed_at: "2026-04-18T13:16:01.000Z",
    });

    const { queryClient } = renderApp(["/activity"]);
    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Sync" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();

    await primeProjectDataQueries(queryClient, projectId);
    expectProjectDataQueriesNotInvalidated(queryClient, projectId);

    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: listenerLastSync,
    });
    const listenerStatusCalls = mockGetSyncTransportStatus.mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["sync", "listener"] });
    });
    await waitFor(() => expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(listenerStatusCalls));
    expect(await screen.findAllByText(listenerAppliedCanonicalSummary)).not.toHaveLength(0);

    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(4);
    expect(within(resultRows[0]).getByText("Applied")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText(projectId)).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Imported")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("proj_listener_imported")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("Deleted")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("proj_listener_deleted")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("Conflicted")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("proj_listener_conflicted")).toBeInTheDocument();
    await waitFor(() => expectProjectDataQueriesInvalidated(queryClient, projectId));

    await primeProjectDataQueries(queryClient, projectId);
    expectProjectDataQueriesNotInvalidated(queryClient, projectId);

    const repeatedListenerStatusCalls = mockGetSyncTransportStatus.mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["sync", "listener"] });
    });
    await waitFor(() =>
      expect(mockGetSyncTransportStatus.mock.calls.length).toBeGreaterThan(repeatedListenerStatusCalls),
    );
    await act(async () => {});

    expectProjectDataQueriesNotInvalidated(queryClient, projectId);
  });

  it("busy preflight shows job counts while allowing sync now", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setJobs([
      job({
        id: "job_running_analyze",
        type: "analyze",
        status: "running",
        progress: 25,
        started_at: "2026-04-18T13:15:00.000Z",
      }),
      job({
        id: "job_pending_stems",
        type: "stems",
        status: "pending",
        progress: 0,
      }),
    ]);
    await openSyncTab(user);

    const preflightSection = await screen.findByRole("heading", { name: "Local Readiness" });
    const readiness = preflightSection.closest("section");
    expect(readiness).not.toBeNull();
    expect(within(readiness as HTMLElement).getByText("Ready With Jobs")).toBeInTheDocument();
    expect(within(readiness as HTMLElement).getAllByText(/2 blocking jobs \(1 running, 1 pending\)\./)).not.toHaveLength(0);
    expect(within(readiness as HTMLElement).getByText("1 analyze, 1 stems")).toBeInTheDocument();
    mockGetSyncPreflight.mockClear();
    mockSyncTrustedPeerNow.mockClear();

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockGetSyncPreflight).toHaveBeenCalled());
    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText(defaultSyncNowCanonicalSummary)).not.toHaveLength(0);
    expect(screen.queryByText("Manifest exchange completed with 4 project results.")).not.toBeInTheDocument();
  });

  it("hides preflight job details and cancel controls while showing compact job summary", async () => {
    const user = userEvent.setup();
    setJobs([
      job({
        id: "job_pending",
        type: "analyze",
        status: "pending",
        progress: 0,
      }),
    ]);
    await openSyncTab(user);

    const preflightSection = screen.getByRole("heading", { name: "Local Readiness" }).closest("section");
    expect(preflightSection).not.toBeNull();
    expect(within(preflightSection as HTMLElement).getByText("Ready With Jobs")).toBeInTheDocument();
    expect(within(preflightSection as HTMLElement).getAllByText(/1 blocking job \(1 pending\)\./)).not.toHaveLength(0);
    expect(within(preflightSection as HTMLElement).getByText("1 analyze")).toBeInTheDocument();
    expect(
      within(preflightSection as HTMLElement).queryByRole("list", { name: "Sync preflight blocking jobs" }),
    ).not.toBeInTheDocument();
    expect(within(preflightSection as HTMLElement).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(mockCancelJob).not.toHaveBeenCalled();
  });

  it("marks truncated preflight job type summaries as samples", async () => {
    const user = userEvent.setup();
    setSyncPreflight(syncPreflight({
      job_state: {
        state: "busy",
        running_job_count: 0,
        pending_job_count: 25,
        blocking_job_count: 25,
        blocking_job_counts: { running: 0, pending: 25 },
        blocking_jobs: Array.from({ length: 20 }, (_, index) => ({
          id: `job_export_${index + 1}`,
          project_id: `proj_${index + 1}`,
          project_name: `Export Song ${index + 1}`,
          type: "export",
          status: "pending",
          progress: 0,
          started_at: null,
          updated_at: "2026-04-18T13:16:00.000Z",
        })),
        blocking_jobs_truncated: true,
        guidance: [],
      },
    }));
    await openSyncTab(user);

    const preflightSection = screen.getByRole("heading", { name: "Local Readiness" }).closest("section");
    expect(preflightSection).not.toBeNull();
    expect(within(preflightSection as HTMLElement).getByText("Ready With Jobs")).toBeInTheDocument();
    expect(within(preflightSection as HTMLElement).getAllByText(/25 blocking jobs \(25 pending\)\./)).not.toHaveLength(0);
    expect(
      within(preflightSection as HTMLElement).getByText("sample: 20 export (first 20 jobs shown)"),
    ).toBeInTheDocument();
    expect(
      within(preflightSection as HTMLElement).queryByRole("list", { name: "Sync preflight blocking jobs" }),
    ).not.toBeInTheDocument();
  });

  it("shows library preflight failures before sync now", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncPreflight(syncPreflight({
      ok: false,
      library_ok: false,
      total_projects: 1,
      ready_projects: 0,
      missing_source_hash_projects: 1,
      manual_cleanup_required: true,
      manual_cleanup_guidance: [
        "Restore the original source file or re-import affected projects so TuneForge can compute source hashes.",
      ],
    }));
    await openSyncTab(user);

    expect(await screen.findAllByText(/Library preflight failed: 1 missing source hash project\./)).not.toHaveLength(0);
    mockGetSyncPreflight.mockClear();
    mockSyncTrustedPeerNow.mockClear();

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockGetSyncPreflight).toHaveBeenCalled());
    expect(mockSyncTrustedPeerNow).not.toHaveBeenCalled();
    expect(
      await screen.findAllByText(/Sync now failed: Library preflight failed: 1 missing source hash project\./),
    ).not.toHaveLength(0);
  });

  it("shows listener-side sync project results from native status", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_status: "Sync session completed without structured details.",
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        selected_transport: irohTransportId,
        status: "completed_with_errors",
        message:
          "Exchanged 0 local and 2 remote manifest(s); imported 0 project(s), skipped 0 project(s), failed 2 project(s), received 16 artifact(s).",
        project_results: [
          {
            project_id: "proj_conflicted",
            status: "conflicted",
            message: "Entity revision manifest content_sha256 must match payload.",
          },
        ],
        project_results_complete: true,
        manifest_errors: [],
        manifest_errors_complete: true,
        received_artifacts: [],
        received_artifacts_complete: true,
        served_artifact_requests: 0,
        local_manifest_count: 0,
        remote_manifest_count: 2,
      },
    });

    await openSyncTab(user);

    expect(await screen.findByText(canonicalSummary({ local: 0, remote: 2, conflicted: 1 }))).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Exchanged 0 local and 2 remote manifest(s); imported 0 project(s), skipped 0 project(s), failed 2 project(s), received 16 artifact(s).",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Transport Iroh/)).toBeInTheDocument();
    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(1);
    expect(within(resultRows[0]).getByText("Conflicted")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("proj_conflicted")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("Entity revision manifest content_sha256 must match payload.")).toBeInTheDocument();
  });

  it("shows partial planner failures from native status without transport fallback", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        selected_transport: irohTransportId,
        status: "completed_with_errors",
        imported_project_count: 1,
        skipped_project_count: 0,
        failed_project_count: 1,
        project_results: [
          {
            project_id: "proj_planner_failed",
            status: "failed",
            message: "Sync transport reconciliation plan failed for project proj_planner_failed.",
          },
          {
            project_id: "proj_imported",
            status: "imported",
            message: "Imported from trusted peer.",
          },
        ],
        project_results_complete: true,
        manifest_errors: [],
        manifest_errors_complete: true,
        received_artifacts: [],
        received_artifacts_complete: true,
      },
    });

    await openSyncTab(user);

    expect(await screen.findByText(canonicalSummary({ imported: 1, failed: 1 }))).toBeInTheDocument();
    expect(screen.getByText(/Transport Iroh/)).toBeInTheDocument();
    expect(screen.getByText(/1 imported, 0 applied, 0 deleted, 0 skipped, 0 conflicted, 1 failed/)).toBeInTheDocument();
    expect(screen.queryByText(/Fallback/)).not.toBeInTheDocument();

    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(2);
    expect(within(resultRows[0]).getByText("Failed")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("proj_planner_failed")).toBeInTheDocument();
    expect(
      within(resultRows[0]).getByText("Sync transport reconciliation plan failed for project proj_planner_failed."),
    ).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Imported")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("proj_imported")).toBeInTheDocument();
  });

  it("hides stale listener sync details after sync now fails", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        selected_transport: tcpTransportId,
        fallback_reason: "Iroh endpoint was unavailable; used TCP.",
        attempted_transports: [irohTransportId, tcpTransportId],
        status: "completed",
        message: "Listener import completed before failed sync now.",
        project_results: [
          {
            project_id: "proj_listener_previous",
            status: "imported",
            message: "Previous listener result.",
          },
        ],
        project_results_complete: true,
        manifest_errors: [],
        manifest_errors_complete: true,
        received_artifacts: [],
        received_artifacts_complete: true,
      },
    });
    const safeFailure = "artifact_transfer: Timed out reading from Iroh sync stream; " +
      "checksum_mismatch hash_retry_pending sha256_mismatch.";
    mockSyncTrustedPeerNow.mockRejectedValueOnce(safeFailure);

    await openSyncTab(user);

    expect(await screen.findByText(importedNoRemoteCanonicalSummary)).toBeInTheDocument();
    expect(screen.getByText("proj_listener_previous")).toBeInTheDocument();

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(
      await screen.findAllByText(`Sync now failed: ${safeFailure}`),
    ).not.toHaveLength(0);
    expect(screen.queryByText("Listener import completed before failed sync now.")).not.toBeInTheDocument();
    expect(screen.queryByText("Previous listener result.")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Last sync project evidence" })).not.toBeInTheDocument();
  });

  it("enables evidence actions from failed listener last_sync after sync now rejects", async () => {
    const user = userEvent.setup();
    const error =
      "Sync transport reconciliation staging failed: Could not write sync transport frame: connection lost";
    const failedLastSync = syncRunStatus({
      run_id: "sync_run_failed_evidence",
      peer_device_id: "device_peer_1",
      remote_device_id: "device_peer_1",
      selected_transport: tcpTransportId,
      attempted_transports: [tcpTransportId],
      status: "failed",
      message: `Sync now failed: ${error}`,
      started_at: "2026-04-18T13:16:00.000Z",
      completed_at: "2026-04-18T13:16:02.000Z",
      duration_ms: 2000,
      served_artifact_requests: 0,
      local_manifest_count: 4,
      remote_manifest_count: 5,
      received_artifacts: [
        {
          artifact_id: "art_partial",
          content_sha256: "sha256-partial",
          size_bytes: 42,
          status: "received",
          message: "Received before connection lost.",
          duration_ms: 1000,
          throughput_bytes_per_second: 42,
        },
      ],
    });
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: null,
      last_error: null,
    });
    mockSyncTrustedPeerNow.mockImplementationOnce(async () => {
      setSyncTransportStatus({
        last_status: `Sync now failed: ${error}`,
        last_error: `Sync now failed: ${error}`,
        last_sync: failedLastSync,
        updated_at: "2026-04-18T13:16:02.000Z",
      });
      throw error;
    });

    await openSyncTab(user);

    expect(screen.getByRole("button", { name: "Copy Evidence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export Evidence" })).toBeDisabled();

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(
      await screen.findAllByText(`Sync now failed: ${error}`),
    ).not.toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy Evidence" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Export Evidence" })).toBeEnabled();
    });
    expect(screen.getByRole("list", { name: "Last sync artifact transfers" })).toBeInTheDocument();
  });

  it("sanitizes raw passive listener last_error details", async () => {
    const user = userEvent.setup();
    const privateValues = [
      "/Users/test/Music/Passive Secret.wav",
      "proj_passive_secret",
      "tuneforge-sync+tcp://192.0.2.8:47619",
      "checksum_deadbeefcafebabe",
      "checksum_mismatch_shadow",
      "hash_retry_pending_shadow",
      "sha256_mismatch_shadow",
      "content_sha256_deadbeefcafebabefeedface01234567",
      "content.hash_deadbeefcafebabefeedface01234567",
      "content-hash_deadbeefcafebabefeedface01234567",
      "abcdefabcdefabcdefabcdefabcdefab_checksum_mismatch",
    ];
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_error: `Sync transport artifact request/transfer failed: ${privateValues.join(" ")}`,
      last_sync: null,
    });

    await openSyncTab(user);

    expect(await screen.findByText("Sync transport artifact request/transfer failed: details redacted."))
      .toBeInTheDocument();
    const visibleText = document.body.textContent ?? "";
    privateValues.forEach((privateValue) => expect(visibleText).not.toContain(privateValue));
  });

  it("sanitizes raw sync now rejection before rendering failed listener evidence", async () => {
    const user = userEvent.setup();
    const rawPath = "/Users/test/Music/Secret Reject Demo.wav";
    const rawEndpoint = "tuneforge-sync+tcp://192.0.2.2:47619";
    const rawDeviceId = "device_secret_reject";
    const rawProjectId = "proj_secret_reject";
    const rawHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const rawError = [
      "Sync transport artifact request/transfer failed: Could not read",
      rawPath,
      "from",
      rawDeviceId,
      "for",
      rawProjectId,
      "via",
      rawEndpoint,
      "with content_sha256",
      rawHash,
    ].join(" ");
    const safeMessage =
      "Sync now failed: Sync transport artifact request/transfer failed: details redacted.";
    const failedLastSync = syncRunStatus({
      run_id: "sync_run_sanitized_failure",
      peer_device_id: "device_peer_1",
      remote_device_id: "device_peer_1",
      selected_transport: tcpTransportId,
      attempted_transports: [tcpTransportId],
      status: "failed",
      message: safeMessage,
      started_at: "2026-04-18T13:16:00.000Z",
      completed_at: "2026-04-18T13:16:02.000Z",
      duration_ms: 2000,
      served_artifact_requests: 0,
      local_manifest_count: 4,
      remote_manifest_count: 5,
      received_artifacts: [
        {
          artifact_id: "art_visible_failure",
          content_sha256: "sha256-visible-failure",
          size_bytes: 42,
          status: "received",
          message: "Received before sanitized hard failure.",
          duration_ms: 1000,
          throughput_bytes_per_second: 42,
        },
      ],
    });
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: null,
      last_error: null,
    });
    mockSyncTrustedPeerNow.mockImplementationOnce(async () => {
      setSyncTransportStatus({
        last_status: safeMessage,
        last_error: safeMessage,
        last_sync: failedLastSync,
        updated_at: "2026-04-18T13:16:02.000Z",
      });
      throw rawError;
    });

    await openSyncTab(user);

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText(safeMessage)).not.toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy Evidence" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Export Evidence" })).toBeEnabled();
    });
    const visibleText = document.body.textContent ?? "";
    [rawPath, "Secret Reject Demo.wav", rawEndpoint, "192.0.2.2", rawDeviceId, rawProjectId, rawHash]
      .forEach((rawValue) => {
        expect(visibleText).not.toContain(rawValue);
      });

    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    const serialized = JSON.stringify(exportedJson);
    [rawPath, "Secret Reject Demo.wav", rawEndpoint, "192.0.2.2", rawDeviceId, rawProjectId, rawHash]
      .forEach((rawValue) => {
        expect(serialized).not.toContain(rawValue);
      });
  });

  it("sanitizes backend body keys in raw sync now rejection text", async () => {
    const user = userEvent.setup();
    const rawProject = "PlainProjectAlpha";
    const rawArtifact = "PlainArtifactBeta";
    const rawDevice = "PlainDeviceGamma";
    const rawEndpoint = "PlainEndpointDelta";
    const rawError = [
      "Backend response body:",
      "project_id",
      rawProject,
      "artifactId",
      rawArtifact,
      "deviceId",
      rawDevice,
      "endpointHints",
      rawEndpoint,
    ].join(" ");
    const safeMessage = "Sync now failed: Sync transport failed: details redacted.";
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: null,
      last_error: null,
    });
    mockSyncTrustedPeerNow.mockRejectedValueOnce(rawError);

    await openSyncTab(user);

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText(safeMessage)).not.toHaveLength(0);
    const visibleText = document.body.textContent ?? "";
    [rawProject, rawArtifact, rawDevice, rawEndpoint].forEach((rawValue) => {
      expect(visibleText).not.toContain(rawValue);
    });
  });

  it("normalizes sync run identity, timing, counters, and final project rows", () => {
    const normalized = normalizeSyncTransportStatus({
      running: true,
      state: "listening",
      endpointHints: syncEndpointHints,
      fallbackCode: "iroh_unavailable",
      active_run_id: "sync_run_active_1",
      active_phase: "artifact_transfer",
      active_message: "Receiving source audio.",
      progress_at: "2026-04-18 13:16:00",
      elapsed_ms: 1500,
      nearbyPeers: [
        {
          deviceId: "device_peer_1",
          displayName: "Laptop Rig",
          publicKey: "pub_peer_1",
          shortFingerprint: "A1B2-C3D4-E5F6-7890",
          trustStatus: "match",
          endpointHints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
          lastSeenAt: "2026-04-18 13:17:00",
        },
      ],
      lastSync: {
        runId: "sync_run_retry_2",
        sessionId: "sync_session_retry_2",
        peerDeviceId: "device_peer_1",
        remoteDeviceId: "device_peer_1",
        selectedTransport: tcpTransportId,
        fallbackReason: "Iroh endpoint was unavailable; used TCP.",
        fallbackCode: "stale_iroh_hint",
        attemptedTransports: [irohTransportId, tcpTransportId],
        status: "completed_with_errors",
        message: "Retry completed after staged bytes were reused.",
        startedAt: "2026-04-18 13:16:00",
        completedAt: "2026-04-18T13:16:01.250Z",
        durationMs: 1250,
        timing: {
          planningMs: 10,
          transferMs: 25,
          applyMs: 30,
        },
        phaseTimings: [
          {
            phase: "artifact_transfer",
            artifactId: "art_retry_source",
            startedAt: "2026-04-18T13:16:00.150Z",
            completedAt: "2026-04-18T13:16:00.650Z",
            durationMs: 500,
          },
        ],
        totalReceivedBytes: 3_000_000,
        totalServedBytes: 1_000_000,
        timeToFirstArtifactMs: 650,
        throughputBytesPerSecond: 3_200_000,
        importedProjectCount: 1,
        skippedProjectCount: 1,
        failedProjectCount: 0,
        projectResults: [
          {
            projectId: "proj_retry",
            status: "failed",
            message: "Old ffprobe failure.",
            isFinal: true,
            completedAt: "2026-04-18T13:15:00.000Z",
            failedCount: 1,
          },
          {
            projectId: "proj_retry",
            status: "applied",
            message: "Retry imported the project.",
            isFinal: true,
            completedAt: "2026-04-18T13:16:01.000Z",
            appliedCount: 3,
            satisfiedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            reusedArtifactCount: 2,
          },
          {
            projectId: "proj_deleted",
            status: "deleted",
            message: "Delete tombstone caught up.",
            isFinal: true,
            deletedCount: 1,
          },
        ],
        manifestErrors: [
          {
            projectId: "proj_retry",
            message: "Local manifest export failed: Old ffprobe failure.",
          },
          {
            projectId: "proj_deleted",
            message: "Peer manifest export failed: stale tombstone warning.",
          },
        ],
        receivedArtifacts: [
          {
            artifactId: "art_retry_source",
            contentSha256: "sha256-retry-source",
            sizeBytes: 1_000_000,
            status: "received",
            startedAt: "2026-04-18T13:16:00.150Z",
            completedAt: "2026-04-18T13:16:00.650Z",
            durationMs: 500,
            throughputBytesPerSecond: 2_000_000,
          },
          {
            artifactId: "art_reused_source",
            contentSha256: "sha256-reused-source",
            sizeBytes: 500_000,
            status: "already_staged",
            completedAt: "2026-04-18T13:16:00.100Z",
          },
        ],
      },
    });

    expect(normalized.last_sync).toMatchObject({
      run_id: "sync_run_retry_2",
      session_id: "sync_session_retry_2",
      selected_transport: "tcp",
      fallback_reason: "Iroh endpoint was unavailable; used TCP.",
      fallback_code: "stale_iroh_hint",
      attempted_transports: ["iroh", "tcp"],
      status: "completed_with_errors",
      started_at: "2026-04-18T13:16:00.000Z",
      duration_ms: 1250,
      total_received_bytes: 3_000_000,
      total_served_bytes: 1_000_000,
      time_to_first_artifact_ms: 650,
      throughput_bytes_per_second: 3_200_000,
      imported_project_count: 0,
      applied_project_count: 1,
      deleted_project_count: 1,
      skipped_project_count: 0,
      failed_project_count: 0,
    });
    expect(normalized.endpoint_hints).toEqual(syncEndpointHints);
    expect(normalized.fallback_code).toBe("iroh_unavailable");
    expect(normalized.active_run_id).toBe("sync_run_active_1");
    expect(normalized.active_phase).toBe("artifact_transfer");
    expect(normalized.active_message).toBe("Receiving source audio.");
    expect(normalized.active_progress_at).toBe("2026-04-18T13:16:00.000Z");
    expect(normalized.active_elapsed_ms).toBe(1500);
    expect(normalized.nearby_peers).toEqual([
      expect.objectContaining({
        device_id: "device_peer_1",
        display_name: "Laptop Rig",
        short_fingerprint: "A1B2-C3D4-E5F6-7890",
        trust_status: "match",
        endpoint_hints: [nearbyIrohEndpointHint, nearbyTcpEndpointHint],
        last_seen_at: "2026-04-18T13:17:00.000Z",
      }),
    ]);
    expect(normalized.last_sync?.timing).toEqual({
      planningMs: 10,
      transferMs: 25,
      applyMs: 30,
    });
    expect(normalized.last_sync?.phase_timings).toEqual([
      expect.objectContaining({
        phase: "artifact_transfer",
        artifact_id: "art_retry_source",
        duration_ms: 500,
      }),
    ]);
    expect(normalized.last_sync?.received_artifacts).toEqual([
      expect.objectContaining({
        artifact_id: "art_retry_source",
        started_at: "2026-04-18T13:16:00.150Z",
        completed_at: "2026-04-18T13:16:00.650Z",
        duration_ms: 500,
        throughput_bytes_per_second: 2_000_000,
      }),
      expect.objectContaining({
        artifact_id: "art_reused_source",
        status: "already_staged",
        completed_at: "2026-04-18T13:16:00.100Z",
      }),
    ]);
    expect(normalized.last_sync?.project_results).toHaveLength(2);
    expect(normalized.last_sync?.project_results[0]).toMatchObject({
      project_id: "proj_retry",
      status: "applied",
      applied_count: 3,
      satisfied_count: 1,
      skipped_count: 0,
      failed_count: 0,
      reused_artifact_count: 2,
    });
    expect(normalized.last_sync?.project_results[1]).toMatchObject({
      project_id: "proj_deleted",
      status: "deleted",
      deleted_count: 1,
    });
  });

  it("normalizes legacy failed counts without hiding conflicted projects", () => {
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      lastSync: {
        localManifestCount: 1,
        remoteManifestCount: 1,
        skippedProjectCount: 1,
        failedProjectCount: 2,
        projectResults: [
          {
            projectId: "proj_conflicted_legacy",
            status: "conflicted",
            message: "Local lyrics conflict with the trusted peer revision.",
          },
          {
            projectId: "proj_failed_legacy",
            status: "failed",
            message: "Peer manifest export failed before transfer.",
          },
          {
            projectId: "proj_skipped_legacy",
            status: "skipped",
            message: "Already up to date.",
          },
        ],
        manifestErrors: [],
        receivedArtifacts: [],
      },
    });

    expect(normalized.last_sync).toMatchObject({
      skipped_project_count: 1,
      conflicted_project_count: 1,
      failed_project_count: 1,
      message:
        canonicalSummary({ local: 1, remote: 1, skipped: 1, conflicted: 1, failed: 1 }),
    });
    expect(normalized.last_sync?.project_results).toEqual([
      expect.objectContaining({ project_id: "proj_conflicted_legacy", status: "conflicted" }),
      expect.objectContaining({ project_id: "proj_failed_legacy", status: "failed" }),
      expect.objectContaining({ project_id: "proj_skipped_legacy", status: "skipped" }),
    ]);
  });

  it.each([
    { label: "failed", inputStatus: undefined, expectedStatus: "completed_with_errors",
      counts: { failed_project_count: 2, total_project_count: 2 }, expectedMap: { failed: 2 } },
    { label: "conflicted", inputStatus: "completed_with_errors", expectedStatus: "completed_with_errors",
      counts: { conflicted_project_count: 1, total_project_count: 1 }, expectedMap: { conflicted: 1 } },
    { label: "skipped", inputStatus: "completed", expectedStatus: "completed",
      counts: { skipped_project_count: 3, total_project_count: 3 }, expectedMap: { skipped: 3 } },
    {
      label: "no-op",
      inputStatus: "completed",
      expectedStatus: "completed",
      counts: { imported_project_count: 0, applied_project_count: 0, deleted_project_count: 0,
        skipped_project_count: 0, conflicted_project_count: 0, failed_project_count: 0, total_project_count: 0 },
      expectedMap: {},
    },
  ])("normalizes no-row aggregate $label accounting", ({ inputStatus, expectedStatus, counts, expectedMap }) => {
    const lastSync = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        status: inputStatus,
        received_artifacts: [],
        ...counts,
      },
    }).last_sync;

    expect(lastSync?.status).toBe(expectedStatus);
    expect(syncRunCanonicalCounts(lastSync!)?.projectResultsByStatus).toEqual(expectedMap);
  });

  it("requests auto transport for native sync now runs and normalizes native Iroh IDs", async () => {
    const actualApi = await vi.importActual<typeof import("./lib/api")>("./lib/api");
    type TauriInternals = {
      invoke: (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    };
    const nativeInvoke = getMockInvoke();
    nativeInvoke.mockResolvedValueOnce({
      status: "completed",
      selectedTransport: irohTransportId,
      fallbackReason: null,
      attemptedTransports: [irohTransportId],
      projectResults: [],
      manifestErrors: [],
      receivedArtifacts: [],
    });
    (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command, args) => nativeInvoke(command, args),
    };

    await expect(actualApi.api.syncTrustedPeerNow("device_peer_1")).resolves.toMatchObject({
      selected_transport: "iroh",
      fallback_reason: null,
      attempted_transports: ["iroh"],
      status: "completed",
    });
    expect(nativeInvoke).toHaveBeenCalledWith(
      "sync_transport_sync_now",
      { payload: { peerDeviceId: "device_peer_1", preferredTransport: "auto" } },
    );
  });

  it("normalizes direct native sync planner failures as partial errors", async () => {
    const actualApi = await vi.importActual<typeof import("./lib/api")>("./lib/api");
    type TauriInternals = {
      invoke: (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    };
    const nativeInvoke = getMockInvoke();
    nativeInvoke.mockResolvedValueOnce({
      peerDeviceId: "device_peer_1",
      selectedTransport: irohTransportId,
      status: "completed_with_errors",
      importedProjectCount: 1,
      skippedProjectCount: 0,
      failedProjectCount: 1,
      projectResults: [
        {
          projectId: "proj_planner_failed",
          status: "failed",
          message: "Sync transport reconciliation plan failed for project proj_planner_failed.",
        },
        {
          projectId: "proj_imported",
          status: "imported",
          message: "Imported from trusted peer.",
        },
      ],
      manifestErrors: [],
      receivedArtifacts: [],
    });
    (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command, args) => nativeInvoke(command, args),
    };

    await expect(actualApi.api.syncTrustedPeerNow("device_peer_1")).resolves.toMatchObject({
      peer_device_id: "device_peer_1",
      selected_transport: "iroh",
      fallback_code: null,
      status: "completed_with_errors",
      imported_project_count: 1,
      skipped_project_count: 0,
      failed_project_count: 1,
      project_results: [
        expect.objectContaining({
          project_id: "proj_planner_failed",
          status: "failed",
          message: "Sync transport reconciliation plan failed for project proj_planner_failed.",
        }),
        expect.objectContaining({
          project_id: "proj_imported",
          status: "imported",
          message: "Imported from trusted peer.",
        }),
      ],
    });
    expect(nativeInvoke).toHaveBeenCalledWith(
      "sync_transport_sync_now",
      { payload: { peerDeviceId: "device_peer_1", preferredTransport: "auto" } },
    );
  });

  it("infers sync TTFA only when native omits the metric", () => {
    const explicitNull = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        started_at: "2026-04-18T13:16:00.000Z",
        time_to_first_artifact_ms: null,
        received_artifacts: [
          {
            artifact_id: "art_received_source",
            status: "received",
            completed_at: "2026-04-18T13:16:00.500Z",
          },
        ],
      },
    });

    expect(explicitNull.last_sync?.time_to_first_artifact_ms).toBeNull();

    const legacyPayload = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        started_at: "2026-04-18T13:16:00.000Z",
        received_artifacts: [
          {
            artifact_id: "art_already_staged",
            status: "already_staged",
            completed_at: "2026-04-18T13:16:00.200Z",
          },
          {
            artifact_id: "art_received_source",
            status: "received",
            completed_at: "2026-04-18T13:16:00.800Z",
          },
        ],
        phase_timings: [
          {
            phase: "artifact_transfer",
            artifact_id: "art_already_staged",
            completed_at: "2026-04-18T13:16:00.200Z",
          },
          {
            phase: "artifact_transfer",
            artifact_id: "art_received_source",
            completed_at: "2026-04-18T13:16:00.800Z",
          },
        ],
      },
    });

    expect(legacyPayload.last_sync?.time_to_first_artifact_ms).toBe(800);
  });

  it("counts only successful received artifact rows in canonical summaries", () => {
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        local_manifest_count: 1,
        remote_manifest_count: 1,
        imported_project_count: 0,
        applied_project_count: 0,
        deleted_project_count: 0,
        skipped_project_count: 0,
        conflicted_project_count: 0,
        failed_project_count: 1,
        received_artifacts: [
          { artifact_id: "art_received", status: "received" },
          { artifact_id: "art_failed", status: "failed" },
          { artifact_id: "art_reused", status: "already_staged" },
        ],
      },
    });

    expect(normalized.last_sync?.message).toContain(
      "transfers: received 1, reused/already staged 1, failed 1",
    );
  });

  it("normalizes Iroh flow-control evidence from snake and camel metrics", () => {
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      lastSync: {
        selectedTransport: irohTransportId,
        status: "completed",
        scratchPeakBytes: 128_000_000,
        credit_wait_ms_total: 42,
        credit_wait_ms_max: 40,
        credit_wait_events: 2,
        credit_hold_ms_total: 80,
        credit_hold_ms_max: 50,
        stage_queue_wait_ms_total: 9,
        stage_queue_wait_ms_max: 6,
        stage_queue_wait_events: 3,
        stream_open_ms_total: 5,
        stream_open_ms_max: 4,
        stream_open_events: 2,
        sender_write_ms_total: 120,
        sender_write_ms_max: 70,
        sender_write_events: 4,
        receiver_read_ms_total: 130,
        receiver_read_ms_max: 90,
        receiver_read_events: 5,
        receiver_hash_ms_total: 11,
        receiver_hash_ms_max: 5,
        receiver_hash_events: 5,
        receiver_temp_write_ms_total: 39,
        receiver_temp_write_ms_max: 12,
        receiver_temp_write_events: 5,
        staging_post_ms_total: 300,
        staging_post_ms_max: 200,
        staging_post_events: 2,
        transferCounts: {
          staging_peak_bytes: 16_000_000,
          maxActiveStreams: 8,
          credit_grants: 64,
          creditRevokes: 2,
        },
        projectResults: [],
        manifestErrors: [],
        receivedArtifacts: [],
      },
    });

    expect(normalized.last_sync).toMatchObject({
      selected_transport: "iroh",
      scratch_peak_bytes: 128_000_000,
      staging_peak_bytes: 16_000_000,
      max_active_streams: 8,
      credit_grants: 64,
      credit_revokes: 2,
      credit_wait_ms_total: 42,
      credit_wait_ms_max: 40,
      credit_wait_events: 2,
      credit_hold_ms_total: 80,
      credit_hold_ms_max: 50,
      stage_queue_wait_ms_total: 9,
      stage_queue_wait_ms_max: 6,
      stage_queue_wait_events: 3,
      stream_open_ms_total: 5,
      stream_open_ms_max: 4,
      stream_open_events: 2,
      sender_write_ms_total: 120,
      sender_write_ms_max: 70,
      sender_write_events: 4,
      receiver_read_ms_total: 130,
      receiver_read_ms_max: 90,
      receiver_read_events: 5,
      receiver_hash_ms_total: 11,
      receiver_hash_ms_max: 5,
      receiver_hash_events: 5,
      receiver_temp_write_ms_total: 39,
      receiver_temp_write_ms_max: 12,
      receiver_temp_write_events: 5,
      staging_post_ms_total: 300,
      staging_post_ms_max: 200,
      staging_post_events: 2,
      transfer_counts: {
        scratch_peak_bytes: 128_000_000,
        staging_peak_bytes: 16_000_000,
        max_active_streams: 8,
        credit_grants: 64,
        credit_revokes: 2,
        credit_wait_ms_total: 42,
        credit_wait_ms_max: 40,
        credit_wait_events: 2,
        credit_hold_ms_total: 80,
        credit_hold_ms_max: 50,
        stage_queue_wait_ms_total: 9,
        stage_queue_wait_ms_max: 6,
        stage_queue_wait_events: 3,
        stream_open_ms_total: 5,
        stream_open_ms_max: 4,
        stream_open_events: 2,
        sender_write_ms_total: 120,
        sender_write_ms_max: 70,
        sender_write_events: 4,
        receiver_read_ms_total: 130,
        receiver_read_ms_max: 90,
        receiver_read_events: 5,
        receiver_hash_ms_total: 11,
        receiver_hash_ms_max: 5,
        receiver_hash_events: 5,
        receiver_temp_write_ms_total: 39,
        receiver_temp_write_ms_max: 12,
        receiver_temp_write_events: 5,
        staging_post_ms_total: 300,
        staging_post_ms_max: 200,
        staging_post_events: 2,
      },
    });
  });

  it("keeps newer successful sync rows when stale failures arrive later in the payload", () => {
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        run_id: "sync_retry_latest",
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        completed_at: "2026-04-18T13:16:02.000Z",
        project_results: [
          {
            project_id: "proj_retry",
            status: "applied",
            message: "Retry imported the project.",
            is_final: true,
            completed_at: "2026-04-18T13:16:01.000Z",
          },
          {
            project_id: "proj_retry",
            status: "failed",
            message: "Old ffprobe failure.",
            is_final: true,
            run_id: "sync_retry_old",
            completed_at: "2026-04-18T13:15:00.000Z",
          },
        ],
        manifest_errors: [],
        received_artifacts: [],
      },
    });

    expect(normalized.last_sync?.project_results).toEqual([
      expect.objectContaining({
        project_id: "proj_retry",
        status: "applied",
        message: "Retry imported the project.",
      }),
    ]);
  });

  it("keeps manifest errors as project rows only when no final project result exists", () => {
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        project_results: [
          {
            project_id: "proj_staging",
            status: "staging",
            message: "Receiving project artifacts.",
            is_final: false,
          },
        ],
        manifest_errors: [
          {
            project_id: "proj_staging",
            message: "Peer manifest export failed before apply.",
          },
        ],
        received_artifacts: [],
      },
    });

    expect(normalized.last_sync?.status).toBe("completed_with_errors");
    expect(normalized.last_sync?.failed_project_count).toBe(0);
    expect(normalized.last_sync?.manifest_export_error_count).toBe(1);
    expect(normalized.last_sync?.message).toContain(
      "manifest export errors (separate from final project outcomes): 1",
    );
    expect(mergeSyncProjectResults(
      normalized.last_sync?.project_results ?? [],
      normalized.last_sync?.manifest_errors ?? [],
    )).toEqual([
      expect.objectContaining({
        project_id: "proj_staging",
        status: "manifest_export_error",
        message: "Peer manifest export failed before apply.",
      }),
    ]);
  });

  it("preserves unknown legacy sync accounting instead of fabricating zero counts", () => {
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      last_sync: {
        status: "completed",
        message: "Legacy sync completed.",
        local_manifest_count: 1,
      },
    });
    const lastSync = normalized.last_sync;

    expect(lastSync).not.toBeNull();
    expect(lastSync).toMatchObject({
      project_results_complete: false,
      manifest_errors_complete: false,
      received_artifacts_complete: false,
      imported_project_count: null,
      failed_project_count: null,
      manifest_export_error_count: null,
      message: "Legacy sync completed.",
    });
    expect(syncRunCanonicalCounts(lastSync!)).toMatchObject({
      importedProjectCount: null,
      failedProjectCount: null,
      receivedArtifactCount: null,
      reusedArtifactCount: null,
      failedTransferCount: null,
      manifestExportErrorCount: null,
      totalProjectCount: null,
      hasCompleteTransferEvidence: false,
    });
  });

  it("shows final retry and delete catch-up rows without obsolete failures", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: {
        run_id: "sync_run_retry_2",
        session_id: "sync_session_retry_2",
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        selected_transport: tcpTransportId,
        fallback_reason: "Iroh endpoint was unavailable; used TCP.",
        attempted_transports: [irohTransportId, tcpTransportId],
        status: "completed",
        message: "Retry completed after staged bytes were reused.",
        started_at: "2026-04-18T13:16:00.000Z",
        completed_at: "2026-04-18T13:16:01.400Z",
        duration_ms: 1400,
        phase_timings: [
          {
            phase: "artifact_transfer",
            duration_ms: 500,
          },
          {
            phase: "backend_staging",
            duration_ms: 900,
          },
        ],
        time_to_first_artifact_ms: 450,
        total_received_bytes: 3_000_000,
        total_served_bytes: 1_000_000,
        throughput_bytes_per_second: 2_500_000,
        scratch_peak_bytes: 64_000_000,
        transfer_counts: {
          staging_peak_bytes: 12_000_000,
          max_active_streams: 8,
          credit_grants: 64,
          credit_revokes: 2,
          credit_wait_ms_total: 42,
          credit_wait_ms_max: 40,
          credit_wait_events: 2,
          credit_hold_ms_total: 80,
          credit_hold_ms_max: 50,
          stage_queue_wait_ms_total: 9,
          stage_queue_wait_ms_max: 6,
          stage_queue_wait_events: 3,
          stream_open_ms_total: 5,
          stream_open_ms_max: 4,
          stream_open_events: 2,
          sender_write_ms_total: 120,
          sender_write_ms_max: 70,
          sender_write_events: 4,
          receiver_read_ms_total: 130,
          receiver_read_ms_max: 90,
          receiver_read_events: 5,
          receiver_hash_ms_total: 11,
          receiver_hash_ms_max: 5,
          receiver_hash_events: 5,
          receiver_temp_write_ms_total: 39,
          receiver_temp_write_ms_max: 12,
          receiver_temp_write_events: 5,
          staging_post_ms_total: 300,
          staging_post_ms_max: 200,
          staging_post_events: 2,
        },
        imported_project_count: 1,
        skipped_project_count: 1,
        failed_project_count: 0,
        project_results: [
          {
            project_id: "proj_retry",
            status: "failed",
            message: "Old ffprobe failure.",
            is_final: true,
          },
          {
            project_id: "proj_retry",
            status: "applied",
            message: "Retry imported the project.",
            is_final: true,
            applied_count: 3,
            satisfied_count: 1,
            skipped_count: 0,
            failed_count: 0,
          },
          {
            project_id: "proj_deleted",
            status: "deleted",
            message: "Delete tombstone caught up.",
            is_final: true,
            deleted_count: 1,
          },
        ],
        manifest_errors: [
          {
            project_id: "proj_retry",
            message: "Local manifest export failed: Old ffprobe failure.",
          },
          {
            project_id: "proj_deleted",
            message: "Peer manifest export failed: stale tombstone warning.",
          },
        ],
        received_artifacts: [
          {
            artifact_id: "art_retry_source",
            content_sha256: "sha256-retry-source",
            size_bytes: 1_000_000,
            status: "received",
            duration_ms: 500,
            throughput_bytes_per_second: 2_000_000,
          },
        ],
      },
    });

    await openSyncTab(user);

    expect(
      await screen.findByText(canonicalSummary({ applied: 1, deleted: 1, received: 1, manifestErrors: 2 })),
    ).toBeInTheDocument();
    expect(screen.getByText(/Run sync_run_retry_2/)).toBeInTheDocument();
    expect(screen.getByText(/Duration 1\.4 s/)).toBeInTheDocument();
    expect(screen.getByText(/Transport TCP/)).toBeInTheDocument();
    expect(screen.getByText(/Fallback: Iroh endpoint was unavailable; used TCP\./)).toBeInTheDocument();
    expect(screen.getByText(/0 imported, 1 applied, 1 deleted, 0 skipped, 0 conflicted, 0 failed/)).toBeInTheDocument();
    expect(screen.getByText(/TTFA 450 ms/)).toBeInTheDocument();
    expect(screen.getByText(/3\.0 MB received/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0 MB sent/)).toBeInTheDocument();
    expect(screen.getByText(/Receive 2\.1 MB\/s/)).toBeInTheDocument();
    expect(screen.getByText(/Send 714 KB\/s/)).toBeInTheDocument();
    expect(screen.getByText(/Largest aggregate phase Artifact Staging 900 ms/)).toBeInTheDocument();
    expect(screen.getByText(/Scratch peak 64 MB/)).toBeInTheDocument();
    expect(screen.getByText(/Staging peak 12 MB/)).toBeInTheDocument();
    expect(screen.getByText(/Max 8 streams/)).toBeInTheDocument();
    expect(screen.getByText(/Credits 64 grants, 2 revokes/)).toBeInTheDocument();
    const diagnosticsSummary = screen.getByText(/Diagnostics staging POST 300 ms/);
    expect(diagnosticsSummary).toHaveTextContent(
      "Diagnostics staging POST 300 ms (2 events, max 200 ms); receiver read 130 ms (5 events, max 90 ms); sender write 120 ms (4 events, max 70 ms); credit hold 80 ms (max 50 ms); credit wait 42 ms (2 events, max 40 ms); temp write 39 ms (5 events, max 12 ms); receiver hash 11 ms (5 events, max 5 ms); queue wait 9 ms (3 events, max 6 ms); stream open 5 ms (2 events, max 4 ms)",
    );
    expect(diagnosticsSummary).not.toHaveTextContent(/\+\d+ more/);

    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(2);
    expect(within(resultRows[0]).getByText("Applied")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("proj_retry")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("Retry imported the project.")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Deleted")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("proj_deleted")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Delete tombstone caught up.")).toBeInTheDocument();
    expect(screen.queryByText("Old ffprobe failure.")).not.toBeInTheDocument();
    expect(screen.queryByText(/stale tombstone warning/)).not.toBeInTheDocument();

    const artifactTransfers = await screen.findByRole("list", { name: "Last sync artifact transfers" });
    const transferRows = within(artifactTransfers).getAllByRole("listitem");
    expect(transferRows).toHaveLength(1);
    expect(within(transferRows[0]).getByText("art_retry_source")).toBeInTheDocument();
    expect(within(transferRows[0]).getByText("500 ms / 2.0 MB/s")).toBeInTheDocument();
  });

  it("disables evidence export when no sync result is available", async () => {
    const user = userEvent.setup();
    await openSyncTab(user);

    expect(screen.getByRole("button", { name: "Copy Evidence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export Evidence" })).toBeDisabled();
  });

  it("exports privacy-safe evidence from listener last_sync", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      display_name: "Studio Desktop",
      last_status: "Listener imported project proj_export_alpha from device_peer_1.",
      active_phase: "artifact_transfer",
      active_message:
        'Receiving artifact art_export_alpha from "C:\\Users\\test\\Music\\Secret Demo.wav" via tuneforge-sync+tcp://192.168.1.42:48625',
      active_progress_at: "2026-04-18T13:16:00.300Z",
      active_elapsed_ms: 900,
      last_lifecycle_event: {
        kind: "network_offline",
        occurred_at: "2026-04-18T13:16:00.700Z",
        message:
          "Lost device_peer_1 while reading /Users/test/Music/Secret Demo.wav via tuneforge-sync+tcp://192.168.1.42:48625.",
        retryable: true,
        interruption_code: "network_offline",
        retry_guidance: "Reconnect device_peer_1 and retry Secret Demo.wav.",
        peer_device_id: "device_peer_1",
        run_id: "sync_run_export_listener",
      },
      lifecycle_events: [
        {
          kind: "background",
          occurred_at: "2026-04-18T13:15:59.000Z",
          message: "Window blurred during sync_run_export_listener.",
          retryable: false,
          peer_device_id: "device_peer_1",
          run_id: "sync_run_export_listener",
        },
        {
          kind: "network_offline",
          occurred_at: "2026-04-18T13:16:00.700Z",
          message:
            "Lost device_peer_1 while reading /Users/test/Music/Secret Demo.wav via tuneforge-sync+tcp://192.168.1.42:48625.",
          retryable: true,
          interruption_code: "network_offline",
          retry_guidance: "Reconnect device_peer_1 and retry Secret Demo.wav.",
          peer_device_id: "device_peer_1",
          run_id: "sync_run_export_listener",
        },
      ],
      retryable_interruption_code: "network_offline",
      retryable_interruption_peer_device_id: "device_peer_1",
      retry_guidance: "Reconnect device_peer_1 and retry Secret Demo.wav.",
      last_sync: {
        run_id: "sync_run_export_listener",
        session_id: "sync_session_export_listener",
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        selected_transport: tcpTransportId,
        fallback_reason: "Iroh endpoint tuneforge-sync+iroh://device_peer_1 was unavailable; used TCP.",
        fallback_code: "stale_iroh_hint",
        attempted_transports: [irohTransportId, tcpTransportId],
        status: "completed",
        message:
          'Imported "/Users/test/Music/Secret Demo.wav" for proj_export_alpha after retry using art_export_alpha.',
        error: "Previous artifact art_export_beta failed from file:///Users/test/Music/Mix.wav",
        started_at: "2026-04-18T13:16:00.000Z",
        completed_at: "2026-04-18T13:16:01.250Z",
        duration_ms: 1250,
        time_to_first_artifact_ms: 650,
        total_received_bytes: 1_000_000,
        total_served_bytes: 9_000_000,
        throughput_bytes_per_second: 3_200_000,
        scratch_peak_bytes: 128_000_000,
        transfer_counts: {
          staging_peak_bytes: 16_000_000,
          max_active_streams: 8,
          credit_grants: 64,
          credit_revokes: 2,
          staging_post_ms_total: 300,
        },
        last_lifecycle_event: {
          kind: "network_offline",
          occurred_at: "2026-04-18T13:16:00.700Z",
          message:
            "Run sync_run_export_listener interrupted by device_peer_1 at /Users/test/Music/Secret Demo.wav.",
          retryable: true,
          interruption_code: "network_offline",
          retry_guidance: "Reconnect device_peer_1 and retry Secret Demo.wav.",
          peer_device_id: "device_peer_1",
          run_id: "sync_run_export_listener",
        },
        lifecycle_events: [
          {
            kind: "network_offline",
            occurred_at: "2026-04-18T13:16:00.700Z",
            message:
              "Run sync_run_export_listener interrupted by device_peer_1 at /Users/test/Music/Secret Demo.wav.",
            retryable: true,
            interruption_code: "network_offline",
            retry_guidance: "Reconnect device_peer_1 and retry Secret Demo.wav.",
            peer_device_id: "device_peer_1",
            run_id: "sync_run_export_listener",
          },
        ],
        retryable_interruption_code: "network_offline",
        retryable_interruption_peer_device_id: "device_peer_1",
        retry_guidance: "Reconnect device_peer_1 and retry Secret Demo.wav.",
        imported_project_count: 1,
        applied_project_count: 1,
        skipped_project_count: 0,
        failed_project_count: 0,
        project_results: [
          {
            project_id: "proj_export_alpha",
            status: "failed",
            message: "Old failure for proj_export_alpha.",
            is_final: true,
            completed_at: "2026-04-18T13:15:30.000Z",
            failed_count: 1,
          },
          {
            project_id: "proj_export_alpha",
            status: "applied",
            phase: "backend_staging_shadow",
            message: "Retry imported proj_export_alpha from '/Users/test/Music/Secret Demo.wav'.",
            is_final: true,
            started_at: "2026-04-18T13:16:00.500Z",
            completed_at: "2026-04-18T13:16:01.100Z",
            applied_count: 2,
            reused_artifact_count: 1,
          },
        ],
        manifest_errors: [],
        phase_timings: [
          {
            phase: "network_receive",
            project_id: "proj_export_alpha",
            artifact_id: "art_export_alpha",
            started_at: "2026-04-18T13:16:00.200Z",
            completed_at: "2026-04-18T13:16:00.650Z",
            duration_ms: 450,
            throughput_bytes_per_second: 2_000_000,
          },
          { phase: "staging_post", duration_ms: null },
          { phase: "staging_apply_plan", duration_ms: null },
        ],
        received_artifacts: [
          {
            artifact_id: "art_export_alpha",
            content_sha256: "sha256-export-alpha",
            size_bytes: 1_000_000,
            status: "received",
            message: "Fetched art_export_alpha from file:///Users/test/Music/Secret%20Demo.wav",
            started_at: "2026-04-18T13:16:00.200Z",
            completed_at: "2026-04-18T13:16:00.650Z",
            duration_ms: 450,
            throughput_bytes_per_second: 2_000_000,
          },
          {
            artifact_id: "art_export_beta",
            content_sha256: "sha256-export-beta",
            size_bytes: 500_000,
            status: "already_staged",
            message: "Reused art_export_beta from Mix.wav",
            completed_at: "2026-04-18T13:16:00.150Z",
          },
        ],
      },
    });

    await openSyncTab(user);

    await user.click(screen.getByRole("button", { name: "Copy Evidence" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copiedSerialized = writeText.mock.calls[0]?.[0];
    expect(typeof copiedSerialized).toBe("string");
    expect(JSON.parse(copiedSerialized as string)).toMatchObject({
      scenario: "listener-last-sync",
      validation: { privacySafe: true },
    });
    expect(screen.getByRole("button", { name: "Export Evidence" })).toBeEnabled();
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(await screen.findByText(/Sync evidence exported/)).toBeInTheDocument();
    expect(Object.keys(exportedJson)).toEqual([
      "capturedAt",
      "scenario",
      "source",
      "run",
      "transport",
      "metrics",
      "projects",
      "artifacts",
      "lifecycle",
      "storage",
      "validation",
    ]);
    expect(exportedJson.scenario).toBe("listener-last-sync");
    expect(exportedJson.source).toMatchObject({
      kind: "listener.last_sync",
      listenerActive: true,
      listenerStatus: "listening",
    });
    expect(exportedJson.run).toMatchObject({
      label: "Run 1",
      peer: "peer_1",
      remotePeer: "peer_1",
      hasRunId: true,
      hasSessionId: true,
      status: "completed",
    });
    expect(exportedJson.transport).toMatchObject({
      selected: tcpTransportId,
      attempted: [irohTransportId, tcpTransportId],
      fallback: {
        code: "stale_iroh_hint",
        reason: "details redacted.",
      },
    });
    expect(exportedJson.metrics).toMatchObject({
      timeToFirstArtifactMs: 650,
      throughputBytesPerSecond: 3_200_000,
      network_receive_throughput_bytes_per_second: 800_000,
      network_send_throughput_bytes_per_second: 7_200_000,
      total_received_bytes: 1_000_000,
      total_served_bytes: 9_000_000,
      project_imports_per_minute: 0,
      project_mutations_per_minute: 48,
      retryIndicators: {
        duplicateProjectEvents: true,
        messageMentionsRetry: true,
      },
      reuseIndicators: {
        reusedArtifacts: true,
        reusedProjectArtifacts: true,
        messageMentionsReuse: false,
      },
    });
    const exportedMetrics = exportedJson.metrics as {
      backend_staging_throughput_bytes_per_second?: number;
    };
    expect(exportedMetrics.backend_staging_throughput_bytes_per_second).toBeCloseTo(
      1_000_000 / 0.3,
    );
    expect(exportedJson.projects).toEqual([
      expect.objectContaining({
        label: "Project 1",
        status: "applied",
        phase: "phase_redacted",
        counts: expect.objectContaining({
          applied: 2,
          reusedArtifacts: 1,
        }),
        appearance: expect.objectContaining({
          eventCount: 5,
          cadenceMs: 7775,
        }),
      }),
    ]);
    expect(exportedJson.artifacts).toEqual([
      expect.objectContaining({
        label: "Artifact 1",
        status: "received",
        throughputBytesPerSecond: 2_000_000,
        reused: false,
      }),
      expect.objectContaining({
        label: "Artifact 2",
        status: "already_staged",
        reused: true,
      }),
    ]);
    expect(exportedJson.lifecycle).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: "background",
          peer: "peer_1",
          hasRunId: true,
        }),
        expect.objectContaining({
          kind: "network_offline",
          retryable: true,
          interruptionCode: "network_offline",
          peer: "peer_1",
          hasRunId: true,
        }),
      ]),
      lastLifecycleEvent: expect.objectContaining({
        kind: "network_offline",
        retryable: true,
        interruptionCode: "network_offline",
        retryGuidance: "details redacted.",
        peer: "peer_1",
        hasRunId: true,
      }),
      retryableInterruptionCode: "network_offline",
      retryGuidance: "details redacted.",
      listener: {
        active: true,
        status: "listening",
        activePhase: "artifact_transfer",
        hasLastError: false,
        lastLifecycleEvent: expect.objectContaining({
          kind: "network_offline",
          peer: "peer_1",
        }),
        retryableInterruptionCode: "network_offline",
      },
      run: {
        lastLifecycleEvent: expect.objectContaining({
          kind: "network_offline",
          peer: "peer_1",
        }),
        retryableInterruptionCode: "network_offline",
      },
      phaseTimings: [
        expect.objectContaining({
          label: "phase_1",
          phase: "artifact_transfer",
          project: "Project 1",
          artifact: "Artifact 1",
        }),
        expect.objectContaining({ phase: "artifact_staging" }),
        expect.objectContaining({ phase: "reconciliation_staging" }),
      ],
    });
    expect(exportedJson.storage).toMatchObject({
      scratch_peak_bytes: 128_000_000,
      staging_peak_bytes: 16_000_000,
      scratchPeakBytes: 128_000_000,
      stagingPeakBytes: 16_000_000,
    });
    expect(exportedJson.validation).toMatchObject({
      schema: "tuneforge-sync-evidence-v1",
      privacySafe: true,
      redactionCounts: {
        peers: 1,
        projects: 1,
        artifacts: 2,
      },
    });

    [copiedSerialized as string, JSON.stringify(exportedJson)].forEach((serialized) => {
      expect(serialized).toContain("peer_1");
      expect(serialized).toContain("Project 1");
      expect(serialized).toContain("Artifact 1");
      [
        "device_peer_1",
        "sync_run_export_listener",
        "proj_export_alpha",
        "art_export_alpha",
        "sha256-export-alpha",
        "Studio Desktop",
        "endpoint_hints",
        "Mix.wav",
        "Secret Demo.wav",
        "C:\\Users",
        "C:\\\\Users",
        "file://",
        "/Users/test/Music",
        "/tmp/demo.wav",
        "tuneforge-sync+tcp://192.168.1.42:48625",
      ].forEach((privateValue) => expect(serialized).not.toContain(privateValue));
    });
  });

  it.each([
    [0, 0, false], [2, 2, true], [2, 0, false],
  ])("exports message reuse %i with numeric reuse %i as %s", async (messageCount, reuseCount, expected) => {
    const user = userEvent.setup();
    setSyncTransportStatus({ active: true, status: "listening", endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({ message: canonicalSummary({ local: 1, remote: 0, reused: messageCount }),
        project_results: [], received_artifacts: Array.from({ length: reuseCount }, (_, index) => ({
          artifact_id: `art_reuse_${index}`, status: "already_staged" })) }) });

    await openSyncTab(user);
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    expect(exportedJson.metrics).toMatchObject({ reuseIndicators: { messageMentionsReuse: expected } });
  });

  it.each([[2, false, null], [1, false, 100], [2, true, null]])(
    "exports received bytes for count %i complete %s as %s", async (receivedCount, complete, expected) => {
      const user = userEvent.setup();
      setSyncTransportStatus({ active: true, status: "listening", endpoint_hints: listenerEndpointHints,
        last_sync: syncRunStatus({ duration_ms: 1000, transfer_counts: { received: receivedCount },
          received_artifacts_complete: complete, received_artifacts: [
            { artifact_id: "art_received", status: "received", size_bytes: 100 },
            { artifact_id: "art_failed", status: "failed", size_bytes: 900 }] }) });
      await openSyncTab(user);
      const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
      expect(exportedJson.metrics).toMatchObject({ total_received_bytes: expected,
        received_artifacts_complete: complete });
      const issues = (exportedJson.validation as { issues: string[] }).issues;
      expect(issues.includes("received_artifact_count_mismatch")).toBe(complete);
      if (complete) {
        expect(exportedJson.validation).toMatchObject({ ok: false });
        expect((await validateExportedEvidence(exportedJson)).errors.join(" "))
          .toMatch(/Complete received artifact rows disagree with authoritative received count/);
      }
    },
  );

  it("does not export UI fallback listener status with trusted peer display names", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_display_name_fallback",
        session_id: "sync_session_display_name_fallback",
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        status: "completed",
        message: null,
        project_results: [
          {
            project_id: "proj_display_name_fallback",
            status: "imported",
            message: "Imported proj_display_name_fallback.",
            imported_count: 1,
          },
        ],
      }),
    });

    await openSyncTab(user);

    expect(await screen.findByText(importedNoRemoteCanonicalSummary)).toBeInTheDocument();
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    const serialized = JSON.stringify(exportedJson);
    expect(exportedJson.lifecycle).toMatchObject({
      listener: {
        lastStatus: null,
      },
    });
    expect(serialized).not.toContain("Completed for Laptop Rig.");
    expect(serialized).not.toContain("Laptop Rig");
    expect(serialized).not.toContain("proj_display_name_fallback");
  });

  it("exports privacy-safe reviewer status corpus", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_partial_truth",
        session_id: "sync_session_partial_truth",
        status: "failed",
        message: "Sync completed with project conflicts.",
        duration_ms: 1000,
        throughput_bytes_per_second: 0,
        total_received_bytes: 0,
        total_served_bytes: 0,
        served_artifact_requests: 0,
        transfer_counts: { requested: 1, received: 0, skipped: 0, already_staged: 0, failed: 1, retried: 0 },
        failed_project_count: 1,
        project_results: [
          {
            project_id: "proj_partial_truth",
            status: "conflicted",
            message: "Project had a conflict.",
            failed_count: 1,
            counters: { failed_count: 1 },
          },
        ],
        received_artifacts: [
          {
            artifact_id: "art_partial_truth",
            content_sha256: "sha256-partial-truth",
            size_bytes: 42,
            status: "error",
            message: "Artifact content_sha256_deadbeefcafebabefeedface01234567 failed.",
          },
        ],
        phase_timings: [{ phase: "reconciliation_apply_project", duration_ms: 0 }],
      }),
    });

    await openSyncTab(user);
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.validation).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "artifact_status_error",
        "conflicted_project_count",
        "project_failed_count",
        "project_counter_failed_count",
        "project_status_conflicted",
        "run_status_failed",
      ]),
    });
    expect(JSON.stringify(exportedJson)).not.toContain("content_sha256_deadbeefcafebabefeedface01234567");
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation).toMatchObject({ ok: true, schemaPrivacyOk: true });
  });

  it("preserves incomplete no-row legacy project accounting through export", async () => {
    const user = userEvent.setup();
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: {
        selected_transport: irohTransportId,
        attempted_transports: [irohTransportId],
        duration_ms: 1000, throughput_bytes_per_second: 1000, time_to_first_artifact_ms: 0,
        served_artifact_requests: 1, total_served_bytes: 1000,
        imported_project_count: 0, failed_project_count: 1, total_project_count: 2,
        received_artifacts: [],
      },
    });
    const canonicalCounts = syncRunCanonicalCounts(normalized.last_sync!);

    expect(normalized.last_sync).toMatchObject({ status: "completed_with_errors", imported_project_count: 0,
      applied_project_count: null, failed_project_count: 1, total_project_count: 2 });
    expect(canonicalCounts?.projectResultsByStatus).toBeNull();
    setSyncTransportStatus(normalized);

    await openSyncTab(user);
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    expect(exportedJson.metrics).toMatchObject({
      network_receive_throughput_bytes_per_second: null,
      network_send_throughput_bytes_per_second: 1000,
      projectResultsByStatus: null,
      transferCounts: { importedProjectCount: 0, appliedProjectCount: null,
        failedProjectCount: 1, totalProjectCount: 2 },
    });
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation.errors).toEqual([]);
    expect(validation).toMatchObject({ ok: true, schemaPrivacyOk: true });
  });

  it("exports no-row aggregate project outcomes with matching status buckets", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        status: "completed_with_errors",
        duration_ms: 1000, throughput_bytes_per_second: 1000, time_to_first_artifact_ms: 0,
        served_artifact_requests: 1, total_served_bytes: 1000,
        imported_project_count: 0, applied_project_count: 0, deleted_project_count: 0,
        skipped_project_count: 2, conflicted_project_count: 1, failed_project_count: 1, total_project_count: 4,
        project_results: [],
      }),
    });

    await openSyncTab(user);
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.projects).toEqual([]);
    expect(exportedJson.metrics).toMatchObject({
      projectResultsByStatus: { skipped: 2, conflicted: 1, failed: 1 },
      transferCounts: { skippedProjectCount: 2, conflictedProjectCount: 1,
        failedProjectCount: 1, totalProjectCount: 4 },
    });
    expect(exportedJson.validation).toMatchObject({
      outcomeOk: false,
      issues: expect.arrayContaining([
        "conflicted_project_count", "failed_project_count", "run_status_completed_with_errors",
      ]),
    });
    expect(await validateExportedEvidence(exportedJson)).toMatchObject({ ok: true, schemaPrivacyOk: true });
  });

  it("excludes non-final project events from exported final outcome accounting", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        status: "completed",
        duration_ms: 1000, throughput_bytes_per_second: 1000, time_to_first_artifact_ms: 0,
        served_artifact_requests: 1, total_served_bytes: 1000,
        project_results: [
          { project_id: "proj_progress_failure", status: "failed", is_final: false },
          { project_id: "proj_final_skip", status: "skipped", is_final: true },
        ],
      }),
    });

    await openSyncTab(user);
    const projectEvidence = await screen.findByRole("list", { name: "Last sync project evidence" });
    expect(within(projectEvidence).getByText("Failed (event)")).toBeInTheDocument();
    expect(within(projectEvidence).getByText("Skipped")).toBeInTheDocument();
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", isFinal: false }),
      expect.objectContaining({ status: "skipped", isFinal: true }),
    ]));
    expect(exportedJson.metrics).toMatchObject({
      projectResultsByStatus: { skipped: 1 },
      transferCounts: { failedProjectCount: 0, skippedProjectCount: 1, totalProjectCount: 1 },
    });
    expect(exportedJson.validation).toMatchObject({ outcomeOk: true, issues: [] });
    expect(await validateExportedEvidence(exportedJson)).toMatchObject({ ok: true, schemaPrivacyOk: true });
  });

  it("exports mixed failed and conflicted listener evidence with consistent counts", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_mixed_counts",
        session_id: "sync_session_mixed_counts",
        status: "completed_with_errors",
        message: "Sync completed with failed and conflicted project results.",
        started_at: "2026-04-18T13:16:00.000Z",
        completed_at: "2026-04-18T13:16:00.600Z",
        duration_ms: 600,
        throughput_bytes_per_second: 4000,
        imported_project_count: 0,
        applied_project_count: 0,
        deleted_project_count: 0,
        skipped_project_count: 1,
        conflicted_project_count: 1,
        failed_project_count: 2,
        project_results: [
          {
            project_id: "proj_mixed_conflict",
            status: "conflicted",
            message: "Lyrics conflict requires manual review.",
          },
          {
            project_id: "proj_mixed_failed",
            status: "failed",
            message: "Manifest export failed before transfer.",
          },
          {
            project_id: "proj_mixed_skipped",
            status: "skipped",
            message: "Already up to date.",
          },
        ],
        manifest_errors: [
          {
            project_id: "proj_mixed_failed",
            message: "Manifest export failed before transfer.",
          },
        ],
        phase_timings: [
          {
            phase: "reconciliation_apply_project",
            started_at: "2026-04-18T13:16:00.000Z",
            completed_at: "2026-04-18T13:16:00.500Z",
            duration_ms: 500,
          },
          {
            phase: "reconciliation_apply_project",
            started_at: "2026-04-18T13:16:00.100Z",
            completed_at: "2026-04-18T13:16:00.600Z",
            duration_ms: 500,
          },
        ],
      }),
    });

    await openSyncTab(user);

    expect(
      await screen.findByText(canonicalSummary({ skipped: 1, conflicted: 1, failed: 1, manifestErrors: 1 })),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sync completed with failed and conflicted project results.")).not.toBeInTheDocument();
    expect(screen.getByText(/1 skipped, 1 conflicted, 1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/Largest aggregate phase Reconciliation Apply Project 1\.0 s/)).toBeInTheDocument();

    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.metrics).toMatchObject({
      reconciliation_apply_ms: 600,
      reconciliation_apply_aggregate_ms: 1000,
      reconciliation_apply_timing: {
        semantics: "wall_clock_interval_union_bounded_to_run",
      },
      projectResultsByStatus: {
        conflicted: 1,
        failed: 1,
        skipped: 1,
      },
      transferCounts: {
        skippedProjectCount: 1,
        conflictedProjectCount: 1,
        failedProjectCount: 1,
        totalProjectCount: 3,
        manifestExportErrorCount: 1,
      },
    });
    expect(exportedJson.validation).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "conflicted_project_count",
        "failed_project_count",
        "manifest_export_error_count",
        "project_status_conflicted",
        "project_status_failed",
      ]),
    });
    const serialized = JSON.stringify(exportedJson);
    expect(serialized).not.toContain("proj_mixed_conflict");
    expect(serialized).not.toContain("proj_mixed_failed");
  });

  it("does not treat run bounds as source project apply timing", async () => {
    const user = userEvent.setup();
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: {
        status: "completed",
        selected_transport: irohTransportId, attempted_transports: [irohTransportId],
        started_at: "2026-04-18T13:16:00.000Z", completed_at: "2026-04-18T13:16:00.600Z",
        duration_ms: 600, throughput_bytes_per_second: 1000, total_received_bytes: 100,
        total_served_bytes: 0, served_artifact_requests: 0,
        time_to_first_artifact_ms: 100,
        project_results: [{ project_id: "proj_legacy_apply", status: "applied" }],
        received_artifacts: [{ artifact_id: "art_legacy_apply", size_bytes: 100,
          status: "received", duration_ms: 100 }],
        phase_timings: [{ phase: "staging_post", project_id: "proj_legacy_apply",
          started_at: "2026-04-18T13:16:00.000Z", completed_at: "2026-04-18T13:16:00.100Z",
          duration_ms: 100 }],
      },
    });

    expect(normalized.last_sync?.project_results[0]).toMatchObject({
      project_id: "proj_legacy_apply", started_at: null, completed_at: null,
    });
    setSyncTransportStatus(normalized);
    await openSyncTab(user);
    expect(screen.getByText("proj_legacy_apply")).toBeInTheDocument();
    expect(screen.getByText("Applied")).toBeInTheDocument();

    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    expect(exportedJson.metrics).toMatchObject({
      reconciliation_apply_ms: null,
      reconciliation_apply_aggregate_ms: null,
      reconciliation_apply_timing: { semantics: "not_reported" },
    });
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation).toMatchObject({ ok: false, schemaPrivacyOk: false });
    expect(validation.errors).toEqual(["Missing required metric: reconciliation apply time."]);
  });

  it.each([
    {
      label: "duration-only entries",
      phaseTimings: [
        { phase: "reconciliation_apply_project", duration_ms: 500 },
        { phase: "reconciliation_apply_project", duration_ms: 500 },
      ],
      wallClockMs: null, aggregateMs: 1000, semantics: "aggregate_only", assertUi: true, validatorErrors: [],
    },
    {
      label: "mixed timestamped and duration-only entries",
      phaseTimings: [
        { phase: "reconciliation_apply_project", started_at: "2026-04-18T13:16:00.000Z",
          completed_at: "2026-04-18T13:16:00.300Z", duration_ms: 300 },
        { phase: "reconciliation_apply_project", duration_ms: 200 },
      ],
      wallClockMs: null, aggregateMs: 500, semantics: "aggregate_only", assertUi: false, validatorErrors: [],
    },
    {
      label: "contradictory interval durations",
      phaseTimings: [
        { phase: "reconciliation_apply_project", started_at: "2026-04-18T13:16:00.100Z",
          completed_at: "2026-04-18T13:16:00.300Z", duration_ms: 500 },
      ],
      wallClockMs: null, aggregateMs: null, semantics: "not_reported", assertUi: false,
      validatorErrors: ["Missing required metric: reconciliation apply time."],
    },
    {
      label: "out-of-run intervals",
      phaseTimings: [
        { phase: "reconciliation_apply_project", started_at: "2026-04-18T13:15:59.900Z",
          completed_at: "2026-04-18T13:16:00.200Z", duration_ms: 300 },
      ],
      wallClockMs: null, aggregateMs: 300, semantics: "aggregate_only", assertUi: false, validatorErrors: [],
    },
    {
      label: "interval-derived aggregate duration",
      phaseTimings: [
        { phase: "reconciliation_apply_project", started_at: "2026-04-18T13:16:00.100Z",
          completed_at: "2026-04-18T13:16:00.400Z" },
      ],
      wallClockMs: 300, aggregateMs: 300, semantics: "wall_clock_interval_union_bounded_to_run",
      assertUi: false, validatorErrors: [],
    },
    {
      label: "tolerated explicit duration below interval",
      phaseTimings: [
        { phase: "reconciliation_apply_project", started_at: "2026-04-18T13:16:00.100Z",
          completed_at: "2026-04-18T13:16:00.400Z", duration_ms: 299 },
      ],
      wallClockMs: 300, aggregateMs: 300, semantics: "wall_clock_interval_union_bounded_to_run",
      assertUi: false, validatorErrors: [],
    },
    {
      label: "tolerated explicit duration above interval",
      phaseTimings: [
        { phase: "reconciliation_apply_project", started_at: "2026-04-18T13:16:00.100Z",
          completed_at: "2026-04-18T13:16:00.400Z", duration_ms: 301 },
      ],
      wallClockMs: 300, aggregateMs: 301, semantics: "wall_clock_interval_union_bounded_to_run",
      assertUi: false, validatorErrors: [],
    },
    {
      label: "uncovered aggregate entries",
      phaseTimings: [
        { phase: "reconciliation_apply_project", duration_ms: 200 },
        { phase: "reconciliation_apply_project" },
      ],
      wallClockMs: null, aggregateMs: null, semantics: "not_reported", assertUi: false,
      validatorErrors: ["Missing required metric: reconciliation apply time."],
    },
  ])("exports truthful apply timing for $label", async ({
    phaseTimings, wallClockMs, aggregateMs, semantics, assertUi, validatorErrors,
  }) => {
    const user = userEvent.setup();
    setSyncTransportStatus(normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: {
        status: "completed",
        selected_transport: irohTransportId,
        attempted_transports: [irohTransportId],
        started_at: "2026-04-18T13:16:00.000Z",
        completed_at: "2026-04-18T13:16:00.600Z",
        duration_ms: 600,
        throughput_bytes_per_second: 1000,
        total_received_bytes: 100,
        total_served_bytes: 0,
        served_artifact_requests: 0,
        time_to_first_artifact_ms: 100,
        project_results: [{ project_id: "proj_timing_truth", status: "skipped",
          started_at: "2026-04-18T13:16:00.000Z", completed_at: "2026-04-18T13:16:00.600Z" }],
        received_artifacts: [{ artifact_id: "art_timing_truth", size_bytes: 100,
          status: "received", duration_ms: 100 }],
        phase_timings: [
          { phase: "staging_post", project_id: "proj_timing_truth",
            started_at: "2026-04-18T13:16:00.000Z", completed_at: "2026-04-18T13:16:00.100Z",
            duration_ms: 100 },
          ...phaseTimings,
        ],
      },
    }));

    await openSyncTab(user);
    if (assertUi) {
      expect(screen.getByText(/Largest aggregate phase Reconciliation Apply Project 1\.0 s/)).toBeInTheDocument();
    }
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.metrics).toMatchObject({
      reconciliation_apply_ms: wallClockMs,
      reconciliation_apply_aggregate_ms: aggregateMs,
      reconciliation_apply_timing: { semantics },
    });
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation.errors).toEqual(validatorErrors);
    expect(validation).toMatchObject({
      ok: validatorErrors.length === 0,
      schemaPrivacyOk: validatorErrors.length === 0,
    });
  });

  it("exports omitted legacy accounting as unknown rather than zero", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus(normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: {
        status: "completed",
        message: "Legacy sync completed.",
        selected_transport: "iroh",
        duration_ms: 1000,
        throughput_bytes_per_second: 0,
        total_received_bytes: 0,
        total_served_bytes: 0,
        served_artifact_requests: 0,
      },
    }));

    await openSyncTab(user);
    expect(await screen.findByText("Legacy sync completed.")).toBeInTheDocument();
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    const metrics = exportedJson.metrics as {
      transfer_counts: Record<string, number | null>;
      transferCounts: Record<string, number | null>;
    };

    expect(metrics.transfer_counts).toEqual({
      requested: null,
      received: null,
      skipped: null,
      already_staged: null,
      failed: null,
      retried: null,
    });
    expect(metrics.transferCounts).toMatchObject({
      importedProjectCount: null,
      appliedProjectCount: null,
      deletedProjectCount: null,
      skippedProjectCount: null,
      conflictedProjectCount: null,
      failedProjectCount: null,
      totalProjectCount: null,
      manifestExportErrorCount: null,
    });
  });

  it("exports manifest-only listener errors outside failed project counts", async () => {
    const user = userEvent.setup();
    const normalized = normalizeSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_manifest_only",
        session_id: "sync_session_manifest_only",
        status: "completed_with_errors",
        message: null,
        local_manifest_count: 1,
        remote_manifest_count: 1,
        imported_project_count: 0,
        applied_project_count: 0,
        deleted_project_count: 0,
        skipped_project_count: 0,
        conflicted_project_count: 0,
        failed_project_count: 0,
        manifest_export_error_count: 0,
        duration_ms: 1000,
        throughput_bytes_per_second: 1000,
        time_to_first_artifact_ms: 0,
        served_artifact_requests: 1,
        total_served_bytes: 1000,
        project_results: [],
        manifest_errors: [
          {
            project_id: "proj_manifest_only",
            message: "Peer manifest export failed before apply.",
          },
        ],
      }),
    });
    expect(normalized.last_sync?.manifest_export_error_count).toBe(1);
    expect(normalized.last_sync?.message).toBe(canonicalSummary({ local: 1, remote: 1, manifestErrors: 1 }));
    setSyncTransportStatus(normalized);

    await openSyncTab(user);

    expect(await screen.findByText(`No project changes. ${canonicalSummary({
      local: 1,
      remote: 1,
      manifestErrors: 1,
    })}`))
      .toBeInTheDocument();
    expect(screen.getByText(/0 skipped, 0 conflicted, 0 failed, 1 manifest export error/)).toBeInTheDocument();
    const projectResults = await screen.findByRole("list", { name: "Last sync project evidence" });
    expect(within(projectResults).getByText("Manifest Export Error")).toBeInTheDocument();

    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.metrics).toMatchObject({
      projectResultsByStatus: {
      },
      transferCounts: {
        failedProjectCount: 0,
        conflictedProjectCount: 0,
        totalProjectCount: 0,
        manifestExportErrorCount: 1,
      },
    });
    expect(exportedJson.validation).toMatchObject({
      scope: "run_outcome",
      ok: false,
      outcomeOk: false,
      issues: expect.arrayContaining([
        "manifest_export_error_count",
      ]),
    });
    expect((exportedJson.validation as { issues: string[] }).issues)
      .not.toContain("project_status_manifest_export_error");
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation).toMatchObject({ ok: true, schemaPrivacyOk: true });
  });

  it("exports multiple manifest errors for one project outside final outcome buckets", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        status: "completed_with_errors",
        duration_ms: 1000,
        throughput_bytes_per_second: 1000,
        time_to_first_artifact_ms: 0,
        served_artifact_requests: 1,
        total_served_bytes: 1000,
        manifest_export_error_count: 2,
        project_results_complete: true,
        received_artifacts_complete: true,
        manifest_errors: [
          { project_id: "proj_manifest_repeat", message: "Local manifest export failed." },
          { project_id: "proj_manifest_repeat", message: "Peer manifest export failed." },
        ],
      }),
    });

    await openSyncTab(user);
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    const metrics = exportedJson.metrics as {
      projectResultsByStatus: Record<string, number>;
      transferCounts: Record<string, number>;
      total_served_bytes: number;
    };

    expect(exportedJson.projects).toEqual([
      expect.objectContaining({ label: "Project 1", status: "manifest_export_error" }),
    ]);
    expect(metrics.projectResultsByStatus).toEqual({});
    expect(metrics.total_served_bytes).toBe(1000);
    expect(metrics.transferCounts).toMatchObject({
      failedProjectCount: 0,
      totalProjectCount: 0,
      manifestExportErrorCount: 2,
    });
    expect(metrics.transferCounts).not.toHaveProperty("manifestErrorCount");
    expect((exportedJson.validation as { issues: string[] }).issues)
      .not.toContain("project_status_manifest_export_error");
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation.errors).toEqual([]);
    expect(validation).toMatchObject({ ok: true, schemaPrivacyOk: true });
  });

  it("exports overlapping failed projects and manifest errors with validator-consistent status buckets", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_overlap_manifest_error",
        session_id: "sync_session_overlap_manifest_error",
        status: "completed_with_errors",
        message: null,
        started_at: "2026-04-18T13:16:00.000Z",
        completed_at: "2026-04-18T13:16:01.000Z",
        duration_ms: 1000,
        time_to_first_artifact_ms: 100,
        throughput_bytes_per_second: 1000,
        total_received_bytes: 1000,
        total_served_bytes: 0,
        served_artifact_requests: 0,
        failed_project_count: 1,
        manifest_export_error_count: 1,
        project_results: [
          {
            project_id: "proj_overlap_private",
            status: "failed",
            message: "Project failed after manifest export warning.",
            is_final: true,
            started_at: "2026-04-18T13:16:00.200Z",
            completed_at: "2026-04-18T13:16:00.900Z",
            failed_count: 1,
          },
        ],
        manifest_errors: [
          {
            project_id: "proj_overlap_private",
            message: "Manifest export failed for overlapping project.",
          },
        ],
        phase_timings: [
          {
            phase: "staging_post",
            started_at: "2026-04-18T13:16:00.000Z",
            completed_at: "2026-04-18T13:16:00.200Z",
            duration_ms: 200,
          },
          {
            phase: "reconciliation_apply",
            project_id: "proj_overlap_private",
            started_at: "2026-04-18T13:16:00.200Z",
            completed_at: "2026-04-18T13:16:00.500Z",
            duration_ms: 300,
          },
        ],
        received_artifacts: [
          {
            artifact_id: "art_overlap_private",
            size_bytes: 1000,
            status: "received",
            duration_ms: 100,
          },
        ],
      }),
    });

    await openSyncTab(user);
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);
    const exportedMetrics = exportedJson.metrics as {
      projectResultsByStatus?: Record<string, number>;
      transferCounts?: Record<string, number>;
    };

    expect(exportedJson.projects).toEqual([
      expect.objectContaining({
        label: "Project 1",
        status: "failed",
      }),
    ]);
    expect(exportedMetrics.projectResultsByStatus).toEqual({ failed: 1 });
    expect(exportedMetrics.transferCounts).toMatchObject({
      failedProjectCount: 1,
      totalProjectCount: 1,
      manifestExportErrorCount: 1,
    });
    expect((exportedJson.validation as { issues: string[] }).issues)
      .not.toContain("project_status_manifest_export_error");
    const validation = await validateExportedEvidence(exportedJson);
    expect(validation).toMatchObject({ ok: true, schemaPrivacyOk: true });
    expect(JSON.stringify(exportedJson)).not.toContain("proj_overlap_private");
  });

  it("exports no-change listener sync evidence as successful", async () => {
    const user = userEvent.setup();
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_no_change",
        session_id: "sync_session_no_change",
        status: "completed",
        message: "Sync completed with no project changes.",
        started_at: "2026-04-18T13:16:00.000Z",
        completed_at: "2026-04-18T13:16:01.000Z",
        duration_ms: 1000,
        throughput_bytes_per_second: 0,
        imported_project_count: 0,
        applied_project_count: 0,
        deleted_project_count: 0,
        skipped_project_count: 2,
        conflicted_project_count: 0,
        failed_project_count: 0,
        total_project_count: 2,
        received_artifacts_complete: true,
        project_results: [],
      }),
    });

    await openSyncTab(user);

    expect(await screen.findByText(`No project changes. ${canonicalSummary({ skipped: 2 })}`)).toBeInTheDocument();
    expect(screen.queryByText("Sync completed with no project changes.")).not.toBeInTheDocument();
    expect(screen.getByText(/2 skipped, 0 conflicted, 0 failed/)).toBeInTheDocument();

    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.validation).toMatchObject({
      scope: "run_outcome",
      ok: true,
      outcomeOk: true,
      issues: [],
    });
    expect(exportedJson.metrics).toMatchObject({
      network_receive_throughput_bytes_per_second: null,
      network_send_throughput_bytes_per_second: null,
      project_imports_per_minute: 0,
      projectResultsByStatus: {
        skipped: 2,
      },
      transferCounts: {
        skippedProjectCount: 2,
        conflictedProjectCount: 0,
        failedProjectCount: 0,
        totalProjectCount: 2,
        manifestExportErrorCount: 0,
      },
    });
    expect(exportedJson.projects).toEqual([]);
  });

  it("copies exact privacy-safe evidence through the native Tauri clipboard", async () => {
    const user = userEvent.setup();
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    setEvidenceSyncResult("native_copy_private");

    await openSyncTab(user);
    await user.click(screen.getByRole("button", { name: "Copy Evidence" }));

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith(expect.any(String)));
    const copiedText = mockClipboardWriteText.mock.calls[0]?.[0] as string;
    expect(JSON.parse(copiedText)).toMatchObject({
      scenario: "listener-last-sync",
      validation: { privacySafe: true },
    });
    expect(copiedText).not.toContain("proj_native_copy_private");
    expect(copiedText).not.toContain("device_peer_1");
    expect(browserWriteText).not.toHaveBeenCalled();
    expect(await screen.findByText("Sync evidence copied.")).toBeInTheDocument();
  });

  it("reports native clipboard failure safely without browser fallback", async () => {
    const user = userEvent.setup();
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    mockClipboardWriteText.mockRejectedValue(
      new Error("Clipboard rejected /private/sync_run_native_copy_failure"),
    );
    setEvidenceSyncResult("native_copy_failure");

    await openSyncTab(user);
    await user.click(screen.getByRole("button", { name: "Copy Evidence" }));

    expect(await screen.findByText("Could not copy sync evidence. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Sync evidence copied.")).not.toBeInTheDocument();
    expect(screen.queryByText(/private\/sync_run/)).not.toBeInTheDocument();
    expect(browserWriteText).not.toHaveBeenCalled();
  });

  it("disables both evidence actions while a native copy is unresolved", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let resolveClipboard: (() => void) | undefined;
    const pendingClipboard = new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    });
    mockClipboardWriteText.mockReturnValue(pendingClipboard);
    setEvidenceSyncResult("native_copy_pending");

    await openSyncTab(user);
    await user.click(screen.getByRole("button", { name: "Copy Evidence" }));
    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledOnce());
    const copyButton = screen.getByRole("button", { name: "Copy Evidence" });
    const exportButton = screen.getByRole("button", { name: "Export Evidence" });
    expect(copyButton).toBeDisabled();
    expect(exportButton).toBeDisabled();

    fireEvent.click(copyButton);
    fireEvent.click(exportButton);
    expect(mockClipboardWriteText).toHaveBeenCalledOnce();
    expect(getMockInvoke().mock.calls.some(([command]) => command === "write_sync_evidence_file")).toBe(false);

    await act(async () => resolveClipboard?.());
    expect(await screen.findByText("Sync evidence copied.")).toBeInTheDocument();
    expect(copyButton).toBeEnabled();
    expect(exportButton).toBeEnabled();
  });

  it("exports evidence through the Tauri save command when available", async () => {
    const user = userEvent.setup();
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_tauri_export",
        session_id: "sync_session_tauri_export",
        message: "Imported proj_tauri_export from device_peer_1.",
        project_results: [
          {
            project_id: "proj_tauri_export",
            status: "imported",
            message: "Imported proj_tauri_export.",
            imported_count: 1,
          },
        ],
      }),
    });

    await openSyncTab(user);
    await user.click(screen.getByRole("button", { name: "Export Evidence" }));

    const mockInvoke = getMockInvoke();
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("write_sync_evidence_file", {
        contents: expect.any(String),
        defaultFileName: expect.stringMatching(/^tuneforge-sync-evidence-.+\.json$/),
      }),
    );
    const writeCall = mockInvoke.mock.calls.find(([command]) => command === "write_sync_evidence_file");
    expect(writeCall).toBeDefined();
    const exportedText = (writeCall?.[1] as { contents: string }).contents;
    const exportedJson = JSON.parse(exportedText) as Record<string, unknown>;
    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith(exportedText));
    expect(await screen.findByText("Sync evidence exported and copied.")).toBeInTheDocument();
    expect(browserWriteText).not.toHaveBeenCalled();
    expect(exportedJson.scenario).toBe("listener-last-sync");
    expect(exportedJson.run).toMatchObject({
      label: "Run 1",
      hasRunId: true,
      hasSessionId: true,
      status: "completed",
    });
    expect(JSON.stringify(exportedJson)).not.toContain("proj_tauri_export");
    expect(JSON.stringify(exportedJson)).not.toContain("device_peer_1");
  });

  it("keeps verified export success when opportunistic native copy fails", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    mockClipboardWriteText.mockRejectedValue(new Error("Clipboard unavailable at /private/provider"));
    setEvidenceSyncResult("export_copy_failure");

    await openSyncTab(user);
    await user.click(screen.getByRole("button", { name: "Export Evidence" }));

    expect(await screen.findByText("Sync evidence exported.")).toBeInTheDocument();
    expect(screen.queryByText(/Could not copy sync evidence/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private\/provider/)).not.toBeInTheDocument();
  });

  it("keeps canceled Tauri evidence export quiet", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const mockInvoke = getMockInvoke();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "write_sync_evidence_file") {
        return false;
      }
      return defaultInvoke(command, args);
    });
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_tauri_cancel",
        session_id: "sync_session_tauri_cancel",
        project_results: [
          {
            project_id: "proj_tauri_cancel",
            status: "imported",
            message: "Imported proj_tauri_cancel.",
            imported_count: 1,
          },
        ],
      }),
    });

    try {
      await openSyncTab(user);
      await user.click(screen.getByRole("button", { name: "Export Evidence" }));

      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith(
        "write_sync_evidence_file",
        expect.objectContaining({ defaultFileName: expect.any(String) }),
      ));
      expect(mockClipboardWriteText).not.toHaveBeenCalled();
      expect(screen.queryByText(/Sync evidence exported/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Could not export sync evidence/)).not.toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("shows retryable Tauri evidence export errors without native paths", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const mockInvoke = getMockInvoke();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "write_sync_evidence_file") {
        throw new Error("Could not write sync evidence file: /Users/test/private/sync.json");
      }
      return defaultInvoke(command, args);
    });
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: listenerEndpointHints,
      last_sync: syncRunStatus({
        run_id: "sync_run_tauri_error",
        session_id: "sync_session_tauri_error",
        project_results: [
          {
            project_id: "proj_tauri_error",
            status: "imported",
            message: "Imported proj_tauri_error.",
            imported_count: 1,
          },
        ],
      }),
    });

    try {
      await openSyncTab(user);
      await user.click(screen.getByRole("button", { name: "Export Evidence" }));

      expect(
        await screen.findByText("Could not export sync evidence. Choose another location and try again."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/\/Users\/test\/private/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Sync evidence exported/)).not.toBeInTheDocument();
      expect(mockClipboardWriteText).not.toHaveBeenCalled();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("exports the latest sync now result when listener last_sync is hidden", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        status: "completed",
        message: "Listener sync completed first.",
        project_results: [
          {
            project_id: "proj_listener_old",
            status: "imported",
            message: "Old listener result.",
          },
        ],
        manifest_errors: [],
        received_artifacts: [],
      },
    });
    mockSyncTrustedPeerNow.mockResolvedValueOnce(syncRunStatus({
      run_id: "sync_run_now_export",
      session_id: "sync_session_now_export",
      selected_transport: irohTransportId,
      attempted_transports: [irohTransportId],
      status: "completed",
      message: "Sync now imported proj_now_result.",
      project_results: [
        {
          project_id: "proj_now_result",
          status: "imported",
          message: "Imported proj_now_result.",
          imported_count: 1,
        },
      ],
      received_artifacts: [],
      imported_project_count: 1,
    }));

    await openSyncTab(user);

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    expect(await screen.findByText("proj_now_result")).toBeInTheDocument();
    const exportedJson = await exportEvidenceFromCurrentSyncResult(user);

    expect(exportedJson.scenario).toBe("sync-now-result");
    expect(exportedJson.source).toMatchObject({
      kind: "sync_now",
      listenerActive: true,
      listenerStatus: "listening",
    });
    expect(exportedJson.run).toMatchObject({
      status: "completed",
      hasRunId: true,
      hasSessionId: true,
    });
    expect(exportedJson.transport).toMatchObject({
      selected: irohTransportId,
      attempted: [irohTransportId],
    });
    expect(exportedJson.projects).toEqual([
      expect.objectContaining({
        label: "Project 1",
        status: "imported",
        counts: expect.objectContaining({
          imported: 1,
        }),
      }),
    ]);
    expect(JSON.stringify(exportedJson)).not.toContain("proj_listener_old");
    expect(JSON.stringify(exportedJson)).not.toContain("proj_now_result");
  });

  it("shows newer listener sync results after a prior sync now result", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: syncEndpointHints,
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        status: "completed",
        message: "Listener import completed before sync now.",
        project_results: [
          {
            project_id: "proj_listener_old",
            status: "imported",
            message: "Old listener result.",
          },
        ],
        project_results_complete: true,
        manifest_errors: [],
        manifest_errors_complete: true,
        received_artifacts: [],
        received_artifacts_complete: true,
        served_artifact_requests: 0,
        local_manifest_count: 0,
        remote_manifest_count: 1,
      },
    });
    await openSyncTab(user);

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    expect(await screen.findAllByText(defaultSyncNowCanonicalSummary)).not.toHaveLength(0);
    expect(screen.queryByText("Manifest exchange completed with 4 project results.")).not.toBeInTheDocument();
    expect(screen.getByText("proj_imported")).toBeInTheDocument();

    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: syncEndpointHints,
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
        status: "completed",
        message: "Listener import completed after sync now.",
        project_results: [
          {
            project_id: "proj_listener_new",
            status: "imported",
            message: "New listener result.",
          },
        ],
        project_results_complete: true,
        manifest_errors: [],
        manifest_errors_complete: true,
        received_artifacts: [],
        received_artifacts_complete: true,
        served_artifact_requests: 0,
        local_manifest_count: 0,
        remote_manifest_count: 1,
      },
    });
    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(pairingPayload({ device_id: "device_peer_2" })) },
    });
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));

    expect(await screen.findByText(importedOneRemoteCanonicalSummary)).toBeInTheDocument();
    expect(screen.getByText("proj_listener_new")).toBeInTheDocument();
    expect(screen.queryByText("proj_imported")).not.toBeInTheDocument();
  });

  it("shows project links and pending queue positions in queue order", async () => {
    setProjects([
      project({ id: "proj_1", display_name: "Ambient Wash" }),
      project({ id: "proj_2", display_name: "Bass Drill" }),
    ]);
    setJobs([
      job({
        id: "job_done",
        project_id: "proj_1",
        type: "lyrics",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:25:00.000Z",
        created_at: "2026-04-18T13:05:00.000Z",
        updated_at: "2026-04-18T13:25:00.000Z",
      }),
      job({
        id: "job_pending_2",
        project_id: null,
        type: "export",
        status: "pending",
        progress: 0,
        created_at: "2026-04-18T13:20:00.000Z",
        updated_at: "2026-04-18T13:20:00.000Z",
      }),
      job({
        id: "job_running",
        project_id: "proj_2",
        type: "stems",
        status: "running",
        progress: 42,
        stem_model: "htdemucs_6s",
        stem_model_label: "Default (6 stems model)",
        runtime_device: "mps",
        started_at: "2026-04-18T13:22:00.000Z",
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
      job({
        id: "job_pending_1",
        project_id: "proj_1",
        type: "chords",
        status: "pending",
        progress: 0,
        chord_backend: "tuneforge-fast",
        chord_source: "source",
        created_at: "2026-04-18T13:10:00.000Z",
        updated_at: "2026-04-18T13:10:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const queue = await screen.findByRole("list", { name: "Job queue" });
    const rows = within(queue).getAllByRole("article");

    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "stems running job",
      "chords pending job",
      "export pending job",
      "lyrics completed job",
    ]);
    expect(within(rows[0]).getByRole("link", { name: "Open Bass Drill project" })).toHaveAttribute(
      "href",
      "/projects/proj_2",
    );
    expect(within(rows[0]).getByText("Running")).toHaveClass("activity-job-row__stage");
    expect(within(rows[0]).getByText("MPS")).toHaveClass("activity-job-row__runtime");
    expect(within(rows[0]).getByText("Default (6 stems model)")).toHaveClass("activity-job-row__details");
    expect(within(rows[1]).getByRole("link", { name: "Open Ambient Wash project" })).toHaveAttribute(
      "href",
      "/projects/proj_1",
    );
    expect(within(rows[1]).getByText("Queue #1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("built-in / source")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Queue #2")).toBeInTheDocument();
    expect(within(rows[2]).getByText("No project")).toBeInTheDocument();
  });

  it("shows reported running stages before progress with runtime metadata", async () => {
    setJobs([
      job({
        id: "job_running_stage",
        project_id: "proj_123",
        type: "stems",
        status: "running",
        progress: 42,
        stage_label: "Separating stems.",
        stem_model: "htdemucs_6s",
        stem_model_label: "Default (6 stems model)",
        runtime_device: "mps",
        runtime_detail: "CPU fallback after accelerator became unavailable.",
        started_at: "2026-04-18T13:22:00.000Z",
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "stems running job" });
    const stage = within(row).getByText("Separating stems");
    const rowText = row.textContent ?? "";

    expect(stage).toHaveClass("activity-job-row__stage");
    expect(stage.closest(".activity-job-row__stage-line")).toHaveClass("activity-job-row__stage-line--active");
    expect(rowText.indexOf("Separating stems")).toBeLessThan(rowText.indexOf("42%"));
    expect(within(row).getByRole("status", { name: /Current stage: Separating stems/ })).toBeInTheDocument();
    expect(within(row).getByText("MPS / CPU fallback after accelerator became unavailable.")).toHaveClass(
      "activity-job-row__runtime",
    );
    expect(within(row).getByText("Default (6 stems model)")).toBeInTheDocument();
    expect(within(row).queryByText("Default (6 stems model) / MPS")).not.toBeInTheDocument();
  });

  it("shows lyrics transcription progress without raw runtime output", async () => {
    setJobs([
      job({
        id: "job_lyrics_transcribing",
        project_id: "proj_123",
        type: "lyrics",
        status: "running",
        progress: 68,
        stage_label: "Transcribing lyrics.",
        lyrics_source: "vocals",
        runtime_device: "cuda",
        runtime_detail: "stderr: /Users/example/song.wav ETA 00:12",
        started_at: "2026-04-18T13:22:00.000Z",
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "lyrics running job" });
    const progressBar = within(row).getByRole("progressbar", { name: "lyrics job progress" });

    expect(within(row).getByText("Transcribing lyrics")).toHaveClass("activity-job-row__stage");
    expect(within(row).getByText("68%")).toBeInTheDocument();
    expect(progressBar).toHaveAttribute("value", "68");
    expect(progressBar).toHaveAttribute("max", "100");
    expect(within(row).getByText("CUDA")).toHaveClass("activity-job-row__runtime");
    expect(row).not.toHaveTextContent(/stderr|song\.wav|ETA/i);
  });

  it("does not duplicate device text when reported stages already include it", async () => {
    setJobs([
      job({
        id: "job_running_stage_device",
        project_id: "proj_123",
        type: "analyze",
        status: "running",
        progress: 42,
        beat_backend: "beat-this",
        runtime_device: "cpu",
        stage_label: "Running advanced beat analysis on CPU.",
        started_at: "2026-04-18T13:22:00.000Z",
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "analyze running job" });
    expect(within(row).getByText("Running advanced beat analysis")).toHaveClass("activity-job-row__stage");
    expect(within(row).getByText("CPU")).toHaveClass("activity-job-row__runtime");
    expect(within(row).queryByText("Running advanced beat analysis on CPU.")).not.toBeInTheDocument();
  });

  it("drops unsafe runtime detail text in job rows", async () => {
    setJobs([
      job({
        id: "job_running_unsafe_runtime_detail",
        project_id: "proj_123",
        type: "stems",
        status: "running",
        progress: 42,
        stage_label: "Separating stems.",
        runtime_device: "mps",
        runtime_detail: "stderr: song.wav failed",
        started_at: "2026-04-18T13:22:00.000Z",
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "stems running job" });
    expect(within(row).getByText("MPS")).toHaveClass("activity-job-row__runtime");
    expect(within(row).queryByText(/song\.wav/)).not.toBeInTheDocument();
  });

  it("shows waiting fallback for pending jobs without a stage label", async () => {
    setJobs([
      job({
        id: "job_pending_no_stage",
        project_id: null,
        type: "export",
        status: "pending",
        progress: 0,
        runtime_detail: null,
        runtime_device: null,
        stage: null,
        stage_label: null,
        created_at: "2026-04-18T13:20:00.000Z",
        updated_at: "2026-04-18T13:20:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "export pending job" });
    expect(within(row).getByText("Waiting to start")).toHaveClass("activity-job-row__stage");
    expect(within(row).getByText("0%")).toBeInTheDocument();
  });

  it("shows terminal stage text without duplicating lifecycle status", async () => {
    setJobs([
      job({
        id: "job_completed_stage",
        project_id: "proj_123",
        type: "lyrics",
        status: "completed",
        progress: 100,
        duration_seconds: 1.8,
        lyrics_source: "vocals",
        runtime_device: "cpu",
        stage_label: "Saving lyrics.",
        completed_at: "2026-04-18T13:25:00.000Z",
        created_at: "2026-04-18T13:24:58.200Z",
        updated_at: "2026-04-18T13:25:00.000Z",
      }),
      job({
        id: "job_failed_stage",
        project_id: "proj_123",
        type: "stems",
        status: "failed",
        progress: 45,
        error_message: "Could not finish stems.",
        runtime_device: "mps",
        stage_label: "Separating stems.",
        stem_model: "htdemucs_6s",
        stem_model_label: "Default (6 stems model)",
        created_at: "2026-04-18T13:21:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
      job({
        id: "job_cancelled_stage",
        project_id: "proj_123",
        type: "chords",
        status: "cancelled",
        progress: 35,
        chord_backend: "crema-advanced",
        chord_source: "source",
        runtime_device: "cpu",
        stage_label: "Detecting chords.",
        created_at: "2026-04-18T13:20:00.000Z",
        updated_at: "2026-04-18T13:22:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const completedRow = await screen.findByRole("article", { name: "lyrics completed job" });
    const completedStage = within(completedRow).getByText("Saved lyrics");
    expect(completedStage).toHaveClass("activity-job-row__stage");
    expect(completedStage.closest(".activity-job-row__stage-line")).toHaveClass(
      "activity-job-row__stage-line--terminal",
    );
    expect(within(completedRow).getByText("CPU")).toHaveClass("activity-job-row__runtime");
    expect(within(completedRow).getByText("vocals / 1.8 s")).toBeInTheDocument();
    expect(within(completedRow).queryByText("Completed.")).not.toBeInTheDocument();
    expect(within(completedRow).queryByText(/Last stage:/)).not.toBeInTheDocument();
    expect(within(completedRow).queryByText("Saving lyrics.")).not.toBeInTheDocument();

    const failedRow = await screen.findByRole("article", { name: "stems failed job" });
    const failedStage = within(failedRow).getByText("Separating stems");
    expect(failedStage).toHaveClass("activity-job-row__stage");
    expect(failedStage.closest(".activity-job-row__stage-line")).toHaveClass(
      "activity-job-row__stage-line--terminal",
    );
    expect(within(failedRow).queryByText(/Last stage:/)).not.toBeInTheDocument();
    expect(within(failedRow).getByText("Default (6 stems model)")).toBeInTheDocument();
    expect(within(failedRow).getByRole("alert")).toHaveTextContent("Could not finish stems.");

    const cancelledRow = await screen.findByRole("article", { name: "chords cancelled job" });
    const cancelledStage = within(cancelledRow).getByText("Detecting chords");
    expect(cancelledStage).toHaveClass("activity-job-row__stage");
    expect(cancelledStage.closest(".activity-job-row__stage-line")).toHaveClass(
      "activity-job-row__stage-line--terminal",
    );
    expect(within(cancelledRow).queryByText(/Last stage:/)).not.toBeInTheDocument();
    expect(within(cancelledRow).getByText("advanced / source")).toBeInTheDocument();
  });

  it("shows dependency job errors without raw output or paths", async () => {
    setJobs([
      job({
        id: "job_stems_missing_demucs",
        project_id: "proj_123",
        type: "stems",
        status: "failed",
        progress: 45,
        error_message: "Demucs is required for stem separation. stderr: /Users/test/Music/Secret Demo.wav",
        stem_model: "htdemucs_6s",
        stem_model_label: "Default (6 stems model)",
        created_at: "2026-04-18T13:21:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "stems failed job" });
    const alert = within(row).getByRole("alert");
    expect(alert).toHaveTextContent(
      "Demucs is required for stem separation. Dependency: Demucs. Next: Install local backend stem dependencies, then retry stem separation.",
    );
    expect(alert).not.toHaveTextContent(/stderr|Secret Demo|Users|\.wav/i);
  });

  it("renders old jobs with null stage and runtime fields", async () => {
    setJobs([
      job({
        id: "job_old_null_fields",
        project_id: "proj_123",
        type: "preview",
        status: "completed",
        progress: 100,
        runtime_detail: null,
        runtime_device: null,
        stage: null,
        stage_label: null,
        completed_at: "2026-04-18T13:25:00.000Z",
        created_at: "2026-04-18T13:24:58.200Z",
        updated_at: "2026-04-18T13:25:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "preview completed job" });
    expect(within(row).getByText("completed")).toBeInTheDocument();
    expect(within(row).queryByText("Waiting to start")).not.toBeInTheDocument();
  });

  it("shows beat analysis backend, runtime, and duration on analysis jobs", async () => {
    setJobs([
      job({
        id: "job_analysis",
        project_id: "proj_123",
        type: "analyze",
        status: "completed",
        progress: 100,
        beat_backend: "beat-this",
        runtime_device: "cpu",
        duration_seconds: 1.8,
        completed_at: "2026-04-18T13:25:00.000Z",
        created_at: "2026-04-18T13:24:58.200Z",
        updated_at: "2026-04-18T13:25:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const row = await screen.findByRole("article", { name: "analyze completed job" });
    expect(within(row).getByText("advanced / source / CPU / 1.8 s")).toBeInTheDocument();
  });

  it("loads additional terminal history pages on request", async () => {
    const user = userEvent.setup();
    setJobs(terminalHistoryJobs(55));

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "history_055 completed job" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more history" }));

    expect(await screen.findByRole("article", { name: "history_055 completed job" })).toBeInTheDocument();
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      sort_by: "activity",
      limit: 50,
      offset: 50,
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more history" })).not.toBeInTheDocument(),
    );
  });

  it("paginates terminal history after activity sorting", async () => {
    const user = userEvent.setup();
    setJobs([
      ...Array.from({ length: 50 }, (_, index) => {
        const jobNumber = index + 1;
        const timestamp = `2026-04-18T12:${String(50 - jobNumber).padStart(2, "0")}:00.000Z`;
        return job({
          id: `job_history_old_${String(jobNumber).padStart(3, "0")}`,
          type: `history_old_${String(jobNumber).padStart(3, "0")}`,
          status: "completed",
          progress: 100,
          completed_at: timestamp,
          created_at: "2026-04-18T12:00:00.000Z",
          updated_at: timestamp,
        });
      }),
      job({
        id: "job_history_tie_a",
        type: "history_tie_a",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:59:00.000Z",
        created_at: "2026-04-18T13:00:00.000Z",
        updated_at: "2026-04-18T13:59:00.000Z",
      }),
      job({
        id: "job_history_tie_b",
        type: "history_tie_b",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:59:00.000Z",
        created_at: "2026-04-18T13:00:00.000Z",
        updated_at: "2026-04-18T13:59:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_tie_b completed job" })).toBeInTheDocument();
    const queue = await screen.findByRole("list", { name: "Job queue" });
    const rows = within(queue).getAllByRole("article");
    expect(rows.slice(0, 2).map((row) => row.getAttribute("aria-label"))).toEqual([
      "history_tie_b completed job",
      "history_tie_a completed job",
    ]);
    expect(screen.queryByRole("article", { name: "history_old_050 completed job" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more history" }));

    expect(await screen.findByRole("article", { name: "history_old_050 completed job" })).toBeInTheDocument();
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      sort_by: "activity",
      limit: 50,
      offset: 50,
    });
  });

  it("loads additional terminal history pages when the history sentinel intersects", async () => {
    setJobs(terminalHistoryJobs(55));

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "history_055 completed job" })).not.toBeInTheDocument();

    act(() => {
      triggerMockIntersectionObserver();
    });

    expect(await screen.findByRole("article", { name: "history_055 completed job" })).toBeInTheDocument();
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      sort_by: "activity",
      limit: 50,
      offset: 50,
    });
  });

  it("rebinds the history sentinel after returning to the Jobs tab", async () => {
    const user = userEvent.setup();
    setJobs(terminalHistoryJobs(55));

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "history_055 completed job" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Sync" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();

    act(() => {
      triggerMockIntersectionObserver();
    });

    expect(mockListJobs.mock.calls.filter(([params]) => params?.offset === 50)).toHaveLength(0);

    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();

    act(() => {
      triggerMockIntersectionObserver();
    });

    expect(await screen.findByRole("article", { name: "history_055 completed job" })).toBeInTheDocument();
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      sort_by: "activity",
      limit: 50,
      offset: 50,
    });
  });

  it("keeps failed terminal history page loads on manual retry only", async () => {
    const user = userEvent.setup();
    const defaultListJobsImplementation = mockListJobs.getMockImplementation();
    if (!defaultListJobsImplementation) {
      throw new Error("Expected list jobs mock implementation.");
    }
    let rejectNextHistoryPage = true;
    const getHistoryPageRequestCount = () =>
      mockListJobs.mock.calls.filter(([params]) => params?.offset === 50).length;
    mockListJobs.mockImplementation(async (params) => {
      if (params?.offset === 50 && rejectNextHistoryPage) {
        rejectNextHistoryPage = false;
        throw new Error("History page failed.");
      }

      return defaultListJobsImplementation(params);
    });
    setJobs(terminalHistoryJobs(55));

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "history_055 completed job" })).not.toBeInTheDocument();

    act(() => {
      triggerMockIntersectionObserver();
    });

    await waitFor(() => expect(getHistoryPageRequestCount()).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load more history" })).toBeEnabled(),
    );

    act(() => {
      triggerMockIntersectionObserver();
      triggerMockIntersectionObserver();
    });

    expect(getHistoryPageRequestCount()).toBe(1);

    await user.click(screen.getByRole("button", { name: "Load more history" }));

    expect(await screen.findByRole("article", { name: "history_055 completed job" })).toBeInTheDocument();
    expect(getHistoryPageRequestCount()).toBe(2);
  });

  it("waits for terminal history refetch to settle before sentinel page loads", async () => {
    const defaultListJobsImplementation = mockListJobs.getMockImplementation();
    if (!defaultListJobsImplementation) {
      throw new Error("Expected list jobs mock implementation.");
    }
    let terminalFirstPageRequests = 0;
    let resolveTerminalRefetch: () => void = () => {
      throw new Error("Terminal history refetch did not start.");
    };
    const getHistoryPageRequestCount = () =>
      mockListJobs.mock.calls.filter(([params]) => params?.offset === 50).length;
    mockListJobs.mockImplementation(async (params) => {
      const isTerminalFirstPage =
        params?.offset === 0 &&
        Array.isArray(params.status) &&
        params.status.includes("completed") &&
        params.status.includes("failed") &&
        params.status.includes("cancelled");
      if (isTerminalFirstPage) {
        terminalFirstPageRequests += 1;
      }

      if (isTerminalFirstPage && terminalFirstPageRequests === 2) {
        return new Promise((resolve) => {
          resolveTerminalRefetch = () => {
            resolve(defaultListJobsImplementation(params));
          };
        });
      }

      return defaultListJobsImplementation(params);
    });
    setJobs(terminalHistoryJobs(55));

    const { queryClient } = renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "history_055 completed job" })).not.toBeInTheDocument();

    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", "activity", "terminal"] });
    });

    await waitFor(() => expect(terminalFirstPageRequests).toBe(2));

    act(() => {
      triggerMockIntersectionObserver();
    });

    expect(getHistoryPageRequestCount()).toBe(0);

    await act(async () => {
      resolveTerminalRefetch();
    });
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: ["jobs", "activity", "terminal"] })).toBe(0),
    );

    act(() => {
      triggerMockIntersectionObserver();
    });

    expect(await screen.findByRole("article", { name: "history_055 completed job" })).toBeInTheDocument();
    expect(getHistoryPageRequestCount()).toBe(1);
  });

  it("keeps loaded history visible while new project details are loading", async () => {
    const user = userEvent.setup();
    let resolveSlowProject: () => void = () => {
      throw new Error("Slow project lookup did not start.");
    };
    const defaultGetProjectImplementation = mockGetProject.getMockImplementation();
    mockGetProject.mockImplementation(
      async (projectId: string) =>
        new Promise((resolve) => {
          if (projectId === "proj_slow_history") {
            resolveSlowProject = () =>
              resolve({ project: project({ id: projectId, display_name: "Slow History Project" }) as ProjectSchema });
            return;
          }
          resolve({ project: project({ id: projectId }) as ProjectSchema });
        }),
    );
    try {
      setJobs(
        Array.from({ length: 51 }, (_, index) => {
          const jobNumber = index + 1;
          return job({
            id: `job_history_${String(jobNumber).padStart(3, "0")}`,
            project_id: jobNumber === 51 ? "proj_slow_history" : null,
            type: `history_${String(jobNumber).padStart(3, "0")}`,
            status: "completed",
            progress: 100,
            completed_at: `2026-04-18T13:${String(59 - index).padStart(2, "0")}:00.000Z`,
            created_at: "2026-04-18T13:00:00.000Z",
            updated_at: `2026-04-18T13:${String(59 - index).padStart(2, "0")}:00.000Z`,
          });
        }),
      );

      renderApp(["/activity"]);

      expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Load more history" }));

      const loadedRow = await screen.findByRole("article", { name: "history_051 completed job" });
      expect(within(loadedRow).getByRole("link", { name: "Open proj_slow_history project" })).toHaveAttribute(
        "href",
        "/projects/proj_slow_history",
      );
      expect(screen.queryByText("Loading jobs...")).not.toBeInTheDocument();

      resolveSlowProject();
      expect(
        await within(loadedRow).findByRole("link", { name: "Open Slow History Project project" }),
      ).toHaveAttribute("href", "/projects/proj_slow_history");
    } finally {
      if (defaultGetProjectImplementation) {
        mockGetProject.mockImplementation(defaultGetProjectImplementation);
      }
    }
  });

  it("cancels pending jobs and refreshes the queue", async () => {
    const user = userEvent.setup();
    setJobs([
      job({
        id: "job_pending",
        type: "analyze",
        status: "pending",
        progress: 0,
        created_at: "2026-04-18T13:10:00.000Z",
        updated_at: "2026-04-18T13:10:00.000Z",
      }),
      job({
        id: "job_completed",
        type: "preview",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:20:00.000Z",
        created_at: "2026-04-18T13:05:00.000Z",
        updated_at: "2026-04-18T13:20:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const pendingRow = await screen.findByRole("article", { name: "analyze pending job" });
    const completedRow = await screen.findByRole("article", { name: "preview completed job" });
    expect(within(completedRow).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    const initialListJobsCalls = mockListJobs.mock.calls.length;

    await user.click(within(pendingRow).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mockCancelJob).toHaveBeenCalledWith("job_pending"));
    await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(initialListJobsCalls));
    expect(await screen.findByRole("article", { name: "analyze cancelled job" })).toBeInTheDocument();
  });

  it("requires confirmation before starting a bulk job action", async () => {
    const user = userEvent.setup();
    let approveConfirm: ((value: boolean) => void) | null = null;
    mockConfirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          approveConfirm = resolve;
        }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Analyze all projects" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringContaining("may use CPU/GPU heavily"),
      expect.objectContaining({
        title: "Analyze all projects",
        okLabel: "Analyze all",
        cancelLabel: "Cancel",
      }),
    );
    expect(mockBulkJobs).not.toHaveBeenCalled();

    await act(async () => {
      approveConfirm?.(true);
    });

    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({ job_type: "analyze", beat_backend: "beat-this" }),
    );
  });

  it("does not enqueue a bulk job action when confirmation is cancelled", async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce(false);

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh chords for all projects" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockBulkJobs).not.toHaveBeenCalled();
  });

  it("shows a bulk job success summary and refreshes jobs", async () => {
    const user = userEvent.setup();
    setProjects([
      project({ id: "proj_bulk_1", display_name: "Bulk Song 1" }),
      project({ id: "proj_bulk_2", display_name: "Bulk Song 2" }),
      project({ id: "proj_bulk_3", display_name: "Bulk Song 3" }),
    ]);
    setJobs([]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await waitFor(() => expect(mockListJobs).toHaveBeenCalledTimes(2));
    const initialListJobsCalls = mockListJobs.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Refresh lyrics for all projects" }));

    await waitFor(() => expect(mockBulkJobs).toHaveBeenCalledWith({ job_type: "lyrics" }));
    expect(await screen.findByText("Lyrics jobs: 3 queued, 0 skipped.")).toBeInTheDocument();
    await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(initialListJobsCalls));
  });

  it("shows grouped skip details for partial bulk job success", async () => {
    const user = userEvent.setup();
    setProjects([
      project({ id: "proj_bulk_skip", display_name: "Busy Song" }),
      project({ id: "proj_bulk_queue", display_name: "Queued Song" }),
    ]);
    setJobs([
      job({
        id: "job_active_bulk_lyrics",
        project_id: "proj_bulk_skip",
        type: "lyrics",
        status: "running",
        progress: 40,
      }),
    ]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh lyrics for all projects" }));

    expect(await screen.findByText("Lyrics jobs: 1 queued, 1 skipped.")).toBeInTheDocument();
    const skippedProjects = screen.getByLabelText("Skipped projects");
    expect(within(skippedProjects).getByText("Already active:")).toBeInTheDocument();
    expect(within(skippedProjects).getByText("Busy Song (proj_bulk_skip)")).toBeInTheDocument();
  });

  it("shows skip details when every bulk job project is skipped", async () => {
    const user = userEvent.setup();
    setProjects([
      project({ id: "proj_bulk_skip_a", display_name: "Busy Song A" }),
      project({ id: "proj_bulk_skip_b", display_name: "Busy Song B" }),
    ]);
    setJobs([
      job({
        id: "job_active_bulk_lyrics_a",
        project_id: "proj_bulk_skip_a",
        type: "lyrics",
        status: "pending",
        progress: 0,
      }),
      job({
        id: "job_active_bulk_lyrics_b",
        project_id: "proj_bulk_skip_b",
        type: "lyrics",
        status: "running",
        progress: 30,
      }),
    ]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh lyrics for all projects" }));

    expect(await screen.findByText("Lyrics jobs: 0 queued, 2 skipped.")).toBeInTheDocument();
    const skippedProjects = screen.getByLabelText("Skipped projects");
    expect(within(skippedProjects).getByText("Already active:")).toBeInTheDocument();
    expect(within(skippedProjects).getByText(/Busy Song A \(proj_bulk_skip_a\)/)).toBeInTheDocument();
    expect(within(skippedProjects).getByText(/Busy Song B \(proj_bulk_skip_b\)/)).toBeInTheDocument();
  });

  it("uses default beat, chord, and stem preferences for bulk refresh actions", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultBeatAnalysisBackend: "beat-this",
        defaultChordBackend: "crema-advanced",
        defaultDurableAudioFormat: "m4a",
        defaultStemModel: "htdemucs_ft",
      }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Analyze all projects" }));
    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({
        job_type: "analyze",
        beat_backend: "beat-this",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Refresh chords for all projects" }));
    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({
        job_type: "chords",
        chord_backend: "crema-advanced",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Refresh existing stems" }));
    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({
        job_type: "stems",
        output_format: "m4a",
        chord_backend: "crema-advanced",
        stem_model: "htdemucs_ft",
      }),
    );
  });

  it.each([
    ["wav", "WAV/PCM", false],
    ["flac", "FLAC", false],
    ["mp3", "MP3 (192 kbps)", true],
    ["m4a", "M4A (AAC-LC, 192 kbps)", true],
  ] as const)("re-processes durable audio as %s", async (format, confirmationLabel, lossy) => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultDurableAudioFormat: format }),
    );

    renderApp(["/activity"]);

    const action = await screen.findByRole("button", {
      name: `Re-process existing audio as ${format.toUpperCase()}`,
    });
    await user.click(action);

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringContaining(lossy ? "conversion is lossy" : `Target format: ${confirmationLabel}`),
      expect.objectContaining({
        title: `Re-process existing audio as ${confirmationLabel}`,
        okLabel: "Re-process audio",
      }),
    );
    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({
        job_type: "convert_audio",
        output_format: format,
      }),
    );
  });

  it("hides durable audio re-processing on Android", async () => {
    const userAgent = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15)");
    try {
      renderApp(["/activity"]);

      expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Re-process existing audio as/ })).not.toBeInTheDocument();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("falls back to built-in beats for bulk analyze when advanced beats are unavailable", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultBeatAnalysisBackend: "beat-this" }),
    );
    setBeatBackends([
      { id: "built-in", available: true },
      { id: "beat-this", available: false },
    ]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Analyze all projects" }));

    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({
        job_type: "analyze",
        beat_backend: "built-in",
      }),
    );
  });

  it("uses chord backend fallback preferences for bulk stem refresh", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultChordBackend: "crema-advanced",
        defaultStemModel: "htdemucs_ft",
      }),
    );
    setChordBackends([
      { id: "tuneforge-fast", available: true },
      { id: "crema-advanced", available: false },
    ]);

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh existing stems" }));

    await waitFor(() =>
      expect(mockBulkJobs).toHaveBeenCalledWith({
        job_type: "stems",
        output_format: "wav",
        chord_backend: "tuneforge-fast",
        chord_backend_fallback_from: "crema-advanced",
        stem_model: "htdemucs_ft",
      }),
    );
  });

  it("shows bulk job errors without clearing the existing list", async () => {
    const user = userEvent.setup();
    setJobs([
      job({
        id: "job_existing",
        type: "preview",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:20:00.000Z",
      }),
    ]);
    mockBulkJobs.mockRejectedValueOnce(new Error("Bulk enqueue failed."));

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "preview completed job" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh existing stems" }));

    expect(await screen.findByText("Bulk enqueue failed.")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "preview completed job" })).toBeInTheDocument();
  });

  it("refreshes active jobs until they reach a terminal status", async () => {
    const intervalHandlers: Array<() => void | Promise<void>> = [];
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === 1500 && typeof handler === "function") {
          intervalHandlers.push(handler as () => void | Promise<void>);
          return 1500;
        }
        return 1;
      });
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

    try {
      setJobs([
        job({
          id: "job_running",
          project_id: "proj_123",
          type: "stems",
          status: "running",
          progress: 25,
          created_at: "2026-04-18T13:10:00.000Z",
          started_at: "2026-04-18T13:10:30.000Z",
          updated_at: "2026-04-18T13:11:00.000Z",
        }),
      ]);

      renderApp(["/activity"]);

      expect(await screen.findByRole("article", { name: "stems running job" })).toBeInTheDocument();
      await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("proj_123"));
      expect(intervalHandlers).toHaveLength(1);
      const initialListJobsCalls = mockListJobs.mock.calls.length;
      const initialGetProjectCalls = mockGetProject.mock.calls.length;

      await act(async () => {
        await intervalHandlers[0]?.();
      });

      await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(initialListJobsCalls));
      expect(mockGetProject).toHaveBeenCalledTimes(initialGetProjectCalls);
      const listJobsCallsAfterActivePoll = mockListJobs.mock.calls.length;

      setJobs([
        job({
          id: "job_running",
          project_id: "proj_123",
          type: "stems",
          status: "completed",
          progress: 100,
          completed_at: "2026-04-18T13:12:00.000Z",
          created_at: "2026-04-18T13:10:00.000Z",
          started_at: "2026-04-18T13:10:30.000Z",
          updated_at: "2026-04-18T13:12:00.000Z",
        }),
      ]);

      await act(async () => {
        await intervalHandlers[0]?.();
      });

      await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(listJobsCallsAfterActivePoll));
      const completedRow = await screen.findByRole("article", { name: "stems completed job" });
      expect(within(completedRow).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(mockGetProject).toHaveBeenCalledTimes(initialGetProjectCalls);
      expect(clearIntervalSpy).toHaveBeenCalledWith(1500);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
