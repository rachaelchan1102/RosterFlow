"""Phase 6: the Monte Carlo scenario engine — SPEC.md section 7 ("Scenario planner").

Uniform cancellation probability across every scheduled musician, by explicit design (see
SPEC.md's "no reliability scoring" decision). Nobody is more or less likely to cancel than
anyone else in this model — a per-person reliability score would contradict that outright.

Performance note (PROJECT_PLAN.md's "watch out for" list): 5,000 runs x ~28 shows needs to avoid
pandas .loc/.merge calls inside the hot loop, or it's far too slow to be interactive. So every
show's roster/backup data is pulled out of pandas ONCE into plain numpy arrays before the run
loop starts, and the "who cancels" draws are vectorized across all n_runs at once with numpy
rather than looped in Python.

Recursion note (also from that same list): `backups_needed_for_target` answers "how many
backups would it take to hit a target fill rate?" by calling `simulate_fill_rate` — the plain,
single-scenario simulator — in a loop over candidate backup counts. It never calls itself, and
`simulate_fill_rate` never calls `backups_needed_for_target` either, so there's no risk of the
recursive blowup an earlier version of this project ran into.

Simplifications kept explicit rather than silent:
- Backups activate in rank order (1, 2, 3, ...) rather than re-deriving cancellation.py's live
  pianist-priority reordering per cancellation. backups.py already guarantees a pianist is one
  of the ranked backups whenever one exists, so rank-order activation gets there in the vast
  majority of cases anyway, and re-deriving that logic 5,000 times per show isn't worth the cost
  for a statistical estimate.
- The shortfall ladder's step 4 ("one more backup beyond the named few") isn't modeled — only
  the named backups plus the existing roster's own extra-song room are. That's a rare edge case
  even in the live cancellation flow, and modeling it here would reintroduce exactly the
  pandas-per-event cost this module exists to avoid.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from datetime import date, timedelta

from optimizer.backups import assign_backups
from optimizer.data import MAX_SHOWS_PER_DAY, Data

MIN_LEAD_DAYS = 7   # a date suggested as an alternative needs real lead time to actually book

DEFAULT_CANCEL_P = 1 / 8
DEFAULT_N_RUNS = 5000


@dataclass
class _ShowSimData:
    songs_target: int
    min_musicians: int
    roster_songs: np.ndarray
    roster_max_songs: np.ndarray
    roster_is_pianist: np.ndarray
    backup_typical_songs: np.ndarray
    backup_max_songs: np.ndarray
    backup_is_pianist: np.ndarray


def _build_show_sim_data(data: Data, assignments: pd.DataFrame, backups: pd.DataFrame, show_id: str) -> _ShowSimData:
    s = data.shows.loc[show_id]
    fac = data.facilities.loc[s.facility_id]
    pianist_ids = set(data.musicians[data.musicians.instrument == "piano"].musician_id)

    roster = assignments.loc[assignments.show_id == show_id]
    roster_ids = roster.musician_id.to_numpy()
    roster_max = data.musicians.loc[roster_ids, "max_songs"].to_numpy(dtype=float) if len(roster_ids) else np.array([])

    backup_here = backups.loc[backups.show_id == show_id].sort_values("rank")
    backup_ids = backup_here.musician_id.to_numpy()
    if len(backup_ids):
        backup_typical = data.musicians.loc[backup_ids, "typical_songs"].to_numpy(dtype=float)
        backup_max = data.musicians.loc[backup_ids, "max_songs"].to_numpy(dtype=float)
        backup_is_pianist = np.array([bid in pianist_ids for bid in backup_ids])
    else:
        backup_typical = backup_max = np.array([])
        backup_is_pianist = np.array([], dtype=bool)

    return _ShowSimData(
        songs_target=int(fac.songs_per_show),
        min_musicians=int(fac.min_musicians),
        roster_songs=roster.songs.to_numpy(dtype=float),
        roster_max_songs=roster_max,
        roster_is_pianist=np.array([mid in pianist_ids for mid in roster_ids]),
        backup_typical_songs=backup_typical,
        backup_max_songs=backup_max,
        backup_is_pianist=backup_is_pianist,
    )


def _simulate_show(sim: _ShowSimData, cancellation_p: float | np.ndarray, n_runs: int,
                   rng: np.random.Generator) -> tuple[float, float, float]:
    """Vectorized across all n_runs for this one show — no pandas, no per-run Python loop.
    Returns (share of runs fully staffed, average songs the set comes up short, share of runs
    with a pianist present). A show that isn't fully staffed still goes ahead — it just runs
    short — so the second number is the real cost of a bad month. The third is a strict subset of
    "fully staffed" (pianist coverage is one of its three conditions), broken out on its own so a
    show that's fine on headcount/songs but structurally reliant on a single pianist can be seen
    even when its overall fill_rate looks fine — see simulate_pianist_risk below.

    `cancellation_p` is normally the module's one uniform scalar rate, but may instead be an
    array broadcastable to (n_runs, n_roster) — simulate_regional_disruption passes a per-run,
    per-roster-member rate that way, so a correlated event (everyone from one region cancelling
    together on the same run) reuses this exact fill/pianist/backup-activation math unchanged,
    rather than re-deriving it under a second, easily-drifting implementation."""
    n_roster = len(sim.roster_songs)
    if n_roster == 0:
        return 0.0, float(sim.songs_target), 0.0

    cancel = rng.random((n_runs, n_roster)) < cancellation_p    # shape (n_runs, n_roster)
    present = ~cancel

    covered_songs = (present * sim.roster_songs).sum(axis=1)
    covered_count = present.sum(axis=1).astype(float)
    pianist_covered = (present & sim.roster_is_pianist).any(axis=1)
    roster_room = (present * (sim.roster_max_songs - sim.roster_songs)).sum(axis=1)

    n_cancelled = cancel.sum(axis=1).astype(float)
    backup_room = np.zeros(n_runs)
    backups_activated = np.zeros(n_runs)

    for rank in range(len(sim.backup_typical_songs)):
        activate = backups_activated < n_cancelled
        covered_songs = covered_songs + activate * sim.backup_typical_songs[rank]
        covered_count = covered_count + activate
        pianist_covered = pianist_covered | (activate & sim.backup_is_pianist[rank])
        backup_room = backup_room + activate * (sim.backup_max_songs[rank] - sim.backup_typical_songs[rank])
        backups_activated = backups_activated + activate

    gap = np.maximum(sim.songs_target - covered_songs, 0)
    covered_songs = covered_songs + np.minimum(gap, roster_room + backup_room)

    filled = (covered_songs >= sim.songs_target) & (covered_count >= sim.min_musicians) & pianist_covered
    songs_short = np.maximum(sim.songs_target - covered_songs, 0)
    return float(filled.mean()), float(songs_short.mean()), float(pianist_covered.mean())


def simulate_fill_rate(data: Data, assignments: pd.DataFrame, backups: pd.DataFrame,
                       show_ids: list[str] | None = None, cancellation_p: float = DEFAULT_CANCEL_P,
                       n_runs: int = DEFAULT_N_RUNS, seed: int | None = None) -> pd.DataFrame:
    """Per show, estimated over n_runs independent Monte Carlo draws: fill_rate (share of runs
    fully staffed) and minutes_short (average minutes of music the set comes up short)."""
    ids = show_ids if show_ids is not None else list(assignments.show_id.unique())
    rng = np.random.default_rng(seed)
    rows = []
    for show_id in ids:
        fill, songs_short, _pianist_rate = _simulate_show(_build_show_sim_data(data, assignments, backups, show_id),
                                                          cancellation_p, n_runs, rng)
        fac = data.facilities.loc[data.shows.at[show_id, "facility_id"]]
        minutes_per_song = float(fac.show_duration_min) / float(fac.songs_per_show)
        rows.append(dict(show_id=show_id, fill_rate=fill, minutes_short=songs_short * minutes_per_song))
    return pd.DataFrame(rows, columns=["show_id", "fill_rate", "minutes_short"])


@dataclass
class NewShowFeasibility:
    """Answers a DIFFERENT question from everything else in this module: not "will an already-
    confirmed show stay fully staffed through cancellations" but "if a care home asks for this date, is it likely
    we could staff it at all" — before any musician has been asked about that specific date."""
    date: str
    probability_fully_staffed: float
    eligible_pool_size: int
    # Exclusion counts don't overlap — each person is counted under the first reason that applies,
    # in this order — so eligible_pool_size + all four always equals the roster size.
    excluded_day_conflict: int    # already committed to another show that exact date
    excluded_over_cap: int        # already at their monthly cap for that month
    excluded_guardian_range: int  # under-17s outside the guardian-distance limit for this facility
    excluded_time: int            # usual weekly pattern doesn't cover this time slot (0 if no time given)
    mean_available_count: float
    mean_available_songs: float
    # Availability-rate-weighted average distance from home to the facility, among the eligible
    # pool — a musician who's rarely free that weekday contributes less to this than one who
    # usually is, so it reads as "how far would the people who'd likely actually show up have to
    # travel," not just a flat average over everyone technically eligible. Lower is cheaper and
    # easier to get to. 0.0 when nobody's eligible (there's no pool to measure).
    mean_travel_km: float


