import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { geocodeAddress } from "../geocode";
import { updateNowAction } from "../scheduleUpdate";

type Field = "ignore" | "name" | "age" | "instrument" | "region" | "address" | "phone" | "email"
  | "guardian_name" | "guardian_phone" | "availability";

const FIELD_LABELS: Record<Field, string> = {
  ignore: "(ignore this column)", name: "Name", age: "Age", instrument: "Instrument", region: "Region",
  address: "Address", phone: "Phone", email: "Email", guardian_name: "Guardian name",
  guardian_phone: "Guardian phone", availability: "Availability",
};
// The default mapping when nothing in the first line looks like a header — same column order the
// old fixed-format paste always assumed, so an existing habit still works without remapping.
const DEFAULT_ORDER: Field[] = ["name", "age", "instrument", "region", "address", "phone", "email",
                                "guardian_name", "guardian_phone", "availability"];
const HEADER_HINTS: Record<Field, string[]> = {
  ignore: [], name: ["name"], age: ["age"], instrument: ["instrument"], region: ["region", "neighbo"],
  address: ["address"], phone: ["phone"], email: ["email"], guardian_name: ["guardian name", "guardian"],
  guardian_phone: ["guardian phone"], availability: ["availab"],
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EMPTY_MAPPING: Field[] = [];

interface Window { weekday: string; start_time: string; end_time: string }

/** "Tue 12:30-17:00; Sun 9-21" -> weekly_availability rows. Loose on purpose (a bulk paste won't
 *  be as precise as the click-to-paint grid) — anything it can't confidently read is just
 *  dropped, not rejected, since availability here is a head start, not the final word. */
function parseAvailability(text: string): Window[] {
  const windows: Window[] = [];
  for (const token of text.split(/[;,]/).map((t) => t.trim()).filter(Boolean)) {
    const m = token.match(/^(\w{3})\w*\s+(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/i);
    if (!m) continue;
    const weekday = WEEKDAYS.find((d) => d.toLowerCase() === m[1].toLowerCase());
    if (!weekday) continue;
    const start = `${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
    const end = `${m[4].padStart(2, "0")}:${(m[5] ?? "00").padStart(2, "0")}`;
    windows.push({ weekday, start_time: start, end_time: end });
  }
  return windows;
}

// Checked in this order, most specific first — "Guardian name" contains "name", so a plain
// substring search in field-declaration order would misclassify it as Name before ever reaching
// Guardian name's own, more specific hint.
const HEADER_PRIORITY: Field[] = ["guardian_phone", "guardian_name", "availability", "name", "age",
                                  "instrument", "region", "address", "phone", "email"];

function detectMapping(headerCells: string[]): Field[] | null {
  const lower = headerCells.map((c) => c.toLowerCase());
  const mapping = lower.map((cell): Field => {
    const hit = HEADER_PRIORITY.find((f) => HEADER_HINTS[f].some((hint) => cell.includes(hint)));
    return hit ?? "ignore";
  });
  const matched = mapping.filter((f) => f !== "ignore").length;
  // Needs at least name+age recognized to trust this as a real header row, not a data row that
  // happens to contain a word like "piano" in the wrong place.
  return matched >= 2 && mapping.includes("name") && mapping.includes("age") ? mapping : null;
}

interface ParsedRow {
  display_name: string; age: number; instrument: string; home_region: string; address: string;
  phone: string; email: string; guardian_name: string; guardian_phone: string; availability_text: string;
}

function buildRows(dataLines: string[], mapping: Field[]): { rows: ParsedRow[]; errors: string[] } {
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  dataLines.forEach((line, i) => {
    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim());
    const get = (f: Field) => { const idx = mapping.indexOf(f); return idx >= 0 ? (cells[idx] ?? "") : ""; };
    const name = get("name");
    const ageStr = get("age");
    if (!name) { errors.push(`Line ${i + 1}: missing a name.`); return; }
    const age = Number(ageStr);
    if (!ageStr || Number.isNaN(age)) { errors.push(`Line ${i + 1} (${name}): age "${ageStr}" isn't a number.`); return; }
    const address = get("address");
    if (!address) { errors.push(`Line ${i + 1} (${name}): no address — required so distances and carpools work.`); return; }
    rows.push({
      display_name: name, age, instrument: get("instrument") || "piano", home_region: get("region"), address,
      phone: get("phone"), email: get("email"), guardian_name: get("guardian_name"), guardian_phone: get("guardian_phone"),
      availability_text: get("availability"),
    });
  });
  return { rows, errors };
}

export default function BulkImportMusicians() {
  const { refresh, backPanel, showToast, setLastUpdateChanges } = useApp();
  usePanelTitle("Bulk import musicians");
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<Field[] | null>(null);
  const [manualMapping, setManualMapping] = useState<Field[] | null>(null);
  const [hasHeaderRow, setHasHeaderRow] = useState(false);
  const [geocoded, setGeocoded] = useState<Map<string, { lat: number; lng: number } | "failed">>(new Map());
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeProgress, setGeocodeProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = useMemo(() => text.split("\n").map((l) => l.trim()).filter(Boolean), [text]);

  useEffect(() => {
    if (lines.length === 0) { setMapping(null); setHasHeaderRow(false); return; }
    const first = (lines[0].includes("\t") ? lines[0].split("\t") : lines[0].split(",")).map((c) => c.trim());
    const detected = detectMapping(first);
    setHasHeaderRow(detected !== null);
    setMapping(detected ?? DEFAULT_ORDER.slice(0, first.length));
    setManualMapping(null);
    setGeocoded(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const effectiveMapping = manualMapping ?? mapping ?? EMPTY_MAPPING;
  const dataLines = hasHeaderRow ? lines.slice(1) : lines;
  const { rows, errors } = useMemo(() => buildRows(dataLines, effectiveMapping), [dataLines, effectiveMapping]);
  const minors = rows.filter((r) => r.age < 17 && !r.guardian_phone);
  const uniqueAddresses = useMemo(() => [...new Set(rows.map((r) => r.address))], [rows]);
  const needsGeocode = uniqueAddresses.some((a) => !geocoded.has(a));

  const setColumnField = (col: number, field: Field) => {
    const base = [...effectiveMapping];
    base[col] = field;
    setManualMapping(base);
  };

  const lookUpAddresses = async () => {
    setGeocoding(true);
    setGeocodeProgress(0);
    const next = new Map(geocoded);
    const todo = uniqueAddresses.filter((a) => !next.has(a));
    for (const address of todo) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const found = await geocodeAddress(address);
        next.set(address, found ? { lat: found.lat, lng: found.lng } : "failed");
      } catch {
        next.set(address, "failed");
      }
      setGeocodeProgress((p) => p + 1);
      setGeocoded(new Map(next));
      // Nominatim's usage policy: no more than about one request a second.
      // eslint-disable-next-line no-await-in-loop
      if (todo.indexOf(address) < todo.length - 1) await new Promise((r) => window.setTimeout(r, 1100));
    }
    setGeocoding(false);
  };

  const failedAddresses = uniqueAddresses.filter((a) => geocoded.get(a) === "failed");

  const save = () => {
    setSaving(true);
    setError(null);
    const musicians = rows.map((r) => {
      const g = geocoded.get(r.address);
      const coords = g && g !== "failed" ? g : { lat: 43.65, lng: -79.38 };
      return {
        display_name: r.display_name, age: r.age, instrument: r.instrument, home_region: r.home_region,
        home_lat: coords.lat, home_lng: coords.lng, phone: r.phone, email: r.email,
        guardian_name: r.guardian_name, guardian_phone: r.guardian_phone,
        weekly_availability: parseAvailability(r.availability_text),
      };
    });
    api<{ added: number }>("/api/musicians/bulk-import", { method: "POST", body: { musicians } })
      .then(({ added }) => {
        showToast(`${added} musician${added !== 1 ? "s" : ""} added. The schedule needs updating to include them.`,
                  updateNowAction(refresh, showToast, setLastUpdateChanges));
        refresh();
        backPanel();
      }).catch((e) => setError(e.message)).finally(() => setSaving(false));
  };

  const columnCount = effectiveMapping.length;

  return (
    <div className="panel-body">
      <div className="panel-title">
        <h2>Bulk import musicians</h2>
        <p className="muted small">
          Paste rows copied from a spreadsheet, tab- or comma-separated. Include a header row (Name, Age, Address, ...)
          and columns are matched automatically — otherwise map each column below. Name, Age and Address are required;
          everything else gets a sensible default you can fix per person afterward.
        </p>
      </div>
      {error && <p className="error">{error}</p>}
      <textarea className="bulk-import-textarea" rows={10} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={"Name\tAge\tInstrument\tRegion\tAddress\tPhone\tEmail\tGuardian name\tGuardian phone\tAvailability\n" +
                            "Ava Chen\t16\tviolin\tNorth York\t123 Main St, North York\t\t\tSusan Chen\t(416) 555-0000\tTue 12:30-17:00; Sun 9-21"} />

      {lines.length > 0 && (
        <div className="bulk-import-preview">
          <h3>Column mapping</h3>
          <p className="small muted">
            {hasHeaderRow ? "Header row detected and matched automatically — adjust any column below if it's wrong."
              : "No header row detected — using the usual column order. Change any column that doesn't match."}
          </p>
          <div className="bulk-import-mapping">
            {Array.from({ length: columnCount }, (_, col) => (
              <label key={col} className="small">
                Column {col + 1}
                <select value={effectiveMapping[col] ?? "ignore"} onChange={(e) => setColumnField(col, e.target.value as Field)}>
                  {(Object.keys(FIELD_LABELS) as Field[]).map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                </select>
              </label>
            ))}
          </div>

          <p className="small muted">
            {rows.length} row{rows.length !== 1 ? "s" : ""} ready{errors.length > 0 && `, ${errors.length} skipped`}.
          </p>
          {errors.length > 0 && (
            <ul className="plain-list small error">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {minors.length > 0 && (
            <p className="callout amber small">
              {minors.length} musician{minors.length !== 1 ? "s are" : " is"} under 17 with no guardian phone in this
              paste — add one from their profile once they're in.
            </p>
          )}

          {rows.length > 0 && (
            <>
              <div className="row-actions">
                <button className="button secondary small-button" onClick={lookUpAddresses} disabled={geocoding || !needsGeocode}>
                  {geocoding ? `Looking up addresses… (${geocodeProgress}/${uniqueAddresses.length})`
                    : needsGeocode ? `Look up ${uniqueAddresses.filter((a) => !geocoded.has(a)).length} address${uniqueAddresses.length !== 1 ? "es" : ""}`
                    : "Addresses looked up ✓"}
                </button>
              </div>
              {failedAddresses.length > 0 && (
                <p className="callout amber small">
                  Couldn't find {failedAddresses.length} address{failedAddresses.length !== 1 ? "es" : ""}: {failedAddresses.join("; ")}.
                  Those musicians will import with a placeholder location — fix it from their profile, or edit the address above and look up again.
                </p>
              )}
              <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Name</th><th>Age</th><th>Instrument</th><th>Region</th><th>Address</th><th>Availability</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const g = geocoded.get(r.address);
                    const parsedWindows = parseAvailability(r.availability_text).length;
                    return (
                      <tr key={i}>
                        <td>{r.display_name}</td><td>{r.age}</td><td>{r.instrument}</td><td>{r.home_region || "—"}</td>
                        <td>
                          {r.address}
                          {g === "failed" && <span className="small error"> — not found</span>}
                          {g && g !== "failed" && <span className="small muted"> — ✓</span>}
                          {!g && <span className="small muted"> — not looked up yet</span>}
                        </td>
                        <td>{r.availability_text ? `${parsedWindows} window${parsedWindows !== 1 ? "s" : ""}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </>
          )}
        </div>
      )}

      <div className="panel-footer">
        <button className="button" onClick={save} disabled={saving || rows.length === 0 || geocoding}>
          {saving ? "Adding…" : `Add ${rows.length || ""} musician${rows.length !== 1 ? "s" : ""}`}
        </button>
        <button className="button secondary" onClick={backPanel}>Cancel</button>
      </div>
    </div>
  );
}
