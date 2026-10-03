import { useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { formatMonth } from "../format";
import { copyToClipboard, reminderMessage } from "../messageTemplates";
import { dayLabelComma, plural, tone, TONE_LABEL } from "../rosterflow";
import type { Musician, ShowDetail } from "../types";
import { useApi, useMusicians, useUtilization } from "../useData";
import { Mark } from "./Mark";

interface Candidate { m: Musician; note: string; noteTone?: "warn"; unmarked?: boolean }

export default function ShowDrawer({ showId }: { showId: string }) {
  const { refresh, showToast } = useApp();
  const { data: detail, error: loadError } = useApi<ShowDetail>(`/api/shows/${showId}/detail`);
  const { data: musicians } = useMusicians();
  const { data: utilization } = useUtilization();
  const [fillOpen, setFillOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  usePanelTitle(detail ? detail.facility_name : null);

  if (loadError) return <p className="error">{loadError}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  const byId = new Map((musicians ?? []).map((m) => [m.musician_id, m]));
  const byName = new Map((musicians ?? []).map((m) => [m.display_name, m]));
  const util = new Map((utilization?.musicians ?? []).map((u) => [u.musician_id, u]));
  const c = detail.coverage;
  const pending = detail.pending_call;
  const t = tone(c.musician_count, c.target_musicians, detail.backups.length,
                 !c.has_pianist || c.songs_total < c.songs_target);
  const open = Math.max(0, c.target_musicians - c.musician_count - (pending ? 1 : 0));
  const gap = Math.max(0, c.target_musicians - c.musician_count);

  const run = (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    fn().then(() => { showToast(msg); setFillOpen(false); setQuery(""); refresh(); }).catch((e: Error) => setError(e.message));
  };
  const add = (m: { musician_id: string; display_name?: string; name?: string }, markAvailable = false) =>
    run(() => api(`/api/shows/${showId}/add-musician`,
                  { method: "POST", body: { musician_id: m.musician_id, mark_available: markAvailable } }),
        `${m.display_name ?? m.name} added to the show`);

  // Who could fill a seat, straight from the backend's own seat check (free_ids: marked available
  // for this show; unmarked_ids: everything else checks out, they just haven't said yes), so the
  // picker never offers someone the add would then refuse. Backups are listed separately above.
  const taken = new Set(detail.backups.map((b) => b.musician_id));
  const free = new Set(detail.free_ids);
  const unmarked = new Set(detail.unmarked_ids);
  const capNote = (m: Musician): Candidate => {
    const u = util.get(m.musician_id);
    if (u && u.utilization >= 1) return { m, note: "at cap", noteTone: "warn" };
    return { m, note: u?.month ? `${u.played} of ${u.capacity} in ${formatMonth(u.month).split(" ")[0]}` : `0 of ${m.max_shows_per_month} this month` };
  };
  const others = (musicians ?? []).filter((m) => !taken.has(m.musician_id));
  const atCap = (m: Musician) => (util.get(m.musician_id)?.utilization ?? 0) >= 1;
  const fillFree = others.filter((m) => free.has(m.musician_id))
    .sort((a, b) => Number(atCap(a)) - Number(atCap(b))).slice(0, 6).map(capNote);
  const q = query.trim().toLowerCase();
  const fillOther = others.filter((m) => unmarked.has(m.musician_id) && (!q || m.display_name.toLowerCase().includes(q)))
    .slice(0, q ? 8 : 4)
    .map((m) => ({ m, note: atCap(m) ? "at cap" : "", noteTone: atCap(m) ? "warn" as const : undefined, unmarked: true }));

  const region = (name: string) => byName.get(name)?.home_region ?? "";
  const firstName = (name: string) => name.split(" ")[0];
  const cars = detail.cars.map((car, i) => {
    const guardian = car.driver === "a guardian";
    const label = detail.cars.length > 1 ? `Car ${i + 1}` : "Car";
    return {
      title: guardian ? `${label} (${firstName(car.riders[0] ?? "")}'s guardian driving)` : `${label} (${car.driver} driving)`,
      km: `${car.distance_km.toFixed(0)} km`,
      people: guardian ? car.riders : [car.driver, ...car.riders],
    };
  });

  const copyMessage = () => copyToClipboard(reminderMessage(detail.facility_name, detail.date, detail.start_time))
    .then((ok) => showToast(ok ? "Reminder message copied. Paste it wherever you message the group." : "Couldn't copy. Try again."));

  const candidateRow = (cand: Candidate) => (
    <button key={cand.m.musician_id} className="fill-row" onClick={() => add(cand.m, !!cand.unmarked)}>
      <span>{cand.m.display_name} <span className="dim">{cand.m.instrument}</span></span>
      <span className={`small ${cand.noteTone ?? "dim"}`}>{cand.note}</span>
    </button>
  );

  return (
    <div className="drawer-stack">
      <div className="drawer-head">
        <div className="mono-when">{dayLabelComma(detail.date)} · {detail.start_time}</div>
        <h2>{detail.facility_name}</h2>
        <div className="status-line">
          <Mark tone={t} size={9} />
          <span className={`strong tone-${t}`}>{TONE_LABEL[t]}</span>
          <span className="dim">·</span>
          <span className="ink-2">{c.musician_count} of {c.target_musicians} · {plural(detail.backups.length, "backup")}</span>
        </div>
      </div>

      <div className="drawer-body">
        {error && <p className="error small">{error}</p>}

        <div className="drawer-section">
          <span>Playing</span>
          <span className={gap > 0 ? "warn" : "dim"}>{gap > 0 ? `${gap} open seat${gap === 1 ? "" : "s"}` : "Full"}</span>
        </div>
        {detail.roster.map((m) => (
          <div key={m.musician_id} className="person-row">
            <span>{m.name} <span className="dim">{m.instrument}</span></span>
            <span className="small dim">{byId.get(m.musician_id)?.home_region}</span>
          </div>
        ))}
        {pending && (
          <div className="person-row dashed">
            <span>{pending.name} <span className="dim">{byId.get(pending.musician_id)?.instrument}</span> <span className="small accent">called</span></span>
            <span className="row-buttons">
              <button className="button tiny" onClick={() => run(() => api(`/api/shows/${showId}/pending/confirm`, { method: "POST" }), `${pending.name} confirmed and added to the show`)}>Confirm</button>
              <button className="button secondary tiny" onClick={() => run(() => api(`/api/shows/${showId}/pending/decline`, { method: "POST" }), `${pending.name} can't make it`)}>Can't make it</button>
            </span>
          </div>
        )}
        {Array.from({ length: open }, (_, k) => (
          <div key={k} className="person-row dashed">
            <span className="warn">Open seat</span>
            {k === 0 && <button className="button secondary tiny outline" onClick={() => setFillOpen(!fillOpen)}>{fillOpen ? "Cancel" : "Fill"}</button>}
          </div>
        ))}

        {fillOpen && open > 0 && (
          <div className="fill-box">
            {detail.backups.length > 0 && (
              <>
                <div className="fill-label">Call a backup</div>
                {detail.backups.map((b, k) => (
                  <button key={b.musician_id} className="fill-row" onClick={() => add(b)}>
                    <span>{b.name} <span className="dim">{b.instrument}</span></span>
                    <span className="small dim">Backup {k + 1}</span>
                  </button>
                ))}
              </>
            )}
            <div className="fill-label">Add someone else who's free</div>
            {fillFree.map(candidateRow)}
            {fillFree.length === 0 && <div className="small dim fill-empty">No one else is free that day.</div>}
            <div className="fill-label">Not marked available</div>
            <input className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" />
            {fillOther.map(candidateRow)}
          </div>
        )}

        <div className="drawer-section"><span>Backups, in call order</span></div>
        {detail.backups.map((b, k) => (
          <div key={b.musician_id} className="backup-row">
            <span className="mono dim">{k + 1}</span>
            <span>{b.name} <span className="dim">{b.instrument}</span></span>
          </div>
        ))}
        {detail.backups.length === 0 && <div className="bad small backup-empty">No backups left.</div>}

        <div className="drawer-section"><span>Getting there</span></div>
        {cars.map((car, i) => (
          <div key={i} className="ride-group">
            <div className="ride-head"><span className="strong">{car.title}</span><span className="mono dim">{car.km}</span></div>
            {car.people.map((p) => (
              <div key={p} className="ride-person"><span>{p}</span><span className="small dim">{region(p)}</span></div>
            ))}
          </div>
        ))}
        {detail.solo_transit.length > 0 && (
          <div className="ride-group">
            <div className="ride-head"><span className="strong">Transit</span></div>
            {detail.solo_transit.map((s) => (
              <div key={s.musician_id} className="ride-person"><span>{s.name}</span><span className="small dim">{byId.get(s.musician_id)?.home_region}</span></div>
            ))}
          </div>
        )}
        {cars.length === 0 && detail.solo_transit.length === 0 && <div className="small dim">Nobody is travelling to this show yet.</div>}
      </div>

      <div className="drawer-footer">
        {open > 0
          ? <button className="button wide" onClick={() => setFillOpen(true)}>Find a replacement</button>
          : <button className="button wide" onClick={copyMessage}>Message musicians</button>}
      </div>
    </div>
  );
}
