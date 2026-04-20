import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import {
  usePreferences,
  type InformationDensity,
  type LayoutDensity,
  type MetadataRevealMode,
} from "../../lib/preferences";
import { useTheme, type ThemePreference } from "../../lib/theme";

function themePreferenceLabel(themePreference: ThemePreference) {
  if (themePreference === "system") {
    return "Follow system";
  }
  return themePreference === "dark" ? "Dark" : "Light";
}

function densityLabel(value: InformationDensity) {
  if (value === "minimal") return "Minimal";
  if (value === "detailed") return "Detailed";
  return "Balanced";
}

function layoutDensityLabel(value: LayoutDensity) {
  return value === "compact" ? "Compact" : "Comfortable";
}

function metadataRevealLabel(value: MetadataRevealMode) {
  return value === "hover" ? "Hover" : "Expand";
}

export function SettingsView() {
  const { effectiveTheme, themePreference, setThemePreference } = useTheme();
  const {
    informationDensity,
    layoutDensity,
    helperTextVisible,
    defaultInspectorOpen,
    metadataRevealMode,
    setInformationDensity,
    setLayoutDensity,
    setHelperTextVisible,
    setDefaultInspectorOpen,
    setMetadataRevealMode,
    resetPreferences,
  } = usePreferences();
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
  });

  return (
    <section className="screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Settings</p>
          <h1>Playback Surface</h1>
          <p className="screen__subtitle">
            TuneForge stays theme-aware while giving you control over density, metadata, and inspector defaults.
          </p>
        </div>
      </div>

      <div className="layout-grid settings-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>Appearance</h2>
              <p className="subpanel__copy">Theme behavior stays compatible with light, dark, and follow-system modes.</p>
            </div>
          </div>
          <div className="controls">
            <label>
              Theme
              <select
                aria-label="Theme"
                value={themePreference}
                onChange={(event) => setThemePreference(event.target.value as ThemePreference)}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Follow system</option>
              </select>
            </label>

            <label>
              Information Density
              <select
                aria-label="Information Density"
                value={informationDensity}
                onChange={(event) => setInformationDensity(event.target.value as InformationDensity)}
              >
                <option value="minimal">Minimal</option>
                <option value="balanced">Balanced</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>

            <label>
              Layout Density
              <select
                aria-label="Layout Density"
                value={layoutDensity}
                onChange={(event) => setLayoutDensity(event.target.value as LayoutDensity)}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
          </div>

          <dl className="meta-grid">
            <div>
              <dt>Theme Preference</dt>
              <dd>{themePreferenceLabel(themePreference)}</dd>
            </div>
            <div>
              <dt>Active Theme</dt>
              <dd>{themePreferenceLabel(effectiveTheme)}</dd>
            </div>
            <div>
              <dt>Information Density</dt>
              <dd>{densityLabel(informationDensity)}</dd>
            </div>
            <div>
              <dt>Layout Density</dt>
              <dd>{layoutDensityLabel(layoutDensity)}</dd>
            </div>
          </dl>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>Visibility Defaults</h2>
              <p className="subpanel__copy">Hide low-value copy by default while keeping technical detail one action away.</p>
            </div>
          </div>

          <div className="controls">
            <label className="checkbox">
              <input
                aria-label="Show helper text"
                checked={helperTextVisible}
                onChange={(event) => setHelperTextVisible(event.target.checked)}
                type="checkbox"
              />
              Show helper text
            </label>

            <label className="checkbox">
              <input
                aria-label="Open inspector by default"
                checked={defaultInspectorOpen}
                onChange={(event) => setDefaultInspectorOpen(event.target.checked)}
                type="checkbox"
              />
              Open inspector by default
            </label>

            <label>
              Metadata Reveal
              <select
                aria-label="Metadata Reveal"
                value={metadataRevealMode}
                onChange={(event) => setMetadataRevealMode(event.target.value as MetadataRevealMode)}
              >
                <option value="expand">Expand on click</option>
                <option value="hover">Hover for path</option>
              </select>
            </label>
          </div>

          <dl className="meta-grid">
            <div>
              <dt>Helper Text</dt>
              <dd>{helperTextVisible ? "Visible" : "Hidden"}</dd>
            </div>
            <div>
              <dt>Inspector Default</dt>
              <dd>{defaultInspectorOpen ? "Open" : "Collapsed"}</dd>
            </div>
            <div>
              <dt>Metadata Reveal</dt>
              <dd>{metadataRevealLabel(metadataRevealMode)}</dd>
            </div>
          </dl>

          <div className="button-row">
            <button className="button button--ghost button--small" type="button" onClick={resetPreferences}>
              Reset UI Defaults
            </button>
            <Link className="button button--ghost button--small" to="/settings/theme-preview">
              Open Theme Preview
            </Link>
          </div>
        </div>

        <div className="panel">
          <h2>Runtime</h2>
          <dl className="meta-grid">
            <div>
              <dt>Status</dt>
              <dd>{healthQuery.data?.status ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>API Base URL</dt>
              <dd>{healthQuery.data?.api_base_url ?? "Unavailable"}</dd>
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
        </div>

        <div className="panel">
          <h2>Storage</h2>
          <p className="path">{healthQuery.data?.data_root ?? "Backend unavailable"}</p>
          <p className="setting-copy">
            Projects, previews, exported files, and the local database stay under this root.
          </p>
        </div>
      </div>
    </section>
  );
}
