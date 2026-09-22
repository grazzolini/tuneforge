import { createContext, useContext } from "react";
import { setBrowserAppOutput, setBrowserCueOutputs } from "./audioOutput";

export type AudioOutputContextValue = {
  appOutputGain: number;
  appOutputMuted: boolean;
  countInOutputGain: number;
  countInOutputMuted: boolean;
  metronomeOutputGain: number;
  metronomeOutputMuted: boolean;
  outputSaveError: string | null;
  ensureAppOutputReady: () => Promise<void>;
  setAppOutputGain: (gain: number) => void;
  setAppOutputMuted: (muted: boolean) => void;
  setCountInOutputGain: (gain: number) => void;
  setCountInOutputMuted: (muted: boolean) => void;
  setMetronomeOutputGain: (gain: number) => void;
  setMetronomeOutputMuted: (muted: boolean) => void;
};

export const AudioOutputContext = createContext<AudioOutputContextValue | null>(null);

const fallbackAudioOutput: AudioOutputContextValue = {
  appOutputGain: 1,
  appOutputMuted: false,
  countInOutputGain: 1,
  countInOutputMuted: false,
  metronomeOutputGain: 0.8,
  metronomeOutputMuted: false,
  outputSaveError: null,
  ensureAppOutputReady: () => Promise.resolve(),
  setAppOutputGain: (gain) => setBrowserAppOutput({ gain, muted: false }),
  setAppOutputMuted: (muted) => setBrowserAppOutput({ gain: 1, muted }),
  setCountInOutputGain: (gain) => setBrowserCueOutputs(
    { gain, muted: false },
    { gain: 0.8, muted: false },
  ),
  setCountInOutputMuted: (muted) => setBrowserCueOutputs(
    { gain: 1, muted },
    { gain: 0.8, muted: false },
  ),
  setMetronomeOutputGain: (gain) => setBrowserCueOutputs(
    { gain: 1, muted: false },
    { gain, muted: false },
  ),
  setMetronomeOutputMuted: (muted) => setBrowserCueOutputs(
    { gain: 1, muted: false },
    { gain: 0.8, muted },
  ),
};

export function useAudioOutput() {
  return useContext(AudioOutputContext) ?? fallbackAudioOutput;
}
