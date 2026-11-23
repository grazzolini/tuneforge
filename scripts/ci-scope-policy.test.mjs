import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function caseArm(pattern) {
  const match = workflow.match(new RegExp(`${pattern}[\\s\\S]*?\\n\\s*;;`));
  assert.ok(match, `Missing CI scope case arm: ${pattern}`);
  return match[0];
}

test("CI reads the exact Python pin and leaves uv project selection unoverridden", () => {
  const pythonSetups = workflow.match(/uses: actions\/setup-python@[\s\S]*?python-version-file: \.python-version/g) ?? [];

  assert.equal(pythonSetups.length, 6);
  assert.doesNotMatch(workflow, /python-version: "3\.14"/);
  assert.doesNotMatch(workflow, /python-version:.*3\.14/);
  assert.doesNotMatch(workflow, /uv run --python/);
});

test("a cold script-tests runner provisions pinned Python and uv before checking the offline projection", () => {
  const job = workflow.slice(workflow.indexOf("  script-tests:\n"), workflow.indexOf("  e2e:\n"));
  const python = job.indexOf("python-version-file: .python-version");
  const uv = job.indexOf('version: "0.13.6"');
  const check = job.indexOf("uv export --offline --locked");
  assert.ok(python >= 0 && python < uv && uv < check);
  assert.match(job, /uses: actions\/setup-python@[a-f0-9]{40}/);
  assert.match(job, /diff -u \.github\/ci\/cross-runtime-requirements\.txt -/);
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
    ["  desktop_tauri:\n", "  cross_runtime_integration:\n", "run: cargo check"],
    ["  cross_runtime_integration:\n", null, "run: node scripts/ci-cross-runtime.mjs"],
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
  for (const gate of ["desktop", "release_media", "site"]) {
    assert.ok(workflow.includes(
      `${gate}: ${"$"}{{ steps.scope.outputs.${gate} == 'true' && (steps.scope.outputs.native_only != 'true' || steps.image.outputs.selection != 'promoted') }}`,
    ));
  }
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

test(".codex changes and third-party notices remain documentation-only CI scope", () => {
  const imageInputs = caseArm(
    String.raw`\.github/ci/\*\|\.github/workflows/ci-image\.yml\|\.github/workflows/ci\.yml\|packaging/soxr/\*\)`,
  );
  assert.match(imageInputs, /full_gate=true/);
  assert.doesNotMatch(imageInputs, /THIRD_PARTY_NOTICES\.md/);

  const documentation = caseArm(
    String.raw`\.agents/\*\|\.codex/\*\|docs/\*\|CHANGELOG\.md\|README\.md\|CONTRIBUTING\.md\|CODE_OF_CONDUCT\.md\|LICENSE\|THIRD_PARTY_NOTICES\.md\|SECURITY\.md\|AGENTS\.md\|TODO\.md\|\.gitignore\|packaging/flatpak/\*\|\.github/ISSUE_TEMPLATE/\*\|\.github/PULL_REQUEST_TEMPLATE\.md\)`,
  );
  assert.doesNotMatch(
    documentation,
    /full_gate=true|backend_static=true|backend_ffmpeg=true|desktop=true|site=true|release_media=true/,
  );
});


test("PR scope handles release, Codex, and cross-runtime paths, renames, deletions and diff failure", (context) => {
  const scope = workflow.slice(
    workflow.indexOf("      - name: Determine CI scope\n"),
    workflow.indexOf("      - name: Select whole CI image recipe\n"),
  );
  const shell = scope.split("        run: |\n")[1].replace(/^ {10}/gm, "");
  assert.match(workflow, /codex_only: \$\{\{ steps\.scope\.outputs\.codex_only \}\}/);
  assert.match(workflow, /  script-tests:\n    needs: ci-scope\n    if: \$\{\{ always\(\) && \(needs\.ci-scope\.result != 'success' \|\| needs\.ci-scope\.outputs\.codex_only != 'true'\) \}\}/);

  const directory = mkdtempSync(join(tmpdir(), "tuneforge-ci-scope-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_AUTHOR_NAME: "CI scope fixture",
    GIT_AUTHOR_EMAIL: "ci-scope@example.invalid",
    GIT_COMMITTER_NAME: "CI scope fixture",
    GIT_COMMITTER_EMAIL: "ci-scope@example.invalid",
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: "/dev/null",
  };
  const git = (args, input) => execFileSync("git", args, { cwd: directory, env, input, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);

  function commit(files, parent) {
    git(["read-tree", "--empty"]);
    for (const [file, contents] of Object.entries(files)) {
      const blob = git(["hash-object", "-w", "--stdin"], contents);
      git(["update-index", "--add", "--cacheinfo", "100644," + blob + "," + file]);
    }
    return git(["-c", "commit.gpgsign=false", "commit-tree", git(["write-tree"]),
      ...(parent ? ["-p", parent] : []), "-m", "CI scope fixture"]);
  }

  function check(label, base, head, codexOnly, { event = "pull_request", ...expected } = {}) {
    const script = shell.replaceAll("${{ github.event_name }}", event)
      .replaceAll("${{ github.event.pull_request.base.sha }}", base)
      .replaceAll("${{ github.event.pull_request.head.sha }}", head);
    rmSync(output, { force: true });
    execFileSync("bash", ["-c", script], { cwd: directory, env, stdio: "pipe" });
    const flags = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=")));
    assert.equal(flags.codex_only, String(codexOnly), label);
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(flags[name], String(value), `${label}: ${name}`);
    }
  }

  const commonFiles = { ".codex/config.toml": "original", "apps/desktop/example.ts": "original desktop" };
  const codexFiles = { ...commonFiles, ".codex/config.toml": "updated" };
  const common = commit(commonFiles);
  const codexHead = commit(codexFiles, common);
  const main = commit({ ...commonFiles, "apps/desktop/example.ts": "updated desktop" }, common);
  const mixedHead = commit({ ...codexFiles, "apps/desktop/example.ts": "updated desktop" }, common);

  check("only main changed outside .codex", main, codexHead, true, { desktop: true });
  check("main and the PR made the same outside edit", main, mixedHead, false, { desktop: false });
  check("nested path with newline", common, commit({ ...codexFiles, ".codex/agents/role\nsettings.toml": "new" }, common), true);
  check("other documentation", common, commit({ ...commonFiles, ".agents/roles.toml": "new", "docs/guide.md": "new" }, common), false);
  check("mixed special scripts", common, commit({ ...codexFiles, "scripts/desktop-e2e.test.mjs": "new" }, common), false);
  check("rename into .codex", common, commit({ ".codex/config.toml": "original", ".codex/example.ts": "original desktop" }, common), false);
  check("rename out of .codex", common, commit({ "config.toml": "original", "apps/desktop/example.ts": "original desktop" }, common), false);
  check("similar prefix", common, commit({ ...commonFiles, ".codex-other/config.toml": "new" }, common), false);
  check("empty diff", common, common, false);
  check("missing base revision", "missing", codexHead, false, { cross_runtime_integration: true });
  check("unrelated histories", common, commit(codexFiles), false, { cross_runtime_integration: true });
  check("push", common, codexHead, false, { event: "push", cross_runtime_integration: true });

  for (const path of [
    "apps/backend/app/services/sync_bundle.py",
    "apps/backend/app/api/routes/projects.py",
    "apps/backend/alembic/versions/0001_base.py",
    "apps/backend/alembic.ini",
    "apps/backend/tests/result_sync_fixture.py",
    "apps/backend/tests/fixtures/bundle.json",
    "apps/backend/pyproject.toml", "apps/backend/uv.lock",
    "packages/music-core/src/core.cpp", "packaging/soxr/sources.lock.json", ".github/workflows/ci.yml",
  ]) {
    check(path, common, commit({ ...commonFiles, [path]: "new" }, common), false,
      { cross_runtime_integration: true });
  }
  for (const path of ["apps/desktop/src/playback.tsx", "apps/site/src/App.tsx", "docs/guide.md", "TODO.md",
    "apps/backend/tests/test_unrelated.py", "packages/shared-types/src/generated/openapi.ts"]) {
    check(path, common, commit({ ...commonFiles, [path]: "new" }, common), false,
      { cross_runtime_integration: false });
  }
  const native = commit({ ...commonFiles, "apps/desktop/src-tauri/src/test\ncase.rs": "native" }, common);
  const nativeScope = { desktop: false, desktop_tauri: true, native_only: true,
    cross_runtime_integration: true, site: false, release_media: false };
  check("native edit", common, native, false, nativeScope);
  check("native deletion", native, commit(commonFiles, native), false, nativeScope);
  check("native-only PR with web drift in main", main, native, false,
    { ...nativeScope, desktop: true, site: true, release_media: true });
  const cargoConfig = commit({ ...commonFiles, ".cargo/config.toml": "cargo config" }, common);
  check("root Cargo config edit", common, cargoConfig, false, nativeScope);
  check("root Cargo config deletion", cargoConfig, commit(commonFiles, cargoConfig), false, nativeScope);
  check("root Cargo config rename to web", cargoConfig,
    commit({ ...commonFiles, "apps/desktop/src/cargo-config.toml": "cargo config" }, cargoConfig),
    false, { desktop: true, desktop_tauri: true, native_only: false, cross_runtime_integration: true, site: true });
  check("rename native into frontend", native, commit({ ...commonFiles, "apps/desktop/src/test.rs": "native" }, native),
    false, { desktop: true, native_only: false, cross_runtime_integration: true, site: true });
  const fixture = { ...commonFiles, "apps/backend/tests/result_sync_fixture.py": "fixture" };
  const fixtureHead = commit(fixture, common);
  check("rename fixture out of backend", fixtureHead,
    commit({ ...commonFiles, "docs/moved_fixture.py": "fixture" }, fixtureHead), false, { cross_runtime_integration: true });
  const backendMain = commit({ ...commonFiles, "apps/backend/app/api/routes/projects.py": "only main backend" }, common);
  const siteOnly = commit({ ...commonFiles, "apps/site/src/page.tsx": "only PR web" }, common);
  check("site-only PR with backend drift in main", backendMain, siteOnly, false,
    { native_only: false, cross_runtime_integration: false, backend_static: true, desktop: true, site: true });
});

test("producer inputs retain real gates and promotion gaps force all image consumer gates", () => {
  assert.match(caseArm(String.raw`scripts/\*\)`), /full_gate=true/);
  assert.match(caseArm(String.raw`\.github/ci/\*\|\.github/workflows/ci-image\.yml\|\.github/workflows/ci\.yml\|packaging/soxr/\*\)`), /full_gate=true/);
  assert.match(workflow, /run: bash scripts\/ci-image-run\.sh select/);
  for (const flag of ["backend_static", "backend_ffmpeg", "desktop_tauri", "cross_runtime_integration"]) {
    assert.match(workflow.split("\n").find((line) => line.includes(`${flag}: `)), /steps\.image\.outputs\.selection != 'promoted'/);
  }
  const candidate = workflow.slice(workflow.indexOf("  ci-image-candidate:\n"), workflow.indexOf("\n  commitlint:"));
  assert.match(candidate, /needs: ci-scope/);
  assert.match(candidate, /always\(\).*needs\.ci-scope\.result != 'success'/);
  const integration = workflow.slice(workflow.indexOf("  cross_runtime_integration:\n"));
  const schedule = integration.match(/^    if: (.*)$/m)?.[1];
  assert.match(schedule, /needs\.ci-scope\.result != 'success'/);
  assert.match(schedule, /needs\.ci-scope\.outputs\.cross_runtime_integration != 'false'/);
  assert.match(schedule, /needs\.ci-scope\.outputs\.image_selection != 'promoted'/);
  assert.match(schedule, /needs\.ci-image-candidate\.result != 'skipped'/);
  assert.match(integration, /if: needs\.ci-scope\.outputs\.image_selection == 'promoted' && needs\.ci-image-candidate\.result != 'skipped'\n        run: exit 1/);
  assert.doesNotMatch(integration, /if: needs\.ci-scope\.outputs\.image_selection != 'candidate'\n        run: exit 1/);
});
