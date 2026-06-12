import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_KNOWLEDGE_BUNDLE_V1,
  normalizeInstrumentKnowledgeBundle,
  normalizeObservedGuitarGzipVoicingSeeds,
} from "./instrumentKnowledge";

describe("instrument knowledge bundle", () => {
  it("exposes first-party harmonic and guitar data in normalized form", () => {
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.schemaVersion).toBe(1);
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.harmonicDefinitions.hdim7?.tones).toContainEqual({
      degree: "b5",
      interval: 6,
    });
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.instrumentProfiles.guitar).toMatchObject({
      id: "guitar",
      label: "Guitar",
      executionLayer: "fretboard",
      fretboard: {
        frets: 22,
        stringOrder: [6, 5, 4, 3, 2, 1],
        canCapo: true,
        canRetune: true,
      },
    });
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.voicingSeeds.guitar?.common).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "c-open",
          chordLabel: "C",
          source: "first-party",
        }),
        expect.objectContaining({
          id: "esus4-open",
          chordLabel: "Esus4",
          source: "first-party",
        }),
      ]),
    );
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.voicingSeeds.guitar?.moveableDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "e-shape-barre",
          shapeFamily: "E",
          quality: "major",
        }),
      ]),
    );
  });

  it("returns safe empty structures for invalid bundles", () => {
    expect(normalizeInstrumentKnowledgeBundle(null)).toMatchObject({
      schemaVersion: 1,
      harmonicDefinitions: {},
      instrumentProfiles: {},
      voicingSeeds: {},
      importAdapters: {},
    });
    expect(
      normalizeInstrumentKnowledgeBundle({
        schemaVersion: 1,
        harmonicDefinitions: {
          major: {
            id: "major",
            label: "Major",
            suffix: "",
            tones: [{ degree: "bogus", interval: 0 }],
          },
        },
        instrumentProfiles: {
          guitar: {
            id: "guitar",
            label: "Guitar",
          },
        },
      }).harmonicDefinitions,
    ).toEqual({});
  });

  it("drops invalid profile, seed, and adapter chunks into safe empty structures", () => {
    const bundle = normalizeInstrumentKnowledgeBundle({
      schemaVersion: 1,
      bundleId: "fixture",
      version: "0.0.0",
      instrumentProfiles: {
        missingFamily: {
          id: "missing-family",
          label: "Missing family",
          executionLayer: "fretboard",
        },
        missingLabel: {
          id: "missing-label",
          family: "fretted-strings",
          executionLayer: "fretboard",
        },
      },
      voicingSeeds: {
        guitar: {
          common: [
            {
              id: "bad-seed",
              label: "Bad seed",
              chordLabel: "C",
              rank: 1,
              notes: [{ string: 0, fret: -1 }],
            },
          ],
          moveableDefinitions: [
            {
              id: "bad-moveable",
              label: "Bad moveable",
              shapeFamily: "not-caged",
              quality: "major",
              rank: 1,
              baseFrets: [0, 2, 2, 1, 0, 0],
              roots: [{ label: "F", offset: 0 }],
            },
          ],
        },
        piano: {
          executionLayer: "keyboard",
          seeds: [
            {
              id: "bad-keyboard-seed",
              label: "Bad keyboard seed",
              chordLabel: "C",
              rank: 1,
              positions: [{ hand: "right", finger: 1 }],
            },
          ],
        },
        accordion: {
          executionLayer: "button-board",
          seeds: [
            {
              id: "bad-button-seed",
              label: "Bad button seed",
              chordLabel: "C",
              rank: 1,
              positions: [{ side: "treble", row: 0, column: 1, button: "C" }],
            },
          ],
        },
      },
      importAdapters: {
        missingSchema: { description: "missing schema" },
        wrongSchema: { schemaVersion: 2, stringOrder: [6, 5, 4, 3, 2, 1] },
      },
    });

    expect(bundle.instrumentProfiles).toEqual({});
    expect(bundle.voicingSeeds).toEqual({});
    expect(bundle.importAdapters).toEqual({});
  });

  it("drops malformed moveable guitar definitions without compacting base frets", () => {
    const bundle = normalizeInstrumentKnowledgeBundle({
      schemaVersion: 1,
      bundleId: "fixture",
      version: "0.0.0",
      voicingSeeds: {
        guitar: {
          moveableDefinitions: [
            {
              id: "bad-middle-fret",
              label: "Bad middle fret",
              shapeFamily: "E",
              quality: "major",
              rank: 1,
              baseFrets: [0, 2, "bad", 1, 0, 0],
              roots: [{ label: "F", offset: 1 }],
            },
            {
              id: "good-muted-string",
              label: "Good muted string",
              shapeFamily: "A",
              quality: "major",
              rank: 2,
              baseFrets: [null, 0, 2, 2, 2, 0],
              roots: [{ label: "Bb", offset: 1 }],
            },
          ],
        },
      },
    });

    expect(bundle.voicingSeeds.guitar?.moveableDefinitions).toEqual([
      {
        id: "good-muted-string",
        instrumentId: "guitar",
        label: "Good muted string",
        shapeFamily: "A",
        quality: "major",
        baseFrets: [null, 0, 2, 2, 2, 0],
        rank: 2,
        roots: [{ label: "Bb", offset: 1 }],
      },
    ]);
  });

  it("rejects partial and invalid guitar string orders", () => {
    const bundle = normalizeInstrumentKnowledgeBundle({
      schemaVersion: 1,
      bundleId: "fixture",
      version: "0.0.0",
      instrumentProfiles: {
        partialOrder: {
          id: "partialOrder",
          label: "Partial order",
          family: "fretted-strings",
          executionLayer: "fretboard",
          fretboard: {
            frets: 22,
            stringOrder: [6, 5, 4],
            canCapo: true,
            canRetune: true,
          },
        },
        invalidOrder: {
          id: "invalidOrder",
          label: "Invalid order",
          family: "fretted-strings",
          executionLayer: "fretboard",
          fretboard: {
            frets: 22,
            stringOrder: [6, 5, 4, 3, 2, 9],
            canCapo: true,
            canRetune: true,
          },
        },
        duplicateOrder: {
          id: "duplicateOrder",
          label: "Duplicate order",
          family: "fretted-strings",
          executionLayer: "fretboard",
          fretboard: {
            frets: 22,
            stringOrder: [6, 5, 4, 3, 2, 2],
            canCapo: true,
            canRetune: true,
          },
        },
      },
      importAdapters: {
        partial: { schemaVersion: 1, stringOrder: [6, 5, 4] },
        invalid: { schemaVersion: 1, stringOrder: [6, 5, 4, 3, 2, 9] },
      },
    });

    expect(bundle.instrumentProfiles.partialOrder?.fretboard?.stringOrder).toEqual([]);
    expect(bundle.instrumentProfiles.invalidOrder?.fretboard?.stringOrder).toEqual([]);
    expect(bundle.instrumentProfiles.duplicateOrder?.fretboard?.stringOrder).toEqual([]);
    expect(bundle.importAdapters).toEqual({
      partial: { schemaVersion: 1 },
      invalid: { schemaVersion: 1 },
    });
  });

  it("normalizes future non-guitar instrument profile and seed shapes from synthetic fixtures", () => {
    const bundle = normalizeInstrumentKnowledgeBundle({
      schemaVersion: 1,
      bundleId: "fixture",
      version: "0.0.0",
      instrumentProfiles: {
        piano: {
          id: "piano",
          label: "Piano",
          family: "keyboard",
          executionLayer: "keyboard",
          keyboard: {
            keyCount: 88,
            lowestPitch: "A0",
            highestPitch: "C8",
            canTranspose: true,
          },
        },
        accordion: {
          id: "accordion",
          label: "Accordion",
          family: "free-reed",
          executionLayer: "button-board",
          buttonBoard: {
            layout: "chromatic",
            buttons: 120,
            rows: 5,
            columns: 24,
            canTranspose: false,
          },
        },
      },
      voicingSeeds: {
        piano: {
          executionLayer: "keyboard",
          seeds: [
            {
              id: "piano-c-triad",
              label: "Piano C triad",
              chordLabel: "C",
              rank: 10,
              tags: ["triad", "synthetic"],
              positions: [
                { pitch: "C4", note: "C", hand: "right", finger: 1 },
                { pitch: "E4", note: "E", hand: "right", finger: 3 },
                { pitch: "G4", note: "G", hand: "right", finger: 5 },
                { pitch: "", hand: "left", finger: 6 },
              ],
            },
            {
              id: "invalid-piano-seed",
              label: "Invalid piano seed",
              chordLabel: "C",
              rank: 11,
              positions: [{ note: "C" }],
            },
          ],
        },
        accordion: {
          executionLayer: "button-board",
          seeds: [
            {
              id: "accordion-c-triad",
              label: "Accordion C triad",
              chordLabel: "C",
              rank: 20,
              positions: [
                { side: "treble", row: 2, column: 4, button: "C", pitch: "C4", finger: 1 },
                { side: "treble", row: 2, column: 6, button: "E", note: "E", finger: 3 },
                { side: "treble", row: 2, column: 8, button: "G", note: "G", finger: 5 },
                { side: "treble", row: 0, column: 8, button: "bad" },
              ],
            },
          ],
        },
      },
    });

    expect(bundle.instrumentProfiles.piano).toMatchObject({
      id: "piano",
      executionLayer: "keyboard",
      keyboard: {
        keyCount: 88,
        lowestPitch: "A0",
        highestPitch: "C8",
        canTranspose: true,
      },
    });
    expect(bundle.instrumentProfiles.accordion).toMatchObject({
      id: "accordion",
      executionLayer: "button-board",
      buttonBoard: {
        layout: "chromatic",
        buttons: 120,
        rows: 5,
        columns: 24,
        canTranspose: false,
      },
    });
    expect(bundle.voicingSeeds.piano).toEqual({
      executionLayer: "keyboard",
      seeds: [
        {
          id: "piano-c-triad",
          instrumentId: "piano",
          label: "Piano C triad",
          chordLabel: "C",
          rank: 10,
          tags: ["triad", "synthetic"],
          executionLayer: "keyboard",
          positions: [
            { pitch: "C4", note: "C", hand: "right", finger: 1 },
            { pitch: "E4", note: "E", hand: "right", finger: 3 },
            { pitch: "G4", note: "G", hand: "right", finger: 5 },
          ],
        },
      ],
    });
    expect(bundle.voicingSeeds.accordion).toEqual({
      executionLayer: "button-board",
      seeds: [
        {
          id: "accordion-c-triad",
          instrumentId: "accordion",
          label: "Accordion C triad",
          chordLabel: "C",
          rank: 20,
          executionLayer: "button-board",
          positions: [
            { side: "treble", row: 2, column: 4, button: "C", pitch: "C4", finger: 1 },
            { side: "treble", row: 2, column: 6, button: "E", note: "E", finger: 3 },
            { side: "treble", row: 2, column: 8, button: "G", note: "G", finger: 5 },
          ],
        },
      ],
    });
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.instrumentProfiles.piano).toBeUndefined();
    expect(INSTRUMENT_KNOWLEDGE_BUNDLE_V1.voicingSeeds.piano).toBeUndefined();
  });
});

describe("observed guitar gzip adapter", () => {
  it("maps observed row-shaped fingerings to guitar voicing seeds", () => {
    expect(
      normalizeObservedGuitarGzipVoicingSeeds(
        {
          C: [
            {
              positions: ["x", "3", "2", "0", "1", "0"],
              fingerings: [["0", "3", "2", "0", "1", "0"]],
            },
          ],
          Bad: [{ positions: [0, 1, 2] }],
        },
        { sourceId: "fixture", rankStart: 50 },
      ),
    ).toEqual([
      {
        id: "fixture-c-1",
        instrumentId: "guitar",
        label: "C observed 1",
        chordLabel: "C",
        rank: 50,
        source: "observed-gzip",
        notes: [
          { string: 5, fret: 3, finger: 3 },
          { string: 4, fret: 2, finger: 2 },
          { string: 3, fret: 0 },
          { string: 2, fret: 1, finger: 1 },
          { string: 1, fret: 0 },
        ],
      },
    ]);
  });
});
