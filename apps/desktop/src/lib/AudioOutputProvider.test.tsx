import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioOutputProvider } from "./AudioOutputProvider";
import { useAudioOutput, type AudioOutputContextValue } from "./audioOutputContext";
import { PreferencesProvider } from "./preferences";

const { mockSetNativeAppOutput, mockSetNativeCueOutputs, mockSetNativeOutputDevice,
  mockGetNativeCapabilities, mockGetNativeOutputRoute, mockListNativeOutputDevices } = vi.hoisted(() => ({
  mockSetNativeAppOutput: vi.fn(),
  mockSetNativeCueOutputs: vi.fn(),
  mockSetNativeOutputDevice: vi.fn(),
  mockGetNativeCapabilities: vi.fn(),
  mockGetNativeOutputRoute: vi.fn(),
  mockListNativeOutputDevices: vi.fn(),
}));

vi.mock("./nativeAudio", () => ({
  getNativeAudioCapabilities: mockGetNativeCapabilities,
  getNativeOutputRoute: mockGetNativeOutputRoute,
  isWebAudioBackendForced: () => false,
  isAndroidRuntime: () => false,
  listNativeAudioOutputDevices: mockListNativeOutputDevices,
  listenNativeOutputRoute: () => Promise.resolve(() => undefined),
  setNativeOutputDevice: mockSetNativeOutputDevice,
  setNativeAppOutput: mockSetNativeAppOutput,
  setNativeCueOutputs: mockSetNativeCueOutputs,
}));

let currentOutput: AudioOutputContextValue | null = null;

function Probe() {
  currentOutput = useAudioOutput();
  return <span>{currentOutput.outputSaveError ?? "ready"}</span>;
}

describe("AudioOutputProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    currentOutput = null;
    mockSetNativeAppOutput.mockReset();
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
