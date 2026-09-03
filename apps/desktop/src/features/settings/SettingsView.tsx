import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, type BeatBackendSchema, type ChordBackendSchema, type StemModelSchema } from "../../lib/api";
import { FRONTEND_VERSION_INFO } from "../../lib/buildInfo";
import { DURABLE_AUDIO_CAPABILITIES_QUERY_KEY } from "../../lib/durableAudio";
import {
  getPlaybackDiagnosticsVersion,
  readPlaybackLiveDiagnostics,
  readRememberedNativePlaybackError,
  readRememberedPlaybackBackend,
  readRememberedWebPlaybackError,
  redactPlaybackDiagnosticText,
  subscribePlaybackDiagnostics,
  type PlaybackBackend,
} from "../../lib/playbackDiagnostics";
import {
  getPowerInhibitionVersion,
  readBrowserWakeLockStatus,
  readPowerInhibitionStatus,
  readRememberedPowerInhibitionBackend,
  readRememberedPowerInhibitionError,
  refreshPowerInhibitionStatus,
  subscribePowerInhibition,
  type PowerInhibitionPhase,
  type PowerInhibitionReason,
} from "../../lib/powerInhibition";
import {
  exportNativeAudioDiagnostics,
  getNativeAudioCapabilities,
  getNativeAudioDiagnosticsAvailability,
  getNativeAudioInputPermissionStatus,
  getNativeAudioInputState,
  isAndroidRuntime,
  isWebAudioBackendForced,
  readNativeAudioDiagnostics,
  resetNativeAudioDiagnostics,
  type NativeAudioBufferHealth,
  type NativeAudioCapabilities,
  type NativeAudioInputState,
  type NativeAudioInputPermissionStatus,
} from "../../lib/nativeAudio";
import { TunerPreferenceControls } from "../tools/TunerPreferenceControls";
import {
  usePreferences,
  type DefaultBeatAnalysisBackend,
  type DefaultChordBackend,
  type DefaultPlaybackDisplayMode,
  type DefaultStemModel,
  type EnharmonicDisplayMode,
  type InformationDensity,
  type LoopAlignmentMode,
  type ProjectWorkspaceMode,
  type TunerVisualMode,
} from "../../lib/preferences";
import {
  DURABLE_AUDIO_FORMAT_PROFILES,
  durableAudioFormatIsLossy,
  durableAudioFormatLabel,
  type DurableAudioFormat,
} from "../../lib/durableAudio";
import {
  parseSettingsSnapshot,
  readSettingsSnapshotFile,
  serializeSettingsSnapshot,
  writeSettingsSnapshotFile,
} from "../../lib/settingsSnapshot";
import {
  DEFAULT_THEME_PREFERENCE,
  useTheme,
  type ThemePreference,
} from "../../lib/theme";
import {
  readRememberedTunerInputCaptureBackend,
  readRememberedTunerNativeCaptureError,
  type TunerInputCaptureBackend,
} from "../tools/tunerMicrophoneAccess";

type ChoiceOption<T extends string> = {
  disabled?: boolean;
  description: string;
  label: string;
  status?: string;
  value: T;
};

type SnapshotStatus = {
  message: string;
  tone: "default" | "error";
};

const powerInhibitionPhaseLabels: Record<PowerInhibitionPhase, string> = {
  inactive: "Inactive",
  acquiring: "Acquiring",
  active: "Active",
  unsupported: "Unsupported",
  failed: "Failed",
  releasing: "Releasing",
  "release-failed": "Release not confirmed",
};

const powerInhibitionReasonLabels: Record<PowerInhibitionReason, string> = {
  playback: "Playback",
  "sync-listener": "Sync listener",
  "sync-transfer": "Sync transfer",
  "tuner-capture": "Tuner capture",
};

function powerInhibitionBackendLabel(backend: string | null) {
  if (!backend) {
    return "None confirmed";
  }
  if (backend === "android-foreground-service") {
    return "Android foreground service";
  }
  if (backend === "android-activity-screen") {
    return "Android activity screen";
  }
  if (backend === "browser-screen-wake-lock") {
    return "Browser Screen Wake Lock";
  }
  return backend;
}

const themeOptions: ChoiceOption<ThemePreference>[] = [
  {
    value: "system",
    label: "Follow system",
    description: "Use your system theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Lower-glare workspace.",
  },
  {
    value: "light",
    label: "Light",
    description: "Brighter workspace.",
  },
];

const informationDensityOptions: ChoiceOption<InformationDensity>[] = [
  {
    value: "minimal",
    label: "Minimal",
    description: "Keep metadata quiet. Focus on transport and key shifts.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Show supporting copy and common project details.",
  },
  {
    value: "detailed",
    label: "Detailed",
    description: "Surface extra timestamps, filenames, and context.",
  },
];

const enharmonicOptions: ChoiceOption<EnharmonicDisplayMode>[] = [
  {
    value: "auto",
    label: "Auto by key",
    description: "Use spellings that fit detected harmonic context.",
  },
  {
    value: "sharps",
    label: "Prefer sharps",
    description: "Bias labels toward sharp names across project views.",
  },
  {
    value: "flats",
    label: "Prefer flats",
    description: "Bias labels toward flat names across project views.",
  },
  {
    value: "neutral",
    label: "Neutral fallback",
    description: "Use mixed spellings when context stays ambiguous.",
  },
  {
    value: "dual",
    label: "Dual labels",
    description: "Show sharp and flat spellings together.",
  },
];

const projectWorkspaceOptions: ChoiceOption<ProjectWorkspaceMode>[] = [
  {
    value: "project",
    label: "Project first",
    description: "Open with sources, mix builder, analysis, and jobs.",
  },
  {
    value: "playback",
    label: "Playback first",
    description: "Open with large lyrics, chords, transport, and stem practice controls.",
  },
];

const playbackDisplayOptions: ChoiceOption<DefaultPlaybackDisplayMode>[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Use lyrics + chords when both exist, otherwise the available practice view.",
  },
  {
    value: "combined",
    label: "Lyrics + chords",
    description: "Open Playback as a lead sheet when possible.",
  },
  {
    value: "lyrics",
    label: "Lyrics",
    description: "Open Playback focused on the lyric theater.",
  },
  {
    value: "chords",
    label: "Chords",
    description: "Open Playback focused on chord follow.",
  },
];

const loopAlignmentOptions: ChoiceOption<LoopAlignmentMode>[] = [
  {
    value: "free",
    label: "Exact",
    description: "Keep loop points where they are set.",
  },
  {
    value: "beat",
    label: "Beat",
    description: "Snap new loop points to detected beats.",
  },
  {
    value: "bar",
    label: "Bar",
    description: "Snap new loop points to inferred bar starts.",
  },
];

