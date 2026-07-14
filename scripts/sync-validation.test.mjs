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
import {
  SYNC_PRIVACY_HASH_TOKENS,
  SYNC_PRIVACY_RAW_ID_TOKENS,
  SYNC_PRIVACY_SAFE_OPERATIONAL_TOKENS,
} from "./sync-privacy-token-cases.mjs";

const RECEIVER_TRANSFER_COUNTS = {
  requested: 8,
  received: 8,
  skipped: 0,
  already_staged: 0,
  failed: 0,
  retried: 0,
};
const ZERO_TRANSFER_COUNTS = Object.fromEntries(
  Object.keys(RECEIVER_TRANSFER_COUNTS).map((key) => [key, 0]),
);

function makeReceiverMetrics(overrides = {}) {
  return {
    network_receive_throughput_bytes_per_second: 2_000_000,
    total_received_bytes: 8_000_000,
    backend_staging_throughput_bytes_per_second: 1_500_000,
    reconciliation_apply_ms: 300,
    project_imports_per_minute: 12,
    project_availability_gap_ms: 5_000,
    ttfa_ms: 900,
    transfer_counts: { ...RECEIVER_TRANSFER_COUNTS },
    ...overrides,
  };
}

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
        { phase: "backend_staging", duration_ms: 1 },
        { phase: "reconciliation_apply", duration_ms: 300 },
      ],
    },
    transport: {
      selected_transport: "tuneforge-sync+iroh",
      candidate_transports: ["tuneforge-sync+tcp", "tuneforge-sync+iroh"],
      fallback_code: null,
      fallback_reason: null,
    },
    metrics: makeReceiverMetrics(),
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

function makeProjectAccountingEvidence({
  projectResultsByStatus,
  projectCounts,
  projects = [],
  metricOverrides = {},
}) {
  return makeEvidence({
    metrics: makeReceiverMetrics({
      project_imports_per_minute: 0,
      ...metricOverrides,
      transferCounts: projectCounts,
      projectResultsByStatus,
    }),
    projects,
  });
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
      label: "Run 1",
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
      throughputBytesPerSecond: 42_409_204.7,
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

function makeNoOpEvidence() {
  const evidence = makeSenderOnlyEvidence();
  Object.assign(evidence.metrics, { network_send_throughput_bytes_per_second: null,
    throughputBytesPerSecond: 0, project_imports_per_minute: null, ttfa_ms: null });
  Object.assign(evidence.metrics.transferCounts, { servedArtifactRequests: 0 });
  Object.assign(evidence.metrics.diagnostics, { total_received_bytes: 0, total_served_bytes: 0 });
  return evidence;
}

function makeReceiverMutationEvidence(overrides) {
  const evidence = makeSenderOnlyEvidence(overrides);
  evidence.metrics.network_send_throughput_bytes_per_second = null;
  Object.assign(evidence.metrics, { network_receive_throughput_bytes_per_second: 0, throughputBytesPerSecond: 0 });
  evidence.metrics.transferCounts.servedArtifactRequests = 0;
  evidence.metrics.diagnostics.total_served_bytes = 0;
  return evidence;
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
  assert.equal(result.normalized.networkReceiveThroughputBytesPerSecond, null);
  assert.equal(result.normalized.networkSendThroughputBytesPerSecond, 42_409_204.7);
  assert.equal(result.normalized.backendStagingThroughputBytesPerSecond, null);
  assert.equal(result.normalized.reconciliationApplyMs, null);
  assert.equal(result.normalized.projectAvailabilityGapMs, null);
});

test("validateEvidence accepts true no-op evidence without work metrics", () => {
  const result = validateEvidence(makeNoOpEvidence(), { scenario: "listener-last-sync" });

  assert.equal(result.ok, true);
  assert.equal(result.schemaPrivacyOk, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.runRole, "no_op");
  for (const metric of ["networkReceiveThroughputBytesPerSecond", "networkSendThroughputBytesPerSecond",
    "backendStagingThroughputBytesPerSecond", "reconciliationApplyMs", "projectImportsPerMinute",
    "projectAvailabilityGapMs", "ttfaMs"]) {
    assert.equal(result.normalized[metric], null, metric);
  }
});

