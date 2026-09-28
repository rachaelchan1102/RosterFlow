"""Read models for the frontend — each function turns a workspace's state into exactly the JSON
one screen renders. Nothing here changes state; see workspace.py for that.

Status colors are defined once here and used by every screen:
  red   — not fully staffed (songs short, under the 3-musician floor, or no pianist)
  amber — fully staffed, but fewer than 3 backups or no pianist among them
  green — fully staffed with a full, pianist-covered backup list
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import pandas as pd

from backend.workspace import Schedule, Workspace
from optimizer.assignment import AssignmentResult, compute_show_flags
from optimizer.backups import NUM_BACKUPS, BackupResult, backup_show_flags, recent_facility_counts
from optimizer.carpool import build_carpools
from optimizer.data import Data
from optimizer.metrics import compute_kpis

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _round1(x: float) -> float:
    """Round half up to one decimal, same convention the frontend's own Math.round(x*10)/10
    uses — Python's built-in round() rounds half-to-even (9.25 -> 9.2), so the exact same average
    could otherwise print as 9.2 on one screen and 9.3 on another depending on which side of the
    app happened to round it."""
    return math.floor(x * 10 + 0.5) / 10


TRANSIT_KMH = 22  # rough urban transit speed including walking/transfers — no real transit-time API here


def _transit_minutes(km: float) -> int:
    return round(km / TRANSIT_KMH * 60)


def _pool_candidates(ws: Workspace, musician_id: str, show_id: str) -> list[str]:
    """Names of anyone already on this show close enough (same 5km rule carpool.py's grouping
    uses) that the new backup could ride with them instead of driving out alone — surfaced at
    cancellation time so a coordinator considering "Fatima replaces Scarlett, 48 km away" can also
    see there's someone to split that drive with, not just the raw km number."""
    from optimizer.carpool import CARPOOL_MAX_KM
    draft = ws.require_draft()
    roster = draft.assignments[draft.assignments.show_id == show_id]
    return [musician_name(ws, m) for m in roster.musician_id if m != musician_id
           and ws.data.distance_between(musician_id, m) <= CARPOOL_MAX_KM]


def musician_name(ws: Workspace, musician_id: str) -> str:
    m = ws.data.musicians
    return str(m.at[musician_id, "display_name"]) if musician_id in m.index else musician_id


def _facility_name(ws: Workspace, facility_id: str) -> str:
    return str(ws.data.facilities.at[facility_id, "display_name"])


def _add_minutes(hhmm: str, minutes: int) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = h * 60 + m + minutes
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


def _outside_weekly_pattern(ws: Workspace, musician_id: str, show_id: str) -> bool:
    """True when this booking falls outside the musician's own RECURRING weekly pattern — a valid,
    deliberate one-off (someone free for just this date who's usually busy then, or vice versa;
    `Data.is_available` already accounts for exactly that, and is what the solver actually enforces
    as a hard constraint) is not a bug, but it's still worth flagging so a coordinator can tell a
    routine booking from an exception at a glance, instead of only finding out by comparing two
    screens by hand."""
    show = ws.data.shows.loc[show_id]
    weekday = DAYS[pd.Timestamp(show.date).weekday()]
    start, end = str(show.start_time), _add_minutes(str(show.start_time), int(show.duration_min))
    wa = ws.data.weekly_availability
    windows = wa[(wa.musician_id == musician_id) & (wa.weekday == weekday)]
    return not any(w.start_time <= start and end <= w.end_time for w in windows.itertuples())


def show_label(ws: Workspace, show_id: str) -> str:
    """How a coordinator names a show: where and when, never its internal ID."""
    show = ws.data.shows.loc[show_id]
    return f"{_facility_name(ws, show.facility_id)} on {pd.Timestamp(show.date):%a %b %-d}"


def schedule_kpis(data: Data, schedule: Schedule, mileage_rate: float = 0.0) -> dict:
    """Takes `data` directly, not a `Workspace` — so this can be computed against any snapshot
    (the live workspace, a what-if copy, or a past version from the audit log), not only the
    current one. `mileage_rate` ($/km) turns the already-computed car-km figures into dollar
    figures; it's a coordinator preference (Workspace.mileage_rate), not part of `data`."""
    ids = list(data.shows[data.shows.period == "upcoming"].index)
    flags = compute_show_flags(data, schedule.assignments, ids)
    backup_flags = backup_show_flags(schedule.backups, ids)
    cars, solo = build_carpools(data, schedule.assignments)
    k = compute_kpis(data, AssignmentResult("DRAFT", None, schedule.assignments, flags),
                     cars, solo, BackupResult(schedule.backups, backup_flags))
    return dict(
        fill_rate=k.fill_rate, minimum_met_rate=k.minimum_met_rate, backup_coverage=k.backup_coverage,
        capacity_utilization_mean=k.capacity_utilization_mean,
        capacity_utilization_spread=k.capacity_utilization_spread,
        total_cars=k.total_cars, total_car_km=k.total_car_km, guardian_car_km=k.guardian_car_km,
        peer_car_km=k.peer_car_km, car_km_savings=k.car_km_savings,
        solo_transit_count=k.solo_transit_count, rotation_repeat_rate=k.rotation_repeat_rate,
        mileage_rate=mileage_rate, car_cost_total=_round1(k.total_car_km * mileage_rate),
        car_cost_savings=_round1(k.car_km_savings * mileage_rate),
    )


def _free_that_day(ws: Workspace, schedule: Schedule, show_id: str) -> int:
    """Musicians who could still step in: available, allowed to travel there, not already
    playing this show or any other show that day, and not banned from it."""
    data = ws.data
    show = data.shows.loc[show_id]
    same_day = set(data.shows.index[data.shows.date == show.date])
    busy = set(schedule.assignments.loc[schedule.assignments.show_id.isin(same_day), "musician_id"])
    banned = ws.banned_pairs()
    return sum(1 for m in data.musicians.index
               if m not in busy and (m, show_id) not in banned
               and data.is_available(m, show_id) and data.within_guardian_range(m, show.facility_id))


