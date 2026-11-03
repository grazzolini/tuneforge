import { callMusicCore } from "./musicCore";
import type * as Core from "@tuneforge/music-core/contracts";
import type { ButtonBoardStradellaProfileV1, ButtonBoardStradellaRowIdV1, KeyboardFingerV1, KeyboardHandV1 } from "./instrumentKnowledge";

export type KeyMode = "major" | "minor";

export type ChordQuality = Core.Quality;

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

export type ChordDegree = Core.Degree;

export type ChordToneDefinition = {
  degree: ChordDegree;
  interval: number;
};

export type ChordQualityDefinition = {
  dictionarySupported: boolean;
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

export type PianoProfile = {
  id: "piano";
  label: string;
  family: string;
  keyboard: {
    keyCount: number;
    lowestPitch: ParsedPitch;
    highestPitch: ParsedPitch;
    canTranspose: boolean;
  };
};

export type PianoHandHint = KeyboardHandV1;

export type PianoVoicingNote = {
  id: string;
  pitch: ParsedPitch;
  note: string;
  degree: ChordDegree;
  handHint: PianoHandHint;
};

export type PianoRegionRoot = Core.RegionRoot;

export type PianoVoicingInversion = {
  index: number;
  label: string;
  bassDegree: ChordDegree;
  isRootPosition: boolean;
};

export type PianoVoicing = {
  id: string;
  label: string;
  chordLabel: string;
  rank: number;
  notes: readonly PianoVoicingNote[];
  inversion: PianoVoicingInversion;
  regionRoot: PianoRegionRoot;
};

export type PianoVoicingContext =
  | MusicalKey
  | {
      activeKey?: MusicalKey | null;
      preferredTrebleRegion?: { centerMidi: number } | null;
      currentChordRoot?: ChordInput | number | null;
    };

export type AccordionStradellaRowId = ButtonBoardStradellaRowIdV1;

export type AccordionLeftHandKind = "standard" | "complete" | "approx";

export type AccordionLeftHandFinger = 2 | 3 | 4;

export type AccordionProfile = {
  id: "accordion";
  label: string;
  family: string;
  keyboard: {
    keyCount: number;
    lowestPitch: ParsedPitch;
    highestPitch: ParsedPitch;
    canTranspose: boolean;
  };
  buttonBoard: {
    layout: string;
    buttons: number;
    rows: number;
    columns: number;
    canTranspose: boolean;
    stradella: ButtonBoardStradellaProfileV1;
  };
};

export type AccordionStradellaButton = {
  id: string;
  side: "bass";
  rowId: AccordionStradellaRowId;
  rowLabel: string;
  kind: "bass" | "chord";
  label: string;
  root: string;
  pitchClass: number;
  pitchClasses: readonly number[];
  column: number;
  row: number;
  visualColumn: number;
  visualOrder: number;
  visualColumnOffset: number;
  visualYOffset: number;
  visualYStep: number;
  visualX: number;
  visualY: number;
};

export type AccordionLeftHandCandidate = Core.LeftHandCandidate;

export type AccordionKeyboardNote = {
  id: string;
  pitch: ParsedPitch;
  note: string;
  degree: ChordDegree;
  hand: "right";
  side: "treble";
  finger?: KeyboardFingerV1;
};

export type AccordionRegionRoot = {
  pitchClass: number;
  note: string;
};

export type AccordionVoicing = Core.AccordionVoicing;

export type AccordionVoicingContext =
  | MusicalKey
  | {
      activeKey?: MusicalKey | null;
      preferredTrebleRegion?: { centerMidi: number } | null;
      currentChordRoot?: ChordInput | number | null;
    };

const constants = callMusicCore({ operation: "constants" });
const profiles = callMusicCore({ operation: "profiles" });
export const CHORD_QUALITY_DEFINITIONS = constants.CHORD_QUALITY_DEFINITIONS as Record<ChordSpellingQuality, ChordQualityDefinition>;
export const DEFAULT_CHORD_DISPLAY_CONTEXT: ChordDisplayContext = constants.DEFAULT_CHORD_DISPLAY_CONTEXT;
export const DEFAULT_KEY: MusicalKey = constants.DEFAULT_KEY;
export const MUSICAL_KEYS = constants.MUSICAL_KEYS;
export const GUITAR_STANDARD_PROFILE = profiles.guitar as GuitarProfile;
export const PIANO_STANDARD_PROFILE = profiles.piano as PianoProfile;
export const ACCORDION_STANDARD_PROFILE = profiles.accordion as AccordionProfile;
export const INSTRUMENT_PROFILES = { guitar: GUITAR_STANDARD_PROFILE, piano: PIANO_STANDARD_PROFILE, accordion: ACCORDION_STANDARD_PROFILE } as const;
export const GUITAR_COMMON_VOICING_TEMPLATES: readonly GuitarVoicingTemplate[] = callMusicCore({ operation: "seeds" });

export function parseKey(value: string | null | undefined): MusicalKey | null {
  return callMusicCore({ operation: "parseKey", input: value });
}

export function parseStoredKey(value: string | null | undefined): MusicalKey | null {
  return callMusicCore({ operation: "parseStoredKey", input: value });
}

export function serializeKey(key: MusicalKey): string {
  return callMusicCore({ operation: "serializeKey", input: key });
}

export function deserializeKey(value: string): MusicalKey {
  return callMusicCore({ operation: "deserializeKey", input: value });
}

export function getEnharmonicContext(
  activeKey: MusicalKey | null | undefined,
  mode: EnharmonicDisplayMode = "auto",
): EnharmonicContext {
  return callMusicCore({ operation: "getEnharmonicContext", input: activeKey, mode });
}

export function formatKey(
  key: MusicalKey,
  format: "short" | "long" = "short",
  options: PitchFormatOptions = {},
): string {
  return callMusicCore({ operation: "formatKey", input: key, format, options });
}

export function formatKeyDisplay(
  key: MusicalKey,
  options: PitchFormatOptions = {},
): FormattedMusicalLabel {
  return callMusicCore({ operation: "formatKeyDisplay", input: key, options });
}

export function formatPitchClass(pitchClass: number, options: PitchFormatOptions = {}): string {
  return callMusicCore({ operation: "formatPitchClass", input: pitchClass, options });
}

export function formatAlternatePitchClass(pitchClass: number, options: PitchFormatOptions = {}): string | null {
  return callMusicCore({ operation: "formatAlternatePitchClass", input: pitchClass, options });
}

export function formatChordRoot(pitchClass: number, options: PitchFormatOptions = {}): string {
  return callMusicCore({ operation: "formatChordRoot", input: pitchClass, options });
}

export function formatChordLabel(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
  bassPitchClass?: number | null,
): string {
  return callMusicCore({ operation: "formatChordLabel", input: pitchClass, quality, options, bassPitchClass });
}

export function formatChordDisplay(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
  bassPitchClass?: number | null,
): FormattedMusicalLabel {
  return callMusicCore({ operation: "formatChordDisplay", input: pitchClass, quality, options, bassPitchClass });
}

export function formatAlternateKey(
  key: MusicalKey,
  format: "short" | "long" = "short",
  options: PitchFormatOptions = {},
): string | null {
  return callMusicCore({ operation: "formatAlternateKey", input: key, format, options });
}

export function formatAlternateChordLabel(
  pitchClass: number,
  quality: ChordQuality,
  options: PitchFormatOptions = {},
  bassPitchClass?: number | null,
): string | null {
  return callMusicCore({ operation: "formatAlternateChordLabel", input: pitchClass, quality, options, bassPitchClass });
}

export function isSupportedChordQuality(quality: string | null | undefined): quality is ChordQuality {
  return callMusicCore({ operation: "isSupportedChordQuality", input: quality });
}

export function formatRawMusicalLabel(label: string): FormattedMusicalLabel {
  return callMusicCore({ operation: "formatRawMusicalLabel", input: label });
}

export function transposePitchClass(pitchClass: number, semitones: number): number {
  return callMusicCore({ operation: "transposePitchClass", input: pitchClass, semitones });
}

export function transposeKey(key: MusicalKey, semitones: number): MusicalKey {
  return callMusicCore({ operation: "transposeKey", input: key, semitones });
}

export function semitoneDelta(source: MusicalKey, target: MusicalKey): number {
  return callMusicCore({ operation: "semitoneDelta", input: source, target });
}

export function parsePitch(value: string | null | undefined): ParsedPitch | null {
  return callMusicCore({ operation: "parsePitch", input: value });
}

export function formatPitch(pitch: PitchLike, options: PitchFormatOptions = {}): string {
  return callMusicCore({ operation: "formatPitch", input: pitch, options });
}

export function pitchToMidi(pitch: PitchLike): number {
  return callMusicCore({ operation: "pitchToMidi", input: pitch });
}

export function midiToPitch(midi: number, options: PitchFormatOptions = {}): ParsedPitch | null {
  return callMusicCore({ operation: "midiToPitch", input: midi, options });
}

export function parseChordLabel(label: string | null | undefined): ParsedChord | null {
  return callMusicCore({ operation: "parseChordLabel", input: label });
}

export function isChordSpellingQuality(quality: string | null | undefined): quality is ChordSpellingQuality {
  return callMusicCore({ operation: "isChordSpellingQuality", input: quality });
}

export function formatParsedChordLabel(chord: ParsedChord, options: PitchFormatOptions = {}): string {
  return callMusicCore({ operation: "formatParsedChordLabel", input: chord, options });
}

export function spellChord(chord: ChordInput, options: PitchFormatOptions = {}): ChordSpelling | null {
  return callMusicCore({ operation: "spell", input: chord, options });
}

export function transposeChord(chord: ChordInput, semitones: number): ParsedChord | null {
  return callMusicCore({ operation: "transposeChord", input: chord, semitones });
}

export function transposeChordLabel(
  chord: ChordInput,
  semitones: number,
  options: PitchFormatOptions = {},
): string | null {
  return callMusicCore({ operation: "transposeChordLabel", input: chord, semitones, options });
}

export function resolveChordDisplayContext(
  context: Partial<ChordDisplayContext> = {},
  profile: Pick<GuitarProfile, "canCapo"> = GUITAR_STANDARD_PROFILE,
): ChordDisplayContext {
  return callMusicCore({ operation: "resolveChordDisplayContext", context, profile });
}

export function getCapoShapeSemitones(
  context: Partial<ChordDisplayContext> = {},
  profile: Pick<GuitarProfile, "canCapo"> = GUITAR_STANDARD_PROFILE,
): number {
  return callMusicCore({ operation: "getCapoShapeSemitones", context, profile });
}

export function getCapoShapeChord(
  chord: ChordInput,
  context: Partial<ChordDisplayContext> = {},
  profile: Pick<GuitarProfile, "canCapo"> = GUITAR_STANDARD_PROFILE,
): ParsedChord | null {
  return callMusicCore({ operation: "getCapoShapeChord", input: chord, context, profile });
}

export function generateGuitarVoicings(
  chord: ChordInput,
  profile: GuitarProfile = GUITAR_STANDARD_PROFILE,
  context: Partial<ChordDisplayContext> = {},
  options: PitchFormatOptions = {},
): readonly GuitarVoicing[] {
  return callMusicCore({ operation: "guitar", input: chord, profile, context, options });
}

export function generatePianoVoicings(
  chord: ChordInput,
  context: PianoVoicingContext | null = null,
  options: PitchFormatOptions = {},
): readonly PianoVoicing[] {
  return callMusicCore({ operation: "piano", input: chord, context, options });
}

export function generateAccordionVoicings(
  chord: ChordInput,
  context: AccordionVoicingContext | null = null,
  options: PitchFormatOptions = {},
): readonly AccordionVoicing[] {
  return callMusicCore({ operation: "accordion", input: chord, context, options });
}
