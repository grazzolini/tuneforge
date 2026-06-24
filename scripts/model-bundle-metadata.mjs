import path from "node:path";
import { readDemucsModelManifest } from "./prepare-demucs-models.mjs";

export const DEFAULT_LYRICS_MODEL = "turbo";

export const WHISPER_MODEL_CACHE_SPECS = {
  "tiny.en": {
    fileName: "tiny.en.pt",
    sha256: "d3dd57d32accea0b295c96e26691aa14d8822fac7d9d27d5dc00b4ca2826dd03",
    size: 75_571_315,
  },
  tiny: {
    fileName: "tiny.pt",
    sha256: "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9",
    size: 75_572_083,
  },
  "base.en": {
    fileName: "base.en.pt",
    sha256: "25a8566e1d0c1e2231d1c762132cd20e0f96a85d16145c3a00adf5d1ac670ead",
    size: 145_261_783,
  },
  base: {
    fileName: "base.pt",
    sha256: "ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e",
    size: 145_262_807,
  },
  "small.en": {
    fileName: "small.en.pt",
    sha256: "f953ad0fd29cacd07d5a9eda5624af0f6bcf2258be67c92b79389873d91e0872",
    size: 483_615_683,
  },
  small: {
    fileName: "small.pt",
    sha256: "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794",
    size: 483_617_219,
  },
  "medium.en": {
    fileName: "medium.en.pt",
    sha256: "d7440d1dc186f76616474e0ff0b3b6b879abc9d1a4926b7adfa41db2d497ab4f",
    size: 1_528_006_491,
  },
  medium: {
    fileName: "medium.pt",
    sha256: "345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1",
    size: 1_528_008_539,
  },
  "large-v1": {
    fileName: "large-v1.pt",
    sha256: "e4b87e7e0bf463eb8e6956e646f1e277e901512310def2c24bf0e11bd3c28e9a",
    size: 3_086_999_982,
  },
  "large-v2": {
    fileName: "large-v2.pt",
    sha256: "81f7c96c852ee8fc832187b0132e569d6c3065a3252ed18e56effd0b6a73e524",
    size: 3_086_999_982,
  },
  "large-v3": {
    fileName: "large-v3.pt",
    sha256: "e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb",
    size: 3_087_371_615,
  },
  large: {
    fileName: "large-v3.pt",
    sha256: "e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb",
    size: 3_087_371_615,
  },
  "large-v3-turbo": {
    fileName: "large-v3-turbo.pt",
    sha256: "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a",
    size: 1_617_941_637,
  },
  turbo: {
    fileName: "large-v3-turbo.pt",
    sha256: "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a",
    size: 1_617_941_637,
  },
};

export const BEAT_THIS_CHECKPOINT_SPEC = {
  checkpoint: "small0",
  fileName: "beat_this-small0.ckpt",
  sha256: "6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b",
  size: 8_451_101,
  url: "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/small0.ckpt",
};

const CUDA_MODEL_FALLBACKS = {
  turbo: ["small", "base"],
  "large-v3-turbo": ["small", "base"],
  large: ["small", "base"],
  "large-v3": ["small", "base"],
  "large-v2": ["small", "base"],
  "large-v1": ["small", "base"],
  medium: ["small", "base"],
  small: ["base"],
};

export function resolveWhisperBundleModels(modelName = DEFAULT_LYRICS_MODEL) {
  const normalizedModel = String(modelName || DEFAULT_LYRICS_MODEL).trim() || DEFAULT_LYRICS_MODEL;
  const candidates = [normalizedModel, ...(CUDA_MODEL_FALLBACKS[normalizedModel] ?? [])];
  return Array.from(new Set(candidates));
}

export function buildModelBundlePlan({
  includeBeatThis = false,
  lyricsModel = process.env.TUNEFORGE_LYRICS_MODEL ?? DEFAULT_LYRICS_MODEL,
  demucsManifest = readDemucsModelManifest(),
} = {}) {
  const entriesByPath = new Map();
  const torchCheckpoints = [];
  const whisperModels = [];

  for (const model of demucsManifest.models) {
    for (const file of model.files) {
      const relativePath = `torch/hub/checkpoints/${file.fileName}`;
      const entry = addEntry(entriesByPath, {
        label: `Demucs ${model.id} ${file.fileName}`,
        url: `${demucsManifest.rootUrl}${file.fileName}`,
        relativePath,
        fileName: file.fileName,
        size: file.size,
        sha256: file.sha256,
      });
      torchCheckpoints.push(entry);
    }
  }

  for (const modelName of resolveWhisperBundleModels(lyricsModel)) {
    const spec = WHISPER_MODEL_CACHE_SPECS[modelName];
    if (!spec) {
      throw new Error(`Unsupported Whisper model for package bundle: ${modelName}`);
    }
    const relativePath = `whisper/${spec.fileName}`;
    const entry = addEntry(entriesByPath, {
      label: `Whisper ${modelName}`,
      url: `https://openaipublic.azureedge.net/main/whisper/models/${spec.sha256}/${spec.fileName}`,
      relativePath,
      fileName: spec.fileName,
      size: spec.size,
      sha256: spec.sha256,
      model: modelName,
    });
    whisperModels.push(entry);
  }

  if (includeBeatThis) {
    const relativePath = `torch/hub/checkpoints/${BEAT_THIS_CHECKPOINT_SPEC.fileName}`;
    const entry = addEntry(entriesByPath, {
      label: `beat-this ${BEAT_THIS_CHECKPOINT_SPEC.checkpoint}`,
      url: BEAT_THIS_CHECKPOINT_SPEC.url,
      relativePath,
      fileName: BEAT_THIS_CHECKPOINT_SPEC.fileName,
      size: BEAT_THIS_CHECKPOINT_SPEC.size,
      sha256: BEAT_THIS_CHECKPOINT_SPEC.sha256,
      checkpoint: BEAT_THIS_CHECKPOINT_SPEC.checkpoint,
    });
    torchCheckpoints.push(entry);
  }

  const sources = Array.from(entriesByPath.values()).map((entry) => ({
    type: "file",
    url: entry.url,
    sha256: entry.sha256,
    dest: path.posix.join("model-bundle", path.posix.dirname(entry.relativePath)),
    "dest-filename": entry.fileName,
  }));

  return {
    sources,
    manifest: {
      version: 1,
      torch_checkpoints: torchCheckpoints.map(manifestEntry),
      whisper_models: whisperModels.map((entry) => ({
        ...manifestEntry(entry),
        model: entry.model,
      })),
    },
  };
}

function addEntry(entriesByPath, entry) {
  if (!entriesByPath.has(entry.relativePath)) {
    entriesByPath.set(entry.relativePath, entry);
  }
  return entriesByPath.get(entry.relativePath);
}

function manifestEntry(entry) {
  return {
    label: entry.label,
    file_name: entry.fileName,
    relative_path: entry.relativePath,
    size: entry.size,
    sha256: entry.sha256,
  };
}
