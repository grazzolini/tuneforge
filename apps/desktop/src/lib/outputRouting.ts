import type { NativeOutputRoutingRequest, NativeRouteSelection } from "./nativeAudio";

export type OutputRouteSelection = NativeRouteSelection;
export type ProjectOutputRouting = {
  project: OutputRouteSelection;
  cue: OutputRouteSelection;
  stems: Record<string, OutputRouteSelection>;
};
export type ProjectOutputRoutingPreferences = {
  native: ProjectOutputRouting;
  browser: ProjectOutputRouting;
};
export type PlaybackRouteLane = {
  laneId: string;
  stableKey: string;
  parentLaneId?: string;
  parentStableKey?: string;
};

export const INHERIT_OUTPUT_ROUTE: OutputRouteSelection = { kind: "inherit" };
export const SYSTEM_DEFAULT_OUTPUT_ROUTE: OutputRouteSelection = { kind: "system-default" };
export const DEFAULT_PROJECT_OUTPUT_ROUTING: ProjectOutputRouting = {
  project: INHERIT_OUTPUT_ROUTE,
  cue: INHERIT_OUTPUT_ROUTE,
  stems: {},
};
export const DEFAULT_PROJECT_OUTPUT_ROUTING_PREFERENCES: ProjectOutputRoutingPreferences = {
  native: DEFAULT_PROJECT_OUTPUT_ROUTING,
  browser: DEFAULT_PROJECT_OUTPUT_ROUTING,
};

export function normalizeOutputRouteSelection(value: unknown): OutputRouteSelection {
  if (!value || typeof value !== "object") return INHERIT_OUTPUT_ROUTE;
  const candidate = value as Partial<OutputRouteSelection>;
  if (candidate.kind === "system-default") return SYSTEM_DEFAULT_OUTPUT_ROUTE;
  if (candidate.kind === "explicit-device" && "deviceId" in candidate
    && typeof candidate.deviceId === "string" && candidate.deviceId.trim()
    && candidate.deviceId !== "default") {
    return { kind: "explicit-device", deviceId: candidate.deviceId };
  }
  return INHERIT_OUTPUT_ROUTE;
}

export function normalizeProjectOutputRouting(value: unknown): ProjectOutputRouting {
  if (!value || typeof value !== "object") return DEFAULT_PROJECT_OUTPUT_ROUTING;
  const candidate = value as Partial<ProjectOutputRouting>;
  const stems = candidate.stems && typeof candidate.stems === "object"
    && !Array.isArray(candidate.stems) ? candidate.stems : {};
  return {
    project: normalizeOutputRouteSelection(candidate.project),
    cue: normalizeOutputRouteSelection(candidate.cue),
    stems: Object.fromEntries(Object.entries(stems).map(([key, selection]) => [
      key, normalizeOutputRouteSelection(selection),
    ])),
  };
}

export function normalizeProjectOutputRoutingPreferences(value: unknown): ProjectOutputRoutingPreferences {
  if (!value || typeof value !== "object") return DEFAULT_PROJECT_OUTPUT_ROUTING_PREFERENCES;
  const candidate = value as Partial<ProjectOutputRoutingPreferences>;
  return {
    native: normalizeProjectOutputRouting(candidate.native),
    browser: normalizeProjectOutputRouting(candidate.browser),
  };
}

export function isAndroidOutputRuntime() {
  return typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent);
}

export function persistableOutputRoutingPreferences(
  routing: ProjectOutputRoutingPreferences,
): ProjectOutputRoutingPreferences {
  if (!isAndroidOutputRuntime()) return routing;
  const stripDevice = (selection: OutputRouteSelection): OutputRouteSelection =>
    selection.kind === "explicit-device" ? INHERIT_OUTPUT_ROUTE : selection;
  const strip = (value: ProjectOutputRouting): ProjectOutputRouting => ({
    project: stripDevice(value.project),
    cue: stripDevice(value.cue),
    stems: Object.fromEntries(Object.entries(value.stems).map(([key, selection]) =>
      [key, stripDevice(selection)])),
  });
  return { native: strip(routing.native), browser: strip(routing.browser) };
}

export function selectedDeviceId(
  selection: OutputRouteSelection,
  inheritedDeviceId: string | null,
): string | null {
  if (selection.kind === "explicit-device") return selection.deviceId;
  if (selection.kind === "system-default") return null;
  return inheritedDeviceId;
}

export function resolvedProjectRoute(
  routing: ProjectOutputRouting,
  globalDeviceId: string | null,
) {
  return selectedDeviceId(routing.project, globalDeviceId);
}

export function resolvedCueRoute(
  routing: ProjectOutputRouting,
  globalDeviceId: string | null,
) {
  return selectedDeviceId(routing.cue, resolvedProjectRoute(routing, globalDeviceId));
}

export function resolvedStemRoute(
  routing: ProjectOutputRouting,
  lane: PlaybackRouteLane,
  globalDeviceId: string | null,
) {
  const projectDeviceId = resolvedProjectRoute(routing, globalDeviceId);
  const parentDeviceId = lane.parentStableKey
    ? selectedDeviceId(routing.stems[lane.parentStableKey] ?? INHERIT_OUTPUT_ROUTE, projectDeviceId)
    : projectDeviceId;
  return selectedDeviceId(routing.stems[lane.stableKey] ?? INHERIT_OUTPUT_ROUTE, parentDeviceId);
}

export function nativeRoutingRequest(
  routing: ProjectOutputRouting,
  lanes: PlaybackRouteLane[],
): NativeOutputRoutingRequest {
  const entries = new Map<string, NativeOutputRoutingRequest["lanes"][number]>();
  for (const lane of lanes) {
    if (lane.parentLaneId && lane.parentStableKey && !entries.has(lane.parentLaneId)) {
      entries.set(lane.parentLaneId, {
        laneId: lane.parentLaneId,
        selection: routing.stems[lane.parentStableKey] ?? INHERIT_OUTPUT_ROUTE,
      });
    }
    entries.set(lane.laneId, {
      laneId: lane.laneId,
      parentLaneId: lane.parentLaneId ?? null,
      selection: routing.stems[lane.stableKey] ?? INHERIT_OUTPUT_ROUTE,
    });
  }
  return { project: routing.project, cue: routing.cue, lanes: [...entries.values()] };
}

const BROWSER_OUTPUT_KEY = "tuneforge.browser-output-device";
let processOnlyBrowserOutput: string | null = null;

export function readBrowserOutputDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  if (isAndroidOutputRuntime()) return processOnlyBrowserOutput;
  try {
    const stored = window.localStorage.getItem(BROWSER_OUTPUT_KEY);
    return stored && stored !== "default" ? stored : null;
  } catch {
    return null;
  }
}

export function writeBrowserOutputDeviceId(deviceId: string | null) {
  const normalized = deviceId && deviceId !== "default" ? deviceId : null;
  if (typeof window === "undefined") return;
  if (isAndroidOutputRuntime()) {
    processOnlyBrowserOutput = normalized;
    return;
  }
  if (normalized) window.localStorage.setItem(BROWSER_OUTPUT_KEY, normalized);
  else window.localStorage.removeItem(BROWSER_OUTPUT_KEY);
}
