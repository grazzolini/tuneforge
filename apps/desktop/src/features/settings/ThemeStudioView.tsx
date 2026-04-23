import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { MusicalKeyLabel } from "../../components/MusicalLabel";
import { useTheme } from "../../lib/theme";
import {
  getThemeVariableValue,
  themeVariableSections,
  type ThemeMode,
  type ThemeVariableName,
} from "../../lib/themeTokens";
import type { MusicalKey } from "../../lib/music";

const PREVIEW_NOTATION_MODE = "dual";
const PREVIEW_SOURCE_KEY: MusicalKey = { pitchClass: 3, mode: "major" };
const PREVIEW_LOWER_KEY: MusicalKey = { pitchClass: 2, mode: "major" };
const PREVIEW_HIGHER_KEY: MusicalKey = { pitchClass: 4, mode: "major" };
const PREVIEW_TARGET_HIGHER_OPTION: MusicalKey = { pitchClass: 5, mode: "major" };
const PREVIEW_TARGET_LOWER_OPTION: MusicalKey = { pitchClass: 1, mode: "major" };

function themeModeLabel(mode: ThemeMode) {
  return mode === "dark" ? "Dark" : "Light";
}

function themePreferenceLabel(themePreference: "dark" | "light" | "system") {
  if (themePreference === "system") {
    return "Follow system";
  }
  return themePreference === "dark" ? "Dark" : "Light";
}

function overrideCount(overrides: Record<string, string> | undefined) {
  return Object.keys(overrides ?? {}).length;
}

function normalizeHexColor(value: string) {
  const trimmed = value.trim();
  const shortHexMatch = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (shortHexMatch) {
    return `#${shortHexMatch[1]
      .split("")
      .map((character) => `${character}${character}`)
      .join("")
      .toUpperCase()}`;
  }

  const longHexMatch = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (longHexMatch) {
    return `#${longHexMatch[1].toUpperCase()}`;
  }

  return null;
}

function previewStyle(mode: ThemeMode, variables: Record<string, string>) {
  return {
    ...variables,
    colorScheme: mode,
  } as CSSProperties;
}

