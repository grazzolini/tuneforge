import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { selectFlatpakStorage, prepareFlatpakStorage, planFlatpakCacheImports, flatpakIdentityHistoryPath } from "./flatpak-cache-storage.mjs";
import { createFlatpakPreflight, flatpakModuleFingerprints, predictFlatpakInvalidation } from "./flatpak-preflight.mjs";
import { flatpakSourceSnapshotInputs, generateFlatpakSourceSnapshots, resolveSourceDateEpoch } from "./flatpak-source-snapshots.mjs";
import { generateFlatpakSourceSnapshots as generatorSnapshots } from "./generate-flatpak-sources.mjs";
import { flatpakBuildEvent, flatpakBuildPhases, resolveFrontendGitRef, renderFlatpakManifest } from "./package-flatpak.mjs";
import { parsePackageOptions } from "./package-options.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hasOstree = spawnSync("ostree", ["--version"], { stdio: "ignore" }).status === 0;
function temporary(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-storage-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${result.error?.message ?? ""} ${result.stderr}`);
  return result.stdout.trim();
}
function inventory(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort().flatMap((name) => {
    const target = path.join(directory, name), stats = lstatSync(target);
    return [[target, stats.mode, stats.mtimeMs, stats.size], ...(stats.isDirectory() ? inventory(target) : [])];
  });
}
function nativeFixture(parent, name) {
  const stateRoot = path.join(parent, "state"), cacheRoot = path.join(parent, "compiler");
  const repository = path.join(stateRoot, name, "cache");
  mkdirSync(path.dirname(repository), { recursive: true });
  mkdirSync(path.join(cacheRoot, name, "pnpm"), { recursive: true });
  writeFileSync(path.join(cacheRoot, name, "pnpm", "existing"), "compiler-cache\n");
  command("ostree", [`--repo=${repository}`, "init", "--mode=bare-user-only"]);
  return { stateRoot, cacheRoot, repository };
}
function commit(repository, source, ref, contents) {
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "content"), contents);
  return command("ostree", [`--repo=${repository}`, "commit", `--branch=${ref}`, `--tree=dir=${source}`, "--subject=synthetic fixture", "--timestamp=1970-01-01T00:00:01Z"]);
}

test("storage adopts production in place, imports native TEST refs once, and preserves identity histories", { skip: !hasOstree && "OSTree is required for the native import fixture" }, (context) => {
  const directory = temporary(context);
  const production = nativeFixture(path.join(directory, "production"), "flatpak-cache-v1-1111111111111111");
  const legacy = nativeFixture(path.join(directory, "legacy-test"), "flatpak-cache-v1-2222222222222222");
  const prodRef = "fixture/com.tuneforge.desktop.generated.yml/build-pnpm";
  const testRef = "fixture/com.tuneforge.desktop.test.generated.yml/build-pnpm";
  const prodCommit = commit(production.repository, path.join(directory, "prod-tree"), prodRef, "production");
  const testCommit = commit(legacy.repository, path.join(directory, "test-tree"), testRef, "test");
  const args = { ...production, legacyTestStateRoot: legacy.stateRoot, legacyTestCacheRoot: legacy.cacheRoot };
  const storage = selectFlatpakStorage(args);
  assert.equal(storage.selection, "adopt-existing-production");
  assert.equal(storage.nativeRepo, production.repository);
  const original = inventory(path.join(directory, "legacy-test"));
  const before = inventory(directory);
  assert.equal(planFlatpakCacheImports(storage)[0].status, "pending");
  assert.deepEqual(inventory(directory), before, "planning must not write");
  const imported = prepareFlatpakStorage(storage);
  assert.deepEqual(imported, [{ status: "imported", refCount: 1 }]);
  assert.deepEqual(inventory(path.join(directory, "legacy-test")), original, "legacy TEST storage must remain untouched");
  assert.equal(command("ostree", [`--repo=${storage.nativeRepo}`, "rev-parse", prodRef]), prodCommit);
  assert.equal(command("ostree", [`--repo=${storage.nativeRepo}`, "rev-parse", testRef]), testCommit);
  assert.equal(readFileSync(path.join(storage.cacheDir, "pnpm/existing"), "utf8"), "compiler-cache\n");
  const newerTest = commit(storage.nativeRepo, path.join(directory, "new-test-tree"), testRef, "new shared TEST history");
  for (const identity of [false, true, false, true]) {
    const selected = selectFlatpakStorage(args);
    assert.equal(selected.stateDir, storage.stateDir);
    assert.equal(selected.cacheDir, storage.cacheDir);
    assert.equal(selected.selection, "persisted");
    prepareFlatpakStorage(selected);
    assert.equal(command("ostree", [`--repo=${selected.nativeRepo}`, "rev-parse", identity ? testRef : prodRef]), identity ? newerTest : prodCommit);
    assert.equal(path.basename(flatpakIdentityHistoryPath(selected, identity)), identity ? "test" : "production");
  }
  assert.equal(command("ostree", [`--repo=${legacy.repository}`, "rev-parse", testRef]), testCommit);
});

test("fresh storage planning and malformed or symlinked selectors are read-only", (context) => {
  const directory = temporary(context), stateRoot = path.join(directory, "state"), cacheRoot = path.join(directory, "cache");
  assert.equal(selectFlatpakStorage({ stateRoot, cacheRoot }).selection, "fresh");
  assert.deepEqual(readdirSync(directory), []);
  mkdirSync(stateRoot);
  const selector = path.join(stateRoot, "storage-selection-v1.json");
  writeFileSync(selector, '{"schema":"flatpak-storage-v1","name":"../escape"}');
  const before = inventory(directory);
  assert.throws(() => selectFlatpakStorage({ stateRoot, cacheRoot }), /Malformed/);
  assert.deepEqual(inventory(directory), before);
  rmSync(selector);
  symlinkSync(path.join(directory, "missing"), path.join(stateRoot, "shared"));
  assert.throws(() => selectFlatpakStorage({ stateRoot, cacheRoot }), /Symlink/);
});

test("competing legacy namespaces reserve TEST refs before either native import", { skip: !hasOstree && "OSTree is required for the native import fixture" }, (context) => {
  const directory = temporary(context);
  const production = nativeFixture(path.join(directory, "production"), "flatpak-cache-v1-1111111111111111");
  const legacyRoot = path.join(directory, "legacy-test");
  const older = nativeFixture(legacyRoot, "flatpak-cache-v1-2222222222222222");
  const newer = nativeFixture(legacyRoot, "flatpak-cache-v1-3333333333333333");
  const ref = "fixture/com.tuneforge.desktop.test.generated.yml/build-pnpm";
  commit(older.repository, path.join(directory, "old-tree"), ref, "older namespace history");
  const newerCommit = commit(newer.repository, path.join(directory, "new-tree"), ref, "preferred namespace history");
  utimesSync(path.join(older.repository, "config"), 1, 1);
  utimesSync(path.join(newer.repository, "config"), 2, 2);
  const args = { ...production, legacyTestStateRoot: older.stateRoot, legacyTestCacheRoot: older.cacheRoot };
  const storage = selectFlatpakStorage(args);
  assert.deepEqual(storage.legacyTestRepositories, [newer.repository, older.repository]);
  const original = inventory(legacyRoot);
  const plan = planFlatpakCacheImports(storage);
  assert.deepEqual(plan.map(({ refs }) => refs), [[ref], []]);
  assert.deepEqual(inventory(legacyRoot), original);
  assert.deepEqual(prepareFlatpakStorage(storage), [{ status: "imported", refCount: 1 }, { status: "no-missing-refs", refCount: 0 }]);
  assert.equal(command("ostree", [`--repo=${storage.nativeRepo}`, "rev-parse", ref]), newerCommit);
  const sharedCommit = commit(storage.nativeRepo, path.join(directory, "shared-tree"), ref, "newer shared history");
  prepareFlatpakStorage(selectFlatpakStorage(args));
  assert.equal(command("ostree", [`--repo=${storage.nativeRepo}`, "rev-parse", ref]), sharedCommit);
  assert.deepEqual(inventory(legacyRoot), original);
});

test("dependency extra transitions invalidate Python before applications and reserve the transition budget", (context) => {
  const directory = temporary(context);
  const storage = { selection: "persisted", stateDir: path.join(directory, "state"), cacheDir: path.join(directory, "cache"),
    nativeRepo: path.join(directory, "state/native"), importedRepositories: [], legacyTestRepositories: [] };
  const historyPath = path.join(directory, "input-history.json");
  const fingerprints = (options) => flatpakModuleFingerprints({ root: directory,
    manifest: renderFlatpakManifest(options, "/cache", "stable", "frontend-ref"), sourceDateEpoch: "1", frontendGitRef: "frontend-ref",
    buildInfo: {}, dependencyOptions: { crema: options.crema, beatThis: options.beatThis, lvChordia: options.lvChordia } });
  for (const [disabled, enabled] of [["--no-beat-this", "--beat-this"], ["--no-crema", "--crema"], ["--no-lv-chordia", "--lv-chordia"]]) {
    const before = parsePackageOptions(["--cpu", disabled], { platform: "linux" });
    const after = parsePackageOptions(["--cpu", enabled], { platform: "linux" });
    for (const [baseline, target] of [[before, after], [after, before]]) {
      writeFileSync(historyPath, JSON.stringify({ schema: "flatpak-input-history-v1", modules: fingerprints(baseline) }));
      const preflight = createFlatpakPreflight({ storage, historyPath, modules: fingerprints(target), identity: "production",
        selectedProfiles: target.flatpakProfiles, sourceDateEpoch: "1", outputs: [path.join(directory, "output")] });
      assert.equal(preflight.invalidation.firstChangedModule, "python-runtime-deps", `${disabled} / ${enabled}`);
      assert.ok(preflight.invalidation.changedModules.includes("python-runtime-deps"));
      assert.equal(preflight.disk.requiredAvailableBytes, 35 * 1024 ** 3);
    }
  }
  const defaults = parsePackageOptions(["--cpu"], { platform: "linux" });
  writeFileSync(historyPath, JSON.stringify({ schema: "flatpak-input-history-v1", modules: fingerprints(defaults) }));
  const noBundle = parsePackageOptions(["--cpu", "--no-bundle"], { platform: "linux" });
  const unchanged = createFlatpakPreflight({ storage, historyPath, modules: fingerprints(noBundle), identity: "production",
    selectedProfiles: noBundle.flatpakProfiles, sourceDateEpoch: "1", outputs: [path.join(directory, "output")] });
  assert.equal(unchanged.invalidation.status, "inputs-unchanged");
  assert.equal(unchanged.disk.requiredAvailableBytes, 20 * 1024 ** 3);
});

test("preflight does not create roots, acquire locks, generate sources, or invoke mutating tools", (context) => {
  const directory = temporary(context), fixture = path.join(directory, "checkout");
  mkdirSync(fixture);
  cpSync(path.join(root, "scripts"), path.join(fixture, "scripts"), { recursive: true });
  for (const file of ["packaging/flatpak/com.tuneforge.desktop.yml", "apps/desktop/src-tauri/tauri.conf.json", "apps/backend/app/storage-profile.json"]) {
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(fixture, file));
  }
  const bins = path.join(directory, "bin");
  mkdirSync(bins);
  for (const name of ["flock", "flatpak", "flatpak-builder", "ostree"]) {
    writeFileSync(path.join(bins, name), '#!/bin/sh\necho "Unexpected mutating tool" >&2\nexit 99\n', { mode: 0o755 });
  }
  const before = inventory(fixture);
  const result = spawnSync(process.execPath, [path.join(fixture, "scripts/package-flatpak.mjs"), "--preflight", "--test", "--cpu", "--nvidia", "--legacy-nvidia", "--no-bundle"], {
    cwd: fixture, encoding: "utf8", env: { ...process.env, PATH: `${bins}:${process.env.PATH}`, SOURCE_DATE_EPOCH: "123",
      FLATPAK_STATE_DIR: path.join(fixture, "new-state"), FLATPAK_CACHE_DIR: path.join(fixture, "new-cache") },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.sourceDateEpoch, "123");
  assert.equal(preflight.storage.selection, "fresh");
  assert.deepEqual(preflight.selectedProfiles, ["cpu", "nvidia", "legacy-nvidia"]);
  assert.equal(preflight.disk.requiredAvailableBytes, 44 * 1024 ** 3);
  assert.equal(preflight.disk.reserveBytes, 5 * 1024 ** 3);
  assert.deepEqual(inventory(fixture), before);
});

test("direct-input history isolates frontend/backend changes and whole-checkout provenance", (context) => {
  const directory = temporary(context);
  for (const file of ["package.json", "apps/desktop/src/synthetic.ts", "apps/backend/app/synthetic.py", "apps/backend/app/storage-profile.json"]) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), "fixture");
  }
  const options = parsePackageOptions(["--cpu", "--nvidia", "--legacy-nvidia", "--no-bundle"], { platform: "linux" });
  const manifest = renderFlatpakManifest(options, "/shared-cache", "stable", "scoped-ref");
  const buildInfo = { frontend: { package_version: "1.0.0", git_ref: "scoped-ref" }, backend: { package_version: "1.0.0", git_ref: "checkout-dirty" } };
  const current = () => flatpakModuleFingerprints({ root: directory, manifest, sourceDateEpoch: "1", frontendGitRef: "scoped-ref", buildInfo });
  const baseline = current(), history = { schema: "flatpak-input-history-v1", modules: baseline };
  assert.equal(predictFlatpakInvalidation(history, current()).status, "inputs-unchanged");
  buildInfo.backend.git_ref = "committed-checkout";
  assert.deepEqual(predictFlatpakInvalidation(history, current()).changedModules, ["tuneforge-build-info"]);
  buildInfo.backend.git_ref = "checkout-dirty";
  writeFileSync(path.join(directory, "apps/backend/app/synthetic.py"), "backend change");
  assert.equal(predictFlatpakInvalidation(history, current()).firstChangedModule, "tuneforge-backend");
  writeFileSync(path.join(directory, "apps/backend/app/synthetic.py"), "fixture");
  writeFileSync(path.join(directory, "apps/desktop/src/synthetic.ts"), "frontend change");
  assert.equal(predictFlatpakInvalidation(history, current()).firstChangedModule, "tuneforge-frontend");
  assert.ok(baseline.findIndex(({ name }) => name === "python-runtime-deps") < baseline.findIndex(({ name }) => name === "tuneforge-frontend"));
  assert.ok(baseline.findIndex(({ name }) => name === "tuneforge-frontend") < baseline.findIndex(({ name }) => name === "tuneforge-desktop"));
  const storage = selectFlatpakStorage({ stateRoot: path.join(directory, "state"), cacheRoot: path.join(directory, "cache") });
  const before = inventory(directory);
  const probe = createFlatpakPreflight({ storage, historyPath: path.join(directory, "broken-history.json"), modules: baseline,
    identity: "production", selectedProfiles: options.flatpakProfiles, sourceDateEpoch: "1", outputs: [path.join(directory, "outputs")] });
  assert.equal(probe.invalidation.status, "no-input-history");
  assert.deepEqual(inventory(directory), before);
});

test("packaging-only commit preserves scoped frontend inputs and stable snapshot epoch", (context) => {
  const directory = temporary(context);
  command("git", ["init", "--quiet", directory]);
  for (const [key, value] of [["user.name", "fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgsign", "false"]]) command("git", ["-C", directory, "config", key, value]);
  writeFileSync(path.join(directory, "frontend"), "unchanged bytes");
  writeFileSync(path.join(directory, "packaging"), "old");
  command("git", ["-C", directory, "add", "."]);
  command("git", ["-C", directory, "commit", "--quiet", "-m", "fixture"]);
  const previous = resolveFrontendGitRef({ root: directory, inputPaths: ["frontend"] });
  writeFileSync(path.join(directory, "packaging"), "new");
  command("git", ["-C", directory, "add", "packaging"]);
  command("git", ["-C", directory, "commit", "--quiet", "-m", "packaging change"]);
  assert.equal(resolveFrontendGitRef({ root: directory, inputPaths: ["frontend"] }), previous);
  assert.equal(resolveSourceDateEpoch({ root: directory, override: undefined }), "1");
});

test("both snapshot producers share complete canonical desktop and backend JSON policy", (context) => {
  const directory = temporary(context);
  generateFlatpakSourceSnapshots({ root, generatedRoot: path.join(directory, "canonical"), sourceDateEpoch: "1" });
  generatorSnapshots({ root, generatedRoot: path.join(directory, "generator"), sourceDateEpoch: "1" });
  for (const name of ["frontend", "desktop", "backend"]) assert.deepEqual(readFileSync(path.join(directory, "canonical", `${name}-snapshot.tar`)), readFileSync(path.join(directory, "generator", `${name}-snapshot.tar`)));
  assert.equal(flatpakSourceSnapshotInputs.desktop.filter((entry) => entry === "apps/backend/app/storage-profile.json").length, 1);
  assert.equal(flatpakSourceSnapshotInputs.desktop.filter((entry) => entry === "apps/desktop/src-tauri/native/whisper-rs-sys").length, 1);
  const desktop = readFileSync(path.join(directory, "canonical", "desktop-snapshot.tar"));
  assert.ok(desktop.includes(Buffer.from("apps/backend/app/storage-profile.json")));
  const backend = readFileSync(path.join(directory, "canonical", "backend-snapshot.tar"));
  assert.ok(backend.includes(Buffer.from("apps/backend/app/storage-profile.json")));
});

test("phase observations separate module work from extension exports", () => {
  assert.equal(flatpakBuildEvent("noise Exporting untrusted to repo"), null);
  const events = [
    { ...flatpakBuildEvent("Cache hit for pnpm, skipping build"), seconds: 1 },
    { ...flatpakBuildEvent("Building module tuneforge-build-info in /run/build/info"), seconds: 2 },
    { ...flatpakBuildEvent("Exporting com.tuneforge.desktop to repo"), seconds: 3 },
    { ...flatpakBuildEvent("Exporting com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime to repo"), seconds: 5 },
  ];
  assert.deepEqual(flatpakBuildPhases(events, 9).map(({ phase, durationSeconds }) => [phase, durationSeconds]), [["module", 1], ["module", 1], ["export", 2], ["export", 4]]);
});
