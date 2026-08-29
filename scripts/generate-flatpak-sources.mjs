import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePnpmLock } from "../packaging/flatpak/seed-pnpm-store.mjs";
import { buildModelBundlePlan } from "./model-bundle-metadata.mjs";
import { parsePackageOptions } from "./package-options.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const flatpakRoot = path.join(workspaceRoot, "packaging", "flatpak");
const generatedRoot = path.join(flatpakRoot, "generated");

const cargoLockPath = path.join(workspaceRoot, "apps", "desktop", "src-tauri", "Cargo.lock");
const pnpmLockPath = path.join(workspaceRoot, "pnpm-lock.yaml");
const uvLockPath = path.join(workspaceRoot, "apps", "backend", "uv.lock");
const packageOptions = parsePackageOptions(process.argv.slice(2), { platform: "linux" });
const selectedPythonExtras = [
  ...(packageOptions.crema === "onnx" ? ["advanced-chords"] : []),
  ...(packageOptions.beatThis ? ["advanced-beats"] : []),
  ...(packageOptions.lvChordia ? ["lv-chordia"] : []),
];

function readRequiredFile(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeGeneratedFile(fileName, contents) {
  mkdirSync(generatedRoot, { recursive: true });
  writeFileSync(path.join(generatedRoot, fileName), contents);
}

function writeGeneratedJson(fileName, value) {
  writeGeneratedFile(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizePackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function basenameFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop());
}

function sha512IntegrityToHex(integrity) {
  if (!integrity.startsWith("sha512-")) {
    throw new Error(`Unsupported npm integrity algorithm: ${integrity}`);
  }

  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

function parseCargoLock(contents) {
  const packages = [];
  const packageBlocks = contents.matchAll(/\[\[package\]\]\n([\s\S]*?)(?=\n\[\[package\]\]|\s*$)/g);

  for (const match of packageBlocks) {
    const block = match[1];
    if (!/source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"/.test(block)) {
      continue;
    }

    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    const checksum = block.match(/^checksum = "([^"]+)"$/m)?.[1];
    if (!name || !version || !checksum) {
      throw new Error(`Could not parse Cargo package block:\n${block}`);
    }

    packages.push({ name, version, checksum });
  }

  packages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  return packages;
}

function generateCargoSources() {
  const crates = parseCargoLock(readRequiredFile(cargoLockPath));
  const sources = [
    {
      type: "file",
      path: "generated/cargo-config.toml",
      dest: ".cargo",
      "dest-filename": "config.toml",
    },
    {
      type: "file",
      path: "generated/cargo-checksums.sh",
      dest: ".",
      "dest-filename": "cargo-checksums.sh",
    },
  ];

  const checksumCommands = [
    "#!/bin/sh",
    "set -eu",
    "",
    "write_checksum() {",
    "  crate_dir=$1",
    "  package_checksum=$2",
    "  printf '{\"files\":{},\"package\":\"%s\"}\\n' \"$package_checksum\" > \"$crate_dir/.cargo-checksum.json\"",
    "}",
    "",
  ];

  for (const crate of crates) {
    sources.push({
      type: "archive",
      "archive-type": "tar-gzip",
      url: `https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`,
      sha256: crate.checksum,
      dest: `cargo/vendor/${crate.name}-${crate.version}`,
    });
    checksumCommands.push(
      `write_checksum "cargo/vendor/${crate.name}-${crate.version}" "${crate.checksum}"`,
    );
  }

  writeGeneratedFile(
    "cargo-config.toml",
    `[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "cargo/vendor"\n`,
  );
  writeGeneratedFile("cargo-checksums.sh", `${checksumCommands.join("\n")}\n`);
  writeGeneratedJson("cargo-sources.json", sources);

  return crates.length;
}

function generateNodeSources() {
  const packages = parsePnpmLock(readRequiredFile(pnpmLockPath));
  const sources = packages.map((pkg) => ({
    type: "file",
    url: pkg.url,
    sha512: sha512IntegrityToHex(pkg.integrity),
    dest: "node-sources",
    "dest-filename": pkg.fileName,
  }));

  writeGeneratedJson("node-sources.json", sources);

  return packages.length;
}

export function markerMatchesFlatpakTarget(marker, { extras = [] } = {}) {
  if (!marker) {
    return true;
  }

  const selectedExtras = new Set(extras.map((extra) => `extra-17-tuneforge-backend-${extra}`));
  const expression = marker
    .replace(/\bsys_platform\b/g, '"linux"')
    .replace(/\bplatform_machine\b/g, '"x86_64"')
    .replace(/\bplatform_system\b/g, '"Linux"')
    .replace(/\bplatform_python_implementation\b/g, '"CPython"')
    .replace(/\bimplementation_name\b/g, '"cpython"')
    .replace(/\bpython_version\b/g, '"3.14"')
    .replace(/\bpython_full_version\b/g, '"3.14.7"')
    .replace(/extra\s*==\s*'([^']+)'/g, (_match, extra) => String(selectedExtras.has(extra)))
    .replace(/extra\s*!=\s*'([^']+)'/g, (_match, extra) => String(!selectedExtras.has(extra)))
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||");

  try {
    return Boolean(Function(`"use strict"; return (${expression});`)());
  } catch (error) {
    throw new Error(`Could not evaluate marker "${marker}": ${error}`);
  }
}

