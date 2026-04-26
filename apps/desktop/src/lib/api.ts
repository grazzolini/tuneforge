import createClient from "openapi-fetch";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { components, MobileCapabilities, paths } from "@tuneforge/shared-types";

const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8765";
let apiBaseUrl = DEFAULT_API_BASE_URL;
let runtimeInitPromise: Promise<string> | null = null;

type ErrorResponse = {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
};
type ValidationErrorResponse = {
  detail?: Array<{
    loc: Array<string | number>;
    msg: string;
    type: string;
    input?: unknown;
    ctx?: Record<string, unknown>;
  }>;
};
export type HealthResponse = components["schemas"]["HealthResponse"];
export type ProjectSchema = components["schemas"]["ProjectSchema"];
export type AnalysisSchema = components["schemas"]["AnalysisSchema"];
export type AnalysisResponse = components["schemas"]["AnalysisResponse"];
export type ChordResponse = components["schemas"]["ChordResponse"];
export type ChordSegmentSchema = components["schemas"]["ChordSegmentSchema"];
export type LyricsResponse = components["schemas"]["LyricsResponse"];
export type LyricsSegmentSchema = components["schemas"]["LyricsSegmentSchema"];
export type LyricsWordSchema = components["schemas"]["LyricsWordSchema"];
export type ArtifactSchema = components["schemas"]["ArtifactSchema"];
export type JobSchema = components["schemas"]["JobSchema"];
export type PreviewRequest = components["schemas"]["PreviewRequest"];
export type RetuneRequest = components["schemas"]["RetuneRequest"];
export type ExportRequest = components["schemas"]["ExportRequest"];
export type ProjectUpdateRequest = components["schemas"]["ProjectUpdateRequest"];
export type StemRequest = components["schemas"]["StemRequest"];
export type ChordRequest = components["schemas"]["ChordRequest"];
export type ChordBackendSchema = components["schemas"]["ChordBackendSchema"];
export type ChordBackendsResponse = components["schemas"]["ChordBackendsResponse"];
export type LyricsGenerateRequest = components["schemas"]["LyricsGenerateRequest"];
export type LyricsUpdateRequest = components["schemas"]["LyricsUpdateRequest"];
export type RuntimeCapabilities = MobileCapabilities | null;

export type TuneForgeClient = {
  getMobileCapabilities: () => Promise<RuntimeCapabilities>;
  getHealth: () => Promise<HealthResponse>;
  listProjects: (search?: string) => Promise<components["schemas"]["ProjectsResponse"]>;
  importProject: (body: components["schemas"]["ProjectImportRequest"]) => Promise<components["schemas"]["ProjectResponse"]>;
  getProject: (projectId: string) => Promise<components["schemas"]["ProjectResponse"]>;
  updateProject: (projectId: string, body: ProjectUpdateRequest) => Promise<components["schemas"]["ProjectResponse"]>;
  deleteProject: (projectId: string) => Promise<components["schemas"]["DeleteResponse"]>;
  analyzeProject: (projectId: string) => Promise<components["schemas"]["JobResponse"]>;
  getAnalysis: (projectId: string) => Promise<AnalysisResponse>;
  listChordBackends: () => Promise<ChordBackendsResponse>;
  createChords: (projectId: string, body: ChordRequest) => Promise<components["schemas"]["JobResponse"]>;
  getChords: (projectId: string) => Promise<ChordResponse>;
  createLyrics: (projectId: string, body: LyricsGenerateRequest) => Promise<components["schemas"]["JobResponse"]>;
  getLyrics: (projectId: string) => Promise<LyricsResponse>;
  updateLyrics: (projectId: string, body: LyricsUpdateRequest) => Promise<LyricsResponse>;
  createPreview: (projectId: string, body: PreviewRequest) => Promise<components["schemas"]["JobResponse"]>;
  createStems: (projectId: string, body: StemRequest) => Promise<components["schemas"]["JobResponse"]>;
  createRetune: (projectId: string, body: RetuneRequest) => Promise<components["schemas"]["JobResponse"]>;
  createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) => Promise<components["schemas"]["JobResponse"]>;
  listArtifacts: (projectId: string) => Promise<components["schemas"]["ArtifactsResponse"]>;
  deleteArtifact: (projectId: string, artifactId: string) => Promise<components["schemas"]["DeleteResponse"]>;
  createExport: (projectId: string, body: ExportRequest) => Promise<components["schemas"]["JobResponse"]>;
  listJobs: () => Promise<components["schemas"]["JobsResponse"]>;
  getJob: (jobId: string) => Promise<components["schemas"]["JobResponse"]>;
  cancelJob: (jobId: string) => Promise<components["schemas"]["JobResponse"]>;
  streamArtifactUrl: (artifactId: string) => string;
};

