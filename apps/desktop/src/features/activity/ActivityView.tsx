import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type JobSchema, type ProjectSchema } from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime, parseApiDateTime } from "../../lib/datetime";
import { formatJobStatusSummary } from "../projects/projectViewUtils";

const CANCELABLE_JOB_STATUSES = new Set(["pending", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_JOB_REFETCH_MS = 1500;

type DisplayJob = {
  job: JobSchema;
  queuePosition: number | null;
};

function timestampMs(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = parseApiDateTime(value);
  const timestamp = parsed.getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareCreatedAtAscending(left: JobSchema, right: JobSchema) {
  return timestampMs(left.created_at) - timestampMs(right.created_at);
}

function recentJobTimestamp(job: JobSchema) {
  return timestampMs(job.completed_at ?? job.updated_at ?? job.created_at);
}

function getJobSortGroup(job: JobSchema) {
  if (job.status === "running") return 0;
  if (job.status === "pending") return 1;
  if (TERMINAL_JOB_STATUSES.has(job.status)) return 2;
  return 3;
}

function orderJobsForQueue(jobs: JobSchema[]): DisplayJob[] {
  const pendingJobs = jobs.filter((job) => job.status === "pending").sort(compareCreatedAtAscending);
  const queuePositionById = new Map(
    pendingJobs.map((job, index) => [job.id, index + 1]),
  );

  return [...jobs]
    .sort((left, right) => {
      const leftGroup = getJobSortGroup(left);
      const rightGroup = getJobSortGroup(right);

      if (leftGroup !== rightGroup) {
        return leftGroup - rightGroup;
      }

      if (leftGroup === 0) {
        return timestampMs(left.started_at ?? left.created_at) - timestampMs(right.started_at ?? right.created_at);
      }

      if (leftGroup === 1) {
        return compareCreatedAtAscending(left, right);
      }

      return recentJobTimestamp(right) - recentJobTimestamp(left);
    })
    .map((job) => ({
      job,
      queuePosition: queuePositionById.get(job.id) ?? null,
    }));
}

function formatTimestamp(value: string) {
  return formatLocalDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatJobDetails(job: JobSchema) {
  const summary = formatJobStatusSummary(job);
  if (!summary || summary === job.status) {
    return null;
  }

  const statusPrefix = `${job.status} / `;
  return summary.startsWith(statusPrefix) ? summary.slice(statusPrefix.length) : summary;
}

function progressValue(job: JobSchema) {
  return Math.max(0, Math.min(100, Math.round(job.progress)));
}

function projectById(projects: ProjectSchema[] | undefined) {
  return new Map((projects ?? []).map((project) => [project.id, project]));
}

function hasActiveJob(jobs: JobSchema[] | undefined) {
  return jobs?.some((job) => CANCELABLE_JOB_STATUSES.has(job.status)) ?? false;
}

function JobProjectLink({
  project,
  projectId,
}: {
  project: ProjectSchema | null;
  projectId: string | null;
}) {
  if (!projectId) {
    return <span>No project</span>;
  }

  const label = project?.display_name ?? projectId;
  return (
    <Link aria-label={`Open ${label} project`} className="activity-job-row__project-link" to={`/projects/${projectId}`}>
      {label}
    </Link>
  );
}

function JobTimestamps({ job }: { job: JobSchema }) {
  const timestamps = [
    { label: "Created", value: job.created_at },
    { label: "Started", value: job.started_at },
    { label: "Updated", value: job.updated_at },
    { label: "Completed", value: job.completed_at },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value));

  return (
    <dl className="activity-job-row__timestamps">
      {timestamps.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            <time dateTime={normalizeApiDateTime(item.value)}>{formatTimestamp(item.value)}</time>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function JobRow({
  displayJob,
  isCancelling,
  onCancel,
  project,
}: {
  displayJob: DisplayJob;
  isCancelling: boolean;
  onCancel: (jobId: string) => void;
  project: ProjectSchema | null;
}) {
  const { job, queuePosition } = displayJob;
  const details = formatJobDetails(job);
  const progress = progressValue(job);
  const canCancel = CANCELABLE_JOB_STATUSES.has(job.status);

  return (
    <li className="activity-job-row">
      <article aria-label={`${job.type} ${job.status} job`} className="activity-job-row__article">
        <div className="activity-job-row__main">
          <div className="activity-job-row__identity">
            <div className="activity-job-row__title-line">
              <strong className="activity-job-row__type">{job.type}</strong>
              <span className={`activity-job-row__status activity-job-row__status--${job.status}`}>
                {job.status}
              </span>
              {queuePosition ? (
                <span className="activity-job-row__queue-position">Queue #{queuePosition}</span>
              ) : null}
            </div>
            <div className="activity-job-row__project">
              <span className="metric-label">Project</span>
              <JobProjectLink project={project} projectId={job.project_id} />
            </div>
            {details ? <p className="activity-job-row__details">{details}</p> : null}
          </div>

          <div className="activity-job-row__progress">
            <span>{progress}%</span>
            <progress aria-label={`${job.type} job progress`} max={100} value={progress} />
          </div>

          {canCancel ? (
            <button
              className="button button--ghost button--small activity-job-row__cancel"
              disabled={isCancelling}
              onClick={() => onCancel(job.id)}
              type="button"
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          ) : null}
        </div>

        <JobTimestamps job={job} />

        {job.error_message ? (
          <p className="activity-job-row__error" role="alert">
            {job.error_message}
          </p>
        ) : null}
      </article>
    </li>
  );
}

export function ActivityView() {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => (await api.listJobs()).jobs,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects", "activity"],
    queryFn: async () => (await api.listProjects()).projects,
  });
  const cancelJobMutation = useMutation({
    mutationFn: (jobId: string) => api.cancelJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const projectsById = useMemo(() => projectById(projectsQuery.data), [projectsQuery.data]);
  const displayJobs = useMemo(() => orderJobsForQueue(jobsQuery.data ?? []), [jobsQuery.data]);
  const activeJobCount = displayJobs.filter(({ job }) => CANCELABLE_JOB_STATUSES.has(job.status)).length;
  const shouldPollJobs = hasActiveJob(jobsQuery.data);
  const isLoading = jobsQuery.isLoading || projectsQuery.isLoading;
  const isError = jobsQuery.isError || projectsQuery.isError;
  const showJobList = !isLoading && !isError && displayJobs.length > 0;
  const showEmptyState = !isLoading && !isError && displayJobs.length === 0;

  useEffect(() => {
    if (!shouldPollJobs) return;

    const interval = window.setInterval(async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["projects", "activity"] }),
      ]);
    }, ACTIVE_JOB_REFETCH_MS);

    return () => window.clearInterval(interval);
  }, [queryClient, shouldPollJobs]);

  return (
    <section className="screen activity-screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Activity</p>
          <h1>Activity</h1>
          <p className="screen__subtitle">Review the local processing queue across every project.</p>
        </div>
      </div>

      <div className="project-workspace-tabs" role="tablist" aria-label="Activity">
        <button
          aria-selected="true"
          className="project-workspace-tabs__button project-workspace-tabs__button--active"
          role="tab"
          type="button"
        >
          Jobs
        </button>
      </div>

      <section aria-labelledby="activity-jobs-heading" className="panel activity-jobs-panel">
        <div className="panel-heading activity-jobs-panel__heading">
          <div>
            <h2 id="activity-jobs-heading">Jobs</h2>
            <p className="subpanel__copy">
              {activeJobCount
                ? `${activeJobCount} active job${activeJobCount === 1 ? "" : "s"} in the queue.`
                : "No pending or running jobs."}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="activity-jobs-panel__state" role="status">
            Loading jobs...
          </div>
        ) : null}

        {isError ? (
          <div className="activity-jobs-panel__state activity-jobs-panel__state--error" role="alert">
            Could not load the activity queue.
          </div>
        ) : null}

        {cancelJobMutation.isError ? (
          <div className="activity-jobs-panel__state activity-jobs-panel__state--error" role="alert">
            Could not cancel the job.
          </div>
        ) : null}

        {showJobList ? (
          <ul aria-label="Job queue" className="activity-job-list">
            {displayJobs.map((displayJob) => (
              <JobRow
                key={displayJob.job.id}
                displayJob={displayJob}
                isCancelling={
                  cancelJobMutation.isPending && cancelJobMutation.variables === displayJob.job.id
                }
                onCancel={(jobId) => cancelJobMutation.mutate(jobId)}
                project={
                  displayJob.job.project_id ? projectsById.get(displayJob.job.project_id) ?? null : null
                }
              />
            ))}
          </ul>
        ) : null}

        {showEmptyState ? (
          <div className="activity-jobs-panel__empty">
            <h3>No jobs yet</h3>
            <p>Import or process a track to populate the queue.</p>
          </div>
        ) : null}
      </section>
    </section>
  );
}
