import {
  emitMockNativeAudioCue,
  emitMockNativePlaybackPosition,
  getMockAudioContexts,
  getMockFetch,
  getMockInvoke,
  markAudioReady,
  mockListen,
  resetAppTestHarness,
  setMockNativeAudioState,
} from "../../test/appTestHarness";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "./playback";
import {
  usePlayback,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./playback-context";
import { MetronomeProvider } from "../tools/metronome";
import {
  useMetronome,
  type MetronomeContextValue,
} from "../tools/metronome-context";

let playback: PlaybackContextValue;
let metronome: MetronomeContextValue;

function Harness() {
  playback = usePlayback();
  return null;
}

function MetronomeHarness() {
  metronome = useMetronome();
  return null;
}

function session(
  overrides: Partial<ProjectPlaybackSession> = {},
): ProjectPlaybackSession {
  return {
    projectId: "synthetic",
    projectName: "Synthetic",
    stageTitle: "Source",
    stageSummary: "Source",
    selectedPlaybackArtifactId: "sine",
    isStemPlayback: false,
    playbackArtifactIds: ["sine"],
    artifactPathsById: { sine: "/tmp/synthetic.wav" },
    artifactFormatsById: { sine: "wav" },
    visibleStemArtifactIds: [],
    stemControls: {},
    durationHintSeconds: 30,
    precountEnabled: false,
    precountLoopEnabled: false,
    precountClickCount: 4,
    precountTempoBpm: 120,
    tempoOriginalBpm: 120,
    tempoTargetBpm: 120,
    timingGrid: null,
    loopRange: null,
    chordDictionaryFollowProject: null,
    ...overrides,
  };
}

function bufferedSession(
  overrides: Partial<ProjectPlaybackSession> = {},
): ProjectPlaybackSession {
  return session({
    selectedPlaybackArtifactId: "stem",
    isStemPlayback: true,
    playbackArtifactIds: ["stem"],
    artifactPathsById: { stem: "/tmp/stem.wav" },
    artifactFormatsById: { stem: "wav" },
    visibleStemArtifactIds: ["stem"],
    stemControls: { stem: { muted: false, solo: false } },
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) {
      await Promise.resolve();
    }
  });
}

async function setup(targetSession = session()) {
  render(
    <PlaybackProvider>
      <Harness />
    </PlaybackProvider>,
  );
  act(() => playback.registerProjectSession(targetSession));
  await flush();
}

function calls(command: string) {
  return getMockInvoke().mock.calls.filter(([name]) => name === command);
}

