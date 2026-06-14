export const CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY =
  "tuneforge.chord-dictionary-preferences.v2";

export type ChordDictionaryPreferenceContext = {
  projectId?: string | null;
  instrumentId: string;
  chordLabel: string;
  sourceKeyLabel?: string | null;
  displayedKeyLabel?: string | null;
  transposeSemitones?: number | null;
  capoFret?: number | null;
  useCapoShapes?: boolean | null;
};

type NormalizedChordDictionaryPreferenceContext = {
  projectId: string | null;
  instrumentId: string;
  chordLabel: string;
};

type ChordDictionaryPreferencesStorage = {
  version: 2;
  globalPreferredShapeIds: Record<string, string>;
  projectPreferredShapeIds: Record<string, Record<string, string>>;
};

function createEmptyChordDictionaryPreferences(): ChordDictionaryPreferencesStorage {
  return {
    version: 2,
    globalPreferredShapeIds: {},
    projectPreferredShapeIds: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRequiredText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function normalizeOptionalText(value: unknown): string | null {
  return normalizeRequiredText(value);
}

function normalizeShapeId(value: unknown): string | null {
  return normalizeRequiredText(value);
}

function normalizeShapePreferenceMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalizedEntries = Object.entries(value).flatMap(([contextKey, shapeId]) => {
    const normalizedContextKey = normalizeRequiredText(contextKey);
    const normalizedShapeId = normalizeShapeId(shapeId);
    if (!normalizedContextKey || !normalizedShapeId) {
      return [];
    }
    return [[normalizedContextKey, normalizedShapeId] satisfies [string, string]];
  });

  return Object.fromEntries(normalizedEntries);
}

function normalizeProjectShapePreferenceMap(
  value: unknown,
): Record<string, Record<string, string>> {
  if (!isRecord(value)) {
    return {};
  }

  const normalizedEntries = Object.entries(value).flatMap(([projectId, shapeMap]) => {
    const normalizedProjectId = normalizeRequiredText(projectId);
    const normalizedShapeMap = normalizeShapePreferenceMap(shapeMap);
    if (!normalizedProjectId || Object.keys(normalizedShapeMap).length === 0) {
      return [];
    }
    return [[normalizedProjectId, normalizedShapeMap] satisfies [string, Record<string, string>]];
  });

  return Object.fromEntries(normalizedEntries);
}

function normalizeStorage(value: unknown): ChordDictionaryPreferencesStorage {
  if (!isRecord(value) || value.version !== 2) {
    return createEmptyChordDictionaryPreferences();
  }

  return {
    version: 2,
    globalPreferredShapeIds: normalizeShapePreferenceMap(value.globalPreferredShapeIds),
    projectPreferredShapeIds: normalizeProjectShapePreferenceMap(value.projectPreferredShapeIds),
  };
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPreferencesStorage(): ChordDictionaryPreferencesStorage {
  const storage = getLocalStorage();
  if (!storage) {
    return createEmptyChordDictionaryPreferences();
  }

  let storedValue: string | null;
  try {
    storedValue = storage.getItem(CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY);
  } catch {
    return createEmptyChordDictionaryPreferences();
  }

  if (!storedValue) {
    return createEmptyChordDictionaryPreferences();
  }

  try {
    return normalizeStorage(JSON.parse(storedValue));
  } catch {
    return createEmptyChordDictionaryPreferences();
  }
}

function writePreferencesStorage(value: ChordDictionaryPreferencesStorage): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      CHORD_DICTIONARY_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalizeStorage(value)),
    );
  } catch {
    return;
  }
}

function normalizePreferenceContext(
  context: ChordDictionaryPreferenceContext | null | undefined,
): NormalizedChordDictionaryPreferenceContext | null {
  if (!context) {
    return null;
  }

  const instrumentId = normalizeRequiredText(context.instrumentId);
  const chordLabel = normalizeRequiredText(context.chordLabel);
  if (!instrumentId || !chordLabel) {
    return null;
  }

  return {
    projectId: normalizeOptionalText(context.projectId),
    instrumentId,
    chordLabel,
  };
}

function buildContextKey(
  context: NormalizedChordDictionaryPreferenceContext,
): string {
  return JSON.stringify([context.instrumentId, context.chordLabel]);
}

function normalizeAvailableShapeIds(
  availableShapeIds: readonly string[] | null | undefined,
): string[] {
  if (!Array.isArray(availableShapeIds)) {
    return [];
  }

  const seenShapeIds = new Set<string>();
  const normalizedShapeIds: string[] = [];
  for (const availableShapeId of availableShapeIds) {
    const shapeId = normalizeShapeId(availableShapeId);
    if (!shapeId || seenShapeIds.has(shapeId)) {
      continue;
    }
    seenShapeIds.add(shapeId);
    normalizedShapeIds.push(shapeId);
  }
  return normalizedShapeIds;
}

