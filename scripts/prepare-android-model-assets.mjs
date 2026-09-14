import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const beatThisAndroidAsset = {
  family: "beat-this",
  revision: "895b249c4ccabaedc0770b12935c2b7b2f60e145",
  fileName: "beat-this-small0.pte",
  size: 9_820_680,
  sha256: "03b512e135edeb4f4644a7f05fa13ae20ba676484997548f81118fec13d42293",
};
beatThisAndroidAsset.url = `https://huggingface.co/grazzolini/tuneforge-models/resolve/${beatThisAndroidAsset.revision}/beat-this/${beatThisAndroidAsset.fileName}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.join(root, "apps/desktop/src-tauri/gen/android/app/src/main/assets/models");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verify(file, spec = beatThisAndroidAsset) {
  return fs.statSync(file, { throwIfNoEntry: false })?.size === spec.size && sha256(file) === spec.sha256;
}

export async function prepareAndroidModelAssets({
  source = process.env.TUNEFORGE_ANDROID_BEAT_THIS_PTE,
  destinationRoot = assetRoot,
  fetchImpl = fetch,
  spec = beatThisAndroidAsset,
} = {}) {
  const familyRoot = path.join(destinationRoot, spec.family);
  const destination = path.join(familyRoot, spec.fileName);
  fs.mkdirSync(familyRoot, { recursive: true });
  const temporary = path.join(familyRoot, `.${spec.fileName}.${crypto.randomUUID()}.tmp`);
  try {
    if (source) {
      fs.copyFileSync(path.resolve(source), temporary, fs.constants.COPYFILE_EXCL);
    } else {
      const response = await fetchImpl(spec.url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Beat This model download failed: HTTP ${response.status}.`);
      const file = fs.createWriteStream(temporary, { flags: "wx", mode: 0o644 });
      await response.body.pipeTo(new WritableStream({
        write(chunk) {
          if (!file.write(Buffer.from(chunk))) return new Promise((resolve) => file.once("drain", resolve));
        },
        close() { return new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve())); },
        abort() { file.destroy(); },
      }));
    }
    if (!verify(temporary, spec)) throw new Error("Beat This Android model failed size or SHA-256 verification.");
    fs.renameSync(temporary, destination);
    const manifest = { version: 1, assets: [{ ...spec, relativePath: `models/${spec.family}/${spec.fileName}` }] };
    fs.writeFileSync(path.join(destinationRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return destination;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function cleanAndroidModelAssets(destinationRoot = assetRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareAndroidModelAssets()
    .then((destination) => console.log(`[android models] verified ${destination}`))
    .catch((error) => { console.error(`[android models] ${error.message}`); process.exitCode = 1; });
}
