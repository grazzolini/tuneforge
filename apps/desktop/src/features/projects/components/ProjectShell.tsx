import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { InspectorPanel } from "./InspectorPanel";
import { JobsHistory } from "./JobsHistory";
import { PlaybackStage } from "./PlaybackStage";
import { ProjectHeader } from "./ProjectHeader";
import { SourcesRail } from "./SourcesRail";

export function ProjectShell() {
  const { inspectorOpen, sourcesRailCollapsed } = useProjectViewModelContext();

  return (
    <section className="screen">
      <ProjectHeader />

      <div
        className={`project-workbench${inspectorOpen ? "" : " project-workbench--wide"}${
          sourcesRailCollapsed ? " project-workbench--sources-collapsed" : ""
        }`}
      >
        <SourcesRail />
        <div className="stack">
          <PlaybackStage />
          <JobsHistory />
        </div>
        {inspectorOpen ? <InspectorPanel /> : null}
      </div>
    </section>
  );
}
