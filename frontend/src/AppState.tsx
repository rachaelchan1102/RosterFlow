import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "./api";

export type Panel =
  | { kind: "show"; id: string }
  | { kind: "musician"; id: string }
  | { kind: "addShow"; date?: string }
  | { kind: "editShow"; id: string }
  | { kind: "musicianForm"; id?: string }
  | { kind: "availability"; id: string }
  | { kind: "cancel"; showId: string; musicianId: string };

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

  panels: Panel[];
  panelTitles: (string | undefined)[];
  setPanelTitle: (index: number, title: string) => void;
  openPanel: (p: Panel) => void;
  backPanel: () => void;
  /** Pop back to a given depth in the stack (used by the breadcrumb). */
  goToPanel: (index: number) => void;
  closePanels: () => void;

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

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("playground");
  const [coordinatorAvailable, setCoordinatorAvailable] = useState(false);
  const [version, setVersion] = useState(0);
  const [needsUpdate, setNeedsUpdate] = useState<string | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [panelTitles, setPanelTitles] = useState<(string | undefined)[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Set<string>>(new Set());
  const [calendarFilter, setCalendarFilter] = useState<CalendarFilter>("all");
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null);
  const confirmResolver = useRef<((ok: boolean) => void) | null>(null);
  const toastId = useRef(0);

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

  const resetView = () => {
    setPanels([]);
    setPanelTitles([]);
    setCalendarFilter("all");
    setCalendarMonth(null);
  };

  const login = async (password: string) => {
    const { token } = await api<{ token: string }>("/api/login", { method: "POST", body: { password } });
    setToken(token);
    setMode("coordinator");
    resetView();
    refresh();
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
        panels, panelTitles, setPanelTitle,
        openPanel: (p) => setPanels((prev) => [...prev, p]),
        backPanel: () => goToPanel(panels.length - 2),
        goToPanel,
        closePanels: () => { setPanels([]); setPanelTitles([]); },
        toast, showToast, confirmRequest, confirm, answerConfirm, removeWithUndo, pendingRemoval,
        calendarFilter, setCalendarFilter, calendarMonth, setCalendarMonth,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
