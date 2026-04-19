import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
const dmgOutputDir = path.join(tauriRoot, "target", "release", "bundle", "dmg");
const dmgOutputPath = path.join(dmgOutputDir, `${productName}_${version}_${arch}.dmg`);

if (!existsSync(appBundlePath)) {
  throw new Error(`App bundle not found at ${appBundlePath}`);
}

mkdirSync(dmgOutputDir, { recursive: true });
rmSync(dmgOutputPath, { force: true });

const stagingDir = mkdtempSync(path.join(os.tmpdir(), "tuneforge-dmg-"));

try {
  cpSync(appBundlePath, path.join(stagingDir, `${productName}.app`), { recursive: true });
  symlinkSync("/Applications", path.join(stagingDir, "Applications"));

  execFileSync(
    "hdiutil",
    ["create", "-volname", productName, "-srcfolder", stagingDir, "-ov", "-format", "UDZO", dmgOutputPath],
    { cwd: workspaceRoot, stdio: "inherit" },
  );

  process.stdout.write(`Created DMG at ${dmgOutputPath}\n`);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
