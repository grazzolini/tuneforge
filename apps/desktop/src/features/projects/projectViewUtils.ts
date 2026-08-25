import type { ArtifactSchema, ChordSegmentSchema, JobSchema, LyricsSegmentSchema, LyricsWordSchema } from "../../lib/api";
import { formatLocalDateTime } from "../../lib/datetime";
import {
  formatParsedChordLabel,
  formatChordLabel,
  isSupportedChordQuality,
  parseChordLabel,
  transposeChord,
  type EnharmonicDisplayMode,
  type MusicalKey,
  transposePitchClass,
} from "../../lib/music";

const STEM_ARTIFACT_LABELS: Record<string, string> = {
  bass_stem: "Bass",
  drums_stem: "Drums",
  guitar_stem: "Guitar",
  instrumental_stem: "Instrumental",
  other_stem: "Other",
  piano_stem: "Piano",
  vocal_stem: "Vocals",
};

const STEM_ARTIFACT_TYPES = new Set(Object.keys(STEM_ARTIFACT_LABELS));

export type SeekDirection = "backward" | "forward";

export function artifactLabel(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") return "Source Track";
  if (artifact.type === "preview_mix") return "Practice Mix";
  if (artifact.type === "export_mix") return "Export File";
  if (artifact.type in STEM_ARTIFACT_LABELS) return STEM_ARTIFACT_LABELS[artifact.type];
  if (artifact.type === "analysis_json") return "Analysis JSON";
  return artifact.type;
}

export function isPlayableArtifact(artifact: ArtifactSchema) {
  return artifact.type === "source_audio" || artifact.type === "preview_mix" || isStemArtifact(artifact);
}

export function isStemArtifact(artifact: ArtifactSchema | null | undefined) {
  return Boolean(artifact && STEM_ARTIFACT_TYPES.has(artifact.type));
}

export function preferredArtifactSelection(artifacts: ArtifactSchema[]) {
  return (
    artifacts.find((artifact) => artifact.type === "source_audio") ??
    artifacts.find((artifact) => artifact.type === "preview_mix") ??
    artifacts[0] ??
    null
  );
}

export function fileNameFromPath(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

export function formatSemitoneShift(semitones: number) {
  return `Shift ${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}`;
}

function formatOrdinal(value: number) {
  const lastTwoDigits = value % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return `${value}th`;
  }
  if (value % 10 === 1) {
    return `${value}st`;
  }
  if (value % 10 === 2) {
    return `${value}nd`;
  }
  if (value % 10 === 3) {
    return `${value}rd`;
  }
  return `${value}th`;
}

export function formatCapoShiftSummary(semitones: number) {
  const shiftSummary = formatSemitoneShift(semitones);
  if (semitones >= 0) {
    return shiftSummary;
  }
  return `${shiftSummary} / ${formatOrdinal(Math.abs(semitones))} fret`;
}

export const MIN_TARGET_TRANSPOSE = -12;
export const MAX_TARGET_TRANSPOSE = 12;

export function clampTargetTranspose(semitones: number) {
  return Math.min(MAX_TARGET_TRANSPOSE, Math.max(MIN_TARGET_TRANSPOSE, semitones));
}

export function formatTargetSelectionSummary(semitones: number) {
  if (semitones === 0) {
    return "Original";
  }
  if (Math.abs(semitones) === 12) {
    return semitones > 0 ? "1 octave higher" : "1 octave lower";
  }
  return semitones > 0 ? "Higher pitch" : "Lower pitch";
}

export type TargetShiftOption = {
  semitones: number;
  key: MusicalKey;
};

export type SourceKeyOption = {
  badge: string | null;
  key: MusicalKey;
  value: string;
};

export function formatArtifactTimestamp(createdAt: string) {
  return formatLocalDateTime(createdAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatJobDuration(durationSeconds: number | null | undefined) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return null;
  }
  if (durationSeconds < 1) {
    return `${Math.max(1, Math.round(durationSeconds * 1000))} ms`;
  }
  if (durationSeconds < 60) {
    return `${durationSeconds < 10 ? durationSeconds.toFixed(1) : Math.round(durationSeconds)} s`;
  }

  return formatPlaybackClock(durationSeconds);
}

type FormatJobStatusSummaryOptions = {
  includeRuntimeDevice?: boolean;
};

const RUNTIME_LABEL_LIMIT = 160;
const RUNTIME_DETAIL_LIMIT = 240;
const DIAGNOSTIC_TEXT_LIMIT = 320;
const SAFE_RUNTIME_DETAIL_PHRASES = new Set([
  "CPU fallback after accelerator became unavailable.",
  "CUDA failed, retrying CPU.",
  "Demucs switched to CPU after the accelerator attempt failed.",
  "Demucs switched to CPU because the requested accelerator is unavailable.",
  "MPS failed, retrying CPU.",
  "Whisper switched to CPU after the accelerator attempt failed.",
  "Whisper switched to CPU because the requested accelerator is unavailable.",
  "Whisper switched to a smaller model after CUDA memory pressure.",
]);

