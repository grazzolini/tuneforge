import { invoke } from "@tauri-apps/api/core";

export type NativeAudioEventName =
  | "audio://state"
  | "audio://position"
  | "audio://ended"
  | "audio://error"
  | "audio://input-level"
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
};

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

export function getNativeAudioSnapshot() {
  return invoke<NativeAudioSnapshot>("audio_get_snapshot");
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
