import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../AppState";
import Combobox from "../components/Combobox";
import FlowDiagram from "../components/FlowDiagram";
import NetworkMap from "../components/NetworkMap";
import { CoverageBar, facilityUtilizationStatus } from "../components/Status";
import { formatDate, isoDate } from "../format";
import type { CrossingSwap, FacilityDemandForecast, FlowView, NetworkView, ProblemLocation, ScheduleView, ShowSummary,
             SlotCollision, UtilizationView } from "../types";

/** Facility capacity as horizontal bars — the "how full is each location actually running"
 *  read that a warehouse/fleet utilization view gives, applied to shows instead of shelves. */
function FacilityUtilization({ facilities, onEdit }: { facilities: UtilizationView["facilities"]; onEdit: (facilityId: string) => void }) {
  if (facilities.length === 0) return <p className="muted small">No upcoming shows to measure yet.</p>;
  const slotCounts = new Map<string, number>();
  facilities.forEach((f) => slotCounts.set(f.preferred_slot, (slotCounts.get(f.preferred_slot) ?? 0) + 1));
  return (
    <div className="util-list">
      {facilities.map((f) => {
        const collides = (slotCounts.get(f.preferred_slot) ?? 0) > 1;
        return (
          <div key={f.facility_id} className="util-row">
            <CoverageBar label={`${f.name} · ${f.preferred_slot}${collides ? " ⚠" : ""} · ${f.shows} show${f.shows !== 1 ? "s" : ""}`}
                         value={f.avg_musicians} target={f.target_musicians}
                         status={facilityUtilizationStatus(f.utilization)} />
            <button className="link-button small" onClick={() => onEdit(f.facility_id)}>Edit location</button>
          </div>
        );
      })}
    </div>
  );
}

