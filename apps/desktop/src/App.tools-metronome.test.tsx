import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceMockAnimationFrames,
  findAudioByArtifactId,
  emitMockNativeAudioCue,
  emitMockSystemMediaPlaybackControl,
  getMockAudioContexts,
  getMockInvoke,
  markAudioReady,
  resetAppTestHarness,
  renderApp,
  setMockNativeAudioState,
  setProjectAnalysis,
  setProjects,
} from "./test/appTestHarness";

function getMetronomeAudioContext() {
  return getMockAudioContexts().find((context) => context.createdOscillators.length > 0);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
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

const timingAnalysis = {
  project_id: "proj_123",
  estimated_key: "G major",
  key_confidence: 0.82,
  estimated_reference_hz: 440,
  tuning_offset_cents: 0,
  tempo_bpm: 60,
  analysis_version: "v3",
  created_at: "2026-04-18T13:16:00.000Z",
  timing: {
    beats_per_bar: 4,
    source: "detected",
    beats: [
      { index: 0, seconds: 0, bar_index: 0, beat_in_bar: 1 },
      { index: 1, seconds: 0.12, bar_index: 0, beat_in_bar: 2 },
      { index: 2, seconds: 0.24, bar_index: 0, beat_in_bar: 3 },
      { index: 3, seconds: 0.36, bar_index: 0, beat_in_bar: 4 },
      { index: 4, seconds: 0.48, bar_index: 1, beat_in_bar: 1 },
      { index: 5, seconds: 0.62, bar_index: 1, beat_in_bar: 2 },
    ],
    bars: [
      { index: 0, start_seconds: 0, end_seconds: 0.48 },
      { index: 1, start_seconds: 0.48, end_seconds: 1 },
    ],
  },
};

describe("Desktop app tools metronome", () => {
  beforeEach(resetAppTestHarness);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the metronome tab from query params with seeded BPM", async () => {
    renderApp(["/tools?tool=metronome&bpm=121.5&projectId=proj_123"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Metronome" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(121.5);
    expect(screen.getByText("Seeded from project analysis.")).toBeInTheDocument();
    expect(screen.getByLabelText("Beats per bar")).toHaveValue(4);
    expect(screen.getByLabelText("Accent first beat")).toBeChecked();
    expect(screen.getByLabelText("Follow project playback")).toBeChecked();
  });

  it("arms follow mode from query params", async () => {
    renderApp(["/tools?tool=metronome&bpm=121.5&projectId=proj_123&followPlayback=1"]);

    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(121.5);
    expect(screen.getByLabelText("Follow project playback")).toBeChecked();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getAllByText("Free-running at 121.5 BPM").length).toBeGreaterThan(0);
  });

  it("describes idle follow and free-running modes truthfully", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));

    expect(screen.getAllByText("Ready at 100.0 BPM").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getAllByText(
      "Free-running at 100.0 BPM · follows Demo Song when playback starts",
    ).length).toBeGreaterThan(0);
    await user.click(screen.getByLabelText("Follow project playback"));
    expect(screen.getAllByText("Free-running at 100.0 BPM").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getAllByText("Ready at 100.0 BPM").length).toBeGreaterThan(0);
  });

  it("updates tempo from the tap pad", async () => {
    const nowSpy = vi.spyOn(performance, "now");
    renderApp(["/tools?tool=metronome&bpm=90"]);

    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    const tapPad = screen.getByRole("button", { name: /Tap Tempo/i });
    nowSpy.mockReturnValue(0);
    fireEvent.click(tapPad);
    nowSpy.mockReturnValue(500);
    fireEvent.click(tapPad);

    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(120);
    expect(screen.getByText("120.0 BPM")).toBeInTheDocument();
  });

  it("starts and stops generated click playback", async () => {
    const user = userEvent.setup();
    renderApp(["/tools?tool=metronome"]);

    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(100);
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdOscillators.length).toBeGreaterThan(0),
    );
    expect(getMockAudioContexts()[0]?.createdOscillators[0]?.start).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(getMockAudioContexts()[0]?.close).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("shows volume percentage and double-click resets volume to 80 percent", async () => {
    const user = userEvent.setup();
    renderApp(["/tools?tool=metronome"]);

    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Metronome volume 80%" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Metronome volume"), { target: { value: "0.42" } });

    expect(screen.getByRole("button", { name: "Metronome volume 42%" })).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Metronome volume 42%" }));

    expect(screen.getByLabelText("Metronome volume")).toHaveValue("0.8");
    expect(screen.getByRole("button", { name: "Metronome volume 80%" })).toBeInTheDocument();
  });

  it("opens from the project analysis tempo action", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "G major",
      key_confidence: 0.82,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: 121.48,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Analysis" }));
    await user.click(screen.getByRole("link", { name: "Follow on metronome at 121.5 BPM" }));

    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Metronome" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(121.5);
    expect(screen.getByLabelText("Follow project playback")).toBeChecked();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("follows active project playback when sync is enabled", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    const playbackPosition = screen.getByLabelText("Playback position");
    fireEvent.change(playbackPosition, { target: { value: "0.49" } });
    expect(playbackPosition).toHaveValue("0.49");
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Following Demo Song playback").length).toBeGreaterThan(0));
    act(() => {
      advanceMockAnimationFrames();
    });

    await waitFor(() =>
      expect(getMetronomeAudioContext()?.createdOscillators.length).toBeGreaterThan(0),
    );
    const syncedContext = getMetronomeAudioContext();
    const scheduledBeforePause = syncedContext?.createdOscillators.length ?? 0;

    await user.click(screen.getByRole("button", { name: "Pause background playback" }));
    await waitFor(() =>
      expect(screen.getAllByText(
        "Free-running at 100.0 BPM · follows Demo Song when playback starts",
      ).length).toBeGreaterThan(0),
    );
    act(() => {
      advanceMockAnimationFrames();
    });
    expect(syncedContext?.close).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(syncedContext?.createdOscillators.length).toBeGreaterThan(scheduledBeforePause),
    );
    const scheduledDuringPause = syncedContext?.createdOscillators.length ?? 0;

    await user.click(screen.getByRole("button", { name: "Play background playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause background playback" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getAllByText("Following Demo Song playback").length).toBeGreaterThan(0));
    act(() => {
      advanceMockAnimationFrames();
    });
    await waitFor(() =>
      expect(syncedContext?.createdOscillators.length).toBeGreaterThan(scheduledDuringPause),
    );
  });

  it("schedules followed clicks from analysis timing when available", async () => {
    const user = userEvent.setup();
    setProjectAnalysis("proj_123", timingAnalysis);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    const playbackPosition = screen.getByLabelText("Playback position");
    fireEvent.change(playbackPosition, { target: { value: "0.45" } });
    expect(playbackPosition).toHaveValue("0.45");
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Following Demo Song playback").length).toBeGreaterThan(0));
    act(() => {
      advanceMockAnimationFrames();
    });

    await waitFor(() => {
      const frequencies =
        getMetronomeAudioContext()?.createdOscillators.flatMap((oscillator) =>
          oscillator.frequency.setValueAtTime.mock.calls.map((call) => call[0]),
        ) ?? [];
      expect(frequencies).toContain(1760);
    });
  });

  it("schedules normal-Tauri follow cues with the project control tuple", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setMockNativeAudioState({ capabilities: {
      nativePlaybackSupported: true, fallbackRequired: false,
      fallbackReason: null, backend: "desktop-cpal",
    } });
    setProjectAnalysis("proj_123", timingAnalysis);
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name]) => name === "audio_play")).toBe(true));
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => {
      const call = getMockInvoke().mock.calls.find(([name]) => name === "audio_schedule_cues");
      const payload = (call?.[1] as { payload?: { cues?: unknown[] } })?.payload;
      expect(payload).toMatchObject({
        leaseId: "project-playback", generation: 1, timelineRevision: 1,
      });
      expect(payload?.cues?.[0]).toMatchObject({
        kind: "metronome", positionSeconds: 0, accent: true, gain: 0.8,
      });
    });
    expect(getMockAudioContexts()).toHaveLength(0);
    act(() => emitMockNativeAudioCue({
      generation: 1, revision: 1, cueIndex: 0, kind: "metronome",
      accent: true, gain: 0.8, scheduledNativeTimeUs: 10,
      actualNativeTimeUs: 10, insertionSequence: 1,
    }));
    const initialPlayCount = getMockInvoke().mock.calls.filter(([name]) => name === "audio_play").length;
    act(() => emitMockSystemMediaPlaybackControl({ action: "pause" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name]) => name === "audio_pause")).toBe(true));
    act(() => emitMockSystemMediaPlaybackControl({ action: "play" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_play")).toHaveLength(initialPlayCount + 1));
    expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues")).toHaveLength(1);
    const resumeCalls = getMockInvoke().mock.calls.filter(([name]) => name === "audio_play");
    const resumePayload = (resumeCalls[resumeCalls.length - 1]?.[1] as {
      payload?: { startTimeSeconds?: number | null; metronomeCues?: Array<{ positionSeconds: number }> };
    })?.payload;
    expect(resumePayload?.startTimeSeconds).toBe(0);
    expect(resumePayload?.metronomeCues?.[0]?.positionSeconds).toBe(0);

    let scheduleCount = 1;
    await user.clear(screen.getByLabelText("Tempo BPM"));
    await user.type(screen.getByLabelText("Tempo BPM"), "90{Enter}");
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length).toBeGreaterThan(scheduleCount));
    scheduleCount = getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length;
    fireEvent.change(screen.getByLabelText("Beats per bar"), { target: { value: "3" } });
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length).toBeGreaterThan(scheduleCount));
    scheduleCount = getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length;
    await user.click(screen.getByLabelText("Accent first beat"));
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length).toBeGreaterThan(scheduleCount));
    scheduleCount = getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length;
    fireEvent.change(screen.getByLabelText("Metronome volume"), { target: { value: "0.42" } });
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_schedule_cues").length).toBeGreaterThan(scheduleCount));
    const replacement = [...getMockInvoke().mock.calls].reverse().find(([name]) => name === "audio_schedule_cues");
    expect((replacement?.[1] as { payload?: { cues?: Array<{ accent: boolean; gain: number }> } })
      ?.payload?.cues?.[0]).toMatchObject({ accent: false, gain: 0.42 });

    await user.click(screen.getByLabelText("Follow project playback"));
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name, args]) =>
      name === "audio_cancel_cues" && (args as { kind?: string })?.kind === "metronome",
    )).toBe(true));
    const [schedule, cancel] = ["audio_schedule_cues", "audio_cancel_cues"].map((name) =>
      (getMockInvoke().mock.calls.find(([command]) => command === name)?.[1] as {
        payload?: { operationId?: string };
      })?.payload?.operationId,
    );
    expect(cancel).not.toBe(schedule);
    act(() => emitMockSystemMediaPlaybackControl({ action: "pause" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_pause")).toHaveLength(2));
    act(() => emitMockSystemMediaPlaybackControl({ action: "play" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.filter(([name]) => name === "audio_play")).toHaveLength(initialPlayCount + 2));
    const disabledCalls = getMockInvoke().mock.calls.filter(([name]) => name === "audio_play");
    expect((disabledCalls[disabledCalls.length - 1]?.[1] as {
      payload?: { metronomeCues?: unknown };
    })?.payload?.metronomeCues).toBeUndefined();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("serializes rapid native settings and stop using the latest revision", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setMockNativeAudioState({ capabilities: {
      nativePlaybackSupported: true, fallbackRequired: false,
      fallbackReason: null, backend: "desktop-cpal",
    } });
    const firstStart = createDeferred<{
      enabled: boolean; bpm: number; beatsPerBar: number; accentFirstBeat: boolean;
      gain: number; followPlayback: boolean; leaseId: string; generation: number;
      revision: number; nativeTimeUs: number;
    }>();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    let standaloneInvocationCount = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_set_standalone_metronome" && standaloneInvocationCount++ === 0) {
        return firstStart.promise;
      }
      return originalInvoke(command, args);
    });
    const user = userEvent.setup();
    renderApp(["/tools?tool=metronome"]);
    await screen.findByRole("heading", { name: "Metronome" });

    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(standaloneInvocationCount).toBe(1));
    fireEvent.change(screen.getByLabelText("Tempo BPM"), { target: { value: "140" } });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(standaloneInvocationCount).toBe(1);

    await act(async () => firstStart.resolve({
      enabled: true, bpm: 100, beatsPerBar: 4, accentFirstBeat: true,
      gain: 0.8, followPlayback: true, leaseId: "standalone-metronome",
      generation: 1, revision: 1, nativeTimeUs: 1,
    }));
    await waitFor(() => expect(standaloneInvocationCount).toBe(2));
    const standaloneCalls = invoke.mock.calls.filter(
      ([command]) => command === "audio_set_standalone_metronome",
    );
    expect(standaloneCalls).toHaveLength(2);
    expect(standaloneCalls[1]?.[1]).toMatchObject({ payload: {
      enabled: false,
      bpm: 140,
      generation: 1,
      timelineRevision: 1,
    } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument());
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("reconciles a failed native settings update by stopping the active metronome", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setMockNativeAudioState({ capabilities: {
      nativePlaybackSupported: true, fallbackRequired: false,
      fallbackReason: null, backend: "desktop-cpal",
    } });
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const user = userEvent.setup();
    renderApp(["/tools?tool=metronome"]);
    await screen.findByRole("heading", { name: "Metronome" });
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(invoke.mock.calls.filter(
      ([command]) => command === "audio_set_standalone_metronome",
    ).length).toBeGreaterThanOrEqual(2));

    let rejectNextUpdate = true;
    invoke.mockImplementation(async (command, args) => {
      const enabled = (args as { payload?: { enabled?: boolean } } | undefined)?.payload?.enabled;
      if (command === "audio_set_standalone_metronome" && enabled && rejectNextUpdate) {
        rejectNextUpdate = false;
        throw new Error("stale_timeline_revision");
      }
      return originalInvoke(command, args);
    });
    fireEvent.change(screen.getByLabelText("Metronome volume"), { target: { value: "0.5" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument());
    const lastStandaloneCall = [...invoke.mock.calls].reverse().find(
      ([command]) => command === "audio_set_standalone_metronome",
    );
    expect(lastStandaloneCall?.[1]).toMatchObject({ payload: { enabled: false } });
    expect(screen.getByText(/stopping it safely/)).toBeInTheDocument();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("replaces followed cues from the authoritative completed native seek position", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setMockNativeAudioState({ capabilities: {
      nativePlaybackSupported: true, fallbackRequired: false,
      fallbackReason: null, backend: "desktop-cpal",
    } });
    setProjectAnalysis("proj_123", timingAnalysis);
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name]) => name === "audio_schedule_cues")).toBe(true));
    await user.click(screen.getByRole("link", { name: "Open Demo Song project" }));
    await user.click(screen.getByRole("tab", { name: "Playback" }));

    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    const preparedSessionId = latestNativeSessionId();
    let authoritativePosition = 0.48;
    invoke.mockImplementation(async (command, args) => command === "audio_seek" ? {
      sessionId: preparedSessionId, state: "playing", positionSeconds: authoritativePosition,
      durationSeconds: 182, playbackRate: 1, nativePlaybackSupported: true,
      fallbackReason: null, lanes: [], bufferHealth: [], leaseId: "project-playback",
      generation: 1, timelineRevision: 2, nativeTimeUs: 10,
    } : originalInvoke!(command, args));
    const beforeSeek = invoke.mock.calls.filter(([name]) => name === "audio_schedule_cues").length;
    fireEvent.change(screen.getByLabelText("Playback position"), { target: { value: "0.2" } });
    await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "audio_schedule_cues")).toHaveLength(beforeSeek + 1));
    const replacement = [...invoke.mock.calls].reverse().find(([name]) => name === "audio_schedule_cues");
    const replacementPayload = (replacement?.[1] as {
      payload?: { timelineRevision?: number; cues?: Array<{ positionSeconds: number }> };
    })?.payload;
    expect(replacementPayload?.timelineRevision).toBe(2);
    expect(replacementPayload?.cues?.[0]?.positionSeconds).toBe(0.48);
    authoritativePosition = 2;
    const beforeEmptySeek = invoke.mock.calls.filter(([name]) => name === "audio_cancel_cues").length;
    fireEvent.change(screen.getByLabelText("Playback position"), { target: { value: "0.3" } });
    await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "audio_cancel_cues")).toHaveLength(beforeEmptySeek + 1));
    const cancel = [...invoke.mock.calls].reverse().find(([name]) => name === "audio_cancel_cues");
    expect(cancel?.[1]).toMatchObject({ kind: "metronome", payload: { timelineRevision: 2 } });
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("ignores a native seek snapshot from a mismatched session", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setMockNativeAudioState({ capabilities: {
      nativePlaybackSupported: true, fallbackRequired: false,
      fallbackReason: null, backend: "desktop-cpal",
    } });
    setProjectAnalysis("proj_123", timingAnalysis);
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name]) => name === "audio_schedule_cues")).toBe(true));
    await user.click(screen.getByRole("link", { name: "Open Demo Song project" }));
    await user.click(screen.getByRole("tab", { name: "Playback" }));

    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => command === "audio_seek" ? {
      sessionId: "mismatched-session", state: "playing", positionSeconds: 48,
      durationSeconds: 182, playbackRate: 1, nativePlaybackSupported: true,
      fallbackReason: null, lanes: [], bufferHealth: [], leaseId: "project-playback",
      generation: 1, timelineRevision: 2, nativeTimeUs: 10,
    } : originalInvoke!(command, args));
    const scheduleCount = invoke.mock.calls.filter(([name]) => name === "audio_schedule_cues").length;
    const cancelCount = invoke.mock.calls.filter(([name]) => name === "audio_cancel_cues").length;
    fireEvent.change(screen.getByLabelText("Playback position"), { target: { value: "0.2" } });
    await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "audio_seek")).toHaveLength(1));
    await act(async () => Promise.resolve());

    expect(invoke.mock.calls.filter(([name]) => name === "audio_schedule_cues")).toHaveLength(scheduleCount);
    expect(invoke.mock.calls.filter(([name]) => name === "audio_cancel_cues")).toHaveLength(cancelCount);
    expect(readPlaybackE2ETelemetry().positionSeconds).not.toBe(48);
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("serializes followed cue updates behind an in-flight native seek", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setMockNativeAudioState({ capabilities: {
      nativePlaybackSupported: true, fallbackRequired: false,
      fallbackReason: null, backend: "desktop-cpal",
    } });
    setProjectAnalysis("proj_123", timingAnalysis);
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    await screen.findByRole("heading", { name: "Demo Song" });
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(getMockInvoke().mock.calls.some(([name]) => name === "audio_play")).toBe(true));

    const preparedSessionId = latestNativeSessionId();
    const seek = createDeferred<{
      sessionId: string;
      state: "playing";
      positionSeconds: number;
      durationSeconds: number;
      playbackRate: number;
      nativePlaybackSupported: boolean;
      fallbackReason: null;
      lanes: never[];
      bufferHealth: never[];
      leaseId: string;
      generation: number;
      timelineRevision: number;
      nativeTimeUs: number;
    }>();
    const sessionSnapshot = {
      resource: "output" as const, source: "project_playback" as const,
      status: "output" as const, owner: "playback" as const,
      leaseId: "project-playback", generation: 1, timelineRevision: 2,
      nativeTimeUs: 1, positionSeconds: 0.48, playbackRate: 1,
      availabilityReason: null, terminalDiagnostic: null,
    };
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_seek") return seek.promise;
      if (command === "audio_schedule_cues" || command === "audio_cancel_cues") return sessionSnapshot;
      return originalInvoke!(command, args);
    });

    fireEvent.change(screen.getByLabelText("Playback position"), { target: { value: "0.2" } });
    await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "audio_seek")).toHaveLength(1));
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(invoke.mock.calls.filter(([name]) => name === "audio_schedule_cues")).toHaveLength(0);

    await act(async () => seek.resolve({
      sessionId: preparedSessionId, state: "playing", positionSeconds: 0.48,
      durationSeconds: 182, playbackRate: 1, nativePlaybackSupported: true,
      fallbackReason: null, lanes: [], bufferHealth: [], leaseId: "project-playback",
      generation: 1, timelineRevision: 2, nativeTimeUs: 10,
    }));
    await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "audio_schedule_cues")).toBe(true));
    for (const call of invoke.mock.calls.filter(([name]) => name === "audio_schedule_cues")) {
      expect(call[1]).toMatchObject({ payload: { timelineRevision: 2 } });
    }
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("keeps synced metronome armed when opening the playback project page", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    const playbackPosition = screen.getByLabelText("Playback position");
    fireEvent.change(playbackPosition, { target: { value: "0.49" } });
    expect(playbackPosition).toHaveValue("0.49");
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Following Demo Song playback").length).toBeGreaterThan(0));
    act(() => {
      advanceMockAnimationFrames();
    });
    await waitFor(() =>
      expect(getMetronomeAudioContext()?.createdOscillators.length).toBeGreaterThan(0),
    );
    const syncedContext = getMetronomeAudioContext();

    await user.click(screen.getByRole("link", { name: "Open Demo Song project" }));

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Metronome" })).not.toBeInTheDocument();
    expect(syncedContext?.close).not.toHaveBeenCalled();

    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));

    expect(screen.getByLabelText("Follow project playback")).toBeChecked();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(syncedContext?.close).not.toHaveBeenCalled();
  });

  it("updates followed metronome BPM from the next opened project analysis", async () => {
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
    setProjectAnalysis("proj_123", {
      project_id: "proj_123",
      estimated_key: "G major",
      key_confidence: 0.82,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: 121.48,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });
    setProjectAnalysis("proj_456", {
      project_id: "proj_456",
      estimated_key: "A minor",
      key_confidence: 0.74,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: 88.76,
      analysis_version: "v1",
      created_at: "2026-04-18T13:16:00.000Z",
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Analysis" }));
    await user.click(screen.getByRole("link", { name: "Follow on metronome at 121.5 BPM" }));
    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(121.5);
    expect(screen.getByLabelText("Follow project playback")).toBeChecked();

    await user.click(screen.getByRole("link", { name: "Library" }));
    await user.click(await screen.findByRole("link", { name: "Open Bass Drill project" }));

    expect(await screen.findByRole("heading", { name: "Bass Drill" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));

    await waitFor(() => expect(screen.getByLabelText("Tempo BPM")).toHaveValue(88.8));
    expect(screen.getByLabelText("Follow project playback")).toBeChecked();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });
});
