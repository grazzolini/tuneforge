import { describe, expect, it } from "vitest";
import {
  ACCORDION_STANDARD_PROFILE,
  INSTRUMENT_PROFILES,
  PIANO_STANDARD_PROFILE,
  formatParsedChordLabel,
  formatPitch,
  formatChordDisplay,
  formatChordLabel,
  formatKey,
  formatKeyDisplay,
  formatPitchClass,
  generateAccordionVoicings,
  generateGuitarVoicings,
  generatePianoVoicings,
  getCapoShapeChord,
  getEnharmonicContext,
  midiToPitch,
  parseChordLabel,
  parsePitch,
  pitchToMidi,
  spellChord,
  transposeChordLabel,
  type AccordionLeftHandCandidate,
  type AccordionVoicing,
  type AccordionVoicingContext,
  type ChordDisplayContext,
  type ChordSpelling,
  type GuitarVoicing,
  type MusicalKey,
  type PianoVoicing,
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

function requireVoicings(label: string, context: Partial<ChordDisplayContext> = {}): readonly GuitarVoicing[] {
  const voicings = generateGuitarVoicings(label, undefined, context);
  if (voicings.length === 0) {
    throw new Error(`Expected ${label} to produce voicings`);
  }
  return voicings;
}

function requireAccordionVoicing(label: string, context: AccordionVoicingContext | null = null): AccordionVoicing {
  const voicing = generateAccordionVoicings(label, context)[0];
  if (!voicing) {
    throw new Error(`Expected ${label} to produce an accordion voicing`);
  }
  return voicing;
}

function requirePianoVoicings(label: string, context: MusicalKey | null = null): readonly PianoVoicing[] {
  const voicings = generatePianoVoicings(label, context);
  if (voicings.length === 0) {
    throw new Error(`Expected ${label} to produce piano voicings`);
  }
  return voicings;
}

function requirePianoVoicing(label: string, context: MusicalKey | null = null): PianoVoicing {
  const voicing = requirePianoVoicings(label, context)[0];
  if (!voicing) {
    throw new Error(`Expected ${label} to produce a piano voicing`);
  }
  return voicing;
}

function requirePianoInversion(label: string, inversionIndex: number): PianoVoicing {
  const voicing = requirePianoVoicings(label).find((candidate) => candidate.inversion.index === inversionIndex);
  if (!voicing) {
    throw new Error(`Expected ${label} to include piano inversion ${inversionIndex}`);
  }
  return voicing;
}

function requireSelectedAccordionLeftHand(
  label: string,
  context: AccordionVoicingContext | null = null,
): AccordionLeftHandCandidate {
  const selected = requireAccordionVoicing(label, context).selectedLeftHandCandidate;
  if (!selected) {
    throw new Error(`Expected ${label} to produce an accordion left-hand candidate`);
  }
  return selected;
}

function visibleStradellaBassColumns(voicing: AccordionVoicing): readonly number[] {
  return [
    ...new Set(
      voicing.visibleStradellaButtons
        .filter((button) => button.rowId === "bass")
        .map((button) => button.column),
    ),
  ].sort((left, right) => left - right);
}

function findAccordionLeftHand(
  label: string,
  key: MusicalKey,
  bassRoot: string,
  chordRoot: string,
  chordRow: AccordionLeftHandCandidate["chordButton"]["rowId"],
): AccordionLeftHandCandidate {
  const voicing = requireAccordionVoicing(label, key);
  const candidate = voicing.leftHandCandidates.find(
    (leftHand) =>
      leftHand.bassButton.root === bassRoot &&
      leftHand.chordButton.root === chordRoot &&
      leftHand.chordButton.rowId === chordRow,
  );
  if (!candidate) {
    throw new Error(`Expected ${label} to include ${bassRoot} bass + ${chordRoot} ${chordRow}`);
  }
  return candidate;
}

function requireGeneratedVoicing(label: string, context: Partial<ChordDisplayContext> = {}): GuitarVoicing {
  const voicing = requireVoicings(label, context).find((candidate) => candidate.source === "generated");
  if (!voicing) {
    throw new Error(`Expected ${label} to produce a generated voicing`);
  }
  return voicing;
}

function requireLowestNote(voicing: GuitarVoicing): GuitarVoicing["notes"][number] {
  const lowest = [...voicing.notes].sort((left, right) => left.pitch.midi - right.pitch.midi)[0];
  if (!lowest) {
    throw new Error(`Expected ${voicing.chordLabel} voicing to include notes`);
  }
  return lowest;
}

function fretSpan(voicing: GuitarVoicing): number {
  const frettedNotes = voicing.notes.map((note) => note.fret).filter((fret) => fret > 0);
  if (frettedNotes.length <= 1) {
    return 0;
  }
  return Math.max(...frettedNotes) - Math.min(...frettedNotes);
}

function expectVoicingCoversChord(label: string, voicing: GuitarVoicing): void {
  const chord = requireChord(label);
  const degrees = new Set(voicing.notes.map((note) => note.degree));
  expect(chord.tones.map((tone) => tone.degree).filter((degree) => !degrees.has(degree))).toEqual([]);
}

function expectLowestBass(label: string, voicing: GuitarVoicing): void {
  const chord = requireChord(label);
  if (typeof chord.bassPitchClass !== "number") {
    throw new Error(`Expected ${label} to include slash bass`);
  }
  expect(requireLowestNote(voicing).pitch.pitchClass).toBe(chord.bassPitchClass);
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
    expect(parseChordLabel("C7b5")?.quality).toBe("7b5");
  });

  it("parses backend Harte-style labels into canonical chord symbols", () => {
    expect(parseChordLabel("D:maj/3")).toMatchObject({
      rawLabel: "D:maj/3",
      root: "D",
      rootPitchClass: 2,
      quality: "major",
      bass: "F#",
      bassPitchClass: 6,
      bassDegree: "3",
    });
    expect(formatParsedChordLabel(requireChord("D:maj/3"))).toBe("D/F#");

    expect(parseChordLabel("C:min/5")).toMatchObject({
      rawLabel: "C:min/5",
      root: "C",
      rootPitchClass: 0,
      quality: "minor",
      bass: "G",
      bassPitchClass: 7,
      bassDegree: "5",
    });
    expect(formatParsedChordLabel(requireChord("C:min/5"))).toBe("Cm/G");

    expect(parseChordLabel("C:min7(b5)")).toMatchObject({
      rawLabel: "C:min7(b5)",
      root: "C",
      rootPitchClass: 0,
      quality: "hdim7",
      bass: null,
      bassPitchClass: null,
    });
    expect(formatParsedChordLabel(requireChord("C:min7(b5)"))).toBe("Cm7b5");
  });

  it("normalizes lead-sheet aliases without changing source-label truth", () => {
    expect(parseChordLabel("Cmin")).toMatchObject({ rawLabel: "Cmin", quality: "minor" });
    expect(parseChordLabel("Cminor")).toMatchObject({ rawLabel: "Cminor", quality: "minor" });
    expect(parseChordLabel("Csus")).toMatchObject({ rawLabel: "Csus", quality: "sus4" });
    expect(parseChordLabel("C+")).toMatchObject({ rawLabel: "C+", quality: "aug" });
    expect(parseChordLabel("Cdim7")).toMatchObject({ rawLabel: "Cdim7", quality: "dim7" });
    expect(parseChordLabel("Cm7b5")).toMatchObject({ rawLabel: "Cm7b5", quality: "hdim7" });

    expect(formatParsedChordLabel(requireChord("Cmin"))).toBe("Cm");
    expect(formatParsedChordLabel(requireChord("Cminor"))).toBe("Cm");
    expect(formatParsedChordLabel(requireChord("Csus"))).toBe("Csus4");
    expect(formatParsedChordLabel(requireChord("C+"))).toBe("Caug");
    expect(formatParsedChordLabel(requireChord("Cdim7"))).toBe("Cdim7");
    expect(formatParsedChordLabel(requireChord("Cm7b5"))).toBe("Cm7b5");
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

  it("spells expanded chord qualities", () => {
    expect(requireChord("Csus2").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:C",
      "2:D",
      "5:G",
    ]);
    expect(requireChord("Csus4").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:C",
      "4:F",
      "5:G",
    ]);
    expect(requireChord("Caug").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:C",
      "3:E",
      "#5:G#",
    ]);
    expect(requireChord("Cdim7").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:C",
      "b3:Eb",
      "b5:Gb",
      "bb7:Bbb",
    ]);
    expect(requireChord("C7b5").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:C",
      "3:E",
      "b5:Gb",
      "b7:Bb",
    ]);
    expect(requireChord("C:hdim7").tones.map((tone) => `${tone.degree}:${tone.noteName}`)).toEqual([
      "1:C",
      "b3:Eb",
      "b5:Gb",
      "b7:Bb",
    ]);
  });

  it("uses key and display context for enharmonic chord spelling", () => {
    expect(spellChord("F#:sus4", { activeKey: { pitchClass: 2, mode: "major" } })?.notes).toEqual([
      "F#",
      "B",
      "C#",
    ]);
    expect(spellChord("Bb:7", { activeKey: { pitchClass: 3, mode: "major" } })?.notes).toEqual([
      "Bb",
      "D",
      "F",
      "Ab",
    ]);
    expect(formatParsedChordLabel(requireChord("Db:maj/3"), { mode: "sharps" })).toBe("C#/F");
    expect(formatParsedChordLabel(requireChord("D#:min/5"), { mode: "flats" })).toBe("Ebm/Bb");
  });

  it("parses slash bass notes and degrees without guessing instrument voicings", () => {
    expect(requireChord("D/F#")).toMatchObject({
      root: "D",
      rootPitchClass: 2,
      quality: "major",
      bass: "F#",
      bassPitchClass: 6,
      bassNoteName: "F#",
    });
    expect(requireChord("D:maj/3")).toMatchObject({
      root: "D",
      rootPitchClass: 2,
      quality: "major",
      bass: "F#",
      bassPitchClass: 6,
      bassDegree: "3",
      bassNoteName: "F#",
    });
  });

  it("transposes chord labels by semitones", () => {
    expect(transposeChordLabel("C", 2)).toBe("D");
    expect(transposeChordLabel("G/D", 2)).toBe("A/E");
    expect(formatParsedChordLabel(requireChord("Cmaj7"), { mode: "flats" })).toBe("Cmaj7");
  });

  it("transposes slash bass notes and degree basses with the root", () => {
    expect(transposeChordLabel("D/F#", 2, { mode: "sharps" })).toBe("E/G#");
    expect(transposeChordLabel("D:maj/3", 2, { mode: "sharps" })).toBe("E/G#");
    expect(transposeChordLabel("C:min/5", 2)).toBe("Dm/A");
    expect(transposeChordLabel("Eb/Bb", -2, { mode: "flats" })).toBe("Db/Ab");
  });

  it("fails gracefully for no-chord, unknown, and unsupported labels", () => {
    for (const label of ["", "N", "NC", "N.C.", "X", "Hmaj7", "C:13", "C/Garbage"]) {
      expect(parseChordLabel(label)).toBeNull();
      expect(spellChord(label)).toBeNull();
      expect(transposeChordLabel(label, 2)).toBeNull();
      expect(generateGuitarVoicings(label)).toEqual([]);
    }
  });
});