def _status_label(flag, backup_flag) -> str:
    """A color alone can't say which of two different problems a show has — red covers both
    "not enough musicians" and "no one to call if someone drops," and amber covers both "short of
    the full target" and "backups are thin." Pick the wording that actually names what's wrong,
    rather than reusing one generic phrase ("Not fully staffed" / "Thin on backups") regardless of
    which one it is — a coordinator reading "Thin on backups" for a show that's short two
    musicians would go looking for a backup problem that isn't the real one."""
    if not flag.fully_staffed and backup_flag.backup_count == 0:
        return "Below minimum, no backups"
    if not flag.fully_staffed:
        return "Below minimum headcount"
    if backup_flag.backup_count == 0:
        return "No backups to call"
    if not flag.at_target and not backup_flag.backup_ready:
        return "Below target, thin on backups"
    if not flag.at_target:
        return "Below target headcount"
    if not backup_flag.backup_ready:
        return "Thin on backups"
    return "On track"


def _status(flag, backup_flag) -> str:
    """Red covers two real emergencies: below the minimum operational headcount (the show can't
    actually go ahead as planned), or zero backups (nobody to call if anyone drops — worse than
    merely "thin," which is what 1-2 backups means). Green requires BOTH the location's full
    target headcount (not just the minimum) and backup coverage ready — a show at 5 of a
    7-person target no longer reads as "on track" just because it clears the floor."""
    if not flag.fully_staffed or backup_flag.backup_count == 0:
        return "red"
    if not flag.at_target or not backup_flag.backup_ready:
        return "amber"
    return "green"


def _reasons(ws: Workspace, schedule: Schedule, show_id: str, flag, backup_flag) -> list[str]:
    fac = ws.data.facilities.loc[ws.data.shows.at[show_id, "facility_id"]]
    reasons = []
    pending_id = ws.pending_calls.get(show_id)
    if pending_id:
        reasons.append(f"waiting to hear back from {musician_name(ws, pending_id)} — not counted until confirmed")
    if flag.songs_total < flag.songs_target:
        reasons.append(f"{flag.songs_target - flag.songs_total} songs short of {flag.songs_target}")
    if flag.musician_count < int(fac.min_musicians):
        reasons.append(f"only {flag.musician_count} musicians (needs at least {int(fac.min_musicians)})")
    elif flag.musician_count < int(fac.target_musicians):
        reasons.append(f"only {flag.musician_count} of a {int(fac.target_musicians)}-musician target")
    if not flag.has_pianist:
        reasons.append("no pianist")
    if backup_flag.backup_count == 0:
        reasons.append("no backups at all — nobody to call if someone drops")
    elif backup_flag.backup_count < NUM_BACKUPS:
        # `free` counts everyone who could be a backup here, including the current backups; the
        # only reason a free musician isn't one is that they're backing up another show that day.
        free = _free_that_day(ws, schedule, show_id)
        others = free - int(backup_flag.backup_count)
        prefix = f"only {backup_flag.backup_count} of {NUM_BACKUPS} backups — "
        if others <= 0:
            reasons.append(prefix + "nobody else is free that day")
        else:
            reasons.append(prefix + f"the {others} other free musician{'s are' if others != 1 else ' is'} "
                                    "already backing up another show that day")
    elif not backup_flag.has_pianist_backup:
        reasons.append("no pianist among the backups")
    return reasons


def cap_warning(ws: Workspace, musician_id: str, show_id: str) -> str | None:
    """Would putting this musician on this show take them past their monthly cap? The solver
    treats the cap as an expensive-but-allowed release valve; a hand edit should say so first."""
    draft = ws.require_draft()
    month = str(ws.data.shows.at[show_id, "date"])[:7]
    same_month = ws.data.shows.index[ws.data.shows.date.astype(str).str.startswith(month)]
    a = draft.assignments
    playing = int(((a.musician_id == musician_id) & a.show_id.isin(same_month) & (a.show_id != show_id)).sum())
    cap = int(ws.data.musicians.at[musician_id, "max_shows_per_month"])
    if playing + 1 > cap:
        return (f"{musician_name(ws, musician_id)} would be at {playing + 1} shows in {month}, "
                f"over their monthly cap of {cap}.")
    return None


def describe_changes(ws: Workspace, changes: list[dict]) -> list[dict]:
    shows = ws.data.shows
    out = []
    for c in changes:
        show_id = c["show_id"]
        looked_up = dict(musician_name=musician_name(ws, c["musician_id"]),
                         date=str(shows.at[show_id, "date"]) if show_id in shows.index else None,
                         start_time=str(shows.at[show_id, "start_time"]) if show_id in shows.index else None,
                         facility_name=(_facility_name(ws, shows.at[show_id, "facility_id"])
                                        if show_id in shows.index else None))
        # Changes for people or shows deleted since arrive already named; keep those names.
        out.append({**looked_up, **c})
    return out


def schedule_view(ws: Workspace) -> dict:
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    flags = compute_show_flags(data, draft.assignments, ids).set_index("show_id")
    backup_flags = backup_show_flags(draft.backups, ids).set_index("show_id")
    changed = {c["show_id"] for c in ws.unpublished_roster_changes()}

    shows = []
    for show_id in sorted(ids, key=lambda s: (data.shows.at[s, "date"], data.shows.at[s, "start_time"])):
        show = data.shows.loc[show_id]
        fac = data.facilities.loc[show.facility_id]
        f, b = flags.loc[show_id], backup_flags.loc[show_id]
        shows.append(dict(
            show_id=show_id, facility_id=show.facility_id, facility_name=str(fac.display_name),
            date=str(show.date), start_time=str(show.start_time), duration_min=int(show.duration_min),
            status=_status(f, b), status_label=_status_label(f, b), reasons=_reasons(ws, draft, show_id, f, b),
            musician_count=int(f.musician_count), target_musicians=int(fac.target_musicians),
            songs_total=int(f.songs_total), songs_target=int(f.songs_target), has_pianist=bool(f.has_pianist),
            backup_count=int(b.backup_count), backup_ready=bool(b.backup_ready),
            locked_count=sum(1 for m, s in ws.locks if s == show_id),
            changed_since_publish=show_id in changed,
        ))

    return dict(
        state=dict(
            published=ws.published is not None,
            has_unpublished_changes=ws.has_unpublished_changes(),
            unpublished_roster_changes=describe_changes(ws, ws.unpublished_roster_changes()),
            needs_resolve=ws.needs_resolve,
            last_resolve_changes=describe_changes(ws, ws.last_resolve_changes),
        ),
        kpis=schedule_kpis(ws.data, draft, ws.mileage_rate),
        published_kpis=schedule_kpis(ws.data, ws.published, ws.mileage_rate) if ws.published is not None else None,
        shows=shows,
        weekly_capacity=weekly_capacity(ws),
    )


