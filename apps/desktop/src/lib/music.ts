export type KeyMode = "major" | "minor";
export type ChordQuality =
  | "major"
  | "minor"
  | "7"
  | "maj7"
  | "m7"
  | "sus2"
  | "sus4"
  | "dim"
  | "aug"
  | "dim7"
  | "hdim7";
export type EnharmonicDisplayMode = "auto" | "sharps" | "flats" | "neutral" | "dual";

export type MusicalKey = {
  pitchClass: number;
  mode: KeyMode;
};

export type PitchFormatOptions = {
  activeKey?: MusicalKey | null;
  mode?: EnharmonicDisplayMode;
};

export type Pitch = ParsedPitch;
export type ParsedChordSymbol = ChordSpelling;
export type GuitarStringProfile = GuitarStringTuning;
export type GuitarVoicingPosition = GuitarVoicingNote;

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

export type ParsedPitch = {
  pitchClass: number;
  octave: number;
  midi: number;
  noteName: string;
  label: string;
};

export type PitchLike = Pick<ParsedPitch, "octave" | "pitchClass">;

export type ChordSpellingQuality = "major" | "minor" | "dim" | "7" | "maj7" | "m7";

export type ChordDegree = "1" | "b3" | "3" | "b5" | "5" | "b7" | "7";

export type ChordToneDefinition = {
  degree: ChordDegree;
  interval: number;
};

export type ChordQualityDefinition = {
  label: string;
  suffix: string;
  tones: readonly ChordToneDefinition[];
};

export type ParsedChord = {
  root: string;
  rootPitchClass: number;
  quality: ChordSpellingQuality;
  bass: string | null;
  bassPitchClass: number | null;
};

export type ChordTone = ChordToneDefinition & {
  pitchClass: number;
  noteName: string;
};

export type ChordSpelling = ParsedChord & {
  label: string;
  tones: readonly ChordTone[];
  notes: readonly string[];
  bassNoteName: string | null;
};

export type ChordInput = string | ParsedChord | ChordSpelling;

export type ChordDisplayContext = {
  sourceKey: MusicalKey | null;
  transposeSemitones: number;
  capoFret: number;
  useCapoShapes: boolean;
  canCapo: boolean;
};

export type GuitarFinger = 1 | 2 | 3 | 4;
export type GuitarShapeFamily = "C" | "A" | "G" | "E" | "D";

export type GuitarStringTuning = {
  string: number;
  openPitch: ParsedPitch;
};

export type GuitarProfile = {
  id: "guitar";
  label: string;
  tuning: readonly GuitarStringTuning[];
  frets: number;
  canCapo: boolean;
  canRetune: boolean;
};

export type GuitarVoicingTemplateNote = {
  string: number;
  fret: number;
  finger?: GuitarFinger;
};

export type GuitarVoicingTemplate = {
  id: string;
  label: string;
  shapeChordLabel: string;
  shapeFamily: GuitarShapeFamily;
  rank: number;
  notes: readonly GuitarVoicingTemplateNote[];
};

export type GuitarVoicingNote = {
  string: number;
  fret: number;
  soundingFret: number;
  degree: ChordDegree;
  note: string;
  pitch: ParsedPitch;
  finger?: GuitarFinger;
};

export type GuitarVoicing = {
  id: string;
  label: string;
  chordLabel: string;
  shapeChordLabel: string;
  shapeFamily?: GuitarShapeFamily;
  source: "common" | "generated";
  rank: number;
  capoFret: number;
  mutedStrings: readonly number[];
  notes: readonly GuitarVoicingNote[];
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

export const CHORD_QUALITY_DEFINITIONS: Record<ChordSpellingQuality, ChordQualityDefinition> = {
  major: {
    label: "Major",
    suffix: "",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "3", interval: 4 },
      { degree: "5", interval: 7 },
    ],
  },
  minor: {
    label: "Minor",
    suffix: "m",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "b3", interval: 3 },
      { degree: "5", interval: 7 },
    ],
  },
  dim: {
    label: "Diminished",
    suffix: "dim",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "b3", interval: 3 },
      { degree: "b5", interval: 6 },
    ],
  },
  "7": {
    label: "Dominant 7",
    suffix: "7",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "3", interval: 4 },
      { degree: "5", interval: 7 },
      { degree: "b7", interval: 10 },
    ],
  },
  maj7: {
    label: "Major 7",
    suffix: "maj7",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "3", interval: 4 },
      { degree: "5", interval: 7 },
      { degree: "7", interval: 11 },
    ],
  },
  m7: {
    label: "Minor 7",
    suffix: "m7",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "b3", interval: 3 },
      { degree: "5", interval: 7 },
      { degree: "b7", interval: 10 },
    ],
  },
};

