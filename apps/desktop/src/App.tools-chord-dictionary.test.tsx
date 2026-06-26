import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChordSegmentSchema } from "./lib/api";
import { renderApp, resetAppTestHarness } from "./test/appTestHarness";
import {
  AccordionCandidateList,
  ChordDictionaryPage,
} from "./features/tools/ChordDictionaryPage";
import { ChordDictionaryFollowArmProvider } from "./features/tools/chordDictionaryFollowArm";
import {
  buildChordDictionaryFollowProjectContext,
  type ChordDictionaryFollowProjectContext,
} from "./features/projects/chordDictionaryFollowContext";
import {
  CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY,
  writeGlobalChordDictionaryPreferredShape,
  writeProjectChordDictionaryPreferredShape,
  type ChordDictionaryPreferenceContext,
} from "./features/tools/chordDictionaryPreferences";
import {
  PlaybackContext,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./features/projects/playback-context";

const DICTIONARY_SHAPE_GROUP_NAME = "Global guitar shape preference choices";
const LIVE_SHAPE_GROUP_NAME = "Project guitar shape preference choices";

function getDictionaryInstrumentSelector() {
  const scopedSelector =
    screen.queryByRole("group", { name: "Instrument status" }) ??
    screen.queryByRole("group", { name: "Live instrument" });
  if (scopedSelector) {
    return scopedSelector as HTMLElement;
  }

  const instrumentGroups = screen.getAllByRole("group", { name: /instrument/i });
  const instrumentSelector = instrumentGroups.find(
    (group) =>
      within(group).queryByRole("button", { name: "Guitar" }) ||
      within(group).queryByRole("button", { name: "Accordion" }) ||
      within(group).queryByRole("button", { name: "Piano" }),
  );

  if (!instrumentSelector) {
    throw new Error("Expected a dictionary instrument selector with Guitar, Accordion, and Piano choices");
  }

  return instrumentSelector as HTMLElement;
}

function expectSelectedOrHighlighted(element: HTMLElement) {
  const className = String(element.className);
  const isSelected =
    element.getAttribute("aria-pressed") === "true" ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-current") === "true" ||
    element.getAttribute("data-selected") === "true" ||
    element.getAttribute("data-highlighted") === "true" ||
    className.includes("--active") ||
    className.includes("--selected") ||
    className.includes("is-active") ||
    className.includes("is-selected");

  expect(isSelected).toBe(true);
}

function getAccordionSurface(selectorRoot: HTMLElement, selectors: string) {
  const surface = selectorRoot.querySelector(selectors);
  if (!(surface instanceof HTMLElement)) {
    throw new Error(`Expected accordion surface matching ${selectors}`);
  }
  return surface;
}

function getSelectedAccordionButton(
  container: HTMLElement,
  name: RegExp | string,
): HTMLElement {
  const buttons = within(container).getAllByRole("button", { name });
  const selectedButton = buttons.find((button) => {
    const className = String(button.className);
    return (
      button.getAttribute("aria-pressed") === "true" ||
      button.getAttribute("aria-selected") === "true" ||
      button.getAttribute("data-selected") === "true" ||
      button.getAttribute("data-highlighted") === "true" ||
      className.includes("--active") ||
      className.includes("--selected") ||
      className.includes("is-active") ||
      className.includes("is-selected")
    );
  });

  if (!selectedButton) {
    throw new Error(`Expected selected accordion button named ${String(name)}`);
  }

  return selectedButton as HTMLElement;
}

function readNumericStyleVar(element: HTMLElement, name: string) {
  const rawValue = element.style.getPropertyValue(name);
  expect(rawValue).not.toBe("");
  const value = Number(rawValue);
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

function getAccordionKeyByMidi(keyboard: HTMLElement, midi: number, color: "black" | "white") {
  const key = keyboard.querySelector(`[data-midi="${midi}"][data-key-color="${color}"]`);
  if (!(key instanceof HTMLElement)) {
    throw new Error(`Expected ${color} accordion keyboard key for MIDI ${midi}`);
  }
  return key;
}

function getAccordionKeyboardMidiByColor(keyboard: HTMLElement, color: "black" | "white") {
  return [...keyboard.querySelectorAll<HTMLElement>(`[data-key-color="${color}"]`)].map(
    (key) => key.dataset.midi,
  );
}

function getAccordionActiveKeyboardMidi(keyboard: HTMLElement) {
  return [...keyboard.querySelectorAll<HTMLElement>(".accordion-keyboard__key--active-tone")]
    .map((key) => key.dataset.midi)
    .sort();
}

function getPianoKeyboard() {
  const keyboard = document.querySelector('[data-instrument="piano"][data-surface="piano-keyboard"]');
  if (!(keyboard instanceof HTMLElement)) {
    throw new Error("Expected piano keyboard surface");
  }
  return keyboard;
}

function getPianoKeyByMidi(keyboard: HTMLElement, midi: number, color: "black" | "white") {
  const key = keyboard.querySelector(`[data-midi="${midi}"][data-key-color="${color}"]`);
  if (!(key instanceof HTMLElement)) {
    throw new Error(`Expected ${color} piano key for MIDI ${midi}`);
  }
  return key;
}

function getPianoActiveKeyboardMidi(keyboard: HTMLElement) {
  return [...keyboard.querySelectorAll<HTMLElement>(".piano-keyboard__key--active-tone")]
    .map((key) => key.dataset.midi)
    .sort();
}

function getPianoKeyboardMidiByColor(keyboard: HTMLElement, color: "black" | "white") {
  return [...keyboard.querySelectorAll<HTMLElement>(`[data-key-color="${color}"]`)].map(
    (key) => key.dataset.midi,
  );
}

function expectAccordionInstrumentSelected() {
  const instrumentSelector = getDictionaryInstrumentSelector();
  const guitarButton = within(instrumentSelector).getByRole("button", { name: "Guitar" });
  const accordionButton = within(instrumentSelector).getByRole("button", { name: "Accordion" });
  const pianoButton = within(instrumentSelector).getByRole("button", { name: "Piano" });

  expect(guitarButton).toHaveAttribute("aria-pressed", "false");
  expect(guitarButton).toHaveAttribute("data-selected", "false");
  expect(guitarButton).not.toHaveClass("chord-instrument-button--active");
  expect(accordionButton).toHaveAttribute("aria-pressed", "true");
  expect(accordionButton).toHaveAttribute("data-selected", "true");
  expect(accordionButton).toHaveClass("chord-instrument-button--active");
  expect(pianoButton).toHaveAttribute("aria-pressed", "false");
  expect(pianoButton).toHaveAttribute("data-selected", "false");
}

function expectPianoInstrumentSelected() {
  const instrumentSelector = getDictionaryInstrumentSelector();
  const guitarButton = within(instrumentSelector).getByRole("button", { name: "Guitar" });
  const accordionButton = within(instrumentSelector).getByRole("button", { name: "Accordion" });
  const pianoButton = within(instrumentSelector).getByRole("button", { name: "Piano" });

  expect(guitarButton).toHaveAttribute("aria-pressed", "false");
  expect(guitarButton).toHaveAttribute("data-selected", "false");
  expect(guitarButton).not.toHaveClass("chord-instrument-button--active");
  expect(accordionButton).toHaveAttribute("aria-pressed", "false");
  expect(accordionButton).toHaveAttribute("data-selected", "false");
  expect(accordionButton).not.toHaveClass("chord-instrument-button--active");
  expect(pianoButton).toHaveAttribute("aria-pressed", "true");
  expect(pianoButton).toHaveAttribute("data-selected", "true");
  expect(pianoButton).toHaveClass("chord-instrument-button--active");
}

async function selectAccordionDictionary() {
  const user = userEvent.setup();
  await renderChordDictionary();

  const instrumentSelector = getDictionaryInstrumentSelector();
  expect(within(instrumentSelector).getByRole("button", { name: "Guitar" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const accordionButton = within(instrumentSelector).getByRole("button", {
    name: "Accordion",
  });
  await user.click(accordionButton);

  await waitFor(() =>
    expect(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Accordion" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  expectAccordionInstrumentSelected();
  return user;
}

async function selectPianoDictionary() {
  const user = userEvent.setup();
  await renderChordDictionary();

  const instrumentSelector = getDictionaryInstrumentSelector();
  expect(within(instrumentSelector).getByRole("button", { name: "Guitar" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await user.click(within(instrumentSelector).getByRole("button", { name: "Piano" }));

  await waitFor(() =>
    expect(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Piano" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  expectPianoInstrumentSelected();
  return user;
}

function renderChordDictionaryView() {
  const view = renderApp(["/tools?tool=chord-dictionary"]);
  return {
    ...view,
    findHeading: () => screen.findByRole("heading", { name: "Chord Dictionary" }),
  };
}

function renderChordDictionary() {
  return renderChordDictionaryView().findHeading();
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

const cTimeline: ChordSegmentSchema[] = [
  {
    confidence: 0.88,
    end_seconds: 16,
    label: "C",
    pitch_class: 0,
    quality: "major",
    start_seconds: 0,
  },
];

const fSharpTimeline: ChordSegmentSchema[] = [
  {
    confidence: 0.86,
    end_seconds: 16,
    label: "F#",
    pitch_class: 6,
    quality: "major",
    start_seconds: 0,
  },
];

const dTimeline: ChordSegmentSchema[] = [
  {
    confidence: 0.86,
    end_seconds: 16,
    label: "D",
    pitch_class: 2,
    quality: "major",
    start_seconds: 0,
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

function makeDictionaryShapePreferenceContext(
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

function makeLiveShapePreferenceContext(
  overrides: Partial<ChordDictionaryPreferenceContext> = {},
): ChordDictionaryPreferenceContext {
  return {
    capoFret: 0,
    chordLabel: "A",
    displayedKeyLabel: "A",
    instrumentId: "guitar",
    projectId: null,
    sourceKeyLabel: "G",
    transposeSemitones: 2,
    useCapoShapes: false,
    ...overrides,
  };
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
    unmount: view.unmount,
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

function getShapeChoiceButtons(groupName: string) {
  return within(screen.getByRole("group", { name: groupName })).getAllByRole("button");
}

function expectFirstShapeChoice(groupName: string, label: string) {
  const shapeButtons = getShapeChoiceButtons(groupName);
  expect(shapeButtons[0]).toHaveTextContent(label);
  expect(shapeButtons[0]).toHaveAttribute("aria-pressed", "true");
}

function expectFirstShapeCard(label: string) {
  const shapeLabels = Array.from(document.querySelectorAll(".chord-shape-card__label"));
  expect(shapeLabels[0]).toHaveTextContent(label);
}

function getStoredChordDictionaryPreferences() {
  return window.localStorage.getItem(CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY) ?? "";
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
    const instrumentSelector = getDictionaryInstrumentSelector();
    expect(within(instrumentSelector).getByRole("button", { name: "Guitar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(instrumentSelector).getByRole("button", { name: "Accordion" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(instrumentSelector).getByRole("button", { name: "Piano" }),
    ).toHaveAttribute("aria-pressed", "false");
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

  it("selects Accordion and renders C across left and right hand surfaces", async () => {
    await selectAccordionDictionary();

    expect(screen.getByRole("heading", { name: "C accordion positions" })).toBeInTheDocument();
    expect(screen.getByText("Region C")).toBeInTheDocument();

    const leftHand = screen.getByRole("group", { name: /Left hand/i });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    expect(
      Boolean(leftHand.compareDocumentPosition(rightHand) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    const stradellaBoard = getAccordionSurface(
      leftHand,
      '[data-surface="stradella"], [data-surface="button-board"], .accordion-stradella, .accordion-button-board, .stradella-board',
    );
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );

    expect(stradellaBoard).toBeInTheDocument();
    expect(keyboard).toBeInTheDocument();
    expect(keyboard).toHaveAttribute("data-orientation", "vertical");
    expect(keyboard).toHaveAttribute("data-layout", "piano-vertical");
    expect(keyboard).toHaveAttribute("data-black-offset", "true");
    const whiteKeyCount = Number(keyboard.style.getPropertyValue("--accordion-white-key-count"));
    expect(whiteKeyCount).toBeLessThanOrEqual(9);
    const whiteKeyLayer = getAccordionSurface(keyboard, ".accordion-keyboard__white-keys");
    const blackKeyLayer = getAccordionSurface(keyboard, ".accordion-keyboard__black-keys");
    expect(keyboard.children[0]).toBe(whiteKeyLayer);
    expect(keyboard.children[1]).toBe(blackKeyLayer);
    expect(whiteKeyLayer.querySelectorAll(".accordion-keyboard__key--white")).toHaveLength(whiteKeyCount);
    expect(blackKeyLayer.querySelectorAll(".accordion-keyboard__key--black").length).toBeGreaterThan(0);

    const blackKey = keyboard.querySelector(
      '[data-key-color="black"][data-key-position="black-overlay"]',
    );
    expect(blackKey).toBeInTheDocument();
    expect((blackKey as HTMLElement).style.getPropertyValue("--accordion-white-index")).not.toBe("");
    const blackKeys = [...blackKeyLayer.querySelectorAll<HTMLElement>('[data-key-color="black"]')];
    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual([
      "60",
      "62",
      "64",
      "65",
      "67",
      "69",
      "71",
      "72",
    ]);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual(["61", "63", "66", "68", "70"]);
    const cKey = getAccordionKeyByMidi(keyboard, 60, "white");
    const cSharpKey = getAccordionKeyByMidi(keyboard, 61, "black");
    const dKey = getAccordionKeyByMidi(keyboard, 62, "white");
    const dSharpKey = getAccordionKeyByMidi(keyboard, 63, "black");
    const eKey = getAccordionKeyByMidi(keyboard, 64, "white");
    const fKey = getAccordionKeyByMidi(keyboard, 65, "white");
    const fSharpKey = getAccordionKeyByMidi(keyboard, 66, "black");
    const gKey = getAccordionKeyByMidi(keyboard, 67, "white");
    const gSharpKey = getAccordionKeyByMidi(keyboard, 68, "black");
    const aKey = getAccordionKeyByMidi(keyboard, 69, "white");
    const aSharpKey = getAccordionKeyByMidi(keyboard, 70, "black");
    const bKey = getAccordionKeyByMidi(keyboard, 71, "white");
    const highCKey = getAccordionKeyByMidi(keyboard, 72, "white");
    expect(whiteKeyLayer).toContainElement(cKey);
    expect(whiteKeyLayer).toContainElement(dKey);
    expect(blackKeyLayer).toContainElement(cSharpKey);
    expect(cKey).toHaveClass("accordion-keyboard__key--white");
    expect(cSharpKey).toHaveClass("accordion-keyboard__key--black");
    expect(cKey.parentElement).toBe(whiteKeyLayer);
    expect(cSharpKey.parentElement).toBe(blackKeyLayer);
    const cWhiteIndex = readNumericStyleVar(cKey, "--accordion-white-index");
    const cSharpBoundaryIndex = readNumericStyleVar(cSharpKey, "--accordion-white-index");
    const dWhiteIndex = readNumericStyleVar(dKey, "--accordion-white-index");
    const eWhiteIndex = readNumericStyleVar(eKey, "--accordion-white-index");
    const fWhiteIndex = readNumericStyleVar(fKey, "--accordion-white-index");
    const gWhiteIndex = readNumericStyleVar(gKey, "--accordion-white-index");
    const aWhiteIndex = readNumericStyleVar(aKey, "--accordion-white-index");
    const bWhiteIndex = readNumericStyleVar(bKey, "--accordion-white-index");
    expect([
      cWhiteIndex,
      dWhiteIndex,
      eWhiteIndex,
      fWhiteIndex,
      gWhiteIndex,
      aWhiteIndex,
      bWhiteIndex,
      readNumericStyleVar(highCKey, "--accordion-white-index"),
    ]).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(cSharpBoundaryIndex).toBe(dWhiteIndex);
    expect(readNumericStyleVar(dSharpKey, "--accordion-white-index")).toBe(eWhiteIndex);
    expect(readNumericStyleVar(fSharpKey, "--accordion-white-index")).toBe(gWhiteIndex);
    expect(readNumericStyleVar(gSharpKey, "--accordion-white-index")).toBe(aWhiteIndex);
    expect(readNumericStyleVar(aSharpKey, "--accordion-white-index")).toBe(bWhiteIndex);
    const blackBoundaryIndices = blackKeys.map((key) =>
      readNumericStyleVar(key, "--accordion-white-index"),
    );
    expect(blackBoundaryIndices).toEqual([
      dWhiteIndex,
      eWhiteIndex,
      gWhiteIndex,
      aWhiteIndex,
      bWhiteIndex,
    ]);
    expect(blackBoundaryIndices).not.toContain(cWhiteIndex);
    expect(blackBoundaryIndices).not.toContain(fWhiteIndex);
    expect(
      keyboard.querySelector('[data-key-color="white"][data-key-position="white-surface-row"]'),
    ).toBeInTheDocument();
    expect(blackKeys.every((key) => key.dataset.keyPosition === "black-overlay")).toBe(true);

    expect(within(leftHand).getByText(/^C$/)).toBeInTheDocument();
    expect(within(leftHand).getByText(/^CM$/)).toBeInTheDocument();

    const selectedBass = getSelectedAccordionButton(
      leftHand,
      /(^C$|\bC bass\b|\bbass C\b)/i,
    );
    const selectedMajor = getSelectedAccordionButton(
      leftHand,
      /(^CM$|\bCM\b.*\bMaj(?:or)?\b|\bC maj(?:or)?\b|\bmaj(?:or)? C\b)/i,
    );
    const selectedRightKey = within(rightHand).getByRole("button", {
      name: /C4 degree 1 accordion keyboard key/i,
    });
    const eRightKey = within(rightHand).getByRole("button", {
      name: /E4 degree 3 accordion keyboard key/i,
    });
    const gRightKey = within(rightHand).getByRole("button", {
      name: /G4 degree 5 accordion keyboard key/i,
    });

    expectSelectedOrHighlighted(selectedBass);
    expectSelectedOrHighlighted(selectedMajor);
    expect(selectedBass).toHaveClass("accordion-stradella__button--bass");
    expect(selectedMajor).toHaveClass("accordion-stradella__button--major");
    const bassColumn = readNumericStyleVar(selectedBass, "--accordion-button-column");
    const bassRow = readNumericStyleVar(selectedBass, "--accordion-button-row");
    const majorColumn = readNumericStyleVar(selectedMajor, "--accordion-button-column");
    const majorRow = readNumericStyleVar(selectedMajor, "--accordion-button-row");
    expect(majorColumn).toBeLessThan(bassColumn);
    expect(majorRow).toBeGreaterThan(bassRow);
    expectSelectedOrHighlighted(selectedRightKey);
    expectSelectedOrHighlighted(eRightKey);
    expectSelectedOrHighlighted(gRightKey);
    const activeKeyboardMidi = [...keyboard.querySelectorAll(".accordion-keyboard__key--active-tone")]
      .map((key) => (key as HTMLElement).dataset.midi)
      .sort();
    expect(activeKeyboardMidi).toEqual(["60", "64", "67"]);
    expect([...blackKeyLayer.querySelectorAll(".accordion-keyboard__key--active-tone")]).toHaveLength(0);
    expect(selectedRightKey).toHaveTextContent("C4");
    expect(selectedRightKey).toHaveTextContent("1");
    expect(eRightKey).toHaveTextContent("E4");
    expect(eRightKey).toHaveTextContent("3");
    expect(gRightKey).toHaveTextContent("G4");
    expect(gRightKey).toHaveTextContent("5");
  });

  it("selects Piano and renders C major generated keys with octave labels", async () => {
    await selectPianoDictionary();

    expect(screen.getByRole("heading", { name: "C piano voicings" })).toBeInTheDocument();
    expect(screen.getByText("A0-C8 range")).toBeInTheDocument();
    expect(screen.getByText("Region C")).toBeInTheDocument();

    const keyboard = getPianoKeyboard();
    expect(keyboard).toHaveAttribute("data-layout", "compact-piano");
    expect(keyboard).toHaveAttribute("data-surface", "piano-keyboard");
    expect(Number(keyboard.style.getPropertyValue("--piano-white-key-count"))).toBe(15);
    expect(getPianoKeyboardMidiByColor(keyboard, "white")).toHaveLength(15);
    expect(getPianoKeyboardMidiByColor(keyboard, "black")).toHaveLength(10);
    expect(getPianoActiveKeyboardMidi(keyboard)).toEqual(["60", "64", "67"]);

    const cKey = getPianoKeyByMidi(keyboard, 60, "white");
    const eKey = getPianoKeyByMidi(keyboard, 64, "white");
    const gKey = getPianoKeyByMidi(keyboard, 67, "white");
    expect(cKey).toHaveTextContent("C4");
    expect(cKey).toHaveTextContent("1");
    expect(eKey).toHaveTextContent("E4");
    expect(eKey).toHaveTextContent("3");
    expect(gKey).toHaveTextContent("G4");
    expect(gKey).toHaveTextContent("5");
    expectSelectedOrHighlighted(cKey);
    expectSelectedOrHighlighted(eKey);
    expectSelectedOrHighlighted(gKey);

    expectInspectorToShow([
      /Pitch\s*C4|C4/,
      /Degree\s*1/,
      /Hand hint\s*Right hand area|Right hand area/,
      /not fingering/i,
    ]);
    expect(within(screen.getByLabelText("Note inspector")).queryByText(/^Finger$/i)).not.toBeInTheDocument();
  });

  it("switches Piano seventh-chord inversions without fake or empty key data", async () => {
    const user = await selectPianoDictionary();

    changeChordSearch("G7");

    await screen.findByRole("heading", { name: "G7 piano voicings" });
    const preferenceChoices = screen.getByRole("group", {
      name: "Global piano voicing preference choices",
    });
    const preferenceButtons = within(preferenceChoices).getAllByRole("button");
    expect(preferenceButtons.map((button) => button.textContent)).toEqual([
      "G7 root position",
      "G7 first inversion",
      "G7 second inversion",
      "G7 third inversion",
    ]);
    expect(preferenceButtons[0]).toHaveAttribute("aria-pressed", "true");

    let keyboard = getPianoKeyboard();
    expect(getPianoActiveKeyboardMidi(keyboard)).toEqual(["55", "59", "62", "65"]);
    expect(getPianoKeyByMidi(keyboard, 55, "white")).toHaveTextContent("G3");
    expect(getPianoKeyByMidi(keyboard, 59, "white")).toHaveTextContent("B3");
    expect(getPianoKeyByMidi(keyboard, 62, "white")).toHaveTextContent("D4");
    expect(getPianoKeyByMidi(keyboard, 65, "white")).toHaveTextContent("F4");
    expect(screen.getByText("Chord tones")).toBeInTheDocument();
    const voicingOrder = screen.getByLabelText("Current piano voicing order");
    expect(within(voicingOrder).getByText("Voicing order")).toBeInTheDocument();
    const voicingOrderItems = within(voicingOrder).getAllByRole("listitem");
    expect(voicingOrderItems.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "G3",
      "B3",
      "D4",
      "F4",
    ]);
    expect(voicingOrderItems.map((item) => item.querySelector("small")?.textContent)).toEqual([
      "1",
      "3",
      "5",
      "b7",
    ]);
    expect(screen.queryByText(/Piano unavailable|No piano keyboard|returned no voicings/i)).not.toBeInTheDocument();

    await user.click(within(preferenceChoices).getByRole("button", { name: "G7 first inversion" }));

    await waitFor(() =>
      expect(within(preferenceChoices).getByRole("button", { name: "G7 first inversion" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    keyboard = getPianoKeyboard();
    expect(getPianoActiveKeyboardMidi(keyboard)).toEqual(["59", "62", "65", "67"]);
    expect(getPianoKeyByMidi(keyboard, 59, "white")).toHaveTextContent("B3");
    expect(getPianoKeyByMidi(keyboard, 62, "white")).toHaveTextContent("D4");
    expect(getPianoKeyByMidi(keyboard, 65, "white")).toHaveTextContent("F4");
    expect(getPianoKeyByMidi(keyboard, 67, "white")).toHaveTextContent("G4");
  });

  it.each([
    {
      active: ["62", "66", "69"],
      black: ["61", "63", "66", "68", "70", "73", "75"],
      heading: "D accordion positions",
      search: "D",
      white: ["60", "62", "64", "65", "67", "69", "71", "72", "74", "76"],
    },
    {
      active: ["63", "67", "70"],
      black: ["61", "63", "66", "68", "70", "73", "75"],
      heading: "Eb accordion positions",
      search: "Eb",
      white: ["60", "62", "64", "65", "67", "69", "71", "72", "74", "76"],
    },
    {
      active: ["67", "71", "74"],
      black: ["66", "68", "70", "73", "75", "78"],
      heading: "G accordion positions",
      search: "G",
      white: ["65", "67", "69", "71", "72", "74", "76", "77", "79"],
    },
    {
      active: ["69", "73", "76"],
      black: ["66", "68", "70", "73", "75", "78", "80", "82"],
      heading: "A accordion positions",
      search: "A",
      white: ["65", "67", "69", "71", "72", "74", "76", "77", "79", "81", "83"],
    },
    {
      active: ["68", "72", "75"],
      black: ["66", "68", "70", "73", "75", "78", "80"],
      heading: "Ab accordion positions",
      search: "Ab",
      white: ["65", "67", "69", "71", "72", "74", "76", "77", "79", "81"],
    },
    {
      active: ["70", "74", "77"],
      black: ["66", "68", "70", "73", "75", "78", "80", "82"],
      heading: "Bb accordion positions",
      search: "Bb",
      white: ["65", "67", "69", "71", "72", "74", "76", "77", "79", "81", "83"],
    },
    {
      active: ["71", "75", "78"],
      black: ["66", "68", "70", "73", "75", "78", "80", "82"],
      heading: "B accordion positions",
      search: "B",
      white: ["65", "67", "69", "71", "72", "74", "76", "77", "79", "81", "83"],
    },
  ])("keeps $search accordion keyboard context on piano landmarks", async ({
    active,
    black,
    heading,
    search,
    white,
  }) => {
    await selectAccordionDictionary();

    changeChordSearch(search);

    await screen.findByRole("heading", { name: heading });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );

    expect(keyboard).toHaveAttribute("data-orientation", "vertical");
    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual(white);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual(black);
    expect(getAccordionActiveKeyboardMidi(keyboard)).toEqual(active);
  });

  it("keeps G accordion keyboard anchored with one octave of context", async () => {
    await selectAccordionDictionary();

    changeChordSearch("G");

    await screen.findByRole("heading", { name: "G accordion positions" });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const blackKeyLayer = getAccordionSurface(keyboard, ".accordion-keyboard__black-keys");
    const activeKeyboardMidi = [...keyboard.querySelectorAll(".accordion-keyboard__key--active-tone")]
      .map((key) => (key as HTMLElement).dataset.midi)
      .sort();

    expect(keyboard).toHaveAttribute("data-orientation", "vertical");
    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual([
      "65",
      "67",
      "69",
      "71",
      "72",
      "74",
      "76",
      "77",
      "79",
    ]);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual(["66", "68", "70", "73", "75", "78"]);
    expect(activeKeyboardMidi).toEqual(["67", "71", "74"]);
    expect([...blackKeyLayer.querySelectorAll(".accordion-keyboard__key--active-tone")]).toHaveLength(0);
    expect(getAccordionKeyByMidi(keyboard, 65, "white")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 66, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 68, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 73, "black")).toHaveAttribute("aria-hidden", "true");
    expect(within(rightHand).getByRole("button", {
      name: /G4 degree 1 accordion keyboard key/i,
    })).toHaveTextContent("G4");
  });

  it("keeps G7 accordion keyboard context with F and F# before the root", async () => {
    await selectAccordionDictionary();

    changeChordSearch("G7");

    await screen.findByRole("heading", { name: "G7 accordion positions" });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const activeKeyboardMidi = [...keyboard.querySelectorAll(".accordion-keyboard__key--active-tone")]
      .map((key) => (key as HTMLElement).dataset.midi)
      .sort();
    const lowerFKey = getAccordionKeyByMidi(keyboard, 65, "white");
    const lowerFSharpKey = getAccordionKeyByMidi(keyboard, 66, "black");
    const rootGKey = getAccordionKeyByMidi(keyboard, 67, "white");

    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual([
      "65",
      "67",
      "69",
      "71",
      "72",
      "74",
      "76",
      "77",
      "79",
    ]);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual(["66", "68", "70", "73", "75", "78"]);
    expect(activeKeyboardMidi).toEqual(["67", "71", "74", "77"]);
    expect(lowerFKey).toHaveAttribute("aria-hidden", "true");
    expect(lowerFSharpKey).toHaveAttribute("aria-hidden", "true");
    expect(readNumericStyleVar(lowerFKey, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(rootGKey, "--accordion-white-index"),
    );
    expect(readNumericStyleVar(lowerFSharpKey, "--accordion-white-index")).toBe(
      readNumericStyleVar(rootGKey, "--accordion-white-index"),
    );
  });

  it("keeps G#/Ab accordion keyboard context anchored to the lower three-black-key group", async () => {
    await selectAccordionDictionary();

    changeChordSearch("Ab");

    await screen.findByRole("heading", { name: "Ab accordion positions" });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const activeKeyboardMidi = [...keyboard.querySelectorAll(".accordion-keyboard__key--active-tone")]
      .map((key) => (key as HTMLElement).dataset.midi)
      .sort();

    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual([
      "65",
      "67",
      "69",
      "71",
      "72",
      "74",
      "76",
      "77",
      "79",
      "81",
    ]);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual(["66", "68", "70", "73", "75", "78", "80"]);
    expect(activeKeyboardMidi).toEqual(["68", "72", "75"]);
    expect(getAccordionKeyByMidi(keyboard, 65, "white")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 66, "black")).toHaveAttribute("aria-hidden", "true");
    expectSelectedOrHighlighted(getAccordionKeyByMidi(keyboard, 68, "black"));
    expect(getAccordionKeyByMidi(keyboard, 70, "black")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps A#/Bb accordion keyboard context with lower and upper three-black-key groups", async () => {
    await selectAccordionDictionary();

    changeChordSearch("Bb");

    await screen.findByRole("heading", { name: "Bb accordion positions" });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const activeKeyboardMidi = [...keyboard.querySelectorAll(".accordion-keyboard__key--active-tone")]
      .map((key) => (key as HTMLElement).dataset.midi)
      .sort();

    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual([
      "65",
      "67",
      "69",
      "71",
      "72",
      "74",
      "76",
      "77",
      "79",
      "81",
      "83",
    ]);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual([
      "66",
      "68",
      "70",
      "73",
      "75",
      "78",
      "80",
      "82",
    ]);
    expect(activeKeyboardMidi).toEqual(["70", "74", "77"]);
    expect(getAccordionKeyByMidi(keyboard, 66, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 68, "black")).toHaveAttribute("aria-hidden", "true");
    expectSelectedOrHighlighted(getAccordionKeyByMidi(keyboard, 70, "black"));
    expect(getAccordionKeyByMidi(keyboard, 78, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 80, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 82, "black")).toHaveAttribute("aria-hidden", "true");
  });

  it("centers Dictionary accordion on non-C roots and shows active black-key labels", async () => {
    await selectAccordionDictionary();

    changeChordSearch("F#");

    await screen.findByRole("heading", { name: "F# accordion positions" });
    expect(screen.getByText("Region F#")).toBeInTheDocument();

    const leftHand = screen.getByRole("group", { name: /Left hand/i });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const blackKeyLayer = getAccordionSurface(keyboard, ".accordion-keyboard__black-keys");
    const selectedBass = getSelectedAccordionButton(leftHand, /(^F#$|\bF# bass\b)/i);
    const selectedMajor = getSelectedAccordionButton(leftHand, /(^F#M$|\bF#M\b)/i);
    const rootBlackKey = within(rightHand).getByRole("button", {
      name: /F#\d degree 1 accordion keyboard key/i,
    });
    const activeBlackKeys = [
      ...blackKeyLayer.querySelectorAll<HTMLElement>(".accordion-keyboard__key--active-tone"),
    ];

    expect(screen.queryByText(/Capo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Transpose/i)).not.toBeInTheDocument();
    expectSelectedOrHighlighted(selectedBass);
    expectSelectedOrHighlighted(selectedMajor);
    expect(blackKeyLayer).toContainElement(rootBlackKey);
    expect(rootBlackKey).toHaveAttribute("data-key-color", "black");
    expect(rootBlackKey).toHaveClass("accordion-keyboard__key--black");
    expect(rootBlackKey).toHaveClass("accordion-keyboard__key--active-tone");
    expect(rootBlackKey).not.toHaveAttribute("aria-hidden");
    expect(rootBlackKey.querySelector("strong")).toHaveTextContent(/^F#\d$/);
    expect(rootBlackKey.querySelector("span")).toHaveTextContent("1");
    expect(activeBlackKeys.length).toBeGreaterThan(0);
    expect(activeBlackKeys.map((key) => key.textContent).join(" ")).toMatch(/F#\d/);
  });

  it("renders B root bottom-up on the vertical accordion keyboard", async () => {
    const user = await selectAccordionDictionary();

    changeChordSearch("B");

    await screen.findByRole("heading", { name: "B accordion positions" });
    const preferenceChoices = screen.getByRole("group", {
      name: "Global accordion right-hand preference choices",
    });
    const preferenceButtons = within(preferenceChoices);
    await user.click(preferenceButtons.getByRole("button", { name: "B root" }));

    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const bKey = getAccordionKeyByMidi(keyboard, 71, "white");
    const dSharpKey = getAccordionKeyByMidi(keyboard, 75, "black");
    const fSharpKey = getAccordionKeyByMidi(keyboard, 78, "black");
    const activeKeyboardMidi = [...keyboard.querySelectorAll(".accordion-keyboard__key--active-tone")]
      .map((key) => (key as HTMLElement).dataset.midi)
      .sort();

    expect(keyboard).toHaveAttribute("data-orientation", "vertical");
    expect(getAccordionKeyboardMidiByColor(keyboard, "white")).toEqual([
      "65",
      "67",
      "69",
      "71",
      "72",
      "74",
      "76",
      "77",
      "79",
      "81",
      "83",
    ]);
    expect(getAccordionKeyboardMidiByColor(keyboard, "black")).toEqual([
      "66",
      "68",
      "70",
      "73",
      "75",
      "78",
      "80",
      "82",
    ]);
    expect(activeKeyboardMidi).toEqual(["71", "75", "78"]);
    expect(getAccordionKeyByMidi(keyboard, 66, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 68, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 70, "black")).toHaveAttribute("aria-hidden", "true");
    expectSelectedOrHighlighted(getAccordionKeyByMidi(keyboard, 78, "black"));
    expect(getAccordionKeyByMidi(keyboard, 80, "black")).toHaveAttribute("aria-hidden", "true");
    expect(getAccordionKeyByMidi(keyboard, 82, "black")).toHaveAttribute("aria-hidden", "true");
    expectSelectedOrHighlighted(bKey);
    expectSelectedOrHighlighted(dSharpKey);
    expectSelectedOrHighlighted(fSharpKey);
    expect(readNumericStyleVar(bKey, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(dSharpKey, "--accordion-white-index"),
    );
    expect(readNumericStyleVar(dSharpKey, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(fSharpKey, "--accordion-white-index"),
    );
    expect(within(rightHand).getByRole("button", {
      name: /B4 degree 1 accordion keyboard key/i,
    })).toHaveTextContent("B4");

    await user.click(preferenceButtons.getByRole("button", { name: "B first inversion" }));
    const firstInversionBass = getAccordionKeyByMidi(keyboard, 75, "black");
    const firstInversionFifth = getAccordionKeyByMidi(keyboard, 78, "black");
    const firstInversionRoot = getAccordionKeyByMidi(keyboard, 83, "white");
    expect(readNumericStyleVar(firstInversionBass, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(firstInversionFifth, "--accordion-white-index"),
    );
    expect(readNumericStyleVar(firstInversionFifth, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(firstInversionRoot, "--accordion-white-index"),
    );

    await user.click(preferenceButtons.getByRole("button", { name: "B second inversion" }));
    const secondInversionBass = getAccordionKeyByMidi(keyboard, 78, "black");
    const secondInversionRoot = getAccordionKeyByMidi(keyboard, 83, "white");
    const secondInversionThird = getAccordionKeyByMidi(keyboard, 87, "black");
    expect(readNumericStyleVar(secondInversionBass, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(secondInversionRoot, "--accordion-white-index"),
    );
    expect(readNumericStyleVar(secondInversionRoot, "--accordion-white-index")).toBeGreaterThan(
      readNumericStyleVar(secondInversionThird, "--accordion-white-index"),
    );
  });

  it("selects root bass and same-root seventh buttons for accordion dominant sevenths", async () => {
    await selectAccordionDictionary();

    changeChordSearch("C7");

    await screen.findByRole("heading", { name: "C7 accordion positions" });
    let leftHand = screen.getByRole("group", { name: /Left hand/i });
    expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^C$|\bC bass\b)/i));
    expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^C7$|\bC7\b)/i));
    expect(screen.getByLabelText("Accordion left-hand candidates")).toHaveTextContent(
      /C bass \+ C7\(no5\)[\s\S]*Missing:\s*G/i,
    );

    changeChordSearch("B7");

    await screen.findByRole("heading", { name: "B7 accordion positions" });
    leftHand = screen.getByRole("group", { name: /Left hand/i });
    expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^B$|\bB bass\b)/i));
    expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^B7$|\bB7\b)/i));
    expect(screen.getByLabelText("Accordion left-hand candidates")).toHaveTextContent(
      /B bass \+ B7\(no5\)[\s\S]*Missing:\s*F#/i,
    );
  });

  it("keeps accordion seventh and diminished row ids through DOM classes", async () => {
    await selectAccordionDictionary();

    changeChordSearch("C7");

    await screen.findByRole("heading", { name: "C7 accordion positions" });
    let leftHand = screen.getByRole("group", { name: /Left hand/i });
    const seventhButtons = within(leftHand).getAllByRole("button", {
      name: "C7 7 accordion button",
    });
    const seventhButton = seventhButtons[0] as HTMLElement;
    expect(seventhButton).toHaveAttribute("data-row", "seventh");
    expect(seventhButton).toHaveClass("accordion-stradella__button--seventh");
    expect(seventhButton).not.toHaveClass("accordion-stradella__button--dominant7");
    expect(seventhButton).not.toHaveClass("accordion-stradella__button--diminished");

    changeChordSearch("Cdim");

    await screen.findByRole("heading", { name: "Cdim accordion positions" });
    leftHand = screen.getByRole("group", { name: /Left hand/i });
    const diminishedButtons = within(leftHand).getAllByRole("button", {
      name: "Cdim Dim accordion button",
    });
    const diminishedButton = diminishedButtons[0] as HTMLElement;
    expect(diminishedButton).toHaveAttribute("data-row", "diminished");
    expect(diminishedButton).toHaveClass("accordion-stradella__button--diminished");
    expect(diminishedButton).not.toHaveClass("accordion-stradella__button--seventh");

    let candidatePanel = screen.getByLabelText("Accordion left-hand candidates");
    expect(candidatePanel).toHaveTextContent(/C bass \+ Cdim \(Ebdim7\(no5\) button\)/i);

    changeChordSearch("Cdim7");

    await screen.findByRole("heading", { name: "Cdim7 accordion positions" });
    candidatePanel = screen.getByLabelText("Accordion left-hand candidates");
    expect(candidatePanel).toHaveTextContent(/C bass \+ Cdim7 \(Gbdim7\(no5\) button\)/i);
  });

  it("renders real accordion diff labels only for approximate candidates", async () => {
    await selectAccordionDictionary();

    expect(screen.queryByText(/Missing:\s*None/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Added:\s*None/i)).not.toBeInTheDocument();

    changeChordSearch("C7b5");

    await screen.findByRole("heading", { name: "C7b5 accordion positions" });
    expect(screen.queryByLabelText("Accordion approximation differences")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Accordion left-hand candidates")).toHaveTextContent(
      /C bass \+ C7[\s\S]*Missing:\s*Gb/i,
    );

    changeChordSearch("Csus4");

    await screen.findByRole("heading", { name: "Csus4 accordion positions" });
    const susApproximationDiff = await screen.findByLabelText(
      "Accordion approximation differences",
    );
    expect(susApproximationDiff).not.toHaveTextContent(/Missing:/i);
    expect(susApproximationDiff).toHaveTextContent(/Added:\s*(?!None\b).+/i);
    const fMinorSusCandidate = screen
      .getAllByRole("button", { name: /F bass \+ Cm/i })
      .find((candidate) => candidate.textContent?.includes("Added: Eb"));
    expect(fMinorSusCandidate).toBeDefined();
    expect(fMinorSusCandidate as HTMLElement).not.toHaveTextContent(/Missing:/i);
    expect(fMinorSusCandidate as HTMLElement).toHaveTextContent(/Added:\s*Eb/i);
    expect(fMinorSusCandidate as HTMLElement).not.toHaveTextContent(/Added:\s*E(?:,|\b)/i);
    expect(screen.queryByText(/Missing:\s*None/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Added:\s*None/i)).not.toBeInTheDocument();
  });

  it("renders accordion candidate added tones verbatim without inferred sus4 thirds", () => {
    render(
      <AccordionCandidateList
        candidates={[
          {
            addedTones: ["Eb"],
            buttons: [],
            buttonIds: [],
            detail: "C bass + Cm row",
            fingering: null,
            id: "c-sus-minor",
            isExact: false,
            label: "C bass + Cm",
            missingTones: ["F"],
            rank: 1,
          },
        ]}
        selectedCandidateId="c-sus-minor"
        onSelectCandidate={vi.fn()}
      />,
    );

    const candidate = screen.getByRole("button", { name: /C bass \+ Cm/i });
    expect(candidate).toHaveTextContent(/Missing:\s*F/i);
    expect(candidate).toHaveTextContent(/Added:\s*Eb/i);
    expect(candidate).not.toHaveTextContent(/Added:\s*E(?:,|\b)/i);

    const selectedDiff = screen.getByLabelText("Accordion approximation differences");
    expect(selectedDiff).toHaveTextContent(/Missing:\s*F/i);
    expect(selectedDiff).toHaveTextContent(/Added:\s*Eb/i);
    expect(selectedDiff).not.toHaveTextContent(/Added:\s*E(?:,|\b)/i);
  });

  it("deduplicates repeated visible left-hand candidate cards", async () => {
    const user = await selectAccordionDictionary();
    changeChordSearch("C7b5");

    await screen.findByRole("heading", { name: "C7b5 accordion positions" });
    const candidatePanel = screen.getByLabelText("Accordion left-hand candidates");
    const cSevenCandidates = within(candidatePanel).getAllByRole("button", {
      name: /C bass \+ C7/i,
    });
    expect(cSevenCandidates).toHaveLength(1);
    await user.click(cSevenCandidates[0] as HTMLElement);

    const leftHand = screen.getByRole("group", { name: /Left hand/i });
    await waitFor(() => {
      expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^C$|\bC bass\b)/i));
      expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^C7$|\bC7\b)/i));
      expectInspectorToShow([/Hand\s*Left|Left hand/i, /Surface\s*Stradella|Stradella/i]);
    });
  });

  it("updates the accordion note inspector from left buttons and right keys", async () => {
    const user = await selectAccordionDictionary();

    const leftHand = screen.getByRole("group", { name: /Left hand/i });
    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const leftCButton = getSelectedAccordionButton(leftHand, /(^C$|\bC bass\b|\bbass C\b)/i);

    await user.click(leftCButton);

    await waitFor(() =>
      expectInspectorToShow([
        /C\d|Pitch\s*C/i,
        /Hand\s*Left|Left hand/i,
        /Side\s*(Left|Bass)|Bass side|Stradella/i,
        /Surface\s*(Stradella|Button board|button-board)|Button board|button-board/i,
        /Degree\s*1/i,
      ]),
    );

    const rightCKey = getSelectedAccordionButton(rightHand, /\bC(4|5)?\b/i);
    await user.click(rightCKey);

    await waitFor(() =>
      expectInspectorToShow([
        /C\d|Pitch\s*C/i,
        /Hand\s*Right|Right hand/i,
        /Surface\s*Keyboard|Keyboard/i,
        /Degree\s*1/i,
      ]),
    );
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

    const shapeChoices = within(screen.getByRole("group", { name: DICTIONARY_SHAPE_GROUP_NAME }));
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
      screen.getByRole("group", { name: DICTIONARY_SHAPE_GROUP_NAME }),
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

  it("persists a dictionary shape choice globally and promotes it when reopened", async () => {
    const user = userEvent.setup();
    const view = renderChordDictionaryView();
    await view.findHeading();

    expect(
      screen.getByText("Saves locally as global for this chord and instrument."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear this chord/instrument global preference" }),
    ).not.toBeInTheDocument();

    const shapeChoices = within(screen.getByRole("group", { name: DICTIONARY_SHAPE_GROUP_NAME }));
    await user.click(shapeChoices.getByRole("button", { name: "C E-shape barre" }));

    await waitFor(() => expectFirstShapeChoice(DICTIONARY_SHAPE_GROUP_NAME, "C E-shape barre"));
    expect(
      screen.getByRole("button", { name: "Clear this chord/instrument global preference" }),
    ).toBeInTheDocument();
    expectFirstShapeCard("C E-shape barre");
    expect(getStoredChordDictionaryPreferences()).toContain("c-e-shape-barre");

    view.unmount();
    const reopenedView = renderChordDictionaryView();
    await reopenedView.findHeading();

    await waitFor(() => expectFirstShapeChoice(DICTIONARY_SHAPE_GROUP_NAME, "C E-shape barre"));
    expectFirstShapeCard("C E-shape barre");
  });

  it("hides dictionary reset when the saved global shape is unavailable", async () => {
    writeGlobalChordDictionaryPreferredShape(
      makeDictionaryShapePreferenceContext(),
      "missing-c-shape",
    );

    await renderChordDictionary();

    await waitFor(() => expectFirstShapeChoice(DICTIONARY_SHAPE_GROUP_NAME, "C open"));
    expectFirstShapeCard("C open");
    expect(
      screen.queryByRole("button", { name: "Clear this chord/instrument global preference" }),
    ).not.toBeInTheDocument();
    expect(getStoredChordDictionaryPreferences()).toContain("missing-c-shape");
  });

  it("resets the dictionary global shape choice to the generated C default", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const shapeChoices = within(screen.getByRole("group", { name: DICTIONARY_SHAPE_GROUP_NAME }));
    await user.click(shapeChoices.getByRole("button", { name: "C E-shape barre" }));
    await waitFor(() => expectFirstShapeChoice(DICTIONARY_SHAPE_GROUP_NAME, "C E-shape barre"));

    await user.click(
      screen.getByRole("button", { name: "Clear this chord/instrument global preference" }),
    );

    await waitFor(() => expectFirstShapeChoice(DICTIONARY_SHAPE_GROUP_NAME, "C open"));
    expectFirstShapeCard("C open");
    expect(
      screen.queryByRole("button", { name: "Clear this chord/instrument global preference" }),
    ).not.toBeInTheDocument();
    expect(getStoredChordDictionaryPreferences()).not.toContain("c-e-shape-barre");
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

  it("renders accordion positions from Live Follow project chord context", async () => {
    const user = userEvent.setup();
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({
        project: makeFollowProject({
          authoritativeSourceTimeline: cTimeline,
          displayedKey: { pitchClass: 0, mode: "major" },
          displayedTimeline: cTimeline,
          sourceKey: { pitchClass: 0, mode: "major" },
          totalDisplayTransposeSemitones: 0,
        }),
      }),
    });

    await user.click(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Accordion" }));

    await waitFor(() =>
      expect(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Accordion" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expectAccordionInstrumentSelected();

    const currentChord = screen.getByLabelText("Current chord");
    expect(currentChord).toHaveTextContent(/Source chord\s*C/);
    expect(currentChord).toHaveTextContent(/Display chord\s*C/);
    expect(screen.getByRole("heading", { name: "C accordion positions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Left hand/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Right hand/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "C guitar shapes" })).not.toBeInTheDocument();
  });

  it("renders piano voicings from Live Follow project chord context", async () => {
    const user = userEvent.setup();
    await renderChordDictionaryWithPlayback();

    await user.click(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Piano" }));

    await waitFor(() =>
      expect(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Piano" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expectPianoInstrumentSelected();

    const currentChord = screen.getByLabelText("Current chord");
    expect(currentChord).toHaveTextContent(/Source chord\s*G/);
    expect(currentChord).toHaveTextContent(/Display chord\s*A/);
    expect(currentChord).toHaveTextContent(/Detected\/imported project chords/);
    expect(currentChord).toHaveTextContent(/Playback source\s*Demo Song/);
    expect(screen.getByRole("heading", { name: "A piano voicings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Next chord")).toHaveTextContent(/E/);
    expect(screen.getByText("Region A")).toBeInTheDocument();

    const keyboard = getPianoKeyboard();
    expect(getPianoActiveKeyboardMidi(keyboard)).toEqual(["57", "61", "64"]);
    expect(getPianoKeyByMidi(keyboard, 57, "white")).toHaveTextContent("A3");
    expect(getPianoKeyByMidi(keyboard, 61, "black")).toHaveTextContent("C#4");
    expect(getPianoKeyByMidi(keyboard, 64, "white")).toHaveTextContent("E4");
    expectInspectorToShow([/A3/, /Degree\s*1/, /Left hand area/, /not fingering/i]);
    expect(screen.queryByRole("heading", { name: "A guitar shapes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Left hand/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Right hand/i })).not.toBeInTheDocument();
    expect(document.querySelector(".guitar-fretboard")).not.toBeInTheDocument();
    expect(document.querySelector(".accordion-keyboard")).not.toBeInTheDocument();
    expect(document.querySelector(".accordion-stradella")).not.toBeInTheDocument();
  });

  it("renders out-of-window accordion roots in Live Follow without moving the key region", async () => {
    const user = userEvent.setup();
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({
        project: makeFollowProject({
          authoritativeSourceTimeline: fSharpTimeline,
          displayedKey: { pitchClass: 0, mode: "major" },
          displayedTimeline: fSharpTimeline,
          sourceKey: { pitchClass: 0, mode: "major" },
          totalDisplayTransposeSemitones: 0,
        }),
      }),
    });

    await user.click(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Accordion" }));

    await waitFor(() =>
      expect(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Accordion" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expectAccordionInstrumentSelected();

    expect(screen.getByLabelText("Current chord")).toHaveTextContent(/Display chord\s*F#/);
    expect(screen.getByText("Region C")).toBeInTheDocument();
    const leftHand = screen.getByRole("group", { name: /Left hand/i });
    expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^F#$|\bF# bass\b)/i));
    expectSelectedOrHighlighted(getSelectedAccordionButton(leftHand, /(^F#M$|\bF#M\b)/i));
  });

  it("uses a Dictionary global C shape preference for Live Follow when the project has no pick", async () => {
    writeGlobalChordDictionaryPreferredShape(
      makeDictionaryShapePreferenceContext({ chordLabel: "C" }),
      "c-e-shape-barre",
    );

    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({
        project: makeFollowProject({
          authoritativeSourceTimeline: cTimeline,
          displayedKey: { pitchClass: 0, mode: "major" },
          displayedTimeline: cTimeline,
          sourceKey: { pitchClass: 0, mode: "major" },
          totalDisplayTransposeSemitones: 0,
        }),
      }),
    });

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "C E-shape barre"));
    expect(
      screen.getByText(
        "Saves locally for this project chord and instrument; clear uses global/default.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Clear this project override and fall back to global or default",
      }),
    ).not.toBeInTheDocument();
    expectFirstShapeCard("C E-shape barre");
    expectInspectorToShow([/C3/, /String\s*6/, /Fret\s*8/, /Degree\s*1/]);
  });

  it("keeps transposed displayed D separate from a global C shape preference", async () => {
    writeGlobalChordDictionaryPreferredShape(
      makeDictionaryShapePreferenceContext({ chordLabel: "C" }),
      "c-e-shape-barre",
    );

    const dProject = makeFollowProject({
      authoritativeSourceTimeline: cTimeline,
      displayedKey: { pitchClass: 2, mode: "major" },
      displayedTimeline: dTimeline,
      sourceKey: { pitchClass: 0, mode: "major" },
      totalDisplayTransposeSemitones: 2,
    });
    const view = renderChordDictionaryPlaybackHarness({
      playback: makePlaybackValue({ project: dProject }),
    });
    await view.findHeading();

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "D open"));
    expectFirstShapeCard("D open");

    view.unmount();
    writeGlobalChordDictionaryPreferredShape(
      makeDictionaryShapePreferenceContext({ chordLabel: "D" }),
      "d-a-shape-barre",
    );

    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({ project: dProject }),
    });

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "D A-shape barre"));
    expectFirstShapeCard("D A-shape barre");
  });

  it("hides Live Follow reset when the saved project shape is unavailable", async () => {
    writeProjectChordDictionaryPreferredShape(
      makeLiveShapePreferenceContext({ projectId: "proj_123" }),
      "missing-a-shape",
    );

    await renderChordDictionaryWithPlayback();

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "A open"));
    expectFirstShapeCard("A open");
    expect(
      screen.queryByRole("button", {
        name: "Clear this project override and fall back to global or default",
      }),
    ).not.toBeInTheDocument();
    expect(getStoredChordDictionaryPreferences()).toContain("missing-a-shape");
  });

  it("stores a Live Follow project override and restores it for the same project", async () => {
    const user = userEvent.setup();
    const view = renderChordDictionaryPlaybackHarness();
    await view.findHeading();

    const shapeChoices = within(screen.getByRole("group", { name: LIVE_SHAPE_GROUP_NAME }));
    await user.click(shapeChoices.getByRole("button", { name: "A D-shape barre" }));

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "A D-shape barre"));
    expect(
      screen.getByRole("button", {
        name: "Clear this project override and fall back to global or default",
      }),
    ).toBeInTheDocument();
    expectFirstShapeCard("A D-shape barre");
    expect(getStoredChordDictionaryPreferences()).toContain("proj_123");
    expect(getStoredChordDictionaryPreferences()).toContain("a-d-shape-barre");

    view.rerenderWithPlayback(makePlaybackValue({ playbackTimeSeconds: 6 }));
    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "A D-shape barre"));

    view.unmount();
    await renderChordDictionaryWithPlayback();

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "A D-shape barre"));
    expectFirstShapeCard("A D-shape barre");
  });

  it("resets a Live Follow project E shape choice back to the global fallback", async () => {
    const user = userEvent.setup();
    writeGlobalChordDictionaryPreferredShape(
      makeDictionaryShapePreferenceContext({ chordLabel: "E" }),
      "e-a-shape-barre",
    );
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({ playbackTimeSeconds: 20 }),
    });

    const shapeChoices = within(screen.getByRole("group", { name: LIVE_SHAPE_GROUP_NAME }));
    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "E A-shape barre"));
    await user.click(shapeChoices.getByRole("button", { name: "E D-shape barre" }));
    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "E D-shape barre"));

    await user.click(
      screen.getByRole("button", {
        name: "Clear this project override and fall back to global or default",
      }),
    );

    await waitFor(() => expectFirstShapeChoice(LIVE_SHAPE_GROUP_NAME, "E A-shape barre"));
    expectFirstShapeCard("E A-shape barre");
    expect(
      screen.queryByRole("button", {
        name: "Clear this project override and fall back to global or default",
      }),
    ).not.toBeInTheDocument();
    expect(getStoredChordDictionaryPreferences()).toContain("e-a-shape-barre");
    expect(getStoredChordDictionaryPreferences()).not.toContain("e-d-shape-barre");
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
  });

  it("exposes only real instrument choices without fake library, playback, or settings affordances", async () => {
    await renderChordDictionary();

    const toolsScreen = within(getToolsScreen());
    const instrumentSelector = getDictionaryInstrumentSelector();
    expect(within(instrumentSelector).getByRole("button", { name: "Guitar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(instrumentSelector).getByRole("button", { name: "Accordion" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(instrumentSelector).getByRole("button", { name: "Piano" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(instrumentSelector).queryByRole("button", { name: "Organ" }),
    ).not.toBeInTheDocument();
    expect(
      within(instrumentSelector).queryByRole("button", { name: /48\s+More/i }),
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
