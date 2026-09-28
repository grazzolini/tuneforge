import { Trash2 } from "lucide-react";
import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { artifactLabel, artifactSummary, fileNameFromPath, formatArtifactTimestamp } from "../projectViewUtils";

export function SourcesRail() {
  const {
    handleSelectPrimaryArtifact,
    handleSelectStemArtifact,
    handleDeleteMix,
    handleDeleteStem,
    informationDensity,
    isDeleteMixDisabled,
    isDeleteStemDisabled,
    previewArtifacts,
    projectSyncLockReason,
    selectedArtifactId,
    selectedPrimaryArtifactId,
    setDismissedStemJobIds,
    setSourcesRailCollapsed,
    showSupportingCopy,
    sourceArtifact,
    sourcesRailCollapsed,
    sourcesRailSummary,
    stemErrorMessage,
    stemDeletionError,
    stemJob,
    stemOutputLabel,
    visibleStemArtifacts,
    coarseVisibleStemArtifacts,
    drumGroup,
    drumMode,
    drumGroupExpanded,
    handleSetDrumMode,
    handleToggleDrumExpanded,
    handleDeleteDrumSplit,
    nativeDesktopRuntime,
  } = useProjectViewModelContext();
  const editLockTitle = projectSyncLockReason ?? undefined;

  return (
    <aside className={`stack sources-rail${sourcesRailCollapsed ? " sources-rail--collapsed" : ""}`}>
      <div className={`panel rail-panel${sourcesRailCollapsed ? " rail-panel--collapsed" : ""}`}>
        <div className="rail-panel__top">
          {sourcesRailCollapsed ? (
            <span className="rail-panel__collapsed-spacer" aria-hidden="true" />
          ) : (
            <div className="rail-panel__identity">
              <h2>Sources</h2>
              {showSupportingCopy ? (
                <p className="subpanel__copy">Jump between the raw track, saved mixes, and stems.</p>
              ) : null}
            </div>
          )}
          <button
            aria-label={sourcesRailCollapsed ? "Expand sources rail" : "Collapse sources rail"}
            className={`button button--ghost button--small rail-panel__toggle${
              sourcesRailCollapsed ? " rail-panel__toggle--collapsed" : ""
            }`}
            onClick={() => setSourcesRailCollapsed((current) => !current)}
            type="button"
          >
            <span aria-hidden="true" className="rail-panel__toggle-icon">
              <span />
              <span />
              <span />
            </span>
            {sourcesRailCollapsed ? null : <span>Hide</span>}
          </button>
        </div>

        {sourcesRailCollapsed ? (
          <div className="rail-panel__collapsed">
            {sourcesRailSummary.map((item) => (
              <div key={item.label} className="rail-summary-chip">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="rail-section">
              <div
                className="artifact-selector artifact-selector--stacked"
                role="group"
                aria-label="Source and mix list"
              >
                {sourceArtifact ? (
                  <button
                    className={`artifact-pill${
                      selectedArtifactId === sourceArtifact.id ? " artifact-pill--active" : ""
                    }`}
                    onClick={() => handleSelectPrimaryArtifact(sourceArtifact)}
                    type="button"
                  >
                    <span className="artifact-pill__title">Source Track</span>
                    <span className="artifact-pill__meta">{artifactSummary(sourceArtifact)}</span>
                    {informationDensity === "detailed" ? (
                      <span className="artifact-pill__meta">{fileNameFromPath(sourceArtifact.path)}</span>
                    ) : null}
                  </button>
                ) : (
                  <p className="artifact-meta">No source track available.</p>
                )}
              </div>
            </div>

            <div className="rail-section">
              <div className="rail-section__header">
                <div>
                  <h3>Saved Mixes</h3>
                  {showSupportingCopy ? (
                    <p className="subpanel__copy">Practice variants stay one click away.</p>
                  ) : null}
                </div>
              </div>
              {previewArtifacts.length ? (
                <div
                  className="artifact-selector artifact-selector--stacked"
                  role="group"
                  aria-label="Saved mix list"
                >
                  {previewArtifacts.map((artifact) => (
                    <div className="artifact-action-row" key={artifact.id}>
                      <button
                        className={`artifact-pill${
                          selectedArtifactId === artifact.id ? " artifact-pill--active" : ""
                        }`}
                        onClick={() => handleSelectPrimaryArtifact(artifact)}
                        type="button"
                      >
                        <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                        <span className="artifact-pill__meta">
                          {artifactSummary(artifact) || formatArtifactTimestamp(artifact.created_at)}
                        </span>
                        {informationDensity === "detailed" ? (
                          <span className="artifact-pill__meta">
                            {formatArtifactTimestamp(artifact.created_at)}
                          </span>
                        ) : null}
                      </button>
                      <button
                        aria-label="Delete saved mix"
                        className="button button--ghost button--small artifact-action-row__delete"
                        disabled={isDeleteMixDisabled || artifact.can_delete === false}
                        onClick={() => void handleDeleteMix(artifact)}
                        title={editLockTitle ?? "Delete saved mix"}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" className="artifact-action-row__delete-icon" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="artifact-meta">No saved mixes yet. Build one from inspector controls.</p>
              )}
            </div>

            <div className="rail-section">
              <div className="rail-section__header">
                <div>
                  <h3>Stems</h3>
                  {showSupportingCopy ? (
                    <p className="subpanel__copy">Stem playback stays scoped to the selected source or mix.</p>
                  ) : null}
                </div>
              </div>
              {visibleStemArtifacts.length ? (
                <div
                  className="artifact-selector artifact-selector--stacked"
                  role="group"
                  aria-label="Stem track list"
                >
                  {coarseVisibleStemArtifacts.map((artifact) => (
                    <div className="stem-group" key={artifact.id}>
                    <div className="artifact-action-row">
                      <button
                        className={`artifact-pill${
                          selectedArtifactId === artifact.id ? " artifact-pill--active" : ""
                        }`}
                        onClick={() => handleSelectStemArtifact(artifact)}
                        type="button"
                      >
                        <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                        <span className="artifact-pill__meta">{stemOutputLabel(artifact.id)}</span>
                        {informationDensity !== "minimal" ? (
                          <span className="artifact-pill__meta">{artifactSummary(artifact)}</span>
                        ) : null}
                      </button>
                      <button
                        aria-label="Delete stem track"
                        className="button button--ghost button--small artifact-action-row__delete"
                        disabled={isDeleteStemDisabled || artifact.can_delete === false}
                        onClick={() => void handleDeleteStem(artifact)}
                        title={editLockTitle ?? "Delete stem track"}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" className="artifact-action-row__delete-icon" />
                      </button>
                    </div>
                    {artifact.type === "drums_stem" && drumGroup ? (
                      <div className="stem-group__details">
                        <div className="stem-group__actions">
                          {drumGroup.children.length ? <button
                            aria-expanded={drumGroupExpanded}
                            className="button button--ghost button--small"
                            onClick={handleToggleDrumExpanded}
                            type="button"
                          >{drumGroupExpanded ? "Hide Parts" : "Show Parts"}</button> : null}
                          <div className="button-row" role="group" aria-label="Drums playback mode">
                            <button aria-pressed={drumMode === "original"} className={`chip${drumMode === "original" ? " chip--active" : ""}`}
                              onClick={() => handleSetDrumMode("original")} type="button">Original</button>
                            <button aria-pressed={drumMode === "split"} className={`chip${drumMode === "split" ? " chip--active" : ""}`}
                              disabled={!nativeDesktopRuntime || !drumGroup.splitAvailable}
                              onClick={() => handleSetDrumMode("split")} type="button">Split</button>
                          </div>
                        </div>
                        {drumGroup.children.length ? (
                          <div className="stem-group__summary">
                            <span className="artifact-meta">{drumGroup.includedChildren.length} of 4 parts</span>
                            <button className="button button--ghost button--small"
                              disabled={isDeleteStemDisabled}
                              onClick={() => void handleDeleteDrumSplit()} type="button">Delete parts</button>
                          </div>
                        ) : null}
                        {drumGroup.recoveryNeeded ? (
                          <p className="artifact-meta">Refinement unavailable; check files or rebuild.</p>
                        ) : null}
                        {drumGroupExpanded ? drumGroup.includedChildren.map((child) => (
                          <div className="artifact-action-row stem-group__child" key={child.id}>
                            <button className="artifact-pill" onClick={() => void handleSelectStemArtifact(child)} type="button">
                              <span className="artifact-pill__title">{artifactLabel(child)}</span>
                              <span className="artifact-pill__meta">{stemOutputLabel(child.id)}</span>
                            </button>
                            <button aria-label={`Delete ${artifactLabel(child)} part`}
                              className="button button--ghost button--small artifact-action-row__delete"
                              disabled={isDeleteStemDisabled}
                              onClick={() => void handleDeleteStem(child)} type="button">
                              <Trash2 aria-hidden="true" className="artifact-action-row__delete-icon" />
                            </button>
                          </div>
                        )) : null}
                      </div>
                    ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="artifact-meta">
                  {selectedPrimaryArtifactId
                    ? "No stems yet for selected audio."
                    : "Select source audio or a saved mix first."}
                </p>
              )}
              {stemErrorMessage && stemJob ? (
                <div className="button-row" role="group" aria-label="Stem error">
                  <span className="inline-error">{stemErrorMessage}</span>
                  <button
                    className="button button--ghost button--small"
                    onClick={() =>
                      setDismissedStemJobIds((current) =>
                        current.includes(stemJob.id) ? current : [...current, stemJob.id],
                      )
                    }
                    type="button"
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
              {stemDeletionError ? <p className="inline-error" role="alert">{stemDeletionError}</p> : null}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
