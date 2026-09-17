import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultVersionFilePath = path.resolve(scriptDir, "..", ".python-version");
const exactVersionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

export function parsePythonVersion(contents, { source = ".python-version" } = {}) {
  const value = contents.trim();
  const match = exactVersionPattern.exec(value);
  if (!match) {
    throw new Error(`${source} must contain an exact major.minor.patch Python version; found ${JSON.stringify(value)}.`);
  }
  const [, major, minor, patch] = match;
  return {
    full: value,
    minor: `${major}.${minor}`,
    abi: `cp${major}${minor}`,
    major,
    patch,
  };
}

export function readPythonVersion({ versionFilePath = defaultVersionFilePath } = {}) {
  try {
    return parsePythonVersion(readFileSync(versionFilePath, "utf8"), { source: versionFilePath });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Required Python version file is missing: ${versionFilePath}`);
    }
    throw error;
  }
}

export function assertPythonVersionCompatibility(version, {
  abi,
  full,
  minor,
  subject = "Release packaging",
} = {}) {
  const expected = full ?? minor;
  if (expected && version[full ? "full" : "minor"] !== expected) {
    throw new Error(`${subject} targets Python ${expected}, but .python-version pins ${version.full}.`);
  }
  if (abi && version.abi !== abi) {
    throw new Error(`${subject} targets ${abi}, but .python-version pins ${version.full} (${version.abi}).`);
  }
}
