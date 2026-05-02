import { Activity, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { InspectorPanel } from "./InspectorPanel";
import { JobsHistory } from "./JobsHistory";
import { ProcessingPanel } from "./ProcessingPanel";
import { ProjectPlaybackSummary } from "./ProjectPlaybackSummary";
import { SourcesRail } from "./SourcesRail";

export function ProjectWorkspace() {
  const {
    activeProjectPanel,
    handleSelectProjectPanel,
    inspectorOpen,
    setInspectorOpen,
    sourcesRailCollapsed,
  } = useProjectViewModelContext();

  return (
    <div className="project-workspace">
      <div className="project-panel-toolbar">
        <div className="project-panel-tabs" role="tablist" aria-label="Project sections">
          <button
            aria-selected={activeProjectPanel === "studio"}
            className={`project-panel-tabs__button${
              activeProjectPanel === "studio" ? " project-panel-tabs__button--active" : ""
            }`}
            onClick={() => handleSelectProjectPanel("studio")}
            role="tab"
            type="button"
          >
            <SlidersHorizontal aria-hidden="true" className="project-panel-tabs__icon" />
            <span>Studio</span>
          </button>
          <button
            aria-selected={activeProjectPanel === "analysis"}
            className={`project-panel-tabs__button${
              activeProjectPanel === "analysis" ? " project-panel-tabs__button--active" : ""
            }`}
            onClick={() => handleSelectProjectPanel("analysis")}
            role="tab"
            type="button"
          >
            <Activity aria-hidden="true" className="project-panel-tabs__icon" />
            <span>Analysis</span>
          </button>
        </div>
      </div>

      {activeProjectPanel === "studio" ? (
        <div
          className={`project-workbench project-workbench--studio${
            inspectorOpen ? "" : " project-workbench--inspector-collapsed"
          }${sourcesRailCollapsed ? " project-workbench--sources-collapsed" : ""}`}
        >
          <SourcesRail />
          <div className="stack project-studio-main">
            <ProjectPlaybackSummary />
            <ProcessingPanel />
          </div>
          {inspectorOpen ? (
            <InspectorPanel mode="studio" />
          ) : (
            <button
              aria-label="Show Inspector"
              className="panel inspector-collapsed"
              onClick={() => setInspectorOpen(true)}
              title="Show Inspector"
              type="button"
            >
              <PanelRightOpen aria-hidden="true" className="project-inspector-toggle__icon" />
              <span>Mix Builder</span>
            </button>
          )}
        </div>
      ) : (
        <div className="project-analysis-workspace">
          <InspectorPanel mode="analysis" />
          <JobsHistory />
        </div>
      )}
    </div>
  );
}
