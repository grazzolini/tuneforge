import { useEffect, useId } from "react";
import { Link, NavLink, Route, Routes, matchPath, useLocation } from "react-router-dom";
import { LibraryView } from "./features/projects/LibraryView";
import { ProjectView } from "./features/projects/ProjectView";
import { usePlayback } from "./features/projects/playback-context";
import { PlaybackProvider } from "./features/projects/playback";
import { SettingsView } from "./features/settings/SettingsView";
import { ThemeStudioView } from "./features/settings/ThemeStudioView";
import { ToolsView } from "./features/tools/ToolsView";
import { PreferencesProvider } from "./lib/preferences";
import { ThemeProvider } from "./lib/theme";

function MiniMetallicGlyphDefs({ gradientId }: { gradientId: string }) {
  return (
    <defs>
      <linearGradient id={gradientId} x1="8%" y1="8%" x2="92%" y2="92%">
        <stop offset="0%" stopColor="#FFFBEB" />
        <stop offset="20%" stopColor="#F8FAFC" />
        <stop offset="48%" stopColor="#CBD5E1" />
        <stop offset="76%" stopColor="#64748B" />
        <stop offset="100%" stopColor="#F8FAFC" />
      </linearGradient>
    </defs>
  );
}

function MiniPlayPauseGlyph({ isPlaying }: { isPlaying: boolean }) {
  const gradientId = useId();
  const fill = `url(#${gradientId})`;

  return (
    <svg
      aria-hidden="true"
      className="background-playback__icon background-playback__icon--playpause"
      focusable="false"
      viewBox="0 0 40 40"
    >
      <MiniMetallicGlyphDefs gradientId={gradientId} />
      {isPlaying ? (
        <>
          <rect
            fill={fill}
            height="17"
            rx="2.4"
            stroke="rgba(255, 255, 255, 0.42)"
            strokeWidth="1"
            width="5.8"
            x="11.45"
            y="11.5"
          />
          <rect
            fill={fill}
            height="17"
            rx="2.4"
            stroke="rgba(255, 255, 255, 0.42)"
            strokeWidth="1"
            width="5.8"
            x="22.75"
            y="11.5"
          />
        </>
      ) : (
        <path
          d="M13.2 10.2L28.9 20L13.2 29.8Z"
          fill={fill}
          stroke="rgba(255, 255, 255, 0.48)"
          strokeLinejoin="round"
          strokeWidth="1"
        />
      )}
    </svg>
  );
}

function MiniStopGlyph() {
  const gradientId = useId();
  const fill = `url(#${gradientId})`;

  return (
    <svg
      aria-hidden="true"
      className="background-playback__icon background-playback__icon--stop"
      focusable="false"
      viewBox="0 0 40 40"
    >
      <MiniMetallicGlyphDefs gradientId={gradientId} />
      <rect
        fill={fill}
        height="14.5"
        rx="4"
        stroke="rgba(255, 255, 255, 0.42)"
        strokeWidth="1"
        width="14.5"
        x="12.75"
        y="12.75"
      />
    </svg>
  );
}

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
      <Link
        aria-label={`Open ${session.projectName} project`}
        className="background-playback__resume"
        to={`/projects/${session.projectId}`}
      >
        <span className="metric-label">Background Playback</span>
        <strong>{session.projectName}</strong>
        <p className="artifact-meta">{session.stageTitle}</p>
      </Link>
      <div className="background-playback__controls">
        <button
          aria-label={isPlaying ? "Pause background playback" : "Play background playback"}
          className="background-playback__control"
          type="button"
          onClick={() => void togglePlayback()}
        >
          <MiniPlayPauseGlyph isPlaying={isPlaying} />
        </button>
        <button
          aria-label="Stop background playback"
          className="background-playback__control"
          type="button"
          onClick={dismissSession}
        >
          <MiniStopGlyph />
        </button>
      </div>
    </div>
  );
}

function AppChrome() {
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
    <div className="app-shell">
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
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<LibraryView />} />
          <Route path="/projects/:projectId" element={<ProjectView />} />
          <Route path="/tools" element={<ToolsView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/settings/theme-studio" element={<ThemeStudioView />} />
          <Route path="/settings/theme-preview" element={<ThemeStudioView />} />
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
