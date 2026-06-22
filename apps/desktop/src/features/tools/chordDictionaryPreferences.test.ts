import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY,
  clearGlobalChordDictionaryPreferredShape,
  clearProjectChordDictionaryPreferredShape,
  hasGlobalChordDictionaryPreferredShape,
  hasProjectChordDictionaryPreferredShape,
  readGlobalChordDictionaryPreferredShapeId,
  readProjectChordDictionaryPreferredShapeId,
  resetGlobalChordDictionaryPreferredShape,
  resetProjectChordDictionaryPreferredShape,
  resolveChordDictionaryPreferredShapeId,
  writeGlobalChordDictionaryPreferredShape,
  writeProjectChordDictionaryPreferredShape,
  type ChordDictionaryPreferenceContext,
} from "./chordDictionaryPreferences";

const SHAPE_IDS = ["c-open", "c-g-shape", "c-a-shape"] as const;
const D_SHAPE_IDS = ["d-open", "d-a-shape-barre"] as const;
const E_SHAPE_IDS = ["e-open", "e-a-shape-barre", "e-d-shape-barre"] as const;
const ACCORDION_RIGHT_HAND_SHAPE_IDS = [
  "accordion-c-right-close",
  "accordion-c-right-first-inversion",
  "accordion-c-right-spread",
] as const;

function makeContext(
  overrides: Partial<ChordDictionaryPreferenceContext> = {},
): ChordDictionaryPreferenceContext {
  return {
    capoFret: 0,
    chordLabel: "C",
    displayedKeyLabel: null,
    instrumentId: "guitar",
    projectId: null,
    sourceKeyLabel: null,
    transposeSemitones: 0,
    useCapoShapes: false,
    ...overrides,
  };
}

