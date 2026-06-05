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

export type ChordSpellingQuality = ChordQuality;

export type ChordDegree =
  | "1"
  | "b2"
  | "#1"
  | "2"
  | "#2"
  | "b3"
  | "3"
  | "4"
  | "#4"
  | "b5"
  | "5"
  | "#5"
  | "b6"
  | "6"
  | "#6"
  | "bb7"
  | "b7"
  | "7";

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
  rawLabel?: string;
  root: string;
  rootPitchClass: number;
  quality: ChordSpellingQuality;
  bass: string | null;
  bassPitchClass: number | null;
  bassDegree?: ChordDegree;
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

const CHORD_DEGREE_INTERVALS: Record<ChordDegree, number> = {
  "1": 0,
  b2: 1,
  "#1": 1,
  "2": 2,
  "#2": 3,
  b3: 3,
  "3": 4,
  "4": 5,
  "#4": 6,
  b5: 6,
  "5": 7,
  "#5": 8,
  b6: 8,
  "6": 9,
  "#6": 10,
  bb7: 9,
  b7: 10,
  "7": 11,
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
  sus2: {
    label: "Suspended 2",
    suffix: "sus2",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "2", interval: 2 },
      { degree: "5", interval: 7 },
    ],
  },
  sus4: {
    label: "Suspended 4",
    suffix: "sus4",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "4", interval: 5 },
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
  aug: {
    label: "Augmented",
    suffix: "aug",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "3", interval: 4 },
      { degree: "#5", interval: 8 },
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
  dim7: {
    label: "Diminished 7",
    suffix: "dim7",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "b3", interval: 3 },
      { degree: "b5", interval: 6 },
      { degree: "bb7", interval: 9 },
    ],
  },
  hdim7: {
    label: "Half-diminished 7",
    suffix: "m7b5",
    tones: [
      { degree: "1", interval: 0 },
      { degree: "b3", interval: 3 },
      { degree: "b5", interval: 6 },
      { degree: "b7", interval: 10 },
    ],
  },
};

