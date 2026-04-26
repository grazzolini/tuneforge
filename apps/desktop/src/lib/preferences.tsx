/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EnharmonicDisplayMode } from "./music";

export type InformationDensity = "minimal" | "balanced" | "detailed";
export type ProjectWorkspaceMode = "project" | "playback";
export type PlaybackDisplayMode = "lyrics" | "chords" | "combined";
export type DefaultPlaybackDisplayMode = "auto" | PlaybackDisplayMode;
export type DefaultChordBackend = "tuneforge-fast" | "crema-advanced";
export type { EnharmonicDisplayMode };

export type UiPreferences = {
  informationDensity: InformationDensity;
  enharmonicDisplayMode: EnharmonicDisplayMode;
  defaultInspectorOpen: boolean;
  defaultSourcesRailCollapsed: boolean;
  defaultProjectWorkspace: ProjectWorkspaceMode;
  defaultPlaybackDisplayMode: DefaultPlaybackDisplayMode;
  defaultChordBackend: DefaultChordBackend;
  defaultLyricsFollowEnabled: boolean;
  defaultChordsFollowEnabled: boolean;
};

export type AppearancePreferences = Pick<UiPreferences, "informationDensity">;
export type NotationPreferences = Pick<UiPreferences, "enharmonicDisplayMode">;
export type AnalysisPreferences = Pick<UiPreferences, "defaultChordBackend">;
export type VisibilityPreferences = Pick<
  UiPreferences,
  | "defaultInspectorOpen"
  | "defaultSourcesRailCollapsed"
  | "defaultProjectWorkspace"
  | "defaultPlaybackDisplayMode"
  | "defaultLyricsFollowEnabled"
  | "defaultChordsFollowEnabled"
>;

type PreferencesContextValue = UiPreferences & {
  setInformationDensity: (value: InformationDensity) => void;
  setEnharmonicDisplayMode: (value: EnharmonicDisplayMode) => void;
  setDefaultInspectorOpen: (value: boolean) => void;
  setDefaultSourcesRailCollapsed: (value: boolean) => void;
  setDefaultProjectWorkspace: (value: ProjectWorkspaceMode) => void;
  setDefaultPlaybackDisplayMode: (value: DefaultPlaybackDisplayMode) => void;
  setDefaultChordBackend: (value: DefaultChordBackend) => void;
  setDefaultLyricsFollowEnabled: (value: boolean) => void;
  setDefaultChordsFollowEnabled: (value: boolean) => void;
  replacePreferences: (value: UiPreferences) => void;
  resetAppearancePreferences: () => void;
  resetNotationPreferences: () => void;
  resetAnalysisPreferences: () => void;
  resetVisibilityPreferences: () => void;
  resetPreferences: () => void;
};

const STORAGE_KEY = "tuneforge.ui-preferences";

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  informationDensity: "minimal",
};

export const DEFAULT_NOTATION_PREFERENCES: NotationPreferences = {
  enharmonicDisplayMode: "auto",
};

export const DEFAULT_ANALYSIS_PREFERENCES: AnalysisPreferences = {
  defaultChordBackend: "tuneforge-fast",
};

