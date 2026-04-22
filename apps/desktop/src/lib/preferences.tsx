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
export type { EnharmonicDisplayMode };

export type UiPreferences = {
  informationDensity: InformationDensity;
  enharmonicDisplayMode: EnharmonicDisplayMode;
  defaultInspectorOpen: boolean;
  defaultSourcesRailCollapsed: boolean;
};

export type AppearancePreferences = Pick<UiPreferences, "informationDensity">;
export type NotationPreferences = Pick<UiPreferences, "enharmonicDisplayMode">;
export type VisibilityPreferences = Pick<
  UiPreferences,
  "defaultInspectorOpen" | "defaultSourcesRailCollapsed"
>;

type PreferencesContextValue = UiPreferences & {
  setInformationDensity: (value: InformationDensity) => void;
  setEnharmonicDisplayMode: (value: EnharmonicDisplayMode) => void;
  setDefaultInspectorOpen: (value: boolean) => void;
  setDefaultSourcesRailCollapsed: (value: boolean) => void;
  replacePreferences: (value: UiPreferences) => void;
  resetAppearancePreferences: () => void;
  resetNotationPreferences: () => void;
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

export const DEFAULT_VISIBILITY_PREFERENCES: VisibilityPreferences = {
  defaultInspectorOpen: false,
  defaultSourcesRailCollapsed: false,
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  ...DEFAULT_APPEARANCE_PREFERENCES,
  ...DEFAULT_NOTATION_PREFERENCES,
  ...DEFAULT_VISIBILITY_PREFERENCES,
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function isInformationDensity(value: unknown): value is InformationDensity {
  return value === "minimal" || value === "balanced" || value === "detailed";
}

function isEnharmonicDisplayMode(value: unknown): value is EnharmonicDisplayMode {
  return value === "auto" || value === "sharps" || value === "flats" || value === "neutral" || value === "dual";
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
