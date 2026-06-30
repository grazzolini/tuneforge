import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Activity, Layers, Mic, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, type BulkJobRequest, type BulkJobsResponse, type JobSchema, type ProjectSchema } from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime, parseApiDateTime } from "../../lib/datetime";
import { useLazyLoadSentinel } from "../../lib/useLazyLoadSentinel";
import { usePreferences } from "../../lib/preferences";
import { useBeatBackendActionSelection } from "../projects/hooks/useBeatBackendActionSelection";
import { useChordBackendActionSelection } from "../projects/hooks/useChordBackendActionSelection";
import {
  formatJobProgressValue,
  formatJobErrorMessage,
  formatJobRuntimeSummary,
  formatJobStageLabel,
  formatJobStatusSummary,
} from "../projects/projectViewUtils";
import { ActivitySyncPanel } from "./ActivitySyncPanel";

const CANCELABLE_JOB_STATUSES = new Set(["pending", "running"]);
const ACTIVE_JOB_STATUSES = ["running", "pending"] as const;
const TERMINAL_JOB_STATUS_VALUES = ["completed", "failed", "cancelled"] as const;
const TERMINAL_JOB_STATUSES = new Set<string>(TERMINAL_JOB_STATUS_VALUES);
const ACTIVE_JOBS_LIMIT = 200;
const TERMINAL_JOBS_PAGE_SIZE = 50;
const ACTIVE_JOB_REFETCH_MS = 1500;
const ACTIVE_JOBS_QUERY_KEY = ["jobs", "activity", "active"] as const;
const TERMINAL_JOBS_QUERY_KEY = ["jobs", "activity", "terminal"] as const;
const ACTIVITY_PROJECTS_QUERY_KEY = ["projects", "activity"] as const;
const ACTIVITY_PROJECT_STALE_MS = 5 * 60 * 1000;
const ACTIVITY_TABS = [
  { id: "jobs", label: "Jobs" },
  { id: "sync", label: "Sync" },
] as const;
const BULK_JOB_ACTIONS = [
  {
    jobType: "analyze",
    label: "Analyze all projects",
    pendingLabel: "Queueing analyze jobs...",
    resultLabel: "Analyze jobs",
    confirmTitle: "Analyze all projects",
    confirmBody: "Re-analyze every project? This may take time and may use CPU/GPU heavily.",
    okLabel: "Analyze all",
    icon: Activity,
  },
  {
    jobType: "chords",
    label: "Refresh chords for all projects",
    pendingLabel: "Queueing chord jobs...",
    resultLabel: "Chord jobs",
    confirmTitle: "Refresh chords for all projects",
    confirmBody: "Refresh chords for every project with your default chord backend? Existing chord timelines and tab suggestions may be replaced. This may take time and may use CPU/GPU heavily.",
    okLabel: "Refresh chords",
    icon: RefreshCw,
  },
  {
    jobType: "lyrics",
    label: "Refresh lyrics for all projects",
    pendingLabel: "Queueing lyrics jobs...",
    resultLabel: "Lyrics jobs",
    confirmTitle: "Refresh lyrics for all projects",
    confirmBody: "Refresh lyrics for every project? Existing transcripts and imported tab suggestions may be replaced. This may take time and may use CPU/GPU heavily.",
    okLabel: "Refresh lyrics",
    icon: Mic,
  },
  {
    jobType: "stems",
    label: "Refresh existing stems",
    pendingLabel: "Queueing stem jobs...",
    resultLabel: "Stem jobs",
    confirmTitle: "Refresh existing stems",
    confirmBody: "Refresh only source tracks and practice mixes that already have stems, using your default stem model. This may take time and may use CPU/GPU heavily.",
    okLabel: "Refresh stems",
    icon: Layers,
  },
] as const;

type ActivityTab = (typeof ACTIVITY_TABS)[number]["id"];
type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];
type BulkJobSkippedProject = BulkJobsResponse["skipped"][number];

