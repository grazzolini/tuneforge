import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { PlaybackWorkspace } from "./PlaybackWorkspace";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectWorkspace } from "./ProjectWorkspace";

export function ProjectShell() {
  const { activeWorkspace, handleSelectWorkspace } = useProjectViewModelContext();

  return (
    <section className={`screen project-screen project-screen--${activeWorkspace}`}>
      <ProjectHeader />

      <div className="project-workspace-tabs" role="tablist" aria-label="Project workspace">
        {(["project", "playback"] as const).map((workspace) => (
          <button
            key={workspace}
            aria-selected={activeWorkspace === workspace}
            className={`project-workspace-tabs__button${
              activeWorkspace === workspace ? " project-workspace-tabs__button--active" : ""
            }`}
            onClick={() => handleSelectWorkspace(workspace)}
            role="tab"
            type="button"
          >
            {workspace === "project" ? "Project" : "Playback"}
          </button>
        ))}
      </div>

      {activeWorkspace === "project" ? <ProjectWorkspace /> : <PlaybackWorkspace />}
    </section>
  );
}
