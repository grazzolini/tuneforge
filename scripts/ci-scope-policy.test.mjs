import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function caseArm(pattern) {
  const match = workflow.match(new RegExp(`${pattern}[\\s\\S]*?\\n\\s*;;`));
  assert.ok(match, `Missing CI scope case arm: ${pattern}`);
  return match[0];
}

test("CI reads the exact Python pin once and leaves uv project selection unoverridden", () => {
  const pythonSetups = workflow.match(/uses: actions\/setup-python@[\s\S]*?python-version-file: \.python-version/g) ?? [];

  assert.equal(pythonSetups.length, 4);
  assert.doesNotMatch(workflow, /python-version: "3\.14"/);
  assert.doesNotMatch(workflow, /python-version:.*3\.14/);
  assert.doesNotMatch(workflow, /uv run --python/);
});

test("WASM consumers require the selected image payload and verify the same-run artifact before use", () => {
  const producer = workflow.slice(workflow.indexOf("  music-core-wasm:\n"), workflow.indexOf("\n  commitlint:"));
  assert.match(producer, /runs-on: ubuntu-24\.04/);
  assert.match(producer, /run: bash scripts\/ci-image-run\.sh load/);
  assert.match(producer, /node scripts\/ci-music-core\.mjs install/);
  assert.match(producer, /run: bash scripts\/verify-ci-image\.sh/);
  assert.doesNotMatch(producer, /run: node scripts\/build-music-core\.mjs --target wasm\n/);
  assert.match(producer, /artifact_id: \$\{\{ steps\.artifact\.outputs\.artifact-id \}\}/);
  for (const [start, end, command] of [
    ["  e2e:\n", "  site:\n", "pnpm --filter @tuneforge/desktop test:e2e"],
    ["  site:\n", "  backend:\n", "node scripts/capture-release-media.mjs --run"],
    ["  desktop_frontend:\n", "  desktop_tauri:\n", "pnpm --filter @tuneforge/desktop test --run"],
  ]) {
    const consumer = workflow.slice(workflow.indexOf(start), workflow.indexOf(end));
    assert.match(consumer, /needs: \[[^\n]*music-core-wasm\]/);
    assert.match(consumer, /artifact-ids: \$\{\{ needs\.music-core-wasm\.outputs\.artifact_id \}\}/);
    assert.match(consumer, /digest-mismatch: error/);
    const verification = consumer.indexOf("node scripts/build-music-core.mjs --target wasm --check");
    assert.ok(verification >= 0 && verification < consumer.indexOf(command));
    assert.doesNotMatch(consumer, /run: node scripts\/build-music-core\.mjs --target wasm\n/);
  }
  const pages = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(pages.slice(0, pages.indexOf("  build:\n")), /grep -qx 'selection=promoted'/);
  assert.match(pages.slice(0, pages.indexOf("  build:\n")), /node scripts\/ci-music-core\.mjs install/);
  assert.match(pages, /build:\n    needs: music-core-wasm/);
  assert.match(pages, /artifact-ids: \$\{\{ needs\.music-core-wasm\.outputs\.artifact_id \}\}/);
  assert.ok(pages.indexOf("--target wasm --check", pages.indexOf("  build:\n")) < pages.indexOf("node scripts/capture-release-media.mjs --run"));
});

test("native CI installs locked CMake on the host before source consumers enter the image", () => {
  for (const [start, end, command] of [
    ["  e2e:\n", "  site:\n", "uv sync --locked --all-groups"],
    ["  backend:\n", "  desktop_frontend:\n", "uv sync --locked --all-groups"],
    ["  desktop_frontend:\n", "  desktop_tauri:\n", "uv sync --locked --all-groups"],
    ["  desktop_tauri:\n", null, "run: cargo check"],
  ]) {
    const job = workflow.slice(workflow.indexOf(start), end ? workflow.indexOf(end) : undefined);
    const install = job.indexOf("      - name: Install locked music-core CMake in hosted Python prefix\n");
    const next = job.indexOf("\n      - name:", install + 1);
    assert.ok(install >= 0 && install < job.indexOf(command), start);
    const step = job.slice(install, next);
    assert.match(step, /shell: bash\n/);
    assert.match(step, /node scripts\/build-music-core\.mjs --download-tool cmake --platform linux-x64/);
    assert.match(step, /python -m pip install --no-index --no-deps "\$cmake_wheel"/);
    assert.doesNotMatch(step, /--user|--target|cmake==/);
  }
});

