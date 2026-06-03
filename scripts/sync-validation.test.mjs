import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareEvidence,
  sampleStoragePeaks,
  summarizeEvidence,
  validateEvidence,
} from "./sync-validation.mjs";

function makeEvidence(overrides = {}) {
  return {
    capturedAt: "2026-06-02T12:00:00.000Z",
    scenario: "desktop-to-desktop",
    source: "tuneforge-sync+iroh",
    run: {
      label: "run-a",
      phase_timings: [
        { phase: "network_receive", duration_ms: 1200 },
        { phase: "staging_post", duration_ms: 400 },
        { phase: "reconciliation_apply", duration_ms: 300 },
      ],
    },
    transport: {
      selected_transport: "tuneforge-sync+iroh",
      candidate_transports: ["tuneforge-sync+tcp", "tuneforge-sync+iroh"],
      fallback_code: null,
      fallback_reason: null,
    },
    metrics: {
      network_receive_throughput_bytes_per_second: 2_000_000,
      backend_staging_throughput_bytes_per_second: 1_500_000,
      reconciliation_apply_ms: 300,
      project_imports_per_minute: 12,
      project_availability_gap_ms: 5_000,
      ttfa_ms: 900,
      transfer_counts: {
        requested: 8,
        received: 8,
        skipped: 0,
        already_staged: 0,
        failed: 0,
        retried: 0,
      },
    },
    projects: {
      imported: 2,
      labels: ["project-1", "project-2"],
    },
    artifacts: {
      transfer_counts: {
        requested: 8,
        received: 8,
        skipped: 0,
        already_staged: 0,
        failed: 0,
        retried: 0,
      },
    },
    lifecycle: {
      fallback_code: null,
      fallback_reason: null,
      ui_visible: true,
    },
    storage: {
      scratch_peak_bytes: 1234,
      staging_peak_bytes: 4321,
    },
    validation: {
      ok: true,
      ui_visible: true,
    },
    ...overrides,
  };
}

function makeSenderOnlyEvidence(overrides = {}) {
  const transferCounts = {
    requested: 0,
    received: 0,
    skipped: 0,
    already_staged: 0,
    failed: 0,
    retried: 0,
  };
  return makeEvidence({
    scenario: "listener-last-sync",
    source: {
      kind: "listener.last_sync",
      listenerActive: true,
      listenerStatus: "listening",
    },
    run: {
      label: "run_1",
      status: "completed",
      message: "Exchanged 1 local and 0 remote manifest(s); imported 0 project(s), received 0 artifact(s).",
    },
    transport: {
      selected_transport: "iroh",
      selected: "iroh",
      candidate_transports: ["iroh"],
      fallback_code: null,
      fallback_reason: null,
    },
    metrics: {
      network_receive_throughput_bytes_per_second: 42_409_204.7,
      backend_staging_throughput_bytes_per_second: null,
      reconciliation_apply_ms: null,
      project_imports_per_minute: 0,
      project_availability_gap_ms: null,
      ttfa_ms: 509,
      transfer_counts: transferCounts,
      transferCounts: {
        counts: transferCounts,
        servedArtifactRequests: 8,
        localManifestCount: 1,
        remoteManifestCount: 0,
        importedProjectCount: 0,
      },
      diagnostics: {
        total_received_bytes: 0,
        total_served_bytes: 227_671_416,
        imported_project_count: 0,
      },
    },
    projects: [],
    artifacts: [],
    lifecycle: {
      fallback_code: null,
      fallback_reason: null,
      ui_visible: true,
      phaseTimings: [
        { phase: "peer_authentication", durationMs: 17 },
        { phase: "manifest_exchange", durationMs: 3 },
        { phase: "local_manifest_export", durationMs: 166 },
        { phase: "serve_artifact_requests", durationMs: 5_147 },
      ],
    },
    storage: {
      scratch_peak_bytes: 0,
      staging_peak_bytes: 0,
    },
    validation: {
      ok: true,
      ui_visible: true,
    },
    ...overrides,
  });
}

