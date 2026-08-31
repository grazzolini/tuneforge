import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDefaultCpuTorchClosure,
  assertTorchExtensionProfile,
  markerMatchesFlatpakTarget,
  flatpakTorchLockPaths,
  mergeLegacyTorchPackageSets,
  parseUvLock,
  parsePylock,
  partitionTorchExtensionPackages,
  removeObsoleteTorchExtensionOutputs,
  removeUnselectedTorchExtensionOutputs,
  resolvePythonRuntimePackages,
  resolveNamedPythonPackages,
  selectedTorchExtensionProfileSpecs,
  torchExtensionPairId,
  torchExtensionMarker,
  assertReviewedTorchExtensionPair,
  TORCH_EXTENSION_PROFILES,
  wheelScore,
} from "./generate-flatpak-sources.mjs";
import { manifestWithPackageOptions } from "./package-flatpak.mjs";
import { refreshTorchLock } from "./refresh-flatpak-torch-locks.mjs";
import {
  buildFlatpakProfileComponentInventory,
  buildReleaseLicenseInventory,
  formatReleaseLicenseInventory,
} from "./release-license-inventory.mjs";
import {
  assertCremaOnnxBundleLayout,
  assertLvChordiaBundleLayout,
  CREMA_ONNX_BUNDLE_RELATIVE_PATHS,
  DEMUCS_MANIFEST_BACKEND_RELATIVE_PATH,
  LV_CHORDIA_CHECKPOINT_NAMES,
  stageDemucsManifest,
} from "./prepare-bundle.mjs";
import {
  backendSyncArgs,
  normalizeFlatpakProfiles,
  packageOptionsEnvironment,
  frontendPackageOptionsEnvironment,
  packageOptionsToGeneratorArgs,
  parsePackageOptions,
} from "./package-options.mjs";

const flatpakPipTmpDir = "/run/build/python-runtime-deps/.pip-tmp";

