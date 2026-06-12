import rawInstrumentKnowledgeBundle from "./instrumentKnowledgeData.json";

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

export type ButtonBoardProfileV1 = {
  layout: string;
  buttons: number;
  rows?: number;
  columns?: number;
  canTranspose: boolean;
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

const EMPTY_INSTRUMENT_KNOWLEDGE_BUNDLE_V1: InstrumentKnowledgeBundleV1 = {
  schemaVersion: 1,
  bundleId: "",
  version: "",
  harmonicDefinitions: {},
  instrumentProfiles: {},
  voicingSeeds: {},
  importAdapters: {},
};

const HARMONIC_DEGREES = new Set<HarmonicDegree>([
  "1",
  "b2",
  "#1",
  "2",
  "#2",
  "b3",
  "3",
  "4",
  "#4",
  "b5",
  "5",
  "#5",
  "b6",
  "6",
  "#6",
  "bb7",
  "b7",
  "7",
]);
const GUITAR_SHAPE_FAMILIES = new Set<GuitarShapeFamilyV1>(["C", "A", "G", "E", "D"]);
const GUITAR_FINGERS = new Set<GuitarFingerV1>([1, 2, 3, 4]);
const KEYBOARD_FINGERS = new Set<KeyboardFingerV1>([1, 2, 3, 4, 5]);
const KEYBOARD_HANDS = new Set<KeyboardHandV1>(["left", "right"]);
const DEFAULT_GUITAR_STRING_ORDER = [6, 5, 4, 3, 2, 1] as const;
const DEFAULT_GUITAR_STRING_ORDER_SET = new Set<number>(DEFAULT_GUITAR_STRING_ORDER);

export const INSTRUMENT_KNOWLEDGE_BUNDLE_V1: InstrumentKnowledgeBundleV1 =
  normalizeInstrumentKnowledgeBundle(rawInstrumentKnowledgeBundle);

export function normalizeInstrumentKnowledgeBundle(input: unknown): InstrumentKnowledgeBundleV1 {
  const record = asRecord(input);
  if (!record || record.schemaVersion !== 1) {
    return EMPTY_INSTRUMENT_KNOWLEDGE_BUNDLE_V1;
  }

  return {
    schemaVersion: 1,
    bundleId: asNonEmptyString(record.bundleId) ?? "",
    version: asNonEmptyString(record.version) ?? "",
    harmonicDefinitions: normalizeHarmonicDefinitions(record.harmonicDefinitions),
    instrumentProfiles: normalizeInstrumentProfiles(record.instrumentProfiles),
    voicingSeeds: normalizeVoicingSeedGroups(record.voicingSeeds),
    importAdapters: normalizeImportAdapters(record.importAdapters),
  };
}

export function normalizeObservedGuitarGzipVoicingSeeds(
  input: unknown,
  options: NormalizeObservedGuitarGzipOptions = {},
): readonly GuitarVoicingSeedV1[] {
  const record = asRecord(input);
  if (!record) {
    return [];
  }

  const instrumentId = options.instrumentId ?? "guitar";
  const sourceId = options.sourceId ?? "observed-gzip";
  const rankStart = options.rankStart ?? 1000;
  const seeds: GuitarVoicingSeedV1[] = [];

  for (const [chordLabel, rawShapes] of Object.entries(record)) {
    const normalizedChordLabel = chordLabel.trim();
    if (!normalizedChordLabel || !Array.isArray(rawShapes)) {
      continue;
    }

    rawShapes.forEach((rawShape, shapeIndex) => {
      const shape = normalizeObservedGuitarGzipShape(rawShape, normalizedChordLabel, shapeIndex, instrumentId, sourceId);
      if (shape) {
        seeds.push({ ...shape, rank: rankStart + seeds.length });
      }
    });
  }

  return seeds;
}

function normalizeHarmonicDefinitions(input: unknown): Readonly<Record<string, HarmonicDefinitionV1>> {
  const record = asRecord(input);
  if (!record) {
    return {};
  }

  const definitions: Record<string, HarmonicDefinitionV1> = {};
  for (const [key, value] of Object.entries(record)) {
    const rawDefinition = asRecord(value);
    const id = asNonEmptyString(rawDefinition?.id) ?? key.trim();
    const label = asNonEmptyString(rawDefinition?.label);
    const suffix = typeof rawDefinition?.suffix === "string" ? rawDefinition.suffix : null;
    const tones = normalizeHarmonicTones(rawDefinition?.tones);
    if (!id || !label || suffix === null || tones.length === 0) {
      continue;
    }

    definitions[id] = {
      id,
      label,
      suffix,
      aliases: normalizeStringArray(rawDefinition?.aliases),
      tones,
    };
  }
  return definitions;
}

function normalizeHarmonicTones(input: unknown): readonly HarmonicToneDefinitionV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawTone): HarmonicToneDefinitionV1[] => {
    const tone = asRecord(rawTone);
    if (!tone || !isHarmonicDegree(tone.degree) || !isSafeInteger(tone.interval)) {
      return [];
    }
    return [{ degree: tone.degree, interval: tone.interval }];
  });
}

