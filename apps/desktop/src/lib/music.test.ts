import { describe, expect, it } from "vitest";
import {
  formatChordDisplay,
  formatChordLabel,
  formatKey,
  formatKeyDisplay,
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

  it("renders dual labels in fixed note order with minor suffixes preserved", () => {
    expect(formatKeyDisplay({ pitchClass: 3, mode: "minor" }, { mode: "dual" })).toEqual({
      ariaLabel: "D#m / Ebm",
      primary: { root: "D#", suffix: "m" },
      secondary: { root: "Eb", suffix: "m" },
    });
    expect(formatChordDisplay(3, "minor", { mode: "dual" })).toEqual({
      ariaLabel: "D#m / Ebm",
      primary: { root: "D#", suffix: "m" },
      secondary: { root: "Eb", suffix: "m" },
    });
  });

  it("formats supported chord extensions", () => {
    expect(formatChordLabel(0, "7")).toBe("C7");
    expect(formatChordLabel(0, "maj7")).toBe("Cmaj7");
    expect(formatChordLabel(0, "m7")).toBe("Cm7");
    expect(formatChordLabel(0, "sus4")).toBe("Csus4");
    expect(formatChordLabel(0, "dim")).toBe("Cdim");
    expect(formatChordDisplay(1, "sus2", { mode: "dual" })).toEqual({
      ariaLabel: "C#sus2 / Dbsus2",
      primary: { root: "C#", suffix: "sus2" },
      secondary: { root: "Db", suffix: "sus2" },
    });
  });
});