test("Flatpak source generation removes only exact obsolete Torch extension outputs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tuneforge-obsolete-torch-"));
  const stem = ["modern", "torch"].join("-");
  const obsolete = [
    `${stem}-profile.json`,
    ...["requirements.txt", "sources.json", "size-report.json"].map((suffix) => `python-${stem}-${suffix}`),
  ];
  try {
    for (const file of [...obsolete, `python-${stem}-keep.txt`]) writeFileSync(path.join(root, file), "stale");
    removeObsoleteTorchExtensionOutputs(root);
    assert.ok(obsolete.every((file) => !existsSync(path.join(root, file))));
    assert.equal(existsSync(path.join(root, `python-${stem}-keep.txt`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Flatpak source generation removes stale unselected profiles and resolves selected profiles only", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tuneforge-selected-torch-"));
  const stale = [
    "python-nvidia-torch-core-requirements.txt",
    "python-legacy-torch-runtime-sources.json",
    "legacy-torch-core-profile.json",
  ];
  try {
    for (const file of stale) writeFileSync(path.join(root, file), "stale");
    removeUnselectedTorchExtensionOutputs(["cpu", "nvidia"], root);
    assert.equal(existsSync(path.join(root, stale[0])), true);
    assert.equal(existsSync(path.join(root, stale[1])), false);
    assert.equal(existsSync(path.join(root, stale[2])), false);

    let nvidiaCalls = 0;
    let legacyCalls = 0;
    const specs = selectedTorchExtensionProfileSpecs(["cpu", "nvidia"], {
      resolveNvidia: () => { nvidiaCalls += 1; return { packages: ["nvidia"] }; },
      resolveLegacy: () => { legacyCalls += 1; return { packages: ["legacy"] }; },
    });
    assert.deepEqual(specs.map(({ profileName }) => profileName), ["Nvidia"]);
    assert.equal(nvidiaCalls, 1);
    assert.equal(legacyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS and Flatpak stage the canonical Demucs manifest at the runtime path", () => {
  const stagedRoot = mkdtempSync(path.join(tmpdir(), "tuneforge-demucs-manifest-"));
  try {
    const stagedPath = stageDemucsManifest(stagedRoot);
    assert.equal(path.relative(stagedRoot, stagedPath), DEMUCS_MANIFEST_BACKEND_RELATIVE_PATH);
    assert.deepEqual(JSON.parse(readFileSync(stagedPath, "utf8")), JSON.parse(readFileSync(
      new URL("../packaging/demucs/models.json", import.meta.url),
      "utf8",
    )));
  } finally {
    rmSync(stagedRoot, { recursive: true, force: true });
  }

  const manifest = readFileSync(
    new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
    "utf8",
  );
  assert.match(manifest, /path: generated\/backend-snapshot\.tar\n\s+archive-type: tar\n\s+strip-components: 0/);
  assert.match(
    manifest,
    /install -Dm644 apps\/backend\/demucs-models\.json \/app\/lib\/tuneforge\/backend\/src\/demucs-models\.json/,
  );
});

function pythonRuntimeDepsModule(manifest) {
  return manifest.slice(
    manifest.indexOf("  - name: python-runtime-deps"),
    manifest.indexOf("  - name: nvidia-torch-core-extension"),
  );
}

function assertFlatpakPipTempLifecycle(manifest) {
  const module = pythonRuntimeDepsModule(manifest);
  const createCommand = `      - install -dm700 ${flatpakPipTmpDir}`;
  const cleanupCommand = `      - rm -rf ${flatpakPipTmpDir}`;
  const createIndex = module.indexOf(createCommand);
  const cleanupIndex = module.indexOf(cleanupCommand);
  const pipCommands = [...module.matchAll(/ -m pip install /g)];

  assert.match(module, new RegExp(`^        TMPDIR: ${flatpakPipTmpDir.replaceAll(".", "\\.")}$`, "m"));
  assert.equal((module.match(new RegExp(flatpakPipTmpDir.replaceAll(".", "\\."), "g")) ?? []).length, 3);
  assert.ok(createIndex >= 0);
  assert.ok(cleanupIndex >= 0);
  assert.equal(pipCommands.length, 2);
  assert.ok(createIndex < pipCommands[0].index);
  assert.ok(cleanupIndex > pipCommands[1].index);
  assert.doesNotMatch(module, /(?:--target=|install -dm\d+ )\/app\/[^\n]*\.pip-tmp/);
}

test("package option parser accepts feature aliases", () => {
  assert.deepEqual(
    parsePackageOptions(["--crema", "--beat-this", "--model-bundle"], { platform: "mac" }),
    {
      crema: "onnx",
      lvChordia: true,
      beatThis: true,
      modelBundle: true,
      noBundle: false,
      sandboxData: false,
      flatpakProfiles: ["cpu", "nvidia", "legacy-nvidia"],
    },
  );
  assert.deepEqual(
    parsePackageOptions(["--advanced-chords", "--advanced-beats"], { platform: "linux" }),
    {
      crema: "onnx",
      lvChordia: true,
      beatThis: true,
      modelBundle: false,
      noBundle: false,
      sandboxData: false,
      flatpakProfiles: ["cpu", "nvidia", "legacy-nvidia"],
    },
  );
});

test("package option parser includes advanced dependencies by default", () => {
  const options = parsePackageOptions([], { platform: "mac" });

  assert.deepEqual(options, {
    crema: "onnx",
    lvChordia: true,
    beatThis: true,
    modelBundle: false,
    noBundle: false,
    sandboxData: false,
    flatpakProfiles: ["cpu", "nvidia", "legacy-nvidia"],
  });
  assert.deepEqual(packageOptionsToGeneratorArgs(options), [
    "--crema", "--beat-this", "--lv-chordia", "--cpu", "--nvidia", "--legacy-nvidia",
  ]);
  assert.deepEqual(backendSyncArgs(options), [
    "sync",
    "--python",
    "3.14",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
    "--extra",
    "lv-chordia",
  ]);
});

test("release defaults do not enable the broad model bundle", () => {
  for (const platform of ["mac", "linux"]) {
    const options = parsePackageOptions([], { platform });

    assert.equal(options.modelBundle, false);
    assert.equal(packageOptionsToGeneratorArgs(options).includes("--model-bundle"), false);
  }
});

test("package option parser accepts advanced dependency opt-outs", () => {
  const options = parsePackageOptions(["--no-crema", "--no-beat-this", "--no-lv-chordia"], { platform: "linux" });

  assert.equal(options.crema, "none");
  assert.equal(options.beatThis, false);
  assert.equal(options.lvChordia, false);
  assert.equal(JSON.parse(packageOptionsEnvironment(options).TUNEFORGE_PACKAGE_OPTIONS).beatThis, false);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), [
    "--no-crema", "--no-beat-this", "--no-lv-chordia", "--cpu", "--nvidia", "--legacy-nvidia",
  ]);
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.14", "--all-groups"]);
});

test("Advanced Chords aliases select one ONNX profile and reject enable-disable conflicts", () => {
  for (const alias of ["--crema", "--advanced-chords", "--crema-onnx", "--advanced-chords-onnx"]) {
    assert.equal(parsePackageOptions([alias], { platform: "mac" }).crema, "onnx");
  }
  for (const alias of ["--no-crema", "--no-advanced-chords", "--no-crema-onnx", "--no-advanced-chords-onnx"]) {
    assert.equal(parsePackageOptions([alias], { platform: "mac" }).crema, "none");
  }
  const options = parsePackageOptions(["--crema", "--advanced-chords-onnx"], { platform: "mac" });
  assert.deepEqual(packageOptionsToGeneratorArgs(options), [
    "--crema", "--beat-this", "--lv-chordia", "--cpu", "--nvidia", "--legacy-nvidia",
  ]);
  assert.deepEqual(backendSyncArgs(options).slice(4, 6), ["--extra", "advanced-chords"]);
  assert.throws(
    () => parsePackageOptions(["--crema", "--no-advanced-chords-onnx"], { platform: "mac" }),
    /Conflicting Advanced Chords selectors/,
  );
});

