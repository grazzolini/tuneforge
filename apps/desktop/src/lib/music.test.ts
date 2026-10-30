import { describe, expect, it } from "vitest";
import {
  ACCORDION_STANDARD_PROFILE, PIANO_STANDARD_PROFILE, CHORD_QUALITY_DEFINITIONS,
  formatChordDisplay, formatKey, formatPitchClass, generateAccordionVoicings,
  generateGuitarVoicings, generatePianoVoicings, getCapoShapeChord,
  isSupportedChordQuality, parseChordLabel, parsePitch, pitchToMidi, formatPitch, spellChord, transposeChordLabel,
} from "./music";

describe("canonical music semantics", () => {
  it("keeps key spelling independent from the displayed register", () => {
    expect(formatKey({ pitchClass: 1, mode: "major" })).toBe("Db");
    expect(formatPitchClass(10, { activeKey: { pitchClass: 7, mode: "major" } })).toBe("A#");
    expect(formatChordDisplay(1, "m7", { mode: "dual" }).ariaLabel).toBe("C#m7 / Dbm7");
    const voicings = generatePianoVoicings("Db7", {
      activeKey: { pitchClass: 1, mode: "major" }, preferredTrebleRegion: { centerMidi: 72 },
    });
    expect(voicings[0]?.chordLabel).toBe("Db7");
    expect(voicings[0]?.regionRoot).toMatchObject({ centerMidi: 72 });
  });
  it.each([["B#3", 60], ["Cb4", 59], ["C4", 60]] as const)("respects the written octave of %s", (input, midi) => {
    const parsed = parsePitch(input)!;
    expect(parsed.midi).toBe(midi);
    expect(pitchToMidi(parsed)).toBe(midi);
    expect(formatPitch(parsed)).toBe(input);
  });
  it.each([["CM7", "maj7"], ["C7M", "maj7"], ["Cm7", "m7"], ["C:maj", "major"], ["C:min", "minor"], ["C:min7", "m7"], ["C:maj6", "maj6"], ["C:min6", "min6"], ["C:minmaj7", "minmaj7"]] as const)("normalizes %s without losing raw labels", (input, quality) => {
    expect(parseChordLabel(input)).toMatchObject({ quality });
  });
  it("spells the formal diminished seventh without changing its sounding interval", () => {
    expect(spellChord("Bdim7")?.notes).toEqual(["B", "D", "F", "Ab"]);
    expect(spellChord("Bdim7")?.tones[3]).toMatchObject({ degree: "bb7", interval: 9 });
  });
  it.each(["guitar", "piano", "accordion"] as const)("keeps formal diminished spelling on %s", instrument => {
    const voicings = instrument === "guitar" ? generateGuitarVoicings("Bdim7") : instrument === "piano" ? generatePianoVoicings("Bdim7") : generateAccordionVoicings("Bdim7");
    for (const voicing of voicings) {
      const notes = "rightHandNotes" in voicing ? voicing.rightHandNotes : voicing.notes;
      expect(notes.filter(note => note.degree === "bb7").every(note => note.pitch.noteName === "Ab")).toBe(true);
      if ("rightHandNotes" in voicing) expect(voicing.rightHandNotes.every(note => note.finger === undefined)).toBe(true);
    }
  });
  it("keeps the dictionary subset explicit", () => {
    expect(Object.keys(CHORD_QUALITY_DEFINITIONS)).toHaveLength(15);
    expect(Object.keys(CHORD_QUALITY_DEFINITIONS).filter(isSupportedChordQuality)).toHaveLength(12);
    expect(isSupportedChordQuality("maj6")).toBe(false);
    expect(spellChord("C:maj6")?.notes).toEqual(["C", "E", "G", "A"]);
  });
  it("transposes slash bass and capo shapes canonically", () => {
    expect(transposeChordLabel("C7/E", 2)).toBe("D7/F#");
    expect(transposeChordLabel("C:min6", 0)).toBe("Cm6");
    expect(getCapoShapeChord("D", { capoFret: 2, useCapoShapes: true, canCapo: true })).toMatchObject({ rootPitchClass: 0, quality: "major" });
  });
  it.each(["N.C.", "X", "Cadd9", "C:unsupported"])("rejects unsupported input %s", input => {
    expect(spellChord(input)).toBeNull();
    expect(generateGuitarVoicings(input)).toEqual([]);
  });
});

