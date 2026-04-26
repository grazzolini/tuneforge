import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Link } from "react-router-dom";
import { api, type ChordBackendSchema } from "../../lib/api";
import {
  usePreferences,
  type DefaultChordBackend,
  type DefaultPlaybackDisplayMode,
  type EnharmonicDisplayMode,
  type InformationDensity,
  type ProjectWorkspaceMode,
} from "../../lib/preferences";
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

const fallbackChordBackendOptions: ChoiceOption<DefaultChordBackend>[] = [
  {
    value: "tuneforge-fast",
    label: "Built-in Chords",
    description: "Default local detector with lightweight source and stem analysis.",
  },
  {
    value: "crema-advanced",
    label: "Advanced Chords",
    description: "Experimental crema detector with sevenths and inversion labels.",
    disabled: true,
    status: "Unavailable",
  },
];

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

function chordBackendLabel(value: DefaultChordBackend) {
  return value === "crema-advanced" ? "Advanced Chords" : "Built-in Chords";
}

function chordBackendOptions(backends: ChordBackendSchema[] | undefined): ChoiceOption<DefaultChordBackend>[] {
  if (!backends?.length) {
    return fallbackChordBackendOptions;
  }

  return fallbackChordBackendOptions.map((fallback) => {
    const backend = backends.find((candidate) => candidate.id === fallback.value);
    if (!backend) {
      return fallback;
    }
    const unavailableReason = backend.available ? null : backend.unavailable_reason;
    return {
      value: fallback.value,
      label: backend.label,
      description: backend.description,
      disabled: !backend.available,
      status: unavailableReason ?? (backend.experimental ? "Experimental" : undefined),
    };
  });
}

function ChoiceGroup<T extends string>({
  description,
  legend,
  onChange,
  options,
  value,
}: {
  description: string;
  legend: string;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
  value: T;
}) {
  return (
    <fieldset className="settings-fieldset">
      <legend>{legend}</legend>
      <p className="setting-copy">{description}</p>
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
    defaultChordBackend,
    defaultLyricsFollowEnabled,
    defaultChordsFollowEnabled,
    setInformationDensity,
    setEnharmonicDisplayMode,
    setDefaultInspectorOpen,
    setDefaultSourcesRailCollapsed,
    setDefaultProjectWorkspace,
    setDefaultPlaybackDisplayMode,
    setDefaultChordBackend,
    setDefaultLyricsFollowEnabled,
    setDefaultChordsFollowEnabled,
    resetAppearancePreferences,
    resetNotationPreferences,
    resetAnalysisPreferences,
    resetVisibilityPreferences,
    resetPreferences,
    replacePreferences,
  } = usePreferences();
  const [isSnapshotBusy, setIsSnapshotBusy] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
  });
  const chordBackendsQuery = useQuery({
    queryKey: ["chord-backends"],
    queryFn: api.listChordBackends,
  });
  const savedThemeOverrideCount = themeOverrideCount(themeOverrides);
  const chordBackendChoices = chordBackendOptions(chordBackendsQuery.data?.backends);

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

  function handleResetAllSettings() {
    setThemePreference(DEFAULT_THEME_PREFERENCE);
    resetThemeOverrides();
    resetPreferences();
  }

  async function handleExportSettings() {
    setIsSnapshotBusy(true);
    setSnapshotStatus(null);

    try {
      const path = await save({
        defaultPath: `tuneforge-settings-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (!path) {
        return;
      }

      const contents = serializeSettingsSnapshot({
        preferences: {
          defaultChordsFollowEnabled,
          defaultChordBackend,
          defaultInspectorOpen,
          defaultPlaybackDisplayMode,
          defaultLyricsFollowEnabled,
          defaultProjectWorkspace,
          defaultSourcesRailCollapsed,
          enharmonicDisplayMode,
          informationDensity,
        },
        themeOverrides,
        themePreference,
      });

      await writeSettingsSnapshotFile(path, contents);
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
      const selected = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      const path = Array.isArray(selected) ? selected[0] : selected;

      if (!path) {
        return;
      }

      const contents = await readSettingsSnapshotFile(path);
      const snapshot = parseSettingsSnapshot(contents);

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

  return (
    <section className="screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Settings</p>
          <h1>Control Room</h1>
          <p className="screen__subtitle">App-wide appearance, notation, and playback defaults.</p>
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
            <span className="pill">Chord backend</span>
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
            <dt>Inspector</dt>
            <dd>{defaultInspectorOpen ? "Open on load" : "Closed on load"}</dd>
          </div>
          <div className="settings-overview__stat">
            <dt>Sources rail</dt>
            <dd>{defaultSourcesRailCollapsed ? "Collapsed" : "Expanded"}</dd>
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
            <dt>Chord backend</dt>
            <dd>{chordBackendLabel(defaultChordBackend)}</dd>
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
            description="Choose the backend used when generating or refreshing chords."
            legend="Default chord backend"
            onChange={setDefaultChordBackend}
            options={chordBackendChoices}
            value={defaultChordBackend}
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

          <div className="settings-toggle-list">
            <PreferenceToggle
              description="Keep transform, export, and analysis controls visible on first load."
              label="Open inspector by default"
              onChange={setDefaultInspectorOpen}
              value={defaultInspectorOpen}
            />
            <PreferenceToggle
              description="Start with more playback space when you reopen dense projects."
              label="Collapse sources rail by default"
              onChange={setDefaultSourcesRailCollapsed}
              value={defaultSourcesRailCollapsed}
            />
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
          <dl className="details-grid details-grid--single-column">
            <div>
              <dt>Status</dt>
              <dd>{healthQuery.data?.status ?? "Unknown"}</dd>
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
          </dl>
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
    </section>
  );
}