describe("piano chord voicings", () => {
  it("exports standard piano profile with 88-key A0-C8 metadata", () => {
    expect(PIANO_STANDARD_PROFILE).toMatchObject({
      id: "piano",
      label: "Piano",
      family: "keyboards",
      keyboard: {
        keyCount: 88,
        lowestPitch: { label: "A0", midi: 21 },
        highestPitch: { label: "C8", midi: 108 },
        canTranspose: false,
      },
    });
    expect(INSTRUMENT_PROFILES.piano).toBe(PIANO_STANDARD_PROFILE);
  });

  it("generates C major root position with exact octave labels and degrees", () => {
    const voicing = requirePianoInversion("C", 0);

    expect(voicing).toMatchObject({
      chordLabel: "C",
      label: "C root position",
      inversion: {
        index: 0,
        label: "root position",
        bassDegree: "1",
        isRootPosition: true,
      },
      regionRoot: { pitchClass: 0, note: "C" },
    });
    expect(voicing.notes.map(({ note, degree, pitch, handHint }) => ({ note, degree, pitch, handHint }))).toEqual([
      {
        note: "C4",
        degree: "1",
        pitch: { pitchClass: 0, octave: 4, midi: 60, noteName: "C", label: "C4" },
        handHint: "right",
      },
      {
        note: "E4",
        degree: "3",
        pitch: { pitchClass: 4, octave: 4, midi: 64, noteName: "E", label: "E4" },
        handHint: "right",
      },
      {
        note: "G4",
        degree: "5",
        pitch: { pitchClass: 7, octave: 4, midi: 67, noteName: "G", label: "G4" },
        handHint: "right",
      },
    ]);
  });

  it("exposes exact pitch data for major, minor, and seventh chords inside range", () => {
    for (const label of ["C", "Am", "G7", "Cmaj7", "Dm7"]) {
      const voicing = requirePianoVoicing(label);
      const chord = requireChord(label);
      expect(new Set(voicing.notes.map((note) => note.degree))).toEqual(
        new Set(chord.tones.map((tone) => tone.degree)),
      );
      expect(voicing.notes.map((note) => note.pitch.midi)).toEqual(
        [...voicing.notes].map((note) => note.pitch.midi).sort((left, right) => left - right),
      );
      for (const note of voicing.notes) {
        expect(note.pitch.label).toBe(note.note);
        expect(note.pitch.label).toMatch(/^[A-G](?:#|b)?-?\d+$/);
        expect(note.pitch.midi).toBeGreaterThanOrEqual(PIANO_STANDARD_PROFILE.keyboard.lowestPitch.midi);
        expect(note.pitch.midi).toBeLessThanOrEqual(PIANO_STANDARD_PROFILE.keyboard.highestPitch.midi);
      }
    }
  });

  it("defaults unconstrained major and minor piano chords to root position across roots", () => {
    const roots = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];

    for (const label of roots.flatMap((root) => [root, `${root}m`])) {
      const voicings = requirePianoVoicings(label);
      const chord = requireChord(label);

      expect(voicings[0]?.rank).toBe(1);
      expect(voicings[0]?.inversion).toMatchObject({
        index: 0,
        label: "root position",
        bassDegree: "1",
        isRootPosition: true,
      });
      expect(voicings[0]?.notes[0]?.degree).toBe("1");
      expect(voicings[0]?.notes[0]?.pitch.pitchClass).toBe(chord.rootPitchClass);
    }
  });

  it("keeps generated close inversions available after the root-position default", () => {
    const cVoicings = requirePianoVoicings("C", { pitchClass: 0, mode: "major" });
    expect(cVoicings.map((voicing) => voicing.rank)).toEqual([1, 2, 3]);
    expect(cVoicings[0]?.inversion.index).toBe(0);
    expect([...cVoicings].map((voicing) => voicing.inversion.index).sort()).toEqual([0, 1, 2]);

    const gRegionVoicings = generatePianoVoicings("C", {
      regionKey: { pitchClass: 7, mode: "major" },
    });
    expect(gRegionVoicings[0]).toMatchObject({
      regionRoot: { pitchClass: 7, note: "G" },
      inversion: { index: 2, label: "second inversion", bassDegree: "5" },
    });
    expect(gRegionVoicings[0]?.notes.map((note) => note.note)).toEqual(["G3", "C4", "E4"]);
    expect(gRegionVoicings.find((voicing) => voicing.inversion.index === 0)?.notes.map((note) => note.note)).toEqual([
      "C4",
      "E4",
      "G4",
    ]);

    const fRootVoicings = generatePianoVoicings("C", { currentChordRoot: "F" });
    expect(fRootVoicings[0]?.regionRoot).toEqual({ pitchClass: 5, note: "F" });
    expect(fRootVoicings[0]).toMatchObject({
      inversion: { index: 1, label: "first inversion", bassDegree: "3" },
    });
    expect(fRootVoicings[0]?.notes.map((note) => note.note)).toEqual(["E4", "G4", "C5"]);
  });

  it("keeps supported slash bass as the lowest piano note", () => {
    const cOverE = requirePianoVoicing("C/E");
    expect(cOverE).toMatchObject({
      chordLabel: "C/E",
      inversion: { index: 1, label: "first inversion", bassDegree: "3", isRootPosition: false },
    });
    expect(cOverE.notes[0]).toMatchObject({
      note: "E4",
      degree: "3",
      pitch: { pitchClass: 4 },
    });

    const gOverD = requirePianoVoicing("G/D");
    expect(gOverD).toMatchObject({
      chordLabel: "G/D",
      inversion: { index: 2, label: "second inversion", bassDegree: "5", isRootPosition: false },
    });
    expect(gOverD.notes[0]).toMatchObject({
      note: "D4",
      degree: "5",
      pitch: { pitchClass: 2 },
    });
  });

  it("returns no piano voicings for unsupported chord symbols", () => {
    expect(generatePianoVoicings("Cadd9")).toEqual([]);
    expect(generatePianoVoicings("N.C.")).toEqual([]);
    expect(generatePianoVoicings("C/F#")).toEqual([]);
  });
});

describe("accordion chord voicings", () => {
  const cMajor: MusicalKey = { pitchClass: 0, mode: "major" };
  const gMajor: MusicalKey = { pitchClass: 7, mode: "major" };

  it("exports standard accordion profile with keyboard and Stradella board metadata", () => {
    expect(ACCORDION_STANDARD_PROFILE).toMatchObject({
      id: "accordion",
      label: "Accordion",
      family: "free-reed",
      keyboard: {
        keyCount: 41,
        lowestPitch: { label: "F3", midi: 53 },
        highestPitch: { label: "A6", midi: 93 },
        canTranspose: false,
      },
      buttonBoard: {
        layout: "stradella-120-bass",
        buttons: 120,
        rows: 6,
        columns: 20,
        canTranspose: false,
      },
    });
    expect(ACCORDION_STANDARD_PROFILE.buttonBoard.stradella.rows.map((row) => row.id)).toEqual([
      "counterbass",
      "bass",
      "major",
      "minor",
      "seventh",
      "diminished",
    ]);
  });

  it("selects exact C left hand as C bass plus C major", () => {
    const voicing = requireAccordionVoicing("C", cMajor);
    const selected = requireSelectedAccordionLeftHand("C", cMajor);

    expect(voicing.regionRoot).toEqual({ pitchClass: 0, note: "C" });
    expect(voicing.visibleStradellaButtons).toHaveLength(66);
    expect(selected).toMatchObject({
      quality: "exact",
      bassButton: { rowId: "bass", root: "C" },
      chordButton: { rowId: "major", root: "C" },
      fingering: { bass: 4, chord: 3, label: "4-3" },
      missingTones: [],
      addedTones: [],
    });
  });

  it("finds exact Cmaj7 left hand via C bass plus E minor", () => {
    const selected = requireSelectedAccordionLeftHand("Cmaj7", cMajor);

    expect(selected).toMatchObject({
      quality: "exact",
      bassButton: { rowId: "bass", root: "C" },
      chordButton: { rowId: "minor", root: "E" },
      fingering: { bass: 4, chord: 2, label: "4-2" },
      missingTones: [],
      addedTones: [],
    });
  });

  it("searches the full Stradella board while keeping out-of-window chord roots visible", () => {
    const voicing = requireAccordionVoicing("F#", cMajor);
    const selected = requireSelectedAccordionLeftHand("F#", cMajor);

    expect(voicing.regionRoot).toEqual({ pitchClass: 0, note: "C" });
    expect(voicing.visibleStradellaButtons).toHaveLength(66);
    expect(selected).toMatchObject({
      quality: "exact",
      bassButton: { rowId: "bass", root: "F#" },
      chordButton: { rowId: "major", root: "F#" },
      missingTones: [],
      addedTones: [],
    });
    expect(voicing.visibleStradellaButtons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowId: "bass", root: "C" }),
        expect.objectContaining({ rowId: "bass", root: "F#" }),
        expect.objectContaining({ rowId: "major", root: "F#" }),
      ]),
    );
  });

  it("reports dominant-flat-five Stradella omissions without fake empty labels", () => {
    const cSevenFlatFive = findAccordionLeftHand("C7b5", cMajor, "C", "C", "seventh");

    expect(cSevenFlatFive).toMatchObject({
      quality: "approx",
      missingTones: ["Gb"],
      addedTones: [],
      fingering: { bass: 4, chord: 2, label: "4-2" },
    });
  });

  it("uses root bass plus Stradella seventh buttons for dominant seventh left-hand voicings", () => {
    expect(requireSelectedAccordionLeftHand("G7")).toMatchObject({
      label: "G bass + G7(no5)",
      quality: "approx",
      bassButton: { rowId: "bass", root: "G" },
      chordButton: { rowId: "seventh", root: "G" },
      missingTones: ["D"],
      addedTones: [],
    });
    expect(requireSelectedAccordionLeftHand("C7")).toMatchObject({
      label: "C bass + C7(no5)",
      quality: "approx",
      bassButton: { rowId: "bass", root: "C" },
      chordButton: { rowId: "seventh", root: "C" },
      missingTones: ["G"],
      addedTones: [],
    });
    expect(requireSelectedAccordionLeftHand("B7")).toMatchObject({
      label: "B bass + B7(no5)",
      quality: "approx",
      bassButton: { rowId: "bass", root: "B" },
      chordButton: { rowId: "seventh", root: "B" },
      missingTones: ["F#"],
      addedTones: [],
    });
  });

  it("labels diminished Stradella candidates by searched chord and physical button", () => {
    expect(requireSelectedAccordionLeftHand("Bdim")).toMatchObject({
      label: "B bass + Bdim (Ddim7(no5) button)",
      quality: "exact",
      bassButton: { rowId: "bass", root: "B" },
      chordButton: { rowId: "diminished", root: "D" },
      missingTones: [],
      addedTones: [],
    });
    expect(requireSelectedAccordionLeftHand("Cdim")).toMatchObject({
      label: "C bass + Cdim (Ebdim7(no5) button)",
      quality: "exact",
      bassButton: { rowId: "bass", root: "C" },
      chordButton: { rowId: "diminished", root: "Eb" },
      missingTones: [],
      addedTones: [],
    });
    expect(requireSelectedAccordionLeftHand("Cdim7")).toMatchObject({
      label: "C bass + Cdim7 (Gbdim7(no5) button)",
      quality: "exact",
      bassButton: { rowId: "bass", root: "C" },
      chordButton: { rowId: "diminished", root: "Gb" },
      missingTones: [],
      addedTones: [],
    });
  });

  it("deduplicates identical visible left-hand candidates", () => {
    const voicing = requireAccordionVoicing("C", cMajor);
    const visibleOptions = voicing.leftHandCandidates.map((candidate) =>
      [
        candidate.label,
        candidate.quality,
        candidate.fingering.label,
        candidate.missingTones.join(","),
        candidate.addedTones.join(","),
      ].join("|"),
    );

    expect(new Set(visibleOptions).size).toBe(visibleOptions.length);
    expect(voicing.leftHandCandidates.filter((candidate) => candidate.label === "C bass + CM")).toHaveLength(1);
  });

  it("keeps static duplicated-root Stradella windows centered", () => {
    const cVoicing = requireAccordionVoicing("C", null);
    const bVoicing = requireAccordionVoicing("B", null);

    expect(cVoicing.selectedLeftHandCandidate).toMatchObject({
      bassButton: { column: 8, rowId: "bass", root: "C" },
      chordButton: { column: 8, rowId: "major", root: "C" },
    });
    expect(visibleStradellaBassColumns(cVoicing)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    expect(bVoicing.selectedLeftHandCandidate).toMatchObject({
      bassButton: { column: 13, rowId: "bass", root: "B" },
      chordButton: { column: 13, rowId: "major", root: "B" },
    });
    expect(visibleStradellaBassColumns(bVoicing)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("labels generated C right-hand options uniquely", () => {
    const voicings = generateAccordionVoicings("C", cMajor);
    const ids = voicings.map((voicing) => voicing.id);
    const labels = voicings.map((voicing) => voicing.label);

    expect(voicings.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(expect.arrayContaining(["C root", "C first inversion", "C second inversion"]));
    expect(labels.some((label) => label.includes("right hand"))).toBe(false);
  });

  it("centers static dictionary voicings around non-C chord roots", () => {
    const voicing = requireAccordionVoicing("F#", null);

    expect(voicing.regionRoot).toEqual({ pitchClass: 6, note: "F#" });
    expect(voicing.rightHandNotes.map((note) => `${note.degree}:${note.note}`)).toEqual([
      "1:F#4",
      "3:A#4",
      "5:C#5",
    ]);
    expect(voicing.visibleStradellaButtons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowId: "bass", root: "F#" }),
        expect.objectContaining({ rowId: "major", root: "F#" }),
      ]),
    );
  });

  it("keeps B root right-hand notes ordered from lower to higher pitches", () => {
    const voicing = requireAccordionVoicing("B", null);

    expect(voicing.label).toBe("B root");
    expect(voicing.rightHandNotes.map((note) => `${note.degree}:${note.note}`)).toEqual([
      "1:B4",
      "3:D#5",
      "5:F#5",
    ]);
  });

  it("labels B inversions by lowest played pitch semantics", () => {
    const voicings = generateAccordionVoicings("B", null);
    const notesByLabel = new Map(
      voicings.map((voicing) => [
        voicing.label,
        voicing.rightHandNotes.map((note) => `${note.degree}:${note.note}`),
      ]),
    );

    expect(notesByLabel.get("B root")).toEqual(["1:B4", "3:D#5", "5:F#5"]);
    expect(notesByLabel.get("B first inversion")).toEqual(["3:D#5", "5:F#5", "1:B5"]);
    expect(notesByLabel.get("B second inversion")).toEqual(["5:F#5", "1:B5", "3:D#6"]);
  });

  it("ranks right-hand inversions around C key root for C G Am F", () => {
    expect(requireAccordionVoicing("C", cMajor).rightHandNotes.map((note) => note.note)).toEqual(["C4", "E4", "G4"]);
    expect(requireAccordionVoicing("G", cMajor).rightHandNotes.map((note) => note.note)).toEqual(["G3", "B3", "D4"]);
    expect(requireAccordionVoicing("Am", cMajor).rightHandNotes.map((note) => note.note)).toEqual(["A3", "C4", "E4"]);
    expect(requireAccordionVoicing("F", cMajor).rightHandNotes.map((note) => note.note)).toEqual(["A3", "C4", "F4"]);
  });

  it("ranks right-hand inversions around G key root for G D Em C", () => {
    expect(requireAccordionVoicing("G", gMajor).regionRoot).toEqual({ pitchClass: 7, note: "G" });
    expect(requireAccordionVoicing("G", gMajor).rightHandNotes.map((note) => note.note)).toEqual(["G3", "B3", "D4"]);
    expect(requireAccordionVoicing("D", gMajor).rightHandNotes.map((note) => note.note)).toEqual(["F#3", "A3", "D4"]);
    expect(requireAccordionVoicing("Em", gMajor).rightHandNotes.map((note) => note.note)).toEqual(["G3", "B3", "E4"]);
    expect(requireAccordionVoicing("C", gMajor).rightHandNotes.map((note) => note.note)).toEqual(["G3", "C4", "E4"]);
  });
});

