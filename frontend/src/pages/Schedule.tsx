import { useMemo, useState, type ReactNode } from "react";
import { useApp } from "../AppState";
import { Mark, Segmented, ToneLegend } from "../components/Mark";
import { isoDate } from "../format";
import {
  dayLabelComma, numberWord, plural, rangeLabel, scheduleWindow, shortDate, showTone, siteCode, siteName,
  WEEKDAYS, weekdayIndex, weekdayLong,
} from "../rosterflow";
import type { Facility, ShowSummary } from "../types";
import { useFacilities, useSchedule } from "../useData";

type View = "month" | "site";

/** One or two sentences a coordinator can act on: how much is coming up, then the worst gap and
 *  the show with nothing left to fall back on, each a link straight to that show. */
function Summary({ shows, today, open }: { shows: ShowSummary[]; today: string; open: (s: ShowSummary) => void }) {
  const upcoming = shows.filter((s) => s.date >= today);
  if (upcoming.length === 0) return <p className="lede">No shows in these five weeks.</p>;
  const sites = new Set(upcoming.map((s) => s.facility_id)).size;
  const first = upcoming[0].date;
  const daysOut = Math.round((new Date(`${first}T00:00`).getTime() - new Date(`${today}T00:00`).getTime()) / 86_400_000);
  const starting = daysOut === 0 ? "starting today" : daysOut === 1 ? "starting tomorrow"
    : daysOut < 7 ? `starting ${weekdayLong(first)}` : `starting ${shortDate(first)}`;

  const gap = (s: ShowSummary) => s.target_musicians - s.musician_count;
  const shortest = [...upcoming].filter((s) => gap(s) > 0).sort((a, b) => gap(b) - gap(a) || a.date.localeCompare(b.date))[0];
  const bare = upcoming.find((s) => s.backup_count === 0 && s.show_id !== shortest?.show_id);
  const link = (s: ShowSummary) => (
    <a href="#" onClick={(e) => { e.preventDefault(); open(s); }}>{siteName(s.facility_name)} on {shortDate(s.date)}</a>
  );
  const parts: ReactNode[] = [];
  if (shortest) {
    const n = gap(shortest);
    parts.push(<>{link(shortest)} is {numberWord(n)} musician{n === 1 ? "" : "s"} short</>);
  }
  if (bare) parts.push(<>{link(bare)} has nobody left to call if someone drops</>);

  return (
    <p className="lede">
      {plural(upcoming.length, "show")} across {plural(sites, "site")} in the next five weeks, {starting}.
      {parts.length === 0 && " Every show is at target with backups to call."}
      {parts.length === 1 && <> {parts[0]}.</>}
      {parts.length === 2 && <> {parts[0]}, and {parts[1]}.</>}
    </p>
  );
}

