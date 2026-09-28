import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp, useDirtyOnChange, usePanelTitle } from "../AppState";
import { updateNowAction } from "../scheduleUpdate";
import type { MusicianProfile } from "../types";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const START_HOUR = 9;
const END_HOUR = 21;   // exclusive — last slot is 20:30-21:00
// Half-hour granularity — a show's usual 18:30 start (or a "Tue 12:30-17:00" window like Harper
// Osei's) used to get floored to the nearest whole hour on both read and write, silently losing
// or shifting 30 minutes every time the grid round-tripped through it.
const SLOTS_PER_HOUR = 2;
const SLOT_COUNT = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);

interface Window {
  weekday: string;
  start_time: string;
  end_time: string;
}

function slotLabel(slot: number): string {
  const h = START_HOUR + Math.floor(slot / SLOTS_PER_HOUR);
  const m = (slot % SLOTS_PER_HOUR) * 30;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToSlot(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h - START_HOUR) * SLOTS_PER_HOUR + (m >= 30 ? 1 : 0);
}

function toGrid(windows: Window[]): boolean[][] {
  const grid = DAYS.map(() => Array.from({ length: SLOT_COUNT }, () => false));
  for (const w of windows) {
    const dayIdx = DAYS.indexOf(w.weekday);
    if (dayIdx === -1) continue;
    const start = timeToSlot(w.start_time);
    const end = timeToSlot(w.end_time);
    for (let s = Math.max(start, 0); s < Math.min(end, SLOT_COUNT); s++) {
      grid[dayIdx][s] = true;
    }
  }
  return grid;
}

function toWindows(grid: boolean[][]): Window[] {
  const windows: Window[] = [];
  grid.forEach((row, dayIdx) => {
    let blockStart: number | null = null;
    row.forEach((on, i) => {
      if (on && blockStart === null) blockStart = i;
      if (!on && blockStart !== null) {
        windows.push({ weekday: DAYS[dayIdx], start_time: slotLabel(blockStart), end_time: slotLabel(i) });
        blockStart = null;
      }
    });
    if (blockStart !== null) {
      windows.push({ weekday: DAYS[dayIdx], start_time: slotLabel(blockStart), end_time: slotLabel(SLOT_COUNT) });
    }
  });
  return windows;
}

export default function AvailabilityGrid({ musicianId }: { musicianId: string }) {
  const { refresh, backPanel, showToast, setPanelDirty, setLastUpdateChanges } = useApp();
  const [grid, setGrid] = useState<boolean[][] | null>(null);
  const [painting, setPainting] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [name, setName] = useState("");
  usePanelTitle("Weekly availability");
  const usedPointer = useRef(false);

  useEffect(() => {
    api<Window[]>(`/api/musicians/${musicianId}/availability`).then((windows) => { setGrid(toGrid(windows)); setLoaded(true); });
    api<MusicianProfile>(`/api/musicians/${musicianId}/profile`).then((p) => setName(p.name)).catch(() => {});
  }, [musicianId]);

  useDirtyOnChange(grid, loaded);

  if (!grid) return <p className="muted">Loading availability…</p>;

  const totalHours = grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0) / SLOTS_PER_HOUR;

  const setCell = (day: number, hour: number, value: boolean) => {
    setGrid((prev) => {
      const next = prev!.map((row) => [...row]);
      next[day][hour] = value;
      return next;
    });
  };

  const toggleDay = (day: number) => {
    const allOn = grid[day].every(Boolean);
    setGrid((prev) => {
      const next = prev!.map((row) => [...row]);
      next[day] = next[day].map(() => !allOn);
      return next;
    });
  };

  const save = () => {
    setSaving(true);
    setError(null);
    api(`/api/musicians/${musicianId}/availability`, { method: "PUT", body: toWindows(grid) })
      .then(() => {
        setPanelDirty(false);
        showToast("Availability saved. The schedule needs updating to reflect this.", updateNowAction(refresh, showToast, setLastUpdateChanges));
        refresh();
        backPanel();
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="panel-body" onMouseUp={() => setPainting(null)} onMouseLeave={() => setPainting(null)}>
      <div className="panel-title">
        <h2>Weekly availability{name ? ` · ${name}` : ""}</h2>
        <p className="muted small">Select hours to mark when this musician is usually available. A day's name fills or clears the whole day.</p>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="availability-grid" style={{ gridTemplateColumns: `60px repeat(${SLOT_COUNT}, 1fr)` }}>
        <div />
        {HOURS.map((h) => (
          <div key={h} className="grid-hour-label" style={{ gridColumn: `span ${SLOTS_PER_HOUR}` }}>{h}</div>
        ))}
        {DAYS.map((day, dayIdx) => (
          <Fragment key={day}>
            <button className="grid-day-label" onClick={() => toggleDay(dayIdx)}
                    aria-label={`${grid[dayIdx].every(Boolean) ? "Clear" : "Fill"} all of ${day}`}>
              {day}
            </button>
            {Array.from({ length: SLOT_COUNT }, (_, slot) => {
              const on = grid[dayIdx][slot];
              return (
                <button
                  key={`${day}-${slot}`}
                  type="button"
                  className={`grid-cell ${on ? "on" : ""} ${slot % SLOTS_PER_HOUR === 0 ? "hour-start" : ""}`}
                  aria-pressed={on}
                  aria-label={`${day} ${slotLabel(slot)}–${slotLabel(slot + 1)}, ${on ? "available" : "not available"}`}
                  onMouseDown={() => { usedPointer.current = true; const v = !on; setPainting(v); setCell(dayIdx, slot, v); }}
                  onMouseEnter={() => { if (painting !== null) setCell(dayIdx, slot, painting); }}
                  onClick={() => {
                    if (usedPointer.current) { usedPointer.current = false; return; }
                    setCell(dayIdx, slot, !on);   // keyboard activation (Enter/Space)
                  }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <p className="small muted">{totalHours} hour{totalHours !== 1 ? "s" : ""} marked available this week.</p>
      <div className="panel-footer">
        <button className="button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save availability"}</button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
