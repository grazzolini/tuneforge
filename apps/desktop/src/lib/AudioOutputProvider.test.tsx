import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioOutputProvider } from "./AudioOutputProvider";
import { useAudioOutput, type AudioOutputContextValue } from "./audioOutputContext";
import * as browserAudio from "./audioOutput";
import { PreferencesProvider } from "./preferences";

const { mockSetNativeAppOutput, mockSetNativeCueOutputs, mockSetNativeOutputDevice,
  mockGetNativeCapabilities, mockGetNativeOutputRoute, mockListNativeOutputDevices, mockForcedWebAudio } = vi.hoisted(() => ({
  mockSetNativeAppOutput: vi.fn(),
  mockSetNativeCueOutputs: vi.fn(),
  mockSetNativeOutputDevice: vi.fn(),
  mockGetNativeCapabilities: vi.fn(),
  mockGetNativeOutputRoute: vi.fn(),
  mockListNativeOutputDevices: vi.fn(),
  mockForcedWebAudio: vi.fn(),
}));

vi.mock("./nativeAudio", () => ({
  getNativeAudioCapabilities: mockGetNativeCapabilities,
  getNativeOutputRoute: mockGetNativeOutputRoute,
  isWebAudioBackendForced: mockForcedWebAudio,
  isAndroidRuntime: () => false,
  listNativeAudioOutputDevices: mockListNativeOutputDevices,
  listenNativeOutputRoute: () => Promise.resolve(() => undefined),
  setNativeOutputDevice: mockSetNativeOutputDevice,
  setNativeAppOutput: mockSetNativeAppOutput,
  setNativeCueOutputs: mockSetNativeCueOutputs,
}));

let currentOutput: AudioOutputContextValue | null = null;

function savedRouteStorage() {
  const entries = { ...window.localStorage };
  delete entries["tuneforge.browser-output-inventory"];
  Reflect.deleteProperty(entries, "length");
  return entries;
}

function Probe() {
  currentOutput = useAudioOutput();
  return <span>{currentOutput.outputSaveError ?? "ready"}</span>;
}

