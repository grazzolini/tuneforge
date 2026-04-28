import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAudioByArtifactId,
  getMockAudioContexts,
  markAudioReady,
  resetAppTestHarness,
  renderApp,
  setProjectAnalysis,
  setProjects,
} from "./test/appTestHarness";

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
    expect(screen.getByLabelText("Follow project playback")).not.toBeChecked();
  });

  it("arms follow mode from query params", async () => {
    renderApp(["/tools?tool=metronome&bpm=121.5&projectId=proj_123&followPlayback=1"]);

    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tempo BPM")).toHaveValue(121.5);
    expect(screen.getByLabelText("Follow project playback")).toBeChecked();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("No project playback active")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByLabelText("Follow project playback"));

    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdOscillators.length).toBeGreaterThan(0),
    );
    const syncedContext = getMockAudioContexts()[0];
    const scheduledBeforePause = syncedContext?.createdOscillators.length ?? 0;

    await user.click(screen.getByRole("button", { name: "Pause background playback" }));
    await waitFor(() =>
      expect(screen.getAllByText("Waiting for Demo Song playback").length).toBeGreaterThan(0),
    );
    expect(syncedContext?.close).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Play background playback" }));
    await waitFor(() =>
      expect(syncedContext?.createdOscillators.length).toBeGreaterThan(scheduledBeforePause),
    );
  });

  it("keeps synced metronome armed when opening the playback project page", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("link", { name: "Tools" }));
    await user.click(await screen.findByRole("tab", { name: "Metronome" }));
    await user.click(screen.getByLabelText("Follow project playback"));
    await waitFor(() =>
      expect(getMockAudioContexts()[0]?.createdOscillators.length).toBeGreaterThan(0),
    );
    const syncedContext = getMockAudioContexts()[0];

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
