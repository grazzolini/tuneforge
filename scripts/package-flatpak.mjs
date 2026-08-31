import { createHash, randomUUID } from "node:crypto";
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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeBuildInfoFile, writeResolvedBuildInfoFile } from "./build-info.mjs";
import {
  normalizeFlatpakProfiles,
  frontendPackageOptionsEnvironment,
  packageOptionsEnvironment,
  packageOptionsToGeneratorArgs,
  parsePackageOptions,
  printModelBundleWarning,
  validatePackageOptions,
} from "./package-options.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const flatpakRoot = path.join(workspaceRoot, "packaging", "flatpak");
const baseManifestPath = path.join(flatpakRoot, "com.tuneforge.desktop.yml");
const flatpakVersionInfoPath = path.join(flatpakRoot, "generated", "version.json");
const frontendVersionInfoPath = path.join(flatpakRoot, "generated", "frontend-version.json");
const appId = "com.tuneforge.desktop";
const nvidiaTorchCoreRef = `${appId}.Torch.Stack.Nvidia.Core`;
const nvidiaTorchRuntimeRef = `${appId}.Torch.Stack.Nvidia.Runtime`;
const legacyTorchCoreRef = `${appId}.Torch.Stack.LegacyNvidia.Core`;
const legacyTorchRuntimeRef = `${appId}.Torch.Stack.LegacyNvidia.Runtime`;
const torchProfileArtifacts = {
  nvidia: [
    { id: "nvidia-core", refId: nvidiaTorchCoreRef, module: "nvidia-torch-core-extension" },
    { id: "nvidia-runtime", refId: nvidiaTorchRuntimeRef, module: "nvidia-torch-runtime-extension" },
  ],
  "legacy-nvidia": [
    { id: "legacy-nvidia-core", refId: legacyTorchCoreRef, module: "legacy-nvidia-torch-core-extension" },
    { id: "legacy-nvidia-runtime", refId: legacyTorchRuntimeRef, module: "legacy-nvidia-torch-runtime-extension" },
  ],
};
const localRepoRemote = "tuneforge-local";
const cacheSchema = "flatpak-cache-v1";
const outputStateSchema = "flatpak-output-state-v1";
const bundleStateSchema = "flatpak-bundle-state-v1";
const sizeReportSchema = "flatpak-size-v1";
const bundleCommandContract = "flatpak build-bundle [--runtime] --arch=x86_64 <repository> <output> <ref-id> stable";
const gibibyte = 1024 ** 3;
const flatpakBundleHardLimitBytes = 2 * gibibyte;
const flatpakBundleTargetBytes = 1.9 * gibibyte;
const buildDir = process.env.FLATPAK_BUILD_DIR ?? path.join(flatpakRoot, "build-dir");
const repoDir = process.env.FLATPAK_REPO_DIR ?? path.join(flatpakRoot, "repo");
const appVersion = JSON.parse(
  readFileSync(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
).version;
const defaultBundlePath = path.join(flatpakRoot, `Tuneforge_${appVersion}_x86_64.flatpak`);
const defaultNvidiaTorchCoreBundlePath =
  path.join(flatpakRoot, `Tuneforge_${appVersion}_Torch_Nvidia_Core_x86_64.flatpak`);
const defaultNvidiaTorchRuntimeBundlePath =
  path.join(flatpakRoot, `Tuneforge_${appVersion}_Torch_Nvidia_Runtime_x86_64.flatpak`);
const defaultLegacyTorchCoreBundlePath =
  path.join(flatpakRoot, `Tuneforge_${appVersion}_Torch_LegacyNvidia_Core_x86_64.flatpak`);
const defaultLegacyTorchRuntimeBundlePath =
  path.join(flatpakRoot, `Tuneforge_${appVersion}_Torch_LegacyNvidia_Runtime_x86_64.flatpak`);
const bundlePath = process.env.FLATPAK_BUNDLE_PATH ?? defaultBundlePath;
const nvidiaTorchCoreBundlePath = process.env.FLATPAK_NVIDIA_TORCH_CORE_BUNDLE_PATH ??
  defaultNvidiaTorchCoreBundlePath;
const nvidiaTorchRuntimeBundlePath = process.env.FLATPAK_NVIDIA_TORCH_RUNTIME_BUNDLE_PATH ??
  defaultNvidiaTorchRuntimeBundlePath;
const legacyTorchCoreBundlePath = process.env.FLATPAK_LEGACY_TORCH_CORE_BUNDLE_PATH ??
  defaultLegacyTorchCoreBundlePath;
const legacyTorchRuntimeBundlePath = process.env.FLATPAK_LEGACY_TORCH_RUNTIME_BUNDLE_PATH ??
  defaultLegacyTorchRuntimeBundlePath;
const configuredBundlePaths = [
  bundlePath, nvidiaTorchCoreBundlePath, nvidiaTorchRuntimeBundlePath,
  legacyTorchCoreBundlePath, legacyTorchRuntimeBundlePath,
];
const currentDefaultBundlePaths = [
  defaultBundlePath,
  defaultNvidiaTorchCoreBundlePath,
  defaultNvidiaTorchRuntimeBundlePath,
  defaultLegacyTorchCoreBundlePath,
  defaultLegacyTorchRuntimeBundlePath,
];
const obsoleteDefaultBundlePaths = [
  path.join(flatpakRoot, `Tuneforge_${appVersion}_Torch_Nvidia_x86_64.flatpak`),
  path.join(flatpakRoot, `Tuneforge_${appVersion}_Torch_LegacyNvidia_x86_64.flatpak`),
];
const sha256SumsPath =
  process.env.FLATPAK_SHA256SUMS_PATH ?? path.join(flatpakRoot, "generated", "SHA256SUMS");
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

function runAndTee(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const forward = (stream, destination) => {
      stream.on("data", (chunk) => {
        output += chunk;
        destination.write(chunk);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    let failed = false;
    child.once("error", (error) => {
      failed = true;
      reject(error?.code === "ENOENT" ? new Error(`Required command not found: ${command}`) : error);
    });
    child.once("close", (status, signal) => {
      if (failed) return;
      if (status === 0) resolve(output);
      else reject(new Error(`${command} failed (${signal ?? `status ${status}`})`));
    });
  });
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

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error?.code === "ENOENT") throw new Error(`Required command not found: ${command}`);
  if (result.status !== 0) throw new Error(`Could not run ${command} --version`);
  return result.stdout.trim();
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
  const encodedPackageOptions = frontendPackageOptionsEnvironment(options).TUNEFORGE_PACKAGE_OPTIONS;
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
  const selectedProfiles = new Set(normalizeFlatpakProfiles(options.flatpakProfiles));
  for (const [profile, artifacts] of Object.entries(torchProfileArtifacts)) {
    if (selectedProfiles.has(profile)) continue;
    for (const { module, refId } of artifacts) {
      result = removeManifestModule(result, module);
      result = disableManifestExtensionBundle(result, refId);
    }
  }
  return result;
}

function removeManifestModule(contents, moduleName) {
  const marker = `  - name: ${moduleName}\n`;
  const start = contents.indexOf(marker);
  if (start < 0) throw new Error(`Could not find Flatpak module: ${moduleName}`);
  const next = contents.indexOf("\n  - name: ", start + marker.length);
  if (next < 0) throw new Error(`Could not find module after Flatpak module: ${moduleName}`);
  return contents.slice(0, start) + contents.slice(next + 1);
}

function disableManifestExtensionBundle(contents, refId) {
  const marker = `  ${refId}:\n`;
  const start = contents.indexOf(marker);
  if (start < 0) throw new Error(`Could not find Flatpak extension declaration: ${refId}`);
  const following = contents.slice(start + marker.length);
  const next = following.search(/\n  \S/);
  const end = next < 0 ? contents.length : start + marker.length + next;
  const block = contents.slice(start, end);
  if (!block.includes("    bundle: true\n")) {
    throw new Error(`Could not find bundled Flatpak extension declaration: ${refId}`);
  }
  return contents.slice(0, start) + block.replace("    bundle: true\n", "") + contents.slice(end);
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
  const buildOptions = { ...options, noBundle: false };
  const { flatpakProfiles: _flatpakProfiles, ...nonProfileOptions } = JSON.parse(
    packageOptionsEnvironment(buildOptions).TUNEFORGE_PACKAGE_OPTIONS,
  );
  const inputs = {
    schema: cacheSchema,
    app: `${appId}@${version}`,
    arch: "x86_64",
    runtime: "org.gnome.Platform/50",
    tools: "node26-llvm20-rust-stable-pnpm11.22.0-sccache0.17.0",
    packageOptions: nonProfileOptions,
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

const knownFlatpakOutputRefs = [
  { id: "cpu", ref: `app/${appId}/x86_64/stable` },
  { id: "nvidia-core", ref: `runtime/${nvidiaTorchCoreRef}/x86_64/stable` },
  { id: "nvidia-runtime", ref: `runtime/${nvidiaTorchRuntimeRef}/x86_64/stable` },
  { id: "legacy-nvidia-core", ref: `runtime/${legacyTorchCoreRef}/x86_64/stable` },
  { id: "legacy-nvidia-runtime", ref: `runtime/${legacyTorchRuntimeRef}/x86_64/stable` },
];
const obsoleteFlatpakOutputRefs = [
  `runtime/${appId}.Torch.Nvidia/x86_64/stable`,
  `runtime/${appId}.Torch.LegacyNvidia/x86_64/stable`,
];

export function selectedFlatpakOutputRefs(profiles) {
  const selected = new Set(normalizeFlatpakProfiles(profiles));
  return knownFlatpakOutputRefs.filter(({ id }) =>
    id === "cpu" || selected.has(id.startsWith("legacy-") ? "legacy-nvidia" : "nvidia"));
}

function listOstreeRefs(repoPath) {
  if (!existsSync(path.join(repoPath, "config"))) return [];
  const result = spawnSync("ostree", [`--repo=${repoPath}`, "refs"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") throw new Error("ostree is required to reconcile Flatpak output refs.");
  if (result.status !== 0) throw new Error("Could not list Flatpak repository refs.");
  return result.stdout.trim().split("\n").filter(Boolean);
}

function deleteOstreeRef(repoPath, ref) {
  const result = spawnSync("ostree", [`--repo=${repoPath}`, "refs", "--delete", ref], {
    stdio: "ignore",
  });
  if (result.error?.code === "ENOENT") throw new Error("ostree is required to reconcile Flatpak output refs.");
  if (result.status !== 0) throw new Error(`Could not delete stale Flatpak output ref ${ref}`);
}

export function reconcileFlatpakOutputRefs({
  repoPath = repoDir,
  listRefs = listOstreeRefs,
  deleteRef = deleteOstreeRef,
} = {}) {
  const present = new Set(listRefs(repoPath));
  for (const ref of [
    ...knownFlatpakOutputRefs.map((output) => output.ref),
    ...obsoleteFlatpakOutputRefs,
  ]) {
    if (present.has(ref)) deleteRef(repoPath, ref);
  }
}

function resolveOstreeCommit(repoPath, ref) {
  const result = spawnSync("ostree", [`--repo=${repoPath}`, "rev-parse", ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") throw new Error("ostree is required to verify Flatpak output refs.");
  if (result.status !== 0) throw new Error(`Could not resolve Flatpak output ref ${ref}`);
  return result.stdout.trim();
}

export function verifyFlatpakOutputRefs({
  repoPath = repoDir,
  selectedProfiles,
  listRefs = listOstreeRefs,
  resolveCommit = resolveOstreeCommit,
} = {}) {
  const expected = selectedFlatpakOutputRefs(selectedProfiles);
  const expectedRefs = new Set(expected.map(({ ref }) => ref));
  const present = new Set(listRefs(repoPath));
  for (const { ref } of expected) {
    if (!present.has(ref)) throw new Error(`Missing selected Flatpak output ref ${ref}`);
  }
  for (const { ref } of knownFlatpakOutputRefs) {
    if (!expectedRefs.has(ref) && present.has(ref)) {
      throw new Error(`Stale unselected Flatpak output ref ${ref}`);
    }
  }
  for (const ref of obsoleteFlatpakOutputRefs) {
    if (present.has(ref)) throw new Error(`Stale obsolete Flatpak output ref ${ref}`);
  }
  return expected.map(({ id, ref }) => {
    const commitSha256 = resolveCommit(repoPath, ref);
    if (!/^[a-f0-9]{64}$/.test(commitSha256)) {
      throw new Error(`Malformed commit for Flatpak output ref ${ref}`);
    }
    return { id, ref, commitSha256 };
  });
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validPayload(payload) {
  return Boolean(payload && /^[a-f0-9]{64}$/.test(payload.sha256) &&
    Number.isInteger(payload.entryCount) && payload.entryCount >= 0);
}

function validRefCommits(refCommits, profiles) {
  if (!Array.isArray(refCommits) || !refCommits.every((entry) =>
    entry && typeof entry === "object" && typeof entry.id === "string" && typeof entry.ref === "string" &&
    /^[a-f0-9]{64}$/.test(entry.commitSha256))) return false;
  return equalJson(
    refCommits.map(({ id, ref }) => ({ id, ref })),
    selectedFlatpakOutputRefs(profiles).map(({ id, ref }) => ({ id, ref })),
  );
}

function validCheckoutSizeEvidence(size) {
  const exactKeys = (value, keys) => value && typeof value === "object" &&
    equalJson(Object.keys(value).sort(), [...keys].sort());
  const validSize = (entry, expectedPath) => entry && typeof entry === "object" && entry.path === expectedPath &&
    entry.available === true && Number.isInteger(entry.bytes) && entry.bytes >= 0;
  const directories = size?.installedApp?.topLevelDirectories;
  const validArtifacts = (artifacts) => exactKeys(artifacts, ["complete", "entries", "knownBytes", "unknownCount"]) &&
    Number.isInteger(artifacts.knownBytes) && artifacts.knownBytes >= 0 && Number.isInteger(artifacts.unknownCount) &&
    artifacts.unknownCount >= 0 && typeof artifacts.complete === "boolean" && Array.isArray(artifacts.entries) &&
    artifacts.entries.every((entry) => exactKeys(entry, ["bytes", "fileName", "name", "version"]) &&
      ["fileName", "name", "version"].every((key) => typeof entry[key] === "string" && entry[key]) &&
      (entry.bytes === null || Number.isInteger(entry.bytes) && entry.bytes >= 0)) &&
    artifacts.knownBytes === artifacts.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0) &&
    artifacts.unknownCount === artifacts.entries.filter((entry) => entry.bytes === null).length &&
    artifacts.complete === (artifacts.unknownCount === 0);
  const libRows = directories?.filter((entry) => entry.path === "/app/lib");
  const libBytes = libRows?.[0]?.bytes;
  return Boolean(exactKeys(size, ["compressedBundle", "installedApp", "pythonRuntime", "schema", "sitePackages", "sourceArchives", "unit", "wheelInputs"]) &&
    size.schema === sizeReportSchema && size.unit === "bytes" && exactKeys(size.compressedBundle, ["available", "path"]) &&
    typeof size.compressedBundle.path === "string" && size.compressedBundle.path && size.compressedBundle.available === false &&
    exactKeys(size.installedApp, ["available", "bytes", "path", "topLevelDirectories"]) && validSize(size.installedApp, "/app") &&
    Array.isArray(directories) && directories.every((entry) => exactKeys(entry, ["bytes", "path"]) &&
      typeof entry.path === "string" && entry.path.startsWith("/app/") && Number.isInteger(entry.bytes) && entry.bytes >= 0) &&
    new Set(directories.map(({ path: entryPath }) => entryPath)).size === directories.length &&
    directories.reduce((total, entry) => total + entry.bytes, 0) === size.installedApp.bytes &&
    libRows.length === 1 &&
    validSize(size.pythonRuntime, "/app/lib/tuneforge/backend/python") &&
    validSize(size.sitePackages, "/app/lib/tuneforge/backend/site-packages") &&
    size.pythonRuntime.bytes <= size.installedApp.bytes && size.sitePackages.bytes <= size.installedApp.bytes &&
    size.pythonRuntime.bytes + size.sitePackages.bytes <= libBytes &&
    validArtifacts(size.wheelInputs) && validArtifacts(size.sourceArchives));
}

export function flatpakOutputStatePath(stateDir) {
  return path.join(stateDir, `${outputStateSchema}.json`);
}

export function validateFlatpakOutputState(state, {
  namespace,
  selectedProfiles,
  payload,
  refCommits,
} = {}) {
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) return ["Flatpak output state is malformed."];
  if (state.schema !== outputStateSchema) errors.push(`Flatpak output state must use ${outputStateSchema}.`);
  let normalizedProfiles;
  try {
    normalizedProfiles = Array.isArray(state.selectedProfiles) ? normalizeFlatpakProfiles(state.selectedProfiles) : null;
  } catch {
    normalizedProfiles = null;
  }
  if (!normalizedProfiles || !equalJson(state.selectedProfiles, normalizedProfiles)) {
    errors.push("Flatpak output state has invalid selected profiles.");
  }
  if (typeof state.namespace !== "string" || !state.namespace) errors.push("Flatpak output state has an invalid namespace.");
  if (!validPayload(state.payload)) errors.push("Flatpak output state has an invalid payload.");
  if (!normalizedProfiles || !validRefCommits(state.refCommits, normalizedProfiles)) {
    errors.push("Flatpak output state has invalid output refs.");
  }
  if (!validCheckoutSizeEvidence(state.checkoutSize)) {
    errors.push("Flatpak output state has incomplete checkout size evidence.");
  }
  if (namespace !== undefined && state.namespace !== namespace) errors.push("Flatpak output state namespace differs.");
  if (selectedProfiles !== undefined && !equalJson(state.selectedProfiles, normalizeFlatpakProfiles(selectedProfiles))) {
    errors.push("Flatpak output state profiles differ.");
  }
  if (payload !== undefined && !equalJson(state.payload, payload)) errors.push("Flatpak output state payload differs.");
  if (refCommits !== undefined && !equalJson(state.refCommits, refCommits)) {
    errors.push("Flatpak output state ref commits differ.");
  }
  return errors;
}

export function readFlatpakOutputState({ statePath, ...expected } = {}) {
  if (!statePath || !existsSync(statePath)) return null;
  let state;
  try {
    state = readJson(statePath);
  } catch {
    rmSync(statePath, { force: true });
    return null;
  }
  if (validateFlatpakOutputState(state, expected).length > 0) {
    rmSync(statePath, { force: true });
    return null;
  }
  return state;
}

export function selectPreservedFlatpakOutputState({
  statePath,
  namespace,
  selectedProfiles,
  refCommits,
  checkoutPayload,
  evidence = false,
} = {}) {
  if (evidence || !refCommits) {
    if (statePath) rmSync(statePath, { force: true });
    return null;
  }
  const state = readFlatpakOutputState({ statePath, namespace, selectedProfiles, refCommits });
  if (!state) return null;
  if (checkoutPayload && !equalJson(state.payload, checkoutPayload)) {
    rmSync(statePath, { force: true });
    return null;
  }
  return state;
}

export function writeFlatpakOutputState({ statePath, namespace, selectedProfiles, payload, refCommits, checkoutSize }) {
  const state = {
    schema: outputStateSchema,
    namespace,
    selectedProfiles: normalizeFlatpakProfiles(selectedProfiles),
    payload,
    refCommits,
    checkoutSize,
  };
  const errors = validateFlatpakOutputState(state, { namespace, selectedProfiles, payload, refCommits });
  if (errors.length > 0) throw new Error(errors.join(" "));
  mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporaryPath, statePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return state;
}

function cacheReportValidationErrors(report, label) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return [`${label} cache report is malformed.`];
  if (report.schema !== cacheSchema) errors.push(`${label} report must use ${cacheSchema}.`);
  if (typeof report.namespace !== "string" || !report.namespace) errors.push(`${label} report has an invalid namespace.`);
  const selectedProfiles = report.selectedProfiles;
  let normalizedProfiles;
  try {
    normalizedProfiles = Array.isArray(selectedProfiles) ? normalizeFlatpakProfiles(selectedProfiles) : null;
  } catch {
    normalizedProfiles = null;
  }
  if (!normalizedProfiles || JSON.stringify(selectedProfiles) !== JSON.stringify(normalizedProfiles)) {
    errors.push(`${label} report has invalid selected profiles.`);
  }
  let expectedOptions;
  if (!report.namespaceInputs || typeof report.namespaceInputs !== "object" || Array.isArray(report.namespaceInputs) ||
    !report.namespaceInputs.packageOptions || typeof report.namespaceInputs.packageOptions !== "object" ||
    Array.isArray(report.namespaceInputs.packageOptions)) {
    errors.push(`${label} report has invalid namespace inputs.`);
  } else if (normalizedProfiles) {
    try {
      expectedOptions = validatePackageOptions({
        ...report.namespaceInputs.packageOptions,
        noBundle: false,
        flatpakProfiles: normalizedProfiles,
      }, { platform: "linux" });
      const expectedNamespace = cacheNamespace(expectedOptions);
      if (report.namespace !== expectedNamespace.name ||
        JSON.stringify(report.namespaceInputs) !== JSON.stringify(expectedNamespace.inputs)) {
        errors.push(`${label} report namespace identity is not canonical.`);
      }
    } catch {
      errors.push(`${label} report has invalid namespace inputs.`);
    }
  }
  if (!validPayload(report.payload)) {
    errors.push(`${label} report has an invalid payload.`);
  }
  if (!Array.isArray(report.refCommits) || report.refCommits.length === 0 ||
    report.refCommits.some((entry) => !entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || typeof entry.ref !== "string" || !entry.ref || !/^[a-f0-9]{64}$/.test(entry.commitSha256)) ||
    new Set(report.refCommits.map(({ id }) => id)).size !== report.refCommits.length ||
    new Set(report.refCommits.map(({ ref }) => ref)).size !== report.refCommits.length) {
    errors.push(`${label} report has invalid output refs.`);
  }
  if (!Array.isArray(report.errors) || report.errors.some((error) => typeof error !== "string" || !error)) {
    errors.push(`${label} report has invalid errors.`);
  } else {
    errors.push(...report.errors);
  }
  const cache = report.moduleCache;
  const modules = cache?.modules;
  if (cache?.mode !== "enabled" || cache?.observationComplete !== true || !Array.isArray(modules) || modules.length === 0 ||
    modules.some((entry) => !entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name || !["cached", "executed"].includes(entry.status)) ||
    new Set(modules.map(({ name }) => name)).size !== modules.length) {
    errors.push(`${label} report has an invalid module-cache observation.`);
  } else {
    const firstExecuted = modules.findIndex(({ status }) => status === "executed");
    const expectedInvalidation = firstExecuted < 0 ? null : modules[firstExecuted].name;
    if (cache.firstInvalidatedModule !== expectedInvalidation) {
      errors.push(`${label} report has an incoherent first invalidated module.`);
    }
  }
  if (expectedOptions && Array.isArray(modules) && modules.every((entry) => entry && typeof entry === "object")) {
    const expectedModules = expectedFlatpakModuleOrder(
      manifestWithPackageOptions(readFileSync(baseManifestPath, "utf8"), expectedOptions),
    );
    if (JSON.stringify(modules.map(({ name }) => name)) !== JSON.stringify(expectedModules)) {
      errors.push(`${label} report module order does not match its selected profiles.`);
    }
  }
  if (normalizedProfiles && Array.isArray(report.refCommits) &&
    report.refCommits.every((entry) => entry && typeof entry === "object")) {
    const expectedRefs = selectedFlatpakOutputRefs(normalizedProfiles).map(({ id, ref }) => ({ id, ref }));
    const actualRefs = report.refCommits.map(({ id, ref }) => ({ id, ref }));
    if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
      errors.push(`${label} report output refs do not match its selected profiles.`);
    }
  }
  const output = report.output;
  if (!output || typeof output !== "object" || !["exported", "preserved-unchanged"].includes(output.mode) ||
    output.observationComplete !== true || !["checkout", "output-state"].includes(output.payloadObservationSource)) {
    errors.push(`${label} report has an invalid output observation.`);
  } else if ((output.mode === "exported" && output.payloadObservationSource !== "checkout") ||
    (output.mode === "preserved-unchanged" && output.payloadObservationSource !== "output-state")) {
    errors.push(`${label} report has an incoherent output observation.`);
  }
  return errors;
}

export function compareCacheReports(cold, warm) {
  const errors = [...cacheReportValidationErrors(cold, "Cold"), ...cacheReportValidationErrors(warm, "Warm")];
  const coldReport = cold && typeof cold === "object" ? cold : {};
  const warmReport = warm && typeof warm === "object" ? warm : {};
  if (coldReport.namespace !== warmReport.namespace) errors.push("Cold and warm cache namespaces differ.");
  if (JSON.stringify(coldReport.selectedProfiles) !== JSON.stringify(warmReport.selectedProfiles)) {
    errors.push("Cold and warm profile selections differ.");
  }
  if (!equalJson(coldReport.payload, warmReport.payload)) errors.push("Cold and warm payload digests differ.");
  if (JSON.stringify(coldReport.refCommits) !== JSON.stringify(warmReport.refCommits)) {
    errors.push("Cold and warm Flatpak output ref commits differ.");
  }
  const coldModules = coldReport.moduleCache?.modules;
  const warmModules = warmReport.moduleCache?.modules;
  if (!Array.isArray(coldModules) || !Array.isArray(warmModules) ||
    JSON.stringify(coldModules.map(({ name }) => name)) !== JSON.stringify(warmModules.map(({ name }) => name))) {
    errors.push("Cold and warm module-cache module sets differ.");
  }
  if (!Array.isArray(warmModules) || warmModules.some(({ status }) => status !== "cached")) {
    errors.push("Warm Flatpak modules must all be cached.");
  }
  if (warmReport.moduleCache?.firstInvalidatedModule !== null) {
    errors.push("Warm Flatpak report has an invalidated module.");
  }
  if (warmReport.output?.mode !== "preserved-unchanged") {
    errors.push("Warm Flatpak report must preserve unchanged output refs.");
  }
  return {
    schema: cacheSchema,
    equivalent: errors.length === 0,
    errors,
    cold: { payload: coldReport.payload, refCommits: coldReport.refCommits, moduleCache: coldReport.moduleCache },
    warm: { payload: warmReport.payload, refCommits: warmReport.refCommits, moduleCache: warmReport.moduleCache, output: warmReport.output },
  };
}

export function compareCrossProfileCacheReports(source, target) {
  const errors = [
    ...cacheReportValidationErrors(source, "Source"),
    ...cacheReportValidationErrors(target, "Target"),
  ];
  const sourceReport = source && typeof source === "object" ? source : {};
  const targetReport = target && typeof target === "object" ? target : {};
  if (sourceReport.namespace !== targetReport.namespace) {
    errors.push("Source and target cache namespaces differ.");
  }
  if (JSON.stringify(sourceReport.selectedProfiles) === JSON.stringify(targetReport.selectedProfiles)) {
    errors.push("Cross-profile cache comparison requires different profile selections.");
  }
  const sourceModules = sourceReport.moduleCache?.modules;
  const targetModules = targetReport.moduleCache?.modules;
  const sharedModulePrefix = [];
  if (Array.isArray(sourceModules) && Array.isArray(targetModules)) {
    for (let index = 0; index < Math.min(sourceModules.length, targetModules.length); index += 1) {
      if (sourceModules[index].name !== targetModules[index].name) break;
      sharedModulePrefix.push(sourceModules[index].name);
    }
    if (sharedModulePrefix.length === 0) errors.push("Cross-profile reports have no shared module prefix.");
    if (targetModules.slice(0, sharedModulePrefix.length).some(({ status }) => status !== "cached")) {
      errors.push("Target shared Flatpak modules must be cached.");
    }
  } else {
    errors.push("Cross-profile reports have invalid module observations.");
  }
  const firstTargetExecution = Array.isArray(targetModules)
    ? targetModules.slice(sharedModulePrefix.length).find(({ status }) => status === "executed")?.name ?? null
    : null;
  if (targetReport.output?.mode !== "exported") {
    errors.push("Cross-profile target report must export output refs.");
  }
  return {
    schema: cacheSchema,
    equivalent: errors.length === 0,
    errors,
    namespace: targetReport.namespace,
    sharedModulePrefix,
    firstTargetExecution,
    source: { selectedProfiles: sourceReport.selectedProfiles, moduleCache: sourceReport.moduleCache },
    target: { selectedProfiles: targetReport.selectedProfiles, moduleCache: targetReport.moduleCache },
  };
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
      `Flatpak bundle ${bytesToBinaryUnit(report.compressedBundle.bytes)} is below the hard limit but misses the 1.9 GiB target.\n`,
    );
  }
}

export function flatpakBundlePlan({
  applicationBundle = bundlePath,
  nvidiaCoreBundle = nvidiaTorchCoreBundlePath,
  nvidiaRuntimeBundle = nvidiaTorchRuntimeBundlePath,
  legacyCoreBundle = legacyTorchCoreBundlePath,
  legacyRuntimeBundle = legacyTorchRuntimeBundlePath,
  selectedProfiles = ["cpu", "nvidia", "legacy-nvidia"],
} = {}) {
  const selected = new Set(normalizeFlatpakProfiles(selectedProfiles));
  const plan = [
    { refId: appId, runtime: false, path: applicationBundle },
  ];
  if (selected.has("nvidia")) plan.push(
    { refId: nvidiaTorchCoreRef, runtime: true, path: nvidiaCoreBundle },
    { refId: nvidiaTorchRuntimeRef, runtime: true, path: nvidiaRuntimeBundle },
  );
  if (selected.has("legacy-nvidia")) plan.push(
    { refId: legacyTorchCoreRef, runtime: true, path: legacyCoreBundle },
    { refId: legacyTorchRuntimeRef, runtime: true, path: legacyRuntimeBundle },
  );
  validateFlatpakArtifactPaths(plan.map((artifact) => artifact.path));
  return plan;
}

export function flatpakBundleStatePath(stateDir) {
  return path.join(stateDir, `${bundleStateSchema}.json`);
}

export function validateFlatpakArtifactPaths(artifacts) {
  const resolved = artifacts.map((artifact) => path.resolve(artifact));
  const duplicatePath = resolved.find((artifact, index) => resolved.indexOf(artifact) !== index);
  if (duplicatePath) throw new Error(`Flatpak bundle output paths must be unique: ${duplicatePath}`);
  const basenames = artifacts.map((artifact) => path.basename(artifact));
  const duplicateBasename = basenames.find((artifact, index) => basenames.indexOf(artifact) !== index);
  if (duplicateBasename) {
    throw new Error(`Flatpak checksum artifact basenames must be unique: ${duplicateBasename}`);
  }
}

export function cleanupFlatpakBundleOutputs({
  bundlePlan = flatpakBundlePlan(),
  checksumPath = sha256SumsPath,
  obsoleteBundlePaths = [...currentDefaultBundlePaths, ...obsoleteDefaultBundlePaths],
} = {}) {
  validateFlatpakArtifactPaths(bundlePlan.map((artifact) => artifact.path));
  for (const artifact of bundlePlan) rmSync(artifact.path, { force: true });
  for (const artifact of obsoleteBundlePaths) rmSync(artifact, { force: true });
  rmSync(checksumPath, { force: true });
}

export async function withFreshFlatpakBundleOutputs(operation, options = {}) {
  cleanupFlatpakBundleOutputs(options);
  try {
    return await operation();
  } catch (error) {
    cleanupFlatpakBundleOutputs(options);
    throw error;
  }
}

export function defaultFlatpakBundleConcurrency(parallelism = availableParallelism()) {
  if (!Number.isInteger(parallelism) || parallelism < 1) throw new Error("Available bundle parallelism must be a positive integer");
  return Math.max(1, parallelism - 1);
}

export function flatpakBundleWorkerLimit(bundlePlan, concurrency = defaultFlatpakBundleConcurrency()) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Bundle concurrency must be a positive integer");
  return Math.min(concurrency, bundlePlan.length);
}

export function buildFlatpakBundles({
  bundlePlan = flatpakBundlePlan(),
  repository = repoDir,
  concurrency = defaultFlatpakBundleConcurrency(),
  spawnProcess = spawn,
} = {}) {
  validateFlatpakArtifactPaths(bundlePlan.map((artifact) => artifact.path));
  const workerLimit = flatpakBundleWorkerLimit(bundlePlan, concurrency);
  return new Promise((resolve, reject) => {
    const active = new Set();
    let next = 0;
    let failure;

    const finish = () => {
      if (active.size > 0) return;
      if (failure) reject(failure);
      else if (next === bundlePlan.length) resolve();
    };
    const fail = (error) => {
      if (!failure) {
        failure = error;
        next = bundlePlan.length;
        for (const child of active) child.kill("SIGTERM");
      }
      finish();
    };
    const launch = () => {
      while (!failure && active.size < workerLimit && next < bundlePlan.length) {
        const artifact = bundlePlan[next++];
        const args = [
          "build-bundle",
          ...(artifact.runtime ? ["--runtime"] : []),
          "--arch=x86_64",
          repository,
          artifact.path,
          artifact.refId,
          "stable",
        ];
        const child = spawnProcess("flatpak", args, {
          cwd: workspaceRoot,
          stdio: "inherit",
          env: process.env,
        });
        active.add(child);
        let settled = false;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          active.delete(child);
          if (error) fail(error);
          else {
            launch();
            finish();
          }
        };
        child.once("error", (error) => settle(
          error?.code === "ENOENT" ? new Error("Required command not found: flatpak") : error,
        ));
        child.once("exit", (status, signal) => settle(
          status === 0
            ? undefined
            : new Error(`flatpak build-bundle for ${artifact.refId} failed (${signal ?? `status ${status}`})`),
        ));
      }
      finish();
    };
    launch();
  });
}

