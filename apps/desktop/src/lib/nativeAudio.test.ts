import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeAudioCapabilities,
  NativeAudioDevices,
  NativeAudioInputFrame,
  NativeAudioInputState,
  NativeAudioSnapshot,
} from "./nativeAudio";

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import {
  getNativeAudioCapabilities,
  getNativeAudioInputPermissionStatus,
  getNativeAudioInputState,
  getNativeAudioSnapshot,
  isWebAudioBackendForced,
  listNativeAudioInputDevices,
  listNativeAudioOutputDevices,
  listenNativeAudioInputFrames,
  listenNativeAudioInputState,
  listenNativeAudioPositions,
  pauseNativeAudio,
  playNativeAudio,
  prepareNativeAudioSession,
  requestNativeAudioInputPermission,
  seekNativeAudio,
  setNativeAudioClick,
  setNativeAudioLanes,
  setNativeAudioMonitor,
  startNativeAudioInput,
  stopNativeAudio,
  stopNativeAudioInput,
} from "./nativeAudio";

const capabilities: NativeAudioCapabilities = {
  platform: "macos",
  backend: "desktop-null",
  nativePlaybackSupported: false,
  micCaptureSupported: false,
  micMonitoringSupported: false,
  systemInputVolumeSupported: true,
  emitsEvents: ["audio://state", "audio://input-frame", "audio://devices-changed"],
  fallbackRequired: true,
  fallbackReason: "Native audio playback is not wired yet; use existing WebView playback.",
};

const devices: NativeAudioDevices = {
  supported: false,
  devices: [],
  error: "Native audio output device discovery is not wired yet.",
};

const snapshot: NativeAudioSnapshot = {
  sessionId: "session-1",
  state: "paused",
  positionSeconds: 12,
  durationSeconds: 180,
  playbackRate: 1,
  nativePlaybackSupported: false,
  fallbackReason: "Native audio playback is not wired yet; use existing WebView playback.",
  lanes: [],
  bufferHealth: [],
};

const inputState: NativeAudioInputState = {
  active: true,
  deviceId: "built-in",
  monitorEnabled: true,
  monitorGain: 0.5,
  inputLevel: 0,
  sampleRate: 48000,
  captureGeneration: 4,
  capturePath: "desktop-cpal",
  permissionState: "unavailable",
  error: null,
};

