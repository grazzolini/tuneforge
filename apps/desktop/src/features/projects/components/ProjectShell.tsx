import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectViewModelContext } from "./useProjectViewModelContext";
import { PlaybackWorkspace } from "./PlaybackWorkspace";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectWorkspace } from "./ProjectWorkspace";

export function ProjectShell() {
  const {
    activeWorkspace,
    exportRecoveryNoticeId,
    exportRecoveryNoticeProjectId,
    handleSelectWorkspace,
    isMobileRuntime,
    projectId,
  } = useProjectViewModelContext();
  const [practiceControlsOpen, setPracticeControlsOpen] = useState(false);
  const [showExportRecoveryNotice, setShowExportRecoveryNotice] = useState(false);
  const screenRef = useRef<HTMLElement>(null);
  const mobilePlayback = isMobileRuntime && activeWorkspace === "playback";
  const closePracticeControls = useCallback(() => setPracticeControlsOpen(false), []);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) {
      return;
    }
    const underlay = screen.closest<HTMLElement>(".app-shell") ?? screen;
    if (practiceControlsOpen) {
      underlay.setAttribute("inert", "");
      underlay.setAttribute("aria-hidden", "true");
    } else {
      underlay.removeAttribute("inert");
      underlay.removeAttribute("aria-hidden");
    }
    return () => {
      underlay.removeAttribute("inert");
      underlay.removeAttribute("aria-hidden");
    };
  }, [practiceControlsOpen]);

  useEffect(() => {
    if (!mobilePlayback) {
      setPracticeControlsOpen(false);
    }
  }, [mobilePlayback]);

  useEffect(() => {
    if (!exportRecoveryNoticeId || exportRecoveryNoticeProjectId !== projectId) {
      setShowExportRecoveryNotice(false);
      return;
    }
    setShowExportRecoveryNotice(true);
    const timeoutId = window.setTimeout(() => setShowExportRecoveryNotice(false), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [exportRecoveryNoticeId, exportRecoveryNoticeProjectId, projectId]);

  return (
    <section
      className={`screen project-screen project-screen--${activeWorkspace}`}
      ref={screenRef}
    >
      <ProjectHeader onOpenPracticeControls={() => setPracticeControlsOpen(true)} />

      {!mobilePlayback ? (
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
      ) : null}

      {activeWorkspace === "project" ? (
        <ProjectWorkspace />
      ) : (
        <PlaybackWorkspace
          practiceControlsOpen={practiceControlsOpen}
          onClosePracticeControls={closePracticeControls}
        />
      )}
      {showExportRecoveryNotice ? (
        <div aria-atomic="true" aria-live="polite" className="project-export-recovery-toast" role="status">
          Saved Export choices were adjusted because this project or device changed.
        </div>
      ) : null}
    </section>
  );
}
