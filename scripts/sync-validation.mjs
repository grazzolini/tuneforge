import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SYNC_PRIVACY_SAFE_OPERATIONAL_TOKENS, SYNC_PRIVACY_SAFE_PHASES } from "./sync-privacy-token-cases.mjs";

const SCHEMA_VERSION = "v1";
const TOP_LEVEL_KEYS = [
  "capturedAt",
  "scenario",
  "source",
  "run",
  "transport",
  "metrics",
  "projects",
  "artifacts",
  "lifecycle",
  "storage",
  "validation",
];
const BOTTLENECK_CATEGORIES = new Set([
  "network",
  "staging",
  "reconciliation_apply",
  "lifecycle",
  "ui_visibility",
  "incomplete_evidence",
]);
const REDACTED_ID_PATTERN = /^(run|peer|project|artifact|device|session|listener)-[a-z0-9._-]+$/i;
const ENDPOINT_VALUE_PATTERN = /\b(localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-f0-9:]{2,}:[a-f0-9:]+|[a-z0-9-]+\.(?:local|lan|home|internal|corp|com|net|org))(?:[:/]\d+)?\b/i;
const FILE_NAME_PATTERN = /\b[^/\s]+\.(?:wav|mp3|m4a|flac|aac|ogg|opus|json|sqlite|db|log|txt|csv|zip|png|jpe?g)\b/i;
const PAIRING_KEY_PATTERN = /(pair(ing)?|qr|invite|secret|token|public_?key|private_?key|payload)/i;
const RAW_ID_KEY_PATTERN = /(?:^|[_-])(id|ids|device_id|peer_id|project_id|artifact_id|run_id|session_id|listener_id)$/i;
const RAW_ID_TOKEN_PATTERN =
  /\b(?:device|proj|art|session|run|project|artifact|sync)_[A-Za-z0-9][A-Za-z0-9._:-]*\b/i;
const SAFE_OPERATIONAL_TOKEN_SET = new Set(SYNC_PRIVACY_SAFE_OPERATIONAL_TOKENS.map((token) => token.toLowerCase()));
const SAFE_PHASE_SET = new Set(SYNC_PRIVACY_SAFE_PHASES);
const LEGACY_PHASE_ALIASES = new Map([["network_receive", "artifact_transfer"],
  ["staging_post", "artifact_staging"], ["staging_apply_plan", "reconciliation_staging"],
  ["backend_staging", "artifact_staging"]]);
const ROLE_NETWORK_REQUIREMENTS = {
  receiver_or_import: [["networkReceiveThroughputBytesPerSecond", "totalReceivedBytes", "receive"]],
  sender_only: [["networkSendThroughputBytesPerSecond", "totalServedBytes", "send"]],
  bidirectional: [["networkReceiveThroughputBytesPerSecond", "totalReceivedBytes", "receive"],
    ["networkSendThroughputBytesPerSecond", "totalServedBytes", "send"]],
  no_op: [],
  unknown: [],
};
const HASH_TOKEN_PATTERN =
  /(?<![A-Za-z0-9])(?:sha(?:-?256)?|hash|checksum)[_:.-][A-Za-z0-9][A-Za-z0-9._:-]*\b|(?<![A-Za-z0-9])[a-f0-9]{32,}(?![A-Za-z0-9])/i;
const SUSPICIOUS_CONTENT_KEY_PATTERN = /(audio|file|bytes|blob|content|payload|waveform|sample)/i;
const PATH_FILE_EXTENSION_PATTERN = "wav|mp3|m4a|flac|aac|ogg|opus|json|sqlite|db|log|txt|csv|zip|png|jpe?g";
const ABSOLUTE_PATH_VALUE_PATTERN = new RegExp(
  `(?:^|[\\s"'(])(?:file:\\/\\/(?:localhost)?(?:[A-Za-z]:[\\\\/]|\\/)?|[A-Za-z]:[\\\\/]|\\/)[^\\r\\n"'<>]*(?:\\.(?:${PATH_FILE_EXTENSION_PATTERN})\\b|[\\\\/][^\\s"'<>),;]+)`,
  "i",
);
const PHASE_CATEGORY_PATTERNS = [
  { category: "staging", pattern: /(staging|stage|temp|hash|write)/i },
  { category: "lifecycle", pattern: /(pause|resume|restart|listener|lifecycle|start|stop)/i },
  { category: "ui_visibility", pattern: /(visible|visibility|ui|hydrate|render)/i },
  { category: "network", pattern: /(network|transport|transfer|receive|recv|send|serve|read|download|upload)/i },
];
const MANIFEST_EXPORT_ERROR_STATUS = "manifest_export_error";
const TRANSFER_COUNT_KEYS = new Set([
  "requested",
  "requested_artifacts",
  "received",
  "completed",
  "skipped",
  "already_local",
  "alreadyLocal",
  "already_staged",
  "alreadyStaged",
  "failed",
  "retried",
  "retries",
]);
const LOCAL_PROJECT_MUTATION_STATUSES = new Set(["imported", "applied", "deleted"]);
const PROJECT_MUTATION_COUNT_ALIASES = {
  imported: [["imported"], ["importedProjectCount"], ["imported_project_count"]],
  applied: [["applied"], ["appliedProjectCount"], ["applied_project_count"]],
  deleted: [["deleted"], ["deletedProjectCount"], ["deleted_project_count"]],
};
const PROJECT_COUNT_ALIASES = {
  imported: [["importedProjectCount"], ["imported_project_count"]],
  applied: [["appliedProjectCount"], ["applied_project_count"]],
  deleted: [["deletedProjectCount"], ["deleted_project_count"]],
  skipped: [["skippedProjectCount"], ["skipped_project_count"]],
  conflicted: [["conflictedProjectCount"], ["conflicted_project_count"]],
  failed: [["failedProjectCount"], ["failed_project_count"]],
  total: [["totalProjectCount"], ["total_project_count"]],
  manifestExportErrors: [["manifestErrorCount"], ["manifest_error_count"], ["manifestExportErrorCount"], ["manifest_export_error_count"]],
};

