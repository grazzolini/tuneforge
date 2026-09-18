import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
  renameSync,
  createWriteStream,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFlatpakSourceSnapshot } from "./flatpak-source-snapshots.mjs";
import { validateOwnedFfmpeg } from "./validate-packaged-ffmpeg.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const lockPath = path.join(workspaceRoot, "packaging", "ffmpeg", "sources.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

const COMMON_COMPONENTS = [
  "--disable-everything",
  "--disable-autodetect",
  "--disable-debug",
  "--disable-doc",
  "--disable-gpl",
  "--disable-network",
  "--disable-nonfree",
  "--disable-version3",
  "--disable-avdevice",
  "--disable-swscale",
  "--enable-avcodec",
  "--enable-avfilter",
  "--enable-avformat",
  "--enable-avutil",
  "--enable-swresample",
  "--enable-libmp3lame",
  "--enable-protocol=file,pipe",
  "--enable-demuxer=aac,flac,matroska,mov,mp3,ogg,wav",
  "--enable-muxer=adts,flac,ipod,mp3,mp4,ogg,wav",
  "--enable-decoder=aac,aac_fixed,alac,flac,mp3,mp3float,opus,vorbis",
  "--enable-decoder=pcm_alaw,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_mulaw",
  "--enable-decoder=pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le",
  "--enable-decoder=pcm_s8,pcm_u16be,pcm_u16le,pcm_u24be,pcm_u24le,pcm_u32be,pcm_u32le,pcm_u8",
  "--enable-encoder=aac,flac,libmp3lame,pcm_s16le",
  "--enable-parser=aac,flac,mpegaudio,opus,vorbis",
  "--enable-filter=amix,aformat,anull,aresample,asetrate,atempo",
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  return result.stdout ?? "";
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function verifyFile(filePath, expected, label) {
  if (!existsSync(filePath)) fail(`${label} missing: ${filePath}`);
  const actual = sha256(filePath);
  if (actual !== expected) fail(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let target = null;
  let cacheDir = path.join(workspaceRoot, "packaging", "ffmpeg", "cache");
  let outputDir = null;
  let sourceOnly = false;
  let download = false;
  let ensure = false;
  let jobs = String(Math.max(1, Number(process.env.TUNEFORGE_FFMPEG_BUILD_JOBS ?? 4)));
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--target") target = args[++index];
    else if (value === "--cache-dir") cacheDir = path.resolve(args[++index]);
    else if (value === "--output-dir") outputDir = path.resolve(args[++index]);
    else if (value === "--jobs") jobs = args[++index];
    else if (value === "--source-only") sourceOnly = true;
    else if (value === "--download") download = true;
    else if (value === "--ensure") ensure = true;
    else fail(`Unknown option: ${value}`);
  }
  if (!sourceOnly && !Object.hasOwn(lock.targets, target)) {
    fail("--target must be macos-arm64 or android-arm64-v8a");
  }
  if (sourceOnly && (target || outputDir)) fail("--source-only cannot be combined with --target or --output-dir");
  if (download && !sourceOnly) fail("--download is only valid with --source-only");
  if (ensure && sourceOnly) fail("--ensure cannot be combined with --source-only");
  return {
    target,
    cacheDir,
    outputDir: outputDir ?? path.join(
      workspaceRoot,
      "packaging",
      "ffmpeg",
      "generated",
      sourceOnly ? "source-only" : target,
    ),
    jobs,
    sourceOnly,
    download,
    ensure,
  };
}

function archivePath(cacheDir, source) {
  return path.join(cacheDir, new URL(source.url).pathname.split("/").pop());
}

function recipeIdentity() {
  const files = [
    "packaging/ffmpeg/sources.lock.json",
    "scripts/build-ffmpeg.mjs",
    "scripts/validate-packaged-ffmpeg.mjs",
    "scripts/flatpak-source-snapshots.mjs",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    ...(lock.patches ?? []).map((entry) => entry.path),
  ];
  const hash = createHash("sha256");
  for (const relative of files) hash.update(relative).update("\0").update(readFileSync(path.join(workspaceRoot, relative)));
  return hash.digest("hex");
}

export function ffmpegCorrespondingSourcesFileName() {
  return `TuneForge_${lock.runtimeVersion}_${recipeIdentity().slice(0, 16)}_corresponding-sources.tar`;
}

function sourceInputs() {
  const ffmpeg = lock.sources.ffmpeg;
  return [
    { url: ffmpeg.url, sha256: ffmpeg.sha256, name: path.basename(new URL(ffmpeg.url).pathname), label: "FFmpeg source" },
    { url: ffmpeg.signatureUrl, sha256: ffmpeg.signatureSha256,
      name: path.basename(new URL(ffmpeg.signatureUrl).pathname), label: "FFmpeg signature" },
    { url: ffmpeg.signingKeyUrl, sha256: ffmpeg.signingKeySha256,
      name: "ffmpeg-devel.asc", label: "FFmpeg signing key" },
    { url: lock.sources.lame.url, sha256: lock.sources.lame.sha256,
      name: path.basename(new URL(lock.sources.lame.url).pathname), label: "LAME source" },
  ];
}

export async function acquireSourceInputs(cacheDir, { download = false, fetchImpl = fetch } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  for (const input of sourceInputs()) await acquirePinnedFile(cacheDir, input, { download, fetchImpl });
}

export async function acquirePinnedFile(cacheDir, input, { download = false, fetchImpl = fetch } = {}) {
  const destination = path.join(cacheDir, input.name);
  if (existsSync(destination)) {
    verifyFile(destination, input.sha256, input.label);
    return destination;
  }
  if (!download) fail(`${input.label} missing: ${destination}. Run pnpm ffmpeg:sources -- --download.`);
  mkdirSync(cacheDir, { recursive: true });
  const temporary = path.join(cacheDir, `.${input.name}.${randomUUID()}.tmp`);
  try {
    const response = await fetchImpl(input.url, { redirect: "follow" });
    if (!response.ok || !response.body) fail(`${input.label} download failed with HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    verifyFile(temporary, input.sha256, `Downloaded ${input.label}`);
    renameSync(temporary, destination);
    return destination;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function materializeCorrespondingSources(cacheDir, outputParent, recipeDigest) {
  const fileName = ffmpegCorrespondingSourcesFileName();
  const output = path.join(outputParent, fileName);
  mkdirSync(outputParent, { recursive: true });
  const staging = mkdtempSync(path.join(outputParent, ".tuneforge-ffmpeg-sources-"));
  const payload = path.join(staging, "payload");
  try {
    mkdirSync(path.join(payload, "packaging", "ffmpeg", "cache"), { recursive: true });
    mkdirSync(path.join(payload, "packaging", "ffmpeg", "patches"), { recursive: true });
    mkdirSync(path.join(payload, "scripts"), { recursive: true });
    for (const source of Object.values(lock.sources)) {
      copyFileSync(archivePath(cacheDir, source), path.join(
        payload, "packaging", "ffmpeg", "cache", path.basename(archivePath(cacheDir, source)),
      ));
    }
    const ffmpeg = lock.sources.ffmpeg;
    for (const [url, destination] of [
      [ffmpeg.signatureUrl, path.basename(new URL(ffmpeg.signatureUrl).pathname)],
      [ffmpeg.signingKeyUrl, "ffmpeg-devel.asc"],
    ]) {
      copyFileSync(path.join(cacheDir, destination), path.join(payload, "packaging", "ffmpeg", "cache", destination));
      if (!url) fail(`Corresponding-source URL is missing for ${destination}`);
    }
    for (const entry of lock.patches ?? []) {
      copyFileSync(path.join(workspaceRoot, entry.path), path.join(payload, entry.path));
    }
    for (const relative of [
      "packaging/ffmpeg/sources.lock.json",
      "scripts/build-ffmpeg.mjs",
      "scripts/validate-packaged-ffmpeg.mjs",
      "scripts/flatpak-source-snapshots.mjs",
      "THIRD_PARTY_NOTICES.md",
      "package.json",
    ]) {
      copyFileSync(path.join(workspaceRoot, relative), path.join(payload, relative));
    }
    writeFileSync(path.join(payload, "README-CORRESPONDING-SOURCES.md"), [
      `# TuneForge ${lock.runtimeVersion} corresponding sources`,
      "",
      "This bundle contains the complete pinned FFmpeg and LAME upstream archives, FFmpeg's",
      "detached signature and signing key, TuneForge's patch, build/validation recipe, source lock,",
      "and notices. LAME publishes no signature or checksum sidecar; its reviewed SHA-256 pin is",
      "recorded in `packaging/ffmpeg/sources.lock.json`.",
      "",
      "Extract this bundle over a TuneForge source checkout matching the distributed application.",
      "Rebuild either owned target with:",
      "",
      "    node scripts/build-ffmpeg.mjs --target macos-arm64",
      "    ANDROID_NDK_HOME=/path/to/ndk/29.0.14206865 node scripts/build-ffmpeg.mjs --target android-arm64-v8a",
      "",
      "The recipe verifies all pins before extraction and rebuilds dynamically linked LGPL payloads.",
      "Replace `packaging/ffmpeg/generated/<target>`, validate it, then run normal packaging.",
      "",
    ].join("\n"));
    const manifest = {
      schemaVersion: 1,
      runtimeVersion: lock.runtimeVersion,
      files: inventoryFiles(payload),
    };
    writeFileSync(path.join(payload, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const stagedOutput = path.join(staging, fileName);
    createFlatpakSourceSnapshot({
      root: staging,
      outputPath: stagedOutput,
      inputs: [{ source: "payload", destination: `TuneForge-${lock.runtimeVersion}-sources` }],
      sourceDateEpoch: "1",
    });
    const metadata = { fileName, sha256: sha256(stagedOutput), size: statSync(stagedOutput).size };
    renameSync(stagedOutput, output);
    writeFileSync(`${output}.sha256`, `${metadata.sha256}  ${fileName}\n`);
    return metadata;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function toolchainIdentity(tc) {
  const version = (tool) => run(tool, ["--version"], { capture: true }).split(/\r?\n/)[0];
  const identity = { cc: version(tc.cc), ar: path.basename(tc.ar), ranlib: path.basename(tc.ranlib) };
  if (tc.provenanceRoot) {
    identity.androidNdkRevision = readFileSync(path.join(tc.provenanceRoot, "source.properties"), "utf8")
      .match(/^Pkg\.Revision\s*=\s*(.+)$/m)?.[1]?.trim();
  } else {
    identity.sdk = run("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { capture: true }).trim();
  }
  return identity;
}

function buildIdentity(target, recipeDigest, tc) {
  return createHash("sha256").update(JSON.stringify({ target, recipeDigest, toolchain: toolchainIdentity(tc) })).digest("hex");
}

export function reusableOutput(outputDir, target, identity, { validate = validateOwnedFfmpeg } = {}) {
  try {
    validate({ root: outputDir, target });
    const provenance = JSON.parse(readFileSync(path.join(outputDir, "provenance.json"), "utf8"));
    return provenance.buildIdentity === identity;
  } catch {
    return false;
  }
}

function promoteDirectory(staging, destination) {
  const backup = `${destination}.previous-${randomUUID()}`;
  const hadDestination = existsSync(destination);
  try {
    if (hadDestination) renameSync(destination, backup);
    renameSync(staging, destination);
    if (hadDestination) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(destination) && hadDestination && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

function verifyFfmpegSignature(cacheDir) {
  const source = lock.sources.ffmpeg;
  const archive = archivePath(cacheDir, source);
  const signature = path.join(cacheDir, new URL(source.signatureUrl).pathname.split("/").pop());
  const key = path.join(cacheDir, "ffmpeg-devel.asc");
  verifyFile(archive, source.sha256, "FFmpeg source");
  verifyFile(signature, source.signatureSha256, "FFmpeg signature");
  verifyFile(key, source.signingKeySha256, "FFmpeg signing key");
  const keyring = mkdtempSync(path.join(tmpdir(), "tuneforge-ffmpeg-gpg-"));
  chmodSync(keyring, 0o700);
  try {
    run("gpg", ["--homedir", keyring, "--batch", "--import", key]);
    const fingerprint = run(
      "gpg",
      ["--homedir", keyring, "--batch", "--with-colons", "--fingerprint", source.signingFingerprint],
      { capture: true },
    );
    if (!fingerprint.includes(`fpr:::::::::${source.signingFingerprint}:`)) {
      fail("Imported FFmpeg signing key fingerprint did not match the source lock");
    }
    run("gpg", ["--homedir", keyring, "--batch", "--verify", signature, archive]);
  } finally {
    rmSync(keyring, { recursive: true, force: true });
  }
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  run("tar", ["-xf", archive, "-C", destination]);
}

function applyPatches(sourceRoot) {
  for (const entry of lock.patches ?? []) {
    const patchPath = path.join(workspaceRoot, entry.path);
    if (!existsSync(patchPath)) fail(`Pinned FFmpeg patch missing: ${entry.path}`);
    verifyFile(patchPath, entry.sha256, `Pinned patch ${entry.path}`);
    run("patch", ["-p1", "--forward", "--input", patchPath], {
      cwd: path.join(sourceRoot, entry.appliesTo),
    });
  }
}

function toolchain(target) {
  if (target === "macos-arm64") {
    const sdk = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { capture: true }).trim();
    const clang = run("xcrun", ["--sdk", "macosx", "--find", "clang"], { capture: true }).trim();
    return {
      target,
      host: "aarch64-apple-darwin",
      cc: clang,
      ar: run("xcrun", ["--sdk", "macosx", "--find", "ar"], { capture: true }).trim(),
      ranlib: run("xcrun", ["--sdk", "macosx", "--find", "ranlib"], { capture: true }).trim(),
      cflags: `-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk}`,
      ldflags: `-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk}`,
      ffmpegCross: ["--arch=arm64", "--target-os=darwin", "--enable-cross-compile"],
      programs: true,
    };
  }
  const ndk = process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT;
  if (!ndk) fail("ANDROID_NDK_HOME is required for android-arm64-v8a");
  const hostTag = process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
  const bin = path.join(ndk, "toolchains", "llvm", "prebuilt", hostTag, "bin");
  const triple = "aarch64-linux-android26";
  return {
    target,
    host: "aarch64-linux-android",
    cc: path.join(bin, `${triple}-clang`),
    ar: path.join(bin, "llvm-ar"),
    ranlib: path.join(bin, "llvm-ranlib"),
    readelf: path.join(bin, "llvm-readelf"),
    cflags: "-fPIC -D__ANDROID_API__=26",
    ldflags: "-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384",
    ffmpegCross: [
      "--arch=aarch64",
      "--target-os=android",
      "--enable-cross-compile",
      "--disable-symver",
      `--cc=${path.join(bin, `${triple}-clang`)}`,
      `--ar=${path.join(bin, "llvm-ar")}`,
      `--ranlib=${path.join(bin, "llvm-ranlib")}`,
      `--strip=${path.join(bin, "llvm-strip")}`,
    ],
    programs: false,
    provenanceRoot: ndk,
  };
}

function validateWithToolchain(options, tc) {
  const previous = process.env.LLVM_READELF;
  if (!previous && tc.readelf) process.env.LLVM_READELF = tc.readelf;
  try { return validateOwnedFfmpeg(options); } finally {
    if (!previous && tc.readelf) delete process.env.LLVM_READELF;
  }
}

function relocateMacBinaries(installRoot) {
  const libraryRoot = path.join(installRoot, "lib");
  const binaries = [...new Set([
    ...readdirSync(libraryRoot).filter((name) => name.endsWith(".dylib")).map((name) => path.join(libraryRoot, name)),
    ...["ffmpeg", "ffprobe"].map((name) => path.join(installRoot, "bin", name)).filter(existsSync),
  ].map((file) => realpathSync(file)))];
  for (const file of binaries) {
    if (file.endsWith(".dylib")) {
      run("install_name_tool", ["-id", `@rpath/${path.basename(file)}`, file]);
    }
    const dependencies = run("otool", ["-L", file], { capture: true })
      .split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
    for (const dependency of dependencies) {
      if (dependency.startsWith(`${installRoot}/lib/`)) {
        run("install_name_tool", ["-change", dependency, `@rpath/${path.basename(dependency)}`, file]);
      }
    }
    run("install_name_tool", ["-add_rpath", file.endsWith(".dylib") ? "@loader_path" : "@executable_path/../lib", file]);
  }
}

function buildLame(sourceRoot, installRoot, tc, jobs) {
  const args = [
    `--prefix=${installRoot}`,
    `--host=${tc.host}`,
    "--disable-static",
    "--enable-shared",
    "--disable-frontend",
    "--disable-decoder",
  ];
  run("sh", ["configure", ...args], {
    cwd: sourceRoot,
    env: { CC: tc.cc, AR: tc.ar, RANLIB: tc.ranlib, CFLAGS: `${tc.cflags} -O2`, LDFLAGS: tc.ldflags },
  });
  run("make", [`-j${jobs}`], { cwd: sourceRoot });
  run("make", ["install"], { cwd: sourceRoot });
  return args;
}

function buildFfmpeg(sourceRoot, installRoot, tc, jobs) {
  const args = [
    `--prefix=${installRoot}`,
    "--enable-shared",
    "--disable-static",
    ...(tc.programs ? ["--enable-ffmpeg", "--enable-ffprobe"] : ["--disable-programs"]),
    ...COMMON_COMPONENTS,
    ...tc.ffmpegCross,
    `--cc=${tc.cc}`,
    `--ar=${tc.ar}`,
    `--ranlib=${tc.ranlib}`,
    `--extra-cflags=-I${path.join(installRoot, "include")} ${tc.cflags}`,
    `--extra-ldflags=-L${path.join(installRoot, "lib")} ${tc.ldflags}`,
  ];
  run("sh", ["configure", ...args], { cwd: sourceRoot });
  run("make", [`-j${jobs}`], { cwd: sourceRoot });
  run("make", ["install"], { cwd: sourceRoot });
  return args;
}

function inventoryFiles(root) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? visit(full) : [full];
  });
  return visit(root).map((file) => ({
    path: path.relative(root, file).split(path.sep).join("/"),
    sha256: sha256(file),
    size: statSync(file).size,
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function materializeSymlinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      materializeSymlinks(file);
    } else if (entry.isSymbolicLink()) {
      const resolved = realpathSync(file);
      const metadata = statSync(resolved);
      if (!metadata.isFile()) fail(`Owned FFmpeg symlink does not resolve to a file: ${file}`);
      rmSync(file);
      copyFileSync(resolved, file);
      chmodSync(file, metadata.mode & 0o777);
    } else if (!lstatSync(file).isFile()) {
      fail(`Owned FFmpeg output contains an unsupported entry: ${file}`);
    }
  }
}

export async function main(argv) {
  const options = parseArgs(argv);
  await acquireSourceInputs(options.cacheDir, { download: options.sourceOnly ? options.download : true });
  verifyFfmpegSignature(options.cacheDir);
  const lameArchive = archivePath(options.cacheDir, lock.sources.lame);
  verifyFile(lameArchive, lock.sources.lame.sha256, "LAME source");
  const recipeDigest = recipeIdentity();
  if (options.sourceOnly) {
    const correspondingSources = materializeCorrespondingSources(
      options.cacheDir, path.dirname(options.outputDir), recipeDigest,
    );
    process.stdout.write(`${JSON.stringify(correspondingSources)}\n`);
    return;
  }

  const tc = toolchain(options.target);
  const identity = buildIdentity(options.target, recipeDigest, tc);
  if (options.ensure && reusableOutput(options.outputDir, options.target, identity, {
    validate: (validation) => validateWithToolchain(validation, tc),
  })) {
    process.stdout.write(`${JSON.stringify({ target: options.target, reused: true })}\n`);
    return;
  }
  const correspondingSources = materializeCorrespondingSources(
    options.cacheDir, path.dirname(options.outputDir), recipeDigest,
  );
  const work = mkdtempSync(path.join(tmpdir(), "tuneforge-ffmpeg-build-"));
  const installRoot = path.join(work, "install");
  const sourceRoot = path.join(work, "src");
  const outputParent = path.dirname(options.outputDir);
  mkdirSync(outputParent, { recursive: true });
  const stagedOutput = mkdtempSync(path.join(outputParent, `.${path.basename(options.outputDir)}-`));
  try {
    extract(archivePath(options.cacheDir, lock.sources.ffmpeg), sourceRoot);
    extract(lameArchive, sourceRoot);
    applyPatches(sourceRoot);
    const lameConfigure = buildLame(path.join(sourceRoot, lock.sources.lame.sourceDirectory), installRoot, tc, options.jobs);
    const ffmpegConfigure = buildFfmpeg(path.join(sourceRoot, lock.sources.ffmpeg.sourceDirectory), installRoot, tc, options.jobs);
    if (options.target === "macos-arm64") relocateMacBinaries(installRoot);
    const licenseRoot = path.join(installRoot, "licenses");
    mkdirSync(licenseRoot, { recursive: true });
    cpSync(
      path.join(sourceRoot, lock.sources.ffmpeg.sourceDirectory, "COPYING.LGPLv2.1"),
      path.join(licenseRoot, "FFmpeg-COPYING.LGPLv2.1.txt"),
    );
    cpSync(
      path.join(sourceRoot, lock.sources.lame.sourceDirectory, "COPYING"),
      path.join(licenseRoot, "LAME-COPYING.LGPL-2.0.txt"),
    );
    cpSync(
      path.join(sourceRoot, lock.sources.lame.sourceDirectory, "LICENSE"),
      path.join(licenseRoot, "LAME-LICENSE.txt"),
    );
    for (const directory of ["bin", "include", "lib", "licenses", "share"]) {
      const source = path.join(installRoot, directory);
      if (existsSync(source)) {
        cpSync(source, path.join(stagedOutput, directory), {
          recursive: true,
          dereference: true,
        });
      }
    }
    materializeSymlinks(stagedOutput);
    const replacements = [
      [installRoot, "${INSTALL_ROOT}"],
      ...(tc.provenanceRoot ? [[tc.provenanceRoot, "${ANDROID_NDK_HOME}"]] : []),
    ];
    const sanitize = (value) => replacements.reduce(
      (result, [source, replacement]) => result.replaceAll(source, replacement),
      value,
    );
    const provenance = {
      schemaVersion: 1,
      buildIdentity: identity,
      recipeDigest,
      runtimeVersion: lock.runtimeVersion,
      target: options.target,
      sources: lock.sources,
      correspondingSources,
      configure: {
        ffmpeg: ffmpegConfigure.map(sanitize),
        lame: lameConfigure.map(sanitize),
      },
      buildEnvironment: {
        ffmpeg: {
          cc: sanitize(tc.cc), ar: sanitize(tc.ar), ranlib: sanitize(tc.ranlib),
          cflags: sanitize(tc.cflags), ldflags: sanitize(tc.ldflags),
        },
        lame: {
          cc: sanitize(tc.cc), ar: sanitize(tc.ar), ranlib: sanitize(tc.ranlib),
          cflags: sanitize(`${tc.cflags} -O2`), ldflags: sanitize(tc.ldflags),
        },
      },
      files: inventoryFiles(stagedOutput),
    };
    writeFileSync(path.join(stagedOutput, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    validateWithToolchain({ root: stagedOutput, target: options.target }, tc);
    promoteDirectory(stagedOutput, options.outputDir);
    process.stdout.write(`${JSON.stringify({ target: options.target, reused: false })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(stagedOutput, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
