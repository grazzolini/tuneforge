import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAppTestHarness,
  getAllByAriaKeyLabel,
  getByAriaKeyLabel,
  installMatchMediaMock,
  mockInvoke,
  mockOpen,
  mockSave,
  queryByAriaKeyLabel,
  renderApp,
  setChordBackends,
  setProjectAnalysis,
  setProjectChords,
} from "./test/appTestHarness";

describe("Desktop app settings theme", () => {
  beforeEach(resetAppTestHarness);

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

  it("uses new default appearance and visibility settings", async () => {
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Auto by key/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Open inspector by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Collapse sources rail by default/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Project first/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^AutoUse lyrics \+ chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "true");
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
      defaultChordBackend: "tuneforge-fast",
      defaultLyricsFollowEnabled: true,
      defaultChordsFollowEnabled: true,
      defaultTunerInputDeviceId: null,
      defaultTunerReferenceHz: 440,
    });
  });

  it("persists theme and UI visibility preferences", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Light/ }));
    await user.click(screen.getByRole("button", { name: /^Detailed/ }));
    await user.click(screen.getByRole("button", { name: /^Prefer sharps/ }));
    await user.click(screen.getByRole("button", { name: /^Open inspector by default/ }));
    await user.click(screen.getByRole("button", { name: /^Collapse sources rail by default/ }));
    await user.click(screen.getByRole("button", { name: /^Playback first/ }));
    await user.click(screen.getByRole("button", { name: /^Lyrics \+ chords/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/ }));
    await user.click(screen.getByText("Show diagnostics"));
    expect(await screen.findByText("/tmp/tuneforge")).toBeInTheDocument();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#F4F7FB");
    expect(document.documentElement.style.getPropertyValue("--component-playback-active")).toBe("#D9861A");
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
        informationDensity: "detailed",
        enharmonicDisplayMode: "sharps",
        defaultInspectorOpen: false,
        defaultSourcesRailCollapsed: true,
        defaultProjectWorkspace: "playback",
        defaultPlaybackDisplayMode: "combined",
        defaultChordBackend: "crema-advanced",
        defaultLyricsFollowEnabled: true,
        defaultChordsFollowEnabled: true,
      }),
    );
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
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Advanced Chords/ })).toBeDisabled();
    expect(await screen.findByText("crema is not installed")).toBeInTheDocument();
  });

  it("resets appearance, visibility, and all settings independently", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Light/ }));
    await user.click(screen.getByRole("button", { name: /^Detailed/ }));
    await user.click(screen.getByRole("button", { name: /^Prefer sharps/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/ }));
    await user.click(screen.getByRole("button", { name: /^Open inspector by default/ }));
    await user.click(screen.getByRole("button", { name: /^Collapse sources rail by default/ }));

    await user.click(screen.getByRole("button", { name: "Reset Appearance" }));
    expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Prefer sharps/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Open inspector by default/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Collapse sources rail by default/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Notation" }));
    expect(screen.getByRole("button", { name: /^Auto by key/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Analysis Defaults" }));
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Reset Playback Defaults" }));
    expect(screen.getByRole("button", { name: /^Open inspector by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Collapse sources rail by default/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Project first/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^AutoUse lyrics \+ chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable lyrics follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable chords follow by default/ })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /^Dark/ }));
    await user.click(screen.getByRole("button", { name: /^Dual labels/ }));
    await user.click(screen.getByRole("button", { name: /^Advanced Chords/ }));
    await user.click(screen.getByRole("button", { name: /^Open inspector by default/ }));
    await user.click(screen.getByRole("button", { name: "Reset All Settings" }));

    expect(screen.getByRole("button", { name: /^Follow system/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Minimal/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Auto by key/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Open inspector by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Collapse sources rail by default/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Project first/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^AutoUse lyrics \+ chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Built-in Chords/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable lyrics follow by default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Enable chords follow by default/ })).toHaveAttribute("aria-pressed", "true");
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
    mockSave.mockResolvedValue("/tmp/tuneforge-settings.json");
    mockOpen.mockResolvedValue("/tmp/tuneforge-settings.json");

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Dark/i }));
    await user.click(screen.getByRole("button", { name: /^Detailed/i }));
    await user.click(screen.getByRole("button", { name: /^Prefer sharps/i }));
    await user.click(screen.getByRole("button", { name: /Open inspector by default/i }));
    await user.click(screen.getByRole("button", { name: /Collapse sources rail by default/i }));
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
        expect.objectContaining({ path: "/tmp/tuneforge-settings.json" }),
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

    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "dark"),
    );
    expect(screen.getByText("Settings imported.")).toBeInTheDocument();
    expect(screen.getAllByText("Detailed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Prefer sharps")).toHaveLength(2);
    expect(screen.getByText("Closed on load")).toBeInTheDocument();
    expect(screen.getByText("Collapsed")).toBeInTheDocument();
    expect(screen.getAllByText("Playback first").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lyrics + chords").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Advanced Chords").length).toBeGreaterThan(0);
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#123456");
  });
});
