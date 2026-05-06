export const PRECOUNT_START_DELAY_SECONDS = 0.035;
export const PRECOUNT_GAIN = 1;
const PRECOUNT_FREQUENCY_HZ = 760;
const PRECOUNT_CLICK_ATTACK_SECONDS = 0.002;
const PRECOUNT_CLICK_DURATION_SECONDS = 0.045;
const PRECOUNT_STOP_TAIL_SECONDS = 0.004;

export function schedulePrecountClaveClick({
  audioContext,
  startTimeSeconds,
}: {
  audioContext: AudioContext;
  startTimeSeconds: number;
}) {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const safeStartTimeSeconds = Math.max(audioContext.currentTime, startTimeSeconds);
  const peakTimeSeconds = safeStartTimeSeconds + PRECOUNT_CLICK_ATTACK_SECONDS;
  const stopTimeSeconds = safeStartTimeSeconds + PRECOUNT_CLICK_DURATION_SECONDS;

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(PRECOUNT_FREQUENCY_HZ, safeStartTimeSeconds);
  gainNode.gain.setValueAtTime(0.0001, safeStartTimeSeconds);
  gainNode.gain.exponentialRampToValueAtTime(PRECOUNT_GAIN, peakTimeSeconds);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, stopTimeSeconds);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gainNode.disconnect();
  };
  oscillator.start(safeStartTimeSeconds);
  oscillator.stop(stopTimeSeconds + PRECOUNT_STOP_TAIL_SECONDS);
}
