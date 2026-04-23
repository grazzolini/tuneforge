import { ProjectShell } from "./components/ProjectShell";
import { ProjectViewModelProvider } from "./components/ProjectViewModelContext";
import { useProjectViewModel } from "./hooks/useProjectViewModel";

export function ProjectView() {
  const model = useProjectViewModel();

  return (
    <ProjectViewModelProvider model={model}>
      <ProjectShell />
    </ProjectViewModelProvider>
  );
}