const fallbackBeatAnalysisBackendOptions: ChoiceOption<DefaultBeatAnalysisBackend>[] = [
  {
    value: "beat-this",
    label: "Advanced Beat Analysis",
    description: "Use the beat-this ML model for tempo and beat timing.",
  },
  {
    value: "built-in",
    label: "Built-in Beat Analysis",
    description: "Use the local librosa heuristic for tempo and beat timing.",
  },
];

const fallbackChordBackendOptions: ChoiceOption<DefaultChordBackend>[] = [
  {
    value: "crema-advanced",
    label: "Advanced Chords — Crema",
    description: "Use the crema detector with richer chord vocabulary and inversion labels.",
  },
  {
    value: "lv-chordia-submission",
    label: "LV Chordia (Submission)",
    description: "Use bundled LV Chordia submission model for desktop chord detection.",
  },
  {
    value: "tuneforge-fast",
    label: "Built-in Chords",
    description: "Use the local lightweight source and stem chord detector.",
    status: "Fallback",
  },
];

const fallbackStemModelOptions: ChoiceOption<DefaultStemModel>[] = [
  {
    value: "htdemucs_6s",
    label: "Default (6 stems model)",
    description: "Separate vocals, drums, bass, guitar, piano, and other.",
  },
  {
    value: "htdemucs_ft",
    label: "2 stems model",
    description: "Separate vocals and a single instrumental track.",
  },
];

function durableAudioFormatOptions(
  formats: Awaited<ReturnType<typeof api.getExportCapabilities>>["capabilities"]["formats"] | undefined,
  fetching: boolean,
  error: boolean,
  selected: DurableAudioFormat,
): ChoiceOption<DurableAudioFormat>[] {
  return DURABLE_AUDIO_FORMAT_PROFILES.map((profile) => {
    const capability = formats?.find((format) => format.id === profile.value);
    let status: string;
    if (fetching || formats === undefined) {
      status = "Checking availability…";
    } else if (error) {
      status = "Availability could not be checked";
    } else if (capability?.available) {
      status = profile.value === "wav"
        ? "Available · Lossless · Default"
        : `Available · ${profile.lossy ? "Lossy" : "Lossless"}`;
    } else {
      const unavailable = `Unavailable — ${capability?.reason || "Not reported by backend"}`;
      status = profile.value === selected ? `Selected · ${unavailable}` : unavailable;
    }
    return {
      value: profile.value,
      label: profile.label,
      description: profile.description,
      disabled: fetching || error || capability?.available !== true,
      status,
    };
  });
}

function themePreferenceLabel(themePreference: ThemePreference) {
  if (themePreference === "system") {
    return "Follow system";
  }
  return themePreference === "dark" ? "Dark" : "Light";
}

function themeOverrideCount(themeOverrides: Record<string, Record<string, string> | undefined>) {
  return Object.values(themeOverrides).reduce((total, modeOverrides) => total + Object.keys(modeOverrides ?? {}).length, 0);
}

function densityLabel(value: InformationDensity) {
  if (value === "minimal") return "Minimal";
  if (value === "detailed") return "Detailed";
  return "Balanced";
}

function enharmonicDisplayLabel(value: EnharmonicDisplayMode) {
  if (value === "sharps") return "Prefer sharps";
  if (value === "flats") return "Prefer flats";
  if (value === "neutral") return "Neutral fallback";
  if (value === "dual") return "Dual labels";
  return "Auto by key";
}

function projectWorkspaceLabel(value: ProjectWorkspaceMode) {
  return value === "playback" ? "Playback first" : "Project first";
}

function playbackDisplayLabel(value: DefaultPlaybackDisplayMode) {
  if (value === "auto") return "Auto";
  if (value === "combined") return "Lyrics + chords";
  if (value === "lyrics") return "Lyrics";
  return "Chords";
}

function loopAlignmentLabel(value: LoopAlignmentMode) {
  if (value === "beat") return "Beat";
  if (value === "bar") return "Bar";
  return "Exact";
}

function beatAnalysisBackendLabel(value: DefaultBeatAnalysisBackend) {
  return value === "beat-this" ? "Advanced Beat Analysis" : "Built-in Beat Analysis";
}

function chordBackendLabel(
  value: DefaultChordBackend,
  options: ChoiceOption<DefaultChordBackend>[],
) {
  return options.find((option) => option.value === value)?.label ?? "Unknown chord backend";
}

function stemModelLabel(value: DefaultStemModel) {
  return value === "htdemucs_ft" ? "2 stems model" : "Default (6 stems model)";
}

function tunerInputDeviceLabel(value: string | null) {
  return value ? "Saved microphone" : "System Default";
}

function tunerVisualModeLabel(value: TunerVisualMode) {
  return value === "simple" ? "Simple Meter" : "Wide Arc";
}

function inputCaptureBackendLabel(
  capabilities: NativeAudioCapabilities | undefined,
) {
  if (!capabilities) {
    return "Unknown";
  }
  return capabilities.micCaptureSupported ? `Available (${capabilities.backend})` : "Unavailable";
}

function inputCaptureStateLabel(state: NativeAudioInputState | undefined) {
  if (!state) return "Unknown";
  if (state.active) return "Listening";
  if (state.error) return "Error";
  if (state.permissionState === "prompting") return "Starting";
  return "Inactive";
}

function inputCapturePathLabel(state: NativeAudioInputState | undefined) {
  if (!state || state.capturePath === "none") return "None";
  return state.capturePath === "android-aaudio" ? "Android AAudio" : "Desktop CPAL";
}

function inputPermissionLabel(status: NativeAudioInputPermissionStatus | undefined) {
  if (!status) return "Unknown";
  if (status.state === "privacy-blocked") return "Privacy blocked";
  return status.state[0].toUpperCase() + status.state.slice(1);
}

function nativePlaybackCapabilityLabel(capabilities: NativeAudioCapabilities | undefined) {
  if (!capabilities) {
    return "Unknown";
  }
  if (capabilities.nativePlaybackSupported && capabilities.backend !== "android-null") {
    return `Native (${capabilities.backend})`;
  }
  const reason = capabilities.availabilityReason
    ? ` — ${redactPlaybackDiagnosticText(capabilities.availabilityReason)}`
    : "";
  return `Unavailable${reason}`;
}

function lastInputCaptureBackendLabel(backend: TunerInputCaptureBackend | null) {
  if (!backend) {
    return "Not started";
  }
  return backend.backend === "native"
    ? `Native (${backend.detail ?? "unknown"})`
    : "Web Audio";
}

function lastPlaybackBackendLabel(backend: PlaybackBackend | null) {
  if (!backend) {
    return "Not started";
  }
  return backend.backend === "native"
    ? `Native (${backend.detail ?? "unknown"})`
    : backend.mode === "forced"
      ? "Web Audio (forced)"
      : "Web Audio";
}

