import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  ApiError,
  api,
  type ExportRequest,
  type GeneratedExportDocumentId,
} from "../../../lib/api";
import { useProjectViewModelContext } from "../components/useProjectViewModelContext";
import {
  buildExportAudioSets,
  androidAudioExportUnavailableReason,
  exportContextName,
  exportOutputNames,
  generatedDocumentOutputNames,
  exportPresetForSelection,
  isDesktopDestinationTarget,
  defaultExportWorkspaceState,
  reconcileExportWorkspaceState,
  type ExportDestinationType,
  type ExportFormat,
  type ExportPreset,
} from "../exportWorkspaceUtils";
import type { ExportWorkspaceState } from "../projectPlaybackState";
import { artifactTransposeSemitones } from "../projectViewUtils";
import { useActiveJobPolling } from "./useActiveJobPolling";

type DestinationType = ExportDestinationType;

const FORMAT_LABELS: Record<ExportFormat, string> = {
  wav: "WAV",
  flac: "FLAC",
  mp3: "MP3",
  m4a: "M4A",
};

function isExportDestinationExistsError(error: unknown) {
  return error instanceof ApiError && error.code === "EXPORT_DESTINATION_EXISTS";
}

function selectedIdsForPreset(
  preset: Exclude<ExportPreset, "custom">,
  trackId: string,
  stemIds: string[],
) {
  if (preset === "track") return new Set([trackId]);
  if (preset === "stems") return new Set(stemIds);
  return new Set([trackId, ...stemIds]);
}

