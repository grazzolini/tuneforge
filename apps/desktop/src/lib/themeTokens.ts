export type ThemeMode = "dark" | "light";

export type ThemeTokens = {
  bg: {
    app: string;
    canvas: string;
    panel: string;
    elevated: string;
    inset: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    inverse: string;
  };
  border: {
    subtle: string;
    default: string;
    strong: string;
  };
  accent: {
    cool: string;
    coolHover: string;
    coolSoft: string;
    warm: string;
    warmStrong: string;
    warmDeep: string;
    warmSoft: string;
  };
  interaction: {
    hover: string;
    focusRing: string;
  };
  state: {
    success: string;
    warning: string;
    danger: string;
    info: string;
  };
  component: {
    sidebarBg: string;
    cardBg: string;
    cardSelectedBg: string;
    inspectorBg: string;
    playbackActive: string;
    playbackTrack: string;
    chordActive: string;
    lyricsActiveBg: string;
    lyricsContextText: string;
    transportDockBg: string;
    stemMuted: string;
    stemSolo: string;
    buttonPrimaryBg: string;
    buttonSecondaryBg: string;
    inputBg: string;
    focusRing: string;
    sourceSelectorSecondaryText: string;
    selectorCurrentSecondaryText: string;
    selectorBadgeText: string;
    selectorSelectedOptionText: string;
    selectorSelectedDirectionText: string;
    selectorCurrentMetaText: string;
    selectorOpenKeyText: string;
    selectorOpenMetaText: string;
  };
};

export type ThemeVariableDefinition = {
  description?: string;
  label: string;
  variable: ThemeVariableName;
};

export type ThemeVariableSection = {
  items: ThemeVariableDefinition[];
  title: string;
};

export const themeTokens: Record<ThemeMode, ThemeTokens> = {
  dark: {
    bg: {
      app: "#070B13",
      canvas: "#0A1020",
      panel: "#0E1628",
      elevated: "#13203A",
      inset: "#0C1424",
    },
    text: {
      primary: "#E8EEF9",
      secondary: "#A7B4C8",
      muted: "#73829A",
      inverse: "#0A1020",
    },
    border: {
      subtle: "#22314B",
      default: "#30435F",
      strong: "#4C6385",
    },
    accent: {
      cool: "#4B6FAE",
      coolHover: "#5D83C4",
      coolSoft: "#1B2D4A",
      warm: "#F59E0B",
      warmStrong: "#FFB547",
      warmDeep: "#C96B16",
      warmSoft: "#3D2512",
    },
    interaction: {
      hover: "#18253B",
      focusRing: "#5D83C4",
    },
    state: {
      success: "#3FAF7A",
      warning: "#E7A23B",
      danger: "#D65C5C",
      info: "#6F8FC8",
    },
    component: {
      sidebarBg: "#0A1020",
      cardBg: "#0E1628",
      cardSelectedBg: "#1B2D4A",
      inspectorBg: "#101A2F",
      playbackActive: "#F59E0B",
      playbackTrack: "#3D2512",
      chordActive: "#C96B16",
      lyricsActiveBg: "#18253B",
      lyricsContextText: "#8FA2BE",
      transportDockBg: "#0B1220",
      stemMuted: "#22314B",
      stemSolo: "#4B6FAE",
      buttonPrimaryBg: "#F59E0B",
      buttonSecondaryBg: "#13203A",
      inputBg: "#0C1424",
      focusRing: "#5D83C4",
      sourceSelectorSecondaryText: "#BBAE97",
      selectorCurrentSecondaryText: "#BDAE93",
      selectorBadgeText: "#FCFDFE",
      selectorSelectedOptionText: "#FDFDFE",
      selectorSelectedDirectionText: "#F0BC65",
      selectorCurrentMetaText: "#EFC47D",
      selectorOpenKeyText: "#FDFDFE",
      selectorOpenMetaText: "#C8AB79",
    },
  },
  light: {
    bg: {
      app: "#F4F7FB",
      canvas: "#EDF2F8",
      panel: "#FFFFFF",
      elevated: "#F8FAFD",
      inset: "#E7EEF7",
    },
    text: {
      primary: "#142033",
      secondary: "#44546C",
      muted: "#6C7B90",
      inverse: "#FFFFFF",
    },
    border: {
      subtle: "#D7E0EC",
      default: "#C0CDDD",
      strong: "#9BAECC",
    },
    accent: {
      cool: "#44679D",
      coolHover: "#35598E",
      coolSoft: "#DCE7F6",
      warm: "#D9861A",
      warmStrong: "#F2A93B",
      warmDeep: "#A95F11",
      warmSoft: "#F6E3C8",
    },
    interaction: {
      hover: "#E4ECF7",
      focusRing: "#44679D",
    },
    state: {
      success: "#3FAF7A",
      warning: "#E7A23B",
      danger: "#D65C5C",
      info: "#6F8FC8",
    },
    component: {
      sidebarBg: "#E7EEF7",
      cardBg: "#FFFFFF",
      cardSelectedBg: "#DCE7F6",
      inspectorBg: "#F8FAFD",
      playbackActive: "#D9861A",
      playbackTrack: "#F6E3C8",
      chordActive: "#D9861A",
      lyricsActiveBg: "#F4E5CB",
      lyricsContextText: "#607189",
      transportDockBg: "#FDFBF7",
      stemMuted: "#D7E0EC",
      stemSolo: "#44679D",
      buttonPrimaryBg: "#D9861A",
      buttonSecondaryBg: "#F8FAFD",
      inputBg: "#FFFFFF",
      focusRing: "#44679D",
      sourceSelectorSecondaryText: "#9A6522",
      selectorCurrentSecondaryText: "#9A6522",
      selectorBadgeText: "#37537F",
      selectorSelectedOptionText: "#142033",
      selectorSelectedDirectionText: "#AA6E20",
      selectorCurrentMetaText: "#A26921",
      selectorOpenKeyText: "#142033",
      selectorOpenMetaText: "#A26921",
    },
  },
};

