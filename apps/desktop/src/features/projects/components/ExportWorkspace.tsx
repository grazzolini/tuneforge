import { Link } from "react-router-dom";
import {
  Archive,
  AudioLines,
  Check,
  Download,
  Drum,
  FileAudio,
  Folder,
  Guitar,
  Layers3,
  MicVocal,
  Music2,
  Piano,
  X,
} from "lucide-react";
import type { ArtifactSchema } from "../../../lib/api";
import { artifactLabel, isStemArtifact } from "../projectViewUtils";
import { useExportWorkspace } from "../hooks/useExportWorkspace";
import { useProjectViewModelContext } from "./useProjectViewModelContext";

const FORMATS = ["wav", "flac", "mp3", "m4a"] as const;
const DESTINATIONS = [
  { id: "single_file", label: "File", icon: FileAudio },
  { id: "folder", label: "Folder", icon: Folder },
  { id: "zip", label: "ZIP", icon: Archive },
] as const;

function ArtifactIcon({ artifact }: { artifact: ArtifactSchema }) {
  const Icon = artifact.type === "vocal_stem"
    ? MicVocal
    : artifact.type === "drums_stem"
      ? Drum
      : artifact.type === "guitar_stem" || artifact.type === "bass_stem"
        ? Guitar
        : artifact.type === "piano_stem"
          ? Piano
          : isStemArtifact(artifact)
            ? AudioLines
            : Music2;
  return <Icon aria-hidden="true" />;
}

