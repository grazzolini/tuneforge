import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const tauriRoot = path.join(workspaceRoot, "apps", "desktop", "src-tauri");
const tauriConfig = JSON.parse(readFileSync(path.join(tauriRoot, "tauri.conf.json"), "utf8"));

const productName = tauriConfig.productName;
const version = tauriConfig.version;
const arch = process.arch === "arm64" ? "aarch64" : process.arch;
const appBundlePath = path.join(tauriRoot, "target", "release", "bundle", "macos", `${productName}.app`);
const dmgOutputPath = path.join(tauriRoot, "target", "release", "bundle", "dmg", `${productName}_${version}_${arch}.dmg`);

export function createDmg({
  source = appBundlePath,
  output = dmgOutputPath,
  name = productName,
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
  createDmg();
}
