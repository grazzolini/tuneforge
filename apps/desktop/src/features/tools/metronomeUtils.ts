export const DEFAULT_METRONOME_BPM = 100;
export const MIN_METRONOME_BPM = 30;
export const MAX_METRONOME_BPM = 240;
export const DEFAULT_BEATS_PER_BAR = 4;
export const DEFAULT_METRONOME_VOLUME = 0.8;
export const MIN_BEATS_PER_BAR = 1;
export const MAX_BEATS_PER_BAR = 12;
export const TAP_MIN_INTERVAL_MS = 250;
export const TAP_MAX_INTERVAL_MS = 2000;
export const TAP_RESET_INTERVAL_MS = 2500;
export const TAP_HISTORY_LIMIT = 6;
export const SYNC_BEAT_EPSILON_SECONDS = 0.015;
export const SYNC_PLAYBACK_JUMP_TOLERANCE_SECONDS = 0.2;

export type TapTempoState = {
  tapTimesMs: number[];
};

export type TapTempoUpdate = {
  bpm: number | null;
  state: TapTempoState;
};

export function createTapTempoState(): TapTempoState {
  return { tapTimesMs: [] };
}

export function normalizeMetronomeBpm(
  value: unknown,
  fallback: number = DEFAULT_METRONOME_BPM,
) {
  if (value === null || value === undefined || value === "") {
    return clampBpm(fallback);
  }
  const numericValue = typeof value === "number" ? value : Number(value);
  const fallbackValue = Number.isFinite(fallback) ? fallback : DEFAULT_METRONOME_BPM;
  if (!Number.isFinite(numericValue)) {
    return clampBpm(fallbackValue);
  }
  return clampBpm(numericValue);
}

export function normalizeBeatsPerBar(
  value: unknown,
  fallback: number = DEFAULT_BEATS_PER_BAR,
) {
  if (value === null || value === undefined || value === "") {
    return clampBeatsPerBar(fallback);
  }
  const numericValue = typeof value === "number" ? value : Number(value);
  const fallbackValue = Number.isFinite(fallback) ? fallback : DEFAULT_BEATS_PER_BAR;
  if (!Number.isFinite(numericValue)) {
    return clampBeatsPerBar(fallbackValue);
  }
  return clampBeatsPerBar(Math.trunc(numericValue));
}

export function secondsPerBeat(bpm: number) {
  return 60 / normalizeMetronomeBpm(bpm);
}

export function beatNumberForIndex(beatIndex: number, beatsPerBar: number) {
  return (Math.max(0, beatIndex) % normalizeBeatsPerBar(beatsPerBar)) + 1;
}

export function isAccentBeat(beatIndex: number, beatsPerBar: number, accentFirstBeat: boolean) {
  return accentFirstBeat && beatNumberForIndex(beatIndex, beatsPerBar) === 1;
}

export function updateTapTempo(
  state: TapTempoState,
  timestampMs: number,
): TapTempoUpdate {
  const tapTimesMs = state.tapTimesMs;
  const previousTapMs = tapTimesMs[tapTimesMs.length - 1];
  if (previousTapMs === undefined || timestampMs - previousTapMs > TAP_RESET_INTERVAL_MS) {
    return { bpm: null, state: { tapTimesMs: [timestampMs] } };
  }

  const intervalMs = timestampMs - previousTapMs;
  if (intervalMs < TAP_MIN_INTERVAL_MS) {
    return { bpm: null, state };
  }
  if (intervalMs > TAP_MAX_INTERVAL_MS) {
    return { bpm: null, state: { tapTimesMs: [timestampMs] } };
  }

  const nextTapTimesMs = [...tapTimesMs, timestampMs].slice(-TAP_HISTORY_LIMIT);
  const intervals = nextTapTimesMs
    .slice(1)
    .map((tapMs, index) => tapMs - nextTapTimesMs[index])
    .filter((nextIntervalMs) =>
      nextIntervalMs >= TAP_MIN_INTERVAL_MS && nextIntervalMs <= TAP_MAX_INTERVAL_MS,
    );
  if (intervals.length === 0) {
    return { bpm: null, state: { tapTimesMs: nextTapTimesMs } };
  }

  const averageIntervalMs =
    intervals.reduce((total, nextIntervalMs) => total + nextIntervalMs, 0) / intervals.length;
  return {
    bpm: normalizeMetronomeBpm(60000 / averageIntervalMs),
    state: { tapTimesMs: nextTapTimesMs },
  };
}

export function nextSyncedBeatIndex({
  bpm,
  lastPlaybackTimeSeconds,
  lastScheduledBeatIndex,
  playbackTimeSeconds,
}: {
  bpm: number;
  lastPlaybackTimeSeconds: number | null;
  lastScheduledBeatIndex: number | null;
  playbackTimeSeconds: number;
}) {
  const beatSeconds = secondsPerBeat(bpm);
  const currentBeatIndex = Math.max(
    0,
    Math.ceil((playbackTimeSeconds - SYNC_BEAT_EPSILON_SECONDS) / beatSeconds),
  );
  const jumped =
    lastPlaybackTimeSeconds !== null &&
    Math.abs(playbackTimeSeconds - lastPlaybackTimeSeconds) >
      SYNC_PLAYBACK_JUMP_TOLERANCE_SECONDS;

  if (lastScheduledBeatIndex === null || jumped) {
    return currentBeatIndex;
  }
  return Math.max(currentBeatIndex, lastScheduledBeatIndex + 1);
}

function clampBpm(value: number) {
  return Math.round(Math.min(MAX_METRONOME_BPM, Math.max(MIN_METRONOME_BPM, value)) * 10) / 10;
}

function clampBeatsPerBar(value: number) {
  return Math.min(MAX_BEATS_PER_BAR, Math.max(MIN_BEATS_PER_BAR, value));
}
