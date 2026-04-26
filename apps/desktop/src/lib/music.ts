export type KeyMode = "major" | "minor";
export type ChordQuality = "major" | "minor" | "7" | "maj7" | "m7" | "sus2" | "sus4" | "dim";
export type EnharmonicDisplayMode = "auto" | "sharps" | "flats" | "neutral" | "dual";

export type MusicalKey = {
  pitchClass: number;
  mode: KeyMode;
};

export type PitchFormatOptions = {
  activeKey?: MusicalKey | null;
  mode?: EnharmonicDisplayMode;
};

type AccidentalFamily = "sharp" | "flat" | "neutral";

export type EnharmonicContext = {
  mode: EnharmonicDisplayMode;
  family: AccidentalFamily;
};

export type MusicalLabelPart = {
  root: string;
  suffix: string;
};

export type FormattedMusicalLabel = {
  ariaLabel: string;
  primary: MusicalLabelPart;
  secondary: MusicalLabelPart | null;
};

const ENHARMONIC_ALIASES: Record<string, number> = {
  C: 0,
  "B#": 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  F: 5,
  "E#": 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};

const SHARP_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const FLAT_PITCH_CLASSES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;
const NEUTRAL_PITCH_CLASSES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;
const DUAL_PITCH_CLASSES = [
  "C",
  "C#/Db",
  "D",
  "D#/Eb",
  "E",
  "F",
  "F#/Gb",
  "G",
  "G#/Ab",
  "A",
  "A#/Bb",
  "B",
] as const;

const AUTO_KEY_FAMILIES: Record<KeyMode, readonly AccidentalFamily[]> = {
  major: ["neutral", "flat", "sharp", "flat", "sharp", "flat", "sharp", "sharp", "flat", "sharp", "flat", "sharp"],
  minor: ["flat", "sharp", "flat", "flat", "sharp", "flat", "sharp", "flat", "sharp", "neutral", "flat", "sharp"],
};

const CHROMATIC_PITCH_CLASSES = Array.from({ length: 12 }, (_, pitchClass) => pitchClass);

const KEY_ORDER: MusicalKey[] = [
  ...CHROMATIC_PITCH_CLASSES.map((pitchClass) => ({ pitchClass, mode: "major" as const })),
  ...CHROMATIC_PITCH_CLASSES.map((pitchClass) => ({ pitchClass, mode: "minor" as const })),
];

export const DEFAULT_KEY: MusicalKey = { pitchClass: 0, mode: "major" };

export const MUSICAL_KEYS = KEY_ORDER.map((key) => ({
  ...key,
  value: serializeKey(key),
  label: formatKey(key),
}));

