import type { Status } from "../types";

const STATUS_LABEL: Record<Status, string> = {
  red: "Not fully staffed",
  amber: "Thin on backups",
  green: "On track",
};

const STATUS_ICON: Record<Status, string> = { red: "✕", amber: "!", green: "✓" };

/** Always icon + label (or icon + tooltip when compact) — status is never carried by color alone.
 *  `label` overrides the default show-staffing wording for badges used in a different context —
 *  a backup-coverage KPI showing red should say so, not "Not fully staffed," which is a claim
 *  about headcount, not backups. */
export function StatusBadge({ status, compact = false, label }: { status: Status; compact?: boolean; label?: string }) {
  const text = label ?? STATUS_LABEL[status];
  return (
    <span className={`status-badge ${status}`} title={text}>
      <span className="status-icon" aria-hidden>{STATUS_ICON[status]}</span>
      {compact ? <span className="sr-only">{text}</span> : text}
    </span>
  );
}

/** The caller decides the color from the same rules as everywhere else — a bar never invents its
 *  own threshold. Value can legitimately exceed target (extra songs accepted, an extra musician
 *  added) — the fraction shown is capped at the target so it never reads as "over 100% of
 *  itself," with the surplus called out separately instead of silently disappearing. */
export function CoverageBar({ value, target, label, status }: { value: number; target: number; label: string; status: Status }) {
  const ratio = target > 0 ? Math.min(value / target, 1) : 0;
  const spare = value - target;
  return (
    <div className="coverage">
      <div className="coverage-label">
        <span>{label}</span>
        <strong>{Math.min(value, target)} / {target}{spare > 0 && <span className="coverage-spare"> (+{spare} spare)</span>}</strong>
      </div>
      <div className="coverage-track">
        <div className={`coverage-fill ${status}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/** Same red/amber/green language as everything else in the app: under 80% of capacity is fine,
 *  80–100% is worth watching, over 100% means the cap itself is the thing being exceeded. */
export function utilizationStatus(ratio: number): Status {
  return ratio > 1 ? "red" : ratio >= 0.8 ? "amber" : "green";
}

/** A location running AT or above its target headcount is the good outcome, not a warning — the
 *  opposite direction from a musician's monthly cap above, where getting close to 100% is the
 *  thing worth flagging. Sharing one threshold function between "more is good" and "more is a
 *  warning" was why every location bar read amber even at a full 9 of 9. */
export function facilityUtilizationStatus(ratio: number): Status {
  return ratio < 0.85 ? "red" : ratio < 1 ? "amber" : "green";
}

/** Compact horizontal bar for a table cell — a track, a fill and a percentage. `label` (e.g. "Oct")
 *  is shown right on the bar, not just in the hover title — a bare percentage with no visible
 *  period reads as one number, but this one, a musician's profile and a backup's "playing N shows
 *  this period" can each mean a different window, so which one it is has to be on-screen, not
 *  something you only find by hovering. */
export function UtilBar({ ratio, title, label }: { ratio: number; title?: string; label?: string }) {
  const status = utilizationStatus(ratio);
  return (
    <div className="util-bar" title={title}>
      <div className="util-bar-track">
        <div className={`util-bar-fill ${status}`} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      </div>
      <span className="util-bar-pct">{Math.round(ratio * 100)}%{label && <span className="util-bar-label"> ({label})</span>}</span>
    </div>
  );
}