def _empirical_weekday_availability_rates(data: Data, weekday: int) -> dict[str, float]:
    """For each musician: of their historical shows that fell on this weekday, what fraction did
    they mark themselves available for? Falls back to their overall historical rate if they've
    never had a historical show on this specific weekday to respond to."""
    hist_shows = data.shows[data.shows.period == "history"]
    hist_shows = hist_shows.assign(weekday=pd.to_datetime(hist_shows["date"]).dt.weekday)
    hist_av = data.availability[data.availability.show_id.isin(hist_shows.index)].merge(
        hist_shows[["weekday"]], left_on="show_id", right_index=True)

    overall_rate = hist_av.groupby("musician_id").available.mean()
    weekday_rate = hist_av[hist_av.weekday == weekday].groupby("musician_id").available.mean()

    rates = {}
    for m in data.musicians.itertuples():
        if m.musician_id in weekday_rate.index:
            rates[m.musician_id] = float(weekday_rate[m.musician_id])
        elif m.musician_id in overall_rate.index:
            rates[m.musician_id] = float(overall_rate[m.musician_id])
        else:
            rates[m.musician_id] = 0.0   # no historical data at all for this musician
    return rates


WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _not_free_at(data: Data, weekday: int, start_time: str, duration_min: int) -> set[str]:
    """Musicians whose usual weekly pattern has no window covering this whole time slot."""
    end = (pd.Timestamp(f"2000-01-01 {start_time}") + pd.Timedelta(minutes=duration_min)).strftime("%H:%M")
    wa = data.weekly_availability
    wa = wa[wa.weekday == WEEKDAY_NAMES[weekday]]
    covered = set(wa[(wa.start_time <= start_time) & (wa.end_time >= end)].musician_id)
    return set(data.musicians.index) - covered


