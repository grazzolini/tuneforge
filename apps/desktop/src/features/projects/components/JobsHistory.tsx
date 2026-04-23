import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { artifactLabel, artifactSummary, formatArtifactTimestamp, formatJobStatusSummary } from "../projectViewUtils";

export function JobsHistory() {
  const {
    displayArtifacts,
    informationDensity,
    showSupportingCopy,
    visibleJobs,
  } = useProjectViewModelContext();

  return (
    <div className="panel">
      <div className="panel-heading">
        <div>
      <h2>Jobs and History</h2>
      {showSupportingCopy ? (
        <p className="subpanel__copy">
          Raw artifacts and job logs stay available without crowding playback.
        </p>
      ) : null}
        </div>
      </div>

      <details className="details-block details-block--flush">
        <summary>Show raw artifacts and processing history</summary>
        <div className="details-stack">
      <ul className="artifact-list">
        {displayArtifacts.length ? (
          displayArtifacts.map((artifact) => (
            <li key={artifact.id}>
              <span>{artifactLabel(artifact)}</span>
              <small>{artifact.format.toUpperCase()}</small>
              <small>{formatArtifactTimestamp(artifact.created_at)}</small>
              {informationDensity === "detailed" && artifactSummary(artifact) ? (
                <small>{artifactSummary(artifact)}</small>
              ) : null}
            </li>
          ))
        ) : (
          <li>No artifacts yet.</li>
        )}
      </ul>

      <ul className="job-list">
        {visibleJobs.length ? (
          visibleJobs.map((job) => (
            <li key={job.id}>
              <div>
                <strong>{job.type}</strong>
                <span>{formatJobStatusSummary(job)}</span>
              </div>
              <progress max={100} value={job.progress} />
              <small>{formatArtifactTimestamp(job.completed_at ?? job.updated_at)}</small>
              {job.error_message ? (
                <small className="inline-error">{job.error_message}</small>
              ) : null}
            </li>
          ))
        ) : (
          <li>No jobs yet.</li>
        )}
      </ul>
        </div>
      </details>
    </div>
  );
}
