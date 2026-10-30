import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMusicCoreSitePackageEntry, verifiedMusicCoreWheel } from "./prepare-bundle.mjs";
import { buildReleaseLicenseInventory, formatReleaseLicenseInventory } from "./release-license-inventory.mjs";
import { musicCoreBuildSources, parseUvLock, resolvePythonRuntimePackages } from "./generate-flatpak-sources.mjs";
import { stageMusicCoreNotices } from "./package-android.mjs";

test("bundle copy excludes music-core packages and editable loaders before wheel installation", () => {
  for (const name of ["tuneforge_music_core/__init__.py", "tuneforge_music_core-0.1.0.dist-info/METADATA",
    "__editable__.tuneforge_music_core-0.1.0.pth", "_tuneforge_music_core_editable.py",
    "_tuneforge_music_core_editable.pth"]) {
    assert.equal(isMusicCoreSitePackageEntry(name), true, name);
  }
  assert.equal(isMusicCoreSitePackageEntry("numpy/__init__.py"), false);
  assert.equal(isMusicCoreSitePackageEntry("torch/testing/__init__.py"), false);
});

test("bundle requires one matching standalone CPython 3.14 wheel", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-music-core-wheel-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "packages/music-core/build/artifacts/python/cp314");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, "tuneforge_music_core-0.1.0-cp311-cp311-macosx_11_0_arm64.whl"), "wrong ABI");
  assert.throws(() => verifiedMusicCoreWheel(root), /exactly one/);
  const wheel = "tuneforge_music_core-0.1.0-cp314-cp314-macosx_11_0_arm64.whl";
  writeFileSync(path.join(artifacts, wheel), "fixture");
  assert.equal(verifiedMusicCoreWheel(root), path.join(artifacts, wheel));
  writeFileSync(path.join(artifacts, "tuneforge_music_core-0.1.0-cp314-cp314-macosx_14_0_arm64.whl"), "ambiguous");
  assert.throws(() => verifiedMusicCoreWheel(root), /exactly one/);
});

test("release inventory retains exact canonical core and binding license evidence", () => {
  const inventory = buildReleaseLicenseInventory();
  assert.equal(inventory.musicCorePolicy.gingo.revision, "eec410e6f5b09ad89a2b9d987b63e4048d9a738c");
  assert.equal(inventory.musicCorePolicy.gingo.license, "MIT");
  assert.equal(inventory.musicCorePolicy.pybind11.license, "BSD-3-Clause");
  assert.equal(inventory.musicCorePolicy.unicode.license, "Unicode-3.0");
  assert.equal(inventory.musicCorePolicy.unicode.version, "16.0.0");
  assert.equal(createHash("sha256").update(readFileSync(new URL(
    `../${inventory.musicCorePolicy.unicode.notice}`, import.meta.url))).digest("hex"), inventory.musicCorePolicy.unicode.sha256);
  assert.match(formatReleaseLicenseInventory(inventory), /Canonical music-core policy:/);
});

test("Android assets retain complete Gingo and Unicode notices", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-music-core-android-notices-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const licenses = stageMusicCoreNotices(root);
  for (const [source, name] of [["licenses/Gingo-LICENSE", "Gingo-MIT.txt"], ["licenses/Unicode-LICENSE", "Unicode-LICENSE.txt"]]) {
    assert.deepEqual(readFileSync(path.join(licenses, name)), readFileSync(new URL(`../packages/music-core/${source}`, import.meta.url)));
  }
});

test("Flatpak acquires every locked Python build dependency with exact hashes", () => {
  const tools = musicCoreBuildSources();
  assert.deepEqual(tools.map(({ name }) => name), ["scikit-build-core", "pybind11", "packaging", "pathspec", "cmake"]);
  for (const { source } of tools) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(source.dest, "music-core-build-sources");
    assert.equal(source.type, "file");
  }
  assert.match(tools.find(({ name }) => name === "cmake").source["dest-filename"], /manylinux.*x86_64/);
  assert.throws(() => musicCoreBuildSources({ platform: "unreviewed-platform" }), /Missing pinned/);
});

