import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { checkImageInputs, imageInventory, imageImpact, producerIdentity } from "./ci-image-impact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ci-image-impact-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const input of imageInventory(root).inputs) {
    fs.mkdirSync(path.dirname(path.join(directory, input)), { recursive: true });
    fs.copyFileSync(path.join(root, input), path.join(directory, input));
  }
  return directory;
}

test("repository inventory closes Docker, imports, reads and lock patch dependencies", () => {
  assert.ok(checkImageInputs(root).inputs.includes(".github/ci/README.md"));
});

test("planned paths distinguish producers from publisher/consumer and ordinary app changes", () => {
  const paths = ["scripts/build-soxr-runtime.mjs", ".github/ci/README.md", ".github/workflows/ci-image.yml",
    "apps/desktop/package.json", ".github/ci/promoted-image.json", "scripts/build-ffmpeg.mjs",
    "scripts/flatpak-source-snapshots.mjs", "apps/backend/app/config.py"];
  const impacts = imageImpact(paths, root);
  assert.deepEqual(impacts.map((impact) => impact.classification), ["producer", "producer",
    "publishing-process", "consumer-compatibility", "consumer-compatibility",
    "no known image impact", "no known image impact", "no known image impact"]);
  assert.deepEqual(impacts[0].components, ["SoXR and PFFFT"]);
  assert.match(impacts[0].chain, /final image -> backend\/desktop_tauri\/e2e/);
});

test("equivalent planned path spelling cannot miss producer impact", () => {
  const impacts = imageImpact(["./scripts/build-soxr-runtime.mjs", "scripts//build-soxr-runtime.mjs",
    "./.github//ci/Dockerfile"], root);
  assert.deepEqual(impacts.map((impact) => impact.classification), ["producer", "producer", "producer"]);
  assert.deepEqual(impacts.map((impact) => impact.path), ["scripts/build-soxr-runtime.mjs",
    "scripts/build-soxr-runtime.mjs", ".github/ci/Dockerfile"]);
  assert.throws(() => imageImpact(["scripts/../scripts/build-soxr-runtime.mjs"], root), /Unsafe planned/);
  assert.equal(imageImpact([".python-version"], root)[0].classification, "consumer-compatibility");
});

test("every registered producer byte changes whole recipe identity; promotion does not", (context) => {
  const directory = fixture(context);
  const before = producerIdentity(directory);
  assert.match(before.fingerprint, /^[a-f0-9]{64}$/);
  for (const input of [".github/ci/Dockerfile", ".github/ci/README.md"]) {
    const original = fs.readFileSync(path.join(directory, input));
    fs.appendFileSync(path.join(directory, input), "\n# changed\n");
    assert.notEqual(producerIdentity(directory).fingerprint, before.fingerprint, input);
    fs.writeFileSync(path.join(directory, input), original);
  }
  fs.writeFileSync(path.join(directory, ".github/ci/promoted-image.json"), '{"digest":"changed"}');
  assert.equal(producerIdentity(directory).fingerprint, before.fingerprint);
});

for (const [label, file, content, expected] of [
  ["Docker COPY", ".github/ci/Dockerfile", "\nCOPY secret.txt /tmp/secret\n", /Unregistered Docker COPY input/],
  ["Docker ADD", ".github/ci/Dockerfile", "\nADD https://example.invalid/payload /tmp/\n", /Unregistered Docker ADD/],
  ["lowercase COPY", ".github/ci/Dockerfile", "\n  copy secret.txt /tmp/secret\n", /Unregistered Docker COPY input/],
  ["lowercase ADD", ".github/ci/Dockerfile", "\nadd https://example.invalid/payload /tmp/\n", /Unregistered Docker ADD/],
  ["RUN context bind", ".github/ci/Dockerfile", "\nrun --mount=type=bind,source=secret.txt,target=/tmp/secret cat /tmp/secret\n", /Unsupported Docker RUN --mount/],
  ["RUN default bind", ".github/ci/Dockerfile", "\nRUN --network=none --mount=source=secret.txt,target=/tmp/secret cat /tmp/secret\n", /Unsupported Docker RUN --mount/],
  ["Docker context", ".github/ci/Dockerfile.dockerignore", "!package.json\n", /Unregistered Docker context/],
  ["local import", "scripts/build-soxr-runtime.mjs", '\nimport "./new-dependency.mjs";\n', /Unregistered local\/external import/],
  ["dynamic import", "scripts/build-soxr-runtime.mjs", '\nimport(variable);\n', /Unsupported dynamic import/],
  ["dynamic read", "scripts/build-soxr-runtime.mjs", '\nfs.readFileSync(variable);\n', /Read dependency audit required/],
  ["literal read", "scripts/build-soxr-runtime.mjs", '\nfs.readFileSync("packaging/new.lock.json");\n', /Unregistered repository read/],
]) {
  test(`unknown ${label} fails with registration action`, (context) => {
    const directory = fixture(context);
    fs.appendFileSync(path.join(directory, file), content);
    assert.throws(() => checkImageInputs(directory), expected);
  });
}

