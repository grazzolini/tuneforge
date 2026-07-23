#!/usr/bin/env node

import process from "node:process";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { runDiagnosticsSmoke } from "./diagnostics-smoke.mjs";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_MANUAL_APP_URL = "http://127.0.0.1:1420";
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const CHILD_TAIL_LINES = 40;
const CAPTURE_SAMPLE_RATE = 48_000;
const CAPTURE_CHANNELS = 2;
const CAPTURE_STARTUP_GRACE_MS = 1000;
const CAPTURE_ANALYZER_TIMEOUT_MS = 120_000;
const SUPPORTED_CAPTURE_PROVIDERS = new Set(["auto", "pipewire", "pulse", "avfoundation"]);
const SMOKE_GROUPS = [
  { name: "playback", description: "Generated-fixture playback controls smoke.", ci: true },
  { name: "diagnostics", description: "Sanitized import and processing diagnostics smoke.", ci: true },
  { name: "audio-capture", description: "Playback smoke with required local audio capture.", ci: false },
];

if (isDirectRun()) {
  try {
    await main();
  } catch (error) {
    console.error(`[playback-smoke] ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.list) {
    printGroups();
    return;
  }
  if (!options.run) {
    printScaffold();
    return;
  }

  if (options.groups.length) {
    await runGroups(options);
    return;
  }

  if (options.manualApp) {
    await runManualSmoke(options);
    return;
  }

  if (options.projectId) {
    throw new Error(
      [
        "Isolated playback smoke creates its own fixture project.",
        'Use manual mode for an existing project: pnpm --filter @tuneforge/desktop test:e2e -- --run --manual-app --project-id="<id>"',
      ].join("\n"),
    );
  }

  await runIsolatedSmoke(options);
}

async function runGroups(options) {
  if (options.manualApp && options.groups.some((group) => group === "diagnostics")) {
    throw new Error("Manual-app mode supports only playback and audio-capture groups.");
  }
  for (const group of options.groups) {
    const startedAt = performance.now();
    try {
      if (group === "diagnostics") {
        await runDiagnosticsSmoke({ headed: options.headed, keepArtifacts: options.keepArtifacts });
      } else {
        const groupOptions = optionsForGroup(options, group);
        if (groupOptions.manualApp) {
          await runManualSmoke(groupOptions);
        } else {
          await runIsolatedSmoke(groupOptions);
        }
      }
      console.log(`[playback-smoke] group ${group}: passed in ${formatDuration(performance.now() - startedAt)}.`);
    } catch (error) {
      console.error(`[playback-smoke] group ${group}: failed in ${formatDuration(performance.now() - startedAt)}.`);
      throw error;
    }
  }
}

export function optionsForGroup(options, group) {
  return {
    ...options,
    captureAudio: group === "audio-capture",
    requireAudioCapture: group === "audio-capture",
  };
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function printGroups() {
  console.log("[playback-smoke] available groups:");
  for (const group of SMOKE_GROUPS) {
    console.log(`  ${group.name}${group.ci ? " (CI)" : ""}: ${group.description}`);
  }
}

function printScaffold() {
  console.log("[playback-smoke] Local smoke scaffold is available.");
  console.log("Run isolated smoke with generated fixture data:");
  console.log("  pnpm --filter @tuneforge/desktop test:e2e -- --run");
  console.log("Run against an existing personal library app:");
  console.log(
    '  pnpm --filter @tuneforge/desktop test:e2e -- --run --manual-app --project-name="Demo Song"',
  );
  console.log("Optional local virtual-audio capture:");
  console.log(
    "  pnpm --filter @tuneforge/desktop test:e2e -- --run --capture-audio --route-output",
  );
}

async function runManualSmoke(options) {
  if (!options.projectId && !options.projectName) {
    throw new Error(
      [
        "Manual app smoke requires --project-id or --project-name.",
        'Example: pnpm --filter @tuneforge/desktop test:e2e -- --run --manual-app --project-name="Demo Song"',
      ].join("\n"),
    );
  }
  if (options.routeOutput) {
    throw new Error(
      [
        "--route-output is supported only by isolated generated-fixture smoke.",
        "Use --capture-device=<name-or-id> for explicit manual-app capture without system output routing.",
      ].join("\n"),
    );
  }

  const captureTempRoot = options.captureAudio && !options.captureOutput
    ? await mkdtemp(join(tmpdir(), "tuneforge-playback-capture-"))
    : null;
  const defaultCaptureOutput = captureTempRoot
    ? join(captureTempRoot, "playback-smoke-capture.wav")
    : null;
  let captureResult = null;

  try {
    captureResult = await runWithOptionalAudioCapture(options, {
      defaultOutputPath: defaultCaptureOutput,
      onStop: (result) => {
        captureResult = result;
      },
      run: async (capture) => runSmoke({
        appUrl: options.appUrl,
        projectId: options.projectId,
        projectName: options.projectName,
        headed: options.headed,
        requireTelemetry: false,
        recordPhase: capture?.recordPhase,
        captureTiming: Boolean(capture),
        captureTimingRequired: Boolean(capture) && options.requireAudioCapture,
      }),
    });
  } finally {
    await cleanupCaptureTempRoot(captureTempRoot, options, captureResult);
  }
}

async function runIsolatedSmoke(options) {
  const appPort = await selectPort(options.appPort, new Set(), "desktop dev server");
  const backendPort = await selectPort(options.backendPort, new Set([appPort]), "backend");
  const tempRoot = await mkdtemp(join(tmpdir(), "tuneforge-playback-smoke-"));
  const dataDir = join(tempRoot, "data");
  const workDir = join(tempRoot, "work");
  const children = [];
  let fixture = null;
  let captureResult = null;
  let failed = false;

  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    logStep(`Using temp root ${tempRoot}.`);
    fixture = await createPlaybackFixture({ dataDir, workDir, projectName: options.projectName });
    logStep(
      `Seeded fixture project ${fixture.project_id} (${fixture.project_name ?? "unnamed"}) in ${dataDir}.`,
    );

    const backendUrl = `http://127.0.0.1:${backendPort}`;
    const appUrl = `http://127.0.0.1:${appPort}`;
    const backend = startChild("backend", "bash", [
      "scripts/run-backend-module.sh",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(backendPort),
    ], {
      TUNEFORGE_DATA_DIR: dataDir,
      TUNEFORGE_HOST: "127.0.0.1",
      TUNEFORGE_PORT: String(backendPort),
      TUNEFORGE_ADDITIONAL_CORS_ORIGINS: appUrl,
      PYTHONUNBUFFERED: "1",
    });
    children.push(backend);
    await waitForHttp(`${backendUrl}/api/v1/health`, {
      label: "backend health",
      child: backend,
      timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
    logStep(`Backend ready on ${backendUrl}.`);

    const app = startChild("desktop dev server", "pnpm", [
      "--filter",
      "@tuneforge/desktop",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(appPort),
      "--strictPort",
    ], {
      VITE_API_BASE_URL: backendUrl,
    });
    children.push(app);
    await waitForHttp(appUrl, {
      label: "desktop dev server",
      child: app,
      timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
    logStep(`Desktop dev server ready on ${appUrl}.`);

    const fixturePath = fixture.app_url_path || `/#/projects/${fixture.project_id}`;
    captureResult = await runWithOptionalAudioCapture(options, {
      defaultOutputPath: join(tempRoot, "capture", "playback-smoke-capture.wav"),
      onStop: (result) => {
        captureResult = result;
      },
      run: async (capture) => runSmoke({
        appUrl,
        projectId: fixture.project_id,
        projectName: fixture.project_name ?? "",
        projectUrl: appendAppPath(appUrl, fixturePath),
        headed: options.headed,
        requireTelemetry: true,
        recordPhase: capture?.recordPhase,
        captureTiming: Boolean(capture),
        captureTimingRequired: Boolean(capture) && options.requireAudioCapture,
        failureArtifactRoot: tempRoot,
      }),
    });
  } catch (error) {
    failed = true;
    await writeSmokeFailureSummary(tempRoot, "isolated playback setup");
    throw error;
  } finally {
    await stopChildren(children);
    if (options.keepArtifacts || failed || captureResult?.keepArtifacts) {
      logStep(`Kept artifacts at ${tempRoot}.`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function runSmoke({
  appUrl,
  projectId,
  projectName,
  projectUrl = "",
  headed,
  requireTelemetry = false,
  recordPhase = () => {},
  captureTiming = false,
  captureTimingRequired = false,
  failureArtifactRoot = "",
}) {
  let chromium;
  try {
    ({ chromium } = desktopRequire("playwright"));
  } catch {
    throw new Error(
      [
        "Playwright is not installed locally.",
        "  pnpm setup:dev",
        "or:",
        "  pnpm install",
        "  pnpm --filter @tuneforge/desktop exec playwright install chromium",
      ].join("\n"),
    );
  }

  const browser = await chromium.launch({ headless: !headed });
  let page;
  let stage = "opening project";

  try {
  page = await browser.newPage();
  recordPhase("smoke:start", { appUrl: projectUrl || appUrl });
  logStep(
    `Running ${headed ? "headed" : "headless"} smoke against ${projectUrl || appUrl} (${projectId ? `project ${projectId}` : `project "${projectName}"`}).`,
  );
  await openProject(page, { appUrl, projectId, projectName, projectUrl });
  await page.getByRole("heading", { name: /.+/ }).first().waitFor();
  recordPhase("project:opened", { projectId: projectId || null, projectName: projectName || null });
  logStep("Project opened.");
  stage = "opening playback controls";
  await openPlayback(page);
  recordPhase("playback:opened");
  if (requireTelemetry) {
    await assertPlaybackE2EBridge(page);
    recordPhase("telemetry:ready");
  }
  await resetSmokePlaybackState(page);
  recordPhase("playback:reset");

  const durationSeconds = await readPlaybackDuration(page);
  recordPhase("playback:ready", { durationSeconds });
  logStep(`Playback tab ready. Duration: ${formatSeconds(durationSeconds)}.`);
  const playbackBpmInput = page.getByRole("spinbutton", { name: "Playback BPM" });
  await playbackBpmInput.fill("128");
  await playbackBpmInput.press("Enter");
  recordPhase("tempo:set", { bpm: 128 });
  logStep("Playback tempo set to 128 BPM.");
  const scrubberStartSeconds = stoppedStartProbeTime(durationSeconds);
  await seekTo(page, scrubberStartSeconds);
  await expectPosition(page, scrubberStartSeconds, "after stopped scrubber seek");
  await verifyPlayStartsFromSelection(page, scrubberStartSeconds, "stopped scrubber selection");
  recordPhase("scrubber-selection:played", { startSeconds: scrubberStartSeconds });
  logStep(`Stopped scrubber selection started at ${formatSeconds(scrubberStartSeconds)}.`);

  const practiceStartSeconds = await chooseStoppedPracticeSelection(page);
  if (practiceStartSeconds === null) {
    recordPhase("practice-selection:skipped");
    logStep("Skipped stopped lyrics/chords selection; no timed practice target was available.");
  } else {
    await verifyPlayStartsFromSelection(page, practiceStartSeconds, "stopped lyrics/chords selection");
    recordPhase("practice-selection:played", { startSeconds: practiceStartSeconds });
    logStep(`Stopped lyrics/chords selection started at ${formatSeconds(practiceStartSeconds)}.`);
  }

  await page.getByLabel("Enable pre-count").check();
  await seekTo(page, 0);
  await expectPosition(page, 0, "before song-start pre-count");
  recordPhase("song-precount:start", { startSeconds: 0 });
  await page.getByRole("button", { name: "Play playback" }).click();
  const songCountInTelemetry = await assertCountInTelemetry(page, {
    expectedKind: "song-start",
    expectedStartSeconds: 0,
    label: "song-start pre-count",
    requireTelemetry,
  });
  await page.getByRole("button", { name: "Pause playback" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expectPosition(page, 0, "after song-start pre-count smoke");
  if (songCountInTelemetry) {
    recordPhase("song-precount:telemetry-passed", songCountInTelemetry);
    logStep("Song-start pre-count telemetry passed.");
  }

  const loopStartSeconds = Math.min(12.25, Math.max(0.25, durationSeconds * 0.25));
  let loopEndSeconds = Math.min(24.5, Math.max(loopStartSeconds + 0.5, durationSeconds * 0.5));
  loopEndSeconds = Math.min(durationSeconds, loopEndSeconds);
  if (loopEndSeconds - loopStartSeconds < 0.25) {
    throw new Error(
      `Project is too short for smoke loop coverage. Duration: ${durationSeconds.toFixed(3)}s.`,
    );
  }
  const outsideLoopSeconds = Math.min(
    durationSeconds,
    Math.max(loopEndSeconds + 0.5, durationSeconds * 0.9),
  );

  await seekTo(page, loopStartSeconds);
  await expectPosition(page, loopStartSeconds, "after seeking to loop start");
  await page.getByRole("button", { name: "Set loop start" }).click();
  await seekTo(page, loopEndSeconds);
  await expectPosition(page, loopEndSeconds, "after seeking to loop end");
  await page.getByRole("button", { name: "Set loop end" }).click();
  await expectPosition(page, loopStartSeconds, "after setting loop end");
  recordPhase("loop:set", { startSeconds: loopStartSeconds, endSeconds: loopEndSeconds });
  logStep(`Loop set: ${formatSeconds(loopStartSeconds)} to ${formatSeconds(loopEndSeconds)}.`);

  await seekTo(page, outsideLoopSeconds);
  await expectPosition(page, loopStartSeconds, "after seeking outside the loop");
  recordPhase("loop:snapback", { requestedSeconds: outsideLoopSeconds, snappedSeconds: loopStartSeconds });
  logStep("Seek outside loop snapped back to loop start.");

  await page.getByLabel("Enable loop pre-count").check();
  recordPhase("loop-precount:enabled");
  logStep("Song and loop pre-count enabled.");

  recordPhase("loop-playback:start", { startSeconds: loopStartSeconds, endSeconds: loopEndSeconds });
  await page.getByRole("button", { name: "Play playback" }).click();
  const loopCountInTelemetry = await assertCountInTelemetry(page, {
    expectedKind: "loop-start",
    expectedStartSeconds: loopStartSeconds,
    label: "loop pre-count",
    requireTelemetry,
  });
  if (loopCountInTelemetry) {
    recordPhase("loop-precount:telemetry-passed", loopCountInTelemetry);
    logStep("Loop pre-count telemetry passed.");
  }
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
  await assertPlaybackTransportTelemetry(page, {
    expectedLoopEndSeconds: loopEndSeconds,
    expectedLoopStartSeconds: loopStartSeconds,
    expectedState: "playing",
    label: "loop playback",
    requireTelemetry,
  });
  if (captureTiming && requireTelemetry) {
    try {
      const loopRestart = await waitForLoopRestartTelemetry(page, {
        expectedLoopEndSeconds: loopEndSeconds,
        expectedLoopStartSeconds: loopStartSeconds,
        label: "loop playback",
        requireTelemetry,
      });
      if (loopRestart) {
        recordPhase("loop:restart-detected", loopRestart);
        logStep("Loop restart telemetry passed.");
      }
    } catch (error) {
      recordPhase("loop:restart-missing", { message: errorMessage(error) });
      if (captureTimingRequired) {
        throw error;
      }
      logStep(`Skipped capture loop restart timing check: ${errorMessage(error)}`);
    }
  }
  await page.getByRole("button", { name: "Pause playback" }).click();
  await page.getByRole("button", { name: "Play playback" }).click();
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expectPosition(page, loopStartSeconds, "after stop with active loop");
  recordPhase("pause-resume-stop:passed");
  logStep("Play, pause, resume, and stop passed.");
  recordPhase("smoke:passed");
  logStep("Passed.");
} catch (error) {
  recordPhase("smoke:error", { message: errorMessage(error) });
  if (failureArtifactRoot) {
    await writeSmokeFailureArtifacts(failureArtifactRoot, page, stage);
  }
  throw error;
} finally {
  await browser.close();
}
}

async function writeSmokeFailureArtifacts(root, page, stage) {
  await mkdir(root, { recursive: true });
  if (page) {
    await page.screenshot({ path: join(root, "playback-failure.png"), fullPage: true }).catch(() => {});
  }
  await writeSmokeFailureSummary(root, stage);
}

async function writeSmokeFailureSummary(root, stage) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "playback-failure-summary.json"),
    JSON.stringify({ group: "playback", result: "failed", stage, error: "Playback smoke failed." }),
  );
}

export function parseOptions(argv) {
  const parsed = parseCliArgs(argv);
  const manualApp = readFlag(parsed, "manual-app");
  const requireAudioCapture = readFlag(parsed, "require-audio-capture");
  const routeOutput = readFlag(parsed, "route-output");
  const captureProvider = readCaptureProviderOption(parsed);
  const captureDevice = readStringOption(parsed, "capture-device");
  const captureOutput = readStringOption(parsed, "capture-output");
  const selectedGroups = selectGroups(parsed);
  const captureAudio = readFlag(parsed, "capture-audio")
    || requireAudioCapture
    || routeOutput
    || Boolean(captureDevice)
    || Boolean(captureOutput)
    || parsed.values.has("capture-provider");
  const projectId = readStringOption(parsed, "project-id")
    || (manualApp ? process.env.TUNEFORGE_SMOKE_PROJECT_ID || "" : "");
  const projectName = readStringOption(parsed, "project-name")
    || process.env.TUNEFORGE_SMOKE_PROJECT_NAME
    || "";

  if (selectedGroups.length && captureAudio && !selectedGroups.includes("audio-capture")) {
    throw new Error("Selected groups do not accept capture flags; include --group audio-capture or use --all.");
  }

  return {
    run: readFlag(parsed, "run") || selectedGroups.length > 0,
    list: readFlag(parsed, "list"),
    groups: selectedGroups,
    manualApp,
    keepArtifacts: readFlag(parsed, "keep-artifacts"),
    headed: readFlag(parsed, "headed"),
    backendPort: readPortOption(parsed, "backend-port"),
    appPort: readPortOption(parsed, "app-port"),
    captureAudio,
    requireAudioCapture,
    routeOutput,
    captureProvider,
    captureDevice,
    captureOutput,
    appUrl: readStringOption(parsed, "app-url")
      || process.env.TUNEFORGE_SMOKE_APP_URL
      || DEFAULT_MANUAL_APP_URL,
    projectId,
    projectName,
  };
}

function selectGroups(parsed) {
  const rawGroups = parsed.values.get("group") ?? [];
  if (parsed.flags.has("group") || rawGroups.some((group) => !group.trim())) {
    throw new Error("--group requires a group name. Valid groups: playback, diagnostics, audio-capture.");
  }
  const requestedGroups = readStringOptions(parsed, "group");
  const ci = readFlag(parsed, "ci");
  const all = readFlag(parsed, "all");
  if ((ci || all) && requestedGroups.length) {
    throw new Error("--group cannot be combined with --ci or --all.");
  }
  if (ci && all) {
    throw new Error("--ci cannot be combined with --all.");
  }
  const selected = all
    ? SMOKE_GROUPS.map((group) => group.name)
    : ci
      ? SMOKE_GROUPS.filter((group) => group.ci).map((group) => group.name)
      : requestedGroups;
  const validGroups = SMOKE_GROUPS.map((group) => group.name);
  const unknown = selected.filter((group) => !validGroups.includes(group));
  if (unknown.length) {
    throw new Error(`Unknown --group ${unknown.map((group) => `"${group}"`).join(", ")}. Valid groups: ${validGroups.join(", ")}.`);
  }
  return validGroups.filter((group) => selected.includes(group));
}

function parseCliArgs(argv) {
  const flags = new Set();
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const body = arg.slice(2);
    const equalsIndex = body.indexOf("=");
    if (equalsIndex >= 0) {
      addCliValue(values, body.slice(0, equalsIndex), body.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      addCliValue(values, body, next);
      index += 1;
      continue;
    }

    flags.add(body);
  }

  return { flags, values };
}

function addCliValue(values, name, value) {
  values.set(name, [...(values.get(name) ?? []), value]);
}

function readFlag(parsed, name) {
  if (parsed.flags.has(name)) {
    return true;
  }
  return (parsed.values.get(name) ?? []).some((value) => value === "true" || value === "1");
}

function readStringOption(parsed, name) {
  const values = parsed.values.get(name) ?? [];
  return values.at(-1)?.trim() ?? "";
}

function readStringOptions(parsed, name) {
  return (parsed.values.get(name) ?? []).map((value) => value.trim()).filter(Boolean);
}

function readPortOption(parsed, name) {
  const value = readStringOption(parsed, name);
  return value ? parsePort(value, name) : null;
}

function readCaptureProviderOption(parsed) {
  const value = readStringOption(parsed, "capture-provider") || "auto";
  if (!SUPPORTED_CAPTURE_PROVIDERS.has(value)) {
    throw new Error(
      `Invalid --capture-provider value "${value}". Expected auto, pipewire, pulse, or avfoundation.`,
    );
  }
  return value;
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --${name} value "${value}". Expected TCP port 1-65535.`);
  }
  return port;
}

async function runWithOptionalAudioCapture(options, { defaultOutputPath, run, onStop = () => {} }) {
  const capture = await startOptionalAudioCapture(options, { defaultOutputPath });
  let runError = null;
  let stopResult = { keepArtifacts: false, error: null };

  try {
    await run(capture);
  } catch (error) {
    runError = error;
  }

  stopResult = await stopOptionalAudioCapture(capture, { runError });
  onStop(stopResult);

  if (runError) {
    throw runError;
  }
  if (stopResult.error && options.requireAudioCapture) {
    throw stopResult.error;
  }

  return stopResult;
}

async function startOptionalAudioCapture(options, { defaultOutputPath }) {
  if (!options.captureAudio) {
    return null;
  }

  let plan;
  try {
    plan = await buildAudioCapturePlan(options, { defaultOutputPath });
  } catch (error) {
    return handleCaptureUnavailable(options, errorMessage(error));
  }
  if (!plan) {
    return null;
  }
  if (plan.skipReason) {
    return handleCaptureUnavailable(options, plan.skipReason);
  }

  const capture = createAudioCaptureSession(plan, options);
  try {
    await startAudioCaptureSession(capture);
    return capture;
  } catch (error) {
    await cleanupAudioRoute(capture.route);
    return handleCaptureUnavailable(options, errorMessage(error));
  }
}

function handleCaptureUnavailable(options, reason) {
  if (options.requireAudioCapture) {
    throw new Error(`Audio capture required but unavailable: ${reason}`);
  }
  logStep(`Skipped audio capture: ${reason}`);
  return null;
}

async function buildAudioCapturePlan(options, { defaultOutputPath }) {
  const outputPath = resolveCaptureOutputPath(options.captureOutput, defaultOutputPath);
  if (!outputPath) {
    return { skipReason: "no --capture-output path and no temporary output path available" };
  }
  const outputSkipReason = validateCaptureOutputPath(outputPath);
  if (outputSkipReason) {
    return { skipReason: outputSkipReason };
  }
  const sidecarPath = `${stripWavExtension(outputPath)}.timing.json`;
  const analysisOutputPath = `${stripWavExtension(outputPath)}.analysis.json`;

  if (process.platform === "darwin") {
    return buildMacAudioCapturePlan(options, { outputPath, sidecarPath, analysisOutputPath });
  }
  if (process.platform === "linux") {
    return buildLinuxAudioCapturePlan(options, { outputPath, sidecarPath, analysisOutputPath });
  }

  return {
    skipReason: `platform ${process.platform} has no supported virtual-audio capture provider`,
  };
}

async function buildMacAudioCapturePlan(options, paths) {
  if (options.captureProvider !== "auto" && options.captureProvider !== "avfoundation") {
    return { skipReason: `capture provider ${options.captureProvider} is not supported on macOS` };
  }
  if (options.routeOutput) {
    return {
      skipReason: "macOS --route-output is unsupported; system output was not changed",
    };
  }
  if (!options.captureDevice) {
    return {
      skipReason: "macOS AVFoundation capture requires --capture-device=<audio-device-name-or-id>",
    };
  }
  if (!(await commandExists("ffmpeg"))) {
    return { skipReason: "ffmpeg was not found for AVFoundation capture" };
  }

  return {
    ...paths,
    provider: "avfoundation",
    providerCommand: "ffmpeg",
    device: options.captureDevice,
    captureTarget: options.captureDevice,
    captureTargetKind: "avfoundation-device",
    routeOutput: false,
  };
}

async function buildLinuxAudioCapturePlan(options, paths) {
  if (options.captureProvider === "avfoundation") {
    return { skipReason: "AVFoundation capture is only supported on macOS" };
  }
  if (options.routeOutput && options.captureDevice) {
    return {
      skipReason: "use --route-output without --capture-device; the temp virtual sink supplies the capture device",
    };
  }

  const provider = await resolveLinuxCaptureProvider(options.captureProvider);
  if (!provider) {
    return { skipReason: "neither pw-record nor parecord was found" };
  }
  if (provider === "pipewire" && !(await commandExists("pw-record"))) {
    return { skipReason: "pw-record was not found for PipeWire capture" };
  }
  if (provider === "pulse" && !(await commandExists("parecord"))) {
    return { skipReason: "parecord was not found for PulseAudio capture" };
  }
  if (options.routeOutput && !(await commandExists("pactl"))) {
    return { skipReason: "--route-output requires pactl to create and restore a virtual sink" };
  }

  let device = options.captureDevice;
  if (!device && !options.routeOutput) {
    const discovery = await discoverLinuxMonitorSource();
    if (!discovery.device) {
      return {
        skipReason: discovery.reason
          || "no Pulse/PipeWire monitor source found; pass --capture-device or --route-output",
      };
    }
    device = discovery.device;
  }

  return {
    ...paths,
    provider,
    providerCommand: provider === "pipewire" ? "pw-record" : "parecord",
    device,
    captureTarget: device,
    captureTargetKind: device ? "capture-device" : "",
    routeOutput: options.routeOutput,
  };
}

async function resolveLinuxCaptureProvider(requestedProvider) {
  if (requestedProvider === "pipewire" || requestedProvider === "pulse") {
    return requestedProvider;
  }
  if (await commandExists("pw-record")) {
    return "pipewire";
  }
  if (await commandExists("parecord")) {
    return "pulse";
  }
  return null;
}

function resolveCaptureOutputPath(captureOutput, defaultOutputPath) {
  const rawPath = captureOutput || defaultOutputPath || "";
  return rawPath ? resolve(rawPath) : "";
}

export function validateCaptureOutputPath(outputPath) {
  return extname(outputPath).toLowerCase() === ".wav"
    ? ""
    : "--capture-output must end in .wav; playback capture analyzer reads WAV output";
}

function stripWavExtension(path) {
  return extname(path).toLowerCase() === ".wav" ? path.slice(0, -4) : path;
}

function createAudioCaptureSession(plan, options) {
  const phaseRecorder = createPhaseRecorder({
    provider: plan.provider,
    outputPath: plan.outputPath,
    routeOutput: plan.routeOutput,
  });
  return {
    plan,
    options,
    handle: null,
    route: null,
    started: false,
    recordPhase: phaseRecorder.recordPhase,
    phases: phaseRecorder.phases,
    captureStartedAt: phaseRecorder.startedAt,
    perfOriginMs: phaseRecorder.perfOriginMs,
  };
}

function createPhaseRecorder(context) {
  const phases = [];
  const perfOriginMs = performance.now();
  const startedAt = new Date().toISOString();
  const recordPhase = (name, details = {}) => {
    phases.push({
      name,
      at: new Date().toISOString(),
      elapsed_ms: roundMillis(performance.now() - perfOriginMs),
      details,
    });
  };
  recordPhase("capture:prepared", context);
  return { phases, startedAt, perfOriginMs, recordPhase };
}

async function startAudioCaptureSession(capture) {
  await mkdir(dirname(capture.plan.outputPath), { recursive: true });
  if (capture.plan.routeOutput) {
    capture.route = await setupPulseVirtualSink();
    capture.plan.device = capture.route.monitorSource;
    capture.plan.captureTarget = capture.route.monitorSource;
    capture.plan.captureTargetKind = "monitor-source";
    if (capture.plan.provider === "pipewire") {
      capture.plan.captureTarget = await resolvePipeWireSinkObjectSerial(capture.route.sinkName);
      capture.plan.captureTargetKind = "pipewire-object-serial";
    }
    logStep(
      `Routed Linux output to temp virtual sink ${capture.route.sinkName}; previous default will be restored.`,
    );
  }

  const { command, args } = buildCaptureCommand(capture.plan);
  capture.handle = startChild("audio capture", command, args);
  await delay(CAPTURE_STARTUP_GRACE_MS);
  throwIfChildExited(capture.handle, "audio capture");
  capture.started = true;
  capture.recordPhase("capture:start", {
    provider: capture.plan.provider,
    device: capture.plan.device || null,
    captureTarget: captureProviderTarget(capture.plan) || null,
    captureTargetKind: capture.plan.captureTargetKind || null,
    outputPath: capture.plan.outputPath,
  });
  logStep(
    `Audio capture started with ${capture.plan.provider} target ${captureProviderTarget(capture.plan) || "(default)"} -> ${capture.plan.outputPath}.`,
  );
}

function captureProviderTarget(plan) {
  return plan.captureTarget || plan.device || "";
}

function buildCaptureCommand(plan) {
  if (plan.provider === "avfoundation") {
    return {
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-f",
        "avfoundation",
        "-i",
        `:${plan.device}`,
        "-ac",
        String(CAPTURE_CHANNELS),
        "-ar",
        String(CAPTURE_SAMPLE_RATE),
        plan.outputPath,
      ],
    };
  }
  if (plan.provider === "pipewire") {
    const args = [
      "--format",
      "s16",
      "--rate",
      String(CAPTURE_SAMPLE_RATE),
      "--channels",
      String(CAPTURE_CHANNELS),
    ];
    const target = captureProviderTarget(plan);
    if (target) {
      args.push("--target", target);
    }
    args.push(plan.outputPath);
    return { command: "pw-record", args };
  }

  const args = [
    "--file-format=wav",
    `--rate=${CAPTURE_SAMPLE_RATE}`,
    `--channels=${CAPTURE_CHANNELS}`,
  ];
  if (plan.device) {
    args.push(`--device=${plan.device}`);
  }
  args.push(plan.outputPath);
  return { command: "parecord", args };
}

async function stopOptionalAudioCapture(capture, { runError = null } = {}) {
  if (!capture) {
    return { keepArtifacts: false, error: null };
  }

  let error = null;
  let keepArtifacts = capture.options.keepArtifacts || Boolean(runError);
  if (runError) {
    capture.recordPhase("smoke:failed", { message: errorMessage(runError) });
  }
  capture.recordPhase("capture:stop-requested");

  try {
    await stopCaptureChild(capture.handle);
  } catch (captureStopError) {
    error = captureStopError;
  }

  const fileInfo = await readCaptureFileInfo(capture.plan.outputPath);
  capture.recordPhase("capture:stopped", {
    outputPath: capture.plan.outputPath,
    exists: fileInfo.exists,
    sizeBytes: fileInfo.sizeBytes,
    durationSeconds: fileInfo.durationSeconds,
    sampleRate: fileInfo.sampleRate,
    channels: fileInfo.channels,
  });

  await cleanupAudioRoute(capture.route);
  try {
    const sidecar = buildCaptureSidecar(capture, fileInfo, { runError });
    await writeFile(capture.plan.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    logStep(`Audio capture timing sidecar written to ${capture.plan.sidecarPath}.`);
  } catch (sidecarError) {
    error ??= sidecarError;
  }

  if (!fileInfo.exists || fileInfo.sizeBytes <= 44) {
    error ??= new Error(`Audio capture did not produce a non-empty WAV at ${capture.plan.outputPath}.`);
  } else {
    logStep(
      `Audio capture wrote ${capture.plan.outputPath} (${fileInfo.sizeBytes} bytes).`,
    );
    const analyzerError = await runCaptureAnalyzer(capture).catch((analyzerRunError) => analyzerRunError);
    if (analyzerError) {
      error ??= analyzerError;
    }
  }

  if (error) {
    keepArtifacts = true;
    const message = `Audio capture post-processing failed: ${errorMessage(error)}`;
    if (capture.options.requireAudioCapture) {
      logStep(message);
    } else {
      logStep(`${message}; smoke result kept.`);
      error = null;
    }
  }

  return {
    keepArtifacts,
    error,
    outputPath: capture.plan.outputPath,
    sidecarPath: capture.plan.sidecarPath,
    analysisOutputPath: capture.plan.analysisOutputPath,
  };
}

async function stopCaptureChild(handle) {
  if (!handle) {
    return;
  }
  if (handle.exit) {
    return;
  }

  killChild(handle.child, "SIGINT");
  await Promise.race([handle.exitPromise, delay(3000)]);
  if (handle.exit) {
    return;
  }
  killChild(handle.child, "SIGTERM");
  await Promise.race([handle.exitPromise, delay(3000)]);
  if (handle.exit) {
    return;
  }
  killChild(handle.child, "SIGKILL");
  await Promise.race([handle.exitPromise, delay(1000)]);
}

async function setupPulseVirtualSink() {
  const sinkName = `tuneforge_playback_smoke_${process.pid}_${Date.now()}`;
  const previousDefault = (await runCommand(
    "read default audio sink",
    "pactl",
    ["get-default-sink"],
    { timeoutMs: 5000 },
  )).stdout.trim();
  let moduleId = "";
  try {
    const loadResult = await runCommand(
      "create virtual audio sink",
      "pactl",
      [
        "load-module",
        "module-null-sink",
        `sink_name=${sinkName}`,
        "sink_properties=device.description=TuneForge Playback Smoke",
      ],
      { timeoutMs: 5000 },
    );
    moduleId = loadResult.stdout.trim();
    await runCommand(
      "route audio to virtual sink",
      "pactl",
      ["set-default-sink", sinkName],
      { timeoutMs: 5000 },
    );
  } catch (error) {
    if (moduleId) {
      await runOptionalCommand(
        "unload virtual audio sink after route failure",
        "pactl",
        ["unload-module", moduleId],
        { timeoutMs: 5000 },
      );
    }
    throw error;
  }

  return {
    sinkName,
    monitorSource: `${sinkName}.monitor`,
    moduleId,
    previousDefault,
  };
}

async function resolvePipeWireSinkObjectSerial(sinkName) {
  const result = await runOptionalCommand(
    "resolve PipeWire sink object serial",
    "pactl",
    ["list", "sinks"],
    { timeoutMs: 5000 },
  );
  if (!result.ok) {
    throw new Error(`could not inspect PipeWire sinks for ${sinkName}: ${result.error}`);
  }
  const sinkBlock = findPactlSinkBlock(result.stdout, sinkName);
  if (!sinkBlock) {
    throw new Error(`could not find temp sink ${sinkName} while resolving PipeWire target`);
  }
  const serial = pactlProperty(sinkBlock, "object.serial");
  if (!serial) {
    throw new Error(`temp sink ${sinkName} has no PipeWire object.serial`);
  }
  return serial;
}

export function findPactlSinkBlock(output, sinkName) {
  return output
    .split(/\n(?=Sink #)/)
    .find((block) => block.split(/\r?\n/).some((line) => line.trim() === `Name: ${sinkName}`))
    || "";
}

export function pactlProperty(block, key) {
  const prefix = `${key} =`;
  const line = block
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return "";
  }
  return line.slice(prefix.length).trim().replace(/^"|"$/g, "");
}

async function cleanupAudioRoute(route) {
  if (!route) {
    return;
  }

  if (route.previousDefault) {
    const restore = await runOptionalCommand(
      "restore default audio sink",
      "pactl",
      ["set-default-sink", route.previousDefault],
      { timeoutMs: 5000 },
    );
    if (!restore.ok) {
      logStep(`Could not restore default audio sink ${route.previousDefault}: ${restore.error}`);
    }
  }
  if (route.moduleId) {
    const unload = await runOptionalCommand(
      "unload virtual audio sink",
      "pactl",
      ["unload-module", route.moduleId],
      { timeoutMs: 5000 },
    );
    if (!unload.ok) {
      logStep(`Could not unload temp virtual audio sink ${route.sinkName}: ${unload.error}`);
    }
  }
}

async function discoverLinuxMonitorSource() {
  if (!(await commandExists("pactl"))) {
    return { device: "", reason: "pactl was not found for Linux monitor source discovery" };
  }

  const sourcesResult = await runOptionalCommand(
    "list audio sources",
    "pactl",
    ["list", "short", "sources"],
    { timeoutMs: 5000 },
  );
  if (!sourcesResult.ok) {
    return { device: "", reason: sourcesResult.error };
  }

  const sourceNames = sourcesResult.stdout
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean);

  const defaultSinkResult = await runOptionalCommand(
    "read default audio sink",
    "pactl",
    ["get-default-sink"],
    { timeoutMs: 5000 },
  );
  if (defaultSinkResult.ok) {
    const defaultMonitor = `${defaultSinkResult.stdout.trim()}.monitor`;
    if (sourceNames.includes(defaultMonitor)) {
      return { device: defaultMonitor, reason: "" };
    }
  }

  const monitorSource = sourceNames.find((name) => name.endsWith(".monitor"));
  if (monitorSource) {
    return { device: monitorSource, reason: "" };
  }

  return { device: "", reason: "no Pulse/PipeWire monitor source is available" };
}

async function readCaptureFileInfo(path) {
  try {
    const stats = await stat(path);
    const wavInfo = await readWavInfo(path).catch(() => null);
    return {
      exists: true,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      durationSeconds: wavInfo?.durationSeconds ?? null,
      sampleRate: wavInfo?.sampleRate ?? null,
      channels: wavInfo?.channels ?? null,
      bitsPerSample: wavInfo?.bitsPerSample ?? null,
    };
  } catch {
    return {
      exists: false,
      sizeBytes: 0,
      modifiedAt: null,
      durationSeconds: null,
      sampleRate: null,
      channels: null,
      bitsPerSample: null,
    };
  }
}

async function readWavInfo(path) {
  const buffer = await readFile(path);
  return parseWavInfo(buffer);
}

function parseWavInfo(buffer) {
  if (
    buffer.length < 44
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      break;
    }
    if (chunkId === "fmt " && chunkSize >= 16) {
      fmt = {
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt || dataBytes === null || fmt.sampleRate <= 0 || fmt.blockAlign <= 0) {
    return null;
  }
  return {
    durationSeconds: roundSeconds(dataBytes / fmt.blockAlign / fmt.sampleRate),
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
  };
}

function buildCaptureAnalysisExpectations(phases, fileInfo) {
  const timingNormalization = buildCaptureTimingNormalization(phases, fileInfo);
  return {
    timingNormalization,
    markers: buildCaptureMarkers(phases, timingNormalization),
    quietWindows: buildCaptureQuietWindows(phases, timingNormalization),
    loops: buildCaptureLoops(phases, timingNormalization),
  };
}

function buildCaptureTimingNormalization(phases, fileInfo) {
  const stopSeconds = phaseElapsedSeconds(lastPhaseNamed(phases, "capture:stopped"));
  const durationSeconds = firstNumberField(fileInfo, ["durationSeconds"]);
  if (stopSeconds === null || durationSeconds === null || durationSeconds <= 0) {
    return {
      applied: false,
      offsetSeconds: 0,
      stopElapsedSeconds: stopSeconds,
      durationSeconds,
      reason: "capture WAV duration unavailable",
    };
  }
  const offsetSeconds = Math.max(0, stopSeconds - durationSeconds);
  return {
    applied: offsetSeconds > 0.001,
    offsetSeconds: roundSeconds(offsetSeconds),
    stopElapsedSeconds: roundSeconds(stopSeconds),
    durationSeconds: roundSeconds(durationSeconds),
    reason: "capture:stopped elapsed minus WAV duration",
  };
}

function buildCaptureMarkers(phases, timingNormalization) {
  return [
    ["song-precount:telemetry-passed", "song-precount-playback-marker"],
    ["loop-precount:telemetry-passed", "loop-precount-playback-marker"],
    ["loop:restart-detected", "loop-restart-marker"],
  ].flatMap(([name, kind]) => {
    const phase = lastPhaseNamed(phases, name);
    const timeSeconds = phaseElapsedSeconds(phase);
    if (timeSeconds === null) {
      return [];
    }
    const captureSeconds = normalizeCaptureSeconds(timeSeconds, timingNormalization);
    if (!captureSecondsInRange(captureSeconds, timingNormalization)) {
      return [];
    }
    const details = phaseDetails(phase);
    const playbackSeconds = firstNumberField(details, [
      "startTimeSeconds",
      "positionSeconds",
      "playbackPositionSeconds",
      "loopStartSeconds",
    ]);
    const marker = { kind, timeSeconds: captureSeconds };
    if (playbackSeconds !== null) {
      marker.playbackSeconds = playbackSeconds;
    }
    return [marker];
  });
}

function buildCaptureQuietWindows(phases, timingNormalization) {
  const captureStart = phaseElapsedSeconds(lastPhaseNamed(phases, "capture:start"));
  const smokeStart = phaseElapsedSeconds(firstPhaseNamed(phases, "smoke:start"));
  if (captureStart === null || smokeStart === null) {
    return [];
  }
  const startSeconds = captureStart + 0.1;
  const endSeconds = smokeStart - 0.1;
  const normalizedStartSeconds = normalizeCaptureSeconds(startSeconds, timingNormalization);
  const normalizedEndSeconds = normalizeCaptureSeconds(endSeconds, timingNormalization);
  if (normalizedStartSeconds === null || normalizedEndSeconds === null) {
    return [];
  }
  const clippedStartSeconds = Math.max(0, normalizedStartSeconds);
  const clippedEndSeconds = timingNormalization.durationSeconds !== null
    ? Math.min(timingNormalization.durationSeconds, normalizedEndSeconds)
    : normalizedEndSeconds;
  if (clippedEndSeconds - clippedStartSeconds < 0.25) {
    return [];
  }
  return [
    {
      startSeconds: roundSeconds(clippedStartSeconds),
      endSeconds: roundSeconds(clippedEndSeconds),
      maxRms: 0.003,
    },
  ];
}

function buildCaptureLoops(phases, timingNormalization) {
  const loopSet = lastPhaseNamed(phases, "loop:set");
  const loopRestart = lastPhaseNamed(phases, "loop:restart-detected");
  const loopPlayback = lastPhaseNamed(phases, "loop-precount:telemetry-passed")
    ?? lastPhaseNamed(phases, "loop-playback:start");
  const startSeconds = firstNumberField(phaseDetails(loopSet), ["startSeconds"]);
  const endSeconds = firstNumberField(phaseDetails(loopSet), ["endSeconds"]);
  const startCaptureSeconds = phaseElapsedSeconds(loopPlayback);
  const restartSeconds = phaseElapsedSeconds(loopRestart);
  if (
    startSeconds === null
    || endSeconds === null
    || endSeconds <= startSeconds
  ) {
    return [];
  }
  const loop = { startSeconds, endSeconds };
  const normalizedStartCaptureSeconds = normalizeCaptureSeconds(startCaptureSeconds, timingNormalization);
  if (captureSecondsInRange(normalizedStartCaptureSeconds, timingNormalization)) {
    loop.startCaptureSeconds = normalizedStartCaptureSeconds;
  }
  const normalizedRestartSeconds = normalizeCaptureSeconds(restartSeconds, timingNormalization);
  if (captureSecondsInRange(normalizedRestartSeconds, timingNormalization)) {
    loop.restartSeconds = normalizedRestartSeconds;
  }
  return [loop];
}

function normalizeCaptureSeconds(seconds, timingNormalization) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }
  return roundSeconds(seconds - timingNormalization.offsetSeconds);
}

function captureSecondsInRange(seconds, timingNormalization) {
  if (seconds === null || seconds < 0) {
    return false;
  }
  return timingNormalization.durationSeconds === null || seconds <= timingNormalization.durationSeconds;
}

function firstPhaseNamed(phases, name) {
  return Array.isArray(phases) ? phases.find((phase) => phase?.name === name) ?? null : null;
}

function lastPhaseNamed(phases, name) {
  if (!Array.isArray(phases)) {
    return null;
  }
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (phase?.name === name) {
      return phase;
    }
  }
  return null;
}

function phaseDetails(phase) {
  return phase && typeof phase.details === "object" && !Array.isArray(phase.details)
    ? phase.details
    : {};
}

function phaseElapsedSeconds(phase) {
  const elapsedMs = firstNumberField(phase, ["elapsed_ms", "elapsedMs"]);
  return elapsedMs === null ? null : elapsedMs / 1000;
}

export function buildCaptureSidecar(capture, fileInfo, { runError }) {
  const expectations = buildCaptureAnalysisExpectations(capture.phases, fileInfo);
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    provider: capture.plan.provider,
    provider_command: capture.plan.providerCommand,
    device: capture.plan.device || null,
    capture_target: captureProviderTarget(capture.plan) || null,
    capture_target_kind: capture.plan.captureTargetKind || null,
    route_output: capture.plan.routeOutput,
    output_path: capture.plan.outputPath,
    analysis_output_path: capture.plan.analysisOutputPath,
    sample_rate_hz: CAPTURE_SAMPLE_RATE,
    channels: CAPTURE_CHANNELS,
    audio: {
      sampleRate: CAPTURE_SAMPLE_RATE,
      channels: CAPTURE_CHANNELS,
      path: capture.plan.outputPath,
    },
    minDurationSeconds: 1.0,
    rmsThreshold: 0.002,
    markerToleranceSeconds: capture.plan.provider === "avfoundation" ? 0.5 : 0.2,
    spacingToleranceSeconds: capture.plan.provider === "avfoundation" ? 0.3 : 0.2,
    smoke_status: runError ? "failed" : "passed",
    smoke_error: runError ? errorMessage(runError) : null,
    capture_file: fileInfo,
    timing_normalization: expectations.timingNormalization,
    phaseMarkers: capture.phases,
    phases: capture.phases,
    markers: expectations.markers,
    quietWindows: expectations.quietWindows,
    loops: expectations.loops,
    requireLoopRestart: expectations.loops.length > 0,
  };
}

async function runCaptureAnalyzer(capture) {
  const result = await runOptionalCommand(
    "audio capture analyzer",
    "bash",
    [
      "scripts/run-backend-module.sh",
      "app.cli.playback_capture_analyze",
      "--audio",
      capture.plan.outputPath,
      "--sidecar",
      capture.plan.sidecarPath,
    ],
    { timeoutMs: CAPTURE_ANALYZER_TIMEOUT_MS },
  );
  if (!result.ok) {
    return new Error(result.error);
  }
  await writeFile(capture.plan.analysisOutputPath, normalizeCommandOutput(result.stdout));
  logStep(`Audio capture analyzer wrote ${capture.plan.analysisOutputPath}.`);
  return null;
}

function normalizeCommandOutput(output) {
  const text = output.trim();
  return text ? `${text}\n` : "{}\n";
}

async function commandExists(command) {
  const result = await runOptionalCommand(
    `find ${command}`,
    "bash",
    ["-lc", `command -v ${shellWord(command)}`],
    { timeoutMs: 5000 },
  );
  return result.ok && Boolean(result.stdout.trim());
}

function shellWord(value) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe shell word: ${value}`);
  }
  return value;
}

async function runOptionalCommand(label, command, args, options = {}) {
  try {
    const result = await runCommand(label, command, args, options);
    return { ok: true, stdout: result.stdout, stderr: result.stderr, error: "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: errorMessage(error) };
  }
}

async function cleanupCaptureTempRoot(tempRoot, options, captureResult) {
  if (!tempRoot) {
    return;
  }
  if (options.keepArtifacts || captureResult?.keepArtifacts) {
    logStep(`Kept audio capture artifacts at ${tempRoot}.`);
    return;
  }
  await rm(tempRoot, { recursive: true, force: true });
}

function roundMillis(value) {
  return Math.round(value * 1000) / 1000;
}

function roundSeconds(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function selectPort(preferredPort, excludedPorts, label) {
  if (preferredPort !== null) {
    if (excludedPorts.has(preferredPort)) {
      throw new Error(`Port ${preferredPort} conflicts with another smoke process port.`);
    }
    await assertPortAvailable(preferredPort, label);
    return preferredPort;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await getFreePort();
    if (!excludedPorts.has(port) && port !== 8765 && port !== 1420) {
      return port;
    }
  }

  throw new Error("Could not allocate a free local port for isolated playback smoke.");
}

async function getFreePort() {
  const server = net.createServer();
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not inspect allocated local port."));
      });
    });
  });
}

async function assertPortAvailable(port, label) {
  const server = net.createServer();
  server.unref();
  const available = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });

  if (!available) {
    throw new Error(
      [
        `Port ${port} is already in use for the ${label}.`,
        `Pass --${label === "backend" ? "backend" : "app"}-port=<free-port> or use --manual-app against a pre-running app.`,
      ].join("\n"),
    );
  }
}

