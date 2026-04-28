import { createContext, useContext } from "react";

export type MetronomeLaunchOptions = {
  bpm?: unknown;
  followPlayback?: boolean;
};

export type MetronomeContextValue = {
  accentFirstBeat: boolean;
  activeBeat: number | null;
  beatsPerBar: number;
  bpm: number;
  bpmDraft: string;
  errorMessage: string | null;
  followPlayback: boolean;
  isRunning: boolean;
  syncStatus: string;
  tapBpm: number | null;
  volume: number;
  commitBpmDraft: () => void;
  handleTapTempo: () => void;
  launchMetronome: (options?: MetronomeLaunchOptions) => Promise<void>;
  resetVolume: () => void;
  seedBpm: (value: unknown) => void;
  setAccentFirstBeat: (enabled: boolean) => void;
  setBeatsPerBarValue: (value: string) => void;
  setBpmDraftValue: (value: string) => void;
  setFollowPlaybackEnabled: (enabled: boolean) => Promise<void>;
  setVolume: (volume: number) => void;
  startMetronome: () => Promise<void>;
  stopMetronome: () => void;
};

export const MetronomeContext = createContext<MetronomeContextValue | null>(null);

export function useMetronome() {
  const context = useContext(MetronomeContext);
  if (!context) {
    throw new Error("useMetronome must be used within a MetronomeProvider.");
  }
  return context;
}
