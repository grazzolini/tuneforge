const TUNER_MICROPHONE_ACCESS_KEY = "tuneforge.tuner-microphone-access-granted";
const TUNER_MICROPHONE_DEVICES_KEY = "tuneforge.tuner-microphone-devices";

export type TunerMicrophoneDevice = {
  deviceId: string;
  label: string;
};

export function rememberTunerMicrophoneAccessGranted() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(TUNER_MICROPHONE_ACCESS_KEY, "true");
}

export function forgetTunerMicrophoneAccessGranted() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(TUNER_MICROPHONE_ACCESS_KEY);
  window.localStorage.removeItem(TUNER_MICROPHONE_DEVICES_KEY);
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
    const deviceId = device.deviceId.trim();
    if (!label || seenDeviceIds.has(deviceId)) {
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
