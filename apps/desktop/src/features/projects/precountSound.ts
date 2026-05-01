export const PRECOUNT_START_DELAY_SECONDS = 0.035;
export const PRECOUNT_GAIN = 0.36;

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
  const peakTimeSeconds = safeStartTimeSeconds + 0.003;
  const stopTimeSeconds = safeStartTimeSeconds + 0.072;

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(2100, safeStartTimeSeconds);
  oscillator.frequency.exponentialRampToValueAtTime(1450, stopTimeSeconds);
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
  oscillator.stop(stopTimeSeconds + 0.006);
}
