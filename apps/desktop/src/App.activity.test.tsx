import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSchema, ProjectSchema } from "./lib/api";
import {
  mockCancelJob,
  mockGetSyncIdentity,
  mockGetSyncTransportStatus,
  mockAnswerSyncPairingOffer,
  mockListSyncTrustedPeers,
  mockStartSyncListener,
  mockStopSyncListener,
  mockSyncTrustedPeerNow,
  mockTrustSyncPeer,
  mockListJobs,
  mockListProjects,
  renderApp,
  resetAppTestHarness,
  setJobs,
  setProjects,
  setSyncTrustedPeers,
} from "./test/appTestHarness";

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

function pairingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sync_group_id: "sync_group_local",
    device_id: "device_peer_1",
    display_name: "Laptop Rig",
    public_key: "pub_peer_1",
    endpoint_hints: ["tcp://192.168.1.57:48625"],
    protocol_version: "tuneforge-sync-v1",
    pairing_offer_id: "pair_offer_peer_1",
    pairing_secret: "pair_secret_peer_1",
    expires_at: "2026-04-18T13:26:00.000Z",
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
    expect(mockListProjects).toHaveBeenCalled();
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
    await openSyncTab(user);

    fireEvent.change(screen.getByLabelText("Peer offer or response payload"), {
      target: { value: JSON.stringify(payload) },
    });
    await user.click(screen.getByRole("button", { name: "Answer Offer" }));

    await waitFor(() =>
      expect(mockAnswerSyncPairingOffer).toHaveBeenCalledWith({
        offer: expect.objectContaining({ device_id: "device_peer_1" }),
        endpoint_hints: [],
        adopt_sync_group: false,
      }),
    );
    expect(await screen.findByText("Laptop Rig")).toBeInTheDocument();
    expect(
      screen.getByText(/Trusted Laptop Rig\. Pairing response (ready|copied)\./),
    ).toBeInTheDocument();
    expect((screen.getByLabelText("Pairing response") as HTMLTextAreaElement).value).toContain(
      '"device_id": "device_local"',
    );
  });

  it("trusts a peer from a pasted pairing response", async () => {
    const user = userEvent.setup();
    const payload = pairingPayload();
    await openSyncTab(user);

    fireEvent.change(screen.getByLabelText("Peer offer or response payload"), {
      target: { value: JSON.stringify(payload) },
    });
    await user.click(screen.getByRole("button", { name: "Trust Response" }));

    await waitFor(() =>
      expect(mockTrustSyncPeer).toHaveBeenCalledWith({
        payload: expect.objectContaining({ device_id: "device_peer_1" }),
        adopt_sync_group: false,
      }),
    );
    expect(await screen.findByText("Laptop Rig")).toBeInTheDocument();
    expect(screen.getByText("Trusted Laptop Rig.")).toBeInTheDocument();
  });

  it("starts and stops the native sync listener", async () => {
    const user = userEvent.setup();
    await openSyncTab(user);

    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Listener" }));

    await waitFor(() => expect(mockStartSyncListener).toHaveBeenCalled());
    expect(await screen.findByText("Listening")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop Listener" }));

    await waitFor(() => expect(mockStopSyncListener).toHaveBeenCalled());
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
  });

  it("runs sync now for a trusted peer", async () => {
    const user = userEvent.setup();
    setSyncTrustedPeers([
      {
        device_id: "device_peer_1",
        sync_group_id: "sync_group_local",
        display_name: "Laptop Rig",
        public_key: "pub_peer_1",
        endpoint_hints: ["tcp://192.168.1.57:48625"],
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    await openSyncTab(user);

    const peers = await screen.findByRole("list", { name: "Trusted sync peers" });
    const peerRow = within(peers).getByText("Laptop Rig").closest("li");
    expect(peerRow).not.toBeNull();

    await user.click(within(peerRow as HTMLElement).getByRole("button", { name: "Sync Now" }));

    await waitFor(() => expect(mockSyncTrustedPeerNow).toHaveBeenCalledWith("device_peer_1"));
    expect(await screen.findAllByText("Manifest exchange completed.")).not.toHaveLength(0);
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
      expect(intervalHandlers).toHaveLength(1);
      const initialListJobsCalls = mockListJobs.mock.calls.length;

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

      await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(initialListJobsCalls));
      const completedRow = await screen.findByRole("article", { name: "stems completed job" });
      expect(within(completedRow).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(clearIntervalSpy).toHaveBeenCalledWith(1500);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
