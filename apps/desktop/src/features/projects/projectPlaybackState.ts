import {
  isPlaybackDisplayMode,
  isProjectWorkspaceMode,
  type PlaybackDisplayMode,
  type ProjectWorkspaceMode,
} from "../../lib/preferences";
import {
  normalizeLoopAlignmentMode,
  type LoopAlignmentMode,
} from "../../lib/timingGrid";
import { normalizeTempoTargetBpm } from "./playbackTempo";
import type { GeneratedExportDocumentId } from "../../lib/api";

export type ProjectPanelMode = "studio" | "analysis" | "export";

export type StemControlState = {
  muted: boolean;
  solo: boolean;
};

export type PlaybackLoopRange = {
  startSeconds: number;
  endSeconds: number;
};

export type ExportWorkspaceState = {
  audioSetId: string | null;
  selectedArtifactIds: string[];
  selectedGeneratedDocumentIds: GeneratedExportDocumentId[];
  outputFormat: "wav" | "flac" | "mp3" | "m4a" | null;
  filenameBase: string;
  destinationType: "single_file" | "folder" | "zip";
  desktopDestinationTarget: string | null;
};

export const DEFAULT_PRECOUNT_CLICK_COUNT = 4;
export const MIN_PRECOUNT_CLICK_COUNT = 1;
export const MAX_PRECOUNT_CLICK_COUNT = 8;
export const MIN_PLAYBACK_LOOP_SECONDS = 0.25;

export type StoredProjectPlaybackState = {
  selectedArtifactId: string | null;
  selectedPrimaryArtifactId: string | null;
  selectedStemSourceArtifactId: string | null;
  activeWorkspace: ProjectWorkspaceMode;
  activeProjectPanel: ProjectPanelMode;
  playbackDisplayMode: PlaybackDisplayMode;
  capoTransposeSemitones: number;
  precountEnabled: boolean;
  precountLoopEnabled: boolean;
  precountClickCount: number;
  tempoTargetBpm: number | null;
  loopRange: PlaybackLoopRange | null;
  loopAlignmentMode: LoopAlignmentMode | null;
  lyricsFollowEnabled: boolean;
  chordsFollowEnabled: boolean;
  stemControls: Record<string, StemControlState>;
  dismissedStemJobIds: string[];
  exportWorkspace: ExportWorkspaceState | null;
};

const STORAGE_KEY = "tuneforge.project-playback-state";

const DEFAULT_STORED_PROJECT_PLAYBACK_STATE: StoredProjectPlaybackState = {
  selectedArtifactId: null,
  selectedPrimaryArtifactId: null,
  selectedStemSourceArtifactId: null,
  activeWorkspace: "project",
  activeProjectPanel: "studio",
  playbackDisplayMode: "combined",
  capoTransposeSemitones: 0,
  precountEnabled: false,
  precountLoopEnabled: false,
  precountClickCount: DEFAULT_PRECOUNT_CLICK_COUNT,
  tempoTargetBpm: null,
  loopRange: null,
  loopAlignmentMode: null,
  lyricsFollowEnabled: true,
  chordsFollowEnabled: true,
  stemControls: {},
  dismissedStemJobIds: [],
  exportWorkspace: null,
};

function normalizeTransposeSemitones(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(12, Math.max(-12, Math.trunc(value)));
}

export function normalizePrecountClickCount(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PRECOUNT_CLICK_COUNT;
  }
  return Math.min(
    MAX_PRECOUNT_CLICK_COUNT,
    Math.max(MIN_PRECOUNT_CLICK_COUNT, Math.trunc(value)),
  );
}

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

function normalizeLoopPoint(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, value);
}

