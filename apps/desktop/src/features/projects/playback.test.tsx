import { act, fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockAudioContexts,
  getMockInvoke,
  mockListen,
  resetAppTestHarness,
  setMockNativeAudioState,
} from "../../test/appTestHarness";
import { readPlaybackE2ETelemetry } from "../../lib/playbackE2ETelemetry";
import {
  readPlaybackLiveDiagnostics,
  readRememberedNativePlaybackError,
  readRememberedWebPlaybackError,
} from "../../lib/playbackDiagnostics";
import { PlaybackProvider } from "./playback";
import {
  usePlayback,
  type PlaybackContextValue,
  type ProjectPlaybackSession,
} from "./playback-context";

const PRESERVED_PLAYBACK_TIME_SECONDS = 61.437;

function makePlaybackSession(
  artifactId: string,
  { stageTitle }: { stageTitle: string },
): ProjectPlaybackSession {
  return {
    projectId: "proj_123",
    projectName: "Demo Song",
    stageTitle,
    stageSummary: "Full playback",
    selectedPlaybackArtifactId: artifactId,
    isStemPlayback: false,
    playbackArtifactIds: [artifactId],
    artifactPathsById: { [artifactId]: `/tmp/${artifactId}.wav` },
    artifactFormatsById: { [artifactId]: "wav" },
    visibleStemArtifactIds: [],
    stemControls: {},
    durationHintSeconds: 182,
    precountEnabled: false,
    precountLoopEnabled: false,
    precountClickCount: 4,
    precountTempoBpm: null,
    tempoOriginalBpm: null,
    tempoTargetBpm: null,
    timingGrid: null,
    loopRange: null,
    chordDictionaryFollowProject: null,
  };
}

function PlaybackHarness({
  onPlayback,
  session,
}: {
  onPlayback: (playback: PlaybackContextValue) => void;
  session: ProjectPlaybackSession;
}) {
  const playback = usePlayback();
  const { registerProjectSession } = playback;

  useEffect(() => {
    registerProjectSession(session);
  }, [registerProjectSession, session]);

  useEffect(() => {
    onPlayback(playback);
  }, [onPlayback, playback]);

  return null;
}

async function flushPlaybackWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function readStartedSourceOffset(sourceIndex: number) {
  const source = getMockAudioContexts()[0]?.createdSources[sourceIndex];
  expect(source?.start).toHaveBeenCalled();
  const offsetSeconds = source?.start.mock.calls[0]?.[1];
  expect(typeof offsetSeconds).toBe("number");
  return offsetSeconds as number;
}

