import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAppTestHarness,
  flushPendingPreview,
  findAudioByArtifactId,
  getMockAudioContexts,
  getMockFetch,
  markAudioReady,
  mockConfirm,
  mockCreateExport,
  mockCreatePreview,
  mockCreateStems,
  mockListJobs,
  mockSave,
  mockUpdateProject,
  renderApp,
  setAudioPlaybackState,
  setDeferredPreviewCompletion,
  setProjects,
} from "./test/appTestHarness";

describe("Desktop app project playback stems", () => {
  beforeEach(resetAppTestHarness);

  async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "Playback" }));
  }

  async function ensureInspectorVisible(user: ReturnType<typeof userEvent.setup>) {
    const showInspectorButton = screen.queryByRole("button", { name: "Show Inspector" });
    if (showInspectorButton) {
      await user.click(showInspectorButton);
    }
  }

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

    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(screen.getByText("Stem monitor")).toBeInTheDocument();

    const sourceList = screen.getByRole("group", { name: "Playback source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));

    expect(await screen.findByRole("heading", { name: "Source Track" })).toBeInTheDocument();
    expect(screen.getByText("Full playback")).toBeInTheDocument();
  });

  it("persists selected stem playback state across project reopen", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

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
    await user.click(screen.getByRole("button", { name: "Stop background playback" }));

    const reopenDemoLinks = screen.getAllByRole("link", { name: "Open Demo Song project" });
    await user.click(reopenDemoLinks[reopenDemoLinks.length - 1] as HTMLElement);

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(screen.getByText("Stem monitor")).toBeInTheDocument();
  });

  it("restores mix-owned stems after reopening the project", async () => {
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
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    expect(mockCreateStems).toHaveBeenLastCalledWith(
      "proj_123",
      expect.objectContaining({
        mode: "two_stem",
        output_format: "wav",
        force: false,
        source_artifact_id: "art_preview",
      }),
    );

    await openPlaybackWorkspace(user);
    const playbackStemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(playbackStemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"),
      ).toMatchObject({
        proj_123: {
          selectedArtifactId: "art_202",
          selectedPrimaryArtifactId: "art_preview",
          selectedStemSourceArtifactId: "art_preview",
        },
      }),
    );

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    const secondProjectCard = screen.getByText("Bass Drill").closest("article");
    expect(secondProjectCard).not.toBeNull();
    await user.click(
      within(secondProjectCard as HTMLElement).getByRole("link", {
        name: "Open Bass Drill project",
      }),
    );

    expect(await screen.findByRole("heading", { name: "Bass Drill" })).toBeInTheDocument();

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    const reopenDemoLinks = screen.getAllByRole("link", { name: "Open Demo Song project" });
    await user.click(reopenDemoLinks[reopenDemoLinks.length - 1] as HTMLElement);

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(screen.getByText("Stem monitor")).toBeInTheDocument();
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

    sourceAudio.currentTime = 47.253;
    fireEvent.timeUpdate(sourceAudio);

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    const playCallsBeforeMixSwitch = vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length;
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      playCallsBeforeMixSwitch,
    );

    const previewAudio = findAudioByArtifactId("art_preview");
    previewAudio.currentTime = 0;
    setAudioPlaybackState(previewAudio);
    fireEvent.loadedMetadata(previewAudio);
    fireEvent.canPlay(previewAudio);

    expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      playCallsBeforeMixSwitch,
    );

    previewAudio.currentTime = 47.253;
    fireEvent.seeked(previewAudio);

    await waitFor(() => expect(previewAudio.currentTime).toBeCloseTo(47.253, 3));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveAttribute("step", "0.001");
  });

  it("stops playback and rewinds transport to start", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 32.417;
    fireEvent.timeUpdate(sourceAudio);

    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("32.417");

    await user.click(screen.getByRole("button", { name: "Stop playback" }));

    expect(sourceAudio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("0");
  });

  it("keeps playback position when a newly created mix becomes active", async () => {
    const user = userEvent.setup();
    setDeferredPreviewCompletion(true);
    const { queryClient } = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await ensureInspectorVisible(user);

    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 61.437;
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
      expect(
        document.querySelector('audio[src*="/artifacts/art_200/stream"]'),
      ).toBeTruthy(),
    );
    const playCallsBeforeNewMixSeek = vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length;

    const newestPreviewAudio = findAudioByArtifactId("art_200");
    expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      playCallsBeforeNewMixSeek,
    );

    newestPreviewAudio.currentTime = 0;
    setAudioPlaybackState(newestPreviewAudio);
    fireEvent.loadedMetadata(newestPreviewAudio);
    fireEvent.canPlay(newestPreviewAudio);

    expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      playCallsBeforeNewMixSeek,
    );

    newestPreviewAudio.currentTime = 61.437;
    fireEvent.seeked(newestPreviewAudio);

    expect(screen.getByRole("heading", { name: "Practice Mix" })).toBeInTheDocument();
    await waitFor(() => expect(newestPreviewAudio.currentTime).toBeCloseTo(61.437, 3));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("restores active playback after app reload", async () => {
    const user = userEvent.setup();
    const firstRender = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 73.125;
    fireEvent.timeUpdate(sourceAudio);

    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem("tuneforge.playback-session") ?? "null"),
      ).toMatchObject({
        session: {
          projectId: "proj_123",
          selectedPlaybackArtifactId: "art_source",
        },
        playbackTimeSeconds: 73.125,
        isPlaying: true,
      }),
    );

    const playCallsBeforeReload = vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length;
    firstRender.unmount();

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const reloadedAudio = findAudioByArtifactId("art_source");
    markAudioReady(reloadedAudio);

    await waitFor(() => expect(reloadedAudio.currentTime).toBeCloseTo(73.125, 3));
    await waitFor(() =>
      expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBeGreaterThan(
        playCallsBeforeReload,
      ),
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("starts both stems from the same playback offset when switching playback modes", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 32.481;
    fireEvent.timeUpdate(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    const vocalAudio = findAudioByArtifactId("art_200");
    const instrumentalAudio = findAudioByArtifactId("art_201");

    await waitFor(() => expect(getMockAudioContexts()).toHaveLength(1));
    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdSources.length).toBe(2),
    );

    const startCalls = getMockAudioContexts()[0].createdSources.map(
      (source) => source.start.mock.calls[0],
    );
    expect(startCalls).toHaveLength(2);
    startCalls.forEach((startCall) => {
      expect(startCall?.[0]).toBe(0);
      expect(startCall?.[1]).toBeCloseTo(32.481, 3);
    });
    await waitFor(() => expect(vocalAudio.currentTime).toBeCloseTo(32.481, 3));
    await waitFor(() => expect(instrumentalAudio.currentTime).toBeCloseTo(32.481, 3));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("preserves playback time when returning to full mix during a pending stem handoff", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 41.662;
    fireEvent.timeUpdate(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Full Mix" }));

    expect(await screen.findByRole("heading", { name: "Source Track" })).toBeInTheDocument();
    const transitionPlaybackPosition = Number(
      (screen.getByLabelText("Playback position") as HTMLInputElement).value,
    );
    const resumedSourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(resumedSourceAudio);

    await waitFor(() =>
      expect(resumedSourceAudio.currentTime).toBeCloseTo(transitionPlaybackPosition, 3),
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("preloads visible stem tracks while full mix remains selected", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    const vocalAudio = findAudioByArtifactId("art_200");
    const instrumentalAudio = findAudioByArtifactId("art_201");
    await waitFor(() =>
      expect(getMockFetch().mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(getMockFetch().mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/artifacts/art_200/stream"),
        expect.stringContaining("/artifacts/art_201/stream"),
      ]),
    );
    expect(vocalAudio).toHaveAttribute("preload", "metadata");
    expect(instrumentalAudio).toHaveAttribute("preload", "metadata");
    expect(screen.getByText("Full playback")).toBeInTheDocument();
  });

  it("reuses the shared stem clock when returning to stems after pausing", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    sourceAudio.currentTime = 18.789;
    fireEvent.timeUpdate(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdSources.length).toBe(2),
    );

    const initialStemStarts = getMockAudioContexts()[0].createdSources.length;
    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    const pausedStemPosition = Number(
      (screen.getByLabelText("Playback position") as HTMLInputElement).value,
    );
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() =>
      expect(getMockAudioContexts()[0].createdSources.length).toBeGreaterThan(initialStemStarts),
    );
    getMockAudioContexts()[0].createdSources
      .slice(initialStemStarts)
      .forEach((source) => {
        expect(source.start.mock.calls[0]?.[1]).toBeCloseTo(pausedStemPosition, 1);
      });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("supports mute and solo controls in stem monitor", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    const soloVocals = screen.getByRole("button", { name: "Solo Vocals" });
    const muteInstrumental = screen.getByRole("button", { name: "Mute Instrumental" });
    await user.click(soloVocals);
    await user.click(muteInstrumental);

    expect(soloVocals).toHaveAttribute("aria-pressed", "true");
    expect(muteInstrumental).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2 stems audible")).toBeInTheDocument();
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

    await user.click(screen.getByText("Show raw artifacts and processing history"));
    const jobHistory = screen.getByText("Show raw artifacts and processing history").closest("details");
    expect(jobHistory).not.toBeNull();

    expect(within(jobHistory as HTMLElement).getByText("stems")).toBeInTheDocument();
    expect(within(jobHistory as HTMLElement).getByText(/failed \/ CPU \/ 3.4 s/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));

    await user.click(screen.getByRole("button", { name: "Collapse sources rail" }));

    const stemSummaryChip = screen.getByText("Stem").closest(".rail-summary-chip");
    expect(stemSummaryChip).not.toBeNull();
    expect(within(stemSummaryChip as HTMLElement).getByText("4")).toBeInTheDocument();
  });

  it("asks for confirmation before rebuilding existing stems", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
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
});