def show_detail(ws: Workspace, show_id: str) -> dict:
    draft = ws.require_draft()
    data = ws.data
    show = data.shows.loc[show_id]
    fac = data.facilities.loc[show.facility_id]
    musicians = data.musicians
    ids = ws.upcoming_show_ids()
    flag = compute_show_flags(data, draft.assignments, [show_id]).iloc[0]
    backup_flag = backup_show_flags(draft.backups, [show_id]).iloc[0]

    roster_df = draft.assignments[draft.assignments.show_id == show_id]
    pianist_count = int(sum(1 for m in roster_df.musician_id if musicians.at[m, "instrument"] == "piano"))
    song_titles = {m: ws.song_titles.get((m, show_id), "") for m in roster_df.musician_id}
    # Anyone whose title (case/whitespace-insensitive) matches someone else's on THIS show —
    # blank titles never count as a match against each other.
    lowered = [t.strip().lower() for t in song_titles.values() if t.strip()]
    dupe_titles = {t for t in lowered if lowered.count(t) > 1}

    roster = [dict(
        musician_id=r.musician_id, name=musician_name(ws, r.musician_id),
        instrument=str(musicians.at[r.musician_id, "instrument"]), age=int(musicians.at[r.musician_id, "age"]),
        songs=int(r.songs), typical_songs=int(musicians.at[r.musician_id, "typical_songs"]),
        max_songs=int(musicians.at[r.musician_id, "max_songs"]),
        locked=(r.musician_id, show_id) in ws.locks,
        confirmed=(r.musician_id, show_id) in ws.confirmed,
        phone=str(musicians.at[r.musician_id, "phone"]), email=str(musicians.at[r.musician_id, "email"]),
        guardian_name=str(musicians.at[r.musician_id, "guardian_name"]),
        guardian_phone=str(musicians.at[r.musician_id, "guardian_phone"]),
        song_title=song_titles[r.musician_id],
        song_title_duplicate=song_titles[r.musician_id].strip().lower() in dupe_titles,
        brings_keyboard=bool(musicians.at[r.musician_id, "brings_keyboard"]),
        outside_availability=_outside_weekly_pattern(ws, r.musician_id, show_id),
    ) for r in roster_df.sort_values("songs", ascending=False).itertuples()]

    # The solver never books a keyboard-less pianist into a no-piano room (assignment.py's hard
    # constraint), so this can only fire when a coordinator LOCKED that pairing by hand — worth
    # surfacing loudly, since it means someone on this lineup has no instrument to actually play.
    stranded_pianists = [musician_name(ws, r.musician_id) for r in roster_df.itertuples()
                        if musicians.at[r.musician_id, "instrument"] == "piano"
                        and not fac.has_piano_onsite and not musicians.at[r.musician_id, "brings_keyboard"]]
    piano_warning = (f"No piano in this room: {', '.join(stranded_pianists)} "
                     f"{'is' if len(stranded_pianists) == 1 else 'are'} booked without a keyboard.") \
        if stranded_pianists else None

    played = draft.assignments.groupby("musician_id").size().to_dict()
    recent = recent_facility_counts(data, data.shows.loc[ids])
    backups = []
    for r in draft.backups[draft.backups.show_id == show_id].sort_values("rank").itertuples():
        km = data.distance_to_facility(r.musician_id, show.facility_id)
        visits = recent.get((r.musician_id, show.facility_id), 0)
        n = played.get(r.musician_id, 0)
        backups.append(dict(
            rank=int(r.rank), musician_id=r.musician_id, name=musician_name(ws, r.musician_id),
            age=int(musicians.at[r.musician_id, "age"]),
            instrument=str(musicians.at[r.musician_id, "instrument"]), is_pianist=bool(r.is_pianist),
            phone=str(musicians.at[r.musician_id, "phone"]), email=str(musicians.at[r.musician_id, "email"]),
            guardian_name=str(musicians.at[r.musician_id, "guardian_name"]),
            guardian_phone=str(musicians.at[r.musician_id, "guardian_phone"]),
            shows_scheduled=int(n), distance_km=float(km), recent_visits=int(visits),
            reason=(f"playing {n} show{'s' if n != 1 else ''} across the upcoming schedule · {km:.0f} km away · "
                    f"{'visited here ' + str(visits) + '× in the last 3 months' if visits else 'no recent visits here'}"),
        ))

    cars, solo = build_carpools(data, roster_df)
    car_rows = [dict(driver=(musician_name(ws, c.driver_id) if c.driver_id else "a guardian"),
                     riders=[musician_name(ws, m) for m in c.musician_ids if m != c.driver_id],
                     distance_km=float(c.distance_km))
                for c in cars]

    bans = [dict(musician_id=m, name=musician_name(ws, m), scope=scope, target_id=t)
            for m, scope, t in sorted(ws.bans)
            if (scope == "show" and t == show_id) or (scope == "facility" and t == show.facility_id)]

    pending_id = ws.pending_calls.get(show_id)
    pending_call = dict(musician_id=pending_id, name=musician_name(ws, pending_id),
                        age=int(musicians.at[pending_id, "age"]) if pending_id else None,
                        phone=str(musicians.at[pending_id, "phone"]), email=str(musicians.at[pending_id, "email"]),
                        guardian_name=str(musicians.at[pending_id, "guardian_name"]),
                        guardian_phone=str(musicians.at[pending_id, "guardian_phone"])) \
        if pending_id else None

    return dict(
        show_id=show_id, facility_id=show.facility_id, facility_name=str(fac.display_name),
        region=str(fac.region), date=str(show.date), start_time=str(show.start_time),
        duration_min=int(show.duration_min), has_piano_onsite=bool(fac.has_piano_onsite),
        status=_status(flag, backup_flag), status_label=_status_label(flag, backup_flag),
        reasons=_reasons(ws, draft, show_id, flag, backup_flag),
        coverage=dict(pianist_count=pianist_count,
                      songs_total=int(flag.songs_total), songs_target=int(flag.songs_target),
                      musician_count=int(flag.musician_count), min_musicians=int(fac.min_musicians),
                      target_musicians=int(fac.target_musicians), has_pianist=bool(flag.has_pianist)),
        piano_warning=piano_warning,
        roster=roster, backups=backups, cars=car_rows,
        solo_transit=[dict(musician_id=s.musician_id, name=musician_name(ws, s.musician_id),
                          distance_km=float(s.distance_km), est_minutes=_transit_minutes(s.distance_km),
                          long_trip=_transit_minutes(s.distance_km) > 60) for s in solo],
        bans=bans, pending_call=pending_call,
        facility=dict(address=str(fac.address), contact_name=str(fac.contact_name),
                      contact_phone=str(fac.contact_phone), parking_notes=str(fac.parking_notes),
                      piano_notes=str(fac.piano_notes), load_in_buffer_min=int(fac.load_in_buffer_min),
                      max_per_car=int(fac.max_per_car)),
        changed_since_publish=show_id in {c["show_id"] for c in ws.unpublished_roster_changes()},
        attendance={r.musician_id: r.status for r in
                   data.history_assignments[data.history_assignments.show_id == show_id].itertuples()},
    )


