"""Data layer: load, validate, and serve the inputs every other layer needs.

Nothing above this file (assignment/carpool/backups/simulate/metrics, the UI) reads a CSV or a
SQL row directly — they all take a `Data` object and call its lookup methods. That's the whole
point of this layer: swapping CSVs for Neon later (phase 7.5) means changing `load_from_csv`
into a `load_from_db`, not touching anything downstream.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from optimizer.geo import fallback_road_distance_km

REQUIRED_COLUMNS = {
    "facilities": ["facility_id", "display_name", "region", "lat", "lng", "show_duration_min",
                   "songs_per_show", "target_musicians", "min_musicians", "max_musicians",
                   "has_piano_onsite", "preferred_slot", "address", "contact_name", "contact_phone",
                   "parking_notes", "piano_notes", "load_in_buffer_min", "max_per_car"],
    "musicians": ["musician_id", "display_name", "age", "instrument", "home_region", "home_lat",
                  "home_lng", "transport", "can_drive", "years_with_org", "max_shows_per_month",
                  "min_songs", "typical_songs", "max_songs", "phone", "email",
                  "guardian_name", "guardian_phone", "brings_keyboard", "household_id",
                  "secondary_instruments"],
    "shows": ["show_id", "facility_id", "date", "start_time", "duration_min", "period"],
    "availability": ["musician_id", "show_id", "available"],
    "weekly_availability": ["musician_id", "weekday", "start_time", "end_time"],
    "distances": ["musician_id", "facility_id", "distance_km"],
    "musician_distances": ["m1", "m2", "km"],
    "history_assignments": ["show_id", "musician_id", "planned_set_min", "status", "actual_set_min"],
}
GUARDIAN_MAX_KM_DEFAULT = 35
MAX_SHOWS_PER_DAY = 3   # org-wide limit — no more than 3 facilities can run a show on the same date
# How far out a NEW show can be booked, in days — a rolling window from today, not a fixed
# calendar cutoff, so it advances on its own as today moves forward rather than needing a slot
# to be "opened" by hand each week. Only checked on add/edit of an "upcoming" show (see
# _check_booking_window below), never on the whole table, so an existing show already on the
# books doesn't start failing validation retroactively just because its date has since passed.
# ~4 months, not ~2: a coordinator booking a December holiday concert from September needs that
# lead time, and a facility asking "can you do December?" in September is routine, not an edge case.
BOOKING_HORIZON_DAYS = 120


class DataValidationError(ValueError):
    """Raised with every problem found, not just the first, so a bad CSV can be fixed in one pass."""


class RecordConflictError(ValueError):
    """Raised when a proposed add/edit/delete would break a rule _validate checks. The change is
    rejected outright and nothing in the live Data object is touched — this is the real safety
    net now that both deployments allow full add/edit/delete (see PROJECT_PLAN.md)."""


def load_from_csv(csv_dir: str | Path) -> "Data":
    csv_dir = Path(csv_dir)
    # keep_default_na=False: every text field here (guardian_name, parking_notes, ...) can be
    # legitimately blank — pandas' default NaN-for-empty-string behavior would otherwise turn
    # those into floats mid-table and crash JSON serialization (nan isn't valid JSON) the moment
    # any row actually had a blank one, rather than at load time where the mistake is obvious.
    raw = {name: pd.read_csv(csv_dir / f"{name}.csv", keep_default_na=False) for name in REQUIRED_COLUMNS}
    problems = _validate(raw)
    if problems:
        raise DataValidationError("\n".join(problems))
    return _build_data(raw)


def load_from_db(dsn: str) -> "Data":
    """The real deployment's loader — same validation, same Data shape as load_from_csv, just a
    different source. psycopg is imported here, not at module level, so a CSV-only environment
    (tests, the playground) never needs a Postgres driver installed to import this module at all.
    """
    import psycopg

    raw = {}
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        for table in REQUIRED_COLUMNS:
            cur.execute(f"SELECT * FROM {table}")
            cols = [c.name for c in cur.description]
            raw[table] = pd.DataFrame(cur.fetchall(), columns=cols)
    raw["availability"]["available"] = raw["availability"]["available"].astype(int)
    # Match the CSV path exactly: string dates (everything downstream compares date strings),
    # and no database-only surrogate id (a new row has none, and save_to_db would insert NaN).
    raw["shows"]["date"] = pd.to_datetime(raw["shows"]["date"]).dt.strftime("%Y-%m-%d")
    raw["weekly_availability"] = raw["weekly_availability"].drop(columns=["id"], errors="ignore")

    problems = _validate(raw)
    if problems:
        raise DataValidationError("\n".join(problems))
    return _build_data(raw)


def save_to_db(data: "Data", dsn: str) -> None:
    """Full resync: replace every table's contents with what's currently in `data`. Simple and
    correct at this dataset's scale (tens of musicians, ~100 shows) — not something to run on a
    hot path, just once after a validated CRUD change (add/update/delete_musician or _show)."""
    import psycopg

    raw = _to_raw_tables(data)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        for table, df in raw.items():
            cur.execute(f"TRUNCATE {table} CASCADE")
            if df.empty:
                continue
            cols = list(df.columns)
            placeholders = ", ".join(["%s"] * len(cols))
            cur.executemany(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})",
                           df[cols].itertuples(index=False, name=None))
        conn.commit()


def _build_data(raw: dict[str, pd.DataFrame]) -> "Data":
    """Assumes `raw` has already passed _validate. Fills in any missing distance pairs (the
    haversine fallback — real OSRM lookups are a caller's job, see distances.py) and wraps
    everything in a Data object."""
    raw = dict(raw)
    raw["distances"] = _fill_missing_musician_facility_distances(raw["musicians"], raw["facilities"], raw["distances"])
    raw["musician_distances"] = _fill_missing_musician_musician_distances(raw["musicians"], raw["musician_distances"])
    return Data(
        facilities=raw["facilities"].reset_index(drop=True).set_index("facility_id", drop=False),
        musicians=raw["musicians"].reset_index(drop=True).set_index("musician_id", drop=False),
        shows=raw["shows"].reset_index(drop=True).set_index("show_id", drop=False),
        availability=raw["availability"].reset_index(drop=True),
        weekly_availability=raw["weekly_availability"].reset_index(drop=True),
        musician_facility_km=raw["distances"].reset_index(drop=True),
        musician_musician_km=raw["musician_distances"].reset_index(drop=True),
        history_assignments=raw["history_assignments"].reset_index(drop=True),
    )


def _to_raw_tables(data: "Data") -> dict[str, pd.DataFrame]:
    """The inverse of _build_data — flattens a live Data object back into the plain dict of
    tables _validate expects, so a proposed CRUD change can be checked with the exact same rules
    a full load is checked with, not a second, parallel set of rules that could drift out of sync."""
    return {
        "facilities": data.facilities.reset_index(drop=True),
        "musicians": data.musicians.reset_index(drop=True),
        "shows": data.shows.reset_index(drop=True),
        "availability": data.availability.reset_index(drop=True),
        "weekly_availability": data.weekly_availability.reset_index(drop=True),
        "distances": data.musician_facility_km.reset_index(drop=True),
        "musician_distances": data.musician_musician_km.reset_index(drop=True),
        "history_assignments": data.history_assignments.reset_index(drop=True),
    }


def _validate_and_build(raw: dict[str, pd.DataFrame]) -> "Data":
    problems = _validate(raw)
    if problems:
        raise RecordConflictError("\n".join(problems))
    return _build_data(raw)


def _validate(raw: dict[str, pd.DataFrame]) -> list[str]:
    problems = []

    for name, cols in REQUIRED_COLUMNS.items():
        missing = [c for c in cols if c not in raw[name].columns]
        if missing:
            problems.append(f"{name}.csv is missing required columns: {missing}")
    if problems:
        return problems  # column checks must pass before anything below can safely run

    for name, key in [("facilities", "facility_id"), ("musicians", "musician_id"), ("shows", "show_id")]:
        dupes = raw[name][key][raw[name][key].duplicated()].unique().tolist()
        if dupes:
            problems.append(f"{name}.csv has duplicate {key}: {dupes}")

    dupe_av = raw["availability"][raw["availability"].duplicated(["musician_id", "show_id"])]
    if not dupe_av.empty:
        problems.append(f"availability.csv has duplicate (musician_id, show_id) rows: {len(dupe_av)} found")

    shows_per_day = raw["shows"].groupby("date").size()
    overloaded_days = shows_per_day[shows_per_day > MAX_SHOWS_PER_DAY]
    if not overloaded_days.empty:
        problems.append(f"shows.csv has more than {MAX_SHOWS_PER_DAY} shows on a single date "
                        f"(org-wide limit): {overloaded_days.to_dict()}")

    musician_ids = set(raw["musicians"]["musician_id"])
    facility_ids = set(raw["facilities"]["facility_id"])
    show_ids = set(raw["shows"]["show_id"])

    fk_checks = [
        ("shows", "facility_id", facility_ids, "facilities"),
        ("availability", "musician_id", musician_ids, "musicians"),
        ("availability", "show_id", show_ids, "shows"),
        ("weekly_availability", "musician_id", musician_ids, "musicians"),
        ("distances", "musician_id", musician_ids, "musicians"),
        ("distances", "facility_id", facility_ids, "facilities"),
        ("history_assignments", "musician_id", musician_ids, "musicians"),
        ("history_assignments", "show_id", show_ids, "shows"),
    ]
    for table, col, valid_ids, ref in fk_checks:
        bad = set(raw[table][col]) - valid_ids
        if bad:
            problems.append(f"{table}.csv has {col} values not found in {ref}.csv: {sorted(bad)[:10]}")

    bad_m1 = set(raw["musician_distances"]["m1"]) - musician_ids
    bad_m2 = set(raw["musician_distances"]["m2"]) - musician_ids
    if bad_m1 or bad_m2:
        problems.append(f"musician_distances.csv has musician_id values not found in musicians.csv: "
                        f"{sorted(bad_m1 | bad_m2)[:10]}")

    bad_available = set(raw["availability"]["available"].unique()) - {0, 1}
    if bad_available:
        problems.append(f"availability.csv 'available' column must be 0/1, found: {bad_available}")

    bad_status = set(raw["history_assignments"]["status"].unique()) - {"attended", "late_cancel", "no_show"}
    if bad_status:
        problems.append(f"history_assignments.csv 'status' must be attended/late_cancel/no_show, found: {bad_status}")

    return problems


def _fill_missing_musician_facility_distances(musicians: pd.DataFrame, facilities: pd.DataFrame,
                                               distances: pd.DataFrame) -> pd.DataFrame:
    have = set(zip(distances["musician_id"], distances["facility_id"]))
    missing_rows = []
    for m in musicians.itertuples():
        for f in facilities.itertuples():
            if (m.musician_id, f.facility_id) not in have:
                km = round(fallback_road_distance_km(m.home_lat, m.home_lng, f.lat, f.lng), 1)
                missing_rows.append(dict(musician_id=m.musician_id, facility_id=f.facility_id, distance_km=km))
    if not missing_rows:
        return distances
    return pd.concat([distances, pd.DataFrame(missing_rows)], ignore_index=True)


def _fill_missing_musician_musician_distances(musicians: pd.DataFrame, musician_distances: pd.DataFrame) -> pd.DataFrame:
    have = set(zip(musician_distances["m1"], musician_distances["m2"]))
    missing_rows = []
    ms = list(musicians.itertuples())
    for i, a in enumerate(ms):
        for b in ms[i + 1:]:
            if (a.musician_id, b.musician_id) not in have:
                km = round(fallback_road_distance_km(a.home_lat, a.home_lng, b.home_lat, b.home_lng), 1)
                missing_rows.append(dict(m1=a.musician_id, m2=b.musician_id, km=km))
                missing_rows.append(dict(m1=b.musician_id, m2=a.musician_id, km=km))
    if not missing_rows:
        return musician_distances
    return pd.concat([musician_distances, pd.DataFrame(missing_rows)], ignore_index=True)


@dataclass
class Data:
    facilities: pd.DataFrame
    musicians: pd.DataFrame
    shows: pd.DataFrame
    availability: pd.DataFrame
    weekly_availability: pd.DataFrame
    musician_facility_km: pd.DataFrame
    musician_musician_km: pd.DataFrame
    history_assignments: pd.DataFrame

    def __post_init__(self):
        self._available = {(r.musician_id, r.show_id): bool(r.available) for r in self.availability.itertuples()}
        self._m_to_f_km = {(r.musician_id, r.facility_id): r.distance_km for r in self.musician_facility_km.itertuples()}
        self._m_to_m_km = {(r.m1, r.m2): r.km for r in self.musician_musician_km.itertuples()}

    def is_available(self, musician_id: str, show_id: str) -> bool:
        return self._available.get((musician_id, show_id), False)

    def distance_to_facility(self, musician_id: str, facility_id: str) -> float:
        return self._m_to_f_km[(musician_id, facility_id)]

    def distance_between(self, musician_id_a: str, musician_id_b: str) -> float:
        if musician_id_a == musician_id_b:
            return 0.0
        return self._m_to_m_km[(musician_id_a, musician_id_b)]

    def within_guardian_range(self, musician_id: str, facility_id: str, max_km: float = GUARDIAN_MAX_KM_DEFAULT) -> bool:
        age = self.musicians.at[musician_id, "age"]
        if age >= 17:
            return True
        return self.distance_to_facility(musician_id, facility_id) <= max_km


# ---------------------------------------------------------------------------
# CRUD — add/edit/delete musicians and shows. Every one of these runs the exact same _validate
# suite a full CSV load goes through, on a COPY of the tables — if anything fails, the original
# `data` passed in is completely untouched, nothing is left half-applied.
# ---------------------------------------------------------------------------

def to_tables(data: Data) -> dict[str, pd.DataFrame]:
    """Public entry point for a caller outside this module that needs to serialize a whole `Data`
    snapshot — the audit log's revert history, specifically."""
    return _to_raw_tables(data)


def from_tables(raw: dict[str, pd.DataFrame]) -> Data:
    """The inverse of `to_tables`. Assumes `raw` already passed validation once (it came from a
    `Data` that was itself already valid), so this skips re-running `_validate`."""
    return _build_data(raw)


def add_musician(data: Data, musician: dict) -> Data:
    raw = _to_raw_tables(data)
    raw["musicians"] = pd.concat([raw["musicians"], pd.DataFrame([musician])], ignore_index=True)
    return _validate_and_build(raw)


def bulk_add_musicians(data: Data, musicians: list[dict]) -> Data:
    """The same add, for a whole spreadsheet's worth of new roster members at once — one
    validation pass over the combined table instead of one call per row, so a typo in row 40
    doesn't leave the first 39 already committed. Each dict may carry a `_weekly_availability`
    key (a list of {weekday, start_time, end_time}) — popped off before the musicians table is
    built, then appended to weekly_availability separately, so a bulk import can seed each new
    musician's recurring pattern instead of leaving every one of them with none at all."""
    raw = _to_raw_tables(data)
    windows_by_row = [m.pop("_weekly_availability", []) for m in musicians]
    raw["musicians"] = pd.concat([raw["musicians"], pd.DataFrame(musicians)], ignore_index=True)
    new_windows = [dict(musician_id=m["musician_id"], **w) for m, windows in zip(musicians, windows_by_row) for w in windows]
    if new_windows:
        raw["weekly_availability"] = pd.concat([raw["weekly_availability"], pd.DataFrame(new_windows)], ignore_index=True)
    return _validate_and_build(raw)


def add_facility(data: Data, facility: dict) -> Data:
    """A brand-new location mid-season — distances from it to every existing musician are filled
    in automatically by the same haversine fallback _build_data already runs for a new musician's
    distances to every existing facility (see _fill_missing_musician_facility_distances), so this
    needs no separate distance-computation step of its own."""
    raw = _to_raw_tables(data)
    raw["facilities"] = pd.concat([raw["facilities"], pd.DataFrame([facility])], ignore_index=True)
    return _validate_and_build(raw)


def update_facility(data: Data, facility_id: str, changes: dict) -> Data:
    """Editing a location's own record — address, contact, parking/piano notes, its usual slot,
    and its target/min/max headcount."""
    raw = _to_raw_tables(data)
    facilities = raw["facilities"]
    if facility_id not in facilities["facility_id"].values:
        raise RecordConflictError(f"facility_id {facility_id!r} does not exist")
    idx = facilities.index[facilities.facility_id == facility_id][0]
    for col, value in changes.items():
        facilities.loc[idx, col] = value
    return _validate_and_build(raw)


def update_musician(data: Data, musician_id: str, changes: dict) -> Data:
    raw = _to_raw_tables(data)
    musicians = raw["musicians"]
    if musician_id not in musicians["musician_id"].values:
        raise RecordConflictError(f"musician_id {musician_id!r} does not exist")
    idx = musicians.index[musicians.musician_id == musician_id][0]
    for col, value in changes.items():
        musicians.loc[idx, col] = value
    return _validate_and_build(raw)


def delete_musician(data: Data, musician_id: str) -> Data:
    """Cascades: also removes this musician's availability, weekly pattern, distance, and
    history rows. Without that, they'd be left as orphaned rows pointing at a musician_id that
    no longer exists — _validate's foreign-key check would (correctly) reject the delete."""
    raw = _to_raw_tables(data)
    musicians = raw["musicians"]
    if musician_id not in musicians["musician_id"].values:
        raise RecordConflictError(f"musician_id {musician_id!r} does not exist")
    raw["musicians"] = musicians[musicians.musician_id != musician_id]
    raw["availability"] = raw["availability"][raw["availability"].musician_id != musician_id]
    raw["weekly_availability"] = raw["weekly_availability"][raw["weekly_availability"].musician_id != musician_id]
    raw["distances"] = raw["distances"][raw["distances"].musician_id != musician_id]
    md = raw["musician_distances"]
    raw["musician_distances"] = md[(md.m1 != musician_id) & (md.m2 != musician_id)]
    raw["history_assignments"] = raw["history_assignments"][raw["history_assignments"].musician_id != musician_id]
    return _validate_and_build(raw)


def _check_booking_window(show_date: str, period: str) -> None:
    """A new or rescheduled 'upcoming' show must land from today through BOOKING_HORIZON_DAYS out
    — never in the past, and not so far ahead that availability that far out hasn't meaningfully
    been asked yet. 'history' shows (already played) are exempt; they're allowed to be in the
    past because that's the point of them."""
    if period != "upcoming":
        return
    today = date.today().isoformat()
    horizon = (date.today() + timedelta(days=BOOKING_HORIZON_DAYS)).isoformat()
    if show_date < today:
        raise RecordConflictError(f"{show_date} is in the past — a show can't be scheduled before today.")
    if show_date > horizon:
        raise RecordConflictError(
            f"{show_date} is more than {BOOKING_HORIZON_DAYS} days from today. The booking window "
            "rolls forward with today, so try again once that date is closer.")


def add_show(data: Data, show: dict) -> Data:
    """`show` needs its own show_id — this layer doesn't generate one, since a UI or a Neon
    sequence is better placed to guarantee uniqueness than a guess made here."""
    _check_booking_window(show["date"], show.get("period", "upcoming"))
    raw = _to_raw_tables(data)
    raw["shows"] = pd.concat([raw["shows"], pd.DataFrame([show])], ignore_index=True)
    # Nobody has answered for a brand-new show yet, and with no availability rows at all the solver
    # (and a manual fill) would treat everyone as unavailable, leaving it empty for good. Start
    # everyone from their recurring weekly pattern instead — the same "who's usually free then"
    # the booking form's feasibility check already assumed — and let real answers override it.
    raw["availability"] = pd.concat(
        [raw["availability"], pd.DataFrame(_weekly_pattern_availability(raw, show))], ignore_index=True)
    return _validate_and_build(raw)


def _weekly_pattern_availability(raw: dict[str, pd.DataFrame], show: dict) -> list[dict]:
    weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][pd.Timestamp(show["date"]).weekday()]
    start = str(show["start_time"])
    end_ts = pd.Timestamp(f"2000-01-01 {start}") + pd.Timedelta(minutes=int(show["duration_min"]))
    end = end_ts.strftime("%H:%M")
    wa = raw["weekly_availability"]
    wa = wa[wa.weekday == weekday]
    free = set(wa[(wa.start_time <= start) & (wa.end_time >= end)].musician_id)
    return [dict(musician_id=m, show_id=show["show_id"], available=int(m in free))
            for m in raw["musicians"]["musician_id"]]