async function createPlaybackFixture({ dataDir, workDir, projectName }) {
  const args = [
    "scripts/run-backend-module.sh",
    "app.cli.playback_e2e_fixture",
    "create",
    "--data-dir",
    dataDir,
    "--work-dir",
    workDir,
  ];
  if (projectName) {
    args.push("--project-name", projectName);
  }

  const result = await runCommand("fixture seed", "bash", args, {
    env: {
      TUNEFORGE_DATA_DIR: dataDir,
      PYTHONUNBUFFERED: "1",
    },
    timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  });
  const fixture = parseJsonOutput(result.stdout, "fixture seed");

  if (!fixture || typeof fixture !== "object" || typeof fixture.project_id !== "string") {
    throw new Error("Fixture seed did not return JSON with project_id.");
  }
  return fixture;
}

function parseJsonOutput(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${label} did not write JSON to stdout.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }

  throw new Error(`${label} stdout was not valid JSON:\n${trimmed}`);
}

async function runCommand(label, command, args, { env = {}, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killChild(child, "SIGTERM");
  }, timeoutMs);

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));

  if (timedOut) {
    killChild(child, "SIGKILL");
    throw new Error(`${label} timed out after ${timeoutMs}ms.\n${stderr.trim()}`);
  }
  if (exit.code !== 0) {
    throw new Error(
      [
        `${label} failed with exit code ${exit.code ?? "null"}${exit.signal ? ` signal ${exit.signal}` : ""}.`,
        stderr.trim(),
      ].filter(Boolean).join("\n"),
    );
  }

  return { stdout, stderr };
}

