import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import type { Musician } from "../types";

const EMPTY: Musician = {
  musician_id: "", display_name: "", age: 18, instrument: "piano", home_region: "", home_lat: 43.65,
  home_lng: -79.38, transport: "car", can_drive: true, years_with_org: 0, max_shows_per_month: 2,
  min_songs: 1, typical_songs: 2, max_songs: 3,
};

function nextMusicianId(all: Musician[]): string {
  const max = all.reduce((m, x) => Math.max(m, Number(x.musician_id.replace(/\D/g, "")) || 0), 0);
  return `M${String(max + 1).padStart(2, "0")}`;
}

export default function MusicianForm({ musicianId }: { musicianId?: string }) {
  const { refresh, backPanel, showToast } = useApp();
  const editing = Boolean(musicianId);
  usePanelTitle(editing ? "Edit details" : "Add a musician");
  const [form, setForm] = useState<Musician>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Musician[]>("/api/musicians").then((all) => {
      const existing = all.find((m) => m.musician_id === musicianId);
      setForm(existing ?? { ...EMPTY, musician_id: nextMusicianId(all) });
    });
  }, [musicianId]);

  const set = <K extends keyof Musician>(key: K, value: Musician[K]) => setForm({ ...form, [key]: value });

  const save = () => {
    setError(null);
    const req = editing
      ? api(`/api/musicians/${musicianId}`, { method: "PUT", body: form })
      : api("/api/musicians", { method: "POST", body: form });
    req.then(() => {
      showToast(editing ? "Saved" : `${form.display_name} added — update the schedule on the calendar to include them`);
      refresh();
      backPanel();
    }).catch((e) => setError(e.message));
  };

  const num = (key: keyof Musician) => (e: ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value) as never);

  return (
    <div className="panel-body">
      <div className="panel-title"><h2>{editing ? `Edit ${form.display_name || musicianId}` : "Add a musician"}</h2></div>
      {error && <p className="error">{error}</p>}
      <div className="form-grid">
        <label>Name<input value={form.display_name} onChange={(e) => set("display_name", e.target.value)} /></label>
        <label>ID<input value={form.musician_id} disabled={editing} onChange={(e) => set("musician_id", e.target.value)} /></label>
        <label>Age<input type="number" value={form.age} onChange={num("age")} /></label>
        <label>Instrument
          <select value={form.instrument} onChange={(e) => set("instrument", e.target.value)}>
            {["piano", "guitar", "violin", "cello"].map((i) => <option key={i}>{i}</option>)}
          </select>
        </label>
        <label>Home region<input value={form.home_region} onChange={(e) => set("home_region", e.target.value)} /></label>
        <label>Gets there by
          <select value={form.transport} onChange={(e) => set("transport", e.target.value)}>
            <option value="car">car</option><option value="transit">transit</option><option value="guardian">guardian</option>
          </select>
        </label>
        <label>Home latitude<input type="number" step="0.0001" value={form.home_lat} onChange={num("home_lat")} /></label>
        <label>Home longitude<input type="number" step="0.0001" value={form.home_lng} onChange={num("home_lng")} /></label>
        <label>Shows per month (cap)<input type="number" value={form.max_shows_per_month} onChange={num("max_shows_per_month")} /></label>
        <label>Years with the org<input type="number" step="0.1" value={form.years_with_org} onChange={num("years_with_org")} /></label>
        <label>Usual songs<input type="number" value={form.typical_songs} onChange={num("typical_songs")} /></label>
        <label>Most songs they'll learn<input type="number" value={form.max_songs} onChange={num("max_songs")} /></label>
        <label className="checkbox-label">
          <input type="checkbox" checked={form.can_drive} onChange={(e) => set("can_drive", e.target.checked)} />
          Can drive others
        </label>
      </div>
      <div className="panel-footer">
        <button className="button" onClick={save} disabled={!form.display_name || !form.musician_id}>
          {editing ? "Save changes" : "Add musician"}
        </button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
