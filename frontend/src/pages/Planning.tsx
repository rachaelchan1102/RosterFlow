// Result rows are built as arrays of table cells; ResultTable keys each one by position when it
// renders them, so the cells themselves don't need keys.
/* oxlint-disable react/jsx-key */
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { Figure } from "../components/Mark";
import { bookingWindow, isoDate, parseDate } from "../format";
import {
  addDays, dayLabel, gettingThere, minutesOf, rangeLabel, rng, scheduleWindow, siteShort, TIME_OPTIONS,
  WEEKDAYS, weekdayIndex,
} from "../rosterflow";
import type { Facility, Feasibility, ScheduleView, ShowSummary, SlotCollision } from "../types";
import { freeOn, useApi, useFacilities, useHeatmap, useMusicians, useSchedule, useShowDetails, useUtilization } from "../useData";

type ToolId = "date" | "best" | "buffer" | "pianist" | "stress" | "growth";

const TOOLS: { group: string; id: ToolId; label: string }[] = [
  { group: "Check", id: "date", label: "Check a date" },
  { group: "Check", id: "best", label: "Best dates to book" },
  { group: "Resilience", id: "buffer", label: "Buffer sizing" },
  { group: "Resilience", id: "pianist", label: "Pianist risk" },
  { group: "Stress test", id: "stress", label: "More cancellations" },
  { group: "Growth", id: "growth", label: "Demand growth" },
];

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** About one cancellation per show is normal, i.e. roughly 1 in 8 musicians. */
const NORMAL_RATE = 0.125;

// ---------------------------------------------------------------------------------------------
// Shared building blocks

