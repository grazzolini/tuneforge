import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyManifestMetadata } from "../tools/build.mjs";
const lock = JSON.parse(readFileSync(new URL("../toolchains.lock.json", import.meta.url)));
const sources = JSON.parse(readFileSync(new URL("../sources.lock.json", import.meta.url)));
const preparedSourceIdentity = createHash("sha256").update(JSON.stringify({ archive: sources.archive,
  files: sources.files.map(file => ({ path: file.path, sha256: file.sha256 })), patches: sources.patches })).digest("hex");
const base = { manifestVersion: 1, packageVersion: "0.1.0", apiVersion: 1, abiVersion: 1, schemaVersion: 1, corpusVersion: 1,
  gingoArchiveSha256: sources.archive.sha256, preparedSourceIdentity,
  target: "wasm", platform: "linux-x64", gingoRevision: "eec410e6f5b09ad89a2b9d987b63e4048d9a738c", cmakeVersion: lock.tools.cmake.version,
  emscriptenVersion: lock.tools.emscripten.version, emscriptenArchiveSha256: lock.tools.emscripten.artifacts["linux-x64"].sha256,
  emscriptenCompilerVersion: lock.tools.emscripten.compilerVersion, emscriptenCompilerRevision: lock.tools.emscripten.compilerRevision,
  emscriptenReleaseRevision: lock.tools.emscripten.releaseRevision };
verifyManifestMetadata(base, "wasm");
let rejected = 0;
for (const key of Object.keys(base)) {
  assert.throws(() => verifyManifestMetadata({ ...base, [key]: "tampered" }, "wasm"), key);
  rejected++;
}
const host = `${process.platform}-${process.arch}`;
for (const minor of ["3.14", "3.11"]) {
  const abi = `cp${minor.replace(".", "")}`;
  const wheelPlatform = process.platform === "darwin" ? "macosx_13_0_arm64" : `linux_${process.arch === "x64" ? "x86_64" : "aarch64"}`;
  const extensionSuffix = process.platform === "darwin" ? `.cpython-${abi.slice(2)}-darwin.so` : `.cpython-${abi.slice(2)}-${process.arch === "x64" ? "x86_64" : "aarch64"}-linux-gnu.so`;
  const python = { ...base, target: "python", platform: host, pythonVersion: minor + ".7", pythonAbi: abi, extensionSuffix,
    pybind11Version: lock.tools.pybind11.version, wheelPlatform, files: [{ path: `tuneforge_music_core-0.1.0-${abi}-${abi}-${wheelPlatform}.whl` }] };
  verifyManifestMetadata(python, "python", minor);
  assert.throws(() => verifyManifestMetadata(python, "python", minor === "3.14" ? "3.11" : "3.14"));
  for (const key of ["platform", "pythonVersion", "pythonAbi", "extensionSuffix", "pybind11Version", "wheelPlatform", "files"]) {
    assert.throws(() => verifyManifestMetadata({ ...python, [key]: key === "files" ? [] : "tampered" }, "python", minor), key);
    rejected++;
  }
}
console.log(JSON.stringify({ portableWasmProducer: "linux-x64", pythonAbis: ["cp314", "cp311"], rejectedMetadataMutations: rejected + 2 }));
