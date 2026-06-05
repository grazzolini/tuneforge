import { describe, expect, it } from "vitest";
import {
  formatParsedChordLabel,
  formatPitch,
  formatChordDisplay,
  formatChordLabel,
  formatKey,
  formatKeyDisplay,
  formatPitchClass,
  generateGuitarVoicings,
  getCapoShapeChord,
  getEnharmonicContext,
  midiToPitch,
  parseChordLabel,
  parsePitch,
  pitchToMidi,
  spellChord,
  transposeChordLabel,
  type ChordDisplayContext,
  type ChordSpelling,
  type GuitarVoicing,
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
    expect(formatChordLabel(2, "major", { mode: "sharps" }, 6)).toBe("D/F#");
    expect(formatChordLabel(0, "minor", { mode: "flats" }, 7)).toBe("Cm/G");
    expect(formatChordLabel(0, "hdim7")).toBe("Cm7b5");
  });
});

function requireChord(label: string): ChordSpelling {
  const chord = spellChord(label);
  if (!chord) {
    throw new Error(`Expected ${label} to parse`);
  }
  return chord;
}

function requireFirstVoicing(label: string, context: Partial<ChordDisplayContext> = {}): GuitarVoicing {
  const voicing = generateGuitarVoicings(label, undefined, context)[0];
  if (!voicing) {
    throw new Error(`Expected ${label} to produce a voicing`);
  }
  return voicing;
}

describe("pitch parsing and midi conversion", () => {
  it("parses pitch labels with octaves", () => {
    expect(parsePitch("C4")).toEqual({
      pitchClass: 0,
      octave: 4,
      midi: 60,
      noteName: "C",
      label: "C4",
    });
    expect(parsePitch("Db3")).toMatchObject({
      pitchClass: 1,
      octave: 3,
      midi: 49,
      noteName: "Db",
      label: "Db3",
    });
    expect(parsePitch("E2")?.midi).toBe(40);
    expect(parsePitch("H2")).toBeNull();
  });

  it("formats pitches and converts midi values", () => {
    expect(pitchToMidi({ pitchClass: 6, octave: 4 })).toBe(66);
    expect(formatPitch({ pitchClass: 10, octave: 3 }, { mode: "sharps" })).toBe("A#3");
    expect(midiToPitch(61, { mode: "flats" })).toEqual({
      pitchClass: 1,
      octave: 4,
      midi: 61,
      noteName: "Db",
      label: "Db4",
    });
  });
});

describe("chord parsing and spelling", () => {
  it("parses compact chord labels and slash bass notes", () => {
    expect(parseChordLabel("G/D")).toEqual({
      root: "G",
      rootPitchClass: 7,
      quality: "major",
      bass: "D",
      bassPitchClass: 2,
    });
    expect(parseChordLabel("Cmaj7")?.quality).toBe("maj7");
    expect(parseChordLabel("Am7")?.quality).toBe("m7");
    expect(parseChordLabel("Bdim")?.quality).toBe("dim");
  });

  it("spells requested chord qualities", () => {
    expect(requireChord("C").notes).toEqual(["C", "E", "G"]);
    expect(requireChord("Dm").notes).toEqual(["D", "F", "A"]);
    expect(requireChord("Bdim").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:B",
      "b3:D",
      "b5:F",
    ]);
    expect(requireChord("G7").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:G",
      "3:B",
      "5:D",
      "b7:F",
    ]);
    expect(requireChord("Cmaj7").notes).toEqual(["C", "E", "G", "B"]);
    expect(requireChord("Am7").notes).toEqual(["A", "C", "E", "G"]);
    expect(requireChord("G/D").bassNoteName).toBe("D");
  });

  it("transposes chord labels by semitones", () => {
    expect(transposeChordLabel("C", 2)).toBe("D");
    expect(transposeChordLabel("G/D", 2)).toBe("A/E");
    expect(formatParsedChordLabel(requireChord("Cmaj7"), { mode: "flats" })).toBe("Cmaj7");
  });
});

