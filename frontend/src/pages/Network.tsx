import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../AppState";
import FlowDiagram from "../components/FlowDiagram";
import NetworkMap from "../components/NetworkMap";
import { CoverageBar } from "../components/Status";
import { utilizationStatus } from "../components/Status";
import { formatDate, isoDate } from "../format";
import type { FlowView, NetworkView, ScheduleView, ShowSummary, UtilizationView } from "../types";

/** Facility capacity as horizontal bars — the "how full is each location actually running"
 *  read that a warehouse/fleet utilization view gives, applied to shows instead of shelves. */
function FacilityUtilization({ facilities }: { facilities: UtilizationView["facilities"] }) {
  if (facilities.length === 0) return <p className="muted small">No upcoming shows to measure yet.</p>;
  return (
    <div className="util-list">
      {facilities.map((f) => (
        <CoverageBar key={f.facility_id} label={`${f.name} · ${f.shows} show${f.shows !== 1 ? "s" : ""}`}
                     value={Math.round(f.avg_musicians * 10) / 10} target={f.target_musicians}
                     status={utilizationStatus(f.utilization)} />
      ))}
    </div>
  );
}

export default function Network() {
  const { version, openPanel } = useApp();
  const [shows, setShows] = useState<ShowSummary[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkView | null>(null);
  // "" means every upcoming show, aggregated — a specific show_id narrows the flow view to just it.
  const [flowShowId, setFlowShowId] = useState("");
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [utilization, setUtilization] = useState<UtilizationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ScheduleView>("/api/schedule").then((v) => {
      const sorted = [...v.shows].sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
      setShows(sorted);
      setDate((d) => d ?? sorted.find((s) => s.date >= isoDate(new Date()))?.date ?? sorted[0]?.date ?? null);
    });
    api<UtilizationView>("/api/utilization").then(setUtilization);
  }, [version]);

  useEffect(() => {
    if (!date) return;
    api<NetworkView>(`/api/network?date=${date}`).then(setNetwork).catch((e) => setError(e.message));
  }, [date, version]);

  useEffect(() => {
    const q = flowShowId ? `?show_id=${flowShowId}` : "";
    api<FlowView>(`/api/flow${q}`).then(setFlow);
  }, [flowShowId, version]);

  const dates = useMemo(() => [...new Set(shows.map((s) => s.date))].sort(), [shows]);
  const dateIdx = date ? dates.indexOf(date) : -1;
  const totalTrips = useMemo(() => flow?.links.reduce((s, l) => s + l.value, 0) ?? 0, [flow]);
  const totalKm = useMemo(() => flow?.links.reduce((s, l) => s + l.total_km, 0) ?? 0, [flow]);
  const flowScope = flowShowId ? shows.find((s) => s.show_id === flowShowId) : null;

  return (
    <div>
      <h1>Network</h1>
      <p className="subtitle">Where musicians travel from, how they get there, and how full each location is running.</p>

      <section className="tool-panel">
        <div className="network-head">
          <h2>Routes for one day</h2>
          {dates.length > 0 && (
            <div className="month-nav">
              <button className="button secondary" disabled={dateIdx <= 0} onClick={() => setDate(dates[dateIdx - 1])}>‹</button>
              <strong>{date ? formatDate(date) : "—"}</strong>
              <button className="button secondary" disabled={dateIdx < 0 || dateIdx >= dates.length - 1}
                      onClick={() => setDate(dates[dateIdx + 1])}>›</button>
            </div>
          )}
        </div>
        <p className="small muted">Lines are schematic (home → location, arced for legibility), not turn-by-turn driving directions.</p>
        {error && <p className="error">{error}</p>}
        {!date ? (
          <p className="muted">No upcoming shows to map yet.</p>
        ) : !network ? (
          <p className="muted">Loading…</p>
        ) : network.facilities.length === 0 ? (
          <p className="muted">No shows on {formatDate(date)}.</p>
        ) : (
          <>
            <NetworkMap facilities={network.facilities} routes={network.routes} />
            <div className="network-pins">
              {network.facilities.map((f) => (
                <button key={f.show_id} className={`chip-button odds-${f.status}`} onClick={() => openPanel({ kind: "show", id: f.show_id })}>
                  {f.name} · {f.start_time}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <div className="network-grid">
        <section className="tool-panel">
          <h2>Location utilization</h2>
          <p className="subtitle small">Average musicians per show against each location's target, across all upcoming shows.</p>
          {utilization ? <FacilityUtilization facilities={utilization.facilities} /> : <p className="muted small">Loading…</p>}
        </section>

        <section className="tool-panel">
          <h2>Trips by home region</h2>
          <div className="flow-filter">
            <label>Show
              <select value={flowShowId} onChange={(e) => setFlowShowId(e.target.value)}>
                <option value="">All upcoming shows</option>
                {shows.map((s) => (
                  <option key={s.show_id} value={s.show_id}>{formatDate(s.date)} · {s.start_time} · {s.facility_name}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="subtitle small">
            {totalTrips} musician-trip{totalTrips !== 1 ? "s" : ""} · {totalKm.toFixed(0)} km total —{" "}
            {flowScope ? <>just {flowScope.facility_name} on {formatDate(flowScope.date)}</> : "across the whole upcoming schedule"}.
          </p>
          {flow ? <FlowDiagram nodes={flow.nodes} links={flow.links} /> : <p className="muted small">Loading…</p>}
        </section>
      </div>
    </div>
  );
}