let client = createClient<paths>({ baseUrl: apiBaseUrl });
const mobileArtifactPaths = new Map<string, string>();
const mobileChordBackendsResponse: ChordBackendsResponse = {
  backends: [
    {
      availability: "available",
      available: true,
      capabilities: {
        desktopOnly: false,
        estimatedSpeed: "medium",
        experimental: false,
        supportsConfidence: true,
        supportsInversions: false,
        supportsNoChord: true,
        supportsSevenths: true,
      },
      description: "TuneForge's built-in lightweight chord detector.",
      desktopOnly: false,
      experimental: false,
      id: "tuneforge-fast",
      label: "Built-in Chords",
      unavailable_reason: null,
    },
    {
      availability: "unavailable",
      available: false,
      capabilities: {
        desktopOnly: true,
        estimatedSpeed: "slow",
        experimental: true,
        supportsConfidence: true,
        supportsInversions: true,
        supportsNoChord: true,
        supportsSevenths: true,
      },
      description: "Optional crema chord detector for desktop builds.",
      desktopOnly: true,
      experimental: true,
      id: "crema-advanced",
      label: "Advanced Chords",
      unavailable_reason: "advanced chord backend is disabled on mobile",
    },
  ],
};

export class ApiError extends Error {
  code: string;
  details: unknown;

  constructor(payload: ErrorResponse["error"]) {
    super(payload.message);
    this.code = payload.code;
    this.details = payload.details;
  }
}

function normalizeError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null && "error" in error) {
    const payload = error as ErrorResponse;
    return new ApiError(payload.error);
  }
  if (typeof error === "object" && error !== null && "detail" in error) {
    const payload = error as ValidationErrorResponse;
    const message = payload.detail?.[0]?.msg ?? "The request failed validation.";
    return new ApiError({ code: "INVALID_REQUEST", message, details: payload.detail ?? [] });
  }
  return new ApiError({ code: "UNKNOWN_ERROR", message: "The request failed.", details: error });
}

async function unwrap<T>(promise: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    throw normalizeError(error);
  }
  if (!data) {
    throw new Error("The backend returned an empty response.");
  }
  return data;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeMobile<T>(command: string, args?: Record<string, unknown>) {
  return invoke<T>(command, args);
}

function rememberArtifactPaths(artifacts: ArtifactSchema[]) {
  artifacts.forEach((artifact) => {
    const playbackPath =
      typeof artifact.metadata.playback_path === "string"
        ? artifact.metadata.playback_path
        : artifact.path;
    mobileArtifactPaths.set(artifact.id, playbackPath);
  });
}

