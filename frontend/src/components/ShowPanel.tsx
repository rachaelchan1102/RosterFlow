import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { arrivalTime, formatDate, isoDate } from "../format";
import { backupAskMessage, copyToClipboard, reminderMessage } from "../messageTemplates";
import type { Musician, ShowDetail } from "../types";
import Combobox from "./Combobox";
import { CoverageBar, StatusBadge } from "./Status";

/** For anyone under 17: the audit's exact complaint was one phone number on file for a minor
 *  with no way to tell whose it is — so a guardian contact is always labeled as such and never
 *  folded in next to the musician's own number as if it were interchangeable with it. */
export function GuardianContact({ age, guardianName, guardianPhone }: { age: number; guardianName: string; guardianPhone: string }) {
  if (age >= 17) return null;
  if (!guardianName && !guardianPhone) return <span className="small error block">No guardian contact on file</span>;
  return (
    <span className="small muted contact-links block">
      Guardian: {guardianName || "name not on file"}
      {guardianPhone && <> · <a href={`tel:${guardianPhone}`}>{guardianPhone}</a></>}
    </span>
  );
}

export default function ShowPanel({ showId }: { showId: string }) {
  const { version, refresh, openPanel, showToast, confirm, removeWithUndo, closePanels } = useApp();
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Separate from loadError: an action failing (locking, confirming, adding someone) shouldn't
  // blank out the whole panel the way a failed initial fetch does — it just needs an inline note.
  const [error, setError] = useState<string | null>(null);
  const [allMusicians, setAllMusicians] = useState<Musician[]>([]);
  const [adding, setAdding] = useState(false);
  const [addPick, setAddPick] = useState("");
  usePanelTitle(detail ? `${detail.facility_name} · ${formatDate(detail.date)}` : null);

  useEffect(() => {
    api<ShowDetail>(`/api/shows/${showId}/detail`).then(setDetail).catch((e) => setLoadError(e.message));
  }, [showId, version]);

  useEffect(() => {
    api<Musician[]>("/api/musicians").then(setAllMusicians);
  }, [version]);

  if (loadError) return <p className="error">{loadError}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  const act = (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    fn().then(() => { showToast(msg); refresh(); }).catch((e) => setError(e.message));
  };

  const removeShow = async () => {
    const ok = await confirm({
      title: `Remove the show at ${detail.facility_name} on ${formatDate(detail.date)}?`,
      confirmLabel: "Remove show", body: "Everyone scheduled on it comes off.",
    });
    if (!ok) return;
    closePanels();
    removeWithUndo([`show:${showId}`], `${detail.facility_name} on ${formatDate(detail.date)} removed`,
                   () => api(`/api/shows/${showId}`, { method: "DELETE" }));
  };

  const confirmPending = () => act(() => api(`/api/shows/${showId}/pending/confirm`, { method: "POST" }),
                                    `${detail.pending_call!.name} confirmed — added to the show`);
  const declinePending = () => act(() => api(`/api/shows/${showId}/pending/decline`, { method: "POST" }),
                                    `${detail.pending_call!.name} said no — pick someone else`);

  const copyEmails = () => {
    const emails = detail.roster.map((m) => m.email).filter(Boolean);
    if (emails.length === 0) { showToast("No emails on file for this lineup"); return; }
    copyToClipboard(emails.join(", ")).then((ok) => showToast(ok ? "Emails copied" : "Couldn't copy — try again"));
  };
  const copyReminder = () => {
    copyToClipboard(reminderMessage(detail.facility_name, detail.date, detail.start_time))
      .then((ok) => showToast(ok ? "Message copied — paste it to whoever needs it" : "Couldn't copy — try again"));
  };
  const copyLocationInfo = () => {
    const f = detail.facility;
    const lines = [
      `${detail.facility_name} — ${formatDate(detail.date)} at ${detail.start_time}`,
      f.address && `Address: ${f.address}`,
      f.contact_name && `Contact: ${f.contact_name}${f.contact_phone ? ` (${f.contact_phone})` : ""}`,
      f.parking_notes && `Parking: ${f.parking_notes}`,
      f.piano_notes && `Piano: ${f.piano_notes}`,
    ].filter(Boolean);
    copyToClipboard(lines.join("\n")).then((ok) => showToast(ok ? "Location details copied" : "Couldn't copy — try again"));
  };
  const copyBackupAsk = () => {
    const p = detail.pending_call!;
    copyToClipboard(backupAskMessage(p.name, detail.facility_name, detail.date, detail.start_time))
      .then((ok) => showToast(ok ? "Message copied" : "Couldn't copy — try again"));
  };

  const setAttendance = (musicianId: string, status: "attended" | "late_cancel" | "no_show") => {
    const next = { ...detail.attendance, [musicianId]: status };
    const records = Object.entries(next).map(([id, s]) => ({
      musician_id: id, status: s, actual_set_min: s === "attended" ? detail.duration_min : 0,
    }));
    act(() => api(`/api/shows/${showId}/attendance`, { method: "POST", body: { records } }), "Attendance saved");
  };

  const addSpecificMusician = (musicianId: string, name: string) => {
    setError(null);
    api(`/api/shows/${showId}/add-musician`, { method: "POST", body: { musician_id: musicianId } })
      .then(() => {
        showToast(`${name} added to the show`);
        setAdding(false);
        setAddPick("");
        refresh();
      }).catch((e) => setError(e.message));
  };

  const addMusician = () => {
    if (!addPick) return;
    const picked = allMusicians.find((m) => m.musician_id === addPick);
    addSpecificMusician(addPick, picked?.display_name ?? addPick);
  };

  const promoteBackup = async (musicianId: string, name: string) => {
    const remaining = detail.backups.length - 1;
    const ok = await confirm({
      title: `Add ${name} to the lineup?`,
      confirmLabel: "Add to lineup",
      body: `This uses a backup — backups drop to ${remaining}.`,
    });
    if (!ok) return;
    addSpecificMusician(musicianId, name);
  };

  const toggleConfirmed = (musicianId: string, confirmed: boolean) =>
    act(() => confirmed
        ? api(`/api/confirmations?musician_id=${musicianId}&show_id=${showId}`, { method: "DELETE" })
        : api("/api/confirmations", { method: "POST", body: { musician_id: musicianId, show_id: showId } }),
      confirmed ? "Un-confirmed" : "Confirmed — they've said yes");

  const setSongTitle = (musicianId: string, title: string) =>
    act(() => api("/api/song-titles", { method: "PUT", body: { musician_id: musicianId, show_id: showId, title } }),
      title ? "Song saved" : "Song cleared");

  const toggleLock = (musicianId: string, locked: boolean) =>
    act(() => locked
        ? api(`/api/locks?musician_id=${musicianId}&show_id=${showId}`, { method: "DELETE" })
        : api("/api/locks", { method: "POST", body: { musician_id: musicianId, show_id: showId } }),
      locked ? "Unlocked" : "Locked — schedule updates will keep them here");

  const guardianCars = detail.cars.filter((c) => c.driver === "a guardian");
  // A car with no other riders isn't a carpool — it's one person driving themselves, and belongs
  // in its own group rather than padding out "Carpools" with solo trips.
  const carpools = detail.cars.filter((c) => c.driver !== "a guardian" && c.riders.length > 0);
  const soloDrivers = detail.cars.filter((c) => c.driver !== "a guardian" && c.riders.length === 0);
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
          <StatusBadge status={detail.status} label={detail.status_label} />
          {!detail.has_piano_onsite && <span className="tag">Bring a keyboard</span>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {detail.pending_call && (
        <div className="callout amber pending-call">
          <strong>Waiting to hear back from {detail.pending_call.name}</strong>
          <p className="small muted block">They don't count toward the show until you confirm they've said yes.</p>
          {(detail.pending_call.phone || detail.pending_call.email) && (
            <p className="small contact-links">
              {detail.pending_call.phone && <a href={`tel:${detail.pending_call.phone}`}>{detail.pending_call.phone}</a>}
              {detail.pending_call.phone && detail.pending_call.email && " · "}
              {detail.pending_call.email && <a href={`mailto:${detail.pending_call.email}`}>{detail.pending_call.email}</a>}
            </p>
          )}
          <GuardianContact age={detail.pending_call.age} guardianName={detail.pending_call.guardian_name}
                           guardianPhone={detail.pending_call.guardian_phone} />
          <div className="row-actions">
            <button className="button small-button" onClick={confirmPending}>They said yes — confirm</button>
            <button className="button secondary small-button" onClick={declinePending}>They said no — try someone else</button>
            <button className="button secondary small-button" onClick={copyBackupAsk}>Copy a message to send them</button>
          </div>
        </div>
      )}

      {(() => {
        // Already covered by the "Waiting to hear back" banner above — repeating it here as a
        // plain reason line would just say the same thing twice with less detail.
        const otherReasons = detail.reasons.filter((r) => !r.startsWith("waiting to hear back from"));
        return otherReasons.length > 0 && (
          <div className={`callout ${detail.status}`}>
            <strong>Why it's flagged</strong>
            <ul>{otherReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        );
      })()}

      <section className="panel-section">
        <CoverageBar label="Songs covered" value={c.songs_total} target={c.songs_target}
                     status={c.songs_total >= c.songs_target ? "green" : "red"} />
        <CoverageBar label="Musicians (target)" value={c.musician_count} target={c.target_musicians}
                     status={c.musician_count < c.min_musicians ? "red" : c.musician_count < c.target_musicians ? "amber" : "green"} />
        <p className="small muted">
          Minimum {c.min_musicians} musicians · {c.has_pianist ? "✓ pianist on the show" : "✕ no pianist"}
        </p>
        {detail.piano_warning && <p className="small error">✕ {detail.piano_warning}</p>}
      </section>

      <section className="panel-section">
        <div className="section-head">
          <h3>Location details</h3>
          <button className="link-button small" onClick={copyLocationInfo}>Copy for musicians</button>
        </div>
        <ul className="plain-list small">
          {detail.facility.address && <li><strong>Address:</strong> {detail.facility.address}</li>}
          {detail.facility.contact_name && (
            <li><strong>Contact:</strong> {detail.facility.contact_name}
              {detail.facility.contact_phone && <> · <a href={`tel:${detail.facility.contact_phone}`}>{detail.facility.contact_phone}</a></>}
            </li>
          )}
          <li><strong>Arrive by:</strong> {arrivalTime(detail.start_time, detail.facility.load_in_buffer_min)}
            {" "}({detail.facility.load_in_buffer_min} min to load in)</li>
          {detail.facility.parking_notes && <li><strong>Parking:</strong> {detail.facility.parking_notes}</li>}
          {detail.facility.max_per_car < 3 && (
            <li><strong>Parking is tight here:</strong> no more than {detail.facility.max_per_car} per car</li>
          )}
          {detail.facility.piano_notes && <li><strong>Piano:</strong> {detail.facility.piano_notes}</li>}
        </ul>
      </section>

      <section className="panel-section">
        <div className="section-head">
          <h3>Playing ({detail.roster.length})</h3>
          {!adding && <button className="link-button small" onClick={() => setAdding(true)}>+ Add musician</button>}
        </div>
        {detail.roster.length > 0 && (
          <>
            <div className="section-subhead">
              <p className="small muted">{detail.roster.filter((m) => m.confirmed).length} of {detail.roster.length} confirmed</p>
              <span className="row-actions">
                <button className="link-button small" onClick={copyEmails}>Copy emails</button>
                <button className="link-button small" onClick={copyReminder}>Copy a reminder message</button>
              </span>
            </div>
            <p className="small muted">
              "Confirmed" means they've said yes. "Keep here" pins them to this show through any future schedule
              update, even if the numbers would otherwise move them.
            </p>
          </>
        )}
        {adding && (
          <div className="add-musician-row">
            <Combobox value={addPick} onChange={setAddPick} placeholder="Search musicians…"
                      options={allMusicians
                        .filter((m) => !detail.roster.some((r) => r.musician_id === m.musician_id))
                        .map((m) => ({ value: m.musician_id, label: m.display_name,
                                       sublabel: `${m.instrument} · ${m.home_region}` }))} />
            <button className="button small-button" onClick={addMusician} disabled={!addPick}>Add</button>
            <button className="button secondary small-button" onClick={() => { setAdding(false); setAddPick(""); setError(null); }}>Cancel</button>
          </div>
        )}
        <ul className="person-list">
          {detail.roster.map((m) => (
            <li key={m.musician_id}>
              <button className="person-name" onClick={() => openPanel({ kind: "musician", id: m.musician_id })}>
                {m.name}
              </button>
              <span className="muted small">{m.instrument} · {m.songs} song{m.songs !== 1 ? "s" : ""}</span>
              {m.outside_availability && (
                <span className="small tag" title="This booking is outside their usual weekly pattern — a one-off exception, not a mistake">
                  ⚠ outside usual availability
                </span>
              )}
              {(m.phone || m.email) && (
                <span className="muted small contact-links">
                  {m.phone && <a href={`tel:${m.phone}`}>{m.phone}</a>}
                  {m.phone && m.email && " · "}
                  {m.email && <a href={`mailto:${m.email}`}>{m.email}</a>}
                </span>
              )}
              <GuardianContact age={m.age} guardianName={m.guardian_name} guardianPhone={m.guardian_phone} />
              <label className="song-title-row">
                Song
                <input key={`${m.musician_id}-${m.song_title}`} defaultValue={m.song_title}
                       placeholder="What are they playing?" className={m.song_title_duplicate ? "song-title-duplicate" : ""}
                       onBlur={(e) => { if (e.target.value !== m.song_title) setSongTitle(m.musician_id, e.target.value); }} />
                {m.song_title_duplicate && <span className="small error">Same as someone else on this show</span>}
              </label>
              <span className="row-actions">
                <button className={`chip-button ${m.confirmed ? "active confirmed" : ""}`} onClick={() => toggleConfirmed(m.musician_id, m.confirmed)}
                        title={m.confirmed ? "They've told you they're coming — click to unmark" : "Mark that this person has actually said yes to this show"}>
                  {m.confirmed ? "✓ Confirmed" : "Not yet confirmed"}
                </button>
                <button className={`chip-button ${m.locked ? "active" : ""}`} onClick={() => toggleLock(m.musician_id, m.locked)}
                        title={m.locked ? "An update will keep them on this show no matter what — click to unlock" : "Keep them on this show through any future update, even if the numbers would otherwise move them"}>
                  {m.locked ? "🔒 Kept here" : "Keep here"}
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
        {detail.backups.length > 0 && (
          <p className="small muted">
            Ranked by who's played fewest shows first, then distance, then how often they've been to this
            location recently — so someone farther away can still outrank someone closer if they've played less.
          </p>
        )}
        {detail.backups.length === 0 ? (
          <p className="muted small">No backups right now — see "Why it's flagged" above.</p>
        ) : (
          <ol className="backup-list">
            {detail.backups.map((b) => (
              <li key={b.musician_id}>
                <span className="row-actions">
                  <button className="person-name" onClick={() => openPanel({ kind: "musician", id: b.musician_id })}>
                    {b.name}
                  </button>
                  {b.is_pianist && <span className="tag">pianist</span>}
                  <button className="link-button small" onClick={() => promoteBackup(b.musician_id, b.name)}>+ Add to lineup</button>
                </span>
                {(b.phone || b.email) && (
                  <div className="small muted contact-links">
                    {b.phone && <a href={`tel:${b.phone}`}>{b.phone}</a>}
                    {b.phone && b.email && " · "}
                    {b.email && <a href={`mailto:${b.email}`}>{b.email}</a>}
                  </div>
                )}
                <GuardianContact age={b.age} guardianName={b.guardian_name} guardianPhone={b.guardian_phone} />
                <div className="small muted">{b.reason}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel-section">
        <h3>Getting there</h3>
        <p className="travel-summary">
          <strong>{detail.cars.length} car{detail.cars.length !== 1 ? "s" : ""}</strong> · {totalKm.toFixed(0)} km total, one-way
          {guardianCars.length > 0 && <> · {guardianCars.length} guardian drop-off{guardianCars.length !== 1 ? "s" : ""}</>}
          {detail.solo_transit.length > 0 && <> · {detail.solo_transit.length} by transit</>}
        </p>
        <p className="small muted">
          Every km figure here is one-way — a car (or a guardian's drop-off and pickup) makes this trip twice.
        </p>
        {carpools.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">Carpools</span>
            <ul className="car-list">
              {carpools.map((car, i) => (
                <li key={i}>
                  <strong>{car.driver} drives</strong><span className="muted small"> · {car.distance_km.toFixed(0)} km</span>
                  <div className="small">with {car.riders.join(", ")}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {soloDrivers.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">Driving alone</span>
            <p className="small travel-inline">
              {soloDrivers.map((c) => `${c.driver} (${c.distance_km.toFixed(0)} km)`).join(" · ")}
            </p>
          </div>
        )}
        {guardianCars.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">Guardian drop-offs</span>
            <p className="small muted">A parent or guardian drives them — not a carpool with another musician.</p>
            <p className="small travel-inline">
              {guardianCars.map((c) => `${c.riders.join(" & ")} (${c.distance_km.toFixed(0)} km)`).join(" · ")}
            </p>
          </div>
        )}
        {detail.solo_transit.length > 0 && (
          <div className="travel-group">
            <span className="travel-label">On their own, by transit</span>
            <p className="small travel-inline">
              {detail.solo_transit.map((s) => (
                <span key={s.musician_id} className={s.long_trip ? "error" : undefined}>
                  {s.name} ({s.distance_km.toFixed(0)} km, ~{s.est_minutes} min{s.long_trip ? " — over an hour" : ""})
                </span>
              )).reduce((acc, el, i) => (i === 0 ? [el] : [...acc, " · ", el]), [] as ReactNode[])}
            </p>
          </div>
        )}
      </section>

      {detail.date <= isoDate(new Date()) && (
        <section className="panel-section">
          <h3>Check-in</h3>
          <p className="small muted">Who actually showed up — separate from who was scheduled or said yes beforehand.</p>
          <ul className="plain-list small">
            {detail.roster.map((m) => {
              const status = detail.attendance[m.musician_id];
              return (
                <li key={m.musician_id} className="checkin-row">
                  <span>{m.name}</span>
                  <span className="row-actions">
                    <button className={`chip-button ${status === "attended" ? "active confirmed" : ""}`}
                            onClick={() => setAttendance(m.musician_id, "attended")}>Attended</button>
                    <button className={`chip-button ${status === "late_cancel" ? "active" : ""}`}
                            onClick={() => setAttendance(m.musician_id, "late_cancel")}>Late cancel</button>
                    <button className={`chip-button ${status === "no_show" ? "active danger" : ""}`}
                            onClick={() => setAttendance(m.musician_id, "no_show")}>No-show</button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="panel-footer">
        <button className="button secondary" onClick={() => window.print()}>Print run sheet</button>
        <button className="button secondary" onClick={() => openPanel({ kind: "editShow", id: showId })}>Edit show details</button>
        <button className="button secondary danger" onClick={removeShow}>Remove show</button>
      </div>

      {/* Only visible when printing (see .run-sheet in App.css) — everything else on the page,
          including this panel's own chrome, is hidden so what prints is just this. */}
      <div className="run-sheet">
        <h1>{detail.facility_name}</h1>
        <p>{formatDate(detail.date)} · {detail.start_time} · {detail.duration_min} min</p>
        <p>Arrive by {arrivalTime(detail.start_time, detail.facility.load_in_buffer_min)}</p>
        {detail.facility.address && <p>{detail.facility.address}</p>}
        {detail.facility.contact_name && <p>Contact: {detail.facility.contact_name} {detail.facility.contact_phone}</p>}
        {detail.facility.parking_notes && <p>Parking: {detail.facility.parking_notes}</p>}
        {detail.facility.piano_notes && <p>Piano: {detail.facility.piano_notes}</p>}
        <h2>Playing ({detail.roster.length})</h2>
        <ul>
          {detail.roster.map((m) => (
            <li key={m.musician_id}>{m.name} — {m.instrument} — {m.songs} songs{m.song_title ? ` — "${m.song_title}"` : ""}</li>
          ))}
        </ul>
        <h2>Backups, in call order</h2>
        {detail.backups.length === 0 ? <p>None</p> : (
          <ul>
            {detail.backups.map((b) => <li key={b.musician_id}>#{b.rank} {b.name}{b.phone ? ` — ${b.phone}` : ""}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
