import { normalizeOutputGain } from "./preferences";
import {
  DEFAULT_PROJECT_OUTPUT_ROUTING,
  resolvedCueRoute,
  resolvedProjectRoute,
  resolvedStemRoute,
  type PlaybackRouteLane,
  type ProjectOutputRouting,
} from "./outputRouting";
import type { NativeDestinationRoute, NativeOutputRouting, NativeRouteSelection } from "./nativeAudio";

export const OUTPUT_GAIN_RAMP_SECONDS = 0.015;

export type OutputLevel = {
  gain: number;
  muted: boolean;
};

function activeGain(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

type SinkOutput = {
  appNode: GainNode;
  destination: MediaStreamAudioDestinationNode;
  element: HTMLAudioElement;
  ready: Promise<boolean>;
  result: "pending" | "selected" | "failed";
};

type ContextBus = {
  appNode: GainNode;
  countInNode: GainNode | null;
  context: AudioContext;
  metronomeNode: GainNode | null;
  projectNode: GainNode | null;
  stemNodes: Map<string, GainNode>;
  sinkOutputs: Map<string, SinkOutput>;
};

type MediaRegistration = {
  element: HTMLAudioElement;
  laneGain: number;
  laneId: string | null;
  frameId: number | null;
  sinkRequest: { deviceId: string; state: BrowserRouteState } | null;
  appliedState: BrowserRouteState | null;
};

type BrowserRoutingConfig = {
  projectId: string | null;
  globalDeviceId: string | null;
  routing: ProjectOutputRouting;
  lanes: PlaybackRouteLane[];
  metronomeFollowsPlayback?: boolean;
};

type BrowserRouteState = {
  requestKey: string;
  preferredDeviceId: string | null;
  effectiveDeviceId: string | null;
  fallbackLatched: boolean;
  defaultFailed: boolean;
  status: NativeDestinationRoute["status"];
};

let appOutput: OutputLevel = { gain: 1, muted: false };
let projectOutput: OutputLevel = { gain: 1, muted: false };
let countInOutput: OutputLevel = { gain: 1, muted: false };
let metronomeOutput: OutputLevel = { gain: 0.8, muted: false };
const contextBuses = new Set<ContextBus>();
const mediaRegistrations = new Map<HTMLAudioElement, MediaRegistration>();
const mediaSinkQueues = new WeakMap<HTMLAudioElement, Promise<void>>();
const unsupportedMediaElements = new WeakSet<HTMLAudioElement>();
let browserRouting: BrowserRoutingConfig = {
  projectId: null,
  globalDeviceId: null,
  routing: DEFAULT_PROJECT_OUTPUT_ROUTING,
  lanes: [],
  metronomeFollowsPlayback: true,
};
const browserRouteStates = new Map<string, BrowserRouteState>();
const routingListeners = new Set<() => void>();
const failureListeners = new Set<(key: string) => void>();
let browserRoutingGeneration = 0;
let browserAttempt = 0;

export function canRouteBrowserAudio() {
  return typeof HTMLMediaElement !== "undefined"
    && typeof HTMLMediaElement.prototype.setSinkId === "function";
}

function routeRequest(key: string): { selection: NativeRouteSelection; preferred: string | null } {
  const global = browserRouting.globalDeviceId;
  const project = browserRouting.routing.project;
  if (key === "project") return { selection: project, preferred: resolvedProjectRoute(browserRouting.routing, global) };
  if (key === "cue") return { selection: browserRouting.routing.cue, preferred: resolvedCueRoute(browserRouting.routing, global) };
  if (key === "standalone") return {
    selection: global ? { kind: "explicit-device", deviceId: global } : { kind: "system-default" },
    preferred: global,
  };
  const lane = browserRouting.lanes.find((candidate) => candidate.laneId === key.slice(5));
  return lane
    ? { selection: browserRouting.routing.stems[lane.stableKey] ?? { kind: "inherit" },
      preferred: resolvedStemRoute(browserRouting.routing, lane, global) }
    : { selection: { kind: "inherit" }, preferred: resolvedProjectRoute(browserRouting.routing, global) };
}

function stateForRoute(key: string): BrowserRouteState {
  const { preferred, selection } = routeRequest(key);
  const requestKey = JSON.stringify([selection, preferred, browserAttempt]);
  const existing = browserRouteStates.get(key);
  if (existing && existing.requestKey === requestKey) return existing;
  const state: BrowserRouteState = {
    requestKey,
    preferredDeviceId: preferred,
    effectiveDeviceId: null,
    fallbackLatched: false,
    defaultFailed: false,
    status: preferred ? canRouteBrowserAudio() ? "pending" : "unavailable" : "system-default",
  };
  browserRouteStates.set(key, state);
  return state;
}

function publishBrowserRouteChange() {
  browserRoutingGeneration += 1;
  routingListeners.forEach((listener) => listener());
}

function fallbackBrowserRoute(key: string) {
  const state = stateForRoute(key);
  if (!state.preferredDeviceId || state.fallbackLatched) return;
  state.fallbackLatched = true;
  state.effectiveDeviceId = null;
  state.status = "fallback-default";
  refreshBrowserRoutes();
  publishBrowserRouteChange();
}

function disposeSinkOutput(output: SinkOutput) {
  output.appNode.disconnect();
  output.destination.stream.getTracks().forEach((track) => track.stop());
  output.element.pause();
  output.element.srcObject = null;
}

function sinkOutput(bus: ContextBus, deviceId: string) {
  const existing = bus.sinkOutputs.get(deviceId);
  if (existing) return existing;
  const destination = bus.context.createMediaStreamDestination();
  const appNode = bus.context.createGain();
  appNode.gain.value = effectiveGain(appOutput);
  appNode.connect(destination);
  const element = document.createElement("audio");
  element.srcObject = destination.stream;
  element.autoplay = true;
  const ready = element.setSinkId(deviceId).then(() => element.play()).then(
    () => true,
    () => false,
  );
  const output: SinkOutput = { appNode, destination, element, ready, result: "pending" };
  bus.sinkOutputs.set(deviceId, output);
  void ready.then((success) => {
    if (!contextBuses.has(bus) || bus.sinkOutputs.get(deviceId) !== output) return;
    output.result = success ? "selected" : "failed";
    for (const [key, state] of browserRouteStates) {
      if (state.preferredDeviceId !== deviceId || state.fallbackLatched
        || state !== stateForRoute(key)) continue;
      if (success) {
        state.effectiveDeviceId = deviceId;
        state.status = "selected";
      } else {
        state.fallbackLatched = true;
        state.effectiveDeviceId = null;
        state.status = "fallback-default";
      }
    }
    refreshBrowserRoutes();
    publishBrowserRouteChange();
  });
  return output;
}

function outputNode(bus: ContextBus, key: string): GainNode {
  const state = stateForRoute(key);
  if (!state.preferredDeviceId || state.fallbackLatched || !canRouteBrowserAudio()) return bus.appNode;
  const sink = sinkOutput(bus, state.preferredDeviceId);
  if (sink.result === "failed") {
    state.fallbackLatched = true;
    state.effectiveDeviceId = null;
    state.status = "fallback-default";
    publishBrowserRouteChange();
    return bus.appNode;
  }
  if (sink.result === "selected" && state.status !== "selected") {
    state.effectiveDeviceId = state.preferredDeviceId;
    state.status = "selected";
    publishBrowserRouteChange();
  }
  return sink.appNode;
}

function connectRouteNode(bus: ContextBus, node: GainNode, key: string) {
  node.disconnect();
  node.connect(outputNode(bus, key));
}

function applyMediaSink(registration: MediaRegistration) {
  const key = registration.laneId ? `lane:${registration.laneId}` : "project";
  const state = stateForRoute(key);
  if (state.defaultFailed) return;
  const deviceId = state.fallbackLatched ? "" : state.preferredDeviceId ?? "";
  if (!canRouteBrowserAudio()) return;
  if ((registration.sinkRequest?.deviceId === deviceId && registration.sinkRequest.state === state) ||
    (registration.appliedState === state && registration.element.sinkId === deviceId)) return;
  const request = { deviceId, state };
  registration.sinkRequest = request;
  const element = registration.element;
  const previous = mediaSinkQueues.get(element) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    if (mediaRegistrations.get(element) !== registration || registration.sinkRequest !== request) return;
    if (element.sinkId === deviceId && (!deviceId || registration.appliedState === state)) {
      registration.sinkRequest = null;
      registration.appliedState = state;
      if (state.preferredDeviceId === deviceId && !state.fallbackLatched) {
        state.effectiveDeviceId = deviceId || null;
        state.status = deviceId ? "selected" : "system-default";
        publishBrowserRouteChange();
      }
      return;
    }
    try {
      await element.setSinkId(deviceId);
      if (mediaRegistrations.get(element) !== registration || registration.sinkRequest !== request
        || stateForRoute(key) !== state) return;
      registration.sinkRequest = null;
      registration.appliedState = state;
      if (state.preferredDeviceId === deviceId && !state.fallbackLatched) {
        state.effectiveDeviceId = deviceId || null;
        state.status = deviceId ? "selected" : "system-default";
        publishBrowserRouteChange();
      }
    } catch {
      if (mediaRegistrations.get(element) !== registration || registration.sinkRequest !== request
        || stateForRoute(key) !== state) return;
      registration.sinkRequest = null;
      if (deviceId) fallbackBrowserRoute(key);
      else {
        state.defaultFailed = true;
        state.status = "unavailable";
        publishBrowserRouteChange();
        failureListeners.forEach((listener) => listener(key));
      }
    }
  });
  mediaSinkQueues.set(element, queued);
}