type DependencyDiagnosticKind = "host_tool" | "model_cache" | "dependency";

type DependencyDiagnosticInput = {
  code?: string | null;
  details?: unknown;
  fallbackOperation?: string | null;
  message: string | null | undefined;
};

const DETAIL_DEPENDENCY_KEYS = ["dependency", "tool", "package", "backend"] as const;
const DETAIL_MODEL_KEYS = ["model"] as const;
const DETAIL_KIND_KEYS = ["dependency_kind", "dependency_type", "diagnostic_kind"] as const;
const DETAIL_OPERATION_KEYS = ["operation", "affected_operation", "context"] as const;
const DETAIL_ACTION_KEYS = [
  "local_action",
  "next_action",
  "recovery_hint",
  "action",
  "guidance",
  "remediation",
] as const;
const OPERATION_LABELS: Record<string, string> = {
  audio_import_normalization: "audio import normalization",
  audio_transform: "audio transform",
  lyrics_transcription: "lyrics generation",
  metadata_extraction: "metadata extraction",
  stem_separation: "stem separation",
};
const OPERATION_MESSAGE_PATTERNS: Record<string, RegExp> = {
  "audio import normalization": /\b(audio import normalization|normalize imported audio)\b/i,
  "audio transform": /\b(audio transform|create transformed audio|transformed audio)\b/i,
  "lyrics generation": /\b(lyrics generation|lyrics transcription|generate lyrics)\b/i,
  "metadata extraction": /\b(metadata extraction|inspect audio metadata)\b/i,
  "stem separation": /\b(stem separation|separate stems)\b/i,
};

