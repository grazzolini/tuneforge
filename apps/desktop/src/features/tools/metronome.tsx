import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isWebAudioBackendForced,
  listenNativeAudioCues,
  listenNativeAudioSessions,
  listenNativeAudioTerminal,
  nativePlayCueProvider,
  setNativeStandaloneMetronome,
  type NativeAudioSessionSnapshot,
  type NativeStandaloneMetronomeState,
} from "../../lib/nativeAudio";
import { useStableCallback } from "../../lib/useStableCallback";
import { nextTimedBeatIndex, type AnalysisTimingBeat } from "../../lib/timingGrid";
import {
  activateWebAudioContext,
  getWebAudioContextConstructor,
} from "../../lib/webAudio";
import { usePlayback, type PlaybackSnapshot } from "../projects/playback-context";
import { MetronomeContext, type MetronomeLaunchOptions } from "./metronome-context";
import { DEFAULT_METRONOME_SOUND, scheduleMetronomeClick } from "./metronomeSound";
import {
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_METRONOME_VOLUME,
  beatNumberForIndex,
  createTapTempoState,
  isAccentBeat,
  nextSyncedBeatIndex,
  normalizeBeatsPerBar,
  normalizeMetronomeBpm,
  secondsPerBeat,
  updateTapTempo,
  type TapTempoState,
} from "./metronomeUtils";

const SCHEDULE_AHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.035;

type NativeMetronomeCommand = {
  enabled: boolean;
  epoch: number;
  lifecycle: number;
};

