import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const FORCE_WEB_AUDIO_VALUES = new Set(["1", "true", "yes", "on"]);

export type NativeAudioEventName =
  | "audio://state"
  | "audio://position"
  | "audio://ended"
  | "audio://error"
  | "audio://input-level"
  | "audio://input-frame"
  | "audio://devices-changed";

export type NativeAudioCapabilities = {
  platform: string;
  backend: string;
  nativePlaybackSupported: boolean;
  micCaptureSupported: boolean;
  micMonitoringSupported: boolean;
  systemInputVolumeSupported: boolean;
  emitsEvents: NativeAudioEventName[];
  fallbackRequired: boolean;
  fallbackReason: string | null;
};

export type NativeAudioDevice = {
  id: string;
  label: string;
  isDefault: boolean;
};

export type NativeAudioDevices = {
  supported: boolean;
  devices: NativeAudioDevice[];
  error: string | null;
};

export type NativeAudioLaneRole = "primary" | "stem" | "click" | "mic_monitor";

export type NativeAudioLaneRequest = {
  id: string;
  artifactId?: string | null;
  sourcePath?: string | null;
  role: NativeAudioLaneRole;
  gain: number;
  muted: boolean;
  solo: boolean;
};

export type NativeAudioLaneUpdate = {
  lanes: NativeAudioLaneRequest[];
};

export type NativeAudioSessionRequest = {
  sessionId: string;
  durationSeconds?: number | null;
  playbackRate?: number | null;
  lanes: NativeAudioLaneRequest[];
};

export type NativeAudioSession = {
  id: string;
  nativePlaybackSupported: boolean;
  fallbackReason: string | null;
  laneCount: number;
};

export type NativeAudioPlayRequest = {
  startTimeSeconds?: number | null;
  scheduledStartTimeSeconds?: number | null;
};

export type NativeAudioSeekRequest = {
  timeSeconds: number;
};

export type NativeAudioLane = {
  id: string;
  artifactId: string | null;
  role: NativeAudioLaneRole;
  effectiveGain: number;
  muted: boolean;
  solo: boolean;
};

export type NativeAudioSnapshot = {
  sessionId: string | null;
  state: "stopped" | "playing" | "paused";
  positionSeconds: number;
  durationSeconds: number;
  playbackRate: number;
  nativePlaybackSupported: boolean;
  fallbackReason: string | null;
  lanes: NativeAudioLane[];
};

export type NativeAudioClickRequest = {
  enabled: boolean;
  bpm?: number | null;
  beatsPerBar?: number | null;
  accentFirstBeat?: boolean | null;
  gain?: number | null;
  followTransport?: boolean | null;
};

export type NativeAudioPositionEvent = {
  sessionId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  state: "stopped" | "playing" | "paused";
};

export type NativeAudioErrorEvent = {
  sessionId: string | null;
  message: string;
};

export type NativeAudioInputRequest = {
  deviceId?: string | null;
  monitorEnabled?: boolean | null;
  monitorGain?: number | null;
};

export type NativeAudioMonitorRequest = {
  enabled: boolean;
  gain?: number | null;
};

export type NativeAudioInputState = {
  active: boolean;
  deviceId: string | null;
  monitorEnabled: boolean;
  monitorGain: number;
  inputLevel: number;
  sampleRate: number | null;
};

export type NativeAudioInputFrame = {
  deviceId: string | null;
  sampleRate: number;
  inputLevel: number;
  samples: number[];
  timestampMs: number;
};

export function isWebAudioBackendForced() {
  const configuredValue = import.meta.env.VITE_TUNEFORGE_FORCE_WEB_AUDIO;
  return (
    typeof configuredValue === "string" &&
    FORCE_WEB_AUDIO_VALUES.has(configuredValue.trim().toLowerCase())
  );
}

export function getNativeAudioCapabilities() {
  return invoke<NativeAudioCapabilities>("audio_get_capabilities");
}

export function listNativeAudioInputDevices() {
  return invoke<NativeAudioDevices>("audio_list_input_devices");
}

export function listNativeAudioOutputDevices() {
  return invoke<NativeAudioDevices>("audio_list_output_devices");
}

export function prepareNativeAudioSession(payload: NativeAudioSessionRequest) {
  return invoke<NativeAudioSession>("audio_prepare_session", { payload });
}

export function playNativeAudio(payload: NativeAudioPlayRequest = {}) {
  return invoke<NativeAudioSnapshot>("audio_play", { payload });
}

export function pauseNativeAudio() {
  return invoke<NativeAudioSnapshot>("audio_pause");
}

export function stopNativeAudio() {
  return invoke<NativeAudioSnapshot>("audio_stop");
}

export function seekNativeAudio(payload: NativeAudioSeekRequest) {
  return invoke<NativeAudioSnapshot>("audio_seek", { payload });
}

export function setNativeAudioLanes(payload: NativeAudioLaneUpdate) {
  return invoke<NativeAudioSnapshot>("audio_set_lanes", { payload });
}

export function setNativeAudioClick(payload: NativeAudioClickRequest) {
  return invoke<NativeAudioSnapshot>("audio_set_click", { payload });
}

export function getNativeAudioSnapshot() {
  return invoke<NativeAudioSnapshot>("audio_get_snapshot");
}

export function getNativeAudioInputState() {
  return invoke<NativeAudioInputState>("audio_get_input_state");
}

export function startNativeAudioInput(payload: NativeAudioInputRequest = {}) {
  return invoke<NativeAudioInputState>("audio_start_input", { payload });
}

export function stopNativeAudioInput() {
  return invoke<NativeAudioInputState>("audio_stop_input");
}

export function setNativeAudioMonitor(payload: NativeAudioMonitorRequest) {
  return invoke<NativeAudioInputState>("audio_set_monitor", { payload });
}

export function listenNativeAudioInputFrames(
  handler: (frame: NativeAudioInputFrame) => void,
) {
  return listen<NativeAudioInputFrame>("audio://input-frame", (event) => {
    handler(event.payload);
  });
}

export function listenNativeAudioPositions(
  handler: (position: NativeAudioPositionEvent) => void,
) {
  return listen<NativeAudioPositionEvent>("audio://position", (event) => {
    handler(event.payload);
  });
}

export function listenNativeAudioEnded(handler: (snapshot: NativeAudioSnapshot) => void) {
  return listen<NativeAudioSnapshot>("audio://ended", (event) => {
    handler(event.payload);
  });
}

export function listenNativeAudioErrors(handler: (error: NativeAudioErrorEvent) => void) {
  return listen<NativeAudioErrorEvent>("audio://error", (event) => {
    handler(event.payload);
  });
}
