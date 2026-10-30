import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "../..");
const build = join(root, "build");
const lock = JSON.parse(await fs.readFile(join(root, "toolchains.lock.json"), "utf8"));
const sources = JSON.parse(await fs.readFile(join(root, "sources.lock.json"), "utf8"));
const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`;
const args = process.argv.slice(2).filter(arg => arg !== "--");
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const check = args.includes("--check");
let buildFingerprint;
const preparedSourceIdentity = createHash("sha256").update(JSON.stringify({ archive: sources.archive,
  files: sources.files.map(file => ({ path: file.path, sha256: file.sha256 })), patches: sources.patches })).digest("hex");

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function run(program, commandArgs, options = {}) {
  const result = spawnSync(program, commandArgs, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.error})`);
}
function output(program, commandArgs, options = {}) {
  const result = spawnSync(program, commandArgs, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
async function sourceFingerprint() {
  const files = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (["build", "node_modules", ".venv", "__pycache__", "target", "vendor", "cache"].includes(entry.name) || (entry.name.endsWith(".pyc") || entry.name === "PKG-INFO")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("Source snapshot contains a symbolic link");
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const path of files) hash.update(relative(root, path).split("\\").join("/") + "\0" + await digest(path) + "\n");
  return hash.digest("hex");
}
export async function toolArtifact(name, target = platform) {
  const tool = lock.tools[name];
  const artifact = tool?.artifacts[target] ?? tool?.artifacts.any;
  if (!artifact) throw new Error(`No pinned ${name} artifact for ${target}`);
  const directory = join(build, "cache", name, tool.version);
  const path = join(directory, artifact.filename);
  await fs.mkdir(directory, { recursive: true });
  if (await fs.stat(path).catch(() => null)) {
    if (await digest(path) === artifact.sha256) return path;
    throw new Error(`Cached ${name} checksum differs from its pin`);
  }
  if (args.includes("--offline")) throw new Error(`Pinned ${name} artifact is unavailable offline; acquire its build-tool cache before retrying`);
  const response = await fetch(artifact.url);
  if (!response.ok || !response.body) throw new Error(`${name} download failed: ${response.status}`);
  const temporary = path + ".partial";
  console.error(`Downloading pinned ${name} ${tool.version}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  if (await digest(temporary) !== artifact.sha256) throw new Error(`${name} archive checksum differs from its pin`);
  if (artifact.bytes !== undefined && (await fs.stat(temporary)).size !== artifact.bytes) throw new Error(`${name} archive size differs from its pin`);
  await fs.rename(temporary, path);
  return path;
}
async function pythonTools(version = "3.14") {
  if (!["3.14", "3.11"].includes(version)) throw new Error("Python must be explicitly 3.14 or 3.11");
  const interpreter = output("uv", ["python", "find", version]);
  const actual = output(interpreter, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]);
  if (actual !== version) throw new Error(`Expected Python ${version}, got ${actual}`);
  const environment = join(build, "envs", `tools-cp${version.replace(".", "")}`);
  const python = join(environment, "bin", "python");
  const marker = join(environment, "toolchain.sha256");
  const expected = await digest(join(root, "toolchains.lock.json"));
  if (await fs.readFile(marker, "utf8").catch(() => "") !== expected) {
    if (!await fs.stat(python).catch(() => null)) run("uv", ["venv", "--python", interpreter, environment]);
    const wheels = [];
    for (const name of lock.pythonBuildDependencies) wheels.push(await toolArtifact(name));
    run("uv", ["pip", "install", "--python", python, "--no-index", "--no-deps", ...wheels]);
    await fs.writeFile(marker, expected);
  }
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", CMAKE_GENERATOR: "Unix Makefiles", PATH: `${join(environment, "bin")}:${process.env.PATH ?? ""}` };
  if (process.platform === "darwin") env.MACOSX_DEPLOYMENT_TARGET = "13.0";
  if (process.platform === "darwin") env.CMAKE_ARGS = "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0";
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return { python, cmake: join(environment, "bin", "cmake"), env, version: actual };
}
async function artifactDirectory(target, pythonVersion) {
  return join(build, "artifacts", target, ...(target === "python" ? [`cp${pythonVersion.replace(".", "")}`] : target === "native" ? [platform] : []));
}
export function verifyManifestMetadata(manifest, target, pythonVersion = "3.14") {
  if (manifest.manifestVersion !== 1 || manifest.packageVersion !== pkg.version || manifest.target !== target ||
      ["apiVersion", "abiVersion", "schemaVersion", "corpusVersion"].some(key => manifest[key] !== 1)) throw new Error("Core artifact contract/version mismatch");
  if (manifest.gingoArchiveSha256 !== sources.archive.sha256 || manifest.preparedSourceIdentity !== preparedSourceIdentity || manifest.gingoRevision !== sources.revision || manifest.cmakeVersion !== lock.tools.cmake.version) throw new Error("Core artifact source/toolchain identity mismatch");
  if (target === "wasm") {
    const tool = lock.tools.emscripten;
    const archive = tool.artifacts[manifest.platform];
    if (!archive || manifest.emscriptenVersion !== tool.version || manifest.emscriptenArchiveSha256 !== archive.sha256 ||
        manifest.emscriptenCompilerVersion !== tool.compilerVersion || manifest.emscriptenCompilerRevision !== tool.compilerRevision ||
        manifest.emscriptenReleaseRevision !== tool.releaseRevision) throw new Error("WASM toolchain identity mismatch");
  } else if (target !== "sdist" && manifest.platform !== platform) throw new Error("Core artifact platform mismatch");
  if (target === "python") {
    if (!["3.14", "3.11"].includes(pythonVersion)) throw new Error("Unsupported Python ABI");
    const abi = `cp${pythonVersion.replace(".", "")}`;
    const suffix = process.platform === "darwin" ? `.cpython-${abi.slice(2)}-darwin.so` : `.cpython-${abi.slice(2)}-${process.arch === "x64" ? "x86_64" : "aarch64"}-linux-gnu.so`;
    const tag = process.platform === "darwin" ? "macosx_13_0_arm64" : `linux_${process.arch === "x64" ? "x86_64" : "aarch64"}`;
    if (!manifest.pythonVersion?.startsWith(pythonVersion + ".") || manifest.extensionSuffix !== suffix ||
        manifest.pybind11Version !== lock.tools.pybind11.version || manifest.pythonAbi !== abi ||
        manifest.wheelPlatform !== tag || manifest.files?.[0]?.path !== `tuneforge_music_core-${pkg.version}-${abi}-${abi}-${tag}.whl`) throw new Error("Python interpreter/ABI/platform identity mismatch");
  }
}
async function verify(directory, target, pythonVersion = "3.14") {
  const manifest = JSON.parse(await fs.readFile(join(directory, "manifest.json"), "utf8"));
  if (await digest(join(root, "licenses/Gingo-LICENSE")) !== sources.files.find(file => file.path === "LICENSE").sha256)
    throw new Error("Distributed Gingo license differs from source lock");
  verifyManifestMetadata(manifest, target, pythonVersion);
  if (manifest.sourceFingerprint !== await sourceFingerprint()) throw new Error("Core artifact is stale; rebuild from current sources");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Artifact manifest has no payloads");
  const names = manifest.files.map(file => file.path).sort();
  if (target === "wasm" && JSON.stringify(names) !== JSON.stringify(["music-core.mjs","music-core.wasm"])) throw new Error("WASM payload matrix differs");
  if (target === "native" && JSON.stringify(names) !== JSON.stringify(["libmusic_core_policy.a","libtuneforge_music_core.a","libtuneforge_music_policies.a"])) throw new Error("Native payload matrix differs");
  if (target === "sdist" && (names.length !== 1 || names[0] !== `tuneforge_music_core-${pkg.version}.tar.gz`)) throw new Error("Standalone source payload matrix differs");
  if (target === "python" && (names.length !== 1 || !names[0].startsWith("tuneforge_music_core-"+pkg.version+"-") || !names[0].endsWith(".whl"))) throw new Error("Python wheel payload matrix differs");
  for (const file of manifest.files) {
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error("Artifact path escapes its directory");
    const path = join(directory, file.path);
    if ((await fs.stat(path)).size !== file.bytes || await digest(path) !== file.sha256) throw new Error(`Core artifact checksum mismatch: ${file.path}`);
  }
  return manifest;
}
async function publishManifest(directory, target, paths, details = {}) {
  if (buildFingerprint !== await sourceFingerprint()) throw new Error("Core sources changed during the build; discard/rebuild this artifact");
  const files = [];
  for (const path of paths) files.push({ path, sha256: await digest(join(directory, path)), bytes: (await fs.stat(join(directory, path))).size });
  const manifest = {
    manifestVersion: 1, packageVersion: pkg.version, apiVersion: 1, abiVersion: 1, schemaVersion: 1, corpusVersion: 1,
    target, platform, sourceFingerprint: await sourceFingerprint(),
    gingoRevision: sources.revision, gingoArchiveSha256: sources.archive.sha256, preparedSourceIdentity, files,
    licenses: [{ name: "TuneForge", license: "MIT", path: "LICENSE" }, { name: "Gingo", license: "MIT", path: "licenses/Gingo-LICENSE" }, { name: "Unicode", license: "Unicode-3.0", path: "licenses/Unicode-LICENSE" }, ...(target === "python" ? [{ name: "pybind11", license: "BSD-3-Clause", path: "licenses/pybind11-LICENSE" }] : [])],
    ...details,
  };
  await fs.writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return verify(directory, target, details.pythonVersion?.split(".").slice(0, 2).join("."));
}
async function configure(tools, directory, extra = [], env = tools.env) {
  await fs.mkdir(directory, { recursive: true });
  run(tools.cmake, ["-S", root, "-B", directory, "-DCMAKE_BUILD_TYPE=Release", `-DPython_EXECUTABLE=${tools.python}`, ...(process.platform === "darwin" ? ["-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"] : []), ...extra], { env });
}
async function native(tools, directory) {
  const cmakeBuild = join(build, "cmake", `native-${platform}`);
  await configure(tools, cmakeBuild);
  run(tools.cmake, ["--build", cmakeBuild, "--parallel", "4", "--target", "tuneforge_music_abi_static"], { env: tools.env });
  const files = ["libtuneforge_music_core.a", "libtuneforge_music_policies.a", "libmusic_core_policy.a"];
  for (const name of files) await fs.copyFile(join(cmakeBuild, name), join(directory, name));
  return publishManifest(directory, "native", files, { cmakeVersion: lock.tools.cmake.version });
}
async function wasm(tools, directory) {
  const archive = await toolArtifact("emscripten");
  const sdk = join(build, "cache", "emscripten", lock.tools.emscripten.version, `sdk-${platform}`);
  const marker = join(sdk, ".source.sha256");
  const pinned = lock.tools.emscripten.artifacts[platform].sha256;
  if (await fs.readFile(marker, "utf8").catch(() => "") !== pinned) {
    await fs.mkdir(sdk, { recursive: true });
    const paths = output("tar", ["-tf", archive]).split("\n");
    if (paths.some(path => isAbsolute(path) || path.split("/").includes(".."))) throw new Error("SDK archive path escapes extraction root");
    run("tar", ["-xf", archive, "--strip-components=1", "-C", sdk]);
    await fs.writeFile(marker, pinned);
  }
  const config = join(build, "cache", "emscripten", "config.py");
  await fs.writeFile(config, `LLVM_ROOT = ${JSON.stringify(join(sdk, "bin"))}\nBINARYEN_ROOT = ${JSON.stringify(sdk)}\nNODE_JS = [${JSON.stringify(process.execPath)}]\n`);
  const env = { ...tools.env, EM_CONFIG: config, EM_CACHE: join(build, "cache", "emscripten", "sysroot"), EMSDK_PYTHON: tools.python, EMCC_CORES: "4" };
  const emcc = join(sdk, "emscripten", "emcc");
  const version = output(emcc, ["--version"], { env });
  const tool = lock.tools.emscripten;
  const compilerVersion = (await fs.readFile(join(sdk, "emscripten/emscripten-version.txt"), "utf8")).trim();
  const compilerRevision = (await fs.readFile(join(sdk, "emscripten/emscripten-revision.txt"), "utf8")).trim();
  if (compilerVersion !== tool.compilerVersion || compilerRevision !== tool.compilerRevision ||
      !version.includes(`${tool.compilerVersion} (${tool.compilerRevision})`)) throw new Error("Unexpected Emscripten compiler identity");
  const cmakeBuild = join(build, "cmake", `wasm-${platform}`);
  await configure(tools, cmakeBuild, [`-DCMAKE_TOOLCHAIN_FILE=${join(sdk, "emscripten/cmake/Modules/Platform/Emscripten.cmake")}`], env);
  run(tools.cmake, ["--build", cmakeBuild, "--parallel", "4", "--target", "music_core_wasm"], { env });
  for (const name of ["music-core.mjs", "music-core.wasm"]) await fs.copyFile(join(cmakeBuild, name), join(directory, name));
  return publishManifest(directory, "wasm", ["music-core.mjs", "music-core.wasm"], { emscriptenVersion: lock.tools.emscripten.version, emscriptenArchiveSha256: pinned, emscriptenCompilerVersion: tool.compilerVersion, emscriptenCompilerRevision: tool.compilerRevision, emscriptenReleaseRevision: tool.releaseRevision, cmakeVersion: lock.tools.cmake.version });
}
async function python(tools, directory) {
  // This directory is owned by this producer; retain unrelated files, remove its prior wheel payloads.
  for (const name of await fs.readdir(directory)) {
    if (name.startsWith(`tuneforge_music_core-${pkg.version}-`) && name.endsWith(".whl")) await fs.unlink(join(directory, name));
  }
  run(tools.python, ["-c", "import sys; from scikit_build_core.build import build_wheel; print(build_wheel(sys.argv[1]))", directory], { env: tools.env });
  const wheels = (await fs.readdir(directory)).filter(name => name.endsWith(".whl"));
  if (wheels.length !== 1 || !wheels[0].includes(`-cp${tools.version.replace(".", "")}-`)) throw new Error("Wheel does not match the requested interpreter");
  const suffix = output(tools.python, ["-c", "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))"]);
  const checkWheel = "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); suffix=sys.argv[2]; assert any(n.endswith('/_native'+suffix) for n in z.namelist())";
  run(tools.python, ["-c", checkWheel, join(directory, wheels[0]), suffix], { env: tools.env });
  return publishManifest(directory, "python", wheels, { pythonVersion: output(tools.python, ["-c", "import platform; print(platform.python_version())"]), extensionSuffix: suffix, pythonAbi: `cp${tools.version.replace(".", "")}`, wheelPlatform: wheels[0].slice(0, -4).split("-").at(-1), pybind11Version: lock.tools.pybind11.version, cmakeVersion: lock.tools.cmake.version });
}
async function sdist(tools, directory) {
  const name = `tuneforge_music_core-${pkg.version}.tar.gz`;
  await fs.rm(join(directory, name), { force: true });
  run(tools.python, ["-c", "import sys; from scikit_build_core.build import build_sdist; print(build_sdist(sys.argv[1]))", directory], { env: tools.env });
  return publishManifest(directory, "sdist", [name], { cmakeVersion: lock.tools.cmake.version });
}
export function acquireSources(offline = false) {
  // Explicit producer-only acquisition. Neither CMake nor runtime bindings fetch.
  run("uv", [...(offline ? ["--offline"] : []), "run", "--python", "3.14", "--no-project", "python", join(root, "tools/prepare_sources.py"), "--fetch-sources", ...(offline ? ["--offline"] : [])], { env: { ...process.env, UV_PYTHON_DOWNLOADS: "never" } });
}
function reportArtifact(manifest, directory, status) {
  if (args.includes("--summary")) {
    console.log(`Music core ${manifest.target}: ${status}\nManifest: ${join(directory, "manifest.json")}`);
  } else {
    console.log(JSON.stringify(manifest, null, 2));
  }
}
export async function main() {
  if (args.includes("--fetch-sources")) {
    if (check) throw new Error("--check cannot fetch sources");
    acquireSources(args.includes("--offline"));
    return;
  }
  if (option("--download-tool")) {
    if (check) throw new Error("--check cannot download tools");
    console.log(await toolArtifact(option("--download-tool"), option("--platform", platform)));
    return;
  }
  const target = option("--target", "wasm");
  if (!["native", "wasm", "python", "sdist"].includes(target)) throw new Error("Expected --target native|wasm|python|sdist");
  const pythonVersion = option("--python", "3.14");
  const directory = await artifactDirectory(target, pythonVersion);
  if (check) { reportArtifact(await verify(directory, target, pythonVersion), directory, "verified"); return; }
  acquireSources(args.includes("--offline"));
  const current = await verify(directory, target, pythonVersion).catch(() => null);
  if (current) { reportArtifact(current, directory, "reused"); return; }
  const tools = await pythonTools(pythonVersion);
  await fs.mkdir(directory, { recursive: true });
  buildFingerprint = await sourceFingerprint();
  const manifest = await ({ native, wasm, python, sdist }[target])(tools, directory);
  reportArtifact(manifest, directory, "built");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
