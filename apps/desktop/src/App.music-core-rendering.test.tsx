import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as core from "@tuneforge/music-core";
import {
  findAudioByArtifactId, markAudioReady, renderApp, resetAppTestHarness, setProjectChords,
} from "./test/appTestHarness";

beforeEach(resetAppTestHarness);
afterEach(() => vi.restoreAllMocks());

async function renderSyntheticPlayback() {
  const timeline = Array.from({ length: 300 }, (_, index) => ({
    start_seconds: index * 0.5, end_seconds: (index + 1) * 0.5,
    label: "C", confidence: 1, pitch_class: 0, quality: "major",
  }));
  setProjectChords("proj_123", {
    project_id: "proj_123", backend: "librosa", source_artifact_id: "art_source",
    source_segments: timeline, timeline, has_user_edits: false,
    created_at: "2026-04-18T13:16:00Z", updated_at: "2026-04-18T13:16:00Z",
  });
  // The normal harness initializes real WASM; this spy delegates every call to that client.
  const spy = vi.spyOn(core, "callMusicCore");
  renderApp(["/projects/proj_123"]);
  await screen.findByRole("heading", { name: "Demo Song" });
  const audio = findAudioByArtifactId("art_source");
  markAudioReady(audio);
  fireEvent.click(screen.getByRole("tab", { name: "Playback" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play playback" })); });
  expect(document.querySelectorAll(".lead-sheet-chord")).toHaveLength(300);
  spy.mockClear();
  return { audio, spy };
}

it("reuses 300 synthetic chord labels while active playback highlights advance", async () => {
  const { audio, spy } = await renderSyntheticPlayback();
  for (let tick = 0; tick < 5; tick++) {
    await act(async () => {
      audio.currentTime = (tick + 1) * 0.5;
      fireEvent.timeUpdate(audio);
    });
    expect(document.querySelectorAll(".lead-sheet-chord--active")).toHaveLength(1);
    expect(document.querySelectorAll(".lead-sheet-chord")[tick + 1]).toHaveClass("lead-sheet-chord--active");
  }
  const formattingOperations = new Set(["isSupportedChordQuality", "formatChordDisplay", "formatKeyDisplay"]);
  expect(spy.mock.calls.filter(([request]) => formattingOperations.has(request.operation))).toHaveLength(0);

});

it("opens settings while 300 synthetic chords keep receiving raw playback clock events", async () => {
  const { audio } = await renderSyntheticPlayback();
  // Raw events preserve concurrent navigation scheduling; act would force it to flush.
  let ticks = 0;
  let clickTick: number | null = null;
  let finishObservation: () => void = () => {};
  const observed = new Promise<void>((resolve) => { finishObservation = resolve; });
  const clock = window.setInterval(() => {
    audio.currentTime += 0.04;
    audio.dispatchEvent(new Event("timeupdate"));
    ticks++;
    if (clickTick !== null && ticks >= clickTick + 3) finishObservation();
  }, 40);
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(ticks).toBeGreaterThan(0);
    clickTick = ticks;
    screen.getByRole("link", { name: "Settings" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    await observed;
    expect(ticks).toBeGreaterThanOrEqual(clickTick + 3);
    expect(screen.getByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause background playback" })).toBeInTheDocument();
  } finally {
    window.clearInterval(clock);
  }
});
