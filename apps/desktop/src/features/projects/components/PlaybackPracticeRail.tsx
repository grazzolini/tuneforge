import {
  artifactLabel,
  artifactSummary,
  formatArtifactTimestamp,
} from "../projectViewUtils";
import { TargetKeySelector } from "./TargetKeySelector";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function PlaybackPracticeRail() {
  const {
    capoKey,
    capoOptionRefs,
    capoSelectionSummary,
    capoSelectorOpen,
    capoSelectorRef,
    capoSemitones,
    capoShiftSummary,
    enharmonicDisplayMode,
    handleSelectPrimaryArtifact,
    handleSelectStemArtifact,
    higherCapoPreview,
    higherTargetShiftOptions,
    informationDensity,
    isStemPlayback,
    lowerCapoPreview,
    lowerTargetShiftOptions,
    previewArtifacts,
    selectedArtifactId,
    selectedArtifactTimestamp,
    selectedPlaybackArtifact,
    selectedPrimaryArtifact,
    setCapoSelectorOpen,
    setCapoTransposeSemitones,
    sourceArtifact,
    sourceKey,
    stageModeLabel,
    stageSummary,
    stageTitle,
    stemControls,
    stemOutputLabel,
    toggleStemControl,
    visibleStemArtifacts,
  } = useProjectViewModelContext();
  const showHeaderDetails =
    informationDensity === "detailed" || selectedPlaybackArtifact?.type !== "source_audio";

  return (
    <aside className="panel playback-practice-rail">
      <div className="playback-practice-rail__header">
        <p className="metric-label">Playback</p>
        <h2>{stageTitle}</h2>
        {showHeaderDetails ? <p className="artifact-meta">{stageSummary}</p> : null}
        {showHeaderDetails ? (
          <div className="playback-workspace__summary-meta playback-workspace__summary-meta--inline">
            <span>{stageModeLabel}</span>
            {selectedArtifactTimestamp ? <span>{selectedArtifactTimestamp}</span> : null}
            {selectedPlaybackArtifact ? (
              <span>
                {artifactSummary(selectedPlaybackArtifact) ||
                  formatArtifactTimestamp(selectedPlaybackArtifact.created_at)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="playback-capo-control">
        <TargetKeySelector
          currentKey={capoKey}
          currentMeta={capoSelectionSummary}
          enharmonicDisplayMode={enharmonicDisplayMode}
          headingLabel="Transpose / Capo"
          higherButtonLabel="Raise capo shift"
          higherPreview={higherCapoPreview}
          higherTargetShiftOptions={higherTargetShiftOptions}
          isOpen={capoSelectorOpen}
          listboxLabel="Capo shift options"
          lowerButtonLabel="Lower capo shift"
          lowerPreview={lowerCapoPreview}
          lowerTargetShiftOptions={lowerTargetShiftOptions}
          optionRefs={capoOptionRefs}
          selectorLabel="Capo Shift"
          selectorRef={capoSelectorRef}
          setIsOpen={setCapoSelectorOpen}
          setSemitones={setCapoTransposeSemitones}
          showCompactControls
          sourceKey={sourceKey}
          value={capoSemitones}
        />
        <p className="artifact-meta playback-capo-control__summary">{capoShiftSummary}</p>
      </section>

      <section className="playback-picker-group playback-picker-group--compact">
        <div className="playback-picker-group__header">
          <div>
            <p className="metric-label">Source and Mixes</p>
            <h3>Base</h3>
          </div>
        </div>
        <div className="artifact-selector" role="group" aria-label="Playback source and mix list">
          {sourceArtifact ? (
            <button
              className={`artifact-pill${
                selectedPrimaryArtifact?.id === sourceArtifact.id ? " artifact-pill--active" : ""
              }`}
              onClick={() => handleSelectPrimaryArtifact(sourceArtifact)}
              type="button"
            >
              <span className="artifact-pill__title">Source Track</span>
              <span className="artifact-pill__meta">{artifactSummary(sourceArtifact)}</span>
            </button>
          ) : null}
          {previewArtifacts.map((artifact) => (
            <button
              key={artifact.id}
              className={`artifact-pill${
                selectedPrimaryArtifact?.id === artifact.id ? " artifact-pill--active" : ""
              }`}
              onClick={() => handleSelectPrimaryArtifact(artifact)}
              type="button"
            >
              <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
              <span className="artifact-pill__meta">
                {artifactSummary(artifact) || formatArtifactTimestamp(artifact.created_at)}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="playback-picker-group playback-picker-group--compact playback-picker-group--stems">
        <div className="playback-picker-group__header">
          <div>
            <p className="metric-label">Stem Practice</p>
            <h3>Stems</h3>
          </div>
        </div>

        {visibleStemArtifacts.length ? (
          <>
            <div className="button-row">
              <button
                aria-pressed={!isStemPlayback}
                className={`chip${!isStemPlayback ? " chip--active" : ""}`}
                onClick={() => {
                  if (selectedPrimaryArtifact) {
                    handleSelectPrimaryArtifact(selectedPrimaryArtifact);
                  }
                }}
                type="button"
              >
                Full Mix
              </button>
            </div>

            <div className="playback-stem-grid playback-stem-grid--compact" role="group" aria-label="Playback stem list">
              {visibleStemArtifacts.map((artifact) => {
                const state = stemControls[artifact.id] ?? { muted: false, solo: false };
                return (
                  <div className="playback-stem-card" key={artifact.id}>
                    <button
                      className={`artifact-pill${
                        selectedArtifactId === artifact.id ? " artifact-pill--active" : ""
                      }`}
                      onClick={() => void handleSelectStemArtifact(artifact)}
                      type="button"
                    >
                      <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                      <span className="artifact-pill__meta">{stemOutputLabel(artifact.id)}</span>
                    </button>
                    <div className="playback-stem-card__controls">
                      <button
                        className={`chip${state.muted ? " chip--active" : ""}`}
                        aria-label={`Mute ${artifactLabel(artifact)}`}
                        aria-pressed={state.muted}
                        onClick={() => toggleStemControl(artifact, "muted")}
                        type="button"
                      >
                        Mute
                      </button>
                      <button
                        className={`chip${state.solo ? " chip--active" : ""}`}
                        aria-label={`Solo ${artifactLabel(artifact)}`}
                        aria-pressed={state.solo}
                        onClick={() => toggleStemControl(artifact, "solo")}
                        type="button"
                      >
                        Solo
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="artifact-meta">
            Generate stems from Project workspace for source track or selected mix.
          </p>
        )}
      </section>
    </aside>
  );
}
