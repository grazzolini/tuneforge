import type { ReactNode } from "react";
import type { ProjectViewModel } from "../hooks/useProjectViewModel";
import { ProjectViewModelContext } from "./useProjectViewModelContext";

export function ProjectViewModelProvider({
  children,
  model,
}: {
  children: ReactNode;
  model: ProjectViewModel;
}) {
  return (
    <ProjectViewModelContext.Provider value={model}>
      {children}
    </ProjectViewModelContext.Provider>
  );
}
