import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "./AppState";
import mascot from "./assets/mascot.png";
import PanelHost from "./components/PanelHost";
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
          Logging in switches to the real, saved schedule. The sample data you're in now resets every time you refresh.
        </p>
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

const NAV = [
  { to: "/schedule", label: "Schedule" },
  { to: "/sites", label: "Sites & travel" },
  { to: "/musicians", label: "Musicians" },
  { to: "/planning", label: "Planning" },
  { to: "/activity", label: "Activity" },
];

export default function Layout() {
  const { mode, coordinatorAvailable, logout, toast } = useApp();
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={mascot} alt="" className="brand-mascot" />
          <div>
            <div className="brand-name">RosterFlow</div>
            <div className="brand-sub">Music for the Golden Age</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to}>{n.label}</NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          {mode === "coordinator" ? (
            <>
              <span>Coordinator. Changes are saved.</span>
              <button className="foot-link" onClick={() => logout()}>Log out</button>
            </>
          ) : (
            <>
              <span>Sample data. Changes reset when you refresh.</span>
              {coordinatorAvailable
                ? <button className="foot-link" onClick={() => setLoginOpen(true)}>Coordinator login</button>
                : <span className="foot-strong">Coordinator login unavailable</span>}
            </>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          <Outlet />
        </div>
      </main>
      <PanelHost />
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
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
