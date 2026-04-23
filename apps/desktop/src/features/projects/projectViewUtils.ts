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
