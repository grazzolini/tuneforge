import { NavLink, Route, Routes } from "react-router-dom";
import { LibraryView } from "./features/projects/LibraryView";
import { ProjectView } from "./features/projects/ProjectView";
import { SettingsView } from "./features/settings/SettingsView";
import { ThemeProvider } from "./lib/theme";

export default function App() {
  return (
    <ThemeProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand__eyebrow">Tuneforge</span>
            <strong>Local Practice Rig</strong>
          </div>
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
          </Routes>
        </main>
      </div>
    </ThemeProvider>
  );
}