export const DEFAULT_VISIBILITY_PREFERENCES: VisibilityPreferences = {
  defaultInspectorOpen: true,
  defaultSourcesRailCollapsed: false,
  defaultProjectWorkspace: "project",
  defaultPlaybackDisplayMode: "auto",
  defaultLyricsFollowEnabled: true,
  defaultChordsFollowEnabled: true,
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  ...DEFAULT_APPEARANCE_PREFERENCES,
  ...DEFAULT_NOTATION_PREFERENCES,
  ...DEFAULT_ANALYSIS_PREFERENCES,
  ...DEFAULT_VISIBILITY_PREFERENCES,
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function isInformationDensity(value: unknown): value is InformationDensity {
  return value === "minimal" || value === "balanced" || value === "detailed";
}

function isEnharmonicDisplayMode(value: unknown): value is EnharmonicDisplayMode {
  return value === "auto" || value === "sharps" || value === "flats" || value === "neutral" || value === "dual";
}

export function isProjectWorkspaceMode(value: unknown): value is ProjectWorkspaceMode {
  return value === "project" || value === "playback";
}

export function isPlaybackDisplayMode(value: unknown): value is PlaybackDisplayMode {
  return value === "lyrics" || value === "chords" || value === "combined";
}

export function isDefaultPlaybackDisplayMode(
  value: unknown,
): value is DefaultPlaybackDisplayMode {
  return value === "auto" || isPlaybackDisplayMode(value);
}

export function isDefaultChordBackend(value: unknown): value is DefaultChordBackend {
  return value === "tuneforge-fast" || value === "crema-advanced";
}

export function normalizePreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") {
    return DEFAULT_PREFERENCES;
  }

  const candidate = value as Partial<UiPreferences>;
  return {
    informationDensity: isInformationDensity(candidate.informationDensity)
      ? candidate.informationDensity
      : DEFAULT_PREFERENCES.informationDensity,
    enharmonicDisplayMode: isEnharmonicDisplayMode(candidate.enharmonicDisplayMode)
      ? candidate.enharmonicDisplayMode
      : DEFAULT_PREFERENCES.enharmonicDisplayMode,
    defaultInspectorOpen:
      typeof candidate.defaultInspectorOpen === "boolean"
        ? candidate.defaultInspectorOpen
        : DEFAULT_PREFERENCES.defaultInspectorOpen,
    defaultSourcesRailCollapsed:
      typeof candidate.defaultSourcesRailCollapsed === "boolean"
        ? candidate.defaultSourcesRailCollapsed
        : DEFAULT_PREFERENCES.defaultSourcesRailCollapsed,
    defaultProjectWorkspace: isProjectWorkspaceMode(candidate.defaultProjectWorkspace)
      ? candidate.defaultProjectWorkspace
      : DEFAULT_PREFERENCES.defaultProjectWorkspace,
    defaultPlaybackDisplayMode: isDefaultPlaybackDisplayMode(candidate.defaultPlaybackDisplayMode)
      ? candidate.defaultPlaybackDisplayMode
      : DEFAULT_PREFERENCES.defaultPlaybackDisplayMode,
    defaultChordBackend: isDefaultChordBackend(candidate.defaultChordBackend)
      ? candidate.defaultChordBackend
      : DEFAULT_PREFERENCES.defaultChordBackend,
    defaultLyricsFollowEnabled:
      typeof candidate.defaultLyricsFollowEnabled === "boolean"
        ? candidate.defaultLyricsFollowEnabled
        : DEFAULT_PREFERENCES.defaultLyricsFollowEnabled,
    defaultChordsFollowEnabled:
      typeof candidate.defaultChordsFollowEnabled === "boolean"
        ? candidate.defaultChordsFollowEnabled
        : DEFAULT_PREFERENCES.defaultChordsFollowEnabled,
  };
}

function readStoredPreferences(): UiPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  const storedValue = window.localStorage.getItem(STORAGE_KEY);
  if (!storedValue) {
    return DEFAULT_PREFERENCES;
  }

  try {
    return normalizePreferences(JSON.parse(storedValue));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function persistPreferences(preferences: UiPreferences) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

function mergePreferences(current: UiPreferences, partial: Partial<UiPreferences>) {
  const next = { ...current, ...partial };
  persistPreferences(next);
  return next;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UiPreferences>(readStoredPreferences);

  useLayoutEffect(() => {
    persistPreferences(preferences);
  }, [preferences]);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      ...preferences,
      setInformationDensity: (informationDensity) => {
        setPreferences((current) => mergePreferences(current, { informationDensity }));
      },
      setEnharmonicDisplayMode: (enharmonicDisplayMode) => {
        setPreferences((current) => mergePreferences(current, { enharmonicDisplayMode }));
      },
      setDefaultInspectorOpen: (defaultInspectorOpen) => {
        setPreferences((current) => mergePreferences(current, { defaultInspectorOpen }));
      },
      setDefaultSourcesRailCollapsed: (defaultSourcesRailCollapsed) => {
        setPreferences((current) => mergePreferences(current, { defaultSourcesRailCollapsed }));
      },
      setDefaultProjectWorkspace: (defaultProjectWorkspace) => {
        setPreferences((current) => mergePreferences(current, { defaultProjectWorkspace }));
      },
      setDefaultPlaybackDisplayMode: (defaultPlaybackDisplayMode) => {
        setPreferences((current) => mergePreferences(current, { defaultPlaybackDisplayMode }));
      },
      setDefaultChordBackend: (defaultChordBackend) => {
        setPreferences((current) => mergePreferences(current, { defaultChordBackend }));
      },
      setDefaultLyricsFollowEnabled: (defaultLyricsFollowEnabled) => {
        setPreferences((current) => mergePreferences(current, { defaultLyricsFollowEnabled }));
      },
      setDefaultChordsFollowEnabled: (defaultChordsFollowEnabled) => {
        setPreferences((current) => mergePreferences(current, { defaultChordsFollowEnabled }));
      },
      replacePreferences: (value) => {
        const normalized = normalizePreferences(value);
        persistPreferences(normalized);
        setPreferences(normalized);
      },
      resetAppearancePreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_APPEARANCE_PREFERENCES));
      },
      resetNotationPreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_NOTATION_PREFERENCES));
      },
      resetAnalysisPreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_ANALYSIS_PREFERENCES));
      },
      resetVisibilityPreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_VISIBILITY_PREFERENCES));
      },
      resetPreferences: () => {
        persistPreferences(DEFAULT_PREFERENCES);
        setPreferences(DEFAULT_PREFERENCES);
      },
    }),
    [preferences],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) {
    throw new Error("usePreferences must be used within PreferencesProvider.");
  }
  return context;
}