def musician_profile(ws: Workspace, musician_id: str) -> dict:
    draft = ws.require_draft()
    data = ws.data
    m = data.musicians.loc[musician_id]
    shows = data.shows

    def show_ref(show_id: str) -> dict:
        return dict(show_id=show_id, date=str(shows.at[show_id, "date"]),
                    facility_name=_facility_name(ws, shows.at[show_id, "facility_id"]))

    playing = [dict(show_ref(r.show_id), songs=int(r.songs), locked=(musician_id, r.show_id) in ws.locks,
                    outside_availability=_outside_weekly_pattern(ws, musician_id, r.show_id))
               for r in draft.assignments[draft.assignments.musician_id == musician_id].itertuples()]
    backing = [dict(show_ref(r.show_id), rank=int(r.rank))
               for r in draft.backups[draft.backups.musician_id == musician_id].itertuples()]
    playing.sort(key=lambda r: r["date"])
    backing.sort(key=lambda r: r["date"])

    months = sorted({str(d)[:7] for d in shows.loc[ws.upcoming_show_ids(), "date"]})
    cap = int(m.max_shows_per_month)
    cap_usage = [dict(month=mo, playing=sum(1 for p in playing if p["date"].startswith(mo)), cap=cap)
                 for mo in months]

    wa = data.weekly_availability
    windows = [dict(weekday=r.weekday, start_time=r.start_time, end_time=r.end_time)
               for r in wa[wa.musician_id == musician_id].itertuples()]
    windows.sort(key=lambda w: (DAYS.index(w["weekday"]) if w["weekday"] in DAYS else 9, w["start_time"]))

    bans = []
    for mid, scope, target in sorted(ws.bans):
        if mid != musician_id:
            continue
        label = (show_label(ws, target) if scope == "show"
                 else _facility_name(ws, target))
        bans.append(dict(scope=scope, target_id=target, label=label))

    return dict(
        musician_id=musician_id, name=str(m.display_name), age=int(m.age), instrument=str(m.instrument),
        home_region=str(m.home_region), transport=str(m.transport), can_drive=bool(m.can_drive),
        years_with_org=float(m.years_with_org), typical_songs=int(m.typical_songs), max_songs=int(m.max_songs),
        max_shows_per_month=cap, playing=playing, backing=backing, cap_usage=cap_usage,
        weekly_availability=windows, bans=bans, phone=str(m.get("phone", "")), email=str(m.get("email", "")),
        guardian_name=str(m.get("guardian_name", "")), guardian_phone=str(m.get("guardian_phone", "")),
        brings_keyboard=bool(m.get("brings_keyboard", False)),
        secondary_instruments=str(m.get("secondary_instruments", "")),
    )


def _window_hours(start: str, end: str) -> float:
    sh, sm = (int(x) for x in start.split(":"))
    eh, em = (int(x) for x in end.split(":"))
    return max(0.0, (eh * 60 + em - sh * 60 - sm) / 60)


def availability_heatmap(ws: Workspace) -> dict:
    """Musicians × every calendar date in the upcoming months, valued by hours free that day
    according to each musician's recurring weekly pattern."""
    data = ws.data
    upcoming_dates = pd.to_datetime(data.shows.loc[ws.upcoming_show_ids(), "date"])
    if upcoming_dates.empty:
        return dict(dates=[], rows=[])
    start = upcoming_dates.min().replace(day=1)
    end = (upcoming_dates.max() + pd.offsets.MonthEnd(0))
    dates = pd.date_range(start, end, freq="D")
    show_counts = upcoming_dates.dt.strftime("%Y-%m-%d").value_counts().to_dict()

    wa = data.weekly_availability
    hours_by_day: dict[str, dict[str, float]] = {}
    for r in wa.itertuples():
        per = hours_by_day.setdefault(r.musician_id, {})
        per[r.weekday] = per.get(r.weekday, 0.0) + _window_hours(r.start_time, r.end_time)

    rows = []
    for m in data.musicians.itertuples():
        per = hours_by_day.get(m.musician_id, {})
        rows.append(dict(musician_id=m.musician_id, name=str(m.display_name), instrument=str(m.instrument),
                         hours=[round(per.get(DAYS[d.weekday()], 0.0), 1) for d in dates]))

    date_rows = []
    for i, d in enumerate(dates):
        key = d.strftime("%Y-%m-%d")
        date_rows.append(dict(date=key, weekday=DAYS[d.weekday()], day=d.day,
                              show_count=int(show_counts.get(key, 0)),
                              free_count=sum(1 for r in rows if r["hours"][i] > 0)))
    return dict(dates=date_rows, rows=rows)


