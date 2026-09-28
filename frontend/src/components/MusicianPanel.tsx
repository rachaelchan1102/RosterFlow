import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { formatDate, formatMonth, tenureLabel } from "../format";
import { copyToClipboard } from "../messageTemplates";
import type { MusicianProfile, VolunteerHours } from "../types";
import { CoverageBar } from "./Status";

export default function MusicianPanel({ musicianId }: { musicianId: string }) {
  const { version, openPanel, mode, showToast } = useApp();
  const [profile, setProfile] = useState<MusicianProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [hours, setHours] = useState<VolunteerHours | null>(null);
  usePanelTitle(profile?.name);

  useEffect(() => {
    api<MusicianProfile>(`/api/musicians/${musicianId}/profile`).then(setProfile).catch((e) => setError(e.message));
    api<VolunteerHours>(`/api/musicians/${musicianId}/volunteer-hours`).then(setHours).catch(() => undefined);
    setLink(null);
  }, [musicianId, version]);

  const copyHoursSummary = () => {
    if (!hours) return;
    const lines = [
      `${hours.name} — volunteer hours summary`,
      `Total: ${hours.total_hours} hours across ${hours.shows_attended} shows`,
      "",
      ...hours.shows.map((s) => `${formatDate(s.date)} · ${s.facility_name} · ${(s.minutes / 60).toFixed(1)}h`),
    ];
    copyToClipboard(lines.join("\n")).then((ok) => showToast(ok ? "Summary copied" : "Couldn't copy — try again"));
  };

  const getLink = () => {
    setLinkError(null);
    api<{ token: string }>(`/api/musicians/${musicianId}/self-service-link`)
      .then(({ token }) => setLink(`${window.location.origin}/respond/${token}`))
      .catch((e) => setLinkError(e.message));
  };
  const copyLink = () => {
    if (!link) return;
    copyToClipboard(link).then((ok) => showToast(ok ? "Link copied" : "Couldn't copy — try again"));
  };

  if (error) return <p className="error">{error}</p>;
  if (!profile) return <p className="muted">Loading…</p>;

  const p = profile;
  return (
    <div className="panel-body">
      <div className="panel-title">
        <h2>{p.name}</h2>
        <p className="muted">
          {p.musician_id} · {p.instrument}{p.secondary_instruments && ` (also ${p.secondary_instruments})`} · age {p.age}
          {" "}· {p.home_region} · {tenureLabel(p.years_with_org)}
        </p>
        <p className="muted small">
          Plays {p.typical_songs} songs usually, up to {p.max_songs} · gets there by {p.transport}
          {p.can_drive ? " (can drive others)" : ""}
        </p>
        {(p.phone || p.email) && (
          <p className="muted small contact-links">
            {p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}
            {p.phone && p.email && " · "}
            {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
          </p>
        )}
        {p.age < 17 && (
          <p className="muted small contact-links">
            {p.guardian_name || p.guardian_phone ? (
              <>Guardian ({p.guardian_name || "name not on file"}){p.guardian_phone && <> · <a href={`tel:${p.guardian_phone}`}>{p.guardian_phone}</a></>}</>
            ) : (
              <span className="error">No guardian contact on file for a minor</span>
            )}
          </p>
        )}
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
                {s.outside_availability && (
                  <span className="small tag" title="This booking is outside their usual weekly pattern — a one-off exception, not a mistake">
                    ⚠ outside usual availability
                  </span>
                )}
                <button className="text-action danger" title="Start the cancellation flow for this show"
                        onClick={() => openPanel({ kind: "cancel", showId: s.show_id, musicianId: p.musician_id })}>
                  Can't make it
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hours && hours.shows_attended > 0 && (
        <section className="panel-section">
          <div className="section-head">
            <h3>Volunteer hours</h3>
            <button className="link-button small" onClick={copyHoursSummary}>Copy summary</button>
          </div>
          <p className="small">
            <strong>{hours.total_hours} hours</strong> across {hours.shows_attended} attended show{hours.shows_attended !== 1 ? "s" : ""}
          </p>
          <p className="small muted">Counted from checked-in attendance only — a scheduled show that was never checked in doesn't count.</p>
        </section>
      )}

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
        {mode === "coordinator" && (
          <div className="self-service-link-row">
            {!link ? (
              <button className="button secondary small-button" onClick={getLink}>Get self-service link</button>
            ) : (
              <>
                <input className="self-service-link-box" readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="button secondary small-button" onClick={copyLink}>Copy link</button>
              </>
            )}
            {linkError && <p className="error small">{linkError}</p>}
            <p className="small muted block">
              A page where {p.name.split(" ")[0]} can mark yes/no for upcoming shows themselves — no login needed.
            </p>
          </div>
        )}
      </section>

      <div className="panel-footer">
        <button className="button secondary" onClick={() => openPanel({ kind: "musicianForm", id: musicianId })}>Edit details</button>
      </div>
    </div>
  );
}
