import {
  advanceMockAnimationFrames,
  emitMockNativeAudioCue,
  emitMockNativePlaybackPosition,
  getMockAudioContexts,
  getMockFetch,
  getMockInvoke,
  markAudioReady,
  mockListen,
  resetAppTestHarness,
  setMockAudioContextInitialState,
  setMockNativeAudioState,
} from "../../test/appTestHarness";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "./playback";
import {
  PlaybackContext,
  usePlayback,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./playback-context";
import { MetronomeProvider } from "../tools/metronome";
import {
  useMetronome,
  type MetronomeContextValue,
} from "../tools/metronome-context";
import { AudioOutputContext } from "../../lib/audioOutputContext";
import { markBrowserOutputDisconnected, setBrowserOutputRouting } from "../../lib/audioOutput";
import { readPlaybackLiveDiagnostics } from "../../lib/playbackDiagnostics";
import { DEFAULT_PROJECT_OUTPUT_ROUTING } from "../../lib/outputRouting";
import { readProjectPlaybackState, writeProjectPlaybackState } from "./projectPlaybackState";

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
    projectOutputGain: 1,
    projectOutputMuted: false,
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

function drumSession(mode: "original" | "split", onDrumModeRollback?: () => void): ProjectPlaybackSession {
  const drumIds = mode === "split" ? ["kick", "snare"] : ["drums"];
  const ids = ["bass", ...drumIds];
  return bufferedSession({
    drumMode: mode,
    drumSourceArtifactId: "source",
    onDrumModeRollback,
    selectedPlaybackArtifactId: ids[0],
    playbackArtifactIds: ids,
    visibleStemArtifactIds: ids,
    artifactPathsById: Object.fromEntries(ids.map((id) => [id, `/tmp/${id}.wav`])),
    artifactFormatsById: Object.fromEntries(ids.map((id) => [id, "wav"])),
    stemControls: Object.fromEntries(ids.map((id) => [id, { muted: false, solo: false, gain: 1 }])),
  });
}

function activePlaybackContextValue(
  targetSession: ProjectPlaybackSession,
  playbackTimeSeconds: number,
): PlaybackContextValue {
  const snapshot = {
    session: targetSession,
    playbackTimeSeconds,
    playbackDurationSeconds: 30,
    isPrecounting: false,
    isPlaying: true,
  };
  return {
    ...snapshot,
    getPlaybackSnapshot: () => snapshot,
    activateStemPlayback: async () => undefined,
    primeWebAudioForGesture: async () => undefined,
    projectOutputSaveError: null,
    outputRoutingSaveError: null,
    outputRouting: { project: { kind: "inherit" }, cue: { kind: "inherit" }, stems: {} },
    outputRoutingSnapshot: null,
    setProjectOutputRoute: () => undefined,
    setCueOutputRoute: () => undefined,
    setStemOutputRoute: () => undefined,
    resetOutputRoutes: () => undefined,
    registerProjectSession: () => undefined,
    setProjectOutputGain: () => undefined,
    setProjectOutputMuted: () => undefined,
    togglePlayback: async () => undefined,
    playPlayback: async () => undefined,
    pausePlayback: () => undefined,
    stopPlayback: () => undefined,
    releasePlaybackHandles: async () => undefined,
    dismissSession: () => undefined,
    seekBy: () => undefined,
    seekTo: () => undefined,
  };
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

function standaloneMetronomeResult(args: unknown) {
  const payload = (args as { payload?: Record<string, unknown> })?.payload;
  return {
    enabled: payload?.enabled,
    bpm: payload?.bpm,
    beatsPerBar: payload?.beatsPerBar,
    accentFirstBeat: payload?.accentFirstBeat,
    gain: payload?.gain,
    followPlayback: payload?.followPlayback,
    leaseId: "standalone-metronome",
    generation: 1,
    revision: 1,
    nativeTimeUs: 1,
  };
}

beforeEach(() => {
  resetAppTestHarness();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe("stem playback activation backend selection", () => {
  it("does not create a Web Audio context in normal Tauri", async () => {
    enableNativePlayback();
    await setup(bufferedSession());

    expect(getMockAudioContexts()).toHaveLength(0);
    await act(async () => playback.activateStemPlayback());

    expect(getMockAudioContexts()).toHaveLength(0);
  });

  for (const runtime of ["browser", "forced Web Audio"] as const) {
    it(`activates Web Audio in ${runtime}`, async () => {
      setMockAudioContextInitialState("suspended");
      if (runtime === "forced Web Audio") {
        vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
        enableNativePlayback();
      }
      await setup(bufferedSession());

      const contextsBeforeActivation = getMockAudioContexts();
      const contextCount = contextsBeforeActivation.length;
      const resumeCount = contextsBeforeActivation[contextCount - 1]?.resume.mock.calls.length ?? 0;
      await act(async () => playback.activateStemPlayback());

      expect(getMockAudioContexts()).toHaveLength(Math.max(1, contextCount));
      const contextsAfterActivation = getMockAudioContexts();
      expect(contextsAfterActivation[contextsAfterActivation.length - 1]?.resume).toHaveBeenCalledTimes(
        resumeCount + 1,
      );
    });
  }
});

describe("native playback race regressions", () => {
  it("restores native route IDs and sends drum inheritance through the owned session", async () => {
    enableNativePlayback();
    const stored = readProjectPlaybackState("synthetic");
    writeProjectPlaybackState("synthetic", { ...stored, outputRouting: {
      native: { project: { kind: "explicit-device", deviceId: "native-project" },
        cue: { kind: "inherit" }, stems: {
          "source:drums": { kind: "explicit-device", deviceId: "native-drums" },
        } },
      browser: { project: { kind: "explicit-device", deviceId: "browser-only" },
        cue: { kind: "inherit" }, stems: {} },
    } });
    await setup(bufferedSession({
      selectedPlaybackArtifactId: "kick", playbackArtifactIds: ["kick"],
      visibleStemArtifactIds: ["kick"], artifactPathsById: { kick: "/tmp/kick.wav" },
      routeLanes: [{ laneId: "kick", stableKey: "source:kick",
        parentLaneId: "drums", parentStableKey: "source:drums" }],
    }));
    await act(async () => playback.playPlayback());

    const prepareCalls = calls("audio_prepare_session");
    const prepared = prepareCalls[prepareCalls.length - 1]?.[1] as {
      payload: { outputRouting: Record<string, unknown> };
    };
    expect(prepared.payload.outputRouting).toEqual({
      project: { kind: "explicit-device", deviceId: "native-project" },
      cue: { kind: "inherit" },
      lanes: [
        { laneId: "drums", selection: { kind: "explicit-device", deviceId: "native-drums" } },
        { laneId: "kick", parentLaneId: "drums", selection: { kind: "inherit" } },
      ],
    });

    act(() => playback.setCueOutputRoute({ kind: "system-default" }));
    await flush();
    const mutations = calls("audio_set_output_routing");
    const mutation = mutations[mutations.length - 1]?.[1] as {
      payload: { cue: { kind: string } };
      control: { generation: number; timelineRevision: number };
    };
    expect(mutation.payload.cue.kind).toBe("system-default");
    expect(mutation.control.generation).toBeGreaterThan(0);
    expect(mutation.control.timelineRevision).toBeGreaterThan(0);
    expect(readProjectPlaybackState("synthetic").outputRouting.browser.project)
      .toEqual({ kind: "explicit-device", deviceId: "browser-only" });
  });

  it("applies a route chosen during native prepare before Play", async () => {
    enableNativePlayback();
    await setup(bufferedSession());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const releasePrepare = deferred<void>();
    invoke.mockImplementation((command, args) => command === "audio_prepare_session"
      ? releasePrepare.promise.then(() => originalInvoke(command, args))
      : originalInvoke(command, args));

    let play!: Promise<void>;
    act(() => { play = playback.playPlayback(); });
    await flush();
    expect(calls("audio_prepare_session")).toHaveLength(1);
    act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "late-route" }));
    releasePrepare.resolve();
    await act(async () => play);
    await flush();

    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands.indexOf("audio_set_output_routing")).toBeGreaterThan(commands.indexOf("audio_prepare_session"));
    expect(commands.indexOf("audio_set_output_routing")).toBeLessThan(commands.indexOf("audio_play"));
    const mutation = calls("audio_set_output_routing")[0]?.[1] as {
      payload: { project: { deviceId: string } };
    };
    expect(mutation.payload.project.deviceId).toBe("late-route");
    expect(playback.isPlaying).toBe(true);
  });

  it("retries an unchanged native selection after fallback without passive retries", async () => {
    enableNativePlayback();
    await setup(bufferedSession());
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    let routingAttempts = 0;
    invoke.mockImplementation(async (command, args) => {
      const result = await originalInvoke(command, args);
      if (command !== "audio_set_output_routing" || ++routingAttempts !== 1) return result;
      const snapshot = result as { outputRouting: { project: Record<string, unknown> } };
      return { ...snapshot, outputRouting: { ...snapshot.outputRouting,
        project: { ...snapshot.outputRouting.project, effectiveDeviceId: null,
          fallbackLatched: true, status: "fallback-default" } } };
    });

    act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "native-speaker" }));
    await flush();
    expect(calls("audio_set_output_routing")).toHaveLength(1);
    expect(playback.outputRoutingSnapshot?.project.fallbackLatched).toBe(true);

    act(() => playback.registerProjectSession(bufferedSession({ projectOutputGain: 0.8 })));
    await flush();
    expect(calls("audio_set_output_routing")).toHaveLength(1);

    act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "native-speaker" }));
    await flush();
    expect(calls("audio_set_output_routing")).toHaveLength(2);
    expect(playback.outputRoutingSnapshot?.project.fallbackLatched).toBe(false);
    expect(playback.outputRoutingSnapshot?.project.effectiveDeviceId).toBe("native-speaker");
  });

  it("uses the initial prepare attempt for a same-route action during preparation", async () => {
    enableNativePlayback();
    const stored = readProjectPlaybackState("synthetic");
    writeProjectPlaybackState("synthetic", { ...stored, outputRouting: {
      ...stored.outputRouting,
      native: { ...stored.outputRouting.native,
        project: { kind: "explicit-device", deviceId: "native-speaker" } },
    } });
    await setup(bufferedSession());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const releasePrepare = deferred<void>();
    invoke.mockImplementation((command, args) => command === "audio_prepare_session"
      ? releasePrepare.promise.then(() => originalInvoke(command, args))
      : originalInvoke(command, args));

    let play!: Promise<void>;
    act(() => { play = playback.playPlayback(); });
    await flush();
    act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "native-speaker" }));
    releasePrepare.resolve();
    await act(async () => play);
    expect(calls("audio_prepare_session")[0]?.[1]).toMatchObject({
      payload: { outputRouting: { project: { kind: "explicit-device", deviceId: "native-speaker" } } },
    });
    expect(calls("audio_set_output_routing")).toHaveLength(0);

    act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "native-speaker" }));
    await flush();
    expect(calls("audio_set_output_routing")).toHaveLength(1);
  });

  it("requires an acknowledged native Stop before releasing playback handles", async () => {
    enableNativePlayback();
    await setup(bufferedSession());
    await act(async () => playback.playPlayback());
    setMockNativeAudioState({ stopError: "output_stream_failure" });

    await act(async () => {
      await expect(playback.releasePlaybackHandles()).rejects.toThrow("output_stream_failure");
    });
    expect(calls("audio_stop")).toHaveLength(1);
    expect(playback.session?.isStemPlayback).toBe(true);
  });

  it("does not inherit a swallowed failure from an in-flight ordinary Stop", async () => {
    enableNativePlayback();
    await setup(bufferedSession());
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    invoke.mockImplementation((command, args) => command === "audio_stop"
      ? stopped : originalInvoke(command, args));

    act(() => playback.stopPlayback());
    await flush();
    const release = playback.releasePlaybackHandles();
    rejectStop(new Error("output_stream_failure"));
    await act(async () => {
      await expect(release).rejects.toThrow("output_stream_failure");
    });
    expect(calls("audio_stop")).toHaveLength(1);
  });

  it("rejects a stale Stop acknowledgment after queued seek advances the native revision", async () => {
    enableNativePlayback();
    await setup(bufferedSession());
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const pendingSeek = deferred<Record<string, unknown>>();
    let seekSnapshot: Record<string, unknown> | null = null;
    invoke.mockImplementation(async (command, args) => {
      const result = await originalInvoke(command, args);
      if (command === "audio_seek") {
        seekSnapshot = { ...(result as object), timelineRevision: 2 };
        return pendingSeek.promise;
      }
      if (command === "audio_stop") return { ...(result as object), timelineRevision: 1 };
      return result;
    });

    act(() => playback.seekTo(8));
    await flush();
    const release = playback.releasePlaybackHandles();
    await act(async () => {
      pendingSeek.resolve(seekSnapshot!);
      await expect(release).rejects.toThrow("did not acknowledge Stop");
    });
    const stopPayload = calls("audio_stop")[0]?.[1] as { payload?: { timelineRevision?: number } };
    expect(stopPayload.payload?.timelineRevision).toBe(2);
  });

  for (const invalidRevision of [undefined, NaN]) {
    it(`rejects a Stop acknowledgment with ${String(invalidRevision)} revision`, async () => {
      enableNativePlayback();
      await setup(bufferedSession());
      await act(async () => playback.playPlayback());
      const invoke = getMockInvoke();
      const originalInvoke = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command, args) => {
        const result = await originalInvoke(command, args);
        return command === "audio_stop"
          ? { ...(result as object), timelineRevision: invalidRevision }
          : result;
      });
      await act(async () => {
        await expect(playback.releasePlaybackHandles()).rejects.toThrow("did not acknowledge Stop");
      });
    });
  }

  for (const cueRoute of [{ kind: "inherit" }, { kind: "explicit-device", deviceId: "cue-speaker" }] as const) {
    it(`keeps original playback running when inactive stems arrive (${cueRoute.kind})`, async () => {
      enableNativePlayback();
      const original = session();
      await setup(original);
      act(() => playback.setCueOutputRoute(cueRoute));
      await flush();
      await act(async () => playback.playPlayback());
      act(() => playback.seekTo(9));
      await flush();
      const prepareCount = calls("audio_prepare_session").length;
      const routeCount = calls("audio_set_output_routing").length;
      const stopCount = calls("audio_stop").length;
      act(() => playback.registerProjectSession(session({
        playbackArtifactIds: ["sine", "new-stem"],
        visibleStemArtifactIds: ["new-stem"],
        artifactPathsById: { sine: "/tmp/synthetic.wav", "new-stem": "/tmp/new-stem.wav" },
        routeLanes: [{ laneId: "new-stem", stableKey: "source:vocals" }],
      })));
      await flush();
      expect(calls("audio_prepare_session")).toHaveLength(prepareCount);
      expect(calls("audio_set_output_routing")).toHaveLength(routeCount);
      expect(calls("audio_stop")).toHaveLength(stopCount);
      expect(playback.isPlaying).toBe(true);
      expect(playback.playbackTimeSeconds).toBe(9);
    });
  }

  it("keeps acknowledged playback running after a rejected route change", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const stopCount = calls("audio_stop").length;
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_set_output_routing") throw new Error("output_stream_failure");
      return originalInvoke(command, args);
    });
    act(() => playback.setCueOutputRoute({ kind: "explicit-device", deviceId: "missing-speaker" }));
    await flush();
    expect(playback.isPlaying).toBe(true);
    expect(calls("audio_stop")).toHaveLength(stopCount);
    expect(playback.outputRoutingSaveError).toMatch(/previous output/);
  });

  it("starts a newly selected native mix after asynchronous replacement and artifact refresh", async () => {
    enableNativePlayback();
    await setup();
    await act(async () => playback.playPlayback());
    act(() => emitMockNativePlaybackPosition({ sessionId: "synthetic:native:sine", state: "playing",
      positionSeconds: 14, durationSeconds: 30 }));
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const stop = deferred<void>();
    const prepare = deferred<void>();
    const play = deferred<void>();
    let replacementPlaying: Record<string, unknown> | undefined;
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_stop") await stop.promise;
      if (command === "audio_prepare_session") {
        await prepare.promise;
        setMockNativeAudioState({ snapshot: { generation: 2, timelineRevision: 1 } });
      }
      const result = await originalInvoke(command, args) as Record<string, unknown>;
      if (command === "audio_play") {
        replacementPlaying = result;
        await play.promise;
      }
      return result;
    });
    const mix = session({ selectedPlaybackArtifactId: "mix", playbackArtifactIds: ["sine", "mix"],
      artifactPathsById: { sine: "/tmp/synthetic.wav", mix: "/tmp/mix.wav" } });
    act(() => playback.registerProjectSession(mix));
    await flush();
    expect(calls("audio_stop")).toHaveLength(1);
    act(() => stop.resolve());
    await flush();
    act(() => playback.registerProjectSession({ ...mix, stageSummary: "Refreshed artifacts" }));
    act(() => prepare.resolve());
    await flush();
    expect(replacementPlaying?.state).toBe("playing");
    expect(calls("audio_play")[1]?.[1]).toMatchObject({ payload: {
      generation: 2, timelineRevision: 1, startTimeSeconds: 14,
    } });
    act(() => play.resolve());
    await flush();
    act(() => emitMockNativePlaybackPosition({ sessionId: "synthetic:native:mix", generation: 2,
      timelineRevision: replacementPlaying?.timelineRevision as number, state: "playing",
      positionSeconds: 14.25, durationSeconds: 30 }));
    expect(playback.session?.selectedPlaybackArtifactId).toBe("mix");
    expect(playback.isPlaying).toBe(true);
    expect(playback.playbackTimeSeconds).toBe(14.25);
    expect(readPlaybackLiveDiagnostics()).toMatchObject({ currentState: "playing", currentPath: "native", statusMessage: null });
    expect(getMockAudioContexts()).toHaveLength(0);
  });

  it("restores original playback and source selection when a replacement mix fails", async () => {
    enableNativePlayback();
    const rollback = vi.fn();
    await setup(session({ onPlaybackSourceRollback: rollback }));
    await act(async () => playback.playPlayback());
    act(() => playback.seekTo(9));
    await flush();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      const payload = (args as { payload?: { lanes?: { artifactId?: string }[] } })?.payload;
      if (command === "audio_prepare_session" && payload?.lanes?.some((lane) => lane.artifactId === "mix")) {
        throw new Error("output_stream_failure");
      }
      return originalInvoke(command, args);
    });
    act(() => playback.registerProjectSession(session({ selectedPlaybackArtifactId: "mix",
      playbackArtifactIds: ["mix"], artifactPathsById: { mix: "/tmp/mix.wav" } })));
    await flush();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(playback.session?.selectedPlaybackArtifactId).toBe("sine");
    expect(playback.playbackTimeSeconds).toBe(9);
    expect(playback.isPlaying).toBe(true);
  });

  it("switches drum representation at the current playing position without parent and child overlap", async () => {
    enableNativePlayback();
    await setup(drumSession("original"));
    await act(async () => playback.playPlayback());
    act(() => playback.seekTo(9));
    await flush();

    act(() => playback.registerProjectSession(drumSession("split")));
    await flush();

    expect(playback.session?.drumMode).toBe("split");
    expect(playback.playbackTimeSeconds).toBe(9);
    expect(playback.isPlaying).toBe(true);
    const prepares = calls("audio_prepare_session");
    const lastPrepare = prepares[prepares.length - 1]?.[1] as { payload?: { lanes?: { artifactId: string }[] } };
    const laneIds = lastPrepare?.payload?.lanes?.map((lane) => lane.artifactId) ?? [];
    expect(laneIds).not.toContain("drums");
    expect(laneIds).toEqual(expect.arrayContaining(["kick", "snare"]));
  });

  it("restores the original native session and paused position after a failed drum switch", async () => {
    enableNativePlayback();
    const rollback = vi.fn();
    await setup(drumSession("original", rollback));
    act(() => playback.seekTo(7));
    await flush();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      const payload = (args as { payload?: { lanes?: { artifactId?: string }[] } })?.payload;
      if (command === "audio_prepare_session" && payload?.lanes?.some((lane) => lane.artifactId === "kick")) {
        throw new Error("output_stream_failure");
      }
      return originalInvoke(command, args);
    });

    act(() => playback.registerProjectSession(drumSession("split")));
    await flush();

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(playback.session?.drumMode).toBe("original");
    expect(playback.playbackTimeSeconds).toBe(7);
    expect(playback.isPlaying).toBe(false);
  });

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

  it("fails closed when the current native Pause is rejected", async () => {
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
    expect(calls("audio_stop")).toHaveLength(1);
    expect((calls("audio_stop")[0]?.[1] as { payload?: object })?.payload).toMatchObject({
      generation: 1,
      timelineRevision: 1,
    });
    expect(playback.isPlaying).toBe(false);
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

  it("reconciles the latest project output after deferred prepare and corrective lanes", async () => {
    enableNativePlayback();
    await setup();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const preparation = deferred<Record<string, unknown>>();
    const correctiveLanes = deferred<Record<string, unknown>>();
    let prepared: Record<string, unknown> | undefined;
    let corrected: Record<string, unknown> | undefined;
    let deferFirstLaneUpdate = true;
    invoke.mockImplementation(async (command, args) => {
      const result = await originalInvoke(command, args) as Record<string, unknown>;
      if (command === "audio_prepare_session") {
        prepared = result;
        return preparation.promise;
      }
      if (command === "audio_set_lanes" && deferFirstLaneUpdate) {
        deferFirstLaneUpdate = false;
        corrected = result;
        return correctiveLanes.promise;
      }
      return result;
    });

    let play!: Promise<void>;
    act(() => {
      play = playback.playPlayback();
    });
    await flush();
    expect(prepared).toBeDefined();
    act(() => playback.registerProjectSession(session({ projectOutputMuted: true })));
    act(() => preparation.resolve(prepared!));
    await flush();
    expect(corrected).toBeDefined();
    act(() => playback.registerProjectSession(session({
      projectOutputGain: 0.4,
      projectOutputMuted: true,
    })));
    await act(async () => {
      correctiveLanes.resolve(corrected!);
      await play;
    });

    const laneCallIndexes = invoke.mock.calls.flatMap(([command], index) =>
      command === "audio_set_lanes" ? [index] : [],
    );
    const laneCallIndex = laneCallIndexes[laneCallIndexes.length - 1] ?? -1;
    const playCallIndex = invoke.mock.calls.findIndex(([command]) => command === "audio_play");
    expect(laneCallIndexes.length).toBeGreaterThanOrEqual(2);
    expect(laneCallIndex).toBeLessThan(playCallIndex);
    expect(invoke.mock.calls[laneCallIndex]?.[1]).toMatchObject({
      payload: { projectOutput: { gain: 0.4, muted: true } },
    });
  });

  it("queues project output changes made while native play is pending", async () => {
    enableNativePlayback();
    await setup();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const pendingPlay = deferred<Record<string, unknown>>();
    let played: Record<string, unknown> | undefined;
    invoke.mockImplementation(async (command, args) => {
      const result = await originalInvoke(command, args) as Record<string, unknown>;
      if (command === "audio_play") {
        played = result;
        return pendingPlay.promise;
      }
      return result;
    });

    let play!: Promise<void>;
    act(() => {
      play = playback.playPlayback();
    });
    await flush();
    expect(played).toBeDefined();
    act(() => playback.registerProjectSession(session({ projectOutputGain: 0.3 })));
    await act(async () => {
      pendingPlay.resolve(played!);
      await play;
    });
    await flush();

    const laneCalls = calls("audio_set_lanes");
    expect(laneCalls[laneCalls.length - 1]?.[1]).toMatchObject({
      payload: { projectOutput: { gain: 0.3, muted: false } },
    });
  });

  it("holds project and metronome acquisition on the shared app output barrier", async () => {
    enableNativePlayback();
    const ready = deferred<void>();
    render(
      <AudioOutputContext.Provider value={{
        appOutputGain: 1,
        appOutputMuted: false,
        countInOutputGain: 1,
        countInOutputMuted: false,
        metronomeOutputGain: 0.8,
        metronomeOutputMuted: false,
        outputSaveError: null,
        browserOutputDeviceId: null,
        browserOutputSelectionSupported: false,
        browserOutputDevices: [],
        selectBrowserOutputDevice: async () => undefined,
        authorizeBrowserOutputDevice: async () => null,
        ensureAppOutputReady: () => ready.promise,
        setAppOutputGain: () => undefined,
        setAppOutputMuted: () => undefined,
        setCountInOutputGain: () => undefined,
        setCountInOutputMuted: () => undefined,
        setMetronomeOutputGain: () => undefined,
        setMetronomeOutputMuted: () => undefined,
      }}>
        <PlaybackProvider>
          <MetronomeProvider>
            <Harness />
            <MetronomeHarness />
          </MetronomeProvider>
        </PlaybackProvider>
      </AudioOutputContext.Provider>,
    );
    act(() => playback.registerProjectSession(session()));
    await flush();

    let projectStart!: Promise<void>;
    let metronomeStart!: Promise<void>;
    act(() => {
      projectStart = playback.playPlayback();
      metronomeStart = metronome.startMetronome();
    });
    await flush();
    expect(calls("audio_prepare_session")).toHaveLength(0);
    expect(calls("audio_set_standalone_metronome")).toHaveLength(0);

    await act(async () => {
      ready.resolve();
      await Promise.all([projectStart, metronomeStart]);
    });
    expect(calls("audio_prepare_session")).toHaveLength(1);
    expect(calls("audio_set_standalone_metronome")).toHaveLength(1);
  });

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

  it("restarts three native EOF loops after each stopped then ended pair", async () => {
    enableNativePlayback();
    await setup(session({ loopRange: { startSeconds: 5, endSeconds: 30 } }));
    await act(async () => playback.playPlayback());
    const listener = mockListen.mock.calls
      .find(([name]) => name === "audio://ended")?.[1];

    for (let wrap = 1; wrap <= 3; wrap += 1) {
      const snapshot = await getMockInvoke()("audio_get_snapshot") as Record<string, unknown>;
      const ended = { ...snapshot, state: "stopped", positionSeconds: 30 };
      act(() => {
        emitMockNativePlaybackPosition(
          ended as Parameters<typeof emitMockNativePlaybackPosition>[0],
        );
        listener?.({ event: "audio://ended", id: wrap, payload: ended });
      });
      await flush();

      expect(calls("audio_play")).toHaveLength(wrap + 1);
    }
  });

  it("does not re-arm song count-in from a native stopped position alone", async () => {
    enableNativePlayback();
    await setup(session({ precountEnabled: true }));
    await act(async () => playback.playPlayback());
    const snapshot = await getMockInvoke()("audio_get_snapshot") as Record<string, unknown>;
    act(() => emitMockNativeAudioCue({
      generation: snapshot.generation,
      revision: snapshot.timelineRevision,
      cueIndex: 4,
      kind: "precount_completion",
      accent: false,
      gain: 1,
      scheduledNativeTimeUs: 2_000_000,
      actualNativeTimeUs: 2_000_000,
      insertionSequence: 5,
    }));
    act(() => emitMockNativePlaybackPosition({
      ...snapshot,
      state: "stopped",
      positionSeconds: 0,
    } as Parameters<typeof emitMockNativePlaybackPosition>[0]));
    await flush();
    expect(playback.playbackTimeSeconds).toBe(0);
    await act(async () => playback.playPlayback());

    expect(calls("audio_play")).toHaveLength(2);
    expect(calls("audio_play")[1]?.[1]).toMatchObject({ payload: { precount: null } });
  });

  it("restarts a native EOF loop with loop count-in and followed metronome active", async () => {
    enableNativePlayback();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) =>
      command === "audio_set_standalone_metronome"
        ? standaloneMetronomeResult(args)
        : originalInvoke(command, args),
    );
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
    await act(async () => metronome.startMetronome());
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

  it("runs one buffered loop count-in on each of three natural wraps", async () => {
    vi.useFakeTimers();
    await setup(bufferedSession({
      loopRange: { startSeconds: 5, endSeconds: 30 },
      precountLoopEnabled: true,
    }));
    await act(async () => playback.playPlayback());

    const context = getMockAudioContexts()[0]!;
    expect(context.createdOscillators).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(2_035));
    await flush();

    for (let wrap = 1; wrap <= 3; wrap += 1) {
      const source = context.createdSources[context.createdSources.length - 1]!;
      act(() => source.onended?.call(
        source as unknown as AudioBufferSourceNode,
        new Event("ended"),
      ));
      await flush();

      expect(context.createdOscillators).toHaveLength((wrap + 1) * 4);
      await act(async () => vi.advanceTimersByTimeAsync(2_035));
      await flush();
      expect(context.createdSources).toHaveLength(wrap + 1);
    }
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
  it("discards deferred buffers when selected and Default outputs fail during startup", async () => {
    const mediaSink = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
    const mediaSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "sinkId");
    const streamDestination = Object.getOwnPropertyDescriptor(AudioContext.prototype,
      "createMediaStreamDestination");
    const selected = new WeakMap<HTMLMediaElement, string>();
    Object.defineProperty(HTMLMediaElement.prototype, "sinkId", { configurable: true,
      get(this: HTMLMediaElement) { return selected.get(this) ?? ""; } });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true,
      value: vi.fn(function(this: HTMLMediaElement, deviceId: string) {
        if (!deviceId) return Promise.reject(new Error("Default unavailable"));
        selected.set(this, deviceId);
        return Promise.resolve();
      }) });
    Object.defineProperty(AudioContext.prototype, "createMediaStreamDestination", {
      configurable: true, value: vi.fn(() => ({ stream: { getTracks: () => [] } })),
    });
    try {
      const buffers = deferred<Response>();
      getMockFetch().mockImplementationOnce(() => buffers.promise);
      await setup(bufferedSession({ precountEnabled: true,
        routeLanes: [{ laneId: "stem", stableKey: "stem" }] }));
      act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "speaker" }));
      await flush();
      expect(playback.outputRoutingSnapshot?.lanes[0]?.effectiveDeviceId).toBe("speaker");

      let play!: Promise<void>;
      act(() => { play = playback.playPlayback(); });
      await flush();
      expect(getMockFetch()).toHaveBeenCalledTimes(1);
      expect(playback.isPrecounting).toBe(false);

      act(() => markBrowserOutputDisconnected("speaker"));
      await flush();
      expect(playback.isPlaying).toBe(false);
      expect(playback.isPrecounting).toBe(false);

      await act(async () => {
        buffers.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
        await play;
      });
      await flush();
      expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(0);
      expect(getMockAudioContexts().flatMap((context) => context.createdOscillators)).toHaveLength(0);
      expect(playback.isPlaying).toBe(false);
      expect(playback.isPrecounting).toBe(false);
    } finally {
      setBrowserOutputRouting({ projectId: null, globalDeviceId: null,
        routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
      if (mediaSink) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", mediaSink);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
      if (mediaSinkId) Object.defineProperty(HTMLMediaElement.prototype, "sinkId", mediaSinkId);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "sinkId");
      if (streamDestination) Object.defineProperty(AudioContext.prototype,
        "createMediaStreamDestination", streamDestination);
      else Reflect.deleteProperty(AudioContext.prototype, "createMediaStreamDestination");
    }
  });

  it("keeps the new project's startup intent when old buffers settle", async () => {
    const mediaSink = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
    const mediaSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "sinkId");
    const streamDestination = Object.getOwnPropertyDescriptor(AudioContext.prototype,
      "createMediaStreamDestination");
    const selected = new WeakMap<HTMLMediaElement, string>();
    Object.defineProperty(HTMLMediaElement.prototype, "sinkId", { configurable: true,
      get(this: HTMLMediaElement) { return selected.get(this) ?? ""; } });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true,
      value: vi.fn(function(this: HTMLMediaElement, deviceId: string) {
        if (!deviceId) return Promise.reject(new Error("Default unavailable"));
        selected.set(this, deviceId);
        return Promise.resolve();
      }) });
    Object.defineProperty(AudioContext.prototype, "createMediaStreamDestination", {
      configurable: true, value: vi.fn(() => ({ stream: { getTracks: () => [] } })),
    });
    try {
      const oldBuffers = deferred<Response>();
      const newBuffers = deferred<Response>();
      getMockFetch().mockImplementationOnce(() => oldBuffers.promise)
        .mockImplementationOnce(() => newBuffers.promise);
      await setup(bufferedSession({ precountEnabled: true,
        routeLanes: [{ laneId: "stem", stableKey: "stem" }] }));
      act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "speaker" }));
      await flush();
      let oldPlay!: Promise<void>;
      act(() => { oldPlay = playback.playPlayback(); });
      await flush();

      const newProject = bufferedSession({ projectId: "other", precountEnabled: true,
        routeLanes: [{ laneId: "stem", stableKey: "stem" }] });
      act(() => playback.registerProjectSession(newProject));
      act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "speaker" }));
      await flush();
      let newPlay!: Promise<void>;
      act(() => { newPlay = playback.playPlayback(); });
      await flush();
      expect(getMockFetch()).toHaveBeenCalledTimes(2);

      await act(async () => {
        oldBuffers.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
        await oldPlay;
      });
      expect(playback.outputRoutingSnapshot?.lanes[0]?.effectiveDeviceId).toBe("speaker");
      act(() => markBrowserOutputDisconnected("speaker"));
      await flush();
      await act(async () => {
        newBuffers.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
        await newPlay;
      });
      expect(getMockAudioContexts().flatMap((context) => context.createdSources)).toHaveLength(0);
      expect(getMockAudioContexts().flatMap((context) => context.createdOscillators)).toHaveLength(0);
      expect(playback.isPlaying).toBe(false);
      expect(playback.isPrecounting).toBe(false);
    } finally {
      setBrowserOutputRouting({ projectId: null, globalDeviceId: null,
        routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
      if (mediaSink) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", mediaSink);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
      if (mediaSinkId) Object.defineProperty(HTMLMediaElement.prototype, "sinkId", mediaSinkId);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "sinkId");
      if (streamDestination) Object.defineProperty(AudioContext.prototype,
        "createMediaStreamDestination", streamDestination);
      else Reflect.deleteProperty(AudioContext.prototype, "createMediaStreamDestination");
    }
  });

  it("cancels count-in when selected and Default outputs both fail", async () => {
    const mediaSink = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
    const mediaSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "sinkId");
    const streamDestination = Object.getOwnPropertyDescriptor(AudioContext.prototype,
      "createMediaStreamDestination");
    const selected = new WeakMap<HTMLMediaElement, string>();
    Object.defineProperty(HTMLMediaElement.prototype, "sinkId", { configurable: true,
      get(this: HTMLMediaElement) { return selected.get(this) ?? ""; } });
    const setSinkId = vi.fn(function(this: HTMLMediaElement, deviceId: string) {
      if (!deviceId) return Promise.reject(new Error("Default unavailable"));
      selected.set(this, deviceId);
      return Promise.resolve();
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true,
      value: setSinkId });
    Object.defineProperty(AudioContext.prototype, "createMediaStreamDestination", {
      configurable: true, value: vi.fn(() => ({ stream: { getTracks: () => [] } })),
    });
    try {
      await setup(session({ precountEnabled: true }));
      act(() => playback.setProjectOutputRoute({ kind: "explicit-device", deviceId: "speaker" }));
      await flush();
      await act(async () => playback.playPlayback());
      await flush();
      expect(playback.isPrecounting).toBe(true);
      const sinkCalls = setSinkId.mock.calls.length;
      act(() => playback.setProjectOutputGain(0.7));
      await flush();
      expect(setSinkId).toHaveBeenCalledTimes(sinkCalls);

      markBrowserOutputDisconnected("speaker");
      await flush();
      expect(playback.isPrecounting).toBe(false);
      expect(playback.isPlaying).toBe(false);
      await new Promise((resolve) => window.setTimeout(resolve, 2_100));
      expect(playback.isPlaying).toBe(false);
    } finally {
      setBrowserOutputRouting({ projectId: null, globalDeviceId: null,
        routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
      if (mediaSink) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", mediaSink);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
      if (mediaSinkId) Object.defineProperty(HTMLMediaElement.prototype, "sinkId", mediaSinkId);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "sinkId");
      if (streamDestination) Object.defineProperty(AudioContext.prototype,
        "createMediaStreamDestination", streamDestination);
      else Reflect.deleteProperty(AudioContext.prototype, "createMediaStreamDestination");
    }
  });

  it("re-arms song count-in after natural EOF across three plays", async () => {
    vi.useFakeTimers();
    await setup(bufferedSession({ precountEnabled: true }));

    const context = getMockAudioContexts()[0]!;
    for (let playIndex = 0; playIndex < 3; playIndex += 1) {
      await act(async () => playback.playPlayback());
      await flush();

      expect(playback.isPrecounting).toBe(true);
      expect(context.createdOscillators).toHaveLength((playIndex + 1) * 4);
      await act(async () => vi.advanceTimersByTimeAsync(2_035));
      await flush();

      expect(context.createdSources).toHaveLength(playIndex + 1);
      const source = context.createdSources[context.createdSources.length - 1]!;
      act(() => source.onended?.call(
        source as unknown as AudioBufferSourceNode,
        new Event("ended"),
      ));
      await flush();
      expect(playback.isPlaying).toBe(false);
      expect(playback.playbackTimeSeconds).toBe(0);
    }
  });

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

  const schedulingCases: Array<[
    string,
    ProjectPlaybackSession["timingGrid"],
    number,
    typeof session,
  ]> = [
    [
      "buffered timing-grid",
      {
        beats_per_bar: 4,
        meter: "4/4",
        source: "detected",
        downbeat_source: null,
        downbeat_confidence: null,
        meter_confidence: null,
        beats: [
          { index: 0, seconds: 0, bar_index: 0, beat_in_bar: 1 },
          { index: 1, seconds: 0.04, bar_index: 0, beat_in_bar: 2 },
        ],
        bars: [],
      },
      0,
      bufferedSession,
    ],
    ["HTML media uniform", null, 0.56, session],
  ];
  for (const runtime of ["browser", "forced Web"] as const) {
    for (const [label, timingGrid, playbackTimeSeconds, makeSession] of schedulingCases) {
      for (const rate of [0.5, 1.5]) {
        it(`${runtime} ${label} schedules source beats in wall time at ${rate}x`, async () => {
          if (runtime === "forced Web") {
            vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
            enableNativePlayback();
          }
          const targetSession = makeSession({
            tempoOriginalBpm: 120,
            tempoTargetBpm: 120 * rate,
            timingGrid,
          });
          render(
            <PlaybackContext.Provider
              value={activePlaybackContextValue(targetSession, playbackTimeSeconds)}
            >
              <MetronomeProvider>
                <MetronomeHarness />
              </MetronomeProvider>
            </PlaybackContext.Provider>,
          );
          await act(async () => metronome.startMetronome());
          act(() => advanceMockAnimationFrames(1));

          const context = getMockAudioContexts()[0]!;
          const scheduledTimes = context.createdOscillators.flatMap((candidate) =>
            candidate.start.mock.calls.map(([time]) => Number(time)),
          );
          const observedDelay = timingGrid
            ? scheduledTimes[1]! - scheduledTimes[0]!
            : scheduledTimes[0]! - context.currentTime;
          expect(observedDelay).toBeCloseTo(0.04 / rate, 6);
        });
      }
    }
  }

});

