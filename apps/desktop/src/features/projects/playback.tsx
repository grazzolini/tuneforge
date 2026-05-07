import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../lib/api";
import {
  getNativeAudioCapabilities,
  isWebAudioBackendForced,
  listenNativeAudioEnded,
  listenNativeAudioErrors,
  listenNativeAudioPositions,
  pauseNativeAudio,
  playNativeAudio,
  prepareNativeAudioSession,
  seekNativeAudio,
  setNativeAudioLanes,
  stopNativeAudio,
  type NativeAudioLaneRequest,
  type NativeAudioSnapshot,
} from "../../lib/nativeAudio";
import {
  clearRememberedNativePlaybackError,
  playbackErrorMessage,
  rememberNativePlaybackError,
  rememberPlaybackBackend,
} from "../../lib/playbackDiagnostics";
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
import { normalizePrecountClickCount } from "./projectPlaybackState";
import {
  PRIMARY_MEDIA_KEY,
  SEEK_TOLERANCE_SECONDS,
  clampTime,
  playbackRateForSession,
  playbackSignature,
  playbackTargetSignature,
  type PendingTransition,
  type StemPlaybackState,
  usesDefaultPlaybackRate,
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
import { PRECOUNT_START_DELAY_SECONDS, schedulePrecountClaveClick } from "./precountSound";

type ActivePrecount = {
  context: AudioContext;
  ownsContext: boolean;
  sequence: number;
  signature: string;
  timeoutId: number;
};

type PitchPreservingAudioElement = HTMLAudioElement & {
  mozPreservesPitch?: boolean;
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

type NativePlaybackState = {
  active: boolean;
  blockedSessionSignature: string | null;
  preparePromise: Promise<boolean> | null;
  prepareSignature: string | null;
  sessionSignature: string | null;
  playbackSignature: string | null;
};

function applyMediaElementPlaybackRate(element: HTMLAudioElement, playbackRate: number) {
  const pitchPreservingElement = element as PitchPreservingAudioElement;
  pitchPreservingElement.preservesPitch = true;
  pitchPreservingElement.mozPreservesPitch = true;
  pitchPreservingElement.webkitPreservesPitch = true;
  element.playbackRate = playbackRate;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function nativeSessionSignature(session: ProjectPlaybackSession | null) {
  if (!session) {
    return "none";
  }
  const playbackRate = playbackRateForSession(session).toFixed(6);
  const artifactIds = nativeActiveArtifactIds(session)
    .sort()
    .join(",");
  return `${session.projectId}:native:${artifactIds}:rate:${playbackRate}`;
}

function nativeActiveArtifactIds(session: ProjectPlaybackSession) {
  return getSessionPlaybackArtifactIds(session).filter((artifactId) =>
    Boolean(session.artifactPathsById[artifactId]),
  );
}

function getSessionPlaybackArtifactIds(targetSession: ProjectPlaybackSession | null) {
  if (!targetSession) {
    return [] as string[];
  }
  if (targetSession.isStemPlayback) {
    return targetSession.visibleStemArtifactIds;
  }
  return targetSession.selectedPlaybackArtifactId
    ? [targetSession.selectedPlaybackArtifactId]
    : [];
}

function nativeLaneRequestsForSession(session: ProjectPlaybackSession): NativeAudioLaneRequest[] {
  const selectedId = session.selectedPlaybackArtifactId;
  const hasSolo = session.visibleStemArtifactIds.some(
    (artifactId) => session.stemControls[artifactId]?.solo,
  );
  const activeArtifactIds = new Set(nativeActiveArtifactIds(session));

  return session.playbackArtifactIds.flatMap((artifactId) => {
    if (!activeArtifactIds.has(artifactId)) {
      return [];
    }
    const sourcePath = session.artifactPathsById[artifactId];
    if (!sourcePath) {
      return [];
    }

    const isStem = session.visibleStemArtifactIds.includes(artifactId);
    const isActivePrimary = !session.isStemPlayback && artifactId === selectedId;
    const stemState = session.stemControls[artifactId] ?? { muted: false, solo: false };
    const stemAudible = session.isStemPlayback
      ? hasSolo
        ? stemState.solo
        : !stemState.muted
      : false;
    return [
      {
        id: artifactId,
        artifactId,
        sourcePath,
        role: isStem ? "stem" : "primary",
        gain: 1,
        muted: isStem ? !stemAudible : !isActivePrimary,
        solo: isStem ? stemState.solo : false,
      } satisfies NativeAudioLaneRequest,
    ];
  });
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const restoredPlaybackState = useRef(readPersistedPlaybackState()).current;
  const primaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const activePrecountRef = useRef<ActivePrecount | null>(null);
  const precountAudioContextRef = useRef<AudioContext | null>(null);
  const precountSequenceRef = useRef(0);
  const stemAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const stemAudioContextRef = useRef<AudioContext | null>(null);
  const stemClockBlockedRef = useRef(false);
  const stemBufferCacheRef = useRef(new Map<string, Promise<AudioBuffer>>());
  const stemPlaybackRef = useRef<StemPlaybackState | null>(null);
  const nativePlaybackRef = useRef<NativePlaybackState>({
    active: false,
    blockedSessionSignature: null,
    preparePromise: null,
    prepareSignature: null,
    sessionSignature: null,
    playbackSignature: null,
  });
  const nativeCapabilitiesPromiseRef = useRef<ReturnType<typeof getNativeAudioCapabilities> | null>(null);
  const pendingTransitionRef = useRef<PendingTransition | null>(
    restoredPlaybackState
        ? {
          id: 1,
          signature: playbackSignature(restoredPlaybackState.session),
          shouldPlay: restoredPlaybackState.isPlaying,
          targetTime: restoredPlaybackState.playbackTimeSeconds,
          awaitSeekBeforePlay: true,
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
  const [isPrecounting, setIsPrecounting] = useState(false);
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

  function setPrimaryAudioRef(element: HTMLAudioElement | null) {
    primaryAudioRef.current = element;
    if (element) {
      applyMediaElementPlaybackRate(element, playbackRateForSession(sessionRef.current));
    }
  }

  function setStemAudioRef(artifactId: string, element: HTMLAudioElement | null) {
    if (element) {
      stemAudioRefs.current[artifactId] = element;
      applyMediaElementPlaybackRate(element, playbackRateForSession(sessionRef.current));
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

  const canUseBufferedClock = useCallback(
    (targetSession: ProjectPlaybackSession | null) => {
      if (!targetSession || !canUseStemClock() || !usesDefaultPlaybackRate(targetSession)) {
        return false;
      }

      const artifactIds = getSessionPlaybackArtifactIds(targetSession);
      if (!artifactIds.length) {
        return false;
      }

      return artifactIds.every((artifactId) => {
        const streamUrl = api.streamArtifactUrl(artifactId);
        return Boolean(streamUrl) && !/^https?:\/\/asset\.localhost(?:\/|$)/.test(streamUrl);
      });
    },
    [canUseStemClock],
  );

  const getNativeAudioCapabilityState = useStableCallback(async function getNativeAudioCapabilityState() {
    if (isWebAudioBackendForced() || !isTauriRuntime()) {
      return null;
    }
    if (!nativeCapabilitiesPromiseRef.current) {
      nativeCapabilitiesPromiseRef.current = getNativeAudioCapabilities().catch((error) => {
        nativeCapabilitiesPromiseRef.current = null;
        throw error;
      });
    }
    return nativeCapabilitiesPromiseRef.current;
  });

  const canUseNativePlayback = useStableCallback(async function canUseNativePlayback(
    targetSession: ProjectPlaybackSession | null,
  ) {
    if (!targetSession) {
      return false;
    }
    const sessionSignature = nativeSessionSignature(targetSession);
    if (nativePlaybackRef.current.blockedSessionSignature === sessionSignature) {
      return false;
    }
    const artifactIds = getSessionPlaybackArtifactIds(targetSession);
    if (!artifactIds.length) {
      return false;
    }
    const lanes = nativeLaneRequestsForSession(targetSession);
    const laneArtifactIds = new Set(lanes.map((lane) => lane.artifactId));
    if (!lanes.length || !artifactIds.every((artifactId) => laneArtifactIds.has(artifactId))) {
      return false;
    }
    const capabilities = await getNativeAudioCapabilityState();
    return Boolean(capabilities?.nativePlaybackSupported);
  });

  const markNativePlaybackInactive = useStableCallback(function markNativePlaybackInactive() {
    nativePlaybackRef.current = {
      ...nativePlaybackRef.current,
      active: false,
      playbackSignature: null,
    };
  });

  const pauseRenderedMediaElements = useStableCallback(function pauseRenderedMediaElements(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    getRenderedMediaElements(targetSession).forEach((element) => element.pause());
  });

  const ensureNativePlaybackSession = useStableCallback(async function ensureNativePlaybackSession(
    targetSession: ProjectPlaybackSession,
  ) {
    if (!(await canUseNativePlayback(targetSession))) {
      return false;
    }
    const sessionSignature = nativeSessionSignature(targetSession);
    const lanes = nativeLaneRequestsForSession(targetSession);
    if (nativePlaybackRef.current.sessionSignature === sessionSignature) {
      await setNativeAudioLanes({ lanes });
      return true;
    }

    const pendingPrepare = nativePlaybackRef.current;
    if (
      pendingPrepare.prepareSignature === sessionSignature &&
      pendingPrepare.preparePromise
    ) {
      const prepared = await pendingPrepare.preparePromise;
      if (prepared && nativePlaybackRef.current.sessionSignature === sessionSignature) {
        await setNativeAudioLanes({ lanes });
      }
      return prepared;
    }

    const preparePromise = (async () => {
      const preparedSession = await prepareNativeAudioSession({
        sessionId: sessionSignature,
        durationSeconds: targetSession.durationHintSeconds || null,
        playbackRate: playbackRateForSession(targetSession),
        lanes,
      });
      if (!preparedSession.nativePlaybackSupported) {
        if (nativePlaybackRef.current.prepareSignature === sessionSignature) {
          nativePlaybackRef.current = {
            ...nativePlaybackRef.current,
            blockedSessionSignature: sessionSignature,
            preparePromise: null,
            prepareSignature: null,
          };
        }
        rememberNativePlaybackError(
          preparedSession.fallbackReason ?? "Native playback prepare fell back to Web Audio.",
        );
        return false;
      }
      if (nativePlaybackRef.current.blockedSessionSignature === sessionSignature) {
        if (nativePlaybackRef.current.prepareSignature === sessionSignature) {
          void stopNativeAudio().catch(() => undefined);
          nativePlaybackRef.current = {
            ...nativePlaybackRef.current,
            preparePromise: null,
            prepareSignature: null,
          };
        }
        return false;
      }
      const currentNative = nativePlaybackRef.current;
      if (currentNative.prepareSignature !== sessionSignature) {
        if (!currentNative.active && !currentNative.prepareSignature) {
          void stopNativeAudio().catch(() => undefined);
        }
        return false;
      }
      nativePlaybackRef.current = {
        ...currentNative,
        active: false,
        blockedSessionSignature: null,
        preparePromise: null,
        prepareSignature: null,
        sessionSignature,
        playbackSignature: null,
      };
      clearRememberedNativePlaybackError();
      return true;
    })();

    nativePlaybackRef.current = {
      ...nativePlaybackRef.current,
      preparePromise,
      prepareSignature: sessionSignature,
    };

    try {
      const prepared = await preparePromise;
      if (prepared && nativePlaybackRef.current.sessionSignature === sessionSignature) {
        await setNativeAudioLanes({ lanes });
      }
      return prepared;
    } catch (error) {
      if (
        nativePlaybackRef.current.prepareSignature === sessionSignature ||
        nativePlaybackRef.current.sessionSignature === sessionSignature
      ) {
        nativePlaybackRef.current = {
          ...nativePlaybackRef.current,
          blockedSessionSignature: sessionSignature,
          preparePromise: null,
          prepareSignature: null,
        };
        rememberNativePlaybackError(playbackErrorMessage(error));
      }
      return false;
    }
  });

  const tryStartNativePlayback = useStableCallback(async function tryStartNativePlayback(
    targetSession: ProjectPlaybackSession,
    timeSeconds: number,
  ) {
    const sessionSignature = nativeSessionSignature(targetSession);
    try {
      if (!(await ensureNativePlaybackSession(targetSession))) {
        return false;
      }
      const latestSession = sessionRef.current;
      if (
        !latestSession ||
        playbackSignature(latestSession) !== playbackSignature(targetSession) ||
        nativeSessionSignature(latestSession) !== sessionSignature
      ) {
        if (
          nativePlaybackRef.current.sessionSignature === sessionSignature &&
          !nativePlaybackRef.current.active
        ) {
          markNativePlaybackInactive();
          void stopNativeAudio().catch(() => undefined);
        }
        return false;
      }
      await setNativeAudioLanes({ lanes: nativeLaneRequestsForSession(latestSession) });
      const snapshot = await playNativeAudio({
        startTimeSeconds:
          timeSeconds <= SEEK_TOLERANCE_SECONDS
            ? null
            : clampTime(timeSeconds, latestSession.durationHintSeconds || 0),
      });
      nativePlaybackRef.current.active = snapshot.nativePlaybackSupported;
      nativePlaybackRef.current.playbackSignature = playbackSignature(latestSession);
      if (!snapshot.nativePlaybackSupported) {
        rememberNativePlaybackError(
          snapshot.fallbackReason ?? "Native playback start fell back to Web Audio.",
        );
        return false;
      }
      const capabilities = await getNativeAudioCapabilityState();
      rememberPlaybackBackend({ backend: "native", detail: capabilities?.backend ?? null });
      clearRememberedNativePlaybackError();
      disposeStemPlaybackState();
      pauseRenderedMediaElements(latestSession);
      setPlaybackTimeSeconds(snapshot.positionSeconds);
      setPlaybackDurationSeconds(snapshot.durationSeconds || latestSession.durationHintSeconds || 0);
      setIsPlaying(true);
      return true;
    } catch (error) {
      rememberNativePlaybackError(playbackErrorMessage(error));
      nativePlaybackRef.current.blockedSessionSignature = sessionSignature;
      markNativePlaybackInactive();
      return false;
    }
  });

  const syncStemElementTimes = useStableCallback(function syncStemElementTimes(
    artifactIds: string[],
    nextTime: number,
  ) {
    artifactIds.forEach((artifactId) => {
      if (
        sessionRef.current?.selectedPlaybackArtifactId === artifactId &&
        primaryAudioRef.current
      ) {
        try {
          if (Math.abs(primaryAudioRef.current.currentTime - nextTime) > SEEK_TOLERANCE_SECONDS) {
            primaryAudioRef.current.currentTime = nextTime;
          }
        } catch {
          return;
        }
      }

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
  });

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

  const cancelPrecount = useStableCallback(function cancelPrecount() {
    const activePrecount = activePrecountRef.current;
    activePrecountRef.current = null;
    precountSequenceRef.current += 1;
    setIsPrecounting(false);

    if (!activePrecount) {
      return;
    }

    window.clearTimeout(activePrecount.timeoutId);
    if (!activePrecount.ownsContext) {
      return;
    }

    if (precountAudioContextRef.current === activePrecount.context) {
      precountAudioContextRef.current = null;
    }
    if (activePrecount.context.state !== "closed") {
      void activePrecount.context.close().catch(() => undefined);
    }
  });

  const closeOwnedPrecountContext = useStableCallback(function closeOwnedPrecountContext(
    activePrecount: ActivePrecount,
  ) {
    if (!activePrecount.ownsContext) {
      return;
    }
    if (precountAudioContextRef.current === activePrecount.context) {
      precountAudioContextRef.current = null;
    }
    if (activePrecount.context.state !== "closed") {
      void activePrecount.context.close().catch(() => undefined);
    }
  });

  const getPrecountAudioContext = useStableCallback(function getPrecountAudioContext() {
    if (canUseStemClock()) {
      const playbackContext = getStemAudioContext();
      return playbackContext ? { context: playbackContext, ownsContext: false } : null;
    }

    if (precountAudioContextRef.current && precountAudioContextRef.current.state !== "closed") {
      return { context: precountAudioContextRef.current, ownsContext: true };
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      return null;
    }

    const context = new AudioContextConstructor();
    precountAudioContextRef.current = context;
    return { context, ownsContext: true };
  });

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
    targetPlaybackState.offsetSeconds = 0;
    targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
    targetPlaybackState.sources = {};
    syncStemElementTimes(targetPlaybackState.artifactIds, 0);

    if (stemPlaybackRef.current !== targetPlaybackState) {
      return;
    }

    setPlaybackTimeSeconds(0);
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

  const closePlaybackAudioContext = useStableCallback(function closePlaybackAudioContext() {
    disposeStemPlaybackState();
    stemBufferCacheRef.current.clear();

    const audioContext = stemAudioContextRef.current;
    stemAudioContextRef.current = null;
    stemClockBlockedRef.current = false;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
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

    const artifactIds = getSessionPlaybackArtifactIds(targetSession);
    if (!artifactIds.length) {
      return null;
    }

    const buffers = await getStemBuffers(artifactIds);
    const durationSeconds = Math.max(
      targetSession.durationHintSeconds || 0,
      ...Object.values(buffers).map((buffer) => buffer.duration || 0),
    );
    const gains = Object.fromEntries(
      artifactIds.map((artifactId) => {
        const gainNode = context.createGain();
        gainNode.connect(context.destination);
        return [artifactId, gainNode] as const;
      }),
    );
    const nextPlaybackState: StemPlaybackState = {
      signature,
      artifactIds,
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
    syncStemElementTimes(artifactIds, nextPlaybackState.offsetSeconds);
    return nextPlaybackState;
  });

  const startStemPlayback = useStableCallback(async function startStemPlayback(
    targetSession: ProjectPlaybackSession,
    timeSeconds: number,
    scheduledStartTimeSeconds?: number,
  ) {
    if (!canUseBufferedClock(targetSession)) {
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
      syncStemElementTimes(targetPlaybackState.artifactIds, targetPlaybackState.durationSeconds);
      setPlaybackTimeSeconds(targetPlaybackState.durationSeconds);
      setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
      setIsPlaying(false);
      return false;
    }

    const nextSources = Object.fromEntries(
      targetPlaybackState.artifactIds.map((artifactId) => {
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
    const sourceStartTimeSeconds =
      scheduledStartTimeSeconds === undefined
        ? 0
        : Math.max(targetPlaybackState.context.currentTime, scheduledStartTimeSeconds);
    const clockStartTimeSeconds =
      scheduledStartTimeSeconds === undefined
        ? targetPlaybackState.context.currentTime
        : sourceStartTimeSeconds;
    targetPlaybackState.offsetSeconds = nextTime;
    targetPlaybackState.startedAtContextTime = clockStartTimeSeconds;
    targetPlaybackState.isPlaying = true;
    syncStemElementTimes(targetPlaybackState.artifactIds, nextTime);
    applyStemVolumes(targetSession);

    Object.values(nextSources).forEach((sourceNode) =>
      sourceNode.start(sourceStartTimeSeconds, nextTime),
    );

    setPlaybackTimeSeconds(nextTime);
    setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
    setIsPlaying(true);
    rememberPlaybackBackend({ backend: "web", detail: null });
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

  const applyMediaPlaybackRate = useStableCallback(function applyMediaPlaybackRate(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    const playbackRate = playbackRateForSession(targetSession);
    getRenderedMediaElements(targetSession).forEach((element) => {
      applyMediaElementPlaybackRate(element, playbackRate);
    });
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
    const targetPlaybackState = stemPlaybackRef.current;
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
    });

    if (
      targetPlaybackState &&
      targetPlaybackState.signature === playbackSignature(targetSession)
    ) {
      targetPlaybackState.artifactIds.forEach((artifactId) => {
        const state = targetSession.stemControls[artifactId] ?? {
          muted: false,
          solo: false,
        };
        const volume = targetSession.isStemPlayback
          ? (hasSolo ? (state.solo ? 1 : 0) : state.muted ? 0 : 1)
          : 1;
        const gainNode = targetPlaybackState.gains[artifactId];
        if (gainNode) {
          gainNode.gain.value = volume;
        }
      });
    }

    if (
      nativePlaybackRef.current.active &&
      nativePlaybackRef.current.sessionSignature === nativeSessionSignature(targetSession)
    ) {
      void setNativeAudioLanes({ lanes: nativeLaneRequestsForSession(targetSession) }).catch(
        (error) => {
          rememberNativePlaybackError(playbackErrorMessage(error));
        },
      );
    }
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

    if (
      targetSession &&
      nativePlaybackRef.current.active &&
      nativePlaybackRef.current.playbackSignature === playbackSignature(targetSession)
    ) {
      return playbackTimeSecondsRef.current;
    }

    const targetPlaybackState = stemPlaybackRef.current;
    if (
      targetSession &&
      targetPlaybackState &&
      targetPlaybackState.signature === playbackSignature(targetSession)
    ) {
      return getStemPlaybackTime(targetPlaybackState);
    }

    return getActiveMediaElements(targetSession)[0]?.currentTime ?? playbackTimeSecondsRef.current;
  });

  const getPlaybackSnapshot = useStableCallback(function getPlaybackSnapshot() {
    const activeSession = sessionRef.current;
    return {
      session: activeSession,
      playbackTimeSeconds: readMasterTime(activeSession),
      playbackDurationSeconds: playbackDurationSecondsRef.current,
      isPrecounting: Boolean(activePrecountRef.current),
      isPlaying: isPlayingRef.current,
    };
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
    const targetPlaybackState = stemPlaybackRef.current;
    if (
      targetSession &&
      targetPlaybackState &&
      targetPlaybackState.signature === playbackSignature(targetSession)
    ) {
      setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
      return;
    }

    if (targetSession?.isStemPlayback) {
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
    void (async () => {
      let pendingTransition = pendingTransitionRef.current;
      let targetSession = sessionRef.current;
      if (!pendingTransition || !targetSession) {
        return;
      }

      if (pendingTransition.shouldPlay) {
        const started = await tryStartNativePlayback(
          targetSession,
          pendingTransition.targetTime,
        );
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
        if (started) {
          clearPendingTransition();
          return;
        }
        pendingTransition = latestPendingTransition;
        targetSession = latestSession;
      }

      if (canUseBufferedClock(targetSession)) {
        const targetPlaybackState = await prepareStemPlaybackState(targetSession);
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
        syncStemElementTimes(targetPlaybackState.artifactIds, nextTime);
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
        applyMediaPlaybackRate(latestSession);

        const results = await Promise.allSettled(
          fallbackElements.map((element) => Promise.resolve(element.play())),
        );
        const fallbackStarted = results.some((result) => result.status === "fulfilled");
        if (fallbackStarted) {
          rememberPlaybackBackend({ backend: "web", detail: null });
        }
        setIsPlaying(fallbackStarted);
        return;
      }

      const targetElements = getActiveMediaElements(targetSession);
      const targetKeys = getActiveMediaKeys(targetSession);
      if (!targetElements.length) {
        return;
      }

      const minimumReadyState = HTMLMediaElement.HAVE_METADATA;
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
          if (pendingTransition.awaitSeekBeforePlay && !awaitingSeekKeys.includes(mediaKey)) {
            awaitingSeekKeys.push(mediaKey);
          }
          return;
        }
        if (Math.abs(element.currentTime - nextTime) > SEEK_TOLERANCE_SECONDS) {
          element.currentTime = nextTime;
          if (pendingTransition.awaitSeekBeforePlay && !awaitingSeekKeys.includes(mediaKey)) {
            awaitingSeekKeys.push(mediaKey);
          }
          return;
        }
        if (
          pendingTransition.awaitSeekBeforePlay &&
          element.seeking &&
          !awaitingSeekKeys.includes(mediaKey)
        ) {
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

      applyMediaPlaybackRate(targetSession);
      const results = await Promise.allSettled(
        targetElements.map((element) => Promise.resolve(element.play())),
      );
      if (pendingTransitionRef.current?.id === transitionId) {
        return;
      }
      if (playbackSignature(sessionRef.current) !== transitionSignature) {
        return;
      }
      const started = results.some((result) => result.status === "fulfilled");
      if (started) {
        rememberPlaybackBackend({ backend: "web", detail: null });
      }
      setIsPlaying(started);
    })();
  });

  const pausePlayback = useCallback(() => {
    cancelPrecount();
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.shouldPlay = false;
    }

    const targetSession = sessionRef.current;
    if (nativePlaybackRef.current.active) {
      void pauseNativeAudio()
        .then((snapshot) => {
          setPlaybackTimeSeconds(snapshot.positionSeconds);
          setIsPlaying(false);
        })
        .catch(() => undefined);
      markNativePlaybackInactive();
      setIsPlaying(false);
      return;
    }

    const targetPlaybackState = stemPlaybackRef.current;
    if (
      targetSession &&
      canUseBufferedClock(targetSession) &&
      targetPlaybackState &&
      targetPlaybackState.signature === playbackSignature(targetSession)
    ) {
      const nextTime = stopStemSources(targetPlaybackState, true);
      setPlaybackTimeSeconds(nextTime);
      setIsPlaying(false);
      return;
    }

    getActiveMediaElements().forEach((element) => element.pause());
    setIsPlaying(false);
  }, [
    canUseBufferedClock,
    cancelPrecount,
    getActiveMediaElements,
    markNativePlaybackInactive,
    stopStemSources,
  ]);

  const playPlaybackImmediately = useStableCallback(async function playPlaybackImmediately(
    {
      forceStartAtZero = false,
      scheduledStemStartTimeSeconds,
    }: {
      forceStartAtZero?: boolean;
      scheduledStemStartTimeSeconds?: number;
    } = {},
  ) {
    const targetSession = sessionRef.current;
    if (!targetSession) {
      return;
    }

    tryCompletePendingTransition();

    const masterTime = forceStartAtZero ? 0 : readMasterTime(targetSession);
    if (await tryStartNativePlayback(targetSession, masterTime)) {
      return;
    }

    if (canUseBufferedClock(targetSession)) {
      const started = await startStemPlayback(
        targetSession,
        masterTime,
        scheduledStemStartTimeSeconds,
      );
      if (started) {
        markNativePlaybackInactive();
        return;
      }
    }

    const activeElements = getActiveMediaElements(targetSession);
    if (!activeElements.length) {
      return;
    }

    activeElements.forEach((element) => {
      if (Math.abs(element.currentTime - masterTime) > SEEK_TOLERANCE_SECONDS) {
        element.currentTime = masterTime;
      }
    });
    applyStemVolumes(targetSession);
    applyMediaPlaybackRate(targetSession);

    const results = await Promise.allSettled(
      activeElements.map((element) => Promise.resolve(element.play())),
    );
    markNativePlaybackInactive();
    const started = results.some((result) => result.status === "fulfilled");
    if (started) {
      rememberPlaybackBackend({ backend: "web", detail: null });
    }
    setIsPlaying(started);
  });

  const startPrecountThenPlayback = useStableCallback(async function startPrecountThenPlayback(
    targetSession: ProjectPlaybackSession,
    startTimeSeconds: number,
  ) {
    const tempoBpm = targetSession.precountTempoBpm;
    if (!targetSession.precountEnabled || typeof tempoBpm !== "number" || !Number.isFinite(tempoBpm) || tempoBpm <= 0) {
      return false;
    }
    if (startTimeSeconds > SEEK_TOLERANCE_SECONDS) {
      return false;
    }

    const clickCount = normalizePrecountClickCount(targetSession.precountClickCount);
    const signature = playbackSignature(targetSession);
    cancelPrecount();
    const sequence = ++precountSequenceRef.current;

    let preparedStemPlaybackState: StemPlaybackState | null = null;
    const willUsePlaybackAudioContext = canUseBufferedClock(targetSession);
    if (willUsePlaybackAudioContext) {
      preparedStemPlaybackState = await prepareStemPlaybackState(targetSession);
      if (!preparedStemPlaybackState) {
        return false;
      }
      if (precountSequenceRef.current !== sequence || playbackSignature(sessionRef.current) !== signature) {
        return true;
      }
    }

    const precountAudio = getPrecountAudioContext();
    if (!precountAudio) {
      return false;
    }

    try {
      if (precountAudio.context.state === "suspended") {
        await precountAudio.context.resume();
      }
    } catch {
      if (precountAudio.ownsContext && precountAudioContextRef.current === precountAudio.context) {
        precountAudioContextRef.current = null;
      }
      if (precountAudio.ownsContext) {
        void precountAudio.context.close().catch(() => undefined);
      }
      return false;
    }

    if (precountAudio.context.state !== "running") {
      if (precountAudio.ownsContext && precountAudioContextRef.current === precountAudio.context) {
        precountAudioContextRef.current = null;
      }
      if (precountAudio.ownsContext) {
        void precountAudio.context.close().catch(() => undefined);
      }
      return false;
    }

    if (precountSequenceRef.current !== sequence || playbackSignature(sessionRef.current) !== signature) {
      if (precountAudio.ownsContext && precountAudioContextRef.current === precountAudio.context) {
        precountAudioContextRef.current = null;
      }
      if (precountAudio.ownsContext) {
        void precountAudio.context.close().catch(() => undefined);
      }
      return true;
    }

    getActiveMediaElements(targetSession).forEach((element) => {
      if (Math.abs(element.currentTime) > SEEK_TOLERANCE_SECONDS) {
        element.currentTime = 0;
      }
    });
    if (preparedStemPlaybackState) {
      preparedStemPlaybackState.offsetSeconds = 0;
      syncStemElementTimes(preparedStemPlaybackState.artifactIds, 0);
      setPlaybackDurationSeconds(preparedStemPlaybackState.durationSeconds);
    }
    setPlaybackTimeSeconds(0);

    const beatSeconds = 60 / tempoBpm;
    const firstClickTimeSeconds = precountAudio.context.currentTime + PRECOUNT_START_DELAY_SECONDS;
    const playbackStartTimeSeconds = firstClickTimeSeconds + clickCount * beatSeconds;
    for (let index = 0; index < clickCount; index += 1) {
      schedulePrecountClaveClick({
        audioContext: precountAudio.context,
        startTimeSeconds: firstClickTimeSeconds + index * beatSeconds,
      });
    }

    const timeoutId = window.setTimeout(() => {
      const activePrecount = activePrecountRef.current;
      if (!activePrecount || activePrecount.sequence !== sequence || activePrecount.signature !== signature) {
        return;
      }

      activePrecountRef.current = null;
      setIsPrecounting(false);
      closeOwnedPrecountContext(activePrecount);

      if (playbackSignature(sessionRef.current) !== signature) {
        return;
      }

      void playPlaybackImmediately({
        forceStartAtZero: true,
        scheduledStemStartTimeSeconds: willUsePlaybackAudioContext
          ? playbackStartTimeSeconds
          : undefined,
      });
    }, Math.max(0, (playbackStartTimeSeconds - precountAudio.context.currentTime) * 1000));

    activePrecountRef.current = {
      context: precountAudio.context,
      ownsContext: precountAudio.ownsContext,
      sequence,
      signature,
      timeoutId,
    };
    setIsPrecounting(true);
    return true;
  });

  const playPlayback = useCallback(async () => {
    if (activePrecountRef.current) {
      return;
    }

    const targetSession = sessionRef.current;
    if (!targetSession) {
      return;
    }

    tryCompletePendingTransition();

    const masterTime = readMasterTime(targetSession);
    if (await startPrecountThenPlayback(targetSession, masterTime)) {
      return;
    }

    await playPlaybackImmediately();
  }, [
    playPlaybackImmediately,
    readMasterTime,
    startPrecountThenPlayback,
    tryCompletePendingTransition,
  ]);

  const togglePlayback = useCallback(async () => {
    if (activePrecountRef.current) {
      cancelPrecount();
      return;
    }
    if (isPlayingRef.current) {
      pausePlayback();
      return;
    }
    await playPlayback();
  }, [cancelPrecount, pausePlayback, playPlayback]);

  const seekTo = useCallback((timeSeconds: number) => {
    cancelPrecount();
    const nextTime = clampTime(timeSeconds, playbackDurationSecondsRef.current);
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.targetTime = nextTime;
    }

    const targetSession = sessionRef.current;
    if (nativePlaybackRef.current.active) {
      void seekNativeAudio({ timeSeconds: nextTime })
        .then((snapshot) => setPlaybackTimeSeconds(snapshot.positionSeconds))
        .catch(() => markNativePlaybackInactive());
      setPlaybackTimeSeconds(nextTime);
      return;
    }

    const targetPlaybackState = stemPlaybackRef.current;
    if (
      targetSession &&
      canUseBufferedClock(targetSession) &&
      targetPlaybackState &&
      targetPlaybackState.signature === playbackSignature(targetSession)
    ) {
      syncStemElementTimes(targetPlaybackState.artifactIds, nextTime);
      targetPlaybackState.offsetSeconds = clampTime(nextTime, targetPlaybackState.durationSeconds);
      targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
      if (targetPlaybackState.isPlaying) {
        void startStemPlayback(targetSession, nextTime);
      }
      setPlaybackTimeSeconds(nextTime);
      return;
    }

    getActiveMediaElements().forEach((element) => {
      element.currentTime = nextTime;
    });
    setPlaybackTimeSeconds(nextTime);
  }, [
    canUseBufferedClock,
    cancelPrecount,
    getActiveMediaElements,
    markNativePlaybackInactive,
    startStemPlayback,
    syncStemElementTimes,
  ]);

  const seekBy = useCallback(
    (secondsDelta: number) => {
      seekTo(readMasterTime() + secondsDelta);
    },
    [readMasterTime, seekTo],
  );

  const stopPlayback = useCallback(() => {
    cancelPrecount();
    clearPendingTransition();
    if (nativePlaybackRef.current.active) {
      void stopNativeAudio().catch(() => undefined);
      markNativePlaybackInactive();
    }
    if (stemPlaybackRef.current) {
      stopStemSources(stemPlaybackRef.current, false);
      stemPlaybackRef.current.offsetSeconds = 0;
      syncStemElementTimes(stemPlaybackRef.current.artifactIds, 0);
    }
    getRenderedMediaElements().forEach((element) => {
      element.pause();
      element.currentTime = 0;
    });
    setPlaybackTimeSeconds(0);
    setIsPlaying(false);
    updateDurationFromActiveMedia();
  }, [
    cancelPrecount,
    clearPendingTransition,
    getRenderedMediaElements,
    markNativePlaybackInactive,
    stopStemSources,
    syncStemElementTimes,
    updateDurationFromActiveMedia,
  ]);

  const dismissSession = useCallback(() => {
    stopPlayback();
    closePlaybackAudioContext();
    setSession(null);
    sessionRef.current = null;
    setPlaybackDurationSeconds(0);
  }, [closePlaybackAudioContext, stopPlayback]);

  const registerProjectSession = useCallback((nextSession: ProjectPlaybackSession) => {
    const previousSession = sessionRef.current;
    const previousSignature = playbackSignature(previousSession);
    const nextSignature = playbackSignature(nextSession);

    if (previousSession && previousSession.projectId !== nextSession.projectId) {
      cancelPrecount();
      clearPendingTransition();
      closePlaybackAudioContext();
      getRenderedMediaElements(previousSession).forEach((element) => {
        element.pause();
        element.currentTime = 0;
      });
      setPlaybackTimeSeconds(0);
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      setIsPlaying(false);
    } else if (previousSession && previousSignature !== nextSignature) {
      cancelPrecount();
      const nextTime = readMasterTime(previousSession);
      const shouldPlay = isPlayingRef.current;
      const samePlaybackTarget =
        playbackTargetSignature(previousSession) === playbackTargetSignature(nextSession);
      const previousUsesNative =
        nativePlaybackRef.current.active &&
        nativePlaybackRef.current.playbackSignature === previousSignature;
      if (previousUsesNative) {
        void stopNativeAudio().catch(() => undefined);
        markNativePlaybackInactive();
        getActiveMediaElements(previousSession).forEach((element) => {
          element.pause();
          element.currentTime = nextTime;
        });
        syncStemElementTimes(previousSession.visibleStemArtifactIds, nextTime);
      }
      const previousUsesBufferedClock = canUseBufferedClock(previousSession);
      const nextUsesBufferedClock = canUseBufferedClock(nextSession);
      if (samePlaybackTarget && !previousUsesNative && !previousUsesBufferedClock && !nextUsesBufferedClock) {
        const pendingTransition = pendingTransitionRef.current;
        if (
          pendingTransition &&
          playbackTargetSignature(previousSession) === playbackTargetSignature(nextSession)
        ) {
          pendingTransition.signature = nextSignature;
          pendingTransition.shouldPlay = pendingTransition.shouldPlay || shouldPlay;
        }
        applyMediaPlaybackRate(nextSession);
        sessionRef.current = nextSession;
        setSession(nextSession);
        return;
      }
      const primarySwap =
        !samePlaybackTarget && !previousSession.isStemPlayback && !nextSession.isStemPlayback;
      const awaitingLoadKeys = primarySwap ? [PRIMARY_MEDIA_KEY] : [];
      const awaitingSeekKeys =
        primarySwap
          ? [PRIMARY_MEDIA_KEY]
          : [];
      const forceSeekKeys = primarySwap ? [PRIMARY_MEDIA_KEY] : [];
      if (
        shouldPlay &&
        (!samePlaybackTarget || previousUsesBufferedClock || nextUsesBufferedClock)
      ) {
        getActiveMediaElements(previousSession).forEach((element) => element.pause());
      }
      disposeStemPlaybackState();
      pendingTransitionRef.current = {
        id: ++transitionCounterRef.current,
        signature: nextSignature,
        shouldPlay,
        targetTime: nextTime,
        awaitSeekBeforePlay: !samePlaybackTarget,
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
    cancelPrecount,
    applyMediaPlaybackRate,
    canUseBufferedClock,
    clearPendingTransition,
    closePlaybackAudioContext,
    disposeStemPlaybackState,
    getActiveMediaElements,
    getRenderedMediaElements,
    markNativePlaybackInactive,
    readMasterTime,
    syncStemElementTimes,
  ]);

  useEffect(() => {
    applyMediaPlaybackRate(session);
    applyStemVolumes(session);
    tryCompletePendingTransition();
    updateDurationFromActiveMedia(session);
  }, [
    applyMediaPlaybackRate,
    applyStemVolumes,
    session,
    tryCompletePendingTransition,
    updateDurationFromActiveMedia,
  ]);

  useEffect(() => {
    if (!session || !usesDefaultPlaybackRate(session)) {
      if (nativePlaybackRef.current.preparePromise) {
        nativePlaybackRef.current = {
          ...nativePlaybackRef.current,
          preparePromise: null,
          prepareSignature: null,
        };
      }
      return;
    }
    if (isPlayingRef.current) {
      return;
    }

    void ensureNativePlaybackSession(session).catch((error) => {
      rememberNativePlaybackError(playbackErrorMessage(error));
    });
  }, [ensureNativePlaybackSession, session]);

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
      cancelPrecount();
      closePlaybackAudioContext();
    },
    [cancelPrecount, closePlaybackAudioContext],
  );

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const unlisteners = Promise.all([
      listenNativeAudioPositions((position) => {
        const activeSession = sessionRef.current;
        if (
          !activeSession ||
          !nativePlaybackRef.current.active ||
          position.sessionId !== nativePlaybackRef.current.sessionSignature
        ) {
          return;
        }
        setPlaybackTimeSeconds(position.positionSeconds);
        setPlaybackDurationSeconds(position.durationSeconds || activeSession.durationHintSeconds || 0);
        setIsPlaying(position.state === "playing");
      }),
      listenNativeAudioEnded((snapshot: NativeAudioSnapshot) => {
        if (snapshot.sessionId !== nativePlaybackRef.current.sessionSignature) {
          return;
        }
        markNativePlaybackInactive();
        void stopNativeAudio().catch(() => undefined);
        setPlaybackTimeSeconds(0);
        setIsPlaying(false);
        syncStemElementTimes(sessionRef.current?.visibleStemArtifactIds ?? [], 0);
        getRenderedMediaElements().forEach((element) => {
          element.pause();
          element.currentTime = 0;
        });
      }),
      listenNativeAudioErrors((error) => {
        const activeSession = sessionRef.current;
        if (!activeSession || !nativePlaybackRef.current.active) {
          return;
        }
        rememberNativePlaybackError(error.message);
        const fallbackTime = clampTime(
          playbackTimeSecondsRef.current,
          playbackDurationSecondsRef.current || activeSession.durationHintSeconds || 0,
        );
        nativePlaybackRef.current.blockedSessionSignature = nativeSessionSignature(activeSession);
        markNativePlaybackInactive();
        setIsPlaying(false);
        void stopNativeAudio().catch(() => undefined);
        syncStemElementTimes(activeSession.visibleStemArtifactIds, fallbackTime);
        getRenderedMediaElements(activeSession).forEach((element) => {
          element.pause();
          element.currentTime = fallbackTime;
        });
        setPlaybackTimeSeconds(fallbackTime);
        void playPlaybackImmediately();
      }),
    ]);

    return () => {
      void unlisteners.then((items) => {
        items.forEach((unlisten) => unlisten());
      });
    };
  }, [
    getRenderedMediaElements,
    markNativePlaybackInactive,
    playPlaybackImmediately,
    syncStemElementTimes,
  ]);

  useMediaSessionControls({
    isPlaying,
    pausePlayback,
    playbackDurationSeconds,
    playbackRate: playbackRateForSession(session),
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
      isPrecounting,
      isPlaying,
      activateStemPlayback,
      getPlaybackSnapshot,
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
      getPlaybackSnapshot,
      isPrecounting,
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
        ref={setPrimaryAudioRef}
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
          if (primaryAudioRef.current) {
            applyMediaElementPlaybackRate(
              primaryAudioRef.current,
              playbackRateForSession(sessionRef.current),
            );
          }
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
          stopPlayback();
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
            const element = stemAudioRefs.current[artifactId];
            if (element) {
              applyMediaElementPlaybackRate(
                element,
                playbackRateForSession(sessionRef.current),
              );
            }
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
            stopPlayback();
          }}
        />
      ))}
    </PlaybackContext.Provider>
  );
}
