/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type InformationDensity = "minimal" | "balanced" | "detailed";
export type LayoutDensity = "compact" | "comfortable";
export type MetadataRevealMode = "hover" | "expand";

export type UiPreferences = {
  informationDensity: InformationDensity;
  layoutDensity: LayoutDensity;
  helperTextVisible: boolean;
  defaultInspectorOpen: boolean;
  metadataRevealMode: MetadataRevealMode;
};

type PreferencesContextValue = UiPreferences & {
  setInformationDensity: (value: InformationDensity) => void;
  setLayoutDensity: (value: LayoutDensity) => void;
  setHelperTextVisible: (value: boolean) => void;
  setDefaultInspectorOpen: (value: boolean) => void;
  setMetadataRevealMode: (value: MetadataRevealMode) => void;
  resetPreferences: () => void;
};

const STORAGE_KEY = "tuneforge.ui-preferences";

const DEFAULT_PREFERENCES: UiPreferences = {
  informationDensity: "balanced",
  layoutDensity: "comfortable",
  helperTextVisible: true,
  defaultInspectorOpen: true,
  metadataRevealMode: "expand",
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function isInformationDensity(value: unknown): value is InformationDensity {
  return value === "minimal" || value === "balanced" || value === "detailed";
}

function isLayoutDensity(value: unknown): value is LayoutDensity {
  return value === "compact" || value === "comfortable";
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
    helperTextVisible:
      typeof candidate.helperTextVisible === "boolean"
        ? candidate.helperTextVisible
        : DEFAULT_PREFERENCES.helperTextVisible,
    defaultInspectorOpen:
      typeof candidate.defaultInspectorOpen === "boolean"
        ? candidate.defaultInspectorOpen
        : DEFAULT_PREFERENCES.defaultInspectorOpen,
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

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UiPreferences>(readStoredPreferences);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      ...preferences,
      setInformationDensity: (informationDensity) => {
        setPreferences((current) => {
          const next = { ...current, informationDensity };
          persistPreferences(next);
          return next;
        });
      },
      setLayoutDensity: (layoutDensity) => {
        setPreferences((current) => {
          const next = { ...current, layoutDensity };
          persistPreferences(next);
          return next;
        });
      },
      setHelperTextVisible: (helperTextVisible) => {
        setPreferences((current) => {
          const next = { ...current, helperTextVisible };
          persistPreferences(next);
          return next;
        });
      },
      setDefaultInspectorOpen: (defaultInspectorOpen) => {
        setPreferences((current) => {
          const next = { ...current, defaultInspectorOpen };
          persistPreferences(next);
          return next;
        });
      },
      setMetadataRevealMode: (metadataRevealMode) => {
        setPreferences((current) => {
          const next = { ...current, metadataRevealMode };
          persistPreferences(next);
          return next;
        });
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