def first_upcoming_date(ws: Workspace) -> str | None:
    ids = ws.upcoming_show_ids()
    if not ids:
        return None
    return str(ws.data.shows.loc[ids, "date"].min())


def network_view(ws: Workspace, date: str) -> dict:
    """One date's worth of the network: a pin per location with a show that day, and a line for
    every musician's trip from home to that location, grouped by car (or "solo" / "guardian") so
    a carpool cluster reads as one group at a glance."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    show_ids = [s for s in ids if str(data.shows.at[s, "date"]) == date]

    facilities: list[dict] = []
    routes: list[dict] = []
    if show_ids:
        flags = compute_show_flags(data, draft.assignments, show_ids).set_index("show_id")
        backup_flags = backup_show_flags(draft.backups, show_ids).set_index("show_id")
        for show_id in show_ids:
            show = data.shows.loc[show_id]
            fac = data.facilities.loc[show.facility_id]
            f, b = flags.loc[show_id], backup_flags.loc[show_id]
            facilities.append(dict(
                show_id=show_id, facility_id=show.facility_id, name=str(fac.display_name),
                lat=float(fac.lat), lng=float(fac.lng), start_time=str(show.start_time),
                status=_status(f, b), musician_count=int(f.musician_count),
                target_musicians=int(fac.target_musicians),
            ))

            roster_df = draft.assignments[draft.assignments.show_id == show_id]
            cars, solo = build_carpools(data, roster_df)
            for i, car in enumerate(cars):
                group = f"{show_id}-car{i}"
                mode = "guardian" if car.driver_id is None else "car"
                for mid in car.musician_ids:
                    m = data.musicians.loc[mid]
                    routes.append(dict(
                        musician_id=mid, name=musician_name(ws, mid), show_id=show_id,
                        from_lat=float(m.home_lat), from_lng=float(m.home_lng),
                        to_lat=float(fac.lat), to_lng=float(fac.lng),
                        group=group, mode=mode, is_driver=(mid == car.driver_id),
                    ))
            for s in solo:
                m = data.musicians.loc[s.musician_id]
                routes.append(dict(
                    musician_id=s.musician_id, name=musician_name(ws, s.musician_id), show_id=show_id,
                    from_lat=float(m.home_lat), from_lng=float(m.home_lng),
                    to_lat=float(fac.lat), to_lng=float(fac.lng),
                    group=f"{show_id}-solo-{s.musician_id}", mode="transit", is_driver=False,
                ))
    return dict(date=date, facilities=facilities, routes=routes)


def flow_view(ws: Workspace, show_id: str | None = None) -> dict:
    """Musician-trips flowing into locations, aggregated by home region — over every upcoming
    show by default, or narrowed to one show. Each link also carries how far those trips are,
    since "who's coming from where" is only half the picture without "how far they're coming"."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    if show_id is not None:
        ids = [show_id] if show_id in ids else []
    a = draft.assignments[draft.assignments.show_id.isin(ids)]
    if a.empty:
        return dict(nodes=[], links=[])
    a = a.merge(data.musicians[["home_region"]], left_on="musician_id", right_index=True)
    a = a.merge(data.shows[["facility_id"]], left_on="show_id", right_index=True)
    a = a.merge(data.facilities[["display_name"]], left_on="facility_id", right_index=True)
    a = a.assign(distance_km=[data.distance_to_facility(m, f) for m, f in zip(a.musician_id, a.facility_id)])

    grouped = a.groupby(["home_region", "display_name"])
    counts = grouped.size().reset_index(name="count")
    distances = grouped["distance_km"].agg(avg_km="mean", total_km="sum").reset_index()
    links_df = counts.merge(distances, on=["home_region", "display_name"])

    regions = sorted(links_df.home_region.unique())
    facilities = sorted(links_df.display_name.unique())
    nodes = ([dict(id=f"region:{r}", label=r, kind="region") for r in regions]
             + [dict(id=f"facility:{f}", label=f, kind="facility") for f in facilities])
    links = [dict(source=f"region:{r.home_region}", target=f"facility:{r.display_name}", value=int(r.count),
                 avg_km=round(float(r.avg_km), 1), total_km=round(float(r.total_km), 1))
             for r in links_df.itertuples()]
    return dict(nodes=nodes, links=links)


