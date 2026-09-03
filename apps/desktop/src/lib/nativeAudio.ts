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
  | "audio://input-state"
  | "audio://devices-changed"
  | "audio://session"
  | "audio://cue"
  | "audio://terminal";

export type NativeAudioAcquisitionControl = {
  leaseId: string;
  operationId: string;
};

export type NativeAudioOutputControl = NativeAudioAcquisitionControl & {
  generation: number;
  timelineRevision: number;
};

export type NativeAudioCaptureControl = NativeAudioAcquisitionControl & {
  generation: number;
};

export type NativeAudioSessionSnapshot = {
  resource: "output" | "capture";
  source: "project_playback" | "tuner_capture";
  status: "released" | "output" | "capture" | "releasing" | "terminal";
  owner: "playback" | "cue" | "capture" | null;
  leaseId: string | null;
  generation: number;
  timelineRevision: number;
  nativeTimeUs: number;
  positionSeconds: number;
  playbackRate: number;
  availabilityReason: string | null;
  terminalDiagnostic: string | null;
};

export type NativeAudioCueKind = "marker" | "precount_beat" | "precount_completion" | "metronome";
export type NativeAudioCue = {
  cueIndex: number;
  positionSeconds: number;
  kind?: "marker" | "metronome";
  accent?: boolean;
  gain?: number;
};
export type NativeAudioCueEvent = {
  resource: "output";
  source: "project_playback" | "standalone_metronome";
  generation: number;
  revision: number;
  cueIndex: number;
  kind: NativeAudioCueKind;
  accent: boolean;
  gain: number;
  scheduledNativeTimeUs: number;
  actualNativeTimeUs: number;
  insertionSequence: number;
};
export type NativeAudioTerminalEvent = {
  resource: "output" | "capture";
  source: "output_runtime" | "capture_runtime" | "project_playback" | "tuner_capture";
  generation: number;
  timelineRevision: number;
  captureGeneration: number | null;
  positionSeconds: number;
  code: string;
  nativeTimeUs: number;
};

export type NativeAudioCapabilities = {
  platform: string;
  backend: string;
  nativePlaybackSupported: boolean;
  micCaptureSupported: boolean;
  micMonitoringSupported: boolean;
  systemInputVolumeSupported: boolean;
  emitsEvents: NativeAudioEventName[];
  availabilityReason: string | null;
};

export type NativeAudioDiagnosticsAvailability = {
  enabled: boolean;
};

export type NativeAudioDiagnosticOperationKind =
  | "prepare"
  | "play"
  | "seek"
  | "tempo"
  | "lane_update"
  | "lane_route";
export type NativeAudioDiagnosticSafeCode =
  | "prebuffer_timeout"
  | "sustained_underrun"
  | "runtime_start_failure"
  | "decoder_worker_failure"
  | "output_stream_failure"
  | "device_changed"
  | "device_not_available"
  | "stream_invalidated";

export type NativeAudioDiagnosticCounters = {
  operationCount: number;
  ringClearCount: number;
  workerFirstPcmEventCount: number;
  prebufferReadyCount: number;
  callbackFirstNonzeroCount: number;
  gainRampBeginCount: number;
  gainRampCompleteCount: number;
  underrunCount: number;
  skippedPacketErrorCount: number;
  skippedDecodeErrorCount: number;
  staleGenerationEventCount: number;
};

export type NativeAudioDiagnosticSafeCodeCount = {
  code: NativeAudioDiagnosticSafeCode;
  count: number;
};

export type NativeAudioDiagnosticOperation = {
  sequence: number;
  kind: NativeAudioDiagnosticOperationKind;
  laneCount: number;
  commandStartUs: 0;
  ringClearCount: number;
  ringClearUs: number[];
  workerFirstPcmCount: number;
  workerFirstPcmUs: Array<number | null>;
  allWorkersFirstPcmUs: number | null;
  prebufferReadyUs: number | null;
  callbackFirstNonzeroUs: number | null;
  gainRampBeginCount: number;
  gainRampBeginUs: number | null;
  gainFirstChangeUs: number | null;
  gainRampCompleteCount: number;
  firstGainRampCompleteUs: number | null;
  underrunCount: number;
  firstUnderrunUs: number | null;
  skippedPacketErrorCount: number;
  skippedDecodeErrorCount: number;
  ringCapacitySamples: number | null;
  scratchCapacitySamples: number | null;
  rssKibAtBegin: number | null;
  safeCodes: NativeAudioDiagnosticSafeCodeCount[];
};

export type NativeAudioDiagnosticExport = {
  schemaVersion: "tuneforge-native-audio-diagnostics-v1";
  relativeNowUs: number;
  resetCount: number;
  counters: NativeAudioDiagnosticCounters;
  operations: NativeAudioDiagnosticOperation[];
  safeCodes: NativeAudioDiagnosticSafeCodeCount[];
  rssKibAtExport: number | null;
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
  playbackRate?: number | null;
};

