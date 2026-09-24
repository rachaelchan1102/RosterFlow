"""Read models for the frontend — each function turns a workspace's state into exactly the JSON
one screen renders. Nothing here changes state; see workspace.py for that.

Status colors are defined once here and used by every screen:
  red   — not fully staffed (songs short, under the 3-musician floor, or no pianist)
  amber — fully staffed, but fewer than 3 backups or no pianist among them
  green — fully staffed with a full, pianist-covered backup list
"""
from __future__ import annotations

import pandas as pd

from backend.workspace import Schedule, Workspace
from optimizer.assignment import AssignmentResult, compute_show_flags
from optimizer.backups import NUM_BACKUPS, BackupResult, backup_show_flags, recent_facility_counts
from optimizer.carpool import build_carpools
from optimizer.metrics import compute_kpis

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def musician_name(ws: Workspace, musician_id: str) -> str:
    m = ws.data.musicians
    return str(m.at[musician_id, "display_name"]) if musician_id in m.index else musician_id


def _facility_name(ws: Workspace, facility_id: str) -> str:
    return str(ws.data.facilities.at[facility_id, "display_name"])


def show_label(ws: Workspace, show_id: str) -> str:
    """How a coordinator names a show: where and when, never its internal ID."""
    show = ws.data.shows.loc[show_id]
    return f"{_facility_name(ws, show.facility_id)} on {pd.Timestamp(show.date):%a %b %-d}"


# Rough $/km estimate (gas + wear), not real fuel-price data — good enough to make "network cost"
# a headline number instead of a buried car-km stat. Easy to swap for a real rate later.
COST_PER_KM = 0.55