function startChild(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const handle = {
    label,
    child,
    tail: [],
    spawnError: null,
    exit: null,
    exitPromise: null,
  };

  handle.exitPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (exit) => {
      if (settled) {
        return;
      }
      settled = true;
      handle.exit = exit;
      resolve(exit);
    };

    child.once("error", (error) => {
      handle.spawnError = error;
      pushChildTail(handle, error.message);
      finish({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => finish({ code, signal }));
  });

  child.stdout?.on("data", (chunk) => pushChildTail(handle, chunk.toString()));
  child.stderr?.on("data", (chunk) => pushChildTail(handle, chunk.toString()));
  return handle;
}

async function waitForHttp(url, { label, child, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() <= deadline) {
    throwIfChildExited(child, label);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = errorMessage(error);
    }

    await delay(250);
  }

  throw new Error(
    [
      `Timed out waiting for ${label} at ${url}.`,
      lastError ? `Last error: ${lastError}` : "",
      formatChildTail(child),
    ].filter(Boolean).join("\n"),
  );
}

function throwIfChildExited(handle, label) {
  if (handle.spawnError) {
    throw new Error(`${label} failed to start: ${handle.spawnError.message}`);
  }
  if (handle.exit) {
    throw new Error(
      [
        `${label} exited before becoming ready with code ${handle.exit.code ?? "null"}${handle.exit.signal ? ` signal ${handle.exit.signal}` : ""}.`,
        formatChildTail(handle),
      ].filter(Boolean).join("\n"),
    );
  }
}

