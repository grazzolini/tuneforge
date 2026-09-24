import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES } from "./preferences";
import {
  SETTINGS_SNAPSHOT_KIND,
  buildSettingsSnapshot,
  parseSettingsSnapshot,
  serializeSettingsSnapshot,
} from "./settingsSnapshot";

const exportedAt = "2026-08-21T12:00:00.000Z";

function snapshot(version: number, preferences: Record<string, unknown>) {
  return JSON.stringify({
    exportedAt,
    kind: SETTINGS_SNAPSHOT_KIND,
    preferences,
    themeOverrides: {},
    themePreference: "system",
    version,
  });
}

describe("settings snapshot migrations", () => {
  it("round-trips v5 with nondefault app, click, and preferred output settings", () => {
    const input = {
      exportedAt,
      preferences: {
        ...DEFAULT_PREFERENCES,
        appOutputGain: 0.37,
        appOutputMuted: true,
        defaultOutputDeviceId: "pipewire:alsa_output.usb:é ",
        countInOutputGain: 0.42,
        countInOutputMuted: true,
        metronomeOutputGain: 0.61,
        metronomeOutputMuted: true,
        defaultChordBackend: "lv-chordia-submission",
        defaultDurableAudioFormat: "flac",
      },
      themeOverrides: {},
      themePreference: "system",
    } as const;

    expect(buildSettingsSnapshot(input)).toMatchObject({
      version: 5,
      preferences: {
        appOutputGain: 0.37,
        appOutputMuted: true,
        defaultOutputDeviceId: "pipewire:alsa_output.usb:é ",
        countInOutputGain: 0.42,
        countInOutputMuted: true,
        metronomeOutputGain: 0.61,
        metronomeOutputMuted: true,
        defaultChordBackend: "lv-chordia-submission",
        defaultDurableAudioFormat: "flac",
      },
    });
    expect(parseSettingsSnapshot(serializeSettingsSnapshot(input))).toMatchObject({
      version: 5,
      preferences: {
        appOutputGain: 0.37,
        appOutputMuted: true,
        defaultOutputDeviceId: "pipewire:alsa_output.usb:é ",
        countInOutputGain: 0.42,
        countInOutputMuted: true,
        metronomeOutputGain: 0.61,
        metronomeOutputMuted: true,
      },
    });
  });

  it("defaults click output for v1 through v3 snapshots", () => {
    const {
      countInOutputGain,
      countInOutputMuted,
      metronomeOutputGain,
      metronomeOutputMuted,
      ...legacyPreferences
    } = DEFAULT_PREFERENCES;
    expect(countInOutputGain).toBe(1);
    expect(countInOutputMuted).toBe(false);
    expect(metronomeOutputGain).toBe(0.8);
    expect(metronomeOutputMuted).toBe(false);

    for (const version of [1, 2, 3]) {
      const preferences = version === 1
        ? Object.fromEntries(
          Object.entries(legacyPreferences).filter(([key]) => key !== "defaultDurableAudioFormat"),
        )
        : legacyPreferences;
      expect(parseSettingsSnapshot(snapshot(version, preferences)).preferences).toMatchObject({
        countInOutputGain: 1,
        countInOutputMuted: false,
        metronomeOutputGain: 0.8,
        metronomeOutputMuted: false,
      });
    }
  });

  it("parses v1 by injecting WAV", () => {
    const { defaultDurableAudioFormat, ...v1Preferences } = DEFAULT_PREFERENCES;
    expect(defaultDurableAudioFormat).toBe("wav");
    expect(parseSettingsSnapshot(snapshot(1, v1Preferences)).preferences.defaultDurableAudioFormat)
      .toBe("wav");
  });

  it("rejects a bad v2 durable format", () => {
    expect(() => parseSettingsSnapshot(snapshot(2, {
      ...DEFAULT_PREFERENCES,
      defaultDurableAudioFormat: "ogg",
    }))).toThrow("Unsupported settings file.");
  });

  it("continues to parse v2 snapshots", () => {
    expect(parseSettingsSnapshot(snapshot(2, {
      ...DEFAULT_PREFERENCES,
      defaultChordBackend: "crema-advanced",
    })).preferences.defaultChordBackend).toBe("crema-advanced");
  });

  it("defaults app output for v1 through v3 snapshots", () => {
    const { appOutputGain, appOutputMuted, ...legacyPreferences } = DEFAULT_PREFERENCES;
    expect(appOutputGain).toBe(1);
    expect(appOutputMuted).toBe(false);

    for (const version of [1, 2, 3]) {
      const preferences = version === 1
        ? Object.fromEntries(
          Object.entries(legacyPreferences).filter(([key]) => key !== "defaultDurableAudioFormat"),
        )
        : legacyPreferences;
      expect(parseSettingsSnapshot(snapshot(version, preferences)).preferences).toMatchObject({
        appOutputGain: 1,
        appOutputMuted: false,
      });
    }
  });

  it("requires all output preferences in v4", () => {
    const missingCountIn = Object.fromEntries(
      Object.entries(DEFAULT_PREFERENCES).filter(([key]) => key !== "countInOutputGain"),
    );
    expect(() => parseSettingsSnapshot(snapshot(4, missingCountIn)))
      .toThrow("Unsupported settings file.");
  });

  it("defaults preferred output for v1 through v4 and rejects unsupported v6", () => {
    for (const version of [1, 2, 3, 4]) {
      const { defaultOutputDeviceId, ...legacy } = DEFAULT_PREFERENCES;
      expect(defaultOutputDeviceId).toBeNull();
      expect(parseSettingsSnapshot(snapshot(version, legacy)).preferences.defaultOutputDeviceId)
        .toBeNull();
    }
    expect(() => parseSettingsSnapshot(snapshot(6, DEFAULT_PREFERENCES)))
      .toThrow("Unsupported settings file.");
  });

  it("removes desktop output IDs from Android imports and exports", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android WebView");
    try {
      const preferences = { ...DEFAULT_PREFERENCES, defaultOutputDeviceId: "pipewire:private-node" };
      const exported = serializeSettingsSnapshot({ preferences, themeOverrides: {}, themePreference: "system" });
      expect(JSON.parse(exported).preferences.defaultOutputDeviceId).toBeNull();
      const desktopSnapshot = snapshot(5, preferences);
      expect(parseSettingsSnapshot(desktopSnapshot).preferences.defaultOutputDeviceId).toBeNull();
    } finally {
      userAgent.mockRestore();
    }
  });
});