function parseDependencyEntries(contents) {
  return Array.from(contents.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g))
    .map((match) => {
      const inline = match[0];
      const name = inline.match(/name = "([^"]+)"/)?.[1];
      const version = inline.match(/version = "([^"]+)"/)?.[1];
      const marker = inline.match(/marker = "([^"]+)"/)?.[1];
      const extras = Array.from(inline.match(/extra = \[([^\]]+)\]/)?.[1].matchAll(/"([^"]+)"/g) ?? []).map(
        (extraMatch) => extraMatch[1],
      );
      if (!name) {
        throw new Error(`Could not parse dependency entry: ${match[0]}`);
      }
      return { name: normalizePackageName(name), version, marker, extras };
    })
    .filter((dependency) => dependency.name);
}

function parseDependencyArray(block) {
  const dependencyMatch = block.match(/\ndependencies = \[\n([\s\S]*?)\n\]/);
  return dependencyMatch ? parseDependencyEntries(dependencyMatch[1]) : [];
}

function parseOptionalDependencies(block) {
  const optionalSectionMatch = block.match(/\n\[package\.optional-dependencies\]\n([\s\S]*?)(?=\n\[package\.|\s*$)/);
  if (!optionalSectionMatch) {
    return new Map();
  }

  const optionalDependencies = new Map();
  for (const match of optionalSectionMatch[1].matchAll(/^([A-Za-z0-9_.-]+) = \[\n([\s\S]*?)\n\]/gm)) {
    optionalDependencies.set(match[1], parseDependencyEntries(match[2]));
  }

  return optionalDependencies;
}

function parsePythonArtifact(inlineTable) {
  const url = inlineTable.match(/url = "([^"]+)"/)?.[1];
  const hash =
    inlineTable.match(/hash = "sha256:([^"]+)"/)?.[1] ??
    inlineTable.match(/hashes = \{ sha256 = "([^"]+)"/)?.[1];
  const sizeMatch = inlineTable.match(/size = (\d+)/)?.[1];
  if (!url || !hash) {
    throw new Error(`Could not parse Python artifact: ${inlineTable}`);
  }
  return { url, sha256: hash, fileName: basenameFromUrl(url), size: sizeMatch ? Number(sizeMatch) : null };
}

function packageIdentity({ name, version }) {
  return `${normalizePackageName(name)}@${version}`;
}

function findLockedPackage(packages, dependency) {
  if (dependency.version) {
    const pkg = packages.get(packageIdentity(dependency));
    if (!pkg) {
      throw new Error(`Could not find Python dependency ${dependency.name} ${dependency.version} in uv.lock`);
    }
    return pkg;
  }

  const candidates = Array.from(packages.values()).filter(
    (pkg) => normalizePackageName(pkg.name) === normalizePackageName(dependency.name),
  );
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new Error(`Could not find Python dependency ${dependency.name} in uv.lock`);
  }
  throw new Error(`Python dependency ${dependency.name} must include a version in uv.lock`);
}

