import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAppTestHarness,
  findAudioByArtifactId,
  markAudioReady,
  renderApp,
  setProjects,
} from "./test/appTestHarness";

describe("Desktop app background playback", () => {
  beforeEach(resetAppTestHarness);

  it("keeps background playback available on settings and clears it when stopped", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByText("Background Playback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause background playback" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset Appearance" }));
    expect(screen.getByRole("button", { name: "Pause background playback" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause background playback" }));
    expect(screen.getByText("Background Playback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play background playback" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop background playback" }));
    expect(screen.queryByText("Background Playback")).not.toBeInTheDocument();
  });

  it("reopens the active project from background playback without stopping playback", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByText("Background Playback")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Open Demo Song project" }));

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(screen.queryByText("Background Playback")).not.toBeInTheDocument();
  });

  it("stops background playback when opening a different project from the library", async () => {
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
    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await user.click(screen.getAllByRole("link", { name: "Library" })[0]);
    expect(await screen.findByText("Background Playback")).toBeInTheDocument();

    const secondProjectCard = screen.getByText("Bass Drill").closest("article");
    expect(secondProjectCard).not.toBeNull();
    await user.click(
      within(secondProjectCard as HTMLElement).getByRole("link", {
        name: "Open Bass Drill project",
      }),
    );

    expect(await screen.findByRole("heading", { name: "Bass Drill" })).toBeInTheDocument();
    expect(screen.queryByText("Background Playback")).not.toBeInTheDocument();
  });
});
