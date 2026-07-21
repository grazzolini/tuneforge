import { invoke } from "@tauri-apps/api/core";
import { redactPlaybackDiagnosticText } from "./playbackDiagnostics";

export type PowerInhibitionReason = "playback" | "sync-listener" | "sync-transfer";

export type PowerInhibitionPhase =
  | "inactive"
  | "acquiring"
  | "active"
  | "unsupported"
  | "failed"
  | "releasing"
  | "release-failed";

export type PowerInhibitionStatus = {
  phase: PowerInhibitionPhase;
  backend: string | null;
  activeReasons: PowerInhibitionReason[];
  screenProtected: boolean;
  backgroundProtected: boolean;
  errorCode: string | null;
  errorMessage: string | null;
};

export type BrowserWakeLockStatus = {
  phase: PowerInhibitionPhase;
  backend: "browser-screen-wake-lock" | null;
  screenProtected: boolean;
  errorMessage: string | null;
};

const POWER_BACKEND_KEY = "tuneforge.power-inhibition-backend";
const POWER_ERROR_KEY = "tuneforge.power-inhibition-error";
const REASONS = new Set<PowerInhibitionReason>([
  "playback",
  "sync-listener",
  "sync-transfer",
]);
const PHASES = new Set<PowerInhibitionPhase>([
  "inactive",
  "acquiring",
  "active",
  "unsupported",
  "failed",
  "releasing",
  "release-failed",
]);
const BACKENDS = new Set([
  "macos-iopm",
  "xdg-desktop-portal",
  "systemd-logind",
  "android-foreground-service",
]);

const INACTIVE_STATUS: PowerInhibitionStatus = {
  phase: "inactive",
  backend: null,
  activeReasons: [],
  screenProtected: false,
  backgroundProtected: false,
  errorCode: null,
  errorMessage: null,
};

const INACTIVE_BROWSER_STATUS: BrowserWakeLockStatus = {
  phase: "inactive",
  backend: null,
  screenProtected: false,
  errorMessage: null,
};

let currentStatus = INACTIVE_STATUS;
let browserStatus = INACTIVE_BROWSER_STATUS;
let diagnosticsVersion = 0;
let operationSequence = 0;
let convergenceToken: { cancelled: boolean; sequence: number } | null = null;
const listeners = new Set<() => void>();
const CONVERGENCE_POLL_INTERVAL_MS = 100;
const CONVERGENCE_MAX_POLLS = 30;

function notify() {
  diagnosticsVersion += 1;
  listeners.forEach((listener) => listener());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToken(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9.-]{0,63}$/i.test(trimmed) ? trimmed : null;
}

function safeMessage(value: unknown, fallback: string | null = null) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return redactPlaybackDiagnosticText(value)
    .replace(
      /\b(device|project|run|sync)[-_ ]?(?:id)?\s*[:=]\s*["'][^"'\r\n]+["']/gi,
      "$1 [redacted]",
    )
    .replace(
      /\b(device|project|run|sync)[-_ ]?(?:id)?[:= ]+[^\s,;]+/gi,
      "$1 [redacted]",
    )
    .slice(0, 240);
}

function rememberStatus(status: PowerInhibitionStatus) {
  if (typeof window === "undefined") {
    return;
  }
  if (status.backend) {
    window.localStorage.setItem(POWER_BACKEND_KEY, status.backend);
  }
  if (status.errorMessage) {
    window.localStorage.setItem(POWER_ERROR_KEY, status.errorMessage);
  }
}

function publishStatus(status: PowerInhibitionStatus) {
  currentStatus = status;
  rememberStatus(status);
  notify();
  return status;
}

function failedStatus(
  phase: "failed" | "release-failed",
  reason: PowerInhibitionReason,
  error: unknown,
) {
  const activeReasons = new Set(currentStatus.activeReasons);
  activeReasons.add(reason);
  return publishStatus({
    ...currentStatus,
    phase,
    activeReasons: [...activeReasons],
    errorCode: phase === "failed" ? "power-inhibition-command-failed" : "power-inhibition-release-failed",
    errorMessage: safeMessage(
      error instanceof Error ? error.message : error,
      phase === "failed"
        ? "Power protection could not be enabled."
        : "Power protection release could not be confirmed.",
    ),
  });
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isPendingPhase(phase: PowerInhibitionPhase) {
  return phase === "acquiring" || phase === "releasing";
}

function waitForConvergencePoll() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, CONVERGENCE_POLL_INTERVAL_MS);
  });
}