export default function Network() {
  const { version, refresh, openPanel, showToast } = useApp();
  const navigate = useNavigate();
  const [shows, setShows] = useState<ShowSummary[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkView | null>(null);
  // "" means every upcoming show, aggregated — a specific show_id narrows the flow view to just it.
  const [flowShowId, setFlowShowId] = useState("");
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [utilization, setUtilization] = useState<UtilizationView | null>(null);
  const [problemLocations, setProblemLocations] = useState<ProblemLocation[]>([]);
  const [slotCollisions, setSlotCollisions] = useState<SlotCollision[]>([]);
  const [crossingSwaps, setCrossingSwaps] = useState<CrossingSwap[] | null>(null);
  const [swapBusy, setSwapBusy] = useState<string | null>(null);
  const [demandForecast, setDemandForecast] = useState<FacilityDemandForecast[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ScheduleView>("/api/schedule").then((v) => {
      const sorted = [...v.shows].sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
      setShows(sorted);
      setDate((d) => d ?? sorted.find((s) => s.date >= isoDate(new Date()))?.date ?? sorted[0]?.date ?? null);
    });
    api<UtilizationView>("/api/utilization").then(setUtilization).catch(() => undefined);
    api<{ locations: ProblemLocation[] }>("/api/problem-locations").then((r) => setProblemLocations(r.locations)).catch(() => undefined);
    api<{ slots: SlotCollision[] }>("/api/slot-collisions").then((r) => setSlotCollisions(r.slots)).catch(() => undefined);
    api<{ swaps: CrossingSwap[] }>("/api/crossing-swaps").then((r) => setCrossingSwaps(r.swaps)).catch(() => undefined);
    api<{ facilities: FacilityDemandForecast[] }>("/api/facility-demand-forecast")
      .then((r) => setDemandForecast(r.facilities)).catch(() => undefined);
  }, [version]);

  const applySwap = (s: CrossingSwap) => {
    const key = `${s.show_a}|${s.musician_a.musician_id}|${s.show_b}|${s.musician_b.musician_id}`;
    setSwapBusy(key);
    api("/api/crossing-swaps/apply", {
      method: "POST",
      body: { show_a: s.show_a, musician_a: s.musician_a.musician_id, show_b: s.show_b, musician_b: s.musician_b.musician_id },
    }).then(() => { showToast("Swapped."); refresh(); }).catch((e) => setError(e.message)).finally(() => setSwapBusy(null));
  };

  useEffect(() => {
    if (!date) return;
    api<NetworkView>(`/api/network?date=${date}`).then(setNetwork).catch((e) => setError(e.message));
  }, [date, version]);

  useEffect(() => {
    const q = flowShowId ? `?show_id=${flowShowId}` : "";
    api<FlowView>(`/api/flow${q}`).then(setFlow).catch(() => undefined);
  }, [flowShowId, version]);

  const dates = useMemo(() => [...new Set(shows.map((s) => s.date))].sort(), [shows]);
  const dateIdx = date ? dates.indexOf(date) : -1;
  const totalTrips = useMemo(() => flow?.links.reduce((s, l) => s + l.value, 0) ?? 0, [flow]);
  const totalKm = useMemo(() => flow?.links.reduce((s, l) => s + l.total_km, 0) ?? 0, [flow]);
  const flowScope = flowShowId ? shows.find((s) => s.show_id === flowShowId) : null;

  return (
    <div>
      <h1>Network</h1>

      {problemLocations.length > 0 && (
        <section className="callout amber problem-locations">
          <strong>{problemLocations.length} location{problemLocations.length !== 1 ? "s" : ""} with an ongoing problem</strong>
          <p className="small muted block">Not a one-off bad show — this is the pattern across its recent upcoming shows.</p>
          <ul className="plain-list small">
            {problemLocations.map((p) => (
              <li key={p.facility_id} className="problem-location-row">
                <div>
                  <button className="link-button" onClick={() => openPanel({ kind: "facilityForm", id: p.facility_id })}>{p.name}</button>
                  {" "}— {p.summary}
                  {p.suggestion && <div className="small muted">{p.suggestion}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="network-grid">
        <section className="tool-panel">
          <div className="section-head">
            <h2>Location utilization</h2>
            <button className="button secondary small-button" onClick={() => openPanel({ kind: "facilityForm" })}>+ Add location</button>
          </div>
          <p className="subtitle small">Average musicians per show, compared with the location target.</p>
          {utilization
            ? <FacilityUtilization facilities={utilization.facilities} onEdit={(id) => openPanel({ kind: "facilityForm", id })} />
            : <p className="muted small">Loading…</p>}
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
            {totalTrips} trip{totalTrips !== 1 ? "s" : ""} · {totalKm.toFixed(0)} km everyone travels individually ·{" "}
            {flowScope ? <>{flowScope.facility_name}, {formatDate(flowScope.date)}</> : "All upcoming shows"}
          </p>
          <p className="small muted">
            Each person's own home-to-location distance, added up — different from the Schedule page's "car-km," which
            is what cars actually drive once carpooling shares trips between riders.
          </p>
          {flow ? <FlowDiagram nodes={flow.nodes} links={flow.links} /> : <p className="muted small">Loading…</p>}
        </section>
      </div>

      <section className="tool-panel">
        <h2>Weekly slot capacity</h2>
        <p className="subtitle small">
          Every recurring day/time a location runs on, and the free-musician pool that slot actually draws from —
          the real reason two locations sharing a slot both run thin at once.
        </p>
        {slotCollisions.length === 0 ? <p className="muted small">Loading…</p> : (
          <table className="data-table slot-collision-table">
            <thead>
              <tr><th>Slot</th><th>Locations</th><th>Combined target</th><th>Free pool</th><th>Headroom</th></tr>
            </thead>
            <tbody>
              {slotCollisions.map((s) => (
                <tr key={s.slot} className={s.headroom < 0 ? "row-bad" : s.facilities.length > 1 && s.headroom < 5 ? "row-warn" : ""}>
                  <td>{s.slot}</td>
                  <td>
                    {s.facilities.map((f, i) => (
                      <span key={f.facility_id}>
                        {i > 0 && ", "}
                        <button className="link-button small" onClick={() => openPanel({ kind: "facilityForm", id: f.facility_id })}>{f.name}</button>
                      </span>
                    ))}
                  </td>
                  <td>{s.total_demand}</td>
                  <td>{s.free_pool_size}</td>
                  <td className={s.headroom < 0 ? "error" : ""}>{s.headroom > 0 ? `+${s.headroom}` : s.headroom}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="tool-panel">
        <h2>Location demand forecast</h2>
        <p className="subtitle small">
          Each location's own historical cadence — what it usually asks for, not an org-wide average — projected
          one month ahead. Busiest first.
        </p>
        {demandForecast === null ? <p className="muted small">Loading…</p> : (
          <table className="data-table">
            <thead>
              <tr><th>Location</th><th>Usual slot</th><th>Avg shows/month</th><th>Projected next month</th><th /></tr>
            </thead>
            <tbody>
              {demandForecast.map((f) => (
                <tr key={f.facility_id}>
                  <td>
                    <button className="link-button" onClick={() => openPanel({ kind: "facilityForm", id: f.facility_id })}>{f.name}</button>
                    <span className="muted small"> · {f.region}</span>
                  </td>
                  <td>{f.preferred_slot}</td>
                  <td>{f.avg_shows_per_month}{f.months_of_history < 3 && <span className="muted small"> ({f.months_of_history}mo history)</span>}</td>
                  <td>{f.projected_next_month} show{f.projected_next_month !== 1 ? "s" : ""} · {f.projected_next_month * f.target_musicians} musician-slots</td>
                  <td>
                    <button className="link-button small" onClick={() => navigate(`/scenario?tool=bestDates&facility=${f.facility_id}`)}>
                      See best dates →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="tool-panel">
        <h2>Crossing routes</h2>
        <p className="subtitle small">
          Same-day shows where two musicians are each closer to the OTHER show than their own — swapping who
          plays where needs no re-solve and doesn't change either show's headcount, songs or pianist coverage.
        </p>
        {crossingSwaps === null ? <p className="muted small">Loading…</p>
          : crossingSwaps.length === 0 ? <p className="muted small">No crossing routes found in the upcoming schedule.</p>
          : (
          <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Date</th><th>Swap</th><th>Saves</th><th /></tr></thead>
            <tbody>
              {crossingSwaps.slice(0, 15).map((s) => {
                const key = `${s.show_a}|${s.musician_a.musician_id}|${s.show_b}|${s.musician_b.musician_id}`;
                return (
                  <tr key={key}>
                    <td>{formatDate(s.date)}</td>
                    <td>
                      {s.musician_a.name} ({s.facility_a} → {s.facility_b}) ↔ {s.musician_b.name} ({s.facility_b} → {s.facility_a})
                    </td>
                    <td>{s.savings_km} km</td>
                    <td>
                      <button className="link-button small" disabled={swapBusy === key} onClick={() => applySwap(s)}>
                        {swapBusy === key ? "Swapping…" : "Swap"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {/* Nice to look at, but nothing on this page above ever sends you here to actually decide
          something — kept, but collapsed by default so it's not the first (or only) thing this
          page has to offer. */}
      <details className="tool-panel">
        <summary><h2>Routes for one day</h2></summary>
        <div className="network-head">
          {dates.length > 0 && (
            <div className="month-nav">
              <button className="button secondary" disabled={dateIdx <= 0} onClick={() => setDate(dates[dateIdx - 1])}>‹</button>
              <Combobox value={date ?? ""} onChange={setDate} placeholder="Search dates…"
                        options={dates.map((d) => ({ value: d, label: formatDate(d) }))} />
              <button className="button secondary" disabled={dateIdx < 0 || dateIdx >= dates.length - 1}
                      onClick={() => setDate(dates[dateIdx + 1])}>›</button>
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <p className="small muted">Routes are illustrative, not driving directions.</p>
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
      </details>
    </div>
  );
}
