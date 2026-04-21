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
export type LayoutDensity = "compact" | "comfortable";
export type MetadataRevealMode = "hover" | "expand";
export type { EnharmonicDisplayMode };

export type UiPreferences = {
  informationDensity: InformationDensity;
  layoutDensity: LayoutDensity;
  enharmonicDisplayMode: EnharmonicDisplayMode;
  helperTextVisible: boolean;
  defaultInspectorOpen: boolean;
  defaultSourcesRailCollapsed: boolean;
  metadataRevealMode: MetadataRevealMode;
};

export type AppearancePreferences = Pick<
  UiPreferences,
  "informationDensity" | "layoutDensity" | "enharmonicDisplayMode"
>;
export type VisibilityPreferences = Pick<
  UiPreferences,
  "helperTextVisible" | "defaultInspectorOpen" | "defaultSourcesRailCollapsed" | "metadataRevealMode"
>;

type PreferencesContextValue = UiPreferences & {
  setInformationDensity: (value: InformationDensity) => void;
  setLayoutDensity: (value: LayoutDensity) => void;
  setEnharmonicDisplayMode: (value: EnharmonicDisplayMode) => void;
  setHelperTextVisible: (value: boolean) => void;
  setDefaultInspectorOpen: (value: boolean) => void;
  setDefaultSourcesRailCollapsed: (value: boolean) => void;
  setMetadataRevealMode: (value: MetadataRevealMode) => void;
  resetAppearancePreferences: () => void;
  resetVisibilityPreferences: () => void;
  resetPreferences: () => void;
};

const STORAGE_KEY = "tuneforge.ui-preferences";

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  informationDensity: "minimal",
  layoutDensity: "compact",
  enharmonicDisplayMode: "auto",
};

export const DEFAULT_VISIBILITY_PREFERENCES: VisibilityPreferences = {
  helperTextVisible: false,
  defaultInspectorOpen: false,
  defaultSourcesRailCollapsed: false,
  metadataRevealMode: "expand",
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  ...DEFAULT_APPEARANCE_PREFERENCES,
  ...DEFAULT_VISIBILITY_PREFERENCES,
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function isInformationDensity(value: unknown): value is InformationDensity {
  return value === "minimal" || value === "balanced" || value === "detailed";
}

function isLayoutDensity(value: unknown): value is LayoutDensity {
  return value === "compact" || value === "comfortable";
}

function isEnharmonicDisplayMode(value: unknown): value is EnharmonicDisplayMode {
  return value === "auto" || value === "sharps" || value === "flats" || value === "neutral" || value === "dual";
}

function isMetadataRevealMode(value: unknown): value is MetadataRevealMode {
  return value === "hover" || value === "expand";
}

function normalizePreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") {
    return DEFAULT_PREFERENCES;
  }

  const candidate = value as Partial<UiPreferences>;
  return {
    informationDensity: isInformationDensity(candidate.informationDensity)
      ? candidate.informationDensity
      : DEFAULT_PREFERENCES.informationDensity,
    layoutDensity: isLayoutDensity(candidate.layoutDensity)
      ? candidate.layoutDensity
      : DEFAULT_PREFERENCES.layoutDensity,
    enharmonicDisplayMode: isEnharmonicDisplayMode(candidate.enharmonicDisplayMode)
      ? candidate.enharmonicDisplayMode
      : DEFAULT_PREFERENCES.enharmonicDisplayMode,
    helperTextVisible:
      typeof candidate.helperTextVisible === "boolean"
        ? candidate.helperTextVisible
        : DEFAULT_PREFERENCES.helperTextVisible,
    defaultInspectorOpen:
      typeof candidate.defaultInspectorOpen === "boolean"
        ? candidate.defaultInspectorOpen
        : DEFAULT_PREFERENCES.defaultInspectorOpen,
    defaultSourcesRailCollapsed:
      typeof candidate.defaultSourcesRailCollapsed === "boolean"
        ? candidate.defaultSourcesRailCollapsed
        : DEFAULT_PREFERENCES.defaultSourcesRailCollapsed,
    metadataRevealMode: isMetadataRevealMode(candidate.metadataRevealMode)
      ? candidate.metadataRevealMode
      : DEFAULT_PREFERENCES.metadataRevealMode,
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
      setLayoutDensity: (layoutDensity) => {
        setPreferences((current) => mergePreferences(current, { layoutDensity }));
      },
      setEnharmonicDisplayMode: (enharmonicDisplayMode) => {
        setPreferences((current) => mergePreferences(current, { enharmonicDisplayMode }));
      },
      setHelperTextVisible: (helperTextVisible) => {
        setPreferences((current) => mergePreferences(current, { helperTextVisible }));
      },
      setDefaultInspectorOpen: (defaultInspectorOpen) => {
        setPreferences((current) => mergePreferences(current, { defaultInspectorOpen }));
      },
      setDefaultSourcesRailCollapsed: (defaultSourcesRailCollapsed) => {
        setPreferences((current) => mergePreferences(current, { defaultSourcesRailCollapsed }));
      },
      setMetadataRevealMode: (metadataRevealMode) => {
        setPreferences((current) => mergePreferences(current, { metadataRevealMode }));
      },
      resetAppearancePreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_APPEARANCE_PREFERENCES));
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
