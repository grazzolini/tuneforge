import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMockInvoke,
  mockConfirm,
  mockCreateDrumSubstems,
  mockGetDrumSubstemCapabilities,
  renderApp,
  resetAppTestHarness,
  setMockNativeAudioState,
  setProjectAnalysis,
  setProjectArtifacts,
} from "./test/appTestHarness";
import { openPlaybackWorkspace } from "./test/projectTestActions";

const createdAt = "2026-04-18T13:16:00Z";
const parentSha256 = "a".repeat(64);

function enableNativePlayback() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: getMockInvoke() },
  });
  setMockNativeAudioState({ capabilities: {
    nativePlaybackSupported: true,
    fallbackRequired: false,
    fallbackReason: null,
    backend: "desktop-cpal",
  } });
}

function latestPreparedSession() {
  const prepare = [...getMockInvoke().mock.calls].reverse()
    .find(([command]) => command === "audio_prepare_session");
  return (prepare?.[1] as { payload?: {
    lanes?: Array<{ artifactId: string }>;
    playbackRate?: number;
  } } | undefined)?.payload;
}

function setDrumArtifacts() {
  const primaryArtifacts = [
    { id: "art_source", type: "source_audio", path: "/tmp/source.wav", metadata: {} },
    { id: "art_preview", type: "preview_mix", path: "/tmp/mix.wav", metadata: {
      retune: {}, transpose: { semitones: 2 },
    } },
  ];
  const artifacts: Array<Record<string, unknown>> = primaryArtifacts.map((artifact) => ({
    ...artifact, project_id: "proj_123", format: "wav", created_at: createdAt,
  }));
  for (const primary of primaryArtifacts) {
    for (const [source, type] of [
      ["vocals", "vocal_stem"], ["bass", "bass_stem"], ["guitar", "guitar_stem"],
      ["piano", "piano_stem"], ["other", "other_stem"],
    ]) {
      artifacts.push({
        id: `${primary.id}_${source}`, project_id: "proj_123", type,
        path: `/tmp/${primary.id}-${source}.wav`, format: "wav", created_at: createdAt,
        metadata: { source_artifact_id: primary.id, stem_model: "htdemucs_6s" },
      });
    }
    const parentId = `${primary.id}_drums`;
    artifacts.push({
      id: parentId, project_id: "proj_123", type: "drums_stem",
      path: `/tmp/${parentId}.wav`, format: "wav", created_at: createdAt,
      file_integrity: "verified",
      metadata: { source_artifact_id: primary.id, stem_model: "htdemucs_6s", drum_substems: {
        generation_id: "generation", parent_sha256: parentSha256,
        expected_parts: ["kick", "snare", "cymbals", "toms"],
        excluded_parts: ["snare", "cymbals", "toms"],
        child_artifact_ids: { kick: `${primary.id}_kick` },
      } },
    });
    artifacts.push({
      id: `${primary.id}_kick`, project_id: "proj_123", type: "kick_drum_substem",
      path: `/tmp/${primary.id}-kick.wav`, format: "wav", created_at: createdAt,
      file_integrity: "verified",
      metadata: { source_artifact_id: primary.id, parent_artifact_id: parentId,
        generation_id: "generation", parent_sha256: parentSha256 },
    });
  }
  setProjectArtifacts("proj_123", artifacts);
}

