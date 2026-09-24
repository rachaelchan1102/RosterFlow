import { useEffect, useState } from "react";

/** Progress for the long optimizer runs (~20s). The optimizer can't report real progress, so this
 *  walks through the stages it genuinely goes through, paced by the typical run time, and eases
 *  the bar toward — but never to — 100% until the run actually finishes. */
export default function SolveProgress({ steps, estimateSec }: { steps: string[]; estimateSec: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = performance.now();
    const t = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 200);
    return () => window.clearInterval(t);
  }, []);

  // Linear up to the estimate, then creep slowly so an overrun never looks frozen or finished.
  const fraction = elapsed < estimateSec ? 0.9 * (elapsed / estimateSec)
    : 0.9 + 0.08 * (1 - Math.exp(-(elapsed - estimateSec) / 10));
  const stepIdx = Math.min(steps.length - 1, Math.floor((elapsed / estimateSec) * steps.length));
  const left = Math.max(0, Math.ceil(estimateSec - elapsed));

  return (
    <div className="solve-progress" role="status" aria-live="polite">
      <div className="solve-progress-bar"><span style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
      <ol className="solve-steps">
        {steps.map((s, i) => (
          <li key={s} className={i < stepIdx ? "done" : i === stepIdx ? "current" : ""}>
            <span className="solve-step-mark">{i < stepIdx ? "✓" : i === stepIdx ? "•" : ""}</span>{s}
          </li>
        ))}
      </ol>
      <p className="small muted">{left > 0 ? `About ${left}s left` : "Finishing up…"}</p>
    </div>
  );
}

