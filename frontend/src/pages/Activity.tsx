import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../AppState";
import mascot from "../assets/mascot.png";
import { timeAgo } from "../format";
import type { ActivityEntry } from "../types";
import { useApi } from "../useData";

export default function Activity() {
  const { markActivitySeen, confirm, refresh, showToast } = useApp();
  const { data: entries, error } = useApi<ActivityEntry[]>("/api/activity");
  const [busyId, setBusyId] = useState<number | null>(null);
  useEffect(() => { markActivitySeen(); }, [markActivitySeen]);

  // Undo is a revert, like `git revert`: it goes back to just before this change and records the
  // revert as a new entry, so nothing disappears from the history. Later changes go back too,
  // so those are listed and confirmed first.
  const undo = async (e: ActivityEntry) => {
    setBusyId(e.id);
    try {
      const preview = await api<{ needs_confirmation: boolean; later: string[] }>(
        `/api/activity/${e.id}/revert`, { method: "POST", body: { confirm: false } });
      if (preview.needs_confirmation) {
        const n = preview.later.length;
        const ok = await confirm({
          title: "Undo this and everything after it?",
          body: `Going back to before "${e.description}" also undoes ${n} later change${n === 1 ? "" : "s"}: `
              + preview.later.slice(0, 3).join("; ") + (n > 3 ? `; and ${n - 3} more.` : "."),
          confirmLabel: `Undo ${n + 1} changes`,
          hint: "The undo is recorded here too, so you can undo the undo.",
        });
        if (!ok) return;
      }
      await api(`/api/activity/${e.id}/revert`, { method: "POST", body: { confirm: true } });
      refresh();
      showToast(`Undone: ${e.description}`);
    } catch (err) {
      showToast(`Couldn't undo: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="page-head"><h1>Activity</h1></div>
      {error && <p className="error">{error}</p>}
      {!entries ? <p className="muted">Loading…</p> : entries.length === 0 ? (
        <div className="empty">
          <img src={mascot} alt="" className="empty-mascot" />
          <div className="empty-title">Nothing has changed yet</div>
          <div className="empty-sub">Edits to shows, musicians and sites show up here.</div>
        </div>
      ) : (
        <div className="activity">
          {entries.map((e) => (
            <div key={e.id} className="activity-row">
              <span className="mono small dim" title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</span>
              <span>{e.description}{e.by && <span className="dim"> · {e.by}</span>}</span>
              <button className="foot-link activity-undo" disabled={busyId !== null} onClick={() => undo(e)}>
                {busyId === e.id ? "Undoing…" : "Undo"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
