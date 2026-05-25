export type LoopAlignmentMode = "free" | "beat" | "bar";
export const TIMING_GRID_METERS = ["4/4", "3/4", "6/8"] as const;
export type TimingGridMeter = (typeof TIMING_GRID_METERS)[number];

export type AnalysisTimingBeat = {
  index: number;
  seconds: number;
  bar_index: number;
  beat_in_bar: number;
};

export type AnalysisTimingBar = {
  index: number;
  start_seconds: number;
  end_seconds: number;
};

export type AnalysisTimingGrid = {
  beats_per_bar: number;
  meter: TimingGridMeter;
  source: string;
  downbeat_source: string | null;
  downbeat_confidence: number | null;
  meter_confidence: number | null;
  beats: AnalysisTimingBeat[];
  bars: AnalysisTimingBar[];
};

export const DEFAULT_LOOP_ALIGNMENT_MODE: LoopAlignmentMode = "free";
export const LOOP_ALIGNMENT_MODES: LoopAlignmentMode[] = ["free", "beat", "bar"];
const TIMING_SNAP_EPSILON_SECONDS = 0.08;
const TIMING_JUMP_TOLERANCE_SECONDS = 0.2;

export function isLoopAlignmentMode(value: unknown): value is LoopAlignmentMode {
  return value === "free" || value === "beat" || value === "bar";
}

export function normalizeLoopAlignmentMode(
  value: unknown,
  fallback: LoopAlignmentMode = DEFAULT_LOOP_ALIGNMENT_MODE,
): LoopAlignmentMode {
  return isLoopAlignmentMode(value) ? value : fallback;
}

export function normalizeAnalysisTimingGrid(value: unknown): AnalysisTimingGrid | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AnalysisTimingGrid>;
  const beatsPerBar =
    typeof candidate.beats_per_bar === "number" &&
    Number.isFinite(candidate.beats_per_bar) &&
    candidate.beats_per_bar >= 1
      ? Math.trunc(candidate.beats_per_bar)
      : 4;
  const beats = Array.isArray(candidate.beats)
    ? candidate.beats
        .map(normalizeTimingBeat)
        .filter((beat): beat is AnalysisTimingBeat => beat !== null)
        .sort((first, second) => first.seconds - second.seconds)
    : [];
  const bars = Array.isArray(candidate.bars)
    ? candidate.bars
        .map(normalizeTimingBar)
        .filter((bar): bar is AnalysisTimingBar => bar !== null)
        .sort((first, second) => first.start_seconds - second.start_seconds)
    : [];

  if (beats.length < 2 && bars.length === 0) {
    return null;
  }
  return {
    beats_per_bar: beatsPerBar,
    meter: normalizeTimingGridMeter(candidate.meter, beatsPerBar),
    source: typeof candidate.source === "string" ? candidate.source : "detected",
    downbeat_source: nullableString(candidate.downbeat_source),
    downbeat_confidence: nullableFiniteNumber(candidate.downbeat_confidence),
    meter_confidence: nullableFiniteNumber(candidate.meter_confidence),
    beats,
    bars,
  };
}

export function isTimingGridMeter(value: unknown): value is TimingGridMeter {
  return TIMING_GRID_METERS.some((meter) => meter === value);
}

export function normalizeTimingGridMeter(
  value: unknown,
  fallbackBeatsPerBar = 4,
): TimingGridMeter {
  if (isTimingGridMeter(value)) {
    return value;
  }
  if (fallbackBeatsPerBar === 3) {
    return "3/4";
  }
  if (fallbackBeatsPerBar === 6) {
    return "6/8";
  }
  return "4/4";
}

export function beatsPerBarForTimingGridMeter(meter: TimingGridMeter) {
  if (meter === "3/4") {
    return 3;
  }
  if (meter === "6/8") {
    return 6;
  }
  return 4;
}

export function snapLoopPointToTiming(
  value: number,
  mode: LoopAlignmentMode,
  timingGrid: AnalysisTimingGrid | null,
) {
  if (mode === "free" || !timingGrid) {
    return value;
  }

  const candidates =
    mode === "bar"
      ? timingGrid.bars.map((bar) => bar.start_seconds)
      : timingGrid.beats.map((beat) => beat.seconds);
  if (!candidates.length) {
    return value;
  }
  return nearestTime(value, candidates) ?? value;
}

