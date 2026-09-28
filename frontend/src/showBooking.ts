import type { Show } from "./types";

/** Next free show_id, S0001-style — shared by the Add-show form and the Scenario Planner's
 *  "book this" action so both mint IDs the same way. */
export function nextShowId(shows: Show[]): string {
  const max = shows.reduce((m, s) => Math.max(m, Number(s.show_id.replace(/\D/g, "")) || 0), 0);
  return `S${String(max + 1).padStart(4, "0")}`;
}