test("legacy boolean package data maps to ONNX or none", () => {
  assert.equal(JSON.parse(packageOptionsEnvironment({ crema: true }).TUNEFORGE_PACKAGE_OPTIONS).crema, "onnx");
  assert.equal(JSON.parse(packageOptionsEnvironment({ crema: false }).TUNEFORGE_PACKAGE_OPTIONS).crema, "none");
});

test("Flatpak package options are scoped to the TuneForge module build environment", () => {
  const baseManifest = readFileSync(
    new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
    "utf8",
  );
  const options = parsePackageOptions(["--no-beat-this"], { platform: "linux" });
  const manifest = manifestWithPackageOptions(baseManifest, options);
  const cpythonModule = manifest.slice(
    manifest.indexOf("  - name: cpython-3.14"),
    manifest.indexOf("  - name: python-runtime-deps"),
  );
  const frontendModule = manifest.slice(
    manifest.indexOf("  - name: tuneforge-frontend"),
    manifest.indexOf("  - name: sccache"),
  );

  assert.equal(cpythonModule.includes("TUNEFORGE_PACKAGE_OPTIONS"), false);
  assert.equal((frontendModule.match(/\n    build-options:/g) ?? []).length, 1);
  assert.equal((manifest.match(/TUNEFORGE_PACKAGE_OPTIONS:/g) ?? []).length, 1);
  assert.match(
    frontendModule,
    /      env:\n        TUNEFORGE_PACKAGE_OPTIONS: '.*"beatThis":false.*'/,
  );
  assert.deepEqual(
    JSON.parse(frontendPackageOptionsEnvironment(parsePackageOptions(["--no-crema", "--no-lv-chordia", "--nvidia"], { platform: "linux" })).TUNEFORGE_PACKAGE_OPTIONS),
    { beatThis: true },
  );
  assert.match(manifest, /path: generated\/python-build-requirements\.txt/);
  assert.match(manifest, /-r python-build-requirements\.txt/);
  assert.match(
    manifest,
    /pip install --no-index --no-deps --no-build-isolation .* -r python-requirements\.txt/,
  );
  assert.match(
    manifest,
    /mv \/app\/lib\/tuneforge\/backend\/site-packages\/share\/lv-chordia\/cache_data \/app\/lib\/tuneforge\/backend\/python\/share\/lv-chordia\/cache_data/,
  );
  const optOutManifest = manifestWithPackageOptions(
    baseManifest,
    parsePackageOptions(["--no-lv-chordia"], { platform: "linux" }),
  );
  assert.doesNotMatch(optOutManifest, /site-packages\/share\/lv-chordia\/cache_data/);
  assert.doesNotMatch(optOutManifest, /python\/share\/lv-chordia\/cache_data/);
  assert.doesNotMatch(pythonRuntimeDepsModule(optOutManifest), /pip install .*--no-deps/);
  assert.match(
    optOutManifest,
    /pip install --no-index --no-build-isolation .* -r python-requirements\.txt/,
  );
});

test("selective Flatpak manifests retain declarations and bundle only selected profile leaves", () => {
  const baseManifest = readFileSync(
    new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
    "utf8",
  );
  for (const [args, includedModules, bundleCount] of [
    [["--cpu"], [], 0],
    [["--nvidia"], ["nvidia-torch-core-extension", "nvidia-torch-runtime-extension"], 2],
    [["--legacy-nvidia"], ["legacy-nvidia-torch-core-extension", "legacy-nvidia-torch-runtime-extension"], 2],
    [[], [
      "nvidia-torch-core-extension", "nvidia-torch-runtime-extension",
      "legacy-nvidia-torch-core-extension", "legacy-nvidia-torch-runtime-extension",
    ], 4],
  ]) {
    const selected = manifestWithPackageOptions(
      baseManifest,
      parsePackageOptions(args, { platform: "linux" }),
    );
    for (const profile of ["Nvidia", "LegacyNvidia"]) {
      assert.match(selected, new RegExp(`^  com\\.tuneforge\\.desktop\\.Torch\\.Stack\\.${profile}:$`, "m"));
      for (const role of ["Core", "Runtime"]) {
        assert.match(selected, new RegExp(`^  com\\.tuneforge\\.desktop\\.Torch\\.Stack\\.${profile}\\.${role}:$`, "m"));
      }
    }
    const extensionSection = selected.slice(selected.indexOf("add-extensions:"), selected.indexOf("finish-args:"));
    assert.equal((extensionSection.match(/^    bundle: true$/gm) ?? []).length, bundleCount);
    for (const module of [
      "nvidia-torch-core-extension", "nvidia-torch-runtime-extension",
      "legacy-nvidia-torch-core-extension", "legacy-nvidia-torch-runtime-extension",
    ]) {
      assert.equal(selected.includes(`  - name: ${module}\n`), includedModules.includes(module));
    }
  }
});