beforeEach(() => {
  resetAppTestHarness();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

function enableNativePlayback() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  setMockNativeAudioState({
    capabilities: {
      nativePlaybackSupported: true,
      availabilityReason: null,
      backend: "desktop-cpal",
    },
  });
}

describe("native playback race regressions", () => {
  for (const action of ["stop", "pause"] as const) {
    it(`${action} waits for an in-flight native seek revision`, async () => {
      enableNativePlayback();
      await setup();
      await act(async () => playback.playPlayback());
      const invoke = getMockInvoke();
      const originalInvoke = invoke.getMockImplementation()!;
      const pendingSeek = deferred<Record<string, unknown>>();
      let revision = 1;
      const rejected: string[] = [];
      let actualState = "playing";

      invoke.mockImplementation(async (command, args) => {
        const control = ((args as { payload?: Record<string, unknown>; control?: Record<string, unknown> })
          ?.payload ?? (args as { control?: Record<string, unknown> })?.control);
        if (
          ["audio_seek", "audio_pause", "audio_stop"].includes(command) &&
          control?.timelineRevision !== revision
        ) {
          rejected.push(command);
          throw new Error("stale_timeline_revision");
        }
        const result = await originalInvoke(command, args);
        if (command === "audio_seek") {
          revision += 1;
          return pendingSeek.promise;
        }
        if (command === "audio_pause" || command === "audio_stop") {
          actualState = command === "audio_pause" ? "paused" : "stopped";
          revision += 1;
          return { ...(result as object), timelineRevision: revision };
        }
        return result;
      });

      act(() => playback.seekTo(12));
      await flush();
      act(() => {
        if (action === "stop") playback.stopPlayback();
        else playback.pausePlayback();
      });
      await flush();
      expect(calls(action === "stop" ? "audio_stop" : "audio_pause")).toHaveLength(0);
      await act(async () => {
        pendingSeek.resolve({
          sessionId: "synthetic:native:sine",
          state: "playing",
          positionSeconds: 12,
          durationSeconds: 30,
          playbackRate: 1,
          nativePlaybackSupported: true,
          availabilityReason: null,
          lanes: [],
          bufferHealth: [],
          leaseId: "project-playback",
          generation: 1,
          timelineRevision: 2,
          nativeTimeUs: 1,
        });
      });
      await flush();

      expect(rejected).toEqual([]);
      expect(actualState).toBe(action === "stop" ? "stopped" : "paused");
    });
  }

  it("keeps Pause queued when a later seek supersedes its UI intent", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const firstSeek = deferred<Record<string, unknown>>();
    let revision = 1;
    const rejected: string[] = [];

    invoke.mockImplementation(async (command, args) => {
      const payload = (args as { payload?: Record<string, unknown> })?.payload;
      if (
        ["audio_seek", "audio_pause"].includes(command) &&
        payload?.timelineRevision !== revision
      ) {
        rejected.push(command);
        throw new Error("stale_timeline_revision");
      }
      const result = await originalInvoke(command, args);
      if (command === "audio_seek") {
        revision += 1;
        if (revision === 2) return firstSeek.promise;
      }
      if (command === "audio_pause") {
        revision += 1;
      }
      return result && typeof result === "object" && "timelineRevision" in result
        ? { ...result, timelineRevision: revision }
        : result;
    });

    act(() => playback.seekTo(8));
    await flush();
    act(() => playback.pausePlayback());
    act(() => playback.seekTo(12));
    await flush();
    await act(async () => {
      firstSeek.resolve({
        sessionId: "synthetic:native:sine",
        state: "playing",
        positionSeconds: 8,
        durationSeconds: 30,
        playbackRate: 1,
        nativePlaybackSupported: true,
        availabilityReason: null,
        lanes: [],
        bufferHealth: [],
        leaseId: "project-playback",
        generation: 1,
        timelineRevision: 2,
        nativeTimeUs: 1,
      });
    });
    await flush();

    expect(rejected).toEqual([]);
    expect(calls("audio_pause")).toHaveLength(1);
    expect(playback.isPlaying).toBe(false);
  });

  it("restores playing state when the current native Pause is rejected", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_pause") throw new Error("output_stream_failure");
      return originalInvoke(command, args);
    });

    act(() => playback.pausePlayback());
    await flush();

    expect(calls("audio_pause")).toHaveLength(1);
    expect(calls("audio_stop")).toHaveLength(0);
    expect(playback.isPlaying).toBe(true);
  });

  it("uses each completed native revision across rapid seeks", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const firstSeek = deferred<Record<string, unknown>>();
    let revision = 1;
    const rejected: string[] = [];

    invoke.mockImplementation(async (command, args) => {
      if (command !== "audio_seek") return originalInvoke(command, args);
      const control = (args as { payload: { timelineRevision: number; timeSeconds: number } }).payload;
      if (control.timelineRevision !== revision) {
        rejected.push(command);
        throw new Error("stale_timeline_revision");
      }
      await originalInvoke(command, args);
      revision += 1;
      const snapshot = {
        sessionId: "synthetic:native:sine",
        state: "playing",
        positionSeconds: control.timeSeconds,
        durationSeconds: 30,
        playbackRate: 1,
        nativePlaybackSupported: true,
        availabilityReason: null,
        lanes: [],
        bufferHealth: [],
        leaseId: "project-playback",
        generation: 1,
        timelineRevision: revision,
        nativeTimeUs: 1,
      };
      return revision === 2 ? firstSeek.promise : snapshot;
    });

    act(() => playback.seekTo(12));
    await flush();
    act(() => playback.seekTo(14));
    await flush();
    await act(async () => {
      firstSeek.resolve({
        sessionId: "synthetic:native:sine",
        state: "playing",
        positionSeconds: 12,
        durationSeconds: 30,
        playbackRate: 1,
        nativePlaybackSupported: true,
        availabilityReason: null,
        lanes: [],
        bufferHealth: [],
        leaseId: "project-playback",
        generation: 1,
        timelineRevision: 2,
        nativeTimeUs: 1,
      });
    });
    await flush();

    expect(rejected).toEqual([]);
    expect(calls("audio_seek")).toHaveLength(2);
    expect(playback.playbackTimeSeconds).toBe(14);
  });

  it("bounds repeated loop-boundary seeks without reusing an obsolete revision", async () => {
    enableNativePlayback();
    await setup(session({ loopRange: { startSeconds: 5, endSeconds: 10 } }));
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const firstSeek = deferred<Record<string, unknown>>();
    let revision = 1;
    const rejected: number[] = [];

    invoke.mockImplementation(async (command, args) => {
      if (command !== "audio_seek") return originalInvoke(command, args);
      const control = (args as { payload: { timelineRevision: number; timeSeconds: number } }).payload;
      if (control.timelineRevision !== revision) {
        rejected.push(control.timelineRevision);
        throw new Error("stale_timeline_revision");
      }
      const result = await originalInvoke(command, args);
      revision += 1;
      const snapshot = { ...(result as object), timelineRevision: revision };
      return revision === 2 ? firstSeek.promise : snapshot;
    });

    const boundary = {
      sessionId: "synthetic:native:sine",
      state: "playing" as const,
      positionSeconds: 10,
      durationSeconds: 30,
      playbackRate: 1,
    };
    act(() => emitMockNativePlaybackPosition(boundary));
    await flush();
    act(() => emitMockNativePlaybackPosition(boundary));
    await flush();
    expect(calls("audio_seek")).toHaveLength(1);
    await act(async () => {
      firstSeek.resolve({
        sessionId: boundary.sessionId,
        state: "playing",
        positionSeconds: 5,
        durationSeconds: 30,
        playbackRate: 1,
        nativePlaybackSupported: true,
        availabilityReason: null,
        lanes: [],
        bufferHealth: [],
        leaseId: "project-playback",
        generation: 1,
        timelineRevision: 2,
        nativeTimeUs: 1,
      });
    });
    await flush();

    expect(rejected).toEqual([]);
    expect(calls("audio_seek").length).toBeLessThanOrEqual(2);
    expect(playback.isPlaying).toBe(true);
  });

  it("sends an owner-scoped safety Stop after a native command failure", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    let transportStopped = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_seek") {
        throw new Error("output_stream_failure");
      }
      const result = await originalInvoke(command, args);
      if (command === "audio_stop") {
        transportStopped = true;
      }
      return result;
    });

    act(() => playback.seekTo(12));
    await flush();

    expect(calls("audio_stop")).toHaveLength(1);
    expect(transportStopped).toBe(true);
    expect(playback.isPlaying).toBe(false);
    expect(playback.playbackTimeSeconds).toBe(12);
  });

  for (const action of ["stop", "pause", "seek"] as const) {
    it(`${action} supersedes native playback preparation`, async () => {
      enableNativePlayback();
      await setup();
      const invoke = getMockInvoke();
      const originalInvoke = invoke.getMockImplementation()!;
      const preparation = deferred<Record<string, unknown>>();
      let prepared: unknown;
      invoke.mockImplementation(async (command, args) => {
        const result = await originalInvoke(command, args);
        if (command === "audio_prepare_session") {
          prepared = result;
          return preparation.promise;
        }
        return result;
      });

      let play!: Promise<void>;
      act(() => {
        play = playback.playPlayback();
      });
      await flush();
      act(() => {
        if (action === "stop") playback.stopPlayback();
        else if (action === "pause") playback.pausePlayback();
        else playback.seekTo(12);
      });
      await act(async () => {
        preparation.resolve(prepared as Record<string, unknown>);
        await play;
      });
      await flush();

      expect(calls("audio_play")).toHaveLength(0);
      expect(calls("audio_stop")).toHaveLength(1);
      expect(playback.playbackTimeSeconds).toBe(action === "seek" ? 12 : 0);
    });
  }

  for (const precountEnabled of [false, true]) {
    it(`does not accept a Play reply after seek${precountEnabled ? " with count-in" : ""}`, async () => {
      enableNativePlayback();
      await setup(session({ precountEnabled }));
      const invoke = getMockInvoke();
      const originalInvoke = invoke.getMockImplementation()!;
      const pendingPlay = deferred<Record<string, unknown>>();
      let played: Record<string, unknown> | undefined;
      invoke.mockImplementation(async (command, args) => {
        const result = await originalInvoke(command, args);
        if (command === "audio_play") {
          played = result as Record<string, unknown>;
          return pendingPlay.promise;
        }
        return result;
      });

      let play!: Promise<void>;
      act(() => {
        play = playback.playPlayback();
      });
      await flush();
      act(() => playback.seekTo(12));
      await act(async () => {
        pendingPlay.resolve(played!);
        await play;
      });
      await flush();

      expect(calls("audio_stop")).toHaveLength(1);
      expect(playback.playbackTimeSeconds).toBe(12);
      expect(playback.isPlaying).toBe(false);
      expect(playback.isPrecounting).toBe(false);
    });
  }

  it("accepts a correlated count-in completion before Play resolves", async () => {
    enableNativePlayback();
    await setup(session({ precountEnabled: true }));
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const pendingPlay = deferred<Record<string, unknown>>();
    let played: Record<string, unknown> | undefined;
    invoke.mockImplementation(async (command, args) => {
      const result = await originalInvoke(command, args);
      if (command === "audio_play") {
        played = result as Record<string, unknown>;
        return pendingPlay.promise;
      }
      return result;
    });

    let play!: Promise<void>;
    act(() => {
      play = playback.playPlayback();
    });
    await flush();
    act(() => emitMockNativeAudioCue({
      kind: "precount_completion",
      generation: played?.generation,
      revision: played?.timelineRevision,
      cueIndex: 4,
      scheduledNativeTimeUs: 2_035_000,
      actualNativeTimeUs: 2_035_000,
      insertionSequence: 5,
      accent: false,
      gain: 1,
    }));
    await act(async () => {
      pendingPlay.resolve(played!);
      await play;
    });
    await flush();

    expect(playback.isPrecounting).toBe(false);
    expect(playback.isPlaying).toBe(true);
  });

  it("restarts a native EOF loop after stopped then ended events", async () => {
    enableNativePlayback();
    await setup(session({ loopRange: { startSeconds: 5, endSeconds: 30 } }));
    await act(async () => playback.playPlayback());
    const snapshot = await getMockInvoke()("audio_get_snapshot") as Record<string, unknown>;
    const ended = { ...snapshot, state: "stopped", positionSeconds: 30 };

    act(() => {
      emitMockNativePlaybackPosition(ended as Parameters<typeof emitMockNativePlaybackPosition>[0]);
    });
    const listener = mockListen.mock.calls
      .find(([name]) => name === "audio://ended")?.[1];
    act(() => listener?.({ event: "audio://ended", id: 1, payload: ended }));
    await flush();

    expect(calls("audio_play")).toHaveLength(2);
  });

  it("restarts a native EOF loop with loop count-in and followed metronome active", async () => {
    enableNativePlayback();
    render(
      <PlaybackProvider>
        <Harness />
        <MetronomeProvider>
          <MetronomeHarness />
        </MetronomeProvider>
      </PlaybackProvider>,
    );
    act(() => playback.registerProjectSession(session({
      loopRange: { startSeconds: 5, endSeconds: 30 },
      precountEnabled: false,
      precountLoopEnabled: true,
    })));
    await flush();
    await act(async () => playback.playPlayback());
    await act(async () => metronome.setFollowPlaybackEnabled(true));
    const snapshot = await getMockInvoke()("audio_get_snapshot") as Record<string, unknown>;
    const ended = { ...snapshot, state: "stopped", positionSeconds: 30 };

    act(() => {
      emitMockNativePlaybackPosition(ended as Parameters<typeof emitMockNativePlaybackPosition>[0]);
    });
    const listener = mockListen.mock.calls
      .find(([name]) => name === "audio://ended")?.[1];
    act(() => listener?.({ event: "audio://ended", id: 1, payload: ended }));
    await flush();

    expect(calls("audio_play")).toHaveLength(2);
    const replay = calls("audio_play")[1]?.[1] as {
      payload?: { precount?: { intervalsSeconds?: number[] } | null };
    } | undefined;
    expect(replay?.payload?.precount?.intervalsSeconds).toHaveLength(4);
    expect(metronome.isRunning).toBe(true);
  });

  it("stops old native ownership when switching projects", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    act(() => playback.registerProjectSession(session({ projectId: "second" })));
    await flush();
    act(() => emitMockNativePlaybackPosition({
      sessionId: "synthetic:native:sine",
      state: "playing",
      positionSeconds: 9,
      durationSeconds: 30,
    }));
    await flush();

    expect(calls("audio_stop")).toHaveLength(1);
    expect(playback.session?.projectId).toBe("second");
    expect(playback.isPlaying).toBe(false);
    expect(playback.playbackTimeSeconds).toBe(0);
  });

  it("ignores a late project-A ended event after project B is registered", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    const endedA = {
      ...(await getMockInvoke()("audio_get_snapshot") as Record<string, unknown>),
      state: "stopped",
      positionSeconds: 30,
    };
    act(() => playback.registerProjectSession(session({
      projectId: "second",
      loopRange: { startSeconds: 5, endSeconds: 30 },
      precountLoopEnabled: true,
    })));
    await flush();
    const playCount = calls("audio_play").length;
    const listener = mockListen.mock.calls
      .find(([name]) => name === "audio://ended")?.[1];
    act(() => listener?.({ event: "audio://ended", id: 1, payload: endedA }));
    await flush();

    expect(calls("audio_play")).toHaveLength(playCount);
    expect(playback.session?.projectId).toBe("second");
    expect(playback.isPrecounting).toBe(false);
    expect(playback.isPlaying).toBe(false);
  });

  it("does not let a late project prepare replace newer native ownership", async () => {
    enableNativePlayback();
    await setup();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const pendingPrepare = deferred<Record<string, unknown>>();
    let firstPrepare = true;
    let preparedA: Record<string, unknown> | undefined;
    let playedB: Record<string, unknown> | undefined;
    let activeGeneration = 1;

    invoke.mockImplementation(async (command, args) => {
      const payload = (args as { payload?: Record<string, unknown> } | undefined)?.payload;
      if (
        ["audio_play", "audio_pause", "audio_stop", "audio_seek"].includes(command) &&
        payload?.generation !== activeGeneration
      ) {
        throw new Error("stale_generation");
      }
      const result = await originalInvoke(command, args) as Record<string, unknown>;
      if (command === "audio_prepare_session" && firstPrepare) {
        firstPrepare = false;
        preparedA = result;
        return pendingPrepare.promise;
      }
      if (command === "audio_play" && result.sessionId !== preparedA?.sessionId) {
        playedB = result;
      }
      return result;
    });

    let playingA!: Promise<void>;
    act(() => {
      playingA = playback.playPlayback();
    });
    await flush();
    expect(preparedA).toBeDefined();

    activeGeneration = 2;
    setMockNativeAudioState({
      snapshot: { generation: 2, timelineRevision: 1, nativeTimeUs: 2 },
    });
    act(() => playback.registerProjectSession(session({
      projectId: "second",
      selectedPlaybackArtifactId: "sine-two",
      playbackArtifactIds: ["sine-two"],
      artifactPathsById: { "sine-two": "/tmp/synthetic-two.wav" },
      artifactFormatsById: { "sine-two": "wav" },
    })));
    await act(async () => playback.playPlayback());
    await flush();
    expect(playedB).toBeDefined();
    expect(playback.isPlaying).toBe(true);
    const stopCount = calls("audio_stop").length;

    await act(async () => {
      pendingPrepare.resolve(preparedA!);
      await playingA;
    });
    await flush();
    expect(calls("audio_stop")).toHaveLength(stopCount);
    act(() => emitMockNativePlaybackPosition({
      ...(playedB as Parameters<typeof emitMockNativePlaybackPosition>[0]),
      state: "playing",
      positionSeconds: 9,
      durationSeconds: 30,
    }));
    await flush();

    expect(playback.playbackTimeSeconds).toBe(9);
    expect(playback.isPlaying).toBe(true);
    const pauseCount = calls("audio_pause").length;
    act(() => playback.pausePlayback());
    await flush();
    const pause = calls("audio_pause")[pauseCount]?.[1] as {
      payload?: { generation?: number; timelineRevision?: number };
    } | undefined;
    expect(pause?.payload).toMatchObject({
      generation: playedB?.generation,
      timelineRevision: playedB?.timelineRevision,
    });
  });
});

