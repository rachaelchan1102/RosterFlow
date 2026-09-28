import { useEffect } from "react";
import { PanelIndexContext, useApp, type Panel } from "../AppState";
import { useFocusTrap } from "../useFocusTrap";
import AvailabilityGrid from "./AvailabilityGrid";
import BulkImportMusicians from "./BulkImportMusicians";
import CancellationFlow from "./CancellationFlow";
import FacilityForm from "./FacilityForm";
import MusicianForm from "./MusicianForm";
import MusicianPanel from "./MusicianPanel";
import ShowDrawer from "./ShowDrawer";
import ShowForm from "./ShowForm";
import ShowList from "./ShowList";
import UpdateSummaryPanel from "./UpdateSummaryPanel";

function render(panel: Panel) {
  switch (panel.kind) {
    case "show": return <ShowDrawer showId={panel.id} />;
    case "showList": return <ShowList list={panel.list} start={panel.start} end={panel.end} />;
    case "musician": return <MusicianPanel musicianId={panel.id} />;
    case "addShow": return <ShowForm initialDate={panel.date} initialFacilityId={panel.facilityId} />;
    case "editShow": return <ShowForm showId={panel.id} />;
    case "musicianForm": return <MusicianForm musicianId={panel.id} />;
    case "bulkImportMusicians": return <BulkImportMusicians />;
    case "facilityForm": return <FacilityForm facilityId={panel.id} />;
    case "availability": return <AvailabilityGrid musicianId={panel.id} />;
    case "cancel": return <CancellationFlow initialShowId={panel.showId} initialMusicianId={panel.musicianId} inPanel />;
    case "updateSummary": return <UpdateSummaryPanel changes={panel.changes} />;
  }
}

/** One drawer on the right; panels stack, so the back link returns to where you drilled in from
 *  (a show opened from "Open seats" goes back to that list). */
export default function PanelHost() {
  const { panels, panelTitles, backPanel, closePanels, confirmRequest } = useApp();
  const top = panels[panels.length - 1];
  const depth = panels.length;
  // Stays "active" even while a confirm dialog is open on top of it: that dialog lives outside
  // this element and manages its own trap, so this one is simply a no-op meanwhile.
  const trapRef = useFocusTrap<HTMLElement>(depth > 0, depth);

  useEffect(() => {
    // Escape belongs to the confirm dialog while it's open.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !confirmRequest) closePanels(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePanels, confirmRequest]);

  if (!top) return null;
  const previous = depth > 1 ? panelTitles[depth - 2] : undefined;
  return (
    <>
      <div className="drawer-scrim" onClick={closePanels} />
      <aside ref={trapRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="true">
        <button className="drawer-close" onClick={closePanels} aria-label="Close">×</button>
        {depth > 1 && (
          <button className="drawer-back" onClick={backPanel}>‹ {previous ?? "Back"}</button>
        )}
        <PanelIndexContext.Provider value={depth - 1}>
          <div key={depth} className="drawer-content">{render(top)}</div>
        </PanelIndexContext.Provider>
      </aside>
    </>
  );
}
