/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EnharmonicDisplayMode } from "./music";
import {
  DEFAULT_LOOP_ALIGNMENT_MODE,
  normalizeLoopAlignmentMode,
  type LoopAlignmentMode,
} from "./timingGrid";
import {
  isDurableAudioFormat,
  type DurableAudioFormat,
} from "./durableAudio";

export type InformationDensity = "minimal" | "balanced" | "detailed";
export type ProjectWorkspaceMode = "project" | "playback";
export type PlaybackDisplayMode = "lyrics" | "chords" | "combined";
export type DefaultPlaybackDisplayMode = "auto" | PlaybackDisplayMode;
export type DefaultBeatAnalysisBackend = "built-in" | "beat-this";
export type DefaultChordBackend = "tuneforge-fast" | "crema-advanced" | "lv-chordia-submission";
export type DefaultStemModel = "htdemucs_6s" | "htdemucs_ft";
export type TunerVisualMode = "simple" | "wide-arc";
export type { EnharmonicDisplayMode, LoopAlignmentMode };

export const DEFAULT_TUNER_REFERENCE_HZ = 440;
export const MIN_TUNER_REFERENCE_HZ = 400;
export const MAX_TUNER_REFERENCE_HZ = 480;

export type UiPreferences = {
  appOutputGain: number;
  appOutputMuted: boolean;
  countInOutputGain: number;
  countInOutputMuted: boolean;
  metronomeOutputGain: number;
  metronomeOutputMuted: boolean;
  informationDensity: InformationDensity;
  enharmonicDisplayMode: EnharmonicDisplayMode;
  defaultInspectorOpen: boolean;
  defaultSourcesRailCollapsed: boolean;
  defaultProjectWorkspace: ProjectWorkspaceMode;
  defaultPlaybackDisplayMode: DefaultPlaybackDisplayMode;
  defaultLoopAlignmentMode: LoopAlignmentMode;
  defaultBeatAnalysisBackend: DefaultBeatAnalysisBackend;
  defaultChordBackend: DefaultChordBackend;
  defaultStemModel: DefaultStemModel;
  defaultDurableAudioFormat: DurableAudioFormat;
  defaultLyricsFollowEnabled: boolean;
  defaultChordsFollowEnabled: boolean;
  defaultTunerInputDeviceId: string | null;
  defaultTunerReferenceHz: number;
  defaultTunerVisualMode: TunerVisualMode;
};

export type AppearancePreferences = Pick<UiPreferences, "informationDensity">;
export type NotationPreferences = Pick<UiPreferences, "enharmonicDisplayMode">;
export type AnalysisPreferences = Pick<
  UiPreferences,
  "defaultBeatAnalysisBackend" | "defaultChordBackend" | "defaultStemModel"
>;
export type AudioStoragePreferences = Pick<UiPreferences, "defaultDurableAudioFormat">;
export type TunerPreferences = Pick<
  UiPreferences,
  "defaultTunerInputDeviceId" | "defaultTunerReferenceHz" | "defaultTunerVisualMode"
>;
export type VisibilityPreferences = Pick<
  UiPreferences,
  | "defaultInspectorOpen"
  | "defaultSourcesRailCollapsed"
  | "defaultProjectWorkspace"
  | "defaultPlaybackDisplayMode"
  | "defaultLoopAlignmentMode"
  | "defaultLyricsFollowEnabled"
  | "defaultChordsFollowEnabled"
>;

type PreferencesContextValue = UiPreferences & {
  preferencesSaveError: string | null;
  setInformationDensity: (value: InformationDensity) => void;
  setAppOutputGain: (value: number) => void;
  setAppOutputMuted: (value: boolean) => void;
  setCountInOutputGain: (value: number) => void;
  setCountInOutputMuted: (value: boolean) => void;
  setMetronomeOutputGain: (value: number) => void;
  setMetronomeOutputMuted: (value: boolean) => void;
  setEnharmonicDisplayMode: (value: EnharmonicDisplayMode) => void;
  setDefaultInspectorOpen: (value: boolean) => void;
  setDefaultSourcesRailCollapsed: (value: boolean) => void;
  setDefaultProjectWorkspace: (value: ProjectWorkspaceMode) => void;
  setDefaultPlaybackDisplayMode: (value: DefaultPlaybackDisplayMode) => void;
  setDefaultLoopAlignmentMode: (value: LoopAlignmentMode) => void;
  setDefaultBeatAnalysisBackend: (value: DefaultBeatAnalysisBackend) => void;
  setDefaultChordBackend: (value: DefaultChordBackend) => void;
  setDefaultStemModel: (value: DefaultStemModel) => void;
  setDefaultDurableAudioFormat: (value: DurableAudioFormat) => void;
  setDefaultLyricsFollowEnabled: (value: boolean) => void;
  setDefaultChordsFollowEnabled: (value: boolean) => void;
  setDefaultTunerInputDeviceId: (value: string | null) => void;
  setDefaultTunerReferenceHz: (value: number) => void;
  setDefaultTunerVisualMode: (value: TunerVisualMode) => void;
  replacePreferences: (value: UiPreferences) => void;
  resetAppearancePreferences: () => void;
  resetNotationPreferences: () => void;
  resetAnalysisPreferences: () => void;
  resetAudioStoragePreferences: () => void;
  resetTunerPreferences: () => void;
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
  defaultBeatAnalysisBackend: "beat-this",
  defaultChordBackend: "crema-advanced",
  defaultStemModel: "htdemucs_6s",
};

