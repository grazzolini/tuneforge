import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("./ci-cross-runtime.mjs", import.meta.url));
const pin = readFileSync(new URL("../.python-version", import.meta.url), "utf8").trim();
const name = "mobile_backend::reconciliation::tests::python_producers_native_apply_result_matrix_and_bidirectional_replay";
const cases = ["analysis 1", "chords 1", "stems 1", "chords-stems 1", "combined 1", "analysis 25", "analysis 194"];
const passed = [
  "running 1 test",
  `test ${name} ... ok`,
  ...cases.map((entry) => {
    const [variant, count] = entry.split(" ");
    return `result matrix variant=${variant} projects=${count} initial_import_ms=0`;
  }),
  "verified native result return",
  "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 589 filtered out",
].join("\n");

function fixture(context, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "cross-runtime-launcher-test-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = join(root, "bin");
  const soxr = join(root, "soxr");
  mkdirSync(bin);
  mkdirSync(join(soxr, "include"), { recursive: true });
  mkdirSync(join(soxr, "lib"));
  writeFileSync(join(soxr, "include/soxr.h"), "");
  writeFileSync(join(soxr, `lib/libsoxr.${process.platform === "darwin" ? "dylib" : "so"}`), "");
  writeFileSync(join(soxr, "provenance.json"), '{"options":["-DWITH_PFFFT=ON"]}');
  function tool(name, script) {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
    return path;
  }
  const python = tool("python", `
if (process.env.PYTHONPATH || process.env.TUNEFORGE_DATA_DIR) process.exit(6);
if (process.argv[4].includes("platform")) console.log(${JSON.stringify(options.version ?? `CPython ${pin}`)});
else if (${options.missingBindings ?? false}) { console.error("No module named tuneforge_music_core"); process.exit(1); }
`);
  tool("cargo", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(root, "cargo.json"))}, JSON.stringify({
  args: process.argv.slice(2),
  home: process.env.HOME, tmp: process.env.TMPDIR, data: process.env.TUNEFORGE_DATA_DIR,
  model: process.env.TUNEFORGE_MODEL_BUNDLE_DIR, python: process.env.TUNEFORGE_CROSS_RUNTIME_PYTHON,
}));
console.log(${JSON.stringify(options.output ?? passed)});
process.exit(${options.exit ?? 0});
`);
  tool("ffmpeg", "");
  tool("ffprobe", options.missingFfprobe ? "process.exit(127);" : "");
  const result = spawnSync(process.execPath, [launcher, "--python", python], {
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].join(delimiter),
      TMPDIR: root,
      TUNEFORGE_SOXR_ROOT: options.missingSoxr ? "" : soxr,
      TUNEFORGE_DATA_DIR: join(root, "unexpected-data"),
      TUNEFORGE_MODEL_BUNDLE_DIR: join(root, "unexpected-models"),
      PYTHONPATH: join(root, "unexpected-imports"),
    },
    encoding: "utf8",
  });
  const record = join(root, "cargo.json");
  return { result, python, cargo: existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null };
}

test("launcher requires the exact ignored library test and cleans up isolated roots", (context) => {
  const { result, cargo, python } = fixture(context);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(cargo.args, ["test", "--locked", "--color", "never", "--manifest-path",
    "apps/desktop/src-tauri/Cargo.toml", "--lib", name, "--", "--exact", "--ignored", "--show-output"]);
  assert.equal(cargo.data, undefined);
  assert.equal(cargo.model, undefined);
  assert.equal(cargo.python, python);
  assert.equal(cargo.home, join(cargo.tmp, "home"));
  assert.equal(existsSync(cargo.tmp), false);
});

test("launcher rejects silent test selection and incomplete matrix output", (context) => {
  for (const output of [
    "running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored;",
    passed.replace(name, "a::different_test"),
    passed.replace("result matrix variant=analysis projects=194", "result matrix variant=analysis projects=193"),
    passed.replace("verified native result return", ""),
  ]) {
    const { result, cargo } = fixture(context, { output });
    assert.ok(cargo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected one passing ignored Rust test/);
  }
});

test("launcher fails before Cargo for wrong Python, binding or FFmpeg/SoXR prerequisites", (context) => {
  for (const [options, error] of [
    [{ version: "CPython 3.14.0" }, /Expected CPython/],
    [{ missingBindings: true }, /No module named tuneforge_music_core/],
    [{ missingFfprobe: true }, /ffprobe failed/],
    [{ missingSoxr: true }, /TUNEFORGE_SOXR_ROOT/],
  ]) {
    const { result, cargo } = fixture(context, options);
    assert.equal(cargo, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
});

test("launcher preserves Cargo and fixture errors and cleans up after failure", (context) => {
  const { result, cargo } = fixture(context, { output: "Synthetic Python fixture failed", exit: 101 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Synthetic Python fixture failed/);
  assert.match(result.stderr, /cargo failed: exit 101/);
  assert.equal(existsSync(cargo.tmp), false);
});
