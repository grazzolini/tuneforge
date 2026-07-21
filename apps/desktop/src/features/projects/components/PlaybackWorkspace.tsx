import { PlaybackPracticeRail } from "./PlaybackPracticeRail";
import { PlaybackPracticeControlsDrawer } from "./PlaybackPracticeControlsDrawer";
import { PlaybackPracticeSurface } from "./PlaybackPracticeSurface";
import { PlaybackTransport } from "./PlaybackTransport";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function PlaybackWorkspace({
  onClosePracticeControls,
  practiceControlsOpen,
}: {
  onClosePracticeControls: () => void;
  practiceControlsOpen: boolean;
}) {
  const {
    handleSeek,
    handleSeekTo,
    handleResetPlaybackTempo,
    handleTogglePlaybackLoop,
    isMobileRuntime,
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
      {!isMobileRuntime ? <PlaybackPracticeRail /> : null}
      <PlaybackPracticeSurface />
      <div className="panel playback-transport-dock" ref={playbackTransportRef}>
        <PlaybackTransport
          compact
          mobile={isMobileRuntime}
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
      {isMobileRuntime ? (
        <PlaybackPracticeControlsDrawer
          open={practiceControlsOpen}
          onDismiss={onClosePracticeControls}
        />
      ) : null}
    </div>
  );
}
