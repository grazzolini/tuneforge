import { describe, expect, it } from "vitest";
import type { ChordSegmentSchema, LyricsSegmentSchema } from "../../lib/api";
import { buildLeadSheetRows } from "./projectViewUtils";

function chord(startSeconds: number, endSeconds: number, label: string): ChordSegmentSchema {
  return {
    confidence: 0.9,
    end_seconds: endSeconds,
    label,
    pitch_class: null,
    quality: null,
    start_seconds: startSeconds,
  };
}

describe("buildLeadSheetRows", () => {
  it("anchors chords to active lyric words when word timestamps exist", () => {
    const lyrics: LyricsSegmentSchema[] = [
      {
        end_seconds: 8,
        start_seconds: 0,
        text: "Hello world",
        words: [
          { confidence: 0.9, end_seconds: 1, start_seconds: 0, text: "Hello" },
          { confidence: 0.9, end_seconds: 2, start_seconds: 1, text: "world" },
        ],
      },
    ];

    const rows = buildLeadSheetRows(lyrics, [chord(0.2, 1, "G"), chord(1.2, 2, "D")], {
      activeChordIndex: 1,
      activeLyricsIndex: 0,
      activeLyricsWordIndex: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activeWordIndex: 1,
      isActive: true,
      type: "lyrics",
    });
    if (rows[0]?.type !== "lyrics") {
      throw new Error("Expected lyrics row");
    }
    expect(rows[0].chords.map((leadSheetChord) => leadSheetChord.anchor)).toEqual([
      { type: "word", wordIndex: 0 },
      { type: "word", wordIndex: 1 },
    ]);
    expect(rows[0].chords[1]?.isActive).toBe(true);
  });

  it("falls back to proportional chord positions when words are unavailable", () => {
    const lyrics: LyricsSegmentSchema[] = [
      {
        end_seconds: 20,
        start_seconds: 10,
        text: "No word timestamps",
        words: [],
      },
    ];

    const rows = buildLeadSheetRows(lyrics, [chord(15, 16, "Am")], {
      activeChordIndex: 0,
      activeLyricsIndex: 0,
      activeLyricsWordIndex: -1,
    });

    if (rows[0]?.type !== "lyrics") {
      throw new Error("Expected lyrics row");
    }
    expect(rows[0].chords[0]?.anchor).toEqual({ type: "percent", percent: 50 });
  });

  it("preserves instrumental chords as chord-only rows around lyric rows", () => {
    const lyrics: LyricsSegmentSchema[] = [
      {
        end_seconds: 20,
        start_seconds: 10,
        text: "Sung line",
        words: [],
      },
    ];

    const rows = buildLeadSheetRows(
      lyrics,
      [chord(2, 4, "C"), chord(12, 14, "F"), chord(24, 26, "G")],
      {
        activeChordIndex: 2,
        activeLyricsIndex: -1,
        activeLyricsWordIndex: -1,
      },
    );

    expect(rows.map((row) => row.type)).toEqual(["chords", "lyrics", "chords"]);
    expect(rows[2]?.isActive).toBe(true);
  });
});
