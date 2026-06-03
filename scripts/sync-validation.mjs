import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
const SUSPICIOUS_CONTENT_KEY_PATTERN = /(audio|file|bytes|blob|content|payload|waveform|sample)/i;
const PATH_FILE_EXTENSION_PATTERN = "wav|mp3|m4a|flac|aac|ogg|opus|json|sqlite|db|log|txt|csv|zip|png|jpe?g";
const ABSOLUTE_PATH_VALUE_PATTERN = new RegExp(
  `(?:^|[\\s"'(])(?:file:\\/\\/(?:localhost)?(?:[A-Za-z]:[\\\\/]|\\/)?|[A-Za-z]:[\\\\/]|\\/)[^\\r\\n"'<>]*(?:\\.(?:${PATH_FILE_EXTENSION_PATTERN})\\b|[\\\\/][^\\s"'<>),;]+)`,
  "i",
);
const PHASE_CATEGORY_PATTERNS = [
  { category: "reconciliation_apply", pattern: /(reconciliation|apply)/i },
  { category: "staging", pattern: /(staging|stage|temp|hash|write)/i },
  { category: "lifecycle", pattern: /(pause|resume|restart|listener|lifecycle|start|stop)/i },
  { category: "ui_visibility", pattern: /(visible|visibility|ui|hydrate|render)/i },
  { category: "network", pattern: /(network|transport|receive|recv|send|serve|read|download|upload)/i },
];
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
      (entry) => isPlainObject(entry) && LOCAL_PROJECT_MUTATION_STATUSES.has(entry.status),
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
        collected.push({ phase, durationMs });
      }
    }
  }
  return collected;
}

function canonicalizeEvidence(evidence) {
  const metrics = isPlainObject(evidence.metrics) ? evidence.metrics : {};
  const transport = isPlainObject(evidence.transport) ? evidence.transport : {};
  const lifecycle = isPlainObject(evidence.lifecycle) ? evidence.lifecycle : {};
  const storage = isPlainObject(evidence.storage) ? evidence.storage : {};
  const validation = isPlainObject(evidence.validation) ? evidence.validation : {};

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
  const totalServedBytes = asFiniteNumber(findAliasValue(metrics, [
    ["diagnostics", "total_served_bytes"],
    ["diagnostics", "totalServedBytes"],
    ["total_served_bytes"],
    ["totalServedBytes"],
    ["served_bytes"],
    ["servedBytes"],
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
  const senderOnly = received === 0 &&
    localProjectMutationCount === 0 &&
    servedArtifactRequests !== null &&
    servedArtifactRequests > 0 &&
    totalServedBytes !== null &&
    totalServedBytes > 0;

  return {
    runRole: senderOnly
      ? "sender_only"
      : received > 0 || localProjectMutationCount > 0
        ? "receiver_or_import"
        : "unknown",
    selectedTransport,
    candidateTransports,
    networkReceiveThroughputBytesPerSecond: asFiniteNumber(findAliasValue(metrics, [
      ["network_receive_throughput_bytes_per_second"],
      ["receive_throughput_bytes_per_second"],
      ["transport_receive_throughput_bytes_per_second"],
      ["throughput_bytes_per_second"],
    ])),
    backendStagingThroughputBytesPerSecond: asFiniteNumber(findAliasValue(metrics, [
      ["backend_staging_throughput_bytes_per_second"],
      ["staging_throughput_bytes_per_second"],
    ])),
    reconciliationApplyMs: asFiniteNumber(findAliasValue(metrics, [
      ["reconciliation_apply_ms"],
      ["apply_ms"],
      ["reconciliation", "apply_ms"],
    ])),
    projectImportsPerMinute: asFiniteNumber(findAliasValue(metrics, [
      ["project_imports_per_minute"],
      ["projects_per_minute"],
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
    servedArtifactRequests,
    totalServedBytes,
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
    validationPassed: validation.ok === false || validation.valid === false
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
  const requiresReceiverMetrics = normalized.runRole !== "sender_only";
  if (normalized.networkReceiveThroughputBytesPerSecond === null) {
    errors.push("Missing required metric: network receive throughput.");
  }
  if (requiresReceiverMetrics && normalized.backendStagingThroughputBytesPerSecond === null) {
    errors.push("Missing required metric: backend staging throughput.");
  }
  if (requiresReceiverMetrics && normalized.reconciliationApplyMs === null) {
    errors.push("Missing required metric: reconciliation apply time.");
  }
  if (normalized.projectImportsPerMinute === null) {
    errors.push("Missing required metric: project import cadence (projects per minute).");
  }
  if (requiresReceiverMetrics && normalized.projectAvailabilityGapMs === null) {
    errors.push("Missing required metric: project import cadence gap.");
  }
  if (normalized.ttfaMs === null) {
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

function validateScenario(evidence, expectedScenario, errors) {
  if (!expectedScenario) {
    return;
  }
  if (evidence.scenario !== expectedScenario) {
    errors.push(`Scenario mismatch: expected ${expectedScenario}, got ${String(evidence.scenario)}`);
  }
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
    if (ABSOLUTE_PATH_VALUE_PATTERN.test(value)) {
      errors.push(`Privacy guard: absolute path at ${trail.join(".")}`);
    }
    if (!isIsoTimestamp(value) && (ENDPOINT_VALUE_PATTERN.test(value) || /^https?:\/\//i.test(value))) {
      errors.push(`Privacy guard: endpoint hint at ${trail.join(".")}`);
    }
    if (FILE_NAME_PATTERN.test(value)) {
      errors.push(`Privacy guard: filename-like value at ${trail.join(".")}`);
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
    validateScenario(evidence, scenario, errors);
    inspectPrivacy(evidence, [], errors);
  }
  return {
    ok: errors.length === 0,
    schemaVersion: SCHEMA_VERSION,
    errors,
    normalized: isPlainObject(evidence) ? canonicalizeEvidence(evidence) : null,
  };
}

function phaseCategoryScore(phaseTimings) {
  const scores = new Map();
  for (const entry of phaseTimings) {
    const matched = PHASE_CATEGORY_PATTERNS.find((item) => item.pattern.test(entry.phase));
    if (!matched) {
      continue;
    }
    scores.set(matched.category, (scores.get(matched.category) ?? 0) + entry.durationMs);
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
  } else if (normalized.validationPassed === false) {
    bottleneck = "incomplete_evidence";
    reasons.push("validation_flag_failed");
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

export function compareEvidence(candidateEvidence, controlEvidence) {
  const candidateSummary = summarizeEvidence(candidateEvidence);
  const controlSummary = summarizeEvidence(controlEvidence);
  const comparisons = [
    compareMetric(candidateSummary.metrics, controlSummary.metrics, "networkReceiveThroughputBytesPerSecond", "higher"),
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
