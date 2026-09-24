import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { useApp } from "../AppState";
import { formatDate } from "../format";
import type { Musician, ScheduleView, ShowSummary } from "../types";
import { StatusBadge } from "./Status";

type Result =
  | { kind: "musician"; id: string; title: string; meta: string }
  | { kind: "show"; id: string; title: string; meta: string; show: ShowSummary };

const MAX_RESULTS = 8;

/** ⌘K / Ctrl+K search over musicians and upcoming shows; Enter opens the match in the side panel. */
export default function QuickFind({ onClose }: { onClose: () => void }) {
  const { openPanel, closePanels, pendingRemoval } = useApp();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<Result[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    Promise.all([api<Musician[]>("/api/musicians"), api<ScheduleView>("/api/schedule")]).then(([musicians, view]) => {
      setItems([
        ...view.shows.map((s): Result => ({
          kind: "show", id: s.show_id, show: s, title: s.facility_name,
          meta: `${formatDate(s.date)} · ${s.start_time} · ${s.date}`,
        })),
        ...musicians.map((m): Result => ({
          kind: "musician", id: m.musician_id, title: m.display_name,
          meta: `${m.instrument} · ${m.home_region} · age ${m.age}`,
        })),
      ]);
    });
  }, []);

  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const visible = items.filter((r) => !pendingRemoval.has(`${r.kind}:${r.id}`));
    if (!words.length) return visible.filter((r) => r.kind === "show").slice(0, MAX_RESULTS);
    return visible.filter((r) => {
      const hay = `${r.title} ${r.meta}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, MAX_RESULTS);
  }, [items, query, pendingRemoval]);

  const open = (r: Result) => {
    closePanels();
    openPanel(r.kind === "show" ? { kind: "show", id: r.id } : { kind: "musician", id: r.id });
    onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && results[active]) open(results[active]);
    else if (e.key === "Escape") onClose();
  };

  return (
    <div className="modal-scrim quickfind-scrim" onClick={onClose}>
      <div className="quickfind" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Quick find">
        <input ref={inputRef} className="quickfind-input" placeholder="Find a musician or show — try “Musician 12” or “Location 3 Oct”"
               value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} />
        <ul className="quickfind-results">
          {!query && <li className="quickfind-hint">Upcoming shows</li>}
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.id}`}>
              <button className={`quickfind-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
                <span className="quickfind-kind">{r.kind === "show" ? "Show" : "Musician"}</span>
                <span className="quickfind-title">{r.title}</span>
                <span className="quickfind-meta">{r.kind === "show" ? r.meta.split(" · ").slice(0, 2).join(" · ") : r.meta}</span>
                {r.kind === "show" && <StatusBadge status={r.show.status} compact />}
              </button>
            </li>
          ))}
          {query && results.length === 0 && <li className="quickfind-hint">Nothing matches “{query}”.</li>}
        </ul>
        <div className="quickfind-footer small muted">↑ ↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
