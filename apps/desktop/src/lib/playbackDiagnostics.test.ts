import { beforeEach, describe, expect, it } from "vitest";
import {
  markPlaybackConfirmed,
  markPlaybackError,
  markPlaybackPaused,
  markPlaybackStarting,
  markPlaybackStopped,
  nativePlaybackErrorMessage,
  readPlaybackLiveDiagnostics,
  readRememberedPlaybackBackend,
  redactPlaybackDiagnosticText,
  rememberPlaybackBackend,
  resetLivePlaybackDiagnostics,
  updateNativePlaybackDiagnostics,
} from "./playbackDiagnostics";

describe("playback diagnostics", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLivePlaybackDiagnostics();
  });

  it("does not restore persisted playback history as a current path", () => {
    rememberPlaybackBackend({ backend: "native", detail: "android-aaudio" });
    resetLivePlaybackDiagnostics();

    expect(readRememberedPlaybackBackend()).toEqual({
      backend: "native",
      detail: "android-aaudio",
    });
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "not-playing",
      currentPath: "none",
    });
  });

  it.each([
    ["device_changed", "Native audio device changed."],
    ["device_not_available", "Native playback device is unavailable."],
    ["stream_invalidated", "Native playback stream was interrupted."],
    ["output_stream_failure", "Native playback output failed."],
    ["decoder_worker_failure", "Native playback decoder failed."],
  ] as const)("maps %s to fixed safe text", (code, expected) => {
    expect(nativePlaybackErrorMessage(code)).toBe(expected);
    expect(expected).not.toMatch(/\/(?:Users|private)|art_|session_/);
  });

  it("does not relabel legacy Web history without an explicit mode", () => {
    window.localStorage.setItem(
      "tuneforge.playback-backend",
      JSON.stringify({ backend: "web", detail: null }),
    );
    resetLivePlaybackDiagnostics();

    expect(readRememberedPlaybackBackend()).toBeNull();
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "not-playing",
      currentPath: "none",
    });
  });

  it("separates pending, confirmed, paused, and stopped native states", () => {
    markPlaybackStarting("native");
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "starting",
      currentPath: "none",
    });

    markPlaybackConfirmed({ backend: "native", detail: "android-aaudio" });
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "native",
      nativeBackend: "android-aaudio",
    });

    markPlaybackPaused();
    expect(readPlaybackLiveDiagnostics().currentState).toBe("paused");
    markPlaybackStopped();
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "not-playing",
      currentPath: "none",
    });
  });

  it("does not claim Web playback before confirmation and clears it on error", () => {
    updateNativePlaybackDiagnostics({
      sessionId: "session_private",
      lanes: [
        {
          id: "lane_vocals",
          artifactId: "art_private",
          role: "stem",
          effectiveGain: 1,
          muted: false,
          solo: false,
        },
      ],
      bufferHealth: [],
    });
    markPlaybackStarting("web");
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "starting",
      currentPath: "none",
      nativeSessionLaneCount: null,
      nativeBufferHealth: [],
    });

    markPlaybackConfirmed({ backend: "web", detail: null, mode: "browser" });
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "web",
    });

    markPlaybackError("Playback stopped. Web Audio could not continue.");
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "error",
      currentPath: "none",
    });
  });

  it("clears native session health when Web playback confirms directly", () => {
    updateNativePlaybackDiagnostics({
      sessionId: "session_private",
      lanes: [
        {
          id: "lane_vocals",
          artifactId: "art_private",
          role: "stem",
          effectiveGain: 1,
          muted: false,
          solo: false,
        },
      ],
      bufferHealth: [
        {
          laneId: "lane_vocals",
          artifactId: "art_private",
          role: "stem",
          ringFillSamples: 2_400,
          ringCapacitySamples: 4_800,
          underrunCount: 0,
          workerErrorCount: 0,
          lastWorkerError: null,
        },
      ],
    });

    markPlaybackConfirmed({ backend: "web", detail: null, mode: "forced" });

    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "web-forced",
      nativeSessionLaneCount: null,
      nativeBufferHealth: [],
    });
  });

  it("reports live native session health without exposing identifiers in errors", () => {
    updateNativePlaybackDiagnostics({
      sessionId: "session_private",
      lanes: [
        {
          id: "lane_vocals",
          artifactId: "art_private",
          role: "stem",
          effectiveGain: 1,
          muted: false,
          solo: false,
        },
      ],
      bufferHealth: [],
    });
    expect(readPlaybackLiveDiagnostics().nativeSessionLaneCount).toBe(1);
    expect(
      redactPlaybackDiagnosticText(
        "artifact id=art_private failed at /Users/person/private.wav for https://asset.localhost/file",
      ),
    ).not.toMatch(/art_private|\/Users\/person|asset\.localhost/);
  });

  it.each([
    [
      "Unix path with spaces",
      "Could not decode /Users/person/My Song.wav after playback started.",
      ["/Users/person", "My Song.wav"],
    ],
    [
      "quoted Unix path",
      "Could not decode '/home/person/Practice Track.flac'.",
      ["/home/person", "Practice Track.flac"],
    ],
    [
      "Windows path with spaces",
      String.raw`Could not decode C:\Users\person\My Song.wav; device disconnected.`,
      [String.raw`C:\Users\person`, "My Song.wav"],
    ],
    [
      "quoted Windows path",
      String.raw`Could not decode "D:\Audio Library\Practice Take 2".`,
      [String.raw`D:\Audio Library`, "Practice Take 2"],
    ],
    [
      "local URL",
      "Read failed at https://asset.localhost/art_private?session=session_private.",
      ["asset.localhost", "art_private", "session_private"],
    ],
    [
      "space-containing file URL",
      "Read failed at file:///Users/person/My Song.wav while opening source.",
      ["file:///Users/person", "My Song.wav"],
    ],
    [
      "unlisted file extension",
      "Could not decode /Users/person/My Track.ape after playback started.",
      ["/Users/person", "My Track.ape"],
    ],
    [
      "quoted identifiers",
      'artifact id="art_secret" failed in session="session_secret" for lane id=lane_secret',
      ["art_secret", "session_secret", "lane_secret"],
    ],
  ])("redacts %s while keeping useful failure context", (_label, message, secrets) => {
    const redacted = redactPlaybackDiagnosticText(message);

    expect(redacted).toMatch(/Could not decode|Read failed|artifact \[redacted\]/);
    secrets.forEach((secret) => expect(redacted).not.toContain(secret));
  });
});
