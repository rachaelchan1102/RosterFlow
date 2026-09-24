import { useState } from "react";
import type { FlowLink, FlowNode } from "../types";

const ROW_H = 26;
const WIDTH = 720;
const COL_LEFT = 190;
const COL_RIGHT = 530;

/** Musician trips flowing from home region into each location, as a two-column flow diagram.
 *  One hue, by design: this encodes magnitude (trip volume), not identity, so link width and
 *  opacity carry the value and every node is named directly — no legend needed for one series. */
export default function FlowDiagram({ nodes, links }: { nodes: FlowNode[]; links: FlowLink[] }) {
  const [asTable, setAsTable] = useState(false);
  const regions = nodes.filter((n) => n.kind === "region");
  const facilities = nodes.filter((n) => n.kind === "facility");
  const totalFor = (id: string) => links.reduce((sum, l) => sum + (l.source === id || l.target === id ? l.value : 0), 0);
  const kmFor = (id: string) => links.reduce((sum, l) => sum + (l.source === id || l.target === id ? l.total_km : 0), 0);
  const sortedRegions = [...regions].sort((a, b) => totalFor(b.id) - totalFor(a.id));
  const sortedFacilities = [...facilities].sort((a, b) => totalFor(b.id) - totalFor(a.id));
  const label = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;

  if (links.length === 0) return <p className="muted small">No assignments for this to show as trips.</p>;

  const height = Math.max(sortedRegions.length, sortedFacilities.length, 1) * ROW_H + 20;
  const yFor = (list: FlowNode[], id: string) => 10 + list.findIndex((n) => n.id === id) * ROW_H + ROW_H / 2;
  const maxValue = Math.max(1, ...links.map((l) => l.value));
  const sortedLinks = [...links].sort((a, b) => b.value - a.value);

  return (
    <div className="flow-diagram">
      <div className="flow-diagram-head">
        <p className="small muted">Line width and darkness show trip volume — home region on the left, location on the right.</p>
        <button className="link-button" onClick={() => setAsTable(!asTable)}>{asTable ? "View as diagram" : "View as table"}</button>
      </div>
      {asTable ? (
        <table className="data-table flow-table">
          <thead><tr><th>Home region</th><th>Location</th><th>Trips</th><th>Avg km</th><th>Total km</th></tr></thead>
          <tbody>
            {sortedLinks.map((l, i) => (
              <tr key={i}>
                <td>{label(l.source)}</td><td>{label(l.target)}</td><td>{l.value}</td>
                <td>{l.avg_km.toFixed(1)}</td><td>{l.total_km.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height} role="img"
             aria-label="Musician trips flowing from home region into each location, weighted by count">
          {sortedLinks.map((l, i) => {
            const y1 = yFor(sortedRegions, l.source);
            const y2 = yFor(sortedFacilities, l.target);
            const mx = (COL_LEFT + COL_RIGHT) / 2;
            const weight = l.value / maxValue;
            return (
              <path key={i} d={`M ${COL_LEFT} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${COL_RIGHT} ${y2}`}
                    stroke="var(--accent)" strokeWidth={1.5 + 5 * weight} fill="none" opacity={0.14 + 0.55 * weight}>
                <title>{`${label(l.source)} → ${label(l.target)}: ${l.value} trip${l.value !== 1 ? "s" : ""} · avg ${l.avg_km.toFixed(1)} km · ${l.total_km.toFixed(0)} km total`}</title>
              </path>
            );
          })}
          {sortedRegions.map((n, i) => (
            <g key={n.id} transform={`translate(${COL_LEFT}, ${10 + i * ROW_H + ROW_H / 2})`}>
              <title>{`${n.label}: ${totalFor(n.id)} trip${totalFor(n.id) !== 1 ? "s" : ""} · ${kmFor(n.id).toFixed(0)} km total`}</title>
              <circle r={3.5} fill="var(--text-secondary)" />
              <text x={-10} textAnchor="end" dy="0.32em" className="flow-label">{n.label} · {totalFor(n.id)}</text>
            </g>
          ))}
          {sortedFacilities.map((n, i) => (
            <g key={n.id} transform={`translate(${COL_RIGHT}, ${10 + i * ROW_H + ROW_H / 2})`}>
              <title>{`${n.label}: ${totalFor(n.id)} trip${totalFor(n.id) !== 1 ? "s" : ""} · ${kmFor(n.id).toFixed(0)} km total`}</title>
              <circle r={3.5} fill="var(--text-secondary)" />
              <text x={10} textAnchor="start" dy="0.32em" className="flow-label">{n.label} · {totalFor(n.id)}</text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
