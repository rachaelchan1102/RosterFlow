import { usePanelTitle } from "../AppState";
import type { Change } from "../types";
import UpdateSummary from "./UpdateSummary";

/** The same "what changed" report the Schedule page shows inline, opened as a panel instead —
 *  reached from the "View changes" action on the toast that follows an update triggered from
 *  anywhere else in the app (Capacity, a musician's availability, etc). */
export default function UpdateSummaryPanel({ changes }: { changes: Change[] }) {
  usePanelTitle("What changed");
  return (
    <div className="panel-body">
      <div className="panel-title"><h2>What changed</h2></div>
      <UpdateSummary changes={changes} />
    </div>
  );
}
