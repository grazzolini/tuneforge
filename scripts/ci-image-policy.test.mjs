import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./build-soxr-runtime.test.mjs";
import "./ci-image-impact.test.mjs";
import "./ci-image-run.test.mjs";

import { imageInventory } from "./ci-image-impact.mjs";
import { validateCiImagePolicy } from "./ci-image-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciImageReference = 'ghcr.io/grazzolini/tuneforge-ci@' + JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.github/ci/promoted-image.json'))).digest;
const fixtureFiles = [
  "apps/desktop/package.json",
  "pnpm-lock.yaml",
  ".github/ci/Dockerfile",
  ".github/ci/Dockerfile.dockerignore",
  ".github/ci/README.md",
  ".github/workflows/ci-image.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/pages.yml",
  ".github/dependabot.yml",
  "scripts/build-soxr-runtime.mjs",
  "scripts/deterministic-source-snapshot.mjs",
  "scripts/verify-ci-image.sh",
  "scripts/ci-image-run.sh",
  ".github/ci/promoted-image.json",
  ".github/ci/image-inputs.json",
  "scripts/ci-image-impact.mjs",
  "packaging/soxr/sources.lock.json",
  "packaging/soxr/patches/android-unversioned-soname.patch",
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-ci-image-policy-"));
  for (const relativePath of new Set([...fixtureFiles, ...imageInventory(repositoryRoot).inputs])) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), destination);
  }
  return root;
}

function replace(root, relativePath, before, after) {
  const target = path.join(root, relativePath);
  const original = fs.readFileSync(target, "utf8");
  assert.ok(original.includes(before), `${relativePath} fixture must include replacement target`);
  fs.writeFileSync(target, original.replaceAll(before, after));
}

function assertMutationsFail(relativePath, mutations, expected) {
  for (const [before, after] of mutations) {
    const root = fixture();
    try {
      replace(root, relativePath, before, after);
      assert.throws(() => validateCiImagePolicy(root), expected);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

test("repository satisfies CI image policy", () => {
  assert.deepEqual(validateCiImagePolicy(repositoryRoot), {
    playwrightVersion: "1.62.1",
    image: "ghcr.io/grazzolini/tuneforge-ci",
  });
});

test("Playwright drift requires an image dependency review", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, "apps/desktop/package.json", "^1.62.1", "^1.63.0");
  replace(root, "pnpm-lock.yaml", "1.62.1", "1.63.0");

  assert.throws(() => validateCiImagePolicy(root), /PLAYWRIGHT_VERSION must be reviewed/);
});

test("Playwright dependency review requires the exact Noble package set", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/ci/Dockerfile", "libxkbcommon0 libxrandr2", "libxkbcommon0");

  assert.throws(() => validateCiImagePolicy(root), /exact reviewed Playwright 1\.62\.1 Noble/);
});

test("Rust bindgen requires libclang-dev in the CI image", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/ci/Dockerfile", "      libclang-dev \\\n", "");

  assert.throws(() => validateCiImagePolicy(root), /libclang-dev for Rust bindgen/);
});

test("SoXR builder stages, payload checks, and restricted context fail closed", () =>
  assertMutationsFail(".github/ci/Dockerfile", [
    ["FROM ubuntu:24.04@", "FROM --platform=linux/amd64 ubuntu:24.04@"],
    [" AS soxr-builder", " AS unreviewed-builder"],
    ['grep -F \'"-DWITH_PFFFT=ON"\'', "grep -F 'disabled'"],
    ["COPY --from=soxr-builder /opt/tuneforge-ci/soxr /opt/tuneforge-ci/soxr", "COPY . /workspace"],
  ], /same pinned Ubuntu base without constant FROM platform flags|must verify SoXR|must build pinned host SoXR|Unregistered Docker COPY/));