function Select({ label, value, onChange, placeholder, options }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[];
}) {
  return (
    <label className="input">
      <span>{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function RunButton({ ready, busy, onRun }: { ready: boolean; busy?: boolean; onRun: () => void }) {
  return (
    <div className="run-row">
      <button className="button run" disabled={!ready || busy} onClick={onRun}>{busy ? "Running…" : "Run"}</button>
    </div>
  );
}

function Results({ figures, summary, summaryTone, children }: {
  figures: ReactNode; summary?: string; summaryTone?: "warn" | "bad"; children?: ReactNode;
}) {
  return (
    <>
      <div className="tool-figures">{figures}</div>
      {summary && <p className={`tool-summary ${summaryTone ?? ""}`}>{summary}</p>}
      {children}
    </>
  );
}

interface Col { label: string; right?: boolean }
function ResultTable({ title, note, cols, rows }: { title: string; note?: string; cols: Col[]; rows: ReactNode[][] }) {
  return (
    <div className="tool-table">
      <div className="section-head ruled"><h2>{title}</h2>{note && <span className="note">{note}</span>}</div>
      <div className="scroll-x">
        <table className="table">
          <thead><tr>{cols.map((c) => <th key={c.label} className={c.right ? "r" : ""}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className={cols[j]?.right ? "r" : ""}>{cell}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const siteOptions = (facilities: Facility[] | null) =>
  (facilities ?? []).map((f) => ({ value: f.facility_id, label: f.display_name }));

// ---------------------------------------------------------------------------------------------
// Check a date

function DateInput({ value, onChange }: { value: string; onChange: (d: string) => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const { min, max } = bookingWindow();
  const monday = addDays(parseDate(min), -weekdayIndex(min));
  const days = Array.from({ length: 35 }, (_, i) => isoDate(addDays(monday, page * 35 + i)));
  return (
    <label className="input">
      <span>Date</span>
      <div className="picker">
        <button type="button" className={`field picker-field${value ? "" : " placeholder"}`} onClick={() => setOpen(!open)}>
          <span>{value ? dayLabel(value) : "Choose a date"}</span><span className="caret">▾</span>
        </button>
        {open && (
          <>
            <div className="click-away" onClick={() => setOpen(false)} />
            <div className="calendar-pop">
              <div className="calendar-pop-head">
                <button type="button" className="icon-button small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
                <span className="strong">{rangeLabel(days[0], days[34])}, {days[34].slice(0, 4)}</span>
                <button type="button" className="icon-button small" disabled={days[34] >= max} onClick={() => setPage(page + 1)}>›</button>
              </div>
              <div className="calendar-pop-grid">
                {WEEKDAYS.map((w) => <span key={w} className="calendar-pop-wd">{w[0]}</span>)}
                {days.map((d) => {
                  const off = d < min || d > max;
                  return (
                    <button type="button" key={d} disabled={off} className={d === value ? "on" : ""}
                            onClick={() => { onChange(d); setOpen(false); }}>
                      {Number(d.slice(8))}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </label>
  );
}

function CheckDate({ facilities, schedule }: { facilities: Facility[] | null; schedule: ScheduleView | null }) {
  const { data: heatmap } = useHeatmap();
  const { data: musicians } = useMusicians();
  const { data: utilization } = useUtilization();
  const [site, setSite] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ site: string; date: string; time: string; req: Feasibility; alts: Feasibility[] } | null>(null);
  const fac = facilities?.find((f) => f.facility_id === site);
  const usual = fac?.preferred_slot.split(" ")[1];
  // Everyone already playing a show that day, so the table never offers someone who's booked.
  const sameDay = (schedule?.shows ?? []).filter((s) => result && s.date === result.date).map((s) => s.show_id);
  const sameDayDetails = useShowDetails(sameDay);
  const bookedThatDay = new Set([...sameDayDetails.values()].flatMap((d) => d.roster.map((m) => m.musician_id)));

  const run = () => {
    if (!fac) return;
    setBusy(true);
    setError(null);
    api<{ requested: Feasibility; alternatives: Feasibility[] }>("/api/feasibility", {
      method: "POST", body: { facility_id: site, date, start_time: time, duration_min: fac.show_duration_min },
    }).then((r) => setResult({ site, date, time, req: r.requested, alts: r.alternatives }))
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  let body: ReactNode = null;
  if (result) {
    const f = facilities?.find((x) => x.facility_id === result.site);
    const target = f?.target_musicians ?? 0;
    const others = (schedule?.shows ?? []).filter((s) => s.date === result.date && s.facility_id !== result.site
      && Math.abs(minutesOf(s.start_time) - minutesOf(result.time)) < 120);
    const needed = others.reduce((a, s) => a + s.target_musicians, 0);
    const p = result.req.probability_fully_staffed;
    const expected = Math.min(target, Math.round(result.req.mean_available_count));
    const better = result.alts.filter((a) => a.date !== result.date && a.probability_fully_staffed > p + 0.05)
      .sort((a, b) => b.probability_fully_staffed - a.probability_fully_staffed)[0];
    const verdictTone = p >= 0.9 ? undefined : p >= 0.6 ? "warn" as const : "bad" as const;
    const verdict = p >= 0.9 ? "Fills" : p >= 0.6 ? "Likely fills, but tight" : "Won't fill";
    const util = new Map((utilization?.musicians ?? []).map((u) => [u.musician_id, u]));
    const freeIds = freeOn(heatmap, result.date);
    const atCap = (id: string) => (util.get(id)?.utilization ?? 0) >= 1;
    const free = (musicians ?? []).filter((m) => freeIds.has(m.musician_id) && !bookedThatDay.has(m.musician_id))
      .sort((a, b) => Number(atCap(a.musician_id)) - Number(atCap(b.musician_id)) || (util.get(a.musician_id)?.utilization ?? 0) - (util.get(b.musician_id)?.utilization ?? 0));
    body = (
      <Results summary={verdict + (better ? ` · ${dayLabel(better.date)} looks better (${pct(better.probability_fully_staffed)})` : "")}
               summaryTone={verdictTone}
               figures={<>
                 <Figure label="Musicians free" value={result.req.eligible_pool_size}
                         sub={`at ${result.time}, under their cap and not booked elsewhere`} />
                 <Figure label="Needed by other shows" value={needed}
                         sub={others.length ? others.map((s) => siteShort(s.facility_name)).join(", ") : "no other show then"} />
                 <Figure label="Expected fill" value={`${expected} / ${target}`} tone={expected < target ? "bad" : undefined} />
                 <Figure label="Chance of a full lineup" value={pct(p)} tone={verdictTone} />
               </>}>
        <ResultTable title={`Not booked on ${dayLabel(result.date)}`}
                     note={`First 10 of ${free.length} with some free time that day, least busy first`}
                     cols={[{ label: "Name" }, { label: "Instrument" }, { label: "Region" }, { label: "Getting there" }, { label: "Busiest month", right: true }]}
                     rows={free.slice(0, 10).map((m) => {
                       const u = util.get(m.musician_id);
                       return [<span className="strong">{m.display_name}</span>, <span className="ink-2">{m.instrument}</span>,
                               <span className="ink-2">{m.home_region}</span>, <span className="ink-2">{gettingThere(m)}</span>,
                               <span className={`mono ${atCap(m.musician_id) ? "warn" : "ink-2"}`}>
                                 {atCap(m.musician_id) ? "at cap" : u?.month ? `${u.played} of ${u.capacity}` : `0 of ${m.max_shows_per_month}`}
                               </span>];
                     })} />
      </Results>
    );
  }

  return (
    <>
      <h2 className="tool-q">Can this site hold a show on this date?</h2>
      <div className="inputs">
        <Select label="Site" value={site} onChange={setSite} placeholder="Choose a site" options={siteOptions(facilities)} />
        <DateInput value={date} onChange={setDate} />
        <Select label="Start time" value={time} onChange={setTime} placeholder="Choose a time"
                options={TIME_OPTIONS.map((t) => ({ value: t, label: t === usual ? `${t}  (usual)` : t }))} />
      </div>
      <RunButton ready={!!(site && date && time)} busy={busy} onRun={run} />
      {error && <p className="error">{error}</p>}
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Best dates to book

interface BestDay extends Feasibility { full: boolean; mean_travel_km: number }

function BestDates({ facilities }: { facilities: Facility[] | null }) {
  const [site, setSite] = useState("");
  const [weeks, setWeeks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ site: string; weeks: number; days: BestDay[] } | null>(null);

  const run = () => {
    const today = new Date();
    const from = isoDate(addDays(today, 1));
    const to = isoDate(addDays(today, Number(weeks) * 7));
    const months = [...new Set([from.slice(0, 7), to.slice(0, 7)])];
    setBusy(true);
    setError(null);
    Promise.all(months.map((m) => api<{ days: BestDay[] }>(`/api/simulation/best-dates?facility_id=${site}&month=${m}`)))
      .then((rs) => setResult({ site, weeks: Number(weeks),
        days: rs.flatMap((r) => r.days).filter((d) => d.date >= from && d.date <= to) }))
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  let body: ReactNode = null;
  if (result) {
    const f = facilities?.find((x) => x.facility_id === result.site);
    const [usualDay, usualTime] = (f?.preferred_slot ?? " ").split(" ");
    const tier = (p: number) => (p >= 0.9 ? 0 : p >= 0.6 ? 1 : 2);
    const ranked = result.days.filter((d) => !d.full && d.probability_fully_staffed !== null)
      .sort((a, b) => tier(a.probability_fully_staffed) - tier(b.probability_fully_staffed)
        || b.probability_fully_staffed - a.probability_fully_staffed || a.mean_travel_km - b.mean_travel_km);
    const top = ranked[0];
    const fills = ranked.filter((d) => d.probability_fully_staffed >= 0.9).length;
    const usualRank = ranked.findIndex((d) => WEEKDAYS[weekdayIndex(d.date)] === usualDay) + 1;
    const target = f?.target_musicians ?? 0;
    body = !top ? <p className="muted tool-summary">No open days in the next {result.weeks} weeks.</p> : (
      <Results figures={<>
        <Figure label="Best date" value={dayLabel(top.date)}
                sub={`${pct(top.probability_fully_staffed)} chance of a full lineup, ~${Math.round(top.mean_travel_km)} km average travel`} />
        <Figure label="Days that fill fully" value={`${fills} of ${ranked.length}`} sub={`next ${result.weeks} weeks, at ${usualTime}`}
                tone={fills ? undefined : "bad"} />
        <Figure label={`Best ${usualDay} (usual day)`} value={usualRank ? `#${usualRank}` : "none"} sub="in this ranking" />
      </>}>
        <ResultTable title="Top 8 dates" note={`${f?.display_name} · usual slot ${f?.preferred_slot}`}
                     cols={[{ label: "#" }, { label: "Date" }, { label: "Time" }, { label: "Free", right: true },
                            { label: "Expected fill", right: true }, { label: "Full lineup", right: true }, { label: "Avg travel", right: true }]}
                     rows={ranked.slice(0, 8).map((d, k) => {
                       const exp = Math.min(target, Math.round(d.mean_available_count));
                       return [<span className="mono dim">{k + 1}</span>, <span className="strong">{dayLabel(d.date)}</span>,
                               <span className="mono">{usualTime}</span>, <span className="mono">{d.eligible_pool_size}</span>,
                               <span className={`mono ${exp < target ? "bad" : ""}`}>{exp} / {target}</span>,
                               <span className={`mono ${d.probability_fully_staffed < 0.6 ? "bad" : d.probability_fully_staffed < 0.9 ? "warn" : ""}`}>{pct(d.probability_fully_staffed)}</span>,
                               <span className="mono ink-2">~{Math.round(d.mean_travel_km)} km</span>];
                     })} />
      </Results>
    );
  }

  return (
    <>
      <h2 className="tool-q">When should this site book its next show?</h2>
      <div className="inputs">
        <Select label="Site" value={site} onChange={setSite} placeholder="Choose a site" options={siteOptions(facilities)} />
        <Select label="Look ahead" value={weeks} onChange={setWeeks} placeholder="Choose a window"
                options={[2, 4, 6].map((w) => ({ value: String(w), label: `${w} weeks` }))} />
      </div>
      <RunButton ready={!!(site && weeks)} busy={busy} onRun={run} />
      {busy && <p className="small dim">Checking every day in the window. This takes a few seconds.</p>}
      {error && <p className="error">{error}</p>}
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Buffer sizing — a simple dropout model: each booked musician drops with probability p, backups
// (called in order until the show is full) drop a bit more often, since they're asked at short notice.

function simulate(target: number, backups: number, p: number, runs: number, seed: number) {
  const r = rng(seed);
  const hist = new Array(target + 1).fill(0);
  const pb = Math.min(0.9, p * 1.5);
  let short = 0;
  for (let s = 0; s < runs; s++) {
    let present = 0;
    for (let k = 0; k < target; k++) if (r() > p) present++;
    for (let k = 0; k < backups && present < target; k++) if (r() > pb) present++;
    hist[present]++;
    if (present < target) short++;
  }
  return { hist, risk: short / runs };
}

function fewestBackups(target: number, p: number): number | null {
  for (let b = 0; b <= 8; b++) if (simulate(target, b, p, 1000, target * 31 + b).risk < 0.1) return b;
  return null;
}

function BufferSizing({ facilities, schedule }: { facilities: Facility[] | null; schedule: ScheduleView | null }) {
  const [site, setSite] = useState("");
  const [rate, setRate] = useState("");
  const [backups, setBackups] = useState("");
  const [ran, setRan] = useState<{ site: string; p: number; b: number } | null>(null);

  let body: ReactNode = null;
  const f = facilities?.find((x) => x.facility_id === ran?.site);
  if (ran && f) {
    const target = f.target_musicians;
    const sim = simulate(target, ran.b, ran.p, 2000, 7);
    const lo = Math.max(0, target - 7);
    const hs = sim.hist.slice(lo);
    const hm = Math.max(1, ...hs);
    const rec = fewestBackups(target, ran.p);
    const today = isoDate(new Date());
    const nextShow = (id: string) => (schedule?.shows ?? []).filter((s) => s.facility_id === id && s.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    body = (
      <>
        <div className="buffer-result">
          <div>
            <div className="small ink-2 hist-title">Musicians who actually play, across 2,000 simulated shows</div>
            <div className="hist">
              {hs.map((c, k) => {
                const n = k + lo;
                return (
                  <div key={n} className="hist-col">
                    <span className="hist-pct">{c ? `${Math.round((c / 2000) * 100)}%` : ""}</span>
                    <div className={`hist-bar ${n < target - 2 ? "bad" : n < target ? "warn" : ""}`} style={{ height: `${(c / hm) * 100}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="hist-axis">
              {hs.map((_, k) => <span key={k} className={k + lo === target ? "" : "dim"}>{k + lo}</span>)}
            </div>
          </div>
          <div className="buffer-figures">
            <div><div className="small ink-2">Chance of being short</div>
              <div className={`big-number ${sim.risk >= 0.25 ? "bad" : sim.risk >= 0.1 ? "warn" : ""}`}>{pct(sim.risk)}</div></div>
            <div><div className="small ink-2">Fewest backups to stay under 10%</div>
              <div className="mid-number">{rec === null ? "more than 8" : `${rec} backup${rec === 1 ? "" : "s"}`}</div></div>
          </div>
        </div>
        <ResultTable title={`Every site at ${Math.round(ran.p * 100)}% dropout`} note="Backups on each site's next show vs. what the simulation asks for"
                     cols={[{ label: "Site" }, { label: "Has" }, { label: "Needs" }, { label: "", right: true }]}
                     rows={(facilities ?? []).map((l) => {
                       const need = fewestBackups(l.target_musicians, ran.p);
                       const has = nextShow(l.facility_id)?.backup_count;
                       const ok = has !== undefined && need !== null && has >= need;
                       const short = need === null ? 99 : has === undefined ? 0 : need - has;
                       return [<span className="strong">{l.display_name}</span>,
                               <span className="mono ink-2">{has === undefined ? "no show" : `has ${has}`}</span>,
                               <span className="mono">needs {need === null ? "8+" : need}</span>,
                               <span className={ok ? "dim" : short > 1 ? "bad" : "warn"}>
                                 {has === undefined ? "—" : ok ? "Covered" : need === null ? "Not a backup problem" : `Add ${need - has}`}
                               </span>];
                     })} />
      </>
    );
  }

  return (
    <>
      <h2 className="tool-q">How many backups does each show need?</h2>
      <div className="inputs">
        <Select label="Site" value={site} onChange={setSite} placeholder="Choose a site"
                options={(facilities ?? []).map((f) => ({ value: f.facility_id, label: `${f.display_name} · target ${f.target_musicians}` }))} />
        <Select label="Dropout rate per musician" value={rate} onChange={setRate} placeholder="Choose a rate"
                options={[2, 4, 6, 8, 10, 12, 15, 20, 25, 30].map((n) => ({ value: String(n), label: `${n}%` }))} />
        <Select label="Backups" value={backups} onChange={setBackups} placeholder="Choose a number"
                options={[0, 1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />
      </div>
      <RunButton ready={!!(site && rate && backups !== "")} onRun={() => setRan({ site, p: Number(rate) / 100, b: Number(backups) })} />
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Pianist risk

function PianistRisk({ windowShows }: { windowShows: ShowSummary[] }) {
  const [rate, setRate] = useState("");
  const [ran, setRan] = useState<number | null>(null);
  const details = useShowDetails(ran === null ? [] : windowShows.map((s) => s.show_id));

  let body: ReactNode = null;
  if (ran !== null) {
    if (details.size === 0) body = <p className="muted tool-summary">Loading shows…</p>;
    else {
      const p = ran, pb = Math.min(0.9, p * 1.5);
      const rows = windowShows.map((s) => {
        const d = details.get(s.show_id);
        const pianists = d?.roster.filter((m) => m.instrument === "piano").length ?? 0;
        const pianoBackups = d?.backups.filter((b) => b.is_pianist).length ?? 0;
        return { s, pianists, pianoBackups, risk: pianists === 0 ? 1 : p ** pianists * pb ** pianoBackups };
      }).sort((a, b) => b.risk - a.risk);
      const risky = rows.filter((r) => r.risk >= 0.05).length;
      const worst = rows[0];
      const fmt = (r: number) => (r < 0.001 ? "<0.1%" : `${(r * 100).toFixed(1)}%`);
      body = (
        <Results figures={<>
          <Figure label="Shows at 5% risk or more" value={`${risky} of ${rows.length}`} tone={risky ? "warn" : undefined} />
          <Figure label="Highest risk" value={fmt(worst.risk)} tone={worst.risk >= 0.1 ? "bad" : undefined}
                  sub={`${siteShort(worst.s.facility_name)}, ${dayLabel(worst.s.date)}, ${worst.s.start_time}`} />
          <Figure label="No piano backup" value={`${rows.filter((r) => r.pianoBackups === 0).length} shows`} />
        </>}>
          <ResultTable title="Next five weeks" note="Highest risk first"
                       cols={[{ label: "Site" }, { label: "Date and time" }, { label: "Pianists", right: true },
                              { label: "Piano backups", right: true }, { label: "No pianist", right: true }]}
                       rows={rows.map((r) => [
                         <span className="strong">{r.s.facility_name}</span>,
                         <span className="mono ink-2">{dayLabel(r.s.date)}, {r.s.start_time}</span>,
                         <span className="mono">{r.pianists}</span>,
                         <span className={`mono ${r.pianoBackups ? "" : "warn"}`}>{r.pianoBackups}</span>,
                         <span className={`mono ${r.risk >= 0.1 ? "bad" : r.risk >= 0.05 ? "warn" : "ink-2"}`}>{fmt(r.risk)}</span>,
                       ])} />
        </Results>
      );
    }
  }

  return (
    <>
      <h2 className="tool-q">Which shows could end up without a pianist?</h2>
      <div className="inputs">
        <Select label="Dropout rate per pianist" value={rate} onChange={setRate} placeholder="Choose a rate"
                options={[2, 4, 6, 8, 10, 12, 15, 20, 25, 30].map((n) => ({ value: String(n), label: `${n}%` }))} />
      </div>
      <RunButton ready={!!rate} onRun={() => setRan(Number(rate) / 100)} />
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// More cancellations

function simShow(filled: number, target: number, backups: number, p: number, runs: number, seed: number) {
  const r = rng(seed), pb = Math.min(0.9, p * 1.5);
  let short = 0, sum = 0;
  for (let s = 0; s < runs; s++) {
    let present = 0;
    for (let k = 0; k < filled; k++) if (r() > p) present++;
    for (let k = 0; k < backups && present < target; k++) if (r() > pb) present++;
    present = Math.min(target, present);
    sum += present;
    if (present < target) short++;
  }
  return { mean: sum / runs, risk: short / runs };
}

function MoreCancellations({ windowShows }: { windowShows: ShowSummary[] }) {
  const [rate, setRate] = useState("");
  const [ran, setRan] = useState<number | null>(null);

  let body: ReactNode = null;
  if (ran !== null && windowShows.length) {
    const calc = (p: number) => windowShows.map((s, i) => ({ s, ...simShow(s.musician_count, s.target_musicians, s.backup_count, p, 800, i * 13 + 7) }));
    const now = calc(NORMAL_RATE), after = calc(ran);
    const seats = windowShows.reduce((a, s) => a + s.target_musicians, 0);
    const gap = (rs: typeof now) => rs.reduce((a, o) => a + o.s.target_musicians - o.mean, 0);
    const likely = after.filter((o) => o.risk > 0.5).length;
    body = (
      <Results figures={<>
        <Figure label="Unfilled seats" value={pct(gap(after) / seats)} sub={`${pct(gap(now) / seats)} at the normal rate`}
                tone={gap(after) / seats > 0.1 ? "bad" : undefined} />
        <Figure label="Seats short" value={Math.round(gap(after))} sub={`of ${seats} in the next five weeks`} />
        <Figure label="Shows likely short" value={`${likely} of ${windowShows.length}`} sub="short in over half the runs" tone={likely ? "warn" : undefined} />
      </>}>
        <ResultTable title="Next five weeks" note="Most likely to be short first"
                     cols={[{ label: "Site" }, { label: "Date and time" }, { label: "Playing", right: true }, { label: "Backups", right: true },
                            { label: "Expected", right: true }, { label: "Short", right: true }]}
                     rows={[...after].sort((a, b) => b.risk - a.risk).map((o) => [
                       <span className="strong">{o.s.facility_name}</span>,
                       <span className="mono ink-2">{dayLabel(o.s.date)}, {o.s.start_time}</span>,
                       <span className="mono">{o.s.musician_count} / {o.s.target_musicians}</span>,
                       <span className="mono">{o.s.backup_count}</span>,
                       <span className="mono">{o.mean.toFixed(1)}</span>,
                       <span className={`mono ${o.risk > 0.5 ? "bad" : o.risk > 0.2 ? "warn" : "ink-2"}`}>{pct(o.risk)}</span>,
                     ])} />
      </Results>
    );
  }

  return (
    <>
      <h2 className="tool-q">What if more musicians cancel?</h2>
      <div className="inputs">
        <Select label="Cancellation rate" value={rate} onChange={setRate} placeholder="Choose a rate"
                options={[5, 10, 15, 20, 25, 30, 40].map((n) => ({ value: String(n), label: `${n}%` }))} />
      </div>
      <RunButton ready={!!rate} onRun={() => setRan(Number(rate) / 100)} />
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Demand growth

function DemandGrowth({ schedule }: { schedule: ScheduleView | null }) {
  const { data: slots } = useApi<{ slots: SlotCollision[] }>("/api/slot-collisions");
  const { data: musicians } = useMusicians();
  const [growth, setGrowth] = useState("");
  const [cap, setCap] = useState("");
  const [ran, setRan] = useState<{ g: number; cap: number } | null>(null);

  let body: ReactNode = null;
  if (ran && slots && musicians && schedule) {
    const today = new Date();
    const from = isoDate(today), to = isoDate(addDays(today, 28));
    const month = schedule.shows.filter((s) => s.date >= from && s.date < to);
    const showsNow = month.length;
    const seatsNow = month.reduce((a, s) => a + s.target_musicians, 0);
    const seatsAfter = Math.round(seatsNow * (1 + ran.g));
    const supply = musicians.reduce((a, m) => a + m.max_shows_per_month, 0);
    const rows = slots.slots.map((s) => {
      const after = Math.round(s.total_demand * (1 + ran.g));
      return { s, after, head: s.free_pool_size - after };
    });
    const slotShort = rows.reduce((a, r) => a + Math.max(0, -r.head), 0);
    const recruit = Math.max(slotShort, Math.ceil(Math.max(0, seatsAfter * 1.25 - supply) / ran.cap));
    body = (
      <Results figures={<>
        <Figure label="Shows per 4 weeks" value={Math.round(showsNow * (1 + ran.g))} sub={`${showsNow} now`} />
        <Figure label="Seats per 4 weeks" value={seatsAfter} sub={`${seatsNow} now`} />
        <Figure label="Musicians to recruit" value={recruit} sub={`playing ${ran.cap} shows a month each`} tone={recruit ? "warn" : undefined} />
      </>}>
        <ResultTable title="By weekly slot" note="Headroom = free musicians minus seats to fill"
                     cols={[{ label: "Slot" }, { label: "Sites" }, { label: "Target", right: true }, { label: "After", right: true },
                            { label: "Free", right: true }, { label: "Headroom", right: true }]}
                     rows={rows.map((r) => [
                       <span className="mono">{r.s.slot}</span>,
                       <span>{r.s.facilities.map((f) => siteShort(f.name)).join(", ")}</span>,
                       <span className="mono ink-2">{r.s.total_demand}</span>,
                       <span className="mono">{r.after}</span>,
                       <span className="mono">{r.s.free_pool_size}</span>,
                       <span className={`mono ${r.head < 0 ? "bad" : r.head < 3 ? "warn" : "ink-2"}`}>{r.head > 0 ? "+" : ""}{r.head}</span>,
                     ])} />
      </Results>
    );
  }

  return (
    <>
      <h2 className="tool-q">How many musicians do we need to grow?</h2>
      <div className="inputs">
        <Select label="More shows per month" value={growth} onChange={setGrowth} placeholder="Choose an increase"
                options={[10, 25, 50, 75, 100].map((n) => ({ value: String(n), label: `+${n}%` }))} />
        <Select label="New musicians play" value={cap} onChange={setCap} placeholder="Choose shows a month"
                options={[2, 3, 4].map((n) => ({ value: String(n), label: `${n} a month` }))} />
      </div>
      <RunButton ready={!!(growth && cap)} onRun={() => setRan({ g: Number(growth) / 100, cap: Number(cap) })} />
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export default function Planning() {
  const [tool, setTool] = useState<ToolId>("date");
  const { data: facilities } = useFacilities();
  const { data: schedule } = useSchedule();
  const win = useMemo(() => scheduleWindow(0), []);
  const today = isoDate(new Date());
  const windowShows = useMemo(() => (schedule?.shows ?? [])
    .filter((s) => s.date >= today && s.date <= win.end)
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time)), [schedule, today, win.end]);
  const groups = [...new Set(TOOLS.map((t) => t.group))];

  return (
    <div>
      <div className="page-head"><h1>Planning</h1></div>
      <div className="planning">
        <nav className="tool-nav">
          {groups.map((g) => (
            <div key={g} className="tool-group">
              <span className="tool-group-label">{g}</span>
              {TOOLS.filter((t) => t.group === g).map((t) => (
                <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)}>{t.label}</button>
              ))}
            </div>
          ))}
        </nav>
        <div className="tool-body">
          {tool === "date" && <CheckDate facilities={facilities} schedule={schedule} />}
          {tool === "best" && <BestDates facilities={facilities} />}
          {tool === "buffer" && <BufferSizing facilities={facilities} schedule={schedule} />}
          {tool === "pianist" && <PianistRisk windowShows={windowShows} />}
          {tool === "stress" && <MoreCancellations windowShows={windowShows} />}
          {tool === "growth" && <DemandGrowth schedule={schedule} />}
        </div>
      </div>
    </div>
  );
}
