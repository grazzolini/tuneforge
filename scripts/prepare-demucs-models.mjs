import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(workspaceRoot, "packaging", "demucs", "models.json");
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

export function readDemucsModelManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.version !== 2) {
    throw new Error("Demucs model manifest must use version 2.");
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error("Demucs model manifest must define at least one model.");
  }
  const modelIds = new Set();
  for (const model of manifest.models) {
    validateModel(model, modelIds);
  }
}

function validateModel(model, modelIds) {
  if (!model || typeof model !== "object" || !safePathComponent(model.id)) {
    throw new Error("Demucs model manifest model id must be a non-empty string.");
  }
  if (modelIds.has(model.id)) {
    throw new Error(`Demucs model manifest has duplicate model id: ${model.id}`);
  }
  modelIds.add(model.id);
  if (typeof model.mode !== "string" || !model.mode) {
    throw new Error(`Demucs model manifest has invalid mode for ${model.id}.`);
  }
  if (typeof model.repo_id !== "string" || model.repo_id.split("/").length !== 2) {
    throw new Error(`Demucs model manifest has invalid repo_id for ${model.id}.`);
  }
  if (typeof model.revision !== "string" || !/^[a-f0-9]{40}$/.test(model.revision)) {
    throw new Error(`Demucs model manifest has invalid revision for ${model.id}.`);
  }
  if (!safeFileName(model.yaml_file)) {
    throw new Error(`Demucs model manifest has invalid yaml_file for ${model.id}.`);
  }
  if (
    !Array.isArray(model.bag_order) || model.bag_order.length === 0 ||
    new Set(model.bag_order).size !== model.bag_order.length ||
    model.bag_order.some((signature) => !safeFileName(signature))
  ) {
    throw new Error(`Demucs model manifest has invalid bag_order for ${model.id}.`);
  }
  if (!Array.isArray(model.files) || model.files.length === 0) {
    throw new Error(`Demucs model ${model.id} must define files.`);
  }
  const expectedNames = new Set([
    model.yaml_file,
    ...model.bag_order.map((signature) => `${signature}.safetensors`),
  ]);
  const fileNames = new Set();
  for (const file of model.files) {
    if (!file || typeof file !== "object" || typeof file.label !== "string" || !file.label) {
      throw new Error(`Demucs model ${model.id} has invalid file label.`);
    }
    if (!safeFileName(file.file_name) || fileNames.has(file.file_name)) {
      throw new Error(`Demucs model ${model.id} has duplicate or invalid file_name.`);
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`Demucs model ${model.id} file ${file.file_name} has invalid size.`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Demucs model ${model.id} file ${file.file_name} has invalid sha256.`);
    }
    fileNames.add(file.file_name);
  }
  if (fileNames.size !== expectedNames.size || [...fileNames].some((name) => !expectedNames.has(name))) {
    throw new Error(`Demucs model ${model.id} has an invalid file set.`);
  }
}

function safeFileName(value) {
  return typeof value === "string" && value.length > 0 && path.basename(value) === value &&
    !value.includes("/") && !value.includes("\\");
}

function safePathComponent(value) {
  return safeFileName(value) && value !== "." && value !== "..";
}
