import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { checkImageInputs, imageInventory, imageImpact, producerIdentity, writeImageContext } from "./ci-image-impact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture(context) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ci-image-impact-")));
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
  ["Docker context", ".github/ci/Dockerfile.dockerignore", "!package.json\n", /Generated Docker context allowlist.*--write-context/],
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

test("music-core complete source snapshot rejects unregistered files while excluding build caches", context => {
  const directory = fixture(context);
  const core = path.join(directory, "packages/music-core");
  for (const ignored of ["build/generated.mjs", "vendor/gingo-src/download.cpp", "cache/tool.whl"]) {
    fs.mkdirSync(path.dirname(path.join(core, ignored)), { recursive: true });
    fs.writeFileSync(path.join(core, ignored), "ignored");
  }
  const before = producerIdentity(directory).fingerprint;
  fs.writeFileSync(path.join(core, "new-source.cpp"), "new source");
  assert.throws(() => checkImageInputs(directory), /Unregistered source snapshot input/);
  fs.unlinkSync(path.join(core, "new-source.cpp"));
  assert.equal(producerIdentity(directory).fingerprint, before);
  const data = path.join(core, "resources/instruments-v1.json");
  fs.appendFileSync(data, " ");
  assert.notEqual(producerIdentity(directory).fingerprint, before);
});

const producerProbeScripts = [
  "packages/music-core/test/artifact-metadata.mjs", "packages/music-core/test/wasm-boundary.mjs",
  "packages/music-core/test/runtime-parity.mjs", "packages/music-core/test/parity.mjs",
  "packages/music-core/test/normalization.mjs", "packages/music-core/test/runtime-driver.mjs",
  "packages/music-core/bindings/wasm/index.mjs",
];
test("executed music-core probe closure retains read/checksum audits", () => {
  const inventory = imageInventory(root);
  for (const input of producerProbeScripts) {
    assert.ok(!inventory.snapshotOnlyInputs.includes(input), input);
    assert.ok(inventory.registeredReads[input], input);
    assert.match(inventory.readAuditSha256[input], /^[a-f0-9]{64}$/, input);
  }
});
for (const [label, mutate, expected] of [
  ["missing generated import", inventory => delete inventory.generatedImports["packages/music-core/test/wasm-boundary.mjs"], /Unregistered local.external import/],
  ["missing dynamic import", inventory => delete inventory.dynamicImports["packages/music-core/bindings/wasm/index.mjs"], /Unsupported dynamic import/],
  ["unknown generated target", inventory => inventory.generatedImports["packages/music-core/test/wasm-boundary.mjs"].push("../build/unregistered.mjs"), /Unregistered generated import target/],
  ["unknown dynamic target", inventory => inventory.dynamicImports["packages/music-core/bindings/wasm/index.mjs"].targets.push("packages/music-core/build/unregistered.mjs"), /Unregistered dynamic import target/],
  ["unknown generated producer", inventory => Object.values(inventory.generatedModules)[0].producer = "scripts/unregistered.mjs", /Invalid generated module declaration/],
  ["snapshot-masked executable", inventory => inventory.snapshotOnlyInputs.push("packages/music-core/test/runtime-driver.mjs"), /Invalid snapshot-only JavaScript input/],
]) test("music-core audit rejects " + label, context => {
  const directory = fixture(context);
  const file = path.join(directory, ".github/ci/image-inputs.json");
  const inventory = JSON.parse(fs.readFileSync(file));
  mutate(inventory);
  fs.writeFileSync(file, JSON.stringify(inventory));
  assert.throws(() => checkImageInputs(directory), expected);
});
for (const [label, input, addition, expected] of [
  ["extra dynamic expression", "packages/music-core/bindings/wasm/index.mjs", "\nimport(unregistered);\n", /Unsupported dynamic import/],
  ["unregistered generated import", "packages/music-core/test/wasm-boundary.mjs", '\nimport "../build/unregistered.mjs";\n', /Unregistered local.external import/],
  ["changed audited probe read", "packages/music-core/test/runtime-driver.mjs", "\nfs.readFileSync(variable);\n", /Read dependency audit required/],
]) test("music-core probe code rejects " + label, context => {
  const directory = fixture(context);
  fs.appendFileSync(path.join(directory, input), addition);
  assert.throws(() => checkImageInputs(directory), expected);
});