function normalizeInstrumentProfiles(input: unknown): Readonly<Record<string, InstrumentProfileV1>> {
  const record = asRecord(input);
  if (!record) {
    return {};
  }

  const profiles: Record<string, InstrumentProfileV1> = {};
  for (const [key, value] of Object.entries(record)) {
    const rawProfile = asRecord(value);
    const id = asNonEmptyString(rawProfile?.id) ?? key.trim();
    const label = asNonEmptyString(rawProfile?.label);
    const family = asNonEmptyString(rawProfile?.family);
    const executionLayer = asNonEmptyString(rawProfile?.executionLayer);
    if (!id || !label || !family || !executionLayer) {
      continue;
    }

    const tuning = normalizeInstrumentTuning(rawProfile?.tuning);
    const fretboard = normalizeFretboardProfile(rawProfile?.fretboard);
    const keyboard = normalizeKeyboardProfile(rawProfile?.keyboard);
    const buttonBoard = normalizeButtonBoardProfile(rawProfile?.buttonBoard);
    profiles[id] = {
      id,
      label,
      family,
      executionLayer,
      ...(tuning.length > 0 ? { tuning } : {}),
      ...(fretboard ? { fretboard } : {}),
      ...(keyboard ? { keyboard } : {}),
      ...(buttonBoard ? { buttonBoard } : {}),
    };
  }
  return profiles;
}

function normalizeInstrumentTuning(input: unknown): readonly InstrumentTuningStringV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawTuning): InstrumentTuningStringV1[] => {
    const tuning = asRecord(rawTuning);
    const openPitch = asNonEmptyString(tuning?.openPitch);
    if (!tuning || !isPositiveInteger(tuning.string) || !openPitch) {
      return [];
    }
    return [{ string: tuning.string, openPitch }];
  });
}

function normalizeFretboardProfile(input: unknown): FretboardProfileV1 | null {
  const rawFretboard = asRecord(input);
  if (!rawFretboard || !isPositiveInteger(rawFretboard.frets)) {
    return null;
  }

  return {
    frets: rawFretboard.frets,
    stringOrder: normalizeGuitarStringOrder(rawFretboard.stringOrder),
    canCapo: rawFretboard.canCapo === true,
    canRetune: rawFretboard.canRetune === true,
  };
}

function normalizeKeyboardProfile(input: unknown): KeyboardProfileV1 | null {
  const rawKeyboard = asRecord(input);
  const lowestPitch = asNonEmptyString(rawKeyboard?.lowestPitch);
  const highestPitch = asNonEmptyString(rawKeyboard?.highestPitch);
  if (!rawKeyboard || !isPositiveInteger(rawKeyboard.keyCount) || !lowestPitch || !highestPitch) {
    return null;
  }

  return {
    keyCount: rawKeyboard.keyCount,
    lowestPitch,
    highestPitch,
    canTranspose: rawKeyboard.canTranspose === true,
  };
}

function normalizeButtonBoardProfile(input: unknown): ButtonBoardProfileV1 | null {
  const rawButtonBoard = asRecord(input);
  const layout = asNonEmptyString(rawButtonBoard?.layout);
  if (!rawButtonBoard || !layout || !isPositiveInteger(rawButtonBoard.buttons)) {
    return null;
  }

  const rows = isPositiveInteger(rawButtonBoard.rows) ? rawButtonBoard.rows : null;
  const columns = isPositiveInteger(rawButtonBoard.columns) ? rawButtonBoard.columns : null;
  return {
    layout,
    buttons: rawButtonBoard.buttons,
    ...(rows ? { rows } : {}),
    ...(columns ? { columns } : {}),
    canTranspose: rawButtonBoard.canTranspose === true,
  };
}