function normalizeExportWorkspaceState(value: unknown): ExportWorkspaceState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExportWorkspaceState>;
  const hasValidOutputFormat = ["wav", "flac", "mp3", "m4a"].includes(candidate.outputFormat ?? "");
  const hasValidDestinationType = ["single_file", "folder", "zip"].includes(
    candidate.destinationType ?? "",
  );
  const outputFormat = hasValidOutputFormat
    ? candidate.outputFormat as ExportWorkspaceState["outputFormat"]
    : null;
  const destinationType = hasValidDestinationType
    ? candidate.destinationType as ExportWorkspaceState["destinationType"]
    : "single_file";
  const invalidChoice = !hasValidOutputFormat || !hasValidDestinationType;
  return {
    audioSetId: !invalidChoice && typeof candidate.audioSetId === "string" ? candidate.audioSetId : null,
    selectedArtifactIds: Array.isArray(candidate.selectedArtifactIds)
      ? candidate.selectedArtifactIds.filter((id): id is string => typeof id === "string")
      : [],
    selectedGeneratedDocumentIds: Array.isArray(candidate.selectedGeneratedDocumentIds)
      ? candidate.selectedGeneratedDocumentIds.filter(
          (id): id is GeneratedExportDocumentId => id === "lyrics" || id === "lyrics_with_chords",
        )
      : [],
    outputFormat,
    filenameBase: typeof candidate.filenameBase === "string" ? candidate.filenameBase : "",
    destinationType,
    desktopDestinationTarget: !invalidChoice && typeof candidate.desktopDestinationTarget === "string"
        ? candidate.desktopDestinationTarget
        : null,
  };
}

export function normalizePlaybackLoopRange(value: unknown): PlaybackLoopRange | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PlaybackLoopRange>;
  const firstPoint = normalizeLoopPoint(candidate.startSeconds);
  const secondPoint = normalizeLoopPoint(candidate.endSeconds);
  if (firstPoint === null || secondPoint === null) {
    return null;
  }

  const startSeconds = Math.min(firstPoint, secondPoint);
  const endSeconds = Math.max(firstPoint, secondPoint);
  if (endSeconds - startSeconds < MIN_PLAYBACK_LOOP_SECONDS) {
    return null;
  }

  return { startSeconds, endSeconds };
}

function isProjectPanelMode(value: unknown): value is ProjectPanelMode {
  return value === "studio" || value === "analysis" || value === "export";
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
    activeWorkspace: isProjectWorkspaceMode(candidate.activeWorkspace)
      ? candidate.activeWorkspace
      : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.activeWorkspace,
    activeProjectPanel: isProjectPanelMode(candidate.activeProjectPanel)
      ? candidate.activeProjectPanel
      : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.activeProjectPanel,
    playbackDisplayMode: isPlaybackDisplayMode(candidate.playbackDisplayMode)
      ? candidate.playbackDisplayMode
      : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.playbackDisplayMode,
    capoTransposeSemitones: normalizeTransposeSemitones(candidate.capoTransposeSemitones),
    precountEnabled:
      typeof candidate.precountEnabled === "boolean"
        ? candidate.precountEnabled
        : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.precountEnabled,
    precountLoopEnabled:
      typeof candidate.precountLoopEnabled === "boolean"
        ? candidate.precountLoopEnabled
        : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.precountLoopEnabled,
    precountClickCount: normalizePrecountClickCount(candidate.precountClickCount),
    tempoTargetBpm: normalizeTempoTargetBpm(candidate.tempoTargetBpm),
    loopRange: normalizePlaybackLoopRange(candidate.loopRange),
    loopAlignmentMode:
      candidate.loopAlignmentMode === null || candidate.loopAlignmentMode === undefined
        ? null
        : normalizeLoopAlignmentMode(candidate.loopAlignmentMode),
    lyricsFollowEnabled:
      typeof candidate.lyricsFollowEnabled === "boolean"
        ? candidate.lyricsFollowEnabled
        : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.lyricsFollowEnabled,
    chordsFollowEnabled:
      typeof candidate.chordsFollowEnabled === "boolean"
        ? candidate.chordsFollowEnabled
        : DEFAULT_STORED_PROJECT_PLAYBACK_STATE.chordsFollowEnabled,
    stemControls,
    dismissedStemJobIds,
    exportWorkspace: normalizeExportWorkspaceState(candidate.exportWorkspace),
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

export function hasProjectPlaybackState(projectId: string) {
  return Object.prototype.hasOwnProperty.call(readPlaybackStateMap(), projectId);
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