describe("PlaybackProvider", () => {
  beforeEach(() => {
    resetAppTestHarness();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps playback position when a newly created mix becomes active", async () => {
    let playback: PlaybackContextValue | null = null;
    const onPlayback = (nextPlayback: PlaybackContextValue) => {
      playback = nextPlayback;
    };
    const sourceSession = makePlaybackSession("art_source", {
      stageTitle: "Source Track",
    });
    const mixSession = makePlaybackSession("art_200", {
      stageTitle: "Practice Mix",
    });

    const { rerender } = render(
      <PlaybackProvider>
        <PlaybackHarness onPlayback={onPlayback} session={sourceSession} />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    await act(async () => {
      await playback?.playPlayback();
    });
    expect(readStartedSourceOffset(0)).toBe(0);

    act(() => {
      playback?.seekTo(PRESERVED_PLAYBACK_TIME_SECONDS);
    });
    await flushPlaybackWork();

    const startsBeforeMixActivation = getMockAudioContexts()[0]?.createdSources.length ?? 0;
    rerender(
      <PlaybackProvider>
        <PlaybackHarness onPlayback={onPlayback} session={mixSession} />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    expect(readStartedSourceOffset(startsBeforeMixActivation)).toBeCloseTo(
      PRESERVED_PLAYBACK_TIME_SECONDS,
      3,
    );
  });

  it("records generic cancellation when play is requested during an active count-in", async () => {
    let playback: PlaybackContextValue | null = null;
    const onPlayback = (nextPlayback: PlaybackContextValue) => {
      playback = nextPlayback;
    };
    const sourceSession = {
      ...makePlaybackSession("art_source", {
        stageTitle: "Source Track",
      }),
      precountEnabled: true,
      precountTempoBpm: 120,
    };

    render(
      <PlaybackProvider>
        <PlaybackHarness onPlayback={onPlayback} session={sourceSession} />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    await act(async () => {
      await playback?.playPlayback();
    });
    const scheduledSequence = readPlaybackE2ETelemetry().countIn.lastScheduled?.sequence;
    expect(readPlaybackE2ETelemetry().countIn.active).toBe(true);

    await act(async () => {
      await playback?.playPlayback();
    });

    expect(readPlaybackE2ETelemetry().countIn.active).toBe(false);
    expect(readPlaybackE2ETelemetry().countIn.lastCancelled).toMatchObject({
      reason: "cancelled",
      sequence: scheduledSequence,
      trigger: "song-start",
    });
  });

  it("stops Web media after five seconds without progress", async () => {
    vi.stubGlobal("fetch", undefined);
    vi.mocked(window.HTMLMediaElement.prototype.play).mockResolvedValue(undefined);
    let playback: PlaybackContextValue | null = null;
    const sourceSession = makePlaybackSession("art_source", {
      stageTitle: "Source Track",
    });

    render(
      <PlaybackProvider>
        <PlaybackHarness
          onPlayback={(nextPlayback) => {
            playback = nextPlayback;
          }}
          session={sourceSession}
        />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    await act(async () => {
      await playback?.playPlayback();
    });
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "starting",
      currentPath: "none",
    });

    const media = document.querySelector("audio");
    expect(media).not.toBeNull();
    Object.defineProperty(media, "paused", { configurable: true, value: false });
    fireEvent.stalled(media as HTMLAudioElement);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "error",
      currentPath: "none",
    });
    expect(readRememberedWebPlaybackError()).toBe(
      "Web Audio stopped making playback progress.",
    );
  });

  it("cancels a Web stall failure when confirmed playback resumes progress", async () => {
    vi.stubGlobal("fetch", undefined);
    vi.mocked(window.HTMLMediaElement.prototype.play).mockResolvedValue(undefined);
    let playback: PlaybackContextValue | null = null;
    const sourceSession = makePlaybackSession("art_source", {
      stageTitle: "Source Track",
    });

    render(
      <PlaybackProvider>
        <PlaybackHarness
          onPlayback={(nextPlayback) => {
            playback = nextPlayback;
          }}
          session={sourceSession}
        />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    await act(async () => {
      await playback?.playPlayback();
    });
    const media = document.querySelector("audio");
    expect(media).not.toBeNull();
    Object.defineProperties(media, {
      currentTime: { configurable: true, value: 0, writable: true },
      paused: { configurable: true, value: false },
    });
    fireEvent.playing(media as HTMLAudioElement);
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "web-fallback",
    });

    fireEvent.stalled(media as HTMLAudioElement);
    (media as HTMLAudioElement).currentTime = 1;
    fireEvent.timeUpdate(media as HTMLAudioElement);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "web-fallback",
    });
    expect(readRememberedWebPlaybackError()).toBeNull();
  });

  it("treats a failed native pause response as terminal without auto-resuming", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    setMockNativeAudioState({
      capabilities: {
        backend: "android-aaudio",
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
      },
    });
    let playback: PlaybackContextValue | null = null;
    const sourceSession = makePlaybackSession("art_source", {
      stageTitle: "Source Track",
    });

    render(
      <PlaybackProvider>
        <PlaybackHarness
          onPlayback={(nextPlayback) => {
            playback = nextPlayback;
          }}
          session={sourceSession}
        />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    await act(async () => {
      await playback?.togglePlayback();
    });
    expect(getMockAudioContexts()).toHaveLength(0);
    expect(window.HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(readPlaybackLiveDiagnostics().currentPath).toBe("native");

    setMockNativeAudioState({
      snapshot: {
        state: "paused",
        positionSeconds: 12.5,
        nativePlaybackSupported: false,
        fallbackReason: "Native stream failed at /Users/person/My Song.wav.",
      },
    });
    act(() => {
      playback?.pausePlayback();
    });
    await flushPlaybackWork();

    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "error",
      currentPath: "none",
      nativeSessionLaneCount: null,
      nativeBufferHealth: [],
    });
    expect(readRememberedNativePlaybackError()).toBe(
      "Native stream failed at [local path redacted].",
    );
    expect(
      getMockInvoke().mock.calls.filter(([command]) => command === "audio_play"),
    ).toHaveLength(1);
  });

  it("claims a pending native transition only once while start is unresolved", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    setMockNativeAudioState({ capabilities: {
      backend: "android-aaudio", nativePlaybackSupported: true,
      fallbackRequired: false, fallbackReason: null,
    } });
    let playback: PlaybackContextValue | null = null;
    const firstSession = makePlaybackSession("art_source", { stageTitle: "Source Track" });
    const { rerender } = render(
      <PlaybackProvider><PlaybackHarness onPlayback={(next) => { playback = next; }} session={firstSession} /></PlaybackProvider>,
    );
    await flushPlaybackWork();
    await act(async () => { await playback?.playPlayback(); });

    const invoke = getMockInvoke();
    const originalInvoke = invoke.getMockImplementation()!;
    const resolvePlays: Array<() => void> = [];
    invoke.mockImplementation((command, args) => {
      const result = originalInvoke(command, args);
      if (command !== "audio_play") return result;
      return new Promise((resolve, reject) => {
        resolvePlays.push(() => { void Promise.resolve(result).then(resolve, reject); });
      });
    });
    rerender(
      <PlaybackProvider><PlaybackHarness onPlayback={(next) => { playback = next; }} session={makePlaybackSession("art_next", { stageTitle: "Next Track" })} /></PlaybackProvider>,
    );
    await flushPlaybackWork();
    const media = document.querySelector("audio");
    fireEvent.loadedMetadata(media as HTMLAudioElement);
    fireEvent.canPlay(media as HTMLAudioElement);
    await flushPlaybackWork();

    expect(invoke.mock.calls.filter(([command]) => command === "audio_play")).toHaveLength(2);
    resolvePlays.forEach((resolve) => resolve());
    invoke.mockImplementation(originalInvoke!);
    await flushPlaybackWork();
  });

  it("refreshes native buffer health at a bounded cadence and rejects stale sessions", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    setMockNativeAudioState({
      capabilities: {
        backend: "android-aaudio",
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
      },
    });
    let playback: PlaybackContextValue | null = null;
    const sourceSession = makePlaybackSession("art_source", {
      stageTitle: "Source Track",
    });

    render(
      <PlaybackProvider>
        <PlaybackHarness
          onPlayback={(nextPlayback) => {
            playback = nextPlayback;
          }}
          session={sourceSession}
        />
      </PlaybackProvider>,
    );
    await flushPlaybackWork();

    await act(async () => {
      await playback?.playPlayback();
    });
    expect(readPlaybackLiveDiagnostics().currentPath).toBe("native");

    setMockNativeAudioState({
      snapshot: {
        bufferHealth: [
          {
            laneId: "art_source",
            artifactId: "art_source",
            role: "primary",
            ringFillSamples: 32_000,
            ringCapacitySamples: 48_000,
            underrunCount: 1,
            workerErrorCount: 0,
            lastWorkerError: null,
          },
        ],
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(
      getMockInvoke().mock.calls.filter(([command]) => command === "audio_get_snapshot"),
    ).toHaveLength(1);
    expect(readPlaybackLiveDiagnostics().nativeBufferHealth[0]).toMatchObject({
      ringFillSamples: 32_000,
      underrunCount: 1,
    });

    setMockNativeAudioState({
      snapshot: {
        sessionId: "stale-session",
        bufferHealth: [
          {
            laneId: "stale-lane",
            artifactId: "stale-artifact",
            role: "primary",
            ringFillSamples: 99,
            ringCapacitySamples: 100,
            underrunCount: 99,
            workerErrorCount: 0,
            lastWorkerError: null,
          },
        ],
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(readPlaybackLiveDiagnostics().nativeBufferHealth[0]).toMatchObject({
      ringFillSamples: 32_000,
      underrunCount: 1,
    });

    const endedHandler = mockListen.mock.calls.find(([event]) => event === "audio://ended")?.[1];
    act(() => {
      endedHandler?.({
        event: "audio://ended",
        id: 1,
        payload: {
          sessionId: "proj_123:native:art_source",
          leaseId: "project-playback",
          generation: 1,
          timelineRevision: 1,
          nativeTimeUs: 1,
          state: "stopped",
          positionSeconds: 0,
          durationSeconds: 182,
          playbackRate: 1,
          nativePlaybackSupported: true,
          fallbackReason: null,
          lanes: [],
          bufferHealth: [],
        },
      });
    });
    await flushPlaybackWork();
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "not-playing",
      currentPath: "none",
      nativeSessionLaneCount: null,
      nativeBufferHealth: [],
    });
  });
});
