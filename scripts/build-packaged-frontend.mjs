import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const versionFilePath = path.join(
  workspaceRoot,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "backend",
  "version.json",
);

if (!existsSync(versionFilePath)) {
  throw new Error(`Packaged version file not found at ${versionFilePath}. Run pnpm -w bundle:prepare first.`);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpm, ["--filter", "@tuneforge/desktop", "build"], {
  cwd: workspaceRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    TUNEFORGE_VERSION_FILE: versionFilePath,
  },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