def cost_waterfall(ws: Workspace) -> dict:
    """Per upcoming month: what car travel would cost if everyone drove themselves alone, then
    what carpooling and transit riders actually take off that — ending at the real car-km (and its
    dollar figure), instead of a bare "km saved" number with nothing to compare it against."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    months = sorted({str(data.shows.at[s, "date"])[:7] for s in ids})
    rows = []
    for month in months:
        month_shows = [s for s in ids if str(data.shows.at[s, "date"]).startswith(month)]
        a = draft.assignments[draft.assignments.show_id.isin(month_shows)]
        cars, solo = build_carpools(data, a)
        baseline_km = sum(data.distance_to_facility(m, data.shows.at[s, "facility_id"])
                         for s, m in zip(a.show_id, a.musician_id))
        actual_km = sum(c.distance_km for c in cars)
        naive_cars_km = sum(c.distance_km * len(c.musician_ids) for c in cars)
        carpool_savings_km = naive_cars_km - actual_km
        transit_km = sum(x.distance_km for x in solo)
        rows.append(dict(month=month, baseline_km=round(baseline_km, 1), carpool_savings_km=round(carpool_savings_km, 1),
                         transit_km=round(transit_km, 1), actual_km=round(actual_km, 1),
                         cost=round(actual_km * ws.mileage_rate, 2)))
    return dict(months=rows, mileage_rate=ws.mileage_rate)


def crossing_swaps(ws: Workspace, min_savings_km: float = 3.0) -> list[dict]:
    """Same-day shows where two musicians are each closer to the OTHER show than their own —
    routes crossing each other on the map instead of running toward each other's home side. A
    straight swap (same instrument, both already eligible for the other show) needs no re-solve
    and never changes headcount, songs or pianist coverage on either show — just who drives
    where. Checked only within the same calendar date, since that's the only case a musician
    could plausibly have played either show anyway."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    by_date: dict[str, list[str]] = {}
    for s in ids:
        by_date.setdefault(str(data.shows.at[s, "date"]), []).append(s)

    suggestions = []
    for date, shows_today in by_date.items():
        if len(shows_today) < 2:
            continue
        for i, s1 in enumerate(shows_today):
            for s2 in shows_today[i + 1:]:
                f1, f2 = data.shows.at[s1, "facility_id"], data.shows.at[s2, "facility_id"]
                if f1 == f2:
                    continue
                roster1 = draft.assignments.loc[draft.assignments.show_id == s1, "musician_id"].tolist()
                roster2 = draft.assignments.loc[draft.assignments.show_id == s2, "musician_id"].tolist()
                def piano_ok(m: str, f: str) -> bool:
                    row = data.musicians.loc[m]
                    return (row.instrument != "piano" or bool(data.facilities.at[f, "has_piano_onsite"])
                           or bool(row.brings_keyboard))

                for m1 in roster1:
                    for m2 in roster2:
                        if data.musicians.at[m1, "instrument"] != data.musicians.at[m2, "instrument"]:
                            continue
                        if not (data.is_available(m1, s2) and data.is_available(m2, s1)
                                and data.within_guardian_range(m1, f2) and data.within_guardian_range(m2, f1)
                                and piano_ok(m1, f2) and piano_ok(m2, f1)):
                            continue
                        current = data.distance_to_facility(m1, f1) + data.distance_to_facility(m2, f2)
                        swapped = data.distance_to_facility(m1, f2) + data.distance_to_facility(m2, f1)
                        savings = current - swapped
                        if savings >= min_savings_km:
                            suggestions.append(dict(
                                date=date, show_a=s1, show_b=s2,
                                facility_a=str(data.facilities.at[f1, "display_name"]),
                                facility_b=str(data.facilities.at[f2, "display_name"]),
                                musician_a=dict(musician_id=m1, name=musician_name(ws, m1)),
                                musician_b=dict(musician_id=m2, name=musician_name(ws, m2)),
                                savings_km=round(savings, 1),
                            ))
    suggestions.sort(key=lambda r: -r["savings_km"])
    return suggestions


def slot_collision_view(ws: Workspace) -> dict:
    """Every weekly slot (e.g. "Tue 18:30") that at least one location runs on, and everyone whose
    recurring weekly pattern actually covers it — the shared pool two same-slot locations are both
    drawing from at once. `headroom` (free pool minus combined target headcount across every
    location on that slot) makes the actual cause of a chronic shortfall visible directly, instead
    of only showing up as one location's utilization bar looking bad for no apparent reason."""
    data = ws.data
    wa = data.weekly_availability
    slot_to_facs: dict[str, list] = {}
    for f in data.facilities.itertuples():
        slot_to_facs.setdefault(str(f.preferred_slot), []).append(f)

    def day_key(slot: str) -> int:
        weekday = slot.split()[0]
        return DAYS.index(weekday) if weekday in DAYS else 9

    rows = []
    for slot, facs in sorted(slot_to_facs.items(), key=lambda kv: (day_key(kv[0]), kv[0])):
        weekday, start = slot.split()
        pool = wa[(wa.weekday == weekday) & (wa.start_time <= start) & (wa.end_time > start)]
        free_pool_size = int(pool.musician_id.nunique())
        total_demand = sum(int(f.target_musicians) for f in facs)
        rows.append(dict(
            slot=slot, weekday=weekday, start_time=start,
            facilities=[dict(facility_id=f.Index, name=str(f.display_name), target_musicians=int(f.target_musicians))
                       for f in facs],
            free_pool_size=free_pool_size, total_demand=total_demand, headroom=free_pool_size - total_demand,
        ))
    return dict(slots=rows)


