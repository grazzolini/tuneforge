import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import {
  cacheNamespace,
  buildFlatpakBundles,
  cleanupFlatpakBundleOutputs,
  compareCacheReports,
  compareCrossProfileCacheReports,
  defaultFlatpakBundleConcurrency,
  digestBuildPayload,
  enforceFlatpakBundleSize,
  flatpakArtifactSizeReport,
  flatpakBundlePlan,
  flatpakBundleStatePath,
  flatpakBundleSizeReportFromCheckout,
  flatpakBundleWorkerLimit,
  flatpakOutputStatePath,
  flatpakSizeReport,
  frontendModuleInputPaths,
  manifestWithPackageOptions,
  isValidPnpmCacheReport,
  normalizeGeneratedModelBundleManifest,
  parseSccacheStats,
  reconcileFlatpakOutputRefs,
  resolveCacheRoots,
  resolveFrontendGitRef,
  resolveSourceDateEpoch,
  selectedFlatpakOutputRefs,
  verifyFlatpakOutputRefs,
  readFlatpakOutputState,
  reuseFlatpakBundles,
  selectPreservedFlatpakOutputState,
  validateFlatpakOutputState,
  writeFlatpakOutputState,
  writeFlatpakChecksums,
  withFreshFlatpakBundleOutputs,
  expectedFlatpakModuleOrder,
  parseFlatpakModuleCacheOutput,
} from "./package-flatpak.mjs";
import { parsePackageOptions } from "./package-options.mjs";
import { compareUtf8, createFlatpakSourceSnapshot, flatpakSourceSnapshotInputs } from "./flatpak-source-snapshots.mjs";

const manifest = readFileSync(
  new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
  "utf8",
);
const packageScript = readFileSync(new URL("./package-flatpak.mjs", import.meta.url), "utf8");

function runGit(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function moduleSource(name, nextName) {
  const start = manifest.indexOf(`  - name: ${name}`);
  const end = nextName ? manifest.indexOf(`  - name: ${nextName}`, start) : manifest.length;
  assert.ok(start >= 0 && end > start, `missing module ${name}`);
  return manifest.slice(start, end);
}

function cacheReportFixture({ profiles = ["cpu"], statuses = "executed", outputMode } = {}) {
  const options = parsePackageOptions(profiles.map((profile) => `--${profile}`), { platform: "linux" });
  const namespace = cacheNamespace(options);
  const names = expectedFlatpakModuleOrder(manifestWithPackageOptions(manifest, options));
  const modules = names.map((name, index) => ({
    name,
    status: typeof statuses === "function" ? statuses(name, index) : statuses,
  }));
  const firstInvalidatedModule = modules.find(({ status }) => status === "executed")?.name ?? null;
  return {
    schema: "flatpak-cache-v1",
    namespace: namespace.name,
    namespaceInputs: namespace.inputs,
    selectedProfiles: options.flatpakProfiles,
    payload: { sha256: "c".repeat(64), entryCount: 4 },
    refCommits: selectedFlatpakOutputRefs(options.flatpakProfiles).map(({ id, ref }, index) => ({
      id, ref, commitSha256: String(index).padStart(64, "a"),
    })),
    errors: [],
    moduleCache: { mode: "enabled", observationComplete: true, firstInvalidatedModule, modules },
    output: {
      mode: outputMode ?? (statuses === "cached" ? "preserved-unchanged" : "exported"),
      observationComplete: true,
      payloadObservationSource: statuses === "cached" ? "output-state" : "checkout",
    },
  };
}

function checkoutSizeFixture() {
  return {
    schema: "flatpak-size-v1",
    unit: "bytes",
    compressedBundle: { path: "Tuneforge.flatpak", available: false },
    installedApp: { path: "/app", available: true, bytes: 10, topLevelDirectories: [{ path: "/app/lib", bytes: 10 }] },
    pythonRuntime: { path: "/app/lib/tuneforge/backend/python", available: true, bytes: 4 },
    sitePackages: { path: "/app/lib/tuneforge/backend/site-packages", available: true, bytes: 6 },
    wheelInputs: { knownBytes: 0, unknownCount: 0, complete: true, entries: [] },
    sourceArchives: { knownBytes: 0, unknownCount: 0, complete: true, entries: [] },
  };
}

function outputStateFixture({ profiles = ["cpu"], payload = { sha256: "c".repeat(64), entryCount: 4 } } = {}) {
  const report = cacheReportFixture({ profiles });
  return {
    namespace: report.namespace,
    namespaceInputs: report.namespaceInputs,
    selectedProfiles: report.selectedProfiles,
    payload,
    refCommits: report.refCommits,
    checkoutSize: checkoutSizeFixture(),
  };
}

test("Flatpak cache namespace shares profiles but keeps non-profile invalidation dimensions", () => {
  const defaults = parsePackageOptions([], { platform: "linux" });
  const first = cacheNamespace(defaults, "1.3.0");
  const second = cacheNamespace(defaults, "1.3.0");
  const optOut = cacheNamespace(
    parsePackageOptions(["--no-beat-this"], { platform: "linux" }),
    "1.3.0",
  );

  assert.deepEqual(first, second);
  assert.notEqual(first.name, optOut.name);
  assert.notEqual(first.name, cacheNamespace(defaults, "1.3.1").name);
  assert.match(first.name, /^flatpak-cache-v1-[a-f0-9]{16}$/);
  assert.equal(first.inputs.arch, "x86_64");
  assert.match(first.inputs.runtime, /org\.gnome\.Platform\/50/);
  assert.match(first.inputs.tools, /pnpm11\.22\.0-sccache0\.17\.0/);
  const explicitAll = parsePackageOptions(["--legacy-nvidia", "--cpu", "--nvidia"], { platform: "linux" });
  const noBundle = parsePackageOptions(["--no-bundle"], { platform: "linux" });
  assert.equal(cacheNamespace(explicitAll, "1.3.0").name, first.name);
  assert.equal(cacheNamespace(noBundle, "1.3.0").name, first.name);
  assert.equal(
    cacheNamespace(parsePackageOptions(["--cpu"], { platform: "linux" }), "1.3.0").name,
    cacheNamespace(parsePackageOptions(["--nvidia"], { platform: "linux" }), "1.3.0").name,
  );
  assert.equal(Object.hasOwn(first.inputs, "selectedProfiles"), false);
  assert.equal(Object.hasOwn(first.inputs.packageOptions, "flatpakProfiles"), false);
});

test("Flatpak state and cache roots reject force-clean overlap and unsafe roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-roots-"));
  const output = path.join(root, "build-dir");
  const valid = resolveCacheRoots({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
    outputRoots: [output],
  });
  assert.equal(valid.stateRoot, path.join(root, "state"));
  assert.throws(
    () => resolveCacheRoots({ stateRoot: output, cacheRoot: path.join(root, "cache"), outputRoots: [output] }),
    /Unsafe Flatpak stateRoot/,
  );
  assert.throws(
    () => resolveCacheRoots({ stateRoot: path.join(root, "same"), cacheRoot: path.join(root, "same", "cache"), outputRoots: [output] }),
    /must not overlap/,
  );
  assert.throws(
    () => resolveCacheRoots({ stateRoot: path.parse(root).root, cacheRoot: path.join(root, "cache"), outputRoots: [output] }),
    /Unsafe Flatpak stateRoot/,
  );
});

test("source date epoch is validated, stable, and passed to Flatpak builder", () => {
  assert.equal(resolveSourceDateEpoch({ override: "123" }), "123");
  assert.throws(() => resolveSourceDateEpoch({ override: "0" }), /SOURCE_DATE_EPOCH/);
  assert.equal(resolveSourceDateEpoch({ root: mkdtempSync(path.join(os.tmpdir(), "tuneforge-no-git-")), override: undefined }), "1");
  assert.match(packageScript, /--override-source-date-epoch=\$\{sourceDateEpoch\}/);
});

