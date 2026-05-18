import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSchema, ProjectSchema } from "./lib/api";
import {
  mockCancelJob,
  mockListJobs,
  mockListProjects,
  renderApp,
  resetAppTestHarness,
  setJobs,
  setProjects,
} from "./test/appTestHarness";

function project(overrides: Partial<ProjectSchema>): Record<string, unknown> {
  return {
    id: "proj_123",
    display_name: "Demo Song",
    source_key_override: null,
    source_path: "/tmp/demo.wav",
    imported_path: "/tmp/projects/demo.wav",
    duration_seconds: 182,
    sample_rate: 44100,
    channels: 2,
    created_at: "2026-04-18T13:16:00.000Z",
    updated_at: "2026-04-18T13:16:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<JobSchema>): Record<string, unknown> {
  return {
    id: "job_1",
    project_id: "proj_123",
    type: "preview",
    status: "completed",
    progress: 100,
    error_message: null,
    created_at: "2026-04-18T13:16:00.000Z",
    updated_at: "2026-04-18T13:16:00.000Z",
    ...overrides,
  };
}

describe("Desktop app activity", () => {
  beforeEach(() => {
    resetAppTestHarness();
  });

  it("opens Activity from the sidebar with Jobs selected", async () => {
    const user = userEvent.setup();
    renderApp(["/"]);

    expect(await screen.findByRole("heading", { level: 1, name: "Practice Projects" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Activity" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Jobs" })).toHaveAttribute("aria-selected", "true");
    expect(mockListJobs).toHaveBeenCalled();
    expect(mockListProjects).toHaveBeenCalled();
  });

  it("shows project links and pending queue positions in queue order", async () => {
    setProjects([
      project({ id: "proj_1", display_name: "Ambient Wash" }),
      project({ id: "proj_2", display_name: "Bass Drill" }),
    ]);
    setJobs([
      job({
        id: "job_done",
        project_id: "proj_1",
        type: "lyrics",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:25:00.000Z",
        created_at: "2026-04-18T13:05:00.000Z",
        updated_at: "2026-04-18T13:25:00.000Z",
      }),
      job({
        id: "job_pending_2",
        project_id: null,
        type: "export",
        status: "pending",
        progress: 0,
        created_at: "2026-04-18T13:20:00.000Z",
        updated_at: "2026-04-18T13:20:00.000Z",
      }),
      job({
        id: "job_running",
        project_id: "proj_2",
        type: "stems",
        status: "running",
        progress: 42,
        stem_model: "htdemucs_6s",
        stem_model_label: "Default (6 stems model)",
        runtime_device: "mps",
        started_at: "2026-04-18T13:22:00.000Z",
        created_at: "2026-04-18T13:22:00.000Z",
        updated_at: "2026-04-18T13:23:00.000Z",
      }),
      job({
        id: "job_pending_1",
        project_id: "proj_1",
        type: "chords",
        status: "pending",
        progress: 0,
        chord_backend: "tuneforge-fast",
        chord_source: "source",
        created_at: "2026-04-18T13:10:00.000Z",
        updated_at: "2026-04-18T13:10:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const queue = await screen.findByRole("list", { name: "Job queue" });
    const rows = within(queue).getAllByRole("article");

    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "stems running job",
      "chords pending job",
      "export pending job",
      "lyrics completed job",
    ]);
    expect(within(rows[0]).getByRole("link", { name: "Open Bass Drill project" })).toHaveAttribute(
      "href",
      "/projects/proj_2",
    );
    expect(within(rows[0]).getByText("Default (6 stems model) / MPS")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "Open Ambient Wash project" })).toHaveAttribute(
      "href",
      "/projects/proj_1",
    );
    expect(within(rows[1]).getByText("Queue #1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("built-in / source")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Queue #2")).toBeInTheDocument();
    expect(within(rows[2]).getByText("No project")).toBeInTheDocument();
  });

  it("cancels pending jobs and refreshes the queue", async () => {
    const user = userEvent.setup();
    setJobs([
      job({
        id: "job_pending",
        type: "analyze",
        status: "pending",
        progress: 0,
        created_at: "2026-04-18T13:10:00.000Z",
        updated_at: "2026-04-18T13:10:00.000Z",
      }),
      job({
        id: "job_completed",
        type: "preview",
        status: "completed",
        progress: 100,
        completed_at: "2026-04-18T13:20:00.000Z",
        created_at: "2026-04-18T13:05:00.000Z",
        updated_at: "2026-04-18T13:20:00.000Z",
      }),
    ]);

    renderApp(["/activity"]);

    const pendingRow = await screen.findByRole("article", { name: "analyze pending job" });
    const completedRow = await screen.findByRole("article", { name: "preview completed job" });
    expect(within(completedRow).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    const initialListJobsCalls = mockListJobs.mock.calls.length;

    await user.click(within(pendingRow).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mockCancelJob).toHaveBeenCalledWith("job_pending"));
    await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(initialListJobsCalls));
    expect(await screen.findByRole("article", { name: "analyze cancelled job" })).toBeInTheDocument();
  });

  it("refreshes active jobs until they reach a terminal status", async () => {
    const intervalHandlers: Array<() => void | Promise<void>> = [];
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === 1500 && typeof handler === "function") {
          intervalHandlers.push(handler as () => void | Promise<void>);
          return 1500;
        }
        return 1;
      });
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

    try {
      setJobs([
        job({
          id: "job_running",
          project_id: "proj_123",
          type: "stems",
          status: "running",
          progress: 25,
          created_at: "2026-04-18T13:10:00.000Z",
          started_at: "2026-04-18T13:10:30.000Z",
          updated_at: "2026-04-18T13:11:00.000Z",
        }),
      ]);

      renderApp(["/activity"]);

      expect(await screen.findByRole("article", { name: "stems running job" })).toBeInTheDocument();
      expect(intervalHandlers).toHaveLength(1);
      const initialListJobsCalls = mockListJobs.mock.calls.length;

      setJobs([
        job({
          id: "job_running",
          project_id: "proj_123",
          type: "stems",
          status: "completed",
          progress: 100,
          completed_at: "2026-04-18T13:12:00.000Z",
          created_at: "2026-04-18T13:10:00.000Z",
          started_at: "2026-04-18T13:10:30.000Z",
          updated_at: "2026-04-18T13:12:00.000Z",
        }),
      ]);

      await act(async () => {
        await intervalHandlers[0]?.();
      });

      await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThan(initialListJobsCalls));
      const completedRow = await screen.findByRole("article", { name: "stems completed job" });
      expect(within(completedRow).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(clearIntervalSpy).toHaveBeenCalledWith(1500);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
