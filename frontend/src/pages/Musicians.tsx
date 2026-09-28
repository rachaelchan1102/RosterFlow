import { useMemo, useState } from "react";
import { useApp } from "../AppState";
import { formatMonth } from "../format";
import { gettingThere } from "../rosterflow";
import { useMusicians, useUtilization } from "../useData";

const PAGE_SIZE = 20;

export default function Musicians() {
  const { openPanel, closePanels, pendingRemoval } = useApp();
  const { data: musicians, error } = useMusicians();
  const { data: utilization } = useUtilization();
  const [query, setQuery] = useState("");
  const [instrument, setInstrument] = useState("all");
  const [page, setPage] = useState(0);

  const util = useMemo(() => new Map((utilization?.musicians ?? []).map((u) => [u.musician_id, u])), [utilization]);
  const roster = useMemo(() => (musicians ?? []).filter((m) => !pendingRemoval.has(`musician:${m.musician_id}`)), [musicians, pendingRemoval]);
  const instruments = useMemo(() => {
    const counts = new Map<string, number>();
    roster.forEach((m) => counts.set(m.instrument, (counts.get(m.instrument) ?? 0) + 1));
    return [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
  }, [roster]);

  const q = query.trim().toLowerCase();
  const list = roster.filter((m) => (instrument === "all" || m.instrument === instrument)
    && (!q || m.display_name.toLowerCase().includes(q) || m.home_region.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = list.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="page-head">
        <h1>Musicians</h1>
        <div className="page-actions">
          <button className="button" onClick={() => { closePanels(); openPanel({ kind: "musicianForm" }); }}>Add musician</button>
        </div>
      </div>

      <div className="toolbar">
        <input className="field search" value={query} placeholder="Search by name or region"
               onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        <div className="chips">
          {["all", ...instruments].map((k) => (
            <button key={k} className={`chip-filter${instrument === k ? " on" : ""}`} onClick={() => { setInstrument(k); setPage(0); }}>
              {k === "all" ? "All" : k}
            </button>
          ))}
        </div>
        <span className="toolbar-note">{list.length} shown · changing availability or caps may need a schedule update</span>
      </div>

      {error && <p className="error">{error}</p>}
      {!musicians ? <p className="muted">Loading…</p> : (
        <div className="scroll-x">
          <table className="table roster">
            <thead>
              <tr><th>Name</th><th>Instrument</th><th className="r">Age</th><th>Getting there</th><th>Region</th><th className="r">Cap</th><th>Busiest month</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const u = util.get(m.musician_id);
                const ratio = u?.utilization ?? 0;
                const atCap = ratio >= 1;
                return (
                  <tr key={m.musician_id}>
                    <td><span className="strong">{m.display_name}</span> <span className="mono-sub">{m.musician_id}</span></td>
                    <td className="ink-2">{m.instrument}</td>
                    <td className="r mono">{m.age}</td>
                    <td className="ink-2">{gettingThere(m)}</td>
                    <td className="ink-2">{m.home_region}</td>
                    <td className="r mono">{m.max_shows_per_month}</td>
                    <td>
                      <span className="bar-cell">
                        <span className="bar-track"><span className={`bar-fill ${atCap ? "warn" : ""}`} style={{ width: `${Math.min(ratio, 1) * 100}%` }} /></span>
                        <span className={`mono small util-label ${atCap ? "warn" : "ink-2"}`}>
                          {!u?.month ? "no shows" : atCap ? "at cap" : `${Math.round(ratio * 100)}% ${formatMonth(u.month).split(" ")[0].slice(0, 3)}`}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={7} className="dim">No musicians match.</td></tr>}
            </tbody>
          </table>
          <div className="pager">
            <span>Showing {list.length ? current * PAGE_SIZE + 1 : 0}–{Math.min((current + 1) * PAGE_SIZE, list.length)} of {list.length}</span>
            <span className="pager-links">
              <button className="text-link" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
              <button className="text-link" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