export function countInIntervalsForTiming({
  clickCount,
  fallbackBeatSeconds,
  startTimeSeconds,
  timingGrid,
}: {
  clickCount: number;
  fallbackBeatSeconds: number;
  startTimeSeconds: number;
  timingGrid: AnalysisTimingGrid | null;
}) {
  const fallbackIntervals = Array.from({ length: clickCount }, () => fallbackBeatSeconds);
  if (!timingGrid || timingGrid.beats.length < 2 || clickCount <= 0) {
    return fallbackIntervals;
  }

  const anchorIndex = timingAnchorBeatIndex(timingGrid.beats, startTimeSeconds);
  if (anchorIndex === null) {
    return fallbackIntervals;
  }

  const localFallback = localBeatSeconds(timingGrid.beats, anchorIndex) ?? fallbackBeatSeconds;
  return fallbackIntervals.map((_interval, index) => {
    const fromIndex = anchorIndex - clickCount + index;
    const toIndex = fromIndex + 1;
    if (
      timingGrid.beats[fromIndex] &&
      timingGrid.beats[toIndex] &&
      timingGrid.beats[toIndex].seconds > timingGrid.beats[fromIndex].seconds
    ) {
      return timingGrid.beats[toIndex].seconds - timingGrid.beats[fromIndex].seconds;
    }
    return localFallback;
  });
}

export function nextTimedBeatIndex({
  lastPlaybackTimeSeconds,
  lastScheduledBeatIndex,
  playbackTimeSeconds,
  timingGrid,
}: {
  lastPlaybackTimeSeconds: number | null;
  lastScheduledBeatIndex: number | null;
  playbackTimeSeconds: number;
  timingGrid: AnalysisTimingGrid;
}) {
  const currentBeatIndex = firstBeatIndexAtOrAfter(timingGrid.beats, playbackTimeSeconds);
  const jumped =
    lastPlaybackTimeSeconds !== null &&
    Math.abs(playbackTimeSeconds - lastPlaybackTimeSeconds) > TIMING_JUMP_TOLERANCE_SECONDS;

  if (lastScheduledBeatIndex === null || jumped) {
    return currentBeatIndex;
  }
  return Math.max(currentBeatIndex, lastScheduledBeatIndex + 1);
}

function normalizeTimingBeat(value: unknown): AnalysisTimingBeat | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AnalysisTimingBeat>;
  if (
    typeof candidate.index !== "number" ||
    typeof candidate.seconds !== "number" ||
    typeof candidate.bar_index !== "number" ||
    typeof candidate.beat_in_bar !== "number" ||
    !Number.isFinite(candidate.seconds)
  ) {
    return null;
  }
  return {
    index: Math.max(0, Math.trunc(candidate.index)),
    seconds: Math.max(0, candidate.seconds),
    bar_index: Math.max(0, Math.trunc(candidate.bar_index)),
    beat_in_bar: Math.max(1, Math.trunc(candidate.beat_in_bar)),
  };
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTimingBar(value: unknown): AnalysisTimingBar | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AnalysisTimingBar>;
  if (
    typeof candidate.index !== "number" ||
    typeof candidate.start_seconds !== "number" ||
    typeof candidate.end_seconds !== "number" ||
    !Number.isFinite(candidate.start_seconds) ||
    !Number.isFinite(candidate.end_seconds)
  ) {
    return null;
  }
  const startSeconds = Math.max(0, candidate.start_seconds);
  const endSeconds = Math.max(startSeconds, candidate.end_seconds);
  return {
    index: Math.max(0, Math.trunc(candidate.index)),
    start_seconds: startSeconds,
    end_seconds: endSeconds,
  };
}

function nearestTime(value: number, candidates: number[]) {
  let nearest: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function timingAnchorBeatIndex(beats: AnalysisTimingBeat[], startTimeSeconds: number) {
  const nearestIndex = nearestBeatIndex(beats, startTimeSeconds);
  if (
    nearestIndex !== null &&
    Math.abs(beats[nearestIndex].seconds - startTimeSeconds) <= TIMING_SNAP_EPSILON_SECONDS
  ) {
    return nearestIndex;
  }
  return firstBeatIndexAtOrAfter(beats, startTimeSeconds);
}

function nearestBeatIndex(beats: AnalysisTimingBeat[], value: number) {
  let nearestIndex: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  beats.forEach((beat, index) => {
    const distance = Math.abs(beat.seconds - value);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function firstBeatIndexAtOrAfter(beats: AnalysisTimingBeat[], value: number) {
  const index = beats.findIndex((beat) => beat.seconds >= value);
  return index === -1 ? beats.length : index;
}

function localBeatSeconds(beats: AnalysisTimingBeat[], anchorIndex: number) {
  const previous = beats[anchorIndex - 1];
  const anchor = beats[anchorIndex];
  if (previous && anchor && anchor.seconds > previous.seconds) {
    return anchor.seconds - previous.seconds;
  }
  const next = beats[anchorIndex + 1];
  if (anchor && next && next.seconds > anchor.seconds) {
    return next.seconds - anchor.seconds;
  }
  return null;
}
