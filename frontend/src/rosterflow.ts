import { isoDate, parseDate } from "./format";
import type { Musician, ShowSummary } from "./types";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The four states every show marker uses, on every page:
 *  ok — at target with 2+ backups; thin — at target but fewer than 2 backups;
 *  short — below target (headcount, songs, or no pianist); none — below target with no backups. */
export type Tone = "ok" | "thin" | "short" | "none";

export const TONE_LABEL: Record<Tone, string> = {
  ok: "On track", thin: "Thin on backups", short: "Below target", none: "No backups left",
};

export function tone(count: number, target: number, backups: number, otherwiseShort = false): Tone {
  const short = count < target || otherwiseShort;
  if (short) return backups === 0 ? "none" : "short";
  return backups < 2 ? "thin" : "ok";
}

export function showTone(s: ShowSummary): Tone {
  return tone(s.musician_count, s.target_musicians, s.backup_count,
              !s.has_pianist || s.songs_total < s.songs_target);
}

const TONE_RANK: Record<Tone, number> = { ok: 0, thin: 1, short: 2, none: 3 };
export function worstTone(tones: Tone[]): Tone {
  return tones.reduce<Tone>((a, t) => (TONE_RANK[t] > TONE_RANK[a] ? t : a), "ok");
}

/** "Harbourview Senior Living" → "HAR" — a calendar chip only has room for a code. */
export function siteCode(name: string): string {
  return name.replace(/[^A-Za-z ]/g, "").split(" ")[0].slice(0, 3).toUpperCase();
}

const GENERIC = new Set(["care", "home", "senior", "living", "long-term", "retirement", "residence", "veterans", "wing",
  "centre", "center", "manor", "lodge", "house"]);

/** "Maple Grove Care Home" → "Maple Grove", "Riverside Gardens Care Centre" → "Riverside Gardens":
 *  the name without the words every care home shares. Falls back to the first word. */
export function siteName(name: string): string {
  const words = name.split(" ");
  const cut = words.findIndex((w, i) => i > 0 && GENERIC.has(w.toLowerCase()));
  return (cut > 0 ? words.slice(0, cut) : words.slice(0, 1)).join(" ");
}

/** "Harbourview Senior Living" → "Harbourview". */
export function siteShort(name: string): string {
  return name.split(" ")[0];
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Monday-first weekday index, 0 = Mon … 6 = Sun. */
export function weekdayIndex(iso: string): number {
  return (parseDate(iso).getDay() + 6) % 7;
}

/** "Sep 28" */
export function shortDate(iso: string): string {
  const d = parseDate(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Tue Oct 6" */
export function dayLabel(iso: string): string {
  return `${WEEKDAYS[weekdayIndex(iso)]} ${shortDate(iso)}`;
}

/** "Tue, Oct 6" */
export function dayLabelComma(iso: string): string {
  return `${WEEKDAYS[weekdayIndex(iso)]}, ${shortDate(iso)}`;
}

export function weekdayLong(iso: string): string {
  return WEEKDAY_LONG[weekdayIndex(iso)];
}

export const WEEKS_SHOWN = 5;

/** The five-week, Monday-first window the Schedule page shows. It starts on the Monday of the week
 *  containing tomorrow, so a Sunday opens on the week ahead rather than a week that's all but over.
 *  `page` moves it a whole window at a time. */
export function scheduleWindow(page = 0, today = new Date()): { days: string[]; start: string; end: string } {
  const tomorrow = addDays(today, 1);
  const monday = addDays(tomorrow, -((tomorrow.getDay() + 6) % 7) + page * WEEKS_SHOWN * 7);
  const days = Array.from({ length: WEEKS_SHOWN * 7 }, (_, i) => isoDate(addDays(monday, i)));
  return { days, start: days[0], end: days[days.length - 1] };
}

export function rangeLabel(start: string, end: string): string {
  return `${shortDate(start)} – ${shortDate(end)}`;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How someone gets to a show, in the roster's words. */
export function gettingThere(m: Pick<Musician, "age" | "transport" | "can_drive">): string {
  if (m.age < 17 || m.transport === "guardian") return "Guardian drives";
  if (m.transport === "car") return m.can_drive ? "Drives, has seats" : "Drives alone";
  return "Transit";
}

export const TIME_OPTIONS = (() => {
  const out: string[] = [];
  for (let m = 9 * 60; m <= 20 * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 ? "30" : "00"}`);
  }
  return out;
})();

export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Small deterministic PRNG so a simulation gives the same answer for the same inputs. */
export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
