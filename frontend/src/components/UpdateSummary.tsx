import { useApp } from "../AppState";
import { formatDate } from "../format";
import type { Change } from "../types";

/** What the last update moved, grouped into one card per show so a coordinator can see at a
 *  glance whose plans changed — and who to message. Names and show headers open their panels.
 *  Shared by the Schedule page's inline summary and the "View changes" panel opened from the
 *  "Update now" toast action elsewhere in the app, so the same clear report is reachable no
 *  matter where the update was triggered from. */
export default function UpdateSummary({ changes, onDismiss }: { changes: Change[]; onDismiss?: () => void }) {
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
        {onDismiss && <button className="link-button" onClick={onDismiss}>Dismiss</button>}
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
