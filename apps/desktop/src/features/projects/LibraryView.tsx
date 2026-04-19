import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Link, useNavigate } from "react-router-dom";
import { api, type ProjectSchema } from "../../lib/api";

function formatDuration(durationSeconds: number | null | undefined) {
  if (!durationSeconds) return "Unknown";
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = Math.round(durationSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function ProjectCard({ project }: { project: ProjectSchema }) {
  return (
    <Link className="project-card" to={`/projects/${project.id}`}>
      <div className="project-card__header">
        <h3>{project.display_name}</h3>
        <span>{formatDuration(project.duration_seconds)}</span>
      </div>
      <p>{project.sample_rate ? `${project.sample_rate} Hz` : "Sample rate unknown"}</p>
      <p>{project.channels ? `${project.channels} channels` : "Channels unknown"}</p>
      <small>{project.source_path}</small>
    </Link>
  );
}

export function LibraryView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.listProjects()).projects,
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
      const response = await api.importProject({
        source_path: selection,
        copy_into_project: true,
      });
      return response.project;
    },
    onSuccess: async (project) => {
      if (!project) return;
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${project.id}`);
    },
  });

  return (
    <section className="screen">
      <div className="screen__header">
        <div>
          <p className="eyebrow">Library</p>
          <h1>Practice Projects</h1>
          <p className="screen__subtitle">
            Import a local song, save alternate mixes, and keep practice versions ready to play.
          </p>
        </div>
        <button
          className="button button--primary"
          onClick={() => importMutation.mutate()}
          disabled={importMutation.isPending}
        >
          {importMutation.isPending ? "Importing…" : "Import Track"}
        </button>
      </div>

      {projectsQuery.isLoading ? <div className="panel">Loading projects…</div> : null}
      {projectsQuery.isError ? (
        <div className="panel panel--error">Could not load projects.</div>
      ) : null}

      <div className="project-grid">
        {projectsQuery.data?.length ? (
          projectsQuery.data.map((project) => <ProjectCard key={project.id} project={project} />)
        ) : (
          <div className="panel panel--empty">
            <h2>No projects yet</h2>
            <p>Use the import action to create the first project.</p>
          </div>
        )}
      </div>
    </section>
  );
}
