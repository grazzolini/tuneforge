import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cacheNamespace,
  compareCacheReports,
  digestBuildPayload,
  enforceFlatpakBundleSize,
  flatpakSizeReport,
  frontendModuleInputPaths,
  isValidPnpmCacheReport,
  normalizeGeneratedModelBundleManifest,
  parseSccacheStats,
  resolveCacheRoots,
  resolveFrontendGitRef,
  resolveSourceDateEpoch,
} from "./package-flatpak.mjs";
import { parsePackageOptions } from "./package-options.mjs";

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

test("Flatpak cache namespace includes every invalidation dimension", () => {
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
      "pulseaudio-client-tools",
      "tuneforge-backend",
    ],
  );
  const frontend = moduleSource("tuneforge-frontend", "sccache");
  const desktop = moduleSource("tuneforge-desktop", "cpython-3.14");
  const backend = moduleSource("tuneforge-backend");
  assert.match(frontend, /apps\/desktop\/src/);
  assert.match(frontend, /frontend-version\.json/);
  assert.doesNotMatch(frontend, /apps\/backend|src-tauri\/Cargo/);
  assert.match(desktop, /frontend-dist\/. apps\/desktop\/dist/);
  assert.match(desktop, /RUSTC_WRAPPER: \/app\/bin\/sccache/);
  assert.doesNotMatch(desktop, /apps\/backend|apps\/desktop\/src$/m);
  assert.match(backend, /apps\/backend\/app/);
  assert.doesNotMatch(backend, /cargo-sources|seed-pnpm-store|vite\.config/);
  assert.match(manifest, /sccache-v0\.17\.0-x86_64-unknown-linux-musl\.tar\.gz/);
  assert.match(manifest, /67c4a96dd237c1f518f6b36083f270f9976d516f1e57fce891755ea782e50006/);
  assert.match(backend, /rm -rf .*\/app\/bin\/sccache/);
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
  const cold = { namespace: "same", payload: { sha256: "abc", entryCount: 4 }, errors: [] };
  const warm = { namespace: "same", payload: { sha256: "abc", entryCount: 4 }, errors: [] };
  assert.equal(compareCacheReports(cold, warm).equivalent, true);
  assert.deepEqual(
    compareCacheReports(cold, { ...warm, payload: { sha256: "def", entryCount: 4 } }).errors,
    ["Cold and warm payload digests differ."],
  );
  assert.equal(compareCacheReports(cold, { ...warm, errors: ["stats error"] }).equivalent, false);
  assert.equal(compareCacheReports(cold, { ...warm, namespace: "different" }).equivalent, false);
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
