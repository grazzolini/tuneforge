import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

import {
  normalizePowerInhibitionStatus,
  playbackPowerProtectionMessage,
  readBrowserWakeLockStatus,
  readPowerInhibitionStatus,
  readRememberedPowerInhibitionBackend,
  resetPowerInhibitionDiagnostics,
  setPowerInhibitionActivity,
  updateBrowserWakeLockStatus,
} from "./powerInhibition";

describe("power inhibition frontend boundary", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    window.localStorage.clear();
    resetPowerInhibitionDiagnostics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes untrusted status values and redacts unsafe diagnostics", () => {
    expect(
      normalizePowerInhibitionStatus({
        phase: "failed",
        backend: "/Users/example/private",
        activeReasons: ["playback", "unknown", "playback"],
        screenProtected: "yes",
        backgroundProtected: true,
        errorCode: "linux-inhibition-failed",
        errorMessage: "Could not open /Users/example/private/song.wav for session_id=session_secret",
      }),
    ).toEqual({
      phase: "failed",
      backend: null,
      activeReasons: ["playback"],
      screenProtected: false,
      backgroundProtected: true,
      errorCode: "linux-inhibition-failed",
      errorMessage: "Could not open [local path redacted] for session [redacted]",
    });
  });

  it("persists confirmed backend history without restoring active state", async () => {
    mockInvoke.mockResolvedValue({
      phase: "active",
      backend: "macos-iopm",
      activeReasons: ["playback"],
      screenProtected: true,
      backgroundProtected: true,
      errorCode: null,
      errorMessage: null,
    });

    await setPowerInhibitionActivity("playback", true);
    expect(readPowerInhibitionStatus().phase).toBe("active");
    expect(readRememberedPowerInhibitionBackend()).toBe("macos-iopm");
    expect([...Array(window.localStorage.length)].map((_, index) => window.localStorage.key(index))).toEqual([
      "tuneforge.power-inhibition-backend",
    ]);

    resetPowerInhibitionDiagnostics();
    expect(readPowerInhibitionStatus()).toMatchObject({
      phase: "inactive",
      activeReasons: [],
      screenProtected: false,
      backgroundProtected: false,
    });
    expect(readRememberedPowerInhibitionBackend()).toBe("macos-iopm");
  });

  it("keeps requested reason when release confirmation fails", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        phase: "active",
        backend: "systemd-logind",
        activeReasons: ["playback"],
        screenProtected: true,
        backgroundProtected: true,
        errorCode: null,
        errorMessage: null,
      })
      .mockRejectedValueOnce(new Error("release failed for /tmp/private.sock"));

    await setPowerInhibitionActivity("playback", true);
    await setPowerInhibitionActivity("playback", false);

    expect(readPowerInhibitionStatus()).toMatchObject({
      phase: "release-failed",
      activeReasons: ["playback"],
      backend: "systemd-logind",
      screenProtected: true,
      errorMessage: "release failed for [local path redacted]",
    });
  });

  it("does not leak stale browser failure into confirmed native playback", async () => {
    updateBrowserWakeLockStatus({
      phase: "release-failed",
      backend: "browser-screen-wake-lock",
      screenProtected: true,
      errorMessage: "Screen Wake Lock release could not be confirmed.",
    });
    mockInvoke.mockResolvedValue({
      phase: "active",
      backend: "macos-iopm",
      activeReasons: ["playback"],
      screenProtected: true,
      backgroundProtected: true,
      errorCode: null,
      errorMessage: null,
    });

    await setPowerInhibitionActivity("playback", true);

    expect(readBrowserWakeLockStatus().phase).toBe("release-failed");
    expect(playbackPowerProtectionMessage()).toBeNull();
  });

  it("converges delayed Android acquisition to active", async () => {
    vi.useFakeTimers();
    mockInvoke
      .mockResolvedValueOnce({
        phase: "acquiring",
        backend: null,
        activeReasons: ["playback"],
        screenProtected: false,
        backgroundProtected: false,
        errorCode: null,
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        phase: "acquiring",
        backend: null,
        activeReasons: ["playback"],
        screenProtected: false,
        backgroundProtected: false,
        errorCode: null,
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        phase: "active",
        backend: "android-foreground-service",
        activeReasons: ["playback"],
        screenProtected: true,
        backgroundProtected: true,
        errorCode: null,
        errorMessage: null,
      });

    const activation = setPowerInhibitionActivity("playback", true);
    await vi.advanceTimersByTimeAsync(200);

    await expect(activation).resolves.toMatchObject({ phase: "active" });
    expect(readPowerInhibitionStatus()).toMatchObject({
      phase: "active",
      backend: "android-foreground-service",
      screenProtected: true,
      backgroundProtected: true,
    });
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      "power_inhibition_set_activity",
      "power_inhibition_status",
      "power_inhibition_status",
    ]);
  });

  it("converges delayed Android acquisition to a truthful failure", async () => {
    vi.useFakeTimers();
    mockInvoke
      .mockResolvedValueOnce({
        phase: "acquiring",
        backend: null,
        activeReasons: ["playback"],
        screenProtected: false,
        backgroundProtected: false,
        errorCode: null,
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        phase: "failed",
        backend: null,
        activeReasons: ["playback"],
        screenProtected: false,
        backgroundProtected: false,
        errorCode: "android-power-control-failed",
        errorMessage: "Android could not start power protection.",
      });

    const activation = setPowerInhibitionActivity("playback", true);
    await vi.advanceTimersByTimeAsync(100);

    await expect(activation).resolves.toMatchObject({
      phase: "failed",
      errorCode: "android-power-control-failed",
    });
    expect(playbackPowerProtectionMessage()).toBe("Android could not start power protection.");
  });

  it("converges delayed release to inactive", async () => {
    vi.useFakeTimers();
    mockInvoke
      .mockResolvedValueOnce({
        phase: "active",
        backend: "android-foreground-service",
        activeReasons: ["playback"],
        screenProtected: true,
        backgroundProtected: true,
        errorCode: null,
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        phase: "releasing",
        backend: "android-foreground-service",
        activeReasons: ["playback"],
        screenProtected: true,
        backgroundProtected: true,
        errorCode: null,
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        phase: "inactive",
        backend: null,
        activeReasons: [],
        screenProtected: false,
        backgroundProtected: false,
        errorCode: null,
        errorMessage: null,
      });

    await setPowerInhibitionActivity("playback", true);
    const release = setPowerInhibitionActivity("playback", false);
    await vi.advanceTimersByTimeAsync(100);

    await expect(release).resolves.toMatchObject({ phase: "inactive", activeReasons: [] });
  });

  it("supersedes an older pending convergence without publishing its result", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "power_inhibition_status") {
        throw new Error("A superseded operation must not poll.");
      }
      const active = (args as { active?: boolean } | undefined)?.active;
      return active
        ? {
            phase: "acquiring",
            backend: null,
            activeReasons: ["playback"],
            screenProtected: false,
            backgroundProtected: false,
            errorCode: null,
            errorMessage: null,
          }
        : {
            phase: "inactive",
            backend: null,
            activeReasons: [],
            screenProtected: false,
            backgroundProtected: false,
            errorCode: null,
            errorMessage: null,
          };
    });

    const activation = setPowerInhibitionActivity("playback", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(readPowerInhibitionStatus().phase).toBe("acquiring");

    const release = setPowerInhibitionActivity("playback", false);
    await expect(release).resolves.toMatchObject({ phase: "inactive" });
    await vi.advanceTimersByTimeAsync(500);
    await expect(activation).resolves.toMatchObject({ phase: "inactive" });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
