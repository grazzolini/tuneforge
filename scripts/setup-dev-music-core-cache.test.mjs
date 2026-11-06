import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cacheMusicCore } from "./setup-dev-music-core-cache.mjs";

const sha = data => createHash("sha256").update(data).digest("hex");
const exists = path => fs.lstat(path).then(() => true, () => false);
async function write(path, data) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, data); }
function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "music-core-cache-test-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await fs.mkdir(root);
  git(root, "init", "-q");
  const donor = join(base, "donor with spaces\nand newline");
  git(root, "worktree", "add", "--orphan", "-b", "fixture-donor", donor);
  const data = Object.fromEntries(["gingo", "scikit", "pybind", "packaging", "pathspec", "cmake", "emscripten"].map(name => [name, Buffer.from(name.repeat(37))]));
  const pin = name => ({ filename: `${name}.archive`, sha256: sha(data[name]), bytes: data[name].length });
  const lock = { pythonBuildDependencies: ["scikit", "pybind", "packaging", "pathspec", "cmake"], tools: {} };
  for (const name of [...lock.pythonBuildDependencies, "emscripten"]) {
    lock.tools[name] = { version: "1", artifacts: { [name === "cmake" || name === "emscripten" ? "test-arm64" : "any"]: pin(name) } };
  }
  const paths = Object.keys(data).map(name => ({ name, data: data[name], pin: pin(name), relative: name === "gingo" ? `gingo/${sha(data.gingo)}/gingo.tar.gz` : `${name}/1/${name}.archive` }));
  const core = join(root, "packages/music-core");
  await write(join(core, "toolchains.lock.json"), JSON.stringify(lock));
  await write(join(core, "sources.lock.json"), JSON.stringify({ archive: { sha256: sha(data.gingo) } }));
  const local = item => join(core, "build/cache", item.relative);
  const source = item => join(donor, "packages/music-core/build/cache", item.relative);
  const cacheHome = join(base, "shared");
  const cached = item => join(cacheHome, "tuneforge-dev/music-core", item.pin.sha256, item.relative.split("/").at(-1));
  const options = { platform: "test-arm64", env: { XDG_CACHE_HOME: cacheHome } };
  return { root, donor, paths, local, source, cached, options, core, lock, base };
}

test("warm linked donor, independent verified cache, removed donor, no compiled outputs", async t => {
  const f = await fixture(t);
  for (const item of f.paths) await write(f.source(item), item.data);
  await write(join(f.donor, "packages/music-core/build/artifacts/wasm/output.wasm"), "excluded");
  await cacheMusicCore(f.root, "seed", f.options);
  for (const item of f.paths) assert.deepEqual(await fs.readFile(f.local(item)), item.data);
  await cacheMusicCore(f.root, "store", f.options);
  for (const item of f.paths) {
    assert.deepEqual(await fs.readFile(f.cached(item)), item.data);
    assert.notEqual((await fs.stat(f.cached(item))).ino, (await fs.stat(f.local(item))).ino);
  }
  await fs.rm(join(f.donor, "packages"), { recursive: true });
  git(f.root, "worktree", "remove", f.donor);
  await fs.rm(join(f.core, "build"), { recursive: true });
  await cacheMusicCore(f.root, "seed", f.options);
  for (const item of f.paths) assert.deepEqual(await fs.readFile(f.local(item)), item.data);
  assert.equal(await exists(join(f.core, "build/artifacts")), false);
});

test("changed pins and platform select exact archives, with any fallback", async t => {
  const f = await fixture(t);
  for (const item of f.paths) await write(f.source(item), item.data);
  const changed = Buffer.from("new pin");
  f.lock.tools.scikit.artifacts.any = { ...f.lock.tools.scikit.artifacts.any, sha256: sha(changed), bytes: changed.length };
  await write(join(f.core, "toolchains.lock.json"), JSON.stringify(f.lock));
  await cacheMusicCore(f.root, "seed", { ...f.options, platform: "other-platform" });
  assert.equal(await exists(f.local(f.paths[1])), false);
  for (const name of ["cmake", "emscripten"]) assert.equal(await exists(f.local(f.paths.find(item => item.name === name))), false);
  assert.deepEqual(await fs.readFile(f.local(f.paths[2])), f.paths[2].data);
});

