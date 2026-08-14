import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExportCapabilitiesResponse, HealthResponse } from "./lib/api";
import {
  mockCreateExport,
  mockDeleteProject,
  mockGetExportCapabilities,
  mockGetHealth,
  mockGetMobileCapabilities,
  mockOpen,
  mockSave,
  resetAppTestHarness,
  renderApp,
  setProjects,
  setProjectArtifacts,
  setJobs,
} from "./test/appTestHarness";
import { openAnalysisPanel, openExportPanel, refreshJobs } from "./test/projectTestActions";

const createdAt = "2026-04-18T13:16:00.000Z";

function artifact(id: string, type: string, sourceArtifactId?: string) {
  return {
    id,
    project_id: "proj_123",
    type,
    format: "wav",
    path: `/tmp/${id}.wav`,
    metadata: sourceArtifactId ? { source_artifact_id: sourceArtifactId } : {},
    created_at: createdAt,
  };
}

function installExportArtifacts() {
  setProjectArtifacts("proj_123", [
    artifact("art_source", "source_audio"),
    artifact("art_mix", "preview_mix"),
    artifact("art_vocals", "vocal_stem", "art_mix"),
    artifact("art_drums", "drums_stem", "art_mix"),
    artifact("art_bass", "bass_stem", "art_mix"),
    artifact("art_guitar", "guitar_stem", "art_mix"),
  ]);
}

function health(defaultExportFormat: string): HealthResponse {
  return {
    name: "TuneForge",
    version: "backend-test-ref",
    backend_version: { package_version: "1.0.1", git_ref: "backend-test-ref" },
    frontend_version: { package_version: "1.0.1", git_ref: "frontend-test-ref" },
    status: "ok",
    api_base_url: "http://127.0.0.1:8765/api/v1",
    data_root: "/tmp/tuneforge",
    default_export_format: defaultExportFormat,
    preview_format: "wav",
  };
}