def utilization_view(ws: Workspace) -> dict:
    """Capacity usage as two ranked lists, the way a fleet/warehouse dashboard would show it:
    each musician's share of their monthly cap used, and each location's average headcount
    against its target across its upcoming shows."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    a = draft.assignments[draft.assignments.show_id.isin(ids)]
    # The cap is enforced per calendar month (see optimizer/assignment.py's over_cap release
    # valve and simulate.py's played_this_month), so utilization has to be measured the same
    # way: each musician's WORST single month against their monthly limit, not their total
    # shows across the whole multi-month booking window against limit×months-in-window. That
    # blanket-total version let someone over cap in one busy month hide behind a quieter one —
    # exactly the "Over their cap" filter finding nobody, ever, that item 1 the audit's Dead/
    # Non-Functional Elements table reported.
    by_month = a.assign(month=pd.to_datetime(data.shows.loc[a.show_id, "date"].values).to_period("M").astype(str))
    played_by_month = by_month.groupby(["musician_id", "month"]).size()
    musician_ids_with_shows = set(played_by_month.index.get_level_values(0))

    musicians = []
    for m in data.musicians.itertuples():
        cap = int(m.max_shows_per_month)
        if m.musician_id in musician_ids_with_shows:
            month_counts = played_by_month.loc[m.musician_id]
            worst_month = str(month_counts.idxmax())
            n = int(month_counts.max())
        else:
            worst_month, n = None, 0
        musicians.append(dict(musician_id=m.musician_id, name=str(m.display_name), played=n, capacity=cap,
                              month=worst_month, utilization=(n / cap if cap else 0.0)))
    musicians.sort(key=lambda r: -r["utilization"])

    facilities = []
    if ids:
        flags = compute_show_flags(data, a, ids).set_index("show_id")
        for f in data.facilities.itertuples():
            here = [s for s in ids if data.shows.at[s, "facility_id"] == f.Index]
            if not here:
                continue
            avg = sum(int(flags.at[s, "musician_count"]) for s in here) / len(here)
            target = int(f.target_musicians)
            facilities.append(dict(facility_id=f.Index, name=str(f.display_name), shows=len(here),
                                   avg_musicians=_round1(avg), target_musicians=target,
                                   preferred_slot=str(f.preferred_slot),
                                   utilization=(avg / target if target else 0.0)))
        # Worst first — the ones actually running short are what a coordinator opens this for,
        # not a reassuring scroll through the locations already doing fine.
        facilities.sort(key=lambda r: r["utilization"])
    return dict(musicians=musicians, facilities=facilities)


def problem_locations(ws: Workspace, min_shows: int = 3) -> list[dict]:
    """Locations where being short isn't one bad week but the pattern — Harbourview averaging
    5.5 of 7, Riverside's backups thin on nearly every show. A single flagged show belongs on the
    Schedule page; this is for the location itself, which only a run of shows can show. Needs at
    least `min_shows` upcoming shows before it says anything, so a location with one show booked
    isn't judged on a sample of one."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    if not ids:
        return []
    flags = compute_show_flags(data, draft.assignments, ids).set_index("show_id")
    backup_flags = backup_show_flags(draft.backups, ids).set_index("show_id")

    # Same usual day/time as another location means both are drawing on the same free-musician
    # pool at once — the actual cause behind a location "just" running thin, not a reason to lower
    # its target. Two locations collide if their preferred_slot string matches exactly.
    slot_to_facilities: dict[str, list[str]] = {}
    for f in data.facilities.itertuples():
        slot_to_facilities.setdefault(str(f.preferred_slot), []).append(str(f.display_name))

    rows = []
    for f in data.facilities.itertuples():
        here = [s for s in ids if data.shows.at[s, "facility_id"] == f.Index]
        if len(here) < min_shows:
            continue
        target = int(f.target_musicians)
        avg_musicians = sum(int(flags.at[s, "musician_count"]) for s in here) / len(here)
        under_target_rate = sum(1 for s in here if not bool(flags.at[s, "at_target"])) / len(here)
        zero_backup_rate = sum(1 for s in here if int(backup_flags.at[s, "backup_count"]) == 0) / len(here)
        collides_with = [n for n in slot_to_facilities.get(str(f.preferred_slot), []) if n != str(f.display_name)]

        problems = []
        suggestion = None
        if under_target_rate >= 0.5 and target > int(f.min_musicians):
            problems.append(f"averages {_round1(avg_musicians)} of a {target}-musician target across {len(here)} shows")
            if collides_with:
                suggestion = (f"{f.preferred_slot} is also {', '.join(collides_with)}'s usual slot — both are drawing on "
                             f"the same free musicians at once. Try moving one location's day/time before lowering the target.")
            else:
                suggestion = (f"Consider lowering the target to {max(int(f.min_musicians), round(avg_musicians))} — "
                             f"that's what it's actually running at.")
        if zero_backup_rate >= 0.5:
            problems.append(f"no backups on {round(zero_backup_rate * 100)}% of its shows")
            if collides_with and suggestion:
                pass   # the slot-collision suggestion above already covers why backups are thin too
            elif collides_with:
                suggestion = f"{f.preferred_slot} is also {', '.join(collides_with)}'s usual slot — that's very likely why backups are thin too."
            else:
                backup_suggestion = "Check whether its usual day/time overlaps with other locations competing for the same free musicians."
                suggestion = f"{suggestion} {backup_suggestion}" if suggestion else backup_suggestion
        if not problems:
            continue
        rows.append(dict(facility_id=f.Index, name=str(f.display_name), shows=len(here),
                         avg_musicians=_round1(avg_musicians), target_musicians=target,
                         summary=" and ".join(problems), suggestion=suggestion))
    rows.sort(key=lambda r: r["avg_musicians"] / r["target_musicians"] if r["target_musicians"] else 0)
    return rows


# ---------------------------------------------------------------------------
# Version history / Control Tower home
# ---------------------------------------------------------------------------

def activity_log(ws: Workspace, limit: int | None = None) -> list[dict]:
    """Reverse-chronological — newest first, the way a feed or a log reads. `limit` caps how many
    come back (the home page's feed wants a handful; the full Activity page wants everything)."""
    entries = list(reversed(ws.audit_log))
    if limit is not None:
        entries = entries[:limit]
    return [dict(id=e.id, at=e.at, description=e.description, fill_seconds=e.fill_seconds) for e in entries]


def revert_preview(ws: Workspace, entry_id: int) -> list[str]:
    return ws.revert_preview(entry_id)


def facility_demand_forecast(ws: Workspace) -> list[dict]:
    """Per location, not just an org-wide total: each one's own historical cadence (how often it's
    actually asked for a show, averaged across every month it's appeared, history included) — the
    same "what does this senior home usually want" a coordinator would otherwise have to remember
    by hand — turned into a projected count for next month. Sorted busiest-first, since that's the
    one a coordinator planning ahead cares about first."""
    data = ws.data
    shows = data.shows
    if data.facilities.empty:
        return []
    all_shows = shows.assign(month=pd.to_datetime(shows.date).dt.to_period("M"))
    cadence = all_shows.groupby(["facility_id", "month"]).size().groupby("facility_id").mean()
    months_seen = all_shows.groupby("facility_id")["month"].nunique()

    rows = []
    for f in data.facilities.itertuples():
        avg_cadence = float(cadence.get(f.Index, 0.0))
        rows.append(dict(
            facility_id=f.Index, name=str(f.display_name), region=str(f.region),
            preferred_slot=str(f.preferred_slot), target_musicians=int(f.target_musicians),
            avg_shows_per_month=round(avg_cadence, 1),
            projected_next_month=round(avg_cadence),
            months_of_history=int(months_seen.get(f.Index, 0)),
        ))
    rows.sort(key=lambda r: -r["avg_shows_per_month"])
    return rows


