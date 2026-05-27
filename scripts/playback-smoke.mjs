#!/usr/bin/env node

import process from "node:process";
import { createRequire } from "node:module";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));

const appUrl = process.env.TUNEFORGE_SMOKE_APP_URL || "http://127.0.0.1:1420";
const projectId = readOption("project-id") || process.env.TUNEFORGE_SMOKE_PROJECT_ID || "";
const projectName = readOption("project-name") || process.env.TUNEFORGE_SMOKE_PROJECT_NAME || "";
const run = process.argv.includes("--run");
const headed = process.argv.includes("--headed");

if (!run) {
  console.log("[playback-smoke] Local smoke scaffold is available.");
  console.log("Start the desktop dev frontend, then run:");
  console.log(
    '  pnpm --filter @tuneforge/desktop test:e2e -- --run --project-name="Demo Song"',
  );
  process.exit(0);
}

if (!projectId && !projectName) {
  console.error(
    "[playback-smoke] Missing --project-name/--project-id or TUNEFORGE_SMOKE_PROJECT_NAME/TUNEFORGE_SMOKE_PROJECT_ID.",
  );
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = desktopRequire("playwright"));
} catch {
  console.error("[playback-smoke] Playwright is not installed locally.");
  console.error("  pnpm setup:dev");
  console.error("or:");
  console.error("  pnpm install");
  console.error("  pnpm --filter @tuneforge/desktop exec playwright install chromium");
  process.exit(1);
}

const browser = await chromium.launch({ headless: !headed });

try {
  const page = await browser.newPage();
  logStep(
    `Running ${headed ? "headed" : "headless"} smoke against ${appUrl} (${projectId ? `project ${projectId}` : `project "${projectName}"`}).`,
  );
  await openProject(page, { appUrl, projectId, projectName });
  await page.getByRole("heading", { name: /.+/ }).first().waitFor();
  logStep("Project opened.");
  await openPlayback(page);
  await resetSmokePlaybackState(page);

  const durationSeconds = await readPlaybackDuration(page);
  logStep(`Playback tab ready. Duration: ${formatSeconds(durationSeconds)}.`);
  const playbackBpmInput = page.getByRole("spinbutton", { name: "Playback BPM" });
  await playbackBpmInput.fill("128");
  await playbackBpmInput.press("Enter");
  logStep("Playback tempo set to 128 BPM.");
  const scrubberStartSeconds = stoppedStartProbeTime(durationSeconds);
  await seekTo(page, scrubberStartSeconds);
  await expectPosition(page, scrubberStartSeconds, "after stopped scrubber seek");
  await verifyPlayStartsFromSelection(page, scrubberStartSeconds, "stopped scrubber selection");
  logStep(`Stopped scrubber selection started at ${formatSeconds(scrubberStartSeconds)}.`);

  const practiceStartSeconds = await chooseStoppedPracticeSelection(page);
  if (practiceStartSeconds === null) {
    logStep("Skipped stopped lyrics/chords selection; no timed practice target was available.");
  } else {
    await verifyPlayStartsFromSelection(page, practiceStartSeconds, "stopped lyrics/chords selection");
    logStep(`Stopped lyrics/chords selection started at ${formatSeconds(practiceStartSeconds)}.`);
  }

  await page.getByLabel("Enable pre-count").check();
  await seekTo(page, 0);
  await expectPosition(page, 0, "before song-start pre-count");
  await page.getByRole("button", { name: "Play playback" }).click();
  const songCountInTelemetryAsserted = await assertCountInTelemetry(page, {
    expectedKind: "song-start",
    expectedStartSeconds: 0,
    label: "song-start pre-count",
  });
  await page.getByRole("button", { name: "Pause playback" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expectPosition(page, 0, "after song-start pre-count smoke");
  if (songCountInTelemetryAsserted) {
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
  logStep(`Loop set: ${formatSeconds(loopStartSeconds)} to ${formatSeconds(loopEndSeconds)}.`);

  await seekTo(page, outsideLoopSeconds);
  await expectPosition(page, loopStartSeconds, "after seeking outside the loop");
  logStep("Seek outside loop snapped back to loop start.");

  await page.getByLabel("Enable loop pre-count").check();
  logStep("Song and loop pre-count enabled.");

  await page.getByRole("button", { name: "Play playback" }).click();
  const loopCountInTelemetryAsserted = await assertCountInTelemetry(page, {
    expectedKind: "loop-start",
    expectedStartSeconds: loopStartSeconds,
    label: "loop pre-count",
  });
  if (loopCountInTelemetryAsserted) {
    logStep("Loop pre-count telemetry passed.");
  }
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
  await assertPlaybackTransportTelemetry(page, {
    expectedLoopEndSeconds: loopEndSeconds,
    expectedLoopStartSeconds: loopStartSeconds,
    expectedState: "playing",
    label: "loop playback",
  });
  await page.getByRole("button", { name: "Pause playback" }).click();
  await page.getByRole("button", { name: "Play playback" }).click();
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
  await page.getByRole("button", { name: "Stop playback" }).click();
  await expectPosition(page, loopStartSeconds, "after stop with active loop");
  logStep("Play, pause, resume, and stop passed.");
  logStep("Passed.");
} catch (error) {
  console.error(`[playback-smoke] ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

function readOption(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function logStep(message) {
  console.log(`[playback-smoke] ${message}`);
}

function formatSeconds(value) {
  return `${value.toFixed(3)}s`;
}

async function openProject(page, { appUrl, projectId, projectName }) {
  const baseUrl = appUrl.replace(/\/$/, "");
  if (projectId) {
    await gotoApp(page, `${baseUrl}/projects/${projectId}`);
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
    logStep(`Skipped ${label}; playback E2E telemetry bridge unavailable.`);
    return null;
  }

  throw new Error(
    `Timed out waiting for ${label} telemetry. Last state: ${formatTelemetryState(lastState)}.`,
  );
}

async function assertCountInTelemetry(page, { expectedKind, expectedStartSeconds, label }) {
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
    { timeout: 2500 },
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
    { timeout: 5000 },
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
  return true;
}

async function assertPlaybackTransportTelemetry(
  page,
  { expectedLoopEndSeconds, expectedLoopStartSeconds, expectedState, label },
) {
  const state = await waitForPlaybackE2EState(
    page,
    `${label} transport`,
    (candidate) => isNativePlaybackActive(candidate) || isWebPlaybackActive(candidate),
    { timeout: 2500 },
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