for (const mutation of ["missing", "extra file", "parent directory", "removed file", "reordered"]) {
  test("generated context rejects " + mutation + " and regeneration repairs it", context => {
    const directory = fixture(context);
    const file = path.join(directory, ".github/ci/Dockerfile.dockerignore");
    const before = fs.readFileSync(file, "utf8");
    if (mutation === "missing") fs.unlinkSync(file);
    else if (mutation === "extra file") fs.appendFileSync(file, "!unregistered.txt\n");
    else if (mutation === "parent directory") fs.appendFileSync(file, "!packages/\n");
    else if (mutation === "removed file") fs.writeFileSync(file, before.replace("!packages/music-core/LICENSE\n", ""));
    else fs.writeFileSync(file, before.split("\n").reverse().join("\n"));
    for (const check of [checkImageInputs, producerIdentity]) assert.throws(() => check(directory),
      /Generated Docker context allowlist.*pnpm ci:image:impact --write-context/);
    const script = path.join(directory, "scripts/ci-image-impact.mjs");
    for (const mode of ["--check", "--fingerprint", "--manifest"]) {
      const result = spawnSync(process.execPath, [script, mode], { encoding: "utf8" });
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, /pnpm ci:image:impact --write-context/);
    }
    const result = spawnSync(process.execPath, [script, "--write-context"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(writeImageContext(directory), before);
    assert.doesNotThrow(() => checkImageInputs(directory));
  });
}

test("context generation derives sorted exact files from the canonical inventory", context => {
  const directory = fixture(context);
  const file = path.join(directory, ".github/ci/image-inputs.json");
  const inventory = JSON.parse(fs.readFileSync(file));
  inventory.components[0].inputs.push("scripts/new-input.txt");
  fs.writeFileSync(file, JSON.stringify(inventory));
  fs.writeFileSync(path.join(directory, "scripts/new-input.txt"), "new registered bytes");
  assert.throws(() => checkImageInputs(directory), /Generated Docker context allowlist/);
  const generated = writeImageContext(directory);
  assert.deepEqual(generated.trimEnd().split("\n").slice(2), imageInventory(directory).inputs.map(input => "!" + input));
  assert.ok(!generated.split("\n").some(line => line.endsWith("/")));
  assert.doesNotThrow(() => checkImageInputs(directory));
  assert.deepEqual(producerIdentity(directory).manifest.trimEnd().split("\n").map(line => line.slice(66)),
    imageInventory(directory).inputs);
});

test("directory COPY accepts registered descendants and filters unrelated directory files", context => {
  const directory = fixture(context);
  fs.writeFileSync(path.join(directory, "scripts/unregistered.txt"), "excluded by exact allowlist");
  fs.appendFileSync(path.join(directory, ".github/ci/Dockerfile"), "\nCOPY scripts/ /payload/\nCOPY packages/music-core /core/\n");
  assert.doesNotThrow(() => checkImageInputs(directory));
  assert.ok(!writeImageContext(directory).includes("!scripts/unregistered.txt"));
});

for (const [source, expected] of [
  ["unknown/", /Unregistered Docker COPY/], [".", /Unregistered Docker COPY/],
  ["./", /Unregistered Docker COPY/], ["/", /Unregistered Docker COPY/],
  ["scripts/../scripts/", /Unregistered Docker COPY/], ["./scripts/", /Unregistered Docker COPY/],
  ["scripts//", /Unregistered Docker COPY/], ["scripts/*", /Unregistered Docker COPY/],
  ["--chown=1000 scripts/", /Unsupported Docker COPY form/],
  ['["scripts/",', /Unsupported Docker COPY form/],
  ["--from=music-core-builder --chown=1000", /Unsupported Docker COPY stage form/],
]) test("unsupported COPY source/form fails: " + source, context => {
  const directory = fixture(context);
  fs.appendFileSync(path.join(directory, ".github/ci/Dockerfile"), "\nCOPY " + source + " /payload/\n");
  assert.throws(() => checkImageInputs(directory), expected);
});

test("registered input with a symlink ancestor fails even when its bytes are unchanged", context => {
  const directory = fixture(context);
  fs.renameSync(path.join(directory, "scripts"), path.join(directory, "actual-scripts"));
  fs.symlinkSync("actual-scripts", path.join(directory, "scripts"));
  assert.throws(() => checkImageInputs(directory), /without symlinks/);
});

test("context generation cannot bless a changed producer read audit", context => {
  const directory = fixture(context);
  const inventoryFile = path.join(directory, ".github/ci/image-inputs.json");
  const before = fs.readFileSync(inventoryFile, "utf8");
  fs.appendFileSync(path.join(directory, "scripts/build-soxr-runtime.mjs"), "\nfs.readFileSync(variable);\n");
  fs.unlinkSync(path.join(directory, ".github/ci/Dockerfile.dockerignore"));
  assert.doesNotThrow(() => writeImageContext(directory));
  assert.equal(fs.readFileSync(inventoryFile, "utf8"), before);
  assert.throws(() => checkImageInputs(directory), /Read dependency audit required/);
});

test("internal stage COPY rejects traversal", context => {
  const directory = fixture(context);
  fs.appendFileSync(path.join(directory, ".github/ci/Dockerfile"),
    "\nCOPY --from=music-core-builder /payload/../elsewhere /payload\n");
  assert.throws(() => checkImageInputs(directory), /Unsupported Docker COPY stage form/);
});
