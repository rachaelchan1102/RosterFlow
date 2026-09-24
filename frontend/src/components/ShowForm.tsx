import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import type { Facility, Show } from "../types";
import FeasibilityCheck from "./FeasibilityCheck";

function nextShowId(shows: Show[]): string {
  const max = shows.reduce((m, s) => Math.max(m, Number(s.show_id.replace(/\D/g, "")) || 0), 0);
  return `S${String(max + 1).padStart(4, "0")}`;
}

/** Add a new show (with the "will this fit?" check inline) or edit an existing one. */
export default function ShowForm({ showId, initialDate }: { showId?: string; initialDate?: string }) {
  const { refresh, backPanel, closePanels, showToast } = useApp();
  const editing = Boolean(showId);
  usePanelTitle(editing ? "Edit show" : "Add a show");
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [form, setForm] = useState<Show>({ show_id: "", facility_id: "", date: initialDate ?? "", start_time: "14:00",
                                           duration_min: 60, period: "upcoming" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<Facility[]>("/api/facilities"), api<Show[]>("/api/shows")]).then(([f, shows]) => {
      setFacilities(f);
      const existing = shows.find((s) => s.show_id === showId);
      if (existing) {
        setForm(existing);
      } else if (f.length) {
        setForm((prev) => ({ ...prev, show_id: nextShowId(shows), facility_id: f[0].facility_id,
                             start_time: f[0].preferred_slot.split(" ")[1] ?? prev.start_time,
                             duration_min: f[0].show_duration_min }));
      }
    });
  }, [showId]);

  const pickFacility = (id: string) => {
    const f = facilities.find((x) => x.facility_id === id);
    setForm({ ...form, facility_id: id,
              start_time: editing ? form.start_time : (f?.preferred_slot.split(" ")[1] ?? form.start_time),
              duration_min: editing ? form.duration_min : (f?.show_duration_min ?? form.duration_min) });
  };

  const save = () => {
    setError(null);
    const req = editing
      ? api(`/api/shows/${showId}`, { method: "PUT", body: form })
      : api("/api/shows", { method: "POST", body: form });
    req.then(() => {
      showToast(editing ? "Show updated" : "Show added — update the schedule on the calendar to staff it");
      refresh();
      if (editing) backPanel(); else closePanels();
    }).catch((e) => setError(e.message));
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
          <select value={form.facility_id} onChange={(e) => pickFacility(e.target.value)}>
            {facilities.map((f) => <option key={f.facility_id} value={f.facility_id}>{f.display_name} ({f.region})</option>)}
          </select>
        </label>
        <label>Date
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
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

      {!editing && (
        <FeasibilityCheck facilityId={form.facility_id} date={form.date} startTime={form.start_time}
                          durationMin={form.duration_min} onPickDate={(date) => setForm({ ...form, date })} />
      )}

      <div className="panel-footer">
        <button className="button" onClick={save} disabled={!form.facility_id || !form.date || !form.show_id}>
          {editing ? "Save changes" : "Add show"}
        </button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