def update_show(data: Data, show_id: str, changes: dict) -> Data:
    raw = _to_raw_tables(data)
    shows = raw["shows"]
    if show_id not in shows["show_id"].values:
        raise RecordConflictError(f"show_id {show_id!r} does not exist")
    idx = shows.index[shows.show_id == show_id][0]
    if "date" in changes or "period" in changes:
        new_date = changes.get("date", shows.at[idx, "date"])
        new_period = changes.get("period", shows.at[idx, "period"])
        _check_booking_window(new_date, new_period)
    for col, value in changes.items():
        shows.loc[idx, col] = value
    return _validate_and_build(raw)


def delete_show(data: Data, show_id: str) -> Data:
    """Cascades: also removes this show's availability and history rows, same reasoning as
    delete_musician — an orphaned row pointing at a deleted show_id would fail the FK check."""
    raw = _to_raw_tables(data)
    shows = raw["shows"]
    if show_id not in shows["show_id"].values:
        raise RecordConflictError(f"show_id {show_id!r} does not exist")
    raw["shows"] = shows[shows.show_id != show_id]
    raw["availability"] = raw["availability"][raw["availability"].show_id != show_id]
    raw["history_assignments"] = raw["history_assignments"][raw["history_assignments"].show_id != show_id]
    return _validate_and_build(raw)


