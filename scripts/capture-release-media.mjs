#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import net from "node:net";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultOutputDir = resolve(repoRoot, "apps/site/public/media/generated");
const fixtureTimestamp = "2026-04-18T13:16:00.000Z";
const childTailLines = 40;
const releaseMediaCaptureCatalog = [
  {
    id: "library",
    enabled: true,
    kind: "screenshot",
    fileName: "library.png",
    title: "Library with practice projects",
    caption: "A local practice library with analysis-ready projects.",
    alt: "TuneForge library showing three synthetic practice projects",
    fixture: "release-showcase-v1",
    route: "/",
    prepare: noPreparation,
    ready: readyLibrary,
    capture: captureScreenshotEntry,
  },
  {
    id: "playback",
    enabled: true,
    kind: "screenshot",
    fileName: "playback.png",
    title: "Playback workspace with lyrics and chords follow",
    caption: "Playback keeps synthetic lyrics and chords in view while the song moves.",
    alt: "TuneForge playback workspace following lyrics and chords for Midnight Count-In",
    fixture: "release-showcase-v1",
    route: "/projects/proj_release_showcase",
    prepare: preparePlayback,
    ready: readyPlayback,
    capture: captureScreenshotEntry,
  },
  {
    id: "tuner",
    enabled: true,
    kind: "screenshot",
    fileName: "tuner.png",
    title: "Chromatic tuner, slightly sharp",
    caption: "The chromatic tuner reading a deterministic 442 Hz synthetic tone.",
    alt: "TuneForge chromatic tuner showing an A at 442 hertz, slightly sharp",
    fixture: "release-showcase-v1",
    route: "/tools",
    prepare: prepareTuner,
    ready: readyTuner,
    capture: captureScreenshotEntry,
  },
  {
    id: "chord-dictionary",
    enabled: true,
    kind: "screenshot",
    fileName: "chord-dictionary.png",
    title: "Chord dictionary reference screen",
    caption: "A built-in chord reference for quick practice checks.",
    alt: "TuneForge chord dictionary reference screen",
    fixture: "release-showcase-v1",
    route: "/tools?tool=chord-dictionary",
    prepare: noPreparation,
    ready: readyChordDictionary,
    capture: captureScreenshotEntry,
  },
  {
    id: "jobs",
    enabled: true,
    kind: "screenshot",
    fileName: "jobs.png",
    title: "Activity jobs screen",
    caption: "Completed local analysis jobs for the synthetic release project.",
    alt: "TuneForge activity screen showing completed synthetic analysis jobs",
    fixture: "release-showcase-v1",
    route: "/activity",
    prepare: noPreparation,
    ready: readyJobs,
    capture: captureScreenshotEntry,
  },
  {
    id: "settings",
    enabled: true,
    kind: "screenshot",
    fileName: "settings.png",
    title: "Settings screen",
    caption: "Local processing and practice preferences in the TuneForge control room.",
    alt: "TuneForge settings control room",
    fixture: "release-showcase-v1",
    route: "/settings",
    prepare: noPreparation,
    ready: readySettings,
    capture: captureScreenshotEntry,
  },
  {
    id: "overview-video",
    enabled: true,
    kind: "video",
    fileName: "overview.webm",
    title: "Release media capture overview",
    caption: "A short, silent walkthrough of current TuneForge screens.",
    fixture: "release-showcase-v1",
    route: "/",
    posterId: "library",
    recordingItemIds: [
      "library",
      "playback",
      "tuner",
      "chord-dictionary",
      "jobs",
      "settings",
    ],
    record: recordOverviewVideo,
  },
];

validateReleaseMediaCatalog(releaseMediaCaptureCatalog);

