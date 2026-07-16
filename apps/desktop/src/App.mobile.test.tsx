import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricsResponse } from "./lib/api";
import {
  findAudioByArtifactId,
  markAudioReady,
  mockGetChords,
  mockGetLyrics,
  mockGetMobileCapabilities,
  resetAppTestHarness,
  renderApp,
  setProjectChords,
  setProjectLyrics,
} from "./test/appTestHarness";

function enableAndroidRuntime() {
  mockGetMobileCapabilities.mockResolvedValue({
    platform: "android",
    mediaBackend: "android_media_codec",
    isEmulator: true,
    gpuBackend: null,
    analysisAvailable: true,
    basicChordsAvailable: true,
    whisperAvailable: false,
    stemSeparationAvailable: false,
    generationTestingAvailable: true,
    maxRecommendedModel: null,
    cpuFallbackAllowed: false,
  });
}

function emptyLyrics(projectId = "proj_123"): LyricsResponse {
  return {
    project_id: projectId,
    backend: null,
    source_artifact_id: null,
    source_kind: null,
    source_segments: [],
    segments: [],
    has_user_edits: false,
    created_at: null,
    updated_at: null,
  };
}

function setEmptyChords() {
  setProjectChords("proj_123", {
    project_id: "proj_123",
    backend: null,
    source_artifact_id: null,
    source_segments: [],
    timeline: [],
    has_user_edits: false,
    created_at: null,
    updated_at: null,
  });
}

