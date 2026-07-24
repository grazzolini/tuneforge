import { beforeEach, describe, expect, it } from "vitest";
import {
  type ChordSegmentSchema,
  DICTIONARY_SHAPE_GROUP_NAME,
  LIVE_SHAPE_GROUP_NAME,
  cTimeline,
  dTimeline,
  expectAccordionInstrumentSelected,
  expectFirstShapeCard,
  expectFirstShapeChoice,
  expectInspectorMatchesGuitarNote,
  expectInspectorToShow,
  expectPianoInstrumentSelected,
  expectSelectedOrHighlighted,
  fSharpTimeline,
  getDictionaryInstrumentSelector,
  getPianoActiveKeyboardMidi,
  getPianoKeyboard,
  getPianoKeyByMidi,
  getSelectedAccordionButton,
  getShapeCard,
  getStoredChordDictionaryPreferences,
  getToolsScreen,
  makeDictionaryShapePreferenceContext,
  makeFollowProject,
  makeLiveShapePreferenceContext,
  makePlaybackValue,
  renderChordDictionary,
  renderChordDictionaryPlaybackHarness,
  renderChordDictionaryView,
  renderChordDictionaryWithPlayback,
  resetAppTestHarness,
  screen,
  userEvent,
  waitFor,
  within,
  writeGlobalChordDictionaryPreferredShape,
  writeProjectChordDictionaryPreferredShape,
} from "./test/chordDictionaryTestHarness";

describe("Desktop app tools chord dictionary live follow", () => {
  beforeEach(resetAppTestHarness);
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

  it("activates the owning Live Follow guitar shape when keyboard-selecting an inactive-card note", async () => {
    const user = userEvent.setup();
    await renderChordDictionaryWithPlayback();

    const shapeGroup = screen.getByRole("group", { name: LIVE_SHAPE_GROUP_NAME });
    const inactiveShapeButton = within(shapeGroup).getByRole("button", {
      name: "A D-shape barre",
    });
    const inactiveShapeCard = getShapeCard("A D-shape barre");
    const noteButton = within(inactiveShapeCard).getAllByRole("button", {
      name: /string \d fret \d/i,
    })[0] as HTMLElement | undefined;
    if (!noteButton) {
      throw new Error("Expected a selectable Live Follow guitar note");
    }

    expect(inactiveShapeButton).toHaveAttribute("aria-pressed", "false");
    expect(inactiveShapeCard).not.toHaveClass("chord-shape-card--active");

    noteButton.focus();
    await user.keyboard(" ");

    await waitFor(() => expect(inactiveShapeButton).toHaveAttribute("aria-pressed", "true"));
    expect(inactiveShapeCard).toHaveClass("chord-shape-card--active");
    expect(noteButton).toHaveClass("guitar-fretboard__dot--selected");
    expectInspectorMatchesGuitarNote(noteButton);
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
