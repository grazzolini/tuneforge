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
import { ApiError } from "./lib/api";
import {
  ensureInspectorVisible,
  generateStems,
  openAnalysisPanel,
  openStudioPanel,
  refreshJobs,
  selectFirstStemInAnalysis,
} from "./test/projectTestActions";

const PROJECT_JOB_HISTORY_PAGE_SIZE = 50;
const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;

function getJobsHistoryDetails() {
  const jobHistory = screen.getByText("Show raw artifacts and processing history").closest("details");
  expect(jobHistory).not.toBeNull();
  return jobHistory as HTMLElement;
}

async function expectProjectJobsRequested(projectId: string) {
  await waitFor(() =>
    expect(mockListJobs.mock.calls.some(([params]) => params?.project_id === projectId)).toBe(true),
  );
}

async function expectProjectTerminalJobsPageRequested(offset: number) {
  await waitFor(() => {
    const hasMatchingCall = mockListJobs.mock.calls.some(([params]) => {
      const status = params?.status;
      return (
        params?.project_id === "proj_123" &&
        params.limit === PROJECT_JOB_HISTORY_PAGE_SIZE &&
        params.offset === offset &&
        Array.isArray(status) &&
        status.length === TERMINAL_JOB_STATUSES.length &&
        TERMINAL_JOB_STATUSES.every((terminalStatus) => status.includes(terminalStatus))
      );
    });

    expect(hasMatchingCall).toBe(true);
  });
}

