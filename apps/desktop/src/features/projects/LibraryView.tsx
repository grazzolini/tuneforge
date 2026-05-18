import { startTransition, useDeferredValue, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Music2, Upload } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ProjectSchema } from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime } from "../../lib/datetime";
import { usePreferences } from "../../lib/preferences";
import { useChordBackendActionSelection } from "./hooks/useChordBackendActionSelection";

const MAX_IMPORT_SELECTION = 25;

function formatDuration(durationSeconds: number | null | undefined) {
  if (!durationSeconds) return "Unknown length";
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = Math.round(durationSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatUpdatedAt(value: string) {
  return formatLocalDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ProjectCard({ project }: { project: ProjectSchema }) {
  const { informationDensity } = usePreferences();
  const updatedAtLabel = formatUpdatedAt(project.updated_at);
  const normalizedUpdatedAt = normalizeApiDateTime(project.updated_at);
  const fileType = project.source_path.split(".").pop()?.toUpperCase() ?? "Audio";

  return (
    <article className="project-card project-library-row">
      <Link
        aria-label={`Open ${project.display_name} project`}
        className="project-card__link"
        to={`/projects/${project.id}`}
      >
        <span className="project-library-row__icon" aria-hidden="true">
          <Music2 />
        </span>

        <div className="project-card__title-block">
          <h2>{project.display_name}</h2>
          {informationDensity === "detailed" ? (
            <span className="artifact-meta">{project.source_path}</span>
          ) : null}
        </div>

        <div className="project-library-row__cell project-library-row__cell--date">
          <time dateTime={normalizedUpdatedAt}>{updatedAtLabel}</time>
        </div>

        <div className="project-card__stats" role="list" aria-label={`${project.display_name} summary`}>
          <span className="stat-chip" role="listitem">
            {fileType}
          </span>
          <span className="stat-chip" role="listitem">
            {formatDuration(project.duration_seconds)}
          </span>
          {informationDensity !== "minimal" ? (
            <span className="stat-chip" role="listitem">
              {project.channels ? `${project.channels} ch` : "Channels n/a"}
            </span>
          ) : null}
          {informationDensity === "detailed" ? (
            <span className="stat-chip" role="listitem">
              {project.sample_rate ? `${project.sample_rate} Hz` : "Sample rate n/a"}
            </span>
          ) : null}
        </div>

      </Link>

      <details className="card-details">
        <summary>Show file details</summary>
        <dl className="details-grid details-grid--single-column">
          <div>
            <dt>Original Source</dt>
            <dd className="path">{project.source_path}</dd>
          </div>
          <div>
            <dt>Imported Audio</dt>
            <dd className="path">{project.imported_path}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

type ImportNotice =
  | { kind: "duplicate"; message: string; projectId: string }
  | { kind: "summary"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };

type BatchImportSummary = {
  failures: Array<{ message: string; sourcePath: string }>;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
};

type ImportMutationResult =
  | { kind: "none" }
  | { kind: "selectionLimit" }
  | { kind: "single"; project: ProjectSchema }
  | { kind: "batch"; summary: BatchImportSummary };

function normalizeImportSelection(selection: string | string[] | null): string[] {
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

function getUniqueImportPaths(paths: string[]) {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  let duplicateCount = 0;

  for (const path of paths) {
    if (seen.has(path)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(path);
    uniquePaths.push(path);
  }

  return { duplicateCount, uniquePaths };
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatBatchImportSummary({ importedCount, skippedCount, failedCount }: BatchImportSummary) {
  return `${importedCount} ${pluralize(importedCount, "track")} imported, ${skippedCount} ${pluralize(
    skippedCount,
    "duplicate",
  )} skipped, ${failedCount} failed.`;
}

function formatBatchFailureSummary(failures: BatchImportSummary["failures"]) {
  if (!failures.length) {
    return "";
  }

  const visibleFailures = failures.slice(0, 3);
  const hiddenFailureCount = failures.length - visibleFailures.length;
  const failureSummary = visibleFailures
    .map((failure) => `${failure.sourcePath}: ${trimTrailingPeriod(failure.message)}`)
    .join("; ");
  return ` Failed: ${failureSummary}${hiddenFailureCount ? `; and ${hiddenFailureCount} more` : ""}.`;
}

function trimTrailingPeriod(value: string) {
  return value.replace(/[.]+$/, "");
}

function formatBatchImportNotice(summary: BatchImportSummary) {
  return `${formatBatchImportSummary(summary)}${formatBatchFailureSummary(summary.failures)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDuplicateProjectSourceError(error: unknown): error is Record<string, unknown> {
  return isRecord(error) && error.code === "DUPLICATE_PROJECT_SOURCE";
}

function getDuplicateImportNotice(error: unknown): ImportNotice | null {
  if (!isDuplicateProjectSourceError(error) || !isRecord(error.details)) {
    return null;
  }

  const projectId = error.details.project_id;
  const projectName = error.details.project_name;
  if (typeof projectId !== "string" || typeof projectName !== "string" || !projectId || !projectName) {
    return null;
  }

  return {
    kind: "duplicate",
    message: `This project is already imported with name "${projectName}".`,
    projectId,
  };
}

function getImportErrorNotice(error: unknown): ImportNotice {
  const duplicateNotice = getDuplicateImportNotice(error);
  if (duplicateNotice) {
    return duplicateNotice;
  }

  const message = getImportErrorMessage(error);
  return { kind: "error", message: `Could not import track. ${message}` };
}

function getImportErrorMessage(error: unknown) {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : "The request failed.";
  return message;
}

function getImportNoticeClassName(importNotice: ImportNotice) {
  if (importNotice.kind === "error") {
    return "panel library-import-notice panel--error";
  }
  if (importNotice.kind === "duplicate" || importNotice.kind === "warning") {
    return "panel library-import-notice panel--warning";
  }
  return "panel library-import-notice";
}

function getImportNoticeRole(importNotice: ImportNotice) {
  return importNotice.kind === "error" ? "alert" : "status";
}

export function LibraryView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { defaultStemModel, informationDensity } = usePreferences();
  const { chordBackendForAction } = useChordBackendActionSelection();
  const [searchDraft, setSearchDraft] = useState("");
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const deferredSearch = useDeferredValue(searchDraft.trim());
  const showSubtitle = informationDensity !== "minimal";

  const projectsQuery = useQuery({
    queryKey: ["projects", deferredSearch],
    queryFn: async () => (await api.listProjects(deferredSearch || undefined)).projects,
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const selection = await open({
        directory: false,
        multiple: true,
        filters: [
          {
            name: "Audio / Video",
            extensions: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "mp4", "webm"],
          },
        ],
      });
      const selectedPaths = normalizeImportSelection(selection);
      if (!selectedPaths.length) {
        return { kind: "none" } satisfies ImportMutationResult;
      }
      const { duplicateCount, uniquePaths } = getUniqueImportPaths(selectedPaths);
      if (uniquePaths.length > MAX_IMPORT_SELECTION) {
        return { kind: "selectionLimit" } satisfies ImportMutationResult;
      }
      const backendSelection = await chordBackendForAction();
      const importPayload = {
        copy_into_project: true,
        chord_backend: backendSelection.backend,
        stem_model: defaultStemModel,
        ...(backendSelection.backend_fallback_from
          ? { chord_backend_fallback_from: backendSelection.backend_fallback_from }
          : {}),
      };

      if (selectedPaths.length === 1) {
        const sourcePath = uniquePaths[0];
        if (!sourcePath) {
          return { kind: "none" } satisfies ImportMutationResult;
        }
        const response = await api.importProject({
          source_path: sourcePath,
          ...importPayload,
        });
        return { kind: "single", project: response.project } satisfies ImportMutationResult;
      }

      let importedCount = 0;
      let skippedCount = duplicateCount;
      let failedCount = 0;
      const failures: BatchImportSummary["failures"] = [];

      for (const sourcePath of uniquePaths) {
        try {
          await api.importProject({
            source_path: sourcePath,
            ...importPayload,
          });
          importedCount += 1;
        } catch (error) {
          if (isDuplicateProjectSourceError(error)) {
            skippedCount += 1;
          } else {
            failedCount += 1;
            failures.push({ sourcePath, message: getImportErrorMessage(error) });
          }
        }
      }

      return {
        kind: "batch",
        summary: { failures, importedCount, skippedCount, failedCount },
      } satisfies ImportMutationResult;
    },
    onMutate: () => {
      setImportNotice(null);
    },
    onSuccess: async (result) => {
      if (result.kind === "none") {
        return;
      }
      if (result.kind === "selectionLimit") {
        setImportNotice({ kind: "warning", message: "Select up to 25 tracks at a time." });
        return;
      }
      if (result.kind === "single") {
        setImportNotice(null);
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
        navigate(`/projects/${result.project.id}`);
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      ]);
      setImportNotice({
        kind: result.summary.failedCount ? "warning" : "summary",
        message: formatBatchImportNotice(result.summary),
      });
    },
    onError: (error) => {
      setImportNotice(getImportErrorNotice(error));
    },
  });

  const resultCount = projectsQuery.data?.length ?? 0;

  return (
    <section className="screen">
      <div className="screen__header screen__header--library">
        <div className="screen__title-block">
          <p className="eyebrow">Library</p>
          <h1>Practice Projects</h1>
          {showSubtitle ? (
            <p className="screen__subtitle">
              Keep songs, saved mixes, and stem-ready practice sessions close to playback.
            </p>
          ) : null}
        </div>
        <button
          className="button button--primary"
          onClick={() => importMutation.mutate()}
          disabled={importMutation.isPending}
        >
          {importMutation.isPending ? "Importing..." : "Import Track(s)"}
          <Upload aria-hidden="true" className="button__icon" />
        </button>
      </div>

      {importNotice ? (
        <div
          className={getImportNoticeClassName(importNotice)}
          role={getImportNoticeRole(importNotice)}
        >
          <span>{importNotice.message}</span>
          {importNotice.kind === "duplicate" ? (
            <Link className="button button--ghost button--small" to={`/projects/${importNotice.projectId}`}>
              Open project
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="panel library-toolbar">
        <label className="search-field">
          <span className="search-field__label">Search library</span>
          <input
            aria-label="Search projects"
            className="search-field__input"
            placeholder="Search by name or file path"
            type="search"
            value={searchDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              startTransition(() => {
                setSearchDraft(nextValue);
              });
            }}
          />
        </label>
        <div className="library-toolbar__summary" aria-live="polite">
          {deferredSearch ? (
            resultCount ? (
              <span>
                {resultCount} match{resultCount === 1 ? "" : "es"} for "{deferredSearch}"
              </span>
            ) : (
              <span>No matches for "{deferredSearch}"</span>
            )
          ) : (
            <span>
              {resultCount} project{resultCount === 1 ? "" : "s"} ready
            </span>
          )}
        </div>
      </div>

      {projectsQuery.isLoading ? <div className="panel">Loading projects...</div> : null}
      {projectsQuery.isError ? (
        <div className="panel panel--error">Could not load projects.</div>
      ) : null}

      <div className="project-grid project-library-table">
        {projectsQuery.data?.length ? (
          <>
            <div className="project-library-table__header" aria-hidden="true">
              <span />
              <span>Title</span>
              <span>Updated</span>
              <span>Format / Duration</span>
            </div>
            {projectsQuery.data.map((project) => <ProjectCard key={project.id} project={project} />)}
          </>
        ) : (
          <div className="panel panel--empty">
            <h2>{deferredSearch ? "No matching projects" : "No projects yet"}</h2>
            <p>
              {deferredSearch
                ? "Try a different name or clear the search."
                : "Import a track to create the first playback-ready project."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
