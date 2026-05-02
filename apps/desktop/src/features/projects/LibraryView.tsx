import { startTransition, useDeferredValue, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Music2, Upload } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ProjectSchema } from "../../lib/api";
import { formatLocalDateTime, normalizeApiDateTime } from "../../lib/datetime";
import { usePreferences } from "../../lib/preferences";
import { useChordBackendActionSelection } from "./hooks/useChordBackendActionSelection";

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

export function LibraryView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { informationDensity } = usePreferences();
  const { chordBackendForAction } = useChordBackendActionSelection();
  const [searchDraft, setSearchDraft] = useState("");
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
        multiple: false,
        filters: [
          {
            name: "Audio / Video",
            extensions: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "mp4", "webm"],
          },
        ],
      });
      if (!selection || Array.isArray(selection)) {
        return null;
      }
      const backendSelection = await chordBackendForAction();
      const response = await api.importProject({
        source_path: selection,
        copy_into_project: true,
        chord_backend: backendSelection.backend,
        ...(backendSelection.backend_fallback_from
          ? { chord_backend_fallback_from: backendSelection.backend_fallback_from }
          : {}),
      });
      return response.project;
    },
    onSuccess: async (project) => {
      if (!project) return;
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${project.id}`);
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
          {importMutation.isPending ? "Importing..." : "Import Track"}
          <Upload aria-hidden="true" className="button__icon" />
        </button>
      </div>

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
