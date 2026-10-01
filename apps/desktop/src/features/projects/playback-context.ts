import { createContext, useContext } from "react";
import type { NativeAudioCue, NativeAudioSessionSnapshot } from "../../lib/nativeAudio";
import type { NativeOutputRouting } from "../../lib/nativeAudio";
import type {
  OutputRouteSelection,
  PlaybackRouteLane,
  ProjectOutputRouting,
} from "../../lib/outputRouting";
import type { AnalysisTimingGrid } from "../../lib/timingGrid";
import type { ChordDictionaryFollowProjectContext } from "./chordDictionaryFollowContext";
import type { PlaybackLoopRange, StemControlState } from "./projectPlaybackState";

export type ProjectPlaybackSession = {
  projectId: string;
  projectName: string;
  stageTitle: string;
  stageSummary: string;
  selectedPlaybackArtifactId: string | null;
  isStemPlayback: boolean;
  drumMode?: "original" | "split";
  drumSourceArtifactId?: string | null;
  onDrumModeRollback?: () => void;
  onPlaybackSourceRollback?: () => void;
  playbackArtifactIds: string[];
  artifactPathsById: Record<string, string>;
  artifactFormatsById: Record<string, string>;
  visibleStemArtifactIds: string[];
  routeLanes?: PlaybackRouteLane[];
  stemControls: Record<string, StemControlState>;
  projectOutputGain: number;
  projectOutputMuted: boolean;
  durationHintSeconds: number;
  precountEnabled: boolean;
  precountLoopEnabled: boolean;
  precountClickCount: number;
  precountTempoBpm: number | null;
  tempoOriginalBpm: number | null;
  tempoTargetBpm: number | null;
  timingGrid: AnalysisTimingGrid | null;
  loopRange: PlaybackLoopRange | null;
  chordDictionaryFollowProject: ChordDictionaryFollowProjectContext | null;
};

export type PlaybackSnapshot = {
  session: ProjectPlaybackSession | null;
  playbackTimeSeconds: number;
  playbackDurationSeconds: number;
  isPrecounting: boolean;
  isPlaying: boolean;
};

export type PlaybackContextValue = {
  session: ProjectPlaybackSession | null;
  playbackTimeSeconds: number;
  playbackDurationSeconds: number;
  isPrecounting: boolean;
  isPlaying: boolean;
  projectOutputSaveError: string | null;
  outputRoutingSaveError: string | null;
  outputRouting: ProjectOutputRouting;
  outputRoutingSnapshot: NativeOutputRouting | null;
  setProjectOutputRoute: (selection: OutputRouteSelection) => void;
  setCueOutputRoute: (selection: OutputRouteSelection) => void;
  setStemOutputRoute: (stableKey: string, selection: OutputRouteSelection) => void;
  resetOutputRoutes: () => void;
  activateStemPlayback: () => Promise<void>;
  primeWebAudioForGesture: () => Promise<void>;
  getPlaybackSnapshot: () => PlaybackSnapshot;
  registerProjectSession: (session: ProjectPlaybackSession) => void;
  updateFollowedMetronomeCues?: (
    cues: NativeAudioCue[],
  ) => Promise<NativeAudioSessionSnapshot | null>;
  updateActiveLoopRange?: (range: PlaybackLoopRange | null) => void;
  togglePlayback: () => Promise<void>;
  playPlayback: () => Promise<void>;
  pausePlayback: () => void;
  stopPlayback: () => void;
  releasePlaybackHandles: () => Promise<void>;
  dismissSession: () => void;
  seekBy: (secondsDelta: number) => void;
  seekTo: (timeSeconds: number) => void;
  setProjectOutputGain: (gain: number) => void;
  setProjectOutputMuted: (muted: boolean) => void;
};

export const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) {
    throw new Error("usePlayback must be used within a PlaybackProvider.");
  }
  return context;
}