test("release-media CI scope captures desktop-affecting changes without widening site-only checks", () => {
  assert.match(workflow, /release_media: \$\{\{ steps\.scope\.outputs\.release_media \}\}/);
  assert.match(workflow, /release_media=false/);
  assert.match(workflow, /echo "release_media=\$\{release_media\}"/);
  const captureScript = caseArm(String.raw`scripts/capture-release-media\.mjs\|scripts/check-release-version\.mjs\)`);
  const dependencies = caseArm(String.raw`package\.json\|pnpm-lock\.yaml\|pnpm-workspace\.yaml\)`);
  const desktop = caseArm(String.raw`apps/desktop/\*\)`);
  const sharedTypes = caseArm(String.raw`packages/shared-types/\*\)`);
  const siteOnly = caseArm(String.raw`apps/site/\*\|\.github/workflows/pages\.yml\)`);
  for (const arm of [captureScript, dependencies]) {
    assert.match(arm, /site=true/);
    assert.match(arm, /release_media=true/);
  }
  assert.match(desktop, /desktop=true/);
  assert.match(desktop, /site=true/);
  assert.match(desktop, /release_media=true/);
  assert.match(sharedTypes, /desktop=true/);
  assert.doesNotMatch(sharedTypes, /site=true|release_media=true/);
  assert.match(siteOnly, /site=true/);
  assert.doesNotMatch(siteOnly, /release_media=true/);
  const fullGateStart = workflow.indexOf('if [[ "${full_gate}" == "true" ]]; then');
  const fullGateEnd = workflow.indexOf("\n          fi", fullGateStart);
  assert.ok(fullGateStart >= 0 && fullGateEnd >= 0, "Missing full-gate scope block.");
  assert.match(workflow.slice(fullGateStart, fullGateEnd), /release_media=true/);

  const siteJob = workflow.slice(workflow.indexOf("  site:\n"), workflow.indexOf("\n  backend:"));
  const installIndex = siteJob.indexOf("playwright install --with-deps chromium");
  const captureIndex = siteJob.indexOf("node scripts/capture-release-media.mjs --run");
  const buildIndex = siteJob.indexOf("pnpm --filter @tuneforge/site build");
  assert.match(siteJob, /Install Chromium for release media\n        if: needs\.ci-scope\.outputs\.release_media == 'true'/);
  assert.match(siteJob, /Capture release media\n        if: needs\.ci-scope\.outputs\.release_media == 'true'/);
  assert.ok(installIndex >= 0 && installIndex < captureIndex && captureIndex < buildIndex);
  assert.doesNotMatch(siteJob, /capture-release-media\.mjs --run.*--(?:allow-partial|no-video)/);
});

test("third-party notice changes remain documentation-only CI scope", () => {
  const imageInputs = caseArm(
    String.raw`\.github/ci/\*\|\.github/workflows/ci-image\.yml\|\.github/workflows/ci\.yml\|packaging/soxr/\*\)`,
  );
  assert.match(imageInputs, /full_gate=true/);
  assert.doesNotMatch(imageInputs, /THIRD_PARTY_NOTICES\.md/);

  const documentation = caseArm(
    String.raw`\.agents/\*\|\.codex/environments/\*\|docs/\*\|CHANGELOG\.md\|README\.md\|CONTRIBUTING\.md\|CODE_OF_CONDUCT\.md\|LICENSE\|THIRD_PARTY_NOTICES\.md\|SECURITY\.md\|AGENTS\.md\|\.gitignore\|packaging/flatpak/\*\|\.github/ISSUE_TEMPLATE/\*\|\.github/PULL_REQUEST_TEMPLATE\.md\)`,
  );
  assert.doesNotMatch(
    documentation,
    /full_gate=true|backend_static=true|desktop=true|site=true|release_media=true/,
  );
});


test("producer inputs retain real gates and promotion gaps force all image consumer gates", () => {
  assert.match(caseArm(String.raw`scripts/\*\)`), /full_gate=true/);
  assert.match(caseArm(String.raw`\.github/ci/\*\|\.github/workflows/ci-image\.yml\|\.github/workflows/ci\.yml\|packaging/soxr/\*\)`), /full_gate=true/);
  assert.match(workflow, /run: bash scripts\/ci-image-run\.sh select/);
  for (const flag of ["backend_static", "backend_ffmpeg", "desktop_tauri"]) {
    assert.match(workflow.split("\n").find((line) => line.includes(`${flag}: `)), /steps\.image\.outputs\.selection != 'promoted'/);
  }
  const candidate = workflow.slice(workflow.indexOf("  ci-image-candidate:\n"), workflow.indexOf("\n  commitlint:"));
  assert.match(candidate, /needs: ci-scope/);
  assert.match(candidate, /always\(\).*needs\.ci-scope\.result != 'success'/);
});