function refreshBrowserRoutes() {
  contextBuses.forEach((bus) => {
    if (bus.projectNode) connectRouteNode(bus, bus.projectNode, "project");
    bus.stemNodes.forEach((node, laneId) => connectRouteNode(bus, node, `lane:${laneId}`));
    if (bus.countInNode) connectRouteNode(bus, bus.countInNode, "cue");
    if (bus.metronomeNode) connectRouteNode(bus, bus.metronomeNode,
      browserRouting.metronomeFollowsPlayback ? "cue" : "standalone");
  });
  mediaRegistrations.forEach(applyMediaSink);
  const activeIds = new Set([...browserRouteStates.values()]
    .filter((state) => !state.fallbackLatched && state.preferredDeviceId)
    .map((state) => state.preferredDeviceId));
  contextBuses.forEach((bus) => bus.sinkOutputs.forEach((output, id) => {
    if (activeIds.has(id)) return;
    bus.sinkOutputs.delete(id);
    disposeSinkOutput(output);
  }));
}

export function setBrowserOutputRouting(config: BrowserRoutingConfig) {
  if (config.projectId !== browserRouting.projectId) browserRouteStates.clear();
  browserRouting = { ...config,
    metronomeFollowsPlayback: config.metronomeFollowsPlayback
      ?? browserRouting.metronomeFollowsPlayback };
  const routeKeys = ["project", "cue", "standalone", ...config.lanes.map((lane) => `lane:${lane.laneId}`)];
  for (const key of browserRouteStates.keys()) {
    if (!routeKeys.includes(key)) browserRouteStates.delete(key);
  }
  for (const key of routeKeys) {
    stateForRoute(key);
  }
  refreshBrowserRoutes();
  publishBrowserRouteChange();
}