function cancelPendingConvergence() {
  if (convergenceToken) {
    convergenceToken.cancelled = true;
    convergenceToken = null;
  }
}

async function convergePowerInhibitionStatus(
  token: { cancelled: boolean; sequence: number },
  initialStatus: PowerInhibitionStatus,
  reason: PowerInhibitionReason,
  active: boolean,
) {
  let status = initialStatus;
  for (let attempt = 0; attempt < CONVERGENCE_MAX_POLLS && isPendingPhase(status.phase); attempt += 1) {
    await waitForConvergencePoll();
    if (token.cancelled || token.sequence !== operationSequence) {
      return currentStatus;
    }
    try {
      const rawStatus = await invoke<unknown>("power_inhibition_status");
      if (token.cancelled || token.sequence !== operationSequence) {
        return currentStatus;
      }
      status = publishStatus(normalizePowerInhibitionStatus(rawStatus));
    } catch (error) {
      return token.cancelled || token.sequence !== operationSequence
        ? currentStatus
        : failedStatus(active ? "failed" : "release-failed", reason, error);
    }
  }
  if (token.cancelled || token.sequence !== operationSequence) {
    return currentStatus;
  }
  if (isPendingPhase(status.phase)) {
    return failedStatus(
      active ? "failed" : "release-failed",
      reason,
      active
        ? "Power protection did not confirm activation in time."
        : "Power protection release could not be confirmed in time.",
    );
  }
  return status;
}

export function normalizePowerInhibitionStatus(value: unknown): PowerInhibitionStatus {
  if (!isRecord(value)) {
    return {
      ...INACTIVE_STATUS,
      phase: "failed",
      errorCode: "power-inhibition-invalid-status",
      errorMessage: "Power protection returned an invalid status.",
    };
  }
  const phase = PHASES.has(value.phase as PowerInhibitionPhase)
    ? (value.phase as PowerInhibitionPhase)
    : "failed";
  const activeReasons = Array.isArray(value.activeReasons)
    ? Array.from(
        new Set(
          value.activeReasons.filter(
            (reason): reason is PowerInhibitionReason => REASONS.has(reason as PowerInhibitionReason),
          ),
        ),
      )
    : [];
  const normalizedBackend = normalizeToken(value.backend);
  const backend = normalizedBackend && BACKENDS.has(normalizedBackend) ? normalizedBackend : null;
  const errorCode = normalizeToken(value.errorCode);
  const invalidPhase = phase === "failed" && value.phase !== "failed";
  return {
    phase,
    backend,
    activeReasons,
    screenProtected: value.screenProtected === true,
    backgroundProtected: value.backgroundProtected === true,
    errorCode: invalidPhase ? "power-inhibition-invalid-status" : errorCode,
    errorMessage: invalidPhase
      ? "Power protection returned an invalid status."
      : safeMessage(value.errorMessage),
  };
}

