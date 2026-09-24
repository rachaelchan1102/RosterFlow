import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../AppState";
import { StatusBadge } from "../components/Status";
import { formatDate, formatMonth } from "../format";
import type { Musician, ScheduleView, ShowSummary } from "../types";

const PAGE_SIZE = 20;
type Tab = "musicians" | "availability" | "shows";

function useSort<T>(rows: T[], initial: keyof T) {
  const [key, setKey] = useState<keyof T>(initial);
  const [asc, setAsc] = useState(true);
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return asc ? cmp : -cmp;
  }), [rows, key, asc]);
  const header = (k: keyof T, label: string) => (
    <th>
      <button className="sort-header" onClick={() => { if (k === key) setAsc(!asc); else { setKey(k); setAsc(true); } }}>
        {label}{k === key ? (asc ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  return { sorted, header };
}

function MusiciansTab() {
  const { version, refresh, openPanel, showToast, confirm, removeWithUndo, pendingRemoval } = useApp();
  const [musicians, setMusicians] = useState<Musician[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCap, setBulkCap] = useState(2);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Musician[]>("/api/musicians").then(setMusicians);
  }, [version]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = musicians.filter((m) => !pendingRemoval.has(`musician:${m.musician_id}`));
    return q ? visible.filter((m) => [m.musician_id, m.display_name, m.instrument, m.home_region]
      .some((f) => f.toLowerCase().includes(q))) : visible;
  }, [musicians, query, pendingRemoval]);
  const { sorted, header } = useSort(filtered, "musician_id");
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allOnPage = current.length > 0 && current.every((m) => selected.has(m.musician_id));
  const togglePage = () => setSelected((prev) => {
    const next = new Set(prev);
    current.forEach((m) => (allOnPage ? next.delete(m.musician_id) : next.add(m.musician_id)));
    return next;
  });

  const run = (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    fn().then(() => { showToast(msg); setSelected(new Set()); refresh(); }).catch((e) => setError(e.message));
  };

  const remove = async (m: Musician) => {
    const ok = await confirm({ title: `Remove ${m.display_name}?`, confirmLabel: "Remove",
                               body: "Their shows, backups and weekly availability go with them." });
    if (!ok) return;
    removeWithUndo([`musician:${m.musician_id}`], `${m.display_name} removed`,
                   () => api(`/api/musicians/${m.musician_id}`, { method: "DELETE" }));
  };

  const removeSelected = async () => {
    const ids = [...selected];
    const ok = await confirm({ title: `Remove ${ids.length} musicians?`, confirmLabel: `Remove ${ids.length}`,
                               body: "Their shows, backups and weekly availability go with them." });
    if (!ok) return;
    setSelected(new Set());
    removeWithUndo(ids.map((id) => `musician:${id}`), `${ids.length} musicians removed`,
                   () => api("/api/musicians/bulk-delete", { method: "POST", body: { musician_ids: ids } }));
  };

  return (
    <section>
      <div className="toolbar">
        <input className="search" placeholder="Search name, instrument, region…" value={query}
               onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        <span className="muted small">{filtered.length} musician{filtered.length !== 1 ? "s" : ""}</span>
        <button className="button" onClick={() => openPanel({ kind: "musicianForm" })}>+ Add musician</button>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <label className="inline">Set monthly cap to
            <input type="number" min={0} max={8} value={bulkCap} onChange={(e) => setBulkCap(Number(e.target.value))} />
          </label>
          <button className="button secondary" onClick={() => run(
            () => api("/api/musicians/bulk-update", { method: "POST", body: { musician_ids: [...selected], changes: { max_shows_per_month: bulkCap } } }),
            `Updated ${selected.size} musicians`)}>Apply</button>
          <button className="button secondary danger" onClick={removeSelected}>Remove</button>
          <button className="link-button" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on this page" /></th>
            {header("display_name", "Name")}{header("instrument", "Instrument")}{header("age", "Age")}
            {header("home_region", "Region")}{header("max_shows_per_month", "Cap / month")}<th />
          </tr>
        </thead>
        <tbody>
          {current.map((m) => (
            <tr key={m.musician_id} className={selected.has(m.musician_id) ? "selected" : ""}>
              <td><input type="checkbox" checked={selected.has(m.musician_id)} onChange={() => toggle(m.musician_id)} /></td>
              <td>
                <button className="person-name" onClick={() => openPanel({ kind: "musician", id: m.musician_id })}>{m.display_name}</button>
                <span className="muted small"> {m.musician_id}</span>
              </td>
              <td>{m.instrument}</td>
              <td>{m.age}{m.age < 17 && <span className="tag" title="Needs a guardian to drive">guardian</span>}</td>
              <td>{m.home_region}</td>
              <td>{m.max_shows_per_month}</td>
              <td className="icon-actions">
                <button title="Edit details" aria-label={`Edit ${m.display_name}'s details`}
                        onClick={() => openPanel({ kind: "musicianForm", id: m.musician_id })}>✎</button>
                <button title="Edit weekly availability" aria-label={`Edit ${m.display_name}'s weekly availability`}
                        onClick={() => openPanel({ kind: "availability", id: m.musician_id })}>◷</button>
                <button title="Remove from roster" aria-label={`Remove ${m.display_name} from the roster`} className="danger"
                        onClick={() => remove(m)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="pager">
          <button className="button secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span className="small muted">Page {page + 1} of {pages}</span>
          <button className="button secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}
    </section>
  );
}

interface Heatmap {
  dates: { date: string; weekday: string; day: number; show_count: number; free_count: number }[];
  rows: { musician_id: string; name: string; instrument: string; hours: number[] }[];
}

function AvailabilityTab() {
  const { version, openPanel } = useApp();
  const [data, setData] = useState<Heatmap | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<Heatmap>("/api/availability-heatmap").then(setData);
  }, [version]);

  if (!data) return <p className="muted">Loading…</p>;
  const q = query.trim().toLowerCase();
  const rows = q ? data.rows.filter((r) => `${r.name} ${r.instrument} ${r.musician_id}`.toLowerCase().includes(q)) : data.rows;
  const monthStarts = new Set(data.dates.filter((d) => d.day === 1).map((d) => d.date));

  return (
    <section>
      <div className="toolbar">
        <input className="search" placeholder="Filter musicians…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="small muted">
          Darker = more hours free that day, from each musician's usual weekly pattern. Days with shows are marked ●.
        </span>
      </div>
      <div className="heatmap-scroll">
        <table className="heatmap">
          <thead>
            <tr>
              <th className="heatmap-name" />
              {data.dates.map((d) => (
                <th key={d.date} className={`${d.show_count ? "has-show" : ""} ${monthStarts.has(d.date) ? "month-start" : ""}`}
                    title={`${formatDate(d.date)} · ${d.show_count} show${d.show_count !== 1 ? "s" : ""}`}>
                  {monthStarts.has(d.date) && <span className="heatmap-month">{formatMonth(d.date.slice(0, 7))}</span>}
                  <span>{d.weekday[0]}</span><span>{d.day}</span>{d.show_count > 0 && <span className="show-dot">●</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.musician_id}>
                <th className="heatmap-name">
                  <button className="person-name" onClick={() => openPanel({ kind: "musician", id: r.musician_id })}>{r.name}</button>
                </th>
                {r.hours.map((h, i) => (
                  <td key={i} className={monthStarts.has(data.dates[i].date) ? "month-start" : ""}
                      style={{ background: h > 0 ? `color-mix(in srgb, #2a78d6 ${Math.round(20 + (h / 12) * 80)}%, var(--surface))` : undefined }}
                      title={`${r.name} · ${formatDate(data.dates[i].date)} · ${h ? `${h}h free` : "not usually free"}`} />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="heatmap-name small">Free that day</th>
              {data.dates.map((d) => (
                <td key={d.date} className={`heatmap-count ${d.free_count < 10 ? "low" : ""}`}>{d.free_count}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function ShowsTab() {
  const { version, openPanel, confirm, removeWithUndo, pendingRemoval } = useApp();
  const [shows, setShows] = useState<ShowSummary[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<ScheduleView>("/api/schedule").then((v) => setShows(v.shows));
  }, [version]);

  const q = query.trim().toLowerCase();
  const visible = shows.filter((s) => !pendingRemoval.has(`show:${s.show_id}`));
  const filtered = q ? visible.filter((s) => `${s.facility_name} ${s.date}`.toLowerCase().includes(q)) : visible;
  const { sorted, header } = useSort(filtered, "date");

  const remove = async (s: ShowSummary) => {
    const ok = await confirm({ title: `Remove the show at ${s.facility_name} on ${formatDate(s.date)}?`,
                               confirmLabel: "Remove show", body: "Everyone scheduled on it comes off." });
    if (!ok) return;
    removeWithUndo([`show:${s.show_id}`], `${s.facility_name} on ${formatDate(s.date)} removed`,
                   () => api(`/api/shows/${s.show_id}`, { method: "DELETE" }));
  };

  return (
    <section>
      <div className="toolbar">
        <input className="search" placeholder="Search location or date…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="muted small">{filtered.length} upcoming show{filtered.length !== 1 ? "s" : ""}</span>
        <button className="button" onClick={() => openPanel({ kind: "addShow" })}>+ Add show</button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            {header("date", "Date")}{header("start_time", "Time")}{header("facility_name", "Location")}
            {header("status", "Status")}{header("musician_count", "Musicians")}{header("backup_count", "Backups")}<th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.show_id}>
              <td><button className="person-name" onClick={() => openPanel({ kind: "show", id: s.show_id })}>{formatDate(s.date)}</button></td>
              <td>{s.start_time}</td>
              <td>{s.facility_name}</td>
              <td><StatusBadge status={s.status} /></td>
              <td>{s.musician_count} / {s.target_musicians}</td>
              <td>{s.backup_count}</td>
              <td className="icon-actions">
                <button title="Edit details" aria-label="Edit this show" onClick={() => openPanel({ kind: "editShow", id: s.show_id })}>✎</button>
                <button title="Remove show" aria-label="Remove this show" className="danger" onClick={() => remove(s)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function WorkingTools() {
  const [tab, setTab] = useState<Tab>("musicians");
  return (
    <div>
      <h1>Roster</h1>
      <p className="subtitle">Musicians, who's usually free when, and upcoming shows. After changes, update the schedule from the calendar.</p>
      <div className="tabs" role="tablist">
        {([["musicians", "Musicians"], ["availability", "Availability"], ["shows", "Shows"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "musicians" && <MusiciansTab />}
      {tab === "availability" && <AvailabilityTab />}
      {tab === "shows" && <ShowsTab />}
    </div>
  );
}
