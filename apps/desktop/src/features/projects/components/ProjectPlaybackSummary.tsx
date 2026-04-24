import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { PlaybackTransport } from "./PlaybackTransport";

export function ProjectPlaybackSummary() {
  const {
    handleSeek,
    handleSeekTo,
    handleSelectWorkspace,
    isPlaying,
    playbackDurationSeconds,
    playbackTimeSeconds,
    projectQuery,
    seekAnimationRevision,
    selectedArtifactTimestamp,
    showSupportingCopy,
    stageModeLabel,
    stageSummary,
    stageTitle,
    stopPlayback,
    togglePlayback,
  } = useProjectViewModelContext();
  const maxSeconds = playbackDurationSeconds || projectQuery.data?.duration_seconds || 0;

  return (
    <div className="panel project-stage-summary">
      <div className="project-stage-summary__header">
        <div>
          <p className="metric-label">Now Playing</p>
          <h2>{stageTitle}</h2>
          <p className="artifact-meta">{stageSummary}</p>
        </div>

        <div className="project-stage-summary__meta">
          <span>{stageModeLabel}</span>
          {selectedArtifactTimestamp ? <span>{selectedArtifactTimestamp}</span> : null}
          <button
            className="button button--ghost button--small"
            onClick={() => handleSelectWorkspace("playback")}
            type="button"
          >
            Open Playback
          </button>
        </div>
      </div>

      <div className="stage-surface stage-surface--compact">
        <PlaybackTransport
          isPlaying={isPlaying}
          maxSeconds={maxSeconds}
          playbackTimeSeconds={playbackTimeSeconds}
          seekAnimationRevision={seekAnimationRevision}
          onSeek={handleSeek}
          onSeekTo={handleSeekTo}
          onStop={stopPlayback}
          onTogglePlayback={togglePlayback}
        />

        {showSupportingCopy ? (
          <p className="artifact-meta project-stage-summary__copy">
            Project tools stay here. Playback workspace keeps lyrics, chords, and stem practice centered.
          </p>
        ) : null}
      </div>
    </div>
  );
}