describe("AudioOutputProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    currentOutput = null;
    mockSetNativeAppOutput.mockReset().mockResolvedValue({});
    mockForcedWebAudio.mockReset().mockReturnValue(false);
    mockSetNativeCueOutputs.mockReset().mockResolvedValue({});
    mockSetNativeOutputDevice.mockReset().mockResolvedValue({ outputRoute: {
      preferredDeviceId: null, activeDeviceId: null, status: "system-default",
      fallbackLatched: false, generation: 0,
    } });
    mockGetNativeCapabilities.mockReset().mockResolvedValue({
      platform: "macos", nativePlaybackSupported: true, outputSelectionPersistence: "persistent",
    });
    mockGetNativeOutputRoute.mockReset().mockResolvedValue({
      preferredDeviceId: null, activeDeviceId: null, status: "system-default",
      fallbackLatched: false, generation: 0,
    });
    mockListNativeOutputDevices.mockReset().mockResolvedValue({ supported: true, devices: [], error: null });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("recovers readiness after an initial native failure and keeps the latest rapid config", async () => {
    mockSetNativeAppOutput
      .mockRejectedValueOnce(new Error("device unavailable"))
      .mockResolvedValue({});
    render(
      <PreferencesProvider>
        <AudioOutputProvider>
          <Probe />
        </AudioOutputProvider>
      </PreferencesProvider>,
    );

    await screen.findByText("App volume could not be applied. Change the volume to try again.");
    if (!currentOutput) throw new Error("Expected audio output context.");

    act(() => {
      currentOutput?.setAppOutputGain(0.4);
      currentOutput?.setAppOutputMuted(true);
    });
    await act(async () => {
      await currentOutput?.ensureAppOutputReady();
    });

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(mockSetNativeAppOutput).toHaveBeenLastCalledWith({ gain: 0.4, muted: true });
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ appOutputGain: 0.4, appOutputMuted: true });
  });

  it("requests browser output permission in the selection gesture and stores its own ID", async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const sinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
    const selectAudioOutput = vi.fn(async () => ({ deviceId: "browser-granted" } as MediaDeviceInfo));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), selectAudioOutput,
    } });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true, value: vi.fn(async () => undefined),
    });
    try {
      render(<PreferencesProvider><AudioOutputProvider><Probe /></AudioOutputProvider></PreferencesProvider>);
      if (!currentOutput) throw new Error("Expected audio output context.");
      let selection!: Promise<void>;
      act(() => { selection = currentOutput!.selectBrowserOutputDevice("requested"); });
      expect(selectAudioOutput).toHaveBeenCalledWith({ deviceId: "requested" });
      await act(async () => selection);
      expect(currentOutput!.browserOutputDeviceId).toBe("browser-granted");
      expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBe("browser-granted");
      expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}")
        .defaultOutputDeviceId ?? null).toBeNull();
    } finally {
      if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      if (sinkId) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", sinkId);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    }
  });

  it("rejects non-finite changes without mutating configured gain or mute", async () => {
    mockSetNativeAppOutput.mockResolvedValue({});
    render(
      <PreferencesProvider>
        <AudioOutputProvider>
          <Probe />
        </AudioOutputProvider>
      </PreferencesProvider>,
    );
    await waitFor(() => expect(mockSetNativeAppOutput).toHaveBeenCalledTimes(1));
    if (!currentOutput) throw new Error("Expected audio output context.");

    act(() => {
      currentOutput?.setAppOutputGain(Number.NaN);
      currentOutput?.setAppOutputGain(Number.POSITIVE_INFINITY);
    });

    expect(mockSetNativeAppOutput).toHaveBeenCalledTimes(1);
    expect(currentOutput.appOutputGain).toBe(1);
    expect(currentOutput.appOutputMuted).toBe(false);
  });

  it("keeps the new audible level when persistence fails and surfaces the save error", async () => {
    mockSetNativeAppOutput.mockResolvedValue({});
    render(
      <PreferencesProvider>
        <AudioOutputProvider>
          <Probe />
        </AudioOutputProvider>
      </PreferencesProvider>,
    );
    await waitFor(() => expect(mockSetNativeAppOutput).toHaveBeenCalledTimes(1));
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    if (!currentOutput) throw new Error("Expected audio output context.");

    act(() => currentOutput?.setAppOutputGain(0.25));

    await screen.findByText("Audio settings changed, but could not be saved for the next launch.");
    expect(mockSetNativeAppOutput).toHaveBeenLastCalledWith({ gain: 0.25, muted: false });
    expect(currentOutput.appOutputGain).toBe(0.25);
  });

  it("serializes paired cue gains and preserves the latest full configuration", async () => {
    mockSetNativeAppOutput.mockResolvedValue({});
    mockSetNativeCueOutputs.mockResolvedValue({});
    render(
      <PreferencesProvider>
        <AudioOutputProvider><Probe /></AudioOutputProvider>
      </PreferencesProvider>,
    );
    await waitFor(() => expect(mockSetNativeCueOutputs).toHaveBeenCalledWith({
      countInGain: 1,
      countInMuted: false,
      metronomeGain: 0.8,
      metronomeMuted: false,
    }));
    if (!currentOutput) throw new Error("Expected audio output context.");

    act(() => {
      currentOutput?.setCountInOutputGain(0.35);
      currentOutput?.setCountInOutputMuted(true);
      currentOutput?.setCountInOutputGain(0.45);
      currentOutput?.setMetronomeOutputGain(0.55);
      currentOutput?.setMetronomeOutputMuted(true);
      currentOutput?.setMetronomeOutputGain(0.65);
    });
    await act(async () => currentOutput?.ensureAppOutputReady());

    expect(mockSetNativeCueOutputs).toHaveBeenLastCalledWith({
      countInGain: 0.45,
      countInMuted: true,
      metronomeGain: 0.65,
      metronomeMuted: true,
    });
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({
        countInOutputGain: 0.45,
        countInOutputMuted: true,
        metronomeOutputGain: 0.65,
        metronomeOutputMuted: true,
      });

    act(() => {
      currentOutput?.setCountInOutputMuted(false);
      currentOutput?.setMetronomeOutputMuted(false);
    });
    await act(async () => currentOutput?.ensureAppOutputReady());
    expect(mockSetNativeCueOutputs).toHaveBeenLastCalledWith({
      countInGain: 0.45,
      countInMuted: false,
      metronomeGain: 0.65,
      metronomeMuted: false,
    });
  });

  it("hydrates an exact desktop output ID before playback readiness", async () => {
    const selected = "pipewire:alsa_output.usb:é ";
    window.localStorage.setItem("tuneforge.ui-preferences", JSON.stringify({
      defaultOutputDeviceId: selected,
    }));
    mockSetNativeAppOutput.mockResolvedValue({});
    render(<PreferencesProvider><AudioOutputProvider><Probe /></AudioOutputProvider></PreferencesProvider>);

    await waitFor(() => expect(mockSetNativeOutputDevice).toHaveBeenCalledWith(selected, false));
    await act(async () => currentOutput?.ensureAppOutputReady());
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ defaultOutputDeviceId: selected });
  });

  it("keeps the newest native inventory and does not retry a latched output on refresh", async () => {
    const saved = "coreaudio:headphones";
    const fallback = {
      preferredDeviceId: saved, activeDeviceId: "coreaudio:speakers",
      status: "fallback-default", fallbackLatched: true, generation: 4,
    };
    window.localStorage.setItem("tuneforge.ui-preferences", JSON.stringify({
      defaultOutputDeviceId: saved,
    }));
    mockGetNativeOutputRoute.mockResolvedValue(fallback);
    mockSetNativeOutputDevice.mockResolvedValue({ outputRoute: fallback });
    let resolveInitial!: (value: unknown) => void;
    let resolveRefresh!: (value: unknown) => void;
    mockListNativeOutputDevices
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

    render(<PreferencesProvider><AudioOutputProvider><Probe /></AudioOutputProvider></PreferencesProvider>);
    await waitFor(() => expect(mockListNativeOutputDevices).toHaveBeenCalledTimes(1));
    if (!currentOutput) throw new Error("Expected audio output context.");
    act(() => { void currentOutput?.refreshOutputDevices?.(); });
    await waitFor(() => expect(mockListNativeOutputDevices).toHaveBeenCalledTimes(2));
    await act(async () => resolveRefresh({ supported: true, devices: [
      { id: saved, label: "Headphones", isDefault: false },
    ], error: null }));
    expect(currentOutput?.outputDevices?.devices.map((device) => device.id)).toEqual([saved]);
    const routeCalls = mockSetNativeOutputDevice.mock.calls.length;

    await act(async () => resolveInitial({ supported: true, devices: [], error: null }));
    expect(currentOutput?.outputDevices?.devices.map((device) => device.id)).toEqual([saved]);
    expect(currentOutput?.outputRoute).toMatchObject(fallback);
    expect(mockSetNativeOutputDevice).toHaveBeenCalledTimes(routeCalls);
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ defaultOutputDeviceId: saved });
  });

  it("keeps Android output selection in native process state across WebView remount", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android test WebView");
    const selected = "aaudio:42";
    window.localStorage.setItem("tuneforge.ui-preferences", JSON.stringify({
      defaultOutputDeviceId: selected,
    }));
    mockGetNativeCapabilities.mockResolvedValue({
      platform: "android", nativePlaybackSupported: true,
      outputSelectionPersistence: "session-only", outputRouteVerification: "requested-unverified",
    });
    mockGetNativeOutputRoute.mockResolvedValue({
      preferredDeviceId: selected, activeDeviceId: selected,
      status: "requested-unverified", fallbackLatched: false, generation: 2,
    });
    mockSetNativeAppOutput.mockResolvedValue({});

    const view = render(<PreferencesProvider><AudioOutputProvider><Probe /></AudioOutputProvider></PreferencesProvider>);
    await waitFor(() => expect(currentOutput?.outputRoute?.preferredDeviceId).toBe(selected));
    expect(mockSetNativeOutputDevice).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("tuneforge.ui-preferences") ?? "{}"))
      .toMatchObject({ defaultOutputDeviceId: null });

    view.unmount();
    currentOutput = null;
    render(<PreferencesProvider><AudioOutputProvider><Probe /></AudioOutputProvider></PreferencesProvider>);
    await waitFor(() => expect(currentOutput?.outputRoute?.preferredDeviceId).toBe(selected));
    expect(mockSetNativeOutputDevice).not.toHaveBeenCalled();
  });
});


