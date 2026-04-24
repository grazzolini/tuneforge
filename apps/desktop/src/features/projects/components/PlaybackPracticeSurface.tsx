import type { CSSProperties } from "react";
import { MusicalChordLabel } from "../../../components/MusicalLabel";
import type { LeadSheetChord, LeadSheetLyricsRow, LeadSheetRow } from "../projectViewUtils";
import {
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

function PlaybackModeHeader() {
  const {
    chordsFollowEnabled,
    displayedLyrics,
    handleSetChordsFollowEnabled,
    handleSetLyricsFollowEnabled,
    handleTogglePlaybackDisplayLane,
    hasLyricsTranscript,
    isEditingLyrics,
    isLyricsRunning,
    lyricsFollowEnabled,
    setLyricsDraft,
    lyricsMutation,
    playbackDisplayMode,
    setIsEditingLyrics,
  } = useProjectViewModelContext();
  const lyricsSelected = playbackDisplayMode === "lyrics" || playbackDisplayMode === "combined";
  const chordsSelected = playbackDisplayMode === "chords" || playbackDisplayMode === "combined";

  return (
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
                setLyricsDraft(displayedLyrics.map((segment) => segment.text));
                setIsEditingLyrics(true);
              }}
              disabled={lyricsMutation.isPending || isLyricsRunning}
            >
              Edit Lyrics
            </button>
          ) : null}
          {lyricsSelected ? (
            <>
              <button
                aria-pressed={lyricsFollowEnabled}
                className={`chip playback-follow-chip${lyricsFollowEnabled ? " chip--active" : ""}`}
                onClick={() => handleSetLyricsFollowEnabled(!lyricsFollowEnabled)}
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
  );
}

function LyricsPracticePanel() {
  const {
    activeLyricsIndex,
    activeLyricsWordIndex,
    displayedLyrics,
    handleSeekTo,
    hasLyricsTranscript,
    hasTimedLyricsTranscript,
    isEditingLyrics,
    lyricsJob,
    lyricsSaveMutation,
    lyricsSegmentRefs,
    lyricsTheaterRef,
    pauseLyricsFollow,
    showSupportingCopy,
  } = useProjectViewModelContext();

  if (isEditingLyrics) {
    return <LyricsEditor />;
  }

  return (
    <div className="playback-practice-body">
      {hasLyricsTranscript ? (
        <div
          className="lyrics-theater lyrics-theater--practice"
          role="group"
          aria-label="Lyrics transcript"
          ref={lyricsTheaterRef}
          onPointerDownCapture={pauseLyricsFollow}
          onTouchMove={pauseLyricsFollow}
          onWheel={pauseLyricsFollow}
        >
          <div aria-hidden="true" className="lyrics-theater__edge" />
          {displayedLyrics.map((segment, index) => {
            const isActive = index === activeLyricsIndex;
            const referenceIndex = activeLyricsIndex >= 0 ? activeLyricsIndex : -999;
            const distance = Math.abs(index - referenceIndex);
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
            const distanceClass =
              distance === 0
                ? " lyrics-theater__segment--active"
                : distance === 1
                  ? " lyrics-theater__segment--near"
                  : distance === 2
                    ? " lyrics-theater__segment--far"
                    : " lyrics-theater__segment--distant";

            if (canSeek) {
              return (
                <button
                  key={segmentKey}
                  className={`lyrics-segment lyrics-theater__segment${distanceClass}`}
                  type="button"
                  ref={(element) => {
                    lyricsSegmentRefs.current[segmentKey] = element;
                  }}
                  onClick={() => handleSeekTo(segment.start_seconds ?? 0)}
                >
                  <small>{formatPlaybackClock(segment.start_seconds ?? 0)}</small>
                  {content}
                </button>
              );
            }

            return (
              <div
                key={segmentKey}
                className={`lyrics-segment lyrics-segment--static lyrics-theater__segment${distanceClass}`}
              >
                <small>Static</small>
                {content}
              </div>
            );
          })}
          <div aria-hidden="true" className="lyrics-theater__edge" />
        </div>
      ) : (
        <EmptyPracticeState copy="Generate a lyrics pass to keep transcription and playback together while you practice." />
      )}

      {hasLyricsTranscript && !hasTimedLyricsTranscript ? (
        <div className="chord-context">
          <span className="artifact-meta">This transcript has no timing data, so follow mode stays static.</span>
        </div>
      ) : null}
      {hasTimedLyricsTranscript && showSupportingCopy ? (
        <div className="chord-context">
          <span className="artifact-meta">Scroll inside lyrics to pause follow. Seek or play resumes it.</span>
        </div>
      ) : null}
      {lyricsSaveMutation.error ? (
        <p className="inline-error">
          {lyricsSaveMutation.error instanceof Error
            ? lyricsSaveMutation.error.message
            : "Lyrics could not be saved."}
        </p>
      ) : null}
      {lyricsJob?.error_message ? <p className="inline-error">{lyricsJob.error_message}</p> : null}
    </div>
  );

}