if (isDirectRun()) {
  try {
    await main();
  } catch (error) {
    console.error(`[capture-release-media] ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.dryRun) {
    printPlan(options);
    return;
  }
  if (options.manifestOnly) {
    await writeManifest(options.outputDir, {
      status: "pending",
      items: [],
      notes: [
        "Manifest placeholder generated without screenshots or video.",
        "Run node scripts/capture-release-media.mjs --run to capture deterministic desktop UI media.",
      ],
    });
    console.log(`[capture-release-media] Wrote placeholder manifest to ${options.outputDir}.`);
    return;
  }
  if (!options.run) {
    printHelp();
    return;
  }

  await captureReleaseMedia(options);
}

function parseOptions(args) {
  const options = {
    allowPartial: false,
    appUrl: null,
    dryRun: false,
    headed: false,
    help: false,
    manifestOnly: false,
    outputDir: defaultOutputDir,
    recordVideo: true,
    run: false,
    theme: "dark",
    timeoutMs: 45_000,
    videoHoldMs: 1_800,
    viewport: { width: 1920, height: 980 },
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--allow-partial") {
      options.allowPartial = true;
    } else if (arg === "--run") {
      options.run = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--manifest-only") {
      options.manifestOnly = true;
    } else if (arg === "--no-video") {
      options.recordVideo = false;
    } else if (arg.startsWith("--app-url=")) {
      options.appUrl = readOptionValue(arg, "--app-url");
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = resolve(repoRoot, readOptionValue(arg, "--output-dir"));
    } else if (arg.startsWith("--timeout-ms=")) {
      const timeoutMs = Number(readOptionValue(arg, "--timeout-ms"));
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = timeoutMs;
    } else if (arg.startsWith("--theme=")) {
      const theme = readOptionValue(arg, "--theme");
      if (!["dark", "light", "system"].includes(theme)) {
        throw new Error("--theme must be one of dark, light, or system.");
      }
      options.theme = theme;
    } else if (arg.startsWith("--video-hold-ms=")) {
      const videoHoldMs = Number(readOptionValue(arg, "--video-hold-ms"));
      if (!Number.isInteger(videoHoldMs) || videoHoldMs < 0) {
        throw new Error("--video-hold-ms must be a non-negative integer.");
      }
      options.videoHoldMs = videoHoldMs;
    } else if (arg.startsWith("--viewport=")) {
      options.viewport = parseViewport(readOptionValue(arg, "--viewport"));
    } else {
      throw new Error(`Unknown option ${arg}. Use --help.`);
    }
  }

  return options;
}

function readOptionValue(arg, name) {
  const value = arg.slice(`${name}=`.length).trim();
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error("--viewport must use WIDTHxHEIGHT, for example 1920x980.");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 320) {
    throw new Error("--viewport dimensions must be at least 320.");
  }
  return { width, height };
}

function printHelp() {
  console.log(`Capture deterministic release media for the GitHub Pages site.

Usage:
  node scripts/capture-release-media.mjs --run
  node scripts/capture-release-media.mjs --run --app-url=http://127.0.0.1:1420
  node scripts/capture-release-media.mjs --dry-run
  node scripts/capture-release-media.mjs --manifest-only

Options:
  --run                  Capture every enabled release-media catalog entry.
  --app-url=<url>        Use an already running desktop Vite app. Defaults to starting one.
  --output-dir=<path>    Output directory. Defaults to apps/site/public/media/generated.
  --viewport=1920x980    Browser viewport for deterministic screenshots.
  --theme=<mode>         Theme to capture: dark, light, or system. Defaults to dark.
  --headed               Show the browser while capturing.
  --no-video             Intentionally capture screenshots only.
  --timeout-ms=<ms>      Startup and selector timeout. Defaults to 45000.
  --video-hold-ms=<ms>   Hold each captured screen in the overview video. Defaults to 1800.
  --allow-partial        Write a partial manifest without failing when media items miss.
  --manifest-only        Write a placeholder manifest without media files.
  --dry-run              Print planned outputs without writing files.

Notes:
  - Browser capture mocks backend HTTP with release media fixture data.
  - The script never downloads assets or calls external runtime services.`);
}

function printPlan(options) {
  console.log("[capture-release-media] Dry run. Planned outputs:");
  for (const item of expectedCatalogEntries(releaseMediaCaptureCatalog, options)) {
    console.log(`- ${join(options.outputDir, item.fileName)} (${item.title})`);
  }
  console.log(`- ${join(options.outputDir, "manifest.json")} (capture manifest)`);
}

async function captureReleaseMedia(options) {
  const { chromium } = loadPlaywright();
  await mkdir(options.outputDir, { recursive: true });

  const children = [];
  const capturedItems = [];
  const notes = [
    "Captured from current desktop React UI.",
    "Capture ran without external runtime services or user media.",
  ];
  let appUrl = options.appUrl;

  try {
    if (!appUrl) {
      const port = await selectPort();
      appUrl = `http://127.0.0.1:${port}`;
      const child = startDesktopDevServer(port);
      children.push(child);
      await waitForHttp(appUrl, { child, timeoutMs: options.timeoutMs });
      console.log(`[capture-release-media] Desktop dev server ready on ${appUrl}.`);
    }

    const browser = await chromium.launch({ headless: !options.headed });
    try {
      const screenshots = expectedCatalogEntries(releaseMediaCaptureCatalog, options)
        .filter((item) => item.kind === "screenshot");
      const screenshotItems = await captureCatalogScreenshots({
        appUrl,
        browser,
        catalog: releaseMediaCaptureCatalog,
        entries: screenshots,
        notes,
        options,
      });
      capturedItems.push(...screenshotItems);

      const videos = expectedCatalogEntries(releaseMediaCaptureCatalog, options)
        .filter((item) => item.kind === "video");
      for (const entry of videos) {
        try {
          const item = await captureCatalogVideo({
            appUrl,
            browser,
            catalog: releaseMediaCaptureCatalog,
            entry,
            options,
          });
          capturedItems.push(item);
        } catch (error) {
          const message = errorMessage(error);
          notes.push(`${entry.id} capture skipped: ${message}`);
          console.warn(`[capture-release-media] ${entry.id} skipped: ${message}`);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await stopChildren(children);
  }

  const accounting = captureAccounting(
    releaseMediaCaptureCatalog,
    capturedItems,
    options,
  );
  if (accounting.missingIds.length) {
    notes.push(`Required media missing: ${accounting.missingIds.join(", ")}.`);
  }

  await writeManifest(options.outputDir, {
    status: accounting.status,
    items: capturedItems,
    notes,
  });
  console.log(`[capture-release-media] Wrote ${capturedItems.length} media item(s) to ${options.outputDir}.`);

  if (!options.allowPartial && accounting.missingIds.length) {
    throw new Error(
      `Required media capture failed: ${accounting.missingIds.join(", ")}. ` +
        "Manifest was written for debugging; rerun with --allow-partial to keep exit 0.",
    );
  }
}

function loadPlaywright() {
  try {
    return desktopRequire("playwright");
  } catch {
    throw new Error(
      [
        "Playwright is not installed for the desktop workspace.",
        "Run pnpm install, then pnpm --filter @tuneforge/desktop exec playwright install chromium if browsers are missing.",
      ].join("\n"),
    );
  }
}

function startDesktopDevServer(port) {
  const desktopDir = resolve(repoRoot, "apps/desktop");
  const localViteBin = resolve(desktopDir, "node_modules/.bin/vite");
  if (existsSync(localViteBin)) {
    return startChild("desktop dev server", localViteBin, [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ], {
      VITE_API_BASE_URL: "http://127.0.0.1:8765",
    }, {
      cwd: desktopDir,
    });
  }

  return startChild("desktop dev server", "pnpm", [
    "--filter",
    "@tuneforge/desktop",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ], {
    VITE_API_BASE_URL: "http://127.0.0.1:8765",
  });
}

function startChild(label, command, args, env = {}, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];

  function pushOutput(chunk) {
    output.push(String(chunk).trimEnd());
    while (output.length > childTailLines) {
      output.shift();
    }
  }

  child.stdout.on("data", pushOutput);
  child.stderr.on("data", pushOutput);
  child.tail = () => output.filter(Boolean).join("\n");
  child.label = label;
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.warn(`[capture-release-media] ${label} exited with ${code ?? signal}.`);
    }
  });
  return child;
}

async function stopChildren(children) {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolveStop) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveStop();
            return;
          }
          child.once("exit", resolveStop);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 1500).unref();
        }),
    ),
  );
}

