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

test("legacy nvidia does not imply optional backends", () => {
  const options = parsePackageOptions(["--legacy-nvidia"], { platform: "linux" });

  assert.deepEqual(packageOptionsToGeneratorArgs(options), ["--legacy-nvidia"]);
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.11", "--all-groups"]);
});

test("sandbox data is Flatpak-only and does not affect dependency generation", () => {
  const options = parsePackageOptions(["--sandbox-data"], { platform: "linux" });

  assert.equal(options.sandboxData, true);
  assert.deepEqual(packageOptionsToGeneratorArgs(options), []);
  assert.deepEqual(backendSyncArgs(options), ["sync", "--python", "3.11", "--all-groups"]);
});
