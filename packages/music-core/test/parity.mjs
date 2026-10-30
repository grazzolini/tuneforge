import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Named musical examples and constraints, never generated from implementation output.
export function verifyPolicyParity(binary = fileURLToPath(new URL("../build/music_core_policy_contract", import.meta.url))) {
  const cases = [];
  const add = (id, request, check) => cases.push({ id, request, check });
  for (const [input, expected] of [["CM7", "maj7"], ["C7M", "maj7"], ["Cm7", "m7"], ["C:maj", "major"], ["C:min", "minor"], ["C:min7", "m7"], ["C:maj6", "maj6"], ["C:min6", "min6"], ["C:minmaj7", "minmaj7"]]) {
    for (const operation of ["parseChordLabel", "backendParseChord", "nativeParseChord"])
      add(`${operation} ${input}`, { operation, input }, value => {
        assert.equal(value.quality, expected);
        if (operation === "backendParseChord") assert.equal(value.raw_label, input);
      });
  }
  add("formal diminished seventh", { operation: "spell", input: "Bdim7" }, value => {
    assert.deepEqual(value.notes, ["B", "D", "F", "Ab"]);
    assert.deepEqual(value.tones.map(t => t.degree), ["1", "b3", "b5", "bb7"]);
    assert.deepEqual(value.tones.map(t => t.interval), [0, 3, 6, 9]);
  });
  for (const [input, midi] of [["B#3", 60], ["Cb4", 59], ["C4", 60], ["A0", 21]])
    add(`written octave ${input}`, { operation: "parsePitch", input }, value => {
      assert.equal(value.midi, midi);
      add(`parsed pitch composition ${input}`, { operation: "pitchToMidi", input: value }, result => assert.equal(result, midi));
      add(`written pitch roundtrip ${input}`, { operation: "formatPitch", input: value }, result => assert.equal(result, input));
      add(`respelling uses sounding octave ${input}`, { operation: "formatPitch", input: value, options: { mode: "sharps" } }, result => assert.equal(result, midi === 60 ? "C4" : midi === 59 ? "B3" : "A0"));
    });
  for (const operation of ["guitar", "piano", "accordion"]) {
    add(`${operation} formal diminished instrument labels`, { operation, input: "Bdim7" }, value => {
      assert.ok(value.length > 0);
      for (const voicing of value) {
        const notes = operation === "accordion" ? voicing.rightHandNotes : voicing.notes;
        const seventh = notes.filter(note => note.degree === "bb7");
        assert.ok(seventh.length > 0);
        assert.ok(seventh.every(note => note.pitch.noteName === "Ab" && /^Ab[0-9]+$/.test(note.note)));
        if (operation === "accordion") assert.ok(notes.every(note => note.finger === undefined));
        for (const note of notes)
          add(`${operation} named pitch composition ${note.note}`, { operation: "pitchToMidi", input: note.pitch }, result => assert.equal(result, note.pitch.midi));
      }
    });
    add(`${operation} written C-flat octave`, { operation, input: "Cb" }, value => {
      assert.ok(value.length > 0);
      const notes = operation === "accordion" ? value[0].rightHandNotes : value[0].notes;
      const root = notes.find(note => note.degree === "1");
      assert.equal(root.pitch.noteName, "Cb");
      assert.equal((root.pitch.octave + 1) * 12 - 1, root.pitch.midi);
    });
  }
  for (const input of ["X", "N.C.", "garbage", "C:unrecognized", "Cmaj9"])
    add(`invalid chord ${input}`, { operation: "parseChordLabel", input }, value => assert.equal(value, null));
  for (const input of ["N", "NC", "N.C.", "no_chord"])
    add(`no chord ${input}`, { operation: "backendParseChord", input }, value => assert.equal(value.display_label, "N.C."));
  add("segment keeps provenance and time", { operation: "backendChordSegment", input: "C:min6/b3", start_seconds: 1.25, end_seconds: 3.75, confidence: 0.83 }, value => {
    assert.equal(value.raw_label, "C:min6/b3"); assert.equal(value.quality, "min6");
    assert.equal(value.start_seconds, 1.25); assert.equal(value.end_seconds, 3.75); assert.equal(value.confidence, 0.83);
  });
  for (const [semitones, root, bass] of [[0, 0, 4], [2, 2, 6], [-1, 11, 3]])
    add(`transpose preserves slash ${semitones}`, { operation: "transposeChord", input: "C7/E", semitones }, value => { assert.equal(value.rootPitchClass, root); assert.equal(value.bassPitchClass, bass); });
  for (const operation of ["backendDocumentContext", "nativeDocumentContext"]) {
    add(`${operation} source correction and transpose`, { operation, detected_key: "C major", override_key: "D major", audio_set: { type: "preview_mix", metadata: { transpose: { semitones: 3 } } }, display_mode: "auto" }, value => {
      assert.equal(value.transpose_semitones, 5); assert.equal(value.active_key.pitch_class, 5);
    });
    add(`${operation} retune-only`, { operation, detected_key: "C major", override_key: null, audio_set: { type: "preview_mix", metadata: { retune: { cents: 25 } } }, display_mode: "auto" }, value => assert.equal(value.transpose_semitones, 0));
  }
  for (const [quality, expected] of [[null, "X"], ["no_chord", "N.C."]])
    add(`formatter sentinel ${quality}`, { operation: "backendFormatChord", root: null, quality, bass: null }, value => assert.equal(value, expected));
  add("formatter unknown quality", { operation: "backendFormatChord", root: 0, quality: null, bass: null }, value => assert.equal(value, "X"));
  const segment = { label: "C:min6", raw_label: "C:min6", quality: "min6", pitch_class: 0, start_seconds: 1, end_seconds: 2, confidence: 0.9 };
  add("display preserves saved segment metadata", { operation: "backendDisplayChordSegment", segment, context: { transpose_semitones: 2, active_key: { pitch_class: 2, mode: "major" }, display_mode: "auto" } }, value => {
    assert.equal(value.label, "Dm6"); assert.equal(value.raw_label, segment.raw_label); assert.equal(value.start_seconds, 1); assert.equal(value.confidence, 0.9);
  });
  for (const operation of ["piano", "accordion"]) {
    for (const [input, context, expectedCenter] of [["D", { activeKey: { pitchClass: 0, mode: "major" } }, 60], ["D", null, 62], ["D", { activeKey: { pitchClass: 0, mode: "major" }, preferredTrebleRegion: { centerMidi: 72 } }, 72]])
      add(`${operation} nearby ${JSON.stringify(context)}`, { operation, input, context }, value => {
        assert.ok(value.length > 0);
        for (const voicing of value) {
          const notes = operation === "piano" ? voicing.notes : voicing.rightHandNotes;
          assert.equal(voicing.regionRoot.centerMidi, expectedCenter);
          assert.deepEqual([...new Set(notes.map(n => n.pitch.pitchClass))].sort((a,b) => a-b), [2,6,9]);
          assert.ok(notes.every(n => n.pitch.midi >= (operation === "piano" ? 21 : 53) && n.pitch.midi <= (operation === "piano" ? 108 : 93)));
          assert.ok(notes.at(-1).pitch.midi - notes[0].pitch.midi < 12);
          assert.equal(notes[0].degree, ["1", "3", "5"][voicing.inversion.index]);
        }
      });
    add(`${operation} region does not change spelling`, { operation, input: "Db7", context: { activeKey: { pitchClass: 1, mode: "major" }, preferredTrebleRegion: { centerMidi: 72 } }, options: { mode: "flats" } }, value => {
      assert.equal(value[0].chordLabel, "Db7");
      const notes = operation === "piano" ? value[0].notes : value[0].rightHandNotes;
      assert.ok(notes.some(n => n.pitch.noteName === "Db"));
    });
  }
  for (const input of ["C7", "Cdim", "Cdim7", "Gmaj7", "C7/E", "C7/Bb", "Caug"]) {
    add(`Stradella ${input}`, { operation: "accordion", input }, value => {
      const left = value[0].leftHandCandidates;
      assert.ok(left.length > 0);
      const requestedBass = input === "C7/E" ? 4 : input === "C7/Bb" ? 10 : input === "Gmaj7" ? 7 : 0;
      assert.ok(left.every(c => c.bassButton.pitchClass === requestedBass && c.requestedBassMatches));
      const bassOnly = left.find(c => c.chordButton === null);
      assert.ok(bassOnly); assert.equal(bassOnly.kind, "approx"); assert.equal(bassOnly.coverageComplete, false);
      assert.equal(value[0].combinedCoverage.complete, true);
      if (["C7", "Cdim7", "C7/E", "C7/Bb"].includes(input)) assert.equal(left[0].kind, "standard");
      if (input === "C7") { assert.equal(left[0].chordButton.rowId, "seventh"); assert.equal(left[0].chordButton.pitchClass, 0); }
      if (input === "Cdim") assert.equal(left[0].kind, "complete");
      if (input === "Gmaj7") { assert.equal(left[0].kind, "complete"); assert.equal(left[0].chordButton.rowId, "minor"); assert.equal(left[0].chordButton.pitchClass, 11); }
      if (input === "Caug") assert.ok(left.every(c => c.chordButton === null));
      for (const c of left) {
        const sounding = [...new Set([c.bassButton.pitchClass, ...(c.chordButton?.pitchClasses ?? [])])].sort((a,b) => a-b);
        assert.deepEqual(c.soundingPitchClasses, sounding);
      }
    });
  }
  for (const [input, context, pcs] of [["C7", {}, [0,4,7,10]], ["C7/E", {}, [0,4,7,10]], ["D", { capoFret: 2, useCapoShapes: true, canCapo: true }, [2,6,9]]])
    add(`Gingo guitar ${input} ${JSON.stringify(context)}`, { operation: "guitar", input, context }, value => {
      assert.ok(value.length > 0 && value.length <= 8);
      assert.equal(new Set(value.map(v => v.id)).size, value.length);
      for (const v of value) {
        assert.equal(v.source, "generated"); assert.equal(v.shapeFamily, undefined);
        assert.deepEqual([...new Set(v.notes.map(n => n.pitch.pitchClass))].sort((a,b)=>a-b), pcs);
        assert.ok(v.id.includes("-capo-"));
        if (input === "C7/E") assert.equal(v.notes.reduce((a,b)=>a.pitch.midi < b.pitch.midi ? a : b).pitch.pitchClass, 4);
      }
      if (input === "C7") {
        const contacts = v => v.notes.filter(n => n.fret > 0).length;
        assert.ok(contacts(value[0]) < contacts(value.at(-1)), "easier contacts precede the known awkward alternative; no hard four-contact rule");
      }
    });
  // Decoder class labels are independent model metadata, retained verbatim from its pinned source.
  const oracle = JSON.parse(readFileSync(new URL("fixtures/crema-labels-v1.json", import.meta.url), "utf8"));
  assert.equal(oracle.labels.length, 170);
  const aliases = { maj: "major", min: "minor", min7: "m7" };
  const intervals = { maj:[0,4,7], min:[0,3,7], maj6:[0,4,7,9], min6:[0,3,7,9], minmaj7:[0,3,7,11], maj7:[0,4,7,11], min7:[0,3,7,10], "7":[0,4,7,10], dim:[0,3,6], dim7:[0,3,6,9], hdim7:[0,3,6,10], aug:[0,4,8], sus2:[0,2,7], sus4:[0,5,7] };
  for (const label of oracle.labels) {
    add(`independent Crema ${label}`, { operation: "nativeParseCrema", input: label }, value => {
      if (label === "N" || label === "X") { assert.equal(value.kind, label === "N" ? "no_chord" : "unknown"); return; }
      const [root, quality] = label.split(":");
      assert.equal(value.kind, "chord"); assert.equal(value.quality, aliases[quality] ?? quality);
      assert.equal(value.root_pitch_class, ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"].indexOf(root));
    });
  }
  for (const [input, expected] of Object.entries(intervals))
    add(`independent factors ${input}`, { operation: "nativeQualityIntervals", input }, value => assert.deepEqual(value, expected));
  let count = 0;
  for (let offset = 0; offset < cases.length; offset += 16) {
    const batch = cases.slice(offset, offset + 16);
    const result = spawnSync(Array.isArray(binary) ? binary[0] : binary, Array.isArray(binary) ? binary.slice(1) : [], {
      input: batch.map(c => JSON.stringify(c.request)).join("\n") + "\n", encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, batch.length);
    batch.forEach((c, i) => { try { c.check(rows[i]); count++; } catch(error) { throw new Error(c.id + ": " + error.message, { cause:error }); } });
  }
  return { namedExamplesAndConstraints: count, independentCremaLabels: oracle.labels.length };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyPolicyParity(), null, 2));
