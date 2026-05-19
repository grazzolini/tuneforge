import { Link } from "react-router-dom";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function ProjectHeader() {
  const {
    activeWorkspace,
    draftName,
    isRenaming,
    projectEditLocked,
    projectQuery,
    projectSyncLockReason,
    projectSyncSummary,
    renameMutation,
    setDraftName,
    setIsRenaming,
    showSupportingCopy,
  } = useProjectViewModelContext();
  const showSyncStatus = !projectSyncSummary.isLocal || projectSyncSummary.isLocked;
  const syncReason = projectSyncLockReason ? ` ${projectSyncLockReason}` : "";

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
