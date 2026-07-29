import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readPlaybackLiveDiagnostics } from "./lib/playbackDiagnostics";
import { readBrowserWakeLockStatus } from "./lib/powerInhibition";
import {
  deferNextMockSystemMediaControlListen,
  emitMockNativePlaybackError,
  emitMockNativePlaybackPosition,
  emitMockSystemMediaPlaybackControl,
  findAudioByArtifactId,
  getMockInvoke,
  mockEnsureWebMediaTransport,
  getMockMediaSession,
  getMockSystemMediaControlListenerCount,
  getMockWakeLock,
  markAudioReady,
  rejectMockSystemMediaCommand,
  renderApp,
  resetAppTestHarness,
  resolveDeferredMockSystemMediaControlListen,
  setMockNativeAudioState,
} from "./test/appTestHarness";

let usePlaybackPowerProtection: typeof import("./features/projects/playbackEffects").usePlaybackPowerProtection;
let useWebPlaybackWakeLock: typeof import("./features/projects/playbackEffects").useWebPlaybackWakeLock;
let useScreenWakeLock: typeof import("./lib/useScreenWakeLock").useScreenWakeLock;

beforeAll(async () => {
  ({ usePlaybackPowerProtection, useWebPlaybackWakeLock } = await import("./features/projects/playbackEffects"));
  ({ useScreenWakeLock } = await import("./lib/useScreenWakeLock"));
});

async function openPlaybackWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Playback" }));
}

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: getMockInvoke() },
  });

  return () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  };
}

function deferWebMediaTransport() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  mockEnsureWebMediaTransport.mockImplementationOnce(() => promise);
  return { reject, resolve };
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

function hasNativePowerProtection(active: boolean) {
  return invokeCalls("power_inhibition_set_activity").some(([, args]) => {
    const payload = args as { active?: boolean; reason?: string } | undefined;
    return payload?.reason === "playback" && payload.active === active;
  });
}

function nativePowerProtectionCallCount(active: boolean) {
  return invokeCalls("power_inhibition_set_activity").filter(([, args]) => {
    const payload = args as { active?: boolean; reason?: string } | undefined;
    return payload?.reason === "playback" && payload.active === active;
  }).length;
}

function expectNoSystemMediaCommandCalls() {
  expect(invokeCalls("system_media_update_state")).toHaveLength(0);
  expect(invokeCalls("system_media_clear_state")).toHaveLength(0);
  expect(invokeCalls("power_inhibition_set_activity")).toHaveLength(0);
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
  await waitFor(() => expect(getMockSystemMediaControlListenerCount()).toBeGreaterThan(0));
  await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledWith("screen"));
  await waitFor(() => expect(hasNativePowerProtection(true)).toBe(true));
}

async function waitForNativeControls() {
  await waitFor(() => expect(hasSystemMediaPlaybackState("playing")).toBe(true));
  await waitFor(() => expect(getMockSystemMediaControlListenerCount()).toBeGreaterThan(0));
  await waitFor(() => expect(hasNativePowerProtection(true)).toBe(true));
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
  await user.click(screen.getByRole("button", { name: "Play playback" }));
  let sourceAudio: HTMLAudioElement | null = null;
  await waitFor(() => {
    sourceAudio = findAudioByArtifactId("art_source");
  });
  markAudioReady(sourceAudio!);
  await waitFor(() => expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument());
  return restoreTauriRuntime;
}

function WebPlaybackWakeLockHarness({
  backend = "web",
  isPlaying,
}: {
  backend?: "native" | "web";
  isPlaying: boolean;
}) {
  useWebPlaybackWakeLock({ backend, isPlaying });
  return null;
}

function SharedWakeLockHarness({ playback, tuner }: { playback: boolean; tuner: boolean }) {
  useScreenWakeLock("playback", playback);
  useScreenWakeLock("tuner-capture", tuner);
  return null;
}

