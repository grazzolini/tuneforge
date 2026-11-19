import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, cpus, release, tmpdir } from "node:os";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values } = parseArgs({ options: {
  dist: { type: "string" },
  variant: { type: "string" },
  openings: { type: "string", default: "50" },
  scenario: { type: "string" },
} });
const preferenceScenarios = ["absent", "valid", "stale"];
const openings = Number(values.openings);
assert.equal(process.platform, "darwin", "WKWebView benchmarking requires macOS");
assert.ok(values.dist && values.variant, "Usage: node scripts/benchmark-chord-dictionary-webview.mjs --dist PATH --variant NAME");
assert.ok(Number.isInteger(openings) && openings >= 1 && openings <= 200, "Expected 1–200 warm openings");
assert.ok(!values.scenario || preferenceScenarios.includes(values.scenario), "Expected absent, valid, or stale");
const dist = await realpath(values.dist);
const assets = join(dist, "assets");
assert.equal(await realpath(assets), assets, "Expected a regular bundle assets directory");
const index = join(dist, "index.html");
assert.equal(await realpath(index), index, "Expected a regular bundle index");
const wasm = (await readdir(assets, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".wasm"));
assert.ok(wasm.length, "Expected WASM in the production bundle");
const fingerprints = [];
for (const file of wasm) {
  const bytes = await readFile(join(assets, file.name));
  fingerprints.push({ file: file.name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}

const csp = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const types = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};
const fixture = createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("Cache-Control", "no-store");
  try {
    assert.ok(request.method === "GET" && request.url?.startsWith("/") && !request.url.startsWith("//"));
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (path === "/_probe") {
      response.setHeader("Content-Type", types[".html"]);
      response.end("<!doctype html><html lang=\"en\"><title>Isolation probe</title><body></body></html>");
      return;
    }
    const file = path === "/" ? index : join(dist, path);
    assert.ok(file === index || file.startsWith(assets + sep));
    assert.equal(await realpath(file), file);
    const content = await readFile(file);
    response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
let probeHits = 0;
const probe = createServer((_request, response) => {
  probeHits++;
  response.writeHead(204).end();
});
probe.on("upgrade", (_request, socket) => {
  probeHits++;
  socket.destroy();
});
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const temporary = await mkdtemp(join(tmpdir(), "tuneforge-dictionary-webview-"));
try {
  const runner = join(temporary, "runner");
  const swift = fileURLToPath(new URL("benchmark-chord-dictionary-webview.swift", import.meta.url));
  await run("xcrun", ["swiftc", "-O", swift, "-o", runner], { timeout: 120_000 });
  const [port, probePort] = await Promise.all([listen(fixture), listen(probe)]);
  const runScenario = async (scenario, samples, extra = []) => {
    const rules = join(temporary, extra.length ? "probe" : scenario);
    await mkdir(rules);
    const { stdout } = await run(
      runner, [String(port), rules, scenario, String(samples), ...extra],
      { timeout: (40 + samples) * 1000 },
    ).catch(error => {
      const detail = error.stderr?.split("\n").find(line => line.startsWith("WKWebView benchmark:"));
      throw new Error(detail ?? `WKWebView runner exited in the ${extra.length ? "probe" : scenario} case`);
    });
    return JSON.parse(stdout);
  };
  const isolation = await runScenario("absent", 1, [String(probePort)]);
  assert.deepEqual(isolation.blocked, { fetch: true, xhr: true, image: true, websocket: true });
  assert.equal(probeHits, 0, "The out-of-origin listener observed traffic");

  const rows = [];
  for (const scenario of values.scenario ? [values.scenario] : preferenceScenarios) {
    rows.push(await runScenario(scenario, openings));
  }
  assert.equal(probeHits, 0, "The out-of-origin listener observed traffic");
  console.log(JSON.stringify({
    variant: values.variant,
    environment: { architecture: arch(), release: release(), cpu: cpus()[0]?.model },
    wasm: fingerprints,
    isolation: { blocked: isolation.blocked, probeHits },
    rows,
  }, null, 2));
} finally {
  for (const server of [fixture, probe]) {
    server.close();
    server.closeAllConnections();
  }
  await rm(temporary, { recursive: true, force: true });
}
