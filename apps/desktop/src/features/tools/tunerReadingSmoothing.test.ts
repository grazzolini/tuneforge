import { describe, expect, it } from "vitest";
import {
  createStabilizedTunerReadingState,
  updateStabilizedTunerReading,
} from "./tunerReadingSmoothing";
import { type TunerPitchReading } from "./tunerPitch";

describe("tuner reading smoothing", () => {
  it("holds the last pitch through short no-pitch gaps", () => {
    let state = createStabilizedTunerReadingState();
    state = updateStabilizedTunerReading(state, makeReading("A", 9, 4), 0);
    state = updateStabilizedTunerReading(state, null, 180);

    expect(state.displayedReading?.noteName).toBe("A");

    state = updateStabilizedTunerReading(state, null, 260);

    expect(state.displayedReading).toBeNull();
  });

  it("smooths same-note cents changes", () => {
    let state = createStabilizedTunerReadingState();
    state = updateStabilizedTunerReading(state, makeReading("A", 9, 18), 0);
    state = updateStabilizedTunerReading(state, makeReading("A", 9, -2), 16);

    expect(state.displayedReading?.cents).toBeGreaterThan(-2);
    expect(state.displayedReading?.cents).toBeLessThan(18);
  });

  it("debounces single-frame note changes", () => {
    let state = createStabilizedTunerReadingState();
    state = updateStabilizedTunerReading(state, makeReading("A", 9, 8), 0);
    state = updateStabilizedTunerReading(state, makeReading("G#", 8, 2), 32);

    expect(state.displayedReading?.noteName).toBe("A");

    state = updateStabilizedTunerReading(state, makeReading("G#", 8, 1), 130);

    expect(state.displayedReading?.noteName).toBe("G#");
  });
});

function makeReading(noteName: string, pitchClass: number, cents: number): TunerPitchReading {
  const targetFrequencyHz = 440;
  const frequencyHz = targetFrequencyHz * 2 ** (cents / 1200);
  return {
    cents,
    confidence: 0.95,
    frequencyHz,
    inputLevel: 0.5,
    noteName,
    pitchClass,
    targetFrequencyHz,
  };
}
