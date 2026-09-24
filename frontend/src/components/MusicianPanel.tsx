import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { formatDate, formatMonth } from "../format";
import type { MusicianProfile } from "../types";
import { CoverageBar } from "./Status";

export default function MusicianPanel({ musicianId }: { musicianId: string }) {
  const { version, openPanel } = useApp();
  const [profile, setProfile] = useState<MusicianProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePanelTitle(profile?.name);

  useEffect(() => {
    api<MusicianProfile>(`/api/musicians/${musicianId}/profile`).then(setProfile).catch((e) => setError(e.message));
  }, [musicianId, version]);

  if (error) return <p className="error">{error}</p>;
  if (!profile) return <p className="muted">Loading…</p>;

  const p = profile;
  return (
    <div className="panel-body">
      <div className="panel-title">
        <h2>{p.name}</h2>
        <p className="muted">
          {p.musician_id} · {p.instrument} · age {p.age} · {p.home_region} ·{" "}
          {p.years_with_org} {p.years_with_org === 1 ? "year" : "years"} with the org
        </p>
        <p className="muted small">
          Plays {p.typical_songs} songs usually, up to {p.max_songs} · gets there by {p.transport}
          {p.can_drive ? " (can drive others)" : ""}
        </p>
      </div>

      <section className="panel-section">
        <h3>Monthly cap</h3>
        {p.cap_usage.map((c) => (
          <CoverageBar key={c.month} label={formatMonth(c.month)} value={c.playing} target={c.cap}
                       status={c.playing > c.cap ? "red" : c.playing === c.cap ? "amber" : "green"} />
        ))}
      </section>

      <section className="panel-section">
        <h3>Playing ({p.playing.length})</h3>
        {p.playing.length === 0 ? <p className="muted small">Not on any show yet.</p> : (
          <ul className="person-list">
            {p.playing.map((s) => (
              <li key={s.show_id}>
                <button className="person-name" onClick={() => openPanel({ kind: "show", id: s.show_id })}>
                  {formatDate(s.date)} · {s.facility_name}
                </button>
                <span className="muted small">{s.songs} song{s.songs !== 1 ? "s" : ""}{s.locked ? " · 🔒 locked" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h3>Backup for ({p.backing.length})</h3>
        {p.backing.length === 0 ? <p className="muted small">Not a backup anywhere.</p> : (
          <ul className="person-list">
            {p.backing.map((s) => (
              <li key={s.show_id}>
                <button className="person-name" onClick={() => openPanel({ kind: "show", id: s.show_id })}>
                  {formatDate(s.date)} · {s.facility_name}
                </button>
                <span className="muted small">backup #{s.rank}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h3>Usually free</h3>
        {p.weekly_availability.length === 0 ? <p className="muted small">No weekly availability set.</p> : (
          <ul className="plain-list small">
            {p.weekly_availability.map((w, i) => (
              <li key={i}><strong>{w.weekday}</strong> {w.start_time}–{w.end_time}</li>
            ))}
          </ul>
        )}
        <button className="button secondary small-button" onClick={() => openPanel({ kind: "availability", id: musicianId })}>
          Edit availability
        </button>
      </section>

      <div className="panel-footer">
        <button className="button secondary" onClick={() => openPanel({ kind: "musicianForm", id: musicianId })}>Edit details</button>
      </div>
    </div>
  );
}