export function parseKey(value: string | null | undefined): MusicalKey | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  const compactMatch = normalized.match(/^([A-G](?:#|b)?)(m)?$/i);
  if (compactMatch) {
    const pitchClass = ENHARMONIC_ALIASES[normalizeNoteName(compactMatch[1])];
    if (pitchClass === undefined) {
      return null;
    }
    return {
      pitchClass,
      mode: compactMatch[2] ? "minor" : "major",
    };
  }

  const verboseMatch = normalized.match(/^([A-G](?:#|b)?)\s+(major|minor)$/i);
  if (!verboseMatch) {
    return null;
  }

  const pitchClass = ENHARMONIC_ALIASES[normalizeNoteName(verboseMatch[1])];
  if (pitchClass === undefined) {
    return null;
  }

  return {
    pitchClass,
    mode: verboseMatch[2].toLowerCase() === "minor" ? "minor" : "major",
  };
}

export function parseStoredKey(value: string | null | undefined): MusicalKey | null {
  if (!value) {
    return null;
  }
  if (value.includes(":")) {
    return deserializeKey(value);
  }
  return parseKey(value);
}

export function serializeKey(key: MusicalKey): string {
  return `${key.pitchClass}:${key.mode}`;
}

export function deserializeKey(value: string): MusicalKey {
  const [pitchClassRaw, modeRaw] = value.split(":");
  const pitchClass = Number(pitchClassRaw);
  if (!Number.isInteger(pitchClass) || pitchClass < 0 || pitchClass > 11) {
    return DEFAULT_KEY;
  }
  return {
    pitchClass,
    mode: modeRaw === "minor" ? "minor" : "major",
  };
}

export function getEnharmonicContext(
  activeKey: MusicalKey | null | undefined,
  mode: EnharmonicDisplayMode = "auto",
): EnharmonicContext {
  if (mode === "sharps") {
    return { mode, family: "sharp" };
  }
  if (mode === "flats") {
    return { mode, family: "flat" };
  }
  if (mode === "neutral" || mode === "dual") {
    return { mode, family: "neutral" };
  }
  if (!activeKey) {
    return { mode, family: "neutral" };
  }
  return {
    mode,
    family: AUTO_KEY_FAMILIES[activeKey.mode][normalizePitchClass(activeKey.pitchClass)] ?? "neutral",
  };
}

export function formatKey(
  key: MusicalKey,
  format: "short" | "long" = "short",
  options: PitchFormatOptions = {},
): string {
  const noteName =
    options.mode === "dual"
      ? formatDualPitchClass(key.pitchClass, format === "short" && key.mode === "minor" ? "m" : "")
      : formatPitchClass(key.pitchClass, {
          activeKey: options.activeKey ?? key,
          mode: options.mode,
        });
  if (format === "long") {
    if (options.mode === "dual") {
      const [sharpRoot, flatRoot] = noteName.split("/");
      if (!flatRoot) {
        return `${noteName} ${key.mode}`;
      }
      return `${sharpRoot} ${key.mode} / ${flatRoot} ${key.mode}`;
    }
    return `${noteName} ${key.mode}`;
  }
  if (options.mode === "dual") {
    return noteName;
  }
  return key.mode === "minor" ? `${noteName}m` : noteName;
}

export function formatKeyDisplay(
  key: MusicalKey,
  options: PitchFormatOptions = {},
): FormattedMusicalLabel {
  const { primaryLabel, secondaryLabel } =
    options.mode === "dual"
      ? formatDualKeyLabels(key)
      : {
          primaryLabel: formatKey(key, "short", options),
          secondaryLabel: null,
        };

  return {
    ariaLabel: secondaryLabel ? `${primaryLabel} / ${secondaryLabel}` : primaryLabel,
    primary: splitMusicalLabel(primaryLabel),
    secondary: secondaryLabel ? splitMusicalLabel(secondaryLabel) : null,
  };
}

export function formatPitchClass(pitchClass: number, options: PitchFormatOptions = {}): string {
  const normalizedPitchClass = normalizePitchClass(pitchClass);
  const context = getEnharmonicContext(options.activeKey, options.mode);
  if (context.mode === "dual") {
    return DUAL_PITCH_CLASSES[normalizedPitchClass] ?? DUAL_PITCH_CLASSES[0];
  }
  if (context.family === "sharp") {
    return SHARP_PITCH_CLASSES[normalizedPitchClass] ?? SHARP_PITCH_CLASSES[0];
  }
  if (context.family === "flat") {
    return FLAT_PITCH_CLASSES[normalizedPitchClass] ?? FLAT_PITCH_CLASSES[0];
  }
  return NEUTRAL_PITCH_CLASSES[normalizedPitchClass] ?? NEUTRAL_PITCH_CLASSES[0];
}

export function formatAlternatePitchClass(pitchClass: number, options: PitchFormatOptions = {}): string | null {
  const normalizedPitchClass = normalizePitchClass(pitchClass);
  const sharpLabel = SHARP_PITCH_CLASSES[normalizedPitchClass];
  const flatLabel = FLAT_PITCH_CLASSES[normalizedPitchClass];
  if (sharpLabel === flatLabel || options.mode === "dual") {
    return null;
  }
  const primaryLabel = formatPitchClass(normalizedPitchClass, options);
  return primaryLabel === sharpLabel ? flatLabel : sharpLabel;
}

export function formatChordRoot(pitchClass: number, options: PitchFormatOptions = {}): string {
  return formatPitchClass(pitchClass, options);
}

export function formatChordLabel(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
): string {
  const suffix = chordQualitySuffix(quality);
  const noteName =
    options.mode === "dual"
      ? formatDualPitchClass(pitchClass, suffix)
      : formatChordRoot(pitchClass, options);
  if (options.mode === "dual") {
    return noteName;
  }
  return `${noteName}${suffix}`;
}

export function formatChordDisplay(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
): FormattedMusicalLabel {
  const { primaryLabel, secondaryLabel } =
    options.mode === "dual"
      ? formatDualChordLabels(pitchClass, quality)
      : {
          primaryLabel: formatChordLabel(pitchClass, quality, options),
          secondaryLabel: null,
        };

  return {
    ariaLabel: secondaryLabel ? `${primaryLabel} / ${secondaryLabel}` : primaryLabel,
    primary: splitMusicalLabel(primaryLabel),
    secondary: secondaryLabel ? splitMusicalLabel(secondaryLabel) : null,
  };
}

export function formatAlternateKey(
  key: MusicalKey,
  format: "short" | "long" = "short",
  options: PitchFormatOptions = {},
): string | null {
  const alternateRoot = formatAlternatePitchClass(key.pitchClass, {
    activeKey: options.activeKey ?? key,
    mode: options.mode,
  });
  if (!alternateRoot) {
    return null;
  }
  if (format === "long") {
    return `${alternateRoot} ${key.mode}`;
  }
  return key.mode === "minor" ? `${alternateRoot}m` : alternateRoot;
}

export function formatAlternateChordLabel(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
): string | null {
  const alternateRoot = formatAlternatePitchClass(pitchClass, options);
  if (!alternateRoot) {
    return null;
  }
  return `${alternateRoot}${chordQualitySuffix(quality)}`;
}

export function isSupportedChordQuality(quality: string | null | undefined): quality is ChordQuality {
  return (
    quality === "major" ||
    quality === "minor" ||
    quality === "7" ||
    quality === "maj7" ||
    quality === "m7" ||
    quality === "sus2" ||
    quality === "sus4" ||
    quality === "dim"
  );
}

export function formatRawMusicalLabel(label: string): FormattedMusicalLabel {
  return {
    ariaLabel: label,
    primary: splitMusicalLabel(label),
    secondary: null,
  };
}

export function transposePitchClass(pitchClass: number, semitones: number): number {
  return ((pitchClass + semitones) % 12 + 12) % 12;
}

export function transposeKey(key: MusicalKey, semitones: number): MusicalKey {
  const normalized = ((key.pitchClass + semitones) % 12 + 12) % 12;
  return { pitchClass: normalized, mode: key.mode };
}

export function semitoneDelta(source: MusicalKey, target: MusicalKey): number {
  const upwardDistance = (target.pitchClass - source.pitchClass + 12) % 12;
  if (upwardDistance === 0) {
    return 0;
  }
  return upwardDistance <= 6 ? upwardDistance : upwardDistance - 12;
}

function normalizeNoteName(noteName: string): string {
  const [letter, accidental = ""] = noteName.trim();
  return `${letter.toUpperCase()}${accidental}`;
}

function splitMusicalLabel(label: string): MusicalLabelPart {
  const match = label.match(/^([A-G](?:#|b)?)(.*)$/);
  if (!match) {
    return { root: label, suffix: "" };
  }
  return {
    root: match[1],
    suffix: match[2] ?? "",
  };
}

function normalizePitchClass(pitchClass: number): number {
  return ((pitchClass % 12) + 12) % 12;
}

function formatDualKeyLabels(key: MusicalKey): { primaryLabel: string; secondaryLabel: string | null } {
  const { primaryRoot, secondaryRoot } = getDualPitchClassParts(key.pitchClass);
  const suffix = key.mode === "minor" ? "m" : "";
  return {
    primaryLabel: `${primaryRoot}${suffix}`,
    secondaryLabel: secondaryRoot ? `${secondaryRoot}${suffix}` : null,
  };
}

function formatDualChordLabels(
  pitchClass: number,
  quality: ChordQuality,
): { primaryLabel: string; secondaryLabel: string | null } {
  const { primaryRoot, secondaryRoot } = getDualPitchClassParts(pitchClass);
  const suffix = chordQualitySuffix(quality);
  return {
    primaryLabel: `${primaryRoot}${suffix}`,
    secondaryLabel: secondaryRoot ? `${secondaryRoot}${suffix}` : null,
  };
}

function getDualPitchClassParts(pitchClass: number): { primaryRoot: string; secondaryRoot: string | null } {
  const normalizedPitchClass = normalizePitchClass(pitchClass);
  const dualLabel = DUAL_PITCH_CLASSES[normalizedPitchClass] ?? DUAL_PITCH_CLASSES[0];
  const [primaryRoot, secondaryRoot] = dualLabel.split("/");
  return {
    primaryRoot,
    secondaryRoot: secondaryRoot ?? null,
  };
}

function formatDualPitchClass(pitchClass: number, suffix = ""): string {
  const normalizedPitchClass = normalizePitchClass(pitchClass);
  const sharpLabel = SHARP_PITCH_CLASSES[normalizedPitchClass] ?? SHARP_PITCH_CLASSES[0];
  const flatLabel = FLAT_PITCH_CLASSES[normalizedPitchClass] ?? FLAT_PITCH_CLASSES[0];
  if (sharpLabel === flatLabel) {
    return `${sharpLabel}${suffix}`;
  }
  return `${sharpLabel}${suffix}/${flatLabel}${suffix}`;
}

function chordQualitySuffix(quality: ChordQuality): string {
  switch (quality) {
    case "major":
      return "";
    case "minor":
      return "m";
    case "7":
      return "7";
    case "maj7":
      return "maj7";
    case "m7":
      return "m7";
    case "sus2":
      return "sus2";
    case "sus4":
      return "sus4";
    case "dim":
      return "dim";
  }
}
