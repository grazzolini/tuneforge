import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "./App";

const {
  resetMockApiState,
  setProjects,
  setProjectAnalysis,
  setDeferredPreviewCompletion,
  flushPendingPreview,
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
  mockGetHealth,
} = vi.hoisted(() => {
  const createdAt = "2026-04-18T13:16:00.000Z";
  let state: {
    projects: Array<Record<string, unknown>>;
    analysisByProject: Record<string, Record<string, unknown> | null>;
    chordsByProject: Record<string, Record<string, unknown>>;
    artifactsByProject: Record<string, Array<Record<string, unknown>>>;
    pendingPreviewArtifactsByProject: Record<string, Array<Record<string, unknown>>>;
    jobs: Array<Record<string, unknown>>;
    nextProjectId: number;
    nextArtifactId: number;
    nextJobId: number;
    deferPreviewCompletion: boolean;
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

  function setProjects(projects: Array<Record<string, unknown>>) {
    state.projects = clone(projects);
  }

  function setProjectAnalysis(projectId: string, analysis: Record<string, unknown> | null) {
    state.analysisByProject[projectId] = analysis ? clone(analysis) : null;
  }

  function setDeferredPreviewCompletion(value: boolean) {
    state.deferPreviewCompletion = value;
  }

  function flushPendingPreview(projectId: string) {
    const pendingArtifacts = state.pendingPreviewArtifactsByProject[projectId] ?? [];
    if (!pendingArtifacts.length) {
      return;
    }
    state.artifactsByProject[projectId] = [
      ...pendingArtifacts,
      ...(state.artifactsByProject[projectId] ?? []),
    ];
    state.pendingPreviewArtifactsByProject[projectId] = [];
    state.jobs = state.jobs.map((job) =>
      job.project_id === projectId && job.type === "preview" && job.status !== "completed"
        ? { ...job, status: "completed", progress: 100, updated_at: createdAt }
        : job,
    );
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
      pendingPreviewArtifactsByProject: {},
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
      deferPreviewCompletion: false,
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
  const mockListProjects = vi.fn(async (search?: string) => {
    const normalizedSearch = search?.trim().toLowerCase();
    const filteredProjects = normalizedSearch
      ? state.projects.filter((project) => {
          const displayName = String(project.display_name ?? "").toLowerCase();
          const sourcePath = String(project.source_path ?? "").toLowerCase();
          const importedPath = String(project.imported_path ?? "").toLowerCase();
          return (
            displayName.includes(normalizedSearch) ||
            sourcePath.includes(normalizedSearch) ||
            importedPath.includes(normalizedSearch)
          );
        })
      : state.projects;
    return { projects: clone(filteredProjects) };
  });
  const mockImportProject = vi.fn(async ({ source_path }: { source_path: string }) => {
    const id = `proj_${state.nextProjectId++}`;
    const baseName = source_path.split("/").pop() ?? "Imported Track";
    const displayName = titleize(baseName);
    const project = makeProject(id, displayName, source_path);
    state.projects.unshift(project);
    state.analysisByProject[id] = null;
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
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "preview",
      status: state.deferPreviewCompletion ? "running" : "completed",
      progress: state.deferPreviewCompletion ? 25 : 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    if (state.deferPreviewCompletion) {
      state.pendingPreviewArtifactsByProject[projectId] = [
        artifact,
        ...(state.pendingPreviewArtifactsByProject[projectId] ?? []),
      ];
    } else {
      state.artifactsByProject[projectId] = [artifact, ...(state.artifactsByProject[projectId] ?? [])];
    }
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
    state.analysisByProject[projectId] = {
      project_id: projectId,
      estimated_key: "D major",
      key_confidence: 0.74,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: createdAt,
    };
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

  return {
    resetMockApiState,
    setProjects,
    setProjectAnalysis,
    setDeferredPreviewCompletion,
    flushPendingPreview,
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
    mockGetHealth,
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
    },
  };
});

function renderApp(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function installMatchMediaMock(initialMatches = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialMatches;

  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_eventName: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_eventName: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      listeners.forEach((listener) =>
        listener({ matches: nextMatches } as MediaQueryListEvent),
      );
    },
  };
}

function findAudioByArtifactId(artifactId: string) {
  const element = Array.from(document.querySelectorAll("audio")).find((candidate) =>
    candidate.getAttribute("src")?.includes(`/artifacts/${artifactId}/stream`),
  );
  if (!element) {
    throw new Error(`Audio element not found for artifact ${artifactId}`);
  }
  return element as HTMLAudioElement;
}

function markAudioReady(element: HTMLAudioElement, duration = 182) {
  Object.defineProperty(element, "duration", {
    configurable: true,
    value: duration,
  });
  fireEvent.loadedMetadata(element);
  fireEvent.canPlay(element);
}

describe("Desktop app flows", () => {
  beforeEach(() => {
    resetMockApiState();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.removeAttribute("style");
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
    mockGetHealth.mockClear();
    vi.mocked(window.HTMLMediaElement.prototype.play).mockClear();
    vi.mocked(window.HTMLMediaElement.prototype.pause).mockClear();
    installMatchMediaMock(false);
  });

  it("filters library results with project search", async () => {
    const user = userEvent.setup();
    setProjects([
      {
        id: "proj_1",
        display_name: "Choir Warmup",
        source_path: "/tmp/choir-warmup.wav",
        imported_path: "/tmp/projects/choir-warmup.wav",
        duration_seconds: 95,
        sample_rate: 44100,
        channels: 2,
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
      {
        id: "proj_2",
        display_name: "Bass Drill",
        source_path: "/tmp/bass-drill.wav",
        imported_path: "/tmp/projects/bass-drill.wav",
        duration_seconds: 120,
        sample_rate: 48000,
        channels: 2,
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
    ]);

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search projects"), "choir");

    await waitFor(() => expect(mockListProjects).toHaveBeenLastCalledWith("choir"));
    expect(screen.getByText("Choir Warmup")).toBeInTheDocument();
    expect(screen.queryByText("Bass Drill")).not.toBeInTheDocument();
  });

  it("imports track from library and opens project", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
    });
    await waitFor(() =>
      expect(mockGetProject).toHaveBeenCalledWith(expect.stringMatching(/^proj_/)),
    );
    expect(await screen.findByRole("heading", { name: "New Song" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Inspector" })).toBeInTheDocument();
  });

  it("analyzes track from inspector", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", null);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    await user.click(screen.getByRole("button", { name: "Analyze Track" }));

    expect(mockAnalyzeProject).toHaveBeenCalledWith("proj_123");
  });

  it("creates a new mix from source-key controls", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));
    await user.click(screen.getByText("Correct source key if detection is wrong"));
    await user.selectOptions(screen.getByLabelText("Current Key"), "9:major");
    await user.click(screen.getByLabelText("Raise target key"));
    await user.click(screen.getByRole("button", { name: "Create Mix" }));

    expect(mockCreatePreview).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        output_format: "wav",
        transpose: { semitones: 1 },
      }),
    );
  });

  it("switches between source playback and stems", async () => {
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
        source_artifact_id: "art_source",
      }),
    );

    const stemList = await screen.findByRole("group", { name: "Stem track list" });
    await user.click(within(stemList).getByRole("button", { name: /Vocals/i }));

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(screen.getAllByText("Stem monitor").length).toBeGreaterThan(0);

    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));

    expect(await screen.findByRole("heading", { name: "Source Track" })).toBeInTheDocument();
    expect(screen.getByText("Full playback")).toBeInTheDocument();
  });

  it("persists selected stem playback state across project reopen", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    const stemList = await screen.findByRole("group", { name: "Stem track list" });
    await user.click(within(stemList).getByRole("button", { name: /Vocals/i }));

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"),
      ).toMatchObject({
        proj_123: {
          selectedArtifactId: "art_200",
          selectedPrimaryArtifactId: "art_source",
        },
      }),
    );

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    expect(await screen.findByText("Background Playback")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));

    const demoProjectCard = screen.getByText("Demo Song").closest("article");
    expect(demoProjectCard).not.toBeNull();
    await user.click(
      within(demoProjectCard as HTMLElement).getByRole("link", { name: /Open project/i }),
    );

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(screen.getAllByText("Stem monitor").length).toBeGreaterThan(0);
  });

  it("toggles playback with spacebar and preserves time when switching mixes", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    fireEvent.keyDown(window, { code: "Space", key: " " });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );

    sourceAudio.currentTime = 47.25;
    fireEvent.timeUpdate(sourceAudio);

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    const previewAudio = findAudioByArtifactId("art_preview");
    markAudioReady(previewAudio);

    await waitFor(() => expect(previewAudio.currentTime).toBeCloseTo(47.25, 2));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("keeps playback position when a newly created mix becomes active", async () => {
    const user = userEvent.setup();
    setDeferredPreviewCompletion(true);
    const { queryClient } = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));

    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 61.4;
    fireEvent.timeUpdate(sourceAudio);

    await user.click(screen.getByLabelText("Raise target key"));
    await user.click(screen.getByRole("button", { name: "Create Mix" }));

    expect(mockCreatePreview).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        output_format: "wav",
        transpose: { semitones: 1 },
      }),
    );

    await act(async () => {
      flushPendingPreview("proj_123");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", "proj_123"] }),
      ]);
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Practice Mix" })).toBeInTheDocument(),
    );
    const newestPreviewAudio = findAudioByArtifactId("art_200");
    markAudioReady(newestPreviewAudio);
    await waitFor(() => expect(newestPreviewAudio.currentTime).toBeCloseTo(61.4, 2));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("supports mute and solo controls in stem monitor", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    const stemList = await screen.findByRole("group", { name: "Stem track list" });
    await user.click(within(stemList).getByRole("button", { name: /Vocals/i }));

    const soloVocals = screen.getByRole("button", { name: "Solo Vocals" });
    const muteInstrumental = screen.getByRole("button", { name: "Mute Instrumental" });
    await user.click(soloVocals);
    await user.click(muteInstrumental);

    expect(soloVocals).toHaveAttribute("aria-pressed", "true");
    expect(muteInstrumental).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("exports selected audio", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue("/tmp/exports/demo-source.flac");

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));
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

  it("deletes project after confirmation and returns to library", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));
    await user.click(screen.getByRole("button", { name: "Delete Project" }));

    expect(mockDeleteProject).toHaveBeenCalledWith("proj_123");
    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
  });

  it("uses new default appearance and visibility settings", async () => {
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Playback Surface" })).toBeInTheDocument();
    expect(screen.getByLabelText("Theme")).toHaveValue("system");
    expect(screen.getByLabelText("Information Density")).toHaveValue("minimal");
    expect(screen.getByLabelText("Layout Density")).toHaveValue("compact");
    expect(screen.getByLabelText("Show helper text by default")).not.toBeChecked();
    expect(screen.getByLabelText("Open inspector by default")).not.toBeChecked();
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("system");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
      informationDensity: "minimal",
      layoutDensity: "compact",
      helperTextVisible: false,
      defaultInspectorOpen: false,
      metadataRevealMode: "expand",
    });
  });

  it("persists theme and UI visibility preferences", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Playback Surface" })).toBeInTheDocument();
    expect(await screen.findByText("/tmp/tuneforge")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Theme"), "light");
    await user.selectOptions(screen.getByLabelText("Information Density"), "detailed");
    await user.selectOptions(screen.getByLabelText("Layout Density"), "comfortable");
    await user.click(screen.getByLabelText("Show helper text by default"));
    await user.click(screen.getByLabelText("Open inspector by default"));
    await user.selectOptions(screen.getByLabelText("Metadata Reveal"), "hover");

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("#F4F7FB");
    expect(document.documentElement.style.getPropertyValue("--component-playback-active")).toBe("#D9861A");
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
      informationDensity: "detailed",
      layoutDensity: "comfortable",
      helperTextVisible: true,
      defaultInspectorOpen: true,
      metadataRevealMode: "hover",
    });
  });

  it("resets appearance, visibility, and all settings independently", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Playback Surface" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Theme"), "light");
    await user.selectOptions(screen.getByLabelText("Information Density"), "detailed");
    await user.selectOptions(screen.getByLabelText("Layout Density"), "comfortable");
    await user.click(screen.getByLabelText("Show helper text by default"));
    await user.click(screen.getByLabelText("Open inspector by default"));
    await user.selectOptions(screen.getByLabelText("Metadata Reveal"), "hover");

    await user.click(screen.getByRole("button", { name: "Reset Appearance" }));
    expect(screen.getByLabelText("Theme")).toHaveValue("system");
    expect(screen.getByLabelText("Information Density")).toHaveValue("minimal");
    expect(screen.getByLabelText("Layout Density")).toHaveValue("compact");
    expect(screen.getByLabelText("Show helper text by default")).toBeChecked();
    expect(screen.getByLabelText("Open inspector by default")).toBeChecked();
    expect(screen.getByLabelText("Metadata Reveal")).toHaveValue("hover");

    await user.click(screen.getByRole("button", { name: "Reset Visibility" }));
    expect(screen.getByLabelText("Show helper text by default")).not.toBeChecked();
    expect(screen.getByLabelText("Open inspector by default")).not.toBeChecked();
    expect(screen.getByLabelText("Metadata Reveal")).toHaveValue("expand");

    await user.selectOptions(screen.getByLabelText("Theme"), "dark");
    await user.click(screen.getByLabelText("Show helper text by default"));
    await user.click(screen.getByRole("button", { name: "Reset All Settings" }));

    expect(screen.getByLabelText("Theme")).toHaveValue("system");
    expect(screen.getByLabelText("Information Density")).toHaveValue("minimal");
    expect(screen.getByLabelText("Layout Density")).toHaveValue("compact");
    expect(screen.getByLabelText("Show helper text by default")).not.toBeChecked();
    expect(screen.getByLabelText("Open inspector by default")).not.toBeChecked();
    expect(screen.getByLabelText("Metadata Reveal")).toHaveValue("expand");
  });

  it("keeps background playback available on settings and clears it when stopped", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Playback Surface" })).toBeInTheDocument();
    expect(screen.getByText("Background Playback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset Appearance" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Background Playback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.queryByText("Background Playback")).not.toBeInTheDocument();
  });

  it("stops background playback when opening a different project from the library", async () => {
    const user = userEvent.setup();
    setProjects([
      {
        id: "proj_123",
        display_name: "Demo Song",
        source_path: "/tmp/demo.wav",
        imported_path: "/tmp/projects/demo.wav",
        duration_seconds: 182,
        sample_rate: 44100,
        channels: 2,
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
      {
        id: "proj_456",
        display_name: "Bass Drill",
        source_path: "/tmp/bass-drill.wav",
        imported_path: "/tmp/projects/bass-drill.wav",
        duration_seconds: 120,
        sample_rate: 48000,
        channels: 2,
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
    ]);

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    expect(await screen.findByText("Background Playback")).toBeInTheDocument();

    const secondProjectCard = screen.getByText("Bass Drill").closest("article");
    expect(secondProjectCard).not.toBeNull();
    await user.click(
      within(secondProjectCard as HTMLElement).getByRole("link", { name: /Open project/i }),
    );

    expect(await screen.findByRole("heading", { name: "Bass Drill" })).toBeInTheDocument();
    expect(screen.queryByText("Background Playback")).not.toBeInTheDocument();
  });

  it("follows system theme when preference is set to system", async () => {
    const user = userEvent.setup();
    const mediaController = installMatchMediaMock(false);

    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Playback Surface" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Theme"), "system");

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

  it("renders the theme preview with dark and light samples", async () => {
    renderApp(["/settings/theme-preview"]);

    expect(await screen.findByRole("heading", { name: "Metal / Heat System" })).toBeInTheDocument();
    expect(screen.getByText("Cold base. Warm action.")).toBeInTheDocument();
    expect(screen.getByText("Paper, metal, and control.")).toBeInTheDocument();
    expect(screen.getAllByText("Playback Active")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
  });
});