export function flatpakArtifactSizeReport(bundle) {
  const compressedBundle = compressedBundleEvidence(bundle, true);
  return {
    schema: sizeReportSchema,
    unit: "bytes",
    compressedBundle,
    compliance: {
      hardLimitBytes: flatpakBundleHardLimitBytes,
      hardLimitPassed: compressedBundle.bytes < flatpakBundleHardLimitBytes,
      targetBytes: flatpakBundleTargetBytes,
      targetMet: compressedBundle.bytes <= flatpakBundleTargetBytes,
    },
  };
}

export function flatpakBundleSizeReportFromCheckout({ checkoutSize, bundle, selectedProfiles, extensionBundles }) {
  if (!validCheckoutSizeEvidence(checkoutSize)) {
    throw new Error("Flatpak checkout size evidence is incomplete.");
  }
  return {
    ...checkoutSize,
    ...flatpakArtifactSizeReport(bundle),
    selectedProfiles: normalizeFlatpakProfiles(selectedProfiles),
    extensionBundles,
  };
}

export function writeFlatpakChecksums(artifacts, outputPath = sha256SumsPath) {
  validateFlatpakArtifactPaths(artifacts);
  const lines = artifacts
    .map((artifact) => ({ name: path.basename(artifact), sha256: fileSha256(artifact) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}`);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${lines.join("\n")}\n`);
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return lines;
}

function readBundleChecksums(checksumPath) {
  let lines;
  try {
    if (!existsSync(checksumPath)) return { checksums: new Map() };
    lines = readFileSync(checksumPath, "utf8").split("\n");
  } catch {
    return null;
  }
  if (lines.at(-1) !== "") return null;
  lines.pop();
  const checksums = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/\n]+)$/.exec(line);
    if (!match || checksums.has(match[2])) return null;
    checksums.set(match[2], match[1]);
  }
  return { checksums };
}

