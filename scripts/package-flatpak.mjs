import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeBuildInfoFile, writeResolvedBuildInfoFile } from "./build-info.mjs";
import {
  packageOptionsEnvironment,
  packageOptionsToGeneratorArgs,
  parsePackageOptions,
  printModelBundleWarning,
} from "./package-options.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const flatpakRoot = path.join(workspaceRoot, "packaging", "flatpak");
const baseManifestPath = path.join(flatpakRoot, "com.tuneforge.desktop.yml");
const flatpakVersionInfoPath = path.join(flatpakRoot, "generated", "version.json");
const frontendVersionInfoPath = path.join(flatpakRoot, "generated", "frontend-version.json");
const appId = "com.tuneforge.desktop";
const localRepoRemote = "tuneforge-local";
const cacheSchema = "flatpak-cache-v1";
const sizeReportSchema = "flatpak-size-v1";
const gibibyte = 1024 ** 3;
const flatpakBundleHardLimitBytes = 2 * gibibyte;
const flatpakBundleTargetBytes = 1.9 * gibibyte;
const buildDir = process.env.FLATPAK_BUILD_DIR ?? path.join(flatpakRoot, "build-dir");
const repoDir = process.env.FLATPAK_REPO_DIR ?? path.join(flatpakRoot, "repo");
const appVersion = JSON.parse(
  readFileSync(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
).version;
const bundlePath =
  process.env.FLATPAK_BUNDLE_PATH ??
  path.join(flatpakRoot, `Tuneforge_${appVersion}_x86_64.flatpak`);
export const frontendModuleInputPaths = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/build-info.mjs",
  "packaging/flatpak/seed-pnpm-store.mjs", "apps/desktop/package.json",
  "apps/desktop/index.html", "apps/desktop/tsconfig.json", "apps/desktop/tsconfig.node.json",
  "apps/desktop/vite.config.ts", "apps/desktop/src", "packages/shared-types/package.json", "packages/shared-types/src",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });

  if (result.error?.code === "ENOENT") {
    throw new Error(`Required command not found: ${command}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function checkCommand(command, installHint) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required. ${installHint}`);
  }
  if (result.status !== 0) {
    throw new Error(`Could not run ${command} --version`);
  }
}

