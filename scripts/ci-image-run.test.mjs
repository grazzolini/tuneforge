import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { imageInventory, producerIdentity } from "./ci-image-impact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkout = "1".repeat(40);
const configID = `sha256:${"2".repeat(64)}`;
function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ci-image-run-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  for (const input of [...imageInventory(root).inputs, "scripts/ci-image-run.sh", ".github/ci/promoted-image.json"]) {
    fs.mkdirSync(path.dirname(path.join(workspace, input)), { recursive: true });
    fs.copyFileSync(path.join(root, input), path.join(workspace, input));
  }
  const log = path.join(directory, "docker.log");
  const executables = {
    git: `#!/bin/bash\nprintf '%s\\n' '${checkout}'\n`,
    node: `#!/bin/bash\nexec '${process.execPath}' "$@"\n`,
    realpath: "#!/bin/bash\necho /opt/hostedtoolcache/node/26/x64/bin/node\n",
    docker: `#!/bin/bash
printf '%s\\n' "$@" >> "$MOCK_LOG"
case "$1 $2" in
  'image inspect')
    if [[ "$4" = '{{.Id}}' ]]; then echo '${configID}'; else echo linux/amd64; fi ;;
  'save --output') printf 'docker archive' > "$3" ;;
  'load --input') echo 'Loaded image ID: ${configID}' ;;
  'run --rm')
    if [[ "\${MOCK_EXEC_SCRIPT:-}" = true ]]; then
      while (( $# > 0 )); do
        case "$1" in
          --workdir) cd "$2"; shift ;;
          --env) export "$2"; shift ;;
          '${configID}') shift; exec "$@" ;;
        esac
        shift
      done
    fi
    exit "$MOCK_EXIT" ;;
esac
`,
  };
  for (const [name, content] of Object.entries(executables)) {
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  }
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: checkout,
    GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: path.join(directory, "output"),
    GITHUB_ENV: path.join(directory, "env"), GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    RUNNER_TEMP: directory, GITHUB_JOB: "test", MOCK_LOG: log, MOCK_EXIT: "0",
    CI_IMAGE_REFERENCE: configID, CI_IMAGE_FINGERPRINT: producerIdentity(workspace).fingerprint,
    CI_SCOPE_RESULT: "success", CI_IMAGE_SELECTION: "candidate", CI_IMAGE_CANDIDATE_RESULT: "success", CI_IMAGE_ARTIFACT_ID: "123",
    CI_USE_UV: "false", RUST_VERSION: "", pythonLocation: "", CI_PNPM_ROOT: "",
  };
  return { directory, workspace, log, env };
}
function run(value, args, overrides = {}) {
  return spawnSync("bash", [path.join(value.workspace, "scripts/ci-image-run.sh"), ...args], {
    env: { ...value.env, ...overrides }, cwd: overrides.TEST_CWD ?? value.workspace, encoding: "utf8",
  });
}
function artifact(value, changes = {}) {
  fs.writeFileSync(path.join(value.directory, "image.tar"), "archive");
  fs.writeFileSync(path.join(value.directory, "metadata.json"), JSON.stringify({
    checkoutSHA: checkout, producerFingerprint: value.env.CI_IMAGE_FINGERPRINT,
    archiveSHA: crypto.createHash("sha256").update("archive").digest("hex"),
    configImageID: configID, platform: "linux/amd64", ...changes,
  }));
}

test("bootstrap chooses candidate; registered matching recipe chooses promoted", (context) => {
  const value = fixture(context);
  const recordPath = path.join(value.workspace, ".github/ci/promoted-image.json");
  const record = JSON.parse(fs.readFileSync(recordPath));
  record.producerFingerprint = null;
  record.sourceRevision = null;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(run(value, ["select"]).status, 0);
  assert.match(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), /selection=candidate/);
  record.producerFingerprint = value.env.CI_IMAGE_FINGERPRINT;
  record.sourceRevision = checkout;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  fs.writeFileSync(value.env.GITHUB_OUTPUT, "");
  assert.equal(run(value, ["select"]).status, 0);
  assert.match(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), /selection=promoted/);
  assert.equal(run(value, ["load"], { CI_IMAGE_SELECTION: "promoted",
    CI_IMAGE_CANDIDATE_RESULT: "skipped", CI_IMAGE_ARTIFACT_ID: "" }).status, 0);
  const log = fs.readFileSync(value.log, "utf8");
  assert.ok(log.includes(`pull\n--platform\nlinux/amd64\nghcr.io/grazzolini/tuneforge-ci@${record.digest}\n`));
  assert.doesNotMatch(log, /build|load|login|push/);
  const identity = crypto.createHash("sha256").update(`${configID}\n${record.producerFingerprint}\n`).digest("hex");
  assert.equal(fs.readFileSync(path.join(value.workspace, ".github/ci/.selected-image-key"), "utf8"), `${identity}\n`);
  record.producerFingerprint = "0".repeat(64);
  fs.writeFileSync(recordPath, JSON.stringify(record));
  fs.writeFileSync(value.env.GITHUB_OUTPUT, "");
  assert.equal(run(value, ["select"]).status, 0);
  assert.match(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), /selection=candidate/);
  record.sourceRevision = null;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.notEqual(run(value, ["select"]).status, 0);
});

