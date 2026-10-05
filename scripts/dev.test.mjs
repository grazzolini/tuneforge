import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { resolveDevProfile, startDevelopment, canonicalStoragePath, waitForBackend, developmentBackendCommand, reserveBackendSocket } from "./dev.mjs";
import { PRODUCTION_PACKAGE, profilesFromConfig, devTauriOverlay } from "./package-profile.mjs";
import { STORAGE_PROFILE, deriveTestRoot, flatpakProductionRoot, productionDataRoot, productionTransportRoot, testStorageEnvironment } from "./storage-profile.mjs";
import { manifestForTestPackage } from "./package-flatpak.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-dev-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, HOME: root, TUNEFORGE_DATA_DIR: "", TUNEFORGE_SYNC_TRANSPORT_DATA_DIR: "" },
    options: { home: root, platform: "darwin" } };
}
function fakeBackend(code = "") {
  return [process.execPath, "--input-type=module", "-e", String.raw`
    import http from 'node:http'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
    fs.mkdirSync(process.env.TUNEFORGE_DATA_DIR, { recursive: true });
    const health = { data_root: process.env.TUNEFORGE_DATA_DIR, api_base_url: process.env.VITE_API_BASE_URL };
    ` + code + String.raw`
    http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(health)); })
      .listen({ fd: 3 });
  `];
}
const frontend = [process.execPath, "-e", "process.exit(0)"];

test("IDs and storage derive from renamed production configuration", () => {
  const profiles = profilesFromConfig({ identifier: "org.example.renamed", productName: "Renamed", mainBinaryName: "renamed" });
  assert.equal(profiles.test.id, "org.example.renamed.test");
  const profile = structuredClone(STORAGE_PROFILE);
  profile.backend.darwin = "Library/Application Support/Renamed";
  profile.backend.linux = ".local/share/renamed";
  for (const platform of ["darwin", "linux"]) {
    const root = productionDataRoot({ platform, home: "/synthetic", env: {}, profile });
    assert.equal(deriveTestRoot(root, platform, profile), root + (platform === "darwin" ? " Test" : "-test"));
  }
  assert.equal(productionDataRoot({ platform: "linux", home: "/synthetic", env: { XDG_DATA_HOME: "/different" } }), "/synthetic/.local/share/tuneforge");
});

test("both dev modes retain identity and WebView config with TEST visual overlay", (t) => {
  const f = fixture(t);
  const base = JSON.parse(fs.readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)));
  for (const args of [[], ["--production-data"]]) {
    const resolved = resolveDevProfile(args, { env: f.env, ...f.options });
    assert.equal(resolved.env.VITE_TUNEFORGE_DEV_TEST_VISUALS, "1");
    const overlay = devTauriOverlay();
    assert.equal(overlay.app.windows[0].title, "TuneForge Test");
    assert.ok(overlay.bundle.icon.every((value) => value.startsWith("icons/test/")));
    assert.deepEqual(Object.keys(overlay).sort(), ["app", "bundle"]);
    assert.equal(overlay.identifier, undefined);
    assert.equal(overlay.mainBinaryName, undefined);
    assert.equal(overlay.build, undefined);
    assert.equal(base.identifier, PRODUCTION_PACKAGE.id);
    assert.equal(base.build.devUrl, "http://127.0.0.1:1420");
  }
});

