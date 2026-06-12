import { describe, expect, it } from "vitest";
import type { ChordSegmentSchema } from "../../lib/api";
import type { MusicalKey } from "../../lib/music";
import {
  buildChordDictionaryFollowContext,
  buildChordDictionaryFollowProjectContext,
  type ChordDictionaryFollowProjectContext,
} from "./chordDictionaryFollowContext";

function chordSegment(
  startSeconds: number,
  endSeconds: number,
  label: string,
  overrides: Partial<ChordSegmentSchema> = {},
): ChordSegmentSchema {
  return {
    confidence: 0.94,
    end_seconds: endSeconds,
    label,
    pitch_class: null,
    quality: null,
    start_seconds: startSeconds,
    ...overrides,
  };
}

const SOURCE_KEY: MusicalKey = { pitchClass: 0, mode: "major" };
const DISPLAYED_KEY: MusicalKey = { pitchClass: 2, mode: "major" };

const SOURCE_TIMELINE: ChordSegmentSchema[] = [
  chordSegment(4, 8, "C", {
    display_label: "C",
    pitch_class: 0,
    quality: "major",
    raw_label: "C:maj",
  }),
  chordSegment(8, 12, "G", {
    display_label: "G",
    pitch_class: 7,
    quality: "major",
    raw_label: "G:maj",
  }),
];

const DISPLAYED_TIMELINE: ChordSegmentSchema[] = [
  chordSegment(4, 8, "D", {
    display_label: "C",
    pitch_class: 2,
    quality: "major",
    raw_label: "C:maj",
  }),
  chordSegment(8, 12, "A", {
    display_label: "G",
    pitch_class: 9,
    quality: "major",
    raw_label: "G:maj",
  }),
];

function makeProject(
  overrides: Partial<ChordDictionaryFollowProjectContext> = {},
): ChordDictionaryFollowProjectContext {
  return {
    authoritativeSourceTimeline: SOURCE_TIMELINE,
    displayedKey: DISPLAYED_KEY,
    displayedTimeline: DISPLAYED_TIMELINE,
    projectId: "project_chord_dictionary_follow",
    projectName: "Chord Dictionary Session",
    selectedPlaybackArtifactId: "artifact_practice_mix",
    sourceKey: SOURCE_KEY,
    totalDisplayTransposeSemitones: 2,
    visualCapoSemitoneShift: 5,
    ...overrides,
  };
}

