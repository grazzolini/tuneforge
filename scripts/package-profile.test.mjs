import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { dmgPaths } from "./package-dmg.mjs";
import { packageProfile, PRODUCTION_PACKAGE, TEST_PACKAGE,
  testTauriOverlay, writeTestTauriOverlay } from "./package-profile.mjs";
import { formatBuildDuration, packageOptionsEnvironment, packageOptionsToGeneratorArgs, parsePackageOptions } from "./package-options.mjs";

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


test("public defaults equal explicit Test without changing helper serialization or cache inputs", () => {
  for (const platform of ["mac", "linux"]) {
    const implicit = parsePackageOptions([], { platform, defaultTestPackage: true });
    const explicit = parsePackageOptions(["--test"], { platform });
    assert.deepEqual(implicit, explicit);
    for (const options of [implicit, parsePackageOptions(["--release"], { platform })]) {
      const args = packageOptionsToGeneratorArgs(options, { explicitMode: true });
      assert.equal(parsePackageOptions(args, { platform: "linux" }).testPackage, options.testPackage);
    }
    assert.equal(packageOptionsEnvironment(implicit).TUNEFORGE_PACKAGE_OPTIONS,
      packageOptionsEnvironment(explicit).TUNEFORGE_PACKAGE_OPTIONS);
    assert.equal(parsePackageOptions(["--", "--release"], { platform, defaultTestPackage: true }).testPackage, false);
    assert.equal(parsePackageOptions([], { platform }).testPackage, false);
    assert.throws(() => parsePackageOptions(["--test", "--release"], { platform }), /Conflicting package modes/);
  }
  assert.equal(formatBuildDuration(1_230), "1.2s");
  assert.equal(formatBuildDuration(61_200), "1m 1.2s");
  assert.equal(formatBuildDuration(7_261_200), "2h 1m 1.2s");
});

test("macOS public app and DMG modes route matching identities with one build duration", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-mac-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "apps/backend"), { recursive: true });
  const tauri = path.join(root, "apps/desktop/src-tauri");
  fs.mkdirSync(tauri, { recursive: true });
  fs.copyFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), path.join(tauri, "tauri.conf.json"));
  fs.copyFileSync(new URL("../.python-version", import.meta.url), path.join(root, ".python-version"));
  for (const script of ["package-mac", "package-dmg", "package-options", "package-profile", "python-version"]) {
    fs.copyFileSync(new URL(`./${script}.mjs`, import.meta.url), path.join(root, "scripts", `${script}.mjs`));
  }
  const hook = path.join(root, "stub.mjs");
  const log = path.join(root, "commands.jsonl");
  fs.writeFileSync(hook, `
    import cp from "node:child_process";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const record = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + String.fromCharCode(10));
    cp.spawnSync = (command, args, options) => {
      record({ command, args, env: { TUNEFORGE_PACKAGE_OPTIONS: options.env.TUNEFORGE_PACKAGE_OPTIONS } });
      return { status: process.env.STUB_FAIL === "1" ? 1 : 0 };
    };
    cp.execFileSync = (command, args) => { record({ command, args }); fs.writeFileSync(args.at(-1), "synthetic dmg"); };
    syncBuiltinESMExports();
  `);
  for (const release of [false, true]) {
    const bundle = path.join(tauri, "target", ...(release ? [] : ["test-package"]), "release/bundle/macos");
    fs.mkdirSync(path.join(bundle, release ? "TuneForge.app" : "TuneForge Test.app"), { recursive: true });
    for (const [script, flags] of [["package-mac", []], ["package-mac", ["--app-only"]], ["package-dmg", []]]) {
      fs.writeFileSync(log, "");
      const result = spawnSync(process.execPath, ["--import", hook, path.join(root, "scripts", `${script}.mjs`),
        ...flags, ...(release ? ["--", "--release"] : [])], {
        cwd: root, encoding: "utf8", env: { ...process.env, STUB_LOG: log },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal((result.stdout.match(/^BUILD time:/gm) ?? []).length, 1);
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const tauriCall = calls.find(({ command }) => command === "pnpm");
      if (tauriCall) {
        assert.equal(tauriCall.args.includes("--config"), !release);
        assert.equal(JSON.parse(tauriCall.env.TUNEFORGE_PACKAGE_OPTIONS).testPackage, !release);
      }
      const disk = calls.find(({ command }) => command === "diskutil");
      assert.equal(Boolean(disk), !flags.includes("--app-only"));
      if (disk) assert.equal(path.basename(disk.args.at(-1)).startsWith("TuneForge Test_"), !release);
    }
  }
  const failed = spawnSync(process.execPath, ["--import", hook, path.join(root, "scripts/package-mac.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, STUB_LOG: log, STUB_FAIL: "1" },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /exited with status 1/);
  assert.equal((failed.stdout.match(/^BUILD time:/gm) ?? []).length, 1);
  fs.writeFileSync(log, "");
  const conflict = spawnSync(process.execPath, ["--import", hook, path.join(root, "scripts/package-mac.mjs"), "--test", "--release"], {
    cwd: root, encoding: "utf8", env: { ...process.env, STUB_LOG: log },
  });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Conflicting package modes/);
  assert.equal(fs.readFileSync(log, "utf8"), "");
});
