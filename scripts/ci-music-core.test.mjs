import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { payloadNames, verifyPayload } from "./ci-music-core.mjs";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export function payloadFixture(directory, root = repository) {
  const core = path.join(root, "packages/music-core");
  for (const name of payloadNames.filter(name => !name.startsWith("wasm/") && name !== "build-tools.txt")) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.copyFileSync(path.join(core, name), path.join(directory, name));
  }
  fs.mkdirSync(path.join(directory, "wasm"), { recursive: true });
  fs.writeFileSync(path.join(directory, "wasm/music-core.mjs"), "synthetic JavaScript payload");
  fs.writeFileSync(path.join(directory, "wasm/music-core.wasm"), "synthetic WASM payload");
  const sources = JSON.parse(fs.readFileSync(path.join(core, "sources.lock.json")));
  const lock = JSON.parse(fs.readFileSync(path.join(core, "toolchains.lock.json")));
  const pkg = JSON.parse(fs.readFileSync(path.join(core, "package.json")));
  const tool = lock.tools.emscripten;
  const manifest = { manifestVersion: 1, packageVersion: pkg.version, apiVersion: 1, abiVersion: 1, schemaVersion: 1, corpusVersion: 1,
    target: "wasm", platform: "linux-x64", sourceFingerprint: "0".repeat(64),
    gingoRevision: sources.revision, gingoArchiveSha256: sources.archive.sha256,
    preparedSourceIdentity: digest(JSON.stringify({ archive: sources.archive, files: sources.files.map(file => ({ path: file.path, sha256: file.sha256 })), patches: sources.patches })),
    cmakeVersion: lock.tools.cmake.version, emscriptenVersion: tool.version,
    emscriptenArchiveSha256: tool.artifacts["linux-x64"].sha256, emscriptenCompilerVersion: tool.compilerVersion,
    emscriptenCompilerRevision: tool.compilerRevision, emscriptenReleaseRevision: tool.releaseRevision,
    files: ["music-core.mjs", "music-core.wasm"].map(name => { const bytes = fs.readFileSync(path.join(directory, "wasm", name)); return { path: name, sha256: digest(bytes), bytes: bytes.length }; }) };
  fs.writeFileSync(path.join(directory, "wasm/manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "build-tools.txt"), "synthetic test bootstrap evidence\n");
  refreshPayload(directory);
  return directory;
}
function refreshPayload(directory) {
  fs.writeFileSync(path.join(directory, "payload.sha256"), payloadNames.map(name => digest(fs.readFileSync(path.join(directory, name))) + "  " + name + "\n").join(""));
}
function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ci-music-core-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return payloadFixture(directory);
}
test("portable music-core payload verifies metadata, checksums and complete notices/pins", context => {
  assert.equal(verifyPayload(fixture(context)).platform, "linux-x64");
});
for (const name of payloadNames) test("music-core rejects missing/corrupt payload " + name, context => {
  const directory = fixture(context);
  fs.appendFileSync(path.join(directory, name), "tampered");
  assert.throws(() => verifyPayload(directory), /checksum mismatch/);
  fs.unlinkSync(path.join(directory, name));
  assert.throws(() => verifyPayload(directory), /ENOENT/);
});
test("music-core rejects traversal, duplicate and omitted manifest entries", context => {
  const directory = fixture(context);
  const file = path.join(directory, "payload.sha256");
  const original = fs.readFileSync(file, "utf8");
  for (const rows of [original + original.split("\n")[0] + "\n", original.split("\n").slice(1).join("\n"), original.replace("wasm/music-core.wasm", "../music-core.wasm")]) {
    fs.writeFileSync(file, rows);
    assert.throws(() => verifyPayload(directory), /matrix differs|Unexpected.*entry/);
  }
});
test("music-core rejects self-consistent stale metadata and changed notices", context => {
  const directory = fixture(context);
  const file = path.join(directory, "wasm/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.emscriptenCompilerRevision = "tampered";
  fs.writeFileSync(file, JSON.stringify(manifest));
  refreshPayload(directory);
  assert.throws(() => verifyPayload(directory), /toolchain identity mismatch/);
  payloadFixture(directory);
  fs.appendFileSync(path.join(directory, "licenses/Unicode-LICENSE"), "tampered");
  refreshPayload(directory);
  assert.throws(() => verifyPayload(directory), /notice.source pin differs/);
});
test("music-core rejects symlink payload files", context => {
  const directory = fixture(context);
  const file = path.join(directory, "wasm/music-core.wasm");
  fs.renameSync(file, file + ".real");
  fs.symlinkSync(file + ".real", file);
  assert.throws(() => verifyPayload(directory), /regular files/);
});
