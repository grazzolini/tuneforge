import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRECOUNT_GAIN, schedulePrecountClaveClick } from "./precountSound";

type MockAudioParam = AudioParam & {
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
};

type MockGainNode = GainNode & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  gain: MockAudioParam;
};

type MockOscillatorNode = OscillatorNode & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  frequency: MockAudioParam;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type MockAudioContext = AudioContext & {
  createdOscillators: MockOscillatorNode[];
  createGain: ReturnType<typeof vi.fn>;
};

function getMockAudioContexts() {
  return (
    globalThis as typeof globalThis & {
      __mockAudioContexts: MockAudioContext[];
    }
  ).__mockAudioContexts;
}

describe("precount sound", () => {
  beforeEach(() => {
    getMockAudioContexts().length = 0;
  });

  it("schedules the shared 760 Hz triangle count-in envelope", () => {
    const audioContext = new AudioContext() as MockAudioContext;

    schedulePrecountClaveClick({
      audioContext,
      startTimeSeconds: 1.25,
    });

    const oscillator = audioContext.createdOscillators[0];
    const gainNode = audioContext.createGain.mock.results[0]?.value as MockGainNode | undefined;
    if (!oscillator || !gainNode) {
      throw new Error("Expected precount click nodes to be created.");
    }

    expect(oscillator.type).toBe("triangle");
    const startFrequencyCall = oscillator.frequency.setValueAtTime.mock.calls[0];
    const startFrequencyHz = Number(startFrequencyCall?.[0]);
    const safeStartTimeSeconds = Number(startFrequencyCall?.[1]);
    expect(startFrequencyHz).toBe(760);
    expect(startFrequencyHz).toBeLessThan(1450);
    expect(oscillator.frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(safeStartTimeSeconds).toBe(1.25);

    expect(gainNode.gain.setValueAtTime).toHaveBeenCalledWith(0.0001, 1.25);
    const peakGainCall = gainNode.gain.exponentialRampToValueAtTime.mock.calls[0];
    const releaseGainCall = gainNode.gain.exponentialRampToValueAtTime.mock.calls[1];
    expect(peakGainCall?.[0]).toBe(PRECOUNT_GAIN);
    expect(PRECOUNT_GAIN).toBe(1);
    expect(Number(peakGainCall?.[1]) - safeStartTimeSeconds).toBeCloseTo(0.002, 6);
    expect(releaseGainCall?.[0]).toBe(0.0001);
    const stopTimeSeconds = Number(releaseGainCall?.[1]);
    expect(stopTimeSeconds - safeStartTimeSeconds).toBeCloseTo(0.045, 6);
    expect(oscillator.connect).toHaveBeenCalledWith(gainNode);
    expect(gainNode.connect).toHaveBeenCalledWith(audioContext.destination);

    expect(oscillator.start).toHaveBeenCalledWith(1.25);
    expect(Number(oscillator.stop.mock.calls[0]?.[0]) - stopTimeSeconds).toBeCloseTo(0.004, 6);
  });
});
