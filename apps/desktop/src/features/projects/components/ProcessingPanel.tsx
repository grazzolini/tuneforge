import type { ChangeEvent } from "react";
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
    lyricsLanguageMetadata,
    lyricsLanguageOptions,
    lyricsMutation,
    mobileGenerationMessage,
    projectEditLocked,
    projectSyncLockReason,
    selectedLyricsLanguageOverride,
    setSelectedLyricsLanguageOverride,
    selectedPrimaryArtifactId,
    showSupportingCopy,
    stemMutation,
  } = useProjectViewModelContext();

  const analyzeDisabled = projectEditLocked || analyzeMutation.isPending || isAnalysisRunning || !canAnalyze;
  const noLyricsSelected = selectedLyricsLanguageOverride === "none";
  const lyricsDisabled =
    projectEditLocked ||
    lyricsMutation.isPending ||
    isLyricsRunning ||
    (!canGenerateLyrics && !noLyricsSelected);
  const lyricsSelectorDisabled = projectEditLocked || lyricsMutation.isPending || isLyricsRunning;
  const chordsDisabled = chordMutation.isPending || isChordRunning || !canGenerateChords;
  const stemsDisabled =
    projectEditLocked ||
    stemMutation.isPending ||
    isStemRunning ||
    !selectedPrimaryArtifactId ||
    !canGenerateStems;
  const editLockTitle = projectSyncLockReason ?? undefined;
  const selectedLyricsLanguageValue = selectedLyricsLanguageOverride ?? "auto";
  const lyricsActionLabel =
    lyricsMutation.isPending || isLyricsRunning
      ? noLyricsSelected
        ? "Clearing..."
        : "Generating..."
      : noLyricsSelected
        ? hasLyricsTranscript
          ? "Clear Lyrics"
          : "Mark Instrumental"
        : hasLyricsTranscript
          ? "Refresh Lyrics"
          : "Generate Lyrics";

  function handleLyricsLanguageChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextValue = event.target.value;
    const nextOption = lyricsLanguageOptions.find(
      (option) => (option.value ?? "auto") === nextValue,
    );
    setSelectedLyricsLanguageOverride(nextOption?.value ?? null);
  }

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
        <div className="processing-panel__lyrics-actions" role="group" aria-label="Lyrics generation">
          <button
            className="button button--small"
            disabled={lyricsDisabled}
            onClick={() => void handleLyricsAction()}
            title={editLockTitle}
            type="button"
          >
            {lyricsActionLabel}
          </button>
          <label className="processing-panel__lyrics-language">
            <select
              aria-label="Lyrics language"
              disabled={lyricsSelectorDisabled}
              onChange={handleLyricsLanguageChange}
              title={editLockTitle}
              value={selectedLyricsLanguageValue}
            >
              {lyricsLanguageOptions.map((option) => (
                <option key={option.value ?? "auto"} value={option.value ?? "auto"}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {lyricsLanguageMetadata ? (
            <span className="processing-panel__lyrics-meta">{lyricsLanguageMetadata}</span>
          ) : null}
        </div>
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
