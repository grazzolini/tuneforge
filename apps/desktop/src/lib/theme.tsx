/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { getThemeCssVariables, type ThemeMode } from "./themeTokens";

export type ThemePreference = "dark" | "light" | "system";
export type EffectiveTheme = ThemeMode;

type ThemeContextValue = {
  effectiveTheme: EffectiveTheme;
  themePreference: ThemePreference;
  setThemePreference: (theme: ThemePreference) => void;
};

const STORAGE_KEY = "tuneforge.theme-preference";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function normalizeThemePreference(value: string | null): ThemePreference {
  if (value === "light" || value === "system") {
    return value;
  }
  return "dark";
}

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "dark";
  }
  return normalizeThemePreference(window.localStorage.getItem(STORAGE_KEY));
}

function readSystemTheme(): EffectiveTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: EffectiveTheme) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;

  for (const [property, value] of Object.entries(getThemeCssVariables(theme))) {
    root.style.setProperty(property, value);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
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
      window.localStorage.setItem(STORAGE_KEY, themePreference);
    }
    applyTheme(effectiveTheme);
  }, [effectiveTheme, themePreference]);

  return (
    <ThemeContext.Provider
      value={{
        effectiveTheme,
        themePreference,
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
