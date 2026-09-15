import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const beatThisAndroidAsset = {
  family: "beat-this",
  revision: "895b249c4ccabaedc0770b12935c2b7b2f60e145",
  fileName: "beat-this-small0.pte",
  size: 9_820_680,
  sha256: "03b512e135edeb4f4644a7f05fa13ae20ba676484997548f81118fec13d42293",
};
beatThisAndroidAsset.url = `https://huggingface.co/grazzolini/tuneforge-models/resolve/${beatThisAndroidAsset.revision}/beat-this/${beatThisAndroidAsset.fileName}`;
export const cremaAndroidAssets = [
  { family: "crema", revision: "895b249c4ccabaedc0770b12935c2b7b2f60e145",
    fileName: "crema-0.2.0-opset18.onnx", size: 2_193_804,
    sha256: "a903f9709821fccebb31d4e93d7d783642faaa90859f45f308c0f9131cc7ca59" },
  { family: "crema", revision: "895b249c4ccabaedc0770b12935c2b7b2f60e145",
    fileName: "crema-0.2.0-runtime-state.json", size: 3_790,
    sha256: "3744bf9ecb47de7194cb9f250fba26678ea347911af32ec4813645d5e033aca2" },
];
for (const asset of cremaAndroidAssets) {
  asset.url = `https://huggingface.co/grazzolini/tuneforge-models/resolve/${asset.revision}/crema/${asset.fileName}`;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.join(root, "apps/desktop/src-tauri/gen/android/app/src/main/assets/models");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verify(file, spec = beatThisAndroidAsset) {
  return fs.statSync(file, { throwIfNoEntry: false })?.size === spec.size && sha256(file) === spec.sha256;
}

function syncPath(file) {
  const descriptor = fs.openSync(file, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

async function downloadVerifiedAsset(response, temporary, spec, createWriteStreamImpl) {
  if (!response.ok || !response.body) {
    throw new Error(`${spec.family} model download failed: HTTP ${response.status}.`);
  }
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > spec.size) callback(new Error(`${spec.family} model download exceeded expected size.`));
      else callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    limit,
    createWriteStreamImpl(temporary, { flags: "wx", mode: 0o644 }),
  );
}

export async function prepareAndroidModelAssets({
  source = process.env.TUNEFORGE_ANDROID_BEAT_THIS_PTE,
  cremaSources = [process.env.TUNEFORGE_ANDROID_CREMA_ONNX,
    process.env.TUNEFORGE_ANDROID_CREMA_RUNTIME_STATE],
  destinationRoot = assetRoot,
  fetchImpl = fetch,
  specs = [beatThisAndroidAsset, ...cremaAndroidAssets],
  createWriteStreamImpl = fs.createWriteStream,
} = {}) {
  const sources = [source, ...cremaSources];
  const parent = path.dirname(destinationRoot);
  const base = path.basename(destinationRoot);
  const identity = crypto.randomUUID();
  const stagingRoot = path.join(parent, `.${base}.${identity}.staging`);
  const backupRoot = path.join(parent, `.${base}.${identity}.backup`);
  let backedUp = false;
  let published = false;
  fs.mkdirSync(parent, { recursive: true });
  try {
    for (const [index, spec] of specs.entries()) {
      const familyRoot = path.join(stagingRoot, spec.family);
      fs.mkdirSync(familyRoot, { recursive: true });
      const temporary = path.join(familyRoot, spec.fileName);
      if (sources[index]) {
        fs.copyFileSync(path.resolve(sources[index]), temporary, fs.constants.COPYFILE_EXCL);
      } else {
        const response = await fetchImpl(spec.url, { redirect: "follow" });
        await downloadVerifiedAsset(response, temporary, spec, createWriteStreamImpl);
      }
      if (!verify(temporary, spec)) throw new Error(`${spec.family} Android model failed size or SHA-256 verification.`);
      syncPath(temporary);
    }
    const manifest = { version: 1, assets: specs.map((spec) => ({ ...spec,
      relativePath: `models/${spec.family}/${spec.fileName}` })) };
    const manifestPath = path.join(stagingRoot, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    syncPath(manifestPath);
    syncPath(stagingRoot);
    if (fs.existsSync(destinationRoot)) {
      fs.renameSync(destinationRoot, backupRoot);
      backedUp = true;
    }
    fs.renameSync(stagingRoot, destinationRoot);
    published = true;
    fs.rmSync(backupRoot, { recursive: true, force: true });
    backedUp = false;
    return specs.map((spec) => path.join(destinationRoot, spec.family, spec.fileName));
  } catch (error) {
    if (published) fs.rmSync(destinationRoot, { recursive: true, force: true });
    if (backedUp) fs.renameSync(backupRoot, destinationRoot);
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

export function cleanAndroidModelAssets(destinationRoot = assetRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareAndroidModelAssets()
    .then((destinations) => console.log(`[android models] verified ${destinations.length} assets`))
    .catch((error) => { console.error(`[android models] ${error.message}`); process.exitCode = 1; });
}
