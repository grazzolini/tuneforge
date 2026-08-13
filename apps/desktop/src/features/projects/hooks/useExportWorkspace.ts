import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { ApiError, api, type ExportRequest } from "../../../lib/api";
import { useProjectViewModelContext } from "../components/useProjectViewModelContext";
import {
  buildExportAudioSets,
  exportContextName,
  exportOutputNames,
  exportPresetForSelection,
  type ExportPreset,
} from "../exportWorkspaceUtils";

type DestinationType = "single_file" | "folder" | "zip";
type ExportFormat = "wav" | "flac" | "mp3" | "m4a";

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
    handleSelectProjectPanel,
    isMobileRuntime,
    projectEditLocked,
    projectQuery,
    selectedPrimaryArtifactId,
    visibleJobs,
  } = useProjectViewModelContext();
  const queryClient = useQueryClient();
  const audioSets = useMemo(() => buildExportAudioSets(displayArtifacts), [displayArtifacts]);
  const defaultAudioSetId =
    audioSets.find((audioSet) => audioSet.artifact.id === selectedPrimaryArtifactId)?.artifact.id ??
    audioSets[0]?.artifact.id ??
    "";
  const [audioSetId, setAudioSetId] = useState(defaultAudioSetId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [outputFormat, setOutputFormat] = useState<ExportFormat>("m4a");
  const [filenameBase, setFilenameBase] = useState(projectQuery.data?.display_name ?? "TuneForge Export");
  const [destinationType, setDestinationType] = useState<DestinationType>("single_file");
  const [destinationTarget, setDestinationTarget] = useState<string | null>(null);
  const skipAudioSetResetRef = useRef(false);
  const audioSet = audioSets.find((candidate) => candidate.artifact.id === audioSetId) ?? audioSets[0] ?? null;

  useEffect(() => {
    if (!audioSetId && defaultAudioSetId) setAudioSetId(defaultAudioSetId);
  }, [audioSetId, defaultAudioSetId]);

  useEffect(() => {
    if (!audioSet) return;
    if (skipAudioSetResetRef.current) {
      skipAudioSetResetRef.current = false;
      return;
    }
    setSelectedIds(new Set([audioSet.artifact.id]));
    setDestinationType("single_file");
    setDestinationTarget(null);
  }, [audioSet]);

  const capabilitiesQuery = useQuery({
    queryKey: ["export-capabilities"],
    queryFn: () => api.getExportCapabilities(),
    staleTime: Infinity,
  });
  const capabilities = capabilitiesQuery.data?.capabilities ?? null;
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
      !projectEditLocked &&
      !activeExportJob,
  );

  function updateSelection(next: Set<string>) {
    const wasSingle = selectedIds.size === 1;
    const isSingle = next.size === 1;
    setSelectedIds(next);
    if (next.size === 0 || wasSingle !== isSingle) {
      setDestinationTarget(null);
      setDestinationType(isSingle ? "single_file" : "folder");
    }
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

  async function chooseDestination(type = destinationType) {
    if (!audioSet) return null;
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
    if (!normalized) return null;
    setDestinationTarget(normalized);
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
        destination: {
          type: destinationType,
          target,
          // Android's native save picker owns the collision confirmation. A returned URI
          // therefore represents explicit approval to replace that picker-owned target.
          overwrite: isMobileRuntime,
        },
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
    if (retryAudioSet.artifact.id !== audioSet?.artifact.id) {
      skipAudioSetResetRef.current = true;
      setAudioSetId(retryAudioSet.artifact.id);
    }
    setSelectedIds(new Set(failed));
    setDestinationTarget(null);
    setDestinationType(failed.length === 1 ? "single_file" : "folder");
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
    retryUnavailableReason: partialExportJob && !retryAudioSet
      ? "Failed export items are no longer available in this project."
      : null,
    selectedDestinationCapability,
    selectedFormatCapability,
    selectedIds,
    selectedArtifacts,
    selectionAllowed,
    selectPreset,
    setAudioSetId,
    setDestinationTarget,
    setDestinationType,
    setFilenameBase,
    setOutputFormat,
    toggleArtifact,
  };
}
