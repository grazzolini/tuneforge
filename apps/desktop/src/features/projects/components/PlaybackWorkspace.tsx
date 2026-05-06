import { PlaybackPracticeRail } from "./PlaybackPracticeRail";
import { PlaybackPracticeSurface } from "./PlaybackPracticeSurface";
import { PlaybackTransport } from "./PlaybackTransport";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function PlaybackWorkspace() {
  const {
    handleSeek,
    handleSeekTo,
    handleResetPlaybackTempo,
    isPlaying,
    playbackDurationSeconds,
    playbackTransportRef,
    playbackTimeSeconds,
    projectQuery,
    seekAnimationRevision,
    stopPlayback,
    tempoDisplayBpm,
    tempoTargetBpm,
    togglePlayback,
  } = useProjectViewModelContext();
  const maxSeconds = playbackDurationSeconds || projectQuery.data?.duration_seconds || 0;

  return (
    <div className={`playback-workspace playback-workspace--practice${isPlaying ? " playback-workspace--focus" : ""}`}>
      <PlaybackPracticeRail />
      <PlaybackPracticeSurface />
      <div className="panel playback-transport-dock" ref={playbackTransportRef}>
        <PlaybackTransport
          compact
          isPlaying={isPlaying}
          maxSeconds={maxSeconds}
          playbackTimeSeconds={playbackTimeSeconds}
          seekAnimationRevision={seekAnimationRevision}
          tempoDisplayBpm={tempoDisplayBpm}
          tempoTargetBpm={tempoTargetBpm}
          onSeek={handleSeek}
          onSeekTo={handleSeekTo}
          onResetTempo={handleResetPlaybackTempo}
          onStop={stopPlayback}
          onTogglePlayback={togglePlayback}
        />
      </div>
    </div>
  );
}
