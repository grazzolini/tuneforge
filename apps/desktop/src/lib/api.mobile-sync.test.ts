import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileCapabilities } from "@tuneforge/shared-types";
import type {
  ListJobsParams,
  ProjectImportRequest,
  SyncPairingAnswerRequest,
  SyncPairingOfferRequest,
  SyncPairingPayloadSchema,
  SyncTrustedPeerCreateRequest,
} from "./api";

const { mockConvertFileSrc, mockInvoke } = vi.hoisted(() => ({
  mockConvertFileSrc: vi.fn((path: string) => path),
  mockInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  invoke: mockInvoke,
}));

const mobileCapabilities: MobileCapabilities = {
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

const pairingPayload: SyncPairingPayloadSchema = {
  sync_group_id: "sync_group_1",
  device_id: "device_peer_1",
  display_name: "Phone",
  public_key: "public-key",
  endpoint_hints: ["tuneforge-sync+iroh://device_peer_1"],
  protocol_version: "1",
  pairing_offer_id: "pairing_offer_1",
  pairing_secret: "pairing-secret",
  expires_at: "2026-05-22T12:00:00.000Z",
  signature: "signature",
};

const pairingOfferRequest: SyncPairingOfferRequest = {
  endpoint_hints: ["tuneforge-sync+iroh://device_local"],
  ttl_seconds: 300,
};

const pairingAnswerRequest: SyncPairingAnswerRequest = {
  offer: pairingPayload,
  endpoint_hints: ["tuneforge-sync+tcp://127.0.0.1:48625"],
  adopt_sync_group: true,
};

const trustedPeerRequest: SyncTrustedPeerCreateRequest = {
  payload: pairingPayload,
  adopt_sync_group: false,
};

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  };
};

async function loadMobileApi() {
  const apiModule = await import("./api");
  await apiModule.initializeApi();
  mockInvoke.mockClear();
  return apiModule.api;
}

