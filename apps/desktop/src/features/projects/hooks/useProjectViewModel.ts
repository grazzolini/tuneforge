import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { api, type ArtifactSchema, type ProjectSchema } from "../../../lib/api";
import { usePreferences } from "../../../lib/preferences";
import { usePlayback } from "../playback-context";
import {
  DEFAULT_PRECOUNT_CLICK_COUNT,
  MAX_PRECOUNT_CLICK_COUNT,
  MIN_PRECOUNT_CLICK_COUNT,
  clearProjectPlaybackState,
  hasProjectPlaybackState,
  normalizePrecountClickCount,
  readProjectPlaybackState,
  writeProjectPlaybackState,
  type ProjectPanelMode,
  type StemControlState,
} from "../projectPlaybackState";
import {
  DEFAULT_KEY,
  MUSICAL_KEYS,
  parseKey,
  parseStoredKey,
  semitoneDelta,
  serializeKey,
  transposeKey,
} from "../../../lib/music";
import { useActiveJobPolling } from "./useActiveJobPolling";
import {
  MAX_TARGET_TRANSPOSE,
  MIN_TARGET_TRANSPOSE,
  artifactById,
  artifactLabel,
  artifactSummary,
  artifactTransposeSemitones,
  buildLeadSheetRows,
  clampTargetTranspose,
  fileNameFromPath,
  findActiveChordIndex,
  findActiveLyricsIndex,
  findActiveLyricsWordIndex,
  formatArtifactTimestamp,
  formatCapoShiftSummary,
  formatRetuneSummary,
  formatSemitoneShift,
  formatTargetSelectionSummary,
  hasTimedLyrics,
  isPlayableArtifact,
  isStemArtifact,
  preferredArtifactSelection,
  sourceArtifactIdForStems,
  transposeChordSegment,
  type SeekDirection,
  type SourceKeyOption,
  type TargetShiftOption,
} from "../projectViewUtils";
import type { DefaultPlaybackDisplayMode, PlaybackDisplayMode } from "../../../lib/preferences";
import { useChordBackendActionSelection } from "./useChordBackendActionSelection";

type PlaybackDisplayModeSource = "default" | "stored" | "user";

function resolveDefaultPlaybackDisplayMode(
  defaultMode: DefaultPlaybackDisplayMode,
  hasLyricsTranscript: boolean,
  hasChordTimeline: boolean,
): PlaybackDisplayMode {
  if (defaultMode !== "auto") {
    return defaultMode;
  }
  if (hasLyricsTranscript && hasChordTimeline) {
    return "combined";
  }
  if (hasLyricsTranscript) {
    return "lyrics";
  }
  if (hasChordTimeline) {
    return "chords";
  }
  return "combined";
}