export function formatJobRuntimeDevice(device: string | null | undefined) {
  const trimmed = typeof device === "string" ? device.trim() : "";
  return trimmed ? trimmed.toUpperCase() : null;
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function formatSafeRuntimeText(value: string | null | undefined, limit: number) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > limit || hasControlCharacter(value ?? "")) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  if (/[\\/]/.test(normalized)) {
    return null;
  }
  if (/(^|\s)\S+\.[a-z0-9]{1,8}(?=$|\s|[,;:!?])/i.test(normalized)) {
    return null;
  }
  if (
    /\b(stdout|stderr|traceback|stack trace)\b/i.test(normalized) ||
    /^\s*(debug|info|warning|warn|error|critical|trace)\s*:/i.test(normalized) ||
    /\[(debug|info|warning|warn|error|critical|trace)\]/i.test(normalized) ||
    /\bFile "/.test(normalized) ||
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatDiagnosticText(value: string | null | undefined, limit = DIAGNOSTIC_TEXT_LIMIT) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || hasControlCharacter(trimmed)) {
    return null;
  }

  let normalized = trimmed.replace(/\s+/g, " ");
  const rawOutputIndex = normalized.search(/\b(stdout|stderr|traceback|stack trace)\b/i);
  if (rawOutputIndex >= 0) {
    normalized = normalized.slice(0, rawOutputIndex).trim();
  }

  normalized = normalized.replace(/\bfile:\/\/[^\s,;)"']+/gi, "[redacted path]");
  normalized = normalized.replace(/\b[A-Za-z]:\\[^\s,;)"']+/g, "[redacted path]");
  normalized = normalized.replace(
    /(^|[\s(["'])\/(?:Users|home|private|tmp|var|Volumes|[^/\s]+\/)[^\s,;)"']+/g,
    (_match, prefix: string) => `${prefix}[redacted path]`,
  );
  normalized = normalized.replace(
    /\b[^\s\\/]+\.(wav|mp3|flac|m4a|aac|ogg|mp4|webm)\b/gi,
    "[redacted file]",
  );
  normalized = normalized.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }
  return normalized.length > limit ? `${normalized.slice(0, limit - 3).trimEnd()}...` : normalized;
}

function detailText(details: unknown, keys: readonly string[]) {
  if (!isRecord(details)) {
    return null;
  }
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string") {
      const formatted = formatDiagnosticText(value, 160);
      if (formatted) {
        return formatted;
      }
    }
  }
  return null;
}

function operationLabel(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  const key = normalized.toLowerCase().replace(/\s+/g, "_");
  return OPERATION_LABELS[key] ?? normalized.replace(/_/g, " ");
}

function detailOperationText(details: unknown) {
  const operation = detailText(details, DETAIL_OPERATION_KEYS);
  return operation ? operationLabel(operation) : null;
}

function dependencyFromMessage(message: string | null | undefined) {
  const normalized = message?.toLowerCase() ?? "";
  if (/\bffprobe\b/.test(normalized)) {
    return "ffprobe";
  }
  if (/\bffmpeg\b/.test(normalized)) {
    return "ffmpeg";
  }
  if (/\bopenai-whisper\b/.test(normalized)) {
    return "openai-whisper";
  }
  if (/\bwhisper\b/.test(normalized)) {
    return "Whisper";
  }
  if (/\bdemucs\b/.test(normalized)) {
    return "Demucs";
  }
  if (/\bbeat-this\b/.test(normalized)) {
    return "beat-this";
  }
  if (/\bcrema\b|\badvanced chords\b/.test(normalized)) {
    return "Advanced Chords";
  }
  if (/\btensorflow\b/.test(normalized)) {
    return "TensorFlow";
  }
  if (/\bkeras\b/.test(normalized)) {
    return "Keras";
  }
  return null;
}

function operationFromMessage(
  message: string | null | undefined,
  fallbackOperation: string | null | undefined,
): string | null {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("metadata extraction")) {
    return "metadata extraction";
  }
  if (normalized.includes("normalize imported audio")) {
    return "audio import normalization";
  }
  if (normalized.includes("stem separation")) {
    return "stem separation";
  }
  if (normalized.includes("lyrics generation") || normalized.includes("lyrics transcription")) {
    return "lyrics generation";
  }
  if (normalized.includes("advanced beat analysis")) {
    return "advanced beat analysis";
  }
  if (normalized.includes("chord")) {
    return "chord detection";
  }
  return fallbackOperation ?? null;
}

function dependencyKind(
  dependency: string | null,
  message: string | null | undefined,
  details: unknown,
): DependencyDiagnosticKind {
  const explicitKind = detailText(details, DETAIL_KIND_KEYS)?.toLowerCase() ?? "";
  if (/\b(host|tool|binary|path)\b/.test(explicitKind)) {
    return "host_tool";
  }
  if (/\b(model|cache|checkpoint|download)\b/.test(explicitKind)) {
    return "model_cache";
  }

  const normalizedDependency = dependency?.toLowerCase() ?? "";
  if (normalizedDependency === "ffmpeg" || normalizedDependency === "ffprobe") {
    return "host_tool";
  }

  const normalizedMessage = message?.toLowerCase() ?? "";
  if (
    /\b(model|cache|checkpoint|download|prewarm)\b/.test(normalizedMessage)
  ) {
    return "model_cache";
  }
  return "dependency";
}

function dependencyKindLabel(kind: DependencyDiagnosticKind) {
  switch (kind) {
    case "host_tool":
      return "Host tool";
    case "model_cache":
      return "Model/cache";
    default:
      return "Dependency";
  }
}

function defaultDependencyAction(dependency: string | null, kind: DependencyDiagnosticKind) {
  const normalizedDependency = dependency?.toLowerCase() ?? "";
  if (normalizedDependency === "ffmpeg") {
    return "Install FFmpeg and ensure ffmpeg is on PATH";
  }
  if (normalizedDependency === "ffprobe") {
    return "Install FFmpeg and ensure ffprobe is on PATH";
  }
  if (normalizedDependency === "demucs") {
    if (kind === "model_cache") {
      return "Run setup with model prewarm enabled, then retry stem separation";
    }
    return "Install local backend stem dependencies, then retry stem separation";
  }
  if (normalizedDependency === "whisper" || normalizedDependency === "openai-whisper") {
    if (kind === "model_cache") {
      return "Run setup with model prewarm enabled, then retry lyrics generation";
    }
    return "Install local backend lyrics dependencies, then retry lyrics generation";
  }
  if (normalizedDependency === "beat-this") {
    return "Install Advanced Beat Analysis dependencies or switch to Built-in Beat Analysis";
  }
  if (normalizedDependency === "advanced chords" || normalizedDependency === "crema") {
    return "Install Advanced Chords dependencies or switch to built-in chords";
  }
  if (kind === "model_cache") {
    return "Run setup with model prewarm enabled, then retry";
  }
  return null;
}

function cacheActionFromMessage(
  dependency: string | null,
  message: string | null | undefined,
): string | null {
  const normalizedDependency = dependency?.toLowerCase() ?? "";
  const normalizedMessage = message?.toLowerCase() ?? "";
  const isDemucs = normalizedDependency === "demucs";
  const isWhisper = normalizedDependency === "whisper" || normalizedDependency === "openai-whisper";
  if (!isDemucs && !isWhisper) {
    return null;
  }
  if (normalizedMessage.includes("download failed")) {
    return "Check local network access for first-run model download, then retry setup";
  }
  if (normalizedMessage.includes("unreadable")) {
    return "Fix local cache permissions or re-run setup from an account that can read the model cache";
  }
  if (normalizedMessage.includes("corrupt")) {
    return isDemucs
      ? "Re-run local setup to replace Demucs model assets, then retry stem separation"
      : "Re-run local setup to replace the Whisper model asset, then retry lyrics generation";
  }
  if (normalizedMessage.includes("missing")) {
    return isDemucs
      ? "Re-run local setup to download Demucs model assets, then retry stem separation"
      : "Re-run local setup to download the Whisper model asset, then retry lyrics generation";
  }
  if (isWhisper && normalizedMessage.includes("unsupported")) {
    return "Choose a supported local Whisper model, then retry lyrics generation";
  }
  return null;
}

function hasActionInMessage(message: string) {
  return /\b(install|run setup|retry|switch to|ensure|make .+ available)\b/i.test(message);
}

function asSentence(value: string) {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function messageMentions(value: string, candidate: string | null | undefined) {
  if (!candidate) {
    return false;
  }
  const operationPattern = OPERATION_MESSAGE_PATTERNS[candidate.toLowerCase()];
  if (operationPattern?.test(value)) {
    return true;
  }
  return value.toLowerCase().includes(candidate.toLowerCase());
}

function isDependencyDiagnostic(input: DependencyDiagnosticInput, dependency: string | null) {
  const code = input.code?.toUpperCase() ?? "";
  if (
    code.includes("DEPENDENCY") ||
    code.includes("BACKEND_UNAVAILABLE") ||
    code.includes("BACKEND_FAILED")
  ) {
    return true;
  }
  if (detailText(input.details, DETAIL_DEPENDENCY_KEYS)) {
    return true;
  }
  if (dependency && detailText(input.details, DETAIL_KIND_KEYS)) {
    return true;
  }
  const message = input.message?.toLowerCase() ?? "";
  return Boolean(
    dependency &&
      /\b(required|dependency|unavailable|missing|model|cache|checkpoint|download)\b/.test(message),
  );
}

function formatDependencyDiagnostic(input: DependencyDiagnosticInput) {
  const message = formatDiagnosticText(input.message);
  const dependency =
    detailText(input.details, DETAIL_DEPENDENCY_KEYS) ??
    dependencyFromMessage(message) ??
    detailText(input.details, DETAIL_MODEL_KEYS);
  if (!isDependencyDiagnostic(input, dependency)) {
    return null;
  }

  const kind = dependencyKind(dependency, message, input.details);
  const operation = detailOperationText(input.details) ?? operationFromMessage(message, input.fallbackOperation);
  const explicitAction = detailText(input.details, DETAIL_ACTION_KEYS);
  const action =
    explicitAction ?? cacheActionFromMessage(dependency, message) ?? defaultDependencyAction(dependency, kind);
  const pieces = [asSentence(message ?? "A required dependency is unavailable.")];

  if (dependency) {
    pieces.push(`${dependencyKindLabel(kind)}: ${dependency}.`);
  }
  if (operation && !messageMentions(message ?? "", operation)) {
    pieces.push(`Operation: ${operation}.`);
  }
  if (action && (explicitAction || !hasActionInMessage(message ?? ""))) {
    pieces.push(`Next: ${asSentence(action)}`);
  }

  return pieces.join(" ");
}

export function formatApiErrorMessage(error: unknown, fallback = "The request failed.") {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
  const details = isRecord(error) ? error.details : null;
  return formatDependencyDiagnostic({ code, details, message }) ?? message;
}

function operationForJobType(type: string | null | undefined) {
  switch (type) {
    case "analyze":
      return "analysis";
    case "chords":
      return "chord detection";
    case "export":
      return "export";
    case "lyrics":
      return "lyrics generation";
    case "preview":
      return "preview rendering";
    case "stems":
      return "stem separation";
    default:
      return null;
  }
}

export function formatJobErrorMessage(
  message: string | null | undefined,
  job?: Pick<JobSchema, "type"> | null,
) {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) {
    return null;
  }
  return (
    formatDependencyDiagnostic({
      fallbackOperation: operationForJobType(job?.type),
      message: trimmed,
    }) ?? trimmed
  );
}

function formatJobRuntimeDetail(detail: string | null | undefined) {
  const safeDetail = formatSafeRuntimeText(detail, RUNTIME_DETAIL_LIMIT);
  if (!safeDetail || !SAFE_RUNTIME_DETAIL_PHRASES.has(safeDetail)) {
    return null;
  }
  return safeDetail;
}

export function formatJobRuntimeSummary(job: JobSchema) {
  const device = formatJobRuntimeDevice(job.runtime_device);
  const detail = formatJobRuntimeDetail(job.runtime_detail);
  return [
    device,
    detail && detail.toUpperCase() !== device ? detail : null,
  ]
    .filter(Boolean)
    .join(" / ") || null;
}

export function formatJobProgressValue(job: Pick<JobSchema, "progress">) {
  return Math.max(0, Math.min(100, Math.round(job.progress)));
}

function formatCompletedStageLabel(stageLabel: string) {
  const savingMatch = /^Saving\s+(.+)$/i.exec(stageLabel);
  return savingMatch ? `Saved ${savingMatch[1]}` : stageLabel;
}

function regexEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingStageDevice(stageLabel: string, runtimeDevice: string | null) {
  if (!runtimeDevice) {
    return stageLabel;
  }
  return stageLabel.replace(new RegExp(`\\s+on\\s+${regexEscape(runtimeDevice)}\\.?$`, "i"), ".");
}

function stripTrailingStagePeriod(stageLabel: string) {
  return stageLabel.replace(/\.$/, "");
}

export function formatJobStageLabel(job: JobSchema) {
  if (job.type === "convert_audio" && job.status === "completed") {
    return "Converted audio";
  }
  const reportedLabel = formatSafeRuntimeText(job.stage_label, RUNTIME_LABEL_LIMIT);
  if (reportedLabel) {
    const stageLabel = stripTrailingStageDevice(reportedLabel, formatJobRuntimeDevice(job.runtime_device));
    const displayLabel = job.status === "completed" ? formatCompletedStageLabel(stageLabel) : stageLabel;
    return stripTrailingStagePeriod(displayLabel);
  }
  if (job.status === "pending") {
    return "Waiting to start";
  }
  if (job.status === "running") {
    return "Running";
  }
  return null;
}

export function formatJobStatusSummary(job: JobSchema, options: FormatJobStatusSummaryOptions = {}) {
  const includeRuntimeDevice = options.includeRuntimeDevice ?? true;
  return [
    job.status,
    job.type === "convert_audio" ? formatAudioConversion(job.input_formats, job.output_format) : null,
    job.type === "analyze" ? formatBeatBackend(job.beat_backend) : null,
    job.type === "analyze" ? formatBeatInput(job.beat_input) : null,
    job.type === "chords" ? formatChordBackend(job.chord_backend) : null,
    job.type === "chords" ? job.chord_source : null,
    job.type === "lyrics" ? formatLyricsSource(job.lyrics_source) : null,
    job.type === "stems" ? formatStemModel(job.stem_model_label ?? job.stem_model) : null,
    includeRuntimeDevice ? formatJobRuntimeDevice(job.runtime_device) : null,
    formatJobDuration(job.duration_seconds),
  ]
    .filter(Boolean)
    .join(" / ");
}

function formatAudioConversion(inputFormats: string[] | undefined, outputFormat: string | null | undefined) {
  const inputs = [...new Set((inputFormats ?? []).map(formatAudioFormat).filter(Boolean))];
  const output = formatAudioFormat(outputFormat);
  return inputs.length && output ? `${inputs.join(" + ")} → ${output}` : null;
}

function formatAudioFormat(format: string | null | undefined) {
  const normalized = typeof format === "string" ? format.trim() : "";
  return normalized ? normalized.toUpperCase() : null;
}

function formatBeatBackend(backend: string | null | undefined) {
  if (
    backend == null ||
    backend === "" ||
    backend === "built-in" ||
    backend === "librosa" ||
    backend === "default"
  ) {
    return "built-in";
  }
  if (backend === "beat-this" || backend === "advanced") {
    return "advanced";
  }
  return backend ?? null;
}

function formatBeatInput(input: string | null | undefined) {
  return input === "source" ? input : "source";
}

function formatStemModel(model: string | null | undefined) {
  if (model === "htdemucs_6s") {
    return "Default (6 stems model)";
  }
  if (model === "htdemucs_ft") {
    return "2 stems model";
  }
  return model;
}

function formatLyricsSource(source: string | null | undefined) {
  if (source === "vocals") {
    return "vocals";
  }
  if (source === "source_preferred") {
    return "source preferred";
  }
  if (source === "none") {
    return "no lyrics";
  }
  return null;
}

function formatChordBackend(backend: string | null | undefined) {
  if (backend === "tuneforge-fast" || backend === "fast" || backend === "default") {
    return "built-in";
  }
  if (backend === "crema-advanced" || backend === "advanced" || backend === "crema") {
    return "advanced";
  }
  if (backend === "lv-chordia-submission" || backend === "lv-chordia") {
    return "LV Chordia";
  }
  return backend ?? null;
}

export function formatPlaybackClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function artifactSummary(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") {
    return "Original source file";
  }
  if (isStemArtifact(artifact)) {
    const engine = typeof artifact.metadata?.engine === "string" ? artifact.metadata.engine : null;
    const mode = typeof artifact.metadata?.mode === "string" ? artifact.metadata.mode : null;
    const model = typeof artifact.metadata?.model === "string" ? artifact.metadata.model : null;
    const stemSource = typeof artifact.metadata?.stem_source === "string" ? artifact.metadata.stem_source : null;
    const device =
      typeof artifact.metadata?.device === "string" ? artifact.metadata.device.toUpperCase() : null;
    return [
      `${artifactLabel(artifact)} stem`,
      stemSource,
      mode,
      engine,
      model,
      device,
    ]
      .filter(Boolean)
      .join(" / ");
  }

  if (artifact.type === "analysis_json") {
    const backend =
      typeof artifact.metadata?.analysis_backend === "string"
        ? artifact.metadata.analysis_backend
        : "built-in";
    return formatBeatBackend(backend) ?? "built-in";
  }

  const metadata = artifact.metadata ?? {};
  const pieces: string[] = [];
  const transpose = metadata.transpose;
  if (
    transpose &&
    typeof transpose === "object" &&
    "semitones" in transpose &&
    typeof transpose.semitones === "number"
  ) {
    pieces.push(formatSemitoneShift(transpose.semitones));
  }

  const retune = metadata.retune;
  if (retune && typeof retune === "object") {
    if ("target_reference_hz" in retune && typeof retune.target_reference_hz === "number") {
      pieces.push(`Retuned to ${retune.target_reference_hz.toFixed(1)} Hz`);
    } else if ("target_cents_offset" in retune && typeof retune.target_cents_offset === "number") {
      const cents = retune.target_cents_offset;
      pieces.push(`Retuned ${cents > 0 ? "+" : ""}${cents.toFixed(1)} cents`);
    }
  }

  return pieces.join(" / ");
}

