import { describe, expect, it } from "vitest";
import {
  countInIntervalsForTiming,
  nextTimedBeatIndex,
  normalizeAnalysisTimingGrid,
  normalizeLoopAlignmentMode,
  snapLoopPointToTiming,
  type AnalysisTimingGrid,
} from "./timingGrid";

const timingGrid: AnalysisTimingGrid = {
  beats_per_bar: 4,
  source: "detected",
  beats: [
    { index: 0, seconds: 0, bar_index: 0, beat_in_bar: 1 },
    { index: 1, seconds: 0.48, bar_index: 0, beat_in_bar: 2 },
    { index: 2, seconds: 1.01, bar_index: 0, beat_in_bar: 3 },
    { index: 3, seconds: 1.5, bar_index: 0, beat_in_bar: 4 },
    { index: 4, seconds: 2.04, bar_index: 1, beat_in_bar: 1 },
  ],
  bars: [
    { index: 0, start_seconds: 0, end_seconds: 2.04 },
    { index: 1, start_seconds: 2.04, end_seconds: 4 },
  ],
};

describe("timing grid helpers", () => {
  it("normalizes loop modes and timing payloads", () => {
    expect(normalizeLoopAlignmentMode("beat")).toBe("beat");
    expect(normalizeLoopAlignmentMode("bad")).toBe("free");
    expect(normalizeAnalysisTimingGrid(timingGrid)?.beats).toHaveLength(5);
    expect(normalizeAnalysisTimingGrid({ beats: [], bars: [] })).toBeNull();
  });

  it("snaps loop points to beats or bars when timing exists", () => {
    expect(snapLoopPointToTiming(0.52, "free", timingGrid)).toBe(0.52);
    expect(snapLoopPointToTiming(0.52, "beat", timingGrid)).toBe(0.48);
    expect(snapLoopPointToTiming(1.8, "bar", timingGrid)).toBe(2.04);
    expect(snapLoopPointToTiming(1.8, "bar", null)).toBe(1.8);
  });

  it("uses local beat intervals for count-in timing", () => {
    const intervals = countInIntervalsForTiming({
      clickCount: 4,
      fallbackBeatSeconds: 0.5,
      startTimeSeconds: 2.04,
      timingGrid,
    });
    expect(intervals[0]).toBeCloseTo(0.48, 3);
    expect(intervals[1]).toBeCloseTo(0.53, 3);
    expect(intervals[2]).toBeCloseTo(0.49, 3);
    expect(intervals[3]).toBeCloseTo(0.54, 3);
  });

  it("finds the next timed beat without rescheduling old beats", () => {
    expect(
      nextTimedBeatIndex({
        lastPlaybackTimeSeconds: null,
        lastScheduledBeatIndex: null,
        playbackTimeSeconds: 0.5,
        timingGrid,
      }),
    ).toBe(2);
    expect(
      nextTimedBeatIndex({
        lastPlaybackTimeSeconds: 0.5,
        lastScheduledBeatIndex: 2,
        playbackTimeSeconds: 0.51,
        timingGrid,
      }),
    ).toBe(3);
  });
});
