import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function ProcessingPanel() {
  const {
    analyzeMutation,
    canAnalyze,
    canGenerateChords,
    canGenerateLyrics,
    canGenerateStems,
    chordMutation,
    handleAnalyzeAction,
    handleChordAction,
    handleLyricsAction,
    handleStemAction,
    hasChordTimeline,
    hasLyricsTranscript,
    hasVisibleStems,
    isAnalysisRunning,
    isChordRunning,
    isLyricsRunning,
    isMobileRuntime,
    isStemRunning,
    lyricsMutation,
    mobileGenerationMessage,
    projectEditLocked,
    projectSyncLockReason,
    selectedPrimaryArtifactId,
    showSupportingCopy,
    stemMutation,
  } = useProjectViewModelContext();

  const analyzeDisabled = projectEditLocked || analyzeMutation.isPending || isAnalysisRunning || !canAnalyze;
  const lyricsDisabled = lyricsMutation.isPending || isLyricsRunning || !canGenerateLyrics;
  const chordsDisabled = chordMutation.isPending || isChordRunning || !canGenerateChords;
  const stemsDisabled =
    projectEditLocked ||
    stemMutation.isPending ||
    isStemRunning ||
    !selectedPrimaryArtifactId ||
    !canGenerateStems;
  const editLockTitle = projectSyncLockReason ?? undefined;

  return (
    <div className="panel processing-panel">
      <div className="panel-heading">
        <div>
          <h2>Processing</h2>
          {showSupportingCopy ? (
            <p className="subpanel__copy">Submit analysis and generation jobs without interrupting playback.</p>
          ) : null}
        </div>
      </div>

      {isMobileRuntime && mobileGenerationMessage ? (
        <p className="inline-error">{mobileGenerationMessage}</p>
      ) : null}

      <div className="processing-panel__actions">
        <button
          className="button button--small"
          disabled={analyzeDisabled}
          onClick={handleAnalyzeAction}
          title={editLockTitle}
          type="button"
        >
          {analyzeMutation.isPending || isAnalysisRunning ? "Analyzing..." : "Analyze Track"}
        </button>
        <button
          className="button button--small"
          disabled={chordsDisabled}
          onClick={() => void handleChordAction()}
          title={editLockTitle}
          type="button"
        >
          {chordMutation.isPending || isChordRunning
            ? "Generating..."
            : hasChordTimeline
              ? "Refresh Chords"
              : "Generate Chords"}
        </button>
        <button
          className="button button--small"
          disabled={lyricsDisabled}
          onClick={() => void handleLyricsAction()}
          title={editLockTitle}
          type="button"
        >
          {lyricsMutation.isPending || isLyricsRunning
            ? "Generating..."
            : hasLyricsTranscript
              ? "Refresh Lyrics"
              : "Generate Lyrics"}
        </button>
        <button
          className="button button--small"
          disabled={stemsDisabled}
          onClick={() => void handleStemAction()}
          title={editLockTitle}
          type="button"
        >
          {stemMutation.isPending || isStemRunning
            ? hasVisibleStems
              ? "Rebuilding..."
              : "Generating..."
            : hasVisibleStems
              ? "Rebuild Stems"
              : "Generate Stems"}
        </button>
      </div>
    </div>
  );
}