def capacity_forecast(ws: Workspace, months_ahead: int = 6) -> dict:
    """Projects musician-show slots needed vs. typically available for the months beyond the
    current schedule — S&OP-style demand-vs-capacity planning, not just a report of what already
    happened. Deliberately simple and explicitly a projection: each location's typical monthly
    cadence (averaged across every month it's appeared in, history included) times its target
    headcount, against the roster's overall historical yes-rate — not a claim about specific
    future shows that don't exist yet.

    `target_roster_size` turns that same projection into a staffing TARGET: at the roster's own
    average monthly cap and yes-rate, how many musicians total it would take to comfortably cover
    that month's projected demand — the number a coordinator recruiting ahead of a busy season
    actually needs, not just a needed-vs-available slot count with no roster-size answer."""
    data = ws.data
    shows = data.shows
    upcoming = shows[shows.period == "upcoming"]
    if upcoming.empty or data.facilities.empty:
        return dict(months=[], roster_size=len(data.musicians))
    last_month = pd.to_datetime(upcoming.date).max().to_period("M")

    all_shows = shows.assign(month=pd.to_datetime(shows.date).dt.to_period("M"))
    cadence = all_shows.groupby(["facility_id", "month"]).size().groupby("facility_id").mean()
    avail_rate = float(data.availability.available.mean()) if len(data.availability) else 0.0
    roster_size = len(data.musicians)
    avg_cap = float(data.musicians.max_shows_per_month.mean()) if roster_size else 0.0
    # A musician's real, usable monthly capacity is their stated cap DISCOUNTED by how often
    # they actually say yes — a cap of 3 at a 70% yes-rate is realistically about 2 shows/month.
    usable_cap_per_musician = avg_cap * avail_rate

    rows = []
    for i in range(1, months_ahead + 1):
        month = last_month + i
        show_count = float(cadence.reindex(data.facilities.index).sum())
        needed = sum(cadence.get(f, 0.0) * int(data.facilities.at[f, "target_musicians"]) for f in data.facilities.index)
        available = show_count * roster_size * avail_rate
        target_roster_size = math.ceil(needed / usable_cap_per_musician) if usable_cap_per_musician > 0 else None
        rows.append(dict(month=str(month), needed=round(needed), available=round(available),
                         target_roster_size=target_roster_size))
    return dict(months=rows, roster_size=roster_size)


def weekly_capacity(ws: Workspace) -> list[dict]:
    """"Needed" (slots) vs. "available" (musicians) per week — deliberately NOT the same unit.
    A musician who's free for 3 shows in one week is one real person, not 3 — counting them once
    per show they're free for (the old approach) inflated "available" arbitrarily and made a
    caps-constrained week look like it had plenty of headroom. This counts each musician once per
    week, and only if they're actually still under their monthly cap that month — the real,
    undouble-counted number of people you could still ask."""
    draft = ws.require_draft()
    data = ws.data
    shows = data.shows.loc[ws.upcoming_show_ids()].copy()
    if shows.empty:
        return []
    shows["week"] = pd.to_datetime(shows["date"]).dt.to_period("W").astype(str)
    shows["month"] = pd.to_datetime(shows["date"]).dt.to_period("M")
    needed = shows.join(data.facilities[["target_musicians"]], on="facility_id").groupby("week")["target_musicians"].sum()

    played_this_month = (draft.assignments.assign(
        month=pd.to_datetime(data.shows.loc[draft.assignments.show_id, "date"]).dt.to_period("M").to_numpy())
        .groupby(["musician_id", "month"]).size())
    avail = data.availability[data.availability.available == 1].merge(
        shows[["week", "month"]], left_on="show_id", right_index=True)

    rows = []
    for week, wk_shows in shows.groupby("week"):
        month = wk_shows["month"].iloc[0]
        free_musicians = set(avail.loc[avail.week == week, "musician_id"])
        under_cap = sum(1 for m in free_musicians
                       if played_this_month.get((m, month), 0) < int(data.musicians.at[m, "max_shows_per_month"]))
        rows.append(dict(week=week, needed=int(needed.get(week, 0)), available=under_cap))
    return rows


def self_service_view(ws: Workspace, musician_id: str, days: int = 45) -> dict:
    """What a musician sees on their own self-service link — no login, just the shows they could
    play in roughly the next month and a half, and whatever they've already told the app (a
    weekly-pattern default or an earlier explicit answer) about each one."""
    m = ws.data.musicians.loc[musician_id]
    shows = ws.data.shows
    today = date.today().isoformat()
    cutoff = (date.today() + timedelta(days=days)).isoformat()
    rows = []
    for show_id in sorted(ws.upcoming_show_ids(), key=lambda s: (shows.at[s, "date"], shows.at[s, "start_time"])):
        d = str(shows.at[show_id, "date"])
        if not (today <= d <= cutoff):
            continue
        fac = ws.data.facilities.loc[shows.at[show_id, "facility_id"]]
        rows.append(dict(show_id=show_id, facility_name=str(fac.display_name), date=d,
                         start_time=str(shows.at[show_id, "start_time"]),
                         available=bool(ws.data.is_available(musician_id, show_id))))
    return dict(musician_id=musician_id, name=str(m.display_name), shows=rows)


def volunteer_hours(ws: Workspace, musician_id: str) -> dict:
    """Total volunteer time from checked-in attendance — the FULL show, not just the minutes
    they personally played, since "volunteering" for a teenager's hour-letter purposes means time
    given to the event (travel, setup, the whole performance), not their own set length. Only
    counts 'attended' rows; a no-show or late cancel contributes nothing."""
    hist = ws.data.history_assignments
    mine = hist[(hist.musician_id == musician_id) & (hist.status == "attended")]
    shows = ws.data.shows
    facilities = ws.data.facilities
    rows = []
    for r in mine.itertuples():
        if r.show_id not in shows.index:
            continue
        show = shows.loc[r.show_id]
        rows.append(dict(show_id=r.show_id, date=str(show.date),
                         facility_name=str(facilities.at[show.facility_id, "display_name"]),
                         minutes=int(show.duration_min)))
    rows.sort(key=lambda r: r["date"])
    total_minutes = sum(r["minutes"] for r in rows)
    m = ws.data.musicians.loc[musician_id]
    return dict(musician_id=musician_id, name=str(m.display_name), total_hours=round(total_minutes / 60, 1),
               shows_attended=len(rows), shows=rows)
