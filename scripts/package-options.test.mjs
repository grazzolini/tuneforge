import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { manifestWithPackageOptions } from "./package-flatpak.mjs";
import { assertLvChordiaBundleLayout, LV_CHORDIA_CHECKPOINT_NAMES } from "./prepare-bundle.mjs";
import {
  backendSyncArgs,
  packageOptionsEnvironment,
  packageOptionsToGeneratorArgs,
  parsePackageOptions,
} from "./package-options.mjs";

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
    /mv \/app\/lib\/tuneforge\/backend\/site-packages\/share\/lv-chordia\/cache_data \/app\/lib\/tuneforge\/backend\/python\/share\/lv-chordia\/cache_data/,
  );
  const optOutManifest = manifestWithPackageOptions(
    baseManifest,
    parsePackageOptions(["--no-lv-chordia"], { platform: "linux" }),
  );
  assert.doesNotMatch(optOutManifest, /site-packages\/share\/lv-chordia\/cache_data/);
  assert.doesNotMatch(optOutManifest, /python\/share\/lv-chordia\/cache_data/);
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

test("legacy nvidia rejects the audited LV Chordia dependency stack", () => {
  assert.throws(
    () => parsePackageOptions(["--legacy-nvidia"], { platform: "linux" }),
    /requires --no-lv-chordia/,
  );
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
