import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, useDirtyOnChange, usePanelTitle } from "../AppState";
import { bookingWindow, BOOKING_HORIZON_DAYS, isoDate, parseDate } from "../format";
import { updateNowAction } from "../scheduleUpdate";
import { nextShowId } from "../showBooking";
import type { Facility, Show } from "../types";
import Combobox from "./Combobox";
import FeasibilityCheck from "./FeasibilityCheck";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_SHOWS_PER_DAY = 3;   // mirrors optimizer/data.py's org-wide daily cap
const REPEAT_DAYS = 14;

/** The next date on this location's own usual weekday, in booking range, that isn't already
 *  taken here and isn't a day already at the org-wide per-day cap — the reverse of typing a date
 *  and hoping it's free. Returns "" if nothing in range qualifies. */
function nextUsualDate(facility: Facility, shows: Show[], minDate: string, maxDate: string): string {
  const targetWeekday = facility.preferred_slot.split(" ")[0];
  const countByDate = new Map<string, number>();
  const hereByDate = new Set<string>();
  shows.forEach((s) => {
    countByDate.set(s.date, (countByDate.get(s.date) ?? 0) + 1);
    if (s.facility_id === facility.facility_id) hereByDate.add(s.date);
  });
  let d = parseDate(minDate);
  const max = parseDate(maxDate);
  while (d <= max) {
    const iso = isoDate(d);
    if (WEEKDAY_NAMES[d.getDay()] === targetWeekday && !hereByDate.has(iso)
        && (countByDate.get(iso) ?? 0) < MAX_SHOWS_PER_DAY) {
      return iso;
    }
    d = new Date(d.getTime() + 86_400_000);
  }
  return "";
}

