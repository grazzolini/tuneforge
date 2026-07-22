import { useEffect, useRef, type RefObject } from "react";
import {
  clearSystemMediaState,
  listenSystemMediaControls,
  updateSystemMediaState,
  type SystemMediaControlEvent,
} from "../../lib/systemMedia";
import {
  usePowerInhibitionActivity,
  useScreenWakeLock,
} from "../../lib/useScreenWakeLock";
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

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useWebPlaybackWakeLock({
  backend,
  isPlaying,
}: Pick<PlaybackMediaControls, "backend" | "isPlaying">) {
  useScreenWakeLock("playback", backend === "web" && isPlaying);
}

export function usePlaybackPowerProtection(isPlaying: boolean) {
  usePowerInhibitionActivity("playback", isPlaying);
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
  usePlaybackPowerProtection(isPlaying);

  useEffect(() => {
    if (backend === "none" || !isTauriRuntime()) {
      if (ownsSystemControlsRef.current) {
        void clearSystemMediaState().catch(() => undefined);
        ownsSystemControlsRef.current = false;
      }
      return;
    }

    if (!session) {
      if (ownsSystemControlsRef.current) {
        void clearSystemMediaState().catch(() => undefined);
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

  useEffect(
    () => () => {
      if (ownsSystemControlsRef.current) {
        void clearSystemMediaState().catch(() => undefined);
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