const NO_CHORD_LABELS = new Set(["N", "NC", "N.C.", "NO_CHORD", "NO-CHORD"]);
const UNKNOWN_CHORD_LABELS = new Set(["X"]);
const HARTE_CHORD_PATTERN = /^([A-G](?:#|b)?)(?::([^/]+))?(?:\/(.+))?$/i;
const LEAD_SHEET_CHORD_PATTERN = /^([A-G](?:#|b)?)([^/]*)(?:\/(.+))?$/i;
const CHORD_QUALITY_ALIASES: Record<string, ChordSpellingQuality> = {
  "": "major",
  maj: "major",
  major: "major",
  min: "minor",
  minor: "minor",
  m: "minor",
  dim: "dim",
  diminished: "dim",
  aug: "aug",
  augmented: "aug",
  "+": "aug",
  sus: "sus4",
  sus2: "sus2",
  sus4: "sus4",
  "7": "7",
  dom7: "7",
  maj7: "maj7",
  major7: "maj7",
  min7: "m7",
  minor7: "m7",
  m7: "m7",
  dim7: "dim7",
  hdim7: "hdim7",
  "half-diminished": "hdim7",
  "half-diminished7": "hdim7",
  "min7(b5)": "hdim7",
  "m7(b5)": "hdim7",
  min7b5: "hdim7",
  m7b5: "hdim7",
};

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

const GUITAR_TEMPLATE_STRINGS = [6, 5, 4, 3, 2, 1] as const;
const GUITAR_TEMPLATE_QUALITY_SUFFIXES = {
  major: "",
  minor: "m",
  "7": "7",
  maj7: "maj7",
  m7: "m7",
  sus2: "sus2",
  sus4: "sus4",
  dim: "dim",
} as const;
type GuitarCommonTemplateQuality = keyof typeof GUITAR_TEMPLATE_QUALITY_SUFFIXES;

type GuitarMoveableRoot = {
  label: string;
  offset: number;
};

const E_SHAPE_BARRE_ROOTS: readonly GuitarMoveableRoot[] = [
  { label: "F", offset: 1 },
  { label: "F#", offset: 2 },
  { label: "G", offset: 3 },
  { label: "Ab", offset: 4 },
  { label: "A", offset: 5 },
  { label: "Bb", offset: 6 },
  { label: "B", offset: 7 },
  { label: "C", offset: 8 },
] as const;

const A_SHAPE_BARRE_ROOTS: readonly GuitarMoveableRoot[] = [
  { label: "Bb", offset: 1 },
  { label: "B", offset: 2 },
  { label: "C", offset: 3 },
  { label: "C#", offset: 4 },
  { label: "D", offset: 5 },
  { label: "Eb", offset: 6 },
  { label: "E", offset: 7 },
  { label: "F", offset: 8 },
] as const;

const D_SHAPE_BARRE_ROOTS: readonly GuitarMoveableRoot[] = [
  { label: "Eb", offset: 1 },
  { label: "E", offset: 2 },
  { label: "F", offset: 3 },
  { label: "F#", offset: 4 },
  { label: "G", offset: 5 },
  { label: "Ab", offset: 6 },
  { label: "A", offset: 7 },
] as const;

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
    id: "c-over-e-open",
    label: "C/E open",
    shapeChordLabel: "C/E",
    shapeFamily: "C",
    rank: 12,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 3, finger: 3 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 0 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "c-over-g-open",
    label: "C/G open",
    shapeChordLabel: "C/G",
    shapeFamily: "C",
    rank: 12,
    notes: [
      { string: 6, fret: 3, finger: 4 },
      { string: 5, fret: 3, finger: 3 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 0 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "a-open",
    label: "A open",
    shapeChordLabel: "A",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 1 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 2, finger: 3 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "a-over-csharp-open",
    label: "A/C# open",
    shapeChordLabel: "A/C#",
    shapeFamily: "A",
    rank: 12,
    notes: [
      { string: 5, fret: 4, finger: 4 },
      { string: 4, fret: 2, finger: 1 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 2, finger: 3 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "d-open",
    label: "D open",
    shapeChordLabel: "D",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 1 },
      { string: 2, fret: 3, finger: 3 },
      { string: 1, fret: 2, finger: 2 },
    ],
  },
  {
    id: "d-over-fsharp-open",
    label: "D/F# open",
    shapeChordLabel: "D/F#",
    shapeFamily: "D",
    rank: 12,
    notes: [
      { string: 6, fret: 2, finger: 1 },
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 3, finger: 4 },
      { string: 1, fret: 2, finger: 3 },
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
    id: "g-over-b-open",
    label: "G/B open",
    shapeChordLabel: "G/B",
    shapeFamily: "G",
    rank: 12,
    notes: [
      { string: 5, fret: 2, finger: 1 },
      { string: 4, fret: 0 },
      { string: 3, fret: 0 },
      { string: 2, fret: 3, finger: 2 },
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
    id: "dm-open",
    label: "Dm open",
    shapeChordLabel: "Dm",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 3, finger: 3 },
      { string: 1, fret: 1, finger: 1 },
    ],
  },
  {
    id: "em-open",
    label: "Em open",
    shapeChordLabel: "Em",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 2, finger: 2 },
      { string: 4, fret: 2, finger: 3 },
      { string: 3, fret: 0 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "am7-open",
    label: "Am7 open",
    shapeChordLabel: "Am7",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 0 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "dm7-open",
    label: "Dm7 open",
    shapeChordLabel: "Dm7",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 1, finger: 1 },
    ],
  },
  {
    id: "em7-open",
    label: "Em7 open",
    shapeChordLabel: "Em7",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 2, finger: 2 },
      { string: 4, fret: 0 },
      { string: 3, fret: 0 },
      { string: 2, fret: 0 },
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
    id: "amaj7-open",
    label: "Amaj7 open",
    shapeChordLabel: "Amaj7",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 1, finger: 1 },
      { string: 2, fret: 2, finger: 3 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "dmaj7-open",
    label: "Dmaj7 open",
    shapeChordLabel: "Dmaj7",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 1 },
      { string: 2, fret: 2, finger: 2 },
      { string: 1, fret: 2, finger: 3 },
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
    id: "a7-open",
    label: "A7 open",
    shapeChordLabel: "A7",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 1 },
      { string: 3, fret: 0 },
      { string: 2, fret: 2, finger: 2 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "c7-open",
    label: "C7 open",
    shapeChordLabel: "C7",
    shapeFamily: "C",
    rank: 10,
    notes: [
      { string: 5, fret: 3, finger: 3 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 3, finger: 4 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "d7-open",
    label: "D7 open",
    shapeChordLabel: "D7",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 1, finger: 1 },
      { string: 1, fret: 2, finger: 3 },
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
  {
    id: "e7-open",
    label: "E7 open",
    shapeChordLabel: "E7",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 2, finger: 2 },
      { string: 4, fret: 0 },
      { string: 3, fret: 1, finger: 1 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "emaj7-open",
    label: "Emaj7 open",
    shapeChordLabel: "Emaj7",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 2, finger: 3 },
      { string: 4, fret: 1, finger: 1 },
      { string: 3, fret: 1, finger: 2 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "asus2-open",
    label: "Asus2 open",
    shapeChordLabel: "Asus2",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 1 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "asus4-open",
    label: "Asus4 open",
    shapeChordLabel: "Asus4",
    shapeFamily: "A",
    rank: 10,
    notes: [
      { string: 5, fret: 0 },
      { string: 4, fret: 2, finger: 1 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 3, finger: 3 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "dsus2-open",
    label: "Dsus2 open",
    shapeChordLabel: "Dsus2",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 2 },
      { string: 2, fret: 3, finger: 3 },
      { string: 1, fret: 0 },
    ],
  },
  {
    id: "dsus4-open",
    label: "Dsus4 open",
    shapeChordLabel: "Dsus4",
    shapeFamily: "D",
    rank: 10,
    notes: [
      { string: 4, fret: 0 },
      { string: 3, fret: 2, finger: 1 },
      { string: 2, fret: 3, finger: 2 },
      { string: 1, fret: 3, finger: 3 },
    ],
  },
  {
    id: "esus4-open",
    label: "Esus4 open",
    shapeChordLabel: "Esus4",
    shapeFamily: "E",
    rank: 10,
    notes: [
      { string: 6, fret: 0 },
      { string: 5, fret: 2, finger: 1 },
      { string: 4, fret: 2, finger: 2 },
      { string: 3, fret: 2, finger: 3 },
      { string: 2, fret: 0 },
      { string: 1, fret: 0 },
    ],
  },
  ...buildMoveableGuitarTemplates(),
] as const;

type GuitarMoveableTemplateDefinition = {
  id: string;
  label: string;
  shapeFamily: GuitarShapeFamily;
  quality: GuitarCommonTemplateQuality;
  baseFrets: readonly (number | null)[];
  rank: number;
  roots: readonly GuitarMoveableRoot[];
};

function buildMoveableGuitarTemplates(): readonly GuitarVoicingTemplate[] {
  const definitions: readonly GuitarMoveableTemplateDefinition[] = [
    {
      id: "e-shape-barre",
      label: "E-shape barre",
      shapeFamily: "E",
      quality: "major",
      baseFrets: [0, 2, 2, 1, 0, 0],
      rank: 30,
      roots: E_SHAPE_BARRE_ROOTS,
    },
    {
      id: "em-shape-barre",
      label: "Em-shape barre",
      shapeFamily: "E",
      quality: "minor",
      baseFrets: [0, 2, 2, 0, 0, 0],
      rank: 32,
      roots: E_SHAPE_BARRE_ROOTS,
    },
    {
      id: "e7-shape-barre",
      label: "E7-shape barre",
      shapeFamily: "E",
      quality: "7",
      baseFrets: [0, 2, 0, 1, 0, 0],
      rank: 34,
      roots: E_SHAPE_BARRE_ROOTS,
    },
    {
      id: "emaj7-shape-barre",
      label: "Emaj7-shape barre",
      shapeFamily: "E",
      quality: "maj7",
      baseFrets: [0, 2, 1, 1, 0, 0],
      rank: 36,
      roots: E_SHAPE_BARRE_ROOTS,
    },
    {
      id: "em7-shape-barre",
      label: "Em7-shape barre",
      shapeFamily: "E",
      quality: "m7",
      baseFrets: [0, 2, 0, 0, 0, 0],
      rank: 34,
      roots: E_SHAPE_BARRE_ROOTS,
    },
    {
      id: "esus4-shape-barre",
      label: "Esus4-shape barre",
      shapeFamily: "E",
      quality: "sus4",
      baseFrets: [0, 2, 2, 2, 0, 0],
      rank: 38,
      roots: E_SHAPE_BARRE_ROOTS,
    },
    {
      id: "a-shape-barre",
      label: "A-shape barre",
      shapeFamily: "A",
      quality: "major",
      baseFrets: [null, 0, 2, 2, 2, 0],
      rank: 31,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "am-shape-barre",
      label: "Am-shape barre",
      shapeFamily: "A",
      quality: "minor",
      baseFrets: [null, 0, 2, 2, 1, 0],
      rank: 33,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "a7-shape-barre",
      label: "A7-shape barre",
      shapeFamily: "A",
      quality: "7",
      baseFrets: [null, 0, 2, 0, 2, 0],
      rank: 35,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "amaj7-shape-barre",
      label: "Amaj7-shape barre",
      shapeFamily: "A",
      quality: "maj7",
      baseFrets: [null, 0, 2, 1, 2, 0],
      rank: 37,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "am7-shape-barre",
      label: "Am7-shape barre",
      shapeFamily: "A",
      quality: "m7",
      baseFrets: [null, 0, 2, 0, 1, 0],
      rank: 35,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "asus2-shape-barre",
      label: "Asus2-shape barre",
      shapeFamily: "A",
      quality: "sus2",
      baseFrets: [null, 0, 2, 2, 0, 0],
      rank: 38,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "asus4-shape-barre",
      label: "Asus4-shape barre",
      shapeFamily: "A",
      quality: "sus4",
      baseFrets: [null, 0, 2, 2, 3, 0],
      rank: 38,
      roots: A_SHAPE_BARRE_ROOTS,
    },
    {
      id: "d-shape-barre",
      label: "D-shape barre",
      shapeFamily: "D",
      quality: "major",
      baseFrets: [null, null, 0, 2, 3, 2],
      rank: 43,
      roots: D_SHAPE_BARRE_ROOTS,
    },
    {
      id: "dm-shape-barre",
      label: "Dm-shape barre",
      shapeFamily: "D",
      quality: "minor",
      baseFrets: [null, null, 0, 2, 3, 1],
      rank: 45,
      roots: D_SHAPE_BARRE_ROOTS,
    },
    {
      id: "d7-shape-barre",
      label: "D7-shape barre",
      shapeFamily: "D",
      quality: "7",
      baseFrets: [null, null, 0, 2, 1, 2],
      rank: 47,
      roots: D_SHAPE_BARRE_ROOTS,
    },
    {
      id: "dmaj7-shape-barre",
      label: "Dmaj7-shape barre",
      shapeFamily: "D",
      quality: "maj7",
      baseFrets: [null, null, 0, 2, 2, 2],
      rank: 47,
      roots: D_SHAPE_BARRE_ROOTS,
    },
    {
      id: "dm7-shape-barre",
      label: "Dm7-shape barre",
      shapeFamily: "D",
      quality: "m7",
      baseFrets: [null, null, 0, 2, 1, 1],
      rank: 47,
      roots: D_SHAPE_BARRE_ROOTS,
    },
    {
      id: "dsus2-shape-barre",
      label: "Dsus2-shape barre",
      shapeFamily: "D",
      quality: "sus2",
      baseFrets: [null, null, 0, 2, 3, 0],
      rank: 49,
      roots: D_SHAPE_BARRE_ROOTS,
    },
    {
      id: "dsus4-shape-barre",
      label: "Dsus4-shape barre",
      shapeFamily: "D",
      quality: "sus4",
      baseFrets: [null, null, 0, 2, 3, 3],
      rank: 49,
      roots: D_SHAPE_BARRE_ROOTS,
    },
  ];

  return definitions.flatMap((definition) =>
    definition.roots.map((root) => {
      const shapeChordLabel = formatGuitarTemplateChordLabel(root.label, definition.quality);
      return {
        id: `${formatGuitarTemplateId(shapeChordLabel)}-${definition.id}`,
        label: `${shapeChordLabel} ${definition.label}`,
        shapeChordLabel,
        shapeFamily: definition.shapeFamily,
        rank: definition.rank + root.offset,
        notes: definition.baseFrets.flatMap((fret, index) =>
          typeof fret === "number" && typeof GUITAR_TEMPLATE_STRINGS[index] === "number"
            ? [
                {
                  string: GUITAR_TEMPLATE_STRINGS[index],
                  fret: fret + root.offset,
                },
              ]
            : [],
        ),
      };
    }),
  );
}

function formatGuitarTemplateChordLabel(rootLabel: string, quality: GuitarCommonTemplateQuality): string {
  return `${rootLabel}${GUITAR_TEMPLATE_QUALITY_SUFFIXES[quality]}`;
}

function formatGuitarTemplateId(label: string): string {
  return label.toLowerCase().replaceAll("#", "sharp").replaceAll("/", "-");
}

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

const DIATONIC_LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
type DiatonicLetter = (typeof DIATONIC_LETTERS)[number];
const NATURAL_PITCH_CLASSES: Record<DiatonicLetter, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};
const CHORD_DEGREE_LETTER_OFFSETS: Record<ChordDegree, number> = {
  "1": 0,
  "#1": 0,
  b2: 1,
  "2": 1,
  "#2": 1,
  b3: 2,
  "3": 2,
  "4": 3,
  "#4": 3,
  b5: 4,
  "5": 4,
  "#5": 4,
  b6: 5,
  "6": 5,
  "#6": 5,
  bb7: 6,
  b7: 6,
  "7": 6,
};

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

  const normalized = label.trim();
  const compactLabel = normalized.replace(/\s+/g, "");
  const compactUpper = compactLabel.toUpperCase();
  if (!compactLabel || NO_CHORD_LABELS.has(compactUpper) || UNKNOWN_CHORD_LABELS.has(compactUpper)) {
    return null;
  }

  const harteMatch = compactLabel.match(HARTE_CHORD_PATTERN);
  if (harteMatch) {
    const parsedChord = parseChordParts(harteMatch[1], harteMatch[2] ?? "", harteMatch[3]);
    if (parsedChord) {
      return withRawChordLabelWhenNeeded(label, parsedChord, compactLabel.includes(":"));
    }
  }

  const leadSheetMatch = compactLabel.match(LEAD_SHEET_CHORD_PATTERN);
  if (!leadSheetMatch) {
    return null;
  }

  const parsedChord = parseChordParts(leadSheetMatch[1], leadSheetMatch[2] ?? "", leadSheetMatch[3]);
  return parsedChord ? withRawChordLabelWhenNeeded(label, parsedChord, false) : null;
}