type DisplayJob = {
  job: JobSchema;
  queuePosition: number | null;
};

const EMPTY_JOBS: JobSchema[] = [];

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

function formatJobDetails(job: JobSchema, { includeRuntimeDevice = true } = {}) {
  const summary = formatJobStatusSummary(job, { includeRuntimeDevice });
  if (!summary || summary === job.status) {
    return null;
  }

  const statusPrefix = `${job.status} / `;
  return summary.startsWith(statusPrefix) ? summary.slice(statusPrefix.length) : summary;
}

function activeStageStatusLabel(stageLabel: string, runtimeSummary: string | null) {
  return runtimeSummary ? `Current stage: ${stageLabel}, ${runtimeSummary}` : `Current stage: ${stageLabel}`;
}

function hasActiveJob(jobs: JobSchema[] | undefined) {
  return jobs?.some((job) => CANCELABLE_JOB_STATUSES.has(job.status)) ?? false;
}

function bulkJobsSummary(action: BulkJobAction, response: BulkJobsResponse) {
  return `${action.resultLabel}: ${response.created_jobs?.length ?? 0} queued, ${response.skipped?.length ?? 0} skipped.`;
}

function bulkJobSkipReasonLabel(reason: BulkJobSkippedProject["reason"]) {
  switch (reason) {
    case "active_job":
      return "Already active";
    case "locked":
      return "Locked by sync";
    case "no_existing_stems":
      return "No existing stems";
    case "creation_failed":
      return "Could not queue";
    default:
      return "Skipped";
  }
}

function bulkJobSkippedProjectLabel(project: BulkJobSkippedProject) {
  return project.project_name ? `${project.project_name} (${project.project_id})` : project.project_id;
}

function groupedBulkJobSkips(skipped: BulkJobSkippedProject[] | undefined) {
  const groups: Array<{ reason: BulkJobSkippedProject["reason"]; projects: BulkJobSkippedProject[] }> = [];
  const groupByReason = new Map<BulkJobSkippedProject["reason"], BulkJobSkippedProject[]>();
  for (const skippedProject of skipped ?? []) {
    const existingGroup = groupByReason.get(skippedProject.reason);
    if (existingGroup) {
      existingGroup.push(skippedProject);
      continue;
    }
    const projects = [skippedProject];
    groupByReason.set(skippedProject.reason, projects);
    groups.push({ reason: skippedProject.reason, projects });
  }
  return groups;
}

