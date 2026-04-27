export type TunerPitchReading = {
  cents: number;
  confidence: number;
  frequencyHz: number;
  inputLevel: number;
  noteName: string;
  pitchClass: number;
  targetFrequencyHz: number;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const MIN_TUNER_FREQUENCY_HZ = 50;
const MAX_TUNER_FREQUENCY_HZ = 2000;
const MIN_SIGNAL_RMS = 0.008;
const MIN_CORRELATION = 0.62;

export function frequencyToTunerReading(
  frequencyHz: number,
  referenceHz: number,
  inputLevel = 0,
  confidence = 1,
): TunerPitchReading | null {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0 || !Number.isFinite(referenceHz) || referenceHz <= 0) {
    return null;
  }

  const exactMidiNote = 69 + 12 * Math.log2(frequencyHz / referenceHz);
  const nearestMidiNote = Math.round(exactMidiNote);
  const pitchClass = ((nearestMidiNote % 12) + 12) % 12;
  const targetFrequencyHz = referenceHz * 2 ** ((nearestMidiNote - 69) / 12);
  const cents = 1200 * Math.log2(frequencyHz / targetFrequencyHz);

  return {
    cents,
    confidence: clamp(confidence, 0, 1),
    frequencyHz,
    inputLevel: clamp(inputLevel, 0, 1),
    noteName: NOTE_NAMES[pitchClass] ?? NOTE_NAMES[0],
    pitchClass,
    targetFrequencyHz,
  };
}

export function analyzeTunerBuffer(
  samples: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  referenceHz: number,
): TunerPitchReading | null {
  if (samples.length === 0 || sampleRate <= 0) {
    return null;
  }

  const inputLevel = calculateRms(samples);
  if (inputLevel < MIN_SIGNAL_RMS) {
    return null;
  }

  const minLag = Math.max(1, Math.floor(sampleRate / MAX_TUNER_FREQUENCY_HZ));
  const maxLag = Math.min(samples.length - 2, Math.floor(sampleRate / MIN_TUNER_FREQUENCY_HZ));
  if (maxLag <= minLag) {
    return null;
  }

  const correlations = new Float32Array(maxLag + 1);

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    correlations[lag] = normalizedCorrelation(samples, lag);
  }

  const { lag: bestLag, correlation: bestCorrelation } = findFirstConfidentPeak(
    correlations,
    minLag,
    maxLag,
  );

  if (bestLag === 0 || bestCorrelation < MIN_CORRELATION) {
    return null;
  }

  const lag = interpolateLag(correlations, bestLag);
  return frequencyToTunerReading(sampleRate / lag, referenceHz, inputLevel, bestCorrelation);
}

export function formatCents(cents: number) {
  const roundedCents = Math.round(cents);
  if (roundedCents > 0) {
    return `+${roundedCents}`;
  }
  return `${roundedCents}`;
}

export function calculateTunerInputLevel(samples: Float32Array<ArrayBufferLike>) {
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function calculateRms(samples: Float32Array<ArrayBufferLike>) {
  return calculateTunerInputLevel(samples);
}

function normalizedCorrelation(samples: Float32Array<ArrayBufferLike>, lag: number) {
  let sum = 0;
  let firstEnergy = 0;
  let secondEnergy = 0;
  const sampleCount = samples.length - lag;

  for (let index = 0; index < sampleCount; index += 1) {
    const first = samples[index] ?? 0;
    const second = samples[index + lag] ?? 0;
    sum += first * second;
    firstEnergy += first * first;
    secondEnergy += second * second;
  }

  const denominator = Math.sqrt(firstEnergy * secondEnergy);
  return denominator > 0 ? sum / denominator : 0;
}

function interpolateLag(correlations: Float32Array, lag: number) {
  const previous = correlations[lag - 1] ?? correlations[lag] ?? 0;
  const current = correlations[lag] ?? 0;
  const next = correlations[lag + 1] ?? current;
  const denominator = previous - 2 * current + next;
  if (Math.abs(denominator) < 0.000001) {
    return lag;
  }
  return lag + (previous - next) / (2 * denominator);
}

function findFirstConfidentPeak(
  correlations: Float32Array,
  minLag: number,
  maxLag: number,
) {
  let fallbackLag = 0;
  let fallbackCorrelation = 0;

  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const previous = correlations[lag - 1] ?? 0;
    const current = correlations[lag] ?? 0;
    const next = correlations[lag + 1] ?? 0;

    if (current > fallbackCorrelation) {
      fallbackCorrelation = current;
      fallbackLag = lag;
    }

    if (current >= MIN_CORRELATION && current >= previous && current > next) {
      return { lag, correlation: current };
    }
  }

  return { lag: fallbackLag, correlation: fallbackCorrelation };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
