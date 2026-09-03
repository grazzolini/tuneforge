import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAudioByArtifactId,
  getMockAudioContexts,
  getMockInvoke,
  markAudioReady,
  emitMockNativePlaybackPosition,
  emitMockNativeAudioCue,
  emitMockNativeAudioTerminal,
  resetAppTestHarness,
  renderApp,
  setMockNativeAudioState,
  setProjectAnalysis,
} from "./test/appTestHarness";

const analysisWithTempo = {
  project_id: "proj_123",
  estimated_key: "G major",
  key_confidence: 0.82,
  estimated_reference_hz: 440,
  tuning_offset_cents: 0,
  tempo_bpm: 120,
  analysis_version: "v1",
  created_at: "2026-04-18T13:16:00.000Z",
};

const analysisWithTiming = {
  ...analysisWithTempo,
  timing: {
    beats_per_bar: 4,
    source: "detected",
    beats: [
      { index: 0, seconds: 0, bar_index: 0, beat_in_bar: 1 },
      { index: 1, seconds: 0.48, bar_index: 0, beat_in_bar: 2 },
      { index: 2, seconds: 1.01, bar_index: 0, beat_in_bar: 3 },
      { index: 3, seconds: 1.5, bar_index: 0, beat_in_bar: 4 },
      { index: 4, seconds: 2.04, bar_index: 1, beat_in_bar: 1 },
      { index: 5, seconds: 2.52, bar_index: 1, beat_in_bar: 2 },
      { index: 6, seconds: 3.02, bar_index: 1, beat_in_bar: 3 },
      { index: 7, seconds: 3.51, bar_index: 1, beat_in_bar: 4 },
      { index: 8, seconds: 4.04, bar_index: 2, beat_in_bar: 1 },
    ],
    bars: [
      { index: 0, start_seconds: 0, end_seconds: 2.04 },
      { index: 1, start_seconds: 2.04, end_seconds: 4.04 },
      { index: 2, start_seconds: 4.04, end_seconds: 6 },
    ],
  },
};

function setupTempoAnalysis() {
  setProjectAnalysis("proj_123", analysisWithTempo);
}

async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Playback" }));
}

async function openStudioPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Studio" }));
}

function setPlaybackPosition(value: string) {
  fireEvent.change(screen.getByLabelText("Playback position"), { target: { value } });
}