export type NativeAudioSessionRequest = NativeAudioAcquisitionControl & {
  sessionId: string;
  durationSeconds?: number | null;
  playbackRate?: number | null;
  owner?: "playback" | "cue" | "capture" | null;
  lanes: NativeAudioLaneRequest[];
};

export type NativeAudioSession = {
  id: string;
  leaseId: string;
  nativePlaybackSupported: boolean;
  availabilityReason: string | null;
  laneCount: number;
  generation: number;
  timelineRevision: number;
  nativeTimeUs: number;
};

export type NativeAudioPlayRequest = NativeAudioOutputControl & {
  startTimeSeconds?: number | null;
  scheduledStartTimeSeconds?: number | null;
  startAtNativeUs?: number | null;
  precount?: { intervalsSeconds: number[] } | null;
  metronomeCues?: Array<NativeAudioCue & { kind: "metronome" }> | null;
};

export const nativePlayCueProvider = { current: null as ((positionSeconds: number) => Array<NativeAudioCue & { kind: "metronome" }>) | null };

export type NativeAudioSeekRequest = NativeAudioOutputControl & {
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

export type NativeAudioBufferHealth = {
  laneId: string;
  artifactId: string | null;
  role: NativeAudioLaneRole;
  ringFillSamples: number;
  ringCapacitySamples: number;
  underrunCount: number;
  workerErrorCount: number;
  lastWorkerError: string | null;
};

export type NativeAudioSnapshot = {
  sessionId: string | null;
  state: "stopped" | "playing" | "paused";
  positionSeconds: number;
  durationSeconds: number;
  playbackRate: number;
  nativePlaybackSupported: boolean;
  availabilityReason: string | null;
  lanes: NativeAudioLane[];
  bufferHealth: NativeAudioBufferHealth[];
  leaseId: string | null;
  generation: number;
  timelineRevision: number;
  nativeTimeUs: number;
};

export type NativeStandaloneMetronomeRequest =
  | (NativeAudioAcquisitionControl & {
      generation?: never;
      timelineRevision?: never;
    } & NativeStandaloneMetronomeConfiguration)
  | (NativeAudioOutputControl & NativeStandaloneMetronomeConfiguration);

type NativeStandaloneMetronomeConfiguration = {
  enabled: boolean;
  bpm: number;
  beatsPerBar: number;
  accentFirstBeat: boolean;
  gain: number;
  followPlayback: boolean;
};

export type NativeStandaloneMetronomeState = {
  enabled: boolean;
  bpm: number;
  beatsPerBar: number;
  accentFirstBeat: boolean;
  gain: number;
  followPlayback: boolean;
  leaseId: string | null;
  generation: number;
  revision: number;
  nativeTimeUs: number;
};

export type NativeAudioPositionEvent = {
  sessionId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  state: "stopped" | "playing" | "paused";
  generation: number;
  timelineRevision: number;
  nativeTimeUs: number;
};

export type NativeAudioStateEvent = {
  sessionId: string | null;
  state: "stopped" | "playing" | "paused";
  positionSeconds: number;
  generation: number;
  timelineRevision: number;
  nativeTimeUs: number;
};

export type NativeAudioErrorEvent = {
  sessionId: string | null;
  generation: number;
  timelineRevision: number;
  nativeTimeUs: number;
  positionSeconds: number;
  code:
    | "device_changed"
    | "device_not_available"
    | "stream_invalidated"
    | "output_stream_failure"
    | "decoder_worker_failure";
};

export type NativeAudioInputRequest = NativeAudioAcquisitionControl & {
  deviceId?: string | null;
  monitorEnabled?: boolean | null;
  monitorGain?: number | null;
};

export type NativeAudioMonitorRequest = NativeAudioCaptureControl & {
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
  captureGeneration: number;
  capturePath: "none" | "desktop-cpal" | "android-aaudio";
  permissionState:
    | "prompt"
    | "prompting"
    | "granted"
    | "denied"
    | "blocked"
    | "privacy-blocked"
    | "unavailable";
  error: NativeAudioInputError | null;
  leaseId: string | null;
  generation: number | null;
  nativeTimeUs: number;
};

export type NativeAudioInputError = {
  code:
    | "permission-denied"
    | "permission-blocked"
    | "privacy-blocked"
    | "unavailable"
    | "startup-failure"
    | "stream-interruption"
    | "background-teardown";
  message: string;
  guidance: string | null;
};

export type NativeAudioInputPermissionStatus = {
  state: NativeAudioInputState["permissionState"];
  error: NativeAudioInputError | null;
};

export type NativeAudioInputFrame = {
  deviceId: string | null;
  sampleRate: number;
  inputLevel: number;
  samples: number[];
  timestampMs: number;
  captureGeneration: number;
};

export function isWebAudioBackendForced() {
  const configuredValue = import.meta.env.VITE_TUNEFORGE_FORCE_WEB_AUDIO;
  return (
    typeof configuredValue === "string" &&
    FORCE_WEB_AUDIO_VALUES.has(configuredValue.trim().toLowerCase())
  );
}

export function isAndroidRuntime() {
  return typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent);
}

