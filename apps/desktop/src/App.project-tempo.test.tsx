import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAudioByArtifactId,
  getMockAudioContexts,
  markAudioReady,
  mockCreateExport,
  mockCreatePreview,
  mockCreateStems,
  renderApp,
  resetAppTestHarness,
  setAudioPlaybackState,
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

function setPlaybackPosition(value: string) {
  fireEvent.change(screen.getByLabelText("Playback position"), { target: { value } });
}

describe("Desktop app project playback tempo", () => {
  beforeEach(resetAppTestHarness);

  it("persists whole-BPM tempo changes and reset without creating audio files", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis();
    const firstRender = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const { group, section } = tempoControl();

    expect(within(section).getByText("Original 123.5 BPM")).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Decrease playback tempo" }));

    expect(within(section).getByText("123 BPM (0.996x)")).toBeInTheDocument();
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

  it("keeps source and practice mix switching on the streamed media path when tempo is changed", async () => {
    const user = userEvent.setup();
    setupTempoAnalysis(120);
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
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
    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));

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
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));
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
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openStudioPanel(user);
    await user.click(screen.getByRole("button", { name: "Generate Stems" }));
    await openPlaybackWorkspace(user);

    const stemList = await screen.findByRole("group", { name: "Playback stem list" });
    await user.click(within(stemList).getAllByRole("button", { name: /Vocals/i })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Decrease playback tempo" }));

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