export function parseUvLock(contents) {
  const packages = new Map();
  const packageBlocks = contents.matchAll(/\[\[package\]\]\n([\s\S]*?)(?=\n\[\[package\]\]|\s*$)/g);

  for (const match of packageBlocks) {
    const block = match[1];
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) {
      throw new Error(`Could not parse uv package block:\n${block}`);
    }

    const wheelsMatch = block.match(/\nwheels = \[\n([\s\S]*?)\n\]/);
    const wheels = wheelsMatch
      ? Array.from(wheelsMatch[1].matchAll(/\{([^}]+)\}/g)).map((artifact) =>
          parsePythonArtifact(artifact[1]),
        )
      : [];
    const sdistMatch = block.match(/\nsdist = \{([^}]+)\}/);
    const directSourceUrl = block.match(/^source = \{ url = "([^"]+)" \}$/m)?.[1];
    const parsedSdist = sdistMatch
      ? parsePythonArtifact(
          directSourceUrl && !sdistMatch[1].includes("url =")
            ? `${sdistMatch[1]}, url = "${directSourceUrl}"`
            : sdistMatch[1],
        )
      : null;
    const sdist = parsedSdist && directSourceUrl
      ? { ...parsedSdist, fileName: `${name.replaceAll("-", "_")}-${version}.tar.gz` }
      : parsedSdist;

    packages.set(packageIdentity({ name, version }), {
      name,
      version,
      dependencies: parseDependencyArray(`\n${block}`),
      optionalDependencies: parseOptionalDependencies(`\n${block}`),
      wheels,
      sdist,
      editable: /source = \{ editable = "\." \}/.test(block),
    });
  }

  return packages;
}

function extractArrayAssignment(block, name) {
  const start = block.indexOf(`\n${name} = [`);
  if (start === -1) {
    return null;
  }
  const openIndex = block.indexOf("[", start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < block.length; index += 1) {
    const character = block[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = inString;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "[") {
      depth += 1;
    }
    if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return block.slice(openIndex + 1, index);
      }
    }
  }
  throw new Error(`Could not parse ${name} array`);
}

function parsePythonArtifactsFromInlineTables(contents) {
  return Array.from(
    contents.matchAll(
      /\{[^{}]*url = "([^"]+)"(?:[^{}]|\{[^{}]*\})*?(?:hash = "sha256:([^"]+)"|hashes = \{ sha256 = "([^"]+)")(?:[^{}]|\{[^{}]*\})*?\}/g,
    ),
  ).map((match) => parsePythonArtifact(match[0]));
}

function parsePylock(contents) {
  const packages = new Map();
  for (const match of contents.matchAll(/\[\[packages\]\]\n([\s\S]*?)(?=\n\[\[packages\]\]|\s*$)/g)) {
    const block = match[1];
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) {
      throw new Error(`Could not parse pylock package block:\n${block}`);
    }
    const wheelsBody = extractArrayAssignment(`\n${block}`, "wheels");
    const wheels = wheelsBody ? parsePythonArtifactsFromInlineTables(wheelsBody) : [];
    const sdistLine = block.match(/^sdist = \{(.+)$/m)?.[0];
    packages.set(packageIdentity({ name, version }), {
      name,
      version,
      dependencies: [],
      optionalDependencies: new Map(),
      wheels,
      sdist: sdistLine ? parsePythonArtifact(sdistLine) : null,
      editable: false,
    });
  }
  return packages;
}

export function wheelScore(fileName) {
  const lower = fileName.toLowerCase();
  const parts = lower.replace(/\.whl$/, "").split("-");
  if (parts.length < 5) {
    return -1;
  }
  const [pythonTag, abiTag, platformTag] = parts.slice(-3);
  const universal = platformTag === "any";
  const linuxX86 = /(?:^|\.)manylinux[^.]*_x86_64(?:\.|$)|^linux_x86_64$/.test(platformTag);
  if (!universal && !linuxX86) {
    return -1;
  }
  if (/^(?:py2\.py3|py3)$/.test(pythonTag) && abiTag === "none") {
    return 10;
  }
  const cpythonTags = pythonTag.split(".").map((tag) => /^cp(\d)(\d+)$/.exec(tag));
  if (cpythonTags.some((tag) => tag === null)) {
    return -1;
  }
  if (abiTag === "cp314" && cpythonTags.some((tag) => tag?.[1] === "3" && tag[2] === "14")) {
    return 40;
  }
  if (abiTag === "abi3") {
    const compatible = cpythonTags.some((tag) => tag?.[1] === "3" && Number(tag[2]) <= 14);
    return compatible ? 30 : -1;
  }
  return -1;
}

