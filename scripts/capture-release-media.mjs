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
const capturePlan = [
  {
    id: "library",
    kind: "screenshot",
    fileName: "library.png",
    title: "Library with practice projects",
    route: "/",
  },
  {
    id: "playback",
    kind: "screenshot",
    fileName: "playback.png",
    title: "Playback workspace with lyrics and chords follow",
    route: "/projects/proj_release_showcase",
  },
  {
    id: "tuner",
    kind: "screenshot",
    fileName: "tuner.png",
    title: "Chromatic tuner, slightly sharp",
    route: "/tools",
  },
  {
    id: "chord-dictionary",
    kind: "screenshot",
    fileName: "chord-dictionary.png",
    title: "Chord dictionary reference screen",
    route: "/tools?tool=chord-dictionary",
  },
  {
    id: "jobs",
    kind: "screenshot",
    fileName: "jobs.png",
    title: "Activity jobs screen",
    route: "/activity",
  },
  {
    id: "settings",
    kind: "screenshot",
    fileName: "settings.png",
    title: "Settings screen",
    route: "/settings",
  },
];

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
  --run                  Capture screenshots and an overview video.
  --app-url=<url>        Use an already running desktop Vite app. Defaults to starting one.
  --output-dir=<path>    Output directory. Defaults to apps/site/public/media/generated.
  --viewport=1920x980    Browser viewport for deterministic screenshots.
  --theme=<mode>         Theme to capture: dark, light, or system. Defaults to dark.
  --headed               Show the browser while capturing.
  --no-video             Skip overview WebM recording.
  --timeout-ms=<ms>      Startup and selector timeout. Defaults to 45000.
  --video-hold-ms=<ms>   Hold each captured screen in the overview video. Defaults to 1800.
  --allow-partial        Write a partial manifest without failing when screenshots miss.
  --manifest-only        Write a placeholder manifest without media files.
  --dry-run              Print planned outputs without writing files.

Notes:
  - Browser capture mocks backend HTTP with release media fixture data.
  - The script never downloads assets or calls external runtime services.`);
}

function printPlan(options) {
  console.log("[capture-release-media] Dry run. Planned outputs:");
  for (const item of capturePlan) {
    console.log(`- ${join(options.outputDir, item.fileName)} (${item.title})`);
  }
  if (options.recordVideo) {
    console.log(`- ${join(options.outputDir, "overview.webm")} (browser-recorded overview)`);
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
    const context = await browser.newContext({
      colorScheme: options.theme === "light" ? "light" : "dark",
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      recordVideo: options.recordVideo
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

    const page = await context.newPage();
    await installPageStabilizers(page, options);

    for (const item of capturePlan) {
      try {
        await captureScreenshot(page, appUrl, item, options);
        capturedItems.push(mediaItemForPlanItem(item));
      } catch (error) {
        notes.push(`${item.id} capture skipped: ${errorMessage(error)}`);
        console.warn(`[capture-release-media] ${item.id} skipped: ${errorMessage(error)}`);
      }
    }

    const video = options.recordVideo ? page.video() : null;

    await context.close();
    await browser.close();

    const videoItem = video ? await saveOverviewVideo(video, options.outputDir) : null;
    if (videoItem) {
      capturedItems.push(videoItem);
    }
  } finally {
    await stopChildren(children);
  }

  const missingRequiredScreenshots = requiredScreenshotIds().filter((id) =>
    !capturedItems.some((item) => item.id === id),
  );
  if (missingRequiredScreenshots.length) {
    notes.push(`Required screenshots missing: ${missingRequiredScreenshots.join(", ")}.`);
  }

  const status = capturedItems.length === capturePlan.length + (options.recordVideo ? 1 : 0)
      ? "captured"
      : capturedItems.length
        ? "partial"
        : "pending";

  await writeManifest(options.outputDir, {
    status,
    items: capturedItems,
    notes,
  });
  console.log(`[capture-release-media] Wrote ${capturedItems.length} media item(s) to ${options.outputDir}.`);

  if (!options.allowPartial && missingRequiredScreenshots.length) {
    throw new Error(
      `Required screenshot capture failed: ${missingRequiredScreenshots.join(", ")}. ` +
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

async function installPageStabilizers(page, options) {
  await page.addInitScript(({ theme }) => {
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
  }, { theme: options.theme });
}

async function captureScreenshot(page, appUrl, item, options) {
  await page.goto(`${appUrl}/#${item.route}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: options.timeoutMs });
  await waitForRouteContent(page, item, options.timeoutMs);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: join(options.outputDir, item.fileName),
  });
  if (options.recordVideo && options.videoHoldMs > 0) {
    await sleep(options.videoHoldMs);
  }
}

