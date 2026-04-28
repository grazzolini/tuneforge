import { describe, expect, it } from "vitest";
import {
  MAX_METRONOME_BPM,
  MIN_METRONOME_BPM,
  createTapTempoState,
  nextSyncedBeatIndex,
  normalizeBeatsPerBar,
  normalizeMetronomeBpm,
  updateTapTempo,
} from "./metronomeUtils";

describe("metronome utils", () => {
  it("normalizes tempo and meter inputs", () => {
    expect(normalizeMetronomeBpm(12)).toBe(MIN_METRONOME_BPM);
    expect(normalizeMetronomeBpm(260)).toBe(MAX_METRONOME_BPM);
    expect(normalizeMetronomeBpm("121.48")).toBe(121.5);
    expect(normalizeMetronomeBpm("nope", 132)).toBe(132);
    expect(normalizeBeatsPerBar(0)).toBe(1);
    expect(normalizeBeatsPerBar(14)).toBe(12);
    expect(normalizeBeatsPerBar("7.9")).toBe(7);
  });

  it("calculates tap tempo from recent valid taps", () => {
    let state = createTapTempoState();
    let result = updateTapTempo(state, 0);
    expect(result.bpm).toBeNull();

    state = result.state;
    result = updateTapTempo(state, 500);
    expect(result.bpm).toBe(120);

    state = result.state;
    result = updateTapTempo(state, 1000);
    expect(result.bpm).toBe(120);
  });

  it("ignores accidental double taps and resets after idle gaps", () => {
    let state = createTapTempoState();
    state = updateTapTempo(state, 0).state;

    const ignored = updateTapTempo(state, 120);
    expect(ignored.bpm).toBeNull();
    expect(ignored.state).toBe(state);

    const reset = updateTapTempo(state, 3200);
    expect(reset.bpm).toBeNull();
    expect(reset.state.tapTimesMs).toEqual([3200]);
  });

  it("realigns synced beats after playback jumps", () => {
    expect(
      nextSyncedBeatIndex({
        bpm: 120,
        lastPlaybackTimeSeconds: null,
        lastScheduledBeatIndex: null,
        playbackTimeSeconds: 0,
      }),
    ).toBe(0);
    expect(
      nextSyncedBeatIndex({
        bpm: 120,
        lastPlaybackTimeSeconds: 0.1,
        lastScheduledBeatIndex: 1,
        playbackTimeSeconds: 0.11,
      }),
    ).toBe(2);
    expect(
      nextSyncedBeatIndex({
        bpm: 120,
        lastPlaybackTimeSeconds: 12,
        lastScheduledBeatIndex: 30,
        playbackTimeSeconds: 4,
      }),
    ).toBe(8);
  });
});