test("Flatpak pip temporary files use disk-backed module storage for all Flatpak profiles", () => {
  const baseManifest = readFileSync(
    new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
    "utf8",
  );
  const manifests = [
    baseManifest,
    manifestWithPackageOptions(baseManifest, parsePackageOptions([], { platform: "linux" })),
    manifestWithPackageOptions(
      baseManifest,
      parsePackageOptions(["--no-lv-chordia"], { platform: "linux" }),
    ),
  ];

  for (const manifest of manifests) {
    assertFlatpakPipTempLifecycle(manifest);
  }
});

test("macOS staged bundle has exactly one LV Chordia checkpoint set or none when opted out", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "tuneforge-lv-layout-"));
  try {
    const checkpointRoot = path.join(fixture, "python", "share", "lv-chordia", "cache_data");
    mkdirSync(checkpointRoot, { recursive: true });
    for (const name of LV_CHORDIA_CHECKPOINT_NAMES) {
      writeFileSync(path.join(checkpointRoot, name), "fixture");
    }
    assert.doesNotThrow(() => assertLvChordiaBundleLayout(fixture, true));
    writeFileSync(path.join(fixture, "duplicate.sdict"), "fixture");
    assert.throws(() => assertLvChordiaBundleLayout(fixture, true), /Unexpected LV Chordia checkpoint layout/);
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });
    assert.doesNotThrow(() => assertLvChordiaBundleLayout(fixture, false));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("staged Advanced Chords bundles contain the exact Crema ONNX file layout", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "tuneforge-crema-layout-"));
  try {
    assert.doesNotThrow(() => assertCremaOnnxBundleLayout(fixture, false));
    const datasets = path.join(fixture, "site-packages", "onnxruntime", "datasets");
    mkdirSync(datasets, { recursive: true });
    writeFileSync(path.join(datasets, "logreg_iris.onnx"), "onnxruntime fixture");
    assert.doesNotThrow(() => assertCremaOnnxBundleLayout(fixture, false));

    for (const relativePath of CREMA_ONNX_BUNDLE_RELATIVE_PATHS) {
      const artifact = path.join(fixture, relativePath);
      mkdirSync(path.dirname(artifact), { recursive: true });
      writeFileSync(artifact, "fixture");
    }
    assert.doesNotThrow(() => assertCremaOnnxBundleLayout(fixture, true));
    assert.throws(
      () => assertCremaOnnxBundleLayout(fixture, false),
      /Unexpected Crema ONNX model bundle layout/,
    );

    rmSync(path.join(fixture, CREMA_ONNX_BUNDLE_RELATIVE_PATHS[0]));
    assert.throws(
      () => assertCremaOnnxBundleLayout(fixture, true),
      /Unexpected Crema ONNX model bundle layout/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("package option parser has no profile compatibility path", () => {
  assert.throws(
    () => parsePackageOptions(["--profile", "full"], { platform: "linux" }),
    /Unknown option: --profile/,
  );
});

test("package option parser selects normalized Flatpak profiles", () => {
  const cases = [
    [[], ["cpu", "nvidia", "legacy-nvidia"]],
    [["--cpu"], ["cpu"]],
    [["--nvidia"], ["cpu", "nvidia"]],
    [["--legacy-nvidia"], ["cpu", "legacy-nvidia"]],
    [["--legacy-nvidia", "--nvidia"], ["cpu", "nvidia", "legacy-nvidia"]],
    [["--cpu", "--nvidia", "--cpu"], ["cpu", "nvidia"]],
    [["--legacy-nvidia", "--cpu", "--nvidia"], ["cpu", "nvidia", "legacy-nvidia"]],
  ];
  for (const [args, expected] of cases) {
    assert.deepEqual(parsePackageOptions(args, { platform: "linux" }).flatpakProfiles, expected);
  }
  assert.deepEqual(normalizeFlatpakProfiles(["legacy-nvidia", "cpu", "nvidia"]), [
    "cpu", "nvidia", "legacy-nvidia",
  ]);
  for (const unsupported of ["--all", "--no-nvidia", "--amd", "--intel", "--nvida"]) {
    assert.throws(() => parsePackageOptions([unsupported], { platform: "linux" }), /Unknown option/);
  }
});

test("package option parser rejects platform-specific options", () => {
  assert.throws(
    () => parsePackageOptions(["--legacy-nvidia"], { platform: "mac" }),
    /only supported for Linux Flatpak/,
  );
  assert.throws(
    () => parsePackageOptions(["--no-bundle"], { platform: "mac" }),
    /only supported for Linux Flatpak/,
  );
  assert.throws(
    () => parsePackageOptions(["--sandbox-data"], { platform: "mac" }),
    /only supported for Linux Flatpak/,
  );
});

test("Flatpak reads reviewed CPU and legacy NVIDIA Torch locks without live resolution", () => {
  const generator = readFileSync(new URL("./generate-flatpak-sources.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(generator, /pip",\s+"compile"/);
  const legacy = parsePylock(readFileSync(flatpakTorchLockPaths["legacy-nvidia"], "utf8"));
  const cpu = parsePylock(readFileSync(flatpakTorchLockPaths.cpu, "utf8"));
  const nvidia = resolveNamedPythonPackages(
    parseUvLock(readFileSync(new URL("../apps/backend/uv.lock", import.meta.url), "utf8")),
    ["torch", "torchaudio"],
  );
  assert.ok(cpu.size > 0);
  assert.ok(legacy.size > 0);
  assert.equal(assertReviewedTorchExtensionPair("LegacyNvidia", legacy), TORCH_EXTENSION_PROFILES.LegacyNvidia.pair_id);
  assert.equal(assertReviewedTorchExtensionPair("Nvidia", nvidia), TORCH_EXTENSION_PROFILES.Nvidia.pair_id);
});

test("failed Torch lock refresh preserves the reviewed lock bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tuneforge-torch-refresh-"));
  const lockPath = path.join(root, "pylock.cpu-torch.toml");
  writeFileSync(lockPath, "reviewed bytes\n");
  try {
    assert.throws(() => refreshTorchLock({ id: "cpu", backend: "cpu", lockPath }, {
      compile: (_profile, _requirementsPath, temporaryPath) => writeFileSync(temporaryPath,
        "lock-version = \"1.0\"\n\n[[packages]]\nname = \"torch\"\nversion = \"2.13.0+cpu\"\n\n[[packages]]\nname = \"torchaudio\"\nversion = \"2.11.0+cpu\"\n"),
    }), /No Linux x86_64-compatible artifact/);
    assert.equal(readFileSync(lockPath, "utf8"), "reviewed bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Torch extension profiles enforce exact versions, closure, and immutable markers", () => {
  const nvidia = [
    { name: "torch", version: "2.13.0" },
    { name: "torchaudio", version: "2.11.0" },
    { name: "triton", version: "3.7.1" },
    { name: "cuda-bindings", version: "13.3.1" },
    { name: "nvidia-cudnn-cu13", version: "9.20.0.48" },
  ];
  assert.doesNotThrow(() => assertTorchExtensionProfile(
    nvidia,
    "Nvidia",
    ["cuda-bindings", "nvidia-cudnn-cu13"],
  ));
  assert.throws(
    () => assertTorchExtensionProfile(nvidia, "Nvidia", ["cuda-bindings"]),
    /does not match the locked family/,
  );
  const legacy = [
    { name: "torch", version: "2.13.0+cu126" },
    { name: "torchaudio", version: "2.11.0+cu126" },
    { name: "triton", version: "3.7.1" },
    { name: "cuda-bindings", version: "12.9.7" },
    { name: "nvidia-cublas-cu12", version: "12.6.4.1" },
  ];
  assert.doesNotThrow(() => assertTorchExtensionProfile(legacy, "LegacyNvidia"));
  assert.throws(
    () => assertTorchExtensionProfile(legacy.map((pkg) =>
      pkg.name === "torch" ? { ...pkg, version: "0.0.0" } : pkg), "LegacyNvidia"),
    /requires torch/,
  );
  assert.throws(
    () => assertTorchExtensionProfile(
      legacy.map((pkg) => pkg.name === "nvidia-cublas-cu12"
        ? { name: "nvidia-cublas-cu13", version: pkg.version }
        : pkg),
      "LegacyNvidia",
    ),
    /CUDA 13 package/,
  );
  const hashableNvidia = nvidia.map((pkg, index) => ({
    ...pkg,
    fileName: `${pkg.name}.whl`,
    sha256: String(index).padStart(64, "a"),
  }));
  const { core, runtime } = partitionTorchExtensionPackages(hashableNvidia);
  assert.deepEqual(core.map((pkg) => pkg.name), ["torch", "torchaudio", "triton"]);
  assert.deepEqual(runtime.map((pkg) => pkg.name), ["cuda-bindings", "nvidia-cudnn-cu13"]);
  assert.deepEqual(
    [...core, ...runtime].map((pkg) => `${pkg.name}@${pkg.version}`).sort(),
    hashableNvidia.map((pkg) => `${pkg.name}@${pkg.version}`).sort(),
  );
  const pairId = torchExtensionPairId("Nvidia", hashableNvidia);
  assert.match(pairId, /^[a-f0-9]{64}$/);
  assert.deepEqual(torchExtensionMarker("Nvidia", "core", pairId), {
    schema_version: 2,
    contract: "profile-pair-v1",
    profile: "Nvidia",
    role: "core",
    ref_id: "com.tuneforge.desktop.Torch.Stack.Nvidia.Core",
    python_abi: "cp314",
    torch_version: "2.13.0",
    torchaudio_version: "2.11.0",
    triton_version: "3.7.1",
    cuda_family: "13",
    pair_id: pairId,
  });
});

test("Rust launcher and Flatpak generator share the exact Torch extension contract", () => {
  const rust = readFileSync(
    new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  const embedded = /const TORCH_EXTENSION_POLICY_JSON: &str = r#"([\s\S]*?)"#;/.exec(rust);
  assert.ok(embedded, "Rust Torch extension policy JSON is missing");
  const policy = JSON.parse(embedded[1]);
  assert.deepEqual(Object.keys(policy.profiles).sort(), Object.keys(TORCH_EXTENSION_PROFILES).sort());
  for (const [profileName, generatedProfile] of Object.entries(TORCH_EXTENSION_PROFILES)) {
    assert.deepEqual(policy.profiles[profileName], generatedProfile);
    for (const role of ["core", "runtime"]) {
      const marker = torchExtensionMarker(profileName, role, generatedProfile.pair_id);
      assert.equal(marker.schema_version, policy.schema_version);
      assert.equal(marker.contract, policy.contract);
      assert.equal(marker.python_abi, policy.python_abi);
      assert.equal(marker.profile, profileName);
      assert.equal(marker.role, role);
      assert.equal(marker.ref_id, `${generatedProfile.ref_prefix}.${role === "core" ? "Core" : "Runtime"}`);
    }
  }
});

test("release inventory follows the normalized Flatpak profile selection", () => {
  for (const [profiles, expectedIds] of [
    [["cpu"], ["cpu"]],
    [["nvidia"], ["cpu", "nvidia-core", "nvidia-runtime"]],
    [["legacy-nvidia"], ["cpu", "legacy-nvidia-core", "legacy-nvidia-runtime"]],
    [["legacy-nvidia", "cpu", "nvidia"], [
      "cpu", "nvidia-core", "nvidia-runtime", "legacy-nvidia-core", "legacy-nvidia-runtime",
    ]],
  ]) {
    const inventory = buildReleaseLicenseInventory({ flatpakProfiles: profiles });
    const policy = inventory.modelPolicy;
    assert.deepEqual(policy.flatpakTorchProfiles.map(({ id }) => id), expectedIds);
    assert.equal(policy.flatpakTorchProfiles.find(({ id }) => id === "cpu").cudaFamily, null);
    assert.equal(policy.flatpakChecksumContents.length, expectedIds.length);
    assert.ok(policy.flatpakChecksumContents.every((artifact) => artifact.endsWith(".flatpak")));
    const human = formatReleaseLicenseInventory(inventory);
    assert.doesNotMatch(human, /Torch undefined|Torchaudio undefined|Triton undefined/);
    if (expectedIds.some((id) => id.endsWith("runtime"))) {
      assert.match(human, /CUDA\/NVIDIA runtime family/);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(inventory)).modelPolicy.flatpakChecksumContents,
      policy.flatpakChecksumContents);
  }
});

test("Flatpak profile inventory uses exact generated artifacts and fails closed on license gaps", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tuneforge-flatpak-license-inventory-"));
  try {
    const writeProfile = (prefix, packages) => {
      const artifacts = packages.map(({ name, version }, index) => {
        const fileName = `${prefix}-${name}.whl`;
        const url = `https://example.invalid/${fileName}`;
        return { name, version, fileName, url, sha256: String(index + 1).repeat(64) };
      });
      writeFileSync(path.join(root, `${prefix}-requirements.txt`),
        `${packages.map(({ name, version }) => `${name}==${version}`).join("\n")}\n`);
      writeFileSync(path.join(root, `${prefix}-sources.json`), JSON.stringify(artifacts.map((artifact) => ({
        url: artifact.url, sha256: artifact.sha256, "dest-filename": artifact.fileName,
      }))));
      writeFileSync(path.join(root, `${prefix}-size-report.json`), JSON.stringify(artifacts));
    };
    writeProfile("python", [
      { name: "torch", version: "2.13.0" },
      { name: "wheel", version: "0.48.0" },
      { name: "pathspec", version: "1.1.1" },
    ]);
    writeFileSync(path.join(root, "python-build-requirements.txt"), "wheel==0.48.0\n");
    writeProfile("python-nvidia-torch-core", [{ name: "torch", version: "2.13.0" }]);
    writeProfile("python-legacy-torch-core", [{ name: "torch", version: "2.13.0+cu126" }]);
    writeProfile("python-nvidia-torch-runtime", [
      { name: "cuda-bindings", version: "13.3.1" },
      { name: "nvidia-cublas", version: "13.1.1.3" },
    ]);
    writeProfile("python-legacy-torch-runtime", [
      { name: "cuda-bindings", version: "12.9.7" },
      { name: "nvidia-cublas-cu12", version: "12.6.4.1" },
    ]);
    const fixtureLicenses = {
      "cuda-bindings": "Apache-2.0", pathspec: "MPL-2.0", torch: "BSD-3-Clause", wheel: "MIT",
    };
    const inventory = buildFlatpakProfileComponentInventory({
      generatedRoot: root,
      strict: true,
      licenseMetadata: fixtureLicenses,
    });
    assert.deepEqual(inventory.profiles.map((profile) => profile.id), [
      "cpu", "nvidia-core", "nvidia-runtime", "legacy-nvidia-core", "legacy-nvidia-runtime",
    ]);
    assert.equal(inventory.profiles[0].components[0].sha256, "1".repeat(64));
    const runtimeComponents = inventory.profiles.find(({ id }) => id === "nvidia-runtime").components;
    assert.equal(runtimeComponents.find(({ name }) => name === "cuda-bindings").license, "Apache-2.0");
    assert.equal(
      runtimeComponents.find(({ name }) => name === "nvidia-cublas").license,
      "LicenseRef-NVIDIA-Software-License",
    );
    writeFileSync(path.join(root, "flatpak-profile-selection.json"), JSON.stringify({ profiles: ["cpu"] }));
    assert.deepEqual(buildFlatpakProfileComponentInventory({
      generatedRoot: root,
      strict: true,
      licenseMetadata: fixtureLicenses,
    }).profiles.map(({ id }) => id), ["cpu"]);
    assert.throws(
      () => buildFlatpakProfileComponentInventory({
        generatedRoot: root, strict: true, licenseMetadata: { torch: "BSD-3-Clause", wheel: "MIT" },
      }),
      /pathspec 1\.1\.1 lacks reviewed license metadata/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Flatpak CPU resolver replaces the CUDA closure and rejects unwanted accelerator families", () => {
  const basePackages = [
    { name: "cuda-bindings", version: "13.2.0" },
    { name: "nvidia-cublas-cu12", version: "13.0.0.19" },
    { name: "triton", version: "3.4.0" },
    { name: "torch", version: "2.10.0" },
    { name: "torchaudio", version: "2.10.0" },
    { name: "numpy", version: "1.26.4" },
  ];
  const cpuPackages = new Map(
    [
      { name: "torch", version: "2.13.0" },
      { name: "torchaudio", version: "2.11.0" },
    ].map((pkg) => [pkg.name, pkg]),
  );

  const merged = mergeLegacyTorchPackageSets(basePackages, cpuPackages);
  assert.deepEqual(
    Object.fromEntries(merged.map((pkg) => [pkg.name, pkg.version])),
    { numpy: "1.26.4", torch: "2.13.0", torchaudio: "2.11.0" },
  );
  assert.doesNotThrow(() => assertDefaultCpuTorchClosure(merged));
  assert.throws(
    () => assertDefaultCpuTorchClosure([...merged, { name: "nvidia-cudnn-cu12", version: "9.0.0" }]),
    /unsupported packages: nvidia-cudnn-cu12/,
  );
});

test("Flatpak legacy resolver replaces the complete Torch CUDA package family", () => {
  const basePackages = [
    { name: "cuda-bindings", version: "13.2.0" },
    { name: "cuda-pathfinder", version: "1.4.2" },
    { name: "cuda-toolkit", version: "13.0.2" },
    { name: "numpy", version: "1.26.4" },
    { name: "nvidia-cublas-cu12", version: "13.0.0.19" },
    { name: "torch", version: "2.13.0" },
  ];
  const legacyPackages = new Map(
    [
      { name: "cuda-bindings", version: "12.9.7" },
      { name: "cuda-pathfinder", version: "1.3.2" },
      { name: "cuda-toolkit", version: "12.6.3" },
      { name: "nvidia-cublas-cu12", version: "12.6.4.1" },
      { name: "torch", version: "2.13.0+cu126" },
      { name: "torchaudio", version: "2.11.0+cu126" },
      { name: "unrelated-legacy-only", version: "9.0.0" },
    ].map((pkg) => [pkg.name, pkg]),
  );

  const merged = mergeLegacyTorchPackageSets(basePackages, legacyPackages);
  const versions = Object.fromEntries(merged.map((pkg) => [pkg.name, pkg.version]));

  assert.equal(versions["cuda-bindings"], "12.9.7");
  assert.equal(versions["cuda-pathfinder"], "1.3.2");
  assert.equal(versions["cuda-toolkit"], "12.6.3");
  assert.equal(versions["nvidia-cublas-cu12"], "12.6.4.1");
  assert.equal(versions.torch, "2.13.0+cu126");
  assert.equal(versions.torchaudio, "2.11.0+cu126");
  assert.equal(versions.numpy, "1.26.4");
  assert.equal(versions["unrelated-legacy-only"], undefined);
});

test("Flatpak resolver keeps duplicate lock packages attached to their versioned dependency", () => {
  const packages = parseUvLock(`
[[package]]
name = "tuneforge-backend"
version = "1.0.0"
source = { editable = "." }
dependencies = [
    { name = "librosa" },
]

[package.optional-dependencies]
advanced-chords = [
    { name = "resolver-one" },
]
advanced-chords-onnx = [
    { name = "resolver-two" },
]

[[package]]
name = "librosa"
version = "1.0.0"
dependencies = [
    { name = "scikit-learn", version = "1.5.2", source = { registry = "https://example.invalid" }, marker = "extra == 'extra-17-tuneforge-backend-advanced-chords'" },
    { name = "scikit-learn", version = "1.9.0", source = { registry = "https://example.invalid" }, marker = "extra != 'extra-17-tuneforge-backend-advanced-chords'" },
]

[[package]]
name = "resolver-one"
version = "1.0.0"
dependencies = [
    { name = "shared-runtime", version = "1.0.0", source = { registry = "https://example.invalid" } },
]

[[package]]
name = "resolver-two"
version = "2.0.0"
dependencies = [
    { name = "shared-runtime", version = "2.0.0", source = { registry = "https://example.invalid" } },
]

[[package]]
name = "shared-runtime"
version = "1.0.0"

[[package]]
name = "shared-runtime"
version = "2.0.0"

[[package]]
name = "scikit-learn"
version = "1.5.2"

[[package]]
name = "scikit-learn"
version = "1.9.0"
`);

  const versionsFor = (extras, name) =>
    resolvePythonRuntimePackages(packages, { extras })
      .filter((pkg) => pkg.name === name)
      .map((pkg) => pkg.version);

  assert.deepEqual(versionsFor(["advanced-chords"], "shared-runtime"), ["1.0.0"]);
  assert.deepEqual(versionsFor(["advanced-chords"], "scikit-learn"), ["1.5.2"]);
  assert.deepEqual(versionsFor(["advanced-chords-onnx"], "shared-runtime"), ["2.0.0"]);
  assert.deepEqual(versionsFor(["advanced-chords-onnx"], "scikit-learn"), ["1.9.0"]);
});

test("Flatpak marker evaluation targets Python 3.14 and includes audioop-lts", () => {
  assert.equal(markerMatchesFlatpakTarget("python_version >= '3.13'"), true);
  assert.equal(markerMatchesFlatpakTarget("python_full_version < '3.14.7'"), false);
  assert.equal(markerMatchesFlatpakTarget("python_version < '3.13'"), false);
});

test("Flatpak wheel selection accepts CPython 3.14, compatible abi3, and universal wheels only", () => {
  assert.ok(wheelScore("runtime-1.0-cp314-cp314-manylinux_2_28_x86_64.whl") > 0);
  assert.ok(wheelScore("runtime-1.0-cp39-abi3-manylinux_2_28_x86_64.whl") > 0);
  assert.ok(wheelScore("runtime-1.0-py3-none-any.whl") > 0);
  assert.equal(wheelScore("runtime-1.0-cp313-cp313-manylinux_2_28_x86_64.whl"), -1);
  assert.equal(wheelScore("runtime-1.0-cp315-abi3-manylinux_2_28_x86_64.whl"), -1);
  assert.equal(wheelScore("runtime-1.0-cp314-cp314-macosx_14_0_arm64.whl"), -1);
});

test("sandbox data is Flatpak-only and does not affect dependency generation beyond defaults", () => {
  const options = parsePackageOptions(["--sandbox-data"], { platform: "linux" });

  assert.equal(options.sandboxData, true);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), [
    "--crema", "--beat-this", "--lv-chordia", "--cpu", "--nvidia", "--legacy-nvidia",
  ]);
  assert.deepEqual(backendSyncArgs(options), [
    "sync",
    "--python",
    "3.14",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
    "--extra",
    "lv-chordia",
  ]);
});
