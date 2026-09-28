import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { useApp } from "../AppState";
import { formatDate } from "../format";
import { fuzzyFilter } from "../fuzzyMatch";
import type { Facility, Musician, ScheduleView, ShowSummary } from "../types";
import { useFocusTrap } from "../useFocusTrap";
import { StatusBadge } from "./Status";

type Result =
  | { kind: "musician"; id: string; title: string; meta: string }
  | { kind: "location"; id: string; title: string; meta: string }
  | { kind: "show"; id: string; title: string; meta: string; show: ShowSummary };

const MAX_RESULTS = 8;

/** ⌘K / Ctrl+K search over musicians, upcoming shows and locations; Enter opens the match — a
 *  location opens straight to Edit location, same as clicking it from the Network page. */
export default function QuickFind({ onClose }: { onClose: () => void }) {
  const { openPanel, closePanels, pendingRemoval } = useApp();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    Promise.all([api<Musician[]>("/api/musicians"), api<ScheduleView>("/api/schedule"), api<Facility[]>("/api/facilities")])
      .then(([musicians, view, facilities]) => {
        setItems([
          ...view.shows.map((s): Result => ({
            kind: "show", id: s.show_id, show: s, title: s.facility_name,
            // Deliberately NOT including the raw ISO date (e.g. "2026-10-05") here: it let a
            // single digit like the "5" in "Location 5" match completely unrelated shows just
            // because that digit happened to appear somewhere in their date, too.
            meta: `${formatDate(s.date)} · ${s.start_time}`,
          })),
          ...musicians.map((m): Result => ({
            kind: "musician", id: m.musician_id, title: m.display_name,
            meta: `${m.musician_id} · ${m.instrument} · ${m.home_region} · age ${m.age}`,
          })),
          ...facilities.map((f): Result => ({
            kind: "location", id: f.facility_id, title: f.display_name,
            meta: `${f.region} · ${f.preferred_slot}`,
          })),
        ]);
      }).catch((e: Error) => setError(e.message));
  }, []);

  const allMatches = useMemo(() => {
    if (!items) return [];
    const visible = items.filter((r) => !pendingRemoval.has(`${r.kind}:${r.id}`));
    if (!query.trim()) return visible.filter((r) => r.kind === "show");
    return fuzzyFilter(visible, query, (r) => `${r.title} ${r.meta}`);
  }, [items, query, pendingRemoval]);
  const results = allMatches.slice(0, MAX_RESULTS);

  const open = (r: Result) => {
    closePanels();
    openPanel(r.kind === "show" ? { kind: "show", id: r.id }
             : r.kind === "location" ? { kind: "facilityForm", id: r.id }
             : { kind: "musician", id: r.id });
    onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && results[active]) {
      // Without this, the browser's own default action for Enter on a text input fires after
      // our handler and synthesizes a click on whatever now sits at the input's old position —
      // here, the breadcrumb's first button, which had just become clickable in this same render
      // because a panel is now open. That phantom click immediately closed the panel this very
      // keypress had just opened, so a musician result looked like it did nothing.
      e.preventDefault();
      open(results[active]);
    }
    else if (e.key === "Escape") onClose();
  };

  return (
    <div className="modal-scrim quickfind-scrim" onClick={onClose}>
      <div ref={trapRef} tabIndex={-1} className="quickfind" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Quick find">
        <input className="quickfind-input" placeholder="Find a musician, show or location — try “Musician 12” or “Location 3”"
               value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} />
        <ul className="quickfind-results">
          {error && <li className="quickfind-hint error">Couldn't search: {error}.</li>}
          {!error && !items && <li className="quickfind-hint">Loading…</li>}
          {!error && items && !query && <li className="quickfind-hint">Upcoming shows</li>}
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.id}`}>
              <button className={`quickfind-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
                <span className="quickfind-kind">{r.kind === "show" ? "Show" : r.kind === "location" ? "Location" : "Musician"}</span>
                <span className="quickfind-title">{r.title}</span>
                <span className="quickfind-meta">{r.kind === "show" ? r.meta.split(" · ").slice(0, 2).join(" · ") : r.meta}</span>
                {r.kind === "show" && <StatusBadge status={r.show.status} label={r.show.status_label} compact />}
              </button>
            </li>
          ))}
          {!error && items && query && results.length === 0 && <li className="quickfind-hint">Nothing matches “{query}”.</li>}
        </ul>
        <div className="quickfind-footer small muted">
          ↑ ↓ to move · Enter to open · Esc to close
          {allMatches.length > MAX_RESULTS && <> · showing {MAX_RESULTS} of {allMatches.length}</>}
        </div>
      </div>
    </div>
  );
}
