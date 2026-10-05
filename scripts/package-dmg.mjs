import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageProfile } from "./package-profile.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const tauriRoot = path.join(workspaceRoot, "apps", "desktop", "src-tauri");
const tauriConfig = JSON.parse(readFileSync(path.join(tauriRoot, "tauri.conf.json"), "utf8"));

const version = tauriConfig.version;
const arch = process.arch === "arm64" ? "aarch64" : process.arch;

export function dmgPaths(testPackage = false) {
  const profile = packageProfile(testPackage);
  const bundleRoot = path.join(tauriRoot, "target", ...(testPackage ? ["test-package"] : []), "release", "bundle");
  return {
    source: path.join(bundleRoot, "macos", `${profile.name}.app`),
    output: path.join(bundleRoot, "dmg", `${profile.name}_${version}_${arch}.dmg`),
    name: profile.name,
  };
}

export function createDmg({
  source = dmgPaths().source,
  output = dmgPaths().output,
  name = dmgPaths().name,
  copy = cpSync,
  execute = execFileSync,
  temporaryRoot = os.tmpdir(),
} = {}) {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error(`App bundle not found at ${source}`);
  }

  mkdirSync(path.dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const stagingDir = mkdtempSync(path.join(temporaryRoot, "tuneforge-dmg-"));
  let completed = false;
  try {
    copy(source, path.join(stagingDir, `${name}.app`), { recursive: true });
    symlinkSync("/Applications", path.join(stagingDir, "Applications"));
    execute("diskutil", [
      "image", "create", "from", "--volumeName", name, "--format", "UDZO", stagingDir, output,
    ], { cwd: workspaceRoot, stdio: "inherit" });
    if (!existsSync(output)) throw new Error(`DMG was not created at ${output}`);
    completed = true;
    process.stdout.write(`Created DMG at ${output}\n`);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    if (!completed) rmSync(output, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== "--test")) {
    throw new Error("Usage: package-dmg.mjs [--test]");
  }
  createDmg(dmgPaths(args.includes("--test")));
}
