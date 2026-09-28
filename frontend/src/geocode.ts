interface GeocodeResult { display_name: string; lat: string; lon: string }

/** Turns free-text ("123 Main St, Toronto") into coordinates via OpenStreetMap's free Nominatim
 *  geocoder — no API key, but rate-limited to about one request a second by Nominatim's own usage
 *  policy, so a caller doing several in a row (a bulk import) must space them out itself. */
/** A Nominatim result reads like "123 Main St, North York, Toronto, Ontario, M2N 5V6, Canada" —
 *  the neighborhood/city is usually the 2nd comma-separated segment (the 1st is the street
 *  address). Best-effort only; the field stays editable either way. */
export function guessRegion(label: string): string {
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[1] ?? parts[0] ?? "";
}

export async function geocodeAddress(query: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const q = query.trim();
  if (!q) return null;
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as GeocodeResult[];
  if (data.length === 0) return null;
  return { lat: Number(data[0].lat), lng: Number(data[0].lon), label: data[0].display_name };
}