describe("instrument constraints", () => {
  it("retains the supported physical instruments", () => {
    expect(PIANO_STANDARD_PROFILE.keyboard).toMatchObject({ keyCount: 88, lowestPitch: { midi: 21 }, highestPitch: { midi: 108 } });
    expect(ACCORDION_STANDARD_PROFILE.keyboard).toMatchObject({ keyCount: 41, lowestPitch: { midi: 53 }, highestPitch: { midi: 93 } });
    expect(ACCORDION_STANDARD_PROFILE.buttonBoard.buttons).toBe(120);
  });
  it("delegates guitar playability order and uses position identities", () => {
    const voicings = generateGuitarVoicings("C7");
    expect(voicings.length).toBeGreaterThan(1);
    expect(new Set(voicings.map(v => v.id)).size).toBe(voicings.length);
    expect(voicings.every(v => !v.shapeFamily && v.source === "generated")).toBe(true);
    expect(voicings[0]?.notes.filter(n => n.fret > 0).length).toBeLessThan(voicings[voicings.length - 1]?.notes.filter(n => n.fret > 0).length ?? 0);
  });
  it("enforces the lowest guitar slash bass before truncating", () => {
    const voicings = generateGuitarVoicings("C7/E");
    expect(voicings.length).toBeGreaterThan(0);
    for (const v of voicings) expect([...v.notes].sort((a,b) => a.pitch.midi-b.pitch.midi)[0]?.pitch.pitchClass).toBe(4);
  });
  it("uses bounded close inversions near an explicit treble center", () => {
    for (const v of generatePianoVoicings("C", { preferredTrebleRegion: { centerMidi: 72 } })) {
      expect(v.notes[v.notes.length - 1]!.pitch.midi - v.notes[0]!.pitch.midi).toBeLessThan(12);
      expect(v.notes[0]?.degree).toBe(v.inversion.bassDegree);
    }
    expect(() => generateAccordionVoicings("C", { preferredTrebleRegion: { centerMidi: 20 } })).toThrow();
  });
  it("uses the song tonic before the current chord when choosing a region", () => {
    const context = { activeKey: { pitchClass: 0, mode: "major" as const }, currentChordRoot: "G" };
    expect(generateAccordionVoicings("G", context)[0]?.regionRoot).toMatchObject({ pitchClass: 0, centerMidi: 60 });
    expect(generateAccordionVoicings("G")[0]?.regionRoot).toMatchObject({ pitchClass: 7, centerMidi: 55 });
  });
  it.each(["C7", "Cdim7"])("treats conventional %s omissions as standard", input => {
    const selected = generateAccordionVoicings(input)[0]?.selectedLeftHandCandidate;
    expect(selected).toMatchObject({ kind: "standard", requestedBassMatches: true, bassButton: { pitchClass: 0 } });
    expect(selected?.label).not.toContain("no5");
  });
  it("distinguishes diminished triads from diminished sevenths", () => {
    expect(generateAccordionVoicings("Cdim")[0]?.selectedLeftHandCandidate).toMatchObject({ kind: "complete", chordButton: { pitchClass: 3 } });
    expect(generateAccordionVoicings("Cdim7")[0]?.selectedLeftHandCandidate).toMatchObject({ kind: "standard", chordButton: { pitchClass: 0 } });
  });
  it("constructs Gmaj7 from G bass and B minor", () => {
    expect(generateAccordionVoicings("Gmaj7")[0]?.selectedLeftHandCandidate).toMatchObject({ kind: "complete", bassButton: { pitchClass: 7 }, chordButton: { pitchClass: 11, rowId: "minor" }, missingTones: [], addedTones: [] });
  });
  it.each([["C7/E", 4], ["C7/Bb", 10]] as const)("keeps %s left bass independent of right inversion", (input, bass) => {
    const voicings = generateAccordionVoicings(input);
    expect(new Set(voicings.map(v => v.inversion.index)).size).toBeGreaterThan(1);
    for (const v of voicings) expect(v.leftHandCandidates.every(c => c.bassButton.pitchClass === bass)).toBe(true);
  });
  it("keeps bass-only coverage partial while treble completes the harmony", () => {
    const voicing = generateAccordionVoicings("Caug")[0]!;
    expect(voicing.selectedLeftHandCandidate).toMatchObject({ kind: "approx", chordButton: null, coverageComplete: false });
    expect(voicing.selectedLeftHandCandidate?.missingTones.length).toBeGreaterThan(0);
    expect(voicing.combinedCoverage).toMatchObject({ complete: true });
    expect(new Set(voicing.rightHandNotes.map(n => n.pitch.pitchClass))).toEqual(new Set([0,4,8]));
  });
});