test("SoXR image context rejects additional checkout files", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, ".github/ci/Dockerfile.dockerignore");
  fs.appendFileSync(target, "!package.json\n");
  assert.throws(() => validateCiImagePolicy(root), /Generated Docker context allowlist.*--write-context/);
});

test("SoXR build-input manifest requires every reviewed input", () =>
  assertMutationsFail(".github/ci/Dockerfile", [
    ["      scripts/build-soxr-runtime.mjs \\\n", ""],
    ["      scripts/deterministic-source-snapshot.mjs \\\n", ""],
    ["      packaging/soxr/sources.lock.json \\\n", ""],
    ["      packaging/soxr/patches/android-unversioned-soname.patch \\\n", ""],
  ], /build-input manifest must hash the exact reviewed recipe, helper, lock, and patch/));

test("SoXR host recipe and corresponding sources exclude repository-wide notices", () =>
  assertMutationsFail("scripts/build-soxr-runtime.mjs", [
    [', "scripts/deterministic-source-snapshot.mjs"];', "];"],
    [
      '...(target === "android-arm64-v8a" ? ["THIRD_PARTY_NOTICES.md"] : [])',
      '"THIRD_PARTY_NOTICES.md"',
    ],
    [
      'if (target === "android-arm64-v8a") correspondingSourceFiles.push("THIRD_PARTY_NOTICES.md");',
      'correspondingSourceFiles.push("THIRD_PARTY_NOTICES.md");',
    ],
    [
      "const correspondingSourceFiles = [lock.patch.path,",
      'const correspondingSourceFiles = ["THIRD_PARTY_NOTICES.md", lock.patch.path,',
    ],
    ['"node scripts/build-soxr-runtime.mjs --target host-test"', '"node scripts/build-soxr-runtime.mjs --target android-arm64-v8a"'],
  ], /host corresponding sources must include/));

test("untrusted and broad publisher triggers fail closed", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/workflows/ci-image.yml", "on:\n  push:", "on:\n  pull_request:\n  push:");
  replace(
    root,
    ".github/workflows/ci-image.yml",
    "      - .github/workflows/ci-image.yml",
    "      - .github/workflows/ci-image.yml\n      - pnpm-lock.yaml",
  );

  assert.throws(
    () => validateCiImagePolicy(root),
    /events must be exactly push and workflow_dispatch[\s\S]*must publish only for trusted main image inputs[\s\S]*must not publish the CI image/,
  );
});

test("repository-wide notices do not trigger CI image publication", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(
    root,
    ".github/workflows/ci-image.yml",
    "      - scripts/deterministic-source-snapshot.mjs\n",
    "      - scripts/deterministic-source-snapshot.mjs\n      - THIRD_PARTY_NOTICES.md\n",
  );

  assert.throws(
    () => validateCiImagePolicy(root),
    /must publish only for trusted main image inputs/,
  );
});

test("publisher rejects every additional workflow event", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(
    root,
    ".github/workflows/ci-image.yml",
    "  workflow_dispatch:\n",
    "  workflow_dispatch:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n",
  );

  assert.throws(() => validateCiImagePolicy(root), /events must be exactly push and workflow_dispatch/);
});