function readBundleState(statePath, expectedHeader, managedPaths) {
  if (!existsSync(statePath)) return null;
  let state;
  try {
    state = readJson(statePath);
  } catch {
    return null;
  }
  if (!state || typeof state !== "object" || Array.isArray(state) ||
    !Object.entries(expectedHeader).every(([key, value]) => state[key] === value) ||
    !Array.isArray(state.entries)) return null;
  const ids = state.entries.map((entry) => entry?.id);
  const paths = state.entries.map((entry) => entry?.outputPath);
  const knownIds = new Set(knownFlatpakOutputRefs.map(({ id }) => id));
  const allowedPaths = new Set(managedPaths.map((entryPath) => path.resolve(entryPath)));
  if (ids.some((id) => typeof id !== "string" || !knownIds.has(id)) || new Set(ids).size !== ids.length ||
    paths.some((entryPath) => typeof entryPath !== "string" || !path.isAbsolute(entryPath)) ||
    new Set(paths).size !== paths.length || paths.some((entryPath) => !allowedPaths.has(entryPath))) return null;
  return state;
}

function validBundleEntry(entry, artifact, refCommit, checksum) {
  return Boolean(entry && entry.id === refCommit.id && entry.refId === artifact.refId &&
    entry.ref === refCommit.ref && entry.commit === refCommit.commitSha256 &&
    entry.role === (artifact.runtime ? "runtime" : "app") &&
    entry.outputPath === path.resolve(artifact.path) && entry.basename === path.basename(artifact.path) &&
    Number.isInteger(entry.bytes) && entry.bytes > 0 && /^[a-f0-9]{64}$/.test(entry.sha256) &&
    checksum === entry.sha256);
}