function generatedManifestPath(options, cacheRoot, namespace, frontendGitRef) {
  const generatedManifestPath = path.join(flatpakRoot, "com.tuneforge.desktop.generated.yml");
  const baseManifest = readFileSync(baseManifestPath, "utf8");
  let manifest = manifestWithPackageOptions(baseManifest, options);
  manifest = manifest
    .replaceAll('"@@FLATPAK_CACHE_BIND@@"', JSON.stringify(`--bind-mount=/run/tuneforge-cache=${cacheRoot}`))
    .replaceAll("@@FLATPAK_CACHE_NAMESPACE@@", namespace);
  manifest = replaceManifestFragment(
    manifest,
    "@@TUNEFORGE_FRONTEND_GIT_REF@@",
    frontendGitRef.replaceAll("'", "''"),
  );
  if (options.legacyNvidia) {
    manifest = replaceManifestFragment(manifest, "  - --device=dri\n", "  - --device=all\n");
  }
  if (options.sandboxData) {
    manifest = replaceManifestFragment(manifest, "  - --filesystem=xdg-data/tuneforge:create\n", "");
    manifest = replaceManifestFragment(
      manifest,
      "  - --env=TUNEFORGE_DATA_DIR=~/.local/share/tuneforge\n",
      "  - --env=TUNEFORGE_DATA_DIR=/var/data/tuneforge\n",
    );
  }
  if (options.modelBundle || options.crema === "onnx") {
    manifest = replaceManifestFragment(
      manifest,
      "  - --env=TUNEFORGE_LYRICS_CACHE_DIR=~/.cache/whisper\n",
      "  - --env=TUNEFORGE_LYRICS_CACHE_DIR=~/.cache/whisper\n" +
        "  - --env=TUNEFORGE_MODEL_BUNDLE_DIR=/app/lib/tuneforge/backend/models/bundle\n",
    );
    manifest = replaceManifestFragment(
      manifest,
      "      - type: file\n" +
        "        path: generated/version.json\n",
      "      - type: file\n" +
        "        path: generated/version.json\n" +
        "      - generated/model-bundle-sources.json\n" +
        "      - type: file\n" +
        "        path: generated/model-bundle-manifest.json\n" +
        "        dest: model-bundle\n" +
        "        dest-filename: manifest.json\n",
    );
    manifest = replaceManifestFragment(
      manifest,
      "      - install -Dm644 apps/backend/pyproject.toml /app/lib/tuneforge/backend/src/pyproject.toml\n",
      "      - install -Dm644 apps/backend/pyproject.toml /app/lib/tuneforge/backend/src/pyproject.toml\n" +
        "      - install -dm755 /app/lib/tuneforge/backend/models/bundle\n" +
        "      - cp -a model-bundle/. /app/lib/tuneforge/backend/models/bundle/\n",
    );
  }

  const imports = ["fastapi", "demucs", "whisper", "torch"];
  if (options.crema === "onnx") {
    imports.push("onnxruntime");
  }
  if (options.beatThis) {
    imports.push("beat_this");
  }
  if (options.lvChordia) {
    imports.push("lv_chordia");
  }
  const lvChordiaValidation = options.lvChordia
    ? "      - PYTHONPATH=/app/lib/tuneforge/backend/src:/app/lib/tuneforge/backend/site-packages /app/lib/tuneforge/backend/python/bin/python3.14 -c \"from pathlib import Path; from app.engines.lv_chordia import lv_chordia_dependency_status; files=list(Path('/app/lib/tuneforge/backend').rglob('*.sdict')); assert len(files)==5, len(files); assert lv_chordia_dependency_status()[0]\"\n"
    : "      - /app/lib/tuneforge/backend/python/bin/python3.14 -c \"from pathlib import Path; files=list(Path('/app/lib/tuneforge/backend').rglob('*.sdict')); assert not files, files\"\n";
  manifest = replaceManifestFragment(
    manifest,
    '      - /app/lib/tuneforge/backend/python/bin/python3.14 -c "import fastapi, demucs, whisper, torch"\n',
    `      - /app/lib/tuneforge/backend/python/bin/python3.14 -c "import ${imports.join(", ")}"\n` +
      lvChordiaValidation,
  );
  mkdirSync(path.dirname(generatedManifestPath), { recursive: true });
  writeFileSync(generatedManifestPath, manifest);
  return generatedManifestPath;
}

export function manifestWithPackageOptions(manifest, options) {
  const encodedPackageOptions = packageOptionsEnvironment(options).TUNEFORGE_PACKAGE_OPTIONS;
  const tuneforgeEnvAnchor =
    "  - name: tuneforge-frontend\n" +
    "    buildsystem: simple\n" +
    "    build-options:\n" +
    "      append-path: /app/bin:/usr/lib/sdk/node26/bin\n" +
    "      build-args:\n" +
    '        - "@@FLATPAK_CACHE_BIND@@"\n' +
    "      env:\n";
  let result = replaceManifestFragment(
    manifest,
    tuneforgeEnvAnchor,
    `${tuneforgeEnvAnchor}        TUNEFORGE_PACKAGE_OPTIONS: '${encodedPackageOptions}'\n`,
  );
  result = replaceManifestFragment(
    result,
    "      - generated/python-sources.json\n" +
      "      - type: file\n" +
      "        path: generated/python-requirements.txt\n",
    "      - generated/python-sources.json\n" +
      "      - type: file\n" +
      "        path: generated/python-build-requirements.txt\n" +
      "      - type: file\n" +
      "        path: generated/python-requirements.txt\n",
  );
  result = replaceManifestFragment(
    result,
    "      - /app/lib/tuneforge/backend/python/bin/python3.14 -m pip install --no-index --find-links=python-sources --target=/app/lib/tuneforge/backend/site-packages setuptools wheel\n",
    "      - /app/lib/tuneforge/backend/python/bin/python3.14 -m pip install --no-index --find-links=python-sources --target=/app/lib/tuneforge/backend/site-packages -r python-build-requirements.txt\n",
  );
  if (options.lvChordia) {
    const runtimeInstall =
      "      - /app/lib/tuneforge/backend/python/bin/python3.14 -m pip install --no-index --no-build-isolation --find-links=python-sources --target=/app/lib/tuneforge/backend/site-packages -r python-requirements.txt\n";
    const lvChordiaRuntimeInstall =
      "      - /app/lib/tuneforge/backend/python/bin/python3.14 -m pip install --no-index --no-deps --no-build-isolation --find-links=python-sources --target=/app/lib/tuneforge/backend/site-packages -r python-requirements.txt\n";
    result = replaceManifestFragment(
      result,
      runtimeInstall,
      lvChordiaRuntimeInstall +
        "      - install -dm755 /app/lib/tuneforge/backend/python/share/lv-chordia\n" +
        "      - test -d /app/lib/tuneforge/backend/site-packages/share/lv-chordia/cache_data\n" +
        "      - mv /app/lib/tuneforge/backend/site-packages/share/lv-chordia/cache_data /app/lib/tuneforge/backend/python/share/lv-chordia/cache_data\n",
    );
  }
  return result;
}

