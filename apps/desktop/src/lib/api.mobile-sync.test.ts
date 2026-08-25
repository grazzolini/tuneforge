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
      if (command === "mobile_media_base_url") {
        return "http://127.0.0.1:43123/session-capability";
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

  it("starts mobile media lazily and caches the ephemeral loopback transport", async () => {
    const apiModule = await import("./api");
    await apiModule.initializeApi();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("mobile_capabilities");
    mockInvoke.mockClear();
    const api = apiModule.api;

    expect(api.streamArtifactUrl("art_0123456789abcdef0123456789ab")).toBe("");
    expect(mockInvoke).not.toHaveBeenCalled();
    await api.ensureWebMediaTransport();
    await api.ensureWebMediaTransport();
    expect(api.streamArtifactUrl("art_0123456789abcdef0123456789ab")).toBe(
      "http://127.0.0.1:43123/session-capability/artifacts/art_0123456789abcdef0123456789ab",
    );
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("mobile_media_base_url", undefined);
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
  });

  it("shares an in-flight mobile media start", async () => {
    const api = await loadMobileApi();
    let resolveBaseUrl: (value: string) => void = () => {};
    const baseUrl = new Promise<string>((resolve) => {
      resolveBaseUrl = resolve;
    });
    mockInvoke.mockImplementation((command: string) =>
      command === "mobile_media_base_url" ? baseUrl : Promise.resolve({}),
    );

    const first = api.ensureWebMediaTransport();
    const second = api.ensureWebMediaTransport();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    resolveBaseUrl("http://127.0.0.1:43123/session-capability");
    await Promise.all([first, second]);
    expect(api.streamArtifactUrl("art_1")).toContain("/artifacts/art_1");
  });

  it("retries mobile media start after a failure", async () => {
    const api = await loadMobileApi();
    mockInvoke
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce("http://127.0.0.1:43123/retry-capability");

    await expect(api.ensureWebMediaTransport()).rejects.toThrow("transport failed");
    expect(api.streamArtifactUrl("art_1")).toBe("");
    await expect(api.ensureWebMediaTransport()).resolves.toBeUndefined();
    expect(api.streamArtifactUrl("art_1")).toContain("/retry-capability/artifacts/art_1");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("allows built-in mobile import requests", async () => {
    const api = await loadMobileApi();
    const builtInRequest: ProjectImportRequest = {
      source_path: "/music/song.wav",
      copy_into_project: true,
      beat_backend: "built-in",
      output_format: "wav",
    };
    const defaultRequest: ProjectImportRequest = {
      source_path: "/music/default.wav",
    };
    const nullableRequest: ProjectImportRequest = {
      source_path: "/music/nullable.wav",
      chord_backend: null,
    };

    await api.importProject(builtInRequest);
    await api.importProject(defaultRequest);
    await api.importProject(nullableRequest);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "mobile_import_project", { payload: builtInRequest });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "mobile_import_project", { payload: defaultRequest });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "mobile_import_project", { payload: nullableRequest });
  });

  it("reports truthful Android export capabilities and forwards destination-free selections", async () => {
    const api = await loadMobileApi();
    const capabilities = await api.getExportCapabilities();
    const request = {
      artifact_ids: [],
      generated_document_ids: ["lyrics_with_chords"] as ["lyrics_with_chords"],
      output_format: "wav" as const,
      filename_base: "Song",
      document_audio_set_artifact_id: "art_mix",
      document_chord_display_mode: "flats" as const,
    };

    expect(capabilities.capabilities).toMatchObject({
      platform: "android",
      max_artifact_count: 1,
      formats: [
        { id: "wav", available: true },
        { id: "flac", available: false },
        { id: "mp3", available: false },
        { id: "m4a", available: false },
      ],
      destinations: [
        { id: "single_file", available: true },
        { id: "folder", available: false },
        { id: "zip", available: false },
      ],
    });
    await api.createExport("proj_1", request);
    expect(mockInvoke).toHaveBeenCalledWith("mobile_submit_export", {
      projectId: "proj_1",
      payload: request,
    });
    expect(request).not.toHaveProperty("destination");
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

  it("rejects LV Chordia mobile import before native invoke", async () => {
    const api = await loadMobileApi();

    await expect(api.importProject({
      source_path: "/music/song.wav",
      copy_into_project: true,
      chord_backend: "lv-chordia-submission",
    })).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME",
      details: { chord_backend: "lv-chordia-submission" },
    });

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each(["flac", "mp3", "m4a"] as const)(
    "rejects %s durable import format on mobile before native invoke",
    async (outputFormat) => {
      const api = await loadMobileApi();

      await expect(
        api.importProject({
          source_path: "/music/song.wav",
          copy_into_project: true,
          output_format: outputFormat,
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_RUNTIME",
        details: { output_format: outputFormat },
      });

      expect(mockInvoke).not.toHaveBeenCalled();
    },
  );

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

  it("reports LV Chordia unavailable on mobile", async () => {
    const api = await loadMobileApi();

    const response = await api.listChordBackends();
    expect(response.backends).toContainEqual(expect.objectContaining({
      available: false,
      id: "lv-chordia-submission",
      unavailable_reason: "LV Chordia is disabled on mobile",
    }));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects explicit LV Chordia generation before native invoke", async () => {
    const api = await loadMobileApi();

    await expect(Promise.resolve().then(() => api.createChords("proj_1", {
      backend: "lv-chordia-submission",
      force: true,
      overwrite_user_edits: false,
    }))).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME",
      details: { chord_backend: "lv-chordia-submission" },
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
