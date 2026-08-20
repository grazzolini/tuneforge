import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateCiImagePolicy } from "./ci-image-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciImageReference = fs
  .readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8")
  .match(/^  CI_IMAGE_REFERENCE:\s+(\S+)$/m)?.[1];
assert.ok(ciImageReference, "CI workflow must declare CI_IMAGE_REFERENCE");
const fixtureFiles = [
  "apps/desktop/package.json",
  "pnpm-lock.yaml",
  ".github/ci/Dockerfile",
  ".github/ci/README.md",
  ".github/workflows/ci-image.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/pages.yml",
  ".github/dependabot.yml",
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-ci-image-policy-"));
  for (const relativePath of fixtureFiles) {
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

test("FFmpeg package checksum verification precedes installation", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/ci/Dockerfile", "| sha256sum -c -;", "| cat; ");

  assert.throws(() => validateCiImagePolicy(root), /checksum-verified, then installed/);
});

test("CI image consumers require independent exact env and container digests", () =>
  assertMutationsFail(".github/workflows/ci.yml", [
    [`env:\n  CI_IMAGE_REFERENCE: ${ciImageReference}`, "env:\n  CI_IMAGE_REFERENCE: ghcr.io/grazzolini/tuneforge-ci:main"],
    [`    container: ${ciImageReference}`, "    container: ghcr.io/grazzolini/tuneforge-ci:main"],
  ], /Exactly backend, e2e, and desktop_tauri/));

test("CI image consumers reject valid container credentials", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(
    root,
    ".github/workflows/ci.yml",
    `    container: ${ciImageReference}`,
    `    container:\n      image: ${ciImageReference}\n      credentials:\n        username: actor\n        password: token`,
  );

  assert.throws(() => validateCiImagePolicy(root), /backend must not configure container credentials/);
});

test("CI image consumers reject every valid packages write permission form", () => {
  const permissions = [
    "    permissions:\n      packages: write", '    permissions:\n      packages: "write"',
    "    permissions:\n      packages: 'write'", "    permissions: { contents: read, packages: write }",
    "    permissions: write-all", '    permissions: "write-all"', "    permissions: 'write-all'",
  ];
  assertMutationsFail(
    ".github/workflows/ci.yml",
    permissions.map((value) => ["  backend:\n    needs: ci-scope", `  backend:\n${value}\n    needs: ci-scope`]),
    /backend must not receive packages: write/,
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
    /Exactly backend, e2e, and desktop_tauri/,
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
    /e2e must not execute apt[\s\S]*e2e must not use Playwright --with-deps/,
  );
});

test("shared verifier calls reject comments, wrong order, duplicates, and nonconsumers", () => {
  const run = "        run: bash scripts/verify-ci-image.sh";
  const step = `      - name: Verify CI image\n${run}`;
  const checkout = "      - name: Check out code\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
  assertMutationsFail(".github/workflows/ci.yml", [
    [run, `        # ${run.trim()}`],
    [`${checkout}\n\n${step}`, `${step}\n\n${checkout}`],
    [step, `${step}\n\n${step}`],
    ["          fetch-depth: 0", "          fetch-depth: 0\n\n      - run: bash scripts/verify-ci-image.sh"],
  ], /must call the shared CI image verifier|Only CI image consumers/);
});

test("consumer runner and shell checks fail closed", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(
    root,
    ".github/workflows/ci.yml",
    `  e2e:\n    runs-on: ubuntu-24.04\n    container: ${ciImageReference}\n    defaults:\n      run:\n        shell: bash`,
    `  e2e:\n    runs-on: ubuntu-latest\n    container: ${ciImageReference}\n    defaults:\n      run:\n        shell: sh`,
  );
  assert.throws(
    () => validateCiImagePolicy(root),
    /e2e must use ubuntu-24\.04[\s\S]*e2e must default run steps to Bash/,
  );
});

test("pinned Rust bootstrap stays required", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  replace(root, ".github/workflows/ci.yml", "          cache: false\n", "          cache: true\n");

  assert.throws(() => validateCiImagePolicy(root), /must bootstrap pinned Rust/);
});

test("release-facing workflow stays separate from CI image", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, ".github/workflows/pages.yml");
  fs.appendFileSync(target, "\n# ghcr.io/grazzolini/tuneforge-ci\n");

  assert.throws(() => validateCiImagePolicy(root), /Pages\/release media workflow/);
});
