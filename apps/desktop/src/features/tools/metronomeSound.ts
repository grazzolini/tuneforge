export type GeneratedMetronomeSound = {
  accentDurationSeconds: number;
  accentFrequencyHz: number;
  durationSeconds: number;
  frequencyHz: number;
  id: "generated-click";
  kind: "generated";
  label: string;
};

export type MetronomeSound = GeneratedMetronomeSound;

export const METRONOME_SOUNDS: MetronomeSound[] = [
  {
    accentDurationSeconds: 0.045,
    accentFrequencyHz: 1760,
    durationSeconds: 0.032,
    frequencyHz: 1175,
    id: "generated-click",
    kind: "generated",
    label: "Generated Click",
  },
];

export const DEFAULT_METRONOME_SOUND = METRONOME_SOUNDS[0];

export function scheduleMetronomeClick({
  accent,
  audioContext,
  sound = DEFAULT_METRONOME_SOUND,
  startTimeSeconds,
  volume,
}: {
  accent: boolean;
  audioContext: AudioContext;
  sound?: MetronomeSound;
  startTimeSeconds: number;
  volume: number;
}) {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const durationSeconds = accent ? sound.accentDurationSeconds : sound.durationSeconds;
  const frequencyHz = accent ? sound.accentFrequencyHz : sound.frequencyHz;
  const peakGain = Math.min(1, Math.max(0, volume)) * (accent ? 0.42 : 0.32);
  const safeStartTimeSeconds = Math.max(audioContext.currentTime, startTimeSeconds);
  const stopTimeSeconds = safeStartTimeSeconds + durationSeconds;

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(frequencyHz, safeStartTimeSeconds);
  gainNode.gain.setValueAtTime(0.0001, safeStartTimeSeconds);
  gainNode.gain.exponentialRampToValueAtTime(
    Math.max(0.0001, peakGain),
    safeStartTimeSeconds + 0.004,
  );
  gainNode.gain.exponentialRampToValueAtTime(0.0001, stopTimeSeconds);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gainNode.disconnect();
  };
  oscillator.start(safeStartTimeSeconds);
  oscillator.stop(stopTimeSeconds + 0.004);
}
