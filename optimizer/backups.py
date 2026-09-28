"""Phase 4: backups. For each show, ranks 3 standby musicians — fairness (who's played least),
then distance, then rotation (SPEC.md section 9) — and swaps in a pianist if none of the top 3
happens to be one, since losing the pianist needs to always be recoverable when possible.

No CP-SAT here — this is a ranking problem, not a joint optimization, so it's its own lighter
pass like carpool.py. The one real coupling across shows is SPEC's "one person can be a backup
for only one show per day," so shows are processed date-by-date and a backup already used for an
earlier show that day is removed from later shows' candidate pools on the same day.

Being a backup — even a top-ranked one — never counts toward a musician's monthly cap or their
fairness "played" count unless they're actually activated for a cancellation (phase 5).
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from optimizer.data import Data

ROTATION_LOOKBACK_MONTHS = 3
NUM_BACKUPS = 3


@dataclass
class BackupResult:
    backups: pd.DataFrame      # show_id, musician_id, rank (1-3), is_pianist
    show_flags: pd.DataFrame   # show_id, backup_count, has_pianist_backup, backup_ready


def recent_facility_counts(data: Data, shows: pd.DataFrame) -> dict[tuple[str, str], int]:
    hist = data.history_assignments.merge(data.shows[["facility_id", "date"]], left_on="show_id", right_index=True)
    hist = hist[hist.status == "attended"]
    horizon_start = pd.to_datetime(shows["date"]).min()
    cutoff = horizon_start - pd.DateOffset(months=ROTATION_LOOKBACK_MONTHS)
    recent = hist[pd.to_datetime(hist.date) >= cutoff]
    return recent.groupby(["musician_id", "facility_id"]).size().to_dict()


def backup_show_flags(backups: pd.DataFrame, show_ids: list[str], num_backups: int = NUM_BACKUPS) -> pd.DataFrame:
    rows = []
    for show_id in show_ids:
        here = backups[backups.show_id == show_id]
        has_pianist = bool(here.is_pianist.any()) if len(here) else False
        rows.append(dict(show_id=show_id, backup_count=len(here), has_pianist_backup=has_pianist,
                         backup_ready=(len(here) >= num_backups and has_pianist)))
    return pd.DataFrame(rows, columns=["show_id", "backup_count", "has_pianist_backup", "backup_ready"])


def assign_backups(data: Data, assignments: pd.DataFrame, show_ids: list[str] | None = None,
                   num_backups: int = NUM_BACKUPS,
                   excluded: set[tuple[str, str]] | None = None,
                   already_backing: dict[str, set[str]] | None = None) -> BackupResult:
    """`excluded` holds (musician_id, show_id) pairs that must never be a backup there (bans).
    `already_backing` maps a date to musicians already used as a backup elsewhere that day —
    needed when refilling one show's backups without re-ranking every other show's."""
    excluded = excluded or set()
    shows = (data.shows.loc[show_ids] if show_ids is not None
             else data.shows[data.shows.period == "upcoming"])
    pianist_ids = set(data.musicians[data.musicians.instrument == "piano"].musician_id)
    played_count = assignments.groupby("musician_id").size().to_dict()
    recent_counts = recent_facility_counts(data, shows)

    # Look up dates from the FULL show table, not the (possibly show_ids-filtered) `shows` above —
    # `assignments` can reference shows outside that filter (e.g. when re-ranking backups for just
    # one show while `assignments` still holds the whole schedule), and every one of those still
    # needs a valid date lookup to check who's playing elsewhere that day.
    show_date = data.shows["date"]
    playing_today: dict[str, set[str]] = {}
    for row in assignments.itertuples():
        day = show_date[row.show_id]
        playing_today.setdefault(day, set()).add(row.musician_id)

    # Same-date shows share one candidate pool for backups (SPEC: one backup per person per
    # day). Tried processing the scarcest show first so it claims candidates before a
    # bigger-pool show can eat into them — measured worse in aggregate (fewer shows hit full
    # 3-backup coverage overall), because "worst first" isn't the same problem as "maximize
    # shows fully covered." That's really its own small assignment problem; a greedy heuristic
    # either way can leave some shows thin on a day where several facilities overlap and there
    # genuinely aren't enough uncommitted musicians to go around — that's a real finding for the
    # exceptions queue, not something this pass should try to paper over with more cleverness.
    used_as_backup_today: dict[str, set[str]] = {d: set(ids) for d, ids in (already_backing or {}).items()}
    rows = []

    for s in shows.sort_values("date").itertuples():
        roster = set(assignments.loc[assignments.show_id == s.show_id, "musician_id"])
        used_today = used_as_backup_today.setdefault(s.date, set())
        playing_elsewhere_today = playing_today.get(s.date, set())

        piano_onsite = bool(data.facilities.at[s.facility_id, "has_piano_onsite"])
        candidates = [
            m for m in data.musicians.itertuples()
            if data.is_available(m.musician_id, s.show_id)
            and data.within_guardian_range(m.musician_id, s.facility_id)
            and (m.instrument != "piano" or piano_onsite or m.brings_keyboard)
            and m.musician_id not in roster
            and m.musician_id not in used_today
            and m.musician_id not in playing_elsewhere_today
            and (m.musician_id, s.show_id) not in excluded
        ]

        def sort_key(m):
            played = played_count.get(m.musician_id, 0)
            dist = data.distance_to_facility(m.musician_id, s.facility_id)
            rotation = recent_counts.get((m.musician_id, s.facility_id), 0)
            return (played, dist, rotation)

        ranked = sorted(candidates, key=sort_key)
        picks = ranked[:num_backups]

        if picks and not any(m.musician_id in pianist_ids for m in picks):
            best_pianist = next((m for m in ranked if m.musician_id in pianist_ids), None)
            if best_pianist is not None:
                picks[-1] = best_pianist

        for rank, m in enumerate(picks, start=1):
            used_today.add(m.musician_id)
            rows.append(dict(show_id=s.show_id, musician_id=m.musician_id, rank=rank,
                             is_pianist=m.musician_id in pianist_ids))

    backups = pd.DataFrame(rows, columns=["show_id", "musician_id", "rank", "is_pianist"])
    return BackupResult(backups=backups, show_flags=backup_show_flags(backups, list(shows.index), num_backups))
