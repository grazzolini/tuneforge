import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createFlatpakSourceSnapshot } from "./flatpak-source-snapshots.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const lockPath = path.join(root, "packaging/soxr/sources.lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

function fail(message) { throw new Error(message); }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function run(command, args, { cwd = root, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) fail(`${path.basename(command)} failed${result.stderr ? `: ${result.stderr.trim()}` : "."}`);
  return result.stdout ?? "";
}
function verify(file, size, digest, label) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size !== size || sha256(file) !== digest) fail(`${label} failed size or SHA-256 verification.`);
}
async function ensureArchive(cacheDir) {
  const archive = path.join(cacheDir, lock.source.archiveName);
  if (fs.statSync(archive, { throwIfNoEntry: false })?.isFile()) {
    verify(archive, lock.source.size, lock.source.sha256, "libsoxr source archive");
    return archive;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const temporary = path.join(cacheDir, `.${lock.source.archiveName}.${crypto.randomUUID()}.tmp`);
  try {
    const response = await fetch(lock.source.url, { redirect: "follow" });
    if (!response.ok || !response.body) fail(`libsoxr source download failed with HTTP ${response.status}.`);
    let received = 0;
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > lock.source.size ? new Error("libsoxr source download exceeded its pinned size.") : null, chunk);
    }});
    await pipeline(Readable.fromWeb(response.body), bounded, fs.createWriteStream(temporary, { flags: "wx" }));
    verify(temporary, lock.source.size, lock.source.sha256, "downloaded libsoxr source archive");
    fs.renameSync(temporary, archive);
    return archive;
  } finally { fs.rmSync(temporary, { force: true }); }
}
function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let target;
  let cacheDir = path.join(root, "packaging/soxr/cache");
  let outputDir;
  let jobs = String(Math.max(1, Number(process.env.TUNEFORGE_SOXR_BUILD_JOBS ?? 4)));
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--target") target = args[++index];
    else if (value === "--cache-dir") cacheDir = path.resolve(args[++index]);
    else if (value === "--output-dir") outputDir = path.resolve(args[++index]);
    else if (value === "--jobs") jobs = args[++index];
    else fail(`Unknown option: ${value}`);
  }
  if (!["android-arm64-v8a", "host-test"].includes(target)) fail("--target must be android-arm64-v8a or host-test");
  return { target, cacheDir, outputDir: outputDir ?? path.join(root, "packaging/soxr/generated", target), jobs };
}
function inventory(directory) {
  const visit = (current) => fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(current, entry.name);
    return entry.isDirectory() ? visit(candidate) : [candidate];
  });
  return visit(directory).map((file) => ({
    path: path.relative(directory, file).split(path.sep).join("/"), size: fs.statSync(file).size, sha256: sha256(file),
  })).sort((left, right) => left.path.localeCompare(right.path));
}
function correspondingSources(archive, outputParent, target) {
  const fileName = `TuneForge_${lock.runtimeVersion}_corresponding-sources.tar`;
  const output = path.join(outputParent, fileName);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-soxr-sources-"));
  const payload = path.join(staging, "payload");
  const rebuild = target === "android-arm64-v8a"
    ? "ANDROID_NDK_HOME=/path/to/ndk/29.0.14206865 node scripts/build-soxr.mjs --target android-arm64-v8a"
    : "node scripts/build-soxr.mjs --target host-test";
  try {
    for (const relative of ["packaging/soxr/cache", "packaging/soxr/patches", "packaging/soxr", "scripts"]) {
      fs.mkdirSync(path.join(payload, relative), { recursive: true });
    }
    fs.copyFileSync(archive, path.join(payload, "packaging/soxr/cache", lock.source.archiveName));
    const correspondingSourceFiles = [lock.patch.path, "packaging/soxr/sources.lock.json",
      "scripts/build-soxr.mjs", "scripts/flatpak-source-snapshots.mjs"];
    if (target === "android-arm64-v8a") correspondingSourceFiles.push("THIRD_PARTY_NOTICES.md");
    for (const relative of correspondingSourceFiles) {
      fs.copyFileSync(path.join(root, relative), path.join(payload, relative));
    }
    fs.writeFileSync(path.join(payload, "README-CORRESPONDING-SOURCES.md"), [
      `# TuneForge ${lock.runtimeVersion} corresponding sources`, "",
      "This bundle contains the exact upstream source archive, TuneForge Android SONAME patch, source lock, complete build recipe, and licensing records.",
      "Extract it, then rebuild or replace the dynamically linked library with:", "",
      `    ${rebuild}`, "",
    ].join("\n"));
    createFlatpakSourceSnapshot({ root: staging, outputPath: output,
      inputs: [{ source: "payload", destination: `TuneForge-${lock.runtimeVersion}-sources` }], sourceDateEpoch: "1" });
    return { fileName, size: fs.statSync(output).size, sha256: sha256(output) };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
async function main(argv) {
  const options = parseArgs(argv);
  const archive = await ensureArchive(options.cacheDir);
  const patch = path.join(root, lock.patch.path);
  verify(patch, fs.statSync(patch).size, lock.patch.sha256, "libsoxr Android patch");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-soxr-build-"));
  try {
    run("tar", ["-xf", archive, "-C", work]);
    const source = path.join(work, lock.source.sourceDirectory);
    verify(path.join(source, "LICENCE"), 1024, lock.source.licenseSha256, "libsoxr license notice");
    verify(path.join(source, "COPYING.LGPL"), 26432, lock.source.copyingSha256, "libsoxr LGPL text");
    const install = path.join(work, "install");
    const build = path.join(work, "build");
    const args = ["-S", source, "-B", build, `-DCMAKE_INSTALL_PREFIX=${install}`, "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=ON", "-DBUILD_TESTS=OFF", "-DBUILD_EXAMPLES=OFF", "-DWITH_OPENMP=OFF",
      "-DWITH_LSR_BINDINGS=OFF", "-DWITH_PFFFT=ON", "-DWITH_AVFFT=OFF"];
    const buildEnvironment = {};
    let androidNdkPath;
    if (options.target === "android-arm64-v8a") {
      const ndk = process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT;
      if (!ndk) fail("ANDROID_NDK_HOME is required for android-arm64-v8a");
      androidNdkPath = path.resolve(ndk);
      run("patch", ["-p1", "--forward", "--input", patch], { cwd: source });
      args.push(`-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, "build/cmake/android.toolchain.cmake")}`,
        "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-26",
        "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384");
      buildEnvironment.androidNdkRevision = fs.readFileSync(path.join(ndk, "source.properties"), "utf8")
        .match(/^Pkg\.Revision\s*=\s*(.+)$/m)?.[1]?.trim();
    }
    run("cmake", args);
    run("cmake", ["--build", build, "--parallel", options.jobs]);
    run("cmake", ["--install", build]);
    fs.rmSync(options.outputDir, { recursive: true, force: true });
    fs.mkdirSync(options.outputDir, { recursive: true });
    for (const directory of ["include", "lib"]) fs.cpSync(path.join(install, directory), path.join(options.outputDir, directory), { recursive: true, dereference: true });
    if (options.target === "host-test" && process.platform === "darwin") {
      for (const name of ["libsoxr.0.dylib", "libsoxr.dylib"]) {
        const link = path.join(options.outputDir, "lib", name);
        fs.rmSync(link, { force: true });
        fs.symlinkSync("libsoxr.0.1.2.dylib", link);
      }
    }
    fs.mkdirSync(path.join(options.outputDir, "licenses"), { recursive: true });
    fs.copyFileSync(path.join(source, "LICENCE"), path.join(options.outputDir, "licenses/libsoxr-LICENCE.txt"));
    fs.copyFileSync(path.join(source, "COPYING.LGPL"), path.join(options.outputDir, "licenses/libsoxr-COPYING.LGPL-2.1.txt"));
    if (options.target === "android-arm64-v8a") {
      const library = path.join(options.outputDir, "lib/libsoxr.so");
      if (!fs.statSync(library, { throwIfNoEntry: false })?.isFile()) fail("Android libsoxr.so output is missing.");
    }
    const sourceBundle = correspondingSources(archive, path.dirname(options.outputDir), options.target);
    const provenance = { schemaVersion: 1, runtimeVersion: lock.runtimeVersion, target: options.target,
      source: lock.source, components: lock.components,
      patch: options.target === "android-arm64-v8a" ? lock.patch : null,
      correspondingSources: sourceBundle, cmake: args.map((value) => value
        .replace(work, "${BUILD_ROOT}")
        .replace(androidNdkPath ?? "\0", "${ANDROID_NDK_HOME}")),
      buildEnvironment, files: inventory(options.outputDir) };
    fs.writeFileSync(path.join(options.outputDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
