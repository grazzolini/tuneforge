export type KeyMode = "major" | "minor";

export type MusicalKey = {
  pitchClass: number;
  mode: KeyMode;
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

const DISPLAY_PITCH_CLASSES = [
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

export function formatKey(key: MusicalKey, format: "short" | "long" = "short"): string {
  const noteName = DISPLAY_PITCH_CLASSES[key.pitchClass] ?? DISPLAY_PITCH_CLASSES[0];
  if (format === "long") {
    return `${noteName} ${key.mode}`;
  }
  return key.mode === "minor" ? `${noteName}m` : noteName;
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
