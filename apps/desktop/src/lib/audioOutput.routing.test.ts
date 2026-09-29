import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserOutputRoutingSnapshot,
  getAppAudioOutputNode,
  getCountInAudioOutputNode,
  getProjectAudioOutputNode,
  markBrowserOutputDisconnected,
  registerProjectMediaElement,
  releaseBrowserOutputContext,
  retryBrowserOutputRouting,
  setBrowserOutputRouting,
  setBrowserProjectOutput,
  subscribeBrowserOutputFailure,
  unregisterProjectMediaElement,
} from "./audioOutput";
import { DEFAULT_PROJECT_OUTPUT_ROUTING } from "./outputRouting";

const contexts: AudioContext[] = [];
const originalSetSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
const originalSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "sinkId");
let selected = new WeakMap<HTMLMediaElement, string>();
let selectSink: ReturnType<typeof vi.fn>;

function makeContext() {
  const context = new AudioContext();
  contexts.push(context);
  Object.defineProperty(context, "createMediaStreamDestination", { configurable: true,
    value: vi.fn(() => ({ stream: { getTracks: () => [] } })) });
  return context;
}

async function settleSink() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("browser per-route sinks", () => {
  beforeEach(() => {
    selected = new WeakMap();
    selectSink = vi.fn(async function(this: HTMLMediaElement, deviceId: string) {
      selected.set(this, deviceId);
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true, value: selectSink,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "sinkId", {
      configurable: true, get(this: HTMLMediaElement) { return selected.get(this) ?? ""; },
    });
    setBrowserOutputRouting({ projectId: "routing-test", globalDeviceId: null,
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
  });

  afterEach(() => {
    contexts.splice(0).forEach(releaseBrowserOutputContext);
    if (originalSetSinkId) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", originalSetSinkId);
    else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    if (originalSinkId) Object.defineProperty(HTMLMediaElement.prototype, "sinkId", originalSinkId);
    else Reflect.deleteProperty(HTMLMediaElement.prototype, "sinkId");
  });

  it("coalesces project and stem nodes on one selected sink without a direct duplicate", async () => {
    setBrowserOutputRouting({ projectId: "shared", globalDeviceId: "speaker",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING,
      lanes: [{ laneId: "bass", stableKey: "source:bass" }] });
    const context = makeContext();
    const directAppNode = getAppAudioOutputNode(context);
    const projectNode = getProjectAudioOutputNode(context);
    const stemNode = getProjectAudioOutputNode(context, "bass");
    await settleSink();

    expect(context.createMediaStreamDestination).toHaveBeenCalledTimes(1);
    expect(selectSink).toHaveBeenCalledWith("speaker");
    const projectConnections = vi.mocked(projectNode.connect).mock.calls;
    const stemConnections = vi.mocked(stemNode.connect).mock.calls;
    expect(projectConnections[projectConnections.length - 1]?.[0]).toBe(
      stemConnections[stemConnections.length - 1]?.[0],
    );
    expect(projectConnections[projectConnections.length - 1]?.[0]).not.toBe(directAppNode);
    expect(browserOutputRoutingSnapshot().project.status).toBe("selected");
  });

  it("holds pending song and count-in audio on the selected sink path", async () => {
    let finish!: () => void;
    selectSink.mockImplementation((deviceId: string) => deviceId === "slow"
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve());
    setBrowserOutputRouting({ projectId: "pending", globalDeviceId: "slow",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    const context = makeContext();
    const defaultNode = getAppAudioOutputNode(context);
    const song = getProjectAudioOutputNode(context);
    const countIn = getCountInAudioOutputNode(context);
    const songTarget = vi.mocked(song.connect).mock.calls[0]?.[0];
    const cueTarget = vi.mocked(countIn.connect).mock.calls[0]?.[0];
    expect(songTarget).toBe(cueTarget);
    expect(songTarget).not.toBe(defaultNode);
    expect(browserOutputRoutingSnapshot().project.status).toBe("pending");
    finish();
    await settleSink();
    expect(browserOutputRoutingSnapshot().cue.status).toBe("selected");
  });

  it("uses an established sink immediately when another route selects it", async () => {
    setBrowserOutputRouting({ projectId: "attach", globalDeviceId: null,
      routing: { ...DEFAULT_PROJECT_OUTPUT_ROUTING,
        project: { kind: "explicit-device", deviceId: "speaker" },
        cue: { kind: "system-default" } }, lanes: [] });
    const context = makeContext();
    getProjectAudioOutputNode(context);
    const cue = getCountInAudioOutputNode(context);
    await settleSink();
    expect(browserOutputRoutingSnapshot().project.status).toBe("selected");

    setBrowserOutputRouting({ projectId: "attach", globalDeviceId: null,
      routing: { ...DEFAULT_PROJECT_OUTPUT_ROUTING,
        project: { kind: "explicit-device", deviceId: "speaker" },
        cue: { kind: "explicit-device", deviceId: "speaker" } }, lanes: [] });
    expect(browserOutputRoutingSnapshot().cue).toMatchObject({
      preferredDeviceId: "speaker", effectiveDeviceId: "speaker", status: "selected",
    });
    const cueConnections = vi.mocked(cue.connect).mock.calls;
    expect(cueConnections[cueConnections.length - 1]?.[0])
      .toBe(vi.mocked(getProjectAudioOutputNode(context).connect).mock.calls[0]?.[0]);
    expect(context.createMediaStreamDestination).toHaveBeenCalledTimes(1);
  });

  it("latches one default fallback until explicit retry and ignores reappearance", async () => {
    selectSink.mockImplementation(async (deviceId: string) => {
      if (deviceId === "missing") throw new Error("device lost");
    });
    const config = { projectId: "missing-project", globalDeviceId: null,
      routing: { ...DEFAULT_PROJECT_OUTPUT_ROUTING,
        project: { kind: "explicit-device" as const, deviceId: "missing" } }, lanes: [] };
    setBrowserOutputRouting(config);
    const context = makeContext();
    getProjectAudioOutputNode(context);
    await settleSink();

    expect(browserOutputRoutingSnapshot().project).toMatchObject({
      preferredDeviceId: "missing", effectiveDeviceId: null,
      fallbackLatched: true, status: "fallback-default",
    });
    setBrowserOutputRouting(config);
    markBrowserOutputDisconnected("missing");
    await settleSink();
    expect(context.createMediaStreamDestination).toHaveBeenCalledTimes(1);

    retryBrowserOutputRouting();
    await settleSink();
    expect(context.createMediaStreamDestination).toHaveBeenCalledTimes(2);
    expect(browserOutputRoutingSnapshot().project.fallbackLatched).toBe(true);
  });

  it("ignores a sink result from the previous project", async () => {
    let finish!: () => void;
    selectSink.mockImplementation((deviceId: string) => deviceId === "late"
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve());
    setBrowserOutputRouting({ projectId: "old", globalDeviceId: "late",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    const context = makeContext();
    getProjectAudioOutputNode(context);
    setBrowserOutputRouting({ projectId: "new", globalDeviceId: null,
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    finish();
    await settleSink();
    expect(browserOutputRoutingSnapshot().project).toMatchObject({
      preferredDeviceId: null, effectiveDeviceId: null, status: "system-default",
    });
  });

  it("reconciles Default after a pending direct-media selection completes", async () => {
    let finish!: () => void;
    selectSink.mockImplementation(function(this: HTMLMediaElement, deviceId: string) {
      if (deviceId === "late") return new Promise<void>((resolve) => {
        finish = () => { selected.set(this, deviceId); resolve(); };
      });
      selected.set(this, deviceId);
      return Promise.resolve();
    });
    setBrowserOutputRouting({ projectId: "direct-pending", globalDeviceId: "late",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    const element = document.createElement("audio");
    registerProjectMediaElement(element, 1);
    await settleSink();
    setBrowserOutputRouting({ projectId: "direct-pending", globalDeviceId: null,
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    finish();
    await settleSink();
    expect(selectSink.mock.calls.map(([id]) => id)).toEqual(["late", ""]);
    expect(element.sinkId).toBe("");
    unregisterProjectMediaElement(element);
  });

  it("ignores old registration results after the same element is re-registered", async () => {
    let finish!: () => void;
    selectSink.mockImplementation(function(this: HTMLMediaElement, deviceId: string) {
      if (deviceId === "late") return new Promise<void>((resolve) => {
        finish = () => { selected.set(this, deviceId); resolve(); };
      });
      selected.set(this, deviceId);
      return Promise.resolve();
    });
    setBrowserOutputRouting({ projectId: "registration", globalDeviceId: "late",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    const element = document.createElement("audio");
    registerProjectMediaElement(element, 1);
    await settleSink();
    unregisterProjectMediaElement(element);
    setBrowserOutputRouting({ projectId: "registration", globalDeviceId: null,
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    registerProjectMediaElement(element, 1);
    finish();
    await settleSink();
    expect(element.sinkId).toBe("");
    expect(browserOutputRoutingSnapshot().project.status).toBe("system-default");
    unregisterProjectMediaElement(element);
  });

  it("reports failed System Default recovery for direct media after device loss", async () => {
    const failures: string[] = [];
    const unsubscribe = subscribeBrowserOutputFailure((key) => failures.push(key));
    selectSink.mockImplementation(async function(this: HTMLMediaElement, deviceId: string) {
      if (!deviceId) throw new Error("default unavailable");
      selected.set(this, deviceId);
    });
    setBrowserOutputRouting({ projectId: "direct", globalDeviceId: "speaker",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    const element = document.createElement("audio");
    registerProjectMediaElement(element, 1);
    await settleSink();
    expect(browserOutputRoutingSnapshot().project.status).toBe("selected");

    markBrowserOutputDisconnected("speaker");
    await settleSink();
    expect(browserOutputRoutingSnapshot().project).toMatchObject({
      preferredDeviceId: "speaker", effectiveDeviceId: null,
      fallbackLatched: true, status: "unavailable",
    });
    expect(failures).toEqual(["project"]);
    const attempts = selectSink.mock.calls.length;
    setBrowserOutputRouting({ projectId: "direct", globalDeviceId: "speaker",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    setBrowserProjectOutput({ gain: 0.7, muted: false });
    await settleSink();
    expect(selectSink).toHaveBeenCalledTimes(attempts);
    retryBrowserOutputRouting();
    await settleSink();
    expect(selectSink.mock.calls.length).toBeGreaterThan(attempts);
    unregisterProjectMediaElement(element);
    unsubscribe();
  });

  it("falls back when hidden sink autoplay is denied", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce(new Error("autoplay"));
    setBrowserOutputRouting({ projectId: "autoplay", globalDeviceId: "speaker",
      routing: DEFAULT_PROJECT_OUTPUT_ROUTING, lanes: [] });
    const context = makeContext();
    getProjectAudioOutputNode(context);
    await settleSink();
    expect(browserOutputRoutingSnapshot().project).toMatchObject({
      preferredDeviceId: "speaker", fallbackLatched: true, status: "fallback-default",
    });
    play.mockRestore();
  });
});
