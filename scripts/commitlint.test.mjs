import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function lint(message, config) {
  const result = spawnSync(
    pnpmCommand,
    ["exec", "commitlint", "--config", config],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      input: message,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

test("accepts a commit body with an inline issue reference", () => {
  const result = lint(
    "fix(ci): align commitlint toolchain\n\nUse the pinned parser for issue #432.\n",
    "commitlint.config.cjs",
  );

  assert.equal(result.status, 0, output(result));
});

test("accepts a commit body followed by a reference footer", () => {
  const result = lint(
    "fix(ci): align commitlint toolchain\n\nUse the pinned parser in CI.\n\nRefs #432\n",
    "commitlint.config.cjs",
  );

  assert.equal(result.status, 0, output(result));
});

test("rejects a commit without a body", () => {
  const result = lint("fix(ci): align commitlint toolchain\n", "commitlint.config.cjs");

  assert.notEqual(result.status, 0);
  assert.match(output(result), /body-empty/i);
});

test("accepts a body-less PR title", () => {
  const result = lint("fix(ci): align commitlint toolchain\n", "commitlint.pr-title.config.cjs");

  assert.equal(result.status, 0, output(result));
});
