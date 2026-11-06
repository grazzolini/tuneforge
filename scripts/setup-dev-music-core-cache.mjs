import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Cache failures are optional optimizations; the canonical producer owns build errors.
async function parents(path, create = false) {
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (create) await fs.mkdir(current).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (!(await fs.lstat(current)).isDirectory()) throw new Error("Unsafe cache directory");
  }
}
const stat = path => fs.lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
async function valid(path, pin) {
  try {
    await parents(path);
    const input = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await input.stat();
      if (!info.isFile() || (pin.bytes !== undefined && info.size !== pin.bytes)) return false;
      const hash = createHash("sha256");
      for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
      return hash.digest("hex") === pin.sha256;
    } finally { await input.close(); }
  } catch { return false; }
}
async function copy(source, destination, pin, replace = false) {
  let temporary;
  try {
    await parents(source);
    await parents(destination, true);
    const existing = await stat(destination);
    if (existing && (!replace || !existing.isFile())) return false;
    const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await input.stat();
      if (!info.isFile() || (pin.bytes !== undefined && info.size !== pin.bytes)) return false;
      temporary = `${destination}.${randomUUID()}.partial`;
      const output = await fs.open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          bytes += chunk.length;
          await output.writeFile(chunk);
        }
      } finally { await output.close(); }
      if (hash.digest("hex") !== pin.sha256 || (pin.bytes !== undefined && bytes !== pin.bytes)) return false;
    } finally { await input.close(); }
    await parents(destination);
    if (replace) {
      const existing = await stat(destination);
      if (existing && !existing.isFile()) return false;
      await fs.rename(temporary, destination);
    } else {
      // Publish without overwriting a local file created by another setup process.
      await fs.link(temporary, destination);
    }
    return true;
  } catch { return false; }
  finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}
function worktrees(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", env });
  if (result.status !== 0) return [];
  return result.stdout.split("\0").filter(field => field.startsWith("worktree "))
    .map(field => field.slice(9)).filter(path => isAbsolute(path) && path !== root);
}
async function cachePath(home) {
  if ((await stat(home))?.isSymbolicLink()) throw new Error("Unsafe cache home");
  const missing = [basename(home)];
  let ancestor = dirname(home);
  for (;;) {
    try { return join(await fs.realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== "ENOENT" || ancestor === dirname(ancestor)) throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}
export async function cacheMusicCore(root, mode, { platform = `${process.platform}-${process.arch}`, env = process.env } = {}) {
  try {
    if (!["seed", "store"].includes(mode)) return;
    root = await fs.realpath(root);
    const core = join(root, "packages/music-core");
    const lock = JSON.parse(await fs.readFile(join(core, "toolchains.lock.json"), "utf8"));
    const sources = JSON.parse(await fs.readFile(join(core, "sources.lock.json"), "utf8"));
    const pins = [{ ...sources.archive, path: `gingo/${sources.archive.sha256}/gingo.tar.gz` }];
    for (const name of [...lock.pythonBuildDependencies, "emscripten"]) {
      const tool = lock.tools[name];
      const artifact = tool.artifacts[platform] ?? tool.artifacts.any;
      if (artifact) pins.push({ ...artifact, path: `${name}/${tool.version}/${artifact.filename}` });
    }
    const cacheHome = isAbsolute(env.XDG_CACHE_HOME ?? "") ? env.XDG_CACHE_HOME : join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache");
    // Only ancestors above the chosen home may be aliases (for example macOS /var).
    const shared = await cachePath(cacheHome).then(home => join(home, "tuneforge-dev/music-core")).catch(() => null);
    let donors;
    for (const pin of pins) {
      if (!/^[a-f0-9]{64}$/.test(pin.sha256) || pin.path.split("/").some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")) continue;
      const local = join(core, "build/cache", pin.path);
      const cached = shared && join(shared, pin.sha256, pin.path.split("/").at(-1));
      try {
        if (mode === "store") {
          if (cached && !await valid(cached, pin)) await copy(local, cached, pin, true);
        } else if (!await stat(local)) {
          if (cached && await copy(cached, local, pin)) continue;
          donors ??= worktrees(root);
          for (const donor of donors) {
            if (await copy(join(donor, "packages/music-core/build/cache", pin.path), local, pin)) break;
          }
        }
      } catch { /* Leave unavailable or existing local entries to the producer. */ }
    }
  } catch { /* Missing cache metadata must not change setup's failure contract. */ }
}
if (import.meta.main) {
  await cacheMusicCore(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.argv[2]);
}
