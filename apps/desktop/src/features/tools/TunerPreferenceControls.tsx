import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  getNativeAudioCapabilities,
  listNativeAudioInputDevices,
} from "../../lib/nativeAudio";
import {
  MAX_TUNER_REFERENCE_HZ,
  MIN_TUNER_REFERENCE_HZ,
  normalizeTunerReferenceHz,
} from "../../lib/preferences";
import {
  forgetTunerMicrophoneAccessGranted,
  readRememberedTunerMicrophoneDevices,
  rememberTunerMicrophoneDevices,
  toVisibleTunerMicrophoneDevices,
  type TunerMicrophoneDevice,
} from "./tunerMicrophoneAccess";

type TunerPreferenceControlsProps = {
  children?: ReactNode;
  className?: string;
  inputDeviceId: string | null;
  nativeCaptureDisabled?: boolean;
  onInputDeviceChange: (value: string | null) => void;
  onReferenceHzChange: (value: number) => void;
  referenceHz: number;
  refreshToken?: number;
  systemDefaultOnly?: boolean;
};

const NATIVE_DEVICE_REFRESH_INTERVAL_MS = 5000;

export function TunerPreferenceControls({
  children,
  className,
  inputDeviceId,
  nativeCaptureDisabled = false,
  onInputDeviceChange,
  onReferenceHzChange,
  referenceHz,
  refreshToken = 0,
  systemDefaultOnly = false,
}: TunerPreferenceControlsProps) {
  const [devices, setDevices] = useState<TunerMicrophoneDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [isReferenceFocused, setIsReferenceFocused] = useState(false);
  const [referenceDraft, setReferenceDraft] = useState(formatReferenceValue(referenceHz));
  const canEnumerateDevices = canUseMediaDeviceEnumeration();

  useEffect(() => {
    if (isReferenceFocused) {
      return;
    }
    setReferenceDraft(formatReferenceValue(referenceHz));
  }, [isReferenceFocused, referenceHz]);

  useEffect(() => {
    let active = true;

    async function refreshDevices() {
      try {
        const availableDevices = await enumerateTunerInputDevices({
          includeNativeDevices: !nativeCaptureDisabled,
        });
        if (!active) {
          return;
        }
        setDevices(availableDevices);
        setDeviceError(null);
      } catch {
        if (active) {
          setDevices([]);
          setDeviceError("Microphone list unavailable.");
        }
      }
    }

    void refreshDevices();
    const refreshIntervalId = window.setInterval(
      refreshDevices,
      NATIVE_DEVICE_REFRESH_INTERVAL_MS,
    );
    if (canEnumerateDevices) {
      navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    }

    return () => {
      active = false;
      window.clearInterval(refreshIntervalId);
      if (canEnumerateDevices) {
        navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
      }
    };
  }, [canEnumerateDevices, nativeCaptureDisabled, refreshToken]);

  const selectedDeviceMissing = useMemo(
    () =>
      Boolean(
        !systemDefaultOnly &&
          inputDeviceId &&
          !devices.some((device) => device.deviceId === inputDeviceId),
      ),
    [devices, inputDeviceId, systemDefaultOnly],
  );
  const selectedInputDeviceId = systemDefaultOnly ? "" : inputDeviceId ?? "";

  function commitReferenceDraft() {
    const normalizedReferenceHz = normalizeTunerReferenceHz(referenceDraft);
    setReferenceDraft(formatReferenceValue(normalizedReferenceHz));
    onReferenceHzChange(normalizedReferenceHz);
  }

  function handleReferenceDraftChange(value: string) {
    setReferenceDraft(value);
    const parsedReferenceHz = parseValidReferenceHz(value);
    if (parsedReferenceHz !== null) {
      onReferenceHzChange(parsedReferenceHz);
    }
  }

  return (
    <div className={["tuner-preferences", className].filter(Boolean).join(" ")}>
      <label className="tuner-field">
        <span>Microphone source</span>
        <select
          aria-label="Microphone source"
          onChange={(event) => {
            const nextValue = event.target.value || null;
            if (systemDefaultOnly && nextValue) {
              return;
            }
            onInputDeviceChange(nextValue);
          }}
          value={selectedInputDeviceId}
        >
          <option value="">System Default</option>
          {selectedDeviceMissing ? <option value={inputDeviceId ?? ""}>Saved microphone</option> : null}
          {devices.map((device) => (
            <option
              disabled={systemDefaultOnly}
              key={device.deviceId || device.label}
              value={device.deviceId}
            >
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <label className="tuner-field">
        <span>A4 reference tuning</span>
        <input
          aria-label="A4 reference tuning"
          inputMode="decimal"
          max={MAX_TUNER_REFERENCE_HZ}
          min={MIN_TUNER_REFERENCE_HZ}
          onBlur={() => {
            setIsReferenceFocused(false);
            commitReferenceDraft();
          }}
          onChange={(event) => handleReferenceDraftChange(event.target.value)}
          onFocus={() => setIsReferenceFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitReferenceDraft();
              event.currentTarget.blur();
            }
          }}
          step="0.1"
          type="number"
          value={referenceDraft}
        />
      </label>

      {children}

      {deviceError ? <p className="tuner-preferences__status">{deviceError}</p> : null}
    </div>
  );
}

function canUseMediaDeviceEnumeration() {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.enumerateDevices === "function";
}

async function enumerateTunerInputDevices({
  includeNativeDevices,
}: {
  includeNativeDevices: boolean;
}) {
  if (includeNativeDevices) {
    const nativeDevices = await enumerateNativeAudioInputDevices();
    if (nativeDevices.length > 0) {
      rememberTunerMicrophoneDevices(nativeDevices);
      return nativeDevices;
    }
  }
  return enumerateAudioInputDevices();
}

async function enumerateNativeAudioInputDevices() {
  try {
    const capabilities = await getNativeAudioCapabilities();
    if (!capabilities.micCaptureSupported) {
      return [];
    }
    const deviceState = await listNativeAudioInputDevices();
    if (!deviceState.supported) {
      return [];
    }
    return deviceState.devices
      .map((device) => ({
        deviceId: device.id,
        label: device.isDefault ? `${device.label} (Default)` : device.label,
      }))
      .filter((device) => device.label.trim());
  } catch {
    return [];
  }
}

async function enumerateAudioInputDevices() {
  if (!canUseMediaDeviceEnumeration()) {
    return readRememberedTunerMicrophoneDevices();
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const visibleDevices = toVisibleTunerMicrophoneDevices(devices);
  if (visibleDevices.length > 0) {
    rememberTunerMicrophoneDevices(visibleDevices);
    return visibleDevices;
  }

  if ((await getMicrophonePermissionState()) === "denied") {
    forgetTunerMicrophoneAccessGranted();
    return [];
  }

  return readRememberedTunerMicrophoneDevices();
}

async function getMicrophonePermissionState() {
  if (typeof navigator === "undefined" || typeof navigator.permissions?.query !== "function") {
    return null;
  }

  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    return null;
  }
}

function formatReferenceValue(referenceHz: number) {
  return Number.isInteger(referenceHz) ? referenceHz.toFixed(0) : referenceHz.toFixed(1);
}

function parseValidReferenceHz(value: string) {
  const numericValue = Number(value);
  if (
    !Number.isFinite(numericValue) ||
    numericValue < MIN_TUNER_REFERENCE_HZ ||
    numericValue > MAX_TUNER_REFERENCE_HZ
  ) {
    return null;
  }
  return normalizeTunerReferenceHz(numericValue);
}
