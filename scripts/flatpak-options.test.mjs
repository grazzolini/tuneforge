import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cremaOnlyModelBundlePlan } from "./generate-flatpak-sources.mjs";
import { buildModelBundlePlan } from "./model-bundle-metadata.mjs";

const flatpakManifest = readFileSync(
  new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
  "utf8",
);

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

test("Advanced Chords package plan includes only pinned Crema ONNX files without broad models", () => {
  const withoutCremaOnnx = buildModelBundlePlan({ demucsManifest, lyricsModel: "base" });
  const withCremaOnnx = cremaOnlyModelBundlePlan(buildModelBundlePlan({
    demucsManifest,
    includeCremaOnnx: true,
    lyricsModel: "base",
  }));

  assert.equal(withoutCremaOnnx.manifest.crema_onnx_files.length, 0);
  assert.equal(withCremaOnnx.manifest.torch_checkpoints.length, 0);
  assert.equal(withCremaOnnx.manifest.whisper_models.length, 0);
  assert.deepEqual(
    withCremaOnnx.manifest.crema_onnx_files.map((entry) => entry.file_name).sort(),
    ["crema-0.2.0-opset18.onnx", "crema-0.2.0-runtime-state.json"],
  );
  assert.equal(
    withCremaOnnx.manifest.crema_onnx_files.reduce((total, entry) => total + entry.size, 0),
    2_197_594,
  );
});

test("Flatpak manifest allows the logind inhibition fallback", () => {
  assert.match(flatpakManifest, /^\s+- --system-talk-name=org\.freedesktop\.login1$/m);
});

test("Flatpak declares optional bundled Torch extension refs without widening devices", () => {
  assert.match(flatpakManifest, /^app-id: com\.tuneforge\.desktop$/m);
  const extensionSection = flatpakManifest.slice(
    flatpakManifest.indexOf("add-extensions:"),
    flatpakManifest.indexOf("finish-args:"),
  );
  assert.doesNotMatch(extensionSection, /^  com\.tuneforge\.desktop\.Torch:$/m);
  assert.doesNotMatch(extensionSection, /^  com\.tuneforge\.desktop\.Torch\.(?:Nvidia|LegacyNvidia):$/m);
  for (const profile of ["Nvidia", "LegacyNvidia"]) {
    assert.match(flatpakManifest, new RegExp(`^  com\\.tuneforge\\.desktop\\.Torch\\.Stack\\.${profile}:$`, "m"));
    assert.match(
      flatpakManifest,
      new RegExp(`directory: lib/tuneforge/backend/torch-extensions/${profile}`),
    );
    for (const role of ["Core", "Runtime"]) {
      assert.match(
        flatpakManifest,
        new RegExp(`^  com\\.tuneforge\\.desktop\\.Torch\\.Stack\\.${profile}\\.${role}:$`, "m"),
      );
      assert.match(
        flatpakManifest,
        new RegExp(`directory: lib/tuneforge/backend/torch-extensions/${profile}/${role}`),
      );
    }
  }
  assert.equal((extensionSection.match(/^    bundle: true$/gm) ?? []).length, 4);
  assert.equal((extensionSection.match(/^    merge-dirs: site-packages$/gm) ?? []).length, 2);
  assert.match(flatpakManifest, /^  - --device=dri$/m);
  assert.doesNotMatch(flatpakManifest, /--device=all|add-ld-path/);
});
