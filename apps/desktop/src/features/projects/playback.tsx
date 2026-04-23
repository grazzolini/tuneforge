import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../lib/api";
import { useStableCallback } from "../../lib/useStableCallback";
import {
  PlaybackContext,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./playback-context";
import {
  clearPersistedPlaybackState,
  readPersistedPlaybackState,
  writePersistedPlaybackState,
} from "./playbackPersistence";
import {
  PRIMARY_MEDIA_KEY,
  SEEK_TOLERANCE_SECONDS,
  clampTime,
  playbackSignature,
  type PendingTransition,
  type StemPlaybackState,
} from "./playbackUtils";
import {
  clearStemClock as clearStemClockFrame,
  disconnectStemGains,
  getStemPlaybackTime as readStemPlaybackTime,
  stopStemSources as stopStemPlaybackSources,
} from "./stemPlaybackClock";
import {
  loadStemBuffer as loadStemPlaybackBuffer,
  loadStemBuffers,
} from "./stemPlaybackBuffers";
import { useMediaSessionControls, useSpacebarPlaybackShortcut } from "./playbackEffects";

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const restoredPlaybackState = useRef(readPersistedPlaybackState()).current;
  const primaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const stemAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const stemAudioContextRef = useRef<AudioContext | null>(null);
  const stemClockBlockedRef = useRef(false);
  const stemBufferCacheRef = useRef(new Map<string, Promise<AudioBuffer>>());
  const stemPlaybackRef = useRef<StemPlaybackState | null>(null);
  const pendingTransitionRef = useRef<PendingTransition | null>(
    restoredPlaybackState
        ? {
          id: 1,
          signature: playbackSignature(restoredPlaybackState.session),
          shouldPlay: restoredPlaybackState.isPlaying,
          targetTime: restoredPlaybackState.playbackTimeSeconds,
          awaitingLoadKeys: [],
          awaitingSeekKeys: [],
          forceSeekKeys: [],
        }
      : null,
  );
  const transitionCounterRef = useRef(restoredPlaybackState ? 1 : 0);
  const sessionRef = useRef<ProjectPlaybackSession | null>(restoredPlaybackState?.session ?? null);
  const playbackTimeSecondsRef = useRef(restoredPlaybackState?.playbackTimeSeconds ?? 0);
  const playbackDurationSecondsRef = useRef(
    restoredPlaybackState?.session.durationHintSeconds ?? 0,
  );
  const isPlayingRef = useRef(restoredPlaybackState?.isPlaying ?? false);
  const [session, setSession] = useState<ProjectPlaybackSession | null>(
    restoredPlaybackState?.session ?? null,
  );
  const [playbackTimeSeconds, setPlaybackTimeSeconds] = useState(
    restoredPlaybackState?.playbackTimeSeconds ?? 0,
  );
  const [playbackDurationSeconds, setPlaybackDurationSeconds] = useState(
    restoredPlaybackState?.session.durationHintSeconds ?? 0,
  );
  const [isPlaying, setIsPlaying] = useState(restoredPlaybackState?.isPlaying ?? false);

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

  useEffect(() => {
    if (!session) {
      clearPersistedPlaybackState();
      return;
    }

    writePersistedPlaybackState({
      session,
      playbackTimeSeconds,
      isPlaying,
    });
  }, [isPlaying, playbackTimeSeconds, session]);

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

  const getAudioContextConstructor = useCallback(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return (
      window.AudioContext ??
      (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext ??
      null
    );
  }, []);

  const canUseStemClock = useCallback(
    () =>
      !stemClockBlockedRef.current &&
      typeof fetch === "function" &&
      Boolean(getAudioContextConstructor()),
    [getAudioContextConstructor],
  );

  function syncStemElementTimes(artifactIds: string[], nextTime: number) {
    artifactIds.forEach((artifactId) => {
      const element = stemAudioRefs.current[artifactId];
      if (!element) {
        return;
      }

      try {
        if (Math.abs(element.currentTime - nextTime) > SEEK_TOLERANCE_SECONDS) {
          element.currentTime = nextTime;
        }
      } catch {
        return;
      }
    });
  }

  const getStemAudioContext = useCallback(() => {
    if (stemAudioContextRef.current) {
      return stemAudioContextRef.current;
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      return null;
    }

    const context = new AudioContextConstructor();
    stemAudioContextRef.current = context;
    return context;
  }, [getAudioContextConstructor]);

  const activateStemPlayback = useCallback(async () => {
    if (!canUseStemClock()) {
      return;
    }

    const context = getStemAudioContext();
    if (!context || context.state === "running") {
      return;
    }

    // WebKit on Linux is stricter about user-gesture timing for AudioContext resume.
    try {
      await context.resume();
    } catch {
      stemClockBlockedRef.current = true;
      return;
    }

    const contextState = (context as AudioContext).state;
    if (contextState !== "running") {
      stemClockBlockedRef.current = true;
      return;
    }
  }, [canUseStemClock, getStemAudioContext]);

  const loadStemBuffer = useStableCallback(async function loadStemBuffer(artifactId: string) {
    return loadStemPlaybackBuffer(artifactId, {
      bufferCache: stemBufferCacheRef.current,
      getStemAudioContext,
    });
  });

  const getStemBuffers = useStableCallback(async function getStemBuffers(artifactIds: string[]) {
    return loadStemBuffers(artifactIds, {
      bufferCache: stemBufferCacheRef.current,
      getStemAudioContext,
    });
  });

  const getStemPlaybackTime = useStableCallback(function getStemPlaybackTime(
    targetPlaybackState: StemPlaybackState | null = stemPlaybackRef.current,
  ) {
    return readStemPlaybackTime(targetPlaybackState, playbackTimeSecondsRef.current);
  });

  const clearStemClock = useStableCallback(function clearStemClock(
    targetPlaybackState: StemPlaybackState | null = stemPlaybackRef.current,
  ) {
    clearStemClockFrame(targetPlaybackState);
  });

  const finalizeStemPlaybackEnded = useStableCallback(function finalizeStemPlaybackEnded(targetPlaybackState: StemPlaybackState) {
    clearStemClock(targetPlaybackState);
    targetPlaybackState.isPlaying = false;
    targetPlaybackState.offsetSeconds = targetPlaybackState.durationSeconds;
    targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
    targetPlaybackState.sources = {};
    syncStemElementTimes(Object.keys(targetPlaybackState.gains), targetPlaybackState.durationSeconds);

    if (stemPlaybackRef.current !== targetPlaybackState) {
      return;
    }

    setPlaybackTimeSeconds(targetPlaybackState.durationSeconds);
    setIsPlaying(false);
  });

  const scheduleStemClock = useStableCallback(function scheduleStemClock(
    targetPlaybackState: StemPlaybackState | null = stemPlaybackRef.current,
  ) {
    if (typeof window === "undefined" || !targetPlaybackState) {
      return;
    }

    clearStemClock(targetPlaybackState);
    const tick = () => {
      const currentPlaybackState = stemPlaybackRef.current;
      if (
        !currentPlaybackState ||
        currentPlaybackState !== targetPlaybackState ||
        !currentPlaybackState.isPlaying
      ) {
        if (currentPlaybackState === targetPlaybackState) {
          currentPlaybackState.clockFrameId = null;
        }
        return;
      }

      const nextTime = getStemPlaybackTime(currentPlaybackState);
      setPlaybackTimeSeconds(nextTime);
      if (nextTime >= currentPlaybackState.durationSeconds) {
        finalizeStemPlaybackEnded(currentPlaybackState);
        return;
      }

      currentPlaybackState.clockFrameId = window.requestAnimationFrame(tick);
    };

    targetPlaybackState.clockFrameId = window.requestAnimationFrame(tick);
  });

  const stopStemSources = useStableCallback(function stopStemSources(
    targetPlaybackState: StemPlaybackState | null = stemPlaybackRef.current,
    preserveOffset: boolean = true,
  ) {
    return stopStemPlaybackSources(targetPlaybackState, {
      fallbackTimeSeconds: playbackTimeSecondsRef.current,
      preserveOffset,
      syncStemElementTimes,
    });
  });

  const disposeStemPlaybackState = useStableCallback(function disposeStemPlaybackState() {
    const targetPlaybackState = stemPlaybackRef.current;
    if (!targetPlaybackState) {
      return;
    }

    stopStemSources(targetPlaybackState, true);
    disconnectStemGains(targetPlaybackState);
    stemPlaybackRef.current = null;
  });

  const prepareStemPlaybackState = useStableCallback(async function prepareStemPlaybackState(targetSession: ProjectPlaybackSession) {
    const signature = playbackSignature(targetSession);
    const existingPlaybackState = stemPlaybackRef.current;
    if (existingPlaybackState?.signature === signature) {
      return existingPlaybackState;
    }

    disposeStemPlaybackState();

    const context = getStemAudioContext();
    if (!context) {
      return null;
    }

    const buffers = await getStemBuffers(targetSession.visibleStemArtifactIds);
    const durationSeconds = Math.max(
      targetSession.durationHintSeconds || 0,
      ...Object.values(buffers).map((buffer) => buffer.duration || 0),
    );
    const gains = Object.fromEntries(
      targetSession.visibleStemArtifactIds.map((artifactId) => {
        const gainNode = context.createGain();
        gainNode.connect(context.destination);
        return [artifactId, gainNode] as const;
      }),
    );
    const nextPlaybackState: StemPlaybackState = {
      signature,
      context,
      durationSeconds,
      startedAtContextTime: context.currentTime,
      offsetSeconds: clampTime(playbackTimeSecondsRef.current, durationSeconds),
      isPlaying: false,
      buffers,
      sources: {},
      gains,
      clockFrameId: null,
    };
    stemPlaybackRef.current = nextPlaybackState;
    syncStemElementTimes(targetSession.visibleStemArtifactIds, nextPlaybackState.offsetSeconds);
    return nextPlaybackState;
  });

  const startStemPlayback = useStableCallback(async function startStemPlayback(targetSession: ProjectPlaybackSession, timeSeconds: number) {
    if (!canUseStemClock()) {
      return false;
    }

    const targetPlaybackState = await prepareStemPlaybackState(targetSession);
    if (!targetPlaybackState) {
      return false;
    }

    if (stemPlaybackRef.current !== targetPlaybackState) {
      return false;
    }

    try {
      await targetPlaybackState.context.resume();
    } catch {
      stemClockBlockedRef.current = true;
      disposeStemPlaybackState();
      setIsPlaying(false);
      return false;
    }
    if (targetPlaybackState.context.state !== "running") {
      stemClockBlockedRef.current = true;
      disposeStemPlaybackState();
      setIsPlaying(false);
      return false;
    }
    stopStemSources(targetPlaybackState, false);

    const nextTime = clampTime(timeSeconds, targetPlaybackState.durationSeconds);
    if (nextTime >= targetPlaybackState.durationSeconds) {
      targetPlaybackState.offsetSeconds = targetPlaybackState.durationSeconds;
      syncStemElementTimes(targetSession.visibleStemArtifactIds, targetPlaybackState.durationSeconds);
      setPlaybackTimeSeconds(targetPlaybackState.durationSeconds);
      setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
      setIsPlaying(false);
      return false;
    }

    const nextSources = Object.fromEntries(
      targetSession.visibleStemArtifactIds.map((artifactId) => {
        const sourceNode = targetPlaybackState.context.createBufferSource();
        sourceNode.buffer = targetPlaybackState.buffers[artifactId] ?? null;
        sourceNode.connect(targetPlaybackState.gains[artifactId]);
        sourceNode.onended = () => {
          const currentPlaybackState = stemPlaybackRef.current;
          if (!currentPlaybackState || currentPlaybackState !== targetPlaybackState) {
            return;
          }

          delete currentPlaybackState.sources[artifactId];
          if (Object.keys(currentPlaybackState.sources).length > 0) {
            return;
          }
          finalizeStemPlaybackEnded(currentPlaybackState);
        };
        return [artifactId, sourceNode] as const;
      }),
    );

    targetPlaybackState.sources = nextSources;
    targetPlaybackState.offsetSeconds = nextTime;
    targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
    targetPlaybackState.isPlaying = true;
    syncStemElementTimes(targetSession.visibleStemArtifactIds, nextTime);
    applyStemVolumes(targetSession);

    Object.values(nextSources).forEach((sourceNode) => sourceNode.start(0, nextTime));

    setPlaybackTimeSeconds(nextTime);
    setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
    setIsPlaying(true);
    scheduleStemClock(targetPlaybackState);
    return true;
  });

  const getRenderedMediaElements = useStableCallback(function getRenderedMediaElements(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    if (!targetSession) {
      return [] as HTMLAudioElement[];
    }

    return [
      ...(primaryAudioRef.current ? [primaryAudioRef.current] : []),
      ...getStemElements(targetSession.visibleStemArtifactIds),
    ];
  });

  const getActiveMediaElements = useStableCallback(function getActiveMediaElements(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    if (!targetSession) {
      return [] as HTMLAudioElement[];
    }

    if (targetSession.isStemPlayback) {
      return getStemElements(targetSession.visibleStemArtifactIds);
    }

    return primaryAudioRef.current && targetSession.selectedPlaybackArtifactId
      ? [primaryAudioRef.current]
      : [];
  });

  const getActiveMediaKeys = useStableCallback(function getActiveMediaKeys(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    if (!targetSession) {
      return [] as string[];
    }

    if (targetSession.isStemPlayback) {
      return targetSession.visibleStemArtifactIds.filter((artifactId) =>
        Boolean(stemAudioRefs.current[artifactId]),
      );
    }

    return primaryAudioRef.current && targetSession.selectedPlaybackArtifactId
      ? [PRIMARY_MEDIA_KEY]
      : [];
  });

  const applyStemVolumes = useStableCallback(function applyStemVolumes(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    if (!targetSession) {
      return;
    }

    const soloedStemIds = targetSession.visibleStemArtifactIds.filter(
      (artifactId) => targetSession.stemControls[artifactId]?.solo,
    );
    const hasSolo = soloedStemIds.length > 0;
    targetSession.visibleStemArtifactIds.forEach((artifactId) => {
      const element = stemAudioRefs.current[artifactId];
      const state = targetSession.stemControls[artifactId] ?? {
        muted: false,
        solo: false,
      };
      const volume = hasSolo ? (state.solo ? 1 : 0) : state.muted ? 0 : 1;

      if (element) {
        element.volume = volume;
      }

      const targetPlaybackState = stemPlaybackRef.current;
      if (
        targetPlaybackState &&
        targetPlaybackState.signature === playbackSignature(targetSession)
      ) {
        const gainNode = targetPlaybackState.gains[artifactId];
        if (gainNode) {
          gainNode.gain.value = volume;
        }
      }
    });
  });

  const readMasterTime = useStableCallback(function readMasterTime(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    const pendingTransition = pendingTransitionRef.current;
    if (
      pendingTransition &&
      playbackSignature(targetSession) === pendingTransition.signature
    ) {
      return pendingTransition.targetTime;
    }

    if (targetSession?.isStemPlayback) {
      const targetPlaybackState = stemPlaybackRef.current;
      if (
        targetPlaybackState &&
        targetPlaybackState.signature === playbackSignature(targetSession)
      ) {
        return getStemPlaybackTime(targetPlaybackState);
      }
    }

    return getActiveMediaElements(targetSession)[0]?.currentTime ?? playbackTimeSecondsRef.current;
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function persistCurrentPlaybackState() {
      const activeSession = sessionRef.current;
      if (!activeSession) {
        clearPersistedPlaybackState();
        return;
      }

      const activeElements = activeSession.isStemPlayback
        ? getStemElements(activeSession.visibleStemArtifactIds)
        : primaryAudioRef.current && activeSession.selectedPlaybackArtifactId
          ? [primaryAudioRef.current]
          : [];

      writePersistedPlaybackState({
        session: activeSession,
        playbackTimeSeconds:
          readMasterTime(activeSession) ??
          activeElements[0]?.currentTime ??
          playbackTimeSecondsRef.current,
        isPlaying: isPlayingRef.current,
      });
    }

    window.addEventListener("pagehide", persistCurrentPlaybackState);
    window.addEventListener("beforeunload", persistCurrentPlaybackState);
    return () => {
      window.removeEventListener("pagehide", persistCurrentPlaybackState);
      window.removeEventListener("beforeunload", persistCurrentPlaybackState);
    };
  }, [readMasterTime]);

  const updateDurationFromActiveMedia = useStableCallback(function updateDurationFromActiveMedia(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    if (targetSession?.isStemPlayback) {
      const targetPlaybackState = stemPlaybackRef.current;
      if (
        targetPlaybackState &&
        targetPlaybackState.signature === playbackSignature(targetSession)
      ) {
        setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
        return;
      }

      const renderedStemDuration = getStemElements(targetSession.visibleStemArtifactIds).reduce(
        (maxDuration, element) =>
          Number.isFinite(element.duration) ? Math.max(maxDuration, element.duration) : maxDuration,
        0,
      );
      if (renderedStemDuration > 0) {
        setPlaybackDurationSeconds(renderedStemDuration);
        return;
      }
    }

    const duration = getActiveMediaElements(targetSession)[0]?.duration;
    if (Number.isFinite(duration) && duration >= 0) {
      setPlaybackDurationSeconds(duration);
    } else if (targetSession) {
      setPlaybackDurationSeconds(targetSession.durationHintSeconds || 0);
    }
  });

  const clearPendingTransition = useStableCallback(function clearPendingTransition() {
    pendingTransitionRef.current = null;
  });

  const markPendingSeekComplete = useStableCallback(function markPendingSeekComplete(mediaKey: string, element: HTMLAudioElement) {
    const pendingTransition = pendingTransitionRef.current;
    if (!pendingTransition) {
      return;
    }
    const expectedTime = clampTime(
      pendingTransition.targetTime,
      element.duration ?? playbackDurationSecondsRef.current,
    );
    if (Math.abs(element.currentTime - expectedTime) > SEEK_TOLERANCE_SECONDS) {
      return;
    }
    pendingTransition.awaitingSeekKeys = pendingTransition.awaitingSeekKeys.filter(
      (key) => key !== mediaKey,
    );
  });

  const markPendingLoadComplete = useStableCallback(function markPendingLoadComplete(mediaKey: string) {
    const pendingTransition = pendingTransitionRef.current;
    if (!pendingTransition) {
      return;
    }
    pendingTransition.awaitingLoadKeys = pendingTransition.awaitingLoadKeys.filter(
      (key) => key !== mediaKey,
    );
  });

  const tryCompletePendingTransition = useStableCallback(function tryCompletePendingTransition() {
    const pendingTransition = pendingTransitionRef.current;
    const targetSession = sessionRef.current;
    if (!pendingTransition || !targetSession) {
      return;
    }

    if (targetSession.isStemPlayback && canUseStemClock()) {
      void (async () => {
        const activePendingTransition = pendingTransitionRef.current;
        const activeSession = sessionRef.current;
        if (
          !activePendingTransition ||
          !activeSession ||
          activePendingTransition.id !== pendingTransition.id ||
          playbackSignature(activeSession) !== pendingTransition.signature
        ) {
          return;
        }

        const targetPlaybackState = await prepareStemPlaybackState(activeSession);
        if (!targetPlaybackState) {
          return;
        }

        const latestPendingTransition = pendingTransitionRef.current;
        const latestSession = sessionRef.current;
        if (
          !latestPendingTransition ||
          !latestSession ||
          latestPendingTransition.id !== pendingTransition.id ||
          playbackSignature(latestSession) !== pendingTransition.signature
        ) {
          return;
        }

        const nextTime = clampTime(
          latestPendingTransition.targetTime,
          targetPlaybackState.durationSeconds,
        );
        latestPendingTransition.awaitingLoadKeys = [];
        latestPendingTransition.awaitingSeekKeys = [];
        latestPendingTransition.forceSeekKeys = [];
        targetPlaybackState.offsetSeconds = nextTime;
        syncStemElementTimes(latestSession.visibleStemArtifactIds, nextTime);
        applyStemVolumes(latestSession);
        setPlaybackTimeSeconds(nextTime);
        setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);

        clearPendingTransition();

        if (!latestPendingTransition.shouldPlay) {
          stopStemSources(targetPlaybackState, false);
          setIsPlaying(false);
          return;
        }

        const started = await startStemPlayback(latestSession, nextTime);
        if (started) {
          return;
        }

        const fallbackElements = getActiveMediaElements(latestSession);
        if (!fallbackElements.length) {
          return;
        }

        fallbackElements.forEach((element) => {
          if (Math.abs(element.currentTime - nextTime) > SEEK_TOLERANCE_SECONDS) {
            element.currentTime = nextTime;
          }
        });

        const results = await Promise.allSettled(
          fallbackElements.map((element) => Promise.resolve(element.play())),
        );
        setIsPlaying(results.some((result) => result.status === "fulfilled"));
      })();
      return;
    }

    const targetElements = getActiveMediaElements(targetSession);
    const targetKeys = getActiveMediaKeys(targetSession);
    if (!targetElements.length) {
      return;
    }

    const minimumReadyState =
      pendingTransition.shouldPlay && targetSession.isStemPlayback
        ? HTMLMediaElement.HAVE_FUTURE_DATA
        : HTMLMediaElement.HAVE_METADATA;
    const ready = targetElements.every((element) => {
      if (element.readyState >= minimumReadyState) {
        return true;
      }
      return (
        !pendingTransition.shouldPlay &&
        Number.isFinite(element.duration) &&
        element.duration > 0
      );
    });
    if (!ready) {
      return;
    }

    const nextTime = clampTime(
      pendingTransition.targetTime,
      targetElements[0]?.duration ?? playbackDurationSecondsRef.current,
    );
    const activeKeySet = new Set(targetKeys);
    const awaitingLoadKeys = pendingTransition.awaitingLoadKeys.filter((key) =>
      activeKeySet.has(key),
    );
    pendingTransition.awaitingLoadKeys = awaitingLoadKeys;
    if (awaitingLoadKeys.length > 0) {
      return;
    }
    const awaitingSeekKeys = pendingTransition.awaitingSeekKeys.filter((key) =>
      activeKeySet.has(key),
    );
    const forceSeekKeys = pendingTransition.forceSeekKeys.filter((key) =>
      activeKeySet.has(key),
    );
    targetElements.forEach((element, index) => {
      const mediaKey = targetKeys[index];
      if (!mediaKey) {
        return;
      }
      const shouldForceSeek = forceSeekKeys.includes(mediaKey);
      if (shouldForceSeek) {
        element.currentTime = nextTime;
        if (!awaitingSeekKeys.includes(mediaKey)) {
          awaitingSeekKeys.push(mediaKey);
        }
        return;
      }
      if (Math.abs(element.currentTime - nextTime) > SEEK_TOLERANCE_SECONDS) {
        element.currentTime = nextTime;
        if (!awaitingSeekKeys.includes(mediaKey)) {
          awaitingSeekKeys.push(mediaKey);
        }
        return;
      }
      if (element.seeking && !awaitingSeekKeys.includes(mediaKey)) {
        awaitingSeekKeys.push(mediaKey);
      }
    });
    pendingTransition.awaitingSeekKeys = awaitingSeekKeys;
    pendingTransition.forceSeekKeys = forceSeekKeys.filter(
      (mediaKey) => !awaitingSeekKeys.includes(mediaKey),
    );
    applyStemVolumes(targetSession);
    setPlaybackTimeSeconds(nextTime);
    updateDurationFromActiveMedia(targetSession);

    if (awaitingSeekKeys.length > 0) {
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
  });

  const pausePlayback = useCallback(() => {
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.shouldPlay = false;
    }

    if (sessionRef.current?.isStemPlayback && canUseStemClock()) {
      const targetPlaybackState = stemPlaybackRef.current;
      if (targetPlaybackState) {
        const nextTime = stopStemSources(targetPlaybackState, true);
        setPlaybackTimeSeconds(nextTime);
      }
      setIsPlaying(false);
      return;
    }

    getActiveMediaElements().forEach((element) => element.pause());
    setIsPlaying(false);
  }, [
    canUseStemClock,
    getActiveMediaElements,
    stopStemSources,
  ]);

  const playPlayback = useCallback(async () => {
    const targetSession = sessionRef.current;
    if (!targetSession) {
      return;
    }

    tryCompletePendingTransition();

    if (targetSession.isStemPlayback && canUseStemClock()) {
      const masterTime = readMasterTime(targetSession);
      const started = await startStemPlayback(targetSession, masterTime);
      if (started) {
        return;
      }
    }

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
  }, [
    applyStemVolumes,
    canUseStemClock,
    getActiveMediaElements,
    readMasterTime,
    startStemPlayback,
    tryCompletePendingTransition,
  ]);

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

    if (sessionRef.current?.isStemPlayback && canUseStemClock()) {
      syncStemElementTimes(sessionRef.current.visibleStemArtifactIds, nextTime);
      const targetPlaybackState = stemPlaybackRef.current;
      if (targetPlaybackState) {
        targetPlaybackState.offsetSeconds = clampTime(nextTime, targetPlaybackState.durationSeconds);
        targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
        if (targetPlaybackState.isPlaying) {
          void startStemPlayback(sessionRef.current, nextTime);
        }
      }
      setPlaybackTimeSeconds(nextTime);
      return;
    }

    getActiveMediaElements().forEach((element) => {
      element.currentTime = nextTime;
    });
    setPlaybackTimeSeconds(nextTime);
  }, [canUseStemClock, getActiveMediaElements, startStemPlayback]);

  const seekBy = useCallback(
    (secondsDelta: number) => {
      seekTo(readMasterTime() + secondsDelta);
    },
    [readMasterTime, seekTo],
  );

  const stopPlayback = useCallback(() => {
    clearPendingTransition();
    if (stemPlaybackRef.current) {
      stopStemSources(stemPlaybackRef.current, false);
      stemPlaybackRef.current.offsetSeconds = 0;
      syncStemElementTimes(Object.keys(stemPlaybackRef.current.gains), 0);
    }
    getRenderedMediaElements().forEach((element) => {
      element.pause();
      element.currentTime = 0;
    });
    setPlaybackTimeSeconds(0);
    setIsPlaying(false);
    updateDurationFromActiveMedia();
  }, [
    clearPendingTransition,
    getRenderedMediaElements,
    stopStemSources,
    updateDurationFromActiveMedia,
  ]);

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
      disposeStemPlaybackState();
      getRenderedMediaElements(previousSession).forEach((element) => {
        element.pause();
        element.currentTime = 0;
      });
      setPlaybackTimeSeconds(0);
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      setIsPlaying(false);
    } else if (previousSession && previousSignature !== nextSignature) {
      const nextTime = previousSession.isStemPlayback
        ? readMasterTime(previousSession)
        : Math.max(
            playbackTimeSecondsRef.current,
            primaryAudioRef.current?.currentTime ?? 0,
          );
      const shouldPlay = isPlayingRef.current;
      const primarySwap =
        !previousSession.isStemPlayback && !nextSession.isStemPlayback;
      const awaitingLoadKeys = primarySwap ? [PRIMARY_MEDIA_KEY] : [];
      const awaitingSeekKeys =
        primarySwap
          ? [PRIMARY_MEDIA_KEY]
          : [];
      const forceSeekKeys = primarySwap ? [PRIMARY_MEDIA_KEY] : [];
      if (shouldPlay) {
        getActiveMediaElements(previousSession).forEach((element) => element.pause());
      }
      if (previousSession.isStemPlayback) {
        disposeStemPlaybackState();
      }
      pendingTransitionRef.current = {
        id: ++transitionCounterRef.current,
        signature: nextSignature,
        shouldPlay,
        targetTime: nextTime,
        awaitingLoadKeys,
        awaitingSeekKeys,
        forceSeekKeys,
      };
      setPlaybackTimeSeconds(nextTime);
    } else if (!previousSession) {
      setPlaybackTimeSeconds(0);
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      setIsPlaying(false);
    }

    sessionRef.current = nextSession;
    setSession(nextSession);
  }, [
    clearPendingTransition,
    disposeStemPlaybackState,
    getActiveMediaElements,
    getRenderedMediaElements,
    readMasterTime,
  ]);

  useEffect(() => {
    applyStemVolumes(session);
    tryCompletePendingTransition();
    updateDurationFromActiveMedia(session);
  }, [applyStemVolumes, session, tryCompletePendingTransition, updateDurationFromActiveMedia]);

  useEffect(() => {
    if (!session?.visibleStemArtifactIds.length || !canUseStemClock()) {
      return;
    }

    void Promise.allSettled(
      session.visibleStemArtifactIds.map((artifactId) => loadStemBuffer(artifactId)),
    );
  }, [canUseStemClock, loadStemBuffer, session]);

  useEffect(
    () => () => {
      disposeStemPlaybackState();
      const audioContext = stemAudioContextRef.current;
      stemAudioContextRef.current = null;
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
      }
    },
    [disposeStemPlaybackState],
  );

  useMediaSessionControls({
    isPlaying,
    pausePlayback,
    playbackDurationSeconds,
    playbackTimeSeconds,
    playPlayback,
    seekBy,
    session,
    stopPlayback,
  });
  useSpacebarPlaybackShortcut({ sessionRef, togglePlayback });

  const value = useMemo<PlaybackContextValue>(
    () => ({
      session,
      playbackTimeSeconds,
      playbackDurationSeconds,
      isPlaying,
      activateStemPlayback,
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
      activateStemPlayback,
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
        key={
          session && !session.isStemPlayback
            ? session.selectedPlaybackArtifactId ?? "__none__"
            : "__none__"
        }
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
          markPendingLoadComplete(PRIMARY_MEDIA_KEY);
          updateDurationFromActiveMedia();
          tryCompletePendingTransition();
        }}
        onDurationChange={() => {
          updateDurationFromActiveMedia();
          tryCompletePendingTransition();
        }}
        onCanPlay={tryCompletePendingTransition}
        onSeeked={(event) => {
          markPendingSeekComplete(PRIMARY_MEDIA_KEY, event.currentTarget);
          tryCompletePendingTransition();
        }}
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
            syncStemElementTimes([artifactId], readMasterTime());
            tryCompletePendingTransition();
          }}
          onDurationChange={() => {
            if (sessionRef.current?.visibleStemArtifactIds[0] === artifactId) {
              updateDurationFromActiveMedia();
            }
            syncStemElementTimes([artifactId], readMasterTime());
            tryCompletePendingTransition();
          }}
          onCanPlay={tryCompletePendingTransition}
          onSeeked={(event) => {
            markPendingSeekComplete(artifactId, event.currentTarget);
            tryCompletePendingTransition();
          }}
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
