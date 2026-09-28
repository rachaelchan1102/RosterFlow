import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFocusTrap } from "../useFocusTrap";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { useApp, type CalendarFilter } from "../AppState";
import SolveProgress from "../components/SolveProgress";
import { StatusBadge } from "../components/Status";
import UpdateSummary from "../components/UpdateSummary";
import { formatDate, formatMonth, isoDate, parseDate, pct } from "../format";
import { updateResultMessage } from "../scheduleUpdate";
import type { CapacityForecastRow, Change, Facility, Kpis, ScheduleView, ShowSummary, StillShort, Status } from "../types";

type Filter = CalendarFilter;
const URGENT_DAYS = 7;
const UPDATE_STEPS = [
  "Checking who's available for each show",
  "Matching musicians to shows",
  "Balancing workload, travel and rotation",
  "Ranking backups and planning carpools",
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The next URGENT_DAYS days, as ISO date bounds (today inclusive). */
function weekWindow(): { from: string; to: string } {
  const today = parseDate(isoDate(new Date()));
  return { from: isoDate(today), to: isoDate(new Date(today.getTime() + URGENT_DAYS * 86_400_000)) };
}

/** A calendar cell is only wide enough for a handful of characters — a full facility name just
 *  truncates to something unreadable ("Wi…", "Ha…"). A 3-letter code plus the headcount actually
 *  tells you something at a glance; the full name is still one hover (the chip's title) away. */
function shortCode(name: string): string {
  return name.replace(/[^A-Za-z ]/g, "").split(" ")[0].slice(0, 3).toUpperCase();
}

function matches(show: ShowSummary, filter: Filter): boolean {
  if (filter === "red") return show.status === "red";
  // A red show is the single most urgent thing on the calendar — the amber ("thin on backups")
  // filter shouldn't dim it into the background just because it isn't literally amber; that
  // filter is meant to surface a NARROWER concern on top of the calendar, not hide something
  // more urgent than what it's looking for. "week" stays a pure date-range filter, since mixing
  // urgency into it would make the 7-day window show things outside the 7 days.
  if (filter === "amber") return show.status === "amber" || show.status === "red";
  if (filter === "week") {
    const { from, to } = weekWindow();
    return show.date >= from && show.date <= to;
  }
  return true;
}

/** Shown only when an edit (new show, availability change, cancellation…) left the schedule out
 *  of date. Updating re-runs the optimizer, which moves as few people as it can to fit the change. */
function UpdateBar({ reason, onUpdated }: { reason: string; onUpdated: (changes: Change[]) => void }) {
  const { refresh, showToast, setLastUpdateChanges } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = () => {
    setBusy(true);
    setError(null);
    api<{ changes: Change[]; still_short: StillShort[] }>("/api/schedule/resolve", { method: "POST" })
      .then((r) => {
        onUpdated(r.changes);
        setLastUpdateChanges(r.changes.length > 0 ? r.changes : null);
        refresh();
        showToast(updateResultMessage(r.changes, r.still_short));
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="update-bar-wrap">
      <div className="callout amber update-bar">
        <div className="update-bar-row">
          <span>
            <strong>The schedule needs updating.</strong> {reason}{" "}
            <span className="small">Updating finds the best fit while moving as few people as possible — usually a few seconds, up to 20.</span>
            <details className="why-estimate">
              <summary>What does updating do?</summary>
              <ul className="small muted update-explainer">
                <li>Re-checks who's available and fills any gap this change left — a new show with no one on it, or a spot a cancellation opened up.</li>
                <li>Keeps anyone locked to a show exactly where they are, and never touches anyone banned from one.</li>
                <li>Only moves someone already assigned elsewhere if it has to, to make the new numbers work — it doesn't rebuild the whole month from scratch.</li>
                <li>Re-ranks backups for every affected show.</li>
                <li>Nothing changes until you click the button below — editing the roster or a show only marks the schedule as needing this.</li>
              </ul>
            </details>
          </span>
          <button className="button" onClick={update} disabled={busy}>{busy ? "Updating…" : "Update schedule"}</button>
        </div>
        {busy && <SolveProgress steps={UPDATE_STEPS} estimateSec={8} />}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function KpiTile({ label, value, status, statusLabel, sub, active = false, onClick }: {
  label: string; value: string; status?: Status; statusLabel?: string; sub?: ReactNode; active?: boolean; onClick?: () => void;
}) {
  const cls = `kpi-tile ${status ?? "neutral"} ${active ? "active" : ""}`;
  const inner = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {status && <StatusBadge status={status} label={statusLabel} compact />}
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  // A tile with nothing to click (e.g. a plain cost figure) renders as a static card, not a button
  // that looks interactive but does nothing.
  return onClick ? <button className={cls} onClick={onClick}>{inner}</button> : <div className={cls}>{inner}</div>;
}

function KpiStrip({ kpis, shows, filter, setFilter, onWeek, onOpenMileageSettings }: {
  kpis: Kpis; shows: ShowSummary[]; filter: Filter; setFilter: (f: Filter) => void; onWeek: (firstDate?: string) => void;
  onOpenMileageSettings: () => void;
}) {
  const red = shows.filter((s) => s.status === "red").length;
  const amber = shows.filter((s) => s.status === "amber").length;
  const week = shows.filter((s) => matches(s, "week"));
  const weekFlagged = week.filter((s) => s.status !== "green");
  const fillStatus: Status = red === 0 ? "green" : "red";
  const backupStatus: Status = kpis.backup_coverage >= 0.9 ? "green" : kpis.backup_coverage >= 0.7 ? "amber" : "red";
  const weekStatus: Status = week.some((s) => s.status === "red") ? "red" : weekFlagged.length ? "amber" : "green";
  const toggle = (f: Filter) => setFilter(filter === f ? "all" : f);
  return (
    <div className="kpi-strip">
      <KpiTile label={`Next ${URGENT_DAYS} days`} value={`${week.length} show${week.length !== 1 ? "s" : ""}`} status={weekStatus}
               statusLabel={weekStatus === "red" ? "Needs attention" : weekStatus === "amber" ? "Below target or thin backups" : "On track"}
               active={filter === "week"} onClick={() => { toggle("week"); if (filter !== "week") onWeek(week[0]?.date); }}
               sub={week.length === 0 ? "nothing scheduled this week"
                 : weekFlagged.length ? `${weekFlagged.length} need${weekFlagged.length === 1 ? "s" : ""} attention · click to highlight`
                 : "all on track · click to highlight"} />
      <KpiTile label="Fill rate" value={pct(kpis.fill_rate)} status={fillStatus}
               statusLabel={fillStatus === "red" ? "Below minimum or no backups" : "At target headcount"}
               active={filter === "red"} onClick={() => toggle("red")}
               sub={red ? `${red} show${red !== 1 ? "s" : ""} below minimum or with no backups · click to show them`
                 : "share of shows at full target headcount, not just the minimum"} />
      <KpiTile label="Backups available" value={pct(kpis.backup_coverage)} status={backupStatus}
               statusLabel={backupStatus === "red" ? "Backups running low" : backupStatus === "amber" ? "Thin on backups" : "Backups healthy"}
               active={filter === "amber"} onClick={() => toggle("amber")}
               sub={amber ? `${amber} show${amber !== 1 ? "s" : ""} thin on backups · click to show them` : "every show has 3 backups incl. a pianist"} />
      <KpiTile label="Car travel cost" value={`$${kpis.car_cost_total.toFixed(0)}`} onClick={onOpenMileageSettings}
               sub={`${kpis.total_car_km.toFixed(0)} km across ${kpis.total_cars} cars, ${shows.length} upcoming shows · $${kpis.car_cost_savings.toFixed(0)}`
                 + ` (${kpis.car_km_savings.toFixed(0)} km) saved by carpooling · at $${kpis.mileage_rate.toFixed(2)}/km, click to change`} />
    </div>
  );
}

/** Small standalone dialog for the $/km reimbursement rate — a coordinator preference, not a
 *  schedule edit, so it lives outside the panel stack (same pattern as Layout's LoginDialog). */
function MileageRateDialog({ rate, onClose, onSaved }: { rate: number; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(rate.toString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLFormElement>(true);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) { setError("Enter a number, 0 or more."); return; }
    setBusy(true);
    api("/api/settings/mileage-rate", { method: "PUT", body: { rate: parsed } })
      .then(() => { onSaved(); onClose(); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <form ref={trapRef} tabIndex={-1} className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Mileage reimbursement rate</h2>
        <p className="muted small">Used to turn car-km figures into a dollar cost across the schedule.</p>
        <label>$ per km
          <input type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="panel-footer">
          <button className="button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** What a coordinator opens the app to find out: anything wrong in the next week, soonest first. */
function Urgent({ shows, onOpen }: { shows: ShowSummary[]; onOpen: (s: ShowSummary) => void }) {
  const today = parseDate(isoDate(new Date()));
  const soon = shows.filter((s) => matches(s, "week"));
  const flagged = soon.filter((s) => s.status !== "green");
  if (soon.length === 0) return null;
  if (flagged.length === 0) {
    return <p className="urgent-ok"><StatusBadge status="green" compact /> {soon.length === 1 ? "The 1 show" : `All ${soon.length} shows`} in the next {URGENT_DAYS} days {soon.length === 1 ? "is" : "are"} on track.</p>;
  }
  const red = flagged.filter((s) => s.status === "red").length;
  const amber = flagged.length - red;
  const daysUntil = (d: string) => Math.round((parseDate(d).getTime() - today.getTime()) / 86_400_000);
  const when = (d: string) => { const n = daysUntil(d); return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`; };
  return (
    <section className={`callout ${red ? "red" : "amber"} urgent`}>
      <strong>
        {red > 0 && `${red} show${red !== 1 ? "s" : ""} need${red === 1 ? "s" : ""} attention`}
        {red > 0 && amber > 0 && " and "}
        {amber > 0 && `${amber} thin on backups or under target`} in the next {URGENT_DAYS} days
      </strong>
      <div className="urgent-list">
        {flagged.map((s) => (
          <button key={s.show_id} className={`urgent-item ${s.status}`} onClick={() => onOpen(s)}>
            <StatusBadge status={s.status} label={s.status_label} compact />
            <span className="urgent-when">{when(s.date)}</span>
            <span>{s.facility_name} · {formatDate(s.date)} {s.start_time}</span>
            <span className="small muted">{s.reasons[0]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Roadmap({ shows, filter, onOpen }: { shows: ShowSummary[]; filter: Filter; onOpen: (s: ShowSummary) => void }) {
  const today = isoDate(new Date());
  const next = shows.filter((s) => s.date >= today).slice(0, 5);
  if (next.length === 0) return null;
  return (
    <div className="roadmap">
      <h3>Next up</h3>
      <div className="roadmap-strip">
        {next.map((s) => (
          <button key={s.show_id} className={`roadmap-card ${s.status} ${matches(s, filter) ? "" : "dimmed"}`} onClick={() => onOpen(s)}>
            <span className="roadmap-date">{formatDate(s.date)} · {s.start_time}</span>
            <span className="roadmap-facility">{s.facility_name}</span>
            <span className="roadmap-meta">
              <StatusBadge status={s.status} label={s.status_label} compact /> {s.musician_count}/{s.target_musicians} musicians · {s.backup_count} backups
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The same show + status data as the month calendar, pivoted facility-as-row instead of
 *  date-as-cell — the coverage-across-the-network framing a logistics control room uses instead
 *  of a personal calendar grid. */
function FacilityGantt({ month, shows, facilities, filter, onOpen }: {
  month: string; shows: ShowSummary[]; facilities: Facility[]; filter: Filter; onOpen: (s: ShowSummary) => void;
}) {
  const first = parseDate(`${month}-01`);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const today = isoDate(new Date());

  const byCell = new Map<string, ShowSummary>();
  shows.forEach((s) => byCell.set(`${s.facility_id}|${s.date}`, s));
  const sorted = [...facilities].sort((a, b) => a.display_name.localeCompare(b.display_name));

  return (
    <div className="gantt-scroll">
      <table className="gantt">
        <thead>
          <tr>
            <th className="gantt-corner">Location</th>
            {days.map((d) => {
              const date = `${month}-${String(d).padStart(2, "0")}`;
              return <th key={d} className={date === today ? "today" : ""}>{d}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => (
            <tr key={f.facility_id}>
              <th className="gantt-row-label">{f.display_name}</th>
              {days.map((d) => {
                const date = `${month}-${String(d).padStart(2, "0")}`;
                const show = byCell.get(`${f.facility_id}|${date}`);
                return (
                  <td key={d} className={date === today ? "today" : ""}>
                    {show && (
                      <button className={`gantt-cell ${show.status} ${matches(show, filter) ? "" : "dimmed"}`} onClick={() => onOpen(show)}
                              title={`${f.display_name} · ${show.start_time} · ${show.reasons.join("; ") || "On track"}`} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Calendar({ month, shows, filter, changedShowIds, onOpen, onAdd }: {
  month: string; shows: ShowSummary[]; filter: Filter; changedShowIds: Set<string>;
  onOpen: (s: ShowSummary) => void; onAdd: (date: string) => void;
}) {
  const first = parseDate(`${month}-01`);
  const lead = (first.getDay() + 6) % 7;   // Monday-first
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const byDate = new Map<string, ShowSummary[]>();
  shows.forEach((s) => byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]));
  const today = isoDate(new Date());

  const cells: (string | null)[] = [...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);

  return (
    <div className="calendar">
      {WEEKDAYS.map((d) => <div key={d} className="calendar-weekday">{d}</div>)}
      {cells.map((date, i) => {
        if (!date) return <div key={`blank-${i}`} className="calendar-cell blank" />;
        const dayShows = byDate.get(date) ?? [];
        return (
          <div key={date} className={`calendar-cell ${date === today ? "today" : ""}`}>
            <div className="calendar-day">
              <span>{Number(date.slice(8))}</span>
              {date >= today && (
                <button className="add-show-button" title="Add a show on this day" onClick={() => onAdd(date)}>+</button>
              )}
            </div>
            {dayShows.map((s) => (
              <button key={s.show_id} className={`show-chip ${s.status} ${matches(s, filter) ? "" : "dimmed"}`}
                      onClick={() => onOpen(s)} title={`${s.facility_name} · ${s.reasons.join("; ") || "On track"}`}>
                <StatusBadge status={s.status} label={s.status_label} compact />
                <span className="chip-time">{s.start_time}</span>
                <span className="chip-text">{shortCode(s.facility_name)} {s.musician_count}/{s.target_musicians}</span>
                {s.locked_count > 0 && <span aria-label="has locks">🔒</span>}
                {changedShowIds.has(s.show_id) && <span className="chip-changed" title="Changed by the last update" aria-label="changed by the last update">●</span>}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** S&OP-style demand-vs-capacity: what the next few months need, projected from each location's
 *  typical cadence and the roster's historical yes-rate — not a claim about specific future shows
 *  that don't exist yet, just the same "needed vs. available" idea pointed forward instead of
 *  only backward. */
// A chart here used to be three visually-identical monthly bar pairs (this sample-data model has
// no seasonality to actually show) — the same information in one sentence, without implying a
// month-to-month shape that isn't real.
function CapacityForecast() {
  const [rows, setRows] = useState<CapacityForecastRow[]>([]);
  const [rosterSize, setRosterSize] = useState(0);
  useEffect(() => {
    api<{ months: CapacityForecastRow[]; roster_size: number }>("/api/capacity-forecast")
      .then((r) => { setRows(r.months); setRosterSize(r.roster_size); });
  }, []);
  if (rows.length === 0) return null;
  const avgNeeded = rows.reduce((s, r) => s + r.needed, 0) / rows.length;
  const avgAvailable = rows.reduce((s, r) => s + r.available, 0) / rows.length;
  const target = rows[0].target_roster_size;
  const gap = target !== null ? target - rosterSize : null;
  return (
    <>
      <h3>Projected demand vs. capacity, next {rows.length} months</h3>
      <p className="small">
        Projected: ~{Math.round(avgNeeded)} slots/month needed, ~{Math.round(avgAvailable)} available
        ({(avgAvailable / avgNeeded).toFixed(1)}×).
      </p>
      {target !== null && (
        <p className="small">
          Target roster size to comfortably cover that: <strong>~{target} musicians</strong>
          {" "}(currently {rosterSize}
          {gap !== null && gap > 0 && <>, about <strong>{gap} short</strong></>}
          {gap !== null && gap <= 0 && ", already enough"}).
        </p>
      )}
      <p className="small muted">
        Projected, not scheduled — each location's typical monthly cadence times its target headcount, against the
        roster's overall historical yes-rate and each musician's own monthly cap. No shows this far out actually
        exist yet, and this model has no seasonality (no accounting for holidays or exam periods) — treat the
        target as a rough recruiting goal, not a precise headcount.
      </p>
    </>
  );
}

interface CostWaterfallRow { month: string; baseline_km: number; carpool_savings_km: number; transit_km: number; actual_km: number; cost: number }

/** Solo-driving km, chunked into what carpooling and transit riders take off it, ending at the
 *  real car-km and its dollar figure — the number that actually justifies the pooling work,
 *  instead of a bare "km saved" figure with nothing to compare it against. */
function CostWaterfall() {
  const [rows, setRows] = useState<CostWaterfallRow[]>([]);
  useEffect(() => { api<{ months: CostWaterfallRow[] }>("/api/cost-waterfall").then((r) => setRows(r.months)); }, []);
  if (rows.length === 0) return null;
  return (
    <>
      <h3>Car travel cost, by month</h3>
      <p className="small muted">
        Stacked from the bottom: the actual car-km driven, then what carpooling saved, then what transit riders
        saved by not driving at all — together adding back up to what it would cost if everyone drove alone.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={(m: string) => formatMonth(m)} />
          <YAxis allowDecimals={false} unit=" km" />
          <Tooltip formatter={(value, name) => [`${value} km`, name]}
                   labelFormatter={(m) => formatMonth(String(m))} />
          <Legend />
          <Bar dataKey="actual_km" name="Actual car-km" stackId="a" fill="#2a78d6" />
          <Bar dataKey="carpool_savings_km" name="Saved by carpooling" stackId="a" fill="var(--mode-carpool)" fillOpacity={0.45} />
          <Bar dataKey="transit_km" name="Saved by transit" stackId="a" fill="var(--mode-transit)" fillOpacity={0.45} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <p className="small muted">
        {rows.map((r) => `${formatMonth(r.month)}: $${r.cost.toFixed(0)}`).join(" · ")}
      </p>
    </>
  );
}

function AtAGlance({ view }: { view: ScheduleView }) {
  const k = view.kpis;
  return (
    <details className="at-a-glance">
      <summary>The upcoming schedule at a glance — travel, fairness, rotation</summary>
      <div className="glance-grid">
        <div><span className="kpi-label">Capacity used</span><strong>{pct(k.capacity_utilization_mean)}</strong>
          <span className="small muted">of everyone's monthly caps, averaged across the whole booking window · spread ±{pct(k.capacity_utilization_spread)}</span></div>
        <div><span className="kpi-label">Cars</span><strong>{k.total_cars}</strong>
          <span className="small muted">{k.total_car_km.toFixed(0)} car-km, ${k.car_cost_total.toFixed(0)} ({k.guardian_car_km.toFixed(0)} km by guardians)</span></div>
        <div><span className="kpi-label">Carpool savings</span><strong>{k.car_km_savings.toFixed(0)} km · ${k.car_cost_savings.toFixed(0)}</strong>
          <span className="small muted">vs. everyone driving alone · {k.solo_transit_count} trips by transit</span></div>
        <div><span className="kpi-label">Repeat visits</span><strong>{pct(k.rotation_repeat_rate)}</strong>
          <span className="small muted">of assignments go back to a location they've played recently</span></div>
      </div>
      <h3>Musician-slots needed vs. unique musicians free, by week</h3>
      <p className="small muted">
        "Needed" is slots (a show wanting 7 counts as 7); "available" is unique people — each musician counted once
        per week, and only if they're still under their monthly cap, so a busy person free for 3 shows that week
        doesn't inflate the number 3×.
      </p>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={view.weekly_capacity}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11 }} tickFormatter={(w: string) => formatDate(w.slice(0, 10))} />
          <YAxis allowDecimals={false} />
          <Tooltip formatter={(value, name) => [value, name]} />
          <Legend />
          <Bar dataKey="needed" name="Needed (slots)" fill="#2a78d6" radius={[4, 4, 0, 0]} />
          <Bar dataKey="available" name="Free and under cap (musicians)" fill="var(--neutral-series)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <CostWaterfall />
      <CapacityForecast />
    </details>
  );
}

export default function ControlTower() {
  const { version, refresh, openPanel, calendarFilter: filter, setCalendarFilter: setFilter,
          calendarMonth: pickedMonth, setCalendarMonth: setMonth, lastUpdateChanges } = useApp();
  const [view, setView] = useState<ScheduleView | null>(null);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [calView, setCalView] = useState<"calendar" | "facility">("calendar");
  const [error, setError] = useState<string | null>(null);
  const [justResolved, setJustResolved] = useState<Change[] | null>(null);
  const [mileageSettingsOpen, setMileageSettingsOpen] = useState(false);
  const changedShowIds = useMemo(() => new Set((lastUpdateChanges ?? []).map((c) => c.show_id)), [lastUpdateChanges]);

  useEffect(() => {
    setError(null);
    api<ScheduleView>("/api/schedule").then(setView).catch((e) => setError(e.message));
    api<Facility[]>("/api/facilities").then(setFacilities).catch(() => undefined);
  }, [version]);

  const months = useMemo(() => [...new Set((view?.shows ?? []).map((s) => s.date.slice(0, 7)))].sort(), [view]);
  const thisMonth = isoDate(new Date()).slice(0, 7);
  const month = pickedMonth ?? months.find((m) => m >= thisMonth) ?? months[0];

  if (error) {
    return (
      <p className="error">
        Couldn't load the schedule: {error}. <button className="link-button" onClick={refresh}>Retry</button>
      </p>
    );
  }
  if (!view) return <p className="muted loading">Loading this month's schedule…</p>;
  if (months.length === 0) {
    return (
      <div className="empty-state">
        <h2>No shows scheduled yet</h2>
        <p className="muted">Add the first show to start building the schedule.</p>
        <button className="button" onClick={() => openPanel({ kind: "addShow" })}>+ New show</button>
      </div>
    );
  }

  const monthIdx = months.indexOf(month);
  const open = (s: ShowSummary) => { setMonth(s.date.slice(0, 7)); openPanel({ kind: "show", id: s.show_id }); };

  return (
    <div>
      {view.state.needs_resolve && <UpdateBar reason={view.state.needs_resolve} onUpdated={setJustResolved} />}
      {justResolved && justResolved.length > 0 && (
        <UpdateSummary changes={justResolved} onDismiss={() => setJustResolved(null)} />
      )}

      <Urgent shows={view.shows} onOpen={open} />
      <KpiStrip kpis={view.kpis} shows={view.shows} filter={filter} setFilter={setFilter}
                onWeek={(d) => { if (d) setMonth(d.slice(0, 7)); }}
                onOpenMileageSettings={() => setMileageSettingsOpen(true)} />
      {mileageSettingsOpen && (
        <MileageRateDialog rate={view.kpis.mileage_rate} onClose={() => setMileageSettingsOpen(false)} onSaved={refresh} />
      )}
      <Roadmap shows={view.shows} filter={filter} onOpen={open} />

      <div className="calendar-head">
        <div className="month-nav">
          <button className="button secondary" disabled={monthIdx <= 0} onClick={() => setMonth(months[monthIdx - 1])}>‹</button>
          <h2>{formatMonth(month)}</h2>
          <button className="button secondary" disabled={monthIdx >= months.length - 1} onClick={() => setMonth(months[monthIdx + 1])}>›</button>
        </div>
        <div className="view-toggle" role="tablist">
          <button role="tab" aria-selected={calView === "calendar"} className={calView === "calendar" ? "active" : ""}
                  onClick={() => setCalView("calendar")}>Calendar</button>
          <button role="tab" aria-selected={calView === "facility"} className={calView === "facility" ? "active" : ""}
                  onClick={() => setCalView("facility")}>Facility view</button>
        </div>
        <div className="legend">
          <StatusBadge status="green" /> <StatusBadge status="amber" /> <StatusBadge status="red" />
          {filter !== "all" && (
            <span className="filter-note">
              Showing {filter === "red" ? "not fully staffed" : filter === "amber" ? "thin on backups" : `the next ${URGENT_DAYS} days`} ·{" "}
              <button className="link-button" onClick={() => setFilter("all")}>Clear filter</button>
            </span>
          )}
        </div>
      </div>
      {calView === "calendar"
        ? <Calendar month={month} shows={view.shows} filter={filter} changedShowIds={changedShowIds} onOpen={open}
                    onAdd={(date) => openPanel({ kind: "addShow", date })} />
        : <FacilityGantt month={month} shows={view.shows} facilities={facilities} filter={filter} onOpen={open} />}

      <AtAGlance view={view} />
    </div>
  );
}
