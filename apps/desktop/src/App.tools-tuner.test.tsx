import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitMockNativeInputFrame,
  emitMockNativeInputState,
  getMockAudioContexts,
  getMockInvoke,
  getMockMediaDevices,
  getMockWakeLock,
  resetAppTestHarness,
  renderApp,
  setMockNativeAudioState,
  setMockSystemInputVolumeState,
} from "./test/appTestHarness";

function mockTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: getMockInvoke() },
  });
}

function makeEndingMediaStream() {
  const endedListeners = new Set<() => void>();
  const track = {
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "ended") endedListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "ended") endedListeners.delete(listener);
    }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: vi.fn(() => [track]),
    getTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
  return {
    end() {
      endedListeners.forEach((listener) => listener());
    },
    stream,
    track,
  };
}

describe("Desktop app tools tuner", () => {
  beforeEach(resetAppTestHarness);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("renders the tools route with chromatic tuner defaults", async () => {
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chromatic Tuner" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(440);
    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("wide-arc");
    expect(screen.getByRole("option", { name: "Wide Arc" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Simple Meter" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Microphone 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    expect(screen.getByTestId("wide-arc-tuner-meter")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Tuning offset" })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Input signal level" })).toBeInTheDocument();
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_list_input_devices");
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps the simple visual mode available and persists it", async () => {
    const user = userEvent.setup();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Tuner visual mode"), "simple");

    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("simple");
    expect(screen.getByTestId("simple-tuner-meter")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Tuning offset" })).toBeInTheDocument();
    expect(window.localStorage.getItem("tuneforge.ui-preferences")).toContain(
      '"defaultTunerVisualMode":"simple"',
    );
  });

  it("keeps tuner preferences synced between tools and settings", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [{ id: "cpal:1:usb", label: "USB Interface", isDefault: false }],
        error: null,
      },
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await refreshMicrophoneOptions("USB Interface");
    await user.selectOptions(screen.getByLabelText("Microphone source"), "cpal:1:usb");
    changeReferenceInput("442.5");
    await user.selectOptions(screen.getByLabelText("Tuner visual mode"), "simple");

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("cpal:1:usb");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(442.5);
    expect(screen.getByLabelText("Default tuner")).toHaveValue("simple");
    expect(screen.getByRole("option", { name: "USB Interface" })).toBeInTheDocument();
    expect(screen.getByText("442.5 Hz")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Microphone source"), "");
    changeReferenceInput("441");
    await user.selectOptions(screen.getByLabelText("Default tuner"), "wide-arc");
    await user.click(screen.getByRole("link", { name: "Tools" }));

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(441);
    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("wide-arc");
  });

  it("applies valid reference tuning edits before the field blurs", async () => {
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("A4 reference tuning"), { target: { value: "442" } });

    expect(window.localStorage.getItem("tuneforge.ui-preferences")).toContain(
      '"defaultTunerReferenceHz":442',
    );
  });

  it("controls the system default microphone volume", async () => {
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    const systemInputVolume = await screen.findByLabelText("System input volume");

    expect(systemInputVolume).toHaveValue("64");
    fireEvent.change(systemInputVolume, { target: { value: "83" } });
    fireEvent.change(systemInputVolume, { target: { value: "84" } });
    fireEvent.change(systemInputVolume, { target: { value: "87" } });

    expect(systemInputVolume).toBeEnabled();
    expect(systemInputVolume).toHaveValue("87");
    expect(getMockInvoke()).not.toHaveBeenCalledWith("set_system_default_input_volume", {
      deviceId: null,
      volumePercent: 83,
    });
    fireEvent.pointerUp(systemInputVolume);

    await waitFor(() =>
      expect(getMockInvoke()).toHaveBeenCalledWith("set_system_default_input_volume", {
        deviceId: null,
        volumePercent: 87,
      }),
    );
    expect(getMockInvoke()).not.toHaveBeenCalledWith("set_system_default_input_volume", {
      deviceId: null,
      volumePercent: 84,
    });
  });

  it("controls the selected native microphone volume", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [{ id: "cpal:0:built-in", label: "Built-in Microphone", isDefault: false }],
        error: null,
      },
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await refreshMicrophoneOptions("Built-in Microphone");
    await user.selectOptions(screen.getByLabelText("Microphone source"), "cpal:0:built-in");

    const selectedInputVolume = await screen.findByLabelText("Selected input volume");
    fireEvent.change(selectedInputVolume, { target: { value: "72" } });
    fireEvent.pointerUp(selectedInputVolume);

    await waitFor(() =>
      expect(getMockInvoke()).toHaveBeenCalledWith("get_system_default_input_volume", {
        deviceId: "cpal:0:built-in",
      }),
    );
    await waitFor(() =>
      expect(getMockInvoke()).toHaveBeenCalledWith("set_system_default_input_volume", {
        deviceId: "cpal:0:built-in",
        volumePercent: 72,
      }),
    );
    expect(await screen.findByText("Controls the selected microphone.")).toBeInTheDocument();
  });

  it("shows unsupported system microphone volume state", async () => {
    setMockSystemInputVolumeState({
      supported: false,
      volumePercent: null,
      muted: null,
      backend: null,
      error: "System input volume control is unavailable.",
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(await screen.findByText("System input volume control is unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("System input volume")).toBeDisabled();
  });

  it("normalizes invalid stored tuner preferences", async () => {
    window.localStorage.setItem(
      "tuneforge.ui-preferences",
      JSON.stringify({
        defaultTunerInputDeviceId: "",
        defaultTunerReferenceHz: 999,
        defaultTunerVisualMode: "needle",
      }),
    );

    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(440);
    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("wide-arc");
  });

  it("starts Web Audio capture with the system default source and stops cleanly", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().revealLabels();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    expect(getMockMediaDevices().getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });
    expect(getMockAudioContexts()).toHaveLength(1);
    expect(getMockAudioContexts()[0]?.createdMediaStreamSources[0]?.connect).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("acquires Web tuner protection only after capture is listening and releases on stop", async () => {
    const user = userEvent.setup();
    const endingStream = makeEndingMediaStream();
    let resolveCapture: (stream: MediaStream) => void = () => undefined;
    getMockMediaDevices().getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((resolve) => {
        resolveCapture = resolve;
      }),
    );
    mockTauriRuntime();
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(getMockMediaDevices().getUserMedia).toHaveBeenCalled());
    expect(getMockWakeLock().request).not.toHaveBeenCalled();
    expect(getMockInvoke()).not.toHaveBeenCalledWith("power_inhibition_set_activity", {
      reason: "tuner-capture",
      active: true,
    });

    await act(async () => {
      resolveCapture(endingStream.stream);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("Listening")).toBeInTheDocument());
    await waitFor(() => expect(getMockWakeLock().request).toHaveBeenCalledWith("screen"));
    await waitFor(() =>
      expect(getMockInvoke()).toHaveBeenCalledWith("power_inhibition_set_activity", {
        reason: "tuner-capture",
        active: true,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(getMockWakeLock().sentinels[0]?.release).toHaveBeenCalled());
    await waitFor(() =>
      expect(getMockInvoke()).toHaveBeenCalledWith("power_inhibition_set_activity", {
        reason: "tuner-capture",
        active: false,
      }),
    );
    expect(endingStream.track.removeEventListener).toHaveBeenCalledWith(
      "ended",
      expect.any(Function),
    );
    expect(endingStream.track.stop).toHaveBeenCalled();
  });

  it("ends Web tuner capture generation when its microphone track terminates", async () => {
    const user = userEvent.setup();
    const endingStream = makeEndingMediaStream();
    getMockMediaDevices().getUserMedia.mockResolvedValueOnce(endingStream.stream);
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByText("Listening")).toBeInTheDocument());

    act(() => endingStream.end());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Microphone capture ended. Choose Retry to start it again.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(endingStream.track.removeEventListener).toHaveBeenCalledWith(
      "ended",
      expect.any(Function),
    );
    expect(endingStream.track.stop).toHaveBeenCalledTimes(1);
  });

  it("uses native microphone capture when available", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [
          { id: "cpal:0:built-in", label: "Built-in Microphone", isDefault: true },
          { id: "cpal:1:usb", label: "USB Interface", isDefault: false },
        ],
        error: null,
      },
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await refreshMicrophoneOptions("USB Interface");
    await user.selectOptions(screen.getByLabelText("Microphone source"), "cpal:1:usb");
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(getMockInvoke()).toHaveBeenCalledWith("audio_start_input", {
        payload: { deviceId: "cpal:1:usb" },
      }),
    );
    expect(window.localStorage.getItem("tuneforge.tuner-input-capture-backend")).toContain(
      "desktop-cpal",
    );
    expect(screen.getByText("Listening", { selector: ".subpanel__copy" })).toHaveAttribute("aria-live", "polite");
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
    expect(getMockInvoke()).not.toHaveBeenCalledWith("power_inhibition_set_activity", {
      reason: "tuner-capture",
      active: true,
    });

    act(() => {
      emitMockNativeInputFrame({
        deviceId: "cpal:1:usb",
        sampleRate: 48000,
        inputLevel: 0.25,
        samples: makeSineSamples(440, 48000, 2048),
        timestampMs: 1000,
        captureGeneration: 1,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("meter", { name: "Input signal level" })).toHaveAttribute(
        "aria-valuenow",
        "50",
      ),
    );
    expect(screen.getByTestId("wide-arc-tuner-meter")).not.toHaveAttribute(
      "data-tuning-state",
      "no-pitch",
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(getMockInvoke()).toHaveBeenCalledWith("audio_stop_input");
    act(() => {
      emitMockNativeInputFrame({
        deviceId: "cpal:1:usb",
        sampleRate: 48000,
        inputLevel: 1,
        samples: makeSineSamples(440, 48000, 2048),
        timestampMs: 1100,
        captureGeneration: 1,
      });
    });
    expect(screen.getByRole("meter", { name: "Input signal level" })).toHaveAttribute("aria-valuenow", "0");

    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    act(() => {
      emitMockNativeInputFrame({
        deviceId: "cpal:1:usb",
        sampleRate: 48000,
        inputLevel: 1,
        samples: makeSineSamples(440, 48000, 2048),
        timestampMs: 1200,
        captureGeneration: 1,
      });
    });
    expect(screen.getByRole("meter", { name: "Input signal level" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("stops native capture when the tuner unmounts", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({ capabilities: { micCaptureSupported: true, backend: "desktop-cpal" } });
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Metronome" }));

    await waitFor(() => expect(getMockInvoke()).toHaveBeenCalledWith("audio_stop_input"));
  });

  it("does not query native microphone devices while the tuner is idle until the picker is opened", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [{ id: "cpal:1:usb", label: "USB Interface", isDefault: false }],
        error: null,
      },
    });

    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    expect(
      getMockInvoke().mock.calls.filter(([command]) => command === "audio_list_input_devices"),
    ).toHaveLength(0);

    await refreshMicrophoneOptions("USB Interface");

    expect(
      getMockInvoke().mock.calls.filter(([command]) => command === "audio_list_input_devices"),
    ).toHaveLength(1);
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  it("runs a follow-up refresh when devices change during active native discovery", async () => {
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
    });
    const mockInvoke = getMockInvoke();
    const originalInvoke = mockInvoke.getMockImplementation();
    if (!originalInvoke) {
      throw new Error("Missing invoke mock implementation.");
    }
    type NativeInputDevicesResponse = {
      supported: boolean;
      devices: Array<{ id: string; label: string; isDefault: boolean }>;
      error: string | null;
    };
    let resolveFirstInputDevices: (value: NativeInputDevicesResponse) => void = () => undefined;
    const firstInputDevices = new Promise<NativeInputDevicesResponse>((resolve) => {
      resolveFirstInputDevices = resolve;
    });
    let inputDeviceCalls = 0;
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "audio_list_input_devices") {
        inputDeviceCalls += 1;
        if (inputDeviceCalls === 1) {
          return firstInputDevices;
        }
        return {
          supported: true,
          devices: [{ id: "cpal:2:new", label: "New Interface", isDefault: false }],
          error: null,
        };
      }
      return originalInvoke(command, args);
    });

    try {
      renderApp(["/tools"]);

      expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
      fireEvent.focus(screen.getByLabelText("Microphone source"));
      await waitFor(() => expect(inputDeviceCalls).toBe(1));

      emitMockMediaDeviceChange();
      await act(async () => {
        resolveFirstInputDevices({
          supported: true,
          devices: [{ id: "cpal:1:old", label: "Old Interface", isDefault: false }],
          error: null,
        });
        await firstInputDevices;
      });

      expect(await screen.findByRole("option", { name: "New Interface" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "Old Interface" })).not.toBeInTheDocument();
      expect(inputDeviceCalls).toBe(2);
    } finally {
      mockInvoke.mockImplementation(originalInvoke);
    }
  });

  it("can force Web Audio capture when native capture is available", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_TUNEFORGE_FORCE_WEB_AUDIO", "1");
    getMockMediaDevices().revealLabels();
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [{ id: "cpal:1:usb", label: "Native USB Interface", isDefault: false }],
        error: null,
      },
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Native USB Interface" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(getMockMediaDevices().getUserMedia).toHaveBeenCalledWith({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      }),
    );
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_get_capabilities");
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_list_input_devices");
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_start_input", expect.anything());
    expect(window.localStorage.getItem("tuneforge.tuner-input-capture-backend")).toContain(
      '"web"',
    );
  });

  it("keeps Web tuner capture active when screen protection is unavailable", async () => {
    const user = userEvent.setup();
    getMockWakeLock().request.mockRejectedValueOnce(new Error("denied"));
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByText("Listening")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Screen protection is unavailable. The tuner may stop if the device sleeps.",
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("falls back to Web Audio when native capture fails", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().revealLabels();
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [{ id: "cpal:1:usb", label: "USB Interface", isDefault: false }],
        error: null,
      },
      startError: "Native microphone failed.",
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(getMockMediaDevices().getUserMedia).toHaveBeenCalledWith({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      }),
    );
    expect(screen.queryByText("Native microphone failed.")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("tuneforge.tuner-native-capture-error")).toBe(
      "Native microphone failed.",
    );
    expect(window.localStorage.getItem("tuneforge.tuner-input-capture-backend")).toContain(
      '"web"',
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("never falls back to Web Audio when packaged Android native capture fails", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "tuneforge.tuner-microphone-devices",
      JSON.stringify([{ deviceId: "cached", label: "Cached browser microphone" }]),
    );
    setMockNativeAudioState({
      capabilities: {
        platform: "android",
        backend: "android-aaudio",
        micCaptureSupported: true,
      },
      startError: "The microphone could not start. Check Android Settings > Apps > TuneForge > Permissions > Microphone, then choose Retry.",
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Cached browser microphone" })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Android Settings");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("continues Android startup after a prompted permission grant", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: { platform: "android", backend: "android-aaudio", micCaptureSupported: true },
      inputPermission: { state: "prompt", error: null },
    });
    const mockInvoke = getMockInvoke();
    const originalInvoke = mockInvoke.getMockImplementation();
    if (!originalInvoke) throw new Error("Missing invoke mock implementation.");
    let requested = false;
    mockInvoke.mockImplementation((command, args) => {
      if (command === "audio_request_input_permission") {
        requested = true;
        return Promise.resolve({ state: "prompting", error: null });
      }
      if (command === "audio_get_input_permission_status" && requested) {
        return Promise.resolve({ state: "granted", error: null });
      }
      return originalInvoke(command, args);
    });
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("audio_start_input", {
        payload: { deviceId: null },
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("audio_request_input_permission");
    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps Android permission denial recoverable without starting capture", async () => {
    const user = userEvent.setup();
    const denial = {
      code: "permission-denied",
      message: "Microphone permission was denied.",
      guidance: "Check Android Settings > Apps > TuneForge > Permissions > Microphone, then choose Retry.",
    };
    setMockNativeAudioState({
      capabilities: { platform: "android", backend: "android-aaudio", micCaptureSupported: true },
      inputPermission: { state: "prompt", error: null },
    });
    const mockInvoke = getMockInvoke();
    const originalInvoke = mockInvoke.getMockImplementation();
    if (!originalInvoke) throw new Error("Missing invoke mock implementation.");
    let requested = false;
    mockInvoke.mockImplementation((command, args) => {
      if (command === "audio_request_input_permission") {
        requested = true;
        return Promise.resolve({ state: "prompting", error: null });
      }
      if (command === "audio_get_input_permission_status" && requested) {
        return Promise.resolve({ state: "denied", error: denial });
      }
      return originalInvoke(command, args);
    });
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert", undefined, { timeout: 3_000 })).toHaveTextContent(
      "Android Settings",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(mockInvoke).not.toHaveBeenCalledWith("audio_start_input", expect.anything());
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("reports permanently blocked Android permission without prompting or fallback", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: { platform: "android", backend: "android-aaudio", micCaptureSupported: true },
      inputPermission: {
        state: "blocked",
        error: {
          code: "permission-blocked",
          message: "Microphone permission is blocked.",
          guidance: "Check Android Settings > Apps > TuneForge > Permissions > Microphone, then choose Retry.",
        },
      },
    });
    renderApp(["/tools"]);

    await user.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Android Settings");
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_request_input_permission");
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_start_input", expect.anything());
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("stops Android capture on a generation-matched terminal state event", async () => {
    const user = userEvent.setup();
    setMockNativeAudioState({
      capabilities: {
        platform: "android",
        backend: "android-aaudio",
        micCaptureSupported: true,
      },
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    setMockNativeAudioState({
      inputState: {
        active: false,
        captureGeneration: 0,
        capturePath: "none",
        inputLevel: 0,
        sampleRate: null,
        error: {
          code: "stream-interruption",
          message: "Microphone capture was interrupted.",
          guidance: "Choose Retry when the microphone is available.",
        },
      },
    });
    act(() => emitMockNativeInputState());
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    setMockNativeAudioState({ inputState: { captureGeneration: 1 } });
    act(() => emitMockNativeInputState());

    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone capture was interrupted.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("falls back to system-default Web Audio when a native microphone selection fails", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().revealLabels();
    setMockNativeAudioState({
      capabilities: {
        micCaptureSupported: true,
        backend: "desktop-cpal",
      },
      inputDevices: {
        supported: true,
        devices: [{ id: "cpal:0:built-in", label: "Built-in Microphone", isDefault: false }],
        error: null,
      },
      startError: "Native microphone failed.",
    });
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await refreshMicrophoneOptions("Built-in Microphone");
    await user.selectOptions(screen.getByLabelText("Microphone source"), "cpal:0:built-in");
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    expect(screen.queryByText("Native microphone failed.")).not.toBeInTheDocument();
    expect(getMockMediaDevices().getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Built-in Microphone" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("tuneforge.tuner-native-capture-error")).toBe(
      "Native microphone failed.",
    );
    expect(window.localStorage.getItem("tuneforge.tuner-input-capture-backend")).toContain(
      '"web"',
    );
  });

  it("uses cached device labels before start without opening capture", async () => {
    window.localStorage.setItem(
      "tuneforge.tuner-microphone-devices",
      JSON.stringify([{ deviceId: "usb", label: "USB Interface" }]),
    );

    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeDisabled();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("does not open capture when settings renders tuner defaults", async () => {
    renderApp(["/settings"]);

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(getMockInvoke()).not.toHaveBeenCalledWith("audio_list_input_devices");
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("caches device labels after real tuner capture starts", async () => {
    const user = userEvent.setup();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    expect(window.localStorage.getItem("tuneforge.tuner-microphone-devices")).toContain("USB Interface");
  });

  it("shows microphone permission failures as recoverable state", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().rejectGetUserMedia(new DOMException("Denied", "NotAllowedError"));
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Microphone permission was denied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});

function changeReferenceInput(value: string) {
  const input = screen.getByLabelText("A4 reference tuning");
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

async function refreshMicrophoneOptions(optionName: string) {
  const inputSource = screen.getByLabelText("Microphone source");
  fireEvent.pointerDown(inputSource);
  fireEvent.focus(inputSource);
  return screen.findByRole("option", { name: optionName });
}

function emitMockMediaDeviceChange() {
  const addEventListener = vi.mocked(navigator.mediaDevices.addEventListener);
  const listener = addEventListener.mock.calls.find(
    ([eventName]) => eventName === "devicechange",
  )?.[1];
  if (!listener) {
    throw new Error("Missing media devicechange listener.");
  }
  const event = new Event("devicechange");
  if (typeof listener === "function") {
    act(() => listener(event));
    return;
  }
  act(() => listener.handleEvent(event));
}

function makeSineSamples(frequencyHz: number, sampleRate: number, sampleCount: number) {
  return Array.from({ length: sampleCount }, (_, index) =>
    Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * 0.5,
  );
}
