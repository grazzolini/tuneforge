import type { ArtifactSchema } from "../../lib/api";
import type { StemControlState } from "./projectPlaybackState";

export type DrumMode = "original" | "split";
export const DRUM_PARTS = ["kick", "snare", "cymbals", "toms"] as const;
type DrumPart = typeof DRUM_PARTS[number];
const PART_TYPES = new Map<DrumPart, string>(DRUM_PARTS.map((part) => [part, `${part}_drum_substem`]));

export type StemGroupDescriptor = {
  parent: ArtifactSchema;
  children: ArtifactSchema[];
  includedChildren: ArtifactSchema[];
  excludedParts: DrumPart[];
  splitAvailable: boolean;
  recoveryNeeded: boolean;
};

export function drumParentKey(group: StemGroupDescriptor): string {
  const manifest = group.parent.metadata?.drum_substems;
  const parentSha = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).parent_sha256 : null;
  return `${group.parent.id}:${typeof parentSha === "string" ? parentSha : ""}`;
}

function isPart(value: unknown): value is DrumPart {
  return DRUM_PARTS.some((part) => part === value);
}

export function isDrumSubstem(artifact: ArtifactSchema | null | undefined): boolean {
  return Boolean(artifact && DRUM_PARTS.some((part) => artifact.type === PART_TYPES.get(part)));
}

export function describeDrumGroup(artifacts: ArtifactSchema[]): StemGroupDescriptor | null {
  const parent = artifacts.find((artifact) => artifact.type === "drums_stem");
  if (!parent) return null;
  const manifest = parent.metadata?.drum_substems;
  const record = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? manifest as Record<string, unknown>
    : null;
  const excludedParts = Array.isArray(record?.excluded_parts)
    ? record.excluded_parts.filter(isPart)
    : [];
  const generationId = record?.generation_id;
  const childIds = record?.child_artifact_ids && typeof record.child_artifact_ids === "object"
    ? record.child_artifact_ids as Record<string, unknown>
    : {};
  const children = artifacts.filter((artifact) =>
    isDrumSubstem(artifact) && artifact.metadata?.parent_artifact_id === parent.id,
  );
  const includedChildren = DRUM_PARTS.filter((part) => !excludedParts.includes(part)).flatMap((part) =>
    children.filter((artifact) =>
      artifact.type === PART_TYPES.get(part)
      && artifact.id === childIds[part]
      && artifact.metadata?.generation_id === generationId
      && artifact.metadata?.parent_sha256 === record?.parent_sha256
      && artifact.file_integrity === "verified",
    ),
  );
  const expectedCount = DRUM_PARTS.length - excludedParts.length;
  const expectedParts = Array.isArray(record?.expected_parts) ? record.expected_parts : [];
  const hasManifest = Boolean(record && typeof record.parent_sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(record.parent_sha256)
    && parent.file_integrity === "verified"
    && expectedParts.length === DRUM_PARTS.length
    && DRUM_PARTS.every((part) => expectedParts.includes(part)));
  return {
    parent,
    children,
    includedChildren,
    excludedParts,
    splitAvailable: hasManifest && expectedCount > 0 && includedChildren.length === expectedCount,
    recoveryNeeded: Boolean(record && expectedCount > 0 &&
      (!hasManifest || includedChildren.length !== expectedCount)),
  };
}

export function activeStemArtifacts(artifacts: ArtifactSchema[], mode: DrumMode): ArtifactSchema[] {
  const group = describeDrumGroup(artifacts);
  if (!group) return artifacts.filter((artifact) => !isDrumSubstem(artifact));
  const split = mode === "split" && group.splitAvailable;
  return artifacts.filter((artifact) => {
    if (artifact.id === group.parent.id) return !split;
    if (isDrumSubstem(artifact)) return split && group.includedChildren.some((child) => child.id === artifact.id);
    return true;
  });
}

export function stemControlKey(artifact: ArtifactSchema): string {
  const source = artifact.metadata?.source_artifact_id;
  const stableSource = typeof source === "string" ? source : artifact.id;
  return `${stableSource}:${artifact.type}`;
}

export function resolveActiveStemControls(
  activeArtifacts: ArtifactSchema[], group: StemGroupDescriptor | null,
  stored: Record<string, StemControlState>,
): Record<string, StemControlState> {
  const state = (artifact: ArtifactSchema) => stored[stemControlKey(artifact)] ?? stored[artifact.id]
    ?? { muted: false, solo: false, gain: 1 };
  const parent = group?.parent;
  const groupState = parent ? state(parent) : { muted: false, solo: false, gain: 1 };
  const childSolo = group?.children.some((child) => state(child).solo) ?? false;
  return Object.fromEntries(activeArtifacts.map((artifact) => {
    if (parent && artifact.id === parent.id) {
      return [artifact.id, { ...groupState, groupMuted: groupState.muted, solo: groupState.solo || childSolo }];
    }
    if (isDrumSubstem(artifact)) {
      const child = state(artifact);
      return [artifact.id, {
        muted: groupState.muted || child.muted,
        groupMuted: groupState.muted,
        solo: childSolo ? child.solo : groupState.solo,
        gain: (groupState.gain ?? 1) * (child.gain ?? 1),
      }];
    }
    return [artifact.id, state(artifact)];
  }));
}