def estimate_new_show_feasibility(data: Data, assignments: pd.DataFrame, facility_id: str, date: str,
                                  n_runs: int = DEFAULT_N_RUNS, seed: int | None = None,
                                  start_time: str | None = None, duration_min: int | None = None) -> NewShowFeasibility:
    """"If a care home asks for `date` at `facility_id`, how likely is it we could staff it?" —
    used BEFORE the date is confirmed and BEFORE musicians have been asked about it, so there's
    no confirmed availability.csv row to read yet. Uses each eligible musician's empirical
    per-weekday availability rate from history instead of a real yes/no answer.

    Hard exclusions come from the schedule that's already confirmed (`assignments`), not from
    randomness: a day conflict or a maxed-out monthly cap makes someone unavailable for real,
    regardless of what their historical pattern says. With a `start_time`, anyone whose usual
    weekly pattern doesn't cover that slot is excluded too (someone only free mornings can't
    take an evening show, however often they say yes to that weekday).
    """
    fac = data.facilities.loc[facility_id]
    weekday = pd.Timestamp(date).weekday()
    month = pd.Timestamp(date).to_period("M")
    pianist_ids = set(data.musicians[data.musicians.instrument == "piano"].musician_id)

    same_date_shows = data.shows[data.shows.date == date].index
    day_conflict_ids = set(assignments.loc[assignments.show_id.isin(same_date_shows), "musician_id"])

    assigned_months = pd.to_datetime(data.shows.loc[assignments.show_id, "date"].values).to_period("M")
    played_this_month = assignments.assign(month=assigned_months).groupby(["musician_id", "month"]).size()
    over_cap_ids = {
        m.musician_id for m in data.musicians.itertuples()
        if played_this_month.get((m.musician_id, month), 0) >= int(m.max_shows_per_month)
    }

    guardian_ineligible_ids = {
        m.musician_id for m in data.musicians.itertuples()
        if not data.within_guardian_range(m.musician_id, facility_id)
    }

    time_ineligible_ids = (_not_free_at(data, weekday, start_time, duration_min or int(fac.show_duration_min))
                           if start_time else set())

    excluded = day_conflict_ids | over_cap_ids | guardian_ineligible_ids | time_ineligible_ids
    eligible = [m for m in data.musicians.itertuples() if m.musician_id not in excluded]

    rates_by_id = _empirical_weekday_availability_rates(data, weekday)
    rates = np.array([rates_by_id[m.musician_id] for m in eligible])
    typical_songs = np.array([m.typical_songs for m in eligible], dtype=float)
    # A pianist only counts toward "has a pianist" here if they could actually play piano at this
    # room — someone who plays piano but doesn't bring a keyboard is no help at a no-piano venue,
    # same hard rule the real solver enforces (optimizer/assignment.py's piano_ok).
    piano_here = bool(fac.has_piano_onsite)
    is_pianist = np.array([m.musician_id in pianist_ids and (piano_here or m.brings_keyboard) for m in eligible])

    if len(eligible) == 0:
        probability = 0.0
        mean_count = mean_songs = mean_travel_km = 0.0
    else:
        rng = np.random.default_rng(seed)
        available = rng.random((n_runs, len(eligible))) < rates    # shape (n_runs, len(eligible))
        available_count = available.sum(axis=1)
        available_songs = (available * typical_songs).sum(axis=1)
        has_pianist = (available & is_pianist).any(axis=1)

        fully_staffed = ((available_count >= fac.min_musicians)
                         & (available_songs >= fac.songs_per_show) & has_pianist)
        probability = float(fully_staffed.mean())
        mean_count = float(available_count.mean())
        mean_songs = float(available_songs.mean())

        distances = np.array([data.distance_to_facility(m.musician_id, facility_id) for m in eligible])
        rate_total = rates.sum()
        mean_travel_km = float((distances * rates).sum() / rate_total) if rate_total > 0 else float(distances.mean())

    # Each person is counted under the first rule that rules them out, so the counts plus the
    # eligible pool add up to the whole roster instead of double-counting overlaps.
    over_cap_only = over_cap_ids - day_conflict_ids
    guardian_only = guardian_ineligible_ids - day_conflict_ids - over_cap_ids
    time_only = time_ineligible_ids - day_conflict_ids - over_cap_ids - guardian_ineligible_ids
    return NewShowFeasibility(
        date=date, probability_fully_staffed=probability, eligible_pool_size=len(eligible),
        excluded_day_conflict=len(day_conflict_ids),
        excluded_over_cap=len(over_cap_only), excluded_guardian_range=len(guardian_only),
        excluded_time=len(time_only),
        mean_available_count=mean_count, mean_available_songs=mean_songs,
        mean_travel_km=mean_travel_km,
    )