function parseChordParts(rootRaw: string, qualityRaw: string, bassRaw: string | undefined): ParsedChord | null {
  const root = normalizeNoteName(rootRaw);
  const rootPitchClass = ENHARMONIC_ALIASES[root];
  const quality = parseChordQualitySuffix(qualityRaw);
  if (rootPitchClass === undefined || !quality) {
    return null;
  }

  const bass = parseChordBass(bassRaw, root, rootPitchClass, quality);
  if (!bass) {
    return null;
  }

  return {
    root,
    rootPitchClass,
    quality,
    bass: bass.label,
    bassPitchClass: bass.pitchClass,
    ...(bass.degree ? { bassDegree: bass.degree } : {}),
  };
}

export function isChordSpellingQuality(quality: string | null | undefined): quality is ChordSpellingQuality {
  return isSupportedChordQuality(quality);
}

export function formatParsedChordLabel(chord: ParsedChord, options: PitchFormatOptions = {}): string {
  const resolvedOptions = resolveChordFormatOptions(chord, options);
  if (chord.bass && typeof chord.bassPitchClass === "number" && chord.bassPitchClass !== chord.rootPitchClass) {
    const rootLabel = formatChordLabel(chord.rootPitchClass, chord.quality, resolvedOptions);
    const bassLabel =
      hasExplicitPitchFormatOptions(options) || !isBassLabelForPitchClass(chord.bass, chord.bassPitchClass)
        ? formatPitchClass(chord.bassPitchClass, resolvedOptions)
        : chord.bass;
    return `${rootLabel}/${bassLabel}`;
  }

  return formatChordLabel(
    chord.rootPitchClass,
    chord.quality,
    resolvedOptions,
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
  if (!definition) {
    return null;
  }
  const tones = definition.tones.map((tone) => {
    const pitchClass = transposePitchClass(parsedChord.rootPitchClass, tone.interval);
    return {
      ...tone,
      pitchClass,
      noteName: spellChordTone(parsedChord.root, parsedChord.rootPitchClass, tone.degree, pitchClass, chordOptions),
    };
  });

  const bassNoteName =
    typeof parsedChord.bassPitchClass === "number"
      ? parsedChord.bass && !options.activeKey && !options.mode
        ? parsedChord.bass
        : formatPitchClass(parsedChord.bassPitchClass, chordOptions)
      : null;

  return {
    ...parsedChord,
    label: formatParsedChordLabel(parsedChord, options),
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

const GUITAR_GENERATED_MAX_SHAPE_FRET = 12;
const GUITAR_GENERATED_MAX_VOICINGS = 8;
const GUITAR_GENERATED_MAX_FRET_SPAN = 4;
const GUITAR_GENERATED_MAX_DISTINCT_FRETS = 4;
const GUITAR_GENERATED_MAX_OPEN_POSITION_FRET = 5;

type GuitarGeneratedCandidate = {
  notes: readonly GuitarVoicingNote[];
  mutedStrings: readonly number[];
  score: number;
  shapeKey: string;
};

type GuitarGeneratedFretStats = {
  hasOpenString: boolean;
  minFret: number;
  maxFret: number;
  span: number;
  distinctFretCount: number;
};

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

  const generatedVoicings = generateFallbackGuitarVoicings(
    soundingSpelling,
    shapeLabel,
    profile,
    resolvedContext,
    chordOptions,
  );
  return [...commonVoicings, ...generatedVoicings].sort((left, right) => {
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
  const compactSuffix = suffix.trim().replace(/\s+/g, "");
  if (compactSuffix === "M7") {
    return "maj7";
  }
  return CHORD_QUALITY_ALIASES[compactSuffix.toLowerCase()] ?? null;
}

function parseChordBass(
  bassRaw: string | undefined,
  root: string,
  rootPitchClass: number,
  quality: ChordSpellingQuality,
): { label: string | null; pitchClass: number | null; degree?: ChordDegree } | null {
  if (!bassRaw) {
    return { label: null, pitchClass: null };
  }

  const compactBass = bassRaw.trim().replace(/\s+/g, "");
  if (!compactBass) {
    return { label: null, pitchClass: null };
  }

  const note = normalizeNoteName(compactBass);
  const notePitchClass = ENHARMONIC_ALIASES[note];
  if (notePitchClass !== undefined) {
    return { label: note, pitchClass: notePitchClass };
  }

  const degree = compactBass.toLowerCase();
  if (!isChordDegree(degree)) {
    return null;
  }
  const interval = CHORD_DEGREE_INTERVALS[degree];
  const pitchClass = transposePitchClass(rootPitchClass, interval);
  return {
    label: spellPitchClassForDegree(root, rootPitchClass, degree, pitchClass, resolveChordFormatOptions({ quality, rootPitchClass })),
    pitchClass,
    degree,
  };
}

function withRawChordLabelWhenNeeded(rawLabel: string, chord: ParsedChord, isHarteStyle: boolean): ParsedChord {
  if (!shouldStoreRawChordLabel(rawLabel, chord, isHarteStyle)) {
    return chord;
  }
  return {
    rawLabel,
    ...chord,
  };
}

function shouldStoreRawChordLabel(rawLabel: string, chord: ParsedChord, isHarteStyle: boolean): boolean {
  if (isHarteStyle || chord.bassDegree || isNewChordQuality(chord.quality)) {
    return true;
  }
  return rawLabel.trim().replace(/\s+/g, "") !== formatParsedChordLabel(chord);
}

function isNewChordQuality(quality: ChordSpellingQuality): boolean {
  return quality === "sus2" || quality === "sus4" || quality === "aug" || quality === "dim7" || quality === "hdim7";
}

function parseChordInput(chord: ChordInput): ParsedChord | null {
  if (typeof chord === "string") {
    return parseChordLabel(chord);
  }
  if (!isChordSpellingQuality(chord.quality)) {
    return null;
  }
  return {
    ...(chord.rawLabel ? { rawLabel: chord.rawLabel } : {}),
    root: chord.root,
    rootPitchClass: normalizePitchClass(chord.rootPitchClass),
    quality: chord.quality,
    bass: chord.bass,
    bassPitchClass: typeof chord.bassPitchClass === "number" ? normalizePitchClass(chord.bassPitchClass) : null,
    ...(chord.bassDegree ? { bassDegree: chord.bassDegree } : {}),
  };
}

function transposeParsedChord(chord: ParsedChord, semitones: number): ParsedChord {
  const rootPitchClass = transposePitchClass(chord.rootPitchClass, semitones);
  const chordOptions = resolveChordFormatOptions({ ...chord, rootPitchClass });
  const bassPitchClass =
    typeof chord.bassPitchClass === "number"
      ? chord.bassDegree
        ? transposePitchClass(rootPitchClass, CHORD_DEGREE_INTERVALS[chord.bassDegree])
        : transposePitchClass(chord.bassPitchClass, semitones)
      : null;
  const root = formatPitchClass(rootPitchClass, chordOptions);
  return {
    ...(chord.rawLabel ? { rawLabel: chord.rawLabel } : {}),
    root,
    rootPitchClass,
    quality: chord.quality,
    bass:
      typeof bassPitchClass === "number"
        ? chord.bassDegree
          ? spellPitchClassForDegree(root, rootPitchClass, chord.bassDegree, bassPitchClass, chordOptions)
          : formatPitchClass(bassPitchClass, chordOptions)
        : null,
    bassPitchClass,
    ...(chord.bassDegree ? { bassDegree: chord.bassDegree } : {}),
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
      mode: isMinorSpelledChordQuality(chord.quality) ? "minor" : "major",
    } satisfies MusicalKey,
  };
}

function isMinorSpelledChordQuality(quality: ChordSpellingQuality): boolean {
  return quality === "minor" || quality === "m7" || quality === "dim" || quality === "dim7" || quality === "hdim7";
}

function isChordDegree(value: string): value is ChordDegree {
  return Object.prototype.hasOwnProperty.call(CHORD_DEGREE_INTERVALS, value);
}

function hasExplicitPitchFormatOptions(options: PitchFormatOptions): boolean {
  return Boolean(options.activeKey || options.mode);
}

function isBassLabelForPitchClass(label: string, pitchClass: number): boolean {
  const labelPitchClass = ENHARMONIC_ALIASES[normalizeNoteName(label)];
  return labelPitchClass !== undefined && labelPitchClass === normalizePitchClass(pitchClass);
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

  const capoFret = context.useCapoShapes && context.canCapo ? context.capoFret : 0;

  return {
    id: `${template.id}${capoFret > 0 ? `-capo-${capoFret}` : ""}`,
    label: template.label,
    chordLabel: chord.label,
    shapeChordLabel,
    shapeFamily: template.shapeFamily,
    source: "common",
    rank: template.rank,
    capoFret,
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

function generateFallbackGuitarVoicings(
  chord: ChordSpelling,
  shapeChordLabel: string,
  profile: GuitarProfile,
  context: ChordDisplayContext,
  options: PitchFormatOptions,
): readonly GuitarVoicing[] {
  const capoFret = context.useCapoShapes && context.canCapo ? context.capoFret : 0;
  const maxShapeFret = Math.min(GUITAR_GENERATED_MAX_SHAPE_FRET, profile.frets - capoFret);
  if (maxShapeFret < 0) {
    return [];
  }

  const playableFretsByString = profile.tuning.map((stringTuning) =>
    findPlayableChordFrets(stringTuning, chord, capoFret, maxShapeFret, options),
  );
  const minPlayedStrings = Math.max(3, getRequiredGuitarPitchClassCount(chord));
  const candidates = new Map<string, GuitarGeneratedCandidate>();

  for (let startIndex = 0; startIndex < playableFretsByString.length; startIndex += 1) {
    for (let endIndex = startIndex + minPlayedStrings - 1; endIndex < playableFretsByString.length; endIndex += 1) {
      const stringOptions = playableFretsByString.slice(startIndex, endIndex + 1);
      if (stringOptions.some((optionsForString) => optionsForString.length === 0)) {
        continue;
      }
      collectGeneratedGuitarCandidates(stringOptions, 0, [], (notes) => {
        addGeneratedGuitarCandidate(chord, profile, notes, candidates);
      });
    }
  }

  return [...candidates.values()]
    .sort(compareGeneratedGuitarCandidates)
    .slice(0, GUITAR_GENERATED_MAX_VOICINGS)
    .map((candidate, index) => ({
      id: formatGeneratedGuitarVoicingId(chord.label, index),
      label: index === 0 ? `${chord.label} generated` : `${chord.label} generated ${index + 1}`,
      chordLabel: chord.label,
      shapeChordLabel,
      source: "generated",
      rank: 1000 + index,
      capoFret,
      mutedStrings: candidate.mutedStrings,
      notes: candidate.notes,
    }));
}

function findPlayableChordFrets(
  tuning: GuitarStringTuning,
  chord: ChordSpelling,
  capoFret: number,
  maxShapeFret: number,
  options: PitchFormatOptions,
): readonly GuitarVoicingNote[] {
  const matches: GuitarVoicingNote[] = [];
  for (let fret = 0; fret <= maxShapeFret; fret += 1) {
    const soundingFret = capoFret + fret;
    const pitch = midiToPitch(tuning.openPitch.midi + soundingFret, options);
    if (!pitch) {
      continue;
    }
    const degree = getChordDegreeForPitchClass(chord, pitch.pitchClass);
    if (degree) {
      matches.push({
        string: tuning.string,
        fret,
        soundingFret,
        degree,
        note: pitch.label,
        pitch,
      });
    }
  }
  return matches;
}

function collectGeneratedGuitarCandidates(
  stringOptions: readonly (readonly GuitarVoicingNote[])[],
  index: number,
  selectedNotes: GuitarVoicingNote[],
  onCandidate: (notes: readonly GuitarVoicingNote[]) => void,
): void {
  if (index >= stringOptions.length) {
    onCandidate([...selectedNotes]);
    return;
  }

  for (const note of stringOptions[index]) {
    selectedNotes.push(note);
    collectGeneratedGuitarCandidates(stringOptions, index + 1, selectedNotes, onCandidate);
    selectedNotes.pop();
  }
}

function addGeneratedGuitarCandidate(
  chord: ChordSpelling,
  profile: GuitarProfile,
  notes: readonly GuitarVoicingNote[],
  candidates: Map<string, GuitarGeneratedCandidate>,
): void {
  if (
    notes.length < Math.max(3, getRequiredGuitarPitchClassCount(chord)) ||
    !isAscendingSoundingGuitarOrder(notes) ||
    !hasRequiredChordDegrees(chord, notes) ||
    !hasRequiredBass(chord, notes) ||
    !isPlayableGeneratedGuitarVoicing(notes)
  ) {
    return;
  }

  const mutedStrings = getMutedStrings(profile, notes);
  const score = scoreGeneratedGuitarCandidate(chord, notes, mutedStrings);
  const shapeKey = getGeneratedGuitarShapeKey(notes);
  const existing = candidates.get(shapeKey);
  if (!existing || score < existing.score) {
    candidates.set(shapeKey, {
      notes: [...notes],
      mutedStrings,
      score,
      shapeKey,
    });
  }
}

function isAscendingSoundingGuitarOrder(notes: readonly GuitarVoicingNote[]): boolean {
  for (let index = 1; index < notes.length; index += 1) {
    if (notes[index].pitch.midi < notes[index - 1].pitch.midi) {
      return false;
    }
  }
  return true;
}

function isPlayableGeneratedGuitarVoicing(notes: readonly GuitarVoicingNote[]): boolean {
  const stats = getGeneratedGuitarFretStats(notes);
  if (stats.span > GUITAR_GENERATED_MAX_FRET_SPAN) {
    return false;
  }
  if (stats.distinctFretCount > GUITAR_GENERATED_MAX_DISTINCT_FRETS) {
    return false;
  }
  return !stats.hasOpenString || stats.maxFret <= GUITAR_GENERATED_MAX_OPEN_POSITION_FRET;
}

function scoreGeneratedGuitarCandidate(
  chord: ChordSpelling,
  notes: readonly GuitarVoicingNote[],
  mutedStrings: readonly number[],
): number {
  const stats = getGeneratedGuitarFretStats(notes);
  const lowestNote = getLowestGuitarNote(notes);
  const explicitBass = typeof chord.bassPitchClass === "number";
  const bassPenalty = explicitBass || lowestNote.pitch.pitchClass === chord.rootPitchClass ? 0 : 500;
  const lowerStringBonus = notes[0]?.string >= 5 ? -8 : notes[0]?.string === 4 ? 0 : 8;
  const openPositionBonus = stats.hasOpenString && stats.maxFret <= 4 ? -18 : 0;
  const compactBarreBonus = !stats.hasOpenString && stats.minFret >= 1 && stats.minFret <= 5 ? -8 : 0;

  return (
    1000 +
    bassPenalty +
    mutedStrings.length * 12 +
    stats.span * 20 +
    stats.distinctFretCount * 8 +
    stats.minFret * 2 +
    stats.maxFret * 4 +
    lowerStringBonus +
    openPositionBonus +
    compactBarreBonus
  );
}

function compareGeneratedGuitarCandidates(
  left: GuitarGeneratedCandidate,
  right: GuitarGeneratedCandidate,
): number {
  return (
    left.score - right.score ||
    left.mutedStrings.length - right.mutedStrings.length ||
    left.shapeKey.localeCompare(right.shapeKey)
  );
}

function getGeneratedGuitarFretStats(notes: readonly GuitarVoicingNote[]): GuitarGeneratedFretStats {
  const frettedNotes = notes.filter((note) => note.fret > 0);
  const frets = frettedNotes.map((note) => note.fret);
  const minFret = frets.length > 0 ? Math.min(...frets) : 0;
  const maxFret = frets.length > 0 ? Math.max(...frets) : 0;
  return {
    hasOpenString: notes.some((note) => note.fret === 0),
    minFret,
    maxFret,
    span: maxFret - minFret,
    distinctFretCount: new Set(frets).size,
  };
}

function getRequiredGuitarPitchClassCount(chord: ChordSpelling): number {
  const requiredPitchClasses = new Set(chord.tones.map((tone) => tone.pitchClass));
  if (typeof chord.bassPitchClass === "number") {
    requiredPitchClasses.add(chord.bassPitchClass);
  }
  return requiredPitchClasses.size;
}

function getLowestGuitarNote(notes: readonly GuitarVoicingNote[]): GuitarVoicingNote {
  return notes.reduce((lowestNote, note) => (note.pitch.midi < lowestNote.pitch.midi ? note : lowestNote), notes[0]);
}

function getGeneratedGuitarShapeKey(notes: readonly GuitarVoicingNote[]): string {
  return notes.map((note) => `${note.string}:${note.fret}`).join("|");
}

function formatGeneratedGuitarVoicingId(chordLabel: string, index: number): string {
  const baseId = chordLabel.toLowerCase().replaceAll("#", "sharp").replaceAll("/", "-").replace(/\s+/g, "-");
  return index === 0 ? `${baseId}-generated` : `${baseId}-generated-${index + 1}`;
}

function getChordDegreeForPitchClass(chord: ChordSpelling, pitchClass: number): ChordDegree | null {
  const normalizedPitchClass = normalizePitchClass(pitchClass);
  const chordToneDegree = chord.tones.find((tone) => tone.pitchClass === normalizedPitchClass)?.degree;
  if (chordToneDegree) {
    return chordToneDegree;
  }
  if (typeof chord.bassPitchClass === "number" && normalizePitchClass(chord.bassPitchClass) === normalizedPitchClass) {
    return chord.bassDegree ?? getChromaticDegreeForPitchClass(chord.rootPitchClass, normalizedPitchClass);
  }
  return null;
}

function getChromaticDegreeForPitchClass(rootPitchClass: number, pitchClass: number): ChordDegree {
  switch (normalizePitchClass(pitchClass - rootPitchClass)) {
    case 1:
      return "b2";
    case 2:
      return "2";
    case 3:
      return "b3";
    case 4:
      return "3";
    case 5:
      return "4";
    case 6:
      return "b5";
    case 7:
      return "5";
    case 8:
      return "#5";
    case 9:
      return "6";
    case 10:
      return "b7";
    case 11:
      return "7";
    default:
      return "1";
  }
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

function spellChordTone(
  root: string,
  rootPitchClass: number,
  degree: ChordDegree,
  pitchClass: number,
  options: PitchFormatOptions,
): string {
  if (options.mode === "dual") {
    return formatPitchClass(pitchClass, options);
  }
  return spellPitchClassForDegree(root, rootPitchClass, degree, pitchClass, options);
}

function spellPitchClassForDegree(
  root: string,
  rootPitchClass: number,
  degree: ChordDegree,
  pitchClass: number,
  options: PitchFormatOptions = {},
): string {
  const rootLetter = normalizeNoteName(root)[0] as DiatonicLetter | undefined;
  const rootLetterIndex = rootLetter ? DIATONIC_LETTERS.indexOf(rootLetter) : -1;
  if (rootLetterIndex < 0) {
    return formatPitchClass(pitchClass, options);
  }

  const targetLetter = DIATONIC_LETTERS[(rootLetterIndex + CHORD_DEGREE_LETTER_OFFSETS[degree]) % DIATONIC_LETTERS.length];
  const naturalPitchClass = NATURAL_PITCH_CLASSES[targetLetter];
  let accidentalOffset = normalizePitchClass(pitchClass - naturalPitchClass);
  if (accidentalOffset > 6) {
    accidentalOffset -= 12;
  }

  if (accidentalOffset < -2 || accidentalOffset > 2) {
    return formatPitchClass(pitchClass, options);
  }

  return `${targetLetter}${formatAccidentalOffset(accidentalOffset)}`;
}

function formatAccidentalOffset(offset: number): string {
  switch (offset) {
    case -2:
      return "bb";
    case -1:
      return "b";
    case 1:
      return "#";
    case 2:
      return "##";
    default:
      return "";
  }
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