function replaceManifestFragment(contents, search, replacement) {
  if (!contents.includes(search)) {
    throw new Error(`Could not find expected Flatpak manifest fragment: ${search.trim()}`);
  }
  return contents.replace(search, replacement);
}

function gitOutput(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function validatedSourceDateEpoch(value, label) {
  const epoch = Number(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(epoch) || epoch > 253402300799) {
    throw new Error(`${label} must be a positive integer Unix timestamp.`);
  }
  return value;
}

export function resolveSourceDateEpoch({
  root = workspaceRoot,
  override = process.env.SOURCE_DATE_EPOCH,
} = {}) {
  if (override !== undefined) return validatedSourceDateEpoch(override, "SOURCE_DATE_EPOCH");
  const commitEpoch = gitOutput(["log", "-1", "--format=%ct", "HEAD"], root);
  return commitEpoch ? validatedSourceDateEpoch(commitEpoch, "Git HEAD commit timestamp") : "1";
}

export function normalizeGeneratedModelBundleManifest({
  filePath = path.join(flatpakRoot, "generated", "model-bundle-manifest.json"),
  sourceDateEpoch,
} = {}) {
  if (!existsSync(filePath)) return false;
  const manifest = readJson(filePath);
  if (!manifest || typeof manifest !== "object" || typeof manifest.prepared_at !== "string") throw new Error("Malformed generated model bundle manifest.");
  const epoch = validatedSourceDateEpoch(sourceDateEpoch, "SOURCE_DATE_EPOCH");
  manifest.prepared_at = new Date(Number(epoch) * 1_000).toISOString();
  writeJson(filePath, manifest);
  return true;
}

export function resolveFrontendGitRef({
  root = workspaceRoot,
  override = process.env.TUNEFORGE_FRONTEND_GIT_REF,
  inputPaths = frontendModuleInputPaths,
} = {}) {
  if (override?.trim()) {
    return override.trim();
  }
  const commit = gitOutput(["log", "-1", "--format=%H", "--", ...inputPaths], root);
  const base = commit && gitOutput(["describe", "--tags", "--long", "--always", "--abbrev=8", commit], root);
  if (!base) {
    return "unknown";
  }
  const dirty = gitOutput(["status", "--porcelain=v1", "--untracked-files=all", "--", ...inputPaths], root);
  return dirty ? `${base}-dirty` : base;
}

export function cacheNamespace(options, version = appVersion) {
  const inputs = {
    schema: cacheSchema,
    app: `${appId}@${version}`,
    arch: "x86_64",
    runtime: "org.gnome.Platform/50",
    tools: "node26-llvm20-rust-stable-pnpm11.22.0-sccache0.17.0",
    profile: packageOptionsEnvironment(options).TUNEFORGE_PACKAGE_OPTIONS,
  };
  const digest = createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
  return { name: `${cacheSchema}-${digest}`, inputs };
}

function pathsOverlap(left, right) {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveCacheRoots({
  stateRoot = process.env.FLATPAK_STATE_DIR ?? path.join(workspaceRoot, ".flatpak-builder", "tuneforge-state"),
  cacheRoot = process.env.FLATPAK_CACHE_DIR ?? path.join(workspaceRoot, ".flatpak-builder", "tuneforge-cache"),
  outputRoots = [buildDir, repoDir],
} = {}) {
  const roots = { stateRoot: path.resolve(stateRoot), cacheRoot: path.resolve(cacheRoot) };
  const unsafe = [path.parse(workspaceRoot).root, workspaceRoot, flatpakRoot, process.env.HOME].filter(Boolean);
  for (const [label, root] of Object.entries(roots)) {
    if (unsafe.includes(root) || outputRoots.some((output) => pathsOverlap(root, output) || pathsOverlap(output, root))) {
      throw new Error(`Unsafe Flatpak ${label}: it overlaps a packaging or force-clean output root.`);
    }
  }
  if (pathsOverlap(roots.stateRoot, roots.cacheRoot) || pathsOverlap(roots.cacheRoot, roots.stateRoot)) {
    throw new Error("FLATPAK_STATE_DIR and FLATPAK_CACHE_DIR must not overlap.");
  }
  return roots;
}

function numericTotal(value, label) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (value && typeof value === "object") {
    return Object.values(value).reduce((total, entry) => total + numericTotal(entry, label), 0);
  }
  throw new Error(`Malformed sccache ${label} statistics.`);
}

export function parseSccacheStats(contents) {
  let parsed;
  try {
    parsed = typeof contents === "string" ? JSON.parse(contents) : contents;
  } catch {
    throw new Error("Malformed sccache JSON statistics.");
  }
  const stats = parsed?.stats ?? parsed;
  if (!stats || typeof stats !== "object") throw new Error("Malformed sccache JSON statistics.");
  const metrics = {
    compileRequests: numericTotal(stats.compile_requests, "compile_requests"),
    cacheHits: numericTotal(stats.cache_hits?.counts ?? stats.cache_hits, "cache_hits"),
    cacheMisses: numericTotal(stats.cache_misses?.counts ?? stats.cache_misses, "cache_misses"),
    cacheErrors: numericTotal(stats.cache_errors?.counts ?? stats.cache_errors, "cache_errors") + numericTotal(stats.cache_read_errors ?? 0, "cache_read_errors") + numericTotal(stats.cache_write_errors ?? 0, "cache_write_errors"),
    compileFailures: numericTotal(stats.compile_fails ?? 0, "compile_fails"),
    notCacheable: numericTotal(stats.requests_not_cacheable ?? 0, "requests_not_cacheable"),
  };
  if (metrics.cacheErrors !== 0) throw new Error(`sccache reported ${metrics.cacheErrors} cache errors.`);
  return metrics;
}

function fileSha256(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0;
      bytes = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function digestBuildPayload(root) {
  const entries = [];
  function visit(relativePath) {
    const absolutePath = path.join(root, relativePath);
    const stats = lstatSync(absolutePath);
    const entry = { path: relativePath.split(path.sep).join("/"), mode: (stats.mode & 0o7777).toString(8) };
    if (stats.isSymbolicLink()) entries.push({ ...entry, type: "symlink", target: readlinkSync(absolutePath) });
    else if (stats.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const child of readdirSync(absolutePath).sort()) visit(path.join(relativePath, child));
    } else if (stats.isFile()) entries.push({ ...entry, type: "file", size: stats.size, sha256: fileSha256(absolutePath) });
    else throw new Error(`Unsupported Flatpak payload entry type: ${relativePath}`);
  }
  for (const child of readdirSync(root).sort()) visit(child);
  return {
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entryCount: entries.length,
  };
}

export function compareCacheReports(cold, warm) {
  const errors = [...(cold.errors ?? []), ...(warm.errors ?? [])];
  if (cold.namespace !== warm.namespace) errors.push("Cold and warm cache namespaces differ.");
  if (cold.payload?.sha256 !== warm.payload?.sha256) errors.push("Cold and warm payload digests differ.");
  return { schema: cacheSchema, equivalent: errors.length === 0, errors, cold: cold.payload, warm: warm.payload };
}

function bytesToBinaryUnit(bytes) {
  if (bytes >= gibibyte) return `${(bytes / gibibyte).toFixed(2)} GiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function directorySize(targetPath) {
  const stats = lstatSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.size;
  }
  return readdirSync(targetPath).reduce(
    (total, childName) => total + directorySize(path.join(targetPath, childName)),
    0,
  );
}

function directoryRows(rootPath, reportPath) {
  if (!existsSync(rootPath)) return [];
  return readdirSync(rootPath)
    .map((name) => {
      const targetPath = path.join(rootPath, name);
      return { path: `${reportPath}/${name}`, bytes: directorySize(targetPath) };
    })
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
    .map(({ path: entryPath, bytes }) => ({ path: entryPath, bytes }));
}

function sizeEvidence(targetPath, reportPath) {
  if (!existsSync(targetPath)) return { path: reportPath, available: false };
  return { path: reportPath, available: true, bytes: directorySize(targetPath) };
}

function pythonArtifactEvidence(artifacts) {
  const entries = artifacts
    .map(({ name, version, fileName, size }) => ({ name, version, fileName, bytes: size ?? null }))
    .sort((left, right) => (right.bytes ?? -1) - (left.bytes ?? -1) || left.name.localeCompare(right.name));
  const unknownCount = entries.filter((entry) => entry.bytes === null).length;
  return {
    knownBytes: entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    unknownCount,
    complete: unknownCount === 0,
    entries,
  };
}

function compressedBundleEvidence(bundle, includeBundle) {
  if (!includeBundle || !existsSync(bundle)) return { path: path.basename(bundle), available: false };
  const stats = statSync(bundle);
  if (!stats.isFile()) throw new Error(`Flatpak bundle target must be a regular file: ${bundle}`);
  return { path: path.basename(bundle), available: true, bytes: stats.size };
}

export function flatpakSizeReport({
  buildRoot = buildDir,
  bundle = bundlePath,
  wheelReportPath = path.join(flatpakRoot, "generated", "python-size-report.json"),
  includeBundle = true,
} = {}) {
  const appFilesRoot = path.join(buildRoot, "files");
  const pythonRuntimeRoot = path.join(appFilesRoot, "lib", "tuneforge", "backend", "python");
  const sitePackagesRoot = path.join(appFilesRoot, "lib", "tuneforge", "backend", "site-packages");
  const pythonArtifacts = existsSync(wheelReportPath) ? readJson(wheelReportPath) : [];
  const compressedBundle = compressedBundleEvidence(bundle, includeBundle);
  const report = {
    schema: sizeReportSchema,
    unit: "bytes",
    compressedBundle,
    installedApp: {
      ...sizeEvidence(appFilesRoot, "/app"),
      topLevelDirectories: directoryRows(appFilesRoot, "/app"),
    },
    pythonRuntime: sizeEvidence(pythonRuntimeRoot, "/app/lib/tuneforge/backend/python"),
    sitePackages: sizeEvidence(sitePackagesRoot, "/app/lib/tuneforge/backend/site-packages"),
    wheelInputs: pythonArtifactEvidence(pythonArtifacts.filter((entry) => entry.fileName.endsWith(".whl"))),
    sourceArchives: pythonArtifactEvidence(pythonArtifacts.filter((entry) => !entry.fileName.endsWith(".whl"))),
  };
  if (compressedBundle.available) {
    report.compliance = {
      hardLimitBytes: flatpakBundleHardLimitBytes,
      hardLimitPassed: compressedBundle.bytes < flatpakBundleHardLimitBytes,
      targetBytes: flatpakBundleTargetBytes,
      targetMet: compressedBundle.bytes <= flatpakBundleTargetBytes,
    };
  }
  return report;
}

export function enforceFlatpakBundleSize(report) {
  if (!report.compressedBundle.available) return;
  if (report.compressedBundle.bytes >= flatpakBundleHardLimitBytes) {
    throw new Error(`Flatpak bundle ${bytesToBinaryUnit(report.compressedBundle.bytes)} exceeds the 2 GiB hard limit.`);
  }
  if (!report.compliance.targetMet) {
    process.stderr.write(
      `Flatpak bundle ${bytesToBinaryUnit(report.compressedBundle.bytes)} is below the hard limit but misses the 1.9 GiB target; issue #490 remains incomplete.\n`,
    );
  }
}

