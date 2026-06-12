import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockAudioContexts,
  resetAppTestHarness,
} from "../../test/appTestHarness";
import { readPlaybackE2ETelemetry } from "../../lib/playbackE2ETelemetry";
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
});
