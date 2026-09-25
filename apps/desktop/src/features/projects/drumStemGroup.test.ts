import { describe, expect, it } from "vitest";
import type { ArtifactSchema } from "../../lib/api";
import {
  activeStemArtifacts,
  describeDrumGroup,
  drumParentKey,
  resolveActiveStemControls,
  stemControlKey,
} from "./drumStemGroup";
import { buildExportAudioSets } from "./exportWorkspaceUtils";

const sha = "a".repeat(64);
const parts = ["kick", "snare", "cymbals", "toms"] as const;

function artifact(id: string, type: string, metadata: Record<string, unknown> = {}): ArtifactSchema {
  return {
    id,
    project_id: "project",
    type,
    format: "wav",
    path: `/tmp/${id}.wav`,
    size_bytes: 1024,
    file_integrity: "verified",
    generated_by: "demucs",
    can_delete: true,
    can_regenerate: true,
    metadata,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function artifacts(excludedParts: string[] = []): ArtifactSchema[] {
  return [
    artifact("bass", "bass_stem", { source_artifact_id: "source" }),
    artifact("drums", "drums_stem", {
      source_artifact_id: "source",
      drum_substems: {
        generation_id: "generation",
        parent_sha256: sha,
        expected_parts: parts,
        excluded_parts: excludedParts,
        child_artifact_ids: Object.fromEntries(parts.map((part) => [part, part])),
      },
    }),
    ...parts.filter((part) => !excludedParts.includes(part)).map((part) => artifact(
      part, `${part}_drum_substem`, {
        source_artifact_id: "source",
        parent_artifact_id: "drums",
        generation_id: "generation",
        parent_sha256: sha,
      },
    )),
  ];
}

describe("refined drum group", () => {
  it("plays the original or complete included children, never both", () => {
    const ready = artifacts();
    expect(activeStemArtifacts(ready, "original").map((item) => item.id)).toEqual(["bass", "drums"]);
    expect(activeStemArtifacts(ready, "split").map((item) => item.id)).toEqual(["bass", ...parts]);

    const omitted = artifacts(["toms"]);
    expect(describeDrumGroup(omitted)?.splitAvailable).toBe(true);
    expect(activeStemArtifacts(omitted, "split").map((item) => item.id)).toEqual([
      "bass", "kick", "snare", "cymbals",
    ]);
  });

  it("falls back to Original for an unexpectedly missing or corrupt child", () => {
    for (const integrity of ["missing", "corrupt"] as const) {
      const listed = artifacts();
      listed[2] = { ...listed[2], file_integrity: integrity };
      expect(describeDrumGroup(listed)?.recoveryNeeded).toBe(true);
      expect(describeDrumGroup(listed)?.splitAvailable).toBe(false);
      expect(activeStemArtifacts(listed, "split").map((item) => item.id)).toEqual(["bass", "drums"]);
    }
  });

  it("inherits group attenuation and mute while child solo isolates one part", () => {
    const listed = artifacts();
    const group = describeDrumGroup(listed)!;
    const stored = {
      [stemControlKey(group.parent)]: { muted: true, solo: true, gain: 0.5 },
      [stemControlKey(group.includedChildren[0])]: { muted: false, solo: true, gain: 0.4 },
    };
    const split = resolveActiveStemControls(activeStemArtifacts(listed, "split"), group, stored);
    expect(split.kick).toMatchObject({ gain: 0.2, muted: true, groupMuted: true, solo: true });
    expect(split.snare).toMatchObject({ gain: 0.5, muted: true, solo: false });

    const original = resolveActiveStemControls(activeStemArtifacts(listed, "original"), group, stored);
    expect(original.drums.solo).toBe(true);
    expect(original.drums.gain).toBe(0.5);
  });

  it("defaults an unselected rebuilt source to Original when its saved parent key is stale", () => {
    const listed = [artifact("source", "source_audio"), ...artifacts()];
    const savedKey = drumParentKey(describeDrumGroup(listed)!);
    expect(buildExportAudioSets(listed, { source: "split" }, { source: savedKey })[0].defaultStemIds)
      .toEqual(["bass", ...parts]);

    const rebuilt = listed.map((item) => {
      if (item.id === "drums") return { ...item, id: "new-drums" };
      if (parts.some((part) => part === item.id)) {
        return { ...item, metadata: { ...item.metadata, parent_artifact_id: "new-drums" } };
      }
      return item;
    });
    expect(describeDrumGroup(rebuilt)?.splitAvailable).toBe(true);
    expect(buildExportAudioSets(rebuilt, { source: "split" }, { source: savedKey })[0].defaultStemIds)
      .toEqual(["bass", "new-drums"]);
  });
});