def suggest_alternative_dates(data: Data, assignments: pd.DataFrame, facility_id: str, requested_date: str,
                              window_days: int = 14, n_runs: int = 2000, top_n: int = 3,
                              seed: int | None = None, start_time: str | None = None,
                              duration_min: int | None = None) -> list[NewShowFeasibility]:
    """If a care home's requested date looks weak, check nearby dates too (+/- window_days) and
    rank by feasibility. A date already at the org-wide MAX_SHOWS_PER_DAY cap (see data.py) is
    skipped outright, not just deprioritized — adding a 4th show there wouldn't be a valid
    schedule regardless of how good the staffing odds look. The requested date itself is always
    included (offset 0), so "your original date is actually fine" is a possible, valid answer.
    """
    base = pd.Timestamp(requested_date)
    earliest = date.today() + timedelta(days=MIN_LEAD_DAYS)
    results = []
    for offset in range(-window_days, window_days + 1):
        candidate = (base + pd.Timedelta(days=offset)).date()
        # The requested date itself is always checked, whatever it is — that's the coordinator's
        # own choice to evaluate. A NEARBY alternative only gets suggested if there's still real
        # lead time to book it; a "better" date that's already this week isn't a usable answer.
        if offset != 0 and candidate < earliest:
            continue
        candidate_date = candidate.isoformat()
        if (data.shows["date"] == candidate_date).sum() >= MAX_SHOWS_PER_DAY:
            continue
        feas = estimate_new_show_feasibility(data, assignments, facility_id, candidate_date,
                                             n_runs=n_runs, seed=seed, start_time=start_time,
                                             duration_min=duration_min)
        results.append((abs(offset), feas))

    results.sort(key=lambda r: (-r[1].probability_fully_staffed, r[0], r[1].mean_travel_km))
    return [feas for _, feas in results[:top_n]]


