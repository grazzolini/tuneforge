import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import "./flatpak-cache.test.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  assertTarballIntegrity,
  nodeTarballFileName,
  parsePnpmLock,
  seedPnpmStore,
  validatePnpmStore,
} from "../packaging/flatpak/seed-pnpm-store.mjs";

const flatpakManifest = readFileSync(
  new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
  "utf8",
);
const pnpmSeeder = readFileSync(new URL("../packaging/flatpak/seed-pnpm-store.mjs", import.meta.url), "utf8");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function packFixture(root, sources, manifest) {
  const packageRoot = path.join(root, manifest.name.replace(/^@/, "").replace("/", "-"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(packageRoot, "index.js"), `module.exports = ${JSON.stringify(manifest.name)};\n`);
  const executablePath = path.join(packageRoot, "bin.js");
  writeFileSync(executablePath, "#!/usr/bin/env node\n");
  chmodSync(executablePath, 0o755);
  const fileName = run(
    "npm",
    ["pack", "--cache", path.join(root, "npm-cache"), "--pack-destination", sources],
    packageRoot,
  ).split("\n").at(-1);
  const tarball = readFileSync(path.join(sources, fileName));
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

function assertServerClosed(origin) {
  return new Promise((resolve, reject) => {
    const request = http.get(origin, () => reject(new Error(`Registry still accepts requests at ${origin}`)));
    request.setTimeout(1_000, () => request.destroy(new Error("Registry close check timed out")));
    request.once("error", (error) => {
      if (error.code === "ECONNREFUSED") return resolve();
      reject(error);
    });
  });
}

function regularFileInodes(root) {
  const inodes = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const inode of regularFileInodes(entryPath)) inodes.add(inode);
      continue;
    }
    if (entry.isFile()) {
      const { dev, ino } = lstatSync(entryPath);
      inodes.add(`${dev}:${ino}`);
    }
  }
  return inodes;
}

function firstPnpmContentFile(storeDir) {
  const filesRoot = path.join(storeDir, "v11", "files");
  for (const prefix of readdirSync(filesRoot)) {
    const prefixPath = path.join(filesRoot, prefix);
    for (const entry of readdirSync(prefixPath)) {
      const entryPath = path.join(prefixPath, entry);
      if (lstatSync(entryPath).isFile()) return entryPath;
    }
  }
  throw new Error("Fixture pnpm store has no content file.");
}

function directorySnapshot(root) {
  const snapshot = new Map();
  const capture = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        capture(entryPath);
      } else if (entry.isFile()) {
        snapshot.set(relativePath, createHash("sha512").update(readFileSync(entryPath)).digest("hex"));
      } else if (entry.isSymbolicLink()) {
        snapshot.set(relativePath, `symlink:${readlinkSync(entryPath)}`);
      }
    }
  };
  capture(root);
  return snapshot;
}

test("Flatpak uses the executable pnpm 11 launcher and an offline frozen install", () => {
  assert.match(flatpakManifest, /org\.freedesktop\.Sdk\.Extension\.node26/);
  assert.match(flatpakManifest, /ln -sf \.\.\/lib\/pnpm\/bin\/pnpm\.mjs \/app\/bin\/pnpm/);
  assert.match(flatpakManifest, /\/app\/bin\/pnpm --version/);
  assert.match(flatpakManifest, /pnpm\/store .*pnpm\/cache .*pnpm-report\.json/);
  assert.equal([...pnpmSeeder.matchAll(/"store",\s*"status"/g)].length, 1);
  assert.equal([...pnpmSeeder.matchAll(/--config\.package-import-method=copy/g)].length, 2);
  assert.equal([...pnpmSeeder.matchAll(/--frozen-store/g)].length, 2);
  assert.doesNotMatch(flatpakManifest, /pnpm\.cjs|rewrite-pnpm-lock/);
});

test("pnpm tarball integrity rejects corrupt offline sources", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "tuneforge-flatpak-integrity-"));
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));
  const tarballPath = path.join(fixtureRoot, "fixture.tgz");
  writeFileSync(tarballPath, "expected");
  const pkg = { name: "fixture", version: "1.0.0", url: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity: `sha512-${createHash("sha512").update("expected").digest("base64")}` };
  const tarballs = new Map([[new URL(pkg.url).pathname, tarballPath]]);
  assert.doesNotThrow(() => assertTarballIntegrity([pkg], tarballs));
  writeFileSync(tarballPath, "corrupt");
  assert.throws(() => assertTarballIntegrity([pkg], tarballs), /integrity mismatch/);
});

