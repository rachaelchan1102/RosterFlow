export interface ComparisonRow {
  key: string;
  label: string;
  format: (v: number) => string;
  higherIsBetter: boolean;
  unit?: string;
}

/** Every deterministic/probabilistic scenario module (stress-test, capacity drop, demand
 *  growth, network cost) compares a baseline Kpis object against a scenario one in the same
 *  shape — this is that comparison, built once instead of once per module. */
export const KPI_ROWS: ComparisonRow[] = [
  { key: "fill_rate", label: "Shows with a full set", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: true },
  { key: "backup_coverage", label: "Backups available", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: true },
  { key: "capacity_utilization_mean", label: "Capacity used", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: false },
  { key: "capacity_utilization_spread", label: "Workload balance (lower is more even)", format: (v) => `±${Math.round(v * 100)}%`, higherIsBetter: false },
  { key: "total_car_km", label: "Total car-km", format: (v) => `${v.toFixed(0)} km`, higherIsBetter: false, unit: "km" },
  { key: "rotation_repeat_rate", label: "Repeat visits", format: (v) => `${Math.round(v * 100)}%`, higherIsBetter: false },
];

export const MINUTES_SHORT_ROW: ComparisonRow = {
  key: "minutes_short", label: "Music missing, all shows", format: (v) => `~${Math.round(v)} min`,
  higherIsBetter: false, unit: "min",
};

function DeltaCell({ row, base, next }: { row: ComparisonRow; base: number; next: number }) {
  const diff = next - base;
  if (Math.abs(diff) < 1e-9) return <td className="muted">—</td>;
  const better = row.higherIsBetter ? diff > 0 : diff < 0;
  // The arrow always reflects the actual direction the number moved; color/label carry whether
  // that direction is good or bad — conflating the two (an arrow that points "up" for a
  // decrease just because a decrease happens to be the good outcome) reads as a data error.
  const shown = row.unit ? `${diff > 0 ? "+" : ""}${diff.toFixed(0)} ${row.unit}`
    : `${diff > 0 ? "+" : ""}${Math.round(diff * 100)} pts`;
  return <td className={better ? "delta-good" : "delta-bad"}>{diff > 0 ? "▲" : "▼"} {shown}</td>;
}

// Accepts any KPI-shaped object (Kpis, or Kpis plus a module-specific extra field like
// minutes_short) at the call site with no cast — TS won't structurally match a plain interface
// (no index signature of its own) against any Record<string, _> parameter type, however loose,
// so the prop type here is deliberately just `object` and the index access is cast internally.
export default function KpiComparisonTable({ baseline, scenario, rows, baseLabel = "Current schedule", scenarioLabel = "Scenario" }: {
  baseline: object; scenario: object; rows: ComparisonRow[];
  baseLabel?: string; scenarioLabel?: string;
}) {
  const num = (o: object, key: string) => (o as Record<string, number>)[key];
  return (
    <table className="comparison-table">
      <thead><tr><th /><th>{baseLabel}</th><th>{scenarioLabel}</th><th>Change</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.label}</td>
            <td>{row.format(num(baseline, row.key))}</td>
            <td><strong>{row.format(num(scenario, row.key))}</strong></td>
            <DeltaCell row={row} base={num(baseline, row.key)} next={num(scenario, row.key)} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
