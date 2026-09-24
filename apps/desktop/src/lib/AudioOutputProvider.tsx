import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getNativeAudioCapabilities,
  getNativeOutputRoute,
  isWebAudioBackendForced,
  listNativeAudioOutputDevices,
  listenNativeOutputRoute,
  setNativeOutputDevice,
  setNativeAppOutput,
  setNativeCueOutputs,
  type NativeAudioCapabilities,
  type NativeAudioDevices,
  type NativeCueOutputRequest,
  type NativeOutputRoute,
} from "./nativeAudio";
import { setBrowserAppOutput, setBrowserCueOutputs } from "./audioOutput";
import { AudioOutputContext, type AudioOutputContextValue } from "./audioOutputContext";
import { usePreferences } from "./preferences";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function AudioOutputProvider({ children }: { children: ReactNode }) {
  const preferences = usePreferences();
  const [nativeAppError, setNativeAppError] = useState<string | null>(null);
  const [nativeCueError, setNativeCueError] = useState<string | null>(null);
  const [outputCapabilities, setOutputCapabilities] = useState<NativeAudioCapabilities | null>(null);
  const [outputDevices, setOutputDevices] = useState<NativeAudioDevices | null>(null);
  const [outputRoute, setOutputRoute] = useState<NativeOutputRoute | null>(null);
  const [outputDeviceError, setOutputDeviceError] = useState<string | null>(null);
  const [outputControlsAttempt, setOutputControlsAttempt] = useState(0);
  const routeQueueRef = useRef(Promise.resolve());
  const latestRouteOperationRef = useRef<Promise<void>>(Promise.resolve());
  const appliedPreferredRef = useRef<string | null | undefined>(undefined);
  const queueRef = useRef(Promise.resolve());
  const latestOperationRef = useRef<Promise<void>>(Promise.resolve());
  const cueQueueRef = useRef(Promise.resolve());
  const latestCueOperationRef = useRef<Promise<void>>(Promise.resolve());
  const configuredOutputRef = useRef({
    gain: preferences.appOutputGain,
    muted: preferences.appOutputMuted,
  });
  const lastAppliedRef = useRef<{ gain: number; muted: boolean } | null>(null);
  const configuredCuesRef = useRef({
    countInGain: preferences.countInOutputGain,
    countInMuted: preferences.countInOutputMuted,
    metronomeGain: preferences.metronomeOutputGain,
    metronomeMuted: preferences.metronomeOutputMuted,
  });
  const lastAppliedCuesRef = useRef<NativeCueOutputRequest | null>(null);

  const refreshOutputDevices = useCallback(async () => {
    if (!isTauriRuntime() || isWebAudioBackendForced()) return;
    try {
      const inventory = await listNativeAudioOutputDevices();
      setOutputDevices(inventory);
    } catch {
      setOutputDevices({ supported: false, devices: [], error: "Output inventory is unavailable." });
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || isWebAudioBackendForced()) return;
    let active = true;
    void Promise.all([getNativeAudioCapabilities(), getNativeOutputRoute()])
      .then(([capabilities, route]) => {
        if (!active) return;
        setOutputRoute(route);
        setOutputCapabilities(capabilities);
        setOutputDeviceError(null);
        void refreshOutputDevices();
      })
      .catch(() => {
        if (active) setOutputDeviceError("Native output controls are unavailable.");
      });
    const unlisten = listenNativeOutputRoute((route) => {
      if (active) setOutputRoute(route);
    });
    const refresh = () => { void refreshOutputDevices(); };
    window.addEventListener("tuneforge:output-devices-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
      window.removeEventListener("tuneforge:output-devices-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [outputControlsAttempt, refreshOutputDevices]);

  const retryOutputControls = useCallback(() => {
    setOutputDeviceError(null);
    setOutputControlsAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (outputCapabilities?.outputSelectionPersistence !== "persistent") return;
    const preferred = preferences.defaultOutputDeviceId;
    if (appliedPreferredRef.current === preferred) return;
    appliedPreferredRef.current = preferred;
    const operation = routeQueueRef.current.then(() =>
      setNativeOutputDevice(preferred, false).then((snapshot) => {
        setOutputRoute(snapshot.outputRoute);
        setOutputDeviceError(null);
      }),
    );
    routeQueueRef.current = operation.catch(() => undefined);
    latestRouteOperationRef.current = operation;
    operation.catch(() => {
      setOutputDeviceError("Saved output is unavailable. Choose an output to try again.");
      void getNativeOutputRoute().then(setOutputRoute).catch(() => undefined);
    });
  }, [outputCapabilities, preferences.defaultOutputDeviceId]);

  const selectOutputDevice = useCallback(async (deviceId: string | null) => {
    if (!outputCapabilities || outputCapabilities.outputSelectionPersistence === "default-only") return;
    if (outputCapabilities.outputSelectionPersistence === "persistent") {
      appliedPreferredRef.current = deviceId;
      preferences.setDefaultOutputDeviceId(deviceId);
    }
    const operation = routeQueueRef.current.then(() =>
      setNativeOutputDevice(deviceId, true).then((snapshot) => {
        setOutputRoute(snapshot.outputRoute);
        setOutputDeviceError(null);
      }),
    );
    routeQueueRef.current = operation.catch(() => undefined);
    latestRouteOperationRef.current = operation;
    try {
      await operation;
    } catch {
      setOutputDeviceError("Output could not be opened. Choose another output or System Default.");
      void getNativeOutputRoute().then(setOutputRoute).catch(() => undefined);
    }
  }, [outputCapabilities, preferences]);

  const applyOutput = useCallback((gain: number, muted: boolean) => {
    lastAppliedRef.current = { gain, muted };
    setBrowserAppOutput({ gain, muted });
    if (!isTauriRuntime()) {
      latestOperationRef.current = Promise.resolve();
      return;
    }
    const operation = queueRef.current.then(() =>
      setNativeAppOutput({ gain, muted }).then(() => undefined),
    );
    queueRef.current = operation.catch(() => undefined);
    latestOperationRef.current = operation;
    operation
      .then(() => {
        setNativeAppError(null);
      })
      .catch((error: unknown) => {
        void error;
        setNativeAppError("App volume could not be applied. Change the volume to try again.");
      });
  }, []);

  const applyCueOutputs = useCallback((configured: NativeCueOutputRequest) => {
    lastAppliedCuesRef.current = configured;
    setBrowserCueOutputs(
      { gain: configured.countInGain, muted: configured.countInMuted },
      { gain: configured.metronomeGain, muted: configured.metronomeMuted },
    );
    if (!isTauriRuntime()) {
      latestCueOperationRef.current = Promise.resolve();
      return;
    }
    const operation = cueQueueRef.current.then(() => setNativeCueOutputs(configured).then(() => undefined));
    cueQueueRef.current = operation.catch(() => undefined);
    latestCueOperationRef.current = operation;
    operation.then(() => setNativeCueError(null)).catch(() => {
      setNativeCueError("Click volume could not be applied. Change the volume to try again.");
    });
  }, []);

  useEffect(() => {
    const next = {
      gain: preferences.appOutputGain,
      muted: preferences.appOutputMuted,
    };
    configuredOutputRef.current = next;
    if (
      lastAppliedRef.current?.gain !== next.gain
      || lastAppliedRef.current.muted !== next.muted
    ) {
      applyOutput(next.gain, next.muted);
    }
  }, [applyOutput, preferences.appOutputGain, preferences.appOutputMuted]);

  useEffect(() => {
    const next = {
      countInGain: preferences.countInOutputGain,
      countInMuted: preferences.countInOutputMuted,
      metronomeGain: preferences.metronomeOutputGain,
      metronomeMuted: preferences.metronomeOutputMuted,
    };
    configuredCuesRef.current = next;
    if (
      lastAppliedCuesRef.current?.countInGain !== next.countInGain
      || lastAppliedCuesRef.current.countInMuted !== next.countInMuted
      || lastAppliedCuesRef.current.metronomeGain !== next.metronomeGain
      || lastAppliedCuesRef.current.metronomeMuted !== next.metronomeMuted
    ) {
      applyCueOutputs(next);
    }
  }, [
    applyCueOutputs,
    preferences.countInOutputGain,
    preferences.countInOutputMuted,
    preferences.metronomeOutputGain,
    preferences.metronomeOutputMuted,
  ]);

  const value = useMemo<AudioOutputContextValue>(() => ({
    appOutputGain: preferences.appOutputGain,
    appOutputMuted: preferences.appOutputMuted,
    countInOutputGain: preferences.countInOutputGain,
    countInOutputMuted: preferences.countInOutputMuted,
    metronomeOutputGain: preferences.metronomeOutputGain,
    metronomeOutputMuted: preferences.metronomeOutputMuted,
    outputCapabilities,
    outputDevices,
    outputRoute,
    outputDeviceError,
    refreshOutputDevices,
    retryOutputControls,
    selectOutputDevice,
    outputSaveError: preferences.preferencesSaveError ?? nativeAppError ?? nativeCueError,
    ensureAppOutputReady: () => Promise.all([
      latestOperationRef.current,
      latestCueOperationRef.current,
      latestRouteOperationRef.current,
    ]).then(() => undefined),
    setAppOutputGain: (gain) => {
      if (!Number.isFinite(gain)) return;
      const clampedGain = Math.min(1, Math.max(0, gain));
      configuredOutputRef.current = {
        gain: clampedGain,
        muted: configuredOutputRef.current.muted,
      };
      applyOutput(clampedGain, configuredOutputRef.current.muted);
      preferences.setAppOutputGain(clampedGain);
    },
    setAppOutputMuted: (muted) => {
      configuredOutputRef.current = {
        gain: configuredOutputRef.current.gain,
        muted,
      };
      applyOutput(configuredOutputRef.current.gain, muted);
      preferences.setAppOutputMuted(muted);
    },
    setCountInOutputGain: (gain) => {
      if (!Number.isFinite(gain)) return;
      const clampedGain = Math.min(1, Math.max(0, gain));
      configuredCuesRef.current = { ...configuredCuesRef.current, countInGain: clampedGain };
      applyCueOutputs(configuredCuesRef.current);
      preferences.setCountInOutputGain(clampedGain);
    },
    setCountInOutputMuted: (muted) => {
      configuredCuesRef.current = { ...configuredCuesRef.current, countInMuted: muted };
      applyCueOutputs(configuredCuesRef.current);
      preferences.setCountInOutputMuted(muted);
    },
    setMetronomeOutputGain: (gain) => {
      if (!Number.isFinite(gain)) return;
      const clampedGain = Math.min(1, Math.max(0, gain));
      configuredCuesRef.current = { ...configuredCuesRef.current, metronomeGain: clampedGain };
      applyCueOutputs(configuredCuesRef.current);
      preferences.setMetronomeOutputGain(clampedGain);
    },
    setMetronomeOutputMuted: (muted) => {
      configuredCuesRef.current = { ...configuredCuesRef.current, metronomeMuted: muted };
      applyCueOutputs(configuredCuesRef.current);
      preferences.setMetronomeOutputMuted(muted);
    },
  }), [applyCueOutputs, applyOutput, nativeAppError, nativeCueError, outputCapabilities,
    outputDevices, outputRoute, outputDeviceError, refreshOutputDevices, retryOutputControls, selectOutputDevice,
    preferences]);

  return <AudioOutputContext.Provider value={value}>{children}</AudioOutputContext.Provider>;
}
