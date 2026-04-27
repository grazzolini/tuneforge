import { type TunerPitchReading } from "./tunerPitch";

export type StabilizedTunerReadingState = {
  displayedReading: TunerPitchReading | null;
  lastPitchTimeMs: number | null;
  pendingReading: TunerPitchReading | null;
  pendingSinceMs: number | null;
};

const CENTS_SMOOTHING = 0.34;
const FREQUENCY_SMOOTHING = 0.34;
const NOTE_CHANGE_CONFIRM_MS = 90;
const PITCH_HOLD_MS = 240;

export function createStabilizedTunerReadingState(): StabilizedTunerReadingState {
  return {
    displayedReading: null,
    lastPitchTimeMs: null,
    pendingReading: null,
    pendingSinceMs: null,
  };
}

export function updateStabilizedTunerReading(
  previousState: StabilizedTunerReadingState,
  rawReading: TunerPitchReading | null,
  nowMs: number,
): StabilizedTunerReadingState {
  if (!rawReading) {
    if (
      previousState.displayedReading &&
      previousState.lastPitchTimeMs !== null &&
      nowMs - previousState.lastPitchTimeMs <= PITCH_HOLD_MS
    ) {
      return {
        ...previousState,
        pendingReading: null,
        pendingSinceMs: null,
      };
    }
    return createStabilizedTunerReadingState();
  }

  if (!previousState.displayedReading) {
    return {
      displayedReading: rawReading,
      lastPitchTimeMs: nowMs,
      pendingReading: null,
      pendingSinceMs: null,
    };
  }

  if (rawReading.pitchClass !== previousState.displayedReading.pitchClass) {
    const pendingSinceMs =
      previousState.pendingReading?.pitchClass === rawReading.pitchClass
        ? previousState.pendingSinceMs
        : nowMs;

    if (pendingSinceMs !== null && nowMs - pendingSinceMs >= NOTE_CHANGE_CONFIRM_MS) {
      return {
        displayedReading: rawReading,
        lastPitchTimeMs: nowMs,
        pendingReading: null,
        pendingSinceMs: null,
      };
    }

    return {
      ...previousState,
      lastPitchTimeMs: nowMs,
      pendingReading: rawReading,
      pendingSinceMs,
    };
  }

  const displayedReading = smoothMatchingReading(previousState.displayedReading, rawReading);
  return {
    displayedReading,
    lastPitchTimeMs: nowMs,
    pendingReading: null,
    pendingSinceMs: null,
  };
}

function smoothMatchingReading(
  previousReading: TunerPitchReading,
  rawReading: TunerPitchReading,
): TunerPitchReading {
  if (Math.abs(previousReading.targetFrequencyHz - rawReading.targetFrequencyHz) > 0.001) {
    return rawReading;
  }

  const cents = blend(previousReading.cents, rawReading.cents, CENTS_SMOOTHING);
  return {
    ...rawReading,
    cents,
    frequencyHz: blend(previousReading.frequencyHz, rawReading.frequencyHz, FREQUENCY_SMOOTHING),
  };
}

function blend(previousValue: number, nextValue: number, amount: number) {
  return previousValue + (nextValue - previousValue) * amount;
}
