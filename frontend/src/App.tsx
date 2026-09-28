import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProvider } from "./AppState";
import Layout from "./Layout";
import Activity from "./pages/Activity";
import Cancellations from "./pages/Cancellations";
import ControlTower from "./pages/ControlTower";
import Network from "./pages/Network";
import ScenarioPlanner from "./pages/ScenarioPlanner";
import SelfService from "./pages/SelfService";
import WorkingTools from "./pages/WorkingTools";
import "./App.css";

/** Everything a coordinator or playground visitor uses — kept inside AppProvider so it shares
 *  the one session/workspace state. The self-service page below is deliberately NOT part of
 *  this: a musician opening their own link has no session and shouldn't need one. */
function CoordinatorApp() {
  return (
    <AppProvider>
      <Routes>
        <Route element={<Layout />}>
          {/* Schedule is the landing page — Overview used to sit here, cut for duplicating it in
              a worse form (see useNavGroups' comment in Layout.tsx). */}
          <Route index element={<Navigate to="/operations" replace />} />
          <Route path="operations" element={<ControlTower />} />
          {/* Kept for direct links (a show panel's "Report cancellation" navigates here too) —
              just no longer a sidebar destination of its own, per UI_Supply_Chain2.md item 9. */}
          <Route path="cancel" element={<Cancellations />} />
          <Route path="musicians" element={<WorkingTools />} />
          <Route path="network" element={<Network />} />
          <Route path="scenario" element={<ScenarioPlanner />} />
          <Route path="activity" element={<Activity />} />
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