export function sourceArtifactIdForStems(artifact: ArtifactSchema | null) {
  if (!artifact) return null;
  if (isStemArtifact(artifact)) {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return typeof sourceArtifactId === "string" ? sourceArtifactId : null;
  }
  if (artifact.type === "source_audio" || artifact.type === "preview_mix") {
    return artifact.id;
  }
  return null;
}

export function artifactById(artifacts: ArtifactSchema[], artifactId: string | null | undefined) {
  if (!artifactId) return null;
  return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

export function artifactTransposeSemitones(
  artifact: ArtifactSchema | null,
  artifacts: ArtifactSchema[],
  depth = 0,
): number {
  if (!artifact || depth > 4) return 0;
  if (artifact.type === "preview_mix" || artifact.type === "export_mix") {
    const metadata = artifact.metadata ?? {};
    const transpose =
      typeof metadata.transpose === "object" && metadata.transpose !== null ? metadata.transpose : {};
    const semitones = "semitones" in transpose ? transpose.semitones : null;
    return typeof semitones === "number" ? semitones : 0;
  }
  if (isStemArtifact(artifact)) {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return artifactTransposeSemitones(
      artifactById(
        artifacts,
        typeof sourceArtifactId === "string" ? sourceArtifactId : null,
      ),
      artifacts,
      depth + 1,
    );
  }
  return 0;
}

export function transposeChordSegment(
  segment: ChordSegmentSchema,
  semitones: number,
  options: { activeKey: MusicalKey | null; mode: EnharmonicDisplayMode },
): ChordSegmentSchema {
  if (
    typeof segment.pitch_class !== "number" ||
    !isSupportedChordQuality(segment.quality)
  ) {
    return transposeChordSegmentFromLabel(segment, semitones, options) ?? segment;
  }
  const pitchClass = transposePitchClass(segment.pitch_class, semitones);
  const bassPitchClass =
    typeof segment.bass_pitch_class === "number"
      ? transposePitchClass(segment.bass_pitch_class, semitones)
      : segment.bass_pitch_class;
  return {
    ...segment,
    bass_pitch_class: bassPitchClass,
    pitch_class: pitchClass,
    root_pitch_class: typeof segment.root_pitch_class === "number" ? pitchClass : segment.root_pitch_class,
    label: formatChordLabel(pitchClass, segment.quality, options, bassPitchClass),
  };
}

function transposeChordSegmentFromLabel(
  segment: ChordSegmentSchema,
  semitones: number,
  options: { activeKey: MusicalKey | null; mode: EnharmonicDisplayMode },
): ChordSegmentSchema | null {
  if (isNoChordOrUnknownLabel(segment.label)) {
    return null;
  }

  for (const label of chordSegmentLabelCandidates(segment)) {
    const parsedChord = parseChordLabel(label);
    if (!parsedChord) {
      continue;
    }
    const transposedChord = transposeChord(parsedChord, semitones);
    if (!transposedChord) {
      continue;
    }
    return {
      ...segment,
      bass_degree: transposedChord.bassDegree ?? null,
      bass_pitch_class: transposedChord.bassPitchClass,
      label: formatParsedChordLabel(transposedChord, options),
      pitch_class: transposedChord.rootPitchClass,
      quality: transposedChord.quality,
      root_pitch_class: transposedChord.rootPitchClass,
    };
  }

  return null;
}

function chordSegmentLabelCandidates(segment: ChordSegmentSchema): string[] {
  const labels = [segment.label, segment.display_label, segment.raw_label].filter(
    (label): label is string => typeof label === "string" && label.trim().length > 0,
  );
  return Array.from(new Set(labels));
}

function isNoChordOrUnknownLabel(label: string): boolean {
  const compactLabel = label.trim().replace(/\s+/g, "").toUpperCase();
  return (
    compactLabel === "N" ||
    compactLabel === "NC" ||
    compactLabel === "N.C." ||
    compactLabel === "NO_CHORD" ||
    compactLabel === "NO-CHORD" ||
    compactLabel === "X"
  );
}

export function findActiveChordIndex(timeline: ChordSegmentSchema[], playbackTimeSeconds: number) {
  return timeline.findIndex((segment, index) => {
    const isLast = index === timeline.length - 1;
    return (
      playbackTimeSeconds >= segment.start_seconds &&
      (playbackTimeSeconds < segment.end_seconds || isLast)
    );
  });
}

export function hasTimedLyrics(
  segment: LyricsSegmentSchema,
): segment is LyricsSegmentSchema & { start_seconds: number; end_seconds: number } {
  return typeof segment.start_seconds === "number" && typeof segment.end_seconds === "number";
}

const ACTIVE_LYRIC_BOUNDARY_EPSILON_SECONDS = 0.005;

export function findActiveLyricsIndex(timeline: LyricsSegmentSchema[], playbackTimeSeconds: number) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const segment = timeline[index];
    if (
      segment &&
      hasTimedLyrics(segment) &&
      Math.abs(playbackTimeSeconds - segment.start_seconds) <= ACTIVE_LYRIC_BOUNDARY_EPSILON_SECONDS
    ) {
      return index;
    }
  }

  return timeline.findIndex((segment, index) => {
    if (!hasTimedLyrics(segment)) {
      return false;
    }
    const isLast = index === timeline.length - 1;
    const nextTimedSegmentStart = timeline
      .slice(index + 1)
      .find((candidate) => typeof candidate.start_seconds === "number")?.start_seconds;
    const effectiveEndSeconds =
      !isLast && typeof nextTimedSegmentStart === "number"
        ? Math.min(segment.end_seconds, nextTimedSegmentStart)
        : segment.end_seconds;
    return (
      playbackTimeSeconds >= segment.start_seconds &&
      (playbackTimeSeconds < effectiveEndSeconds || isLast)
    );
  });
}

