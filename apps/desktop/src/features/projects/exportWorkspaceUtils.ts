import type { ArtifactSchema, ExportCapabilities, GeneratedExportDocumentId } from "../../lib/api";
import type { ExportWorkspaceState } from "./projectPlaybackState";
import { artifactLabel, isStemArtifact } from "./projectViewUtils";

export type ExportAudioSet = {
  artifact: ArtifactSchema;
  label: string;
  stems: ArtifactSchema[];
};

export type ExportPreset = "track" | "stems" | "track-and-stems" | "custom";
export type ExportFormat = NonNullable<ExportWorkspaceState["outputFormat"]>;
export type ExportDestinationType = ExportWorkspaceState["destinationType"];

const EXPORT_FORMATS: ExportFormat[] = ["wav", "flac", "mp3", "m4a"];

function knownExportFormat(value: string | null | undefined): ExportFormat | null {
  return EXPORT_FORMATS.find((format) => format === value) ?? null;
}

function preferredOutputFormat(
  defaultOutputFormat: string | null | undefined,
  availableFormats: Set<string>,
) {
  const knownDefault = knownExportFormat(defaultOutputFormat);
  if (knownDefault && availableFormats.has(knownDefault)) return knownDefault;
  return EXPORT_FORMATS.find((format) => availableFormats.has(format)) ?? knownDefault ?? "m4a";
}

function stateEquals(left: ExportWorkspaceState, right: ExportWorkspaceState) {
  return left.audioSetId === right.audioSetId &&
    left.outputFormat === right.outputFormat &&
    left.filenameBase === right.filenameBase &&
    left.destinationType === right.destinationType &&
    left.desktopDestinationTarget === right.desktopDestinationTarget &&
    left.selectedArtifactIds.length === right.selectedArtifactIds.length &&
    left.selectedArtifactIds.every((id, index) => id === right.selectedArtifactIds[index]) &&
    left.selectedGeneratedDocumentIds.length === right.selectedGeneratedDocumentIds.length &&
    left.selectedGeneratedDocumentIds.every((id, index) =>
      id === right.selectedGeneratedDocumentIds[index]
    );
}

