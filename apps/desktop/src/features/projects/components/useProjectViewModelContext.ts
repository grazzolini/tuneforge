import { createContext, useContext } from "react";
import type { ProjectViewModel } from "../hooks/useProjectViewModel";

export const ProjectViewModelContext = createContext<ProjectViewModel | null>(null);

export function useProjectViewModelContext() {
  const context = useContext(ProjectViewModelContext);
  if (!context) {
    throw new Error("useProjectViewModelContext must be used within a ProjectViewModelProvider.");
  }
  return context;
}
