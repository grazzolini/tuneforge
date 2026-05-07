import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeAudioCapabilities,
  NativeAudioDevices,
  NativeAudioInputState,
  NativeAudioSnapshot,
} from "./nativeAudio";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

import {
  getNativeAudioCapabilities,
  getNativeAudioSnapshot,
  listNativeAudioInputDevices,
  listNativeAudioOutputDevices,
  pauseNativeAudio,
  playNativeAudio,
  prepareNativeAudioSession,
  seekNativeAudio,
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
  emitsEvents: ["audio://state", "audio://devices-changed"],
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
};

const inputState: NativeAudioInputState = {
  active: true,
  deviceId: "built-in",
  monitorEnabled: true,
  monitorGain: 0.5,
  inputLevel: 0,
};

describe("native audio adapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
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

    await startNativeAudioInput({
      deviceId: "built-in",
      monitorEnabled: true,
      monitorGain: 0.5,
    });
    await setNativeAudioMonitor({ enabled: false, gain: 0 });
    await stopNativeAudioInput();

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "audio_start_input", {
      payload: { deviceId: "built-in", monitorEnabled: true, monitorGain: 0.5 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "audio_set_monitor", {
      payload: { enabled: false, gain: 0 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "audio_stop_input");
  });

  it("leaves invoke errors visible to callers", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Native audio unavailable."));

    await expect(listNativeAudioOutputDevices()).rejects.toThrow("Native audio unavailable.");
  });
});
