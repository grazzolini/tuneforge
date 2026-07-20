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
  getNativeAudioSnapshot,
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
  clearNativePlaybackSessionDiagnostics,
  markPlaybackConfirmed,
  markPlaybackError,
  markPlaybackPaused,
  markPlaybackStarting,
  markPlaybackStopped,
  playbackErrorMessage,
  rememberNativePlaybackError,
  rememberNativeFallbackCause,
  rememberWebPlaybackError,
  resetLivePlaybackDiagnostics,
  updateNativePlaybackDiagnostics,
} from "../../lib/playbackDiagnostics";
import {
  patchPlaybackE2ETelemetry,
  type PlaybackE2EActivePath,
  type PlaybackE2ECountInCancelReason,
  type PlaybackE2ECountInCancelled,
  type PlaybackE2ECountInFired,
  type PlaybackE2ECountInSchedule,
  type PlaybackE2ECountInState,
  type PlaybackE2ETelemetryPatch,
  type PlaybackE2ETransportState,
} from "../../lib/playbackE2ETelemetry";
import {
  activateWebAudioContext,
  getWebAudioContextConstructor,
  primeWebAudioContext,
} from "../../lib/webAudio";
import { releaseSystemMediaControls } from "../../lib/systemMedia";
import { useStableCallback } from "../../lib/useStableCallback";
import { countInIntervalsForTiming } from "../../lib/timingGrid";
import {
  PlaybackContext,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./playback-context";
import { normalizePrecountClickCount } from "./projectPlaybackState";
import {
  MEDIA_PLAYBACK_RATE_RAMP_MS,
  PRIMARY_MEDIA_KEY,
  SEEK_TOLERANCE_SECONDS,
  STEM_PLAYBACK_CROSSFADE_SECONDS,
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
import {
  useSpacebarPlaybackShortcut,
  useSystemPlaybackMediaControls,
  useWebPlaybackWakeLock,
  type PlaybackControlBackend,
} from "./playbackEffects";
import {
  PRECOUNT_START_DELAY_SECONDS,
  schedulePrecountClaveClick,
  type PrecountClaveClickHandle,
} from "./precountSound";

type ActivePrecount = {
  clickHandles: PrecountClaveClickHandle[];
  context: AudioContext;
  ownsContext: boolean;
  sequence: number;
  signature: string;
  telemetry: PlaybackE2ECountInEvent;
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

type PendingWebPlayback = {
  fallbackCause: string | null;
  mode: "fallback" | "forced";
  signature: string;
  startTimeSeconds: number;
};

type PlaybackE2ECountInEvent = PlaybackE2ECountInSchedule;
type PlaybackE2ETelemetryOverrides = Omit<PlaybackE2ETelemetryPatch, "countIn">;

function playbackTelemetryPathForBackend(
  backend: PlaybackControlBackend,
): PlaybackE2EActivePath {
  if (backend === "native") {
    return "native";
  }
  if (backend === "web") {
    return "web-audio";
  }
  return "none";
}

function playbackTelemetryTransportState(
  backend: PlaybackControlBackend,
  isPlaying: boolean,
): PlaybackE2ETransportState {
  if (isPlaying) {
    return "playing";
  }
  return backend === "none" ? "stopped" : "paused";
}

function playbackCountInCancelledEvent(
  schedule: PlaybackE2ECountInSchedule,
  context: AudioContext,
  reason: PlaybackE2ECountInCancelReason,
): PlaybackE2ECountInCancelled {
  return {
    sequence: schedule.sequence,
    trigger: schedule.trigger,
    playbackStartTimeSeconds: schedule.playbackStartTimeSeconds,
    cancelledAtContextTimeSeconds: context.state === "closed" ? null : context.currentTime,
    reason,
  };
}

function playbackCountInFiredEvent(
  schedule: PlaybackE2ECountInSchedule,
  context: AudioContext,
): PlaybackE2ECountInFired {
  return {
    sequence: schedule.sequence,
    trigger: schedule.trigger,
    playbackStartTimeSeconds: schedule.playbackStartTimeSeconds,
    firedAtContextTimeSeconds: context.state === "closed" ? null : context.currentTime,
  };
}

const mediaPlaybackRateRampFrames = new WeakMap<
  HTMLAudioElement,
  { frameId: number; targetPlaybackRate: number }
>();

function cancelMediaElementPlaybackRateRamp(element: HTMLAudioElement) {
  const activeRamp = mediaPlaybackRateRampFrames.get(element);
  if (!activeRamp || typeof window === "undefined") {
    return;
  }
  window.cancelAnimationFrame(activeRamp.frameId);
  mediaPlaybackRateRampFrames.delete(element);
}

function applyMediaElementPlaybackRate(
  element: HTMLAudioElement,
  playbackRate: number,
  { ramp = false }: { ramp?: boolean } = {},
) {
  const pitchPreservingElement = element as PitchPreservingAudioElement;
  pitchPreservingElement.preservesPitch = true;
  pitchPreservingElement.mozPreservesPitch = true;
  pitchPreservingElement.webkitPreservesPitch = true;
  if (!ramp || typeof window === "undefined") {
    const activeRamp = mediaPlaybackRateRampFrames.get(element);
    if (
      activeRamp &&
      Math.abs(activeRamp.targetPlaybackRate - playbackRate) <= 0.0001
    ) {
      return;
    }
    cancelMediaElementPlaybackRateRamp(element);
    element.playbackRate = playbackRate;
    return;
  }

  cancelMediaElementPlaybackRateRamp(element);
  const initialPlaybackRate = element.playbackRate;
  if (Math.abs(initialPlaybackRate - playbackRate) <= 0.0001) {
    element.playbackRate = playbackRate;
    return;
  }

  let startTimestamp: number | null = null;
  const scheduleStep = () => {
    const frameId = window.requestAnimationFrame((timestamp) => {
      startTimestamp ??= timestamp;
      const progress = Math.min(
        1,
        (timestamp - startTimestamp) / MEDIA_PLAYBACK_RATE_RAMP_MS,
      );
      element.playbackRate =
        initialPlaybackRate + (playbackRate - initialPlaybackRate) * progress;
      if (progress < 1) {
        scheduleStep();
        return;
      }
      mediaPlaybackRateRampFrames.delete(element);
      element.playbackRate = playbackRate;
    });
    mediaPlaybackRateRampFrames.set(element, { frameId, targetPlaybackRate: playbackRate });
  };
  scheduleStep();
}

function setGainValue(gainNode: GainNode, value: number) {
  gainNode.gain.value = value;
}

function rampGainValue(
  gainNode: GainNode,
  context: AudioContext,
  value: number,
  durationSeconds: number,
) {
  const gainParam = gainNode.gain;
  if (typeof gainParam.linearRampToValueAtTime !== "function") {
    setGainValue(gainNode, value);
    return;
  }

  const startTime = context.currentTime;
  gainParam.cancelScheduledValues(startTime);
  gainParam.setValueAtTime(gainParam.value, startTime);
  gainParam.linearRampToValueAtTime(value, startTime + durationSeconds);
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function nativeSessionSignature(session: ProjectPlaybackSession | null) {
  if (!session) {
    return "none";
  }
  const artifactIds = nativeActiveArtifactIds(session)
    .sort()
    .join(",");
  return `${session.projectId}:native:${artifactIds}`;
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

function nativeLaneUpdateForSession(session: ProjectPlaybackSession) {
  return {
    lanes: nativeLaneRequestsForSession(session),
    playbackRate: playbackRateForSession(session),
  };
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const initialWebMediaSourcesEnabled = isWebAudioBackendForced() || !isTauriRuntime();
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
  const nativeStopPromiseRef = useRef<Promise<void> | null>(null);
  const nativeControlGenerationRef = useRef(0);
  const pendingNativePlayRef = useRef<{
    generation: number;
    sessionSignature: string;
    playbackSignature: string;
    stopOnFailure: boolean;
  } | null>(null);
  const pendingNativePauseRef = useRef<{
    generation: number;
    sessionSignature: string | null;
  } | null>(null);
  const nativeCapabilitiesPromiseRef = useRef<ReturnType<typeof getNativeAudioCapabilities> | null>(null);
  const nativeBackendRef = useRef<string | null>(null);
  const pendingNativeFallbackCauseRef = useRef<string | null>(null);
  const pendingWebPlaybackRef = useRef<PendingWebPlayback | null>(null);
  const webStallTimersRef = useRef(new Map<HTMLAudioElement, number>());
  const webMediaSourcesEnabledRef = useRef(initialWebMediaSourcesEnabled);
  const pendingTransitionRef = useRef<PendingTransition | null>(null);
  const pendingTransitionCompletionIdRef = useRef<number | null>(null);
  const transitionCounterRef = useRef(0);
  const allowFreshPlaybackRef = useRef(true);
  const sessionRef = useRef<ProjectPlaybackSession | null>(null);
  const playbackTimeSecondsRef = useRef(0);
  const playbackDurationSecondsRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playbackControlBackendRef = useRef<PlaybackControlBackend>("none");
  const playbackTelemetryGenerationRef = useRef(0);
  const nativeSnapshotRef = useRef<NativeAudioSnapshot | null>(null);
  const countInTelemetryRef = useRef<PlaybackE2ECountInState>({
    active: false,
    lastScheduled: null,
    lastFired: null,
    lastCancelled: null,
  });
  const [session, setSession] = useState<ProjectPlaybackSession | null>(null);
  const [playbackTimeSeconds, setPlaybackTimeSecondsState] = useState(0);
  const [playbackDurationSeconds, setPlaybackDurationSecondsState] = useState(0);
  const [isPrecounting, setIsPrecountingState] = useState(false);
  const [isPlaying, setIsPlayingState] = useState(false);
  const [webMediaSourcesEnabled, setWebMediaSourcesEnabled] = useState(
    initialWebMediaSourcesEnabled,
  );
  const [playbackControlBackend, setPlaybackControlBackendState] =
    useState<PlaybackControlBackend>("none");

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    resetLivePlaybackDiagnostics();
    return () => resetLivePlaybackDiagnostics();
  }, []);

  const writePlaybackE2ETelemetry = useStableCallback(function writePlaybackE2ETelemetry(
    overrides: PlaybackE2ETelemetryOverrides = {},
  ) {
    playbackTelemetryGenerationRef.current += 1;
    const activeSession = sessionRef.current;
    const activePath =
      overrides.activePath ??
      playbackTelemetryPathForBackend(playbackControlBackendRef.current);
    const durationSeconds =
      overrides.durationSeconds ??
      (playbackDurationSecondsRef.current || activeSession?.durationHintSeconds || 0);
    const loopRange = overrides.loopRange ?? getPlayableLoopRange(activeSession);
    const nativeSnapshot = nativeSnapshotRef.current;
    patchPlaybackE2ETelemetry({
      activePath,
      transportState:
        overrides.transportState ??
        playbackTelemetryTransportState(
          playbackControlBackendRef.current,
          isPlayingRef.current,
        ),
      positionSeconds: overrides.positionSeconds ?? playbackTimeSecondsRef.current,
      durationSeconds,
      playbackRate:
        overrides.playbackRate ??
        (activePath === "native" && nativeSnapshot
          ? nativeSnapshot.playbackRate
          : playbackRateForSession(activeSession)),
      loopRange,
      nativeBufferHealth:
        overrides.nativeBufferHealth ?? nativeSnapshot?.bufferHealth ?? [],
      countIn: { ...countInTelemetryRef.current },
    });
  });

  useEffect(() => {
    playbackTimeSecondsRef.current = playbackTimeSeconds;
  }, [playbackTimeSeconds]);

  const setPlaybackTimeSeconds = useStableCallback(function setPlaybackTimeSeconds(
    nextTimeSeconds: number,
  ) {
    playbackTimeSecondsRef.current = nextTimeSeconds;
    setPlaybackTimeSecondsState(nextTimeSeconds);
    writePlaybackE2ETelemetry({ positionSeconds: nextTimeSeconds });
  });

  useEffect(() => {
    playbackDurationSecondsRef.current = playbackDurationSeconds;
  }, [playbackDurationSeconds]);

  const setPlaybackDurationSeconds = useStableCallback(function setPlaybackDurationSeconds(
    nextDurationSeconds: number,
  ) {
    playbackDurationSecondsRef.current = nextDurationSeconds;
    setPlaybackDurationSecondsState(nextDurationSeconds);
    writePlaybackE2ETelemetry({ durationSeconds: nextDurationSeconds });
  });

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const setIsPrecounting = useStableCallback(function setIsPrecounting(
    nextIsPrecounting: boolean,
  ) {
    setIsPrecountingState(nextIsPrecounting);
    writePlaybackE2ETelemetry();
  });

  const setIsPlaying = useStableCallback(function setIsPlaying(nextIsPlaying: boolean) {
    isPlayingRef.current = nextIsPlaying;
    setIsPlayingState(nextIsPlaying);
    writePlaybackE2ETelemetry({
      transportState: playbackTelemetryTransportState(
        playbackControlBackendRef.current,
        nextIsPlaying,
      ),
    });
  });

  const setPlaybackControlBackend = useStableCallback(function setPlaybackControlBackend(
    nextBackend: PlaybackControlBackend,
  ) {
    playbackControlBackendRef.current = nextBackend;
    setPlaybackControlBackendState(nextBackend);
    writePlaybackE2ETelemetry({
      activePath: playbackTelemetryPathForBackend(nextBackend),
      transportState: playbackTelemetryTransportState(nextBackend, isPlayingRef.current),
    });
  });

  const recordNativeSnapshot = useStableCallback(function recordNativeSnapshot(
    snapshot: NativeAudioSnapshot,
    overrides: PlaybackE2ETelemetryOverrides = {},
  ) {
    nativeSnapshotRef.current = snapshot;
    updateNativePlaybackDiagnostics(snapshot);
    writePlaybackE2ETelemetry({
      positionSeconds: snapshot.positionSeconds,
      durationSeconds: snapshot.durationSeconds || sessionRef.current?.durationHintSeconds || 0,
      playbackRate: snapshot.playbackRate,
      nativeBufferHealth: snapshot.bufferHealth,
      transportState: snapshot.state,
      ...overrides,
    });
  });

  const clearPlaybackControlBackend = useCallback(() => {
    setPlaybackControlBackend("none");
  }, [setPlaybackControlBackend]);

  const markWebPlaybackStartResult = useCallback((started: boolean) => {
    if (!started) {
      pendingWebPlaybackRef.current = null;
      setPlaybackControlBackend("none");
      setIsPlaying(false);
      markPlaybackError("Playback stopped. Web Audio could not start.");
    }
  }, [setIsPlaying, setPlaybackControlBackend]);

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

  const getAudioContextConstructor = useCallback(() => getWebAudioContextConstructor(), []);

  const canUseStemClock = useCallback(
    () =>
      !stemClockBlockedRef.current &&
      typeof fetch === "function" &&
      Boolean(getAudioContextConstructor()),
    [getAudioContextConstructor],
  );

  const canUseBufferedClock = useCallback(
    (targetSession: ProjectPlaybackSession | null) => {
      if (
        !webMediaSourcesEnabledRef.current ||
        !targetSession ||
        !canUseStemClock() ||
        !usesDefaultPlaybackRate(targetSession)
      ) {
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

  const enableWebMediaSources = useStableCallback(function enableWebMediaSources() {
    if (webMediaSourcesEnabledRef.current) {
      return;
    }
    webMediaSourcesEnabledRef.current = true;
    setWebMediaSourcesEnabled(true);
  });

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
    const capabilities = await nativeCapabilitiesPromiseRef.current;
    nativeBackendRef.current = capabilities.backend;
    return capabilities;
  });

  const recordNativePlaybackFailure = useStableCallback(function recordNativePlaybackFailure(
    error: unknown,
  ) {
    const message = playbackErrorMessage(error);
    pendingNativeFallbackCauseRef.current = message;
    rememberNativePlaybackError(message);
    return message;
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
    if (
      !capabilities?.nativePlaybackSupported ||
      capabilities.backend === "android-null"
    ) {
      recordNativePlaybackFailure(
        capabilities?.fallbackReason ?? "Native playback is unavailable.",
      );
      return false;
    }
    return true;
  });

  const markNativePlaybackInactive = useStableCallback(function markNativePlaybackInactive() {
    nativePlaybackRef.current = {
      ...nativePlaybackRef.current,
      active: false,
      playbackSignature: null,
    };
  });

  const requestNativeStop = useStableCallback(function requestNativeStop() {
    nativeControlGenerationRef.current += 1;
    pendingNativePauseRef.current = null;
    const stopTelemetryGeneration = playbackTelemetryGenerationRef.current;
    const stoppedSessionSignature = nativePlaybackRef.current.sessionSignature;
    const stopPromise = stopNativeAudio()
      .then((snapshot) => {
        if (
          nativeStopPromiseRef.current !== stopPromise ||
          playbackTelemetryGenerationRef.current !== stopTelemetryGeneration ||
          nativePlaybackRef.current.sessionSignature !== stoppedSessionSignature ||
          !snapshot.nativePlaybackSupported ||
          playbackControlBackendRef.current === "web" ||
          isPlayingRef.current ||
          nativePlaybackRef.current.active
        ) {
          return;
        }
        recordNativeSnapshot(snapshot, {
          activePath: "none",
          transportState: "stopped",
        });
      })
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (nativeStopPromiseRef.current === stopPromise) {
          nativeStopPromiseRef.current = null;
        }
      });
    nativeStopPromiseRef.current = stopPromise;
    return stopPromise;
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
    if (
      nativeStopPromiseRef.current &&
      nativePlaybackRef.current.sessionSignature === sessionSignature
    ) {
      await nativeStopPromiseRef.current;
    }
    if (nativePlaybackRef.current.sessionSignature === sessionSignature) {
      const snapshot = await setNativeAudioLanes(nativeLaneUpdateForSession(targetSession));
      recordNativeSnapshot(snapshot);
      return true;
    }

    const pendingPrepare = nativePlaybackRef.current;
    if (
      pendingPrepare.prepareSignature === sessionSignature &&
      pendingPrepare.preparePromise
    ) {
      const prepared = await pendingPrepare.preparePromise;
      if (prepared && nativePlaybackRef.current.sessionSignature === sessionSignature) {
        const snapshot = await setNativeAudioLanes(nativeLaneUpdateForSession(targetSession));
        recordNativeSnapshot(snapshot);
      }
      return prepared;
    }

    if (nativeStopPromiseRef.current) {
      await nativeStopPromiseRef.current;
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
        recordNativePlaybackFailure(
          preparedSession.fallbackReason ?? "Native playback prepare fell back to Web Audio.",
        );
        return false;
      }
      if (nativePlaybackRef.current.blockedSessionSignature === sessionSignature) {
        if (nativePlaybackRef.current.prepareSignature === sessionSignature) {
          void requestNativeStop();
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
          void requestNativeStop();
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
        const snapshot = await setNativeAudioLanes(nativeLaneUpdateForSession(targetSession));
        recordNativeSnapshot(snapshot);
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
        recordNativePlaybackFailure(error);
      }
      return false;
    }
  });

  const tryStartNativePlayback = useStableCallback(async function tryStartNativePlayback(
    targetSession: ProjectPlaybackSession,
    timeSeconds: number,
  ) {
    pendingNativePauseRef.current = null;
    markPlaybackStarting("native");
    const sessionSignature = nativeSessionSignature(targetSession);
    const wasNativeActive =
      nativePlaybackRef.current.active &&
      nativePlaybackRef.current.sessionSignature === sessionSignature;
    let playAttempt: {
      generation: number;
      sessionSignature: string;
      playbackSignature: string;
    } | null = null;
    try {
      if (!(await ensureNativePlaybackSession(targetSession))) {
        clearPlaybackControlBackend();
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
          void requestNativeStop();
        }
        return false;
      }
      const lanesSnapshot = await setNativeAudioLanes(nativeLaneUpdateForSession(latestSession));
      recordNativeSnapshot(lanesSnapshot);
      const playGeneration = nativeControlGenerationRef.current + 1;
      nativeControlGenerationRef.current = playGeneration;
      const playPlaybackSignature = playbackSignature(latestSession);
      playAttempt = {
        generation: playGeneration,
        sessionSignature,
        playbackSignature: playPlaybackSignature,
      };
      pendingNativePlayRef.current = {
        generation: playGeneration,
        sessionSignature,
        playbackSignature: playPlaybackSignature,
        stopOnFailure: false,
      };
      const playbackAudioContext = stemAudioContextRef.current;
      stemAudioContextRef.current = null;
      stemPlaybackRef.current = null;
      stemBufferCacheRef.current.clear();
      if (playbackAudioContext && playbackAudioContext.state !== "closed") {
        await playbackAudioContext.close();
      }
      let snapshot: NativeAudioSnapshot;
      try {
        snapshot = await playNativeAudio({
          startTimeSeconds: wasNativeActive
            ? null
            : clampTime(timeSeconds, latestSession.durationHintSeconds || 0),
        });
      } catch (error) {
        const pendingNativePlay = pendingNativePlayRef.current;
        if (pendingNativePlay?.generation === playGeneration) {
          pendingNativePlayRef.current = null;
          if (pendingNativePlay.stopOnFailure) {
            void requestNativeStop();
          }
        }
        throw error;
      }
      if (pendingNativePlayRef.current?.generation === playGeneration) {
        pendingNativePlayRef.current = null;
      }
      const currentSession = sessionRef.current;
      if (
        nativeControlGenerationRef.current !== playGeneration ||
        nativePlaybackRef.current.sessionSignature !== sessionSignature ||
        !currentSession ||
        nativeSessionSignature(currentSession) !== sessionSignature ||
        playbackSignature(currentSession) !== playPlaybackSignature
      ) {
        const newerNativePlaybackCurrent =
          currentSession &&
          nativePlaybackRef.current.active &&
          nativePlaybackRef.current.sessionSignature === nativeSessionSignature(currentSession) &&
          nativePlaybackRef.current.playbackSignature === playbackSignature(currentSession);
        const pendingNativePlay = pendingNativePlayRef.current;
        const newerPendingNativePlaybackCurrent =
          currentSession &&
          pendingNativePlay &&
          pendingNativePlay.sessionSignature === nativeSessionSignature(currentSession) &&
          pendingNativePlay.playbackSignature === playbackSignature(currentSession);
        if (
          snapshot.nativePlaybackSupported &&
          snapshot.state === "playing" &&
          newerPendingNativePlaybackCurrent
        ) {
          pendingNativePlay.stopOnFailure = true;
        }
        if (
          snapshot.nativePlaybackSupported &&
          snapshot.state === "playing" &&
          !newerNativePlaybackCurrent &&
          !newerPendingNativePlaybackCurrent
        ) {
          void requestNativeStop();
        }
        return true;
      }
      nativePlaybackRef.current.active = snapshot.nativePlaybackSupported;
      nativePlaybackRef.current.playbackSignature = playPlaybackSignature;
      if (!snapshot.nativePlaybackSupported) {
        recordNativeSnapshot(snapshot, {
          activePath: "none",
          transportState: snapshot.state,
        });
        recordNativePlaybackFailure(
          snapshot.fallbackReason ?? "Native playback start fell back to Web Audio.",
        );
        nativePlaybackRef.current.blockedSessionSignature = sessionSignature;
        markNativePlaybackInactive();
        clearPlaybackControlBackend();
        void requestNativeStop();
        return false;
      }
      if (
        nativeControlGenerationRef.current !== playGeneration ||
        nativePlaybackRef.current.sessionSignature !== sessionSignature ||
        playbackSignature(sessionRef.current) !== playPlaybackSignature
      ) {
        return true;
      }
      disposeStemPlaybackState();
      pauseRenderedMediaElements(latestSession);
      setPlaybackTimeSeconds(snapshot.positionSeconds);
      setPlaybackDurationSeconds(snapshot.durationSeconds || latestSession.durationHintSeconds || 0);
      recordNativeSnapshot(snapshot, {
        activePath:
          snapshot.sessionId === sessionSignature && snapshot.state === "playing"
            ? "native"
            : "none",
        transportState: snapshot.state,
      });
      if (snapshot.sessionId === sessionSignature && snapshot.state === "playing") {
        setPlaybackControlBackend("native");
        setIsPlaying(true);
        markPlaybackConfirmed({
          backend: "native",
          detail: nativeBackendRef.current,
        });
      } else {
        markPlaybackStarting("native");
      }
      return true;
    } catch (error) {
      const currentSession = sessionRef.current;
      if (
        playAttempt &&
        (nativeControlGenerationRef.current !== playAttempt.generation ||
          nativePlaybackRef.current.sessionSignature !== playAttempt.sessionSignature ||
          !currentSession ||
          nativeSessionSignature(currentSession) !== playAttempt.sessionSignature ||
          playbackSignature(currentSession) !== playAttempt.playbackSignature)
      ) {
        return true;
      }
      recordNativePlaybackFailure(error);
      nativePlaybackRef.current.blockedSessionSignature = sessionSignature;
      markNativePlaybackInactive();
      clearPlaybackControlBackend();
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

  const activatePlaybackAudioContext = useStableCallback(async function activatePlaybackAudioContext(
    context: AudioContext,
  ) {
    await activateWebAudioContext(context);
  });

  const primeWebAudioForGesture = useStableCallback(async function primeWebAudioForGesture() {
    if (!canUseStemClock()) {
      return;
    }

    const context = getStemAudioContext();
    if (!context) {
      return;
    }

    primeWebAudioContext(context);
    try {
      await activatePlaybackAudioContext(context);
    } catch {
      stemClockBlockedRef.current = true;
    }
  });

  const cancelPrecount = useStableCallback(function cancelPrecount(
    reason: PlaybackE2ECountInCancelReason,
  ) {
    const activePrecount = activePrecountRef.current;
    activePrecountRef.current = null;
    precountSequenceRef.current += 1;
    if (activePrecount) {
      countInTelemetryRef.current = {
        ...countInTelemetryRef.current,
        active: false,
        lastCancelled: playbackCountInCancelledEvent(
          activePrecount.telemetry,
          activePrecount.context,
          reason,
        ),
      };
    }
    setIsPrecounting(false);

    if (!activePrecount) {
      return;
    }

    window.clearTimeout(activePrecount.timeoutId);
    activePrecount.clickHandles.forEach((handle) => handle.cancel());
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

    try {
      await activatePlaybackAudioContext(context);
    } catch {
      stemClockBlockedRef.current = true;
    }
  }, [activatePlaybackAudioContext, canUseStemClock, getStemAudioContext]);

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
    if (restartActiveLoopPlayback(sessionRef.current)) {
      return;
    }

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
    clearPlaybackControlBackend();
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
      if (restartLoopIfNeeded(sessionRef.current, nextTime)) {
        return;
      }

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

  const fadeOutStemPlaybackState = useStableCallback(function fadeOutStemPlaybackState(
    targetPlaybackState: StemPlaybackState,
  ) {
    const nextTime = getStemPlaybackTime(targetPlaybackState);
    clearStemClock(targetPlaybackState);
    targetPlaybackState.offsetSeconds = nextTime;
    targetPlaybackState.startedAtContextTime = targetPlaybackState.context.currentTime;
    targetPlaybackState.isPlaying = false;
    syncStemElementTimes(targetPlaybackState.artifactIds, nextTime);

    if (typeof window === "undefined") {
      stopStemSources(targetPlaybackState, true);
      disconnectStemGains(targetPlaybackState);
      return;
    }

    const sources = targetPlaybackState.sources;
    targetPlaybackState.sources = {};
    const stopTime =
      targetPlaybackState.context.currentTime + STEM_PLAYBACK_CROSSFADE_SECONDS;
    Object.values(targetPlaybackState.gains).forEach((gainNode) => {
      rampGainValue(
        gainNode,
        targetPlaybackState.context,
        0,
        STEM_PLAYBACK_CROSSFADE_SECONDS,
      );
    });
    Object.values(sources).forEach((source) => {
      source.onended = null;
      try {
        source.stop(stopTime);
      } catch {
        return;
      }
    });
    window.setTimeout(() => {
      Object.values(sources).forEach((source) => {
        try {
          source.disconnect();
        } catch {
          return;
        }
      });
      disconnectStemGains(targetPlaybackState);
    }, STEM_PLAYBACK_CROSSFADE_SECONDS * 1000);
  });

  const disposeStemPlaybackState = useStableCallback(function disposeStemPlaybackState(
    { crossfade = false }: { crossfade?: boolean } = {},
  ) {
    const targetPlaybackState = stemPlaybackRef.current;
    if (!targetPlaybackState) {
      return;
    }

    stemPlaybackRef.current = null;
    if (crossfade && targetPlaybackState.isPlaying) {
      fadeOutStemPlaybackState(targetPlaybackState);
      return;
    }

    stopStemSources(targetPlaybackState, true);
    disconnectStemGains(targetPlaybackState);
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
    { fadeIn = false }: { fadeIn?: boolean } = {},
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
      await activatePlaybackAudioContext(targetPlaybackState.context);
    } catch {
      stemClockBlockedRef.current = true;
      disposeStemPlaybackState();
      markWebPlaybackStartResult(false);
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
      markWebPlaybackStartResult(false);
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
    if (fadeIn) {
      targetPlaybackState.artifactIds.forEach((artifactId) => {
        const gainNode = targetPlaybackState.gains[artifactId];
        if (gainNode) {
          setGainValue(gainNode, 0);
        }
      });
    }
    applyStemVolumes(targetSession, { rampGains: fadeIn });

    let scheduledCount = 0;
    try {
      Object.values(nextSources).forEach((sourceNode) => {
        sourceNode.start(sourceStartTimeSeconds, nextTime);
        scheduledCount += 1;
      });
    } catch {
      stemClockBlockedRef.current = true;
      disposeStemPlaybackState();
      markWebPlaybackStartResult(false);
      setIsPlaying(false);
      return false;
    }
    if (scheduledCount !== Object.keys(nextSources).length || scheduledCount === 0) {
      stemClockBlockedRef.current = true;
      disposeStemPlaybackState();
      markWebPlaybackStartResult(false);
      setIsPlaying(false);
      return false;
    }

    setPlaybackTimeSeconds(nextTime);
    setPlaybackDurationSeconds(targetPlaybackState.durationSeconds);
    markWebPlaybackStartResult(true);
    setPlaybackControlBackend("web");
    setIsPlaying(true);
    if (!isWebAudioBackendForced()) {
      rememberNativeFallbackCause(
        pendingNativeFallbackCauseRef.current ?? "Native playback is unavailable.",
      );
    }
    markPlaybackConfirmed({
      backend: "web",
      detail: null,
      mode: isWebAudioBackendForced() ? "forced" : "fallback",
    });
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
    { ramp = false }: { ramp?: boolean } = {},
  ) {
    const playbackRate = playbackRateForSession(targetSession);
    getRenderedMediaElements(targetSession).forEach((element) => {
      applyMediaElementPlaybackRate(element, playbackRate, { ramp });
    });
  });

  const applyStemVolumes = useStableCallback(function applyStemVolumes(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
    { rampGains = false }: { rampGains?: boolean } = {},
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
          if (rampGains) {
            rampGainValue(
              gainNode,
              targetPlaybackState.context,
              volume,
              STEM_PLAYBACK_CROSSFADE_SECONDS,
            );
          } else {
            setGainValue(gainNode, volume);
          }
        }
      });
    }

    if (
      nativePlaybackRef.current.active &&
      nativePlaybackRef.current.sessionSignature === nativeSessionSignature(targetSession)
    ) {
      void setNativeAudioLanes(nativeLaneUpdateForSession(targetSession))
        .then((snapshot) => recordNativeSnapshot(snapshot))
        .catch((error) => {
          rememberNativePlaybackError(playbackErrorMessage(error));
        });
    }
  });

  const getPlayableLoopRange = useStableCallback(function getPlayableLoopRange(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    const loopRange = targetSession?.loopRange;
    if (!targetSession || !loopRange) {
      return null;
    }

    const durationSeconds =
      sessionRef.current?.projectId === targetSession.projectId
        ? playbackDurationSecondsRef.current || targetSession.durationHintSeconds || 0
        : targetSession.durationHintSeconds || 0;
    const startSeconds = clampTime(loopRange.startSeconds, durationSeconds);
    const endSeconds = clampTime(loopRange.endSeconds, durationSeconds);
    if (endSeconds - startSeconds <= SEEK_TOLERANCE_SECONDS) {
      return null;
    }

    return { startSeconds, endSeconds };
  });

  const playbackResetTimeForSession = useStableCallback(function playbackResetTimeForSession(
    targetSession: ProjectPlaybackSession | null = sessionRef.current,
  ) {
    return getPlayableLoopRange(targetSession)?.startSeconds ?? 0;
  });

  const playbackStartTimeForSession = useStableCallback(function playbackStartTimeForSession(
    targetSession: ProjectPlaybackSession,
    requestedTimeSeconds: number,
  ) {
    const loopRange = getPlayableLoopRange(targetSession);
    if (!loopRange) {
      const durationSeconds =
        sessionRef.current?.projectId === targetSession.projectId
          ? playbackDurationSecondsRef.current || targetSession.durationHintSeconds || 0
          : targetSession.durationHintSeconds || 0;
      return clampTime(requestedTimeSeconds, durationSeconds);
    }

    const durationSeconds = playbackDurationSecondsRef.current || targetSession.durationHintSeconds || 0;
    const nextTime = clampTime(requestedTimeSeconds, durationSeconds);
    if (
      nextTime < loopRange.startSeconds - SEEK_TOLERANCE_SECONDS ||
      nextTime >= loopRange.endSeconds - SEEK_TOLERANCE_SECONDS
    ) {
      return loopRange.startSeconds;
    }
    return nextTime;
  });

  const restartLoopIfNeeded = useStableCallback(function restartLoopIfNeeded(
    targetSession: ProjectPlaybackSession | null,
    timeSeconds: number,
  ) {
    const loopRange = getPlayableLoopRange(targetSession);
    if (!loopRange || timeSeconds < loopRange.endSeconds - SEEK_TOLERANCE_SECONDS) {
      return false;
    }

    void restartActiveLoopPlayback(targetSession);
    return true;
  });

  const restartActiveLoopPlayback = useStableCallback(function restartActiveLoopPlayback(
    targetSession: ProjectPlaybackSession | null,
  ) {
    const loopRange = getPlayableLoopRange(targetSession);
    if (!loopRange) {
      return false;
    }

    void (async () => {
      if (
        targetSession &&
        targetSession.precountLoopEnabled &&
        typeof targetSession.precountTempoBpm === "number" &&
        Number.isFinite(targetSession.precountTempoBpm) &&
        targetSession.precountTempoBpm > 0
      ) {
        if (nativePlaybackRef.current.active) {
          void requestNativeStop();
          markNativePlaybackInactive();
        }
        if (stemPlaybackRef.current) {
          stopStemSources(stemPlaybackRef.current, false);
          stemPlaybackRef.current.offsetSeconds = loopRange.startSeconds;
          syncStemElementTimes(stemPlaybackRef.current.artifactIds, loopRange.startSeconds);
        }
        getRenderedMediaElements(targetSession).forEach((element) => {
          element.pause();
          element.currentTime = loopRange.startSeconds;
        });
        setPlaybackTimeSeconds(loopRange.startSeconds);
        clearPlaybackControlBackend();
        setIsPlaying(false);
        if (
          await startPrecountThenPlayback(targetSession, loopRange.startSeconds, {
            loopWrap: true,
          })
        ) {
          return;
        }
      }
      seekTo(loopRange.startSeconds);
      if (
        targetSession &&
        isPlayingRef.current &&
        playbackSignature(sessionRef.current) === playbackSignature(targetSession)
      ) {
        const bufferedClockIsActive =
          canUseBufferedClock(targetSession) &&
          stemPlaybackRef.current?.signature === playbackSignature(targetSession);
        if (!bufferedClockIsActive) {
          void playPlaybackImmediately({ forceStartAtZero: true });
        }
      }
    })();
    return true;
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

    if (!isPlayingRef.current) {
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

  const beginWebPlaybackAttempt = useStableCallback(function beginWebPlaybackAttempt(
    elements: HTMLAudioElement[],
  ) {
    const targetSession = sessionRef.current;
    if (!targetSession || !elements.length) {
      return;
    }
    const mode = isWebAudioBackendForced() ? "forced" : "fallback";
    const fallbackCause =
      mode === "fallback"
        ? pendingNativeFallbackCauseRef.current ?? "Native playback is unavailable."
        : null;
    if (fallbackCause) {
      rememberNativeFallbackCause(fallbackCause);
    }
    pendingWebPlaybackRef.current = {
      fallbackCause,
      mode,
      signature: playbackSignature(targetSession),
      startTimeSeconds: elements[0]?.currentTime ?? playbackTimeSecondsRef.current,
    };
    markPlaybackStarting(mode === "forced" ? "web-forced" : "web-fallback");
  });

  const playWebMediaElements = useStableCallback(async function playWebMediaElements(
    elements: HTMLAudioElement[],
  ) {
    if (!elements.length) {
      return false;
    }

    beginWebPlaybackAttempt(elements);
    const results = await Promise.allSettled(
      elements.map((element) => Promise.resolve(element.play())),
    );
    const requested = results.some((result) => result.status === "fulfilled");
    if (!requested) {
      const rejection = results.find((result) => result.status === "rejected");
      rememberWebPlaybackError(
        rejection?.status === "rejected"
          ? playbackErrorMessage(rejection.reason)
          : "Web Audio could not start.",
      );
    }
    return requested;
  });

  const clearWebStallTimer = useStableCallback(function clearWebStallTimer(
    element: HTMLAudioElement,
  ) {
    const timerId = webStallTimersRef.current.get(element);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      webStallTimersRef.current.delete(element);
    }
  });

  const confirmWebPlayback = useStableCallback(function confirmWebPlayback(
    element: HTMLAudioElement,
    requireProgress: boolean,
  ) {
    clearWebStallTimer(element);
    const targetSession = sessionRef.current;
    const attempt = pendingWebPlaybackRef.current;
    const activeElements = getActiveMediaElements(targetSession);
    if (
      !targetSession ||
      !attempt ||
      attempt.signature !== playbackSignature(targetSession) ||
      activeElements[0] !== element ||
      (requireProgress &&
        Math.abs(element.currentTime - attempt.startTimeSeconds) <= 0.01)
    ) {
      return;
    }
    pendingWebPlaybackRef.current = null;
    pendingNativeFallbackCauseRef.current = null;
    setPlaybackControlBackend("web");
    setIsPlaying(true);
    markPlaybackConfirmed({
      backend: "web",
      detail: null,
      mode: attempt.mode,
    });
  });

  const failWebPlayback = useStableCallback(function failWebPlayback(
    element: HTMLAudioElement,
    message: string,
  ) {
    const targetSession = sessionRef.current;
    if (!targetSession || !getActiveMediaElements(targetSession).includes(element)) {
      return;
    }
    const hasWebOwnership =
      pendingWebPlaybackRef.current?.signature === playbackSignature(targetSession) ||
      playbackControlBackendRef.current === "web";
    if (!hasWebOwnership) {
      return;
    }
    getActiveMediaElements(targetSession).forEach((activeElement) => {
      clearWebStallTimer(activeElement);
      activeElement.pause();
    });
    pendingWebPlaybackRef.current = null;
    clearPlaybackControlBackend();
    setIsPlaying(false);
    rememberWebPlaybackError(message);
    markPlaybackError("Playback stopped. Web Audio could not continue.");
  });

  const scheduleWebStallFailure = useStableCallback(function scheduleWebStallFailure(
    element: HTMLAudioElement,
  ) {
    clearWebStallTimer(element);
    const timerId = window.setTimeout(() => {
      webStallTimersRef.current.delete(element);
      if (element.paused || element.seeking || element.ended) {
        return;
      }
      failWebPlayback(element, "Web Audio stopped making playback progress.");
    }, 5_000);
    webStallTimersRef.current.set(element, timerId);
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
    const transitionId = pendingTransitionRef.current?.id;
    if (!transitionId || pendingTransitionCompletionIdRef.current === transitionId) {
      return;
    }
    pendingTransitionCompletionIdRef.current = transitionId;
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
          clearPlaybackControlBackend();
          setIsPlaying(false);
          return;
        }

        const started = await startStemPlayback(latestSession, nextTime, undefined, {
          fadeIn: latestPendingTransition.crossfadeStemPlayback,
        });
        if (started) {
          return;
        }
        if (stemClockBlockedRef.current) {
          markWebPlaybackStartResult(false);
          setIsPlaying(false);
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

        const fallbackStarted = await playWebMediaElements(fallbackElements);
        markWebPlaybackStartResult(fallbackStarted);
        return;
      }

      if (!webMediaSourcesEnabledRef.current) {
        enableWebMediaSources();
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
        clearPlaybackControlBackend();
        setIsPlaying(false);
        return;
      }

      applyMediaPlaybackRate(targetSession);
      const started = await playWebMediaElements(targetElements);
      if (pendingTransitionRef.current?.id === transitionId) {
        return;
      }
      if (playbackSignature(sessionRef.current) !== transitionSignature) {
        return;
      }
      markWebPlaybackStartResult(started);
    })().finally(() => {
      if (pendingTransitionCompletionIdRef.current === transitionId) {
        pendingTransitionCompletionIdRef.current = null;
      }
    });
  });

  const pausePlayback = useCallback(() => {
    allowFreshPlaybackRef.current = false;
    cancelPrecount("playback-stopped");
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.shouldPlay = false;
    }

    const targetSession = sessionRef.current;
    if (nativePlaybackRef.current.active) {
      const pauseGeneration = nativeControlGenerationRef.current + 1;
      nativeControlGenerationRef.current = pauseGeneration;
      const pausedSessionSignature = nativePlaybackRef.current.sessionSignature;
      pendingNativePauseRef.current = {
        generation: pauseGeneration,
        sessionSignature: pausedSessionSignature,
      };
      void pauseNativeAudio()
        .then((snapshot) => {
          if (pendingNativePauseRef.current?.generation === pauseGeneration) {
            pendingNativePauseRef.current = null;
          }
          if (
            nativeControlGenerationRef.current !== pauseGeneration ||
            nativePlaybackRef.current.sessionSignature !== pausedSessionSignature ||
            playbackControlBackendRef.current !== "native"
          ) {
            return;
          }
          if (!snapshot.nativePlaybackSupported) {
            recordNativePlaybackFailure(
              snapshot.fallbackReason ?? "Native playback became unavailable while pausing.",
            );
            nativePlaybackRef.current.blockedSessionSignature = pausedSessionSignature;
            setPlaybackTimeSeconds(snapshot.positionSeconds);
            markNativePlaybackInactive();
            clearPlaybackControlBackend();
            setIsPlaying(false);
            markPlaybackError(
              "Native playback became unavailable. Press Play to continue with Web Audio.",
            );
            void requestNativeStop();
            void releaseSystemMediaControls().catch(() => undefined);
            return;
          }
          recordNativeSnapshot(snapshot, {
            activePath: "native",
            transportState: "paused",
          });
          setPlaybackTimeSeconds(snapshot.positionSeconds);
          setIsPlaying(false);
          markNativePlaybackInactive();
          markPlaybackPaused();
        })
        .catch(() => {
          if (pendingNativePauseRef.current?.generation === pauseGeneration) {
            pendingNativePauseRef.current = null;
          }
        });
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
      markPlaybackPaused();
      return;
    }

    getActiveMediaElements().forEach((element) => element.pause());
    webStallTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    webStallTimersRef.current.clear();
    pendingWebPlaybackRef.current = null;
    setIsPlaying(false);
    markPlaybackPaused();
  }, [
    canUseBufferedClock,
    cancelPrecount,
    clearPlaybackControlBackend,
    getActiveMediaElements,
    markNativePlaybackInactive,
    recordNativePlaybackFailure,
    recordNativeSnapshot,
    requestNativeStop,
    setIsPlaying,
    setPlaybackTimeSeconds,
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
    if (
      pendingTransitionRef.current?.shouldPlay &&
      pendingTransitionCompletionIdRef.current === pendingTransitionRef.current.id
    ) {
      return;
    }

    const requestedMasterTime = forceStartAtZero
      ? playbackResetTimeForSession(targetSession)
      : readMasterTime(targetSession);
    const masterTime = playbackStartTimeForSession(targetSession, requestedMasterTime);
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
      if (stemClockBlockedRef.current) {
        markNativePlaybackInactive();
        markWebPlaybackStartResult(false);
        setIsPlaying(false);
        return;
      }
    }

    if (!webMediaSourcesEnabledRef.current) {
      const activeKeys = getActiveMediaKeys(targetSession);
      if (!activeKeys.length) {
        return;
      }
      pendingTransitionRef.current = {
        id: ++transitionCounterRef.current,
        signature: playbackSignature(targetSession),
        shouldPlay: true,
        targetTime: masterTime,
        awaitSeekBeforePlay: true,
        crossfadeStemPlayback: false,
        awaitingLoadKeys: activeKeys,
        awaitingSeekKeys: activeKeys,
        forceSeekKeys: activeKeys,
      };
      enableWebMediaSources();
      return;
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

    markNativePlaybackInactive();
    const started = await playWebMediaElements(activeElements);
    markWebPlaybackStartResult(started);
  });

  const startPrecountThenPlayback = useStableCallback(async function startPrecountThenPlayback(
    targetSession: ProjectPlaybackSession,
    startTimeSeconds: number,
    options: { loopWrap?: boolean } = {},
  ) {
    if (options.loopWrap !== true && !allowFreshPlaybackRef.current) {
      return false;
    }
    const tempoBpm = targetSession.precountTempoBpm;
    if (typeof tempoBpm !== "number" || !Number.isFinite(tempoBpm) || tempoBpm <= 0) {
      return false;
    }

    const loopRange = getPlayableLoopRange(targetSession);
    const isSongStart = Math.abs(startTimeSeconds) <= SEEK_TOLERANCE_SECONDS;
    const isLoopStart = Boolean(
      loopRange &&
        Math.abs(startTimeSeconds - loopRange.startSeconds) <= SEEK_TOLERANCE_SECONDS,
    );
    const shouldUseLoopPrecount =
      targetSession.precountLoopEnabled && Boolean(isLoopStart);
    const shouldUseSongPrecount =
      options.loopWrap !== true && targetSession.precountEnabled && isSongStart;
    if (!shouldUseLoopPrecount && !shouldUseSongPrecount) {
      return false;
    }
    if (!isSongStart && !isLoopStart) {
      return false;
    }
    allowFreshPlaybackRef.current = false;

    const clickCount = normalizePrecountClickCount(targetSession.precountClickCount);
    const signature = playbackSignature(targetSession);
    cancelPrecount("superseded");
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
      await activatePlaybackAudioContext(precountAudio.context);
    } catch {
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
      if (Math.abs(element.currentTime - startTimeSeconds) > SEEK_TOLERANCE_SECONDS) {
        element.currentTime = startTimeSeconds;
      }
    });
    if (preparedStemPlaybackState) {
      preparedStemPlaybackState.offsetSeconds = startTimeSeconds;
      syncStemElementTimes(preparedStemPlaybackState.artifactIds, startTimeSeconds);
      setPlaybackDurationSeconds(preparedStemPlaybackState.durationSeconds);
    }
    setPlaybackTimeSeconds(startTimeSeconds);

    const beatSeconds = 60 / tempoBpm;
    const countInIntervals = countInIntervalsForTiming({
      clickCount,
      fallbackBeatSeconds: beatSeconds,
      startTimeSeconds,
      timingGrid: targetSession.timingGrid,
    });
    const firstClickTimeSeconds = precountAudio.context.currentTime + PRECOUNT_START_DELAY_SECONDS;
    const playbackStartTimeSeconds =
      firstClickTimeSeconds + countInIntervals.reduce((total, interval) => total + interval, 0);
    const countInTelemetry: PlaybackE2ECountInEvent = {
      clickCount,
      trigger: shouldUseLoopPrecount ? "loop-start" : "song-start",
      activePath: playbackTelemetryPathForBackend(playbackControlBackendRef.current),
      scheduledAtContextTimeSeconds: precountAudio.context.currentTime,
      firstClickTimeSeconds,
      playbackStartTimeSeconds,
      sequence,
      startTimeSeconds,
      tempoBpm,
    };
    let nextClickTimeSeconds = firstClickTimeSeconds;
    const clickHandles: PrecountClaveClickHandle[] = [];
    for (let index = 0; index < clickCount; index += 1) {
      clickHandles.push(
        schedulePrecountClaveClick({
          audioContext: precountAudio.context,
          startTimeSeconds: nextClickTimeSeconds,
        }),
      );
      nextClickTimeSeconds += countInIntervals[index] ?? beatSeconds;
    }

    const timeoutId = window.setTimeout(() => {
      const activePrecount = activePrecountRef.current;
      if (!activePrecount || activePrecount.sequence !== sequence || activePrecount.signature !== signature) {
        return;
      }

      activePrecountRef.current = null;
      countInTelemetryRef.current = {
        ...countInTelemetryRef.current,
        active: false,
        lastFired: playbackCountInFiredEvent(activePrecount.telemetry, activePrecount.context),
      };
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
      clickHandles,
      context: precountAudio.context,
      ownsContext: precountAudio.ownsContext,
      sequence,
      signature,
      telemetry: countInTelemetry,
      timeoutId,
    };
    countInTelemetryRef.current = {
      ...countInTelemetryRef.current,
      active: true,
      lastScheduled: countInTelemetry,
    };
    setIsPrecounting(true);
    writePlaybackE2ETelemetry({ positionSeconds: startTimeSeconds });
    return true;
  });

  const playPlayback = useCallback(async () => {
    if (activePrecountRef.current) {
      cancelPrecount("cancelled");
      return;
    }

    const targetSession = sessionRef.current;
    if (!targetSession) {
      return;
    }

    tryCompletePendingTransition();

    const masterTime = playbackStartTimeForSession(
      targetSession,
      readMasterTime(targetSession),
    );
    if (await startPrecountThenPlayback(targetSession, masterTime)) {
      return;
    }

    allowFreshPlaybackRef.current = false;
    await playPlaybackImmediately();
  }, [
    cancelPrecount,
    playPlaybackImmediately,
    playbackStartTimeForSession,
    readMasterTime,
    startPrecountThenPlayback,
    tryCompletePendingTransition,
  ]);

  const togglePlayback = useCallback(async () => {
    if (activePrecountRef.current) {
      cancelPrecount("playback-stopped");
      return;
    }
    if (isPlayingRef.current) {
      pausePlayback();
      return;
    }
    if (isWebAudioBackendForced() || !isTauriRuntime()) {
      await primeWebAudioForGesture();
    }
    await playPlayback();
  }, [cancelPrecount, pausePlayback, playPlayback, primeWebAudioForGesture]);

  const seekTo = useCallback((timeSeconds: number) => {
    cancelPrecount("superseded");
    const targetSession = sessionRef.current;
    const nextTime = targetSession
      ? playbackStartTimeForSession(targetSession, timeSeconds)
      : clampTime(timeSeconds, playbackDurationSecondsRef.current);
    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      pendingTransition.targetTime = nextTime;
    }

    if (nativePlaybackRef.current.active) {
      const seekGeneration = nativeControlGenerationRef.current + 1;
      nativeControlGenerationRef.current = seekGeneration;
      const seekSessionSignature = nativePlaybackRef.current.sessionSignature;
      void seekNativeAudio({ timeSeconds: nextTime })
        .then((snapshot) => {
          if (
            nativeControlGenerationRef.current !== seekGeneration ||
            nativePlaybackRef.current.sessionSignature !== seekSessionSignature
          ) {
            return;
          }
          recordNativeSnapshot(snapshot, {
            activePath: "native",
            transportState: snapshot.state,
          });
          setPlaybackTimeSeconds(snapshot.positionSeconds);
        })
        .catch(() => {
          if (
            nativeControlGenerationRef.current !== seekGeneration ||
            nativePlaybackRef.current.sessionSignature !== seekSessionSignature
          ) {
            return;
          }
          markNativePlaybackInactive();
          clearPlaybackControlBackend();
        });
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
    clearPlaybackControlBackend,
    getActiveMediaElements,
    markNativePlaybackInactive,
    playbackStartTimeForSession,
    recordNativeSnapshot,
    setPlaybackTimeSeconds,
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
    allowFreshPlaybackRef.current = true;
    cancelPrecount("playback-stopped");
    clearPendingTransition();
    const targetSession = sessionRef.current;
    const resetTime = playbackResetTimeForSession(targetSession);
    const targetNativeSessionSignature = targetSession
      ? nativeSessionSignature(targetSession)
      : null;
    const shouldStopNativeSession =
      nativePlaybackRef.current.active ||
      (nativePlaybackRef.current.sessionSignature !== null &&
        (targetNativeSessionSignature === null ||
          nativePlaybackRef.current.sessionSignature === targetNativeSessionSignature));
    if (shouldStopNativeSession) {
      void requestNativeStop();
      markNativePlaybackInactive();
    }
    if (stemPlaybackRef.current) {
      stopStemSources(stemPlaybackRef.current, false);
      stemPlaybackRef.current.offsetSeconds = resetTime;
      syncStemElementTimes(stemPlaybackRef.current.artifactIds, resetTime);
    }
    getRenderedMediaElements().forEach((element) => {
      clearWebStallTimer(element);
      element.pause();
      element.currentTime = resetTime;
    });
    pendingWebPlaybackRef.current = null;
    setPlaybackTimeSeconds(resetTime);
    clearPlaybackControlBackend();
    setIsPlaying(false);
    markPlaybackStopped();
    clearNativePlaybackSessionDiagnostics();
    updateDurationFromActiveMedia();
  }, [
    cancelPrecount,
    clearPlaybackControlBackend,
    clearPendingTransition,
    clearWebStallTimer,
    getRenderedMediaElements,
    markNativePlaybackInactive,
    playbackResetTimeForSession,
    requestNativeStop,
    setIsPlaying,
    setPlaybackTimeSeconds,
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
  }, [closePlaybackAudioContext, setPlaybackDurationSeconds, stopPlayback]);

  const registerProjectSession = useCallback((nextSession: ProjectPlaybackSession) => {
    const previousSession = sessionRef.current;
    const previousSignature = playbackSignature(previousSession);
    const nextSignature = playbackSignature(nextSession);

    if (previousSession && previousSession.projectId !== nextSession.projectId) {
      const resetTime = playbackResetTimeForSession(nextSession);
      cancelPrecount("session-changed");
      clearPendingTransition();
      closePlaybackAudioContext();
      allowFreshPlaybackRef.current = true;
      getRenderedMediaElements(previousSession).forEach((element) => {
        element.pause();
        element.currentTime = 0;
      });
      setPlaybackTimeSeconds(resetTime);
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      clearPlaybackControlBackend();
      setIsPlaying(false);
      markPlaybackStopped();
    } else if (previousSession && previousSignature !== nextSignature) {
      cancelPrecount("session-changed");
      const activePendingTransition = pendingTransitionRef.current;
      const requestedTransitionTime =
        activePendingTransition?.signature === nextSignature
          ? activePendingTransition.targetTime
          : readMasterTime(previousSession);
      const nextTime = playbackStartTimeForSession(
        nextSession,
        requestedTransitionTime,
      );
      const shouldPlay = isPlayingRef.current;
      const samePlaybackTarget =
        playbackTargetSignature(previousSession) === playbackTargetSignature(nextSession);
      const previousUsesNative =
        nativePlaybackRef.current.active &&
        nativePlaybackRef.current.playbackSignature === previousSignature;
      const carriesNativeSession =
        previousUsesNative &&
        nativeSessionSignature(previousSession) === nativeSessionSignature(nextSession);
      const nextNativeSessionSignature = nativeSessionSignature(nextSession);
      if (samePlaybackTarget && carriesNativeSession) {
        clearPendingTransition();
        nativePlaybackRef.current = {
          ...nativePlaybackRef.current,
          playbackSignature: nextSignature,
        };
        sessionRef.current = nextSession;
        setSession(nextSession);
        setPlaybackTimeSeconds(nextTime);
        setPlaybackDurationSeconds(nextSession.durationHintSeconds || playbackDurationSecondsRef.current);

        const fallbackFromNativeLaneUpdate = (message: string) => {
          const latestSession = sessionRef.current;
          if (
            !latestSession ||
            playbackSignature(latestSession) !== nextSignature ||
            nativeSessionSignature(latestSession) !== nextNativeSessionSignature
          ) {
            return;
          }

          recordNativePlaybackFailure(message);
          nativePlaybackRef.current.blockedSessionSignature = nextNativeSessionSignature;
          markNativePlaybackInactive();
          const fallbackTime = clampTime(
            playbackTimeSecondsRef.current,
            playbackDurationSecondsRef.current || latestSession.durationHintSeconds || 0,
          );
          void requestNativeStop();
          syncStemElementTimes(latestSession.visibleStemArtifactIds, fallbackTime);
          getRenderedMediaElements(latestSession).forEach((element) => {
            element.pause();
            element.currentTime = fallbackTime;
          });
          setPlaybackTimeSeconds(fallbackTime);
          clearPlaybackControlBackend();
          setIsPlaying(false);
          if (shouldPlay) {
            markPlaybackStarting("web-fallback");
            void releaseSystemMediaControls()
              .then(() => {
                void playPlaybackImmediately();
              })
              .catch(() => markPlaybackError("Playback stopped. Fallback could not start."));
            return;
          }
          void releaseSystemMediaControls().catch((error) => recordNativePlaybackFailure(error));
        };

        void setNativeAudioLanes(nativeLaneUpdateForSession(nextSession))
          .then((snapshot) => {
            const latestSession = sessionRef.current;
            if (
              !latestSession ||
              playbackSignature(latestSession) !== nextSignature ||
              nativeSessionSignature(latestSession) !== nextNativeSessionSignature
            ) {
              return;
            }
            recordNativeSnapshot(snapshot);
            if (!snapshot.nativePlaybackSupported) {
              fallbackFromNativeLaneUpdate(
                snapshot.fallbackReason ?? "Native playback lane update fell back to Web Audio.",
              );
              return;
            }

            nativePlaybackRef.current = {
              ...nativePlaybackRef.current,
              active: snapshot.state === "playing",
              blockedSessionSignature: null,
              playbackSignature: nextSignature,
            };
            setPlaybackTimeSeconds(snapshot.positionSeconds);
            setPlaybackDurationSeconds(snapshot.durationSeconds || latestSession.durationHintSeconds || 0);
            if (snapshot.state === "stopped") {
              clearPlaybackControlBackend();
              markPlaybackStopped();
            } else {
              setPlaybackControlBackend("native");
              if (snapshot.state === "playing") {
                markPlaybackConfirmed({
                  backend: "native",
                  detail: nativeBackendRef.current,
                });
              } else {
                markPlaybackPaused();
              }
            }
            setIsPlaying(snapshot.state === "playing");
          })
          .catch((error) => {
            fallbackFromNativeLaneUpdate(playbackErrorMessage(error));
          });
        return;
      }
      if (previousUsesNative && !carriesNativeSession) {
        void requestNativeStop();
        markNativePlaybackInactive();
        clearPlaybackControlBackend();
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
        applyMediaPlaybackRate(nextSession, { ramp: shouldPlay });
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
      const shouldCrossfadeStemPlayback = shouldPlay && previousUsesBufferedClock;
      if (
        shouldPlay &&
        !shouldCrossfadeStemPlayback &&
        (previousUsesBufferedClock || nextUsesBufferedClock)
      ) {
        getActiveMediaElements(previousSession).forEach((element) => element.pause());
      }
      disposeStemPlaybackState({ crossfade: shouldCrossfadeStemPlayback });
      pendingTransitionRef.current = {
        id: ++transitionCounterRef.current,
        signature: nextSignature,
        shouldPlay,
        targetTime: nextTime,
        awaitSeekBeforePlay: !samePlaybackTarget,
        crossfadeStemPlayback:
          shouldPlay &&
          nextUsesBufferedClock &&
          (previousUsesBufferedClock || !samePlaybackTarget),
        awaitingLoadKeys,
        awaitingSeekKeys,
        forceSeekKeys,
      };
      setPlaybackTimeSeconds(nextTime);
    } else if (!previousSession) {
      setPlaybackTimeSeconds(playbackResetTimeForSession(nextSession));
      setPlaybackDurationSeconds(nextSession.durationHintSeconds || 0);
      clearPlaybackControlBackend();
      setIsPlaying(false);
      markPlaybackStopped();
    }

    sessionRef.current = nextSession;
    setSession(nextSession);
  }, [
    cancelPrecount,
    applyMediaPlaybackRate,
    canUseBufferedClock,
    clearPlaybackControlBackend,
    clearPendingTransition,
    closePlaybackAudioContext,
    disposeStemPlaybackState,
    getActiveMediaElements,
    getRenderedMediaElements,
    markNativePlaybackInactive,
    playbackResetTimeForSession,
    playbackStartTimeForSession,
    playPlaybackImmediately,
    readMasterTime,
    recordNativePlaybackFailure,
    recordNativeSnapshot,
    requestNativeStop,
    setIsPlaying,
    setPlaybackControlBackend,
    setPlaybackDurationSeconds,
    setPlaybackTimeSeconds,
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
    if (
      !webMediaSourcesEnabled ||
      !session?.visibleStemArtifactIds.length ||
      !canUseStemClock()
    ) {
      return;
    }

    void Promise.allSettled(
      session.visibleStemArtifactIds.map((artifactId) => loadStemBuffer(artifactId)),
    );
  }, [canUseStemClock, loadStemBuffer, session, webMediaSourcesEnabled]);

  useEffect(
    () => () => {
      cancelPrecount("unavailable");
      closePlaybackAudioContext();
    },
    [cancelPrecount, closePlaybackAudioContext],
  );

  useEffect(() => {
    writePlaybackE2ETelemetry();
  }, [
    isPlaying,
    isPrecounting,
    playbackControlBackend,
    playbackDurationSeconds,
    playbackTimeSeconds,
    session,
    writePlaybackE2ETelemetry,
  ]);

  useEffect(() => {
    if (
      !isTauriRuntime() ||
      playbackControlBackend !== "native" ||
      !isPlaying
    ) {
      return;
    }

    let cancelled = false;
    let requestInFlight = false;
    const refreshNativeDiagnostics = async () => {
      if (requestInFlight) {
        return;
      }
      const expectedSessionId = nativePlaybackRef.current.sessionSignature;
      if (!nativePlaybackRef.current.active || !expectedSessionId) {
        return;
      }
      requestInFlight = true;
      try {
        const snapshot = await getNativeAudioSnapshot();
        if (
          cancelled ||
          playbackControlBackendRef.current !== "native" ||
          !nativePlaybackRef.current.active ||
          nativePlaybackRef.current.sessionSignature !== expectedSessionId ||
          snapshot.sessionId !== expectedSessionId
        ) {
          return;
        }
        recordNativeSnapshot(snapshot);
      } catch {
        // Transport error events own playback failure and fallback handling.
      } finally {
        requestInFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void refreshNativeDiagnostics();
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isPlaying, playbackControlBackend, recordNativeSnapshot]);

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
        if (position.state === "playing" && restartLoopIfNeeded(activeSession, position.positionSeconds)) {
          setPlaybackDurationSeconds(position.durationSeconds || activeSession.durationHintSeconds || 0);
          return;
        }
        setPlaybackTimeSeconds(position.positionSeconds);
        setPlaybackDurationSeconds(position.durationSeconds || activeSession.durationHintSeconds || 0);
        if (position.state === "stopped") {
          clearPlaybackControlBackend();
          markPlaybackStopped();
        } else if (position.state === "playing") {
          setPlaybackControlBackend("native");
          markPlaybackConfirmed({
            backend: "native",
            detail: nativeBackendRef.current,
          });
        } else {
          markPlaybackPaused();
        }
        setIsPlaying(position.state === "playing");
        writePlaybackE2ETelemetry({
          activePath: position.state === "stopped" ? "none" : "native",
          transportState: position.state,
          positionSeconds: position.positionSeconds,
          durationSeconds: position.durationSeconds || activeSession.durationHintSeconds || 0,
        });
      }),
      listenNativeAudioEnded((snapshot: NativeAudioSnapshot) => {
        if (snapshot.sessionId !== nativePlaybackRef.current.sessionSignature) {
          return;
        }
        const activeSession = sessionRef.current;
        markNativePlaybackInactive();
        void requestNativeStop();
        recordNativeSnapshot(snapshot, {
          activePath: "none",
          transportState: "stopped",
        });
        if (restartActiveLoopPlayback(activeSession)) {
          return;
        }
        const resetTime = playbackResetTimeForSession(activeSession);
        setPlaybackTimeSeconds(resetTime);
        clearPlaybackControlBackend();
        setIsPlaying(false);
        markPlaybackStopped();
        syncStemElementTimes(activeSession?.visibleStemArtifactIds ?? [], resetTime);
        getRenderedMediaElements().forEach((element) => {
          element.pause();
          element.currentTime = resetTime;
        });
      }),
      listenNativeAudioErrors((error) => {
        const activeSession = sessionRef.current;
        const pendingNativePlay = pendingNativePlayRef.current;
        const pendingNativePause = pendingNativePauseRef.current;
        const matchingPendingPlay = Boolean(
          activeSession &&
            pendingNativePlay &&
            pendingNativePlay.generation === nativeControlGenerationRef.current &&
            pendingNativePlay.sessionSignature === error.sessionId &&
            pendingNativePlay.playbackSignature === playbackSignature(activeSession),
        );
        const ownsPausedNativeSession = playbackControlBackendRef.current === "native";
        const matchingPendingPause = Boolean(
          pendingNativePause &&
            pendingNativePause.generation === nativeControlGenerationRef.current &&
            pendingNativePause.sessionSignature === error.sessionId,
        );
        if (
          !activeSession ||
          error.sessionId !== nativePlaybackRef.current.sessionSignature ||
          nativeSessionSignature(activeSession) !== error.sessionId ||
          (!nativePlaybackRef.current.active &&
            !matchingPendingPlay &&
            !ownsPausedNativeSession)
        ) {
          return;
        }
        const shouldContinuePlayback =
          (nativePlaybackRef.current.active || matchingPendingPlay) &&
          !matchingPendingPause;
        nativeControlGenerationRef.current += 1;
        pendingNativePlayRef.current = null;
        pendingNativePauseRef.current = null;
        recordNativePlaybackFailure(error.message);
        const fallbackTime = clampTime(
          playbackTimeSecondsRef.current,
          playbackDurationSecondsRef.current || activeSession.durationHintSeconds || 0,
        );
        nativePlaybackRef.current.blockedSessionSignature = nativeSessionSignature(activeSession);
        markNativePlaybackInactive();
        clearPlaybackControlBackend();
        setIsPlaying(false);
        if (shouldContinuePlayback) {
          markPlaybackStarting("web-fallback");
        } else {
          markPlaybackError(
            "Native playback became unavailable. Press Play to continue with Web Audio.",
          );
        }
        void requestNativeStop();
        const fallbackGeneration = nativeControlGenerationRef.current;
        syncStemElementTimes(activeSession.visibleStemArtifactIds, fallbackTime);
        getRenderedMediaElements(activeSession).forEach((element) => {
          element.pause();
          element.currentTime = fallbackTime;
        });
        setPlaybackTimeSeconds(fallbackTime);
        writePlaybackE2ETelemetry({
          activePath: "none",
          transportState: "paused",
          positionSeconds: fallbackTime,
        });
        if (!shouldContinuePlayback) {
          void releaseSystemMediaControls().catch(() => undefined);
          return;
        }
        void releaseSystemMediaControls()
          .then(() => {
            const currentSession = sessionRef.current;
            if (
              nativeControlGenerationRef.current !== fallbackGeneration ||
              !currentSession ||
              nativeSessionSignature(currentSession) !== error.sessionId ||
              nativePlaybackRef.current.blockedSessionSignature !== error.sessionId
            ) {
              return;
            }
            void playPlaybackImmediately();
          })
          .catch(() => markPlaybackError("Playback stopped. Fallback could not start."));
      }),
    ]);

    return () => {
      void unlisteners.then((items) => {
        items.forEach((unlisten) => unlisten());
      });
    };
  }, [
    clearPlaybackControlBackend,
    getRenderedMediaElements,
    markNativePlaybackInactive,
    playbackResetTimeForSession,
    playPlaybackImmediately,
    recordNativePlaybackFailure,
    recordNativeSnapshot,
    requestNativeStop,
    restartActiveLoopPlayback,
    restartLoopIfNeeded,
    setIsPlaying,
    setPlaybackControlBackend,
    setPlaybackDurationSeconds,
    setPlaybackTimeSeconds,
    syncStemElementTimes,
    writePlaybackE2ETelemetry,
  ]);

  useWebPlaybackWakeLock({
    backend: playbackControlBackend,
    isPlaying,
  });
  useSystemPlaybackMediaControls({
    backend: playbackControlBackend,
    isPlaying,
    pausePlayback,
    playbackDurationSeconds,
    playbackRate: playbackRateForSession(session),
    playbackTimeSeconds,
    playPlayback,
    seekBy,
    seekTo,
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
      primeWebAudioForGesture,
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
      primeWebAudioForGesture,
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
          webMediaSourcesEnabled &&
          session &&
          !session.isStemPlayback &&
          session.selectedPlaybackArtifactId
            ? api.streamArtifactUrl(session.selectedPlaybackArtifactId)
            : undefined
        }
        preload={webMediaSourcesEnabled ? "metadata" : "none"}
        className="player player--hidden"
        onTimeUpdate={(event) => {
          const activeSession = sessionRef.current;
          if (!activeSession || activeSession.isStemPlayback) {
            return;
          }
          if (isPlayingRef.current && restartLoopIfNeeded(activeSession, event.currentTarget.currentTime)) {
            return;
          }
          confirmWebPlayback(event.currentTarget, true);
          setPlaybackTimeSeconds(event.currentTarget.currentTime);
        }}
        onPlaying={(event) => confirmWebPlayback(event.currentTarget, false)}
        onWaiting={(event) => scheduleWebStallFailure(event.currentTarget)}
        onStalled={(event) => scheduleWebStallFailure(event.currentTarget)}
        onSeeking={(event) => clearWebStallTimer(event.currentTarget)}
        onError={(event) =>
          failWebPlayback(
            event.currentTarget,
            `Web Audio media error${event.currentTarget.error?.code ? ` (code ${event.currentTarget.error.code})` : ""}.`,
          )
        }
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
          if (restartActiveLoopPlayback(sessionRef.current)) {
            return;
          }
          stopPlayback();
        }}
      />
      {session?.visibleStemArtifactIds.map((artifactId) => (
        <audio
          key={artifactId}
          ref={(element) => setStemAudioRef(artifactId, element)}
          src={webMediaSourcesEnabled ? api.streamArtifactUrl(artifactId) : undefined}
          preload={webMediaSourcesEnabled ? "metadata" : "none"}
          className="player player--hidden"
          onTimeUpdate={(event) => {
            const activeSession = sessionRef.current;
            if (!activeSession || !activeSession.isStemPlayback) {
              return;
            }
            if (activeSession.visibleStemArtifactIds[0] !== artifactId) {
              return;
            }
            if (isPlayingRef.current && restartLoopIfNeeded(activeSession, event.currentTarget.currentTime)) {
              return;
            }
            confirmWebPlayback(event.currentTarget, true);
            setPlaybackTimeSeconds(event.currentTarget.currentTime);
          }}
          onPlaying={(event) => confirmWebPlayback(event.currentTarget, false)}
          onWaiting={(event) => scheduleWebStallFailure(event.currentTarget)}
          onStalled={(event) => scheduleWebStallFailure(event.currentTarget)}
          onSeeking={(event) => clearWebStallTimer(event.currentTarget)}
          onError={(event) =>
            failWebPlayback(
              event.currentTarget,
              `Web Audio media error${event.currentTarget.error?.code ? ` (code ${event.currentTarget.error.code})` : ""}.`,
            )
          }
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
            if (restartActiveLoopPlayback(sessionRef.current)) {
              return;
            }
            stopPlayback();
          }}
        />
      ))}
    </PlaybackContext.Provider>
  );
}
