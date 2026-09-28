import { useEffect, useState } from "react";
import { api } from "./api";
import { useApp } from "./AppState";
import type { Facility, Musician, ScheduleView, ShowDetail, UtilizationView } from "./types";

/** Fetches `path` and refetches whenever the app's data version moves (after any edit). */
export function useApi<T>(path: string | null): { data: T | null; error: string | null } {
  const { version } = useApp();
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>(
    { path: null, data: null, error: null });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((data) => { if (live) setState({ path, data, error: null }); })
      .catch((e: Error) => { if (live) setState({ path, data: null, error: e.message }); });
    return () => { live = false; };
  }, [path, version]);
  // A result for a previous path is never shown as if it answered the current one.
  return state.path === path ? { data: state.data, error: state.error } : { data: null, error: null };
}

export const useSchedule = () => useApi<ScheduleView>("/api/schedule");
export const useMusicians = () => useApi<Musician[]>("/api/musicians");
export const useFacilities = () => useApi<Facility[]>("/api/facilities");
export const useUtilization = () => useApi<UtilizationView>("/api/utilization");

export interface Heatmap {
  dates: { date: string; weekday: string; day: number; show_count: number; free_count: number }[];
  rows: { musician_id: string; name: string; instrument: string; hours: number[] }[];
}
export const useHeatmap = () => useApi<Heatmap>("/api/availability-heatmap");

/** Musician ids with any free hours on `date` by their weekly pattern. */
export function freeOn(heatmap: Heatmap | null, date: string): Set<string> {
  const i = heatmap?.dates.findIndex((d) => d.date === date) ?? -1;
  if (!heatmap || i < 0) return new Set();
  return new Set(heatmap.rows.filter((r) => r.hours[i] > 0).map((r) => r.musician_id));
}

/** Detail for several shows at once, keyed by show id. */
export function useShowDetails(ids: string[]): Map<string, ShowDetail> {
  const { version } = useApp();
  const key = ids.join(",");
  const [state, setState] = useState<{ key: string; map: Map<string, ShowDetail> }>({ key: "", map: new Map() });
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(key.split(",").map((id) => api<ShowDetail>(`/api/shows/${id}/detail`).catch(() => null)))
      .then((list) => {
        if (!live) return;
        const map = new Map<string, ShowDetail>();
        list.forEach((d) => { if (d) map.set(d.show_id, d); });
        setState({ key, map });
      });
    return () => { live = false; };
  }, [key, version]);
  return state.key === key ? state.map : new Map();
}