export function retryBrowserOutputRouting() {
  if (![...browserRouteStates.values()].some((state) => state.fallbackLatched || state.defaultFailed)) return;
  browserAttempt += 1;
  for (const bus of contextBuses) {
    bus.sinkOutputs.forEach(disposeSinkOutput);
    bus.sinkOutputs.clear();
  }
  browserRouteStates.clear();
  refreshBrowserRoutes();
  publishBrowserRouteChange();
}

export function setBrowserMetronomeFollow(followsPlayback: boolean) {
  if (browserRouting.metronomeFollowsPlayback === followsPlayback) return;
  browserRouting = { ...browserRouting, metronomeFollowsPlayback: followsPlayback };
  refreshBrowserRoutes();
  publishBrowserRouteChange();
}

export function subscribeBrowserOutputRouting(listener: () => void) {
  routingListeners.add(listener);
  return () => { routingListeners.delete(listener); };
}

export function subscribeBrowserOutputFailure(listener: (key: string) => void) {
  failureListeners.add(listener);
  return () => { failureListeners.delete(listener); };
}

export function browserOutputRoutingSnapshot(): NativeOutputRouting {
  const snapshot = (key: string): NativeDestinationRoute => {
    const { selection } = routeRequest(key);
    const state = stateForRoute(key);
    return { selection, preferredDeviceId: state.preferredDeviceId,
      effectiveDeviceId: state.effectiveDeviceId, fallbackLatched: state.fallbackLatched,
      status: state.status };
  };
  return {
    project: snapshot("project"),
    cue: snapshot("cue"),
    lanes: browserRouting.lanes.map((lane) => ({ laneId: lane.laneId, ...snapshot(`lane:${lane.laneId}`) })),
    generation: browserRoutingGeneration,
  };
}