export const DEFAULT_AUDIO_STORAGE_PREFERENCES: AudioStoragePreferences = {
  defaultDurableAudioFormat: "wav",
};

export const DEFAULT_TUNER_PREFERENCES: TunerPreferences = {
  defaultTunerInputDeviceId: null,
  defaultTunerReferenceHz: DEFAULT_TUNER_REFERENCE_HZ,
  defaultTunerVisualMode: "wide-arc",
};

export const DEFAULT_VISIBILITY_PREFERENCES: VisibilityPreferences = {
  defaultInspectorOpen: true,
  defaultSourcesRailCollapsed: false,
  defaultProjectWorkspace: "project",
  defaultPlaybackDisplayMode: "auto",
  defaultLoopAlignmentMode: DEFAULT_LOOP_ALIGNMENT_MODE,
  defaultLyricsFollowEnabled: true,
  defaultChordsFollowEnabled: true,
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  appOutputGain: 1,
  appOutputMuted: false,
  countInOutputGain: 1,
  countInOutputMuted: false,
  metronomeOutputGain: 0.8,
  metronomeOutputMuted: false,
  ...DEFAULT_APPEARANCE_PREFERENCES,
  ...DEFAULT_NOTATION_PREFERENCES,
  ...DEFAULT_ANALYSIS_PREFERENCES,
  ...DEFAULT_AUDIO_STORAGE_PREFERENCES,
  ...DEFAULT_TUNER_PREFERENCES,
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

export function isDefaultBeatAnalysisBackend(value: unknown): value is DefaultBeatAnalysisBackend {
  return value === "built-in" || value === "beat-this";
}

export function isDefaultChordBackend(value: unknown): value is DefaultChordBackend {
  return value === "tuneforge-fast" || value === "crema-advanced" || value === "lv-chordia-submission";
}

export function isDefaultStemModel(value: unknown): value is DefaultStemModel {
  return value === "htdemucs_6s" || value === "htdemucs_ft";
}

function isTunerVisualMode(value: unknown): value is TunerVisualMode {
  return value === "simple" || value === "wide-arc";
}

function normalizeTunerInputDeviceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().length > 0 ? value : null;
}

export function normalizeTunerReferenceHz(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(numericValue) ||
    numericValue < MIN_TUNER_REFERENCE_HZ ||
    numericValue > MAX_TUNER_REFERENCE_HZ
  ) {
    return DEFAULT_TUNER_REFERENCE_HZ;
  }
  return Math.round(numericValue * 10) / 10;
}

export function normalizeOutputGain(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

export function normalizePreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") {
    return DEFAULT_PREFERENCES;
  }

  const candidate = value as Partial<UiPreferences>;
  return {
    appOutputGain: normalizeOutputGain(candidate.appOutputGain),
    appOutputMuted:
      typeof candidate.appOutputMuted === "boolean" ? candidate.appOutputMuted : false,
    countInOutputGain: normalizeOutputGain(candidate.countInOutputGain, 1),
    countInOutputMuted:
      typeof candidate.countInOutputMuted === "boolean" ? candidate.countInOutputMuted : false,
    metronomeOutputGain: normalizeOutputGain(candidate.metronomeOutputGain, 0.8),
    metronomeOutputMuted:
      typeof candidate.metronomeOutputMuted === "boolean" ? candidate.metronomeOutputMuted : false,
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
    defaultLoopAlignmentMode: normalizeLoopAlignmentMode(
      candidate.defaultLoopAlignmentMode,
      DEFAULT_PREFERENCES.defaultLoopAlignmentMode,
    ),
    defaultBeatAnalysisBackend: isDefaultBeatAnalysisBackend(candidate.defaultBeatAnalysisBackend)
      ? candidate.defaultBeatAnalysisBackend
      : DEFAULT_PREFERENCES.defaultBeatAnalysisBackend,
    defaultChordBackend: isDefaultChordBackend(candidate.defaultChordBackend)
      ? candidate.defaultChordBackend
      : DEFAULT_PREFERENCES.defaultChordBackend,
    defaultStemModel: isDefaultStemModel(candidate.defaultStemModel)
      ? candidate.defaultStemModel
      : DEFAULT_PREFERENCES.defaultStemModel,
    defaultDurableAudioFormat: isDurableAudioFormat(candidate.defaultDurableAudioFormat)
      ? candidate.defaultDurableAudioFormat
      : DEFAULT_PREFERENCES.defaultDurableAudioFormat,
    defaultTunerInputDeviceId: normalizeTunerInputDeviceId(candidate.defaultTunerInputDeviceId),
    defaultTunerReferenceHz: normalizeTunerReferenceHz(candidate.defaultTunerReferenceHz),
    defaultTunerVisualMode: isTunerVisualMode(candidate.defaultTunerVisualMode)
      ? candidate.defaultTunerVisualMode
      : DEFAULT_PREFERENCES.defaultTunerVisualMode,
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
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    window.queueMicrotask(() =>
      window.dispatchEvent(new CustomEvent("tuneforge:preferences-save", { detail: null })),
    );
  } catch {
    window.queueMicrotask(() =>
      window.dispatchEvent(
        new CustomEvent("tuneforge:preferences-save", {
          detail: "Audio settings changed, but could not be saved for the next launch.",
        }),
      ),
    );
  }
}

