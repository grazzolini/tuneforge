import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function caseArm(pattern) {
  const match = workflow.match(new RegExp(`${pattern}[\\s\\S]*?\\n\\s*;;`));
  assert.ok(match, `Missing CI scope case arm: ${pattern}`);
  return match[0];
}

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