async function selectPort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url, { child, timeoutMs }) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${child.label} exited before becoming ready.\n${child.tail()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${errorMessage(lastError)}\n${child.tail()}`);
}

async function installPageStabilizers(page, options, captureKind) {
  const motionPolicy = captureMotionPolicy(captureKind);
  await page.addInitScript(({ animatePlayback, theme }) => {
    const fixedNow = Date.parse("2026-04-18T13:16:00.000Z");
    let callbackId = 1;
    const callbacks = new Map();
    const eventListeners = new Map();
    let tunerFrameTimer = null;
    let playbackPositionTimer = null;
    let playbackSnapshot = {
      sessionId: null,
      state: "stopped",
      positionSeconds: 0,
      durationSeconds: 182,
      playbackRate: 1,
      nativePlaybackSupported: true,
      fallbackReason: null,
      lanes: [],
      bufferHealth: [],
    };

    try {
      window.localStorage.setItem("tuneforge.theme-preference", theme);
      window.localStorage.setItem(
        "tuneforge.project-playback-state",
        JSON.stringify({
          proj_release_showcase: {
            selectedArtifactId: "art_source",
            selectedPrimaryArtifactId: "art_source",
            selectedStemSourceArtifactId: null,
            activeWorkspace: "playback",
            activeProjectPanel: "studio",
            playbackDisplayMode: "combined",
            capoTransposeSemitones: 0,
            precountEnabled: false,
            precountLoopEnabled: false,
            precountClickCount: 4,
            tempoTargetBpm: 104,
            loopRange: null,
            loopAlignmentMode: null,
            lyricsFollowEnabled: true,
            chordsFollowEnabled: true,
            stemControls: {},
            dismissedStemJobIds: [],
          },
        }),
      );
    } catch {
      // Local storage may be unavailable on about:blank before the app origin exists.
    }

    function createTunerFrame(index) {
      const sampleRate = 48_000;
      const sampleCount = 2_048;
      const frequencyHz = 442;
      const samples = Array.from({ length: sampleCount }, (_, sampleIndex) => {
        const phase = (2 * Math.PI * frequencyHz * (sampleIndex + index * sampleCount)) / sampleRate;
        return Math.sin(phase) * 0.28;
      });
      return {
        deviceId: "release-media-default-input",
        inputLevel: 0.28,
        sampleRate,
        samples,
        timestampMs: fixedNow + index * 24,
      };
    }

    function emitReleaseMediaEvent(event, payload) {
      const listenerIds = eventListeners.get(event) ?? [];
      for (const listenerId of listenerIds) {
        const callbackEntry = callbacks.get(listenerId);
        if (!callbackEntry) {
          continue;
        }
        callbackEntry.callback({
          event,
          id: listenerId,
          payload,
        });
        if (callbackEntry.once) {
          callbacks.delete(listenerId);
        }
      }
    }

    function startTunerFrames() {
      if (tunerFrameTimer) {
        window.clearInterval(tunerFrameTimer);
      }
      let frameIndex = 0;
      const emitFrame = () => {
        emitReleaseMediaEvent("audio://input-frame", createTunerFrame(frameIndex));
        frameIndex += 1;
      };
      emitFrame();
      tunerFrameTimer = window.setInterval(emitFrame, 48);
    }

    function stopTunerFrames() {
      if (tunerFrameTimer) {
        window.clearInterval(tunerFrameTimer);
        tunerFrameTimer = null;
      }
    }

    function playbackLanesFromRequests(lanes) {
      return lanes.map((lane) => ({
        id: lane.id,
        artifactId: lane.artifactId ?? null,
        role: lane.role,
        effectiveGain: lane.gain,
        muted: Boolean(lane.muted),
        solo: Boolean(lane.solo),
      }));
    }

    function bufferHealthForLanes(lanes) {
      return lanes.map((lane) => ({
        laneId: lane.id,
        artifactId: lane.artifactId ?? null,
        role: lane.role,
        ringFillSamples: 48_000,
        ringCapacitySamples: 96_000,
        underrunCount: 0,
        workerErrorCount: 0,
        lastWorkerError: null,
      }));
    }

    function updatePlaybackSnapshot(overrides = {}) {
      playbackSnapshot = {
        ...playbackSnapshot,
        ...overrides,
      };
      playbackSnapshot.bufferHealth = bufferHealthForLanes(playbackSnapshot.lanes);
      return { ...playbackSnapshot };
    }

    function emitPlaybackPosition() {
      emitReleaseMediaEvent("audio://position", {
        sessionId: playbackSnapshot.sessionId,
        positionSeconds: playbackSnapshot.positionSeconds,
        durationSeconds: playbackSnapshot.durationSeconds,
        state: playbackSnapshot.state,
      });
    }

    function startPlaybackPosition() {
      if (playbackPositionTimer) {
        window.clearInterval(playbackPositionTimer);
      }
      emitPlaybackPosition();
      if (!animatePlayback) {
        playbackPositionTimer = null;
        return;
      }
      playbackPositionTimer = window.setInterval(() => {
        const nextPosition = Math.min(
          playbackSnapshot.durationSeconds,
          playbackSnapshot.positionSeconds + 0.5,
        );
        updatePlaybackSnapshot({ positionSeconds: nextPosition });
        emitPlaybackPosition();
      }, 500);
    }

    function stopPlaybackPosition() {
      if (playbackPositionTimer) {
        window.clearInterval(playbackPositionTimer);
        playbackPositionTimer = null;
      }
    }

    function releaseMediaSyncStatus() {
      return {
        active: true,
        status: "listening",
        endpoint_hints: [
          "tuneforge-sync+tcp://127.0.0.1:48625?device_id=release_media_device_local&v=1",
        ],
        nearby_peers: [
          {
            device_id: "release_media_device_peer",
            display_name: "Rehearsal Laptop",
            public_key: "release-media-peer-public-key",
            short_fingerprint: "7d3f 91ac",
            trust_status: "match",
            trusted_peer_device_id: "release_media_device_peer",
            endpoint_hints: [
              "tuneforge-sync+tcp://127.0.0.1:48626?device_id=release_media_device_peer&v=1",
            ],
            last_seen_at: "2026-04-18T13:15:30.000Z",
          },
        ],
        active_run_id: "sync_release_001",
        active_phase: "receiving",
        active_message: "Transfer from trusted peer.",
        active_progress_at: "2026-04-18T13:15:58.000Z",
        active_elapsed_ms: 24_000,
        last_sync: {
          run_id: "sync_release_previous",
          peer_device_id: "release_media_device_peer",
          status: "completed",
          message: "Sync completed.",
          started_at: "2026-04-18T13:10:00.000Z",
          completed_at: "2026-04-18T13:10:09.000Z",
          duration_ms: 9_000,
          total_received_bytes: 12_582_912,
          total_served_bytes: 0,
          received_project_count: 1,
          skipped_project_count: 2,
          failed_project_count: 0,
          total_project_count: 3,
          received_artifacts: [
            {
              artifact_id: "proj_release_sync",
              bytes: 12_582_912,
              status: "received",
              duration_ms: 4_200,
            },
          ],
        },
        updated_at: "2026-04-18T13:16:00.000Z",
      };
    }

    async function invokeReleaseMediaCommand(command, args) {
      if (command === "backend_base_url") {
        return "http://127.0.0.1:8765";
      }
      if (command === "mobile_capabilities") {
        throw new Error("Mobile runtime unavailable in release media capture.");
      }
      if (command === "audio_get_capabilities") {
        return {
          platform: "release-media",
          backend: "release-media-fixture",
          nativePlaybackSupported: true,
          micCaptureSupported: true,
          micMonitoringSupported: false,
          systemInputVolumeSupported: false,
          emitsEvents: ["audio://position", "audio://ended", "audio://error", "audio://input-frame"],
          fallbackRequired: false,
          fallbackReason: null,
        };
      }
      if (command === "audio_list_input_devices") {
        return {
          supported: true,
          devices: [{ id: "release-media-default-input", label: "Release media input", isDefault: true }],
          error: null,
        };
      }
      if (command === "audio_list_output_devices") {
        return { supported: true, devices: [], error: null };
      }
      if (command === "audio_prepare_session") {
        const payload = args?.payload ?? {};
        const lanes = playbackLanesFromRequests(payload.lanes ?? []);
        updatePlaybackSnapshot({
          sessionId: payload.sessionId ?? "release-media-playback",
          state: "stopped",
          positionSeconds: 0,
          durationSeconds: payload.durationSeconds ?? 182,
          playbackRate: payload.playbackRate ?? 1,
          nativePlaybackSupported: true,
          fallbackReason: null,
          lanes,
        });
        return {
          id: playbackSnapshot.sessionId,
          nativePlaybackSupported: true,
          fallbackReason: null,
          laneCount: lanes.length,
        };
      }
      if (command === "audio_play") {
        const payload = args?.payload ?? {};
        const requestedStart = payload.startTimeSeconds;
        const startTimeSeconds =
          typeof requestedStart === "number" && Number.isFinite(requestedStart) && requestedStart > 0
            ? requestedStart
            : 10.2;
        const snapshot = updatePlaybackSnapshot({
          state: "playing",
          positionSeconds: startTimeSeconds,
          nativePlaybackSupported: true,
          fallbackReason: null,
        });
        startPlaybackPosition();
        return snapshot;
      }
      if (command === "audio_pause") {
        stopPlaybackPosition();
        return updatePlaybackSnapshot({ state: "paused" });
      }
      if (command === "audio_stop") {
        stopPlaybackPosition();
        return updatePlaybackSnapshot({ state: "stopped", positionSeconds: 0 });
      }
      if (command === "audio_seek") {
        const nextPosition = Number(args?.payload?.timeSeconds ?? 0);
        const snapshot = updatePlaybackSnapshot({
          positionSeconds: Number.isFinite(nextPosition) ? Math.max(0, nextPosition) : 0,
        });
        if (playbackSnapshot.state === "playing") {
          emitPlaybackPosition();
        }
        return snapshot;
      }
      if (command === "audio_set_lanes") {
        const payload = args?.payload ?? {};
        return updatePlaybackSnapshot({
          playbackRate: payload.playbackRate ?? playbackSnapshot.playbackRate,
          lanes: playbackLanesFromRequests(payload.lanes ?? []),
        });
      }
      if (command === "audio_set_click" || command === "audio_get_snapshot") {
        return updatePlaybackSnapshot();
      }
      if (command === "audio_get_input_state") {
        return {
          active: Boolean(tunerFrameTimer),
          deviceId: tunerFrameTimer ? "release-media-default-input" : null,
          inputLevel: tunerFrameTimer ? 0.28 : 0,
          monitorEnabled: false,
          monitorGain: 0,
          sampleRate: tunerFrameTimer ? 48_000 : null,
        };
      }
      if (command === "audio_start_input") {
        startTunerFrames();
        return {
          active: true,
          deviceId: "release-media-default-input",
          inputLevel: 0.28,
          monitorEnabled: false,
          monitorGain: 0,
          sampleRate: 48_000,
        };
      }
      if (command === "audio_stop_input") {
        stopTunerFrames();
        return {
          active: false,
          deviceId: null,
          inputLevel: 0,
          monitorEnabled: false,
          monitorGain: 0,
          sampleRate: null,
        };
      }
      if (command === "audio_set_monitor") {
        return {
          active: Boolean(tunerFrameTimer),
          deviceId: tunerFrameTimer ? "release-media-default-input" : null,
          inputLevel: tunerFrameTimer ? 0.28 : 0,
          monitorEnabled: Boolean(args?.payload?.enabled),
          monitorGain: Number(args?.payload?.gain ?? 0),
          sampleRate: tunerFrameTimer ? 48_000 : null,
        };
      }
      if (command === "get_system_default_input_volume" || command === "set_system_default_input_volume") {
        return {
          supported: false,
          volumePercent: null,
          muted: null,
          backend: null,
          error: "System input volume unavailable during release media capture.",
        };
      }
      if (command === "sync_transport_status" || command === "sync_transport_start_listener") {
        return releaseMediaSyncStatus();
      }
      if (command === "sync_transport_stop_listener") {
        return { ...releaseMediaSyncStatus(), active: false, status: "stopped" };
      }
      if (command === "sync_transport_sync_now") {
        return {
          ...releaseMediaSyncStatus(),
          active: false,
          status: "completed",
          last_sync: {
            ...releaseMediaSyncStatus().last_sync,
            run_id: "sync_release_manual",
            peer_device_id: args?.payload?.peerDeviceId ?? "release_media_device_peer",
          },
        };
      }
      if (command === "sync_transport_record_lifecycle_event") {
        return releaseMediaSyncStatus();
      }
      if (command === "plugin:event|listen") {
        const event = args?.event;
        const handlerId = args?.handler;
        if (typeof event === "string" && typeof handlerId === "number") {
          const listenerIds = eventListeners.get(event) ?? [];
          listenerIds.push(handlerId);
          eventListeners.set(event, listenerIds);
          return handlerId;
        }
        return callbackId++;
      }
      if (command === "plugin:event|unlisten") {
        const event = args?.event;
        const eventId = args?.eventId ?? args?.id;
        if (typeof event === "string" && typeof eventId === "number") {
          eventListeners.set(
            event,
            (eventListeners.get(event) ?? []).filter((listenerId) => listenerId !== eventId),
          );
        }
        return null;
      }
      throw new Error(`Release media mock does not implement native command ${command}.`);
    }

    Date.now = () => fixedNow;
    window.matchMedia = window.matchMedia || ((query) => ({
      addEventListener: () => undefined,
      addListener: () => undefined,
      dispatchEvent: () => false,
      matches: query.includes("prefers-reduced-motion") || (
        query.includes("prefers-color-scheme: dark") && theme !== "light"
      ),
      media: query,
      onchange: null,
      removeEventListener: () => undefined,
      removeListener: () => undefined,
    }));
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      convertFileSrc: (filePath) => `asset://localhost/${encodeURIComponent(filePath)}`,
      invoke: invokeReleaseMediaCommand,
      transformCallback: (callback, once = false) => {
        const id = callbackId++;
        callbacks.set(id, { callback, once });
        return id;
      },
      unregisterCallback: (id) => {
        callbacks.delete(id);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (event, eventId) => {
        if (typeof event === "string" && typeof eventId === "number") {
          eventListeners.set(
            event,
            (eventListeners.get(event) ?? []).filter((listenerId) => listenerId !== eventId),
          );
        }
      },
    };
  }, { animatePlayback: motionPolicy.animatePlayback, theme: options.theme });
}

