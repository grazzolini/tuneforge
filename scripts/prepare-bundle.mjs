import {
  cpSync,
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildInfo, writeResolvedBuildInfoFile } from "./build-info.mjs";
import {
  packageOptionsFromEnvironmentOrArgv,
  printModelBundleWarning,
} from "./package-options.mjs";

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
const stagedModelBundleRoot = path.join(stagedBackendRoot, "models", "bundle");
const sourceDemucsManifestPath = path.join(workspaceRoot, "packaging", "demucs", "models.json");
const stagedLvChordiaRoot = path.join(stagedPythonRoot, "share", "lv-chordia", "cache_data");
const sourceLvChordiaRoot = path.join(backendRoot, ".venv", "share", "lv-chordia", "cache_data");
const cremaLicensePath = path.join(workspaceRoot, "LICENSES", "crema-0.2.0-BSD-2-Clause.txt");
const CREMA_ONNX_ARTIFACT_NAMES = new Set([
  "crema-0.2.0-opset18.onnx",
  "crema-0.2.0-runtime-state.json",
]);
const CREMA_ONNX_REVISION = "65af18f49af5101267fd28f15ac8c452d98b8e3d";
export const CREMA_ONNX_BUNDLE_RELATIVE_PATHS = Array.from(CREMA_ONNX_ARTIFACT_NAMES, (name) =>
  path.join("models", "bundle", "crema", "0.2.0", CREMA_ONNX_REVISION, name),
).sort();
export const DEMUCS_MANIFEST_BACKEND_RELATIVE_PATH = path.join("src", "demucs-models.json");
export const LV_CHORDIA_CHECKPOINT_NAMES = [
  "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s0.best.sdict",
  "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s1.best.sdict",
  "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s2.best.sdict",
  "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s3.best.sdict",
  "joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s4.best.sdict",
];

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

function checkpointPaths(root) {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? checkpointPaths(entryPath) : entry.name.endsWith(".sdict") ? [entryPath] : [];
  });
}

function cremaModelPaths(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return cremaModelPaths(entryPath);
    return CREMA_ONNX_ARTIFACT_NAMES.has(entry.name) ? [entryPath] : [];
  });
}

export function assertCremaOnnxBundleLayout(root, enabled) {
  const actual = cremaModelPaths(root).map((filePath) => path.relative(root, filePath)).sort();
  const expected = enabled ? CREMA_ONNX_BUNDLE_RELATIVE_PATHS : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected Crema ONNX model bundle layout: ${actual.join(", ") || "none"}`);
  }
}

export function assertLvChordiaBundleLayout(root, enabled) {
  const actual = checkpointPaths(root).map((filePath) => path.relative(root, filePath)).sort();
  const expected = enabled
    ? LV_CHORDIA_CHECKPOINT_NAMES.map((name) => path.join("python", "share", "lv-chordia", "cache_data", name)).sort()
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected LV Chordia checkpoint layout: ${actual.join(", ") || "none"}`);
  }
}