function formatDuration(seconds: number | null | undefined) {
  if (typeof seconds !== "number") return "Duration unknown";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.round(seconds % 60).toString().padStart(2, "0")}`;
}

export function ExportWorkspace() {
  const workspace = useExportWorkspace();
  const {
    audioSet,
    audioSetId,
    audioSets,
    activeExportJob,
    capabilitiesError,
    canExport,
    cancelMutation,
    capabilities,
    chooseDestination,
    destinationTarget,
    destinationType,
    exportMutation,
    filenameBase,
    goToStudio,
    isMobileRuntime,
    latestExportJob,
    outputFormat,
    outputNames,
    partialExportJob,
    preset,
    retryFailed,
    retryCapabilities,
    retryUnavailableReason,
    resetUnavailableReason,
    resetWorkspace,
    selectedDestinationCapability,
    selectedFormatCapability,
    selectedIds,
    selectedArtifacts,
    selectionAllowed,
    selectPreset,
    setAudioSetId,
    setDestinationType,
    setFilenameBase,
    setOutputFormat,
    toggleArtifact,
    workspaceReady,
  } = workspace;
  const { projectQuery } = useProjectViewModelContext();
  const projectDuration = projectQuery.data?.duration_seconds;
  const selectionInputType = isMobileRuntime ? "radio" : "checkbox";
  const controlsDisabled = Boolean(activeExportJob) || !workspaceReady;
  const destinationLabel = DESTINATIONS.find((destination) => destination.id === destinationType)?.label
    ?? "Destination";

  if (!audioSet) {
    return (
      <div
        aria-labelledby="project-export-tab"
        className="panel export-workspace-empty"
        id="project-export-panel"
        role="tabpanel"
      >
        {capabilitiesError ? (
          <div className="notice notice--error" role="alert">
            {capabilitiesError} <button className="button-link" onClick={retryCapabilities} type="button">Retry</button>
          </div>
        ) : "No audio is available to export yet."}
      </div>
    );
  }

  return (
    <section className="export-workspace" aria-labelledby="project-export-tab" id="project-export-panel" role="tabpanel">
      <header className="export-workspace__header">
        <div>
          <span className="eyebrow">Project delivery</span>
          <h2 id="export-workspace-title">Export audio</h2>
          <p>Choose one audio set, select its tracks, then package local files.</p>
        </div>
        <div className="export-workspace__header-actions">
          <span className="export-workspace__selection-count" aria-live="polite">
            {selectedIds.size} selected
          </span>
          <button
            aria-describedby={resetUnavailableReason ? "export-reset-reason" : undefined}
            className="button button--ghost button--small"
            disabled={Boolean(resetUnavailableReason)}
            onClick={resetWorkspace}
            type="button"
          >Reset export workspace</button>
          {resetUnavailableReason ? <span className="field-reason" id="export-reset-reason">{resetUnavailableReason}</span> : null}
        </div>
      </header>

      {capabilitiesError ? (
        <div className="notice notice--error" role="alert">
          {capabilitiesError} <button className="button-link" onClick={retryCapabilities} type="button">Retry</button>
        </div>
      ) : null}

      {isMobileRuntime ? (
        <div className="notice notice--info" id="android-export-format-notice" role="status">
          Android currently exports one M4A file at a time.
          {!capabilities?.formats.some((format) => format.available)
            ? " Audio export is unavailable in this build."
            : null}
        </div>
      ) : null}

      <div className="export-workspace__grid">
        <aside className="panel export-audio-sets" aria-label="Audio sets">
          <div className="export-section-heading">
            <span>Audio sets</span>
            <span>{audioSets.length}</span>
          </div>
          <div className="export-audio-sets__options" role="radiogroup" aria-label="Export audio set">
            {audioSets.map((candidate) => (
              <label
                className={`export-audio-set${candidate.artifact.id === audioSetId ? " export-audio-set--active" : ""}`}
                key={candidate.artifact.id}
              >
                <input
                  checked={candidate.artifact.id === audioSetId}
                  disabled={controlsDisabled}
                  name="export-audio-set"
                  onChange={() => setAudioSetId(candidate.artifact.id)}
                  type="radio"
                />
                <span className="export-audio-set__icon"><Music2 aria-hidden="true" /></span>
                <span>
                  <strong>{candidate.label}</strong>
                  <small>{candidate.stems.length ? `${candidate.stems.length} stems` : "Track only"}</small>
                </span>
              </label>
            ))}
          </div>
        </aside>

        <div className="panel export-selection">
          <div className="export-selection__identity">
            <div>
              <span className="eyebrow">Selected audio set</span>
              <h3>{audioSet.label}</h3>
            </div>
            <span>{audioSet.artifact.format.toUpperCase()} · {formatDuration(projectDuration)}</span>
          </div>

          <fieldset className="export-presets" disabled={controlsDisabled}>
            <legend>Quick selections</legend>
            <button
              aria-describedby={isMobileRuntime ? "android-multi-export-reason" : undefined}
              aria-pressed={preset === "track-and-stems"}
              className="button button--small"
              disabled={!audioSet.stems.length || isMobileRuntime}
              title={isMobileRuntime ? "Android currently exports one file at a time." : undefined}
              onClick={() => selectPreset("track-and-stems")}
              type="button"
            >Track + all stems</button>
            <button
              aria-pressed={preset === "track"}
              className="button button--small"
              onClick={() => selectPreset("track")}
              type="button"
            >Track only</button>
            <button
              aria-describedby={isMobileRuntime ? "android-multi-export-reason" : undefined}
              aria-pressed={preset === "stems"}
              className="button button--small"
              disabled={!audioSet.stems.length || isMobileRuntime}
              title={isMobileRuntime ? "Android currently exports one file at a time." : undefined}
              onClick={() => selectPreset("stems")}
              type="button"
            >All stems</button>
            <span className="export-presets__state">{preset === "custom" ? "Custom selection" : "Preset selection"}</span>
            {isMobileRuntime ? (
              <span className="field-reason" id="android-multi-export-reason">
                All stems and track plus stems require multiple files. Android exports one file at a time.
              </span>
            ) : null}
          </fieldset>

          <fieldset className="export-artifact-list" disabled={controlsDisabled}>
            <legend>Audio selection</legend>
            {[audioSet.artifact, ...audioSet.stems].map((artifact) => (
              <label className="export-artifact-row" key={artifact.id}>
                <input
                  checked={selectedIds.has(artifact.id)}
                  name={isMobileRuntime ? "export-artifact" : undefined}
                  onChange={() => toggleArtifact(artifact.id)}
                  type={selectionInputType}
                />
                <span className="export-artifact-row__icon"><ArtifactIcon artifact={artifact} /></span>
                <span className="export-artifact-row__copy">
                  <strong>{isStemArtifact(artifact) ? artifactLabel(artifact) : audioSet.label}</strong>
                  <small>{artifact.format.toUpperCase()} · {formatDuration(projectDuration)}</small>
                </span>
                <span className="export-artifact-row__status">
                  {selectedIds.has(artifact.id) ? <Check aria-hidden="true" /> : null}
                  Available
                </span>
              </label>
            ))}
          </fieldset>

          {!audioSet.stems.length ? (
            <p className="export-empty-stems">No stems yet for this audio set. <button className="button-link" onClick={goToStudio} type="button">Go to Studio</button></p>
          ) : null}
        </div>

        <aside className="panel export-package" aria-label="Export package">
          {activeExportJob ? (
            <div className="export-package__summary export-package__summary--progress export-progress" aria-live="polite">
              <span className="eyebrow">Export in progress</span>
              <h3>{activeExportJob.stage_label ?? "Preparing files"}</h3>
              <p>{activeExportJob.export_result?.items.find((item) => item.status === "running")?.output_name
                ?? activeExportJob.export_result?.items[0]?.output_name
                ?? outputNames[0]
                ?? "Export package"}</p>
              <p>{activeExportJob.export_result?.total_count ?? selectedArtifacts.length} items · {activeExportJob.progress}%</p>
              <progress aria-label="Export progress" max="100" value={activeExportJob.progress} />
              <div className="export-progress__actions">
                <button className="button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()} type="button">
                  <X aria-hidden="true" /> Cancel
                </button>
                <Link className="button button--ghost" to="/activity">View in Activity</Link>
              </div>
            </div>
          ) : (
            <>
              <div className="export-section-heading"><span>Export package</span><PackageSummaryIcon /></div>
              {latestExportJob ? (
                <div className="export-latest" aria-live="polite">
                  <span>Latest export</span>
                  <strong>{latestExportJob.export_result?.outcome ?? latestExportJob.status}</strong>
                </div>
              ) : null}
              <label className="export-field">
                <span>File format</span>
                <select
                  aria-describedby={isMobileRuntime ? "android-export-format-notice" : undefined}
                  disabled={!workspaceReady}
                  onChange={(event) => setOutputFormat(event.target.value as typeof outputFormat)}
                  value={outputFormat}
                >
                  {FORMATS.map((format) => {
                    const capability = capabilities?.formats.find((candidate) => candidate.id === format);
                    return <option disabled={capability?.available === false} key={format} value={format}>{format.toUpperCase()}{capability?.available === false ? " — unavailable" : ""}</option>;
                  })}
                </select>
              </label>
              {selectedFormatCapability?.available === false ? <p className="field-reason">{selectedFormatCapability.reason}</p> : null}
              <label className="export-field">
                <span>File name base</span>
                <input onChange={(event) => setFilenameBase(event.target.value)} value={filenameBase} />
              </label>
              <fieldset className="export-destinations">
                <legend>Destination</legend>
                {DESTINATIONS.map(({ id, label, icon: Icon }) => {
                  const countCompatible = selectedIds.size === 1 ? id === "single_file" : id !== "single_file";
                  const capability = capabilities?.destinations.find((candidate) => candidate.id === id);
                  const unavailable = !countCompatible || capability?.available === false;
                  const reasonId = `export-destination-${id}-reason`;
                  return (
                    <span className="export-destination-option" key={id}>
                      <button
                        aria-describedby={unavailable ? reasonId : undefined}
                        aria-pressed={destinationType === id}
                        className="button button--small"
                        disabled={unavailable}
                        onClick={() => setDestinationType(id)}
                        type="button"
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                        <span aria-hidden="true" className="export-destination-option__check">
                          {destinationType === id ? <Check /> : null}
                        </span>
                      </button>
                      {unavailable ? (
                        <small className="field-reason" id={reasonId}>
                          {capability?.available === false
                            ? capability.reason
                            : selectedIds.size === 1
                              ? "Choose File for one item."
                              : "Multiple items require Folder or ZIP."}
                        </small>
                      ) : null}
                    </span>
                  );
                })}
              </fieldset>
              {selectedDestinationCapability?.available === false ? <p className="field-reason">{selectedDestinationCapability.reason}</p> : null}
              <button className="button button--ghost export-destination-picker" disabled={!selectedIds.size || !workspaceReady || isMobileRuntime} onClick={() => void chooseDestination()} type="button">
                {destinationTarget ? "Change destination" : "Choose destination"}
              </button>
              {destinationTarget ? <p className="export-destination-target" title={destinationTarget}>{destinationTarget}</p> : null}

              <div className="export-preview">
                <div className="export-section-heading"><span>File preview</span><span>{outputNames.length}</span></div>
                <ul>{outputNames.map((name) => <li key={name}>{name}</li>)}</ul>
              </div>

              {!selectionAllowed ? <p className="field-reason">This device supports one export item at a time.</p> : null}
              {partialExportJob ? (
                <>
                  <button className="button button--ghost" disabled={Boolean(retryUnavailableReason)} onClick={retryFailed} type="button">Retry failed</button>
                  {retryUnavailableReason ? <p className="field-reason">{retryUnavailableReason}</p> : null}
                </>
              ) : null}
              <div className="export-package__summary" data-testid="export-compact-summary">
                <div className="export-package__summary-copy" aria-live="polite">
                  <span>{selectedIds.size} {selectedIds.size === 1 ? "item" : "items"}</span>
                  <strong>{destinationLabel} · {destinationTarget ? "Selected" : "Choose on export"}</strong>
                </div>
                <button className="button export-package__submit" disabled={!canExport || exportMutation.isPending} onClick={() => exportMutation.mutate()} type="button">
                  <Download aria-hidden="true" /> {exportMutation.isPending ? "Opening destination…" : `Export ${selectedIds.size || ""} ${selectedIds.size === 1 ? "file" : "files"}`}
                </button>
                {exportMutation.error ? <p className="error" role="alert">{exportMutation.error.message}</p> : null}
              </div>
              <Link className="export-activity-link" to="/activity">View export history in Activity</Link>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function PackageSummaryIcon() {
  return <Layers3 aria-hidden="true" />;
}
