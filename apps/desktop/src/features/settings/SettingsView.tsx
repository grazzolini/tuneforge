import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useTheme, type ThemePreference } from "../../lib/theme";

function themePreferenceLabel(themePreference: ThemePreference) {
  if (themePreference === "system") {
    return "Follow system";
  }
  return themePreference === "dark" ? "Dark" : "Light";
}

export function SettingsView() {
  const { effectiveTheme, themePreference, setThemePreference } = useTheme();
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
  });

  return (
    <section className="screen">
      <div className="screen__header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Backend and Storage</h1>
          <p className="screen__subtitle">
            Tuneforge keeps audio, analysis, and generated exports local by default.
          </p>
        </div>
      </div>

      <div className="layout-grid layout-grid--tight">
        <div className="panel">
          <h2>Appearance</h2>
          <div className="controls controls--compact">
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
          </div>
          <p className="setting-copy">
            Dark is the default. Choose system if you want Tuneforge to follow the operating system appearance.
          </p>
          <dl className="meta-grid">
            <div>
              <dt>Preference</dt>
              <dd>{themePreferenceLabel(themePreference)}</dd>
            </div>
            <div>
              <dt>Active Theme</dt>
              <dd>{themePreferenceLabel(effectiveTheme)}</dd>
            </div>
          </dl>
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
          <p>Projects, previews, exported files, and the SQLite database are stored under this local data root.</p>
        </div>
      </div>
    </section>
  );
}
