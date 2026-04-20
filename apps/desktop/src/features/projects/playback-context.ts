import { createContext, useContext } from "react";
import type { StemControlState } from "./projectPlaybackState";

export type ProjectPlaybackSession = {
  projectId: string;
  projectName: string;
  stageTitle: string;
  stageSummary: string;
  selectedPlaybackArtifactId: string | null;
  isStemPlayback: boolean;
  visibleStemArtifactIds: string[];
  stemControls: Record<string, StemControlState>;
  durationHintSeconds: number;
};

export type PlaybackContextValue = {
  session: ProjectPlaybackSession | null;
  playbackTimeSeconds: number;
  playbackDurationSeconds: number;
  isPlaying: boolean;
  activateStemPlayback: () => Promise<void>;
  registerProjectSession: (session: ProjectPlaybackSession) => void;
  togglePlayback: () => Promise<void>;
  playPlayback: () => Promise<void>;
  pausePlayback: () => void;
  stopPlayback: () => void;
  dismissSession: () => void;
  seekBy: (secondsDelta: number) => void;
  seekTo: (timeSeconds: number) => void;
};

export const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) {
    throw new Error("usePlayback must be used within a PlaybackProvider.");
  }
  return context;
}