function mergePreferences(current: UiPreferences, partial: Partial<UiPreferences>) {
  const next = { ...current, ...partial };
  persistPreferences(next);
  return next;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UiPreferences>(readStoredPreferences);
  const [preferencesSaveError, setPreferencesSaveError] = useState<string | null>(null);

  useEffect(() => {
    const handleSave = (event: Event) => {
      setPreferencesSaveError((event as CustomEvent<string | null>).detail);
    };
    window.addEventListener("tuneforge:preferences-save", handleSave);
    return () => window.removeEventListener("tuneforge:preferences-save", handleSave);
  }, []);

  useLayoutEffect(() => {
    persistPreferences(preferences);
  }, [preferences]);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      ...preferences,
      preferencesSaveError,
      setAppOutputGain: (appOutputGain) => {
        if (!Number.isFinite(appOutputGain)) return;
        setPreferences((current) =>
          mergePreferences(current, { appOutputGain: normalizeOutputGain(appOutputGain) }),
        );
      },
      setAppOutputMuted: (appOutputMuted) => {
        setPreferences((current) => mergePreferences(current, { appOutputMuted }));
      },
      setCountInOutputGain: (countInOutputGain) => {
        if (!Number.isFinite(countInOutputGain)) return;
        setPreferences((current) => mergePreferences(current, {
          countInOutputGain: normalizeOutputGain(countInOutputGain),
        }));
      },
      setCountInOutputMuted: (countInOutputMuted) => {
        setPreferences((current) => mergePreferences(current, { countInOutputMuted }));
      },
      setMetronomeOutputGain: (metronomeOutputGain) => {
        if (!Number.isFinite(metronomeOutputGain)) return;
        setPreferences((current) => mergePreferences(current, {
          metronomeOutputGain: normalizeOutputGain(metronomeOutputGain, 0.8),
        }));
      },
      setMetronomeOutputMuted: (metronomeOutputMuted) => {
        setPreferences((current) => mergePreferences(current, { metronomeOutputMuted }));
      },
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
      setDefaultLoopAlignmentMode: (defaultLoopAlignmentMode) => {
        setPreferences((current) => mergePreferences(current, { defaultLoopAlignmentMode }));
      },
      setDefaultBeatAnalysisBackend: (defaultBeatAnalysisBackend) => {
        setPreferences((current) => mergePreferences(current, { defaultBeatAnalysisBackend }));
      },
      setDefaultChordBackend: (defaultChordBackend) => {
        setPreferences((current) => mergePreferences(current, { defaultChordBackend }));
      },
      setDefaultStemModel: (defaultStemModel) => {
        setPreferences((current) => mergePreferences(current, { defaultStemModel }));
      },
      setDefaultDurableAudioFormat: (defaultDurableAudioFormat) => {
        setPreferences((current) => mergePreferences(current, { defaultDurableAudioFormat }));
      },
      setDefaultLyricsFollowEnabled: (defaultLyricsFollowEnabled) => {
        setPreferences((current) => mergePreferences(current, { defaultLyricsFollowEnabled }));
      },
      setDefaultChordsFollowEnabled: (defaultChordsFollowEnabled) => {
        setPreferences((current) => mergePreferences(current, { defaultChordsFollowEnabled }));
      },
      setDefaultTunerInputDeviceId: (defaultTunerInputDeviceId) => {
        setPreferences((current) =>
          mergePreferences(current, {
            defaultTunerInputDeviceId: normalizeTunerInputDeviceId(defaultTunerInputDeviceId),
          }),
        );
      },
      setDefaultTunerReferenceHz: (defaultTunerReferenceHz) => {
        setPreferences((current) =>
          mergePreferences(current, {
            defaultTunerReferenceHz: normalizeTunerReferenceHz(defaultTunerReferenceHz),
          }),
        );
      },
      setDefaultTunerVisualMode: (defaultTunerVisualMode) => {
        setPreferences((current) => mergePreferences(current, { defaultTunerVisualMode }));
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
      resetAudioStoragePreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_AUDIO_STORAGE_PREFERENCES));
      },
      resetTunerPreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_TUNER_PREFERENCES));
      },
      resetVisibilityPreferences: () => {
        setPreferences((current) => mergePreferences(current, DEFAULT_VISIBILITY_PREFERENCES));
      },
      resetPreferences: () => {
        persistPreferences(DEFAULT_PREFERENCES);
        setPreferences(DEFAULT_PREFERENCES);
      },
    }),
    [preferences, preferencesSaveError],
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
