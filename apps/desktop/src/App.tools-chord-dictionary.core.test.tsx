import { beforeEach, describe, expect, it } from "vitest";
import { generateGuitarVoicings, GUITAR_STANDARD_PROFILE } from "./lib/music";
import {
  AccordionCandidateList, changeChordSearch, getDictionaryInstrumentSelector,
  makeDictionaryShapePreferenceContext, writeGlobalChordDictionaryPreferredShape, getStoredChordDictionaryPreferences,
  render, renderChordDictionary, resetAppTestHarness, screen, selectAccordionDictionary,
  selectPianoDictionary, userEvent, vi, within,
} from "./test/chordDictionaryTestHarness";

describe("Desktop chord dictionary canonical voicings", () => {
  beforeEach(resetAppTestHarness);

  it("renders generated guitar choices without catalog provenance or verified fingers", async () => {
    await renderChordDictionary();
    expect(screen.getByLabelText("Chord search")).toHaveValue("C");
    expect(within(getDictionaryInstrumentSelector()).getByRole("button", { name: "Guitar" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: "C voicing 1" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/CAGED|Common shape|E shape/i)).not.toBeInTheDocument();
    const notes = screen.getAllByRole("button", { name: /string \d fret \d/ });
    expect(notes.length).toBeGreaterThan(0);
    await userEvent.click(notes[0]!);
    expect(screen.getByLabelText("Note inspector")).toHaveTextContent(/String|Fret/);
  });

  it("restores a valid guitar preference beyond the normal shortlist", async () => {
    const saved = "guitar-1:3-2:1-3:3-4:2-5:1-6:3-capo-0";
    writeGlobalChordDictionaryPreferredShape(makeDictionaryShapePreferenceContext({ chordLabel: "C7" }), saved);
    expect(generateGuitarVoicings("C7").some(v => v.id === saved)).toBe(false);
    const label = generateGuitarVoicings("C7", GUITAR_STANDARD_PROFILE, {}, {}, [saved]).find(v => v.id === saved)!.label;
    await renderChordDictionary();
    changeChordSearch("C7");
    const choices = within(screen.getByRole("group", { name: "Global guitar shape preference choices" })).getAllByRole("button");
    expect(choices[0]).toHaveAccessibleName(label);
    expect(choices[0]).toHaveAttribute("aria-pressed", "true");
    expect(getStoredChordDictionaryPreferences()).toContain(saved);
  });

  it.each([
    ["piano", "piano-c-first-inversion-64-67-72"],
    ["accordion", "accordion-c-rh-second-inversion-octave-3-79-84-88"],
  ])("restores a valid saved %s inversion beyond the normal shortlist", async (instrumentId, saved) => {
    writeGlobalChordDictionaryPreferredShape(makeDictionaryShapePreferenceContext({ instrumentId }), saved);
    if (instrumentId === "piano") await selectPianoDictionary(); else await selectAccordionDictionary();
    const group = screen.getByRole("group", { name: instrumentId === "piano" ? "Global piano voicing preference choices" : "Global accordion right-hand preference choices" });
    const choices = within(group).getAllByRole("button");
    expect(choices[0]).toHaveAttribute("aria-pressed", "true");
    expect(choices[0]).toHaveTextContent(instrumentId === "piano" ? /First inversion/i : /3rd octave.*Second inversion/i);
    expect(getStoredChordDictionaryPreferences()).toContain(saved);
  });

  it("clears unsupported harmony without stale guitar notes", async () => {
    await renderChordDictionary();
    changeChordSearch("Cadd9");
    expect(screen.queryByRole("button", { name: "C voicing 1" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Unsupported chord/i).length).toBeGreaterThan(0);
  });

  it("shows ordinary seventh as Standard without a selected omission warning", async () => {
    await selectAccordionDictionary();
    changeChordSearch("C7");
    await screen.findByRole("heading", { name: "C7 accordion positions" });
    const left = screen.getByRole("group", { name: /Left hand/i });
    expect(left).toHaveTextContent("Standard");
    expect(left).not.toHaveTextContent(/Approx|Missing|no5/);
    expect(screen.queryByLabelText("Accordion approximation differences")).not.toBeInTheDocument();
    const panel = screen.getByLabelText("Accordion left-hand candidates");
    expect(within(panel).getByRole("button", { name: /C bass \+ C7.*Standard/i })).toHaveAttribute("aria-pressed", "true");
  });

  it.each([["C7/E", "E"], ["C7/Bb", "Bb"]])("highlights the requested physical bass for %s", async (chord, bass) => {
    await selectAccordionDictionary();
    changeChordSearch(chord);
    await screen.findByRole("heading", { name: `${chord} accordion positions` });
    const panel = screen.getByLabelText("Accordion left-hand candidates");
    const selected = within(panel).getAllByRole("button").find(b => b.getAttribute("aria-pressed") === "true");
    expect(selected).toHaveTextContent(new RegExp(`${bass} (?:bass|counterbass) \\+ C7`));
    const physical = within(screen.getByRole("group", { name: /Left hand/i })).getAllByRole("button").filter(b => b.getAttribute("aria-pressed") === "true");
    expect(physical.some(b => b.textContent?.includes(bass))).toBe(true);
    expect(selected).not.toHaveTextContent("G bass");
  });

  it("shows the complete G bass plus B minor combination", async () => {
    await selectAccordionDictionary();
    changeChordSearch("Gmaj7");
    await screen.findByRole("heading", { name: "Gmaj7 accordion positions" });
    const panel = screen.getByLabelText("Accordion left-hand candidates");
    expect(within(panel).getByRole("button", { name: /G bass \+ Bm.*Complete/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("distinguishes conventional diminished seventh from a completed diminished triad", async () => {
    await selectAccordionDictionary();
    changeChordSearch("Cdim");
    await screen.findByRole("heading", { name: "Cdim accordion positions" });
    expect(screen.getByRole("group", { name: /Left hand/i })).toHaveTextContent("Complete");
    changeChordSearch("Cdim7");
    await screen.findByRole("heading", { name: "Cdim7 accordion positions" });
    expect(screen.getByRole("group", { name: /Left hand/i })).toHaveTextContent("Standard");
  });

  it("keeps bass-only left hand partial even when right hand completes an augmented chord", async () => {
    await selectAccordionDictionary();
    changeChordSearch("Caug");
    await screen.findByRole("heading", { name: "Caug accordion positions" });
    expect(screen.getByRole("group", { name: /Left hand/i })).toHaveTextContent("Approx");
    const panel = screen.getByLabelText("Accordion left-hand candidates");
    expect(panel).toHaveTextContent(/treble completion/);
    expect(screen.getByLabelText("Accordion approximation differences")).toHaveTextContent(/Missing:/);
    expect(screen.getByRole("group", { name: /Right hand/i }).querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("keeps right inversion selection independent of left candidate selection", async () => {
    const user = await selectAccordionDictionary();
    changeChordSearch("C7");
    await screen.findByRole("heading", { name: "C7 accordion positions" });
    const right = screen.getByRole("group", { name: /Right hand/i });
    const before = [...right.querySelectorAll("button")].map(b => b.textContent);
    const panel = screen.getByLabelText("Accordion left-hand candidates");
    const bassOnly = within(panel).getAllByRole("button").find(b => b.textContent?.includes("treble completion"));
    await user.click(bassOnly!);
    expect(bassOnly).toHaveAttribute("aria-pressed", "true");
    expect([...right.querySelectorAll("button")].map(b => b.textContent)).toEqual(before);
    expect(screen.getByRole("group", { name: /Left hand/i })).toHaveTextContent("Approx");
    const inversions = within(screen.getByRole("group", { name: "Global accordion right-hand preference choices" })).getAllByRole("button");
    await user.click(inversions.find(button => button.getAttribute("aria-pressed") === "false")!);
    expect(bassOnly).toHaveAttribute("aria-pressed", "true");
    expect([...right.querySelectorAll("button")].map(b => b.textContent)).not.toEqual(before);
  });

  it("renders typed candidate differences verbatim with accessible partial status", () => {
    render(<AccordionCandidateList candidates={[{ id: "partial", label: "C bass + treble completion", kind: "approx", addedTones: [], missingTones: ["E", "G#"], buttons: [], buttonIds: [], detail: "Bass only", fingering: null, rank: 0 }]} selectedCandidateId="partial" onSelectCandidate={vi.fn()} />);
    expect(screen.getByRole("button", { name: /C bass.*Approx left hand/i })).toHaveTextContent("Missing: E, G#");
  });

  it("renders piano inversions with coherent note descriptions", async () => {
    await selectPianoDictionary();
    const keyboard = screen.getByRole("group", { name: /C piano keyboard/ });
    const notes = within(keyboard).getAllByRole("button");
    expect(notes.length).toBe(3);
    for (const note of notes) {
      expect(note).toHaveAccessibleDescription(/Degree|degree/);
      expect(note.getAttribute("aria-label")).toMatch(/[A-G][#b]?\d/);
    }
  });
});
