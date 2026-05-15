import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAppTestHarness,
  findAudioByArtifactId,
  markAudioReady,
  mockConfirm,
  mockCreateExport,
  mockCreateStems,
  mockDeleteArtifact,
  mockListJobs,
  mockSave,
  mockUpdateProject,
  renderApp,
  setJobs,
  setProjectChords,
} from "./test/appTestHarness";
import {
  ensureInspectorVisible,
  generateStems,
  openAnalysisPanel,
  openStudioPanel,
  refreshJobs,
  selectFirstStemInAnalysis,
} from "./test/projectTestActions";

describe("Desktop app project playback artifacts", () => {
  beforeEach(resetAppTestHarness);

  it("enables source stem delete in analysis when playback and jobs are idle", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    await selectFirstStemInAnalysis(user);

    expect(screen.getByRole("button", { name: "Delete Source Track Stems" })).toBeEnabled();
  });

  it("disables source stem delete while playback is active", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await generateStems(user);
    await selectFirstStemInAnalysis(user);

    expect(screen.getByRole("button", { name: "Delete Source Track Stems" })).toBeDisabled();
  });

  it.each([
    { label: "chord", jobType: "chords", status: "running" },
    { label: "stem", jobType: "stems", status: "running" },
    { label: "export running", jobType: "export", status: "running" },
    { label: "export pending", jobType: "export", status: "pending" },
  ] as const)("disables stem delete while a $label job is active", async ({ jobType, status }) => {
    const user = userEvent.setup();
    const { queryClient } = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    await selectFirstStemInAnalysis(user);

    setJobs([
      {
        id: `job_${jobType}_${status}`,
        project_id: "proj_123",
        type: jobType,
        status,
        progress: 50,
        source_artifact_id: jobType === "stems" ? "art_source" : null,
        error_message: null,
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
    ]);
    await refreshJobs(queryClient);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete Source Track Stems" })).toBeDisabled(),
    );
  });

  it.each(["pending", "running"] as const)(
    "disables saved mix delete while an export job is %s",
    async (jobStatus) => {
      const { queryClient } = renderApp(["/projects/proj_123"]);

      expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
      const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
      setJobs([
        {
          id: `job_export_${jobStatus}`,
          project_id: "proj_123",
          type: "export",
          status: jobStatus,
          progress: 50,
          source_artifact_id: null,
          error_message: null,
          created_at: "2026-04-18T13:16:00.000Z",
          updated_at: "2026-04-18T13:16:00.000Z",
        },
      ]);
      await refreshJobs(queryClient);

      await waitFor(() =>
        expect(within(savedMixList).getByRole("button", { name: "Delete saved mix" })).toBeDisabled(),
      );
    },
  );

  it("deletes a visible stem from the sources rail", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    const stemList = await screen.findByRole("group", { name: "Stem track list" });

    await user.click(
      within(stemList).getAllByRole("button", { name: "Delete stem track" })[0] as HTMLElement,
    );

    expect(mockConfirm).toHaveBeenCalledWith(
      "Delete Vocals stem? Regenerating stems rebuilds the full selected stem model set.",
      expect.objectContaining({
        title: "Delete stem",
        kind: "warning",
        okLabel: "Delete",
      }),
    );
    await waitFor(() => expect(mockDeleteArtifact).toHaveBeenCalledWith("proj_123", "art_200"));
    const updatedStemList = screen.queryByRole("group", { name: "Stem track list" });
    expect(
      updatedStemList
        ? within(updatedStemList).queryByRole("button", { name: /Vocals/i })
        : null,
    ).not.toBeInTheDocument();
  });

  it("exposes sources rail delete for saved mixes but not the source track", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceList = screen.getByRole("group", { name: "Source and mix list" });

    expect(
      within(sourceList).queryByRole("button", { name: "Delete Source Track" }),
    ).not.toBeInTheDocument();
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });

    await user.click(within(savedMixList).getByRole("button", { name: "Delete saved mix" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Delete this practice mix and its stem tracks? Rebuilding stems later may take longer on CPU-only desktops.",
      expect.objectContaining({
        title: "Delete practice mix",
        kind: "warning",
        okLabel: "Delete",
      }),
    );
    await waitFor(() => expect(mockDeleteArtifact).toHaveBeenCalledWith("proj_123", "art_preview"));
  });

  it("disables saved mix delete while playback is active", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    expect(within(savedMixList).getByRole("button", { name: "Delete saved mix" })).toBeDisabled();
  });

  it("shows analysis bulk delete buttons and deletes all mixes", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openAnalysisPanel(user);

    expect(screen.getByRole("button", { name: "Delete Project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete All Mixes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete All Stems" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Delete All Mixes" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Delete all practice mixes and their stem tracks?",
      expect.objectContaining({
        title: "Delete all mixes",
        kind: "warning",
        okLabel: "Delete",
      }),
    );
    await waitFor(() => expect(mockDeleteArtifact).toHaveBeenCalledWith("proj_123", "art_preview"));
  });

  it("deletes all stems across source audio and saved mixes from analysis", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await generateStems(user);
    await openAnalysisPanel(user);

    await user.click(screen.getByRole("button", { name: "Delete All Stems" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Delete all stem tracks? Mixes and source track stay.",
      expect.objectContaining({
        title: "Delete all stems",
        kind: "warning",
        okLabel: "Delete",
      }),
    );
    await waitFor(() => expect(mockDeleteArtifact).toHaveBeenCalledTimes(12));
  });

  it("deletes only source stems from the analysis context button", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    await openAnalysisPanel(user);

    await user.click(screen.getByRole("button", { name: "Delete Source Track Stems" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Delete stems for Source Track? Source audio stays.",
      expect.objectContaining({
        title: "Delete source stems",
        kind: "warning",
        okLabel: "Delete",
      }),
    );
    await waitFor(() => expect(mockDeleteArtifact).toHaveBeenCalledTimes(6));
    expect(mockDeleteArtifact.mock.calls.map((call) => call[1])).toEqual([
      "art_200",
      "art_201",
      "art_202",
      "art_203",
      "art_204",
      "art_205",
    ]);
  });

  it("derives practice mix stem deletion from selected stem metadata", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await generateStems(user);
    const stemList = await screen.findByRole("group", { name: "Stem track list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    await openAnalysisPanel(user);

    await user.click(screen.getByRole("button", { name: "Delete Practice Mix Stems" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      "Delete stems for Practice Mix? Practice mix stays.",
      expect.objectContaining({
        title: "Delete practice mix stems",
        kind: "warning",
        okLabel: "Delete",
      }),
    );
    await waitFor(() => expect(mockDeleteArtifact).toHaveBeenCalledTimes(6));
    expect(mockDeleteArtifact.mock.calls.map((call) => call[1])).toEqual([
      "art_206",
      "art_207",
      "art_208",
      "art_209",
      "art_210",
      "art_211",
    ]);
  });

  it("shows failed stem jobs inline and in processing history", async () => {
    const user = userEvent.setup();
    mockListJobs.mockResolvedValue({
      jobs: [
        {
          id: "job_stem_failed",
          project_id: "proj_123",
          type: "stems",
          status: "failed",
          progress: 15,
          source_artifact_id: "art_source",
          stem_model: "htdemucs_ft",
          stem_model_label: "2 stems model",
          error_message: "Demucs failed to separate the track.",
          runtime_device: "cpu",
          duration_seconds: 3.4,
          created_at: "2026-04-18T13:16:00.000Z",
          updated_at: "2026-04-18T13:16:00.000Z",
        },
      ],
    });

    renderApp(["/projects/proj_123"]);

    const stemError = await screen.findByRole("group", { name: "Stem error" });
    expect(within(stemError).getByText("Demucs failed to separate the track.")).toBeInTheDocument();

    await openAnalysisPanel(user);
    await user.click(screen.getByText("Show raw artifacts and processing history"));
    const jobHistory = screen.getByText("Show raw artifacts and processing history").closest("details");
    expect(jobHistory).not.toBeNull();

    expect(within(jobHistory as HTMLElement).getByText("stems")).toBeInTheDocument();
    expect(
      within(jobHistory as HTMLElement).getByText(/failed \/ 2 stems model \/ CPU \/ 3.4 s/i),
    ).toBeInTheDocument();
    expect(
      within(jobHistory as HTMLElement).getByText("Demucs failed to separate the track."),
    ).toBeInTheDocument();
  });

  it("scopes stem errors to selected audio and lets user dismiss them", async () => {
    const user = userEvent.setup();
    mockListJobs.mockResolvedValue({
      jobs: [
        {
          id: "job_stem_preview_failed",
          project_id: "proj_123",
          type: "stems",
          status: "failed",
          progress: 15,
          source_artifact_id: "art_preview",
          error_message: "Preview stems failed.",
          created_at: "2026-04-18T13:16:00.000Z",
          updated_at: "2026-04-18T13:16:00.000Z",
        },
      ],
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Stem error" })).not.toBeInTheDocument();

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    const stemError = await screen.findByRole("group", { name: "Stem error" });
    expect(within(stemError).getByText("Preview stems failed.")).toBeInTheDocument();
    await user.click(within(stemError).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("group", { name: "Stem error" })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    const demoProjectCard = screen.getByRole("heading", { name: "Demo Song", level: 2 }).closest(
      "article",
    );
    expect(demoProjectCard).not.toBeNull();
    await user.click(
      within(demoProjectCard as HTMLElement).getByRole("link", { name: "Open Demo Song project" }),
    );

    expect(await screen.findByRole("heading", { name: "Practice Mix" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Stem error" })).not.toBeInTheDocument();
  });

  it("exports selected audio", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue("/tmp/exports/demo-source.flac");

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await ensureInspectorVisible(user);
    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));
    await openAnalysisPanel(user);
    await user.click(screen.getByRole("button", { name: "Export Selected Audio" }));

    expect(mockSave).toHaveBeenCalled();
    expect(mockCreateExport).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        artifact_ids: ["art_source"],
        output_format: "flac",
        destination_path: "/tmp/exports",
      }),
    );
  });

  it("renames project from the title row", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByLabelText("Project name");
    await user.clear(nameInput);
    await user.type(nameInput, "Practice Set");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockUpdateProject).toHaveBeenCalledWith("proj_123", { display_name: "Practice Set" });
    expect(await screen.findByRole("heading", { name: "Practice Set" })).toBeInTheDocument();
  });

  it("counts total stems across source audio and saved mixes in the collapsed sources rail", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);

    await openStudioPanel(user);
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await generateStems(user);

    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Collapse sources rail" }));

    const stemSummaryChip = screen.getByText("Stem").closest(".rail-summary-chip");
    expect(stemSummaryChip).not.toBeNull();
    expect(within(stemSummaryChip as HTMLElement).getByText("12")).toBeInTheDocument();
  });

  it("asks for confirmation before rebuilding existing stems", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();

    await generateStems(user);
    expect(mockCreateStems).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Rebuild Stems" }));

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringContaining("CPU rebuilds may take longer"),
      expect.objectContaining({
        title: "Rebuild stems",
        kind: "warning",
        okLabel: "Rebuild",
      }),
    );
    expect(mockCreateStems).toHaveBeenCalledTimes(2);
    expect(mockCreateStems).toHaveBeenLastCalledWith(
      "proj_123",
      expect.objectContaining({
        force: true,
        source_artifact_id: "art_source",
      }),
    );
  });

  it("warns before source stem generation can replace chord edits", async () => {
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
    await generateStems(user);

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringContaining("Existing chord edits will be replaced"),
      expect.objectContaining({
        title: "Generate stems",
        kind: "warning",
        okLabel: "Generate",
      }),
    );
    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        force: false,
        overwrite_chord_edits: true,
        source_artifact_id: "art_source",
      }),
    );
  });

  it("does not warn about chord edits for practice mix stem generation", async () => {
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
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await generateStems(user);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        overwrite_chord_edits: false,
        source_artifact_id: "art_preview",
      }),
    );
  });
});
