import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildReleaseLicenseInventory,
  buildFlatpakProfileComponentInventory,
  collectToolStatuses,
  formatReleaseLicenseInventory,
  releaseInventoryCommands,
  REVIEWED_FLATPAK_PYTHON_LICENSES,
} from "./release-license-inventory.mjs";
import { DEFAULT_LYRICS_MODEL } from "./model-bundle-metadata.mjs";
import {
  assertDefaultCpuTorchClosure,
  flatpakPythonBuildRequirementNames,
  flatpakTorchLockPaths,
  mergeLegacyTorchPackageSets,
  parsePylock,
  parseUvLock,
  resolveNamedPythonPackages,
  resolvePythonRuntimePackages,
  selectPythonArtifact,
} from "./generate-flatpak-sources.mjs";
import { backendSyncArgs, defaultPackageOptions } from "./package-options.mjs";

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
  assert.match(checklist.ownedCodecPolicy.correspondingSources,
    /^packaging\/ffmpeg\/generated\/TuneForge_ffmpeg-9\.0\.1-lame-4\.0-1_[0-9a-f]{16}_corresponding-sources\.tar$/);

  const rendered = formatReleaseLicenseInventory(checklist);
  assert.match(rendered, /Owned codec policy:/);
  assert.match(rendered, /FFmpeg\/LAME release payloads require matching source companion/);
  assert.doesNotMatch(rendered, /FFmpeg and ffprobe are host-installed and are not bundled/);
});

test("Android analysis inventory pins Demucs, Crema, ONNX Runtime, and owned libsoxr", () => {
  const policy = buildReleaseLicenseInventory().androidAnalysisPolicy;

  assert.equal(policy.demucs.profile.variant, "cpu-t4-b1-openblas-pthread");
  assert.equal(policy.demucs.openblas.license, "BSD-3-Clause");
  assert.equal(policy.demucs.openblas.sourceSha256, "cd7e129868320cc2d033afa920e31202dfe0b8066a5b66661900ccc0f197dfed");
  assert.equal(policy.demucs.model.revision, "053e1404489b3dc58bf718224fac4b7316de8c93");
  assert.equal(policy.demucs.model.fileName, "5c90dfd2.safetensors");
  assert.equal(policy.demucs.nativeArchives.find(({ name }) => name === "python-torch").version, "2.15.0");
  assert.ok(policy.demucs.nativeArchives.every(({ recipeSha256 }) => /^[a-f0-9]{64}$/.test(recipeSha256)));
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
  assert.match(rendered, /Demucs runtime: cpu-t4-b1-openblas-pthread/);
  assert.match(rendered, /OpenBLAS 0\.3\.34: BSD-3-Clause/);
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

test("section runtime inventory retains code and native plotting license distinctions", () => {
  assert.equal(REVIEWED_FLATPAK_PYTHON_LICENSES["all-in-one-infer"], "MIT AND Apache-2.0");
  assert.equal(REVIEWED_FLATPAK_PYTHON_LICENSES["madmom-infer"], "BSD-2-Clause");
  assert.equal(REVIEWED_FLATPAK_PYTHON_LICENSES["antlr4-python3-runtime"], "BSD-3-Clause");
  assert.match(REVIEWED_FLATPAK_PYTHON_LICENSES.matplotlib, /FTL/);
  assert.match(REVIEWED_FLATPAK_PYTHON_LICENSES.matplotlib, /OFL-1.1/);
  assert.match(REVIEWED_FLATPAK_PYTHON_LICENSES.matplotlib, /CC0-1.0/);
  assert.doesNotMatch(REVIEWED_FLATPAK_PYTHON_LICENSES.matplotlib, /GPL/);
  for (const name of ["contourpy", "cycler", "fonttools", "hydra-core", "kiwisolver", "omegaconf",
    "pillow", "pyparsing", "python-dateutil"]) assert.ok(REVIEWED_FLATPAK_PYTHON_LICENSES[name], name);
});

test("the real Flatpak shipping lock passes strict license inventory", (context) => {
  const lock = parseUvLock(readFileSync(new URL("../apps/backend/uv.lock", import.meta.url), "utf8"));
  const syncArgs = backendSyncArgs(defaultPackageOptions());
  const extras = syncArgs.flatMap((arg, index) => arg === "--extra" ? [syncArgs[index + 1]] : []);
  const runtime = mergeLegacyTorchPackageSets(
    resolvePythonRuntimePackages(lock, { extras }),
    parsePylock(readFileSync(flatpakTorchLockPaths.cpu, "utf8")),
  );
  assertDefaultCpuTorchClosure(runtime);
  const build = resolveNamedPythonPackages(lock, flatpakPythonBuildRequirementNames);
  const packages = [...new Map([...runtime, ...build].map((pkg) =>
    [`${pkg.name}@${pkg.version}`, pkg])).values()];
  const artifacts = packages.map((pkg) => ({
    name: pkg.name, version: pkg.version, ...selectPythonArtifact(pkg),
  }));
  const generatedRoot = mkdtempSync(path.join(tmpdir(), "tuneforge-real-license-inventory-"));
  context.after(() => rmSync(generatedRoot, { recursive: true, force: true }));
  const write = (name, value) => writeFileSync(path.join(generatedRoot, name), value);
  write("python-requirements.txt", runtime.map((pkg) => `${pkg.name}==${pkg.version}`).join("\n"));
  write("python-build-requirements.txt", build.map((pkg) => `${pkg.name}==${pkg.version}`).join("\n"));
  write("python-size-report.json", JSON.stringify(artifacts));
  write("python-sources.json", JSON.stringify(artifacts.map((artifact) => ({
    url: artifact.url, sha256: artifact.sha256, "dest-filename": artifact.fileName,
  }))));

  const options = { generatedRoot, selectedProfiles: ["cpu"], strict: true };
  const inventory = buildFlatpakProfileComponentInventory(options);
  assert.deepEqual(inventory.errors, []);
  assert.equal(inventory.profiles.length, 1);
  const components = inventory.profiles[0].components;
  assert.equal(components.length, packages.length);
  assert.ok(components.every((component) => component.license));
  for (const [name, version, license] of [
    ["pillow", "12.3.0", "MIT-CMU"], ["tzdata", "2026.6", "Apache-2.0"],
  ]) {
    const component = components.find((entry) => entry.name === name);
    assert.equal(component?.version, version);
    assert.equal(component?.license, license);
  }
  const pillow = runtime.find((pkg) => pkg.name === "pillow");
  for (const target of [/cp314-cp314-manylinux.*_x86_64/, /cp314-cp314-macosx_.*_arm64/]) {
    assert.ok(pillow.wheels.some((wheel) => target.test(wheel.fileName)), String(target));
  }
  context.diagnostic(`${components.length} resolved shipping/build packages have reviewed licenses`);
  const withoutTzdata = { ...REVIEWED_FLATPAK_PYTHON_LICENSES };
  delete withoutTzdata.tzdata;
  assert.throws(() => buildFlatpakProfileComponentInventory({
    ...options, licenseMetadata: withoutTzdata,
  }), /tzdata 2026\.6 lacks reviewed license metadata/);
});
