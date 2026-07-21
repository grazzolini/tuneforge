import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, MoreVertical, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

const OVERFLOW_HISTORY_KEY = "tuneforgePlaybackOverflow";

export function ProjectHeader({
  onOpenPracticeControls,
}: {
  onOpenPracticeControls: () => void;
}) {
  const {
    activeWorkspace,
    displayedLyrics,
    draftName,
    handleOpenTabImport,
    handleSetPlaybackDisplayMode,
    handleSelectWorkspace,
    hasLyricsTranscript,
    isLyricsRunning,
    isMobileRuntime,
    isRenaming,
    lyricsMutation,
    projectEditLocked,
    projectQuery,
    projectSyncLockReason,
    projectSyncSummary,
    renameMutation,
    setDraftName,
    setIsEditingLyrics,
    setIsRenaming,
    setLyricsDraft,
    showSupportingCopy,
  } = useProjectViewModelContext();
  const showSyncStatus = projectSyncSummary.showBadge;
  const syncReason = projectSyncLockReason ? ` ${projectSyncLockReason}` : "";
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowHistoryMarkerRef = useRef(`playback-overflow-${crypto.randomUUID()}`);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);

  const dismissOverflowFromUi = useCallback((restoreFocus = true) => {
    setOverflowOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => overflowTriggerRef.current?.focus(), 0);
    }
    if (
      window.history.state?.[OVERFLOW_HISTORY_KEY] === overflowHistoryMarkerRef.current
    ) {
      window.history.back();
    }
  }, []);

  useEffect(() => {
    if (!overflowOpen) {
      return;
    }
    const marker = overflowHistoryMarkerRef.current;
    window.history.pushState(
      { ...window.history.state, [OVERFLOW_HISTORY_KEY]: marker },
      "",
      window.location.href,
    );
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !overflowRef.current?.contains(event.target)) {
        dismissOverflowFromUi();
      }
    };
    const handlePopState = () => {
      setOverflowOpen(false);
      window.setTimeout(() => overflowTriggerRef.current?.focus(), 0);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      dismissOverflowFromUi();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissOverflowFromUi, overflowOpen]);

  if (isMobileRuntime && activeWorkspace === "playback") {
    return (
      <header className="screen__header screen__header--project screen__header--compact mobile-playback-app-bar">
        <Link
          aria-label="Back to Library"
          className="button button--ghost button--small mobile-playback-app-bar__back"
          to="/"
        >
          <ArrowLeft aria-hidden="true" />
        </Link>
        <div className="mobile-playback-app-bar__identity">
          <p className="eyebrow">Playback</p>
          <h1 title={projectQuery.data?.display_name ?? "Project"}>
            {projectQuery.data?.display_name ?? "Project"}
          </h1>
          {showSyncStatus ? (
            <span
              aria-label={`Sync status: ${projectSyncSummary.label}.${syncReason}`}
              className={`sync-status-badge sync-status-badge--${projectSyncSummary.state}`}
              title={projectSyncLockReason ?? undefined}
            >
              {projectSyncSummary.label}
            </span>
          ) : null}
          {projectSyncLockReason ? (
            <p className="project-sync-lock-reason" role="status">
              {projectSyncLockReason}
            </p>
          ) : null}
        </div>
        <div className="mobile-playback-app-bar__actions">
          <button
            aria-label="Open Practice Controls"
            className="button button--ghost button--small mobile-playback-app-bar__practice-controls"
            onClick={onOpenPracticeControls}
            type="button"
          >
            <SlidersHorizontal aria-hidden="true" />
            <span>Practice Controls</span>
          </button>
          <div className="mobile-playback-overflow" ref={overflowRef}>
            <button
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              aria-label="More playback actions"
              className="button button--ghost button--small mobile-playback-overflow__trigger"
              onClick={() => {
                if (overflowOpen) {
                  dismissOverflowFromUi();
                } else {
                  setOverflowOpen(true);
                }
              }}
              ref={overflowTriggerRef}
              type="button"
            >
              <MoreVertical aria-hidden="true" />
            </button>
            {overflowOpen ? (
              <div
                aria-label="Playback actions"
                className="mobile-playback-overflow__menu"
                role="menu"
              >
                <button
                  onClick={() => {
                    dismissOverflowFromUi(false);
                    handleSelectWorkspace("project");
                  }}
                  role="menuitem"
                  type="button"
                >
                  Project workspace
                </button>
                {hasLyricsTranscript ? (
                  <button
                    disabled={projectEditLocked || lyricsMutation.isPending || isLyricsRunning}
                    onClick={() => {
                      if (projectEditLocked) {
                        return;
                      }
                      handleSetPlaybackDisplayMode("lyrics");
                      setLyricsDraft(displayedLyrics.map((segment) => segment.text));
                      setIsEditingLyrics(true);
                      dismissOverflowFromUi(false);
                    }}
                    role="menuitem"
                    title={projectSyncLockReason ?? undefined}
                    type="button"
                  >
                    Edit Lyrics
                  </button>
                ) : null}
                <button
                  disabled={projectEditLocked}
                  onClick={() => {
                    dismissOverflowFromUi(false);
                    handleOpenTabImport();
                  }}
                  role="menuitem"
                  title={projectSyncLockReason ?? undefined}
                  type="button"
                >
                  Import Tab
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
    );
  }

  return (
    <div
      className={`screen__header screen__header--project${
        activeWorkspace === "playback" ? " screen__header--compact" : ""
      }`}
    >
      <div className="screen__title-block">
        <p className="eyebrow">
          <Link to="/">Library</Link> / Project
        </p>
        {isRenaming ? (
          <div className="title-edit">
            <input
              aria-label="Project name"
              className="title-input"
              disabled={projectEditLocked || renameMutation.isPending}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
            />
            <div className="button-row">
              <button
                className="button button--primary button--small"
                type="button"
                onClick={() => renameMutation.mutate()}
                disabled={projectEditLocked || renameMutation.isPending || !draftName.trim()}
              >
                {renameMutation.isPending ? "Saving..." : "Save"}
              </button>
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => {
                  setIsRenaming(false);
                  setDraftName(projectQuery.data?.display_name ?? "");
                }}
                disabled={renameMutation.isPending}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="title-row">
            <h1>{projectQuery.data?.display_name ?? "Project"}</h1>
            {showSyncStatus ? (
              <span
                aria-label={`Sync status: ${projectSyncSummary.label}.${syncReason}`}
                className={`sync-status-badge sync-status-badge--${projectSyncSummary.state}`}
                title={projectSyncLockReason ?? undefined}
              >
                {projectSyncSummary.label}
              </span>
            ) : null}
            <button
              className="button button--ghost button--small"
              type="button"
              onClick={() => setIsRenaming(true)}
              disabled={projectEditLocked}
            >
              Rename
            </button>
          </div>
        )}
        {projectSyncLockReason ? (
          <p className="project-sync-lock-reason" role="status">
            {projectSyncLockReason}
          </p>
        ) : null}
        {showSupportingCopy && activeWorkspace === "project" ? (
          <p className="screen__subtitle">
            Move between project tools and playback workspace without losing transport context.
          </p>
        ) : null}
      </div>
    </div>
  );
}
