import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PRODUCTION_PACKAGE, writeDevTauriOverlay } from "./package-profile.mjs";
import { productionDataRoot, productionTransportRoot, deriveTestRoot, testStorageEnvironment } from "./storage-profile.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function canonicalStoragePath(value) {
  let existing = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveDevProfile(args = [], { env = process.env, platform = process.platform,
  home, cwd = workspaceRoot, profile } = {}) {
  const flags = args.filter((arg) => arg !== "--");
  if (flags.some((arg) => arg !== "--production-data")) throw new Error("Usage: pnpm dev [--production-data]");
  const productionData = flags.includes("--production-data");
  const parts = { env, platform, home, cwd, profile };
  const defaults = productionDataRoot({ ...parts, overrides: false });
  const resolved = productionDataRoot(parts);
  const root = productionData ? resolved : env.TUNEFORGE_DATA_DIR ? resolved : deriveTestRoot(defaults, platform, profile);
  if (!productionData) {
    const transport = productionTransportRoot({ ...parts, env: { ...env, TUNEFORGE_DATA_DIR: "", TUNEFORGE_SYNC_TRANSPORT_DATA_DIR: "" }, packageId: PRODUCTION_PACKAGE.id });
    for (const productionRoot of [defaults, path.dirname(transport)]) {
      const actual = canonicalStoragePath(root);
      const protectedRoot = canonicalStoragePath(productionRoot);
      if (overlaps(actual, protectedRoot) || overlaps(protectedRoot, actual)) {
        throw new Error("Development data overlaps production storage. Use --production-data explicitly.");
      }
    }
  }
  const childEnv = { ...env, TUNEFORGE_DATA_DIR: root, TUNEFORGE_HOST: "127.0.0.1", VITE_TUNEFORGE_DEV_TEST_VISUALS: "1" };
  if (productionData) {
    // Preserve transport precedence before the launcher injects the resolved backend root.
    childEnv.TUNEFORGE_SYNC_TRANSPORT_DATA_DIR = productionTransportRoot({ ...parts, packageId: PRODUCTION_PACKAGE.id });
  } else {
    const storageEnv = testStorageEnvironment(root);
    delete storageEnv.XDG_CACHE_HOME;
    Object.assign(childEnv, storageEnv);
    delete childEnv.TUNEFORGE_DEMUCS_MODEL_REPO;
    delete childEnv.TUNEFORGE_MODEL_BUNDLE_DIR;
    // Explicit Hugging Face cache overrides otherwise outrank HF_HOME.
    delete childEnv.HF_HUB_CACHE;
    delete childEnv.HUGGINGFACE_HUB_CACHE;
    delete childEnv.TRANSFORMERS_CACHE;
  }
  return { productionData, dataRoot: root, env: childEnv };
}

export function reserveBackendSocket(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      // Node exposes the listening descriptor on its native handle for POSIX stdio passing.
      const fd = server._handle?.fd;
      if (!Number.isInteger(fd) || fd < 0) {
        server.close();
        reject(new Error("Development backend requires socket descriptor passing."));
        return;
      }
      resolve({ server, fd, port: server.address().port });
    });
  });
}

export function developmentBackendCommand(port) {
  return ["bash", "scripts/run-backend-module.sh", "uvicorn", "app.main:app", "--reload",
    "--host", "127.0.0.1", "--port", String(port), "--fd", "3"];
}

function spawnOwned(command, env, cwd, stdio) {
  const child = spawn(command[0], command.slice(1), { env, cwd, stdio, detached: process.platform !== "win32" });
  child.failure = null;
  child.once("error", (error) => { child.failure = error; });
  return child;
}

function assertAlive(child, label) {
  if (child.failure) throw child.failure;
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(label + " exited before startup completed.");
}

export async function stopOwned(children, { graceMs = 5000 } = {}) {
  const signal = (child, name) => {
    if (!child.pid) return false;
    try {
      if (process.platform === "win32") return child.kill(name);
      process.kill(-child.pid, name);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      if (name === 0 && error.code === "EPERM") return true;
      throw error;
    }
  };
  const alive = (child) => process.platform === "win32"
    ? child.exitCode === null && child.signalCode === null : signal(child, 0);
  const wait = async (ms) => {
    const deadline = Date.now() + ms;
    while (children.some(alive) && Date.now() < deadline) await delay(25);
  };
  for (const child of children) signal(child, "SIGTERM");
  await wait(graceMs);
  for (const child of children) if (alive(child)) signal(child, "SIGKILL");
  await wait(1000);
}