test("validateEvidence requires positive byte proof for positive throughput", () => {
  for (const [bytes, ok] of [[null, false], [0, false], [-1, false], [8_000_000, true]]) {
    const result = validateEvidence(makeEvidence({ metrics: makeReceiverMetrics(
      { total_received_bytes: bytes, total_served_bytes: 0 }) }));
    assert.equal(result.ok, ok, String(bytes));
    if (!ok) assert.match(result.errors.join(" "), /Positive network receive throughput requires positive/);
    if (bytes === -1) assert.match(result.errors.join(" "), /received byte total.*combined byte total/);
  }
  for (const bytes of [null, -1]) {
    const sender = makeSenderOnlyEvidence(); sender.metrics.diagnostics.total_served_bytes = bytes;
    const errors = validateEvidence(sender).errors.join(" ");
    assert.match(errors, /Positive network send throughput requires positive/);
    if (bytes === -1) assert.match(errors, /served byte total/);
  }
  const aggregate = makeEvidence({ metrics: makeReceiverMetrics({ throughputBytesPerSecond: 1 }) });
  assert.match(validateEvidence(aggregate).errors.join(" "), /Positive aggregate network throughput requires positive/);
});

test("validateEvidence remaps legacy bidirectional aggregate receive throughput", () => {
  const evidence = makeEvidence();
  evidence.run.durationMs = 1_000;
  Object.assign(evidence.metrics, { total_received_bytes: 100, total_served_bytes: 200,
    network_receive_throughput_bytes_per_second: 300, throughputBytesPerSecond: 300,
    transferCounts: { servedArtifactRequests: 1 } });
  const result = validateEvidence(evidence);
  assert.equal(result.ok, true);
  assert.deepEqual([result.normalized.networkReceiveThroughputBytesPerSecond,
    result.normalized.networkSendThroughputBytesPerSecond,
    result.normalized.aggregateNetworkThroughputBytesPerSecond], [100, 200, 300]);
  delete evidence.metrics.network_receive_throughput_bytes_per_second;
  delete evidence.run.durationMs;
  const genericOnly = validateEvidence(evidence).normalized;
  assert.deepEqual([genericOnly.networkReceiveThroughputBytesPerSecond,
    genericOnly.networkSendThroughputBytesPerSecond], [null, null]);
});

