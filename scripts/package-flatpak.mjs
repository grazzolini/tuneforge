import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(workspaceRoot, "packaging", "flatpak", "com.tuneforge.desktop.yml");
const buildDir = process.env.FLATPAK_BUILD_DIR ?? path.join(workspaceRoot, "packaging", "flatpak", "build-dir");
const repoDir = process.env.FLATPAK_REPO_DIR ?? path.join(workspaceRoot, "packaging", "flatpak", "repo");
const appId = "com.tuneforge.desktop";
const localRepoRemote = "tuneforge-local";
const skipBundle = process.argv.includes("--no-bundle") || process.env.FLATPAK_NO_BUNDLE === "1";
const appVersion = JSON.parse(
  readFileSync(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
).version;
const bundlePath =
  process.env.FLATPAK_BUNDLE_PATH ??
  path.join(workspaceRoot, "packaging", "flatpak", `Tuneforge_${appVersion}_x86_64.flatpak`);

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

function checkCommand(command, installHint) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required. ${installHint}`);
  }
  if (result.status !== 0) {
    throw new Error(`Could not run ${command} --version`);
  }
}

function main() {
  if (process.arch !== "x64") {
    throw new Error("Tuneforge Flatpak packaging currently targets Linux x86_64 only.");
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Flatpak manifest not found at ${manifestPath}`);
  }

  run(process.execPath, [path.join("scripts", "generate-flatpak-sources.mjs")]);

  checkCommand(
    "flatpak-builder",
    "Install flatpak-builder and the Flathub runtimes before running pnpm package:linux:flatpak.",
  );
  checkCommand("flatpak", "Install flatpak before running pnpm package:linux:flatpak.");

  run("flatpak-builder", [
    "--force-clean",
    "--arch=x86_64",
    "--default-branch=stable",
    "--install-deps-from=flathub",
    "--repo",
    repoDir,
    buildDir,
    manifestPath,
  ]);
  if (skipBundle) {
    process.stdout.write(`Flatpak repo exported to ${repoDir}\n`);
    process.stdout.write(
      `Install with: flatpak remote-add --user --if-not-exists --no-gpg-verify ${localRepoRemote} ${repoDir}\n`,
    );
    process.stdout.write(`Then run: flatpak install --user --reinstall ${localRepoRemote} ${appId}\n`);
    return;
  }

  run("flatpak", ["build-bundle", "--arch=x86_64", repoDir, bundlePath, appId, "stable"]);

  process.stdout.write(`Flatpak bundle written to ${bundlePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
