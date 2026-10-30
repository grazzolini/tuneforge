import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyManifestMetadata } from "../packages/music-core/tools/build.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = path.join(repository, "packages/music-core");
const artifactNames = ["manifest.json", "music-core.mjs", "music-core.wasm"];
const noticeNames = ["LICENSE", "licenses/Gingo-LICENSE", "licenses/Unicode-LICENSE", "sources.lock.json", "toolchains.lock.json", "package.json"];
export const payloadNames = [...artifactNames.map(name => "wasm/" + name), ...noticeNames, "build-tools.txt"].sort();
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function regularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Music-core payload must contain regular files: " + file);
  return fs.readFileSync(file);
}
function checkArtifact() {
  execFileSync(process.execPath, [path.join(core, "tools/build.mjs"), "--target", "wasm", "--check", "--summary"], { stdio: "inherit" });
}
export function verifyPayload(directory) {
  const rows = regularFile(path.join(directory, "payload.sha256")).toString().trimEnd().split("\n");
  const names = [];
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})  ([\w./-]+)$/);
    if (!match || !payloadNames.includes(match[2])) throw new Error("Unexpected music-core payload manifest entry");
    const [, expected, name] = match;
    names.push(name);
    if (digest(regularFile(path.join(directory, name))) !== expected) throw new Error("Music-core payload checksum mismatch: " + name);
  }
  if (JSON.stringify(names.sort()) !== JSON.stringify(payloadNames)) throw new Error("Music-core payload matrix differs");
  for (const name of noticeNames) {
    if (!regularFile(path.join(directory, name)).equals(regularFile(path.join(core, name)))) throw new Error("Music-core notice/source pin differs: " + name);
  }
  const manifest = JSON.parse(regularFile(path.join(directory, "wasm/manifest.json")));
  verifyManifestMetadata(manifest, "wasm");
  if (!Array.isArray(manifest.files) || JSON.stringify(manifest.files.map(file => file.path).sort()) !== JSON.stringify(artifactNames.filter(name => name !== "manifest.json"))) throw new Error("Music-core WASM artifact matrix differs");
  for (const file of manifest.files) {
    const bytes = regularFile(path.join(directory, "wasm", file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error("Music-core WASM manifest checksum mismatch: " + file.path);
  }
  return manifest;
}
export function stagePayload(directory) {
  checkArtifact();
  if (fs.existsSync(directory)) throw new Error("Music-core staging destination already exists");
  fs.mkdirSync(directory, { recursive: true });
  for (const name of [...artifactNames.map(name => "wasm/" + name), ...noticeNames]) {
    const source = name.startsWith("wasm/") ? path.join(core, "build/artifacts", name) : path.join(core, name);
    const destination = path.join(directory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, regularFile(source));
  }
  fs.writeFileSync(path.join(directory, "build-tools.txt"), execFileSync(process.execPath, ["--version"]) + execFileSync("uv", ["--version"]) + execFileSync("uv", ["run", "--no-project", "--python", "3.14", "python", "--version"]) + Object.keys(process.env).filter(key => key.startsWith("MUSIC_")).sort().map(key => key + "=" + process.env[key] + "\n").join(""));
  fs.writeFileSync(path.join(directory, "payload.sha256"), payloadNames.map(name => digest(regularFile(path.join(directory, name))) + "  " + name + "\n").join(""));
  verifyPayload(directory);
}
export function installPayload(directory) {
  verifyPayload(directory);
  const destination = path.join(core, "build/artifacts/wasm");
  fs.mkdirSync(destination, { recursive: true });
  for (const name of artifactNames) fs.writeFileSync(path.join(destination, name), regularFile(path.join(directory, "wasm", name)));
  // The canonical producer check binds the payload to every current package source byte.
  checkArtifact();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory = "/opt/tuneforge-ci/music-core"] = process.argv.slice(2);
  if (action === "stage") stagePayload(directory);
  else if (action === "verify") verifyPayload(directory);
  else if (action === "install") installPayload(directory);
  else throw new Error("Use stage|verify|install [PAYLOAD_DIRECTORY]");
}
