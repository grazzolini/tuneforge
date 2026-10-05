import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STORAGE_PROFILE = JSON.parse(fs.readFileSync(
  new URL("../apps/backend/app/storage-profile.json", import.meta.url), "utf8"));

export function expandStoragePath(value, { home = os.homedir(), cwd = process.cwd() } = {}) {
  return path.resolve(cwd, value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
}

export function productionDataRoot({ platform = process.platform, home = os.homedir(), env = process.env,
  profile = STORAGE_PROFILE, cwd = process.cwd(), overrides = true } = {}) {
  return overrides && env.TUNEFORGE_DATA_DIR
    ? expandStoragePath(env.TUNEFORGE_DATA_DIR, { home, cwd })
    : path.join(home, profile.backend[platform] ?? profile.backend.linux);
}

export function deriveTestRoot(productionRoot, platform = process.platform, profile = STORAGE_PROFILE) {
  const parsed = path.parse(productionRoot);
  if (!parsed.base) throw new Error("Production storage root must have a final path component.");
  return path.join(parsed.dir, parsed.base + (profile.testSuffix[platform] ?? profile.testSuffix.linux));
}

export function productionTransportRoot({ platform = process.platform, home = os.homedir(),
  env = process.env, packageId, profile = STORAGE_PROFILE, cwd = process.cwd() } = {}) {
  if (env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR?.trim()) return env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR.trim();
  if (env.TUNEFORGE_DATA_DIR?.trim()) return path.join(env.TUNEFORGE_DATA_DIR.trim(), "sync-transport");
  let nativeRoot;
  if (platform === "linux" && env.XDG_DATA_HOME?.trim()) nativeRoot = path.join(env.XDG_DATA_HOME.trim(), packageId);
  else {
    const value = (profile.native[platform] ?? profile.native.linux)
      .replace("{packageId}", packageId).replace("{appData}", env.APPDATA ?? "");
    if (platform === "win32" && !env.APPDATA) throw new Error("APPDATA is required for sync transport state.");
    nativeRoot = path.resolve(home, value);
  }
  return path.join(nativeRoot, "sync-transport");
}

export function testStorageEnvironment(root) {
  const cache = path.join(root, "cache");
  return {
    TUNEFORGE_DATA_DIR: root,
    TUNEFORGE_SYNC_TRANSPORT_DATA_DIR: path.join(root, "sync-transport"),
    XDG_CACHE_HOME: cache,
    TORCH_HOME: path.join(cache, "torch"),
    HF_HOME: path.join(cache, "huggingface"),
    TUNEFORGE_LYRICS_CACHE_DIR: path.join(cache, "whisper"),
  };
}

export function flatpakProductionRoot({ sandboxData = false, profile = STORAGE_PROFILE } = {}) {
  return sandboxData ? path.posix.join(profile.flatpak.sandboxBase, path.posix.basename(profile.backend.linux)) : "~/" + profile.backend.linux;
}
