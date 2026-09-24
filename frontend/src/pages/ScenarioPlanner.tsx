import { useEffect, useState } from "react";
import { api } from "../api";
import FeasibilityCheck from "../components/FeasibilityCheck";
import SolveProgress from "../components/SolveProgress";
import type { Facility, Kpis } from "../types";

// The scenario endpoint adds the simulated music shortfall to the usual KPIs.
type ScenarioKpis = Kpis & { minutes_short: number };

interface ScenarioResponse {
  baseline: ScenarioKpis;
  scenario: ScenarioKpis;
  show_count: number;
}

// SPEC: about 1 cancellation per show is normal, i.e. roughly 1 in 8 musicians.
const RATE_STOPS = [
  { label: "Normal", sub: "~1 per show", phrase: "the normal cancellation rate", value: 0.125 },
  { label: "2×", sub: "~2 per show", phrase: "twice the normal cancellations", value: 0.25 },
  { label: "3×", sub: "~3 per show", phrase: "three times the normal cancellations", value: 0.375 },
];

type Row = { key: keyof ScenarioKpis; label: string; format: (v: number) => string; higherIsBetter: boolean; unit?: string };
const ROWS: Row[] = [
  { key: "fill_rate", label: "Shows with a full set", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: true },
  { key: "minutes_short", label: "Music missing, all shows", format: (v) => `~${Math.round(v)} min`, higherIsBetter: false, unit: "min" },
  { key: "backup_coverage", label: "Backup coverage", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: true },
  { key: "capacity_utilization_mean", label: "Capacity used", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: false },
  { key: "capacity_utilization_spread", label: "Workload spread", format: (v) => `±${Math.round(v * 100)}%`, higherIsBetter: false },
  { key: "total_car_km", label: "Total car-km", format: (v) => `${v.toFixed(0)} km`, higherIsBetter: false },
  { key: "rotation_repeat_rate", label: "Repeat visits", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: false },
];

function DeltaCell({ row, base, next }: { row: Row; base: number; next: number }) {
  const diff = next - base;
  if (Math.abs(diff) < 1e-9) return <td className="muted">—</td>;
  const better = row.higherIsBetter ? diff > 0 : diff < 0;
  const unit = row.key === "total_car_km" ? "km" : row.unit;
  const shown = unit ? `${diff > 0 ? "+" : ""}${diff.toFixed(0)} ${unit}`
    : `${diff > 0 ? "+" : ""}${Math.round(diff * 100)} pts`;
  return <td className={better ? "delta-good" : "delta-bad"}>{better ? "▲" : "▼"} {shown}</td>;
}

function NewShowCheck() {
  const [locations, setLocations] = useState<Facility[]>([]);
  const [slot, setSlot] = useState({ facilityId: "", date: "", startTime: "14:00", durationMin: 60 });

  useEffect(() => {
    api<Facility[]>("/api/facilities").then((f) => {
      setLocations(f);
      if (f.length) {
        setSlot((s) => ({ ...s, facilityId: f[0].facility_id, durationMin: f[0].show_duration_min,
                          startTime: f[0].preferred_slot.split(" ")[1] ?? s.startTime }));
      }
    });
  }, []);

  const pickLocation = (id: string) => {
    const f = locations.find((x) => x.facility_id === id);
    setSlot({ ...slot, facilityId: id, durationMin: f?.show_duration_min ?? slot.durationMin });
  };

  return (
    <section className="tool-panel">
      <p className="subtitle">
        A location asks for a show on a certain day and time. See how likely it is you could staff it before saying yes —
        given who's already booked, who's at their monthly cap, and who's usually free at that time.
      </p>
      <div className="scenario-layout">
        <div className="scenario-controls">
          <label>Location
            <select value={slot.facilityId} onChange={(e) => pickLocation(e.target.value)}>
              {locations.map((f) => <option key={f.facility_id} value={f.facility_id}>{f.display_name} ({f.region})</option>)}
            </select>
          </label>
          <label>Date
            <input type="date" value={slot.date} onChange={(e) => setSlot({ ...slot, date: e.target.value })} />
          </label>
          <div className="form-row">
            <label>Start time
              <input type="time" value={slot.startTime} onChange={(e) => setSlot({ ...slot, startTime: e.target.value })} />
            </label>
            <label>Length
              <select value={slot.durationMin} onChange={(e) => setSlot({ ...slot, durationMin: Number(e.target.value) })}>
                <option value={45}>45 min</option>
                <option value={60}>60 min</option>
              </select>
            </label>
          </div>
        </div>
        <div className="scenario-results">
          {slot.date ? (
            <FeasibilityCheck facilityId={slot.facilityId} date={slot.date} startTime={slot.startTime}
                              durationMin={slot.durationMin} onPickDate={(date) => setSlot({ ...slot, date })} />
          ) : (
            <p className="muted">Pick a date to check it.</p>
          )}
        </div>
      </div>
    </section>
  );
}