async function stopChildren(children) {
  await Promise.all(children.slice().reverse().map((child) => stopChild(child)));
}

async function stopChild(handle) {
  if (handle.exit || !handle.child.pid) {
    return;
  }

  killChild(handle.child, "SIGTERM");
  await Promise.race([handle.exitPromise, delay(3000)]);
  if (!handle.exit) {
    killChild(handle.child, "SIGKILL");
    await Promise.race([handle.exitPromise, delay(1000)]);
  }
}

function killChild(child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child kill.
  }

  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function pushChildTail(handle, output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  handle.tail.push(...lines);
  if (handle.tail.length > CHILD_TAIL_LINES) {
    handle.tail.splice(0, handle.tail.length - CHILD_TAIL_LINES);
  }
}

function formatChildTail(handle) {
  if (!handle?.tail?.length) {
    return "";
  }
  return `${handle.label} output:\n${handle.tail.join("\n")}`;
}

function appendAppPath(appUrl, path) {
  const base = appUrl.replace(/\/$/, "");
  if (!path) {
    return base;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(message) {
  console.log(`[playback-smoke] ${message}`);
}

function formatSeconds(value) {
  return `${value.toFixed(3)}s`;
}

async function openProject(page, { appUrl, projectId, projectName, projectUrl = "" }) {
  if (projectUrl) {
    await gotoApp(page, projectUrl);
    return;
  }

  const baseUrl = appUrl.replace(/\/$/, "");
  if (projectId) {
    await gotoApp(page, appendAppPath(baseUrl, `/#/projects/${projectId}`));
    return;
  }

  await gotoApp(page, baseUrl);
  try {
    await page.getByRole("link", { name: `Open ${projectName} project` }).click();
  } catch (error) {
    throw new Error(
      `Could not find a library project named "${projectName}". Use the visible library name or pass --project-id=<id>.\n${errorMessage(error)}`,
    );
  }
}

async function gotoApp(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("ERR_CONNECTION_REFUSED")) {
      throw new Error(
        [
          `Could not reach TuneForge at ${url}.`,
          "Start the dev app first, for example:",
          "  pnpm dev",
          "or, if the backend is already running:",
          "  pnpm dev:desktop",
          "Set TUNEFORGE_SMOKE_APP_URL if the frontend is on a different URL.",
        ].join("\n"),
      );
    }
    throw error;
  }
}

