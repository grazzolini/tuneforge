import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendSyncArgs,
  packageOptionsEnvironment,
  parsePackageOptions,
  printModelBundleWarning,
} from "./package-options.mjs";
import { writeTestTauriOverlay } from "./package-profile.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const backendRoot = path.join(workspaceRoot, "apps", "backend");
const tauriRoot = path.join(workspaceRoot, "apps", "desktop", "src-tauri");

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

  const configuredFfmpeg = process.env.TUNEFORGE_FFMPEG_RUNTIME_DIR;
  if (!configuredFfmpeg) {
    run(process.execPath, [
      path.join("scripts", "build-ffmpeg.mjs"),
      "--target", "macos-arm64",
      "--ensure",
    ]);
  }

  run(process.execPath, [
    path.join("scripts", "validate-packaged-ffmpeg.mjs"),
    "--target", "macos-arm64",
    "--root", configuredFfmpeg
      ?? path.join("packaging", "ffmpeg", "generated", "macos-arm64"),
  ]);

  run("uv", backendSyncArgs(options), { cwd: backendRoot });
  const configArgs = options.testPackage
    ? ["--config", writeTestTauriOverlay(tauriRoot)] : [];
  run("pnpm", ["--filter", "@tuneforge/desktop", "tauri", "build", "--bundles", "app", ...configArgs], {
    env: {
      ...packageOptionsEnvironment(options),
      ...(options.testPackage ? { CARGO_TARGET_DIR: path.join(tauriRoot, "target", "test-package") } : {}),
    },
  });
  if (!appOnly) {
    run(process.execPath, [path.join("scripts", "package-dmg.mjs"), ...(options.testPackage ? ["--test"] : [])]);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
