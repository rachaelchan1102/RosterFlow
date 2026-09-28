import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "../api";
import { useApp, useDirtyOnChange, usePanelTitle } from "../AppState";
import { guessRegion } from "../geocode";
import { updateNowAction } from "../scheduleUpdate";
import type { Musician } from "../types";
import LocationPicker from "./LocationPicker";

const EMPTY: Musician = {
  musician_id: "", display_name: "", age: 18, instrument: "piano", home_region: "", home_lat: 43.65,
  home_lng: -79.38, transport: "car", can_drive: true, years_with_org: 0, max_shows_per_month: 2,
  min_songs: 1, typical_songs: 2, max_songs: 3, phone: "", email: "", guardian_name: "", guardian_phone: "",
  brings_keyboard: false, household_id: "", secondary_instruments: "",
};

const INSTRUMENTS = ["piano", "guitar", "violin", "cello", "voice", "flute", "other"];

function nextMusicianId(all: Musician[]): string {
  const max = all.reduce((m, x) => Math.max(m, Number(x.musician_id.replace(/\D/g, "")) || 0), 0);
  return `M${String(max + 1).padStart(2, "0")}`;
}

export default function MusicianForm({ musicianId }: { musicianId?: string }) {
  const { refresh, backPanel, showToast, setPanelDirty, setLastUpdateChanges } = useApp();
  const editing = Boolean(musicianId);
  usePanelTitle(editing ? "Edit details" : "Add a musician");
  const [form, setForm] = useState<Musician>(EMPTY);
  const [regions, setRegions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // For a NEW musician, home location starts at the org's placeholder center — every distance,
  // carpool and "too far" calculation depends on it being real, so saving is blocked until it's
  // actually been set (search or map click), rather than silently defaulting and breaking routing
  // for everyone who ever carpools with this person.
  const [locationSet, setLocationSet] = useState(editing);

  useEffect(() => {
    api<Musician[]>("/api/musicians").then((all) => {
      const existing = all.find((m) => m.musician_id === musicianId);
      setForm(existing ?? { ...EMPTY, musician_id: nextMusicianId(all) });
      setRegions([...new Set(all.map((m) => m.home_region).filter(Boolean))].sort());
      setLoaded(true);
    });
  }, [musicianId]);

  useDirtyOnChange(form, loaded);

  const set = <K extends keyof Musician>(key: K, value: Musician[K]) => setForm({ ...form, [key]: value });

  const save = () => {
    setError(null);
    const req = editing
      ? api(`/api/musicians/${musicianId}`, { method: "PUT", body: form })
      : api("/api/musicians", { method: "POST", body: form });
    req.then(() => {
      setPanelDirty(false);
      showToast(editing ? "Saved. The schedule needs updating to reflect this."
                         : `${form.display_name} added. The schedule needs updating to include them.`,
                updateNowAction(refresh, showToast, setLastUpdateChanges));
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
        <label>Primary instrument
          <select value={form.instrument} onChange={(e) => set("instrument", e.target.value)}>
            {INSTRUMENTS.map((i) => <option key={i}>{i}</option>)}
          </select>
        </label>
        {form.instrument === "piano" && (
          <label className="checkbox-label">
            <input type="checkbox" checked={form.brings_keyboard}
                   onChange={(e) => set("brings_keyboard", e.target.checked)} />
            Brings their own keyboard
          </label>
        )}
      </div>

      <fieldset className="checkbox-group">
        <legend>Also plays <span className="muted small">(informational — only the primary instrument above affects staffing)</span></legend>
        {INSTRUMENTS.filter((i) => i !== form.instrument).map((i) => {
          const list = form.secondary_instruments.split(",").map((s) => s.trim()).filter(Boolean);
          const checked = list.includes(i);
          return (
            <label key={i} className="checkbox-label inline">
              <input type="checkbox" checked={checked} onChange={(e) => {
                const next = e.target.checked ? [...list, i] : list.filter((x) => x !== i);
                set("secondary_instruments", next.join(", "));
              }} />
              {i}
            </label>
          );
        })}
      </fieldset>

      <div className="form-grid">
        <label>Home region
          <input value={form.home_region} onChange={(e) => set("home_region", e.target.value)} list="known-regions"
                 placeholder="e.g. the neighborhood or town they travel from" />
          <datalist id="known-regions">{regions.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        <label>Age<input type="number" value={form.age} onChange={num("age")} /></label>
        <label>Gets there by
          <select value={form.transport} onChange={(e) => {
            const transport = e.target.value;
            set("transport", transport);
            if (transport !== "car") set("can_drive", false as never);
          }}>
            <option value="car">drives themselves</option><option value="transit">takes transit</option>
            <option value="guardian">a guardian drives them</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={form.can_drive} disabled={form.transport !== "car" || form.age < 16}
                 onChange={(e) => set("can_drive", e.target.checked)} />
          Can drive others{form.age < 16 && " (under 16)"}
        </label>
        <label>Shows per month (cap)<input type="number" value={form.max_shows_per_month} onChange={num("max_shows_per_month")} /></label>
        <label>Phone<input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} /></label>
        <label>Email<input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></label>
      </div>

      <label className="block">
        Home location {!locationSet && <span className="error">— required, search an address or click the map</span>}
        <LocationPicker lat={form.home_lat} lng={form.home_lng}
                        onChange={(lat, lng) => { setForm({ ...form, home_lat: lat, home_lng: lng }); setLocationSet(true); }}
                        onAddressFound={(label) => {
                          // A typed-over region is never clobbered — this only fills in a first
                          // guess for someone who hasn't set one yet.
                          setForm((prev) => (prev.home_region ? prev : { ...prev, home_region: guessRegion(label) }));
                        }} />
      </label>

      {form.age < 17 && (
        <div className="form-grid">
          <label>Parent/guardian name<input value={form.guardian_name} onChange={(e) => set("guardian_name", e.target.value)} /></label>
          <label>Parent/guardian phone<input type="tel" value={form.guardian_phone} onChange={(e) => set("guardian_phone", e.target.value)} /></label>
        </div>
      )}

      <label>
        Household ID <span className="muted small">(optional — same value as a sibling, or their own guardian, if that person is also on the roster)</span>
        <input value={form.household_id} onChange={(e) => set("household_id", e.target.value)}
               placeholder="e.g. a family name — leave blank if no one else on the roster lives with them" />
      </label>
      <p className="small muted">
        The only thing that lets this person ride in another musician's car — carpooling never assumes a nearby
        adult can take a minor without this explicit link.
      </p>

      <details className="advanced-fields">
        <summary>{editing ? "More details" : "More details (optional — defaults are filled in)"}</summary>
        <p className="small muted">
          {editing
            ? "These affect routing and staffing, not just the profile — check they're still accurate."
            : "Age 18, car, 0 years with the org, and 1–3 songs are placeholders. Fix any that are wrong — they affect routing and staffing, not just the profile."}
        </p>
        <div className="form-grid">
          <label>Years with the org<input type="number" step="0.1" value={form.years_with_org} onChange={num("years_with_org")} /></label>
          <label>Usual songs<input type="number" value={form.typical_songs} onChange={num("typical_songs")} /></label>
          <label>Most songs they'll learn<input type="number" value={form.max_songs} onChange={num("max_songs")} /></label>
        </div>
      </details>

      <div className="panel-footer">
        <button className="button" onClick={save} disabled={!form.display_name || !form.musician_id || !locationSet}>
          {editing ? "Save changes" : "Add musician"}
        </button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