def backups_needed_for_target(data: Data, assignments: pd.DataFrame, show_id: str,
                              target_fill_rate: float = 0.95, cancellation_p: float = DEFAULT_CANCEL_P,
                              n_runs: int = 2000, max_backups: int = 8, seed: int | None = None) -> int | None:
    """How many named backups would this ONE show need to clear `target_fill_rate`? Tries 0, 1,
    2, ... backups (re-ranking with assign_backups each time) and calls the plain
    simulate-a-single-scenario helper below directly — never itself — stopping at the first
    count that clears the target. Returns None if even max_backups isn't enough (the honest
    answer, not a crash)."""
    rng = np.random.default_rng(seed)
    for n in range(0, max_backups + 1):
        backup_result = assign_backups(data, assignments, show_ids=[show_id], num_backups=n)
        sim = _build_show_sim_data(data, assignments, backup_result.backups, show_id)
        if _simulate_show(sim, cancellation_p, n_runs, rng)[0] >= target_fill_rate:
            return n
    return None


def simulate_pianist_risk(data: Data, assignments: pd.DataFrame, backups: pd.DataFrame,
                          show_ids: list[str] | None = None, cancellation_p: float = DEFAULT_CANCEL_P,
                          n_runs: int = DEFAULT_N_RUNS, seed: int | None = None) -> pd.DataFrame:
    """Per show, over n_runs draws: the chance NO pianist is present after cancellations and
    backup activation (roster + ranked backups, same model simulate_fill_rate uses). This is a
    read on the CURRENT hard pianist requirement, not a new rule — it doesn't adopt the pianist
    soft-preference proposal floated elsewhere, which would change what "pianist coverage" even
    means; it just surfaces a number that model already computes internally but never exposed on
    its own. A show can look fine on simulate_fill_rate's overall fill_rate while still being
    structurally reliant on a single pianist — this is the number that catches that case."""
    ids = show_ids if show_ids is not None else list(assignments.show_id.unique())
    rng = np.random.default_rng(seed)
    rows = []
    for show_id in ids:
        sim = _build_show_sim_data(data, assignments, backups, show_id)
        _fill, _short, pianist_rate = _simulate_show(sim, cancellation_p, n_runs, rng)
        n_pianists = int(sim.roster_is_pianist.sum() + sim.backup_is_pianist.sum())
        # Coverage risk (above) and lineup variety are different problems: a show can have near-zero
        # risk of losing its pianist and still be four pianists and a guitarist — fine only if the
        # room actually has a piano for all of them to play. Both deterministic from the CURRENT
        # roster, not simulated — no cancellation draw changes who's booked today.
        facility_id = data.shows.at[show_id, "facility_id"]
        rows.append(dict(show_id=show_id, pianist_risk=1.0 - pianist_rate, pianists_in_reach=n_pianists,
                         non_pianists_booked=int(len(sim.roster_is_pianist) - sim.roster_is_pianist.sum()),
                         has_piano_onsite=bool(data.facilities.at[facility_id, "has_piano_onsite"])))
    return pd.DataFrame(rows, columns=["show_id", "pianist_risk", "pianists_in_reach",
                                       "non_pianists_booked", "has_piano_onsite"])


