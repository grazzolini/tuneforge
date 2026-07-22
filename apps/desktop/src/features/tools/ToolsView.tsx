import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getNativeAudioCapabilities,
  getNativeAudioInputPermissionStatus,
  getNativeAudioInputState,
  isAndroidRuntime,
  isWebAudioBackendForced,
  listenNativeAudioInputFrames,
  listenNativeAudioInputState,
  requestNativeAudioInputPermission,
  startNativeAudioInput,
  stopNativeAudioInput,
  type NativeAudioCapabilities,
  type NativeAudioInputFrame,
  type NativeAudioInputState,
} from "../../lib/nativeAudio";
import { useStableCallback } from "../../lib/useStableCallback";
import {
  getPowerInhibitionVersion,
  refreshPowerInhibitionStatus,
  subscribePowerInhibition,
  tunerPowerProtectionMessage,
} from "../../lib/powerInhibition";
import {
  usePowerInhibitionActivity,
  useScreenWakeLock,
} from "../../lib/useScreenWakeLock";
import { usePreferences, type TunerVisualMode } from "../../lib/preferences";
import {
  activateWebAudioContext,
  getWebAudioContextConstructor,
} from "../../lib/webAudio";
import { MetronomePage } from "./MetronomePage";
import {
  clampSystemInputVolume,
  getSystemDefaultInputVolume,
  setSystemDefaultInputVolume,
  type SystemDefaultInputVolume,
} from "./systemInputVolume";
import { TunerPreferenceControls } from "./TunerPreferenceControls";
import {
  SimpleTunerMeter,
  WideArcTunerMeter,
} from "./TunerMeters";
import {
  createStabilizedTunerReadingState,
  updateStabilizedTunerReading,
} from "./tunerReadingSmoothing";
import {
  clearRememberedTunerNativeCaptureError,
  forgetTunerMicrophoneAccessGranted,
  rememberTunerInputCaptureBackend,
  rememberTunerMicrophoneDevices,
  rememberTunerMicrophoneAccessGranted,
  rememberTunerNativeCaptureError,
  toVisibleTunerMicrophoneDevices,
} from "./tunerMicrophoneAccess";
import {
  analyzeTunerBuffer,
  calculateTunerInputLevel,
  type TunerPitchReading,
} from "./tunerPitch";
import { ChordDictionaryPage } from "./ChordDictionaryPage";
import { nextToolSearchParams, type ToolId } from "./toolRouting";

const SYSTEM_INPUT_VOLUME_COMMIT_DELAY_MS = 180;

type TunerStatus = "idle" | "starting" | "listening" | "unsupported" | "error";
type CaptureBackend = "native" | "web";

export function ToolsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTool = readToolId(searchParams);

  function handleSelectTool(tool: ToolId) {
    setSearchParams(nextToolSearchParams(searchParams, tool));
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
          { id: "chord-dictionary", label: "Chord Dictionary" },
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

      {activeTool === "tuner" ? (
        <ChromaticTunerPage />
      ) : activeTool === "metronome" ? (
        <MetronomePage />
      ) : (
        <ChordDictionaryPage />
      )}
    </section>
  );
}

function readToolId(searchParams: URLSearchParams): ToolId {
  const tool = searchParams.get("tool");
  if (tool === "metronome" || tool === "chord-dictionary") {
    return tool;
  }
  return "tuner";
}

