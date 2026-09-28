import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../AppState";
import { UtilBar } from "../components/Status";
import { formatMonth } from "../format";
import { copyToClipboard } from "../messageTemplates";
import { updateNowAction } from "../scheduleUpdate";
import type { Musician, UtilizationView } from "../types";

const PAGE_SIZE = 20;

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

/** A row's overflow actions — Remove sits behind this instead of next to Edit with no guard,
 *  so it's not one careless click away from Edit at the same spot every row. */
function RowMenu({ musician, onEdit, onAvailability, onRemove }: {
  musician: Musician; onEdit: () => void; onAvailability: () => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = (fn: () => void) => { setOpen(false); fn(); };
  return (
    <div className="row-menu">
      <button title="More actions" aria-haspopup="menu" aria-expanded={open}
              aria-label={`More actions for ${musician.display_name}`} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <>
          <div className="panel-scrim" onClick={() => setOpen(false)} />
          <div className="row-menu-list" role="menu">
            <button role="menuitem" onClick={() => run(onEdit)}>✎ Edit details</button>
            <button role="menuitem" onClick={() => run(onAvailability)}>◷ Edit availability</button>
            <button role="menuitem" className="danger" onClick={() => run(onRemove)}>✕ Remove from roster</button>
          </div>
        </>
      )}
    </div>
  );
}

function transportLabel(m: Musician): { icon: string; label: string } {
  if (m.age < 17) return { icon: "👪", label: "guardian drives" };
  if (m.transport === "car") return m.can_drive ? { icon: "🚗", label: "drives (can take others)" } : { icon: "🚗", label: "drives self only" };
  if (m.transport === "guardian") return { icon: "👪", label: "guardian drives" };
  return { icon: "🚇", label: "transit" };
}