describe("browser output discovery", () => {
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const sinkDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
  const device = (deviceId: string): MediaDeviceInfo => ({
    deviceId, label: deviceId, groupId: "synthetic", kind: "audiooutput", toJSON: () => ({}),
  });
  const mount = () => render(
    <PreferencesProvider><AudioOutputProvider><Probe /></AudioOutputProvider></PreferencesProvider>,
  );
  function install(devices: object, native = false) {
    if (!native) delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    else Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true, value: vi.fn(async () => undefined),
    });
  }
  beforeEach(() => {
    window.localStorage.clear();
    currentOutput = null;
    mockForcedWebAudio.mockReset().mockReturnValue(false);
    mockSetNativeAppOutput.mockReset().mockResolvedValue({});
    mockSetNativeCueOutputs.mockReset().mockResolvedValue({});
    mockGetNativeCapabilities.mockReset().mockResolvedValue({ outputSelectionPersistence: "default-only" });
    mockGetNativeOutputRoute.mockReset().mockResolvedValue({});
    mockListNativeOutputDevices.mockReset().mockResolvedValue({ supported: true, devices: [] });
  });
  afterEach(() => {
    if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    if (sinkDescriptor) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", sinkDescriptor);
    else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("keeps remembered names unverified across reload and uses fresh labels without automatic repeat prompts", async () => {
    window.localStorage.setItem("tuneforge.browser-output-inventory", JSON.stringify([{ deviceId: "old", label: "Studio" }]));
    let visible: MediaDeviceInfo[] = [];
    const chooser = vi.fn().mockRejectedValueOnce(new DOMException("synthetic", "AbortError"))
      .mockResolvedValue(device("rotated"));
    install({ enumerateDevices: vi.fn(async () => visible), selectAudioOutput: chooser });
    const view = mount();
    await waitFor(() => expect(currentOutput?.browserOutputChoices).toEqual([
      { deviceId: "old", label: "Studio", remembered: true },
    ]));
    expect(chooser).not.toHaveBeenCalled();
    await act(async () => {
      currentOutput!.activateBrowserOutputSelector();
      currentOutput!.activateBrowserOutputSelector();
    });
    expect(chooser).toHaveBeenCalledTimes(1);
    await act(async () => currentOutput!.activateBrowserOutputSelector());
    expect(chooser).toHaveBeenCalledTimes(1);
    await act(async () => { await currentOutput!.authorizeBrowserOutputDevice("old"); });
    expect(currentOutput?.browserOutputDiscoveryError).toBeNull();
    expect(currentOutput?.browserOutputDiscoveryHelp).toBe("");
    expect(currentOutput?.browserOutputDeviceId).toBeNull();
    expect(currentOutput?.browserOutputChoices).toContainEqual({ deviceId: "rotated", label: "rotated", remembered: true });
    view.unmount();
    visible = [{ ...device("old"), label: "Fresh name" }];
    mount();
    await waitFor(() => expect(currentOutput?.browserOutputChoices).toContainEqual(
      { deviceId: "old", label: "Fresh name", remembered: false },
    ));
    await act(async () => currentOutput!.activateBrowserOutputSelector());
    expect(chooser).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem("tuneforge.browser-output-inventory")!))
      .toContainEqual({ deviceId: "old", label: "Fresh name" });
  });

  it("keeps the latest global choice when a remembered selection grants a rotated ID late", async () => {
    let grant!: (value: MediaDeviceInfo) => void;
    const chooser = vi.fn(() => new Promise<MediaDeviceInfo>((resolve) => { grant = resolve; }));
    install({ enumerateDevices: vi.fn(async () => []), selectAudioOutput: chooser });
    mount();
    let selecting!: Promise<void>;
    act(() => { selecting = currentOutput!.selectBrowserOutputDevice("remembered"); });
    expect(chooser).toHaveBeenCalledWith({ deviceId: "remembered" });
    await act(async () => currentOutput!.selectBrowserOutputDevice(null));
    await act(async () => { grant(device("rotated")); await selecting; });
    expect(currentOutput?.browserOutputDeviceId).toBeNull();
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBeNull();
    expect(currentOutput?.browserOutputChoices).toContainEqual({ deviceId: "rotated", label: "rotated", remembered: true });
  });

  it("keeps session output changes and save errors through passive refresh until a later successful save", async () => {
    install({ enumerateDevices: vi.fn(async () => []), selectAudioOutput: vi.fn(async () => device("usb")) });
    mount();
    await act(async () => currentOutput!.selectBrowserOutputDevice("usb"));
    const remove = vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => currentOutput!.selectBrowserOutputDevice(null));
    expect(currentOutput?.browserOutputDeviceId).toBeNull();
    expect(currentOutput?.outputSaveError).toMatch(/could not be saved.*session/);
    await act(async () => currentOutput!.refreshOutputDevices!());
    expect(currentOutput?.outputSaveError).toMatch(/could not be saved/);
    remove.mockRestore();
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => currentOutput!.selectBrowserOutputDevice("usb"));
    expect(currentOutput?.browserOutputDeviceId).toBe("usb");
    expect(currentOutput?.outputSaveError).toMatch(/could not be saved/);
    write.mockRestore();
    await act(async () => currentOutput!.selectBrowserOutputDevice("usb"));
    expect(currentOutput?.outputSaveError).toBeNull();
  });

  it("updates inherited global routes without retrying an explicit route's latched fallback", async () => {
    const routing = { project: { kind: "inherit" as const }, cue: { kind: "inherit" as const },
      stems: { bass: { kind: "explicit-device" as const, deviceId: "lost" } } };
    function RoutingProbe() {
      const output = useAudioOutput();
      useEffect(() => { browserAudio.setBrowserOutputRouting({ projectId: "global-inheritance",
        globalDeviceId: output.browserOutputDeviceId, routing, lanes: [{ laneId: "bass", stableKey: "bass" }] });
      }, [output.browserOutputDeviceId]);
      return <Probe />;
    }
    install({ enumerateDevices: vi.fn(async () => []), selectAudioOutput: vi.fn(async () => device("usb")) });
    render(<PreferencesProvider><AudioOutputProvider><RoutingProbe /></AudioOutputProvider></PreferencesProvider>);
    const bass = document.createElement("audio");
    browserAudio.registerProjectMediaElement(bass, 1, "bass");
    try {
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().lanes[0].status).toBe("selected"));
      act(() => browserAudio.markBrowserOutputDisconnected("lost"));
      const before = browserAudio.browserOutputRoutingSnapshot().lanes[0];
      expect(before.status).toBe("fallback-default");
      await act(async () => currentOutput!.selectBrowserOutputDevice("usb"));
      const after = browserAudio.browserOutputRoutingSnapshot();
      expect(after.project.preferredDeviceId).toBe("usb");
      expect(after.cue.preferredDeviceId).toBe("usb");
      expect(after.lanes[0]).toEqual(before);
      await act(async () => currentOutput!.selectBrowserOutputDevice(null));
      expect(browserAudio.browserOutputRoutingSnapshot().project.preferredDeviceId).toBeNull();
      expect(browserAudio.browserOutputRoutingSnapshot().lanes[0]).toEqual(before);
    } finally { browserAudio.unregisterProjectMediaElement(bass); }
  });

  it("retries the same Settings output only along inheriting routes after successful authorization", async () => {
    window.localStorage.setItem("tuneforge.browser-output-device", "usb");
    const chooser = vi.fn().mockRejectedValueOnce(new DOMException("synthetic", "NotAllowedError"))
      .mockResolvedValue(device("usb"));
    install({ enumerateDevices: vi.fn(async () => []), selectAudioOutput: chooser });
    const routing = { project: { kind: "inherit" as const }, cue: { kind: "inherit" as const }, stems: {
      same: { kind: "explicit-device" as const, deviceId: "usb" },
      other: { kind: "explicit-device" as const, deviceId: "lost" },
      parent: { kind: "explicit-device" as const, deviceId: "usb" },
    } };
    const lanes = ["inherited", "same", "other", "parent", "child"].map((laneId) => ({
      laneId, stableKey: laneId, ...(laneId === "child" ? { parentStableKey: "parent" } : {}),
    }));
    function RoutingProbe() {
      const output = useAudioOutput();
      useEffect(() => { browserAudio.setBrowserOutputRouting({ projectId: "same-global-retry",
        globalDeviceId: output.browserOutputDeviceId, routing, lanes });
      }, [output.browserOutputDeviceId]);
      return <Probe />;
    }
    render(<PreferencesProvider><AudioOutputProvider><RoutingProbe /></AudioOutputProvider></PreferencesProvider>);
    const context = new AudioContext();
    Object.defineProperty(context, "createMediaStreamDestination", { configurable: true,
      value: vi.fn(() => ({ stream: { getTracks: () => [] } })) });
    browserAudio.getProjectAudioOutputNode(context);
    browserAudio.getCountInAudioOutputNode(context);
    lanes.forEach((lane) => browserAudio.getProjectAudioOutputNode(context, lane.laneId));
    try {
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("selected"));
      act(() => { browserAudio.markBrowserOutputDisconnected("usb"); browserAudio.markBrowserOutputDisconnected("lost"); });
      const before = browserAudio.browserOutputRoutingSnapshot();
      expect(before.lanes.every((lane) => lane.fallbackLatched)).toBe(true);
      await act(async () => currentOutput!.selectBrowserOutputDevice("usb"));
      expect(browserAudio.browserOutputRoutingSnapshot().project).toEqual(before.project);
      expect(browserAudio.browserOutputRoutingSnapshot().lanes).toEqual(before.lanes);
      await act(async () => currentOutput!.selectBrowserOutputDevice("usb"));
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("selected"));
      const after = browserAudio.browserOutputRoutingSnapshot();
      expect(after.cue.status).toBe("selected");
      expect(after.lanes[0].status).toBe("selected");
      expect(after.lanes.slice(1)).toEqual(before.lanes.slice(1));
      expect(currentOutput?.browserOutputDeviceId).toBe("usb");
    } finally { browserAudio.releaseBrowserOutputContext(context); }
  });

  it("retries an unchanged remembered inventory after storage becomes writable", async () => {
    install({ enumerateDevices: vi.fn(async () => [device("usb")]) });
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "tuneforge.browser-output-inventory") throw new Error("blocked");
      setItem(key, value);
    });
    mount();
    await waitFor(() => expect(currentOutput?.outputSaveError).toMatch(/Output names could not be saved/));
    expect(currentOutput?.browserOutputChoices).toContainEqual({ deviceId: "usb", label: "usb", remembered: false });
    write.mockRestore();
    const recovered = vi.spyOn(window.localStorage, "setItem");
    await act(async () => currentOutput!.refreshOutputDevices!());
    expect(currentOutput?.outputSaveError).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("tuneforge.browser-output-inventory")!))
      .toEqual([{ deviceId: "usb", label: "usb" }]);
    await act(async () => currentOutput!.refreshOutputDevices!());
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("enumerates without a mount prompt and discovers synchronously without changing routes or settings", async () => {
    let grant!: (value: MediaDeviceInfo) => void;
    let granted = false;
    const chooser = vi.fn(() => new Promise<MediaDeviceInfo>((resolve) => { grant = resolve; }));
    const microphone = vi.fn();
    const enumerate = vi.fn(async () => granted ? [device("new-speaker")] : [device("saved-speaker")]);
    install({ enumerateDevices: enumerate, selectAudioOutput: chooser, getUserMedia: microphone,
      addEventListener: vi.fn(), removeEventListener: vi.fn() });
    window.localStorage.setItem("tuneforge.browser-output-device", "saved-speaker");
    mount();
    await waitFor(() => expect(currentOutput?.browserOutputDevices).toHaveLength(1));
    expect(chooser).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const storage = savedRouteStorage();
    const retry = vi.spyOn(browserAudio, "retryBrowserOutputRouting");
    const disconnect = vi.spyOn(browserAudio, "markBrowserOutputDisconnected");
    let discovery!: Promise<void>;
    act(() => {
      discovery = currentOutput!.discoverBrowserOutputs();
      void currentOutput!.discoverBrowserOutputs();
    });
    expect(chooser).toHaveBeenCalledExactlyOnceWith();
    expect(currentOutput?.browserOutputDiscoveryPending).toBe(true);
    granted = true;
    await act(async () => { grant(device("new-speaker")); await discovery; });
    expect(currentOutput?.browserOutputDevices.map((entry) => entry.deviceId)).toEqual(["new-speaker"]);
    expect(currentOutput?.browserOutputDeviceId).toBe("saved-speaker");
    expect(savedRouteStorage()).toEqual(storage);
    expect(retry).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(currentOutput?.browserOutputDiscoveryResult).toBeNull();
    expect(currentOutput?.browserOutputDiscoveryHelp).toBe("");
    expect(currentOutput?.browserOutputDiscoveryPending).toBe(false);
  });

  it("uses microphone fallback only on request and stops all tracks before refreshing", async () => {
    const stops = [vi.fn(), vi.fn()];
    let granted = false;
    const enumerate = vi.fn(async () => {
      if (granted) stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
      return granted ? [device("speakers")] : [device("default")];
    });
    const microphone = vi.fn(async () => {
      granted = true;
      return { getTracks: () => stops.map((stop) => ({ stop })) } as unknown as MediaStream;
    });
    install({ enumerateDevices: enumerate, getUserMedia: microphone });
    mount();
    await waitFor(() => expect(enumerate).toHaveBeenCalledTimes(1));
    expect(microphone).not.toHaveBeenCalled();
    expect(currentOutput?.browserOutputDiscoveryMethod).toBe("microphone");
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(microphone).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
    expect(currentOutput?.browserOutputDevices.map((entry) => entry.deviceId)).toEqual(["speakers"]);
  });

  it("stops every late microphone track after unmount without enumerating", async () => {
    let grant!: (value: MediaStream) => void;
    const stops = [vi.fn(), vi.fn()];
    const enumerate = vi.fn(async () => []);
    install({ enumerateDevices: enumerate, getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve; })) });
    const view = mount();
    await waitFor(() => expect(enumerate).toHaveBeenCalledTimes(1));
    let discovery!: Promise<void>;
    act(() => { discovery = currentOutput!.discoverBrowserOutputs(); });
    view.unmount();
    await act(async () => {
      grant({ getTracks: () => stops.map((stop) => ({ stop })) } as unknown as MediaStream);
      await discovery;
    });
    stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
    expect(enumerate).toHaveBeenCalledTimes(1);
  });

  it.each(["NotAllowedError", "AbortError", "NotFoundError"])("keeps defaults after %s and retries without microphone fallback", async (name) => {
    const chooser = vi.fn().mockRejectedValueOnce(new DOMException("synthetic", name))
      .mockResolvedValue(device("granted"));
    const microphone = vi.fn();
    install({ enumerateDevices: vi.fn(async () => []), selectAudioOutput: chooser, getUserMedia: microphone });
    mount();
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryError).toContain(name === "NotFoundError"
      ? "No audio output is available" : "wasn’t granted");
    expect(currentOutput?.browserOutputDiscoveryPending).toBe(false);
    expect(currentOutput?.browserOutputDeviceId).toBeNull();
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryError).toBeNull();
    expect(currentOutput?.browserOutputDiscoveryResult).toBeNull();
    expect(currentOutput?.browserOutputDiscoveryError).toBeNull();
    expect(microphone).not.toHaveBeenCalled();
  });

  it("reports no microphone and permits a later retry", async () => {
    const microphone = vi.fn().mockRejectedValueOnce(new DOMException("synthetic", "NotFoundError"))
      .mockResolvedValue({ getTracks: () => [] });
    install({ enumerateDevices: vi.fn(async () => []), getUserMedia: microphone });
    mount();
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryError).toContain("No microphone is available");
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryError).toBeNull();
  });

  it("reports grant refresh failure and clears inventory errors on retry", async () => {
    const enumerate = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("synthetic"))
      .mockResolvedValue([device("granted")]);
    install({ enumerateDevices: enumerate, selectAudioOutput: vi.fn(async () => device("granted")) });
    mount();
    await waitFor(() => expect(enumerate).toHaveBeenCalledTimes(1));
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryError).toContain("Could not refresh outputs");
    expect(currentOutput?.outputSaveError).toBe("Browser output inventory is unavailable.");
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryError).toBeNull();
    expect(currentOutput?.outputSaveError).toBeNull();
  });

  it("ignores pre-grant stale enumeration after refreshing the granted inventory", async () => {
    let resolveInitial!: (value: MediaDeviceInfo[]) => void;
    const enumerate = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValue([device("granted")]);
    install({ enumerateDevices: enumerate, selectAudioOutput: vi.fn(async () => device("granted")) });
    mount();
    await act(async () => currentOutput!.discoverBrowserOutputs());
    await act(async () => resolveInitial([device("old")]));
    expect(currentOutput?.browserOutputDevices.map((entry) => entry.deviceId)).toEqual(["granted"]);
  });

  it("defers devicechange reconciliation until the newest grant inventory settles", async () => {
    let finishInventory!: (value: MediaDeviceInfo[]) => void;
    let finishChooser!: (value: MediaDeviceInfo) => void;
    let finishRefresh!: (value: MediaDeviceInfo[]) => void;
    let devicechange!: () => void;
    const enumerate = vi.fn().mockResolvedValueOnce([device("saved")])
      .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishInventory = resolve; }))
      .mockResolvedValue([device("rotated")]);
    install({ enumerateDevices: enumerate,
      selectAudioOutput: vi.fn(() => new Promise((resolve) => { finishChooser = resolve; })),
      addEventListener: (_: string, callback: () => void) => { devicechange = callback; }, removeEventListener: vi.fn() });
    mount();
    await waitFor(() => expect(currentOutput?.browserOutputDevices).toHaveLength(1));
    const disconnect = vi.spyOn(browserAudio, "markBrowserOutputDisconnected");
    let discovery!: Promise<void>;
    act(() => { discovery = currentOutput!.discoverBrowserOutputs(); });
    // Grant refresh starts first; a devicechange then supersedes it while discovery is still pending.
    act(() => finishChooser(device("granted")));
    await waitFor(() => expect(enumerate).toHaveBeenCalledTimes(2));
    act(() => devicechange());
    await act(async () => { finishRefresh([device("saved")]); });
    expect(currentOutput?.browserOutputDiscoveryPending).toBe(true);
    expect(currentOutput?.browserOutputDiscoveryResult).toBeNull();
    await act(async () => { finishInventory([device("rotated")]); await discovery; });
    expect(currentOutput?.browserOutputDevices.map((entry) => entry.deviceId)).toEqual(["rotated"]);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("saved");
    expect(enumerate).toHaveBeenCalledTimes(4);
  });

  it.each(["grant", "denial"])("reconciles unavailable IDs after %s without changing saved or unaffected routes", async (outcome) => {
    let settle!: (value: MediaDeviceInfo) => void;
    let deny!: (reason: Error) => void;
    let devicechange!: () => void;
    let removed = false;
    const enumerate = vi.fn(async () => removed ? [device("other")] : [device("saved"), device("other")]);
    install({ enumerateDevices: enumerate,
      selectAudioOutput: vi.fn(() => new Promise<MediaDeviceInfo>((resolve, reject) => { settle = resolve; deny = reject; })),
      addEventListener: (_: string, callback: () => void) => { devicechange = callback; }, removeEventListener: vi.fn() });
    const routing = { project: { kind: "explicit-device" as const, deviceId: "saved" },
      cue: { kind: "system-default" as const },
      stems: { bass: { kind: "explicit-device" as const, deviceId: "other" } } };
    window.localStorage.setItem("tuneforge.browser-output-device", "saved");
    window.localStorage.setItem("tuneforge.project-playback-state", JSON.stringify({ fixture: { routing } }));
    mount();
    await waitFor(() => expect(currentOutput?.browserOutputDevices).toHaveLength(2));
    browserAudio.setBrowserOutputRouting({ projectId: `discovery-fixture-${outcome}`, globalDeviceId: "saved", routing,
      lanes: [{ laneId: "bass", stableKey: "bass" }] });
    const project = document.createElement("audio");
    const bass = document.createElement("audio");
    browserAudio.registerProjectMediaElement(project, 1);
    browserAudio.registerProjectMediaElement(bass, 1, "bass");
    try {
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("selected"));
      const before = browserAudio.browserOutputRoutingSnapshot();
      const storage = savedRouteStorage();
      const retry = vi.spyOn(browserAudio, "retryBrowserOutputRouting");
      const routeSetter = vi.spyOn(browserAudio, "setBrowserOutputRouting");
      let discovery!: Promise<void>;
      act(() => { discovery = currentOutput!.discoverBrowserOutputs(); });
      removed = true;
      await act(async () => { devicechange(); devicechange(); });
      expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("selected");
      await act(async () => {
        if (outcome === "grant") settle(device("chooser-result"));
        else deny(new DOMException("synthetic", "NotAllowedError"));
        await discovery;
      });
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("fallback-default"));
      const after = browserAudio.browserOutputRoutingSnapshot();
      expect(after.project).toMatchObject({ selection: routing.project, preferredDeviceId: "saved",
        effectiveDeviceId: null, fallbackLatched: true });
      expect(after.cue).toEqual(before.cue);
      expect(after.lanes).toEqual(before.lanes);
      expect(currentOutput?.browserOutputDeviceId).toBe("saved");
      expect(savedRouteStorage()).toEqual(storage);
      expect(retry).not.toHaveBeenCalled();
      expect(routeSetter).not.toHaveBeenCalled();
      expect(enumerate).toHaveBeenCalledTimes(outcome === "grant" ? 5 : 4);
    } finally {
      browserAudio.unregisterProjectMediaElement(project);
      browserAudio.unregisterProjectMediaElement(bass);
    }
  });

  it("retains deferred reconciliation through an immediate retry while the prior drain is enumerating", async () => {
    let devicechange!: () => void;
    let grantFirst!: (value: MediaDeviceInfo) => void;
    let grantRetry!: (value: MediaDeviceInfo) => void;
    let finishDrain!: (value: MediaDeviceInfo[]) => void;
    const chooser = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { grantFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { grantRetry = resolve; }));
    const enumerate = vi.fn().mockResolvedValueOnce([device("saved")])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((resolve) => { finishDrain = resolve; }))
      .mockResolvedValue([]);
    install({ enumerateDevices: enumerate, selectAudioOutput: chooser,
      addEventListener: (_: string, callback: () => void) => { devicechange = callback; }, removeEventListener: vi.fn() });
    window.localStorage.setItem("tuneforge.browser-output-device", "saved");
    mount();
    await waitFor(() => expect(currentOutput?.browserOutputDevices).toHaveLength(1));
    const routing = { project: { kind: "explicit-device" as const, deviceId: "saved" },
      cue: { kind: "system-default" as const }, stems: {} };
    browserAudio.setBrowserOutputRouting({ projectId: "discovery-immediate-retry", globalDeviceId: "saved", routing, lanes: [] });
    const project = document.createElement("audio");
    browserAudio.registerProjectMediaElement(project, 1);
    try {
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("selected"));
      const storage = savedRouteStorage();
      const retry = vi.spyOn(browserAudio, "retryBrowserOutputRouting");
      let first!: Promise<void>;
      act(() => { first = currentOutput!.discoverBrowserOutputs(); });
      await act(async () => devicechange());
      await act(async () => { grantFirst(device("ignored")); await first; });
      expect(enumerate).toHaveBeenCalledTimes(4);
      expect(currentOutput?.browserOutputDiscoveryPending).toBe(false);
      let second!: Promise<void>;
      act(() => { second = currentOutput!.discoverBrowserOutputs(); });
      await act(async () => finishDrain([]));
      expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("selected");
      expect(currentOutput?.browserOutputDiscoveryPending).toBe(true);
      await act(async () => { grantRetry(device("ignored-again")); await second; });
      await waitFor(() => expect(browserAudio.browserOutputRoutingSnapshot().project.status).toBe("fallback-default"));
      expect(browserAudio.browserOutputRoutingSnapshot().project.selection).toEqual(routing.project);
      expect(currentOutput?.browserOutputDeviceId).toBe("saved");
      expect(savedRouteStorage()).toEqual(storage);
      expect(retry).not.toHaveBeenCalled();
      expect(enumerate).toHaveBeenCalledTimes(6);
    } finally {
      browserAudio.unregisterProjectMediaElement(project);
    }
  });

  it("reports newest enumeration failure when devicechange supersedes the grant refresh", async () => {
    let finishRefresh!: (value: MediaDeviceInfo[]) => void;
    let failLatest!: (reason: Error) => void;
    let devicechange!: () => void;
    const enumerate = vi.fn().mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }))
      .mockImplementationOnce(() => new Promise((_, reject) => { failLatest = reject; }));
    install({ enumerateDevices: enumerate, selectAudioOutput: vi.fn(async () => device("granted")),
      addEventListener: (_: string, callback: () => void) => { devicechange = callback; }, removeEventListener: vi.fn() });
    mount();
    let discovery!: Promise<void>;
    act(() => { discovery = currentOutput!.discoverBrowserOutputs(); });
    await waitFor(() => expect(enumerate).toHaveBeenCalledTimes(2));
    act(() => devicechange());
    await act(async () => finishRefresh([]));
    expect(currentOutput?.browserOutputDiscoveryPending).toBe(true);
    await act(async () => { failLatest(new Error("synthetic")); await discovery; });
    expect(currentOutput?.browserOutputDiscoveryError).toContain("Could not refresh outputs");
    expect(currentOutput?.browserOutputDiscoveryResult).toBeNull();
  });

  it("keeps native capability failure out of browser APIs but permits explicitly forced WebAudio", async () => {
    const chooser = vi.fn(async () => device("granted"));
    const enumerate = vi.fn(async () => []);
    install({ enumerateDevices: enumerate, selectAudioOutput: chooser }, true);
    mockGetNativeCapabilities.mockRejectedValue(new Error("synthetic"));
    const view = mount();
    await waitFor(() => expect(currentOutput?.outputDeviceError).toContain("Native output controls"));
    await act(async () => {
      await currentOutput!.discoverBrowserOutputs();
      expect(await currentOutput!.authorizeBrowserOutputDevice("granted")).toBeNull();
    });
    expect(enumerate).not.toHaveBeenCalled();
    expect(chooser).not.toHaveBeenCalled();
    expect(currentOutput?.browserOutputDiscoveryMethod).toBeNull();
    view.unmount();
    mockForcedWebAudio.mockReturnValue(true);
    mount();
    await act(async () => currentOutput!.discoverBrowserOutputs());
    expect(currentOutput?.browserOutputDiscoveryMethod).toBe("output-chooser");
    expect(chooser).toHaveBeenCalledTimes(1);
  });

  it("separates discovery support from sink routing and preserves chooser-granted row authorization IDs", async () => {
    const enumerate = vi.fn(async () => [device("granted")]);
    install({ enumerateDevices: enumerate, selectAudioOutput: vi.fn(async () => device("granted")) });
    Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    const view = mount();
    expect(currentOutput?.browserOutputSelectionSupported).toBe(false);
    expect(currentOutput?.browserOutputDiscoveryMethod).toBe("output-chooser");
    view.unmount();
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: vi.fn() });
    mount();
    const before = enumerate.mock.calls.length;
    await act(async () => expect(await currentOutput!.authorizeBrowserOutputDevice("requested")).toBe("granted"));
    expect(enumerate.mock.calls.length).toBeGreaterThan(before);
    expect(currentOutput?.browserOutputDeviceId).toBeNull();
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBeNull();
  });
});
