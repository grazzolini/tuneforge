import type { ArtifactSchema, ChordSegmentSchema, JobSchema, LyricsSegmentSchema, LyricsWordSchema } from "../../lib/api";
import { formatLocalDateTime } from "../../lib/datetime";
import {
  formatChordLabel,
  type EnharmonicDisplayMode,
  type MusicalKey,
  transposePitchClass,
} from "../../lib/music";

export type SeekDirection = "backward" | "forward";

export function artifactLabel(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") return "Source Track";
  if (artifact.type === "preview_mix") return "Practice Mix";
  if (artifact.type === "export_mix") return "Export File";
  if (artifact.type === "vocal_stem") return "Vocals";
  if (artifact.type === "instrumental_stem") return "Instrumental";
  if (artifact.type === "analysis_json") return "Analysis JSON";
  return artifact.type;
}

export function isPlayableArtifact(artifact: ArtifactSchema) {
  return ["source_audio", "preview_mix", "vocal_stem", "instrumental_stem"].includes(artifact.type);
}

export function isStemArtifact(artifact: ArtifactSchema | null | undefined) {
  return artifact?.type === "vocal_stem" || artifact?.type === "instrumental_stem";
}

export function preferredArtifactSelection(artifacts: ArtifactSchema[]) {
  return (
    artifacts.find((artifact) => artifact.type === "source_audio") ??
    artifacts.find((artifact) => artifact.type === "preview_mix") ??
    artifacts[0] ??
    null
  );
}

export function fileNameFromPath(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

export function formatSemitoneShift(semitones: number) {
  return `Shift ${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}`;
}

export const MIN_TARGET_TRANSPOSE = -12;
export const MAX_TARGET_TRANSPOSE = 12;

export function clampTargetTranspose(semitones: number) {
  return Math.min(MAX_TARGET_TRANSPOSE, Math.max(MIN_TARGET_TRANSPOSE, semitones));
}

export function formatTargetSelectionSummary(semitones: number) {
  if (semitones === 0) {
    return "Original";
  }
  if (Math.abs(semitones) === 12) {
    return semitones > 0 ? "1 octave higher" : "1 octave lower";
  }
  return semitones > 0 ? "Higher pitch" : "Lower pitch";
}

export type TargetShiftOption = {
  semitones: number;
  key: MusicalKey;
};

export type SourceKeyOption = {
  badge: string | null;
  key: MusicalKey;
  value: string;
};

export function formatArtifactTimestamp(createdAt: string) {
  return formatLocalDateTime(createdAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatJobDuration(durationSeconds: number | null | undefined) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return null;
  }
  if (durationSeconds < 1) {
    return `${Math.max(1, Math.round(durationSeconds * 1000))} ms`;
  }
  if (durationSeconds < 60) {
    return `${durationSeconds < 10 ? durationSeconds.toFixed(1) : Math.round(durationSeconds)} s`;
  }

  return formatPlaybackClock(durationSeconds);
}

export function formatJobStatusSummary(job: JobSchema) {
  return [
    job.status,
    typeof job.runtime_device === "string" ? job.runtime_device.toUpperCase() : null,
    formatJobDuration(job.duration_seconds),
  ]
    .filter(Boolean)
    .join(" / ");
}

export function formatPlaybackClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function artifactSummary(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") {
    return "Original source file";
  }
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const engine = typeof artifact.metadata?.engine === "string" ? artifact.metadata.engine : null;
    const mode = typeof artifact.metadata?.mode === "string" ? artifact.metadata.mode : null;
    const model = typeof artifact.metadata?.model === "string" ? artifact.metadata.model : null;
    const device =
      typeof artifact.metadata?.device === "string" ? artifact.metadata.device.toUpperCase() : null;
    return [
      artifact.type === "vocal_stem" ? "Vocal stem" : "Instrumental stem",
      mode,
      engine,
      model,
      device,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  const metadata = artifact.metadata ?? {};
  const pieces: string[] = [];
  const transpose = metadata.transpose;
  if (
    transpose &&
    typeof transpose === "object" &&
    "semitones" in transpose &&
    typeof transpose.semitones === "number"
  ) {
    pieces.push(formatSemitoneShift(transpose.semitones));
  }

  const retune = metadata.retune;
  if (retune && typeof retune === "object") {
    if ("target_reference_hz" in retune && typeof retune.target_reference_hz === "number") {
      pieces.push(`Retuned to ${retune.target_reference_hz.toFixed(1)} Hz`);
    } else if ("target_cents_offset" in retune && typeof retune.target_cents_offset === "number") {
      const cents = retune.target_cents_offset;
      pieces.push(`Retuned ${cents > 0 ? "+" : ""}${cents.toFixed(1)} cents`);
    }
  }

  return pieces.join(" / ");
}

export function sourceArtifactIdForStems(artifact: ArtifactSchema | null) {
  if (!artifact) return null;
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return typeof sourceArtifactId === "string" ? sourceArtifactId : null;
  }
  if (artifact.type === "source_audio" || artifact.type === "preview_mix") {
    return artifact.id;
  }
  return null;
}