export function findActiveLyricsWordIndex(words: LyricsWordSchema[], playbackTimeSeconds: number) {
  return words.findIndex((word, index) => {
    if (typeof word.start_seconds !== "number" || typeof word.end_seconds !== "number") {
      return false;
    }
    const isLast = index === words.length - 1;
    return (
      playbackTimeSeconds >= word.start_seconds &&
      (playbackTimeSeconds < word.end_seconds || isLast)
    );
  });
}

export type LeadSheetChordAnchor =
  | {
      type: "word";
      wordIndex: number;
    }
  | {
      type: "percent";
      percent: number;
    };

export type LeadSheetChord = {
  anchor: LeadSheetChordAnchor;
  chordIndex: number;
  id: string;
  isActive: boolean;
  segment: ChordSegmentSchema;
};

export type LeadSheetLyricsRow = {
  activeWordIndex: number;
  chords: LeadSheetChord[];
  id: string;
  isActive: boolean;
  lyricIndex: number;
  segment: LyricsSegmentSchema;
  type: "lyrics";
};

export type LeadSheetChordRow = {
  chords: LeadSheetChord[];
  id: string;
  isActive: boolean;
  type: "chords";
};

export type LeadSheetRow = LeadSheetLyricsRow | LeadSheetChordRow;

type BuildLeadSheetRowsOptions = {
  activeChordIndex: number;
  activeLyricsIndex: number;
  activeLyricsWordIndex: number;
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function chordLeadSheetId(segment: ChordSegmentSchema, chordIndex: number) {
  return `chord-${chordIndex}-${segment.start_seconds}-${segment.label}`;
}

function chordAnchorForLyricsSegment(
  chord: ChordSegmentSchema,
  segment: LyricsSegmentSchema,
): LeadSheetChordAnchor {
  if (segment.words?.length) {
    const timedWords = segment.words.flatMap((word, wordIndex) =>
      typeof word.start_seconds === "number" &&
      Number.isFinite(word.start_seconds) &&
      typeof word.end_seconds === "number" &&
      Number.isFinite(word.end_seconds) &&
      word.end_seconds >= word.start_seconds
        ? [{ end: word.end_seconds, start: word.start_seconds, wordIndex }]
        : []
    );
    if (timedWords.length) {
      const containingOrFollowing = timedWords.find(
        (word) => chord.start_seconds < word.start ||
          (chord.start_seconds >= word.start && chord.start_seconds < word.end),
      );
      return {
        type: "word",
        wordIndex: containingOrFollowing?.wordIndex ?? timedWords[timedWords.length - 1]!.wordIndex,
      };
    }
  }

  if (hasTimedLyrics(segment) && segment.end_seconds > segment.start_seconds) {
    return {
      type: "percent",
      percent: clampPercent(
        ((chord.start_seconds - segment.start_seconds) /
          (segment.end_seconds - segment.start_seconds)) *
          100,
      ),
    };
  }

  return { type: "percent", percent: 0 };
}

function findLyricsIndexForChord(
  lyrics: LyricsSegmentSchema[],
  chord: ChordSegmentSchema,
) {
  return lyrics.findIndex((segment) => {
    if (!hasTimedLyrics(segment)) {
      return false;
    }
    return (
      chord.start_seconds >= segment.start_seconds &&
      chord.start_seconds < segment.end_seconds
    );
  });
}

function findGapInsertionIndex(lyrics: LyricsSegmentSchema[], chord: ChordSegmentSchema) {
  const nextTimedLyricsIndex = lyrics.findIndex(
    (segment) => hasTimedLyrics(segment) && chord.start_seconds < segment.start_seconds,
  );
  return nextTimedLyricsIndex >= 0 ? nextTimedLyricsIndex : lyrics.length;
}

function leadSheetChord(
  chord: ChordSegmentSchema,
  chordIndex: number,
  anchor: LeadSheetChordAnchor,
  activeChordIndex: number,
): LeadSheetChord {
  return {
    anchor,
    chordIndex,
    id: chordLeadSheetId(chord, chordIndex),
    isActive: chordIndex === activeChordIndex,
    segment: chord,
  };
}

export function buildLeadSheetRows(
  lyrics: LyricsSegmentSchema[],
  chords: ChordSegmentSchema[],
  { activeChordIndex, activeLyricsIndex, activeLyricsWordIndex }: BuildLeadSheetRowsOptions,
): LeadSheetRow[] {
  const chordsByLyricsIndex = new Map<number, LeadSheetChord[]>();
  const gapChordsByInsertionIndex = new Map<number, LeadSheetChord[]>();

  chords.forEach((chord, chordIndex) => {
    const lyricIndex = findLyricsIndexForChord(lyrics, chord);
    if (lyricIndex >= 0) {
      const segment = lyrics[lyricIndex];
      const current = chordsByLyricsIndex.get(lyricIndex) ?? [];
      current.push(
        leadSheetChord(
          chord,
          chordIndex,
          chordAnchorForLyricsSegment(chord, segment),
          activeChordIndex,
        ),
      );
      chordsByLyricsIndex.set(lyricIndex, current);
      return;
    }

    const insertionIndex = findGapInsertionIndex(lyrics, chord);
    const current = gapChordsByInsertionIndex.get(insertionIndex) ?? [];
    current.push(
      leadSheetChord(chord, chordIndex, { type: "percent", percent: 0 }, activeChordIndex),
    );
    gapChordsByInsertionIndex.set(insertionIndex, current);
  });

  const rows: LeadSheetRow[] = [];
  for (let index = 0; index <= lyrics.length; index += 1) {
    const gapChords = gapChordsByInsertionIndex.get(index) ?? [];
    if (gapChords.length) {
      rows.push({
        chords: gapChords,
        id: `lead-sheet-gap-${index}-${gapChords[0]?.segment.start_seconds ?? 0}`,
        isActive: gapChords.some((chord) => chord.isActive),
        type: "chords",
      });
    }

    const segment = lyrics[index];
    if (segment) {
      rows.push({
        activeWordIndex: index === activeLyricsIndex ? activeLyricsWordIndex : -1,
        chords: chordsByLyricsIndex.get(index) ?? [],
        id: `lead-sheet-lyrics-${index}-${segment.start_seconds ?? "static"}`,
        isActive: index === activeLyricsIndex,
        lyricIndex: index,
        segment,
        type: "lyrics",
      });
    }
  }

  if (!lyrics.length && !rows.length && chords.length) {
    rows.push({
      chords: chords.map((chord, chordIndex) =>
        leadSheetChord(chord, chordIndex, { type: "percent", percent: 0 }, activeChordIndex),
      ),
      id: "lead-sheet-gap-0",
      isActive: activeChordIndex >= 0,
      type: "chords",
    });
  }

  return rows;
}

export function formatRetuneSummary(
  retuneMode: "off" | "reference" | "cents",
  referenceHz: string,
  centsOffset: string,
) {
  if (retuneMode === "off") {
    return "No fine retune";
  }
  if (retuneMode === "reference") {
    return `Retuned to ${referenceHz} Hz`;
  }
  return `Retuned ${Number(centsOffset) > 0 ? "+" : ""}${centsOffset} cents`;
}
