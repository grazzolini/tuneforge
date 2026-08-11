import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBuildInfo } from "./build-info.mjs";

function runGit(repository, args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("git fallback uses matching minimum eight-digit refs and preserves dirty state", () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "tuneforge-build-info-"));
  const originalGitRef = process.env.TUNEFORGE_GIT_REF;

  try {
    delete process.env.TUNEFORGE_GIT_REF;
    runGit(repository, ["init", "--quiet"]);
    runGit(repository, ["config", "core.abbrev", "7"]);
    writeFileSync(path.join(repository, "tracked.txt"), "clean\n");
    runGit(repository, ["add", "tracked.txt"]);
    runGit(repository, [
      "-c",
      "user.name=TuneForge Tests",
      "-c",
      "user.email=tests@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "initial",
    ]);
    runGit(repository, ["-c", "tag.gpgSign=false", "tag", "v1.2.3"]);

    const clean = resolveBuildInfo({ workspaceRoot: repository, versionFilePath: null });
    assert.match(clean.backend.git_ref, /^v1\.2\.3-0-g[0-9a-f]{8,}$/);
    assert.equal(clean.frontend.git_ref, clean.backend.git_ref);

    writeFileSync(path.join(repository, "tracked.txt"), "dirty\n");
    const dirty = resolveBuildInfo({ workspaceRoot: repository, versionFilePath: null });
    assert.equal(dirty.backend.git_ref, `${clean.backend.git_ref}-dirty`);
    assert.equal(dirty.frontend.git_ref, dirty.backend.git_ref);
  } finally {
    if (originalGitRef === undefined) {
      delete process.env.TUNEFORGE_GIT_REF;
    } else {
      process.env.TUNEFORGE_GIT_REF = originalGitRef;
    }
    rmSync(repository, { recursive: true, force: true });
  }
});
