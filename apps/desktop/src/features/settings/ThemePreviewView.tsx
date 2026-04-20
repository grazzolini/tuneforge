import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import { useTheme } from "../../lib/theme";
import { getThemeCssVariables, themeTokens, type ThemeMode, type ThemeTokens } from "../../lib/themeTokens";

type TokenSection = {
  title: string;
  items: Array<{
    label: string;
    value: (tokens: ThemeTokens) => string;
  }>;
};

const semanticSections: TokenSection[] = [
  {
    title: "Background",
    items: [
      { label: "App", value: (tokens) => tokens.bg.app },
      { label: "Canvas", value: (tokens) => tokens.bg.canvas },
      { label: "Panel", value: (tokens) => tokens.bg.panel },
      { label: "Elevated", value: (tokens) => tokens.bg.elevated },
      { label: "Inset", value: (tokens) => tokens.bg.inset },
    ],
  },
  {
    title: "Text",
    items: [
      { label: "Primary", value: (tokens) => tokens.text.primary },
      { label: "Secondary", value: (tokens) => tokens.text.secondary },
      { label: "Muted", value: (tokens) => tokens.text.muted },
      { label: "Inverse", value: (tokens) => tokens.text.inverse },
    ],
  },
  {
    title: "Border",
    items: [
      { label: "Subtle", value: (tokens) => tokens.border.subtle },
      { label: "Default", value: (tokens) => tokens.border.default },
      { label: "Strong", value: (tokens) => tokens.border.strong },
    ],
  },
  {
    title: "Accent",
    items: [
      { label: "Cool", value: (tokens) => tokens.accent.cool },
      { label: "Cool Hover", value: (tokens) => tokens.accent.coolHover },
      { label: "Cool Soft", value: (tokens) => tokens.accent.coolSoft },
      { label: "Warm", value: (tokens) => tokens.accent.warm },
      { label: "Warm Strong", value: (tokens) => tokens.accent.warmStrong },
      { label: "Warm Deep", value: (tokens) => tokens.accent.warmDeep },
      { label: "Warm Soft", value: (tokens) => tokens.accent.warmSoft },
    ],
  },
  {
    title: "State",
    items: [
      { label: "Success", value: (tokens) => tokens.state.success },
      { label: "Warning", value: (tokens) => tokens.state.warning },
      { label: "Danger", value: (tokens) => tokens.state.danger },
      { label: "Info", value: (tokens) => tokens.state.info },
      { label: "Hover", value: (tokens) => tokens.interaction.hover },
      { label: "Focus Ring", value: (tokens) => tokens.interaction.focusRing },
    ],
  },
];

const componentSections: TokenSection[] = [
  {
    title: "Components",
    items: [
      { label: "Sidebar", value: (tokens) => tokens.component.sidebarBg },
      { label: "Card", value: (tokens) => tokens.component.cardBg },
      { label: "Card Selected", value: (tokens) => tokens.component.cardSelectedBg },
      { label: "Inspector", value: (tokens) => tokens.component.inspectorBg },
      { label: "Playback Active", value: (tokens) => tokens.component.playbackActive },
      { label: "Playback Track", value: (tokens) => tokens.component.playbackTrack },
      { label: "Chord Active", value: (tokens) => tokens.component.chordActive },
      { label: "Stem Muted", value: (tokens) => tokens.component.stemMuted },
      { label: "Stem Solo", value: (tokens) => tokens.component.stemSolo },
      { label: "Button Primary", value: (tokens) => tokens.component.buttonPrimaryBg },
      { label: "Button Secondary", value: (tokens) => tokens.component.buttonSecondaryBg },
      { label: "Input", value: (tokens) => tokens.component.inputBg },
      { label: "Focus Ring", value: (tokens) => tokens.component.focusRing },
    ],
  },
];

function previewStyle(mode: ThemeMode) {
  return {
    ...getThemeCssVariables(mode),
    colorScheme: mode,
  } as CSSProperties;
}