export function subscribePowerInhibition(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPowerInhibitionVersion() {
  return diagnosticsVersion;
}

export function readPowerInhibitionStatus() {
  return currentStatus;
}

export function readBrowserWakeLockStatus() {
  return browserStatus;
}

export function updateBrowserWakeLockStatus(status: BrowserWakeLockStatus) {
  browserStatus = {
    phase: PHASES.has(status.phase) ? status.phase : "failed",
    backend: status.backend === "browser-screen-wake-lock" ? status.backend : null,
    screenProtected: status.screenProtected === true,
    errorMessage: safeMessage(status.errorMessage),
  };
  notify();
}

export async function setPowerInhibitionActivity(
  reason: PowerInhibitionReason,
  active: boolean,
) {
  cancelPendingConvergence();
  const sequence = ++operationSequence;
  const token = { cancelled: false, sequence };
  convergenceToken = token;
  const pendingReasons = new Set(currentStatus.activeReasons);
  if (active) {
    pendingReasons.add(reason);
  }
  publishStatus({
    ...currentStatus,
    phase: active ? "acquiring" : "releasing",
    activeReasons: active ? [...pendingReasons] : currentStatus.activeReasons,
    errorCode: null,
    errorMessage: null,
  });
  try {
    const rawStatus = await invoke<unknown>("power_inhibition_set_activity", { reason, active });
    const status = normalizePowerInhibitionStatus(rawStatus);
    if (sequence !== operationSequence || token.cancelled) {
      return currentStatus;
    }
    const published = publishStatus(status);
    return isPendingPhase(published.phase)
      ? await convergePowerInhibitionStatus(token, published, reason, active)
      : published;
  } catch (error) {
    return sequence === operationSequence && !token.cancelled
      ? failedStatus(active ? "failed" : "release-failed", reason, error)
      : currentStatus;
  } finally {
    if (convergenceToken === token) {
      convergenceToken = null;
    }
  }
}

export async function refreshPowerInhibitionStatus() {
  if (!isTauriRuntime()) {
    return currentStatus;
  }
  const sequence = operationSequence;
  try {
    const rawStatus = await invoke<unknown>("power_inhibition_status");
    const status = normalizePowerInhibitionStatus(rawStatus);
    return sequence === operationSequence ? publishStatus(status) : currentStatus;
  } catch (error) {
    if (sequence !== operationSequence) {
      return currentStatus;
    }
    return publishStatus({
      ...currentStatus,
      phase: "failed",
      errorCode: "power-inhibition-status-failed",
      errorMessage: safeMessage(error instanceof Error ? error.message : error, "Power protection status is unavailable."),
    });
  }
}

export function readRememberedPowerInhibitionBackend() {
  if (typeof window === "undefined") {
    return null;
  }
  const backend = normalizeToken(window.localStorage.getItem(POWER_BACKEND_KEY));
  return backend && BACKENDS.has(backend) ? backend : null;
}

export function readRememberedPowerInhibitionError() {
  if (typeof window === "undefined") {
    return null;
  }
  return safeMessage(window.localStorage.getItem(POWER_ERROR_KEY));
}

export function resetPowerInhibitionDiagnostics() {
  cancelPendingConvergence();
  operationSequence += 1;
  currentStatus = INACTIVE_STATUS;
  browserStatus = INACTIVE_BROWSER_STATUS;
  notify();
}

function phaseFailureMessage(phase: PowerInhibitionPhase, errorMessage: string | null) {
  if (phase === "unsupported") {
    return "Power protection is unavailable. Playback may pause when the device sleeps.";
  }
  if (phase === "failed") {
    return errorMessage ?? "Power protection could not be enabled. Playback may pause when the device sleeps.";
  }
  if (phase === "release-failed") {
    return errorMessage ?? "Power protection release could not be confirmed.";
  }
  return null;
}

export function playbackPowerProtectionMessage() {
  const nativeRelevant = currentStatus.activeReasons.includes("playback");
  if (nativeRelevant) {
    return phaseFailureMessage(currentStatus.phase, currentStatus.errorMessage);
  }
  if (currentStatus.phase === "release-failed") {
    return phaseFailureMessage(currentStatus.phase, currentStatus.errorMessage);
  }
  return phaseFailureMessage(browserStatus.phase, browserStatus.errorMessage);
}

export function syncPowerProtectionMessage(status = currentStatus) {
  const syncRelevant = status.activeReasons.some(
    (reason) => reason === "sync-listener" || reason === "sync-transfer",
  );
  if (!syncRelevant) {
    return null;
  }
  if (status.phase === "unsupported") {
    return "Power protection is unavailable. Sync may pause when the device sleeps.";
  }
  if (status.phase === "failed") {
    return status.errorMessage ?? "Power protection could not be enabled. Sync may pause when the device sleeps.";
  }
  if (status.phase === "release-failed") {
    return status.errorMessage ?? "Sync power protection release could not be confirmed.";
  }
  return null;
}
