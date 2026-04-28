import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useStableCallback } from "../../lib/useStableCallback";
import { usePreferences } from "../../lib/preferences";
import { MetronomePage } from "./MetronomePage";
import { TunerPreferenceControls } from "./TunerPreferenceControls";
import {
  SimpleTunerMeter,
  type TunerVisualMode,
  WideArcTunerMeter,
} from "./TunerMeters";
import { getTunerStatusLabel } from "./tunerMeterState";
import {
  createStabilizedTunerReadingState,
  updateStabilizedTunerReading,
} from "./tunerReadingSmoothing";
import {
  forgetTunerMicrophoneAccessGranted,
  rememberTunerMicrophoneDevices,
  rememberTunerMicrophoneAccessGranted,
  toVisibleTunerMicrophoneDevices,
} from "./tunerMicrophoneAccess";
import {
  analyzeTunerBuffer,
  calculateTunerInputLevel,
  type TunerPitchReading,
} from "./tunerPitch";

type TunerStatus = "idle" | "starting" | "listening" | "unsupported" | "error";
type ToolId = "tuner" | "metronome";

type AudioContextConstructor = typeof AudioContext;

export function ToolsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTool = readToolId(searchParams);

  function handleSelectTool(tool: ToolId) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (tool === "tuner") {
      nextSearchParams.delete("tool");
      nextSearchParams.delete("bpm");
      nextSearchParams.delete("followPlayback");
      nextSearchParams.delete("projectId");
    } else {
      nextSearchParams.set("tool", "metronome");
    }
    setSearchParams(nextSearchParams);
  }

  return (
    <section className="screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Tools</p>
          <h1>Tools</h1>
          <p className="screen__subtitle">Local musician utilities.</p>
        </div>
      </div>

      <div className="project-workspace-tabs" role="tablist" aria-label="Tools">
        {[
          { id: "tuner", label: "Chromatic Tuner" },
          { id: "metronome", label: "Metronome" },
        ].map((tool) => (
          <button
            key={tool.id}
            aria-selected={activeTool === tool.id}
            className={`project-workspace-tabs__button${
              activeTool === tool.id ? " project-workspace-tabs__button--active" : ""
            }`}
            onClick={() => handleSelectTool(tool.id as ToolId)}
            role="tab"
            type="button"
          >
            {tool.label}
          </button>
        ))}
      </div>

      {activeTool === "tuner" ? <ChromaticTunerPage /> : <MetronomePage />}
    </section>
  );
}

function readToolId(searchParams: URLSearchParams): ToolId {
  return searchParams.get("tool") === "metronome" ? "metronome" : "tuner";
}