function deferWakeLockRequest() {
  const sentinel = {
    release: vi.fn(async () => undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  let resolve!: (value: typeof sentinel) => void;
  const request = () => new Promise<typeof sentinel>((resolveRequest) => { resolve = resolveRequest; });
  return { resolve: () => resolve(sentinel), request, sentinel };
}

function PlaybackPowerProtectionHarness({
  backend,
  isPlaying,
}: {
  backend: "native" | "web";
  isPlaying: boolean;
}) {
  usePlaybackPowerProtection(isPlaying);
  return <span data-testid="playback-power-backend">{backend}</span>;
}

describe("Desktop app project media controls", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("uses system controls with native power protection and supplemental browser wake lock when Web Audio is forced", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);

    await waitForWebOwnerControls();
    expect(getMockMediaSession().actionHandlers.size).toBe(0);
    expect(getMockMediaSession().setActionHandler).not.toHaveBeenCalled();
    expect(hasNativePowerProtection(true)).toBe(true);
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

  it("keeps native power protection stable when the active playback backend changes", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const view = render(<PlaybackPowerProtectionHarness backend="native" isPlaying />);
    await waitFor(() => expect(nativePowerProtectionCallCount(true)).toBe(1));
    const releaseCount = nativePowerProtectionCallCount(false);

    view.rerender(<PlaybackPowerProtectionHarness backend="web" isPlaying />);
    expect(screen.getByTestId("playback-power-backend")).toHaveTextContent("web");
    await act(async () => {
      await Promise.resolve();
    });

    expect(nativePowerProtectionCallCount(true)).toBe(1);
    expect(nativePowerProtectionCallCount(false)).toBe(releaseCount);
    view.unmount();
    await waitFor(() => {
      expect(nativePowerProtectionCallCount(false)).toBeGreaterThan(releaseCount);
    });
    restoreTauriRuntime();
  });

  it("uses native controls and power protection only after native playback starts", async () => {
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
    expect(mockEnsureWebMediaTransport).not.toHaveBeenCalled();

    act(() => {
      emitMockSystemMediaPlaybackControl({ action: "pause" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument());
    await waitFor(() => expect(hasNativePowerProtection(false)).toBe(true));

    restoreTauriRuntime();
  });

  it("keeps Web Audio sources disabled when lazy transport startup fails", async () => {
    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
    mockEnsureWebMediaTransport.mockRejectedValueOnce(
      new Error("Mobile media transport could not start."),
    );
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

    await waitFor(() => expect(mockEnsureWebMediaTransport).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(readPlaybackLiveDiagnostics()).toMatchObject({
        currentState: "error",
        currentPath: "none",
        statusMessage: "Playback stopped. Web Audio could not start.",
      });
    });
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("audio")).every(
        (element) => !element.hasAttribute("src"),
      ),
    ).toBe(true);

    restoreTauriRuntime();
  });

  it("waits for lazy transport before exposing native fallback media sources", async () => {
    const transport = deferWebMediaTransport();
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

    await waitFor(() => expect(mockEnsureWebMediaTransport).toHaveBeenCalledTimes(1));
    expect(
      Array.from(document.querySelectorAll("audio")).every(
        (element) => !element.hasAttribute("src"),
      ),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();

    await act(async () => transport.resolve());
    const sourceAudio = await waitFor(() => findAudioByArtifactId("art_source"));
    markAudioReady(sourceAudio);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument(),
    );

    restoreTauriRuntime();
  });

  it("ignores lazy transport success after playback is stopped", async () => {
    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
    const transport = deferWebMediaTransport();
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(mockEnsureWebMediaTransport).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await act(async () => transport.resolve());

    expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("audio")).every(
        (element) => !element.hasAttribute("src"),
      ),
    ).toBe(true);
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "not-playing",
      currentPath: "none",
    });

    restoreTauriRuntime();
  });

  it("ignores lazy transport rejection after a newer native owner starts", async () => {
    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
    const transport = deferWebMediaTransport();
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
    await waitFor(() => expect(mockEnsureWebMediaTransport).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    vi.unstubAllEnvs();
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();

    await act(async () => transport.reject(new Error("Stale Web transport failure.")));

    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("audio")).every(
        (element) => !element.hasAttribute("src"),
      ),
    ).toBe(true);
    expect(window.localStorage.getItem("tuneforge.playback-web-error")).toBeNull();
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "native",
    });

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
    expect(hasNativePowerProtection(true)).toBe(true);
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

    const releaseCount = nativePowerProtectionCallCount(false);
    act(() => {
      emitMockNativePlaybackError({
        sessionId,
        message: "Native output failed.",
      });
    });
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "starting",
      currentPath: "none",
      nativeSessionLaneCount: null,
      nativeBufferHealth: [],
    });

    await waitFor(() => {
      expect(nativePowerProtectionCallCount(false)).toBeGreaterThan(releaseCount);
    });
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

  it("blocks a failed paused native session and resumes through Web Audio on demand", async () => {
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

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument(),
    );
    act(() => {
      emitMockNativePlaybackError({
        sessionId,
        message: "Native output disconnected while paused.",
      });
    });

    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "error",
      currentPath: "none",
      nativeSessionLaneCount: null,
    });
    expect(window.localStorage.getItem("tuneforge.playback-native-error")).toBe(
      "Native output disconnected while paused.",
    );

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    const sourceAudio = await waitFor(() => findAudioByArtifactId("art_source"));
    markAudioReady(sourceAudio);
    await waitForWebOwnerControls();
    expect(readPlaybackLiveDiagnostics()).toMatchObject({
      currentState: "playing",
      currentPath: "web-fallback",
    });
    restoreTauriRuntime();
  });

  it("honors a pending pause when a native stream error races its response", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    const mockInvoke = getMockInvoke();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    const nativePauseBlock: { release: (() => void) | null } = { release: null };
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "audio_pause") {
        await new Promise<void>((resolve) => {
          nativePauseBlock.release = resolve;
        });
      }
      return defaultInvoke(command, args);
    });

    try {
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
      await user.click(screen.getByRole("button", { name: "Pause playback" }));
      await waitFor(() => expect(nativePauseBlock.release).not.toBeNull());
      act(() => {
        emitMockNativePlaybackError({
          sessionId,
          message: "Native output disconnected during pause.",
        });
      });

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument(),
      );
      expect(readPlaybackLiveDiagnostics()).toMatchObject({
        currentState: "error",
        currentPath: "none",
      });
      expect(document.querySelector("audio[src]")).toBeNull();

      nativePauseBlock.release?.();
      await Promise.resolve();
      expect(readPlaybackLiveDiagnostics()).toMatchObject({
        currentState: "error",
        currentPath: "none",
      });
      expect(screen.getByRole("button", { name: "Play playback" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Play playback" }));
      const sourceAudio = await waitFor(() => findAudioByArtifactId("art_source"));
      markAudioReady(sourceAudio);
      await waitForWebOwnerControls();
      expect(readPlaybackLiveDiagnostics()).toMatchObject({
        currentState: "playing",
        currentPath: "web-fallback",
      });
    } finally {
      nativePauseBlock.release?.();
      mockInvoke.mockImplementation(defaultInvoke);
      restoreTauriRuntime();
    }
  });

  it("handles a matching native stream error while play is still pending", async () => {
    const restoreTauriRuntime = mockTauriRuntime();
    const user = userEvent.setup();
    const mockInvoke = getMockInvoke();
    const defaultInvoke = mockInvoke.getMockImplementation();
    if (!defaultInvoke) {
      throw new Error("Mock invoke implementation was not installed.");
    }
    const nativePlayBlock: { release: (() => void) | null } = { release: null };
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "audio_play") {
        await new Promise<void>((resolve) => {
          nativePlayBlock.release = resolve;
        });
      }
      return defaultInvoke(command, args);
    });

    try {
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
      await waitFor(() => expect(nativePlayBlock.release).not.toBeNull());
      expect(hasNativePowerProtection(true)).toBe(false);

      const sessionId = latestNativeSessionId();
      act(() => {
        emitMockNativePlaybackError({
          sessionId,
          message: "Native output disconnected during start.",
        });
      });

      const sourceAudio = await waitFor(() => findAudioByArtifactId("art_source"));
      markAudioReady(sourceAudio);
      await waitForWebOwnerControls();
      expect(window.localStorage.getItem("tuneforge.playback-native-error")).toBe(
        "Native output disconnected during start.",
      );

      nativePlayBlock.release?.();
      await Promise.resolve();
      expect(readPlaybackLiveDiagnostics()).toMatchObject({
        currentState: "playing",
        currentPath: "web-fallback",
      });
    } finally {
      nativePlayBlock.release?.();
      mockInvoke.mockImplementation(defaultInvoke);
      restoreTauriRuntime();
    }
  });

  it("pause releases both native power protection and the supplemental Web Audio wake lock", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);
    await waitForWebOwnerControls();
    const releaseCount = nativePowerProtectionCallCount(false);

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await waitFor(() => expect(getMockWakeLock().sentinels[0]?.release).toHaveBeenCalled());
    await waitFor(() => {
      expect(nativePowerProtectionCallCount(false)).toBeGreaterThan(releaseCount);
    });

    restoreTauriRuntime();
  });

  it("reports Web Audio wake lock release failure after pause", async () => {
    const user = userEvent.setup();
    const restoreTauriRuntime = await startForcedWebPlayback(user);
    await waitForWebOwnerControls();
    getMockWakeLock().sentinels[0]?.release.mockRejectedValueOnce(new Error("release failed"));

    await user.click(screen.getByRole("button", { name: "Pause playback" }));

    await waitFor(() => {
      expect(readBrowserWakeLockStatus()).toMatchObject({
        phase: "release-failed",
        backend: "browser-screen-wake-lock",
        screenProtected: true,
      });
    });
    restoreTauriRuntime();
  });

  it("ignores stale Web Audio release failure after a new owner starts", async () => {
    const view = render(<WebPlaybackWakeLockHarness isPlaying />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(1));
    let rejectRelease: (reason?: unknown) => void = () => undefined;
    getMockWakeLock().sentinels[0]!.release.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        rejectRelease = reject;
      }),
    );

    view.rerender(<WebPlaybackWakeLockHarness isPlaying={false} />);
    view.rerender(<WebPlaybackWakeLockHarness isPlaying />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(2));
    await act(async () => {
      rejectRelease(new Error("stale release failed"));
      await Promise.resolve();
    });

    expect(readBrowserWakeLockStatus()).toMatchObject({
      phase: "active",
      backend: "browser-screen-wake-lock",
      screenProtected: true,
    });
    view.unmount();
  });

  it("coalesces pending browser Wake Lock requests and releases a late sentinel", async () => {
    const pendingSentinel = {
      released: false,
      release: vi.fn(async () => {
        pendingSentinel.released = true;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchRelease: vi.fn(),
    };
    let resolveRequest: (sentinel: typeof pendingSentinel) => void = () => undefined;
    getMockWakeLock().request.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const view = render(<WebPlaybackWakeLockHarness isPlaying />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(1));

    fireEvent(document, new Event("visibilitychange"));
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.focus(window);
    expect(getMockWakeLock().request).toHaveBeenCalledTimes(1);

    view.rerender(<WebPlaybackWakeLockHarness backend="native" isPlaying />);
    await act(async () => {
      resolveRequest(pendingSentinel);
      await Promise.resolve();
    });

    expect(pendingSentinel.release).toHaveBeenCalledTimes(1);
    expect(getMockWakeLock().request).toHaveBeenCalledTimes(1);
    expect(readBrowserWakeLockStatus()).toMatchObject({
      phase: "inactive",
      backend: null,
      screenProtected: false,
    });
    view.unmount();
  });

  it("reports a late browser Wake Lock release failure after the final owner exits", async () => {
    let rejectRelease: (reason?: unknown) => void = () => undefined;
    const pendingSentinel = {
      release: vi.fn(
        () => new Promise<void>((_resolve, reject) => {
          rejectRelease = reject;
        }),
      ),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    let resolveRequest: (sentinel: typeof pendingSentinel) => void = () => undefined;
    getMockWakeLock().request.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const view = render(<WebPlaybackWakeLockHarness isPlaying />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(1));

    view.rerender(<WebPlaybackWakeLockHarness backend="native" isPlaying />);
    await act(async () => {
      resolveRequest(pendingSentinel);
      await Promise.resolve();
    });
    expect(readBrowserWakeLockStatus()).toMatchObject({
      phase: "releasing",
      backend: "browser-screen-wake-lock",
      screenProtected: true,
    });

    await act(async () => {
      rejectRelease(new Error("late release failed"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(readBrowserWakeLockStatus()).toMatchObject({
        phase: "release-failed",
        backend: "browser-screen-wake-lock",
        screenProtected: true,
      });
    });
    view.unmount();
  });

  it("keeps one browser Wake Lock while playback and tuner owners overlap", async () => {
    const view = render(<SharedWakeLockHarness playback tuner />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(1));

    view.rerender(<SharedWakeLockHarness playback={false} tuner />);
    expect(getMockWakeLock().sentinels[0]?.release).not.toHaveBeenCalled();
    expect(readBrowserWakeLockStatus()).toMatchObject({
      phase: "active",
      screenProtected: true,
    });

    view.rerender(<SharedWakeLockHarness playback={false} tuner={false} />);
    await waitFor(() => expect(getMockWakeLock().sentinels[0]?.release).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readBrowserWakeLockStatus().phase).toBe("inactive"));
    view.unmount();
  });

  it("keeps a fresh tuner Wake Lock request isolated from a reset owner", async () => {
    const priorRequest = deferWakeLockRequest();
    getMockWakeLock().request.mockImplementationOnce(priorRequest.request);
    const priorView = render(<SharedWakeLockHarness playback tuner={false} />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(1));

    resetAppTestHarness();

    const freshRequest = deferWakeLockRequest();
    getMockWakeLock().request.mockImplementationOnce(freshRequest.request);
    const freshView = render(<SharedWakeLockHarness playback={false} tuner />);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledTimes(1));

    await act(async () => {
      priorRequest.resolve();
      await Promise.resolve();
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(getMockWakeLock().request).toHaveBeenCalledTimes(1);

    await act(async () => {
      freshRequest.resolve();
      await Promise.resolve();
    });
    expect(readBrowserWakeLockStatus().phase).toBe("active");

    freshView.unmount();
    await waitFor(() => expect(freshRequest.sentinel.release).toHaveBeenCalledTimes(1));
    priorView.unmount();
  });

  it("releases native power protection on stop, natural end, and unmount", async () => {
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
    const view = renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await openPlaybackWorkspace(user);
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();

    let releaseCount = nativePowerProtectionCallCount(false);
    await user.click(screen.getByRole("button", { name: "Stop playback" }));
    await waitFor(() => {
      expect(nativePowerProtectionCallCount(false)).toBeGreaterThan(releaseCount);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();
    releaseCount = nativePowerProtectionCallCount(false);
    const sessionId = latestNativeSessionId();
    act(() => {
      emitMockNativePlaybackPosition({
        sessionId,
        positionSeconds: 182,
        durationSeconds: 182,
        state: "stopped",
      });
    });
    await waitFor(() => {
      expect(nativePowerProtectionCallCount(false)).toBeGreaterThan(releaseCount);
    });

    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitForNativeControls();
    releaseCount = nativePowerProtectionCallCount(false);
    view.unmount();
    await waitFor(() => {
      expect(nativePowerProtectionCallCount(false)).toBeGreaterThan(releaseCount);
    });
    restoreTauriRuntime();
  });

  it("records supplemental browser Wake Lock acquisition failures while retaining native protection", async () => {
    const user = userEvent.setup();
    getMockWakeLock().request.mockRejectedValueOnce(new Error("denied"));
    const restoreTauriRuntime = await startForcedWebPlayback(user);

    await waitFor(() => {
      expect(readBrowserWakeLockStatus()).toMatchObject({
        phase: "failed",
        screenProtected: false,
      });
    });
    expect(hasNativePowerProtection(true)).toBe(true);
    expect(screen.queryByText("Screen Wake Lock could not be enabled.")).not.toBeInTheDocument();

    restoreTauriRuntime();
  });

  it("ignores a pending browser Wake Lock rejection after playback pauses", async () => {
    const user = userEvent.setup();
    let rejectRequest: (reason?: unknown) => void = () => undefined;
    getMockWakeLock().request.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    const restoreTauriRuntime = await startForcedWebPlayback(user);
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledWith("screen"));

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await waitFor(() => expect(readBrowserWakeLockStatus().phase).toBe("inactive"));
    await act(async () => {
      rejectRequest(new Error("late denial"));
      await Promise.resolve();
    });

    expect(readBrowserWakeLockStatus().phase).toBe("inactive");
    expect(screen.queryByText("Screen Wake Lock could not be enabled.")).not.toBeInTheDocument();
    restoreTauriRuntime();
  });
});