test("validateEvidence trusts received artifact rows only when complete or count-matched", () => {
  for (const [receivedCount, complete, expected] of [[2, false, null], [1, false, 100], [2, true, null]]) {
    const mismatch = receivedCount === 2 && complete;
    const evidence = makeEvidence({ artifacts: [{ status: "received", sizeBytes: 100 },
      { status: "failed", sizeBytes: 900 }], run: { ...makeEvidence().run, received_artifacts_complete: complete },
      metrics: makeReceiverMetrics({ total_received_bytes: null,
        network_receive_throughput_bytes_per_second: mismatch ? null : 2_000_000,
        transfer_counts: { ...RECEIVER_TRANSFER_COUNTS, received: receivedCount } }) });
    const result = validateEvidence(evidence);
    assert.equal(result.normalized.totalReceivedBytes, expected);
    if (mismatch) assert.match(result.errors.join(" "),
      /Complete received artifact rows disagree with authoritative received count/);
  }
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

test("validateEvidence preserves schema-v1 byte and directional rate aliases", () => {
  const cases = [
    ...["served_bytes", "servedBytes"].map((alias) => [alias, "served", "totalServedBytes", 227_671_416]),
    ...["received_bytes", "receivedBytes"].map((alias) => [alias, "received", "totalReceivedBytes", 8_000_000]),
    ...["receive_throughput_bytes_per_second", "transport_receive_throughput_bytes_per_second"]
      .map((alias) => [alias, "receive", "networkReceiveThroughputBytesPerSecond", 1234]),
    ...["send_throughput_bytes_per_second", "transport_send_throughput_bytes_per_second"]
      .map((alias) => [alias, "send", "networkSendThroughputBytesPerSecond", 1234]),
    ["throughput_bytes_per_second", "receive", "networkReceiveThroughputBytesPerSecond", 1234],
    ["throughputBytesPerSecond", "send", "networkSendThroughputBytesPerSecond", 4321],
  ];
  for (const [alias, kind, field, expected] of cases) {
    const evidence = ["served", "send"].includes(kind) ? makeSenderOnlyEvidence() : makeEvidence();
    if (kind === "served") delete evidence.metrics.diagnostics.total_served_bytes;
    else if (kind === "received") delete evidence.metrics.total_received_bytes;
    else delete evidence.metrics[`network_${kind}_throughput_bytes_per_second`];
    if (alias === "throughput_bytes_per_second") evidence.metrics.total_served_bytes = 0;
    if (alias === "throughputBytesPerSecond") delete evidence.metrics.network_receive_throughput_bytes_per_second;
    evidence.metrics[alias] = expected;
    const result = validateEvidence(evidence);
    assert.equal(result.ok, true, alias);
    assert.equal(result.normalized[field], expected, alias);
  }
});

test("validateEvidence treats local project mutations as receiver/import evidence", () => {
  for (const status of ["imported", "applied", "deleted"]) {
    const result = validateEvidence(makeReceiverMutationEvidence({
      projects: [{ label: "Project 1", status }],
    }));
    assert.equal(result.ok, false, status);
    assert.equal(result.normalized.runRole, "receiver_or_import", status);
    assert.equal(result.normalized.localProjectMutationCount, 1, status);
    assert.match(result.errors.join(" "), /reconciliation apply time/, status);
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
    const evidence = makeReceiverMutationEvidence({ projects: [] });
    mutateMetrics(evidence.metrics);
    const result = validateEvidence(evidence);
    assert.equal(result.ok, false, name);
    assert.equal(result.normalized.runRole, "receiver_or_import", name);
    assert.equal(result.normalized.localProjectMutationCount, 1, name);
    assert.match(result.errors.join(" "), /reconciliation apply time/, name);
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

test("validateEvidence bounds wall-clock apply timing but not aggregate work", () => {
  const valid = validateEvidence(makeEvidence({
    run: { durationMs: 1_000 },
    metrics: makeReceiverMetrics({
      reconciliation_apply_ms: 900,
      reconciliation_apply_aggregate_ms: 1_500,
    }),
  }));
  assert.equal(valid.ok, true);
  assert.equal(valid.normalized.reconciliationApplyAggregateMs, 1_500);

  const invalid = validateEvidence(makeEvidence({
    run: { durationMs: 1_000 },
    metrics: makeReceiverMetrics({ reconciliation_apply_ms: 1_200 }),
  }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(" "), /reconciliation_apply_ms exceeds run wall-clock duration/);
});

test("validateEvidence rejects impossible timing evidence", () => {
  const cases = [
    ["run duration", (evidence) => { evidence.run.durationMs = -1; }],
    ["reconciliation_apply_ms", (evidence) => { evidence.metrics.reconciliation_apply_ms = -1; }],
    ["reconciliation_apply_aggregate_ms", (evidence) => {
      evidence.metrics.reconciliation_apply_aggregate_ms = -1;
    }],
    ["project_availability_gap_ms", (evidence) => { evidence.metrics.project_availability_gap_ms = -1; }],
    ["ttfa_ms", (evidence) => { evidence.metrics.ttfa_ms = -1; }],
    ["Phase timing durations", (evidence) => { evidence.run.phase_timings[0].duration_ms = -1; }],
  ];
  for (const [expectedError, mutate] of cases) {
    const evidence = makeEvidence({ run: { ...makeEvidence().run, durationMs: 1_000 } });
    mutate(evidence);
    assert.match(validateEvidence(evidence).errors.join(" "), new RegExp(`${expectedError} must be non-negative`));
  }

  const aggregateOnlyWithWallClock = makeEvidence({
    metrics: makeReceiverMetrics({
      reconciliation_apply_ms: 300,
      reconciliation_apply_aggregate_ms: 500,
      reconciliation_apply_timing: { semantics: "aggregate_only" },
    }),
  });
  assert.match(
    validateEvidence(aggregateOnlyWithWallClock).errors.join(" "),
    /aggregate_only semantics require reconciliation_apply_ms to be null/,
  );

  const aggregateBelowWallClock = makeEvidence({
    metrics: makeReceiverMetrics({
      reconciliation_apply_ms: 500,
      reconciliation_apply_aggregate_ms: 300,
    }),
  });
  assert.match(
    validateEvidence(aggregateBelowWallClock).errors.join(" "),
    /reconciliation_apply_aggregate_ms must be at least reconciliation_apply_ms/,
  );
});

test("validateEvidence accepts exporter-shaped aggregate-only timing", () => {
  const evidence = makeEvidence();
  evidence.run.durationMs = 1_000;
  evidence.run.phaseTimings = [
    { phase: "reconciliation_apply", durationMs: 750 },
    { phase: "reconciliation_apply", durationMs: 750 },
  ];
  Object.assign(evidence.metrics, makeReceiverMetrics({
    project_imports_per_minute: 0,
    reconciliation_apply_ms: null,
    reconciliation_apply_aggregate_ms: 1_500,
    reconciliation_apply_timing: { semantics: "aggregate_only" },
    transfer_counts: ZERO_TRANSFER_COUNTS,
    projectResultsByStatus: { skipped: 2 },
    transferCounts: { skippedProjectCount: 2, totalProjectCount: 2 },
  }));
  evidence.projects = [
    { label: "Project 1", status: "skipped" },
    { label: "Project 2", status: "skipped" },
  ];
  evidence.validation = { ...evidence.validation, scope: "run_outcome", outcomeOk: true, privacySafe: true };
  const result = validateEvidence(evidence);

  assert.equal(result.ok, true);
  assert.equal(result.schemaPrivacyOk, true);
  assert.equal(result.normalized.reconciliationApplyMs, null);
  assert.equal(result.normalized.reconciliationApplyAggregateMs, 1_500);
  assert.equal(result.normalized.reconciliationApplyTimingSemantics, "aggregate_only");
  assert.equal(result.normalized.projectCounts.skipped, 2);
  assert.equal(result.normalized.validationScope, "run_outcome");
  assert.equal(result.normalized.runOutcomeOk, true);
});

test("validateEvidence still requires wall-clock apply timing without aggregate-only semantics", () => {
  for (const timing of [
    { reconciliation_apply_ms: null },
    { reconciliation_apply_ms: null, reconciliation_apply_aggregate_ms: 1_500 },
  ]) {
    const result = validateEvidence(makeEvidence({ metrics: makeReceiverMetrics(timing) }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /Missing required metric: reconciliation apply time/);
  }
});

test("validateEvidence keeps failed and conflicted project counts separate", () => {
  const result = validateEvidence(makeProjectAccountingEvidence({
    projectResultsByStatus: { failed: 1, conflicted: 1, skipped: 1 },
    projectCounts: {
      failedProjectCount: 1,
      conflictedProjectCount: 1,
      skippedProjectCount: 1,
      totalProjectCount: 3,
    },
    projects: [
      { label: "Project 1", status: "failed" },
      { label: "Project 2", status: "conflicted" },
      { label: "Project 3", status: "skipped" },
    ],
  }));

  assert.equal(result.ok, true);
  assert.equal(result.normalized.transferCounts.failed, 0);
  assert.equal(result.normalized.projectCounts.failed, 1);
  assert.equal(result.normalized.projectCounts.conflicted, 1);
});

test("validateEvidence excludes explicitly non-final project rows from final accounting", () => {
  const result = validateEvidence(makeProjectAccountingEvidence({
    projectResultsByStatus: { skipped: 1 },
    projectCounts: { skippedProjectCount: 1, totalProjectCount: 1 },
    projects: [
      { label: "Project 1", status: "failed", isFinal: false },
      { label: "Project 2", status: "skipped", isFinal: true },
    ],
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.normalized.projectResultsByStatus, { skipped: 1 });
  assert.equal(result.normalized.projectCounts.failed, 0);
});

test("validateEvidence accepts aggregate-only project status evidence when counts agree", () => {
  const result = validateEvidence(makeProjectAccountingEvidence({
    projectResultsByStatus: { failed: 1, conflicted: 1 },
    projectCounts: { failedProjectCount: 1, conflictedProjectCount: 1, totalProjectCount: 2 },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.normalized.projectResultsByStatus, { failed: 1, conflicted: 1 });
  assert.equal(result.normalized.projectCounts.total, 2);
});

test("validateEvidence keeps manifest errors explicit and outside failed project totals", () => {
  const manifestOnly = validateEvidence(makeProjectAccountingEvidence({
    projectResultsByStatus: {},
    projectCounts: {
      failedProjectCount: 0,
      totalProjectCount: 0,
      manifestExportErrorCount: 2,
    },
    projects: [{ label: "Project 1", status: "manifest_export_error" }],
  }));
  assert.equal(manifestOnly.ok, true);
  assert.deepEqual(manifestOnly.normalized.projectResultsByStatus, {});
  assert.equal(manifestOnly.normalized.projectCounts.failed, 0);
  assert.equal(manifestOnly.normalized.projectCounts.total, 0);
  assert.equal(manifestOnly.normalized.projectCounts.manifestExportErrors, 2);

  const overlap = validateEvidence(makeProjectAccountingEvidence({
    projectResultsByStatus: { failed: 1 },
    projectCounts: { failedProjectCount: 1, totalProjectCount: 1, manifestExportErrorCount: 1 },
    projects: [
      { label: "Project 1", status: "failed" },
      { label: "Project 1", status: "manifest_export_error" },
    ],
  }));
  assert.equal(overlap.ok, true);
  assert.equal(overlap.normalized.projectCounts.failed, 1);
  assert.equal(overlap.normalized.projectCounts.manifestExportErrors, 1);
});

test("validateEvidence rejects inconsistent project maps and count claims", () => {
  const evidence = makeProjectAccountingEvidence({
    projectResultsByStatus: { failed: 1 },
    projectCounts: { failedProjectCount: 1, totalProjectCount: 1 },
  });
  evidence.metrics.failedProjectCount = 2;
  const result = validateEvidence(evidence);

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /failed project count fields disagree/);
  assert.match(result.errors.join(" "), /failedProjectCount disagrees with projectResultsByStatus\.failed/);
});

test("validateEvidence validates manifest count aliases independently", () => {
  const evidence = makeProjectAccountingEvidence({
    projectResultsByStatus: {},
    projectCounts: {
      failedProjectCount: 0,
      totalProjectCount: 0,
      manifestErrorCount: 2,
      manifestExportErrorCount: 1,
    },
    projects: [{ label: "Project 1", status: "manifest_export_error" }],
  });
  const result = validateEvidence(evidence);

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /manifestExportErrors project count fields disagree/);
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

test("summarizeEvidence does not classify planning phases as reconciliation apply", () => {
  const summary = summarizeEvidence(makeEvidence({
    run: {
      phase_timings: [
        { phase: "reconciliation_plan", duration_ms: 5_000 },
        { phase: "staging_apply_plan", duration_ms: 4_000 },
        { phase: "network_receive", duration_ms: 1_000 },
      ],
    },
  }));

  assert.equal(summary.bottleneck, "staging");
  assert.deepEqual(summary.reasons, ["phase:staging"]);
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

test("validateEvidence allows operational status tokens", () => {
  const evidence = makeEvidence({
    run: {
      label: "Run 1",
      status: "completed",
      message: `${SYNC_PRIVACY_SAFE_OPERATIONAL_TOKENS.join(" ")} ` +
        "prefix_checksum_mismatch prefix.hash_retry_pending prefix-sha256_mismatch",
    },
    validation: {
      ok: false,
      issues: SYNC_PRIVACY_SAFE_OPERATIONAL_TOKENS.filter((token) => token !== "artifact_transfer"),
      ui_visible: true,
    },
  });
  const result = validateEvidence(evidence);
  const summary = summarizeEvidence(evidence);

  assert.equal(result.ok, true);
  assert.equal(result.schemaPrivacyOk, true);
  assert.equal(result.normalized.validationScope, null);
  assert.equal(result.normalized.runOutcomeOk, false);
  assert.equal(summary.schemaPrivacyOk, true);
  assert.equal(summary.runOutcomeOk, false);
  assert.deepEqual(summary.reasons, ["run_outcome_failed"]);
});

test("validateEvidence rejects near-miss phase identifiers", () => {
  for (const token of ["artifact_shadow", "artifact_transfer_shadow", "artifact_staging_shadow", "artifact_cleanup_shadow"]) {
    const result = validateEvidence(makeEvidence({ run: { label: "Run 1", message: token } }));
    assert.equal(result.ok, false, token);
    assert.match(result.errors.join(" "), /raw identifier token/, token);
  }
  for (const phase of ["network_receive_shadow", "staging_post_shadow", "staging_apply_plan_shadow",
    "backend_staging_shadow"]) {
    const result = validateEvidence(makeEvidence({ run: { phase_timings: [{ phase, duration_ms: 1 }] } }));
    assert.equal(result.ok, false, phase);
    assert.match(result.errors.join(" "), /unknown phase/, phase);
  }
});

test("validateEvidence rejects raw identifier and hash tokens in free text", () => {
  const result = validateEvidence(makeEvidence({
    run: {
      label: "Run 1",
      status: "completed",
      message: `Completed with ${SYNC_PRIVACY_RAW_ID_TOKENS.join(" ")} ${SYNC_PRIVACY_HASH_TOKENS.join(" ")}.`,
      error: `Checksum failed for ${SYNC_PRIVACY_RAW_ID_TOKENS[4]}.`,
    },
    lifecycle: {
      note: "Retry guidance available.",
      ui_visible: true,
    },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /raw identifier token/);
  assert.match(result.errors.join(" "), /hash-like token/);
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
      total_received_bytes: 8_000_000,
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
      total_received_bytes: 8_000_000,
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
