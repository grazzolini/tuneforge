import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateCiImagePolicy } from "./ci-image-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

test("release-facing workflow stays separate from CI image", (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, ".github/workflows/pages.yml");
  fs.appendFileSync(target, "\n# ghcr.io/grazzolini/tuneforge-ci\n");

  assert.throws(() => validateCiImagePolicy(root), /Pages\/release media workflow/);
});
