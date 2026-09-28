import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDate, pct } from "../format";
import type { Feasibility, Status } from "../types";

interface FeasibilityResponse {
  requested: Feasibility;
  alternatives: Feasibility[];
}

function oddsStatus(p: number): Status {
  return p >= 0.9 ? "green" : p >= 0.6 ? "amber" : "red";
}

/** "Could we staff a new show here?" — re-checks automatically whenever facility, date or time
 *  changes. Used in the add-show form and the scenario planner. `onResult` reports the estimate
 *  back up (or null while checking/on a request that hasn't resolved to *this* key yet) so a
 *  caller like the add-show form can warn before saving on a very low estimate — the number
 *  alone, without a resistance point at the moment of committing, reads as advisory-only. */
export default function FeasibilityCheck({ facilityId, date, startTime, durationMin, onPickDate, onResult }: {
  facilityId: string; date: string; startTime: string; durationMin: number; onPickDate: (date: string) => void;
  onResult?: (probability: number | null) => void;
}) {
  // Kept with the request it answers, so a stale result is never shown for a new pick.
  const [checked, setChecked] = useState<{ key: string; result: FeasibilityResponse | null } | null>(null);
  const key = facilityId && date ? [facilityId, date, startTime, durationMin].join("|") : null;

  useEffect(() => {
    onResult?.(null);
    if (!key) return;
    const [facility_id, d, start_time, duration] = key.split("|");
    const t = window.setTimeout(() => {
      api<FeasibilityResponse>("/api/feasibility", {
        method: "POST",
        body: { facility_id, date: d, start_time: start_time || null, duration_min: Number(duration) || null },
      })
        .then((result) => { setChecked({ key, result }); onResult?.(result.requested.probability_fully_staffed); })
        .catch(() => setChecked({ key, result: null }));
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  const feasibility = checked?.key === key ? checked.result : null;
  if (!feasibility) {
    return <p className="muted small">{checked?.key === key ? "Couldn't check that date." : "Checking who'd be free…"}</p>;
  }

  const req = feasibility.requested;
  const others = feasibility.alternatives.filter((a) => a.date !== req.date);
  const status = oddsStatus(req.probability_fully_staffed);
  const recommendation = status === "green" ? "Likely fine to book."
    : status === "amber" ? "Possible, but worth a second look before you commit." : "Unlikely to be fully staffed as-is.";
  return (
    <div className="feasibility">
      <div className={`callout ${status}`}>
        <strong>Estimated {pct(req.probability_fully_staffed)} chance {formatDate(req.date)}{startTime ? ` at ${startTime}` : ""} could be fully staffed</strong>
        <p className="small">{recommendation} This is an estimate, not a guarantee — adding the show doesn't staff it by itself.</p>
        <details className="why-estimate">
          <summary>Why this estimate?</summary>
          <p className="small">
            {req.eligible_pool_size} musicians could play. Ruled out: {req.excluded_day_conflict} already booked that day,{" "}
            {req.excluded_over_cap} at their monthly cap, {req.excluded_guardian_range} too far for a guardian drive
            {startTime ? <>, {req.excluded_time} not usually free at that time</> : null}.
            On a typical run about {req.mean_available_count.toFixed(0)} of them would say yes.
          </p>
        </details>
      </div>
      {others.length > 0 && (
        <div className="alt-dates">
          <span className="small muted">Nearby dates, same time:</span>
          {others.map((a) => (
            <button key={a.date} className={`chip-button odds-${oddsStatus(a.probability_fully_staffed)}`}
                    onClick={() => onPickDate(a.date)}>
              {formatDate(a.date)} · {pct(a.probability_fully_staffed)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
