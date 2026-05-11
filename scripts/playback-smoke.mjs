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

  await page.getByLabel("Enable pre-count").check();
  await page.getByLabel("Enable loop pre-count").check();
  const playbackBpmInput = page.getByRole("spinbutton", { name: "Playback BPM" });
  await playbackBpmInput.fill("128");
  await playbackBpmInput.press("Enter");
  logStep("Song and loop pre-count enabled; tempo set to 128 BPM.");

  await page.getByRole("button", { name: "Play playback" }).click();
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
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
  await page.getByRole("button", { name: "Play playback" }).click();
  await page.getByRole("button", { name: "Pause playback" }).waitFor({ timeout: 5000 });
  await expectPositionAtLeast(page, startSeconds - 0.05, label, { timeout: 3500 });
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
