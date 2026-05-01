import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const workspaceRoot = path.resolve(scriptDir, "..");
const flatpakRoot = path.join(workspaceRoot, "packaging", "flatpak");
const generatedRoot = path.join(flatpakRoot, "generated");

const cargoLockPath = path.join(workspaceRoot, "apps", "desktop", "src-tauri", "Cargo.lock");
const pnpmLockPath = path.join(workspaceRoot, "pnpm-lock.yaml");
const uvLockPath = path.join(workspaceRoot, "apps", "backend", "uv.lock");

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

function cleanYamlKey(key) {
  let cleaned = key.trim();
  if (cleaned.endsWith(":")) {
    cleaned = cleaned.slice(0, -1);
  }
  if (
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

function parsePnpmPackageKey(key) {
  const withoutPeers = key.replace(/\(.+$/, "");
  const versionSeparator = withoutPeers.lastIndexOf("@");
  if (versionSeparator <= 0) {
    throw new Error(`Could not parse pnpm package key: ${key}`);
  }

  return {
    name: withoutPeers.slice(0, versionSeparator),
    version: withoutPeers.slice(versionSeparator + 1),
  };
}

function npmTarballUrl(name, version) {
  if (!name.startsWith("@")) {
    return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  }

  const [scope, packageName] = name.split("/");
  return `https://registry.npmjs.org/${scope}/${packageName}/-/${packageName}-${version}.tgz`;
}

function nodeTarballFileName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function parsePnpmLock(contents) {
  const packagesStart = contents.indexOf("\npackages:\n");
  if (packagesStart === -1) {
    throw new Error("Could not find packages section in pnpm-lock.yaml");
  }

  const snapshotsStart = contents.indexOf("\nsnapshots:\n", packagesStart);
  const packagesBody = contents.slice(
    packagesStart + "\npackages:\n".length,
    snapshotsStart === -1 ? contents.length : snapshotsStart,
  );

  const packages = new Map();
  let currentKey = null;
  let currentBlock = [];

  function finishEntry() {
    if (!currentKey) {
      return;
    }

    const block = currentBlock.join("\n");
    const integrity = block.match(/integrity:\s*([^}\s]+)/)?.[1];
    if (!integrity) {
      return;
    }

    const parsed = parsePnpmPackageKey(currentKey);
    const key = `${parsed.name}@${parsed.version}`;
    if (!packages.has(key)) {
      packages.set(key, {
        ...parsed,
        integrity,
        url: npmTarballUrl(parsed.name, parsed.version),
        fileName: nodeTarballFileName(parsed.name, parsed.version),
      });
    }
  }

  for (const line of packagesBody.split("\n")) {
    if (line.startsWith("  ") && !line.startsWith("    ") && line.trim().endsWith(":")) {
      finishEntry();
      currentKey = cleanYamlKey(line);
      currentBlock = [];
      continue;
    }

    if (currentKey) {
      currentBlock.push(line);
    }
  }
  finishEntry();

  return Array.from(packages.values()).sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
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
  const hash = inlineTable.match(/hash = "sha256:([^"]+)"/)?.[1];
  if (!url || !hash) {
    throw new Error(`Could not parse Python artifact: ${inlineTable}`);
  }
  return { url, sha256: hash, fileName: basenameFromUrl(url) };
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

function wheelScore(fileName) {
  const lower = fileName.toLowerCase();
  if (/(macosx|win32|win_amd64|win_arm64|musllinux|aarch64|armv7l|i686|ppc64le|s390x|riscv64)/.test(lower)) {
    return -1;
  }
  if (/(py2\.py3|py3)-none-any/.test(lower)) {
    return 10;
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

function resolvePythonRuntimePackages(packages) {
  const root = packages.get("tuneforge-backend");
  if (!root) {
    throw new Error("Could not find tuneforge-backend in uv.lock");
  }

  const queue = [...root.dependencies, { name: "setuptools" }, { name: "wheel" }];
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

function generatePythonSources() {
  const packages = resolvePythonRuntimePackages(parseUvLock(readRequiredFile(uvLockPath)));
  const sourceByUrl = new Map();

  for (const pkg of packages) {
    const artifact = selectPythonArtifact(pkg);
    sourceByUrl.set(artifact.url, {
      type: "file",
      url: artifact.url,
      sha256: artifact.sha256,
      dest: "python-sources",
      "dest-filename": artifact.fileName,
    });
  }

  const sources = Array.from(sourceByUrl.values()).sort((left, right) => left.url.localeCompare(right.url));
  const runtimeRequirements = packages
    .filter((pkg) => !["setuptools", "wheel"].includes(normalizePackageName(pkg.name)))
    .map((pkg) => `${pkg.name}==${pkg.version}`)
    .sort();

  writeGeneratedJson("python-sources.json", sources);
  writeGeneratedFile("python-requirements.txt", `${runtimeRequirements.join("\n")}\n`);

  return packages.length;
}

function main() {
  const cargoCount = generateCargoSources();
  const nodeCount = generateNodeSources();
  const pythonCount = generatePythonSources();

  process.stdout.write(
    `Generated Flatpak sources: ${cargoCount} Cargo crates, ${nodeCount} pnpm tarballs, ${pythonCount} Python packages.\n`,
  );
}

main();
