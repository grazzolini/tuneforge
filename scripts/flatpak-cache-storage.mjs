import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const schema = "flatpak-storage-v1";
const selectionFile = "storage-selection-v1.json";
const storageName = /^(?:flatpak-cache-v1-[a-f0-9]{16}|shared)$/;

function safeDirectory(root, name) {
  if (!storageName.test(name)) throw new Error("Unsafe Flatpak storage selection.");
  const target = path.join(root, name);
  if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error(`Unsafe Flatpak storage directory: ${target}`);
  for (let current = target; ; current = path.dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlinked Flatpak storage path: ${current}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current === path.dirname(current)) break;
  }
  return target;
}

function candidates(stateRoot, cacheRoot) {
  if (!existsSync(stateRoot)) return [];
  return readdirSync(stateRoot).filter((name) => storageName.test(name)).map((name) => {
    const stateDir = safeDirectory(stateRoot, name);
    const cacheDir = safeDirectory(cacheRoot, name);
    const config = path.join(stateDir, "cache", "config");
    if (!existsSync(config) || !existsSync(cacheDir)) return null;
    return { name, modified: statSync(config).mtimeMs };
  }).filter(Boolean).sort((left, right) => right.modified - left.modified || left.name.localeCompare(right.name));
}

export function selectFlatpakStorage({ stateRoot, cacheRoot, legacyTestStateRoot, legacyTestCacheRoot } = {}) {
  stateRoot = path.resolve(stateRoot);
  cacheRoot = path.resolve(cacheRoot);
  const selectorPath = path.join(stateRoot, selectionFile);
  let saved;
  if (existsSync(selectorPath)) {
    if (lstatSync(selectorPath).isSymbolicLink()) throw new Error("Symlinked Flatpak storage selector.");
    saved = JSON.parse(readFileSync(selectorPath, "utf8"));
    if (saved.schema !== schema || !storageName.test(saved.name) || !Array.isArray(saved.importedRepositories) ||
      saved.importedRepositories.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))) throw new Error("Malformed Flatpak storage selector.");
  }
  const available = candidates(stateRoot, cacheRoot);
  const name = saved?.name ?? available[0]?.name ?? "shared";
  const stateDir = safeDirectory(stateRoot, name);
  const cacheDir = safeDirectory(cacheRoot, name);
  if (saved && (!existsSync(stateDir) || !existsSync(cacheDir))) throw new Error("Selected Flatpak storage is missing; restore it or select another root explicitly.");
  const nativeRepo = path.join(stateDir, "cache");
  const nativeConfig = path.join(nativeRepo, "config");
  if (existsSync(nativeConfig) && lstatSync(nativeConfig).isSymbolicLink()) throw new Error("Symlinked Flatpak native cache config.");
  if (existsSync(nativeConfig) && !/^mode=bare-user-only$/m.test(readFileSync(nativeConfig, "utf8"))) {
    throw new Error("Flatpak native cache must use OSTree bare-user-only mode.");
  }
  const testCandidates = legacyTestStateRoot && legacyTestCacheRoot
    ? candidates(path.resolve(legacyTestStateRoot), path.resolve(legacyTestCacheRoot)) : [];
  return {
    schema, name, stateRoot, cacheRoot, stateDir, cacheDir, nativeRepo, selectorPath,
    selection: !existsSync(nativeConfig) ? "fresh" : saved ? "persisted" : "adopt-existing-production",
    importedRepositories: saved?.importedRepositories ?? [],
    legacyTestRepositories: testCandidates.map(({ name: candidate }) => path.join(legacyTestStateRoot, candidate, "cache"))
      .filter((repository) => path.resolve(repository) !== nativeRepo),
  };
}

function ostree(args, runCommand) {
  const result = runCommand("ostree", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`OSTree cache probe failed: ${result.error?.message ?? result.stderr?.trim()}`);
  return result.stdout.trim();
}

export function planFlatpakCacheImports(storage, { runCommand = spawnSync } = {}) {
  const targetRefs = existsSync(path.join(storage.nativeRepo, "config"))
    ? new Set(ostree([`--repo=${storage.nativeRepo}`, "refs"], runCommand).split("\n").filter(Boolean)) : new Set();
  return storage.legacyTestRepositories.map((repository) => {
    const sourceKey = createHash("sha256").update(path.resolve(repository)).digest("hex");
    const imported = storage.importedRepositories.includes(sourceKey);
    const refs = imported ? [] : ostree([`--repo=${repository}`, "refs"], runCommand).split("\n")
      .filter((ref) => ref.includes("com.tuneforge.desktop.test.generated.yml/") && !targetRefs.has(ref));
    for (const ref of refs) targetRefs.add(ref);
    return { repository, sourceKey, status: imported ? "already-imported" : refs.length ? "pending" : "no-missing-refs", refs };
  });
}

function persistSelection(storage, importedRepositories) {
  mkdirSync(storage.stateRoot, { recursive: true });
  const temporary = `${storage.selectorPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schema, name: storage.name, importedRepositories }, null, 2)}\n`);
  renameSync(temporary, storage.selectorPath);
}

export function prepareFlatpakStorage(storage, { runCommand = spawnSync } = {}) {
  // Called only after the checkout packaging lock is held; original test storage stays untouched.
  const imports = planFlatpakCacheImports(storage, { runCommand });
  mkdirSync(storage.stateDir, { recursive: true });
  mkdirSync(storage.cacheDir, { recursive: true });
  if (imports.some(({ refs }) => refs.length) && !existsSync(path.join(storage.nativeRepo, "config"))) {
    ostree([`--repo=${storage.nativeRepo}`, "init", "--mode=bare-user-only"], runCommand);
  }
  const completed = new Set(storage.importedRepositories);
  for (const entry of imports) {
    if (entry.refs.length) ostree([`--repo=${storage.nativeRepo}`, "pull-local", "--untrusted", "--depth=-1", entry.repository, ...entry.refs], runCommand);
    completed.add(entry.sourceKey);
    // Record each successful import so a later failed import cannot revert newer shared history.
    persistSelection(storage, [...completed]);
  }
  persistSelection(storage, [...completed]);
  return imports.map(({ status, refs }) => ({ status: status === "pending" ? "imported" : status, refCount: refs.length }));
}

export function flatpakIdentityHistoryPath(storage, testPackage) {
  return path.join(storage.stateDir, "identities", testPackage ? "test" : "production");
}