describe("buildChordDictionaryFollowContext", () => {
  it("returns no-project when project is null", () => {
    const context = buildChordDictionaryFollowContext({
      followArmed: true,
      playbackActive: true,
      playbackTimeSeconds: 6,
      project: null,
    });

    expect(context).toMatchObject({
      currentChord: null,
      nextChord: null,
      playbackTimeSeconds: 6,
      project: null,
      status: "no-project",
    });
  });

  it("returns follow-off when project exists but follow is not armed", () => {
    const project = makeProject();

    const context = buildChordDictionaryFollowContext({
      followArmed: false,
      playbackActive: true,
      playbackTimeSeconds: 6,
      project,
    });

    expect(context).toMatchObject({
      currentChord: null,
      nextChord: null,
      playbackTimeSeconds: 6,
      project,
      status: "follow-off",
    });
  });

  it("returns paused when follow is armed but playback is not active", () => {
    const project = makeProject();

    const context = buildChordDictionaryFollowContext({
      followArmed: true,
      playbackActive: false,
      playbackTimeSeconds: 6,
      project,
    });

    expect(context).toMatchObject({
      currentChord: null,
      nextChord: null,
      playbackTimeSeconds: 6,
      project,
      status: "paused",
    });
  });

  it.each([
    [
      "source timeline",
      { authoritativeSourceTimeline: [] },
    ],
    [
      "displayed timeline",
      { displayedTimeline: [] },
    ],
  ] satisfies Array<[string, Partial<ChordDictionaryFollowProjectContext>]>)(
    "returns no-chord-timeline when %s is empty",
    (_timelineName, projectOverrides) => {
      const project = makeProject(projectOverrides);

      const context = buildChordDictionaryFollowContext({
        followArmed: true,
        playbackActive: true,
        playbackTimeSeconds: 6,
        project,
      });

      expect(context).toMatchObject({
        currentChord: null,
        nextChord: null,
        playbackTimeSeconds: 6,
        project,
        status: "no-chord-timeline",
      });
    },
  );

  it.each([
    ["before the first chord", 2, 0],
    ["after the chord range", 14, null],
  ] satisfies Array<[string, number, number | null]>)(
    "returns no-current-chord for playback %s",
    (_position, playbackTimeSeconds, expectedNextIndex) => {
      const project = makeProject();

      const context = buildChordDictionaryFollowContext({
        followArmed: true,
        playbackActive: true,
        playbackTimeSeconds,
        project,
      });

      expect(context.status).toBe("no-current-chord");
      expect(context.currentChord).toBeNull();
      expect(context.playbackTimeSeconds).toBe(playbackTimeSeconds);
      expect(context.project).toBe(project);
      if (expectedNextIndex === null) {
        expect(context.nextChord).toBeNull();
      } else {
        expect(context.nextChord).toMatchObject({
          displayedSegment: DISPLAYED_TIMELINE[expectedNextIndex],
          index: expectedNextIndex,
          sourceSegment: SOURCE_TIMELINE[expectedNextIndex],
        });
      }
    },
  );

  it("returns active with current chord and next chord during playback", () => {
    const project = makeProject();

    const context = buildChordDictionaryFollowContext({
      followArmed: true,
      playbackActive: true,
      playbackTimeSeconds: 6,
      project,
    });

    expect(context).toMatchObject({
      playbackTimeSeconds: 6,
      project,
      status: "active",
    });
    expect(context.currentChord).toMatchObject({
      displayedSegment: DISPLAYED_TIMELINE[0],
      displayLabel: "D",
      index: 0,
      sourceLabel: "C",
      sourceSegment: SOURCE_TIMELINE[0],
    });
    expect(context.nextChord).toMatchObject({
      displayedSegment: DISPLAYED_TIMELINE[1],
      displayLabel: "A",
      index: 1,
      sourceLabel: "G",
      sourceSegment: SOURCE_TIMELINE[1],
    });
  });

  it("uses safe explicit labels when displayed segment source labels are stale", () => {
    const project = makeProject();

    const context = buildChordDictionaryFollowContext({
      followArmed: true,
      playbackActive: true,
      playbackTimeSeconds: 6,
      project,
    });

    expect(context.currentChord?.sourceLabel).toBe("C");
    expect(context.currentChord?.displayLabel).toBe("D");
    expect(context.currentChord?.sourceSegment.display_label).toBe("C");
    expect(context.currentChord?.sourceSegment.raw_label).toBe("C:maj");
    expect(context.currentChord?.displayedSegment.label).toBe("D");
    expect(context.currentChord?.displayedSegment.display_label).toBe("C");
    expect(context.currentChord?.displayedSegment.raw_label).toBe("C:maj");
  });

  it("preserves playback artifact, key, transpose, and visual capo fields", () => {
    const project = makeProject();

    const context = buildChordDictionaryFollowContext({
      followArmed: true,
      playbackActive: true,
      playbackTimeSeconds: 6,
      project,
    });

    expect(context.project).toMatchObject({
      displayedKey: DISPLAYED_KEY,
      selectedPlaybackArtifactId: "artifact_practice_mix",
      sourceKey: SOURCE_KEY,
      totalDisplayTransposeSemitones: 2,
      visualCapoSemitoneShift: 5,
    });
  });

  it("keeps source and displayed chord timelines distinct", () => {
    const project = makeProject();

    const context = buildChordDictionaryFollowContext({
      followArmed: true,
      playbackActive: true,
      playbackTimeSeconds: 6,
      project,
    });

    expect(context.project?.authoritativeSourceTimeline).toBe(SOURCE_TIMELINE);
    expect(context.project?.displayedTimeline).toBe(DISPLAYED_TIMELINE);
    expect(context.currentChord?.sourceSegment).toBe(SOURCE_TIMELINE[0]);
    expect(context.currentChord?.displayedSegment).toBe(DISPLAYED_TIMELINE[0]);
    expect(context.currentChord?.sourceLabel).toBe("C");
    expect(context.currentChord?.displayLabel).toBe("D");
    expect(context.currentChord?.sourceSegment.label).toBe("C");
    expect(context.currentChord?.displayedSegment.label).toBe("D");
  });
});

describe("buildChordDictionaryFollowProjectContext", () => {
  it("preserves project mapping fields and source/display timelines", () => {
    const sourceTimeline = [
      chordSegment(0, 4, "C", {
        display_label: "C",
        pitch_class: 0,
        quality: "major",
        raw_label: "C:maj",
      }),
    ];
    const displayedTimeline = [
      chordSegment(0, 4, "D", {
        display_label: "C",
        pitch_class: 2,
        quality: "major",
        raw_label: "C:maj",
      }),
    ];

    const project = buildChordDictionaryFollowProjectContext({
      authoritativeSourceTimeline: sourceTimeline,
      displayedKey: DISPLAYED_KEY,
      displayedTimeline,
      projectId: "project_mapping",
      projectName: "Project Mapping",
      selectedPlaybackArtifactId: "artifact_practice_mix",
      sourceKey: SOURCE_KEY,
      totalDisplayTransposeSemitones: 2,
      visualCapoSemitoneShift: 5,
    });

    expect(project).toMatchObject({
      displayedKey: DISPLAYED_KEY,
      projectId: "project_mapping",
      projectName: "Project Mapping",
      selectedPlaybackArtifactId: "artifact_practice_mix",
      sourceKey: SOURCE_KEY,
      totalDisplayTransposeSemitones: 2,
      visualCapoSemitoneShift: 5,
    });
    expect(project.authoritativeSourceTimeline).toBe(sourceTimeline);
    expect(project.displayedTimeline).toBe(displayedTimeline);
    expect(project.authoritativeSourceTimeline[0]).toMatchObject({
      display_label: "C",
      label: "C",
      raw_label: "C:maj",
    });
    expect(project.displayedTimeline[0]).toMatchObject({
      display_label: "C",
      label: "D",
      raw_label: "C:maj",
    });
  });
});