test("corrupt, partial, symlink entries rejected; existing locals preserved", async t => {
  const f = await fixture(t);
  const [gingo, scikit, pybind, packaging, pathspec, cmake, emscripten] = f.paths;
  await write(f.cached(gingo), "corrupt shared");
  await write(f.source(gingo), gingo.data);
  await write(f.source(scikit), "wrong");
  await write(`${f.source(pybind)}.partial`, pybind.data);
  await write(join(f.base, "outside"), packaging.data);
  await fs.mkdir(dirname(f.source(packaging)), { recursive: true });
  await fs.symlink(join(f.base, "outside"), f.source(packaging));
  await write(f.local(pathspec), "existing corrupt local");
  await write(f.source(pathspec), pathspec.data);
  const outsideDir = join(f.base, "outside-dir");
  await fs.mkdir(outsideDir);
  await fs.mkdir(dirname(dirname(f.local(cmake))), { recursive: true });
  await fs.symlink(outsideDir, dirname(f.local(cmake)));
  await write(f.source(cmake), cmake.data);
  // Correct hash with an incorrect declared size must also miss.
  f.lock.tools.emscripten.artifacts["test-arm64"].bytes++;
  await write(join(f.core, "toolchains.lock.json"), JSON.stringify(f.lock));
  await write(f.source(emscripten), emscripten.data);
  await cacheMusicCore(f.root, "seed", f.options);
  assert.deepEqual(await fs.readFile(f.local(gingo)), gingo.data);
  for (const item of [scikit, pybind, packaging, emscripten]) assert.equal(await exists(f.local(item)), false);
  assert.equal(await fs.readFile(f.local(pathspec), "utf8"), "existing corrupt local");
  assert.deepEqual(await fs.readdir(outsideDir), []);
  await cacheMusicCore(f.root, "store", f.options);
  assert.deepEqual(await fs.readFile(f.cached(gingo)), gingo.data);
  assert.equal(await exists(f.cached(pathspec)), false);
});

test("concurrent writers publish complete copies and repair corrupt shared files", async t => {
  const f = await fixture(t);
  for (const name of ["toolchains.lock.json", "sources.lock.json"]) {
    await write(join(f.donor, "packages/music-core", name), await fs.readFile(join(f.core, name)));
  }
  for (const item of f.paths) {
    await write(f.local(item), item.data);
    await write(f.source(item), item.data);
    await write(f.cached(item), "broken");
  }
  await Promise.all(Array.from({ length: 6 }, (_, i) => cacheMusicCore(i % 2 ? f.root : f.donor, "store", f.options)));
  for (const item of f.paths) {
    assert.deepEqual(await fs.readFile(f.cached(item)), item.data);
    assert.deepEqual(await fs.readdir(dirname(f.cached(item))), [item.relative.split("/").at(-1)]);
  }
  await fs.rm(join(f.core, "build"), { recursive: true });
  await fs.rm(join(f.donor, "packages/music-core/build"), { recursive: true });
  await Promise.all(Array.from({ length: 6 }, (_, i) => cacheMusicCore(i % 2 ? f.root : f.donor, "seed", f.options)));
  for (const item of f.paths) assert.deepEqual(await fs.readFile(f.local(item)), item.data);
});

test("unavailable or symlink shared cache stays optional and untouched", async t => {
  const f = await fixture(t);
  const blocked = join(f.base, "blocked");
  await write(blocked, "not a directory");
  for (const item of f.paths) await write(f.source(item), item.data);
  const options = { ...f.options, env: { XDG_CACHE_HOME: blocked } };
  await cacheMusicCore(f.root, "seed", options);
  await cacheMusicCore(f.root, "store", options);
  assert.equal(await fs.readFile(blocked, "utf8"), "not a directory");
  for (const item of f.paths) assert.deepEqual(await fs.readFile(f.local(item)), item.data);
  const outside = join(f.base, "outside-cache");
  await fs.mkdir(outside);
  await fs.symlink(outside, f.options.env.XDG_CACHE_HOME);
  await cacheMusicCore(f.root, "store", f.options);
  assert.deepEqual(await fs.readdir(outside), []);
});


