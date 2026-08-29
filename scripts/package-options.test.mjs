import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDefaultCpuTorchClosure,
  markerMatchesFlatpakTarget,
  mergeLegacyTorchPackageSets,
  parseUvLock,
  resolvePythonRuntimePackages,
  wheelScore,
} from "./generate-flatpak-sources.mjs";
import { manifestWithPackageOptions } from "./package-flatpak.mjs";
import {
  assertCremaOnnxBundleLayout,
  assertLvChordiaBundleLayout,
  CREMA_ONNX_BUNDLE_RELATIVE_PATHS,
  LV_CHORDIA_CHECKPOINT_NAMES,
} from "./prepare-bundle.mjs";
import {
  backendSyncArgs,
  packageOptionsEnvironment,
  packageOptionsToGeneratorArgs,
  parsePackageOptions,
} from "./package-options.mjs";

const flatpakPipTmpDir = "/run/build/python-runtime-deps/.pip-tmp";

function pythonRuntimeDepsModule(manifest) {
  return manifest.slice(
    manifest.indexOf("  - name: python-runtime-deps"),
    manifest.indexOf("  - name: pulseaudio-client-tools"),
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
      legacyNvidia: false,
      modelBundle: true,
      noBundle: false,
      sandboxData: false,
    },
  );
  assert.deepEqual(
    parsePackageOptions(["--advanced-chords", "--advanced-beats"], { platform: "linux" }),
    {
      crema: "onnx",
      lvChordia: true,
      beatThis: true,
      legacyNvidia: false,
      modelBundle: false,
      noBundle: false,
      sandboxData: false,
    },
  );
});

test("package option parser includes advanced dependencies by default", () => {
  const options = parsePackageOptions([], { platform: "mac" });

  assert.deepEqual(options, {
    crema: "onnx",
    lvChordia: true,
    beatThis: true,
    legacyNvidia: false,
    modelBundle: false,
    noBundle: false,
    sandboxData: false,
  });
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this", "--lv-chordia"]);
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
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--no-crema", "--no-beat-this", "--no-lv-chordia"]);
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
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this", "--lv-chordia"]);
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
  assert.doesNotMatch(optOutManifest, /pip install .*--no-deps/);
  assert.match(
    optOutManifest,
    /pip install --no-index --no-build-isolation .* -r python-requirements\.txt/,
  );
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

test("package option parser rejects platform-specific options", () => {
  assert.throws(
    () => parsePackageOptions(["--legacy-nvidia"], { platform: "mac" }),
    /only supported for Linux/,
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

test("legacy nvidia includes LV Chordia by default", () => {
  const options = parsePackageOptions(["--legacy-nvidia"], { platform: "linux" });

  assert.deepEqual(
    packageOptionsToGeneratorArgs(options),
    ["--crema", "--beat-this", "--lv-chordia", "--legacy-nvidia"],
  );
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

test("Flatpak resolves official CPU Torch by default and preserves the legacy CUDA 12.6 resolver", () => {
  const generator = readFileSync(new URL("./generate-flatpak-sources.mjs", import.meta.url), "utf8");

  assert.match(generator, /"torch==2\.13\.0\\ntorchaudio==2\.11\.0\\n"/);
  assert.match(generator, /"--python-version",\n\s+"3\.14"/);
  assert.match(generator, /"--torch-backend",\n\s+"cpu"/);
  assert.match(generator, /"--torch-backend",\n\s+"cu126"/);
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

test("legacy nvidia supports advanced dependency opt-outs", () => {
  const options = parsePackageOptions(
    ["--legacy-nvidia", "--no-advanced-chords", "--no-advanced-beats", "--no-lv-chordia"],
    { platform: "linux" },
  );

  assert.deepEqual(
    packageOptionsToGeneratorArgs(options),
    ["--no-crema", "--no-beat-this", "--no-lv-chordia", "--legacy-nvidia"],
  );
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.14", "--all-groups"]);
});

test("sandbox data is Flatpak-only and does not affect dependency generation beyond defaults", () => {
  const options = parsePackageOptions(["--sandbox-data"], { platform: "linux" });

  assert.equal(options.sandboxData, true);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this", "--lv-chordia"]);
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
