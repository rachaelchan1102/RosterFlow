import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "./AppState";
import PanelHost from "./components/PanelHost";
import QuickFind from "./components/QuickFind";
import { useFocusTrap } from "./useFocusTrap";

function LoginDialog({ onClose }: { onClose: () => void }) {
  const { login, coordinatorAvailable } = useApp();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trapRef = useFocusTrap<HTMLFormElement>(true);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    login(password).then(onClose).catch((err) => setError(err.message)).finally(() => setBusy(false));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form ref={trapRef} tabIndex={-1} className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Coordinator login</h2>
        <p className="muted small">
          Logging in switches to the real, saved schedule. The playground you're in now is sample data
          that resets every time you refresh.
        </p>
        {!coordinatorAvailable && (
          <p className="callout amber small">This server isn't connected to a coordinator database yet, so login will fail.</p>
        )}
        <label>Password
          <input type="password" disabled={!coordinatorAvailable}
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="panel-footer">
          <button className="button" type="submit" disabled={busy || !password || !coordinatorAvailable}>
            {busy ? "Checking…" : "Log in"}
          </button>
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** In-app stand-in for window.confirm, so deleting things looks like the rest of the app. */
function ConfirmDialog() {
  const { confirmRequest, answerConfirm } = useApp();
  const trapRef = useFocusTrap<HTMLDivElement>(!!confirmRequest);
  useEffect(() => {
    if (!confirmRequest) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") answerConfirm(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRequest, answerConfirm]);
  if (!confirmRequest) return null;
  return (
    <div className="modal-scrim" onClick={() => answerConfirm(false)}>
      <div ref={trapRef} tabIndex={-1} className="modal confirm" role="alertdialog" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{confirmRequest.title}</h2>
        <p className="muted">{confirmRequest.body}</p>
        <p className="small muted">{confirmRequest.hint ?? "Not deleted yet — you'll have a few seconds to undo."}</p>
        <div className="panel-footer">
          <button className="button danger-fill" autoFocus onClick={() => answerConfirm(true)}>{confirmRequest.confirmLabel}</button>
          <button className="button secondary" onClick={() => answerConfirm(false)}>Keep it</button>
        </div>
      </div>
    </div>
  );
}

interface NavItem { to: string; label: string; badge?: number; needsUpdate?: boolean }
interface NavGroup { label: string; items: NavItem[] }

/** Grouped by function rather than a flat row of equal-weight tabs — Monitor (what's happening
 *  now), Resources (what we have to work with), Plan (what-if and simulation work). The
 *  structural signal most real logistics platforms use instead of a to-do app's tab bar.
 *  Overview used to sit here too — cut for duplicating Schedule in a worse form (a grade nobody
 *  could act on, a cramped map repeating Network, an activity feed that already has its own full
 *  page) — Schedule is the landing page now, no separate summary screen in front of it. */
function useNavGroups(): NavGroup[] {
  return [
    { label: "Monitor", items: [
      { to: "/operations", label: "Schedule", needsUpdate: true },
    ] },
    { label: "Resources", items: [
      { to: "/network", label: "Network" },
      { to: "/musicians", label: "Musicians" },
    ] },
    { label: "Plan", items: [
      { to: "/scenario", label: "Scenario Planner" },
    ] },
  ];
}

const PINNED_VIEWS = [
  { label: "Thin on backups", to: "/operations", action: "amber" as const },
  { label: "At their cap", to: "/musicians?view=at_cap", action: null },
];

const SECTION_LABEL: Record<string, string> = {
  "/operations": "Schedule", "/network": "Network", "/musicians": "Musicians",
  "/scenario": "Scenario Planner", "/activity": "Activity", "/cancel": "Cancellations",
};

/** "Operations > Location 4 > Musician 27" under the top bar — the page you're on, then the
 *  panel stack on top of it (item #16 from UI_FIXES_1.md; item #11 from UI_SUPPLY_CHAIN2.md). */
function TopBreadcrumb() {
  const location = useLocation();
  const { panels, panelTitles, goToPanel, closePanels } = useApp();
  const pageLabel = SECTION_LABEL[location.pathname] ?? "Schedule";
  if (panels.length === 0) return <span className="top-breadcrumb">{pageLabel}</span>;
  return (
    <span className="top-breadcrumb">
      <button className="link-button" onClick={closePanels}>{pageLabel}</button>
      {panels.map((_, i) => (
        <span key={i}>
          <span className="breadcrumb-sep">›</span>
          {i < panels.length - 1
            ? <button className="link-button" onClick={() => goToPanel(i)}>{panelTitles[i] ?? "…"}</button>
            : <strong>{panelTitles[i] ?? "…"}</strong>}
        </span>
      ))}
    </span>
  );
}

/** The three things a coordinator does most often, one click from anywhere — same pattern as a
 *  TMS's "Create shipment." Also what makes removing Cancellations from the sidebar (item #9)
 *  safe: it's still one click away, just not a whole nav slot. */
function QuickActions() {
  const { openPanel, closePanels, mode } = useApp();
  const navigate = useNavigate();
  const sampleTitle = mode === "playground" ? "This changes sample data — it resets when you refresh." : undefined;
  return (
    <div className="quick-actions">
      <button className="button secondary small-button" title={sampleTitle}
              onClick={() => { closePanels(); openPanel({ kind: "addShow" }); }}>
        + New show
      </button>
      <button className="button secondary small-button" title={sampleTitle}
              onClick={() => { closePanels(); openPanel({ kind: "cancel" }); }}>
        Report cancellation
      </button>
      <button className="button secondary small-button" onClick={() => navigate("/scenario")}>
        Run scenario
      </button>
    </div>
  );
}

/** Compact fallback for the quick actions above — shown only under the 900px breakpoint where
 *  the full row is hidden, so key actions stay one tap away instead of disappearing entirely. */
function MobileActionMenu() {
  const { openPanel, closePanels, mode } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const run = (fn: () => void) => { setOpen(false); fn(); };
  return (
    <div className="mobile-actions">
      <button className="quickfind-trigger mobile-actions-trigger" aria-haspopup="menu" aria-expanded={open}
              aria-label="Quick actions" onClick={() => setOpen((o) => !o)}>
        ☰
      </button>
      {open && (
        <>
          <div className="panel-scrim" onClick={() => setOpen(false)} />
          <div className="mobile-actions-menu" role="menu">
            {mode === "playground" && <p className="small muted mobile-actions-note">Sample data — resets on refresh</p>}
            <button role="menuitem" onClick={() => run(() => { closePanels(); openPanel({ kind: "addShow" }); })}>+ New show</button>
            <button role="menuitem" onClick={() => run(() => { closePanels(); openPanel({ kind: "cancel" }); })}>Report cancellation</button>
            <button role="menuitem" onClick={() => run(() => navigate("/scenario"))}>Run scenario</button>
          </div>
        </>
      )}
    </div>
  );
}

/** A persistent chip reporting what the most recent "Update schedule" run changed, so it's
 *  reachable from anywhere in the app — not just for the moment right after the toast that
 *  followed it — until the coordinator looks at it or dismisses it. */
function LastUpdateChip() {
  const { lastUpdateChanges, setLastUpdateChanges, openPanel } = useApp();
  if (!lastUpdateChanges || lastUpdateChanges.length === 0) return null;
  const shows = new Set(lastUpdateChanges.map((c) => c.show_id)).size;
  return (
    <div className="last-update-chip">
      <button className="link-button" onClick={() => openPanel({ kind: "updateSummary", changes: lastUpdateChanges })}>
        What changed: {shows} show{shows !== 1 ? "s" : ""} from the last update
      </button>
      <button className="link-button" aria-label="Dismiss" onClick={() => setLastUpdateChanges(null)}>✕</button>
    </div>
  );
}

export default function Layout() {
  const { mode, coordinatorAvailable, logout, toast, needsUpdate, unreadActivity, calendarFilter, setCalendarFilter } = useApp();
  const [loginOpen, setLoginOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const groups = useNavGroups();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFindOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Music for the Golden Age</div>
        <nav>
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <span className="nav-group-label">{g.label}</span>
              {g.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"}
                        title={item.needsUpdate && needsUpdate ? `Schedule needs updating: ${needsUpdate}` : undefined}>
                  {item.label}
                  {!!item.badge && (
                    <span className="nav-badge" title={`${item.badge} activity log entr${item.badge === 1 ? "y" : "ies"} since you last looked`}>
                      {item.badge}
                    </span>
                  )}
                  {item.needsUpdate && needsUpdate && <span className="nav-dot" aria-label="schedule needs updating" />}
                </NavLink>
              ))}
            </div>
          ))}
          <div className="nav-group">
            <span className="nav-group-label">Quick filters</span>
            {PINNED_VIEWS.map((v) => {
              // A quick filter with its own query param (like "Over their cap") is only truly
              // active when that EXACT query string is in the URL — matching on pathname alone
              // marked it active on every tab of the Capacity page, not just the filtered one.
              const active = v.action
                ? location.pathname === v.to.split("?")[0] && calendarFilter === v.action
                : location.pathname + location.search === v.to;
              return (
                <button key={v.label} className={`nav-pinned${active ? " active" : ""}`}
                        onClick={() => {
                          if (active) { if (v.action) setCalendarFilter("all"); navigate(v.to.split("?")[0]); }
                          else { if (v.action) setCalendarFilter(v.action); navigate(v.to); }
                        }}>
                  {v.label}
                </button>
              );
            })}
          </div>
        </nav>
        <NavLink to="/activity" className="sidebar-footer-link">
          Activity log
          {!!unreadActivity && (
            <span className="nav-badge" title={`${unreadActivity} activity log entr${unreadActivity === 1 ? "y" : "ies"} since you last looked`}>
              {unreadActivity}
            </span>
          )}
        </NavLink>
      </aside>

      <div className="app-main">
        {mode === "playground" && (
          <div className="sample-banner" role="status">
            <span>Sample schedule. Changes reset when you refresh — log in with the button in the top-right to use the real schedule.</span>
          </div>
        )}
        <LastUpdateChip />
        <header className="top-bar">
          <TopBreadcrumb />
          <QuickActions />
          <MobileActionMenu />
          <button className="quickfind-trigger" onClick={() => setFindOpen(true)}>
            <span>Find…</span><kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
          </button>
          <div className="mode">
            {mode === "coordinator" ? (
              <>
                <span className="mode-badge saved">Coordinator · changes are saved</span>
                <button className="link-button" onClick={() => logout()}>Log out</button>
              </>
            ) : (
              <>
                <span className="mode-badge" title="Sample data, just for you — refreshing the page starts over">
                  Playground · resets on refresh
                </span>
                <button className="link-button"
                        title={!coordinatorAvailable ? "This server isn't connected to a coordinator database yet, so login will fail." : undefined}
                        onClick={() => setLoginOpen(true)}>
                  Coordinator login{!coordinatorAvailable ? " (unavailable)" : ""}
                </button>
              </>
            )}
          </div>
        </header>
        <main className="page">
          <Outlet />
        </main>
      </div>
      <PanelHost />
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
      {findOpen && <QuickFind onClose={() => setFindOpen(false)} />}
      <ConfirmDialog />
      {toast && (
        <div key={toast.id} className="toast" role="status">
          <span>{toast.message}</span>
          {toast.action && <button className="toast-action" onClick={toast.action.run}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}
