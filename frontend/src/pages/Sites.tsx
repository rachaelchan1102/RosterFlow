import { useMemo, useState } from "react";
import { Mark } from "../components/Mark";
import NetworkMap from "../components/NetworkMap";
import { isoDate, parseDate } from "../format";
import { dayLabel, plural, shortDate, showTone, siteShort, TONE_LABEL, weekdayIndex, worstTone } from "../rosterflow";
import type { NetworkView, ShowSummary, SlotCollision } from "../types";
import { useApi, useMusicians, useSchedule, useShowDetails } from "../useData";

const WEEKDAY_NAMES: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

function weekOf(iso: string): string {
  const d = parseDate(iso);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `Week of ${shortDate(isoDate(monday))}`;
}

function DatePicker({ dates, showsOn, value, onChange }: {
  dates: string[]; showsOn: (d: string) => ShowSummary[]; value: string; onChange: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const today = showsOn(value);
  return (
    <div className="picker">
      <button className="picker-button" onClick={() => setOpen(!open)}>
        <span className="strong">{dayLabel(value)}</span>
        <span className="small dim">{plural(today.length, "show")} · {[...new Set(today.map((s) => s.start_time))].join(", ")}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="click-away" onClick={() => setOpen(false)} />
          <div className="picker-menu">
            {dates.map((d, k) => {
              const ss = showsOn(d);
              const head = k === 0 || weekOf(dates[k - 1]) !== weekOf(d);
              return (
                <div key={d}>
                  {head && <div className="picker-week">{weekOf(d)}</div>}
                  <button className={`picker-option${d === value ? " on" : ""}`} onClick={() => { onChange(d); setOpen(false); }}>
                    <span className="mono">{dayLabel(d)}</span>
                    <span className="picker-sites">{ss.map((s) => `${siteShort(s.facility_name)} ${s.start_time}`).join(" · ")}</span>
                    <Mark tone={worstTone(ss.map(showTone))} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function Sites() {
  const { data: view } = useSchedule();
  const { data: musicians } = useMusicians();
  const { data: slots } = useApi<{ slots: SlotCollision[] }>("/api/slot-collisions");
  const today = isoDate(new Date());
  const upcoming = useMemo(() => (view?.shows ?? []).filter((s) => s.date >= today)
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time)), [view, today]);
  const dates = useMemo(() => [...new Set(upcoming.map((s) => s.date))], [upcoming]);
  const [picked, setPicked] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState<string>("all");
  const date = picked && dates.includes(picked) ? picked : dates[0] ?? null;
  const showsOn = (d: string) => upcoming.filter((s) => s.date === d);
  const dayShows = date ? showsOn(date) : [];
  const shown = showFilter === "all" ? dayShows : dayShows.filter((s) => s.show_id === showFilter);
  const details = useShowDetails(shown.map((s) => s.show_id));
  const { data: network } = useApi<NetworkView>(date ? `/api/network?date=${date}` : null);

  if (!view) return <p className="muted">Loading…</p>;
  if (!date) {
    return (
      <div>
        <div className="page-head"><h1>Sites &amp; travel</h1></div>
        <p className="muted">No upcoming shows to look at yet.</p>
      </div>
    );
  }

  const idx = dates.indexOf(date);
  const go = (d: string) => { setPicked(d); setShowFilter("all"); };
  const regionOf = new Map((musicians ?? []).map((m) => [m.musician_id, m.home_region]));

  const slotFor = (s: ShowSummary) => (slots?.slots ?? []).find((x) =>
    WEEKDAY_NAMES[x.weekday] === weekdayIndex(s.date) && x.start_time === s.start_time);

  const list = shown.map((s) => ({ s, d: details.get(s.show_id) })).filter((x) => x.d);
  // Until every picked show's detail has arrived, the totals below would read as real zeros.
  const loading = list.length < shown.length;
  const figure = (v: string | number) => (loading ? <span className="dim">…</span> : v);
  const people = list.reduce((a, { d }) => a + d!.roster.length, 0);
  const transit = list.reduce((a, { d }) => a + d!.solo_transit.length, 0);
  const cars = list.reduce((a, { d }) => a + d!.cars.length, 0);
  const km = list.reduce((a, { d }) => a + d!.cars.reduce((b, c) => b + c.distance_km, 0), 0);

  const rides = list.flatMap(({ s, d }) => [
    ...d!.cars.map((c) => ({
      key: `${s.show_id}-${c.driver}-${c.riders.join()}`, site: siteShort(s.facility_name), time: s.start_time,
      driver: c.driver === "a guardian" ? `${(c.riders[0] ?? "").split(" ")[0]}'s guardian` : c.driver,
      // A guardian's car is named after the first minor in it, so only the others count as riders.
      riders: (c.driver === "a guardian" ? c.riders.slice(1) : c.riders).join(", ") || "—",
      km: `${c.distance_km.toFixed(0)} km`,
    })),
    ...(d!.solo_transit.length ? [{ key: `${s.show_id}-transit`, site: siteShort(s.facility_name), time: s.start_time,
      driver: "Transit", riders: d!.solo_transit.map((t) => t.name).join(", "), km: "" }] : []),
  ]);

  const regions = [...new Set(list.flatMap(({ d }) => d!.roster.map((m) => regionOf.get(m.musician_id) ?? "")))].filter(Boolean).sort();
  const counts = regions.map((g) => list.map(({ d }) => d!.roster.filter((m) => regionOf.get(m.musician_id) === g).length));
  const hmax = Math.max(1, ...counts.flat());

  const mapFacilities = (network?.facilities ?? []).filter((f) => showFilter === "all" || f.show_id === showFilter);
  const mapRoutes = (network?.routes ?? []).filter((r) => showFilter === "all" || r.show_id === showFilter);

  return (
    <div>
      <div className="page-head"><h1>Sites &amp; travel</h1></div>
      <div className="sticky-bar">
        <span className="small ink-2">Show date</span>
        <DatePicker dates={dates} showsOn={showsOn} value={date} onChange={go} />
        <div className="arrows">
          <button className="icon-button" disabled={idx <= 0} onClick={() => go(dates[idx - 1])} aria-label="Previous show date">‹</button>
          <button className="icon-button" disabled={idx >= dates.length - 1} onClick={() => go(dates[idx + 1])} aria-label="Next show date">›</button>
        </div>
        {dayShows.length > 1 && (
          <div className="segmented">
            <button className={showFilter === "all" ? "on" : ""} onClick={() => setShowFilter("all")}>All shows</button>
            {dayShows.map((s) => (
              <button key={s.show_id} className={showFilter === s.show_id ? "on" : ""} onClick={() => setShowFilter(s.show_id)}>
                {siteShort(s.facility_name)} {s.start_time}
              </button>
            ))}
          </div>
        )}
      </div>

      <section className="section tight">
        <div className="section-head plain">
          <h2>Shows on {dayLabel(date)}</h2>
          <span className="note">Shows at the same time draw on the same free musicians</span>
        </div>
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr><th>Site</th><th>Time</th><th>Musicians / target</th><th className="r">Backups</th><th>Same time as</th><th className="r">Headroom</th></tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const t = showTone(s);
                const ratio = s.target_musicians ? s.musician_count / s.target_musicians : 1;
                const barTone = ratio < 0.8 ? "bad" : ratio < 1 ? "warn" : "";
                const same = dayShows.filter((o) => o !== s && o.start_time === s.start_time).map((o) => siteShort(o.facility_name));
                const slot = slotFor(s);
                const head = slot?.headroom;
                return (
                  <tr key={s.show_id}>
                    <td><span className="strong">{s.facility_name}</span><br /><span className={`small tone-${t}`}>{TONE_LABEL[t]}</span></td>
                    <td className="mono">{s.start_time}</td>
                    <td>
                      <span className="bar-cell">
                        <span className="bar-track"><span className={`bar-fill ${barTone}`} style={{ width: `${Math.min(ratio, 1) * 100}%` }} /></span>
                        <span className={`mono bar-num ${barTone}`}>{s.musician_count} / {s.target_musicians}</span>
                      </span>
                    </td>
                    <td className={`r mono ${s.backup_count === 0 ? "bad" : s.backup_count < 2 ? "warn" : "ink-2"}`}>{s.backup_count}</td>
                    <td className="ink-2">{same.join(", ") || "—"}</td>
                    <td className={`r mono ${head === undefined ? "dim" : head < 0 ? "bad" : head < 3 ? "warn" : "dim"}`}>
                      {head === undefined ? "—" : `${head > 0 ? "+" : ""}${head} free`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section wide-gap">
        <div className="section-head ruled">
          <h2>Travel</h2>
          <span className="note">{dayLabel(date)}</span>
        </div>
        <div className="travel-layout">
          <div className="travel-figures">
            <div className="travel-figure"><div className="small ink-2">Musicians travelling</div>
              <div className="travel-value">{figure(people)}</div></div>
            <div className="travel-figure"><div className="small ink-2">Cars</div>
              <div className="travel-value">{figure(cars)}</div></div>
            <div className="travel-figure"><div className="small ink-2">Distance driven</div>
              <div className="travel-value">{figure(`${km.toFixed(0)} km`)}</div></div>
            <div className="travel-figure"><div className="small ink-2">On transit</div>
              <div className="travel-value">{figure(transit)}</div></div>
          </div>
          <div className="travel-map">
            {network ? <NetworkMap facilities={mapFacilities} routes={mapRoutes} /> : <div className="map-loading mono dim">Loading map…</div>}
          </div>
        </div>

        <h3 className="sub-h">Rides</h3>
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Site</th><th>Time</th><th>Driver</th><th>Riders</th><th className="r">Distance</th></tr></thead>
            <tbody>
              {rides.map((r) => (
                <tr key={r.key}>
                  <td className="strong">{r.site}</td><td className="mono ink-2">{r.time}</td>
                  <td>{r.driver}</td><td className="ink-2">{r.riders}</td><td className="r mono dim">{r.km}</td>
                </tr>
              ))}
              {loading && <tr><td colSpan={5} className="dim">Loading rides…</td></tr>}
              {!loading && rides.length === 0 && <tr><td colSpan={5} className="dim">No rides planned for {dayLabel(date)} yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="section-head plain sub-h">
          <h3>Where musicians travel from</h3>
          <span className="note">Musicians per home region and show · darker = more</span>
        </div>
        <div className="scroll-x">
          <div className="heat" style={{ gridTemplateColumns: `150px repeat(${Math.max(1, list.length)}, minmax(92px, 1fr))` }}>
            <span />
            {list.map(({ s }) => <span key={s.show_id} className="heat-col">{siteShort(s.facility_name)} {s.start_time}</span>)}
            {regions.map((g, gi) => (
              <div key={g} className="heat-row">
                <span className="heat-region">{g}</span>
                {counts[gi].map((v, ci) => (
                  <span key={ci} className="heat-cell"
                        style={{ background: v ? `rgba(44,74,134,${(0.12 + (v / hmax) * 0.8).toFixed(2)})` : "var(--hover)",
                                 color: v / hmax > 0.55 ? "#fff" : "var(--ink)" }}>
                    {v || ""}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
