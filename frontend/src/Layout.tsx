import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "./AppState";
import PanelHost from "./components/PanelHost";
import QuickFind from "./components/QuickFind";

function LoginDialog({ onClose }: { onClose: () => void }) {
  const { login, coordinatorAvailable } = useApp();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    login(password).then(onClose).catch((err) => setError(err.message)).finally(() => setBusy(false));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Coordinator login</h2>
        <p className="muted small">
          Logging in switches to the real, saved schedule. The playground you're in now is sample data
          that resets every time you refresh.
        </p>
        {!coordinatorAvailable && (
          <p className="callout amber small">This server isn't connected to a coordinator database yet, so login will fail.</p>
        )}
        <label>Password
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="panel-footer">
          <button className="button" type="submit" disabled={busy || !password}>{busy ? "Checking…" : "Log in"}</button>
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** In-app stand-in for window.confirm, so deleting things looks like the rest of the app. */
function ConfirmDialog() {
  const { confirmRequest, answerConfirm } = useApp();
  useEffect(() => {
    if (!confirmRequest) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") answerConfirm(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRequest, answerConfirm]);
  if (!confirmRequest) return null;
  return (
    <div className="modal-scrim" onClick={() => answerConfirm(false)}>
      <div className="modal confirm" role="alertdialog" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{confirmRequest.title}</h2>
        <p className="muted">{confirmRequest.body}</p>
        <p className="small muted">You'll have a few seconds to undo.</p>
        <div className="panel-footer">
          <button className="button danger-fill" autoFocus onClick={() => answerConfirm(true)}>{confirmRequest.confirmLabel}</button>
          <button className="button secondary" onClick={() => answerConfirm(false)}>Keep it</button>
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const { mode, logout, toast, needsUpdate } = useApp();
  const [loginOpen, setLoginOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

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
    <div className="app">
      <header className="top-bar">
        <div className="brand">Music for the Golden Age · Scheduling</div>
        <nav className="top-nav">
          <NavLink to="/" end title={needsUpdate ? `Schedule needs updating: ${needsUpdate}` : undefined}>
            Calendar{needsUpdate && <span className="nav-dot" aria-label="schedule needs updating" />}
          </NavLink>
          <NavLink to="/cancel">Cancellations</NavLink>
          <NavLink to="/tools">Roster</NavLink>
          <NavLink to="/scenario">Scenario planner</NavLink>
        </nav>
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
              <button className="link-button" onClick={() => setLoginOpen(true)}>Coordinator login</button>
            </>
          )}
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
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