def schedule_kpis(ws: Workspace, schedule: Schedule) -> dict:
    ids = ws.upcoming_show_ids()
    flags = compute_show_flags(ws.data, schedule.assignments, ids)
    backup_flags = backup_show_flags(schedule.backups, ids)
    cars, solo = build_carpools(ws.data, schedule.assignments)
    k = compute_kpis(ws.data, AssignmentResult("DRAFT", None, schedule.assignments, flags),
                     cars, solo, BackupResult(schedule.backups, backup_flags))
    n_shows = len(ids)
    n_trips = int((schedule.assignments.show_id.isin(ids)).sum())
    return dict(
        fill_rate=k.fill_rate, backup_coverage=k.backup_coverage,
        capacity_utilization_mean=k.capacity_utilization_mean,
        capacity_utilization_spread=k.capacity_utilization_spread,
        total_cars=k.total_cars, total_car_km=k.total_car_km, guardian_car_km=k.guardian_car_km,
        peer_car_km=k.peer_car_km, car_km_savings=k.car_km_savings,
        solo_transit_count=k.solo_transit_count, rotation_repeat_rate=k.rotation_repeat_rate,
        estimated_cost_dollars=k.total_car_km * COST_PER_KM,
        cost_per_show_dollars=(k.total_car_km * COST_PER_KM / n_shows) if n_shows else 0.0,
        cost_per_trip_dollars=(k.total_car_km * COST_PER_KM / n_trips) if n_trips else 0.0,
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


def _status(flag, backup_flag) -> str:
    if not flag.fully_staffed:
        return "red"
    return "green" if backup_flag.backup_ready else "amber"


def _reasons(ws: Workspace, schedule: Schedule, show_id: str, flag, backup_flag) -> list[str]:
    fac = ws.data.facilities.loc[ws.data.shows.at[show_id, "facility_id"]]
    reasons = []
    if flag.songs_total < flag.songs_target:
        reasons.append(f"{flag.songs_target - flag.songs_total} songs short of {flag.songs_target}")
    if flag.musician_count < int(fac.min_musicians):
        reasons.append(f"only {flag.musician_count} musicians (needs at least {int(fac.min_musicians)})")
    if not flag.has_pianist:
        reasons.append("no pianist")
    if backup_flag.backup_count < NUM_BACKUPS:
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
            status=_status(f, b), reasons=_reasons(ws, draft, show_id, f, b),
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
        kpis=schedule_kpis(ws, draft),
        published_kpis=schedule_kpis(ws, ws.published) if ws.published is not None else None,
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
    roster = [dict(
        musician_id=r.musician_id, name=musician_name(ws, r.musician_id),
        instrument=str(musicians.at[r.musician_id, "instrument"]), age=int(musicians.at[r.musician_id, "age"]),
        songs=int(r.songs), typical_songs=int(musicians.at[r.musician_id, "typical_songs"]),
        max_songs=int(musicians.at[r.musician_id, "max_songs"]),
        locked=(r.musician_id, show_id) in ws.locks,
    ) for r in roster_df.sort_values("songs", ascending=False).itertuples()]

    played = draft.assignments.groupby("musician_id").size().to_dict()
    recent = recent_facility_counts(data, data.shows.loc[ids])
    backups = []
    for r in draft.backups[draft.backups.show_id == show_id].sort_values("rank").itertuples():
        km = data.distance_to_facility(r.musician_id, show.facility_id)
        visits = recent.get((r.musician_id, show.facility_id), 0)
        n = played.get(r.musician_id, 0)
        backups.append(dict(
            rank=int(r.rank), musician_id=r.musician_id, name=musician_name(ws, r.musician_id),
            instrument=str(musicians.at[r.musician_id, "instrument"]), is_pianist=bool(r.is_pianist),
            shows_scheduled=int(n), distance_km=float(km), recent_visits=int(visits),
            reason=(f"playing {n} show{'s' if n != 1 else ''} this period · {km:.0f} km away · "
                    f"{'visited here ' + str(visits) + '× in the last 3 months' if visits else 'no recent visits here'}"),
        ))

    cars, solo = build_carpools(data, roster_df)
    car_rows = [dict(driver=(musician_name(ws, c.driver_id) if c.driver_id else "a guardian"),
                     riders=[musician_name(ws, m) for m in c.musician_ids], distance_km=float(c.distance_km))
                for c in cars]

    bans = [dict(musician_id=m, name=musician_name(ws, m), scope=scope, target_id=t)
            for m, scope, t in sorted(ws.bans)
            if (scope == "show" and t == show_id) or (scope == "facility" and t == show.facility_id)]

    return dict(
        show_id=show_id, facility_id=show.facility_id, facility_name=str(fac.display_name),
        region=str(fac.region), date=str(show.date), start_time=str(show.start_time),
        duration_min=int(show.duration_min), has_piano_onsite=bool(fac.has_piano_onsite),
        status=_status(flag, backup_flag), reasons=_reasons(ws, draft, show_id, flag, backup_flag),
        coverage=dict(songs_total=int(flag.songs_total), songs_target=int(flag.songs_target),
                      musician_count=int(flag.musician_count), min_musicians=int(fac.min_musicians),
                      target_musicians=int(fac.target_musicians), has_pianist=bool(flag.has_pianist)),
        roster=roster, backups=backups, cars=car_rows,
        solo_transit=[musician_name(ws, s.musician_id) for s in solo],
        bans=bans,
        changed_since_publish=show_id in {c["show_id"] for c in ws.unpublished_roster_changes()},
    )


def musician_profile(ws: Workspace, musician_id: str) -> dict:
    draft = ws.require_draft()
    data = ws.data
    m = data.musicians.loc[musician_id]
    shows = data.shows

    def show_ref(show_id: str) -> dict:
        return dict(show_id=show_id, date=str(shows.at[show_id, "date"]),
                    facility_name=_facility_name(ws, shows.at[show_id, "facility_id"]))

    playing = [dict(show_ref(r.show_id), songs=int(r.songs), locked=(musician_id, r.show_id) in ws.locks)
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
        weekly_availability=windows, bans=bans,
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


def utilization_view(ws: Workspace) -> dict:
    """Capacity usage as two ranked lists, the way a fleet/warehouse dashboard would show it:
    each musician's share of their monthly cap used, and each location's average headcount
    against its target across its upcoming shows."""
    draft = ws.require_draft()
    data = ws.data
    ids = ws.upcoming_show_ids()
    a = draft.assignments[draft.assignments.show_id.isin(ids)]
    months = pd.to_datetime(data.shows.loc[ids, "date"]).dt.to_period("M").nunique() if ids else 0
    months = max(months, 1)
    played = a.groupby("musician_id").size()

    musicians = []
    for m in data.musicians.itertuples():
        n = int(played.get(m.musician_id, 0))
        cap = int(m.max_shows_per_month) * months
        musicians.append(dict(musician_id=m.musician_id, name=str(m.display_name), played=n, capacity=cap,
                              utilization=(n / cap if cap else 0.0)))
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
                                   avg_musicians=avg, target_musicians=target,
                                   utilization=(avg / target if target else 0.0)))
        facilities.sort(key=lambda r: -r["utilization"])
    return dict(musicians=musicians, facilities=facilities)


def weekly_capacity(ws: Workspace) -> list[dict]:
    data = ws.data
    shows = data.shows.loc[ws.upcoming_show_ids()].copy()
    if shows.empty:
        return []
    shows["week"] = pd.to_datetime(shows["date"]).dt.to_period("W").astype(str)
    needed = shows.join(data.facilities[["target_musicians"]], on="facility_id").groupby("week")["target_musicians"].sum()
    avail_counts = data.availability[data.availability.available == 1].groupby("show_id").size()
    shows["avail_count"] = shows.index.map(avail_counts).fillna(0)
    available = shows.groupby("week")["avail_count"].sum()
    weekly = pd.DataFrame({"needed": needed, "available": available}).fillna(0)
    return [dict(week=week, needed=int(r.needed), available=int(r.available)) for week, r in weekly.iterrows()]
