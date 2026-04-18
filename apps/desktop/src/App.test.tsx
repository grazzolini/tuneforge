import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "./App";

const { mockCreatePreview } = vi.hoisted(() => ({
  mockCreatePreview: vi.fn().mockResolvedValue({ job: { id: "job_preview" } }),
}));

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getHealth: vi.fn().mockResolvedValue({
        status: "ok",
        api_base_url: "http://127.0.0.1:8765/api/v1",
        data_root: "/tmp/tuneforge",
        default_export_format: "wav",
        preview_format: "wav",
      }),
      listProjects: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "proj_123",
            display_name: "Demo Song",
            source_path: "/tmp/demo.wav",
            imported_path: "/tmp/app/demo.wav",
            duration_seconds: 182,
            sample_rate: 44100,
            channels: 2,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      }),
      getProject: vi.fn().mockResolvedValue({
        project: {
          id: "proj_123",
          display_name: "Demo Song",
          source_path: "/tmp/demo.wav",
          imported_path: "/tmp/app/demo.wav",
          duration_seconds: 182,
          sample_rate: 44100,
          channels: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      getAnalysis: vi.fn().mockResolvedValue({
        analysis: {
          project_id: "proj_123",
          estimated_key: "G major",
          key_confidence: 0.82,
          estimated_reference_hz: 431.9,
          tuning_offset_cents: -32,
          tempo_bpm: null,
          analysis_version: "v1",
          created_at: new Date().toISOString(),
        },
      }),
      listArtifacts: vi.fn().mockResolvedValue({
        artifacts: [
          {
            id: "art_source",
            project_id: "proj_123",
            type: "source_audio",
            format: "wav",
            path: "/tmp/demo.wav",
            metadata: {},
            created_at: new Date().toISOString(),
          },
        ],
      }),
      listJobs: vi.fn().mockResolvedValue({
        jobs: [
          {
            id: "job_1",
            project_id: "proj_123",
            type: "preview",
            status: "running",
            progress: 60,
            error_message: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      }),
      createPreview: mockCreatePreview,
      analyzeProject: vi.fn().mockResolvedValue({ job: { id: "job_analyze" } }),
      updateProject: vi.fn().mockResolvedValue({
        project: {
          id: "proj_123",
          display_name: "Renamed Demo",
          source_path: "/tmp/demo.wav",
          imported_path: "/tmp/app/demo.wav",
          duration_seconds: 182,
          sample_rate: 44100,
          channels: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
      createExport: vi.fn().mockResolvedValue({ job: { id: "job_export" } }),
      deleteProject: vi.fn().mockResolvedValue({ deleted: true }),
      cancelJob: vi.fn().mockResolvedValue({ job: { id: "job_1", status: "cancelled" } }),
    },
  };
});

function renderApp(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    mockCreatePreview.mockClear();
  });

  it("renders the library view", async () => {
    renderApp(["/"]);
    expect(await screen.findByText("Practice Projects")).toBeInTheDocument();
    expect(await screen.findByText("Demo Song")).toBeInTheDocument();
  });

  it("renders the project detail state", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByText("Transform Controls")).toBeInTheDocument();
    expect(await screen.findByText("Detected Tuning")).toBeInTheDocument();
    expect(await screen.findByText("running")).toBeInTheDocument();

    const currentKey = await screen.findByLabelText("Current Key");
    const targetKey = await screen.findByLabelText("Target Key");
    const updatePreviewButton = screen.getByRole("button", { name: "Update Preview" });
    expect(currentKey).toHaveValue("auto");
    expect(targetKey).toHaveValue("7:major");
    expect(screen.getByText("Shift 0 semitones")).toBeInTheDocument();
    expect(updatePreviewButton).toBeDisabled();

    await user.click(screen.getByLabelText("Raise target key"));

    expect(targetKey).toHaveValue("8:major");
    expect(screen.getByText("Shift +1 semitone")).toBeInTheDocument();
    expect(updatePreviewButton).toBeEnabled();

    await user.click(screen.getByText("Correct source key if detection is wrong"));
    await user.selectOptions(currentKey, "9:major");

    expect(targetKey).toHaveValue("8:major");
    expect(screen.getByText("Shift -1 semitone")).toBeInTheDocument();
    expect(updatePreviewButton).toBeEnabled();

    await user.click(updatePreviewButton);

    expect(mockCreatePreview).toHaveBeenCalledWith(
      "proj_123",
      expect.objectContaining({
        output_format: "wav",
        transpose: { semitones: -1 },
      }),
    );
  });

  it("renders the settings view", async () => {
    renderApp(["/settings"]);
    expect(await screen.findByText("Backend and Storage")).toBeInTheDocument();
    expect(await screen.findByText("/tmp/tuneforge")).toBeInTheDocument();
  });

  it("defaults to dark theme and persists theme changes", async () => {
    const user = userEvent.setup();
    renderApp(["/settings"]);

    const themeSelect = await screen.findByLabelText("Theme");
    expect(themeSelect).toHaveValue("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("dark");

    await user.selectOptions(themeSelect, "light");

    expect(themeSelect).toHaveValue("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("tuneforge.theme-preference")).toBe("light");
  });
});