function LyricsEditor() {
  const {
    displayedLyrics,
    lyricsDraft,
    lyricsSaveMutation,
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
    pauseChordsFollow,
    showSupportingCopy,
  } = useProjectViewModelContext();

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
        <div
          className="chord-timeline chord-timeline--practice"
          role="group"
          aria-label="Chord timeline"
          ref={chordTimelineRef}
          onPointerDownCapture={pauseChordsFollow}
          onWheel={pauseChordsFollow}
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
          <div aria-hidden="true" className="chord-timeline__edge" />
        </div>
      ) : (
        <EmptyPracticeState copy="Generate a chord pass to jump around arrangement while you practice." />
      )}
      {hasChordTimeline && showSupportingCopy ? (
        <div className="chord-context">
          <span className="artifact-meta">Scroll inside chords to pause follow. Seek or play resumes it.</span>
        </div>
      ) : null}
      {chordJob?.error_message ? <p className="inline-error">{chordJob.error_message}</p> : null}
    </div>
  );
}

function CombinedLeadSheetPanel() {
  const {
    combinedLeadSheetRef,
    combinedLeadSheetRowRefs,
    combinedLeadSheetRows,
    displayedChords,
    displayedLyrics,
    hasChordTimeline,
    hasLyricsTranscript,
    isEditingLyrics,
    lyricsJob,
    lyricsSaveMutation,
    pauseLyricsFollow,
    showSupportingCopy,
  } = useProjectViewModelContext();

  if (isEditingLyrics) {
    return <LyricsPracticePanel />;
  }

  return (
    <div className="playback-practice-body">
      {hasLyricsTranscript || hasChordTimeline ? (
        <div
          className="lead-sheet"
          role="group"
          aria-label="Lyrics and chords lead sheet"
          ref={combinedLeadSheetRef}
          onPointerDownCapture={pauseLyricsFollow}
          onTouchMove={pauseLyricsFollow}
          onWheel={pauseLyricsFollow}
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
        <EmptyPracticeState copy="Generate lyrics and chords to build a timed lead sheet." />
      )}

      {!hasLyricsTranscript && hasChordTimeline ? (
        <div className="chord-context">
          <span className="artifact-meta">Lyrics are missing, so combined mode shows chord rows only.</span>
        </div>
      ) : null}
      {hasLyricsTranscript && !hasChordTimeline ? (
        <div className="chord-context">
          <span className="artifact-meta">Chords are missing, so combined mode shows lyrics only.</span>
        </div>
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
      {lyricsJob?.error_message ? <p className="inline-error">{lyricsJob.error_message}</p> : null}
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
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleSeekTo(row.segment.start_seconds ?? 0);
              }
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
    >
      <MusicalChordLabel
        activeKey={activeEnharmonicKeyContext}
        fallbackLabel={chord.segment.label}
        mode={enharmonicDisplayMode}
        pitchClass={chord.segment.pitch_class}
        quality={chord.segment.quality}
        variant="chord-chip"
      />
    </button>
  );
}

function EmptyPracticeState({ copy }: { copy: string }) {
  return (
    <div className="chord-lane-empty playback-practice-empty">
      <p className="artifact-meta">{copy}</p>
    </div>
  );
}
