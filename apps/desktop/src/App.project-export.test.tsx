import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mockCreateExport,
  mockGetExportCapabilities,
  mockGetMobileCapabilities,
  mockOpen,
  resetAppTestHarness,
  renderApp,
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
    expect(within(preview as HTMLElement).getByText("Demo Song - Practice Mix 1 - Vocals.m4a")).toBeInTheDocument();
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
      output_format: "m4a",
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
  });

  it("shows truthful Android limits and disabled export controls", async () => {
    const user = userEvent.setup();
    installExportArtifacts();
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
    expect(screen.getByLabelText("File format")).toHaveAttribute(
      "aria-describedby",
      "android-export-format-notice",
    );
    expect(screen.getByRole("button", { name: "Export 1 file" })).toBeDisabled();
  });
});