export function useExportWorkspace() {
  const {
    displayArtifacts,
    displayedChords,
    displayedLyrics,
    chordsQuerySettled,
    chordsQuerySucceeded,
    lyricsQuerySettled,
    lyricsQuerySucceeded,
    artifactsQuery,
    exportWorkspace,
    enharmonicDisplayMode,
    handleSetExportWorkspace,
    handleShowExportRecoveryNotice,
    handleSelectProjectPanel,
    hydratedProjectId,
    isMobileRuntime,
    projectEditLocked,
    projectId,
    projectQuery,
    selectedPrimaryArtifactId,
    visibleJobs,
  } = useProjectViewModelContext();
  const queryClient = useQueryClient();
  const isCurrentProjectHydrated =
    hydratedProjectId === projectId && projectQuery.data?.id === projectId && artifactsQuery.isSuccess;
  const audioSets = useMemo(
    () => isCurrentProjectHydrated ? buildExportAudioSets(displayArtifacts) : [],
    [displayArtifacts, isCurrentProjectHydrated],
  );
  const defaultAudioSetId =
    audioSets.find((audioSet) => audioSet.artifact.id === selectedPrimaryArtifactId)?.artifact.id ??
    audioSets[0]?.artifact.id ??
    "";
  const fallbackState = useMemo<ExportWorkspaceState | null>(() => {
    if (!isCurrentProjectHydrated) return null;
    return {
      audioSetId: defaultAudioSetId || null,
      selectedArtifactIds: defaultAudioSetId ? [defaultAudioSetId] : [],
      selectedGeneratedDocumentIds: [],
      outputFormat: "m4a",
      filenameBase: isCurrentProjectHydrated
        ? projectQuery.data?.display_name ?? "TuneForge Export"
        : "TuneForge Export",
      destinationType: "single_file",
      desktopDestinationTarget: null,
    };
  }, [defaultAudioSetId, isCurrentProjectHydrated, projectQuery.data?.display_name]);
  const availableGeneratedDocumentIds = useMemo(() => {
    const available = new Set<GeneratedExportDocumentId>();
    if (
      lyricsQuerySucceeded &&
      displayedLyrics.some((segment) => segment.text.trim())
    ) {
      available.add("lyrics");
      if (chordsQuerySucceeded && displayedChords.length) available.add("lyrics_with_chords");
    }
    return available;
  }, [
    chordsQuerySucceeded,
    displayedChords.length,
    displayedLyrics,
    lyricsQuerySucceeded,
  ]);
  const storedDocumentIds = useMemo(
    () => exportWorkspace?.selectedGeneratedDocumentIds ?? [],
    [exportWorkspace?.selectedGeneratedDocumentIds],
  );
  const relevantDocumentAvailabilitySettled = Boolean(
    !storedDocumentIds.length ||
      (lyricsQuerySettled &&
        (!storedDocumentIds.includes("lyrics_with_chords") || chordsQuerySettled)),
  );
  const reconciliationDocumentIds = useMemo(
    () => relevantDocumentAvailabilitySettled
      ? availableGeneratedDocumentIds
      : new Set(storedDocumentIds),
    [availableGeneratedDocumentIds, relevantDocumentAvailabilitySettled, storedDocumentIds],
  );
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: () => api.getHealth(),
    staleTime: Infinity,
  });
  const capabilitiesQuery = useQuery({
    queryKey: ["export-capabilities"],
    queryFn: () => api.getExportCapabilities(),
    staleTime: Infinity,
  });
  const capabilities = capabilitiesQuery.data?.capabilities ?? null;
  const healthSettled = healthQuery.isSuccess || healthQuery.isError;
  const defaultOutputFormat = healthQuery.isSuccess
    ? healthQuery.data.default_export_format
    : null;
  const savedFormatIsAvailable = Boolean(
    exportWorkspace?.outputFormat && capabilities?.formats.some(
      (format) => format.id === exportWorkspace.outputFormat && format.available,
    ),
  );
  const workspaceReady = Boolean(
    isCurrentProjectHydrated &&
      capabilitiesQuery.isSuccess &&
      capabilities &&
      (healthSettled || savedFormatIsAvailable),
  );
  const reconciliation = useMemo(
    () => workspaceReady && capabilities
      ? reconcileExportWorkspaceState({
          storedState: exportWorkspace,
          audioSets,
          selectedPrimaryArtifactId,
          filenameBase: projectQuery.data?.display_name ?? "TuneForge Export",
          capabilities,
          defaultOutputFormat,
          availableGeneratedDocumentIds: reconciliationDocumentIds,
        })
      : null,
    [
      audioSets,
      capabilities,
      defaultOutputFormat,
      exportWorkspace,
      projectQuery.data?.display_name,
      reconciliationDocumentIds,
      selectedPrimaryArtifactId,
      workspaceReady,
    ],
  );
  const draft = reconciliation?.state ?? fallbackState;
  const audioSetId = draft?.audioSetId ?? "";
  const selectedIds = useMemo(() => new Set(draft?.selectedArtifactIds ?? []), [draft?.selectedArtifactIds]);
  const selectedDocumentIds = useMemo(
    () => draft?.selectedGeneratedDocumentIds ?? [],
    [draft?.selectedGeneratedDocumentIds],
  );
  const selectedDocumentIdSet = useMemo(() => new Set(selectedDocumentIds), [selectedDocumentIds]);
  const outputFormat = draft?.outputFormat ?? "m4a";
  const filenameBase = draft?.filenameBase ?? fallbackState?.filenameBase ?? "TuneForge Export";
  const destinationType = draft?.destinationType ?? "single_file";
  const destinationTarget = draft?.desktopDestinationTarget ?? null;
  const recoveredDrafts = useRef(new Set<string>());
  const audioSet = audioSets.find((candidate) => candidate.artifact.id === audioSetId) ?? audioSets[0] ?? null;
  const documentMixTransposeSemitones = artifactTransposeSemitones(
    audioSet?.artifact ?? null,
    displayArtifacts,
  );
  const documentChordContext = documentMixTransposeSemitones === 0
    ? "Source key"
    : `Matches ${audioSet?.label ?? "selected audio"} (${documentMixTransposeSemitones > 0 ? "+" : ""}${documentMixTransposeSemitones} semitone${Math.abs(documentMixTransposeSemitones) === 1 ? "" : "s"})`;

  useEffect(() => {
    if (!reconciliation) {
      return;
    }
    if (JSON.stringify(reconciliation.state) === JSON.stringify(exportWorkspace)) return;
    const storedFingerprint = JSON.stringify(exportWorkspace);
    if (reconciliation.recovery && !recoveredDrafts.current.has(`${projectId}:${storedFingerprint}`)) {
      recoveredDrafts.current.add(`${projectId}:${storedFingerprint}`);
      handleShowExportRecoveryNotice();
    }
    handleSetExportWorkspace(reconciliation.state);
  }, [
    exportWorkspace,
    handleSetExportWorkspace,
    handleShowExportRecoveryNotice,
    projectId,
    reconciliation,
  ]);
  const selectedArtifacts = audioSet
    ? [audioSet.artifact, ...audioSet.stems].filter((artifact) => selectedIds.has(artifact.id))
    : [];
  const preset = audioSet ? exportPresetForSelection(audioSet, selectedIds) : "custom";
  const audioOutputNames = audioSet
    ? exportOutputNames(audioSet, selectedIds, filenameBase, outputFormat)
    : [];
  const documentOutputNames = generatedDocumentOutputNames(selectedDocumentIds, filenameBase);
  const outputNames = [...audioOutputNames, ...documentOutputNames];
  const totalSelectedCount = selectedIds.size + selectedDocumentIds.length;
  const activeExportJob = visibleJobs.find(
    (job) => job.type === "export" && ["pending", "running"].includes(job.status),
  );
  const latestExportJob = visibleJobs.find((job) => job.type === "export") ?? null;
  const partialExportJob = latestExportJob?.export_result?.outcome === "partial" ? latestExportJob : null;
  const failedArtifactIds = partialExportJob?.export_result?.items
    .filter((item) => item.status === "failed")
    .map((item) => item.artifact_id)
    .filter((id): id is string => id != null) ?? [];
  const failedDocumentIds = partialExportJob?.export_result?.items
    .filter((item) => item.status === "failed")
    .map((item) => item.generated_document_id)
    .filter((id): id is GeneratedExportDocumentId =>
      id != null && availableGeneratedDocumentIds.has(id)) ?? [];
  const retryAudioSet = audioSets.find((candidate) =>
    failedArtifactIds.some(
      (id) => id === candidate.artifact.id || candidate.stems.some((stem) => stem.id === id),
    ),
  ) ?? null;
  const maxArtifactCount = capabilities?.max_artifact_count ?? null;
  const selectedFormatCapability = capabilities?.formats.find((format) => format.id === outputFormat);
  const selectedDestinationCapability = capabilities?.destinations.find(
    (destination) => destination.id === destinationType,
  );
  const selectionAllowed = maxArtifactCount === null || totalSelectedCount <= maxArtifactCount;
  const canExport = Boolean(
    totalSelectedCount &&
      filenameBase.trim() &&
      (!selectedIds.size || selectedFormatCapability?.available) &&
      (!isMobileRuntime || selectedArtifacts.every((artifact) =>
        !androidAudioExportUnavailableReason(artifact)
      )) &&
      selectedDestinationCapability?.available &&
      selectionAllowed &&
      (!selectedDocumentIds.length || relevantDocumentAvailabilitySettled) &&
      workspaceReady &&
      !projectEditLocked &&
      !activeExportJob,
  );

  function updateDraft(next: ExportWorkspaceState) {
    if (!workspaceReady) return;
    handleSetExportWorkspace(next);
  }

  function updateSelection(next: Set<string>) {
    const nextDocumentIds = isMobileRuntime && next.size ? [] : selectedDocumentIds;
    const previousCount = totalSelectedCount;
    const nextCount = next.size + nextDocumentIds.length;
    updateDraft({
      ...(draft ?? fallbackState!),
      selectedArtifactIds: [...next],
      selectedGeneratedDocumentIds: nextDocumentIds,
      destinationType: previousCount === 0 || (previousCount === 1) !== (nextCount === 1)
        ? nextCount <= 1 ? "single_file" : "folder"
        : destinationType,
      desktopDestinationTarget: previousCount === 0 || (previousCount === 1) !== (nextCount === 1)
        ? null
        : destinationTarget,
    });
  }

  function toggleGeneratedDocument(documentId: GeneratedExportDocumentId) {
    if (!draft || !availableGeneratedDocumentIds.has(documentId)) return;
    if (isMobileRuntime) {
      updateDraft({
        ...draft,
        selectedArtifactIds: [],
        selectedGeneratedDocumentIds: [documentId],
        destinationType: "single_file",
        desktopDestinationTarget: null,
      });
      return;
    }
    const next = new Set(selectedDocumentIds);
    if (next.has(documentId)) next.delete(documentId);
    else next.add(documentId);
    const ordered = (["lyrics", "lyrics_with_chords"] as GeneratedExportDocumentId[])
      .filter((id) => next.has(id));
    const nextCount = selectedIds.size + ordered.length;
    updateDraft({
      ...draft,
      selectedGeneratedDocumentIds: ordered,
      destinationType: (totalSelectedCount === 1) !== (nextCount === 1)
        ? nextCount <= 1 ? "single_file" : "folder"
        : destinationType,
      desktopDestinationTarget: (totalSelectedCount === 1) !== (nextCount === 1)
        ? null
        : destinationTarget,
    });
  }

  function selectPreset(nextPreset: Exclude<ExportPreset, "custom">) {
    if (!audioSet || (isMobileRuntime && nextPreset !== "track")) return;
    updateSelection(
      selectedIdsForPreset(nextPreset, audioSet.artifact.id, audioSet.stems.map((stem) => stem.id)),
    );
  }

  function toggleArtifact(artifactId: string) {
    if (isMobileRuntime) {
      updateSelection(new Set([artifactId]));
      return;
    }
    const next = new Set(selectedIds);
    if (next.has(artifactId)) next.delete(artifactId);
    else next.add(artifactId);
    updateSelection(next);
  }

  function selectAudioSet(nextAudioSetId: string) {
    const nextAudioSet = audioSets.find((audioSet) => audioSet.artifact.id === nextAudioSetId);
    if (!nextAudioSet || !draft || !capabilities) return;
    const nextDefault = defaultExportWorkspaceState({
      audioSets: [nextAudioSet],
      selectedPrimaryArtifactId: nextAudioSetId,
      filenameBase: draft.filenameBase,
      capabilities,
      defaultOutputFormat,
    });
    if (!nextDefault) return;
    updateDraft({
      ...draft,
      audioSetId: nextAudioSetId,
      selectedArtifactIds: isMobileRuntime && selectedDocumentIds.length
        ? []
        : nextDefault.selectedArtifactIds,
      destinationType: (isMobileRuntime && selectedDocumentIds.length
        ? selectedDocumentIds.length
        : nextDefault.selectedArtifactIds.length + selectedDocumentIds.length) === 1
        ? "single_file"
        : "folder",
      desktopDestinationTarget: null,
    });
  }

  function resetWorkspace() {
    if (!workspaceReady || !healthSettled || !capabilities || activeExportJob) return;
    const next = defaultExportWorkspaceState({
      audioSets,
      selectedPrimaryArtifactId,
      filenameBase: projectQuery.data?.display_name ?? "TuneForge Export",
      capabilities,
      defaultOutputFormat,
    });
    handleSetExportWorkspace(next ?? (fallbackState ? {
      ...fallbackState,
      selectedGeneratedDocumentIds: [],
      filenameBase: projectQuery.data?.display_name ?? "TuneForge Export",
      desktopDestinationTarget: null,
    } : null));
  }

  async function chooseDestination(type = destinationType) {
    if (capabilities?.platform !== "desktop") return null;
    let target: string | string[] | null;
    if (type === "folder") {
      target = await open({ directory: true, multiple: false });
    } else {
      const defaultName =
        type === "zip"
          ? selectedDocumentIds.length
            ? `${filenameBase.trim()} - Export.zip`
            : `${filenameBase.trim()} - ${audioSet ? exportContextName(audioSet) : "Export"}.zip`
          : outputNames[0];
      target = await save({
        defaultPath: defaultName,
        filters:
          type === "zip"
            ? [{ name: "ZIP Archive", extensions: ["zip"] }]
            : selectedIds.size
              ? [{ name: FORMAT_LABELS[outputFormat], extensions: [outputFormat] }]
              : [{ name: "Plain Text", extensions: ["txt"] }],
      });
    }
    const normalized = Array.isArray(target) ? target[0] : target;
    if (
      !normalized ||
      !isDesktopDestinationTarget(normalized) ||
      (selectedIds.size > 0 && !selectedFormatCapability?.available) ||
      !selectedDestinationCapability?.available
    ) return null;
    if (draft) updateDraft({ ...draft, desktopDestinationTarget: normalized });
    return normalized;
  }

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!projectQuery.data) return null;
      const chordDocumentSelected = selectedDocumentIds.includes("lyrics_with_chords");
      if (chordDocumentSelected && !audioSet) return null;
      if (isMobileRuntime) {
        if (totalSelectedCount !== 1 || (!audioSet && selectedDocumentIds.length)) return null;
        const request: ExportRequest = chordDocumentSelected
          ? {
              artifact_ids: [],
              generated_document_ids: ["lyrics_with_chords"],
              output_format: "wav",
              filename_base: filenameBase.trim(),
              document_audio_set_artifact_id: audioSet!.artifact.id,
              document_chord_display_mode: enharmonicDisplayMode,
            }
          : {
              artifact_ids: selectedArtifacts.map((artifact) => artifact.id),
              ...(selectedDocumentIds.includes("lyrics")
                ? { generated_document_ids: ["lyrics"] as const }
                : {}),
              output_format: "wav",
              filename_base: filenameBase.trim(),
              ...(selectedDocumentIds.length && audioSet ? {
                document_audio_set_artifact_id: audioSet.artifact.id,
                document_chord_display_mode: enharmonicDisplayMode,
              } : {}),
            };
        return api.createExport(projectQuery.data.id, request);
      }
      const target = destinationTarget ?? (await chooseDestination());
      if (!target) return null;
      const commonRequest = {
        artifact_ids: selectedArtifacts.map((artifact) => artifact.id),
        output_format: outputFormat,
        filename_base: filenameBase.trim(),
        destination: { type: destinationType, target, overwrite: false },
      };
      const request: ExportRequest = chordDocumentSelected && audioSet
        ? {
            ...commonRequest,
            generated_document_ids: selectedDocumentIds.length === 1
              ? ["lyrics_with_chords"]
              : selectedDocumentIds[0] === "lyrics"
                ? ["lyrics", "lyrics_with_chords"]
                : ["lyrics_with_chords", "lyrics"],
            document_audio_set_artifact_id: audioSet.artifact.id,
            document_chord_display_mode: enharmonicDisplayMode,
          }
        : {
            ...commonRequest,
            ...(selectedDocumentIds.length ? { generated_document_ids: ["lyrics"] as const } : {}),
            ...(selectedDocumentIds.length && audioSet ? {
              document_audio_set_artifact_id: audioSet.artifact.id,
              document_chord_display_mode: enharmonicDisplayMode,
            } : {}),
          };
      try {
        return await api.createExport(projectQuery.data.id, request);
      } catch (error) {
        if (!isExportDestinationExistsError(error)) throw error;
        const overwrite = await confirm("One or more export destinations already exist. Replace them?", {
          title: "Replace existing export?",
          kind: "warning",
          okLabel: "Replace",
          cancelLabel: "Cancel",
        });
        if (!overwrite) return null;
        return api.createExport(projectQuery.data.id, {
          ...request,
          destination: { ...request.destination!, overwrite: true },
        });
      }
    },
    onSuccess: async (response) => {
      if (!response) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectQuery.data?.id] }),
      ]);
    },
  });

  useActiveJobPolling(projectId, undefined, {
    forceActive: isMobileRuntime && exportMutation.isPending,
    intervalMs: 250,
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelJob(activeExportJob?.id ?? ""),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  function retryFailed() {
    if (!retryAudioSet && !failedDocumentIds.length) return;
    const failed = failedArtifactIds.filter(
      (id) => id === retryAudioSet?.artifact.id || retryAudioSet?.stems.some((stem) => stem.id === id),
    );
    if (!draft) return;
    updateDraft({
      ...draft,
      audioSetId: retryAudioSet?.artifact.id ?? draft.audioSetId,
      selectedArtifactIds: failed,
      selectedGeneratedDocumentIds: failedDocumentIds,
      destinationType: failed.length + failedDocumentIds.length === 1 ? "single_file" : "folder",
      desktopDestinationTarget: null,
    });
  }

  return {
    audioSet,
    audioSetId,
    audioSets,
    activeExportJob,
    audioOutputNames,
    canExport,
    cancelMutation,
    capabilities,
    capabilitiesQuery,
    capabilitiesError: capabilitiesQuery.isError
      ? "Export options couldn’t load. Retry to continue."
      : null,
    chooseDestination,
    destinationTarget,
    destinationType,
    exportMutation,
    filenameBase,
    goToStudio: () => handleSelectProjectPanel("studio"),
    isMobileRuntime,
    latestExportJob,
    maxArtifactCount,
    outputFormat,
    outputNames,
    partialExportJob,
    preset,
    projectEditLocked,
    retryFailed,
    retryCapabilities: () => void capabilitiesQuery.refetch(),
    resetWorkspace,
    resetUnavailableReason: activeExportJob
      ? "Export options can’t be reset while an export is in progress."
      : capabilitiesQuery.isError
        ? "Export options couldn’t load. Retry to continue."
        : !workspaceReady || !healthSettled
        ? "Export options are still loading."
        : null,
    retryUnavailableReason: partialExportJob && !retryAudioSet && !failedDocumentIds.length
      ? "Failed export items are no longer available in this project."
      : null,
    selectedDestinationCapability,
    selectedFormatCapability,
    selectedIds,
    selectedDocumentIdSet,
    selectedDocumentIds,
    selectedArtifacts,
    selectionAllowed,
    totalSelectedCount,
    selectPreset,
    setAudioSetId: selectAudioSet,
    setDestinationType: (nextDestinationType: DestinationType) => {
      if (draft) updateDraft({ ...draft, destinationType: nextDestinationType, desktopDestinationTarget: null });
    },
    setFilenameBase: (nextFilenameBase: string) => {
      if (draft) updateDraft({ ...draft, filenameBase: nextFilenameBase });
    },
    setOutputFormat: (nextOutputFormat: ExportFormat) => {
      if (draft) updateDraft({ ...draft, outputFormat: nextOutputFormat, desktopDestinationTarget: null });
    },
    toggleArtifact,
    toggleGeneratedDocument,
    documentAvailability: {
      lyrics: availableGeneratedDocumentIds.has("lyrics"),
      lyrics_with_chords: availableGeneratedDocumentIds.has("lyrics_with_chords"),
    },
    documentChordContext,
    documentOutputNames,
    androidAudioUnavailableReason: androidAudioExportUnavailableReason,
    selectedDeliverableLabel: selectedArtifacts[0]
      ? (audioSet && selectedArtifacts[0].id === audioSet.artifact.id
          ? audioSet.label
          : selectedArtifacts[0].type.replace(/_stem$/, "").replaceAll("_", " "))
      : selectedDocumentIds[0] === "lyrics_with_chords"
        ? "Lyrics + chords"
        : selectedDocumentIds[0] === "lyrics"
          ? "Lyrics"
          : null,
    workspaceReady,
  };
}
