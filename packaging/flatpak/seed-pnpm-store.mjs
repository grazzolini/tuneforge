import { createHash } from "node:crypto";
import { cpSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const pnpmStoreVersion = "v11";

function cleanYamlKey(key) {
  let cleaned = key.trim();
  if (cleaned.endsWith(":")) {
    cleaned = cleaned.slice(0, -1);
  }
  if (
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

export function parsePnpmPackageKey(key) {
  const withoutPeers = key.replace(/\(.+$/, "");
  const versionSeparator = withoutPeers.lastIndexOf("@");
  if (versionSeparator <= 0) {
    throw new Error(`Could not parse pnpm package key: ${key}`);
  }

  const name = withoutPeers.slice(0, versionSeparator);
  const version = withoutPeers.slice(versionSeparator + 1);
  const nameSegments = name.startsWith("@") ? name.slice(1).split("/") : name.split("/");
  const validName =
    nameSegments.length === (name.startsWith("@") ? 2 : 1) &&
    nameSegments.every((segment) => /^[a-z0-9][a-z0-9._~-]*$/i.test(segment));
  if (!validName || !/^[a-z0-9][a-z0-9.+_-]*$/i.test(version)) {
    throw new Error(`Unsafe pnpm package key: ${key}`);
  }

  return { name, version };
}

export function npmTarballUrl(name, version) {
  if (!name.startsWith("@")) {
    return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  }

  const [scope, packageName] = name.split("/");
  if (!scope || !packageName) {
    throw new Error(`Could not parse scoped npm package name: ${name}`);
  }
  return `https://registry.npmjs.org/${scope}/${packageName}/-/${packageName}-${version}.tgz`;
}

export function nodeTarballFileName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export function parsePnpmLock(contents) {
  const packagesStart = contents.indexOf("\npackages:\n");
  if (packagesStart === -1) {
    throw new Error("Could not find packages section in pnpm-lock.yaml");
  }

  const snapshotsStart = contents.indexOf("\nsnapshots:\n", packagesStart);
  const packagesBody = contents.slice(
    packagesStart + "\npackages:\n".length,
    snapshotsStart === -1 ? contents.length : snapshotsStart,
  );

  const packages = new Map();
  const packageByFileName = new Map();
  let currentKey = null;
  let currentBlock = [];

  function finishEntry() {
    if (!currentKey) {
      return;
    }

    const block = currentBlock.join("\n");
    const integrity = block.match(/integrity:\s*([^}\s]+)/)?.[1];
    if (!integrity) {
      return;
    }

    const parsed = parsePnpmPackageKey(currentKey);
    const key = `${parsed.name}@${parsed.version}`;
    if (packages.has(key)) {
      return;
    }

    const fileName = nodeTarballFileName(parsed.name, parsed.version);
    const existingKey = packageByFileName.get(fileName);
    if (existingKey && existingKey !== key) {
      throw new Error(`Flatpak pnpm tarball filename collision: ${existingKey} and ${key}`);
    }
    packageByFileName.set(fileName, key);
    packages.set(key, {
      ...parsed,
      integrity,
      url: npmTarballUrl(parsed.name, parsed.version),
      fileName,
    });
  }

  for (const line of packagesBody.split("\n")) {
    if (line.startsWith("  ") && !line.startsWith("    ") && line.trim().endsWith(":")) {
      finishEntry();
      currentKey = cleanYamlKey(line);
      currentBlock = [];
      continue;
    }

    if (currentKey) {
      currentBlock.push(line);
    }
  }
  finishEntry();

  return Array.from(packages.values()).sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

function resolveTarballs(packages, tarballRoot) {
  const root = realpathSync(tarballRoot);
  return new Map(packages.map((pkg) => {
    const tarballPath = realpathSync(path.join(root, pkg.fileName));
    if (path.dirname(tarballPath) !== root || !statSync(tarballPath).isFile()) {
      throw new Error(`Unsafe pnpm tarball path: ${tarballPath}`);
    }
    return [new URL(pkg.url).pathname, tarballPath];
  }));
}

export function assertTarballIntegrity(packages, tarballs) {
  for (const pkg of packages) {
    const [algorithm, expected] = pkg.integrity.split("-", 2);
    const tarballPath = tarballs.get(new URL(pkg.url).pathname);
    if (!algorithm || !expected || !tarballPath || createHash(algorithm).update(readFileSync(tarballPath)).digest("base64") !== expected) {
      throw new Error(`Flatpak pnpm tarball integrity mismatch: ${pkg.name}@${pkg.version}`);
    }
  }
}

function optionalLstat(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertDirectory(filePath, label) {
  const stats = optionalLstat(filePath);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Malformed pnpm ${label}: expected a directory.`);
  }
}

function assertRegularFile(filePath, errorMessage) {
  const stats = optionalLstat(filePath);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) throw new Error(errorMessage);
}

function assertIndexIntegrity(indexPath) {
  let database;
  try {
    database = new DatabaseSync(`${pathToFileURL(indexPath).href}?immutable=1`, { readOnly: true });
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0]).at(0) !== "ok") {
      throw new Error("pnpm index integrity check did not return ok.");
    }
  } catch (error) {
    throw new Error(`Malformed pnpm index database: ${error.message}`);
  } finally {
    database?.close();
  }
}

export function validatePnpmStore(storeDir, { requireContent = false } = {}) {
  assertDirectory(storeDir, "store root");
  const versionRoot = path.join(storeDir, pnpmStoreVersion);
  if (!optionalLstat(versionRoot)) {
    if (readdirSync(storeDir).length !== 0) {
      throw new Error(`Malformed pnpm store root layout: expected only ${pnpmStoreVersion}.`);
    }
    if (requireContent) throw new Error("pnpm store is not populated.");
    return { pristine: true, contentFiles: 0, indexIntegrity: "empty" };
  }

  assertDirectory(versionRoot, `${pnpmStoreVersion} store root`);
  const unexpectedRootEntry = readdirSync(storeDir).find((entry) => entry !== pnpmStoreVersion);
  if (unexpectedRootEntry) throw new Error(`Malformed pnpm store root layout: ${unexpectedRootEntry}.`);
  const allowedEntries = new Set(["files", "projects", "index.db", "index.db-shm", "index.db-wal"]);
  const unexpectedEntry = readdirSync(versionRoot).find((entry) => !allowedEntries.has(entry));
  if (unexpectedEntry) throw new Error(`Malformed pnpm ${pnpmStoreVersion} store layout: ${unexpectedEntry}.`);

  const filesRoot = path.join(versionRoot, "files");
  assertDirectory(filesRoot, `${pnpmStoreVersion} content root`);
  if (optionalLstat(path.join(versionRoot, "projects"))) {
    assertDirectory(path.join(versionRoot, "projects"), `${pnpmStoreVersion} projects root`);
  }
  assertRegularFile(path.join(versionRoot, "index.db"), "Malformed pnpm index database: expected a regular file.");
  for (const sidecar of ["index.db-shm", "index.db-wal"]) {
    const sidecarPath = path.join(versionRoot, sidecar);
    if (optionalLstat(sidecarPath)) assertRegularFile(sidecarPath, `Malformed pnpm index sidecar: ${sidecar}.`);
  }

  let contentFiles = 0;
  for (const prefix of readdirSync(filesRoot)) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) {
      throw new Error(`Malformed pnpm content directory: ${prefix}.`);
    }
    const prefixPath = path.join(filesRoot, prefix);
    assertDirectory(prefixPath, `content directory ${prefix}`);
    const entries = readdirSync(prefixPath);
    for (const entry of entries) {
      const match = /^([a-f0-9]{126})(-exec)?$/.exec(entry);
      const entryPath = path.join(prefixPath, entry);
      const stats = optionalLstat(entryPath);
      if (!match || !stats?.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Malformed pnpm content entry: ${prefix}/${entry}.`);
      }
      if (match[2] && (stats.mode & 0o111) === 0) {
        throw new Error(`Malformed pnpm executable content entry: ${prefix}/${entry}.`);
      }
      if (!match[2] && (stats.mode & 0o111) !== 0) {
        throw new Error(`Malformed pnpm non-executable content entry: ${prefix}/${entry}.`);
      }
      const digest = createHash("sha512").update(readFileSync(entryPath)).digest("hex");
      if (digest !== `${prefix}${match[1]}`) {
        throw new Error(`pnpm content integrity mismatch: ${prefix}/${entry}.`);
      }
      contentFiles += 1;
    }
  }
  if (contentFiles === 0) throw new Error("pnpm store is partially initialized without content files.");

  const indexPath = path.join(versionRoot, "index.db");
  assertIndexIntegrity(indexPath);
  return { pristine: false, contentFiles, indexIntegrity: "ok" };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

export async function seedPnpmStore({
  lockfilePath = "pnpm-lock.yaml",
  tarballRoot,
  storeDir,
  cacheDir,
  pnpmPath = "/app/bin/pnpm",
  reportPath,
}) {
  const packages = parsePnpmLock(readFileSync(lockfilePath, "utf8"));
  const tarballs = resolveTarballs(packages, tarballRoot);
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  assertTarballIntegrity(packages, tarballs);
  const initialStore = validatePnpmStore(storeDir);
  const frozenStoreArgs = initialStore.pristine ? [] : ["--frozen-store"];
  let snapshotRoot;
  let activeStoreDir = storeDir;
  let activeCacheDir = cacheDir;
  if (!initialStore.pristine) {
    snapshotRoot = mkdtempSync(path.join(os.tmpdir(), "tuneforge-pnpm-store-"));
    activeStoreDir = path.join(snapshotRoot, "store");
    activeCacheDir = path.join(snapshotRoot, "cache");
    try {
      cpSync(storeDir, activeStoreDir, { recursive: true, dereference: false, verbatimSymlinks: true });
      cpSync(cacheDir, activeCacheDir, { recursive: true, dereference: false, verbatimSymlinks: true });
    } catch (error) {
      rmSync(snapshotRoot, { force: true, recursive: true });
      throw error;
    }
  }
  try {
  const versionsByName = new Map();
  for (const pkg of packages) {
    const versions = versionsByName.get(pkg.name) ?? new Map();
    versions.set(pkg.version, pkg);
    versionsByName.set(pkg.name, versions);
  }

  let origin;
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, origin).pathname);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }

    const tarballPath = tarballs.get(pathname);
    if (tarballPath) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(tarballPath);
      stream.once("error", () => response.destroy());
      stream.pipe(response);
      return;
    }

    const packageName = pathname.slice(1);
    const versions = versionsByName.get(packageName);
    if (!versions) {
      response.writeHead(404);
      response.end();
      return;
    }

    const metadata = {
      name: packageName,
      versions: Object.fromEntries(
        Array.from(versions, ([version, pkg]) => [
          version,
          {
            name: packageName,
            version,
            dist: {
              integrity: pkg.integrity,
              tarball: `${origin}${new URL(pkg.url).pathname}`,
            },
          },
        ]),
      ),
    };
    const body = JSON.stringify(metadata);
    response.writeHead(200, {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await close(server);
    throw new Error("Flatpak pnpm registry did not bind exclusively to 127.0.0.1");
  }
  origin = `http://127.0.0.1:${address.port}`;

  try {
    await run(pnpmPath, [
      `--config.registry=${origin}/`,
      `--config.store-dir=${activeStoreDir}`,
      `--config.cache-dir=${activeCacheDir}`,
      "--config.fetch-retries=0",
      "--config.package-import-method=copy",
      ...frozenStoreArgs,
      "fetch",
      "--frozen-lockfile",
    ]);
  } finally {
    await close(server);
  }

  assertTarballIntegrity(packages, tarballs);
  rmSync(tarballRoot, { recursive: true });
  await run(pnpmPath, [
    `--config.registry=${origin}/`,
    `--config.store-dir=${activeStoreDir}`,
    `--config.cache-dir=${activeCacheDir}`,
    "--config.fetch-retries=0",
    "--config.package-import-method=copy",
    "--frozen-store",
    "install",
    "--offline",
    "--frozen-lockfile",
  ]);
  const storeValidation = validatePnpmStore(activeStoreDir, { requireContent: true });
  await run(pnpmPath, [
    `--config.store-dir=${activeStoreDir}`,
    `--config.cache-dir=${activeCacheDir}`,
    "store",
    "status",
  ]);

  process.stdout.write(`Installed from an isolated pnpm store with ${packages.length} packages.\n`);
  const report = {
    origin: "loopback",
    packageCount: packages.length,
    tarballIntegrityChecks: 2,
    storeIntegrityChecks: 2,
    storeStatusChecks: 1,
    ...storeValidation,
  };
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, origin };
  } finally {
    if (snapshotRoot) rmSync(snapshotRoot, { force: true, recursive: true });
  }
}

async function main() {
  const [tarballRoot, storeDir, cacheDir, pnpmPath, reportPath] = process.argv.slice(2);
  if (!tarballRoot || !storeDir || !cacheDir) {
    throw new Error(
      "Usage: node seed-pnpm-store.mjs <tarball-root> <store-dir> <cache-dir> [pnpm-path]",
    );
  }
  await seedPnpmStore({ tarballRoot, storeDir, cacheDir, pnpmPath, reportPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
