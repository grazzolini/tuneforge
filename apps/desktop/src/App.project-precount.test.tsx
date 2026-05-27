import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAudioByArtifactId,
  getMockAudioContexts,
  markAudioReady,
  resetAppTestHarness,
  renderApp,
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