function normalizeVoicingSeedGroups(input: unknown): InstrumentKnowledgeBundleV1["voicingSeeds"] {
  const record = asRecord(input);
  if (!record) {
    return {};
  }

  const groups: Record<string, InstrumentVoicingSeedsV1> = {};
  for (const [instrumentId, value] of Object.entries(record)) {
    const rawGroup = asRecord(value);
    if (!rawGroup) {
      continue;
    }
    const common = normalizeGuitarVoicingSeeds(rawGroup.common, instrumentId);
    const moveableDefinitions = normalizeGuitarMoveableDefinitions(rawGroup.moveableDefinitions, instrumentId);
    if (common.length > 0 || moveableDefinitions.length > 0) {
      groups[instrumentId] = { common, moveableDefinitions };
      continue;
    }

    const layeredGroup = normalizeLayeredVoicingSeedGroup(rawGroup, instrumentId);
    if (layeredGroup) {
      groups[instrumentId] = layeredGroup;
    }
  }
  return groups as InstrumentKnowledgeBundleV1["voicingSeeds"];
}

function normalizeGuitarVoicingSeeds(input: unknown, instrumentId: string): readonly GuitarVoicingSeedV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawSeed): GuitarVoicingSeedV1[] => {
    const seed = asRecord(rawSeed);
    const id = asNonEmptyString(seed?.id);
    const label = asNonEmptyString(seed?.label);
    const chordLabel = asNonEmptyString(seed?.chordLabel);
    const rank = seed && isSafeInteger(seed.rank) ? seed.rank : null;
    const notes = normalizeGuitarVoicingNotes(seed?.notes);
    if (!id || !label || !chordLabel || rank === null || notes.length === 0) {
      return [];
    }

    const shapeFamily = normalizeGuitarShapeFamily(seed?.shapeFamily);
    return [
      {
        id,
        instrumentId,
        label,
        chordLabel,
        ...(shapeFamily ? { shapeFamily } : {}),
        rank,
        source: "first-party",
        notes,
      },
    ];
  });
}

function normalizeGuitarMoveableDefinitions(
  input: unknown,
  instrumentId: string,
): readonly GuitarMoveableVoicingSeedDefinitionV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawDefinition): GuitarMoveableVoicingSeedDefinitionV1[] => {
    const definition = asRecord(rawDefinition);
    const id = asNonEmptyString(definition?.id);
    const label = asNonEmptyString(definition?.label);
    const quality = asNonEmptyString(definition?.quality);
    const shapeFamily = normalizeGuitarShapeFamily(definition?.shapeFamily);
    const rank = definition && isSafeInteger(definition.rank) ? definition.rank : null;
    const baseFrets = normalizeBaseFrets(definition?.baseFrets);
    const roots = normalizeMoveableRoots(definition?.roots);
    if (
      !id ||
      !label ||
      !quality ||
      !shapeFamily ||
      rank === null ||
      baseFrets.length !== DEFAULT_GUITAR_STRING_ORDER.length ||
      roots.length === 0
    ) {
      return [];
    }

    return [{ id, instrumentId, label, shapeFamily, quality, baseFrets, rank, roots }];
  });
}

function normalizeGuitarVoicingNotes(input: unknown): readonly GuitarVoicingSeedNoteV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawNote): GuitarVoicingSeedNoteV1[] => {
    const note = asRecord(rawNote);
    if (!note || !isPositiveInteger(note.string) || !isNonNegativeInteger(note.fret)) {
      return [];
    }

    const finger = normalizeGuitarFinger(note.finger);
    return [{ string: note.string, fret: note.fret, ...(finger ? { finger } : {}) }];
  });
}

function normalizeLayeredVoicingSeedGroup(input: Record<string, unknown>, instrumentId: string): InstrumentVoicingSeedsV1 | null {
  if (input.executionLayer === "keyboard") {
    const seeds = normalizeKeyboardVoicingSeeds(input.seeds, instrumentId);
    return seeds.length > 0 ? { executionLayer: "keyboard", seeds } : null;
  }

  if (input.executionLayer === "button-board") {
    const seeds = normalizeButtonBoardVoicingSeeds(input.seeds, instrumentId);
    return seeds.length > 0 ? { executionLayer: "button-board", seeds } : null;
  }

  return null;
}

function normalizeKeyboardVoicingSeeds(input: unknown, instrumentId: string): readonly KeyboardVoicingSeedV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawSeed): KeyboardVoicingSeedV1[] => {
    const seed = asRecord(rawSeed);
    const base = normalizeVoicingSeedBase(seed, instrumentId);
    const positions = normalizeKeyboardVoicingPositions(seed?.positions);
    if (!base || positions.length === 0) {
      return [];
    }

    return [{ ...base, executionLayer: "keyboard", positions }];
  });
}

