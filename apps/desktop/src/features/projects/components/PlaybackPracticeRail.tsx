import { ArrowUpDown, AudioLines, Drumstick, Layers } from "lucide-react";
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
    capoSourceKey,
    enharmonicDisplayMode,
    handleSelectPrimaryArtifact,
    handleSelectStemArtifact,
    higherCapoPreview,
    higherCapoShiftOptions,
    handleSetPrecountClickCount,
    handleSetPrecountEnabled,
    informationDensity,
    isStemPlayback,
    lowerCapoPreview,
    lowerCapoShiftOptions,
    precountClickCount,
    precountDisabledReason,
    precountEnabled,
    precountMaxClickCount,
    precountMinClickCount,
    precountTempoBpm,
    canUsePrecount,
    previewArtifacts,
    selectedArtifactId,
    selectedArtifactTimestamp,
    selectedPlaybackArtifact,
    selectedPrimaryArtifact,
    setCapoSelectorOpen,
    setCapoTransposeSemitones,
    sourceArtifact,
    stageModeLabel,
    stageSummary,
    stageTitle,
    stemControls,
    stemOutputLabel,
    toggleStemControl,
    visibleStemArtifacts,
  } = useProjectViewModelContext();
  const showHeaderDetails = informationDensity === "detailed";

  return (
    <aside className="panel playback-practice-rail">
      <div
        aria-label="Playback rail shortcuts"
        className="playback-practice-rail__focus-icons"
        tabIndex={0}
      >
        <span title="Transpose / Capo">
          <ArrowUpDown aria-hidden="true" />
        </span>
        <span title="Pre-count">
          <Drumstick aria-hidden="true" />
        </span>
        <span title="Source and Mixes">
          <Layers aria-hidden="true" />
        </span>
        <span title="Stem Practice">
          <AudioLines aria-hidden="true" />
        </span>
      </div>
      <div className="playback-practice-rail__content">
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
          higherTargetShiftOptions={higherCapoShiftOptions}
          isOpen={capoSelectorOpen}
          listboxLabel="Capo shift options"
          lowerButtonLabel="Lower capo shift"
          lowerPreview={lowerCapoPreview}
          lowerTargetShiftOptions={lowerCapoShiftOptions}
          optionRefs={capoOptionRefs}
          selectorLabel="Capo Shift"
          selectorRef={capoSelectorRef}
          setIsOpen={setCapoSelectorOpen}
          setSemitones={setCapoTransposeSemitones}
          showCompactControls
          sourceKey={capoSourceKey}
          value={capoSemitones}
        />
        <p className="artifact-meta playback-capo-control__summary">{capoShiftSummary}</p>
      </section>

      <section
        className={`playback-precount-control${
          canUsePrecount ? "" : " playback-precount-control--disabled"
        }`}
        aria-labelledby="playback-precount-heading"
      >
        <div className="playback-precount-control__header">
          <div>
            <p className="metric-label">Pre-count</p>
            <h3 id="playback-precount-heading">Count-in</h3>
          </div>
          <label className="playback-precount-control__toggle">
            <input
              aria-label="Enable pre-count"
              checked={precountEnabled}
              disabled={!canUsePrecount}
              onChange={(event) => handleSetPrecountEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>{precountEnabled ? "On" : "Off"}</span>
          </label>
        </div>
        <div className="playback-precount-control__stepper" role="group" aria-label="Pre-count clicks">
          <button
            aria-label="Decrease pre-count clicks"
            disabled={!canUsePrecount || precountClickCount <= precountMinClickCount}
            onClick={() => handleSetPrecountClickCount(precountClickCount - 1)}
            type="button"
          >
            -
          </button>
          <strong aria-live="polite">{precountClickCount}</strong>
          <button
            aria-label="Increase pre-count clicks"
            disabled={!canUsePrecount || precountClickCount >= precountMaxClickCount}
            onClick={() => handleSetPrecountClickCount(precountClickCount + 1)}
            type="button"
          >
            +
          </button>
        </div>
        <p className="artifact-meta playback-precount-control__summary">
          {canUsePrecount && precountTempoBpm !== null
            ? `${precountClickCount} clicks at ${precountTempoBpm.toFixed(1)} BPM`
            : precountDisabledReason}
        </p>
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
      </div>
    </aside>
  );
}
