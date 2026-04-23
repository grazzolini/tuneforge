import { clampTime, type StemPlaybackState } from "./playbackUtils";

export function getStemPlaybackTime(
  targetPlaybackState: StemPlaybackState | null,
  fallbackTimeSeconds: number,
) {
  if (!targetPlaybackState) {
    return fallbackTimeSeconds;
  }

  const elapsedSeconds = targetPlaybackState.isPlaying
    ? Math.max(0, targetPlaybackState.context.currentTime - targetPlaybackState.startedAtContextTime)
    : 0;
  return clampTime(
    targetPlaybackState.offsetSeconds + elapsedSeconds,
    targetPlaybackState.durationSeconds,
  );
}

export function clearStemClock(targetPlaybackState: StemPlaybackState | null) {
  if (
    typeof window === "undefined" ||
    !targetPlaybackState ||
    targetPlaybackState.clockFrameId === null
  ) {
    return;
  }

  window.cancelAnimationFrame(targetPlaybackState.clockFrameId);
  targetPlaybackState.clockFrameId = null;
}

export function stopStemSources(
  targetPlaybackState: StemPlaybackState | null,
  {
    fallbackTimeSeconds,
    preserveOffset,
    syncStemElementTimes,
  }: {
    fallbackTimeSeconds: number;
    preserveOffset: boolean;
    syncStemElementTimes: (artifactIds: string[], nextTime: number) => void;
  },
) {
  if (!targetPlaybackState) {
    return fallbackTimeSeconds;
  }

  const nextTime = preserveOffset
    ? getStemPlaybackTime(targetPlaybackState, fallbackTimeSeconds)
    : targetPlaybackState.offsetSeconds;
  clearStemClock(targetPlaybackState);
  Object.values(targetPlaybackState.sources).forEach((source) => {
    source.onended = null;
    try {
      source.stop();
    } catch {
      return;
    } finally {
      source.disconnect();
    }
  });
  targetPlaybackState.sources = {};
  targetPlaybackState.isPlaying = false;
  targetPlaybackState.offsetSeconds = clampTime(nextTime, targetPlaybackState.durationSeconds);
  targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
  syncStemElementTimes(Object.keys(targetPlaybackState.gains), targetPlaybackState.offsetSeconds);
  return targetPlaybackState.offsetSeconds;
}

export function disconnectStemGains(targetPlaybackState: StemPlaybackState) {
  Object.values(targetPlaybackState.gains).forEach((gainNode) => gainNode.disconnect());
}
