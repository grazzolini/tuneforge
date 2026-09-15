import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(repositoryRoot, "scripts/verify-ci-image.sh");
const buildInputs = [
  "scripts/build-soxr.mjs",
  "scripts/flatpak-source-snapshots.mjs",
  "packaging/soxr/sources.lock.json",
  "packaging/soxr/patches/android-unversioned-soname.patch",
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? files(candidate) : [candidate];
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-ci-image-verifier-"));
  const workspace = path.join(root, "workspace");
  const soxr = path.join(root, "soxr");
  const runtime = path.join(soxr, "host-test");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(runtime, "include"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "lib"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const relative of buildInputs) {
    const destination = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${relative}\n`);
  }
  fs.writeFileSync(path.join(runtime, "include/soxr.h"), "header\n");
  fs.writeFileSync(path.join(runtime, "lib/libsoxr.so"), "library\n");
  fs.writeFileSync(path.join(runtime, "provenance.json"),
    `${JSON.stringify({ cmake: ["-DWITH_PFFFT=ON"] }, null, 2)}\n`);
  fs.writeFileSync(path.join(soxr, "build-inputs.sha256"), buildInputs
    .map((relative) => `${sha256(path.join(workspace, relative))}  ${relative}`)
    .join("\n") + "\n");
  const payload = files(soxr)
    .map((file) => `${sha256(file)}  ./${path.relative(soxr, file).split(path.sep).join("/")}`)
    .sort()
    .join("\n") + "\n";
  fs.writeFileSync(path.join(soxr, "payload.sha256"), payload);
  for (const name of ["ffmpeg", "ffprobe"]) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, `#!/usr/bin/env bash\necho '${name} test version'\n`);
    fs.chmodSync(executable, 0o755);
  }
  const summary = path.join(root, "summary.md");
  return { root, workspace, soxr, runtime, bin, summary };
}

function run(value) {
  const ffmpeg = path.join(value.bin, "ffmpeg");
  const ffprobe = path.join(value.bin, "ffprobe");
  return spawnSync("bash", [verifier], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.bin}:${process.env.PATH}`,
      CI_IMAGE_REFERENCE: "ghcr.io/grazzolini/tuneforge-ci@sha256:test",
      GITHUB_JOB: "desktop_tauri",
      GITHUB_STEP_SUMMARY: value.summary,
      GITHUB_WORKSPACE: value.workspace,
      TUNEFORGE_CI_SOXR_ROOT: value.soxr,
      TUNEFORGE_CI_EXPECTED_FFMPEG_PATH: ffmpeg,
      TUNEFORGE_CI_EXPECTED_FFPROBE_PATH: ffprobe,
    },
  });
}

test("CI image verifier accepts matching SoXR payload and checkout inputs", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const result = run(value);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(value.summary, "utf8"), /verified payload and build inputs/);
});

test("CI image verifier ignores repository-wide notice changes", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(value.workspace, "THIRD_PARTY_NOTICES.md"), "changed\n");

  const result = run(value);
  assert.equal(result.status, 0, result.stderr);
});

test("CI image verifier rejects missing, corrupt, and stale SoXR state", () => {
  const cases = [
    ["missing", (value) => fs.rmSync(path.join(value.soxr, "payload.sha256")), /missing the prebuilt SoXR payload/],
    ["corrupt", (value) => fs.appendFileSync(path.join(value.runtime, "lib/libsoxr.so"), "corrupt"), /failed integrity verification/],
    ["stale", (value) => fs.appendFileSync(path.join(value.workspace, buildInputs[0]), "stale"), /build inputs do not match/],
  ];
  for (const [label, mutate, expected] of cases) {
    const value = fixture();
    try {
      mutate(value);
      const result = run(value);
      assert.notEqual(result.status, 0, `${label} fixture unexpectedly passed`);
      assert.match(result.stderr, expected);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  }
});
