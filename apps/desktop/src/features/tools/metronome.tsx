import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStableCallback } from "../../lib/useStableCallback";
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

type AudioContextConstructor = typeof AudioContext;

export function MetronomeProvider({ children }: { children: ReactNode }) {
  const { getPlaybackSnapshot, isPlaying, session } = usePlayback();
  const [bpm, setBpm] = useState(() => normalizeMetronomeBpm(null));
  const [bpmDraft, setBpmDraft] = useState(() => normalizeMetronomeBpm(null).toString());
  const [beatsPerBar, setBeatsPerBar] = useState(DEFAULT_BEATS_PER_BAR);
  const [accentFirstBeat, setAccentFirstBeat] = useState(true);
  const [followPlayback, setFollowPlayback] = useState(false);
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

  const pauseSyncedClock = useStableCallback(function pauseSyncedClock() {
    clearScheduler();
    lastSyncedPlaybackTimeRef.current = null;
    lastSyncedScheduledBeatRef.current = null;
  });

  const ensureAudioContext = useStableCallback(function ensureAudioContext() {
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      return audioContextRef.current;
    }
    const AudioContextCtor = getAudioContextConstructor();
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
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
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
  ) {
    const beatNumber = beatNumberForIndex(beatIndex, beatsPerBarRef.current);
    const accent = isAccentBeat(beatIndex, beatsPerBarRef.current, accentFirstBeatRef.current);
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

  const scheduleSynced = useStableCallback(function scheduleSynced(
    audioContext: AudioContext,
    snapshot: PlaybackSnapshot,
  ) {
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
    setBpm(nextBpm);
    setBpmDraft(nextBpm.toString());
  });

  const startMetronome = useStableCallback(async function startMetronome() {
    setErrorMessage(null);
    const audioContext = await activateAudioContext();
    if (!audioContext) {
      return;
    }
    setIsRunning(true);
  });

  const stopMetronome = useStableCallback(function stopMetronome() {
    stopAudioClock();
    setIsRunning(false);
  });

  const setFollowPlaybackEnabled = useStableCallback(async function setFollowPlaybackEnabled(
    enabled: boolean,
  ) {
    setFollowPlayback(enabled);
    if (!enabled) {
      return;
    }
    await startMetronome();
  });

  const launchMetronome = useStableCallback(async function launchMetronome(
    options: MetronomeLaunchOptions = {},
  ) {
    if (options.bpm !== undefined) {
      seedBpm(options.bpm);
    }
    if (typeof options.followPlayback === "boolean") {
      setFollowPlayback(options.followPlayback);
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
    if (!followPlayback) {
      const audioContext = audioContextRef.current;
      if (audioContext && audioContext.state !== "closed") {
        startFreeRunClock(audioContext);
        return;
      }
      void activateAudioContext().then((nextAudioContext) => {
        if (nextAudioContext && isRunningRef.current && !followPlaybackRef.current) {
          startFreeRunClock(nextAudioContext);
        }
      });
      return;
    }

    clearScheduler();
    lastSyncedPlaybackTimeRef.current = null;
    lastSyncedScheduledBeatRef.current = null;
  }, [
    accentFirstBeat,
    activateAudioContext,
    beatsPerBar,
    bpm,
    clearScheduler,
    followPlayback,
    isRunning,
    startFreeRunClock,
  ]);

  useEffect(() => {
    if (!isRunning || !followPlayback) {
      return;
    }

    let frameId: number | null = null;
    function tick() {
      const snapshot = getPlaybackSnapshot();
      if (!snapshot.session || !snapshot.isPlaying) {
        pauseSyncedClock();
      } else {
        const audioContext = ensureAudioContext();
        if (audioContext) {
          if (audioContext.state === "suspended") {
            void audioContext.resume().catch(() => undefined);
          }
          scheduleSynced(audioContext, snapshot);
        }
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
    ensureAudioContext,
    followPlayback,
    getPlaybackSnapshot,
    isRunning,
    pauseSyncedClock,
    scheduleSynced,
  ]);

  const syncStatus = followPlayback
    ? session
      ? isPlaying
        ? `Following ${session.projectName}`
        : `Waiting for ${session.projectName} playback`
      : "No project playback active"
    : "Standalone clock";

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

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (
    window.AudioContext ??
    (window as Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext ??
    null
  );
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