function createHttpTuneForgeClient(): TuneForgeClient {
  return {
    getMobileCapabilities: async () => null,
    getHealth: () => unwrap(client.GET("/api/v1/health")),
    listProjects: (search?: string) =>
      unwrap(
        client.GET("/api/v1/projects", {
          params: search ? ({ query: { search } } as never) : undefined,
        }),
      ),
    importProject: (body: components["schemas"]["ProjectImportRequest"]) =>
      unwrap(client.POST("/api/v1/projects/import", { body })),
    getProject: (projectId: string) => unwrap(client.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    updateProject: (projectId: string, body: ProjectUpdateRequest) =>
      unwrap(client.PATCH("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } }, body })),
    deleteProject: (projectId: string) =>
      unwrap(client.DELETE("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    analyzeProject: (projectId: string) =>
      unwrap(
        client.POST("/api/v1/projects/{project_id}/analyze", {
          params: { path: { project_id: projectId } },
          body: { include_tempo: false, force: false },
        }),
      ),
    getAnalysis: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/analysis", { params: { path: { project_id: projectId } } })),
    listChordBackends: () => unwrap(client.GET("/api/v1/chord-backends")),
    createChords: (projectId: string, body: ChordRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/chords", { params: { path: { project_id: projectId } }, body })),
    getChords: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/chords", { params: { path: { project_id: projectId } } })),
    createLyrics: (projectId: string, body: LyricsGenerateRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/lyrics", { params: { path: { project_id: projectId } }, body })),
    getLyrics: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/lyrics", { params: { path: { project_id: projectId } } })),
    updateLyrics: (projectId: string, body: LyricsUpdateRequest) =>
      unwrap(client.PUT("/api/v1/projects/{project_id}/lyrics", { params: { path: { project_id: projectId } }, body })),
    createPreview: (projectId: string, body: PreviewRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/preview", { params: { path: { project_id: projectId } }, body })),
    createStems: (projectId: string, body: StemRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/stems", { params: { path: { project_id: projectId } }, body })),
    createRetune: (projectId: string, body: RetuneRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/retune", { params: { path: { project_id: projectId } }, body })),
    createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/transpose", { params: { path: { project_id: projectId } }, body })),
    listArtifacts: (projectId: string) =>
      unwrap(client.GET("/api/v1/projects/{project_id}/artifacts", { params: { path: { project_id: projectId } } })),
    deleteArtifact: (projectId: string, artifactId: string) =>
      unwrap(
        client.DELETE("/api/v1/projects/{project_id}/artifacts/{artifact_id}", {
          params: { path: { project_id: projectId, artifact_id: artifactId } },
        }),
      ),
    createExport: (projectId: string, body: ExportRequest) =>
      unwrap(client.POST("/api/v1/projects/{project_id}/export", { params: { path: { project_id: projectId } }, body })),
    listJobs: () => unwrap(client.GET("/api/v1/jobs")),
    getJob: (jobId: string) => unwrap(client.GET("/api/v1/jobs/{job_id}", { params: { path: { job_id: jobId } } })),
    cancelJob: (jobId: string) =>
      unwrap(client.POST("/api/v1/jobs/{job_id}/cancel", { params: { path: { job_id: jobId } } })),
    streamArtifactUrl: (artifactId: string) => `${getApiBaseUrl()}/api/v1/artifacts/${artifactId}/stream`,
  };
}

function createMobileTuneForgeClient(capabilities: MobileCapabilities): TuneForgeClient {
  return {
    getMobileCapabilities: async () => capabilities,
    getHealth: () => invokeMobile("mobile_get_health"),
    listProjects: (search?: string) => invokeMobile("mobile_list_projects", { search }),
    importProject: (body: components["schemas"]["ProjectImportRequest"]) =>
      invokeMobile("mobile_import_project", { payload: body }),
    getProject: (projectId: string) => invokeMobile("mobile_get_project", { projectId }),
    updateProject: (projectId: string, body: ProjectUpdateRequest) =>
      invokeMobile("mobile_update_project", { projectId, payload: body }),
    deleteProject: (projectId: string) => invokeMobile("mobile_delete_project", { projectId }),
    analyzeProject: (projectId: string) => invokeMobile("mobile_submit_analyze", { projectId }),
    getAnalysis: (projectId: string) => invokeMobile("mobile_get_analysis", { projectId }),
    listChordBackends: async () => mobileChordBackendsResponse,
    createChords: (projectId: string, body: ChordRequest) =>
      invokeMobile("mobile_submit_chords", { projectId, payload: body }),
    getChords: (projectId: string) => invokeMobile("mobile_get_chords", { projectId }),
    createLyrics: (projectId: string, body: LyricsGenerateRequest) =>
      invokeMobile("mobile_submit_lyrics", { projectId, payload: body }),
    getLyrics: (projectId: string) => invokeMobile("mobile_get_lyrics", { projectId }),
    updateLyrics: (projectId: string, body: LyricsUpdateRequest) =>
      invokeMobile("mobile_update_lyrics", { projectId, payload: body }),
    createPreview: (projectId: string, body: PreviewRequest) =>
      invokeMobile("mobile_submit_preview", { projectId, payload: body }),
    createStems: (projectId: string, body: StemRequest) =>
      invokeMobile("mobile_submit_stems", { projectId, payload: body }),
    createRetune: (projectId: string, body: RetuneRequest) =>
      invokeMobile("mobile_submit_retune", { projectId, payload: body }),
    createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) =>
      invokeMobile("mobile_submit_transpose", { projectId, payload: body }),
    listArtifacts: async (projectId: string) => {
      const response = await invokeMobile<components["schemas"]["ArtifactsResponse"]>("mobile_list_artifacts", { projectId });
      rememberArtifactPaths(response.artifacts);
      return response;
    },
    deleteArtifact: (projectId: string, artifactId: string) =>
      invokeMobile("mobile_delete_artifact", { projectId, artifactId }),
    createExport: (projectId: string, body: ExportRequest) =>
      invokeMobile("mobile_submit_export", { projectId, payload: body }),
    listJobs: () => invokeMobile("mobile_list_jobs"),
    getJob: (jobId: string) => invokeMobile("mobile_get_job", { jobId }),
    cancelJob: (jobId: string) => invokeMobile("mobile_cancel_job", { jobId }),
    streamArtifactUrl: (artifactId: string) => {
      const artifactPath = mobileArtifactPaths.get(artifactId);
      return artifactPath ? convertFileSrc(artifactPath) : "";
    },
  };
}

let activeClient = createHttpTuneForgeClient();

export async function initializeApi() {
  if (!runtimeInitPromise) {
    runtimeInitPromise = (async () => {
      if (!isTauriRuntime()) {
        return apiBaseUrl;
      }

      try {
        const capabilities = await invoke<MobileCapabilities>("mobile_capabilities");
        apiBaseUrl = "mobile://embedded";
        activeClient = createMobileTuneForgeClient(capabilities);
        return apiBaseUrl;
      } catch {
        activeClient = createHttpTuneForgeClient();
      }

      try {
        const resolved = await invoke<string>("backend_base_url");
        apiBaseUrl = resolved;
        client = createClient<paths>({ baseUrl: apiBaseUrl });
        activeClient = createHttpTuneForgeClient();
      } catch {
        apiBaseUrl = DEFAULT_API_BASE_URL;
        client = createClient<paths>({ baseUrl: apiBaseUrl });
        activeClient = createHttpTuneForgeClient();
      }

      return apiBaseUrl;
    })();
  }

  return runtimeInitPromise;
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export const api: TuneForgeClient = {
  getMobileCapabilities: () => activeClient.getMobileCapabilities(),
  getHealth: () => activeClient.getHealth(),
  listProjects: (search?: string) => activeClient.listProjects(search),
  importProject: (body) => activeClient.importProject(body),
  getProject: (projectId: string) => activeClient.getProject(projectId),
  updateProject: (projectId: string, body: ProjectUpdateRequest) => activeClient.updateProject(projectId, body),
  deleteProject: (projectId: string) => activeClient.deleteProject(projectId),
  analyzeProject: (projectId: string) => activeClient.analyzeProject(projectId),
  getAnalysis: (projectId: string) => activeClient.getAnalysis(projectId),
  listChordBackends: () => activeClient.listChordBackends(),
  createChords: (projectId: string, body: ChordRequest) => activeClient.createChords(projectId, body),
  getChords: (projectId: string) => activeClient.getChords(projectId),
  createLyrics: (projectId: string, body: LyricsGenerateRequest) => activeClient.createLyrics(projectId, body),
  getLyrics: (projectId: string) => activeClient.getLyrics(projectId),
  updateLyrics: (projectId: string, body: LyricsUpdateRequest) => activeClient.updateLyrics(projectId, body),
  createPreview: (projectId: string, body: PreviewRequest) => activeClient.createPreview(projectId, body),
  createStems: (projectId: string, body: StemRequest) => activeClient.createStems(projectId, body),
  createRetune: (projectId: string, body: RetuneRequest) => activeClient.createRetune(projectId, body),
  createTranspose: (projectId: string, body: components["schemas"]["TransposeRequest"]) => activeClient.createTranspose(projectId, body),
  listArtifacts: (projectId: string) => activeClient.listArtifacts(projectId),
  deleteArtifact: (projectId: string, artifactId: string) => activeClient.deleteArtifact(projectId, artifactId),
  createExport: (projectId: string, body: ExportRequest) => activeClient.createExport(projectId, body),
  listJobs: () => activeClient.listJobs(),
  getJob: (jobId: string) => activeClient.getJob(jobId),
  cancelJob: (jobId: string) => activeClient.cancelJob(jobId),
  streamArtifactUrl: (artifactId: string) => activeClient.streamArtifactUrl(artifactId),
};
