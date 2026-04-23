import { MusicalChordLabel } from "../../../components/MusicalLabel";
import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { PlayPauseGlyph, SeekGlyph, StopGlyph } from "./TransportGlyphs";
import { artifactLabel, formatPlaybackClock, hasTimedLyrics } from "../projectViewUtils";

export function PlaybackStage() {
  const {
    activeChordIndex,
    activeEnharmonicKeyContext,
    activeLyricsIndex,
    activeLyricsWordIndex,
    activeStemCount,
    chordContextCopy,
    chordJob,
    chordMutation,
    chordSegmentRefs,
    currentChord,
    displayedChords,
    displayedLyrics,
    enharmonicDisplayMode,
    handleLyricsAction,
    handleSeek,
    handleSelectPrimaryArtifact,
    handleSelectStemArtifact,
    hasChordTimeline,
    hasLyricsTranscript,
    hasTimedLyricsTranscript,
    isChordRunning,
    isEditingLyrics,
    isLyricsRunning,
    isPlaying,
    isStemPlayback,
    lyricsDraft,
    lyricsJob,
    lyricsMutation,
    lyricsSaveMutation,
    lyricsSegmentRefs,
    nextChord,
    playbackDurationSeconds,
    playbackTimeSeconds,
    projectQuery,
    seekAnimationRevision,
    seekTo,
    selectedArtifactId,
    selectedArtifactTimestamp,
    selectedPrimaryArtifact,
    setIsEditingLyrics,
    setLyricsDraft,
    showSupportingCopy,
    stageModeLabel,
    stageSummary,
    stageTitle,
    stemControls,
    stemOutputLabel,
    stopPlayback,
    togglePlayback,
    toggleStemControl,
    visibleStemArtifacts,
  } = useProjectViewModelContext();

  return (
    <div className="panel playback-stage">
      <div className="playback-stage__header">
        <div>
      <p className="metric-label">Now Playing</p>
      <h2>{stageTitle}</h2>
      <p className="artifact-meta">{stageSummary}</p>
        </div>
        <div className="playback-focus__meta">
      <span>{stageModeLabel}</span>
      {selectedArtifactTimestamp ? <span>{selectedArtifactTimestamp}</span> : null}
        </div>
      </div>

      <div className="stage-surface">
        <div className="transport">
      <div className="transport__controls">
        <button
          aria-label="Seek back 10 seconds"
          className="button transport__button transport__button--seek"
          onClick={() => handleSeek(-10)}
          type="button"
        >
          <SeekGlyph
            key={`backward-${seekAnimationRevision.backward}`}
            animate={seekAnimationRevision.backward > 0}
            direction="backward"
          />
        </button>
        <button
          aria-label={isPlaying ? "Pause playback" : "Play playback"}
          aria-pressed={isPlaying}
          className="button transport__button transport__button--play"
          onClick={() => void togglePlayback()}
          type="button"
        >
          <PlayPauseGlyph isPlaying={isPlaying} />
        </button>
        <button
          aria-label="Stop playback"
          className="button transport__button transport__button--stop"
          onClick={stopPlayback}
          type="button"
        >
          <StopGlyph />
        </button>
        <button
          aria-label="Seek forward 10 seconds"
          className="button transport__button transport__button--seek"
          onClick={() => handleSeek(10)}
          type="button"
        >
          <SeekGlyph
            key={`forward-${seekAnimationRevision.forward}`}
            animate={seekAnimationRevision.forward > 0}
            direction="forward"
          />
        </button>
      </div>

      <label className="transport__scrubber">
        <span className="metric-label">Playback position</span>
        <input
          aria-label="Playback position"
          max={playbackDurationSeconds || projectQuery.data?.duration_seconds || 0}
          min={0}
          onChange={(event) => seekTo(Number(event.target.value))}
          step={0.001}
          type="range"
          value={Math.min(
            playbackTimeSeconds,
            playbackDurationSeconds || projectQuery.data?.duration_seconds || 0,
          )}
        />
        <div className="transport__times">
          <strong>{formatPlaybackClock(playbackTimeSeconds)}</strong>
          <span>
            {formatPlaybackClock(
              playbackDurationSeconds || projectQuery.data?.duration_seconds || 0,
            )}
          </span>
        </div>
      </label>
        </div>
      </div>

      <div className="playback-stage__lane">
        <div className="playback-stage__lane-header">
      <div>
        <p className="metric-label">Chord Follow</p>
        <h3>Current harmony</h3>
      </div>
      <button
        className="button button--small"
        type="button"
        onClick={() => chordMutation.mutate()}
        disabled={chordMutation.isPending || isChordRunning}
      >
        {chordMutation.isPending || isChordRunning
          ? "Generating..."
          : hasChordTimeline
            ? "Refresh Chords"
            : "Generate Chords"}
      </button>
        </div>

        <div className="chord-preview-grid">
      <div className="chord-card" role="group" aria-label="Current chord card">
        <span className="metric-label">Current</span>
        <strong>
          {currentChord ? (
            <MusicalChordLabel
              activeKey={activeEnharmonicKeyContext}
              fallbackLabel={currentChord.label ?? "-"}
              mode={enharmonicDisplayMode}
              pitchClass={currentChord.pitch_class}
              quality={currentChord.quality}
              variant="chord-card"
            />
          ) : (
            "-"
          )}
        </strong>
      </div>
      <div className="chord-card" role="group" aria-label="Next chord card">
        <span className="metric-label">Next</span>
        <strong>
          {nextChord ? (
            <MusicalChordLabel
              activeKey={activeEnharmonicKeyContext}
              fallbackLabel={nextChord.label ?? "-"}
              mode={enharmonicDisplayMode}
              pitchClass={nextChord.pitch_class}
              quality={nextChord.quality}
              variant="chord-card"
            />
          ) : (
            "-"
          )}
        </strong>
      </div>
        </div>

        {showSupportingCopy ? (
      <div className="chord-context">
        <span className="artifact-meta">{chordContextCopy}</span>
      </div>
        ) : null}

        {hasChordTimeline ? (
      <div className="chord-timeline" role="group" aria-label="Chord timeline">
        {displayedChords.map((segment, index) => {
          const durationWeight = Math.max(
            0.9,
            segment.end_seconds - segment.start_seconds,
          );
          const isActive = index === activeChordIndex;
          return (
            <button
              key={`${segment.start_seconds}-${segment.label}-${index}`}
              className={`chord-segment${isActive ? " chord-segment--active" : ""}`}
              type="button"
              style={{ flexGrow: durationWeight }}
              aria-pressed={isActive}
              ref={(element) => {
                chordSegmentRefs.current[
                  `${segment.start_seconds}-${segment.label}-${index}`
                ] = element;
              }}
              onClick={() => seekTo(segment.start_seconds)}
            >
              <span>
                <MusicalChordLabel
                  activeKey={activeEnharmonicKeyContext}
                  fallbackLabel={segment.label}
                  mode={enharmonicDisplayMode}
                  pitchClass={segment.pitch_class}
                  quality={segment.quality}
                  variant="chord-chip"
                />
              </span>
              <small>{formatPlaybackClock(segment.start_seconds)}</small>
            </button>
          );
        })}
      </div>
        ) : (
      <div className="chord-lane-empty">
        <p className="artifact-meta">
          Generate a chord pass to jump around the arrangement while you practice.
        </p>
      </div>
        )}

        {chordJob?.error_message ? (
      <p className="inline-error">{chordJob.error_message}</p>
        ) : null}
      </div>

      <div className="playback-stage__lane">
        <div className="playback-stage__lane-header">
      <div>
        <p className="metric-label">Lyrics Follow</p>
        <h3>Current lyrics</h3>
      </div>
      <div className="button-row">
        {hasLyricsTranscript && !isEditingLyrics ? (
          <button
            className="button button--ghost button--small"
            type="button"
            onClick={() => setIsEditingLyrics(true)}
            disabled={lyricsMutation.isPending || isLyricsRunning}
          >
            Edit Lyrics
          </button>
        ) : null}
        <button
          className="button button--small"
          type="button"
          onClick={() => void handleLyricsAction()}
          disabled={lyricsMutation.isPending || isLyricsRunning}
        >
          {lyricsMutation.isPending || isLyricsRunning
            ? "Generating..."
            : hasLyricsTranscript
              ? "Refresh Lyrics"
              : "Generate Lyrics"}
        </button>
      </div>
        </div>

        {isEditingLyrics ? (
      <div className="lyrics-editor">
        {displayedLyrics.map((segment, index) => (
          <label className="lyrics-editor__row" key={`${segment.start_seconds}-${index}`}>
            <span className="lyrics-editor__time">
              {hasTimedLyrics(segment) ? formatPlaybackClock(segment.start_seconds ?? 0) : "Static"}
            </span>
            <textarea
              aria-label={`Lyric segment ${index + 1}`}
              className="lyrics-editor__input"
              value={lyricsDraft[index] ?? ""}
              onChange={(event) =>
                setLyricsDraft((current) =>
                  current.map((value, valueIndex) =>
                    valueIndex === index ? event.target.value : value,
                  ),
                )
              }
            />
          </label>
        ))}
        <div className="button-row">
          <button
            className="button button--primary button--small"
            type="button"
            onClick={() => lyricsSaveMutation.mutate()}
            disabled={lyricsSaveMutation.isPending}
          >
            {lyricsSaveMutation.isPending ? "Saving..." : "Save Lyrics"}
          </button>
          <button
            className="button button--ghost button--small"
            type="button"
            onClick={() => {
              setIsEditingLyrics(false);
              setLyricsDraft(displayedLyrics.map((currentSegment) => currentSegment.text));
            }}
            disabled={lyricsSaveMutation.isPending}
          >
            Cancel
          </button>
        </div>
      </div>
        ) : hasLyricsTranscript ? (
      <div className="lyrics-panel" role="group" aria-label="Lyrics transcript">
        {displayedLyrics.map((segment, index) => {
          const isActive = index === activeLyricsIndex;
          const segmentKey = `${segment.start_seconds}-${segment.end_seconds}-${index}`;
          const canSeek = hasTimedLyrics(segment);
          const content =
            isActive && (segment.words?.length ?? 0) > 0 ? (
              <span className="lyrics-segment__words">
                {(segment.words ?? []).map((word, wordIndex) => (
                  <span
                    key={`${segmentKey}-${wordIndex}-${word.start_seconds}`}
                    className={`lyrics-word${
                      wordIndex === activeLyricsWordIndex ? " lyrics-word--active" : ""
                    }`}
                  >
                    {word.text}
                  </span>
                ))}
              </span>
            ) : (
              <span className="lyrics-segment__text">{segment.text}</span>
            );

          if (canSeek) {
            return (
              <button
                key={segmentKey}
                className={`lyrics-segment${isActive ? " lyrics-segment--active" : ""}`}
                type="button"
                ref={(element) => {
                  lyricsSegmentRefs.current[segmentKey] = element;
                }}
                onClick={() => seekTo(segment.start_seconds ?? 0)}
              >
                <small>{formatPlaybackClock(segment.start_seconds ?? 0)}</small>
                {content}
              </button>
            );
          }

          return (
            <div
              key={segmentKey}
              className={`lyrics-segment lyrics-segment--static${
                isActive ? " lyrics-segment--active" : ""
              }`}
            >
              <small>Static</small>
              {content}
            </div>
          );
        })}
      </div>
        ) : (
      <div className="chord-lane-empty">
        <p className="artifact-meta">
          Generate a lyrics pass to keep transcription and playback together while you practice.
        </p>
      </div>
        )}

        {!isEditingLyrics && hasLyricsTranscript && !hasTimedLyricsTranscript ? (
      <div className="chord-context">
        <span className="artifact-meta">This transcript has no timing data, so follow mode stays static.</span>
      </div>
        ) : null}

        {lyricsSaveMutation.error ? (
      <p className="inline-error">
        {lyricsSaveMutation.error instanceof Error
          ? lyricsSaveMutation.error.message
          : "Lyrics could not be saved."}
      </p>
        ) : null}
        {lyricsJob?.error_message ? (
      <p className="inline-error">{lyricsJob.error_message}</p>
        ) : null}
      </div>

      {visibleStemArtifacts.length ? (
        <div className="stage-subsection">
      <div className="panel-heading">
        <div>
          <h3>Stem Monitor</h3>
          {showSupportingCopy ? (
            <p className="subpanel__copy">
              Mute or solo stems without leaving the transport surface.
            </p>
          ) : null}
        </div>
        {isStemPlayback ? (
          <button
            className="button button--small"
            onClick={() => {
              if (selectedPrimaryArtifact) {
                handleSelectPrimaryArtifact(selectedPrimaryArtifact);
              }
            }}
            type="button"
          >
            Return to Full Mix
          </button>
        ) : (
          <button
            className="button button--small"
            onClick={() => {
              if (visibleStemArtifacts[0]) {
                handleSelectStemArtifact(visibleStemArtifacts[0]);
              }
            }}
            type="button"
          >
            Switch to Stems
          </button>
        )}
      </div>

      <div className="stem-mixer">
        <div className="stem-mixer__summary">
          <span className="metric-label">Audible stems</span>
          <strong>
            {activeStemCount} / {visibleStemArtifacts.length}
          </strong>
        </div>
        {visibleStemArtifacts.map((artifact) => {
          const state = stemControls[artifact.id] ?? {
            muted: false,
            solo: false,
          };
          return (
            <div className="stem-row" key={artifact.id}>
              <button
                className={`stem-row__name${
                  selectedArtifactId === artifact.id ? " stem-row__name--active" : ""
                }`}
                onClick={() => handleSelectStemArtifact(artifact)}
                type="button"
              >
                <span>{artifactLabel(artifact)}</span>
                <small>{stemOutputLabel(artifact.id)}</small>
              </button>
              <div className="stem-row__controls">
                <button
                  className={`chip${state.muted ? " chip--active" : ""}`}
                  aria-label={`Mute ${artifactLabel(artifact)}`}
                  aria-pressed={state.muted}
                  onClick={() => toggleStemControl(artifact, "muted")}
                  type="button"
                >
                  Mute
                </button>
                <button
                  className={`chip${state.solo ? " chip--active" : ""}`}
                  aria-label={`Solo ${artifactLabel(artifact)}`}
                  aria-pressed={state.solo}
                  onClick={() => toggleStemControl(artifact, "solo")}
                  type="button"
                >
                  Solo
                </button>
              </div>
            </div>
          );
        })}
      </div>
        </div>
      ) : null}
    </div>
  );
}
