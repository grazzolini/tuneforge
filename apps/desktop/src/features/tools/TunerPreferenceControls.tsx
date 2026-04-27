import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  onInputDeviceChange: (value: string | null) => void;
  onReferenceHzChange: (value: number) => void;
  referenceHz: number;
  refreshToken?: number;
};

export function TunerPreferenceControls({
  children,
  className,
  inputDeviceId,
  onInputDeviceChange,
  onReferenceHzChange,
  referenceHz,
  refreshToken = 0,
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
    if (!canEnumerateDevices) {
      setDevices([]);
      setDeviceError("Microphone list unavailable.");
      return undefined;
    }

    let active = true;

    async function refreshDevices() {
      try {
        const availableDevices = await enumerateAudioInputDevices();
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
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);

    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [canEnumerateDevices, refreshToken]);

  const selectedDeviceMissing = useMemo(
    () => Boolean(inputDeviceId && !devices.some((device) => device.deviceId === inputDeviceId)),
    [devices, inputDeviceId],
  );

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
          onChange={(event) => onInputDeviceChange(event.target.value || null)}
          value={inputDeviceId ?? ""}
        >
          <option value="">System Default</option>
          {selectedDeviceMissing ? <option value={inputDeviceId ?? ""}>Saved microphone</option> : null}
          {devices.map((device) => (
            <option key={device.deviceId || device.label} value={device.deviceId}>
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

async function enumerateAudioInputDevices() {
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