export function artifactById(artifacts: ArtifactSchema[], artifactId: string | null | undefined) {
  if (!artifactId) return null;
  return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

export function artifactTransposeSemitones(
  artifact: ArtifactSchema | null,
  artifacts: ArtifactSchema[],
  depth = 0,
): number {
  if (!artifact || depth > 4) return 0;
  if (artifact.type === "preview_mix" || artifact.type === "export_mix") {
    const metadata = artifact.metadata ?? {};
    const transpose =
      typeof metadata.transpose === "object" && metadata.transpose !== null ? metadata.transpose : {};
    const semitones = "semitones" in transpose ? transpose.semitones : null;
    return typeof semitones === "number" ? semitones : 0;
  }
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return artifactTransposeSemitones(
      artifactById(
        artifacts,
        typeof sourceArtifactId === "string" ? sourceArtifactId : null,
      ),
      artifacts,
      depth + 1,
    );
  }
  return 0;
}

export function transposeChordSegment(
  segment: ChordSegmentSchema,
  semitones: number,
  options: { activeKey: MusicalKey | null; mode: EnharmonicDisplayMode },
): ChordSegmentSchema {
  if (
    typeof segment.pitch_class !== "number" ||
    (segment.quality !== "major" && segment.quality !== "minor")
  ) {
    return segment;
  }
  const pitchClass = transposePitchClass(segment.pitch_class, semitones);
  return {
    ...segment,
    pitch_class: pitchClass,
    label: formatChordLabel(pitchClass, segment.quality, options),
  };
}

export function findActiveChordIndex(timeline: ChordSegmentSchema[], playbackTimeSeconds: number) {
  return timeline.findIndex((segment, index) => {
    const isLast = index === timeline.length - 1;
    return (
      playbackTimeSeconds >= segment.start_seconds &&
      (playbackTimeSeconds < segment.end_seconds || isLast)
    );
  });
}

export function hasTimedLyrics(
  segment: LyricsSegmentSchema,
): segment is LyricsSegmentSchema & { start_seconds: number; end_seconds: number } {
  return typeof segment.start_seconds === "number" && typeof segment.end_seconds === "number";
}

export function findActiveLyricsIndex(timeline: LyricsSegmentSchema[], playbackTimeSeconds: number) {
  return timeline.findIndex((segment, index) => {
    if (!hasTimedLyrics(segment)) {
      return false;
    }
    const isLast = index === timeline.length - 1;
    return (
      playbackTimeSeconds >= segment.start_seconds &&
      (playbackTimeSeconds < segment.end_seconds || isLast)
    );
  });
}

export function findActiveLyricsWordIndex(words: LyricsWordSchema[], playbackTimeSeconds: number) {
  return words.findIndex((word, index) => {
    if (typeof word.start_seconds !== "number" || typeof word.end_seconds !== "number") {
      return false;
    }
    const isLast = index === words.length - 1;
    return (
      playbackTimeSeconds >= word.start_seconds &&
      (playbackTimeSeconds < word.end_seconds || isLast)
    );
  });
}

export type LeadSheetChordAnchor =
  | {
      type: "word";
      wordIndex: number;
    }
  | {
      type: "percent";
      percent: number;
    };

export type LeadSheetChord = {
  anchor: LeadSheetChordAnchor;
  chordIndex: number;
  id: string;
  isActive: boolean;
  segment: ChordSegmentSchema;
};

export type LeadSheetLyricsRow = {
  activeWordIndex: number;
  chords: LeadSheetChord[];
  id: string;
  isActive: boolean;
  lyricIndex: number;
  segment: LyricsSegmentSchema;
  type: "lyrics";
};

export type LeadSheetChordRow = {
  chords: LeadSheetChord[];
  id: string;
  isActive: boolean;
  type: "chords";
};

export type LeadSheetRow = LeadSheetLyricsRow | LeadSheetChordRow;