describe("chord dictionary preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves and restores a global non-default C shape preference", () => {
    const context = makeContext({
      capoFret: 0.9,
      chordLabel: " C ",
      sourceKeyLabel: " ",
      transposeSemitones: 0.4,
    });

    expect(resolveChordDictionaryPreferredShapeId(makeContext(), SHAPE_IDS)).toBe("c-open");

    writeGlobalChordDictionaryPreferredShape(context, "c-g-shape");

    expect(resolveChordDictionaryPreferredShapeId(makeContext(), SHAPE_IDS)).toBe("c-g-shape");
    expect(window.localStorage.getItem(CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY)).toContain(
      "c-g-shape",
    );
    expect(window.localStorage.getItem("tuneforge.ui-preferences")).toBeNull();
    expect(window.localStorage.getItem("tuneforge.project-playback-state")).toBeNull();
  });

  it("uses the same global key for dictionary and Live Follow contexts", () => {
    const dictionaryContext = makeContext({
      chordLabel: "C",
      displayedKeyLabel: null,
      sourceKeyLabel: null,
      transposeSemitones: 0,
    });
    const liveFollowContext = makeContext({
      chordLabel: "C",
      displayedKeyLabel: "C",
      sourceKeyLabel: "G",
      transposeSemitones: 5,
    });

    writeGlobalChordDictionaryPreferredShape(dictionaryContext, "c-g-shape");

    expect(resolveChordDictionaryPreferredShapeId(liveFollowContext, SHAPE_IDS)).toBe(
      "c-g-shape",
    );
    expect(readGlobalChordDictionaryPreferredShapeId(liveFollowContext)).toBe("c-g-shape");
  });

  it("uses displayed chord labels so transposed D does not reuse a C preference", () => {
    writeGlobalChordDictionaryPreferredShape(makeContext({ chordLabel: "C" }), "c-g-shape");

    const displayedDContext = makeContext({
      chordLabel: "D",
      displayedKeyLabel: "D",
      sourceKeyLabel: "C",
      transposeSemitones: 2,
    });

    expect(resolveChordDictionaryPreferredShapeId(displayedDContext, D_SHAPE_IDS)).toBe("d-open");

    writeGlobalChordDictionaryPreferredShape(displayedDContext, "d-a-shape-barre");

    expect(resolveChordDictionaryPreferredShapeId(displayedDContext, D_SHAPE_IDS)).toBe(
      "d-a-shape-barre",
    );
  });

  it("lets a project override win over the global preference", () => {
    const context = makeContext();
    const projectContext = makeContext({ projectId: "project-1" });

    writeGlobalChordDictionaryPreferredShape(context, "c-g-shape");
    writeProjectChordDictionaryPreferredShape(projectContext, "c-a-shape");

    expect(resolveChordDictionaryPreferredShapeId(projectContext, SHAPE_IDS)).toBe("c-a-shape");
  });

  it("scopes accordion right-hand preferences under the accordion instrument", () => {
    const accordionContext = makeContext({ instrumentId: "accordion" });
    const accordionProjectContext = makeContext({
      instrumentId: "accordion",
      projectId: "project-accordion",
    });
    const guitarContext = makeContext();

    writeGlobalChordDictionaryPreferredShape(
      accordionContext,
      "accordion-c-right-first-inversion",
    );
    writeProjectChordDictionaryPreferredShape(
      accordionProjectContext,
      "accordion-c-right-spread",
    );

    expect(
      resolveChordDictionaryPreferredShapeId(
        accordionContext,
        ACCORDION_RIGHT_HAND_SHAPE_IDS,
      ),
    ).toBe("accordion-c-right-first-inversion");
    expect(
      resolveChordDictionaryPreferredShapeId(
        accordionProjectContext,
        ACCORDION_RIGHT_HAND_SHAPE_IDS,
      ),
    ).toBe("accordion-c-right-spread");
    expect(resolveChordDictionaryPreferredShapeId(guitarContext, SHAPE_IDS)).toBe("c-open");

    writeGlobalChordDictionaryPreferredShape(guitarContext, "c-g-shape");

    expect(resolveChordDictionaryPreferredShapeId(guitarContext, SHAPE_IDS)).toBe("c-g-shape");
    expect(
      resolveChordDictionaryPreferredShapeId(
        accordionContext,
        ACCORDION_RIGHT_HAND_SHAPE_IDS,
      ),
    ).toBe("accordion-c-right-first-inversion");

    const storedPreferences = JSON.parse(
      window.localStorage.getItem(CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as {
      globalPreferredShapeIds?: Record<string, string>;
      projectPreferredShapeIds?: Record<string, Record<string, string>>;
    };

    expect(storedPreferences.globalPreferredShapeIds?.[JSON.stringify(["accordion", "C"])]).toBe(
      "accordion-c-right-first-inversion",
    );
    expect(storedPreferences.globalPreferredShapeIds?.[JSON.stringify(["guitar", "C"])]).toBe(
      "c-g-shape",
    );
    expect(
      storedPreferences.projectPreferredShapeIds?.["project-accordion"]?.[
        JSON.stringify(["accordion", "C"])
      ],
    ).toBe("accordion-c-right-spread");
  });

  it("falls through project, global, and generated defaults for one displayed chord", () => {
    const globalContext = makeContext({ chordLabel: "E" });
    const projectContext = makeContext({ chordLabel: "E", projectId: "project-1" });

    writeGlobalChordDictionaryPreferredShape(globalContext, "e-a-shape-barre");
    writeProjectChordDictionaryPreferredShape(projectContext, "e-d-shape-barre");

    expect(resolveChordDictionaryPreferredShapeId(projectContext, E_SHAPE_IDS)).toBe(
      "e-d-shape-barre",
    );

    clearProjectChordDictionaryPreferredShape(projectContext);
    expect(resolveChordDictionaryPreferredShapeId(projectContext, E_SHAPE_IDS)).toBe(
      "e-a-shape-barre",
    );

    clearGlobalChordDictionaryPreferredShape(globalContext);
    expect(resolveChordDictionaryPreferredShapeId(projectContext, E_SHAPE_IDS)).toBe("e-open");
  });

  it("reports saved global and project shape preferences by scope", () => {
    const context = makeContext();
    const projectContext = makeContext({ projectId: "project-1" });

    expect(readGlobalChordDictionaryPreferredShapeId(context)).toBeNull();
    expect(readProjectChordDictionaryPreferredShapeId(projectContext)).toBeNull();
    expect(hasGlobalChordDictionaryPreferredShape(context, SHAPE_IDS)).toBe(false);
    expect(hasProjectChordDictionaryPreferredShape(projectContext, SHAPE_IDS)).toBe(false);

    writeGlobalChordDictionaryPreferredShape(context, "c-g-shape");
    writeProjectChordDictionaryPreferredShape(projectContext, "c-a-shape");

    expect(readGlobalChordDictionaryPreferredShapeId(context)).toBe("c-g-shape");
    expect(readProjectChordDictionaryPreferredShapeId(projectContext)).toBe("c-a-shape");
    expect(hasGlobalChordDictionaryPreferredShape(context, SHAPE_IDS)).toBe(true);
    expect(hasProjectChordDictionaryPreferredShape(projectContext, SHAPE_IDS)).toBe(true);
    expect(hasGlobalChordDictionaryPreferredShape(context, ["c-open"])).toBe(false);
    expect(hasProjectChordDictionaryPreferredShape(projectContext, ["c-open"])).toBe(false);

    clearGlobalChordDictionaryPreferredShape(context);
    clearProjectChordDictionaryPreferredShape(projectContext);

    expect(hasGlobalChordDictionaryPreferredShape(context, SHAPE_IDS)).toBe(false);
    expect(hasProjectChordDictionaryPreferredShape(projectContext, SHAPE_IDS)).toBe(false);
  });

  it("falls back to global preference when a project has no pick", () => {
    writeGlobalChordDictionaryPreferredShape(makeContext(), "c-g-shape");

    expect(
      resolveChordDictionaryPreferredShapeId(makeContext({ projectId: "project-2" }), SHAPE_IDS),
    ).toBe("c-g-shape");
  });

  it("falls back to generated default or null when saved shapes are unavailable", () => {
    const context = makeContext({ projectId: "project-1" });

    writeGlobalChordDictionaryPreferredShape(context, "c-a-shape");
    writeProjectChordDictionaryPreferredShape(context, "c-a-shape");

    expect(resolveChordDictionaryPreferredShapeId(context, ["c-open", "c-g-shape"])).toBe(
      "c-open",
    );
    expect(resolveChordDictionaryPreferredShapeId(context, [])).toBeNull();
  });

  it("clears and resets global preferences", () => {
    const context = makeContext();

    writeGlobalChordDictionaryPreferredShape(context, "c-g-shape");
    clearGlobalChordDictionaryPreferredShape(context);
    expect(resolveChordDictionaryPreferredShapeId(context, SHAPE_IDS)).toBe("c-open");

    writeGlobalChordDictionaryPreferredShape(context, "c-a-shape");
    resetGlobalChordDictionaryPreferredShape(context);
    expect(resolveChordDictionaryPreferredShapeId(context, SHAPE_IDS)).toBe("c-open");
  });

  it("clears and resets project preferences", () => {
    const context = makeContext();
    const projectContext = makeContext({ projectId: "project-1" });

    writeGlobalChordDictionaryPreferredShape(context, "c-g-shape");
    writeProjectChordDictionaryPreferredShape(projectContext, "c-a-shape");
    clearProjectChordDictionaryPreferredShape(projectContext);
    expect(resolveChordDictionaryPreferredShapeId(projectContext, SHAPE_IDS)).toBe("c-g-shape");

    writeProjectChordDictionaryPreferredShape(projectContext, "c-a-shape");
    resetProjectChordDictionaryPreferredShape(projectContext);
    expect(resolveChordDictionaryPreferredShapeId(projectContext, SHAPE_IDS)).toBe("c-g-shape");
  });

  it("falls back silently for invalid JSON and malformed storage records", () => {
    const context = makeContext();

    window.localStorage.setItem(CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY, "{not json");
    expect(resolveChordDictionaryPreferredShapeId(context, SHAPE_IDS)).toBe("c-open");

    window.localStorage.setItem(
      CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        globalPreferredShapeIds: {
          stale: 42,
        },
        projectPreferredShapeIds: {
          "project-1": {
            stale: null,
          },
          "project-2": "not-a-map",
        },
        version: 2,
      }),
    );
    expect(resolveChordDictionaryPreferredShapeId(context, SHAPE_IDS)).toBe("c-open");
  });

  it("falls back and does not throw without window or localStorage", () => {
    const originalWindow = window;
    vi.stubGlobal("window", undefined);

    try {
      expect(resolveChordDictionaryPreferredShapeId(makeContext(), SHAPE_IDS)).toBe("c-open");
      expect(() =>
        writeGlobalChordDictionaryPreferredShape(makeContext(), "c-g-shape"),
      ).not.toThrow();
      expect(() =>
        writeProjectChordDictionaryPreferredShape(
          makeContext({ projectId: "project-1" }),
          "c-a-shape",
        ),
      ).not.toThrow();
      expect(() => clearGlobalChordDictionaryPreferredShape(makeContext())).not.toThrow();
      expect(() =>
        clearProjectChordDictionaryPreferredShape(makeContext({ projectId: "project-1" })),
      ).not.toThrow();
    } finally {
      vi.stubGlobal("window", originalWindow);
    }
  });

  it("ignores empty chord labels and malformed shape ids", () => {
    const emptyChordContext = makeContext({ chordLabel: " " });

    writeGlobalChordDictionaryPreferredShape(emptyChordContext, "c-g-shape");
    writeProjectChordDictionaryPreferredShape(
      { ...emptyChordContext, projectId: "project-1" },
      "c-a-shape",
    );

    expect(resolveChordDictionaryPreferredShapeId(emptyChordContext, SHAPE_IDS)).toBe("c-open");
    expect(resolveChordDictionaryPreferredShapeId(makeContext(), ["", "c-open"])).toBe("c-open");
  });
});
