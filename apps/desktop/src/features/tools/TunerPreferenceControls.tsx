import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getNativeAudioCapabilities,
  listNativeAudioInputDevices,
} from "../../lib/nativeAudio";
import {
  MAX_TUNER_REFERENCE_HZ,
  MIN_TUNER_REFERENCE_HZ,
  normalizeTunerReferenceHz,
  type TunerVisualMode,
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
  clearDevicesWhenSystemDefaultOnly?: boolean;
  inputDeviceId: string | null;
  nativeCaptureDisabled?: boolean;
  onInputDeviceChange: (value: string | null) => void;
  onReferenceHzChange: (value: number) => void;
  onVisualModeChange?: (value: TunerVisualMode) => void;
  referenceHz: number;
  refreshToken?: number;
  systemDefaultOnly?: boolean;
  visualMode?: TunerVisualMode;
  visualModeAriaLabel?: string;
  visualModeLabel?: string;
};

export function TunerPreferenceControls({
  children,
  className,
  clearDevicesWhenSystemDefaultOnly = false,
  inputDeviceId,
  nativeCaptureDisabled = false,
  onInputDeviceChange,
  onReferenceHzChange,
  onVisualModeChange,
  referenceHz,
  refreshToken = 0,
  systemDefaultOnly = false,
  visualMode,
  visualModeAriaLabel = "Default tuner",
  visualModeLabel = "Default tuner",
}: TunerPreferenceControlsProps) {
  const [devices, setDevices] = useState<TunerMicrophoneDevice[]>(() =>
    systemDefaultOnly ? [] : readRememberedTunerMicrophoneDevices(),
  );
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [isReferenceFocused, setIsReferenceFocused] = useState(false);
  const [referenceDraft, setReferenceDraft] = useState(formatReferenceValue(referenceHz));
  const canEnumerateDevices = canUseMediaDeviceEnumeration();
  const isMountedRef = useRef(true);
  const lastRefreshTokenRef = useRef(refreshToken);
  const pendingRefreshRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshRequestIdRef = useRef(0);

  useEffect(() => {
    if (isReferenceFocused) {
      return;
    }
    setReferenceDraft(formatReferenceValue(referenceHz));
  }, [isReferenceFocused, referenceHz]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      refreshRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    pendingRefreshRef.current = false;
    refreshPromiseRef.current = null;
    refreshRequestIdRef.current += 1;
    setDevices(readRememberedTunerMicrophoneDevices());
    setDeviceError(null);
  }, [nativeCaptureDisabled]);

  useEffect(() => {
    if (systemDefaultOnly) {
      setDevices((currentDevices) =>
        clearDevicesWhenSystemDefaultOnly
          ? []
          : currentDevices.filter((device) => !device.deviceId.startsWith("cpal:")),
      );
      setDeviceError(null);
      refreshRequestIdRef.current += 1;
    }
  }, [clearDevicesWhenSystemDefaultOnly, systemDefaultOnly]);

  const refreshDevices = useCallback(({ queueIfBusy = false } = {}) => {
    if (systemDefaultOnly) {
      return Promise.resolve();
    }
    if (refreshPromiseRef.current) {
      if (queueIfBusy) {
        pendingRefreshRef.current = true;
      }
      return refreshPromiseRef.current;
    }

    const refreshPromise = (async () => {
      while (isMountedRef.current) {
        pendingRefreshRef.current = false;
        const requestId = refreshRequestIdRef.current + 1;
        refreshRequestIdRef.current = requestId;

        try {
          const availableDevices = await enumerateTunerInputDevices({
            includeNativeDevices: !nativeCaptureDisabled,
          });
          if (!isMountedRef.current || refreshRequestIdRef.current !== requestId) {
            return;
          }
          setDevices(availableDevices);
          setDeviceError(null);
        } catch {
          if (isMountedRef.current && refreshRequestIdRef.current === requestId) {
            setDevices([]);
            setDeviceError("Microphone list unavailable.");
          }
        }

        if (!pendingRefreshRef.current) {
          return;
        }
      }
    })();

    refreshPromiseRef.current = refreshPromise;
    void refreshPromise.finally(() => {
      if (refreshPromiseRef.current === refreshPromise) {
        refreshPromiseRef.current = null;
      }
    });
    return refreshPromise;
  }, [nativeCaptureDisabled, systemDefaultOnly]);

  useEffect(() => {
    if (lastRefreshTokenRef.current === refreshToken) {
      return;
    }
    lastRefreshTokenRef.current = refreshToken;
    void refreshDevices({ queueIfBusy: true });
  }, [refreshDevices, refreshToken]);

  useEffect(() => {
    function refreshOnDeviceChange() {
      void refreshDevices({ queueIfBusy: true });
    }
    if (canEnumerateDevices) {
      navigator.mediaDevices?.addEventListener?.("devicechange", refreshOnDeviceChange);
    }

    return () => {
      if (canEnumerateDevices) {
        navigator.mediaDevices?.removeEventListener?.("devicechange", refreshOnDeviceChange);
      }
    };
  }, [canEnumerateDevices, refreshDevices]);

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

  function handleInputDeviceRefreshRequest() {
    if (!systemDefaultOnly) {
      void refreshDevices();
    }
  }

  return (
    <div className={["tuner-preferences", className].filter(Boolean).join(" ")}>
      <label className="tuner-field">
        <span>Microphone source</span>
        <select
          aria-label="Microphone source"
          onFocus={handleInputDeviceRefreshRequest}
          onChange={(event) => {
            const nextValue = event.target.value || null;
            if (systemDefaultOnly && nextValue) {
              return;
            }
            onInputDeviceChange(nextValue);
          }}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "ArrowDown" || event.key === "Enter") {
              handleInputDeviceRefreshRequest();
            }
          }}
          onPointerDown={handleInputDeviceRefreshRequest}
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

      {visualMode && onVisualModeChange ? (
        <label className="tuner-field">
          <span>{visualModeLabel}</span>
          <select
            aria-label={visualModeAriaLabel}
            onChange={(event) => onVisualModeChange(event.target.value as TunerVisualMode)}
            value={visualMode}
          >
            <option value="wide-arc">Wide Arc</option>
            <option value="simple">Simple Meter</option>
          </select>
        </label>
      ) : null}

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
