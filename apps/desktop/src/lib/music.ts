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

const DISPLAY_PITCH_CLASSES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

const KEY_ORDER: MusicalKey[] = [
  { pitchClass: 0, mode: "major" },
  { pitchClass: 7, mode: "major" },
  { pitchClass: 2, mode: "major" },
  { pitchClass: 9, mode: "major" },
  { pitchClass: 4, mode: "major" },
  { pitchClass: 11, mode: "major" },
  { pitchClass: 6, mode: "major" },
  { pitchClass: 1, mode: "major" },
  { pitchClass: 8, mode: "major" },
  { pitchClass: 3, mode: "major" },
  { pitchClass: 10, mode: "major" },
  { pitchClass: 5, mode: "major" },
  { pitchClass: 9, mode: "minor" },
  { pitchClass: 4, mode: "minor" },
  { pitchClass: 11, mode: "minor" },
  { pitchClass: 6, mode: "minor" },
  { pitchClass: 1, mode: "minor" },
  { pitchClass: 8, mode: "minor" },
  { pitchClass: 3, mode: "minor" },
  { pitchClass: 10, mode: "minor" },
  { pitchClass: 5, mode: "minor" },
  { pitchClass: 0, mode: "minor" },
  { pitchClass: 7, mode: "minor" },
  { pitchClass: 2, mode: "minor" },
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
