import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { formatDate } from "../format";
import type { ShowDetail } from "../types";
import { CoverageBar, StatusBadge } from "./Status";

export default function ShowPanel({ showId }: { showId: string }) {
  const { version, refresh, openPanel, showToast } = useApp();
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePanelTitle(detail ? `${detail.facility_name} · ${formatDate(detail.date)}` : null);

  useEffect(() => {
    api<ShowDetail>(`/api/shows/${showId}/detail`).then(setDetail).catch((e) => setError(e.message));
  }, [showId, version]);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  const act = (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    fn().then(() => { showToast(msg); refresh(); }).catch((e) => setError(e.message));
  };

  const toggleLock = (musicianId: string, locked: boolean) =>
    act(() => locked
        ? api(`/api/locks?musician_id=${musicianId}&show_id=${showId}`, { method: "DELETE" })
        : api("/api/locks", { method: "POST", body: { musician_id: musicianId, show_id: showId } }),
      locked ? "Unlocked" : "Locked — schedule updates will keep them here");

  const guardianCars = detail.cars.filter((c) => c.driver === "a guardian");
  const carpools = detail.cars.filter((c) => c.driver !== "a guardian");
  const totalKm = detail.cars.reduce((sum, c) => sum + c.distance_km, 0);


  const c = detail.coverage;
  return (
    <div className="panel-body">
      <div className="panel-title">
        <h2>{detail.facility_name}</h2>
        <p className="muted">
          {formatDate(detail.date)} · {detail.start_time} · {detail.duration_min} min
        </p>
        <div className="panel-tags">
          <StatusBadge status={detail.status} />
          {!detail.has_piano_onsite && <span className="tag">Bring a keyboard</span>}
        </div>
      </div>

      {detail.reasons.length > 0 && (
        <div className={`callout ${detail.status}`}>
          <strong>Why it's flagged</strong>
          <ul>{detail.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <section className="panel-section">
        <CoverageBar label="Songs covered" value={c.songs_total} target={c.songs_target}
                     status={c.songs_total >= c.songs_target ? "green" : "red"} />
        <CoverageBar label="Musicians (target)" value={c.musician_count} target={c.target_musicians}
                     status={c.musician_count < c.min_musicians ? "red" : c.musician_count < c.target_musicians ? "amber" : "green"} />
        <p className="small muted">
          Minimum {c.min_musicians} musicians · {c.has_pianist ? "✓ pianist on the show" : "✕ no pianist"}
        </p>
      </section>

      <section className="panel-section">
        <h3>Playing ({detail.roster.length})</h3>
        <ul className="person-list">
          {detail.roster.map((m) => (
            <li key={m.musician_id}>
              <button className="person-name" onClick={() => openPanel({ kind: "musician", id: m.musician_id })}>
                {m.name}
              </button>
              <span className="muted small">{m.instrument} · {m.songs} song{m.songs !== 1 ? "s" : ""}</span>
              <span className="row-actions">
                <button className={`chip-button ${m.locked ? "active" : ""}`} onClick={() => toggleLock(m.musician_id, m.locked)}
                        title={m.locked ? "Locked on this show — click to unlock" : "Keep them on this show no matter what"}>
                  {m.locked ? "🔒 Locked" : "Lock"}
                </button>
                <span className="row-divider" aria-hidden />
                <button className="text-action danger" title="Start the cancellation flow for this musician"
                        onClick={() => openPanel({ kind: "cancel", showId, musicianId: m.musician_id })}>
                  ⚠ Report cancellation
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel-section">
        <h3>Backups, in call order</h3>
        {detail.backups.length === 0 ? (
          <p className="muted small">No backups right now — see "Why it's flagged" above.</p>
        ) : (
          <ol className="backup-list">
            {detail.backups.map((b) => (
              <li key={b.musician_id}>
                <button className="person-name" onClick={() => openPanel({ kind: "musician", id: b.musician_id })}>
                  {b.name}
                </button>
                {b.is_pianist && <span className="tag">pianist</span>}
                <div className="small muted">{b.reason}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel-section">
        <h3>Getting there</h3>
        <p className="travel-summary">
          <strong>{detail.cars.length} car{detail.cars.length !== 1 ? "s" : ""}</strong> · {totalKm.toFixed(0)} km total
          {guardianCars.length > 0 && <> · {guardianCars.length} guardian drop-off{guardianCars.length !== 1 ? "s" : ""}</>}
          {detail.solo_transit.length > 0 && <> · {detail.solo_transit.length} by transit</>}
        </p>
        {carpools.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">Carpools</span>
            <ul className="car-list">
              {carpools.map((car, i) => (
                <li key={i}>
                  <strong>{car.driver} drives</strong><span className="muted small"> · {car.distance_km.toFixed(0)} km</span>
                  {car.riders.length > 0 && <div className="small">with {car.riders.join(", ")}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {guardianCars.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">Guardian drop-offs</span>
            <p className="small travel-inline">
              {guardianCars.map((c) => `${c.riders.join(" & ")} (${c.distance_km.toFixed(0)} km)`).join(" · ")}
            </p>
          </div>
        )}
        {detail.solo_transit.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">On their own, by transit</span>
            <p className="small travel-inline">{detail.solo_transit.join(" · ")}</p>
          </div>
        )}
      </section>

      <div className="panel-footer">
        <button className="button secondary" onClick={() => openPanel({ kind: "editShow", id: showId })}>Edit show details</button>
      </div>
    </div>
  );
}
