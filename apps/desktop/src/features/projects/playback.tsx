/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../lib/api";
import type { StemControlState } from "./projectPlaybackState";

type PendingTransition = {
  id: number;
  signature: string;
  shouldPlay: boolean;
  targetTime: number;
};

export type ProjectPlaybackSession = {
  projectId: string;
  projectName: string;
  stageTitle: string;
  stageSummary: string;
  selectedPlaybackArtifactId: string | null;
  isStemPlayback: boolean;
  visibleStemArtifactIds: string[];
  stemControls: Record<string, StemControlState>;
  durationHintSeconds: number;
};

type PlaybackContextValue = {
  session: ProjectPlaybackSession | null;
  playbackTimeSeconds: number;
  playbackDurationSeconds: number;
  isPlaying: boolean;
  registerProjectSession: (session: ProjectPlaybackSession) => void;
  togglePlayback: () => Promise<void>;
  playPlayback: () => Promise<void>;
  pausePlayback: () => void;
  stopPlayback: () => void;
  dismissSession: () => void;
  seekBy: (secondsDelta: number) => void;
  seekTo: (timeSeconds: number) => void;
};

const PlaybackContext = createContext<PlaybackContextValue | null>(null);
const SEEK_TOLERANCE_SECONDS = 0.001;

function playbackSignature(session: ProjectPlaybackSession | null) {
  if (!session) {
    return "none";
  }

  const activeSignature = session.isStemPlayback
    ? `stems:${session.visibleStemArtifactIds.join(",")}`
    : `primary:${session.selectedPlaybackArtifactId ?? "none"}`;
  return `${session.projectId}:${activeSignature}`;
}

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'input, textarea, select, button, a, summary, [contenteditable="true"], [role="button"]',
    ),
  );
}

