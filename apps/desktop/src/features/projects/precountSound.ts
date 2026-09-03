export const PRECOUNT_START_DELAY_SECONDS = 0.035;
export const PRECOUNT_GAIN = 1;
const PRECOUNT_FREQUENCY_HZ = 760;
const PRECOUNT_CLICK_ATTACK_SECONDS = 0.002;
const PRECOUNT_CLICK_DURATION_SECONDS = 0.045;
const PRECOUNT_STOP_TAIL_SECONDS = 0.004;

export type PrecountClaveClickHandle = {
  cancel: () => void;
};

function disconnectAudioNode(node: AudioNode) {
  try {
    node.disconnect();
  } catch {
    // Node may already be disconnected by the audio engine.
  }
}

export function schedulePrecountClaveClick({
  audioContext,
  startTimeSeconds,
}: {
  audioContext: AudioContext;
  startTimeSeconds: number;
}): PrecountClaveClickHandle {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const safeStartTimeSeconds = Math.max(audioContext.currentTime, startTimeSeconds);
  const peakTimeSeconds = safeStartTimeSeconds + PRECOUNT_CLICK_ATTACK_SECONDS;
  const stopTimeSeconds = safeStartTimeSeconds + PRECOUNT_CLICK_DURATION_SECONDS;
  let disconnected = false;

  const disconnectNodes = () => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    disconnectAudioNode(oscillator);
    disconnectAudioNode(gainNode);
  };

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(PRECOUNT_FREQUENCY_HZ, safeStartTimeSeconds);
  gainNode.gain.setValueAtTime(0.0001, safeStartTimeSeconds);
  gainNode.gain.exponentialRampToValueAtTime(PRECOUNT_GAIN, peakTimeSeconds);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, stopTimeSeconds);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.onended = () => {
    disconnectNodes();
  };
  oscillator.start(safeStartTimeSeconds);
  oscillator.stop(stopTimeSeconds + PRECOUNT_STOP_TAIL_SECONDS);
  return {
    cancel: () => {
      try {
        oscillator.stop(audioContext.currentTime);
      } catch {
        // If the browser already ended the oscillator, disconnect still silences the route.
      }
      disconnectNodes();
    },
  };
}
