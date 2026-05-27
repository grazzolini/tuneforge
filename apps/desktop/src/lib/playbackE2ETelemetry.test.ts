import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exposePlaybackE2ETelemetryApi,
  patchPlaybackE2ETelemetry,
  publishPlaybackE2ETelemetry,
  readPlaybackE2ETelemetry,
  resetPlaybackE2ETelemetry,
  type PlaybackE2ETelemetrySnapshot,
} from "./playbackE2ETelemetry";

const nativeSnapshot: PlaybackE2ETelemetrySnapshot = {
  activePath: "native",
  transportState: "playing",
  positionSeconds: 12,
  durationSeconds: 180,
  playbackRate: 0.9,
  loopRange: {
    startSeconds: 4,
    endSeconds: 16,
  },
  nativeBufferHealth: [
    {
      laneId: "primary",
      artifactId: "artifact-1",
      role: "primary",
      ringFillSamples: 4096,
      ringCapacitySamples: 8192,
      underrunCount: 0,
      workerErrorCount: 0,
      lastWorkerError: null,
    },
  ],
  countIn: {
    active: true,
    lastScheduled: {
      sequence: 7,
      trigger: "song-start",
      activePath: "native",
      startTimeSeconds: 0,
      clickCount: 4,
      tempoBpm: 120,
      scheduledAtContextTimeSeconds: 10,
      firstClickTimeSeconds: 10.1,
      playbackStartTimeSeconds: 12.1,
    },
    lastFired: null,
    lastCancelled: null,
  },
};

describe("playback E2E telemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetPlaybackE2ETelemetry();
    delete window.__TUNEFORGE_PLAYBACK_E2E__;
  });

  it("exposes a local window reader for the current snapshot", () => {
    publishPlaybackE2ETelemetry(nativeSnapshot);

    expect(window.__TUNEFORGE_PLAYBACK_E2E__?.read()).toEqual(nativeSnapshot);
  });

  it("returns cloned snapshots from direct and window reads", () => {
    publishPlaybackE2ETelemetry(nativeSnapshot);

    const firstRead = window.__TUNEFORGE_PLAYBACK_E2E__?.read();
    expect(firstRead).toBeDefined();
    if (!firstRead) {
      return;
    }

    firstRead.nativeBufferHealth[0].ringFillSamples = 0;
    firstRead.countIn.lastScheduled = null;

    expect(readPlaybackE2ETelemetry()).toEqual(nativeSnapshot);
  });

  it("patches top-level and count-in fields without clearing prior count-in events", () => {
    publishPlaybackE2ETelemetry(nativeSnapshot);

    patchPlaybackE2ETelemetry({
      activePath: "web-audio",
      transportState: "paused",
      countIn: {
        active: false,
        lastFired: {
          sequence: 7,
          trigger: "song-start",
          playbackStartTimeSeconds: 12.1,
          firedAtContextTimeSeconds: 12.1,
        },
      },
    });

    expect(readPlaybackE2ETelemetry()).toEqual({
      ...nativeSnapshot,
      activePath: "web-audio",
      transportState: "paused",
      countIn: {
        ...nativeSnapshot.countIn,
        active: false,
        lastFired: {
          sequence: 7,
          trigger: "song-start",
          playbackStartTimeSeconds: 12.1,
          firedAtContextTimeSeconds: 12.1,
        },
      },
    });
  });

  it("does not require a browser window", () => {
    vi.stubGlobal("window", undefined);

    expect(() => exposePlaybackE2ETelemetryApi()).not.toThrow();
    expect(() => publishPlaybackE2ETelemetry(nativeSnapshot)).not.toThrow();
  });
});
