import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const demucsRoot = path.join(workspaceRoot, "packaging", "demucs");
const manifestPath = path.join(demucsRoot, "models.json");
const defaultCacheRoot = path.join(demucsRoot, "cache");
export const defaultPreparedModelRoot = path.join(
  workspaceRoot,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "backend",
  "models",
  "demucs",
);

function modelMode(modelId) {
  if (modelId === "htdemucs_6s") {
    return "six_stems";
  }
  if (modelId === "htdemucs_ft") {
    return "two_stems";
  }
  throw new Error(`Unsupported Demucs model id: ${modelId}`);
}

export function readDemucsModelManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Demucs model manifest must be an object.");
  }
  if (typeof manifest.rootUrl !== "string") {
    throw new Error("Demucs model manifest rootUrl must be a string.");
  }
  try {
    new URL(manifest.rootUrl);
  } catch {
    throw new Error(`Demucs model manifest rootUrl is invalid: ${manifest.rootUrl}`);
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error("Demucs model manifest must define at least one model.");
  }

  const modelIds = new Set();
  const fileNames = new Set();
  for (const model of manifest.models) {
    if (!model || typeof model !== "object") {
      throw new Error("Demucs model manifest entries must be objects.");
    }
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw new Error("Demucs model manifest model id must be a non-empty string.");
    }
    if (modelIds.has(model.id)) {
      throw new Error(`Demucs model manifest has duplicate model id: ${model.id}`);
    }
    modelIds.add(model.id);
    if (
      typeof model.yaml !== "string" ||
      model.yaml.length === 0 ||
      model.yaml.includes("/") ||
      model.yaml.includes("\\")
    ) {
      throw new Error(`Demucs model manifest has invalid yaml path for ${model.id}.`);
    }
    if (!existsSync(path.join(demucsRoot, model.yaml))) {
      throw new Error(`Demucs model yaml not found: ${model.yaml}`);
    }
    if (!Array.isArray(model.files) || model.files.length === 0) {
      throw new Error(`Demucs model ${model.id} must define at least one file.`);
    }
    for (const file of model.files) {
      if (!file || typeof file !== "object") {
        throw new Error(`Demucs model ${model.id} file entries must be objects.`);
      }
      if (
        typeof file.fileName !== "string" ||
        file.fileName.length === 0 ||
        file.fileName.includes("/") ||
        file.fileName.includes("\\")
      ) {
        throw new Error(`Demucs model ${model.id} has invalid fileName.`);
      }
      if (fileNames.has(file.fileName)) {
        throw new Error(`Demucs model manifest has duplicate file: ${file.fileName}`);
      }
      fileNames.add(file.fileName);
      if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
        throw new Error(`Demucs model ${model.id} file ${file.fileName} has invalid sha256.`);
      }
      if (!Number.isSafeInteger(file.size) || file.size <= 0) {
        throw new Error(`Demucs model ${model.id} file ${file.fileName} has invalid size.`);
      }
    }
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function verifyFile(filePath, file) {
  if (!existsSync(filePath)) {
    return false;
  }
  if (statSync(filePath).size !== file.size) {
    return false;
  }
  return sha256File(filePath) === file.sha256;
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destinationPath, buffer);
}

function cleanPartialTempFiles(cacheRoot, fileName) {
  if (!existsSync(cacheRoot)) {
    return;
  }
  for (const entry of readdirSync(cacheRoot)) {
    if (entry.startsWith(`${fileName}.`) && entry.endsWith(".tmp")) {
      rmSync(path.join(cacheRoot, entry), { force: true });
    }
  }
}

async function downloadAndVerifyFile(url, destinationPath, file) {
  const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  try {
    await downloadFile(url, tempPath);
    if (!verifyFile(tempPath, file)) {
      throw new Error(`Checksum failed for downloaded file ${file.fileName}`);
    }
    renameSync(tempPath, destinationPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export async function prepareDemucsModelRepo({
  cacheRoot = defaultCacheRoot,
  destinationRoot,
  cacheOnly = envFlag("TUNEFORGE_DEMUCS_CACHE_ONLY"),
} = {}) {
  if (!destinationRoot) {
    throw new Error("destinationRoot is required.");
  }

  const manifest = readDemucsModelManifest();
  mkdirSync(cacheRoot, { recursive: true });

  for (const model of manifest.models) {
    for (const file of model.files) {
      const cachedPath = path.join(cacheRoot, file.fileName);
      cleanPartialTempFiles(cacheRoot, file.fileName);
      if (!verifyFile(cachedPath, file)) {
        if (cacheOnly) {
          throw new Error(`Cached Demucs model file missing or invalid: ${cachedPath}`);
        }
        await downloadAndVerifyFile(`${manifest.rootUrl}${file.fileName}`, cachedPath, file);
      }
      if (!verifyFile(cachedPath, file)) {
        throw new Error(`Checksum failed for ${cachedPath}`);
      }
    }
  }

  rmSync(destinationRoot, { recursive: true, force: true });
  mkdirSync(destinationRoot, { recursive: true });

  for (const model of manifest.models) {
    copyFileSync(path.join(demucsRoot, model.yaml), path.join(destinationRoot, model.yaml));
    for (const file of model.files) {
      const cachedPath = path.join(cacheRoot, file.fileName);
      copyFileSync(cachedPath, path.join(destinationRoot, file.fileName));
    }
  }

  writeFileSync(
    path.join(destinationRoot, "manifest.json"),
    JSON.stringify(
      {
        prepared_at: new Date().toISOString(),
        models: Object.fromEntries(
          manifest.models.map((model) => [
            model.id,
            {
              mode: modelMode(model.id),
              yaml: model.yaml,
              files: [
                {
                  name: model.yaml,
                  size_bytes: statSync(path.join(destinationRoot, model.yaml)).size,
                  sha256: sha256File(path.join(destinationRoot, model.yaml)),
                },
                ...model.files.map((file) => ({
                  name: file.fileName,
                  size_bytes: file.size,
                  sha256: file.sha256,
                })),
              ],
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function envFlag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] ?? "").toLowerCase());
}

if (process.argv[1] === __filename) {
  const destinationRoot = readArg("--output") ?? defaultPreparedModelRoot;
  const cacheRoot = readArg("--cache") ?? defaultCacheRoot;
  const cacheOnly = hasFlag("--cache-only") || envFlag("TUNEFORGE_DEMUCS_CACHE_ONLY");
  prepareDemucsModelRepo({ cacheRoot, destinationRoot, cacheOnly })
    .then(() => {
      process.stdout.write(`Prepared Demucs model repo in ${destinationRoot}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