function TokenSwatches({ mode, sections }: { mode: ThemeMode; sections: TokenSection[] }) {
  const tokens = themeTokens[mode];

  return (
    <div className="theme-preview__swatches">
      {sections.map((section) => (
        <section className="theme-preview__token-section" key={`${mode}-${section.title}`}>
          <div className="panel-heading panel-heading--compact">
            <div>
              <h3>{section.title}</h3>
            </div>
          </div>
          <div className="theme-preview__token-grid">
            {section.items.map((item) => {
              const hex = item.value(tokens);
              return (
                <div className="theme-preview__token" key={`${section.title}-${item.label}`}>
                  <span className="theme-preview__token-swatch" style={{ background: hex }} aria-hidden="true" />
                  <span className="theme-preview__token-label">{item.label}</span>
                  <code>{hex}</code>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function ThemeCanvas({ mode }: { mode: ThemeMode }) {
  const isDark = mode === "dark";
  const libraryId = `${mode}-theme-preview-library`;
  const sessionId = `${mode}-theme-preview-session`;
  const inspectorId = `${mode}-theme-preview-inspector`;

  return (
    <section className={`theme-preview theme-preview--${mode}`} style={previewStyle(mode)}>
      <div className="theme-preview__frame">
        <div className="theme-preview__topbar">
          <div>
            <p className="eyebrow">{isDark ? "Dark / Steel Night" : "Light / Brushed Metal"}</p>
            <h2>{isDark ? "Cold base. Warm action." : "Paper, metal, and control."}</h2>
          </div>
          <span className="pill">{isDark ? "Night / depth" : "Day / structure"}</span>
        </div>

        <div className="theme-preview__shell">
          <aside className="theme-preview__sidebar">
            <div className="brand">
              <span className="brand__eyebrow">TuneForge</span>
              <strong>Deliberate mix rig</strong>
            </div>
            <nav className="theme-preview__nav" aria-label={`${mode} theme navigation example`}>
              <a className="active" href={`#${libraryId}`}>
                Library
              </a>
              <a href={`#${sessionId}`}>Session</a>
              <a href={`#${inspectorId}`}>Inspector</a>
            </nav>
          </aside>

          <div className="theme-preview__workspace">
            <div className="theme-preview__workspace-header">
              <div>
                <p className="eyebrow">Preview Surface</p>
                <h3>Playback, cards, and inspector</h3>
                <p className="screen__subtitle">
                  Cool blue holds structure. Molten orange only marks live playback and high-emphasis actions.
                </p>
              </div>
              <div className="button-row">
                <button className="theme-preview__button theme-preview__button--secondary" type="button">
                  Neutral Select
                </button>
                <button className="theme-preview__button theme-preview__button--primary" type="button">
                  Render Mix
                </button>
              </div>
            </div>

            <div className="theme-preview__workspace-grid">
              <section className="theme-preview__panel" id={libraryId}>
                <div className="panel-heading panel-heading--compact">
                  <div>
                    <p className="metric-label">Sidebar + Cards</p>
                    <h3>Project library</h3>
                  </div>
                </div>
                <div className="theme-preview__card-stack">
                  <article className="theme-preview__card">
                    <div className="theme-preview__card-meta">
                      <span className="pill">Updated Apr 20</span>
                      <span className="pill">4:12</span>
                    </div>
                    <strong>Reference mix</strong>
                    <p className="artifact-meta">Neutral state uses steel structure, not heat.</p>
                  </article>
                  <article className="theme-preview__card theme-preview__card--selected">
                    <div className="theme-preview__card-meta">
                      <span className="pill">Selected</span>
                      <span className="pill">A / 440</span>
                    </div>
                    <strong>Retune pass</strong>
                    <p className="artifact-meta">Selected cards stay cool until audio becomes active.</p>
                  </article>
                </div>
              </section>

              <section className="theme-preview__panel" id={sessionId}>
                <div className="panel-heading panel-heading--compact">
                  <div>
                    <p className="metric-label">Playback</p>
                    <h3>Heat stays localized</h3>
                  </div>
                  <span className="theme-preview__status">Live</span>
                </div>
                <div className="theme-preview__playback">
                  <div className="theme-preview__playback-meta">
                    <div>
                      <span className="metric-label">Now playing</span>
                      <strong>Molten focus lane</strong>
                    </div>
                    <button className="theme-preview__button theme-preview__button--primary" type="button">
                      Play
                    </button>
                  </div>
                  <div className="theme-preview__track" aria-label={`${mode} playback track example`}>
                    <div className="theme-preview__track-progress" />
                  </div>
                  <div className="theme-preview__playback-footer">
                    <span>01:24</span>
                    <span>04:12</span>
                  </div>
                  <div className="theme-preview__chip-row">
                    <span className="theme-preview__chip theme-preview__chip--muted">Stem muted</span>
                    <span className="theme-preview__chip theme-preview__chip--solo">Stem solo</span>
                    <span className="theme-preview__chip theme-preview__chip--active">Chord active</span>
                  </div>
                </div>
              </section>

              <section className="theme-preview__panel theme-preview__panel--inspector" id={inspectorId}>
                <div className="panel-heading panel-heading--compact">
                  <div>
                    <p className="metric-label">Inspector</p>
                    <h3>Decision surfaces</h3>
                  </div>
                </div>
                <div className="theme-preview__text-block">
                  <p className="theme-preview__text-primary">Primary text carries the read path.</p>
                  <p className="theme-preview__text-secondary">Secondary text explains state without stealing focus.</p>
                  <p className="theme-preview__text-muted">Muted text stays low-contrast for metadata and scaffolding.</p>
                </div>
                <label className="theme-preview__field">
                  <span className="metric-label">Transpose</span>
                  <input defaultValue="+2 semitones" readOnly type="text" />
                </label>
              </section>
            </div>
          </div>
        </div>
      </div>

      <TokenSwatches mode={mode} sections={semanticSections} />
      <TokenSwatches mode={mode} sections={componentSections} />
    </section>
  );
}

export function ThemePreviewView() {
  const { effectiveTheme } = useTheme();

  return (
    <section className="screen theme-preview-page">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Theme</p>
          <h1>Metal / Heat System</h1>
          <p className="screen__subtitle">
            Semantic tokens now drive dark, light, and follow-system modes from one TypeScript source. The live UI still
            follows your active theme: <strong>{effectiveTheme}</strong>.
          </p>
        </div>
        <div className="button-row">
          <Link className="button button--ghost" to="/settings">
            Back to Settings
          </Link>
        </div>
      </div>

      <div className="theme-preview-page__stack">
        <ThemeCanvas mode="dark" />
        <ThemeCanvas mode="light" />
      </div>
    </section>
  );
}
