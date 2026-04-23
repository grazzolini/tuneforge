import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { artifactLabel, artifactSummary, fileNameFromPath, formatArtifactTimestamp } from "../projectViewUtils";

export function SourcesRail() {
  const {
    handleSelectPrimaryArtifact,
    handleSelectStemArtifact,
    handleStemAction,
    hasVisibleStems,
    informationDensity,
    isStemRunning,
    previewArtifacts,
    selectedArtifactId,
    selectedPrimaryArtifactId,
    setDismissedStemJobIds,
    setSourcesRailCollapsed,
    showSupportingCopy,
    sourceArtifact,
    sourcesRailCollapsed,
    sourcesRailSummary,
    stemErrorMessage,
    stemJob,
    stemMutation,
    stemOutputLabel,
    visibleStemArtifacts,
  } = useProjectViewModelContext();

  return (
      <aside className={`stack sources-rail${sourcesRailCollapsed ? " sources-rail--collapsed" : ""}`}>
    <div className={`panel rail-panel${sourcesRailCollapsed ? " rail-panel--collapsed" : ""}`}>
      <div className="rail-panel__top">
        {sourcesRailCollapsed ? <span className="rail-panel__collapsed-spacer" aria-hidden="true" /> : (
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
              <span className="artifact-pill__meta">
                {artifactSummary(sourceArtifact)}
              </span>
              {informationDensity === "detailed" ? (
                <span className="artifact-pill__meta">
                  {fileNameFromPath(sourceArtifact.path)}
                </span>
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
              <button
                key={artifact.id}
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
          <button
            className="button button--small"
            onClick={() => void handleStemAction()}
            disabled={stemMutation.isPending || isStemRunning || !selectedPrimaryArtifactId}
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
        {visibleStemArtifacts.length ? (
          <div
            className="artifact-selector artifact-selector--stacked"
            role="group"
            aria-label="Stem track list"
          >
            {visibleStemArtifacts.map((artifact) => (
              <button
                key={artifact.id}
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
      </div>
        </>
      )}
    </div>
      </aside>
  );
}