describe("buffered Web playback race regressions", () => {
  for (const action of ["stop", "pause", "seek"] as const) {
    it(`${action} cancels pending buffer preparation`, async () => {
      const response = deferred<Response>();
      getMockFetch().mockImplementationOnce(() => response.promise);
      await setup(bufferedSession());
      let play!: Promise<void>;
      act(() => {
        play = playback.playPlayback();
      });
      await flush();
      act(() => {
        if (action === "stop") playback.stopPlayback();
        else if (action === "pause") playback.pausePlayback();
        else playback.seekTo(12);
      });
      await act(async () => {
        response.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
        await play;
      });
      await flush();

      expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(0);
      expect(playback.isPlaying).toBe(false);
      expect(playback.playbackTimeSeconds).toBe(action === "seek" ? 12 : 0);
    });
  }

  for (const action of ["stop", "pause", "seek"] as const) {
    it(`${action} cancels pending count-in buffer preparation`, async () => {
      const response = deferred<Response>();
      getMockFetch().mockImplementationOnce(() => response.promise);
      await setup(bufferedSession({ precountEnabled: true }));
      let play!: Promise<void>;
      act(() => {
        play = playback.playPlayback();
      });
      await flush();
      act(() => {
        if (action === "stop") playback.stopPlayback();
        else if (action === "pause") playback.pausePlayback();
        else playback.seekTo(12);
      });
      await act(async () => {
        response.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
        await play;
      });
      await flush();

      expect(playback.isPrecounting).toBe(false);
      expect(playback.isPlaying).toBe(false);
      expect(playback.playbackTimeSeconds).toBe(action === "seek" ? 12 : 0);
      expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(0);
    });
  }

  it("forced Web later start remains stopped after deferred buffer preparation", async () => {
    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
    enableNativePlayback();
    render(
      <PlaybackProvider>
        <Harness />
      </PlaybackProvider>,
    );
    act(() => playback.registerProjectSession(bufferedSession()));
    await flush();
    let initialPlay!: Promise<void>;
    act(() => {
      initialPlay = playback.playPlayback();
    });
    const initialAudio = await waitFor(() => {
      const element = document.querySelector("audio[src]") as HTMLAudioElement | null;
      expect(element).not.toBeNull();
      return element!;
    });
    markAudioReady(initialAudio, 30);
    await act(async () => initialPlay);
    await flush();
    expect(playback.isPlaying).toBe(true);
    act(() => playback.stopPlayback());

    const response = deferred<Response>();
    getMockFetch().mockImplementationOnce(() => response.promise);
    act(() => playback.registerProjectSession(bufferedSession({
      projectId: "second",
      selectedPlaybackArtifactId: "stem-two",
      playbackArtifactIds: ["stem-two"],
      artifactPathsById: { "stem-two": "/tmp/stem-two.wav" },
      artifactFormatsById: { "stem-two": "wav" },
      visibleStemArtifactIds: ["stem-two"],
      stemControls: { "stem-two": { muted: false, solo: false } },
    })));
    await flush();
    let pendingPlay!: Promise<void>;
    act(() => {
      pendingPlay = playback.playPlayback();
    });
    await flush();
    act(() => playback.stopPlayback());
    await act(async () => {
      response.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
      await pendingPlay;
    });
    await flush();

    expect(playback.isPlaying).toBe(false);
    expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(1);
  });

});