def record_attendance(data: Data, show_id: str, records: list[dict]) -> Data:
    """Who actually showed up, after the fact — separate from `confirmed` (said yes beforehand)
    and from being on the draft (the solver/coordinator's plan). Replaces any existing check-in
    for this show rather than appending, so re-checking someone in corrects the record instead of
    duplicating it; feeds both rotation fairness (recent_facility_counts) and volunteer hours."""
    raw = _to_raw_tables(data)
    if show_id not in raw["shows"]["show_id"].values:
        raise RecordConflictError(f"show_id {show_id!r} does not exist")
    hist = raw["history_assignments"]
    hist = hist[hist.show_id != show_id]
    raw["history_assignments"] = pd.concat([hist, pd.DataFrame(records)], ignore_index=True)
    return _validate_and_build(raw)


def set_show_availability(data: Data, musician_id: str, show_id: str, available: bool) -> Data:
    """One musician's yes/no for one show — how a cancellation gets recorded, so a later
    re-solve doesn't put the person who just dropped out straight back on the show."""
    raw = _to_raw_tables(data)
    av = raw["availability"]
    mask = (av.musician_id == musician_id) & (av.show_id == show_id)
    if mask.any():
        av.loc[mask, "available"] = int(available)
    else:
        raw["availability"] = pd.concat(
            [av, pd.DataFrame([dict(musician_id=musician_id, show_id=show_id, available=int(available))])],
            ignore_index=True)
    return _validate_and_build(raw)


