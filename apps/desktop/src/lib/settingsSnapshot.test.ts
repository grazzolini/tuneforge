import { describe, expect, it } from "vitest";
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
  it("round-trips v4 with nondefault app and click output preferences", () => {
    const input = {
      exportedAt,
      preferences: {
        ...DEFAULT_PREFERENCES,
        appOutputGain: 0.37,
        appOutputMuted: true,
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
      version: 4,
      preferences: {
        appOutputGain: 0.37,
        appOutputMuted: true,
        countInOutputGain: 0.42,
        countInOutputMuted: true,
        metronomeOutputGain: 0.61,
        metronomeOutputMuted: true,
        defaultChordBackend: "lv-chordia-submission",
        defaultDurableAudioFormat: "flac",
      },
    });
    expect(parseSettingsSnapshot(serializeSettingsSnapshot(input))).toMatchObject({
      version: 4,
      preferences: {
        appOutputGain: 0.37,
        appOutputMuted: true,
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

  it("rejects unsupported v5 snapshots", () => {
    expect(() => parseSettingsSnapshot(snapshot(5, DEFAULT_PREFERENCES)))
      .toThrow("Unsupported settings file.");
  });
});
