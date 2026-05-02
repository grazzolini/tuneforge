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
    await user.click(screen.getByRole("button", { name: "Increase pre-count clicks" }));

    expect(screen.getByLabelText("Enable pre-count")).toBeChecked();
    expect(screen.getByText("5 clicks at 120.0 BPM")).toBeInTheDocument();

    firstRender.unmount();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    expect(screen.getByLabelText("Enable pre-count")).toBeChecked();
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
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
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
