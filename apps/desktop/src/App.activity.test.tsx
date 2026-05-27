import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileCapabilities } from "@tuneforge/shared-types";
import {
  normalizeSyncTransportStatus,
  type JobSchema,
  type ProjectSchema,
  type SyncPairingPayloadSchema,
} from "./lib/api";
import { encodePairingCode, pairingFingerprint } from "./features/activity/syncPairingCode";
import {
  mockCancelJob,
  mockConfirm,
  mockGetProject,
  mockGetMobileCapabilities,
  mockGetSyncIdentity,
  mockGetSyncTransportStatus,
  mockAnswerSyncPairingOffer,
  mockCreateSyncPairingOffer,
  mockListSyncTrustedPeers,
  getMockInvoke,
  mockStartSyncListener,
  mockStopSyncListener,
  mockScanPairingQrCode,
  mockSyncTrustedPeerNow,
  mockTrustSyncPeer,
  mockListJobs,
  mockBulkJobs,
  mockListProjects,
  renderApp,
  resetAppTestHarness,
  setJobs,
  setBeatBackends,
  setChordBackends,
  setProjects,
  setSyncTransportStatus,
  setSyncTrustedPeers,
  triggerMockIntersectionObserver,
} from "./test/appTestHarness";

const irohTransportId = "tuneforge-sync+iroh";
const tcpTransportId = "tuneforge-sync+tcp";
const irohEndpointHint = `${irohTransportId}://device_peer_1`;
const tcpEndpointHint = `${tcpTransportId}://192.168.1.57:48625`;
const listenerTcpEndpointHint = `${tcpTransportId}://192.168.1.42:48625`;
const nearbyIrohEndpointHint = `${irohTransportId}://device_peer_1?direct=192.168.1.58%3A47620`;
const nearbyTcpEndpointHint = `${tcpTransportId}://192.168.1.58:48625?device_id=device_peer_1&v=1`;
const syncEndpointHints = [irohEndpointHint, tcpEndpointHint];
const listenerEndpointHints = [irohEndpointHint, listenerTcpEndpointHint];
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

