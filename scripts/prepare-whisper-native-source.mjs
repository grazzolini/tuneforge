import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const whisperRsSysSource = {
  name: "whisper-rs-sys",
  version: "0.15.0",
  size: 1_757_612,
  sha256: "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f",
  url: "https://static.crates.io/crates/whisper-rs-sys/whisper-rs-sys-0.15.0.crate",
};
export const vulkanHeadersSource = {
  version: "1.4.357.0",
  sha256: "e87dce08116151f6b6d7de6b6faf41498e87e6cf848ff16fa3bd5402190ad4a3",
  url: "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/vulkan-sdk-1.4.357.0.tar.gz",
};
export const whisperVulkanShaderTool = {
  ndkRevision: "29.0.14206865",
  tool: "shader-tools/<host>/glslc",
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const patchFile = path.join(scriptDir, "patches/whisper-rs-sys-0.15.0-tuneforge.patch");
const dtwHelperFile = path.join(
  repoRoot,
  "apps/desktop/src-tauri/native/whisper-rs-sys/tuneforge_dtw.h",
);
const textHelperFile = path.join(
  repoRoot,
  "apps/desktop/src-tauri/native/whisper-rs-sys/tuneforge_text.h",
);
const defaultDestination = path.join(
  repoRoot,
  "apps/desktop/src-tauri/target/native-sources",
);

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verified(file, spec = whisperRsSysSource) {
  return fs.statSync(file, { throwIfNoEntry: false })?.size === spec.size &&
    digest(file) === spec.sha256;
}

function cachedArchive(spec = whisperRsSysSource, cargoHome = process.env.CARGO_HOME) {
  const root = cargoHome ? path.resolve(cargoHome) : path.join(os.homedir(), ".cargo");
  const cache = path.join(root, "registry/cache");
  if (!fs.statSync(cache, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  for (const registry of fs.readdirSync(cache)) {
    const candidate = path.join(cache, registry, `${spec.name}-${spec.version}.crate`);
    if (verified(candidate, spec)) return candidate;
  }
  return undefined;
}

async function downloadArchive(destination, spec, fetchImpl) {
  const response = await fetchImpl(spec.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`whisper-rs-sys source download failed: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o644 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || result.error?.message).trim()}`);
  }
}

export async function prepareWhisperNativeSource({
  destinationRoot = defaultDestination,
  spec = whisperRsSysSource,
  fetchImpl = fetch,
  archive = cachedArchive(spec),
  vulkanSpec = vulkanHeadersSource,
  vulkanArchive,
} = {}) {
  const patchSha256 = digest(patchFile);
  const dtwHelperSha256 = digest(dtwHelperFile);
  const textHelperSha256 = digest(textHelperFile);
  const identityHash = crypto.createHash("sha256")
    .update(`${patchSha256}:${dtwHelperSha256}:${textHelperSha256}:${vulkanSpec.sha256}:${whisperVulkanShaderTool.ndkRevision}`)
    .digest("hex").slice(0, 12);
  const identity = `${spec.name}-${spec.version}-${identityHash}`;
  const destination = path.join(destinationRoot, identity);
  const marker = path.join(destination, ".tuneforge-source.json");
  try {
    const state = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (state.archiveSha256 === spec.sha256 && state.patchSha256 === patchSha256 &&
        state.dtwHelperSha256 === dtwHelperSha256 &&
        state.textHelperSha256 === textHelperSha256 &&
        state.vulkanHeadersSha256 === vulkanSpec.sha256 &&
        state.vulkanShaderNdkRevision === whisperVulkanShaderTool.ndkRevision) return destination;
  } catch {}

  fs.mkdirSync(destinationRoot, { recursive: true });
  const staging = path.join(destinationRoot, `.${identity}.${crypto.randomUUID()}.staging`);
  const archivePath = path.join(staging, `${spec.name}-${spec.version}.crate`);
  const vulkanArchivePath = path.join(staging, `Vulkan-Headers-${vulkanSpec.version}.tar.gz`);
  const extracted = path.join(staging, "extracted");
  try {
    fs.mkdirSync(extracted, { recursive: true });
    if (archive) fs.copyFileSync(archive, archivePath, fs.constants.COPYFILE_EXCL);
    else await downloadArchive(archivePath, spec, fetchImpl);
    if (!verified(archivePath, spec)) throw new Error("whisper-rs-sys source failed size or SHA-256 verification.");
    run("tar", ["-xzf", archivePath, "-C", extracted]);
    const source = path.join(extracted, `${spec.name}-${spec.version}`);
    fs.copyFileSync(
      dtwHelperFile,
      path.join(source, "whisper.cpp/src/tuneforge_dtw.h"),
      fs.constants.COPYFILE_EXCL,
    );
    fs.copyFileSync(
      textHelperFile,
      path.join(source, "whisper.cpp/src/tuneforge_text.h"),
      fs.constants.COPYFILE_EXCL,
    );
    if (vulkanArchive) fs.copyFileSync(vulkanArchive, vulkanArchivePath, fs.constants.COPYFILE_EXCL);
    else await downloadArchive(vulkanArchivePath, vulkanSpec, fetchImpl);
    if (digest(vulkanArchivePath) !== vulkanSpec.sha256) {
      throw new Error("Vulkan-Headers source failed SHA-256 verification.");
    }
    run("tar", ["-xzf", vulkanArchivePath, "-C", extracted]);
    const vulkanSource = path.join(extracted, `Vulkan-Headers-vulkan-sdk-${vulkanSpec.version}`);
    fs.renameSync(vulkanSource, path.join(source, "vulkan-headers"));
    run("patch", ["--batch", "--forward", "-p1", "-i", patchFile], { cwd: source });
    fs.writeFileSync(path.join(source, ".tuneforge-vulkan-ndk-revision"),
      `${whisperVulkanShaderTool.ndkRevision}\n`, { flag: "wx" });
    fs.writeFileSync(path.join(source, ".tuneforge-source.json"), `${JSON.stringify({
      archiveSha256: spec.sha256,
      patchSha256,
      dtwHelperSha256,
      textHelperSha256,
      vulkanHeadersSha256: vulkanSpec.sha256,
      vulkanShaderNdkRevision: whisperVulkanShaderTool.ndkRevision,
      vulkanShaderTool: whisperVulkanShaderTool.tool,
    }, null, 2)}\n`, { flag: "wx" });
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    }
    return destination;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareWhisperNativeSource()
    .then((destination) => process.stdout.write(`${destination}\n`))
    .catch((error) => { console.error(`[whisper native source] ${error.message}`); process.exitCode = 1; });
}