type BuildLeadSheetRowsOptions = {
  activeChordIndex: number;
  activeLyricsIndex: number;
  activeLyricsWordIndex: number;
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function chordLeadSheetId(segment: ChordSegmentSchema, chordIndex: number) {
  return `chord-${chordIndex}-${segment.start_seconds}-${segment.label}`;
}

function chordAnchorForLyricsSegment(
  chord: ChordSegmentSchema,
  segment: LyricsSegmentSchema,
): LeadSheetChordAnchor {
  if (segment.words?.length) {
    const wordIndex = findActiveLyricsWordIndex(segment.words, chord.start_seconds);
    if (wordIndex >= 0) {
      return { type: "word", wordIndex };
    }
  }

  if (hasTimedLyrics(segment) && segment.end_seconds > segment.start_seconds) {
    return {
      type: "percent",
      percent: clampPercent(
        ((chord.start_seconds - segment.start_seconds) /
          (segment.end_seconds - segment.start_seconds)) *
          100,
      ),
    };
  }

  return { type: "percent", percent: 0 };
}

function findLyricsIndexForChord(
  lyrics: LyricsSegmentSchema[],
  chord: ChordSegmentSchema,
) {
  return lyrics.findIndex((segment) => {
    if (!hasTimedLyrics(segment)) {
      return false;
    }
    return (
      chord.start_seconds >= segment.start_seconds &&
      chord.start_seconds < segment.end_seconds
    );
  });
}

function findGapInsertionIndex(lyrics: LyricsSegmentSchema[], chord: ChordSegmentSchema) {
  const nextTimedLyricsIndex = lyrics.findIndex(
    (segment) => hasTimedLyrics(segment) && chord.start_seconds < segment.start_seconds,
  );
  return nextTimedLyricsIndex >= 0 ? nextTimedLyricsIndex : lyrics.length;
}

function leadSheetChord(
  chord: ChordSegmentSchema,
  chordIndex: number,
  anchor: LeadSheetChordAnchor,
  activeChordIndex: number,
): LeadSheetChord {
  return {
    anchor,
    chordIndex,
    id: chordLeadSheetId(chord, chordIndex),
    isActive: chordIndex === activeChordIndex,
    segment: chord,
  };
}

export function buildLeadSheetRows(
  lyrics: LyricsSegmentSchema[],
  chords: ChordSegmentSchema[],
  { activeChordIndex, activeLyricsIndex, activeLyricsWordIndex }: BuildLeadSheetRowsOptions,
): LeadSheetRow[] {
  const chordsByLyricsIndex = new Map<number, LeadSheetChord[]>();
  const gapChordsByInsertionIndex = new Map<number, LeadSheetChord[]>();

  chords.forEach((chord, chordIndex) => {
    const lyricIndex = findLyricsIndexForChord(lyrics, chord);
    if (lyricIndex >= 0) {
      const segment = lyrics[lyricIndex];
      const current = chordsByLyricsIndex.get(lyricIndex) ?? [];
      current.push(
        leadSheetChord(
          chord,
          chordIndex,
          chordAnchorForLyricsSegment(chord, segment),
          activeChordIndex,
        ),
      );
      chordsByLyricsIndex.set(lyricIndex, current);
      return;
    }

    const insertionIndex = findGapInsertionIndex(lyrics, chord);
    const current = gapChordsByInsertionIndex.get(insertionIndex) ?? [];
    current.push(
      leadSheetChord(chord, chordIndex, { type: "percent", percent: 0 }, activeChordIndex),
    );
    gapChordsByInsertionIndex.set(insertionIndex, current);
  });

  const rows: LeadSheetRow[] = [];
  for (let index = 0; index <= lyrics.length; index += 1) {
    const gapChords = gapChordsByInsertionIndex.get(index) ?? [];
    if (gapChords.length) {
      rows.push({
        chords: gapChords,
        id: `lead-sheet-gap-${index}-${gapChords[0]?.segment.start_seconds ?? 0}`,
        isActive: gapChords.some((chord) => chord.isActive),
        type: "chords",
      });
    }

    const segment = lyrics[index];
    if (segment) {
      rows.push({
        activeWordIndex: index === activeLyricsIndex ? activeLyricsWordIndex : -1,
        chords: chordsByLyricsIndex.get(index) ?? [],
        id: `lead-sheet-lyrics-${index}-${segment.start_seconds ?? "static"}`,
        isActive: index === activeLyricsIndex,
        lyricIndex: index,
        segment,
        type: "lyrics",
      });
    }
  }

  if (!lyrics.length && !rows.length && chords.length) {
    rows.push({
      chords: chords.map((chord, chordIndex) =>
        leadSheetChord(chord, chordIndex, { type: "percent", percent: 0 }, activeChordIndex),
      ),
      id: "lead-sheet-gap-0",
      isActive: activeChordIndex >= 0,
      type: "chords",
    });
  }

  return rows;
}

export function formatRetuneSummary(
  retuneMode: "off" | "reference" | "cents",
  referenceHz: string,
  centsOffset: string,
) {
  if (retuneMode === "off") {
    return "No fine retune";
  }
  if (retuneMode === "reference") {
    return `Retuned to ${referenceHz} Hz`;
  }
  return `Retuned ${Number(centsOffset) > 0 ? "+" : ""}${centsOffset} cents`;
}
