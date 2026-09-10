import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricsResponse } from "./lib/api";
import { markPlaybackStarting } from "./lib/playbackDiagnostics";
import { updateBrowserWakeLockStatus } from "./lib/powerInhibition";
import {
  findAudioByArtifactId,
  emitMockNativePlaybackPosition,
  markAudioReady,
  mockCreateStems,
  mockGetChords,
  mockGetAnalysis,
  mockGetProject,
  mockGetLyrics,
  mockInvoke,
  mockListArtifacts,
  mockListJobs,
  mockGetMobileCapabilities,
  mockStartSyncListener,
  resetAppTestHarness,
  renderApp,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
  setProjectArtifacts,
  setMockNativeAudioState,
} from "./test/appTestHarness";

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;
const originalMaxTouchPoints = navigator.maxTouchPoints;

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

function setIOSUserAgent() {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X)",
  });
}

function setIPadDesktopUserAgent() {
  Object.defineProperties(window.navigator, {
    userAgent: { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    platform: { configurable: true, value: "MacIntel" },
    maxTouchPoints: { configurable: true, value: 5 },
  });
}

function enableIOSRuntime() {
  setIOSUserAgent();
  mockGetMobileCapabilities.mockResolvedValue({
    platform: "ios",
    mediaBackend: "cpal_coreaudio",
    isEmulator: true,
    gpuBackend: null,
    analysisAvailable: false,
    basicChordsAvailable: false,
    whisperAvailable: false,
    stemSeparationAvailable: false,
    generationTestingAvailable: false,
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

function setAvailableChords() {
  setProjectChords("proj_123", {
    project_id: "proj_123",
    backend: "tuneforge-fast",
    source_artifact_id: "art_source",
    source_segments: [
      {
        start_seconds: 0,
        end_seconds: 16,
        label: "G",
        confidence: 0.81,
        pitch_class: 7,
        quality: "major",
      },
    ],
    timeline: [
      {
        start_seconds: 0,
        end_seconds: 16,
        label: "G",
        confidence: 0.81,
        pitch_class: 7,
        quality: "major",
      },
    ],
    has_user_edits: false,
    created_at: "2026-04-18T13:16:00.000Z",
    updated_at: "2026-04-18T13:16:00.000Z",
  });
}

function setTempoAnalysis(tempoBpm = 120) {
  setProjectAnalysis("proj_123", {
    project_id: "proj_123",
    estimated_key: "G major",
    key_confidence: 0.82,
    estimated_reference_hz: 440,
    tuning_offset_cents: 0,
    tempo_bpm: tempoBpm,
    analysis_version: "v1",
    created_at: "2026-04-18T13:16:00.000Z",
  });
}

describe("Desktop app mobile capability gates", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperties(window.navigator, {
      userAgent: { configurable: true, value: originalUserAgent },
      platform: { configurable: true, value: originalPlatform },
      maxTouchPoints: { configurable: true, value: originalMaxTouchPoints },
    });
  });

  it("keeps the iOS library sync-directed", async () => {
    enableIOSRuntime();
    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Import Track(s)" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Open Demo Song project" })).toBeInTheDocument();
    expect(screen.queryByText("Show file details")).not.toBeInTheDocument();
  });

  it.each(["pending", "failed"])("keeps the iOS library closed when capabilities are %s", async (state) => {
    setIOSUserAgent();
    if (state === "pending") mockGetMobileCapabilities.mockReturnValue(new Promise(() => {}));
    else mockGetMobileCapabilities.mockRejectedValue(new Error("capabilities unavailable"));
    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Demo Song project" })).not.toBeInTheDocument();
    expect(screen.queryByText("Show file details")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import Track(s)" })).not.toBeInTheDocument();
  });

  it("opens an iOS project directly in the constrained playback workspace", async () => {
    enableIOSRuntime();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Library" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Processing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Project workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More playback actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lyrics + chords" })).not.toBeInTheDocument();
    expect(mockGetProject).toHaveBeenCalledWith("proj_123");
    expect(mockListArtifacts).toHaveBeenCalledWith("proj_123");
    expect(mockGetAnalysis).not.toHaveBeenCalled();
    expect(mockGetChords).not.toHaveBeenCalled();
    expect(mockGetLyrics).not.toHaveBeenCalled();
    expect(mockListJobs).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open Practice Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    expect(within(dialog).getByRole("button", { name: /Source Track/i })).toBeInTheDocument();
    expect(within(dialog).queryByText("Transpose / Capo")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Count-in")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Playback BPM")).not.toBeInTheDocument();
  });

  it("uses registered WAV proxies and omits unsupported iOS playback rows", async () => {
    enableIOSRuntime();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: mockInvoke },
    });
    setMockNativeAudioState({ capabilities: {
      platform: "ios", backend: "ios-coreaudio", nativePlaybackSupported: true,
    } });
    setProjectArtifacts("proj_123", [
      { id: "proxy", project_id: "proj_123", type: "preview_mix", format: "mp3", path: "/private/mix.mp3", metadata: { playback_path: "/private/mix.wav", playback_format: "wav" }, created_at: "2026-04-18T13:16:00.000Z" },
      { id: "unsupported", project_id: "proj_123", type: "source_audio", format: "mp3", path: "/private/source.mp3", metadata: {}, created_at: "2026-04-18T13:16:00.000Z" },
    ]);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Practice Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    expect(within(dialog).getByRole("button", { name: /Practice Mix/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Source Track/i })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close Practice Controls" }));
    await userEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith(
      "audio_prepare_session",
      expect.objectContaining({ payload: expect.objectContaining({ lanes: [expect.objectContaining({ sourcePath: "/private/mix.wav" })] }) }),
    ));
  });

  it("resumes iOS playback with one Play after a lifecycle pause", async () => {
    enableIOSRuntime();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: mockInvoke },
    });
    setMockNativeAudioState({ capabilities: {
      platform: "ios", backend: "ios-coreaudio", nativePlaybackSupported: true,
    } });
    renderApp(["/projects/proj_123"]);

    await userEvent.click(await screen.findByRole("button", { name: "Play playback" }));
    expect(await screen.findByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    act(() => emitMockNativePlaybackPosition({
      sessionId: "proj_123:native:art_source",
      state: "paused",
      positionSeconds: 4,
      durationSeconds: 16,
      timelineRevision: 0,
    }));
    act(() => emitMockNativePlaybackPosition({
      sessionId: "other-session",
      state: "paused",
      positionSeconds: 5,
      durationSeconds: 16,
      timelineRevision: 2,
    }));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    act(() => emitMockNativePlaybackPosition({
      sessionId: "proj_123:native:art_source",
      state: "paused",
      positionSeconds: 6.5,
      durationSeconds: 16,
      timelineRevision: 2,
    }));
    const playButton = await screen.findByRole("button", { name: "Play playback" });
    const playCallsBeforeResume = mockInvoke.mock.calls.filter(([command]) => command === "audio_play").length;

    await userEvent.click(playButton);

    await waitFor(() => expect(
      mockInvoke.mock.calls.filter(([command]) => command === "audio_play"),
    ).toHaveLength(playCallsBeforeResume + 1));
    const playCalls = mockInvoke.mock.calls.filter(([command]) => command === "audio_play");
    const resumeCall = playCalls[playCalls.length - 1];
    expect(resumeCall?.[1]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ timelineRevision: 2 }),
    }));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it.each([
    ["desktop", "macos", "desktop-cpal"],
    ["Android", "android", "android-aaudio"],
  ])("does not treat a newer %s pause as an iOS lifecycle event", async (_label, platform, backend) => {
    enableIOSRuntime();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: mockInvoke },
    });
    setMockNativeAudioState({ capabilities: {
      platform, backend, nativePlaybackSupported: true,
    } });
    renderApp(["/projects/proj_123"]);

    await userEvent.click(await screen.findByRole("button", { name: "Play playback" }));
    expect(await screen.findByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    act(() => emitMockNativePlaybackPosition({
      sessionId: "proj_123:native:art_source",
      state: "paused",
      positionSeconds: 6.5,
      durationSeconds: 16,
      timelineRevision: 2,
    }));

    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pause playback" }));
    await userEvent.click(await screen.findByRole("button", { name: "Play playback" }));
    expect(await screen.findByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("keeps iOS stems in one source group and exposes mute, solo, and reset", async () => {
    enableIOSRuntime();
    setProjectArtifacts("proj_123", [
      {
        id: "group-a",
        project_id: "proj_123",
        type: "preview_mix",
        format: "wav",
        path: "/private/group-a.wav",
        metadata: {},
        created_at: "2026-04-18T13:16:00.000Z",
      },
      ...["vocals", "drums"].map((stem) => ({
        id: `group-a-${stem}`,
        project_id: "proj_123",
        type: `${stem === "vocals" ? "vocal" : stem}_stem`,
        format: "wav",
        path: `/private/group-a-${stem}.wav`,
        metadata: { source_artifact_id: "group-a", stem_source: stem },
        created_at: "2026-04-18T13:16:00.000Z",
      })),
      ...["bass", "guitar"].map((stem) => ({
        id: `group-b-${stem}`,
        project_id: "proj_123",
        type: `${stem}_stem`,
        format: "wav",
        path: `/private/group-b-${stem}.wav`,
        metadata: { source_artifact_id: "group-b", stem_source: stem },
        created_at: "2026-04-18T13:16:00.000Z",
      })),
    ]);
    window.localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        activeWorkspace: "playback",
        selectedArtifactId: "group-b-bass",
        selectedPrimaryArtifactId: "group-a",
      },
    }));
    renderApp(["/projects/proj_123"]);

    await userEvent.click(await screen.findByRole("button", { name: "Open Practice Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    const stemList = within(dialog).getByRole("group", { name: "Playback stem list" });
    expect(within(stemList).getByRole("button", { name: "Mute Guitar" })).toBeInTheDocument();
    expect(within(stemList).queryByRole("button", { name: "Mute Drums" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Full Mix" })).toBeDisabled();

    await userEvent.click(within(stemList).getByRole("button", { name: "Mute Guitar" }));
    await userEvent.click(within(stemList).getByRole("button", { name: "Solo Bass" }));
    const reset = within(dialog).getByRole("button", { name: "Reset stem mute and solo" });
    expect(reset).toBeEnabled();
    await userEvent.click(reset);
    expect(within(stemList).getByRole("button", { name: "Mute Guitar" })).toHaveAttribute(
      "aria-pressed", "false",
    );
  });

  it("fails a project route closed when runtime capabilities fail", async () => {
    setIPadDesktopUserAgent();
    mockGetMobileCapabilities.mockRejectedValue(new Error("capabilities unavailable"));
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify project support");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(mockGetProject).not.toHaveBeenCalled();
    expect(mockListArtifacts).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("audio_prepare_session", expect.anything());
  });

  it("keeps an iOS project route closed while runtime capabilities are pending", () => {
    setIOSUserAgent();
    mockGetMobileCapabilities.mockReturnValue(new Promise(() => {}));
    renderApp(["/projects/proj_123"]);

    expect(screen.getByRole("status")).toHaveTextContent("Loading project runtime");
    expect(mockGetProject).not.toHaveBeenCalled();
    expect(mockListArtifacts).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("audio_prepare_session", expect.anything());
  });

  it("shows only manual sync controls in iOS Activity", async () => {
    enableIOSRuntime();
    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Answer Offer" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Jobs" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Pairing Offer" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Nearby Devices" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Evidence" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Export Evidence" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local Readiness" })).toBeInTheDocument();
  });

  it("keeps iOS pairing available when the listener cannot start", async () => {
    const user = userEvent.setup();
    enableIOSRuntime();
    mockStartSyncListener.mockRejectedValueOnce(new Error("raw native listener detail"));
    renderApp(["/activity"]);

    const startListener = await screen.findByRole("button", { name: "Start Listener" });
    await user.click(startListener);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sync listener could not start. Pairing with a listening peer and Sync Now remain available.",
    );
    expect(startListener).toBeEnabled();
    expect(screen.getByLabelText("Peer pairing code")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Answer Offer" })).toBeInTheDocument();
    expect(screen.queryByText("raw native listener detail")).not.toBeInTheDocument();
  });

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
    await user.click(screen.getByRole("button", { name: "Open Practice Controls" }));

    expect(
      await screen.findByText(
        "Stems are unavailable on this device. Sync desktop-generated stems to practice individual parts.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Generate stems from Project workspace for source track or selected mix.")).not.toBeInTheDocument();
  });

  it("resets synced stem controls from Android Practice Controls without leaving stems", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    await mockCreateStems("proj_123", { source_artifact_id: "art_source" });
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Open Practice Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    const stemList = within(dialog).getByRole("group", { name: "Playback stem list" });
    const resetButton = within(dialog).getByRole("button", { name: "Reset stem mute and solo" });
    expect(resetButton).toBeDisabled();

    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    await user.click(within(stemList).getByRole("button", { name: "Mute Drums" }));
    expect(resetButton).toBeEnabled();
    expect(within(stemList).getByRole("button", { name: "Mute Drums" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(resetButton);
    expect(within(stemList).getByRole("button", { name: "Mute Drums" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(stemList).getAllByRole("button", { name: /Vocals/i })[0]).toHaveClass(
      "artifact-pill--active",
    );
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
    expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Both" })).toHaveAttribute("aria-pressed", "true");
  });

  it("consolidates mobile playback navigation and infrequent actions in the app bar", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));

    const appBar = screen.getByRole("banner");
    expect(within(appBar).getByRole("link", { name: "Back to Library" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(within(appBar).getByRole("heading", { name: "Demo Song" })).toHaveAttribute(
      "title",
      "Demo Song",
    );
    expect(within(appBar).getByText("Playback")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Project workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Lyrics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import Tab" })).not.toBeInTheDocument();

    const overflowTrigger = within(appBar).getByRole("button", {
      name: "More playback actions",
    });
    await user.click(overflowTrigger);
    const menu = within(appBar).getByRole("menu", { name: "Playback actions" });
    expect(within(menu).getByRole("menuitem", { name: "Project workspace" })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Edit Lyrics" })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Import Tab" })).toBeEnabled();
    expect(window.history.state).toMatchObject({
      tuneforgePlaybackOverflow: expect.any(String),
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() =>
      expect(within(appBar).queryByRole("menu", { name: "Playback actions" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(overflowTrigger).toHaveFocus());
    expect(within(appBar).getByRole("heading", { name: "Demo Song" })).toBeInTheDocument();

    const historyBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    await user.click(overflowTrigger);
    expect(within(appBar).getByRole("menu", { name: "Playback actions" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(within(appBar).queryByRole("menu", { name: "Playback actions" })).not.toBeInTheDocument(),
    );
    expect(historyBack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(overflowTrigger).toHaveFocus());
    historyBack.mockRestore();

    await user.click(overflowTrigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(appBar).queryByRole("menu", { name: "Playback actions" })).not.toBeInTheDocument();
    expect(overflowTrigger).toHaveFocus();
  });

  it("makes Practice Controls modal, inert, focus-trapped, and dismissible by every mobile path", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    const trigger = screen.getByRole("button", { name: "Open Practice Controls" });
    const appUnderlay = document.querySelector<HTMLElement>(".app-shell");
    expect(appUnderlay).not.toBeNull();

    await user.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    let closeButton = within(dialog).getByRole("button", { name: "Close Practice Controls" });
    expect(appUnderlay).toHaveAttribute("inert");
    expect(appUnderlay).toHaveAttribute("aria-hidden", "true");
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Practice Controls" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(appUnderlay).not.toHaveAttribute("inert");

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    expect(dialog).toBeInTheDocument();
    const scrim = document.querySelector<HTMLElement>(".mobile-practice-controls__scrim");
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as HTMLElement);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    closeButton = within(dialog).getByRole("button", { name: "Close Practice Controls" });
    await user.click(closeButton);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("flushes typed and mixed debounced tempo edits through every drawer dismissal path", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    setTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    const trigger = screen.getByRole("button", { name: "Open Practice Controls" });

    await user.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    let bpmInput = within(dialog).getByRole("spinbutton", { name: "Playback BPM" });
    fireEvent.change(bpmInput, { target: { value: "96" } });
    fireEvent.keyDown(bpmInput, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    bpmInput = within(dialog).getByRole("spinbutton", { name: "Playback BPM" });
    expect(bpmInput).toHaveValue(96);
    fireEvent.change(bpmInput, { target: { value: "97" } });
    const scrim = document.querySelector<HTMLElement>(".mobile-practice-controls__scrim");
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as HTMLElement);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    bpmInput = within(dialog).getByRole("spinbutton", { name: "Playback BPM" });
    expect(bpmInput).toHaveValue(97);
    fireEvent.change(bpmInput, { target: { value: "98" } });
    await user.click(
      within(dialog).getByRole("button", { name: "Close Practice Controls" }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    bpmInput = within(dialog).getByRole("spinbutton", { name: "Playback BPM" });
    expect(bpmInput).toHaveValue(98);
    await user.click(
      within(dialog).getByRole("button", { name: "Increase playback tempo" }),
    );
    expect(bpmInput).toHaveValue(99);
    expect(within(dialog).getByText("98 BPM (0.817x)")).toBeInTheDocument();
    fireEvent.change(bpmInput, { target: { value: "104" } });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    expect(bpmInput).toHaveValue(104);
    expect(within(dialog).getByText("98 BPM (0.817x)")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    expect(within(dialog).getByRole("spinbutton", { name: "Playback BPM" })).toHaveValue(104);
    expect(within(dialog).getByText("104 BPM (0.867x)")).toBeInTheDocument();
  });

  it("preserves playback and lane preferences while opening mobile chrome", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Chords" }));
    const follow = screen.getByRole("button", { name: "Follow chords" });
    await user.click(follow);
    expect(follow).toHaveAttribute("aria-pressed", "false");

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    const pauseButton = await screen.findByRole("button", { name: "Pause playback" });
    const playbackPosition = sourceAudio.currentTime;

    const trigger = screen.getByRole("button", { name: "Open Practice Controls" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Practice Controls" });
    expect(within(dialog).getByRole("group", { name: "Playback source and mix list" })).toBeInTheDocument();
    expect(sourceAudio.currentTime).toBeCloseTo(playbackPosition, 3);
    expect(pauseButton).toHaveAttribute("aria-label", "Pause playback");

    await user.click(within(dialog).getByRole("button", { name: "Close Practice Controls" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Chords" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Follow chords" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(sourceAudio.currentTime).toBeCloseTo(playbackPosition, 3);
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
    const heading = (header as HTMLElement).querySelector(
      ".playback-practice-surface__heading",
    );
    const controls = (header as HTMLElement).querySelector(
      ".playback-practice-surface__controls",
    );
    expect(heading).not.toBeNull();
    expect(controls).not.toBeNull();
    const modeToggle = within(header as HTMLElement).getByRole("group", {
      name: "Playback display mode",
    });
    const lyricsToggle = within(modeToggle).getByRole("button", { name: "Lyrics" });
    const chordsToggle = within(modeToggle).getByRole("button", { name: "Chords" });
    const bothToggle = within(modeToggle).getByRole("button", { name: "Both" });
    const combinedFollow = within(header as HTMLElement).getByRole("button", {
      name: "Follow lyrics and chords",
    });
    expect(combinedFollow).toBeEnabled();
    expect(combinedFollow).toHaveTextContent(/^Follow$/);
    expect(combinedFollow).toHaveAttribute("title", "Follow lyrics and chords");
    expect(heading).toContainElement(combinedFollow);
    expect(controls).toContainElement(modeToggle);
    expect(controls).not.toContainElement(combinedFollow);
    expect((header as HTMLElement).querySelector(".playback-practice-actions")).toBeNull();
    expect(
      combinedFollow.compareDocumentPosition(modeToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const combinedLeadSheet = within(surface as HTMLElement).getByRole("group", {
      name: "Lyrics and chords lead sheet",
    });
    expect(header).not.toContainElement(combinedLeadSheet);

    await user.click(chordsToggle);
    expect(await within(surface as HTMLElement).findByRole("heading", { name: "Chords" })).toBeInTheDocument();
    expect(lyricsToggle).toHaveAttribute("aria-pressed", "false");
    expect(chordsToggle).toHaveAttribute("aria-pressed", "true");
    expect(bothToggle).toHaveAttribute("aria-pressed", "false");
    expect(within(surface as HTMLElement).getByRole("group", { name: "Chord timeline" })).toBeInTheDocument();
    const chordsFollow = within(header as HTMLElement).getByRole("button", { name: "Follow chords" });
    expect(chordsFollow).toBeEnabled();
    await user.click(chordsFollow);
    expect(chordsFollow).toHaveAttribute("aria-pressed", "false");

    await user.click(bothToggle);
    expect(await within(surface as HTMLElement).findByRole("heading", { name: "Lyrics + chords" })).toBeInTheDocument();
    expect(lyricsToggle).toHaveAttribute("aria-pressed", "false");
    expect(chordsToggle).toHaveAttribute("aria-pressed", "false");
    expect(bothToggle).toHaveAttribute("aria-pressed", "true");
    expect(
      within(header as HTMLElement).getByRole("button", { name: "Follow lyrics and chords" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(lyricsToggle);
    expect(await within(surface as HTMLElement).findByRole("heading", { name: "Lyrics" })).toBeInTheDocument();
    expect(lyricsToggle).toHaveAttribute("aria-pressed", "true");
    expect(chordsToggle).toHaveAttribute("aria-pressed", "false");
    expect(bothToggle).toHaveAttribute("aria-pressed", "false");
    expect(within(surface as HTMLElement).getByRole("group", { name: "Lyrics transcript" })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: "Follow lyrics" })).toBeEnabled();

    await user.click(chordsToggle);
    expect(within(header as HTMLElement).getByRole("button", { name: "Follow chords" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("disables Chords Follow truthfully when the timeline is unavailable", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    setEmptyChords();
    const { queryClient } = renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Chords" }));

    const follow = screen.getByRole("button", { name: "Follow chords" });
    expect(follow).toBeDisabled();
    expect(follow).toHaveAttribute("aria-pressed", "false");
    expect(follow).toHaveAttribute("title", "Follow requires a chord timeline.");
    expect(follow).toHaveAttribute(
      "aria-describedby",
      "playback-follow-unavailable-description",
    );
    const unavailableExplanation = screen.getByText("Follow requires a chord timeline.");
    expect(unavailableExplanation).toBeInTheDocument();
    expect(follow.closest(".playback-practice-surface__heading")).toContainElement(
      unavailableExplanation,
    );
    const storedState = JSON.parse(
      window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
    ) as { proj_123?: { chordsFollowEnabled?: boolean } };
    expect(storedState.proj_123?.chordsFollowEnabled).toBe(true);

    setAvailableChords();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["chords", "proj_123"] });
    });
    await waitFor(() => expect(follow).toBeEnabled());
    expect(follow).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Follow requires a chord timeline.")).not.toBeInTheDocument();
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
    const recoveredStoredState = JSON.parse(
      window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
    ) as { proj_123?: { playbackDisplayMode?: string } };
    expect(recoveredStoredState.proj_123?.playbackDisplayMode).toBe("lyrics");

    await user.click(screen.getByRole("button", { name: "Lyrics" }));
    expect(screen.getByRole("heading", { name: "Lyrics" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Follow lyrics" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Follow lyrics" })).toHaveAttribute(
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

    expect(screen.getByRole("button", { name: "Follow lyrics and chords" })).toBeDisabled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps Android-capability seek, pause, resume, highlight, and follow behavior", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    const combinedLeadSheet = screen.getByRole("group", {
      name: "Lyrics and chords lead sheet",
    });
    const combinedBody = combinedLeadSheet.closest<HTMLElement>(".playback-practice-body");
    expect(combinedBody).not.toBeNull();
    const combinedScrollTo = vi.fn();
    const combinedContentScrollTo = vi.fn();
    Object.defineProperties(combinedBody as HTMLElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: combinedScrollTo },
    });
    Object.defineProperty(combinedLeadSheet, "scrollTo", {
      configurable: true,
      value: combinedContentScrollTo,
    });
    const secondCombinedLyric = within(combinedLeadSheet).getByRole("button", { name: /0:08/i });
    await user.click(secondCombinedLyric);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(secondCombinedLyric.className).toContain("lead-sheet__row--active"));
    await waitFor(() => expect(combinedScrollTo).toHaveBeenCalled());
    expect(combinedContentScrollTo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Pause playback" }));

    await user.click(screen.getByRole("button", { name: "Lyrics" }));
    const leadSheet = screen.getByRole("group", { name: "Lyrics transcript" });
    const lyricsBody = leadSheet.closest<HTMLElement>(".playback-practice-body");
    expect(lyricsBody).not.toBeNull();
    const scrollTo = vi.fn();
    const contentScrollTo = vi.fn();
    Object.defineProperties(lyricsBody as HTMLElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    Object.defineProperty(leadSheet, "scrollTo", {
      configurable: true,
      value: contentScrollTo,
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
    expect(contentScrollTo).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    const pausedTime = sourceAudio.currentTime;
    expect(pausedTime).toBeGreaterThanOrEqual(8);
    expect(pausedTime).toBeLessThan(9);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    expect(await screen.findByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(sourceAudio.currentTime).toBeCloseTo(pausedTime, 1);

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await user.click(screen.getByRole("button", { name: "Chords" }));
    const chordTimeline = screen.getByRole("group", { name: "Chord timeline" });
    const chordScrollTo = vi.fn();
    Object.defineProperties(chordTimeline, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: chordScrollTo },
    });
    const secondChord = within(chordTimeline).getByRole("button", { name: /0:16/i });
    await user.click(secondChord);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(secondChord).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(chordScrollTo).toHaveBeenCalled());
  });

  it("keeps mobile Web Audio status beside an interactive scrubber and clocks", async () => {
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    fireEvent.click(await screen.findByRole("tab", { name: "Playback" }));
    act(() => {
      markPlaybackStarting("web");
      updateBrowserWakeLockStatus({
        phase: "failed",
        backend: "browser-screen-wake-lock",
        screenProtected: false,
        errorMessage: "Screen wake lock is unavailable.",
      });
    });

    const status = await screen.findByText("Starting playback…");
    const scrubber = screen.getByRole("slider", { name: "Playback position" });
    const statusStack = status.closest<HTMLElement>(".transport__status-stack");
    const scrubberLabel = scrubber.closest("label");
    expect(statusStack).not.toBeNull();
    expect(within(statusStack as HTMLElement).getByText("Screen wake lock is unavailable.")).toBeInTheDocument();
    expect(within(statusStack as HTMLElement).getAllByRole("status")).toHaveLength(2);
    expect(scrubberLabel).not.toBeNull();
    expect(scrubberLabel).not.toContainElement(status);
    expect(within(scrubberLabel as HTMLElement).getByText("0:00")).toBeInTheDocument();
    expect(within(scrubberLabel as HTMLElement).getByText("3:02")).toBeInTheDocument();

    fireEvent.change(scrubber, { target: { value: "10" } });
    await waitFor(() => expect(scrubber).toHaveValue("10"));
  });
});
