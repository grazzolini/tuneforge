import { PlaybackPracticeRail } from "./PlaybackPracticeRail";
import { PlaybackPracticeSurface } from "./PlaybackPracticeSurface";
import { PlaybackTransport } from "./PlaybackTransport";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function PlaybackWorkspace() {
  const {
    handleSeek,
    handleSeekTo,
    handleResetPlaybackTempo,
    handleTogglePlaybackLoop,
    isPlaying,
    loopRange,
    loopStatusMessage,
    playbackDurationSeconds,
    playbackTransportRef,
    playbackTimeSeconds,
    pendingLoopStartSeconds,
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
          loopRange={loopRange}
          loopStatusMessage={loopStatusMessage}
          maxSeconds={maxSeconds}
          pendingLoopStartSeconds={pendingLoopStartSeconds}
          playbackTimeSeconds={playbackTimeSeconds}
          seekAnimationRevision={seekAnimationRevision}
          tempoDisplayBpm={tempoDisplayBpm}
          tempoTargetBpm={tempoTargetBpm}
          onSeek={handleSeek}
          onSeekTo={handleSeekTo}
          onResetTempo={handleResetPlaybackTempo}
          onStop={stopPlayback}
          onToggleLoop={handleTogglePlaybackLoop}
          onTogglePlayback={togglePlayback}
        />
      </div>
    </div>
  );
}
