import { invoke } from "@tauri-apps/api/core";
import {
  MAX_TUNER_REFERENCE_HZ,
  MIN_TUNER_REFERENCE_HZ,
  normalizePreferences,
  type UiPreferences,
} from "./preferences";
import {
  normalizeThemeOverrides,
  normalizeThemePreference,
  type ThemePreference,
} from "./theme";
import { isThemeVariableName, type ThemeOverrides } from "./themeTokens";

export const SETTINGS_SNAPSHOT_KIND = "tuneforge.settings";
export const SETTINGS_SNAPSHOT_VERSION = 2;
const SETTINGS_PARSE_ERROR = "Could not parse the settings file.";
const SETTINGS_UNSUPPORTED_ERROR = "Unsupported settings file.";
const REQUIRED_PREFERENCE_KEYS = [
  "informationDensity",
  "enharmonicDisplayMode",
  "defaultInspectorOpen",
  "defaultSourcesRailCollapsed",
  "defaultProjectWorkspace",
  "defaultPlaybackDisplayMode",
  "defaultLoopAlignmentMode",
  "defaultBeatAnalysisBackend",
  "defaultChordBackend",
  "defaultStemModel",
  "defaultDurableAudioFormat",
  "defaultLyricsFollowEnabled",
  "defaultChordsFollowEnabled",
  "defaultTunerInputDeviceId",
  "defaultTunerReferenceHz",
  "defaultTunerVisualMode",
] as const satisfies readonly (keyof UiPreferences)[];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function requireSupported(condition: boolean): asserts condition {
  if (!condition) {
    throw new Error(SETTINGS_UNSUPPORTED_ERROR);
  }
}

function validateExportedAt(value: unknown): asserts value is string {
  requireSupported(typeof value === "string" && value.trim().length > 0);
  requireSupported(Number.isFinite(Date.parse(value)));
}

function validatePreferences(value: unknown, version: 1 | 2): UiPreferences {
  requireSupported(isRecord(value));
  for (const key of REQUIRED_PREFERENCE_KEYS) {
    if (version === 1 && key === "defaultDurableAudioFormat") {
      continue;
    }
    requireSupported(hasOwn(value, key));
  }
  requireSupported(isOneOf(value.informationDensity, ["minimal", "balanced", "detailed"]));
  requireSupported(isOneOf(value.enharmonicDisplayMode, ["auto", "sharps", "flats", "neutral", "dual"]));
  requireSupported(typeof value.defaultInspectorOpen === "boolean");
  requireSupported(typeof value.defaultSourcesRailCollapsed === "boolean");
  requireSupported(isOneOf(value.defaultProjectWorkspace, ["project", "playback"]));
  requireSupported(isOneOf(value.defaultPlaybackDisplayMode, ["auto", "lyrics", "chords", "combined"]));
  requireSupported(isOneOf(value.defaultLoopAlignmentMode, ["free", "beat", "bar"]));
  requireSupported(isOneOf(value.defaultBeatAnalysisBackend, ["built-in", "beat-this"]));
  requireSupported(isOneOf(value.defaultChordBackend, ["tuneforge-fast", "crema-advanced"]));
  requireSupported(isOneOf(value.defaultStemModel, ["htdemucs_6s", "htdemucs_ft"]));
  if (version === 2) {
    requireSupported(isOneOf(value.defaultDurableAudioFormat, ["wav", "flac", "mp3", "m4a"]));
  }
  requireSupported(typeof value.defaultLyricsFollowEnabled === "boolean");
  requireSupported(typeof value.defaultChordsFollowEnabled === "boolean");
  requireSupported(value.defaultTunerInputDeviceId === null || typeof value.defaultTunerInputDeviceId === "string");
  requireSupported(
    typeof value.defaultTunerReferenceHz === "number" &&
      Number.isFinite(value.defaultTunerReferenceHz) &&
      value.defaultTunerReferenceHz >= MIN_TUNER_REFERENCE_HZ &&
      value.defaultTunerReferenceHz <= MAX_TUNER_REFERENCE_HZ,
  );
  requireSupported(isOneOf(value.defaultTunerVisualMode, ["simple", "wide-arc"]));
  return normalizePreferences(
    version === 1 ? { ...value, defaultDurableAudioFormat: "wav" } : value,
  );
}

function validateThemeOverrides(value: unknown): ThemeOverrides {
  requireSupported(isRecord(value));
  for (const [mode, modeOverrides] of Object.entries(value)) {
    requireSupported(mode === "dark" || mode === "light");
    requireSupported(isRecord(modeOverrides));
    for (const [variable, variableValue] of Object.entries(modeOverrides)) {
      requireSupported(isThemeVariableName(variable) && typeof variableValue === "string");
    }
  }
  return normalizeThemeOverrides(value);
}

function validateThemePreference(value: unknown): ThemePreference {
  requireSupported(isOneOf(value, ["dark", "light", "system"]));
  return normalizeThemePreference(value);
}

export function parseSettingsSnapshot(text: string): SettingsSnapshot {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(SETTINGS_PARSE_ERROR);
  }

  if (!isRecord(parsed)) {
    throw new Error(SETTINGS_PARSE_ERROR);
  }

  const candidate = parsed;
  const version = candidate.version;
  if (
    candidate.kind !== SETTINGS_SNAPSHOT_KIND ||
    (version !== 1 && version !== SETTINGS_SNAPSHOT_VERSION)
  ) {
    throw new Error(SETTINGS_UNSUPPORTED_ERROR);
  }

  validateExportedAt(candidate.exportedAt);

  return buildSettingsSnapshot({
    exportedAt: candidate.exportedAt,
    preferences: validatePreferences(candidate.preferences, version),
    themeOverrides: validateThemeOverrides(candidate.themeOverrides),
    themePreference: validateThemePreference(candidate.themePreference),
  });
}

export async function readSettingsSnapshotFile() {
  try {
    return await invoke<string | null>("read_settings_snapshot_file");
  } catch {
    throw new Error("Could not read settings file. Choose another file and try again.");
  }
}

export async function writeSettingsSnapshotFile(defaultFileName: string, contents: string) {
  try {
    return await invoke<boolean | null>("write_settings_snapshot_file", { contents, defaultFileName }) === true;
  } catch {
    throw new Error("Could not export settings. Choose another location and try again.");
  }
}