function clampTime(value: number, duration: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return Math.max(0, value);
  }
  return Math.max(0, Math.min(duration, value));
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const primaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const stemAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const pendingTransitionRef = useRef<PendingTransition | null>(null);
  const transitionCounterRef = useRef(0);
  const sessionRef = useRef<ProjectPlaybackSession | null>(null);
  const playbackTimeSecondsRef = useRef(0);
  const playbackDurationSecondsRef = useRef(0);
  const isPlayingRef = useRef(false);
  const [session, setSession] = useState<ProjectPlaybackSession | null>(null);
  const [playbackTimeSeconds, setPlaybackTimeSeconds] = useState(0);
  const [playbackDurationSeconds, setPlaybackDurationSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    playbackTimeSecondsRef.current = playbackTimeSeconds;
  }, [playbackTimeSeconds]);

  useEffect(() => {
    playbackDurationSecondsRef.current = playbackDurationSeconds;
  }, [playbackDurationSeconds]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  function setStemAudioRef(artifactId: string, element: HTMLAudioElement | null) {
    if (element) {
      stemAudioRefs.current[artifactId] = element;
      return;
    }
    delete stemAudioRefs.current[artifactId];
  }

  function getStemElements(artifactIds: string[]) {
    return artifactIds
      .map((artifactId) => stemAudioRefs.current[artifactId])
      .filter(Boolean) as HTMLAudioElement[];
  }

  function getRenderedMediaElements(targetSession = sessionRef.current) {
    if (!targetSession) {
      return [] as HTMLAudioElement[];
    }

    return [
      ...(primaryAudioRef.current ? [primaryAudioRef.current] : []),
      ...getStemElements(targetSession.visibleStemArtifactIds),
    ];
  }

  function getActiveMediaElements(targetSession = sessionRef.current) {
    if (!targetSession) {
      return [] as HTMLAudioElement[];
    }

    if (targetSession.isStemPlayback) {
      return getStemElements(targetSession.visibleStemArtifactIds);
    }

    return primaryAudioRef.current && targetSession.selectedPlaybackArtifactId
      ? [primaryAudioRef.current]
      : [];
  }

  function applyStemVolumes(targetSession = sessionRef.current) {
    if (!targetSession) {
      return;
    }

    const soloedStemIds = targetSession.visibleStemArtifactIds.filter(
      (artifactId) => targetSession.stemControls[artifactId]?.solo,
    );
    const hasSolo = soloedStemIds.length > 0;
    targetSession.visibleStemArtifactIds.forEach((artifactId) => {
      const element = stemAudioRefs.current[artifactId];
      if (!element) {
        return;
      }

      const state = targetSession.stemControls[artifactId] ?? {
        muted: false,
        solo: false,
      };
      element.volume = hasSolo ? (state.solo ? 1 : 0) : state.muted ? 0 : 1;
    });
  }

  function readMasterTime(targetSession = sessionRef.current) {
    return getActiveMediaElements(targetSession)[0]?.currentTime ?? playbackTimeSecondsRef.current;
  }

  function updateDurationFromActiveMedia(targetSession = sessionRef.current) {
    const duration = getActiveMediaElements(targetSession)[0]?.duration;
    if (Number.isFinite(duration) && duration >= 0) {
      setPlaybackDurationSeconds(duration);
    } else if (targetSession) {
      setPlaybackDurationSeconds(targetSession.durationHintSeconds || 0);
    }
  }

  function clearPendingTransition() {
    pendingTransitionRef.current = null;
  }

  function tryCompletePendingTransition() {
    const pendingTransition = pendingTransitionRef.current;
    const targetSession = sessionRef.current;
    if (!pendingTransition || !targetSession) {
      return;
    }

    const targetElements = getActiveMediaElements(targetSession);
    if (!targetElements.length) {
      return;
    }

    const ready = targetElements.every(
      (element) =>
        element.readyState >= HTMLMediaElement.HAVE_METADATA ||
        (Number.isFinite(element.duration) && element.duration > 0),
    );
    if (!ready) {
      return;
    }

    const nextTime = clampTime(
      pendingTransition.targetTime,
      targetElements[0]?.duration ?? playbackDurationSecondsRef.current,
    );
    let awaitingSeekCompletion = false;
    targetElements.forEach((element) => {
      if (Math.abs(element.currentTime - nextTime) > SEEK_TOLERANCE_SECONDS) {
        element.currentTime = nextTime;
        awaitingSeekCompletion = true;
        return;
      }
      if (element.seeking) {
        awaitingSeekCompletion = true;
      }
    });
    applyStemVolumes(targetSession);
    setPlaybackTimeSeconds(nextTime);
    updateDurationFromActiveMedia(targetSession);

    if (awaitingSeekCompletion) {
      return;
    }

    const transitionId = pendingTransition.id;
    const transitionSignature = pendingTransition.signature;
    clearPendingTransition();

    if (!pendingTransition.shouldPlay) {
      targetElements.forEach((element) => element.pause());
      setIsPlaying(false);
      return;
    }

    void Promise.allSettled(
      targetElements.map((element) => Promise.resolve(element.play())),
    ).then((results) => {
      if (pendingTransitionRef.current?.id === transitionId) {
        return;
      }
      if (playbackSignature(sessionRef.current) !== transitionSignature) {
        return;
      }
      setIsPlaying(results.some((result) => result.status === "fulfilled"));
    });
  }

  const pausePlayback = useCallback(() => {
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.shouldPlay = false;
    }

    getActiveMediaElements().forEach((element) => element.pause());
    setIsPlaying(false);
  }, []);

  const playPlayback = useCallback(async () => {
    const targetSession = sessionRef.current;
    if (!targetSession) {
      return;
    }

    tryCompletePendingTransition();

    const activeElements = getActiveMediaElements(targetSession);
    if (!activeElements.length) {
      return;
    }

    const masterTime = readMasterTime(targetSession);
    activeElements.forEach((element) => {
      if (Math.abs(element.currentTime - masterTime) > SEEK_TOLERANCE_SECONDS) {
        element.currentTime = masterTime;
      }
    });
    applyStemVolumes(targetSession);

    const results = await Promise.allSettled(
      activeElements.map((element) => Promise.resolve(element.play())),
    );
    setIsPlaying(results.some((result) => result.status === "fulfilled"));
  }, []);

  const togglePlayback = useCallback(async () => {
    if (isPlayingRef.current) {
      pausePlayback();
      return;
    }
    await playPlayback();
  }, [pausePlayback, playPlayback]);

  const seekTo = useCallback((timeSeconds: number) => {
    const nextTime = clampTime(timeSeconds, playbackDurationSecondsRef.current);
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.targetTime = nextTime;
    }

    getActiveMediaElements().forEach((element) => {
      element.currentTime = nextTime;
    });
    setPlaybackTimeSeconds(nextTime);
  }, []);

  const seekBy = useCallback(
    (secondsDelta: number) => {
      seekTo(readMasterTime() + secondsDelta);
    },
    [seekTo],
  );

  const stopPlayback = useCallback(() => {
    clearPendingTransition();
    getRenderedMediaElements().forEach((element) => {
      element.pause();
      element.currentTime = 0;
    });
    setPlaybackTimeSeconds(0);
    setIsPlaying(false);
    updateDurationFromActiveMedia();
  }, []);

  const dismissSession = useCallback(() => {
    stopPlayback();
    setSession(null);
    sessionRef.current = null;
    setPlaybackDurationSeconds(0);
  }, [stopPlayback]);

  const registerProjectSession = useCallback((nextSession: ProjectPlaybackSession) => {
    const previousSession = sessionRef.current;
    const previousSignature = playbackSignature(previousSession);
    const nextSignature = playbackSignature(nextSession);

    if (previousSession && previousSession.projectId !== nextSession.projectId) {
      clearPendingTransition();
      getRenderedMediaElements(previousSession).forEach((element) => {
        element.pause();
        element.currentTime = 0;
      });
      setPlaybackTimeSeconds(0);
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      setIsPlaying(false);
    } else if (previousSession && previousSignature !== nextSignature) {
      const nextTime = readMasterTime(previousSession);
      const shouldPlay = isPlayingRef.current;
      if (shouldPlay) {
        getActiveMediaElements(previousSession).forEach((element) => element.pause());
      }
      pendingTransitionRef.current = {
        id: ++transitionCounterRef.current,
        signature: nextSignature,
        shouldPlay,
        targetTime: nextTime,
      };
      setPlaybackTimeSeconds(nextTime);
    } else if (!previousSession) {
      setPlaybackTimeSeconds(0);
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      setIsPlaying(false);
    }

    sessionRef.current = nextSession;
    setSession(nextSession);
  }, []);

  useEffect(() => {
    applyStemVolumes(session);
    tryCompletePendingTransition();
    updateDurationFromActiveMedia(session);
  }, [session]);

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
  }, [togglePlayback]);

  const value = useMemo<PlaybackContextValue>(
    () => ({
      session,
      playbackTimeSeconds,
      playbackDurationSeconds,
      isPlaying,
      registerProjectSession,
      togglePlayback,
      playPlayback,
      pausePlayback,
      stopPlayback,
      dismissSession,
      seekBy,
      seekTo,
    }),
    [
      dismissSession,
      isPlaying,
      pausePlayback,
      playbackDurationSeconds,
      playbackTimeSeconds,
      playPlayback,
      registerProjectSession,
      seekBy,
      seekTo,
      session,
      stopPlayback,
      togglePlayback,
    ],
  );

  return (
    <PlaybackContext.Provider value={value}>
      {children}
      <audio
        ref={primaryAudioRef}
        src={
          session && !session.isStemPlayback && session.selectedPlaybackArtifactId
            ? api.streamArtifactUrl(session.selectedPlaybackArtifactId)
            : undefined
        }
        preload="metadata"
        className="player player--hidden"
        onTimeUpdate={(event) => {
          if (!sessionRef.current || sessionRef.current.isStemPlayback) {
            return;
          }
          setPlaybackTimeSeconds(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={() => {
          updateDurationFromActiveMedia();
          tryCompletePendingTransition();
        }}
        onDurationChange={() => {
          updateDurationFromActiveMedia();
          tryCompletePendingTransition();
        }}
        onCanPlay={tryCompletePendingTransition}
        onSeeked={tryCompletePendingTransition}
        onEnded={() => {
          if (!sessionRef.current || sessionRef.current.isStemPlayback) {
            return;
          }
          setIsPlaying(false);
        }}
      />
      {session?.visibleStemArtifactIds.map((artifactId) => (
        <audio
          key={artifactId}
          ref={(element) => setStemAudioRef(artifactId, element)}
          src={api.streamArtifactUrl(artifactId)}
          preload="metadata"
          className="player player--hidden"
          onTimeUpdate={(event) => {
            if (!sessionRef.current || !sessionRef.current.isStemPlayback) {
              return;
            }
            if (sessionRef.current.visibleStemArtifactIds[0] !== artifactId) {
              return;
            }
            setPlaybackTimeSeconds(event.currentTarget.currentTime);
          }}
          onLoadedMetadata={() => {
            if (sessionRef.current?.visibleStemArtifactIds[0] === artifactId) {
              updateDurationFromActiveMedia();
            }
            tryCompletePendingTransition();
          }}
          onDurationChange={() => {
            if (sessionRef.current?.visibleStemArtifactIds[0] === artifactId) {
              updateDurationFromActiveMedia();
            }
            tryCompletePendingTransition();
          }}
          onCanPlay={tryCompletePendingTransition}
          onSeeked={tryCompletePendingTransition}
          onEnded={() => {
            if (!sessionRef.current || !sessionRef.current.isStemPlayback) {
              return;
            }
            if (sessionRef.current.visibleStemArtifactIds[0] !== artifactId) {
              return;
            }
            setIsPlaying(false);
          }}
        />
      ))}
    </PlaybackContext.Provider>
  );
}

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) {
    throw new Error("usePlayback must be used within a PlaybackProvider.");
  }
  return context;
}