function printFlatpakSizeReport(report) {
  process.stdout.write("Flatpak size report (binary bytes):\n");
  for (const entry of report.installedApp.topLevelDirectories) {
    process.stdout.write(`  ${bytesToBinaryUnit(entry.bytes).padStart(10)} ${entry.path}\n`);
  }
  if (report.compressedBundle.available) {
    process.stdout.write(`  ${bytesToBinaryUnit(report.compressedBundle.bytes).padStart(10)} ${report.compressedBundle.path}\n`);
  }
}

function readJson(targetPath) {
  return JSON.parse(readFileSync(targetPath, "utf8"));
}

function writeJson(targetPath, value) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function isValidPnpmCacheReport(pnpm) {
  return Boolean(
    pnpm &&
    pnpm.origin === "loopback" &&
    Number.isInteger(pnpm.packageCount) && pnpm.packageCount >= 1 &&
    pnpm.tarballIntegrityChecks === 2 &&
    pnpm.storeIntegrityChecks === 2 &&
    pnpm.storeStatusChecks === 1 &&
    Number.isInteger(pnpm.contentFiles) && pnpm.contentFiles >= 1 &&
    pnpm.indexIntegrity === "ok",
  );
}

function cacheReport({ namespace, inputs, cacheRoot, timings, evidence }) {
  const namespaceRoot = path.join(cacheRoot, namespace);
  const pnpmPath = path.join(namespaceRoot, "pnpm-report.json");
  const sccachePath = path.join(namespaceRoot, "sccache-stats.json");
  const pnpm = existsSync(pnpmPath) ? readJson(pnpmPath) : null;
  const sccache = existsSync(sccachePath) ? parseSccacheStats(readFileSync(sccachePath, "utf8")) : null;
  if (evidence && (!pnpm || !sccache)) {
    throw new Error("Flatpak cache evidence mode requires frontend and desktop modules to execute.");
  }
  if (pnpm && !isValidPnpmCacheReport(pnpm)) {
    throw new Error("Malformed Flatpak pnpm integrity report.");
  }
  return {
    schema: cacheSchema,
    namespace,
    namespaceInputs: inputs,
    modules: { frontend: pnpm ? "executed" : "cached", desktop: sccache ? "executed" : "cached" },
    pnpm: pnpm ?? { status: "module-cached" },
    sccache: sccache ?? { status: "module-cached" },
    timings,
    payload: digestBuildPayload(path.join(buildDir, "files")),
    errors: [],
  };
}

