import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { ProjectShell } from "./components/ProjectShell";
import { ProjectViewModelProvider } from "./components/ProjectViewModelContext";
import { useProjectViewModel } from "./hooks/useProjectViewModel";
import { useMetronome } from "../tools/metronome-context";

export function ProjectView() {
  const mobileCapabilitiesQuery = useQuery({
    queryKey: ["runtime", "mobile-capabilities"],
    queryFn: () => api.getMobileCapabilities(),
  });
  const isIOSHost = /\b(iPhone|iPad|iPod)\b/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (isIOSHost && mobileCapabilitiesQuery.isPending) {
    return <div className="panel" role="status">Loading project runtime...</div>;
  }
  if (isIOSHost && mobileCapabilitiesQuery.isError) {
    return (
      <div className="panel panel--error" role="alert">
        Could not verify project support.
        <button className="button button--ghost" onClick={() => void mobileCapabilitiesQuery.refetch()} type="button">
          Retry
        </button>
      </div>
    );
  }
  if (mobileCapabilitiesQuery.data?.platform === "ios") {
    return (
      <div className="panel">
        <h1>Project playback unavailable</h1>
        <p>Browse synced project and artifact details from Library.</p>
        <Link className="button button--ghost" to="/">Back to Library</Link>
      </div>
    );
  }
  return <FullProjectView />;
}

function FullProjectView() {
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
