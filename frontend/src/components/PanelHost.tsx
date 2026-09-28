import { Fragment, useEffect } from "react";
import { PanelIndexContext, useApp, type Panel } from "../AppState";
import { useFocusTrap } from "../useFocusTrap";
import AvailabilityGrid from "./AvailabilityGrid";
import BulkImportMusicians from "./BulkImportMusicians";
import CancellationFlow from "./CancellationFlow";
import FacilityForm from "./FacilityForm";
import MusicianForm from "./MusicianForm";
import MusicianPanel from "./MusicianPanel";
import ShowForm from "./ShowForm";
import ShowPanel from "./ShowPanel";
import UpdateSummaryPanel from "./UpdateSummaryPanel";

function render(panel: Panel) {
  switch (panel.kind) {
    case "show": return <ShowPanel showId={panel.id} />;
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

/** One slide-over on the right; panels stack, so "back" returns to where you drilled in from.
 *  Each panel names itself (usePanelTitle) so the trail reads "Location 4 → Musician 27". */
export default function PanelHost() {
  const { panels, panelTitles, backPanel, goToPanel, closePanels, confirmRequest } = useApp();
  const top = panels[panels.length - 1];
  const depth = panels.length;
  // Stays "active" even while a confirm dialog is open on top of it: that dialog lives outside
  // this element and manages its own trap, so this one is simply a no-op meanwhile (Tab-handling
  // only fires when focus is actually inside this container) rather than prematurely returning
  // focus to whatever was focused before the panel opened.
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
      <div className="panel-scrim" onClick={closePanels} />
      <aside ref={trapRef} tabIndex={-1} className="side-panel" role="dialog" aria-modal="true">
        <div className="panel-nav">
          {depth > 1
            ? <button className="link-button" onClick={backPanel}>← {previous ? `Back to ${previous}` : "Back"}</button>
            : <span />}
          <button className="link-button" onClick={closePanels} aria-label="Close">Close ✕</button>
        </div>
        {depth > 1 && (
          <nav className="breadcrumb" aria-label="Where you are">
            {panels.map((_, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="breadcrumb-sep">→</span>}
                {i < depth - 1
                  ? <button className="link-button" onClick={() => goToPanel(i)}>{panelTitles[i] ?? "…"}</button>
                  : <span className="breadcrumb-current">{panelTitles[i] ?? "…"}</span>}
              </Fragment>
            ))}
          </nav>
        )}
        <PanelIndexContext.Provider value={depth - 1}>
          <div key={depth} className="panel-content">{render(top)}</div>
        </PanelIndexContext.Provider>
      </aside>
    </>
  );
}