function main() {
  const startedAt = performance.now();
  const packageOptions = parsePackageOptions(process.argv.slice(2), { platform: "linux" });
  const skipBundle = packageOptions.noBundle || process.env.FLATPAK_NO_BUNDLE === "1";
  const evidence = process.env.FLATPAK_CACHE_EVIDENCE === "1";
  if (process.arch !== "x64") {
    throw new Error("TuneForge Flatpak packaging currently targets Linux x86_64 only.");
  }
  if (!existsSync(baseManifestPath)) {
    throw new Error(`Flatpak manifest not found at ${baseManifestPath}`);
  }
  if (packageOptions.modelBundle) {
    printModelBundleWarning();
  }

  const namespace = cacheNamespace(packageOptions);
  const sourceDateEpoch = resolveSourceDateEpoch();
  const { stateRoot, cacheRoot } = resolveCacheRoots();
  const stateDir = path.join(stateRoot, namespace.name);
  const namespaceRoot = path.join(cacheRoot, namespace.name);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(namespaceRoot, { recursive: true });
  rmSync(path.join(namespaceRoot, "pnpm-report.json"), { force: true });
  rmSync(path.join(namespaceRoot, "sccache-stats.json"), { force: true });

  const sourceStartedAt = performance.now();
  run(process.execPath, [
    path.join("scripts", "generate-flatpak-sources.mjs"),
    ...packageOptionsToGeneratorArgs(packageOptions),
  ]);
  normalizeGeneratedModelBundleManifest({ sourceDateEpoch });
  const frontendGitRef = resolveFrontendGitRef();
  const installedBuildInfo = writeBuildInfoFile(flatpakVersionInfoPath, { workspaceRoot });
  installedBuildInfo.frontend.git_ref = frontendGitRef;
  writeResolvedBuildInfoFile(flatpakVersionInfoPath, installedBuildInfo);
  writeResolvedBuildInfoFile(frontendVersionInfoPath, {
    backend: { ...installedBuildInfo.frontend },
    frontend: { ...installedBuildInfo.frontend },
  });
  const manifestPath = generatedManifestPath(packageOptions, cacheRoot, namespace.name, frontendGitRef);
  const sourceSeconds = (performance.now() - sourceStartedAt) / 1_000;

  checkCommand(
    "flatpak-builder",
    "Install flatpak-builder and the Flathub runtimes before running pnpm package:linux:flatpak.",
  );
  checkCommand("flatpak", "Install flatpak before running pnpm package:linux:flatpak.");

  const builderArgs = [
    "--force-clean",
    `--state-dir=${stateDir}`,
    `--override-source-date-epoch=${sourceDateEpoch}`,
    "--arch=x86_64",
    "--default-branch=stable",
    "--install-deps-from=flathub",
    "--repo",
    repoDir,
    buildDir,
    manifestPath,
  ];
  if (evidence) builderArgs.unshift("--disable-cache");
  const builderStartedAt = performance.now();
  run("flatpak-builder", builderArgs);
  const report = cacheReport({
    namespace: namespace.name,
    inputs: namespace.inputs,
    cacheRoot,
    evidence,
    timings: {
      sourceGenerationSeconds: Number(sourceSeconds.toFixed(3)),
      builderSeconds: Number(((performance.now() - builderStartedAt) / 1_000).toFixed(3)),
      elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
    },
  });
  const reportPath = process.env.FLATPAK_CACHE_REPORT_PATH ?? path.join(flatpakRoot, "generated", "cache-report.json");
  writeJson(reportPath, report);
  const baselinePath = process.env.FLATPAK_CACHE_BASELINE_REPORT;
  if (baselinePath) {
    const comparison = compareCacheReports(readJson(baselinePath), report);
    const comparisonPath = process.env.FLATPAK_CACHE_COMPARISON_REPORT_PATH ??
      path.join(flatpakRoot, "generated", "cache-comparison-report.json");
    writeJson(comparisonPath, comparison);
    if (!comparison.equivalent) throw new Error(comparison.errors.join(" "));
  }
  if (skipBundle) {
    const sizeReportPath = process.env.FLATPAK_SIZE_REPORT_PATH ?? path.join(flatpakRoot, "generated", "size-report.json");
    const sizeReport = flatpakSizeReport({ includeBundle: false });
    writeJson(sizeReportPath, sizeReport);
    printFlatpakSizeReport(sizeReport);
    process.stdout.write(`Flatpak repo exported to ${repoDir}\n`);
    process.stdout.write(
      `Install with: flatpak remote-add --user --if-not-exists --no-gpg-verify ${localRepoRemote} ${repoDir}\n`,
    );
    process.stdout.write(`Then run: flatpak install --user --reinstall ${localRepoRemote} ${appId}\n`);
    return;
  }

  run("flatpak", ["build-bundle", "--arch=x86_64", repoDir, bundlePath, appId, "stable"]);
  const sizeReportPath = process.env.FLATPAK_SIZE_REPORT_PATH ?? path.join(flatpakRoot, "generated", "size-report.json");
  const sizeReport = flatpakSizeReport();
  writeJson(sizeReportPath, sizeReport);
  printFlatpakSizeReport(sizeReport);
  enforceFlatpakBundleSize(sizeReport);

  process.stdout.write(`Flatpak bundle written to ${bundlePath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
