import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseLicenseInventory,
  collectToolStatuses,
  formatReleaseLicenseInventory,
  releaseInventoryCommands,
} from "./release-license-inventory.mjs";
import { DEFAULT_LYRICS_MODEL } from "./model-bundle-metadata.mjs";

test("release inventory commands cover JS, Python, and Rust without writing reports", () => {
  const checklist = buildReleaseLicenseInventory();
  const commandsById = new Map(checklist.inventoryCommands.map((command) => [command.id, command]));

  assert.deepEqual(Array.from(commandsById.keys()), ["javascript", "python", "rust"]);
  assert.equal(commandsById.get("javascript").commands[0].shell, "pnpm licenses list --recursive");
  assert.match(commandsById.get("python").commands[0].shell, /--extra advanced-chords /);
  assert.doesNotMatch(commandsById.get("python").commands[0].shell, /--all-extras/);
  assert.match(commandsById.get("python").commands[1].shell, /uv run --no-sync python -m pip inspect --local/);
  assert.doesNotMatch(commandsById.get("python").commands[1].shell, /--python/);
  assert.equal(
    commandsById.get("rust").commands[0].shell,
    "cd apps/desktop/src-tauri && cargo about generate --format json --locked",
  );
  for (const command of checklist.inventoryCommands) {
    assert.equal(command.writesFiles, false);
  }
});

test("model policy documents default no-bundle packaging and explicit bundle commands", () => {
  const checklist = buildReleaseLicenseInventory();

  assert.equal(checklist.modelPolicy.defaultPackageOptions.modelBundle, false);
  assert.equal(checklist.modelPolicy.defaultPackageOptions.lvChordia, true);
  assert.ok(
    checklist.modelPolicy.defaultPackageCommands.every((entry) => !entry.command.includes("--model-bundle")),
  );
  assert.ok(
    checklist.modelPolicy.explicitModelBundleCommands.every((entry) => entry.command.includes("--model-bundle")),
  );
  assert.ok(
    checklist.modelPolicy.cremaOnnxModelBundleCommands.every(
      (entry) => entry.command.includes("--crema-onnx") && entry.command.includes("--model-bundle"),
    ),
  );
  assert.ok(checklist.modelPolicy.onnxPackageCommands.every((entry) => entry.command.includes("--crema-onnx")));
  assert.ok(checklist.modelPolicy.cachePaths.includes("~/.cache/torch/hub/checkpoints"));
  assert.ok(checklist.modelPolicy.cachePaths.includes("~/.cache/whisper"));
  assert.ok(checklist.modelPolicy.explicitBundleSourceCount > 0);
  assert.ok(checklist.modelPolicy.explicitBundleBytes > 0);
  assert.equal(checklist.modelPolicy.cremaOnnxBundleSourceCount, 2);
  assert.equal(checklist.modelPolicy.cremaOnnxBundleBytes, 2_197_594);
  assert.deepEqual(checklist.modelPolicy.bundledDependencyWeights.lvChordia, {
    checkpointBytes: 28_730_939,
    checkpointCount: 5,
    packagePath: "share/lv-chordia/cache_data",
    sourceRevision: "9d7de7bbf45efa6731ec8dc62d35280f141c0702",
  });
});

test("owned codec policy records audited payloads and platform ownership", () => {
  const checklist = buildReleaseLicenseInventory();

  assert.equal(checklist.ownedCodecPolicy.runtimeVersion, "ffmpeg-9.0.1-lame-4.0-1");
  assert.deepEqual(checklist.ownedCodecPolicy.ownedTargets, [
    "macos-arm64",
    "android-arm64-v8a",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(checklist.ownedCodecPolicy.sources).map(
      ([name, source]) => [name, source.license],
    )),
    { ffmpeg: "LGPL-2.1-or-later", lame: "LGPL-2.0-or-later" },
  );
  assert.match(checklist.ownedCodecPolicy.sources.ffmpeg.verification, /FCF986EA/);
  assert.match(checklist.ownedCodecPolicy.sources.lame.verification, /no detached signature/);
  assert.match(checklist.ownedCodecPolicy.developmentResolution, /Host FFmpeg/);
  assert.match(checklist.ownedCodecPolicy.flatpakResolution, /zero owned/);
  assert.equal(
    checklist.ownedCodecPolicy.correspondingSources,
    "packaging/ffmpeg/generated/" +
      "TuneForge_ffmpeg-9.0.1-lame-4.0-1_corresponding-sources.tar",
  );

  const rendered = formatReleaseLicenseInventory(checklist);
  assert.match(rendered, /Owned codec policy:/);
  assert.match(rendered, /FFmpeg\/LAME release payloads require matching source companion/);
  assert.doesNotMatch(rendered, /FFmpeg and ffprobe are host-installed and are not bundled/);
});