function normalizeButtonBoardVoicingSeeds(input: unknown, instrumentId: string): readonly ButtonBoardVoicingSeedV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawSeed): ButtonBoardVoicingSeedV1[] => {
    const seed = asRecord(rawSeed);
    const base = normalizeVoicingSeedBase(seed, instrumentId);
    const positions = normalizeButtonBoardVoicingPositions(seed?.positions);
    if (!base || positions.length === 0) {
      return [];
    }

    return [{ ...base, executionLayer: "button-board", positions }];
  });
}

function normalizeVoicingSeedBase(input: Record<string, unknown> | null, instrumentId: string): VoicingSeedBaseV1 | null {
  const id = asNonEmptyString(input?.id);
  const label = asNonEmptyString(input?.label);
  const chordLabel = asNonEmptyString(input?.chordLabel);
  const rank = input && isSafeInteger(input.rank) ? input.rank : null;
  if (!id || !label || !chordLabel || rank === null) {
    return null;
  }

  const tags = normalizeStringArray(input?.tags);
  return {
    id,
    instrumentId,
    label,
    chordLabel,
    rank,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function normalizeKeyboardVoicingPositions(input: unknown): readonly KeyboardVoicingSeedPositionV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawPosition): KeyboardVoicingSeedPositionV1[] => {
    const position = asRecord(rawPosition);
    const pitch = asNonEmptyString(position?.pitch);
    if (!position || !pitch) {
      return [];
    }

    const note = asNonEmptyString(position.note);
    const hand = normalizeKeyboardHand(position.hand);
    const finger = normalizeKeyboardFinger(position.finger);
    return [
      {
        pitch,
        ...(note ? { note } : {}),
        ...(hand ? { hand } : {}),
        ...(finger ? { finger } : {}),
      },
    ];
  });
}

function normalizeButtonBoardVoicingPositions(input: unknown): readonly ButtonBoardVoicingSeedPositionV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawPosition): ButtonBoardVoicingSeedPositionV1[] => {
    const position = asRecord(rawPosition);
    const side = asNonEmptyString(position?.side);
    const button = asNonEmptyString(position?.button);
    if (!position || !side || !button || !isPositiveInteger(position.row) || !isPositiveInteger(position.column)) {
      return [];
    }

    const pitch = asNonEmptyString(position.pitch);
    const note = asNonEmptyString(position.note);
    const finger = normalizeKeyboardFinger(position.finger);
    return [
      {
        side,
        row: position.row,
        column: position.column,
        button,
        ...(pitch ? { pitch } : {}),
        ...(note ? { note } : {}),
        ...(finger ? { finger } : {}),
      },
    ];
  });
}

function normalizeBaseFrets(input: unknown): readonly (number | null)[] {
  if (!Array.isArray(input) || input.length !== DEFAULT_GUITAR_STRING_ORDER.length) {
    return [];
  }

  const frets: (number | null)[] = [];
  for (const value of input) {
    if (value === null) {
      frets.push(null);
      continue;
    }
    if (!isNonNegativeInteger(value)) {
      return [];
    }
    frets.push(value);
  }
  return frets;
}

function normalizeMoveableRoots(input: unknown): readonly GuitarMoveableRootV1[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((rawRoot): GuitarMoveableRootV1[] => {
    const root = asRecord(rawRoot);
    const label = asNonEmptyString(root?.label);
    if (!root || !label || !isPositiveInteger(root.offset)) {
      return [];
    }
    return [{ label, offset: root.offset }];
  });
}

function normalizeImportAdapters(input: unknown): Readonly<Record<string, ImportAdapterDefinitionV1>> {
  const record = asRecord(input);
  if (!record) {
    return {};
  }

  const adapters: Record<string, ImportAdapterDefinitionV1> = {};
  for (const [id, value] of Object.entries(record)) {
    const rawAdapter = asRecord(value);
    if (!rawAdapter || rawAdapter.schemaVersion !== 1) {
      continue;
    }
    const description = asNonEmptyString(rawAdapter.description);
    const stringOrder = normalizeGuitarStringOrder(rawAdapter.stringOrder);
    adapters[id] = {
      schemaVersion: 1,
      ...(description ? { description } : {}),
      ...(stringOrder.length > 0 ? { stringOrder } : {}),
    };
  }
  return adapters;
}