function buildThemeCssVariables(tokens: ThemeTokens) {
  return {
    "--color-bg-app": tokens.bg.app,
    "--color-bg-canvas": tokens.bg.canvas,
    "--color-bg-panel": tokens.bg.panel,
    "--color-bg-elevated": tokens.bg.elevated,
    "--color-bg-inset": tokens.bg.inset,
    "--color-text-primary": tokens.text.primary,
    "--color-text-secondary": tokens.text.secondary,
    "--color-text-muted": tokens.text.muted,
    "--color-text-inverse": tokens.text.inverse,
    "--color-border-subtle": tokens.border.subtle,
    "--color-border-default": tokens.border.default,
    "--color-border-strong": tokens.border.strong,
    "--color-accent-cool": tokens.accent.cool,
    "--color-accent-cool-hover": tokens.accent.coolHover,
    "--color-accent-cool-soft": tokens.accent.coolSoft,
    "--color-accent-warm": tokens.accent.warm,
    "--color-accent-warm-strong": tokens.accent.warmStrong,
    "--color-accent-warm-deep": tokens.accent.warmDeep,
    "--color-accent-warm-soft": tokens.accent.warmSoft,
    "--color-interaction-hover": tokens.interaction.hover,
    "--color-interaction-focus-ring": tokens.interaction.focusRing,
    "--color-state-success": tokens.state.success,
    "--color-state-warning": tokens.state.warning,
    "--color-state-danger": tokens.state.danger,
    "--color-state-info": tokens.state.info,
    "--component-sidebar-bg": tokens.component.sidebarBg,
    "--component-card-bg": tokens.component.cardBg,
    "--component-card-selected-bg": tokens.component.cardSelectedBg,
    "--component-inspector-bg": tokens.component.inspectorBg,
    "--component-playback-active": tokens.component.playbackActive,
    "--component-playback-track": tokens.component.playbackTrack,
    "--component-chord-active": tokens.component.chordActive,
    "--component-lyrics-active-bg": tokens.component.lyricsActiveBg,
    "--component-lyrics-context-text": tokens.component.lyricsContextText,
    "--component-transport-dock-bg": tokens.component.transportDockBg,
    "--component-stem-muted": tokens.component.stemMuted,
    "--component-stem-solo": tokens.component.stemSolo,
    "--component-button-primary-bg": tokens.component.buttonPrimaryBg,
    "--component-button-secondary-bg": tokens.component.buttonSecondaryBg,
    "--component-input-bg": tokens.component.inputBg,
    "--component-focus-ring": tokens.component.focusRing,
    "--component-source-selector-secondary-text": tokens.component.sourceSelectorSecondaryText,
    "--component-selector-current-secondary-text": tokens.component.selectorCurrentSecondaryText,
    "--component-selector-badge-text": tokens.component.selectorBadgeText,
    "--component-selector-selected-option-text": tokens.component.selectorSelectedOptionText,
    "--component-selector-selected-direction-text": tokens.component.selectorSelectedDirectionText,
    "--component-selector-current-meta-text": tokens.component.selectorCurrentMetaText,
    "--component-selector-open-key-text": tokens.component.selectorOpenKeyText,
    "--component-selector-open-meta-text": tokens.component.selectorOpenMetaText,
  } satisfies Record<string, string>;
}

const darkThemeCssVariables = buildThemeCssVariables(themeTokens.dark);
const lightThemeCssVariables = buildThemeCssVariables(themeTokens.light);

export type ThemeVariableName = keyof typeof darkThemeCssVariables;
export type ThemeModeOverrides = Partial<Record<ThemeVariableName, string>>;
export type ThemeOverrides = Partial<Record<ThemeMode, ThemeModeOverrides>>;

