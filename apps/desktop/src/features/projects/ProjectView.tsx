import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { api, type ArtifactSchema, type ChordSegmentSchema, type JobSchema, type ProjectSchema } from "../../lib/api";
import { formatLocalDateTime } from "../../lib/datetime";
import { usePreferences } from "../../lib/preferences";
import { usePlayback } from "./playback-context";
import {
  clearProjectPlaybackState,
  readProjectPlaybackState,
  writeProjectPlaybackState,
  type StemControlState,
} from "./projectPlaybackState";
import {
  DEFAULT_KEY,
  type EnharmonicDisplayMode,
  MUSICAL_KEYS,
  deserializeKey,
  formatChordLabel,
  formatKey,
  parseKey,
  parseStoredKey,
  semitoneDelta,
  serializeKey,
  transposePitchClass,
  transposeKey,
  type MusicalKey,
} from "../../lib/music";

function useActiveJobPolling(projectId: string, jobs: JobSchema[] | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const active = jobs?.some(
      (job) => job.project_id === projectId && ["pending", "running"].includes(job.status),
    );
    if (!active) return;

    const interval = window.setInterval(async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["analysis", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["chords", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    }, 1500);

    return () => window.clearInterval(interval);
  }, [jobs, projectId, queryClient]);
}

function artifactLabel(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") return "Source Track";
  if (artifact.type === "preview_mix") return "Practice Mix";
  if (artifact.type === "export_mix") return "Export File";
  if (artifact.type === "vocal_stem") return "Vocals";
  if (artifact.type === "instrumental_stem") return "Instrumental";
  if (artifact.type === "analysis_json") return "Analysis JSON";
  return artifact.type;
}

function isPlayableArtifact(artifact: ArtifactSchema) {
  return ["source_audio", "preview_mix", "vocal_stem", "instrumental_stem"].includes(artifact.type);
}

function isStemArtifact(artifact: ArtifactSchema | null | undefined) {
  return artifact?.type === "vocal_stem" || artifact?.type === "instrumental_stem";
}