test("pnpm lock parsing maps scoped and peer-suffixed entries to exact tarballs", () => {
  const packages = parsePnpmLock(`lockfileVersion: '9.0'\n\npackages:\n\n  '@scope/peer@1.2.3(peer@2.0.0)':\n    resolution: {integrity: sha512-first}\n\n  '@scope/peer@1.2.3(peer@3.0.0)':\n    resolution: {integrity: sha512-first}\n\n  plain@2.0.0:\n    resolution: {integrity: sha512-second}\n\nsnapshots:\n`);
  assert.deepEqual(packages.map(({ name, version, fileName }) => ({ name, version, fileName })), [
    { name: "@scope/peer", version: "1.2.3", fileName: "scope-peer-1.2.3.tgz" },
    { name: "plain", version: "2.0.0", fileName: "plain-2.0.0.tgz" },
  ]);
  assert.equal(nodeTarballFileName("@scope/peer", "1.2.3"), "scope-peer-1.2.3.tgz");
  assert.throws(() => parsePnpmLock("lockfileVersion: '9.0'\n\npackages:\n\n  '../../escape@1.0.0':\n    resolution: {integrity: sha512-bad}\n"), /Unsafe pnpm package key/);
});

test("pnpm store seeding preserves durable warm caches and rejects corrupt stores", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "tuneforge-flatpak-pnpm-"));
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));
  const sources = path.join(fixtureRoot, "sources");
  mkdirSync(sources);

  const plainIntegrity = packFixture(fixtureRoot, sources, {
    name: "plain-fixture",
    version: "1.0.0",
  });
  const scopedIntegrity = packFixture(fixtureRoot, sources, {
    name: "@scope/peer-fixture",
    version: "1.0.0",
    peerDependencies: { "plain-fixture": "1.0.0" },
  });

  writeFileSync(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({
      name: "flatpak-pnpm-fixture",
      private: true,
      dependencies: {
        "@scope/peer-fixture": "1.0.0",
        "plain-fixture": "1.0.0",
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(fixtureRoot, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      '@scope/peer-fixture':\n        specifier: 1.0.0\n        version: 1.0.0(plain-fixture@1.0.0)\n      plain-fixture:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  '@scope/peer-fixture@1.0.0':\n    resolution: {integrity: ${scopedIntegrity}}\n    peerDependencies:\n      plain-fixture: 1.0.0\n\n  plain-fixture@1.0.0:\n    resolution: {integrity: ${plainIntegrity}}\n\nsnapshots:\n\n  '@scope/peer-fixture@1.0.0(plain-fixture@1.0.0)':\n    dependencies:\n      plain-fixture: 1.0.0\n\n  plain-fixture@1.0.0: {}\n`,
  );
  writeFileSync(path.join(fixtureRoot, ".npmrc"), "package-import-method=hardlink\n");
  const warmWorkspace = path.join(fixtureRoot, "warm-workspace");
  const warmSources = path.join(fixtureRoot, "warm-sources");
  const missingWorkspace = path.join(fixtureRoot, "missing-workspace");
  const missingSources = path.join(fixtureRoot, "missing-sources");
  mkdirSync(warmWorkspace);
  mkdirSync(warmSources);
  mkdirSync(missingWorkspace);
  mkdirSync(missingSources);
  for (const fileName of readdirSync(sources)) copyFileSync(path.join(sources, fileName), path.join(warmSources, fileName));
  for (const fileName of readdirSync(sources)) copyFileSync(path.join(sources, fileName), path.join(missingSources, fileName));
  for (const fileName of ["package.json", "pnpm-lock.yaml", ".npmrc"]) {
    copyFileSync(path.join(fixtureRoot, fileName), path.join(warmWorkspace, fileName));
    copyFileSync(path.join(fixtureRoot, fileName), path.join(missingWorkspace, fileName));
  }
  const storeDir = path.join(fixtureRoot, "store");
  const cacheDir = path.join(fixtureRoot, "cache");

  const previousCwd = process.cwd();
  process.chdir(fixtureRoot);
  let result;
  try {
    result = await seedPnpmStore({
      tarballRoot: sources,
      storeDir,
      cacheDir,
      pnpmPath: "pnpm",
    });
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(result.packageCount, 2);
  assert.equal(result.tarballIntegrityChecks, 2);
  assert.equal(result.storeIntegrityChecks, 2);
  assert.equal(result.storeStatusChecks, 1);
  assert.ok(result.contentFiles > 0);
  assert.equal(result.indexIntegrity, "ok");
  assert.equal(existsSync(sources), false);
  assert.match(await readFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "utf8"), /resolution: \{integrity:/);
  assert.doesNotMatch(await readFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "utf8"), /tarball:/);
  assert.equal(
    JSON.parse(await readFile(path.join(fixtureRoot, "node_modules", "@scope", "peer-fixture", "package.json"))).name,
    "@scope/peer-fixture",
  );
  const storeInodes = regularFileInodes(storeDir);
  const installedInodes = regularFileInodes(path.join(fixtureRoot, "node_modules"));
  assert.deepEqual([...installedInodes].filter((inode) => storeInodes.has(inode)), []);
  await assertServerClosed(result.origin);

  const noProjectsStore = path.join(fixtureRoot, "no-projects-store");
  cpSync(storeDir, noProjectsStore, { recursive: true });
  rmSync(path.join(noProjectsStore, "v11", "projects"), { force: true, recursive: true });
  assert.doesNotThrow(() => validatePnpmStore(noProjectsStore));

  assert.equal(existsSync(path.join(warmWorkspace, "node_modules")), false);
  const warmSnapshot = directorySnapshot(storeDir);
  const warmCacheSnapshot = directorySnapshot(cacheDir);
  process.chdir(warmWorkspace);
  let warmResult;
  try {
    warmResult = await seedPnpmStore({
      tarballRoot: warmSources,
      storeDir,
      cacheDir,
      pnpmPath: "pnpm",
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(warmResult.contentFiles, result.contentFiles);
  assert.equal(existsSync(warmSources), false);
  assert.deepEqual(directorySnapshot(storeDir), warmSnapshot);
  assert.deepEqual(directorySnapshot(cacheDir), warmCacheSnapshot);
  const warmInodes = regularFileInodes(path.join(warmWorkspace, "node_modules"));
  assert.deepEqual([...warmInodes].filter((inode) => storeInodes.has(inode)), []);
  await assertServerClosed(warmResult.origin);

  const missingBlobStore = path.join(fixtureRoot, "missing-blob-store");
  cpSync(storeDir, missingBlobStore, { recursive: true });
  const missingBlobPath = firstPnpmContentFile(missingBlobStore);
  rmSync(missingBlobPath);
  const missingCacheSnapshot = directorySnapshot(cacheDir);
  assert.equal(existsSync(path.join(missingWorkspace, "node_modules")), false);
  process.chdir(missingWorkspace);
  try {
    await assert.rejects(
      () => seedPnpmStore({
        tarballRoot: missingSources,
        storeDir: missingBlobStore,
        cacheDir,
        pnpmPath: "pnpm",
      }),
    );
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(existsSync(missingBlobPath), false);
  assert.equal(existsSync(missingSources), true);
  assert.deepEqual(directorySnapshot(cacheDir), missingCacheSnapshot);

  const corruptContentStore = path.join(fixtureRoot, "corrupt-content-store");
  cpSync(storeDir, corruptContentStore, { recursive: true });
  const corruptContentPath = firstPnpmContentFile(corruptContentStore);
  writeFileSync(corruptContentPath, "corrupt content");
  assert.throws(() => validatePnpmStore(corruptContentStore), /content integrity mismatch/);
  assert.equal(readFileSync(corruptContentPath, "utf8"), "corrupt content");

  const corruptIndexStore = path.join(fixtureRoot, "corrupt-index-store");
  cpSync(storeDir, corruptIndexStore, { recursive: true });
  const corruptIndexPath = path.join(corruptIndexStore, "v11", "index.db");
  writeFileSync(corruptIndexPath, "corrupt index");
  assert.throws(() => validatePnpmStore(corruptIndexStore), /Malformed pnpm index database/);
  assert.equal(readFileSync(corruptIndexPath, "utf8"), "corrupt index");
});
