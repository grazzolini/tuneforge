import type { NativeAudioBufferHealth } from "./nativeAudio";

export const PLAYBACK_E2E_WINDOW_KEY = "__TUNEFORGE_PLAYBACK_E2E__";

export type PlaybackE2EActivePath = "native" | "web-audio" | "none";
export type PlaybackE2ETransportState = "stopped" | "playing" | "paused";

export type PlaybackE2ELoopRange = {
  startSeconds: number;
  endSeconds: number;
};

export type PlaybackE2ECountInTrigger = "song-start" | "loop-start";

export type PlaybackE2ECountInCancelReason =
  | "cancelled"
  | "playback-stopped"
  | "session-changed"
  | "superseded"
  | "unavailable";

export type PlaybackE2ECountInSchedule = {
  sequence: number;
  trigger: PlaybackE2ECountInTrigger;
  activePath: PlaybackE2EActivePath;
  startTimeSeconds: number;
  clickCount: number;
  tempoBpm: number;
  scheduledAtContextTimeSeconds: number;
  firstClickTimeSeconds: number;
  playbackStartTimeSeconds: number;
};

export type PlaybackE2ECountInFired = {
  sequence: number;
  trigger: PlaybackE2ECountInTrigger;
  playbackStartTimeSeconds: number;
  firedAtContextTimeSeconds: number | null;
};

export type PlaybackE2ECountInCancelled = {
  sequence: number;
  trigger: PlaybackE2ECountInTrigger;
  playbackStartTimeSeconds: number;
  cancelledAtContextTimeSeconds: number | null;
  reason: PlaybackE2ECountInCancelReason;
};

export type PlaybackE2ECountInState = {
  active: boolean;
  lastScheduled: PlaybackE2ECountInSchedule | null;
  lastFired: PlaybackE2ECountInFired | null;
  lastCancelled: PlaybackE2ECountInCancelled | null;
};

export type PlaybackE2ETelemetrySnapshot = {
  activePath: PlaybackE2EActivePath;
  transportState: PlaybackE2ETransportState;
  positionSeconds: number;
  durationSeconds: number;
  playbackRate: number;
  loopRange: PlaybackE2ELoopRange | null;
  nativeBufferHealth: NativeAudioBufferHealth[];
  countIn: PlaybackE2ECountInState;
};

export type PlaybackE2ETelemetryPatch = Partial<Omit<PlaybackE2ETelemetrySnapshot, "countIn">> & {
  countIn?: Partial<PlaybackE2ECountInState>;
};

export type PlaybackE2ETelemetryApi = {
  read: () => PlaybackE2ETelemetrySnapshot;
};

const EMPTY_COUNT_IN: PlaybackE2ECountInState = {
  active: false,
  lastScheduled: null,
  lastFired: null,
  lastCancelled: null,
};

const EMPTY_SNAPSHOT: PlaybackE2ETelemetrySnapshot = {
  activePath: "none",
  transportState: "stopped",
  positionSeconds: 0,
  durationSeconds: 0,
  playbackRate: 1,
  loopRange: null,
  nativeBufferHealth: [],
  countIn: EMPTY_COUNT_IN,
};

let currentSnapshot = clonePlaybackE2ETelemetrySnapshot(EMPTY_SNAPSHOT);

function cloneLoopRange(loopRange: PlaybackE2ELoopRange | null): PlaybackE2ELoopRange | null {
  return loopRange ? { ...loopRange } : null;
}

function cloneNativeBufferHealth(bufferHealth: NativeAudioBufferHealth[]) {
  return bufferHealth.map((health) => ({ ...health }));
}

function cloneCountIn(countIn: PlaybackE2ECountInState): PlaybackE2ECountInState {
  return {
    active: countIn.active,
    lastScheduled: countIn.lastScheduled ? { ...countIn.lastScheduled } : null,
    lastFired: countIn.lastFired ? { ...countIn.lastFired } : null,
    lastCancelled: countIn.lastCancelled ? { ...countIn.lastCancelled } : null,
  };
}

export function clonePlaybackE2ETelemetrySnapshot(
  snapshot: PlaybackE2ETelemetrySnapshot,
): PlaybackE2ETelemetrySnapshot {
  return {
    activePath: snapshot.activePath,
    transportState: snapshot.transportState,
    positionSeconds: snapshot.positionSeconds,
    durationSeconds: snapshot.durationSeconds,
    playbackRate: snapshot.playbackRate,
    loopRange: cloneLoopRange(snapshot.loopRange),
    nativeBufferHealth: cloneNativeBufferHealth(snapshot.nativeBufferHealth),
    countIn: cloneCountIn(snapshot.countIn),
  };
}

export function readPlaybackE2ETelemetry() {
  return clonePlaybackE2ETelemetrySnapshot(currentSnapshot);
}

const playbackE2ETelemetryApi: PlaybackE2ETelemetryApi = {
  read: readPlaybackE2ETelemetry,
};

export function exposePlaybackE2ETelemetryApi() {
  if (typeof window === "undefined") {
    return playbackE2ETelemetryApi;
  }

  window[PLAYBACK_E2E_WINDOW_KEY] = playbackE2ETelemetryApi;
  return playbackE2ETelemetryApi;
}

export function publishPlaybackE2ETelemetry(snapshot: PlaybackE2ETelemetrySnapshot) {
  currentSnapshot = clonePlaybackE2ETelemetrySnapshot(snapshot);
  exposePlaybackE2ETelemetryApi();
}

export function patchPlaybackE2ETelemetry(patch: PlaybackE2ETelemetryPatch) {
  currentSnapshot = clonePlaybackE2ETelemetrySnapshot({
    ...currentSnapshot,
    ...patch,
    countIn: {
      ...currentSnapshot.countIn,
      ...patch.countIn,
    },
  });
  exposePlaybackE2ETelemetryApi();
}

export function resetPlaybackE2ETelemetry() {
  currentSnapshot = clonePlaybackE2ETelemetrySnapshot(EMPTY_SNAPSHOT);
  exposePlaybackE2ETelemetryApi();
}

exposePlaybackE2ETelemetryApi();