function terminalJob(index: number, overrides: Record<string, unknown> = {}) {
  const minute = 59 - (index % 60);
  const timestamp = `2026-04-18T13:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id: `job_terminal_${index}`,
    project_id: "proj_123",
    type: "export",
    status: "completed",
    progress: 100,
    source_artifact_id: null,
    error_message: null,
    completed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function exportDestinationExistsError() {
  return new ApiError({
    code: "EXPORT_DESTINATION_EXISTS",
    message: "Export destination already exists.",
    details: {},
  });
}

async function exportSelectedSourceAudio(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
  await ensureInspectorVisible(user);
  const sourceList = screen.getByRole("group", { name: "Source and mix list" });
  await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));
  await openAnalysisPanel(user);
  await user.click(screen.getByRole("button", { name: "Export Selected Audio" }));
}

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

  it("loads project-scoped jobs so global pagination cannot hide project failures", async () => {
    setJobs([
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `job_other_running_${index}`,
        project_id: `proj_other_${index}`,
        type: "stems",
        status: "running",
        progress: 50,
        source_artifact_id: null,
        error_message: null,
        created_at: "2026-04-18T13:00:00.000Z",
        updated_at: "2026-04-18T13:00:00.000Z",
      })),
      {
        id: "job_selected_failed",
        project_id: "proj_123",
        type: "stems",
        status: "failed",
        progress: 15,
        source_artifact_id: "art_source",
        error_message: "Selected project stems failed.",
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await expectProjectJobsRequested("proj_123");
    const stemError = await screen.findByRole("group", { name: "Stem error" });
    expect(within(stemError).getByText("Selected project stems failed.")).toBeInTheDocument();
  });

  it("shows live lyrics transcription progress in project job history without raw runtime output", async () => {
    const user = userEvent.setup();
    setJobs([
      {
        id: "job_lyrics_transcribing",
        project_id: "proj_123",
        type: "lyrics",
        status: "running",
        progress: 68,
        stage_label: "Transcribing lyrics.",
        lyrics_source: "vocals",
        runtime_device: "cuda",
        runtime_detail: "stderr: /Users/example/song.wav ETA 00:12",
        source_artifact_id: null,
        error_message: null,
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      },
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openAnalysisPanel(user);
    await user.click(screen.getByText("Show raw artifacts and processing history"));
    await expectProjectJobsRequested("proj_123");

    const jobHistory = getJobsHistoryDetails();
    const progressBar = await within(jobHistory).findByRole("progressbar", { name: "lyrics job progress" });

    expect(within(jobHistory).getByText("Transcribing lyrics")).toBeInTheDocument();
    expect(within(jobHistory).getByText("running / vocals / CUDA")).toBeInTheDocument();
    expect(progressBar).toHaveAttribute("value", "68");
    expect(progressBar).toHaveAttribute("max", "100");
    expect(jobHistory).not.toHaveTextContent(/stderr|song\.wav|ETA/i);
  });

  it("shows dependency job history errors without raw output or paths", async () => {
    const user = userEvent.setup();
    setJobs([
      {
        id: "job_stems_missing_demucs",
        project_id: "proj_123",
        type: "stems",
        status: "failed",
        progress: 15,
        source_artifact_id: "art_source",
        error_message: "Demucs is required for stem separation. stderr: /Users/test/Music/Secret Demo.wav",
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openAnalysisPanel(user);
    await user.click(screen.getByText("Show raw artifacts and processing history"));
    await expectProjectJobsRequested("proj_123");

    const jobHistory = getJobsHistoryDetails();
    expect(jobHistory).toHaveTextContent(
      "Demucs is required for stem separation. Dependency: Demucs. Next: Install local backend stem dependencies, then retry stem separation.",
    );
    expect(jobHistory).not.toHaveTextContent(/stderr|Secret Demo|Users|\.wav/i);
  });

  it("loads later project terminal job pages with scoped filters", async () => {
    const user = userEvent.setup();
    setJobs([
      ...Array.from({ length: PROJECT_JOB_HISTORY_PAGE_SIZE }, (_, index) =>
        terminalJob(index, { id: `job_initial_terminal_${index}` }),
      ),
      terminalJob(PROJECT_JOB_HISTORY_PAGE_SIZE, {
        id: "job_terminal_second_page",
        status: "failed",
        error_message: "Second terminal jobs page failed export.",
      }),
      {
        id: "job_other_project_terminal",
        project_id: "proj_other",
        type: "export",
        status: "failed",
        progress: 100,
        source_artifact_id: null,
        error_message: "Other project failure must stay hidden.",
        created_at: "2026-04-18T13:59:00.000Z",
        updated_at: "2026-04-18T13:59:00.000Z",
      },
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openAnalysisPanel(user);
    await user.click(screen.getByText("Show raw artifacts and processing history"));

    const jobHistory = getJobsHistoryDetails();
    await expectProjectTerminalJobsPageRequested(0);
    expect(within(jobHistory).queryByText("Second terminal jobs page failed export.")).not.toBeInTheDocument();

    await user.click(within(jobHistory).getByRole("button", { name: /load more/i }));

    await expectProjectTerminalJobsPageRequested(PROJECT_JOB_HISTORY_PAGE_SIZE);
    expect(await within(jobHistory).findByText("Second terminal jobs page failed export.")).toBeInTheDocument();
    expect(within(jobHistory).queryByText("Other project failure must stay hidden.")).not.toBeInTheDocument();
  });

  it("keeps loaded project job history visible when the next page fails", async () => {
    const user = userEvent.setup();
    setJobs([
      terminalJob(0, {
        id: "job_terminal_loaded_first",
        status: "failed",
        error_message: "Loaded terminal history stays visible.",
      }),
      ...Array.from({ length: PROJECT_JOB_HISTORY_PAGE_SIZE - 1 }, (_, index) =>
        terminalJob(index + 1, { id: `job_terminal_loaded_${index + 1}` }),
      ),
      terminalJob(PROJECT_JOB_HISTORY_PAGE_SIZE, {
        id: "job_terminal_unloaded_after_failure",
        status: "failed",
        error_message: "Unloaded terminal history stays hidden.",
      }),
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openAnalysisPanel(user);
    await user.click(screen.getByText("Show raw artifacts and processing history"));

    const jobHistory = getJobsHistoryDetails();
    await expectProjectTerminalJobsPageRequested(0);
    expect(within(jobHistory).getByText("Loaded terminal history stays visible.")).toBeInTheDocument();

    mockListJobs.mockClear();
    mockListJobs.mockRejectedValueOnce(new Error("Project job history page failed."));
    await user.click(within(jobHistory).getByRole("button", { name: /load more/i }));

    await expectProjectTerminalJobsPageRequested(PROJECT_JOB_HISTORY_PAGE_SIZE);
    expect(within(jobHistory).getByText("Loaded terminal history stays visible.")).toBeInTheDocument();
    expect(within(jobHistory).queryByText("Unloaded terminal history stays hidden.")).not.toBeInTheDocument();
    expect(await within(jobHistory).findByText("Could not load more history.")).toBeInTheDocument();
  });

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
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
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
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
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

    await exportSelectedSourceAudio(user);

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: ["wav"] }),
          expect.objectContaining({ extensions: ["mp3"] }),
          expect.objectContaining({ extensions: ["flac"] }),
        ]),
      }),
    );
    expect(mockCreateExport).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        artifact_ids: ["art_source"],
        output_format: "flac",
        destination_file_path: "/tmp/exports/demo-source.flac",
      }),
    );
    expect(mockCreateExport.mock.calls[0]?.[1]).not.toHaveProperty("destination_path");
  });

  it("does not create an export when the save dialog is canceled", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue(null);

    renderApp(["/projects/proj_123"]);

    await exportSelectedSourceAudio(user);

    expect(mockSave).toHaveBeenCalled();
    expect(mockCreateExport).not.toHaveBeenCalled();
  });

  it("does not retry export when an existing destination warning is canceled", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue("/tmp/exports/demo-source.wav");
    mockConfirm.mockResolvedValueOnce(false);
    mockCreateExport.mockRejectedValueOnce(exportDestinationExistsError());

    renderApp(["/projects/proj_123"]);

    await exportSelectedSourceAudio(user);

    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith(
        expect.stringContaining("already exists"),
        expect.objectContaining({
          title: "Replace existing export?",
          kind: "warning",
          okLabel: "Replace",
        }),
      ),
    );
    expect(mockCreateExport).toHaveBeenCalledTimes(1);
    expect(mockCreateExport.mock.calls[0]?.[1]).not.toHaveProperty("overwrite_existing");
  });

  it("retries export once with overwrite when an existing destination warning is approved", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue("/tmp/exports/demo-source.mp3");
    mockConfirm.mockResolvedValueOnce(true);
    mockCreateExport.mockRejectedValueOnce(exportDestinationExistsError());

    renderApp(["/projects/proj_123"]);

    await exportSelectedSourceAudio(user);

    await waitFor(() => expect(mockCreateExport).toHaveBeenCalledTimes(2));
    expect(mockCreateExport).toHaveBeenNthCalledWith(
      1,
      "proj_123",
      expect.objectContaining({
        artifact_ids: ["art_source"],
        output_format: "mp3",
        destination_file_path: "/tmp/exports/demo-source.mp3",
      }),
    );
    expect(mockCreateExport.mock.calls[0]?.[1]).not.toHaveProperty("overwrite_existing");
    expect(mockCreateExport).toHaveBeenNthCalledWith(
      2,
      "proj_123",
      expect.objectContaining({
        artifact_ids: ["art_source"],
        output_format: "mp3",
        destination_file_path: "/tmp/exports/demo-source.mp3",
        overwrite_existing: true,
      }),
    );
    expect(mockCreateExport.mock.calls[1]?.[1]).not.toHaveProperty("destination_path");
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

  it("does not warn about chord edits for source stem generation", async () => {
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

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        force: false,
        overwrite_chord_edits: false,
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