/** Add a new show (with the "will this fit?" check inline) or edit an existing one. */
export default function ShowForm({ showId, initialDate, initialFacilityId }: { showId?: string; initialDate?: string; initialFacilityId?: string }) {
  const { refresh, backPanel, closePanels, showToast, confirm, setPanelDirty, setLastUpdateChanges } = useApp();
  const editing = Boolean(showId);
  usePanelTitle(editing ? "Edit show" : "Add a show");
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [existingShows, setExistingShows] = useState<Show[]>([]);
  const [form, setForm] = useState<Show>({ show_id: "", facility_id: "", date: initialDate ?? "", start_time: "14:00",
                                           duration_min: 60, period: "upcoming" });
  const [repeat, setRepeat] = useState(false);
  const [repeatUntil, setRepeatUntil] = useState("");
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [feasibility, setFeasibility] = useState<number | null>(null);
  const window = bookingWindow();
  const dateInRange = form.date >= window.min && form.date <= window.max;

  useEffect(() => {
    Promise.all([api<Facility[]>("/api/facilities"), api<Show[]>("/api/shows")]).then(([f, shows]) => {
      setFacilities(f);
      setExistingShows(shows);
      const existing = shows.find((s) => s.show_id === showId);
      if (existing) {
        setForm(existing);
      } else if (initialFacilityId) {
        // Arrived from a specific context (a calendar day's "+", a scenario tool's "Book this") —
        // that choice is deliberate, so it's honored as-is rather than reset to empty.
        const picked = f.find((x) => x.facility_id === initialFacilityId);
        if (picked) {
          setForm((prev) => ({ ...prev, show_id: nextShowId(shows), facility_id: picked.facility_id,
                               start_time: picked.preferred_slot.split(" ")[1] ?? prev.start_time,
                               duration_min: picked.show_duration_min }));
        }
      } else {
        // No location implied by how this form was opened — starts empty rather than defaulting
        // to whichever facility happens to sort first, which read as an arbitrary, meaningless pick.
        setForm((prev) => ({ ...prev, show_id: nextShowId(shows) }));
      }
      setLoaded(true);
    });
  }, [showId, initialFacilityId]);

  useDirtyOnChange(form, loaded);

  const pickFacility = (id: string) => {
    const f = facilities.find((x) => x.facility_id === id);
    setForm((prev) => {
      const date = !editing && !prev.date && f
        ? nextUsualDate(f, existingShows, window.min, window.max) : prev.date;
      return { ...prev, facility_id: id, date,
               start_time: editing ? prev.start_time : (f?.preferred_slot.split(" ")[1] ?? prev.start_time),
               duration_min: editing ? prev.duration_min : (f?.show_duration_min ?? prev.duration_min) };
    });
  };

  const repeatDates = (): string[] => {
    if (!repeat || !repeatUntil || !form.date) return [form.date];
    const dates: string[] = [];
    let d = parseDate(form.date);
    const until = parseDate(repeatUntil);
    while (d <= until) {
      dates.push(isoDate(d));
      d = new Date(d.getTime() + REPEAT_DAYS * 86_400_000);
    }
    return dates;
  };

  const save = async () => {
    if (!editing && feasibility !== null && feasibility < 0.3) {
      const ok = await confirm({
        title: "This date looks very unlikely to be staffed",
        body: `The estimate is about ${Math.round(feasibility * 100)}% likely to be fully staffed. Adding the show ` +
              "doesn't staff it — you'd still need to find people, or pick a stronger date from the estimate above.",
        confirmLabel: "Add it anyway",
        hint: "You can always update the schedule and see the real outcome afterward.",
      });
      if (!ok) return;
    }
    setError(null);
    if (editing) {
      api(`/api/shows/${showId}`, { method: "PUT", body: form }).then(() => {
        setPanelDirty(false);
        refresh();
        showToast("Saved. The schedule needs updating to reflect this.");
        backPanel();
      }).catch((e) => setError(e.message));
      return;
    }
    const dates = repeatDates();
    const baseNum = Number(form.show_id.replace(/\D/g, ""));
    setBooking(true);
    let added = 0;
    for (const date of dates) {
      const show: Show = { ...form, show_id: `S${String(baseNum + added).padStart(4, "0")}`, date };
      try {
        // eslint-disable-next-line no-await-in-loop
        await api("/api/shows", { method: "POST", body: show });
        added += 1;
      } catch (e) {
        setError(`Stopped after ${added} of ${dates.length}: ${(e as Error).message}`);
        break;
      }
    }
    setBooking(false);
    if (added > 0) {
      setPanelDirty(false);
      refresh();
      showToast(dates.length > 1
        ? `${added} of ${dates.length} shows added. They still need the schedule updated to be staffed.`
        : "Show added. It still needs the schedule updated to be staffed.",
        updateNowAction(refresh, showToast, setLastUpdateChanges));
      if (added === dates.length) closePanels();
    }
  };

  return (
    <div className="panel-body">
      <div className="panel-title">
        <h2>{editing ? "Edit show" : "Add a show"}</h2>
        {!editing && <p className="muted small">Pick a location and date to see whether it could be staffed before you commit to it.</p>}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="form-grid">
        <label>Location
          <Combobox value={form.facility_id} onChange={pickFacility} placeholder="Search locations…"
                    options={facilities.map((f) => ({ value: f.facility_id, label: f.display_name, sublabel: f.region }))} />
        </label>
        <label>Date
          <input type="date" value={form.date} min={window.min} max={window.max}
                 onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </label>
        <label>Start time
          <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
        </label>
        <label>Length
          <select value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })}>
            <option value={45}>45 min</option>
            <option value={60}>60 min</option>
          </select>
        </label>
      </div>
      <p className="small muted">
        Shows can be booked from today through {BOOKING_HORIZON_DAYS} days out. That window moves forward with
        today, so dates further out open up as they come into range.
      </p>
      {form.date && !dateInRange && (
        <p className="error small">
          {form.date < window.min ? "That date has already passed." : `That's more than ${BOOKING_HORIZON_DAYS} days away — try a closer date.`}
        </p>
      )}

      {!editing && (
        <>
          <label className="checkbox-label block">
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
            Repeat every {REPEAT_DAYS} days until
          </label>
          {repeat && (
            <label className="block">
              <input type="date" value={repeatUntil} min={form.date || window.min} max={window.max}
                     onChange={(e) => setRepeatUntil(e.target.value)} />
              {form.date && repeatUntil && (
                <span className="small muted"> — {repeatDates().length} show{repeatDates().length !== 1 ? "s" : ""} would be added</span>
              )}
            </label>
          )}
        </>
      )}

      {!editing && (
        <FeasibilityCheck facilityId={form.facility_id} date={form.date} startTime={form.start_time}
                          durationMin={form.duration_min} onPickDate={(date) => setForm({ ...form, date })}
                          onResult={setFeasibility} />
      )}

      <div className="panel-footer">
        <button className="button" onClick={save}
                disabled={!form.facility_id || !form.date || !form.show_id || !dateInRange || booking}>
          {booking ? "Adding…" : editing ? "Save changes" : repeat && repeatUntil ? `Add ${repeatDates().length} shows` : "Add show"}
        </button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