function normalizeObservedGuitarGzipShape(
  input: unknown,
  chordLabel: string,
  shapeIndex: number,
  instrumentId: string,
  sourceId: string,
): GuitarVoicingSeedV1 | null {
  const shape = asRecord(input);
  if (!shape || !Array.isArray(shape.positions) || shape.positions.length !== DEFAULT_GUITAR_STRING_ORDER.length) {
    return null;
  }

  const notes = shape.positions.flatMap((position, index): GuitarVoicingSeedNoteV1[] => {
    const fret = normalizeObservedFret(position);
    if (fret === null) {
      return [];
    }

    const finger = normalizeObservedFingerForString(shape.fingerings, index);
    return [
      {
        string: DEFAULT_GUITAR_STRING_ORDER[index],
        fret,
        ...(finger ? { finger } : {}),
      },
    ];
  });
  if (notes.length === 0) {
    return null;
  }

  const ordinal = shapeIndex + 1;
  return {
    id: `${sourceId}-${slugify(chordLabel)}-${ordinal}`,
    instrumentId,
    label: `${chordLabel} observed ${ordinal}`,
    chordLabel,
    rank: 0,
    source: "observed-gzip",
    notes,
  };
}

function normalizeObservedFret(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "x") {
      return null;
    }
    const parsed = Number(trimmed);
    return isNonNegativeInteger(parsed) ? parsed : null;
  }
  return isNonNegativeInteger(value) ? value : null;
}

function normalizeObservedFingerForString(input: unknown, stringIndex: number): GuitarFingerV1 | null {
  if (!Array.isArray(input)) {
    return null;
  }

  const firstRow = input[0];
  if (Array.isArray(firstRow) && firstRow.length === DEFAULT_GUITAR_STRING_ORDER.length) {
    return normalizeObservedFingerValue(firstRow[stringIndex]);
  }

  return normalizeObservedFinger(input[stringIndex]);
}

function normalizeObservedFinger(value: unknown): GuitarFingerV1 | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const candidate of value) {
    const finger = normalizeObservedFingerValue(candidate);
    if (finger) {
      return finger;
    }
  }
  return null;
}

function normalizeObservedFingerValue(value: unknown): GuitarFingerV1 | null {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  return normalizeGuitarFinger(numeric);
}

function normalizeGuitarFinger(value: unknown): GuitarFingerV1 | null {
  return isSafeInteger(value) && GUITAR_FINGERS.has(value as GuitarFingerV1) ? (value as GuitarFingerV1) : null;
}

function normalizeKeyboardFinger(value: unknown): KeyboardFingerV1 | null {
  return isSafeInteger(value) && KEYBOARD_FINGERS.has(value as KeyboardFingerV1) ? (value as KeyboardFingerV1) : null;
}

function normalizeKeyboardHand(value: unknown): KeyboardHandV1 | null {
  return typeof value === "string" && KEYBOARD_HANDS.has(value as KeyboardHandV1) ? (value as KeyboardHandV1) : null;
}

function normalizeGuitarShapeFamily(value: unknown): GuitarShapeFamilyV1 | null {
  return typeof value === "string" && GUITAR_SHAPE_FAMILIES.has(value as GuitarShapeFamilyV1)
    ? (value as GuitarShapeFamilyV1)
    : null;
}

function normalizeStringArray(input: unknown): readonly string[] {
  return Array.isArray(input) ? input.flatMap((value) => asNonEmptyString(value) ?? []) : [];
}

function normalizeNumberArray(input: unknown): readonly number[] {
  return Array.isArray(input) ? input.flatMap((value) => (isSafeInteger(value) ? [value] : [])) : [];
}

function normalizeGuitarStringOrder(input: unknown): readonly number[] {
  if (!Array.isArray(input) || input.length !== DEFAULT_GUITAR_STRING_ORDER.length) {
    return [];
  }

  const stringOrder = normalizeNumberArray(input);
  if (
    stringOrder.length !== DEFAULT_GUITAR_STRING_ORDER.length ||
    new Set(stringOrder).size !== DEFAULT_GUITAR_STRING_ORDER.length
  ) {
    return [];
  }

  return stringOrder.every((string) => DEFAULT_GUITAR_STRING_ORDER_SET.has(string)) ? stringOrder : [];
}

function isHarmonicDegree(value: unknown): value is HarmonicDegree {
  return typeof value === "string" && HARMONIC_DEGREES.has(value as HarmonicDegree);
}

function isPositiveInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("#", "sharp")
    .replaceAll("/", "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
