export const MIN_PLAYBACK_TEMPO_BPM = 30;
export const MAX_PLAYBACK_TEMPO_BPM = 240;
export const DEFAULT_PLAYBACK_RATE = 1;
export const PLAYBACK_RATE_TOLERANCE = 0.0001;

export function normalizeTempoBpm(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export function normalizeTempoTargetBpm(value: unknown): number | null {
  const normalizedValue = normalizeTempoBpm(value);
  return normalizedValue === null ? null : Math.round(normalizedValue);
}

export function tempoTargetBpmFromStep({
  currentTargetBpm,
  delta,
  originalBpm,
}: {
  currentTargetBpm: number | null;
  delta: -1 | 1;
  originalBpm: number | null;
}) {
  if (currentTargetBpm !== null) {
    return normalizeTempoTargetBpm(currentTargetBpm + delta);
  }
  if (originalBpm === null) {
    return null;
  }
  if (Number.isInteger(originalBpm)) {
    return normalizeTempoTargetBpm(originalBpm + delta);
  }
  return normalizeTempoTargetBpm(delta > 0 ? Math.ceil(originalBpm) : Math.floor(originalBpm));
}

export function tempoPlaybackRate({
  originalBpm,
  targetBpm,
}: {
  originalBpm: number | null;
  targetBpm: number | null;
}) {
  if (originalBpm === null || targetBpm === null) {
    return DEFAULT_PLAYBACK_RATE;
  }
  return targetBpm / originalBpm;
}

export function isDefaultPlaybackRate(playbackRate: number) {
  return Math.abs(playbackRate - DEFAULT_PLAYBACK_RATE) <= PLAYBACK_RATE_TOLERANCE;
}
