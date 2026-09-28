"""Phase 2: the assignment optimizer. Decides who plays each show and how many songs.

True hard constraints (never relaxed): availability, guardian-distance for under-17s, one show
per musician per day, each musician's own minimum set length (everyone plays >= their min), and
a pianist at a facility with no piano onsite unless they bring their own keyboard.

Everything else is a *soft* constraint with a weight. Two of these are release valves rather
than targets — going over a musician's monthly cap, or asking them for more songs than their own
stated max — priced high enough that the solver only reaches for them when there's genuinely no
other way to keep a show staffed. The rest follow SPEC.md section 6's priority order: "fully
staffed" (3+ musicians, pianist present, songs covered) gets by far the largest weight, then fair
workload, then low travel, then rotation. If a show genuinely can't be filled even with those
release valves, the solver still returns the best schedule it can rather than failing outright —
that show just shows up flagged as needing attention downstream.

Travel cost here is a simplified proxy (raw musician-to-facility distance for whoever's
assigned) — the real car-pooled travel cost only exists after carpool.py groups people into cars
(phase 3). This term just discourages picking a far-away musician when a closer one works too.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
from ortools.sat.python import cp_model

from optimizer.data import Data

ROTATION_LOOKBACK_MONTHS = 3


ABS_MAX_EXTRA_SONGS = 5   # how far past a musician's own stated max we'd ever ask, even under penalty


@dataclass
class Weights:
    fully_staffed: int = 100_000   # per unit of: song shortfall, musician shortfall, missing pianist
    stability: int = 5_000         # per previously-scheduled assignment dropped on a re-solve
    over_cap: int = 20_000         # per show over a musician's monthly cap — a release valve, not a target
    over_max_songs: int = 20_000   # per song asked beyond a musician's own stated max
    target_headcount: int = 2_500  # per musician short of a show's target headcount (~10), above the 3-min floor
    fairness: int = 1_000          # per show of deviation from a musician's fair-share target
    extra_song_ask: int = 200      # per song asked beyond a musician's typical (comfortable) amount
    travel: int = 50               # per km
    travel_efficiency: int = 30    # per km, per song short of their typical count, while assigned
    rotation: int = 20             # per repeat facility visit (recent history or within this solve)


@dataclass
class AssignmentResult:
    status: str                    # "OPTIMAL", "FEASIBLE", or "INFEASIBLE"
    objective_value: float | None
    assignments: pd.DataFrame      # show_id, musician_id, songs
    show_flags: pd.DataFrame       # show_id, musician_count, has_pianist, songs_total, songs_target, fully_staffed, at_target


def compute_show_flags(data: Data, assignments: pd.DataFrame, show_ids: list[str] | None = None) -> pd.DataFrame:
    """Per-show staffing status from a roster alone — used after a solve, and again after a
    cancellation edits the roster directly without re-solving.

    `fully_staffed` means the show cleared its MINIMUM headcount — the hard operational floor
    the solver itself treats as a near-must (weights.fully_staffed, the heaviest penalty term).
    `at_target` means it reached the location's full TARGET headcount — a softer, lower-weighted
    goal in the solver (weights.target_headcount). These are genuinely different bars: a show at
    5 of a 7-person target is real and workable (fully_staffed), just not at full strength (not
    at_target). Reporting layers (KPIs, calendar status) need both, not just the first — treating
    "cleared the minimum" as "fully staffed" in a headline number is what let a schedule with
    several under-target shows report a misleading 100% fill rate."""
    ids = show_ids if show_ids is not None else list(data.shows[data.shows.period == "upcoming"].index)
    pianist_ids = set(data.musicians[data.musicians.instrument == "piano"].musician_id)
    rows = []
    for show_id in ids:
        fac = data.facilities.loc[data.shows.at[show_id, "facility_id"]]
        roster = assignments[assignments.show_id == show_id]
        songs_total = int(roster.songs.sum()) if len(roster) else 0
        has_pianist = bool(set(roster.musician_id) & pianist_ids)
        rows.append(dict(
            show_id=show_id,
            musician_count=len(roster),
            has_pianist=has_pianist,
            songs_total=songs_total,
            songs_target=int(fac.songs_per_show),
            fully_staffed=(len(roster) >= int(fac.min_musicians) and songs_total >= int(fac.songs_per_show)
                          and has_pianist),
            at_target=(len(roster) >= int(fac.target_musicians) and songs_total >= int(fac.songs_per_show)
                      and has_pianist),
        ))
    return pd.DataFrame(rows, columns=["show_id", "musician_count", "has_pianist", "songs_total",
                                       "songs_target", "fully_staffed", "at_target"])


def solve_assignment(data: Data, show_ids: list[str] | None = None, weights: Weights | None = None,
                     time_limit_s: float = 30.0,
                     locked: set[tuple[str, str]] | None = None,
                     banned: set[tuple[str, str]] | None = None,
                     banned_facilities: set[tuple[str, str]] | None = None,
                     previous: pd.DataFrame | None = None,
                     guardian_max_km: float | None = None) -> AssignmentResult:
    """`locked` / `banned` are (musician_id, show_id) pairs; `banned_facilities` are
    (musician_id, facility_id). A lock forces the pair on even if the availability data says
    otherwise — the coordinator heard it directly — but a ban always wins over a lock.
    `previous` (show_id, musician_id rows) is the schedule already in place: dropping any of
    those pairs costs `weights.stability`, so a re-solve only moves people when it has to.
    `guardian_max_km` overrides `Data.within_guardian_range`'s own default (GUARDIAN_MAX_KM_DEFAULT
    in data.py) for this solve only — used by the Network Cost Sensitivity scenario to ask "what
    if the guardian-driving distance limit were tighter?" without changing the org-wide default."""
    weights = weights or Weights()
    locked, banned, banned_facilities = locked or set(), banned or set(), banned_facilities or set()
    shows = data.shows.loc[show_ids] if show_ids is not None else data.shows[data.shows.period == "upcoming"]
    fac_cols = ["songs_per_show", "target_musicians", "min_musicians", "max_musicians"]
    shows = shows.join(data.facilities[fac_cols], on="facility_id")
    musicians = data.musicians

    model = cp_model.CpModel()

    def is_banned(m: str, s: str, f: str) -> bool:
        return (m, s) in banned or (m, f) in banned_facilities

    def piano_ok(m: str, f: str) -> bool:
        """A pianist can't play a facility with no piano in the room unless they bring their
        own keyboard — never relaxed, since there's no soft version of "no instrument to play"."""
        row = musicians.loc[m]
        return (row.instrument != "piano" or bool(data.facilities.at[f, "has_piano_onsite"])
                or bool(row.brings_keyboard))

    def in_guardian_range(musician_id: str, facility_id: str) -> bool:
        return (data.within_guardian_range(musician_id, facility_id, max_km=guardian_max_km)
                if guardian_max_km is not None else data.within_guardian_range(musician_id, facility_id))

    pairs = [(m.musician_id, s.show_id) for s in shows.itertuples() for m in musicians.itertuples()
             if not is_banned(m.musician_id, s.show_id, s.facility_id)
             and piano_ok(m.musician_id, s.facility_id)
             and (((m.musician_id, s.show_id) in locked)
                  or (data.is_available(m.musician_id, s.show_id)
                      and in_guardian_range(m.musician_id, s.facility_id)))]
    pairs_by_show: dict[str, list[tuple[str, str]]] = {}
    pairs_by_musician: dict[str, list[tuple[str, str]]] = {}
    for m, s in pairs:
        pairs_by_show.setdefault(s, []).append((m, s))
        pairs_by_musician.setdefault(m, []).append((m, s))

    x = {(m, s): model.NewBoolVar(f"x_{m}_{s}") for m, s in pairs}
    y, over_max_songs_vars, extra_song_vars = {}, [], []
    for m, s in pairs:
        row = musicians.loc[m]
        show_songs = int(shows.loc[s, "songs_per_show"])
        ub = min(int(row.max_songs) + ABS_MAX_EXTRA_SONGS, show_songs)
        y[(m, s)] = model.NewIntVar(0, max(ub, 0), f"y_{m}_{s}")
        model.Add(y[(m, s)] >= int(row.min_songs) * x[(m, s)])       # hard: everyone plays >= their min
        model.Add(y[(m, s)] <= ub * x[(m, s)])                        # zero out when not playing

        over = model.NewIntVar(0, ABS_MAX_EXTRA_SONGS, f"overmax_{m}_{s}")
        model.Add(over >= y[(m, s)] - int(row.max_songs))             # soft: exceeding their own max costs
        over_max_songs_vars.append(over)

        # soft, smaller: every song beyond their *typical* (not max) amount is an "extra song ask" —
        # SPEC.md wants these spread evenly rather than piled onto whoever's already assigned, so
        # without this the solver has zero reason to prefer adding another available musician over
        # loading up the same few people up to their learnable max every time.
        extra = model.NewIntVar(0, max(ub - int(row.typical_songs), 0), f"extra_{m}_{s}")
        model.Add(extra >= y[(m, s)] - int(row.typical_songs))
        extra_song_vars.append(extra)

    # --- hard: one show per musician per day ---
    show_date = shows["date"]
    by_day: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for m, s in pairs:
        by_day.setdefault((m, show_date[s]), []).append((m, s))
    for ms_pairs in by_day.values():
        if len(ms_pairs) > 1:
            model.Add(sum(x[p] for p in ms_pairs) <= 1)

    for pair in locked:
        if pair in x:
            model.Add(x[pair] == 1)

    penalty_terms = [weights.over_max_songs * sum(over_max_songs_vars),
                     weights.extra_song_ask * sum(extra_song_vars)]

    if previous is not None and len(previous):
        kept = [x[(r.musician_id, r.show_id)] for r in previous.itertuples() if (r.musician_id, r.show_id) in x]
        if kept:
            penalty_terms.append(weights.stability * sum(1 - v for v in kept))

    # --- soft, big weight: monthly cap (a release valve, not a hard wall) ---
    show_month = pd.to_datetime(show_date).dt.to_period("M")
    by_month: dict[tuple[str, pd.Period], list[tuple[str, str]]] = {}
    for m, s in pairs:
        by_month.setdefault((m, show_month[s]), []).append((m, s))
    over_cap_vars = []
    for (m, _month), ms_pairs in by_month.items():
        cap = int(musicians.loc[m, "max_shows_per_month"])
        over_cap = model.NewIntVar(0, len(ms_pairs), f"overcap_{m}_{_month}")
        model.Add(over_cap >= sum(x[p] for p in ms_pairs) - cap)
        over_cap_vars.append(over_cap)
    penalty_terms.append(weights.over_cap * sum(over_cap_vars))

    # --- soft, huge weight: fully staffed ---
    pianist_ids = set(musicians[musicians.instrument == "piano"].musician_id)
    shortfall_vars, understaff_vars, no_pianist_vars = {}, {}, {}
    for s in shows.itertuples():
        here = pairs_by_show.get(s.show_id, [])
        song_sum = sum(y[p] for p in here) if here else 0
        count_sum = sum(x[p] for p in here) if here else 0
        pianist_sum = sum(x[p] for p in here if p[0] in pianist_ids) if here else 0

        shortfall = model.NewIntVar(0, int(s.songs_per_show), f"shortfall_{s.show_id}")
        model.Add(shortfall >= s.songs_per_show - song_sum)
        shortfall_vars[s.show_id] = shortfall

        understaff = model.NewIntVar(0, int(s.min_musicians), f"understaff_{s.show_id}")
        model.Add(understaff >= s.min_musicians - count_sum)
        understaff_vars[s.show_id] = understaff

        no_pianist = model.NewBoolVar(f"no_pianist_{s.show_id}")
        if isinstance(pianist_sum, int):
            # No pianist can play this show at all. `0 >= 1` would be a plain Python False, which
            # CP-SAT reads as an impossible constraint — so take the penalty instead of failing.
            model.Add(no_pianist == 1)
        else:
            model.Add(pianist_sum >= 1).OnlyEnforceIf(no_pianist.Not())
        no_pianist_vars[s.show_id] = no_pianist

        penalty_terms.append(weights.fully_staffed * (shortfall + understaff + no_pianist))

        # soft, its own (smaller) tier: landing below the *target* headcount (~10 for a 60-min show)
        # costs something even once the 3-musician floor is met — without this, the model is happy
        # to cover a show's songs with a handful of people pushed to their max instead of spreading
        # the opportunity across more of the available pool, which is the whole point of "everyone
        # gets a similar opportunity to play."
        below_target = model.NewIntVar(0, int(s.target_musicians), f"below_target_{s.show_id}")
        model.Add(below_target >= s.target_musicians - count_sum)
        penalty_terms.append(weights.target_headcount * below_target)

    # --- soft: fair workload (deviation from each musician's fair-share target) ---
    months_in_horizon = max(pd.to_datetime(show_date).dt.to_period("M").nunique(), 1)
    total_capacity = sum(int(m.max_shows_per_month) * months_in_horizon for m in musicians.itertuples())
    total_demand = int(shows["target_musicians"].sum())
    avg_util = (total_demand / total_capacity) if total_capacity else 0.0

    fairness_terms = []
    for m in musicians.itertuples():
        here = pairs_by_musician.get(m.musician_id, [])
        played = sum(x[p] for p in here) if here else 0
        cap_here = int(m.max_shows_per_month) * months_in_horizon
        # When demand outstrips the whole roster's capacity (avg_util > 1), a fair share still
        # can't exceed someone's own cap — and letting it would push the target past dev's bound,
        # making the whole model infeasible rather than just short-staffed.
        target = min(round(avg_util * cap_here), cap_here)
        dev = model.NewIntVar(0, max(cap_here, 1), f"dev_{m.musician_id}")
        model.Add(dev >= played - target)
        model.Add(dev >= target - played)
        fairness_terms.append(dev)
    penalty_terms.append(weights.fairness * sum(fairness_terms))

    # --- soft: low travel (proxy — real car-pooled cost comes from carpool.py) ---
    show_facility = shows["facility_id"]
    travel_terms = [x[(m, s)] * int(round(data.distance_to_facility(m, show_facility[s]))) for m, s in pairs]
    penalty_terms.append(weights.travel * sum(travel_terms))

    # --- soft: travel efficiency — a long drive for only a token number of songs. `travel` above
    # already discourages picking someone far away at all; this catches the case it can't: someone
    # genuinely needed on a show (so `x` = 1 either way) who then only gets a couple of songs while
    # everyone closer plays their full typical amount. Zero whenever they're not assigned (y is
    # already forced to 0 by the x=0 case, so the shortfall term is too) or already at/above their
    # typical count.
    efficiency_terms = []
    for m, s in pairs:
        typical = int(musicians.loc[m, "typical_songs"])
        km = int(round(data.distance_to_facility(m, show_facility[s])))
        if typical <= 0 or km <= 0:
            continue
        shortfall = model.NewIntVar(0, typical, f"travelshort_{m}_{s}")
        model.Add(shortfall >= typical * x[(m, s)] - y[(m, s)])
        efficiency_terms.append(km * shortfall)
    penalty_terms.append(weights.travel_efficiency * sum(efficiency_terms))

    # --- soft: rotation (recent-history repeats + repeats within this solve) ---
    hist = data.history_assignments.merge(data.shows[["facility_id", "date"]], left_on="show_id", right_index=True)
    hist = hist[hist.status == "attended"]
    horizon_start = pd.to_datetime(show_date).min()
    cutoff = horizon_start - pd.DateOffset(months=ROTATION_LOOKBACK_MONTHS)
    recent = hist[pd.to_datetime(hist.date) >= cutoff]
    recent_counts = recent.groupby(["musician_id", "facility_id"]).size().to_dict()

    rotation_terms = [x[(m, s)] * recent_counts[(m, show_facility[s])]
                      for m, s in pairs if (m, show_facility[s]) in recent_counts]

    over_vars = []
    for m in musicians.itertuples():
        for f in shows["facility_id"].unique():
            ms_here = [(m.musician_id, s) for s in shows[shows.facility_id == f].index
                      if (m.musician_id, s) in x]
            if len(ms_here) <= 1:
                continue
            over = model.NewIntVar(0, len(ms_here), f"over_{m.musician_id}_{f}")
            model.Add(over >= sum(x[p] for p in ms_here) - 1)
            over_vars.append(over)
    penalty_terms.append(weights.rotation * (sum(rotation_terms) + sum(over_vars)))

    model.Minimize(sum(penalty_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_s
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    if status_name not in ("OPTIMAL", "FEASIBLE"):
        return AssignmentResult(status=status_name, objective_value=None,
                                assignments=pd.DataFrame(columns=["show_id", "musician_id", "songs"]),
                                show_flags=pd.DataFrame())

    assign_rows = [dict(show_id=s, musician_id=m, songs=solver.Value(y[(m, s)]))
                   for m, s in pairs if solver.Value(x[(m, s)]) == 1]
    assignments = pd.DataFrame(assign_rows, columns=["show_id", "musician_id", "songs"])
    show_flags = compute_show_flags(data, assignments, list(shows.index))

    return AssignmentResult(status=status_name, objective_value=solver.ObjectiveValue(),
                            assignments=assignments, show_flags=show_flags)