async function waitForRouteContent(page, item, timeoutMs) {
  if (item.id === "library") {
    await page.getByRole("heading", { name: "Practice Projects" }).waitFor({ timeout: timeoutMs });
    await page.getByText(/3 projects ready/i).waitFor({ timeout: timeoutMs });
    await page.getByRole("link", { name: /Open Midnight Count-In project/i }).waitFor({ timeout: timeoutMs });
  } else if (item.id === "playback") {
    await page.getByRole("heading", { name: "Midnight Count-In" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("tab", { name: "Playback" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("heading", { name: "Lyrics + chords" }).waitFor({ timeout: timeoutMs });
    await page.locator(".lead-sheet").waitFor({ timeout: timeoutMs });
    await page.locator(".lead-sheet-word .lyrics-word", { hasText: /^Count$/ }).waitFor({ timeout: timeoutMs });
    const playButton = page.getByRole("button", { name: "Play playback" });
    if (await playButton.count()) {
      await playButton.click();
    }
    await page.getByRole("button", { name: "Pause playback" }).waitFor({ timeout: timeoutMs });
  } else if (item.id === "tuner") {
    await page.getByRole("heading", { name: "Tools" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("tab", { name: "Chromatic Tuner" }).waitFor({ timeout: timeoutMs });
    const startButton = page.getByRole("button", { name: "Start" });
    if (await startButton.count()) {
      await startButton.click();
    }
    await page.locator(".tuner-readout__note", { hasText: /^A$/ }).waitFor({ timeout: timeoutMs });
    await page.getByText(/442\.00 Hz -> target 440\.00 Hz/i).waitFor({ timeout: timeoutMs });
  } else if (item.id === "chord-dictionary") {
    await page.getByRole("heading", { name: "Tools" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("heading", { name: "Chord Dictionary" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("tab", { name: "Chord Dictionary" }).waitFor({ timeout: timeoutMs });
  } else if (item.id === "jobs") {
    await page.getByRole("heading", { name: "Activity" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("tab", { name: "Jobs" }).waitFor({ timeout: timeoutMs });
    await page.getByRole("heading", { name: "Jobs" }).waitFor({ timeout: timeoutMs });
    await page.getByText(/Transcript ready/i).waitFor({ timeout: timeoutMs });
  } else if (item.id === "settings") {
    await page.getByRole("heading", { name: "Control Room" }).waitFor({ timeout: timeoutMs });
  }
}

function requiredScreenshotIds() {
  return capturePlan.filter((item) => item.kind === "screenshot").map((item) => item.id);
}

async function saveOverviewVideo(video, outputDir) {
  const videoPath = await video.path();
  const outputPath = join(outputDir, "overview.webm");
  await rename(videoPath, outputPath);
  return {
    id: "overview-video",
    title: "Release media capture overview",
    kind: "video",
    src: "media/generated/overview.webm",
    poster: "media/generated/library.png",
    caption: "Browser-recorded walkthrough of release media screens.",
    label: "video",
  };
}

function mediaItemForPlanItem(item) {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    src: `media/generated/${item.fileName}`,
    alt: item.title,
    caption: "Captured from the current TuneForge UI.",
    label: "screenshot",
  };
}

async function writeManifest(outputDir, { status, items, notes }) {
  await mkdir(outputDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    status,
    generatedAt: generatedAt(),
    source: "scripts/capture-release-media.mjs",
    fixtureTimestamp,
    items,
    notes,
  };
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
    name: "Tuneforge",
    version: "release-media-fixture",
    backend_version: {
      package_version: "0.1.0",
      git_ref: "release-media-fixture",
    },
    frontend_version: {
      package_version: "0.1.0",
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
      description: "Tuneforge built-in beat detector.",
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
      description: "Tuneforge built-in chord detector.",
      desktopOnly: false,
      experimental: false,
      id: "tuneforge-fast",
      label: "Built-in Chords",
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
