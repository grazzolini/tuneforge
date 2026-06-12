import type { ChordSegmentSchema } from "../../lib/api";
import type { MusicalKey } from "../../lib/music";

export type ChordDictionaryFollowStatus =
  | "no-project"
  | "follow-off"
  | "paused"
  | "no-chord-timeline"
  | "no-current-chord"
  | "active";

export type ChordDictionaryFollowProjectContext = {
  projectId: string;
  projectName: string;
  selectedPlaybackArtifactId: string | null;
  sourceKey: MusicalKey | null;
  displayedKey: MusicalKey | null;
  totalDisplayTransposeSemitones: number;
  visualCapoSemitoneShift: number;
  authoritativeSourceTimeline: ChordSegmentSchema[];
  displayedTimeline: ChordSegmentSchema[];
};

export type ChordDictionaryFollowChordContext = {
  index: number;
  sourceLabel: string;
  displayLabel: string;
  sourceSegment: ChordSegmentSchema;
  displayedSegment: ChordSegmentSchema;
};

export type ChordDictionaryFollowContext = {
  status: ChordDictionaryFollowStatus;
  project: ChordDictionaryFollowProjectContext | null;
  playbackTimeSeconds: number;
  currentChord: ChordDictionaryFollowChordContext | null;
  nextChord: ChordDictionaryFollowChordContext | null;
};

export type BuildChordDictionaryFollowContextParams = {
  project: ChordDictionaryFollowProjectContext | null;
  followArmed: boolean;
  playbackActive: boolean;
  playbackTimeSeconds: number;
};

export type BuildChordDictionaryFollowProjectContextParams = {
  projectId: string;
  projectName: string;
  selectedPlaybackArtifactId: string | null;
  sourceKey: MusicalKey | null;
  displayedKey: MusicalKey | null;
  totalDisplayTransposeSemitones: number;
  visualCapoSemitoneShift: number;
  authoritativeSourceTimeline: ChordSegmentSchema[];
  displayedTimeline: ChordSegmentSchema[];
};

export function buildChordDictionaryFollowProjectContext({
  projectId,
  projectName,
  selectedPlaybackArtifactId,
  sourceKey,
  displayedKey,
  totalDisplayTransposeSemitones,
  visualCapoSemitoneShift,
  authoritativeSourceTimeline,
  displayedTimeline,
}: BuildChordDictionaryFollowProjectContextParams): ChordDictionaryFollowProjectContext {
  return {
    projectId,
    projectName,
    selectedPlaybackArtifactId,
    sourceKey,
    displayedKey,
    totalDisplayTransposeSemitones,
    visualCapoSemitoneShift,
    authoritativeSourceTimeline,
    displayedTimeline,
  };
}

function chordContextAtIndex(
  project: ChordDictionaryFollowProjectContext,
  index: number,
): ChordDictionaryFollowChordContext | null {
  const sourceSegment = project.authoritativeSourceTimeline[index];
  const displayedSegment = project.displayedTimeline[index];
  if (!sourceSegment || !displayedSegment) {
    return null;
  }
  return {
    index,
    sourceLabel: sourceSegment.label,
    displayLabel: displayedSegment.label,
    sourceSegment,
    displayedSegment,
  };
}

function findCurrentChordIndex(timeline: ChordSegmentSchema[], playbackTimeSeconds: number) {
  if (!Number.isFinite(playbackTimeSeconds)) {
    return -1;
  }
  return timeline.findIndex(
    (segment) =>
      playbackTimeSeconds >= segment.start_seconds &&
      playbackTimeSeconds < segment.end_seconds,
  );
}

function findNextChordIndex(timeline: ChordSegmentSchema[], playbackTimeSeconds: number) {
  if (!Number.isFinite(playbackTimeSeconds)) {
    return -1;
  }
  return timeline.findIndex((segment) => segment.start_seconds > playbackTimeSeconds);
}

export function buildChordDictionaryFollowContext({
  project,
  followArmed,
  playbackActive,
  playbackTimeSeconds,
}: BuildChordDictionaryFollowContextParams): ChordDictionaryFollowContext {
  const baseContext = {
    project,
    playbackTimeSeconds,
    currentChord: null,
    nextChord: null,
  } satisfies Omit<ChordDictionaryFollowContext, "status">;

  if (!project) {
    return {
      ...baseContext,
      status: "no-project",
    };
  }
  if (!followArmed) {
    return {
      ...baseContext,
      status: "follow-off",
    };
  }
  if (!playbackActive) {
    return {
      ...baseContext,
      status: "paused",
    };
  }
  if (
    project.authoritativeSourceTimeline.length === 0 ||
    project.displayedTimeline.length === 0
  ) {
    return {
      ...baseContext,
      status: "no-chord-timeline",
    };
  }

  const currentChordIndex = findCurrentChordIndex(
    project.authoritativeSourceTimeline,
    playbackTimeSeconds,
  );
  const currentChord =
    currentChordIndex >= 0 ? chordContextAtIndex(project, currentChordIndex) : null;
  const nextChordIndex =
    currentChordIndex >= 0
      ? currentChordIndex + 1
      : findNextChordIndex(project.authoritativeSourceTimeline, playbackTimeSeconds);
  const nextChord = nextChordIndex >= 0 ? chordContextAtIndex(project, nextChordIndex) : null;

  if (!currentChord) {
    return {
      project,
      playbackTimeSeconds,
      currentChord: null,
      nextChord,
      status: "no-current-chord",
    };
  }

  return {
    project,
    playbackTimeSeconds,
    currentChord,
    nextChord,
    status: "active",
  };
}
