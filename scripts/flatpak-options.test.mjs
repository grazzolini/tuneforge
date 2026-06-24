import assert from "node:assert/strict";
import test from "node:test";
import { buildModelBundlePlan } from "./model-bundle-metadata.mjs";

const demucsManifest = {
  rootUrl: "https://example.invalid/models/",
  models: [
    {
      id: "htdemucs_6s",
      files: [
        {
          fileName: "six.th",
          size: 3,
          sha256: "a".repeat(64),
        },
      ],
    },
    {
      id: "htdemucs_ft",
      files: [
        {
          fileName: "two.th",
          size: 3,
          sha256: "b".repeat(64),
        },
      ],
    },
  ],
};

test("model bundle plan includes Demucs and Whisper by default", () => {
  const plan = buildModelBundlePlan({ demucsManifest, lyricsModel: "turbo" });
  const sourceNames = plan.sources.map((source) => source["dest-filename"]).sort();

  assert.deepEqual(sourceNames, ["base.pt", "large-v3-turbo.pt", "six.th", "small.pt", "two.th"]);
  assert.equal(plan.manifest.torch_checkpoints.length, 2);
  assert.equal(plan.manifest.whisper_models.length, 3);
});

test("model bundle plan includes beat-this only when requested", () => {
  const withoutBeatThis = buildModelBundlePlan({ demucsManifest, lyricsModel: "base" });
  const withBeatThis = buildModelBundlePlan({
    demucsManifest,
    includeBeatThis: true,
    lyricsModel: "base",
  });

  assert.equal(
    withoutBeatThis.sources.some((source) => source["dest-filename"] === "beat_this-small0.ckpt"),
    false,
  );
  assert.equal(
    withBeatThis.sources.some((source) => source["dest-filename"] === "beat_this-small0.ckpt"),
    true,
  );
});