describe("mobile sync API adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    mockConvertFileSrc.mockClear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "mobile_capabilities") {
        return mobileCapabilities;
      }
      return {};
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: (command: string, args?: Record<string, unknown>, options?: unknown) =>
          mockInvoke(command, args, options),
      },
    });
  });

  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("routes mobile sync pairing and trusted-peer methods to mobile commands", async () => {
    const api = await loadMobileApi();

    await api.getSyncIdentity();
    await api.createSyncPairingOffer(pairingOfferRequest);
    await api.answerSyncPairingOffer(pairingAnswerRequest);
    await api.listSyncTrustedPeers();
    await api.trustSyncPeer(trustedPeerRequest);
    await api.revokeSyncTrustedPeer("device_peer_1");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "mobile_get_sync_identity", undefined);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "mobile_create_sync_pairing_offer", {
      payload: pairingOfferRequest,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "mobile_answer_sync_pairing_offer", {
      payload: pairingAnswerRequest,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "mobile_list_sync_trusted_peers", undefined);
    expect(mockInvoke).toHaveBeenNthCalledWith(5, "mobile_trust_sync_peer", {
      payload: trustedPeerRequest,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(6, "mobile_revoke_sync_trusted_peer", {
      deviceId: "device_peer_1",
    });
  });

  it("routes latest jobs query params to the mobile jobs command", async () => {
    const api = await loadMobileApi();
    const params: ListJobsParams = {
      status: ["completed"],
      search: "needle",
      sort_by: "updated_at",
      sort_order: "asc",
      limit: 10,
      offset: 5,
    };

    await api.listJobs(params);

    expect(mockInvoke).toHaveBeenCalledWith("mobile_list_jobs", { params });
  });

  it("allows built-in mobile import requests", async () => {
    const api = await loadMobileApi();
    const builtInRequest: ProjectImportRequest = {
      source_path: "/music/song.wav",
      copy_into_project: true,
      beat_backend: "built-in",
    };
    const defaultRequest: ProjectImportRequest = {
      source_path: "/music/default.wav",
      copy_into_project: true,
    };

    await api.importProject(builtInRequest);
    await api.importProject(defaultRequest);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "mobile_import_project", { payload: builtInRequest });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "mobile_import_project", { payload: defaultRequest });
  });

  it("rejects advanced mobile import beat analysis before native invoke", async () => {
    const api = await loadMobileApi();

    await expect(
      api.importProject({
        source_path: "/music/song.wav",
        copy_into_project: true,
        beat_backend: "beat-this",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME",
      details: { beat_backend: "beat-this" },
    });

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("allows built-in mobile analysis requests", async () => {
    const api = await loadMobileApi();

    await api.analyzeProject("proj_1", { beat_backend: "built-in" });
    await api.analyzeProject("proj_2");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "mobile_submit_analyze", { projectId: "proj_1" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "mobile_submit_analyze", { projectId: "proj_2" });
  });

  it("rejects advanced mobile beat analysis before native invoke", async () => {
    const api = await loadMobileApi();

    await expect(api.analyzeProject("proj_1", { beat_backend: "beat-this" })).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME",
      details: { beat_backend: "beat-this" },
    });

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("routes mobile sync transport methods to native transport commands", async () => {
    const api = await loadMobileApi();

    await api.getSyncTransportStatus();
    await api.startSyncListener();
    await api.stopSyncListener();
    await api.syncTrustedPeerNow("device_peer_1");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "sync_transport_status", undefined);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "sync_transport_start_listener", { payload: {} });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "sync_transport_stop_listener", undefined);
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "sync_transport_sync_now", {
      payload: { peerDeviceId: "device_peer_1", preferredTransport: "auto" },
    });
  });

  it("normalizes nested native activeProgress from Rust camelCase status payloads", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "mobile_capabilities") {
        return mobileCapabilities;
      }
      if (command === "sync_transport_status") {
        return {
          supported: true,
          running: true,
          bindHost: "127.0.0.1",
          port: 48625,
          endpointHints: ["tuneforge-sync+tcp://192.168.1.42:48625"],
          nearbyPeers: [],
          activeSessions: 1,
          acceptedSessions: 2,
          failedSessions: 0,
          lastStatus: "listener running",
          lastError: null,
          lastSync: null,
          activeProgress: {
            runId: "sync_run_active_1",
            phase: "artifact_transfer",
            message: "Receiving source audio.",
            progressAt: "2026-05-22 12:00:01",
            elapsedMs: 1234,
          },
        };
      }
      return {};
    });
    const api = await loadMobileApi();

    await expect(api.getSyncTransportStatus()).resolves.toMatchObject({
      active: true,
      status: "listening",
      active_run_id: "sync_run_active_1",
      active_phase: "artifact_transfer",
      active_message: "Receiving source audio.",
      active_progress_at: "2026-05-22T12:00:01.000Z",
      active_elapsed_ms: 1234,
    });
    expect(mockInvoke).toHaveBeenCalledWith("sync_transport_status", undefined);
  });

  it("passes discovered endpoint hints to native sync now", async () => {
    const api = await loadMobileApi();
    const currentEndpointHints = [
      " tuneforge-sync+iroh://device_peer_1?direct=192.168.1.57%3A47620 ",
      "tuneforge-sync+tcp://192.168.1.57:48625?device_id=device_peer_1&v=1",
    ];

    await api.syncTrustedPeerNow("device_peer_1", { endpointHints: currentEndpointHints });

    expect(mockInvoke).toHaveBeenCalledWith("sync_transport_sync_now", {
      payload: {
        peerDeviceId: "device_peer_1",
        preferredTransport: "auto",
        endpointHint: "tuneforge-sync+iroh://device_peer_1?direct=192.168.1.57%3A47620",
        endpointHints: [
          "tuneforge-sync+iroh://device_peer_1?direct=192.168.1.57%3A47620",
          "tuneforge-sync+tcp://192.168.1.57:48625?device_id=device_peer_1&v=1",
        ],
      },
    });
  });

	  it("routes lifecycle events to native transport and normalizes camelCase lifecycle fields", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "mobile_capabilities") {
        return mobileCapabilities;
      }
      if (command === "sync_transport_record_lifecycle_event") {
        return {
          running: true,
          status: "listening",
          endpointHints: [],
          nearbyPeers: [],
          lastLifecycleEvent: {
            kind: "network_offline",
            occurredAt: "2026-05-22 12:04:00",
            message: "Network dropped.",
            retryable: true,
            interruptionCode: "android_screen_locked",
            retryGuidance: "Wake the phone and retry sync.",
            peerDeviceId: "device_peer_1",
            runId: "sync_run_lifecycle_1",
          },
          lifecycleEvents: [
            {
              kind: "background",
              occurredAt: "2026-05-22T12:03:58.000Z",
              message: "App backgrounded.",
              retryable: false,
            },
            {
              kind: "network_offline",
              occurredAt: "2026-05-22 12:04:00",
              message: "Network dropped.",
              retryable: true,
              interruptionCode: "android_screen_locked",
              retryGuidance: "Wake the phone and retry sync.",
              peerDeviceId: "device_peer_1",
              runId: "sync_run_lifecycle_1",
            },
          ],
          retryableInterruptionCode: "android_screen_locked",
          retryableInterruptionPeerDeviceId: "device_peer_1",
          retryGuidance: "Wake the phone and retry sync.",
          lastSync: {
            peerDeviceId: "device_peer_1",
            status: "failed",
            message: "Sync paused by lifecycle interruption.",
            projectResults: [],
            manifestErrors: [],
            receivedArtifacts: [],
            lastLifecycleEvent: {
              kind: "network_offline",
              occurredAt: "2026-05-22 12:04:00",
              message: "Network dropped.",
              retryable: true,
              interruptionCode: "android_screen_locked",
              retryGuidance: "Wake the phone and retry sync.",
              peerDeviceId: "device_peer_1",
              runId: "sync_run_lifecycle_1",
            },
            lifecycleEvents: [
              {
                kind: "network_offline",
                occurredAt: "2026-05-22 12:04:00",
                retryable: true,
                interruptionCode: "android_screen_locked",
                retryGuidance: "Wake the phone and retry sync.",
                peerDeviceId: "device_peer_1",
                runId: "sync_run_lifecycle_1",
              },
            ],
            retryableInterruptionCode: "android_screen_locked",
            retryableInterruptionPeerDeviceId: "device_peer_1",
            retryGuidance: "Wake the phone and retry sync.",
          },
        };
      }
      return {};
    });
    const api = await loadMobileApi();

    await expect(
      api.recordSyncLifecycleEvent({
        kind: "network_offline",
        occurredAt: "2026-05-22T12:04:00.000Z",
        message: "Network dropped.",
      }),
    ).resolves.toMatchObject({
      active: true,
      status: "listening",
      last_lifecycle_event: {
        kind: "network_offline",
        occurred_at: "2026-05-22T12:04:00.000Z",
        message: "Network dropped.",
        retryable: true,
        interruption_code: "android_screen_locked",
        retry_guidance: "Wake the phone and retry sync.",
        peer_device_id: "device_peer_1",
        run_id: "sync_run_lifecycle_1",
      },
      lifecycle_events: [
        expect.objectContaining({ kind: "background", retryable: false }),
        expect.objectContaining({
          kind: "network_offline",
          retryable: true,
          interruption_code: "android_screen_locked",
        }),
      ],
      retryable_interruption_code: "android_screen_locked",
      retryable_interruption_peer_device_id: "device_peer_1",
      retry_guidance: "Wake the phone and retry sync.",
      last_sync: {
        status: "failed",
        lifecycle_events: [
          expect.objectContaining({
            kind: "network_offline",
            retryable: true,
            interruption_code: "android_screen_locked",
          }),
        ],
        retryable_interruption_code: "android_screen_locked",
        retryable_interruption_peer_device_id: "device_peer_1",
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith("sync_transport_record_lifecycle_event", {
      payload: {
        kind: "network_offline",
        occurredAt: "2026-05-22T12:04:00.000Z",
        message: "Network dropped.",
      },
	    });
	  });

	  it("keeps retry interruption cleared when native status returns explicit null fields", async () => {
	    const { normalizeSyncTransportStatus } = await import("./api");

	    expect(normalizeSyncTransportStatus({
	      running: true,
	      status: "listening",
	      endpointHints: [],
	      nearbyPeers: [],
	      lastLifecycleEvent: {
	        kind: "network_offline",
	        occurredAt: "2026-05-22T12:04:00.000Z",
	        retryable: true,
	        interruptionCode: "lifecycle_interrupted_network_offline",
	        retryGuidance: "Retry when the peer is reachable.",
	        peerDeviceId: "device_peer_1",
	        runId: "sync_run_old_interruption",
	      },
	      lifecycleEvents: [
	        {
	          kind: "network_offline",
	          occurredAt: "2026-05-22T12:04:00.000Z",
	          retryable: true,
	          interruptionCode: "lifecycle_interrupted_network_offline",
	          retryGuidance: "Retry when the peer is reachable.",
	          peerDeviceId: "device_peer_1",
	          runId: "sync_run_old_interruption",
	        },
	      ],
	      retryableInterruptionCode: null,
	      retryableInterruptionPeerDeviceId: null,
	      retryGuidance: null,
	    })).toMatchObject({
	      retryable_interruption_code: null,
	      retryable_interruption_peer_device_id: null,
	      retry_guidance: null,
	    });
	  });
	});