function ChromaticTunerPage() {
  const {
    defaultTunerInputDeviceId,
    defaultTunerReferenceHz,
    defaultTunerVisualMode,
    setDefaultTunerInputDeviceId,
    setDefaultTunerReferenceHz,
    setDefaultTunerVisualMode,
  } = usePreferences();
  const [status, setStatus] = useState<TunerStatus>(() =>
    canUseTunerCapture(null) ? "idle" : "unsupported",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [activeCaptureBackend, setActiveCaptureBackend] = useState<CaptureBackend | null>(null);
  const [nativeAudioCapabilities, setNativeAudioCapabilities] =
    useState<NativeAudioCapabilities | null>(null);
  const webAudioForced = isWebAudioBackendForced();
  const androidRuntime = isAndroidRuntime() || nativeAudioCapabilities?.platform === "android";
  const [reading, setReading] = useState<TunerPitchReading | null>(null);
  const [deviceRefreshToken, setDeviceRefreshToken] = useState(0);
  const [systemInputVolumeRefreshToken, setSystemInputVolumeRefreshToken] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameIdRef = useRef<number | null>(null);
  const inputDeviceIdRef = useRef(defaultTunerInputDeviceId);
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nativeCaptureActiveRef = useRef(false);
  const nativeCaptureGenerationRef = useRef<number | null>(null);
  const nativeInputUnlistenRef = useRef<(() => void) | null>(null);
  const nativeStateUnlistenRef = useRef<(() => void) | null>(null);
  const referenceHzRef = useRef(defaultTunerReferenceHz);
  const requestIdRef = useRef(0);
  const readingStabilizerRef = useRef(createStabilizedTunerReadingState());
  const statusRef = useRef(status);
  const streamRef = useRef<MediaStream | null>(null);
  const webTrackEndCleanupRef = useRef<(() => void) | null>(null);
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

  useEffect(() => {
    let active = true;

    async function refreshNativeAudioCapabilities() {
      if (webAudioForced) {
        setNativeAudioCapabilities(null);
        if (statusRef.current === "unsupported" && canUseTunerCapture(null)) {
          setStatus("idle");
          setErrorMessage(null);
        }
        return;
      }

      try {
        const capabilities = await getNativeAudioCapabilities();
        if (!active) {
          return;
        }
        setNativeAudioCapabilities(capabilities);
        if (capabilities.micCaptureSupported && statusRef.current === "unsupported") {
          setStatus("idle");
          setErrorMessage(null);
        }
      } catch {
        if (active) {
          setNativeAudioCapabilities(null);
        }
      }
    }

    void refreshNativeAudioCapabilities();
    return () => {
      active = false;
    };
  }, [webAudioForced]);

  const releaseCapture = useStableCallback(function releaseCapture() {
    if (frameIdRef.current !== null) {
      window.cancelAnimationFrame(frameIdRef.current);
      frameIdRef.current = null;
    }
    setActiveCaptureBackend(null);

    nativeInputUnlistenRef.current?.();
    nativeInputUnlistenRef.current = null;
    nativeStateUnlistenRef.current?.();
    nativeStateUnlistenRef.current = null;
    nativeCaptureGenerationRef.current = null;
    if (nativeCaptureActiveRef.current) {
      nativeCaptureActiveRef.current = false;
      void stopNativeAudioInput().catch(() => undefined);
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

    webTrackEndCleanupRef.current?.();
    webTrackEndCleanupRef.current = null;
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

  const processTunerSamples = useStableCallback(function processTunerSamples(
    samples: Float32Array<ArrayBufferLike>,
    sampleRate: number,
    inputLevel: number,
    timestampMs: number,
  ) {
    setInputLevel(inputLevel);
    const rawReading = analyzeTunerBuffer(samples, sampleRate, referenceHzRef.current);
    const stabilizedState = updateStabilizedTunerReading(
      readingStabilizerRef.current,
      rawReading,
      timestampMs,
    );
    readingStabilizerRef.current = stabilizedState;
    setReading(stabilizedState.displayedReading);
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
    processTunerSamples(
      timeDomainDataRef.current,
      audioContext.sampleRate,
      calculateTunerInputLevel(timeDomainDataRef.current),
      timestampMs ?? getCurrentTunerTimeMs(),
    );
    frameIdRef.current = window.requestAnimationFrame(readTunerFrame);
  });

  const resolveNativeAudioCapabilities = useStableCallback(async function resolveNativeAudioCapabilities() {
    if (webAudioForced) {
      setNativeAudioCapabilities(null);
      return null;
    }
    if (nativeAudioCapabilities) {
      return nativeAudioCapabilities;
    }
    try {
      const capabilities = await getNativeAudioCapabilities();
      setNativeAudioCapabilities(capabilities);
      return capabilities;
    } catch {
      setNativeAudioCapabilities(null);
      return null;
    }
  });

  const handleNativeInputFrame = useStableCallback(function handleNativeInputFrame(
    frame: NativeAudioInputFrame,
  ) {
    if (
      !nativeCaptureActiveRef.current ||
      frame.captureGeneration !== nativeCaptureGenerationRef.current ||
      frame.sampleRate <= 0 ||
      frame.samples.length === 0
    ) {
      return;
    }
    processTunerSamples(
      new Float32Array(frame.samples),
      frame.sampleRate,
      frame.inputLevel,
      frame.timestampMs,
    );
  });

  const handleNativeInputState = useStableCallback(function handleNativeInputState(
    inputState: NativeAudioInputState,
  ) {
    if (
      inputState.captureGeneration !== nativeCaptureGenerationRef.current ||
      inputState.active ||
      !inputState.error
    ) {
      return;
    }
    requestIdRef.current += 1;
    const message = captureStateErrorMessage(inputState);
    rememberTunerNativeCaptureError(message);
    releaseCapture();
    resetTunerDisplay();
    setStatus("error");
    setErrorMessage(message);
  });

  const startNativeTuner = useStableCallback(async function startNativeTuner(
    deviceId: string | null,
    requestId: number,
    backend: string | null,
    requireAndroidPermission: boolean,
  ) {
    const [unlistenFrames, unlistenState] = await Promise.all([
      listenNativeAudioInputFrames(handleNativeInputFrame),
      listenNativeAudioInputState(handleNativeInputState),
    ]);
    if (requestIdRef.current !== requestId) {
      unlistenFrames();
      unlistenState();
      return;
    }
    nativeInputUnlistenRef.current = unlistenFrames;
    nativeStateUnlistenRef.current = unlistenState;
    nativeCaptureActiveRef.current = true;
    if (requireAndroidPermission) {
      let permission = await getNativeAudioInputPermissionStatus();
      if (permission.state === "prompt" || permission.state === "denied") {
        permission = await requestNativeAudioInputPermission();
      }
      while (requestIdRef.current === requestId && permission.state === "prompting") {
        await waitForPermissionPoll();
        permission = await getNativeAudioInputPermissionStatus();
      }
      if (permission.error || permission.state !== "granted") {
        throw new Error(captureSafeErrorMessage(permission.error));
      }
    }
    let inputState = await startNativeAudioInput({ deviceId });
    nativeCaptureGenerationRef.current = inputState.captureGeneration;
    while (
      requestIdRef.current === requestId &&
      !inputState.active &&
      !inputState.error &&
      (inputState.permissionState === "prompt" || inputState.permissionState === "prompting")
    ) {
      await waitForPermissionPoll();
      inputState = await getNativeAudioInputState();
      nativeCaptureGenerationRef.current = inputState.captureGeneration;
      if (inputState.permissionState === "granted" && !inputState.active) {
        inputState = await startNativeAudioInput({ deviceId });
        nativeCaptureGenerationRef.current = inputState.captureGeneration;
      }
    }
    nativeCaptureActiveRef.current = inputState.active;
    if (requestIdRef.current !== requestId) {
      releaseCapture();
      return;
    }
    if (!inputState.active || inputState.capturePath === "none") {
      throw new Error(captureStateErrorMessage(inputState));
    }
    if (inputState.deviceId) {
      inputDeviceIdRef.current = deviceId;
    }
    rememberTunerMicrophoneAccessGranted();
    rememberTunerInputCaptureBackend({
      backend: "native",
      detail: backend,
    });
    clearRememberedTunerNativeCaptureError();
    setActiveCaptureBackend("native");
    setDeviceRefreshToken(Date.now());
    setStatus("listening");
  });

  const startWebTuner = useStableCallback(async function startWebTuner(
    _nextDeviceId: string | null,
    requestId: number,
  ) {
    const AudioContextCtor = getWebAudioContextConstructor();
    const mediaDevices = getMediaDevices();
    if (!AudioContextCtor || !mediaDevices) {
      throw new Error("Microphone capture is unavailable.");
    }

    const stream = await mediaDevices.getUserMedia(createAudioConstraints());
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

    const handleTrackEnded = () => {
      if (requestIdRef.current !== requestId || streamRef.current !== stream) {
        return;
      }
      requestIdRef.current += 1;
      releaseCapture();
      resetTunerDisplay();
      setStatus("error");
      setErrorMessage("Microphone capture ended. Choose Retry to start it again.");
    };
    const tracks = stream.getTracks();
    tracks.forEach((track) => track.addEventListener?.("ended", handleTrackEnded));
    webTrackEndCleanupRef.current = () => {
      tracks.forEach((track) => track.removeEventListener?.("ended", handleTrackEnded));
    };

    await activateWebAudioContext(audioContext);

    if (requestIdRef.current !== requestId) {
      releaseCapture();
      return;
    }

    rememberTunerMicrophoneAccessGranted();
    rememberTunerInputCaptureBackend({ backend: "web", detail: null });
    await rememberVisibleAudioInputDevices(mediaDevices);
    setActiveCaptureBackend("web");
    setDeviceRefreshToken(Date.now());
    setStatus("listening");
    readTunerFrame();
  });

  const startTuner = useStableCallback(async function startTuner(nextDeviceId?: string | null) {
    releaseCapture();
    setErrorMessage(null);
    resetTunerDisplay();
    setSystemInputVolumeRefreshToken(Date.now());
    setStatus("starting");

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const selectedDeviceId = nextDeviceId ?? inputDeviceIdRef.current;
    const selectedNativeDevice = isNativeAudioInputDeviceId(selectedDeviceId);
    const nativeCapabilities = await resolveNativeAudioCapabilities();
    const androidNativeRequired =
      isAndroidRuntime() || nativeCapabilities?.platform === "android";

    if (!webAudioForced && nativeCapabilities?.micCaptureSupported) {
      try {
        await startNativeTuner(
          selectedDeviceId,
          requestId,
          nativeCapabilities.backend,
          androidNativeRequired,
        );
        return;
      } catch (error) {
        rememberTunerNativeCaptureError(captureErrorMessage(error));
        if (requestIdRef.current !== requestId) {
          return;
        }
        releaseCapture();
        if (androidNativeRequired) {
          setStatus("error");
          setErrorMessage(captureErrorMessage(error));
          return;
        }
      }
    } else if (!webAudioForced && androidNativeRequired) {
      const message = "Native Android microphone capture is unavailable.";
      rememberTunerNativeCaptureError(message);
      setStatus("error");
      setErrorMessage(message);
      return;
    } else if (!webAudioForced && selectedNativeDevice) {
      rememberTunerNativeCaptureError(
        "Selected microphone requires native input capture, but native capture is unavailable.",
      );
    }

    try {
      await startWebTuner(selectedDeviceId, requestId);
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
    setStatus(
      canUseTunerCapture(webAudioForced ? null : nativeAudioCapabilities)
        ? "idle"
        : "unsupported",
    );
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

  const handleVisualModeChange = useStableCallback(function handleVisualModeChange(
    value: TunerVisualMode,
  ) {
    setDefaultTunerVisualMode(value);
  });

  const isBusy = status === "starting";
  const isListening = status === "listening";
  const webTunerListening = isListening && activeCaptureBackend === "web";
  useSyncExternalStore(
    subscribePowerInhibition,
    getPowerInhibitionVersion,
    getPowerInhibitionVersion,
  );
  usePowerInhibitionActivity("tuner-capture", webTunerListening);
  useScreenWakeLock("tuner-capture", webTunerListening);
  useEffect(() => {
    if (isListening) {
      void refreshPowerInhibitionStatus();
    }
  }, [isListening]);
  const protectionWarning = isListening ? tunerPowerProtectionMessage() : null;
  const canStart =
    ((!webAudioForced && androidRuntime) ||
      canUseTunerCapture(webAudioForced ? null : nativeAudioCapabilities)) &&
    !isBusy &&
    !isListening;
  const statusText = headerStatusLabel(status);
  const systemDefaultInputOnly =
    webAudioForced ||
    androidRuntime ||
    activeCaptureBackend === "web" ||
    nativeAudioCapabilities?.micCaptureSupported === false;
  const inputVolumeDeviceId =
    webAudioForced ||
    activeCaptureBackend === "web" ||
    !isNativeAudioInputDeviceId(defaultTunerInputDeviceId)
      ? null
      : defaultTunerInputDeviceId;

  return (
    <div className="tuner-shell">
      <div className="panel tuner-panel">
        <TunerHeader
          canStart={canStart}
          isBusy={isBusy}
          isListening={isListening}
          isError={status === "error"}
          onStart={() => void startTuner()}
          onStop={stopTuner}
          statusText={statusText}
        />

        <TunerPreferenceControls
          className="tuner-preferences--with-mode"
          inputDeviceId={defaultTunerInputDeviceId}
          nativeCaptureDisabled={webAudioForced}
          onInputDeviceChange={handleInputDeviceChange}
          onReferenceHzChange={handleReferenceHzChange}
          onVisualModeChange={handleVisualModeChange}
          referenceHz={defaultTunerReferenceHz}
          refreshToken={deviceRefreshToken}
          systemDefaultOnly={systemDefaultInputOnly}
          visualMode={defaultTunerVisualMode}
          visualModeAriaLabel="Tuner visual mode"
          visualModeLabel="Visual mode"
        />

        <SystemInputVolumeControl
          deviceId={inputVolumeDeviceId}
          refreshToken={systemInputVolumeRefreshToken}
        />

        {errorMessage ? <p className="inline-error" role="alert">{errorMessage}</p> : null}
        {protectionWarning ? (
          <p className="tuner-preferences__status" role="status">{protectionWarning}</p>
        ) : null}
        {webAudioForced ? (
          <p className="tuner-preferences__status">Web Audio development override is active.</p>
        ) : null}

        {defaultTunerVisualMode === "simple" ? (
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
  isError,
  onStart,
  onStop,
  statusText,
}: {
  canStart: boolean;
  isBusy: boolean;
  isListening: boolean;
  isError: boolean;
  onStart: () => void;
  onStop: () => void;
  statusText: string;
}) {
  return (
    <div className="tuner-header">
      <div>
        <h2>Chromatic Tuner</h2>
        <p aria-live="polite" className="subpanel__copy">{statusText}</p>
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
            {isError ? "Retry" : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}

function SystemInputVolumeControl({
  deviceId,
  refreshToken,
}: {
  deviceId: string | null;
  refreshToken: number;
}) {
  const [volumeState, setVolumeState] = useState<SystemDefaultInputVolume | null>(null);
  const [draftVolume, setDraftVolume] = useState(0);
  const [isSetting, setIsSetting] = useState(false);
  const volumeSetRequestIdRef = useRef(0);
  const volumeCommitTimeoutRef = useRef<number | null>(null);
  const latestDraftVolumeRef = useRef(0);

  const refreshVolume = useStableCallback(async function refreshVolume() {
    try {
      const nextState = await getSystemDefaultInputVolume(deviceId);
      setVolumeState(nextState);
      if (typeof nextState.volumePercent === "number") {
        setDraftVolume(nextState.volumePercent);
        latestDraftVolumeRef.current = nextState.volumePercent;
      }
    } catch (error) {
      setVolumeState({
        supported: false,
        volumePercent: null,
        muted: null,
        backend: null,
        error: error instanceof Error ? error.message : "System input volume unavailable.",
      });
    }
  });

  useEffect(() => {
    volumeSetRequestIdRef.current += 1;
    if (volumeCommitTimeoutRef.current !== null) {
      window.clearTimeout(volumeCommitTimeoutRef.current);
      volumeCommitTimeoutRef.current = null;
    }
    void refreshVolume();
  }, [deviceId, refreshToken, refreshVolume]);

  useEffect(() => {
    return () => {
      if (volumeCommitTimeoutRef.current !== null) {
        window.clearTimeout(volumeCommitTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    function refreshOnFocus() {
      void refreshVolume();
    }

    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshVolume]);

  const supported = Boolean(volumeState?.supported && typeof volumeState.volumePercent === "number");
  const hasDeviceTarget = Boolean(deviceId);
  const statusText = systemInputVolumeStatus(volumeState, isSetting, hasDeviceTarget);

  const commitVolume = useStableCallback(async function commitVolume(volume: number) {
    const requestId = volumeSetRequestIdRef.current + 1;
    volumeSetRequestIdRef.current = requestId;
    setIsSetting(true);
    try {
      const nextState = await setSystemDefaultInputVolume(volume, deviceId);
      if (volumeSetRequestIdRef.current !== requestId) {
        return;
      }
      setVolumeState(nextState);
    } catch (error) {
      if (volumeSetRequestIdRef.current !== requestId) {
        return;
      }
      setVolumeState({
        supported: false,
        volumePercent: null,
        muted: null,
        backend: null,
        error: error instanceof Error ? error.message : "System input volume unavailable.",
      });
    } finally {
      if (volumeSetRequestIdRef.current === requestId) {
        setIsSetting(false);
      }
    }
  });

  function clearScheduledVolumeCommit() {
    if (volumeCommitTimeoutRef.current !== null) {
      window.clearTimeout(volumeCommitTimeoutRef.current);
      volumeCommitTimeoutRef.current = null;
    }
  }

  function scheduleVolumeCommit(volume: number) {
    clearScheduledVolumeCommit();
    volumeCommitTimeoutRef.current = window.setTimeout(() => {
      volumeCommitTimeoutRef.current = null;
      void commitVolume(volume);
    }, SYSTEM_INPUT_VOLUME_COMMIT_DELAY_MS);
  }

  function flushVolumeCommit() {
    if (!supported) {
      return;
    }
    clearScheduledVolumeCommit();
    void commitVolume(latestDraftVolumeRef.current);
  }

  function handleVolumeChange(value: string) {
    const nextVolume = clampSystemInputVolume(Number(value));
    latestDraftVolumeRef.current = nextVolume;
    setDraftVolume(nextVolume);
    scheduleVolumeCommit(nextVolume);
  }

  return (
    <div className="tuner-system-volume">
      <label className="tuner-field">
          <span className="tuner-field__label-row">
          <span>{hasDeviceTarget ? "Selected input volume" : "System input volume"}</span>
          {supported ? <strong>{draftVolume}%</strong> : null}
        </span>
        <input
          aria-label={hasDeviceTarget ? "Selected input volume" : "System input volume"}
          disabled={!supported}
          max={100}
          min={0}
          onChange={(event) => void handleVolumeChange(event.target.value)}
          onBlur={flushVolumeCommit}
          onKeyUp={flushVolumeCommit}
          onPointerUp={flushVolumeCommit}
          step={1}
          type="range"
          value={draftVolume}
        />
      </label>
      <p className="tuner-preferences__status">{statusText}</p>
    </div>
  );
}

function systemInputVolumeStatus(
  volumeState: SystemDefaultInputVolume | null,
  isSetting: boolean,
  hasDeviceTarget: boolean,
) {
  if (isSetting) {
    return hasDeviceTarget ? "Updating selected input volume." : "Updating system input volume.";
  }
  if (!volumeState) {
    return hasDeviceTarget ? "Checking selected input volume." : "Checking system input volume.";
  }
  if (!volumeState.supported) {
    return (
      volumeState.error ??
      (hasDeviceTarget
        ? "Selected input volume control is unavailable."
        : "System input volume control is unavailable.")
    );
  }
  if (volumeState.muted) {
    return hasDeviceTarget ? "Selected microphone is muted." : "Default microphone is muted.";
  }
  return hasDeviceTarget
    ? "Controls the selected microphone."
    : "Controls the operating system default microphone.";
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

function canUseTunerCapture(nativeAudioCapabilities: NativeAudioCapabilities | null) {
  return Boolean(nativeAudioCapabilities?.micCaptureSupported || (getWebAudioContextConstructor() && getMediaDevices()));
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

function createAudioConstraints(): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
  };
  return { audio, video: false };
}

function isNativeAudioInputDeviceId(inputDeviceId: string | null) {
  return inputDeviceId?.startsWith("cpal:") ?? false;
}

function captureErrorMessage(error: unknown) {
  if (typeof error === "string" && error.trim()) {
    return error;
  }
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

function captureStateErrorMessage(inputState: NativeAudioInputState) {
  return captureSafeErrorMessage(inputState.error);
}

function captureSafeErrorMessage(error: NativeAudioInputState["error"]) {
  return error
    ? [error.message, error.guidance].filter(Boolean).join(" ")
    : "Native microphone capture did not start.";
}

function waitForPermissionPoll() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 250));
}

function isMicrophonePermissionError(error: unknown) {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function getCurrentTunerTimeMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function headerStatusLabel(status: TunerStatus) {
  if (status === "error" || status === "unsupported") return "Error";
  if (status === "starting") return "Starting microphone";
  if (status === "listening") return "Listening";
  return "Ready";
}
