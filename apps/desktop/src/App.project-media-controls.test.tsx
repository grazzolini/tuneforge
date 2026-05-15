import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferNextMockSystemMediaControlListen,
  emitMockNativePlaybackError,
  emitMockNativePlaybackPosition,
  emitMockSystemMediaPlaybackControl,
  findAudioByArtifactId,
  getMockInvoke,
  getMockMediaSession,
  getMockWakeLock,
  markAudioReady,
  rejectMockSystemMediaCommand,
  renderApp,
  resetAppTestHarness,
  resolveDeferredMockSystemMediaControlListen,
  setMockNativeAudioState,
} from "./test/appTestHarness";

async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Playback" }));
}

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });

  return () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  };
}

function latestNativeSessionId() {
  const prepareCall = [...getMockInvoke().mock.calls]
    .reverse()
    .find(([command]) => command === "audio_prepare_session");
  const payload = (prepareCall?.[1] as { payload?: { sessionId?: string } } | undefined)?.payload;
  if (!payload?.sessionId) {
    throw new Error("Native audio session was not prepared.");
  }
  return payload.sessionId;
}

function invokeCalls(command: string) {
  return getMockInvoke().mock.calls.filter(([name]) => name === command);
}

function hasSystemMediaPlaybackState(playbackState: "playing" | "paused") {
  return invokeCalls("system_media_update_state").some(([, args]) => {
    const payload = (args as { payload?: { playbackState?: string } } | undefined)?.payload;
    return payload?.playbackState === playbackState;
  });
}

function hasNativeIdleInhibition(active: boolean) {
  return invokeCalls("system_media_set_idle_inhibition").some(([, args]) => {
    return (args as { active?: boolean } | undefined)?.active === active;
  });
}

function expectNoSystemMediaCommandCalls() {
  expect(invokeCalls("system_media_update_state")).toHaveLength(0);
  expect(invokeCalls("system_media_clear_state")).toHaveLength(0);
  expect(invokeCalls("system_media_set_idle_inhibition")).toHaveLength(0);
}

function expectNoNativePlaybackCommandCalls() {
  expect(invokeCalls("audio_prepare_session")).toHaveLength(0);
  expect(invokeCalls("audio_play")).toHaveLength(0);
  expect(invokeCalls("audio_pause")).toHaveLength(0);
  expect(invokeCalls("audio_seek")).toHaveLength(0);
  expect(invokeCalls("audio_stop")).toHaveLength(0);
  expect(invokeCalls("audio_set_lanes")).toHaveLength(0);
}

function invokeCallIndexAfter(
  startIndex: number,
  command: string,
  predicate: (args: unknown) => boolean = () => true,
) {
  return getMockInvoke().mock.calls.findIndex(
    ([name, args], index) => index > startIndex && name === command && predicate(args),
  );
}

async function waitForWebOwnerControls() {
  await waitFor(() => {
    expect(hasSystemMediaPlaybackState("playing")).toBe(true);
  });
  await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledWith("screen"));
}

async function waitForNativeControls() {
  await waitFor(() => expect(hasSystemMediaPlaybackState("playing")).toBe(true));
  await waitFor(() => expect(hasNativeIdleInhibition(true)).toBe(true));
}