export function markBrowserOutputDisconnected(deviceId: string) {
  const affectedKeys = [...browserRouteStates]
    .filter(([, state]) => state.effectiveDeviceId === deviceId)
    .map(([key]) => key);
  affectedKeys.forEach(fallbackBrowserRoute);
}

export function releaseBrowserOutputContext(context: AudioContext) {
  const bus = [...contextBuses].find((candidate) => candidate.context === context);
  if (!bus) return;
  bus.sinkOutputs.forEach(disposeSinkOutput);
  contextBuses.delete(bus);
}

function effectiveGain(level: OutputLevel) {
  return level.muted ? 0 : normalizeOutputGain(level.gain);
}

function rampAudioParam(context: AudioContext, param: AudioParam, value: number) {
  const now = context.currentTime;
  param.cancelScheduledValues?.(now);
  param.setValueAtTime?.(param.value, now);
  if (typeof param.linearRampToValueAtTime === "function") {
    param.linearRampToValueAtTime(value, now + OUTPUT_GAIN_RAMP_SECONDS);
  } else {
    param.value = value;
  }
}

function targetMediaVolume(registration: MediaRegistration) {
  return normalizeOutputGain(
    effectiveGain(appOutput) * effectiveGain(projectOutput) * registration.laneGain,
  );
}

function applyMediaVolume(element: HTMLAudioElement, value: number) {
  try {
    element.volume = value;
    return Math.abs(element.volume - value) < 0.001;
  } catch {
    return false;
  }
}

function rampMediaVolume(registration: MediaRegistration) {
  const target = targetMediaVolume(registration);
  const initial = registration.element.volume;
  if (!applyMediaVolume(registration.element, target)) {
    unsupportedMediaElements.add(registration.element);
    return false;
  }
  unsupportedMediaElements.delete(registration.element);
  if (!applyMediaVolume(registration.element, initial)) {
    unsupportedMediaElements.add(registration.element);
    return false;
  }
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return applyMediaVolume(registration.element, target);
  }
  if (registration.frameId !== null) {
    window.cancelAnimationFrame(registration.frameId);
  }
  let startedAt: number | null = null;
  const step = (now: number) => {
    startedAt ??= now - (1000 / 60);
    const progress = Math.min(
      1,
      Math.max(0, (now - startedAt) / (OUTPUT_GAIN_RAMP_SECONDS * 1000)),
    );
    if (!applyMediaVolume(registration.element, initial + (target - initial) * progress)) {
      unsupportedMediaElements.add(registration.element);
      registration.frameId = null;
      return;
    }
    if (progress < 1) {
      registration.frameId = window.requestAnimationFrame(step);
    } else {
      registration.frameId = null;
    }
  };
  registration.frameId = window.requestAnimationFrame(step);
  return true;
}

export function getAppAudioOutputNode(context: AudioContext) {
  const existing = [...contextBuses].find((bus) => bus.context === context);
  if (existing) return existing.appNode;
  const appNode = context.createGain();
  appNode.gain.value = effectiveGain(appOutput);
  appNode.connect(context.destination);
  contextBuses.add({ appNode, countInNode: null, context, metronomeNode: null, projectNode: null,
    stemNodes: new Map(), sinkOutputs: new Map() });
  return appNode;
}

function getCueAudioOutputNode(context: AudioContext, kind: "count-in" | "metronome") {
  let bus = [...contextBuses].find((candidate) => candidate.context === context);
  if (!bus) {
    getAppAudioOutputNode(context);
    bus = [...contextBuses].find((candidate) => candidate.context === context)!;
  }
  const key = kind === "count-in" ? "countInNode" : "metronomeNode";
  if (!bus[key]) {
    const node = context.createGain();
    node.gain.value = effectiveGain(kind === "count-in" ? countInOutput : metronomeOutput);
    connectRouteNode(bus, node, kind === "count-in" ? "cue"
      : browserRouting.metronomeFollowsPlayback ? "cue" : "standalone");
    bus[key] = node;
  }
  return bus[key];
}

export function getCountInAudioOutputNode(context: AudioContext) {
  return getCueAudioOutputNode(context, "count-in");
}