function ChromaticTunerPage() {
  const {
    defaultTunerInputDeviceId,
    defaultTunerReferenceHz,
    setDefaultTunerInputDeviceId,
    setDefaultTunerReferenceHz,
  } = usePreferences();
  const [status, setStatus] = useState<TunerStatus>(() =>
    canUseTunerCapture() ? "idle" : "unsupported",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [reading, setReading] = useState<TunerPitchReading | null>(null);
  const [deviceRefreshToken, setDeviceRefreshToken] = useState(0);
  const [visualMode, setVisualMode] = useState<TunerVisualMode>("simple");
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameIdRef = useRef<number | null>(null);
  const inputDeviceIdRef = useRef(defaultTunerInputDeviceId);
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const referenceHzRef = useRef(defaultTunerReferenceHz);
  const requestIdRef = useRef(0);
  const readingStabilizerRef = useRef(createStabilizedTunerReadingState());
  const statusRef = useRef(status);
  const streamRef = useRef<MediaStream | null>(null);
  const timeDomainDataRef = useRef<Float32Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    inputDeviceIdRef.current = defaultTunerInputDeviceId;
  }, [defaultTunerInputDeviceId]);

  useEffect(() => {
    referenceHzRef.current = defaultTunerReferenceHz;
  }, [defaultTunerReferenceHz]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const releaseCapture = useStableCallback(function releaseCapture() {
    if (frameIdRef.current !== null) {
      window.cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
    }

    try {
      mediaSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
    } catch {
      // Audio nodes can already be disconnected during rapid source switches.
    }
    mediaSourceRef.current = null;
    analyserRef.current = null;
    timeDomainDataRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
  });

  const resetTunerDisplay = useStableCallback(function resetTunerDisplay() {
    readingStabilizerRef.current = createStabilizedTunerReadingState();
    setInputLevel(0);
    setReading(null);
  });

  const readTunerFrame = useStableCallback(function readTunerFrame(timestampMs?: number) {
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) {
      return;
    }

    if (!timeDomainDataRef.current || timeDomainDataRef.current.length !== analyser.fftSize) {
      timeDomainDataRef.current = new Float32Array(analyser.fftSize);
    }

    analyser.getFloatTimeDomainData(timeDomainDataRef.current);
    setInputLevel(calculateTunerInputLevel(timeDomainDataRef.current));
    const rawReading = analyzeTunerBuffer(
      timeDomainDataRef.current,
      audioContext.sampleRate,
      referenceHzRef.current,
    );
    const stabilizedState = updateStabilizedTunerReading(
      readingStabilizerRef.current,
      rawReading,
      timestampMs ?? getCurrentTunerTimeMs(),
    );
    readingStabilizerRef.current = stabilizedState;
    setReading(stabilizedState.displayedReading);
    frameIdRef.current = window.requestAnimationFrame(readTunerFrame);
  });

  const startTuner = useStableCallback(async function startTuner(nextDeviceId?: string | null) {
    const AudioContextCtor = getAudioContextConstructor();
    const mediaDevices = getMediaDevices();
    if (!AudioContextCtor || !mediaDevices) {
      setStatus("unsupported");
      setErrorMessage("Microphone capture is unavailable.");
      return;
    }

    releaseCapture();
    setErrorMessage(null);
    resetTunerDisplay();
    setStatus("starting");

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const stream = await mediaDevices.getUserMedia(
        createAudioConstraints(nextDeviceId ?? inputDeviceIdRef.current),
      );
      if (requestIdRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const audioContext = new AudioContextCtor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.12;

      const mediaSource = audioContext.createMediaStreamSource(stream);
      mediaSource.connect(analyser);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      mediaSourceRef.current = mediaSource;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      if (requestIdRef.current !== requestId) {
        releaseCapture();
        return;
      }

      rememberTunerMicrophoneAccessGranted();
      await rememberVisibleAudioInputDevices(mediaDevices);
      setDeviceRefreshToken(Date.now());
      setStatus("listening");
      readTunerFrame();
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      releaseCapture();
      if (isMicrophonePermissionError(error)) {
        forgetTunerMicrophoneAccessGranted();
      }
      setStatus("error");
      setErrorMessage(captureErrorMessage(error));
    }
  });

  const stopTuner = useStableCallback(function stopTuner() {
    requestIdRef.current += 1;
    releaseCapture();
    setErrorMessage(null);
    resetTunerDisplay();
    setStatus(canUseTunerCapture() ? "idle" : "unsupported");
  });

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      releaseCapture();
    },
    [releaseCapture],
  );

  const handleInputDeviceChange = useStableCallback(function handleInputDeviceChange(
    value: string | null,
  ) {
    inputDeviceIdRef.current = value;
    setDefaultTunerInputDeviceId(value);
    if (statusRef.current === "listening") {
      void startTuner(value);
    }
  });

  const handleReferenceHzChange = useStableCallback(function handleReferenceHzChange(
    value: number,
  ) {
    referenceHzRef.current = value;
    resetTunerDisplay();
    setDefaultTunerReferenceHz(value);
  });

  const isBusy = status === "starting";
  const isListening = status === "listening";
  const canStart = canUseTunerCapture() && !isBusy && !isListening;
  const statusText = headerStatusLabel(status, reading);

  return (
    <div className="tuner-shell">
      <div className="panel tuner-panel">
        <TunerHeader
          canStart={canStart}
          isBusy={isBusy}
          isListening={isListening}
          onStart={() => void startTuner()}
          onStop={stopTuner}
          statusText={statusText}
        />

        <TunerPreferenceControls
          className="tuner-preferences--with-mode"
          inputDeviceId={defaultTunerInputDeviceId}
          onInputDeviceChange={handleInputDeviceChange}
          onReferenceHzChange={handleReferenceHzChange}
          referenceHz={defaultTunerReferenceHz}
          refreshToken={deviceRefreshToken}
        >
          <label className="tuner-field">
            <span>Visual mode</span>
            <select
              aria-label="Tuner visual mode"
              onChange={(event) => setVisualMode(event.target.value as TunerVisualMode)}
              value={visualMode}
            >
              <option value="simple">Simple Meter</option>
              <option value="wide-arc">Wide Arc</option>
            </select>
          </label>
        </TunerPreferenceControls>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        {visualMode === "simple" ? (
          <SimpleTunerMeter
            inputLevel={inputLevel}
            reading={reading}
            referenceHz={defaultTunerReferenceHz}
          />
        ) : (
          <WideArcTunerMeter
            inputLevel={inputLevel}
            reading={reading}
            referenceHz={defaultTunerReferenceHz}
          />
        )}
      </div>
    </div>
  );
}

function TunerHeader({
  canStart,
  isBusy,
  isListening,
  onStart,
  onStop,
  statusText,
}: {
  canStart: boolean;
  isBusy: boolean;
  isListening: boolean;
  onStart: () => void;
  onStop: () => void;
  statusText: string;
}) {
  return (
    <div className="tuner-header">
      <div>
        <h2>Chromatic Tuner</h2>
        <p className="subpanel__copy">{statusText}</p>
      </div>
      <div className="button-row">
        {isListening || isBusy ? (
          <button className="button button--ghost" onClick={onStop} type="button">
            Stop
          </button>
        ) : (
          <button
            className="button button--primary"
            disabled={!canStart}
            onClick={onStart}
            type="button"
          >
            Start
          </button>
        )}
      </div>
    </div>
  );
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (
    window.AudioContext ??
    (window as Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext ??
    null
  );
}

function getMediaDevices() {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return null;
  }
  return navigator.mediaDevices;
}

function canUseTunerCapture() {
  return Boolean(getAudioContextConstructor() && getMediaDevices());
}

async function rememberVisibleAudioInputDevices(mediaDevices: MediaDevices) {
  if (typeof mediaDevices.enumerateDevices !== "function") {
    return;
  }
  try {
    const devices = await mediaDevices.enumerateDevices();
    rememberTunerMicrophoneDevices(toVisibleTunerMicrophoneDevices(devices));
  } catch {
    // Device labels are a convenience cache; tuner capture should continue without them.
  }
}

function createAudioConstraints(inputDeviceId: string | null): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
  };
  if (inputDeviceId) {
    audio.deviceId = { exact: inputDeviceId };
  }
  return { audio, video: false };
}

function captureErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (isMicrophonePermissionError(error)) {
      return "Microphone permission was denied.";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "Selected microphone was not found.";
    }
  }
  return error instanceof Error ? error.message : "Could not start microphone capture.";
}

function isMicrophonePermissionError(error: unknown) {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function getCurrentTunerTimeMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function headerStatusLabel(status: TunerStatus, reading: TunerPitchReading | null) {
  if (status === "error" || status === "unsupported") return "Error";
  if (status === "starting") return "Listening";
  if (status === "listening") return getTunerStatusLabel(reading);
  return "Ready";
}