async function openSyncTab(user: ReturnType<typeof userEvent.setup>) {
  renderApp(["/activity"]);
  expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Sync" }));

  expect(await screen.findByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();
}

describe("Desktop app activity", () => {
  beforeEach(() => {
    resetAppTestHarness();
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
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Pairing Offer" }));
    expect(await screen.findByLabelText("Local pairing code")).toBeInTheDocument();

    await user.click(screen.getByText("Advanced"));
    expect((screen.getByLabelText("Local pairing offer raw JSON") as HTMLTextAreaElement).value).toContain(
      '"signature": "pair_signature_1"',
    );
    await user.click(screen.getByRole("button", { name: "Copy Raw Offer" }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('"signature": "pair_signature_1"'));

    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(pairingPayload({ device_id: "stale_device" })) },
    });
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent("stale_device");
    fireEvent.change(screen.getByLabelText("Pasted raw JSON payload"), {
      target: { value: JSON.stringify(payload) },
    });
    expect(screen.getByLabelText("Peer pairing code")).toHaveValue("");
    expect(screen.getByLabelText("Peer pairing confirmation")).toHaveTextContent(pairingFingerprint(payload));
    expect(screen.getByLabelText(/Adopt peer sync group for third-device join/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));

    await waitFor(() =>
      expect(mockAnswerSyncPairingOffer).toHaveBeenCalledWith({
        offer: expect.objectContaining({ device_id: "device_peer_1" }),
        endpoint_hints: listenerEndpointHints,
        adopt_sync_group: false,
      }),
    );
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
      within(laptopRow as HTMLElement).getByText((content) => content.includes(nearbyIrohEndpointHint)),
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

  it("runs sync now for a trusted peer", async () => {
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
    expect(within(peerRow as HTMLElement).getByText(syncEndpointHints.join(", "))).toBeInTheDocument();

    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText("Manifest exchange completed with 4 project results.")).not.toHaveLength(0);
    expect(screen.getByText(/Transport Iroh/)).toBeInTheDocument();

    const projectResults = await screen.findByRole("list", { name: "Last sync project results" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(4);
    expect(within(resultRows[0]).getByText("Applied")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("proj_imported")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("Reconciliation apply: 3 applied, 1 satisfied, 0 skipped, 0 failed.")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("Skipped")).toBeInTheDocument();
    expect(within(resultRows[1]).getByText("proj_up_to_date")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("Conflicted")).toBeInTheDocument();
    expect(within(resultRows[2]).getByText("Local lyrics conflict with the trusted peer revision.")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("Failed")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("proj_missing_audio")).toBeInTheDocument();
    expect(within(resultRows[3]).getByText("Peer did not provide the required source audio.")).toBeInTheDocument();
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
        manifest_errors: [],
        received_artifacts: [],
        served_artifact_requests: 0,
        local_manifest_count: 0,
        remote_manifest_count: 2,
      },
    });

    await openSyncTab(user);

    expect(
      await screen.findByText(
        "Exchanged 0 local and 2 remote manifest(s); imported 0 project(s), skipped 0 project(s), failed 2 project(s), received 16 artifact(s).",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Transport Iroh/)).toBeInTheDocument();
    const projectResults = await screen.findByRole("list", { name: "Last sync project results" });
    const resultRows = within(projectResults).getAllByRole("listitem");
    expect(resultRows).toHaveLength(1);
    expect(within(resultRows[0]).getByText("Conflicted")).toBeInTheDocument();
    expect(within(resultRows[0]).getByText("proj_conflicted")).toBeInTheDocument();
    expect(
      within(resultRows[0]).getByText("Entity revision manifest content_sha256 must match payload."),
    ).toBeInTheDocument();
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
        manifest_errors: [],
        received_artifacts: [],
      },
    });
    mockSyncTrustedPeerNow.mockRejectedValueOnce(new Error("Peer unavailable."));

    await openSyncTab(user);

    expect(await screen.findByText("Listener import completed before failed sync now.")).toBeInTheDocument();
    expect(screen.getByText("proj_listener_previous")).toBeInTheDocument();

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText("Sync now failed.")).not.toHaveLength(0);
    expect(screen.queryByText("Listener import completed before failed sync now.")).not.toBeInTheDocument();
    expect(screen.queryByText("proj_listener_previous")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Last sync project results" })).not.toBeInTheDocument();
  });

  it("normalizes sync run identity, timing, counters, and final project rows", () => {
    const normalized = normalizeSyncTransportStatus({
      running: true,
      state: "listening",
      endpointHints: syncEndpointHints,
      fallbackCode: "iroh_unavailable",
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
      status: "completed",
      started_at: "2026-04-18T13:16:00.000Z",
      duration_ms: 1250,
      total_received_bytes: 3_000_000,
      total_served_bytes: 1_000_000,
      time_to_first_artifact_ms: 650,
      throughput_bytes_per_second: 3_200_000,
      imported_project_count: 1,
      skipped_project_count: 1,
      failed_project_count: 0,
    });
    expect(normalized.endpoint_hints).toEqual(syncEndpointHints);
    expect(normalized.fallback_code).toBe("iroh_unavailable");
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
    expect(normalized.last_sync?.project_results).toEqual([
      expect.objectContaining({
        project_id: "proj_staging",
        status: "failed",
        message: "Peer manifest export failed before apply.",
      }),
    ]);
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
        time_to_first_artifact_ms: 450,
        total_received_bytes: 3_000_000,
        total_served_bytes: 1_000_000,
        throughput_bytes_per_second: 2_500_000,
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

    expect(await screen.findByText("Retry completed after staged bytes were reused.")).toBeInTheDocument();
    expect(screen.getByText(/Run sync_run_retry_2/)).toBeInTheDocument();
    expect(screen.getByText(/Duration 1\.4 s/)).toBeInTheDocument();
    expect(screen.getByText(/Transport TCP/)).toBeInTheDocument();
    expect(screen.getByText(/Fallback: Iroh endpoint was unavailable; used TCP\./)).toBeInTheDocument();
    expect(screen.getByText(/1 imported, 1 skipped, 0 failed/)).toBeInTheDocument();
    expect(screen.getByText(/TTFA 450 ms/)).toBeInTheDocument();
    expect(screen.getByText(/4\.0 MB total/)).toBeInTheDocument();
    expect(screen.getByText(/2\.5 MB\/s/)).toBeInTheDocument();

    const projectResults = await screen.findByRole("list", { name: "Last sync project results" });
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
        manifest_errors: [],
        received_artifacts: [],
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

    expect(await screen.findAllByText("Manifest exchange completed with 4 project results.")).not.toHaveLength(0);
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
        manifest_errors: [],
        received_artifacts: [],
        served_artifact_requests: 0,
        local_manifest_count: 0,
        remote_manifest_count: 1,
      },
    });
    fireEvent.change(screen.getByLabelText("Peer pairing code"), {
      target: { value: encodePairingCode(pairingPayload({ device_id: "device_peer_2" })) },
    });
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));

    expect(await screen.findByText("Listener import completed after sync now.")).toBeInTheDocument();
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
    expect(within(rows[0]).getByText("Default (6 stems model) / MPS")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "Open Ambient Wash project" })).toHaveAttribute(
      "href",
      "/projects/proj_1",
    );
    expect(within(rows[1]).getByText("Queue #1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("built-in / source")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Queue #2")).toBeInTheDocument();
    expect(within(rows[2]).getByText("No project")).toBeInTheDocument();
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
    expect(within(row).getByText("advanced / CPU / 1.8 s")).toBeInTheDocument();
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
      expect(mockBulkJobs).toHaveBeenCalledWith({ job_type: "analyze", beat_backend: "built-in" }),
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
        chord_backend: "crema-advanced",
        stem_model: "htdemucs_ft",
      }),
    );
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