test("test mode isolates inherited model and transport overrides", (t) => {
  const f = fixture(t);
  const env = { ...f.env, TORCH_HOME: "/production/torch", HF_HOME: "/production/hf", HF_HUB_CACHE: "/production/hub", HUGGINGFACE_HUB_CACHE: "/production/hub", TRANSFORMERS_CACHE: "/production/transformers", XDG_CACHE_HOME: "/production/cache", TUNEFORGE_LYRICS_CACHE_DIR: "/production/whisper", TUNEFORGE_MODEL_BUNDLE_DIR: "/production/bundle", TUNEFORGE_DEMUCS_MODEL_REPO: "/production/models", TUNEFORGE_SYNC_TRANSPORT_DATA_DIR: "/production/sync" };
  const resolved = resolveDevProfile([], { env, ...f.options });
  for (const key of ["TORCH_HOME", "HF_HOME", "TUNEFORGE_LYRICS_CACHE_DIR", "TUNEFORGE_SYNC_TRANSPORT_DATA_DIR"]) assert.ok(resolved.env[key].startsWith(resolved.dataRoot + path.sep));
  for (const key of ["TUNEFORGE_DEMUCS_MODEL_REPO", "TUNEFORGE_MODEL_BUNDLE_DIR", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE"]) assert.equal(resolved.env[key], undefined);
});

test("both dev modes preserve inherited tool-cache settings, including absent XDG_CACHE_HOME", (t) => {
  const f = fixture(t);
  const toolSettings = {
    UV_CACHE_DIR: path.join(f.root, "tool-cache/uv"),
    npm_config_store_dir: path.join(f.root, "tool-cache/pnpm-store"),
    npm_config_cache_dir: path.join(f.root, "tool-cache/pnpm-cache"),
  };
  for (const args of [[], ["--", "--production-data"]]) {
    for (const xdg of [undefined, path.join(f.root, "tool-cache/xdg")]) {
      const env = { ...f.env, ...toolSettings };
      if (xdg === undefined) delete env.XDG_CACHE_HOME;
      else env.XDG_CACHE_HOME = xdg;
      const resolved = resolveDevProfile(args, { env, ...f.options });
      assert.equal(resolved.env.XDG_CACHE_HOME, xdg);
      assert.equal(Object.hasOwn(resolved.env, "XDG_CACHE_HOME"), xdg !== undefined);
      for (const [key, value] of Object.entries(toolSettings)) assert.equal(resolved.env[key], value);
      assert.equal(testStorageEnvironment(resolved.dataRoot).XDG_CACHE_HOME, path.join(resolved.dataRoot, "cache"));
    }
  }
});

test("production mode preserves overrides and legacy native transport before root injection", (t) => {
  const f = fixture(t);
  const defaults = resolveDevProfile(["--production-data"], { env: f.env, ...f.options });
  assert.equal(defaults.dataRoot, path.join(f.root, "Library/Application Support/Tuneforge"));
  assert.equal(defaults.env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR, path.join(f.root, "Library/Application Support", PRODUCTION_PACKAGE.id, "sync-transport"));
  const env = { ...f.env, TUNEFORGE_DATA_DIR: path.join(f.root, "custom"), TORCH_HOME: "/synthetic/torch", TUNEFORGE_MODEL_BUNDLE_DIR: "/synthetic/bundle" };
  const resolved = resolveDevProfile(["--production-data"], { env, ...f.options });
  assert.equal(resolved.env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR, path.join(env.TUNEFORGE_DATA_DIR, "sync-transport"));
  assert.equal(resolved.env.TORCH_HOME, env.TORCH_HOME);
  assert.equal(resolved.env.TUNEFORGE_MODEL_BUNDLE_DIR, env.TUNEFORGE_MODEL_BUNDLE_DIR);
  env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR = path.join(f.root, "explicit-transport");
  assert.equal(resolveDevProfile(["--production-data"], { env, ...f.options }).env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR, env.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR);
  assert.equal(productionTransportRoot({ platform: "linux", home: f.root, packageId: "org.renamed", env: { XDG_DATA_HOME: path.join(f.root, "xdg") } }), path.join(f.root, "xdg/org.renamed/sync-transport"));
});

test("fixture overrides reject production ancestors, descendants and symlink aliases", (t) => {
  const f = fixture(t);
  const production = path.join(f.root, "Library/Application Support/Tuneforge");
  fs.mkdirSync(production, { recursive: true });
  fs.symlinkSync(production, path.join(f.root, "alias"));
  for (const root of [production, path.dirname(production), production + "/missing/subdir", path.join(f.root, "alias"), path.join(f.root, "alias/missing")]) {
    const env = { ...f.env, TUNEFORGE_DATA_DIR: root };
    assert.throws(() => resolveDevProfile([], { env, ...f.options }), /overlaps production/);
    assert.doesNotThrow(() => resolveDevProfile(["--production-data"], { env, ...f.options }));
  }
  const isolated = path.join(f.root, "fixture");
  assert.equal(resolveDevProfile([], { env: { ...f.env, TUNEFORGE_DATA_DIR: isolated }, ...f.options }).dataRoot, isolated);
  assert.equal(canonicalStoragePath(path.join(f.root, "alias/missing")), canonicalStoragePath(production + "/missing"));
});

test("Flatpak test derives selected storage mode and grants", () => {
  const manifest = fs.readFileSync(new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url), "utf8");
  for (const sandboxData of [false, true]) {
    const result = manifestForTestPackage(manifest, { sandboxData });
    const root = deriveTestRoot(flatpakProductionRoot({ sandboxData }), "linux");
    assert.ok(result.includes("--env=TUNEFORGE_DATA_DIR=" + root));
    assert.ok(result.includes("--env=TUNEFORGE_SYNC_TRANSPORT_DATA_DIR=" + root + "/sync-transport"));
    assert.ok(result.includes("--env=TORCH_HOME=" + root + "/cache/torch"));
    assert.ok(result.includes("TUNEFORGE_PACKAGE_DATA_ROOT: " + flatpakProductionRoot({ sandboxData })));
    assert.equal(result.includes("--filesystem=xdg-data/tuneforge-test:create"), !sandboxData);
    assert.equal(result.includes("--filesystem=xdg-cache/torch:create"), false);
    assert.equal(result.includes("--env=XDG_CACHE_HOME=/var/cache/"), false);
    assert.equal(result.includes(PRODUCTION_PACKAGE.id + ".test"), true);
  }
});

test("launcher starts frontend only after matching owned backend readiness, both modes", async (t) => {
  const f = fixture(t);
  for (const args of [[], ["--production-data"]]) {
    const record = path.join(f.root, "frontend-" + args.length + ".json");
    const env = { ...f.env, RECORD: record };
    const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.env.RECORD, JSON.stringify(Object.fromEntries(['TUNEFORGE_PORT', 'TUNEFORGE_DEV_API_BASE_URL', 'VITE_API_BASE_URL', 'TUNEFORGE_DATA_DIR', 'VITE_TUNEFORGE_DEV_TEST_VISUALS'].map(key => [key, process.env[key]]))))"];
    const outcome = await startDevelopment({ args, env, profileOptions: f.options, backendCommand: fakeBackend(), frontendCommand: command, stdio: "ignore", handleSignals: false, timeoutMs: 3000 });
    const saved = JSON.parse(fs.readFileSync(record));
    assert.equal(saved.TUNEFORGE_PORT, String(outcome.port));
    assert.equal(saved.TUNEFORGE_DEV_API_BASE_URL, "http://127.0.0.1:" + outcome.port);
    assert.equal(saved.VITE_API_BASE_URL, saved.TUNEFORGE_DEV_API_BASE_URL + "/api/v1");
    assert.equal(saved.TUNEFORGE_DATA_DIR, outcome.dataRoot);
    assert.equal(saved.VITE_TUNEFORGE_DEV_TEST_VISUALS, "1");
  }
});

