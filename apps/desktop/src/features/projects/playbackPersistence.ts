import type {
  ProjectPlaybackSession,
} from "./playback-context";
import type { StemControlState } from "./projectPlaybackState";

export type PersistedPlaybackState = {
  session: ProjectPlaybackSession;
  playbackTimeSeconds: number;
  isPlaying: boolean;
};

const STORAGE_KEY = "tuneforge.playback-session";

function normalizeStemControlState(value: unknown): StemControlState {
  if (!value || typeof value !== "object") {
    return { muted: false, solo: false };
  }

  const candidate = value as Partial<StemControlState>;
  return {
    muted: Boolean(candidate.muted),
    solo: Boolean(candidate.solo),
  };
}

function normalizeProjectPlaybackSession(value: unknown): ProjectPlaybackSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectPlaybackSession>;
  if (
    typeof candidate.projectId !== "string" ||
    typeof candidate.projectName !== "string" ||
    typeof candidate.stageTitle !== "string" ||
    typeof candidate.stageSummary !== "string"
  ) {
    return null;
  }

  const visibleStemArtifactIds = Array.isArray(candidate.visibleStemArtifactIds)
    ? candidate.visibleStemArtifactIds.filter(
        (artifactId): artifactId is string => typeof artifactId === "string",
      )
    : [];
  const stemControlsInput =
    candidate.stemControls && typeof candidate.stemControls === "object"
      ? candidate.stemControls
      : {};

  return {
    projectId: candidate.projectId,
    projectName: candidate.projectName,
    stageTitle: candidate.stageTitle,
    stageSummary: candidate.stageSummary,
    selectedPlaybackArtifactId:
      typeof candidate.selectedPlaybackArtifactId === "string"
        ? candidate.selectedPlaybackArtifactId
        : null,
    isStemPlayback: Boolean(candidate.isStemPlayback),
    visibleStemArtifactIds,
    stemControls: Object.fromEntries(
      Object.entries(stemControlsInput).map(([artifactId, controlState]) => [
        artifactId,
        normalizeStemControlState(controlState),
      ]),
    ),
    durationHintSeconds:
      typeof candidate.durationHintSeconds === "number" &&
      Number.isFinite(candidate.durationHintSeconds) &&
      candidate.durationHintSeconds >= 0
        ? candidate.durationHintSeconds
        : 0,
  };
}

function normalizePersistedPlaybackState(value: unknown): PersistedPlaybackState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PersistedPlaybackState>;
  const session = normalizeProjectPlaybackSession(candidate.session);
  if (!session) {
    return null;
  }

  return {
    session,
    playbackTimeSeconds:
      typeof candidate.playbackTimeSeconds === "number" &&
      Number.isFinite(candidate.playbackTimeSeconds) &&
      candidate.playbackTimeSeconds >= 0
        ? candidate.playbackTimeSeconds
        : 0,
    isPlaying: Boolean(candidate.isPlaying),
  };
}

export function readPersistedPlaybackState() {
  if (typeof window === "undefined") {
    return null;
  }

  const storedValue = window.sessionStorage.getItem(STORAGE_KEY);
  if (!storedValue) {
    return null;
  }

  try {
    return normalizePersistedPlaybackState(JSON.parse(storedValue));
  } catch {
    return null;
  }
}

export function writePersistedPlaybackState(value: PersistedPlaybackState) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function clearPersistedPlaybackState() {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(STORAGE_KEY);
}
