import assert from "node:assert/strict";
import test from "node:test";
import {
  backendSyncArgs,
  packageOptionsToGeneratorArgs,
  parsePackageOptions,
} from "./package-options.mjs";

test("package option parser accepts feature aliases", () => {
  assert.deepEqual(
    parsePackageOptions(["--crema", "--beat-this", "--model-bundle"], { platform: "mac" }),
    {
      crema: true,
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
    beatThis: true,
    legacyNvidia: false,
    modelBundle: false,
    noBundle: false,
    sandboxData: false,
  });
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this"]);
  assert.deepEqual(backendSyncArgs(options), [
    "sync",
    "--python",
    "3.11",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
  ]);
});

test("package option parser accepts advanced dependency opt-outs", () => {
  const options = parsePackageOptions(["--no-crema", "--no-beat-this"], { platform: "linux" });

  assert.equal(options.crema, false);
  assert.equal(options.beatThis, false);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--no-crema", "--no-beat-this"]);
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.11", "--all-groups"]);
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

test("legacy nvidia includes advanced dependencies by default", () => {
  const options = parsePackageOptions(["--legacy-nvidia"], { platform: "linux" });

  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this", "--legacy-nvidia"]);
  assert.deepEqual(backendSyncArgs(options), [
    "sync",
    "--python",
    "3.11",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
  ]);
});

test("legacy nvidia supports advanced dependency opt-outs", () => {
  const options = parsePackageOptions(["--legacy-nvidia", "--no-advanced-chords", "--no-advanced-beats"], {
    platform: "linux",
  });

  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--no-crema", "--no-beat-this", "--legacy-nvidia"]);
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.11", "--all-groups"]);
});

test("sandbox data is Flatpak-only and does not affect dependency generation beyond defaults", () => {
  const options = parsePackageOptions(["--sandbox-data"], { platform: "linux" });

  assert.equal(options.sandboxData, true);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--crema", "--beat-this"]);
  assert.deepEqual(backendSyncArgs(options), [
    "sync",
    "--python",
    "3.11",
    "--all-groups",
    "--extra",
    "advanced-chords",
    "--extra",
    "advanced-beats",
  ]);
});
