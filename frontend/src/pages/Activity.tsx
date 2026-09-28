import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../AppState";
import UpdateSummary from "../components/UpdateSummary";
import { timeAgo } from "../format";
import type { ActivityEntry, Change, RevertResult } from "../types";

/** Lazily fetches and shows what THIS entry actually changed on the roster, so "what changed"
 *  is browsable for any past update, not just the most recent one (see LastUpdateChip). Most
 *  entries changed nothing about who's playing what (a lock, a ban, an edit that hasn't been
 *  resolved yet) — that's shown plainly rather than as an empty, unexplained blank. */
function EntryChanges({ entryId }: { entryId: number }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ changes: Change[] }>(`/api/activity/${entryId}/changes`)
      .then((r) => setChanges(r.changes))
      .catch((e) => setError(e.message));
  }, [entryId]);

  if (error) return <p className="small error">Couldn't load what changed: {error}</p>;
  if (!changes) return <p className="small muted">Loading…</p>;
  if (changes.length === 0) return <p className="small muted">This didn't change who's playing what.</p>;
  return <UpdateSummary changes={changes} />;
}

/** Version control for the schedule, not a single undo stack — "revert" restores an earlier
 *  snapshot as a NEW entry (like `git revert`), so nothing already in the log is ever deleted,
 *  even the things a revert effectively undoes. */
export default function Activity() {
  const { version, refresh, showToast, confirm, markActivitySeen } = useApp();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<ActivityEntry[]>("/api/activity").then(setEntries).catch((e) => setError(e.message));
  }, [version]);

  useEffect(() => { markActivitySeen(); }, [markActivitySeen]);

  const revert = async (entry: ActivityEntry) => {
    setBusyId(entry.id);
    setError(null);
    try {
      const first = await api<RevertResult>(`/api/activity/${entry.id}/revert`, { method: "POST", body: { confirm: false } });
      let proceed = !first.needs_confirmation;
      if (first.needs_confirmation) {
        proceed = await confirm({
          title: "This isn't the most recent change",
          body: `Reverting to before "${entry.description}" will also undo ${first.later!.length} more recent ` +
                `change${first.later!.length !== 1 ? "s" : ""}: ${first.later!.join("; ")}.`,
          confirmLabel: "Revert anyway",
        });
      }
      if (!proceed) return;
      await api<RevertResult>(`/api/activity/${entry.id}/revert`, { method: "POST", body: { confirm: true } });
      showToast("Reverted. A new entry records it; nothing was deleted from the log.");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const filtered = entries?.filter((e) => e.description.toLowerCase().includes(search.trim().toLowerCase())) ?? null;
  const sorted = filtered ? [...filtered].sort((a, b) =>
    order === "newest" ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)) : null;

  return (
    <div>
      <div className="network-head">
        <h1>Activity</h1>
        {entries && entries.length > 0 && (
          <div className="view-toggle" role="tablist">
            <button role="tab" aria-selected={order === "newest"} className={order === "newest" ? "active" : ""}
                    onClick={() => setOrder("newest")}>Newest first</button>
            <button role="tab" aria-selected={order === "oldest"} className={order === "oldest" ? "active" : ""}
                    onClick={() => setOrder("oldest")}>Oldest first</button>
          </div>
        )}
      </div>
      <p className="subtitle">Restore the schedule to before a change. Later changes may also be undone.</p>
      {entries && entries.length > 0 && (
        <input type="search" className="search" placeholder="Filter by show or musician name…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      {error && <p className="error">{error}</p>}
      {!sorted ? (
        <p className="muted">Loading…</p>
      ) : entries && entries.length > 0 && sorted.length === 0 ? (
        <p className="muted">Nothing matches "{search}".</p>
      ) : sorted.length === 0 ? (
        <p className="muted">Nothing's happened yet. Changes you make will show up here.</p>
      ) : (
        <ol className="activity-list">
          {sorted.map((e) => (
            <li key={e.id}>
              <div className="activity-when">
                <span title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>
                {e.fill_seconds !== null && (
                  <span className="small muted"> · filled in {(e.fill_seconds / 60).toFixed(1)} min</span>
                )}
              </div>
              <div className="activity-desc">{e.description}</div>
              <div className="activity-actions">
                <button className="link-button" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                  {expanded === e.id ? "Hide what changed" : "What changed"}
                </button>
                <button className="link-button" disabled={busyId !== null} onClick={() => revert(e)}>
                  {busyId === e.id ? "Reverting…" : "Revert to before this"}
                </button>
              </div>
              {expanded === e.id && (
                <div className="activity-changes"><EntryChanges entryId={e.id} /></div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
