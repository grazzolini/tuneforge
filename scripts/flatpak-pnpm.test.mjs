import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  nodeTarballFileName,
  parsePnpmLock,
  seedPnpmStore,
} from "../packaging/flatpak/seed-pnpm-store.mjs";

const flatpakManifest = readFileSync(
  new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url),
  "utf8",
);

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
      if (error.code === "ECONNREFUSED") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

test("Flatpak uses the executable pnpm 11 launcher and an offline frozen install", () => {
  assert.match(flatpakManifest, /org\.freedesktop\.Sdk\.Extension\.node26/);
  assert.match(flatpakManifest, /ln -sf \.\.\/lib\/pnpm\/bin\/pnpm\.mjs \/app\/bin\/pnpm/);
  assert.match(flatpakManifest, /\/app\/bin\/pnpm --version/);
  assert.match(flatpakManifest, /node seed-pnpm-store\.mjs/);
  assert.doesNotMatch(flatpakManifest, /pnpm\.cjs|rewrite-pnpm-lock/);
});

test("pnpm lock parsing maps scoped and peer-suffixed entries to exact tarballs", () => {
  const packages = parsePnpmLock(`lockfileVersion: '9.0'\n\npackages:\n\n  '@scope/peer@1.2.3(peer@2.0.0)':\n    resolution: {integrity: sha512-first}\n\n  '@scope/peer@1.2.3(peer@3.0.0)':\n    resolution: {integrity: sha512-first}\n\n  plain@2.0.0:\n    resolution: {integrity: sha512-second}\n\nsnapshots:\n`);

  assert.deepEqual(
    packages.map(({ name, version, fileName }) => ({ name, version, fileName })),
    [
      { name: "@scope/peer", version: "1.2.3", fileName: "scope-peer-1.2.3.tgz" },
      { name: "plain", version: "2.0.0", fileName: "plain-2.0.0.tgz" },
    ],
  );
  assert.equal(nodeTarballFileName("@scope/peer", "1.2.3"), "scope-peer-1.2.3.tgz");
  assert.throws(
    () => parsePnpmLock("lockfileVersion: '9.0'\n\npackages:\n\n  '../../escape@1.0.0':\n    resolution: {integrity: sha512-bad}\n"),
    /Unsafe pnpm package key/,
  );
});

test("pnpm store seeding supports scoped peers and installs after sources are removed", async (context) => {
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

  const previousCwd = process.cwd();
  process.chdir(fixtureRoot);
  let result;
  try {
    result = await seedPnpmStore({
      tarballRoot: sources,
      storeDir: path.join(fixtureRoot, "store"),
      cacheDir: path.join(fixtureRoot, "cache"),
      pnpmPath: "pnpm",
    });
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(result.packageCount, 2);
  assert.equal(existsSync(sources), false);
  assert.match(await readFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "utf8"), /resolution: \{integrity:/);
  assert.doesNotMatch(await readFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "utf8"), /tarball:/);
  assert.equal(
    JSON.parse(await readFile(path.join(fixtureRoot, "node_modules", "@scope", "peer-fixture", "package.json"))).name,
    "@scope/peer-fixture",
  );
  await assertServerClosed(result.origin);
});