function MusiciansTab() {
  const { version, refresh, openPanel, showToast, confirm, removeWithUndo, pendingRemoval, setLastUpdateChanges } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const atCapOnly = searchParams.get("view") === "at_cap";
  const [musicians, setMusicians] = useState<Musician[]>([]);
  const [utilization, setUtilization] = useState<Map<string, UtilizationView["musicians"][number]>>(new Map());
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCap, setBulkCap] = useState(2);
  const [unavailableDate, setUnavailableDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    Promise.all([
      api<Musician[]>("/api/musicians").then(setMusicians),
      api<UtilizationView>("/api/utilization").then((u) => setUtilization(new Map(u.musicians.map((m) => [m.musician_id, m])))),
    ]).then(() => setLoaded(true));
  }, [version]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let visible = musicians.filter((m) => !pendingRemoval.has(`musician:${m.musician_id}`));
    // Never ">" — the solver treats the cap as a hard ceiling, so nobody is ever actually OVER
    // it; "at" (>= 1) is the real, useful question: these are the people you can't ask for one more.
    if (atCapOnly) visible = visible.filter((m) => (utilization.get(m.musician_id)?.utilization ?? 0) >= 1);
    return q ? visible.filter((m) => [m.musician_id, m.display_name, m.instrument, m.home_region]
      .some((f) => f.toLowerCase().includes(q))) : visible;
  }, [musicians, query, pendingRemoval, atCapOnly, utilization]);
  // Utilization lives in a separate map (it's a derived stat, not a roster field), so it's merged
  // onto each row here — the one field the sort/pagination pipeline couldn't otherwise touch.
  const withUtilization = useMemo(() => filtered.map((m) => ({
    ...m, utilization_ratio: utilization.get(m.musician_id)?.utilization ?? 0,
  })), [filtered, utilization]);
  const { sorted, header } = useSort(withUtilization, "musician_id");
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
    fn().then(() => { showToast(msg, updateNowAction(refresh, showToast, setLastUpdateChanges)); setSelected(new Set()); refresh(); }).catch((e) => setError(e.message));
  };

  const remove = async (m: Musician) => {
    const ok = await confirm({ title: `Remove ${m.display_name}?`, confirmLabel: "Remove",
                               body: "Their shows, backups and weekly availability go with them." });
    if (!ok) return;
    removeWithUndo([`musician:${m.musician_id}`], `${m.display_name} removed`,
                   () => api(`/api/musicians/${m.musician_id}`, { method: "DELETE" }));
  };

  const copyEmails = () => {
    const emails = musicians.filter((m) => selected.has(m.musician_id) && m.email).map((m) => m.email);
    copyToClipboard(emails.join(", "))
      .then((ok) => showToast(ok ? `${emails.length} email${emails.length !== 1 ? "s" : ""} copied` : "Couldn't copy — try again"));
  };

  const markUnavailable = () => {
    if (!unavailableDate) return;
    const ids = [...selected];
    api<{ shows_affected: number }>("/api/musicians/bulk-mark-unavailable", {
      method: "POST", body: { musician_ids: ids, date: unavailableDate },
    }).then(({ shows_affected }) => {
      showToast(shows_affected === 0
        ? `No upcoming shows on ${unavailableDate}.`
        : `${ids.length} musicians marked unavailable for ${shows_affected} show${shows_affected !== 1 ? "s" : ""}. The schedule needs updating to reflect this.`,
        updateNowAction(refresh, showToast, setLastUpdateChanges));
      setSelected(new Set());
      setUnavailableDate("");
      refresh();
    }).catch((e) => setError(e.message));
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
        <button className="button secondary" onClick={() => openPanel({ kind: "bulkImportMusicians" })}>Bulk import</button>
        <button className="button" onClick={() => openPanel({ kind: "musicianForm" })}>+ Add musician</button>
      </div>
      {atCapOnly && (
        <p className="filter-note">
          Showing musicians at their monthly show limit — the ones you can't ask for one more ·{" "}
          <button className="link-button" onClick={() => setSearchParams({})}>Clear filter</button>
        </p>
      )}

      {selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <label className="inline">Set monthly cap to
            <input type="number" min={0} max={8} value={bulkCap} onChange={(e) => setBulkCap(Number(e.target.value))} />
          </label>
          <button className="button secondary" onClick={() => run(
            () => api("/api/musicians/bulk-update", { method: "POST", body: { musician_ids: [...selected], changes: { max_shows_per_month: bulkCap } } }),
            `Updated ${selected.size} musicians. The schedule needs updating to reflect this.`)}>Apply</button>
          <button className="button secondary" onClick={copyEmails}>Copy emails</button>
          <label className="inline">Mark unavailable
            <input type="date" value={unavailableDate} onChange={(e) => setUnavailableDate(e.target.value)} />
          </label>
          <button className="button secondary" onClick={markUnavailable} disabled={!unavailableDate}>Apply</button>
          <button className="button secondary danger" onClick={removeSelected}>Remove</button>
          <button className="link-button" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="empty-state">
          {atCapOnly ? "Nobody is at their monthly limit right now." : "No musicians match your search."}
        </p>
      ) : (
      <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on this page" /></th>
            {header("display_name", "Name")}{header("instrument", "Instrument")}{header("age", "Age")}
            <th>Transport</th>
            {header("home_region", "Region")}{header("max_shows_per_month", "Cap / month")}
            {header("utilization_ratio", "Utilization (busiest month)")}<th />
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
              <td>{m.age}</td>
              <td>
                {(() => {
                  const t = transportLabel(m);
                  return <span title={t.label}>{t.icon} {t.label}</span>;
                })()}
              </td>
              <td>{m.home_region}</td>
              <td>{m.max_shows_per_month}</td>
              <td>
                {(() => {
                  const u = utilization.get(m.musician_id);
                  return u ? <UtilBar ratio={u.utilization} label={u.month ? formatMonth(u.month).split(" ")[0] : undefined}
                                      title={u.month ? `${u.played} of ${u.capacity} shows in ${formatMonth(u.month)} — their busiest month`
                                                      : "Not on any upcoming show"} />
                           : <span className="muted small">—</span>;
                })()}
              </td>
              <td className="icon-actions">
                <RowMenu musician={m}
                        onEdit={() => openPanel({ kind: "musicianForm", id: m.musician_id })}
                        onAvailability={() => openPanel({ kind: "availability", id: m.musician_id })}
                        onRemove={() => remove(m)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      )}
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

// Shows used to have their own second list here too, with a second "+ Add show" button — exactly
// duplicating the Schedule page's calendar/facility views and their own add-show entry point,
// with no way to tell which was "the real one." Shows now live only on the Schedule page; this
// page is musicians only, which is what "Capacity" actually means.
export default function WorkingTools() {
  return (
    <div>
      <h1>Musicians</h1>
      <p className="subtitle">Changes to availability or monthly limits may require a schedule update.</p>
      <MusiciansTab />
    </div>
  );
}
