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
import { canRouteBrowserAudio, markBrowserOutputDisconnected, retryBrowserOutputRouting, setBrowserAppOutput, setBrowserCueOutputs } from "./audioOutput";
import { AudioOutputContext, type AudioOutputContextValue } from "./audioOutputContext";
import { readBrowserOutputDeviceId, writeBrowserOutputDeviceId, readBrowserOutputInventory, writeBrowserOutputInventory, type RememberedBrowserOutput } from "./outputRouting";
import { usePreferences } from "./preferences";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type OutputMediaDevices = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

export function AudioOutputProvider({ children }: { children: ReactNode }) {
  const preferences = usePreferences();
  const [nativeAppError, setNativeAppError] = useState<string | null>(null);
  const [nativeCueError, setNativeCueError] = useState<string | null>(null);
  const [outputCapabilities, setOutputCapabilities] = useState<NativeAudioCapabilities | null>(null);
  const [outputDevices, setOutputDevices] = useState<NativeAudioDevices | null>(null);
  const outputDeviceRequestRef = useRef(0);
  const [outputRoute, setOutputRoute] = useState<NativeOutputRoute | null>(null);
  const [outputDeviceError, setOutputDeviceError] = useState<string | null>(null);
  const [browserOutputDeviceId, setBrowserOutputDeviceId] = useState(readBrowserOutputDeviceId);
  const browserOutputDeviceIdRef = useRef(browserOutputDeviceId);
  const [browserOutputDevices, setBrowserOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [rememberedOutputs, setRememberedOutputs] = useState(readBrowserOutputInventory);
  const rememberedOutputsRef = useRef(rememberedOutputs);
  const inventorySavePendingRef = useRef(false);
  const [browserOutputSaveError, setBrowserOutputSaveError] = useState<string | null>(null);
  const [inventorySaveError, setInventorySaveError] = useState<string | null>(null);
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false);
  const discoveryAttemptedRef = useRef(false);
  const browserSelectionRequestRef = useRef(0);
  const [browserOutputError, setBrowserOutputError] = useState<string | null>(null);
  const [browserOutputDiscoveryPending, setBrowserOutputDiscoveryPending] = useState(false);
  const [browserOutputDiscoveryError, setBrowserOutputDiscoveryError] = useState<string | null>(null);
  const discoveryPendingRef = useRef(false);
  const deferredDeviceChangeRef = useRef(false);
  const mountedRef = useRef(true);
  const browserDevices = navigator.mediaDevices as OutputMediaDevices | undefined;
  const browserRuntime = !isTauriRuntime() || isWebAudioBackendForced();
  const browserOutputDiscoveryMethod = browserRuntime && browserDevices?.enumerateDevices
    ? browserDevices.selectAudioOutput ? "output-chooser"
      : typeof browserDevices.getUserMedia === "function" ? "microphone" : null
    : null;
  const browserInventoryRefreshRef = useRef<Promise<boolean | null>>(Promise.resolve(false));
  const browserDeviceIdsRef = useRef<Set<string>>(new Set());
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

  const rememberOutputs = useCallback((devices: RememberedBrowserOutput[]) => {
    const inventory = new Map(rememberedOutputsRef.current.map((device) => [device.deviceId, device]));
    for (const device of devices) {
      if (!device.deviceId || device.deviceId === "default") continue;
      inventory.set(device.deviceId, { deviceId: device.deviceId,
        label: device.label?.trim() || inventory.get(device.deviceId)?.label || "" });
    }
    const next = [...inventory.values()];
    const changed = JSON.stringify(next) !== JSON.stringify(rememberedOutputsRef.current);
    if (!changed && !inventorySavePendingRef.current) return;
    if (changed) {
      rememberedOutputsRef.current = next;
      setRememberedOutputs(next);
    }
    try {
      writeBrowserOutputInventory(next);
      inventorySavePendingRef.current = false;
      setInventorySaveError(null);
    } catch {
      inventorySavePendingRef.current = true;
      setInventorySaveError("Output names could not be saved. They remain available for this session.");
    }
  }, []);

  const refreshOutputDevices = useCallback(async (preserveRoutes = false) => {
    const keepRoutes = preserveRoutes || discoveryPendingRef.current;
    const request = ++outputDeviceRequestRef.current;
    if (!isTauriRuntime() || isWebAudioBackendForced()) {
      if (!navigator.mediaDevices?.enumerateDevices) return false;
      const refresh = (async () => {
        try {
          const inventory = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === "audiooutput");
          if (request !== outputDeviceRequestRef.current) return null;
          const currentIds = new Set(inventory.map((device) => device.deviceId));
          if (!keepRoutes && !discoveryPendingRef.current) {
            deferredDeviceChangeRef.current = false;
            browserDeviceIdsRef.current.forEach((id) => {
              if (!currentIds.has(id)) markBrowserOutputDisconnected(id);
            });
          }
          // Keep missing IDs until an ordinary refresh can reconcile deferred disconnects.
          browserDeviceIdsRef.current = keepRoutes || discoveryPendingRef.current
            ? new Set([...browserDeviceIdsRef.current, ...currentIds]) : currentIds;
          rememberOutputs(inventory);
          setBrowserOutputDevices(inventory);
          setBrowserOutputError(null);
          return true;
        } catch {
          if (request === outputDeviceRequestRef.current) {
            setBrowserOutputError("Browser output inventory is unavailable.");
            return false;
          }
        }
        return null;
      })();
      browserInventoryRefreshRef.current = refresh;
      return refresh;
    }
    try {
      const inventory = await listNativeAudioOutputDevices();
      if (request === outputDeviceRequestRef.current) setOutputDevices(inventory);
    } catch {
      if (request === outputDeviceRequestRef.current) {
        setOutputDevices({ supported: false, devices: [], error: "Output inventory is unavailable." });
      }
    }
  }, [rememberOutputs]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      outputDeviceRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (isTauriRuntime() && !isWebAudioBackendForced()) return;
    void refreshOutputDevices();
    const refresh = () => {
      if (discoveryPendingRef.current) deferredDeviceChangeRef.current = true;
      void refreshOutputDevices();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refreshOutputDevices]);

  const authorizeBrowserOutputDevice = useCallback(async (deviceId: string) => {
    if ((isTauriRuntime() && !isWebAudioBackendForced()) || !canRouteBrowserAudio()) return null;
    const devices = navigator.mediaDevices as OutputMediaDevices | undefined;
    const selected = devices?.selectAudioOutput
      ? await devices.selectAudioOutput({ deviceId }) : null;
    if (selected && mountedRef.current) {
      discoveryAttemptedRef.current = true;
      setDiscoveryAttempted(true);
      setBrowserOutputDiscoveryError(null);
      rememberOutputs([selected]);
      void refreshOutputDevices(true);
    }
    return selected?.deviceId ?? deviceId;
  }, [refreshOutputDevices, rememberOutputs]);

  const discoverBrowserOutputs = useCallback(async () => {
    if ((isTauriRuntime() && !isWebAudioBackendForced()) || discoveryPendingRef.current) return;
    const devices = navigator.mediaDevices as OutputMediaDevices | undefined;
    if (!devices?.enumerateDevices || (!devices.selectAudioOutput && !devices.getUserMedia)) return;
    const usesMicrophone = !devices.selectAudioOutput;
    discoveryAttemptedRef.current = true;
    setDiscoveryAttempted(true);
    discoveryPendingRef.current = true;
    setBrowserOutputDiscoveryPending(true);
    try {
      if (devices.selectAudioOutput) {
        const selected = await devices.selectAudioOutput();
        if (mountedRef.current) rememberOutputs([selected]);
      } else {
        const stream = await devices.getUserMedia({ audio: true, video: false });
        // Release every temporary track before refresh or lifecycle checks, including late grants.
        stream.getTracks().forEach((track) => track.stop());
      }
      if (!mountedRef.current) return;
      let refreshed = await refreshOutputDevices(true);
      while (refreshed === null && mountedRef.current) {
        const latest = browserInventoryRefreshRef.current;
        refreshed = await latest;
        if (latest !== browserInventoryRefreshRef.current) refreshed = null;
      }
      if (!mountedRef.current) return;
      if (refreshed === false) {
        setBrowserOutputDiscoveryError("Could not refresh outputs. Try again; System Default is still available.");
      } else {
        setBrowserOutputDiscoveryError(null);
      }
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const name = error instanceof DOMException || error instanceof Error ? error.name : "";
      setBrowserOutputDiscoveryError(name === "NotFoundError"
        ? usesMicrophone
          ? "No microphone is available to discover outputs. System Default still works."
          : "No audio output is available to discover. System Default still works."
        : "Output access wasn’t granted. Use Discover outputs to try again; System Default remains available.");
    } finally {
      discoveryPendingRef.current = false;
      if (mountedRef.current) {
        setBrowserOutputDiscoveryPending(false);
        if (deferredDeviceChangeRef.current) {
          void refreshOutputDevices();
        }
      }
    }
  }, [refreshOutputDevices, rememberOutputs]);

  const needsDiscovery = !browserOutputDevices.some((device) =>
    device.deviceId && device.deviceId !== "default" && device.label.trim());
  const automaticDiscovery = browserRuntime && canRouteBrowserAudio()
    && !!browserOutputDiscoveryMethod && needsDiscovery && !discoveryAttempted;
  const activateBrowserOutputSelector = useCallback(() => {
    if (automaticDiscovery && !discoveryAttemptedRef.current) void discoverBrowserOutputs();
    else void refreshOutputDevices();
  }, [automaticDiscovery, discoverBrowserOutputs, refreshOutputDevices]);
  const browserOutputDiscoveryHelp = !canRouteBrowserAudio()
    ? "This runtime uses System Default. Saved choices stay available for supported devices."
    : !browserOutputDiscoveryMethod
      ? "Output discovery is unavailable in this browser. System Default remains available."
      : browserOutputDiscoveryMethod === "microphone"
        && (automaticDiscovery || browserOutputDiscoveryPending || browserOutputDiscoveryError)
        ? "Opening outputs briefly uses microphone access. Microphone use stops immediately; no audio is recorded."
        : "";
  const browserOutputChoices = useMemo(() => {
    const choices = new Map(rememberedOutputs.map((device) => [device.deviceId,
      { ...device, label: device.label || "Saved output", remembered: true }]));
    browserOutputDevices.filter((device) => device.deviceId && device.deviceId !== "default").forEach((device, index) => {
      choices.set(device.deviceId, { deviceId: device.deviceId,
        label: device.label.trim() || rememberedOutputs.find((entry) => entry.deviceId === device.deviceId)?.label || `Audio output ${index + 1}`,
        remembered: false });
    });
    return [...choices.values()];
  }, [browserOutputDevices, rememberedOutputs]);

  const selectBrowserOutputDevice = useCallback(async (deviceId: string | null) => {
    const request = ++browserSelectionRequestRef.current;
    try {
      const nextId = deviceId ? await authorizeBrowserOutputDevice(deviceId) : null;
      if (!mountedRef.current || request !== browserSelectionRequestRef.current || (deviceId && !nextId)) return;
      const sameOutput = nextId === browserOutputDeviceIdRef.current;
      browserOutputDeviceIdRef.current = nextId;
      setBrowserOutputDeviceId(nextId);
      if (sameOutput) retryBrowserOutputRouting(nextId);
      try { writeBrowserOutputDeviceId(nextId); setBrowserOutputSaveError(null); }
      catch { setBrowserOutputSaveError("Output choice could not be saved. It remains active for this session."); }
      setBrowserOutputError(null);
      void refreshOutputDevices();
    } catch {
      if (!mountedRef.current || request !== browserSelectionRequestRef.current) return;
      setBrowserOutputError("Output permission was denied. Choose an output to try again.");
    }
  }, [authorizeBrowserOutputDevice, refreshOutputDevices]);

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
    browserOutputDeviceId,
    browserOutputSelectionSupported: canRouteBrowserAudio(),
    browserOutputDevices,
    browserOutputChoices,
    browserOutputDiscoveryHelp,
    activateBrowserOutputSelector,
    browserOutputDiscoveryMethod,
    browserOutputDiscoveryPending,
    browserOutputDiscoveryResult: null,
    browserOutputDiscoveryError,
    discoverBrowserOutputs,
    selectBrowserOutputDevice,
    authorizeBrowserOutputDevice,
    refreshOutputDevices: async () => { await refreshOutputDevices(); },
    retryOutputControls,
    selectOutputDevice,
    outputSaveError: preferences.preferencesSaveError ?? nativeAppError ?? nativeCueError ?? browserOutputSaveError ?? browserOutputError ?? inventorySaveError,
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
  }), [applyCueOutputs, applyOutput, nativeAppError, nativeCueError, browserOutputError, browserOutputSaveError, inventorySaveError,
    browserOutputDeviceId, browserOutputDevices, browserOutputChoices, browserOutputDiscoveryHelp,
    activateBrowserOutputSelector, browserOutputDiscoveryMethod,
    browserOutputDiscoveryPending, browserOutputDiscoveryError,
    discoverBrowserOutputs, selectBrowserOutputDevice,
    authorizeBrowserOutputDevice, outputCapabilities,
    outputDevices, outputRoute, outputDeviceError, refreshOutputDevices, retryOutputControls, selectOutputDevice,
    preferences]);

  return (
    <AudioOutputContext.Provider value={value}>
      {browserRuntime ? (
        <span aria-atomic="true" aria-live="polite" className="sr-only"
          role={browserOutputDiscoveryPending || browserOutputDiscoveryError
            ? "status" : undefined}>
          {browserOutputDiscoveryPending ? "Discovering outputs…"
            : browserOutputDiscoveryError}
        </span>
      ) : null}
      {children}
    </AudioOutputContext.Provider>
  );
}