test("unsafe lock paths and shared symlink entries cannot redirect writes", async t => {
  const f = await fixture(t);
  const [gingo, scikit] = f.paths;
  const target = join(f.base, "target");
  await write(target, "preserve");
  await fs.mkdir(dirname(f.cached(gingo)), { recursive: true });
  await fs.symlink(target, f.cached(gingo));
  await write(f.local(gingo), gingo.data);
  f.lock.tools.scikit.artifacts.any.filename = "../../escape";
  await write(join(f.core, "toolchains.lock.json"), JSON.stringify(f.lock));
  await write(f.source(scikit), scikit.data);
  await cacheMusicCore(f.root, "seed", f.options);
  await cacheMusicCore(f.root, "store", f.options);
  assert.equal(await fs.readFile(target, "utf8"), "preserve");
  assert.equal((await fs.lstat(f.cached(gingo))).isSymbolicLink(), true);
  assert.equal(await exists(f.local(scikit)), false);
  assert.equal(await exists(join(f.core, "build/cache/escape")), false);
});


test("repository-overriding Git environment cannot redirect fixtures or donor discovery", async t => {
  const other = await fixture(t);
  const config = await fs.readFile(join(other.root, ".git/config"));
  const index = join(other.root, ".git/synthetic-index");
  await write(index, "preserve staged-data sentinel");
  const misleading = {
    GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root,
    GIT_COMMON_DIR: join(other.root, ".git"), GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: join(other.root, ".git/objects"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true",
  };
  const previous = Object.fromEntries(Object.keys(misleading).map(name => [name, process.env[name]]));
  Object.assign(process.env, misleading);
  try {
    const f = await fixture(t);
    for (const item of f.paths) await write(f.source(item), item.data);
    await cacheMusicCore(f.root, "seed", f.options);
    for (const item of f.paths) assert.deepEqual(await fs.readFile(f.local(item)), item.data);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  assert.deepEqual(await fs.readFile(join(other.root, ".git/config")), config);
  assert.equal(await fs.readFile(index, "utf8"), "preserve staged-data sentinel");
  assert.deepEqual(await fs.readdir(join(other.root, ".git/refs/heads")), []);
});

test("cache-home ancestor aliases support absent nested homes; relative XDG retains donors", async t => {
  const f = await fixture(t);
  for (const item of f.paths) await write(f.source(item), item.data);
  const actual = join(f.base, "actual-parent");
  const alias = join(f.base, "parent-alias");
  await fs.mkdir(actual);
  await fs.symlink(actual, alias);
  const options = { ...f.options, env: { XDG_CACHE_HOME: join(alias, "absent", "cache") } };
  await cacheMusicCore(f.root, "seed", options);
  await cacheMusicCore(f.root, "store", options);
  const first = f.paths[0];
  assert.deepEqual(await fs.readFile(join(actual, "absent/cache/tuneforge-dev/music-core", first.pin.sha256, "gingo.tar.gz")), first.data);
  await fs.rm(join(f.core, "build"), { recursive: true });
  await cacheMusicCore(f.root, "seed", { ...f.options, env: { XDG_CACHE_HOME: "relative-cache" } });
  for (const item of f.paths) assert.deepEqual(await fs.readFile(f.local(item)), item.data);
  assert.equal(await exists(join(f.root, "relative-cache")), false);
});

test("actual CLI seeds and stores when invoked through a repository alias", async t => {
  const f = await fixture(t);
  const script = join(f.root, "scripts/setup-dev-music-core-cache.mjs");
  await write(script, await fs.readFile(fileURLToPath(new URL("./setup-dev-music-core-cache.mjs", import.meta.url))));
  for (const item of f.paths) await write(f.source(item), item.data);
  const alias = join(f.base, "checkout-alias");
  await fs.symlink(f.root, alias);
  for (const mode of ["seed", "store"]) {
    const result = spawnSync(process.execPath, [join(alias, "scripts/setup-dev-music-core-cache.mjs"), mode], {
      encoding: "utf8", env: { ...process.env, ...f.options.env },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const item = f.paths[0];
  assert.deepEqual(await fs.readFile(f.local(item)), item.data);
  assert.deepEqual(await fs.readFile(f.cached(item)), item.data);
});
