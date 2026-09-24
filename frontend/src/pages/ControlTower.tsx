import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { useApp, type CalendarFilter } from "../AppState";
import SolveProgress from "../components/SolveProgress";
import { StatusBadge } from "../components/Status";
import { formatDate, formatMonth, isoDate, parseDate, pct } from "../format";
import type { Change, Facility, Kpis, ScheduleView, ShowSummary, Status } from "../types";

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

function matches(show: ShowSummary, filter: Filter): boolean {
  if (filter === "red") return show.status === "red";
  if (filter === "amber") return show.status === "amber";
  if (filter === "week") {
    const { from, to } = weekWindow();
    return show.date >= from && show.date <= to;
  }
  return true;
}

/** What the last update moved, grouped into one card per show so a coordinator can see at a
 *  glance whose plans changed — and who to message. Names and show headers open their panels. */
function UpdateSummary({ changes, onDismiss }: { changes: Change[]; onDismiss: () => void }) {
  const { openPanel } = useApp();
  const byShow = new Map<string, Change[]>();
  for (const c of changes) byShow.set(c.show_id, [...(byShow.get(c.show_id) ?? []), c]);
  const people = new Set(changes.map((c) => c.musician_id)).size;

  return (
    <section className="update-summary">
      <div className="update-summary-head">
        <div>
          <h3>What the update changed</h3>
          <p className="small muted">
            {byShow.size} show{byShow.size !== 1 ? "s" : ""} · {people} musician{people !== 1 ? "s" : ""} affected —
            let them know their plans changed.
          </p>
        </div>
        <button className="link-button" onClick={onDismiss}>Dismiss</button>
      </div>
      <div className="update-cards">
        {[...byShow.entries()].sort(([, a], [, b]) => `${a[0].date}${a[0].start_time}`.localeCompare(`${b[0].date}${b[0].start_time}`))
          .map(([showId, rows]) => {
          const first = rows[0];
          const showGone = rows.every((c) => c.reason === "show was removed");
          const when = first.date ? <span>{formatDate(first.date)} · {first.start_time}{showGone ? " · removed" : ""}</span> : null;
          const header = showGone || !first.date
            ? <span className="update-card-title">{first.facility_name ?? "A removed show"} {when}</span>
            : <button className="update-card-title" onClick={() => openPanel({ kind: "show", id: showId })}>
                {first.facility_name} {when}
              </button>;
          return (
            <div key={showId} className="update-card">
              {header}
              <ul>
                {[...rows].sort((a, b) => (a.change === b.change ? 0 : a.change === "removed" ? -1 : 1)).map((c) => (
                  <li key={`${c.change}-${c.musician_id}`}>
                    <span className={`change-pill ${c.change}`}>{c.change === "added" ? "On" : "Off"}</span>
                    <button className="person-name" onClick={() => openPanel({ kind: "musician", id: c.musician_id })}>
                      {c.musician_name}
                    </button>
                    <span className="small muted">{c.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Shown only when an edit (new show, availability change, cancellation…) left the schedule out
 *  of date. Updating re-runs the optimizer, which moves as few people as it can to fit the change. */
function UpdateBar({ reason, onUpdated }: { reason: string; onUpdated: (changes: Change[]) => void }) {
  const { refresh, showToast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = () => {
    setBusy(true);
    setError(null);
    api<{ changes: Change[] }>("/api/schedule/resolve", { method: "POST" })
      .then((r) => {
        onUpdated(r.changes);
        refresh();
        showToast(r.changes.length ? `Schedule updated — ${r.changes.length} change${r.changes.length !== 1 ? "s" : ""}` : "Schedule updated — no one needed to move");
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
          </span>
          <button className="button" onClick={update} disabled={busy}>{busy ? "Updating…" : "Update schedule"}</button>
        </div>
        {busy && <SolveProgress steps={UPDATE_STEPS} estimateSec={8} />}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function KpiTile({ label, value, status, sub, active = false, onClick }: {
  label: string; value: string; status?: Status; sub?: ReactNode; active?: boolean; onClick?: () => void;
}) {
  const cls = `kpi-tile ${status ?? "neutral"} ${active ? "active" : ""}`;
  const inner = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {status && <StatusBadge status={status} compact />}
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  // A tile with nothing to click (e.g. a plain cost figure) renders as a static card, not a button
  // that looks interactive but does nothing.
  return onClick ? <button className={cls} onClick={onClick}>{inner}</button> : <div className={cls}>{inner}</div>;
}

function KpiStrip({ kpis, shows, filter, setFilter, onWeek }: {
  kpis: Kpis; shows: ShowSummary[]; filter: Filter; setFilter: (f: Filter) => void; onWeek: (firstDate?: string) => void;
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
               active={filter === "week"} onClick={() => { toggle("week"); if (filter !== "week") onWeek(week[0]?.date); }}
               sub={week.length === 0 ? "nothing scheduled this week"
                 : weekFlagged.length ? `${weekFlagged.length} need${weekFlagged.length === 1 ? "s" : ""} attention · click to highlight`
                 : "all on track · click to highlight"} />
      <KpiTile label="Fully staffed" value={pct(kpis.fill_rate)} status={fillStatus} active={filter === "red"}
               onClick={() => toggle("red")}
               sub={red ? `${red} show${red !== 1 ? "s" : ""} short as planned · click to show them` : "every show covered as planned"} />
      <KpiTile label="Backup coverage" value={pct(kpis.backup_coverage)} status={backupStatus} active={filter === "amber"}
               onClick={() => toggle("amber")}
               sub={amber ? `${amber} show${amber !== 1 ? "s" : ""} thin on backups · click to show them` : "every show has 3 backups incl. a pianist"} />
      <KpiTile label="Network cost" value={`~$${kpis.cost_per_show_dollars.toFixed(0)}/show`}
               sub={`$${Math.round(kpis.estimated_cost_dollars).toLocaleString()} total · ${kpis.total_car_km.toFixed(0)} car-km across all ${shows.length} upcoming shows · rough $/km estimate`} />
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
    return <p className="urgent-ok"><StatusBadge status="green" compact /> All {soon.length} show{soon.length !== 1 ? "s" : ""} in the next {URGENT_DAYS} days are on track.</p>;
  }
  const red = flagged.filter((s) => s.status === "red").length;
  const daysUntil = (d: string) => Math.round((parseDate(d).getTime() - today.getTime()) / 86_400_000);
  const when = (d: string) => { const n = daysUntil(d); return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`; };
  return (
    <section className={`callout ${red ? "red" : "amber"} urgent`}>
      <strong>
        {red > 0 && `${red} show${red !== 1 ? "s" : ""} not fully staffed`}
        {red > 0 && flagged.length > red && " and "}
        {flagged.length > red && `${flagged.length - red} thin on backups`} in the next {URGENT_DAYS} days
      </strong>
      <div className="urgent-list">
        {flagged.map((s) => (
          <button key={s.show_id} className={`urgent-item ${s.status}`} onClick={() => onOpen(s)}>
            <StatusBadge status={s.status} compact />
            <span className="urgent-when">{when(s.date)}</span>
            <span>{s.facility_name} · {formatDate(s.date)} {s.start_time}</span>
            <span className="small muted">{s.reasons[0]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Roadmap({ shows, onOpen }: { shows: ShowSummary[]; onOpen: (s: ShowSummary) => void }) {
  const today = isoDate(new Date());
  const next = shows.filter((s) => s.date >= today).slice(0, 5);
  if (next.length === 0) return null;
  return (
    <div className="roadmap">
      <h3>Next up</h3>
      <div className="roadmap-strip">
        {next.map((s) => (
          <button key={s.show_id} className={`roadmap-card ${s.status}`} onClick={() => onOpen(s)}>
            <span className="roadmap-date">{formatDate(s.date)} · {s.start_time}</span>
            <span className="roadmap-facility">{s.facility_name}</span>
            <span className="roadmap-meta">
              <StatusBadge status={s.status} compact /> {s.musician_count}/{s.target_musicians} musicians · {s.backup_count} backups
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
function FacilityGantt({ month, shows, facilities, onOpen }: {
  month: string; shows: ShowSummary[]; facilities: Facility[]; onOpen: (s: ShowSummary) => void;
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
                      <button className={`gantt-cell ${show.status}`} onClick={() => onOpen(show)}
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

function Calendar({ month, shows, filter, onOpen, onAdd }: {
  month: string; shows: ShowSummary[]; filter: Filter; onOpen: (s: ShowSummary) => void; onAdd: (date: string) => void;
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
                      onClick={() => onOpen(s)} title={s.reasons.join("; ") || "On track"}>
                <StatusBadge status={s.status} compact />
                <span className="chip-text">{s.start_time} {s.facility_name}</span>
                {s.locked_count > 0 && <span aria-label="has locks">🔒</span>}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function AtAGlance({ view }: { view: ScheduleView }) {
  const k = view.kpis;
  return (
    <details className="at-a-glance">
      <summary>This month at a glance — travel, fairness, rotation</summary>
      <div className="glance-grid">
        <div><span className="kpi-label">Capacity used</span><strong>{pct(k.capacity_utilization_mean)}</strong>
          <span className="small muted">of everyone's monthly caps · spread ±{pct(k.capacity_utilization_spread)}</span></div>
        <div><span className="kpi-label">Cars</span><strong>{k.total_cars}</strong>
          <span className="small muted">{k.total_car_km.toFixed(0)} car-km ({k.guardian_car_km.toFixed(0)} by guardians)</span></div>
        <div><span className="kpi-label">Carpool savings</span><strong>{k.car_km_savings.toFixed(0)} km</strong>
          <span className="small muted">vs. everyone driving alone · {k.solo_transit_count} trips by transit</span></div>
        <div><span className="kpi-label">Repeat visits</span><strong>{pct(k.rotation_repeat_rate)}</strong>
          <span className="small muted">of assignments go back to a location they've played recently</span></div>
      </div>
      <h3>Musician-show slots needed vs. marked available, by week</h3>
      <p className="small muted">
        Counted per show, not per person — one musician saying yes to 3 shows in a week counts as 3,
        so "available" isn't capped at the roster size and can run well past it in a busy week.
      </p>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={view.weekly_capacity}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11 }} tickFormatter={(w: string) => formatDate(w.slice(0, 10))} />
          <YAxis allowDecimals={false} />
          <Tooltip formatter={(value, name) => [`${value} slots`, name]} />
          <Legend />
          <Bar dataKey="needed" name="Needed (slots)" fill="#2a78d6" radius={[4, 4, 0, 0]} />
          <Bar dataKey="available" name="Marked available (slots)" fill="var(--neutral-series)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </details>
  );
}

export default function ControlTower() {
  const { version, openPanel, calendarFilter: filter, setCalendarFilter: setFilter,
          calendarMonth: pickedMonth, setCalendarMonth: setMonth } = useApp();
  const [view, setView] = useState<ScheduleView | null>(null);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [calView, setCalView] = useState<"calendar" | "facility">("calendar");
  const [error, setError] = useState<string | null>(null);
  const [justResolved, setJustResolved] = useState<Change[] | null>(null);

  useEffect(() => {
    api<ScheduleView>("/api/schedule").then(setView).catch((e) => setError(e.message));
    api<Facility[]>("/api/facilities").then(setFacilities);
  }, [version]);

  const months = useMemo(() => [...new Set((view?.shows ?? []).map((s) => s.date.slice(0, 7)))].sort(), [view]);
  const thisMonth = isoDate(new Date()).slice(0, 7);
  const month = pickedMonth ?? months.find((m) => m >= thisMonth) ?? months[0];

  if (error) return <p className="error">Couldn't load the schedule: {error}</p>;
  if (!view || !month) return <p className="muted loading">Loading this month's schedule…</p>;

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
                onWeek={(d) => { if (d) setMonth(d.slice(0, 7)); }} />
      <Roadmap shows={view.shows} onOpen={open} />

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
          {filter !== "all" && calView === "calendar" && (
            <span className="filter-note">
              Showing {filter === "red" ? "not fully staffed" : filter === "amber" ? "thin on backups" : `the next ${URGENT_DAYS} days`} ·{" "}
              <button className="link-button" onClick={() => setFilter("all")}>Show all shows</button>
            </span>
          )}
        </div>
      </div>
      {calView === "calendar"
        ? <Calendar month={month} shows={view.shows} filter={filter} onOpen={open}
                    onAdd={(date) => openPanel({ kind: "addShow", date })} />
        : <FacilityGantt month={month} shows={view.shows} facilities={facilities} onOpen={open} />}

      <AtAGlance view={view} />
    </div>
  );
}
