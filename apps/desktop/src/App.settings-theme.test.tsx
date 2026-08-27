import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRONTEND_VERSION_INFO } from "./lib/buildInfo";
import { DEFAULT_PREFERENCES } from "./lib/preferences";
import {
  resetAppTestHarness,
  getAllByAriaKeyLabel,
  getByAriaKeyLabel,
  installMatchMediaMock,
  mockInvoke,
  mockConfirm,
  mockGetExportCapabilities,
  mockListBeatBackends,
  mockListChordBackends,
  queryByAriaKeyLabel,
  renderApp,
  setBeatBackends,
  setChordBackends,
  setMockNativeAudioState,
  setProjectAnalysis,
  setProjectChords,
} from "./test/appTestHarness";

describe("Desktop app settings theme", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => vi.unstubAllEnvs());

  async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "Playback" }));
  }

  async function switchToChordsOnly(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Lyrics" }));
  }

  async function ensureInspectorVisible(user: ReturnType<typeof userEvent.setup>) {
    const showInspectorButton = screen.queryByRole("button", { name: "Show Inspector" });
    if (showInspectorButton) {
      await user.click(showInspectorButton);
    }
  }

  function settingsSnapshotContents(
    preferences: typeof DEFAULT_PREFERENCES,
    themePreference: "dark" | "light" | "system",
    themeOverrides: Record<string, Record<string, string>> = {},
  ) {
    return JSON.stringify({
      exportedAt: "2026-04-18T13:16:00.000Z",
      kind: "tuneforge.settings",
      preferences,
      themeOverrides,
      themePreference,
      version: 2,
    });
  }

  it("applies enharmonic display overrides from settings", async () => {
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
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "D#m")).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Next chord card" }), "A#")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Project" }));
    await ensureInspectorVisible(user);

    const sourceKeyCard = screen.getByText("Source Key", { selector: "span" }).closest("div") as HTMLElement;
    expect(getByAriaKeyLabel(sourceKeyCard, "D#m")).toBeInTheDocument();
    expect(queryByAriaKeyLabel(sourceKeyCard, "Ebm")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Target Key"));
    const targetKeyList = screen.getByRole("listbox", { name: "Target key options" });
    expect(getAllByAriaKeyLabel(targetKeyList as HTMLElement, "D#m").length).toBeGreaterThan(0);
    expect(queryByAriaKeyLabel(targetKeyList as HTMLElement, "Ebm")).not.toBeInTheDocument();
  });

  it("uses new default appearance and playback settings", async () => {
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Auto by key/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^Open inspector by default/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Collapse sources rail by default/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project first/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^AutoUse lyrics \+ chords/ })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Audio Storage" })).toBeInTheDocument();
    const durableFormats = screen.getByRole("group", { name: "New durable audio format" });
    expect(within(durableFormats).getByRole("button", { name: /^WAV\/PCM/ }))
      .toHaveTextContent("Available · Lossless · Default");
    expect(within(durableFormats).getByRole("button", { name: /^FLAC/ }))
      .toHaveTextContent("Available · Lossless");
    expect(within(durableFormats).getByRole("button", { name: /^MP3/ }))
      .toHaveTextContent("Available · Lossy");
    expect(within(durableFormats).getByRole("button", { name: /^M4A/ }))
      .toHaveTextContent("Available · Lossy");
    expect(within(durableFormats).getByRole("button", { name: /^WAV\/PCM/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(
      within(screen.getByRole("group", { name: "Default beat analysis" })).getAllByRole("button")[0],
    ).toHaveTextContent("Advanced Beat Analysis");
    expect(
      within(screen.getByRole("group", { name: "Default chord backend" })).getAllByRole("button")[0],
    ).toHaveTextContent("Advanced Chords — Crema (TensorFlow)");
    expect(within(screen.getByRole("group", { name: "Default chord backend" })).getAllByRole("button"))
      .toHaveLength(3);
    expect(screen.getByRole("button", { name: /^Enable lyrics follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable chords follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("system");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
      informationDensity: "minimal",
      enharmonicDisplayMode: "auto",
      defaultInspectorOpen: true,
      defaultSourcesRailCollapsed: false,
      defaultProjectWorkspace: "project",
      defaultPlaybackDisplayMode: "auto",
      defaultBeatAnalysisBackend: "beat-this",
      defaultChordBackend: "crema-advanced",
      defaultDurableAudioFormat: "wav",
      defaultLyricsFollowEnabled: true,
      defaultChordsFollowEnabled: true,
      defaultTunerInputDeviceId: null,
      defaultTunerReferenceHz: 440,
      defaultTunerVisualMode: "wide-arc",
    });
  });

  it("confirms lossy audio storage choices and resets to WAV", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Audio Storage" })).toBeInTheDocument();
    const audioFormats = screen.getByRole("group", { name: "New durable audio format" });
    await waitFor(() => expect(within(audioFormats).getByRole("button", { name: /^MP3 \(192 kbps\)/ })).toBeEnabled());
    await user.click(within(audioFormats).getByRole("button", { name: /^MP3 \(192 kbps\)/ }));

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringMatching(/irreversible.*cannot be recovered.*new imports.*bulk stem refreshes/is),
      expect.objectContaining({ okLabel: "Use MP3" }),
    );
    expect(within(audioFormats).getByRole("button", { name: /^MP3 \(192 kbps\)/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ defaultDurableAudioFormat: "mp3" });

    await user.click(within(audioFormats).getByRole("button", { name: /^M4A \(AAC-LC, 192 kbps\)/ }));
    expect(mockConfirm).toHaveBeenLastCalledWith(
      expect.stringMatching(/irreversible.*cannot be recovered/is),
      expect.objectContaining({ okLabel: "Use M4A" }),
    );
    expect(within(audioFormats).getByRole("button", { name: /^M4A \(AAC-LC, 192 kbps\)/ }))
      .toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Audio Storage" }));
    expect(within(audioFormats).getByRole("button", { name: /^WAV\/PCM/ }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("retains a persisted unavailable format without fallback", async () => {
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultDurableAudioFormat: "m4a" }),
    );
    mockGetExportCapabilities.mockResolvedValueOnce({
      capabilities: {
        platform: "desktop",
        formats: [
          { id: "wav", available: true, reason: null },
          { id: "flac", available: true, reason: null },
          { id: "mp3", available: false, reason: "MP3 encoder missing." },
          { id: "m4a", available: false, reason: "AAC encoder missing." },
        ],
        destinations: [],
        max_artifact_count: null,
      },
    });
    renderApp(["/settings"]);

    const savedChoice = await screen.findByRole("button", { name: /^M4A \(AAC-LC, 192 kbps\)/ });
    await waitFor(() => expect(savedChoice).toBeDisabled());
    expect(savedChoice).toHaveAttribute("aria-pressed", "true");
    expect(savedChoice).toHaveTextContent("Selected · Unavailable — AAC encoder missing.");
    expect(screen.getByRole("button", { name: /^MP3 \(192 kbps\)/ }))
      .toHaveTextContent("Unavailable — MP3 encoder missing.");
    expect(screen.getByText(
      "M4A (AAC-LC, 192 kbps) is saved but unavailable on this desktop: AAC encoder missing. Choose an available format before creating new audio.",
    )).toBeInTheDocument();
  });

  it("keeps the persisted format pressed while availability is loading", async () => {
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultDurableAudioFormat: "flac" }),
    );
    let resolveCapabilities: ((value: Awaited<ReturnType<typeof mockGetExportCapabilities>>) => void) | null = null;
    mockGetExportCapabilities.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCapabilities = resolve;
      }),
    );
    renderApp(["/settings"]);

    const group = await screen.findByRole("group", { name: "New durable audio format" });
    expect(group).toHaveAttribute("aria-busy", "true");
    expect(within(group).getByRole("button", { name: /^FLAC/ })).toHaveAttribute("aria-pressed", "true");
    for (const button of within(group).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText("Checking audio format availability…")).toHaveAttribute("aria-live", "polite");

    await act(async () => {
      resolveCapabilities?.({
        capabilities: {
          platform: "desktop",
          formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({ id, available: true, reason: null })),
          destinations: [],
          max_artifact_count: null,
        },
      });
    });
    await waitFor(() => expect(group).not.toHaveAttribute("aria-busy"));
  });

  it("disables audio choices and retry while an availability retry is fetching", async () => {
    const user = userEvent.setup();
    mockGetExportCapabilities.mockRejectedValueOnce(new Error("offline"));
    renderApp(["/settings"]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Audio format availability could not be checked. Check FFmpeg, then try again.",
    );
    let resolveRetry: ((value: Awaited<ReturnType<typeof mockGetExportCapabilities>>) => void) | null = null;
    mockGetExportCapabilities.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const retry = screen.getByRole("button", { name: "Retry" });
    const group = screen.getByRole("group", { name: "New durable audio format" });
    expect(retry).toBeDisabled();
    expect(group).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    for (const choice of within(group).getAllByRole("button")) {
      expect(choice).toBeDisabled();
      expect(choice).toHaveTextContent("Checking availability…");
    }
    await user.click(retry);
    expect(mockGetExportCapabilities).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveRetry?.({
        capabilities: {
          platform: "desktop",
          formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({ id, available: true, reason: null })),
          destinations: [],
          max_artifact_count: null,
        },
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /^WAV\/PCM/ })).toBeEnabled());
  });

  it("hides audio storage settings when capabilities report Android", async () => {
    mockGetExportCapabilities.mockResolvedValueOnce({
      capabilities: {
        platform: "android",
        formats: [{ id: "wav", available: true, reason: null }],
        destinations: [],
        max_artifact_count: 1,
      },
    });
    renderApp(["/settings"]);

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Audio Storage" })).not.toBeInTheDocument());
    expect(screen.queryByText("New audio format")).not.toBeInTheDocument();
    expect(screen.getByText("App-wide appearance, notation, and playback defaults.")).toBeInTheDocument();
    expect(screen.queryByText(/audio storage/i)).not.toBeInTheDocument();
  });

  it("persists theme and visible UI preferences", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        backend: "desktop-cpal",
        micCaptureSupported: true,
        nativePlaybackSupported: false,
      },
      snapshot: {
        fallbackReason: "buffer underrun on native lane vocals",
        bufferHealth: [
          {
            laneId: "vocals",
            artifactId: "art_vocals",
            role: "stem",
            ringFillSamples: 1200,
            ringCapacitySamples: 4800,
            underrunCount: 3,
            workerErrorCount: 1,
            lastWorkerError: "decoder stalled",
          },
        ],
      },
    });
    window.localStorage.setItem(
      "tuneforge.tuner-input-capture-backend",
      JSON.stringify({ backend: "native", detail: "desktop-cpal" }),
    );
    window.localStorage.setItem("tuneforge.tuner-native-capture-error", "Native microphone failed.");
    window.localStorage.setItem(
      "tuneforge.playback-backend",
      JSON.stringify({ backend: "web", detail: null }),
    );
    window.localStorage.setItem("tuneforge.playback-native-error", "Native output failed.");
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Light/ }));
    await user.click(screen.getByRole("button", { name: /^Detailed/ }));
    await user.click(screen.getByRole("button", { name: /^Prefer sharps/ }));
    await user.click(screen.getByRole("button", { name: /^Playback first/ }));
    await user.click(screen.getByRole("button", { name: /^Lyrics \+ chords/ }));
    await user.click(screen.getByRole("button", { name: /^Beat/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Beat Analysis/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/ }));
    await user.click(screen.getByText("Show diagnostics"));
    expect(await screen.findByText("/tmp/tuneforge")).toBeInTheDocument();
    expect(screen.getByText("Backend Package Version")).toBeInTheDocument();
    expect(screen.getByText("Backend Git Ref")).toBeInTheDocument();
    expect(screen.getByText("backend-test-ref")).toBeInTheDocument();
    expect(screen.getByText("Frontend Package Version")).toBeInTheDocument();
    expect(screen.getByText("Frontend Git Ref")).toBeInTheDocument();
    expect(screen.getByText(FRONTEND_VERSION_INFO.git_ref)).toBeInTheDocument();
    expect(screen.getByText("Available (desktop-cpal)")).toBeInTheDocument();
    expect(screen.getByText("Native (desktop-cpal)")).toBeInTheDocument();
    expect(screen.getByText(/^Unavailable —/)).toBeInTheDocument();
    expect(screen.getByText("Native microphone failed.")).toBeInTheDocument();
    expect(screen.getByText("Native output failed.")).toBeInTheDocument();
    expect(screen.getByText("Latest Native Fallback Cause")).toBeInTheDocument();
    expect(screen.getAllByText("None").length).toBeGreaterThan(0);
    expect(screen.getByText("Native Playback Buffer Health")).toBeInTheDocument();
    expect(screen.getByText("No active native lanes")).toBeInTheDocument();
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current Playback" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Previous Playback Issues" })).toBeInTheDocument();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#F4F7FB");
    expect(document.documentElement.style.getPropertyValue("--component-playback-active")).toBe("#D9861A");
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
        informationDensity: "detailed",
        enharmonicDisplayMode: "sharps",
        defaultInspectorOpen: true,
        defaultSourcesRailCollapsed: false,
        defaultProjectWorkspace: "playback",
        defaultPlaybackDisplayMode: "combined",
        defaultLoopAlignmentMode: "beat",
        defaultBeatAnalysisBackend: "beat-this",
        defaultChordBackend: "crema-advanced",
        defaultLyricsFollowEnabled: true,
        defaultChordsFollowEnabled: true,
      }),
    );
  });

  it("shows forced Web Audio diagnostics", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
    setMockNativeAudioState({
      capabilities: {
        backend: "desktop-cpal",
        micCaptureSupported: true,
        nativePlaybackSupported: true,
      },
    });
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByText("Show diagnostics"));

    expect(await screen.findByText("/tmp/tuneforge")).toBeInTheDocument();
    expect(screen.getByText("Web Audio forced at build time")).toBeInTheDocument();
    expect(screen.getByText("Forced Web Audio")).toBeInTheDocument();
    expect(screen.getByText("Available (desktop-cpal)")).toBeInTheDocument();
    expect(screen.getByText("Native (desktop-cpal)")).toBeInTheDocument();
    expect(screen.getByText("Not playing")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("audio_get_capabilities");
  });

  it("hides native audio diagnostics when the diagnostic environment is disabled", async () => {
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("native_audio_diagnostics_availability"),
    );
    expect(screen.queryByRole("heading", { name: "Native Audio Diagnostics" })).not.toBeInTheDocument();
  });

  it("resets and exports enabled local native audio diagnostics", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    const diagnosticExport = {
      schemaVersion: "tuneforge-native-audio-diagnostics-v1",
      relativeNowUs: 10,
      resetCount: 0,
      counters: {
        operationCount: 2,
        ringClearCount: 1,
        workerFirstPcmEventCount: 1,
        prebufferReadyCount: 1,
        callbackFirstNonzeroCount: 1,
        gainRampBeginCount: 0,
        gainRampCompleteCount: 0,
        underrunCount: 0,
        skippedPacketErrorCount: 1,
        skippedDecodeErrorCount: 2,
        staleGenerationEventCount: 0,
      },
      operations: [],
      safeCodes: [],
      rssKibAtExport: null,
    };
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "native_audio_diagnostics_availability") {
        return { enabled: true };
      }
      if (command === "native_audio_diagnostics_read" || command === "native_audio_diagnostics_reset") {
        return diagnosticExport;
      }
      if (command === "native_audio_diagnostics_export") {
        return true;
      }
      return defaultInvoke(command, args);
    });

    try {
      renderApp(["/settings"]);

      expect(await screen.findByRole("heading", { name: "Native Audio Diagnostics" })).toBeInTheDocument();
      expect(screen.getByText(/Local session only/)).toHaveTextContent(
        "Names, paths, identifiers, and audio samples are not recorded or sent.",
      );
      expect(await screen.findByText("3")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Reset diagnostics" }));
      expect(await screen.findByText("Local diagnostic counters reset.")).toBeInTheDocument();
      expect(mockInvoke).toHaveBeenCalledWith("native_audio_diagnostics_reset");

      await user.click(screen.getByRole("button", { name: "Export sanitized JSON" }));
      expect(await screen.findByText("Sanitized diagnostics exported.")).toBeInTheDocument();
      expect(mockInvoke).toHaveBeenCalledWith("native_audio_diagnostics_export");
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("keeps Android capture capability, live state, and history distinct", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: { platform: "android", backend: "android-aaudio", micCaptureSupported: true },
      inputPermission: { state: "blocked", error: null },
      inputState: { active: false, capturePath: "none", captureGeneration: 9, error: null },
    });
    window.localStorage.setItem(
      "tuneforge.tuner-input-capture-backend",
      JSON.stringify({ backend: "native", detail: "android-aaudio" }),
    );
    window.localStorage.setItem(
      "tuneforge.tuner-native-capture-error",
      "Microphone capture was interrupted. Check Android Settings, then choose Retry.",
    );
    renderApp(["/settings"]);

    await user.click(await screen.findByText("Show diagnostics"));

    expect(await screen.findByText("Available (android-aaudio)")).toBeInTheDocument();
    expect(screen.getByText("Native required")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
    expect(screen.getAllByText("None").length).toBeGreaterThan(0);
    expect(screen.getByText("Native (android-aaudio)")).toBeInTheDocument();
    expect(screen.getByText(/Microphone capture was interrupted/)).toBeInTheDocument();
  });

  it("persists playback follow defaults", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    const lyricsFollowToggle = screen.getByRole("button", {
      name: /^Enable lyrics follow by default/,
    });
    const chordsFollowToggle = screen.getByRole("button", {
      name: /^Enable chords follow by default/,
    });

    await user.click(lyricsFollowToggle);
    await user.click(chordsFollowToggle);

    expect(lyricsFollowToggle).toHaveAttribute("aria-pressed", "false");
    expect(chordsFollowToggle).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
      defaultLyricsFollowEnabled: false,
      defaultChordsFollowEnabled: false,
    });
  });

  it("shows unavailable advanced chord backend without allowing selection", async () => {
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
        label: "Advanced Chords — Crema ONNX",
        unavailable_reason: "crema is not installed",
      },
    ]);

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(await screen.findByText("Selected · Unavailable — crema is not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Advanced Chords — Crema ONNX").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Imports may use Built-in Chords if the saved backend is unavailable/)).toBeInTheDocument();
  });

  it("retains the cached implementation label while chord availability refetches and fails", async () => {
    setChordBackends([
      {
        availability: "available",
        available: true,
        capabilities: {},
        desktopOnly: true,
        experimental: true,
        id: "crema-advanced",
        label: "Advanced Chords — Crema ONNX",
        unavailable_reason: null,
      },
      {
        availability: "available",
        available: true,
        capabilities: {},
        desktopOnly: true,
        experimental: true,
        id: "lv-chordia-submission",
        label: "LV Chordia (Submission)",
        unavailable_reason: null,
      },
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
    ]);
    const { queryClient } = renderApp(["/settings"]);
    expect((await screen.findAllByText("Advanced Chords — Crema ONNX")).length).toBeGreaterThan(0);

    let rejectRefetch!: (reason: Error) => void;
    mockListChordBackends.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefetch = reject;
        }),
    );
    let refetch!: Promise<void>;
    act(() => {
      refetch = queryClient.refetchQueries({ queryKey: ["chord-backends"] });
    });

    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Default chord backend" })).toHaveAttribute("aria-busy", "true"),
    );
    expect(screen.getAllByText("Advanced Chords — Crema ONNX").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();

    await act(async () => {
      rejectRefetch(new Error("registry unavailable at /private/library"));
      await refetch;
    });

    expect(await screen.findByText(
      "Chord backend availability could not be checked. Saved selection was preserved.",
    )).toBeInTheDocument();
    expect(screen.getAllByText("Advanced Chords — Crema ONNX").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();
  });

  it("preserves the saved chord backend and offers retry when availability fails", async () => {
    const user = userEvent.setup();
    mockListChordBackends.mockRejectedValueOnce(new Error("registry unavailable"));

    renderApp(["/settings"]);

    expect(await screen.findByText(
      "Chord backend availability could not be checked. Saved selection was preserved.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^LV Chordia/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry availability" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^Advanced Chords/ })).not.toBeDisabled());
    const chordBackendGroup = screen.getByRole("group", { name: "Default chord backend" });
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(chordBackendGroup).toHaveFocus();
    expect(within(chordBackendGroup).getByRole("status")).toHaveTextContent(
      "Chord backend availability updated.",
    );
  });

  it("shows unavailable advanced beat backend alongside the available Built-in choice", async () => {
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultBeatAnalysisBackend: "beat-this", defaultSourcesRailCollapsed: false }),
    );
    setBeatBackends([
      {
        availability: "available",
        available: true,
        desktopOnly: false,
        experimental: false,
        id: "built-in",
        label: "Built-in Beat Analysis",
        unavailable_reason: null,
      },
      {
        availability: "unavailable",
        available: false,
        desktopOnly: true,
        experimental: true,
        id: "beat-this",
        label: "Advanced Beat Analysis",
        unavailable_reason: "beat-this is not installed",
      },
    ]);

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(await screen.findByText("beat-this is not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Built-in Beat Analysis/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toBeDisabled();
    expect(screen.getAllByText("Advanced Beat Analysis").length).toBeGreaterThan(0);
  });

  it("keeps engine defaults neutral while registry availability is loading", async () => {
    let resolveBeatBackends!: () => void;
    let resolveChordBackends!: () => void;
    mockListBeatBackends.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBeatBackends = () => resolve({ backends: [] });
        }),
    );
    mockListChordBackends.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveChordBackends = () => resolve({ backends: [] });
        }),
    );

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Default chord backend" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Checking chord backend availability…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^LV Chordia/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toBeDisabled();
    expect(screen.queryByText(/Using Built-in .* fallback/)).not.toBeInTheDocument();

    await act(async () => {
      resolveBeatBackends();
      resolveChordBackends();
    });

    await waitFor(() =>
      expect(screen.getAllByText("Missing from backend registry").length).toBeGreaterThanOrEqual(4),
    );
    expect(screen.queryByText("Checking availability")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("No available backend")).toHaveLength(1);
    expect(screen.getByText(/Imports may use Built-in Chords if the saved backend is unavailable/)).toBeInTheDocument();
  });

  it("shows blocked state when no beat or chord backend is available", async () => {
    setBeatBackends([
      {
        availability: "unavailable",
        available: false,
        desktopOnly: false,
        experimental: false,
        id: "built-in",
        label: "Built-in Beat Analysis",
        unavailable_reason: "built-in beat engine failed diagnostics",
      },
      {
        availability: "unavailable",
        available: false,
        desktopOnly: true,
        experimental: true,
        id: "beat-this",
        label: "Advanced Beat Analysis",
        unavailable_reason: "beat-this is not installed",
      },
    ]);
    setChordBackends([
      {
        availability: "unavailable",
        available: false,
        capabilities: {},
        desktopOnly: false,
        experimental: false,
        id: "tuneforge-fast",
        label: "Built-in Chords",
        unavailable_reason: "built-in chord engine failed diagnostics",
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

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(await screen.findByText("beat-this is not installed")).toBeInTheDocument();
    expect(screen.getByText("built-in beat engine failed diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Selected · Unavailable — crema is not installed")).toBeInTheDocument();
    expect(screen.getByText("Unavailable — built-in chord engine failed diagnostics")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Built-in Beat Analysis/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByText("No available backend")).toHaveLength(1);
    expect(screen.getByText(/Imports may use Built-in Chords if the saved backend is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Using Built-in .* fallback/)).not.toBeInTheDocument();
  });

  it("resets appearance, playback, and all settings independently", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Light/ }));
    await user.click(screen.getByRole("button", { name: /^Detailed/ }));
    await user.click(screen.getByRole("button", { name: /^Prefer sharps/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/ }));

    await user.click(screen.getByRole("button", { name: "Reset Appearance" }));
    expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Prefer sharps/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Notation" }));
    expect(screen.getByRole("button", { name: /^Auto by key/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Analysis Defaults" }));
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Playback Defaults" }));
    expect(screen.getByRole("button", { name: /^Project first/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^AutoUse lyrics \+ chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable lyrics follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable chords follow by default/ })).toHaveAttribute("aria-pressed", "true");

    await user.selectOptions(screen.getByLabelText("Default tuner"), "simple");
    await user.click(screen.getByRole("button", { name: "Reset Tuner Defaults" }));
    expect(screen.getByLabelText("Default tuner")).toHaveValue("wide-arc");

    await user.click(screen.getByRole("button", { name: /^Dark/ }));
    await user.click(screen.getByRole("button", { name: /^Dual labels/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/ }));
    await user.selectOptions(screen.getByLabelText("Default tuner"), "simple");
    await user.click(screen.getByRole("button", { name: "Reset All Settings" }));

    expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Auto by key/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Project first/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^AutoUse lyrics \+ chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable lyrics follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable chords follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Default tuner")).toHaveValue("wide-arc");
  });

  it("keeps project playback preferences when resetting all settings", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.project-playback-state",
      JSON.stringify({
        proj_123: {
          activeWorkspace: "playback",
          chordsFollowEnabled: false,
          dismissedStemJobIds: [],
          lyricsFollowEnabled: false,
          playbackDisplayMode: "chords",
          selectedArtifactId: "art_200",
          selectedPrimaryArtifactId: "art_source",
          selectedStemSourceArtifactId: null,
          stemControls: {},
        },
      }),
    );

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset All Settings" }));

    expect(JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}")).toMatchObject({
      proj_123: {
        activeWorkspace: "playback",
        chordsFollowEnabled: false,
        lyricsFollowEnabled: false,
        playbackDisplayMode: "chords",
        selectedArtifactId: "art_200",
        selectedPrimaryArtifactId: "art_source",
      },
    });
  });

  it("follows system theme when preference is set to system", async () => {
    const user = userEvent.setup();
    const mediaController = installMatchMediaMock(false);

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Follow system/ }));

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await act(async () => {
      mediaController.setMatches(true);
    });

    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "dark"),
    );
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#070B13");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("system");
  });

  it("opens theme studio and persists local theme overrides", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Open Theme Studio" }));

    expect(await screen.findByRole("heading", { name: "Metal / Heat Studio" })).toBeInTheDocument();
    const appBackgroundInput = screen.getByLabelText("App background hex");
    fireEvent.change(appBackgroundInput, { target: { value: "#123456" } });
    fireEvent.blur(appBackgroundInput);

    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#123456");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.theme-overrides.v1") ?? "{}")).toMatchObject({
      light: {
        "--color-bg-app": "#123456",
      },
    });

    await user.click(screen.getByRole("button", { name: "Reset Light Theme" }));

    expect(window.localStorage.getItem("tuneforge.theme-overrides.v1")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#F4F7FB");
  });

  it("keeps legacy theme preview route pointed at theme studio", async () => {
    renderApp(["/settings/theme-preview"]);

    expect(await screen.findByRole("heading", { name: "Metal / Heat Studio" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
  });

  it("shows selector samples inside theme studio preview", async () => {
    renderApp(["/settings/theme-studio"]);

    expect(await screen.findByRole("heading", { name: "Metal / Heat Studio" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: /source selector sample/i })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: /target selector sample/i })).toBeInTheDocument();
  });

  it("exports and imports a full settings snapshot", async () => {
    const user = userEvent.setup();

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Dark/i }));
    await user.click(screen.getByRole("button", { name: /^Detailed/i }));
    await user.click(screen.getByRole("button", { name: /^Prefer sharps/i }));
    await user.click(screen.getByRole("button", { name: /^Playback first/i }));
    await user.click(screen.getByRole("button", { name: /^Lyrics \+ chords/i }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/i }));
    await user.click(screen.getByRole("link", { name: "Open Theme Studio" }));

    expect(await screen.findByRole("heading", { name: "Metal / Heat Studio" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("App background hex"), { target: { value: "#123456" } });
    fireEvent.blur(screen.getByLabelText("App background hex"));

    await user.click(screen.getByRole("link", { name: "Back to Settings" }));
    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export Settings" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "write_settings_snapshot_file",
        expect.objectContaining({
          contents: expect.any(String),
          defaultFileName: expect.stringMatching(/^tuneforge-settings-\d{4}-\d{2}-\d{2}\.json$/),
        }),
      ),
    );
    expect(screen.getByText("Settings exported.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset All Settings" }));

    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "light"),
    );
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#F4F7FB");
    expect(window.localStorage.getItem("tuneforge.theme-overrides.v1")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Import Settings" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("read_settings_snapshot_file"));
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "dark"),
    );
    expect(screen.getByText("Settings imported.")).toBeInTheDocument();
    expect(screen.getAllByText("Detailed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Prefer sharps")).toHaveLength(2);
    expect(screen.getAllByText("Playback first").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lyrics + chords").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Advanced Chords — Crema (TensorFlow)").length).toBeGreaterThan(0);
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#123456");
  });

  it("confirms a lossy desktop snapshot before atomically applying it", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) throw new Error("Mock invoke implementation was not installed.");
    const contents = settingsSnapshotContents(
      { ...DEFAULT_PREFERENCES, defaultDurableAudioFormat: "mp3", informationDensity: "detailed" },
      "dark",
      { light: { "--color-bg-app": "#123456" } },
    );
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "read_settings_snapshot_file" ? contents : defaultInvoke(command, args));

    try {
      renderApp(["/settings"]);
      await user.click(await screen.findByRole("button", { name: "Import Settings" }));

      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("read_settings_snapshot_file"));
      await waitFor(() =>
        expect(mockConfirm).toHaveBeenCalledWith(
          expect.stringMatching(/irreversible.*cannot be recovered/is),
          expect.objectContaining({ okLabel: "Use MP3" }),
        ),
      );
      await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
      expect(screen.getByRole("button", { name: /^MP3 \(192 kbps\)/ }))
        .toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Settings imported.")).toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("leaves theme and preferences unchanged when a lossy snapshot is declined", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) throw new Error("Mock invoke implementation was not installed.");
    const contents = settingsSnapshotContents(
      { ...DEFAULT_PREFERENCES, defaultDurableAudioFormat: "m4a", informationDensity: "detailed" },
      "dark",
      { light: { "--color-bg-app": "#123456" } },
    );
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "read_settings_snapshot_file" ? contents : defaultInvoke(command, args));
    mockConfirm.mockResolvedValueOnce(false);

    try {
      renderApp(["/settings"]);
      await user.click(await screen.findByRole("button", { name: "Import Settings" }));

      await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /^WAV\/PCM/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
      expect(document.documentElement.style.getPropertyValue("--color-bg-app")).not.toBe("#123456");
      expect(screen.queryByText("Settings imported.")).not.toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("imports WAV from a v1 snapshot without a lossy confirmation", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) throw new Error("Mock invoke implementation was not installed.");
    const { defaultDurableAudioFormat, ...v1Preferences } = DEFAULT_PREFERENCES;
    expect(defaultDurableAudioFormat).toBe("wav");
    const contents = JSON.stringify({
      exportedAt: "2026-04-18T13:16:00.000Z",
      kind: "tuneforge.settings",
      preferences: { ...v1Preferences, informationDensity: "detailed" },
      themeOverrides: {},
      themePreference: "dark",
      version: 1,
    });
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "read_settings_snapshot_file" ? contents : defaultInvoke(command, args));

    try {
      renderApp(["/settings"]);
      await user.click(await screen.findByRole("button", { name: "Import Settings" }));

      await screen.findByText("Settings imported.");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /^WAV\/PCM/ })).toHaveAttribute("aria-pressed", "true");
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("preserves a hidden compressed snapshot preference on Android without prompting", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) throw new Error("Mock invoke implementation was not installed.");
    mockGetExportCapabilities.mockResolvedValueOnce({
      capabilities: {
        platform: "android",
        formats: [{ id: "wav", available: true, reason: null }],
        destinations: [],
        max_artifact_count: 1,
      },
    });
    const contents = settingsSnapshotContents(
      { ...DEFAULT_PREFERENCES, defaultDurableAudioFormat: "m4a" },
      "system",
    );
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "read_settings_snapshot_file" ? contents : defaultInvoke(command, args));

    try {
      renderApp(["/settings"]);
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Audio Storage" })).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Import Settings" }));

      await screen.findByText("Settings imported.");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
        .toMatchObject({ defaultDurableAudioFormat: "m4a" });
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("keeps settings snapshot cancel quiet", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export Settings" }));
    await screen.findByText("Settings exported.");

    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_settings_snapshot_file") {
        return null;
      }
      return defaultInvoke(command, args);
    });

    try {
      await user.click(screen.getByRole("button", { name: "Import Settings" }));

      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("read_settings_snapshot_file"));
      expect(screen.queryByText("Settings exported.")).not.toBeInTheDocument();
      expect(screen.queryByText("Settings imported.")).not.toBeInTheDocument();
      expect(screen.queryByText(/Could not import settings/i)).not.toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("shows a parse error for empty settings snapshot files", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_settings_snapshot_file") {
        return "";
      }
      return defaultInvoke(command, args);
    });

    try {
      renderApp(["/settings"]);

      expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Import Settings" }));

      expect(await screen.findByText("Could not parse the settings file.")).toBeInTheDocument();
      expect(screen.queryByText("Settings imported.")).not.toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("rejects corrupt settings snapshots instead of reporting full success", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_settings_snapshot_file") {
        return JSON.stringify({
          exportedAt: "2026-04-18T13:16:00.000Z",
          kind: "tuneforge.settings",
          preferences: {
            informationDensity: "detailed",
          },
          themeOverrides: {},
          themePreference: "dark",
          version: 1,
        });
      }
      return defaultInvoke(command, args);
    });

    try {
      renderApp(["/settings"]);

      expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Import Settings" }));

      expect(await screen.findByText("Unsupported settings file.")).toBeInTheDocument();
      expect(screen.queryByText("Settings imported.")).not.toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });

  it("shows retryable settings export errors without native paths", async () => {
    const user = userEvent.setup();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }

    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "write_settings_snapshot_file") {
        throw new Error("Could not write settings file: /Users/test/private/settings.json");
      }
      return defaultInvoke(command, args);
    });

    try {
      renderApp(["/settings"]);

      expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Export Settings" }));

      expect(
        await screen.findByText("Could not export settings. Choose another location and try again."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/\/Users\/test\/private/)).not.toBeInTheDocument();
      expect(screen.queryByText("Settings exported.")).not.toBeInTheDocument();
    } finally {
      mockInvoke.mockImplementation(defaultInvoke);
    }
  });
});
