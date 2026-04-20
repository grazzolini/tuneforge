import {
  cpSync,
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const backendRoot = path.join(workspaceRoot, "apps", "backend");
const tauriRoot = path.join(workspaceRoot, "apps", "desktop", "src-tauri");
const resourcesRoot = path.join(tauriRoot, "resources");
const stagedBackendRoot = path.join(resourcesRoot, "backend");
const stagedBackendSourceRoot = path.join(stagedBackendRoot, "src");
const stagedPythonRoot = path.join(stagedBackendRoot, "python");
const stagedSitePackagesRoot = path.join(stagedBackendRoot, "site-packages");

function requirePath(targetPath, description) {
  if (!existsSync(targetPath)) {
    throw new Error(`${description} not found at ${targetPath}`);
  }
}

function copyInto(sourcePath, destinationPath, { dereference = false, filter } = {}) {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    preserveTimestamps: true,
    dereference,
    filter,
  });
}

function parsePythonHome(venvConfigPath) {
  const contents = readFileSync(venvConfigPath, "utf8");
  const homeLine = contents
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("home = "));

  if (!homeLine) {
    throw new Error(`Could not find "home" in ${venvConfigPath}`);
  }

  return homeLine.replace("home = ", "").trim();
}

function shouldIncludeBundledSitePackage(sourcePath) {
  const relativePath = path.relative(sitePackagesRootForFilter, sourcePath);
  if (!relativePath || relativePath === "") {
    return true;
  }

  const segments = relativePath.split(path.sep);
  // Keep runtime package submodules intact. Torch imports from torch/testing at runtime,
  // so filtering generic names like "test" or "testing" breaks packaged builds.
  if (segments.includes("__pycache__")) {
    return false;
  }

  return true;
}

let sitePackagesRootForFilter = "";

function main() {
  const venvConfigPath = path.join(backendRoot, ".venv", "pyvenv.cfg");
  const sitePackagesRoot = path.join(backendRoot, ".venv", "lib", "python3.11", "site-packages");
  requirePath(venvConfigPath, "Backend virtualenv config");
  requirePath(sitePackagesRoot, "Backend site-packages");
  sitePackagesRootForFilter = sitePackagesRoot;

  const pythonHomeBin = parsePythonHome(venvConfigPath);
  const pythonInstallRoot = path.resolve(pythonHomeBin, "..");
  requirePath(pythonInstallRoot, "Bundled Python runtime source");

  rmSync(resourcesRoot, { recursive: true, force: true });
  mkdirSync(resourcesRoot, { recursive: true });
  mkdirSync(stagedBackendSourceRoot, { recursive: true });

  copyInto(path.join(backendRoot, "app"), path.join(stagedBackendSourceRoot, "app"));
  copyInto(path.join(backendRoot, "alembic"), path.join(stagedBackendSourceRoot, "alembic"));
  copyInto(path.join(backendRoot, "alembic.ini"), path.join(stagedBackendSourceRoot, "alembic.ini"));
  copyInto(path.join(backendRoot, "pyproject.toml"), path.join(stagedBackendSourceRoot, "pyproject.toml"));
  copyInto(pythonInstallRoot, stagedPythonRoot, { dereference: true });
  copyInto(sitePackagesRoot, stagedSitePackagesRoot, { filter: shouldIncludeBundledSitePackage });

  writeFileSync(
    path.join(stagedBackendRoot, "manifest.json"),
    JSON.stringify(
      {
        prepared_at: new Date().toISOString(),
        python_root: path.relative(resourcesRoot, stagedPythonRoot),
        site_packages: path.relative(resourcesRoot, stagedSitePackagesRoot),
        backend_source: path.relative(resourcesRoot, stagedBackendSourceRoot),
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(resourcesRoot, ".gitkeep"), "");
  writeFileSync(path.join(resourcesRoot, "placeholder.txt"), "Generated resources live here.\n");

  process.stdout.write(`Prepared bundled backend resources in ${resourcesRoot}\n`);
}

main();
