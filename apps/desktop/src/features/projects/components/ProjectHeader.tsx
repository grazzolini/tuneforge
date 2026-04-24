import { Link } from "react-router-dom";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function ProjectHeader() {
  const {
    activeWorkspace,
    draftName,
    hasTransformChange,
    inspectorOpen,
    isRenaming,
    previewMutation,
    projectQuery,
    renameMutation,
    setDraftName,
    setInspectorOpen,
    setIsRenaming,
    showSupportingCopy,
  } = useProjectViewModelContext();

  return (
    <div className={`screen__header${activeWorkspace === "playback" ? " screen__header--compact" : ""}`}>
      <div className="screen__title-block">
    <p className="eyebrow">
      <Link to="/">Library</Link> / Project
    </p>
    {isRenaming ? (
      <div className="title-edit">
        <input
      aria-label="Project name"
      className="title-input"
      value={draftName}
      onChange={(event) => setDraftName(event.target.value)}
        />
        <div className="button-row">
      <button
        className="button button--primary button--small"
        type="button"
        onClick={() => renameMutation.mutate()}
        disabled={renameMutation.isPending || !draftName.trim()}
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
        <button
      className="button button--ghost button--small"
      type="button"
      onClick={() => setIsRenaming(true)}
        >
      Rename
        </button>
      </div>
    )}
    {showSupportingCopy && activeWorkspace === "project" ? (
      <p className="screen__subtitle">
        Move between project tools and playback workspace without losing transport context.
      </p>
    ) : null}
      </div>

      {activeWorkspace === "project" ? (
        <div className="button-row">
          <button
            className="button button--primary"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !hasTransformChange}
          >
            {previewMutation.isPending ? "Queueing..." : "Create Mix"}
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => setInspectorOpen((current) => !current)}
          >
            {inspectorOpen ? "Hide Inspector" : "Show Inspector"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