describe("Desktop app mobile capability gates", () => {
  beforeEach(resetAppTestHarness);

  it("disables generation actions when mobile acceleration is unavailable", async () => {
    mockGetMobileCapabilities.mockResolvedValue({
      platform: "android",
      mediaBackend: "android_media_codec",
      isEmulator: false,
      gpuBackend: null,
      analysisAvailable: true,
      basicChordsAvailable: true,
      whisperAvailable: false,
      stemSeparationAvailable: false,
      generationTestingAvailable: false,
      maxRecommendedModel: null,
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Processing" })).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Side-load a Whisper model to enable local lyrics. Stem generation is unavailable on this device.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Analyze Track" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Refresh Chords" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Generate Stems" })).toBeDisabled();
  });

  it("shows synced-stems guidance in mobile playback when local stems are unavailable", async () => {
    const user = userEvent.setup();
    mockGetMobileCapabilities.mockResolvedValue({
      platform: "android",
      mediaBackend: "android_media_codec",
      isEmulator: false,
      gpuBackend: null,
      analysisAvailable: true,
      basicChordsAvailable: true,
      whisperAvailable: false,
      stemSeparationAvailable: false,
      generationTestingAvailable: false,
      maxRecommendedModel: null,
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));

    expect(
      await screen.findByText(
        "Stems are unavailable on this device. Sync desktop-generated stems to practice individual parts.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Generate stems from Project workspace for source track or selected mix.")).not.toBeInTheDocument();
  });

  it("allows emulator lyrics flow testing while keeping stems disabled", async () => {
    mockGetMobileCapabilities.mockResolvedValue({
      platform: "android",
      mediaBackend: "android_media_codec",
      isEmulator: true,
      gpuBackend: null,
      analysisAvailable: true,
      basicChordsAvailable: true,
      whisperAvailable: false,
      stemSeparationAvailable: false,
      generationTestingAvailable: true,
      maxRecommendedModel: null,
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    expect(
      await screen.findByText(
        "Emulator lyrics actions are enabled for flow testing; stem generation is unavailable on this device.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Generate Stems" })).toBeDisabled();
  });

  it("enables local lyrics when a side-loaded Whisper model is available", async () => {
    mockGetMobileCapabilities.mockResolvedValue({
      platform: "android",
      mediaBackend: "android_media_codec",
      isEmulator: false,
      gpuBackend: null,
      analysisAvailable: true,
      basicChordsAvailable: true,
      whisperAvailable: true,
      stemSeparationAvailable: false,
      generationTestingAvailable: false,
      maxRecommendedModel: "base",
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    expect(
      await screen.findByText("Local lyrics are available. Stem generation is unavailable on this device."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Generate Stems" })).toBeDisabled();
  });

  it("keeps generation controls out of the playback workspace", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));

    const playbackSurface = screen.getByRole("heading", { name: "Lyrics + chords" }).closest("main");
    expect(playbackSurface).not.toBeNull();
    expect(
      within(playbackSurface as HTMLElement).queryByRole("button", { name: /Generate|Refresh/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lyrics and chords lead sheet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps mobile Practice controls reachable while switching every display mode", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    const surface = screen.getByRole("heading", { name: "Lyrics + chords" }).closest("main");
    expect(surface).not.toBeNull();
    const header = (surface as HTMLElement).querySelector(".playback-practice-surface__header");
    expect(header).not.toBeNull();
    const modeToggle = within(header as HTMLElement).getByRole("group", {
      name: "Playback display mode",
    });
    const lyricsToggle = within(modeToggle).getByRole("button", { name: "Lyrics" });
    const chordsToggle = within(modeToggle).getByRole("button", { name: "Chords" });
    expect(within(header as HTMLElement).getByRole("button", { name: "Lyrics Follow" })).toBeEnabled();
    const combinedLeadSheet = within(surface as HTMLElement).getByRole("group", {
      name: "Lyrics and chords lead sheet",
    });
    expect(header).not.toContainElement(combinedLeadSheet);

    await user.click(lyricsToggle);
    expect(await within(surface as HTMLElement).findByRole("heading", { name: "Chords" })).toBeInTheDocument();
    expect(lyricsToggle).toHaveAttribute("aria-pressed", "false");
    expect(chordsToggle).toHaveAttribute("aria-pressed", "true");
    expect(within(surface as HTMLElement).getByRole("group", { name: "Chord timeline" })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: "Chords Follow" })).toBeEnabled();

    await user.click(lyricsToggle);
    expect(await within(surface as HTMLElement).findByRole("heading", { name: "Lyrics + chords" })).toBeInTheDocument();
    expect(lyricsToggle).toHaveAttribute("aria-pressed", "true");
    expect(chordsToggle).toHaveAttribute("aria-pressed", "true");

    await user.click(chordsToggle);
    expect(await within(surface as HTMLElement).findByRole("heading", { name: "Lyrics" })).toBeInTheDocument();
    expect(lyricsToggle).toHaveAttribute("aria-pressed", "true");
    expect(chordsToggle).toHaveAttribute("aria-pressed", "false");
    expect(within(surface as HTMLElement).getByRole("group", { name: "Lyrics transcript" })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: "Lyrics Follow" })).toBeEnabled();
  });

  it("keeps loading distinct from confirmed absence before resolving auto mode", async () => {
    const user = userEvent.setup();
    let resolveLyrics!: (lyrics: LyricsResponse) => void;
    const lyricsPromise = new Promise<LyricsResponse>((resolve) => {
      resolveLyrics = resolve;
    });
    enableAndroidRuntime();
    mockGetLyrics.mockImplementationOnce(() => lyricsPromise);
    setEmptyChords();

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    expect(await screen.findByText("Loading practice data…")).toBeInTheDocument();
    expect(screen.queryByText(/Generate lyrics and chords/i)).not.toBeInTheDocument();

    await act(async () => {
      resolveLyrics(emptyLyrics());
      await lyricsPromise;
    });

    expect(
      await screen.findByText(
        "No lyrics or chords on this device. Sync them from desktop, or use available Project tools.",
      ),
    ).toBeInTheDocument();
  });

  it("shows synced chords with a privacy-safe partial read failure", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    mockGetLyrics.mockRejectedValueOnce(new Error("private/device/path/lyrics.json"));

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    expect(await screen.findByRole("heading", { name: "Chords" })).toBeInTheDocument();
    expect(
      screen.getByText("Lyrics couldn’t be loaded; showing chords."),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Chord timeline" })).toBeInTheDocument();
    expect(screen.queryByText(/private\/device\/path/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate|Refresh/i })).not.toBeInTheDocument();
  });

  it("temporarily falls back from an unavailable stored lane without overwriting it", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    setProjectLyrics("proj_123", emptyLyrics());
    window.localStorage.setItem(
      "tuneforge.project-playback-state",
      JSON.stringify({
        proj_123: {
          activeWorkspace: "playback",
          playbackDisplayMode: "lyrics",
        },
      }),
    );

    const { queryClient } = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Chords" })).toBeInTheDocument();
    expect(screen.getByText("No lyrics on this device; showing chords.")).toBeInTheDocument();
    await waitFor(() => {
      const storedState = JSON.parse(
        window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
      ) as { proj_123?: { playbackDisplayMode?: string } };
      expect(storedState.proj_123?.playbackDisplayMode).toBe("lyrics");
    });

    await user.click(screen.getByRole("button", { name: "Lyrics" }));
    expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "true");

    setProjectLyrics("proj_123", {
      ...emptyLyrics(),
      backend: "synced",
      segments: [
        {
          start_seconds: 0,
          end_seconds: 8,
          text: "Recovered synced lyric",
          words: [],
        },
      ],
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["lyrics", "proj_123"] });
    });

    await waitFor(() =>
      expect(screen.queryByText("No lyrics on this device; showing chords.")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Lyrics + chords" })).toBeInTheDocument();
    const recoveredStoredState = JSON.parse(
      window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
    ) as { proj_123?: { playbackDisplayMode?: string } };
    expect(recoveredStoredState.proj_123?.playbackDisplayMode).toBe("combined");
  });

  it("keeps untimed synced lyrics static without activating Lyrics Follow", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    setEmptyChords();
    setProjectLyrics("proj_123", {
      ...emptyLyrics(),
      backend: "synced",
      segments: [
        {
          start_seconds: null,
          end_seconds: null,
          text: "Static synced lyric",
          words: [],
        },
      ],
    });

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    expect(await screen.findByRole("heading", { name: "Lyrics" })).toBeInTheDocument();
    expect(screen.getByText("Static synced lyric")).toBeInTheDocument();
    expect(screen.getByText("Static")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lyrics Follow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lyrics Follow" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("keeps synced lyrics visible when chords fail to load", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    mockGetChords.mockRejectedValueOnce(new Error("private/device/path/chords.json"));

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    expect(await screen.findByRole("heading", { name: "Lyrics" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lyrics transcript" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Chords couldn’t be loaded; showing lyrics.",
    );
    expect(screen.queryByText(/private\/device\/path/i)).not.toBeInTheDocument();
  });

  it("reports both failed synced lanes without showing generation prompts", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    mockGetLyrics.mockRejectedValueOnce(new Error("lyrics private path"));
    mockGetChords.mockRejectedValueOnce(new Error("chords private path"));

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Lyrics and chords couldn’t be loaded on this device.",
    );
    expect(screen.queryByRole("button", { name: /Generate|Refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/private path/i)).not.toBeInTheDocument();
  });

  it("keeps retained lyrics visible when a refresh fails", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    const { queryClient } = renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();

    mockGetLyrics.mockRejectedValueOnce(new Error("refresh private path"));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["lyrics", "proj_123"] });
    });

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lyrics and chords lead sheet" })).toBeInTheDocument();
    expect(
      await screen.findByText("Lyrics couldn’t be refreshed; showing available lyrics."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/refresh private path/i)).not.toBeInTheDocument();
  });

  it("does not auto-scroll combined chord rows when synced lyrics are untimed", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    setProjectLyrics("proj_123", {
      ...emptyLyrics(),
      backend: "synced",
      segments: [
        {
          start_seconds: null,
          end_seconds: null,
          text: "Static synced lyric",
          words: [],
        },
      ],
    });

    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    const leadSheet = screen.getByRole("group", { name: "Lyrics and chords lead sheet" });
    const scrollTo = vi.fn();
    Object.defineProperty(leadSheet, "scrollTo", { configurable: true, value: scrollTo });
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    fireEvent.timeUpdate(sourceAudio);

    expect(screen.getByRole("button", { name: "Lyrics Follow" })).toBeDisabled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps Android-capability seek, pause, resume, highlight, and follow behavior", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Chords" }));
    const leadSheet = screen.getByRole("group", { name: "Lyrics transcript" });
    const scrollTo = vi.fn();
    Object.defineProperties(leadSheet, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    const secondLyric = within(leadSheet).getByRole("button", { name: /0:08/i });

    await user.click(secondLyric);
    expect(sourceAudio.currentTime).toBeCloseTo(8, 3);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(secondLyric.className).toContain("lead-sheet__row--active"));
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    const pausedTime = sourceAudio.currentTime;
    expect(pausedTime).toBeGreaterThanOrEqual(8);
    expect(pausedTime).toBeLessThan(9);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    expect(await screen.findByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(sourceAudio.currentTime).toBeCloseTo(pausedTime, 1);
  });
});
