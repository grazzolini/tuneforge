import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAppTestHarness,
  flushPendingPreview,
  findAudioByArtifactId,
  getByAriaKeyLabel,
  getMockAudioContexts,
  getMockFetch,
  markAudioReady,
  mockCreatePreview,
  mockCreateStems,
  mockListArtifacts,
  mockListJobs,
  renderApp,
  setAudioPlaybackState,
  setDeferredPreviewCompletion,
  setMockAudioContextInitialState,
  setMockAudioSourceStartError,
  setProjects,
} from "./test/appTestHarness";
import {
  ensureInspectorVisible,
  generateStems,
  openPlaybackWorkspace,
  openStudioPanel,
} from "./test/projectTestActions";

function setPlaybackPosition(value: string) {
  fireEvent.change(screen.getByLabelText("Playback position"), { target: { value } });
}

function readStoredProjectPlaybackState() {
  return JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}") as Record<
    string,
    {
      loopRange?: {
        startSeconds: number;
        endSeconds: number;
      } | null;
    }
  >;
}

function triggerBufferSourceEnded(source: { onended: AudioBufferSourceNode["onended"] }) {
  source.onended?.call(source as unknown as AudioBufferSourceNode, new Event("ended"));
}

describe("Desktop app project playback stems", () => {
  beforeEach(resetAppTestHarness);

  async function switchToChordsOnly(user: ReturnType<typeof userEvent.setup>) {
    const lyricsToggle = screen.getByRole("button", { name: "Lyrics" });
    const chordsToggle = screen.getByRole("button", { name: "Chords" });
    const lyricsPressed = lyricsToggle.getAttribute("aria-pressed") === "true";
    const chordsPressed = chordsToggle.getAttribute("aria-pressed") === "true";
    if (lyricsPressed && !chordsPressed) {
      await user.click(chordsToggle);
      await user.click(lyricsToggle);
      return;
    }
    if (lyricsPressed && chordsPressed) {
      await user.click(lyricsToggle);
    }
  }


  it("switches between source playback and stems", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);

    expect(mockCreateStems).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        mode: "stems",
        stem_model: "htdemucs_6s",
        output_format: "wav",
        force: false,
        source_artifact_id: "art_source",
      }),
    );

    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    expect(await screen.findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Playback stem list" })).toBeInTheDocument();

    const sourceList = screen.getByRole("group", { name: "Playback source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));

    expect(await screen.findByRole("heading", { name: "Source Track" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Playback source and mix list" })).toBeInTheDocument();
  });

  it("persists selected stem playback state across project reopen", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);

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
    expect(screen.getByRole("group", { name: "Playback stem list" })).toBeInTheDocument();
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
    await generateStems(user);

    await openStudioPanel(user);
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));
    await generateStems(user);

    expect(mockCreateStems).toHaveBeenLastCalledWith(
      "proj_123",
      expect.objectContaining({
        mode: "stems",
        stem_model: "htdemucs_6s",
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
          selectedArtifactId: "art_206",
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
    expect(screen.getByRole("group", { name: "Playback stem list" })).toBeInTheDocument();
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

    setPlaybackPosition("47.253");

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

    setPlaybackPosition("32.417");

    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("32.417");

    await user.click(screen.getByRole("button", { name: "Stop playback" }));

    expect(sourceAudio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("0");
  });

  it("starts source playback from a stopped scrubber selection", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    setPlaybackPosition("32.417");
    sourceAudio.currentTime = 0;

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    expect(getMockAudioContexts()[0]?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      32.417,
      3,
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("cycles the source loop control and only persists a complete loop", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();

    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));

    expect(screen.getByText("Loop in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set loop end" })).toBeInTheDocument();
    await waitFor(() => expect(readStoredProjectPlaybackState().proj_123?.loopRange).toBeNull());

    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    expect(screen.getByText("Loop set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear loop" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("12.25");
    await waitFor(() =>
      expect(readStoredProjectPlaybackState()).toMatchObject({
        proj_123: {
          loopRange: {
            startSeconds: 12.25,
            endSeconds: 24.5,
          },
        },
      }),
    );
  });

  it("restarts an active source loop at the loop end", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();

    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    const sourceCountBeforeRollover = getMockAudioContexts()[0].createdSources.length;

    act(() => {
      sourceAudio.currentTime = 24.5;
      fireEvent.timeUpdate(sourceAudio);
    });

    await waitFor(() =>
      expect(getMockAudioContexts()[0].createdSources.length).toBe(
        sourceCountBeforeRollover + 1,
      ),
    );
    const restartedSource =
      getMockAudioContexts()[0].createdSources[sourceCountBeforeRollover];
    expect(restartedSource?.start.mock.calls[0]?.[1]).toBeCloseTo(12.25, 3);
    expect(sourceAudio.currentTime).toBeCloseTo(12.25, 3);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(Number((screen.getByLabelText("Playback position") as HTMLInputElement).value)).toBeCloseTo(
      12.25,
      1,
    );
  });

  it("starts and stops source playback at a persisted loop start", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.project-playback-state",
      JSON.stringify({
        proj_123: {
          loopRange: {
            startSeconds: 12.25,
            endSeconds: 24.5,
          },
        },
      }),
    );
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Playback position")).toHaveValue("12.25"));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    expect(getMockAudioContexts()[0]?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      12.25,
      3,
    );

    setPlaybackPosition("18");
    await user.click(screen.getByRole("button", { name: "Stop playback" }));

    expect(sourceAudio.currentTime).toBeCloseTo(12.25, 3);
    expect(screen.getByLabelText("Playback position")).toHaveValue("12.25");
  });

  it("clears the persisted source loop from the transport", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.project-playback-state",
      JSON.stringify({
        proj_123: {
          loopRange: {
            startSeconds: 12.25,
            endSeconds: 24.5,
          },
        },
      }),
    );
    const firstRender = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear loop" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear loop" }));

    expect(screen.getByText("Loop cleared")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set loop start" })).toBeInTheDocument();
    await waitFor(() => expect(readStoredProjectPlaybackState().proj_123?.loopRange).toBeNull());

    firstRender.unmount();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Playback position")).toHaveValue("0"));
    expect(screen.getByRole("button", { name: "Set loop start" })).toBeInTheDocument();
  });

  it("rewinds source playback after natural end and restarts from the beginning with space", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));

    const endedSource = getMockAudioContexts()[0].createdSources[0];
    act(() => {
      sourceAudio.currentTime = 182;
      triggerBufferSourceEnded(endedSource);
    });

    expect(sourceAudio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("0");

    const sourceCountAfterEnd = getMockAudioContexts()[0].createdSources.length;
    fireEvent.keyDown(window, { code: "Space", key: " " });

    await waitFor(() =>
      expect(getMockAudioContexts()[0].createdSources.length).toBeGreaterThan(sourceCountAfterEnd),
    );
    const restartedSource = getMockAudioContexts()[0].createdSources[sourceCountAfterEnd];
    expect(restartedSource?.start.mock.calls[0]?.[1]).toBe(0);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("primes Web Audio from the playback gesture before artifact buffers finish loading", async () => {
    const user = userEvent.setup();
    setMockAudioContextInitialState("suspended");
    getMockFetch().mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    );
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()).toHaveLength(1));
    expect(getMockAudioContexts()[0]?.resume).toHaveBeenCalled();
    expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(0);
  });

  it("keeps playback stopped when Web Audio sources cannot start", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    setMockAudioSourceStartError(new Error("start failed"));

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
  });

  it("selects a newly created mix after preview completion", async () => {
    const user = userEvent.setup();
    setDeferredPreviewCompletion(true);
    const { queryClient } = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await ensureInspectorVisible(user);

    const sourceList = screen.getByRole("group", { name: "Source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Source Track/i }));

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
      const [{ artifacts }, { jobs }] = await Promise.all([
        mockListArtifacts("proj_123"),
        mockListJobs(),
      ]);
      queryClient.setQueryData(["artifacts", "proj_123"], artifacts);
      queryClient.setQueryData(["jobs"], jobs);
    });

    expect(await screen.findByRole("heading", { name: "Practice Mix" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
  });

  it("applies and persists a visual capo shift without creating a mix", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        enharmonicDisplayMode: "sharps",
      }),
    );

    const { unmount } = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "G")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Lower capo shift"));

    expect(screen.getByText("Shift -1 semitone / 1st fret")).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "F#")).toBeInTheDocument();
    expect(mockCreatePreview).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"),
      ).toMatchObject({
        proj_123: {
          activeWorkspace: "playback",
          capoTransposeSemitones: -1,
        },
      }),
    );

    unmount();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await switchToChordsOnly(user);
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "F#")).toBeInTheDocument();
    expect(screen.getByText("Shift -1 semitone / 1st fret")).toBeInTheDocument();
  });

  it("bases the visual capo selector on the selected practice mix key", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        enharmonicDisplayMode: "sharps",
      }),
    );
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    await openPlaybackWorkspace(user);
    await switchToChordsOnly(user);
    await user.click(screen.getByLabelText("Lower capo shift"));

    expect(screen.getByText("Shift -1 semitone / 1st fret")).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByRole("group", { name: "Current chord card" }), "G#")).toBeInTheDocument();
    expect(getByAriaKeyLabel(screen.getByLabelText("Capo Shift"), "G#")).toBeInTheDocument();
  });

  it("keeps playback header compact outside detailed information density", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    const rail = document.querySelector(".playback-practice-rail") as HTMLElement;
    const sourceList = within(rail).getByRole("group", {
      name: "Playback source and mix list",
    });
    expect(within(rail).queryByText("Full playback")).not.toBeInTheDocument();
    expect(within(rail).queryAllByText("Original source file")).toHaveLength(1);
    expect(within(sourceList).getByText("Original source file")).toBeInTheDocument();

    await user.click(within(sourceList).getByRole("button", { name: /Practice Mix/i }));
    const header = rail.querySelector(".playback-practice-rail__header") as HTMLElement;
    expect(await within(header).findByRole("heading", { name: "Practice Mix" })).toBeInTheDocument();
    expect(within(header).queryByText("Full playback")).not.toBeInTheDocument();
    expect(within(header).queryByText("Shift +2 semitones")).not.toBeInTheDocument();
  });

  it("keeps stem playback header compact outside detailed information density", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();

    await generateStems(user);
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    const rail = document.querySelector(".playback-practice-rail") as HTMLElement;
    const header = rail.querySelector(".playback-practice-rail__header") as HTMLElement;

    expect(await within(header).findByRole("heading", { name: "Vocals" })).toBeInTheDocument();
    expect(within(header).queryByText("Stem monitor")).not.toBeInTheDocument();
    expect(within(header).queryByText("6 of 6 stems audible")).not.toBeInTheDocument();
  });

  it("shows playback header details at detailed information density", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultSourcesRailCollapsed: false,
        informationDensity: "detailed",
      }),
    );
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    const rail = document.querySelector(".playback-practice-rail") as HTMLElement;
    expect(within(rail).getByText("Full playback")).toBeInTheDocument();
    expect(within(rail).queryAllByText("Original source file")).toHaveLength(3);
  });

  it("persists selected practice mix across app reload without restoring playback time", async () => {
    const user = userEvent.setup();
    const firstRender = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const savedMixList = screen.getByRole("group", { name: "Saved mix list" });
    await user.click(within(savedMixList).getByRole("button", { name: /Practice Mix/i }));

    expect(await screen.findByRole("heading", { name: "Practice Mix" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"),
      ).toMatchObject({
        proj_123: {
          selectedArtifactId: "art_preview",
          selectedPrimaryArtifactId: "art_preview",
        },
      }),
    );

    const previewAudio = findAudioByArtifactId("art_preview");
    markAudioReady(previewAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    setPlaybackPosition("73.125");
    expect(screen.getByLabelText("Playback position")).toHaveValue("73.125");

    firstRender.unmount();

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Practice Mix" })).toBeInTheDocument();
    const reloadedPreviewAudio = findAudioByArtifactId("art_preview");
    markAudioReady(reloadedPreviewAudio);

    expect(screen.getByLabelText("Playback position")).toHaveValue("0");
    expect(reloadedPreviewAudio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
  });

  it("ignores stale playback session storage on project load", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      "tuneforge.playback-session",
      JSON.stringify({
        session: {
          projectId: "proj_123",
          projectName: "Demo Song",
          stageTitle: "Source Track",
          stageSummary: "Original source file",
          selectedPlaybackArtifactId: "art_source",
          isStemPlayback: false,
          playbackArtifactIds: ["art_source"],
          artifactPathsById: { art_source: "/tmp/projects/demo.wav" },
          artifactFormatsById: { art_source: "wav" },
          visibleStemArtifactIds: [],
          stemControls: {},
          durationHintSeconds: 182,
          precountEnabled: false,
          precountClickCount: 4,
          precountTempoBpm: null,
          tempoOriginalBpm: null,
          tempoTargetBpm: null,
        },
        playbackTimeSeconds: 73.125,
        isPlaying: true,
      }),
    );

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    expect(screen.getByLabelText("Playback position")).toHaveValue("0");
    expect(sourceAudio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    expect(getMockAudioContexts()[0]?.createdSources[0]?.start.mock.calls[0]?.[1]).toBe(0);
  });

  it("starts visible stems from the same playback offset when switching playback modes", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    setPlaybackPosition("32.481");

    await generateStems(user);
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    const firstStemSourceIndex = getMockAudioContexts()[0]?.createdSources.length ?? 0;
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    const vocalAudio = findAudioByArtifactId("art_200");
    const drumsAudio = findAudioByArtifactId("art_201");

    await waitFor(() => expect(getMockAudioContexts()).toHaveLength(1));
    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdSources.length).toBe(firstStemSourceIndex + 6),
    );

    const startCalls = getMockAudioContexts()[0].createdSources.slice(firstStemSourceIndex).map(
      (source) => source.start.mock.calls[0],
    );
    expect(startCalls).toHaveLength(6);
    const stemStartOffset = startCalls[0]?.[1] ?? 0;
    startCalls.forEach((startCall) => {
      expect(startCall?.[0]).toBe(0);
      expect(startCall?.[1]).toBeCloseTo(stemStartOffset, 3);
    });
    expect(stemStartOffset).toBeGreaterThanOrEqual(32.481);
    expect(stemStartOffset).toBeLessThan(33);
    await waitFor(() => expect(vocalAudio.currentTime).toBeCloseTo(stemStartOffset, 1));
    await waitFor(() => expect(drumsAudio.currentTime).toBeCloseTo(stemStartOffset, 1));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("rewinds stem playback after buffered audio reaches the end", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    const vocalAudio = findAudioByArtifactId("art_200");
    const drumsAudio = findAudioByArtifactId("art_201");
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(6));

    const endedSources = getMockAudioContexts()[0].createdSources.slice(0, 6);
    act(() => {
      vocalAudio.currentTime = 182;
      drumsAudio.currentTime = 182;
      endedSources.forEach(triggerBufferSourceEnded);
    });

    expect(vocalAudio.currentTime).toBe(0);
    expect(drumsAudio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toHaveValue("0");
  });

  it("restarts buffered stem playback when a loop reaches the end", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const vocalAudio = findAudioByArtifactId("art_200");
    const drumsAudio = findAudioByArtifactId("art_201");
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(6));
    const stemSourceCountBeforeRollover = getMockAudioContexts()[0].createdSources.length;
    const endedSources = getMockAudioContexts()[0].createdSources.slice(
      stemSourceCountBeforeRollover - 6,
      stemSourceCountBeforeRollover,
    );

    act(() => {
      vocalAudio.currentTime = 24.5;
      drumsAudio.currentTime = 24.5;
      endedSources.forEach(triggerBufferSourceEnded);
    });

    await waitFor(() =>
      expect(getMockAudioContexts()[0].createdSources.length).toBe(
        stemSourceCountBeforeRollover + 6,
      ),
    );
    getMockAudioContexts()[0].createdSources
      .slice(stemSourceCountBeforeRollover)
      .forEach((source) => {
        expect(source.start.mock.calls[0]?.[1]).toBeCloseTo(12.25, 3);
      });
    expect(vocalAudio.currentTime).toBeCloseTo(12.25, 3);
    expect(drumsAudio.currentTime).toBeCloseTo(12.25, 3);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(Number((screen.getByLabelText("Playback position") as HTMLInputElement).value)).toBeCloseTo(
      12.25,
      1,
    );
  });

  it("preserves playback time when returning to full mix during a pending stem handoff", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    setPlaybackPosition("41.662");

    await generateStems(user);
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
      expect(resumedSourceAudio.currentTime).toBeCloseTo(transitionPlaybackPosition, 1),
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("preloads visible stem tracks while full mix remains selected", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await generateStems(user);
    const vocalAudio = findAudioByArtifactId("art_200");
    const drumsAudio = findAudioByArtifactId("art_201");
    await waitFor(() =>
      expect(getMockFetch().mock.calls.map(([url]) => String(url))).toEqual(
        expect.arrayContaining([
          expect.stringContaining("/artifacts/art_200/stream"),
          expect.stringContaining("/artifacts/art_201/stream"),
          expect.stringContaining("/artifacts/art_202/stream"),
          expect.stringContaining("/artifacts/art_203/stream"),
          expect.stringContaining("/artifacts/art_204/stream"),
          expect.stringContaining("/artifacts/art_205/stream"),
        ]),
      ),
    );
    expect(vocalAudio).toHaveAttribute("preload", "metadata");
    expect(drumsAudio).toHaveAttribute("preload", "metadata");
    await openStudioPanel(user);
    expect(screen.getByRole("heading", { name: "Source Track" })).toBeInTheDocument();
  });

  it("reuses the shared stem clock when returning to stems after pausing", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    setPlaybackPosition("18.789");

    await generateStems(user);
    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    const firstStemSourceIndex = getMockAudioContexts()[0]?.createdSources.length ?? 0;
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdSources.length).toBe(firstStemSourceIndex + 6),
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
    await generateStems(user);

    await openPlaybackWorkspace(user);
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);

    const soloVocals = screen.getByRole("button", { name: "Solo Vocals" });
    const muteDrums = screen.getByRole("button", { name: "Mute Drums" });
    await user.click(soloVocals);
    await user.click(muteDrums);

    expect(soloVocals).toHaveAttribute("aria-pressed", "true");
    expect(muteDrums).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("1 of 6 stems audible")).not.toBeInTheDocument();
  });


});
