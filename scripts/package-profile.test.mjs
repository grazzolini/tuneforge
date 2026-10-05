import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dmgPaths } from "./package-dmg.mjs";
import { packageProfile, PRODUCTION_PACKAGE, TEST_PACKAGE,
  testTauriOverlay, writeTestTauriOverlay } from "./package-profile.mjs";
import { packageOptionsToGeneratorArgs, parsePackageOptions } from "./package-options.mjs";

test("test profile keeps macOS bundle, binary, window, and DMG identities together", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-test-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const overlay = testTauriOverlay();
  const saved = writeTestTauriOverlay(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, "utf8")), overlay);
  assert.equal(overlay.identifier, TEST_PACKAGE.id);
  assert.equal(overlay.productName, TEST_PACKAGE.name);
  assert.equal(overlay.mainBinaryName, TEST_PACKAGE.binary);
  assert.equal(overlay.app.windows[0].title, TEST_PACKAGE.name);
  assert.ok(overlay.bundle.icon.every((icon) => icon.startsWith("icons/test/")));
  assert.equal(path.basename(dmgPaths(true).source), `${TEST_PACKAGE.name}.app`);
  assert.match(path.basename(dmgPaths(true).output), /^TuneForge Test_.*\.dmg$/);
  assert.equal(packageProfile(false), PRODUCTION_PACKAGE);
  assert.equal(packageProfile(true), TEST_PACKAGE);
  assert.equal(path.basename(dmgPaths(false).source), `${PRODUCTION_PACKAGE.name}.app`);
});

test("package --test selects the same profile through Flatpak source generation", () => {
  const mac = parsePackageOptions(["--test"], { platform: "mac" });
  const linux = parsePackageOptions(["--test", "--cpu"], { platform: "linux" });
  assert.equal(mac.testPackage, true);
  assert.equal(linux.testPackage, true);
  assert.equal(parsePackageOptions([], { platform: "mac" }).testPackage, false);
  assert.ok(packageOptionsToGeneratorArgs(linux).includes("--test"));
});