test("Flatpak packaging uses a per-invocation flock handshake", () => {
  assert.match(packageScript, /flock", \["--verbose", lockPath/);
  assert.match(packageScript, /Waiting for Flatpak packaging lock/);
  assert.match(packageScript, /--flatpak-lock-token=\$\{token\}/);
  assert.doesNotMatch(packageScript, /TUNEFORGE_FLATPAK_LOCK_HELD/);
});

test("generated model bundle manifest gets the source date epoch", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-model-manifest-"));
  const manifestPath = path.join(root, "model-bundle-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({ prepared_at: "2026-08-29T18:21:39.773Z", files: [] })}\n`);
  assert.equal(normalizeGeneratedModelBundleManifest({ filePath: manifestPath, sourceDateEpoch: "123" }), true);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).prepared_at, "1970-01-01T00:02:03.000Z");
});

test("frontend ref dirtiness is limited to exact frontend module inputs and supports override", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-ref-"));
  runGit(root, "init", "--quiet");
  runGit(root, "config", "user.email", "test@example.invalid");
  runGit(root, "config", "user.name", "TuneForge test");
  runGit(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "frontend.txt"), "frontend\n");
  writeFileSync(path.join(root, "backend.txt"), "backend\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "--quiet", "-m", "fixture");
  assert.equal(resolveSourceDateEpoch({ root }), runGit(root, "log", "-1", "--format=%ct", "HEAD"));
  const clean = resolveFrontendGitRef({ root, inputPaths: ["frontend.txt"] });

  writeFileSync(path.join(root, "backend.txt"), "backend dirty\n");
  assert.equal(resolveFrontendGitRef({ root, inputPaths: ["frontend.txt"] }), clean);
  runGit(root, "add", "backend.txt");
  runGit(root, "commit", "--quiet", "-m", "backend only");
  assert.equal(resolveFrontendGitRef({ root, inputPaths: ["frontend.txt"] }), clean);
  writeFileSync(path.join(root, "frontend.txt"), "frontend dirty\n");
  assert.equal(resolveFrontendGitRef({ root, inputPaths: ["frontend.txt"] }), `${clean}-dirty`);
  runGit(root, "add", "frontend.txt");
  runGit(root, "commit", "--quiet", "-m", "frontend change");
  assert.notEqual(resolveFrontendGitRef({ root, inputPaths: ["frontend.txt"] }), clean);
  assert.equal(resolveFrontendGitRef({ root, override: "release-ref", inputPaths: [] }), "release-ref");
  assert.deepEqual(frontendModuleInputPaths.slice(0, 3), ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
});

test("Flatpak modules split frontend, Rust, and backend source boundaries", () => {
  assert.deepEqual(
    [...manifest.matchAll(/^  - name: (.+)$/gm)].map((match) => match[1]),
    [
      "pnpm",
      "node-sources",
      "tuneforge-frontend",
      "sccache",
      "tuneforge-desktop",
      "cpython-3.14",
      "python-runtime-deps",
      "nvidia-torch-core-extension",
      "nvidia-torch-runtime-extension",
      "legacy-nvidia-torch-core-extension",
      "legacy-nvidia-torch-runtime-extension",
      "pulseaudio-client-tools",
      "tuneforge-backend",
    ],
  );
  const frontend = moduleSource("tuneforge-frontend", "sccache");
  const desktop = moduleSource("tuneforge-desktop", "cpython-3.14");
  const backend = moduleSource("tuneforge-backend");
  assert.match(frontend, /generated\/frontend-snapshot\.tar/);
  assert.match(frontend, /frontend-version\.json/);
  assert.doesNotMatch(frontend, /apps\/backend|src-tauri\/Cargo/);
  assert.match(desktop, /frontend-dist\/. apps\/desktop\/dist/);
  assert.match(desktop, /RUSTC_WRAPPER: \/app\/bin\/sccache/);
  assert.match(desktop, /generated\/desktop-snapshot\.tar/);
  assert.doesNotMatch(desktop, /apps\/backend|apps\/desktop\/src$/m);
  assert.match(backend, /generated\/backend-snapshot\.tar/);
  assert.doesNotMatch(backend, /cargo-sources|seed-pnpm-store|vite\.config/);
  assert.match(manifest, /sccache-v0\.17\.0-x86_64-unknown-linux-musl\.tar\.gz/);
  assert.match(manifest, /67c4a96dd237c1f518f6b36083f270f9976d516f1e57fce891755ea782e50006/);
  assert.match(backend, /rm -rf .*\/app\/bin\/sccache/);
});

