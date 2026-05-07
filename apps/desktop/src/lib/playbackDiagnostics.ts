const NATIVE_PLAYBACK_ERROR_KEY = "tuneforge.playback-native-error";
const PLAYBACK_BACKEND_KEY = "tuneforge.playback-backend";

export type PlaybackBackend = {
  backend: "native" | "web";
  detail: string | null;
};

export function rememberPlaybackBackend(backend: PlaybackBackend) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    PLAYBACK_BACKEND_KEY,
    JSON.stringify({
      backend: backend.backend,
      detail: backend.detail,
    }),
  );
}

export function readRememberedPlaybackBackend(): PlaybackBackend | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const rawBackend = JSON.parse(window.localStorage.getItem(PLAYBACK_BACKEND_KEY) ?? "null");
    if (
      rawBackend?.backend !== "native" &&
      rawBackend?.backend !== "web"
    ) {
      return null;
    }
    return {
      backend: rawBackend.backend,
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
  window.localStorage.setItem(NATIVE_PLAYBACK_ERROR_KEY, error);
}

export function readRememberedNativePlaybackError() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(NATIVE_PLAYBACK_ERROR_KEY);
}

export function clearRememberedNativePlaybackError() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(NATIVE_PLAYBACK_ERROR_KEY);
}

export function playbackErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Native playback failed.";
}
