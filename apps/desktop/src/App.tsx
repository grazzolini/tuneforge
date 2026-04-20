import { NavLink, Route, Routes } from "react-router-dom";
import { LibraryView } from "./features/projects/LibraryView";
import { ProjectView } from "./features/projects/ProjectView";
import { SettingsView } from "./features/settings/SettingsView";
import { ThemePreviewView } from "./features/settings/ThemePreviewView";
import { PreferencesProvider, usePreferences } from "./lib/preferences";
import { ThemeProvider } from "./lib/theme";

function AppChrome() {
  const { informationDensity, layoutDensity } = usePreferences();

  return (
    <div className="app-shell" data-information-density={informationDensity} data-layout-density={layoutDensity}>
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
        <AppChrome />
      </PreferencesProvider>
    </ThemeProvider>
  );
}
