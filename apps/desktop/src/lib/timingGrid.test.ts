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
  meter: "4/4",
  source: "detected",
  downbeat_source: "source",
  downbeat_confidence: 0.82,
  meter_confidence: 0.91,
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
      sourceTempoBpm: 120,
      startTimeSeconds: 2.04,
      targetTempoBpm: 120,
      timingGrid,
    });
    expect(intervals[0]).toBeCloseTo(0.48, 3);
    expect(intervals[1]).toBeCloseTo(0.53, 3);
    expect(intervals[2]).toBeCloseTo(0.49, 3);
    expect(intervals[3]).toBeCloseTo(0.54, 3);
  });

  it("rejects doubled source gaps and keeps valid local variation", () => {
    const variedGrid: AnalysisTimingGrid = {
      ...timingGrid,
      beats: [
        { index: 0, seconds: 0, bar_index: 0, beat_in_bar: 1 },
        { index: 1, seconds: 0.48, bar_index: 0, beat_in_bar: 2 },
        { index: 2, seconds: 1.48, bar_index: 0, beat_in_bar: 3 },
        { index: 3, seconds: 1.99, bar_index: 0, beat_in_bar: 4 },
        { index: 4, seconds: 2.49, bar_index: 1, beat_in_bar: 1 },
      ],
    };
    const intervals = countInIntervalsForTiming({
        clickCount: 4,
        fallbackBeatSeconds: 0.5,
        sourceTempoBpm: 120,
        startTimeSeconds: 2.49,
        targetTempoBpm: 120,
        timingGrid: variedGrid,
      });
    expect(intervals[0]).toBeCloseTo(0.48, 6);
    expect(intervals[1]).toBeCloseTo(0.5, 6);
    expect(intervals[2]).toBeCloseTo(0.51, 6);
    expect(intervals[3]).toBeCloseTo(0.5, 6);
  });

  it("uses source BPM for validation and scales accepted gaps to displayed tempo", () => {
    const fastGrid: AnalysisTimingGrid = {
      ...timingGrid,
      beats: [
        { index: 0, seconds: 0, bar_index: 0, beat_in_bar: 1 },
        { index: 1, seconds: 0.24, bar_index: 0, beat_in_bar: 2 },
        { index: 2, seconds: 0.5, bar_index: 0, beat_in_bar: 3 },
        { index: 3, seconds: 0.75, bar_index: 0, beat_in_bar: 4 },
      ],
    };
    expect(
      countInIntervalsForTiming({
        clickCount: 3,
        fallbackBeatSeconds: 0.5,
        sourceTempoBpm: 240,
        startTimeSeconds: 0.75,
        targetTempoBpm: 120,
        timingGrid: fastGrid,
      }),
    ).toEqual([0.48, 0.52, 0.5]);
  });

  it("fills pre-song intervals from beat gaps without treating intro silence as a beat", () => {
    const introGrid: AnalysisTimingGrid = {
      ...timingGrid,
      beats: [
        { index: 0, seconds: 4, bar_index: 0, beat_in_bar: 1 },
        { index: 1, seconds: 4.5, bar_index: 0, beat_in_bar: 2 },
        { index: 2, seconds: 5, bar_index: 0, beat_in_bar: 3 },
      ],
    };
    expect(
      countInIntervalsForTiming({
        clickCount: 4,
        fallbackBeatSeconds: 0.5,
        sourceTempoBpm: 120,
        startTimeSeconds: 0,
        targetTempoBpm: 120,
        timingGrid: introGrid,
      }),
    ).toEqual([0.5, 0.5, 0.5, 0.5]);
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

  it("resets scheduled beat lookup after a backward seek", () => {
    expect(
      nextTimedBeatIndex({
        lastPlaybackTimeSeconds: 1.5,
        lastScheduledBeatIndex: 3,
        playbackTimeSeconds: 0.49,
        timingGrid,
      }),
    ).toBe(2);
  });

  it("resets scheduled beat lookup after a forward seek", () => {
    expect(
      nextTimedBeatIndex({
        lastPlaybackTimeSeconds: 0.51,
        lastScheduledBeatIndex: 2,
        playbackTimeSeconds: 2.04,
        timingGrid,
      }),
    ).toBe(4);
  });
});
