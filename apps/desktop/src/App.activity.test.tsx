import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSyncTransportStatus, type JobSchema, type ProjectSchema } from "./lib/api";
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
  setSyncTransportStatus,
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

  it("requests active and terminal job pages separately", async () => {
    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { level: 2, name: "Jobs" })).toBeInTheDocument();

    await waitFor(() => expect(mockListJobs).toHaveBeenCalledTimes(2));
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["running", "pending"],
      limit: 200,
      offset: 0,
    });
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      limit: 50,
      offset: 0,
    });
    expect(mockListJobs.mock.calls.some(([params]) => params === undefined)).toBe(false);
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
    expect(await screen.findAllByText("Manifest exchange completed with 4 project results.")).not.toHaveLength(0);

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
      endpoint_hints: ["tcp://192.168.1.57:48625"],
      last_status: "Sync session completed without structured details.",
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
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
        endpoint_hints: ["tcp://192.168.1.57:48625"],
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: ["tcp://192.168.1.57:48625"],
      last_sync: {
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
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
      endpointHints: ["tcp://192.168.1.57:48625"],
      lastSync: {
        runId: "sync_run_retry_2",
        sessionId: "sync_session_retry_2",
        peerDeviceId: "device_peer_1",
        remoteDeviceId: "device_peer_1",
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
        ],
      },
    });

    expect(normalized.last_sync).toMatchObject({
      run_id: "sync_run_retry_2",
      session_id: "sync_session_retry_2",
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
    ]);
    expect(normalized.last_sync?.project_results).toHaveLength(2);
    expect(normalized.last_sync?.project_results[0]).toMatchObject({
      project_id: "proj_retry",
      status: "applied",
      applied_count: 3,
      satisfied_count: 1,
      skipped_count: 0,
      failed_count: 0,
    });
    expect(normalized.last_sync?.project_results[1]).toMatchObject({
      project_id: "proj_deleted",
      status: "deleted",
      deleted_count: 1,
    });
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
      endpoint_hints: ["tcp://192.168.1.57:48625"],
      last_sync: {
        run_id: "sync_run_retry_2",
        session_id: "sync_session_retry_2",
        peer_device_id: "device_peer_1",
        remote_device_id: "device_peer_1",
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
        endpoint_hints: ["tcp://192.168.1.57:48625"],
        trusted_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    setSyncTransportStatus({
      active: true,
      status: "listening",
      endpoint_hints: ["tcp://192.168.1.57:48625"],
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
      endpoint_hints: ["tcp://192.168.1.57:48625"],
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
    fireEvent.change(screen.getByLabelText("Peer offer or response payload"), {
      target: { value: JSON.stringify(pairingPayload({ device_id: "device_peer_2" })) },
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

  it("loads additional terminal history pages on request", async () => {
    const user = userEvent.setup();
    setJobs(
      Array.from({ length: 55 }, (_, index) => {
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
      }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("article", { name: "history_001 completed job" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "history_055 completed job" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more history" }));

    expect(await screen.findByRole("article", { name: "history_055 completed job" })).toBeInTheDocument();
    expect(mockListJobs).toHaveBeenCalledWith({
      status: ["completed", "failed", "cancelled"],
      limit: 50,
      offset: 50,
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more history" })).not.toBeInTheDocument(),
    );
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
