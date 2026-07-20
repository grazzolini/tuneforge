import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRONTEND_VERSION_INFO } from "./lib/buildInfo";
import {
  resetAppTestHarness,
  getAllByAriaKeyLabel,
  getByAriaKeyLabel,
  installMatchMediaMock,
  mockInvoke,
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
    expect(
      within(screen.getByRole("group", { name: "Default beat analysis" })).getAllByRole("button")[0],
    ).toHaveTextContent("Advanced Beat Analysis");
    expect(
      within(screen.getByRole("group", { name: "Default chord backend" })).getAllByRole("button")[0],
    ).toHaveTextContent("Advanced Chords");
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
      defaultLyricsFollowEnabled: true,
      defaultChordsFollowEnabled: true,
      defaultTunerInputDeviceId: null,
      defaultTunerReferenceHz: 440,
      defaultTunerVisualMode: "wide-arc",
    });
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
    expect(screen.getAllByText("Native (desktop-cpal)")).toHaveLength(2);
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
    expect(screen.getByText("Web Audio forced")).toBeInTheDocument();
    expect(screen.getAllByText("Native (desktop-cpal)")).toHaveLength(2);
    expect(screen.getByText("Not playing")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("audio_get_capabilities");
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
        label: "Advanced Chords",
        unavailable_reason: "crema is not installed",
      },
    ]);

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(await screen.findByText("crema is not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Advanced Chords unavailable: crema is not installed. Using Built-in Chords fallback."),
    ).toBeInTheDocument();
  });

  it("shows unavailable advanced beat backend and selects built-in fallback", async () => {
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
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toBeDisabled();
    expect(
      screen.getByText(
        "Advanced Beat Analysis unavailable: beat-this is not installed. Using Built-in Beat Analysis fallback.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Built-in Beat Analysis").length).toBeGreaterThan(0);
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
    expect(screen.getAllByText("Checking availability").length).toBeGreaterThanOrEqual(4);
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
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/No beat analysis backend available/)).toBeInTheDocument();
    expect(screen.getByText(/No chord backend available/)).toBeInTheDocument();
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
    expect(screen.getByText("crema is not installed")).toBeInTheDocument();
    expect(screen.getByText("built-in chord engine failed diagnostics")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Advanced Beat Analysis/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Built-in Beat Analysis/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/No beat analysis backend available/)).toBeInTheDocument();
    expect(screen.getByText(/No chord backend available/)).toBeInTheDocument();
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
    expect(screen.getAllByText("Advanced Chords").length).toBeGreaterThan(0);
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#123456");
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