describe("followed native metronome races", () => {
  it("stops and exposes a failed Follow cue schedule, then allows Start to retry", async () => {
    enableNativePlayback();
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    let failSchedule = true;
    invoke.mockImplementation(async (command, args) => {
      if (command === "audio_set_standalone_metronome") return standaloneMetronomeResult(args);
      if (command === "audio_schedule_cues" && failSchedule) throw new Error("output_stream_failure");
      return originalInvoke(command, args);
    });
    render(<PlaybackProvider><Harness /><MetronomeProvider><MetronomeHarness /></MetronomeProvider></PlaybackProvider>);
    act(() => playback.registerProjectSession(session()));
    await flush();
    await act(async () => playback.playPlayback());
    await act(async () => metronome.startMetronome());
    await flush();
    expect(metronome.isRunning).toBe(false);
    expect(metronome.errorMessage).toMatch(/stopping it safely/);
    expect(playback.isPlaying).toBe(true);
    failSchedule = false;
    await act(async () => metronome.startMetronome());
    await flush();
    expect(metronome.isRunning).toBe(true);
    expect(metronome.errorMessage).toBeNull();
  });

  for (const position of [0.25, 0.75, 1.25]) {
    it(`starts Follow at the next future beat from ${position}s`, async () => {
      enableNativePlayback();
      const invoke = getMockInvoke();
      const originalInvoke = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command, args) => command === "audio_set_standalone_metronome"
        ? standaloneMetronomeResult(args) : originalInvoke(command, args));
      render(<PlaybackProvider><Harness /><MetronomeProvider><MetronomeHarness /></MetronomeProvider></PlaybackProvider>);
      act(() => playback.registerProjectSession(session()));
      await flush();
      await act(async () => playback.playPlayback());
      act(() => {
        playback.seekTo(position);
        metronome.seedBpm(120);
      });
      await flush();
      await act(async () => metronome.startMetronome());
      await flush();
      const schedules = calls("audio_schedule_cues");
      const last = schedules[schedules.length - 1]?.[1] as {
        payload?: { cues?: Array<{ cueIndex: number; positionSeconds: number; accent: boolean }> };
      };
      expect(last.payload?.cues?.[0]).toMatchObject({ cueIndex: Math.ceil(position / 0.5),
        positionSeconds: Math.ceil(position / 0.5) * 0.5, accent: false });
    });
  }

  it("restores followed cues after a native tempo mutation", async () => {
    enableNativePlayback();
    let cueCount = 0;
    let playbackRate = 1;
    let timelineRevision = 1;
    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      const payload = (args as { payload?: Record<string, unknown> })?.payload;
      if (command === "audio_set_standalone_metronome") {
        return standaloneMetronomeResult(args);
      }
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
    await act(async () => metronome.startMetronome());
    await flush();
    expect(cueCount).toBeGreaterThan(0);

    act(() => playback.registerProjectSession(session({ tempoTargetBpm: 90 })));
    await flush();

    expect(cueCount).toBeGreaterThan(0);
  });
});
