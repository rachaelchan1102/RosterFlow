const DATE_FMT = new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric" });
const MONTH_FMT = new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric" });

/** "2026-10-03" → a local Date at midnight (not UTC, which would shift the day west of Greenwich). */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDate(iso: string): string {
  return DATE_FMT.format(parseDate(iso));
}

export function formatMonth(yyyyMm: string): string {
  return MONTH_FMT.format(parseDate(`${yyyyMm}-01`));
}

/** A show's start time minus the location's own load-in buffer — "18:30" minus 20 min is "18:10". */
export function arrivalTime(startTime: string, bufferMin: number): string {
  const [h, m] = startTime.split(":").map(Number);
  const total = ((h * 60 + m - bufferMin) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

const TENURE_MONTH_FMT = new Intl.DateTimeFormat("en-CA", { month: "short", year: "numeric" });

/** "0.2 years with the org" reads as a strange fraction for anyone who joined this year — there's
 *  no exact join date stored, only a years-with-org figure, so under a year this approximates a
 *  join month from it ("since Aug 2026") instead of showing the raw fraction. */
export function tenureLabel(years: number): string {
  if (years >= 1) return `${years === Math.round(years) ? years : years.toFixed(1)} ${years === 1 ? "year" : "years"} with the org`;
  const joined = new Date();
  joined.setDate(joined.getDate() - Math.round(years * 365));
  return `since ${TENURE_MONTH_FMT.format(joined)}`;
}

/** How far out a new show can be booked, in days — matches the backend's rolling window
 *  (optimizer/data.py's BOOKING_HORIZON_DAYS). It's computed from "today" fresh on every call,
 *  so the window itself rolls forward automatically: no fixed end date to update by hand, and
 *  no extra slots to "open" each week — the ceiling just keeps recomputing as today moves. */
export const BOOKING_HORIZON_DAYS = 120;

/** [today, today + horizon] as ISO date strings, for a date input's min/max. */
export function bookingWindow(): { min: string; max: string } {
  const today = new Date();
  const horizon = new Date(today.getTime() + BOOKING_HORIZON_DAYS * 86_400_000);
  return { min: isoDate(today), max: isoDate(horizon) };
}

/** "2 min ago" / "3 hr ago" / "Sep 20" — an ISO timestamp as a feed reads it, not a raw date. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day !== 1 ? "s" : ""} ago`;
  return DATE_FMT.format(new Date(iso));
}