describe("guitar chord voicings", () => {
  it("preserves externalized guitar catalog runtime parity", () => {
    expect(requireFirstVoicing("C").id).toBe("c-open");
    expect(requireVoicings("F").map((voicing) => voicing.id).slice(0, 2)).toEqual(["f-e-barre", "f-partial"]);
    expect(requireFirstVoicing("F#").id).toBe("fsharp-e-shape-barre");
    expect(
      requireFirstVoicing("F#", {
        sourceKey: { pitchClass: 6, mode: "major" },
        capoFret: 2,
        useCapoShapes: true,
        canCapo: true,
      }).id,
    ).toBe("e-open-capo-2");
  });

  it("keeps common shapes ordered before generated alternatives", () => {
    const voicings = requireVoicings("C");
    const firstGeneratedIndex = voicings.findIndex((voicing) => voicing.source === "generated");
    let lastCommonIndex = -1;
    for (let index = voicings.length - 1; index >= 0; index -= 1) {
      if (voicings[index]?.source === "common") {
        lastCommonIndex = index;
        break;
      }
    }

    expect(voicings[0]?.source).toBe("common");
    expect(firstGeneratedIndex).toBeGreaterThan(0);
    expect(lastCommonIndex).toBeGreaterThanOrEqual(0);
    expect(lastCommonIndex).toBeLessThan(firstGeneratedIndex);
  });

  it("prioritizes common CAGED open and barre shape families", () => {
    for (const [label, shapeFamily] of [
      ["C", "C"],
      ["A", "A"],
      ["G", "G"],
      ["E", "E"],
      ["D", "D"],
    ] as const) {
      expect(requireFirstVoicing(label)).toMatchObject({
        source: "common",
        shapeFamily,
      });
    }

    for (const [label, shapeFamily] of [
      ["F", "E"],
      ["Bb", "A"],
    ] as const) {
      const voicing = requireFirstVoicing(label);
      expect(voicing).toMatchObject({
        source: "common",
        shapeFamily,
      });
      expect(fretSpan(voicing)).toBeLessThanOrEqual(4);
      expect(voicing.notes.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("generates playable voicings for supported V1 chord qualities", () => {
    for (const label of ["C", "Am", "G7", "Cmaj7", "Am7", "Bdim", "Dsus2", "Dsus4"] as const) {
      const voicing = requireFirstVoicing(label);
      expectVoicingCoversChord(label, voicing);
      expect(voicing.notes.length).toBeGreaterThanOrEqual(3);
      expect(voicing.mutedStrings.length).toBeLessThanOrEqual(3);
    }
  });

  it("prefers root-bass generated voicings for non-slash diminished chords when possible", () => {
    for (const label of ["Bdim", "Cdim7"] as const) {
      const chord = requireChord(label);
      const voicing = requireFirstVoicing(label);

      expect(voicing.source).toBe("generated");
      expectVoicingCoversChord(label, voicing);
      expect(requireLowestNote(voicing).pitch.pitchClass).toBe(chord.rootPitchClass);
    }
  });

  it("keeps slash chord bass as the lowest sounding note across common and generated shapes", () => {
    for (const label of ["G/D", "C/E", "D/F#", "Am/G"] as const) {
      const voicing = requireFirstVoicing(label);
      expectVoicingCoversChord(label, voicing);
      expectLowestBass(label, voicing);
    }
  });

  it("keeps capo display shape separate from sounding slash chord notes", () => {
    const context: Partial<ChordDisplayContext> = {
      sourceKey: { pitchClass: 6, mode: "major" },
      capoFret: 2,
      useCapoShapes: true,
      canCapo: true,
    };
    const shapeChord = getCapoShapeChord("F#/A#", context);
    expect(shapeChord ? formatParsedChordLabel(shapeChord, { mode: "sharps" }) : null).toBe("E/G#");

    const voicing = requireFirstVoicing("F#/A#", context);
    expect(voicing).toMatchObject({
      chordLabel: "F#/A#",
      shapeChordLabel: "E/G#",
      capoFret: 2,
    });
    expect(voicing.shapeChordLabel).not.toBe(voicing.chordLabel);
    expectVoicingCoversChord("F#/A#", voicing);
    expectLowestBass("F#/A#", voicing);

    const soundingPitchClasses = new Set(requireChord("F#/A#").tones.map((tone) => tone.pitchClass));
    const shapeOnlyPitchClasses = requireChord("E/G#").tones
      .map((tone) => tone.pitchClass)
      .filter((pitchClass) => !soundingPitchClasses.has(pitchClass));
    expect(voicing.notes.some((note) => shapeOnlyPitchClasses.includes(note.pitch.pitchClass))).toBe(false);
  });

  it("keeps common voicing ids aligned with effective capo state", () => {
    const activeCapoContext: Partial<ChordDisplayContext> = {
      sourceKey: { pitchClass: 6, mode: "major" },
      capoFret: 2,
      useCapoShapes: true,
      canCapo: true,
    };
    const capoDisabledVoicing = requireFirstVoicing("F#", {
      ...activeCapoContext,
      useCapoShapes: false,
    });
    const cannotCapoVoicing = requireFirstVoicing("F#", {
      ...activeCapoContext,
      canCapo: false,
    });
    const activeCapoVoicing = requireFirstVoicing("F#", activeCapoContext);

    expect(capoDisabledVoicing).toMatchObject({
      id: "fsharp-e-shape-barre",
      capoFret: 0,
    });
    expect(cannotCapoVoicing).toMatchObject({
      id: "fsharp-e-shape-barre",
      capoFret: 0,
    });
    expect(activeCapoVoicing).toMatchObject({
      id: "e-open-capo-2",
      capoFret: 2,
    });
  });

  it("keeps generated fallback voicings playable for uncommon slash chords", () => {
    const voicing = requireGeneratedVoicing("C#sus2/G#");
    expectVoicingCoversChord("C#sus2/G#", voicing);
    expectLowestBass("C#sus2/G#", voicing);
    expect(fretSpan(voicing)).toBeLessThanOrEqual(4);
    expect(voicing.mutedStrings.length).toBeLessThanOrEqual(2);
  });

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