function captureMotionPolicy(captureKind) {
  if (captureKind !== "screenshot" && captureKind !== "video") {
    throw new Error(`Unsupported capture kind ${captureKind}.`);
  }
  return { animatePlayback: captureKind === "video" };
}

async function createCaptureContext(browser, options, { recordVideo = false } = {}) {
  const context = await browser.newContext({
    colorScheme: options.theme === "light" ? "light" : "dark",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    recordVideo: recordVideo
      ? { dir: options.outputDir, size: options.viewport }
      : undefined,
    viewport: options.viewport,
  });
  await context.route("**/*", async (route) => {
    const handled = await maybeFulfillMockApi(route);
    if (!handled) {
      await route.continue();
    }
  });
  return context;
}

async function captureCatalogScreenshots({ appUrl, browser, catalog, entries, notes, options }) {
  if (!entries.length) {
    return [];
  }

  const capturedItems = [];
  const context = await createCaptureContext(browser, options);
  try {
    const page = await context.newPage();
    await installPageStabilizers(page, options, "screenshot");
    for (const entry of entries) {
      try {
        await entry.capture({ appUrl, entry, options, page });
        capturedItems.push(manifestItemForCatalogEntry(entry, catalog));
      } catch (error) {
        const message = errorMessage(error);
        notes.push(`${entry.id} capture skipped: ${message}`);
        console.warn(`[capture-release-media] ${entry.id} skipped: ${message}`);
      }
    }
  } finally {
    await context.close();
  }
  return capturedItems;
}