test("lock patch reference/checksum drift fails", (context) => {
  const directory = fixture(context);
  const file = path.join(directory, "packaging/soxr/sources.lock.json");
  const lock = JSON.parse(fs.readFileSync(file));
  lock.patch.path = "packaging/soxr/new.patch";
  fs.writeFileSync(file, JSON.stringify(lock));
  assert.throws(() => checkImageInputs(directory), /Unregistered lock patch/);
  lock.patch.path = "packaging/soxr/patches/android-unversioned-soname.patch";
  lock.patch.sha256 = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(lock));
  assert.throws(() => checkImageInputs(directory), /Lock patch checksum drift/);
});

test("registered internal stages support new components while external stages fail", (context) => {
  const directory = fixture(context);
  const file = path.join(directory, ".github/ci/Dockerfile");
  fs.appendFileSync(file, "\nFROM ubuntu:24.04 AS new-component\nCOPY --from=new-component /payload /payload\n");
  assert.doesNotThrow(() => checkImageInputs(directory));
  fs.appendFileSync(file, "COPY --from=external-registry/image /payload /payload\n");
  assert.throws(() => checkImageInputs(directory), /Unregistered\/external Docker stage/);
});

test("missing input and symlink input fail", (context) => {
  const directory = fixture(context);
  const file = path.join(directory, ".github/ci/README.md");
  fs.unlinkSync(file);
  assert.throws(() => checkImageInputs(directory), /ENOENT/);
  fs.symlinkSync("Dockerfile", file);
  assert.throws(() => checkImageInputs(directory), /regular file/);
});

function gitFixture(context) {
  const directory = fixture(context);
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const key = path.join(directory, ".fixture-signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  git("init", "--quiet");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci-fixture@example.invalid");
  git("config", "gpg.format", "ssh");
  git("config", "user.signingkey", key);
  git("config", "commit.gpgsign", "true");
  fs.writeFileSync(path.join(directory, ".gitignore"), ".fixture-signing-key*\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture base");
  const base = git("rev-parse", "HEAD");
  fs.appendFileSync(path.join(directory, ".github/ci/README.md"), "\nfixture producer change\n");
  git("add", ".github/ci/README.md");
  git("commit", "--quiet", "-m", "fixture producer");
  return { directory, git, base, script: path.join(directory, "scripts/ci-image-impact.mjs") };
}

test("actual diff mode reports committed producer paths and rejects missing commits", (context) => {
  const { script, base } = gitFixture(context);
  const result = spawnSync(process.execPath, [script, "--diff", base, "HEAD"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).impacts.map(({ path: input, classification }) => [input, classification]),
    [[".github/ci/README.md", "producer"]]);
  const missing = spawnSync(process.execPath, [script, "--diff", "missing-ci-base", "HEAD"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing-ci-base/);
});

test("working-tree mode includes committed, staged, unstaged and untracked paths without remote refs", (context) => {
  const { directory, git, base, script } = gitFixture(context);
  fs.appendFileSync(path.join(directory, ".github/ci/README.md"), "staged producer change\n");
  git("add", ".github/ci/README.md");
  fs.appendFileSync(path.join(directory, ".github/ci/Dockerfile"), "\n# unstaged producer change\n");
  fs.writeFileSync(path.join(directory, "new-input.txt"), "untracked");
  const result = spawnSync(process.execPath, [script, "--working-tree", base], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const impacts = JSON.parse(result.stdout).impacts;
  assert.deepEqual(impacts.map(({ path: input, classification }) => [input, classification]).sort(), [
    [".github/ci/Dockerfile", "producer"], [".github/ci/README.md", "producer"], ["new-input.txt", "no known image impact"],
  ]);
});
