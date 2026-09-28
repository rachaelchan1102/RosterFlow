import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "../api";
import { useApp, useDirtyOnChange, usePanelTitle } from "../AppState";
import { guessRegion } from "../geocode";
import type { Facility } from "../types";
import LocationPicker from "./LocationPicker";

const EMPTY: Facility = {
  facility_id: "", display_name: "", region: "", lat: 43.65, lng: -79.38,
  show_duration_min: 60, songs_per_show: 15, preferred_slot: "Mon 18:30",
  target_musicians: 7, min_musicians: 3, max_musicians: 10, has_piano_onsite: true,
  address: "", contact_name: "", contact_phone: "", parking_notes: "", piano_notes: "",
  load_in_buffer_min: 15, max_per_car: 3,
};

function nextFacilityId(all: Facility[]): string {
  const max = all.reduce((m, f) => Math.max(m, Number(f.facility_id.replace(/\D/g, "")) || 0), 0);
  return `LOC${max + 1}`;
}

/** Add a brand-new location, or edit an existing one — same form either way, the way
 *  MusicianForm and ShowForm both handle add/edit with one component. */
export default function FacilityForm({ facilityId }: { facilityId?: string }) {
  const { refresh, backPanel, showToast, setPanelDirty } = useApp();
  const editing = Boolean(facilityId);
  usePanelTitle(editing ? "Edit location" : "Add a location");
  const [form, setForm] = useState<Facility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Same reasoning as MusicianForm's home-pin gate: every distance and carpool calculation
  // depends on a real pin, so a new location can't be saved with the map's placeholder center.
  const [locationSet, setLocationSet] = useState(editing);

  useEffect(() => {
    api<Facility[]>("/api/facilities").then((all) => {
      if (facilityId) {
        setForm(all.find((f) => f.facility_id === facilityId) ?? null);
      } else {
        setForm({ ...EMPTY, facility_id: nextFacilityId(all) });
      }
      setLoaded(true);
    });
  }, [facilityId]);

  useDirtyOnChange(form, loaded);

  if (!form) return <div className="panel-body"><p className="small muted">Loading…</p></div>;

  const set = <K extends keyof Facility>(key: K, value: Facility[K]) => setForm({ ...form, [key]: value });
  const str = (key: keyof Facility) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, e.target.value as never);
  const num = (key: keyof Facility) => (e: ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value) as never);

  const [slotDay, slotTime] = form.preferred_slot.split(" ");
  const setSlotDay = (day: string) => set("preferred_slot", `${day} ${slotTime ?? "18:30"}` as never);
  const setSlotTime = (time: string) => set("preferred_slot", `${slotDay ?? "Mon"} ${time}` as never);

  const save = () => {
    setError(null);
    const req = editing
      ? (() => { const { facility_id, ...changes } = form; void facility_id; return api(`/api/facilities/${facilityId}`, { method: "PUT", body: changes }); })()
      : api("/api/facilities", { method: "POST", body: form });
    req.then(() => {
      setPanelDirty(false);
      showToast(editing ? "Saved." : `${form.display_name} added as a new location.`);
      refresh();
      backPanel();
    }).catch((e) => setError(e.message));
  };

  return (
    <div className="panel-body">
      <div className="panel-title"><h2>{editing ? form.display_name : "Add a location"}</h2></div>
      {error && <p className="error">{error}</p>}
      <div className="form-grid">
        <label>Name<input value={form.display_name} onChange={str("display_name")} /></label>
        <label>Region<input value={form.region} onChange={str("region")}
                            placeholder="e.g. the neighborhood or town" /></label>
        <label>Address<input value={form.address} onChange={str("address")}
                              placeholder="Street address" /></label>
        <label>Contact name<input value={form.contact_name} onChange={str("contact_name")} /></label>
        <label>Contact phone<input value={form.contact_phone} onChange={str("contact_phone")} /></label>
      </div>
      <div className="form-grid">
        <label>Target musicians<input type="number" min={1} value={form.target_musicians} onChange={num("target_musicians")} /></label>
        <label>Minimum musicians<input type="number" min={1} value={form.min_musicians} onChange={num("min_musicians")} /></label>
        <label>Maximum musicians<input type="number" min={1} value={form.max_musicians} onChange={num("max_musicians")} /></label>
        <label>Usual day
          <select value={slotDay ?? "Mon"} onChange={(e) => setSlotDay(e.target.value)}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>Usual time<input type="time" value={slotTime ?? "18:30"} onChange={(e) => setSlotTime(e.target.value)} /></label>
        <label>Usual length
          <select value={form.show_duration_min} onChange={(e) => set("show_duration_min", Number(e.target.value))}>
            <option value={45}>45 min</option>
            <option value={60}>60 min</option>
          </select>
        </label>
      </div>
      <p className="small muted">
        Target is what a full show aims for; minimum is the floor a show can still go ahead with. The usual
        day/time/length is only a default when adding a new show here — it doesn't move any show already booked.
      </p>
      <div className="form-grid">
        <label>Load-in buffer (minutes)
          <input type="number" min={0} value={form.load_in_buffer_min} onChange={num("load_in_buffer_min")} />
        </label>
        <label>Max per car (parking)
          <input type="number" min={1} value={form.max_per_car} onChange={num("max_per_car")} />
        </label>
      </div>
      <p className="small muted">
        Load-in buffer is how long before start musicians should arrive — informational, shown on the show panel.
        Max per car overrides the usual carpool size when parking here is tight.
      </p>
      <label className="checkbox-label">
        <input type="checkbox" checked={form.has_piano_onsite}
               onChange={(e) => set("has_piano_onsite", e.target.checked)} />
        Piano on site
      </label>
      <label>Piano notes
        <textarea value={form.piano_notes} onChange={str("piano_notes")} rows={2}
                  placeholder="Condition, location in the building, tuning notes, etc." />
      </label>
      <label>Parking notes
        <textarea value={form.parking_notes} onChange={str("parking_notes")} rows={2}
                  placeholder="Where musicians should park, entrance to use, etc." />
      </label>
      <label className="block">
        Location on map {!locationSet && <span className="error">— required, search an address or click the map</span>}
        <LocationPicker lat={form.lat} lng={form.lng}
                        onChange={(lat, lng) => { setForm({ ...form, lat, lng }); setLocationSet(true); }}
                        onAddressFound={(label) => {
                          setForm((prev) => (prev && !prev.region ? { ...prev, region: guessRegion(label) } : prev));
                        }}
                        helpText="Search an address, or click the map to set where this location is." />
      </label>

      <div className="panel-footer">
        <button className="button" onClick={save} disabled={!form.display_name || !locationSet}>
          {editing ? "Save changes" : "Add location"}
        </button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