async function captureScreenshotEntry({ appUrl, entry, options, page }) {
  await prepareCatalogEntry(page, appUrl, entry, options.timeoutMs, "screenshot");
  await settleScreenshotPaint(page);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: join(options.outputDir, entry.fileName),
  });
}

async function settleScreenshotPaint(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolveFrame) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolveFrame));
    });
  });
}

async function captureCatalogVideo({ appUrl, browser, catalog, entry, options }) {
  const context = await createCaptureContext(browser, options, { recordVideo: true });
  let video = null;
  try {
    const page = await context.newPage();
    await installPageStabilizers(page, options, "video");
    video = page.video();
    await entry.record({ appUrl, catalog, entry, options, page });
  } finally {
    await context.close();
  }

  if (!video) {
    throw new Error(`${entry.id} did not create a browser video.`);
  }
  const videoPath = await video.path();
  await rename(videoPath, join(options.outputDir, entry.fileName));
  return manifestItemForCatalogEntry(entry, catalog);
}

async function prepareCatalogEntry(page, appUrl, entry, timeoutMs, captureKind) {
  await page.goto(`${appUrl}/#${entry.route}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  await entry.prepare({ captureKind, page, timeoutMs });
  await entry.ready({ captureKind, page, timeoutMs });
}

async function noPreparation() {}

async function preparePlayback({ captureKind, page, timeoutMs }) {
  if (captureKind === "screenshot") {
    return;
  }
  const playButton = page.getByRole("button", { name: "Play playback" });
  await playButton.waitFor({ timeout: timeoutMs });
  await playButton.click();
}

async function prepareTuner({ page, timeoutMs }) {
  const startButton = page.getByRole("button", { name: "Start" });
  await startButton.waitFor({ timeout: timeoutMs });
  await startButton.click();
}

async function readyLibrary({ page, timeoutMs }) {
  await page.getByRole("heading", { name: "Practice Projects" }).waitFor({ timeout: timeoutMs });
  await page.getByText(/3 projects ready/i).waitFor({ timeout: timeoutMs });
  await page.getByRole("link", { name: /Open Midnight Count-In project/i })
    .waitFor({ timeout: timeoutMs });
}

async function readyPlayback({ captureKind, page, timeoutMs }) {
  await page.getByRole("heading", { name: "Midnight Count-In" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("tab", { name: "Playback" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("heading", { name: "Lyrics + chords" }).waitFor({ timeout: timeoutMs });
  await page.locator(".lead-sheet").waitFor({ timeout: timeoutMs });
  await page.locator(".lead-sheet-word .lyrics-word", { hasText: /^Count$/ })
    .waitFor({ timeout: timeoutMs });
  if (captureKind === "screenshot") {
    await page.getByRole("button", { name: "Play playback" }).waitFor({ timeout: timeoutMs });
    const position = page.getByLabel("Playback position");
    await position.waitFor({ timeout: timeoutMs });
    const value = Number(await position.inputValue());
    if (value !== 0) {
      throw new Error(`Playback screenshot must stay stopped at 0 seconds; received ${value}.`);
    }
  } else {
    await page.getByRole("button", { name: "Pause playback" }).waitFor({ timeout: timeoutMs });
  }
}

async function readyTuner({ page, timeoutMs }) {
  await page.getByRole("heading", { name: "Tools" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("tab", { name: "Chromatic Tuner" }).waitFor({ timeout: timeoutMs });
  await page.locator(".tuner-readout__note", { hasText: /^A$/ }).waitFor({ timeout: timeoutMs });
  await page.getByText(/442\.00 Hz -> target 440\.00 Hz/i).waitFor({ timeout: timeoutMs });
}

async function readyChordDictionary({ page, timeoutMs }) {
  await page.getByRole("heading", { name: "Tools" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("heading", { name: "Chord Dictionary" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("tab", { name: "Chord Dictionary" }).waitFor({ timeout: timeoutMs });
}

async function readyJobs({ page, timeoutMs }) {
  await page.getByRole("heading", { name: "Activity" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("tab", { name: "Jobs" }).waitFor({ timeout: timeoutMs });
  await page.getByRole("heading", { name: "Jobs" }).waitFor({ timeout: timeoutMs });
  await page.getByText(/Transcript ready/i).waitFor({ timeout: timeoutMs });
}

async function readySettings({ page, timeoutMs }) {
  await page.getByRole("heading", { name: "Control Room" }).waitFor({ timeout: timeoutMs });
}

async function recordOverviewVideo({ appUrl, catalog, entry, options, page }) {
  for (const itemId of entry.recordingItemIds) {
    const item = catalog.find((candidate) => candidate.id === itemId);
    if (!item || item.kind !== "screenshot") {
      throw new Error(`${entry.id} references unavailable recording item ${itemId}.`);
    }
    await prepareCatalogEntry(page, appUrl, item, options.timeoutMs, "video");
    if (options.videoHoldMs > 0) {
      await sleep(options.videoHoldMs);
    }
  }
}

function validateReleaseMediaCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("Release-media capture catalog must contain at least one entry.");
  }

  const ids = new Set();
  const fileNames = new Set();
  for (const entry of catalog) {
    for (const field of ["id", "fileName", "title", "caption", "fixture", "route"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Release-media entry ${entry.id ?? "<unknown>"} requires ${field}.`);
      }
    }
    if (entry.enabled !== true && entry.enabled !== false) {
      throw new Error(`Release-media entry ${entry.id} requires a boolean enabled value.`);
    }
    if (ids.has(entry.id)) {
      throw new Error(`Release-media capture catalog has duplicate id ${entry.id}.`);
    }
    if (fileNames.has(entry.fileName)) {
      throw new Error(`Release-media capture catalog has duplicate file ${entry.fileName}.`);
    }
    ids.add(entry.id);
    fileNames.add(entry.fileName);

    if (entry.kind === "screenshot") {
      if (typeof entry.alt !== "string" || !entry.alt.trim()) {
        throw new Error(`Screenshot ${entry.id} requires alt text.`);
      }
      for (const callback of ["prepare", "ready", "capture"]) {
        if (typeof entry[callback] !== "function") {
          throw new Error(`Screenshot ${entry.id} requires a ${callback} callback.`);
        }
      }
    } else if (entry.kind === "video") {
      if (typeof entry.posterId !== "string" || !entry.posterId.trim()) {
        throw new Error(`Video ${entry.id} requires posterId.`);
      }
      if (typeof entry.record !== "function") {
        throw new Error(`Video ${entry.id} requires a record callback.`);
      }
    } else {
      throw new Error(`Release-media entry ${entry.id} has unsupported kind ${entry.kind}.`);
    }
  }

  for (const entry of catalog.filter((candidate) => candidate.kind === "video")) {
    const poster = catalog.find((candidate) => candidate.id === entry.posterId);
    if (!poster || poster.kind !== "screenshot" || !poster.enabled) {
      throw new Error(`Video ${entry.id} requires an enabled screenshot poster.`);
    }
    if (entry.recordingItemIds !== undefined) {
      if (!Array.isArray(entry.recordingItemIds) || entry.recordingItemIds.length === 0) {
        throw new Error(`Video ${entry.id} recordingItemIds must be a non-empty array.`);
      }
      for (const itemId of entry.recordingItemIds) {
        const item = catalog.find((candidate) => candidate.id === itemId);
        if (!item || item.kind !== "screenshot" || !item.enabled) {
          throw new Error(`Video ${entry.id} references invalid recording item ${itemId}.`);
        }
      }
    }
  }

  return catalog;
}