async function openPlayback(page) {
  const playbackTab = page.getByRole("tab", { name: "Playback" });
  if ((await playbackTab.getAttribute("aria-selected")) !== "true") {
    await playbackTab.click();
  }
}

async function resetSmokePlaybackState(page) {
  await page.getByRole("button", { name: "Stop playback" }).click();
  const clearLoopButton = page.getByRole("button", { name: "Clear loop" });
  if (await clearLoopButton.isVisible().catch(() => false)) {
    await clearLoopButton.click();
  }
  await setCheckbox(page, "Enable pre-count", false);
  await setCheckbox(page, "Enable loop pre-count", false);
  await seekTo(page, 0);
  await expectPosition(page, 0, "after resetting smoke playback state");
}

async function setCheckbox(page, label, checked) {
  const checkbox = page.getByLabel(label);
  if (await checkbox.isEnabled().catch(() => false)) {
    await checkbox.setChecked(checked);
  }
}

async function seekTo(page, value) {
  await page.getByLabel("Playback position").evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Playback position control is not an input element.");
    }
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(element, String(nextValue));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

function stoppedStartProbeTime(durationSeconds) {
  return Math.min(Math.max(8, durationSeconds * 0.2), Math.max(0, durationSeconds - 2));
}

async function verifyPlayStartsFromSelection(page, startSeconds, label) {
  const minimumPositionSeconds = startSeconds - 0.05;
  await page.getByRole("button", { name: "Play playback" }).click();
  await waitForPlaybackStartFromSelection(page, minimumPositionSeconds, label);
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expectPosition(page, 0, `after stopping ${label}`);
}

