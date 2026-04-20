export type StemControlState = {
  muted: boolean;
  solo: boolean;
};

export type StoredProjectPlaybackState = {
  selectedArtifactId: string | null;
  selectedPrimaryArtifactId: string | null;
  selectedStemSourceArtifactId: string | null;
  stemControls: Record<string, StemControlState>;
  dismissedStemJobIds: string[];
};

const STORAGE_KEY = "tuneforge.project-playback-state";

const DEFAULT_STORED_PROJECT_PLAYBACK_STATE: StoredProjectPlaybackState = {
  selectedArtifactId: null,
  selectedPrimaryArtifactId: null,
  selectedStemSourceArtifactId: null,
  stemControls: {},
  dismissedStemJobIds: [],
};

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

function normalizeStoredProjectPlaybackState(value: unknown): StoredProjectPlaybackState {
  if (!value || typeof value !== "object") {
    return DEFAULT_STORED_PROJECT_PLAYBACK_STATE;
  }

  const candidate = value as Partial<StoredProjectPlaybackState>;
  const stemControlsInput =
    candidate.stemControls && typeof candidate.stemControls === "object"
      ? candidate.stemControls
      : {};
  const stemControls = Object.fromEntries(
    Object.entries(stemControlsInput).map(([artifactId, controlState]) => [
      artifactId,
      normalizeStemControlState(controlState),
    ]),
  );
  const dismissedStemJobIds = Array.isArray(candidate.dismissedStemJobIds)
    ? candidate.dismissedStemJobIds.filter((jobId): jobId is string => typeof jobId === "string")
    : [];

  return {
    selectedArtifactId:
      typeof candidate.selectedArtifactId === "string" ? candidate.selectedArtifactId : null,
    selectedPrimaryArtifactId:
      typeof candidate.selectedPrimaryArtifactId === "string"
        ? candidate.selectedPrimaryArtifactId
        : null,
    selectedStemSourceArtifactId:
      typeof candidate.selectedStemSourceArtifactId === "string"
        ? candidate.selectedStemSourceArtifactId
        : null,
    stemControls,
    dismissedStemJobIds,
  };
}

function readPlaybackStateMap() {
  if (typeof window === "undefined") {
    return {} as Record<string, StoredProjectPlaybackState>;
  }

  const storedValue = window.localStorage.getItem(STORAGE_KEY);
  if (!storedValue) {
    return {} as Record<string, StoredProjectPlaybackState>;
  }

  try {
    const parsed = JSON.parse(storedValue) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([projectId, playbackState]) => [
        projectId,
        normalizeStoredProjectPlaybackState(playbackState),
      ]),
    );
  } catch {
    return {} as Record<string, StoredProjectPlaybackState>;
  }
}

function writePlaybackStateMap(value: Record<string, StoredProjectPlaybackState>) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function readProjectPlaybackState(projectId: string): StoredProjectPlaybackState {
  return readPlaybackStateMap()[projectId] ?? DEFAULT_STORED_PROJECT_PLAYBACK_STATE;
}

export function writeProjectPlaybackState(
  projectId: string,
  playbackState: StoredProjectPlaybackState,
) {
  const next = readPlaybackStateMap();
  next[projectId] = normalizeStoredProjectPlaybackState(playbackState);
  writePlaybackStateMap(next);
}

export function clearProjectPlaybackState(projectId: string) {
  const next = readPlaybackStateMap();
  delete next[projectId];
  writePlaybackStateMap(next);
}