async function flushMicrotasks(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function readPlaybackE2ETelemetry() {
  const telemetry = window.__TUNEFORGE_PLAYBACK_E2E__?.read();
  if (!telemetry) {
    throw new Error("Playback E2E telemetry bridge was not exposed.");
  }
  return telemetry;
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

function enableNativePlayback() {
  const restoreTauriRuntime = mockTauriRuntime();
  setMockNativeAudioState({
    capabilities: {
      nativePlaybackSupported: true,
      fallbackRequired: false,
      fallbackReason: null,
      backend: "desktop-cpal",
    },
  });
  return restoreTauriRuntime;
}

function invokeCalls(command: string) {
  return getMockInvoke().mock.calls.filter(([name]) => name === command);
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

function audioPlayStartTime(callIndex = 0) {
  const playCall = invokeCalls("audio_play")[callIndex];
  const payload = (playCall?.[1] as { payload?: { startTimeSeconds?: number | null } } | undefined)?.payload;
  return payload?.startTimeSeconds ?? null;
}

function expectPrecountClicksCancelled(
  audioContext: ReturnType<typeof getMockAudioContexts>[number] | undefined,
) {
  expect(audioContext?.createdOscillators).toHaveLength(4);
  audioContext?.createdOscillators.forEach((oscillator) => {
    expect(oscillator.stop).toHaveBeenCalledTimes(2);
    expect(oscillator.disconnect).toHaveBeenCalledTimes(1);
  });
}

function createDeferred<T>(_type?: T) {
  void _type;
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = (value) => nextResolve({
      ...(value as object),
      leaseId: "project-playback",
      generation: 1,
      timelineRevision: 1,
      nativeTimeUs: 1,
    } as T);
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe("Desktop app project playback pre-count", () => {
  beforeEach(resetAppTestHarness);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows pre-count disabled until analysis provides BPM", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    expect(screen.getByLabelText("Enable pre-count")).toBeDisabled();
    expect(screen.getByLabelText("Enable loop pre-count")).toBeDisabled();
    expect(screen.getByRole("group", { name: "Pre-count clicks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease pre-count clicks" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase pre-count clicks" })).toBeDisabled();
    expect(screen.getByText("Waiting for BPM analysis")).toBeInTheDocument();
  });

  it("persists enabled pre-count and click count once BPM is known", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    const firstRender = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    await user.click(screen.getByLabelText("Enable pre-count"));
    await user.click(screen.getByLabelText("Enable loop pre-count"));
    await user.click(screen.getByRole("button", { name: "Increase pre-count clicks" }));

    expect(screen.getByLabelText("Enable pre-count")).toBeChecked();
    expect(screen.getByLabelText("Enable loop pre-count")).toBeChecked();
    expect(screen.getByText("5 clicks at 120.0 BPM")).toBeInTheDocument();

    firstRender.unmount();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    expect(screen.getByLabelText("Enable pre-count")).toBeChecked();
    expect(screen.getByLabelText("Enable loop pre-count")).toBeChecked();
    expect(screen.getByText("5 clicks at 120.0 BPM")).toBeInTheDocument();
  });

  it("runs pre-count before source playback and starts from zero", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    sourceAudio.currentTime = 0;

    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    const playSpy = vi.mocked(window.HTMLMediaElement.prototype.play);
    expect(playSpy).not.toHaveBeenCalled();
    const audioContext = getMockAudioContexts()[0];
    expect(audioContext?.createdOscillators).toHaveLength(4);
    expect(audioContext?.createdSources).toHaveLength(0);
    let telemetry = readPlaybackE2ETelemetry();
    expect(telemetry.countIn.active).toBe(true);
    expect(telemetry.countIn.lastScheduled).toMatchObject({
      activePath: "none",
      clickCount: 4,
      startTimeSeconds: 0,
      tempoBpm: 120,
      trigger: "song-start",
    });
    expect(telemetry.countIn.lastFired).toBeNull();
    const clickStartTimes = audioContext?.createdOscillators.map(
      (oscillator) => oscillator.start.mock.calls[0]?.[0],
    ) ?? [];
    expect(Number(clickStartTimes[1]) - Number(clickStartTimes[0])).toBeCloseTo(0.5, 3);
    expect(Number(clickStartTimes[3]) - Number(clickStartTimes[2])).toBeCloseTo(0.5, 3);

    act(() => {
      vi.advanceTimersByTime(2034);
    });
    expect(playSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flushMicrotasks();
    expect(playSpy).not.toHaveBeenCalled();
    expect(audioContext?.createdSources).toHaveLength(1);
    expect(audioContext?.createdSources[0]?.start.mock.calls[0]?.[0]).toBeCloseTo(2.035, 3);
    expect(audioContext?.createdSources[0]?.start.mock.calls[0]?.[1]).toBe(0);
    expect(sourceAudio.currentTime).toBe(0);
    telemetry = readPlaybackE2ETelemetry();
    expect(telemetry.countIn.active).toBe(false);
    expect(telemetry.countIn.lastFired).toMatchObject({
      sequence: telemetry.countIn.lastScheduled?.sequence,
      trigger: "song-start",
    });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
  });

  it("cancels pre-count without starting playback", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    const audioContext = getMockAudioContexts()[0];
    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
    expectPrecountClicksCancelled(audioContext);

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(vi.mocked(window.HTMLMediaElement.prototype.play)).not.toHaveBeenCalled();
    expect(audioContext?.createdSources).toHaveLength(0);
    expect(sourceAudio.currentTime).toBe(0);
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled).toMatchObject({
      reason: "playback-stopped",
      sequence: readPlaybackE2ETelemetry().countIn.lastScheduled?.sequence,
      trigger: "song-start",
    });
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
  });

  it("cancels loop pre-count clicks and resets to loop start on stop", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable loop pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    const audioContext = getMockAudioContexts()[0];
    expect(audioContext?.createdSources).toHaveLength(0);
    expect(audioContext?.createdOscillators).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
    expectPrecountClicksCancelled(audioContext);

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(audioContext?.createdSources).toHaveLength(0);
    expect(sourceAudio.currentTime).toBeCloseTo(12.25, 3);
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      countIn: {
        active: false,
        lastCancelled: {
          reason: "playback-stopped",
          sequence: readPlaybackE2ETelemetry().countIn.lastScheduled?.sequence,
          trigger: "loop-start",
        },
      },
      loopRange: { startSeconds: 12.25, endSeconds: 24.5 },
      positionSeconds: 12.25,
      transportState: "stopped",
    });
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
  });

  it("records pre-count cancellation reasons for superseded, session, and unavailable states", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    const rendered = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    let scheduledSequence = readPlaybackE2ETelemetry().countIn.lastScheduled?.sequence;
    setPlaybackPosition("12.5");
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled).toMatchObject({
      reason: "superseded",
      sequence: scheduledSequence,
      trigger: "song-start",
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
    setPlaybackPosition("0");
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    scheduledSequence = readPlaybackE2ETelemetry().countIn.lastScheduled?.sequence;
    const sourceList = screen.getByRole("group", { name: "Playback source and mix list" });
    fireEvent.click(within(sourceList).getByRole("button", { name: /Practice Mix/i }));
    await flushMicrotasks();
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled).toMatchObject({
      reason: "session-changed",
      sequence: scheduledSequence,
      trigger: "song-start",
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
    setPlaybackPosition("0");
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    scheduledSequence = readPlaybackE2ETelemetry().countIn.lastScheduled?.sequence;
    rendered.unmount();
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled).toMatchObject({
      reason: "unavailable",
      sequence: scheduledSequence,
      trigger: "song-start",
    });
    vi.useRealTimers();
  });

  it("does not pre-count when resuming mid-song", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    setPlaybackPosition("12.5");

    await user.click(screen.getByLabelText("Enable pre-count"));
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    expect(vi.mocked(window.HTMLMediaElement.prototype.play)).not.toHaveBeenCalled();
    expect(getMockAudioContexts()[0]?.createdOscillators).toHaveLength(0);
    expect(getMockAudioContexts()[0]?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      12.5,
      3,
    );
    expect(sourceAudio.currentTime).toBeCloseTo(12.5, 3);
  });

  it("starts native playback from a stopped seek position", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.5");
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));
    expect(audioPlayStartTime()).toBeCloseTo(12.5, 3);
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        positionSeconds: 12.5,
        transportState: "playing",
      }),
    );
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    restoreTauriRuntime();
  });

  it("does not pre-count when resuming after pause", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    const audioContext = getMockAudioContexts()[0];
    expect(audioContext?.createdOscillators).toHaveLength(4);

    act(() => {
      vi.advanceTimersByTime(2035);
    });
    await flushMicrotasks();
    const sourceStartCount = audioContext?.createdSources.length ?? 0;
    const oscillatorCount = audioContext?.createdOscillators.length ?? 0;
    expect(sourceStartCount).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Pause playback" }));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    expect(audioContext?.createdSources.length).toBeGreaterThanOrEqual(sourceStartCount);
    expect(audioContext?.createdOscillators).toHaveLength(oscillatorCount);
    vi.useRealTimers();
  }, 15000);

  it("loop pre-counts from loop start on fresh playback and each loop wrap", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    vi.useFakeTimers();

    fireEvent.click(screen.getByLabelText("Enable loop pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    const audioContext = getMockAudioContexts()[0];
    expect(audioContext?.createdSources).toHaveLength(0);
    expect(audioContext?.createdOscillators).toHaveLength(4);
    let telemetry = readPlaybackE2ETelemetry();
    expect(telemetry.loopRange).toEqual({ startSeconds: 12.25, endSeconds: 24.5 });
    expect(telemetry.countIn.active).toBe(true);
    expect(telemetry.countIn.lastScheduled).toMatchObject({
      clickCount: 4,
      startTimeSeconds: 12.25,
      tempoBpm: 120,
      trigger: "loop-start",
    });
    const firstSequence = telemetry.countIn.lastScheduled?.sequence;
    act(() => {
      vi.advanceTimersByTime(2035);
    });
    await flushMicrotasks();
    expect(audioContext?.createdSources).toHaveLength(1);
    expect(audioContext?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(12.25, 3);
    expect(sourceAudio.currentTime).toBeCloseTo(12.25, 3);
    telemetry = readPlaybackE2ETelemetry();
    expect(telemetry.countIn.active).toBe(false);
    expect(telemetry.countIn.lastFired).toMatchObject({
      sequence: firstSequence,
      trigger: "loop-start",
    });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();

    act(() => {
      sourceAudio.currentTime = 24.5;
      fireEvent.timeUpdate(sourceAudio);
    });
    await flushMicrotasks();
    expect(audioContext?.createdOscillators).toHaveLength(8);
    telemetry = readPlaybackE2ETelemetry();
    expect(telemetry.countIn.active).toBe(true);
    expect(telemetry.countIn.lastScheduled).toMatchObject({
      startTimeSeconds: 12.25,
      trigger: "loop-start",
    });
    expect(telemetry.countIn.lastScheduled?.sequence).not.toBe(firstSequence);
    const sourceCountBeforeRollover = audioContext?.createdSources.length ?? 0;
    act(() => {
      vi.advanceTimersByTime(2035);
    });
    await flushMicrotasks();
    expect(audioContext?.createdSources).toHaveLength(sourceCountBeforeRollover + 1);
    expect(audioContext?.createdSources[sourceCountBeforeRollover]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      12.25,
      3,
    );
    telemetry = readPlaybackE2ETelemetry();
    expect(telemetry.countIn.active).toBe(false);
    expect(telemetry.countIn.lastFired).toMatchObject({
      sequence: telemetry.countIn.lastScheduled?.sequence,
      trigger: "loop-start",
    });
    vi.useRealTimers();
  }, 15000);

  it("starts native playback at loop start when stopped outside the loop", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));
    setPlaybackPosition("48");

    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));
    expect(audioPlayStartTime()).toBeCloseTo(12.25, 3);
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        loopRange: { startSeconds: 12.25, endSeconds: 24.5 },
        positionSeconds: 12.25,
        transportState: "playing",
      }),
    );
    restoreTauriRuntime();
  });

  it("stops paused native playback before replaying from song start", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("18.75");

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));
    expect(audioPlayStartTime()).toBeCloseTo(18.75, 3);

    act(() => {
      emitMockNativePlaybackPosition({
        sessionId: latestNativeSessionId(),
        positionSeconds: 23.5,
        durationSeconds: 182,
        state: "playing",
      });
    });
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        positionSeconds: 23.5,
        transportState: "playing",
      }),
    );

    const pauseDeferred = createDeferred({
      sessionId: latestNativeSessionId(),
      state: "paused",
      positionSeconds: 23.5,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const stopDeferred = createDeferred({
      sessionId: latestNativeSessionId(),
      state: "stopped",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_pause") {
        return pauseDeferred.promise;
      }
      if (command === "audio_stop") {
        return stopDeferred.promise;
      }
      if (!originalInvoke) {
        throw new Error(`Unhandled invoke command ${command}`);
      }
      return originalInvoke(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await waitFor(() => expect(invokeCalls("audio_pause")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      positionSeconds: 23.5,
      transportState: "playing",
    });
    pauseDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "paused",
      positionSeconds: 23.5,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument(),
    );
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      positionSeconds: 23.5,
      transportState: "paused",
    });
    expect(invokeCalls("audio_stop")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "none",
        positionSeconds: 0,
        transportState: "stopped",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    expect(invokeCalls("audio_play")).toHaveLength(1);
    stopDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "stopped",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(2));
    expect(audioPlayStartTime(1)).toBe(0);
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        positionSeconds: 0,
        transportState: "playing",
      }),
    );
    if (originalInvoke) {
      invoke.mockImplementation(originalInvoke);
    }
    restoreTauriRuntime();
  });

  it("ignores stale native play completion after stop", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("18.75");

    const playDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_play") {
        return playDeferred.promise;
      }
      if (!originalInvoke) {
        throw new Error(`Unhandled invoke command ${command}`);
      }
      return originalInvoke(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));
    expect(audioPlayStartTime()).toBeCloseTo(18.75, 3);

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "none",
        positionSeconds: 0,
        transportState: "stopped",
      }),
    );

    playDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(2));
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "none",
      positionSeconds: 0,
      transportState: "stopped",
    });
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    if (originalInvoke) {
      invoke.mockImplementation(originalInvoke);
    }
    restoreTauriRuntime();
  });

  it("does not stop newer native replay when stale play completes", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("18.75");

    const firstPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const secondPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_play") {
        return invokeCalls("audio_play").length === 1
          ? firstPlayDeferred.promise
          : secondPlayDeferred.promise;
      }
      if (!originalInvoke) {
        throw new Error(`Unhandled invoke command ${command}`);
      }
      return originalInvoke(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));
    expect(audioPlayStartTime()).toBeCloseTo(18.75, 3);

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "none",
        positionSeconds: 0,
        transportState: "stopped",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(2));
    expect(audioPlayStartTime(1)).toBe(0);
    secondPlayDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    firstPlayDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        positionSeconds: 0,
        transportState: "playing",
      }),
    );
    expect(invokeCalls("audio_stop")).toHaveLength(1);
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      positionSeconds: 0,
      transportState: "playing",
    });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    if (originalInvoke) {
      invoke.mockImplementation(originalInvoke);
    }
    restoreTauriRuntime();
  });

  it("ignores stale native play failure after newer replay starts", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("18.75");

    const firstPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const secondPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_play") {
        return invokeCalls("audio_play").length === 1
          ? firstPlayDeferred.promise
          : secondPlayDeferred.promise;
      }
      if (!originalInvoke) {
        throw new Error(`Unhandled invoke command ${command}`);
      }
      return originalInvoke(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "none",
        positionSeconds: 0,
        transportState: "stopped",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(2));
    secondPlayDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        positionSeconds: 0,
        transportState: "playing",
      }),
    );

    firstPlayDeferred.reject(new Error("stale native play failed"));
    await flushMicrotasks();
    expect(invokeCalls("audio_stop")).toHaveLength(1);
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      positionSeconds: 0,
      transportState: "playing",
    });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    if (originalInvoke) {
      invoke.mockImplementation(originalInvoke);
    }
    restoreTauriRuntime();
  });

  it("records terminal cancellation for an active native pre-count", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await openPlaybackWorkspace(user);
    await user.click(screen.getByLabelText("Enable pre-count"));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(readPlaybackE2ETelemetry().countIn.active).toBe(true));
    act(() => emitMockNativeAudioTerminal({
      resource: "output", source: "output_runtime", generation: 1,
      code: "output_stream_failure", nativeTimeUs: 3_000_000,
    }));
    expect(readPlaybackE2ETelemetry().countIn).toMatchObject({ active: false, lastCancelled: {
      reason: "unavailable", cancelledAtContextTimeSeconds: 3,
    } });
    restoreTauriRuntime();
  });

  it("does not stop pending newer native replay when stale play completes", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("18.75");

    const firstPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const secondPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_play") {
        return invokeCalls("audio_play").length === 1
          ? firstPlayDeferred.promise
          : secondPlayDeferred.promise;
      }
      if (!originalInvoke) {
        throw new Error(`Unhandled invoke command ${command}`);
      }
      return originalInvoke(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "none",
        positionSeconds: 0,
        transportState: "stopped",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(2));
    expect(audioPlayStartTime(1)).toBe(0);

    firstPlayDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await flushMicrotasks();
    expect(invokeCalls("audio_stop")).toHaveLength(1);
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "none",
      positionSeconds: 0,
      transportState: "stopped",
    });

    secondPlayDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "native",
        positionSeconds: 0,
        transportState: "playing",
      }),
    );
    expect(invokeCalls("audio_stop")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    if (originalInvoke) {
      invoke.mockImplementation(originalInvoke);
    }
    restoreTauriRuntime();
  });

  it("stops stale native play if pending newer replay fails", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("18.75");

    const firstPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const secondPlayDeferred = createDeferred({
      sessionId: "proj_123:art_source",
      state: "playing",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_play") {
        return invokeCalls("audio_play").length === 1
          ? firstPlayDeferred.promise
          : secondPlayDeferred.promise;
      }
      if (!originalInvoke) {
        throw new Error(`Unhandled invoke command ${command}`);
      }
      return originalInvoke(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(readPlaybackE2ETelemetry()).toMatchObject({
        activePath: "none",
        positionSeconds: 0,
        transportState: "stopped",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(2));

    firstPlayDeferred.resolve({
      sessionId: latestNativeSessionId(),
      state: "playing",
      positionSeconds: 18.75,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    });
    await flushMicrotasks();
    expect(invokeCalls("audio_stop")).toHaveLength(1);

    secondPlayDeferred.reject(new Error("native play failed"));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(2));
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "none",
      positionSeconds: 0,
      transportState: "stopped",
    });
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    if (originalInvoke) {
      invoke.mockImplementation(originalInvoke);
    }
    restoreTauriRuntime();
  });

  it("publishes cancellation and blocks late completion when native stop rejects", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByLabelText("Enable pre-count"));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(invokeCalls("audio_play")).toHaveLength(1));
    expect(readPlaybackE2ETelemetry().countIn.lastScheduled).toMatchObject({
      activePath: "native", clickCount: 4, scheduledAtContextTimeSeconds: 0.000001,
    });
    act(() => emitMockNativeAudioCue({
      generation: 1, revision: 1, cueIndex: 0, kind: "precount_beat",
      accent: false, gain: 1, scheduledNativeTimeUs: 1_000_000,
      actualNativeTimeUs: 1_000_010, insertionSequence: 1,
    }));
    expect(readPlaybackE2ETelemetry().countIn.lastScheduled).toMatchObject({
      firstClickTimeSeconds: 1, playbackStartTimeSeconds: 3,
    });

    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_stop") throw new Error("native stop failed");
      return originalInvoke!(command, args);
    });

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => expect(invokeCalls("audio_stop")).toHaveLength(1));
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled).toMatchObject({
      reason: "playback-stopped", trigger: "song-start",
    });
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled?.cancelledAtContextTimeSeconds)
      .toEqual(expect.any(Number));
    act(() => emitMockNativeAudioCue({
      generation: 1, revision: 1, cueIndex: 4, kind: "precount_completion",
      accent: false, gain: 1, scheduledNativeTimeUs: 2_000_000,
      actualNativeTimeUs: 2_000_000, insertionSequence: 5,
    }));
    expect(invokeCalls("audio_play")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    invoke.mockImplementation(originalInvoke!);
    restoreTauriRuntime();
  });

  it("runs loop pre-count on native loop wrap before restarting at loop start", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    fireEvent.click(screen.getByLabelText("Enable loop pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    expect(invokeCalls("audio_play")).toHaveLength(1);
    expect(audioPlayStartTime()).toBeCloseTo(12.25, 3);
    expect(invokeCalls("audio_play")[0]?.[1]).toMatchObject({
      payload: { precount: { intervalsSeconds: [0.5, 0.5, 0.5, 0.5] } },
    });
    expect(getMockAudioContexts()).toHaveLength(0);
    act(() => emitMockNativeAudioCue({
      generation: 1, revision: 1, cueIndex: 4, kind: "precount_completion",
      accent: false, gain: 1, scheduledNativeTimeUs: 2_000_000,
      actualNativeTimeUs: 2_000_000, insertionSequence: 5,
    }));
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      countIn: { active: false, lastFired: { firedAtContextTimeSeconds: 2 } },
      positionSeconds: 12.25,
      transportState: "playing",
    });

    act(() => {
      emitMockNativePlaybackPosition({
        sessionId: latestNativeSessionId(),
        positionSeconds: 24.5,
        durationSeconds: 182,
        state: "playing",
      });
    });
    await flushMicrotasks();

    expect(invokeCalls("audio_stop")).toHaveLength(1);
    expect(invokeCalls("audio_play")).toHaveLength(2);
    expect(audioPlayStartTime(1)).toBeCloseTo(12.25, 3);
    act(() => emitMockNativeAudioCue({
      generation: 1, revision: 1, cueIndex: 4, kind: "precount_completion",
      accent: false, gain: 1, scheduledNativeTimeUs: 4_000_000,
      actualNativeTimeUs: 4_000_000, insertionSequence: 10,
    }));
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      positionSeconds: 12.25,
      transportState: "playing",
    });
    restoreTauriRuntime();
  }, 15000);

  it("cancels a native wrap pre-count when the active loop is cleared", async () => {
    const restoreTauriRuntime = enableNativePlayback();
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));
    fireEvent.click(screen.getByLabelText("Enable loop pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    act(() => emitMockNativeAudioCue({
      generation: 1, revision: 1, cueIndex: 4, kind: "precount_completion",
      accent: false, gain: 1, scheduledNativeTimeUs: 2_000_000,
      actualNativeTimeUs: 2_000_000, insertionSequence: 5,
    }));

    act(() => emitMockNativePlaybackPosition({
      sessionId: latestNativeSessionId(), positionSeconds: 24.5,
      durationSeconds: 182, state: "playing",
    }));
    await flushMicrotasks();
    expect(invokeCalls("audio_play")).toHaveLength(2);
    expect(readPlaybackE2ETelemetry().countIn.active).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear loop" }));
    await flushMicrotasks();

    expect(invokeCalls("audio_stop")).toHaveLength(2);
    expect(invokeCalls("audio_play")).toHaveLength(3);
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "native",
      countIn: { active: false, lastCancelled: { trigger: "loop-start" } },
      loopRange: null,
      transportState: "playing",
    });
    restoreTauriRuntime();
  }, 15000);

  it("cancels a Web wrap pre-count when the active loop is cleared", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable loop pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();
    act(() => vi.advanceTimersByTime(2035));
    await flushMicrotasks();

    act(() => {
      sourceAudio.currentTime = 24.5;
      fireEvent.timeUpdate(sourceAudio);
    });
    await flushMicrotasks();
    expect(readPlaybackE2ETelemetry().countIn.active).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear loop" }));
    await flushMicrotasks();

    const audioContext = getMockAudioContexts()[0];
    expect(audioContext?.createdOscillators).toHaveLength(8);
    audioContext?.createdOscillators.slice(-4).forEach((oscillator) => {
      expect(oscillator.stop).toHaveBeenCalledTimes(2);
      expect(oscillator.disconnect).toHaveBeenCalledTimes(1);
    });
    expect(readPlaybackE2ETelemetry()).toMatchObject({
      activePath: "web-audio",
      countIn: { active: false, lastCancelled: { trigger: "loop-start" } },
      loopRange: null,
      transportState: "playing",
    });
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    vi.useRealTimers();
  }, 15000);

  it("uses timing-grid spacing for loop pre-counts when available", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", analysisWithTiming);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("2.04");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("4.04");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    vi.useFakeTimers();

    fireEvent.click(screen.getByLabelText("Enable loop pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    const audioContext = getMockAudioContexts()[0];
    expect(audioContext?.createdOscillators).toHaveLength(4);
    const clickStartTimes = audioContext?.createdOscillators.map(
      (oscillator) => oscillator.start.mock.calls[0]?.[0],
    ) ?? [];
    expect(Number(clickStartTimes[1]) - Number(clickStartTimes[0])).toBeCloseTo(0.48, 3);
    expect(Number(clickStartTimes[2]) - Number(clickStartTimes[1])).toBeCloseTo(0.53, 3);
    expect(Number(clickStartTimes[3]) - Number(clickStartTimes[2])).toBeCloseTo(0.49, 3);

    act(() => {
      vi.advanceTimersByTime(2075);
    });
    await flushMicrotasks();

    expect(audioContext?.createdSources[0]?.start.mock.calls[0]?.[0]).toBeCloseTo(2.075, 3);
    expect(audioContext?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(2.04, 3);
    vi.useRealTimers();
  }, 15000);

  it("snaps newly set loops by the project loop alignment mode", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", analysisWithTiming);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);

    await user.click(screen.getByRole("button", { name: "Beat" }));
    setPlaybackPosition("1.9");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("3.8");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    expect(getMockAudioContexts()[0]?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      2.04,
      3,
    );
    const storedPlaybackState = JSON.parse(
      window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
    );
    expect(storedPlaybackState.proj_123.loopAlignmentMode).toBe("beat");
  });

  it("keeps project loop alignment override after resetting global settings", async () => {
    const user = userEvent.setup();
    const settingsRender = renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Bar/ }));
    settingsRender.unmount();

    setProjectAnalysis("proj_123", analysisWithTiming);
    const projectRender = renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    expect(screen.getByRole("button", { name: "Bar" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Beat" }));
    projectRender.unmount();

    const resetRender = renderApp(["/settings"]);
    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset All Settings" }));

    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")).toMatchObject({
      defaultLoopAlignmentMode: "free",
    });
    const storedProjectPlaybackState = JSON.parse(
      window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}",
    );
    expect(storedProjectPlaybackState.proj_123.loopAlignmentMode).toBe("beat");
    resetRender.unmount();

    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    expect(screen.getByRole("button", { name: "Beat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not use song pre-count for a nonzero loop start", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    setPlaybackPosition("12.25");
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    setPlaybackPosition("24.5");
    await user.click(screen.getByRole("button", { name: "Set loop end" }));

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByLabelText("Enable pre-count"));
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(getMockAudioContexts()[0]?.createdSources).toHaveLength(1));
    expect(getMockAudioContexts()[0]?.createdOscillators).toHaveLength(0);
    expect(getMockAudioContexts()[0]?.createdSources[0]?.start.mock.calls[0]?.[1]).toBeCloseTo(
      12.25,
      3,
    );
  });

  it("schedules stem playback on the pre-count clock after the last click", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);

    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText("Enable pre-count"));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    await flushMicrotasks();

    const stemAudioContext = getMockAudioContexts()[0];
    expect(stemAudioContext?.createdOscillators).toHaveLength(4);
    expect(stemAudioContext?.createdSources).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(2035);
    });
    await flushMicrotasks();

    expect(stemAudioContext.createdSources.length).toBeGreaterThan(0);
    const startCalls = stemAudioContext.createdSources.map(
      (source) => source.start.mock.calls[0],
    );
    startCalls.forEach((call) => {
      expect(call?.[0]).toBeCloseTo(2.035, 3);
      expect(call?.[1]).toBe(0);
    });
  });
});