test("publisher rejects a quoted additional workflow event", () => {
  for (const key of ["'pull_request_target'", '"pull_request_target"']) {
    const root = fixture();
    try {
      replace(root, ".github/workflows/ci-image.yml", "  workflow_dispatch:\n", `  workflow_dispatch:\n  ${key}:\n`);
      assert.throws(
        () => validateCiImagePolicy(root),
        /events must be exactly push and workflow_dispatch/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("publisher tag is unique per run attempt", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(
    root,
    ".github/workflows/ci-image.yml",
    "sha-${{ github.sha }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    "sha-${{ github.sha }}",
  );

  assert.throws(() => validateCiImagePolicy(root), /unique commit\/run\/attempt tag/);
});

test("publisher uses repository context without an Actions Docker cache", () =>
  assertMutationsFail(".github/workflows/ci-image.yml", [
    ["          context: .\n", "          context: .github/ci\n"],
    ["          no-cache: true\n", "          no-cache: true\n          cache-to: type=gha,mode=max\n"],
  ], /restricted repository-root build context|must not consume Actions cache storage/));

test("FFmpeg package checksum verification precedes installation", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/ci/Dockerfile", "| sha256sum -c -;", "| cat; ");

  assert.throws(() => validateCiImagePolicy(root), /checksum-verified, then installed/);
});

test("central promoted record rejects mutable or malformed identity", () => {
  for (const changes of [{ digest: "main" }, { producerFingerprint: "bad" },
    { producerFingerprint: "0".repeat(64), sourceRevision: null },
    { producerFingerprint: null, sourceRevision: "1".repeat(40) }]) {
    const root = fixture();
    try {
      const recordPath = path.join(root, ".github/ci/promoted-image.json");
      const record = JSON.parse(fs.readFileSync(recordPath));
      fs.writeFileSync(recordPath, JSON.stringify({ ...record, ...changes }));
      assert.throws(() => validateCiImagePolicy(root), /Promoted image must have/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("CI image consumers reject container credentials", () =>
  assertMutationsFail(".github/workflows/ci.yml", [["  backend:\n", "  backend:\n    container: { image: arbitrary, credentials: { password: token } }\n"]], /must run on the host/));

test("CI image consumers reject every valid packages write permission form", () => {
  const permissions = [
    "    permissions:\n      packages: write", '    permissions:\n      packages: "write"',
    "    permissions:\n      packages: 'write'", "    permissions: { contents: read, packages: write }",
    "    permissions: write-all", '    permissions: "write-all"', "    permissions: 'write-all'",
  ];
  assertMutationsFail(
    ".github/workflows/ci.yml",
    permissions.map((value) => ["  backend:\n    needs: [ci-scope, ci-image-candidate]", `  backend:\n${value}\n    needs: [ci-scope, ci-image-candidate]`]),
    /backend must not install system packages or receive publication credentials/,
  );
});

test("CI image consumer discovery rejects fourth-job container key variants", () => {
  const containers = [
    `    container:\n      image: ${ciImageReference}`, `    container: { image: ${ciImageReference} }`,
    `    'container': ${ciImageReference}`, `    "container": ${ciImageReference}`,
    `    'container':\n      image: ${ciImageReference}`, `    "container": { image: ${ciImageReference} }`,
    `    ? container\n    : ${ciImageReference}`,
  ];
  assertMutationsFail(
    ".github/workflows/ci.yml",
    containers.map((value) => ["jobs:\n", `jobs:\n  unexpected_ci_image:\n    runs-on: ubuntu-24.04\n${value}\n    steps:\n      - run: echo unexpected\n\n`]),
    /must run on the host/,
  );
});

test("targeted jobs reject apt and Playwright system dependency installation", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(
    root,
    ".github/workflows/ci.yml",
    "run: pnpm --filter @tuneforge/desktop exec playwright install chromium",
    "run: pnpm --filter @tuneforge/desktop exec playwright install --with-deps chromium\n\n      - run: sudo apt-get update",
  );

  assert.throws(
    () => validateCiImagePolicy(root),
    /must not install system packages/,
  );
});

test("shared verifier calls reject comments, wrong order, duplicates, and nonconsumers", () => {
  const run = "        run: bash scripts/verify-ci-image.sh";
  const step = `      - name: Verify CI image\n${run}`;
  const checkout = "      - name: Check out code\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ github.sha }}\n          persist-credentials: false";
  assertMutationsFail(".github/workflows/ci.yml", [
    [run, `        # ${run.trim()}`],
    [checkout, `${step}\n\n${checkout}`],
    [step, `${step}\n\n${step}`],
    ["          fetch-depth: 0", "          fetch-depth: 0\n\n      - run: bash scripts/verify-ci-image.sh"],
  ], /must require selection success|Only CI image consumers/);
});

test("consumer runner and absolute shared shell checks fail closed", () =>
  assertMutationsFail(".github/workflows/ci.yml", [["    runs-on: ubuntu-24.04", "    runs-on: ubuntu-latest"],
    ["shell: bash ${{ github.workspace }}/scripts/ci-image-run.sh script {0}", "shell: bash scripts/ci-image-run.sh script {0}"]], /must use ubuntu-24.04|absolute shared Docker shell/));

test("pinned Rust bootstrap stays required", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/workflows/ci.yml", "          cache: false\n", "          cache: true\n");

  assert.throws(() => validateCiImagePolicy(root), /must bootstrap pinned Rust/);
});

test("Tauri uses one image-keyed Cargo cache and prebuilt SoXR", () =>
  assertMutationsFail(".github/workflows/ci.yml", [
    ["key: cargo-v2-${{ steps.image.outputs.identity }}-", "key: cargo-v2-"],
    ["      - name: Check Tauri shell", "      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9\n\n      - name: Check Tauri shell"],
    ['soxr_root="${TUNEFORGE_SOXR_ROOT:?}"', 'node scripts/build-soxr.mjs --target host-test\n          soxr_root="packaging/soxr/generated/host-test"'],
  ], /one image-keyed Cargo cache and the prebuilt SoXR payload/));

test("Pages rejects stale producer sources, unverified payloads and publication authority", () => {
  assertMutationsFail(".github/workflows/pages.yml", [
    ["grep -qx 'selection=promoted'", "grep -qx 'selection=candidate'"],
    ["GITHUB_OUTPUT=/dev/stdout bash scripts/ci-image-run.sh select", "echo selection=promoted"],
    ['run: bash scripts/ci-image-run.sh load "$RUNNER_TEMP/ci-image"', "run: docker pull moving-tag"],
    ["      contents: read", "      contents: read\n      packages: write"],
    ["run: bash scripts/verify-ci-image.sh", "run: true"],
    ["run: node scripts/ci-music-core.mjs install", "run: node scripts/build-music-core.mjs --target wasm"],
  ], /Pages must acquire|WASM acquisition/);
});

test("neutral serializer rejects Flatpak policy coupling", () => {
  assertMutationsFail("scripts/deterministic-source-snapshot.mjs", [
    ['const blockSize = 512;', 'const blockSize = 512;\nconst epoch = process.env.SOURCE_DATE_EPOCH;'],
    ['const blockSize = 512;', 'const blockSize = 512;\nimport "./flatpak-source-snapshots.mjs";'],
  ], /serializer must remain independent/);
});


test("candidate builder rejects publication, missing artifacts and scope bypass", () => {
  assertMutationsFail(".github/workflows/ci.yml", [
    ["  ci-image-candidate:\n    needs: ci-scope", "  ci-image-candidate:\n    needs: ci-scope\n    container: arbitrary-image"],
    ["      contents: read\n    outputs:\n      artifact_id:", "      contents: read\n      packages: write\n    outputs:\n      artifact_id:"],
    ["          if-no-files-found: error", "          if-no-files-found: ignore"],
    ["artifact_id: ${{ steps.upload.outputs.artifact-id }}", "artifact_id: fixed-name"],
    ["if: ${{ always() && (needs.ci-scope.result != 'success' || needs.ci-scope.outputs.image_selection != 'promoted') }}", "if: ${{ false }}"],
  ], /Candidate image|must run on the host/);
  assertMutationsFail("scripts/ci-image-run.sh", [
    ["docker build --platform linux/amd64 --no-cache --pull", "docker build --platform linux/amd64 --push --target soxr-builder"],
    ["--tag tuneforge-ci-candidate .", "--tag tuneforge-ci-candidate .\n    docker login ghcr.io"],
  ], /Shared image helper/);
});

test("candidate consumers reject artifact substitution and verification skip-green", () =>
  assertMutationsFail(".github/workflows/ci.yml", [
    ["artifact-ids: ${{ needs.ci-image-candidate.outputs.artifact_id }}", "name: candidate-image"],
    ["          digest-mismatch: error", "          digest-mismatch: warn"],
    ["          path: ${{ runner.temp }}/ci-image", "          path: ${{ runner.temp }}/ci-image\n          run-id: 123"],
    ["      - name: Verify CI image\n        run:", "      - name: Verify CI image\n        if: false\n        run:"],
    ["      - name: Require selected CI image\n        shell: bash", "      - name: Require selected CI image\n        continue-on-error: true\n        shell: bash"],
    ["    if: ${{ always() }}", "    if: ${{ false && always() }}"],
    ["CI_IMAGE_CANDIDATE_RESULT: ${{ needs.ci-image-candidate.result }}", "CI_IMAGE_CANDIDATE_RESULT: success"],
    ["cache-suffix: ${{ steps.image.outputs.identity }}", "cache-suffix: default"],
  ], /must download only|must not skip|must require selection|must retain fail-closed|caches must include/));

test("whole recipe selection cannot lose promotion-gap gates", () =>
  assertMutationsFail(".github/workflows/ci.yml", [["steps.image.outputs.selection != 'promoted'", "false"],
    ["run: bash scripts/ci-image-run.sh select", "run: echo promoted"]], /force consumer gates/));

test("promotion cannot trigger publisher and branch dispatch cannot publish", () =>
  assertMutationsFail(".github/workflows/ci-image.yml", [["      - .github/ci/Dockerfile", "      - .github/ci/**"],
    ["    if: github.ref == 'refs/heads/main'", "    if: true"]], /trusted main image inputs/));

test("publisher rejects unreviewed build arguments, targets, platforms and contexts", () =>
  assertMutationsFail(".github/workflows/ci-image.yml", [["          platforms: linux/amd64", "          platforms: linux/arm64"],
    ...["build-args: EXTRA=1", "target: soxr-builder", "build-contexts: extra=./apps"].map((option) => ["          no-cache: true", "          no-cache: true\n          " + option])], /only linux|explicit compatibility review/));

test("music-core builder rejects missing payload verification and unpinned bootstrap", () => {
  assertMutationsFail(".github/ci/Dockerfile", [["node scripts/ci-music-core.mjs stage /opt/tuneforge-ci/music-core", "true"], ["cd /opt/tuneforge-ci/music-core && sha256sum --check --strict payload.sha256", "true"]], /standalone music-core WASM payload/);
  assertMutationsFail(".github/ci/Dockerfile", [["MUSIC_NODE_SHA256}", "UNPINNED_SHA256}"], ["MUSIC_UV_SHA256}", "UNPINNED_SHA256}"], ["MUSIC_PYTHON_SHA256}", "UNPINNED_SHA256}"]], /checksum-pin.*bootstrap/);
});

test("publisher source-tree trigger coverage remains exact", () =>
  assertMutationsFail(".github/workflows/ci-image.yml", [
    ["      - packages/music-core/**\n", ""],
    ["      - packages/music-core/**", "      - packages/**"],
    ["      - packages/music-core/**", "      - packages/music-core/*"],
    ["      - packages/music-core/**", "      - packages/music-core/**\n      - .github/ci/promoted-image.json"],
    ["      - packages/music-core/**", "      - packages/music-core/**\n      - packages/music-core/LICENSE"],
  ], /must publish only for trusted main image inputs/));

test("native consumers permit only the exact locked CMake installation step", () => {
  assertMutationsFail(".github/workflows/ci.yml", [
    ["python -m pip install --no-index --no-deps", "python -m pip install"],
    ["cmake --platform linux-x64", "cmake --platform unreviewed-platform"],
    ["cmake --version", "cmake --version\n          pip install arbitrary"],
  ], /only the lock-verified CMake/);
});
