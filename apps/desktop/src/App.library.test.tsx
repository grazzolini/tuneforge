import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAppTestHarness,
  mockDeleteProject,
  mockGetProject,
  mockImportProject,
  mockListProjects,
  mockOpen,
  renderApp,
  setBeatBackends,
  setChordBackends,
  setProjects,
  triggerMockIntersectionObserver,
} from "./test/appTestHarness";

function makeLibraryProject(projectNumber: number) {
  return {
    id: `proj_${String(projectNumber).padStart(3, "0")}`,
    display_name: `Project ${projectNumber}`,
    source_path: `/tmp/project-${projectNumber}.wav`,
    imported_path: `/tmp/projects/project-${projectNumber}.wav`,
    duration_seconds: 120,
    sample_rate: 44100,
    channels: 2,
    created_at: "2026-04-18T13:16:00.000Z",
    updated_at: "2026-04-18T13:16:00.000Z",
  };
}

function setLibraryProjects(count: number) {
  setProjects(Array.from({ length: count }, (_, index) => makeLibraryProject(index + 1)));
}

function getProjectHeadingCount(name: string) {
  return screen.queryAllByRole("heading", { name, level: 2 }).length;
}

describe("Desktop app library", () => {
  beforeEach(resetAppTestHarness);

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

    await waitFor(() =>
      expect(mockListProjects).toHaveBeenLastCalledWith({ search: "choir", limit: 50, offset: 0 }),
    );
    expect(screen.getByText("Choir Warmup")).toBeInTheDocument();
    expect(screen.queryByText("Bass Drill")).not.toBeInTheDocument();
  });

  it("loads additional project pages when the scroll sentinel enters view", async () => {
    setLibraryProjects(55);

    renderApp(["/"]);

    expect(await screen.findByText("50 of 55 projects loaded")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project 1", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Project 55", level: 2 })).not.toBeInTheDocument();
    expect(mockListProjects).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(screen.getByText("More projects load as you scroll.")).toBeInTheDocument();

    act(() => {
      triggerMockIntersectionObserver();
    });

    expect(await screen.findByRole("heading", { name: "Project 55", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("55 projects ready")).toBeInTheDocument();
    expect(screen.getByText("All projects loaded.")).toBeInTheDocument();
    expect(mockListProjects).toHaveBeenCalledWith({ limit: 50, offset: 50 });
    expect(screen.queryByRole("button", { name: "Load more projects" })).not.toBeInTheDocument();
  });

  it("ignores repeated next-page triggers while a page request is already in flight", async () => {
    let resolveNextPage!: () => void;
    mockListProjects
      .mockImplementationOnce(async (params) => ({
        projects: Array.from({ length: 50 }, (_, index) => makeLibraryProject(index + 1)),
        total: 55,
        limit: params?.limit ?? 50,
        offset: params?.offset ?? 0,
        has_more: true,
      }))
      .mockImplementationOnce(
        async (params) =>
          new Promise((resolve) => {
            resolveNextPage = () =>
              resolve({
                projects: Array.from({ length: 5 }, (_, index) => makeLibraryProject(51 + index)),
                total: 55,
                limit: params?.limit ?? 50,
                offset: params?.offset ?? 0,
                has_more: false,
              });
          }),
      );

    renderApp(["/"]);

    expect(await screen.findByText("50 of 55 projects loaded")).toBeInTheDocument();
    const loadMoreButton = screen.getByRole("button", { name: "Load more projects" });

    act(() => {
      triggerMockIntersectionObserver();
      triggerMockIntersectionObserver();
      fireEvent.click(loadMoreButton);
    });

    await waitFor(() =>
      expect(mockListProjects.mock.calls.filter(([params]) => params?.offset === 50)).toHaveLength(1),
    );

    act(() => {
      resolveNextPage();
    });

    expect(await screen.findByRole("heading", { name: "Project 55", level: 2 })).toBeInTheDocument();
  });

  it("searches across all projects after multiple pages have been loaded", async () => {
    const user = userEvent.setup();
    setLibraryProjects(55);

    renderApp(["/"]);

    expect(await screen.findByText("50 of 55 projects loaded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more projects" }));
    expect(await screen.findByRole("heading", { name: "Project 55", level: 2 })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search projects"), "project 55");

    await waitFor(() =>
      expect(mockListProjects).toHaveBeenLastCalledWith({
        search: "project 55",
        limit: 50,
        offset: 0,
      }),
    );
    expect(await screen.findByText('1 match for "project 55"')).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project 55", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Project 1", level: 2 })).not.toBeInTheDocument();
  });

  it("refreshes loaded library pages after batch import without duplicate rows", async () => {
    const user = userEvent.setup();
    setLibraryProjects(55);
    mockOpen.mockResolvedValue(["/tmp/new-alpha.wav", "/tmp/new-beta.wav"]);

    renderApp(["/"]);

    expect(await screen.findByText("50 of 55 projects loaded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more projects" }));
    expect(await screen.findByRole("heading", { name: "Project 55", level: 2 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    expect(await screen.findByText("57 projects ready")).toBeInTheDocument();
    const summary = screen.getByRole("status");
    expect(within(summary).getByText("2 tracks imported, 0 duplicates skipped, 0 failed.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New Alpha", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New Beta", level: 2 })).toBeInTheDocument();
    expect(getProjectHeadingCount("Project 49")).toBe(1);
    expect(getProjectHeadingCount("Project 50")).toBe(1);
    expect(getProjectHeadingCount("Project 55")).toBe(1);
  });

  it("shows a refetch error after import invalidation fails while keeping loaded rows visible", async () => {
    const user = userEvent.setup();
    setLibraryProjects(1);
    mockOpen.mockResolvedValue(["/tmp/new-alpha.wav", "/tmp/new-beta.wav"]);
    mockListProjects.mockImplementationOnce(async (params) => ({
      projects: [makeLibraryProject(1)],
      total: 1,
      limit: params?.limit ?? 50,
      offset: params?.offset ?? 0,
      has_more: false,
    }));
    mockListProjects.mockRejectedValueOnce(new Error("Refresh failed"));

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Project 1", level: 2 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    const refetchError = await screen.findByText("Could not refresh projects. Showing saved results.");
    expect(refetchError.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Project 1", level: 2 })).toBeInTheDocument();
  });

  it("shows library loading, empty, failure, and final-page states", async () => {
    let resolveProjects!: () => void;
    mockListProjects.mockImplementationOnce(
      async (params) =>
        new Promise((resolve) => {
          resolveProjects = () =>
            resolve({
              projects: [],
              total: 0,
              limit: params?.limit ?? 50,
              offset: params?.offset ?? 0,
              has_more: false,
            });
        }),
    );

    const { unmount } = renderApp(["/"]);

    expect(await screen.findByText("Loading projects...")).toBeInTheDocument();
    resolveProjects();
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getByText("0 projects ready")).toBeInTheDocument();

    unmount();
    mockListProjects.mockRejectedValueOnce(new Error("Library unavailable"));
    renderApp(["/"]);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load projects.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No projects yet" })).not.toBeInTheDocument();
  });

  it("renders project cards with local timestamps and without filename subtitles", async () => {
    const updatedAt = "2026-04-21T02:59:00.000000";

    setProjects([
      {
        id: "proj_1",
        display_name: "Birds",
        source_path: "/tmp/Birds [Sa-dxgZt4rY].webm",
        imported_path: "/tmp/projects/birds.webm",
        duration_seconds: 219,
        sample_rate: 44100,
        channels: 2,
        created_at: updatedAt,
        updated_at: updatedAt,
      },
    ]);

    renderApp(["/"]);

    const localizedUpdatedAt = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(Date.UTC(2026, 3, 21, 2, 59, 0, 0)));

    const projectCard = (await screen.findByRole("heading", { name: "Birds", level: 2 })).closest(
      "article",
    );
    expect(projectCard).not.toBeNull();
    const timestamp = within(projectCard as HTMLElement).getByText(localizedUpdatedAt);
    expect(timestamp).toBeInTheDocument();
    expect(within(projectCard as HTMLElement).queryByText(/Updated/i)).not.toBeInTheDocument();
    expect(within(projectCard as HTMLElement).queryByText("Open project")).not.toBeInTheDocument();

    const timeElement = timestamp.closest("time");
    expect(timeElement).toHaveAttribute("dateTime", "2026-04-21T02:59:00.000Z");

    const openLink = within(projectCard as HTMLElement).getByRole("link", {
      name: "Open Birds project",
    });
    expect(within(openLink).queryByText(/\[Sa-dxgZt4rY\]\.webm/i)).not.toBeInTheDocument();
  });

  it("shows non-local sync status on library rows and treats missing sync fields as local", async () => {
    const updatedAt = "2026-04-21T02:59:00.000000";

    setProjects([
      {
        id: "proj_remote",
        display_name: "Remote Demo",
        source_path: "/tmp/remote-demo.wav",
        imported_path: "/tmp/projects/remote-demo.wav",
        duration_seconds: 219,
        sample_rate: 44100,
        channels: 2,
        created_at: updatedAt,
        updated_at: updatedAt,
        sync_status: "remote_available",
        sync_editable: false,
        sync_status_reason: "Download source audio before editing.",
      },
      {
        id: "proj_local",
        display_name: "Legacy Local",
        source_path: "/tmp/legacy-local.wav",
        imported_path: "/tmp/projects/legacy-local.wav",
        duration_seconds: 95,
        sample_rate: 44100,
        channels: 2,
        created_at: updatedAt,
        updated_at: updatedAt,
      },
    ]);

    renderApp(["/"]);

    const remoteCard = (await screen.findByRole("heading", { name: "Remote Demo", level: 2 })).closest(
      "article",
    );
    const localCard = screen.getByRole("heading", { name: "Legacy Local", level: 2 }).closest("article");
    expect(remoteCard).not.toBeNull();
    expect(localCard).not.toBeNull();

    expect(within(remoteCard as HTMLElement).getByText("Remote Available")).toBeInTheDocument();
    expect(
      within(remoteCard as HTMLElement).getByLabelText(
        "Sync status: Remote Available. Download source audio before editing.",
      ),
    ).toBeInTheDocument();
    expect(within(localCard as HTMLElement).queryByText("Local")).not.toBeInTheDocument();
  });

  it("imports track from library and opens project", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      beat_backend: "beat-this",
      chord_backend: "crema-advanced",
      stem_model: "htdemucs_6s",
    });
    expect(mockOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: true,
      }),
    );
    await waitFor(() =>
      expect(mockGetProject).toHaveBeenCalledWith(expect.stringMatching(/^proj_/)),
    );
    expect(await screen.findByRole("heading", { name: "New Song" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Inspector" })).toBeInTheDocument();
  });

  it("imports multiple tracks in order and stays on the library", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultChordBackend: "crema-advanced",
        defaultSourcesRailCollapsed: false,
        defaultStemModel: "htdemucs_ft",
      }),
    );
    mockOpen.mockResolvedValue(["/tmp/first-song.mp4", "/tmp/second-song.wav"]);

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(mockImportProject).toHaveBeenCalledTimes(2));
    expect(mockImportProject.mock.calls.map(([payload]) => payload.source_path)).toEqual([
      "/tmp/first-song.mp4",
      "/tmp/second-song.wav",
    ]);
    for (const [payload] of mockImportProject.mock.calls) {
      expect(payload).toEqual(
        expect.objectContaining({
          copy_into_project: true,
          beat_backend: "beat-this",
          chord_backend: "crema-advanced",
          stem_model: "htdemucs_ft",
        }),
      );
    }

    const summary = await screen.findByRole("status");
    expect(within(summary).getByText("2 tracks imported, 0 duplicates skipped, 0 failed.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("deduplicates selected import paths before importing", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue([
      "/tmp/first-song.mp4",
      "/tmp/first-song.mp4",
      "/tmp/second-song.wav",
      "/tmp/first-song.mp4",
    ]);

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(mockImportProject).toHaveBeenCalledTimes(2));
    expect(mockImportProject.mock.calls.map(([payload]) => payload.source_path)).toEqual([
      "/tmp/first-song.mp4",
      "/tmp/second-song.wav",
    ]);

    const summary = await screen.findByRole("status");
    expect(within(summary).getByText("2 tracks imported, 2 duplicates skipped, 0 failed.")).toBeInTheDocument();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("does not import when more than twenty-five files are selected", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue(Array.from({ length: 26 }, (_, index) => `/tmp/song-${index + 1}.wav`));

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    const warning = await screen.findByRole("status");
    expect(within(warning).getByText("Select up to 25 tracks at a time.")).toBeInTheDocument();
    expect(mockImportProject).not.toHaveBeenCalled();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("applies the import cap after deduplicating selected paths", async () => {
    const user = userEvent.setup();
    const uniquePaths = Array.from({ length: 25 }, (_, index) => `/tmp/song-${index + 1}.wav`);
    mockOpen.mockResolvedValue([...uniquePaths, uniquePaths[0]]);

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(mockImportProject).toHaveBeenCalledTimes(25));
    expect(mockImportProject.mock.calls.map(([payload]) => payload.source_path)).toEqual(uniquePaths);

    const summary = await screen.findByRole("status");
    expect(within(summary).getByText("25 tracks imported, 1 duplicate skipped, 0 failed.")).toBeInTheDocument();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("summarizes duplicate-content imports as skipped during a batch", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue(["/tmp/demo.wav", "/tmp/new-song.wav"]);
    mockImportProject.mockRejectedValueOnce(
      Object.assign(new Error('This project is already imported with name "Demo Song".'), {
        code: "DUPLICATE_PROJECT_SOURCE",
        details: {
          project_id: "proj_123",
          project_name: "Demo Song",
        },
      }),
    );

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(mockImportProject).toHaveBeenCalledTimes(2));
    const summary = await screen.findByRole("status");
    expect(within(summary).getByText("1 track imported, 1 duplicate skipped, 0 failed.")).toBeInTheDocument();
    expect(within(summary).queryByRole("link", { name: "Open project" })).not.toBeInTheDocument();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("summarizes failed batch imports with error details", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue(["/tmp/broken.wav", "/tmp/new-song.wav"]);
    mockImportProject.mockRejectedValueOnce(new Error("Unsupported codec."));

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(mockImportProject).toHaveBeenCalledTimes(2));
    const summary = await screen.findByRole("status");
    expect(
      within(summary).getByText(
        "1 track imported, 0 duplicates skipped, 1 failed. Failed: Unsupported codec.",
      ),
    ).toBeInTheDocument();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("summarizes dependency batch failures without raw output or paths", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue(["/Users/test/Music/Secret Demo.wav", "/tmp/new-song.wav"]);
    mockImportProject.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "ffmpeg is required to normalize imported audio. stderr: /Users/test/Music/Secret Demo.wav",
        ),
        {
          code: "DEPENDENCY_MISSING",
          details: {
            dependency: "ffmpeg",
            dependency_kind: "host_tool",
            local_action: "Install FFmpeg and ensure ffmpeg is on PATH",
            operation: "normalize imported audio",
          },
        },
      ),
    );

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(mockImportProject).toHaveBeenCalledTimes(2));
    const summary = await screen.findByRole("status");
    expect(summary).toHaveTextContent(
      "1 track imported, 0 duplicates skipped, 1 failed. Failed: ffmpeg is required to normalize imported audio. Host tool: ffmpeg. Next: Install FFmpeg and ensure ffmpeg is on PATH.",
    );
    expect(summary).not.toHaveTextContent(/stderr|Secret Demo|Users|\.wav/i);
  });

  it("shows duplicate import warning with a link to the existing project", async () => {
    const user = userEvent.setup();
    const duplicateMessage = 'This project is already imported with name "Demo Song".';
    mockOpen.mockResolvedValue("/tmp/demo.wav");
    mockImportProject.mockRejectedValueOnce(
      Object.assign(new Error(duplicateMessage), {
        code: "DUPLICATE_PROJECT_SOURCE",
        details: {
          project_id: "proj_123",
          project_name: "Demo Song",
        },
      }),
    );

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    const warning = await screen.findByRole("status");
    expect(within(warning).getByText(duplicateMessage)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const openProjectLink = within(warning).getByRole("link", { name: "Open project" });
    expect(openProjectLink).toHaveAttribute("href", "/projects/proj_123");
    await user.click(openProjectLink);

    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("proj_123"));
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
  });

  it("shows generic import errors without a project link and clears them on the next import", async () => {
    const user = userEvent.setup();
    const existingProject = {
      id: "proj_123",
      display_name: "Demo Song",
      source_key_override: null,
      source_path: "/tmp/demo.wav",
      imported_path: "/tmp/app/demo-song.wav",
      duration_seconds: 182,
      sample_rate: 44100,
      channels: 2,
      created_at: "2026-04-18T13:16:00.000Z",
      updated_at: "2026-04-18T13:16:00.000Z",
    };
    const genericMessage = "Could not import track. Disk is full.";
    let resolveImport!: (value: { project: typeof existingProject }) => void;
    const importPromise = new Promise<{ project: typeof existingProject }>((resolve) => {
      resolveImport = resolve;
    });
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");
    mockImportProject.mockRejectedValueOnce(new Error("Disk is full."));

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(genericMessage)).toBeInTheDocument();
    expect(within(alert).queryByRole("link", { name: "Open project" })).not.toBeInTheDocument();

    mockImportProject.mockImplementationOnce(async () => importPromise);
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    await waitFor(() => expect(screen.queryByText(genericMessage)).not.toBeInTheDocument());
    resolveImport({ project: existingProject });

    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("proj_123"));
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
  });

  it("shows dependency import errors without raw output or paths", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue("/Users/test/Music/Secret Demo.wav");
    mockImportProject.mockRejectedValueOnce(
      Object.assign(
        new Error("ffprobe is required for metadata extraction. stdout: /Users/test/Music/Secret Demo.wav"),
        {
          code: "DEPENDENCY_MISSING",
          details: {
            dependency: "ffprobe",
            dependency_kind: "host_tool",
            local_action: "Install FFmpeg and ensure ffprobe is on PATH",
            operation: "metadata extraction",
          },
        },
      ),
    );

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not import track. ffprobe is required for metadata extraction. Host tool: ffprobe. Next: Install FFmpeg and ensure ffprobe is on PATH.",
    );
    expect(alert).not.toHaveTextContent(/stdout|Secret Demo|Users|\.wav/i);
    expect(within(alert).queryByRole("link", { name: "Open project" })).not.toBeInTheDocument();
  });

  it("uses the selected default chord backend and stem model when importing a track", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultChordBackend: "crema-advanced",
        defaultBeatAnalysisBackend: "beat-this",
        defaultSourcesRailCollapsed: false,
        defaultStemModel: "htdemucs_ft",
      }),
    );
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      beat_backend: "beat-this",
      chord_backend: "crema-advanced",
      stem_model: "htdemucs_ft",
    });
  });

  it("falls back to built-in chords when importing with unavailable advanced chords", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultChordBackend: "crema-advanced", defaultSourcesRailCollapsed: false }),
    );
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
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      beat_backend: "beat-this",
      chord_backend: "tuneforge-fast",
      stem_model: "htdemucs_6s",
      chord_backend_fallback_from: "crema-advanced",
    });
  });

  it("falls back to built-in beat analysis when importing with unavailable advanced beats", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultBeatAnalysisBackend: "beat-this", defaultSourcesRailCollapsed: false }),
    );
    setBeatBackends([
      { id: "built-in", available: true },
      { id: "beat-this", available: false },
    ]);
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track(s)" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      beat_backend: "built-in",
      chord_backend: "crema-advanced",
      stem_model: "htdemucs_6s",
    });
  });

  it("deletes project after confirmation and returns to library", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const showInspectorButton = screen.queryByRole("button", { name: "Show Inspector" });
    if (showInspectorButton) {
      await user.click(showInspectorButton);
    }
    await user.click(screen.getByRole("tab", { name: "Analysis" }));
    await user.click(screen.getByRole("button", { name: "Delete Project" }));

    expect(mockDeleteProject).toHaveBeenCalledWith("proj_123");
    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
  });
});
