import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, resetAppTestHarness } from "./test/appTestHarness";

function renderChordDictionary() {
  renderApp(["/tools?tool=chord-dictionary"]);
  return screen.findByRole("heading", { name: "Chord Dictionary" });
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

    await user.click(noteButton);
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
    expect(within(liveStatus).getByText("Waiting")).toBeInTheDocument();
    expect(within(liveStatus).queryByRole("button", { name: "Guitar" })).not.toBeInTheDocument();
    expect(within(liveStatus).queryByRole("button", { name: "Waiting" })).not.toBeInTheDocument();
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