export function resolveChordDictionaryPreferredShapeId(
  context: ChordDictionaryPreferenceContext | null | undefined,
  availableShapeIds: readonly string[] | null | undefined,
): string | null {
  const normalizedAvailableShapeIds = normalizeAvailableShapeIds(availableShapeIds);
  const generatedDefaultShapeId = normalizedAvailableShapeIds[0] ?? null;
  const normalizedContext = normalizePreferenceContext(context);
  if (!normalizedContext) {
    return generatedDefaultShapeId;
  }

  const availableShapeIdSet = new Set(normalizedAvailableShapeIds);
  const contextKey = buildContextKey(normalizedContext);
  const preferences = readPreferencesStorage();
  if (normalizedContext.projectId) {
    const projectShapeId =
      preferences.projectPreferredShapeIds[normalizedContext.projectId]?.[contextKey] ?? null;
    if (projectShapeId && availableShapeIdSet.has(projectShapeId)) {
      return projectShapeId;
    }
  }

  const globalShapeId = preferences.globalPreferredShapeIds[contextKey] ?? null;
  if (globalShapeId && availableShapeIdSet.has(globalShapeId)) {
    return globalShapeId;
  }

  return generatedDefaultShapeId;
}

export function readGlobalChordDictionaryPreferredShapeId(
  context: ChordDictionaryPreferenceContext | null | undefined,
): string | null {
  const normalizedContext = normalizePreferenceContext(context);
  if (!normalizedContext) {
    return null;
  }

  const preferences = readPreferencesStorage();
  return preferences.globalPreferredShapeIds[buildContextKey(normalizedContext)] ?? null;
}

export function readProjectChordDictionaryPreferredShapeId(
  context: ChordDictionaryPreferenceContext | null | undefined,
): string | null {
  const normalizedContext = normalizePreferenceContext(context);
  if (!normalizedContext?.projectId) {
    return null;
  }

  const preferences = readPreferencesStorage();
  return (
    preferences.projectPreferredShapeIds[normalizedContext.projectId]?.[
      buildContextKey(normalizedContext)
    ] ?? null
  );
}

export function hasGlobalChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
  availableShapeIds: readonly string[] | null | undefined,
): boolean {
  const savedShapeId = readGlobalChordDictionaryPreferredShapeId(context);
  return (
    savedShapeId !== null && normalizeAvailableShapeIds(availableShapeIds).includes(savedShapeId)
  );
}

export function hasProjectChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
  availableShapeIds: readonly string[] | null | undefined,
): boolean {
  const savedShapeId = readProjectChordDictionaryPreferredShapeId(context);
  return (
    savedShapeId !== null && normalizeAvailableShapeIds(availableShapeIds).includes(savedShapeId)
  );
}

export function writeGlobalChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
  shapeId: string,
): void {
  const normalizedContext = normalizePreferenceContext(context);
  const normalizedShapeId = normalizeShapeId(shapeId);
  if (!normalizedContext || !normalizedShapeId) {
    return;
  }

  const contextKey = buildContextKey(normalizedContext);
  const preferences = readPreferencesStorage();
  preferences.globalPreferredShapeIds[contextKey] = normalizedShapeId;
  writePreferencesStorage(preferences);
}

export function writeProjectChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
  shapeId: string,
): void {
  const normalizedContext = normalizePreferenceContext(context);
  const normalizedShapeId = normalizeShapeId(shapeId);
  if (!normalizedContext?.projectId || !normalizedShapeId) {
    return;
  }

  const contextKey = buildContextKey(normalizedContext);
  const preferences = readPreferencesStorage();
  preferences.projectPreferredShapeIds[normalizedContext.projectId] = {
    ...(preferences.projectPreferredShapeIds[normalizedContext.projectId] ?? {}),
    [contextKey]: normalizedShapeId,
  };
  writePreferencesStorage(preferences);
}

export function clearGlobalChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
): void {
  const normalizedContext = normalizePreferenceContext(context);
  if (!normalizedContext) {
    return;
  }

  const preferences = readPreferencesStorage();
  delete preferences.globalPreferredShapeIds[buildContextKey(normalizedContext)];
  writePreferencesStorage(preferences);
}

export function clearProjectChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
): void {
  const normalizedContext = normalizePreferenceContext(context);
  if (!normalizedContext?.projectId) {
    return;
  }

  const contextKey = buildContextKey(normalizedContext);
  const preferences = readPreferencesStorage();
  const projectPreferences =
    preferences.projectPreferredShapeIds[normalizedContext.projectId] ?? {};
  delete projectPreferences[contextKey];

  if (Object.keys(projectPreferences).length === 0) {
    delete preferences.projectPreferredShapeIds[normalizedContext.projectId];
  } else {
    preferences.projectPreferredShapeIds[normalizedContext.projectId] = projectPreferences;
  }

  writePreferencesStorage(preferences);
}

export function resetGlobalChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
): void {
  clearGlobalChordDictionaryPreferredShape(context);
}

export function resetProjectChordDictionaryPreferredShape(
  context: ChordDictionaryPreferenceContext | null | undefined,
): void {
  clearProjectChordDictionaryPreferredShape(context);
}
