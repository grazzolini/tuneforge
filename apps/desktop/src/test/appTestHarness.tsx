import { fireEvent, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import App from "../App";

const {
  resetMockApiState,
  setProjects,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
  setChordBackends,
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
  mockListChordBackends,
  mockListArtifacts,
  mockListJobs,
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
  setMockSystemInputVolume,
} = vi.hoisted(() => {
  const createdAt = "2026-04-18T13:16:00.000Z";
  let state: {
    projects: Array<Record<string, unknown>>;
    analysisByProject: Record<string, Record<string, unknown> | null>;
    chordsByProject: Record<string, Record<string, unknown>>;
    lyricsByProject: Record<string, Record<string, unknown>>;
    tabImportsByProject: Record<string, Array<Record<string, unknown>>>;
    sectionsByProject: Record<string, Array<Record<string, unknown>>>;
    artifactsByProject: Record<string, Array<Record<string, unknown>>>;
    chordBackends: Array<Record<string, unknown>>;
    pendingPreviewArtifactsByProject: Record<string, Array<Record<string, unknown>>>;
    jobs: Array<Record<string, unknown>>;
    snapshotFiles: Record<string, string>;
    systemInputVolume: {
      supported: boolean;
      volumePercent: number | null;
      muted: boolean | null;
      backend: string | null;
      error: string | null;
    };
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

  function makeLyricsTranscript(projectId: string) {
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
      backend: "openai-whisper",
      source_artifact_id: "art_source",
      source_kind: "ai",
      source_segments: clone(segments),
      segments: clone(segments),
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

  function setChordBackends(backends: Array<Record<string, unknown>>) {
    state.chordBackends = clone(backends);
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
    state.jobs = state.jobs.map((job) =>
      job.project_id === projectId && job.type === "preview" && job.status !== "completed"
        ? { ...job, status: "completed", progress: 100, updated_at: createdAt }
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
      chordBackends: makeChordBackends(),
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
      snapshotFiles: {},
      systemInputVolume: {
        supported: true,
        volumePercent: 64,
        muted: false,
        backend: "test",
        error: null,
      },
      nextProjectId: 200,
      nextArtifactId: 200,
      nextJobId: 200,
      nextTabImportId: 200,
      nextSectionId: 200,
      deferPreviewCompletion: false,
    };
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
  const mockInvoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "backend_base_url") {
      return "http://127.0.0.1:8765";
    }

    if (command === "write_settings_snapshot_file") {
      const path = String(args?.path ?? "");
      state.snapshotFiles[path] = String(args?.contents ?? "");
      return null;
    }

    if (command === "read_settings_snapshot_file") {
      const path = String(args?.path ?? "");
      const contents = state.snapshotFiles[path];
      if (contents === undefined) {
        throw new Error(`Missing snapshot file: ${path}`);
      }
      return contents;
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

    throw new Error(`Unexpected invoke command: ${command}`);
  });
  const mockGetHealth = vi.fn(async () => ({
    status: "ok",
    api_base_url: "http://127.0.0.1:8765/api/v1",
    data_root: "/tmp/tuneforge",
    default_export_format: "wav",
    preview_format: "wav",
  }));
  const mockGetMobileCapabilities = vi.fn(async (): Promise<unknown> => null);
  const mockListChordBackends = vi.fn(async () => ({ backends: clone(state.chordBackends) }));
  const mockListProjects = vi.fn(async (search?: string) => {
    const normalizedSearch = search?.trim().toLowerCase();
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
    return { projects: clone(filteredProjects) };
  });
  const mockImportProject = vi.fn(async ({ source_path }: { source_path: string }) => {
    const id = `proj_${state.nextProjectId++}`;
    const baseName = source_path.split("/").pop() ?? "Imported Track";
    const displayName = titleize(baseName);
    const project = makeProject(id, displayName, source_path);
    state.projects.unshift(project);
    state.analysisByProject[id] = null;
    state.artifactsByProject[id] = [
      {
        id: `art_${state.nextArtifactId++}`,
        project_id: id,
        type: "source_audio",
        format: "wav",
        path: source_path,
        metadata: {},
        created_at: createdAt,
      },
    ];
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
  const mockListJobs = vi.fn(async () => ({ jobs: clone(state.jobs) }));
  const mockCreateChords = vi.fn(async (projectId: string, body?: Record<string, unknown>) => {
    state.chordsByProject[projectId] = makeChordTimeline(projectId);
    const job = {
      id: `job_${state.nextJobId++}`,
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
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockCreateLyrics = vi.fn(async (projectId: string, body?: { force?: boolean }) => {
    void body;
    state.lyricsByProject[projectId] = makeLyricsTranscript(projectId);
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "lyrics",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
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
    body: { source_artifact_id?: string; force?: boolean; chord_backend?: string; overwrite_chord_edits?: boolean },
  ) => {
    const sourceArtifactId = body.source_artifact_id ?? "art_source";
    state.artifactsByProject[projectId] = (state.artifactsByProject[projectId] ?? []).filter((artifact) => {
      if (artifact.type !== "vocal_stem" && artifact.type !== "instrumental_stem") return true;
      const metadata = (artifact.metadata ?? {}) as { source_artifact_id?: string };
      return metadata.source_artifact_id !== sourceArtifactId;
    });
    const vocalArtifact = {
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type: "vocal_stem",
      format: "wav",
      path: `/tmp/${projectId}-${sourceArtifactId}-vocals.wav`,
      metadata: {
        mode: "two_stem",
        engine: "demucs",
        source_artifact_id: sourceArtifactId,
      },
      created_at: createdAt,
    };
    const instrumentalArtifact = {
      id: `art_${state.nextArtifactId++}`,
      project_id: projectId,
      type: "instrumental_stem",
      format: "wav",
      path: `/tmp/${projectId}-${sourceArtifactId}-instrumental.wav`,
      metadata: {
        mode: "two_stem",
        engine: "demucs",
        source_artifact_id: sourceArtifactId,
      },
      created_at: createdAt,
    };
    state.artifactsByProject[projectId] = [
      vocalArtifact,
      instrumentalArtifact,
      ...(state.artifactsByProject[projectId] ?? []),
    ];
    const job = {
      id: `job_${state.nextJobId++}`,
      project_id: projectId,
      type: "stems",
      status: "completed",
      progress: 100,
      source_artifact_id: sourceArtifactId,
      error_message: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    state.jobs.unshift(job);
    return { job: clone(job) };
  });
  const mockAnalyzeProject = vi.fn(async (projectId: string) => {
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
      if ((artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") && metadata.source_artifact_id === artifactId) {
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
    setChordBackends,
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
    mockListChordBackends,
    mockListArtifacts,
    mockListJobs,
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
    setMockSystemInputVolume,
  };
});

export {
  resetMockApiState,
  setProjects,
  setProjectAnalysis,
  setProjectChords,
  setProjectLyrics,
  setChordBackends,
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
  mockListChordBackends,
  mockListArtifacts,
  mockListJobs,
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
};

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
  save: mockSave,
  confirm: mockConfirm,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: mockInvoke,
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
      listChordBackends: mockListChordBackends,
      listArtifacts: mockListArtifacts,
      listJobs: mockListJobs,
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
          start: ReturnType<typeof vi.fn>;
          stop: ReturnType<typeof vi.fn>;
        }>;
        createdMediaStreamSources: Array<{
          connect: ReturnType<typeof vi.fn>;
        }>;
        createdSources: Array<{
          start: ReturnType<typeof vi.fn>;
        }>;
        close: ReturnType<typeof vi.fn>;
      }>;
    }
  ).__mockAudioContexts;
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


export function resetAppTestHarness() {
  resetMockApiState();
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  mockOpen.mockReset();
  mockSave.mockReset();
  mockConfirm.mockReset();
  mockInvoke.mockClear();
  mockConfirm.mockResolvedValue(true);
  mockListProjects.mockClear();
  mockImportProject.mockClear();
  mockGetProject.mockClear();
  mockGetAnalysis.mockClear();
  mockGetChords.mockClear();
  mockGetLyrics.mockClear();
  mockListArtifacts.mockClear();
  mockListJobs.mockClear();
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
  mockGetMobileCapabilities.mockClear();
  vi.mocked(window.HTMLMediaElement.prototype.play).mockClear();
  vi.mocked(window.HTMLMediaElement.prototype.pause).mockClear();
  getMockFetch().mockClear();
  getMockAudioContexts().length = 0;
  getMockMediaDevices().reset();
  installMatchMediaMock(false);
}
