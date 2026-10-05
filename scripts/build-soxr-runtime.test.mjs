import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeterministicSourceSnapshot } from "./deterministic-source-snapshot.mjs";
import { createFlatpakSourceSnapshot } from "./flatpak-source-snapshots.mjs";
import { buildSoxr, createSoxrCorrespondingSources, soxrCorrespondingSourcesFileName,
  validateSoxrOutput } from "./build-soxr-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const producerInputs = [
  "scripts/build-soxr-runtime.mjs", "scripts/deterministic-source-snapshot.mjs",
  "packaging/soxr/sources.lock.json", "packaging/soxr/patches/android-unversioned-soname.patch",
];

function temporary(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-soxr-runtime-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function copyInputs(directory) {
  for (const relative of [...producerInputs, "THIRD_PARTY_NOTICES.md"]) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
}

function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("neutral TAR preserves legacy bytes, modes, links, ordering, and explicit epochs", (context) => {
  const directory = temporary(context);
  fs.mkdirSync(path.join(directory, "input/empty"), { recursive: true });
  for (const name of ["é", "e\u0301", "a"]) fs.writeFileSync(path.join(directory, "input", name), name);
  fs.chmodSync(path.join(directory, "input/a"), 0o755);
  fs.symlinkSync("a", path.join(directory, "input/link"));
  const legacy = path.join(directory, "legacy.tar");
  const neutral = path.join(directory, "neutral.tar");
  const options = { root: directory, inputs: [{ source: "input" }] };
  createFlatpakSourceSnapshot({ ...options, outputPath: legacy, sourceDateEpoch: "123" });
  createDeterministicSourceSnapshot({ ...options, outputPath: neutral, epoch: 123 });
  const expected = fs.readFileSync(legacy);
  assert.deepEqual(fs.readFileSync(neutral), expected);
  fs.utimesSync(path.join(directory, "input/a"), new Date(0), new Date(0));
  createDeterministicSourceSnapshot({ ...options, outputPath: neutral, epoch: 123 });
  assert.deepEqual(fs.readFileSync(neutral), expected);
  createDeterministicSourceSnapshot({ ...options, outputPath: neutral, epoch: 0 });
  assert.notDeepEqual(fs.readFileSync(neutral), expected);
  for (const epoch of [undefined, -1, 1.5]) {
    assert.throws(() => createDeterministicSourceSnapshot({ ...options, outputPath: neutral, epoch }),
      /epoch must be a non-negative integer/);
  }
  assert.throws(() => createDeterministicSourceSnapshot({ ...options, outputPath: neutral, epoch: 1,
    inputs: [{ source: "input", destination: "../escape" }] }), /Unsafe snapshot path/);
  assert.throws(() => createDeterministicSourceSnapshot({ ...options, outputPath: neutral, epoch: 1,
    inputs: [{ source: "input" }, { source: "input" }] }), /Duplicate snapshot path/);
});

test("new entrypoint imports without a build and exports its runner and legacy helpers", async (context) => {
  const directory = temporary(context);
  const entrypoint = path.join(root, "scripts/build-soxr-runtime.mjs");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(pathToFileURL(entrypoint).href)})`], { cwd: directory, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(typeof validateSoxrOutput, "function");
  assert.equal(typeof soxrCorrespondingSourcesFileName, "function");
  await assert.rejects(buildSoxr(["--target", "unsupported"]), /--target must be android-arm64-v8a or host-test/);
  await assert.rejects(buildSoxr(["--", "--unknown"]), /Unknown option: --unknown/);
  const direct = spawnSync(process.execPath, [entrypoint, "--target", "unsupported"], { encoding: "utf8" });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /--target must be android-arm64-v8a or host-test/);
});

test("corresponding-source TAR is complete, reproducible, and imports its copied rebuild entrypoint", async (context) => {
  const directory = temporary(context);
  const upstream = path.join(directory, "upstream.tar.gz");
  // Synthetic bytes exercise packaging without downloading or compiling a runtime.
  fs.writeFileSync(upstream, "synthetic upstream archive fixture\n");
  for (const target of ["host-test", "android-arm64-v8a"]) {
    const bundle = createSoxrCorrespondingSources(upstream, directory, target);
    const archive = path.join(directory, bundle.fileName);
    const first = fs.readFileSync(archive);
    assert.deepEqual(createSoxrCorrespondingSources(upstream, directory, target), bundle);
    assert.deepEqual(fs.readFileSync(archive), first);
    const extracted = path.join(directory, target);
    fs.mkdirSync(extracted);
    tar(["-xf", archive, "-C", extracted]);
    const payload = path.join(extracted, "TuneForge-soxr-a66f3eee-sources");
    const members = tar(["-tf", archive]).split("\n").filter((member) => member && !member.endsWith("/"))
      .map((member) => member.split("/").slice(1).join("/")).sort();
    assert.deepEqual(members, [...producerInputs, "packaging/soxr/cache/soxr-a66f3eee.tar.gz",
      "README-CORRESPONDING-SOURCES.md", ...(target === "android-arm64-v8a" ? ["THIRD_PARTY_NOTICES.md"] : [])].sort());
    for (const relative of producerInputs) assert.deepEqual(fs.readFileSync(path.join(payload, relative)),
      fs.readFileSync(path.join(root, relative)));
    assert.deepEqual(fs.readFileSync(path.join(payload, "packaging/soxr/cache/soxr-a66f3eee.tar.gz")),
      fs.readFileSync(upstream));
    const readme = fs.readFileSync(path.join(payload, "README-CORRESPONDING-SOURCES.md"), "utf8");
    assert.ok(readme.includes(`node scripts/build-soxr-runtime.mjs --target ${target}`));
    assert.doesNotMatch(readme, /scripts\/build-soxr\.mjs/);
    const copied = await import(pathToFileURL(path.join(payload, "scripts/build-soxr-runtime.mjs")));
    await assert.rejects(copied.buildSoxr(["--target", "unsupported"]), /--target must be/);
    assert.equal(copied.soxrCorrespondingSourcesFileName(target), bundle.fileName);
  }
});

test("producer identity and publication include genuine inputs and exclude Flatpak policy", async (context) => {
  const directory = temporary(context);
  copyInputs(directory);
  const recipe = await import(pathToFileURL(path.join(directory, "scripts/build-soxr-runtime.mjs")));
  const original = recipe.soxrCorrespondingSourcesFileName("host-test");
  const dockerfile = fs.readFileSync(path.join(root, ".github/ci/Dockerfile"), "utf8");
  const manifest = dockerfile.match(/    sha256sum \\\n([\s\S]*?)      > \/opt\/tuneforge-ci\/soxr\/build-inputs\.sha256/)[1]
    .split("\n").map((line) => line.trim().replace(/ \\$/, "")).filter(Boolean);
  assert.deepEqual(manifest, producerInputs);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci-image.yml"), "utf8");
  const paths = workflow.match(/    paths:\n([\s\S]*?)  workflow_dispatch:/)[1]
    .split("\n").map((line) => line.trim().replace(/^- /, "")).filter(Boolean);
  const publishes = (relative) => paths.some((pattern) => pattern.endsWith("/**")
    ? relative.startsWith(pattern.slice(0, -2)) : relative === pattern);
  const allowlist = fs.readFileSync(path.join(root, ".github/ci/Dockerfile.dockerignore"), "utf8")
    .split("\n").filter((line) => line.startsWith("!") && !line.endsWith("/"))
    .map((line) => line.slice(1));
  assert.deepEqual(allowlist.sort(), [...producerInputs, ".github/ci/README.md"].sort());
  for (const relative of producerInputs) {
    const destination = path.join(directory, relative);
    const originalBytes = fs.readFileSync(destination);
    fs.appendFileSync(destination, "\n");
    assert.notEqual(recipe.soxrCorrespondingSourcesFileName("host-test"), original, relative);
    assert.ok(publishes(relative), `${relative} must publish`);
    fs.writeFileSync(destination, originalBytes);
  }
  const excludedMutations = [
    ["scripts/build-soxr.mjs", "async function main(argv)", "async function legacyMain(argv)"],
    ["scripts/flatpak-source-snapshots.mjs", '"package.json"', '"new-frontend-policy.json"'],
    ["scripts/generate-flatpak-sources.mjs", "return process.env.SOURCE_DATE_EPOCH;", 'return "999";'],
    ["scripts/package-flatpak.mjs", '"flatpak-cache-v1"', '"flatpak-cache-v2"'],
  ];
  for (const [relative, before, after] of excludedMutations) {
    const destination = path.join(directory, relative);
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.ok(source.includes(before), `${relative} must contain its policy fixture target`);
    fs.writeFileSync(destination, source.replaceAll(before, after));
    assert.equal(recipe.soxrCorrespondingSourcesFileName("host-test"), original, relative);
    assert.equal(publishes(relative), false, `${relative} must not publish`);
    assert.equal(allowlist.includes(relative), false);
  }
  const android = recipe.soxrCorrespondingSourcesFileName("android-arm64-v8a");
  fs.appendFileSync(path.join(directory, "THIRD_PARTY_NOTICES.md"), "\n");
  assert.equal(recipe.soxrCorrespondingSourcesFileName("host-test"), original);
  assert.notEqual(recipe.soxrCorrespondingSourcesFileName("android-arm64-v8a"), android);
  assert.equal(publishes("THIRD_PARTY_NOTICES.md"), false);
});
