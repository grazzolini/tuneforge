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
    stemMuted: string;
    stemSolo: string;
    buttonPrimaryBg: string;
    buttonSecondaryBg: string;
    inputBg: string;
    focusRing: string;
  };
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
      stemMuted: "#22314B",
      stemSolo: "#4B6FAE",
      buttonPrimaryBg: "#F59E0B",
      buttonSecondaryBg: "#13203A",
      inputBg: "#0C1424",
      focusRing: "#5D83C4",
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
      stemMuted: "#D7E0EC",
      stemSolo: "#44679D",
      buttonPrimaryBg: "#D9861A",
      buttonSecondaryBg: "#F8FAFD",
      inputBg: "#FFFFFF",
      focusRing: "#44679D",
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
    "--component-stem-muted": tokens.component.stemMuted,
    "--component-stem-solo": tokens.component.stemSolo,
    "--component-button-primary-bg": tokens.component.buttonPrimaryBg,
    "--component-button-secondary-bg": tokens.component.buttonSecondaryBg,
    "--component-input-bg": tokens.component.inputBg,
    "--component-focus-ring": tokens.component.focusRing,
  } satisfies Record<string, string>;
}

export const themeCssVariables: Record<ThemeMode, Record<string, string>> = {
  dark: buildThemeCssVariables(themeTokens.dark),
  light: buildThemeCssVariables(themeTokens.light),
};

export function getThemeCssVariables(theme: ThemeMode) {
  return themeCssVariables[theme];
}
