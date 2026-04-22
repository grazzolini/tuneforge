import { invoke } from "@tauri-apps/api/core";
import {
  normalizePreferences,
  type UiPreferences,
} from "./preferences";
import {
  normalizeThemeOverrides,
  normalizeThemePreference,
  type ThemePreference,
} from "./theme";
import type { ThemeOverrides } from "./themeTokens";

export const SETTINGS_SNAPSHOT_KIND = "tuneforge.settings";
export const SETTINGS_SNAPSHOT_VERSION = 1;

export type SettingsSnapshot = {
  exportedAt: string;
  kind: typeof SETTINGS_SNAPSHOT_KIND;
  preferences: UiPreferences;
  themeOverrides: ThemeOverrides;
  themePreference: ThemePreference;
  version: typeof SETTINGS_SNAPSHOT_VERSION;
};

type SettingsSnapshotInput = {
  exportedAt?: string;
  preferences: UiPreferences;
  themeOverrides: ThemeOverrides;
  themePreference: ThemePreference;
};

export function buildSettingsSnapshot(input: SettingsSnapshotInput): SettingsSnapshot {
  return {
    exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date().toISOString(),
    kind: SETTINGS_SNAPSHOT_KIND,
    preferences: normalizePreferences(input.preferences),
    themeOverrides: normalizeThemeOverrides(input.themeOverrides),
    themePreference: normalizeThemePreference(input.themePreference),
    version: SETTINGS_SNAPSHOT_VERSION,
  };
}

export function serializeSettingsSnapshot(input: SettingsSnapshotInput) {
  return JSON.stringify(buildSettingsSnapshot(input), null, 2);
}

export function parseSettingsSnapshot(text: string): SettingsSnapshot {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Could not parse the settings file.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Could not parse the settings file.");
  }

  const candidate = parsed as Partial<SettingsSnapshot>;
  if (
    candidate.kind !== SETTINGS_SNAPSHOT_KIND ||
    candidate.version !== SETTINGS_SNAPSHOT_VERSION
  ) {
    throw new Error("Unsupported settings file.");
  }

  return buildSettingsSnapshot({
    exportedAt: candidate.exportedAt,
    preferences: candidate.preferences as UiPreferences,
    themeOverrides: candidate.themeOverrides as ThemeOverrides,
    themePreference: candidate.themePreference as ThemePreference,
  });
}

export async function readSettingsSnapshotFile(path: string) {
  return invoke<string>("read_settings_snapshot_file", { path });
}

export async function writeSettingsSnapshotFile(path: string, contents: string) {
  await invoke("write_settings_snapshot_file", { contents, path });
}
