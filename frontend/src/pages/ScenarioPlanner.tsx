import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../AppState";
import Combobox from "../components/Combobox";
import FeasibilityCheck from "../components/FeasibilityCheck";
import KpiComparisonTable, { KPI_ROWS, MINUTES_SHORT_ROW } from "../components/KpiComparisonTable";
import SolveProgress from "../components/SolveProgress";
import { bookingWindow, BOOKING_HORIZON_DAYS, formatDate, formatMonth, parseDate } from "../format";
import { updateNowAction } from "../scheduleUpdate";
import { nextShowId } from "../showBooking";
import type { Facility, Kpis, Show } from "../types";

// The scenario/simulation endpoints add the simulated music shortfall to the usual KPIs.
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

const STRESS_ROWS = [MINUTES_SHORT_ROW, ...KPI_ROWS];

function NewShowCheck({ facilityId: sharedFacilityId, setFacilityId: setSharedFacilityId }: {
  facilityId: string; setFacilityId: (id: string) => void;
}) {
  const { refresh, showToast, setLastUpdateChanges, confirm } = useApp();
  const [locations, setLocations] = useState<Facility[]>([]);
  const [slot, setSlot] = useState({ facilityId: "", date: "", startTime: "14:00", durationMin: 60 });
  const [probability, setProbability] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const window = bookingWindow();

  useEffect(() => {
    api<Facility[]>("/api/facilities").then((f) => {
      setLocations(f);
      const picked = f.find((x) => x.facility_id === sharedFacilityId) ?? f[0];
      if (picked) {
        setSlot((s) => ({ ...s, facilityId: picked.facility_id, durationMin: picked.show_duration_min,
                          startTime: picked.preferred_slot.split(" ")[1] ?? s.startTime }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickLocation = (id: string) => {
    const f = locations.find((x) => x.facility_id === id);
    setSlot({ ...slot, facilityId: id, durationMin: f?.show_duration_min ?? slot.durationMin });
    setSharedFacilityId(id);
    setBooked(false);
  };
  const update = (patch: Partial<typeof slot>) => { setSlot({ ...slot, ...patch }); setBooked(false); };

  const bookThis = async () => {
    if (probability !== null && probability < 0.3) {
      const ok = await confirm({
        title: "Book anyway?",
        body: `Estimated only a ${Math.round(probability * 100)}% chance this date could be fully staffed. You can still book it — the schedule just needs closer attention afterward.`,
        confirmLabel: "Book anyway",
      });
      if (!ok) return;
    }
    setBooking(true);
    setError(null);
    api<Show[]>("/api/shows").then((shows) => {
      const show: Show = { show_id: nextShowId(shows), facility_id: slot.facilityId, date: slot.date,
                           start_time: slot.startTime, duration_min: slot.durationMin, period: "upcoming" };
      return api("/api/shows", { method: "POST", body: show });
    }).then(() => {
      setBooked(true);
      refresh();
      showToast("Show added. It still needs the schedule updated to be staffed.", updateNowAction(refresh, showToast, setLastUpdateChanges));
    }).catch((e) => setError(e.message)).finally(() => setBooking(false));
  };

  return (
    <section className="tool-panel">
      <p className="subtitle">Check estimated staffing before you confirm a new show.</p>
      <div className="scenario-layout">
        <div className="scenario-controls">
          <label>Location
            <Combobox value={slot.facilityId} onChange={pickLocation} placeholder="Search locations…"
                      options={locations.map((f) => ({ value: f.facility_id, label: f.display_name, sublabel: f.region }))} />
          </label>
          <label>Date
            <input type="date" value={slot.date} min={window.min} max={window.max}
                   onChange={(e) => update({ date: e.target.value })} />
          </label>
          <p className="small muted">Bookable from today through {BOOKING_HORIZON_DAYS} days out.</p>
          <div className="form-row">
            <label>Start time
              <input type="time" value={slot.startTime} onChange={(e) => update({ startTime: e.target.value })} />
            </label>
            <label>Length
              <select value={slot.durationMin} onChange={(e) => update({ durationMin: Number(e.target.value) })}>
                <option value={45}>45 min</option>
                <option value={60}>60 min</option>
              </select>
            </label>
          </div>
          {slot.date && slot.facilityId && (
            <>
              <button className="button" onClick={bookThis} disabled={booking || booked}>
                {booked ? "✓ Booked" : booking ? "Booking…" : "Book this show"}
              </button>
              {error && <p className="error small">{error}</p>}
            </>
          )}
        </div>
        <div className="scenario-results">
          {slot.date ? (
            <FeasibilityCheck facilityId={slot.facilityId} date={slot.date} startTime={slot.startTime}
                              durationMin={slot.durationMin} onPickDate={(date) => update({ date })}
                              onResult={setProbability} />
          ) : (
            <p className="muted">Pick a date to check it.</p>
          )}
        </div>
      </div>
    </section>
  );
}

interface BestDateRow {
  date: string; full: boolean; probability_fully_staffed: number | null; eligible_pool_size: number | null;
  mean_travel_km: number | null;
}
interface BestMonthRow { month: string; avg_probability: number; days_checked: number }

const CAL_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function oddsTier(p: number): "green" | "amber" | "red" {
  return p >= 0.9 ? "green" : p >= 0.6 ? "amber" : "red";
}

/** Staffing odds first (an unstaffable day isn't "best" regardless of distance) — within the
 *  same odds tier, lower expected travel distance wins, same rule the backend ranks best_days
 *  by, so the calendar's per-month lists agree with it instead of using a different rule. */
function byOddsThenTravel(a: BestDateRow, b: BestDateRow): number {
  const tierRank = { green: 0, amber: 1, red: 2 };
  const ta = tierRank[oddsTier(a.probability_fully_staffed!)];
  const tb = tierRank[oddsTier(b.probability_fully_staffed!)];
  return ta !== tb ? ta - tb : (a.mean_travel_km ?? 0) - (b.mean_travel_km ?? 0);
}

/** Blank leading cells + one cell per day of `month` ("2026-10"), Monday-first — same layout
 *  the Schedule page's own calendar uses, so this reads as the same kind of grid. */
function monthGridDates(month: string): (string | null)[] {
  const first = parseDate(`${month}-01`);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Every "2026-10"-style month the booking window actually covers, chronological — pure calendar
 *  math, no simulation involved, so this can populate the month picker before anything runs. */
function bookableMonths(): string[] {
  const { min, max } = bookingWindow();
  const months: string[] = [];
  let cursor = parseDate(`${min.slice(0, 7)}-01`);
  const end = parseDate(`${max.slice(0, 7)}-01`);
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return months;
}

function BestDates({ facilityId, setFacilityId }: { facilityId: string; setFacilityId: (id: string) => void }) {
  const { openPanel } = useApp();
  const [locations, setLocations] = useState<Facility[]>([]);
  const [result, setResult] = useState<{ days: BestDateRow[]; months: BestMonthRow[] } | null>(null);
  const months = useMemo(bookableMonths, []);
  const [month, setMonth] = useState(months[0] ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRun = useRef(false);

  useEffect(() => {
    api<Facility[]>("/api/facilities").then((f) => {
      setLocations(f);
      if (!facilityId) setFacilityId(f[0]?.facility_id ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (forMonth: string) => {
    if (!facilityId || !forMonth) return;
    hasRun.current = true;
    setLoading(true);
    setError(null);
    api<{ days: BestDateRow[]; months: BestMonthRow[] }>(
      `/api/simulation/best-dates?facility_id=${facilityId}&month=${forMonth}`)
      .then(setResult)
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  };

  // Once a first run has actually happened, changing either picker re-runs for the new choice —
  // but nothing runs on its own before that first explicit "Find best dates" click, so switching
  // locations from another tool never kicks off a simulation for a month nobody's chosen yet.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (hasRun.current) run(month); }, [facilityId, month]);

  const monthDays = result ? result.days.filter((d) => d.date.startsWith(month)) : [];
  const checked = monthDays.filter((d) => !d.full && d.probability_fully_staffed !== null);
  // Only genuinely strong/weak days qualify — with a short partial month (a handful of checked
  // days), padding a "5 worst" list with days that are actually fine just to hit a fixed count
  // would misrepresent them as risks.
  const bestInMonth = [...checked].filter((d) => oddsTier(d.probability_fully_staffed!) === "green")
    .sort(byOddsThenTravel).slice(0, 5);
  const worstInMonth = [...checked].filter((d) => oddsTier(d.probability_fully_staffed!) !== "green")
    .sort((a, b) => a.probability_fully_staffed! - b.probability_fully_staffed!).slice(0, 5);
  const byDate = new Map(monthDays.map((d) => [d.date, d]));

  return (
    <section className="tool-panel">
      <p className="subtitle">
        The reverse of "Would an extra show work?" — instead of checking one date, ranks every day in a month for
        this location. Staffing odds come first; among days that are equally easy to staff, the ones with less
        average travel for the musicians likely to show up rank higher.
      </p>
      <div className="scenario-controls best-dates-controls">
        <label>Location
          <Combobox value={facilityId} onChange={setFacilityId} placeholder="Search locations…"
                    options={locations.map((f) => ({ value: f.facility_id, label: f.display_name, sublabel: f.region }))} />
        </label>
        <label>Month
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{formatMonth(m)}</option>)}
          </select>
        </label>
        <button className="button" onClick={() => run(month)} disabled={loading || !facilityId || !month}>
          {loading ? "Checking every day…" : "Find best dates"}
        </button>
        {loading && <p className="small muted">Checking every day in {formatMonth(month)} — a few seconds.</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {!loading && !result && <p className="muted">Pick a location and a month, then run it.</p>}

      {!loading && result && (
        <>
          <div className="calendar best-dates-calendar">
            {CAL_WEEKDAYS.map((d) => <div key={d} className="calendar-weekday">{d}</div>)}
            {monthGridDates(month).map((iso, i) => {
              if (!iso) return <div key={`blank-${i}`} className="best-dates-cell blank" />;
              const d = byDate.get(iso);
              const tier = d && !d.full && d.probability_fully_staffed !== null ? oddsTier(d.probability_fully_staffed) : null;
              const pct = d?.probability_fully_staffed !== null && d?.probability_fully_staffed !== undefined
                ? Math.round(d.probability_fully_staffed * 100) : null;
              const km = d?.mean_travel_km;
              return (
                <div key={iso} className={`best-dates-cell ${tier ?? ""}`}
                     title={d?.full ? "Already fully booked that day"
                       : pct !== null ? `${pct}% likely fully staffed · ~${Math.round(km ?? 0)}km average travel` : ""}>
                  <span className="best-dates-daynum">{Number(iso.slice(8))}</span>
                  {d?.full ? <span className="small muted">full</span> : pct !== null && (
                    <span className="best-dates-metrics">
                      <span className="best-dates-pct">{pct}%</span>
                      <span className="best-dates-km">~{Math.round(km ?? 0)}km</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="network-grid best-dates-lists">
            <section className="tool-panel">
              <h3>Best days this month</h3>
              {bestInMonth.length === 0 ? <p className="small muted">No standout days this month.</p> : (
                <ul className="feed-list">
                  {bestInMonth.map((d) => (
                    <li key={d.date}>
                      <span className="feed-dot" style={{ color: "var(--green)" }} aria-hidden>●</span>
                      <span className="feed-desc">
                        {formatDate(d.date)} · {Math.round(d.probability_fully_staffed! * 100)}%
                        <span className="muted"> · ~{Math.round(d.mean_travel_km ?? 0)}km avg travel</span>
                      </span>
                      <button className="link-button small" onClick={() => openPanel({ kind: "addShow", date: d.date, facilityId })}>
                        Book this
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="tool-panel">
              <h3>Worst days this month</h3>
              {worstInMonth.length === 0 ? <p className="small muted">No particularly weak days this month.</p> : (
                <ul className="feed-list">
                  {worstInMonth.map((d) => (
                    <li key={d.date}>
                      <span className="feed-dot" style={{ color: "var(--red)" }} aria-hidden>●</span>
                      <span className="feed-desc">{formatDate(d.date)} · {Math.round(d.probability_fully_staffed! * 100)}%</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

const SCENARIO_STEPS = [
  "Taking the lost musicians out of the roster",
  "Rebuilding the schedule without them",
  "Ranking backups for every show",
  "Simulating 3,000 months of cancellations",
];

// A purely deterministic re-solve (demand growth, network cost) never runs the Monte Carlo
// step above — showing it anyway would describe work that isn't actually happening.
const RESOLVE_STEPS = ["Rebuilding the schedule", "Ranking backups for every show"];

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
              <KpiComparisonTable baseline={result.baseline} scenario={result.scenario} rows={STRESS_ROWS}
                                  baseLabel="Current schedule (normal rate)" />
              <details className="why-estimate">
                <summary>How this estimate works</summary>
                <p className="small muted">
                  "Full set" and "music missing" are simulated: 3,000 random months where every musician has the same
                  chance of dropping out, backups are called in rank order, and the rest of the roster picks up extra songs
                  where they can. A full set also needs the minimum number of musicians and a pianist.
                </p>
              </details>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function CapacityDrop() {
  const [nMusicians, setNMusicians] = useState(18);
  const [newCap, setNewCap] = useState(1);
  const [result, setResult] = useState<ScenarioResponse & { affected_musicians: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api<ScenarioResponse & { affected_musicians: number }>("/api/simulation/capacity-drop", {
      method: "POST", body: { n_musicians: nMusicians, new_cap: newCap },
    }).then(setResult).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };

  return (
    <section className="tool-panel">
      <p className="subtitle">
        A known, recurring risk: what if your highest-capacity musicians all dropped to a much lower monthly limit
        at once — the way availability often craters in September?
      </p>
      <div className="scenario-layout">
        <div className="scenario-controls">
          <label>Musicians affected
            <input type="number" min={1} max={60} value={nMusicians} onChange={(e) => setNMusicians(Number(e.target.value))} />
          </label>
          <label>New monthly limit for them
            <input type="number" min={0} max={8} value={newCap} onChange={(e) => setNewCap(Number(e.target.value))} />
          </label>
          <p className="small muted">Picks the {nMusicians} musicians with the highest current limit — they're the ones a cut like this actually changes.</p>
          <button className="button" onClick={run} disabled={loading}>{loading ? "Running…" : "Run scenario"}</button>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="scenario-results">
          {loading && <SolveProgress steps={SCENARIO_STEPS} estimateSec={22} />}
          {!loading && !result && <p className="muted">Pick how many musicians and how low, then run it.</p>}
          {!loading && result && (
            <>
              <p className="scenario-summary">
                With <strong>{result.affected_musicians} musicians</strong> capped at <strong>{newCap}/month</strong>, fill rate
                would move from <strong>{Math.round(result.baseline.fill_rate * 100)}%</strong> to{" "}
                <strong>{Math.round(result.scenario.fill_rate * 100)}%</strong>.
              </p>
              <KpiComparisonTable baseline={result.baseline} scenario={result.scenario} rows={STRESS_ROWS} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

interface PianistRow {
  show_id: string; facility_name: string; date: string; start_time: string; pianist_risk: number;
  pianists_in_reach: number; non_pianists_booked: number; has_piano_onsite: boolean;
}

function PianistRisk() {
  const [rows, setRows] = useState<PianistRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api<{ shows: PianistRow[] }>("/api/simulation/pianist-risk").then((r) => setRows(r.shows))
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  };

  // No inputs to fill in first, so there's nothing to wait on the coordinator for — running it
  // the moment the tool opens saves the otherwise-pointless extra click every time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, []);

  // Two different problems, not one: losing coverage entirely (can be near-zero even for a show
  // that's nothing BUT pianists, if there are enough of them) vs. a lineup with no variety and/or
  // nowhere for any of them to actually play.
  const noPiano = (r: PianistRow) => r.pianists_in_reach > 0 && !r.has_piano_onsite;
  const allPianists = (r: PianistRow) => r.non_pianists_booked === 0 && r.pianists_in_reach > 0;
  const flagged = rows?.filter((r) => r.pianist_risk > 0 || noPiano(r) || allPianists(r)) ?? [];

  return (
    <section className="tool-panel">
      <p className="subtitle">
        Which upcoming shows are structurally reliant on one pianist even after backups activate, are booked with
        no instrument but piano, or have pianists booked at a location with no piano.
      </p>
      <button className="button" onClick={run} disabled={loading}>{loading ? "Checking…" : rows ? "Re-check" : "Check pianist risk"}</button>
      {error && <p className="error">{error}</p>}
      {rows && (
        flagged.length === 0 ? (
          <p className="callout green" style={{ marginTop: 12 }}>Every upcoming show keeps a pianist in reach, has some instrument variety, and has a piano wherever one's needed.</p>
        ) : (
          <table className="comparison-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Show</th><th>Pianists in reach</th><th>Risk of losing pianist coverage</th><th>Lineup</th><th>Piano in room</th></tr></thead>
            <tbody>
              {flagged.map((r) => (
                <tr key={r.show_id}>
                  <td>{r.facility_name} · {formatDate(r.date)} · {r.start_time}</td>
                  <td>{r.pianists_in_reach}</td>
                  <td className={r.pianist_risk > 0.05 ? "delta-bad" : ""}>{(r.pianist_risk * 100).toFixed(1)}%</td>
                  <td className={allPianists(r) ? "muted" : ""}>
                    {allPianists(r) ? "All piano, no variety" : `${r.non_pianists_booked} non-piano`}
                  </td>
                  <td className={noPiano(r) ? "delta-bad" : ""}>{r.has_piano_onsite ? "✓ yes" : "✕ no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      <details className="why-estimate" style={{ marginTop: 12 }}>
        <summary>How this is modeled</summary>
        <p className="small muted">
          Reads the current, hard pianist requirement (a show isn't "fully staffed" without one) — it doesn't assume any
          proposed change to how pianist preference works, it just simulates cancellations 3,000 times and counts how
          often no pianist is left, even after ranked backups activate.
        </p>
      </details>
    </section>
  );
}

interface BufferRow { show_id: string; facility_id: string; facility_name: string; date: string; start_time: string; current_backups: number; backups_needed: number | null }

function BufferSizing({ onGoToBestDates }: { onGoToBestDates: (facilityId: string) => void }) {
  const [target, setTarget] = useState(0.95);
  const [rows, setRows] = useState<BufferRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api<{ shows: BufferRow[] }>(`/api/simulation/buffer-sizing?target_fill_rate=${target}`).then((r) => setRows(r.shows))
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  };

  // A sensible default target is already picked, so there's nothing to configure first.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, []);

  const short = rows?.filter((r) => r.backups_needed === null || r.backups_needed > r.current_backups) ?? [];

  return (
    <section className="tool-panel">
      <p className="subtitle">How many named backups each show would actually need to hit a target fill rate, not just how many it has.</p>
      <div className="form-row" style={{ maxWidth: 320 }}>
        <label>Target fill rate
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            <option value={0.9}>90%</option>
            <option value={0.95}>95%</option>
            <option value={0.99}>99%</option>
          </select>
        </label>
      </div>
      <button className="button" onClick={run} disabled={loading}>{loading ? "Checking…" : rows ? "Re-check" : "Check buffer sizes"}</button>
      {error && <p className="error">{error}</p>}
      {rows && (
        short.length === 0 ? (
          <p className="callout green" style={{ marginTop: 12 }}>Every show already has enough named backups for {Math.round(target * 100)}%.</p>
        ) : (
          <table className="comparison-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Show</th><th>Backups now</th><th>Needed for {Math.round(target * 100)}%</th><th /></tr></thead>
            <tbody>
              {short.map((r) => (
                <tr key={r.show_id}>
                  <td>{r.facility_name} · {formatDate(r.date)} · {r.start_time}</td>
                  <td>{r.current_backups}</td>
                  <td className="delta-bad">{r.backups_needed === null ? "more than 8" : r.backups_needed}</td>
                  <td>
                    {r.backups_needed === null && (
                      <button className="link-button small" onClick={() => onGoToBestDates(r.facility_id)}>
                        This isn't a buffer problem — see best dates for this location →
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}

interface RegionalRow {
  show_id: string; facility_name: string; date: string; start_time: string;
  from_region_count: number; fill_rate_normal: number; fill_rate_disrupted: number;
}

function RegionalDisruption() {
  const [regions, setRegions] = useState<string[]>([]);
  const [region, setRegion] = useState("");
  const [disruptionP, setDisruptionP] = useState(0.15);
  const [result, setResult] = useState<{ shows_affected: number; shows_total: number; shows: RegionalRow[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ regions: string[] }>("/api/simulation/regions").then((r) => { setRegions(r.regions); setRegion(r.regions[0] ?? ""); });
  }, []);

  const run = () => {
    if (!region) return;
    setLoading(true);
    setError(null);
    api<{ shows_affected: number; shows_total: number; shows: RegionalRow[] }>("/api/simulation/regional-disruption", {
      method: "POST", body: { region, disruption_p: disruptionP, disrupted_cancel_p: 0.7 },
    }).then(setResult).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };

  return (
    <section className="tool-panel">
      <p className="subtitle">
        What if everyone from one home region cancelled together — a storm, a transit outage — instead of
        cancellations happening one at a time.
      </p>
      <div className="scenario-layout">
        <div className="scenario-controls">
          <label>Region
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <div className="control">
            <span className="control-label">Chance of a disruption per show: <strong>{Math.round(disruptionP * 100)}%</strong></span>
            <input type="range" min={0.05} max={0.5} step={0.05} value={disruptionP}
                   onChange={(e) => setDisruptionP(Number(e.target.value))} />
          </div>
          <button className="button" onClick={run} disabled={loading || !region}>{loading ? "Running…" : "Run scenario"}</button>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="scenario-results">
          {!result && !loading && <p className="muted">Pick a region and run it — only shows with someone from that region show up.</p>}
          {result && (
            result.shows.length === 0 ? (
              <p className="callout green">No upcoming shows have anyone from {region} on the roster.</p>
            ) : (
              <>
                <p className="scenario-summary">
                  {result.shows_affected} of {result.shows_total} upcoming shows have someone from <strong>{region}</strong> on
                  the roster and would be exposed to a shared regional disruption.
                </p>
                <table className="comparison-table">
                  <thead><tr><th>Show</th><th>From {region}</th><th>Normal fill rate</th><th>If disrupted</th></tr></thead>
                  <tbody>
                    {result.shows.map((r) => (
                      <tr key={r.show_id}>
                        <td>{r.facility_name} · {formatDate(r.date)} · {r.start_time}</td>
                        <td>{r.from_region_count}</td>
                        <td>{Math.round(r.fill_rate_normal * 100)}%</td>
                        <td className={r.fill_rate_disrupted < r.fill_rate_normal - 0.01 ? "delta-bad" : "muted"}>
                          {Math.round(r.fill_rate_disrupted * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          )}
        </div>
      </div>
      <details className="why-estimate">
        <summary>How this is modeled</summary>
        <p className="small muted">
          Each simulated run either does or doesn't hit a shared disruption for that show's region-{region || "X"} group
          (the percentage above); when it does, everyone from that region on the show cancels together instead of
          independently. This is scoped per show, not across the whole network at once — two different shows on the same
          date don't share the same disruption draw.
        </p>
      </details>
    </section>
  );
}

function DemandGrowth({ facilityId, setFacilityId }: { facilityId: string; setFacilityId: (id: string) => void }) {
  const [locations, setLocations] = useState<Facility[]>([]);
  const [extraShows, setExtraShows] = useState(2);
  const [result, setResult] = useState<ScenarioResponse & { shows_added: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Facility[]>("/api/facilities").then((f) => {
      setLocations(f);
      if (!facilityId) setFacilityId(f[0]?.facility_id ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = () => {
    if (!facilityId) return;
    setLoading(true);
    setError(null);
    api<ScenarioResponse & { shows_added: number }>("/api/simulation/demand-growth", {
      method: "POST", body: { facility_id: facilityId, extra_shows: extraShows },
    }).then(setResult).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };

  return (
    <section className="tool-panel">
      <p className="subtitle">A location asks for more shows — spread across the current booking window, then re-solved.</p>
      <div className="scenario-layout">
        <div className="scenario-controls">
          <label>Location
            <Combobox value={facilityId} onChange={setFacilityId} placeholder="Search locations…"
                      options={locations.map((f) => ({ value: f.facility_id, label: f.display_name, sublabel: f.region }))} />
          </label>
          <label>Extra shows over the next {BOOKING_HORIZON_DAYS} days
            <input type="number" min={1} max={20} value={extraShows} onChange={(e) => setExtraShows(Number(e.target.value))} />
          </label>
          <button className="button" onClick={run} disabled={loading || !facilityId}>{loading ? "Running…" : "Run scenario"}</button>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="scenario-results">
          {loading && <SolveProgress steps={RESOLVE_STEPS} estimateSec={18} />}
          {!loading && !result && <p className="muted">Pick a location and how many extra shows, then run it.</p>}
          {!loading && result && (
            <>
              <p className="scenario-summary">
                Adding <strong>{result.shows_added} shows</strong> moves fill rate from{" "}
                <strong>{Math.round(result.baseline.fill_rate * 100)}%</strong> to{" "}
                <strong>{Math.round(result.scenario.fill_rate * 100)}%</strong>.
              </p>
              <KpiComparisonTable baseline={result.baseline} scenario={result.scenario} rows={KPI_ROWS} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

type Tool = "stress" | "extra" | "bestDates" | "capacityDrop" | "pianistRisk" | "bufferSizing" | "regionalDisruption" | "demandGrowth";

// "Network cost sensitivity" (fewer drivers / tighter guardian range vs. travel cost) used to be
// here too; cut for being a niche what-if against a small roster. The mileage-rate setting on the
// Schedule page covers the actual, standing "what does travel cost us" question this org does
// have now — see backend/workspace.py's mileage_rate.
const GROUPS: { label: string; tools: { id: Tool; title: string; sub: string }[] }[] = [
  { label: "Check a date", tools: [
    { id: "extra", title: "Would an extra show work?", sub: "Check a day and time before saying yes" },
    { id: "bestDates", title: "Best dates to book", sub: "Rank the strongest days and months for a location" },
  ] },
  { label: "Resilience", tools: [
    { id: "bufferSizing", title: "Buffer sizing", sub: "How many backups each show actually needs" },
    { id: "pianistRisk", title: "Pianist / skill risk", sub: "Shows reliant on a single pianist, or with no piano in the room" },
  ] },
  { label: "Stress test", tools: [
    { id: "stress", title: "Stress-test the schedule", sub: "More cancellations, fewer musicians" },
    { id: "capacityDrop", title: "Capacity drop", sub: "Highest-cap musicians lose most of their availability at once" },
    { id: "regionalDisruption", title: "Regional disruption", sub: "One region cancels together" },
  ] },
  { label: "Growth", tools: [
    { id: "demandGrowth", title: "Demand growth", sub: "A location asks for more shows" },
  ] },
];

const ALL_TOOL_IDS = new Set<string>(GROUPS.flatMap((g) => g.tools.map((t) => t.id)));

export default function ScenarioPlanner() {
  // Arriving with ?tool=bestDates&facility=LOC2 (a link from the demand forecast, or anywhere
  // else that already knows which tool and location matter) opens straight to it, instead of
  // landing on the default tool and making the location be picked again by hand.
  const [searchParams] = useSearchParams();
  const initialTool = searchParams.get("tool");
  const [tool, setTool] = useState<Tool>(initialTool && ALL_TOOL_IDS.has(initialTool) ? initialTool as Tool : "extra");
  // A location picked in one tool (Best dates, Would-an-extra-show-work, Demand growth) carries
  // over to the next one opened, instead of each independently defaulting back to the first
  // facility alphabetically every time — picking "Harbourview" once shouldn't mean re-picking it
  // again for every other tool in the same sitting.
  const [facilityId, setFacilityId] = useState(searchParams.get("facility") ?? "");

  const goTo = (t: Tool, forFacilityId?: string) => {
    if (forFacilityId) setFacilityId(forFacilityId);
    setTool(t);
  };

  // The tool panel itself doesn't scroll independently — the whole page does — so switching tools
  // left the new one's form scrolled out of view whenever the previous tool's results ran long.
  useEffect(() => { window.scrollTo({ top: 0 }); }, [tool]);

  return (
    <div>
      <h1>Scenario planner</h1>
      <div className="scenario-page">
        <nav className="scenario-tool-groups" aria-label="Scenario tools">
          {GROUPS.map((g) => (
            <div className="tool-group" key={g.label}>
              <span className="tool-group-label">{g.label}</span>
              {g.tools.map((t) => (
                <button key={t.id} role="tab" aria-selected={tool === t.id}
                        className={`tool-group-item${tool === t.id ? " active" : ""}`}
                        onClick={() => setTool(t.id)}>
                  <strong>{t.title}</strong>
                  <span>{t.sub}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="scenario-tool-content">
          {tool === "stress" && <StressTest />}
          {tool === "extra" && <NewShowCheck facilityId={facilityId} setFacilityId={setFacilityId} />}
          {tool === "bestDates" && <BestDates facilityId={facilityId} setFacilityId={setFacilityId} />}
          {tool === "capacityDrop" && <CapacityDrop />}
          {tool === "pianistRisk" && <PianistRisk />}
          {tool === "bufferSizing" && <BufferSizing onGoToBestDates={(id) => goTo("bestDates", id)} />}
          {tool === "regionalDisruption" && <RegionalDisruption />}
          {tool === "demandGrowth" && <DemandGrowth facilityId={facilityId} setFacilityId={setFacilityId} />}
        </div>
      </div>
    </div>
  );
}
