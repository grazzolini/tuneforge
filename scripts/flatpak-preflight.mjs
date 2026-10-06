import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statfsSync } from "node:fs";
import path from "node:path";
import { compareUtf8, flatpakSourceSnapshotInputs } from "./flatpak-source-snapshots.mjs";
import { planFlatpakCacheImports } from "./flatpak-cache-storage.mjs";

export function flatpakDiskSpace(target) {
  let existing = path.resolve(target);
  while (!existsSync(existing)) existing = path.dirname(existing);
  const stats = statfsSync(existing);
  return { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}

function hashInput(hash, root, source) {
  const target = path.resolve(root, source);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe preflight input: ${source}`);
  if (!existsSync(target) && !existsSync(path.dirname(target))) {
    hash.update(`missing:${source}\0`);
    return;
  }
  let stats;
  try { stats = lstatSync(target); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hash.update(`missing:${source}\0`);
    return;
  }
  hash.update(`${source}\0${stats.mode & 0o7777}\0`);
  if (stats.isSymbolicLink()) hash.update(`link:${readlinkSync(target)}\0`);
  else if (stats.isDirectory()) {
    hash.update("directory\0");
    for (const name of readdirSync(target).sort(compareUtf8)) hashInput(hash, root, path.join(source, name));
  } else if (stats.isFile()) {
    hash.update(`file:${stats.size}\0`);
    hash.update(readFileSync(target));
  }
  else throw new Error(`Unsupported preflight input: ${source}`);
}

export function flatpakModuleFingerprints({ root, manifest, sourceDateEpoch, frontendGitRef, buildInfo, testPackage,
  dependencyOptions = { crema: "onnx", beatThis: true, lvChordia: true } }) {
  const blocks = [...manifest.matchAll(/^  - name: ([^\n]+)\n([\s\S]*?)(?=^  - name: |$(?![\s\S]))/gm)];
  const dependencyInputs = {
    "node-sources": ["pnpm-lock.yaml"],
    "tuneforge-desktop": ["apps/desktop/src-tauri/Cargo.lock"],
    "python-runtime-deps": ["apps/backend/uv.lock", "packaging/flatpak/locks/pylock.cpu-torch.toml", ".python-version"],
    "nvidia-torch-core-extension": ["apps/backend/uv.lock"],
    "nvidia-torch-runtime-extension": ["apps/backend/uv.lock"],
    "legacy-nvidia-torch-core-extension": ["packaging/flatpak/locks/pylock.legacy-nvidia-torch.toml"],
    "legacy-nvidia-torch-runtime-extension": ["packaging/flatpak/locks/pylock.legacy-nvidia-torch.toml"],
  };
  return blocks.map(([block, name]) => {
    const hash = createHash("sha256").update(block);
    if (name === "python-runtime-deps") hash.update(JSON.stringify(dependencyOptions));
    const sourceGroup = { "tuneforge-frontend": "frontend", "tuneforge-desktop": "desktop", "tuneforge-backend": "backend" }[name];
    const inputs = [...(dependencyInputs[name] ?? [])];
    if (sourceGroup) {
      hash.update(sourceDateEpoch);
      hash.update(JSON.stringify(flatpakSourceSnapshotInputs[sourceGroup]));
      inputs.push(...flatpakSourceSnapshotInputs[sourceGroup].map((entry) => typeof entry === "string" ? entry : entry.source));
    }
    if (name === "tuneforge-frontend") hash.update(frontendGitRef);
    if (name === "tuneforge-build-info") hash.update(JSON.stringify(buildInfo));
    if (name === "tuneforge-backend") {
      inputs.push("packaging/demucs/drumsep-model.json");
      if (testPackage) inputs.push("apps/desktop/src-tauri/icons/test");
    }
    for (const source of new Set(inputs)) hashInput(hash, root, source);
    return { name, sha256: hash.digest("hex") };
  });
}

export function predictFlatpakInvalidation(previous, current) {
  if (!previous || previous.schema !== "flatpak-input-history-v1" || !Array.isArray(previous.modules)) {
    return { status: "no-input-history", firstChangedModule: null, changedModules: [], reason: "Native cache refs may exist; direct-input comparison is unavailable." };
  }
  const changedModules = current.filter((entry, index) => previous.modules[index]?.name !== entry.name || previous.modules[index]?.sha256 !== entry.sha256)
    .map(({ name }) => name);
  return { status: changedModules.length ? "inputs-changed" : "inputs-unchanged", firstChangedModule: changedModules[0] ?? null, changedModules,
    reason: "Direct-input prediction only; Builder chained keys and manifest identity determine actual module hits." };
}

function estimateImport(repository, destination) {
  const sourceRoot = path.join(repository, "objects");
  if (!existsSync(sourceRoot)) return { missingObjects: 0, missingAllocatedBytes: 0 };
  let missingObjects = 0, missingAllocatedBytes = 0;
  for (const prefix of readdirSync(sourceRoot)) {
    const directory = path.join(sourceRoot, prefix);
    if (!lstatSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory)) {
      const target = path.join(destination, "objects", prefix, name);
      try { lstatSync(target); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
      const stats = lstatSync(path.join(directory, name));
      missingObjects += 1;
      missingAllocatedBytes += stats.blocks * 512;
    }
  }
  return { missingObjects, missingAllocatedBytes };
}

export function createFlatpakPreflight({ storage, historyPath, modules, identity, selectedProfiles, sourceDateEpoch, outputs, runCommand }) {
  let previous;
  if (existsSync(historyPath)) {
    try { previous = JSON.parse(readFileSync(historyPath, "utf8")); } catch { /* Invalid history remains untouched during preflight. */ }
  }
  const imports = planFlatpakCacheImports(storage, { runCommand }).map((entry) => ({
    repository: entry.repository, status: entry.status, refCount: entry.refs.length,
    ...(entry.refs.length ? estimateImport(entry.repository, storage.nativeRepo) : { missingObjects: 0, missingAllocatedBytes: 0 }),
  }));
  const invalidation = predictFlatpakInvalidation(previous, modules);
  const fresh = storage.selection === "fresh";
  const appOnly = invalidation.status === "inputs-unchanged" || (invalidation.status === "inputs-changed" &&
    invalidation.changedModules.every((name) => ["tuneforge-frontend", "tuneforge-desktop", "tuneforge-backend", "tuneforge-build-info"].includes(name)));
  const requiredAvailableBytes = (fresh ? 44 : appOnly ? 20 : 35) * 1024 ** 3;
  const filesystems = [...new Set([storage.stateDir, storage.cacheDir, ...outputs])]
    .map((target) => ({ target, ...flatpakDiskSpace(target) }));
  return {
    schema: "flatpak-preflight-v1", identity, selectedProfiles, sourceDateEpoch,
    storage: { selection: storage.selection, stateDir: storage.stateDir, cacheDir: storage.cacheDir,
      nativeRepo: storage.nativeRepo, downloads: path.join(storage.stateDir, "downloads"),
      pnpm: path.join(storage.cacheDir, "pnpm"), sccache: path.join(storage.cacheDir, "sccache"), imports },
    invalidation, outputs, disk: { filesystems, requiredAvailableBytes, reserveBytes: 5 * 1024 ** 3,
      sufficient: filesystems.every(({ availableBytes }) => availableBytes >= requiredAvailableBytes),
      growth: "Import estimates cover missing native objects; rebuild/export growth is workload-dependent." },
    limits: ["Read-only; no sources generated, cache imported, lock acquired, or build started.",
      "Shared storage does not prove cross-identity module hits; each identity keeps its native manifest history."],
  };
}
