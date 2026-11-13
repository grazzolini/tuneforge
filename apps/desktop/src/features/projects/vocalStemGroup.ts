import type { ArtifactSchema } from "../../lib/api";
import { stemControlKey, type DrumMode } from "./drumStemGroup";
import type { StemControlState } from "./projectPlaybackState";

export const VOCAL_PARTS = ["lead", "backing"] as const;
type VocalPart = typeof VOCAL_PARTS[number];
const PART_TYPES: Record<VocalPart, string> = { lead: "lead_vocal_substem", backing: "backing_vocal_substem" };

export function isVocalSubstem(artifact: ArtifactSchema | null | undefined): boolean {
  return Boolean(artifact && VOCAL_PARTS.some((part) => artifact.type === PART_TYPES[part]));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isVocalPart(value: unknown): value is VocalPart {
  return VOCAL_PARTS.some((part) => part === value);
}

function isFingerprint(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function describeVocalGroup(artifacts: ArtifactSchema[], source: ArtifactSchema | null) {
  const parent = artifacts.find((artifact) =>
    artifact.type === "vocal_stem" && artifact.metadata?.stem_model === "htdemucs_6s"
    && artifact.metadata?.mode === "six_stems" && artifact.metadata?.source_artifact_id === source?.id,
  );
  if (!parent || !source) return null;
  const group = asRecord(parent.metadata?.vocal_substems);
  const children = artifacts.filter((artifact) =>
    isVocalSubstem(artifact) && artifact.metadata?.parent_artifact_id === parent.id,
  );
  const expectedParts = group?.expected_parts;
  const excludedParts = group?.excluded_parts;
  const memberIds = asRecord(group?.child_artifact_ids);
  const memberHashes = asRecord(group?.child_sha256);
  const generation = typeof group?.generation_id === "string" && group.generation_id ? group.generation_id : null;
  const includedParts = VOCAL_PARTS.filter((part) => !Array.isArray(excludedParts) || !excludedParts.includes(part));
  const validManifest = generation && group?.source_artifact_id === source.id
    && isFingerprint(group.parent_sha256) && isFingerprint(group.source_sha256)
    && Array.isArray(expectedParts) && expectedParts.length === VOCAL_PARTS.length
    && VOCAL_PARTS.every((part) => expectedParts.includes(part))
    && Array.isArray(excludedParts) && excludedParts.every(isVocalPart)
    && new Set(excludedParts).size === excludedParts.length
    && memberIds && memberHashes && Object.keys(memberIds).length === includedParts.length
    && Object.keys(memberHashes).length === includedParts.length && parent.file_integrity === "verified";
  const includedChildren = validManifest ? includedParts.flatMap((part) => {
    const child = children.find((artifact) =>
      artifact.id === memberIds[part] && artifact.type === PART_TYPES[part] && isFingerprint(memberHashes[part])
      && artifact.format === group.format && artifact.metadata?.generation_id === generation
      && artifact.metadata?.vocal_part === part && artifact.metadata?.source_artifact_id === source.id
      && artifact.file_integrity === "verified",
    );
    return child ? [child] : [];
  }) : [];
  const complete = Boolean(validManifest && includedChildren.length === includedParts.length);
  return {
    parent,
    children,
    includedChildren: complete ? includedChildren : [],
    splitAvailable: complete && includedChildren.length > 0,
    recoveryNeeded: Boolean(group && !complete),
    splitIdentity: complete && includedChildren.length > 0 ? JSON.stringify([
      generation, group?.source_sha256, group?.parent_sha256,
      ...includedParts.map((part) => [memberIds?.[part], memberHashes?.[part]]),
    ]) : null,
    generationKey: generation ? `${parent.id}:${generation}` : null,
  };
}

export type VocalGroupDescriptor = NonNullable<ReturnType<typeof describeVocalGroup>>;

export function vocalPlaybackMode(group: VocalGroupDescriptor | null, splitGeneration: string | undefined): DrumMode {
  return group?.splitAvailable && group.generationKey === splitGeneration ? "split" : "original";
}

export function resolveVocalStemControls(
  group: VocalGroupDescriptor | null, mode: DrumMode, stored: Record<string, StemControlState>,
  effective: Record<string, StemControlState>,
): Record<string, StemControlState> {
  if (!group || mode !== "split") return effective;
  const parent = stored[stemControlKey(group.parent)] ?? stored[group.parent.id];
  const childSolo = group.includedChildren.some((child) => effective[child.id]?.solo);
  return {
    ...effective,
    ...Object.fromEntries(group.includedChildren.map((child) => {
      const state = effective[child.id];
      return [child.id, {
        muted: Boolean(parent?.muted || state?.muted),
        groupMuted: Boolean(parent?.muted),
        solo: childSolo ? Boolean(state?.solo) : Boolean(parent?.solo),
        gain: parent?.gain ?? 1,
      }];
    })),
  };
}

export function activeVocalStems(
  artifacts: ArtifactSchema[], group: VocalGroupDescriptor | null, mode: DrumMode,
): ArtifactSchema[] {
  const split = mode === "split" && group?.splitAvailable;
  return artifacts.filter((artifact) => {
    if (artifact.id === group?.parent.id) return !split;
    if (isVocalSubstem(artifact)) return split && group.includedChildren.some((child) => child.id === artifact.id);
    return true;
  });
}
