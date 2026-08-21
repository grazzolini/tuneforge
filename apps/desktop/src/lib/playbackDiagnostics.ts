import type {
  NativeAudioBufferHealth,
  NativeAudioErrorEvent,
  NativeAudioSnapshot,
} from "./nativeAudio";

const NATIVE_PLAYBACK_ERROR_KEY = "tuneforge.playback-native-error";
const NATIVE_FALLBACK_CAUSE_KEY = "tuneforge.playback-native-fallback-cause";
const PLAYBACK_BACKEND_KEY = "tuneforge.playback-backend";
const WEB_PLAYBACK_ERROR_KEY = "tuneforge.playback-web-error";

export type PlaybackBackend =
  | {
      backend: "native";
      detail: string | null;
    }
  | {
      backend: "web";
      detail: string | null;
      mode: "fallback" | "forced";
    };

export type PlaybackCurrentState =
  | "not-playing"
  | "starting"
  | "playing"
  | "paused"
  | "error";

export type PlaybackCurrentPath =
  | "none"
  | "native"
  | "web-fallback"
  | "web-forced";

export type PlaybackLiveDiagnostics = {
  currentState: PlaybackCurrentState;
  currentPath: PlaybackCurrentPath;
  nativeBackend: string | null;
  nativeSessionLaneCount: number | null;
  nativeBufferHealth: NativeAudioBufferHealth[];
  statusMessage: string | null;
};

const INITIAL_LIVE_DIAGNOSTICS: PlaybackLiveDiagnostics = {
  currentState: "not-playing",
  currentPath: "none",
  nativeBackend: null,
  nativeSessionLaneCount: null,
  nativeBufferHealth: [],
  statusMessage: null,
};

let liveDiagnostics = INITIAL_LIVE_DIAGNOSTICS;
let diagnosticsVersion = 0;
const diagnosticsListeners = new Set<() => void>();

function notifyDiagnosticsChanged() {
  diagnosticsVersion += 1;
  diagnosticsListeners.forEach((listener) => listener());
}

function updateLiveDiagnostics(patch: Partial<PlaybackLiveDiagnostics>) {
  liveDiagnostics = { ...liveDiagnostics, ...patch };
  notifyDiagnosticsChanged();
}

export function subscribePlaybackDiagnostics(listener: () => void) {
  diagnosticsListeners.add(listener);
  return () => diagnosticsListeners.delete(listener);
}

export function getPlaybackDiagnosticsVersion() {
  return diagnosticsVersion;
}

export function readPlaybackLiveDiagnostics() {
  return liveDiagnostics;
}

export function resetLivePlaybackDiagnostics() {
  liveDiagnostics = INITIAL_LIVE_DIAGNOSTICS;
  notifyDiagnosticsChanged();
}

export function markPlaybackStarting(
  path: "native" | "web-fallback" | "web-forced",
) {
  const statusMessage =
    path === "web-fallback"
      ? "Native playback unavailable. Starting Web Audio fallback…"
      : "Starting playback…";
  updateLiveDiagnostics({
    currentState: "starting",
    currentPath: "none",
    ...(path === "web-fallback"
      ? { nativeSessionLaneCount: null, nativeBufferHealth: [] }
      : {}),
    statusMessage,
  });
}

export function markPlaybackConfirmed(backend: PlaybackBackend) {
  const currentPath: PlaybackCurrentPath =
    backend.backend === "native"
      ? "native"
      : backend.mode === "forced"
        ? "web-forced"
        : "web-fallback";
  const statusMessage =
    currentPath === "web-fallback" ? "Playing with Web Audio fallback." : null;
  const nativeBackend =
    backend.backend === "native" ? backend.detail : liveDiagnostics.nativeBackend;
  if (
    liveDiagnostics.currentState === "playing" &&
    liveDiagnostics.currentPath === currentPath &&
    liveDiagnostics.nativeBackend === nativeBackend &&
    liveDiagnostics.statusMessage === statusMessage &&
    (backend.backend === "native" ||
      (liveDiagnostics.nativeSessionLaneCount === null &&
        liveDiagnostics.nativeBufferHealth.length === 0))
  ) {
    return;
  }
  rememberPlaybackBackend(backend);
  updateLiveDiagnostics({
    currentState: "playing",
    currentPath,
    nativeBackend,
    ...(backend.backend === "web"
      ? { nativeSessionLaneCount: null, nativeBufferHealth: [] }
      : {}),
    statusMessage,
  });
}

export function markPlaybackPaused() {
  updateLiveDiagnostics({
    currentState: "paused",
    statusMessage:
      liveDiagnostics.currentPath === "web-fallback"
        ? "Paused on Web Audio fallback."
        : null,
  });
}

export function markPlaybackStopped() {
  updateLiveDiagnostics({
    currentState: "not-playing",
    currentPath: "none",
    nativeSessionLaneCount: null,
    nativeBufferHealth: [],
    statusMessage: null,
  });
}