test("readiness fails closed for wrong root or URL and never starts frontend", async (t) => {
  const f = fixture(t);
  for (const code of ["health.data_root = '/synthetic/wrong-root';", "health.api_base_url = 'http://127.0.0.1:1/api/v1';"]) {
    const record = path.join(f.root, "unexpected-frontend");
    await assert.rejects(startDevelopment({ env: f.env, profileOptions: f.options, backendCommand: fakeBackend(code), frontendCommand: [process.execPath, "-e", "require('node:fs').writeFileSync('" + record + "', 'started')"], stdio: "ignore", handleSignals: false, timeoutMs: 2000 }), /does not match/);
    assert.equal(fs.existsSync(record), false);
  }
});

test("child exit, spawn failure, timeout and port collision fail closed", async (t) => {
  const f = fixture(t);
  for (const [command, expected] of [[[process.execPath, "-e", "process.exit(7)"], /exited before/], [["/synthetic/missing-command"], /ENOENT/], [[process.execPath, "-e", "setInterval(()=>{},1000)"], /timed out/]]) {
    await assert.rejects(startDevelopment({ env: f.env, profileOptions: f.options, backendCommand: command, frontendCommand: frontend, stdio: "ignore", handleSignals: false, timeoutMs: 300 }), expected);
  }
  const expectedRoot = resolveDevProfile([], { env: f.env, ...f.options }).dataRoot;
  const server = http.createServer((req, res) => res.end(JSON.stringify({ data_root: expectedRoot, api_base_url: "http://127.0.0.1:" + server.address().port + "/api/v1" })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await assert.rejects(startDevelopment({ env: f.env, profileOptions: f.options, port: server.address().port, backendCommand: [process.execPath, "-e", "setInterval(()=>{},1000)"], frontendCommand: frontend, stdio: "ignore", handleSignals: false, timeoutMs: 1000 }), /EADDRINUSE/);
  assert.equal(server.listening, true);
});

test("liveness is rechecked after a health response", async () => {
  const child = { exitCode: null, signalCode: null };
  await assert.rejects(waitForBackend(child, 1234, "/synthetic", { timeoutMs: 500, fetchHealth: async () => {
    child.exitCode = 7;
    return { ok: true, json: async () => ({ data_root: "/synthetic", api_base_url: "http://127.0.0.1:1234/api/v1" }) };
  } }), /exited before/);
});

test("cleanup signals owned wrapper descendants while external children remain alive", async (t) => {
  const f = fixture(t);
  const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => external.kill());
  const pidFile = path.join(f.root, "descendant-pid");
  const code = "const nested = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{}); process.stdout.write(\"ready\"); setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] }); await new Promise(resolve => nested.stdout.once('data', resolve)); fs.writeFileSync(process.env.PID_FILE, String(nested.pid));";
  await startDevelopment({ env: { ...f.env, PID_FILE: pidFile }, profileOptions: f.options, backendCommand: fakeBackend(code), frontendCommand: frontend, stdio: "ignore", handleSignals: false, timeoutMs: 2000, shutdownGraceMs: 300 });
  const pid = Number(fs.readFileSync(pidFile));
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    await delay(50);
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
  }
  assert.equal(alive, false);
  assert.doesNotThrow(() => process.kill(external.pid, 0));
});

