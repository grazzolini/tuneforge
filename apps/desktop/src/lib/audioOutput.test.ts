import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceMockAnimationFrames } from "../test/appTestHarness";
import {
  getAppAudioOutputNode,
  getCountInAudioOutputNode,
  getMetronomeAudioOutputNode,
  getProjectAudioOutputNode,
  registerProjectMediaElement,
  projectMediaElementSupportsVolume,
  setBrowserAppOutput,
  setBrowserCueOutputs,
  setBrowserProjectOutput,
  unregisterProjectMediaElement,
  updateProjectMediaElement,
} from "./audioOutput";

type MockGainNode = GainNode & {
  connect: ReturnType<typeof vi.fn>;
};

describe("browser audio output routing", () => {
  beforeEach(() => {
    setBrowserAppOutput({ gain: 1, muted: false });
    setBrowserProjectOutput({ gain: 1, muted: false });
    setBrowserCueOutputs({ gain: 1, muted: false }, { gain: 0.8, muted: false });
  });

  it("routes count-in and metronome categories through the shared app bus", () => {
    setBrowserCueOutputs({ gain: 0.3, muted: false }, { gain: 0.6, muted: false });
    const context = new AudioContext();
    const appNode = getAppAudioOutputNode(context) as MockGainNode;
    const countInNode = getCountInAudioOutputNode(context) as MockGainNode;
    const metronomeNode = getMetronomeAudioOutputNode(context) as MockGainNode;

    expect(countInNode.gain.value).toBe(0.3);
    expect(metronomeNode.gain.value).toBe(0.6);
    expect(countInNode.connect).toHaveBeenCalledWith(appNode);
    expect(metronomeNode.connect).toHaveBeenCalledWith(appNode);
  });

  it("mutes cue categories without losing their configured gains", () => {
    setBrowserCueOutputs({ gain: 0.3, muted: true }, { gain: 0.6, muted: true });
    const mutedContext = new AudioContext();
    expect(getCountInAudioOutputNode(mutedContext).gain.value).toBe(0);
    expect(getMetronomeAudioOutputNode(mutedContext).gain.value).toBe(0);

    setBrowserCueOutputs({ gain: 0.3, muted: false }, { gain: 0.6, muted: false });
    const restoredContext = new AudioContext();
    expect(getCountInAudioOutputNode(restoredContext).gain.value).toBe(0.3);
    expect(getMetronomeAudioOutputNode(restoredContext).gain.value).toBe(0.6);
  });

  it("routes project audio through project and app gain nodes", () => {
    setBrowserAppOutput({ gain: 0.4, muted: false });
    setBrowserProjectOutput({ gain: 0.5, muted: false });
    const context = new AudioContext();

    const projectNode = getProjectAudioOutputNode(context) as MockGainNode;
    const appNode = getAppAudioOutputNode(context) as MockGainNode;

    expect(projectNode.gain.value).toBe(0.5);
    expect(appNode.gain.value).toBe(0.4);
    expect(projectNode.connect).toHaveBeenCalledWith(appNode);
    expect(appNode.connect).toHaveBeenCalledWith(context.destination);
  });

  it("updates existing HTML primary and stem elements without restarting them", () => {
    const primary = document.createElement("audio");
    const stem = document.createElement("audio");
    registerProjectMediaElement(primary, 1);
    registerProjectMediaElement(stem, 0.5);

    setBrowserProjectOutput({ gain: 0.5, muted: false });
    setBrowserAppOutput({ gain: 0.4, muted: false });
    advanceMockAnimationFrames(2);

    expect(primary.volume).toBeCloseTo(0.2, 4);
    expect(stem.volume).toBeCloseTo(0.1, 4);

    expect(updateProjectMediaElement(stem, 0.25)).toBe(true);
    advanceMockAnimationFrames(1);
    expect(stem.volume).toBeCloseTo(0.05, 4);
    expect(primary.paused).toBe(true);
    unregisterProjectMediaElement(primary);
    unregisterProjectMediaElement(stem);
  });

  it("rejects non-finite active updates without changing current output", () => {
    setBrowserAppOutput({ gain: 0.35, muted: true });
    setBrowserProjectOutput({ gain: 0.6, muted: false });

    expect(setBrowserAppOutput({ gain: Number.NaN, muted: false })).toBe(false);
    expect(setBrowserProjectOutput({ gain: Number.POSITIVE_INFINITY, muted: true })).toBe(false);

    const context = new AudioContext();
    expect(getAppAudioOutputNode(context).gain.value).toBe(0);
    expect(getProjectAudioOutputNode(context).gain.value).toBe(0.6);
  });

  it("detects HTML media elements that ignore programmatic volume", () => {
    const element = document.createElement("audio");
    Object.defineProperty(element, "volume", {
      configurable: true,
      get: () => 1,
      set: () => undefined,
    });

    expect(registerProjectMediaElement(element, 0.5)).toBe(false);
    expect(projectMediaElementSupportsVolume(element)).toBe(false);
    unregisterProjectMediaElement(element);
  });
});
