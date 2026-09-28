import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { api, getToken, setToken } from "./api";
import type { Change } from "./types";

export type Panel =
  | { kind: "show"; id: string }
  | { kind: "musician"; id: string }
  | { kind: "addShow"; date?: string; facilityId?: string }
  | { kind: "editShow"; id: string }
  | { kind: "musicianForm"; id?: string }
  | { kind: "bulkImportMusicians" }
  | { kind: "facilityForm"; id?: string }
  | { kind: "availability"; id: string }
  | { kind: "cancel"; showId?: string; musicianId?: string }
  | { kind: "updateSummary"; changes: Change[] };

type Mode = "playground" | "coordinator";
export type CalendarFilter = "all" | "week" | "amber" | "red";

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** Replaces the default "You'll have a few seconds to undo" hint line. */
  hint?: string;
}

interface AppState {
  mode: Mode;
  coordinatorAvailable: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Bumped after every change; pages refetch when it moves. */
  version: number;
  refresh: () => void;
  /** Why the schedule is out of date (shown as a dot on the Calendar tab from any page), or null. */
  needsUpdate: string | null;
  /** What the most recent "Update schedule" run changed, kept until dismissed or replaced by the
   *  next update — a toast alone would vanish before a coordinator on a different page than the
   *  one they triggered the update from ever saw it. A persistent chip in the top bar (Layout)
   *  reads this and stays up so "what changed" is always reachable, not just momentarily shown. */
  lastUpdateChanges: Change[] | null;
  setLastUpdateChanges: (changes: Change[] | null) => void;

  panels: Panel[];
  panelTitles: (string | undefined)[];
  setPanelTitle: (index: number, title: string) => void;
  openPanel: (p: Panel) => void;
  backPanel: () => void;
  /** Pop back to a given depth in the stack (used by the breadcrumb). */
  goToPanel: (index: number) => void;
  /** Closes the whole panel stack. Asks for confirmation first if a form has unsaved edits. */
  closePanels: () => void;
  /** Whether the form in the topmost panel has unsaved edits. Set by the form itself. */
  panelDirty: boolean;
  setPanelDirty: (dirty: boolean) => void;

  toast: Toast | null;
  showToast: (message: string, action?: Toast["action"]) => void;
  confirmRequest: ConfirmRequest | null;
  /** In-app replacement for window.confirm. */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  answerConfirm: (ok: boolean) => void;
  /** Hide something straight away, offer Undo for a few seconds, then really delete it. */
  removeWithUndo: (keys: string[], message: string, commit: () => Promise<unknown>) => void;
  /** Keys ("musician:M01", "show:S0001") hidden while their Undo window is open. */
  pendingRemoval: Set<string>;

  // Calendar view state lives here so it survives switching tabs.
  calendarFilter: CalendarFilter;
  setCalendarFilter: (f: CalendarFilter) => void;
  calendarMonth: string | null;
  setCalendarMonth: (m: string | null) => void;

  /** How many activity-log entries have happened since this browser last looked at the feed or
   *  the Activity page — the sidebar's notification badge. A per-viewer convenience (localStorage),
   *  not shared state: it just remembers where THIS browser left off reading. */
  unreadActivity: number;
  markActivitySeen: () => void;
}

const UNDO_MS = 5000;
const TOAST_MS = 3500;

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

/** Which depth of the panel stack a component is rendered at (set by PanelHost). */
export const PanelIndexContext = createContext<number>(-1);

/** Lets a panel name itself for the breadcrumb ("Location 4 → Musician 27"). */
export function usePanelTitle(title: string | null | undefined) {
  const index = useContext(PanelIndexContext);
  const { setPanelTitle } = useApp();
  useEffect(() => {
    if (index >= 0 && title) setPanelTitle(index, title);
  }, [index, title, setPanelTitle]);
}

