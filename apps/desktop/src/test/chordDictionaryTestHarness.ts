import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, vi } from "vitest";
import type { ChordSegmentSchema } from "../lib/api";
import { renderApp, resetAppTestHarness } from "./appTestHarness";
import {
  AccordionCandidateList,
  ChordDictionaryPage,
} from "../features/tools/ChordDictionaryPage";
import { ChordDictionaryFollowArmProvider } from "../features/tools/chordDictionaryFollowArm";
import {
  buildChordDictionaryFollowProjectContext,
  type ChordDictionaryFollowProjectContext,
} from "../features/projects/chordDictionaryFollowContext";
import {
  CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY,
  writeGlobalChordDictionaryPreferredShape,
  writeProjectChordDictionaryPreferredShape,
  type ChordDictionaryPreferenceContext,
} from "../features/tools/chordDictionaryPreferences";
import {
  PlaybackContext,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "../features/projects/playback-context";

export type { ChordSegmentSchema };

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
  const renderTree = (playbackValue: PlaybackContextValue) =>
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(
        PlaybackContext.Provider,
        { value: playbackValue },
        createElement(ChordDictionaryFollowArmProvider, null, createElement(ChordDictionaryPage)),
      ),
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

function setWindowScrollPosition(scrollX: number, scrollY: number) {
  Object.defineProperty(window, "scrollX", {
    configurable: true,
    value: scrollX,
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value: scrollY,
  });
}

function installWindowScrollMock() {
  const scrollTo = vi.fn();
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
}

function getMainContent() {
  const mainContent = document.querySelector(".main-content");
  if (!(mainContent instanceof HTMLElement)) {
    throw new Error("Expected app main content scroll container");
  }
  return mainContent;
}

function installElementScrollMock(
  element: HTMLElement,
  { scrollLeft = 0, scrollTop }: { scrollLeft?: number; scrollTop: number },
) {
  let currentScrollLeft = scrollLeft;
  let currentScrollTop = scrollTop;
  const scrollLeftSetter = vi.fn((value: number) => {
    currentScrollLeft = value;
  });
  const scrollTopSetter = vi.fn((value: number) => {
    currentScrollTop = value;
  });

  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => currentScrollLeft,
    set: scrollLeftSetter,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => currentScrollTop,
    set: scrollTopSetter,
  });

  return { scrollLeftSetter, scrollTopSetter };
}

function expectDescribedBy(element: HTMLElement, pattern: RegExp) {
  const describedBy = element.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const description = describedBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  expect(description).toMatch(pattern);
}

function getActiveShapeCard() {
  const shapeCard = document.querySelector(".chord-shape-card--active");
  if (!(shapeCard instanceof HTMLElement)) {
    throw new Error("Expected an active chord shape card");
  }
  return shapeCard;
}

function getSelectedButton(group: HTMLElement) {
  const button = within(group).getAllByRole("button").find(
    (candidate) => candidate.getAttribute("aria-pressed") === "true",
  );
  if (!button) {
    throw new Error("Expected a selected button");
  }
  return button as HTMLElement;
}

function expectInspectorMatchesGuitarNote(noteButton: HTMLElement) {
  const note = noteButton.dataset.note;
  const stringNumber = noteButton.dataset.string;
  const fret = noteButton.dataset.fret;

  expect(note).toBeTruthy();
  expect(stringNumber).toBeTruthy();
  expect(fret).toBeTruthy();
  expectInspectorToShow([
    new RegExp(escapeRegExp(note ?? "")),
    new RegExp(`String\\s*${stringNumber ?? ""}`),
    new RegExp(`Fret\\s*${fret ?? ""}`),
  ]);
}


export {
  AccordionCandidateList,
  CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY,
  ChordDictionaryFollowArmProvider,
  ChordDictionaryPage,
  DICTIONARY_SHAPE_GROUP_NAME,
  LIVE_SHAPE_GROUP_NAME,
  PlaybackContext,
  buildChordDictionaryFollowProjectContext,
  changeChordSearch,
  cTimeline,
  dTimeline,
  displayedTimeline,
  escapeRegExp,
  expectAccordionInstrumentSelected,
  expectActiveTooltipNotes,
  expectContainedHorizontalOverflow,
  expectContinuousBarre,
  expectDescribedBy,
  expectFirstShapeCard,
  expectFirstShapeChoice,
  expectInspectorMatchesGuitarNote,
  expectInspectorToShow,
  expectNoMutedMarker,
  expectNoOpenMarker,
  expectOpenMarker,
  expectPianoInstrumentSelected,
  expectPlayableNote,
  expectSelectedOrHighlighted,
  expectStandardStringLabels,
  expectTextVisible,
  expectMutedMarker,
  fireEvent,
  fSharpTimeline,
  getAccordionActiveKeyboardMidi,
  getAccordionKeyboardMidiByColor,
  getAccordionKeyByMidi,
  getAccordionSurface,
  getActiveShapeCard,
  getCommonChordCard,
  getDictionaryInstrumentSelector,
  getMainContent,
  getPianoActiveKeyboardMidi,
  getPianoKeyboard,
  getPianoKeyboardMidiByColor,
  getPianoKeyByMidi,
  getSelectedAccordionButton,
  getSelectedButton,
  getShapeCard,
  getShapeChoiceButtons,
  getStandardDiagram,
  getStoredChordDictionaryPreferences,
  getToolsScreen,
  installElementScrollMock,
  installWindowScrollMock,
  makeDictionaryShapePreferenceContext,
  makeFollowProject,
  makeLiveShapePreferenceContext,
  makePlaybackSession,
  makePlaybackValue,
  readNumericStyleVar,
  render,
  renderApp,
  renderChordDictionary,
  renderChordDictionaryPlaybackHarness,
  renderChordDictionaryView,
  renderChordDictionaryWithPlayback,
  resetAppTestHarness,
  screen,
  selectAccordionDictionary,
  selectPianoDictionary,
  setNarrowViewport,
  setWindowScrollPosition,
  sourceTimeline,
  userEvent,
  vi,
  waitFor,
  within,
  writeGlobalChordDictionaryPreferredShape,
  writeProjectChordDictionaryPreferredShape,
};
