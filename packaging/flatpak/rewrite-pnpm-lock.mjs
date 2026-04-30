import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const lockfilePath = "pnpm-lock.yaml";
const tarballRoot = process.argv[2] ?? "/app/share/tuneforge/node-sources";

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

function nodeTarballFileName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function tarballUrl(name, version) {
  return `file://${path.posix.join(tarballRoot, nodeTarballFileName(name, version))}`;
}

const lines = readFileSync(lockfilePath, "utf8").split("\n");
let inPackagesSection = false;
let currentPackageKey = null;

const rewritten = lines.map((line) => {
  if (line === "packages:") {
    inPackagesSection = true;
    currentPackageKey = null;
    return line;
  }
  if (inPackagesSection && line === "snapshots:") {
    inPackagesSection = false;
    currentPackageKey = null;
    return line;
  }
  if (inPackagesSection && line.startsWith("  ") && !line.startsWith("    ") && line.trim().endsWith(":")) {
    currentPackageKey = cleanYamlKey(line);
    return line;
  }
  if (
    inPackagesSection &&
    currentPackageKey &&
    line.includes("resolution:") &&
    line.includes("integrity:") &&
    !line.includes("tarball:")
  ) {
    const { name, version } = parsePnpmPackageKey(currentPackageKey);
    return line.replace(/}(\s*)$/, `, tarball: "${tarballUrl(name, version)}"}$1`);
  }

  return line;
});

writeFileSync(lockfilePath, rewritten.join("\n"));
