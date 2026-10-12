import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetTunerMicrophoneAccessGranted,
  readRememberedBrowserTunerMicrophoneDevices,
  readRememberedTunerMicrophoneDevices,
  rememberBrowserTunerMicrophoneDevices,
  rememberTunerMicrophoneDevices,
  useBrowserTunerInputDevice,
} from "./tunerMicrophoneAccess";

const preferenceKey = "tuneforge.browser-tuner-input-device";

describe("browser tuner input preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it.each(["cpal:1:usb", "pipewire:usb"])("does not migrate native ID %s", (nativeId) => {
    const { result } = renderHook(() => useBrowserTunerInputDevice(nativeId));
    expect(result.current[0]).toBeNull();
    expect(window.localStorage.getItem(preferenceKey)).toBe("null");
  });

  it("migrates a browser candidate once, preserving explicit default thereafter", () => {
    const { result, unmount } = renderHook(() => useBrowserTunerInputDevice("legacy-browser"));
    expect(result.current[0]).toBe("legacy-browser");
    act(() => result.current[1](null));
    unmount();
    const next = renderHook(() => useBrowserTunerInputDevice("legacy-browser"));
    expect(next.result.current[0]).toBeNull();
    expect(window.localStorage.getItem(preferenceKey)).toBe("null");
  });

  it("shares browser selection without accepting native IDs", () => {
    const first = renderHook(() => useBrowserTunerInputDevice(null));
    const second = renderHook(() => useBrowserTunerInputDevice("cpal:1:native"));
    act(() => first.result.current[1]("usb"));
    expect(second.result.current[0]).toBe("usb");
    act(() => second.result.current[1]("pipewire:usb"));
    expect(first.result.current[0]).toBeNull();
  });

  it("keeps browser names and permission cleanup separate from native names", () => {
    const native = [{ deviceId: "cpal:1:native", label: "Native Interface" }];
    rememberTunerMicrophoneDevices(native);
    rememberBrowserTunerMicrophoneDevices([
      { deviceId: "usb", label: "USB Interface" },
      ...native,
    ]);
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([{ deviceId: "usb", label: "USB Interface" }]);
    rememberTunerMicrophoneDevices([{ deviceId: "pipewire:new", label: "New Native" }]);
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([{ deviceId: "usb", label: "USB Interface" }]);
    forgetTunerMicrophoneAccessGranted();
    expect(readRememberedTunerMicrophoneDevices()).toEqual([{ deviceId: "pipewire:new", label: "New Native" }]);
    expect(window.localStorage.getItem("tuneforge.browser-tuner-microphone-devices")).toBeNull();
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([]);
  });

  it("removes legacy browser names after permission loss while preserving native entries", () => {
    const native = [
      { deviceId: "cpal:1:native", label: "Native Interface" },
      { deviceId: "pipewire:native", label: "Native Microphone" },
    ];
    rememberTunerMicrophoneDevices([
      { deviceId: "usb", label: "Legacy USB" },
      ...native,
    ]);
    expect(window.localStorage.getItem("tuneforge.browser-tuner-microphone-devices")).toBeNull();
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([{ deviceId: "usb", label: "Legacy USB" }]);
    forgetTunerMicrophoneAccessGranted();
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([]);
    expect(readRememberedTunerMicrophoneDevices()).toEqual(native);
  });

  it("removes browser-only legacy cache after permission loss", () => {
    rememberTunerMicrophoneDevices([{ deviceId: "usb", label: "Legacy USB" }]);
    window.localStorage.setItem("tuneforge.tuner-microphone-access-granted", "true");
    forgetTunerMicrophoneAccessGranted();
    expect(window.localStorage.getItem("tuneforge.tuner-microphone-access-granted")).toBeNull();
    expect(window.localStorage.getItem("tuneforge.tuner-microphone-devices")).toBeNull();
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([]);
  });

  it("retains remembered names after current inventory removes a saved device", () => {
    rememberBrowserTunerMicrophoneDevices([{ deviceId: "usb", label: "USB Interface" }]);
    rememberBrowserTunerMicrophoneDevices([{ deviceId: "built-in", label: "Built-in Microphone" }]);
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([
      { deviceId: "built-in", label: "Built-in Microphone" },
      { deviceId: "usb", label: "USB Interface" },
    ]);
  });

  it("filters native IDs out of legacy browser labels", () => {
    rememberTunerMicrophoneDevices([
      { deviceId: "cpal:1:native", label: "Native Interface" },
      { deviceId: "usb", label: "Legacy USB" },
    ]);
    expect(readRememberedBrowserTunerMicrophoneDevices()).toEqual([{ deviceId: "usb", label: "Legacy USB" }]);
  });
});
