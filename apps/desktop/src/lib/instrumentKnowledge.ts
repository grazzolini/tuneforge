import { callMusicCore } from "./musicCore";

export type InstrumentKnowledgeBundleSchemaVersion = 1;

export type HarmonicDegree =
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

export type HarmonicToneDefinitionV1 = {
  degree: HarmonicDegree;
  interval: number;
};

export type HarmonicDefinitionV1 = {
  id: string;
  label: string;
  suffix: string;
  aliases: readonly string[];
  tones: readonly HarmonicToneDefinitionV1[];
};

export type InstrumentExecutionLayerV1 = "fretboard" | "keyboard" | "button-board" | (string & {});

export type InstrumentTuningStringV1 = {
  string: number;
  openPitch: string;
};

export type FretboardProfileV1 = {
  frets: number;
  stringOrder: readonly number[];
  canCapo: boolean;
  canRetune: boolean;
};

export type KeyboardProfileV1 = {
  keyCount: number;
  lowestPitch: string;
  highestPitch: string;
  canTranspose: boolean;
};

export type ButtonBoardStradellaRowIdV1 = "counterbass" | "bass" | "major" | "minor" | "seventh" | "diminished";

export type ButtonBoardStradellaRowKindV1 = "bass" | "chord";

export type ButtonBoardStradellaRootAxisEntryV1 = {
  root: string;
  pitchClass: number;
  column: number;
  visualColumn: number;
  visualOrder: number;
};

export type ButtonBoardStradellaRowDefinitionV1 = {
  id: ButtonBoardStradellaRowIdV1;
  label: string;
  kind: ButtonBoardStradellaRowKindV1;
  visualOrder: number;
  visualColumnOffset: number;
  visualYOffset: number;
  visualYStep: number;
};

export type ButtonBoardStradellaProfileV1 = {
  rootAxis: readonly ButtonBoardStradellaRootAxisEntryV1[];
  rows: readonly ButtonBoardStradellaRowDefinitionV1[];
};

export type ButtonBoardProfileV1 = {
  layout: string;
  buttons: number;
  rows?: number;
  columns?: number;
  canTranspose: boolean;
  stradella?: ButtonBoardStradellaProfileV1;
};

export type InstrumentProfileV1 = {
  id: string;
  label: string;
  family: string;
  executionLayer: InstrumentExecutionLayerV1;
  tuning?: readonly InstrumentTuningStringV1[];
  fretboard?: FretboardProfileV1;
  keyboard?: KeyboardProfileV1;
  buttonBoard?: ButtonBoardProfileV1;
};

export type GuitarShapeFamilyV1 = "C" | "A" | "G" | "E" | "D";

export type GuitarFingerV1 = 1 | 2 | 3 | 4;

export type KeyboardFingerV1 = 1 | 2 | 3 | 4 | 5;

export type KeyboardHandV1 = "left" | "right";

export type VoicingSeedBaseV1 = {
  id: string;
  instrumentId: string;
  label: string;
  chordLabel: string;
  rank: number;
  tags?: readonly string[];
};

export type GuitarVoicingSeedNoteV1 = {
  string: number;
  fret: number;
  finger?: GuitarFingerV1;
};

export type GuitarVoicingSeedSourceV1 = "first-party" | "observed-gzip";

export type GuitarVoicingSeedV1 = VoicingSeedBaseV1 & {
  shapeFamily?: GuitarShapeFamilyV1;
  source: GuitarVoicingSeedSourceV1;
  notes: readonly GuitarVoicingSeedNoteV1[];
};

export type KeyboardVoicingSeedPositionV1 = {
  pitch: string;
  note?: string;
  hand?: KeyboardHandV1;
  finger?: KeyboardFingerV1;
};

export type KeyboardVoicingSeedV1 = VoicingSeedBaseV1 & {
  executionLayer: "keyboard";
  positions: readonly KeyboardVoicingSeedPositionV1[];
};

export type ButtonBoardVoicingSeedPositionV1 = {
  side: string;
  row: number;
  column: number;
  button: string;
  pitch?: string;
  note?: string;
  finger?: KeyboardFingerV1;
};

export type ButtonBoardVoicingSeedV1 = VoicingSeedBaseV1 & {
  executionLayer: "button-board";
  positions: readonly ButtonBoardVoicingSeedPositionV1[];
};

export type GuitarMoveableRootV1 = {
  label: string;
  offset: number;
};

export type GuitarMoveableVoicingSeedDefinitionV1 = {
  id: string;
  instrumentId: string;
  label: string;
  shapeFamily: GuitarShapeFamilyV1;
  quality: string;
  baseFrets: readonly (number | null)[];
  rank: number;
  roots: readonly GuitarMoveableRootV1[];
};

export type GuitarVoicingSeedsV1 = {
  common: readonly GuitarVoicingSeedV1[];
  moveableDefinitions: readonly GuitarMoveableVoicingSeedDefinitionV1[];
};

export type KeyboardVoicingSeedsV1 = {
  executionLayer: "keyboard";
  seeds: readonly KeyboardVoicingSeedV1[];
};

export type ButtonBoardVoicingSeedsV1 = {
  executionLayer: "button-board";
  seeds: readonly ButtonBoardVoicingSeedV1[];
};

export type InstrumentVoicingSeedsV1 = GuitarVoicingSeedsV1 | KeyboardVoicingSeedsV1 | ButtonBoardVoicingSeedsV1;

export type ImportAdapterDefinitionV1 = {
  schemaVersion: InstrumentKnowledgeBundleSchemaVersion;
  description?: string;
  stringOrder?: readonly number[];
};

export type InstrumentKnowledgeBundleV1 = {
  schemaVersion: InstrumentKnowledgeBundleSchemaVersion;
  bundleId: string;
  version: string;
  harmonicDefinitions: Readonly<Record<string, HarmonicDefinitionV1>>;
  instrumentProfiles: Readonly<Record<string, InstrumentProfileV1>>;
  voicingSeeds: Readonly<Record<string, InstrumentVoicingSeedsV1> & { guitar?: GuitarVoicingSeedsV1 }>;
  importAdapters: Readonly<Record<string, ImportAdapterDefinitionV1>>;
};

export type ObservedGuitarGzipVoicing = {
  positions: readonly unknown[];
  fingerings?: readonly unknown[];
};

export type NormalizeObservedGuitarGzipOptions = {
  instrumentId?: string;
  sourceId?: string;
  rankStart?: number;
};

export const INSTRUMENT_KNOWLEDGE_BUNDLE_V1 = callMusicCore({ operation: "constants" }).INSTRUMENT_KNOWLEDGE_BUNDLE_V1 as unknown as InstrumentKnowledgeBundleV1;
export function normalizeInstrumentKnowledgeBundle(input: unknown): InstrumentKnowledgeBundleV1 {
  return callMusicCore({ operation: "normalizeBundle", input }) as unknown as InstrumentKnowledgeBundleV1;
}
export function normalizeObservedGuitarGzipVoicingSeeds(input: unknown, options: NormalizeObservedGuitarGzipOptions = {}): readonly GuitarVoicingSeedV1[] {
  return callMusicCore({ operation: "normalizeObserved", input, options });
}
