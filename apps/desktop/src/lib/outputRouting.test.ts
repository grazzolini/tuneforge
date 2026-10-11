import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectPlaybackState, writeProjectPlaybackState } from "../features/projects/projectPlaybackState";
import {
  DEFAULT_PROJECT_OUTPUT_ROUTING_PREFERENCES,
  nativeRoutingRequest,
  normalizeProjectOutputRouting,
  readBrowserOutputDeviceId,
  readBrowserOutputInventory,
  writeBrowserOutputInventory,
  resolvedCueRoute,
  resolvedProjectRoute,
  resolvedStemRoute,
  writeBrowserOutputDeviceId,
} from "./outputRouting";

const drums = { laneId: "drums-parent", stableKey: "source:drums" };
const kick = { laneId: "kick", stableKey: "source:kick",
  parentLaneId: drums.laneId, parentStableKey: drums.stableKey };

describe("output routing preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("resolves global, project, cue and refined-drum routes without collapsing explicit Default", () => {
    const routing = normalizeProjectOutputRouting({
      project: { kind: "explicit-device", deviceId: "project" },
      cue: { kind: "system-default" },
      stems: { [drums.stableKey]: { kind: "explicit-device", deviceId: "drums" } },
    });
    expect(resolvedProjectRoute(routing, "global")).toBe("project");
    expect(resolvedCueRoute(routing, "global")).toBeNull();
    expect(resolvedStemRoute(routing, kick, "global")).toBe("drums");
    expect(resolvedStemRoute({ ...routing, stems: { ...routing.stems,
      [kick.stableKey]: { kind: "explicit-device", deviceId: "kick-device" } } }, kick, "global"))
      .toBe("kick-device");

    const request = nativeRoutingRequest(routing, [kick]);
    expect(request.lanes).toEqual([
      { laneId: drums.laneId, selection: { kind: "explicit-device", deviceId: "drums" } },
      { laneId: kick.laneId, parentLaneId: drums.laneId, selection: { kind: "inherit" } },
    ]);
  });

  it("keeps project routes local and preserves defaults for old saved state", () => {
    expect(readProjectPlaybackState("old").outputRouting).toEqual(DEFAULT_PROJECT_OUTPUT_ROUTING_PREFERENCES);
    const prior = readProjectPlaybackState("song");
    writeProjectPlaybackState("song", { ...prior, outputRouting: {
      native: { project: { kind: "system-default" }, cue: { kind: "inherit" },
        stems: { [drums.stableKey]: { kind: "explicit-device", deviceId: "native-drums" } } },
      browser: { project: { kind: "explicit-device", deviceId: "browser-project" },
        cue: { kind: "inherit" }, stems: {} },
    } });
    expect(readProjectPlaybackState("song").outputRouting.native.project.kind).toBe("system-default");
    expect(readProjectPlaybackState("song").outputRouting.native.stems[drums.stableKey])
      .toEqual({ kind: "explicit-device", deviceId: "native-drums" });
    expect(readProjectPlaybackState("song").outputRouting.browser.project)
      .toEqual({ kind: "explicit-device", deviceId: "browser-project" });
    expect(readProjectPlaybackState("other").outputRouting).toEqual(DEFAULT_PROJECT_OUTPUT_ROUTING_PREFERENCES);
  });

  it("keeps Android device identities in process memory only", () => {
    const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, value: "Android" });
    try {
      const prior = readProjectPlaybackState("android-song");
      writeProjectPlaybackState("android-song", { ...prior, outputRouting: {
        native: { project: { kind: "explicit-device", deviceId: "native-private" },
          cue: { kind: "system-default" }, stems: {} },
        browser: { project: { kind: "explicit-device", deviceId: "browser-private" },
          cue: { kind: "inherit" }, stems: {} },
      } });
      expect(readProjectPlaybackState("android-song").outputRouting.native.project)
        .toEqual({ kind: "explicit-device", deviceId: "native-private" });
      const durable = window.localStorage.getItem("tuneforge.project-playback-state") ?? "";
      expect(durable).not.toContain("native-private");
      expect(durable).not.toContain("browser-private");
      expect(durable).toContain("system-default");
      writeBrowserOutputDeviceId("browser-global-private");
      expect(readBrowserOutputDeviceId()).toBe("browser-global-private");
      expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBeNull();
      writeBrowserOutputInventory([{ deviceId: "private-output", label: "Synthetic" }]);
      expect(readBrowserOutputInventory()).toEqual([{ deviceId: "private-output", label: "Synthetic" }]);
      expect(window.localStorage.getItem("tuneforge.browser-output-inventory")).toBeNull();
    } finally {
      if (userAgent) Object.defineProperty(Navigator.prototype, "userAgent", userAgent);
      else Reflect.deleteProperty(Navigator.prototype, "userAgent");
    }
  });

  it("persists only valid output IDs and labels and tolerates corrupt or inaccessible storage", () => {
    window.localStorage.setItem("tuneforge.browser-output-inventory", "invalid");
    expect(readBrowserOutputInventory()).toEqual([]);
    window.localStorage.setItem("tuneforge.browser-output-inventory", JSON.stringify([
      { deviceId: "usb", label: "Studio", groupId: "must-not-persist" },
      { deviceId: "default", label: "Default" }, { deviceId: "bad", label: 42 },
    ]));
    const inventory = readBrowserOutputInventory();
    expect(inventory).toEqual([{ deviceId: "usb", label: "Studio" }]);
    writeBrowserOutputInventory(inventory);
    expect(window.localStorage.getItem("tuneforge.browser-output-inventory")).not.toContain("groupId");
    const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readBrowserOutputInventory()).toEqual([]);
    read.mockRestore();
  });

  it("stores the browser device separately from native global preferences", () => {
    writeBrowserOutputDeviceId("browser-device");
    expect(readBrowserOutputDeviceId()).toBe("browser-device");
    expect(window.localStorage.getItem("tuneforge.browser-output-device")).toBe("browser-device");
    writeBrowserOutputDeviceId(null);
    expect(readBrowserOutputDeviceId()).toBeNull();
  });
});