test("source snapshots are deterministic and preserve files, modes, empty directories, and links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-source-snapshot-"));
  const first = path.join(root, "first.tar");
  const second = path.join(root, "second.tar");
  try {
    mkdirSync(path.join(root, "input", "empty"), { recursive: true });
    writeFileSync(path.join(root, "input", "a"), "one");
    writeFileSync(path.join(root, "input", "b"), "two");
    chmodSync(path.join(root, "input", "a"), 0o755);
    symlinkSync("a", path.join(root, "input", "link"));
    createFlatpakSourceSnapshot({ root, outputPath: first, inputs: [{ source: "input" }], sourceDateEpoch: "123" });
    utimesSync(path.join(root, "input", "a"), new Date(1), new Date(2));
    createFlatpakSourceSnapshot({ root, outputPath: second, inputs: [{ source: "input" }], sourceDateEpoch: "123" });
    assert.deepEqual(readFileSync(second), readFileSync(first));
    writeFileSync(path.join(root, "input", "a"), "changed");
    createFlatpakSourceSnapshot({ root, outputPath: second, inputs: [{ source: "input" }], sourceDateEpoch: "123" });
    assert.notDeepEqual(readFileSync(second), readFileSync(first));
    writeFileSync(path.join(root, "input", "a"), "one");
    chmodSync(path.join(root, "input", "a"), 0o644);
    createFlatpakSourceSnapshot({ root, outputPath: second, inputs: [{ source: "input" }], sourceDateEpoch: "123" });
    assert.notDeepEqual(readFileSync(second), readFileSync(first));
    chmodSync(path.join(root, "input", "a"), 0o755);
    rmSync(path.join(root, "input", "link"));
    symlinkSync("b", path.join(root, "input", "link"));
    createFlatpakSourceSnapshot({ root, outputPath: second, inputs: [{ source: "input" }], sourceDateEpoch: "123" });
    assert.notDeepEqual(readFileSync(second), readFileSync(first));
    const archive = readFileSync(first);
    const members = [];
    for (let offset = 0; offset < archive.length - 1024;) {
      const name = archive.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/, "");
      const size = Number.parseInt(archive.subarray(offset + 124, offset + 136).toString("utf8"), 8);
      if (!name) break;
      members.push({ name, mode: archive.subarray(offset + 100, offset + 108).toString("utf8"), type: String.fromCharCode(archive[offset + 156]), link: archive.subarray(offset + 157, offset + 257).toString("utf8").replace(/\0.*$/, "") });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepEqual(members.map(({ name }) => name), ["input/", "input/a", "input/b", "input/empty/", "input/link"]);
    assert.match(members.find(({ name }) => name === "input/a").mode, /^0000755/);
    assert.deepEqual(members.find(({ name }) => name === "input/link"), { name: "input/link", mode: "0000777\u0000", type: "2", link: "a" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source snapshots use byte ordering and retain the exact Flatpak input mappings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-source-snapshot-order-"));
  try {
    const names = ["b", "a"];
    for (const [directory, order] of [["first", names], ["second", [...names].reverse()]]) {
      mkdirSync(path.join(root, directory), { recursive: true });
      for (const name of order) writeFileSync(path.join(root, directory, name), "same");
    }
    const first = path.join(root, "first.tar");
    const second = path.join(root, "second.tar");
    createFlatpakSourceSnapshot({ root, outputPath: first, inputs: [{ source: "first", destination: "input" }], sourceDateEpoch: "1" });
    createFlatpakSourceSnapshot({ root, outputPath: second, inputs: [{ source: "second", destination: "input" }], sourceDateEpoch: "1" });
    assert.deepEqual(readFileSync(first), readFileSync(second));
    const unicodeNames = ["é", "e\u0301"];
    assert.equal(unicodeNames[0].localeCompare(unicodeNames[1]), 0);
    assert.deepEqual([...unicodeNames].sort(compareUtf8), ["e\u0301", "é"]);
    assert.deepEqual(flatpakSourceSnapshotInputs.frontend.map((input) => typeof input === "string" ? input : `${input.source}:${input.destination}`), [
      "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/build-info.mjs",
      "packaging/flatpak/seed-pnpm-store.mjs:seed-pnpm-store.mjs", "apps/desktop/package.json", "apps/desktop/index.html",
      "apps/desktop/tsconfig.json", "apps/desktop/tsconfig.node.json", "apps/desktop/vite.config.ts", "apps/desktop/src",
      "packages/shared-types/package.json", "packages/shared-types/src",
    ]);
    assert.deepEqual(flatpakSourceSnapshotInputs.desktop, [
      "apps/desktop/src-tauri/Cargo.lock", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/build.rs",
      "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/capabilities", "apps/desktop/src-tauri/icons",
      "apps/desktop/src-tauri/resources", "apps/desktop/src-tauri/src",
    ]);
    assert.deepEqual(flatpakSourceSnapshotInputs.backend.map((input) => typeof input === "string" ? input : `${input.source}:${input.destination}`), [
      "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "LICENSES/crema-0.2.0-BSD-2-Clause.txt", "docs/PACKAGING.md",
      "apps/backend/app", "apps/backend/alembic", "apps/backend/alembic.ini", "apps/backend/pyproject.toml",
      "packaging/demucs/models.json:apps/backend/demucs-models.json", "packaging/flatpak/ffmpeg-wrapper.sh:ffmpeg",
      "packaging/flatpak/ffprobe-wrapper.sh:ffprobe", "packaging/flatpak/com.tuneforge.desktop.desktop:com.tuneforge.desktop.desktop",
      "packaging/flatpak/com.tuneforge.desktop.metainfo.xml:com.tuneforge.desktop.metainfo.xml",
      "apps/desktop/src-tauri/icons/32x32.png:icons/32x32.png", "apps/desktop/src-tauri/icons/128x128.png:icons/128x128.png",
      "apps/desktop/src-tauri/icons/512x512.png:icons/512x512.png",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source snapshots reject duplicate paths, unsafe paths, and unsupported inputs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-source-snapshot-errors-"));
  try {
    writeFileSync(path.join(root, "file"), "fixture");
    assert.throws(() => createFlatpakSourceSnapshot({ root, outputPath: path.join(root, "out.tar"), inputs: [{ source: "file" }, { source: "file" }], sourceDateEpoch: "1" }), /Duplicate/);
    assert.throws(() => createFlatpakSourceSnapshot({ root, outputPath: path.join(root, "out.tar"), inputs: [{ source: "../outside" }], sourceDateEpoch: "1" }), /Unsafe/);
    assert.throws(() => createFlatpakSourceSnapshot({ root, outputPath: path.join(root, "out.tar"), inputs: [{ source: "file", destination: `${"a".repeat(156)}/file` }], sourceDateEpoch: "1" }), /USTAR path overflow/);
    const sparse = path.join(root, "sparse");
    writeFileSync(sparse, "");
    truncateSync(sparse, 8 ** 11);
    assert.throws(() => createFlatpakSourceSnapshot({ root, outputPath: path.join(root, "out.tar"), inputs: [{ source: "sparse" }], sourceDateEpoch: "1" }), /USTAR size overflow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source snapshots reject Unix sockets", { skip: process.platform === "win32" }, async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-source-snapshot-socket-"));
  const socketPath = path.join(root, "socket");
  const server = createServer();
  let listening = false;
  try {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
      listening = true;
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EAFNOSUPPORT") return context.skip("Unix sockets unavailable");
      throw error;
    }
    assert.throws(() => createFlatpakSourceSnapshot({ root, outputPath: path.join(root, "out.tar"), inputs: [{ source: "socket" }], sourceDateEpoch: "1" }), /Unsupported snapshot entry type/);
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("module cache output is anchored, complete only when observed, and profile order follows manifest", () => {
  const expected = expectedFlatpakModuleOrder(manifestWithPackageOptions(
    manifest,
    parsePackageOptions(["--cpu"], { platform: "linux" }),
  ));
  assert.equal(expected.includes("nvidia-torch-core-extension"), false);
  const complete = parseFlatpakModuleCacheOutput(expected.map((name) => `\u001b[32mCache hit for ${name}, skipping build\u001b[0m`).join("\r\n"), expected);
  assert.equal(complete.observationComplete, true);
  assert.equal(complete.firstInvalidatedModule, null);
  assert.ok(complete.modules.every(({ status }) => status === "cached"));
  const partial = parseFlatpakModuleCacheOutput("\u001b[32mBuilding module pnpm in /run/build/pnpm\u001b[0m\nnoise Building module node-sources in /run/build/node-sources", expected);
  assert.equal(partial.observationComplete, false);
  assert.equal(partial.firstInvalidatedModule, "pnpm");
  const spacedPath = parseFlatpakModuleCacheOutput("Building module pnpm in /tmp/build root/pnpm-1", expected);
  assert.equal(spacedPath.modules[0].status, "executed");
  const uncertainPrefix = parseFlatpakModuleCacheOutput(`Building module ${expected[1]} in /run/build/${expected[1]}`, expected);
  assert.equal(uncertainPrefix.firstInvalidatedModule, null);
  const conflict = parseFlatpakModuleCacheOutput("Cache hit for pnpm, skipping build\nBuilding module pnpm in /run/build/pnpm", expected, { evidence: true });
  assert.equal(conflict.mode, "disabled-for-evidence");
  assert.equal(conflict.observationComplete, false);
  assert.equal(conflict.modules[0].status, "unknown");
  const nearMisses = parseFlatpakModuleCacheOutput("Cache hit for pnpm\nBuilding module pnpm\nBuilding module pnpm in relative/path", expected);
  assert.equal(nearMisses.modules[0].status, "unknown");
});

test("sccache JSON stats are normalized and fail closed on malformed or error data", () => {
  const rawStats = {
    compile_requests: 12,
    cache_hits: { counts: { Rust: 7 }, adv_counts: { "Rust/rustc": 7 } },
    cache_misses: { counts: { Rust: 3 }, adv_counts: { "Rust/rustc": 3 } },
    cache_errors: { counts: {}, adv_counts: {} },
    requests_not_cacheable: 2,
    cache_read_errors: 0,
    cache_write_errors: 0,
    compile_fails: 7,
  };
  const stats = parseSccacheStats({ stats: rawStats });
  assert.deepEqual(stats, {
    compileRequests: 12,
    cacheHits: 7,
    cacheMisses: 3,
    cacheErrors: 0,
    compileFailures: 7,
    notCacheable: 2,
  });
  assert.throws(() => parseSccacheStats("{"), /Malformed sccache JSON/);
  assert.throws(
    () => parseSccacheStats({ stats: { ...rawStats, cache_errors: { counts: { Rust: 1 } } } }),
    /reported 1 cache errors/,
  );
  assert.throws(
    () => parseSccacheStats({ stats: { ...rawStats, cache_read_errors: 1 } }),
    /reported 1 cache errors/,
  );
  assert.throws(
    () => parseSccacheStats({ stats: { ...rawStats, cache_write_errors: 1 } }),
    /reported 1 cache errors/,
  );
});

test("pnpm cache reports require explicit durable-store integrity evidence", () => {
  const report = {
    origin: "loopback",
    packageCount: 2,
    tarballIntegrityChecks: 2,
    storeIntegrityChecks: 2,
    storeStatusChecks: 1,
    contentFiles: 8,
    indexIntegrity: "ok",
  };
  assert.equal(isValidPnpmCacheReport(report), true);
  assert.equal(isValidPnpmCacheReport({ ...report, contentFiles: 0 }), false);
});

test("payload digest is metadata-complete, order-stable, and content-sensitive", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-digest-"));
  mkdirSync(path.join(root, "dir"));
  writeFileSync(path.join(root, "dir", "b"), "two");
  writeFileSync(path.join(root, "a"), "one");
  symlinkSync("a", path.join(root, "link"));
  const first = digestBuildPayload(root);
  utimesSync(path.join(root, "a"), new Date(1_000), new Date(2_000));
  assert.deepEqual(digestBuildPayload(root), first);
  writeFileSync(path.join(root, "a"), "changed");
  assert.notEqual(digestBuildPayload(root).sha256, first.sha256);
  assert.equal(first.entryCount, 4);
});

test("cold and warm reports compare payloads and propagate report errors", () => {
  const cold = cacheReportFixture({ profiles: ["cpu", "nvidia", "legacy-nvidia"] });
  const warm = cacheReportFixture({ profiles: ["cpu", "nvidia", "legacy-nvidia"], statuses: "cached" });
  assert.equal(compareCacheReports(cold, warm).equivalent, true);
  assert.deepEqual(
    compareCacheReports(cold, { ...warm, payload: { sha256: "d".repeat(64), entryCount: 4 } }).errors,
    ["Cold and warm payload digests differ."],
  );
  assert.deepEqual(
    compareCacheReports(cold, { ...warm, payload: { ...warm.payload, entryCount: 5 } }).errors,
    ["Cold and warm payload digests differ."],
  );
  assert.equal(compareCacheReports(cold, { ...warm, errors: ["stats error"] }).equivalent, false);
  assert.equal(compareCacheReports(cold, { ...warm, output: { ...warm.output, mode: "exported" } }).equivalent, false);
  assert.equal(compareCacheReports(cold, { ...warm, namespace: "different" }).equivalent, false);
  assert.equal(compareCacheReports({ ...cold, schema: "flatpak-cache-unknown" }, warm).equivalent, false);
  assert.equal(compareCacheReports({ ...cold, namespace: "" }, warm).equivalent, false);
  assert.equal(compareCacheReports({ ...cold, payload: { sha256: "not-a-digest", entryCount: -1 } }, warm).equivalent, false);
  assert.equal(compareCacheReports({ ...cold, refCommits: [] }, warm).equivalent, false);
  assert.equal(compareCacheReports({ ...cold, refCommits: [null] }, warm).equivalent, false);
  assert.equal(compareCacheReports({ ...cold, errors: "invalid" }, warm).equivalent, false);
  assert.equal(compareCacheReports(cold, { ...warm, moduleCache: { ...warm.moduleCache, modules: [{ name: "pnpm", status: "unknown" }] } }).equivalent, false);
  assert.equal(compareCacheReports(null, warm).equivalent, false);
  assert.equal(compareCacheReports(cold, { ...warm, moduleCache: { ...warm.moduleCache, observationComplete: false } }).equivalent, false);
  assert.equal(compareCacheReports(cold, { ...warm, moduleCache: { ...warm.moduleCache, firstInvalidatedModule: "pnpm", modules: [{ name: "pnpm", status: "executed" }] } }).equivalent, false);
  const changedNvidia = cold.refCommits.map((entry) =>
    entry.id === "nvidia-runtime" ? { ...entry, commitSha256: "f".repeat(64) } : entry);
  assert.deepEqual(compareCacheReports(cold, { ...warm, refCommits: changedNvidia }).errors, [
    "Cold and warm Flatpak output ref commits differ.",
  ]);
});

test("cross-profile cache comparisons require a cached shared module prefix", () => {
  const source = cacheReportFixture({ profiles: ["cpu"] });
  const sourceNames = source.moduleCache.modules.map(({ name }) => name);
  const target = cacheReportFixture({
    profiles: ["cpu", "nvidia"],
    statuses: (name) => sourceNames.includes(name) ? "cached" : "executed",
  });
  const comparison = compareCrossProfileCacheReports(source, target);
  assert.equal(comparison.equivalent, true);
  assert.ok(comparison.sharedModulePrefix.length > 0);
  assert.equal(comparison.firstTargetExecution, "nvidia-torch-core-extension");
  assert.equal(compareCrossProfileCacheReports(source, {
    ...target,
    moduleCache: { ...target.moduleCache, modules: [{ name: "pnpm", status: "executed" }] },
  }).equivalent, false);
  assert.equal(compareCrossProfileCacheReports(source, { ...target, selectedProfiles: ["cpu"] }).equivalent, false);
  assert.equal(compareCrossProfileCacheReports(source, {
    ...target,
    namespaceInputs: { ...target.namespaceInputs, packageOptions: { ...target.namespaceInputs.packageOptions, beatThis: false } },
  }).equivalent, false);
  assert.equal(compareCrossProfileCacheReports(source, {
    ...target,
    moduleCache: { ...target.moduleCache, modules: [...target.moduleCache.modules].reverse() },
  }).equivalent, false);
  assert.equal(compareCrossProfileCacheReports(source, {
    ...target,
    refCommits: target.refCommits.map((entry, index) => index === 0 ? { ...entry, ref: "app/forged" } : entry),
  }).equivalent, false);
  assert.equal(compareCrossProfileCacheReports(source, {
    ...target,
    refCommits: target.refCommits.map((entry, index) => index === 0 ? { ...entry, id: "forged" } : entry),
  }).equivalent, false);
  assert.equal(compareCrossProfileCacheReports(source, {
    ...target,
    output: { ...target.output, mode: "preserved-unchanged" },
  }).equivalent, false);
});

test("Flatpak repo reconciliation removes only known refs and verifies the selected set", () => {
  const known = selectedFlatpakOutputRefs(["cpu", "nvidia", "legacy-nvidia"]).map(({ ref }) => ref);
  const obsolete = [
    "runtime/com.tuneforge.desktop.Torch.Nvidia/x86_64/stable",
    "runtime/com.tuneforge.desktop.Torch.LegacyNvidia/x86_64/stable",
  ];
  const unrelated = "runtime/org.example.Unrelated/x86_64/stable";
  const deleted = [];
  reconcileFlatpakOutputRefs({
    repoPath: "/tmp/repo",
    listRefs: () => [...known, ...obsolete, unrelated],
    deleteRef: (_repo, ref) => deleted.push(ref),
  });
  assert.deepEqual(deleted.sort(), [...known, ...obsolete].sort());
  assert.equal(deleted.includes(unrelated), false);

  const selected = selectedFlatpakOutputRefs(["cpu", "nvidia"]);
  const commits = verifyFlatpakOutputRefs({
    repoPath: "/tmp/repo",
    selectedProfiles: ["cpu", "nvidia"],
    listRefs: () => [...selected.map(({ ref }) => ref), unrelated],
    resolveCommit: (_repo, ref) => createHash("sha256").update(ref).digest("hex"),
  });
  assert.deepEqual(commits.map(({ id, ref }) => [id, ref]), [
    ["cpu", "app/com.tuneforge.desktop/x86_64/stable"],
    ["nvidia-core", "runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Core/x86_64/stable"],
    ["nvidia-runtime", "runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime/x86_64/stable"],
  ]);
  assert.ok(commits.every(({ commitSha256 }) => /^[a-f0-9]{64}$/.test(commitSha256)));
  assert.throws(() => verifyFlatpakOutputRefs({
    selectedProfiles: ["cpu"],
    listRefs: () => [known[0], known[1]],
  }), /Stale unselected Flatpak output ref/);
  assert.throws(() => verifyFlatpakOutputRefs({
    selectedProfiles: ["cpu", "nvidia"],
    listRefs: () => [known[0]],
  }), /Missing selected Flatpak output ref/);
  assert.throws(() => verifyFlatpakOutputRefs({
    selectedProfiles: ["cpu"],
    listRefs: () => [known[0], obsolete[0]],
  }), /Stale obsolete Flatpak output ref/);
  assert.throws(() => verifyFlatpakOutputRefs({
    selectedProfiles: ["cpu"],
    listRefs: () => [known[0]],
    resolveCommit: () => "not-a-digest",
  }), /Malformed commit/);
});

test("Flatpak output state is atomic, self-healing, and profile-specific", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-output-state-"));
  try {
    const cpu = outputStateFixture();
    const statePath = flatpakOutputStatePath(root);
    const written = writeFlatpakOutputState({ statePath, ...cpu });
    assert.equal(written.schema, "flatpak-output-state-v1");
    assert.equal(existsSync(statePath), true);
    assert.equal(readdirSync(root).some((name) => name.includes(".tmp")), false);
    assert.deepEqual(readFlatpakOutputState({ statePath, ...cpu }), written);
    assert.deepEqual(validateFlatpakOutputState(written, { ...cpu }), []);
    const firstWarmNoop = selectPreservedFlatpakOutputState({
      statePath,
      namespace: cpu.namespace,
      selectedProfiles: cpu.selectedProfiles,
      refCommits: cpu.refCommits,
    });
    const secondWarmNoop = selectPreservedFlatpakOutputState({
      statePath,
      namespace: cpu.namespace,
      selectedProfiles: cpu.selectedProfiles,
      refCommits: cpu.refCommits,
    });
    assert.deepEqual(firstWarmNoop, written);
    assert.deepEqual(secondWarmNoop, written);

    const nvidia = outputStateFixture({ profiles: ["cpu", "nvidia"] });
    assert.equal(readFlatpakOutputState({ statePath, ...nvidia }), null);
    assert.equal(existsSync(statePath), false);

    writeFileSync(statePath, "not json\n");
    assert.equal(readFlatpakOutputState({ statePath, ...cpu }), null);
    assert.equal(existsSync(statePath), false);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reused Flatpak checkout size evidence is complete enough for downstream bundle reporting", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-reused-size-"));
  try {
    const { checkoutSize, selectedProfiles } = outputStateFixture();
    const bundle = path.join(root, "app.flatpak");
    writeFileSync(bundle, "compressed");
    const report = flatpakBundleSizeReportFromCheckout({
      checkoutSize,
      bundle,
      selectedProfiles,
      extensionBundles: [],
    });
    assert.equal(report.compressedBundle.available, true);
    assert.equal(report.installedApp.path, "/app");
    assert.deepEqual(report.installedApp.topLevelDirectories, [{ path: "/app/lib", bytes: 10 }]);
    assert.equal(report.selectedProfiles[0], "cpu");
    const malformed = {
      ...checkoutSize,
      installedApp: { ...checkoutSize.installedApp, topLevelDirectories: [{ path: "/wrong", bytes: 1 }] },
    };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: malformed, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
    assert.ok(validateFlatpakOutputState({ ...outputStateFixture(), checkoutSize: malformed }).length > 0);
    const malformedCompressed = {
      ...checkoutSize,
      compressedBundle: { ...checkoutSize.compressedBundle, bytes: 0 },
      pythonRuntime: { ...checkoutSize.pythonRuntime, path: "/wrong" },
    };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: malformedCompressed, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
    const oversizedLib = {
      ...checkoutSize,
      installedApp: { ...checkoutSize.installedApp, topLevelDirectories: [{ path: "/app/lib", bytes: 99 }] },
    };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: oversizedLib, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
    const inconsistentRows = {
      ...checkoutSize,
      installedApp: { ...checkoutSize.installedApp, topLevelDirectories: [{ path: "/app/lib", bytes: 4 }] },
    };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: inconsistentRows, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
    const unavailableBundleCompliance = { ...checkoutSize, compliance: { targetMet: true } };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: unavailableBundleCompliance, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
    const missingLib = {
      ...checkoutSize,
      installedApp: { ...checkoutSize.installedApp, topLevelDirectories: [{ path: "/app/share", bytes: 10 }] },
    };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: missingLib, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
    const subtreesExceedLib = {
      ...checkoutSize,
      installedApp: {
        ...checkoutSize.installedApp,
        topLevelDirectories: [{ path: "/app/lib", bytes: 9 }, { path: "/app/share", bytes: 1 }],
      },
    };
    assert.throws(
      () => flatpakBundleSizeReportFromCheckout({ checkoutSize: subtreesExceedLib, bundle, selectedProfiles, extensionBundles: [] }),
      /checkout size evidence is incomplete/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Flatpak size report is deterministic, byte-based, and has no compliance claim without a bundle", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-size-"));
  const buildRoot = path.join(root, "build");
  const appRoot = path.join(buildRoot, "files");
  const wheelReportPath = path.join(root, "python-size-report.json");
  try {
    mkdirSync(path.join(appRoot, "lib", "tuneforge", "backend", "python"), { recursive: true });
    mkdirSync(path.join(appRoot, "lib", "tuneforge", "backend", "site-packages"), { recursive: true });
    mkdirSync(path.join(appRoot, "share"), { recursive: true });
    writeFileSync(path.join(appRoot, "lib", "tuneforge", "backend", "python", "python3.14"), "runtime");
    writeFileSync(path.join(appRoot, "lib", "tuneforge", "backend", "site-packages", "torch.py"), "torch");
    writeFileSync(path.join(appRoot, "share", "small"), "x");
    writeFileSync(
      wheelReportPath,
      `${JSON.stringify([
        { name: "torch", version: "2.13.0", fileName: "torch.whl", size: 12 },
        { name: "torchaudio", version: "2.11.0", fileName: "torchaudio.whl", size: null },
        { name: "source-only", version: "1.0.0", fileName: "source-only-1.0.0.tar.gz", size: 8 },
      ])}\n`,
    );

    const first = flatpakSizeReport({ buildRoot, wheelReportPath, includeBundle: false });
    const second = flatpakSizeReport({ buildRoot, wheelReportPath, includeBundle: false });
    assert.deepEqual(second, first);
    assert.equal(first.unit, "bytes");
    assert.equal(first.compressedBundle.available, false);
    assert.equal(first.compliance, undefined);
    assert.equal(first.wheelInputs.knownBytes, 12);
    assert.equal(first.wheelInputs.unknownCount, 1);
    assert.equal(first.wheelInputs.complete, false);
    assert.equal(first.wheelInputs.entries.length, 2);
    assert.deepEqual(first.sourceArchives, {
      knownBytes: 8,
      unknownCount: 0,
      complete: true,
      entries: [{ name: "source-only", version: "1.0.0", fileName: "source-only-1.0.0.tar.gz", bytes: 8 }],
    });
    assert.deepEqual(first.installedApp.topLevelDirectories.map((entry) => entry.path), ["/app/lib", "/app/share"]);
    assert.equal(first.pythonRuntime.path, "/app/lib/tuneforge/backend/python");
    assert.equal(first.sitePackages.path, "/app/lib/tuneforge/backend/site-packages");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Flatpak bundle size gate hard-fails only at 2 GiB or above", () => {
  const belowHardLimit = {
    compressedBundle: { available: true, bytes: 2 * 1024 ** 3 - 1 },
    compliance: { targetMet: true },
  };
  assert.doesNotThrow(() => enforceFlatpakBundleSize(belowHardLimit));
  assert.throws(
    () => enforceFlatpakBundleSize({ ...belowHardLimit, compressedBundle: { available: true, bytes: 2 * 1024 ** 3 } }),
    /2 GiB hard limit/,
  );
});

test("Flatpak bundle size follows a symlink target and requires a regular file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-bundle-"));
  const target = path.join(root, "bundle.flatpak");
  const link = path.join(root, "configured-output.flatpak");
  try {
    writeFileSync(target, "bundle-target");
    symlinkSync(path.basename(target), link);
    const report = flatpakSizeReport({ buildRoot: path.join(root, "build"), bundle: link });
    assert.deepEqual(report.compressedBundle, {
      path: "configured-output.flatpak",
      available: true,
      bytes: Buffer.byteLength("bundle-target"),
    });
    assert.throws(
      () => flatpakSizeReport({ buildRoot: path.join(root, "build"), bundle: root }),
      /must be a regular file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function bundleFixture(root, selectedProfiles = ["cpu", "nvidia", "legacy-nvidia"]) {
  const plan = flatpakBundlePlan({
    selectedProfiles,
    applicationBundle: path.join(root, "app.flatpak"),
    nvidiaCoreBundle: path.join(root, "nvidia-core.flatpak"),
    nvidiaRuntimeBundle: path.join(root, "nvidia-runtime.flatpak"),
    legacyCoreBundle: path.join(root, "legacy-core.flatpak"),
    legacyRuntimeBundle: path.join(root, "legacy-runtime.flatpak"),
  });
  const ids = ["cpu", "nvidia-core", "nvidia-runtime", "legacy-nvidia-core", "legacy-nvidia-runtime"];
  const refs = [
    "app/com.tuneforge.desktop/x86_64/stable",
    "runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Core/x86_64/stable",
    "runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime/x86_64/stable",
    "runtime/com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core/x86_64/stable",
    "runtime/com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Runtime/x86_64/stable",
  ];
  const wantedIds = plan.map(({ refId }) => {
    if (refId === "com.tuneforge.desktop") return "cpu";
    const legacy = refId.includes("LegacyNvidia");
    const core = refId.endsWith(".Core");
    return `${legacy ? "legacy-nvidia" : "nvidia"}-${core ? "core" : "runtime"}`;
  });
  const refCommits = wantedIds.map((id) => {
    const index = ids.indexOf(id);
    return { id, ref: refs[index], commitSha256: String(index + 1).repeat(64) };
  });
  return {
    plan,
    refCommits,
    statePath: flatpakBundleStatePath(path.join(root, "state")),
    checksumPath: path.join(root, "generated", "SHA256SUMS"),
    managedBundlePaths: ["app.flatpak", "nvidia-core.flatpak", "nvidia-runtime.flatpak", "legacy-core.flatpak", "legacy-runtime.flatpak"]
      .map((name) => path.join(root, name)),
  };
}

function bundleSpawner(spawned, { failRef } = {}) {
  return (_command, args) => {
    const child = new EventEmitter();
    child.kill = () => queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    const output = args.at(-3);
    const refId = args.at(-2);
    spawned.push({ output, refId });
    queueMicrotask(() => {
      if (refId === failRef) child.emit("exit", 1, null);
      else {
        writeFileSync(output, `bundle:${refId}:${spawned.length}`);
        child.emit("exit", 0, null);
      }
    });
    return child;
  };
}

async function runBundleReuse(fixture, spawned, overrides = {}) {
  return reuseFlatpakBundles({
    bundlePlan: fixture.plan,
    refCommits: fixture.refCommits,
    namespace: "flatpak-cache-v1-test",
    flatpakVersion: "Flatpak 1.16.1",
    statePath: fixture.statePath,
    checksumPath: fixture.checksumPath,
    managedBundlePaths: fixture.managedBundlePaths,
    spawnProcess: bundleSpawner(spawned),
    ...overrides,
  });
}

test("Flatpak bundle plan emits the CPU app and exact runtime extension refs", () => {
  const plan = flatpakBundlePlan({
    applicationBundle: "/tmp/app.flatpak",
    nvidiaCoreBundle: "/tmp/nvidia-core.flatpak",
    nvidiaRuntimeBundle: "/tmp/nvidia-runtime.flatpak",
    legacyCoreBundle: "/tmp/legacy-core.flatpak",
    legacyRuntimeBundle: "/tmp/legacy-runtime.flatpak",
  });
  assert.deepEqual(plan.map(({ refId, runtime }) => [refId, runtime]), [
    ["com.tuneforge.desktop", false],
    ["com.tuneforge.desktop.Torch.Stack.Nvidia.Core", true],
    ["com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime", true],
    ["com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core", true],
    ["com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Runtime", true],
  ]);
  const cpuOnly = flatpakBundlePlan({
    selectedProfiles: ["cpu"],
    applicationBundle: "/tmp/cpu-only.flatpak",
  });
  assert.deepEqual(cpuOnly.map(({ refId }) => refId), ["com.tuneforge.desktop"]);
  const nvidiaOnly = flatpakBundlePlan({
    selectedProfiles: ["cpu", "nvidia"],
    applicationBundle: "/tmp/selected-app.flatpak",
    nvidiaCoreBundle: "/tmp/selected-nvidia-core.flatpak",
    nvidiaRuntimeBundle: "/tmp/selected-nvidia-runtime.flatpak",
  });
  assert.equal(nvidiaOnly.length, 3);
  assert.ok(nvidiaOnly.every(({ refId }) => !refId.includes("LegacyNvidia")));
  assert.throws(
    () => flatpakBundlePlan({
      applicationBundle: "/tmp/collision.flatpak",
      nvidiaCoreBundle: "/tmp/collision.flatpak",
    }),
    /bundle output paths must be unique/,
  );
  assert.throws(
    () => flatpakBundlePlan({
      applicationBundle: "/tmp/one/collision.flatpak",
      nvidiaCoreBundle: "/tmp/two/collision.flatpak",
    }),
    /checksum artifact basenames must be unique/,
  );
  let spawned = false;
  assert.throws(
    () => buildFlatpakBundles({
      bundlePlan: [
        { refId: "first", runtime: false, path: "/tmp/collision.flatpak" },
        { refId: "second", runtime: true, path: "/tmp/collision.flatpak" },
      ],
      spawnProcess: () => {
        spawned = true;
      },
    }),
    /bundle output paths must be unique/,
  );
  assert.equal(spawned, false);
  assert.match(packageScript, /Torch_Nvidia_x86_64\.flatpak/);
  assert.match(packageScript, /Torch_LegacyNvidia_x86_64\.flatpak/);
  assert.doesNotMatch(packageScript, /FLATPAK_(?:NVIDIA|LEGACY)_TORCH_BUNDLE_PATH/);
});

test("each Flatpak artifact has an independent size gate and stable checksum entry", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-artifacts-"));
  try {
    const artifacts = ["app.flatpak", "nvidia-core.flatpak", "nvidia-runtime.flatpak", "legacy-core.flatpak", "legacy-runtime.flatpak"].map((name, index) => {
      const artifact = path.join(root, name);
      writeFileSync(artifact, `artifact-${index}`);
      const report = flatpakArtifactSizeReport(artifact);
      assert.equal(report.compressedBundle.path, name);
      assert.doesNotThrow(() => enforceFlatpakBundleSize(report));
      return artifact;
    });
    const output = path.join(root, "SHA256SUMS");
    const lines = writeFlatpakChecksums(artifacts, output);
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.map((line) => line.split("  ")[1]), [
      "app.flatpak",
      "legacy-core.flatpak",
      "legacy-runtime.flatpak",
      "nvidia-core.flatpak",
      "nvidia-runtime.flatpak",
    ]);
    assert.equal(readFileSync(output, "utf8"), `${lines.join("\n")}\n`);
    const selectedLines = writeFlatpakChecksums(artifacts.slice(0, 3), output);
    assert.equal(selectedLines.length, 3);
    assert.deepEqual(selectedLines.map((line) => line.split("  ")[1]), [
      "app.flatpak", "nvidia-core.flatpak", "nvidia-runtime.flatpak",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-bundle path does not invoke bundle cleanup, reuse, checksums, or state", () => {
  const mainSource = packageScript.slice(
    packageScript.indexOf("async function main()"),
    packageScript.indexOf("function runWithPackagingLock()"),
  );
  const noBundleBranch = mainSource.slice(mainSource.indexOf("if (skipBundle)"), mainSource.indexOf("try {", mainSource.indexOf("if (skipBundle)")));
  assert.doesNotMatch(mainSource, /cleanupFlatpakBundleOutputs/);
  assert.doesNotMatch(noBundleBranch, /reuseFlatpakBundles|writeFlatpakChecksums|bundleStatePath|rmSync\([^)]*flatpak/);
  assert.match(noBundleBranch, /return;/);
  assert.match(mainSource, /Flatpak bundle \$\{status\} at/);
  assert.match(mainSource, /Flatpak checksums verified at/);
  assert.doesNotMatch(mainSource, /Flatpak (?:bundle|checksums) written/);
});

test("Flatpak bundles rebuild cold and exact warm reuse is zero-spawn and no-touch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-reuse-"));
  const fixture = bundleFixture(root);
  try {
    mkdirSync(path.dirname(fixture.checksumPath), { recursive: true });
    for (const artifact of fixture.plan) writeFileSync(artifact.path, "old bundle must be ignored");
    writeFileSync(fixture.checksumPath, `${"0".repeat(64)}  app.flatpak\n`);
    const coldSpawned = [];
    const cold = await runBundleReuse(fixture, coldSpawned);
    assert.equal(coldSpawned.length, 5);
    assert.deepEqual(cold.entries.map(({ status }) => status), Array(5).fill("rebuilt"));
    assert.equal(cold.firstRebuiltArtifact, "cpu");
    assert.deepEqual(readFileSync(fixture.checksumPath, "utf8").trim().split("\n").map((line) => line.slice(66)), [
      "app.flatpak", "legacy-core.flatpak", "legacy-runtime.flatpak", "nvidia-core.flatpak", "nvidia-runtime.flatpak",
    ]);
    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.schema, "flatpak-bundle-state-v1");
    assert.equal(state.namespace, "flatpak-cache-v1-test");
    assert.equal(state.flatpakVersion, "Flatpak 1.16.1");
    assert.equal(state.arch, "x86_64");
    assert.equal(state.branch, "stable");
    assert.match(state.commandContract, /^flatpak build-bundle/);
    assert.ok(state.entries.every((entry) => path.isAbsolute(entry.outputPath) && entry.bytes > 0));

    const before = [fixture.statePath, fixture.checksumPath, ...fixture.plan.map(({ path: output }) => output)]
      .map((target) => ({ target, contents: readFileSync(target), mtimeMs: statSync(target).mtimeMs }));
    const warmSpawned = [];
    const warm = await runBundleReuse(fixture, warmSpawned);
    assert.equal(warmSpawned.length, 0);
    assert.deepEqual(warm.entries.map(({ status }) => status), Array(5).fill("reused"));
    assert.equal(warm.firstRebuiltArtifact, null);
    for (const previous of before) {
      assert.deepEqual(readFileSync(previous.target), previous.contents);
      assert.equal(statSync(previous.target).mtimeMs, previous.mtimeMs);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle reuse invalidates exact NVIDIA and legacy refs independently", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-refs-"));
  const fixture = bundleFixture(root);
  try {
    await runBundleReuse(fixture, []);
    const legacy = fixture.refCommits.find(({ id }) => id === "legacy-nvidia-core");
    legacy.commitSha256 = "a".repeat(64);
    const legacySpawned = [];
    const legacyReport = await runBundleReuse(fixture, legacySpawned);
    assert.deepEqual(legacySpawned.map(({ refId }) => refId), ["com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core"]);
    assert.equal(legacyReport.entries.find(({ name }) => name === "cpu").status, "reused");
    assert.equal(legacyReport.entries.find(({ name }) => name === "legacy-nvidia-runtime").status, "reused");

    const nvidia = fixture.refCommits.find(({ id }) => id === "nvidia-runtime");
    nvidia.commitSha256 = "b".repeat(64);
    const nvidiaSpawned = [];
    const nvidiaReport = await runBundleReuse(fixture, nvidiaSpawned);
    assert.deepEqual(nvidiaSpawned.map(({ refId }) => refId), ["com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime"]);
    assert.equal(nvidiaReport.entries.filter(({ status }) => status === "rebuilt").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle state, checksum, path, ref, and file mismatches fail closed at the right scope", async (t) => {
  const cases = [
    ["malformed state", 5, ({ fixture }) => writeFileSync(fixture.statePath, "{broken")],
    ["wrong command contract", 5, ({ state, fixture }) => {
      state.commandContract = "old contract";
      writeFileSync(fixture.statePath, JSON.stringify(state));
    }],
    ["wrong Flatpak version", 5, ({ state, fixture }) => {
      state.flatpakVersion = "Flatpak 0.0.0";
      writeFileSync(fixture.statePath, JSON.stringify(state));
    }],
    ["missing checksum", 5, ({ fixture }) => rmSync(fixture.checksumPath)],
    ["malformed checksum", 5, ({ fixture }) => writeFileSync(fixture.checksumPath, "broken\n")],
    ["duplicate checksum", 5, ({ fixture }) => {
      const line = readFileSync(fixture.checksumPath, "utf8").split("\n")[0];
      writeFileSync(fixture.checksumPath, `${line}\n${line}\n`);
    }],
    ["entry path outside managed allowlist", 5, ({ state, fixture }) => {
      state.entries[2].outputPath = path.join(path.dirname(state.entries[2].outputPath), "moved.flatpak");
      writeFileSync(fixture.statePath, JSON.stringify(state));
    }],
    ["entry ref", 1, ({ state, fixture }) => {
      state.entries[1].ref += "-changed";
      writeFileSync(fixture.statePath, JSON.stringify(state));
    }],
    ["entry commit", 1, ({ state, fixture }) => {
      state.entries[3].commit = "f".repeat(64);
      writeFileSync(fixture.statePath, JSON.stringify(state));
    }],
    ["checksum hash", 1, ({ fixture }) => {
      const lines = readFileSync(fixture.checksumPath, "utf8").trim().split("\n");
      lines[0] = `${"f".repeat(64)}  app.flatpak`;
      writeFileSync(fixture.checksumPath, `${lines.join("\n")}\n`);
    }],
    ["missing file", 1, ({ fixture }) => rmSync(fixture.plan[1].path)],
    ["tampered file", 1, ({ fixture }) => {
      const original = readFileSync(fixture.plan[2].path);
      writeFileSync(fixture.plan[2].path, Buffer.alloc(original.length, 120));
    }],
    ["truncated file", 1, ({ fixture }) => truncateSync(fixture.plan[3].path, 1)],
    ["symlink file", 1, ({ fixture }) => {
      const output = fixture.plan[4].path;
      const target = `${output}.target`;
      writeFileSync(target, readFileSync(output));
      rmSync(output);
      symlinkSync(target, output);
      assert.equal(lstatSync(output).isSymbolicLink(), true);
    }],
  ];
  for (const [name, expectedBuilds, mutate] of cases) await t.test(name, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-mismatch-"));
    const fixture = bundleFixture(root);
    try {
      await runBundleReuse(fixture, []);
      const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
      mutate({ fixture, state });
      const spawned = [];
      const report = await runBundleReuse(fixture, spawned);
      assert.equal(spawned.length, expectedBuilds);
      assert.equal(report.entries.filter(({ status }) => status === "rebuilt").length, expectedBuilds);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("hostile bundle-state paths cannot authorize deletion", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-hostile-"));
  const fixture = bundleFixture(root);
  const sentinel = path.join(root, "sentinel.keep");
  try {
    await runBundleReuse(fixture, []);
    writeFileSync(sentinel, "do not delete");
    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    state.entries.push({ ...state.entries[0], id: "hostile", outputPath: sentinel, basename: path.basename(sentinel) });
    writeFileSync(fixture.statePath, JSON.stringify(state));
    const spawned = [];
    await runBundleReuse(fixture, spawned);
    assert.equal(spawned.length, 5);
    assert.equal(readFileSync(sentinel, "utf8"), "do not delete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle publication failures cannot leave trusted or partially replaced outputs", async (t) => {
  await t.test("hash race becomes a one-artifact miss", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-hash-race-"));
    const fixture = bundleFixture(root);
    try {
      await runBundleReuse(fixture, []);
      let hashes = 0;
      const spawned = [];
      const report = await runBundleReuse(fixture, spawned, {
        hashFile: (target) => {
          if (hashes++ === 0) throw new Error("simulated read race");
          return createHash("sha256").update(readFileSync(target)).digest("hex");
        },
      });
      assert.equal(spawned.length, 1);
      assert.equal(report.entries[0].status, "rebuilt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const failure of ["second rename", "state publication"]) await t.test(failure, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-publish-failure-"));
    const fixture = bundleFixture(root);
    try {
      await runBundleReuse(fixture, []);
      fixture.refCommits[0].commitSha256 = "a".repeat(64);
      if (failure === "second rename") fixture.refCommits[1].commitSha256 = "b".repeat(64);
      const retainedSecond = readFileSync(fixture.plan[1].path);
      let renames = 0;
      await assert.rejects(runBundleReuse(fixture, [], failure === "second rename" ? {
        renameArtifact: (source, destination) => {
          if (++renames === 2) throw new Error("simulated final rename failure");
          renameSync(source, destination);
        },
      } : { writeState: () => { throw new Error("simulated state publication failure"); } }));
      assert.equal(existsSync(fixture.statePath), false);
      assert.equal(existsSync(fixture.checksumPath), false);
      assert.equal(existsSync(fixture.plan[0].path), false);
      if (failure === "second rename") assert.deepEqual(readFileSync(fixture.plan[1].path), retainedSecond);
      assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("profile transitions reuse overlap, build additions, and publish selected-only artifacts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-profiles-"));
  const all = bundleFixture(root);
  try {
    await runBundleReuse(all, []);
    const retained = bundleFixture(root, ["cpu", "nvidia"]);
    const removeSpawned = [];
    const removed = await runBundleReuse(retained, removeSpawned);
    assert.equal(removeSpawned.length, 0);
    assert.deepEqual(removed.entries.map(({ status }) => status), ["reused", "reused", "reused"]);
    assert.ok(all.plan.slice(3).every(({ path: output }) => !existsSync(output)));
    assert.equal(JSON.parse(readFileSync(retained.statePath, "utf8")).entries.length, 3);
    assert.equal(readFileSync(retained.checksumPath, "utf8").trim().split("\n").length, 3);

    const addSpawned = [];
    const added = await runBundleReuse(all, addSpawned);
    assert.equal(addSpawned.length, 2);
    assert.deepEqual(added.entries.map(({ status }) => status), ["reused", "reused", "reused", "rebuilt", "rebuilt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle failures remove trust markers and temps, then evidence mode rebuilds every artifact", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-failure-"));
  const fixture = bundleFixture(root);
  try {
    await runBundleReuse(fixture, []);
    rmSync(fixture.plan[0].path);
    rmSync(fixture.plan[1].path);
    const failedSpawns = [];
    await assert.rejects(
      reuseFlatpakBundles({
        bundlePlan: fixture.plan,
        refCommits: fixture.refCommits,
        namespace: "flatpak-cache-v1-test",
        flatpakVersion: "Flatpak 1.16.1",
        statePath: fixture.statePath,
        checksumPath: fixture.checksumPath,
        managedBundlePaths: fixture.managedBundlePaths,
        concurrency: 2,
        spawnProcess: bundleSpawner(failedSpawns, { failRef: fixture.plan[0].refId }),
      }),
      (error) => error.bundleCache?.observationComplete === false,
    );
    assert.equal(failedSpawns.length, 2);
    assert.equal(existsSync(fixture.statePath), false);
    assert.equal(existsSync(fixture.checksumPath), false);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);

    const evidenceSpawned = [];
    const evidence = await runBundleReuse(fixture, evidenceSpawned, { evidence: true });
    assert.equal(evidenceSpawned.length, 5);
    assert.equal(evidence.mode, "disabled-for-evidence");
    assert.ok(evidence.entries.every(({ status }) => status === "rebuilt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-bundle cleanup and bundle failures cannot preserve stale artifacts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-flatpak-cleanup-"));
  const bundlePlan = ["app.flatpak", "nvidia-core.flatpak", "nvidia-runtime.flatpak", "legacy-core.flatpak", "legacy-runtime.flatpak"].map((name) => ({
    path: path.join(root, name),
  }));
  const checksumPath = path.join(root, "generated", "SHA256SUMS");
  const obsoleteBundlePaths = [
    path.join(root, "Tuneforge_1.4.0_Torch_Nvidia_x86_64.flatpak"),
    path.join(root, "Tuneforge_1.4.0_Torch_LegacyNvidia_x86_64.flatpak"),
  ];
  const unrelatedOldOverride = path.join(root, "custom-old-nvidia-output.flatpak");
  try {
    mkdirSync(path.dirname(checksumPath), { recursive: true });
    for (const { path: artifact } of bundlePlan) writeFileSync(artifact, "stale");
    for (const artifact of obsoleteBundlePaths) writeFileSync(artifact, "obsolete");
    writeFileSync(unrelatedOldOverride, "preserve");
    writeFileSync(checksumPath, "stale\n");
    cleanupFlatpakBundleOutputs({ bundlePlan, checksumPath, obsoleteBundlePaths });
    assert.ok(bundlePlan.every(({ path: artifact }) => !existsSync(artifact)));
    assert.ok(obsoleteBundlePaths.every((artifact) => !existsSync(artifact)));
    assert.equal(existsSync(unrelatedOldOverride), true);
    assert.equal(existsSync(checksumPath), false);

    for (const artifact of obsoleteBundlePaths) writeFileSync(artifact, "obsolete");
    await assert.rejects(
      withFreshFlatpakBundleOutputs(() => {
        writeFileSync(bundlePlan[0].path, "partial");
        writeFileSync(checksumPath, "partial\n");
        throw new Error("bundle failed");
      }, { bundlePlan, checksumPath, obsoleteBundlePaths }),
      /bundle failed/,
    );
    assert.ok(bundlePlan.every(({ path: artifact }) => !existsSync(artifact)));
    assert.ok(obsoleteBundlePaths.every((artifact) => !existsSync(artifact)));
    assert.equal(existsSync(checksumPath), false);

    const protectedArtifact = bundlePlan[0].path;
    writeFileSync(protectedArtifact, "keep-before-validation");
    assert.throws(
      () => cleanupFlatpakBundleOutputs({
        bundlePlan: [{ path: protectedArtifact }, { path: protectedArtifact }],
        checksumPath,
        obsoleteBundlePaths: [],
      }),
      /bundle output paths must be unique/,
    );
    assert.equal(readFileSync(protectedArtifact, "utf8"), "keep-before-validation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Flatpak bundle workers reserve one core, use five workers when available, and cap queued work", async () => {
  assert.equal(defaultFlatpakBundleConcurrency(1), 1);
  assert.equal(defaultFlatpakBundleConcurrency(2), 1);
  assert.equal(defaultFlatpakBundleConcurrency(8), 7);
  assert.equal(flatpakBundleWorkerLimit([{ path: "/tmp/one" }], 7), 1);
  assert.equal(flatpakBundleWorkerLimit([{ path: "/tmp/one" }, { path: "/tmp/two" }], 7), 2);
  const plan = (count) => Array.from({ length: count }, (_, index) => ({
    refId: `ref-${index}`, runtime: index > 0, path: `/tmp/ref-${index}.flatpak`,
  }));
  const run = (bundlePlan, concurrency) => {
    const children = [];
    const spawned = [];
    const operation = buildFlatpakBundles({
      bundlePlan,
      repository: "/tmp/repo",
      concurrency,
      spawnProcess: (_command, args) => {
        const child = new EventEmitter();
        child.kill = () => queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        spawned.push(args.at(-2));
        children.push(child);
        return child;
      },
    });
    return { children, operation, spawned };
  };

  const five = run(plan(5), 7);
  assert.equal(five.spawned.length, 5);
  for (const child of five.children) child.emit("exit", 0, null);
  await five.operation;

  const larger = run(plan(8), 7);
  assert.equal(larger.spawned.length, 7);
  larger.children[0].emit("exit", 0, null);
  assert.equal(larger.spawned.length, 8);
  for (const child of larger.children.slice(1)) child.emit("exit", 0, null);
  await larger.operation;
});

test("Flatpak bundle failure stops queued work and terminates active children", async () => {
  const plan = Array.from({ length: 5 }, (_, index) => ({
    refId: `ref-${index}`, runtime: index > 0, path: `/tmp/ref-${index}.flatpak`,
  }));
  const spawned = [];
  const killed = [];
  const operation = buildFlatpakBundles({
    bundlePlan: plan,
    repository: "/tmp/repo",
    concurrency: 2,
    spawnProcess: (_command, args) => {
      const child = new EventEmitter();
      const refId = args.at(-2);
      child.kill = () => {
        killed.push(refId);
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      };
      spawned.push({ child, refId });
      return child;
    },
  });
  assert.equal(spawned.length, 2);
  spawned[1].child.emit("exit", 1, null);
  await assert.rejects(operation, /ref-1.*status 1/);
  assert.deepEqual(spawned.map(({ refId }) => refId), ["ref-0", "ref-1"]);
  assert.deepEqual(killed, ["ref-0"]);
});
