import { Fragment, useEffect } from "react";
import { PanelIndexContext, useApp, type Panel } from "../AppState";
import AvailabilityGrid from "./AvailabilityGrid";
import CancellationFlow from "./CancellationFlow";
import MusicianForm from "./MusicianForm";
import MusicianPanel from "./MusicianPanel";
import ShowForm from "./ShowForm";
import ShowPanel from "./ShowPanel";

function render(panel: Panel) {
  switch (panel.kind) {
    case "show": return <ShowPanel showId={panel.id} />;
    case "musician": return <MusicianPanel musicianId={panel.id} />;
    case "addShow": return <ShowForm initialDate={panel.date} />;
    case "editShow": return <ShowForm showId={panel.id} />;
    case "musicianForm": return <MusicianForm musicianId={panel.id} />;
    case "availability": return <AvailabilityGrid musicianId={panel.id} />;
    case "cancel": return <CancellationFlow initialShowId={panel.showId} initialMusicianId={panel.musicianId} inPanel />;
  }
}

/** One slide-over on the right; panels stack, so "back" returns to where you drilled in from.
 *  Each panel names itself (usePanelTitle) so the trail reads "Location 4 → Musician 27". */
export default function PanelHost() {
  const { panels, panelTitles, backPanel, goToPanel, closePanels, confirmRequest } = useApp();
  const top = panels[panels.length - 1];

  useEffect(() => {
    // Escape belongs to the confirm dialog while it's open.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !confirmRequest) closePanels(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePanels, confirmRequest]);

  if (!top) return null;
  const depth = panels.length;
  const previous = depth > 1 ? panelTitles[depth - 2] : undefined;
  return (
    <>
      <div className="panel-scrim" onClick={closePanels} />
      <aside className="side-panel" role="dialog" aria-modal="true">
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
