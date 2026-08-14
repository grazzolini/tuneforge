import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { ApiError, api, type ExportRequest } from "../../../lib/api";
import { useProjectViewModelContext } from "../components/useProjectViewModelContext";
import {
  buildExportAudioSets,
  exportContextName,
  exportOutputNames,
  exportPresetForSelection,
  isDesktopDestinationTarget,
  defaultExportWorkspaceState,
  reconcileExportWorkspaceState,
  type ExportDestinationType,
  type ExportFormat,
  type ExportPreset,
} from "../exportWorkspaceUtils";
import type { ExportWorkspaceState } from "../projectPlaybackState";

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
    artifactsQuery,
    exportWorkspace,
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
    if (!defaultAudioSetId) return null;
    return {
      audioSetId: defaultAudioSetId,
      selectedArtifactIds: [defaultAudioSetId],
      outputFormat: "m4a",
      filenameBase: isCurrentProjectHydrated
        ? projectQuery.data?.display_name ?? "TuneForge Export"
        : "TuneForge Export",
      destinationType: "single_file",
      desktopDestinationTarget: null,
    };
  }, [defaultAudioSetId, isCurrentProjectHydrated, projectQuery.data?.display_name]);
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
        })
      : null,
    [
      audioSets,
      capabilities,
      defaultOutputFormat,
      exportWorkspace,
      projectQuery.data?.display_name,
      selectedPrimaryArtifactId,
      workspaceReady,
    ],
  );
  const draft = reconciliation?.state ?? fallbackState;
  const audioSetId = draft?.audioSetId ?? "";
  const selectedIds = useMemo(() => new Set(draft?.selectedArtifactIds ?? []), [draft?.selectedArtifactIds]);
  const outputFormat = draft?.outputFormat ?? "m4a";
  const filenameBase = draft?.filenameBase ?? fallbackState?.filenameBase ?? "TuneForge Export";
  const destinationType = draft?.destinationType ?? "single_file";
  const destinationTarget = draft?.desktopDestinationTarget ?? null;
  const recoveredDrafts = useRef(new Set<string>());
  const audioSet = audioSets.find((candidate) => candidate.artifact.id === audioSetId) ?? audioSets[0] ?? null;

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
  const outputNames = audioSet
    ? exportOutputNames(audioSet, selectedIds, filenameBase, outputFormat)
    : [];
  const activeExportJob = visibleJobs.find(
    (job) => job.type === "export" && ["pending", "running"].includes(job.status),
  );
  const latestExportJob = visibleJobs.find((job) => job.type === "export") ?? null;
  const partialExportJob = latestExportJob?.export_result?.outcome === "partial" ? latestExportJob : null;
  const failedArtifactIds = partialExportJob?.export_result?.items
    .filter((item) => item.status === "failed")
    .map((item) => item.artifact_id) ?? [];
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
  const selectionAllowed = maxArtifactCount === null || selectedIds.size <= maxArtifactCount;
  const canExport = Boolean(
    audioSet &&
      selectedIds.size &&
      filenameBase.trim() &&
      selectedFormatCapability?.available &&
      selectedDestinationCapability?.available &&
      selectionAllowed &&
      workspaceReady &&
      !projectEditLocked &&
      !activeExportJob,
  );

  function updateDraft(next: ExportWorkspaceState) {
    if (!workspaceReady) return;
    handleSetExportWorkspace(next);
  }

  function updateSelection(next: Set<string>) {
    const wasSingle = selectedIds.size === 1;
    const isSingle = next.size === 1;
    updateDraft({
      ...(draft ?? fallbackState!),
      selectedArtifactIds: [...next],
      destinationType: next.size === 0 || wasSingle !== isSingle
        ? isSingle ? "single_file" : "folder"
        : destinationType,
      desktopDestinationTarget: next.size === 0 || wasSingle !== isSingle ? null : destinationTarget,
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
      selectedArtifactIds: nextDefault.selectedArtifactIds,
      destinationType: nextDefault.destinationType,
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
    handleSetExportWorkspace(next);
  }

  async function chooseDestination(type = destinationType) {
    if (!audioSet || capabilities?.platform !== "desktop") return null;
    let target: string | string[] | null;
    if (type === "folder") {
      target = await open({ directory: true, multiple: false });
    } else {
      const defaultName =
        type === "zip"
          ? `${filenameBase.trim()} - ${exportContextName(audioSet)}.zip`
          : outputNames[0];
      target = await save({
        defaultPath: defaultName,
        filters:
          type === "zip"
            ? [{ name: "ZIP Archive", extensions: ["zip"] }]
            : [{ name: FORMAT_LABELS[outputFormat], extensions: [outputFormat] }],
      });
    }
    const normalized = Array.isArray(target) ? target[0] : target;
    if (
      !normalized ||
      !isDesktopDestinationTarget(normalized) ||
      !selectedFormatCapability?.available ||
      !selectedDestinationCapability?.available
    ) return null;
    if (draft) updateDraft({ ...draft, desktopDestinationTarget: normalized });
    return normalized;
  }

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!audioSet || !projectQuery.data) return null;
      const target = destinationTarget ?? (await chooseDestination());
      if (!target) return null;
      const request: ExportRequest = {
        artifact_ids: selectedArtifacts.map((artifact) => artifact.id),
        output_format: outputFormat,
        filename_base: filenameBase.trim(),
        destination: { type: destinationType, target, overwrite: false },
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

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelJob(activeExportJob?.id ?? ""),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  function retryFailed() {
    if (!retryAudioSet) return;
    const failed = failedArtifactIds.filter(
      (id) => id === retryAudioSet.artifact.id || retryAudioSet.stems.some((stem) => stem.id === id),
    );
    if (!draft) return;
    updateDraft({
      ...draft,
      audioSetId: retryAudioSet.artifact.id,
      selectedArtifactIds: failed,
      destinationType: failed.length === 1 ? "single_file" : "folder",
      desktopDestinationTarget: null,
    });
  }

  return {
    audioSet,
    audioSetId,
    audioSets,
    activeExportJob,
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
    retryUnavailableReason: partialExportJob && !retryAudioSet
      ? "Failed export items are no longer available in this project."
      : null,
    selectedDestinationCapability,
    selectedFormatCapability,
    selectedIds,
    selectedArtifacts,
    selectionAllowed,
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
    workspaceReady,
  };
}
