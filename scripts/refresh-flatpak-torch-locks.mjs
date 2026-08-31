import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  flatpakTorchLockPaths,
  validateFlatpakTorchLock,
} from "./generate-flatpak-sources.mjs";

const __filename = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(__filename), "..");
const profiles = new Map([
  ["--cpu", { id: "cpu", backend: "cpu", lockPath: flatpakTorchLockPaths.cpu }],
  ["--legacy-nvidia", { id: "legacy-nvidia", backend: "cu126", lockPath: flatpakTorchLockPaths["legacy-nvidia"] }],
]);

function selectedProfiles(argv) {
  if (argv.length === 0) throw new Error("Select --cpu and/or --legacy-nvidia to refresh reviewed Torch locks.");
  const selected = [];
  for (const argument of argv) {
    const profile = profiles.get(argument);
    if (!profile) throw new Error(`Unknown Torch lock refresh option: ${argument}`);
    if (!selected.includes(profile)) selected.push(profile);
  }
  return selected;
}

function compileTorchLock(profile, requirementsPath, temporaryPath) {
  writeFileSync(requirementsPath, "torch==2.13.0\ntorchaudio==2.11.0\n");
  const result = spawnSync("uv", [
    "--quiet", "pip", "compile", requirementsPath,
    "--python-version", "3.14",
    "--python-platform", "x86_64-manylinux_2_28",
    "--torch-backend", profile.backend,
    "--format", "pylock.toml",
    "--output-file", temporaryPath,
    "--no-header", "--no-annotate",
  ], { cwd: workspaceRoot, stdio: "inherit" });
  if (result.error?.code === "ENOENT") throw new Error("Required command not found: uv");
  if (result.status !== 0) throw new Error(`uv exited with status ${result.status}`);
}

export function refreshTorchLock(profile, { compile = compileTorchLock } = {}) {
  const directory = path.dirname(profile.lockPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `pylock.${profile.id}-${process.pid}.toml`);
  const requirementsPath = path.join(directory, `.torch-${profile.id}-${process.pid}.in`);
  try {
    compile(profile, requirementsPath, temporaryPath);
    const { pairId } = validateFlatpakTorchLock(profile.id, readFileSync(temporaryPath, "utf8"));
    renameSync(temporaryPath, profile.lockPath);
    process.stdout.write(`Refreshed ${path.relative(workspaceRoot, profile.lockPath)}\n`);
    if (pairId) process.stdout.write(`Review LegacyNvidia pair ID: ${pairId}\n`);
  } finally {
    rmSync(requirementsPath, { force: true });
    rmSync(temporaryPath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    for (const profile of selectedProfiles(process.argv.slice(2))) refreshTorchLock(profile);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