function currentPlaybackStateLabel(
  state: ReturnType<typeof readPlaybackLiveDiagnostics>["currentState"],
) {
  if (state === "not-playing") return "Not playing";
  return state[0].toUpperCase() + state.slice(1);
}

function currentPlaybackPathLabel(
  diagnostics: ReturnType<typeof readPlaybackLiveDiagnostics>,
  capabilities: NativeAudioCapabilities | undefined,
) {
  if (diagnostics.currentPath === "native") {
    return `Native (${diagnostics.nativeBackend ?? capabilities?.backend ?? "unknown"})`;
  }
  if (diagnostics.currentPath === "web-forced") {
    return "Web Audio (forced)";
  }
  if (diagnostics.currentPath === "web") {
    return "Web Audio";
  }
  return "None";
}

function nativePlaybackHealthLabel(health: NativeAudioBufferHealth[] | undefined) {
  if (!health?.length) {
    return "No active native lanes";
  }
  return health
    .map((lane, index) => {
      const label = `Lane ${index + 1} (${lane.role.replace("_", " ")})`;
      const fillPercent =
        lane.ringCapacitySamples > 0
          ? Math.round((lane.ringFillSamples / lane.ringCapacitySamples) * 100)
          : 0;
      const error = lane.lastWorkerError
        ? `, last worker error: ${redactPlaybackDiagnosticText(lane.lastWorkerError)}`
        : "";
      const underrunLabel = lane.underrunCount === 1 ? "underrun" : "underruns";
      const workerErrorLabel = lane.workerErrorCount === 1 ? "worker error" : "worker errors";
      return `${label}: ${fillPercent}% buffer, ${lane.underrunCount} ${underrunLabel}, ${lane.workerErrorCount} ${workerErrorLabel}${error}`;
    })
    .join(" / ");
}

function diagnosticVersionValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : "Unknown";
}

function chordBackendOptions(
  backends: ChordBackendSchema[] | undefined,
  fetching: boolean,
  error: boolean,
  selected: DefaultChordBackend,
): ChoiceOption<DefaultChordBackend>[] {
  if (backends === undefined) {
    return fallbackChordBackendOptions.map((option) => ({
      ...option,
      disabled: true,
      status: error ? "Availability could not be checked" : "Checking availability",
    }));
  }

  return fallbackChordBackendOptions.map((fallback) => {
    const backend = backends.find((candidate) => candidate.id === fallback.value);
    if (!backend) {
      return {
        ...fallback,
        disabled: true,
        status: "Missing from backend registry",
      };
    }
    const unavailableReason = backend.available
      ? null
      : `Unavailable — ${backend.unavailable_reason || "Not reported by backend"}`;
    return {
      value: fallback.value,
      label: backend.label,
      description: fallback.description,
      disabled: fetching || error || !backend.available,
      status: fetching
        ? "Checking availability…"
        : error
          ? "Availability could not be checked"
          : unavailableReason
        ? fallback.value === selected ? `Selected · ${unavailableReason}` : unavailableReason
        : fallback.value === "tuneforge-fast" ? "Import fallback" : undefined,
    };
  });
}

function beatBackendOptions(backends: BeatBackendSchema[] | undefined): ChoiceOption<DefaultBeatAnalysisBackend>[] {
  if (backends === undefined) {
    return fallbackBeatAnalysisBackendOptions.map((option) => ({
      ...option,
      disabled: true,
      status: "Checking availability",
    }));
  }

  return fallbackBeatAnalysisBackendOptions.map((fallback) => {
    const backend = backends.find((candidate) => candidate.id === fallback.value);
    if (!backend) {
      return {
        ...fallback,
        disabled: true,
        status: "Missing from backend registry",
      };
    }
    const unavailableReason = backend.available ? null : backend.unavailable_reason;
    return {
      value: fallback.value,
      label: backend.label,
      description: fallback.description,
      disabled: !backend.available,
      status: unavailableReason ?? undefined,
    };
  });
}

function effectiveChoiceValue<T extends string>(
  value: T,
  options: ChoiceOption<T>[],
  fallback: T,
  availabilityResolved: boolean,
) {
  if (!availabilityResolved) {
    return value;
  }
  if (options.some((option) => option.value === value && !option.disabled)) {
    return value;
  }
  if (options.some((option) => option.value === fallback && !option.disabled)) {
    return fallback;
  }
  return null;
}

function stemModelOptions(models: StemModelSchema[] | undefined): ChoiceOption<DefaultStemModel>[] {
  if (!models?.length) {
    return fallbackStemModelOptions;
  }
  return models
    .filter((model): model is StemModelSchema & { id: DefaultStemModel } =>
      model.id === "htdemucs_6s" || model.id === "htdemucs_ft",
    )
    .map((model) => ({
      value: model.id,
      label: model.label,
      description: model.description,
      disabled: !model.available,
      status: model.available ? `${model.sourceCount} stems` : "Unavailable",
    }));
}

