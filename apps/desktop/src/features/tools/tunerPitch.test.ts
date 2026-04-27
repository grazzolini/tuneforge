import { describe, expect, it } from "vitest";
import {
  analyzeTunerBuffer,
  calculateTunerInputLevel,
  formatCents,
  frequencyToTunerReading,
} from "./tunerPitch";

describe("chromatic tuner pitch helpers", () => {
  it("maps frequencies to notes and cents from the selected reference", () => {
    expect(frequencyToTunerReading(440, 440)?.noteName).toBe("A");
    expect(frequencyToTunerReading(440, 440)?.cents).toBeCloseTo(0, 5);
    expect(frequencyToTunerReading(432, 432)?.noteName).toBe("A");

    const sharpReading = frequencyToTunerReading(466.16, 440);
    expect(sharpReading?.noteName).toBe("A#");
    expect(sharpReading?.cents).toBeCloseTo(0, 1);
  });

  it("detects the dominant pitch from a sine buffer", () => {
    const reading = analyzeTunerBuffer(makeSineWave(440), 44100, 440);

    expect(reading?.noteName).toBe("A");
    expect(reading?.frequencyHz).toBeCloseTo(440, 0);
    expect(reading?.cents).toBeCloseTo(0, 0);
    expect(reading?.confidence).toBeGreaterThan(0.9);
  });

  it("ignores silence and formats signed cents", () => {
    expect(analyzeTunerBuffer(new Float32Array(4096), 44100, 440)).toBeNull();
    expect(calculateTunerInputLevel(new Float32Array([0, 0.5, -0.5, 0]))).toBeCloseTo(0.3535, 3);
    expect(formatCents(3.2)).toBe("+3");
    expect(formatCents(-2.6)).toBe("-3");
  });
});

function makeSineWave(frequencyHz: number, sampleRate = 44100) {
  const samples = new Float32Array(4096);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * 0.72;
  }
  return samples;
}
