import { Trash2 } from "lucide-react";
import { artifactLabel } from "../projectViewUtils";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function VocalStemGroupControls({ playback }: { playback: boolean }) {
  const {
    vocalGroup, vocalMode, vocalGroupExpanded, handleToggleVocalExpanded, handleSetVocalMode,
    handleDeleteVocalSplit, handleDeleteStem, isDeleteStemDisabled, handleSelectStemArtifact, isMobileRuntime,
  } = useProjectViewModelContext();
  if (!vocalGroup || (!vocalGroup.children.length && !vocalGroup.recoveryNeeded)) return null;
  return (
    <div className="stem-group__details">
      <div className="stem-group__actions">
        {vocalGroup.includedChildren.length ? (
          <button
            aria-expanded={vocalGroupExpanded}
            className="button button--ghost button--small"
            onClick={handleToggleVocalExpanded}
            type="button"
          >{vocalGroupExpanded ? "Hide Parts" : "Show Parts"}</button>
        ) : null}
        <div className="button-row" role="group" aria-label="Vocals playback mode">
          <button aria-pressed={vocalMode === "original"} className={`chip${vocalMode === "original" ? " chip--active" : ""}`}
            onClick={() => handleSetVocalMode("original", playback)} type="button">Original</button>
          <button aria-pressed={vocalMode === "split"} className={`chip${vocalMode === "split" ? " chip--active" : ""}`}
            disabled={!vocalGroup.splitAvailable} onClick={() => handleSetVocalMode("split", playback)} type="button">Split</button>
        </div>
      </div>
      {vocalGroup.recoveryNeeded ? (
        <p className="artifact-meta">Vocal split unavailable. Check the synced files or rebuild on desktop.</p>
      ) : null}
      {!playback && vocalGroup.children.length > 0 && !isMobileRuntime ? (
        <div className="stem-group__summary">
          <button className="button button--ghost button--small" disabled={isDeleteStemDisabled}
            onClick={() => void handleDeleteVocalSplit()} type="button">Delete vocal parts</button>
        </div>
      ) : null}
      {!playback && vocalGroupExpanded ? vocalGroup.includedChildren.map((child) => (
        <div className="artifact-action-row stem-group__child" key={child.id}>
          <button className="artifact-pill" disabled={vocalMode !== "split"}
            onClick={() => void handleSelectStemArtifact(child)} type="button">
            <span className="artifact-pill__title">{artifactLabel(child)}</span>
          </button>
          <button aria-label={`Delete ${artifactLabel(child)} vocal part`}
            className="button button--ghost button--small artifact-action-row__delete"
            disabled={isDeleteStemDisabled || child.can_delete === false}
            onClick={() => void handleDeleteStem(child)} type="button">
            <Trash2 aria-hidden="true" className="artifact-action-row__delete-icon" />
          </button>
        </div>
      )) : null}
    </div>
  );
}
