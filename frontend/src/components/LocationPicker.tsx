import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";

interface GeocodeResult { display_name: string; lat: string; lon: string }

function ClickToPlace({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

/** Pans the map when `target` changes (a search result was picked) — MapContainer's own
 *  `center` prop only applies once, at mount, so moving the view afterward needs the live map
 *  instance via useMap, the same pattern NetworkMap's FitBounds uses. */
function RecenterOn({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (target) map.flyTo(target, 13); }, [target, map]);
  return null;
}

/** Turns free-text ("123 Main St, Toronto") into coordinates via OpenStreetMap's free Nominatim
 *  geocoder — no API key, but rate-limited to about one request a second, so this only ever
 *  fires on submit (Enter or the button), never per keystroke. */
function AddressSearch({ onFound }: { onFound: (lat: number, lng: number, label: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = (await res.json()) as GeocodeResult[];
      if (id !== requestId.current) return;   // a newer search superseded this one
      setResults(data);
      if (data.length === 0) setError("No matches for that address.");
    } catch {
      if (id !== requestId.current) return;
      setError("Couldn't reach the address search. You can still click the map directly.");
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  const pick = (r: GeocodeResult) => {
    onFound(Number(r.lat), Number(r.lon), r.display_name);
    setResults(null);
    setQuery(r.display_name);
  };

  return (
    <div className="address-search">
      <div className="form-row">
        <input value={query} placeholder="Search an address or place…"
               onChange={(e) => { setQuery(e.target.value); setResults(null); }}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <button type="button" className="button secondary" onClick={search} disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      {results && results.length > 0 && (
        <ul className="address-results">
          {results.map((r, i) => (
            <li key={i}>
              <button type="button" onClick={() => pick(r)}>{r.display_name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A click-to-place map pin plus an optional address search, standing in for typing raw
 *  latitude/longitude by hand. Uses the same CircleMarker style NetworkMap does, so this never
 *  touches Leaflet's default marker icon (its image paths don't survive bundling without extra
 *  config), and geocodes addresses via OpenStreetMap's Nominatim, so no API key or backend
 *  change is needed. */
export default function LocationPicker({ lat, lng, onChange, onAddressFound, helpText }: {
  lat: number; lng: number; onChange: (lat: number, lng: number) => void;
  /** Fires only for a search-picked result (never a raw map click, which has no address text) —
   *  callers can use the label to guess a region, so it doesn't have to be retyped by hand. */
  onAddressFound?: (label: string) => void; helpText?: string;
}) {
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);

  return (
    <div className="location-picker">
      <AddressSearch onFound={(foundLat, foundLng, label) => {
        onChange(foundLat, foundLng); setFlyTarget([foundLat, foundLng]); onAddressFound?.(label);
      }} />
      <MapContainer center={[lat, lng]} zoom={11} scrollWheelZoom={false} style={{ height: "220px", width: "100%" }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <ClickToPlace onPick={onChange} />
        <RecenterOn target={flyTarget} />
        <CircleMarker center={[lat, lng]} radius={9}
                      pathOptions={{ color: "var(--accent)", fillColor: "var(--accent)", fillOpacity: 0.85, weight: 2 }} />
      </MapContainer>
      <p className="small muted">{helpText ?? "Search an address, or click the map to set where they travel from."}</p>
    </div>
  );
}
