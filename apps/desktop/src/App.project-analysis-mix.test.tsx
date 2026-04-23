import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAppTestHarness,
  getAllByAriaKeyLabel,
  getByAriaKeyLabel,
  mockAnalyzeProject,
  mockConfirm,
  mockCreateChords,
  mockCreateLyrics,
  mockCreatePreview,
  mockUpdateLyrics,
  mockUpdateProject,
  renderApp,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
} from "./test/appTestHarness";

describe("Desktop app project analysis mix", () => {
  beforeEach(resetAppTestHarness);

  it("analyzes track from inspector", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", null);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    await user.click(screen.getByRole("button", { name: "Analyze Track" }));

    expect(mockAnalyzeProject).toHaveBeenCalledWith("proj_123");
  });

  it("refreshes existing chords with force enabled", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Chords" }));

    expect(mockCreateChords).toHaveBeenCalledWith("proj_123", {
      backend: "default",
      force: true,
    });
  });

  it("generates lyrics when transcript is empty", async () => {
    const user = userEvent.setup();
    setProjectLyrics("proj_123", {
      project_id: "proj_123",
      backend: null,
      source_artifact_id: null,
      source_kind: null,
      source_segments: [],
      segments: [],
      has_user_edits: false,
      created_at: null,
      updated_at: null,
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Lyrics" }));

    expect(mockCreateLyrics).toHaveBeenCalledWith("proj_123", { force: false });
  });

  it("renders active lyrics and saves in-app edits", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const activeLyric = within(lyricsTranscript).getByRole("button", { name: /0:00/i });
    expect(activeLyric.className).toContain("lyrics-segment--active");

    await user.click(screen.getByRole("button", { name: "Edit Lyrics" }));
    const firstTextarea = screen.getByLabelText("Lyric segment 1");
    await user.clear(firstTextarea);
    await user.type(firstTextarea, "Edited lyric line");
    await user.click(screen.getByRole("button", { name: "Save Lyrics" }));

    expect(mockUpdateLyrics).toHaveBeenCalledWith("proj_123", {
      segments: [
        { text: "Edited lyric line" },
        { text: "Second lyric line stays steady" },
      ],
    });
    expect(await screen.findByText("Edited lyric line")).toBeInTheDocument();
  });

  it("refreshes edited lyrics with confirmation", async () => {
    const user = userEvent.setup();
    setProjectLyrics("proj_123", {
      project_id: "proj_123",
      backend: "openai-whisper",
      source_artifact_id: "art_source",
      source_kind: "ai",
      source_segments: [
        {
          start_seconds: 0,
          end_seconds: 8,
          text: "Original lyric line",
          words: [],
        },
      ],
      segments: [
        {
          start_seconds: 0,
          end_seconds: 8,
          text: "Edited lyric line",
          words: [],
        },
      ],
      has_user_edits: true,
      created_at: "2026-04-18T13:16:00.000Z",
      updated_at: "2026-04-18T13:16:00.000Z",
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Lyrics" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Refresh lyrics? This replaces the current transcript, discards your edits, and may take longer when Whisper falls back to CPU.",
      expect.objectContaining({
        title: "Refresh lyrics",
        kind: "warning",
      }),
    );
    expect(mockCreateLyrics).toHaveBeenCalledWith("proj_123", { force: true });
  });

  it("renders single-label enharmonic spellings by default", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "Eb minor",
      key_confidence: 0.82,
      estimated_reference_hz: 431.9,
      tuning_offset_cents: -32,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });
    setProjectChords("proj_123", {
      project_id: "proj_123",
      backend: "default",
      source_artifact_id: "art_source",
      created_at: "2026-04-18T13:16:00.000Z",
      timeline: [
        { start_seconds: 0, end_seconds: 16, label: "legacy", confidence: 0.81, pitch_class: 3, quality: "minor" },
        { start_seconds: 16, end_seconds: 32, label: "legacy", confidence: 0.79, pitch_class: 10, quality: "major" },
      ],
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "Ebm")).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Next chord card" }), "Bb")).toBeInTheDocument();
    expect(screen.queryByText("D#/Ebm")).not.toBeInTheDocument();
    expect(screen.queryByText("A#/Bb")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    expect(
      getByAriaKeyLabel(screen.getByText("Source Key", { selector: "span" }).closest("div") as HTMLElement, "Ebm"),
    ).toBeInTheDocument();
    await user.click(screen.getByLabelText("Target Key"));
    const targetKeyList = screen.getByRole("listbox", { name: "Target key options" });
    expect(getAllByAriaKeyLabel(targetKeyList as HTMLElement, "Bbm").length).toBeGreaterThan(0);
    expect(within(targetKeyList).queryByText("D#/Ebm")).not.toBeInTheDocument();
  });

  it("uses sharp-first dual labels across key and chord surfaces", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        enharmonicDisplayMode: "dual",
      }),
    );
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "Eb minor",
      key_confidence: 0.82,
      estimated_reference_hz: 431.9,
      tuning_offset_cents: -32,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });
    setProjectChords("proj_123", {
      project_id: "proj_123",
      backend: "default",
      source_artifact_id: "art_source",
      created_at: "2026-04-18T13:16:00.000Z",
      timeline: [
        { start_seconds: 0, end_seconds: 16, label: "legacy", confidence: 0.81, pitch_class: 3, quality: "minor" },
      ],
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "D#m / Ebm")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    const sourceKeyCard = screen.getByText("Source Key", { selector: "span" }).closest("div") as HTMLElement;
    expect(getByAriaKeyLabel(sourceKeyCard, "D#m / Ebm")).toBeInTheDocument();
    const estimatedKeyCard = screen.getByText("Estimated Key", { selector: "span" }).closest("div") as HTMLElement;
    expect(getByAriaKeyLabel(estimatedKeyCard, "D#m / Ebm")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Target Key"));
    const targetKeyList = screen.getByRole("listbox", { name: "Target key options" });
    expect(getAllByAriaKeyLabel(targetKeyList as HTMLElement, "D#m / Ebm").length).toBeGreaterThan(0);
  });

  it("preserves the relative target shift when the detected source key is corrected", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        enharmonicDisplayMode: "sharps",
      }),
    );
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    await user.click(screen.getByLabelText("Raise target key"));

    const targetKeyCard = screen.getAllByText("Target Key", { selector: "span" })[0]?.closest("div") as HTMLElement;
    expect(within(targetKeyCard).getByText("G#")).toBeInTheDocument();

    await user.click(screen.getByText("Correct source key for this project"));
    await user.click(screen.getByLabelText("Project Source Key"));
    await user.click(screen.getByRole("option", { name: "G#" }));

    const sourceKeyCard = screen.getByText("Source Key", { selector: "span" }).closest("div") as HTMLElement;
    expect(mockUpdateProject).toHaveBeenCalledWith("proj_123", { source_key_override: "8:major" });
    expect(within(sourceKeyCard).getByText("G#")).toBeInTheDocument();
    expect(within(targetKeyCard).getByText("A")).toBeInTheDocument();
  });

  it("creates a new mix from the project source key override and target controls", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));
    await user.click(screen.getByText("Correct source key for this project"));
    await user.click(screen.getByLabelText("Project Source Key"));
    await user.click(screen.getByRole("option", { name: "A" }));
    await user.click(screen.getByLabelText("Raise target key"));
    await user.click(screen.getByRole("button", { name: "Create Mix" }));

    expect(mockCreatePreview).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        output_format: "wav",
        transpose: { semitones: 1 },
      }),
    );
  });

  it("shifts displayed chords when the detected source key is corrected", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        enharmonicDisplayMode: "sharps",
      }),
    );
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "G major",
      key_confidence: 0.82,
      estimated_reference_hz: 431.9,
      tuning_offset_cents: -32,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });
    setProjectChords("proj_123", {
      project_id: "proj_123",
      backend: "default",
      source_artifact_id: "art_source",
      created_at: "2026-04-18T13:16:00.000Z",
      timeline: [
        { start_seconds: 0, end_seconds: 16, label: "legacy", confidence: 0.81, pitch_class: 7, quality: "major" },
      ],
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "G")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    await user.click(screen.getByText("Correct source key for this project"));
    await user.click(screen.getByLabelText("Project Source Key"));
    await user.click(screen.getByRole("option", { name: "A" }));

    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "A")).toBeInTheDocument();

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "B")).toBeInTheDocument();
  });

  it("does not duplicate the detected key inside the project source key selector", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        enharmonicDisplayMode: "sharps",
      }),
    );
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "G# minor",
      key_confidence: 0.82,
      estimated_reference_hz: 431.9,
      tuning_offset_cents: -32,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    await user.click(screen.getByText("Correct source key for this project"));
    await user.click(screen.getByLabelText("Project Source Key"));

    const sourceKeyList = screen.getByRole("listbox", { name: "Project Source Key options" });
    expect(getAllByAriaKeyLabel(sourceKeyList as HTMLElement, "G#m").length).toBe(1);
  });

  it("caps target key stepping at one octave in either direction", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));

    const raiseTargetKeyButton = screen.getByLabelText("Raise target key");
    for (let index = 0; index < 16; index += 1) {
      await user.click(raiseTargetKeyButton);
    }

    expect(raiseTargetKeyButton).toBeDisabled();
    const targetKeyCard = screen
      .getAllByText("Target Key", { selector: "span" })[0]
      ?.closest(".key-shift__card") as HTMLElement;
    expect(within(targetKeyCard).getByText("Shift +12 semitones")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Mix" }));

    expect(mockCreatePreview).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        output_format: "wav",
        transpose: { semitones: 12 },
      }),
    );
  });

  it("honors the collapsed sources rail preference and expands on demand", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultSourcesRailCollapsed: true }),
    );

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sources rail" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Source and mix list" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand sources rail" }));

    expect(screen.getByRole("button", { name: "Collapse sources rail" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Source and mix list" })).toBeInTheDocument();
  });

  it("keeps raw artifact summaries compact at minimal information density", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await user.click(screen.getByText("Show raw artifacts and processing history"));

    const jobHistory = screen.getByText("Show raw artifacts and processing history").closest("details");
    expect(jobHistory).not.toBeNull();
    expect(within(jobHistory as HTMLElement).queryByText(/Vocal stem \/ two_stem \/ demucs/i)).not.toBeInTheDocument();
    expect(
      within(jobHistory as HTMLElement).queryByText(/Instrumental stem \/ two_stem \/ demucs/i),
    ).not.toBeInTheDocument();
  });
});
