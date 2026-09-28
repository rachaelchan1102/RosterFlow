import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProvider } from "./AppState";
import Layout from "./Layout";
import Activity from "./pages/Activity";
import Musicians from "./pages/Musicians";
import Planning from "./pages/Planning";
import Schedule from "./pages/Schedule";
import SelfService from "./pages/SelfService";
import Sites from "./pages/Sites";
import "./App.css";

/** Everything a coordinator or playground visitor uses — kept inside AppProvider so it shares
 *  the one session/workspace state. The self-service page below is deliberately NOT part of
 *  this: a musician opening their own link has no session and shouldn't need one. */
function CoordinatorApp() {
  return (
    <AppProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/schedule" replace />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="sites" element={<Sites />} />
          <Route path="musicians" element={<Musicians />} />
          <Route path="planning" element={<Planning />} />
          <Route path="activity" element={<Activity />} />
          {/* Old addresses from before the redesign, so bookmarks still land somewhere sensible. */}
          <Route path="operations" element={<Navigate to="/schedule" replace />} />
          <Route path="network" element={<Navigate to="/sites" replace />} />
          <Route path="scenario" element={<Navigate to="/planning" replace />} />
          <Route path="*" element={<Navigate to="/schedule" replace />} />
        </Route>
      </Routes>
    </AppProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="respond/:token" element={<SelfService />} />
        <Route path="*" element={<CoordinatorApp />} />
      </Routes>
    </BrowserRouter>
  );
}
