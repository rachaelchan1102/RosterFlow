import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fuzzyFilter } from "../fuzzyMatch";

export interface ComboboxOption { value: string; label: string; sublabel?: string }

/** A `<select>` that can be typed into to filter, for pickers with enough options that scanning
 *  a plain dropdown is slow (a musician list, a show list) — arrow keys still move through the
 *  filtered results, Enter picks the highlighted one, Escape backs out to what was selected.
 *  Matching is fuzzy (see fuzzyMatch.ts): a typo, a word out of order, or a loose "kinda right"
 *  guess still finds the row, not just an exact substring. */
export default function Combobox({ options, value, onChange, placeholder, id, disabled }: {
  options: ComboboxOption[]; value: string; onChange: (v: string) => void;
  placeholder?: string; id?: string; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Set briefly when the field is left with typed text that matched nothing, so reverting to
  // the last real selection is visible instead of the field just silently snapping back —
  // without this, typing a location that doesn't exist and clicking away leaves the ORIGINAL
  // selection in place with no sign anything was discarded, which is exactly how someone books
  // the wrong location without noticing.
  const [revertedFrom, setRevertedFrom] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const leaveUnpicked = () => {
    setOpen(false);
    if (query.trim() && !options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase())) {
      setRevertedFrom(query.trim());
      window.setTimeout(() => setRevertedFrom(null), 4000);
    }
    setQuery("");
  };

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) leaveUnpicked();
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  });

  const filtered = fuzzyFilter(options, query, (o) => `${o.label} ${o.sublabel ?? ""}`);

  const pick = (o: ComboboxOption) => {
    setRevertedFrom(null);
    onChange(o.value);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (open && filtered[active]) pick(filtered[active]); }
    else if (e.key === "Escape") leaveUnpicked();
  };

  // The closed-state display includes the sublabel too (not just the label) — for a show
  // picker where the label is just the facility name, showing only that after picking would
  // drop the date/time that actually disambiguates which show, same as the plain <select> this
  // replaced never did.
  const closedText = selected ? (selected.sublabel ? `${selected.label} · ${selected.sublabel}` : selected.label) : "";

  return (
    <div className="combobox" ref={containerRef}>
      <input id={id} disabled={disabled} autoComplete="off" role="combobox"
             aria-expanded={open} aria-autocomplete="list"
             value={open ? query : closedText}
             placeholder={placeholder ?? "Type to search…"}
             onFocus={() => { setOpen(true); setQuery(""); setActive(0); }}
             onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
             onKeyDown={onKeyDown} onBlur={leaveUnpicked} />
      {open && (
        filtered.length > 0 ? (
          <ul className="combobox-list" role="listbox">
            {filtered.map((o, i) => (
              <li key={o.value}>
                <button type="button" role="option" aria-selected={o.value === value}
                        className={i === active ? "active" : ""}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(o)}>
                  {o.label}{o.sublabel && <span className="small muted"> {o.sublabel}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="combobox-list combobox-empty">No matches</div>
        )
      )}
      {!open && revertedFrom && (
        <p className="combobox-reverted small" role="alert">
          "{revertedFrom}" didn't match anything — kept {selected ? selected.label : "no selection"}.
        </p>
      )}
    </div>
  );
}
