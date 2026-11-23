import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const backend = join(repo, "apps/backend");
const testName =
  "mobile_backend::reconciliation::tests::python_producers_native_apply_result_matrix_and_bidirectional_replay";
const cases = [
  "analysis:1", "chords:1", "stems:1", "chords-stems:1", "combined:1", "analysis:25", "analysis:194",
];

function checkPass(output) {
  const lines = output.split(/\r?\n/);
  const actual = lines.flatMap((line) => {
    const match = /^result matrix variant=(\S+) projects=(\d+) /.exec(line);
    return match ? [`${match[1]}:${match[2]}`] : [];
  });
  if (!lines.includes("running 1 test") || !lines.includes(`test ${testName} ... ok`) ||
      !lines.some((line) => /^test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(line)) ||
      actual.join(",") !== cases.join(",") ||
      lines.filter((line) => line === "verified native result return").length !== 1) {
    throw new Error("Expected one passing ignored Rust test, all seven matrix cases and one verified native return");
  }
}

function run(command, args, env) {
  const child = spawnSync(command, args, {
    cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    if (child.stdout) process.stdout.write(child.stdout);
    throw new Error(`${command} failed: ${child.error?.message ?? child.signal ?? `exit ${child.status}`}`);
  }
  return child.stdout;
}

function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== "--python" || !args[1])) {
    throw new Error("Usage: node scripts/ci-cross-runtime.mjs [--python path/to/python]");
  }
  const python = args.length ? resolve(args[1]) : join(backend, ".venv/bin/python");
  const pinnedPython = readFileSync(join(repo, ".python-version"), "utf8").trim();
  const soxr = process.env.TUNEFORGE_SOXR_ROOT;
  if (!soxr) throw new Error("TUNEFORGE_SOXR_ROOT must point to the repository-built host-test runtime");
  const soxrRoot = resolve(soxr);
  const soxrLib = join(soxrRoot, "lib");
  const extension = process.platform === "darwin" ? "dylib" : "so";
  if (!statSync(join(soxrRoot, "include/soxr.h")).isFile() ||
      !statSync(join(soxrLib, `libsoxr.${extension}`)).isFile() ||
      !readFileSync(join(soxrRoot, "provenance.json"), "utf8").includes('"-DWITH_PFFFT=ON"')) {
    throw new Error(`Invalid SoXR host-test runtime: ${soxrRoot}`);
  }
  const fixture = join(backend, "tests/result_sync_fixture.py");
  if (!statSync(fixture).isFile()) throw new Error(`Missing Python producer fixture: ${fixture}`);

  const root = mkdtempSync(join(tmpdir(), "tuneforge-cross-runtime-"));
  try {
    const home = join(root, "home");
    mkdirSync(home);
    const path = process.env.PATH;
    const probeEnv = { PATH: path, HOME: home, TMPDIR: root, XDG_CACHE_HOME: join(root, "cache") };
    const version = run(python, ["-IB", "-c",
      "import platform; print(platform.python_implementation(), platform.python_version())"], probeEnv).trim();
    if (version !== `CPython ${pinnedPython}`) {
      throw new Error(`Expected CPython ${pinnedPython}, got ${version} from ${python}`);
    }
    run(python, ["-IB", "-c",
      "import alembic, cryptography, fastapi, numpy, soundfile, sqlalchemy; from tuneforge_music_core import _native"],
    probeEnv);
    run("ffmpeg", ["-version"], probeEnv);
    run("ffprobe", ["-version"], probeEnv);

    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(TUNEFORGE_|PYTHON|DYLD_|HF_|HUGGINGFACE_|TORCH_|XDG_|APPDATA$|LOCALAPPDATA$)/.test(name)));
    const loader = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
    const cargoHome = process.env.CARGO_HOME ?? join(process.env.HOME ?? dirname(home), ".cargo");
    const rustupHome = process.env.RUSTUP_HOME ?? join(process.env.HOME ?? dirname(home), ".rustup");
    const started = performance.now();
    const output = run("cargo", [
      "test", "--locked", "--color", "never", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
      "--lib", testName, "--", "--exact", "--ignored", "--show-output",
    ], {
      ...env, HOME: home, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
      TMPDIR: root, TMP: root, TEMP: root, XDG_CACHE_HOME: join(root, "cache"),
      TUNEFORGE_SOXR_ROOT: soxrRoot, TUNEFORGE_CROSS_RUNTIME_PYTHON: python,
      [loader]: [soxrLib, process.env[loader]].filter(Boolean).join(delimiter),
    });
    process.stdout.write(output);
    checkPass(output);
    console.log(`Cross-runtime matrix passed in ${((performance.now() - started) / 1000).toFixed(1)}s (Cargo and tests)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