export function getNativeAudioCapabilities() {
  return invoke<NativeAudioCapabilities>("audio_get_capabilities");
}

export function getNativeAudioDiagnosticsAvailability() {
  return invoke<NativeAudioDiagnosticsAvailability>("native_audio_diagnostics_availability");
}

export function readNativeAudioDiagnostics() {
  return invoke<NativeAudioDiagnosticExport>("native_audio_diagnostics_read");
}

export function resetNativeAudioDiagnostics() {
  return invoke<NativeAudioDiagnosticExport>("native_audio_diagnostics_reset");
}

export function exportNativeAudioDiagnostics() {
  return invoke<boolean>("native_audio_diagnostics_export");
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

export function playNativeAudio(payload: NativeAudioPlayRequest) {
  return invoke<NativeAudioSnapshot>("audio_play", { payload });
}

export function pauseNativeAudio(payload: NativeAudioOutputControl) {
  return invoke<NativeAudioSnapshot>("audio_pause", { payload });
}

export function stopNativeAudio(payload: NativeAudioOutputControl) {
  return invoke<NativeAudioSnapshot>("audio_stop", { payload });
}

export function seekNativeAudio(payload: NativeAudioSeekRequest) {
  return invoke<NativeAudioSnapshot>("audio_seek", { payload });
}

export function setNativeAudioLanes(
  payload: NativeAudioLaneUpdate,
  control: NativeAudioOutputControl,
) {
  return invoke<NativeAudioSnapshot>("audio_set_lanes", { payload, control });
}

export function setNativeStandaloneMetronome(payload: NativeStandaloneMetronomeRequest) {
  return invoke<NativeStandaloneMetronomeState>("audio_set_standalone_metronome", { payload });
}

export function getNativeAudioSnapshot() {
  return invoke<NativeAudioSnapshot>("audio_get_snapshot");
}

export function getNativeAudioSessionSnapshot() {
  return invoke<NativeAudioSessionSnapshot>("audio_get_session_snapshot");
}

export function scheduleNativeAudioCues(
  payload: NativeAudioOutputControl & { cues: NativeAudioCue[] },
) {
  return invoke<NativeAudioSessionSnapshot>("audio_schedule_cues", { payload });
}

export function cancelNativeAudioCues(
  payload: NativeAudioOutputControl,
  kind?: "marker" | "metronome",
) {
  return invoke<NativeAudioSessionSnapshot>("audio_cancel_cues", { payload, kind });
}

export function getNativeAudioInputState() {
  return invoke<NativeAudioInputState>("audio_get_input_state");
}

export function getNativeAudioInputPermissionStatus() {
  return invoke<NativeAudioInputPermissionStatus>("audio_get_input_permission_status");
}

export function requestNativeAudioInputPermission() {
  return invoke<NativeAudioInputPermissionStatus>("audio_request_input_permission");
}

export function startNativeAudioInput(payload: NativeAudioInputRequest) {
  return invoke<NativeAudioInputState>("audio_start_input", { payload });
}

export function stopNativeAudioInput(payload: NativeAudioCaptureControl) {
  return invoke<NativeAudioInputState>("audio_stop_input", { payload });
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

export function listenNativeAudioInputState(
  handler: (state: NativeAudioInputState) => void,
) {
  return listen<NativeAudioInputState>("audio://input-state", (event) => {
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

export function listenNativeAudioState(handler: (state: NativeAudioStateEvent) => void) {
  return listen<NativeAudioStateEvent>("audio://state", (event) => {
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

export function listenNativeAudioSessions(
  handler: (session: NativeAudioSessionSnapshot) => void,
) {
  return listen<NativeAudioSessionSnapshot>("audio://session", (event) => handler(event.payload));
}

export function listenNativeAudioCues(handler: (cue: NativeAudioCueEvent) => void) {
  return listen<NativeAudioCueEvent>("audio://cue", (event) => handler(event.payload));
}

export function listenNativeAudioTerminal(handler: (terminal: NativeAudioTerminalEvent) => void) {
  return listen<NativeAudioTerminalEvent>("audio://terminal", (event) => handler(event.payload));
}