function verifiedBundleFile(artifactPath, entry, hashFile) {
  try {
    if (!existsSync(artifactPath)) return false;
    const stats = lstatSync(artifactPath);
    return stats.isFile() && stats.size === entry.bytes && hashFile(artifactPath) === entry.sha256;
  } catch {
    return false;
  }
}

function bundleEntry(artifact, refCommit, artifactPath, hashFile) {
  const stats = lstatSync(artifactPath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`Flatpak bundle target must be a non-empty regular file: ${artifactPath}`);
  }
  const report = flatpakArtifactSizeReport(artifactPath);
  enforceFlatpakBundleSize(report);
  return {
    id: refCommit.id,
    refId: artifact.refId,
    ref: refCommit.ref,
    commit: refCommit.commitSha256,
    role: artifact.runtime ? "runtime" : "app",
    outputPath: path.resolve(artifact.path),
    basename: path.basename(artifact.path),
    bytes: stats.size,
    sha256: hashFile(artifactPath),
  };
}

function atomicWriteBundleState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporaryPath, statePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function reuseFlatpakBundles({
  bundlePlan,
  refCommits,
  namespace,
  flatpakVersion,
  statePath,
  checksumPath = sha256SumsPath,
  repository = repoDir,
  evidence = false,
  concurrency = defaultFlatpakBundleConcurrency(),
  reportWorkerLimit = false,
  spawnProcess = spawn,
  managedBundlePaths = [...configuredBundlePaths, ...currentDefaultBundlePaths, ...obsoleteDefaultBundlePaths],
  hashFile = fileSha256, renameArtifact = renameSync,
  writeChecksums = writeFlatpakChecksums, writeState = atomicWriteBundleState,
} = {}) {
  validateFlatpakArtifactPaths(bundlePlan.map((artifact) => artifact.path));
  if (!Array.isArray(refCommits) || refCommits.length !== bundlePlan.length) {
    throw new Error("Flatpak bundle refs must match the selected bundle plan.");
  }
  if (typeof namespace !== "string" || !namespace || typeof flatpakVersion !== "string" || !flatpakVersion ||
    refCommits.some((entry, index) => !entry || typeof entry.id !== "string" || !entry.id ||
      entry.ref !== `${bundlePlan[index].runtime ? "runtime" : "app"}/${bundlePlan[index].refId}/x86_64/stable` ||
      !/^[a-f0-9]{64}$/.test(entry.commitSha256))) {
    throw new Error("Flatpak bundle state inputs are malformed.");
  }
  const header = {
    schema: bundleStateSchema, namespace, flatpakVersion,
    arch: "x86_64", branch: "stable", commandContract: bundleCommandContract,
  };
  const state = evidence ? null : readBundleState(statePath, header, managedBundlePaths);
  const manifest = evidence ? null : readBundleChecksums(checksumPath);
  const entriesById = new Map(state?.entries.map((entry) => [entry.id, entry]) ?? []);
  const observations = [];
  const pending = [];
  for (let index = 0; index < bundlePlan.length; index += 1) {
    const artifact = bundlePlan[index];
    const refCommit = refCommits[index];
    const cached = entriesById.get(refCommit.id);
    if (!evidence && state && manifest && validBundleEntry(
      cached, artifact, refCommit, manifest.checksums.get(path.basename(artifact.path)),
    ) && verifiedBundleFile(artifact.path, cached, hashFile)) {
      observations.push({ ...cached, status: "reused" });
    } else {
      const temporaryPath = `${artifact.path}.${randomUUID()}.tmp`;
      pending.push({ index, artifact, refCommit, temporaryPath });
      observations.push(null);
    }
  }
  const firstRebuiltArtifact = pending[0]?.refCommit.id ?? null, mode = evidence ? "disabled-for-evidence" : "enabled";
  const selectedPaths = new Set(bundlePlan.map(({ path: artifactPath }) => path.resolve(artifactPath)));
  const selectedNames = bundlePlan.map(({ path: artifactPath }) => path.basename(artifactPath)).sort();
  const existingNames = [...(manifest?.checksums.keys() ?? [])].sort();
  const selectedStateIds = refCommits.map(({ id }) => id), existingStateIds = state?.entries.map(({ id }) => id) ?? [];
  const publicationNeeded = pending.length > 0 || !equalJson(selectedNames, existingNames) ||
    !equalJson(selectedStateIds, existingStateIds);
  const replacedDestinations = [];
  try {
    if (publicationNeeded) {
      rmSync(statePath, { force: true });
      rmSync(checksumPath, { force: true });
    }
    if (pending.length > 0) {
      const workerLimit = flatpakBundleWorkerLimit(pending, concurrency);
      if (reportWorkerLimit) process.stdout.write(`Flatpak bundle worker limit: ${workerLimit}\n`);
      await buildFlatpakBundles({
        bundlePlan: pending.map(({ artifact, temporaryPath }) => ({ ...artifact, path: temporaryPath })),
        repository,
        concurrency: workerLimit,
        spawnProcess,
      });
      for (const item of pending) {
        const entry = bundleEntry(item.artifact, item.refCommit, item.temporaryPath, hashFile);
        observations[item.index] = { ...entry, status: "rebuilt" };
      }
      for (const item of pending) {
        renameArtifact(item.temporaryPath, item.artifact.path);
        replacedDestinations.push(item.artifact.path);
      }
    }
    if (publicationNeeded) {
      for (const managedPath of managedBundlePaths) {
        if (!selectedPaths.has(path.resolve(managedPath))) rmSync(managedPath, { force: true });
      }
      writeChecksums(bundlePlan.map((artifact) => artifact.path), checksumPath);
      writeState(statePath, { ...header, entries: observations.map(({ status, ...entry }) => entry) });
    }
    return {
      mode,
      observationComplete: true,
      entries: observations.map(({ id: name, ref, commit, status, bytes, sha256 }) =>
        ({ name, ref, commit, status, bytes, sha256 })),
      firstRebuiltArtifact,
    };
  } catch (error) {
    rmSync(statePath, { force: true }); rmSync(checksumPath, { force: true });
    for (const { temporaryPath } of pending) rmSync(temporaryPath, { force: true });
    for (const destination of replacedDestinations) rmSync(destination, { force: true });
    error.bundleCache = {
      mode,
      observationComplete: false,
      entries: observations.filter(Boolean).map(({ id: name, ref, commit, status, bytes, sha256 }) =>
        ({ name, ref, commit, status, bytes, sha256 })),
      firstRebuiltArtifact,
    };
    throw error;
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

export function expectedFlatpakModuleOrder(manifest) {
  return [...manifest.matchAll(/^  - name: ([^\n]+)$/gm)].map((match) => match[1]);
}

export function parseFlatpakModuleCacheOutput(output, expectedModules, { evidence = false } = {}) {
  const normalized = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r\n", "\n");
  const expected = new Set(expectedModules);
  const states = new Map(expectedModules.map((name) => [name, "unknown"]));
  let contradictory = false;
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    const match = /^(?:Cache hit for ([A-Za-z0-9._-]+), skipping build|Building module ([A-Za-z0-9._-]+) in \/[^\0]*)(?:\.)?$/.exec(line);
    if (!match) continue;
    const name = match[1] ?? match[2];
    if (!expected.has(name)) continue;
    const status = line.startsWith("Cache hit") ? "cached" : "executed";
    const previous = states.get(name);
    if (previous !== "unknown" && previous !== status) contradictory = true;
    states.set(name, previous === "unknown" || previous === status ? status : "unknown");
  }
  const modules = expectedModules.map((name) => ({ name, status: states.get(name) }));
  const firstExecuted = modules.findIndex(({ status }) => status === "executed");
  return {
    mode: evidence ? "disabled-for-evidence" : "enabled",
    modules,
    observationComplete: !contradictory && modules.every(({ status }) => status !== "unknown"),
    firstInvalidatedModule: firstExecuted >= 0 && modules.slice(0, firstExecuted).every(({ status }) => status === "cached")
      ? modules[firstExecuted].name
      : null,
  };
}

function cacheReport({ namespace, inputs, cacheRoot, timings, evidence, refCommits, selectedProfiles, builderOutput, expectedModules, payload, output, bundleCache }) {
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
    moduleCache: parseFlatpakModuleCacheOutput(builderOutput, expectedModules, { evidence }),
    pnpm: pnpm ?? { status: "module-cached" },
    sccache: sccache ?? { status: "module-cached" },
    timings,
    selectedProfiles,
    payload,
    refCommits,
    output,
    bundleCache,
    errors: [],
  };
}

