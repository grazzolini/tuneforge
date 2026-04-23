import { useEffect, type RefObject } from "react";
import type { ProjectPlaybackSession } from "./playback-context";
import { clampTime, isInteractiveTarget } from "./playbackUtils";

type MediaSessionControls = {
  isPlaying: boolean;
  pausePlayback: () => void;
  playbackDurationSeconds: number;
  playbackTimeSeconds: number;
  playPlayback: () => Promise<void>;
  seekBy: (secondsDelta: number) => void;
  session: ProjectPlaybackSession | null;
  stopPlayback: () => void;
};

export function useMediaSessionControls({
  isPlaying,
  pausePlayback,
  playbackDurationSeconds,
  playbackTimeSeconds,
  playPlayback,
  seekBy,
  session,
  stopPlayback,
}: MediaSessionControls) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }

    if (!session) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      } catch {
        return;
      }
      return;
    }

    try {
      if (typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: session.stageTitle || session.projectName,
          artist: session.projectName,
          album: session.stageSummary,
        });
      }

      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
      navigator.mediaSession.setActionHandler("play", () => {
        void playPlayback();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        pausePlayback();
      });
      navigator.mediaSession.setActionHandler("stop", () => {
        stopPlayback();
      });
      navigator.mediaSession.setActionHandler("seekbackward", () => {
        seekBy(-10);
      });
      navigator.mediaSession.setActionHandler("seekforward", () => {
        seekBy(10);
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        seekBy(-10);
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        seekBy(10);
      });

      if (
        typeof navigator.mediaSession.setPositionState === "function" &&
        Number.isFinite(playbackDurationSeconds) &&
        playbackDurationSeconds > 0
      ) {
        navigator.mediaSession.setPositionState({
          duration: playbackDurationSeconds,
          playbackRate: 1,
          position: clampTime(playbackTimeSeconds, playbackDurationSeconds),
        });
      }
    } catch {
      return;
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("stop", null);
        navigator.mediaSession.setActionHandler("seekbackward", null);
        navigator.mediaSession.setActionHandler("seekforward", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch {
        return;
      }
    };
  }, [
    isPlaying,
    pausePlayback,
    playbackDurationSeconds,
    playbackTimeSeconds,
    playPlayback,
    seekBy,
    session,
    stopPlayback,
  ]);
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
