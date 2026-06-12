import { describe, expect, it } from "vitest";
import { nextToolSearchParams } from "./toolRouting";

describe("ToolsView routing", () => {
  it("preserves playback follow params when selecting Chord Dictionary", () => {
    const nextSearchParams = nextToolSearchParams(
      new URLSearchParams("tool=metronome&bpm=121.5&followPlayback=1&projectId=proj_123"),
      "chord-dictionary",
    );

    expect(nextSearchParams.toString()).toBe(
      "tool=chord-dictionary&followPlayback=1&projectId=proj_123",
    );
  });

  it("clears playback follow params when selecting the default tuner", () => {
    const nextSearchParams = nextToolSearchParams(
      new URLSearchParams("tool=chord-dictionary&followPlayback=1&projectId=proj_123"),
      "tuner",
    );

    expect(nextSearchParams.toString()).toBe("");
  });

  it("does not leak Chord Dictionary follow params when selecting Metronome", () => {
    const nextSearchParams = nextToolSearchParams(
      new URLSearchParams("tool=chord-dictionary&followPlayback=1&projectId=proj_123"),
      "metronome",
    );

    expect(nextSearchParams.toString()).toBe("tool=metronome");
  });
});