function manifestItemForCatalogEntry(entry, catalog = releaseMediaCaptureCatalog) {
  const item = {
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    src: `media/generated/${entry.fileName}`,
  };
  if (entry.kind === "screenshot") {
    item.alt = entry.alt;
  } else {
    const poster = catalog.find((candidate) => candidate.id === entry.posterId);
    if (!poster) {
      throw new Error(`${entry.id} references unknown poster ${entry.posterId}.`);
    }
    item.poster = `media/generated/${poster.fileName}`;
  }
  item.caption = entry.caption;
  item.label = entry.kind;
  return item;
}

function expectedCatalogEntries(catalog = releaseMediaCaptureCatalog, { recordVideo = true } = {}) {
  return catalog.filter((entry) => entry.enabled && (recordVideo || entry.kind !== "video"));
}

function captureAccounting(catalog, capturedItems, options = {}) {
  const expectedIds = expectedCatalogEntries(catalog, options).map((entry) => entry.id);
  const capturedIds = new Set(capturedItems.map((item) => item.id));
  const missingIds = expectedIds.filter((id) => !capturedIds.has(id));
  return {
    expectedIds,
    missingIds,
    status: missingIds.length === 0
      ? "captured"
      : capturedIds.size > 0
        ? "partial"
        : "pending",
  };
}

async function writeManifest(outputDir, { status, items, notes }) {
  await mkdir(outputDir, { recursive: true });
  const manifest = buildManifest({ status, items, notes });
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function buildManifest({ status, items, notes }) {
  return {
    schemaVersion: 1,
    status,
    generatedAt: generatedAt(),
    source: "scripts/capture-release-media.mjs",
    fixtureTimestamp,
    items,
    notes,
  };
}

function generatedAt() {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch) {
    const seconds = Number(sourceDateEpoch);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return fixtureTimestamp;
}

async function maybeFulfillMockApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.pathname.startsWith("/api/v1/")) {
    return false;
  }

  const payload = mockApiResponse(request.method(), url);
  if (!payload) {
    await route.fulfill({
      contentType: "application/json",
      status: 404,
      body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Mock endpoint not found." } }),
    });
    return true;
  }
  await route.fulfill({
    contentType: "application/json",
    status: payload.status ?? 200,
    body: JSON.stringify(payload.body),
  });
  return true;
}