function MonthGrid({ days, shows, today, selectedId, open }: {
  days: string[]; shows: ShowSummary[]; today: string; selectedId: string | null; open: (s: ShowSummary) => void;
}) {
  const byDate = new Map<string, ShowSummary[]>();
  shows.forEach((s) => byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]));
  return (
    <div className="month-grid">
      {WEEKDAYS.map((w) => <div key={w} className="month-weekday">{w}</div>)}
      {days.map((d, i) => {
        const label = i === 0 || d.endsWith("-01") ? shortDate(d) : String(Number(d.slice(8)));
        return (
          <div key={d} className={`month-cell${d < today ? " past" : ""}`}>
            <div className="month-daynum">{label}</div>
            {(byDate.get(d) ?? []).map((s) => {
              const t = showTone(s);
              return (
                <button key={s.show_id} className={`chip${selectedId === s.show_id ? " selected" : ""}`}
                        title={`${s.facility_name} · ${s.start_time}`} onClick={() => open(s)}>
                  <Mark tone={t} size={7} />
                  <span className="chip-code">{siteCode(s.facility_name)}</span>
                  <span className={`chip-count ${t === "short" || t === "none" ? t : ""}`}>{s.musician_count}/{s.target_musicians}</span>
                  <span className="chip-time">{s.start_time}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function SiteGrid({ days, shows, facilities, selectedId, open }: {
  days: string[]; shows: ShowSummary[]; facilities: Facility[]; selectedId: string | null; open: (s: ShowSummary) => void;
}) {
  const byCell = new Map<string, ShowSummary>();
  shows.forEach((s) => byCell.set(`${s.facility_id}|${s.date}`, s));
  const cols = `200px repeat(${days.length}, minmax(0, 1fr))`;
  const sorted = [...facilities].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return (
    <div className="site-grid">
      <div className="site-grid-row head" style={{ gridTemplateColumns: cols }}>
        <div className="site-grid-label">Site</div>
        {days.map((d) => (
          <div key={d} className={`site-grid-day${weekdayIndex(d) >= 5 ? " weekend" : ""}`}>
            {WEEKDAYS[weekdayIndex(d)][0]}<br />{Number(d.slice(8))}
          </div>
        ))}
      </div>
      {sorted.map((f) => (
        <div key={f.facility_id} className="site-grid-row" style={{ gridTemplateColumns: cols }}>
          <div className="site-grid-name">
            <div className="site-grid-title">{f.display_name}</div>
            <div className="mono-sub">{f.preferred_slot}</div>
          </div>
          {days.map((d) => {
            const s = byCell.get(`${f.facility_id}|${d}`);
            return (
              <div key={d} className={`site-grid-cell${weekdayIndex(d) >= 5 ? " weekend" : ""}`}>
                {s && (
                  <button className={`site-grid-mark ${showTone(s)}${selectedId === s.show_id ? " selected" : ""}`}
                          title={`${f.display_name} · ${shortDate(d)} · ${s.musician_count}/${s.target_musicians}`}
                          onClick={() => open(s)} />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function WeeklyBars({ weeks }: { weeks: { week: string; needed: number; available: number }[] }) {
  if (weeks.length === 0) return null;
  const max = Math.max(1, ...weeks.flatMap((w) => [w.needed, w.available]));
  return (
    <section className="section">
      <div className="section-head">
        <h2>Seats to fill vs. musicians free, by week</h2>
        <span className="note">Free = under their monthly cap that week, counted once</span>
      </div>
      <div className="week-bars" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((w) => (
          <div key={w.week} className="week-bar">
            <div className="week-bar-pair">
              <div className="week-bar-need" style={{ height: `${(w.needed / max) * 100}%` }} />
              <div className="week-bar-free" style={{ height: `${(w.available / max) * 100}%` }} />
            </div>
            <div className="week-bar-nums"><span>{w.needed}</span><span className="dim">{w.available}</span></div>
            <div className={`week-bar-label${w.needed > w.available ? " bad" : ""}`}>Week of {shortDate(w.week.slice(0, 10))}</div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span className="legend-item"><span className="swatch" style={{ background: "var(--ink)" }} />Seats to fill</span>
        <span className="legend-item"><span className="swatch" style={{ background: "var(--bar-free)" }} />Musicians free</span>
      </div>
    </section>
  );
}

export default function Schedule() {
  const { openPanel, closePanels, panels } = useApp();
  const { data: view, error } = useSchedule();
  const { data: facilities } = useFacilities();
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<View>("month");
  const today = isoDate(new Date());
  const win = useMemo(() => scheduleWindow(page), [page]);

  const top = panels[panels.length - 1];
  const selectedId = top?.kind === "show" ? top.id : null;
  const activeList = top?.kind === "showList" ? top.list : null;

  if (error) return <p className="error">Couldn't load the schedule: {error}</p>;
  if (!view) return <p className="muted">Loading the schedule…</p>;

  const shows = view.shows
    .filter((s) => s.date >= win.start && s.date <= win.end)
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  const open = (s: ShowSummary) => { closePanels(); openPanel({ kind: "show", id: s.show_id }); };
  const openList = (list: "seats" | "backups") => { closePanels(); openPanel({ kind: "showList", list, start: win.start, end: win.end }); };

  const seats = shows.reduce((a, s) => a + s.target_musicians, 0);
  const filled = shows.reduce((a, s) => a + Math.min(s.musician_count, s.target_musicians), 0);
  const shortShows = shows.filter((s) => s.musician_count < s.target_musicians);
  const two = shows.filter((s) => s.backup_count >= 2).length;
  const one = shows.filter((s) => s.backup_count === 1).length;
  const none = shows.filter((s) => s.backup_count === 0).length;
  const weeks = view.weekly_capacity.filter((w) => w.week.slice(0, 10) >= win.start && w.week.slice(0, 10) <= win.end);

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Schedule · today is {dayLabelComma(today)}</div>
          <h1>{rangeLabel(win.start, win.end)}</h1>
        </div>
        <div className="page-actions">
          <Segmented value={mode} onChange={setMode}
                     options={[{ value: "month", label: "Month" }, { value: "site", label: "By site" }]} />
          <div className="arrows">
            <button className="icon-button" aria-label="Previous five weeks" onClick={() => setPage(page - 1)}>‹</button>
            <button className="icon-button" aria-label="Next five weeks" onClick={() => setPage(page + 1)}>›</button>
          </div>
          <button className="button secondary" onClick={() => { closePanels(); openPanel({ kind: "cancel" }); }}>Report cancellation</button>
          <button className="button" onClick={() => { closePanels(); openPanel({ kind: "addShow" }); }}>New show</button>
        </div>
      </div>

      <Summary shows={shows} today={today} open={open} />

      <div className="figures">
        <button className={`figure-button${activeList === "seats" ? " active" : ""}`} onClick={() => openList("seats")}>
          <div className="figure-top"><span>Seats filled</span><span className="accent">View shows ›</span></div>
          <div className="figure-value">{filled} of {seats}</div>
          <div className="figure-sub">{seats - filled} open seat{seats - filled === 1 ? "" : "s"} across {plural(shortShows.length, "show")}</div>
        </button>
        <button className={`figure-button${activeList === "backups" ? " active" : ""}`} onClick={() => openList("backups")}>
          <div className="figure-top"><span>Shows with 2+ backups</span><span className="accent">View shows ›</span></div>
          <div className="figure-value">{two} of {shows.length}</div>
          <div className="figure-sub">{one} {one === 1 ? "has" : "have"} one backup, {none} {none === 1 ? "has" : "have"} none</div>
        </button>
      </div>

      <div className="scroll-x">
        {mode === "month"
          ? <MonthGrid days={win.days} shows={shows} today={today} selectedId={selectedId} open={open} />
          : <SiteGrid days={win.days} shows={shows} facilities={facilities ?? []} selectedId={selectedId} open={open} />}
      </div>
      <ToneLegend note="count = playing / target" />

      <WeeklyBars weeks={weeks} />
    </div>
  );
}