def buffer_sizing_report(data: Data, assignments: pd.DataFrame, backups: pd.DataFrame,
                         show_ids: list[str] | None = None, target_fill_rate: float = 0.95,
                         cancellation_p: float = DEFAULT_CANCEL_P, n_runs: int = 2000,
                         max_backups: int = 8, seed: int | None = None) -> pd.DataFrame:
    """Per show: how many named backups it has right now vs. how many backups_needed_for_target
    says it would take to clear `target_fill_rate` — the UI surface `backups_needed_for_target`
    was written for but never got (see this module's docstring). A different, deterministic seed
    per show (derived from `seed`, when given) so a coordinator scanning down the list isn't
    looking at the exact same random draw repeated for every row."""
    ids = show_ids if show_ids is not None else list(assignments.show_id.unique())
    rows = []
    for i, show_id in enumerate(ids):
        current = int((backups.show_id == show_id).sum())
        show_seed = None if seed is None else seed + i
        needed = backups_needed_for_target(data, assignments, show_id, target_fill_rate=target_fill_rate,
                                           cancellation_p=cancellation_p, n_runs=n_runs,
                                           max_backups=max_backups, seed=show_seed)
        rows.append(dict(show_id=show_id, current_backups=current, backups_needed=needed))
    return pd.DataFrame(rows, columns=["show_id", "current_backups", "backups_needed"])


def simulate_regional_disruption(data: Data, assignments: pd.DataFrame, backups: pd.DataFrame, region: str,
                                 show_ids: list[str] | None = None, disruption_p: float = 0.1,
                                 disrupted_cancel_p: float = 0.7, normal_cancel_p: float = DEFAULT_CANCEL_P,
                                 n_runs: int = DEFAULT_N_RUNS, seed: int | None = None) -> pd.DataFrame:
    """"What if a single regional event (a storm, a transit outage) knocked out everyone who
    lives in `region` at once, instead of cancellations happening independently the way
    simulate_fill_rate assumes?" A structured, CORRELATED alternative to that uniform model,
    scoped per show: each run draws one shared "is this show's region-`region` group disrupted"
    event (probability `disruption_p`); when it hits, every roster member who lives in `region`
    cancels together at `disrupted_cancel_p` instead of the normal independent `normal_cancel_p`,
    while everyone else on the roster keeps the normal rate. Reuses _simulate_show's exact
    fill/pianist/backup-activation math via its cancellation_p argument, which accepts a
    broadcastable array for exactly this purpose — the only new logic here is building that array.

    This deliberately does NOT correlate the same disruption draw across different shows that
    happen to fall on the same calendar date (that would mean restructuring the whole engine
    around date-level batches instead of independent per-show loops, a bigger change than this
    module's per-show design). It answers "how exposed is THIS show to losing its region-`region`
    people together," not "what does one storm do to the whole network in a single night."
    Backups aren't part of the correlation: in this model they never have their own cancellation
    event, they're only ever activated in rank order by how many roster members cancelled, so
    there's nothing region-specific to draw for them. A show with nobody from `region` on its
    roster is unaffected by construction and its `affected` flag says so, rather than silently
    reporting a number the scenario never touched."""
    ids = show_ids if show_ids is not None else list(assignments.show_id.unique())
    rng = np.random.default_rng(seed)
    home_region = data.musicians["home_region"]
    rows = []
    for show_id in ids:
        sim = _build_show_sim_data(data, assignments, backups, show_id)
        roster_ids = assignments.loc[assignments.show_id == show_id, "musician_id"].to_numpy()
        from_region = np.array([home_region.get(m) == region for m in roster_ids])
        affected = bool(from_region.any())

        if affected:
            disrupted = rng.random(n_runs) < disruption_p                          # shape (n_runs,)
            per_person = np.where(from_region, disrupted_cancel_p, normal_cancel_p)  # shape (n_roster,)
            cancel_p = np.where(disrupted[:, None], per_person[None, :], normal_cancel_p)  # (n_runs, n_roster)
        else:
            cancel_p = normal_cancel_p

        fill, songs_short, _pianist = _simulate_show(sim, cancel_p, n_runs, rng)
        fac = data.facilities.loc[data.shows.at[show_id, "facility_id"]]
        minutes_per_song = float(fac.show_duration_min) / float(fac.songs_per_show)
        rows.append(dict(show_id=show_id, fill_rate=fill, minutes_short=songs_short * minutes_per_song,
                         affected=affected, from_region_count=int(from_region.sum())))
    return pd.DataFrame(rows, columns=["show_id", "fill_rate", "minutes_short", "affected", "from_region_count"])
