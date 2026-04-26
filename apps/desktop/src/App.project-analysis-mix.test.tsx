import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAppTestHarness,
  findAudioByArtifactId,
  getAllByAriaKeyLabel,
  getByAriaKeyLabel,
  markAudioReady,
  mockAnalyzeProject,
  mockConfirm,
  mockCreateChords,
  mockCreateLyrics,
  mockCreatePreview,
  mockCreateStems,
  mockUpdateLyrics,
  mockUpdateProject,
  renderApp,
  setChordBackends,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
} from "./test/appTestHarness";

describe("Desktop app project analysis mix", () => {
  beforeEach(resetAppTestHarness);

  async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "Playback" }));
  }

  async function switchToLyricsOnly(user: ReturnType<typeof userEvent.setup>) {
    const lyricsToggle = screen.getByRole("button", { name: "Lyrics" });
    const chordsToggle = screen.getByRole("button", { name: "Chords" });
    const lyricsPressed = lyricsToggle.getAttribute("aria-pressed") === "true";
    const chordsPressed = chordsToggle.getAttribute("aria-pressed") === "true";
    if (!lyricsPressed && chordsPressed) {
      await user.click(lyricsToggle);
      await user.click(chordsToggle);
      return;
    }
    if (lyricsPressed && chordsPressed) {
      await user.click(chordsToggle);
    }
  }

  async function switchToChordsOnly(user: ReturnType<typeof userEvent.setup>) {
    const lyricsToggle = screen.getByRole("button", { name: "Lyrics" });
    const chordsToggle = screen.getByRole("button", { name: "Chords" });
    const lyricsPressed = lyricsToggle.getAttribute("aria-pressed") === "true";
    const chordsPressed = chordsToggle.getAttribute("aria-pressed") === "true";
    if (lyricsPressed && !chordsPressed) {
      await user.click(chordsToggle);
      await user.click(lyricsToggle);
      return;
    }
    if (lyricsPressed && chordsPressed) {
      await user.click(lyricsToggle);
    }
  }

  async function ensureInspectorVisible(user: ReturnType<typeof userEvent.setup>) {
    const showInspectorButton = screen.queryByRole("button", { name: "Show Inspector" });
    if (showInspectorButton) {
      await user.click(showInspectorButton);
    }
  }

  function installScrollMock(element: HTMLElement, axis: "vertical" | "horizontal" = "vertical") {
    const scrollTo = vi.fn();
    Object.defineProperty(element, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    if (axis === "vertical") {
      Object.defineProperty(element, "clientHeight", {
        configurable: true,
        value: 100,
      });
      Object.defineProperty(element, "scrollHeight", {
        configurable: true,
        value: 500,
      });
      element.scrollTop = 200;
    } else {
      Object.defineProperty(element, "clientWidth", {
        configurable: true,
        value: 100,
      });
      Object.defineProperty(element, "scrollWidth", {
        configurable: true,
        value: 500,
      });
      element.scrollLeft = 200;
    }
    return scrollTo;
  }

  it("analyzes track from processing panel", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", null);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Analyze Track" }));

    expect(mockAnalyzeProject).toHaveBeenCalledWith("proj_123");
  });

  it("surfaces detected tempo in the analysis panel", async () => {
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "G major",
      key_confidence: 0.82,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: 121.48,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByText("121.5")).toBeInTheDocument();
    expect(screen.getByText("BPM")).toBeInTheDocument();
  });

  it("refreshes existing chords with force enabled", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Chords" }));

    expect(mockCreateChords).toHaveBeenCalledWith("proj_123", {
      backend: "tuneforge-fast",
      force: true,
      overwrite_user_edits: false,
    });
  });

  it("uses the selected default chord backend for chord and stem jobs", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultChordBackend: "crema-advanced", defaultSourcesRailCollapsed: false }),
    );

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Chords" }));
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    expect(mockCreateChords).toHaveBeenCalledWith("proj_123", {
      backend: "crema-advanced",
      force: true,
      overwrite_user_edits: false,
    });
    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({ chord_backend: "crema-advanced" }),
    );
  });

  it("falls back to built-in chords when the saved advanced backend is unavailable", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultChordBackend: "crema-advanced", defaultSourcesRailCollapsed: false }),
    );
    setChordBackends([
      {
        availability: "available",
        available: true,
        capabilities: {},
        desktopOnly: false,
        experimental: false,
        id: "tuneforge-fast",
        label: "Built-in Chords",
        unavailable_reason: null,
      },
      {
        availability: "unavailable",
        available: false,
        capabilities: {},
        desktopOnly: true,
        experimental: true,
        id: "crema-advanced",
        label: "Advanced Chords",
        unavailable_reason: "crema is not installed",
      },
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Chords" }));
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    expect(mockCreateChords).toHaveBeenCalledWith("proj_123", {
      backend: "tuneforge-fast",
      backend_fallback_from: "crema-advanced",
      force: true,
      overwrite_user_edits: false,
    });
    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        chord_backend: "tuneforge-fast",
        chord_backend_fallback_from: "crema-advanced",
      }),
    );
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
    await openPlaybackWorkspace(user);
    await switchToLyricsOnly(user);
    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const activeLyric = within(lyricsTranscript).getByRole("button", { name: /0:00/i });
    expect(lyricsTranscript.className).toContain("lead-sheet");
    expect(activeLyric.className).toContain("lead-sheet__row--lyrics");
    expect(activeLyric.className).toContain("lead-sheet__row--active");

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

  it("hard follows lyrics during playback after manual scroll", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await openPlaybackWorkspace(user);
    await switchToLyricsOnly(user);

    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const scrollTo = installScrollMock(lyricsTranscript);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    scrollTo.mockClear();

    fireEvent.wheel(lyricsTranscript, { deltaY: 320 });
    await user.click(within(lyricsTranscript).getByRole("button", { name: /0:08/i }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(within(lyricsTranscript).getByRole("button", { name: /0:08/i }).className).toContain(
      "lead-sheet__row--active",
    );
  });

  it("lets users browse follow views while playback is stopped", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    const leadSheet = screen.getByRole("group", { name: "Lyrics and chords lead sheet" });
    const leadSheetScrollTo = installScrollMock(leadSheet);
    const secondLeadSheetRow = Array.from(
      leadSheet.querySelectorAll<HTMLElement>(".lead-sheet__row--lyrics"),
    ).find((row) => row.textContent?.includes("Second") && row.textContent.includes("steady"));
    expect(secondLeadSheetRow).not.toBeNull();
    fireEvent.wheel(leadSheet, { deltaY: 320 });
    await user.click(secondLeadSheetRow as HTMLElement);
    await waitFor(() =>
      expect((secondLeadSheetRow as HTMLElement).className).toContain("lead-sheet__row--active"),
    );
    expect(leadSheetScrollTo).not.toHaveBeenCalled();

    await switchToLyricsOnly(user);
    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const lyricsScrollTo = installScrollMock(lyricsTranscript);
    const firstLyric = within(lyricsTranscript).getByRole("button", { name: /0:00/i });
    fireEvent.wheel(lyricsTranscript, { deltaY: -320 });
    await user.click(firstLyric);
    await waitFor(() =>
      expect(firstLyric.className).toContain("lead-sheet__row--active"),
    );
    expect(lyricsScrollTo).not.toHaveBeenCalled();

    await switchToChordsOnly(user);
    const chordTimeline = screen.getByRole("group", { name: "Chord timeline" });
    const chordScrollTo = installScrollMock(chordTimeline, "horizontal");
    const secondChord = within(chordTimeline).getByRole("button", { name: /D\s*0:16/ });
    fireEvent.wheel(chordTimeline, { deltaX: 320 });
    await user.click(secondChord);
    await waitFor(() => expect(secondChord).toHaveAttribute("aria-pressed", "true"));
    expect(chordScrollTo).not.toHaveBeenCalled();
  });

  it("keeps lyric highlights current when lyrics follow is off", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await switchToLyricsOnly(user);
    await user.click(screen.getByRole("button", { name: "Lyrics Follow" }));

    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const scrollTo = installScrollMock(lyricsTranscript);
    const secondLyric = within(lyricsTranscript).getByRole("button", { name: /0:08/i });

    fireEvent.wheel(lyricsTranscript, { deltaY: 320 });
    await user.click(secondLyric);

    await waitFor(() =>
      expect(secondLyric.className).toContain("lead-sheet__row--active"),
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("activates clicked lyric rows when transcript segment timings overlap", async () => {
    const user = userEvent.setup();
    const segments = [
      {
        start_seconds: 0,
        end_seconds: 12,
        text: "First overlapping phrase",
        words: [],
      },
      {
        start_seconds: 8,
        end_seconds: 16,
        text: "Second overlapping phrase",
        words: [],
      },
    ];
    setProjectLyrics("proj_123", {
      project_id: "proj_123",
      backend: "openai-whisper",
      source_artifact_id: "art_source",
      source_kind: "ai",
      source_segments: segments,
      segments,
      has_user_edits: false,
      created_at: "2026-04-18T13:16:00.000Z",
      updated_at: "2026-04-18T13:16:00.000Z",
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    const leadSheet = screen.getByRole("group", { name: "Lyrics and chords lead sheet" });
    const combinedSecond = within(leadSheet).getByRole("button", {
      name: /Second overlapping phrase/i,
    });
    await user.click(combinedSecond);
    await waitFor(() => expect(combinedSecond.className).toContain("lead-sheet__row--active"));

    await switchToLyricsOnly(user);
    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const lyricsFirst = within(lyricsTranscript).getByRole("button", {
      name: /First overlapping phrase/i,
    });
    const lyricsSecond = within(lyricsTranscript).getByRole("button", {
      name: /Second overlapping phrase/i,
    });
    await user.click(lyricsFirst);
    await waitFor(() => expect(lyricsFirst.className).toContain("lead-sheet__row--active"));

    await user.click(lyricsSecond);
    await waitFor(() => expect(lyricsSecond.className).toContain("lead-sheet__row--active"));
  });

  it("renders a combined lead sheet with lyric chords and instrumental rows", async () => {
    const user = userEvent.setup();
    setProjectChords("proj_123", {
      project_id: "proj_123",
      backend: "default",
      source_artifact_id: "art_source",
      created_at: "2026-04-18T13:16:00.000Z",
      timeline: [
        { start_seconds: 0.5, end_seconds: 2, label: "G", confidence: 0.81, pitch_class: 7, quality: "major" },
        { start_seconds: 20, end_seconds: 24, label: "D", confidence: 0.79, pitch_class: 2, quality: "major" },
      ],
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const leadSheet = screen.getByRole("group", { name: "Lyrics and chords lead sheet" });

    expect(within(leadSheet).getByText("Hello")).toBeInTheDocument();
    expect(getByAriaKeyLabel(leadSheet, "G")).toBeInTheDocument();
    expect(within(leadSheet).getByText("Instrumental")).toBeInTheDocument();
    expect(getByAriaKeyLabel(leadSheet, "D")).toBeInTheDocument();
  });

  it("hard follows combined lead sheet during playback after manual scroll", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await openPlaybackWorkspace(user);

    const leadSheet = screen.getByRole("group", { name: "Lyrics and chords lead sheet" });
    const scrollTo = installScrollMock(leadSheet);
    const secondLyricRow = Array.from(
      leadSheet.querySelectorAll<HTMLElement>(".lead-sheet__row--lyrics"),
    ).find((row) => row.textContent?.includes("Second") && row.textContent.includes("steady"));
    expect(secondLyricRow).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    scrollTo.mockClear();

    fireEvent.wheel(leadSheet, { deltaY: 320 });
    await user.click(secondLyricRow as HTMLElement);

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect((secondLyricRow as HTMLElement).className).toContain("lead-sheet__row--active");
  });

  it("hard follows chords during playback after manual timeline scroll", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);

    const chordTimeline = screen.getByRole("group", { name: "Chord timeline" });
    const scrollTo = installScrollMock(chordTimeline, "horizontal");
    const secondChord = within(chordTimeline).getByRole("button", { name: /D\s*0:16/ });
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    scrollTo.mockClear();

    fireEvent.wheel(chordTimeline, { deltaX: 320 });
    await user.click(secondChord);

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(secondChord).toHaveAttribute("aria-pressed", "true");
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
      "Refresh lyrics? This replaces the current transcript and discards your edits.",
      expect.objectContaining({
        title: "Refresh lyrics",
        kind: "warning",
      }),
    );
    expect(mockCreateLyrics).toHaveBeenCalledWith("proj_123", { force: true });
  });

  it("refreshes edited chords with confirmation", async () => {
    const user = userEvent.setup();
    const timeline = [
      { start_seconds: 0, end_seconds: 16, label: "G", confidence: 0.81, pitch_class: 7, quality: "major" },
    ];
    setProjectChords("proj_123", {
      project_id: "proj_123",
      backend: "librosa",
      source_artifact_id: "art_source",
      source_segments: timeline,
      timeline,
      has_user_edits: true,
      created_at: "2026-04-18T13:16:00.000Z",
      updated_at: "2026-04-18T13:16:00.000Z",
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh Chords" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Refresh chords? This replaces the current chord timeline and discards your edits.",
      expect.objectContaining({
        title: "Refresh chords",
        kind: "warning",
      }),
    );
    expect(mockCreateChords).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({ force: true, overwrite_user_edits: true }),
    );
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
    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "Ebm")).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Next chord card" }), "Bb")).toBeInTheDocument();
    expect(screen.queryByText("D#/Ebm")).not.toBeInTheDocument();
    expect(screen.queryByText("A#/Bb")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Project" }));
    await ensureInspectorVisible(user);
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
    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "D#m / Ebm")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Project" }));
    await ensureInspectorVisible(user);
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
    await ensureInspectorVisible(user);
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
    await ensureInspectorVisible(user);
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
    await ensureInspectorVisible(user);
    await user.click(screen.getByText("Correct source key for this project"));
    await user.click(screen.getByLabelText("Project Source Key"));
    await user.click(screen.getByRole("option", { name: "A" }));

    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "A")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Project" }));
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "B")).toBeInTheDocument();
  });

  it("opens project first, then remembers playback workspace and display mode per project", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");

    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);

    expect(screen.getByRole("tab", { name: "Playback" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "true");
    expect(
      JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"),
    ).toMatchObject({
      proj_123: {
        activeWorkspace: "playback",
        playbackDisplayMode: "chords",
      },
    });

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    const reopenDemoLinks = screen.getAllByRole("link", { name: "Open Demo Song project" });
    await user.click(reopenDemoLinks[reopenDemoLinks.length - 1] as HTMLElement);

    expect(await screen.findByRole("tab", { name: "Playback" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "true");
  });

  it("resolves auto playback display to the available practice view", async () => {
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
    await openPlaybackWorkspace(user);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "false"),
    );
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Current chord card" })).toBeInTheDocument();
  });

  it("persists playback follow toggles per project", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    const lyricsFollow = screen.getByRole("button", { name: "Lyrics Follow" });
    await user.click(lyricsFollow);

    expect(lyricsFollow).toHaveAttribute("aria-pressed", "false");
    expect(
      JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"),
    ).toMatchObject({
      proj_123: {
        lyricsFollowEnabled: false,
        chordsFollowEnabled: true,
      },
    });

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    const reopenDemoLinks = screen.getAllByRole("link", { name: "Open Demo Song project" });
    await user.click(reopenDemoLinks[reopenDemoLinks.length - 1] as HTMLElement);

    expect(await screen.findByRole("button", { name: "Lyrics Follow" })).toHaveAttribute("aria-pressed", "false");
    await switchToChordsOnly(user);
    expect(screen.getByRole("button", { name: "Chords Follow" })).toHaveAttribute("aria-pressed", "true");
  });

  it("scrolls the page to transport when playback starts from the playback workspace", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await switchToLyricsOnly(user);

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    const scrollIntoView = vi.mocked(window.HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "end",
      }),
    );
  });

  it("plays from the focused lyric when space starts playback", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await openPlaybackWorkspace(user);
    await switchToLyricsOnly(user);

    const lyricsTranscript = screen.getByRole("group", { name: "Lyrics transcript" });
    const secondLyric = within(lyricsTranscript).getByRole("button", { name: /0:08/i });
    await user.click(secondLyric);

    expect(sourceAudio.currentTime).toBeCloseTo(8, 3);
    expect(secondLyric).toHaveFocus();
    fireEvent.keyDown(secondLyric, { code: "Space", key: " " });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    expect(sourceAudio.currentTime).toBeCloseTo(8, 3);

    sourceAudio.currentTime = 12.5;
    fireEvent.timeUpdate(sourceAudio);
    fireEvent.keyDown(secondLyric, { code: "Space", key: " " });

    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(sourceAudio.currentTime).toBeCloseTo(8, 3);
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
    await ensureInspectorVisible(user);
    await user.click(screen.getByText("Correct source key for this project"));
    await user.click(screen.getByLabelText("Project Source Key"));

    const sourceKeyList = screen.getByRole("listbox", { name: "Project Source Key options" });
    expect(getAllByAriaKeyLabel(sourceKeyList as HTMLElement, "G#m").length).toBe(1);
  });

  it("caps target key stepping at one octave in either direction", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await ensureInspectorVisible(user);

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
