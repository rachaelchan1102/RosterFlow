import "leaflet/dist/leaflet.css";
import { Fragment, useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import type { NetworkFacility, NetworkRoute } from "../types";
import { StatusBadge } from "./Status";

// Colored by whether the ride is shared, not by who's driving — a solo trip is "by car" whether
// a guardian or the rider themself drives, and "carpool" covers both peer- and guardian-driven
// groups of 2+. That's the real distinction that matters here, not the driver's identity.
type DisplayMode = "carpool" | "solo" | "transit";
const MODE_COLOR: Record<DisplayMode, string> = {
  carpool: "var(--mode-carpool)", solo: "var(--mode-solo)", transit: "var(--mode-transit)",
};
const MODE_LABEL: Record<DisplayMode, string> = { carpool: "Carpool", solo: "Solo (car)", transit: "Transit" };
const STATUS_FILL: Record<string, string> = { green: "var(--green)", amber: "var(--amber-mark)", red: "var(--red)" };

function displayMode(ride: NetworkRoute[]): DisplayMode {
  if (ride[0].mode === "transit") return "transit";
  return ride.length > 1 ? "carpool" : "solo";
}

/** A gentle arc instead of a straight line — the standard fix for origin-destination maps. A
 *  straight line reads as a claimed driving route, and a synthetic home 2km off a real address
 *  can land it across a lake or through a building; an arc reads as a schematic connector
 *  instead, which is what it actually is (there's no real routing behind this map). */
function arcPoints(from: [number, number], to: [number, number], bend = 0.14): [number, number][] {
  const [lat1, lng1] = from, [lat2, lng2] = to;
  const mlat = (lat1 + lat2) / 2, mlng = (lng1 + lng2) / 2;
  const dLat = lat2 - lat1, dLng = lng2 - lng1;
  // Control point offset perpendicular to the line, so every arc curves the same way — a subtle,
  // consistent direction-of-travel cue, same convention flight-route maps use.
  const clat = mlat + dLng * bend;
  const clng = mlng - dLat * bend;
  const steps = 24;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t ** 2;
    return [a * lat1 + b * clat + c * lat2, a * lng1 + b * clng + c * lng2] as [number, number];
  });
}

/** Re-centers when the day's pins change, so a date with shows clustered elsewhere doesn't leave
 *  the map staring at empty ocean. */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) { map.setView(points[0], 11); return; }
    map.fitBounds(points, { padding: [32, 32] });
  }, [map, points]);
  return null;
}

/** Facility pins for one date, plus a line for every musician's trip home → location, colored by
 *  whether the ride is shared. The single most recognizable "this is logistics software" visual. */
export default function NetworkMap({ facilities, routes }: { facilities: NetworkFacility[]; routes: NetworkRoute[] }) {
  const points: [number, number][] = facilities.length
    ? facilities.map((f) => [f.lat, f.lng] as [number, number])
    : [[43.7, -79.42]];
  const byGroup = new Map<string, NetworkRoute[]>();
  routes.forEach((r) => byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]));

  return (
    <div className="network-map">
      <MapContainer center={points[0]} zoom={10} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitBounds points={points} />
        {routes.map((r, i) => {
          const line = arcPoints([r.from_lat, r.from_lng], [r.to_lat, r.to_lng]);
          const ride = byGroup.get(r.group) ?? [r];
          const mode = displayMode(ride);
          const weight = r.is_driver ? 3.5 : 2.5;
          return (
            <Fragment key={i}>
              {/* A white "casing" under the colored line — standard map styling so a route reads
                  clearly over OSM's own busy road colors, without needing a paid, key-gated basemap.
                  Purely visual: interactive is off, and the wide invisible line below carries clicks. */}
              <Polyline positions={line} pathOptions={{ color: "#fff", weight: weight + 2.5, opacity: 0.9 }} interactive={false} />
              <Polyline positions={line} pathOptions={{ color: MODE_COLOR[mode], weight, opacity: 0.95 }} interactive={false} />
              {/* Invisible and much wider than the visible line, so tapping near a route — not
                  its exact pixel — registers. Every line in the same ride shares this popup:
                  click any one of them (each rider's home is a different point) and see who
                  else is in it. */}
              <Polyline positions={line} pathOptions={{ opacity: 0, weight: 16 }}>
                <Popup>
                  {ride.map((m) => <div key={m.musician_id}>{m.name}</div>)}
                </Popup>
              </Polyline>
            </Fragment>
          );
        })}
        {facilities.map((f) => (
          <CircleMarker key={f.show_id} center={[f.lat, f.lng]} radius={9}
                        pathOptions={{ color: STATUS_FILL[f.status], fillColor: STATUS_FILL[f.status], fillOpacity: 0.85, weight: 2 }}>
            <Popup>
              <strong>{f.name}</strong><br />
              {f.start_time} · {f.musician_count}/{f.target_musicians} musicians
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      <div className="network-legend">
        <span className="network-legend-group">
          {(["carpool", "solo", "transit"] as const).map((mode) => (
            <span key={mode} className="network-legend-item">
              <span className="network-legend-swatch" style={{ background: MODE_COLOR[mode] }} />
              {MODE_LABEL[mode]}
            </span>
          ))}
        </span>
        <span className="network-legend-group">
          <StatusBadge status="green" /> <StatusBadge status="amber" /> <StatusBadge status="red" />
        </span>
      </div>
    </div>
  );
}