export function stageDemucsManifest(root) {
  const destination = path.join(root, DEMUCS_MANIFEST_BACKEND_RELATIVE_PATH);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyInto(sourceDemucsManifestPath, destination);
  const manifest = JSON.parse(readFileSync(destination, "utf8"));
  if (manifest.version !== 2 || !Array.isArray(manifest.models)) {
    throw new Error(`Invalid staged Demucs manifest: ${destination}`);
  }
  return destination;
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

function prepareModelBundle(options) {
  if (!options.modelBundle && options.crema === "none") {
    return;
  }

  if (options.modelBundle && !process.env.TUNEFORGE_PACKAGE_OPTIONS) {
    printModelBundleWarning();
  }
  const pythonPath = path.join(backendRoot, ".venv", "bin", "python");
  requirePath(pythonPath, "Backend virtualenv Python");
  if (!options.modelBundle) {
    run(
      pythonPath,
      [
        "-c",
        [
          "import json, shutil, sys",
          "from pathlib import Path",
          "from app.engines.crema_onnx import MODEL_REVISION, ensure_crema_onnx_files, expected_model_files",
          "from app.utils.model_cache import ExpectedModelFile, invalid_model_files",
          "output = Path(sys.argv[1])",
          "shutil.rmtree(output, ignore_errors=True)",
          "ensure_crema_onnx_files()",
          "entries = []",
          "for source in expected_model_files():",
          "    relative = Path('crema') / '0.2.0' / MODEL_REVISION / source.path.name",
          "    destination = output / relative",
          "    destination.parent.mkdir(parents=True, exist_ok=True)",
          "    shutil.copy2(source.path, destination)",
          "    copied = ExpectedModelFile(source.label, destination, source.size, source.sha256)",
          "    assert not invalid_model_files((copied,)), destination",
          "    entries.append({'label': source.label, 'file_name': source.path.name, 'relative_path': relative.as_posix(), 'size': source.size, 'sha256': source.sha256})",
          "manifest = {'version': 2, 'torch_checkpoints': [], 'demucs_hf_models': [], 'whisper_models': [], 'crema_onnx_files': entries}",
          "(output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')",
        ].join("\n"),
        stagedModelBundleRoot,
      ],
      { cwd: backendRoot },
    );
    return;
  }
  const args = ["-m", "app.cli.prepare_model_bundle", "--output", stagedModelBundleRoot];
  if (options.beatThis) {
    args.push("--include-beat-this");
  }
  if (options.crema === "onnx") {
    args.push("--include-crema-onnx");
  }
  run(pythonPath, args, { cwd: backendRoot });
}

function verifyBundledDependencyAssets(options) {
  if (!options.lvChordia) {
    return;
  }
  const pythonPath = path.join(backendRoot, ".venv", "bin", "python");
  requirePath(pythonPath, "Backend virtualenv Python");
  run(
    pythonPath,
    [
      "-c",
      "from app.engines.lv_chordia import lv_chordia_dependency_status; " +
        "available, reason = lv_chordia_dependency_status(); assert available, reason",
    ],
    { cwd: backendRoot },
  );
}

function stageLvChordiaAssets(options) {
  if (options.lvChordia) {
    requirePath(sourceLvChordiaRoot, "LV Chordia checkpoint source");
    mkdirSync(path.dirname(stagedLvChordiaRoot), { recursive: true });
    copyInto(sourceLvChordiaRoot, stagedLvChordiaRoot);
  }
  assertLvChordiaBundleLayout(stagedBackendRoot, options.lvChordia);
  if (!options.lvChordia) {
    return;
  }
  const stagedPython = path.join(stagedPythonRoot, "bin", "python3.14");
  run(
    stagedPython,
    [
      "-c",
      "from app.engines.lv_chordia import lv_chordia_dependency_status; " +
        "available, reason = lv_chordia_dependency_status(); assert available, reason",
    ],
    {
      cwd: stagedBackendSourceRoot,
      env: {
        DYLD_LIBRARY_PATH: path.join(stagedPythonRoot, "lib"),
        PYTHONPATH: `${stagedBackendSourceRoot}${path.delimiter}${stagedSitePackagesRoot}`,
      },
    },
  );
}

async function main() {
  const packageOptions = packageOptionsFromEnvironmentOrArgv(process.argv.slice(2), { platform: "mac" });
  const venvConfigPath = path.join(backendRoot, ".venv", "pyvenv.cfg");
  const sitePackagesRoot = path.join(backendRoot, ".venv", "lib", "python3.14", "site-packages");
  requirePath(venvConfigPath, "Backend virtualenv config");
  requirePath(sitePackagesRoot, "Backend site-packages");
  sitePackagesRootForFilter = sitePackagesRoot;
  verifyBundledDependencyAssets(packageOptions);
  const buildInfo = resolveBuildInfo({ workspaceRoot, versionFilePath: null });

  const pythonHomeBin = parsePythonHome(venvConfigPath);
  const pythonInstallRoot = path.resolve(pythonHomeBin, "..");
  requirePath(pythonInstallRoot, "Bundled Python runtime source");

  rmSync(resourcesRoot, { recursive: true, force: true });
  mkdirSync(resourcesRoot, { recursive: true });
  mkdirSync(stagedBackendSourceRoot, { recursive: true });

  copyInto(path.join(backendRoot, "app"), path.join(stagedBackendSourceRoot, "app"));
  stageDemucsManifest(stagedBackendRoot);
  copyInto(path.join(backendRoot, "alembic"), path.join(stagedBackendSourceRoot, "alembic"));
  copyInto(path.join(backendRoot, "alembic.ini"), path.join(stagedBackendSourceRoot, "alembic.ini"));
  copyInto(path.join(backendRoot, "pyproject.toml"), path.join(stagedBackendSourceRoot, "pyproject.toml"));
  mkdirSync(path.join(stagedBackendRoot, "licenses"), { recursive: true });
  copyInto(cremaLicensePath, path.join(stagedBackendRoot, "licenses", path.basename(cremaLicensePath)));
  copyInto(pythonInstallRoot, stagedPythonRoot, { dereference: true });
  copyInto(sitePackagesRoot, stagedSitePackagesRoot, { filter: shouldIncludeBundledSitePackage });
  stageLvChordiaAssets(packageOptions);
  prepareModelBundle(packageOptions);
  assertCremaOnnxBundleLayout(
    stagedBackendRoot,
    packageOptions.crema === "onnx",
  );
  writeResolvedBuildInfoFile(path.join(stagedBackendRoot, "version.json"), buildInfo);

  const manifest = {
    prepared_at: new Date().toISOString(),
    python_root: path.relative(resourcesRoot, stagedPythonRoot),
    site_packages: path.relative(resourcesRoot, stagedSitePackagesRoot),
    backend_source: path.relative(resourcesRoot, stagedBackendSourceRoot),
    version_info: path.relative(resourcesRoot, path.join(stagedBackendRoot, "version.json")),
  };
  if (packageOptions.modelBundle || packageOptions.crema === "onnx") {
    manifest.model_bundle = path.relative(resourcesRoot, stagedModelBundleRoot);
  }

  writeFileSync(
    path.join(stagedBackendRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeFileSync(path.join(resourcesRoot, ".gitkeep"), "");
  writeFileSync(path.join(resourcesRoot, "placeholder.txt"), "Generated resources live here.\n");

  process.stdout.write(`Prepared bundled backend resources in ${resourcesRoot}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