test("candidate build exports FINAL recipe plus distinct config and archive identities", (context) => {
  const value = fixture(context);
  assert.equal(run(value, ["build", value.directory]).status, 0);
  const metadata = JSON.parse(fs.readFileSync(path.join(value.directory, "metadata.json")));
  assert.equal(metadata.configImageID, configID);
  assert.equal(metadata.checkoutSHA, checkout);
  assert.equal(metadata.producerFingerprint, value.env.CI_IMAGE_FINGERPRINT);
  assert.match(metadata.archiveSHA, /^[a-f0-9]{64}$/);
  const log = fs.readFileSync(value.log, "utf8");
  assert.match(log, /build\n--platform\nlinux\/amd64\n--no-cache\n--pull/);
  assert.doesNotMatch(log, /--target|login|push/);
});

test("candidate loader rejects failure, missing ID, substituted identity and corrupt archive without fallback", (context) => {
  const value = fixture(context);
  artifact(value);
  assert.equal(run(value, ["load", value.directory]).status, 0);
  for (const overrides of [{ CI_SCOPE_RESULT: "failure" }, { CI_IMAGE_CANDIDATE_RESULT: "failure" }, { CI_IMAGE_ARTIFACT_ID: "" }, { CI_IMAGE_SELECTION: "unknown" }]) {
    assert.notEqual(run(value, ["load", value.directory], overrides).status, 0);
  }
  for (const changes of [{ checkoutSHA: "3".repeat(40) }, { producerFingerprint: "0".repeat(64) },
    { platform: "linux/arm64" }, { configImageID: "registry-digest-is-not-config-id" },
    { configImageID: `sha256:${"3".repeat(64)}` }, { archiveSHA: "0".repeat(64) }]) {
    artifact(value, changes);
    const result = run(value, ["load", value.directory]);
    assert.notEqual(result.status, 0, JSON.stringify(changes));
    assert.match(result.stderr, /mismatch|does not match/);
  }
  assert.doesNotMatch(fs.readFileSync(value.log, "utf8"), /pull|login/);
});

test("expired or missing candidate archives and metadata fail without pulling the promoted image", (context) => {
  const value = fixture(context);
  for (const missing of ["image.tar", "metadata.json"]) {
    artifact(value);
    fs.unlinkSync(path.join(value.directory, missing));
    assert.notEqual(run(value, ["load", value.directory]).status, 0);
  }
  assert.equal(fs.existsSync(value.log), false);
});

test("absolute script shell preserves nested cwd, command files, explicit env and nonzero exit", (context) => {
  const value = fixture(context);
  const cwd = path.join(value.workspace, "apps/backend");
  fs.mkdirSync(cwd, { recursive: true });
  const script = path.join(value.directory, "step.sh");
  fs.writeFileSync(script, 'printf "cwd=%s\\n" "$PWD" >> "$GITHUB_OUTPUT"\nprintf "forwarded=%s\\n" "$E2E_ARTIFACT_DIR" >> "$GITHUB_ENV"\nprintf "summary\\n" >> "$GITHUB_STEP_SUMMARY"\nexit 23\n');
  const result = run(value, ["script", script], { TEST_CWD: cwd, MOCK_EXEC_SCRIPT: "true", E2E_ARTIFACT_DIR: "forwarded-value" });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(fs.readFileSync(value.env.GITHUB_OUTPUT, "utf8"), `cwd=${cwd}\n`);
  assert.equal(fs.readFileSync(value.env.GITHUB_ENV, "utf8"), "forwarded=forwarded-value\n");
  assert.equal(fs.readFileSync(value.env.GITHUB_STEP_SUMMARY, "utf8"), "summary\n");
  assert.notEqual(run(value, ["script", script], { TEST_CWD: value.directory }).status, 0);
  const outside = path.join(value.workspace, "step.sh");
  fs.copyFileSync(script, outside);
  assert.notEqual(run(value, ["script", outside], { RUNNER_TEMP: path.join(value.directory, "script-only") }).status, 0);
});

test("one Docker runner forwards exit status with curated mounts/env and no host secrets/libs", (context) => {
  const value = fixture(context);
  const result = run(value, ["run", "exit 23"], { MOCK_EXIT: "23", GITHUB_TOKEN: "secret-sentinel", LD_LIBRARY_PATH: "/host-secret-lib" });
  assert.equal(result.status, 23);
  const log = fs.readFileSync(value.log, "utf8");
  assert.match(log, /--user\n[0-9]+:[0-9]+/);
  assert.match(log, /HOME=.*ci-image-home/);
  assert.match(log, /LD_LIBRARY_PATH=\/opt\/tuneforge-ci\/soxr\/host-test\/lib/);
  assert.doesNotMatch(log, /secret-sentinel|host-secret-lib|docker\.sock|src=\/usr\/lib/);
  assert.ok(!log.includes(`src=${process.env.HOME},`));
});