function selectPythonArtifact(pkg) {
  const wheel = pkg.wheels
    .map((candidate) => ({ ...candidate, score: wheelScore(candidate.fileName) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.fileName.localeCompare(right.fileName))[0];

  if (wheel) {
    return wheel;
  }
  if (pkg.sdist) {
    return pkg.sdist;
  }

  throw new Error(`No Linux x86_64-compatible artifact found for ${pkg.name} ${pkg.version}`);
}

export function resolvePythonRuntimePackages(packages, { extras = [] } = {}) {
  const root = findLockedPackage(packages, { name: "tuneforge-backend" });

  const queue = [...root.dependencies];
  for (const extra of extras) {
    const extraDependencies = root.optionalDependencies.get(extra);
    if (!extraDependencies) {
      throw new Error(`tuneforge-backend does not define requested extra "${extra}"`);
    }
    queue.push(...extraDependencies);
  }
  const resolved = new Map();
  const processedExtrasByPackage = new Map();

  while (queue.length > 0) {
    const dependency = queue.shift();
    if (!markerMatchesFlatpakTarget(dependency.marker, { extras })) {
      continue;
    }

    const pkg = findLockedPackage(packages, dependency);
    const identity = packageIdentity(pkg);
    if (resolved.has(identity)) {
      continue;
    }

    if (pkg.editable) {
      continue;
    }

    if (!resolved.has(identity)) {
      resolved.set(identity, pkg);
      queue.push(...pkg.dependencies);
    }

    const processedExtras = processedExtrasByPackage.get(identity) ?? new Set();
    processedExtrasByPackage.set(identity, processedExtras);

    for (const extra of dependency.extras ?? []) {
      if (processedExtras.has(extra)) {
        continue;
      }
      processedExtras.add(extra);

      const extraDependencies = pkg.optionalDependencies.get(extra);
      if (!extraDependencies) {
        throw new Error(`${pkg.name} ${pkg.version} does not define requested extra "${extra}"`);
      }
      queue.push(...extraDependencies);
    }
  }

  return Array.from(resolved.values()).sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
}

function resolveNamedPythonPackages(packages, names) {
  const resolved = new Map();
  const queue = names.map((name) => ({ name }));
  while (queue.length > 0) {
    const dependency = queue.shift();
    if (!markerMatchesFlatpakTarget(dependency.marker)) {
      continue;
    }
    const pkg = findLockedPackage(packages, dependency);
    const identity = packageIdentity(pkg);
    if (resolved.has(identity)) {
      continue;
    }
    resolved.set(identity, pkg);
    queue.push(...pkg.dependencies);
  }
  return Array.from(resolved.values()).sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(flatpakRoot, ".uv-cache"),
      ...options.env,
    },
  });

  if (result.error?.code === "ENOENT") {
    throw new Error(`Required command not found: ${command}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function resolveLegacyTorchPackages() {
  const requirementsPath = path.join(generatedRoot, "python-legacy-torch.in");
  const pylockPath = path.join(generatedRoot, "pylock.legacy-torch.toml");
  writeGeneratedFile("python-legacy-torch.in", "torch==2.13.0\ntorchaudio==2.11.0\n");
  run("uv", [
    "--quiet",
    "pip",
    "compile",
    requirementsPath,
    "--python-version",
    "3.14",
    "--python-platform",
    "x86_64-manylinux_2_28",
    "--torch-backend",
    "cu126",
    "--format",
    "pylock.toml",
    "--output-file",
    pylockPath,
    "--no-header",
    "--no-annotate",
  ]);
  return parsePylock(readRequiredFile(pylockPath));
}

function resolveCpuTorchPackages() {
  const requirementsPath = path.join(generatedRoot, "python-cpu-torch.in");
  const pylockPath = path.join(generatedRoot, "pylock.cpu-torch.toml");
  writeGeneratedFile("python-cpu-torch.in", "torch==2.13.0\ntorchaudio==2.11.0\n");
  run("uv", [
    "--quiet",
    "pip",
    "compile",
    requirementsPath,
    "--python-version",
    "3.14",
    "--python-platform",
    "x86_64-manylinux_2_28",
    "--torch-backend",
    "cpu",
    "--format",
    "pylock.toml",
    "--output-file",
    pylockPath,
    "--no-header",
    "--no-annotate",
  ]);
  return parsePylock(readRequiredFile(pylockPath));
}

function isLegacyTorchPackage(packageName) {
  return (
    packageName === "torch" ||
    packageName === "torchaudio" ||
    packageName === "triton" ||
    packageName === "sympy" ||
    packageName.startsWith("cuda-") ||
    packageName.startsWith("nvidia-")
  );
}

export function mergeLegacyTorchPackageSets(packages, legacyPackages) {
  const merged = new Map(packages.map((pkg) => [packageIdentity(pkg), pkg]));
  for (const [identity, pkg] of merged) {
    if (isLegacyTorchPackage(normalizePackageName(pkg.name))) {
      merged.delete(identity);
    }
  }
  for (const pkg of legacyPackages.values()) {
    if (isLegacyTorchPackage(normalizePackageName(pkg.name))) {
      merged.set(packageIdentity(pkg), pkg);
    }
  }
  return Array.from(merged.values()).sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
}

export function assertDefaultCpuTorchClosure(packages) {
  const unwanted = packages
    .map((pkg) => normalizePackageName(pkg.name))
    .filter((name) => name === "triton" || name.startsWith("cuda-") || name.startsWith("nvidia-"));
  if (unwanted.length > 0) {
    throw new Error(`Default Flatpak CPU Torch closure includes unsupported packages: ${unwanted.join(", ")}`);
  }
}

function generatePythonSources() {
  const lockedPackages = parseUvLock(readRequiredFile(uvLockPath));
  let runtimePackages = resolvePythonRuntimePackages(lockedPackages, { extras: selectedPythonExtras });
  runtimePackages = mergeLegacyTorchPackageSets(
    runtimePackages,
    packageOptions.legacyNvidia ? resolveLegacyTorchPackages() : resolveCpuTorchPackages(),
  );
  if (!packageOptions.legacyNvidia) assertDefaultCpuTorchClosure(runtimePackages);
  const buildRequirementNames = ["setuptools", "wheel", ...(packageOptions.lvChordia ? ["hatchling"] : [])];
  const buildPackages = resolveNamedPythonPackages(lockedPackages, buildRequirementNames);
  const runtimePackageNames = new Set(runtimePackages.map((pkg) => packageIdentity(pkg)));
  const packages = Array.from(
    new Map([...runtimePackages, ...buildPackages].map((pkg) => [packageIdentity(pkg), pkg])).values(),
  ).sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
  const sourceByUrl = new Map();
  const artifactReport = [];

  for (const pkg of packages) {
    const artifact = selectPythonArtifact(pkg);
    sourceByUrl.set(artifact.url, {
      type: "file",
      url: artifact.url,
      sha256: artifact.sha256,
      dest: "python-sources",
      "dest-filename": artifact.fileName,
    });
    artifactReport.push({
      name: pkg.name,
      version: pkg.version,
      fileName: artifact.fileName,
      size: artifact.size,
      url: artifact.url,
    });
  }

  const sources = Array.from(sourceByUrl.values()).sort((left, right) => left.url.localeCompare(right.url));
  const runtimeRequirements = packages
    .filter((pkg) => runtimePackageNames.has(packageIdentity(pkg)))
    .map((pkg) => `${pkg.name}==${pkg.version}`)
    .sort();
  const buildRequirements = buildRequirementNames.map((name) => {
    const pkg = findLockedPackage(lockedPackages, { name });
    return `${pkg.name}==${pkg.version}`;
  });

  writeGeneratedJson("python-sources.json", sources);
  writeGeneratedFile("python-build-requirements.txt", `${buildRequirements.join("\n")}\n`);
  writeGeneratedFile("python-requirements.txt", `${runtimeRequirements.join("\n")}\n`);
  writeGeneratedJson(
    "python-size-report.json",
    artifactReport.sort((left, right) => (right.size ?? -1) - (left.size ?? -1) || left.name.localeCompare(right.name)),
  );

  return packages.length;
}

function generateModelBundleSources() {
  if (!packageOptions.modelBundle && packageOptions.crema === "none") {
    return 0;
  }
  const completePlan = buildModelBundlePlan({
    includeBeatThis: packageOptions.modelBundle && packageOptions.beatThis,
    includeCremaOnnx: packageOptions.crema === "onnx",
  });
  const plan = packageOptions.modelBundle ? completePlan : cremaOnlyModelBundlePlan(completePlan);
  writeGeneratedJson("model-bundle-sources.json", plan.sources);
  writeGeneratedJson("model-bundle-manifest.json", {
    ...plan.manifest,
    prepared_at: new Date().toISOString(),
  });
  return plan.sources.length;
}

export function cremaOnlyModelBundlePlan(plan) {
  const fileNames = new Set(plan.manifest.crema_onnx_files.map((entry) => entry.file_name));
  return {
    sources: plan.sources.filter((source) => fileNames.has(source["dest-filename"])),
    manifest: {
      ...plan.manifest,
      torch_checkpoints: [],
      whisper_models: [],
    },
  };
}

function main() {
  const cargoCount = generateCargoSources();
  const nodeCount = generateNodeSources();
  const pythonCount = generatePythonSources();
  const modelBundleCount = generateModelBundleSources();

  process.stdout.write(
    `Generated Flatpak sources: ${cargoCount} Cargo crates, ${nodeCount} pnpm tarballs, ${pythonCount} Python packages, ${modelBundleCount} model bundle files.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