function ChoiceGroup<T extends string>({
  ariaBusy,
  description,
  fieldsetRef,
  legend,
  liveStatus,
  onChange,
  options,
  value,
}: {
  ariaBusy?: boolean;
  description: string;
  fieldsetRef?: RefObject<HTMLFieldSetElement | null>;
  legend: string;
  liveStatus?: string;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
  value: T | null;
}) {
  return (
    <fieldset
      ref={fieldsetRef}
      aria-busy={ariaBusy || undefined}
      className="settings-fieldset"
      tabIndex={fieldsetRef ? -1 : undefined}
    >
      <legend>{legend}</legend>
      <p className="setting-copy">{description}</p>
      {liveStatus ? <p className="setting-copy" role="status">{liveStatus}</p> : null}
      <div className="settings-choice-grid">
        {options.map((option) => (
          <button
            key={option.value}
            aria-pressed={value === option.value}
            disabled={option.disabled}
            className="settings-choice"
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span className="settings-choice__label">{option.label}</span>
            <span className="settings-choice__copy">{option.description}</span>
            {option.status ? <span className="settings-choice__copy">{option.status}</span> : null}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function PreferenceToggle({
  description,
  label,
  onChange,
  value,
}: {
  description: string;
  label: string;
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <button
      aria-pressed={value}
      className={`settings-toggle${value ? " settings-toggle--active" : ""}`}
      onClick={() => onChange(!value)}
      type="button"
    >
      <span className="settings-toggle__body">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <span className="settings-toggle__state">{value ? "On" : "Off"}</span>
    </button>
  );
}

export function SettingsView() {
  const {
    effectiveTheme,
    replaceThemeState,
    resetThemeOverrides,
    themeOverrides,
    themePreference,
    setThemePreference,
  } = useTheme();
  const {
    informationDensity,
    enharmonicDisplayMode,
    defaultInspectorOpen,
    defaultSourcesRailCollapsed,
    defaultProjectWorkspace,
    defaultPlaybackDisplayMode,
    defaultLoopAlignmentMode,
    defaultBeatAnalysisBackend,
    defaultChordBackend,
    defaultStemModel,
    defaultDurableAudioFormat,
    defaultLyricsFollowEnabled,
    defaultChordsFollowEnabled,
    defaultTunerInputDeviceId,
    defaultTunerReferenceHz,
    defaultTunerVisualMode,
    setInformationDensity,
    setEnharmonicDisplayMode,
    setDefaultProjectWorkspace,
    setDefaultPlaybackDisplayMode,
    setDefaultLoopAlignmentMode,
    setDefaultBeatAnalysisBackend,
    setDefaultChordBackend,
    setDefaultStemModel,
    setDefaultDurableAudioFormat,
    setDefaultLyricsFollowEnabled,
    setDefaultChordsFollowEnabled,
    setDefaultTunerInputDeviceId,
    setDefaultTunerReferenceHz,
    setDefaultTunerVisualMode,
    resetAppearancePreferences,
    resetNotationPreferences,
    resetAnalysisPreferences,
    resetAudioStoragePreferences,
    resetTunerPreferences,
    resetVisibilityPreferences,
    resetPreferences,
    replacePreferences,
  } = usePreferences();
  const [isSnapshotBusy, setIsSnapshotBusy] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
  const [chordAvailabilityStatus, setChordAvailabilityStatus] = useState<string | null>(null);
  const chordBackendGroupRef = useRef<HTMLFieldSetElement>(null);
  const [availabilityRetrying, setAvailabilityRetrying] = useState(false);
  const [isNativeValidationBusy, setIsNativeValidationBusy] = useState(false);
  const [nativeValidationStatus, setNativeValidationStatus] = useState<SnapshotStatus | null>(null);
  const tauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const webAudioForced = tauriRuntime && isWebAudioBackendForced();
  const normalTauriAudio = tauriRuntime && !webAudioForced;
  const androidRuntime = isAndroidRuntime();
  useSyncExternalStore(
    subscribePlaybackDiagnostics,
    getPlaybackDiagnosticsVersion,
    getPlaybackDiagnosticsVersion,
  );
  useSyncExternalStore(
    subscribePowerInhibition,
    getPowerInhibitionVersion,
    getPowerInhibitionVersion,
  );
  const livePlaybackDiagnostics = readPlaybackLiveDiagnostics();
  const powerInhibitionStatus = readPowerInhibitionStatus();
  const browserWakeLockStatus = readBrowserWakeLockStatus();
  const rememberedPowerBackend = readRememberedPowerInhibitionBackend();
  const rememberedPowerError = readRememberedPowerInhibitionError();
  useEffect(() => {
    void refreshPowerInhibitionStatus();
  }, []);
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
  });
  const chordBackendsQuery = useQuery({
    queryKey: ["chord-backends"],
    queryFn: api.listChordBackends,
  });
  const beatBackendsQuery = useQuery({
    queryKey: ["beat-backends"],
    queryFn: api.listBeatBackends,
  });
  const stemModelsQuery = useQuery({
    queryKey: ["stem-models"],
    queryFn: api.listStemModels,
  });
  const exportCapabilitiesQuery = useQuery({
    enabled: !androidRuntime,
    queryKey: DURABLE_AUDIO_CAPABILITIES_QUERY_KEY,
    queryFn: api.getExportCapabilities,
    staleTime: Infinity,
  });
  const nativeAudioQuery = useQuery({
    enabled: normalTauriAudio,
    queryKey: ["native-audio-capabilities"],
    queryFn: getNativeAudioCapabilities,
  });
  const nativeDiagnosticsAvailabilityQuery = useQuery({
    enabled: normalTauriAudio,
    queryKey: ["native-audio-diagnostics-availability"],
    queryFn: getNativeAudioDiagnosticsAvailability,
  });
  const nativeDiagnosticsQuery = useQuery({
    enabled: normalTauriAudio && nativeDiagnosticsAvailabilityQuery.data?.enabled === true,
    queryKey: ["native-audio-diagnostics"],
    queryFn: readNativeAudioDiagnostics,
  });
  const nativeInputQuery = useQuery({
    enabled: normalTauriAudio,
    queryKey: ["native-audio-input-state"],
    queryFn: getNativeAudioInputState,
  });
  const nativePermissionQuery = useQuery({
    enabled: normalTauriAudio,
    queryKey: ["native-audio-input-permission"],
    queryFn: getNativeAudioInputPermissionStatus,
  });
  const lastInputCaptureBackend = readRememberedTunerInputCaptureBackend();
  const lastNativeCaptureError = readRememberedTunerNativeCaptureError();
  const lastPlaybackBackend = readRememberedPlaybackBackend();
  const lastNativePlaybackError = readRememberedNativePlaybackError();
  const latestWebPlaybackError = readRememberedWebPlaybackError();
  const savedThemeOverrideCount = themeOverrideCount(themeOverrides);
  const beatAvailabilityResolved = beatBackendsQuery.data?.backends !== undefined;
  const beatBackendChoices = beatBackendOptions(beatBackendsQuery.data?.backends);
  const effectiveBeatAnalysisBackend = effectiveChoiceValue(
    defaultBeatAnalysisBackend,
    beatBackendChoices,
    "built-in",
    beatAvailabilityResolved,
  );
  const chordBackendChoices = chordBackendOptions(
    chordBackendsQuery.data?.backends,
    chordBackendsQuery.isFetching,
    chordBackendsQuery.isError,
    defaultChordBackend,
  );
  const stemModelChoices = stemModelOptions(stemModelsQuery.data?.models);
  const durableAudioChoices = durableAudioFormatOptions(
    exportCapabilitiesQuery.data?.capabilities.formats,
    exportCapabilitiesQuery.isFetching,
    exportCapabilitiesQuery.isError,
    defaultDurableAudioFormat,
  );
  const androidSettings =
    androidRuntime || exportCapabilitiesQuery.data?.capabilities.platform === "android";
  const showAudioStoragePanel = !androidSettings;
  const chordFallbackNotice =
    "Imports may use Built-in Chords if the saved backend is unavailable; generate, refresh, and bulk actions keep the saved backend.";

  function handleResetAppearance() {
    setThemePreference(DEFAULT_THEME_PREFERENCE);
    resetThemeOverrides();
    resetAppearancePreferences();
  }

  function handleResetPlaybackDefaults() {
    resetVisibilityPreferences();
  }

  function handleResetNotation() {
    resetNotationPreferences();
  }

  function handleResetAnalysis() {
    resetAnalysisPreferences();
  }

  async function handleChordAvailabilityRetry() {
    setChordAvailabilityStatus(null);
    const result = await chordBackendsQuery.refetch();
    if (result.isSuccess) {
      setChordAvailabilityStatus("Chord backend availability updated.");
      chordBackendGroupRef.current?.focus();
    }
  }

  function handleResetAudioStorage() {
    resetAudioStoragePreferences();
  }

  async function confirmLossyDurableAudioFormat(format: DurableAudioFormat) {
    if (durableAudioFormatIsLossy(format)) {
      const label = durableAudioFormatLabel(format);
      const shortLabel = format === "mp3" ? "MP3" : "M4A";
      const approved = await confirm(
        `${label} uses irreversible lossy compression that permanently removes audio detail. That detail cannot be recovered later. This applies only to new imports, stems, saved mixes, and bulk stem refreshes; existing files and queued work stay unchanged.`,
        {
          title: `Use ${label}?`,
          kind: "warning",
          okLabel: `Use ${shortLabel}`,
          cancelLabel: "Cancel",
        },
      );
      if (!approved) {
        return false;
      }
    }
    return true;
  }

  async function handleDurableAudioFormatChange(format: DurableAudioFormat) {
    if (format === defaultDurableAudioFormat || !await confirmLossyDurableAudioFormat(format)) {
      return;
    }
    setDefaultDurableAudioFormat(format);
  }

  function handleResetTunerDefaults() {
    resetTunerPreferences();
  }

  function handleResetAllSettings() {
    setThemePreference(DEFAULT_THEME_PREFERENCE);
    resetThemeOverrides();
    resetPreferences();
  }

  async function handleExportSettings() {
    setIsSnapshotBusy(true);
    setSnapshotStatus(null);

    try {
      const defaultFileName = `tuneforge-settings-${new Date().toISOString().slice(0, 10)}.json`;
      const contents = serializeSettingsSnapshot({
        preferences: {
          defaultChordsFollowEnabled,
          defaultBeatAnalysisBackend,
          defaultChordBackend,
          defaultLoopAlignmentMode,
          defaultStemModel,
          defaultDurableAudioFormat,
          defaultInspectorOpen,
          defaultPlaybackDisplayMode,
          defaultTunerInputDeviceId,
          defaultTunerReferenceHz,
          defaultTunerVisualMode,
          defaultLyricsFollowEnabled,
          defaultProjectWorkspace,
          defaultSourcesRailCollapsed,
          enharmonicDisplayMode,
          informationDensity,
        },
        themeOverrides,
        themePreference,
      });

      const exported = await writeSettingsSnapshotFile(defaultFileName, contents);
      if (!exported) {
        return;
      }

      setSnapshotStatus({ message: "Settings exported.", tone: "default" });
    } catch (error) {
      setSnapshotStatus({
        message: error instanceof Error ? error.message : "Could not export settings.",
        tone: "error",
      });
    } finally {
      setIsSnapshotBusy(false);
    }
  }

  async function handleImportSettings() {
    setIsSnapshotBusy(true);
    setSnapshotStatus(null);

    try {
      const contents = await readSettingsSnapshotFile();
      if (contents === null) {
        return;
      }

      const snapshot = parseSettingsSnapshot(contents);
      if (
        !androidSettings
        && snapshot.preferences.defaultDurableAudioFormat !== defaultDurableAudioFormat
        && !await confirmLossyDurableAudioFormat(snapshot.preferences.defaultDurableAudioFormat)
      ) {
        return;
      }

      replaceThemeState({
        themeOverrides: snapshot.themeOverrides,
        themePreference: snapshot.themePreference,
      });
      replacePreferences(snapshot.preferences);
      setSnapshotStatus({ message: "Settings imported.", tone: "default" });
    } catch (error) {
      setSnapshotStatus({
        message: error instanceof Error ? error.message : "Could not import settings.",
        tone: "error",
      });
    } finally {
      setIsSnapshotBusy(false);
    }
  }

  async function handleRetryAudioAvailability() {
    if (availabilityRetrying || exportCapabilitiesQuery.isFetching) {
      return;
    }
    setAvailabilityRetrying(true);
    try {
      await exportCapabilitiesQuery.refetch();
    } finally {
      setAvailabilityRetrying(false);
    }
  }

  async function handleResetNativeValidation() {
    setIsNativeValidationBusy(true);
    setNativeValidationStatus(null);
    try {
      await resetNativeAudioDiagnostics();
      await nativeDiagnosticsQuery.refetch();
      setNativeValidationStatus({ message: "Local diagnostic counters reset.", tone: "default" });
    } catch (error) {
      setNativeValidationStatus({
        message: error instanceof Error ? error.message : "Native audio diagnostics could not reset.",
        tone: "error",
      });
    } finally {
      setIsNativeValidationBusy(false);
    }
  }

  async function handleExportNativeValidation() {
    setIsNativeValidationBusy(true);
    setNativeValidationStatus(null);
    try {
      const exported = await exportNativeAudioDiagnostics();
      if (exported) {
        setNativeValidationStatus({ message: "Sanitized diagnostics exported.", tone: "default" });
      }
    } catch (error) {
      setNativeValidationStatus({
        message: error instanceof Error ? error.message : "Native audio diagnostics could not export.",
        tone: "error",
      });
    } finally {
      setIsNativeValidationBusy(false);
    }
  }

  return (
    <section className="screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Settings</p>
          <h1>Control Room</h1>
          <p className="screen__subtitle">
            {androidSettings
              ? "App-wide appearance, notation, and playback defaults."
              : "App-wide appearance, audio storage, notation, and playback defaults."}
          </p>
        </div>
      </div>

      <div className="panel settings-overview">
        <div className="settings-overview__copy">
          <p className="eyebrow">Sections</p>
          <h2>Core defaults</h2>
          <div className="settings-pill-row" aria-label="Settings scope">
            <span className="pill">Theme</span>
            <span className="pill">Density</span>
            <span className="pill">Musical notation</span>
            <span className="pill">Tuner</span>
            <span className="pill">Beat analysis</span>
            <span className="pill">Chord backend</span>
            <span className="pill">Stem model</span>
            {showAudioStoragePanel ? <span className="pill">Audio storage</span> : null}
            <span className="pill">Playback defaults</span>
          </div>
        </div>

        <dl className="settings-overview__stats">
          <div className="settings-overview__stat">
            <dt>Theme</dt>
            <dd>{themePreferenceLabel(themePreference)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Active theme</dt>
            <dd>{themePreferenceLabel(effectiveTheme)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Density</dt>
            <dd>{densityLabel(informationDensity)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Musical notation</dt>
            <dd>{enharmonicDisplayLabel(enharmonicDisplayMode)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>First project workspace</dt>
            <dd>{projectWorkspaceLabel(defaultProjectWorkspace)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Playback view</dt>
            <dd>{playbackDisplayLabel(defaultPlaybackDisplayMode)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Loop alignment</dt>
            <dd>{loopAlignmentLabel(defaultLoopAlignmentMode)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Beat analysis</dt>
            <dd>
              {effectiveBeatAnalysisBackend === null
                ? "No available backend"
                : beatAnalysisBackendLabel(effectiveBeatAnalysisBackend)}
            </dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Chord backend</dt>
            <dd>
              {chordBackendLabel(defaultChordBackend, chordBackendChoices)}
              <span>{chordFallbackNotice}</span>
            </dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Stem model</dt>
            <dd>{stemModelLabel(defaultStemModel)}</dd>
          </div>
          {showAudioStoragePanel ? (
            <div className="settings-overview__stat">
              <dt>New audio format</dt>
              <dd>{durableAudioFormatLabel(defaultDurableAudioFormat)}</dd>
            </div>
          ) : null}
          <div className="settings-overview__stat">
            <dt>Tuner mic</dt>
            <dd>{tunerInputDeviceLabel(defaultTunerInputDeviceId)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>A4 reference</dt>
            <dd>{defaultTunerReferenceHz.toFixed(1)} Hz</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Default tuner</dt>
            <dd>{tunerVisualModeLabel(defaultTunerVisualMode)}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Playback follow</dt>
            <dd>
              {defaultLyricsFollowEnabled && defaultChordsFollowEnabled
                ? "Lyrics + chords"
                : defaultLyricsFollowEnabled
                  ? "Lyrics only"
                  : defaultChordsFollowEnabled
                    ? "Chords only"
                    : "Manual"}
            </dd>
          </div>
        </dl>
      </div>

      {showAudioStoragePanel ? (
        <div className="panel settings-panel" aria-labelledby="audio-storage-title">
          <div className="panel-heading">
            <div>
              <h2 id="audio-storage-title">Audio Storage</h2>
              <p className="subpanel__copy">
                Choose the storage format for new audio created on this desktop.
              </p>
            </div>
          </div>

          <ChoiceGroup
            ariaBusy={exportCapabilitiesQuery.isFetching}
            description="The format is captured when an action starts. Future imports, stems, saved mixes, and bulk stem refreshes use it; existing files and already queued work stay unchanged. Temporary processing audio remains WAV."
            legend="New durable audio format"
            onChange={(format) => void handleDurableAudioFormatChange(format)}
            options={durableAudioChoices}
            value={defaultDurableAudioFormat}
          />

          {exportCapabilitiesQuery.isFetching ? (
            <p aria-live="polite" className="settings-feedback" role="status">
              Checking audio format availability…
            </p>
          ) : null}
          {exportCapabilitiesQuery.isError || availabilityRetrying ? (
            <>
              {!exportCapabilitiesQuery.isFetching ? (
                <p className="settings-feedback settings-feedback--error" role="alert">
                  Audio format availability could not be checked. Check FFmpeg, then try again.
                </p>
              ) : null}
              <div className="button-row">
                <button
                  className="button button--ghost button--small"
                  disabled={exportCapabilitiesQuery.isFetching}
                  onClick={() => void handleRetryAudioAvailability()}
                  type="button"
                >
                  Retry
                </button>
              </div>
            </>
          ) : null}

          {exportCapabilitiesQuery.isSuccess && !exportCapabilitiesQuery.isFetching
          && exportCapabilitiesQuery.data.capabilities.formats.find(
            (format) => format.id === defaultDurableAudioFormat && !format.available,
          ) ? (
            <p className="settings-feedback settings-feedback--error" role="status">
              {durableAudioFormatLabel(defaultDurableAudioFormat)} is saved but unavailable on this desktop:{" "}
              {exportCapabilitiesQuery.data.capabilities.formats.find(
                (format) => format.id === defaultDurableAudioFormat,
              )?.reason?.replace(/\.+$/, "") || "Not reported by backend"}. Choose an available format before creating new audio.
            </p>
          ) : null}

          <div className="button-row">
            <button className="button button--ghost button--small" onClick={handleResetAudioStorage} type="button">
              Reset Audio Storage
            </button>
          </div>
        </div>
      ) : null}

      <div className="settings-column">
        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Appearance</h2>
              <p className="subpanel__copy">
                Theme, density, and Theme Studio overrides.
                {" "}
                {savedThemeOverrideCount}
                {" "}
                saved.
              </p>
            </div>
          </div>

          <div className="settings-stack">
            <ChoiceGroup
              description="Choose light, dark, or system theme."
              legend="Theme"
              onChange={setThemePreference}
              options={themeOptions}
              value={themePreference}
            />

            <div className="button-row">
              <Link className="button button--ghost button--small" to="/settings/theme-studio">
                Open Theme Studio
              </Link>
            </div>

            <ChoiceGroup
              description="Choose how much supporting detail to show."
              legend="Information density"
              onChange={setInformationDensity}
              options={informationDensityOptions}
              value={informationDensity}
            />
          </div>

          <div className="button-row">
            <button className="button button--ghost button--small" onClick={handleResetAppearance} type="button">
              Reset Appearance
            </button>
          </div>
        </div>

        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Tuner Defaults</h2>
              <p className="subpanel__copy">Default microphone source, A4 reference, and tuner view.</p>
            </div>
          </div>

          <TunerPreferenceControls
            inputDeviceId={defaultTunerInputDeviceId}
            nativeCaptureDisabled={!normalTauriAudio}
            onInputDeviceChange={setDefaultTunerInputDeviceId}
            onReferenceHzChange={setDefaultTunerReferenceHz}
            onVisualModeChange={setDefaultTunerVisualMode}
            referenceHz={defaultTunerReferenceHz}
            systemDefaultOnly={webAudioForced || isAndroidRuntime() || nativeAudioQuery.data?.platform === "android"}
            visualMode={defaultTunerVisualMode}
          />

          <div className="button-row">
            <button className="button button--ghost button--small" onClick={handleResetTunerDefaults} type="button">
              Reset Tuner Defaults
            </button>
          </div>
        </div>

        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Musical Notation</h2>
              <p className="subpanel__copy">How keys and chords are spelled.</p>
            </div>
          </div>

          <ChoiceGroup
            description="Choose accidental spelling across playback and selectors."
            legend="Enharmonic display"
            onChange={setEnharmonicDisplayMode}
            options={enharmonicOptions}
            value={enharmonicDisplayMode}
          />

          <div className="button-row">
            <button className="button button--ghost button--small" onClick={handleResetNotation} type="button">
              Reset Notation
            </button>
          </div>
        </div>

        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Analysis Defaults</h2>
              <p className="subpanel__copy">Default engines for generated project analysis.</p>
            </div>
          </div>

          <ChoiceGroup
            description="Choose the backend used when generating tempo and beat timing."
            legend="Default beat analysis"
            onChange={setDefaultBeatAnalysisBackend}
            options={beatBackendChoices}
            value={effectiveBeatAnalysisBackend}
          />

          <ChoiceGroup
            ariaBusy={chordBackendsQuery.isFetching}
            description="Choose default backend for new imports and chord generation. Imports may use Built-in Chords when selected backend is unavailable; generate, refresh, and bulk actions do not switch backends."
            fieldsetRef={chordBackendGroupRef}
            legend="Default chord backend"
            liveStatus={chordBackendsQuery.isFetching
              ? "Checking chord backend availability…"
              : chordAvailabilityStatus ?? undefined}
            onChange={setDefaultChordBackend}
            options={chordBackendChoices}
            value={defaultChordBackend}
          />

          {chordBackendsQuery.isError ? (
            <div className="settings-feedback settings-feedback--error" role="alert">
              <span>Chord backend availability could not be checked. Saved selection was preserved.</span>
              <button
                className="button button--ghost button--small"
                disabled={chordBackendsQuery.isFetching}
                onClick={() => void handleChordAvailabilityRetry()}
                type="button"
              >
                Retry availability
              </button>
            </div>
          ) : null}

          <ChoiceGroup
            description="Choose the Demucs model used when generating stems."
            legend="Default stem model"
            onChange={setDefaultStemModel}
            options={stemModelChoices}
            value={defaultStemModel}
          />

          <div className="button-row">
            <button className="button button--ghost button--small" onClick={handleResetAnalysis} type="button">
              Reset Analysis Defaults
            </button>
          </div>
        </div>

        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Playback Defaults</h2>
              <p className="subpanel__copy">Default project view state.</p>
            </div>
          </div>

          <ChoiceGroup
            description="Choose which workspace a project uses before it has saved its own last-open state."
            legend="First-open workspace"
            onChange={setDefaultProjectWorkspace}
            options={projectWorkspaceOptions}
            value={defaultProjectWorkspace}
          />

          <ChoiceGroup
            description="Choose the Playback practice view before a project has saved its own display mode."
            legend="First-open playback view"
            onChange={setDefaultPlaybackDisplayMode}
            options={playbackDisplayOptions}
            value={defaultPlaybackDisplayMode}
          />

          <ChoiceGroup
            description="Choose how new project loops align before that project stores its own mode."
            legend="Default loop alignment"
            onChange={setDefaultLoopAlignmentMode}
            options={loopAlignmentOptions}
            value={defaultLoopAlignmentMode}
          />

          <div className="settings-toggle-list">
            <PreferenceToggle
              description="Start each project with lyrics follow enabled until that project stores its own setting."
              label="Enable lyrics follow by default"
              onChange={setDefaultLyricsFollowEnabled}
              value={defaultLyricsFollowEnabled}
            />
            <PreferenceToggle
              description="Start each project with chord follow enabled until that project stores its own setting."
              label="Enable chords follow by default"
              onChange={setDefaultChordsFollowEnabled}
              value={defaultChordsFollowEnabled}
            />
          </div>

          <div className="button-row">
            <button className="button button--ghost button--small" onClick={handleResetPlaybackDefaults} type="button">
              Reset Playback Defaults
            </button>
          </div>
        </div>
      </div>

      <div className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Local Data</h2>
            <p className="subpanel__copy">
              Settings backup and backend diagnostics. Resetting settings does not clear per-project playback memory.
            </p>
          </div>
        </div>

        <details className="details-block settings-details">
          <summary>Show diagnostics</summary>
          <div className="settings-diagnostics">
            <section className="settings-diagnostics__group" aria-labelledby="diagnostics-configuration">
              <h3 id="diagnostics-configuration">Configuration</h3>
              <dl className="details-grid details-grid--single-column">
                <div>
                  <dt>Status</dt>
                  <dd>{healthQuery.data?.status ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Backend Package Version</dt>
                  <dd>{diagnosticVersionValue(healthQuery.data?.backend_version?.package_version)}</dd>
                </div>
                <div>
                  <dt>Backend Git Ref</dt>
                  <dd className="path">
                    {diagnosticVersionValue(healthQuery.data?.backend_version?.git_ref ?? healthQuery.data?.version)}
                  </dd>
                </div>
                <div>
                  <dt>Frontend Package Version</dt>
                  <dd>{diagnosticVersionValue(FRONTEND_VERSION_INFO.package_version)}</dd>
                </div>
                <div>
                  <dt>Frontend Git Ref</dt>
                  <dd className="path">{diagnosticVersionValue(FRONTEND_VERSION_INFO.git_ref)}</dd>
                </div>
                <div>
                  <dt>API Base URL</dt>
                  <dd>{healthQuery.data?.api_base_url ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Storage Root</dt>
                  <dd className="path">{healthQuery.data?.data_root ?? "Backend unavailable"}</dd>
                </div>
                <div>
                  <dt>Preview Format</dt>
                  <dd>{healthQuery.data?.preview_format ?? "wav"}</dd>
                </div>
                <div>
                  <dt>Default Export Format</dt>
                  <dd>{healthQuery.data?.default_export_format ?? "wav"}</dd>
                </div>
                <div>
                  <dt>Native Capture Capability</dt>
                  <dd>{inputCaptureBackendLabel(nativeAudioQuery.data)}</dd>
                </div>
                <div>
                  <dt>Capture Selection Policy</dt>
                  <dd>{webAudioForced ? "Web Audio (forced)" : normalTauriAudio ? "Native required" : "Web Audio"}</dd>
                </div>
                <div>
                  <dt>Current Microphone Permission</dt>
                  <dd>{inputPermissionLabel(nativePermissionQuery.data)}</dd>
                </div>
                <div>
                  <dt>Current Capture State</dt>
                  <dd>{inputCaptureStateLabel(nativeInputQuery.data)}</dd>
                </div>
                <div>
                  <dt>Current Capture Path</dt>
                  <dd>{inputCapturePathLabel(nativeInputQuery.data)}</dd>
                </div>
                <div>
                  <dt>Last Confirmed Capture Path</dt>
                  <dd>{lastInputCaptureBackendLabel(lastInputCaptureBackend)}</dd>
                </div>
                <div>
                  <dt>Latest Safe Capture Failure</dt>
                  <dd>{lastNativeCaptureError ?? "None"}</dd>
                </div>
                <div>
                  <dt>Audio Override</dt>
                  <dd>{webAudioForced ? "Web Audio forced at build time" : "None"}</dd>
                </div>
                <div>
                  <dt>Native Playback Capability</dt>
                  <dd>{nativePlaybackCapabilityLabel(nativeAudioQuery.data)}</dd>
                </div>
                <div>
                  <dt>Playback Selection Policy</dt>
                  <dd>{webAudioForced ? "Web Audio (forced)" : normalTauriAudio ? "Native required" : "Web Audio"}</dd>
                </div>
              </dl>
            </section>

            <section className="settings-diagnostics__group" aria-labelledby="diagnostics-current-playback">
              <h3 id="diagnostics-current-playback">Current Playback</h3>
              <dl className="details-grid details-grid--single-column">
                <div>
                  <dt>Current Playback State</dt>
                  <dd>{currentPlaybackStateLabel(livePlaybackDiagnostics.currentState)}</dd>
                </div>
                <div>
                  <dt>Current Playback Path</dt>
                  <dd>{currentPlaybackPathLabel(livePlaybackDiagnostics, nativeAudioQuery.data)}</dd>
                </div>
                <div>
                  <dt>Native Session</dt>
                  <dd>
                    {livePlaybackDiagnostics.nativeSessionLaneCount === null
                      ? "None"
                      : `Active (${livePlaybackDiagnostics.nativeSessionLaneCount} ${
                          livePlaybackDiagnostics.nativeSessionLaneCount === 1 ? "lane" : "lanes"
                        })`}
                  </dd>
                </div>
                <div>
                  <dt>Native Playback Buffer Health</dt>
                  <dd>{nativePlaybackHealthLabel(livePlaybackDiagnostics.nativeBufferHealth)}</dd>
                </div>
              </dl>
            </section>

            <section className="settings-diagnostics__group" aria-labelledby="diagnostics-power-protection">
              <h3 id="diagnostics-power-protection">Power Protection</h3>
              <dl className="details-grid details-grid--single-column">
                <div>
                  <dt>Current State</dt>
                  <dd>{powerInhibitionPhaseLabels[powerInhibitionStatus.phase]}</dd>
                </div>
                <div>
                  <dt>Native Backend</dt>
                  <dd>{powerInhibitionBackendLabel(powerInhibitionStatus.backend)}</dd>
                </div>
                <div>
                  <dt>Active Reasons</dt>
                  <dd>
                    {powerInhibitionStatus.activeReasons.length
                      ? powerInhibitionStatus.activeReasons
                          .map((reason) => powerInhibitionReasonLabels[reason])
                          .join(", ")
                      : "None"}
                  </dd>
                </div>
                <div>
                  <dt>Native Screen Protected</dt>
                  <dd>{powerInhibitionStatus.screenProtected ? "Confirmed" : "Not confirmed"}</dd>
                </div>
                <div>
                  <dt>Native Background Protected</dt>
                  <dd>{powerInhibitionStatus.backgroundProtected ? "Confirmed" : "Not confirmed"}</dd>
                </div>
                <div>
                  <dt>Browser Screen Wake Lock State</dt>
                  <dd>{powerInhibitionPhaseLabels[browserWakeLockStatus.phase]}</dd>
                </div>
                <div>
                  <dt>Browser Screen Wake Lock Backend</dt>
                  <dd>{powerInhibitionBackendLabel(browserWakeLockStatus.backend)}</dd>
                </div>
                <div>
                  <dt>Browser Screen Protected</dt>
                  <dd>{browserWakeLockStatus.screenProtected ? "Confirmed" : "Not confirmed"}</dd>
                </div>
                <div>
                  <dt>Last Confirmed Backend</dt>
                  <dd>{rememberedPowerBackend ? powerInhibitionBackendLabel(rememberedPowerBackend) : "None"}</dd>
                </div>
                <div>
                  <dt>Latest Power Protection Error</dt>
                  <dd>{powerInhibitionStatus.errorMessage ?? rememberedPowerError ?? "None"}</dd>
                </div>
              </dl>
            </section>

            <section className="settings-diagnostics__group" aria-labelledby="diagnostics-previous-issues">
              <h3 id="diagnostics-previous-issues">Previous Playback Issues</h3>
              <dl className="details-grid details-grid--single-column">
                <div>
                  <dt>Last Confirmed Playback Path</dt>
                  <dd>{lastPlaybackBackendLabel(lastPlaybackBackend)}</dd>
                </div>
                <div>
                  <dt>Latest Native Playback Failure</dt>
                  <dd>{lastNativePlaybackError ?? "None"}</dd>
                </div>
                <div>
                  <dt>Latest Web Media Failure</dt>
                  <dd>{latestWebPlaybackError ?? "None"}</dd>
                </div>
              </dl>
            </section>
          </div>
        </details>

        <div className="button-row">
          <button
            className="button button--ghost button--small"
            disabled={isSnapshotBusy}
            onClick={() => void handleExportSettings()}
            type="button"
          >
            Export Settings
          </button>
          <button
            className="button button--ghost button--small"
            disabled={isSnapshotBusy}
            onClick={() => void handleImportSettings()}
            type="button"
          >
            Import Settings
          </button>
          <button className="button button--ghost button--small" onClick={handleResetAllSettings} type="button">
            Reset All Settings
          </button>
        </div>
        {snapshotStatus ? (
          <p
            className={`settings-feedback${
              snapshotStatus.tone === "error" ? " settings-feedback--error" : ""
            }`}
          >
            {snapshotStatus.message}
          </p>
        ) : null}
      </div>

      {nativeDiagnosticsAvailabilityQuery.data?.enabled ? (
        <div className="panel settings-panel" aria-labelledby="native-audio-diagnostics-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Diagnostics</p>
              <h2 id="native-audio-diagnostics-title">Native Audio Diagnostics</h2>
              <p className="subpanel__copy">
                Local session only. Names, paths, identifiers, and audio samples are not recorded or sent.
              </p>
            </div>
          </div>

          <dl className="details-grid details-grid--single-column">
            <div>
              <dt>Recorded operations</dt>
              <dd>{nativeDiagnosticsQuery.data?.counters.operationCount ?? 0}</dd>
            </div>
            <div>
              <dt>Skipped packet/decode errors</dt>
              <dd>
                {(nativeDiagnosticsQuery.data?.counters.skippedPacketErrorCount ?? 0)
                  + (nativeDiagnosticsQuery.data?.counters.skippedDecodeErrorCount ?? 0)}
              </dd>
            </div>
          </dl>

          <div className="button-row">
            <button
              className="button button--ghost button--small"
              disabled={isNativeValidationBusy}
              onClick={() => void handleResetNativeValidation()}
              type="button"
            >
              Reset diagnostics
            </button>
            <button
              className="button button--ghost button--small"
              disabled={isNativeValidationBusy}
              onClick={() => void handleExportNativeValidation()}
              type="button"
            >
              Export sanitized JSON
            </button>
          </div>
          {nativeValidationStatus ? (
            <p
              className={`settings-feedback${
                nativeValidationStatus.tone === "error" ? " settings-feedback--error" : ""
              }`}
            >
              {nativeValidationStatus.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
