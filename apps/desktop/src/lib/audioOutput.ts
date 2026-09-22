import { normalizeOutputGain } from "./preferences";

export const OUTPUT_GAIN_RAMP_SECONDS = 0.015;

export type OutputLevel = {
  gain: number;
  muted: boolean;
};

function activeGain(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

type ContextBus = {
  appNode: GainNode;
  countInNode: GainNode | null;
  context: AudioContext;
  metronomeNode: GainNode | null;
  projectNode: GainNode | null;
};

type MediaRegistration = {
  element: HTMLAudioElement;
  laneGain: number;
  frameId: number | null;
};

let appOutput: OutputLevel = { gain: 1, muted: false };
let projectOutput: OutputLevel = { gain: 1, muted: false };
let countInOutput: OutputLevel = { gain: 1, muted: false };
let metronomeOutput: OutputLevel = { gain: 0.8, muted: false };
const contextBuses = new Set<ContextBus>();
const mediaRegistrations = new Map<HTMLAudioElement, MediaRegistration>();
const unsupportedMediaElements = new WeakSet<HTMLAudioElement>();

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
  contextBuses.add({ appNode, countInNode: null, context, metronomeNode: null, projectNode: null });
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
    node.connect(bus.appNode);
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

export function getProjectAudioOutputNode(context: AudioContext) {
  let bus = [...contextBuses].find((candidate) => candidate.context === context);
  if (!bus) {
    getAppAudioOutputNode(context);
    bus = [...contextBuses].find((candidate) => candidate.context === context)!;
  }
  if (!bus.projectNode) {
    bus.projectNode = context.createGain();
    bus.projectNode.gain.value = effectiveGain(projectOutput);
    bus.projectNode.connect(bus.appNode);
  }
  return bus.projectNode;
}

export function setBrowserAppOutput(level: OutputLevel) {
  const gain = activeGain(level.gain);
  if (gain === null) return false;
  appOutput = { gain, muted: level.muted };
  contextBuses.forEach(({ appNode, context }) =>
    rampAudioParam(context, appNode.gain, effectiveGain(appOutput)),
  );
  mediaRegistrations.forEach(rampMediaVolume);
  return true;
}

export function setBrowserProjectOutput(level: OutputLevel) {
  const gain = activeGain(level.gain);
  if (gain === null) return false;
  projectOutput = { gain, muted: level.muted };
  contextBuses.forEach(({ context, projectNode }) => {
    if (projectNode) rampAudioParam(context, projectNode.gain, effectiveGain(projectOutput));
  });
  mediaRegistrations.forEach(rampMediaVolume);
  return true;
}

export function registerProjectMediaElement(element: HTMLAudioElement, laneGain: number) {
  const registration: MediaRegistration = {
    element,
    laneGain: normalizeOutputGain(laneGain),
    frameId: null,
  };
  mediaRegistrations.set(element, registration);
  const supported = applyMediaVolume(element, targetMediaVolume(registration));
  if (supported) unsupportedMediaElements.delete(element);
  else unsupportedMediaElements.add(element);
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
