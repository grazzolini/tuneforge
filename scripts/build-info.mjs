import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const defaultWorkspaceRoot = path.resolve(scriptDir, "..");
const unknownVersion = "unknown";

export function resolveBuildInfo({
  workspaceRoot = defaultWorkspaceRoot,
  versionFilePath = process.env.TUNEFORGE_VERSION_FILE,
} = {}) {
  const fileInfo = readBuildInfoFile(versionFilePath);
  if (fileInfo) {
    return fileInfo;
  }

  const gitRef = resolveGitRef(workspaceRoot);
  return {
    backend: {
      package_version:
        normalizedEnvValue("TUNEFORGE_BACKEND_PACKAGE_VERSION") ??
        readPackageVersion(path.join(workspaceRoot, "apps", "backend", "pyproject.toml")) ??
        unknownVersion,
      git_ref: gitRef,
    },
    frontend: {
      package_version:
        normalizedEnvValue("TUNEFORGE_FRONTEND_PACKAGE_VERSION") ??
        readPackageVersion(path.join(workspaceRoot, "apps", "desktop", "package.json")) ??
        unknownVersion,
      git_ref: gitRef,
    },
  };
}

export function writeBuildInfoFile(outputPath, options = {}) {
  const buildInfo = resolveBuildInfo({ ...options, versionFilePath: null });
  writeResolvedBuildInfoFile(outputPath, buildInfo);
  return buildInfo;
}

export function writeResolvedBuildInfoFile(outputPath, buildInfo) {
  writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  return buildInfo;
}

function normalizedEnvValue(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function resolveGitRef(workspaceRoot) {
  const envGitRef = normalizedEnvValue("TUNEFORGE_GIT_REF");
  if (envGitRef) {
    return envGitRef;
  }

  try {
    return execFileSync("git", ["describe", "--tags", "--long", "--dirty", "--always"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return unknownVersion;
  }
}

function readBuildInfoFile(versionFilePath) {
  if (!versionFilePath || !existsSync(versionFilePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(versionFilePath, "utf8"));
    const backend = normalizeVersionInfo(parsed.backend);
    const frontend = normalizeVersionInfo(parsed.frontend);
    if (!backend || !frontend) {
      return null;
    }
    return { backend, frontend };
  } catch {
    return null;
  }
}

function normalizeVersionInfo(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const packageVersion = typeof value.package_version === "string" ? value.package_version.trim() : "";
  const gitRef = typeof value.git_ref === "string" ? value.git_ref.trim() : "";
  if (!packageVersion || !gitRef) {
    return null;
  }
  return {
    package_version: packageVersion,
    git_ref: gitRef,
  };
}

function readPackageVersion(packagePath) {
  if (!existsSync(packagePath)) {
    return null;
  }

  const contents = readFileSync(packagePath, "utf8");
  if (packagePath.endsWith(".json")) {
    const parsed = JSON.parse(contents);
    return typeof parsed.version === "string" ? parsed.version : null;
  }

  const match = contents.match(/^version = "([^"]+)"$/m);
  return match?.[1] ?? null;
}
