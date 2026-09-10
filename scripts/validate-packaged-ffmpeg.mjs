import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const lock = JSON.parse(readFileSync(path.join(workspaceRoot, "packaging", "ffmpeg", "sources.lock.json"), "utf8"));

function fail(message) {
  throw new Error(message);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  return result.stdout ?? "";
}

function filesUnder(root) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Owned FFmpeg payload must not contain symlinks: ${filePath}`);
    return entry.isDirectory() ? visit(filePath) : [filePath];
  });
  return visit(root);
}

function baseLibraryName(fileName) {
  const match = /^(lib(?:avcodec|avfilter|avformat|avutil|swresample|mp3lame))(?:\.[0-9]+)*\.(?:dylib|so)(?:\.[0-9]+)*$/.exec(fileName);
  return match?.[1] ?? null;
}

export function validateProvenance(root, target, { requireCorrespondingSources = true } = {}) {
  const provenancePath = path.join(root, "provenance.json");
  if (!existsSync(provenancePath)) fail(`Owned FFmpeg provenance missing: ${provenancePath}`);
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  if (provenance.runtimeVersion !== lock.runtimeVersion || provenance.target !== target) {
    fail("Owned FFmpeg provenance version or target does not match the source lock");
  }
  if (requireCorrespondingSources) {
    const source = provenance.correspondingSources;
    if (typeof source?.fileName !== "string" || path.basename(source.fileName) !== source.fileName ||
        typeof source.sha256 !== "string" || typeof source.size !== "number") {
      fail("Owned FFmpeg corresponding-source metadata is missing or invalid");
    }
    const sourcePath = path.join(path.dirname(root), source.fileName);
    if (!existsSync(sourcePath) || statSync(sourcePath).size !== source.size ||
        sha256(sourcePath) !== source.sha256) {
      fail("Owned FFmpeg corresponding-source bundle does not match provenance");
    }
  }
  const configure = provenance.configure?.ffmpeg;
  if (!Array.isArray(configure)) fail("Owned FFmpeg configure arguments missing");
  for (const required of [...lock.policy.licenseFlagsRequired, ...lock.policy.networkFlagsRequired]) {
    if (!configure.includes(required)) fail(`Owned FFmpeg configure is missing ${required}`);
  }
  for (const forbidden of ["--enable-gpl", "--enable-nonfree", "--enable-version3", "--enable-network"]) {
    if (configure.includes(forbidden)) fail(`Owned FFmpeg configure contains forbidden flag ${forbidden}`);
  }
  const recorded = new Set();
  for (const entry of provenance.files ?? []) {
    if (typeof entry.path !== "string" || recorded.has(entry.path)) {
      fail(`Owned FFmpeg provenance has an invalid or duplicate path: ${entry.path}`);
    }
    recorded.add(entry.path);
    const filePath = path.resolve(root, entry.path);
    if (!filePath.startsWith(`${realpathSync(root)}${path.sep}`)) fail(`Provenance path escapes payload: ${entry.path}`);
    if (!existsSync(filePath) || statSync(filePath).size !== entry.size || sha256(filePath) !== entry.sha256) {
      fail(`Owned FFmpeg file does not match provenance: ${entry.path}`);
    }
  }
  const actual = filesUnder(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((file) => file !== "provenance.json");
  for (const file of actual) if (!recorded.has(file)) fail(`Owned FFmpeg file is absent from provenance: ${file}`);
  for (const file of recorded) if (!actual.includes(file)) fail(`Owned FFmpeg provenance records an absent file: ${file}`);
  return provenance;
}

function validateLibrarySet(root, target) {
  const libraryRoot = path.join(root, "lib");
  if (!existsSync(libraryRoot)) fail(`Owned FFmpeg library directory missing: ${libraryRoot}`);
  const actual = new Set(
    filesUnder(libraryRoot)
      .map((file) => baseLibraryName(path.basename(file)))
      .filter(Boolean),
  );
  const expected = new Set(lock.targets[target].libraries);
  for (const name of expected) if (!actual.has(name)) fail(`Owned FFmpeg library missing: ${name}`);
  for (const name of actual) if (!expected.has(name)) fail(`Unexpected owned FFmpeg library: ${name}`);
  for (const forbidden of lock.policy.forbiddenLibraries) {
    if (filesUnder(libraryRoot).some((file) => path.basename(file).startsWith(forbidden))) {
      fail(`Forbidden owned FFmpeg library: ${forbidden}`);
    }
  }
  return filesUnder(libraryRoot).filter((file) => baseLibraryName(path.basename(file)));
}

function validateMac(root, libraries) {
  const programs = lock.targets["macos-arm64"].programs.map((name) => path.join(root, "bin", name));
  for (const executable of programs) {
    if (!existsSync(executable)) fail(`Owned FFmpeg executable missing: ${executable}`);
  }
  const ownedNames = new Set(libraries.map((file) => path.basename(file)));
  for (const file of [...libraries, ...programs]) {
    const info = run("file", [file]);
    if (!info.includes("arm64")) fail(`Owned macOS FFmpeg file is not arm64: ${file}`);
    const linkage = run("otool", ["-L", file]);
    if (/\/(?:opt\/homebrew|usr\/local|opt\/local)\//.test(linkage)) {
      fail(`Owned macOS FFmpeg links to Homebrew or MacPorts: ${file}`);
    }
    const invalid = linkage.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean)
      .find((dependency) => dependency.startsWith("/") && !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/"));
    if (invalid) fail(`Owned macOS FFmpeg has external absolute dependency ${invalid}`);
    const missingOwned = linkage.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean)
      .find((dependency) => dependency.startsWith("@rpath/") && !ownedNames.has(path.basename(dependency)));
    if (missingOwned) fail(`Owned macOS FFmpeg dependency is outside the payload: ${missingOwned}`);
  }
}

function validateAndroid(libraries) {
  const ownedNames = new Set(libraries.map((file) => path.basename(file)));
  const systemNames = new Set(["libc.so", "libdl.so", "libm.so"]);
  for (const file of libraries) {
    if (!path.basename(file).endsWith(".so")) continue;
    const header = run(process.env.LLVM_READELF || "llvm-readelf", ["-h", "-l", "-d", file]);
    if (!/Machine:\s+AArch64/.test(header)) fail(`Owned Android FFmpeg file is not AArch64: ${file}`);
    const loads = [...header.matchAll(/LOAD\s+[^\n]*\s0x([0-9a-f]+)\s*$/gim)];
    if (!loads.length || loads.some((match) => Number.parseInt(match[1], 16) < 0x4000)) {
      fail(`Owned Android FFmpeg file lacks 16 KB LOAD alignment: ${file}`);
    }
    if (/NEEDED[^\n]*(?:libavdevice|libpostproc|libswscale|libGPL)/i.test(header)) {
      fail(`Owned Android FFmpeg has forbidden DT_NEEDED dependency: ${file}`);
    }
    for (const match of header.matchAll(/Shared library: \[([^\]]+)\]/g)) {
      if (!ownedNames.has(match[1]) && !systemNames.has(match[1])) {
        fail(`Owned Android FFmpeg dependency is outside audited closure: ${match[1]}`);
      }
    }
  }
}

export function validateOwnedFfmpeg({ root, target, requireCorrespondingSources = true }) {
  if (!Object.hasOwn(lock.targets, target)) fail(`Unknown FFmpeg target: ${target}`);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail(`Owned FFmpeg payload missing: ${root}`);
  validateProvenance(root, target, { requireCorrespondingSources });
  const libraries = validateLibrarySet(root, target);
  for (const license of ["FFmpeg-COPYING.LGPLv2.1.txt", "LAME-COPYING.LGPL-2.0.txt", "LAME-LICENSE.txt"]) {
    if (!existsSync(path.join(root, "licenses", license))) fail(`Owned FFmpeg license missing: ${license}`);
  }
  if (target === "macos-arm64") validateMac(root, libraries);
  else validateAndroid(libraries);
  return { target, files: filesUnder(root).length, bytes: filesUnder(root).reduce((sum, file) => sum + statSync(file).size, 0) };
}

function main(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const targetIndex = args.indexOf("--target");
  const rootIndex = args.indexOf("--root");
  if (targetIndex < 0 || rootIndex < 0) fail("Usage: validate-packaged-ffmpeg --target <target> --root <payload>");
  const result = validateOwnedFfmpeg({ target: args[targetIndex + 1], root: path.resolve(args[rootIndex + 1]) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
