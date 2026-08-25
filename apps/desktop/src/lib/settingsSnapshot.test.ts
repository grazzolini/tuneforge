import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "./preferences";
import {
  SETTINGS_SNAPSHOT_KIND,
  buildSettingsSnapshot,
  parseSettingsSnapshot,
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
  it("writes v3 with the durable audio and chord backend preferences", () => {
    expect(buildSettingsSnapshot({
      exportedAt,
      preferences: {
        ...DEFAULT_PREFERENCES,
        defaultChordBackend: "lv-chordia-submission",
        defaultDurableAudioFormat: "flac",
      },
      themeOverrides: {},
      themePreference: "system",
    })).toMatchObject({
      version: 3,
      preferences: {
        defaultChordBackend: "lv-chordia-submission",
        defaultDurableAudioFormat: "flac",
      },
    });
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
});