test("Android analysis inventory pins Crema, ONNX Runtime, and owned libsoxr", () => {
  const policy = buildReleaseLicenseInventory().androidAnalysisPolicy;

  assert.deepEqual(policy.onnxRuntime, {
    coordinate: "com.microsoft.onnxruntime:onnxruntime-android:1.29.0",
    version: "1.29.0",
    license: "MIT",
    size: 51_897_836,
    sha256: "e97540ca78fe36f6fe2013f82843414fb843b6c7681fb04644cba5e1406662dd",
  });
  assert.equal(policy.crema.revision, "895b249c4ccabaedc0770b12935c2b7b2f60e145");
  assert.deepEqual(policy.crema.assets.map(({ size }) => size), [2_193_804, 3_790]);
  assert.equal(policy.soxr.license, "LGPL-2.1-or-later");
  assert.equal(policy.soxr.revision, "a66f3eeeeb62a32403ff143b756eed92b1ec6b62");
  assert.match(policy.soxr.linkage, /Dynamically linked/);
  assert.match(policy.soxr.linkage, /replaceable companion sources/);
  assert.deepEqual(policy.soxr.pffft, {
    revision: "483453d8f7661058e74aa4e7cf5c27bcd7887e7a",
    license: "BSD-3-Clause",
  });

  const rendered = formatReleaseLicenseInventory(buildReleaseLicenseInventory());
  assert.match(rendered, /Android analysis runtime policy:/);
  assert.match(rendered, /onnxruntime-android:1\.29\.0/);
  assert.match(rendered, /libsoxr soxr-a66f3eee: LGPL-2\.1-or-later/);
  assert.match(rendered, /PFFFT 483453d8f7661058e74aa4e7cf5c27bcd7887e7a: BSD-3-Clause/);
});

test("model policy output is stable when lyrics model env is overridden", () => {
  const baseline = withLyricsModelEnv(undefined, () => buildReleaseLicenseInventory().modelPolicy);
  const overridden = withLyricsModelEnv("tiny", () => buildReleaseLicenseInventory().modelPolicy);

  assert.equal(overridden.defaultLyricsModel, DEFAULT_LYRICS_MODEL);
  assert.equal(overridden.explicitBundleSourceCount, baseline.explicitBundleSourceCount);
  assert.equal(overridden.explicitBundleBytes, baseline.explicitBundleBytes);
  assert.deepEqual(overridden.defaultPackageOptions, baseline.defaultPackageOptions);
});

test("tool status collection can report missing cargo-about without throwing", () => {
  const statuses = collectToolStatuses(releaseInventoryCommands, {
    checkTool(tool) {
      return {
        tool,
        available: tool !== "cargo-about",
        detail: tool === "cargo-about" ? "cargo-about not found" : "available",
      };
    },
  });

  assert.deepEqual(
    statuses.map((status) => [status.tool, status.available]),
    [
      ["pnpm", true],
      ["uv", true],
      ["cargo", true],
      ["cargo-about", false],
    ],
  );
  assert.match(formatReleaseLicenseInventory(buildReleaseLicenseInventory({
    includeToolStatus: true,
    checkTool(tool) {
      return statuses.find((status) => status.tool === tool);
    },
  })), /cargo-about missing/);
});

function withLyricsModelEnv(value, callback) {
  const originalValue = process.env.TUNEFORGE_LYRICS_MODEL;
  if (value === undefined) {
    delete process.env.TUNEFORGE_LYRICS_MODEL;
  } else {
    process.env.TUNEFORGE_LYRICS_MODEL = value;
  }

  try {
    return callback();
  } finally {
    if (originalValue === undefined) {
      delete process.env.TUNEFORGE_LYRICS_MODEL;
    } else {
      process.env.TUNEFORGE_LYRICS_MODEL = originalValue;
    }
  }
}