export function useProjectViewModel() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    activateStemPlayback,
    dismissSession,
    isPlaying,
    playbackDurationSeconds,
    playbackTimeSeconds,
    registerProjectSession,
    seekBy,
    seekTo,
    stopPlayback,
    togglePlayback,
  } = usePlayback();
  const {
    defaultPlaybackDisplayMode,
    defaultChordsFollowEnabled,
    defaultInspectorOpen,
    defaultLyricsFollowEnabled,
    defaultProjectWorkspace,
    defaultSourcesRailCollapsed,
    enharmonicDisplayMode,
    informationDensity,
  } = usePreferences();
  const { chordBackendForAction } = useChordBackendActionSelection();
  const chordSegmentRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const chordTimelineRef = useRef<HTMLDivElement | null>(null);
  const combinedLeadSheetRef = useRef<HTMLDivElement | null>(null);
  const combinedLeadSheetRowRefs = useRef<Record<string, HTMLElement | null>>({});
  const lyricsSegmentRefs = useRef<Record<string, HTMLElement | null>>({});
  const lyricsTheaterRef = useRef<HTMLDivElement | null>(null);
  const playbackTransportRef = useRef<HTMLDivElement | null>(null);
  const pendingPreviewSelection = useRef<{ previousLatestPreviewArtifactId: string | null } | null>(
    null,
  );
  const persistedStemSourceArtifactId = useRef<string | null>(null);
  const wasPlayingRef = useRef(isPlaying);
  const targetSelectorRef = useRef<HTMLDivElement | null>(null);
  const targetOptionRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const capoSelectorRef = useRef<HTMLDivElement | null>(null);
  const capoOptionRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const sourceKeySelectorRef = useRef<HTMLDivElement | null>(null);
  const sourceKeyOptionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [retuneMode, setRetuneMode] = useState<"off" | "reference" | "cents">("off");
  const [referenceHz, setReferenceHz] = useState("440");
  const [centsOffset, setCentsOffset] = useState("0");
  const [seekAnimationRevision, setSeekAnimationRevision] = useState<Record<SeekDirection, number>>({
    backward: 0,
    forward: 0,
  });
  const [targetTransposeSemitones, setTargetTransposeSemitones] = useState(0);
  const [targetSelectorOpen, setTargetSelectorOpen] = useState(false);
  const [capoTransposeSemitones, setCapoTransposeSemitones] = useState(0);
  const [capoSelectorOpen, setCapoSelectorOpen] = useState(false);
  const [precountEnabled, setPrecountEnabled] = useState(false);
  const [precountClickCount, setPrecountClickCount] = useState(DEFAULT_PRECOUNT_CLICK_COUNT);
  const [sourceKeySelectorOpen, setSourceKeySelectorOpen] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [selectedPrimaryArtifactId, setSelectedPrimaryArtifactId] = useState<string | null>(null);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(defaultInspectorOpen);
  const [sourcesRailCollapsed, setSourcesRailCollapsed] = useState(defaultSourcesRailCollapsed);
  const [activeWorkspace, setActiveWorkspace] = useState(defaultProjectWorkspace);
  const [activeProjectPanel, setActiveProjectPanel] = useState<ProjectPanelMode>("studio");
  const [playbackDisplayMode, setPlaybackDisplayMode] = useState<PlaybackDisplayMode>("combined");
  const [playbackDisplayModeSource, setPlaybackDisplayModeSource] =
    useState<PlaybackDisplayModeSource>("default");
  const [stemControls, setStemControls] = useState<Record<string, StemControlState>>({});
  const [dismissedStemJobIds, setDismissedStemJobIds] = useState<string[]>([]);
  const [isEditingLyrics, setIsEditingLyrics] = useState(false);
  const [lyricsDraft, setLyricsDraft] = useState<string[]>([]);
  const [isTabImportOpen, setIsTabImportOpen] = useState(false);
  const [tabImportDraft, setTabImportDraft] = useState("");
  const [acceptedTabSuggestionIds, setAcceptedTabSuggestionIds] = useState<string[]>([]);
  const [selectedTabSuggestionId, setSelectedTabSuggestionId] = useState<string | null>(null);
  const [lyricsFollowEnabled, setLyricsFollowEnabled] = useState(defaultLyricsFollowEnabled);
  const [chordsFollowEnabled, setChordsFollowEnabled] = useState(defaultChordsFollowEnabled);
  const showSupportingCopy = informationDensity !== "minimal";

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => (await api.getProject(projectId)).project,
    enabled: Boolean(projectId),
  });
  const analysisQuery = useQuery({
    queryKey: ["analysis", projectId],
    queryFn: async () => (await api.getAnalysis(projectId)).analysis,
    enabled: Boolean(projectId),
  });
  const chordsQuery = useQuery({
    queryKey: ["chords", projectId],
    queryFn: async () => api.getChords(projectId),
    enabled: Boolean(projectId),
  });
  const lyricsQuery = useQuery({
    queryKey: ["lyrics", projectId],
    queryFn: async () => api.getLyrics(projectId),
    enabled: Boolean(projectId),
  });
  const sectionsQuery = useQuery({
    queryKey: ["sections", projectId],
    queryFn: async () => api.listSections(projectId),
    enabled: Boolean(projectId),
  });
  const artifactsQuery = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: async () => (await api.listArtifacts(projectId)).artifacts,
    enabled: Boolean(projectId),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => (await api.listJobs()).jobs,
  });
  const mobileCapabilitiesQuery = useQuery({
    queryKey: ["mobile-capabilities"],
    queryFn: async () => api.getMobileCapabilities(),
    staleTime: Infinity,
  });

  useActiveJobPolling(projectId, jobsQuery.data);

  const analyzeMutation = useMutation({
    mutationFn: () => api.analyzeProject(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async () => api.updateProject(projectId, { display_name: draftName }),
    onSuccess: async () => {
      setIsRenaming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });

  const sourceKeyOverrideMutation = useMutation({
    mutationFn: async (sourceKeyOverride: string | null) =>
      api.updateProject(projectId, { source_key_override: sourceKeyOverride }),
    onMutate: async (sourceKeyOverride) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["project", projectId] }),
        queryClient.cancelQueries({ queryKey: ["projects"] }),
      ]);

      const previousProject = queryClient.getQueryData<ProjectSchema>(["project", projectId]);
      const previousProjects = queryClient.getQueryData<ProjectSchema[]>(["projects"]);

      queryClient.setQueryData<ProjectSchema>(["project", projectId], (current) =>
        current ? { ...current, source_key_override: sourceKeyOverride } : current,
      );
      queryClient.setQueryData<ProjectSchema[]>(["projects"], (current) =>
        current?.map((project) =>
          project.id === projectId ? { ...project, source_key_override: sourceKeyOverride } : project,
        ) ?? current,
      );

      return { previousProject, previousProjects };
    },
    onError: (_error, _sourceKeyOverride, context) => {
      if (context?.previousProject) {
        queryClient.setQueryData(["project", projectId], context.previousProject);
      }
      if (context?.previousProjects) {
        queryClient.setQueryData(["projects"], context.previousProjects);
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });

  const chordMutation = useMutation({
    mutationFn: async (overwriteUserEdits: boolean) => {
      const backendSelection = await chordBackendForAction();
      return api.createChords(projectId, {
        ...backendSelection,
        force: (chordsQuery.data?.timeline?.length ?? 0) > 0,
        overwrite_user_edits: overwriteUserEdits,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["chords", projectId] }),
      ]);
    },
  });

  const lyricsMutation = useMutation({
    mutationFn: async (force: boolean) => api.createLyrics(projectId, { force }),
    onSuccess: async () => {
      setIsEditingLyrics(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["lyrics", projectId] }),
      ]);
    },
  });

  const lyricsSaveMutation = useMutation({
    mutationFn: async () =>
      api.updateLyrics(projectId, {
        segments: lyricsDraft.map((text) => ({ text })),
      }),
    onSuccess: async () => {
      setIsEditingLyrics(false);
      await queryClient.invalidateQueries({ queryKey: ["lyrics", projectId] });
    },
  });

  const tabImportMutation = useMutation({
    mutationFn: async (rawText: string) => api.createTabImport(projectId, { raw_text: rawText }),
    onSuccess: (response) => {
      const firstSuggestion =
        response.tab_import.groups?.flatMap((group) => group.suggestions ?? [])[0] ?? null;
      setAcceptedTabSuggestionIds([]);
      setSelectedTabSuggestionId(firstSuggestion?.id ?? null);
    },
  });

  const tabImportApplyMutation = useMutation({
    mutationFn: async () => {
      const tabImportId = tabImportMutation.data?.tab_import.id;
      if (!tabImportId) {
        throw new Error("Create tab suggestions first.");
      }
      return api.acceptTabImport(projectId, tabImportId, {
        accepted_suggestion_ids: acceptedTabSuggestionIds,
      });
    },
    onSuccess: async () => {
      setIsTabImportOpen(false);
      setAcceptedTabSuggestionIds([]);
      setSelectedTabSuggestionId(null);
      setTabImportDraft("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["lyrics", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["chords", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["sections", projectId] }),
      ]);
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (retuneMode === "off" && transposeSemitones === 0) {
        throw new Error("Choose a tuning or key change first.");
      }

      pendingPreviewSelection.current = {
        previousLatestPreviewArtifactId: latestPreviewArtifact?.id ?? null,
      };

      return api.createPreview(projectId, {
        output_format: "wav",
        retune:
          retuneMode === "reference"
            ? { target_reference_hz: Number(referenceHz) }
            : retuneMode === "cents"
              ? { target_cents_offset: Number(centsOffset) }
              : undefined,
        transpose: transposeSemitones !== 0 ? { semitones: transposeSemitones } : undefined,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
      ]);
    },
    onError: () => {
      pendingPreviewSelection.current = null;
    },
  });

  const stemMutation = useMutation({
    mutationFn: async (overwriteChordEdits: boolean) => {
      if (!selectedPrimaryArtifactId) {
        throw new Error("Select source audio or practice mix first.");
      }
      const backendSelection = await chordBackendForAction();
      return api.createStems(projectId, {
        mode: "two_stem",
        output_format: "wav",
        chord_backend: backendSelection.backend,
        chord_backend_fallback_from: backendSelection.backend_fallback_from,
        force: hasVisibleStems,
        source_artifact_id: selectedPrimaryArtifactId,
        overwrite_chord_edits: overwriteChordEdits,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
      ]);
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const exportArtifact =
        selectedArtifact ??
        primaryArtifacts.find((artifact) => artifact.type === "preview_mix") ??
        primaryArtifacts.find((artifact) => artifact.type === "source_audio");
      if (!exportArtifact) {
        throw new Error("Nothing available to export yet.");
      }
      const suggestedFormat = exportArtifact.format;
      const exportTarget = await save({
        defaultPath: `${projectQuery.data?.display_name ?? artifactLabel(exportArtifact)}.${suggestedFormat}`,
      });
      const destinationPath = exportTarget
        ? exportTarget.slice(0, exportTarget.lastIndexOf("/"))
        : undefined;
      const extension = exportTarget?.split(".").pop()?.toLowerCase();
      return api.createExport(projectId, {
        artifact_ids: [exportArtifact.id],
        mixdown_mode: "copy",
        output_format:
          extension === "mp3" || extension === "flac" ? extension : "wav",
        destination_path: destinationPath,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: async () => {
      dismissSession();
      clearProjectPlaybackState(projectId);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/");
    },
  });

  const deleteMixMutation = useMutation({
    mutationFn: async () => {
      if (!selectedArtifact || selectedArtifact.type !== "preview_mix") {
        throw new Error("Select a saved practice mix first.");
      }
      return api.deleteArtifact(projectId, selectedArtifact.id);
    },
    onSuccess: async () => {
      setSelectedArtifactId(null);
      await queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] });
    },
  });

  const projectJobs = useMemo(
    () => jobsQuery.data?.filter((job) => job.project_id === projectId) ?? [],
    [jobsQuery.data, projectId],
  );
  const analyzeJob = projectJobs.find((job) => job.type === "analyze");
  const chordJob = projectJobs.find((job) => job.type === "chords");
  const lyricsJob = projectJobs.find((job) => job.type === "lyrics");
  const stemJobs = useMemo(
    () => projectJobs.filter((job) => job.type === "stems"),
    [projectJobs],
  );

  const displayArtifacts = useMemo(() => {
    const artifacts = artifactsQuery.data ?? [];
    const source = artifacts.find((artifact) => artifact.type === "source_audio");
    const previews = artifacts.filter((artifact) => artifact.type === "preview_mix");
    const stems = artifacts.filter(
      (artifact) =>
        artifact.type === "vocal_stem" || artifact.type === "instrumental_stem",
    );
    const analysisJson = artifacts.find((artifact) => artifact.type === "analysis_json");
    const exports = artifacts.filter((artifact) => artifact.type === "export_mix");
    return [...previews, ...stems, ...exports, analysisJson, source].filter(Boolean) as ArtifactSchema[];
  }, [artifactsQuery.data]);

  const primaryArtifacts = useMemo(
    () =>
      displayArtifacts.filter(
        (artifact) => artifact.type === "preview_mix" || artifact.type === "source_audio",
      ),
    [displayArtifacts],
  );
  const sourceArtifact = useMemo(
    () => primaryArtifacts.find((artifact) => artifact.type === "source_audio") ?? null,
    [primaryArtifacts],
  );
  const previewArtifacts = useMemo(
    () => primaryArtifacts.filter((artifact) => artifact.type === "preview_mix"),
    [primaryArtifacts],
  );
  const stemArtifacts = useMemo(
    () =>
      displayArtifacts.filter(
        (artifact) => artifact.type === "vocal_stem" || artifact.type === "instrumental_stem",
      ),
    [displayArtifacts],
  );
  const selectableArtifacts = useMemo(
    () => [...primaryArtifacts, ...stemArtifacts].filter((artifact) => isPlayableArtifact(artifact)),
    [primaryArtifacts, stemArtifacts],
  );
  const latestPreviewArtifact = previewArtifacts[0] ?? null;
  const defaultPrimaryArtifact = preferredArtifactSelection(primaryArtifacts);

  const selectedArtifact =
    selectableArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const selectedPrimaryArtifact =
    primaryArtifacts.find((artifact) => artifact.id === selectedPrimaryArtifactId) ??
    artifactById(primaryArtifacts, sourceArtifactIdForStems(selectedArtifact)) ??
    defaultPrimaryArtifact;
  const visibleStemArtifacts = useMemo(
    () =>
      stemArtifacts.filter((artifact) => {
        const sourceArtifactId = artifact.metadata?.source_artifact_id;
        return (
          typeof sourceArtifactId === "string" &&
          sourceArtifactId === selectedPrimaryArtifact?.id
        );
      }),
    [selectedPrimaryArtifact?.id, stemArtifacts],
  );
  const stemJob = useMemo(() => {
    const selectedPrimaryId = selectedPrimaryArtifact?.id;
    if (!selectedPrimaryId) {
      return null;
    }

    const selectedSourceJob =
      stemJobs.find((job) => job.source_artifact_id === selectedPrimaryId) ?? null;
    if (selectedSourceJob) {
      return selectedSourceJob;
    }

    if (selectedPrimaryArtifact?.type === "source_audio") {
      return stemJobs.find((job) => job.source_artifact_id == null) ?? null;
    }

    return null;
  }, [selectedPrimaryArtifact, stemJobs]);
  const focusedStemArtifact =
    isStemArtifact(selectedArtifact) ? selectedArtifact : visibleStemArtifacts[0] ?? null;
  const isStemSelected = isStemArtifact(selectedArtifact);
  const isStemPlayback = isStemSelected && visibleStemArtifacts.length > 0;
  const selectedStemSourceArtifactId = isStemPlayback
    ? sourceArtifactIdForStems(selectedArtifact) ?? selectedPrimaryArtifact?.id ?? selectedPrimaryArtifactId
    : null;
  const selectedPlaybackArtifact = isStemPlayback
    ? focusedStemArtifact
    : selectedArtifact ?? selectedPrimaryArtifact;
  const selectedArtifactSummary = selectedPlaybackArtifact
    ? artifactSummary(selectedPlaybackArtifact)
    : "";

  const detectedKey = parseKey(analysisQuery.data?.estimated_key);
  const analyzedTempoBpm = analysisQuery.data?.tempo_bpm;
  const precountTempoBpm =
    typeof analyzedTempoBpm === "number" && Number.isFinite(analyzedTempoBpm) && analyzedTempoBpm > 0
      ? analyzedTempoBpm
      : null;
  const canUsePrecount = precountTempoBpm !== null;
  const precountDisabledReason = canUsePrecount ? null : "Waiting for BPM analysis";
  const sourceKeyOverride = parseStoredKey(projectQuery.data?.source_key_override);
  const sourceKeyBasis = sourceKeyOverride ?? detectedKey ?? null;
  const sourceKey = sourceKeyBasis ?? DEFAULT_KEY;
  const transposeSemitones = clampTargetTranspose(targetTransposeSemitones);
  const targetKey = transposeKey(sourceKey, transposeSemitones);
  const capoSemitones = clampTargetTranspose(capoTransposeSemitones);
  const hasTransformChange = retuneMode !== "off" || transposeSemitones !== 0;
  const isAnalysisRunning = Boolean(
    analyzeJob && ["pending", "running"].includes(analyzeJob.status),
  );
  const isChordRunning = Boolean(
    chordJob && ["pending", "running"].includes(chordJob.status),
  );
  const isLyricsRunning = Boolean(
    lyricsJob && ["pending", "running"].includes(lyricsJob.status),
  );
  const isStemRunning = Boolean(stemJob && ["pending", "running"].includes(stemJob.status));
  const mobileCapabilities = mobileCapabilitiesQuery.data ?? null;
  const isMobileRuntime = mobileCapabilities !== null;
  const mobileGenerationMessage = isMobileRuntime
    ? "Local generation requires GPU acceleration on this device."
    : null;
  const canAnalyze = !isMobileRuntime || mobileCapabilities?.gpuBackend != null;
  const canGenerateLyrics = !isMobileRuntime || mobileCapabilities?.whisperAvailable === true;
  const canGenerateStems = !isMobileRuntime || mobileCapabilities?.stemSeparationAvailable === true;
  const canGenerateChords = !isMobileRuntime || mobileCapabilities?.gpuBackend != null;
  const currentKeyValue = sourceKeyOverride ? serializeKey(sourceKeyOverride) : "auto";
  const hasVisibleStems = visibleStemArtifacts.length > 0;
  const stemErrorMessage =
    stemJob?.error_message && !dismissedStemJobIds.includes(stemJob.id)
      ? stemJob.error_message
      : null;
  const visibleJobs = projectJobs;
  const tuningSummary = formatRetuneSummary(retuneMode, referenceHz, centsOffset);
  const canDeleteSelectedMix = selectedArtifact?.type === "preview_mix";
  const selectedArtifactTimestamp = selectedPlaybackArtifact
    ? formatArtifactTimestamp(selectedPlaybackArtifact.created_at)
    : "";
  const correctedSourceChordSemitones =
    detectedKey && sourceKeyOverride ? semitoneDelta(detectedKey, sourceKeyOverride) : 0;
  const chordTransposeSemitones = artifactTransposeSemitones(
    selectedPlaybackArtifact,
    selectableArtifacts,
  );
  const capoSourceKey = transposeKey(sourceKey, chordTransposeSemitones);
  const capoKey = transposeKey(capoSourceKey, capoSemitones);
  const displayedChordSemitones =
    chordTransposeSemitones + correctedSourceChordSemitones + capoSemitones;
  const activeEnharmonicKeyContext = sourceKeyBasis
    ? transposeKey(sourceKeyBasis, chordTransposeSemitones + capoSemitones)
    : null;
  const displayedChords = useMemo(
    () =>
      (chordsQuery.data?.timeline ?? []).map((segment) =>
        transposeChordSegment(segment, displayedChordSemitones, {
          activeKey: activeEnharmonicKeyContext,
          mode: enharmonicDisplayMode,
        }),
      ),
    [activeEnharmonicKeyContext, chordsQuery.data?.timeline, displayedChordSemitones, enharmonicDisplayMode],
  );
  const activeChordIndex = findActiveChordIndex(displayedChords, playbackTimeSeconds);
  const currentChord =
    activeChordIndex >= 0 ? displayedChords[activeChordIndex] : displayedChords[0] ?? null;
  const nextChord =
    activeChordIndex >= 0
      ? displayedChords[activeChordIndex + 1] ?? null
      : displayedChords.length > 1
        ? displayedChords[1]
        : null;
  const hasChordTimeline = displayedChords.length > 0;
  const displayedLyrics = useMemo(
    () => lyricsQuery.data?.segments ?? [],
    [lyricsQuery.data?.segments],
  );
  const hasLyricsTranscript = displayedLyrics.length > 0;
  const hasTimedLyricsTranscript = displayedLyrics.some((segment) => hasTimedLyrics(segment));
  const activeLyricsIndex = findActiveLyricsIndex(displayedLyrics, playbackTimeSeconds);
  const activeLyricsSegment =
    activeLyricsIndex >= 0 ? displayedLyrics[activeLyricsIndex] : null;
  const activeLyricsWordIndex =
    activeLyricsSegment?.words?.length
      ? findActiveLyricsWordIndex(activeLyricsSegment.words, playbackTimeSeconds)
      : -1;
  const combinedLeadSheetRows = useMemo(
    () =>
      buildLeadSheetRows(displayedLyrics, displayedChords, {
        activeChordIndex,
        activeLyricsIndex,
        activeLyricsWordIndex,
      }),
    [activeChordIndex, activeLyricsIndex, activeLyricsWordIndex, displayedChords, displayedLyrics],
  );
  const baseChordContextCopy =
    correctedSourceChordSemitones === 0 && chordTransposeSemitones === 0
      ? "Chord labels follow the original arrangement."
      : correctedSourceChordSemitones !== 0 && chordTransposeSemitones === 0
        ? "Chord labels follow the corrected source key."
        : correctedSourceChordSemitones === 0
          ? `Chord labels follow the selected playback (${formatSemitoneShift(
              chordTransposeSemitones,
            ).toLowerCase()}).`
          : `Chord labels follow corrected source key and selected playback (${formatSemitoneShift(
          chordTransposeSemitones,
        ).toLowerCase()}).`;
  const chordContextCopy =
    capoSemitones === 0
      ? baseChordContextCopy
      : `${baseChordContextCopy} Visual capo: ${formatCapoShiftSummary(
          capoSemitones,
        ).toLowerCase()}.`;
  const sourceKeyStatus = sourceKeyOverride ? "Corrected" : detectedKey ? "Detected" : "Default";
  const targetShiftSummary =
    transposeSemitones === 0 ? "Original key" : formatSemitoneShift(transposeSemitones);
  const targetSelectionSummary = formatTargetSelectionSummary(transposeSemitones);
  const capoShiftSummary = formatCapoShiftSummary(capoSemitones);
  const capoSelectionSummary = formatTargetSelectionSummary(capoSemitones);
  const sourceKeySelectorCurrentKey = sourceKeyOverride ?? detectedKey ?? sourceKey;
  const sourceKeySelectorCurrentBadge = sourceKeyOverride ? null : detectedKey ? "Original" : "No override";
  const lowerTargetPreview =
    transposeSemitones > MIN_TARGET_TRANSPOSE
      ? transposeKey(sourceKey, transposeSemitones - 1)
      : null;
  const higherTargetPreview =
    transposeSemitones < MAX_TARGET_TRANSPOSE
      ? transposeKey(sourceKey, transposeSemitones + 1)
      : null;
  const lowerCapoPreview =
    capoSemitones > MIN_TARGET_TRANSPOSE ? transposeKey(capoSourceKey, capoSemitones - 1) : null;
  const higherCapoPreview =
    capoSemitones < MAX_TARGET_TRANSPOSE ? transposeKey(capoSourceKey, capoSemitones + 1) : null;
  const targetShiftOptions = useMemo<TargetShiftOption[]>(
    () =>
      Array.from(
        { length: MAX_TARGET_TRANSPOSE - MIN_TARGET_TRANSPOSE + 1 },
        (_, index) => MIN_TARGET_TRANSPOSE + index,
      ).map((semitones) => {
        const key = transposeKey(sourceKey, semitones);
        return {
          semitones,
          key,
        };
      }),
    [sourceKey],
  );
  const capoShiftOptions = useMemo<TargetShiftOption[]>(
    () =>
      Array.from(
        { length: MAX_TARGET_TRANSPOSE - MIN_TARGET_TRANSPOSE + 1 },
        (_, index) => MIN_TARGET_TRANSPOSE + index,
      ).map((semitones) => {
        const key = transposeKey(capoSourceKey, semitones);
        return {
          semitones,
          key,
        };
      }),
    [capoSourceKey],
  );
  const lowerTargetShiftOptions = useMemo(
    () => targetShiftOptions.filter((option) => option.semitones < 0).sort((a, b) => b.semitones - a.semitones),
    [targetShiftOptions],
  );
  const higherTargetShiftOptions = useMemo(
    () => targetShiftOptions.filter((option) => option.semitones > 0).sort((a, b) => b.semitones - a.semitones),
    [targetShiftOptions],
  );
  const lowerCapoShiftOptions = useMemo(
    () => capoShiftOptions.filter((option) => option.semitones < 0).sort((a, b) => b.semitones - a.semitones),
    [capoShiftOptions],
  );
  const higherCapoShiftOptions = useMemo(
    () => capoShiftOptions.filter((option) => option.semitones > 0).sort((a, b) => b.semitones - a.semitones),
    [capoShiftOptions],
  );
  const sourceKeyOptions = useMemo<SourceKeyOption[]>(
    () => [
      {
        badge: detectedKey ? "Original" : "No override",
        key: detectedKey ?? sourceKey,
        value: "auto",
      },
      ...MUSICAL_KEYS.filter((key) =>
        detectedKey ? key.value !== serializeKey(detectedKey) : true,
      ).map((key) => ({
        badge: null,
        key,
        value: key.value,
      })),
    ],
    [detectedKey, sourceKey],
  );

  const soloedStemIds = visibleStemArtifacts
    .filter((artifact) => stemControls[artifact.id]?.solo)
    .map((artifact) => artifact.id);
  const activeStemCount = visibleStemArtifacts.filter((artifact) => {
    const state = stemControls[artifact.id] ?? { muted: false, solo: false };
    if (soloedStemIds.length > 0) {
      return state.solo;
    }
    return !state.muted;
  }).length;

  function handleSelectPrimaryArtifact(artifact: ArtifactSchema) {
    setSelectedPrimaryArtifactId(artifact.id);
    setSelectedArtifactId(artifact.id);
  }

  async function handleSelectStemArtifact(artifact: ArtifactSchema) {
    await activateStemPlayback();
    const sourceArtifactId = sourceArtifactIdForStems(artifact);
    if (sourceArtifactId) {
      setSelectedPrimaryArtifactId(sourceArtifactId);
    }
    setSelectedArtifactId(artifact.id);
  }

  function handleSelectWorkspace(workspace: "project" | "playback") {
    setActiveWorkspace(workspace);
  }

  function handleSetPlaybackDisplayMode(displayMode: PlaybackDisplayMode) {
    setPlaybackDisplayMode(displayMode);
    setPlaybackDisplayModeSource("user");
  }

  function handleTogglePlaybackDisplayLane(lane: "lyrics" | "chords") {
    if (playbackDisplayMode === "combined") {
      handleSetPlaybackDisplayMode(lane === "lyrics" ? "chords" : "lyrics");
      return;
    }
    if (playbackDisplayMode === lane) {
      return;
    }
    handleSetPlaybackDisplayMode("combined");
  }

  async function handleChordAction() {
    if (!canGenerateChords) {
      return;
    }
    const hasExistingChords = (chordsQuery.data?.timeline?.length ?? 0) > 0;
    const hasUserChordEdits = chordsQuery.data?.has_user_edits === true;
    if (hasExistingChords && hasUserChordEdits) {
      const approved = await confirm(
        "Refresh chords? This replaces the current chord timeline and discards your edits, including accepted tab suggestions.",
        {
          title: "Refresh chords",
          kind: "warning",
          okLabel: "Refresh",
          cancelLabel: "Cancel",
        },
      );
      if (!approved) {
        return;
      }
    }
    chordMutation.mutate(hasUserChordEdits);
  }

  function handleSetLyricsFollowEnabled(enabled: boolean) {
    setLyricsFollowEnabled(enabled);
  }

  function handleSetChordsFollowEnabled(enabled: boolean) {
    setChordsFollowEnabled(enabled);
  }

  function handleOpenTabImport() {
    setIsTabImportOpen(true);
  }

  function handleCloseTabImport() {
    if (tabImportMutation.isPending || tabImportApplyMutation.isPending) {
      return;
    }
    setIsTabImportOpen(false);
  }

  function handleCreateTabImportProposal() {
    if (!tabImportDraft.trim()) {
      return;
    }
    tabImportMutation.mutate(tabImportDraft);
  }

  function handleToggleTabSuggestion(suggestionId: string) {
    setAcceptedTabSuggestionIds((current) =>
      current.includes(suggestionId)
        ? current.filter((id) => id !== suggestionId)
        : [...current, suggestionId],
    );
    setSelectedTabSuggestionId(suggestionId);
  }

  function handleAcceptTabSuggestionGroup(suggestionIds: string[]) {
    setAcceptedTabSuggestionIds((current) => Array.from(new Set([...current, ...suggestionIds])));
    setSelectedTabSuggestionId(suggestionIds[0] ?? null);
  }

  function handleRejectTabSuggestionGroup(suggestionIds: string[]) {
    const ids = new Set(suggestionIds);
    setAcceptedTabSuggestionIds((current) => current.filter((id) => !ids.has(id)));
    if (selectedTabSuggestionId && ids.has(selectedTabSuggestionId)) {
      setSelectedTabSuggestionId(null);
    }
  }

  function handleApplyTabSuggestions() {
    if (!acceptedTabSuggestionIds.length) {
      return;
    }
    tabImportApplyMutation.mutate();
  }

  async function handleTogglePlayback() {
    await togglePlayback();
  }

  function handleSetPrecountEnabled(enabled: boolean) {
    if (enabled && !canUsePrecount) {
      return;
    }
    setPrecountEnabled(enabled);
  }

  function handleSetPrecountClickCount(value: number) {
    setPrecountClickCount(normalizePrecountClickCount(value));
  }

  function handleSeekTo(timeSeconds: number) {
    seekTo(timeSeconds);
  }

  function handleSeek(secondsDelta: number) {
    const direction: SeekDirection = secondsDelta < 0 ? "backward" : "forward";
    setSeekAnimationRevision((current) => ({
      ...current,
      [direction]: current[direction] + 1,
    }));
    seekBy(secondsDelta);
  }

  async function handleLyricsAction() {
    if (!canGenerateLyrics) {
      return;
    }
    const hasExistingLyrics = (lyricsQuery.data?.segments?.length ?? 0) > 0;
    if (hasExistingLyrics) {
      const approved = await confirm(
        lyricsQuery.data?.has_user_edits
          ? "Refresh lyrics? This replaces the current transcript and discards your edits, including accepted tab suggestions."
          : "Refresh lyrics? This replaces the current transcript with a new pass and clears the current tab import.",
        {
          title: "Refresh lyrics",
          kind: "warning",
          okLabel: "Refresh",
          cancelLabel: "Cancel",
        },
      );
      if (!approved) {
        return;
      }
    }

    lyricsMutation.mutate(hasExistingLyrics);
  }

  async function handleStemAction() {
    if (!selectedPrimaryArtifactId) {
      return;
    }
    if (!canGenerateStems) {
      return;
    }

    const affectsSourceChords = selectedPrimaryArtifact?.type === "source_audio";
    const hasUserChordEdits = affectsSourceChords && chordsQuery.data?.has_user_edits === true;
    let overwriteChordEdits = false;

    if (hasVisibleStems) {
      const stemTargetLabel = selectedPrimaryArtifact
        ? artifactLabel(selectedPrimaryArtifact)
        : "selected audio";
      const rebuildMessage = hasUserChordEdits
        ? `Rebuild stems for ${stemTargetLabel}? Existing chord edits will be replaced. Existing stems will be replaced. On desktop, Demucs uses GPU when available; CPU rebuilds may take longer.`
        : `Rebuild stems for ${stemTargetLabel}? Existing stems will be replaced. On desktop, Demucs uses GPU when available; CPU rebuilds may take longer.`;
      const approved = await confirm(
        rebuildMessage,
        {
          title: "Rebuild stems",
          kind: "warning",
          okLabel: "Rebuild",
          cancelLabel: "Cancel",
        },
      );
      if (!approved) {
        return;
      }
      overwriteChordEdits = hasUserChordEdits;
    } else if (hasUserChordEdits) {
      const stemTargetLabel = selectedPrimaryArtifact
        ? artifactLabel(selectedPrimaryArtifact)
        : "selected audio";
      const approved = await confirm(
        `Generate stems for ${stemTargetLabel}? Existing chord edits will be replaced when chords refresh after stem generation. On desktop, Demucs uses GPU when available; CPU generation may take longer.`,
        {
          title: "Generate stems",
          kind: "warning",
          okLabel: "Generate",
          cancelLabel: "Cancel",
        },
      );
      if (!approved) {
        return;
      }
      overwriteChordEdits = true;
    }

    stemMutation.mutate(overwriteChordEdits);
  }

  function toggleStemControl(
    artifact: ArtifactSchema,
    mode: keyof StemControlState,
  ) {
    if (!isStemPlayback) {
      handleSelectStemArtifact(artifact);
    }

    setStemControls((current) => {
      const previous = current[artifact.id] ?? { muted: false, solo: false };
      return {
        ...current,
        [artifact.id]: {
          ...previous,
          [mode]: !previous[mode],
        },
      };
    });
  }

  function stemOutputLabel(artifactId: string) {
    const state = stemControls[artifactId] ?? { muted: false, solo: false };
    if (soloedStemIds.length > 0 && !state.solo) {
      return "Muted by solo";
    }
    if (state.solo) {
      return "Solo";
    }
    if (state.muted) {
      return "Muted";
    }
    return "Live";
  }

  async function handleDeleteProject() {
    const approved = await confirm(
      "Delete this project and all of its mixes, stems, and exports?",
      {
        title: "Delete project",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!approved) {
      return;
    }
    deleteMutation.mutate();
  }

  async function handleDeleteMix() {
    if (!selectedArtifact || selectedArtifact.type !== "preview_mix") {
      return;
    }
    const approved = await confirm(
      isMobileRuntime
        ? "Delete this practice mix and its stem tracks? Rebuilding stems later requires GPU acceleration on this device."
        : "Delete this practice mix and its stem tracks? Rebuilding stems later may take longer on CPU-only desktops.",
      {
        title: "Delete practice mix",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!approved) {
      return;
    }
    deleteMixMutation.mutate();
  }

  useEffect(() => {
    if (!isRenaming) {
      setDraftName(projectQuery.data?.display_name ?? "");
    }
  }, [isRenaming, projectQuery.data?.display_name]);

  useEffect(() => {
    if (!isEditingLyrics) {
      setLyricsDraft(displayedLyrics.map((segment) => segment.text));
    }
  }, [displayedLyrics, isEditingLyrics]);

  useEffect(() => {
    if (!targetSelectorOpen) {
      return;
    }

    const activeOption = targetOptionRefs.current[transposeSemitones];
    activeOption?.scrollIntoView?.({ block: "center" });
  }, [targetSelectorOpen, transposeSemitones]);

  useEffect(() => {
    if (!capoSelectorOpen) {
      return;
    }

    const activeOption = capoOptionRefs.current[capoSemitones];
    activeOption?.scrollIntoView?.({ block: "center" });
  }, [capoSelectorOpen, capoSemitones]);

  useEffect(() => {
    if (!sourceKeySelectorOpen) {
      return;
    }

    const activeOption = sourceKeyOptionRefs.current[currentKeyValue];
    activeOption?.scrollIntoView?.({ block: "center" });
  }, [currentKeyValue, sourceKeySelectorOpen]);

  useEffect(() => {
    if (!targetSelectorOpen && !sourceKeySelectorOpen && !capoSelectorOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const targetInside = targetSelectorRef.current?.contains(event.target as Node) ?? false;
      const sourceInside = sourceKeySelectorRef.current?.contains(event.target as Node) ?? false;
      const capoInside = capoSelectorRef.current?.contains(event.target as Node) ?? false;
      if (!targetInside) {
        setTargetSelectorOpen(false);
      }
      if (!sourceInside) {
        setSourceKeySelectorOpen(false);
      }
      if (!capoInside) {
        setCapoSelectorOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTargetSelectorOpen(false);
        setSourceKeySelectorOpen(false);
        setCapoSelectorOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [capoSelectorOpen, sourceKeySelectorOpen, targetSelectorOpen]);

  useEffect(() => {
    setInspectorOpen(defaultInspectorOpen);
  }, [defaultInspectorOpen]);

  useEffect(() => {
    setSourcesRailCollapsed(defaultSourcesRailCollapsed);
  }, [defaultSourcesRailCollapsed]);

  useEffect(() => {
    const storedPlaybackState = readProjectPlaybackState(projectId);
    const hasStoredPlayback = hasProjectPlaybackState(projectId);
    pendingPreviewSelection.current = null;
    persistedStemSourceArtifactId.current = storedPlaybackState.selectedStemSourceArtifactId;
    setSelectedArtifactId(storedPlaybackState.selectedArtifactId);
    setSelectedPrimaryArtifactId(storedPlaybackState.selectedPrimaryArtifactId);
    setActiveWorkspace(
      hasStoredPlayback ? storedPlaybackState.activeWorkspace : defaultProjectWorkspace,
    );
    setActiveProjectPanel(storedPlaybackState.activeProjectPanel);
    setPlaybackDisplayMode(
      hasStoredPlayback
        ? storedPlaybackState.playbackDisplayMode
        : resolveDefaultPlaybackDisplayMode(defaultPlaybackDisplayMode, false, false),
    );
    setCapoTransposeSemitones(storedPlaybackState.capoTransposeSemitones);
    setPrecountEnabled(storedPlaybackState.precountEnabled);
    setPrecountClickCount(storedPlaybackState.precountClickCount);
    setPlaybackDisplayModeSource(hasStoredPlayback ? "stored" : "default");
    setLyricsFollowEnabled(
      hasStoredPlayback
        ? storedPlaybackState.lyricsFollowEnabled
        : defaultLyricsFollowEnabled,
    );
    setChordsFollowEnabled(
      hasStoredPlayback
        ? storedPlaybackState.chordsFollowEnabled
        : defaultChordsFollowEnabled,
    );
    setStemControls(storedPlaybackState.stemControls);
    setDismissedStemJobIds(storedPlaybackState.dismissedStemJobIds);
    setHydratedProjectId(projectId);
  }, [
    defaultChordsFollowEnabled,
    defaultLyricsFollowEnabled,
    defaultPlaybackDisplayMode,
    defaultProjectWorkspace,
    projectId,
  ]);

  useEffect(() => {
    if (
      hydratedProjectId !== projectId ||
      playbackDisplayModeSource !== "default"
    ) {
      return;
    }

    setPlaybackDisplayMode(
      resolveDefaultPlaybackDisplayMode(
        defaultPlaybackDisplayMode,
        hasLyricsTranscript,
        hasChordTimeline,
      ),
    );
  }, [
    defaultPlaybackDisplayMode,
    hasChordTimeline,
    hasLyricsTranscript,
    hydratedProjectId,
    playbackDisplayModeSource,
    projectId,
  ]);

  useEffect(() => {
    if (hydratedProjectId !== projectId) {
      return;
    }

    if (!defaultPrimaryArtifact) {
      setSelectedPrimaryArtifactId(null);
      setSelectedArtifactId(null);
      return;
    }

    const shouldSelectNewPreview =
      pendingPreviewSelection.current &&
      latestPreviewArtifact &&
      latestPreviewArtifact.id !== pendingPreviewSelection.current.previousLatestPreviewArtifactId;

    if (shouldSelectNewPreview) {
      setSelectedPrimaryArtifactId(latestPreviewArtifact.id);
      setSelectedArtifactId(latestPreviewArtifact.id);
      pendingPreviewSelection.current = null;
      return;
    }

    const nextSelectedArtifact =
      selectableArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
    const derivedPrimaryId = sourceArtifactIdForStems(nextSelectedArtifact);
    const preferredStemSourceArtifactId =
      derivedPrimaryId ??
      (nextSelectedArtifact || !selectedArtifactId ? null : persistedStemSourceArtifactId.current);
    const nextPrimaryArtifactId =
      preferredStemSourceArtifactId &&
      primaryArtifacts.some((artifact) => artifact.id === preferredStemSourceArtifactId)
        ? preferredStemSourceArtifactId
        : primaryArtifacts.some((artifact) => artifact.id === selectedPrimaryArtifactId)
        ? selectedPrimaryArtifactId
        : derivedPrimaryId && primaryArtifacts.some((artifact) => artifact.id === derivedPrimaryId)
          ? derivedPrimaryId
          : defaultPrimaryArtifact.id;
    const nextSelectedArtifactId = nextSelectedArtifact?.id ?? nextPrimaryArtifactId;

    if (selectedPrimaryArtifactId !== nextPrimaryArtifactId) {
      setSelectedPrimaryArtifactId(nextPrimaryArtifactId);
    }

    if (selectedArtifactId !== nextSelectedArtifactId) {
      setSelectedArtifactId(nextSelectedArtifactId);
    }
  }, [
    defaultPrimaryArtifact,
    hydratedProjectId,
    latestPreviewArtifact,
    primaryArtifacts,
    projectId,
    selectableArtifacts,
    selectedArtifactId,
    selectedPrimaryArtifactId,
  ]);

  useEffect(() => {
    setStemControls((current) => {
      const next: Record<string, StemControlState> = {};
      visibleStemArtifacts.forEach((artifact) => {
        next[artifact.id] = current[artifact.id] ?? { muted: false, solo: false };
      });
      return next;
    });
  }, [visibleStemArtifacts]);

  useEffect(() => {
    if (hydratedProjectId !== projectId || !jobsQuery.data) {
      return;
    }

    const activeStemJobIds = new Set(stemJobs.map((job) => job.id));
    setDismissedStemJobIds((current) => {
      const next = current.filter((jobId) => activeStemJobIds.has(jobId));
      return next.length === current.length ? current : next;
    });
  }, [hydratedProjectId, jobsQuery.data, projectId, stemJobs]);

  useEffect(() => {
    if (hydratedProjectId !== projectId) {
      return;
    }

    persistedStemSourceArtifactId.current = selectedStemSourceArtifactId;
    writeProjectPlaybackState(projectId, {
      selectedArtifactId,
      selectedPrimaryArtifactId,
      selectedStemSourceArtifactId,
      activeWorkspace,
      activeProjectPanel,
      playbackDisplayMode,
      capoTransposeSemitones: capoSemitones,
      precountEnabled,
      precountClickCount,
      lyricsFollowEnabled,
      chordsFollowEnabled,
      stemControls,
      dismissedStemJobIds,
    });
  }, [
    activeProjectPanel,
    activeWorkspace,
    capoSemitones,
    chordsFollowEnabled,
    dismissedStemJobIds,
    hydratedProjectId,
    lyricsFollowEnabled,
    playbackDisplayMode,
    precountClickCount,
    precountEnabled,
    projectId,
    selectedArtifactId,
    selectedPrimaryArtifactId,
    selectedStemSourceArtifactId,
    stemControls,
  ]);

  useEffect(() => {
    if (
      activeWorkspace !== "playback" ||
      playbackDisplayMode !== "chords" ||
      !chordsFollowEnabled ||
      !isPlaying ||
      activeChordIndex < 0
    ) {
      return;
    }
    const activeSegment = displayedChords[activeChordIndex];
    if (!activeSegment) {
      return;
    }
    const activeElement =
      chordSegmentRefs.current[
        `${activeSegment.start_seconds}-${activeSegment.label}-${activeChordIndex}`
      ];
    const chordTimeline = chordTimelineRef.current;
    if (!activeElement || !chordTimeline) {
      return;
    }
    const containerRect = chordTimeline.getBoundingClientRect();
    const elementRect = activeElement.getBoundingClientRect();
    const centerOffset =
      elementRect.left -
      containerRect.left -
      chordTimeline.clientWidth / 2 +
      elementRect.width / 2;
    const maxScrollLeft = Math.max(
      chordTimeline.scrollWidth - chordTimeline.clientWidth,
      0,
    );
    const targetScrollLeft = Math.min(
      Math.max(chordTimeline.scrollLeft + centerOffset, 0),
      maxScrollLeft,
    );
    if (typeof chordTimeline.scrollTo === "function") {
      chordTimeline.scrollTo({
        behavior: "smooth",
        left: targetScrollLeft,
      });
      return;
    }
    chordTimeline.scrollLeft = targetScrollLeft;
  }, [
    activeChordIndex,
    activeWorkspace,
    chordsFollowEnabled,
    displayedChords,
    isPlaying,
    playbackDisplayMode,
  ]);

  useEffect(() => {
    if (
      activeWorkspace !== "playback" ||
      playbackDisplayMode !== "lyrics" ||
      !lyricsFollowEnabled ||
      !isPlaying ||
      isEditingLyrics ||
      activeLyricsIndex < 0
    ) {
      return;
    }
    const activeSegment = displayedLyrics[activeLyricsIndex];
    if (!activeSegment) {
      return;
    }
    const activeElement =
      lyricsSegmentRefs.current[
        `${activeSegment.start_seconds}-${activeSegment.end_seconds}-${activeLyricsIndex}`
      ];
    const lyricsContainer = lyricsTheaterRef.current;
    if (!activeElement || !lyricsContainer) {
      return;
    }
    const containerRect = lyricsContainer.getBoundingClientRect();
    const elementRect = activeElement.getBoundingClientRect();
    const centerOffset =
      elementRect.top -
      containerRect.top -
      lyricsContainer.clientHeight / 2 +
      elementRect.height / 2;
    const maxScrollTop = Math.max(
      lyricsContainer.scrollHeight - lyricsContainer.clientHeight,
      0,
    );
    const targetScrollTop = Math.min(
      Math.max(lyricsContainer.scrollTop + centerOffset, 0),
      maxScrollTop,
    );
    if (typeof lyricsContainer.scrollTo === "function") {
      lyricsContainer.scrollTo({
        behavior: "smooth",
        top: targetScrollTop,
      });
      return;
    }
    lyricsContainer.scrollTop = targetScrollTop;
  }, [
    activeLyricsIndex,
    activeLyricsWordIndex,
    activeWorkspace,
    displayedLyrics,
    isEditingLyrics,
    isPlaying,
    lyricsFollowEnabled,
    playbackDisplayMode,
  ]);

  useEffect(() => {
    if (
      activeWorkspace !== "playback" ||
      playbackDisplayMode !== "combined" ||
      !lyricsFollowEnabled ||
      !isPlaying ||
      isEditingLyrics
    ) {
      return;
    }
    const activeRow = combinedLeadSheetRows.find((row) => row.isActive);
    if (!activeRow) {
      return;
    }
    const activeElement = combinedLeadSheetRowRefs.current[activeRow.id];
    const leadSheetContainer = combinedLeadSheetRef.current;
    if (!activeElement || !leadSheetContainer) {
      return;
    }
    const containerRect = leadSheetContainer.getBoundingClientRect();
    const elementRect = activeElement.getBoundingClientRect();
    const centerOffset =
      elementRect.top -
      containerRect.top -
      leadSheetContainer.clientHeight / 2 +
      elementRect.height / 2;
    const maxScrollTop = Math.max(
      leadSheetContainer.scrollHeight - leadSheetContainer.clientHeight,
      0,
    );
    const targetScrollTop = Math.min(
      Math.max(leadSheetContainer.scrollTop + centerOffset, 0),
      maxScrollTop,
    );
    if (typeof leadSheetContainer.scrollTo === "function") {
      leadSheetContainer.scrollTo({
        behavior: "smooth",
        top: targetScrollTop,
      });
      return;
    }
    leadSheetContainer.scrollTop = targetScrollTop;
  }, [
    activeWorkspace,
    combinedLeadSheetRows,
    isEditingLyrics,
    isPlaying,
    lyricsFollowEnabled,
    playbackDisplayMode,
  ]);

  useEffect(() => {
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;
    if (wasPlaying || !isPlaying || activeWorkspace !== "playback") {
      return;
    }
    playbackTransportRef.current?.scrollIntoView?.({
      behavior: "smooth",
      block: "end",
    });
  }, [activeWorkspace, isPlaying]);

  const currentSourceSummary = selectedPrimaryArtifact
    ? artifactSummary(selectedPrimaryArtifact) ||
      fileNameFromPath(selectedPrimaryArtifact.path)
    : "Select audio to start playback.";
  const stageTitle = isStemPlayback
    ? focusedStemArtifact
      ? artifactLabel(focusedStemArtifact)
      : "Stem Monitor"
    : selectedPlaybackArtifact
      ? artifactLabel(selectedPlaybackArtifact)
      : "Playback";
  const stageModeLabel = isStemPlayback ? "Stem monitor" : "Full playback";
  const stageSummary = isStemPlayback
    ? `${activeStemCount} of ${visibleStemArtifacts.length} stems audible`
    : selectedArtifactSummary || currentSourceSummary;
  const sourcesRailSummary = [
    { label: "Src", value: sourceArtifact ? "1" : "0" },
    { label: "Mix", value: `${previewArtifacts.length}` },
    { label: "Stem", value: `${stemArtifacts.length}` },
  ];

  useEffect(() => {
    if (hydratedProjectId !== projectId || !projectId || !selectedPlaybackArtifact) {
      return;
    }

    registerProjectSession({
      projectId,
      projectName: projectQuery.data?.display_name ?? "Project",
      stageTitle,
      stageSummary,
      selectedPlaybackArtifactId: selectedPlaybackArtifact.id,
      isStemPlayback,
      visibleStemArtifactIds: visibleStemArtifacts.map((artifact) => artifact.id),
      stemControls,
      durationHintSeconds: projectQuery.data?.duration_seconds ?? 0,
      precountEnabled,
      precountClickCount,
      precountTempoBpm,
    });
  }, [
    hydratedProjectId,
    isStemPlayback,
    projectId,
    projectQuery.data?.display_name,
    projectQuery.data?.duration_seconds,
    precountClickCount,
    precountEnabled,
    precountTempoBpm,
    registerProjectSession,
    selectedPlaybackArtifact,
    stageSummary,
    stageTitle,
    stemControls,
    visibleStemArtifacts,
  ]);


  return {
    activeWorkspace,
    activeProjectPanel,
    activeChordIndex,
    activeEnharmonicKeyContext,
    activeLyricsIndex,
    activeLyricsWordIndex,
    activeStemCount,
    analysisQuery,
    analyzeMutation,
    canAnalyze,
    canDeleteSelectedMix,
    canGenerateChords,
    canGenerateLyrics,
    canGenerateStems,
    capoKey,
    capoOptionRefs,
    capoSelectionSummary,
    capoSelectorOpen,
    capoSelectorRef,
    capoSemitones,
    capoShiftSummary,
    capoSourceKey,
    chordContextCopy,
    chordJob,
    chordMutation,
    chordSegmentRefs,
    chordTimelineRef,
    chordsFollowEnabled,
    combinedLeadSheetRef,
    combinedLeadSheetRowRefs,
    combinedLeadSheetRows,
    currentChord,
    currentKeyValue,
    centsOffset,
    deleteMixMutation,
    deleteMutation,
    detectedKey,
    displayArtifacts,
    displayedChords,
    displayedLyrics,
    draftName,
    enharmonicDisplayMode,
    exportMutation,
    acceptedTabSuggestionIds,
    handleDeleteMix,
    handleDeleteProject,
    handleChordAction,
    handleLyricsAction,
    handleSeek,
    handleSeekTo,
    handleSelectPrimaryArtifact,
    handleSelectStemArtifact,
    handleSelectWorkspace,
    handleSelectProjectPanel: setActiveProjectPanel,
    handleSetChordsFollowEnabled,
    handleSetLyricsFollowEnabled,
    handleSetPrecountClickCount,
    handleSetPrecountEnabled,
    handleAcceptTabSuggestionGroup,
    handleApplyTabSuggestions,
    handleCloseTabImport,
    handleCreateTabImportProposal,
    handleOpenTabImport,
    handleRejectTabSuggestionGroup,
    handleSetPlaybackDisplayMode,
    handleStemAction,
    handleTogglePlaybackDisplayLane,
    handleToggleTabSuggestion,
    hasChordTimeline,
    hasEditedLyrics: lyricsQuery.data?.has_user_edits ?? false,
    hasLyricsTranscript,
    hasTimedLyricsTranscript,
    hasTransformChange,
    hasVisibleStems,
    higherCapoPreview,
    higherCapoShiftOptions,
    higherTargetPreview,
    higherTargetShiftOptions,
    informationDensity,
    inspectorOpen,
    isRenaming,
    isAnalysisRunning,
    isChordRunning,
    isEditingLyrics,
    isTabImportOpen,
    isLyricsRunning,
    isMobileRuntime,
    isPlaying,
    isStemPlayback,
    isStemRunning,
    latestPreviewArtifact,
    lowerCapoPreview,
    lowerCapoShiftOptions,
    lowerTargetPreview,
    lowerTargetShiftOptions,
    mobileCapabilities,
    mobileGenerationMessage,
    lyricsFollowEnabled,
    lyricsDraft,
    lyricsJob,
    lyricsMutation,
    lyricsSaveMutation,
    lyricsSegmentRefs,
    lyricsTheaterRef,
    nextChord,
    playbackDisplayMode,
    playbackDurationSeconds,
    playbackTransportRef,
    playbackTimeSeconds,
    precountClickCount,
    precountDisabledReason,
    precountEnabled,
    precountMaxClickCount: MAX_PRECOUNT_CLICK_COUNT,
    precountMinClickCount: MIN_PRECOUNT_CLICK_COUNT,
    precountTempoBpm,
    canUsePrecount,
    previewArtifacts,
    previewMutation,
    projectQuery,
    referenceHz,
    renameMutation,
    retuneMode,
    seekAnimationRevision,
    seekTo,
    sectionsQuery,
    selectedArtifactId,
    selectedTabSuggestionId,
    selectedArtifactTimestamp,
    selectedPlaybackArtifact,
    selectedPrimaryArtifact,
    selectedPrimaryArtifactId,
    setCapoSelectorOpen,
    setCapoTransposeSemitones,
    setCentsOffset,
    setDismissedStemJobIds,
    setDraftName,
    setInspectorOpen,
    setIsEditingLyrics,
    setIsRenaming,
    setReferenceHz,
    setRetuneMode,
    setSourcesRailCollapsed,
    setSourceKeySelectorOpen,
    setTargetSelectorOpen,
    setTargetTransposeSemitones,
    setLyricsDraft,
    setSelectedTabSuggestionId,
    setTabImportDraft,
    showSupportingCopy,
    sourceArtifact,
    sourceKey,
    sourceKeyOptions,
    sourceKeyOverride,
    sourceKeyOverrideMutation,
    sourceKeySelectorCurrentBadge,
    sourceKeySelectorCurrentKey,
    sourceKeySelectorOpen,
    sourceKeySelectorRef,
    sourceKeyOptionRefs,
    sourceKeyStatus,
    sourcesRailCollapsed,
    sourcesRailSummary,
    stageModeLabel,
    stageSummary,
    stageTitle,
    stemControls,
    stemErrorMessage,
    stemJob,
    stemMutation,
    stemOutputLabel,
    stopPlayback,
    tabImportApplyMutation,
    tabImportDraft,
    tabImportMutation,
    targetKey,
    targetOptionRefs,
    targetSelectionSummary,
    targetSelectorOpen,
    targetSelectorRef,
    targetShiftSummary,
    togglePlayback: handleTogglePlayback,
    toggleStemControl,
    transposeSemitones,
    tuningSummary,
    visibleJobs,
    visibleStemArtifacts,
  };
}

export type ProjectViewModel = ReturnType<typeof useProjectViewModel>;
