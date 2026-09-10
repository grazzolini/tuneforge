import { chmod, cp, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps", "desktop");
const tauriRoot = path.join(desktop, "src-tauri");
const appleRoot = path.join(tauriRoot, "gen", "apple");
const targetRoot = path.join(tauriRoot, "target");
const iconRoot = path.join(targetRoot, "ios-icons");
const toolchainBin = path.join(targetRoot, "ios-toolchain-bin");
const buildDebug = process.argv.slice(2).includes("--build-debug");

async function exists(value) {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktop,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return options.capture ? result.stdout.trim() : undefined;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function prepareToolchainEnvironment() {
  const developerDir = process.env.DEVELOPER_DIR;
  if (!developerDir) {
    throw new Error("Set DEVELOPER_DIR to the selected Xcode developer directory.");
  }

  const rustc = run("rustup", ["which", "rustc", "--toolchain", "stable"], {
    capture: true,
  });
  const cargo = run("rustup", ["which", "cargo", "--toolchain", "stable"], {
    capture: true,
  });
  await mkdir(toolchainBin, { recursive: true });
  const scripts = {
    "xcode-select": `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "-p" ]; then\n  printf '%s\\n' ${shellQuote(developerDir)}\n  exit 0\nfi\nexec /usr/bin/xcode-select "$@"\n`,
    xcodebuild: `#!/bin/sh\nDEVELOPER_DIR=${shellQuote(developerDir)} exec /usr/bin/xcodebuild "$@"\n`,
    cargo: `#!/bin/sh\nRUSTC=${shellQuote(rustc)} exec ${shellQuote(cargo)} "$@"\n`,
  };
  await Promise.all(
    Object.entries(scripts).map(async ([name, contents]) => {
      const destination = path.join(toolchainBin, name);
      await writeFile(destination, contents);
      await chmod(destination, 0o755);
    }),
  );
  return {
    ...process.env,
    PATH: `${toolchainBin}${path.delimiter}${process.env.PATH ?? ""}`,
    RUSTC: rustc,
  };
}

function runTauri(args, env) {
  run("pnpm", ["exec", "tauri", ...args], { env });
}

const toolchainEnv = await prepareToolchainEnvironment();

await mkdir(targetRoot, { recursive: true });
if (await exists(appleRoot)) {
  const backup = path.join(targetRoot, `ios-scaffold-${Date.now()}`);
  await rename(appleRoot, backup);
  console.log(`Preserved previous iOS scaffold at ${path.relative(root, backup)}.`);
}

runTauri([
  "ios",
  "init",
  "--ci",
  "--skip-targets-install",
  "--config",
  "src-tauri/tauri.ios.conf.json",
], toolchainEnv);
runTauri(["icon", "src-tauri/icons/icon.png", "--output", iconRoot], toolchainEnv);

const generatedIcons = path.join(iconRoot, "ios");
const appIconSet = path.join(appleRoot, "Assets.xcassets", "AppIcon.appiconset");
await cp(generatedIcons, appIconSet, { recursive: true });
console.log("Generated the iOS scaffold and TuneForge app icons.");

if (buildDebug) {
  runTauri(
    [
      "ios",
      "build",
      "--debug",
      "--target",
      "aarch64-sim",
      "--ci",
      "--no-sign",
      "--config",
      "src-tauri/tauri.ios.conf.json",
    ],
    toolchainEnv,
  );
}
