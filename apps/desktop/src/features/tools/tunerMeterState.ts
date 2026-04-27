import { formatCents, type TunerPitchReading } from "./tunerPitch";

export type TunerToneState = "no-pitch" | "in-tune" | "flat" | "sharp";

export const TUNER_IN_TUNE_CENTS = 5;

export function getTunerToneState(reading: TunerPitchReading | null): TunerToneState {
  if (!reading) {
    return "no-pitch";
  }
  if (Math.abs(reading.cents) <= TUNER_IN_TUNE_CENTS) {
    return "in-tune";
  }
  return reading.cents < 0 ? "flat" : "sharp";
}

export function getTunerStatusLabel(reading: TunerPitchReading | null) {
  const toneState = getTunerToneState(reading);
  if (toneState === "no-pitch") return "No pitch";
  if (toneState === "in-tune") return "In tune";
  if (toneState === "flat") return "Flat";
  return "Sharp";
}

export function getTunerDisplay(reading: TunerPitchReading | null, referenceHz: number) {
  const toneState = getTunerToneState(reading);
  const clampedCents = clamp(reading?.cents ?? 0, -50, 50);
  return {
    centsLabel: reading ? `${formatCents(reading.cents)} cents` : "No pitch",
    clampedCents,
    hasPitch: Boolean(reading),
    markerPositionPercent: ((clampedCents + 50) / 100) * 100,
    metaLabel: reading
      ? `${reading.frequencyHz.toFixed(2)} Hz -> target ${reading.targetFrequencyHz.toFixed(2)} Hz`
      : `Reference ${referenceHz.toFixed(1)} Hz`,
    noteName: reading?.noteName ?? "--",
    statusLabel: getTunerStatusLabel(reading),
    toneState,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
