import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAndroidModelAssets } from "./prepare-android-model-assets.mjs";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-android-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureSpec(bytes) {
  return {
    family: "beat-this",
    revision: "fixture-revision",
    fileName: "fixture.pte",
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    url: "https://invalid.example/fixture.pte",
  };
}

test("Android model bundle verifies and records a local model atomically", async (t) => {
  const root = temp(t);
  const bytes = Buffer.from("synthetic-model-fixture");
  const source = path.join(root, "source.pte");
  const destinationRoot = path.join(root, "assets/models");
  fs.writeFileSync(source, bytes);
  const spec = fixtureSpec(bytes);

  const destination = await prepareAndroidModelAssets({ source, destinationRoot, spec });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(destinationRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.assets[0].sha256, spec.sha256);
  assert.equal(manifest.assets[0].relativePath, "models/beat-this/fixture.pte");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)).sort(), ["fixture.pte"]);
});

test("Android model bundle rejects corrupt bytes without publishing", async (t) => {
  const root = temp(t);
  const source = path.join(root, "source.pte");
  const destinationRoot = path.join(root, "assets/models");
  fs.writeFileSync(source, "corrupt");
  const spec = fixtureSpec(Buffer.from("expected"));

  await assert.rejects(
    prepareAndroidModelAssets({ source, destinationRoot, spec }),
    /failed size or SHA-256 verification/,
  );
  assert.equal(fs.existsSync(path.join(destinationRoot, "manifest.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(destinationRoot, "beat-this")), []);
});