export function markPlaybackError(message: string) {
  updateLiveDiagnostics({
    currentState: "error",
    currentPath: "none",
    nativeSessionLaneCount: null,
    nativeBufferHealth: [],
    statusMessage: redactPlaybackDiagnosticText(message),
  });
}

export function updateNativePlaybackDiagnostics(
  snapshot: Pick<NativeAudioSnapshot, "bufferHealth" | "lanes" | "sessionId">,
) {
  updateLiveDiagnostics({
    nativeSessionLaneCount: snapshot.sessionId ? snapshot.lanes.length : null,
    nativeBufferHealth: snapshot.sessionId ? snapshot.bufferHealth : [],
  });
}

export function clearNativePlaybackSessionDiagnostics() {
  updateLiveDiagnostics({
    nativeSessionLaneCount: null,
    nativeBufferHealth: [],
  });
}

export function redactPlaybackDiagnosticText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Playback failed.";
  }
  return trimmed
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^"'<>|,;\r\n]*?\.[a-z0-9]{1,16}\b(?:[?#][^\s"'<>),;]*)?/gi,
      "[local URL redacted]",
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>),;]+/gi, "[local URL redacted]")
    .replace(/(["'])(?:[A-Za-z]:\\|\/)[^"'\r\n]+\1/g, "[local path redacted]")
    .replace(
      /(?:[A-Za-z]:\\|\/)[^"'<>|,;\r\n]*?\.[a-z0-9]{1,16}\b/gi,
      "[local path redacted]",
    )
    .replace(
      /\b(artifact|lane|session)[-_ ]?(?:id)?\s*[:=]\s*["'][^"'\r\n]+["']/gi,
      "$1 [redacted]",
    )
    .replace(/\b(artifact|lane|session)[-_ ]?(?:id)?[:= ]+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\bart_[a-z0-9_-]+\b/gi, "artifact [redacted]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;]+[\\/])*[^\s,;]+/g, "[local path redacted]");
}

export function rememberPlaybackBackend(backend: PlaybackBackend) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    PLAYBACK_BACKEND_KEY,
    JSON.stringify({
      backend: backend.backend,
      detail: backend.detail,
      ...(backend.backend === "web" ? { mode: backend.mode } : {}),
    }),
  );
  notifyDiagnosticsChanged();
}

export function readRememberedPlaybackBackend(): PlaybackBackend | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const rawBackend = JSON.parse(window.localStorage.getItem(PLAYBACK_BACKEND_KEY) ?? "null");
    if (rawBackend?.backend !== "native" && rawBackend?.backend !== "web") {
      return null;
    }
    if (
      rawBackend.backend === "web" &&
      rawBackend.mode !== "forced" &&
      rawBackend.mode !== "fallback"
    ) {
      return null;
    }
    if (rawBackend.backend === "web") {
      return {
        backend: "web",
        detail: typeof rawBackend.detail === "string" ? rawBackend.detail : null,
        mode: rawBackend.mode,
      };
    }
    return {
      backend: "native",
      detail: typeof rawBackend.detail === "string" ? rawBackend.detail : null,
    };
  } catch {
    return null;
  }
}

export function rememberNativePlaybackError(error: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    NATIVE_PLAYBACK_ERROR_KEY,
    redactPlaybackDiagnosticText(error),
  );
  notifyDiagnosticsChanged();
}

export function readRememberedNativePlaybackError() {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(NATIVE_PLAYBACK_ERROR_KEY);
  return value ? redactPlaybackDiagnosticText(value) : null;
}

export function clearRememberedNativePlaybackError() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(NATIVE_PLAYBACK_ERROR_KEY);
  notifyDiagnosticsChanged();
}

export function rememberNativeFallbackCause(cause: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    NATIVE_FALLBACK_CAUSE_KEY,
    redactPlaybackDiagnosticText(cause),
  );
  notifyDiagnosticsChanged();
}

export function readRememberedNativeFallbackCause() {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(NATIVE_FALLBACK_CAUSE_KEY);
  return value ? redactPlaybackDiagnosticText(value) : null;
}

export function rememberWebPlaybackError(error: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    WEB_PLAYBACK_ERROR_KEY,
    redactPlaybackDiagnosticText(error),
  );
  notifyDiagnosticsChanged();
}

export function readRememberedWebPlaybackError() {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(WEB_PLAYBACK_ERROR_KEY);
  return value ? redactPlaybackDiagnosticText(value) : null;
}

export function playbackErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return redactPlaybackDiagnosticText(error.message);
  }
  if (typeof error === "string") {
    return redactPlaybackDiagnosticText(error);
  }
  return "Playback failed.";
}

export function nativePlaybackErrorMessage(code: NativeAudioErrorEvent["code"]) {
  switch (code) {
    case "device_changed":
      return "Native audio device changed.";
    case "device_not_available":
      return "Native playback device is unavailable.";
    case "stream_invalidated":
      return "Native playback stream was interrupted.";
    case "decoder_worker_failure":
      return "Native playback decoder failed.";
    case "output_stream_failure":
      return "Native playback output failed.";
  }
}
