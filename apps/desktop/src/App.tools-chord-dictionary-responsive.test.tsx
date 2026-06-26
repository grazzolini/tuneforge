import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChordDictionaryFollowProjectContext,
  type ChordDictionaryFollowProjectContext,
} from "./features/projects/chordDictionaryFollowContext";
import {
  PlaybackContext,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./features/projects/playback-context";
import { ChordDictionaryPage } from "./features/tools/ChordDictionaryPage";
import { ChordDictionaryFollowArmProvider } from "./features/tools/chordDictionaryFollowArm";
import type { ChordSegmentSchema } from "./lib/api";
import { resetAppTestHarness } from "./test/appTestHarness";

const sourceTimeline: ChordSegmentSchema[] = [
  {
    confidence: 0.81,
    end_seconds: 16,
    label: "G",
    pitch_class: 7,
    quality: "major",
    start_seconds: 0,
  },
  {
    confidence: 0.79,
    end_seconds: 32,
    label: "D",
    pitch_class: 2,
    quality: "major",
    start_seconds: 16,
  },
];

const displayedTimeline: ChordSegmentSchema[] = [
  {
    confidence: 0.81,
    end_seconds: 16,
    label: "A",
    pitch_class: 9,
    quality: "major",
    start_seconds: 0,
  },
  {
    confidence: 0.79,
    end_seconds: 32,
    label: "E",
    pitch_class: 4,
    quality: "major",
    start_seconds: 16,
  },
];

function makeFollowProject(
  overrides: Partial<ChordDictionaryFollowProjectContext> = {},
): ChordDictionaryFollowProjectContext {
  return buildChordDictionaryFollowProjectContext({
    authoritativeSourceTimeline: sourceTimeline,
    displayedKey: { pitchClass: 9, mode: "major" },
    displayedTimeline,
    projectId: "proj_123",
    projectName: "Demo Song",
    selectedPlaybackArtifactId: "art_source",
    sourceKey: { pitchClass: 7, mode: "major" },
    totalDisplayTransposeSemitones: 2,
    visualCapoSemitoneShift: 0,
    ...overrides,
  });
}

function makePlaybackSession(
  project: ChordDictionaryFollowProjectContext,
): ProjectPlaybackSession {
  return {
    artifactFormatsById: { art_source: "wav" },
    artifactPathsById: { art_source: "/tmp/demo.wav" },
    chordDictionaryFollowProject: project,
    durationHintSeconds: 96,
    isStemPlayback: false,
    loopRange: null,
    playbackArtifactIds: ["art_source"],
    precountClickCount: 4,
    precountEnabled: false,
    precountLoopEnabled: false,
    precountTempoBpm: null,
    projectId: project.projectId,
    projectName: project.projectName,
    selectedPlaybackArtifactId: "art_source",
    stageSummary: "Source mix",
    stageTitle: "Source audio",
    stemControls: {},
    tempoOriginalBpm: null,
    tempoTargetBpm: null,
    timingGrid: null,
    visibleStemArtifactIds: [],
  };
}

function makePlaybackValue({
  isPlaying = true,
  playbackTimeSeconds = 6,
  project = makeFollowProject(),
}: {
  isPlaying?: boolean;
  playbackTimeSeconds?: number;
  project?: ChordDictionaryFollowProjectContext | null;
} = {}): PlaybackContextValue {
  const session = project ? makePlaybackSession(project) : null;
  return {
    activateStemPlayback: vi.fn(async () => undefined),
    dismissSession: vi.fn(),
    getPlaybackSnapshot: () => ({
      isPlaying,
      isPrecounting: false,
      playbackDurationSeconds: 96,
      playbackTimeSeconds,
      session,
    }),
    isPlaying,
    isPrecounting: false,
    pausePlayback: vi.fn(),
    playPlayback: vi.fn(async () => undefined),
    playbackDurationSeconds: 96,
    playbackTimeSeconds,
    primeWebAudioForGesture: vi.fn(async () => undefined),
    registerProjectSession: vi.fn(),
    seekBy: vi.fn(),
    seekTo: vi.fn(),
    session,
    stopPlayback: vi.fn(),
    togglePlayback: vi.fn(async () => undefined),
  };
}

function renderLiveFollow({
  playback = makePlaybackValue(),
}: {
  playback?: PlaybackContextValue;
} = {}) {
  render(
    <MemoryRouter initialEntries={["/tools?tool=chord-dictionary&followPlayback=1&projectId=proj_123"]}>
      <PlaybackContext.Provider value={playback}>
        <ChordDictionaryFollowArmProvider>
          <ChordDictionaryPage />
        </ChordDictionaryFollowArmProvider>
      </PlaybackContext.Provider>
    </MemoryRouter>,
  );
  return screen.findByRole("heading", { name: "Chord Dictionary" });
}

function renderDictionary({
  playback = makePlaybackValue({ isPlaying: false, project: null }),
}: {
  playback?: PlaybackContextValue;
} = {}) {
  render(
    <MemoryRouter initialEntries={["/tools?tool=chord-dictionary"]}>
      <PlaybackContext.Provider value={playback}>
        <ChordDictionaryFollowArmProvider>
          <ChordDictionaryPage />
        </ChordDictionaryFollowArmProvider>
      </PlaybackContext.Provider>
    </MemoryRouter>,
  );
  return screen.findByRole("heading", { name: "Chord Dictionary" });
}

function getLivePage() {
  const page = document.querySelector(".live-follow-page");
  if (!(page instanceof HTMLElement)) {
    throw new Error("Expected Live Follow page");
  }
  return page;
}

function getLiveInstrumentSelector() {
  return screen.getByRole("group", { name: "Live instrument" });
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

describe("Desktop app tools chord dictionary responsive layout", () => {
  beforeEach(() => {
    setViewportWidth(1024);
    resetAppTestHarness();
  });

  it("keeps Dictionary guitar metadata fields shrinkable in the desktop split layout", async () => {
    setViewportWidth(1280);
    await renderDictionary();

    const fieldRow = document.querySelector(".chord-field-row");
    if (!(fieldRow instanceof HTMLElement)) {
      throw new Error("Expected guitar metadata field row");
    }

    expect(within(fieldRow).getByText("Instrument")).toBeInTheDocument();
    expect(within(fieldRow).getByText("Tuning")).toBeInTheDocument();
    expect(within(fieldRow).getByText("Capo")).toBeInTheDocument();
    expect(within(fieldRow).getByText("Retune")).toBeInTheDocument();
    expect(fieldRow).toHaveAttribute("data-layout", "responsive");
    expect(fieldRow.querySelectorAll(".chord-field")).toHaveLength(4);
  });

  it("keeps Live Follow active regions compact without hiding provenance", async () => {
    const user = userEvent.setup();
    await renderLiveFollow();

    const page = getLivePage();
    expect(page).toHaveClass("live-follow-page--active");
    expect(page).toHaveAttribute("data-follow-status", "active");

    const currentChord = screen.getByLabelText("Current chord");
    expect(within(currentChord).getByRole("heading", { name: "A" })).toBeInTheDocument();
    expect(currentChord.querySelectorAll(".live-follow-provenance div")).toHaveLength(5);
    expect(currentChord).toHaveTextContent(/Source chord\s*G/);
    expect(currentChord).toHaveTextContent(/Display chord\s*A/);
    expect(currentChord).toHaveTextContent(/Detected\/imported project chords/);
    expect(currentChord).toHaveTextContent(/Playback source\s*Demo Song/);
    expect(screen.getByLabelText("Next chord")).toHaveTextContent(/E/);
    expect(document.querySelector(".guitar-fretboard")).toBeInTheDocument();

    await user.click(within(getLiveInstrumentSelector()).getByRole("button", { name: "Accordion" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "A accordion positions" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("group", { name: /Left hand/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Right hand/i })).toBeInTheDocument();
    expect(document.querySelector(".accordion-stradella")).toBeInTheDocument();
    expect(document.querySelector(".accordion-keyboard")).toBeInTheDocument();
    expect(document.querySelector(".guitar-fretboard")).not.toBeInTheDocument();

    await user.click(within(getLiveInstrumentSelector()).getByRole("button", { name: "Piano" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "A piano voicings" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Region A")).toBeInTheDocument();
    expect(document.querySelector(".piano-keyboard")).toBeInTheDocument();
    expect(document.querySelector(".accordion-stradella")).not.toBeInTheDocument();
    expect(document.querySelector(".accordion-keyboard")).not.toBeInTheDocument();
  });

  it("keeps Live Follow waiting state to one status card", async () => {
    await renderLiveFollow({ playback: makePlaybackValue({ project: null }) });

    const page = getLivePage();
    expect(page).toHaveClass("live-follow-page--waiting");
    expect(page).toHaveAttribute("data-follow-status", "no-project");
    expect(screen.getByRole("status")).toHaveTextContent("No matching project playback");
    expect(screen.getByRole("group", { name: "Live chord display status" })).toHaveTextContent(
      "No Project",
    );
    expect(screen.queryByLabelText("Current chord")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Next chord")).not.toBeInTheDocument();
  });

  it("keeps 360px Live Follow controls and instrument regions addressable", async () => {
    const user = userEvent.setup();
    setViewportWidth(360);
    await renderLiveFollow();

    const controls = screen.getByRole("group", { name: "Live chord display status" });
    expect(within(controls).getByRole("button", { name: "Guitar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(controls).getByRole("button", { name: "Accordion" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(controls).getByRole("button", { name: "Piano" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Current chord")).toHaveTextContent(/Display chord\s*A/);
    expect(screen.getByLabelText("Next chord")).toHaveTextContent(/E/);
    expect(screen.getByRole("group", { name: "Project guitar shape preference choices" }))
      .toBeInTheDocument();
    expect(document.querySelector(".chord-shape-grid")).toHaveAttribute("data-layout", "responsive");

    await user.click(within(getLiveInstrumentSelector()).getByRole("button", { name: "Piano" }));
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Project piano voicing preference choices" }),
      ).toBeInTheDocument(),
    );
    expect(document.querySelector(".piano-keyboard")).toBeInTheDocument();

    await user.click(within(getLiveInstrumentSelector()).getByRole("button", { name: "Accordion" }));
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Project accordion right-hand preference choices" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("group", { name: /Left hand/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Right hand/i })).toBeInTheDocument();
  });
});
