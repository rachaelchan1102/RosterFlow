import { useState } from "react";
import type { FlowLink, FlowNode } from "../types";

const ROW_H = 26;
const WIDTH = 720;
const COL_LEFT = 190;
const COL_RIGHT = 530;

function heat(ratio: number): string {
  // Same green/amber/red vocabulary would be wrong here (this isn't a status), so volume gets its
  // own single-hue scale — light for barely-there, solid accent for the busiest cell.
  const alpha = 0.08 + 0.72 * ratio;
  return `rgba(42, 120, 214, ${alpha.toFixed(2)})`;
}

/** Musician trips flowing from home region into each location. Defaults to a region × location
 *  heatmap table — sortable, every label fully readable — with the two-column flow diagram as an
 *  optional view, not the default: at 28+ shows the diagram's labels ran a few pixels tall and
 *  clipped ("Riverside Gardens Care Centre · 2"), and the table reads faster for "which pairing is
 *  the outlier" anyway. */
export default function FlowDiagram({ nodes, links }: { nodes: FlowNode[]; links: FlowLink[] }) {
  const [view, setView] = useState<"heatmap" | "diagram" | "list">("heatmap");
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
  const cellFor = new Map(links.map((l) => [`${l.source}|${l.target}`, l]));

  return (
    <div className="flow-diagram">
      <div className="flow-diagram-head">
        <p className="small muted">
          {view === "heatmap" ? "Darker cells mean more trips on that region → location pairing."
            : view === "list" ? "Every region → location pairing, busiest first."
            : "Line width and darkness show trip volume — home region on the left, location on the right."}
        </p>
        <span className="view-toggle" role="tablist">
          <button role="tab" aria-selected={view === "heatmap"} className={view === "heatmap" ? "active" : ""}
                  onClick={() => setView("heatmap")}>Heatmap</button>
          <button role="tab" aria-selected={view === "list"} className={view === "list" ? "active" : ""}
                  onClick={() => setView("list")}>List</button>
          <button role="tab" aria-selected={view === "diagram"} className={view === "diagram" ? "active" : ""}
                  onClick={() => setView("diagram")}>Diagram</button>
        </span>
      </div>
      {view === "heatmap" ? (
        <div className="heatmap-scroll">
          <table className="data-table flow-heatmap">
            <thead>
              <tr>
                <th className="heatmap-corner">Home region</th>
                {sortedFacilities.map((f) => <th key={f.id} title={f.label}>{f.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {sortedRegions.map((r) => (
                <tr key={r.id}>
                  <th className="row-label">{r.label}</th>
                  {sortedFacilities.map((f) => {
                    const l = cellFor.get(`${r.id}|${f.id}`);
                    return (
                      <td key={f.id} style={l ? { background: heat(l.value / maxValue) } : undefined}
                          title={l ? `${r.label} → ${f.label}: ${l.value} trip${l.value !== 1 ? "s" : ""} · avg ${l.avg_km.toFixed(1)} km` : undefined}>
                        {l ? l.value : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "list" ? (
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
