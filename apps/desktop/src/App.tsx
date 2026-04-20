import { useEffect } from "react";
import { NavLink, Route, Routes, matchPath, useLocation } from "react-router-dom";
import { LibraryView } from "./features/projects/LibraryView";
import { ProjectView } from "./features/projects/ProjectView";
import { usePlayback } from "./features/projects/playback-context";
import { PlaybackProvider } from "./features/projects/playback";
import { SettingsView } from "./features/settings/SettingsView";
import { ThemePreviewView } from "./features/settings/ThemePreviewView";
import { PreferencesProvider, usePreferences } from "./lib/preferences";
import { ThemeProvider } from "./lib/theme";

function BackgroundPlaybackCard() {
  const location = useLocation();
  const { dismissSession, isPlaying, session, togglePlayback } = usePlayback();
  const routeProjectId =
    matchPath("/projects/:projectId", location.pathname)?.params.projectId ?? null;

  if (!session || routeProjectId === session.projectId) {
    return null;
  }

  return (
    <div className="background-playback">
      <div>
        <span className="metric-label">Background Playback</span>
        <strong>{session.projectName}</strong>
        <p className="artifact-meta">{session.stageTitle}</p>
      </div>
      <div className="background-playback__controls">
        <button
          className="button button--small"
          type="button"
          onClick={() => void togglePlayback()}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          className="button button--ghost button--small"
          type="button"
          onClick={dismissSession}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function AppChrome() {
  const { informationDensity, layoutDensity } = usePreferences();
  const location = useLocation();
  const { dismissSession, session } = usePlayback();
  const routeProjectId =
    matchPath("/projects/:projectId", location.pathname)?.params.projectId ?? null;

  useEffect(() => {
    if (!routeProjectId || !session || routeProjectId === session.projectId) {
      return;
    }

    dismissSession();
  }, [dismissSession, routeProjectId, session]);

  return (
    <div className="app-shell" data-information-density={informationDensity} data-layout-density={layoutDensity}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__eyebrow">Tuneforge</span>
          <strong>Local Practice Rig</strong>
        </div>
        <BackgroundPlaybackCard />
        <nav className="nav">
          <NavLink to="/" end>
            Library
          </NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<LibraryView />} />
          <Route path="/projects/:projectId" element={<ProjectView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/settings/theme-preview" element={<ThemePreviewView />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <PreferencesProvider>
        <PlaybackProvider>
          <AppChrome />
        </PlaybackProvider>
      </PreferencesProvider>
    </ThemeProvider>
  );
}
