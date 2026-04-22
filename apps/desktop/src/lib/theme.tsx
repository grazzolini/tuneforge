/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  getThemeVariableValue,
  isThemeVariableName,
  resolveThemeCssVariables,
  type ThemeMode,
  type ThemeOverrides,
  type ThemeVariableName,
} from "./themeTokens";

export type ThemePreference = "dark" | "light" | "system";
export type EffectiveTheme = ThemeMode;
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

type ThemeContextValue = {
  effectiveTheme: EffectiveTheme;
  clearThemeOverride: (theme: ThemeMode, variable: ThemeVariableName) => void;
  getThemeVariables: (theme: ThemeMode) => Record<ThemeVariableName, string>;
  replaceThemeState: (state: { themeOverrides: ThemeOverrides; themePreference: ThemePreference }) => void;
  resetThemeOverrides: (theme?: ThemeMode) => void;
  themePreference: ThemePreference;
  themeOverrides: ThemeOverrides;
  setThemeOverride: (theme: ThemeMode, variable: ThemeVariableName, value: string) => void;
  setThemePreference: (theme: ThemePreference) => void;
};

const THEME_PREFERENCE_STORAGE_KEY = "tuneforge.theme-preference";
const THEME_OVERRIDES_STORAGE_KEY = "tuneforge.theme-overrides.v1";
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function normalizeThemePreference(value: string | null): ThemePreference {
  if (value === "dark" || value === "light" || value === "system") {
    return value;
  }
  return DEFAULT_THEME_PREFERENCE;
}

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_PREFERENCE;
  }
  return normalizeThemePreference(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY));
}

export function normalizeThemeOverrides(value: unknown): ThemeOverrides {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  const normalized: ThemeOverrides = {};

  for (const mode of ["dark", "light"] satisfies ThemeMode[]) {
    const modeValue = candidate[mode];
    if (!modeValue || typeof modeValue !== "object") {
      continue;
    }

    const modeOverrides: Partial<Record<ThemeVariableName, string>> = {};
    for (const [variable, variableValue] of Object.entries(modeValue)) {
      if (!isThemeVariableName(variable) || typeof variableValue !== "string") {
        continue;
      }
      modeOverrides[variable] = variableValue;
    }

    if (Object.keys(modeOverrides).length) {
      normalized[mode] = modeOverrides;
    }
  }

  return normalized;
}

function readThemeOverrides(): ThemeOverrides {
  if (typeof window === "undefined") {
    return {};
  }

  const storedValue = window.localStorage.getItem(THEME_OVERRIDES_STORAGE_KEY);
  if (!storedValue) {
    return {};
  }

  try {
    return normalizeThemeOverrides(JSON.parse(storedValue));
  } catch {
    return {};
  }
}

function readSystemTheme(): EffectiveTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: EffectiveTheme, themeOverrides: ThemeOverrides) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;

  for (const [property, value] of Object.entries(resolveThemeCssVariables(theme, themeOverrides[theme]))) {
    root.style.setProperty(property, value);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [themeOverrides, setThemeOverrides] = useState<ThemeOverrides>(readThemeOverrides);
  const [systemTheme, setSystemTheme] = useState<EffectiveTheme>(readSystemTheme);
  const effectiveTheme = themePreference === "system" ? systemTheme : themePreference;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? "dark" : "light");
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, []);

  useLayoutEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, themePreference);
      if (Object.keys(themeOverrides.dark ?? {}).length || Object.keys(themeOverrides.light ?? {}).length) {
        window.localStorage.setItem(THEME_OVERRIDES_STORAGE_KEY, JSON.stringify(themeOverrides));
      } else {
        window.localStorage.removeItem(THEME_OVERRIDES_STORAGE_KEY);
      }
    }
    applyTheme(effectiveTheme, themeOverrides);
  }, [effectiveTheme, themeOverrides, themePreference]);

  return (
    <ThemeContext.Provider
      value={{
        effectiveTheme,
        clearThemeOverride: (theme, variable) => {
          setThemeOverrides((current) => {
            const currentModeOverrides = current[theme];
            if (!currentModeOverrides?.[variable]) {
              return current;
            }

            const nextModeOverrides = { ...currentModeOverrides };
            delete nextModeOverrides[variable];

            const next = { ...current };
            if (Object.keys(nextModeOverrides).length) {
              next[theme] = nextModeOverrides;
            } else {
              delete next[theme];
            }
            return next;
          });
        },
        getThemeVariables: (theme) => resolveThemeCssVariables(theme, themeOverrides[theme]),
        replaceThemeState: ({ themeOverrides: nextThemeOverrides, themePreference: nextThemePreference }) => {
          setThemePreference(normalizeThemePreference(nextThemePreference));
          setThemeOverrides(normalizeThemeOverrides(nextThemeOverrides));
        },
        resetThemeOverrides: (theme) => {
          setThemeOverrides((current) => {
            if (!theme) {
              return {};
            }
            if (!current[theme]) {
              return current;
            }
            const next = { ...current };
            delete next[theme];
            return next;
          });
        },
        themePreference,
        themeOverrides,
        setThemeOverride: (theme, variable, value) => {
          const normalizedValue = value.trim().toUpperCase();
          setThemeOverrides((current) => {
            const defaultValue = getThemeVariableValue(theme, variable).toUpperCase();
            const nextModeOverrides = { ...(current[theme] ?? {}) };

            if (!normalizedValue || normalizedValue === defaultValue) {
              delete nextModeOverrides[variable];
            } else {
              nextModeOverrides[variable] = normalizedValue;
            }

            const next = { ...current };
            if (Object.keys(nextModeOverrides).length) {
              next[theme] = nextModeOverrides;
            } else {
              delete next[theme];
            }
            return next;
          });
        },
        setThemePreference,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }
  return context;
}
