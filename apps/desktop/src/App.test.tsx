import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "./App";

const {
  resetMockApiState,
  mockOpen,
  mockSave,
  mockConfirm,
  mockListProjects,
  mockImportProject,
  mockGetProject,
  mockGetAnalysis,
  mockGetChords,
  mockListArtifacts,
  mockListJobs,
  mockCreateChords,
  mockCreatePreview,
  mockCreateStems,
  mockAnalyzeProject,
  mockUpdateProject,
  mockCreateExport,
  mockDeleteArtifact,
  mockDeleteProject,
  mockCancelJob,
  mockGetHealth,
  setChordTimeline,
} = vi.hoisted(() => {
  const createdAt = "2026-04-18T13:16:00.000Z";
  let state: {
    projects: Array<Record<string, unknown>>;
    analysisByProject: Record<string, Record<string, unknown> | null>;
    chordsByProject: Record<string, Record<string, unknown>>;
    artifactsByProject: Record<string, Array<Record<string, unknown>>>;
    jobs: Array<Record<string, unknown>>;
    nextProjectId: number;
    nextArtifactId: number;
    nextJobId: number;
  };

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  function titleize(value: string) {
    return value
      .replace(/\.[^/.]+$/, "")
      .split(/[-_ ]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function makeProject(
    id: string,
    displayName: string,
    sourcePath: string,
    importedPath = `/tmp/app/${displayName.toLowerCase().replace(/\s+/g, "-")}.wav`,
  ) {
    return {
      id,
      display_name: displayName,
      source_path: sourcePath,
      imported_path: importedPath,
      duration_seconds: 182,
      sample_rate: 44100,
      channels: 2,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  function makeChordTimeline(projectId: string) {
    return {
      project_id: projectId,
      backend: "default",
      source_artifact_id: "art_source",
      created_at: createdAt,
      timeline: [
        { start_seconds: 0, end_seconds: 16, label: "G", confidence: 0.81, pitch_class: 7, quality: "major" },
        { start_seconds: 16, end_seconds: 32, label: "D", confidence: 0.79, pitch_class: 2, quality: "major" },
        { start_seconds: 32, end_seconds: 48, label: "Em", confidence: 0.74, pitch_class: 4, quality: "minor" },
        { start_seconds: 48, end_seconds: 64, label: "C", confidence: 0.76, pitch_class: 0, quality: "major" },
      ],
    };
  }

  function setChordTimeline(projectId: string, timeline: Record<string, unknown> | null) {
    if (timeline === null) {
      delete state.chordsByProject[projectId];
      return;
    }
    state.chordsByProject[projectId] = clone(timeline);
  }

  function resetMockApiState() {
    const demoProject = makeProject("proj_123", "Demo Song", "/tmp/demo.wav");
    state = {
      projects: [demoProject],
      analysisByProject: {
        proj_123: {
          project_id: "proj_123",
          estimated_key: "G major",
          key_confidence: 0.82,
          estimated_reference_hz: 431.9,
          tuning_offset_cents: -32,
          tempo_bpm: null,
          analysis_version: "v1",
          created_at: createdAt,
        },
      },
      chordsByProject: {
        proj_123: makeChordTimeline("proj_123"),
      },
      artifactsByProject: {
        proj_123: [
          {
            id: "art_preview",
            project_id: "proj_123",
            type: "preview_mix",
            format: "wav",
            path: "/tmp/demo-preview.wav",
            metadata: {
              retune: {},
              transpose: { semitones: 2 },
              total_cents: 200,
            },
            created_at: createdAt,
          },
          {
            id: "art_source",
            project_id: "proj_123",
            type: "source_audio",
            format: "wav",
            path: "/tmp/demo.wav",
            metadata: {},
            created_at: createdAt,
          },
        ],
      },
      jobs: [
        {
          id: "job_1",
          project_id: "proj_123",
          type: "preview",
          status: "completed",
          progress: 100,
          error_message: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
        {
          id: "job_2",
          project_id: "proj_123",
          type: "analyze",
          status: "completed",
          progress: 100,
          error_message: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
      nextProjectId: 200,
      nextArtifactId: 200,
      nextJobId: 200,
    };
  }

  resetMockApiState();

  function getProjectOrThrow(projectId: string) {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Unknown project ${projectId}`);
    }
    return project;
  }

  const mockOpen = vi.fn(async (): Promise<string | string[] | null> => null);
  const mockSave = vi.fn(async (): Promise<string | null> => null);
  const mockConfirm = vi.fn(async (): Promise<boolean> => true);
  const mockGetHealth = vi.fn(async () => ({
    status: "ok",
    api_base_url: "http://127.0.0.1:8765/api/v1",
    data_root: "/tmp/tuneforge",
    default_export_format: "wav",
    preview_format: "wav",
  }));
  const mockListProjects = vi.fn(async () => ({ projects: clone(state.projects) }));
  const mockImportProject = vi.fn(async ({ source_path }: { source_path: string }) => {
    const id = `proj_${state.nextProjectId++}`;
    const baseName = source_path.split("/").pop() ?? "Imported Track";
    const displayName = titleize(baseName);
    const project = makeProject(id, displayName, source_path);
    state.projects.unshift(project);
    state.analysisByProject[id] = {
      project_id: id,
      estimated_key: "D major",
      key_confidence: 0.74,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: createdAt,
    };
    state.artifactsByProject[id] = [
      {
        id: `art_${state.nextArtifactId++}`,
        project_id: id,
        type: "source_audio",
        format: "wav",
        path: source_path,
        metadata: {},
        created_at: createdAt,
      },
    ];
    return { project: clone(project) };
  });
  const mockGetProject = vi.fn(async (projectId: string) => ({ project: clone(getProjectOrThrow(projectId)) }));
  const mockGetAnalysis = vi.fn(async (projectId: string) => ({ analysis: clone(state.analysisByProject[projectId] ?? null) }));
  const mockGetChords = vi.fn(async (projectId: string) =>
    clone(
      state.chordsByProject[projectId] ?? {
        project_id: projectId,
        backend: null,
        source_artifact_id: null,
        created_at: null,
        timeline: [],
      },
    ),
  );
  const mockListArtifacts = vi.fn(async (projectId: string) => ({ artifacts: clone(state.artifactsByProject[projectId] ?? []) }));
  const mockListJobs = vi.fn(async () => ({ jobs: clone(state.jobs) }));
  const mockCreateChords = vi.fn(async (projectId: string) => {
    state.chordsByProject[projectId] = makeChordTimeline(projectId);
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "chords",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockCreatePreview = vi.fn(async (projectId: string, body: Record<string, unknown>) => {
    const artifact = {
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type: "preview_mix",
      format: "wav",
      path: `/tmp/${projectId}-mix-${state.nextArtifactId}.wav`,
      metadata: {
        retune: body.retune ?? {},
        transpose: body.transpose ?? {},
      },
      created_at: createdAt,
    };
    state.artifactsByProject[projectId] = [artifact, ...(state.artifactsByProject[projectId] ?? [])];
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "preview",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockCreateStems = vi.fn(async (projectId: string, body: { source_artifact_id?: string; force?: boolean }) => {
    const sourceArtifactId = body.source_artifact_id ?? "art_source";
    state.artifactsByProject[projectId] = (state.artifactsByProject[projectId] ?? []).filter((artifact) => {
      if (artifact.type !== "vocal_stem" && artifact.type !== "instrumental_stem") return true;
      const metadata = (artifact.metadata ?? {}) as { source_artifact_id?: string };
      return metadata.source_artifact_id !== sourceArtifactId;
    });
    const vocalArtifact = {
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type: "vocal_stem",
      format: "wav",
      path: `/tmp/${projectId}-${sourceArtifactId}-vocals.wav`,
      metadata: {
        mode: "two_stem",
        engine: "demucs",
        model: "htdemucs_ft",
        device: "cpu",
        source_artifact_id: sourceArtifactId,
      },
      created_at: createdAt,
    };
    const instrumentalArtifact = {
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type: "instrumental_stem",
      format: "wav",
      path: `/tmp/${projectId}-${sourceArtifactId}-instrumental.wav`,
      metadata: {
        mode: "two_stem",
        engine: "demucs",
        model: "htdemucs_ft",
        device: "cpu",
        source_artifact_id: sourceArtifactId,
      },
      created_at: createdAt,
    };
    state.artifactsByProject[projectId] = [
      vocalArtifact,
      instrumentalArtifact,
      ...(state.artifactsByProject[projectId] ?? []),
    ];
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "stems",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockAnalyzeProject = vi.fn(async (projectId: string) => {
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "analyze",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockUpdateProject = vi.fn(async (projectId: string, body: { display_name: string }) => {
    const project = getProjectOrThrow(projectId);
    project.display_name = body.display_name;
    project.updated_at = createdAt;
    return { project: clone(project) };
  });
  const mockCreateExport = vi.fn(async (projectId: string, body: Record<string, unknown>) => {
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "export",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job), request: clone(body) };
  });
  const mockDeleteArtifact = vi.fn(async (projectId: string, artifactId: string) => {
    state.artifactsByProject[projectId] = (state.artifactsByProject[projectId] ?? []).filter((artifact) => {
      if (artifact.id === artifactId) {
        return false;
      }
      const metadata = (artifact.metadata ?? {}) as { source_artifact_id?: string };
      if ((artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") && metadata.source_artifact_id === artifactId) {
        return false;
      }
      return true;
    });
    return { deleted: true };
  });
  const mockDeleteProject = vi.fn(async (projectId: string) => {
    state.projects = state.projects.filter((project) => project.id !== projectId);
    delete state.analysisByProject[projectId];
    delete state.artifactsByProject[projectId];
    state.jobs = state.jobs.filter((job) => job.project_id !== projectId);
    return { deleted: true };
  });
  const mockCancelJob = vi.fn(async (jobId: string) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (job) {
      job.status = "cancelled";
      job.updated_at = createdAt;
    }
    return { job: clone(job ?? { id: jobId, status: "cancelled" }) };
  });

  return {
    resetMockApiState,
    mockOpen,
    mockSave,
    mockConfirm,
    mockListProjects,
    mockImportProject,
    mockGetProject,
    mockGetAnalysis,
    mockGetChords,
    mockListArtifacts,
    mockListJobs,
    mockCreateChords,
    mockCreatePreview,
    mockCreateStems,
    mockAnalyzeProject,
    mockUpdateProject,
    mockCreateExport,
    mockDeleteArtifact,
    mockDeleteProject,
    mockCancelJob,
    mockGetHealth,
    setChordTimeline,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
  save: mockSave,
  confirm: mockConfirm,
}));

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getHealth: mockGetHealth,
      listProjects: mockListProjects,
      importProject: mockImportProject,
      getProject: mockGetProject,
      getAnalysis: mockGetAnalysis,
      getChords: mockGetChords,
      listArtifacts: mockListArtifacts,
      listJobs: mockListJobs,
      createChords: mockCreateChords,
      createPreview: mockCreatePreview,
      createStems: mockCreateStems,
      analyzeProject: mockAnalyzeProject,
      updateProject: mockUpdateProject,
      createExport: mockCreateExport,
      deleteArtifact: mockDeleteArtifact,
      deleteProject: mockDeleteProject,
      cancelJob: mockCancelJob,
    },
  };
});

function renderApp(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App flows", () => {
  beforeEach(() => {
    resetMockApiState();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    mockOpen.mockReset();
    mockSave.mockReset();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockListProjects.mockClear();
    mockImportProject.mockClear();
    mockGetProject.mockClear();
    mockGetAnalysis.mockClear();
    mockGetChords.mockClear();
    mockListArtifacts.mockClear();
    mockListJobs.mockClear();
    mockCreateChords.mockClear();
    mockCreatePreview.mockClear();
    mockCreateStems.mockClear();
    mockAnalyzeProject.mockClear();
    mockUpdateProject.mockClear();
    mockCreateExport.mockClear();
    mockDeleteArtifact.mockClear();
    mockDeleteProject.mockClear();
    mockCancelJob.mockClear();
    mockGetHealth.mockClear();
  });

  it("imports track from library and opens project", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByText("Practice Projects")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
    });
    expect(await screen.findByRole("heading", { name: "New Song" })).toBeInTheDocument();
  });

  it("keeps selected mix in sync with summary and creates new mix from controls", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(await screen.findByText("Saved Mixes")).toBeInTheDocument();
    const selectedMixSummary = screen.getByRole("group", { name: "Selected mix summary" });
    const mixStatusSummary = screen.getByRole("group", { name: "Mix status summary" });
    const savedMixList = await screen.findByRole("group", { name: "Saved mix list" });

    expect(within(selectedMixSummary).getByText("Practice Mix")).toBeInTheDocument();
    expect(within(selectedMixSummary).getByText("Shift +2 semitones")).toBeInTheDocument();
    expect(within(mixStatusSummary).getByText("Using source settings")).toBeInTheDocument();
    expect(within(mixStatusSummary).getByText("Selected mix differs from current source controls.")).toBeInTheDocument();

    const targetKey = screen.getByLabelText("Target Key") as HTMLSelectElement;
    expect(Array.from(targetKey.options).map((option) => option.text)).toEqual([
      "C",
      "C#/Db",
      "D",
      "D#/Eb",
      "E",
      "F",
      "F#/Gb",
      "G",
      "G#/Ab",
      "A",
      "A#/Bb",
      "B",
    ]);

    await user.click(within(savedMixList).getByRole("button", { name: /Source Track/i }));
    expect(within(selectedMixSummary).getByText("Source Track")).toBeInTheDocument();
    expect(within(selectedMixSummary).getByText("Original source file")).toBeInTheDocument();
    expect(within(mixStatusSummary).getByText("Selected mix matches current controls.")).toBeInTheDocument();

    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    expect(within(selectedMixSummary).getByText("Practice Mix")).toBeInTheDocument();
    expect(within(selectedMixSummary).getByText("Shift +2 semitones")).toBeInTheDocument();

    const currentKey = screen.getByLabelText("Current Key");
    const createMixButton = screen.getByRole("button", { name: "Create Mix" });
    await user.click(screen.getByText("Correct source key if detection is wrong"));
    await user.selectOptions(currentKey, "9:major");
    await user.click(screen.getByLabelText("Raise target key"));
    await user.click(createMixButton);

    expect(mockCreatePreview).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        output_format: "wav",
        transpose: { semitones: 1 },
      }),
    );
  });

  it("transposes chord display for the selected mix and source track", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Chord timeline" })).toBeInTheDocument();
    const currentChordCard = screen.getByRole("group", { name: "Current chord card" });
    const nextChordCard = screen.getByRole("group", { name: "Next chord card" });
    expect(within(currentChordCard).getByText("A")).toBeInTheDocument();
    expect(within(nextChordCard).getByText("E")).toBeInTheDocument();

    const savedMixList = await screen.findByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Source Track/i }));

    expect(within(currentChordCard).getByText("G")).toBeInTheDocument();
    expect(within(nextChordCard).getByText("D")).toBeInTheDocument();
  });

  it("recenters the chord lane when a later chord becomes active", async () => {
    const user = userEvent.setup();
    const scrollIntoViewMock = vi.mocked(window.HTMLElement.prototype.scrollIntoView);
    scrollIntoViewMock.mockClear();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const chordTimeline = screen.getByRole("group", { name: "Chord timeline" });
    const chordButtons = within(chordTimeline).getAllByRole("button");
    await user.click(chordButtons[chordButtons.length - 1]);

    await waitFor(() => {
      const currentChordCard = screen.getByRole("group", { name: "Current chord card" });
      const nextChordCard = screen.getByRole("group", { name: "Next chord card" });
      expect(within(currentChordCard).getByText("D")).toBeInTheDocument();
      expect(within(nextChordCard).getByText("—")).toBeInTheDocument();
    });
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("queues chord detection when the project has no saved chord timeline", async () => {
    const user = userEvent.setup();
    setChordTimeline("proj_123", null);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByText("Generate a chord timeline to jump around the song while you practice.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Generate Chords" }));

    expect(mockCreateChords).toHaveBeenCalledWith("proj_123", { backend: "default", force: false });
  });

  it("generates stems and lets the app select them", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        mode: "two_stem",
        output_format: "wav",
        force: false,
        source_artifact_id: "art_preview",
      }),
    );

    const stemList = await screen.findByRole("group", { name: "Stem track list" });
    await user.click(within(stemList).getByRole("button", { name: /Vocals/i }));

    const selectedSummary = screen.getByRole("group", { name: "Selected mix summary" });
    const statusSummary = screen.getByRole("group", { name: "Mix status summary" });
    expect(within(selectedSummary).getByText("Vocals")).toBeInTheDocument();
    expect(within(selectedSummary).getByText(/Vocal stem/)).toBeInTheDocument();
    expect(within(statusSummary).getByText("Stem tracks are independent from mix controls.")).toBeInTheDocument();
  });

  it("keeps stem lists scoped to selected audio", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    const stemList = await screen.findByRole("group", { name: "Stem track list" });
    expect(within(stemList).getAllByRole("button")).toHaveLength(2);

    const savedMixList = await screen.findByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Source Track/i }));

    expect(screen.getByText("No stems yet for selected audio.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Stems" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    expect(mockCreateStems).toHaveBeenLastCalledWith(
      "proj_123",
      expect.objectContaining({
        mode: "two_stem",
        output_format: "wav",
        force: false,
        source_artifact_id: "art_source",
      }),
    );

    const sourceStemList = await screen.findByRole("group", { name: "Stem track list" });
    expect(within(sourceStemList).getAllByRole("button")).toHaveLength(2);

    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    expect(screen.getByRole("button", { name: "Refresh Stems" })).toBeInTheDocument();
  });

  it("renames project from project screen", async () => {
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

  it("exports selected mix and uses selected artifact id", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue("/tmp/exports/demo-source.flac");

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(await screen.findByText("Saved Mixes")).toBeInTheDocument();
    const savedMixList = await screen.findByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Source Track/i }));
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

  it("toggles inspector visibility without affecting playback selection", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByText("Mix Builder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Inspector" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide Inspector" }));

    expect(screen.queryByText("Mix Builder")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Inspector" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Selected mix summary" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show Inspector" }));

    expect(screen.getByText("Mix Builder")).toBeInTheDocument();
  });

  it("requires confirmation before deleting a project", async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(false);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete Project" }));

    expect(mockConfirm).toHaveBeenCalledWith("Delete this project and all of its mixes, stems, and exports?", {
      title: "Delete project",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
  });

  it("deletes project after confirmation and returns to library", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete Project" }));

    expect(mockDeleteProject).toHaveBeenCalledWith("proj_123");
    expect(await screen.findByText("Practice Projects")).toBeInTheDocument();
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  });

  it("deletes a practice mix with confirmation and removes its stems", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    const savedMixList = await screen.findByRole("group", { name: "Saved mix list" });
    expect(within(savedMixList).getByRole("button", { name: /Practice Mix/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Delete Practice Mix" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete Practice Mix" }));

    expect(mockConfirm).toHaveBeenCalledWith("Delete this practice mix and its stem tracks?", {
      title: "Delete practice mix",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    expect(mockDeleteArtifact).toHaveBeenCalledWith("proj_123", "art_preview");
    const selectedSummary = screen.getByRole("group", { name: "Selected mix summary" });
    expect(await within(selectedSummary).findByText("Source Track")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Practice Mix" })).not.toBeInTheDocument();
    expect(screen.getByText("No stems yet for selected audio.")).toBeInTheDocument();
  });

  it("does not offer mix deletion for the source track", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const savedMixList = await screen.findByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Source Track/i }));

    expect(screen.queryByRole("button", { name: "Delete Practice Mix" })).not.toBeInTheDocument();
  });

  it("renders settings and persists theme changes", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByText("Backend and Storage")).toBeInTheDocument();
    expect(await screen.findByText("/tmp/tuneforge")).toBeInTheDocument();

    const themeSelect = screen.getByLabelText("Theme");
    expect(themeSelect).toHaveValue("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("dark");

    await user.selectOptions(themeSelect, "light");

    expect(themeSelect).toHaveValue("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("light");
  });
});
