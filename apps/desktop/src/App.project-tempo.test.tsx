import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceMockAnimationFrames,
  emitMockNativePlaybackError,
  emitMockNativePlaybackPosition,
  findAudioByArtifactId,
  getMockAudioContexts,
  getMockInvoke,
  mockListen,
  markAudioReady,
  mockCreateExport,
  mockCreatePreview,
  mockCreateStems,
  renderApp,
  resetAppTestHarness,
  setAudioPlaybackState,
  setMockNativeAudioState,
  setProjectAnalysis,
} from "./test/appTestHarness";

const tempoAnalysis = {
  project_id: "proj_123",
  estimated_key: "G major",
  key_confidence: 0.82,
  estimated_reference_hz: 440,
  tuning_offset_cents: 0,
  tempo_bpm: 123.5,
  analysis_version: "v1",
  created_at: "2026-04-18T13:16:00.000Z",
};

function setupTempoAnalysis(tempoBpm = 123.5) {
  setProjectAnalysis("proj_123", {
    ...tempoAnalysis,
    tempo_bpm: tempoBpm,
  });
}

async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Playback" }));
}

async function openStudioPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Studio" }));
}

function tempoControl() {
  const group = screen.getByRole("group", { name: "Playback tempo BPM" });
  const section = group.closest("section");
  if (!section) {
    throw new Error("Tempo control not found.");
  }
  return { group, section: section as HTMLElement };
}

async function waitForTempoSummary(text: string) {
  await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
}

function setPlaybackPosition(value: string) {
  fireEvent.change(screen.getByLabelText("Playback position"), { target: { value } });
}

function useTwoStemModelDefault() {
  window.localStorage.setItem(
    "tuneforge.ui-preferences",
    JSON.stringify({
      defaultSourcesRailCollapsed: false,
      defaultStemModel: "htdemucs_ft",
    }),
  );
}

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });

  return () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  };
}

function latestNativeSessionId() {
  const prepareCall = [...getMockInvoke().mock.calls]
    .reverse()
    .find(([command]) => command === "audio_prepare_session");
  const payload = (prepareCall?.[1] as { payload?: { sessionId?: string } } | undefined)?.payload;
  if (!payload?.sessionId) {
    throw new Error("Native audio session was not prepared.");
  }
  return payload.sessionId;
}

function readPlaybackE2ETelemetry() {
  const telemetry = window.__TUNEFORGE_PLAYBACK_E2E__?.read();
  if (!telemetry) {
    throw new Error("Playback E2E telemetry bridge was not exposed.");
  }
  return telemetry;
}