function mockApiResponse(method, url) {
  const path = url.pathname;
  if (method !== "GET" && method !== "POST" && method !== "PATCH") {
    return null;
  }
  if (path === "/api/v1/health") {
    return { body: healthResponse() };
  }
  if (method === "GET" && path === "/api/v1/projects") {
    return { body: projectsResponse(url.searchParams) };
  }
  if (method === "GET" && path === "/api/v1/beat-backends") {
    return { body: { backends: beatBackends() } };
  }
  if (method === "GET" && path === "/api/v1/chord-backends") {
    return { body: { backends: chordBackends() } };
  }
  if (method === "GET" && path === "/api/v1/stem-models") {
    return { body: { models: stemModels() } };
  }
  if (method === "GET" && path === "/api/v1/jobs") {
    return { body: jobsResponse(url.searchParams) };
  }
  if (method === "GET" && path === "/api/v1/sync/preflight") {
    return { body: syncPreflight() };
  }
  if (method === "GET" && path === "/api/v1/sync/identity") {
    return { body: syncIdentity() };
  }
  if (method === "GET" && path === "/api/v1/sync/trusted-peers") {
    return { body: { trusted_peers: syncPeers() } };
  }

  const projectMatch = /^\/api\/v1\/projects\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (!projectMatch) {
    return null;
  }
  const projectId = decodeURIComponent(projectMatch[1]);
  const child = projectMatch[2] ?? "";
  const project = projects().find((item) => item.id === projectId);
  if (!project) {
    return { status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } } };
  }
  if (!child) {
    return { body: { project } };
  }
  if (child === "analysis") {
    return { body: { analysis: analysis(projectId) } };
  }
  if (child === "chords") {
    return { body: chords(projectId) };
  }
  if (child === "lyrics") {
    return { body: lyrics(projectId) };
  }
  if (child === "artifacts") {
    return { body: { artifacts: artifacts(projectId) } };
  }
  if (child === "sections") {
    return { body: { sections: sections(projectId) } };
  }
  return null;
}

function healthResponse() {
  return {
    name: "TuneForge",
    version: "release-media-fixture",
    backend_version: {
      package_version: "1.0.0",
      git_ref: "release-media-fixture",
    },
    frontend_version: {
      package_version: "1.0.0",
      git_ref: "release-media-fixture",
    },
    status: "ok",
    api_base_url: "http://127.0.0.1:8765/api/v1",
    data_root: "/tmp/tuneforge-release-media",
    default_export_format: "wav",
    preview_format: "wav",
  };
}

function projectsResponse(searchParams) {
  const search = searchParams.get("search")?.trim().toLowerCase() ?? "";
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  const filtered = search
    ? projects().filter((project) =>
        `${project.display_name} ${project.source_path}`.toLowerCase().includes(search),
      )
    : projects();
  const page = filtered.slice(offset, offset + limit);
  return {
    projects: page,
    total: filtered.length,
    limit,
    offset,
    has_more: offset + page.length < filtered.length,
  };
}

function projects() {
  return [
    project("proj_release_showcase", "Midnight Count-In", "/release-media/midnight-count-in.wav", 182),
    project("proj_release_sync", "Sync Rehearsal Draft", "/release-media/sync-rehearsal.wav", 214, {
      sync_state: "local",
    }),
    project("proj_release_tuner", "Tuner Reference Tone", "/release-media/a440-reference.wav", 46),
  ];
}

function project(id, displayName, sourcePath, durationSeconds, extra = {}) {
  return {
    id,
    display_name: displayName,
    source_path: sourcePath,
    imported_path: `/tmp/tuneforge-release-media/${basename(sourcePath)}`,
    duration_seconds: durationSeconds,
    sample_rate: 48_000,
    channels: 2,
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp,
    ...extra,
  };
}

function analysis(projectId) {
  return {
    project_id: projectId,
    estimated_key: "G major",
    key_confidence: 0.86,
    estimated_reference_hz: 439.8,
    tuning_offset_cents: -8,
    tempo_bpm: 116,
    analysis_version: "release-media-fixture",
    created_at: fixtureTimestamp,
  };
}

function chords(projectId) {
  const timeline = [
    { start_seconds: 0, end_seconds: 16, label: "G", confidence: 0.84, pitch_class: 7, quality: "major" },
    { start_seconds: 16, end_seconds: 32, label: "D", confidence: 0.81, pitch_class: 2, quality: "major" },
    { start_seconds: 32, end_seconds: 48, label: "Em", confidence: 0.78, pitch_class: 4, quality: "minor" },
    { start_seconds: 48, end_seconds: 64, label: "C", confidence: 0.8, pitch_class: 0, quality: "major" },
    { start_seconds: 64, end_seconds: 80, label: "G", confidence: 0.83, pitch_class: 7, quality: "major" },
  ];
  return {
    project_id: projectId,
    backend: "tuneforge-fast",
    source_artifact_id: "art_source",
    source_segments: timeline,
    has_user_edits: false,
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp,
    timeline,
  };
}

function lyrics(projectId) {
  const segments = [
    {
      start_seconds: 0,
      end_seconds: 7.5,
      text: "Count the bar and breathe in time",
      words: [
        { text: "Count", start_seconds: 0, end_seconds: 1.1, confidence: 0.92 },
        { text: "the", start_seconds: 1.1, end_seconds: 1.5, confidence: 0.91 },
        { text: "bar", start_seconds: 1.5, end_seconds: 2.3, confidence: 0.9 },
        { text: "and", start_seconds: 2.3, end_seconds: 2.9, confidence: 0.88 },
        { text: "breathe", start_seconds: 2.9, end_seconds: 4.2, confidence: 0.89 },
        { text: "in", start_seconds: 4.2, end_seconds: 4.8, confidence: 0.9 },
        { text: "time", start_seconds: 4.8, end_seconds: 6.3, confidence: 0.91 },
      ],
    },
    {
      start_seconds: 8,
      end_seconds: 15.5,
      text: "Bring the chorus down to practice speed",
      words: [],
    },
  ];
  return {
    project_id: projectId,
    backend: "openai-whisper",
    source_artifact_id: "art_source",
    source_kind: "ai",
    language: "en",
    language_override: null,
    source_segments: segments,
    segments,
    has_user_edits: false,
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp,
  };
}

function artifacts(projectId) {
  return [
    {
      id: "art_preview",
      project_id: projectId,
      type: "preview_mix",
      format: "wav",
      path: "/tmp/tuneforge-release-media/midnight-count-in-preview.wav",
      metadata: {
        retune: { reference_hz: 440 },
        transpose: { semitones: 2 },
      },
      created_at: fixtureTimestamp,
    },
    {
      id: "art_stems",
      project_id: projectId,
      type: "stems",
      format: "wav",
      path: "/tmp/tuneforge-release-media/stems",
      metadata: {
        model: "htdemucs_6s",
        sources: ["vocals", "drums", "bass", "guitar", "piano", "other"],
      },
      created_at: fixtureTimestamp,
    },
    {
      id: "art_source",
      project_id: projectId,
      type: "source_audio",
      format: "wav",
      path: "/tmp/tuneforge-release-media/midnight-count-in.wav",
      metadata: {},
      created_at: fixtureTimestamp,
    },
  ];
}