describe("Drum refinement controls", () => {
  beforeEach(() => {
    resetAppTestHarness();
    enableNativePlayback();
    setDrumArtifacts();
  });

  it.each(["missing", "verified", "corrupt"])(
    "authorizes a %s DrumSep cache only after an explicit refinement action",
    async (cacheStatus) => {
      mockGetDrumSubstemCapabilities.mockResolvedValue({
        platform_supported: true, available: true, unavailable_reason: null,
        model_id: "drumsep", checkpoint_sha256: parentSha256,
        checkpoint_revision: "test", cache_status: cacheStatus,
        download_size_bytes: 167400043,
      });
      const user = userEvent.setup();
      renderApp(["/projects/proj_123"]);
      expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
      expect(mockCreateDrumSubstems).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Disable DrumSep opt-in" })).not.toBeInTheDocument();
      const action = await screen.findByRole("button", { name: "Rebuild Refined Drums" });
      await user.click(action);
      await waitFor(() => expect(mockCreateDrumSubstems).toHaveBeenCalledWith(
        "proj_123",
        expect.objectContaining({
          drums_artifact_id: "art_source_drums", force: true, allow_download: true,
        }),
      ));
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("tuneforge.drumsep-enabled")).toBeNull();
    },
  );

  it.each(["source", "mix"] as const)(
    "activates Original and Split from full %s playback, including a repeated mode click",
    async (selection) => {
      const user = userEvent.setup();
      renderApp(["/projects/proj_123"]);
      expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
      await openPlaybackWorkspace(user);
      if (selection === "mix") {
        const sources = screen.getByRole("group", { name: "Playback source and mix list" });
        await user.click(within(sources).getByRole("button", { name: /Practice Mix/i }));
      }
      const stems = screen.getByRole("group", { name: "Playback stem list" });
      const mode = within(stems).getByRole("group", { name: "Drums playback mode" });
      expect(mockCreateDrumSubstems).not.toHaveBeenCalled();
      await user.click(within(mode).getByRole("button", { name: "Original" }));
      expect(await screen.findByRole("heading", { name: "Drums" })).toBeInTheDocument();
      const expectedParent = selection === "source" ? "art_source_drums" : "art_preview_drums";
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"))
        .toMatchObject({ proj_123: { selectedArtifactId: expectedParent } }));
      await user.click(screen.getByRole("button", { name: "Full Mix" }));
      await user.click(within(mode).getByRole("button", { name: "Split" }));
      expect(within(mode).getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"))
        .toMatchObject({ proj_123: { selectedArtifactId: expectedParent } }));
    },
  );

  it.each([false, true])(
    "preserves native transport, loop, rate, and visual capo while switching drums (playing: %s)",
    async (playing) => {
      setProjectAnalysis("proj_123", {
        project_id: "proj_123", estimated_key: "G major", key_confidence: 0.82,
        estimated_reference_hz: 440, tuning_offset_cents: 0, tempo_bpm: 123.5,
        analysis_version: "v1", created_at: createdAt,
      });
      window.localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({
        proj_123: {
          loopRange: { startSeconds: 20, endSeconds: 40 },
          tempoTargetBpm: 140,
          capoTransposeSemitones: 2,
        },
      }));
      const user = userEvent.setup();
      renderApp(["/projects/proj_123"]);
      expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
      await openPlaybackWorkspace(user);
      if (playing) {
        await user.click(screen.getByRole("button", { name: "Play playback" }));
        await waitFor(() => expect(getMockInvoke().mock.calls.some(([command]) => command === "audio_play"))
          .toBe(true));
      }
      fireEvent.change(screen.getByLabelText("Playback position"), { target: { value: "32.481" } });
      const mode = screen.getByRole("group", { name: "Drums playback mode" });
      await user.click(within(mode).getByRole("button", { name: "Split" }));
      if (!playing) {
        expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Play playback" }));
      }
      await waitFor(() => expect(latestPreparedSession()?.lanes?.map((lane) => lane.artifactId))
        .toContain("art_source_kick"));
      expect(latestPreparedSession()?.lanes?.map((lane) => lane.artifactId))
        .not.toContain("art_source_drums");
      expect(latestPreparedSession()?.playbackRate).toBeCloseTo(140 / 123.5, 3);
      if (!playing) await user.click(screen.getByRole("button", { name: "Pause playback" }));
      await user.click(within(mode).getByRole("button", { name: "Original" }));
      if (!playing) await user.click(screen.getByRole("button", { name: "Play playback" }));
      await waitFor(() => expect(latestPreparedSession()?.lanes?.map((lane) => lane.artifactId))
        .toContain("art_source_drums"));
      expect(latestPreparedSession()?.lanes?.map((lane) => lane.artifactId))
        .not.toContain("art_source_kick");
      if (!playing) await user.click(screen.getByRole("button", { name: "Pause playback" }));

      expect(screen.getByLabelText("Playback position")).toHaveValue("32.481");
      expect(screen.getByRole("button", { name: playing ? "Pause playback" : "Play playback" }))
        .toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Clear loop" })).toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem("tuneforge.project-playback-state") ?? "{}"))
        .toMatchObject({ proj_123: {
          loopRange: { startSeconds: 20, endSeconds: 40 },
          tempoTargetBpm: 140,
          capoTransposeSemitones: 2,
        } });
    },
  );

  it("keeps Studio mode changes as a preference until stem playback is selected", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);
    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    const studioStems = screen.getByRole("group", { name: "Stem track list" });
    await user.click(within(studioStems).getByRole("button", { name: "Split" }));
    await openPlaybackWorkspace(user);
    expect(screen.getByRole("button", { name: "Full Mix" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Playback stem list" })).toBeInTheDocument();
  });
});