test("renamed Linux default propagates to Flatpak host and sandbox roots and grants", () => {
  const profile = structuredClone(STORAGE_PROFILE);
  profile.backend.linux = ".local/share/renamed";
  const manifest = fs.readFileSync(new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url), "utf8");
  for (const sandboxData of [false, true]) {
    const selected = flatpakProductionRoot({ sandboxData, profile });
    const result = manifestForTestPackage(manifest, { sandboxData, storageProfile: profile });
    assert.equal(selected, sandboxData ? "/var/data/renamed" : "~/.local/share/renamed");
    assert.ok(result.includes("--env=TUNEFORGE_DATA_DIR=" + selected + "-test"));
    assert.equal(result.includes("--filesystem=xdg-data/renamed-test:create"), !sandboxData);
    assert.equal(result.includes("--filesystem=xdg-data/tuneforge:create"), false);
  }
});

test("renamed base ID propagates to manifest and extension refs", () => {
  const baseConfig = JSON.parse(fs.readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)));
  baseConfig.identifier = "org.example.renamed";
  const manifest = fs.readFileSync(new URL("../packaging/flatpak/com.tuneforge.desktop.yml", import.meta.url), "utf8");
  const result = manifestForTestPackage(manifest, { baseConfig });
  assert.ok(result.includes("app-id: org.example.renamed.test"));
  assert.ok(result.includes("org.example.renamed.test.Torch.Stack.Nvidia.Core"));
  assert.ok(result.includes('"identifier":"org.example.renamed.test"'));
});


test("development backend command retains reload and receives the owned descriptor", () => {
  const command = developmentBackendCommand(12345);
  assert.ok(command.includes("--reload"));
  assert.equal(command[command.indexOf("--fd") + 1], "3");
  assert.equal(command[command.indexOf("--port") + 1], "12345");
});

test("shutdown waits for a draining backend before escalating", async (t) => {
  const f = fixture(t);
  const drained = path.join(f.root, "drained");
  const code = "process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.env.DRAINED, 'completed'); process.exit(0); }, 250));";
  await startDevelopment({ env: { ...f.env, DRAINED: drained }, profileOptions: f.options,
    backendCommand: fakeBackend(code), frontendCommand: frontend, stdio: "ignore", handleSignals: false, timeoutMs: 2000 });
  assert.equal(fs.readFileSync(drained, "utf8"), "completed");
});

test("spawn failure releases the reserved listening socket", async (t) => {
  const f = fixture(t);
  const reservation = await reserveBackendSocket();
  const port = reservation.port;
  await new Promise((resolve) => reservation.server.close(resolve));
  await assert.rejects(startDevelopment({ env: f.env, profileOptions: f.options, port,
    backendCommand: ["/synthetic/missing-command"], frontendCommand: frontend, stdio: "ignore", handleSignals: false }), /ENOENT/);
  const reused = await reserveBackendSocket(port);
  assert.equal(reused.port, port);
  await new Promise((resolve) => reused.server.close(resolve));
});