const PARSED_CHORD_PATTERN = /^([A-G](?:#|b)?)(maj7|m7|dim|m|7)?(?:\/([A-G](?:#|b)?))?$/i;

export const DEFAULT_CHORD_DISPLAY_CONTEXT: ChordDisplayContext = {
  sourceKey: null,
  transposeSemitones: 0,
  capoFret: 0,
  useCapoShapes: false,
  canCapo: true,
};

export const GUITAR_STANDARD_PROFILE: GuitarProfile = {
  id: "guitar",
  label: "Guitar",
  tuning: [
    { string: 6, openPitch: parsePitchRequired("E2") },
    { string: 5, openPitch: parsePitchRequired("A2") },
    { string: 4, openPitch: parsePitchRequired("D3") },
    { string: 3, openPitch: parsePitchRequired("G3") },
    { string: 2, openPitch: parsePitchRequired("B3") },
    { string: 1, openPitch: parsePitchRequired("E4") },
  ],
  frets: 22,
  canCapo: true,
  canRetune: true,
};

export const INSTRUMENT_PROFILES = {
  guitar: GUITAR_STANDARD_PROFILE,
} as const;

export const GUITAR_COMMON_VOICING_TEMPLATES: readonly GuitarVoicingTemplate[] = [
  {
    id: "c-open",
    label: "C open",
    shapeChordLabel: "C",
    shapeFamily: "C",
    rank: 10,
    notes: [
      { string: 5, fret: 3, finger: 3 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 0 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "g-open",
    label: "G open",
    shapeChordLabel: "G",
    shapeFamily: "G",
    rank: 10,
    notes: [
      { string: 6, fret: 3, finger: 2 },
      { string: 5, fret: 2, finger: 1 },
      { string: 4, fret: 0 },
      { string: 3, fret: 0 },
      { string: 2, fret: 0 },
      { string: 1, fret: 3, finger: 3 },
    ],
  },
  {
    id: "g-over-d-open",
    label: "G/D open",
    shapeChordLabel: "G/D",
    shapeFamily: "G",
    rank: 12,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 0 },
      { string: 2, fret: 0 },
      { string: 1, fret: 3, finger: 3 },
    ],
  },
  {
    id: "am-open",
    label: "Am open",
    shapeChordLabel: "Am",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 2, finger: 3 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "f-e-barre",
    label: "F E-shape barre",
    shapeChordLabel: "F",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 1, finger: 1 },
      { string: 5, fret: 3, finger: 3 },
      { string: 4, fret: 3, finger: 4 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 1, finger: 1 },
    ],
  },
  {
    id: "f-partial",
    label: "F partial",
    shapeChordLabel: "F",
    shapeFamily: "E",
    rank: 20,
    notes: [
      { string: 4, fret: 3, finger: 3 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 1, finger: 1 },
    ],
  },
  {
    id: "cmaj7-open",
    label: "Cmaj7 open",
    shapeChordLabel: "Cmaj7",
    shapeFamily: "C",
    rank: 10,
    notes: [
      { string: 5, fret: 3, finger: 3 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 0 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "g7-open",
    label: "G7 open",
    shapeChordLabel: "G7",
    shapeFamily: "G",
    rank: 10,
    notes: [
      { string: 6, fret: 3, finger: 3 },
      { string: 5, fret: 2, finger: 2 },
      { string: 4, fret: 0 },
      { string: 3, fret: 0 },
      { string: 2, fret: 0 },
      { string: 1, fret: 1, finger: 1 },
    ],
  },
  {
    id: "e-open",
    label: "E open",
    shapeChordLabel: "E",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 2, finger: 2 },
      { string: 4, fret: 2, finger: 3 },
      { string: 3, fret: 1, finger: 1 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
] as const;

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
  bassPitchClass?: number | null,
): string {
  const suffix = chordQualitySuffix(quality);
  const noteName =
    options.mode === "dual"
      ? formatDualPitchClass(pitchClass, suffix, bassPitchClass)
      : formatChordRoot(pitchClass, options);
  if (options.mode === "dual") {
    return noteName;
  }
  const bassSuffix =
    typeof bassPitchClass === "number" && bassPitchClass !== pitchClass
      ? `/${formatPitchClass(bassPitchClass, options)}`
      : "";
  return `${noteName}${suffix}${bassSuffix}`;
}

export function formatChordDisplay(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
  bassPitchClass?: number | null,
): FormattedMusicalLabel {
  const { primaryLabel, secondaryLabel } =
    options.mode === "dual"
      ? formatDualChordLabels(pitchClass, quality, bassPitchClass)
      : {
          primaryLabel: formatChordLabel(pitchClass, quality, options, bassPitchClass),
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
  bassPitchClass?: number | null,
): string | null {
  const alternateRoot = formatAlternatePitchClass(pitchClass, options);
  if (!alternateRoot) {
    return null;
  }
  const alternateBass =
    typeof bassPitchClass === "number" && bassPitchClass !== pitchClass
      ? formatAlternatePitchClass(bassPitchClass, options) ?? formatPitchClass(bassPitchClass, options)
      : null;
  return `${alternateRoot}${chordQualitySuffix(quality)}${alternateBass ? `/${alternateBass}` : ""}`;
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
    quality === "dim" ||
    quality === "aug" ||
    quality === "dim7" ||
    quality === "hdim7"
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

export function parsePitch(value: string | null | undefined): ParsedPitch | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(/^([A-G](?:#|b)?)(-?\d+)$/i);
  if (!match) {
    return null;
  }

  const noteName = normalizeNoteName(match[1]);
  const pitchClass = ENHARMONIC_ALIASES[noteName];
  const octave = Number(match[2]);
  if (pitchClass === undefined || !Number.isInteger(octave)) {
    return null;
  }

  const midi = pitchToMidi({ octave, pitchClass });
  return {
    pitchClass,
    octave,
    midi,
    noteName,
    label: `${noteName}${octave}`,
  };
}

export function formatPitch(pitch: PitchLike, options: PitchFormatOptions = {}): string {
  return `${formatPitchClass(pitch.pitchClass, options)}${pitch.octave}`;
}

export function pitchToMidi(pitch: PitchLike): number {
  return (pitch.octave + 1) * 12 + normalizePitchClass(pitch.pitchClass);
}

export function midiToPitch(midi: number, options: PitchFormatOptions = {}): ParsedPitch | null {
  if (!Number.isInteger(midi)) {
    return null;
  }

  const pitchClass = normalizePitchClass(midi);
  const octave = Math.floor(midi / 12) - 1;
  const noteName = formatPitchClass(pitchClass, options);
  return {
    pitchClass,
    octave,
    midi,
    noteName,
    label: `${noteName}${octave}`,
  };
}

export function parseChordLabel(label: string | null | undefined): ParsedChord | null {
  if (!label) {
    return null;
  }

  const match = label.trim().match(PARSED_CHORD_PATTERN);
  if (!match) {
    return null;
  }

  const root = normalizeNoteName(match[1]);
  const rootPitchClass = ENHARMONIC_ALIASES[root];
  const quality = parseChordQualitySuffix(match[2] ?? "");
  if (rootPitchClass === undefined || !quality) {
    return null;
  }

  const bass = match[3] ? normalizeNoteName(match[3]) : null;
  const bassPitchClass = bass ? ENHARMONIC_ALIASES[bass] : null;
  if (bass && bassPitchClass === undefined) {
    return null;
  }

  return {
    root,
    rootPitchClass,
    quality,
    bass,
    bassPitchClass,
  };
}

export function isChordSpellingQuality(quality: string | null | undefined): quality is ChordSpellingQuality {
  return (
    quality === "major" ||
    quality === "minor" ||
    quality === "dim" ||
    quality === "7" ||
    quality === "maj7" ||
    quality === "m7"
  );
}

export function formatParsedChordLabel(chord: ParsedChord, options: PitchFormatOptions = {}): string {
  return formatChordLabel(
    chord.rootPitchClass,
    chord.quality,
    resolveChordFormatOptions(chord, options),
    chord.bassPitchClass,
  );
}

export function spellChord(chord: ChordInput, options: PitchFormatOptions = {}): ChordSpelling | null {
  const parsedChord = parseChordInput(chord);
  if (!parsedChord) {
    return null;
  }

  const chordOptions = resolveChordFormatOptions(parsedChord, options);
  const definition = CHORD_QUALITY_DEFINITIONS[parsedChord.quality];
  const tones = definition.tones.map((tone) => {
    const pitchClass = transposePitchClass(parsedChord.rootPitchClass, tone.interval);
    return {
      ...tone,
      pitchClass,
      noteName: formatPitchClass(pitchClass, chordOptions),
    };
  });

  const bassNoteName =
    typeof parsedChord.bassPitchClass === "number" ? formatPitchClass(parsedChord.bassPitchClass, chordOptions) : null;

  return {
    ...parsedChord,
    label: formatParsedChordLabel(parsedChord, chordOptions),
    tones,
    notes: tones.map((tone) => tone.noteName),
    bassNoteName,
  };
}

export function transposeChord(chord: ChordInput, semitones: number): ParsedChord | null {
  const parsedChord = parseChordInput(chord);
  if (!parsedChord) {
    return null;
  }
  return transposeParsedChord(parsedChord, semitones);
}

export function transposeChordLabel(
  chord: ChordInput,
  semitones: number,
  options: PitchFormatOptions = {},
): string | null {
  const transposed = transposeChord(chord, semitones);
  return transposed ? formatParsedChordLabel(transposed, options) : null;
}

export function resolveChordDisplayContext(
  context: Partial<ChordDisplayContext> = {},
  profile: Pick<GuitarProfile, "canCapo"> = GUITAR_STANDARD_PROFILE,
): ChordDisplayContext {
  const capoFret = Math.max(0, Math.trunc(context.capoFret ?? DEFAULT_CHORD_DISPLAY_CONTEXT.capoFret));
  const canCapo = context.canCapo ?? profile.canCapo;
  return {
    sourceKey: context.sourceKey ?? DEFAULT_CHORD_DISPLAY_CONTEXT.sourceKey,
    transposeSemitones: context.transposeSemitones ?? DEFAULT_CHORD_DISPLAY_CONTEXT.transposeSemitones,
    capoFret,
    useCapoShapes: context.useCapoShapes ?? DEFAULT_CHORD_DISPLAY_CONTEXT.useCapoShapes,
    canCapo,
  };
}

export function getCapoShapeSemitones(
  context: Partial<ChordDisplayContext> = {},
  profile: Pick<GuitarProfile, "canCapo"> = GUITAR_STANDARD_PROFILE,
): number {
  const resolvedContext = resolveChordDisplayContext(context, profile);
  return resolvedContext.useCapoShapes && resolvedContext.canCapo ? -resolvedContext.capoFret : 0;
}

export function getCapoShapeChord(
  chord: ChordInput,
  context: Partial<ChordDisplayContext> = {},
  profile: Pick<GuitarProfile, "canCapo"> = GUITAR_STANDARD_PROFILE,
): ParsedChord | null {
  const parsedChord = parseChordInput(chord);
  if (!parsedChord) {
    return null;
  }
  const resolvedContext = resolveChordDisplayContext(context, profile);
  const soundingChord = transposeParsedChord(parsedChord, resolvedContext.transposeSemitones);
  return transposeParsedChord(soundingChord, getCapoShapeSemitones(resolvedContext, profile));
}

export function generateGuitarVoicings(
  chord: ChordInput,
  profile: GuitarProfile = GUITAR_STANDARD_PROFILE,
  context: Partial<ChordDisplayContext> = {},
  options: PitchFormatOptions = {},
): readonly GuitarVoicing[] {
  const parsedChord = parseChordInput(chord);
  if (!parsedChord) {
    return [];
  }

  const resolvedContext = resolveChordDisplayContext(context, profile);
  const soundingChord = transposeParsedChord(parsedChord, resolvedContext.transposeSemitones);
  const shapeChord = transposeParsedChord(soundingChord, getCapoShapeSemitones(resolvedContext, profile));
  const chordOptions = {
    ...resolveChordFormatOptions(soundingChord, options),
    activeKey: options.activeKey ?? resolvedContext.sourceKey ?? resolveChordFormatOptions(soundingChord).activeKey,
  };
  const soundingSpelling = spellChord(soundingChord, chordOptions);
  const shapeLabel = formatParsedChordLabel(shapeChord, chordOptions);
  if (!soundingSpelling) {
    return [];
  }

  const commonVoicings = GUITAR_COMMON_VOICING_TEMPLATES.flatMap((template) => {
    const templateChord = parseChordLabel(template.shapeChordLabel);
    if (
      !templateChord ||
      templateChord.rootPitchClass !== shapeChord.rootPitchClass ||
      templateChord.quality !== shapeChord.quality ||
      templateChord.bassPitchClass !== shapeChord.bassPitchClass
    ) {
      return [];
    }

    const voicing = renderGuitarTemplate(template, soundingSpelling, shapeLabel, profile, resolvedContext, chordOptions);
    return voicing ? [voicing] : [];
  });

  const generatedVoicing = generateFallbackGuitarVoicing(
    soundingSpelling,
    shapeLabel,
    profile,
    resolvedContext,
    chordOptions,
  );
  return [...commonVoicings, ...(generatedVoicing ? [generatedVoicing] : [])].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === "common" ? -1 : 1;
    }
    return left.rank - right.rank;
  });
}

function parsePitchRequired(label: string): ParsedPitch {
  const pitch = parsePitch(label);
  if (!pitch) {
    throw new Error(`Invalid pitch label: ${label}`);
  }
  return pitch;
}

function parseChordQualitySuffix(suffix: string): ChordSpellingQuality | null {
  switch (suffix.toLowerCase()) {
    case "":
      return "major";
    case "m":
      return "minor";
    case "dim":
      return "dim";
    case "7":
      return "7";
    case "maj7":
      return "maj7";
    case "m7":
      return "m7";
    default:
      return null;
  }
}

function parseChordInput(chord: ChordInput): ParsedChord | null {
  if (typeof chord === "string") {
    return parseChordLabel(chord);
  }
  return {
    root: chord.root,
    rootPitchClass: normalizePitchClass(chord.rootPitchClass),
    quality: chord.quality,
    bass: chord.bass,
    bassPitchClass: typeof chord.bassPitchClass === "number" ? normalizePitchClass(chord.bassPitchClass) : null,
  };
}

function transposeParsedChord(chord: ParsedChord, semitones: number): ParsedChord {
  const rootPitchClass = transposePitchClass(chord.rootPitchClass, semitones);
  const bassPitchClass =
    typeof chord.bassPitchClass === "number" ? transposePitchClass(chord.bassPitchClass, semitones) : null;
  return {
    root: formatPitchClass(rootPitchClass, resolveChordFormatOptions({ ...chord, rootPitchClass })),
    rootPitchClass,
    quality: chord.quality,
    bass: typeof bassPitchClass === "number" ? formatPitchClass(bassPitchClass) : null,
    bassPitchClass,
  };
}

function resolveChordFormatOptions(
  chord: Pick<ParsedChord, "quality" | "rootPitchClass">,
  options: PitchFormatOptions = {},
): PitchFormatOptions {
  if (options.activeKey || options.mode) {
    return options;
  }
  return {
    activeKey: {
      pitchClass: normalizePitchClass(chord.rootPitchClass),
      mode: chord.quality === "minor" || chord.quality === "m7" ? "minor" : "major",
    } satisfies MusicalKey,
  };
}

function renderGuitarTemplate(
  template: GuitarVoicingTemplate,
  chord: ChordSpelling,
  shapeChordLabel: string,
  profile: GuitarProfile,
  context: ChordDisplayContext,
  options: PitchFormatOptions,
): GuitarVoicing | null {
  const notes = template.notes
    .map((templateNote) => renderGuitarNote(templateNote, chord, profile, context, options))
    .filter((note): note is GuitarVoicingNote => Boolean(note));
  if (notes.length !== template.notes.length) {
    return null;
  }
  if (!hasRequiredChordDegrees(chord, notes) || !hasRequiredBass(chord, notes)) {
    return null;
  }

  return {
    id: `${template.id}${context.capoFret > 0 ? `-capo-${context.capoFret}` : ""}`,
    label: template.label,
    chordLabel: chord.label,
    shapeChordLabel,
    shapeFamily: template.shapeFamily,
    source: "common",
    rank: template.rank,
    capoFret: context.useCapoShapes && context.canCapo ? context.capoFret : 0,
    mutedStrings: getMutedStrings(profile, template.notes),
    notes,
  };
}

function renderGuitarNote(
  templateNote: GuitarVoicingTemplateNote,
  chord: ChordSpelling,
  profile: GuitarProfile,
  context: ChordDisplayContext,
  options: PitchFormatOptions,
): GuitarVoicingNote | null {
  const tuning = profile.tuning.find((stringTuning) => stringTuning.string === templateNote.string);
  const capoFret = context.useCapoShapes && context.canCapo ? context.capoFret : 0;
  const soundingFret = capoFret + templateNote.fret;
  if (!tuning || soundingFret > profile.frets) {
    return null;
  }

  const pitch = midiToPitch(tuning.openPitch.midi + soundingFret, options);
  if (!pitch) {
    return null;
  }

  const degree = getChordDegreeForPitchClass(chord, pitch.pitchClass);
  if (!degree) {
    return null;
  }

  return {
    string: templateNote.string,
    fret: templateNote.fret,
    soundingFret,
    degree,
    note: pitch.label,
    pitch,
    ...(templateNote.finger ? { finger: templateNote.finger } : {}),
  };
}

function generateFallbackGuitarVoicing(
  chord: ChordSpelling,
  shapeChordLabel: string,
  profile: GuitarProfile,
  context: ChordDisplayContext,
  options: PitchFormatOptions,
): GuitarVoicing | null {
  const capoFret = context.useCapoShapes && context.canCapo ? context.capoFret : 0;
  const maxShapeFret = Math.min(5, profile.frets - capoFret);
  const notes = profile.tuning
    .map((stringTuning) => {
      const match = findLowestChordFret(stringTuning, chord, capoFret, maxShapeFret, options);
      return match;
    })
    .filter((note): note is GuitarVoicingNote => Boolean(note));

  if (notes.length < 3 || !hasRequiredChordDegrees(chord, notes) || !hasRequiredBass(chord, notes)) {
    return null;
  }

  return {
    id: `${chord.label.toLowerCase().replaceAll("/", "-")}-generated`,
    label: `${chord.label} generated`,
    chordLabel: chord.label,
    shapeChordLabel,
    source: "generated",
    rank: 1000,
    capoFret,
    mutedStrings: getMutedStrings(profile, notes),
    notes,
  };
}

function findLowestChordFret(
  tuning: GuitarStringTuning,
  chord: ChordSpelling,
  capoFret: number,
  maxShapeFret: number,
  options: PitchFormatOptions,
): GuitarVoicingNote | null {
  for (let fret = 0; fret <= maxShapeFret; fret += 1) {
    const soundingFret = capoFret + fret;
    const pitch = midiToPitch(tuning.openPitch.midi + soundingFret, options);
    if (!pitch) {
      return null;
    }
    const degree = getChordDegreeForPitchClass(chord, pitch.pitchClass);
    if (degree) {
      return {
        string: tuning.string,
        fret,
        soundingFret,
        degree,
        note: pitch.label,
        pitch,
      };
    }
  }
  return null;
}

function getChordDegreeForPitchClass(chord: ChordSpelling, pitchClass: number): ChordDegree | null {
  return chord.tones.find((tone) => tone.pitchClass === normalizePitchClass(pitchClass))?.degree ?? null;
}

function hasRequiredChordDegrees(chord: ChordSpelling, notes: readonly GuitarVoicingNote[]): boolean {
  const presentDegrees = new Set(notes.map((note) => note.degree));
  return chord.tones.every((tone) => presentDegrees.has(tone.degree));
}

function hasRequiredBass(chord: ChordSpelling, notes: readonly GuitarVoicingNote[]): boolean {
  if (typeof chord.bassPitchClass !== "number") {
    return true;
  }
  const lowestNote = [...notes].sort((left, right) => left.pitch.midi - right.pitch.midi)[0];
  return lowestNote?.pitch.pitchClass === chord.bassPitchClass;
}

function getMutedStrings(
  profile: GuitarProfile,
  playedNotes: readonly Pick<GuitarVoicingTemplateNote, "string">[],
): readonly number[] {
  const playedStrings = new Set(playedNotes.map((note) => note.string));
  return profile.tuning.map((stringTuning) => stringTuning.string).filter((stringNumber) => !playedStrings.has(stringNumber));
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
  bassPitchClass?: number | null,
): { primaryLabel: string; secondaryLabel: string | null } {
  const { primaryRoot, secondaryRoot } = getDualPitchClassParts(pitchClass);
  const bassParts =
    typeof bassPitchClass === "number" && bassPitchClass !== pitchClass
      ? getDualPitchClassParts(bassPitchClass)
      : null;
  const suffix = chordQualitySuffix(quality);
  const primaryBass = bassParts ? `/${bassParts.primaryRoot}` : "";
  const secondaryBass = bassParts ? `/${bassParts.secondaryRoot ?? bassParts.primaryRoot}` : "";
  return {
    primaryLabel: `${primaryRoot}${suffix}${primaryBass}`,
    secondaryLabel:
      secondaryRoot || bassParts?.secondaryRoot
        ? `${secondaryRoot ?? primaryRoot}${suffix}${secondaryBass}`
        : null,
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

function formatDualPitchClass(pitchClass: number, suffix = "", bassPitchClass?: number | null): string {
  const normalizedPitchClass = normalizePitchClass(pitchClass);
  const sharpLabel = SHARP_PITCH_CLASSES[normalizedPitchClass] ?? SHARP_PITCH_CLASSES[0];
  const flatLabel = FLAT_PITCH_CLASSES[normalizedPitchClass] ?? FLAT_PITCH_CLASSES[0];
  const sharpBassSuffix =
    typeof bassPitchClass === "number" && bassPitchClass !== pitchClass
      ? `/${SHARP_PITCH_CLASSES[normalizePitchClass(bassPitchClass)] ?? SHARP_PITCH_CLASSES[0]}`
      : "";
  if (sharpLabel === flatLabel) {
    return `${sharpLabel}${suffix}${sharpBassSuffix}`;
  }
  const flatBassSuffix =
    typeof bassPitchClass === "number" && bassPitchClass !== pitchClass
      ? `/${FLAT_PITCH_CLASSES[normalizePitchClass(bassPitchClass)] ?? FLAT_PITCH_CLASSES[0]}`
      : "";
  return `${sharpLabel}${suffix}${sharpBassSuffix}/${flatLabel}${suffix}${flatBassSuffix}`;
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
    case "aug":
      return "aug";
    case "dim7":
      return "dim7";
    case "hdim7":
      return "m7b5";
  }
}