async function startForcedWebPlayback(user: ReturnType<typeof userEvent.setup>) {
  vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
  const restoreTauriRuntime = mockTauriRuntime();
  setMockNativeAudioState({
    capabilities: {
      nativePlaybackSupported: true,
      fallbackRequired: false,
      fallbackReason: null,
      backend: "desktop-cpal",
    },
  });
  renderApp(["/projects/proj_123"]);
  expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
  await openPlaybackWorkspace(user);
  const sourceAudio = findAudioByArtifactId("art_source");
  markAudioReady(sourceAudio);
  await user.click(screen.getByRole("button", { name: "Play playback" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());
  return restoreTauriRuntime;
}

describe("Desktop app project media controls", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("uses system media controls and browser wake lock when Web Audio is forced", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);

    await waitForWebOwnerControls();
    expect(getMockMediaSession().actionHandlers.size).toBe(0);
    expect(getMockMediaSession().setActionHandler).not.toHaveBeenCalled();
    expect(hasNativeIdleInhibition(true)).toBe(false);
    expectNoNativePlaybackCommandCalls();

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "pause" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());
    await waitFor(() => expect(getMockWakeLock().sentinels[0]?.release).toHaveBeenCalled());
    expectNoNativePlaybackCommandCalls();

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "play" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());
    expectNoNativePlaybackCommandCalls();
    restoreTauriRuntime();
  });

  it("routes system media controls to Web Audio when Web Audio owns playback", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);
    const sourceAudio = findAudioByArtifactId("art_source");

    await waitForWebOwnerControls();
    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "playPause" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "playPause" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "seekForward", seekOffsetSeconds: 10 });
    });
    await waitFor(() => {
      expect(sourceAudio.currentTime).toBeGreaterThanOrEqual(10);
      expect(sourceAudio.currentTime).toBeLessThan(11);
    });
    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "seekTo", positionSeconds: 22 });
    });
    await waitFor(() => {
      expect(sourceAudio.currentTime).toBeCloseTo(22, 3);
    });
    expectNoNativePlaybackCommandCalls();
    restoreTauriRuntime();
  });

  it("reacquires the browser wake lock after the sentinel is released", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);

    await waitForWebOwnerControls();
    expect(getMockWakeLock().request).toHaveBeenCalledTimes(1);
    getMockWakeLock().sentinels[0]?.dispatchRelease();
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(2));
    expectNoNativePlaybackCommandCalls();
    restoreTauriRuntime();
  });

  it("uses native controls and native idle inhibition after native playback starts", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitForNativeControls();
    expect(getMockMediaSession().actionHandlers.size).toBe(0);
    expect(getMockMediaSession().setActionHandler).not.toHaveBeenCalled();
    expect(getMockWakeLock().request).not.toHaveBeenCalled();

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "pause" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());
    await waitFor(() => expect(hasNativeIdleInhibition(false)).toBe(true));

    restoreTauriRuntime();
  });

  it("routes native seek controls to the native transport", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "seekForward", seekOffsetSeconds: 10 });
    });
    await waitFor(() => {
      expect(
        invokeCalls("audio_seek").some(([, args]) => {
          const payload = (args as { payload?: { timeSeconds?: number } } | undefined)?.payload;
          return payload?.timeSeconds === 10;
        }),
      ).toBe(true);
    });

    restoreTauriRuntime();
  });

  it("routes late system media listeners through the Web Audio owner after fallback", async () => {
    deferNextMockSystemMediaControlListen();
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();

    const sessionId = latestNativeSessionId();
    act(() => {
      emitMockNativePlaybackPosition({
        sessionId,
        positionSeconds: 21,
        durationSeconds: 182,
        state: "playing",
      });
    });
    act(() => {
      emitMockNativePlaybackError({
        sessionId,
        message: "Native output failed.",
      });
    });

    const sourceAudio = await waitFor(() => findAudioByArtifactId("art_source"));
    markAudioReady(sourceAudio);
    await waitForWebOwnerControls();

    const nativePauseCount = invokeCalls("audio_pause").length;
    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "pause" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());
    expect(invokeCalls("audio_pause")).toHaveLength(nativePauseCount);

    resolveDeferredMockSystemMediaControlListen();
    await Promise.resolve();

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "play" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());
    expect(invokeCalls("audio_pause")).toHaveLength(nativePauseCount);
    restoreTauriRuntime();
  });

  it("activates Web Audio system controls only after native play falls back before start", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
      playFallbackReason: "Native playback could not start.",
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));

    await waitFor(() => expect(findAudioByArtifactId("art_source")).toBeInTheDocument());
    expectNoSystemMediaCommandCalls();

    const sourceAudio = findAudioByArtifactId("art_source");
    markAudioReady(sourceAudio);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());
    await waitForWebOwnerControls();
    expect(hasNativeIdleInhibition(true)).toBe(false);
    restoreTauriRuntime();
  });

  it("does not activate Web Audio controls when native release fails during runtime fallback", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();

    rejectMockSystemMediaCommand("system_media_clear_state", "Native controls did not clear.");
    const sessionId = latestNativeSessionId();
    act(() => {
      emitMockNativePlaybackError({
        sessionId,
        message: "Native output failed.",
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());
    await Promise.resolve();
    expect(getMockMediaSession().actionHandlers.size).toBe(0);
    expect(getMockWakeLock().request).not.toHaveBeenCalled();
    restoreTauriRuntime();
  });

  it("clears native controls before activating Web Audio controls on runtime fallback", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        nativePlaybackSupported: true,
        fallbackRequired: false,
        fallbackReason: null,
        backend: "desktop-cpal",
      },
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();

    const sessionId = latestNativeSessionId();
    act(() => {
      emitMockNativePlaybackPosition({
        sessionId,
        positionSeconds: 42,
        durationSeconds: 182,
        state: "playing",
      });
    });
    await waitFor(() => expect(screen.getByLabelText("Playback position")).toHaveValue("42"));

    act(() => {
      emitMockNativePlaybackError({
        sessionId,
        message: "Native output failed.",
      });
    });

    await waitFor(() => expect(hasNativeIdleInhibition(false)).toBe(true));
    await waitFor(() => {
      expect(invokeCalls("system_media_clear_state").length).toBeGreaterThan(0);
    });

    const sourceAudio = await waitFor(() => findAudioByArtifactId("art_source"));
    markAudioReady(sourceAudio);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());
    await waitFor(() => expect(sourceAudio.currentTime).toBeCloseTo(42, 3));
    await waitForWebOwnerControls();
    const clearIndex = invokeCallIndexAfter(0, "system_media_clear_state");
    expect(clearIndex).toBeGreaterThan(-1);
    const webUpdateIndex = invokeCallIndexAfter(clearIndex, "system_media_update_state", (args) => {
      const payload = (args as { payload?: { playbackState?: string } } | undefined)?.payload;
      return payload?.playbackState === "playing";
    });
    expect(webUpdateIndex).toBeGreaterThan(clearIndex);
    restoreTauriRuntime();
  });

  it("pause releases the Web Audio wake lock without touching native idle inhibition", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);
    await waitForWebOwnerControls();

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await waitFor(() => expect(getMockWakeLock().sentinels[0]?.release).toHaveBeenCalled());
    expect(hasNativeIdleInhibition(true)).toBe(false);

    restoreTauriRuntime();
  });
});