test("Flatpak rejects a build artifact that could escape its acquisition directory", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuneforge-music-core-lock-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages/music-core"), { recursive: true });
  writeFileSync(path.join(root, "packages/music-core/toolchains.lock.json"), JSON.stringify({
    schemaVersion: 1, pythonBuildDependencies: ["tool"], tools: { tool: {
      version: "1", buildOnly: true, artifacts: { any: {
        filename: "../tool.whl", url: "https://example.invalid/tool.whl", sha256: "a".repeat(64),
      } },
    } },
  }));
  assert.throws(() => musicCoreBuildSources({ root }), /Missing pinned/);
});

test("Flatpak resolves the local music-core separately from downloadable runtime packages", () => {
  for (const sourceKind of ["editable", "directory"]) {
    const lock = `[[package]]
name = "tuneforge-backend"
version = "1.0.0"
source = { editable = "." }
dependencies = [
    { name = "tuneforge-music-core" },
    { name = "remote" },
]

[[package]]
name = "tuneforge-music-core"
version = "0.1.0"
source = { ${sourceKind} = "../../packages/music-core" }

[[package]]
name = "remote"
version = "1.2.3"
source = { registry = "https://example.invalid/simple" }
`;
    const packages = parseUvLock(lock);
    assert.deepEqual(resolvePythonRuntimePackages(packages).map(({ name }) => name), ["remote"]);
    const wrongPath = parseUvLock(lock.replace("../../packages/music-core", "../unexpected"));
    assert.throws(() => resolvePythonRuntimePackages(wrongPath), /reviewed standalone local source/);
  }
});


test("music-core setup summary retains verified manifest and direct-builder JSON output", (context) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tuneforge-music-core-report-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  // Copy only producer source and metadata. The fixture never reads real build artifacts.
  const inputs = ["tools/build.mjs", "package.json", "toolchains.lock.json", "sources.lock.json", "licenses/Gingo-LICENSE"];
  for (const input of inputs) {
    const destination = path.join(root, input);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(new URL(`../packages/music-core/${input}`, import.meta.url), destination);
  }
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const json = (name) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
  const sources = json("sources.lock.json");
  const tools = json("toolchains.lock.json").tools;
  const platform = `${process.platform}-${process.arch}`;
  const directory = path.join(root, "build/artifacts/wasm");
  mkdirSync(directory, { recursive: true });
  const files = ["music-core.mjs", "music-core.wasm"].map((name) => {
    const bytes = Buffer.from(`synthetic non-executable ${name}`);
    writeFileSync(path.join(directory, name), bytes);
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  const fingerprint = createHash("sha256");
  for (const input of [...inputs].sort()) fingerprint.update(`${input}\0${hash(readFileSync(path.join(root, input)))}\n`);
  const manifest = {
    manifestVersion: 1, packageVersion: json("package.json").version, target: "wasm", platform,
    apiVersion: 1, abiVersion: 1, schemaVersion: 1, corpusVersion: 1,
    sourceFingerprint: fingerprint.digest("hex"), files,
    gingoArchiveSha256: sources.archive.sha256, gingoRevision: sources.revision,
    preparedSourceIdentity: hash(JSON.stringify({ archive: sources.archive,
      files: sources.files.map(({ path, sha256 }) => ({ path, sha256 })), patches: sources.patches })),
    cmakeVersion: tools.cmake.version, emscriptenVersion: tools.emscripten.version,
    emscriptenArchiveSha256: tools.emscripten.artifacts[platform].sha256,
    emscriptenCompilerVersion: tools.emscripten.compilerVersion,
    emscriptenCompilerRevision: tools.emscripten.compilerRevision,
    emscriptenReleaseRevision: tools.emscripten.releaseRevision,
  };
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const builder = path.join(root, "build/report-cli.mjs");
  writeFileSync(builder, 'import { main } from "../tools/build.mjs"; await main();\n');
  const run = (...args) => spawnSync(process.execPath, [builder, "--target", "wasm", "--check", ...args], { encoding: "utf8" });
  const summary = run("--summary");
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(summary.stdout, `Music core wasm: verified\nManifest: ${path.join(directory, "manifest.json")}\n`);
  assert.doesNotMatch(summary.stdout, /sha256|sourceFingerprint|"files"/);
  const direct = run();
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), manifest);
  writeFileSync(path.join(directory, files[0].path), "tampered");
  const corrupt = run("--summary");
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /Core artifact checksum mismatch/);
  const failed = spawnSync(process.execPath, [builder, "--target", "unsupported", "--summary"], { encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Expected --target/);
});