/** Marks the panel dirty on every change to `value` AFTER `ready` first becomes true — but not
 *  the change that makes it become true. A form's data-loading effect setting its state to the
 *  fetched record (or to computed defaults for a new record) is, from React's point of view, a
 *  "change" indistinguishable from the user editing a field — treating it as one meant every
 *  edit/availability panel asked "Discard unsaved changes?" on a close where nothing had
 *  actually been touched yet. */
export function useDirtyOnChange(value: unknown, ready: boolean) {
  const { setPanelDirty } = useApp();
  const started = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!started.current) { started.current = true; return; }
    setPanelDirty(true);
  }, [value, ready, setPanelDirty]);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("playground");
  const [coordinatorAvailable, setCoordinatorAvailable] = useState(false);
  const [version, setVersion] = useState(0);
  const [needsUpdate, setNeedsUpdate] = useState<string | null>(null);
  const [lastUpdateChanges, setLastUpdateChanges] = useState<Change[] | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [panelTitles, setPanelTitles] = useState<(string | undefined)[]>([]);
  const [panelDirty, setPanelDirtyState] = useState(false);
  const location = useLocation();
  // A panel is scoped to whatever page opened it (a musician, a show) — the side panel itself
  // stays mounted across route changes since Layout wraps every route, so without this, an open
  // panel would keep floating over a page it has nothing to do with, and a fresh "+ Add ___" on
  // that new page would stack onto its now-unrelated breadcrumb instead of starting clean.
  useEffect(() => {
    setPanels([]);
    setPanelTitles([]);
  }, [location.pathname]);
  // guardDirty (below) needs the up-to-the-moment value, not the one closed over at last render:
  // a caller that does `setPanelDirty(false); backPanel();` in the same tick would otherwise have
  // backPanel's guard still see the stale "dirty" from before that call, since the state update
  // hasn't been applied yet — exactly the save-then-close sequence every form here uses.
  const panelDirtyRef = useRef(false);
  const setPanelDirty = useCallback((d: boolean) => { panelDirtyRef.current = d; setPanelDirtyState(d); }, []);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Set<string>>(new Set());
  const [calendarFilter, setCalendarFilter] = useState<CalendarFilter>("all");
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null);
  const [unreadActivity, setUnreadActivity] = useState(0);
  const confirmResolver = useRef<((ok: boolean) => void) | null>(null);
  const toastId = useRef(0);
  const lastSeenActivity = useRef(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const loadSession = useCallback(() => {
    api<{ mode: Mode; coordinator_available: boolean }>("/api/session").then((s) => {
      setMode(s.mode);
      setCoordinatorAvailable(s.coordinator_available);
    });
  }, []);

  useEffect(() => {
    loadSession();
    const onExpired = () => {
      setMode("playground");
      setPanels([]);
      refresh();
    };
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, [loadSession, refresh]);

  useEffect(() => {
    api<{ needs_update: string | null }>("/api/schedule/status")
      .then((s) => setNeedsUpdate(s.needs_update))
      .catch(() => setNeedsUpdate(null));
  }, [version, mode]);

  const latestActivityId = useRef(0);
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem("lastSeenActivityId") ?? "0");
      if (Number.isFinite(stored)) lastSeenActivity.current = stored;
    } catch { /* private window / blocked storage — unread just starts at 0 */ }
  }, []);
  useEffect(() => {
    api<{ id: number }[]>("/api/activity").then((entries) => {
      latestActivityId.current = entries[0]?.id ?? 0;   // newest first
      setUnreadActivity(entries.filter((e) => e.id > lastSeenActivity.current).length);
    }).catch(() => setUnreadActivity(0));
  }, [version, mode]);

  const markActivitySeen = useCallback(() => {
    lastSeenActivity.current = latestActivityId.current;
    try { localStorage.setItem("lastSeenActivityId", String(latestActivityId.current)); } catch { /* fine */ }
    setUnreadActivity(0);
  }, []);

  const resetView = () => {
    setPanels([]);
    setPanelTitles([]);
    setCalendarFilter("all");
    setCalendarMonth(null);
    setLastUpdateChanges(null);
  };

  const login = async (password: string) => {
    const { token, loaded } = await api<{ token: string; loaded: { musicians: number; facilities: number; upcoming_shows: number } }>(
      "/api/login", { method: "POST", body: { password } });
    setToken(token);
    setMode("coordinator");
    resetView();
    refresh();
    showToast(`Logged in to the real schedule: ${loaded.musicians} musicians, ${loaded.facilities} locations, `
             + `${loaded.upcoming_shows} upcoming show${loaded.upcoming_shows !== 1 ? "s" : ""} loaded.`);
  };

  const logout = async () => {
    if (getToken()) await api("/api/logout", { method: "POST" }).catch(() => undefined);
    setToken(null);
    setMode("playground");
    resetView();
    refresh();
  };

  const showToast = useCallback((message: string, action?: Toast["action"]) => {
    const id = ++toastId.current;
    setToast({ id, message, action });
    window.setTimeout(() => setToast((current) => (current?.id === id ? null : current)),
                      action ? UNDO_MS : TOAST_MS);
  }, []);

  const confirm = useCallback((req: ConfirmRequest) => new Promise<boolean>((resolve) => {
    confirmResolver.current = resolve;
    setConfirmRequest(req);
  }), []);

  const answerConfirm = (ok: boolean) => {
    confirmResolver.current?.(ok);
    confirmResolver.current = null;
    setConfirmRequest(null);
  };

  /** Runs `action` immediately, unless the open form has unsaved edits, in which case it asks first. */
  const guardDirty = useCallback(async (action: () => void) => {
    if (panelDirtyRef.current) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        body: "Closing now will lose what you've entered here.",
        confirmLabel: "Discard changes",
        hint: "There's no undo for this — you'll need to re-enter it.",
      });
      if (!ok) return;
    }
    setPanelDirty(false);
    action();
  }, [confirm, setPanelDirty]);

  const removeWithUndo = useCallback((keys: string[], message: string, commit: () => Promise<unknown>) => {
    const hide = (on: boolean) => setPendingRemoval((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
      return next;
    });
    hide(true);
    let undone = false;
    const timer = window.setTimeout(() => {
      if (undone) return;
      commit()
        // Stay hidden until the refetch (triggered by refresh) has replaced the list, so the
        // row doesn't flash back for a moment before disappearing for good.
        .then(() => { refresh(); window.setTimeout(() => hide(false), 2000); })
        .catch((e: Error) => { hide(false); showToast(`Couldn't remove: ${e.message}`); });
    }, UNDO_MS);
    showToast(message, {
      label: "Undo",
      run: () => {
        undone = true;
        window.clearTimeout(timer);
        hide(false);
        setToast(null);
      },
    });
  }, [refresh, showToast]);

  const setPanelTitle = useCallback((index: number, title: string) => {
    setPanelTitles((prev) => {
      if (prev[index] === title) return prev;
      const next = [...prev];
      next[index] = title;
      return next;
    });
  }, []);

  const goToPanel = (index: number) => {
    setPanels((prev) => prev.slice(0, index + 1));
    setPanelTitles((prev) => prev.slice(0, index + 1));
  };

  return (
    <AppContext.Provider
      value={{
        mode, coordinatorAvailable, login, logout, version, refresh, needsUpdate,
        lastUpdateChanges, setLastUpdateChanges,
        panels, panelTitles, setPanelTitle,
        panelDirty, setPanelDirty,
        openPanel: (p) => { setPanelDirty(false); setPanels((prev) => [...prev, p]); },
        backPanel: () => guardDirty(() => goToPanel(panels.length - 2)),
        goToPanel: (index) => guardDirty(() => goToPanel(index)),
        closePanels: () => guardDirty(() => { setPanels([]); setPanelTitles([]); }),
        toast, showToast, confirmRequest, confirm, answerConfirm, removeWithUndo, pendingRemoval,
        calendarFilter, setCalendarFilter, calendarMonth, setCalendarMonth,
        unreadActivity, markActivitySeen,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
