import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppProvider } from "./AppState";
import Layout from "./Layout";
import Cancellations from "./pages/Cancellations";
import ControlTower from "./pages/ControlTower";
import Network from "./pages/Network";
import ScenarioPlanner from "./pages/ScenarioPlanner";
import WorkingTools from "./pages/WorkingTools";
import "./App.css";

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<ControlTower />} />
            <Route path="cancel" element={<Cancellations />} />
            <Route path="tools" element={<WorkingTools />} />
            <Route path="network" element={<Network />} />
            <Route path="scenario" element={<ScenarioPlanner />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