async function main() {
  const startedAt = performance.now();
  const packageOptions = parsePackageOptions(packageArguments(), { platform: "linux" });
  const selectedProfiles = packageOptions.flatpakProfiles;
  const bundlePlan = flatpakBundlePlan({ selectedProfiles });
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
  const outputStatePath = flatpakOutputStatePath(stateDir);
  const bundleStatePath = flatpakBundleStatePath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(namespaceRoot, { recursive: true });
  rmSync(path.join(namespaceRoot, "pnpm-report.json"), { force: true });
  rmSync(path.join(namespaceRoot, "sccache-stats.json"), { force: true });

  const sourceStartedAt = performance.now();
  run(process.execPath, [
    path.join("scripts", "generate-flatpak-sources.mjs"),
    ...packageOptionsToGeneratorArgs(packageOptions),
  ], { env: { SOURCE_DATE_EPOCH: sourceDateEpoch } });
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

  const reportPath = process.env.FLATPAK_CACHE_REPORT_PATH ?? path.join(flatpakRoot, "generated", "cache-report.json");
  const existingPayload = existsSync(path.join(buildDir, "files"))
    ? digestBuildPayload(path.join(buildDir, "files"))
    : undefined;
  let preBuilderRefCommits;
  try {
    preBuilderRefCommits = verifyFlatpakOutputRefs({ selectedProfiles });
  } catch {
    preBuilderRefCommits = undefined;
  }
  let outputState = selectPreservedFlatpakOutputState({
    statePath: outputStatePath,
    namespace: namespace.name,
    selectedProfiles,
    refCommits: preBuilderRefCommits,
    checkoutPayload: existingPayload,
    evidence,
  });
  const preserveOutputRefs = outputState !== null;

  checkCommand(
    "flatpak-builder",
    "Install flatpak-builder and the Flathub runtimes before running pnpm package:linux:flatpak.",
  );
  checkCommand("flatpak", "Install flatpak before running pnpm package:linux:flatpak.");
  const flatpakVersion = commandVersion("flatpak");

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
  if (preserveOutputRefs) builderArgs.unshift("--require-changes");
  const builderStartedAt = performance.now();
  if (!preserveOutputRefs) reconcileFlatpakOutputRefs();
  const builderOutput = await runAndTee("flatpak-builder", builderArgs);
  const refCommits = verifyFlatpakOutputRefs({ selectedProfiles });
  let payload;
  let checkoutSize;
  let output;
  if (preserveOutputRefs && equalJson(preBuilderRefCommits, refCommits)) {
    const stateErrors = validateFlatpakOutputState(outputState, { namespace: namespace.name, selectedProfiles, refCommits });
    if (stateErrors.length > 0) {
      throw new Error(`Flatpak output state contradicted preserved refs: ${stateErrors.join(" ")}`);
    }
    payload = outputState.payload;
    checkoutSize = outputState.checkoutSize;
    output = {
      mode: "preserved-unchanged",
      observationComplete: true,
      payloadObservationSource: "output-state",
    };
  } else {
    payload = digestBuildPayload(path.join(buildDir, "files"));
    checkoutSize = flatpakSizeReport({ includeBundle: false });
    output = {
      mode: "exported",
      observationComplete: true,
      payloadObservationSource: "checkout",
    };
  }
  writeFlatpakOutputState({
    statePath: outputStatePath,
    namespace: namespace.name,
    selectedProfiles,
    payload,
    refCommits,
    checkoutSize,
  });
  const report = cacheReport({
    namespace: namespace.name,
    inputs: namespace.inputs,
    cacheRoot,
    evidence,
    refCommits,
    selectedProfiles,
    builderOutput,
    payload,
    output,
    bundleCache: skipBundle
      ? { mode: "not-requested", observationComplete: true, entries: [], firstRebuiltArtifact: null }
      : { mode: evidence ? "disabled-for-evidence" : "enabled", observationComplete: false, entries: [], firstRebuiltArtifact: null },
    expectedModules: expectedFlatpakModuleOrder(readFileSync(manifestPath, "utf8")),
    timings: {
      sourceGenerationSeconds: Number(sourceSeconds.toFixed(3)),
      builderSeconds: Number(((performance.now() - builderStartedAt) / 1_000).toFixed(3)),
      elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
    },
  });
  writeJson(reportPath, report);
  const baselinePath = process.env.FLATPAK_CACHE_BASELINE_REPORT;
  if (baselinePath) {
    const comparison = compareCacheReports(readJson(baselinePath), report);
    const comparisonPath = process.env.FLATPAK_CACHE_COMPARISON_REPORT_PATH ??
      path.join(flatpakRoot, "generated", "cache-comparison-report.json");
    writeJson(comparisonPath, comparison);
    if (!comparison.equivalent) throw new Error(comparison.errors.join(" "));
  }
  const crossProfileBaselinePath = process.env.FLATPAK_CACHE_CROSS_PROFILE_BASELINE_REPORT;
  if (crossProfileBaselinePath) {
    const comparison = compareCrossProfileCacheReports(readJson(crossProfileBaselinePath), report);
    const comparisonPath = process.env.FLATPAK_CACHE_CROSS_PROFILE_COMPARISON_REPORT_PATH ??
      path.join(flatpakRoot, "generated", "cache-cross-profile-comparison-report.json");
    writeJson(comparisonPath, comparison);
    if (!comparison.equivalent) throw new Error(comparison.errors.join(" "));
  }
  if (skipBundle) {
    const sizeReportPath = process.env.FLATPAK_SIZE_REPORT_PATH ?? path.join(flatpakRoot, "generated", "size-report.json");
    const sizeReport = { ...checkoutSize, selectedProfiles };
    writeJson(sizeReportPath, sizeReport);
    printFlatpakSizeReport(sizeReport);
    process.stdout.write(`Flatpak repo exported to ${repoDir}\n`);
    process.stdout.write(
      `Install with: flatpak remote-add --user --if-not-exists --no-gpg-verify ${localRepoRemote} ${repoDir}\n`,
    );
    process.stdout.write(`Then run: flatpak install --user --reinstall ${localRepoRemote} ${appId}\n`);
    if (selectedProfiles.includes("nvidia")) process.stdout.write(
      `Optional NVIDIA: flatpak install --user --reinstall ${localRepoRemote} ${nvidiaTorchCoreRef} ${nvidiaTorchRuntimeRef}\n`,
    );
    if (selectedProfiles.includes("legacy-nvidia")) process.stdout.write(
      `Optional legacy NVIDIA: flatpak install --user --reinstall ${localRepoRemote} ${legacyTorchCoreRef} ${legacyTorchRuntimeRef}\n`,
    );
    return;
  }

  try {
    report.bundleCache = await reuseFlatpakBundles({
      bundlePlan,
      refCommits,
      namespace: namespace.name,
      flatpakVersion,
      statePath: bundleStatePath,
      evidence,
      reportWorkerLimit: true,
    });
    const sizeReportPath = process.env.FLATPAK_SIZE_REPORT_PATH ?? path.join(flatpakRoot, "generated", "size-report.json");
    const sizeReport = flatpakBundleSizeReportFromCheckout({
      checkoutSize,
      bundle: bundlePlan[0].path,
      selectedProfiles,
      extensionBundles: bundlePlan.slice(1).map((artifact) => flatpakArtifactSizeReport(artifact.path)),
    });
    writeJson(sizeReportPath, sizeReport);
    printFlatpakSizeReport(sizeReport);
    enforceFlatpakBundleSize(sizeReport);
    for (const report of sizeReport.extensionBundles) enforceFlatpakBundleSize(report);
    writeJson(reportPath, report);
  } catch (error) {
    if (error.bundleCache) report.bundleCache = error.bundleCache;
    writeJson(reportPath, report);
    throw error;
  }

  for (const [index, artifact] of bundlePlan.entries()) {
    const status = report.bundleCache.entries[index].status;
    process.stdout.write(`Flatpak bundle ${status} at ${artifact.path}\n`);
  }
  process.stdout.write(`Flatpak checksums verified at ${sha256SumsPath}\n`);
}

function runWithPackagingLock() {
  const lockPath = path.join(workspaceRoot, ".flatpak-builder", "tuneforge-package.lock");
  const token = randomUUID();
  mkdirSync(path.dirname(lockPath), { recursive: true });
  process.stdout.write("Waiting for Flatpak packaging lock...\n");
  run("flock", ["--verbose", lockPath, process.execPath, __filename, `--flatpak-lock-token=${token}`, ...process.argv.slice(2)], {
    env: { TUNEFORGE_FLATPAK_LOCK_TOKEN: token },
  });
}

function packageArguments() {
  return isLockedPackagingInvocation() ? process.argv.slice(3) : process.argv.slice(2);
}

function isLockedPackagingInvocation() {
  const token = process.env.TUNEFORGE_FLATPAK_LOCK_TOKEN;
  const marker = process.argv[2];
  return typeof token === "string" && /^[0-9a-f-]{36}$/.test(token) &&
    marker === `--flatpak-lock-token=${token}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  if (isLockedPackagingInvocation()) {
    main().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    try {
      runWithPackagingLock();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
