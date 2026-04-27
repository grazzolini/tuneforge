import { MusicalKeyLabel } from "../../../components/MusicalLabel";
import { formatKey } from "../../../lib/music";
import { TargetKeySelector } from "./TargetKeySelector";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

export function InspectorPanel() {
  const {
    analysisQuery,
    canDeleteSelectedMix,
    centsOffset,
    currentKeyValue,
    deleteMixMutation,
    deleteMutation,
    detectedKey,
    enharmonicDisplayMode,
    exportMutation,
    handleDeleteMix,
    handleDeleteProject,
    higherTargetPreview,
    higherTargetShiftOptions,
    isAnalysisRunning,
    lowerTargetPreview,
    lowerTargetShiftOptions,
    previewMutation,
    projectQuery,
    referenceHz,
    retuneMode,
    setCentsOffset,
    setReferenceHz,
    setRetuneMode,
    setSourceKeySelectorOpen,
    setTargetSelectorOpen,
    setTargetTransposeSemitones,
    showSupportingCopy,
    sourceKey,
    sourceKeyOptions,
    sourceKeyOptionRefs,
    sourceKeyOverride,
    sourceKeyOverrideMutation,
    sourceKeySelectorCurrentBadge,
    sourceKeySelectorCurrentKey,
    sourceKeySelectorOpen,
    sourceKeySelectorRef,
    sourceKeyStatus,
    targetKey,
    targetOptionRefs,
    targetSelectionSummary,
    targetSelectorOpen,
    targetSelectorRef,
    targetShiftSummary,
    transposeSemitones,
    tuningSummary,
  } = useProjectViewModelContext();

  return (
    <aside className="stack">
      <div className="panel inspector-panel">
        <div className="panel-heading">
      <div>
        <h2>Inspector</h2>
        {showSupportingCopy ? (
          <p className="subpanel__copy">
            Mix decisions stay compact and close to playback.
          </p>
        ) : null}
      </div>
        </div>

        <div className="section-stack">
      <div className="subpanel">
        <div className="subpanel__header">
          <h3>Mix Builder</h3>
        </div>
        <div className="mix-builder">
          <div className="mix-builder__retune">
            <div className="mix-builder__section-head">
              <span className="metric-label">Retune</span>
              <span className="artifact-meta">
                {retuneMode === "off" ? "No pitch retune" : tuningSummary}
              </span>
            </div>
            <div className="mix-builder__mode-toggle" role="group" aria-label="Retune">
              {[
                { value: "off", label: "Off" },
                { value: "reference", label: "Reference Hz" },
                { value: "cents", label: "Cents Offset" },
              ].map((modeOption) => (
                <button
                  key={modeOption.value}
                  className="button button--small mix-builder__mode-button"
                  aria-pressed={retuneMode === modeOption.value}
                  onClick={() =>
                    setRetuneMode(modeOption.value as "off" | "reference" | "cents")
                  }
                  type="button"
                >
                  {modeOption.label}
                </button>
              ))}
            </div>

            {retuneMode === "reference" ? (
              <label className="mix-builder__retune-field">
                <span>Target Reference Hz</span>
                <input
                  aria-label="Target Reference Hz"
                  value={referenceHz}
                  onChange={(event) => setReferenceHz(event.target.value)}
                  type="number"
                  step="0.1"
                />
              </label>
            ) : null}

            {retuneMode === "cents" ? (
              <label className="mix-builder__retune-field">
                <span>Cents Offset</span>
                <input
                  aria-label="Cents Offset"
                  value={centsOffset}
                  onChange={(event) => setCentsOffset(event.target.value)}
                  type="number"
                  step="0.1"
                />
              </label>
            ) : null}
          </div>

          <div className="key-shift key-shift--compact">
            <div className="mix-builder__section-head">
              <span className="metric-label">Key Center</span>
              <span className="artifact-meta">{targetShiftSummary}</span>
            </div>
            <div className="key-shift__header">
              <div className="key-shift__card">
                <div>
                  <span className="metric-label">Source Key</span>
                  <strong>
                    <MusicalKeyLabel
                      keyValue={sourceKey}
                      mode={enharmonicDisplayMode}
                      variant="key-card"
                    />
                  </strong>
                </div>
                <div className="key-shift__chips">
                  <span className="key-shift__chip">{sourceKeyStatus}</span>
                </div>
              </div>
              <div className="key-shift__card key-shift__card--target">
                <div>
                  <span className="metric-label">Target Key</span>
                  <strong>
                    <MusicalKeyLabel
                      keyValue={targetKey}
                      mode={enharmonicDisplayMode}
                      variant="key-card"
                    />
                  </strong>
                </div>
                <div className="key-shift__chips">
                  <span className="key-shift__chip key-shift__chip--active">
                    {targetShiftSummary}
                  </span>
                </div>
              </div>
            </div>

            <TargetKeySelector
              currentKey={targetKey}
              currentMeta={targetSelectionSummary}
              enharmonicDisplayMode={enharmonicDisplayMode}
              headingLabel="Target Selection"
              higherButtonLabel="Raise target key"
              higherPreview={higherTargetPreview}
              higherTargetShiftOptions={higherTargetShiftOptions}
              isOpen={targetSelectorOpen}
              listboxLabel="Target key options"
              lowerButtonLabel="Lower target key"
              lowerPreview={lowerTargetPreview}
              lowerTargetShiftOptions={lowerTargetShiftOptions}
              optionRefs={targetOptionRefs}
              selectorLabel="Target Key"
              selectorRef={targetSelectorRef}
              setIsOpen={setTargetSelectorOpen}
              setSemitones={setTargetTransposeSemitones}
              sourceKey={sourceKey}
              supportingCopy={
                showSupportingCopy
                  ? "Step through all shifts from 1 octave down to 1 octave up."
                  : null
              }
              value={transposeSemitones}
            />
          </div>
        </div>

        {previewMutation.isError ? (
          <p className="inline-error">
            {previewMutation.error instanceof Error
              ? previewMutation.error.message
              : "Could not create preview."}
          </p>
        ) : null}
      </div>

      <div className="subpanel">
        <div className="panel-heading panel-heading--compact">
          <div>
            <h3>Analysis</h3>
          </div>
        </div>
        <div className="analysis-grid">
          <div className="analysis-stat">
            <span className="metric-label">Detected Tuning</span>
            <strong>
              <span className="analysis-stat__value">
                {analysisQuery.data?.estimated_reference_hz?.toFixed(2) ?? "Pending"}
              </span>
              <span className="analysis-stat__unit">Hz</span>
            </strong>
          </div>
          <div className="analysis-stat">
            <span className="metric-label">Offset</span>
            <strong>
              <span className="analysis-stat__value">
                {analysisQuery.data?.tuning_offset_cents?.toFixed(2) ?? "-"}
              </span>
              <span className="analysis-stat__unit">cents</span>
            </strong>
          </div>
          <div className="analysis-stat">
            <span className="metric-label">Estimated Key</span>
            <strong>
              {detectedKey ? (
                <MusicalKeyLabel
                  keyValue={detectedKey}
                  mode={enharmonicDisplayMode}
                  variant="key-card"
                />
              ) : (
                <span className="analysis-stat__value">
                  {isAnalysisRunning ? "Analyzing..." : "Unknown"}
                </span>
              )}
            </strong>
          </div>
          <div className="analysis-stat">
            <span className="metric-label">Tempo</span>
            <strong>
              <span className="analysis-stat__value">
                {analysisQuery.data?.tempo_bpm?.toFixed(1) ?? "-"}
              </span>
              <span className="analysis-stat__unit">BPM</span>
            </strong>
          </div>
          <div className="analysis-stat">
            <span className="metric-label">Confidence</span>
            <strong>
              <span className="analysis-stat__value">
                {analysisQuery.data?.key_confidence?.toFixed(2) ?? "-"}
              </span>
            </strong>
          </div>
        </div>
        <details className="details-block details-block--inset">
          <summary>Correct source key for this project</summary>
          <p className="artifact-meta">
            {sourceKeyOverride
              ? `Using ${formatKey(sourceKeyOverride, "short", { mode: enharmonicDisplayMode })} everywhere keys are derived in this project. Analysis data stays unchanged.`
              : "Use this to change the detected key, if you think analysis got it wrong. It updates the project key, chords and practice mixes."}
          </p>
          <div className="controls controls--tight">
            <div className="source-key-selector-field">
              <span className="source-key-selector-field__label">Project Source Key</span>
              <div className="source-key-selector" ref={sourceKeySelectorRef}>
                <button
                  className={`source-key-selector__trigger${
                    sourceKeySelectorOpen ? " source-key-selector__trigger--open" : ""
                  }`}
                  aria-label="Project Source Key"
                  aria-expanded={sourceKeySelectorOpen}
                  aria-haspopup="listbox"
                  disabled={sourceKeyOverrideMutation.isPending}
                  onClick={() => {
                    setTargetSelectorOpen(false);
                    setSourceKeySelectorOpen((current) => !current);
                  }}
                  type="button"
                >
                  <span className="source-key-selector__current">
                    <span className="source-key-selector__current-indicator" aria-hidden="true" />
                    <span className="source-key-selector__current-label">
                      <MusicalKeyLabel
                        keyValue={sourceKeySelectorCurrentKey}
                        mode={enharmonicDisplayMode}
                        variant="source-selector-current"
                      />
                    </span>
                    {sourceKeySelectorCurrentBadge ? (
                      <span className="source-key-selector__current-badge">
                        {sourceKeySelectorCurrentBadge}
                      </span>
                    ) : null}
                  </span>
                  <span className="source-key-selector__chevron" aria-hidden="true">
                    ⌄
                  </span>
                </button>

                {sourceKeySelectorOpen ? (
                  <div
                    className="source-key-selector__menu"
                    role="listbox"
                    aria-label="Project Source Key options"
                  >
                    {sourceKeyOptions.map((option) => {
                      const isSelected = option.value === currentKeyValue;
                      return (
                        <button
                          key={`${option.value}-${option.badge ?? "key"}`}
                          ref={(node) => {
                            sourceKeyOptionRefs.current[option.value] = node;
                          }}
                          aria-selected={isSelected}
                          className={`source-key-selector__option${
                            isSelected ? " source-key-selector__option--selected" : ""
                          }`}
                          disabled={sourceKeyOverrideMutation.isPending}
                          onClick={() => {
                            sourceKeyOverrideMutation.mutate(
                              option.value === "auto" ? null : option.value,
                            );
                            setSourceKeySelectorOpen(false);
                          }}
                          role="option"
                          type="button"
                        >
                          <span className="source-key-selector__option-content">
                            <span className="source-key-selector__option-indicator" aria-hidden="true" />
                            <span className="source-key-selector__option-label">
                              <MusicalKeyLabel
                                keyValue={option.key}
                                mode={enharmonicDisplayMode}
                                variant="source-selector-option"
                              />
                            </span>
                            {option.badge ? (
                              <span className="source-key-selector__option-badge">
                                {option.badge}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </details>
      </div>

      <div className="subpanel subpanel--compact">
        <div className="subpanel__header">
          <h3>Export</h3>
          {showSupportingCopy ? (
            <p className="subpanel__copy">
              Export only when you need audio outside the app.
            </p>
          ) : null}
        </div>
        <button
          className="button"
          onClick={() => exportMutation.mutate()}
          disabled={exportMutation.isPending}
          type="button"
        >
          {exportMutation.isPending ? "Queueing..." : "Export Selected Audio"}
        </button>
      </div>

      <div className="subpanel">
        <div className="subpanel__header">
          <h3>Project Details</h3>
        </div>
        <dl className="meta-grid">
          <div className="meta-stat">
            <dt>Duration</dt>
            <dd>
              <span className="meta-stat__value">
                {projectQuery.data?.duration_seconds?.toFixed(2) ?? "Unknown"}
              </span>
              <span className="meta-stat__unit">s</span>
            </dd>
          </div>
          <div className="meta-stat">
            <dt>Sample Rate</dt>
            <dd>
              <span className="meta-stat__value">
                {projectQuery.data?.sample_rate ?? "Unknown"}
              </span>
              <span className="meta-stat__unit">Hz</span>
            </dd>
          </div>
          <div className="meta-stat">
            <dt>Channels</dt>
            <dd>
              <span className="meta-stat__value">
                {projectQuery.data?.channels ?? "Unknown"}
              </span>
            </dd>
          </div>
        </dl>

        <details className="details-block">
          <summary>Show file details</summary>
          <dl className="details-grid details-grid--single-column">
            <div>
              <dt>Imported Path</dt>
              <dd className="path">{projectQuery.data?.imported_path ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Original Source</dt>
              <dd className="path">{projectQuery.data?.source_path ?? "Unknown"}</dd>
            </div>
          </dl>
        </details>
      </div>

      <div className="subpanel subpanel--compact subpanel--danger">
        <div className="subpanel__header">
          <h3>Danger Zone</h3>
        </div>
        <div className="button-row">
          {canDeleteSelectedMix ? (
            <button
              className="button button--ghost button--small"
              onClick={handleDeleteMix}
              disabled={deleteMixMutation.isPending}
              type="button"
            >
              {deleteMixMutation.isPending ? "Deleting..." : "Delete Practice Mix"}
            </button>
          ) : null}
          <button
            className="button button--ghost button--small"
            onClick={handleDeleteProject}
            disabled={deleteMutation.isPending}
            type="button"
          >
            Delete Project
          </button>
        </div>
      </div>
        </div>
      </div>
    </aside>
  );
}
