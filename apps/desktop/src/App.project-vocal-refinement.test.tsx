import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import type { ArtifactSchema } from "./lib/api";
import { buildExportAudioSets } from "./features/projects/exportWorkspaceUtils";
import { describeVocalGroup, resolveVocalStemControls } from "./features/projects/vocalStemGroup";
import {
  mockConfirm, mockCreateVocalSubstems, mockGetVocalSubstemCapabilities,
  renderApp, resetAppTestHarness, setProjectArtifacts,
} from "./test/appTestHarness";

const hash = "a".repeat(64);
const sourceId = "art_source";
const parentId = "art_vocals";
const generation = "vocalset_1";

function artifact(id: string, type: string, metadata: ArtifactSchema["metadata"]): ArtifactSchema {
  return {
    id, type, format: "wav", metadata, path: `/tmp/${id}.wav`, project_id: "proj_123",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    file_integrity: "verified", can_delete: true, can_regenerate: true, generated_by: "fixture", size_bytes: 100,
  };
}

function fixture(excluded: string[] = [], includeBacking = true) {
  const source = artifact(sourceId, "source_audio", {});
  const parent = artifact(parentId, "vocal_stem", {
    stem_model: "htdemucs_6s", mode: "six_stems", source_artifact_id: sourceId,
    vocal_substems: {
      generation_id: generation, source_artifact_id: sourceId, parent_sha256: hash, source_sha256: hash,
      format: "wav", expected_parts: ["lead", "backing"], excluded_parts: excluded,
      child_artifact_ids: excluded.length ? { lead: "art_lead" } : { lead: "art_lead", backing: "art_backing" },
      child_sha256: excluded.length ? { lead: hash } : { lead: hash, backing: hash },
    },
  });
  const part = (name: string) => artifact(`art_${name}`, `${name}_vocal_substem`, {
    parent_artifact_id: parentId, source_artifact_id: sourceId, generation_id: generation, vocal_part: name,
  });
  const stems = [parent, part("lead"), ...(includeBacking ? [part("backing")] : []),
    artifact("art_bass", "bass_stem", { source_artifact_id: sourceId })];
  return { source, parent, stems, artifacts: [source, ...stems] };
}

beforeEach(() => {
  resetAppTestHarness();
  mockGetVocalSubstemCapabilities.mockResolvedValue({
    available: true, cached: false, download_bytes: 1368924071, unavailable_reason: null,
  });
});

it("offers a manual rebuild for the selected six-stem Vocals and confirms the first download", async () => {
  setProjectArtifacts("proj_123", fixture().artifacts);
  const user = userEvent.setup();
  renderApp(["/projects/proj_123"]);
  const action = await screen.findByRole("button", { name: "Rebuild Refined Vocals" });
  expect(mockCreateVocalSubstems).not.toHaveBeenCalled();
  await user.click(action);
  await waitFor(() => expect(mockCreateVocalSubstems).toHaveBeenCalledWith(
    "proj_123", expect.objectContaining({ vocals_artifact_id: parentId, allow_download: true }),
  ));
  expect(mockConfirm).toHaveBeenCalledWith(expect.stringContaining("1.37 GB"), expect.anything());
  const mode = screen.getByRole("group", { name: "Vocals playback mode" });
  expect(within(mode).getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
});

it("shares complete and deliberately partial membership with export", () => {
  const complete = fixture();
  const incomplete = fixture([], false);
  const partial = fixture(["backing"], false);
  const split = { [sourceId]: `${parentId}:${generation}` };
  expect(buildExportAudioSets(complete.artifacts, {}, {}, split)[0].defaultStemIds)
    .toEqual(["art_lead", "art_backing", "art_bass"]);
  expect(buildExportAudioSets(incomplete.artifacts, {}, {}, split)[0].defaultStemIds)
    .toEqual([parentId, "art_bass"]);
  expect(buildExportAudioSets(partial.artifacts, {}, {}, split)[0].defaultStemIds)
    .toEqual(["art_lead", "art_bass"]);
  expect(describeVocalGroup(complete.stems, complete.source)?.splitIdentity)
    .not.toBe(describeVocalGroup(partial.stems, partial.source)?.splitIdentity);
});

it("applies original Vocals mute, solo, and level to both Split children", () => {
  const complete = fixture();
  const group = describeVocalGroup(complete.stems, complete.source);
  const backing = { muted: false, solo: false, gain: 1 };
  const bass = { muted: false, solo: true, gain: 0.5 };
  const effective = resolveVocalStemControls(group, "split", {
    [parentId]: { muted: true, solo: true, gain: 0.4 },
  }, { art_lead: { muted: false, solo: true }, art_backing: backing, art_bass: bass });
  expect(effective.art_lead).toEqual({ muted: true, groupMuted: true, solo: true, gain: 0.4 });
  expect(effective.art_backing).toEqual({ muted: true, groupMuted: true, solo: false, gain: 0.4 });
  expect(effective.art_bass).toEqual(bass);
});
