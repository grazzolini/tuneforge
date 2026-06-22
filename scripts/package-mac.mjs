import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendSyncArgs,
  packageOptionsEnvironment,
  parsePackageOptions,
  printModelBundleWarning,
} from "./package-options.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const backendRoot = path.join(workspaceRoot, "apps", "backend");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
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

function main() {
  const rawArgs = process.argv.slice(2);
  const appOnly = rawArgs.includes("--app-only");
  const options = parsePackageOptions(
    rawArgs.filter((arg) => arg !== "--app-only"),
    { platform: "mac" },
  );

  if (options.modelBundle) {
    printModelBundleWarning();
  }

  run("uv", backendSyncArgs(options), { cwd: backendRoot });
  run("pnpm", ["--filter", "@tuneforge/desktop", "tauri", "build", "--bundles", "app"], {
    env: packageOptionsEnvironment(options),
  });
  if (!appOnly) {
    run(process.execPath, [path.join("scripts", "package-dmg.mjs")]);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
