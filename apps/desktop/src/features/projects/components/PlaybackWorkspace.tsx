import { PlaybackPracticeRail } from "./PlaybackPracticeRail";
import { PlaybackPracticeSurface } from "./PlaybackPracticeSurface";
import { PlaybackTransport } from "./PlaybackTransport";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function PlaybackWorkspace() {
  const {
    handleSeek,
    handleSeekTo,
    isPlaying,
    playbackDurationSeconds,
    playbackTransportRef,
    playbackTimeSeconds,
    projectQuery,
    seekAnimationRevision,
    stopPlayback,
    togglePlayback,
  } = useProjectViewModelContext();
  const maxSeconds = playbackDurationSeconds || projectQuery.data?.duration_seconds || 0;

  return (
    <div className="playback-workspace playback-workspace--practice">
      <PlaybackPracticeRail />
      <PlaybackPracticeSurface />
      <div className="panel playback-transport-dock" ref={playbackTransportRef}>
        <PlaybackTransport
          compact
          isPlaying={isPlaying}
          maxSeconds={maxSeconds}
          playbackTimeSeconds={playbackTimeSeconds}
          seekAnimationRevision={seekAnimationRevision}
          onSeek={handleSeek}
          onSeekTo={handleSeekTo}
          onStop={stopPlayback}
          onTogglePlayback={togglePlayback}
        />
      </div>
    </div>
  );
}