def bulk_set_show_availability(data: Data, pairs: list[tuple[str, str]], available: bool) -> Data:
    """The same edit as set_show_availability, for many (musician_id, show_id) pairs in one pass
    — a coordinator marking a whole group unavailable for every show on a given date (a holiday,
    a school exam block) shouldn't mean one validated rebuild per person."""
    raw = _to_raw_tables(data)
    av = raw["availability"]
    pair_set = set(pairs)
    mask = av.apply(lambda r: (r.musician_id, r.show_id) in pair_set, axis=1) if len(av) else pd.Series(dtype=bool)
    if mask.any():
        av.loc[mask, "available"] = int(available)
    existing = set(zip(av.musician_id, av.show_id))
    new_rows = [dict(musician_id=m, show_id=s, available=int(available)) for m, s in pairs if (m, s) not in existing]
    if new_rows:
        raw["availability"] = pd.concat([av, pd.DataFrame(new_rows)], ignore_index=True)
    return _validate_and_build(raw)


def set_weekly_availability(data: Data, musician_id: str, windows: list[dict]) -> Data:
    """Replaces a musician's ENTIRE recurring weekly pattern with `windows` (each a dict with
    weekday/start_time/end_time) — not an add or a merge. The UI's availability grid always
    sends the musician's complete new pattern, since a user editing a when2meet-style grid is
    setting the whole picture at once, not appending to the old one."""
    raw = _to_raw_tables(data)
    if musician_id not in raw["musicians"]["musician_id"].values:
        raise RecordConflictError(f"musician_id {musician_id!r} does not exist")
    wa = raw["weekly_availability"]
    wa = wa[wa.musician_id != musician_id]
    if windows:
        new_rows = pd.DataFrame([{**w, "musician_id": musician_id} for w in windows])
        wa = pd.concat([wa, new_rows], ignore_index=True)
    raw["weekly_availability"] = wa
    return _validate_and_build(raw)
