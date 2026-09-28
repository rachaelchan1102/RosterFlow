import type { ReactNode } from "react";
import { TONE_LABEL, type Tone } from "../rosterflow";

/** The small square that carries a show's state everywhere: filled grey, amber outline, amber,
 *  or red. Always paired with a label or a title, never color alone. */
export function Mark({ tone, size = 8, title }: { tone: Tone; size?: number; title?: string }) {
  return <span className={`mark ${tone}`} style={{ width: size, height: size }} title={title ?? TONE_LABEL[tone]} />;
}

export function ToneLegend({ note }: { note?: ReactNode }) {
  return (
    <div className="legend">
      {(["ok", "thin", "short", "none"] as Tone[]).map((t) => (
        <span key={t} className="legend-item"><Mark tone={t} />{TONE_LABEL[t]}</span>
      ))}
      {note && <span className="legend-note">{note}</span>}
    </div>
  );
}

/** Two or more mutually exclusive options, the dark one selected. */
export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Figure({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="figure">
      <div className="figure-label">{label}</div>
      <div className={`figure-value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="figure-sub">{sub}</div>}
    </div>
  );
}
