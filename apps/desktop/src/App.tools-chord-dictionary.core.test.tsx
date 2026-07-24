import { beforeEach, describe, expect, it } from "vitest";
import {
  AccordionCandidateList,
  DICTIONARY_SHAPE_GROUP_NAME,
  changeChordSearch,
  escapeRegExp,
  expectActiveTooltipNotes,
  expectContainedHorizontalOverflow,
  expectContinuousBarre,
  expectDescribedBy,
  expectInspectorMatchesGuitarNote,
  expectInspectorToShow,
  expectNoMutedMarker,
  expectNoOpenMarker,
  expectOpenMarker,
  expectPlayableNote,
  expectSelectedOrHighlighted,
  expectStandardStringLabels,
  expectTextVisible,
  expectMutedMarker,
  fireEvent,
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
  getStandardDiagram,
  installElementScrollMock,
  installWindowScrollMock,
  makePlaybackValue,
  readNumericStyleVar,
  render,
  renderChordDictionary,
  renderChordDictionaryView,
  renderChordDictionaryWithPlayback,
  resetAppTestHarness,
  screen,
  selectAccordionDictionary,
  selectPianoDictionary,
  setNarrowViewport,
  setWindowScrollPosition,
  userEvent,
  vi,
  waitFor,
  within,
} from "./test/chordDictionaryTestHarness";

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

  it("activates the owning Dictionary guitar shape when selecting a note in an inactive card", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const shapeGroup = screen.getByRole("group", { name: DICTIONARY_SHAPE_GROUP_NAME });
    const inactiveShapeButton = within(shapeGroup).getByRole("button", {
      name: "C E-shape barre",
    });
    const inactiveShapeCard = getShapeCard("C E-shape barre");
    const noteButton = expectPlayableNote(
      getStandardDiagram("C E-shape barre"),
      "C3",
      6,
      8,
    );

    expect(inactiveShapeButton).toHaveAttribute("aria-pressed", "false");
    expect(inactiveShapeCard).not.toHaveClass("chord-shape-card--active");

    await user.click(noteButton);

    await waitFor(() => expect(inactiveShapeButton).toHaveAttribute("aria-pressed", "true"));
    expect(inactiveShapeCard).toHaveClass("chord-shape-card--active");
    expect(noteButton).toHaveClass("guitar-fretboard__dot--selected");
    expectInspectorMatchesGuitarNote(noteButton);
  });

  it("preserves search focus and viewport while typing across instruments and live fallback", async () => {
    const user = userEvent.setup();
    const scrollTo = installWindowScrollMock();
    const dictionaryView = renderChordDictionaryView();
    await dictionaryView.findHeading();

    const expectStableSearchChange = async (value: string, scrollY: number) => {
      const elementScroll = installElementScrollMock(getMainContent(), {
        scrollLeft: 6,
        scrollTop: scrollY,
      });
      setWindowScrollPosition(8, scrollY + 1);
      const input = screen.getByLabelText("Chord search");
      input.focus();
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveFocus();
      await waitFor(() => expect(elementScroll.scrollTopSetter).toHaveBeenCalledWith(scrollY));
      expect(elementScroll.scrollLeftSetter).toHaveBeenCalledWith(6);
      expect(scrollTo).toHaveBeenLastCalledWith(8, scrollY + 1);
    };

    await expectStableSearchChange("D", 420);

    await user.click(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Accordion" }));
    await expectStableSearchChange("E", 512);

    await user.click(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Piano" }));
    await expectStableSearchChange("F", 640);

    dictionaryView.unmount();
    await renderChordDictionaryWithPlayback({
      playback: makePlaybackValue({ isPlaying: false }),
    });
    expect(screen.getByText("Playback paused")).toBeInTheDocument();
    setWindowScrollPosition(8, 720);
    const input = screen.getByLabelText("Chord search");
    input.focus();
    fireEvent.change(input, { target: { value: "G" } });
    expect(input).toHaveFocus();
    expect(scrollTo).toHaveBeenLastCalledWith(8, 720);
  });

  it("supports keyboard-only guitar shape and fretboard note selection", async () => {
    const user = userEvent.setup();
    await renderChordDictionary();

    const shapeGroup = screen.getByRole("group", { name: DICTIONARY_SHAPE_GROUP_NAME });
    const initialShapeButtons = within(shapeGroup).getAllByRole("button");
    initialShapeButtons[0]?.focus();

    await user.keyboard("{ArrowRight}");
    const focusedShapeButton = document.activeElement as HTMLElement;
    expect(focusedShapeButton).toHaveClass("chord-shape-tab");
    expect(focusedShapeButton).not.toBe(initialShapeButtons[0]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(focusedShapeButton).toHaveAttribute("aria-pressed", "true"));
    expectDescribedBy(focusedShapeButton, /C .*Guitar.*choice .*tuning/i);

    const activeShapeCard = getActiveShapeCard();
    const noteButtons = within(activeShapeCard).getAllByRole("button", {
      name: /string \d fret \d/i,
    });
    const firstNoteButton = noteButtons[0] as HTMLElement;
    firstNoteButton.focus();

    await user.keyboard("{ArrowRight}");
    const focusedNote = document.activeElement as HTMLElement;
    expect(focusedNote).toHaveAttribute("data-note-id");
    expect(focusedNote).not.toBe(firstNoteButton);
    await user.keyboard(" ");

    await waitFor(() =>
      expectInspectorToShow([
        new RegExp(escapeRegExp(focusedNote.dataset.note ?? "")),
        new RegExp(`String\\s*${focusedNote.dataset.string ?? ""}`),
        new RegExp(`Fret\\s*${focusedNote.dataset.fret ?? ""}`),
      ]),
    );
    expectDescribedBy(focusedNote, /Guitar.*shape .*degree .*string .*fret/i);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(getSelectedButton(shapeGroup)).toHaveFocus());
  });

  it("supports keyboard-only piano voicing and key selection", async () => {
    const user = await selectPianoDictionary();

    changeChordSearch("G7");
    await screen.findByRole("heading", { name: "G7 piano voicings" });
    const voicingGroup = screen.getByRole("group", {
      name: "Global piano voicing preference choices",
    });
    const voicingButtons = within(voicingGroup).getAllByRole("button");
    voicingButtons[0]?.focus();

    await user.keyboard("{ArrowRight}");
    const focusedVoicing = document.activeElement as HTMLElement;
    expect(focusedVoicing).toHaveTextContent("G7 first inversion");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(focusedVoicing).toHaveAttribute("aria-pressed", "true"));
    expectDescribedBy(focusedVoicing, /G7 .*Piano.*choice .*range/i);

    const keyboard = getPianoKeyboard();
    const keyButtons = within(keyboard).getAllByRole("button", { name: /piano key/i });
    keyButtons[0]?.focus();
    await user.keyboard("{ArrowRight}");
    const focusedKey = document.activeElement as HTMLElement;
    expect(focusedKey).toHaveAttribute("data-note-id");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expectInspectorToShow([
        new RegExp(escapeRegExp(focusedKey.dataset.pitchLabel ?? "")),
        new RegExp(`Degree\\s*${focusedKey.dataset.degree ?? ""}`),
      ]),
    );
    expectDescribedBy(focusedKey, /Piano.*voicing .*range.*degree/i);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(getSelectedButton(voicingGroup)).toHaveFocus());
  });

  it("supports keyboard-only accordion voicing, keys, left buttons, and candidates", async () => {
    const user = await selectAccordionDictionary();

    const voicingGroup = screen.getByRole("group", {
      name: "Global accordion right-hand preference choices",
    });
    const voicingButtons = within(voicingGroup).getAllByRole("button");
    voicingButtons[0]?.focus();
    await user.keyboard("{ArrowRight}");
    const focusedVoicing = document.activeElement as HTMLElement;
    expect(focusedVoicing).toHaveClass("chord-shape-tab");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(focusedVoicing).toHaveAttribute("aria-pressed", "true"));
    expectDescribedBy(focusedVoicing, /Accordion.*choice/i);

    const rightHand = screen.getByRole("group", { name: /Right hand/i });
    const keyboard = getAccordionSurface(
      rightHand,
      '[data-surface="keyboard"], .accordion-keyboard, .piano-keyboard',
    );
    const keyButtons = within(keyboard).getAllByRole("button", {
      name: /accordion keyboard key/i,
    });
    keyButtons[0]?.focus();
    await user.keyboard("{ArrowRight}");
    const focusedKey = document.activeElement as HTMLElement;
    expect(focusedKey).toHaveAttribute("data-note-id");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expectInspectorToShow([
        new RegExp(escapeRegExp(focusedKey.querySelector("strong")?.textContent ?? "")),
        /Hand\s*Right|Right hand/i,
      ]),
    );
    expectDescribedBy(focusedKey, /Accordion.*voicing .*degree/i);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(getSelectedButton(voicingGroup)).toHaveFocus());

    const leftHand = screen.getByRole("group", { name: /Left hand/i });
    const leftButton = getSelectedAccordionButton(leftHand, /(^C$|\bC bass\b|\bbass C\b)/i);
    leftButton.focus();
    await user.keyboard("{ArrowDown}");
    const focusedLeftButton = document.activeElement as HTMLElement;
    expect(focusedLeftButton.closest('[data-surface="stradella"]')).toBeInTheDocument();
    await user.keyboard(" ");
    await waitFor(() => expectInspectorToShow([/Hand\s*Left|Left hand/i, /Stradella/i]));
    expectDescribedBy(focusedLeftButton, /Accordion.*Stradella.*row.*column/i);

    changeChordSearch("Csus4");
    await screen.findByRole("heading", { name: "Csus4 accordion positions" });
    const candidatePanel = screen.getByLabelText("Accordion left-hand candidates");
    const candidateButtons = within(candidatePanel).getAllByRole("button");
    expect(candidateButtons.length).toBeGreaterThan(1);
    candidateButtons[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(candidateButtons[1]);
    await user.keyboard(" ");
    await waitFor(() => expect(candidateButtons[1]).toHaveAttribute("aria-pressed", "true"));
  });
});
