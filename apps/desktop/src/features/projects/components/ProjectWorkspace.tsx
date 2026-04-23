import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { InspectorPanel } from "./InspectorPanel";
import { JobsHistory } from "./JobsHistory";
import { ProjectPlaybackSummary } from "./ProjectPlaybackSummary";
import { SourcesRail } from "./SourcesRail";

export function ProjectWorkspace() {
  const { inspectorOpen, sourcesRailCollapsed } = useProjectViewModelContext();

  return (
    <div
      className={`project-workbench${inspectorOpen ? "" : " project-workbench--wide"}${
        sourcesRailCollapsed ? " project-workbench--sources-collapsed" : ""
      }`}
    >
      <SourcesRail />
      <div className="stack">
        <ProjectPlaybackSummary />
        <JobsHistory />
      </div>
      {inspectorOpen ? <InspectorPanel /> : null}
    </div>
  );
}