describe("project export workspace", () => {
  beforeEach(resetAppTestHarness);

  it("uses a dedicated project tab instead of the Analysis inspector", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    await screen.findByRole("heading", { name: "Demo Song" });
    await openAnalysisPanel(user);
    expect(screen.queryByRole("button", { name: /Export Selected Audio/i })).not.toBeInTheDocument();

    await openExportPanel(user);
    expect(screen.getByRole("tabpanel", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Export audio" })).toBeInTheDocument();
    expect(screen.getByLabelText("File format")).toHaveValue("wav");
  });

  it("keeps the empty Export view connected to its tabpanel", async () => {
    const user = userEvent.setup();
    setProjectArtifacts("proj_123", []);
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.getByRole("tabpanel", { name: "Export" })).toHaveTextContent(
      "No audio is available to export yet.",
    );
  });

  it("supports keyboard tab navigation and persists the Export panel", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });

    const studioTab = screen.getByRole("tab", { name: "Studio" });
    studioTab.focus();
    await user.keyboard("{ArrowLeft}");

    const exportTab = screen.getByRole("tab", { name: "Export" });
    expect(exportTab).toHaveFocus();
    expect(exportTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("tuneforge.project-playback-state") ?? "{}");
      expect(stored.proj_123?.activeProjectPanel).toBe("export");
    });
  });

  it("shows custom selection and deterministic previews after a manual edit", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    await user.click(screen.getByRole("button", { name: "Track + all stems" }));
    expect(screen.getByRole("button", { name: "Track + all stems" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("checkbox", { name: /Guitar/i }));
    expect(screen.getByText("Custom selection")).toBeInTheDocument();
    expect(screen.getByText("4 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder" })).toHaveAttribute("aria-pressed", "true");
    const preview = screen.getByText("File preview").closest("div")?.parentElement;
    expect(preview).not.toBeNull();
    expect(within(preview as HTMLElement).getAllByRole("listitem")).toHaveLength(4);
    expect(within(preview as HTMLElement).getByText("Demo Song - Practice Mix 1 - Vocals.wav")).toBeInTheDocument();
  });

  it("orders presets and defaults a newly selected stemmed set to a folder package", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    const presetButtons = within(screen.getByRole("group", { name: "Quick selections" }))
      .getAllByRole("button");
    expect(presetButtons.map((button) => button.textContent)).toEqual([
      "Track + all stems",
      "Track only",
      "All stems",
    ]);
    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    presetButtons[0]?.focus();
    await user.tab();
    expect(presetButtons[1]).toHaveFocus();
    await user.tab();
    expect(presetButtons[2]).toHaveFocus();

    expect(screen.getByText("5 selected")).toBeInTheDocument();
    expect(presetButtons[0]).toHaveAttribute("aria-pressed", "true");
    const destinations = within(screen.getByRole("group", { name: "Destination" }))
      .getAllByRole("button");
    expect(destinations).toHaveLength(3);
    expect(destinations[1]).toHaveAttribute("aria-pressed", "true");
    expect(destinations.map((button) => button.querySelector(".export-destination-option__check")))
      .not.toContain(null);
    expect(destinations[0]?.querySelector(".export-destination-option__check svg")).toBeNull();
    expect(destinations[1]?.querySelector(".export-destination-option__check svg")).not.toBeNull();
    expect(destinations[2]?.querySelector(".export-destination-option__check svg")).toBeNull();
  });

  it("retains a compatible folder target for manual many-to-many selection changes", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    mockOpen.mockResolvedValue("/tmp/exports");
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    await user.click(screen.getByRole("button", { name: "Track + all stems" }));
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    expect(await screen.findByText("/tmp/exports")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Guitar/i }));

    expect(screen.getByText("/tmp/exports")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder" })).toHaveAttribute("aria-pressed", "true");
  });

  it("restores a saved export draft after returning to the project", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "art_mix",
          selectedArtifactIds: ["art_mix", "art_vocals"],
          outputFormat: "flac",
          filenameBase: "Session take",
          destinationType: "folder",
          desktopDestinationTarget: "/tmp/exports",
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.getByRole("radio", { name: /Practice Mix 1/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Vocals/i })).toBeChecked();
    expect(screen.getByLabelText("File format")).toHaveValue("flac");
    expect(screen.getByLabelText("File name base")).toHaveValue("Session take");
    expect(screen.getByText("/tmp/exports")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Export 2 files" }));
    expect(mockCreateExport).toHaveBeenCalledWith("proj_123", expect.objectContaining({
      destination: { type: "folder", target: "/tmp/exports", overwrite: false },
    }));
  });

  it("keeps stored private choices out of the pending and recovered workspace", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    let resolveCapabilities!: (value: ExportCapabilitiesResponse) => void;
    mockGetExportCapabilities.mockImplementationOnce(() => new Promise<ExportCapabilitiesResponse>((resolve) => {
      resolveCapabilities = resolve;
    }));
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "stale-audio-set",
          selectedArtifactIds: ["stale-audio-set"],
          outputFormat: "flac",
          filenameBase: "A private take",
          destinationType: "folder",
          desktopDestinationTarget: "/private/a-only",
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.queryByText("A private take")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/a-only")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeDisabled();

    resolveCapabilities({
      capabilities: {
        platform: "desktop",
        formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({ id, available: true, reason: null })),
        destinations: ["single_file", "folder", "zip"].map((id) => ({ id, available: true, reason: null })),
        max_artifact_count: null,
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export 1 file" })).toBeEnabled());
    expect(screen.queryByText("A private take")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/a-only")).not.toBeInTheDocument();
  });

  it("does not carry cached export choices into another project", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    setProjects([
      {
        id: "proj_123", display_name: "Demo Song", source_key_override: null,
        source_path: "/tmp/demo.wav", imported_path: "/tmp/demo.wav", duration_seconds: 182,
        sample_rate: 44100, channels: 2, created_at: createdAt, updated_at: createdAt,
      },
      {
        id: "proj_456", display_name: "Other Song", source_key_override: null,
        source_path: "/tmp/other.wav", imported_path: "/tmp/other.wav", duration_seconds: 182,
        sample_rate: 44100, channels: 2, created_at: createdAt, updated_at: createdAt,
      },
    ]);
    setProjectArtifacts("proj_456", [{
      ...artifact("other_source", "source_audio"), project_id: "proj_456",
    }]);
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "art_source", selectedArtifactIds: ["art_source"], outputFormat: "m4a",
          filenameBase: "A private take", destinationType: "single_file",
          desktopDestinationTarget: "/private/a-only.m4a",
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);
    expect(screen.getByText("/private/a-only.m4a")).toBeInTheDocument();

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]!);
    await screen.findByRole("heading", { name: "Practice Projects" });
    await user.click(screen.getByRole("link", { name: "Open Other Song project" }));
    await screen.findByRole("heading", { name: "Other Song" });
    await openExportPanel(user);

    expect(screen.queryByText("A private take")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/a-only.m4a")).not.toBeInTheDocument();
    expect(screen.getByLabelText("File name base")).toHaveValue("Other Song");
  });

  it("clears an export recovery notice when navigating to another project", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    setProjects([
      {
        id: "proj_123", display_name: "Demo Song", source_key_override: null,
        source_path: "/tmp/demo.wav", imported_path: "/tmp/demo.wav", duration_seconds: 182,
        sample_rate: 44100, channels: 2, created_at: createdAt, updated_at: createdAt,
      },
      {
        id: "proj_456", display_name: "Other Song", source_key_override: null,
        source_path: "/tmp/other.wav", imported_path: "/tmp/other.wav", duration_seconds: 182,
        sample_rate: 44100, channels: 2, created_at: createdAt, updated_at: createdAt,
      },
    ]);
    setProjectArtifacts("proj_456", [{ ...artifact("other_source", "source_audio"), project_id: "proj_456" }]);
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "gone", selectedArtifactIds: ["gone"], outputFormat: "m4a",
          filenameBase: "A stale take", destinationType: "single_file",
          desktopDestinationTarget: "/private/a-stale.m4a",
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved Export choices were adjusted because this project or device changed.",
    );

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]!);
    await screen.findByRole("heading", { name: "Practice Projects" });
    await user.click(screen.getByRole("link", { name: "Open Other Song project" }));
    await screen.findByRole("heading", { name: "Other Song" });

    expect(screen.queryByText("Saved Export choices were adjusted because this project or device changed.")).not.toBeInTheDocument();
  });

  it("removes only the deleted project's stored export workspace", async () => {
    const user = userEvent.setup();
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: { exportWorkspace: { audioSetId: "art_source", selectedArtifactIds: ["art_source"], outputFormat: "m4a", filenameBase: "Delete me", destinationType: "single_file", desktopDestinationTarget: "/tmp/delete.m4a" } },
      proj_456: { exportWorkspace: { audioSetId: "other_source", selectedArtifactIds: ["other_source"], outputFormat: "m4a", filenameBase: "Keep me", destinationType: "single_file", desktopDestinationTarget: "/tmp/keep.m4a" } },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openAnalysisPanel(user);
    await user.click(screen.getByRole("button", { name: "Delete Project" }));
    await waitFor(() => expect(mockDeleteProject).toHaveBeenCalledWith("proj_123"));

    const stored = JSON.parse(localStorage.getItem("tuneforge.project-playback-state") ?? "{}");
    expect(stored.proj_123).toBeUndefined();
    expect(stored.proj_456.exportWorkspace.filenameBase).toBe("Keep me");
  });

  it("offers a retry after export capabilities fail", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    mockGetExportCapabilities.mockRejectedValueOnce(new Error("offline"));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("Export options couldn’t load. Retry to continue.");
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeEnabled();
  });

  it("does not persist an uninitialized format while health is pending", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    let resolveHealth!: (value: HealthResponse) => void;
    mockGetHealth.mockImplementationOnce(() => new Promise<HealthResponse>((resolve) => {
      resolveHealth = resolve;
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeDisabled();
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("tuneforge.project-playback-state") ?? "{}");
      expect(stored.proj_123?.exportWorkspace ?? null).toBeNull();
    });

    resolveHealth(health("wav"));
    await waitFor(() => expect(screen.getByLabelText("File format")).toHaveValue("wav"));
  });

  it("restores an available saved format before health settles but waits to reset", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    let resolveHealth!: (value: HealthResponse) => void;
    mockGetHealth.mockImplementationOnce(() => new Promise<HealthResponse>((resolve) => {
      resolveHealth = resolve;
    }));
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "art_source",
          selectedArtifactIds: ["art_source"],
          outputFormat: "flac",
          filenameBase: "Saved take",
          destinationType: "single_file",
          desktopDestinationTarget: null,
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    await waitFor(() => expect(screen.getByLabelText("File format")).toHaveValue("flac"));
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeEnabled();
    const reset = screen.getByRole("button", { name: "Reset export workspace" });
    expect(reset).toBeDisabled();
    expect(screen.getByText("Export options are still loading.")).toBeVisible();
    expect(JSON.parse(
      localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
    ).proj_123.exportWorkspace.outputFormat).toBe("flac");

    resolveHealth(health("wav"));
    await waitFor(() => expect(reset).toBeEnabled());
    expect(screen.getByLabelText("File format")).toHaveValue("flac");
    await user.click(reset);
    expect(screen.getByLabelText("File format")).toHaveValue("wav");
  });

  it("uses capability fallback and permits export when health fails", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    mockGetHealth.mockRejectedValueOnce(new Error("health unavailable"));
    mockSave.mockResolvedValueOnce("/tmp/demo-song.wav");
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.getByLabelText("File format")).toHaveValue("wav");
    const exportButton = screen.getByRole("button", { name: "Export 1 file" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await user.click(exportButton);
    expect(mockCreateExport).toHaveBeenCalledWith("proj_123", expect.objectContaining({
      output_format: "wav",
    }));
  });

  it("resets only the export workspace and keeps focus on the reset action", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);
    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    await user.click(screen.getByRole("button", { name: "Track + all stems" }));
    await user.selectOptions(screen.getByLabelText("File format"), "flac");

    const reset = screen.getByRole("button", { name: "Reset export workspace" });
    await user.click(reset);

    expect(reset).toHaveFocus();
    expect(screen.getByRole("radio", { name: /Source Track/i })).toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByLabelText("File format")).toHaveValue("wav");
    expect(screen.getByRole("button", { name: "File" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps an export draft when leaving and returning to its tab", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);
    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    await user.selectOptions(screen.getByLabelText("File format"), "flac");
    await user.clear(screen.getByLabelText("File name base"));
    await user.type(screen.getByLabelText("File name base"), "Return take");

    await openAnalysisPanel(user);
    await openExportPanel(user);

    expect(screen.getByRole("radio", { name: /Practice Mix 1/i })).toBeChecked();
    expect(screen.getByLabelText("File format")).toHaveValue("flac");
    expect(screen.getByLabelText("File name base")).toHaveValue("Return take");
  });

  it("announces one private recovery notice without exposing the saved target", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "gone",
          selectedArtifactIds: ["gone"],
          outputFormat: "wav",
          filenameBase: "Session",
          destinationType: "zip",
          desktopDestinationTarget: "/private/secret.wav",
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Saved Export choices were adjusted because this project or device changed.");
    expect(notice).not.toHaveTextContent("/private/secret.wav");
  });

  it("clears a corrupt legacy format target and announces its recovery", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
      proj_123: {
        exportWorkspace: {
          audioSetId: "art_source",
          selectedArtifactIds: ["art_source"],
          outputFormat: "aac",
          filenameBase: "Legacy",
          destinationType: "legacy-folder",
          desktopDestinationTarget: "/private/legacy-export",
        },
      },
    }));
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.getByLabelText("File format")).toHaveValue("wav");
    expect(screen.queryByText("/private/legacy-export")).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved Export choices were adjusted because this project or device changed.",
    );
  });

  it("keeps the narrow package in flow while its compact summary owns the export action", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    const exportPackage = screen.getByRole("complementary", { name: "Export package" });
    const compactSummary = within(exportPackage).getByTestId("export-compact-summary");
    expect(compactSummary).toHaveTextContent("1 item");
    expect(compactSummary).toHaveTextContent("File · Choose on export");
    expect(within(compactSummary).getByRole("button", { name: "Export 1 file" })).toBeEnabled();
    expect(within(exportPackage).getAllByRole("button", { name: /Export \d+ files?/ })).toHaveLength(1);

  });

  it("resets selection and target when changing audio sets while retaining format and base name", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    mockOpen.mockResolvedValue("/tmp/exports");
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    await user.click(screen.getByRole("button", { name: "All stems" }));
    await user.selectOptions(screen.getByLabelText("File format"), "flac");
    await user.clear(screen.getByLabelText("File name base"));
    await user.type(screen.getByLabelText("File name base"), "Session take");
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    expect(await screen.findByText("/tmp/exports")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Source Track/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByLabelText("File format")).toHaveValue("flac");
    expect(screen.getByLabelText("File name base")).toHaveValue("Session take");
    expect(screen.queryByText("/tmp/exports")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "File" })).toHaveAttribute("aria-pressed", "true");
  });

  it("submits an ordered multi-file folder request for one audio set", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    mockOpen.mockResolvedValue("/tmp/exports");
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    await user.click(screen.getByRole("button", { name: "Track + all stems" }));
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("/tmp/exports");
    await user.click(screen.getByRole("button", { name: "Export 5 files" }));

    expect(mockCreateExport).toHaveBeenCalledWith("proj_123", {
      artifact_ids: ["art_mix", "art_vocals", "art_drums", "art_bass", "art_guitar"],
      output_format: "wav",
      filename_base: "Demo Song",
      destination: { type: "folder", target: "/tmp/exports", overwrite: false },
    });
  });

  it("retry failed switches to the audio set that owns failed artifacts", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    setJobs([{ id: "job_partial", project_id: "proj_123", type: "export", status: "completed", progress: 100,
      export_result: { outcome: "partial", total_count: 2, completed_count: 1, failed_count: 1, items: [
        { artifact_id: "art_vocals", output_name: "Demo Song - Practice Mix 1 - Vocals.m4a", status: "failed", progress: 100, result_artifact_id: null, error: "Failed" },
      ] } }]);
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);
    expect(screen.getByRole("radio", { name: /Source Track/i })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Retry failed" }));

    expect(screen.getByRole("radio", { name: /Practice Mix 1/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Vocals/i })).toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("shows the current output filename during export progress", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    const { queryClient } = renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);
    setJobs([{ id: "job_running", project_id: "proj_123", type: "export", status: "running", progress: 45,
      stage_label: "Encoding audio", export_result: { outcome: "failed", total_count: 1, completed_count: 0, failed_count: 0, items: [
        { artifact_id: "art_source", output_name: "Demo Song - Source.m4a", status: "running", progress: 45, result_artifact_id: null, error: null },
      ] } }]);
    await refreshJobs(queryClient);
    await waitFor(() => expect(screen.getByText("Demo Song - Source.m4a")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reset export workspace" })).toBeDisabled();
    expect(screen.getByText("Export options can’t be reset while an export is in progress.")).toBeVisible();
  });

  it("shows truthful Android limits and disabled export controls", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
    mockGetHealth.mockResolvedValueOnce(health("m4a"));
    mockGetMobileCapabilities.mockResolvedValue({ platform: "android" });
    mockGetExportCapabilities.mockResolvedValue({
      capabilities: {
        platform: "android",
        formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({
          id,
          available: false,
          reason: "Android audio export is not available in this build.",
        })),
        destinations: ["single_file", "folder", "zip"].map((id) => ({
          id,
          available: false,
          reason: "Android audio export is not available in this build.",
        })),
        max_artifact_count: 1,
      },
    });
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openExportPanel(user);

    expect(screen.getByText(/Android currently exports one M4A file at a time/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Practice Mix 1/i }));
    const trackOnly = screen.getByRole("button", { name: "Track only" });
    const allStems = screen.getByRole("button", { name: "All stems" });
    const trackAndStems = screen.getByRole("button", { name: "Track + all stems" });
    expect(trackOnly).not.toHaveAttribute("aria-describedby");
    expect(allStems).toBeDisabled();
    expect(allStems).toHaveAttribute("aria-describedby", "android-multi-export-reason");
    expect(trackAndStems).toHaveAttribute("aria-describedby", "android-multi-export-reason");
    expect(screen.getByText(/All stems and track plus stems require multiple files/)).toBeVisible();
    expect(screen.getAllByText("Android audio export is not available in this build.").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("group", { name: "Audio selection" })).getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByLabelText("File format")).toHaveValue("m4a");
    expect(screen.getByLabelText("File format")).toHaveAttribute(
      "aria-describedby",
      "android-export-format-notice",
    );
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeDisabled();
  });
});
