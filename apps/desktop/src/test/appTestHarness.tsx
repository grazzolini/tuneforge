import { fireEvent, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "../App";
import type {
  AnalysisRequest,
  BulkJobRequest,
  BulkJobsResponse,
  LyricsGenerateRequest,
  ListJobsParams,
  ListProjectsParams,
  SyncLifecycleEventRequest,
  SyncPreflightResponse,
  SyncPairingAnswerRequest,
  SyncPairingAnswerResponse,
  SyncPairingOfferRequest,
  SyncPairingOfferResponse,
  SyncTransportRunStatus,
  SyncTrustedPeerSchema,
  SyncTrustedPeerCreateRequest,
  SyncTrustedPeerResponse,
} from "../lib/api";
import { resetPlaybackE2ETelemetry } from "../lib/playbackE2ETelemetry";
import { resetPowerInhibitionDiagnostics } from "../lib/powerInhibition";

const DEFAULT_PROJECTS_LIMIT = 50;
const DEFAULT_JOBS_LIMIT = 50;

type MockListJobsParams = ListJobsParams & {
  sort_by?: string | null;
  sort_order?: string | null;
};
type JobSortOrder = "asc" | "desc";
type TimestampJobSortField = "created_at" | "started_at" | "updated_at";
type MockJobSortBy = "activity" | "status" | TimestampJobSortField;

const {
  resetMockApiState,
  setProjects,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
  setBeatBackends,
  setChordBackends,
  setStemModels,
  setJobs,
  setSyncTransportStatus,
  setSyncPreflight,
  setSyncTrustedPeers,
  setDeferredPreviewCompletion,
  flushPendingPreview,
  mockOpen,
  mockSave,
  mockConfirm,
  mockInvoke,
  mockInvokeImplementation,
  mockListProjects,
  mockImportProject,
  mockGetProject,
  mockGetAnalysis,
  mockGetChords,
  mockGetLyrics,
  mockListBeatBackends,
  mockListChordBackends,
  mockListStemModels,
  mockListArtifacts,
  mockListJobs,
  mockCancelJob,
  mockBulkJobs,
  mockGetSyncPreflight,
  mockGetSyncIdentity,
  mockGetSyncTransportStatus,
  mockStartSyncListener,
  mockStopSyncListener,
  mockRecordSyncLifecycleEvent,
  mockCreateSyncPairingOffer,
  mockAnswerSyncPairingOffer,
  mockListSyncTrustedPeers,
  mockTrustSyncPeer,
  mockRevokeSyncTrustedPeer,
  mockSyncTrustedPeerNow,
  mockCreateChords,
  mockCreateLyrics,
  mockCreateTabImport,
  mockCreatePreview,
  mockCreateStems,
  mockAnalyzeProject,
  mockUpdateLyrics,
  mockUpdateProject,
  mockGetTabImport,
  mockAcceptTabImport,
  mockListSections,
  mockCreateExport,
  mockDeleteArtifact,
  mockDeleteProject,
  mockGetHealth,
  mockGetMobileCapabilities,
  mockScanPairingQrCode,
  setMockSystemInputVolume,
  setMockNativeAudio,
  setMockPowerInhibition,
  emitMockNativeAudioError,
  emitMockNativeAudioInputFrame,
  emitMockNativeAudioInputState,
  emitMockNativeAudioPosition,
  emitMockSystemMediaControl,
  getSystemMediaControlListenerCount,
  deferNextSystemMediaControlListen,
  mockListen,
  rejectSystemMediaCommand,
  resolveDeferredSystemMediaControlListen,
} = vi.hoisted(() => {
  const createdAt = "2026-04-18T13:16:00.000Z";
  const irohTransportId = "tuneforge-sync+iroh";
  const tcpTransportId = "tuneforge-sync+tcp";
  const syncEndpointHints = [
    `${irohTransportId}://device_peer_1`,
    `${tcpTransportId}://192.168.1.42:48625`,
  ];
  type NativeAudioInputFrame = {
    deviceId: string | null;
    sampleRate: number;
    inputLevel: number;
    samples: number[];
    timestampMs: number;
    captureGeneration: number;
  };
  type NativeAudioInputFrameEvent = {
    event: "audio://input-frame";
    id: number;
    payload: NativeAudioInputFrame;
  };
  type NativeAudioPositionPayload = {
    sessionId: string | null;
    positionSeconds: number;
    durationSeconds: number;
    state: "stopped" | "playing" | "paused";
  };
  type NativeAudioErrorPayload = {
    sessionId: string | null;
    message: string;
  };
  type NativeAudioRuntimeEvent = {
    event: "audio://position" | "audio://ended" | "audio://error" | "audio://input-state";
    id: number;
    payload: Record<string, unknown>;
  };
  type SystemMediaControlPayload = {
    action: "play" | "pause" | "playPause" | "stop" | "seekBackward" | "seekForward" | "seekTo";
    positionSeconds?: number | null;
    seekOffsetSeconds?: number | null;
  };
  type SystemMediaControlEvent = {
    event: "system-media://control";
    id: number;
    payload: SystemMediaControlPayload;
  };
  type SystemMediaCommand =
    | "system_media_update_state"
    | "system_media_clear_state"
    | "system_media_set_idle_inhibition";
  const nativeInputFrameListeners = new Map<
    number,
    (event: NativeAudioInputFrameEvent) => void
  >();
  const nativeRuntimeListeners = new Map<
    number,
    {
      eventName: NativeAudioRuntimeEvent["event"];
      handler: (event: NativeAudioRuntimeEvent) => void;
    }
  >();
  const systemMediaControlListeners = new Map<
    number,
    (event: SystemMediaControlEvent) => void
  >();
  let nextNativeInputFrameListenerId = 1;
  let nextNativeRuntimeListenerId = 1;
  let nextSystemMediaControlListenerId = 1;
  let deferredSystemMediaControlListenResolver: (() => void) | null = null;
  let state: {
    projects: Array<Record<string, unknown>>;
    analysisByProject: Record<string, Record<string, unknown> | null>;
    chordsByProject: Record<string, Record<string, unknown>>;
    lyricsByProject: Record<string, Record<string, unknown>>;
    tabImportsByProject: Record<string, Array<Record<string, unknown>>>;
    sectionsByProject: Record<string, Array<Record<string, unknown>>>;
    artifactsByProject: Record<string, Array<Record<string, unknown>>>;
    beatBackends: Array<Record<string, unknown>>;
    chordBackends: Array<Record<string, unknown>>;
    stemModels: Array<Record<string, unknown>>;
    pendingPreviewArtifactsByProject: Record<string, Array<Record<string, unknown>>>;
    jobs: Array<Record<string, unknown>>;
    syncPreflight: Record<string, unknown> | null;
    syncIdentity: Record<string, unknown>;
    syncTransportStatus: Record<string, unknown>;
    syncTrustedPeers: Array<Record<string, unknown>>;
    snapshotFiles: Record<string, string>;
    systemInputVolume: {
      supported: boolean;
      volumePercent: number | null;
      muted: boolean | null;
      backend: string | null;
      error: string | null;
    };
    nativeAudioCapabilities: Record<string, unknown>;
    nativeAudioInputDevices: Record<string, unknown>;
    nativeAudioInputState: {
      active: boolean;
      deviceId: string | null;
      monitorEnabled: boolean;
      monitorGain: number;
      inputLevel: number;
      sampleRate: number | null;
      captureGeneration: number;
      capturePath: "none" | "desktop-cpal" | "android-aaudio";
      permissionState: string;
      error: { code: string; message: string; guidance: string | null } | null;
    };
    nativeAudioInputPermission: {
      state: string;
      error: { code: string; message: string; guidance: string | null } | null;
    };
    nativeAudioSnapshot: Record<string, unknown>;
    nativeAudioStartError: string | null;
    nativeAudioPlayFallbackReason: string | null;
    powerInhibitionStatus: {
      phase: string;
      backend: string | null;
      activeReasons: string[];
      screenProtected: boolean;
      backgroundProtected: boolean;
      errorCode: string | null;
      errorMessage: string | null;
    };
    systemMediaState: Record<string, unknown> | null;
    systemMediaIdleInhibited: boolean;
    systemMediaCommandErrors: Partial<Record<SystemMediaCommand, string>>;
    deferNextSystemMediaControlListen: boolean;
    nextProjectId: number;
    nextArtifactId: number;
    nextJobId: number;
    nextTabImportId: number;
    nextSectionId: number;
    deferPreviewCompletion: boolean;
  };

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  function titleize(value: string) {
    return value
      .replace(/\.[^/.]+$/, "")
      .split(/[-_ ]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function makeProject(
    id: string,
    displayName: string,
    sourcePath: string,
    importedPath = `/tmp/app/${displayName.toLowerCase().replace(/\s+/g, "-")}.wav`,
  ) {
    return {
      id,
      display_name: displayName,
      source_key_override: null,
      source_path: sourcePath,
      imported_path: importedPath,
      duration_seconds: 182,
      sample_rate: 44100,
      channels: 2,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  function makeChordTimeline(projectId: string) {
    const timeline = [
      { start_seconds: 0, end_seconds: 16, label: "G", confidence: 0.81, pitch_class: 7, quality: "major" },
      { start_seconds: 16, end_seconds: 32, label: "D", confidence: 0.79, pitch_class: 2, quality: "major" },
      { start_seconds: 32, end_seconds: 48, label: "Em", confidence: 0.74, pitch_class: 4, quality: "minor" },
      { start_seconds: 48, end_seconds: 64, label: "C", confidence: 0.76, pitch_class: 0, quality: "major" },
    ];
    return {
      project_id: projectId,
      backend: "librosa",
      source_artifact_id: "art_source",
      source_segments: clone(timeline),
      has_user_edits: false,
      created_at: createdAt,
      updated_at: createdAt,
      timeline: clone(timeline),
    };
  }

  function makeLyricsTranscript(
    projectId: string,
    languageOverride: LyricsGenerateRequest["language_override"] = null,
  ) {
    const hasNoLyrics = languageOverride === "none";
    const segments = [
      {
        start_seconds: 0,
        end_seconds: 8,
        text: "Hello from the first line",
        words: [
          { text: "Hello", start_seconds: 0, end_seconds: 1, confidence: 0.92 },
          { text: "from", start_seconds: 1, end_seconds: 2, confidence: 0.88 },
          { text: "the", start_seconds: 2, end_seconds: 3, confidence: 0.9 },
          { text: "first", start_seconds: 3, end_seconds: 4.5, confidence: 0.91 },
          { text: "line", start_seconds: 4.5, end_seconds: 6, confidence: 0.9 },
        ],
      },
      {
        start_seconds: 8,
        end_seconds: 16,
        text: "Second lyric line stays steady",
        words: [
          { text: "Second", start_seconds: 8, end_seconds: 9.4, confidence: 0.87 },
          { text: "lyric", start_seconds: 9.4, end_seconds: 10.8, confidence: 0.85 },
          { text: "line", start_seconds: 10.8, end_seconds: 12, confidence: 0.9 },
          { text: "stays", start_seconds: 12, end_seconds: 13.4, confidence: 0.84 },
          { text: "steady", start_seconds: 13.4, end_seconds: 15.2, confidence: 0.86 },
        ],
      },
    ];

    return {
      project_id: projectId,
      backend: hasNoLyrics ? "none" : "openai-whisper",
      source_artifact_id: "art_source",
      source_kind: hasNoLyrics ? "instrumental" : "ai",
      language: hasNoLyrics ? null : languageOverride ?? "en",
      language_override: languageOverride,
      source_segments: hasNoLyrics ? [] : clone(segments),
      segments: hasNoLyrics ? [] : clone(segments),
      has_user_edits: false,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  function makeChordBackends() {
    return [
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
        availability: "available",
        available: true,
        capabilities: {
          desktopOnly: true,
          estimatedSpeed: "slow",
          experimental: true,
          supportsConfidence: true,
          supportsInversions: true,
          supportsNoChord: true,
          supportsSevenths: true,
        },
        description: "Experimental crema chord detector.",
        desktopOnly: true,
        experimental: true,
        id: "crema-advanced",
        label: "Advanced Chords",
        unavailable_reason: null,
      },
    ];
  }

  function makeBeatBackends() {
    return [
      {
        availability: "available",
        available: true,
        description: "TuneForge's built-in beat detector.",
        desktopOnly: false,
        experimental: false,
        id: "built-in",
        label: "Built-in Beat Analysis",
        runtime_device: "cpu",
        unavailable_reason: null,
      },
      {
        availability: "available",
        available: true,
        description: "Experimental beat-this beat detector.",
        desktopOnly: true,
        experimental: true,
        id: "beat-this",
        label: "Advanced Beat Analysis",
        runtime_device: "cpu",
        unavailable_reason: null,
      },
    ];
  }

  function makeStemModels() {
    return [
      {
        availability: "available",
        available: true,
        default: true,
        description: "Demucs six-source model.",
        id: "htdemucs_6s",
        label: "Default (6 stems model)",
        sourceCount: 6,
        sources: ["vocals", "drums", "bass", "guitar", "piano", "other"],
        unavailable_reason: null,
      },
      {
        availability: "available",
        available: true,
        default: false,
        description: "Demucs two-source model.",
        id: "htdemucs_ft",
        label: "2 stems model",
        sourceCount: 2,
        sources: ["vocals", "instrumental"],
        unavailable_reason: null,
      },
    ];
  }

  function setProjects(projects: Array<Record<string, unknown>>) {
    state.projects = clone(projects);
  }

  function setProjectAnalysis(projectId: string, analysis: Record<string, unknown> | null) {
    state.analysisByProject[projectId] = analysis ? clone(analysis) : null;
  }

  function setProjectChords(projectId: string, chords: Record<string, unknown>) {
    state.chordsByProject[projectId] = clone(chords);
  }

  function setProjectLyrics(projectId: string, lyrics: Record<string, unknown>) {
    state.lyricsByProject[projectId] = clone(lyrics);
  }

  function setBeatBackends(backends: Array<Record<string, unknown>>) {
    state.beatBackends = clone(backends);
  }

  function setChordBackends(backends: Array<Record<string, unknown>>) {
    state.chordBackends = clone(backends);
  }

  function setStemModels(models: Array<Record<string, unknown>>) {
    state.stemModels = clone(models);
  }

  function isTerminalJobStatus(status: string) {
    return ["completed", "failed", "cancelled"].includes(status);
  }

  function completedAtForJobStatus(status: string) {
    return isTerminalJobStatus(status) ? createdAt : null;
  }

  function normalizeMockJob(job: Record<string, unknown>, index = 0): Record<string, unknown> {
    const clonedJob = clone(job) as Record<string, unknown>;
    const status = typeof clonedJob.status === "string" ? clonedJob.status : "pending";
    const type = typeof clonedJob.type === "string" && clonedJob.type ? clonedJob.type : "activity";
    const progress =
      typeof clonedJob.progress === "number"
        ? clonedJob.progress
        : status === "completed"
          ? 100
          : 0;

    return {
      ...clonedJob,
      id: typeof clonedJob.id === "string" && clonedJob.id ? clonedJob.id : `job_${index + 1}`,
      project_id: "project_id" in clonedJob ? clonedJob.project_id : null,
      type,
      status,
      progress,
      error_message: "error_message" in clonedJob ? clonedJob.error_message : null,
      completed_at: "completed_at" in clonedJob
        ? clonedJob.completed_at
        : completedAtForJobStatus(status),
      created_at: typeof clonedJob.created_at === "string" ? clonedJob.created_at : createdAt,
      updated_at: typeof clonedJob.updated_at === "string" ? clonedJob.updated_at : createdAt,
    };
  }

  function makeMockJob(job: Record<string, unknown>) {
    return normalizeMockJob({
      id: `job_${state.nextJobId++}`,
      ...job,
    });
  }

  function setJobs(jobs: Array<Record<string, unknown>>) {
    state.jobs = jobs.map((job, index) => normalizeMockJob(job, index));
  }

  function jobStringValue(job: Record<string, unknown>, field: string) {
    const value = job[field];
    return typeof value === "string" && value ? value : null;
  }

  function jobTimestampMs(job: Record<string, unknown>, field: string) {
    const value = jobStringValue(job, field);
    if (!value) return null;

    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  function firstJobTimestampMs(job: Record<string, unknown>, fields: string[]) {
    for (const field of fields) {
      const timestamp = jobTimestampMs(job, field);
      if (timestamp !== null) {
        return timestamp;
      }
    }

    return null;
  }

  function compareJobIds(left: Record<string, unknown>, right: Record<string, unknown>) {
    return (jobStringValue(left, "id") ?? "").localeCompare(jobStringValue(right, "id") ?? "");
  }

  function compareJobIdsDescending(left: Record<string, unknown>, right: Record<string, unknown>) {
    return compareJobIds(right, left);
  }

  function compareTimestampMs(
    leftTimestamp: number | null,
    rightTimestamp: number | null,
    sortOrder: JobSortOrder,
  ) {
    if (leftTimestamp === null && rightTimestamp === null) return 0;
    if (leftTimestamp === null) return 1;
    if (rightTimestamp === null) return -1;
    if (leftTimestamp === rightTimestamp) return 0;

    return sortOrder === "asc" ? leftTimestamp - rightTimestamp : rightTimestamp - leftTimestamp;
  }

  function compareJobTimestampField(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    field: TimestampJobSortField,
    sortOrder: JobSortOrder,
  ) {
    const timestampComparison = compareTimestampMs(
      jobTimestampMs(left, field),
      jobTimestampMs(right, field),
      sortOrder,
    );
    return timestampComparison || compareJobIds(left, right);
  }

  function mockJobStatus(job: Record<string, unknown>) {
    return jobStringValue(job, "status") ?? "unknown";
  }

  function mockActivitySortGroup(job: Record<string, unknown>) {
    const status = mockJobStatus(job);
    if (status === "running") return 0;
    if (status === "pending") return 1;
    if (isTerminalJobStatus(status)) return 2;
    return 3;
  }

  function compareActivityJobs(left: Record<string, unknown>, right: Record<string, unknown>) {
    const leftGroup = mockActivitySortGroup(left);
    const rightGroup = mockActivitySortGroup(right);

    if (leftGroup !== rightGroup) {
      return leftGroup - rightGroup;
    }

    if (leftGroup === 0) {
      const timestampComparison = compareTimestampMs(
        firstJobTimestampMs(left, ["started_at", "created_at"]),
        firstJobTimestampMs(right, ["started_at", "created_at"]),
        "asc",
      );
      return timestampComparison || compareJobIds(left, right);
    }

    if (leftGroup === 1) {
      return compareJobTimestampField(left, right, "created_at", "asc");
    }

    if (leftGroup === 2) {
      const timestampComparison = compareTimestampMs(
        firstJobTimestampMs(left, ["completed_at", "updated_at"]),
        firstJobTimestampMs(right, ["completed_at", "updated_at"]),
        "desc",
      );
      return timestampComparison || compareJobIdsDescending(left, right);
    }

    const timestampComparison = compareTimestampMs(
      jobTimestampMs(left, "updated_at"),
      jobTimestampMs(right, "updated_at"),
      "desc",
    );
    return timestampComparison || compareJobIdsDescending(left, right);
  }

  function statusSortGroup(job: Record<string, unknown>) {
    switch (mockJobStatus(job)) {
      case "running":
        return 0;
      case "pending":
        return 1;
      case "completed":
        return 2;
      case "cancelled":
        return 3;
      case "failed":
        return 4;
      default:
        return 5;
    }
  }

  function compareStatusJobs(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    sortOrder: JobSortOrder,
  ) {
    const leftGroup = statusSortGroup(left);
    const rightGroup = statusSortGroup(right);

    if (leftGroup !== rightGroup) {
      return sortOrder === "desc" ? rightGroup - leftGroup : leftGroup - rightGroup;
    }

    return compareActivityJobs(left, right);
  }

  function isTimestampJobSortField(value: string): value is TimestampJobSortField {
    return value === "created_at" || value === "started_at" || value === "updated_at";
  }

  function normalizeJobSortBy(value: string | null | undefined): MockJobSortBy {
    if (value === "status" || value === "activity") {
      return value;
    }

    if (value && isTimestampJobSortField(value)) {
      return value;
    }

    return "activity";
  }

  function sortJobsForParams(jobs: Array<Record<string, unknown>>, params?: MockListJobsParams) {
    const sortBy = normalizeJobSortBy(params?.sort_by);
    const sortOrder: JobSortOrder = params?.sort_order === "asc" ? "asc" : "desc";

    return [...jobs].sort((left, right) => {
      if (sortBy === "activity") {
        return compareActivityJobs(left, right);
      }

      if (sortBy === "status") {
        const statusSortOrder: JobSortOrder = params?.sort_order === "desc" ? "desc" : "asc";
        return compareStatusJobs(left, right, statusSortOrder);
      }

      return compareJobTimestampField(left, right, sortBy, sortOrder);
    });
  }

  function setSyncTransportStatus(nextStatus: Record<string, unknown>) {
    state.syncTransportStatus = {
      ...state.syncTransportStatus,
      ...clone(nextStatus),
    };
  }

  function setSyncPreflight(preflight: Record<string, unknown> | null) {
    state.syncPreflight = preflight ? clone(preflight) : null;
  }

  function setSyncTrustedPeers(peers: Array<Record<string, unknown>>) {
    state.syncTrustedPeers = clone(peers);
  }

  function setDeferredPreviewCompletion(value: boolean) {
    state.deferPreviewCompletion = value;
  }

  function flushPendingPreview(projectId: string) {
    const pendingArtifacts = state.pendingPreviewArtifactsByProject[projectId] ?? [];
    if (!pendingArtifacts.length) {
      return;
    }
    state.artifactsByProject[projectId] = [
      ...pendingArtifacts,
      ...(state.artifactsByProject[projectId] ?? []),
    ];
    state.pendingPreviewArtifactsByProject[projectId] = [];
    state.jobs = state.jobs.map((job, index) =>
      job.project_id === projectId && job.type === "preview" && job.status !== "completed"
        ? normalizeMockJob(
            {
              ...job,
              status: "completed",
              progress: 100,
              completed_at: job.completed_at ?? createdAt,
              updated_at: createdAt,
            },
            index,
          )
        : job,
    );
  }

  function resetMockApiState() {
    const demoProject = makeProject("proj_123", "Demo Song", "/tmp/demo.wav");
    state = {
      projects: [demoProject],
      analysisByProject: {
        proj_123: {
          project_id: "proj_123",
          estimated_key: "G major",
          key_confidence: 0.82,
          estimated_reference_hz: 431.9,
          tuning_offset_cents: -32,
          tempo_bpm: null,
          analysis_version: "v1",
          created_at: createdAt,
        },
      },
      chordsByProject: {
        proj_123: makeChordTimeline("proj_123"),
      },
      lyricsByProject: {
        proj_123: makeLyricsTranscript("proj_123"),
      },
      tabImportsByProject: {},
      sectionsByProject: {
        proj_123: [],
      },
      artifactsByProject: {
        proj_123: [
          {
            id: "art_preview",
            project_id: "proj_123",
            type: "preview_mix",
            format: "wav",
            path: "/tmp/demo-preview.wav",
            metadata: {
              retune: {},
              transpose: { semitones: 2 },
            },
            created_at: createdAt,
          },
          {
            id: "art_source",
            project_id: "proj_123",
            type: "source_audio",
            format: "wav",
            path: "/tmp/demo.wav",
            metadata: {},
            created_at: createdAt,
          },
        ],
      },
      beatBackends: makeBeatBackends(),
      chordBackends: makeChordBackends(),
      stemModels: makeStemModels(),
      pendingPreviewArtifactsByProject: {},
      jobs: [
        {
          id: "job_1",
          project_id: "proj_123",
          type: "preview",
          status: "completed",
          progress: 100,
          error_message: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
        {
          id: "job_2",
          project_id: "proj_123",
          type: "analyze",
          status: "completed",
          progress: 100,
          error_message: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
      syncPreflight: null,
      syncIdentity: {
        device_id: "device_local",
        sync_group_id: "sync_group_local",
        display_name: "Studio Mac",
        public_key: "pub_local",
        created_at: createdAt,
        updated_at: createdAt,
      },
      syncTransportStatus: {
        active: false,
        status: "stopped",
        endpoint_hints: [],
        last_error: null,
        last_sync: null,
        updated_at: createdAt,
      },
      syncTrustedPeers: [],
      snapshotFiles: {},
      systemInputVolume: {
        supported: true,
        volumePercent: 64,
        muted: false,
        backend: "test",
        error: null,
      },
      nativeAudioCapabilities: {
        platform: "test",
        backend: "test",
        nativePlaybackSupported: false,
        micCaptureSupported: false,
        micMonitoringSupported: false,
        systemInputVolumeSupported: true,
        emitsEvents: ["audio://input-frame", "audio://devices-changed"],
        fallbackRequired: true,
        fallbackReason: "Native audio playback is not wired yet; use existing WebView playback.",
      },
      nativeAudioInputDevices: {
        supported: true,
        devices: [],
        error: null,
      },
      nativeAudioInputState: {
        active: false,
        deviceId: null,
        monitorEnabled: false,
        monitorGain: 0,
        inputLevel: 0,
        sampleRate: null,
        captureGeneration: 0,
        capturePath: "none",
        permissionState: "unavailable",
        error: null,
      },
      nativeAudioInputPermission: { state: "unavailable", error: null },
      nativeAudioSnapshot: {
        sessionId: null,
        state: "stopped",
        positionSeconds: 0,
        durationSeconds: 0,
        playbackRate: 1,
        nativePlaybackSupported: false,
        fallbackReason: "Native audio playback is not wired yet; use existing WebView playback.",
        lanes: [],
        bufferHealth: [],
      },
      nativeAudioStartError: null,
      nativeAudioPlayFallbackReason: null,
      powerInhibitionStatus: {
        phase: "inactive",
        backend: null,
        activeReasons: [],
        screenProtected: false,
        backgroundProtected: false,
        errorCode: null,
        errorMessage: null,
      },
      systemMediaState: null,
      systemMediaIdleInhibited: false,
      systemMediaCommandErrors: {},
      deferNextSystemMediaControlListen: false,
      nextProjectId: 200,
      nextArtifactId: 200,
      nextJobId: 200,
      nextTabImportId: 200,
      nextSectionId: 200,
      deferPreviewCompletion: false,
    };
    nativeInputFrameListeners.clear();
    nativeRuntimeListeners.clear();
    systemMediaControlListeners.clear();
    nextNativeInputFrameListenerId = 1;
    nextNativeRuntimeListenerId = 1;
    nextSystemMediaControlListenerId = 1;
    deferredSystemMediaControlListenResolver = null;
  }

  resetMockApiState();

  function getProjectOrThrow(projectId: string) {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Unknown project ${projectId}`);
    }
    return project;
  }

  const mockOpen = vi.fn(async (): Promise<string | string[] | null> => null);
  const mockSave = vi.fn(async (): Promise<string | null> => null);
  const mockConfirm = vi.fn(async (): Promise<boolean> => true);
  function setMockSystemInputVolume(
    nextState: Partial<typeof state.systemInputVolume>,
  ) {
    state.systemInputVolume = {
      ...state.systemInputVolume,
      ...nextState,
    };
  }
  function setMockNativeAudio(nextState: {
    capabilities?: Record<string, unknown>;
    inputDevices?: Record<string, unknown>;
    inputState?: Partial<typeof state.nativeAudioInputState>;
    inputPermission?: Partial<typeof state.nativeAudioInputPermission>;
    snapshot?: Record<string, unknown>;
    startError?: string | null;
    playFallbackReason?: string | null;
  }) {
    state.nativeAudioCapabilities = {
      ...state.nativeAudioCapabilities,
      ...nextState.capabilities,
    };
    state.nativeAudioInputDevices = {
      ...state.nativeAudioInputDevices,
      ...nextState.inputDevices,
    };
    state.nativeAudioInputState = {
      ...state.nativeAudioInputState,
      ...nextState.inputState,
    };
    state.nativeAudioInputPermission = {
      ...state.nativeAudioInputPermission,
      ...nextState.inputPermission,
    };
    if (nextState.capabilities?.platform === "android" && !nextState.inputPermission) {
      state.nativeAudioInputPermission = { state: "granted", error: null };
    }
    state.nativeAudioSnapshot = {
      ...state.nativeAudioSnapshot,
      ...nextState.snapshot,
    };
    if ("startError" in nextState) {
      state.nativeAudioStartError = nextState.startError ?? null;
    }
    if ("playFallbackReason" in nextState) {
      state.nativeAudioPlayFallbackReason = nextState.playFallbackReason ?? null;
    }
  }

  function setMockPowerInhibition(
    nextStatus: Partial<typeof state.powerInhibitionStatus>,
  ) {
    state.powerInhibitionStatus = {
      ...state.powerInhibitionStatus,
      ...clone(nextStatus),
    };
  }
  function effectiveNativeAudioLanes(
    lanes: Array<{
      id: string;
      artifactId?: string | null;
      role: string;
      gain: number;
      muted: boolean;
      solo: boolean;
    }>,
  ) {
    const hasSolo = lanes.some((lane) => lane.solo);
    return lanes.map((lane) => {
      const active = hasSolo ? lane.solo : !lane.muted;
      return {
        id: lane.id,
        artifactId: lane.artifactId ?? null,
        role: lane.role,
        effectiveGain: active ? Math.max(0, Math.min(1, lane.gain)) : 0,
        muted: lane.muted,
        solo: lane.solo,
      };
    });
  }
  function emitMockNativeAudioInputFrame(frame: NativeAudioInputFrame) {
    nativeInputFrameListeners.forEach((listener, id) => {
      listener({
        event: "audio://input-frame",
        id,
        payload: clone(frame),
      });
    });
  }
  function emitMockNativeAudioInputState() {
    emitMockNativeRuntimeEvent("audio://input-state", state.nativeAudioInputState);
  }
  function emitMockNativeAudioPosition(position: NativeAudioPositionPayload) {
    emitMockNativeRuntimeEvent("audio://position", position);
  }
  function emitMockNativeAudioError(error: NativeAudioErrorPayload) {
    emitMockNativeRuntimeEvent("audio://error", error);
  }
  function emitMockSystemMediaControl(payload: SystemMediaControlPayload) {
    systemMediaControlListeners.forEach((listener, id) => {
      listener({
        event: "system-media://control",
        id,
        payload: clone(payload),
      });
    });
  }
  function getSystemMediaControlListenerCount() {
    return systemMediaControlListeners.size;
  }
  function deferNextSystemMediaControlListen() {
    state.deferNextSystemMediaControlListen = true;
  }
  function resolveDeferredSystemMediaControlListen() {
    deferredSystemMediaControlListenResolver?.();
  }
  function rejectSystemMediaCommand(command: SystemMediaCommand, message: string) {
    state.systemMediaCommandErrors[command] = message;
  }
  function emitMockNativeRuntimeEvent(
    eventName: NativeAudioRuntimeEvent["event"],
    payload: Record<string, unknown>,
  ) {
    nativeRuntimeListeners.forEach((listener, id) => {
      if (listener.eventName !== eventName) {
        return;
      }
      listener.handler({
        event: eventName,
        id,
        payload: clone(payload),
      });
    });
  }
  const mockListen = vi.fn(
    async (
      eventName: string,
      handler: (event: NativeAudioInputFrameEvent | NativeAudioRuntimeEvent | SystemMediaControlEvent) => void,
    ) => {
      if (eventName === "system-media://control") {
        const listenerId = nextSystemMediaControlListenerId;
        nextSystemMediaControlListenerId += 1;
        systemMediaControlListeners.set(
          listenerId,
          handler as (event: SystemMediaControlEvent) => void,
        );
        const unlisten = () => systemMediaControlListeners.delete(listenerId);
        if (state.deferNextSystemMediaControlListen) {
          state.deferNextSystemMediaControlListen = false;
          await new Promise<void>((resolve) => {
            deferredSystemMediaControlListenResolver = () => {
              deferredSystemMediaControlListenResolver = null;
              resolve();
            };
          });
        }
        return unlisten;
      }
      if (
        eventName === "audio://position" ||
        eventName === "audio://ended" ||
        eventName === "audio://error" ||
        eventName === "audio://input-state"
      ) {
        const listenerId = nextNativeRuntimeListenerId;
        nextNativeRuntimeListenerId += 1;
        nativeRuntimeListeners.set(listenerId, {
          eventName,
          handler: handler as (event: NativeAudioRuntimeEvent) => void,
        });
        return () => nativeRuntimeListeners.delete(listenerId);
      }
      if (eventName !== "audio://input-frame") {
        throw new Error(`Unexpected listen event: ${eventName}`);
      }
      const listenerId = nextNativeInputFrameListenerId;
      nextNativeInputFrameListenerId += 1;
      nativeInputFrameListeners.set(
        listenerId,
        handler as (event: NativeAudioInputFrameEvent) => void,
      );
      return () => nativeInputFrameListeners.delete(listenerId);
    },
  );
  const mockInvokeImplementation = async (
    command: string,
    args?: Record<string, unknown>,
  ) => {
    if (command === "backend_base_url") {
      return "http://127.0.0.1:8765";
    }

    if (command === "write_settings_snapshot_file") {
      const defaultFileName = String(args?.defaultFileName ?? "tuneforge-settings.json");
      const contents = String(args?.contents ?? "");
      state.snapshotFiles[defaultFileName] = contents;
      state.snapshotFiles.__settings_snapshot__ = contents;
      return true as boolean;
    }

    if (command === "write_sync_evidence_file") {
      const defaultFileName = String(args?.defaultFileName ?? "tuneforge-sync-evidence.json");
      state.snapshotFiles[defaultFileName] = String(args?.contents ?? "");
      return true as boolean;
    }

    if (command === "read_settings_snapshot_file") {
      return state.snapshotFiles.__settings_snapshot__ ?? null;
    }

    if (command === "get_system_default_input_volume") {
      return clone(state.systemInputVolume);
    }

    if (command === "set_system_default_input_volume") {
      const nextVolume = Math.max(0, Math.min(100, Math.round(Number(args?.volumePercent ?? 0))));
      state.systemInputVolume = {
        supported: true,
        volumePercent: nextVolume,
        muted: false,
        backend: "test",
        error: null,
      };
      return clone(state.systemInputVolume);
    }

    if (command === "system_media_update_state") {
      if (state.systemMediaCommandErrors.system_media_update_state) {
        throw new Error(state.systemMediaCommandErrors.system_media_update_state);
      }
      state.systemMediaState = clone((args?.payload ?? {}) as Record<string, unknown>);
      return null;
    }

    if (command === "system_media_clear_state") {
      if (state.systemMediaCommandErrors.system_media_clear_state) {
        throw new Error(state.systemMediaCommandErrors.system_media_clear_state);
      }
      state.systemMediaState = null;
      return null;
    }

    if (command === "system_media_set_idle_inhibition") {
      if (state.systemMediaCommandErrors.system_media_set_idle_inhibition) {
        throw new Error(state.systemMediaCommandErrors.system_media_set_idle_inhibition);
      }
      state.systemMediaIdleInhibited = Boolean(args?.active);
      return null;
    }

    if (command === "power_inhibition_set_activity") {
      const reason = String(args?.reason ?? "");
      const activeReasons = new Set(state.powerInhibitionStatus.activeReasons);
      if (args?.active === true) {
        activeReasons.add(reason);
      } else {
        activeReasons.delete(reason);
      }
      const hasActiveReasons = activeReasons.size > 0;
      state.powerInhibitionStatus = {
        phase: hasActiveReasons ? "active" : "inactive",
        backend: hasActiveReasons ? "test-power" : null,
        activeReasons: [...activeReasons],
        screenProtected: hasActiveReasons,
        backgroundProtected: hasActiveReasons,
        errorCode: null,
        errorMessage: null,
      };
      return clone(state.powerInhibitionStatus);
    }

    if (command === "power_inhibition_status") {
      return clone(state.powerInhibitionStatus);
    }

    if (command === "audio_get_capabilities") {
      return clone(state.nativeAudioCapabilities);
    }

    if (command === "audio_list_input_devices") {
      return clone(state.nativeAudioInputDevices);
    }

    if (command === "audio_get_input_state") {
      return clone(state.nativeAudioInputState);
    }

    if (command === "audio_get_input_permission_status") {
      return clone(state.nativeAudioInputPermission);
    }

    if (command === "audio_request_input_permission") {
      return clone(state.nativeAudioInputPermission);
    }

    if (command === "audio_prepare_session") {
      const payload = (args?.payload ?? {}) as {
        sessionId?: string;
        durationSeconds?: number | null;
        playbackRate?: number | null;
        lanes?: Array<{
          id: string;
          artifactId?: string | null;
          role: string;
          gain: number;
          muted: boolean;
          solo: boolean;
        }>;
      };
      const nativePlaybackSupported = state.nativeAudioCapabilities.nativePlaybackSupported === true;
      const fallbackReason =
        nativePlaybackSupported
          ? null
          : String(state.nativeAudioCapabilities.fallbackReason ?? "Native audio playback is unavailable.");
      const lanes = effectiveNativeAudioLanes(payload.lanes ?? []);
      state.nativeAudioSnapshot = {
        ...state.nativeAudioSnapshot,
        sessionId: payload.sessionId ?? null,
        state: "stopped",
        positionSeconds: 0,
        durationSeconds: payload.durationSeconds ?? 0,
        playbackRate: payload.playbackRate ?? 1,
        nativePlaybackSupported,
        fallbackReason,
        lanes,
        bufferHealth: (payload.lanes ?? []).map((lane) => ({
          laneId: lane.id,
          artifactId: lane.artifactId ?? null,
          role: lane.role,
          ringFillSamples: 0,
          ringCapacitySamples: 0,
          underrunCount: 0,
          workerErrorCount: 0,
          lastWorkerError: null,
        })),
      };
      return {
        id: payload.sessionId ?? "session",
        nativePlaybackSupported,
        fallbackReason,
        laneCount: lanes.length,
      };
    }

    if (command === "audio_play") {
      const payload = (args?.payload ?? {}) as { startTimeSeconds?: number | null };
      if (state.nativeAudioPlayFallbackReason) {
        state.nativeAudioSnapshot = {
          ...state.nativeAudioSnapshot,
          state: "paused",
          nativePlaybackSupported: false,
          fallbackReason: state.nativeAudioPlayFallbackReason,
          positionSeconds: payload.startTimeSeconds ?? Number(state.nativeAudioSnapshot.positionSeconds ?? 0),
        };
        return clone(state.nativeAudioSnapshot);
      }
      state.nativeAudioSnapshot = {
        ...state.nativeAudioSnapshot,
        state: "playing",
        positionSeconds: payload.startTimeSeconds ?? Number(state.nativeAudioSnapshot.positionSeconds ?? 0),
      };
      return clone(state.nativeAudioSnapshot);
    }

    if (command === "audio_pause") {
      state.nativeAudioSnapshot = {
        ...state.nativeAudioSnapshot,
        state: "paused",
      };
      return clone(state.nativeAudioSnapshot);
    }

    if (command === "audio_stop") {
      state.nativeAudioSnapshot = {
        ...state.nativeAudioSnapshot,
        state: "stopped",
        positionSeconds: 0,
      };
      return clone(state.nativeAudioSnapshot);
    }

    if (command === "audio_seek") {
      const payload = (args?.payload ?? {}) as { timeSeconds?: number };
      state.nativeAudioSnapshot = {
        ...state.nativeAudioSnapshot,
        positionSeconds: payload.timeSeconds ?? 0,
      };
      return clone(state.nativeAudioSnapshot);
    }

    if (command === "audio_set_lanes") {
      const payload = (args?.payload ?? {}) as {
        playbackRate?: number | null;
        lanes?: Array<{
          id: string;
          artifactId?: string | null;
          role: string;
          gain: number;
          muted: boolean;
          solo: boolean;
        }>;
      };
      const lanes = effectiveNativeAudioLanes(payload.lanes ?? []);
      state.nativeAudioSnapshot = {
        ...state.nativeAudioSnapshot,
        playbackRate: payload.playbackRate ?? Number(state.nativeAudioSnapshot.playbackRate ?? 1),
        lanes,
        bufferHealth: (payload.lanes ?? []).map((lane) => ({
          laneId: lane.id,
          artifactId: lane.artifactId ?? null,
          role: lane.role,
          ringFillSamples: 0,
          ringCapacitySamples: 0,
          underrunCount: 0,
          workerErrorCount: 0,
          lastWorkerError: null,
        })),
      };
      return clone(state.nativeAudioSnapshot);
    }

    if (command === "audio_set_click" || command === "audio_get_snapshot") {
      return clone(state.nativeAudioSnapshot);
    }

    if (command === "audio_start_input") {
      if (state.nativeAudioStartError) {
        throw new Error(state.nativeAudioStartError);
      }
      const payload = (args?.payload ?? {}) as {
        deviceId?: string | null;
        monitorEnabled?: boolean | null;
        monitorGain?: number | null;
      };
      state.nativeAudioInputState = {
        active: true,
        deviceId: payload.deviceId ?? null,
        monitorEnabled: payload.monitorEnabled ?? false,
        monitorGain: payload.monitorGain ?? 0,
        inputLevel: 0,
        sampleRate: 48000,
        captureGeneration: state.nativeAudioInputState.captureGeneration + 1,
        capturePath:
          state.nativeAudioCapabilities.platform === "android" ? "android-aaudio" : "desktop-cpal",
        permissionState:
          state.nativeAudioCapabilities.platform === "android" ? "granted" : "unavailable",
        error: null,
      };
      return clone(state.nativeAudioInputState);
    }

    if (command === "audio_stop_input") {
      state.nativeAudioInputState = {
        ...state.nativeAudioInputState,
        active: false,
        inputLevel: 0,
        sampleRate: null,
        captureGeneration: state.nativeAudioInputState.captureGeneration + 1,
        capturePath: "none",
        error: null,
      };
      return clone(state.nativeAudioInputState);
    }

    throw new Error(`Unexpected invoke command: ${command}`);
  };
  const mockInvoke = vi.fn(mockInvokeImplementation);
  const mockGetHealth = vi.fn(async () => ({
    name: "TuneForge",
    version: "backend-test-ref",
    backend_version: {
      package_version: "1.0.0",
      git_ref: "backend-test-ref",
    },
    frontend_version: {
      package_version: "1.0.0",
      git_ref: "frontend-test-ref",
    },
    status: "ok",
    api_base_url: "http://127.0.0.1:8765/api/v1",
    data_root: "/tmp/tuneforge",
    default_export_format: "wav",
    preview_format: "wav",
  }));
  const mockGetMobileCapabilities = vi.fn(async (): Promise<unknown> => null);
  const mockScanPairingQrCode = vi.fn(async (): Promise<string> => {
    throw new Error("QR scanner unavailable.");
  });
  const mockListChordBackends = vi.fn(async () => ({ backends: clone(state.chordBackends) }));
  const mockListBeatBackends = vi.fn(async () => ({ backends: clone(state.beatBackends) }));
  const mockListStemModels = vi.fn(async () => ({ models: clone(state.stemModels) }));
  const mockListProjects = vi.fn(async (params?: ListProjectsParams) => {
    const normalizedSearch = params?.search?.trim().toLowerCase();
    const filteredProjects = normalizedSearch
      ? state.projects.filter((project) => {
          const displayName = String(project.display_name ?? "").toLowerCase();
          const sourcePath = String(project.source_path ?? "").toLowerCase();
          const importedPath = String(project.imported_path ?? "").toLowerCase();
          return (
            displayName.includes(normalizedSearch) ||
            sourcePath.includes(normalizedSearch) ||
            importedPath.includes(normalizedSearch)
          );
        })
      : state.projects;
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? DEFAULT_PROJECTS_LIMIT;
    const projects = filteredProjects.slice(offset, offset + limit);
    return {
      projects: clone(projects),
      total: filteredProjects.length,
      limit,
      offset,
      has_more: offset + projects.length < filteredProjects.length,
    };
  });
  const mockImportProject = vi.fn(async (body: {
    source_path: string;
    display_name?: string | null;
    beat_backend?: string | null;
    chord_backend?: string | null;
    chord_backend_fallback_from?: string | null;
    stem_model?: string | null;
  }) => {
    const { source_path } = body;
    const id = `proj_${state.nextProjectId++}`;
    const baseName = source_path.split("/").pop() ?? "Imported Track";
    const displayName = body.display_name?.trim() || titleize(baseName);
    const project = makeProject(id, displayName, source_path);
    const sourceArtifactId = `art_${state.nextArtifactId++}`;
    state.projects.unshift(project);
    state.analysisByProject[id] = null;
    state.chordsByProject[id] = {
      project_id: id,
      backend: null,
      source_artifact_id: null,
      source_segments: [],
      created_at: null,
      has_user_edits: false,
      updated_at: null,
      timeline: [],
    };
    state.lyricsByProject[id] = {
      project_id: id,
      backend: null,
      source_artifact_id: null,
      source_kind: null,
      source_segments: [],
      segments: [],
      has_user_edits: false,
      created_at: null,
      updated_at: null,
    };
    state.sectionsByProject[id] = [];
    state.artifactsByProject[id] = [
      {
        id: sourceArtifactId,
        project_id: id,
        type: "source_audio",
        format: "wav",
        path: source_path,
        metadata: {},
        created_at: createdAt,
      },
    ];
    const selectedStemModel = body.stem_model === "htdemucs_ft" ? "htdemucs_ft" : "htdemucs_6s";
    state.jobs.unshift(
      makeMockJob({
        project_id: id,
        type: "stems",
        status: "pending",
        progress: 0,
        source_artifact_id: sourceArtifactId,
        stem_model: selectedStemModel,
        stem_model_label: selectedStemModel === "htdemucs_ft" ? "2 stems model" : "Default (6 stems model)",
      }),
      makeMockJob({
        project_id: id,
        type: "lyrics",
        status: "pending",
        progress: 0,
      }),
      makeMockJob({
        project_id: id,
        type: "chords",
        status: "pending",
        progress: 0,
        chord_backend: body.chord_backend === "crema-advanced" ? "crema-advanced" : "tuneforge-fast",
        chord_backend_fallback_from: body.chord_backend_fallback_from ?? null,
        chord_source: "source",
      }),
      makeMockJob({
        project_id: id,
        type: "analyze",
        status: "pending",
        progress: 0,
      }),
    );
    return { project: clone(project) };
  });
  const mockGetProject = vi.fn(async (projectId: string) => ({ project: clone(getProjectOrThrow(projectId)) }));
  const mockGetAnalysis = vi.fn(async (projectId: string) => ({ analysis: clone(state.analysisByProject[projectId] ?? null) }));
  const mockGetChords = vi.fn(async (projectId: string) =>
    clone(
      state.chordsByProject[projectId] ?? {
        project_id: projectId,
        backend: null,
        source_artifact_id: null,
        source_segments: [],
        created_at: null,
        has_user_edits: false,
        updated_at: null,
        timeline: [],
      },
    ),
  );
  const mockGetLyrics = vi.fn(async (projectId: string) =>
    clone(
      state.lyricsByProject[projectId] ?? {
        project_id: projectId,
        backend: null,
        source_artifact_id: null,
        source_kind: null,
        source_segments: [],
        segments: [],
        has_user_edits: false,
        created_at: null,
        updated_at: null,
      },
    ),
  );
  const mockListArtifacts = vi.fn(async (projectId: string) => ({ artifacts: clone(state.artifactsByProject[projectId] ?? []) }));
  const mockListJobs = vi.fn(async (params?: MockListJobsParams) => {
    const normalizedJobs = state.jobs.map((job, index) => normalizeMockJob(job, index));
    const statusFilters = Array.isArray(params?.status) ? params.status : [];
    const normalizedSearch = params?.search?.trim().toLowerCase();
    const filteredJobs = normalizedJobs.filter((job) => {
      const statusMatches =
        statusFilters.length === 0 || statusFilters.includes(String(job.status));
      const projectMatches =
        params?.project_id == null || job.project_id === params.project_id;
      const searchMatches = normalizedSearch
        ? state.projects.some((project) => {
            const displayName = String(project.display_name ?? "").toLowerCase();
            return project.id === job.project_id && displayName.includes(normalizedSearch);
          })
        : true;
      return statusMatches && projectMatches && searchMatches;
    });
    const sortedJobs = sortJobsForParams(filteredJobs, params);
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? DEFAULT_JOBS_LIMIT;
    const jobs = sortedJobs.slice(offset, offset + limit);
    return {
      jobs: clone(jobs),
      total: sortedJobs.length,
      limit,
      offset,
      has_more: offset + jobs.length < sortedJobs.length,
    };
  });
  const mockCancelJob = vi.fn(async (jobId: string) => {
    const jobIndex = state.jobs.findIndex((job) => job.id === jobId);
    if (jobIndex === -1) {
      throw new Error(`Unknown job ${jobId}`);
    }
    const cancelledJob = normalizeMockJob(
      {
        ...state.jobs[jobIndex],
        status: "cancelled",
        progress: 0,
        error_message: null,
        completed_at: state.jobs[jobIndex]?.completed_at ?? createdAt,
        updated_at: createdAt,
      },
      jobIndex,
    );
    state.jobs = state.jobs.map((job, index) => (index === jobIndex ? cancelledJob : job));
    return { job: clone(cancelledJob) };
  });
  const mockBulkJobs = vi.fn(async (body: BulkJobRequest): Promise<BulkJobsResponse> => {
    const activeStatuses = new Set(["pending", "running"]);
    const jobs: Array<Record<string, unknown>> = [];
    const skipped: NonNullable<BulkJobsResponse["skipped"]> = [];

    state.projects.forEach((project) => {
      const projectId = String(project.id);
      const projectName = String(project.display_name ?? projectId);
      const hasActiveDuplicate = state.jobs.some(
        (job) =>
          job.project_id === projectId &&
          job.type === body.job_type &&
          typeof job.status === "string" &&
          activeStatuses.has(job.status),
      );
      if (hasActiveDuplicate) {
        skipped.push({ project_id: projectId, project_name: projectName, reason: "active_job" });
        return;
      }

      const queuedJob = makeMockJob({
        project_id: projectId,
        type: body.job_type,
        status: "pending",
        progress: 0,
        created_at: createdAt,
        updated_at: createdAt,
      });
      jobs.push(queuedJob);
    });

    state.jobs = [...jobs, ...state.jobs];
    return {
      created_jobs: clone(jobs) as NonNullable<BulkJobsResponse["created_jobs"]>,
      total_projects: state.projects.length,
      skipped,
    };
  });
  function buildMockSyncPreflight(): SyncPreflightResponse {
    const blockingJobs = state.jobs
      .map((item, index) => normalizeMockJob(item, index))
      .filter((item) => item.status === "pending" || item.status === "running")
      .sort(compareActivityJobs);
    const runningJobCount = blockingJobs.filter((item) => item.status === "running").length;
    const pendingJobCount = blockingJobs.filter((item) => item.status === "pending").length;
    const visibleBlockingJobs = blockingJobs.slice(0, 20).map((item) => {
      const projectId = typeof item.project_id === "string" ? item.project_id : null;
      const project = projectId ? state.projects.find((candidate) => candidate.id === projectId) : null;
      return {
        id: String(item.id),
        project_id: projectId,
        project_name: typeof project?.display_name === "string" ? project.display_name : null,
        type: String(item.type ?? "job"),
        status: String(item.status ?? "pending"),
        progress: typeof item.progress === "number" ? item.progress : 0,
        started_at: typeof item.started_at === "string" ? item.started_at : null,
        updated_at: typeof item.updated_at === "string" ? item.updated_at : createdAt,
      };
    });

    return {
      ok: true,
      library_ok: true,
      total_projects: state.projects.length,
      ready_projects: state.projects.length,
      missing_source_hash_projects: 0,
      invalid_source_hash_projects: 0,
      duplicate_source_hash_projects: 0,
      noncanonical_project_id_projects: 0,
      projects: state.projects.map((item) => ({
        project_id: String(item.id),
        display_name: String(item.display_name ?? item.id),
        status: "ready",
        source_sha256: null,
        expected_project_id: null,
        expected_storage_key: null,
        source_hash_source: null,
        reason: null,
      })),
      duplicate_groups: [],
      job_state: {
        state: blockingJobs.length ? "busy" : "ready",
        running_job_count: runningJobCount,
        pending_job_count: pendingJobCount,
        blocking_job_count: blockingJobs.length,
        blocking_job_counts: {
          running: runningJobCount,
          pending: pendingJobCount,
        },
        blocking_jobs: visibleBlockingJobs,
        blocking_jobs_truncated: blockingJobs.length > visibleBlockingJobs.length,
        guidance: blockingJobs.length
          ? ["Backend jobs are running. Sync can start, but backend work may delay sync endpoint responses."]
          : [],
      },
      manual_cleanup_required: false,
      manual_cleanup_guidance: [],
    };
  }
  function normalizeSyncPeer(peer: Record<string, unknown>): SyncTrustedPeerSchema {
    return {
      device_id: String(peer.device_id ?? "device_peer"),
      sync_group_id: String(peer.sync_group_id ?? "sync_group_local"),
      display_name: typeof peer.display_name === "string" ? peer.display_name : null,
      public_key: String(peer.public_key ?? "pub_peer"),
      endpoint_hints: Array.isArray(peer.endpoint_hints)
        ? peer.endpoint_hints.filter((hint): hint is string => typeof hint === "string")
        : [],
      trusted_at: typeof peer.trusted_at === "string" ? peer.trusted_at : createdAt,
      revoked_at: typeof peer.revoked_at === "string" ? peer.revoked_at : null,
      updated_at: typeof peer.updated_at === "string" ? peer.updated_at : createdAt,
    };
  }
  const mockGetSyncPreflight = vi.fn(async (): Promise<SyncPreflightResponse> =>
    clone((state.syncPreflight as SyncPreflightResponse | null) ?? buildMockSyncPreflight()),
  );
  const mockGetSyncIdentity = vi.fn(async () => ({ identity: clone(state.syncIdentity) }));
  const mockGetSyncTransportStatus = vi.fn(async () => clone(state.syncTransportStatus));
  const mockStartSyncListener = vi.fn(async () => {
    state.syncTransportStatus = {
      ...state.syncTransportStatus,
      active: true,
      status: "listening",
      endpoint_hints: clone(syncEndpointHints),
      last_error: null,
      updated_at: createdAt,
    };
    return clone(state.syncTransportStatus);
  });
  const mockStopSyncListener = vi.fn(async () => {
    state.syncTransportStatus = {
      ...state.syncTransportStatus,
      active: false,
      status: "stopped",
      endpoint_hints: [],
      updated_at: createdAt,
    };
    return clone(state.syncTransportStatus);
  });
  const mockRecordSyncLifecycleEvent = vi.fn(async (event: SyncLifecycleEventRequest) => {
    const occurredAt = event.occurredAt ?? createdAt;
    const lifecycleEvent = {
      kind: event.kind,
      occurred_at: occurredAt,
      message: event.message ?? null,
      retryable: false,
      interruption_code: null,
      retry_guidance: null,
      peer_device_id: null,
      run_id: null,
    };
    const lifecycleEvents = Array.isArray(state.syncTransportStatus.lifecycle_events)
      ? state.syncTransportStatus.lifecycle_events
      : [];
    state.syncTransportStatus = {
      ...state.syncTransportStatus,
      last_lifecycle_event: lifecycleEvent,
      lifecycle_events: [...lifecycleEvents, lifecycleEvent],
      updated_at: occurredAt,
    };
    return clone(state.syncTransportStatus);
  });
  const mockCreateSyncPairingOffer = vi.fn(async (
    body: SyncPairingOfferRequest,
  ): Promise<SyncPairingOfferResponse> => ({
    pairing_offer: {
      payload: {
        sync_group_id: String(state.syncIdentity.sync_group_id),
        device_id: String(state.syncIdentity.device_id),
        display_name: typeof state.syncIdentity.display_name === "string" ? state.syncIdentity.display_name : null,
        public_key: String(state.syncIdentity.public_key),
        endpoint_hints: clone(body.endpoint_hints ?? []),
        protocol_version: "tuneforge-sync-v1",
        pairing_offer_id: "pair_offer_1",
        pairing_secret: "pair_secret_1",
        expires_at: "2099-04-18T13:26:00.000Z",
        signature: "pair_signature_1",
      },
      expires_at: "2099-04-18T13:26:00.000Z",
      ttl_seconds: body.ttl_seconds,
    },
  }));
  const mockAnswerSyncPairingOffer = vi.fn(async (
    body: SyncPairingAnswerRequest,
  ): Promise<SyncPairingAnswerResponse> => {
    const peer = normalizeSyncPeer({
      device_id: body.offer.device_id,
      sync_group_id: body.offer.sync_group_id,
      display_name: body.offer.display_name,
      public_key: body.offer.public_key,
      endpoint_hints: body.offer.endpoint_hints,
      trusted_at: createdAt,
      updated_at: createdAt,
    });
    state.syncTrustedPeers = [
      peer,
      ...state.syncTrustedPeers.filter((existingPeer) => existingPeer.device_id !== peer.device_id),
    ];
    return {
      pairing_response: {
        sync_group_id: String(state.syncIdentity.sync_group_id),
        device_id: String(state.syncIdentity.device_id),
        display_name: typeof state.syncIdentity.display_name === "string" ? state.syncIdentity.display_name : null,
        public_key: String(state.syncIdentity.public_key),
        endpoint_hints: clone(body.endpoint_hints ?? []),
        protocol_version: "tuneforge-sync-v1",
        pairing_offer_id: body.offer.pairing_offer_id,
        pairing_secret: body.offer.pairing_secret,
        expires_at: body.offer.expires_at,
        signature: "pair_response_signature_1",
      },
      trusted_peer: clone(peer),
    };
  });
  const mockListSyncTrustedPeers = vi.fn(async () => ({
    trusted_peers: clone(state.syncTrustedPeers.map((peer) => normalizeSyncPeer(peer))),
  }));
  const mockTrustSyncPeer = vi.fn(async (
    body: SyncTrustedPeerCreateRequest,
  ): Promise<SyncTrustedPeerResponse> => {
    const peer = normalizeSyncPeer({
      device_id: body.payload.device_id,
      sync_group_id: body.payload.sync_group_id,
      display_name: body.payload.display_name,
      public_key: body.payload.public_key,
      endpoint_hints: body.payload.endpoint_hints,
      trusted_at: createdAt,
      updated_at: createdAt,
    });
    state.syncTrustedPeers = [
      peer,
      ...state.syncTrustedPeers.filter((existingPeer) => existingPeer.device_id !== peer.device_id),
    ];
    return { trusted_peer: clone(peer) };
  });
  const mockRevokeSyncTrustedPeer = vi.fn(async (deviceId: string) => {
    const peer = normalizeSyncPeer(
      state.syncTrustedPeers.find((trustedPeer) => trustedPeer.device_id === deviceId) ?? {
        device_id: deviceId,
      },
    );
    state.syncTrustedPeers = state.syncTrustedPeers.filter((trustedPeer) => trustedPeer.device_id !== deviceId);
    return {
      trusted_peer: clone({
        ...peer,
        revoked_at: createdAt,
        updated_at: createdAt,
      }),
    };
  });
  const mockSyncTrustedPeerNow = vi.fn(async (deviceId: string): Promise<SyncTransportRunStatus> => {
    const syncResult: SyncTransportRunStatus = {
      peer_device_id: deviceId,
      remote_device_id: deviceId,
      selected_transport: irohTransportId,
      attempted_transports: [irohTransportId, tcpTransportId],
      status: "completed_with_errors",
      message: "Manifest exchange completed with 4 project results.",
      started_at: createdAt,
      completed_at: createdAt,
      error: null,
      project_results: [
        {
          project_id: "proj_imported",
          status: "applied",
          message: "Reconciliation apply: 3 applied, 1 satisfied, 0 skipped, 0 failed.",
        },
        {
          project_id: "proj_up_to_date",
          status: "skipped",
          message: "Reconciliation apply: 0 applied, 0 satisfied, 2 skipped, 0 failed.",
        },
        {
          project_id: "proj_conflict",
          status: "conflicted",
          message: "Local lyrics conflict with the trusted peer revision.",
        },
        {
          project_id: "proj_missing_audio",
          status: "failed",
          message: "Peer did not provide the required source audio.",
        },
      ],
      manifest_errors: [
        {
          project_id: "proj_missing_audio",
          message: "Peer did not provide the required source audio.",
        },
      ],
      received_artifacts: [
        {
          artifact_id: "art_imported_source",
          content_sha256: "sha256-imported-source",
          size_bytes: 4096,
          status: "received",
          message: "Received source audio.",
        },
      ],
      served_artifact_requests: 1,
      local_manifest_count: 2,
      remote_manifest_count: 4,
    };
    state.syncTransportStatus = {
      ...state.syncTransportStatus,
      last_sync: syncResult,
      last_error: null,
      updated_at: createdAt,
    };
    return clone(syncResult);
  });
  const mockCreateChords = vi.fn(async (projectId: string, body?: Record<string, unknown>) => {
    state.chordsByProject[projectId] = makeChordTimeline(projectId);
    const job = makeMockJob({
      project_id: projectId,
      type: "chords",
      status: "completed",
      progress: 100,
      chord_backend: body?.backend === "crema-advanced" ? "crema-advanced" : "tuneforge-fast",
      chord_backend_fallback_from: body?.backend_fallback_from ?? null,
      chord_source: body?.chord_source ?? "source",
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockCreateLyrics = vi.fn(async (projectId: string, body?: LyricsGenerateRequest) => {
    state.lyricsByProject[projectId] = makeLyricsTranscript(
      projectId,
      body?.language_override ?? null,
    );
    const job = makeMockJob({
      project_id: projectId,
      type: "lyrics",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockCreatePreview = vi.fn(async (projectId: string, body: Record<string, unknown>) => {
    const artifact = {
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type: "preview_mix",
      format: "wav",
      path: `/tmp/${projectId}-mix-${state.nextArtifactId}.wav`,
      metadata: {
        retune: body.retune ?? {},
        transpose: body.transpose ?? {},
      },
      created_at: createdAt,
    };
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "preview",
      status: state.deferPreviewCompletion ? "running" : "completed",
      progress: state.deferPreviewCompletion ? 25 : 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    if (state.deferPreviewCompletion) {
      state.pendingPreviewArtifactsByProject[projectId] = [
        artifact,
        ...(state.pendingPreviewArtifactsByProject[projectId] ?? []),
      ];
    } else {
      state.artifactsByProject[projectId] = [artifact, ...(state.artifactsByProject[projectId] ?? [])];
    }
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockCreateStems = vi.fn(async (
    projectId: string,
    body: {
      source_artifact_id?: string;
      force?: boolean;
      chord_backend?: string;
      overwrite_chord_edits?: boolean;
      stem_model?: string;
    },
  ) => {
    const sourceArtifactId = body.source_artifact_id ?? "art_source";
    const stemModel = body.stem_model === "htdemucs_ft" ? "htdemucs_ft" : "htdemucs_6s";
    const stemSources =
      stemModel === "htdemucs_ft"
        ? [
            ["vocals", "vocal_stem"],
            ["instrumental", "instrumental_stem"],
          ]
        : [
            ["vocals", "vocal_stem"],
            ["drums", "drums_stem"],
            ["bass", "bass_stem"],
            ["guitar", "guitar_stem"],
            ["piano", "piano_stem"],
            ["other", "other_stem"],
          ];
    const stemTypes = new Set(["vocal_stem", "instrumental_stem", "drums_stem", "bass_stem", "guitar_stem", "piano_stem", "other_stem"]);
    state.artifactsByProject[projectId] = (state.artifactsByProject[projectId] ?? []).filter((artifact) => {
      if (!stemTypes.has(String(artifact.type))) return true;
      const metadata = (artifact.metadata ?? {}) as { source_artifact_id?: string };
      return metadata.source_artifact_id !== sourceArtifactId;
    });
    const stemArtifacts = stemSources.map(([source, type]) => ({
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type,
      format: "wav",
      path: `/tmp/${projectId}-${sourceArtifactId}-${source}.wav`,
      metadata: {
        mode: stemModel === "htdemucs_ft" ? "two_stems" : "six_stems",
        stem_model: stemModel,
        stem_source: source,
        engine: "demucs",
        model: stemModel,
        source_artifact_id: sourceArtifactId,
      },
      created_at: createdAt,
    }));
    state.artifactsByProject[projectId] = [
      ...stemArtifacts,
      ...(state.artifactsByProject[projectId] ?? []),
    ];
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "stems",
      status: "completed",
      progress: 100,
      source_artifact_id: sourceArtifactId,
      stem_model: stemModel,
      stem_model_label: stemModel === "htdemucs_ft" ? "2 stems model" : "Default (6 stems model)",
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockAnalyzeProject = vi.fn(async (projectId: string, _body?: AnalysisRequest) => {
    void _body;
    state.analysisByProject[projectId] = {
      project_id: projectId,
      estimated_key: "D major",
      key_confidence: 0.74,
      estimated_reference_hz: 440,
      tuning_offset_cents: 0,
      tempo_bpm: null,
      analysis_version: "v1",
      created_at: createdAt,
    };
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "analyze",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockUpdateProject = vi.fn(async (projectId: string, body: { display_name?: string; source_key_override?: string | null }) => {
    const project = getProjectOrThrow(projectId);
    if (body.display_name !== undefined) {
      project.display_name = body.display_name;
    }
    if ("source_key_override" in body) {
      project.source_key_override = body.source_key_override ?? null;
    }
    project.updated_at = createdAt;
    return { project: clone(project) };
  });

  function retimeWordsForText(segment: Record<string, unknown>, text: string) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const currentWords = Array.isArray(segment.words)
      ? (segment.words as Array<Record<string, unknown>>)
      : [];
    if (!words.length || !currentWords.length) {
      return undefined;
    }
    const segmentStart = Number(segment.start_seconds ?? currentWords[0]?.start_seconds ?? 0);
    const segmentEnd = Number(
      segment.end_seconds ?? currentWords[currentWords.length - 1]?.end_seconds ?? segmentStart + words.length,
    );
    const span = Math.max(segmentEnd - segmentStart, 0.001);
    return words.map((word, index) => {
      const matchedWord = currentWords[Math.min(index, currentWords.length - 1)] ?? {};
      if (index < currentWords.length) {
        return { ...matchedWord, text: word };
      }
      const startSeconds = segmentStart + (span * index) / words.length;
      const endSeconds = segmentStart + (span * (index + 1)) / words.length;
      return {
        confidence: null,
        end_seconds: endSeconds,
        start_seconds: startSeconds,
        text: word,
      };
    });
  }

  const mockUpdateLyrics = vi.fn(async (projectId: string, body: { segments: Array<{ text: string }> }) => {
    const current = clone(
      state.lyricsByProject[projectId] ?? {
        project_id: projectId,
        backend: "openai-whisper",
        source_artifact_id: "art_source",
        source_kind: "ai",
        source_segments: [],
        segments: [],
        has_user_edits: false,
        created_at: createdAt,
        updated_at: createdAt,
      },
    ) as {
      source_segments: Array<Record<string, unknown>>;
      segments: Array<Record<string, unknown>>;
      has_user_edits: boolean;
      updated_at: string;
    };

    current.segments = current.segments.map((segment, index) => {
      const nextText = body.segments[index]?.text ?? String(segment.text ?? "");
      const sourceSegment = current.source_segments[index] ?? null;
      const nextSegment: Record<string, unknown> & { text: string; words?: unknown } = {
        ...segment,
        text: nextText,
      };
      if (sourceSegment && nextText === sourceSegment.text) {
        return clone(sourceSegment);
      }
      if (nextText !== segment.text) {
        const retimedWords = retimeWordsForText(segment, nextText);
        if (retimedWords) {
          nextSegment.words = retimedWords;
        }
      }
      return nextSegment;
    });
    current.has_user_edits =
      JSON.stringify(current.segments) !== JSON.stringify(current.source_segments);
    current.updated_at = createdAt;
    state.lyricsByProject[projectId] = current;
    return clone(current);
  });
  function buildTabImport(projectId: string, rawText: string, tabImportId = `tab_${state.nextTabImportId++}`) {
    const lyrics = state.lyricsByProject[projectId];
    const chords = state.chordsByProject[projectId];
    const project = getProjectOrThrow(projectId);
    const currentLyric = String(((lyrics?.segments as Array<Record<string, unknown>> | undefined)?.[0]?.text) ?? "");
    const currentChord = String(((chords?.timeline as Array<Record<string, unknown>> | undefined)?.[0]?.label) ?? "");
    return {
      id: tabImportId,
      project_id: projectId,
      raw_text: rawText,
      parser_version: "test",
      status: "pending",
      parsed: {
        key: "D",
        sections: [{ label: "Verse" }],
      },
      groups: [
        {
          kind: "lyrics",
          label: "Lyrics",
          suggestions: [
            {
              id: `${tabImportId}_lyrics_1`,
              kind: "lyrics",
              status: "pending",
              title: "Update lyric segment 1",
              current_text: currentLyric,
              suggested_text: "Hello from the fast line",
              start_seconds: 0,
              end_seconds: 8,
              segment_index: 0,
              payload: { text: "Hello from the fast line" },
            },
          ],
        },
        {
          kind: "chords",
          label: "Chords",
          suggestions: [
            {
              id: `${tabImportId}_chord_1`,
              kind: "chords",
              status: "pending",
              title: "Use F# at 00:00",
              current_text: currentChord,
              suggested_text: "F#",
              start_seconds: 0,
              end_seconds: 8,
              chord_index: 0,
              payload: { label: "F#" },
            },
          ],
        },
        {
          kind: "sections",
          label: "Sections",
          suggestions: [
            {
              id: `${tabImportId}_section_1`,
              kind: "sections",
              status: "pending",
              title: "Add Verse section",
              current_text: null,
              suggested_text: "Verse",
              start_seconds: 0,
              end_seconds: null,
              payload: { label: "Verse" },
            },
          ],
        },
        {
          kind: "key",
          label: "Key",
          suggestions: [
            {
              id: `${tabImportId}_key_1`,
              kind: "key",
              status: "pending",
              title: "Set source key to D",
              current_text: String(project.source_key_override ?? "G major"),
              suggested_text: "D",
              start_seconds: null,
              end_seconds: null,
              payload: { source_key: "D" },
            },
          ],
        },
      ],
      created_at: createdAt,
      updated_at: createdAt,
    };
  }
  const mockCreateTabImport = vi.fn(async (projectId: string, body: { raw_text: string }) => {
    const existingTabImport = state.tabImportsByProject[projectId]?.[0] ?? null;
    const existingId = typeof existingTabImport?.id === "string" ? existingTabImport.id : undefined;
    const tabImport = buildTabImport(projectId, body.raw_text, existingId);
    state.tabImportsByProject[projectId] = [tabImport];
    return { tab_import: clone(tabImport) };
  });
  const mockGetTabImport = vi.fn(async (projectId: string, tabImportId: string) => {
    const tabImport = (state.tabImportsByProject[projectId] ?? []).find((item) => item.id === tabImportId);
    if (!tabImport) {
      throw new Error(`Unknown tab import ${tabImportId}`);
    }
    return { tab_import: clone(tabImport) };
  });
  const mockAcceptTabImport = vi.fn(async (projectId: string, tabImportId: string, body: { accepted_suggestion_ids?: string[] }) => {
    const tabImport = (state.tabImportsByProject[projectId] ?? []).find((item) => item.id === tabImportId);
    if (!tabImport) {
      throw new Error(`Unknown tab import ${tabImportId}`);
    }
    const acceptedIds = new Set(body.accepted_suggestion_ids ?? []);
    const groups = (tabImport.groups as Array<Record<string, unknown>>).map((group) => ({
      ...group,
      suggestions: ((group.suggestions as Array<Record<string, unknown>>) ?? []).map((suggestion) => {
        const suggestionId = String(suggestion.id);
        const accepted = acceptedIds.has(suggestionId);
        if (!accepted) {
          return { ...suggestion, status: "ignored" };
        }
        if (suggestion.kind === "lyrics") {
          const currentLyrics = state.lyricsByProject[projectId];
          const segments = (currentLyrics.segments as Array<Record<string, unknown>>).map((segment, index) => {
            if (index !== 0) {
              return segment;
            }
            const suggestedText = String(suggestion.suggested_text ?? "");
            return {
              ...segment,
              text: suggestedText,
              words: retimeWordsForText(segment, suggestedText),
            };
          });
          state.lyricsByProject[projectId] = {
            ...currentLyrics,
            has_user_edits: true,
            segments,
            updated_at: createdAt,
          };
        }
        if (suggestion.kind === "chords") {
          const currentChords = state.chordsByProject[projectId];
          const timeline = (currentChords.timeline as Array<Record<string, unknown>>).map((segment, index) =>
            index === 0
              ? {
                  ...segment,
                  label: "F#",
                  pitch_class: 6,
                  quality: "major",
                }
              : segment,
          );
          state.chordsByProject[projectId] = {
            ...currentChords,
            has_user_edits: true,
            timeline,
            updated_at: createdAt,
          };
        }
        if (suggestion.kind === "sections") {
          const section = {
            id: `section_${state.nextSectionId++}`,
            project_id: projectId,
            tab_import_id: tabImportId,
            label: "Verse",
            start_seconds: 0,
            end_seconds: null,
            source: "tab",
            metadata: {},
            created_at: createdAt,
            updated_at: createdAt,
          };
          state.sectionsByProject[projectId] = [
            ...(state.sectionsByProject[projectId] ?? []),
            section,
          ];
        }
        if (suggestion.kind === "key") {
          const project = getProjectOrThrow(projectId);
          project.source_key_override = "D";
          project.updated_at = createdAt;
        }
        return { ...suggestion, status: "accepted" };
      }),
    }));
    tabImport.groups = groups;
    tabImport.status = "applied";
    tabImport.updated_at = createdAt;
    const allSuggestionIds = groups.flatMap((group) =>
      ((group.suggestions as Array<Record<string, unknown>>) ?? []).map((suggestion) => String(suggestion.id)),
    );
    return {
      tab_import: clone(tabImport),
      accepted_suggestion_ids: Array.from(acceptedIds),
      ignored_suggestion_ids: allSuggestionIds.filter((suggestionId) => !acceptedIds.has(suggestionId)),
      lyrics: clone(state.lyricsByProject[projectId] ?? null),
      chords: clone(state.chordsByProject[projectId] ?? null),
      sections: clone(state.sectionsByProject[projectId] ?? []),
      project: clone(getProjectOrThrow(projectId)),
    };
  });
  const mockListSections = vi.fn(async (projectId: string) => ({
    sections: clone(state.sectionsByProject[projectId] ?? []),
  }));
  const mockCreateExport = vi.fn(async (projectId: string, body: Record<string, unknown>) => {
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "export",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job), request: clone(body) };
  });
  const mockDeleteArtifact = vi.fn(async (projectId: string, artifactId: string) => {
    state.artifactsByProject[projectId] = (state.artifactsByProject[projectId] ?? []).filter((artifact) => {
      if (artifact.id === artifactId) {
        return false;
      }
      const metadata = (artifact.metadata ?? {}) as { source_artifact_id?: string };
      const isStem = [
        "vocal_stem",
        "instrumental_stem",
        "drums_stem",
        "bass_stem",
        "guitar_stem",
        "piano_stem",
        "other_stem",
      ].includes(String(artifact.type));
      if (isStem && metadata.source_artifact_id === artifactId) {
        return false;
      }
      return true;
    });
    return { deleted: true };
  });
  const mockDeleteProject = vi.fn(async (projectId: string) => {
    state.projects = state.projects.filter((project) => project.id !== projectId);
    delete state.analysisByProject[projectId];
    delete state.artifactsByProject[projectId];
    state.jobs = state.jobs.filter((job) => job.project_id !== projectId);
    return { deleted: true };
  });

  return {
    resetMockApiState,
    setProjects,
    setProjectAnalysis,
    setProjectChords,
    setProjectLyrics,
    setBeatBackends,
    setChordBackends,
    setStemModels,
    setJobs,
    setSyncTransportStatus,
    setSyncPreflight,
    setSyncTrustedPeers,
    setDeferredPreviewCompletion,
    flushPendingPreview,
    mockOpen,
    mockSave,
    mockConfirm,
    mockInvoke,
    mockInvokeImplementation,
    mockListProjects,
    mockImportProject,
    mockGetProject,
    mockGetAnalysis,
    mockGetChords,
    mockGetLyrics,
    mockListBeatBackends,
    mockListChordBackends,
    mockListStemModels,
    mockListArtifacts,
    mockListJobs,
    mockCancelJob,
    mockBulkJobs,
    mockGetSyncPreflight,
    mockGetSyncIdentity,
    mockGetSyncTransportStatus,
    mockStartSyncListener,
    mockStopSyncListener,
    mockRecordSyncLifecycleEvent,
    mockCreateSyncPairingOffer,
    mockAnswerSyncPairingOffer,
    mockListSyncTrustedPeers,
    mockTrustSyncPeer,
    mockRevokeSyncTrustedPeer,
    mockSyncTrustedPeerNow,
    mockCreateChords,
    mockCreateLyrics,
    mockCreateTabImport,
    mockCreatePreview,
    mockCreateStems,
    mockAnalyzeProject,
    mockUpdateLyrics,
    mockUpdateProject,
    mockGetTabImport,
    mockAcceptTabImport,
    mockListSections,
    mockCreateExport,
    mockDeleteArtifact,
    mockDeleteProject,
    mockGetHealth,
    mockGetMobileCapabilities,
    mockScanPairingQrCode,
    setMockSystemInputVolume,
    setMockNativeAudio,
    setMockPowerInhibition,
    emitMockNativeAudioError,
    emitMockNativeAudioInputFrame,
    emitMockNativeAudioInputState,
    emitMockNativeAudioPosition,
    emitMockSystemMediaControl,
    getSystemMediaControlListenerCount,
    deferNextSystemMediaControlListen,
    mockListen,
    rejectSystemMediaCommand,
    resolveDeferredSystemMediaControlListen,
  };
});

export {
  resetMockApiState,
  setProjects,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
  setBeatBackends,
  setChordBackends,
  setStemModels,
  setJobs,
  setSyncTransportStatus,
  setSyncPreflight,
  setSyncTrustedPeers,
  setDeferredPreviewCompletion,
  flushPendingPreview,
  mockOpen,
  mockSave,
  mockConfirm,
  mockInvoke,
  mockListProjects,
  mockImportProject,
  mockGetProject,
  mockGetAnalysis,
  mockGetChords,
  mockGetLyrics,
  mockListBeatBackends,
  mockListChordBackends,
  mockListStemModels,
  mockListArtifacts,
  mockListJobs,
  mockCancelJob,
  mockBulkJobs,
  mockGetSyncPreflight,
  mockGetSyncIdentity,
  mockGetSyncTransportStatus,
  mockStartSyncListener,
  mockStopSyncListener,
  mockRecordSyncLifecycleEvent,
  mockCreateSyncPairingOffer,
  mockAnswerSyncPairingOffer,
  mockListSyncTrustedPeers,
  mockTrustSyncPeer,
  mockRevokeSyncTrustedPeer,
  mockSyncTrustedPeerNow,
  mockCreateChords,
  mockCreateLyrics,
  mockCreateTabImport,
  mockCreatePreview,
  mockCreateStems,
  mockAnalyzeProject,
  mockUpdateLyrics,
  mockUpdateProject,
  mockGetTabImport,
  mockAcceptTabImport,
  mockListSections,
  mockCreateExport,
  mockDeleteArtifact,
  mockDeleteProject,
  mockGetHealth,
  mockGetMobileCapabilities,
  mockScanPairingQrCode,
  mockListen,
};

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
  save: mockSave,
  confirm: mockConfirm,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: mockInvoke,
  isTauri: () => Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getHealth: mockGetHealth,
      listProjects: mockListProjects,
      importProject: mockImportProject,
      getProject: mockGetProject,
      getAnalysis: mockGetAnalysis,
      getChords: mockGetChords,
      getLyrics: mockGetLyrics,
      listBeatBackends: mockListBeatBackends,
      listChordBackends: mockListChordBackends,
      listStemModels: mockListStemModels,
      listArtifacts: mockListArtifacts,
      listJobs: mockListJobs,
      cancelJob: mockCancelJob,
      bulkJobs: mockBulkJobs,
      getSyncPreflight: mockGetSyncPreflight,
      getSyncIdentity: mockGetSyncIdentity,
      getSyncTransportStatus: mockGetSyncTransportStatus,
      startSyncListener: mockStartSyncListener,
      stopSyncListener: mockStopSyncListener,
      recordSyncLifecycleEvent: mockRecordSyncLifecycleEvent,
      createSyncPairingOffer: mockCreateSyncPairingOffer,
      answerSyncPairingOffer: mockAnswerSyncPairingOffer,
      listSyncTrustedPeers: mockListSyncTrustedPeers,
      trustSyncPeer: mockTrustSyncPeer,
      revokeSyncTrustedPeer: mockRevokeSyncTrustedPeer,
      syncTrustedPeerNow: mockSyncTrustedPeerNow,
      createChords: mockCreateChords,
      createLyrics: mockCreateLyrics,
      createTabImport: mockCreateTabImport,
      getTabImport: mockGetTabImport,
      acceptTabImport: mockAcceptTabImport,
      listSections: mockListSections,
      createPreview: mockCreatePreview,
      createStems: mockCreateStems,
      analyzeProject: mockAnalyzeProject,
      updateLyrics: mockUpdateLyrics,
      updateProject: mockUpdateProject,
      createExport: mockCreateExport,
      deleteArtifact: mockDeleteArtifact,
      deleteProject: mockDeleteProject,
      getMobileCapabilities: mockGetMobileCapabilities,
    },
  };
});

vi.mock("../lib/pairingQrScanner", () => ({
  scanPairingQrCode: mockScanPairingQrCode,
}));

export function renderApp(initialEntries: string[]) {
  if (
    initialEntries.some((entry) => entry.startsWith("/projects/")) &&
    !window.localStorage.getItem("tuneforge.ui-preferences")
  ) {
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({ defaultSourcesRailCollapsed: false }),
    );
  }

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

export function hasAriaKeyLabel(element: Element | null, label: string) {
  return element?.getAttribute("aria-label") === label;
}

export function getByAriaKeyLabel(container: HTMLElement, label: string) {
  return within(container).getByText((_, element) => hasAriaKeyLabel(element, label));
}

export function getAllByAriaKeyLabel(container: HTMLElement, label: string) {
  return within(container).getAllByText((_, element) => hasAriaKeyLabel(element, label));
}

export function queryByAriaKeyLabel(container: HTMLElement, label: string) {
  return within(container).queryByText((_, element) => hasAriaKeyLabel(element, label));
}

type MockIntersectionObserverCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver,
) => void;

const mockIntersectionObservers: MockIntersectionObserver[] = [];

function normalizeMockRootMargin(rootMargin: string | undefined) {
  const value = rootMargin?.trim() || "0px";
  const parts = value.split(/\s+/);
  if (parts.length > 4 || parts.some((part) => !/^-?(?:\d+|\d*\.\d+)(px|%)$/.test(part))) {
    throw new SyntaxError("Failed to construct 'IntersectionObserver': rootMargin must be specified in pixels or percent.");
  }
  return value;
}

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string;
  readonly scrollMargin = "";
  readonly thresholds: ReadonlyArray<number> = [];
  readonly observedElements = new Set<Element>();

  constructor(
    private readonly callback: MockIntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.rootMargin = normalizeMockRootMargin(options?.rootMargin);
    mockIntersectionObservers.push(this);
  }

  disconnect() {
    this.observedElements.clear();
  }

  observe(target: Element) {
    this.observedElements.add(target);
  }

  takeRecords() {
    return [];
  }

  unobserve(target: Element) {
    this.observedElements.delete(target);
  }

  trigger(isIntersecting = true) {
    const entries = Array.from(this.observedElements, (target) => ({
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      isIntersecting,
      rootBounds: null,
      target,
      time: 0,
    }));
    if (entries.length) {
      this.callback(entries as IntersectionObserverEntry[], this);
    }
  }
}

function installMockIntersectionObserver() {
  mockIntersectionObservers.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
}

export function triggerMockIntersectionObserver(isIntersecting = true) {
  for (const observer of mockIntersectionObservers) {
    observer.trigger(isIntersecting);
  }
}

export function installMatchMediaMock(initialMatches = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialMatches;

  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_eventName: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_eventName: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      listeners.forEach((listener) =>
        listener({ matches: nextMatches } as MediaQueryListEvent),
      );
    },
  };
}

export function findAudioByArtifactId(artifactId: string) {
  const element = Array.from(document.querySelectorAll("audio")).find((candidate) =>
    candidate.getAttribute("src")?.includes(`/artifacts/${artifactId}/stream`),
  );
  if (!element) {
    throw new Error(`Audio element not found for artifact ${artifactId}`);
  }
  return element as HTMLAudioElement;
}

export function setAudioPlaybackState(
  element: HTMLAudioElement,
  { duration = 182, readyState = HTMLMediaElement.HAVE_FUTURE_DATA }: {
    duration?: number;
    readyState?: number;
  } = {},
) {
  Object.defineProperty(element, "duration", {
    configurable: true,
    value: duration,
  });
  Object.defineProperty(element, "readyState", {
    configurable: true,
    value: readyState,
  });
}

export function markAudioReady(element: HTMLAudioElement, duration = 182) {
  setAudioPlaybackState(element, { duration });
  fireEvent.loadedMetadata(element);
  fireEvent.canPlay(element);
  fireEvent.seeked(element);
}

export function getMockAudioContexts() {
  return (
    globalThis as typeof globalThis & {
      __mockAudioContexts: Array<{
        createdAnalysers: Array<{
          setSamples: (samples: Float32Array | null) => void;
        }>;
        createdOscillators: Array<{
          disconnect: ReturnType<typeof vi.fn>;
          frequency: {
            setValueAtTime: ReturnType<typeof vi.fn>;
          };
          start: ReturnType<typeof vi.fn>;
          stop: ReturnType<typeof vi.fn>;
        }>;
        createdMediaStreamSources: Array<{
          connect: ReturnType<typeof vi.fn>;
        }>;
        createdSources: Array<{
          onended: AudioBufferSourceNode["onended"];
          start: ReturnType<typeof vi.fn>;
        }>;
        close: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
      }>;
    }
  ).__mockAudioContexts;
}

export function setMockAudioContextInitialState(state: AudioContextState) {
  (
    globalThis as typeof globalThis & {
      __setMockAudioContextInitialState: (state: AudioContextState) => void;
    }
  ).__setMockAudioContextInitialState(state);
}

export function setMockAudioSourceStartError(error: Error | null) {
  (
    globalThis as typeof globalThis & {
      __setMockAudioSourceStartError: (error: Error | null) => void;
    }
  ).__setMockAudioSourceStartError(error);
}

export function getMockFetch() {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

export function getMockInvoke() {
  return mockInvoke;
}

export function setMockSystemInputVolumeState(
  nextState: Parameters<typeof setMockSystemInputVolume>[0],
) {
  setMockSystemInputVolume(nextState);
}

export function setMockNativeAudioState(
  nextState: Parameters<typeof setMockNativeAudio>[0],
) {
  setMockNativeAudio(nextState);
}

export function setMockPowerInhibitionState(
  nextState: Parameters<typeof setMockPowerInhibition>[0],
) {
  setMockPowerInhibition(nextState);
}

export function emitMockNativeInputFrame(
  frame: Parameters<typeof emitMockNativeAudioInputFrame>[0],
) {
  emitMockNativeAudioInputFrame(frame);
}

export function emitMockNativeInputState() {
  emitMockNativeAudioInputState();
}

export function emitMockNativePlaybackPosition(
  position: Parameters<typeof emitMockNativeAudioPosition>[0],
) {
  emitMockNativeAudioPosition(position);
}

export function emitMockNativePlaybackError(
  error: Parameters<typeof emitMockNativeAudioError>[0],
) {
  emitMockNativeAudioError(error);
}

export function emitMockSystemMediaPlaybackControl(
  payload: Parameters<typeof emitMockSystemMediaControl>[0],
) {
  emitMockSystemMediaControl(payload);
}

export function getMockSystemMediaControlListenerCount() {
  return getSystemMediaControlListenerCount();
}

export function deferNextMockSystemMediaControlListen() {
  deferNextSystemMediaControlListen();
}

export function resolveDeferredMockSystemMediaControlListen() {
  resolveDeferredSystemMediaControlListen();
}

export function rejectMockSystemMediaCommand(
  command:
    | "system_media_update_state"
    | "system_media_clear_state"
    | "system_media_set_idle_inhibition",
  message: string,
) {
  rejectSystemMediaCommand(command, message);
}

export function getMockMediaDevices() {
  return (
    globalThis as typeof globalThis & {
      __mockMediaDevices: {
        clearGetUserMediaError: () => void;
        enumerateDevices: ReturnType<typeof vi.fn>;
        getUserMedia: ReturnType<typeof vi.fn>;
        revealLabels: () => void;
        rejectGetUserMedia: (error: Error | DOMException) => void;
        reset: () => void;
        setDevices: (devices: MediaDeviceInfo[]) => void;
      };
    }
  ).__mockMediaDevices;
}

export function getMockMediaSession() {
  return (
    globalThis as typeof globalThis & {
      __mockMediaSession: MediaSession & {
        actionHandlers: Map<string, (details?: MediaSessionActionDetails) => void>;
        dispatchAction: (action: string, details?: MediaSessionActionDetails) => void;
        reset: () => void;
        setActionHandler: ReturnType<typeof vi.fn>;
        setPositionState: ReturnType<typeof vi.fn>;
        throwOnAction: (action: MediaSessionAction | "seekto") => void;
      };
    }
  ).__mockMediaSession;
}

export function getMockWakeLock() {
  return (
    globalThis as typeof globalThis & {
      __mockWakeLock: {
        request: ReturnType<typeof vi.fn>;
        reset: () => void;
        sentinels: Array<{
          dispatchRelease: () => void;
          released: boolean;
          release: ReturnType<typeof vi.fn>;
        }>;
      };
    }
  ).__mockWakeLock;
}


export function resetAppTestHarness() {
  resetMockApiState();
  resetPlaybackE2ETelemetry();
  resetPowerInhibitionDiagnostics();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  mockOpen.mockReset();
  mockSave.mockReset();
  mockConfirm.mockReset();
  mockInvoke.mockImplementation(mockInvokeImplementation);
  mockInvoke.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  mockListen.mockClear();
  mockConfirm.mockResolvedValue(true);
  getMockMediaSession().reset();
  getMockWakeLock().reset();
  getMockMediaDevices().reset();
  mockListProjects.mockClear();
  mockImportProject.mockClear();
  mockGetProject.mockClear();
  mockGetAnalysis.mockClear();
  mockGetChords.mockClear();
  mockGetLyrics.mockClear();
  mockListArtifacts.mockClear();
  mockListJobs.mockClear();
  mockCancelJob.mockClear();
  mockBulkJobs.mockClear();
  mockGetSyncIdentity.mockClear();
  mockGetSyncTransportStatus.mockClear();
  mockStartSyncListener.mockClear();
  mockStopSyncListener.mockClear();
  mockRecordSyncLifecycleEvent.mockClear();
  mockCreateSyncPairingOffer.mockClear();
  mockAnswerSyncPairingOffer.mockClear();
  mockListSyncTrustedPeers.mockClear();
  mockTrustSyncPeer.mockClear();
  mockRevokeSyncTrustedPeer.mockClear();
  mockSyncTrustedPeerNow.mockClear();
  mockCreateChords.mockClear();
  mockCreateLyrics.mockClear();
  mockCreateTabImport.mockClear();
  mockGetTabImport.mockClear();
  mockAcceptTabImport.mockClear();
  mockListSections.mockClear();
  mockCreatePreview.mockClear();
  mockCreateStems.mockClear();
  mockAnalyzeProject.mockClear();
  mockUpdateLyrics.mockClear();
  mockUpdateProject.mockClear();
  mockCreateExport.mockClear();
  mockDeleteArtifact.mockClear();
  mockDeleteProject.mockClear();
  mockGetHealth.mockClear();
  mockGetMobileCapabilities.mockReset();
  mockGetMobileCapabilities.mockResolvedValue(null);
  mockScanPairingQrCode.mockReset();
  mockScanPairingQrCode.mockRejectedValue(new Error("QR scanner unavailable."));
  vi.mocked(window.HTMLMediaElement.prototype.play).mockImplementation(function play(
    this: HTMLMediaElement,
  ) {
    queueMicrotask(() => this.dispatchEvent(new Event("playing", { bubbles: true })));
    return Promise.resolve();
  });
  vi.mocked(window.HTMLMediaElement.prototype.play).mockClear();
  vi.mocked(window.HTMLMediaElement.prototype.pause).mockClear();
  getMockFetch().mockClear();
  getMockAudioContexts().length = 0;
  setMockAudioContextInitialState("running");
  setMockAudioSourceStartError(null);
  getMockMediaDevices().reset();
  installMatchMediaMock(false);
  installMockIntersectionObserver();
}
