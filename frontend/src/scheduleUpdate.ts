import { api } from "./api";
import type { Toast } from "./AppState";
import type { Change, StillShort } from "./types";

/** The honest version of "Schedule updated" — a resolve can have nothing to move (or nothing
 *  more it's able to do) and still leave a show below minimum or with zero backups; that's a
 *  partial failure, not a no-op success, and needs to say so rather than sounding like
 *  everything's fine. */
export function updateResultMessage(changes: Change[], stillShort: StillShort[]): string {
  const changePart = changes.length ? `${changes.length} change${changes.length !== 1 ? "s" : ""}` : "no one needed to move";
  if (stillShort.length === 0) return `Schedule updated — ${changePart}.`;
  const names = stillShort.slice(0, 2).map((s) => s.facility_name).join(", ");
  const more = stillShort.length > 2 ? ` and ${stillShort.length - 2} more` : "";
  return `Schedule updated (${changePart}), but couldn't fully staff ${names}${more} — nobody eligible was available.`;
}

/** A toast action that runs an update right from wherever the edit was made, so "the schedule
 *  needs updating" always comes with an immediate, one-click way to see what that actually does
 *  — instead of only being actionable back on the Schedule page's update bar. The result is
 *  handed to `setLastUpdateChanges` so a persistent chip (Layout.tsx) can report what changed
 *  for as long as it takes the coordinator to notice it — a toast alone can vanish before
 *  someone on a different page than the one that triggered the update ever sees it. */
export function updateNowAction(
  refresh: () => void,
  showToast: (message: string, action?: Toast["action"]) => void,
  setLastUpdateChanges: (changes: Change[] | null) => void,
): Toast["action"] {
  return {
    label: "Update now",
    run: () => {
      api<{ changes: Change[]; still_short: StillShort[] }>("/api/schedule/resolve", { method: "POST" })
        .then((r) => {
          refresh();
          setLastUpdateChanges(r.changes.length > 0 ? r.changes : null);
          showToast(updateResultMessage(r.changes, r.still_short)
            + (r.changes.length ? ' See "What changed" in the top bar.' : ""));
        })
        .catch((e: Error) => showToast(`Couldn't update the schedule: ${e.message}`));
    },
  };
}
