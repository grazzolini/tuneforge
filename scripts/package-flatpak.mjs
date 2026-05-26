import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeBuildInfoFile } from "./build-info.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const flatpakRoot = path.join(workspaceRoot, "packaging", "flatpak");
const baseManifestPath = path.join(flatpakRoot, "com.tuneforge.desktop.yml");
const flatpakVersionInfoPath = path.join(flatpakRoot, "generated", "version.json");
const appId = "com.tuneforge.desktop";
const skipBundle = process.argv.includes("--no-bundle") || process.env.FLATPAK_NO_BUNDLE === "1";
const profile = readProfileArg();
const profileSuffix = profile === "standard" ? "" : `-${profile}`;
const localRepoRemote = profile === "standard" ? "tuneforge-local" : `tuneforge-local-${profile}`;
const buildDir =
  process.env.FLATPAK_BUILD_DIR ?? path.join(flatpakRoot, profile === "standard" ? "build-dir" : `build-dir-${profile}`);
const repoDir = process.env.FLATPAK_REPO_DIR ?? path.join(flatpakRoot, profile === "standard" ? "repo" : `repo-${profile}`);
const appVersion = JSON.parse(
  readFileSync(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
).version;
const bundlePath =
  process.env.FLATPAK_BUNDLE_PATH ??
  path.join(flatpakRoot, `Tuneforge_${appVersion}_x86_64${profileSuffix}.flatpak`);

function readProfileArg() {
  const profileFlagIndex = process.argv.indexOf("--profile");
  const requestedProfile =
    profileFlagIndex === -1
      ? process.env.FLATPAK_PROFILE ?? "standard"
      : process.argv[profileFlagIndex + 1];
  if (!["standard", "full"].includes(requestedProfile)) {
    throw new Error(`Unsupported Flatpak profile: ${requestedProfile}`);
  }
  return requestedProfile;
}

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

function fullProfileManifestPath() {
  const generatedManifestPath = path.join(flatpakRoot, "com.tuneforge.desktop.full.generated.yml");
  const baseManifest = readFileSync(baseManifestPath, "utf8");
  let fullManifest = replaceManifestFragment(
    baseManifest,
    "  - --device=dri\n",
    "  - --device=all\n  - --filesystem=xdg-data/tuneforge:create\n",
  );
  fullManifest = replaceManifestFragment(
    fullManifest,
    "  - --env=TUNEFORGE_DATA_DIR=/var/data/tuneforge\n",
    "  - --env=TUNEFORGE_DATA_DIR=~/.local/share/tuneforge\n",
  );
  fullManifest = replaceManifestFragment(
    fullManifest,
    '      - /app/lib/tuneforge/backend/python/bin/python3.11 -c "import fastapi, demucs, whisper, torch"\n',
    '      - /app/lib/tuneforge/backend/python/bin/python3.11 -c "import fastapi, demucs, whisper, torch, crema, tensorflow, keras, beat_this"\n',
  );
  writeFileSync(generatedManifestPath, fullManifest);
  return generatedManifestPath;
}

function replaceManifestFragment(contents, search, replacement) {
  if (!contents.includes(search)) {
    throw new Error(`Could not find expected Flatpak manifest fragment: ${search.trim()}`);
  }
  return contents.replace(search, replacement);
}

function manifestPathForProfile() {
  return profile === "standard" ? baseManifestPath : fullProfileManifestPath();
}

function bytesToMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function directorySize(targetPath) {
  const stats = lstatSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.size;
  }
  return readdirSync(targetPath).reduce(
    (total, childName) => total + directorySize(path.join(targetPath, childName)),
    0,
  );
}

function printAppDirectorySizeReport() {
  const appFilesRoot = path.join(buildDir, "files");
  if (!existsSync(appFilesRoot)) {
    return;
  }
  const rows = readdirSync(appFilesRoot)
    .map((name) => {
      const targetPath = path.join(appFilesRoot, name);
      return { name: `/app/${name}`, size: directorySize(targetPath) };
    })
    .sort((left, right) => right.size - left.size)
    .slice(0, 12);
  process.stdout.write(`Flatpak ${profile} /app size report:\n`);
  for (const row of rows) {
    process.stdout.write(`  ${bytesToMiB(row.size).padStart(10)} ${row.name}\n`);
  }
}

function printPythonWheelSizeReport() {
  const reportPath = path.join(flatpakRoot, "generated", "python-size-report.json");
  if (!existsSync(reportPath)) {
    return;
  }
  const entries = JSON.parse(readFileSync(reportPath, "utf8")).slice(0, 15);
  process.stdout.write(`Flatpak ${profile} selected Python artifact report:\n`);
  for (const entry of entries) {
    const size = typeof entry.size === "number" ? bytesToMiB(entry.size).padStart(10) : "unknown".padStart(10);
    process.stdout.write(`  ${size} ${entry.name}==${entry.version} ${entry.fileName}\n`);
  }
}

function main() {
  if (process.arch !== "x64") {
    throw new Error("Tuneforge Flatpak packaging currently targets Linux x86_64 only.");
  }
  if (!existsSync(baseManifestPath)) {
    throw new Error(`Flatpak manifest not found at ${baseManifestPath}`);
  }

  run(process.execPath, [path.join("scripts", "generate-flatpak-sources.mjs"), "--profile", profile]);
  writeBuildInfoFile(flatpakVersionInfoPath, { workspaceRoot });
  const manifestPath = manifestPathForProfile();

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
  printAppDirectorySizeReport();
  printPythonWheelSizeReport();
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
