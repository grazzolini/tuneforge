import type { CSSProperties, KeyboardEvent } from "react";
import { MusicalChordLabel } from "../../../components/MusicalLabel";
import type { TabSuggestionGroupSchema, TabSuggestionSchema } from "../../../lib/api";
import type { LeadSheetChord, LeadSheetLyricsRow, LeadSheetRow } from "../projectViewUtils";
import {
  formatJobErrorMessage,
  formatPlaybackClock,
  hasTimedLyrics,
} from "../projectViewUtils";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function PlaybackPracticeSurface() {
  const { playbackDisplayMode } = useProjectViewModelContext();

  return (
    <main className="panel playback-practice-surface">
      <PlaybackModeHeader />
      {playbackDisplayMode === "lyrics" ? <LyricsPracticePanel /> : null}
      {playbackDisplayMode === "chords" ? <ChordsPracticePanel /> : null}
      {playbackDisplayMode === "combined" ? <CombinedLeadSheetPanel /> : null}
    </main>
  );
}

function usePracticeTargetSpacePlayback() {
  const { handleSeekTo, isPlaying, togglePlayback } = useProjectViewModelContext();

  return function handlePracticeTargetSpacePlayback(
    event: KeyboardEvent<HTMLElement>,
    timeSeconds: number,
  ) {
    if (event.code !== "Space" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    handleSeekTo(timeSeconds);
    if (!isPlaying) {
      void togglePlayback();
    }
  };
}

function PlaybackModeHeader() {
  const {
    acceptedTabSuggestionIds,
    chordsFollowEnabled,
    displayedLyrics,
    handleAcceptTabSuggestionGroup,
    handleApplyTabSuggestions,
    handleCloseTabImport,
    handleCreateTabImportProposal,
    handleOpenTabImport,
    handleRejectTabSuggestionGroup,
    handleSetChordsFollowEnabled,
    handleSetLyricsFollowEnabled,
    handleTogglePlaybackDisplayLane,
    hasLyricsTranscript,
    hasTimedLyricsTranscript,
    isEditingLyrics,
    isLyricsRunning,
    isTabImportOpen,
    lyricsFollowEnabled,
    lyricsMutation,
    playbackDisplayMode,
    projectEditLocked,
    projectSyncLockReason,
    selectedTabSuggestionId,
    setIsEditingLyrics,
    setLyricsDraft,
    setSelectedTabSuggestionId,
    setTabImportDraft,
    tabImportApplyMutation,
    tabImportDraft,
    tabImportMutation,
  } = useProjectViewModelContext();
  const lyricsSelected = playbackDisplayMode === "lyrics" || playbackDisplayMode === "combined";
  const chordsSelected = playbackDisplayMode === "chords" || playbackDisplayMode === "combined";

  return (
    <>
      <div className="playback-practice-surface__header">
        <div>
          <p className="metric-label">Practice View</p>
          <h2>
            {playbackDisplayMode === "combined"
              ? "Lyrics + chords"
              : playbackDisplayMode === "lyrics"
                ? "Lyrics"
                : "Chords"}
          </h2>
        </div>

        <div className="playback-practice-surface__controls">
          <div className="playback-mode-toggle" role="group" aria-label="Playback display mode">
            <button
              aria-pressed={lyricsSelected}
              className={lyricsSelected ? "playback-mode-toggle__button playback-mode-toggle__button--active" : "playback-mode-toggle__button"}
              onClick={() => handleTogglePlaybackDisplayLane("lyrics")}
              type="button"
            >
              Lyrics
            </button>
            <button
              aria-pressed={chordsSelected}
              className={chordsSelected ? "playback-mode-toggle__button playback-mode-toggle__button--active" : "playback-mode-toggle__button"}
              onClick={() => handleTogglePlaybackDisplayLane("chords")}
              type="button"
            >
              Chords
            </button>
          </div>

          <div className="button-row playback-practice-actions">
            {lyricsSelected && hasLyricsTranscript && !isEditingLyrics ? (
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => {
                  if (projectEditLocked) {
                    return;
                  }
                  setLyricsDraft(displayedLyrics.map((segment) => segment.text));
                  setIsEditingLyrics(true);
                }}
                disabled={projectEditLocked || lyricsMutation.isPending || isLyricsRunning}
                title={projectSyncLockReason ?? undefined}
              >
                Edit Lyrics
              </button>
            ) : null}
            <button
              className="button button--ghost button--small"
              type="button"
              onClick={handleOpenTabImport}
              disabled={projectEditLocked}
              title={projectSyncLockReason ?? undefined}
            >
              Import Tab
            </button>
            {lyricsSelected ? (
              <>
                <button
                  aria-pressed={hasTimedLyricsTranscript && lyricsFollowEnabled}
                  className={`chip playback-follow-chip${hasTimedLyricsTranscript && lyricsFollowEnabled ? " chip--active" : ""}`}
                  disabled={!hasTimedLyricsTranscript}
                  onClick={() => handleSetLyricsFollowEnabled(!lyricsFollowEnabled)}
                  title={
                    hasTimedLyricsTranscript ? undefined : "Lyrics Follow requires timed lyrics."
                  }
                  type="button"
                >
                  Lyrics Follow
                </button>
              </>
            ) : null}
            {chordsSelected ? (
              <>
                {playbackDisplayMode === "chords" ? (
                  <button
                    aria-pressed={chordsFollowEnabled}
                    className={`chip playback-follow-chip${chordsFollowEnabled ? " chip--active" : ""}`}
                    onClick={() => handleSetChordsFollowEnabled(!chordsFollowEnabled)}
                    type="button"
                  >
                    Chords Follow
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
      {isTabImportOpen ? (
        <TabImportDialog
          acceptedSuggestionIds={acceptedTabSuggestionIds}
          applyMutation={tabImportApplyMutation}
          draft={tabImportDraft}
          importMutation={tabImportMutation}
          isProjectLocked={projectEditLocked}
          lockReason={projectSyncLockReason}
          onAcceptGroup={handleAcceptTabSuggestionGroup}
          onApply={handleApplyTabSuggestions}
          onClose={handleCloseTabImport}
          onCreateProposal={handleCreateTabImportProposal}
          onRejectGroup={handleRejectTabSuggestionGroup}
          onSelectSuggestion={setSelectedTabSuggestionId}
          onSetDraft={setTabImportDraft}
          selectedSuggestionId={selectedTabSuggestionId}
        />
      ) : null}
    </>
  );
}

function TabImportDialog({
  acceptedSuggestionIds,
  applyMutation,
  draft,
  importMutation,
  isProjectLocked,
  lockReason,
  onAcceptGroup,
  onApply,
  onClose,
  onCreateProposal,
  onRejectGroup,
  onSelectSuggestion,
  onSetDraft,
  selectedSuggestionId,
}: {
  acceptedSuggestionIds: string[];
  applyMutation: ReturnType<typeof useProjectViewModelContext>["tabImportApplyMutation"];
  draft: string;
  importMutation: ReturnType<typeof useProjectViewModelContext>["tabImportMutation"];
  isProjectLocked: boolean;
  lockReason: string | null;
  onAcceptGroup: (suggestionIds: string[]) => void;
  onApply: () => void;
  onClose: () => void;
  onCreateProposal: () => void;
  onRejectGroup: (suggestionIds: string[]) => void;
  onSelectSuggestion: (suggestionId: string | null) => void;
  onSetDraft: (value: string) => void;
  selectedSuggestionId: string | null;
}) {
  const { handleToggleTabSuggestion } = useProjectViewModelContext();
  const groups = importMutation.data?.tab_import.groups ?? [];
  const suggestions = groups.flatMap((group) => group.suggestions ?? []);
  const selectedSuggestion =
    suggestions.find((suggestion) => suggestion.id === selectedSuggestionId) ?? suggestions[0] ?? null;
  const acceptedCount = acceptedSuggestionIds.length;

  return (
    <div className="tab-import-overlay" role="presentation">
      <section
        aria-label="Import tab suggestions"
        className="tab-import-drawer"
        role="dialog"
      >
        <div className="tab-import-drawer__header">
          <div>
            <p className="metric-label">Tab Import</p>
            <h3>Review Suggestions</h3>
          </div>
          <button
            className="button button--ghost button--small"
            disabled={importMutation.isPending || applyMutation.isPending}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <label className="tab-import-input">
          <span>Tab text</span>
          <textarea
            value={draft}
            onChange={(event) => onSetDraft(event.currentTarget.value)}
            placeholder={"[Verse]\nG       D\nHello from the first line"}
            disabled={isProjectLocked}
          />
        </label>

        <div className="button-row tab-import-actions">
          <button
            className="button button--primary button--small"
            disabled={
              isProjectLocked || !draft.trim() || importMutation.isPending || applyMutation.isPending
            }
            onClick={onCreateProposal}
            title={lockReason ?? undefined}
            type="button"
          >
            {importMutation.isPending ? "Reading..." : "Create Suggestions"}
          </button>
          <button
            className="button button--ghost button--small"
            disabled={
              isProjectLocked || acceptedCount === 0 || importMutation.isPending || applyMutation.isPending
            }
            onClick={onApply}
            title={lockReason ?? undefined}
            type="button"
          >
            {applyMutation.isPending ? "Applying..." : `Apply Accepted (${acceptedCount})`}
          </button>
        </div>

        {importMutation.error ? <p className="inline-error">{mutationErrorMessage(importMutation.error)}</p> : null}
        {applyMutation.error ? <p className="inline-error">{mutationErrorMessage(applyMutation.error)}</p> : null}

        {groups.length ? (
          <div className="tab-import-review">
            <div className="tab-import-groups">
              {groups.map((group) => (
                <TabSuggestionGroup
                  acceptedSuggestionIds={acceptedSuggestionIds}
                  group={group}
                  isProjectLocked={isProjectLocked}
                  key={group.kind}
                  lockReason={lockReason}
                  onAcceptGroup={onAcceptGroup}
                  onRejectGroup={onRejectGroup}
                  onSelectSuggestion={onSelectSuggestion}
                  onToggleSuggestion={handleToggleTabSuggestion}
                  selectedSuggestionId={selectedSuggestion?.id ?? null}
                />
              ))}
            </div>

            <TabSuggestionDetail suggestion={selectedSuggestion} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TabSuggestionGroup({
  acceptedSuggestionIds,
  group,
  isProjectLocked,
  lockReason,
  onAcceptGroup,
  onRejectGroup,
  onSelectSuggestion,
  onToggleSuggestion,
  selectedSuggestionId,
}: {
  acceptedSuggestionIds: string[];
  group: TabSuggestionGroupSchema;
  isProjectLocked: boolean;
  lockReason: string | null;
  onAcceptGroup: (suggestionIds: string[]) => void;
  onRejectGroup: (suggestionIds: string[]) => void;
  onSelectSuggestion: (suggestionId: string | null) => void;
  onToggleSuggestion: (suggestionId: string) => void;
  selectedSuggestionId: string | null;
}) {
  const suggestions = group.suggestions ?? [];
  const suggestionIds = suggestions.map((suggestion) => suggestion.id);

  return (
    <section className="tab-import-group">
      <div className="tab-import-group__header">
        <div>
          <h4>{group.label}</h4>
          <span className="artifact-meta">{suggestions.length} suggestions</span>
        </div>
        <div className="button-row">
          <button
            className="button button--ghost button--small"
            disabled={isProjectLocked || !suggestionIds.length}
            onClick={() => onAcceptGroup(suggestionIds)}
            title={lockReason ?? undefined}
            type="button"
          >
            Accept Group
          </button>
          <button
            className="button button--ghost button--small"
            disabled={isProjectLocked || !suggestionIds.length}
            onClick={() => onRejectGroup(suggestionIds)}
            title={lockReason ?? undefined}
            type="button"
          >
            Reject Group
          </button>
        </div>
      </div>

      <div className="tab-import-suggestions">
        {suggestions.map((suggestion) => {
          const accepted = acceptedSuggestionIds.includes(suggestion.id);
          const selected = suggestion.id === selectedSuggestionId;
          return (
            <div
              className={`tab-import-suggestion${selected ? " tab-import-suggestion--selected" : ""}`}
              key={suggestion.id}
            >
              <input
                aria-label={`Accept ${suggestion.title}`}
                checked={accepted}
                disabled={isProjectLocked}
                onChange={() => onToggleSuggestion(suggestion.id)}
                type="checkbox"
              />
              <button
                className="tab-import-suggestion__summary"
                onClick={(event) => {
                  event.preventDefault();
                  onSelectSuggestion(suggestion.id);
                }}
                type="button"
              >
                <span className="tab-import-suggestion__heading">
                  <span>{suggestion.title}</span>
                  <small>{suggestionTimeLabel(suggestion)}</small>
                </span>
                <span className="tab-import-suggestion__comparison">
                  <span className="tab-import-suggestion__cell">
                    <span className="metric-label">Current</span>
                    <span>{suggestion.current_text ?? "-"}</span>
                  </span>
                  <span className="tab-import-suggestion__cell">
                    <span className="metric-label">Tab</span>
                    <span>{suggestion.suggested_text ?? "-"}</span>
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TabSuggestionDetail({ suggestion }: { suggestion: TabSuggestionSchema | null }) {
  if (!suggestion) {
    return (
      <aside className="tab-import-detail">
        <p className="artifact-meta">No suggestions yet.</p>
      </aside>
    );
  }

  return (
    <aside className="tab-import-detail">
      <div>
        <p className="metric-label">{suggestion.kind}</p>
        <h4>{suggestion.title}</h4>
        <span className="artifact-meta">{suggestionTimeLabel(suggestion)}</span>
      </div>
      <div className="tab-import-diff">
        <div>
          <span className="metric-label">Current</span>
          <p>{suggestion.current_text ?? "-"}</p>
        </div>
        <div>
          <span className="metric-label">Tab</span>
          <p>{suggestion.suggested_text ?? "-"}</p>
        </div>
      </div>
    </aside>
  );
}

function suggestionTimeLabel(suggestion: TabSuggestionSchema) {
  if (typeof suggestion.start_seconds !== "number") {
    return "Untimed";
  }
  const start = formatPlaybackClock(suggestion.start_seconds);
  if (typeof suggestion.end_seconds !== "number") {
    return start;
  }
  return `${start} - ${formatPlaybackClock(suggestion.end_seconds)}`;
}

function mutationErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}

function LyricsPracticePanel() {
  const {
    activeLyricsIndex,
    activeLyricsWordIndex,
    displayedLyrics,
    hasLyricsTranscript,
    hasTimedLyricsTranscript,
    isEditingLyrics,
    isMobileRuntime,
    lyricsPracticeStatus,
    lyricsPracticeRefreshFailed,
    lyricsJob,
    lyricsSaveMutation,
    lyricsSegmentRefs,
    lyricsTheaterRef,
    practiceModeFallbackMessage,
    showSupportingCopy,
  } = useProjectViewModelContext();

  if (isEditingLyrics) {
    return <LyricsEditor />;
  }

  const lyricsErrorMessage = formatJobErrorMessage(lyricsJob?.error_message, lyricsJob);

  return (
    <div className="playback-practice-body">
      {lyricsPracticeStatus === "available" ? (
        <div
          className="lead-sheet lead-sheet--lyrics-only"
          role="group"
          aria-label="Lyrics transcript"
          ref={lyricsTheaterRef}
        >
          <div aria-hidden="true" className="lead-sheet__edge" />
          {displayedLyrics.map((segment, index) => {
            const segmentKey = `${segment.start_seconds}-${segment.end_seconds}-${index}`;
            const row: LeadSheetLyricsRow = {
              activeWordIndex: index === activeLyricsIndex ? activeLyricsWordIndex : -1,
              chords: [],
              id: `lyrics-only-${segmentKey}`,
              isActive: index === activeLyricsIndex,
              lyricIndex: index,
              segment,
              type: "lyrics",
            };
            return (
              <LeadSheetLyricsRowView
                key={segmentKey}
                row={row}
                setRowRef={(element) => {
                  lyricsSegmentRefs.current[segmentKey] = element;
                }}
              />
            );
          })}
          <div aria-hidden="true" className="lead-sheet__edge" />
        </div>
      ) : (
        <EmptyPracticeState
          copy={practiceLaneStateCopy("lyrics", lyricsPracticeStatus, isMobileRuntime)}
          announce
        />
      )}

      {hasLyricsTranscript && !hasTimedLyricsTranscript ? (
        <div className="chord-context">
          <span className="artifact-meta">This transcript has no timing data, so follow mode stays static.</span>
        </div>
      ) : null}
      {hasTimedLyricsTranscript && showSupportingCopy ? (
        <div className="chord-context">
          <span className="artifact-meta">Follow keeps the active lyric in view while playback moves.</span>
        </div>
      ) : null}
      {practiceModeFallbackMessage ? (
        <PracticeContextMessage copy={practiceModeFallbackMessage} />
      ) : null}
      {lyricsPracticeRefreshFailed ? (
        <PracticeContextMessage copy="Lyrics couldn’t be refreshed; showing available lyrics." />
      ) : null}
      {lyricsSaveMutation.error ? (
        <p className="inline-error">
          {lyricsSaveMutation.error instanceof Error
            ? lyricsSaveMutation.error.message
            : "Lyrics could not be saved."}
        </p>
      ) : null}
      {lyricsErrorMessage ? <p className="inline-error">{lyricsErrorMessage}</p> : null}
    </div>
  );
}

function LyricsEditor() {
  const {
    displayedLyrics,
    lyricsDraft,
    lyricsSaveMutation,
    projectEditLocked,
    projectSyncLockReason,
    setIsEditingLyrics,
    setLyricsDraft,
  } = useProjectViewModelContext();

  return (
    <div className="lyrics-editor">
      {displayedLyrics.map((segment, index) => (
        <label className="lyrics-editor__row" key={`${segment.start_seconds}-${index}`}>
          <span className="lyrics-editor__time">
            {hasTimedLyrics(segment) ? formatPlaybackClock(segment.start_seconds ?? 0) : "Static"}
          </span>
          <textarea
            aria-label={`Lyric segment ${index + 1}`}
            className="lyrics-editor__input"
            disabled={projectEditLocked}
            value={lyricsDraft[index] ?? ""}
            onChange={(event) => {
              const nextValue = event.currentTarget.value;
              setLyricsDraft((current) => {
                const next = displayedLyrics.map((currentSegment, valueIndex) =>
                  current[valueIndex] ?? currentSegment.text,
                );
                next[index] = nextValue;
                return next;
              });
            }}
          />
        </label>
      ))}
      <div className="button-row">
        <button
          className="button button--primary button--small"
          type="button"
          onClick={() => lyricsSaveMutation.mutate()}
          disabled={projectEditLocked || lyricsSaveMutation.isPending}
          title={projectSyncLockReason ?? undefined}
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
  );
}

function ChordsPracticePanel() {
  const {
    activeChordIndex,
    activeEnharmonicKeyContext,
    chordContextCopy,
    chordJob,
    chordSegmentRefs,
    chordTimelineRef,
    currentChord,
    displayedChords,
    enharmonicDisplayMode,
    handleSeekTo,
    hasChordTimeline,
    nextChord,
    practiceModeFallbackMessage,
    chordsPracticeStatus,
    chordsPracticeRefreshFailed,
    isMobileRuntime,
    showSupportingCopy,
  } = useProjectViewModelContext();
  const handlePracticeTargetSpacePlayback = usePracticeTargetSpacePlayback();
  const chordErrorMessage = formatJobErrorMessage(chordJob?.error_message, chordJob);

  if (chordsPracticeStatus !== "available") {
    return (
      <div className="playback-practice-body playback-practice-body--chords">
        <EmptyPracticeState
          copy={practiceLaneStateCopy("chords", chordsPracticeStatus, isMobileRuntime)}
          announce
        />
        {chordErrorMessage ? <p className="inline-error">{chordErrorMessage}</p> : null}
      </div>
    );
  }

  return (
    <div className="playback-practice-body playback-practice-body--chords">
      <div className="chord-preview-grid chord-preview-grid--hero">
        <div className="chord-card" role="group" aria-label="Current chord card">
          <span className="metric-label">Current</span>
          <strong>
            {currentChord ? (
              <MusicalChordLabel
                activeKey={activeEnharmonicKeyContext}
                fallbackLabel={currentChord.label ?? "-"}
                mode={enharmonicDisplayMode}
                bassPitchClass={currentChord.bass_pitch_class}
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
                bassPitchClass={nextChord.bass_pitch_class}
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
        <div
          className="chord-timeline chord-timeline--practice"
          role="group"
          aria-label="Chord timeline"
          ref={chordTimelineRef}
        >
          <div aria-hidden="true" className="chord-timeline__edge" />
          {displayedChords.map((segment, index) => {
            const durationWeight = Math.max(0.9, segment.end_seconds - segment.start_seconds);
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
                onClick={() => handleSeekTo(segment.start_seconds)}
                onKeyDown={(event) =>
                  handlePracticeTargetSpacePlayback(event, segment.start_seconds)
                }
              >
                <span>
                  <MusicalChordLabel
                    activeKey={activeEnharmonicKeyContext}
                    fallbackLabel={segment.label}
                    mode={enharmonicDisplayMode}
                    bassPitchClass={segment.bass_pitch_class}
                    pitchClass={segment.pitch_class}
                    quality={segment.quality}
                    variant="chord-chip"
                  />
                </span>
                <small>{formatPlaybackClock(segment.start_seconds)}</small>
              </button>
            );
          })}
          <div aria-hidden="true" className="chord-timeline__edge" />
        </div>
      ) : (
        <EmptyPracticeState copy="Generate a chord pass to jump around arrangement while you practice." />
      )}
      {hasChordTimeline && showSupportingCopy ? (
        <div className="chord-context">
          <span className="artifact-meta">Follow keeps the active chord in view while playback moves.</span>
        </div>
      ) : null}
      {practiceModeFallbackMessage ? (
        <PracticeContextMessage copy={practiceModeFallbackMessage} />
      ) : null}
      {chordsPracticeRefreshFailed ? (
        <PracticeContextMessage copy="Chords couldn’t be refreshed; showing available chords." />
      ) : null}
      {chordErrorMessage ? <p className="inline-error">{chordErrorMessage}</p> : null}
    </div>
  );
}

function CombinedLeadSheetPanel() {
  const {
    combinedLeadSheetRef,
    combinedLeadSheetRowRefs,
    combinedLeadSheetRows,
    chordsPracticeStatus,
    chordsPracticeRefreshFailed,
    displayedChords,
    displayedLyrics,
    isEditingLyrics,
    isMobileRuntime,
    lyricsJob,
    lyricsPracticeStatus,
    lyricsPracticeRefreshFailed,
    lyricsSaveMutation,
    practiceModeFallbackMessage,
    showSupportingCopy,
  } = useProjectViewModelContext();

  if (isEditingLyrics) {
    return <LyricsPracticePanel />;
  }

  const lyricsErrorMessage = formatJobErrorMessage(lyricsJob?.error_message, lyricsJob);

  return (
    <div className="playback-practice-body">
      {lyricsPracticeStatus === "available" || chordsPracticeStatus === "available" ? (
        <div
          className="lead-sheet"
          role="group"
          aria-label="Lyrics and chords lead sheet"
          ref={combinedLeadSheetRef}
        >
          <div aria-hidden="true" className="lead-sheet__edge" />
          {combinedLeadSheetRows.map((row) => (
            <LeadSheetRowView
              key={row.id}
              row={row}
              setRowRef={(element) => {
                combinedLeadSheetRowRefs.current[row.id] = element;
              }}
            />
          ))}
          <div aria-hidden="true" className="lead-sheet__edge" />
        </div>
      ) : (
        <EmptyPracticeState
          copy={combinedPracticeStateCopy(
            lyricsPracticeStatus,
            chordsPracticeStatus,
            isMobileRuntime,
          )}
          announce
        />
      )}

      {chordsPracticeStatus === "available" && lyricsPracticeStatus !== "available" ? (
        <PracticeContextMessage
          copy={partialPracticeStateCopy(
            "lyrics",
            lyricsPracticeStatus,
            "chords",
            isMobileRuntime,
          )}
        />
      ) : null}
      {lyricsPracticeStatus === "available" && chordsPracticeStatus !== "available" ? (
        <PracticeContextMessage
          copy={partialPracticeStateCopy(
            "chords",
            chordsPracticeStatus,
            "lyrics",
            isMobileRuntime,
          )}
        />
      ) : null}
      {practiceModeFallbackMessage ? (
        <PracticeContextMessage copy={practiceModeFallbackMessage} />
      ) : null}
      {lyricsPracticeRefreshFailed ? (
        <PracticeContextMessage copy="Lyrics couldn’t be refreshed; showing available lyrics." />
      ) : null}
      {chordsPracticeRefreshFailed ? (
        <PracticeContextMessage copy="Chords couldn’t be refreshed; showing available chords." />
      ) : null}
      {displayedLyrics.length > 0 && displayedChords.length > 0 && showSupportingCopy ? (
        <div className="chord-context">
          <span className="artifact-meta">
            Chords anchor to lyric word timestamps when available, then fall back to segment timing.
          </span>
        </div>
      ) : null}
      {lyricsSaveMutation.error ? (
        <p className="inline-error">
          {lyricsSaveMutation.error instanceof Error
            ? lyricsSaveMutation.error.message
            : "Lyrics could not be saved."}
        </p>
      ) : null}
      {lyricsErrorMessage ? <p className="inline-error">{lyricsErrorMessage}</p> : null}
    </div>
  );
}

function LeadSheetRowView({
  row,
  setRowRef,
}: {
  row: LeadSheetRow;
  setRowRef: (element: HTMLElement | null) => void;
}) {
  if (row.type === "chords") {
    return (
      <div
        className={`lead-sheet__row lead-sheet__row--chords${row.isActive ? " lead-sheet__row--active" : ""}`}
        ref={setRowRef}
      >
        <span className="metric-label">Instrumental</span>
        <div className="lead-sheet-chord-strip">
          {row.chords.map((chord) => (
            <LeadSheetChordButton key={chord.id} chord={chord} />
          ))}
        </div>
      </div>
    );
  }

  return <LeadSheetLyricsRowView row={row} setRowRef={setRowRef} />;
}

function LeadSheetLyricsRowView({
  row,
  setRowRef,
}: {
  row: LeadSheetLyricsRow;
  setRowRef: (element: HTMLElement | null) => void;
}) {
  const { handleSeekTo } = useProjectViewModelContext();
  const handlePracticeTargetSpacePlayback = usePracticeTargetSpacePlayback();
  const canSeek = hasTimedLyrics(row.segment);
  const wordAnchoredChords = row.chords.filter((chord) => chord.anchor.type === "word");
  const percentAnchoredChords = row.chords.filter((chord) => chord.anchor.type === "percent");
  const wordChordMap = new Map<number, LeadSheetChord[]>();
  wordAnchoredChords.forEach((chord) => {
    if (chord.anchor.type !== "word") {
      return;
    }
    const current = wordChordMap.get(chord.anchor.wordIndex) ?? [];
    current.push(chord);
    wordChordMap.set(chord.anchor.wordIndex, current);
  });

  return (
    <div
      className={`lead-sheet__row lead-sheet__row--lyrics${row.isActive ? " lead-sheet__row--active" : ""}`}
      role={canSeek ? "button" : undefined}
      tabIndex={canSeek ? 0 : undefined}
      ref={setRowRef}
      onClick={canSeek ? () => handleSeekTo(row.segment.start_seconds ?? 0) : undefined}
      onKeyDown={
        canSeek
          ? (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSeekTo(row.segment.start_seconds ?? 0);
                return;
              }
              handlePracticeTargetSpacePlayback(event, row.segment.start_seconds ?? 0);
            }
          : undefined
      }
    >
      <small>{canSeek ? formatPlaybackClock(row.segment.start_seconds ?? 0) : "Static"}</small>
      <div className="lead-sheet-lyrics-line">
        {percentAnchoredChords.length ? (
          <div className="lead-sheet-lyrics-line__floating-chords" aria-label="Timed chord markers">
            {percentAnchoredChords.map((chord) => (
              <LeadSheetChordButton key={chord.id} chord={chord} />
            ))}
          </div>
        ) : null}
        {row.segment.words?.length ? (
          <span className="lead-sheet-words">
            {row.segment.words.map((word, wordIndex) => (
              <span className="lead-sheet-word" key={`${word.text}-${word.start_seconds}-${wordIndex}`}>
                <span className="lead-sheet-word__chords">
                  {(wordChordMap.get(wordIndex) ?? []).map((chord) => (
                    <LeadSheetChordButton key={chord.id} chord={chord} />
                  ))}
                </span>
                <span className={wordIndex === row.activeWordIndex ? "lyrics-word lyrics-word--active" : "lyrics-word"}>
                  {word.text}
                </span>
              </span>
            ))}
          </span>
        ) : (
          <span className="lead-sheet-lyrics-line__text">{row.segment.text}</span>
        )}
      </div>
    </div>
  );
}

function LeadSheetChordButton({ chord }: { chord: LeadSheetChord }) {
  const {
    activeEnharmonicKeyContext,
    enharmonicDisplayMode,
    handleSeekTo,
  } = useProjectViewModelContext();
  const handlePracticeTargetSpacePlayback = usePracticeTargetSpacePlayback();
  const style =
    chord.anchor.type === "percent"
      ? ({ "--lead-sheet-chord-left": `${chord.anchor.percent}%` } as CSSProperties)
      : undefined;

  return (
    <button
      className={`lead-sheet-chord${chord.isActive ? " lead-sheet-chord--active" : ""}`}
      style={style}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        handleSeekTo(chord.segment.start_seconds);
      }}
      onKeyDown={(event) =>
        handlePracticeTargetSpacePlayback(event, chord.segment.start_seconds)
      }
    >
      <MusicalChordLabel
        activeKey={activeEnharmonicKeyContext}
        fallbackLabel={chord.segment.label}
        mode={enharmonicDisplayMode}
        bassPitchClass={chord.segment.bass_pitch_class}
        pitchClass={chord.segment.pitch_class}
        quality={chord.segment.quality}
        variant="chord-chip"
      />
    </button>
  );
}

function EmptyPracticeState({ copy, announce = false }: { copy: string; announce?: boolean }) {
  return (
    <div
      aria-atomic={announce ? "true" : undefined}
      className="chord-lane-empty playback-practice-empty"
      role={announce ? "status" : undefined}
    >
      <p className="artifact-meta">{copy}</p>
    </div>
  );
}

function PracticeContextMessage({ copy }: { copy: string }) {
  return (
    <div aria-atomic="true" className="chord-context" role="status">
      <span className="artifact-meta">{copy}</span>
    </div>
  );
}

function practiceLaneStateCopy(
  lane: "lyrics" | "chords",
  status: ReturnType<typeof useProjectViewModelContext>["lyricsPracticeStatus"],
  isMobileRuntime: boolean,
) {
  const label = lane === "lyrics" ? "Lyrics" : "Chords";
  if (status === "loading") {
    return "Loading practice data…";
  }
  if (status === "error") {
    return isMobileRuntime
      ? `${label} couldn’t be loaded on this device.`
      : `${label} couldn’t be loaded.`;
  }
  return isMobileRuntime
    ? `No ${lane} on this device. Sync them from desktop, or use available Project tools.`
    : `No ${lane} are available for this project. Use Project tools to generate them.`;
}

function partialPracticeStateCopy(
  lane: "lyrics" | "chords",
  status: ReturnType<typeof useProjectViewModelContext>["lyricsPracticeStatus"],
  visibleLane: "lyrics" | "chords",
  isMobileRuntime: boolean,
) {
  if (status === "loading") {
    return "Loading practice data…";
  }
  const label = lane === "lyrics" ? "Lyrics" : "Chords";
  if (status === "error") {
    return `${label} couldn’t be loaded; showing ${visibleLane}.`;
  }
  return isMobileRuntime
    ? `No ${lane} on this device; showing ${visibleLane}.`
    : `No ${lane} are available; showing ${visibleLane}.`;
}

function combinedPracticeStateCopy(
  lyricsStatus: ReturnType<typeof useProjectViewModelContext>["lyricsPracticeStatus"],
  chordsStatus: ReturnType<typeof useProjectViewModelContext>["chordsPracticeStatus"],
  isMobileRuntime: boolean,
) {
  if (lyricsStatus === "loading" || chordsStatus === "loading") {
    return "Loading practice data…";
  }
  if (lyricsStatus === "empty" && chordsStatus === "empty") {
    return isMobileRuntime
      ? "No lyrics or chords on this device. Sync them from desktop, or use available Project tools."
      : "No lyrics or chords are available for this project. Use Project tools to generate them.";
  }
  if (lyricsStatus === "error" && chordsStatus === "error") {
    return isMobileRuntime
      ? "Lyrics and chords couldn’t be loaded on this device."
      : "Lyrics and chords couldn’t be loaded.";
  }
  if (lyricsStatus === "error") {
    return isMobileRuntime
      ? "Lyrics couldn’t be loaded. No chords are available on this device."
      : "Lyrics couldn’t be loaded. No chords are available.";
  }
  return isMobileRuntime
    ? "Chords couldn’t be loaded. No lyrics are available on this device."
    : "Chords couldn’t be loaded. No lyrics are available.";
}
