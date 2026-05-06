import type { ProjectPlaybackSession } from "./playback-context";
import {
  isDefaultPlaybackRate,
  tempoPlaybackRate,
} from "./playbackTempo";

export type PendingTransition = {
  id: number;
  signature: string;
  shouldPlay: boolean;
  targetTime: number;
  awaitSeekBeforePlay: boolean;
  awaitingLoadKeys: string[];
  awaitingSeekKeys: string[];
  forceSeekKeys: string[];
};

const SEEK_TOLERANCE_SECONDS = 0.001;
const PRIMARY_MEDIA_KEY = "__primary__";

export type StemPlaybackState = {
  signature: string;
  artifactIds: string[];
  context: AudioContext;
  durationSeconds: number;
  startedAtContextTime: number;
  offsetSeconds: number;
  isPlaying: boolean;
  buffers: Record<string, AudioBuffer>;
  sources: Record<string, AudioBufferSourceNode>;
  gains: Record<string, GainNode>;
  clockFrameId: number | null;
};

export function playbackSignature(session: ProjectPlaybackSession | null) {
  if (!session) {
    return "none";
  }

  const playbackRate = playbackRateForSession(session).toFixed(6);
  return `${playbackTargetSignature(session)}:rate:${playbackRate}`;
}

export function playbackTargetSignature(session: ProjectPlaybackSession | null) {
  if (!session) {
    return "none";
  }

  const activeSignature = session.isStemPlayback
    ? `stems:${session.visibleStemArtifactIds.join(",")}`
    : `primary:${session.selectedPlaybackArtifactId ?? "none"}`;
  return `${session.projectId}:${activeSignature}`;
}

export function playbackRateForSession(session: ProjectPlaybackSession | null) {
  if (!session) {
    return 1;
  }
  return tempoPlaybackRate({
    originalBpm: session.tempoOriginalBpm,
    targetBpm: session.tempoTargetBpm,
  });
}

export function usesDefaultPlaybackRate(session: ProjectPlaybackSession | null) {
  return isDefaultPlaybackRate(playbackRateForSession(session));
}

export function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'input, textarea, select, button, a, summary, [contenteditable="true"], [role="button"]',
    ),
  );
}

export function clampTime(value: number, duration: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return Math.max(0, value);
  }
  return Math.max(0, Math.min(duration, value));
}


export { PRIMARY_MEDIA_KEY, SEEK_TOLERANCE_SECONDS };
