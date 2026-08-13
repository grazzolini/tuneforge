import { describe, expect, it } from "vitest";
import type { ArtifactSchema } from "../../lib/api";
import {
  buildExportAudioSets,
  exportOutputNames,
  exportPresetForSelection,
} from "./exportWorkspaceUtils";

function artifact(
  id: string,
  type: string,
  createdAt: string,
  sourceArtifactId?: string,
): ArtifactSchema {
  return {
    id,
    project_id: "project-1",
    type,
    format: "wav",
    path: `/tmp/${id}.wav`,
    size_bytes: 1,
    generated_by: "test",
    can_delete: true,
    can_regenerate: false,
    metadata: sourceArtifactId ? { source_artifact_id: sourceArtifactId } : {},
    created_at: createdAt,
  };
}

describe("export workspace utilities", () => {
  it("numbers practice mixes by creation time with an ID tiebreaker", () => {
    const audioSets = buildExportAudioSets([
      artifact("mix-z", "preview_mix", "2026-08-13T12:00:00Z"),
      artifact("source", "source_audio", "2026-08-13T10:00:00Z"),
      artifact("mix-b", "preview_mix", "2026-08-13T11:00:00Z"),
      artifact("mix-a", "preview_mix", "2026-08-13T11:00:00Z"),
      artifact("vocals", "vocal_stem", "2026-08-13T12:01:00Z", "mix-a"),
    ]);

    expect(audioSets.map((audioSet) => [audioSet.artifact.id, audioSet.label])).toEqual([
      ["source", "Source Track"],
      ["mix-a", "Practice Mix 1"],
      ["mix-b", "Practice Mix 2"],
      ["mix-z", "Practice Mix 3"],
    ]);
    expect(audioSets[1]?.stems.map((stem) => stem.id)).toEqual(["vocals"]);
  });

  it("recognizes exact presets and keeps manual subsets custom", () => {
    const [audioSet] = buildExportAudioSets([
      artifact("source", "source_audio", "2026-08-13T10:00:00Z"),
      artifact("vocals", "vocal_stem", "2026-08-13T10:01:00Z", "source"),
      artifact("drums", "drums_stem", "2026-08-13T10:02:00Z", "source"),
    ]);
    expect(audioSet).toBeDefined();
    if (!audioSet) return;

    expect(exportPresetForSelection(audioSet, new Set(["source"]))).toBe("track");
    expect(exportPresetForSelection(audioSet, new Set(["vocals", "drums"]))).toBe("stems");
    expect(exportPresetForSelection(audioSet, new Set(["source", "vocals", "drums"]))).toBe(
      "track-and-stems",
    );
    expect(exportPresetForSelection(audioSet, new Set(["source", "vocals"]))).toBe("custom");
    expect(exportOutputNames(audioSet, new Set(["source", "vocals"]), "My take", "m4a")).toEqual([
      "My take - Source.m4a",
      "My take - Source - Vocals.m4a",
    ]);
  });
});
