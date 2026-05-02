import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetAppTestHarness,
  mockDeleteProject,
  mockGetProject,
  mockImportProject,
  mockListProjects,
  mockOpen,
  renderApp,
  setChordBackends,
  setProjects,
} from "./test/appTestHarness";

describe("Desktop app library", () => {
  beforeEach(resetAppTestHarness);

  it("filters library results with project search", async () => {
    const user = userEvent.setup();
    setProjects([
      {
        id: "proj_1",
        display_name: "Choir Warmup",
        source_path: "/tmp/choir-warmup.wav",
        imported_path: "/tmp/projects/choir-warmup.wav",
        duration_seconds: 95,
        sample_rate: 44100,
        channels: 2,
        created_at: "2026-04-18T13:16:00.000Z",
        updated_at: "2026-04-18T13:16:00.000Z",
      },
      {
        id: "proj_2",
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

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search projects"), "choir");

    await waitFor(() => expect(mockListProjects).toHaveBeenLastCalledWith("choir"));
    expect(screen.getByText("Choir Warmup")).toBeInTheDocument();
    expect(screen.queryByText("Bass Drill")).not.toBeInTheDocument();
  });

  it("renders project cards with local timestamps and without filename subtitles", async () => {
    const updatedAt = "2026-04-21T02:59:00.000000";

    setProjects([
      {
        id: "proj_1",
        display_name: "Birds",
        source_path: "/tmp/Birds [Sa-dxgZt4rY].webm",
        imported_path: "/tmp/projects/birds.webm",
        duration_seconds: 219,
        sample_rate: 44100,
        channels: 2,
        created_at: updatedAt,
        updated_at: updatedAt,
      },
    ]);

    renderApp(["/"]);

    const localizedUpdatedAt = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(Date.UTC(2026, 3, 21, 2, 59, 0, 0)));

    const projectCard = (await screen.findByRole("heading", { name: "Birds", level: 2 })).closest(
      "article",
    );
    expect(projectCard).not.toBeNull();
    const timestamp = within(projectCard as HTMLElement).getByText(localizedUpdatedAt);
    expect(timestamp).toBeInTheDocument();
    expect(within(projectCard as HTMLElement).queryByText(/Updated/i)).not.toBeInTheDocument();
    expect(within(projectCard as HTMLElement).queryByText("Open project")).not.toBeInTheDocument();

    const timeElement = timestamp.closest("time");
    expect(timeElement).toHaveAttribute("dateTime", "2026-04-21T02:59:00.000Z");

    const openLink = within(projectCard as HTMLElement).getByRole("link", {
      name: "Open Birds project",
    });
    expect(within(openLink).queryByText(/\[Sa-dxgZt4rY\]\.webm/i)).not.toBeInTheDocument();
  });

  it("imports track from library and opens project", async () => {
    const user = userEvent.setup();
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      chord_backend: "tuneforge-fast",
    });
    await waitFor(() =>
      expect(mockGetProject).toHaveBeenCalledWith(expect.stringMatching(/^proj_/)),
    );
    expect(await screen.findByRole("heading", { name: "New Song" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Inspector" })).toBeInTheDocument();
  });

  it("uses the selected default chord backend when importing a track", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultChordBackend: "crema-advanced", defaultSourcesRailCollapsed: false }),
    );
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      chord_backend: "crema-advanced",
    });
  });

  it("falls back to built-in chords when importing with unavailable advanced chords", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultChordBackend: "crema-advanced", defaultSourcesRailCollapsed: false }),
    );
    setChordBackends([
      {
        availability: "available",
        available: true,
        capabilities: {},
        desktopOnly: false,
        experimental: false,
        id: "tuneforge-fast",
        label: "Built-in Chords",
        unavailable_reason: null,
      },
      {
        availability: "unavailable",
        available: false,
        capabilities: {},
        desktopOnly: true,
        experimental: true,
        id: "crema-advanced",
        label: "Advanced Chords",
        unavailable_reason: "crema is not installed",
      },
    ]);
    mockOpen.mockResolvedValue("/tmp/new-song.mp4");

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import Track" }));

    expect(mockImportProject).toHaveBeenCalledWith({
      source_path: "/tmp/new-song.mp4",
      copy_into_project: true,
      chord_backend: "tuneforge-fast",
      chord_backend_fallback_from: "crema-advanced",
    });
  });

  it("deletes project after confirmation and returns to library", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const showInspectorButton = screen.queryByRole("button", { name: "Show Inspector" });
    if (showInspectorButton) {
      await user.click(showInspectorButton);
    }
    await user.click(screen.getByRole("tab", { name: "Analysis" }));
    await user.click(screen.getByRole("button", { name: "Delete Project" }));

    expect(mockDeleteProject).toHaveBeenCalledWith("proj_123");
    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
  });
});