describe("native audio adapter", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockInvoke.mockReset();
    mockListen.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("detects the Web Audio backend override from env", () => {
    expect(isWebAudioBackendForced()).toBe(false);

    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "true");
    expect(isWebAudioBackendForced()).toBe(true);

    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "0");
    expect(isWebAudioBackendForced()).toBe(false);
  });

  it("wraps capability and device discovery commands", async () => {
    mockInvoke
      .mockResolvedValueOnce(capabilities)
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce(devices);

    await expect(getNativeAudioCapabilities()).resolves.toEqual(capabilities);
    await expect(listNativeAudioInputDevices()).resolves.toEqual(devices);
    await expect(listNativeAudioOutputDevices()).resolves.toEqual(devices);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "audio_get_capabilities");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "audio_list_input_devices");
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "audio_list_output_devices");
  });

  it("sends camelCase session and transport payloads", async () => {
    const sessionRequest = {
      sessionId: "session-1",
      durationSeconds: 180,
      playbackRate: 1,
      lanes: [
        {
          id: "vocals",
          artifactId: "artifact-vocals",
          sourcePath: "/tmp/vocals.wav",
          role: "stem" as const,
          gain: 0.75,
          muted: false,
          solo: true,
        },
      ],
    };
    const laneUpdate = { lanes: sessionRequest.lanes };
    mockInvoke.mockResolvedValue(snapshot);

    await prepareNativeAudioSession(sessionRequest);
    await playNativeAudio({ startTimeSeconds: 4, scheduledStartTimeSeconds: 10 });
    await seekNativeAudio({ timeSeconds: 24 });
    await setNativeAudioLanes(laneUpdate);
    await setNativeAudioClick({
      enabled: true,
      bpm: 120,
      beatsPerBar: 4,
      accentFirstBeat: true,
      gain: 0.75,
      followTransport: true,
    });

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "audio_prepare_session", {
      payload: sessionRequest,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "audio_play", {
      payload: { startTimeSeconds: 4, scheduledStartTimeSeconds: 10 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "audio_seek", {
      payload: { timeSeconds: 24 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "audio_set_lanes", {
      payload: laneUpdate,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(5, "audio_set_click", {
      payload: {
        enabled: true,
        bpm: 120,
        beatsPerBar: 4,
        accentFirstBeat: true,
        gain: 0.75,
        followTransport: true,
      },
    });
  });

  it("wraps snapshot and stop-state commands without payloads", async () => {
    mockInvoke.mockResolvedValue(snapshot);

    await pauseNativeAudio();
    await stopNativeAudio();
    await getNativeAudioSnapshot();

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "audio_pause");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "audio_stop");
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "audio_get_snapshot");
  });

  it("wraps native input and monitor payloads", async () => {
    mockInvoke.mockResolvedValue(inputState);

    await getNativeAudioInputState();
    await startNativeAudioInput({
      deviceId: "built-in",
      monitorEnabled: true,
      monitorGain: 0.5,
    });
    await setNativeAudioMonitor({ enabled: false, gain: 0 });
    await stopNativeAudioInput();

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "audio_get_input_state");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "audio_start_input", {
      payload: { deviceId: "built-in", monitorEnabled: true, monitorGain: 0.5 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "audio_set_monitor", {
      payload: { enabled: false, gain: 0 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "audio_stop_input");
  });

  it("keeps permission status and request separate from capture start", async () => {
    const permission = { state: "granted" as const, error: null };
    mockInvoke.mockResolvedValue(permission);

    await expect(getNativeAudioInputPermissionStatus()).resolves.toEqual(permission);
    await expect(requestNativeAudioInputPermission()).resolves.toEqual(permission);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "audio_get_input_permission_status");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "audio_request_input_permission");
    expect(mockInvoke).not.toHaveBeenCalledWith("audio_start_input", expect.anything());
  });

  it("wraps native input frame events", async () => {
    const unlisten = vi.fn();
    const frame: NativeAudioInputFrame = {
      deviceId: "built-in",
      sampleRate: 48000,
      inputLevel: 0.25,
      samples: [0, 0.5, -0.5],
      timestampMs: 1234,
      captureGeneration: 4,
    };
    mockListen.mockImplementation(async (_eventName, callback) => {
      callback({ event: "audio://input-frame", id: 1, payload: frame });
      return unlisten;
    });
    const handler = vi.fn();

    const stopListening = await listenNativeAudioInputFrames(handler);

    expect(mockListen).toHaveBeenCalledWith("audio://input-frame", expect.any(Function));
    expect(handler).toHaveBeenCalledWith(frame);
    stopListening();
    expect(unlisten).toHaveBeenCalled();
  });

  it("wraps generation-scoped native input state events", async () => {
    const unlisten = vi.fn();
    mockListen.mockImplementation(async (_eventName, callback) => {
      callback({ event: "audio://input-state", id: 2, payload: inputState });
      return unlisten;
    });
    const handler = vi.fn();

    const stopListening = await listenNativeAudioInputState(handler);

    expect(mockListen).toHaveBeenCalledWith("audio://input-state", expect.any(Function));
    expect(handler).toHaveBeenCalledWith(inputState);
    stopListening();
    expect(unlisten).toHaveBeenCalled();
  });

  it("wraps native position events", async () => {
    const unlisten = vi.fn();
    const position = {
      sessionId: "session-1",
      positionSeconds: 12,
      durationSeconds: 180,
      state: "playing" as const,
    };
    mockListen.mockImplementation(async (_eventName, callback) => {
      callback({ event: "audio://position", id: 1, payload: position });
      return unlisten;
    });
    const handler = vi.fn();

    const stopListening = await listenNativeAudioPositions(handler);

    expect(mockListen).toHaveBeenCalledWith("audio://position", expect.any(Function));
    expect(handler).toHaveBeenCalledWith(position);
    stopListening();
    expect(unlisten).toHaveBeenCalled();
  });

  it("leaves invoke errors visible to callers", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Native audio unavailable."));

    await expect(listNativeAudioOutputDevices()).rejects.toThrow("Native audio unavailable.");
  });
});
