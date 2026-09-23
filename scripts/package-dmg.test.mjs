import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDmg } from "./package-dmg.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "tuneforge-dmg-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "plain-source");
  const temporaryRoot = path.join(root, "temporary");
  mkdirSync(source);
  mkdirSync(temporaryRoot);
  writeFileSync(path.join(source, "marker.txt"), "synthetic fixture");
  return { root, source, temporaryRoot, output: path.join(root, "output", "Example_1.2.3_aarch64.dmg") };
}

test("diskutil creates the named UDZO image from staged content and cleans staging", (t) => {
  const { source, temporaryRoot, output } = fixture(t);
  let staging;
  createDmg({
    source, output, name: "Example", temporaryRoot,
    copy(from, to, options) {
      assert.equal(from, source);
      assert.equal(path.basename(to), "Example.app");
      assert.deepEqual(options, { recursive: true });
    },
    execute(command, args, options) {
      assert.equal(command, "diskutil");
      assert.deepEqual(args.slice(0, 7), [
        "image", "create", "from", "--volumeName", "Example", "--format", "UDZO",
      ]);
      staging = args[7];
      assert.equal(args[8], output);
      assert.equal(options.stdio, "inherit");
      assert.equal(readlinkSync(path.join(staging, "Applications")), "/Applications");
      assert.deepEqual(readdirSync(staging), ["Applications"]);
      writeFileSync(output, "mock disk image");
    },
  });
  assert.equal(readFileSync(output, "utf8"), "mock disk image");
  assert.equal(existsSync(staging), false);
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test("diskutil failure removes a partial image and staging directory", (t) => {
  const { source, temporaryRoot, output } = fixture(t);
  assert.throws(() => createDmg({
    source, output, name: "Example", temporaryRoot,
    copy() {},
    execute(_command, args) {
      writeFileSync(args.at(-1), "partial image");
      throw new Error("diskutil failed");
    },
  }), /diskutil failed/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(temporaryRoot), []);
  assert.equal(readFileSync(path.join(source, "marker.txt"), "utf8"), "synthetic fixture");
});

test("missing source leaves an existing output untouched", (t) => {
  const { root, temporaryRoot, output } = fixture(t);
  mkdirSync(path.dirname(output));
  writeFileSync(output, "existing image");
  assert.throws(() => createDmg({
    source: path.join(root, "missing-source"), output, temporaryRoot,
    copy() { throw new Error("copy should not run"); },
    execute() { throw new Error("diskutil should not run"); },
  }), /App bundle not found/);
  assert.equal(readFileSync(output, "utf8"), "existing image");
  assert.deepEqual(readdirSync(temporaryRoot), []);
});
