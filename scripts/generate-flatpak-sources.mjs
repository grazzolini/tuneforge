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
  ...(packageOptions.crema ? ["advanced-chords"] : []),
  ...(packageOptions.beatThis ? ["advanced-beats"] : []),
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

function markerMatchesFlatpakTarget(marker) {
  if (!marker) {
    return true;
  }

  const expression = marker
    .replace(/\bsys_platform\b/g, '"linux"')
    .replace(/\bplatform_machine\b/g, '"x86_64"')
    .replace(/\bplatform_system\b/g, '"Linux"')
    .replace(/\bplatform_python_implementation\b/g, '"CPython"')
    .replace(/\bimplementation_name\b/g, '"cpython"')
    .replace(/\bpython_version\b/g, '"3.11"')
    .replace(/\bpython_full_version\b/g, '"3.11.15"')
    .replace(/\bextra\b/g, '""')
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||");

  try {
    return Boolean(Function(`"use strict"; return (${expression});`)());
  } catch (error) {
    throw new Error(`Could not evaluate marker "${marker}": ${error}`);
  }
}

function parseDependencyEntries(contents) {
  return Array.from(contents.matchAll(/\{([^}]+)\}/g))
    .map((match) => {
      const inline = match[1];
      const name = inline.match(/name = "([^"]+)"/)?.[1];
      const marker = inline.match(/marker = "([^"]+)"/)?.[1];
      const extras = Array.from(inline.match(/extra = \[([^\]]+)\]/)?.[1].matchAll(/"([^"]+)"/g) ?? []).map(
        (extraMatch) => extraMatch[1],
      );
      if (!name) {
        throw new Error(`Could not parse dependency entry: ${match[0]}`);
      }
      return { name: normalizePackageName(name), marker, extras };
    })
    .filter((dependency) => markerMatchesFlatpakTarget(dependency.marker));
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

function parseUvLock(contents) {
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
    const sdist = sdistMatch ? parsePythonArtifact(sdistMatch[1]) : null;

    packages.set(normalizePackageName(name), {
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
  const packageBlocks = contents.matchAll(/\[\[packages\]\]\n([\s\S]*?)(?=\n\[\[packages\]\]|\s*$)/g);

  for (const match of packageBlocks) {
    const block = match[1];
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) {
      throw new Error(`Could not parse pylock package block:\n${block}`);
    }

    const wheelsBody = extractArrayAssignment(`\n${block}`, "wheels");
    const wheels = wheelsBody ? parsePythonArtifactsFromInlineTables(wheelsBody) : [];
    const sdistLine = block.match(/^sdist = \{(.+)$/m)?.[0];
    const sdist = sdistLine ? parsePythonArtifact(sdistLine) : null;

    packages.set(normalizePackageName(name), {
      name,
      version,
      dependencies: [],
      optionalDependencies: new Map(),
      wheels,
      sdist,
      editable: false,
    });
  }

  return packages;
}

function wheelScore(fileName) {
  const lower = fileName.toLowerCase();
  if (/(macosx|win32|win_amd64|win_arm64|musllinux|aarch64|armv7l|i686|ppc64le|s390x|riscv64)/.test(lower)) {
    return -1;
  }
  if (/(py2\.py3|py3)-none-any/.test(lower)) {
    return 10;
  }
  if (lower.includes("linux_x86_64")) {
    return lower.includes("cp311") ? 25 : 15;
  }
  if (lower.includes("manylinux") && lower.includes("x86_64")) {
    return lower.includes("cp311") ? 30 : 20;
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

function resolvePythonRuntimePackages(packages, { extras = [] } = {}) {
  const root = packages.get("tuneforge-backend");
  if (!root) {
    throw new Error("Could not find tuneforge-backend in uv.lock");
  }

  const queue = [...root.dependencies, { name: "setuptools" }, { name: "wheel" }];
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
    if (!markerMatchesFlatpakTarget(dependency.marker)) {
      continue;
    }

    const normalizedName = normalizePackageName(dependency.name);
    if (resolved.has(normalizedName)) {
      continue;
    }

    const pkg = packages.get(normalizedName);
    if (!pkg) {
      throw new Error(`Could not find Python dependency ${dependency.name} in uv.lock`);
    }
    if (pkg.editable) {
      continue;
    }

    if (!resolved.has(normalizedName)) {
      resolved.set(normalizedName, pkg);
      queue.push(...pkg.dependencies);
    }

    const processedExtras = processedExtrasByPackage.get(normalizedName) ?? new Set();
    processedExtrasByPackage.set(normalizedName, processedExtras);

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

  return Array.from(resolved.values()).sort((left, right) => left.name.localeCompare(right.name));
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
  writeGeneratedFile("python-legacy-torch.in", "torch==2.6.0\ntorchaudio==2.6.0\n");
  run("uv", [
    "--quiet",
    "pip",
    "compile",
    requirementsPath,
    "--python-version",
    "3.11",
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

function mergeLegacyTorchPackages(packages) {
  const merged = new Map(packages.map((pkg) => [normalizePackageName(pkg.name), pkg]));
  const legacyPackages = resolveLegacyTorchPackages();

  for (const packageName of Array.from(merged.keys())) {
    if (
      packageName === "torch" ||
      packageName === "torchaudio" ||
      packageName === "triton" ||
      packageName === "sympy" ||
      packageName.startsWith("nvidia-")
    ) {
      merged.delete(packageName);
    }
  }

  for (const [packageName, pkg] of legacyPackages) {
    if (
      packageName === "torch" ||
      packageName === "torchaudio" ||
      packageName === "triton" ||
      packageName === "sympy" ||
      packageName.startsWith("nvidia-")
    ) {
      merged.set(packageName, pkg);
    }
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function generatePythonSources() {
  let packages = resolvePythonRuntimePackages(parseUvLock(readRequiredFile(uvLockPath)), { extras: selectedPythonExtras });
  if (packageOptions.legacyNvidia) {
    packages = mergeLegacyTorchPackages(packages);
  }
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
    .filter((pkg) => !["setuptools", "wheel"].includes(normalizePackageName(pkg.name)))
    .map((pkg) => `${pkg.name}==${pkg.version}`)
    .sort();

  writeGeneratedJson("python-sources.json", sources);
  writeGeneratedFile("python-requirements.txt", `${runtimeRequirements.join("\n")}\n`);
  writeGeneratedJson(
    "python-size-report.json",
    artifactReport.sort((left, right) => (right.size ?? -1) - (left.size ?? -1) || left.name.localeCompare(right.name)),
  );

  return packages.length;
}

function generateModelBundleSources() {
  if (!packageOptions.modelBundle) {
    return 0;
  }
  const plan = buildModelBundlePlan({
    includeBeatThis: packageOptions.beatThis,
  });
  writeGeneratedJson("model-bundle-sources.json", plan.sources);
  writeGeneratedJson("model-bundle-manifest.json", {
    ...plan.manifest,
    prepared_at: new Date().toISOString(),
  });
  return plan.sources.length;
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

main();
