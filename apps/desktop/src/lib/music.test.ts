import { describe, expect, it } from "vitest";
import {
  formatChordLabel,
  formatKey,
  formatPitchClass,
  getEnharmonicContext,
  type MusicalKey,
} from "./music";

describe("enharmonic formatting", () => {
  it("uses neutral fallback when context is unknown", () => {
    expect(formatPitchClass(1)).toBe("C#");
    expect(formatPitchClass(3)).toBe("Eb");
    expect(formatPitchClass(8)).toBe("Ab");
    expect(formatPitchClass(10)).toBe("Bb");
  });

  it("uses sharp spellings in sharp key contexts", () => {
    const sharpKey: MusicalKey = { pitchClass: 7, mode: "major" };
    expect(getEnharmonicContext(sharpKey).family).toBe("sharp");
    expect(formatPitchClass(6, { activeKey: sharpKey })).toBe("F#");
    expect(formatPitchClass(10, { activeKey: sharpKey })).toBe("A#");
  });

  it("uses flat spellings in flat key contexts", () => {
    const flatKey: MusicalKey = { pitchClass: 3, mode: "major" };
    expect(getEnharmonicContext(flatKey).family).toBe("flat");
    expect(formatPitchClass(8, { activeKey: flatKey })).toBe("Ab");
    expect(formatPitchClass(10, { activeKey: flatKey })).toBe("Bb");
  });

  it("formats keys canonically in auto mode", () => {
    expect(formatKey({ pitchClass: 3, mode: "minor" })).toBe("Ebm");
    expect(formatKey({ pitchClass: 1, mode: "major" })).toBe("Db");
    expect(formatKey({ pitchClass: 9, mode: "minor" })).toBe("Am");
  });

  it("supports explicit spelling overrides", () => {
    expect(formatKey({ pitchClass: 3, mode: "minor" }, "short", { mode: "sharps" })).toBe("D#m");
    expect(formatKey({ pitchClass: 1, mode: "major" }, "short", { mode: "flats" })).toBe("Db");
    expect(formatPitchClass(8, { mode: "neutral" })).toBe("Ab");
    expect(formatChordLabel(10, "major", { mode: "dual" })).toBe("A#/Bb");
  });
});
