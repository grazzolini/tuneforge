import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const API_URL = "http://127.0.0.1:18765";
const PROJECT_ID = "proj_diagnostics";
const CANARIES = [
  "RAW_STDOUT_DIAGNOSTICS_CANARY",
  "RAW_STDERR_DIAGNOSTICS_CANARY",
  "RAW_EXCEPTION_DIAGNOSTICS_CANARY",
  "/private/diagnostics/Secret Song.wav",
];
const FFmpeg_GUIDANCE = "FFmpeg is required for import. Host tool: FFmpeg. Next: Install FFmpeg and ensure ffmpeg is on PATH.";
const DEMUCS_GUIDANCE = "Demucs is required for stem separation. Dependency: Demucs. Next: Install local backend stem dependencies, then retry stem separation.";
const WHISPER_UNREADABLE_GUIDANCE = "Whisper model cache is unreadable. Model/cache: Whisper. Operation: lyrics generation. Next: Fix local cache permissions or re-run setup from an account that can read the model cache.";
const WHISPER_MISSING_GUIDANCE = "Whisper model cache is missing. Model/cache: Whisper. Operation: lyrics generation. Next: Re-run local setup to download the Whisper model asset, then retry lyrics generation.";

export async function runDiagnosticsSmoke({ headed = false, keepArtifacts = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tuneforge-diagnostics-smoke-"));
  let app = null;
  let browser = null;
  let failed = false;
  let stage = "reserving a loopback port";
  try {
    const port = await selectPort();
    const appUrl = `http://127.0.0.1:${port}`;
    stage = "starting Vite";
    app = startVite(port);
    await waitForHttp(appUrl, app);
    stage = "launching Chromium";
    browser = await desktopRequire("playwright").chromium.launch({ headless: !headed });
    const page = await browser.newPage();
    await installTauriDialogStub(page);
    await installApiFixtures(page);
    stage = "running diagnostics assertions";
    await exerciseDiagnostics(page, appUrl);
  } catch (error) {
    failed = true;
    await writeFailureArtifacts(root, browser, stage);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await stopChild(app);
    if (failed || keepArtifacts) {
      console.log(`[diagnostics-smoke] kept sanitized artifacts at ${root}.`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function writeFailureArtifacts(root, browser, stage) {
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  if (browser) {
    const artifactPage = await browser.newPage();
    await artifactPage.setContent(`<main>Diagnostics smoke failed during ${stage}.</main>`);
    await artifactPage.screenshot({ path: join(artifactRoot, "diagnostics-failure.png"), fullPage: true }).catch(() => {});
    await artifactPage.close().catch(() => {});
  }
  await writeFile(
    join(artifactRoot, "summary.json"),
    JSON.stringify({ group: "diagnostics", result: "failed", stage, error: "Diagnostics smoke failed." }),
  );
}

async function exerciseDiagnostics(page, appUrl) {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  const importButton = page.getByRole("button", { name: "Import Track(s)" });
  await importButton.waitFor();
  await importButton.click();
  await page.getByRole("alert").getByText(/Could not import track/).waitFor();
  await page.getByRole("alert").getByText(FFmpeg_GUIDANCE).waitFor();
  await assertSanitized(page, "single FFmpeg import notice");

  await importButton.click();
  await page.getByRole("status").getByText(/1 track imported, 0 duplicates skipped, 1 failed/).waitFor();
  await page.getByRole("status").getByText(FFmpeg_GUIDANCE).waitFor();
  await assertSanitized(page, "batch import summary");

  await page.getByRole("link", { name: "View Activity" }).click();
  await page.getByRole("heading", { name: "Activity" }).waitFor();
  await page.getByRole("list", { name: "Job queue" }).waitFor();
  await page.getByText(DEMUCS_GUIDANCE).waitFor();
  await page.getByText(WHISPER_UNREADABLE_GUIDANCE).waitFor();
  await page.getByText(WHISPER_MISSING_GUIDANCE).waitFor();
  await assertSanitized(page, "Activity jobs");

  await page.goto(`${appUrl}/#/projects/${PROJECT_ID}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Diagnostics Song" }).waitFor();
  await page.getByRole("tab", { name: "Analysis" }).click();
  await page.getByText("Show raw artifacts and processing history").click();
  await page.getByRole("list", { name: "Project job history" }).waitFor();
  await page.getByText(DEMUCS_GUIDANCE).waitFor();
  await page.getByText(WHISPER_UNREADABLE_GUIDANCE).waitFor();
  await page.getByText(WHISPER_MISSING_GUIDANCE).waitFor();
  await assertSanitized(page, "project processing history");
}

async function assertSanitized(page, surface) {
  const text = await page.locator("body").innerText();
  for (const [index, canary] of CANARIES.entries()) {
    if (text.includes(canary)) {
      throw new Error(`${surface} rendered raw diagnostics canary ${index + 1}.`);
    }
  }
}

async function installTauriDialogStub(page) {
  await page.addInitScript(() => {
    const selections = [
      ["/private/diagnostics/Secret Song.wav"],
      ["/private/diagnostics/Good Song.wav", "/private/diagnostics/Bad Song.wav"],
    ];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "plugin:dialog|open") return selections.shift() ?? null;
        if (command === "mobile_capabilities" || command === "backend_base_url") {
          throw new Error("diagnostics HTTP fixture");
        }
        throw new Error("diagnostics native command unavailable");
      },
    };
  });
}

async function installApiFixtures(page) {
  let importCount = 0;
  await page.route(`${API_URL}/api/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "POST" && path === "/api/v1/projects/import") {
      importCount += 1;
      if (importCount === 2) return respond(route, 200, { project: PROJECT });
      return respond(route, 503, dependencyError("FFmpeg is required for import. stderr: RAW_STDERR_DIAGNOSTICS_CANARY"));
    }
    if (path === "/api/v1/health") return respond(route, 200, { status: "ok" });
    if (path === "/api/v1/projects") return respond(route, 200, { projects: [PROJECT], total: 1, limit: 50, offset: 0, has_more: false });
    if (path === `/api/v1/projects/${PROJECT_ID}`) return respond(route, 200, { project: PROJECT });
    if (path === `/api/v1/projects/${PROJECT_ID}/analysis`) return respond(route, 200, { analysis: null });
    if (path === `/api/v1/projects/${PROJECT_ID}/chords`) return respond(route, 200, { chords: [], backend: null });
    if (path === `/api/v1/projects/${PROJECT_ID}/lyrics`) return respond(route, 200, { lyrics: [] });
    if (path === `/api/v1/projects/${PROJECT_ID}/sections`) return respond(route, 200, { sections: [] });
    if (path === `/api/v1/projects/${PROJECT_ID}/artifacts`) return respond(route, 200, { artifacts: [ARTIFACT] });
    if (path === "/api/v1/jobs") return respond(route, 200, jobsResponse(url.searchParams));
    if (path === "/api/v1/beat-backends") return respond(route, 200, { backends: [] });
    if (path === "/api/v1/chord-backends") return respond(route, 200, { backends: [] });
    if (path === "/api/v1/stem-models") return respond(route, 200, { models: [] });
    return respond(route, 200, {});
  });
}

function respond(route, status, body) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function dependencyError(message) {
  return {
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message,
      details: { dependency: "FFmpeg", raw_output: "RAW_STDOUT_DIAGNOSTICS_CANARY", exception: "RAW_EXCEPTION_DIAGNOSTICS_CANARY" },
    },
  };
}

function jobsResponse(params) {
  const statuses = params.getAll("status").flatMap((value) => value.split(",")).filter(Boolean);
  const jobs = !statuses.length ? JOBS : JOBS.filter((job) => statuses.includes(job.status));
  return { jobs, total: jobs.length, limit: 50, offset: 0, has_more: false };
}

const PROJECT = {
  id: PROJECT_ID,
  display_name: "Diagnostics Song",
  source_path: "/private/diagnostics/Secret Song.wav",
  imported_path: "/private/diagnostics/Secret Song.wav",
  duration_seconds: 180,
  sample_rate: 48000,
  created_at: "2026-07-23T12:00:00.000Z",
  updated_at: "2026-07-23T12:00:00.000Z",
};
const ARTIFACT = { id: "art_diagnostics", project_id: PROJECT_ID, kind: "source", format: "wav", created_at: PROJECT.updated_at, path: "/private/diagnostics/Secret Song.wav" };
const JOBS = [
  job("job_demucs", "stems", "Demucs is required for stem separation. stderr: RAW_STDERR_DIAGNOSTICS_CANARY /private/diagnostics/Secret Song.wav"),
  job("job_whisper", "lyrics", "Whisper model cache is unreadable. stdout: RAW_STDOUT_DIAGNOSTICS_CANARY"),
  {
    ...job("job_cache", "lyrics", "Whisper model cache is missing."),
    exception: "RAW_EXCEPTION_DIAGNOSTICS_CANARY",
  },
];
function job(id, type, error_message) {
  return { id, project_id: PROJECT_ID, type, status: "failed", progress: 100, source_artifact_id: "art_diagnostics", error_message, created_at: PROJECT.updated_at, updated_at: PROJECT.updated_at, completed_at: PROJECT.updated_at };
}

function selectPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function startVite(port) {
  const child = spawn(process.execPath, [resolve(repoRoot, "apps/desktop/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: resolve(repoRoot, "apps/desktop"),
    env: { ...process.env, VITE_API_BASE_URL: API_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = { child, exited: false, spawnError: false, exitPromise: null };
  handle.exitPromise = new Promise((resolve) => {
    const finish = () => {
      handle.exited = true;
      resolve();
    };
    child.once("error", () => {
      handle.spawnError = true;
      finish();
    });
    child.once("exit", finish);
  });
  child.stdout.resume();
  child.stderr.resume();
  return handle;
}

async function waitForHttp(url, handle) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (handle.spawnError) throw new Error("diagnostics Vite server failed to start");
    if (handle.exited) throw new Error("diagnostics Vite server exited before startup");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("diagnostics Vite server did not become ready");
}

async function stopChild(handle) {
  if (!handle || handle.exited || !handle.child.pid) return;
  killChild(handle.child, "SIGTERM");
  await Promise.race([handle.exitPromise, delay(3000)]);
  if (!handle.exited) {
    killChild(handle.child, "SIGKILL");
    await Promise.race([handle.exitPromise, delay(1000)]);
  }
}

function killChild(child, signal) {
  try {
    child.kill(signal);
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