export function MetronomeProvider({ children }: { children: ReactNode }) {
  const {
    getPlaybackSnapshot,
    isPlaying,
    session,
    updateFollowedMetronomeCues,
  } = usePlayback();
  const [bpm, setBpm] = useState(() => normalizeMetronomeBpm(null));
  const [bpmDraft, setBpmDraft] = useState(() => normalizeMetronomeBpm(null).toString());
  const [beatsPerBar, setBeatsPerBar] = useState(DEFAULT_BEATS_PER_BAR);
  const [accentFirstBeat, setAccentFirstBeat] = useState(true);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [volume, setVolumeState] = useState(DEFAULT_METRONOME_VOLUME);
  const [isRunning, setIsRunning] = useState(false);
  const [activeBeat, setActiveBeat] = useState<number | null>(null);
  const [tapBpm, setTapBpm] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const accentFirstBeatRef = useRef(accentFirstBeat);
  const activeBeatTimeoutsRef = useRef<number[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const beatsPerBarRef = useRef(beatsPerBar);
  const bpmRef = useRef(bpm);
  const followPlaybackRef = useRef(followPlayback);
  const freeRunOriginRef = useRef(0);
  const isRunningRef = useRef(isRunning);
  const lastSyncedPlaybackTimeRef = useRef<number | null>(null);
  const lastSyncedScheduledBeatRef = useRef<number | null>(null);
  const [nativeSession, setNativeSession] = useState<NativeAudioSessionSnapshot | null>(null);
  const nativeActivationEpochRef = useRef(0);
  const nativeStandaloneRef = useRef<NativeStandaloneMetronomeState | null>(null);
  const nativeStandaloneCommandEpochRef = useRef(0);
  const nativeStandaloneCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nativeStandaloneLifecycleRef = useRef(0);
  const nativeStandaloneOperationRef = useRef(0);
  const nextFreeRunBeatIndexRef = useRef(0);
  const schedulerIntervalRef = useRef<number | null>(null);
  const tapTempoStateRef = useRef<TapTempoState>(createTapTempoState());
  const volumeRef = useRef(volume);

  useEffect(() => {
    bpmRef.current = bpm;
  }, [bpm]);

  useEffect(() => {
    beatsPerBarRef.current = beatsPerBar;
  }, [beatsPerBar]);

  useEffect(() => {
    accentFirstBeatRef.current = accentFirstBeat;
  }, [accentFirstBeat]);

  useEffect(() => {
    followPlaybackRef.current = followPlayback;
  }, [followPlayback]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  const clearBeatTimeouts = useStableCallback(function clearBeatTimeouts() {
    activeBeatTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    activeBeatTimeoutsRef.current = [];
  });

  const clearScheduler = useStableCallback(function clearScheduler() {
    if (schedulerIntervalRef.current !== null) {
      window.clearInterval(schedulerIntervalRef.current);
      schedulerIntervalRef.current = null;
    }
    clearBeatTimeouts();
    setActiveBeat(null);
  });

  const stopAudioClock = useStableCallback(function stopAudioClock() {
    clearScheduler();
    lastSyncedPlaybackTimeRef.current = null;
    lastSyncedScheduledBeatRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
  });

  const ensureAudioContext = useStableCallback(function ensureAudioContext() {
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      return audioContextRef.current;
    }
    const AudioContextCtor = getWebAudioContextConstructor();
    if (!AudioContextCtor) {
      setErrorMessage("Audio playback is unavailable.");
      return null;
    }
    const audioContext = new AudioContextCtor();
    audioContextRef.current = audioContext;
    return audioContext;
  });

  const activateAudioContext = useStableCallback(async function activateAudioContext() {
    const audioContext = ensureAudioContext();
    if (!audioContext) {
      return null;
    }
    try {
      await activateWebAudioContext(audioContext);
    } catch {
      setErrorMessage("Could not start metronome audio.");
      return null;
    }
    return audioContext;
  });

  const scheduleBeat = useStableCallback(function scheduleBeat(
    audioContext: AudioContext,
    beatIndex: number,
    startTimeSeconds: number,
    timingBeat?: AnalysisTimingBeat,
  ) {
    const beatNumber =
      timingBeat?.beat_in_bar ?? beatNumberForIndex(beatIndex, beatsPerBarRef.current);
    const accent = timingBeat
      ? accentFirstBeatRef.current && timingBeat.beat_in_bar === 1
      : isAccentBeat(beatIndex, beatsPerBarRef.current, accentFirstBeatRef.current);
    scheduleMetronomeClick({
      accent,
      audioContext,
      sound: DEFAULT_METRONOME_SOUND,
      startTimeSeconds,
      volume: volumeRef.current,
    });

    const timeoutId = window.setTimeout(
      () => setActiveBeat(beatNumber),
      Math.max(0, (startTimeSeconds - audioContext.currentTime) * 1000),
    );
    activeBeatTimeoutsRef.current.push(timeoutId);
  });

  const scheduleFreeRun = useStableCallback(function scheduleFreeRun(audioContext: AudioContext) {
    const beatSeconds = secondsPerBeat(bpmRef.current);
    let nextBeatIndex = nextFreeRunBeatIndexRef.current;
    const scheduleUntilSeconds = audioContext.currentTime + SCHEDULE_AHEAD_SECONDS;

    while (freeRunOriginRef.current + nextBeatIndex * beatSeconds <= scheduleUntilSeconds) {
      const beatTimeSeconds = freeRunOriginRef.current + nextBeatIndex * beatSeconds;
      if (beatTimeSeconds >= audioContext.currentTime - 0.005) {
        scheduleBeat(audioContext, nextBeatIndex, beatTimeSeconds);
      }
      nextBeatIndex += 1;
    }

    nextFreeRunBeatIndexRef.current = nextBeatIndex;
  });

  const startFreeRunClock = useStableCallback(function startFreeRunClock(audioContext: AudioContext) {
    clearScheduler();
    freeRunOriginRef.current = audioContext.currentTime + START_DELAY_SECONDS;
    nextFreeRunBeatIndexRef.current = 0;
    scheduleFreeRun(audioContext);
    schedulerIntervalRef.current = window.setInterval(
      () => scheduleFreeRun(audioContext),
      SCHEDULER_INTERVAL_MS,
    );
  });

  const scheduleTimed = useStableCallback(function scheduleTimed(
    audioContext: AudioContext,
    snapshot: PlaybackSnapshot,
  ) {
    const timingGrid = snapshot.session?.timingGrid;
    if (!timingGrid || timingGrid.beats.length < 2) {
      return;
    }
    const playbackTimeSeconds = Math.max(0, snapshot.playbackTimeSeconds);
    let beatIndex = nextTimedBeatIndex({
      lastPlaybackTimeSeconds: lastSyncedPlaybackTimeRef.current,
      lastScheduledBeatIndex: lastSyncedScheduledBeatRef.current,
      playbackTimeSeconds,
      timingGrid,
    });
    const scheduleUntilPlaybackSeconds = playbackTimeSeconds + SCHEDULE_AHEAD_SECONDS;

    while (
      beatIndex < timingGrid.beats.length &&
      timingGrid.beats[beatIndex].seconds <= scheduleUntilPlaybackSeconds
    ) {
      const beat = timingGrid.beats[beatIndex];
      const startTimeSeconds =
        audioContext.currentTime + Math.max(0, beat.seconds - playbackTimeSeconds);
      scheduleBeat(audioContext, beat.index, startTimeSeconds, beat);
      lastSyncedScheduledBeatRef.current = beatIndex;
      beatIndex += 1;
    }

    lastSyncedPlaybackTimeRef.current = playbackTimeSeconds;
  });

  const scheduleSynced = useStableCallback(function scheduleSynced(
    audioContext: AudioContext,
    snapshot: PlaybackSnapshot,
  ) {
    if (snapshot.session?.timingGrid) {
      scheduleTimed(audioContext, snapshot);
      return;
    }
    const beatSeconds = secondsPerBeat(bpmRef.current);
    const playbackTimeSeconds = Math.max(0, snapshot.playbackTimeSeconds);
    let beatIndex = nextSyncedBeatIndex({
      bpm: bpmRef.current,
      lastPlaybackTimeSeconds: lastSyncedPlaybackTimeRef.current,
      lastScheduledBeatIndex: lastSyncedScheduledBeatRef.current,
      playbackTimeSeconds,
    });
    const scheduleUntilPlaybackSeconds = playbackTimeSeconds + SCHEDULE_AHEAD_SECONDS;

    while (beatIndex * beatSeconds <= scheduleUntilPlaybackSeconds) {
      const beatPlaybackTimeSeconds = beatIndex * beatSeconds;
      const startTimeSeconds =
        audioContext.currentTime + Math.max(0, beatPlaybackTimeSeconds - playbackTimeSeconds);
      scheduleBeat(audioContext, beatIndex, startTimeSeconds);
      lastSyncedScheduledBeatRef.current = beatIndex;
      beatIndex += 1;
    }

    lastSyncedPlaybackTimeRef.current = playbackTimeSeconds;
  });

  const seedBpm = useStableCallback(function seedBpm(value: unknown) {
    const nextBpm = normalizeMetronomeBpm(value);
    bpmRef.current = nextBpm;
    setBpm(nextBpm);
    setBpmDraft(nextBpm.toString());
  });

  const enqueueNativeMetronomeCommand = useStableCallback(function enqueueNativeMetronomeCommand(
    command: NativeMetronomeCommand,
  ) {
    const execute = async () => {
      if (
        command.lifecycle !== nativeStandaloneLifecycleRef.current ||
        command.epoch !== nativeStandaloneCommandEpochRef.current
      ) {
        return null;
      }
      const current = nativeStandaloneRef.current;
      if (!command.enabled && !current) {
        return null;
      }
      if (current && !current.leaseId) {
        throw new Error("Native metronome ownership metadata is unavailable.");
      }
      const configuration = {
        enabled: command.enabled,
        bpm: bpmRef.current,
        beatsPerBar: beatsPerBarRef.current,
        accentFirstBeat: accentFirstBeatRef.current,
        gain: volumeRef.current,
        followPlayback: followPlaybackRef.current,
        operationId: `standalone-metronome-${++nativeStandaloneOperationRef.current}`,
      };
      const next = await setNativeStandaloneMetronome(
        current?.leaseId
          ? {
              ...configuration,
              leaseId: current.leaseId,
              generation: current.generation,
              timelineRevision: current.revision,
            }
          : { ...configuration, leaseId: "standalone-metronome" },
      );
      if (!next.leaseId || next.generation <= 0 || next.revision <= 0) {
        throw new Error("Native metronome ownership metadata is unavailable.");
      }
      if (command.lifecycle === nativeStandaloneLifecycleRef.current) {
        nativeStandaloneRef.current = next;
      }
      return next;
    };
    const result = nativeStandaloneCommandQueueRef.current.then(execute, execute);
    nativeStandaloneCommandQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  });

  const startMetronome = useStableCallback(async function startMetronome() {
    setErrorMessage(null);
    if (isTauriRuntime() && !isWebAudioBackendForced()) {
      const epoch = ++nativeStandaloneCommandEpochRef.current;
      const lifecycle = nativeStandaloneLifecycleRef.current;
      setIsRunning(true);
      try {
        await enqueueNativeMetronomeCommand({ enabled: true, epoch, lifecycle });
      } catch {
        if (epoch === nativeStandaloneCommandEpochRef.current) {
          setIsRunning(false);
          setErrorMessage("Could not start native metronome audio. Check the output device and retry.");
        }
      }
      return;
    }
    const audioContext = await activateAudioContext();
    if (!audioContext) {
      return;
    }
    setIsRunning(true);
  });

  const stopMetronome = useStableCallback(function stopMetronome() {
    stopAudioClock();
    if (isTauriRuntime() && !isWebAudioBackendForced()) {
      const epoch = ++nativeStandaloneCommandEpochRef.current;
      const lifecycle = nativeStandaloneLifecycleRef.current;
      void enqueueNativeMetronomeCommand({ enabled: false, epoch, lifecycle }).then(() => {
        if (epoch === nativeStandaloneCommandEpochRef.current) {
          setIsRunning(false);
          setErrorMessage(null);
        }
      }).catch(() => {
        if (epoch === nativeStandaloneCommandEpochRef.current) {
          setIsRunning(true);
          setErrorMessage("Could not stop native metronome audio. Retry Stop before leaving it running.");
        }
      });
      return;
    }
    setIsRunning(false);
  });

  const reconcileNativeMetronomeFailure = useStableCallback(
    async function reconcileNativeMetronomeFailure(failedEpoch: number) {
      if (failedEpoch !== nativeStandaloneCommandEpochRef.current) return;
      const stopEpoch = ++nativeStandaloneCommandEpochRef.current;
      const lifecycle = nativeStandaloneLifecycleRef.current;
      setErrorMessage("Native metronome audio changed unexpectedly; stopping it safely.");
      try {
        await enqueueNativeMetronomeCommand({
          enabled: false,
          epoch: stopEpoch,
          lifecycle,
        });
        if (stopEpoch === nativeStandaloneCommandEpochRef.current) {
          setIsRunning(false);
        }
      } catch {
        if (stopEpoch === nativeStandaloneCommandEpochRef.current) {
          setIsRunning(true);
          setErrorMessage("Native metronome state is uncertain. Choose Stop again.");
        }
      }
    },
  );

  const setFollowPlaybackEnabled = useStableCallback(async function setFollowPlaybackEnabled(
    enabled: boolean,
  ) {
    setFollowPlayback(enabled);
    followPlaybackRef.current = enabled;
    if (!enabled) {
      return;
    }
    if (!isTauriRuntime() || isWebAudioBackendForced()) {
      await startMetronome();
    }
  });

  const launchMetronome = useStableCallback(async function launchMetronome(
    options: MetronomeLaunchOptions = {},
  ) {
    if (options.bpm !== undefined) {
      seedBpm(options.bpm);
    }
    if (typeof options.followPlayback === "boolean") {
      setFollowPlayback(options.followPlayback);
      followPlaybackRef.current = options.followPlayback;
    }
    await startMetronome();
  });

  const setBpmDraftValue = useStableCallback(function setBpmDraftValue(value: string) {
    setBpmDraft(value);
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return;
    }
    setBpm(normalizeMetronomeBpm(numericValue));
  });

  const commitBpmDraft = useStableCallback(function commitBpmDraft() {
    const nextBpm = normalizeMetronomeBpm(bpmDraft, bpm);
    setBpm(nextBpm);
    setBpmDraft(nextBpm.toString());
  });

  const setBeatsPerBarValue = useStableCallback(function setBeatsPerBarValue(value: string) {
    setBeatsPerBar(normalizeBeatsPerBar(value, beatsPerBar));
  });

  const setVolume = useStableCallback(function setVolume(value: number) {
    setVolumeState(normalizeVolume(value));
  });

  const resetVolume = useStableCallback(function resetVolume() {
    setVolumeState(DEFAULT_METRONOME_VOLUME);
  });

  const handleTapTempo = useStableCallback(function handleTapTempo() {
    const result = updateTapTempo(tapTempoStateRef.current, getCurrentMetronomeTimeMs());
    tapTempoStateRef.current = result.state;
    setTapBpm(result.bpm);
    if (result.bpm !== null) {
      setBpm(result.bpm);
      setBpmDraft(result.bpm.toString());
    }
  });

  useEffect(
    () => () => {
      stopAudioClock();
    },
    [stopAudioClock],
  );

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    if (isTauriRuntime() && !isWebAudioBackendForced()) {
      return;
    }
    void activateAudioContext().then((audioContext) => {
      if (!audioContext || !isRunningRef.current) return;
      const snapshot = getPlaybackSnapshot();
      if (!followPlaybackRef.current || !snapshot.session || !snapshot.isPlaying) {
        startFreeRunClock(audioContext);
      } else {
        clearScheduler();
        lastSyncedPlaybackTimeRef.current = null;
        lastSyncedScheduledBeatRef.current = null;
      }
    });
  }, [
    accentFirstBeat,
    activateAudioContext,
    beatsPerBar,
    bpm,
    clearScheduler,
    followPlayback,
    getPlaybackSnapshot,
    isRunning,
    startFreeRunClock,
  ]);

  useEffect(() => {
    if (
      !isRunning ||
      !followPlayback ||
      (isTauriRuntime() && !isWebAudioBackendForced())
    ) {
      return;
    }

    let frameId: number | null = null;
    function tick() {
      const snapshot = getPlaybackSnapshot();
      const audioContext = ensureAudioContext();
      if (!audioContext) {
        frameId = window.requestAnimationFrame(tick);
        return;
      }
      if (!snapshot.session || !snapshot.isPlaying) {
        lastSyncedPlaybackTimeRef.current = null;
        lastSyncedScheduledBeatRef.current = null;
        if (schedulerIntervalRef.current === null) {
          startFreeRunClock(audioContext);
        }
      } else {
        if (schedulerIntervalRef.current !== null) {
          clearScheduler();
        }
        void activateWebAudioContext(audioContext).catch(() => undefined);
        scheduleSynced(audioContext, snapshot);
      }
      frameId = window.requestAnimationFrame(tick);
    }

    frameId = window.requestAnimationFrame(tick);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    clearScheduler,
    ensureAudioContext,
    followPlayback,
    getPlaybackSnapshot,
    isRunning,
    scheduleSynced,
    startFreeRunClock,
  ]);

  useEffect(() => {
    if (!isTauriRuntime() || isWebAudioBackendForced()) return;
    const unlisteners = Promise.all([
      listenNativeAudioSessions((next) => {
        if (next.resource !== "output") return;
        setNativeSession((current) =>
          current?.generation === next.generation &&
          current.timelineRevision === next.timelineRevision &&
          current.status === next.status ? current : next,
        );
      }),
      listenNativeAudioCues((cue) => {
        if (
          cue.kind !== "metronome" ||
          (cue.source === "project_playback" &&
            (cue.generation !== nativeSession?.generation ||
              cue.revision !== nativeSession.timelineRevision)) ||
          (cue.source === "standalone_metronome" &&
            (cue.generation !== nativeStandaloneRef.current?.generation ||
              cue.revision !== nativeStandaloneRef.current.revision))
        ) return;
        setActiveBeat(beatNumberForIndex(cue.cueIndex, beatsPerBarRef.current));
        activeBeatTimeoutsRef.current.push(window.setTimeout(() => setActiveBeat(null), 90));
      }),
      listenNativeAudioTerminal((event) => {
        if (
          event.resource === "output" &&
          (event.generation === nativeSession?.generation ||
            event.generation === nativeStandaloneRef.current?.generation)
        ) {
          nativeStandaloneLifecycleRef.current += 1;
          nativeStandaloneCommandEpochRef.current += 1;
          setNativeSession(null);
          nativeStandaloneRef.current = null;
          setIsRunning(false);
          setErrorMessage("Native metronome audio stopped. Check the output device and retry.");
        }
      }),
    ]);
    return () => void unlisteners.then((items) => items.forEach((unlisten) => unlisten()));
  }, [nativeSession?.generation, nativeSession?.timelineRevision]);

  useEffect(() => {
    if (
      !isRunning ||
      !nativeStandaloneRef.current ||
      !isTauriRuntime() ||
      isWebAudioBackendForced()
    ) return;
    const epoch = nativeStandaloneCommandEpochRef.current;
    const lifecycle = nativeStandaloneLifecycleRef.current;
    void enqueueNativeMetronomeCommand({ enabled: true, epoch, lifecycle }).catch(() => {
      void reconcileNativeMetronomeFailure(epoch);
    });
  }, [
    accentFirstBeat,
    beatsPerBar,
    bpm,
    enqueueNativeMetronomeCommand,
    followPlayback,
    isRunning,
    reconcileNativeMetronomeFailure,
    volume,
  ]);

  const nativeCuePlan = useStableCallback((positionSeconds: number) => {
    const snapshot = getPlaybackSnapshot();
    const beatSeconds = secondsPerBeat(bpm);
    const beats = snapshot.session?.timingGrid?.beats.map((beat) => ({
      index: beat.index, seconds: beat.seconds, accent: beat.beat_in_bar === 1,
    })) ?? Array.from({ length: Math.ceil(snapshot.playbackDurationSeconds / beatSeconds) }, (_, index) => ({
      index, seconds: index * beatSeconds, accent: isAccentBeat(index, beatsPerBar, accentFirstBeat),
    }));
    return beats.filter((beat) => beat.seconds >= positionSeconds).map((beat) => ({
      cueIndex: beat.index, positionSeconds: beat.seconds, kind: "metronome" as const,
      accent: accentFirstBeat && beat.accent, gain: volume,
    }));
  });

  const advanceNativeActivationEpoch = useStableCallback(
    () => ++nativeActivationEpochRef.current,
  );
  const isNativeActivationEpochCurrent = useStableCallback(
    (epoch: number) => nativeActivationEpochRef.current === epoch,
  );
  useEffect(() => {
    if (!isRunning || !followPlayback || !isTauriRuntime() || isWebAudioBackendForced()) return;
    const activationEpoch = advanceNativeActivationEpoch();
    nativePlayCueProvider.current = nativeCuePlan;
    return () => {
      if (nativePlayCueProvider.current === nativeCuePlan) nativePlayCueProvider.current = null;
      if (!isNativeActivationEpochCurrent(activationEpoch)) return;
      const cleanupEpoch = advanceNativeActivationEpoch();
      void updateFollowedMetronomeCues?.([]).then((snapshot) => {
        if (!snapshot || !isNativeActivationEpochCurrent(cleanupEpoch)) return;
        setNativeSession(snapshot);
      }).catch(() => undefined);
    };
  }, [advanceNativeActivationEpoch, followPlayback, isNativeActivationEpochCurrent, isRunning, nativeCuePlan, updateFollowedMetronomeCues]);

  useEffect(() => {
    if (
      !isRunning || !followPlayback || !isTauriRuntime() || isWebAudioBackendForced()
    ) return;
    let cancelled = false;
    const activationEpoch = nativeActivationEpochRef.current;
    const cues = nativeCuePlan(getPlaybackSnapshot().playbackTimeSeconds);
    void updateFollowedMetronomeCues?.(cues).then((snapshot) => {
      if (!snapshot || cancelled || nativeActivationEpochRef.current !== activationEpoch) return;
      setNativeSession(snapshot);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [accentFirstBeat, beatsPerBar, bpm, followPlayback, getPlaybackSnapshot, isRunning, nativeCuePlan, updateFollowedMetronomeCues, volume]);

  const tempoStatus = `${bpm.toFixed(1)} BPM`;
  const freeRunningStatus = `Free-running at ${tempoStatus}`;
  const syncStatus = !isRunning
    ? `Ready at ${tempoStatus}`
    : followPlayback && session && isPlaying
      ? `Following ${session.projectName} playback`
      : followPlayback && session
        ? `${freeRunningStatus} · follows ${session.projectName} when playback starts`
        : freeRunningStatus;

  const value = useMemo(
    () => ({
      accentFirstBeat,
      activeBeat,
      beatsPerBar,
      bpm,
      bpmDraft,
      commitBpmDraft,
      errorMessage,
      followPlayback,
      handleTapTempo,
      isRunning,
      launchMetronome,
      resetVolume,
      seedBpm,
      setAccentFirstBeat,
      setBeatsPerBarValue,
      setBpmDraftValue,
      setFollowPlaybackEnabled,
      setVolume,
      startMetronome,
      stopMetronome,
      syncStatus,
      tapBpm,
      volume,
    }),
    [
      accentFirstBeat,
      activeBeat,
      beatsPerBar,
      bpm,
      bpmDraft,
      commitBpmDraft,
      errorMessage,
      followPlayback,
      handleTapTempo,
      isRunning,
      launchMetronome,
      resetVolume,
      seedBpm,
      setBeatsPerBarValue,
      setBpmDraftValue,
      setFollowPlaybackEnabled,
      setVolume,
      startMetronome,
      stopMetronome,
      syncStatus,
      tapBpm,
      volume,
    ],
  );

  return <MetronomeContext.Provider value={value}>{children}</MetronomeContext.Provider>;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getCurrentMetronomeTimeMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function normalizeVolume(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_METRONOME_VOLUME;
  }
  return Math.max(0, Math.min(1, value));
}
