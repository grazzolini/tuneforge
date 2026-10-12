import { useEffect, useState } from "react";

const TUNER_MICROPHONE_ACCESS_KEY = "tuneforge.tuner-microphone-access-granted";
const TUNER_INPUT_CAPTURE_BACKEND_KEY = "tuneforge.tuner-input-capture-backend";
const TUNER_MICROPHONE_DEVICES_KEY = "tuneforge.tuner-microphone-devices";
const BROWSER_TUNER_INPUT_KEY = "tuneforge.browser-tuner-input-device";
const BROWSER_TUNER_DEVICES_KEY = "tuneforge.browser-tuner-microphone-devices";
const browserInputListeners = new Set<(deviceId: string | null) => void>();

const TUNER_NATIVE_CAPTURE_ERROR_KEY = "tuneforge.tuner-native-capture-error";

export type TunerMicrophoneDevice = {
  deviceId: string;
  label: string;
};

export type TunerInputCaptureBackend = {
  backend: "native" | "web";
  detail: string | null;
};

export function rememberTunerMicrophoneAccessGranted() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(TUNER_MICROPHONE_ACCESS_KEY, "true");
}

export function rememberTunerInputCaptureBackend(backend: TunerInputCaptureBackend) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    TUNER_INPUT_CAPTURE_BACKEND_KEY,
    JSON.stringify({
      backend: backend.backend,
      detail: backend.detail,
    }),
  );
}

export function readRememberedTunerInputCaptureBackend(): TunerInputCaptureBackend | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const rawBackend = JSON.parse(window.localStorage.getItem(TUNER_INPUT_CAPTURE_BACKEND_KEY) ?? "null");
    if (!isTunerInputCaptureBackend(rawBackend)) {
      return null;
    }
    return {
      backend: rawBackend.backend,
      detail: rawBackend.detail,
    };
  } catch {
    return null;
  }
}

export function rememberTunerNativeCaptureError(error: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(TUNER_NATIVE_CAPTURE_ERROR_KEY, error);
}

export function readRememberedTunerNativeCaptureError() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(TUNER_NATIVE_CAPTURE_ERROR_KEY);
}

export function clearRememberedTunerNativeCaptureError() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(TUNER_NATIVE_CAPTURE_ERROR_KEY);
}

export function forgetTunerMicrophoneAccessGranted() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(TUNER_MICROPHONE_ACCESS_KEY);
  window.localStorage.removeItem(BROWSER_TUNER_DEVICES_KEY);
  rememberTunerMicrophoneDevices(readRememberedTunerMicrophoneDevices()
    .filter((device) => isNativeTunerInputDeviceId(device.deviceId)));
}

export function hasRememberedTunerMicrophoneAccess() {
  return (
    typeof window !== "undefined" &&
    window.localStorage.getItem(TUNER_MICROPHONE_ACCESS_KEY) === "true"
  );
}

export function rememberTunerMicrophoneDevices(devices: TunerMicrophoneDevice[]) {
  if (typeof window === "undefined") {
    return;
  }

  const visibleDevices = normalizeTunerMicrophoneDevices(devices);
  if (visibleDevices.length === 0) {
    window.localStorage.removeItem(TUNER_MICROPHONE_DEVICES_KEY);
    return;
  }
  window.localStorage.setItem(TUNER_MICROPHONE_DEVICES_KEY, JSON.stringify(visibleDevices));
}

export function readRememberedTunerMicrophoneDevices() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawDevices = JSON.parse(window.localStorage.getItem(TUNER_MICROPHONE_DEVICES_KEY) ?? "[]");
    if (!Array.isArray(rawDevices)) {
      return [];
    }
    return normalizeTunerMicrophoneDevices(rawDevices);
  } catch {
    return [];
  }
}

export function toVisibleTunerMicrophoneDevices(devices: MediaDeviceInfo[]) {
  return normalizeTunerMicrophoneDevices(
    devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
      })),
  );
}

function normalizeTunerMicrophoneDevices(devices: unknown[]) {
  const visibleDevices: TunerMicrophoneDevice[] = [];
  const seenDeviceIds = new Set<string>();

  for (const device of devices) {
    if (!isTunerMicrophoneDevice(device)) {
      continue;
    }
    const label = device.label.trim();
    const deviceId = device.deviceId;
    if (!label || !deviceId.trim() || seenDeviceIds.has(deviceId)) {
      continue;
    }
    seenDeviceIds.add(deviceId);
    visibleDevices.push({ deviceId, label });
  }

  return visibleDevices;
}

function isTunerMicrophoneDevice(device: unknown): device is TunerMicrophoneDevice {
  return (
    typeof device === "object" &&
    device !== null &&
    "deviceId" in device &&
    "label" in device &&
    typeof device.deviceId === "string" &&
    typeof device.label === "string"
  );
}

function isTunerInputCaptureBackend(device: unknown): device is TunerInputCaptureBackend {
  return (
    typeof device === "object" &&
    device !== null &&
    "backend" in device &&
    "detail" in device &&
    (device.backend === "native" || device.backend === "web") &&
    (device.detail === null || typeof device.detail === "string")
  );
}

export function supportsBrowserTunerInputSelection() {
  return typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getSupportedConstraints?.().deviceId === true;
}

export function isNativeTunerInputDeviceId(value: string | null) {
  return Boolean(value?.startsWith("cpal:") || value?.startsWith("pipewire:"));
}

export function useBrowserTunerInputDevice(legacyDeviceId: string | null) {
  const read = () => {
    const raw = window.localStorage.getItem(BROWSER_TUNER_INPUT_KEY);
    if (raw === null) return isNativeTunerInputDeviceId(legacyDeviceId) ? null : legacyDeviceId;
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" && value.trim() && !isNativeTunerInputDeviceId(value)
        ? value : null;
    } catch {
      return null;
    }
  };
  const [deviceId, setDeviceId] = useState(read);
  useEffect(() => subscribeBrowserTunerInput(setDeviceId), []);
  useEffect(() => {
    if (window.localStorage.getItem(BROWSER_TUNER_INPUT_KEY) === null) {
      setBrowserTunerInputDevice(deviceId);
    }
  }, [deviceId]);
  return [deviceId, setBrowserTunerInputDevice] as const;
}

function subscribeBrowserTunerInput(listener: (deviceId: string | null) => void) {
  browserInputListeners.add(listener);
  return () => {
    browserInputListeners.delete(listener);
  };
}

function setBrowserTunerInputDevice(value: string | null) {
  const deviceId = isNativeTunerInputDeviceId(value) ? null : value;
  window.localStorage.setItem(BROWSER_TUNER_INPUT_KEY, JSON.stringify(deviceId));
  browserInputListeners.forEach((listener) => listener(deviceId));
}

export function rememberBrowserTunerMicrophoneDevices(devices: TunerMicrophoneDevice[]) {
  window.localStorage.setItem(BROWSER_TUNER_DEVICES_KEY, JSON.stringify(
    normalizeTunerMicrophoneDevices([...devices, ...readRememberedBrowserTunerMicrophoneDevices()])
      .filter((device) => !isNativeTunerInputDeviceId(device.deviceId)),
  ));
}

export function readRememberedBrowserTunerMicrophoneDevices(): TunerMicrophoneDevice[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(BROWSER_TUNER_DEVICES_KEY) ?? "null");
    return (Array.isArray(raw) ? normalizeTunerMicrophoneDevices(raw) : readRememberedTunerMicrophoneDevices())
      .filter((device) => !isNativeTunerInputDeviceId(device.deviceId));
  } catch {
    return [];
  }
}
