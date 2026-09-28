import { useApp, usePanelTitle } from "../AppState";
import { dayLabel, plural, rangeLabel, showTone } from "../rosterflow";
import type { ShowSummary } from "../types";
import { useSchedule } from "../useData";
import { Mark } from "./Mark";

interface Group { label: string; count: string; tone?: "warn" | "bad"; rows: { show: ShowSummary; main: string; mainTone?: "warn" | "bad"; aux: string }[] }

/** The drill-down behind the two Schedule figures: every show in the window, grouped by how many
 *  seats are open or how many backups are left. Clicking a row opens that show, with a back link here. */
export default function ShowList({ list, start, end }: { list: "seats" | "backups"; start: string; end: string }) {
  const { openPanel } = useApp();
  const { data } = useSchedule();
  usePanelTitle(list === "seats" ? "Open seats" : "Backups");
  if (!data) return <p className="muted">Loading…</p>;

  const shows = data.shows.filter((s) => s.date >= start && s.date <= end)
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  const backups = (s: ShowSummary) => plural(s.backup_count, "backup");

  let title: string, sub: string, groups: Group[];
  if (list === "seats") {
    const gap = (s: ShowSummary) => s.target_musicians - s.musician_count;
    const short = shows.filter((s) => gap(s) > 0).sort((a, b) => gap(b) - gap(a));
    const full = shows.filter((s) => gap(s) <= 0);
    const total = short.reduce((a, s) => a + gap(s), 0);
    title = "Open seats";
    sub = `${total} open seat${total === 1 ? "" : "s"} across ${plural(short.length, "show")}`;
    groups = [
      { label: "Short", count: plural(short.length, "show"), tone: "warn",
        rows: short.map((s) => ({ show: s, main: `${gap(s)} open`, mainTone: "bad",
                                  aux: `${s.musician_count} of ${s.target_musicians} · ${backups(s)}` })) },
      { label: "Full", count: plural(full.length, "show"),
        rows: full.map((s) => ({ show: s, main: `${s.musician_count} of ${s.target_musicians}`, aux: backups(s) })) },
    ];
  } else {
    const group = (label: string, pick: (s: ShowSummary) => boolean, tone?: "warn" | "bad"): Group => {
      const rows = shows.filter(pick);
      return {
        label, count: plural(rows.length, "show"), tone,
        rows: rows.map((s) => ({ show: s, main: backups(s), mainTone: s.backup_count === 0 ? "bad" : s.backup_count === 1 ? "warn" : undefined,
                                 aux: `${s.musician_count} of ${s.target_musicians} playing` })),
      };
    };
    title = "Backups";
    sub = "";
    groups = [group("No backups", (s) => s.backup_count === 0, "bad"), group("One backup", (s) => s.backup_count === 1, "warn"),
              group("2 or more", (s) => s.backup_count >= 2)];
  }

  return (
    <div>
      <div className="drawer-head">
        <div className="eyebrow">Schedule · {rangeLabel(start, end)}</div>
        <h2>{title}</h2>
        {sub && <div className="drawer-sub">{sub}</div>}
      </div>
      <div className="drawer-body">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="drawer-section"><span>{g.label}</span><span className={`mono ${g.tone ?? ""}`}>{g.count}</span></div>
            {g.rows.map(({ show: s, main, mainTone, aux }) => (
              <button key={s.show_id} className="list-row" onClick={() => openPanel({ kind: "show", id: s.show_id })}>
                <Mark tone={showTone(s)} />
                <span className="list-row-main">
                  <span className="strong">{s.facility_name}</span>
                  <span className="mono-sub">{dayLabel(s.date)} · {s.start_time}</span>
                </span>
                <span className="list-row-side">
                  <span className={`mono ${mainTone ?? ""}`}>{main}</span>
                  <span className="dim small">{aux}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
