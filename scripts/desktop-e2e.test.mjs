import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_APPROVED_GROUPS,
  HEADLESS_CAPABLE_GROUPS,
  buildCaptureSidecar,
  failureArtifactNames,
  findPactlSinkBlock,
  optionsForGroup,
  pactlProperty,
  parseOptions,
  validateCaptureOutputPath,
} from "./desktop-e2e.mjs";

test("declares headless and CI group catalogs independently", () => {
  assert.deepEqual(HEADLESS_CAPABLE_GROUPS, ["playback", "diagnostics", "export"]);
  assert.deepEqual(CI_APPROVED_GROUPS, ["playback", "diagnostics", "export"]);
});

test("selects exact requested groups in catalog order and makes selectors runnable", () => {
  const options = parseOptions(["--group", "audio-capture", "--group=playback"]);

  assert.equal(options.run, true);
  assert.equal(options.headed, false);
  assert.deepEqual(options.groups, ["playback", "audio-capture"]);
});

test("maps bare run, CI, and all selectors to their intended groups", () => {
  assert.deepEqual(parseOptions(["--run"]).groups, ["playback", "diagnostics", "export"]);
  assert.deepEqual(parseOptions(["--ci"]).groups, ["playback", "diagnostics", "export"]);
  const all = parseOptions(["--all"]);
  assert.equal(all.headed, false);
  assert.deepEqual(all.groups, ["playback", "diagnostics", "export", "audio-capture"]);
});

test("leaves no-flag invocation in scaffold mode", () => {
  const options = parseOptions([]);

  assert.equal(options.run, false);
  assert.equal(options.list, false);
  assert.deepEqual(options.groups, []);
});

test("rejects conflicting or unknown group selectors", () => {
  assert.throws(() => parseOptions(["--group", "playback", "--ci"]), /cannot be combined/);
  assert.throws(
    () => parseOptions(["--group", "missing"]),
    (error) => error instanceof Error && error.message ===
      "Unknown --group \"missing\". Valid groups: playback, diagnostics, export, audio-capture.",
  );
  assert.throws(
    () => parseOptions(["--group"]),
    (error) => error instanceof Error && error.message ===
      "--group requires a group name. Valid groups: playback, diagnostics, export, audio-capture.",
  );
  assert.throws(
    () => parseOptions(["--group="]),
    (error) => error instanceof Error && error.message ===
      "--group requires a group name. Valid groups: playback, diagnostics, export, audio-capture.",
  );
});

test("keeps capture launch mode optional while selected capture remains strict", () => {
  const legacy = parseOptions(["--run", "--capture-audio"]);
  assert.equal(legacy.requireAudioCapture, false);
  assert.equal(legacy.headed, false);
  assert.deepEqual(legacy.groups, []);
  const selected = parseOptions(["--group", "audio-capture"]);
  assert.equal(selected.headed, false);
  assert.deepEqual(selected.groups, ["audio-capture"]);
  assert.throws(
    () => parseOptions(["--group", "playback", "--capture-audio"]),
    /include --group audio-capture or use --all/,
  );
  assert.throws(
    () => parseOptions(["--group", "playback", "--group", "diagnostics", "--capture-audio"]),
    /include --group audio-capture or use --all/,
  );
  const headedSelected = parseOptions(["--group", "audio-capture", "--headed"]);
  assert.equal(headedSelected.headed, true);
  assert.deepEqual(headedSelected.groups, ["audio-capture"]);
  const manual = parseOptions(["--run", "--manual-app", "--project-name", "Demo Song"]);
  assert.equal(manual.manualApp, true);
  assert.deepEqual(manual.groups, []);
  const headedAll = parseOptions(["--all", "--capture-device", "Loopback", "--headed"]);
  assert.equal(headedAll.headed, true);
  assert.equal(optionsForGroup(headedAll, "playback").captureAudio, false);
  assert.equal(optionsForGroup(headedAll, "audio-capture").captureAudio, true);
  assert.equal(optionsForGroup(headedAll, "audio-capture").requireAudioCapture, true);
});

test("names failure artifacts by smoke group", () => {
  assert.deepEqual(failureArtifactNames("export"), {
    image: "export-failure.png",
    summary: "export-failure-summary.json",
  });
});

test("parses PipeWire object serial from pactl sink output", () => {
  const pactlOutput = [
    "Sink #41",
    "\tState: IDLE",
    "\tName: alsa_output.pci-0000_00_1f.3.analog-stereo",
    "\tProperties:",
    '\t\tobject.serial = "214"',
    "",
    "Sink #42",
    "\tState: RUNNING",
    "\tName: tuneforge_playback_smoke_123_456",
    "\tProperties:",
    '\t\tmedia.class = "Audio/Sink"',
    '\t\tobject.serial = "9384"',
    '\t\tnode.name = "tuneforge_playback_smoke_123_456"',
  ].join("\n");

  const block = findPactlSinkBlock(pactlOutput, "tuneforge_playback_smoke_123_456");

  assert.match(block, /Name: tuneforge_playback_smoke_123_456/);
  assert.equal(pactlProperty(block, "object.serial"), "9384");
});