describe("Desktop app project playback tempo", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("persists whole-BPM tempo changes and reset without creating audio files", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    const firstRender = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const { group, section } = tempoControl();

    expect(within(section).getByText("Original 123.5 BPM")).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Decrease playback tempo" }));

    await waitFor(() => expect(within(section).getByText("123 BPM (0.996x)")).toBeInTheDocument());
    expect(mockCreatePreview).not.toHaveBeenCalled();
    expect(mockCreateStems).not.toHaveBeenCalled();
    expect(mockCreateExport).not.toHaveBeenCalled();

    firstRender.unmount();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    expect(screen.getByText("123 BPM (0.996x)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Original 123.5 BPM")).toBeInTheDocument();
  });

  it("keeps tempo-correct playback when seeking is loop-bounded", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    setPlaybackPosition("99");
    expect(screen.getByLabelText("Playback position")).toHaveValue("12.25");

    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await waitForTempoSummary("119 BPM (0.992x)");

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(sourceAudio.currentTime).toBeCloseTo(12.25, 3));
    await waitFor(() => expect(sourceAudio.playbackRate).toBeCloseTo(119 / 120, 4));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("flushes a pending tempo step before playback starts", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(sourceAudio.playbackRate).toBeCloseTo(119 / 120, 4));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("commits direct BPM edits from the playback tempo selector", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    const bpmInput = screen.getByRole("spinbutton", { name: "Playback BPM" });
    await user.clear(bpmInput);
    await user.type(bpmInput, "96{Enter}");

    expect(await screen.findByText("96 BPM (0.800x)")).toBeInTheDocument();
    expect(bpmInput).toHaveValue(96);
  });

  it("does not open native playback while the project is idle", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setupTempoAnalysis();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    expect(
      Array.from(document.querySelectorAll("audio")).every(
        (element) => !element.getAttribute("src"),
      ),
    ).toBe(true);
    expect(
      getMockInvoke().mock.calls.some(([command]) => command === "audio_prepare_session"),
    ).toBe(false);
    restoreTauriRuntime();
  });

  it("reports native playback transport and buffer health for E2E assertions", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() =>
      expect(
        getMockInvoke().mock.calls.some(([command]) => command === "audio_play"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        durationSeconds: 182,
        playbackRate: 1,
        transportState: "playing",
      }),
    );
    expect(readPlaybackE2ETelemetry().nativeBufferHealth).toEqual([
      expect.objectContaining({
        artifactId: "art_source",
        laneId: "art_source",
        role: "primary",
      }),
    ]);

    emitMockNativePlaybackPosition({
      sessionId: latestNativeSessionId(),
      positionSeconds: 5.25,
      durationSeconds: 182,
      state: "playing",
    });
    await waitFor(() => expect(readPlaybackE2ETelemetry().positionSeconds).toBe(5.25));
    restoreTauriRuntime();
  });

  it("falls back to Web Audio when native play reports an underrun fallback", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
      playFallbackReason: "Native playback underrun persisted; falling back to Web Audio.",
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() =>
      expect(
        getMockInvoke().mock.calls.some(([command]) => command === "audio_play"),
      ).toBe(true),
    );
    await waitFor(() => {
      expect(findAudioByArtifactId("art_source")).toBeInTheDocument();
    });
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await waitFor(() =>
      expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(1),
    );
    expect(window.localStorage.getItem("tuneforge.playback-native-error")).toBe(
      "Native playback underrun persisted; falling back to Web Audio.",
    );
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "web-audio",
      transportState: "playing",
    });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    restoreTauriRuntime();
  });

  it("keeps Web Audio telemetry when delayed native stop cleanup resolves after fallback", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    const mockInvoke = getMockInvoke();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    const nativeStopBlock: { resolve: (() => void) | null } = { resolve: null };
    let resolveNativeStopSettled: (() => void) | null = null;
    const nativeStopSettled = new Promise<void>((resolve) => {
      resolveNativeStopSettled = resolve;
    });
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "audio_stop") {
        await new Promise<void>((resolve) => {
          nativeStopBlock.resolve = () => {
            nativeStopBlock.resolve = null;
            resolve();
          };
        });
        const result = await defaultInvoke(command, args);
        resolveNativeStopSettled?.();
        return result;
      }
      return defaultInvoke(command, args);
    });

    try {
      setupTempoAnalysis(120);
      setMockNativeAudioState({
        capabilities: {
          nativePlaybackSupported: true,
          fallbackRequired: false,
          fallbackReason: null,
          backend: "desktop-cpal",
        },
      });
      renderApp(["/projects/proj_123"]);

      expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
      await openPlaybackWorkspace(user);
      await user.click(screen.getByRole("button", { name: "Play playback" }));
      await waitFor(() =>
        expect(readPlaybackE2ETelemetry()).toMatchObject({
          activePath: "native",
          transportState: "playing",
        }),
      );

      emitMockNativePlaybackError({
        sessionId: latestNativeSessionId(),
        code: "output_stream_failure",
      });
      await waitFor(() => expect(nativeStopBlock.resolve).not.toBeNull());
      const sourceAudio = findAudioByArtifactId("art_source");
      markAudioReady(sourceAudio);
      await waitFor(() =>
        expect(readPlaybackE2ETelemetry()).toMatchObject({
          activePath: "web-audio",
          transportState: "playing",
        }),
      );

      nativeStopBlock.resolve?.();
      await nativeStopSettled;
      await Promise.resolve();
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "web-audio",
        transportState: "playing",
      });
    } finally {
      nativeStopBlock.resolve?.();
      mockInvoke.mockImplementation(defaultInvoke);
      restoreTauriRuntime();
    }
  });

  it("falls back to Web Audio at the current native time after a runtime underrun error", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(
        getMockInvoke().mock.calls.some(([command]) => command === "audio_play"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(mockListen.mock.calls.some(([eventName]) => eventName === "audio://error")).toBe(true),
    );

    const sessionId = latestNativeSessionId();
    emitMockNativePlaybackPosition({
      sessionId,
      positionSeconds: 42.25,
      durationSeconds: 182,
      state: "playing",
    });
    await waitFor(() => expect(screen.getByLabelText("Playback position")).toHaveValue("42.25"));

    emitMockNativePlaybackError({
      sessionId: "stale-native-session",
      code: "output_stream_failure",
    });
    await waitFor(() => {
      expect(
        getMockInvoke().mock.calls.some(([command]) => command === "audio_stop"),
      ).toBe(false);
    });
    expect(window.localStorage.getItem("tuneforge.playback-native-error")).toBeNull();

    emitMockNativePlaybackError({
      sessionId,
      code: "output_stream_failure",
    });

    await waitFor(() => {
      expect(findAudioByArtifactId("art_source")).toBeInTheDocument();
    });
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await waitFor(() =>
      expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(1),
    );
    expect(getMockAudioContexts().flatMap((context) => context.createdSources)[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      42.25,
      3,
    );
    expect(window.localStorage.getItem("tuneforge.playback-native-error")).toBe(
      "Native playback output failed.",
    );
    expect(
      getMockInvoke().mock.calls.some(([command]) => command === "audio_stop"),
    ).toBe(true);
    restoreTauriRuntime();
  });

  it("keeps source and practice mix switching on the streamed media path when tempo is changed", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await waitForTempoSummary("119 BPM (0.992x)");
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    expect(sourceAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect((sourceAudio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch).toBe(true);
    expect(vi.mocked(window.HTMLMediaElement.prototype.play)).toHaveBeenCalled();
    expect(getMockAudioContexts()[0]?.createdSources ?? []).toHaveLength(0);

    setPlaybackPosition("47.253");
    const sourceList = screen.getByRole("group", { name: "Playback source and mix list" });
    await user.click(within(sourceList).getByRole("button", { name: /Practice Mix/i }));

    const previewAudio = findAudioByArtifactId("art_preview");
    previewAudio.currentTime = 0;
    setAudioPlaybackState(previewAudio);
    fireEvent.loadedMetadata(previewAudio);
    fireEvent.canPlay(previewAudio);
    previewAudio.currentTime = 47.253;
    fireEvent.seeked(previewAudio);

    await waitFor(() => expect(previewAudio.currentTime).toBeCloseTo(47.253, 3));
    expect(previewAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("preserves time when changing tempo during active buffered playback", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    setPlaybackPosition("32.5");
    await openPlaybackWorkspace(user);

    const playCallsBeforeTempoChange =
      vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length;
    const bpmInput = screen.getByRole("spinbutton", { name: "Playback BPM" });
    await user.clear(bpmInput);
    await user.type(bpmInput, "119{Enter}");

    await waitFor(() => {
      expect(sourceAudio.currentTime).toBeGreaterThanOrEqual(32.5);
      expect(sourceAudio.currentTime).toBeLessThan(32.7);
    });
    await waitFor(() =>
      expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBeGreaterThan(
        playCallsBeforeTempoChange,
      ),
    );
    expect(sourceAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("starts tempo-adjusted stems from metadata without requiring a pause toggle", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    useTwoStemModelDefault();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await waitForTempoSummary("119 BPM (0.992x)");
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    setPlaybackPosition("41.125");

    const playCallsBeforeStemSwitch =
      vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length;
    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Full Mix" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );

    const vocalAudio = findAudioByArtifactId("art_200");
    const instrumentalAudio = findAudioByArtifactId("art_201");
    setAudioPlaybackState(vocalAudio, {
      readyState: HTMLMediaElement.HAVE_METADATA,
    });
    setAudioPlaybackState(instrumentalAudio, {
      readyState: HTMLMediaElement.HAVE_METADATA,
    });
    fireEvent.loadedMetadata(vocalAudio);
    fireEvent.loadedMetadata(instrumentalAudio);
    fireEvent.seeked(vocalAudio);
    fireEvent.seeked(instrumentalAudio);

    await waitFor(() =>
      expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length).toBeGreaterThan(
        playCallsBeforeStemSwitch,
      ),
    );
    expect(vocalAudio.currentTime).toBeCloseTo(41.125, 3);
    expect(instrumentalAudio.currentTime).toBeCloseTo(41.125, 3);
    expect(vocalAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect(instrumentalAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("updates tempo-adjusted stem rate in place without replaying or seeking", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    useTwoStemModelDefault();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);

    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Full Mix" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await waitForTempoSummary("119 BPM (0.992x)");

    const vocalAudio = findAudioByArtifactId("art_200");
    const instrumentalAudio = findAudioByArtifactId("art_201");
    markAudioReady(vocalAudio);
    markAudioReady(instrumentalAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    setPlaybackPosition("52.25");

    const playCallsBeforeTempoChanges =
      vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls.length;
    const pauseCallsBeforeTempoChanges =
      vi.mocked(window.HTMLMediaElement.prototype.pause).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await user.click(screen.getByRole("button", { name: "Increase playback tempo" }));
    await waitForTempoSummary("118 BPM (0.983x)");
    await act(async () => {});
    act(() => {
      advanceMockAnimationFrames(5);
    });

    await waitFor(() => expect(vocalAudio.playbackRate).toBeCloseTo(118 / 120, 4));
    expect(instrumentalAudio.playbackRate).toBeCloseTo(118 / 120, 4);
    expect(vocalAudio.currentTime).toBeCloseTo(52.25, 3);
    expect(instrumentalAudio.currentTime).toBeCloseTo(52.25, 3);
    expect(vi.mocked(window.HTMLMediaElement.prototype.play).mock.calls).toHaveLength(
      playCallsBeforeTempoChanges,
    );
    expect(vi.mocked(window.HTMLMediaElement.prototype.pause).mock.calls).toHaveLength(
      pauseCallsBeforeTempoChanges,
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("keeps tempo-adjusted stem playback synced with mute, solo, and full-mix handoff", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    useTwoStemModelDefault();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);

    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
    await waitForTempoSummary("119 BPM (0.992x)");

    const vocalAudio = findAudioByArtifactId("art_200");
    const instrumentalAudio = findAudioByArtifactId("art_201");
    markAudioReady(vocalAudio);
    markAudioReady(instrumentalAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    expect(vocalAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect(instrumentalAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    await user.click(screen.getByRole("button", { name: "Solo Vocals" }));
    expect(vocalAudio.volume).toBe(1);
    expect(instrumentalAudio.volume).toBe(0);

    setPlaybackPosition("28.25");
    await user.click(screen.getByRole("button", { name: "Full Mix" }));
    const sourceAudio = findAudioByArtifactId("art_source");
    setAudioPlaybackState(sourceAudio);
    fireEvent.loadedMetadata(sourceAudio);
    fireEvent.canPlay(sourceAudio);
    sourceAudio.currentTime = 28.25;
    fireEvent.seeked(sourceAudio);

    await waitFor(() => expect(sourceAudio.currentTime).toBeCloseTo(28.25, 3));
    expect(sourceAudio.playbackRate).toBeCloseTo(119 / 120, 4);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });
});
