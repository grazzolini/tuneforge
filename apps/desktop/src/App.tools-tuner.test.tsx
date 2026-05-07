import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitMockNativeInputFrame,
  getMockAudioContexts,
  getMockInvoke,
  getMockMediaDevices,
  resetAppTestHarness,
  renderApp,
  setMockNativeAudioState,
  setMockSystemInputVolumeState,
} from "./test/appTestHarness";

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
    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("simple");
    expect(screen.getByRole("option", { name: "Wide Arc" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Microphone 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "USB Interface" })).not.toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Tuning offset" })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Input signal level" })).toBeInTheDocument();
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps the wide arc visual mode available", async () => {
    const user = userEvent.setup();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Tuner visual mode"), "wide-arc");

    expect(screen.getByLabelText("Tuner visual mode")).toHaveValue("wide-arc");
    expect(screen.getByRole("meter", { name: "Tuning offset" })).toBeInTheDocument();
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
    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Microphone source"), "cpal:1:usb");
    changeReferenceInput("442.5");

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("cpal:1:usb");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(442.5);
    expect(screen.getByText("Saved microphone")).toBeInTheDocument();
    expect(screen.getByText("442.5 Hz")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Microphone source"), "");
    changeReferenceInput("441");
    await user.click(screen.getByRole("link", { name: "Tools" }));

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(441);
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
      }),
    );

    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone source")).toHaveValue("");
    expect(screen.getByLabelText("A4 reference tuning")).toHaveValue(440);
  });

  it("starts Web Audio capture with the system default source and stops cleanly", async () => {
    const user = userEvent.setup();
    getMockMediaDevices().revealLabels();
    renderApp(["/tools"]);

    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "USB Interface" })).toBeDisabled(),
    );
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
    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeInTheDocument();
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
    expect(getMockMediaDevices().getUserMedia).not.toHaveBeenCalled();

    emitMockNativeInputFrame({
      deviceId: "cpal:1:usb",
      sampleRate: 48000,
      inputLevel: 0.25,
      samples: makeSineSamples(440, 48000, 2048),
      timestampMs: 1000,
    });

    await waitFor(() =>
      expect(screen.getByRole("meter", { name: "Input signal level" })).toHaveAttribute(
        "aria-valuenow",
        "50",
      ),
    );
    expect(screen.getByTestId("simple-tuner-meter")).not.toHaveAttribute(
      "data-tuning-state",
      "no-pitch",
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(getMockInvoke()).toHaveBeenCalledWith("audio_stop_input");
  });

  it("does not poll native microphone devices while the tuner is idle", async () => {
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

    expect(await screen.findByRole("option", { name: "USB Interface" })).toBeInTheDocument();
    expect(
      getMockInvoke().mock.calls.filter(([command]) => command === "audio_list_input_devices"),
    ).toHaveLength(1);
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 5000);
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
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "USB Interface" })).toBeDisabled(),
    );
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
    expect(await screen.findByRole("option", { name: "Built-in Microphone" })).toBeInTheDocument();
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
    expect(screen.getByRole("option", { name: "Built-in Microphone" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });
});

function changeReferenceInput(value: string) {
  const input = screen.getByLabelText("A4 reference tuning");
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function makeSineSamples(frequencyHz: number, sampleRate: number, sampleCount: number) {
  return Array.from({ length: sampleCount }, (_, index) =>
    Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * 0.5,
  );
}