test("normalizes generated sidecar timings to capture file clock", () => {
  const sidecar = buildCaptureSidecar(
    captureWithPhases([
      phase("capture:start", 1000),
      phase("smoke:start", 3000),
      phase("song-precount:telemetry-passed", 5500, { startTimeSeconds: 0 }),
      phase("loop:set", 6000, { startSeconds: 10, endSeconds: 20 }),
      phase("loop-precount:telemetry-passed", 7000, { startTimeSeconds: 10 }),
      phase("loop:restart-detected", 12000, {
        loopStartSeconds: 10,
        loopEndSeconds: 20,
        restartFromSeconds: 19.8,
        positionSeconds: 10.1,
      }),
      phase("capture:stopped", 20529),
    ]),
    fileInfo({ durationSeconds: 19.115 }),
    { runError: null },
  );

  assert.equal(sidecar.device, "tuneforge_playback_smoke.monitor");
  assert.equal(sidecar.capture_target, "9384");
  assert.equal(sidecar.capture_target_kind, "pipewire-object-serial");
  assert.equal(sidecar.timing_normalization.offsetSeconds, 1.414);
  assert.deepEqual(
    sidecar.markers.map((marker) => marker.timeSeconds),
    [4.086, 5.586, 10.586],
  );
  assert.equal(sidecar.loops[0].startCaptureSeconds, 5.586);
  assert.equal(sidecar.loops[0].restartSeconds, 10.586);
  assert.equal(sidecar.loops[0].startSeconds, 10);
  assert.equal(sidecar.loops[0].endSeconds, 20);
});

test("clips or drops quiet windows that begin before capture file start", () => {
  const clipped = buildCaptureSidecar(
    captureWithPhases([
      phase("capture:start", 1000),
      phase("smoke:start", 2500),
      phase("capture:stopped", 20000),
    ]),
    fileInfo({ durationSeconds: 18 }),
    { runError: null },
  );

  assert.deepEqual(clipped.quietWindows, [{ startSeconds: 0, endSeconds: 0.4, maxRms: 0.003 }]);

  const dropped = buildCaptureSidecar(
    captureWithPhases([
      phase("capture:start", 1000),
      phase("smoke:start", 2300),
      phase("capture:stopped", 20000),
    ]),
    fileInfo({ durationSeconds: 18 }),
    { runError: null },
  );

  assert.deepEqual(dropped.quietWindows, []);
});

test("requires WAV capture output", () => {
  assert.equal(validateCaptureOutputPath("/tmp/playback-smoke-capture.wav"), "");
  assert.match(validateCaptureOutputPath("/tmp/playback-smoke-capture.raw"), /must end in \.wav/);
});

test("uses wider spacing tolerance only for AVFoundation capture", () => {
  const linuxSidecar = buildCaptureSidecar(
    captureWithPhases([]),
    fileInfo(),
    { runError: null },
  );
  const macSidecar = buildCaptureSidecar(
    captureWithPhases([], { provider: "avfoundation", providerCommand: "ffmpeg" }),
    fileInfo(),
    { runError: null },
  );

  assert.equal(linuxSidecar.markerToleranceSeconds, 0.2);
  assert.equal(linuxSidecar.spacingToleranceSeconds, 0.2);
  assert.equal(macSidecar.markerToleranceSeconds, 0.5);
  assert.equal(macSidecar.spacingToleranceSeconds, 0.3);
});

function captureWithPhases(phases, planOverrides = {}) {
  return {
    plan: {
      provider: "pipewire",
      providerCommand: "pw-record",
      device: "tuneforge_playback_smoke.monitor",
      captureTarget: "9384",
      captureTargetKind: "pipewire-object-serial",
      routeOutput: true,
      outputPath: "/tmp/playback-smoke-capture.wav",
      analysisOutputPath: "/tmp/playback-smoke-capture.analysis.json",
      ...planOverrides,
    },
    phases,
  };
}

function fileInfo(overrides = {}) {
  return {
    exists: true,
    sizeBytes: 4096,
    modifiedAt: "2026-05-28T00:00:00.000Z",
    durationSeconds: null,
    sampleRate: 48000,
    channels: 2,
    bitsPerSample: 16,
    ...overrides,
  };
}

function phase(name, elapsedMs, details = {}) {
  return {
    name,
    at: "2026-05-28T00:00:00.000Z",
    elapsed_ms: elapsedMs,
    details,
  };
}