function preferredArtifactSelection(artifacts: ArtifactSchema[]) {
  return (
    artifacts.find((artifact) => artifact.type === "source_audio") ??
    artifacts.find((artifact) => artifact.type === "preview_mix") ??
    artifacts[0] ??
    null
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

function formatSemitoneShift(semitones: number) {
  return `Shift ${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}`;
}

function formatArtifactTimestamp(createdAt: string) {
  return formatLocalDateTime(createdAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPlaybackClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

type SeekDirection = "backward" | "forward";

function MetallicGlyphDefs({ gradientId }: { gradientId: string }) {
  return (
    <defs>
      <linearGradient id={gradientId} x1="8%" y1="8%" x2="92%" y2="92%">
        <stop offset="0%" stopColor="#FFFBEB" />
        <stop offset="20%" stopColor="#F8FAFC" />
        <stop offset="48%" stopColor="#CBD5E1" />
        <stop offset="76%" stopColor="#64748B" />
        <stop offset="100%" stopColor="#F8FAFC" />
      </linearGradient>
    </defs>
  );
}

function PlayPauseGlyph({ isPlaying }: { isPlaying: boolean }) {
  const gradientId = useId();
  const fill = `url(#${gradientId})`;

  return (
    <svg
      aria-hidden="true"
      className="transport__icon transport__icon--playpause"
      focusable="false"
      viewBox="0 0 40 40"
    >
      <MetallicGlyphDefs gradientId={gradientId} />
      {isPlaying ? (
        <>
          <rect
            fill={fill}
            height="19"
            rx="2.6"
            stroke="rgba(255, 255, 255, 0.5)"
            strokeWidth="1"
            width="6.5"
            x="10.75"
            y="10.5"
          />
          <rect
            fill={fill}
            height="19"
            rx="2.6"
            stroke="rgba(255, 255, 255, 0.5)"
            strokeWidth="1"
            width="6.5"
            x="22.75"
            y="10.5"
          />
        </>
      ) : (
        <path
          d="M13 9.75L29.5 20L13 30.25Z"
          fill={fill}
          stroke="rgba(255, 255, 255, 0.55)"
          strokeLinejoin="round"
          strokeWidth="1"
        />
      )}
    </svg>
  );
}

function StopGlyph() {
  const gradientId = useId();
  const fill = `url(#${gradientId})`;

  return (
    <svg
      aria-hidden="true"
      className="transport__icon transport__icon--stop"
      focusable="false"
      viewBox="0 0 40 40"
    >
      <MetallicGlyphDefs gradientId={gradientId} />
      <rect
        className="transport__stop-block"
        fill={fill}
        height="19"
        rx="4.5"
        stroke="rgba(255, 255, 255, 0.5)"
        strokeWidth="1"
        width="19"
        x="10.5"
        y="10.5"
      />
    </svg>
  );
}

function SeekGlyph({ animate = false, direction }: { animate?: boolean; direction: SeekDirection }) {
  const animationClass = animate ? ` transport__seek-glyph--animate-${direction}` : "";
  const triangleClass = `transport__seek-triangle transport__seek-triangle--${direction}`;

  return (
    <span
      aria-hidden="true"
      className={`transport__icon transport__icon--seek transport__seek-glyph${animationClass}`}
    >
      <span className="transport__seek-slot">
        <span className={triangleClass} />
        <span className={`${triangleClass} transport__seek-triangle--overlay`} />
      </span>
      <span className="transport__seek-slot">
        <span className={triangleClass} />
        <span className={`${triangleClass} transport__seek-triangle--overlay`} />
      </span>
    </span>
  );
}

function artifactSummary(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") {
    return "Original source file";
  }
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const engine = typeof artifact.metadata?.engine === "string" ? artifact.metadata.engine : null;
    const mode = typeof artifact.metadata?.mode === "string" ? artifact.metadata.mode : null;
    return [
      artifact.type === "vocal_stem" ? "Vocal stem" : "Instrumental stem",
      mode,
      engine,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  const metadata = artifact.metadata ?? {};
  const pieces: string[] = [];
  const transpose = metadata.transpose;
  if (
    transpose &&
    typeof transpose === "object" &&
    "semitones" in transpose &&
    typeof transpose.semitones === "number"
  ) {
    pieces.push(formatSemitoneShift(transpose.semitones));
  }

  const retune = metadata.retune;
  if (retune && typeof retune === "object") {
    if ("target_reference_hz" in retune && typeof retune.target_reference_hz === "number") {
      pieces.push(`Retuned to ${retune.target_reference_hz.toFixed(1)} Hz`);
    } else if ("target_cents_offset" in retune && typeof retune.target_cents_offset === "number") {
      const cents = retune.target_cents_offset;
      pieces.push(`Retuned ${cents > 0 ? "+" : ""}${cents.toFixed(1)} cents`);
    }
  }

  return pieces.join(" / ");
}

function sourceArtifactIdForStems(artifact: ArtifactSchema | null) {
  if (!artifact) return null;
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return typeof sourceArtifactId === "string" ? sourceArtifactId : null;
  }
  if (artifact.type === "source_audio" || artifact.type === "preview_mix") {
    return artifact.id;
  }
  return null;
}

function artifactById(artifacts: ArtifactSchema[], artifactId: string | null | undefined) {
  if (!artifactId) return null;
  return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

function artifactTransposeSemitones(
  artifact: ArtifactSchema | null,
  artifacts: ArtifactSchema[],
  depth = 0,
): number {
  if (!artifact || depth > 4) return 0;
  if (artifact.type === "preview_mix" || artifact.type === "export_mix") {
    const metadata = artifact.metadata ?? {};
    const transpose =
      typeof metadata.transpose === "object" && metadata.transpose !== null ? metadata.transpose : {};
    const semitones = "semitones" in transpose ? transpose.semitones : null;
    return typeof semitones === "number" ? semitones : 0;
  }
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return artifactTransposeSemitones(
      artifactById(
        artifacts,
        typeof sourceArtifactId === "string" ? sourceArtifactId : null,
      ),
      artifacts,
      depth + 1,
    );
  }
  return 0;
}

function transposeChordSegment(
  segment: ChordSegmentSchema,
  semitones: number,
  options: { activeKey: MusicalKey | null; mode: EnharmonicDisplayMode },
): ChordSegmentSchema {
  if (
    typeof segment.pitch_class !== "number" ||
    (segment.quality !== "major" && segment.quality !== "minor")
  ) {
    return segment;
  }
  const pitchClass = transposePitchClass(segment.pitch_class, semitones);
  return {
    ...segment,
    pitch_class: pitchClass,
    label: formatChordLabel(pitchClass, segment.quality, options),
  };
}

function findActiveChordIndex(timeline: ChordSegmentSchema[], playbackTimeSeconds: number) {
  return timeline.findIndex((segment, index) => {
    const isLast = index === timeline.length - 1;
    return (
      playbackTimeSeconds >= segment.start_seconds &&
      (playbackTimeSeconds < segment.end_seconds || isLast)
    );
  });
}

function buildRequestedRetune(
  retuneMode: "off" | "reference" | "cents",
  referenceHz: string,
  centsOffset: string,
) {
  if (retuneMode === "reference") {
    const parsed = Number(referenceHz);
    return Number.isFinite(parsed) ? { target_reference_hz: parsed } : null;
  }
  if (retuneMode === "cents") {
    const parsed = Number(centsOffset);
    return Number.isFinite(parsed) ? { target_cents_offset: parsed } : null;
  }
  return null;
}

function matchesPreviewSettings(
  artifact: ArtifactSchema | null,
  requestedRetune:
    | { target_reference_hz: number }
    | { target_cents_offset: number }
    | null,
  transposeSemitones: number,
) {
  if (!artifact || artifact.type !== "preview_mix") {
    return false;
  }

  const metadata = artifact.metadata ?? {};
  const retune =
    typeof metadata.retune === "object" && metadata.retune !== null ? metadata.retune : {};
  const transpose =
    typeof metadata.transpose === "object" && metadata.transpose !== null
      ? metadata.transpose
      : {};

  const requestedReferenceHz =
    requestedRetune && "target_reference_hz" in requestedRetune
      ? requestedRetune.target_reference_hz
      : null;
  const requestedCents =
    requestedRetune && "target_cents_offset" in requestedRetune
      ? requestedRetune.target_cents_offset
      : null;
  const artifactReferenceHz =
    "target_reference_hz" in retune && typeof retune.target_reference_hz === "number"
      ? retune.target_reference_hz
      : null;
  const artifactCents =
    "target_cents_offset" in retune && typeof retune.target_cents_offset === "number"
      ? retune.target_cents_offset
      : null;
  const artifactSemitones =
    "semitones" in transpose && typeof transpose.semitones === "number"
      ? transpose.semitones
      : 0;

  return (
    artifactSemitones === transposeSemitones &&
    artifactReferenceHz === requestedReferenceHz &&
    artifactCents === requestedCents
  );
}

function formatRetuneSummary(
  retuneMode: "off" | "reference" | "cents",
  referenceHz: string,
  centsOffset: string,
) {
  if (retuneMode === "off") {
    return "No fine retune";
  }
  if (retuneMode === "reference") {
    return `Retuned to ${referenceHz} Hz`;
  }
  return `Retuned ${Number(centsOffset) > 0 ? "+" : ""}${centsOffset} cents`;
}

export function ProjectView() {
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
    defaultInspectorOpen,
    defaultSourcesRailCollapsed,
    enharmonicDisplayMode,
    helperTextVisible,
    informationDensity,
    metadataRevealMode,
  } = usePreferences();
  const chordSegmentRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingPreviewSelection = useRef<{ previousLatestPreviewArtifactId: string | null } | null>(
    null,
  );
  const previousSourceKeyRef = useRef<MusicalKey | null>(null);
  const persistedStemSourceArtifactId = useRef<string | null>(null);
  const [retuneMode, setRetuneMode] = useState<"off" | "reference" | "cents">("off");
  const [referenceHz, setReferenceHz] = useState("440");
  const [centsOffset, setCentsOffset] = useState("0");
  const [seekAnimationRevision, setSeekAnimationRevision] = useState<Record<SeekDirection, number>>({
    backward: 0,
    forward: 0,
  });
  const [targetKeyState, setTargetKeyState] = useState<MusicalKey | null>(null);
  const [targetDirty, setTargetDirty] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [selectedPrimaryArtifactId, setSelectedPrimaryArtifactId] = useState<string | null>(null);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(defaultInspectorOpen);
  const [sourcesRailCollapsed, setSourcesRailCollapsed] = useState(defaultSourcesRailCollapsed);
  const [stemControls, setStemControls] = useState<Record<string, StemControlState>>({});
  const [dismissedStemJobIds, setDismissedStemJobIds] = useState<string[]>([]);
  const showSupportingCopy = helperTextVisible && informationDensity !== "minimal";

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
  const artifactsQuery = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: async () => (await api.listArtifacts(projectId)).artifacts,
    enabled: Boolean(projectId),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => (await api.listJobs()).jobs,
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
    mutationFn: async () =>
      api.createChords(projectId, {
        backend: "default",
        force: (chordsQuery.data?.timeline?.length ?? 0) > 0,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["chords", projectId] }),
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
    mutationFn: async () => {
      if (!selectedPrimaryArtifactId) {
        throw new Error("Select source audio or practice mix first.");
      }
      return api.createStems(projectId, {
        mode: "two_stem",
        output_format: "wav",
        force: hasVisibleStems,
        source_artifact_id: selectedPrimaryArtifactId,
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
  const sourceKeyOverride = parseStoredKey(projectQuery.data?.source_key_override);
  const sourceKeyBasis = sourceKeyOverride ?? detectedKey ?? null;
  const sourceKey = sourceKeyBasis ?? DEFAULT_KEY;
  const targetKey = targetDirty ? targetKeyState ?? sourceKey : sourceKey;
  const transposeSemitones = semitoneDelta(sourceKey, targetKey);
  const targetKeyOptions = MUSICAL_KEYS.filter((key) => key.mode === sourceKey.mode);
  const requestedRetune = buildRequestedRetune(retuneMode, referenceHz, centsOffset);
  const hasTransformChange = retuneMode !== "off" || transposeSemitones !== 0;
  const previewMatchesCurrentSettings = matchesPreviewSettings(
    latestPreviewArtifact,
    requestedRetune,
    transposeSemitones,
  );
  const selectedArtifactMatchesCurrentSettings =
    (selectedArtifact?.type === "source_audio" && !hasTransformChange) ||
    matchesPreviewSettings(selectedArtifact, requestedRetune, transposeSemitones);
  const isAnalysisRunning = Boolean(
    analyzeJob && ["pending", "running"].includes(analyzeJob.status),
  );
  const isChordRunning = Boolean(
    chordJob && ["pending", "running"].includes(chordJob.status),
  );
  const isStemRunning = Boolean(stemJob && ["pending", "running"].includes(stemJob.status));
  const currentKeyValue = sourceKeyOverride
    ? serializeKey(sourceKeyOverride)
    : detectedKey
      ? "auto"
      : serializeKey(sourceKey);
  const hasVisibleStems = visibleStemArtifacts.length > 0;
  const stemErrorMessage =
    stemJob?.error_message && !dismissedStemJobIds.includes(stemJob.id)
      ? stemJob.error_message
      : null;
  const visibleJobs = projectJobs;
  const controlSummary = hasTransformChange ? formatKey(targetKey, "short", { mode: enharmonicDisplayMode }) : "Original key";
  const tuningSummary = formatRetuneSummary(retuneMode, referenceHz, centsOffset);
  const mixStatus = isStemPlayback
    ? "Stem monitor"
    : !hasTransformChange
      ? latestPreviewArtifact
        ? "Source settings"
        : "Source only"
      : !latestPreviewArtifact
        ? "No preview yet"
        : previewMatchesCurrentSettings
          ? "Up to date"
          : "Needs update";
  const mixStatusCopy = isStemPlayback
    ? "Mute or solo stems without leaving the playback surface."
    : selectedArtifact
      ? selectedArtifactMatchesCurrentSettings
        ? "Selected playback matches current controls."
        : "Controls differ from selected playback."
      : "Select source audio or a saved mix.";
  const canDeleteSelectedMix = selectedArtifact?.type === "preview_mix";
  const selectedArtifactTimestamp = selectedPlaybackArtifact
    ? formatArtifactTimestamp(selectedPlaybackArtifact.created_at)
    : "";
  const chordTransposeSemitones = artifactTransposeSemitones(
    selectedPlaybackArtifact,
    selectableArtifacts,
  );
  const activeEnharmonicKeyContext = sourceKeyBasis
    ? transposeKey(sourceKeyBasis, chordTransposeSemitones)
    : null;
  const displayedChords = useMemo(
    () =>
      (chordsQuery.data?.timeline ?? []).map((segment) =>
        transposeChordSegment(segment, chordTransposeSemitones, {
          activeKey: activeEnharmonicKeyContext,
          mode: enharmonicDisplayMode,
        }),
      ),
    [activeEnharmonicKeyContext, chordTransposeSemitones, chordsQuery.data?.timeline, enharmonicDisplayMode],
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
  const chordContextCopy =
    chordTransposeSemitones === 0
      ? "Chord labels follow the original arrangement."
      : `Chord labels follow the selected playback (${formatSemitoneShift(
          chordTransposeSemitones,
        ).toLowerCase()}).`;
  const capoSummary = transposeSemitones > 0 ? `${transposeSemitones}` : "Off";

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

  function handleSeek(secondsDelta: number) {
    const direction: SeekDirection = secondsDelta < 0 ? "backward" : "forward";
    setSeekAnimationRevision((current) => ({
      ...current,
      [direction]: current[direction] + 1,
    }));
    seekBy(secondsDelta);
  }

  async function handleStemAction() {
    if (!selectedPrimaryArtifactId) {
      return;
    }

    if (hasVisibleStems) {
      const stemTargetLabel = selectedPrimaryArtifact
        ? artifactLabel(selectedPrimaryArtifact)
        : "selected audio";
      const approved = await confirm(
        `Rebuild stems for ${stemTargetLabel}? Existing stems will be replaced. Demucs selects GPU automatically when available, otherwise it falls back to CPU and may take longer.`,
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
    }

    stemMutation.mutate();
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
    const approved = await confirm("Delete this practice mix and its stem tracks?", {
      title: "Delete practice mix",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
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
    const previousSourceKey = previousSourceKeyRef.current;
    if (previousSourceKey && targetDirty) {
      const delta = semitoneDelta(previousSourceKey, sourceKey);
      if (delta !== 0) {
        setTargetKeyState((current) => (current ? transposeKey(current, delta) : current));
      }
    }
    previousSourceKeyRef.current = sourceKey;
  }, [sourceKey, targetDirty]);

  useEffect(() => {
    setInspectorOpen(defaultInspectorOpen);
  }, [defaultInspectorOpen]);

  useEffect(() => {
    setSourcesRailCollapsed(defaultSourcesRailCollapsed);
  }, [defaultSourcesRailCollapsed]);

  useEffect(() => {
    const storedPlaybackState = readProjectPlaybackState(projectId);
    pendingPreviewSelection.current = null;
    persistedStemSourceArtifactId.current = storedPlaybackState.selectedStemSourceArtifactId;
    setSelectedArtifactId(storedPlaybackState.selectedArtifactId);
    setSelectedPrimaryArtifactId(storedPlaybackState.selectedPrimaryArtifactId);
    setStemControls(storedPlaybackState.stemControls);
    setDismissedStemJobIds(storedPlaybackState.dismissedStemJobIds);
    setHydratedProjectId(projectId);
  }, [projectId]);

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
      stemControls,
      dismissedStemJobIds,
    });
  }, [
    dismissedStemJobIds,
    hydratedProjectId,
    projectId,
    selectedArtifactId,
    selectedPrimaryArtifactId,
    selectedStemSourceArtifactId,
    stemControls,
  ]);

  useEffect(() => {
    if (activeChordIndex < 0) {
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
    activeElement?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [activeChordIndex, displayedChords]);

  const currentSourceLabel = selectedPrimaryArtifact
    ? artifactLabel(selectedPrimaryArtifact)
    : "Source Track";
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
    });
  }, [
    hydratedProjectId,
    isStemPlayback,
    projectId,
    projectQuery.data?.display_name,
    projectQuery.data?.duration_seconds,
    registerProjectSession,
    selectedPlaybackArtifact,
    stageSummary,
    stageTitle,
    stemControls,
    visibleStemArtifacts,
  ]);

  return (
    <section className="screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">
            <Link to="/">Library</Link> / Project
          </p>
          {isRenaming ? (
            <div className="title-edit">
              <input
                aria-label="Project name"
                className="title-input"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
              <div className="button-row">
                <button
                  className="button button--primary button--small"
                  type="button"
                  onClick={() => renameMutation.mutate()}
                  disabled={renameMutation.isPending || !draftName.trim()}
                >
                  {renameMutation.isPending ? "Saving..." : "Save"}
                </button>
                <button
                  className="button button--ghost button--small"
                  type="button"
                  onClick={() => {
                    setIsRenaming(false);
                    setDraftName(projectQuery.data?.display_name ?? "");
                  }}
                  disabled={renameMutation.isPending}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="title-row">
              <h1>{projectQuery.data?.display_name ?? "Project"}</h1>
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => setIsRenaming(true)}
              >
                Rename
              </button>
            </div>
          )}
          {showSupportingCopy ? (
            <p className="screen__subtitle">
              Keep source audio, saved mixes, chords, and stems close to transport.
            </p>
          ) : null}
        </div>

        <div className="button-row">
          <button
            className="button button--primary"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !hasTransformChange}
          >
            {previewMutation.isPending ? "Queueing..." : "Create Mix"}
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => setInspectorOpen((current) => !current)}
          >
            {inspectorOpen ? "Hide Inspector" : "Show Inspector"}
          </button>
        </div>
      </div>

      <div
        className={`project-workbench${inspectorOpen ? "" : " project-workbench--wide"}${
          sourcesRailCollapsed ? " project-workbench--sources-collapsed" : ""
        }`}
      >
        <aside className={`stack sources-rail${sourcesRailCollapsed ? " sources-rail--collapsed" : ""}`}>
          <div className={`panel rail-panel${sourcesRailCollapsed ? " rail-panel--collapsed" : ""}`}>
            <div className="rail-panel__top">
              {sourcesRailCollapsed ? <span className="rail-panel__collapsed-spacer" aria-hidden="true" /> : (
                <div className="rail-panel__identity">
                  <h2>Sources</h2>
                  {showSupportingCopy ? (
                    <p className="subpanel__copy">Jump between the raw track, saved mixes, and stems.</p>
                  ) : null}
                </div>
              )}
              <button
                aria-label={sourcesRailCollapsed ? "Expand sources rail" : "Collapse sources rail"}
                className={`button button--ghost button--small rail-panel__toggle${
                  sourcesRailCollapsed ? " rail-panel__toggle--collapsed" : ""
                }`}
                onClick={() => setSourcesRailCollapsed((current) => !current)}
                type="button"
              >
                <span aria-hidden="true" className="rail-panel__toggle-icon">
                  <span />
                  <span />
                  <span />
                </span>
                {sourcesRailCollapsed ? null : <span>Hide</span>}
              </button>
            </div>

            {sourcesRailCollapsed ? (
              <div className="rail-panel__collapsed">
                {sourcesRailSummary.map((item) => (
                  <div key={item.label} className="rail-summary-chip">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="rail-section">
                  <div
                    className="artifact-selector artifact-selector--stacked"
                    role="group"
                    aria-label="Source and mix list"
                  >
                    {sourceArtifact ? (
                      <button
                        className={`artifact-pill${
                          selectedArtifactId === sourceArtifact.id ? " artifact-pill--active" : ""
                        }`}
                        onClick={() => handleSelectPrimaryArtifact(sourceArtifact)}
                        type="button"
                      >
                        <span className="artifact-pill__title">Source Track</span>
                        <span className="artifact-pill__meta">
                          {artifactSummary(sourceArtifact)}
                        </span>
                        {informationDensity === "detailed" ? (
                          <span className="artifact-pill__meta">
                            {fileNameFromPath(sourceArtifact.path)}
                          </span>
                        ) : null}
                      </button>
                    ) : (
                      <p className="artifact-meta">No source track available.</p>
                    )}
                  </div>
                </div>

                <div className="rail-section">
                  <div className="rail-section__header">
                    <div>
                      <h3>Saved Mixes</h3>
                      {showSupportingCopy ? (
                        <p className="subpanel__copy">Practice variants stay one click away.</p>
                      ) : null}
                    </div>
                  </div>
                  {previewArtifacts.length ? (
                    <div
                      className="artifact-selector artifact-selector--stacked"
                      role="group"
                      aria-label="Saved mix list"
                    >
                      {previewArtifacts.map((artifact) => (
                        <button
                          key={artifact.id}
                          className={`artifact-pill${
                            selectedArtifactId === artifact.id ? " artifact-pill--active" : ""
                          }`}
                          onClick={() => handleSelectPrimaryArtifact(artifact)}
                          type="button"
                        >
                          <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                          <span className="artifact-pill__meta">
                            {artifactSummary(artifact) || formatArtifactTimestamp(artifact.created_at)}
                          </span>
                          {informationDensity === "detailed" ? (
                            <span className="artifact-pill__meta">
                              {formatArtifactTimestamp(artifact.created_at)}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="artifact-meta">No saved mixes yet. Build one from inspector controls.</p>
                  )}
                </div>

                <div className="rail-section">
                  <div className="rail-section__header">
                    <div>
                      <h3>Stems</h3>
                      {showSupportingCopy ? (
                        <p className="subpanel__copy">Stem playback stays scoped to the selected source or mix.</p>
                      ) : null}
                    </div>
                    <button
                      className="button button--small"
                      onClick={() => void handleStemAction()}
                      disabled={stemMutation.isPending || isStemRunning || !selectedPrimaryArtifactId}
                      type="button"
                    >
                      {stemMutation.isPending || isStemRunning
                        ? hasVisibleStems
                          ? "Rebuilding..."
                          : "Generating..."
                        : hasVisibleStems
                          ? "Rebuild Stems"
                          : "Generate Stems"}
                    </button>
                  </div>
                  {visibleStemArtifacts.length ? (
                    <div
                      className="artifact-selector artifact-selector--stacked"
                      role="group"
                      aria-label="Stem track list"
                    >
                      {visibleStemArtifacts.map((artifact) => (
                        <button
                          key={artifact.id}
                          className={`artifact-pill${
                            selectedArtifactId === artifact.id ? " artifact-pill--active" : ""
                          }`}
                          onClick={() => handleSelectStemArtifact(artifact)}
                          type="button"
                        >
                          <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                          <span className="artifact-pill__meta">{stemOutputLabel(artifact.id)}</span>
                          {informationDensity !== "minimal" ? (
                            <span className="artifact-pill__meta">{artifactSummary(artifact)}</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="artifact-meta">
                      {selectedPrimaryArtifactId
                        ? "No stems yet for selected audio."
                        : "Select source audio or a saved mix first."}
                    </p>
                  )}
                  {stemErrorMessage && stemJob ? (
                    <div className="button-row" role="group" aria-label="Stem error">
                      <span className="inline-error">{stemErrorMessage}</span>
                      <button
                        className="button button--ghost button--small"
                        onClick={() =>
                          setDismissedStemJobIds((current) =>
                            current.includes(stemJob.id) ? current : [...current, stemJob.id],
                          )
                        }
                        type="button"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </aside>

        <div className="stack">
          <div className="panel playback-stage">
            <div className="playback-stage__header">
              <div>
                <p className="metric-label">Now Playing</p>
                <h2>{stageTitle}</h2>
                <p className="artifact-meta">{stageSummary}</p>
              </div>
              <div className="playback-focus__meta">
                <span>{stageModeLabel}</span>
                {selectedArtifactTimestamp ? <span>{selectedArtifactTimestamp}</span> : null}
              </div>
            </div>

            <div className="stage-surface">
              <div className="session-block playback-stage__summary">
                <div role="group" aria-label="Current source summary">
                  <p className="metric-label">Current Source</p>
                  <strong>{currentSourceLabel}</strong>
                  <p className="artifact-meta">{currentSourceSummary}</p>
                </div>
                <div role="group" aria-label="Current control summary">
                  <p className="metric-label">Mix Controls</p>
                  <strong>{controlSummary}</strong>
                  <p className="artifact-meta">{tuningSummary}</p>
                </div>
                <div role="group" aria-label="Mix status summary">
                  <p className="metric-label">Status</p>
                  <strong>{mixStatus}</strong>
                  <p className="artifact-meta">{mixStatusCopy}</p>
                </div>
              </div>

              <div className="transport">
                <div className="transport__controls">
                  <button
                    aria-label="Seek back 10 seconds"
                    className="button transport__button transport__button--seek"
                    onClick={() => handleSeek(-10)}
                    type="button"
                  >
                    <SeekGlyph
                      key={`backward-${seekAnimationRevision.backward}`}
                      animate={seekAnimationRevision.backward > 0}
                      direction="backward"
                    />
                  </button>
                  <button
                    aria-label={isPlaying ? "Pause playback" : "Play playback"}
                    aria-pressed={isPlaying}
                    className="button transport__button transport__button--play"
                    onClick={() => void togglePlayback()}
                    type="button"
                  >
                    <PlayPauseGlyph isPlaying={isPlaying} />
                  </button>
                  <button
                    aria-label="Stop playback"
                    className="button transport__button transport__button--stop"
                    onClick={stopPlayback}
                    type="button"
                  >
                    <StopGlyph />
                  </button>
                  <button
                    aria-label="Seek forward 10 seconds"
                    className="button transport__button transport__button--seek"
                    onClick={() => handleSeek(10)}
                    type="button"
                  >
                    <SeekGlyph
                      key={`forward-${seekAnimationRevision.forward}`}
                      animate={seekAnimationRevision.forward > 0}
                      direction="forward"
                    />
                  </button>
                </div>

                <label className="transport__scrubber">
                  <span className="metric-label">Playback position</span>
                  <input
                    aria-label="Playback position"
                    max={playbackDurationSeconds || projectQuery.data?.duration_seconds || 0}
                    min={0}
                    onChange={(event) => seekTo(Number(event.target.value))}
                    step={0.001}
                    type="range"
                    value={Math.min(
                      playbackTimeSeconds,
                      playbackDurationSeconds || projectQuery.data?.duration_seconds || 0,
                    )}
                  />
                  <div className="transport__times">
                    <strong>{formatPlaybackClock(playbackTimeSeconds)}</strong>
                    <span>
                      {formatPlaybackClock(
                        playbackDurationSeconds || projectQuery.data?.duration_seconds || 0,
                      )}
                    </span>
                  </div>
                </label>
              </div>
            </div>

            <div className="playback-stage__lane">
              <div className="playback-stage__lane-header">
                <div>
                  <p className="metric-label">Chord Follow</p>
                  <h3>Current harmony</h3>
                </div>
                <button
                  className="button button--small"
                  type="button"
                  onClick={() => chordMutation.mutate()}
                  disabled={chordMutation.isPending || isChordRunning}
                >
                  {chordMutation.isPending || isChordRunning
                    ? "Generating..."
                    : hasChordTimeline
                      ? "Refresh Chords"
                      : "Generate Chords"}
                </button>
              </div>

              <div className="chord-preview-grid">
                <div className="chord-card" role="group" aria-label="Current chord card">
                  <span className="metric-label">Current</span>
                  <strong>{currentChord?.label ?? "-"}</strong>
                </div>
                <div className="chord-card" role="group" aria-label="Next chord card">
                  <span className="metric-label">Next</span>
                  <strong>{nextChord?.label ?? "-"}</strong>
                </div>
              </div>

              {showSupportingCopy ? (
                <div className="chord-context">
                  <span className="artifact-meta">{chordContextCopy}</span>
                </div>
              ) : null}

              {hasChordTimeline ? (
                <div className="chord-timeline" role="group" aria-label="Chord timeline">
                  {displayedChords.map((segment, index) => {
                    const durationWeight = Math.max(
                      0.9,
                      segment.end_seconds - segment.start_seconds,
                    );
                    const isActive = index === activeChordIndex;
                    return (
                      <button
                        key={`${segment.start_seconds}-${segment.label}-${index}`}
                        className={`chord-segment${isActive ? " chord-segment--active" : ""}`}
                        type="button"
                        style={{ flexGrow: durationWeight }}
                        aria-pressed={isActive}
                        ref={(element) => {
                          chordSegmentRefs.current[
                            `${segment.start_seconds}-${segment.label}-${index}`
                          ] = element;
                        }}
                        onClick={() => seekTo(segment.start_seconds)}
                      >
                        <span>{segment.label}</span>
                        <small>{formatPlaybackClock(segment.start_seconds)}</small>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="chord-lane-empty">
                  <p className="artifact-meta">
                    Generate a chord pass to jump around the arrangement while you practice.
                  </p>
                </div>
              )}

              {chordJob?.error_message ? (
                <p className="inline-error">{chordJob.error_message}</p>
              ) : null}
            </div>

            {visibleStemArtifacts.length ? (
              <div className="stage-subsection">
                <div className="panel-heading">
                  <div>
                    <h3>Stem Monitor</h3>
                    {showSupportingCopy ? (
                      <p className="subpanel__copy">
                        Mute or solo stems without leaving the transport surface.
                      </p>
                    ) : null}
                  </div>
                  {isStemPlayback ? (
                    <button
                      className="button button--small"
                      onClick={() => {
                        if (selectedPrimaryArtifact) {
                          handleSelectPrimaryArtifact(selectedPrimaryArtifact);
                        }
                      }}
                      type="button"
                    >
                      Return to Full Mix
                    </button>
                  ) : (
                    <button
                      className="button button--small"
                      onClick={() => {
                        if (visibleStemArtifacts[0]) {
                          handleSelectStemArtifact(visibleStemArtifacts[0]);
                        }
                      }}
                      type="button"
                    >
                      Switch to Stems
                    </button>
                  )}
                </div>

                <div className="stem-mixer">
                  <div className="stem-mixer__summary">
                    <span className="metric-label">Audible stems</span>
                    <strong>
                      {activeStemCount} / {visibleStemArtifacts.length}
                    </strong>
                  </div>
                  {visibleStemArtifacts.map((artifact) => {
                    const state = stemControls[artifact.id] ?? {
                      muted: false,
                      solo: false,
                    };
                    return (
                      <div className="stem-row" key={artifact.id}>
                        <button
                          className={`stem-row__name${
                            selectedArtifactId === artifact.id ? " stem-row__name--active" : ""
                          }`}
                          onClick={() => handleSelectStemArtifact(artifact)}
                          type="button"
                        >
                          <span>{artifactLabel(artifact)}</span>
                          <small>{stemOutputLabel(artifact.id)}</small>
                        </button>
                        <div className="stem-row__controls">
                          <button
                            className={`chip${state.muted ? " chip--active" : ""}`}
                            aria-label={`Mute ${artifactLabel(artifact)}`}
                            aria-pressed={state.muted}
                            onClick={() => toggleStemControl(artifact, "muted")}
                            type="button"
                          >
                            Mute
                          </button>
                          <button
                            className={`chip${state.solo ? " chip--active" : ""}`}
                            aria-label={`Solo ${artifactLabel(artifact)}`}
                            aria-pressed={state.solo}
                            onClick={() => toggleStemControl(artifact, "solo")}
                            type="button"
                          >
                            Solo
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>Jobs and History</h2>
                {showSupportingCopy ? (
                  <p className="subpanel__copy">
                    Raw artifacts and job logs stay available without crowding playback.
                  </p>
                ) : null}
              </div>
            </div>

            <details className="details-block details-block--flush">
              <summary>Show raw artifacts and processing history</summary>
              <div className="details-stack">
                <ul className="artifact-list">
                  {displayArtifacts.length ? (
                    displayArtifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <span>{artifactLabel(artifact)}</span>
                        <small>{artifact.format.toUpperCase()}</small>
                        <small>{formatArtifactTimestamp(artifact.created_at)}</small>
                        {artifactSummary(artifact) ? (
                          <small>{artifactSummary(artifact)}</small>
                        ) : null}
                      </li>
                    ))
                  ) : (
                    <li>No artifacts yet.</li>
                  )}
                </ul>

                <ul className="job-list">
                  {visibleJobs.length ? (
                    visibleJobs.map((job) => (
                      <li key={job.id}>
                        <div>
                          <strong>{job.type}</strong>
                          <span>{job.status}</span>
                        </div>
                        <progress max={100} value={job.progress} />
                        {job.error_message ? (
                          <small className="inline-error">{job.error_message}</small>
                        ) : null}
                      </li>
                    ))
                  ) : (
                    <li>No jobs yet.</li>
                  )}
                </ul>
              </div>
            </details>
          </div>
        </div>

        {inspectorOpen ? (
          <aside className="stack">
            <div className="panel inspector-panel">
              <div className="panel-heading">
                <div>
                  <h2>Inspector</h2>
                  {showSupportingCopy ? (
                    <p className="subpanel__copy">
                      Mix decisions stay compact and close to playback.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="section-stack">
                <div className="subpanel">
                  <div className="subpanel__header">
                    <h3>Mix Builder</h3>
                  </div>
                  <div className="controls">
                    <label>
                      Retune
                      <select
                        aria-label="Retune"
                        value={retuneMode}
                        onChange={(event) =>
                          setRetuneMode(event.target.value as "off" | "reference" | "cents")
                        }
                      >
                        <option value="off">Off</option>
                        <option value="reference">Target Reference Hz</option>
                        <option value="cents">Direct Cents Offset</option>
                      </select>
                    </label>

                    {retuneMode === "reference" ? (
                      <label>
                        Target Reference Hz
                        <input
                          aria-label="Target Reference Hz"
                          value={referenceHz}
                          onChange={(event) => setReferenceHz(event.target.value)}
                          type="number"
                          step="0.1"
                        />
                      </label>
                    ) : null}

                    {retuneMode === "cents" ? (
                      <label>
                        Cents Offset
                        <input
                          aria-label="Cents Offset"
                          value={centsOffset}
                          onChange={(event) => setCentsOffset(event.target.value)}
                          type="number"
                          step="0.1"
                        />
                      </label>
                    ) : null}
                  </div>

                  <div className="key-shift key-shift--compact">
                    <div className="key-shift__header">
                      <div>
                        <span className="metric-label">Source Key</span>
                        <strong>{formatKey(sourceKey, "short", { mode: enharmonicDisplayMode })}</strong>
                        <small className="artifact-meta">
                          {sourceKeyOverride
                            ? "Corrected"
                            : detectedKey
                              ? "Detected"
                              : "Default"}
                        </small>
                      </div>
                      <div>
                        <span className="metric-label">Target Key</span>
                        <strong>{formatKey(targetKey, "short", { mode: enharmonicDisplayMode })}</strong>
                      </div>
                      <div>
                        <span className="metric-label">Capo</span>
                        <strong>{capoSummary}</strong>
                        <small className="artifact-meta">Practice cue</small>
                      </div>
                      <span className="key-shift__meta">{formatSemitoneShift(transposeSemitones)}</span>
                    </div>

                    <div className="key-stepper">
                      <button
                        className="button"
                        aria-label="Lower target key"
                        onClick={() => {
                          setTargetDirty(true);
                          setTargetKeyState((current) =>
                            transposeKey(current ?? sourceKey, -1),
                          );
                        }}
                        type="button"
                      >
                        -
                      </button>
                      <label className="key-stepper__value">
                        <span className="key-stepper__label">Target Key</span>
                        <select
                          aria-label="Target Key"
                          value={serializeKey(targetKey)}
                          onChange={(event) => {
                            setTargetDirty(true);
                            setTargetKeyState(deserializeKey(event.target.value));
                          }}
                        >
                          {targetKeyOptions.map((key) => (
                            <option key={key.value} value={key.value}>
                              {formatKey(key, "short", { mode: enharmonicDisplayMode })}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="button"
                        aria-label="Raise target key"
                        onClick={() => {
                          setTargetDirty(true);
                          setTargetKeyState((current) =>
                            transposeKey(current ?? sourceKey, 1),
                          );
                        }}
                        type="button"
                      >
                        +
                      </button>
                    </div>

                  </div>

                  {previewMutation.isError ? (
                    <p className="inline-error">
                      {previewMutation.error instanceof Error
                        ? previewMutation.error.message
                        : "Could not create preview."}
                    </p>
                  ) : null}
                </div>

                <div className="subpanel">
                  <div className="panel-heading panel-heading--compact">
                    <div>
                      <h3>Analysis</h3>
                    </div>
                    <button
                      className="button button--small"
                      onClick={() => analyzeMutation.mutate()}
                      disabled={analyzeMutation.isPending || isAnalysisRunning}
                      type="button"
                    >
                      {analyzeMutation.isPending || isAnalysisRunning
                        ? "Analyzing..."
                        : analysisQuery.data
                          ? "Refresh Analysis"
                          : "Analyze Track"}
                    </button>
                  </div>
                  <div className="analysis-grid">
                    <div className="analysis-stat">
                      <span className="metric-label">Detected Tuning</span>
                      <strong>
                        <span className="analysis-stat__value">
                          {analysisQuery.data?.estimated_reference_hz?.toFixed(2) ?? "Pending"}
                        </span>
                        <span className="analysis-stat__unit">Hz</span>
                      </strong>
                    </div>
                    <div className="analysis-stat">
                      <span className="metric-label">Offset</span>
                      <strong>
                        <span className="analysis-stat__value">
                          {analysisQuery.data?.tuning_offset_cents?.toFixed(2) ?? "-"}
                        </span>
                        <span className="analysis-stat__unit">cents</span>
                      </strong>
                    </div>
                    <div className="analysis-stat">
                      <span className="metric-label">Estimated Key</span>
                      <strong>
                        <span className="analysis-stat__value">
                          {detectedKey
                            ? formatKey(detectedKey, "short", { mode: enharmonicDisplayMode })
                            : isAnalysisRunning
                              ? "Analyzing..."
                              : "Unknown"}
                        </span>
                      </strong>
                    </div>
                    <div className="analysis-stat">
                      <span className="metric-label">Confidence</span>
                      <strong>
                        <span className="analysis-stat__value">
                          {analysisQuery.data?.key_confidence?.toFixed(2) ?? "-"}
                        </span>
                      </strong>
                    </div>
                  </div>
                  <details className="details-block details-block--inset">
                    <summary>Correct source key for this project</summary>
                    <p className="artifact-meta">
                      {sourceKeyOverride
                        ? `Using ${formatKey(sourceKeyOverride, "short", { mode: enharmonicDisplayMode })} everywhere keys are derived in this project. Analysis data stays unchanged.`
                        : "Use this to change the detected key, if you think analysis got it wrong. It updates the project key, and practice mixes."}
                    </p>
                    <div className="controls controls--tight">
                      <label>
                        Project Source Key
                        <select
                          aria-label="Project Source Key"
                          value={currentKeyValue}
                          onChange={(event) =>
                            sourceKeyOverrideMutation.mutate(
                              event.target.value === "auto" ? null : event.target.value,
                            )
                          }
                          disabled={sourceKeyOverrideMutation.isPending}
                        >
                          {detectedKey ? (
                            <option value="auto">
                              Use analysis result ({formatKey(detectedKey, "short", { mode: enharmonicDisplayMode })})
                            </option>
                          ) : (
                            <option value={serializeKey(sourceKey)}>No override</option>
                          )}
                          {MUSICAL_KEYS.map((key) => (
                            <option key={key.value} value={key.value}>
                              {formatKey(key, "short", { mode: enharmonicDisplayMode })}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </details>
                </div>

                <div className="subpanel subpanel--compact">
                  <div className="subpanel__header">
                    <h3>Export</h3>
                    {showSupportingCopy ? (
                      <p className="subpanel__copy">
                        Export only when you need audio outside the app.
                      </p>
                    ) : null}
                  </div>
                  <button
                    className="button"
                    onClick={() => exportMutation.mutate()}
                    disabled={exportMutation.isPending}
                    type="button"
                  >
                    {exportMutation.isPending ? "Queueing..." : "Export Selected Audio"}
                  </button>
                </div>

                <div className="subpanel">
                  <div className="subpanel__header">
                    <h3>Project Details</h3>
                  </div>
                  <dl className="meta-grid">
                    <div className="meta-stat">
                      <dt>Duration</dt>
                      <dd>
                        <span className="meta-stat__value">
                          {projectQuery.data?.duration_seconds?.toFixed(2) ?? "Unknown"}
                        </span>
                        <span className="meta-stat__unit">s</span>
                      </dd>
                    </div>
                    <div className="meta-stat">
                      <dt>Sample Rate</dt>
                      <dd>
                        <span className="meta-stat__value">
                          {projectQuery.data?.sample_rate ?? "Unknown"}
                        </span>
                        <span className="meta-stat__unit">Hz</span>
                      </dd>
                    </div>
                    <div className="meta-stat">
                      <dt>Channels</dt>
                      <dd>
                        <span className="meta-stat__value">
                          {projectQuery.data?.channels ?? "Unknown"}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  {metadataRevealMode === "expand" ? (
                    <details className="details-block">
                      <summary>Show file details</summary>
                      <dl className="details-grid details-grid--single-column">
                        <div>
                          <dt>Imported Path</dt>
                          <dd className="path">{projectQuery.data?.imported_path ?? "Unknown"}</dd>
                        </div>
                        <div>
                          <dt>Original Source</dt>
                          <dd className="path">{projectQuery.data?.source_path ?? "Unknown"}</dd>
                        </div>
                      </dl>
                    </details>
                  ) : (
                    <p className="artifact-meta" title={projectQuery.data?.source_path ?? ""}>
                      Hover for file path
                    </p>
                  )}
                </div>

                <div className="subpanel subpanel--compact subpanel--danger">
                  <div className="subpanel__header">
                    <h3>Danger Zone</h3>
                  </div>
                  <div className="button-row">
                    {canDeleteSelectedMix ? (
                      <button
                        className="button button--ghost button--small"
                        onClick={handleDeleteMix}
                        disabled={deleteMixMutation.isPending}
                        type="button"
                      >
                        {deleteMixMutation.isPending ? "Deleting..." : "Delete Practice Mix"}
                      </button>
                    ) : null}
                    <button
                      className="button button--ghost button--small"
                      onClick={handleDeleteProject}
                      disabled={deleteMutation.isPending}
                      type="button"
                    >
                      Delete Project
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
