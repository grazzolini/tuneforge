import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceMockAnimationFrames,
  getMockAudioContexts,
  resetAppTestHarness,
} from "./appTestHarness";

describe("mock animation frames", () => {
  beforeEach(resetAppTestHarness);

  it("does not run callbacks until a frame is advanced and shares a frame timestamp", () => {
    const first = vi.fn();
    const second = vi.fn();

    window.requestAnimationFrame(first);
    window.requestAnimationFrame(second);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    advanceMockAnimationFrames();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first.mock.calls[0]?.[0]).toBe(second.mock.calls[0]?.[0]);
  });

  it("defers nested callbacks to the next explicit frame", () => {
    const nested = vi.fn();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(nested);
    });

    advanceMockAnimationFrames();
    expect(nested).not.toHaveBeenCalled();
    advanceMockAnimationFrames();
    expect(nested).toHaveBeenCalledOnce();
  });

  it("allows an earlier callback to cancel a later callback in the same frame", () => {
    const later = vi.fn();
    let laterId = 0;
    window.requestAnimationFrame(() => {
      window.cancelAnimationFrame(laterId);
    });
    laterId = window.requestAnimationFrame(later);
    advanceMockAnimationFrames();
    expect(later).not.toHaveBeenCalled();
  });

  it("clears queued callbacks and restarts timestamps when reset", () => {
    const leaked = vi.fn();
    window.requestAnimationFrame(leaked);
    resetAppTestHarness();
    const next = vi.fn();
    const frameId = window.requestAnimationFrame(next);
    advanceMockAnimationFrames();
    expect(leaked).not.toHaveBeenCalled();
    expect(frameId).toBe(1);
    expect(next).toHaveBeenCalledWith(1000 / 60);
  });

  it("advances running audio time once per frame, not once per callback", () => {
    const audioContext = new AudioContext();
    window.requestAnimationFrame(vi.fn());
    window.requestAnimationFrame(vi.fn());

    advanceMockAnimationFrames();
    expect(getMockAudioContexts()).toHaveLength(1);
    expect(getMockAudioContexts()[0]?.currentTime).toBeCloseTo(1 / 60, 10);
    advanceMockAnimationFrames(2);
    expect(getMockAudioContexts()[0]?.currentTime).toBeCloseTo(3 / 60, 10);
    void audioContext;
  });

  it("rejects invalid frame counts", () => {
    expect(() => advanceMockAnimationFrames(-1)).toThrow(RangeError);
    expect(() => advanceMockAnimationFrames(1.5)).toThrow(RangeError);
    expect(() => advanceMockAnimationFrames(Number.NaN)).toThrow(RangeError);
  });
});