export function getMetronomeAudioOutputNode(context: AudioContext) {
  return getCueAudioOutputNode(context, "metronome");
}

export function setBrowserCueOutputs(
  countInLevel: OutputLevel,
  metronomeLevel: OutputLevel,
) {
  const nextCountInGain = activeGain(countInLevel.gain);
  const nextMetronomeGain = activeGain(metronomeLevel.gain);
  if (nextCountInGain === null || nextMetronomeGain === null) return false;
  countInOutput = { gain: nextCountInGain, muted: countInLevel.muted };
  metronomeOutput = { gain: nextMetronomeGain, muted: metronomeLevel.muted };
  contextBuses.forEach(({ context, countInNode, metronomeNode }) => {
    if (countInNode) rampAudioParam(context, countInNode.gain, effectiveGain(countInOutput));
    if (metronomeNode) {
      rampAudioParam(context, metronomeNode.gain, effectiveGain(metronomeOutput));
    }
  });
  return true;
}

export function getProjectAudioOutputNode(context: AudioContext, laneId?: string) {
  let bus = [...contextBuses].find((candidate) => candidate.context === context);
  if (!bus) {
    getAppAudioOutputNode(context);
    bus = [...contextBuses].find((candidate) => candidate.context === context)!;
  }
  if (laneId) {
    let stemNode = bus.stemNodes.get(laneId);
    if (!stemNode) {
      stemNode = context.createGain();
      stemNode.gain.value = effectiveGain(projectOutput);
      connectRouteNode(bus, stemNode, `lane:${laneId}`);
      bus.stemNodes.set(laneId, stemNode);
    }
    return stemNode;
  }
  if (!bus.projectNode) {
    bus.projectNode = context.createGain();
    bus.projectNode.gain.value = effectiveGain(projectOutput);
    connectRouteNode(bus, bus.projectNode, "project");
  }
  return bus.projectNode;
}

export function setBrowserAppOutput(level: OutputLevel) {
  const gain = activeGain(level.gain);
  if (gain === null) return false;
  appOutput = { gain, muted: level.muted };
  contextBuses.forEach(({ appNode, context, sinkOutputs }) => {
    rampAudioParam(context, appNode.gain, effectiveGain(appOutput));
    sinkOutputs.forEach((output) => rampAudioParam(context, output.appNode.gain, effectiveGain(appOutput)));
  });
  mediaRegistrations.forEach(rampMediaVolume);
  return true;
}

export function setBrowserProjectOutput(level: OutputLevel) {
  const gain = activeGain(level.gain);
  if (gain === null) return false;
  projectOutput = { gain, muted: level.muted };
  contextBuses.forEach(({ context, projectNode, stemNodes }) => {
    if (projectNode) rampAudioParam(context, projectNode.gain, effectiveGain(projectOutput));
    stemNodes.forEach((node) => rampAudioParam(context, node.gain, effectiveGain(projectOutput)));
  });
  mediaRegistrations.forEach(rampMediaVolume);
  return true;
}

export function registerProjectMediaElement(element: HTMLAudioElement, laneGain: number, laneId?: string) {
  const registration: MediaRegistration = {
    element,
    laneGain: normalizeOutputGain(laneGain),
    laneId: laneId ?? null,
    frameId: null,
    sinkRequest: null,
    appliedState: null,
  };
  mediaRegistrations.set(element, registration);
  const supported = applyMediaVolume(element, targetMediaVolume(registration));
  if (supported) unsupportedMediaElements.delete(element);
  else unsupportedMediaElements.add(element);
  applyMediaSink(registration);
  return supported;
}

export function updateProjectMediaElement(element: HTMLAudioElement, laneGain: number) {
  const normalizedGain = activeGain(laneGain);
  if (normalizedGain === null) return false;
  const registration = mediaRegistrations.get(element);
  if (!registration) {
    registerProjectMediaElement(element, normalizedGain);
    return true;
  }
  registration.laneGain = normalizedGain;
  return rampMediaVolume(registration);
}

export function projectMediaElementSupportsVolume(element: HTMLAudioElement) {
  return !unsupportedMediaElements.has(element);
}

export function unregisterProjectMediaElement(element: HTMLAudioElement) {
  const registration = mediaRegistrations.get(element);
  if (registration && registration.frameId !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(registration.frameId);
  }
  mediaRegistrations.delete(element);
  unsupportedMediaElements.delete(element);
}
