import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(__filename), "..");

function readText(relativePath) {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

function readJsonVersion(relativePath) {
  const parsed = JSON.parse(readText(relativePath));
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`${relativePath} does not define a string "version" field.`);
  }
  return parsed.version;
}

function readTomlSectionVersion(relativePath, sectionName) {
  const lines = readText(relativePath).split(/\r?\n/);
  let inSection = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSection = sectionMatch[1] === sectionName;
      continue;
    }
    if (!inSection) {
      continue;
    }

    const versionMatch = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/);
    if (versionMatch) {
      return versionMatch[1];
    }
  }

  throw new Error(`${relativePath} does not define "${sectionName}.version".`);
}

function readMetainfoReleaseVersion(relativePath) {
  const contents = readText(relativePath);
  const releaseMatch = contents.match(/<release\b[^>]*\bversion="([^"]+)"[^>]*>/);
  if (!releaseMatch) {
    throw new Error(`${relativePath} does not define a release version.`);
  }
  return releaseMatch[1];
}

const versionSources = [
  {
    label: "backend package",
    path: "apps/backend/pyproject.toml",
    version: () => readTomlSectionVersion("apps/backend/pyproject.toml", "project"),
  },
  {
    label: "desktop package",
    path: "apps/desktop/package.json",
    version: () => readJsonVersion("apps/desktop/package.json"),
  },
  {
    label: "tauri config",
    path: "apps/desktop/src-tauri/tauri.conf.json",
    version: () => readJsonVersion("apps/desktop/src-tauri/tauri.conf.json"),
  },
  {
    label: "tauri cargo package",
    path: "apps/desktop/src-tauri/Cargo.toml",
    version: () => readTomlSectionVersion("apps/desktop/src-tauri/Cargo.toml", "package"),
  },
  {
    label: "shared types package",
    path: "packages/shared-types/package.json",
    version: () => readJsonVersion("packages/shared-types/package.json"),
  },
  {
    label: "Flatpak metainfo latest release",
    path: "packaging/flatpak/com.tuneforge.desktop.metainfo.xml",
    version: () => readMetainfoReleaseVersion("packaging/flatpak/com.tuneforge.desktop.metainfo.xml"),
  },
];

function main() {
  const versions = versionSources.map((source) => ({
    label: source.label,
    path: source.path,
    version: source.version(),
  }));
  const expectedVersion = versions[0].version;
  const mismatches = versions.filter((source) => source.version !== expectedVersion);

  if (mismatches.length > 0) {
    process.stderr.write("Release versions do not match:\n");
    for (const source of versions) {
      process.stderr.write(`  ${source.version.padEnd(12)} ${source.path} (${source.label})\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Release version check passed: ${expectedVersion}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