function usage() {
  return [
    "Usage:",
    "  pnpm sync:validate -- validate --input <file> [--scenario <name>]",
    "  pnpm sync:validate -- summarize --input <file>",
    "  pnpm sync:validate -- compare --candidate <file> --control <file>",
    "  pnpm sync:validate -- storage-peaks --transport-root <path> --staging-root <path> [--samples <count>] [--interval-ms <ms>]",
  ].join("\n");
}

function parseArgs(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [subcommand, ...rest] = normalizedArgv;
  if (!subcommand) {
    throw new Error(usage());
  }
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }
  return { subcommand, options };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeJsonParse(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getNestedValue(value, keyPath) {
  let current = value;
  for (const key of keyPath) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function findAliasValue(scope, aliasPaths) {
  for (const aliasPath of aliasPaths) {
    const keyPath = Array.isArray(aliasPath) ? aliasPath : [aliasPath];
    const resolved = getNestedValue(scope, keyPath);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findFirstNonNegativeInteger(scope, aliasPaths) {
  const value = findAliasValue(scope, aliasPaths);
  return asNonNegativeInteger(value);
}

function maxNonNull(values) {
  const presentValues = values.filter((value) => value !== null && value !== undefined);
  return presentValues.length > 0 ? Math.max(...presentValues) : null;
}

function readProjectMutationStatusCount(scope, status) {
  return isPlainObject(scope)
    ? findFirstNonNegativeInteger(scope, PROJECT_MUTATION_COUNT_ALIASES[status])
    : null;
}

function readAggregateProjectMutationCount(scope) {
  if (!isPlainObject(scope)) {
    return null;
  }
  const mutationCounts = [...LOCAL_PROJECT_MUTATION_STATUSES].map(
    (status) => readProjectMutationStatusCount(scope, status),
  );
  const presentCounts = mutationCounts.filter((count) => count !== null);
  return presentCounts.length > 0
    ? presentCounts.reduce((total, count) => total + count, 0)
    : null;
}

function inferLocalProjectMutationCount(projects) {
  if (Array.isArray(projects)) {
    return projects.filter(
      (entry) => isPlainObject(entry) && entry.isFinal !== false && entry.is_final !== false &&
        LOCAL_PROJECT_MUTATION_STATUSES.has(entry.status),
    ).length;
  }
  if (isPlainObject(projects)) {
    return readAggregateProjectMutationCount(projects);
  }
  return null;
}

function normalizeTransferCountCandidate(value) {
  const candidate = isPlainObject(value?.counts) ? value.counts : value;
  return isPlainObject(candidate) ? candidate : null;
}

function hasTransferCountKey(candidate) {
  return Object.keys(candidate).some((key) => TRANSFER_COUNT_KEYS.has(key));
}

function collectTransferCountCandidates(...values) {
  return values
    .map((value) => normalizeTransferCountCandidate(value))
    .filter((candidate) => candidate !== null && hasTransferCountKey(candidate));
}

function findTransferCountValue(candidates, aliases) {
  for (const candidate of candidates) {
    for (const alias of aliases) {
      if (alias in candidate) {
        return candidate[alias];
      }
    }
  }
  return undefined;
}

function asPositiveIntegerOption(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function asNonNegativeIntegerOption(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function isIsoTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function timestampMs(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
}

function durationMsFromEvidenceRun(run) {
  if (!isPlainObject(run)) {
    return null;
  }
  const durationMs = asFiniteNumber(findAliasValue(run, [
    ["durationMs"],
    ["duration_ms"],
    ["elapsedMs"],
    ["elapsed_ms"],
  ]));
  if (durationMs !== null) {
    return durationMs;
  }
  const durationSeconds = asFiniteNumber(findAliasValue(run, [
    ["durationSeconds"],
    ["duration_seconds"],
    ["elapsedSeconds"],
    ["elapsed_seconds"],
  ]));
  if (durationSeconds !== null) {
    return durationSeconds * 1000;
  }
  const startedAt = timestampMs(run.startedAt ?? run.started_at);
  const completedAt = timestampMs(run.completedAt ?? run.completed_at ?? run.finishedAt ?? run.finished_at);
  return startedAt !== null && completedAt !== null && completedAt >= startedAt
    ? completedAt - startedAt
    : null;
}

function countFinalProjectsByStatus(projects) {
  if (!Array.isArray(projects)) {
    return {};
  }
  return projects.reduce((counts, project) => {
    if (
      isPlainObject(project) &&
      typeof project.status === "string" &&
      project.status &&
      project.isFinal !== false &&
      project.is_final !== false &&
      project.status !== MANIFEST_EXPORT_ERROR_STATUS
    ) {
      counts[project.status] = (counts[project.status] ?? 0) + 1;
    }
    return counts;
  }, {});
}

function hasProjectResultsByStatusMetrics(metrics) {
  return isPlainObject(metrics.projectResultsByStatus) || isPlainObject(metrics.project_results_by_status);
}

function projectResultsByStatusFromMetrics(metrics) {
  const counts = {};
  for (const scope of [metrics.projectResultsByStatus, metrics.project_results_by_status]) {
    if (!isPlainObject(scope)) {
      continue;
    }
    for (const [status, count] of Object.entries(scope)) {
      const normalizedCount = asNonNegativeInteger(count);
      if (normalizedCount !== null) {
        counts[status] = normalizedCount;
      }
    }
  }
  return counts;
}

function authoritativeProjectResultsByStatus(evidence) {
  const metrics = isPlainObject(evidence.metrics) ? evidence.metrics : {};
  const projectResultsByStatus = countFinalProjectsByStatus(evidence.projects);
  if (Object.keys(projectResultsByStatus).length > 0) {
    return {
      projectResultsByStatus,
      hasAuthoritativeProjectStatusMap: true,
    };
  }
  const metricProjectResultsByStatus = projectResultsByStatusFromMetrics(metrics);
  if (hasProjectResultsByStatusMetrics(metrics)) {
    return {
      projectResultsByStatus: metricProjectResultsByStatus,
      hasAuthoritativeProjectStatusMap: true,
    };
  }
  return {
    projectResultsByStatus,
    hasAuthoritativeProjectStatusMap: false,
  };
}

function sumTrueProjectResultCounts(projectResultsByStatus) {
  return Object.entries(projectResultsByStatus).reduce((total, [status, count]) => (
    status === MANIFEST_EXPORT_ERROR_STATUS ? total : total + count
  ), 0);
}

function projectCountFieldValue(metrics, status) {
  return maxNonNull(projectCountCandidateValues(metrics, status).map(({ value }) => value));
}

function readProjectCountFromMetrics(metrics, status, projectResultsByStatus, hasAuthoritativeStatusMap) {
  if (status === "manifestExportErrors") {
    return projectCountFieldValue(metrics, status);
  }
  if (hasAuthoritativeStatusMap) {
    if (status === "total") {
      return sumTrueProjectResultCounts(projectResultsByStatus);
    }
    return projectResultsByStatus[status] ?? 0;
  }
  return projectCountFieldValue(metrics, status);
}

function collectPhaseTimings(evidence) {
  const phaseSets = [
    evidence?.run?.phaseTimings,
    evidence?.run?.phase_timings,
    evidence?.transport?.phaseTimings,
    evidence?.transport?.phase_timings,
    evidence?.lifecycle?.phaseTimings,
    evidence?.lifecycle?.phase_timings,
  ];
  const collected = [];
  for (const phaseSet of phaseSets) {
    if (!Array.isArray(phaseSet)) {
      continue;
    }
    for (const entry of phaseSet) {
      if (!isPlainObject(entry)) {
        continue;
      }
      const phase = asString(entry.phase ?? entry.name ?? entry.label);
      const durationMs = asFiniteNumber(entry.durationMs ?? entry.duration_ms ?? entry.totalMs ?? entry.total_ms);
      if (phase && durationMs !== null) {
        collected.push({ phase: LEGACY_PHASE_ALIASES.get(phase) ?? phase, durationMs });
      }
    }
  }
  return collected;
}

function canonicalizeEvidence(evidence) {
  const run = isPlainObject(evidence.run) ? evidence.run : {};
  const metrics = isPlainObject(evidence.metrics) ? evidence.metrics : {};
  const transport = isPlainObject(evidence.transport) ? evidence.transport : {};
  const lifecycle = isPlainObject(evidence.lifecycle) ? evidence.lifecycle : {};
  const storage = isPlainObject(evidence.storage) ? evidence.storage : {};
  const validation = isPlainObject(evidence.validation) ? evidence.validation : {};
  const { projectResultsByStatus, hasAuthoritativeProjectStatusMap } =
    authoritativeProjectResultsByStatus(evidence);

  const transferCountCandidates = collectTransferCountCandidates(
    metrics.transfer_counts,
    metrics.transferCounts,
    metrics.artifact_transfer_counts,
    evidence.artifacts?.transfer_counts,
    evidence.artifacts?.transferCounts,
  );

  const requested = asNonNegativeInteger(findTransferCountValue(
    transferCountCandidates,
    ["requested", "requested_artifacts"],
  ));
  const received = asNonNegativeInteger(findTransferCountValue(
    transferCountCandidates,
    ["received", "completed"],
  ));
  const skipped = asNonNegativeInteger(findTransferCountValue(
    transferCountCandidates,
    ["skipped", "already_local", "alreadyLocal"],
  ));
  const alreadyStaged = asNonNegativeInteger(findTransferCountValue(
    transferCountCandidates,
    ["already_staged", "alreadyStaged"],
  ));
  const failed = asNonNegativeInteger(findTransferCountValue(transferCountCandidates, ["failed"]));
  const retried = asNonNegativeInteger(findTransferCountValue(
    transferCountCandidates,
    ["retried", "retries"],
  ));

  const selectedTransport = asString(
    transport.selected ?? transport.selected_transport ?? evidence.source,
  );
  const candidateTransports = Array.isArray(transport.candidates ?? transport.candidate_transports)
    ? (transport.candidates ?? transport.candidate_transports).filter((entry) => typeof entry === "string")
    : [];
  const bottleneckHint = asString(validation.bottleneck ?? validation.bottleneck_category);
  const servedArtifactRequests = asNonNegativeInteger(findAliasValue(metrics, [
    ["transferCounts", "servedArtifactRequests"],
    ["transferCounts", "served_artifact_requests"],
    ["transfer_counts", "servedArtifactRequests"],
    ["transfer_counts", "served_artifact_requests"],
    ["servedArtifactRequests"],
    ["served_artifact_requests"],
  ]));
  const reportedServedBytes = asFiniteNumber(findAliasValue(metrics, [
    ["diagnostics", "total_served_bytes"], ["diagnostics", "totalServedBytes"],
    ["total_served_bytes"], ["totalServedBytes"], ["served_bytes"], ["servedBytes"],
  ]));
  const reportedReceivedBytes = asFiniteNumber(findAliasValue(metrics, [
    ["diagnostics", "total_received_bytes"], ["diagnostics", "totalReceivedBytes"],
    ["total_received_bytes"], ["totalReceivedBytes"], ["received_bytes"], ["receivedBytes"],
  ]));
  const projectMutationMetricScopes = [
    metrics.transferCounts,
    metrics.transfer_counts,
    metrics.diagnostics,
    metrics,
  ];
  const importedProjectCount = maxNonNull(
    projectMutationMetricScopes.map((scope) => readProjectMutationStatusCount(scope, "imported")),
  );
  const aggregateProjectMutationCount = maxNonNull(
    projectMutationMetricScopes.map((scope) => readAggregateProjectMutationCount(scope)),
  );
  const localProjectMutationCount = maxNonNull([
    inferLocalProjectMutationCount(evidence.projects),
    aggregateProjectMutationCount,
  ]);
  const projectCounts = {
    imported: readProjectCountFromMetrics(metrics, "imported", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    applied: readProjectCountFromMetrics(metrics, "applied", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    deleted: readProjectCountFromMetrics(metrics, "deleted", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    skipped: readProjectCountFromMetrics(metrics, "skipped", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    conflicted: readProjectCountFromMetrics(metrics, "conflicted", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    failed: readProjectCountFromMetrics(metrics, "failed", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    total: readProjectCountFromMetrics(metrics, "total", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
    manifestExportErrors: readProjectCountFromMetrics(metrics, "manifestExportErrors", projectResultsByStatus, hasAuthoritativeProjectStatusMap),
  };
  const receivedArtifactRows = Array.isArray(evidence.artifacts) ? evidence.artifacts
    .filter((artifact) => isPlainObject(artifact) && artifact.status === "received") : [];
  const receivedArtifactSizes = receivedArtifactRows
    .map((artifact) => asFiniteNumber(artifact.sizeBytes ?? artifact.size_bytes));
  const receivedArtifactsComplete = run.received_artifacts_complete === true ||
    metrics.received_artifacts_complete === true;
  const receivedArtifactCountMismatch = receivedArtifactsComplete && received !== null &&
    receivedArtifactRows.length !== received;
  const artifactRowsComplete = received !== null ? receivedArtifactRows.length === received
    : receivedArtifactsComplete;
  const artifactReceivedBytes = artifactRowsComplete && receivedArtifactSizes.every((size) => size !== null)
    ? receivedArtifactSizes.reduce((total, size) => total + size, 0) : null;
  const totalReceivedBytes = reportedReceivedBytes ?? artifactReceivedBytes ?? (received === 0 ? 0 : null);
  const totalServedBytes = reportedServedBytes ?? (servedArtifactRequests === 0 ? 0 : null);
  const receiverCounts = [requested, received, skipped, alreadyStaged, failed, retried];
  const receiverActive = receiverCounts.some((count) => (count ?? 0) > 0) ||
    (localProjectMutationCount ?? 0) > 0 || (totalReceivedBytes ?? 0) > 0;
  const senderActive = (servedArtifactRequests ?? 0) > 0 || (totalServedBytes ?? 0) > 0;
  const noOp = receiverCounts.every((count) => count === 0) && localProjectMutationCount === 0 &&
    servedArtifactRequests === 0 && totalReceivedBytes === 0 && totalServedBytes === 0;
  const runRole = receiverActive && senderActive ? "bidirectional" : senderActive ? "sender_only"
    : receiverActive ? "receiver_or_import" : noOp ? "no_op" : "unknown";
  const aggregateNetworkThroughput = asFiniteNumber(findAliasValue(metrics,
    [["throughput_bytes_per_second"], ["throughputBytesPerSecond"]]));
  const reportedReceiveThroughput = asFiniteNumber(findAliasValue(metrics, [
    ["network_receive_throughput_bytes_per_second"], ["receive_throughput_bytes_per_second"],
    ["transport_receive_throughput_bytes_per_second"],
  ]));
  const reportedSendThroughput = asFiniteNumber(findAliasValue(metrics, [
    ["network_send_throughput_bytes_per_second"], ["send_throughput_bytes_per_second"],
    ["transport_send_throughput_bytes_per_second"],
  ]));
  const runDurationMs = durationMsFromEvidenceRun(run);
  const deriveRate = (bytes) => bytes !== null && runDurationMs !== null && runDurationMs > 0
    ? bytes / (runDurationMs / 1000) : null;
  const legacyBidirectionalAggregate = runRole === "bidirectional" && reportedSendThroughput === null &&
    reportedReceiveThroughput === aggregateNetworkThroughput;
  const oneWayAggregate = (runRole === "receiver_or_import" && totalServedBytes === 0) ||
    (runRole === "sender_only" && totalReceivedBytes === 0)
    ? aggregateNetworkThroughput : null;
  const networkReceiveThroughput = receiverActive ? legacyBidirectionalAggregate
    ? deriveRate(totalReceivedBytes)
    : reportedReceiveThroughput ?? oneWayAggregate ?? deriveRate(totalReceivedBytes) : null;
  const networkSendThroughput = senderActive
    ? reportedSendThroughput ?? (runRole === "sender_only" ? reportedReceiveThroughput : null) ??
      oneWayAggregate ?? deriveRate(totalServedBytes)
    : null;
  const combinedNetworkBytes = totalReceivedBytes !== null && totalServedBytes !== null
    ? totalReceivedBytes + totalServedBytes : null;

  return {
    runRole,
    runDurationMs,
    selectedTransport,
    candidateTransports,
    networkReceiveThroughputBytesPerSecond: networkReceiveThroughput,
    networkSendThroughputBytesPerSecond: networkSendThroughput,
    aggregateNetworkThroughputBytesPerSecond: aggregateNetworkThroughput,
    combinedNetworkBytes,
    backendStagingThroughputBytesPerSecond: asFiniteNumber(findAliasValue(metrics, [
      ["backend_staging_throughput_bytes_per_second"],
      ["staging_throughput_bytes_per_second"],
    ])),
    reconciliationApplyMs: asFiniteNumber(findAliasValue(metrics, [
      ["reconciliation_apply_ms"],
      ["apply_ms"],
      ["reconciliation", "apply_ms"],
    ])),
    reconciliationApplyAggregateMs: asFiniteNumber(findAliasValue(metrics, [
      ["reconciliation_apply_aggregate_ms"],
      ["apply_aggregate_ms"],
      ["reconciliation", "apply_aggregate_ms"],
    ])),
    reconciliationApplyTimingSemantics: asString(findAliasValue(metrics, [
      ["reconciliation_apply_timing", "semantics"],
      ["reconciliationApplyTiming", "semantics"],
    ])),
    projectImportsPerMinute: asFiniteNumber(findAliasValue(metrics, [
      ["project_imports_per_minute"],
      ["projects_per_minute"],
    ])),
    projectMutationsPerMinute: asFiniteNumber(findAliasValue(metrics, [
      ["project_mutations_per_minute"],
      ["project_mutation_cadence_per_minute"],
    ])),
    projectAvailabilityGapMs: asFiniteNumber(findAliasValue(metrics, [
      ["project_availability_gap_ms"],
      ["project_availability_gap_ms_avg"],
      ["project_availability_gap_ms_p50"],
    ])),
    ttfaMs: asFiniteNumber(findAliasValue(metrics, [
      ["ttfa_ms"],
      ["time_to_first_artifact_ms"],
    ])),
    transferCounts: {
      requested,
      received,
      skipped,
      alreadyStaged,
      failed,
      retried,
    },
    projectResultsByStatus,
    projectCounts,
    servedArtifactRequests,
    totalReceivedBytes,
    totalServedBytes,
    receivedArtifactCountMismatch,
    importedProjectCount,
    localProjectMutationCount,
    fallbackReason: asString(
      lifecycle.fallbackReason ??
      lifecycle.fallback_reason ??
      transport.fallbackReason ??
      transport.fallback_reason ??
      transport.fallback?.reason,
    ),
    fallbackCode: asString(
      lifecycle.fallbackCode ??
      lifecycle.fallback_code ??
      transport.fallbackCode ??
      transport.fallback_code ??
      transport.fallback?.code,
    ),
    scratchPeakBytes: asFiniteNumber(findAliasValue(storage, [
      ["scratch_peak_bytes"],
      ["scratch_bytes_peak"],
      ["scratch", "peakBytes"],
      ["scratch", "peak_bytes"],
    ])),
    stagingPeakBytes: asFiniteNumber(findAliasValue(storage, [
      ["staging_peak_bytes"],
      ["staging_bytes_peak"],
      ["staging", "peakBytes"],
      ["staging", "peak_bytes"],
    ])),
    phaseTimings: collectPhaseTimings(evidence),
    uiVisible: validation.ui_visible === false || lifecycle.ui_visible === false
      ? false
      : validation.ui_visible === true || lifecycle.ui_visible === true
        ? true
        : null,
    validationScope: asString(validation.scope),
    runOutcomeOk: validation.outcomeOk === false || validation.outcome_ok === false
      ? false
      : validation.outcomeOk === true || validation.outcome_ok === true
        ? true
        : validation.ok === false || validation.valid === false
          ? false
          : validation.ok === true || validation.valid === true
            ? true
            : null,
    bottleneckHint,
  };
}

function validateTopLevel(evidence, errors) {
  if (!isPlainObject(evidence)) {
    errors.push("Evidence must be a JSON object.");
    return;
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in evidence)) {
      errors.push(`Missing top-level key: ${key}`);
    }
  }
  const capturedAt = evidence.capturedAt;
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) {
    errors.push("capturedAt must be an ISO-8601 timestamp string.");
  }
}

function validateRequiredMetrics(evidence, errors) {
  const normalized = canonicalizeEvidence(evidence);
  const hasExplicitAggregateOnlyApplyTiming =
    normalized.reconciliationApplyMs === null &&
    normalized.reconciliationApplyAggregateMs !== null &&
    normalized.reconciliationApplyTimingSemantics === "aggregate_only";
  const aggregateFallback = normalized.runRole === "bidirectional" &&
    normalized.aggregateNetworkThroughputBytesPerSecond !== null;
  for (const [rateField, bytesField, direction] of ROLE_NETWORK_REQUIREMENTS[normalized.runRole]) {
    if (normalized[bytesField] !== null && normalized[rateField] === null && !aggregateFallback) {
      errors.push(`Missing required metric: network ${direction} throughput.`);
    }
  }
  if (normalized.totalReceivedBytes > 0 && normalized.backendStagingThroughputBytesPerSecond === null) {
    errors.push("Missing required metric: backend staging throughput.");
  }
  if (
    ["receiver_or_import", "bidirectional"].includes(normalized.runRole) &&
    normalized.reconciliationApplyMs === null &&
    !hasExplicitAggregateOnlyApplyTiming
  ) {
    errors.push("Missing required metric: reconciliation apply time.");
  }
  if (normalized.importedProjectCount > 0 && normalized.projectImportsPerMinute === null) {
    errors.push("Missing required metric: project import cadence (projects per minute).");
  }
  if (normalized.importedProjectCount > 0 && normalized.projectAvailabilityGapMs === null) {
    errors.push("Missing required metric: project import cadence gap.");
  }
  if ((normalized.totalReceivedBytes ?? 0) + (normalized.totalServedBytes ?? 0) > 0 && normalized.ttfaMs === null) {
    errors.push("Missing required metric: TTFA.");
  }
  for (const [key, value] of Object.entries(normalized.transferCounts)) {
    if (value === null) {
      errors.push(`Missing required transfer count: ${key}`);
    }
  }
  if (!normalized.selectedTransport) {
    errors.push("Missing required transport choice.");
  }
}

function validateTimingConsistency(evidence, errors) {
  const normalized = canonicalizeEvidence(evidence);
  for (const [field, value] of [
    ["run duration", normalized.runDurationMs],
    ["reconciliation_apply_ms", normalized.reconciliationApplyMs],
    ["reconciliation_apply_aggregate_ms", normalized.reconciliationApplyAggregateMs],
    ["project_availability_gap_ms", normalized.projectAvailabilityGapMs],
    ["ttfa_ms", normalized.ttfaMs],
    ["network receive throughput", normalized.networkReceiveThroughputBytesPerSecond],
    ["network send throughput", normalized.networkSendThroughputBytesPerSecond],
    ["aggregate network throughput", normalized.aggregateNetworkThroughputBytesPerSecond],
  ]) {
    if (value !== null && value < 0) {
      errors.push(`${field} must be non-negative.`);
    }
  }
  if (collectPhaseTimings(evidence).some(({ durationMs }) => durationMs < 0)) {
    errors.push("Phase timing durations must be non-negative.");
  }
  for (const [field, value] of [["received", normalized.totalReceivedBytes],
    ["served", normalized.totalServedBytes], ["combined", normalized.combinedNetworkBytes]]) {
    if (value !== null && value < 0) errors.push(`${field} byte total must be non-negative.`);
  }
  if (normalized.receivedArtifactCountMismatch) {
    errors.push("Complete received artifact rows disagree with authoritative received count.");
  }
  if (
    normalized.reconciliationApplyTimingSemantics === "aggregate_only" &&
    normalized.reconciliationApplyMs !== null
  ) {
    errors.push("aggregate_only semantics require reconciliation_apply_ms to be null.");
  }
  if (
    normalized.reconciliationApplyMs !== null &&
    normalized.reconciliationApplyAggregateMs !== null &&
    normalized.reconciliationApplyAggregateMs < normalized.reconciliationApplyMs
  ) {
    errors.push("reconciliation_apply_aggregate_ms must be at least reconciliation_apply_ms.");
  }
  if (
    normalized.reconciliationApplyMs !== null &&
    normalized.runDurationMs !== null &&
    normalized.reconciliationApplyMs > normalized.runDurationMs
  ) {
    errors.push("reconciliation_apply_ms exceeds run wall-clock duration.");
  }
  for (const [rate, bytes, direction] of [
    [normalized.networkReceiveThroughputBytesPerSecond, normalized.totalReceivedBytes, "network receive"],
    [normalized.networkSendThroughputBytesPerSecond, normalized.totalServedBytes, "network send"],
    [normalized.aggregateNetworkThroughputBytesPerSecond, normalized.combinedNetworkBytes, "aggregate network"],
  ]) {
    if (rate > 0 && !(bytes > 0)) errors.push(`Positive ${direction} throughput requires positive ${direction === "network receive" ? "received" : direction === "network send" ? "served" : "combined"} bytes.`);
  }
}

function projectCountCandidateValues(metrics, status) {
  const aliases = PROJECT_COUNT_ALIASES[status];
  if (!aliases) {
    return [];
  }
  const scopes = [
    ["transferCounts", metrics.transferCounts],
    ["transfer_counts", metrics.transfer_counts],
    ["metrics", metrics],
  ];
  return scopes.flatMap(([scopeName, scope]) => {
    if (!isPlainObject(scope)) {
      return [];
    }
    return aliases.flatMap((alias) => {
      const value = asNonNegativeInteger(getNestedValue(scope, alias));
      return value === null ? [] : [{ fieldName: `${scopeName}.${alias.join(".")}`, value }];
    });
  });
}

function validateProjectCountConsistency(evidence, errors) {
  const metrics = isPlainObject(evidence.metrics) ? evidence.metrics : {};
  const concreteProjectResultsByStatus = countFinalProjectsByStatus(evidence.projects);
  const metricProjectResultsByStatus = projectResultsByStatusFromMetrics(metrics);
  if (Object.keys(concreteProjectResultsByStatus).length > 0 && hasProjectResultsByStatusMetrics(metrics)) {
    const statuses = new Set([
      ...Object.keys(concreteProjectResultsByStatus),
      ...Object.keys(metricProjectResultsByStatus),
    ]);
    for (const status of statuses) {
      if ((metricProjectResultsByStatus[status] ?? 0) !== (concreteProjectResultsByStatus[status] ?? 0)) {
        errors.push(`metrics.projectResultsByStatus.${status} disagrees with projects.${status}.`);
      }
    }
  }
  const { projectResultsByStatus, hasAuthoritativeProjectStatusMap } =
    authoritativeProjectResultsByStatus(evidence);
  const statuses = ["imported", "applied", "deleted", "skipped", "conflicted", "failed"];
  for (const status of [...statuses, "total", "manifestExportErrors"]) {
    const candidates = projectCountCandidateValues(metrics, status);
    if (new Set(candidates.map(({ value }) => value)).size > 1) {
      errors.push(`${status} project count fields disagree.`);
    }
  }
  if (!hasAuthoritativeProjectStatusMap) {
    return;
  }
  for (const status of statuses) {
    const expected = projectResultsByStatus[status] ?? 0;
    for (const { fieldName, value } of projectCountCandidateValues(metrics, status)) {
      if (value !== expected) {
        errors.push(`${fieldName} disagrees with projectResultsByStatus.${status}.`);
      }
    }
  }
  const totalExpected = sumTrueProjectResultCounts(projectResultsByStatus);
  for (const { fieldName, value } of projectCountCandidateValues(metrics, "total")) {
    if (value !== totalExpected) {
      errors.push(`${fieldName} disagrees with projectResultsByStatus total.`);
    }
  }
}

function validateScenario(evidence, expectedScenario, errors) {
  if (!expectedScenario) {
    return;
  }
  if (evidence.scenario !== expectedScenario) {
    errors.push(`Scenario mismatch: expected ${expectedScenario}, got ${String(evidence.scenario)}`);
  }
}

function hasUnsafeOperationalToken(value, pattern) {
  return (value.match(new RegExp(pattern.source, "gi")) ?? [])
    .some((token) => !SAFE_OPERATIONAL_TOKEN_SET.has(token.toLowerCase()));
}

function inspectPrivacy(value, trail, errors) {
  const key = trail[trail.length - 1] ?? "";
  if (PAIRING_KEY_PATTERN.test(key)) {
    errors.push(`Privacy guard: disallowed key ${trail.join(".")}`);
  }
  if (RAW_ID_KEY_PATTERN.test(key)) {
    if (typeof value === "string" && !REDACTED_ID_PATTERN.test(value)) {
      errors.push(`Privacy guard: raw identifier at ${trail.join(".")}`);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && !REDACTED_ID_PATTERN.test(entry)) {
          errors.push(`Privacy guard: raw identifier at ${trail.join(".")}`);
          break;
        }
      }
    }
  }
  if (typeof value === "string") {
    const phase = LEGACY_PHASE_ALIASES.get(value) ?? value;
    if (/(?:^|[_-])phase$|Phase$/.test(key) && phase !== "phase_redacted" && !SAFE_PHASE_SET.has(phase)) {
      errors.push(`Privacy guard: unknown phase at ${trail.join(".")}`);
    }
    if (ABSOLUTE_PATH_VALUE_PATTERN.test(value)) {
      errors.push(`Privacy guard: absolute path at ${trail.join(".")}`);
    }
    if (!isIsoTimestamp(value) && (ENDPOINT_VALUE_PATTERN.test(value) || /^https?:\/\//i.test(value))) {
      errors.push(`Privacy guard: endpoint hint at ${trail.join(".")}`);
    }
    if (FILE_NAME_PATTERN.test(value)) {
      errors.push(`Privacy guard: filename-like value at ${trail.join(".")}`);
    }
    if (hasUnsafeOperationalToken(value, RAW_ID_TOKEN_PATTERN)) {
      errors.push(`Privacy guard: raw identifier token at ${trail.join(".")}`);
    }
    if (hasUnsafeOperationalToken(value, HASH_TOKEN_PATTERN)) {
      errors.push(`Privacy guard: hash-like token at ${trail.join(".")}`);
    }
    if (
      (SUSPICIOUS_CONTENT_KEY_PATTERN.test(key) || /^data:/i.test(value)) &&
      value.length > 96
    ) {
      errors.push(`Privacy guard: suspicious payload content at ${trail.join(".")}`);
    }
    if (/^[A-Za-z0-9+/=]{192,}$/.test(value)) {
      errors.push(`Privacy guard: opaque payload at ${trail.join(".")}`);
    }
  }
  if (Array.isArray(value)) {
    if (SUSPICIOUS_CONTENT_KEY_PATTERN.test(key) && value.length > 32 && value.every((entry) => Number.isInteger(entry))) {
      errors.push(`Privacy guard: byte payload at ${trail.join(".")}`);
    }
    value.forEach((entry, index) => inspectPrivacy(entry, trail.concat(String(index)), errors));
    return;
  }
  if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      inspectPrivacy(childValue, trail.concat(childKey), errors);
    }
  }
}

export function validateEvidence(evidence, { scenario } = {}) {
  const errors = [];
  validateTopLevel(evidence, errors);
  if (isPlainObject(evidence)) {
    validateRequiredMetrics(evidence, errors);
    validateTimingConsistency(evidence, errors);
    validateProjectCountConsistency(evidence, errors);
    validateScenario(evidence, scenario, errors);
    inspectPrivacy(evidence, [], errors);
  }
  return {
    ok: errors.length === 0,
    schemaPrivacyOk: errors.length === 0,
    schemaVersion: SCHEMA_VERSION,
    errors,
    normalized: isPlainObject(evidence) ? canonicalizeEvidence(evidence) : null,
  };
}

function normalizedPhaseName(phase) {
  return phase.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isReconciliationApplyPhase(phase) {
  const normalized = normalizedPhaseName(phase);
  if (!normalized || /(^|_)(plan|planning|stage|staging)($|_)/.test(normalized)) {
    return false;
  }
  return normalized === "apply" ||
    normalized === "reconciliation_apply" ||
    normalized.startsWith("apply_") ||
    normalized.startsWith("reconciliation_apply_") ||
    normalized.endsWith("_apply");
}

function phaseCategory(phase) {
  if (isReconciliationApplyPhase(phase)) {
    return "reconciliation_apply";
  }
  return PHASE_CATEGORY_PATTERNS.find((item) => item.pattern.test(phase))?.category ?? null;
}

function phaseCategoryScore(phaseTimings) {
  const scores = new Map();
  for (const entry of phaseTimings) {
    const category = phaseCategory(entry.phase);
    if (!category) {
      continue;
    }
    scores.set(category, (scores.get(category) ?? 0) + entry.durationMs);
  }
  return Array.from(scores.entries()).sort((left, right) => right[1] - left[1])[0] ?? null;
}

export function summarizeEvidence(evidence) {
  const validation = validateEvidence(evidence);
  const normalized = validation.normalized;
  let bottleneck = "incomplete_evidence";
  const reasons = [];

  if (!validation.ok || !normalized) {
    reasons.push("validation_failed");
  } else if (normalized.uiVisible === false) {
    bottleneck = "ui_visibility";
    reasons.push("ui_not_visible");
  } else if (normalized.runOutcomeOk === false) {
    bottleneck = "incomplete_evidence";
    reasons.push("run_outcome_failed");
  } else if (normalized.fallbackCode || normalized.fallbackReason) {
    bottleneck = "lifecycle";
    reasons.push("fallback_used");
  } else {
    const phaseWinner = phaseCategoryScore(normalized.phaseTimings);
    if (phaseWinner && BOTTLENECK_CATEGORIES.has(phaseWinner[0])) {
      bottleneck = phaseWinner[0];
      reasons.push(`phase:${phaseWinner[0]}`);
    } else if (
      normalized.reconciliationApplyMs !== null &&
      normalized.ttfaMs !== null &&
      normalized.reconciliationApplyMs >= Math.max(normalized.ttfaMs * 0.6, 1000)
    ) {
      bottleneck = "reconciliation_apply";
      reasons.push("apply_time_dominant");
    } else if (
      normalized.networkReceiveThroughputBytesPerSecond !== null &&
      normalized.backendStagingThroughputBytesPerSecond !== null &&
      normalized.backendStagingThroughputBytesPerSecond < normalized.networkReceiveThroughputBytesPerSecond * 0.75
    ) {
      bottleneck = "staging";
      reasons.push("staging_slower_than_network");
    } else if (
      normalized.networkReceiveThroughputBytesPerSecond !== null &&
      normalized.backendStagingThroughputBytesPerSecond !== null &&
      normalized.networkReceiveThroughputBytesPerSecond <= normalized.backendStagingThroughputBytesPerSecond * 0.8
    ) {
      bottleneck = "network";
      reasons.push("network_slower_than_staging");
    } else if (normalized.bottleneckHint && BOTTLENECK_CATEGORIES.has(normalized.bottleneckHint)) {
      bottleneck = normalized.bottleneckHint;
      reasons.push("validation_hint");
    } else {
      reasons.push("no_clear_signal");
    }
  }

  return {
    ok: validation.ok,
    schemaPrivacyOk: validation.schemaPrivacyOk,
    runOutcomeOk: normalized?.runOutcomeOk ?? null,
    schemaVersion: SCHEMA_VERSION,
    scenario: evidence?.scenario ?? null,
    source: evidence?.source ?? null,
    bottleneck,
    reasons,
    metrics: normalized,
    errors: validation.errors,
  };
}

function compareMetric(candidate, control, key, preferredDirection) {
  const candidateValue = candidate?.[key];
  const controlValue = control?.[key];
  if (candidateValue === null || candidateValue === undefined || controlValue === null || controlValue === undefined) {
    return { metric: key, candidate: candidateValue ?? null, control: controlValue ?? null, winner: "unknown" };
  }
  if (candidateValue === controlValue) {
    return { metric: key, candidate: candidateValue, control: controlValue, winner: "tie" };
  }
  const winner = preferredDirection === "higher"
    ? (candidateValue > controlValue ? "candidate" : "control")
    : (candidateValue < controlValue ? "candidate" : "control");
  return { metric: key, candidate: candidateValue, control: controlValue, winner };
}

function networkComparisonValue(metrics) {
  if (!metrics) return null;
  if (metrics.runRole === "receiver_or_import") return metrics.networkReceiveThroughputBytesPerSecond;
  if (metrics.runRole === "sender_only") return metrics.networkSendThroughputBytesPerSecond;
  if (metrics.runRole === "no_op") return 0;
  if (metrics.runRole === "bidirectional") {
    return metrics.aggregateNetworkThroughputBytesPerSecond ?? (
      metrics.networkReceiveThroughputBytesPerSecond !== null &&
      metrics.networkSendThroughputBytesPerSecond !== null
        ? metrics.networkReceiveThroughputBytesPerSecond + metrics.networkSendThroughputBytesPerSecond
        : null
    );
  }
  return metrics.aggregateNetworkThroughputBytesPerSecond;
}

export function compareEvidence(candidateEvidence, controlEvidence) {
  const candidateSummary = summarizeEvidence(candidateEvidence);
  const controlSummary = summarizeEvidence(controlEvidence);
  const networkComparable = candidateSummary.metrics?.runRole === controlSummary.metrics?.runRole;
  const candidateNetwork = networkComparable ? networkComparisonValue(candidateSummary.metrics) : null;
  const controlNetwork = networkComparable ? networkComparisonValue(controlSummary.metrics) : null;
  const comparisons = [
    compareMetric(
      { networkThroughputBytesPerSecond: candidateNetwork },
      { networkThroughputBytesPerSecond: controlNetwork },
      "networkThroughputBytesPerSecond",
      "higher",
    ),
    compareMetric(candidateSummary.metrics, controlSummary.metrics, "backendStagingThroughputBytesPerSecond", "higher"),
    compareMetric(candidateSummary.metrics, controlSummary.metrics, "reconciliationApplyMs", "lower"),
    compareMetric(candidateSummary.metrics, controlSummary.metrics, "projectImportsPerMinute", "higher"),
    compareMetric(candidateSummary.metrics, controlSummary.metrics, "projectAvailabilityGapMs", "lower"),
    compareMetric(candidateSummary.metrics, controlSummary.metrics, "ttfaMs", "lower"),
  ];

  const score = { candidate: 0, control: 0 };
  for (const comparison of comparisons) {
    if (comparison.winner === "candidate") {
      score.candidate += 1;
    } else if (comparison.winner === "control") {
      score.control += 1;
    }
  }

  return {
    ok: candidateSummary.ok && controlSummary.ok,
    schemaVersion: SCHEMA_VERSION,
    candidate: candidateSummary,
    control: controlSummary,
    comparison: {
      metrics: comparisons,
      overall: score.candidate === score.control
        ? "mixed"
        : score.candidate > score.control
          ? "candidate"
          : "control",
      score,
    },
  };
}

function directorySize(rootPath) {
  const stat = lstatSync(rootPath, { throwIfNoEntry: false });
  if (!stat) {
    return 0;
  }
  if (stat.isSymbolicLink()) {
    return 0;
  }
  if (stat.isFile()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return 0;
  }
  let total = 0;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    total += directorySize(path.join(rootPath, entry.name));
  }
  return total;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readStorageSample(transportRoot, stagingRoot) {
  const transportBytes = directorySize(path.resolve(transportRoot));
  const stagingBytes = directorySize(path.resolve(stagingRoot));
  return {
    sampledAt: new Date().toISOString(),
    transportBytes,
    stagingBytes,
    combinedBytes: transportBytes + stagingBytes,
  };
}

export async function sampleStoragePeaks({
  transportRoot,
  stagingRoot,
  samples = 1,
  intervalMs = 1000,
}) {
  if (!transportRoot || !stagingRoot) {
    throw new Error("storage-peaks requires --transport-root and --staging-root");
  }
  const sampleCount = asPositiveIntegerOption(samples, 1, "--samples");
  const sampleIntervalMs = asNonNegativeIntegerOption(intervalMs, 1000, "--interval-ms");
  const observedSamples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    observedSamples.push(readStorageSample(transportRoot, stagingRoot));
    if (index < sampleCount - 1 && sampleIntervalMs > 0) {
      await sleep(sampleIntervalMs);
    }
  }
  const currentSample = observedSamples[observedSamples.length - 1];
  const transportPeakBytes = Math.max(...observedSamples.map((sample) => sample.transportBytes));
  const stagingPeakBytes = Math.max(...observedSamples.map((sample) => sample.stagingBytes));
  const combinedPeakBytes = Math.max(...observedSamples.map((sample) => sample.combinedBytes));
  return {
    capturedAt: currentSample.sampledAt,
    mode: "sampled",
    sampleCount,
    intervalMs: sampleIntervalMs,
    peakSemantics: sampleCount === 1 ? "current_snapshot_not_run_peak" : "max_observed_across_samples",
    samples: observedSamples,
    storage: {
      transport: {
        currentBytes: currentSample.transportBytes,
        peakBytes: transportPeakBytes,
      },
      staging: {
        currentBytes: currentSample.stagingBytes,
        peakBytes: stagingPeakBytes,
      },
      combined: {
        currentBytes: currentSample.combinedBytes,
        peakBytes: combinedPeakBytes,
      },
    },
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { subcommand, options } = parseArgs(argv);
  if (subcommand === "validate") {
    if (!options.input) {
      throw new Error("validate requires --input <file>");
    }
    const result = validateEvidence(safeJsonParse(options.input), { scenario: options.scenario });
    printJson(result);
    if (!result.ok) {
      process.stderr.write(`Validation failed: ${result.errors.join("; ")}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "summarize") {
    if (!options.input) {
      throw new Error("summarize requires --input <file>");
    }
    printJson(summarizeEvidence(safeJsonParse(options.input)));
    return;
  }
  if (subcommand === "compare") {
    if (!options.candidate || !options.control) {
      throw new Error("compare requires --candidate <file> and --control <file>");
    }
    const result = compareEvidence(safeJsonParse(options.candidate), safeJsonParse(options.control));
    printJson(result);
    if (!result.ok) {
      process.stderr.write("Comparison includes invalid evidence.\n");
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "storage-peaks") {
    printJson(await sampleStoragePeaks({
      transportRoot: options["transport-root"],
      stagingRoot: options["staging-root"],
      samples: options.samples,
      intervalMs: options["interval-ms"],
    }));
    return;
  }
  throw new Error(`Unknown subcommand: ${subcommand}\n${usage()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
