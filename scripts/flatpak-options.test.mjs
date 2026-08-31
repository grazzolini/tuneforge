import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cremaOnlyModelBundlePlan } from "./generate-flatpak-sources.mjs";
import { buildModelBundlePlan } from "./model-bundle-metadata.mjs";
import { readDemucsModelManifest, validateManifest } from "./prepare-demucs-models.mjs";

const flatpakManifest = readFileSync(
  new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const demucsManifest = {
  version: 2,
  models: [
    {
      id: "htdemucs_6s",
      mode: "six_stems",
      repo_id: "fixture/six",
      revision: "a".repeat(40),
      yaml_file: "six.yaml",
      bag_order: ["six"],
      files: [
        {
          label: "six yaml",
          file_name: "six.yaml",
          size: 3,
          sha256: "a".repeat(64),
        },
        {
          label: "six model",
          file_name: "six.safetensors",
          size: 3,
          sha256: "b".repeat(64),
        },
      ],
    },
    {
      id: "htdemucs_ft",
      mode: "two_stems",
      repo_id: "fixture/two",
      revision: "c".repeat(40),
      yaml_file: "two.yaml",
      bag_order: ["two"],
      files: [
        {
          label: "two yaml",
          file_name: "two.yaml",
          size: 3,
          sha256: "c".repeat(64),
        },
        {
          label: "two model",
          file_name: "two.safetensors",
          size: 3,
          sha256: "d".repeat(64),
        },
      ],
    },
  ],
};

test("canonical Demucs manifest pins immutable Hugging Face safetensors", () => {
  const manifest = readDemucsModelManifest();

  assert.equal(manifest.version, 2);
  assert.deepEqual(
    manifest.models.map((model) => [model.id, model.repo_id, model.revision, model.bag_order]),
    [
      [
        "htdemucs_6s",
        "adefossez/HTDemucs-6s",
        "053e1404489b3dc58bf718224fac4b7316de8c93",
        ["5c90dfd2"],
      ],
      [
        "htdemucs_ft",
        "adefossez/HTDemucs-ft",
        "478be8a68f85418addd6f7baefd4be76522a4034",
        ["f7e0c4bc", "d12395a8", "92cfc3b6", "04573f0d"],
      ],
    ],
  );
  assert.equal(
    manifest.models.flatMap((model) => model.files).every(
      (file) => file.file_name.endsWith(".yaml") || file.file_name.endsWith(".safetensors"),
    ),
    true,
  );
});

test("Demucs preparation routes through the backend CLI", () => {
  assert.match(rootPackage.scripts["models:demucs:prepare"], /run-backend-module\.sh app\.cli\.prepare_demucs_models/);
  assert.doesNotMatch(rootPackage.scripts["models:demucs:prepare"], /prepare-demucs-models\.mjs/);
  assert.match(rootPackage.scripts["models:demucs:prepare"], /TUNEFORGE_DEMUCS_PREPARE_BASE_DIR=.*INIT_CWD:-\$PWD/);
});

test("Demucs manifest rejects duplicate models and path traversal", () => {
  const manifest = structuredClone(readDemucsModelManifest());
  manifest.models.push(structuredClone(manifest.models[0]));
  assert.throws(() => validateManifest(manifest), /duplicate model id/);

  const traversing = structuredClone(readDemucsModelManifest());
  traversing.models[0].files[0].file_name = "../escape.yaml";
  assert.throws(() => validateManifest(traversing), /invalid file_name/);

  for (const modelId of ["../escape", "/absolute", "nested/id", "nested\\id", ".", ".."]) {
    const unsafeId = structuredClone(readDemucsModelManifest());
    unsafeId.models[0].id = modelId;
    assert.throws(() => validateManifest(unsafeId), /model id/);
  }
});

test("model bundle plan includes Demucs and Whisper by default", () => {
  const plan = buildModelBundlePlan({ demucsManifest, lyricsModel: "turbo" });
  const sourceNames = plan.sources.map((source) => source["dest-filename"]).sort();

  assert.deepEqual(sourceNames, [
    "base.pt", "large-v3-turbo.pt", "six.safetensors", "six.yaml", "small.pt",
    "two.safetensors", "two.yaml",
  ]);
  assert.equal(plan.manifest.version, 2);
  assert.equal(plan.manifest.torch_checkpoints.length, 0);
  assert.equal(plan.manifest.demucs_hf_models.length, 2);
  assert.equal(plan.manifest.whisper_models.length, 3);
  assert.equal(
    plan.sources.filter((source) => source.dest.includes("model-bundle/demucs/")).every(
      (source) => /\/resolve\/[a-f0-9]{40}\//.test(source.url),
    ),
    true,
  );
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
  assert.equal(withCremaOnnx.manifest.demucs_hf_models.length, 0);
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
