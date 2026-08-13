import type { ArtifactSchema } from "../../lib/api";
import { artifactLabel, isStemArtifact } from "./projectViewUtils";

export type ExportAudioSet = {
  artifact: ArtifactSchema;
  label: string;
  stems: ArtifactSchema[];
};

export type ExportPreset = "track" | "stems" | "track-and-stems" | "custom";

export function buildExportAudioSets(artifacts: ArtifactSchema[]): ExportAudioSet[] {
  const source = artifacts.find((artifact) => artifact.type === "source_audio") ?? null;
  const mixes = artifacts
    .filter((artifact) => artifact.type === "preview_mix")
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
    );
  const stems = artifacts.filter(isStemArtifact);
  const primaryArtifacts = [source, ...mixes].filter(Boolean) as ArtifactSchema[];
  return primaryArtifacts.map((artifact) => ({
    artifact,
    label:
      artifact.type === "source_audio"
        ? "Source Track"
        : `Practice Mix ${mixes.findIndex((mix) => mix.id === artifact.id) + 1}`,
    stems: stems.filter((stem) => stem.metadata?.source_artifact_id === artifact.id),
  }));
}

export function exportPresetForSelection(audioSet: ExportAudioSet, selectedIds: Set<string>): ExportPreset {
  const stemIds = audioSet.stems.map((stem) => stem.id);
  if (selectedIds.size === 1 && selectedIds.has(audioSet.artifact.id)) {
    return "track";
  }
  if (stemIds.length && selectedIds.size === stemIds.length && stemIds.every((id) => selectedIds.has(id))) {
    return "stems";
  }
  if (
    stemIds.length &&
    selectedIds.size === stemIds.length + 1 &&
    selectedIds.has(audioSet.artifact.id) &&
    stemIds.every((id) => selectedIds.has(id))
  ) {
    return "track-and-stems";
  }
  return "custom";
}

export function exportContextName(audioSet: ExportAudioSet) {
  return audioSet.artifact.type === "source_audio" ? "Source" : audioSet.label;
}

export function exportOutputNames(
  audioSet: ExportAudioSet,
  selectedIds: Set<string>,
  filenameBase: string,
  outputFormat: string,
) {
  const context = exportContextName(audioSet);
  return [audioSet.artifact, ...audioSet.stems]
    .filter((artifact) => selectedIds.has(artifact.id))
    .map((artifact) => {
      const itemLabel = isStemArtifact(artifact) ? ` - ${artifactLabel(artifact)}` : "";
      return `${filenameBase.trim() || "TuneForge Export"} - ${context}${itemLabel}.${outputFormat}`;
    });
}
