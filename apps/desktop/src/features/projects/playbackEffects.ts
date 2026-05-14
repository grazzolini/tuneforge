import { useEffect, useRef, type RefObject } from "react";
import {
  clearSystemMediaState,
  listenSystemMediaControls,
  setSystemMediaIdleInhibition,
  updateSystemMediaState,
  type SystemMediaControlEvent,
} from "../../lib/systemMedia";
import type { ProjectPlaybackSession } from "./playback-context";
import { isInteractiveTarget } from "./playbackUtils";

export type PlaybackControlBackend = "none" | "web" | "native";

type PlaybackMediaControls = {
  backend: PlaybackControlBackend;
  isPlaying: boolean;
  pausePlayback: () => void;
  playbackDurationSeconds: number;
  playbackRate: number;
  playbackTimeSeconds: number;
  playPlayback: () => Promise<void>;
  seekBy: (secondsDelta: number) => void;
  seekTo: (timeSeconds: number) => void;
  session: ProjectPlaybackSession | null;
  stopPlayback: () => void;
};

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
  removeEventListener?: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useWebPlaybackWakeLock({
  backend,
  isPlaying,
}: Pick<PlaybackMediaControls, "backend" | "isPlaying">) {
  useEffect(() => {
    if (backend !== "web" || !isPlaying || typeof navigator === "undefined") {
      return;
    }

    let sentinel: WakeLockSentinelLike | null = null;
    let sentinelReleaseHandler: (() => void) | null = null;
    let cancelled = false;
    const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
    if (!wakeLock) {
      return;
    }

    function clearSentinel() {
      if (sentinel && sentinelReleaseHandler) {
        sentinel.removeEventListener?.("release", sentinelReleaseHandler);
      }
      sentinel = null;
      sentinelReleaseHandler = null;
    }

    async function acquireWakeLock() {
      if (cancelled || sentinel || document.visibilityState === "hidden") {
        return;
      }
      try {
        const nextSentinel = await wakeLock?.request("screen") ?? null;
        if (cancelled) {
          void nextSentinel?.release().catch(() => undefined);
          return;
        }
        sentinel = nextSentinel;
        sentinelReleaseHandler = () => {
          if (sentinel !== nextSentinel) {
            return;
          }
          clearSentinel();
          if (!cancelled && document.visibilityState === "visible") {
            void acquireWakeLock();
          }
        };
        sentinel?.addEventListener?.("release", sentinelReleaseHandler);
      } catch {
        clearSentinel();
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && !sentinel) {
        void acquireWakeLock();
      }
    }

    void acquireWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const activeSentinel = sentinel;
      clearSentinel();
      if (activeSentinel) {
        void activeSentinel.release().catch(() => undefined);
      }
    };
  }, [backend, isPlaying]);
}

export function useSystemPlaybackMediaControls({
  backend,
  isPlaying,
  pausePlayback,
  playbackDurationSeconds,
  playbackRate,
  playbackTimeSeconds,
  playPlayback,
  seekBy,
  seekTo,
  session,
  stopPlayback,
}: PlaybackMediaControls) {
  const ownsSystemControlsRef = useRef(false);

  useEffect(() => {
    if (backend === "none" || !isTauriRuntime()) {
      if (ownsSystemControlsRef.current) {
        void clearSystemMediaState().catch(() => undefined);
        void setSystemMediaIdleInhibition(false).catch(() => undefined);
        ownsSystemControlsRef.current = false;
      }
      return;
    }

    if (!session) {
      if (ownsSystemControlsRef.current) {
        void clearSystemMediaState().catch(() => undefined);
        void setSystemMediaIdleInhibition(false).catch(() => undefined);
        ownsSystemControlsRef.current = false;
      }
      return;
    }

    ownsSystemControlsRef.current = true;
    void updateSystemMediaState({
      title: session.stageTitle || session.projectName,
      artist: session.projectName,
      album: session.stageSummary,
      playbackState: isPlaying ? "playing" : "paused",
      durationSeconds: Number.isFinite(playbackDurationSeconds)
        ? playbackDurationSeconds
        : session.durationHintSeconds,
      positionSeconds: playbackTimeSeconds,
      playbackRate,
      canSeek: true,
    }).catch(() => undefined);
  }, [
    backend,
    isPlaying,
    playbackDurationSeconds,
    playbackRate,
    playbackTimeSeconds,
    session,
  ]);

  useEffect(() => {
    if (backend === "none" || !session || !isTauriRuntime()) {
      return;
    }

    let cancelled = false;

    function handleControl(event: SystemMediaControlEvent) {
      if (cancelled) {
        return;
      }
      if (event.action === "play") {
        void playPlayback();
        return;
      }
      if (event.action === "pause") {
        pausePlayback();
        return;
      }
      if (event.action === "playPause") {
        if (isPlaying) {
          pausePlayback();
        } else {
          void playPlayback();
        }
        return;
      }
      if (event.action === "stop") {
        stopPlayback();
        return;
      }
      if (event.action === "seekBackward") {
        seekBy(-Math.abs(event.seekOffsetSeconds ?? 10));
        return;
      }
      if (event.action === "seekForward") {
        seekBy(Math.abs(event.seekOffsetSeconds ?? 10));
        return;
      }
      if (event.action === "seekTo" && typeof event.positionSeconds === "number") {
        seekTo(event.positionSeconds);
      }
    }

    let unlisten: (() => void) | null = null;
    void listenSystemMediaControls(handleControl)
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    backend,
    isPlaying,
    pausePlayback,
    playPlayback,
    seekBy,
    seekTo,
    session,
    stopPlayback,
  ]);

  useEffect(() => {
    if (!ownsSystemControlsRef.current) {
      return;
    }

    if (backend !== "native" || !isPlaying) {
      void setSystemMediaIdleInhibition(false).catch(() => undefined);
      return;
    }

    void setSystemMediaIdleInhibition(true).catch(() => undefined);
    return () => {
      void setSystemMediaIdleInhibition(false).catch(() => undefined);
    };
  }, [backend, isPlaying]);

  useEffect(
    () => () => {
      if (ownsSystemControlsRef.current) {
        void clearSystemMediaState().catch(() => undefined);
        void setSystemMediaIdleInhibition(false).catch(() => undefined);
        ownsSystemControlsRef.current = false;
      }
    },
    [],
  );
}

export function useSpacebarPlaybackShortcut({
  sessionRef,
  togglePlayback,
}: {
  sessionRef: RefObject<ProjectPlaybackSession | null>;
  togglePlayback: () => Promise<void>;
}) {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!sessionRef.current || event.defaultPrevented) {
        return;
      }
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }

      event.preventDefault();
      void togglePlayback();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sessionRef, togglePlayback]);
}