describe("followed native metronome races", () => {
  it("restores followed cues after a native tempo mutation", async () => {
    enableNativePlayback();
    let cueCount = 0;
    let playbackRate = 1;
    let timelineRevision = 1;
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      const payload = (args as { payload?: Record<string, unknown> })?.payload;
      const result = await originalInvoke(command, args);
      if (command === "audio_schedule_cues") {
        cueCount = (payload?.cues as unknown[]).length;
      }
      if (command === "audio_set_lanes" && payload?.playbackRate !== playbackRate) {
        playbackRate = Number(payload?.playbackRate);
        timelineRevision += 1;
        cueCount = 0;
      }
      return result && typeof result === "object" && "timelineRevision" in result
        ? { ...result, timelineRevision }
        : result;
    });

    render(
      <PlaybackProvider>
        <Harness />
        <MetronomeProvider>
          <MetronomeHarness />
        </MetronomeProvider>
      </PlaybackProvider>,
    );
    act(() => playback.registerProjectSession(session()));
    await flush();
    await act(async () => playback.playPlayback());
    await act(async () => metronome.setFollowPlaybackEnabled(true));
    await flush();
    expect(cueCount).toBeGreaterThan(0);

    act(() => playback.registerProjectSession(session({ tempoTargetBpm: 90 })));
    await flush();

    expect(cueCount).toBeGreaterThan(0);
  });
});
