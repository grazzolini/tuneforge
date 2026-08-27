import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeLegacyTorchPackageSets } from "./generate-flatpak-sources.mjs";
import { manifestWithPackageOptions } from "./package-flatpak.mjs";
import { assertLvChordiaBundleLayout, LV_CHORDIA_CHECKPOINT_NAMES } from "./prepare-bundle.mjs";
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
    manifest.indexOf("  - name: pnpm"),
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
      crema: true,
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
      crema: true,
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
    crema: true,
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
    "3.11",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
    "--extra",
    "lv-chordia",
  ]);
});

test("release default package options do not bundle model weights", () => {
  for (const platform of ["mac", "linux"]) {
    const options = parsePackageOptions([], { platform });

    assert.equal(options.modelBundle, false);
    assert.equal(packageOptionsToGeneratorArgs(options).includes("--model-bundle"), false);
  }
});

test("package option parser accepts advanced dependency opt-outs", () => {
  const options = parsePackageOptions(["--no-crema", "--no-beat-this", "--no-lv-chordia"], { platform: "linux" });

  assert.equal(options.crema, false);
  assert.equal(options.beatThis, false);
  assert.equal(options.lvChordia, false);
  assert.equal(JSON.parse(packageOptionsEnvironment(options).TUNEFORGE_PACKAGE_OPTIONS).beatThis, false);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--no-crema", "--no-beat-this", "--no-lv-chordia"]);
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.11", "--all-groups"]);
});

test("Flatpak package options are scoped to the TuneForge module build environment", () => {
  const baseManifest = readFileSync(
    new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
    "utf8",
  );
  const options = parsePackageOptions(["--no-beat-this"], { platform: "linux" });
  const manifest = manifestWithPackageOptions(baseManifest, options);
  const cpythonModule = manifest.slice(
    manifest.indexOf("  - name: cpython-3.11"),
    manifest.indexOf("  - name: python-runtime-deps"),
  );
  const tuneforgeModule = manifest.slice(manifest.indexOf("  - name: tuneforge"));

  assert.equal(cpythonModule.includes("TUNEFORGE_PACKAGE_OPTIONS"), false);
  assert.equal((tuneforgeModule.match(/\n    build-options:/g) ?? []).length, 1);
  assert.equal((manifest.match(/TUNEFORGE_PACKAGE_OPTIONS:/g) ?? []).length, 1);
  assert.match(
    tuneforgeModule,
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
    manifestWithPackageOptions(
      baseManifest,
      parsePackageOptions(["--legacy-nvidia"], { platform: "linux" }),
    ),
    manifestWithPackageOptions(
      baseManifest,
      parsePackageOptions(["--legacy-nvidia", "--no-lv-chordia"], { platform: "linux" }),
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
    "3.11",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
    "--extra",
    "lv-chordia",
  ]);
});

test("Flatpak legacy resolver requests matched Torch 2.11 CUDA 12.6 wheels", () => {
  const generator = readFileSync(new URL("./generate-flatpak-sources.mjs", import.meta.url), "utf8");

  assert.match(generator, /"torch==2\.11\.0\\ntorchaudio==2\.11\.0\\n"/);
  assert.match(generator, /"--torch-backend",\n\s+"cu126"/);
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
      { name: "torch", version: "2.11.0+cu126" },
      { name: "unrelated-legacy-only", version: "9.0.0" },
    ].map((pkg) => [pkg.name, pkg]),
  );

  const merged = mergeLegacyTorchPackageSets(basePackages, legacyPackages);
  const versions = Object.fromEntries(merged.map((pkg) => [pkg.name, pkg.version]));

  assert.equal(versions["cuda-bindings"], "12.9.7");
  assert.equal(versions["cuda-pathfinder"], "1.3.2");
  assert.equal(versions["cuda-toolkit"], "12.6.3");
  assert.equal(versions["nvidia-cublas-cu12"], "12.6.4.1");
  assert.equal(versions.torch, "2.11.0+cu126");
  assert.equal(versions.numpy, "1.26.4");
  assert.equal(versions["unrelated-legacy-only"], undefined);
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
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.11", "--all-groups"]);
});

test("sandbox data is Flatpak-only and does not affect dependency generation beyond defaults", () => {
  const options = parsePackageOptions(["--sandbox-data"], { platform: "linux" });

  assert.equal(options.sandboxData, true);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this", "--lv-chordia"]);
  assert.deepEqual(backendSyncArgs(options), [
    "sync",
    "--python",
    "3.11",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
    "--extra",
    "lv-chordia",
  ]);
});
