import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChordSegmentSchema } from "./lib/api";
import { renderApp, resetAppTestHarness } from "./test/appTestHarness";
import { ChordDictionaryPage } from "./features/tools/ChordDictionaryPage";
import { ChordDictionaryFollowArmProvider } from "./features/tools/chordDictionaryFollowArm";
import {
  buildChordDictionaryFollowProjectContext,
  type ChordDictionaryFollowProjectContext,
} from "./features/projects/chordDictionaryFollowContext";
import {
  PlaybackContext,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./features/projects/playback-context";

function renderChordDictionary() {
  renderApp(["/tools?tool=chord-dictionary"]);
  return screen.findByRole("heading", { name: "Chord Dictionary" });
}

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
  {
    confidence: 0.74,
    end_seconds: 48,
    label: "Em",
    pitch_class: 4,
    quality: "minor",
    start_seconds: 32,
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
  {
    confidence: 0.74,
    end_seconds: 48,
    label: "F#m",
    pitch_class: 6,
    quality: "minor",
    start_seconds: 32,
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

function renderChordDictionaryWithPlayback({
  entry = "/tools?tool=chord-dictionary&followPlayback=1&projectId=proj_123",
  playback = makePlaybackValue(),
}: {
  entry?: string;
  playback?: PlaybackContextValue;
} = {}) {
  const view = renderChordDictionaryPlaybackHarness({ entry, playback });
  return view.findHeading();
}

function renderChordDictionaryPlaybackHarness({
  entry = "/tools?tool=chord-dictionary&followPlayback=1&projectId=proj_123",
  playback = makePlaybackValue(),
}: {
  entry?: string;
  playback?: PlaybackContextValue;
} = {}) {
  const renderTree = (playbackValue: PlaybackContextValue) => (
    <MemoryRouter initialEntries={[entry]}>
      <PlaybackContext.Provider value={playbackValue}>
        <ChordDictionaryFollowArmProvider>
          <ChordDictionaryPage />
        </ChordDictionaryFollowArmProvider>
      </PlaybackContext.Provider>
    </MemoryRouter>
  );

  const view = render(renderTree(playback));
  return {
    findHeading: () => screen.findByRole("heading", { name: "Chord Dictionary" }),
    rerenderWithPlayback: (nextPlayback: PlaybackContextValue) => {
      view.rerender(renderTree(nextPlayback));
    },
  };
}

function getToolsScreen() {
  const toolsTabs = screen.getByRole("tablist", { name: "Tools" });
  const toolsScreen = toolsTabs.closest("section");
  if (!toolsScreen) {
    throw new Error("Expected Chord Dictionary to render inside the Tools screen");
  }
  return toolsScreen as HTMLElement;
}

function changeChordSearch(value: string) {
  const input = screen.getByLabelText("Chord search");
  fireEvent.change(input, { target: { value } });
  return input;
}

function expectInspectorToShow(patterns: Array<RegExp | string>) {
  const inspector = screen.getByLabelText("Note inspector");
  for (const pattern of patterns) {
    expect(inspector).toHaveTextContent(pattern);
  }
}

function expectTextVisible(text: RegExp | string) {
  expect(screen.getAllByText(text).length).toBeGreaterThan(0);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getStandardDisplayString(stringNumber: number) {
  return 7 - stringNumber;
}

function getShapeCard(label: string) {
  const shapeLabel = screen
    .getAllByRole("button", { name: label })
    .find((button) => button.closest(".chord-shape-card"));
  if (!shapeLabel) {
    throw new Error(`Expected ${label} shape card`);
  }

  const shapeCard = shapeLabel.closest(".chord-shape-card");
  if (!shapeCard) {
    throw new Error(`Expected ${label} label inside a shape card`);
  }
  return shapeCard as HTMLElement;
}

function getStandardDiagram(label: string) {
  const shapeCard = getShapeCard(label);
  const diagram = within(shapeCard).getByRole("group", {
    name: new RegExp(`${escapeRegExp(label)}.*standard guitar diagram`, "i"),
  });

  expect(diagram).toHaveClass("guitar-fretboard");
  expect(diagram).toHaveClass("guitar-fretboard--standard");
  expect(diagram).toHaveAttribute("data-string-orientation", "vertical");
  expect(diagram).toHaveAttribute("data-fret-orientation", "horizontal");
  expect(diagram.querySelector(".guitar-fretboard__board")).toBeInTheDocument();
  expect(diagram.querySelector(".guitar-fretboard__numbers")).toBeInTheDocument();
  expect(diagram.querySelector(".guitar-fretboard__strings")).toBeInTheDocument();
  return diagram as HTMLElement;
}

function expectStandardStringLabels(diagram: HTMLElement) {
  const expectedLabels = [
    [6, "E"],
    [5, "A"],
    [4, "D"],
    [3, "G"],
    [2, "B"],
    [1, "E"],
  ] as const;
  const stringLabels = Array.from(diagram.querySelectorAll(".guitar-fretboard__strings span"));

  expect(stringLabels.map((label) => label.getAttribute("data-string"))).toEqual([
    "6",
    "5",
    "4",
    "3",
    "2",
    "1",
  ]);

  for (const [stringNumber, label] of expectedLabels) {
    const stringLabel = within(diagram).getByLabelText(
      new RegExp(`string\\s*${stringNumber}.*\\b${label}\\b`, "i"),
    );
    expect(stringLabel).toHaveAttribute("data-string", String(stringNumber));
  }
}

function expectPlayableNote(
  diagram: HTMLElement,
  note: string,
  stringNumber: number,
  fret: number,
) {
  const noteButton = within(diagram).getByRole("button", {
    name: `${note} string ${stringNumber} fret ${fret}`,
  });

  expect(noteButton).toHaveAttribute("data-string", String(stringNumber));
  expect(noteButton).toHaveAttribute("data-fret", String(fret));
  expect(noteButton).toHaveAttribute("data-note", note);
  expect(noteButton).toHaveAttribute("data-note-kind", fret === 0 ? "open" : "fretted");
  expect(noteButton).toHaveAttribute("title", note);
  expect(noteButton.style.getPropertyValue("--string")).toBe(
    String(getStandardDisplayString(stringNumber)),
  );
  expect(within(noteButton).getByText(note)).toHaveClass("guitar-fretboard__note-tooltip");
  return noteButton as HTMLElement;
}

function expectActiveTooltipNotes(expectedNotes: string[]) {
  const activeDots = Array.from(document.querySelectorAll(".guitar-fretboard__dot--tooltip-active"));
  expect(activeDots.map((dot) => dot.getAttribute("data-note"))).toEqual(expectedNotes);
  expect(document.querySelectorAll('.guitar-fretboard__dot[data-tooltip-active="true"]')).toHaveLength(
    expectedNotes.length,
  );
}

function expectOpenMarker(diagram: HTMLElement, stringNumber: number) {
  const marker = within(diagram).getByLabelText(
    new RegExp(`(?:open\\s*string\\s*${stringNumber}|string\\s*${stringNumber}\\s*open)`, "i"),
  );
  expect(marker).toHaveAttribute("data-string", String(stringNumber));
  expect(marker).toHaveClass("guitar-fretboard__marker--open");
  expect(marker.style.getPropertyValue("--string")).toBe(
    String(getStandardDisplayString(stringNumber)),
  );
}

function expectMutedMarker(diagram: HTMLElement, stringNumber: number) {
  const marker = within(diagram).getByLabelText(
    new RegExp(`(?:muted\\s*string\\s*${stringNumber}|string\\s*${stringNumber}\\s*muted)`, "i"),
  );
  expect(marker).toHaveAttribute("data-string", String(stringNumber));
  expect(marker).toHaveClass("guitar-fretboard__marker--muted");
  expect(marker.style.getPropertyValue("--string")).toBe(
    String(getStandardDisplayString(stringNumber)),
  );
}

function expectNoOpenMarker(diagram: HTMLElement, stringNumber: number) {
  expect(
    within(diagram).queryByLabelText(
      new RegExp(`(?:open\\s*string\\s*${stringNumber}|string\\s*${stringNumber}\\s*open)`, "i"),
    ),
  ).not.toBeInTheDocument();
}

function expectNoMutedMarker(diagram: HTMLElement, stringNumber: number) {
  expect(
    within(diagram).queryByLabelText(
      new RegExp(`(?:muted\\s*string\\s*${stringNumber}|string\\s*${stringNumber}\\s*muted)`, "i"),
    ),
  ).not.toBeInTheDocument();
}

function expectContinuousBarre(
  diagram: HTMLElement,
  {
    fret,
    fromString,
    toString,
  }: { fret: number; fromString: number; toString: number },
) {
  const barre = within(diagram).getByLabelText(
    new RegExp(
      `barre.*fret\\s*${fret}.*strings?\\s*${fromString}.*${toString}`,
      "i",
    ),
  );

  expect(barre).toHaveClass("guitar-fretboard__barre");
  expect(barre).toHaveAttribute("data-barre-fret", String(fret));
  expect(barre).toHaveAttribute("data-barre-from-string", String(fromString));
  expect(barre).toHaveAttribute("data-barre-to-string", String(toString));
  expect(barre.style.getPropertyValue("--barre-start-string")).toBe(String(fromString));
  expect(barre.style.getPropertyValue("--barre-end-string")).toBe(String(toString));
  expect(barre.style.getPropertyValue("--string-start")).toBe(
    String(Math.min(getStandardDisplayString(fromString), getStandardDisplayString(toString))),
  );
  expect(barre.style.getPropertyValue("--string-end")).toBe(
    String(Math.max(getStandardDisplayString(fromString), getStandardDisplayString(toString))),
  );
  return barre as HTMLElement;
}

function setNarrowViewport(width: number) {
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

function getCommonChordCard(label: string) {
  const chordCard = Array.from(document.querySelectorAll(".chord-family-card")).find(
    (card) => card.querySelector("strong")?.textContent === label,
  );
  if (!chordCard) {
    throw new Error(`Expected ${label} common chord card`);
  }
  return chordCard as HTMLElement;
}

function expectContainedHorizontalOverflow(element: HTMLElement, viewportWidth: number) {
  expect(element.scrollWidth).toBeLessThanOrEqual(Math.max(element.clientWidth, viewportWidth));
}

describe("Desktop app tools chord dictionary", () => {
  beforeEach(resetAppTestHarness);

  it("renders the default guitar dictionary from the tools route", async () => {
    await renderChordDictionary();

    expect(screen.getByLabelText("Chord search")).toHaveValue("C");
    const instrumentStatus = screen.getByRole("group", { name: "Instrument status" });
    expect(within(instrumentStatus).getByText("Guitar")).toBeInTheDocument();
    expect(within(instrumentStatus).queryByRole("button", { name: "Guitar" })).not.toBeInTheDocument();
    expectTextVisible("C E G");
    expect(
      screen.getAllByRole("button", { name: "C3 string 5 fret 3" }).length,
    ).toBeGreaterThan(0);
    expectTextVisible("E A D G B E");
    expectTextVisible("E2 - D6");
    expectTextVisible("6 strings x 22 frets");
    expectInspectorToShow([
      /C3/,
      /String\s*5/,
      /Fret\s*3/,
      /Finger\s*3/,
      /Degree\s*1/,
    ]);
  });

  it("renders C open with standard vertical-string diagram semantics", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const diagram = getStandardDiagram("C open");

    expectStandardStringLabels(diagram);
    expectPlayableNote(diagram, "C3", 5, 3);
    expectPlayableNote(diagram, "E3", 4, 2);
    const openStringNote = expectPlayableNote(diagram, "G3", 3, 0);
    expectPlayableNote(diagram, "C4", 2, 1);
    expectPlayableNote(diagram, "E4", 1, 0);
    expectOpenMarker(diagram, 3);
    expectOpenMarker(diagram, 1);
    expectMutedMarker(diagram, 6);
    expectNoOpenMarker(diagram, 6);
    expectNoMutedMarker(diagram, 3);
    expect(within(getShapeCard("C open")).getByText(/Common.*5 notes.*frets 0-3.*1 muted string/)).toBeInTheDocument();

    await user.click(openStringNote);

    await waitFor(() =>
      expectInspectorToShow([/G3/, /String\s*3/, /Fret\s*0/, /Degree\s*5/]),
    );
    expectActiveTooltipNotes(["G3"]);
  });

  it("previews hovered and focused notes with one active tooltip", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const diagram = getStandardDiagram("C open");
    const selectedRoot = expectPlayableNote(diagram, "C3", 5, 3);
    const previewNote = expectPlayableNote(diagram, "E3", 4, 2);

    expect(selectedRoot).toHaveClass("guitar-fretboard__dot--tooltip-active");
    expectActiveTooltipNotes(["C3"]);
    expectInspectorToShow([/C3/, /String\s*5/, /Fret\s*3/]);

    await user.hover(previewNote);

    await waitFor(() => expectInspectorToShow([/E3/, /String\s*4/, /Fret\s*2/]));
    expectActiveTooltipNotes(["E3"]);

    await user.unhover(previewNote);

    await waitFor(() => expectInspectorToShow([/C3/, /String\s*5/, /Fret\s*3/]));
    expectActiveTooltipNotes(["C3"]);

    previewNote.focus();

    await waitFor(() => expectInspectorToShow([/E3/, /String\s*4/, /Fret\s*2/]));
    expectActiveTooltipNotes(["E3"]);

    previewNote.blur();

    await waitFor(() => expectInspectorToShow([/C3/, /String\s*5/, /Fret\s*3/]));
    expectActiveTooltipNotes(["C3"]);
  });

  it("renders F barre as one continuous E-shape barre with note buttons intact", async () => {
    await renderChordDictionary();

    changeChordSearch("F");

    const diagram = getStandardDiagram("F E-shape barre");

    expectStandardStringLabels(diagram);
    const barre = expectContinuousBarre(diagram, { fret: 1, fromString: 6, toString: 1 });
    const miniBarre = getCommonChordCard("F").querySelector(".mini-fretboard__barre");

    expect(barre.style.getPropertyValue("--fret-position")).toBe("1");
    expect(miniBarre).toBeInTheDocument();
    expect((miniBarre as HTMLElement).style.getPropertyValue("--barre-start-string")).toBe("6");
    expect((miniBarre as HTMLElement).style.getPropertyValue("--barre-end-string")).toBe("1");
    expect((miniBarre as HTMLElement).style.getPropertyValue("--string-start")).toBe("1");
    expect((miniBarre as HTMLElement).style.getPropertyValue("--string-end")).toBe("6");
    expectPlayableNote(diagram, "F2", 6, 1);
    expectPlayableNote(diagram, "C3", 5, 3);
    expectPlayableNote(diagram, "F3", 4, 3);
    expectPlayableNote(diagram, "A3", 3, 2);
    expectPlayableNote(diagram, "C4", 2, 1);
    expectPlayableNote(diagram, "F4", 1, 1);
    expect(diagram.querySelector(".guitar-fretboard__marker--open")).not.toBeInTheDocument();
    expect(diagram.querySelector(".guitar-fretboard__marker--muted")).not.toBeInTheDocument();
    expect(within(getShapeCard("F E-shape barre")).getByText(/Common.*6 notes.*frets 1-3/)).toBeInTheDocument();
  });

  it("keeps C moved E-shape barre labelled by left fret numbers without position marker text", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const shapeChoices = within(screen.getByRole("group", { name: "Guitar shape choices" }));
    const movedShapeButton = shapeChoices.getByRole("button", { name: "C E-shape barre" });

    await user.click(movedShapeButton);

    const diagram = getStandardDiagram("C E-shape barre");
    const movedShapeCard = getShapeCard("C E-shape barre");

    expect(movedShapeButton).toHaveAttribute("aria-pressed", "true");
    expect(diagram).toHaveAttribute("data-start-fret", "8");
    expect(diagram.querySelector(".guitar-fretboard__position-marker")).not.toBeInTheDocument();
    expect(within(diagram).queryByText(/8\s*fr/i)).not.toBeInTheDocument();
    expect(movedShapeCard).toHaveTextContent(/Common.*6 notes.*frets 8-10/);
    expect(movedShapeCard).not.toHaveTextContent(/8\s*fr/i);
    expect(
      Array.from(diagram.querySelectorAll(".guitar-fretboard__numbers span")).map(
        (fretNumber) => fretNumber.textContent,
      ),
    ).toEqual(["8", "9", "10", "11"]);
    const barre = expectContinuousBarre(diagram, { fret: 8, fromString: 6, toString: 1 });
    const rootButton = expectPlayableNote(diagram, "C3", 6, 8);

    expect(barre.style.getPropertyValue("--fret-position")).toBe("1");
    expectPlayableNote(diagram, "G3", 5, 10);
    expectPlayableNote(diagram, "C4", 4, 10);
    expectPlayableNote(diagram, "E4", 3, 9);
    expectPlayableNote(diagram, "G4", 2, 8);
    expectPlayableNote(diagram, "C5", 1, 8);

    await user.hover(rootButton);
    expect(within(rootButton).getByText("C3")).toHaveClass("guitar-fretboard__note-tooltip");

    await user.click(rootButton);

    await waitFor(() =>
      expectInspectorToShow([/C3/, /String\s*6/, /Fret\s*8/, /Degree\s*1/]),
    );
  });

  it("keeps standard diagrams compact and labelled in a narrow layout", async () => {
    setNarrowViewport(360);
    await renderChordDictionary();

    const diagram = getStandardDiagram("C open");
    const shell = document.querySelector(".chord-dictionary-shell");
    const panel = document.querySelector(".chord-dictionary-panel");
    const mainPanel = document.querySelector(".chord-tool-main");
    const shapeGrid = document.querySelector(".chord-shape-grid");
    const shapeTabs = document.querySelector(".chord-shape-tabs");

    expect(shapeGrid).toHaveAttribute("data-layout", "responsive");
    expect(diagram).toHaveAttribute("data-layout", "compact");
    expect(diagram.style.getPropertyValue("--display-frets")).toBe("4");
    expect(shell).toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(mainPanel).toBeInTheDocument();
    expect(shapeTabs).toBeInTheDocument();
    expectContainedHorizontalOverflow(shell as HTMLElement, 360);
    expectContainedHorizontalOverflow(panel as HTMLElement, 360);
    expectContainedHorizontalOverflow(mainPanel as HTMLElement, 360);
    expectContainedHorizontalOverflow(shapeGrid as HTMLElement, 360);
    expectStandardStringLabels(diagram);
    expectPlayableNote(diagram, "C3", 5, 3);
    expectOpenMarker(diagram, 1);
    expectMutedMarker(diagram, 6);
  });

  it("updates a supported slash-chord search with backed guitar spelling and shape data", async () => {
    await renderChordDictionary();

    const input = changeChordSearch("G/D");

    expect(input).toHaveValue("G/D");
    const resultHeading = screen.getByRole("heading", { name: "G/D guitar shapes" });
    const libraryHeading = screen.getByRole("heading", { name: "Common chord library" });
    expect(
      Boolean(resultHeading.compareDocumentPosition(libraryHeading) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect((await screen.findAllByText("G/D open")).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "D3 string 4 fret 0" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "G3 string 3 fret 0" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "B3 string 2 fret 0" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "G4 string 1 fret 3" }).length,
    ).toBeGreaterThan(0);
    expectTextVisible(/Common.*frets 0-3/);
    expectInspectorToShow([/D3/, /String\s*4/, /Fret\s*0/, /Degree\s*5/]);
  });

  it("keeps unsupported search input honest without stale C chord data", async () => {
    await renderChordDictionary();

    const input = changeChordSearch("H13");

    expect(input).toHaveValue("H13");
    expectTextVisible(/unsupported|not supported|no guitar shapes|no shapes/i);
    expect(screen.queryAllByText("C E G")).toHaveLength(0);
    expect(screen.queryAllByRole("group", { name: "Guitar fretboard" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /C3.*string 5 fret 3/ })).toHaveLength(
      0,
    );
    expect(screen.queryByLabelText("Note inspector")).not.toBeInTheDocument();
  });

  it("updates the note inspector from shape switching and note selection", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const noteButton = screen.getAllByRole("button", { name: "E3 string 4 fret 2" })[0];
    if (!noteButton) {
      throw new Error("Expected a selectable E3 string 4 fret 2 note");
    }

    noteButton.focus();
    expect(noteButton).toHaveFocus();
    expect(within(noteButton).getByText("E3")).toHaveClass("guitar-fretboard__note-tooltip");

    await user.click(noteButton);
    expect(noteButton).toHaveFocus();
    await waitFor(() =>
      expectInspectorToShow([
        /E3/,
        /String\s*4/,
        /Fret\s*2/,
        /Finger\s*2/,
        /Degree\s*3/,
      ]),
    );

    const beforeShapeSwitch = screen.getByLabelText("Note inspector").textContent;
    const shapeButtons = within(
      screen.getByRole("group", { name: "Guitar shape choices" }),
    ).getAllByRole("button");
    if (!shapeButtons[1]) {
      throw new Error("Expected at least two selectable CAGED shapes");
    }

    expect(shapeButtons[0]).toHaveAttribute("aria-pressed", "true");
    expect(shapeButtons[1]).toHaveAttribute("aria-pressed", "false");

    await user.click(shapeButtons[1]);
    await waitFor(() =>
      expect(screen.getByLabelText("Note inspector").textContent).not.toBe(beforeShapeSwitch),
    );
    expect(shapeButtons[1]).toHaveAttribute("aria-pressed", "true");
  });

  it("opens live follow from query params and renders the active project chord", async () => {
    await renderChordDictionaryWithPlayback();

    const viewToggle = screen.getByRole("group", { name: "Chord dictionary views" });
    expect(within(viewToggle).getByRole("button", { name: "Dictionary" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(viewToggle).getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const liveStatus = screen.getByRole("group", { name: "Live chord display status" });
    expect(within(liveStatus).getByText("Live")).toBeInTheDocument();
    expect(within(liveStatus).getByText("Demo Song")).toBeInTheDocument();

    const currentChord = screen.getByLabelText("Current chord");
    expect(within(currentChord).getByRole("heading", { name: "A" })).toBeInTheDocument();
    expect(currentChord).toHaveTextContent(/Source chord\s*G/);
    expect(currentChord).toHaveTextContent(/Display chord\s*A/);
    expect(currentChord).toHaveTextContent(/Detected\/imported project chords/);
    expect(currentChord).toHaveTextContent(/Playback source\s*Demo Song/);
    expect(currentChord).not.toHaveTextContent("art_source");

    expect(screen.getByRole("heading", { name: "A guitar shapes" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "A open" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Next chord")).toHaveTextContent(/E/);
    expectInspectorToShow([/A2/, /String\s*5/, /Fret\s*0/, /Degree\s*1/]);
    expect(screen.queryByRole("heading", { name: "C guitar shapes" })).not.toBeInTheDocument();
  });

  it("uses an honest generic playback source label without a project display name", async () => {
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({
        project: makeFollowProject({ projectName: " " }),
      }),
    });

    const liveStatus = screen.getByRole("group", { name: "Live chord display status" });
    expect(within(liveStatus).getByText("Project playback")).toBeInTheDocument();

    const currentChord = screen.getByLabelText("Current chord");
    expect(currentChord).toHaveTextContent(/Playback source\s*Project playback/);
    expect(currentChord).not.toHaveTextContent("art_source");
  });

  it("arms live follow from the Chord Dictionary page and follows future playback sessions", async () => {
    const user = userEvent.setup();
    const view = renderChordDictionaryPlaybackHarness({
      entry: "/tools?tool=chord-dictionary",
      playback: makePlaybackValue({ project: null }),
    });

    await view.findHeading();
    await user.click(screen.getByRole("button", { name: "Live Follow" }));

    const viewToggle = screen.getByRole("group", { name: "Chord dictionary views" });
    expect(within(viewToggle).getByRole("button", { name: "Dictionary" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(viewToggle).getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("No matching project playback")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current chord")).not.toBeInTheDocument();

    view.rerenderWithPlayback(makePlaybackValue({ playbackTimeSeconds: 6 }));

    expect(await screen.findByLabelText("Current chord")).toHaveTextContent(/Display chord\s*A/);
    expect(screen.getByRole("heading", { name: "A guitar shapes" })).toBeInTheDocument();

    view.rerenderWithPlayback(
      makePlaybackValue({ isPlaying: false, playbackTimeSeconds: 6 }),
    );

    expect(screen.getByText("Playback paused")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current chord")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "C guitar shapes" })).toBeInTheDocument();

    view.rerenderWithPlayback(makePlaybackValue({ project: null }));

    expect(screen.getByText("No matching project playback")).toBeInTheDocument();
    expect(within(viewToggle).getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    view.rerenderWithPlayback(makePlaybackValue({ playbackTimeSeconds: 20 }));

    expect(await screen.findByLabelText("Current chord")).toHaveTextContent(/Display chord\s*E/);
    expect(screen.getByRole("heading", { name: "E guitar shapes" })).toBeInTheDocument();
  });

  it("does not show a stale current chord when followed playback is paused", async () => {
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({ isPlaying: false }),
    });

    const liveStatus = screen.getByRole("group", { name: "Live chord display status" });
    expect(within(liveStatus).getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Playback paused")).toBeInTheDocument();
    expect(screen.getByText(/No stale live chord is shown/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Current chord")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A guitar shapes" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "C guitar shapes" })).toBeInTheDocument();
    expectInspectorToShow([/C3/, /Degree\s*1/]);
  });

  it("keeps unsupported followed chords honest without guitar voicings", async () => {
    const unsupportedTimeline: ChordSegmentSchema[] = [
      {
        confidence: 0.62,
        end_seconds: 16,
        label: "H13",
        pitch_class: null,
        quality: null,
        start_seconds: 0,
      },
    ];
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({
        project: makeFollowProject({
          authoritativeSourceTimeline: unsupportedTimeline,
          displayedTimeline: unsupportedTimeline,
        }),
      }),
    });

    const liveStatus = screen.getByRole("group", { name: "Live chord display status" });
    expect(within(liveStatus).getByText("Unsupported")).toBeInTheDocument();
    expect(screen.getByText("Unsupported chord: H13")).toBeInTheDocument();
    expect(screen.getByText(/cannot be parsed by the chord dictionary/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Current guitar voicing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Note inspector")).not.toBeInTheDocument();
  });

  it("shows live follow as an honest waiting state without fake progression previews", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    await user.click(screen.getByRole("button", { name: "Live Follow" }));

    const viewToggle = screen.getByRole("group", { name: "Chord dictionary views" });
    expect(within(viewToggle).getByRole("button", { name: "Dictionary" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(viewToggle).getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const toolsScreen = within(getToolsScreen());
    const liveStatus = toolsScreen.getByRole("group", { name: "Live chord display status" });
    expect(within(liveStatus).getByText("Guitar")).toBeInTheDocument();
    expect(within(liveStatus).getByText("No Project")).toBeInTheDocument();
    expect(within(liveStatus).queryByRole("button", { name: "Guitar" })).not.toBeInTheDocument();
    expect(within(liveStatus).queryByRole("button", { name: "No Project" })).not.toBeInTheDocument();
    expect(
      toolsScreen.getAllByText(
        /waiting|unavailable|inactive|no project|select a project|open a project/i,
      ).length,
    ).toBeGreaterThan(0);
    expect(toolsScreen.queryByRole("dialog", { name: /C chord preview/i })).not.toBeInTheDocument();
    expect(toolsScreen.queryByLabelText(/Accordion C chord/i)).not.toBeInTheDocument();
    expect(toolsScreen.queryByText("Tonight is heavy on one side")).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: "C" })).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: "G/D" })).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: "Am/C" })).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: "F/C" })).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: "Accordion" })).not.toBeInTheDocument();
  });

  it("does not expose fake instrument, library, playback, or settings affordances", async () => {
    await renderChordDictionary();

    const toolsScreen = within(getToolsScreen());
    const instrumentStatus = toolsScreen.getByRole("group", { name: "Instrument status" });
    expect(within(instrumentStatus).getByText("Guitar")).toBeInTheDocument();
    expect(
      within(instrumentStatus).queryByRole("button", { name: "Guitar" }),
    ).not.toBeInTheDocument();
    expect(
      within(instrumentStatus).queryByRole("button", { name: "Piano" }),
    ).not.toBeInTheDocument();
    expect(
      within(instrumentStatus).queryByRole("button", { name: "Accordion" }),
    ).not.toBeInTheDocument();
    expect(
      within(instrumentStatus).queryByRole("button", { name: "Organ" }),
    ).not.toBeInTheDocument();
    expect(
      within(instrumentStatus).queryByRole("button", { name: /48\s+More/i }),
    ).not.toBeInTheDocument();
    expect(
      toolsScreen.queryByRole("button", { name: /Toggle project follow/i }),
    ).not.toBeInTheDocument();
    expect(
      toolsScreen.queryByRole("button", { name: /Preview playback active state/i }),
    ).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: /Saved shapes/i })).not.toBeInTheDocument();
    expect(toolsScreen.queryByTitle("Saved shapes")).not.toBeInTheDocument();
    expect(toolsScreen.queryByRole("button", { name: /Settings/i })).not.toBeInTheDocument();
    expect(toolsScreen.queryByTitle("Settings")).not.toBeInTheDocument();
    expect(toolsScreen.queryByText("Atlas")).not.toBeInTheDocument();
    expect(toolsScreen.queryByText(/Piano, accordion, organ/i)).not.toBeInTheDocument();
  });
});
