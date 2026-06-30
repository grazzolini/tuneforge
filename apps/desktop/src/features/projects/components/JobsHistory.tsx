import { useProjectViewModelContext } from "./useProjectViewModelContext";
import {
  artifactLabel,
  artifactSummary,
  formatArtifactTimestamp,
  formatJobProgressValue,
  formatJobErrorMessage,
  formatJobStageLabel,
  formatJobStatusSummary,
} from "../projectViewUtils";

export function JobsHistory() {
  const {
    displayArtifacts,
    hasNextProjectHistoryJobsPage,
    informationDensity,
    isFetchNextProjectHistoryJobsPageError,
    isFetchingNextProjectHistoryJobsPage,
    isProjectJobsError,
    isProjectJobsLoading,
    loadNextProjectHistoryJobsPage,
    showSupportingCopy,
    visibleJobs,
  } = useProjectViewModelContext();
  const hasJobs = visibleJobs.length > 0;
  const showNoJobs = !isProjectJobsLoading && !isProjectJobsError && !hasJobs;

  return (
    <div className="panel jobs-history">
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

          <div className="job-history-list">
            {isProjectJobsLoading ? (
              <p className="job-history-list__state" role="status">
                Loading job history...
              </p>
            ) : null}

            {isProjectJobsError ? (
              <p className="job-history-list__state inline-error" role="alert">
                Could not load job history.
              </p>
            ) : null}

            <ul
              aria-busy={isProjectJobsLoading || isFetchingNextProjectHistoryJobsPage}
              aria-label="Project job history"
              className="job-list"
            >
              {hasJobs
                ? visibleJobs.map((job) => {
                    const progress = formatJobProgressValue(job);
                    const errorMessage = formatJobErrorMessage(job.error_message, job);
                    const stageLabel = formatJobStageLabel(job);
                    return (
                      <li key={job.id}>
                        <div>
                          <strong>{job.type}</strong>
                          <span>{formatJobStatusSummary(job)}</span>
                          {stageLabel ? <small>{stageLabel}</small> : null}
                        </div>
                        <progress aria-label={`${job.type} job progress`} max={100} value={progress} />
                        <small>{formatArtifactTimestamp(job.completed_at ?? job.updated_at)}</small>
                        {errorMessage ? <small className="inline-error">{errorMessage}</small> : null}
                      </li>
                    );
                  })
                : null}
            </ul>

            {showNoJobs ? <p className="job-history-list__state">No jobs yet.</p> : null}

            {isFetchNextProjectHistoryJobsPageError ? (
              <p className="job-history-list__state inline-error" role="alert">
                Could not load more history.
              </p>
            ) : null}

            {hasNextProjectHistoryJobsPage ? (
              <button
                className="button button--ghost button--small job-history-list__load-more"
                disabled={isFetchingNextProjectHistoryJobsPage}
                onClick={() => {
                  void loadNextProjectHistoryJobsPage();
                }}
                type="button"
              >
                {isFetchingNextProjectHistoryJobsPage ? "Loading history..." : "Load more history"}
              </button>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}