describe("guitar chord voicings", () => {
  it("ranks C major open shape first with exact sounding notes", () => {
    const voicing = requireFirstVoicing("C");
    expect(voicing).toMatchObject({
      id: "c-open",
      shapeFamily: "C",
      source: "common",
      mutedStrings: [6],
    });
    expect(voicing.notes.map(({ string, fret, note, degree }) => ({ string, fret, note, degree }))).toEqual([
      { string: 5, fret: 3, note: "C3", degree: "1" },
      { string: 4, fret: 2, note: "E3", degree: "3" },
      { string: 3, fret: 0, note: "G3", degree: "5" },
      { string: 2, fret: 1, note: "C4", degree: "1" },
      { string: 1, fret: 0, note: "E4", degree: "3" },
    ]);
  });

  it("returns G major open shape", () => {
    const voicing = requireFirstVoicing("G");
    expect(voicing.shapeFamily).toBe("G");
    expect(voicing.notes.map(({ string, fret, note, degree }) => ({ string, fret, note, degree }))).toEqual([
      { string: 6, fret: 3, note: "G2", degree: "1" },
      { string: 5, fret: 2, note: "B2", degree: "3" },
      { string: 4, fret: 0, note: "D3", degree: "5" },
      { string: 3, fret: 0, note: "G3", degree: "1" },
      { string: 2, fret: 0, note: "B3", degree: "3" },
      { string: 1, fret: 3, note: "G4", degree: "1" },
    ]);
  });

  it("returns Am open shape", () => {
    const voicing = requireFirstVoicing("Am");
    expect(voicing.shapeFamily).toBe("A");
    expect(voicing.notes.map(({ string, fret, note, degree }) => ({ string, fret, note, degree }))).toEqual([
      { string: 5, fret: 0, note: "A2", degree: "1" },
      { string: 4, fret: 2, note: "E3", degree: "5" },
      { string: 3, fret: 2, note: "A3", degree: "1" },
      { string: 2, fret: 1, note: "C4", degree: "b3" },
      { string: 1, fret: 0, note: "E4", degree: "5" },
    ]);
  });

  it("returns F barre before open partial shape", () => {
    const voicings = generateGuitarVoicings("F");
    expect(voicings.map((voicing) => voicing.id).slice(0, 2)).toEqual(["f-e-barre", "f-partial"]);
    expect(voicings[0]?.notes.map(({ string, fret, note, degree }) => ({ string, fret, note, degree }))).toEqual([
      { string: 6, fret: 1, note: "F2", degree: "1" },
      { string: 5, fret: 3, note: "C3", degree: "5" },
      { string: 4, fret: 3, note: "F3", degree: "1" },
      { string: 3, fret: 2, note: "A3", degree: "3" },
      { string: 2, fret: 1, note: "C4", degree: "5" },
      { string: 1, fret: 1, note: "F4", degree: "1" },
    ]);
  });

  it("returns Cmaj7 and G7 open extensions", () => {
    expect(requireFirstVoicing("Cmaj7").notes.map(({ note, degree }) => `${note}:${degree}`)).toEqual([
      "C3:1",
      "E3:3",
      "G3:5",
      "B3:7",
      "E4:3",
    ]);
    expect(requireFirstVoicing("G7").notes.map(({ note, degree }) => `${note}:${degree}`)).toEqual([
      "G2:1",
      "B2:3",
      "D3:5",
      "G3:1",
      "B3:3",
      "F4:b7",
    ]);
  });

  it("keeps slash chord bass as the lowest sounding guitar note", () => {
    const voicing = requireFirstVoicing("G/D");
    expect(voicing).toMatchObject({
      id: "g-over-d-open",
      chordLabel: "G/D",
    });
    expect(voicing.notes[0]).toMatchObject({
      note: "D3",
      degree: "5",
      string: 4,
      fret: 0,
    });
  });

  it("uses capo shapes while preserving sounding chord notes", () => {
    const context: Partial<ChordDisplayContext> = {
      sourceKey: { pitchClass: 6, mode: "major" },
      capoFret: 2,
      useCapoShapes: true,
      canCapo: true,
    };
    expect(formatParsedChordLabel(getCapoShapeChord("F#", context) ?? requireChord("E"))).toBe("E");

    const voicing = requireFirstVoicing("F#", context);
    expect(voicing).toMatchObject({
      shapeFamily: "E",
      chordLabel: "F#",
      shapeChordLabel: "E",
      capoFret: 2,
    });
    expect(voicing.notes.map(({ string, fret, note, degree }) => ({ string, fret, note, degree }))).toEqual([
      { string: 6, fret: 0, note: "F#2", degree: "1" },
      { string: 5, fret: 2, note: "C#3", degree: "5" },
      { string: 4, fret: 2, note: "F#3", degree: "1" },
      { string: 3, fret: 1, note: "A#3", degree: "3" },
      { string: 2, fret: 0, note: "C#4", degree: "5" },
      { string: 1, fret: 0, note: "F#4", degree: "1" },
    ]);
  });
});