function BulkJobSkipDetails({ response }: { response: BulkJobsResponse }) {
  const skipGroups = groupedBulkJobSkips(response.skipped);
  if (!skipGroups.length) {
    return null;
  }

  return (
    <div aria-label="Skipped projects" className="activity-bulk-skip-details">
      <ul>
        {skipGroups.map((group) => (
          <li key={group.reason}>
            <strong>{bulkJobSkipReasonLabel(group.reason)}:</strong>{" "}
            <span>{group.projects.map(bulkJobSkippedProjectLabel).join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function uniqueJobs(jobs: JobSchema[]) {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
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
  const stageLabel = formatJobStageLabel(job);
  const runtimeSummary = stageLabel ? formatJobRuntimeSummary(job) : null;
  const details = formatJobDetails(job, { includeRuntimeDevice: !runtimeSummary });
  const errorMessage = formatJobErrorMessage(job.error_message, job);
  const progress = formatJobProgressValue(job);
  const canCancel = CANCELABLE_JOB_STATUSES.has(job.status);
  const stageTone = TERMINAL_JOB_STATUSES.has(job.status) ? "terminal" : "active";

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
            {stageLabel ? (
              <div
                aria-label={canCancel ? activeStageStatusLabel(stageLabel, runtimeSummary) : undefined}
                className={`activity-job-row__stage-line activity-job-row__stage-line--${stageTone}`}
                role={canCancel ? "status" : undefined}
              >
                <strong className="activity-job-row__stage">{stageLabel}</strong>
                {runtimeSummary ? (
                  <span className="activity-job-row__runtime">{runtimeSummary}</span>
                ) : null}
              </div>
            ) : null}
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

        {errorMessage ? (
          <p className="activity-job-row__error" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </article>
    </li>
  );
}

export function ActivityView() {
  const [activeTab, setActiveTab] = useState<ActivityTab>("jobs");
  const [searchDraft, setSearchDraft] = useState("");
  const [bulkJobResult, setBulkJobResult] = useState<{
    action: BulkJobAction;
    response: BulkJobsResponse;
  } | null>(null);
  const deferredSearch = useDeferredValue(searchDraft.trim());
  const previousActiveJobIds = useRef<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const { defaultStemModel } = usePreferences();
  const { beatBackendForAction } = useBeatBackendActionSelection();
  const { chordBackendForAction } = useChordBackendActionSelection();
  const activeJobsQueryKey = useMemo(
    () => [...ACTIVE_JOBS_QUERY_KEY, deferredSearch] as const,
    [deferredSearch],
  );
  const terminalJobsQueryKey = useMemo(
    () => [...TERMINAL_JOBS_QUERY_KEY, deferredSearch] as const,
    [deferredSearch],
  );
  const activeJobsQuery = useInfiniteQuery({
    queryKey: activeJobsQueryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = {
        status: [...ACTIVE_JOB_STATUSES],
        sort_by: "activity" as const,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        limit: ACTIVE_JOBS_LIMIT,
        offset: pageParam,
      };

      return api.listJobs(params);
    },
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.offset + lastPage.jobs.length : undefined,
  });
  const {
    data: activeJobsData,
    fetchNextPage: fetchNextActiveJobsPage,
    hasNextPage: hasNextActiveJobsPage,
    isError: isActiveJobsError,
    isFetchingNextPage: isFetchingNextActiveJobsPage,
    isLoading: isActiveJobsLoading,
    isSuccess: isActiveJobsSuccess,
  } = activeJobsQuery;
  const terminalJobsQuery = useInfiniteQuery({
    queryKey: terminalJobsQueryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = {
        status: [...TERMINAL_JOB_STATUS_VALUES],
        sort_by: "activity" as const,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        limit: TERMINAL_JOBS_PAGE_SIZE,
        offset: pageParam,
      };

      return api.listJobs(params);
    },
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.offset + lastPage.jobs.length : undefined,
  });
  const {
    data: terminalJobsData,
    fetchNextPage: fetchNextTerminalJobsPage,
    hasNextPage: hasNextTerminalJobsPage,
    isError: isTerminalJobsError,
    isFetchNextPageError: isFetchNextTerminalJobsPageError,
    isFetching: isFetchingTerminalJobs,
    isFetchingNextPage: isFetchingNextTerminalJobsPage,
    isLoading: isTerminalJobsLoading,
  } = terminalJobsQuery;
  const activeJobs = useMemo(
    () => activeJobsData?.pages.flatMap((page) => page.jobs) ?? EMPTY_JOBS,
    [activeJobsData],
  );
  const terminalJobs = useMemo(
    () => terminalJobsData?.pages.flatMap((page) => page.jobs) ?? EMPTY_JOBS,
    [terminalJobsData],
  );
  const jobs = useMemo(() => uniqueJobs([...activeJobs, ...terminalJobs]), [activeJobs, terminalJobs]);
  const jobProjectIds = useMemo(
    () =>
      Array.from(
        new Set(
          jobs
            .map((job) => job.project_id)
            .filter((projectId): projectId is string => Boolean(projectId)),
        ),
      ).sort(),
    [jobs],
  );
  const projectQueries = useQueries({
    queries: jobProjectIds.map((projectId) => ({
      queryKey: [...ACTIVITY_PROJECTS_QUERY_KEY, "detail", projectId],
      staleTime: ACTIVITY_PROJECT_STALE_MS,
      queryFn: async () => {
        try {
          const response = await api.getProject(projectId);
          return response.project;
        } catch {
          return null;
        }
      },
    })),
  });
  const cancelJobMutation = useMutation({
    mutationFn: (jobId: string) => api.cancelJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  const bulkJobsMutation = useMutation({
    mutationFn: async (action: BulkJobAction) => {
      const request: BulkJobRequest = { job_type: action.jobType };
      if (action.jobType === "analyze") {
        const beatBackendSelection = await beatBackendForAction();
        request.beat_backend = beatBackendSelection.beat_backend;
      }
      if (action.jobType === "chords" || action.jobType === "stems") {
        const backendSelection = await chordBackendForAction();
        request.chord_backend = backendSelection.backend;
        if (backendSelection.backend_fallback_from) {
          request.chord_backend_fallback_from = backendSelection.backend_fallback_from;
        }
      }
      if (action.jobType === "stems") {
        request.stem_model = defaultStemModel;
      }
      return api.bulkJobs(request);
    },
    onMutate: () => {
      setBulkJobResult(null);
    },
    onSuccess: async (response, action) => {
      setBulkJobResult({ action, response });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const projectsById = useMemo(
    () => new Map(jobProjectIds.map((projectId, index) => [projectId, projectQueries[index]?.data ?? null])),
    [jobProjectIds, projectQueries],
  );
  const displayJobs = useMemo(() => orderJobsForQueue(jobs), [jobs]);
  const activeJobCount = displayJobs.filter(({ job }) => CANCELABLE_JOB_STATUSES.has(job.status)).length;
  const shouldPollJobs = hasActiveJob(activeJobs);
  const isLoading = isActiveJobsLoading || isTerminalJobsLoading;
  const isError = isActiveJobsError || isTerminalJobsError;
  const showJobList = !isLoading && !isError && displayJobs.length > 0;
  const showEmptyState = !isLoading && !isError && displayJobs.length === 0;
  const { loadNextPage: loadNextTerminalJobsPage, sentinelRef: terminalHistorySentinelRef } =
    useLazyLoadSentinel({
      enabled:
        activeTab === "jobs" &&
        !isFetchingTerminalJobs &&
        !isTerminalJobsError &&
        !isFetchNextTerminalJobsPageError,
      fetchNextPage: fetchNextTerminalJobsPage,
      hasNextPage: hasNextTerminalJobsPage,
      isFetchingNextPage: isFetchingNextTerminalJobsPage,
      rootMargin: "160px 0px",
    });

  useEffect(() => {
    if (!shouldPollJobs) return;

    const interval = window.setInterval(async () => {
      await queryClient.invalidateQueries({ queryKey: activeJobsQueryKey });
    }, ACTIVE_JOB_REFETCH_MS);

    return () => window.clearInterval(interval);
  }, [activeJobsQueryKey, queryClient, shouldPollJobs]);

  useEffect(() => {
    if (!hasNextActiveJobsPage || isFetchingNextActiveJobsPage) return;

    fetchNextActiveJobsPage();
  }, [fetchNextActiveJobsPage, hasNextActiveJobsPage, isFetchingNextActiveJobsPage]);

  useEffect(() => {
    if (!isActiveJobsSuccess) return;

    const currentActiveJobIds = new Set(activeJobs.map((job) => job.id));
    const activeJobLeftQueue = [...previousActiveJobIds.current].some(
      (jobId) => !currentActiveJobIds.has(jobId),
    );
    previousActiveJobIds.current = currentActiveJobIds;

    if (activeJobLeftQueue) {
      queryClient.invalidateQueries({ queryKey: terminalJobsQueryKey });
    }
  }, [activeJobs, isActiveJobsSuccess, queryClient, terminalJobsQueryKey]);

  async function handleBulkJobAction(action: BulkJobAction) {
    bulkJobsMutation.reset();
    setBulkJobResult(null);
    const approved = await confirm(action.confirmBody, {
      title: action.confirmTitle,
      kind: "warning",
      okLabel: action.okLabel,
      cancelLabel: "Cancel",
    });
    if (!approved) {
      return;
    }
    bulkJobsMutation.mutate(action);
  }

  return (
    <section className="screen activity-screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">Activity</p>
          <h1>Activity</h1>
          <p className="screen__subtitle">Review local processing and sync lab activity.</p>
        </div>
      </div>

      <div className="project-workspace-tabs" role="tablist" aria-label="Activity">
        {ACTIVITY_TABS.map((tab) => (
          <button
            aria-controls={`activity-${tab.id}-panel`}
            aria-selected={activeTab === tab.id}
            className={`project-workspace-tabs__button${
              activeTab === tab.id ? " project-workspace-tabs__button--active" : ""
            }`}
            id={`activity-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "jobs" ? (
        <section
          aria-labelledby="activity-jobs-heading"
          className="panel activity-jobs-panel"
          id="activity-jobs-panel"
          role="tabpanel"
        >
          <div className="panel-heading activity-jobs-panel__heading">
            <div>
              <h2 id="activity-jobs-heading">Jobs</h2>
              <p className="subpanel__copy">
                {activeJobCount
                  ? `${activeJobCount} active job${activeJobCount === 1 ? "" : "s"} in the queue.`
                  : "No pending or running jobs."}
              </p>
            </div>
            <div className="activity-jobs-panel__heading-actions">
              <label className="search-field">
                <span className="search-field__label">Search jobs</span>
                <input
                  aria-label="Search jobs by project"
                  className="search-field__input"
                  placeholder="Search project names"
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
              </label>
            </div>
          </div>
          <div aria-label="Bulk job actions" className="activity-bulk-actions" role="group">
            {BULK_JOB_ACTIONS.map((action) => {
              const Icon = action.icon;
              const isPending = bulkJobsMutation.isPending &&
                bulkJobsMutation.variables?.jobType === action.jobType;
              return (
                <button
                  className="button button--ghost button--small activity-bulk-actions__button"
                  disabled={bulkJobsMutation.isPending}
                  key={action.jobType}
                  onClick={() => {
                    void handleBulkJobAction(action);
                  }}
                  type="button"
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>{isPending ? "Queueing..." : action.label}</span>
                </button>
              );
            })}
          </div>

          {bulkJobsMutation.isPending ? (
            <div className="activity-jobs-panel__state" role="status">
              {bulkJobsMutation.variables?.pendingLabel ?? "Queueing bulk jobs..."}
            </div>
          ) : null}

          {bulkJobResult ? (
            <div className="activity-jobs-panel__state activity-jobs-panel__state--success" role="status">
              {bulkJobsSummary(bulkJobResult.action, bulkJobResult.response)}
              <BulkJobSkipDetails response={bulkJobResult.response} />
            </div>
          ) : null}

          {bulkJobsMutation.isError ? (
            <div className="activity-jobs-panel__state activity-jobs-panel__state--error" role="alert">
              {bulkJobsMutation.error instanceof Error
                ? bulkJobsMutation.error.message
                : "Could not queue bulk jobs."}
            </div>
          ) : null}

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

          {hasNextTerminalJobsPage ? (
            <div className="activity-jobs-panel__load-more" ref={terminalHistorySentinelRef}>
              <button
                className="button button--ghost"
                disabled={isFetchingNextTerminalJobsPage}
                onClick={loadNextTerminalJobsPage}
                type="button"
              >
                {isFetchingNextTerminalJobsPage ? "Loading history..." : "Load more history"}
              </button>
            </div>
          ) : null}

          {showEmptyState ? (
            <div className="activity-jobs-panel__empty">
              <h3>{deferredSearch ? "No matching jobs" : "No jobs yet"}</h3>
              <p>
                {deferredSearch
                  ? "Try a different project name or clear the search."
                  : "Import or process a track to populate the queue."}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeTab === "sync" ? <ActivitySyncPanel /> : null}
    </section>
  );
}