export async function waitForBackend(child, port, dataRoot, { timeoutMs = 30_000, fetchHealth = fetch } = {}) {
  const apiBaseUrl = "http://127.0.0.1:" + port + "/api/v1";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertAlive(child, "Backend");
    try {
      const response = await fetchHealth(apiBaseUrl + "/health", { signal: AbortSignal.timeout(Math.min(500, timeoutMs)) });
      assertAlive(child, "Backend");
      if (response.ok) {
        const health = await response.json();
        assertAlive(child, "Backend");
        if (health.api_base_url !== apiBaseUrl || typeof health.data_root !== "string" ||
          canonicalStoragePath(health.data_root) !== canonicalStoragePath(dataRoot)) {
          throw new Error("Backend health does not match the owned API URL and data root.");
        }
        return;
      }
    } catch (error) {
      assertAlive(child, "Backend");
      if (error.message.includes("Backend health does not match")) throw error;
    }
    await delay(50);
  }
  throw new Error("Backend readiness timed out.");
}

export async function startDevelopment({ args = [], env = process.env, cwd = workspaceRoot,
  profileOptions = {}, backendCommand, frontendCommand, port, timeoutMs, fetchHealth,
  stdio = "inherit", handleSignals = true, shutdownGraceMs } = {}) {
  const profile = resolveDevProfile(args, { env, cwd, ...profileOptions });
  const reservation = await reserveBackendSocket(port);
  port = reservation.port;
  const base = "http://127.0.0.1:" + port;
  const childEnv = { ...profile.env, TUNEFORGE_PORT: String(port), TUNEFORGE_DEV_API_BASE_URL: base, VITE_API_BASE_URL: base + "/api/v1" };
  backendCommand ??= developmentBackendCommand(port);
  const children = [];
  let stopped = false;
  let stopping;
  const stop = () => { stopped = true; return stopping ??= stopOwned(children, { graceMs: shutdownGraceMs }); };
  const onSignal = () => { void stop(); };
  if (handleSignals) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    const backendStdio = typeof stdio === "string" ? [stdio, stdio, stdio, reservation.fd]
      : [...stdio.slice(0, 3), reservation.fd];
    const backend = spawnOwned(backendCommand, childEnv, cwd, backendStdio);
    children.push(backend);
    await new Promise((resolve, reject) => {
      backend.once("spawn", resolve);
      backend.once("error", reject);
    });
    // The child now holds FD3; close our acceptor before sending any health request.
    await new Promise((resolve) => reservation.server.close(resolve));
    await waitForBackend(backend, port, profile.dataRoot, { timeoutMs, fetchHealth });
    if (stopped) throw new Error("Development startup interrupted.");
    assertAlive(backend, "Backend");
    if (!frontendCommand) {
      const overlay = writeDevTauriOverlay(path.join(cwd, "apps/desktop/src-tauri"));
      frontendCommand = ["pnpm", "--filter", "@tuneforge/desktop", "tauri", "dev", "--config", overlay];
    }
    const frontend = spawnOwned(frontendCommand, childEnv, cwd, stdio);
    children.push(frontend);
    const outcome = await Promise.race(children.map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ child, code, signal }));
      if (child.failure) reject(child.failure);
      else if (child.exitCode !== null || child.signalCode !== null) resolve({ child, code: child.exitCode, signal: child.signalCode });
    })));
    if (!stopped && (outcome.child === backend || outcome.code !== 0)) {
      throw new Error((outcome.child === backend ? "Backend" : "Frontend") + " exited (" + (outcome.signal ?? outcome.code) + ").");
    }
    return { dataRoot: profile.dataRoot, port };
  } finally {
    if (reservation.server.listening) await new Promise((resolve) => reservation.server.close(resolve));
    await stop();
    if (handleSignals) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDevelopment({ args: process.argv.slice(2) }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