export function isDesktopDestinationTarget(value: string | null) {
  if (!value) return false;
  const target = value.trim();
  return Boolean(target) &&
    !target.includes("\0") &&
    !/^(?:file|content):/i.test(target) &&
    (/^\//.test(target) || /^[a-z]:[\\/]/i.test(target) || /^\\\\[^\\]+\\[^\\]+/.test(target));
}

function audioSetForArtifactId(audioSets: ExportAudioSet[], artifactId: string) {
  return audioSets.find((audioSet) =>
    audioSet.artifact.id === artifactId || audioSet.stems.some((stem) => stem.id === artifactId),
  ) ?? null;
}

function availableOptionIds(
  capabilities: ExportCapabilities,
  kind: "formats" | "destinations",
) {
  return new Set(capabilities[kind].filter((option) => option.available).map((option) => option.id));
}

export function androidAudioExportUnavailableReason(artifact: ArtifactSchema) {
  if (artifact.format.toLowerCase() !== "wav") {
    return "Android can export only locally stored WAV audio without re-encoding.";
  }
  if (!artifact.path.trim() || /^(?:content|https?):/i.test(artifact.path)) {
    return "This WAV is not available as a locally readable project file.";
  }
  return null;
}

function capCombinedSelection(
  artifactIds: string[],
  documentIds: GeneratedExportDocumentId[],
  maxCount: number | null | undefined,
) {
  if (maxCount === null || maxCount === undefined) {
    return { artifactIds, documentIds };
  }
  const normalizedMax = Math.max(0, maxCount);
  const cappedArtifacts = artifactIds.slice(0, normalizedMax);
  const cappedDocuments = documentIds.slice(0, Math.max(0, normalizedMax - cappedArtifacts.length));
  return { artifactIds: cappedArtifacts, documentIds: cappedDocuments };
}

function compatibleDestinationTypes(itemCount: number): ExportDestinationType[] {
  return itemCount <= 1 ? ["single_file"] : ["folder", "zip"];
}

function preferredDestinationType(
  artifactCount: number,
  availableDestinations: Set<string>,
) {
  const compatibleDestinations = compatibleDestinationTypes(artifactCount);
  return compatibleDestinations.find((type) => availableDestinations.has(type)) ?? compatibleDestinations[0];
}

export function defaultExportWorkspaceState({
  audioSets,
  selectedPrimaryArtifactId,
  filenameBase,
  capabilities,
  defaultOutputFormat,
}: {
  audioSets: ExportAudioSet[];
  selectedPrimaryArtifactId: string | null;
  filenameBase: string;
  capabilities: ExportCapabilities;
  defaultOutputFormat: string | null | undefined;
}): ExportWorkspaceState | null {
  const audioSet = audioSets.find((set) => set.artifact.id === selectedPrimaryArtifactId) ?? audioSets[0];
  if (!audioSet) return null;
  const availableFormats = availableOptionIds(capabilities, "formats");
  const outputFormat = preferredOutputFormat(defaultOutputFormat, availableFormats);
  const artifactOrder = [audioSet.artifact, ...audioSet.stems]
    .filter((artifact) =>
      capabilities.platform !== "android" || !androidAudioExportUnavailableReason(artifact)
    )
    .map((artifact) => artifact.id);
  const maxArtifactCount = capabilities.max_artifact_count;
  const selectedArtifactIds = maxArtifactCount === null || maxArtifactCount === undefined
    ? artifactOrder
    : artifactOrder.slice(0, Math.max(1, maxArtifactCount));
  const availableDestinations = availableOptionIds(capabilities, "destinations");
  return {
    audioSetId: audioSet.artifact.id,
    selectedArtifactIds,
    selectedGeneratedDocumentIds: [],
    outputFormat,
    filenameBase,
    destinationType: preferredDestinationType(selectedArtifactIds.length, availableDestinations),
    desktopDestinationTarget: null,
  };
}

export function reconcileExportWorkspaceState({
  storedState,
  audioSets,
  selectedPrimaryArtifactId,
  filenameBase,
  capabilities,
  defaultOutputFormat,
  availableGeneratedDocumentIds,
}: {
  storedState: ExportWorkspaceState | null;
  audioSets: ExportAudioSet[];
  selectedPrimaryArtifactId: string | null;
  filenameBase: string;
  capabilities: ExportCapabilities;
  defaultOutputFormat: string | null | undefined;
  availableGeneratedDocumentIds: Set<GeneratedExportDocumentId>;
}): { state: ExportWorkspaceState | null; recovery: boolean } {
  const availableFormats = availableOptionIds(capabilities, "formats");
  const availableDestinations = availableOptionIds(capabilities, "destinations");
  if (!audioSets.length) {
    let selectedGeneratedDocumentIds = (storedState?.selectedGeneratedDocumentIds ?? [])
      .filter((id) => availableGeneratedDocumentIds.has(id));
    selectedGeneratedDocumentIds = capCombinedSelection(
      [],
      selectedGeneratedDocumentIds,
      capabilities.max_artifact_count,
    ).documentIds;
    const outputFormat = storedState?.outputFormat && availableFormats.has(storedState.outputFormat)
      ? storedState.outputFormat
      : preferredOutputFormat(defaultOutputFormat, availableFormats);
    const compatibleDestinations = compatibleDestinationTypes(selectedGeneratedDocumentIds.length);
    const destinationType = storedState &&
      compatibleDestinations.includes(storedState.destinationType) &&
      availableDestinations.has(storedState.destinationType)
      ? storedState.destinationType
      : preferredDestinationType(selectedGeneratedDocumentIds.length, availableDestinations);
    const candidate: ExportWorkspaceState = {
      audioSetId: null,
      selectedArtifactIds: [],
      selectedGeneratedDocumentIds,
      outputFormat,
      filenameBase: storedState?.filenameBase || filenameBase,
      destinationType,
      desktopDestinationTarget: storedState?.desktopDestinationTarget ?? null,
    };
    const targetIsCompatible = capabilities.platform === "desktop" &&
      availableDestinations.has(destinationType) &&
      isDesktopDestinationTarget(candidate.desktopDestinationTarget);
    const state = {
      ...candidate,
      desktopDestinationTarget: !storedState || !stateEquals(storedState, candidate) || !targetIsCompatible
        ? null
        : candidate.desktopDestinationTarget?.trim() ?? null,
    };
    return { state, recovery: storedState !== null && !stateEquals(storedState, state) };
  }
  if (!storedState) {
    return {
      state: defaultExportWorkspaceState({
        audioSets,
        selectedPrimaryArtifactId,
        filenameBase,
        capabilities,
        defaultOutputFormat,
      }),
      recovery: false,
    };
  }

  const savedSet = audioSets.find((set) => set.artifact.id === storedState.audioSetId) ?? null;
  const survivingSets = Array.from(new Set(
    storedState.selectedArtifactIds
      .map((id) => audioSetForArtifactId(audioSets, id))
      .filter((audioSet): audioSet is ExportAudioSet => audioSet !== null),
  ));
  const audioSet = savedSet ??
    (survivingSets.length === 1 ? survivingSets[0] : null) ??
    audioSets.find((set) => set.artifact.id === selectedPrimaryArtifactId) ??
    audioSets[0];
  const artifactOrder = [audioSet.artifact, ...audioSet.stems]
    .filter((artifact) =>
      capabilities.platform !== "android" || !androidAudioExportUnavailableReason(artifact)
    )
    .map((artifact) => artifact.id);
  const savedIds = new Set(storedState.selectedArtifactIds);
  let selectedArtifactIds = artifactOrder.filter((id) => savedIds.has(id));
  const maxArtifactCount = capabilities.max_artifact_count;
  if (maxArtifactCount !== null && maxArtifactCount !== undefined) {
    selectedArtifactIds = selectedArtifactIds.slice(0, Math.max(0, maxArtifactCount));
  }
  let selectedGeneratedDocumentIds = (storedState.selectedGeneratedDocumentIds ?? [])
    .filter((id) => availableGeneratedDocumentIds.has(id));
  if (!savedSet && survivingSets.length === 0 && !selectedArtifactIds.length && !selectedGeneratedDocumentIds.length) {
    selectedArtifactIds = [audioSet.artifact.id];
  }
  const outputFormat = storedState.outputFormat && availableFormats.has(storedState.outputFormat)
    ? storedState.outputFormat
    : preferredOutputFormat(defaultOutputFormat, availableFormats);
  const cappedSelection = capCombinedSelection(
    selectedArtifactIds,
    selectedGeneratedDocumentIds,
    maxArtifactCount,
  );
  selectedArtifactIds = cappedSelection.artifactIds;
  selectedGeneratedDocumentIds = cappedSelection.documentIds;
  const totalCount = selectedArtifactIds.length + selectedGeneratedDocumentIds.length;
  const compatibleDestinations = compatibleDestinationTypes(totalCount);
  const destinationType = compatibleDestinations.includes(storedState.destinationType) &&
    availableDestinations.has(storedState.destinationType)
    ? storedState.destinationType
    : preferredDestinationType(totalCount, availableDestinations);
  const adjusted = !stateEquals(storedState, {
    audioSetId: audioSet.artifact.id,
    selectedArtifactIds,
    selectedGeneratedDocumentIds,
    outputFormat,
    filenameBase: storedState.filenameBase,
    destinationType,
    desktopDestinationTarget: storedState.desktopDestinationTarget,
  });
  const targetIsCompatible = capabilities.platform === "desktop" &&
    (selectedArtifactIds.length === 0 || availableFormats.has(outputFormat)) &&
    availableDestinations.has(destinationType) &&
    isDesktopDestinationTarget(storedState.desktopDestinationTarget);
  const state: ExportWorkspaceState = {
    audioSetId: audioSet.artifact.id,
    selectedArtifactIds,
    selectedGeneratedDocumentIds,
    outputFormat,
    filenameBase: storedState.filenameBase,
    destinationType,
    desktopDestinationTarget: adjusted || !targetIsCompatible
      ? null
      : storedState.desktopDestinationTarget?.trim() ?? null,
  };
  return { state, recovery: !stateEquals(storedState, state) };
}

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

export function generatedDocumentOutputNames(
  selectedIds: GeneratedExportDocumentId[],
  filenameBase: string,
) {
  const base = filenameBase.trim() || "TuneForge Export";
  return selectedIds.map((id) =>
    `${base} - ${id === "lyrics" ? "Lyrics" : "Lyrics and Chords"}.txt`
  );
}