const SCENARIO_STEPS = [
  "Taking the lost musicians out of the roster",
  "Rebuilding the schedule without them",
  "Ranking backups for every show",
  "Simulating 3,000 months of cancellations",
];

function StressTest() {
  const [rate, setRate] = useState(0.25);
  const [removeMusicians, setRemoveMusicians] = useState(0);
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [ranWith, setRanWith] = useState<{ rate: number; removed: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api<ScenarioResponse>("/api/scenario", { method: "POST", body: { cancellation_p: rate, remove_musicians: removeMusicians } })
      .then((r) => { setResult(r); setRanWith({ rate, removed: removeMusicians }); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const full = result ? { base: result.baseline.fill_rate, next: result.scenario.fill_rate } : null;
  const missing = Math.round(result?.scenario.minutes_short ?? 0);
  const stop = RATE_STOPS.find((s) => s.value === ranWith?.rate);

  return (
    <section className="tool-panel">
      <p className="subtitle">What if the coming weeks go worse than usual? Compare against the current schedule, side by side.</p>

      <div className="scenario-layout">
        <div className="scenario-controls">
          <div className="control">
            <span className="control-label">Cancellations</span>
            <div className="segmented">
              {RATE_STOPS.map((s) => (
                <button key={s.value} className={rate === s.value ? "active" : ""} onClick={() => setRate(s.value)}>
                  <strong>{s.label}</strong><span>{s.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="control">
            <span className="control-label">Musicians lost: <strong>{removeMusicians}</strong></span>
            <input type="range" min={0} max={30} step={1} value={removeMusicians}
                   onChange={(e) => setRemoveMusicians(Number(e.target.value))} />
            <span className="small muted">Takes the schedule apart and re-solves it without them (~20s).</span>
          </div>

          <button className="button" onClick={run} disabled={loading}>{loading ? "Running…" : "Run scenario"}</button>
          {error && <p className="error">{error}</p>}
        </div>

        <div className="scenario-results">
          {loading && (
            <SolveProgress steps={removeMusicians > 0 ? SCENARIO_STEPS : SCENARIO_STEPS.slice(3)}
                           estimateSec={removeMusicians > 0 ? 22 : 3} />
          )}
          {!loading && !result && <p className="muted">Pick a scenario and run it — results show up here next to the current schedule's numbers.</p>}
          {!loading && result && full && ranWith && (
            <>
              <p className="scenario-summary">
                At <strong>{stop?.phrase ?? `a ${Math.round(ranWith.rate * 100)}% cancellation rate`}</strong>
                {ranWith.removed > 0 && <> with <strong>{ranWith.removed} fewer musicians</strong></>}, about{" "}
                <strong>{Math.round(full.next * 100)}%</strong> of shows would still have a full set after backups
                (vs {Math.round(full.base * 100)}% at the normal rate). Every show still goes ahead — the rest just run
                short, about <strong>{missing} minutes of music</strong> missing across all {result.show_count} shows.
              </p>
              <table className="comparison-table">
                <thead><tr><th /><th>Current schedule (normal rate)</th><th>Scenario</th><th>Change</th></tr></thead>
                <tbody>
                  {ROWS.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td>{row.format(result.baseline[row.key])}</td>
                      <td><strong>{row.format(result.scenario[row.key])}</strong></td>
                      <DeltaCell row={row} base={result.baseline[row.key]} next={result.scenario[row.key]} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">
                "Full set" and "music missing" are simulated: 3,000 random months where every musician has the same
                chance of dropping out, backups are called in rank order, and the rest of the roster picks up extra songs
                where they can. A full set also needs the minimum number of musicians and a pianist.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

type Tool = "stress" | "extra";

export default function ScenarioPlanner() {
  const [tool, setTool] = useState<Tool>("stress");
  return (
    <div>
      <h1>Scenario planner</h1>
      <div className="tool-tabs" role="tablist">
        <button role="tab" aria-selected={tool === "stress"} className={tool === "stress" ? "active" : ""} onClick={() => setTool("stress")}>
          <strong>Stress-test the schedule</strong>
          <span>More cancellations, fewer musicians</span>
        </button>
        <button role="tab" aria-selected={tool === "extra"} className={tool === "extra" ? "active" : ""} onClick={() => setTool("extra")}>
          <strong>Would an extra show work?</strong>
          <span>Check a day and time before saying yes</span>
        </button>
      </div>
      {tool === "stress" ? <StressTest /> : <NewShowCheck />}
    </div>
  );
}
