import { Activity, Download, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ProjectPanelMode } from "../projectPlaybackState";
import { ExportWorkspace } from "./ExportWorkspace";
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
  const panelModes: ProjectPanelMode[] = ["studio", "analysis", "export"];

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentMode: ProjectPanelMode) {
    const currentIndex = panelModes.indexOf(currentMode);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? panelModes.length - 1
        : event.key === "ArrowRight"
          ? (currentIndex + 1) % panelModes.length
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + panelModes.length) % panelModes.length
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = panelModes[nextIndex];
    handleSelectProjectPanel(nextMode);
    document.getElementById(`project-${nextMode}-tab`)?.focus();
  }

  return (
    <div className="project-workspace">
      <div className="project-panel-toolbar">
        <div className="project-panel-tabs" role="tablist" aria-label="Project sections">
          <button
            aria-controls="project-studio-panel"
            aria-selected={activeProjectPanel === "studio"}
            className={`project-panel-tabs__button${
              activeProjectPanel === "studio" ? " project-panel-tabs__button--active" : ""
            }`}
            id="project-studio-tab"
            onKeyDown={(event) => handleTabKeyDown(event, "studio")}
            onClick={() => handleSelectProjectPanel("studio")}
            role="tab"
            tabIndex={activeProjectPanel === "studio" ? 0 : -1}
            type="button"
          >
            <SlidersHorizontal aria-hidden="true" className="project-panel-tabs__icon" />
            <span>Studio</span>
          </button>
          <button
            aria-controls="project-analysis-panel"
            aria-selected={activeProjectPanel === "analysis"}
            className={`project-panel-tabs__button${
              activeProjectPanel === "analysis" ? " project-panel-tabs__button--active" : ""
            }`}
            id="project-analysis-tab"
            onKeyDown={(event) => handleTabKeyDown(event, "analysis")}
            onClick={() => handleSelectProjectPanel("analysis")}
            role="tab"
            tabIndex={activeProjectPanel === "analysis" ? 0 : -1}
            type="button"
          >
            <Activity aria-hidden="true" className="project-panel-tabs__icon" />
            <span>Analysis</span>
          </button>
          <button
            aria-controls="project-export-panel"
            aria-selected={activeProjectPanel === "export"}
            className={`project-panel-tabs__button${
              activeProjectPanel === "export" ? " project-panel-tabs__button--active" : ""
            }`}
            id="project-export-tab"
            onKeyDown={(event) => handleTabKeyDown(event, "export")}
            onClick={() => handleSelectProjectPanel("export")}
            role="tab"
            tabIndex={activeProjectPanel === "export" ? 0 : -1}
            type="button"
          >
            <Download aria-hidden="true" className="project-panel-tabs__icon" />
            <span>Export</span>
          </button>
        </div>
      </div>

      {activeProjectPanel === "studio" ? (
        <div
          aria-labelledby="project-studio-tab"
          className={`project-workbench project-workbench--studio${
            inspectorOpen ? "" : " project-workbench--inspector-collapsed"
          }${sourcesRailCollapsed ? " project-workbench--sources-collapsed" : ""}`}
          id="project-studio-panel"
          role="tabpanel"
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
      ) : activeProjectPanel === "analysis" ? (
        <div aria-labelledby="project-analysis-tab" className="project-analysis-workspace" id="project-analysis-panel" role="tabpanel">
          <InspectorPanel mode="analysis" />
          <JobsHistory />
        </div>
      ) : (
        <ExportWorkspace />
      )}
    </div>
  );
}