function sections(projectId) {
  return [
    { id: "intro", project_id: projectId, label: "Intro", start_seconds: 0, end_seconds: 16 },
    { id: "verse", project_id: projectId, label: "Verse", start_seconds: 16, end_seconds: 48 },
    { id: "chorus", project_id: projectId, label: "Chorus", start_seconds: 48, end_seconds: 80 },
  ];
}

function jobsResponse(searchParams) {
  const statusFilters = searchParams.getAll("status");
  const projectId = searchParams.get("project_id");
  const limit = Number(searchParams.get("limit") ?? 50);
  const offset = Number(searchParams.get("offset") ?? 0);
  const filtered = jobs().filter((job) => {
    const statusMatches = !statusFilters.length || statusFilters.includes(job.status);
    const projectMatches = !projectId || job.project_id === projectId;
    return statusMatches && projectMatches;
  });
  const page = filtered.slice(offset, offset + limit);
  return {
    jobs: page,
    total: filtered.length,
    limit,
    offset,
    has_more: offset + page.length < filtered.length,
  };
}

function jobs() {
  return [
    {
      id: "job_release_stems",
      project_id: "proj_release_showcase",
      type: "stems",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: fixtureTimestamp,
      started_at: fixtureTimestamp,
      updated_at: fixtureTimestamp,
      completed_at: fixtureTimestamp,
      stem_model: "htdemucs_6s",
      stem_model_label: "Default (6 stems model)",
      stage: "complete",
      stage_label: "Stems ready",
    },
    {
      id: "job_release_lyrics",
      project_id: "proj_release_showcase",
      type: "lyrics",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: fixtureTimestamp,
      started_at: fixtureTimestamp,
      updated_at: fixtureTimestamp,
      completed_at: fixtureTimestamp,
      stage: "complete",
      stage_label: "Transcript ready",
    },
    {
      id: "job_release_chords",
      project_id: "proj_release_showcase",
      type: "chords",
      status: "completed",
      progress: 100,
      error_message: null,
      created_at: fixtureTimestamp,
      started_at: fixtureTimestamp,
      updated_at: fixtureTimestamp,
      completed_at: fixtureTimestamp,
      chord_backend: "tuneforge-fast",
      chord_source: "source",
    },
  ];
}

function beatBackends() {
  return [
    {
      availability: "available",
      available: true,
      description: "TuneForge built-in beat detector.",
      desktopOnly: false,
      experimental: false,
      id: "built-in",
      label: "Built-in Beat Analysis",
      runtime_device: "cpu",
      unavailable_reason: null,
    },
    {
      availability: "available",
      available: true,
      description: "Advanced local beat detector.",
      desktopOnly: true,
      experimental: true,
      id: "beat-this",
      label: "Advanced Beat Analysis",
      runtime_device: "cpu",
      unavailable_reason: null,
    },
  ];
}

function chordBackends() {
  return [
    {
      availability: "available",
      available: true,
      capabilities: {
        desktopOnly: false,
        estimatedSpeed: "medium",
        experimental: false,
        supportsConfidence: true,
        supportsInversions: false,
        supportsNoChord: true,
        supportsSevenths: true,
      },
      description: "TuneForge built-in chord detector.",
      desktopOnly: false,
      experimental: false,
      id: "tuneforge-fast",
      label: "Built-in Chords",
      unavailable_reason: null,
    },
    {
      availability: "available",
      available: true,
      capabilities: {
        desktopOnly: true,
        estimatedSpeed: "slow",
        experimental: true,
        supportsConfidence: true,
        supportsInversions: true,
        supportsNoChord: true,
        supportsSevenths: true,
      },
      description: "Optional crema chord detector with richer chord vocabulary and inversion estimates.",
      desktopOnly: true,
      experimental: true,
      id: "crema-advanced",
      label: "Advanced Chords",
      unavailable_reason: null,
    },
  ];
}

function stemModels() {
  return [
    {
      availability: "available",
      available: true,
      default: true,
      description: "Demucs six-source model.",
      id: "htdemucs_6s",
      label: "Default (6 stems model)",
      sourceCount: 6,
      sources: ["vocals", "drums", "bass", "guitar", "piano", "other"],
      unavailable_reason: null,
    },
    {
      availability: "available",
      available: true,
      default: false,
      description: "Demucs two-source model.",
      id: "htdemucs_ft",
      label: "2 stems model",
      sourceCount: 2,
      sources: ["vocals", "instrumental"],
      unavailable_reason: null,
    },
  ];
}

function syncPreflight() {
  return {
    ok: true,
    library_ok: true,
    total_projects: 3,
    ready_projects: 3,
    missing_source_hash_projects: 0,
    invalid_source_hash_projects: 0,
    duplicate_source_hash_projects: 0,
    noncanonical_project_id_projects: 0,
    projects: [],
    duplicate_groups: [],
    data_root: "/tmp/tuneforge-release-media",
    sync_group_id: "release-media-fixture",
    checks: [],
    blocking_reasons: [],
    job_state: {
      state: "ready",
      running_job_count: 0,
      pending_job_count: 0,
      blocking_job_count: 0,
      blocking_job_counts: {},
      blocking_jobs: [],
      blocking_jobs_truncated: false,
      guidance: ["Local release-media sync state. No LAN transfer is running."],
    },
    manual_cleanup_required: false,
    manual_cleanup_guidance: [],
  };
}

function syncIdentity() {
  return {
    device_id: "release_media_device_local",
    sync_group_id: "release-media-fixture",
    display_name: "Studio Mac",
    public_key: "release-media-public-key",
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp,
  };
}

function syncPeers() {
  return [
    {
      device_id: "release_media_device_peer",
      display_name: "Rehearsal Laptop",
      public_key: "release-media-peer-public-key",
      endpoint_hints: ["tuneforge-sync+tcp://127.0.0.1:48625"],
      trusted_at: fixtureTimestamp,
      revoked_at: null,
      created_at: fixtureTimestamp,
      updated_at: fixtureTimestamp,
    },
  ];
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

export {
  buildManifest,
  captureAccounting,
  captureMotionPolicy,
  chordBackends,
  expectedCatalogEntries,
  manifestItemForCatalogEntry,
  parseOptions,
  releaseMediaCaptureCatalog,
  validateReleaseMediaCatalog,
};