function ThemeTokenField({
  label,
  onChange,
  onReset,
  overridden,
  value,
  variable,
}: {
  label: string;
  onChange: (value: string) => void;
  onReset: () => void;
  overridden: boolean;
  value: string;
  variable: ThemeVariableName;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className={`theme-studio-token${overridden ? " theme-studio-token--overridden" : ""}`}>
      <div className="theme-studio-token__header">
        <div>
          <strong>{label}</strong>
          <p>{overridden ? "Local override active." : "Using theme default."}</p>
        </div>
        <span className="pill">{overridden ? "Override" : "Default"}</span>
      </div>

      <div className="theme-studio-token__controls">
        <input
          aria-label={`${label} color`}
          className="theme-studio-token__swatch"
          onChange={(event) => {
            const normalized = normalizeHexColor(event.target.value);
            if (!normalized) {
              return;
            }
            setDraft(normalized);
            onChange(normalized);
          }}
          type="color"
          value={value.toLowerCase()}
        />
        <input
          aria-label={`${label} hex`}
          className="theme-studio-token__hex"
          onBlur={() => setDraft(value)}
          onChange={(event) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            const normalized = normalizeHexColor(nextDraft);
            if (normalized) {
              onChange(normalized);
            }
          }}
          spellCheck={false}
          type="text"
          value={draft}
        />
      </div>

      <div className="theme-studio-token__footer">
        <code>{variable}</code>
        <button
          className="button button--ghost button--small"
          disabled={!overridden}
          onClick={onReset}
          type="button"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function ThemeStudioPreview({
  mode,
  variables,
}: {
  mode: ThemeMode;
  variables: Record<string, string>;
}) {
  return (
    <section className="theme-studio-preview" style={previewStyle(mode, variables)}>
      <div className="theme-studio-preview__frame">
        <div className="theme-studio-preview__hero">
          <div>
            <p className="eyebrow">Theme Studio</p>
            <h2>{themeModeLabel(mode)} mode sample</h2>
            <p className="screen__subtitle">Preview this mode.</p>
          </div>
          <span className="pill">{themeModeLabel(mode)}</span>
        </div>

        <div className="theme-studio-preview__shell">
          <aside className="theme-studio-preview__sidebar">
            <div className="brand">
              <span className="brand__eyebrow">Tuneforge</span>
              <strong>Local Practice Rig</strong>
            </div>
            <div className="theme-studio-preview__nav" aria-label={`${mode} theme sample navigation`}>
              <span className="theme-studio-preview__nav-item">Library</span>
              <span className="theme-studio-preview__nav-item theme-studio-preview__nav-item--active">Settings</span>
            </div>
          </aside>

          <div className="theme-studio-preview__workspace">
            <div className="theme-studio-preview__workspace-header">
              <div>
                <p className="eyebrow">Preview Surface</p>
                <h3>Theme studio sample</h3>
              </div>
              <div className="button-row">
                <button className="button button--ghost button--small" type="button">
                  Neutral Action
                </button>
                <button className="button button--primary button--small" type="button">
                  Render Mix
                </button>
              </div>
            </div>

            <div className="theme-studio-preview__grid">
              <article className="theme-studio-preview__card">
                <div className="theme-studio-preview__card-meta">
                  <span className="pill">Apr 22</span>
                  <span className="pill">4:12</span>
                </div>
                <span className="metric-label">Library card</span>
                <strong>Reference mix</strong>
                <p className="artifact-meta">Card, text, metadata, and selection colors meet first here.</p>
              </article>

              <section className="theme-studio-preview__playback">
                <div className="theme-studio-preview__playback-header">
                  <div>
                    <span className="metric-label">Playback accents</span>
                    <strong>Lyrics + dock</strong>
                  </div>
                  <span className="theme-studio-preview__live-pill">Live</span>
                </div>
                <div className="theme-studio-preview__lyrics-card">
                  <span className="metric-label">Active lyric</span>
                  <strong>Hold middle line steady</strong>
                  <p className="artifact-meta">Context lines dim. Active line stays centered.</p>
                </div>
                <div className="theme-studio-preview__track" aria-label={`${mode} playback track sample`}>
                  <div className="theme-studio-preview__track-progress" />
                </div>
                <div className="theme-studio-preview__chip-row">
                  <span className="theme-studio-preview__chip theme-studio-preview__chip--muted">Muted stem</span>
                  <span className="theme-studio-preview__chip theme-studio-preview__chip--solo">Solo stem</span>
                  <span className="theme-studio-preview__chip theme-studio-preview__chip--active">Chord active</span>
                </div>
                <div className="theme-studio-preview__dock">
                  <span className="theme-studio-preview__dock-button" />
                  <span className="theme-studio-preview__dock-button theme-studio-preview__dock-button--large" />
                  <span className="theme-studio-preview__dock-track" />
                </div>
              </section>

              <section className="theme-studio-preview__settings">
                <span className="metric-label">Settings field</span>
                <strong>Local default</strong>
                <label className="theme-studio-preview__field">
                  <span className="metric-label">Theme preference</span>
                  <input readOnly type="text" value={`${themeModeLabel(mode)} mode`} />
                </label>

                <div className="theme-studio-preview__selector-showcase">
                  <div className="source-key-selector-field">
                    <span className="source-key-selector-field__label">Project Source Key</span>
                    <div className="source-key-selector theme-studio-preview__selector-block">
                      <button
                        aria-expanded="true"
                        aria-haspopup="listbox"
                        className="source-key-selector__trigger source-key-selector__trigger--open"
                        type="button"
                      >
                        <span className="source-key-selector__current">
                          <span className="source-key-selector__current-indicator" aria-hidden="true" />
                          <span className="source-key-selector__current-label">
                            <MusicalKeyLabel
                              keyValue={PREVIEW_SOURCE_KEY}
                              mode={PREVIEW_NOTATION_MODE}
                              variant="source-selector-current"
                            />
                          </span>
                          <span className="source-key-selector__current-badge">Original</span>
                        </span>
                        <span className="source-key-selector__chevron" aria-hidden="true">
                          ⌄
                        </span>
                      </button>

                      <div
                        className="source-key-selector__menu theme-studio-preview__selector-menu"
                        role="listbox"
                        aria-label={`${mode} source selector sample`}
                      >
                        {[
                          { badge: "Original", key: PREVIEW_SOURCE_KEY, selected: true },
                          { badge: null, key: { pitchClass: 0, mode: "major" } satisfies MusicalKey, selected: false },
                          { badge: null, key: PREVIEW_TARGET_LOWER_OPTION, selected: false },
                          { badge: null, key: PREVIEW_LOWER_KEY, selected: false },
                          { badge: null, key: PREVIEW_HIGHER_KEY, selected: false },
                          { badge: null, key: PREVIEW_TARGET_HIGHER_OPTION, selected: false },
                        ].map((option, index) => (
                          <button
                            key={`${option.key.pitchClass}-${option.key.mode}-${index}`}
                            aria-selected={option.selected}
                            className={`source-key-selector__option${
                              option.selected ? " source-key-selector__option--selected" : ""
                            }`}
                            role="option"
                            type="button"
                          >
                            <span className="source-key-selector__option-content">
                              <span className="source-key-selector__option-indicator" aria-hidden="true" />
                              <span className="source-key-selector__option-label">
                                <MusicalKeyLabel
                                  keyValue={option.key}
                                  mode={PREVIEW_NOTATION_MODE}
                                  variant="source-selector-option"
                                />
                              </span>
                              {option.badge ? (
                                <span className="source-key-selector__option-badge">{option.badge}</span>
                              ) : null}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="source-key-selector-field">
                    <span className="source-key-selector-field__label">Target Key</span>
                    <div className="target-selector theme-studio-preview__selector-block">
                      <button
                        aria-expanded="true"
                        aria-haspopup="listbox"
                        className="target-selector__trigger target-selector__trigger--dual"
                        type="button"
                      >
                        <span className="target-selector__preview target-selector__preview--lower">
                          <MusicalKeyLabel
                            keyValue={PREVIEW_LOWER_KEY}
                            mode={PREVIEW_NOTATION_MODE}
                            variant="selector-preview"
                          />
                        </span>
                        <span className="target-selector__current target-selector__current--dual">
                          <span className="target-selector__current-key target-selector__current-key--dual">
                            <MusicalKeyLabel
                              keyValue={PREVIEW_SOURCE_KEY}
                              mode={PREVIEW_NOTATION_MODE}
                              variant="selector-current"
                            />
                          </span>
                          <span className="target-selector__current-meta">Original</span>
                        </span>
                        <span className="target-selector__preview target-selector__preview--higher">
                          <MusicalKeyLabel
                            keyValue={PREVIEW_HIGHER_KEY}
                            mode={PREVIEW_NOTATION_MODE}
                            variant="selector-preview"
                          />
                        </span>
                        <span className="target-selector__chevron" aria-hidden="true">
                          ⌄
                        </span>
                      </button>

                      <div
                        className="target-selector__menu theme-studio-preview__selector-menu"
                        role="listbox"
                        aria-label={`${mode} target selector sample`}
                      >
                        <div className="target-selector__group-label">Higher pitch</div>
                        {[
                          { direction: "↑", key: PREVIEW_TARGET_HIGHER_OPTION, selected: false },
                          { direction: "↑", key: PREVIEW_HIGHER_KEY, selected: false },
                        ].map((option, index) => (
                          <button
                            key={`higher-${option.key.pitchClass}-${index}`}
                            aria-selected={option.selected}
                            className="target-selector__option"
                            role="option"
                            type="button"
                          >
                            <span className="target-selector__option-direction" aria-hidden="true">
                              {option.direction}
                            </span>
                            <span className="target-selector__option-content">
                              <span className="target-selector__option-label">
                                <MusicalKeyLabel
                                  keyValue={option.key}
                                  mode={PREVIEW_NOTATION_MODE}
                                  variant="selector-option"
                                />
                              </span>
                            </span>
                          </button>
                        ))}

                        <div className="target-selector__group-label">Original</div>
                        <button
                          aria-selected={true}
                          className="target-selector__option target-selector__option--selected"
                          role="option"
                          type="button"
                        >
                          <span className="target-selector__option-direction" aria-hidden="true">
                            •
                          </span>
                          <span className="target-selector__option-content">
                            <span className="target-selector__option-label">
                              <MusicalKeyLabel
                                keyValue={PREVIEW_SOURCE_KEY}
                                mode={PREVIEW_NOTATION_MODE}
                                variant="selector-option"
                              />
                            </span>
                          </span>
                        </button>

                        <div className="target-selector__group-label">Lower pitch</div>
                        {[
                          { direction: "↓", key: PREVIEW_LOWER_KEY, selected: false },
                          { direction: "↓", key: PREVIEW_TARGET_LOWER_OPTION, selected: false },
                        ].map((option, index) => (
                          <button
                            key={`lower-${option.key.pitchClass}-${index}`}
                            aria-selected={option.selected}
                            className="target-selector__option"
                            role="option"
                            type="button"
                          >
                            <span className="target-selector__option-direction" aria-hidden="true">
                              {option.direction}
                            </span>
                            <span className="target-selector__option-content">
                              <span className="target-selector__option-label">
                                <MusicalKeyLabel
                                  keyValue={option.key}
                                  mode={PREVIEW_NOTATION_MODE}
                                  variant="selector-option"
                                />
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ThemeStudioView() {
  const {
    clearThemeOverride,
    effectiveTheme,
    getThemeVariables,
    resetThemeOverrides,
    setThemeOverride,
    themeOverrides,
    themePreference,
  } = useTheme();
  const [editingMode, setEditingMode] = useState<ThemeMode>(effectiveTheme);

  const variables = getThemeVariables(editingMode);
  const modeOverrideCount = overrideCount(themeOverrides[editingMode]);
  const totalOverrideCount = overrideCount(themeOverrides.dark) + overrideCount(themeOverrides.light);

  return (
    <section className="screen theme-studio-page">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Theme Studio</p>
          <h1>Metal / Heat Studio</h1>
          <p className="screen__subtitle">
            Edit light and dark theme tokens. Current app theme:
            {" "}
            <strong>{themePreferenceLabel(themePreference)}</strong>. Effective theme:
            {" "}
            <strong>{themeModeLabel(effectiveTheme)}</strong>.
          </p>
        </div>
        <div className="button-row">
          <Link className="button button--ghost" to="/settings">
            Back to Settings
          </Link>
        </div>
      </div>

      <div className="panel theme-studio-toolbar">
        <div className="theme-studio-toolbar__primary">
          <div>
            <p className="eyebrow">Mode</p>
            <h2>Edit token set</h2>
            <p className="setting-copy">Light and dark modes save separately.</p>
          </div>
          <div className="theme-studio-toolbar__modes" role="tablist" aria-label="Theme studio mode">
            {(["dark", "light"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                aria-pressed={editingMode === mode}
                className={`theme-studio-toolbar__mode${editingMode === mode ? " theme-studio-toolbar__mode--active" : ""}`}
                onClick={() => setEditingMode(mode)}
                type="button"
              >
                {themeModeLabel(mode)}
              </button>
            ))}
          </div>
        </div>

        <dl className="theme-studio-toolbar__stats">
          <div className="theme-studio-toolbar__stat">
            <dt>Editing</dt>
            <dd>{themeModeLabel(editingMode)}</dd>
          </div>
          <div className="theme-studio-toolbar__stat">
            <dt>Mode overrides</dt>
            <dd>{modeOverrideCount}</dd>
          </div>
          <div className="theme-studio-toolbar__stat">
            <dt>Total saved</dt>
            <dd>{totalOverrideCount}</dd>
          </div>
        </dl>

        <div className="button-row">
          <button className="button button--ghost button--small" onClick={() => resetThemeOverrides(editingMode)} type="button">
            Reset {themeModeLabel(editingMode)} Theme
          </button>
          <button className="button button--ghost button--small" onClick={() => resetThemeOverrides()} type="button">
            Reset All Theme Overrides
          </button>
        </div>
      </div>

      <div className="theme-studio-layout">
        <div className="theme-studio-layout__controls">
          {themeVariableSections.map((section) => (
            <details className="panel theme-studio-section" key={section.title} open>
              <summary>{section.title}</summary>
              <div className="theme-studio-section__body">
                <div className="theme-studio-token-grid">
                  {section.items.map((item) => (
                    <ThemeTokenField
                      key={`${editingMode}-${item.variable}`}
                      label={item.label}
                      onChange={(value) => setThemeOverride(editingMode, item.variable, value)}
                      onReset={() => clearThemeOverride(editingMode, item.variable)}
                      overridden={Boolean(themeOverrides[editingMode]?.[item.variable])}
                      value={variables[item.variable]}
                      variable={item.variable}
                    />
                  ))}
                </div>
              </div>
            </details>
          ))}
        </div>

        <div className="theme-studio-layout__preview">
          <ThemeStudioPreview mode={editingMode} variables={variables} />
          <div className="panel theme-studio-reference">
            <h2>Defaults</h2>
            <p className="setting-copy">Reset any field to snap back to bundled theme tokens for this mode.</p>
            <dl className="details-grid details-grid--single-column">
              <div>
                <dt>App background</dt>
                <dd>
                  {getThemeVariableValue(editingMode, "--color-bg-app")}
                </dd>
              </div>
              <div>
                <dt>Playback active</dt>
                <dd>
                  {getThemeVariableValue(editingMode, "--component-playback-active")}
                </dd>
              </div>
              <div>
                <dt>Lyrics active</dt>
                <dd>
                  {getThemeVariableValue(editingMode, "--component-lyrics-active-bg")}
                </dd>
              </div>
              <div>
                <dt>Transport dock</dt>
                <dd>
                  {getThemeVariableValue(editingMode, "--component-transport-dock-bg")}
                </dd>
              </div>
              <div>
                <dt>Focus ring</dt>
                <dd>
                  {getThemeVariableValue(editingMode, "--component-focus-ring")}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
