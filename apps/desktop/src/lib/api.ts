import createClient from "openapi-fetch";
import { invoke } from "@tauri-apps/api/core";
import type { components, paths } from "@tuneforge/shared-types";

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
export type LyricsGenerateRequest = components["schemas"]["LyricsGenerateRequest"];
export type LyricsUpdateRequest = components["schemas"]["LyricsUpdateRequest"];

let client = createClient<paths>({ baseUrl: apiBaseUrl });

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

export async function initializeApi() {
  if (!runtimeInitPromise) {
    runtimeInitPromise = (async () => {
      if (!isTauriRuntime()) {
        return apiBaseUrl;
      }

      try {
        const resolved = await invoke<string>("backend_base_url");
        apiBaseUrl = resolved;
        client = createClient<paths>({ baseUrl: apiBaseUrl });
      } catch {
        apiBaseUrl = DEFAULT_API_BASE_URL;
        client = createClient<paths>({ baseUrl: apiBaseUrl });
      }

      return apiBaseUrl;
    })();
  }

  return runtimeInitPromise;
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export const api = {
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
