import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquirePinnedFile, ffmpegCorrespondingSourcesFileName, reusableOutput } from "./build-ffmpeg.mjs";
import { soxrCorrespondingSourcesFileName, validateSoxrOutput } from "./build-soxr.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-ffmpeg-download-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("pinned source bytes");
  return { root, bytes, input: { url: "https://example.invalid/source.tar.xz", name: "source.tar.xz",
    label: "fixture source", sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
}

test("pinned source stays offline unless download is requested", async (t) => {
  const { root, input } = fixture(t);
  let fetched = false;
  await assert.rejects(acquirePinnedFile(root, input, { fetchImpl: async () => { fetched = true; } }),
    /Run pnpm ffmpeg:sources -- --download/);
  assert.equal(fetched, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("pinned source download follows redirects, verifies bytes, and reuses cache", async (t) => {
  const { root, bytes, input } = fixture(t);
  let fetches = 0;
  const fetchImpl = async (_url, options) => {
    fetches += 1;
    assert.equal(options.redirect, "follow");
    return new Response(bytes, { status: 200 });
  };
  const file = await acquirePinnedFile(root, input, { download: true, fetchImpl });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(await acquirePinnedFile(root, input, { download: true, fetchImpl }), file);
  assert.equal(fetches, 1);
});

test("pinned source rejects corrupt cache without replacing it", async (t) => {
  const { root, input } = fixture(t);
  const file = path.join(root, input.name);
  fs.writeFileSync(file, "corrupt");
  let fetched = false;
  await assert.rejects(acquirePinnedFile(root, input, {
    download: true, fetchImpl: async () => { fetched = true; },
  }), /SHA-256 mismatch/);
  assert.equal(fetched, false);
  assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
});

for (const [name, fetchImpl, expected] of [
  ["HTTP failure", async () => new Response("missing", { status: 404 }), /HTTP 404/],
  ["digest mismatch", async () => new Response("wrong", { status: 200 }), /SHA-256 mismatch/],
  ["interrupted transfer", async () => ({ ok: true, status: 200, body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error("interrupted")); },
  }) }), /interrupted/],
]) {
  test(`pinned source cleans temporary files after ${name}`, async (t) => {
    const { root, input } = fixture(t);
    await assert.rejects(acquirePinnedFile(root, input, { download: true, fetchImpl }), expected);
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test("corresponding-source name carries recipe identity", () => {
  assert.match(ffmpegCorrespondingSourcesFileName(),
    /^TuneForge_ffmpeg-9\.0\.1-lame-4\.0-1_[0-9a-f]{16}_corresponding-sources\.tar$/);
});

test("package commands ensure default runtimes without changing setup", () => {
  const mac = fs.readFileSync(new URL("./package-mac.mjs", import.meta.url), "utf8");
  const android = fs.readFileSync(new URL("./package-android.mjs", import.meta.url), "utf8");
  const scripts = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.match(mac, /if \(!configuredFfmpeg\)[\s\S]*"--target", "macos-arm64",[\s\S]*"--ensure"/);
  assert.match(android, /if \(!sourceEnv\.TUNEFORGE_ANDROID_FFMPEG_ROOT\)[\s\S]*build-ffmpeg\.mjs/);
  assert.match(android, /if \(!sourceEnv\.TUNEFORGE_ANDROID_SOXR_ROOT\)[\s\S]*build-soxr\.mjs/);
  assert.doesNotMatch(scripts["setup:dev"], /ffmpeg|soxr/i);
});

test("verified reuse precedes companion generation and rebuilds never adopt an existing companion", () => {
  const source = fs.readFileSync(new URL("./build-ffmpeg.mjs", import.meta.url), "utf8");
  const materialize = source.slice(source.indexOf("function materializeCorrespondingSources"),
    source.indexOf("function toolchainIdentity"));
  assert.doesNotMatch(materialize, /if \(existsSync\(output\)\)/);
  assert.match(source.slice(source.indexOf("export async function main")),
    /if \(options\.ensure && reusableOutput[\s\S]*?return;\s*}\s*const correspondingSources/);
});

test("FFmpeg reuse reads identity from provenance after full validator summary", (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, "provenance.json"), JSON.stringify({ buildIdentity: "current" }));
  const calls = [];
  const validate = (options) => { calls.push(options); return { target: options.target, files: 1, bytes: 1 }; };
  assert.equal(reusableOutput(root, "macos-arm64", "current", { validate }), true);
  assert.equal(reusableOutput(root, "macos-arm64", "stale", { validate }), false);
  assert.deepEqual(calls, [{ root, target: "macos-arm64" }, { root, target: "macos-arm64" }]);
});

test("libsoxr targets use independent content-addressed companions", () => {
  const android = soxrCorrespondingSourcesFileName("android-arm64-v8a", "a".repeat(64));
  const host = soxrCorrespondingSourcesFileName("host-test", "a".repeat(64));
  assert.notEqual(android, host);
  assert.match(android, /_android-arm64-v8a_aaaaaaaaaaaaaaaa_corresponding-sources\.tar$/);
  assert.match(host, /_host-test_aaaaaaaaaaaaaaaa_corresponding-sources\.tar$/);
});

test("standalone Android FFmpeg validation uses selected NDK readelf", () => {
  const source = fs.readFileSync(new URL("./build-ffmpeg.mjs", import.meta.url), "utf8");
  assert.match(source, /readelf: path\.join\(bin, "llvm-readelf"\)/);
  assert.match(source, /validateWithToolchain\(\{ root: stagedOutput, target: options\.target }, tc\)/);
  assert.match(source, /previous && tc\.readelf[\s\S]*process\.env\.LLVM_READELF = tc\.readelf/);
});

test("libsoxr validation rejects corrupt files and escaping provenance", (t) => {
  const { root } = fixture(t);
  const payload = path.join(root, "host-test");
  const licenses = path.join(payload, "licenses");
  fs.mkdirSync(licenses, { recursive: true });
  const files = ["libsoxr-LICENCE.txt", "libsoxr-COPYING.LGPL-2.1.txt"].map((name) => {
    const file = path.join(licenses, name);
    fs.writeFileSync(file, name);
    return { path: `licenses/${name}`, size: fs.statSync(file).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  });
  const companion = "fixture-sources.tar";
  fs.writeFileSync(path.join(root, companion), "sources");
  const provenance = { runtimeVersion: "soxr-a66f3eee", target: "host-test", buildIdentity: "current", files,
    correspondingSources: { fileName: companion, size: 7,
      sha256: crypto.createHash("sha256").update("sources").digest("hex") } };
  const provenanceFile = path.join(payload, "provenance.json");
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
  assert.equal(validateSoxrOutput(payload, "host-test").buildIdentity, "current");
  fs.writeFileSync(path.join(licenses, files[0].path.split("/").at(-1)), "corrupt");
  assert.throws(() => validateSoxrOutput(payload, "host-test"), /does not match provenance/);
  fs.writeFileSync(path.join(licenses, files[0].path.split("/").at(-1)), files[0].path.split("/").at(-1));
  fs.writeFileSync(provenanceFile, JSON.stringify({ ...provenance,
    correspondingSources: { ...provenance.correspondingSources, fileName: "../outside.tar" } }));
  assert.throws(() => validateSoxrOutput(payload, "host-test"), /metadata is invalid/);
});

test("Android libsoxr validation uses explicitly selected readelf", (t) => {
  const { root } = fixture(t);
  const payload = path.join(root, "android-arm64-v8a");
  const contents = new Map([
    ["licenses/libsoxr-LICENCE.txt", "license"],
    ["licenses/libsoxr-COPYING.LGPL-2.1.txt", "copying"],
    ["lib/libsoxr.so", "elf fixture"],
  ]);
  const files = [];
  for (const [relative, value] of contents) {
    const file = path.join(payload, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    files.push({ path: relative, size: fs.statSync(file).size,
      sha256: crypto.createHash("sha256").update(value).digest("hex") });
  }
  const companion = "android-sources.tar";
  fs.writeFileSync(path.join(root, companion), "sources");
  fs.writeFileSync(path.join(payload, "provenance.json"), JSON.stringify({
    runtimeVersion: "soxr-a66f3eee", target: "android-arm64-v8a", buildIdentity: "current", files,
    correspondingSources: { fileName: companion, size: 7,
      sha256: crypto.createHash("sha256").update("sources").digest("hex") },
  }));
  const calls = [];
  validateSoxrOutput(payload, "android-arm64-v8a", {
    readelf: "/selected/ndk/bin/llvm-readelf",
    runTool(command, args, options) {
      calls.push({ command, args, options });
      return "Machine: AArch64\n  LOAD 0x000000 0x000000 0x000000 0x4000\nShared library: [libm.so]\n";
    },
  });
  assert.deepEqual(calls, [{ command: "/selected/ndk/bin/llvm-readelf",
    args: ["-h", "-l", "-d", path.join(payload, "lib/libsoxr.so")], options: { capture: true } }]);
});
