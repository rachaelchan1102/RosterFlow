import { useEffect } from "react";
import { useApp } from "../AppState";
import mascot from "../assets/mascot.png";
import { timeAgo } from "../format";
import type { ActivityEntry } from "../types";
import { useApi } from "../useData";

export default function Activity() {
  const { markActivitySeen } = useApp();
  const { data: entries, error } = useApi<ActivityEntry[]>("/api/activity");
  useEffect(() => { markActivitySeen(); }, [markActivitySeen]);

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
              <span>{e.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
