import { createReadStream, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
}) {
  const packages = parsePnpmLock(readFileSync(lockfilePath, "utf8"));
  const tarballs = resolveTarballs(packages, tarballRoot);
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
      `--config.store-dir=${storeDir}`,
      `--config.cache-dir=${cacheDir}`,
      "--config.fetch-retries=0",
      "fetch",
      "--frozen-lockfile",
    ]);
  } finally {
    await close(server);
  }

  rmSync(tarballRoot, { recursive: true });
  await run(pnpmPath, [
    `--config.registry=${origin}/`,
    `--config.store-dir=${storeDir}`,
    `--config.cache-dir=${cacheDir}`,
    "--config.fetch-retries=0",
    "install",
    "--offline",
    "--frozen-lockfile",
  ]);

  process.stdout.write(`Installed from an isolated pnpm store with ${packages.length} packages.\n`);
  return { origin, packageCount: packages.length };
}

async function main() {
  const [tarballRoot, storeDir, cacheDir, pnpmPath] = process.argv.slice(2);
  if (!tarballRoot || !storeDir || !cacheDir) {
    throw new Error(
      "Usage: node seed-pnpm-store.mjs <tarball-root> <store-dir> <cache-dir> [pnpm-path]",
    );
  }
  await seedPnpmStore({ tarballRoot, storeDir, cacheDir, pnpmPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