async function chooseStoppedPracticeSelection(page) {
  const selectors = [
    '[role="group"][aria-label="Lyrics and chords lead sheet"] [role="button"]',
    '[role="group"][aria-label="Lyrics transcript"] [role="button"]',
    '[role="group"][aria-label="Chord timeline"] button',
  ];

  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const candidateCount = Math.min(await candidates.count(), 24);
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      await candidate.click();
      const selectedSeconds = await readPlaybackPosition(page);
      if (selectedSeconds > 3) {
        return selectedSeconds;
      }
    }
  }

  return null;
}

async function readPlaybackDuration(page) {
  const rawMax = await page.getByLabel("Playback position").evaluate((element) => {
    const input = element;
    return input instanceof HTMLInputElement ? input.max : "";
  });
  const durationSeconds = Number(rawMax);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Playback duration is unavailable for smoke test. Range max: ${rawMax}`);
  }
  return durationSeconds;
}

async function readPlaybackPosition(page) {
  const rawValue = await page.getByLabel("Playback position").evaluate((element) => {
    const input = element;
    return input instanceof HTMLInputElement ? input.value : "";
  });
  const positionSeconds = Number(rawValue);
  return Number.isFinite(positionSeconds) ? positionSeconds : 0;
}

async function readPlaybackE2EState(page) {
  return page.evaluate(async () => {
    const bridge = window.__TUNEFORGE_PLAYBACK_E2E__;
    if (!bridge || typeof bridge.read !== "function") {
      return null;
    }
    const value = bridge.read();
    return value && typeof value.then === "function" ? await value : value;
  });
}

async function assertPlaybackE2EBridge(page) {
  const telemetry = await readPlaybackE2EDiagnostic(page);
  if (!telemetry.available) {
    throw new Error(
      "Isolated playback smoke requires window.__TUNEFORGE_PLAYBACK_E2E__.read(), but the bridge was unavailable.",
    );
  }
  if (telemetry.error) {
    throw new Error(`Playback E2E telemetry bridge read failed: ${telemetry.error}`);
  }
  if (!telemetry.snapshot || typeof telemetry.snapshot !== "object") {
    throw new Error(
      `Playback E2E telemetry bridge returned no snapshot: ${formatTelemetryState(telemetry.snapshot)}.`,
    );
  }
}

async function waitForPlaybackStartFromSelection(page, minimumPositionSeconds, label, options = {}) {
  const timeout = options.timeout ?? 5000;
  const pollInterval = options.pollInterval ?? 100;
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    const pauseVisible = await isPlaybackButtonVisible(page, "Pause playback");
    const inputPositionSeconds = await readPlaybackPosition(page).catch(() => null);
    if (
      pauseVisible &&
      typeof inputPositionSeconds === "number" &&
      inputPositionSeconds >= minimumPositionSeconds
    ) {
      return;
    }

    const telemetry = await readPlaybackE2EState(page).catch(() => null);
    if (
      telemetry &&
      telemetryReportsPlaybackStarted(telemetry) &&
      telemetryPositionReached(telemetry, minimumPositionSeconds)
    ) {
      return;
    }

    await page.waitForTimeout(pollInterval);
  }

  throw new Error(
    [
      `Timed out waiting for playback to start from ${label}.`,
      `Expected position at or after ${formatSeconds(minimumPositionSeconds)}.`,
      await formatPlaybackStartDiagnostics(page),
    ].join("\n"),
  );
}

async function isPlaybackButtonVisible(page, name) {
  return page.getByRole("button", { name }).isVisible().catch(() => false);
}

function telemetryReportsPlaybackStarted(state) {
  const transport = transportTelemetry(state);
  if (transportState(transport) === "playing") {
    return true;
  }

  const nestedBackend = firstObjectField(state, [
    "activeBackend",
    "backendState",
    "native",
    "nativePlayback",
    "webAudio",
    "webPlayback",
  ]);
  if (transportState(nestedBackend) === "playing") {
    return true;
  }

  const playing = firstBooleanField(transport, ["playing", "isPlaying"])
    ?? firstBooleanField(nestedBackend, ["playing", "isPlaying"])
    ?? firstBooleanField(state, ["playing", "isPlaying"]);
  if (playing !== null) {
    return playing;
  }

  const active = firstBooleanField(transport, ["active", "isActive"])
    ?? firstBooleanField(nestedBackend, ["active", "isActive"]);
  return active === true && (isNativePlaybackActive(state) || isWebPlaybackActive(state));
}

function telemetryPositionReached(state, minimumPositionSeconds) {
  const positionSeconds = transportPositionSeconds(transportTelemetry(state));
  return positionSeconds !== null && positionSeconds >= minimumPositionSeconds;
}

async function formatPlaybackStartDiagnostics(page) {
  const diagnostics = await readPlaybackStartDiagnostics(page);
  const telemetry = diagnostics.telemetry.available
    ? formatTelemetryDiagnostic(diagnostics.telemetry)
    : "bridge unavailable";
  return [
    `Position input: ${diagnostics.positionInputValue}`,
    `Buttons: Play visible=${diagnostics.buttons.playVisible}, Pause visible=${diagnostics.buttons.pauseVisible}, Stop visible=${diagnostics.buttons.stopVisible}`,
    `Telemetry: ${telemetry}`,
    `localStorage tuneforge.playback-native-error: ${formatDiagnosticValue(diagnostics.nativeError)}`,
    `localStorage tuneforge.playback-backend: ${formatDiagnosticValue(diagnostics.playbackBackend)}`,
  ].join("\n");
}

async function readPlaybackStartDiagnostics(page) {
  const [positionInputValue, playVisible, pauseVisible, stopVisible, storage, telemetry] =
    await Promise.all([
      readPlaybackPositionInputValue(page),
      isPlaybackButtonVisible(page, "Play playback"),
      isPlaybackButtonVisible(page, "Pause playback"),
      isPlaybackButtonVisible(page, "Stop playback"),
      readPlaybackDiagnosticStorage(page),
      readPlaybackE2EDiagnostic(page),
    ]);

  return {
    positionInputValue,
    buttons: {
      playVisible,
      pauseVisible,
      stopVisible,
    },
    nativeError: storage.nativeError,
    playbackBackend: storage.playbackBackend,
    telemetry,
  };
}

async function readPlaybackPositionInputValue(page) {
  return page
    .getByLabel("Playback position")
    .evaluate((element) => (element instanceof HTMLInputElement ? element.value : "not-input"))
    .catch(() => "missing");
}

async function readPlaybackDiagnosticStorage(page) {
  return page.evaluate(() => ({
    nativeError: window.localStorage.getItem("tuneforge.playback-native-error"),
    playbackBackend: window.localStorage.getItem("tuneforge.playback-backend"),
  }));
}

async function readPlaybackE2EDiagnostic(page) {
  return page.evaluate(async () => {
    const bridge = window.__TUNEFORGE_PLAYBACK_E2E__;
    if (!bridge || typeof bridge.read !== "function") {
      return { available: false, snapshot: null, error: null };
    }

    try {
      const value = bridge.read();
      const snapshot = value && typeof value.then === "function" ? await value : value;
      return { available: true, snapshot, error: null };
    } catch (error) {
      return { available: true, snapshot: null, error: String(error) };
    }
  });
}

function formatTelemetryDiagnostic(telemetry) {
  if (telemetry.error) {
    return `read failed: ${telemetry.error}`;
  }
  return formatTelemetryState(telemetry.snapshot);
}

function formatDiagnosticValue(value) {
  return value === null ? "not present" : JSON.stringify(value);
}

async function waitForPlaybackE2EState(page, label, predicate, options = {}) {
  const timeout = options.timeout ?? 3500;
  const pollInterval = options.pollInterval ?? 100;
  const requireTelemetry = options.requireTelemetry === true;
  const deadline = Date.now() + timeout;
  let lastState = null;
  let bridgeWasAvailable = false;

  while (Date.now() <= deadline) {
    const state = await readPlaybackE2EState(page);
    if (state !== null) {
      bridgeWasAvailable = true;
      lastState = state;
      if (predicate(state)) {
        return state;
      }
    }
    await page.waitForTimeout(pollInterval);
  }

  if (!bridgeWasAvailable) {
    const message = `${label} telemetry bridge unavailable. Isolated playback smoke requires window.__TUNEFORGE_PLAYBACK_E2E__.read().`;
    if (requireTelemetry) {
      throw new Error(message);
    }
    logStep(`Skipped ${label}; playback E2E telemetry bridge unavailable.`);
    return null;
  }

  throw new Error(
    `Timed out waiting for ${label} telemetry. Last state: ${formatTelemetryState(lastState)}.`,
  );
}

async function assertCountInTelemetry(
  page,
  { expectedKind, expectedStartSeconds, label, requireTelemetry = false },
) {
  const scheduledState = await waitForPlaybackE2EState(
    page,
    `${label} schedule`,
    (candidate) => {
      const countIn = countInTelemetry(candidate);
      if (!countIn || !isCountInActive(countIn, candidate)) {
        return false;
      }
      const scheduled = countInScheduledEvent(countIn);
      const kind = scheduled ? countInEventKind(scheduled) : null;
      if (kind && !kindMatches(kind, expectedKind)) {
        return false;
      }
      return true;
    },
    { timeout: 2500, requireTelemetry },
  );
  if (!scheduledState) {
    return false;
  }

  const countIn = countInTelemetry(scheduledState);
  if (!countIn) {
    throw new Error(`${label} telemetry did not include count-in details.`);
  }
  const scheduled = countInScheduledEvent(countIn);
  if (!scheduled) {
    throw new Error(`${label} telemetry did not include a scheduled count-in event.`);
  }
  const kind = countInEventKind(scheduled);
  if (!kind) {
    throw new Error(`${label} telemetry did not include a count-in kind.`);
  }
  if (!kindMatches(kind, expectedKind)) {
    throw new Error(`Expected ${label} kind ${expectedKind}, but saw ${kind}.`);
  }
  const startSeconds = firstNumberField(scheduled, [
    "startTimeSeconds",
    "targetStartSeconds",
    "playbackStartSeconds",
    "anchorTimeSeconds",
    "anchorSeconds",
  ]);
  if (startSeconds === null) {
    throw new Error(`${label} telemetry did not include a target start time.`);
  }
  if (Math.abs(startSeconds - expectedStartSeconds) > 0.05) {
    throw new Error(
      `Expected ${label} target near ${formatSeconds(expectedStartSeconds)}, but saw ${formatSeconds(startSeconds)}.`,
    );
  }
  const scheduledCount = countInScheduledClickCount(countIn, scheduled);
  if (scheduledCount === null || scheduledCount <= 0) {
    throw new Error(`${label} telemetry did not include scheduled click count.`);
  }
  const scheduledSequence = firstNumberField(scheduled, ["sequence"]);

  const firedState = await waitForPlaybackE2EState(
    page,
    `${label} fired`,
    (candidate) => {
      const candidateCountIn = countInTelemetry(candidate);
      const fired = candidateCountIn ? countInFiredEvent(candidateCountIn) : null;
      if (!fired) {
        return false;
      }
      const firedKind = countInEventKind(fired);
      if (firedKind && !kindMatches(firedKind, expectedKind)) {
        return false;
      }
      const firedSequence = firstNumberField(fired, ["sequence"]);
      return scheduledSequence === null || firedSequence === null || firedSequence === scheduledSequence;
    },
    { timeout: 5000, requireTelemetry },
  );
  if (!firedState) {
    return false;
  }
  const firedCountIn = countInTelemetry(firedState);
  const fired = firedCountIn ? countInFiredEvent(firedCountIn) : null;
  if (!fired) {
    throw new Error(`${label} telemetry did not include a fired count-in event.`);
  }
  const firedKind = countInEventKind(fired);
  if (firedKind && !kindMatches(firedKind, expectedKind)) {
    throw new Error(`Expected ${label} fired kind ${expectedKind}, but saw ${firedKind}.`);
  }
  const firedSequence = firstNumberField(fired, ["sequence"]);
  if (scheduledSequence !== null && firedSequence !== null && firedSequence !== scheduledSequence) {
    throw new Error(
      `${label} fired sequence ${firedSequence} did not match scheduled sequence ${scheduledSequence}.`,
    );
  }
  return {
    trigger: expectedKind,
    sequence: firedSequence ?? scheduledSequence,
    clickCount: scheduledCount,
    startTimeSeconds: startSeconds,
    tempoBpm: firstNumberField(scheduled, ["tempoBpm", "bpm"]),
    scheduledAtContextTimeSeconds: firstNumberField(scheduled, ["scheduledAtContextTimeSeconds"]),
    firstClickTimeSeconds: firstNumberField(scheduled, ["firstClickTimeSeconds"]),
    playbackStartTimeSeconds: firstNumberField(scheduled, ["playbackStartTimeSeconds"]),
    firedAtContextTimeSeconds: firstNumberField(fired, ["firedAtContextTimeSeconds"]),
  };
}

async function assertPlaybackTransportTelemetry(
  page,
  { expectedLoopEndSeconds, expectedLoopStartSeconds, expectedState, label, requireTelemetry = false },
) {
  const state = await waitForPlaybackE2EState(
    page,
    `${label} transport`,
    (candidate) => isNativePlaybackActive(candidate) || isWebPlaybackActive(candidate),
    { timeout: 2500, requireTelemetry },
  );
  if (!state) {
    return;
  }

  const transport = transportTelemetry(state);
  const activePath = isNativePlaybackActive(state) ? "native" : "Web Audio";
  const stateName = transportState(transport);
  if (stateName !== expectedState) {
    throw new Error(`Expected ${label} ${activePath} transport state ${expectedState}, but saw ${stateName}.`);
  }
  const positionSeconds = transportPositionSeconds(transport);
  if (positionSeconds === null) {
    throw new Error(`${label} ${activePath} transport did not report positionSeconds.`);
  }
  if (
    positionSeconds < expectedLoopStartSeconds - 0.1 ||
    positionSeconds > expectedLoopEndSeconds + 1
  ) {
    throw new Error(
      `${label} ${activePath} position ${formatSeconds(positionSeconds)} outside expected loop ${formatSeconds(expectedLoopStartSeconds)}-${formatSeconds(expectedLoopEndSeconds)}.`,
    );
  }
  const playbackRate = firstNumberField(transport, ["playbackRate", "rate"]);
  if (playbackRate === null || playbackRate <= 0) {
    throw new Error(`${label} ${activePath} transport did not report a positive playback rate.`);
  }
  const durationSeconds = firstNumberField(transport, [
    "durationSeconds",
    "duration",
    "totalDurationSeconds",
  ]);
  if (durationSeconds === null || durationSeconds <= 0) {
    throw new Error(`${label} ${activePath} transport did not report a positive duration.`);
  }

  const loopRange = loopTelemetry(state);
  if (!loopRange) {
    throw new Error(`${label} ${activePath} transport did not report active loop range.`);
  }
  const loopStart = firstNumberField(loopRange, ["startSeconds", "start", "loopStartSeconds"]);
  const loopEnd = firstNumberField(loopRange, ["endSeconds", "end", "loopEndSeconds"]);
  if (loopStart === null || Math.abs(loopStart - expectedLoopStartSeconds) > 0.05) {
    throw new Error(
      `Expected ${label} ${activePath} loop start near ${formatSeconds(expectedLoopStartSeconds)}, but saw ${loopStart}.`,
    );
  }
  if (loopEnd === null || Math.abs(loopEnd - expectedLoopEndSeconds) > 0.05) {
    throw new Error(
      `Expected ${label} ${activePath} loop end near ${formatSeconds(expectedLoopEndSeconds)}, but saw ${loopEnd}.`,
    );
  }

  if (!isNativePlaybackActive(state)) {
    logStep(`${label} Web Audio transport telemetry passed.`);
    return;
  }

  const bufferHealth = nativeBufferHealthTelemetry(state);
  if (!Array.isArray(bufferHealth) || bufferHealth.length === 0) {
    throw new Error(`${label} native telemetry did not report buffer health.`);
  }
  bufferHealth.forEach((lane, index) => {
    const laneId = firstStringField(lane, ["laneId", "id"]);
    const role = firstStringField(lane, ["role", "laneRole"]);
    const fill = firstNumberField(lane, ["ringFillSamples", "fillSamples", "bufferFillSamples"]);
    const capacity = firstNumberField(lane, [
      "ringCapacitySamples",
      "capacitySamples",
      "bufferCapacitySamples",
    ]);
    const underruns = firstNumberField(lane, ["underrunCount", "underruns"]);
    const workerErrors = firstNumberField(lane, ["workerErrorCount", "workerErrors"]);
    if (!laneId) {
      throw new Error(`${label} native buffer health lane ${index} missing laneId.`);
    }
    if (!role) {
      throw new Error(`${label} native buffer health lane ${laneId} missing role.`);
    }
    if (fill === null || fill < 0) {
      throw new Error(`${label} native buffer health lane ${laneId} has invalid fill.`);
    }
    if (capacity === null || capacity <= 0) {
      throw new Error(`${label} native buffer health lane ${laneId} has invalid capacity.`);
    }
    if (fill > capacity) {
      throw new Error(`${label} native buffer health lane ${laneId} fill exceeds capacity.`);
    }
    if (underruns === null || underruns < 0) {
      throw new Error(`${label} native buffer health lane ${laneId} has invalid underruns.`);
    }
    if (workerErrors === null || workerErrors < 0) {
      throw new Error(`${label} native buffer health lane ${laneId} has invalid worker errors.`);
    }
  });
  logStep(`${label} native transport and buffer telemetry passed.`);
}

async function waitForLoopRestartTelemetry(
  page,
  { expectedLoopEndSeconds, expectedLoopStartSeconds, label, requireTelemetry = false },
) {
  const loopSeconds = expectedLoopEndSeconds - expectedLoopStartSeconds;
  if (loopSeconds <= 0) {
    throw new Error(`${label} loop range is invalid.`);
  }

  const edgeSeconds = Math.min(0.35, Math.max(0.08, loopSeconds * 0.15));
  const nearEndSeconds = expectedLoopEndSeconds - edgeSeconds;
  const nearStartSeconds = expectedLoopStartSeconds + edgeSeconds;
  const minBackwardJumpSeconds = Math.min(0.25, Math.max(0.05, loopSeconds * 0.25));
  const timeout = Math.max(4000, Math.min(30000, (loopSeconds + 6) * 1000));
  let sawNearEnd = false;
  let previousPositionSeconds = null;
  let restartFromSeconds = null;

  const state = await waitForPlaybackE2EState(
    page,
    `${label} loop restart`,
    (candidate) => {
      if (!isNativePlaybackActive(candidate) && !isWebPlaybackActive(candidate)) {
        return false;
      }
      const transport = transportTelemetry(candidate);
      if (transportState(transport) !== "playing") {
        return false;
      }
      const loopRange = loopTelemetry(candidate);
      if (!loopRange) {
        return false;
      }
      const loopStart = firstNumberField(loopRange, ["startSeconds", "start", "loopStartSeconds"]);
      const loopEnd = firstNumberField(loopRange, ["endSeconds", "end", "loopEndSeconds"]);
      if (
        loopStart === null
        || loopEnd === null
        || Math.abs(loopStart - expectedLoopStartSeconds) > 0.05
        || Math.abs(loopEnd - expectedLoopEndSeconds) > 0.05
      ) {
        return false;
      }

      const positionSeconds = transportPositionSeconds(transport);
      if (positionSeconds === null) {
        return false;
      }
      if (positionSeconds >= nearEndSeconds && positionSeconds <= expectedLoopEndSeconds + 0.5) {
        sawNearEnd = true;
        restartFromSeconds = positionSeconds;
      }
      const restarted = Boolean(
        sawNearEnd
        && restartFromSeconds !== null
        && positionSeconds <= nearStartSeconds
        && previousPositionSeconds !== null
        && positionSeconds < previousPositionSeconds - minBackwardJumpSeconds,
      );
      previousPositionSeconds = positionSeconds;
      return restarted;
    },
    { timeout, pollInterval: 100, requireTelemetry },
  );
  if (!state) {
    return null;
  }

  return {
    loopStartSeconds: expectedLoopStartSeconds,
    loopEndSeconds: expectedLoopEndSeconds,
    positionSeconds: transportPositionSeconds(transportTelemetry(state)),
    restartFromSeconds,
  };
}

function countInTelemetry(state) {
  return firstObjectField(state, [
    "countIn",
    "countInState",
    "precount",
    "preCount",
  ]) ?? firstObjectField(transportTelemetry(state), ["countIn", "countInState", "precount", "preCount"]);
}

function isCountInActive(countIn, state) {
  const activeValue = firstBooleanField(countIn, ["active", "isActive", "running", "isRunning"])
    ?? firstBooleanField(state, ["isPrecounting", "precounting"]);
  if (activeValue !== null) {
    return activeValue;
  }
  const stateName = firstStringField(countIn, ["state", "status", "phase"]);
  return stateName ? ["active", "running", "scheduled", "firing"].includes(stateName.toLowerCase()) : false;
}

function countInScheduledEvent(countIn) {
  return firstObjectField(countIn, ["lastScheduled", "scheduled"]) ?? countIn;
}

function countInFiredEvent(countIn) {
  const event = firstObjectField(countIn, ["lastFired", "fired"]);
  if (event) {
    return event;
  }
  const firedCount = countInFiredClickCount(countIn);
  return firedCount !== null && firedCount > 0 ? countIn : null;
}

function countInEventKind(event) {
  return firstStringField(event, ["trigger", "kind", "type", "mode", "scope", "reason"]);
}

function countInScheduledClickCount(countIn, scheduledEvent) {
  return firstCountField(scheduledEvent, [
    "scheduledClickCount",
    "scheduledClicks",
    "clickCount",
    "totalClicks",
    "clicks",
  ]) ?? firstCountField(countIn, [
    "scheduledClickCount",
    "scheduledClicks",
    "clickCount",
    "totalClicks",
    "clicks",
  ]);
}

function countInFiredClickCount(countIn) {
  const count = firstCountField(countIn, ["firedClickCount", "firedClicks", "clicksFired"]);
  if (count !== null) {
    return count;
  }
  const lastIndex = firstNumberField(countIn, ["lastFiredClickIndex", "currentClickIndex"]);
  return lastIndex === null ? null : lastIndex + 1;
}

function isNativePlaybackActive(state) {
  const active = firstBooleanField(state, [
    "nativeActive",
    "nativePlaybackActive",
    "isNativeActive",
  ]) ?? firstBooleanField(firstObjectField(state, ["native", "nativePlayback"]), ["active", "isActive"]);
  if (active !== null) {
    return active;
  }
  const backend = activeBackendName(state);
  return backend === "native" || backend?.startsWith("native-") === true;
}

function isWebPlaybackActive(state) {
  const backend = activeBackendName(state);
  const compactBackend = backend?.replace(/[^a-z0-9]/g, "") ?? "";
  return (
    backend === "browser" ||
    compactBackend === "webaudio" ||
    compactBackend === "browseraudio"
  );
}

function activeBackendName(state) {
  const backend = firstStringField(state, [
    "activePath",
    "activePlaybackPath",
    "playbackPath",
    "activeBackend",
    "backend",
    "playbackBackend",
  ])
    ?? firstStringField(transportTelemetry(state), ["backend", "owner", "playbackBackend"]);
  return backend ? normalizeKind(backend) : null;
}

function transportTelemetry(state) {
  return firstObjectField(state, ["transport", "playback", "nativeTransport"]) ?? state;
}

function transportState(transport) {
  return firstStringField(transport, ["transportState", "state", "status"])?.toLowerCase() ?? "unknown";
}

function transportPositionSeconds(transport) {
  return firstNumberField(transport, [
    "positionSeconds",
    "currentPositionSeconds",
    "playbackTimeSeconds",
    "currentTimeSeconds",
    "timeSeconds",
  ]);
}

function loopTelemetry(state) {
  const transport = transportTelemetry(state);
  return firstObjectField(transport, ["loop", "loopRange", "activeLoopRange"])
    ?? firstObjectField(state, ["loop", "loopRange", "activeLoopRange"]);
}

function nativeBufferHealthTelemetry(state) {
  return firstArrayField(state, ["bufferHealth", "nativeBufferHealth"])
    ?? firstArrayField(firstObjectField(state, ["native", "nativePlayback"]), ["bufferHealth"])
    ?? firstArrayField(transportTelemetry(state), ["bufferHealth", "nativeBufferHealth"]);
}

function kindMatches(actual, expected) {
  const normalizedActual = normalizeKind(actual);
  const normalizedExpected = normalizeKind(expected);
  const compactActual = normalizedActual.replace(/[^a-z0-9]/g, "");
  const compactExpected = normalizedExpected.replace(/[^a-z0-9]/g, "");
  if (normalizedExpected === "song-start" && normalizedActual === "song") {
    return true;
  }
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.includes(normalizedExpected) ||
    compactActual === compactExpected ||
    compactActual.includes(compactExpected)
  );
}

function normalizeKind(value) {
  return value.toLowerCase().replace(/[\s_]+/g, "-");
}

function firstObjectField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function firstArrayField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function firstStringField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstBooleanField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function firstNumberField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstCountField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return null;
}

function formatTelemetryState(state) {
  try {
    return JSON.stringify(state);
  } catch {
    return String(state);
  }
}

async function expectPosition(page, value, label) {
  try {
    await page.waitForFunction(
      ({ expected }) => {
        const input = document.querySelector('input[aria-label="Playback position"]');
        if (!(input instanceof HTMLInputElement)) {
          return false;
        }
        const actual = Number(input.value);
        return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.05;
      },
      { expected: value },
    );
  } catch (error) {
    const actual = await page
      .locator('input[aria-label="Playback position"]')
      .evaluate((input) => (input instanceof HTMLInputElement ? input.value : "missing"))
      .catch(() => "missing");
    throw new Error(
      `Expected playback position near ${value.toFixed(3)} ${label}, but saw ${actual}.\n${errorMessage(error)}`,
    );
  }
}

async function expectPositionAtLeast(page, value, label, options = {}) {
  try {
    await page.waitForFunction(
      ({ minimum }) => {
        const input = document.querySelector('input[aria-label="Playback position"]');
        if (!(input instanceof HTMLInputElement)) {
          return false;
        }
        const actual = Number(input.value);
        return Number.isFinite(actual) && actual >= minimum;
      },
      { minimum: value },
      options,
    );
  } catch (error) {
    const actual = await readPlaybackPosition(page).catch(() => "missing");
    throw new Error(
      `Expected playback position at or after ${value.toFixed(3)} for ${label}, but saw ${actual}.\n${errorMessage(error)}`,
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
