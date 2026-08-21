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

describe("settings snapshot durable audio migration", () => {
  it("writes v2 with the durable audio preference", () => {
    expect(buildSettingsSnapshot({
      exportedAt,
      preferences: { ...DEFAULT_PREFERENCES, defaultDurableAudioFormat: "flac" },
      themeOverrides: {},
      themePreference: "system",
    })).toMatchObject({
      version: 2,
      preferences: { defaultDurableAudioFormat: "flac" },
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
});
