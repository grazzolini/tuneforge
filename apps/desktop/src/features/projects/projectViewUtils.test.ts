import { describe, expect, it } from "vitest";
import type { ChordSegmentSchema, JobSchema, LyricsSegmentSchema } from "../../lib/api";
import {
  buildLeadSheetRows,
  findActiveLyricsIndex,
  formatJobStatusSummary,
  transposeChordSegment,
} from "./projectViewUtils";

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

describe("findActiveLyricsIndex", () => {
  it("prefers the next phrase once overlapping lyric segments start", () => {
    const lyrics: LyricsSegmentSchema[] = [
      {
        end_seconds: 12,
        start_seconds: 0,
        text: "First overlapping phrase",
        words: [],
      },
      {
        end_seconds: 16,
        start_seconds: 8,
        text: "Second overlapping phrase",
        words: [],
      },
    ];

    expect(findActiveLyricsIndex(lyrics, 7.99)).toBe(0);
    expect(findActiveLyricsIndex(lyrics, 7.9995)).toBe(1);
    expect(findActiveLyricsIndex(lyrics, 8)).toBe(1);
  });

  it("keeps lyric gaps inactive outside seek precision tolerance", () => {
    const lyrics: LyricsSegmentSchema[] = [
      {
        end_seconds: 4,
        start_seconds: 0,
        text: "Before the gap",
        words: [],
      },
      {
        end_seconds: 12,
        start_seconds: 8,
        text: "After the gap",
        words: [],
      },
    ];

    expect(findActiveLyricsIndex(lyrics, 5)).toBe(-1);
    expect(findActiveLyricsIndex(lyrics, 7.99)).toBe(-1);
    expect(findActiveLyricsIndex(lyrics, 7.9995)).toBe(1);
  });
});

describe("transposeChordSegment", () => {
  it("transposes supported chord extensions", () => {
    const segment: ChordSegmentSchema = {
      bass_pitch_class: 4,
      confidence: 0.9,
      end_seconds: 4,
      label: "Cmaj7/E",
      pitch_class: 0,
      quality: "maj7",
      root_pitch_class: 0,
      start_seconds: 0,
    };

    expect(
      transposeChordSegment(segment, 2, {
        activeKey: { pitchClass: 2, mode: "major" },
        mode: "auto",
      }),
    ).toMatchObject({
      bass_pitch_class: 6,
      label: "Dmaj7/F#",
      pitch_class: 2,
      root_pitch_class: 2,
      quality: "maj7",
    });
  });

  it("keeps unknown chord qualities as backend fallbacks", () => {
    const segment: ChordSegmentSchema = {
      confidence: 0.9,
      end_seconds: 4,
      label: "C6",
      pitch_class: 0,
      quality: "6",
      start_seconds: 0,
    };

    expect(
      transposeChordSegment(segment, 2, {
        activeKey: { pitchClass: 2, mode: "major" },
        mode: "auto",
      }),
    ).toBe(segment);
  });
});

describe("formatJobStatusSummary", () => {
  it("includes chord detection source for chord jobs", () => {
    const job: JobSchema = {
      chord_backend: "tuneforge-fast",
      chord_source: "source+stem",
      completed_at: "2026-04-18T13:16:14.000Z",
      created_at: "2026-04-18T13:16:00.000Z",
      duration_seconds: 14,
      error_message: null,
      id: "job_chords",
      progress: 100,
      project_id: "proj_123",
      runtime_device: "cpu",
      source_artifact_id: null,
      started_at: "2026-04-18T13:16:00.000Z",
      status: "completed",
      type: "chords",
      updated_at: "2026-04-18T13:16:14.000Z",
    };

    expect(formatJobStatusSummary(job)).toBe("completed / built-in / source+stem / CPU / 14 s");
  });

  it("includes advanced chord backend for crema jobs", () => {
    const job: JobSchema = {
      chord_backend: "crema-advanced",
      chord_source: "source",
      completed_at: "2026-04-18T13:16:14.000Z",
      created_at: "2026-04-18T13:16:00.000Z",
      duration_seconds: 5.3,
      error_message: null,
      id: "job_chords_advanced",
      progress: 100,
      project_id: "proj_123",
      runtime_device: "cuda",
      source_artifact_id: null,
      started_at: "2026-04-18T13:16:09.000Z",
      status: "completed",
      type: "chords",
      updated_at: "2026-04-18T13:16:14.000Z",
    };

    expect(formatJobStatusSummary(job)).toBe("completed / advanced / source / CUDA / 5.3 s");
  });
});
