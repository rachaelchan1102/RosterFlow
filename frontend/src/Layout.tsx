import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "./AppState";
import { formatDate, isoDate } from "./format";
import mascot from "./assets/mascot.png";
import PanelHost from "./components/PanelHost";
import { useFocusTrap } from "./useFocusTrap";

const NAME_KEY = "coordinatorName";

function LoginDialog({ onClose }: { onClose: () => void }) {
  const { login } = useApp();
  const [name, setName] = useState(() => {
    try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
  });
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrongTries, setWrongTries] = useState(0);   // re-keys the mascot so it wiggles on every miss
  const trapRef = useFocusTrap<HTMLFormElement>(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { localStorage.setItem(NAME_KEY, name.trim()); } catch { /* just won't be prefilled next time */ }
    login(name, password).then(onClose).catch((err) => {
      setError(err.message);
      setPassword("");
      setWrongTries((n) => n + 1);
    }).finally(() => setBusy(false));
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form ref={trapRef} tabIndex={-1} className="modal login" aria-labelledby="login-title"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <img key={wrongTries} src={mascot} alt="" className={`login-mascot${wrongTries ? " wiggle" : ""}`} />
        <div className="login-head">
          <span className="login-kicker">Music for the Golden Age</span>
          <h2 id="login-title">Are you part of the team?</h2>
          <p className="muted">
            Log in with the team password to see and edit the real schedule.
          </p>
        </div>
        <label>Your name
          {/* autoComplete="username" so a password manager files the team password under this name. */}
          <input type="text" name="username" autoComplete="username" maxLength={40} autoFocus={!name}
                 value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>Team password
          <span className="password-field">
            <input type={showPassword ? "text" : "password"} name="password" autoComplete="current-password"
                   autoFocus={!!name} value={password} onChange={(e) => setPassword(e.target.value)}
                   aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} />
            <button type="button" className="foot-link" onClick={() => setShowPassword((v) => !v)}
                    aria-pressed={showPassword}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </span>
        </label>
        {error && <p id="login-error" className="error small" role="alert">{error}</p>}
        <button className="button wide" type="submit" disabled={busy || !password || !name.trim()}>
          {busy ? "Checking…" : "Log in"}
        </button>
        <button className="login-skip" type="button" onClick={onClose}>
          Not on the team? Keep exploring the sample schedule
        </button>
        <p className="login-fine">You'll stay logged in on this device for 30 days.</p>
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
  const { mode, coordinatorAvailable, loginExpiresAt, loginName, logout, logoutEverywhere, confirm, showToast, toast } = useApp();
  const [loginOpen, setLoginOpen] = useState(false);

  const endAllLogins = async () => {
    const ok = await confirm({
      title: "Log out on every device?",
      body: "Everyone logged in to the real schedule, on any computer or phone, including you here, "
          + "will need the shared password again. Use this if a device was lost or someone shouldn't have access anymore.",
      confirmLabel: "Log out everywhere",
      hint: "Nothing in the schedule changes. If the password itself got out, change COORDINATOR_PASSWORD on the server too.",
    });
    if (ok) logoutEverywhere().catch((e: Error) => showToast(`Couldn't log out everywhere: ${e.message}`));
  };

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
              <span className="foot-strong">{loginName ? `Logged in as ${loginName}` : "Coordinator"}. Changes are saved.</span>
              {loginExpiresAt && <span>Logged in until {formatDate(isoDate(new Date(loginExpiresAt)))}</span>}
              <span className="foot-actions">
                <button className="foot-link" onClick={() => logout()}>Log out</button>
                <button className="foot-link" onClick={endAllLogins}>Log out everywhere</button>
              </span>
            </>
          ) : (
            <>
              <span>Sample data. Changes reset when you refresh.</span>
              {coordinatorAvailable
                ? <button className="foot-link" onClick={() => setLoginOpen(true)}>Coordinator login</button>
                : <span className="foot-strong" title="This server isn't connected to a coordinator database, so only sample data is available here.">
                    Coordinator login unavailable
                  </span>}
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