export const themeCssVariables: Record<ThemeMode, Record<ThemeVariableName, string>> = {
  dark: darkThemeCssVariables,
  light: lightThemeCssVariables,
};

const themeVariableNames = Object.keys(darkThemeCssVariables) as ThemeVariableName[];
const themeVariableNameSet = new Set<string>(themeVariableNames);

export const themeVariableSections: ThemeVariableSection[] = [
  {
    title: "Background",
    items: [
      { label: "App background", variable: "--color-bg-app" },
      { label: "Canvas background", variable: "--color-bg-canvas" },
      { label: "Panel background", variable: "--color-bg-panel" },
      { label: "Elevated background", variable: "--color-bg-elevated" },
      { label: "Inset background", variable: "--color-bg-inset" },
    ],
  },
  {
    title: "Text",
    items: [
      { label: "Primary text", variable: "--color-text-primary" },
      { label: "Secondary text", variable: "--color-text-secondary" },
      { label: "Muted text", variable: "--color-text-muted" },
      { label: "Inverse text", variable: "--color-text-inverse" },
    ],
  },
  {
    title: "Border",
    items: [
      { label: "Subtle border", variable: "--color-border-subtle" },
      { label: "Default border", variable: "--color-border-default" },
      { label: "Strong border", variable: "--color-border-strong" },
    ],
  },
  {
    title: "Accent",
    items: [
      { label: "Cool accent", variable: "--color-accent-cool" },
      { label: "Cool accent hover", variable: "--color-accent-cool-hover" },
      { label: "Cool accent soft", variable: "--color-accent-cool-soft" },
      { label: "Warm accent", variable: "--color-accent-warm" },
      { label: "Warm accent strong", variable: "--color-accent-warm-strong" },
      { label: "Warm accent deep", variable: "--color-accent-warm-deep" },
      { label: "Warm accent soft", variable: "--color-accent-warm-soft" },
    ],
  },
  {
    title: "Interaction",
    items: [
      { label: "Hover surface", variable: "--color-interaction-hover" },
      { label: "Focus ring", variable: "--color-interaction-focus-ring" },
    ],
  },
  {
    title: "State",
    items: [
      { label: "Success", variable: "--color-state-success" },
      { label: "Warning", variable: "--color-state-warning" },
      { label: "Danger", variable: "--color-state-danger" },
      { label: "Info", variable: "--color-state-info" },
    ],
  },
  {
    title: "Components",
    items: [
      { label: "Sidebar background", variable: "--component-sidebar-bg" },
      { label: "Card background", variable: "--component-card-bg" },
      { label: "Card selected", variable: "--component-card-selected-bg" },
      { label: "Inspector background", variable: "--component-inspector-bg" },
      { label: "Playback active", variable: "--component-playback-active" },
      { label: "Playback track", variable: "--component-playback-track" },
      { label: "Chord active", variable: "--component-chord-active" },
      { label: "Lyrics active", variable: "--component-lyrics-active-bg" },
      { label: "Lyrics context", variable: "--component-lyrics-context-text" },
      { label: "Transport dock", variable: "--component-transport-dock-bg" },
      { label: "Stem muted", variable: "--component-stem-muted" },
      { label: "Stem solo", variable: "--component-stem-solo" },
      { label: "Primary button", variable: "--component-button-primary-bg" },
      { label: "Secondary button", variable: "--component-button-secondary-bg" },
      { label: "Input background", variable: "--component-input-bg" },
      { label: "Component focus ring", variable: "--component-focus-ring" },
    ],
  },
  {
    title: "Selectors",
    items: [
      { label: "Source selector secondary", variable: "--component-source-selector-secondary-text" },
      { label: "Selector current secondary", variable: "--component-selector-current-secondary-text" },
      { label: "Selector badge text", variable: "--component-selector-badge-text" },
      { label: "Selected option text", variable: "--component-selector-selected-option-text" },
      { label: "Selected direction", variable: "--component-selector-selected-direction-text" },
      { label: "Current meta text", variable: "--component-selector-current-meta-text" },
      { label: "Open key text", variable: "--component-selector-open-key-text" },
      { label: "Open meta text", variable: "--component-selector-open-meta-text" },
    ],
  },
];

export function getThemeCssVariables(theme: ThemeMode) {
  return themeCssVariables[theme];
}

export function getThemeVariableValue(theme: ThemeMode, variable: ThemeVariableName) {
  return themeCssVariables[theme][variable];
}

export function isThemeVariableName(value: string): value is ThemeVariableName {
  return themeVariableNameSet.has(value);
}

export function resolveThemeCssVariables(theme: ThemeMode, overrides?: ThemeModeOverrides) {
  return {
    ...themeCssVariables[theme],
    ...(overrides ?? {}),
  };
}