test("validateEvidence passes valid scenario evidence", () => {
  const result = validateEvidence(makeEvidence(), { scenario: "desktop-to-desktop" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateEvidence passes sender-only evidence without receiver metrics", () => {
  const result = validateEvidence(makeSenderOnlyEvidence(), { scenario: "listener-last-sync" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.runRole, "sender_only");
  assert.equal(result.normalized.backendStagingThroughputBytesPerSecond, null);
  assert.equal(result.normalized.reconciliationApplyMs, null);
  assert.equal(result.normalized.projectAvailabilityGapMs, null);
});

test("validateEvidence reads nested counts when transfer_counts is diagnostic", () => {
  const evidence = makeSenderOnlyEvidence();
  evidence.metrics.transfer_counts = {
    statuses: {},
    localManifestCount: 1,
    remoteManifestCount: 0,
    servedArtifactRequests: 8,
  };

  const result = validateEvidence(evidence, { scenario: "listener-last-sync" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.runRole, "sender_only");
  assert.equal(result.normalized.transferCounts.requested, 0);
  assert.equal(result.normalized.transferCounts.received, 0);
});

test("validateEvidence treats local project mutations as receiver/import evidence", () => {
  for (const status of ["imported", "applied", "deleted"]) {
    const result = validateEvidence(makeSenderOnlyEvidence({
      projects: [{ label: "project_1", status }],
    }));
    assert.equal(result.ok, false, status);
    assert.equal(result.normalized.runRole, "receiver_or_import", status);
    assert.equal(result.normalized.localProjectMutationCount, 1, status);
    assert.match(result.errors.join(" "), /backend staging throughput/, status);
    assert.match(result.errors.join(" "), /reconciliation apply time/, status);
    assert.match(result.errors.join(" "), /project import cadence gap/, status);
  }
});

test("validateEvidence treats aggregate project mutations as receiver/import evidence", () => {
  const cases = [
    ["transferCounts imported", (metrics) => { metrics.transferCounts.importedProjectCount = 1; }],
    ["transferCounts applied", (metrics) => { metrics.transferCounts.appliedProjectCount = 1; }],
    ["transferCounts deleted", (metrics) => { metrics.transferCounts.deletedProjectCount = 1; }],
    ["transfer_counts imported", (metrics) => { metrics.transfer_counts.imported_project_count = 1; }],
    ["transfer_counts applied", (metrics) => { metrics.transfer_counts.applied_project_count = 1; }],
    ["transfer_counts deleted", (metrics) => { metrics.transfer_counts.deleted_project_count = 1; }],
    ["diagnostics imported", (metrics) => { metrics.diagnostics.imported_project_count = 1; }],
    ["diagnostics applied", (metrics) => { metrics.diagnostics.applied_project_count = 1; }],
    ["diagnostics deleted", (metrics) => { metrics.diagnostics.deleted_project_count = 1; }],
    ["top-level applied", (metrics) => { metrics.appliedProjectCount = 1; }],
  ];

  for (const [name, mutateMetrics] of cases) {
    const evidence = makeSenderOnlyEvidence({ projects: [] });
    mutateMetrics(evidence.metrics);
    const result = validateEvidence(evidence);
    assert.equal(result.ok, false, name);
    assert.equal(result.normalized.runRole, "receiver_or_import", name);
    assert.equal(result.normalized.localProjectMutationCount, 1, name);
    assert.match(result.errors.join(" "), /backend staging throughput/, name);
    assert.match(result.errors.join(" "), /reconciliation apply time/, name);
    assert.match(result.errors.join(" "), /project import cadence gap/, name);
  }
});

test("summarizeEvidence reports sender-only network work", () => {
  const summary = summarizeEvidence(makeSenderOnlyEvidence());
  assert.equal(summary.ok, true);
  assert.equal(summary.metrics.runRole, "sender_only");
  assert.equal(summary.bottleneck, "network");
  assert.deepEqual(summary.reasons, ["phase:network"]);
});

test("validateEvidence fails scenario mismatch and missing metrics", () => {
  const evidence = makeEvidence({
    scenario: "android-to-desktop",
    metrics: {
      ttfa_ms: 900,
    },
  });
  const result = validateEvidence(evidence, { scenario: "desktop-to-desktop" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /Scenario mismatch/);
  assert.match(result.errors.join(" "), /network receive throughput/);
});

test("validateEvidence still requires receiver metrics for receiver evidence", () => {
  const transferCounts = {
    requested: 8,
    received: 8,
    skipped: 0,
    already_staged: 0,
    failed: 0,
    retried: 0,
  };
  const result = validateEvidence(makeEvidence({
    metrics: {
      network_receive_throughput_bytes_per_second: 37_401_348.9,
      backend_staging_throughput_bytes_per_second: null,
      reconciliation_apply_ms: null,
      project_imports_per_minute: 9.86,
      project_availability_gap_ms: null,
      ttfa_ms: 652,
      transfer_counts: {
        statuses: { received: 8 },
        localManifestCount: 0,
        remoteManifestCount: 1,
      },
      transferCounts: {
        counts: transferCounts,
        servedArtifactRequests: 0,
        importedProjectCount: 1,
      },
      diagnostics: {
        total_received_bytes: 227_671_416,
        total_served_bytes: 0,
        imported_project_count: 1,
      },
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.normalized.runRole, "receiver_or_import");
  assert.match(result.errors.join(" "), /backend staging throughput/);
  assert.match(result.errors.join(" "), /reconciliation apply time/);
  assert.match(result.errors.join(" "), /project import cadence gap/);
  assert.doesNotMatch(result.errors.join(" "), /Missing required transfer count/);
});

test("summarizeEvidence classifies network bottleneck from phase timings", () => {
  const summary = summarizeEvidence(makeEvidence({
    run: {
      phase_timings: [
        { phase: "network_receive", duration_ms: 5_000 },
        { phase: "staging_post", duration_ms: 500 },
        { phase: "reconciliation_apply", duration_ms: 300 },
      ],
    },
  }));
  assert.equal(summary.bottleneck, "network");
});

test("validateEvidence rejects privacy leaks", () => {
  const leaked = makeEvidence({
    projects: {
      imported: 1,
      file_name: "secret-song.wav",
      absolute_path: "/Users/test/Music/secret-song.wav",
    },
    transport: {
      selected_transport: "tuneforge-sync+tcp",
      endpoint_hint: "192.168.1.24:47619",
    },
    validation: {
      ok: true,
      ui_visible: true,
      pairing_payload: "opaque-value",
    },
    lifecycle: {
      device_id: "abc123",
      ui_visible: true,
    },
  });
  const result = validateEvidence(leaked);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /absolute path/);
  assert.match(result.errors.join(" "), /endpoint hint/);
  assert.match(result.errors.join(" "), /filename-like value/);
  assert.match(result.errors.join(" "), /disallowed key/);
  assert.match(result.errors.join(" "), /raw identifier/);
});

test("validateEvidence rejects embedded path variants", () => {
  const cases = [
    ["windows", String.raw`Imported C:\Users\test\Music\secret song.wav from peer.`],
    ["file-url", "Fetched file:///Users/test/Music/secret-song.wav during staging."],
    ["quoted-posix", 'Imported "/Users/test/Music/secret song.wav" after retry.'],
  ];
  for (const [name, note] of cases) {
    const result = validateEvidence(makeEvidence({
      lifecycle: {
        fallback_code: null,
        fallback_reason: null,
        ui_visible: true,
        note,
      },
    }));
    assert.equal(result.ok, false, name);
    assert.match(result.errors.join(" "), /absolute path/, name);
  }
});

test("sampleStoragePeaks reports one sample as current snapshot", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sync-validation-"));
  const transportRoot = path.join(root, "transport");
  const stagingRoot = path.join(root, "staging");
  mkdirSync(transportRoot, { recursive: true });
  mkdirSync(path.join(transportRoot, "nested"), { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  writeFileSync(path.join(transportRoot, "a.bin"), Buffer.alloc(3));
  writeFileSync(path.join(transportRoot, "nested", "b.bin"), Buffer.alloc(5));
  writeFileSync(path.join(stagingRoot, "c.bin"), Buffer.alloc(7));

  try {
    const result = await sampleStoragePeaks({ transportRoot, stagingRoot });
    assert.equal(result.mode, "sampled");
    assert.equal(result.storage.transport.currentBytes, 8);
    assert.equal(result.storage.staging.currentBytes, 7);
    assert.equal(result.storage.combined.peakBytes, 15);
    assert.equal(result.sampleCount, 1);
    assert.equal(result.peakSemantics, "current_snapshot_not_run_peak");
    assert.equal(result.samples.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sampleStoragePeaks tracks peak across repeated samples", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sync-validation-"));
  const transportRoot = path.join(root, "transport");
  const stagingRoot = path.join(root, "staging");
  mkdirSync(transportRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  writeFileSync(path.join(transportRoot, "a.bin"), Buffer.alloc(3));
  writeFileSync(path.join(stagingRoot, "b.bin"), Buffer.alloc(5));

  const addPeakFile = setTimeout(() => {
    writeFileSync(path.join(stagingRoot, "peak.bin"), Buffer.alloc(11));
  }, 1);
  try {
    const result = await sampleStoragePeaks({
      transportRoot,
      stagingRoot,
      samples: 2,
      intervalMs: 10,
    });
    clearTimeout(addPeakFile);
    assert.equal(result.mode, "sampled");
    assert.equal(result.sampleCount, 2);
    assert.equal(result.intervalMs, 10);
    assert.equal(result.peakSemantics, "max_observed_across_samples");
    assert.equal(result.samples.length, 2);
    assert.equal(result.storage.staging.currentBytes, 16);
    assert.equal(result.storage.staging.peakBytes, 16);
    assert.equal(result.storage.combined.peakBytes, 19);
  } finally {
    clearTimeout(addPeakFile);
    rmSync(root, { recursive: true, force: true });
  }
});

test("compareEvidence compares candidate against Syncthing-like control without dependency", () => {
  const candidate = makeEvidence({
    source: "tuneforge-sync+iroh",
    metrics: {
      network_receive_throughput_bytes_per_second: 2_400_000,
      backend_staging_throughput_bytes_per_second: 1_700_000,
      reconciliation_apply_ms: 280,
      project_imports_per_minute: 14,
      project_availability_gap_ms: 4_000,
      ttfa_ms: 800,
      transfer_counts: {
        requested: 8,
        received: 8,
        skipped: 0,
        already_staged: 0,
        failed: 0,
        retried: 0,
      },
    },
  });
  const control = makeEvidence({
    source: "syncthing-control",
    metrics: {
      network_receive_throughput_bytes_per_second: 2_100_000,
      backend_staging_throughput_bytes_per_second: 1_600_000,
      reconciliation_apply_ms: 400,
      project_imports_per_minute: 11,
      project_availability_gap_ms: 6_000,
      ttfa_ms: 1_100,
      transfer_counts: {
        requested: 8,
        received: 8,
        skipped: 0,
        already_staged: 0,
        failed: 0,
        retried: 0,
      },
    },
  });

  const result = compareEvidence(candidate, control);
  assert.equal(result.ok, true);
  assert.equal(result.comparison.overall, "candidate");
  assert.equal(result.control.source, "syncthing-control");
  assert.equal(result.comparison.metrics.find((entry) => entry.metric === "ttfaMs")?.winner, "candidate");
});
