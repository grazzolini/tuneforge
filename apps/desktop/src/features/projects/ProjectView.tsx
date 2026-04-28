import { useEffect } from "react";
import { ProjectShell } from "./components/ProjectShell";
import { ProjectViewModelProvider } from "./components/ProjectViewModelContext";
import { useProjectViewModel } from "./hooks/useProjectViewModel";
import { useMetronome } from "../tools/metronome-context";

export function ProjectView() {
  const model = useProjectViewModel();
  const { followPlayback, seedBpm } = useMetronome();
  const tempoBpm = model.analysisQuery.data?.tempo_bpm;

  useEffect(() => {
    if (!followPlayback || typeof tempoBpm !== "number" || !Number.isFinite(tempoBpm)) {
      return;
    }

    seedBpm(tempoBpm);
  }, [followPlayback, seedBpm, tempoBpm]);

  return (
    <ProjectViewModelProvider model={model}>
      <ProjectShell />
    </ProjectViewModelProvider>
  );
}
