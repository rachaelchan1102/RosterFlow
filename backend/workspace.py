"""Workspaces: the unit of state every API request operates on.

A workspace holds one roster (Data) plus the scheduling state layered on top of it:
- a DRAFT schedule (what the solver last produced, plus any hand edits like a cancellation)
- a PUBLISHED schedule (the schedule of record, frozen until the coordinator publishes again)
- LOCKS (keep this musician on this show no matter what) and BANS (never put this musician on
  this show / at this facility)

Re-solving is explicit, never automatic. When the roster changes, the draft is kept as-is and
marked stale (`needs_resolve`), so a schedule nobody asked to change never silently shifts under
the coordinator. A re-solve then keeps everything already in the draft unless it has to move it
(the solver's `stability` weight), and reports every move it did make.

Two kinds of workspace, same class: one per playground visitor (in memory, gone on refresh), and
one shared coordinator workspace backed by Postgres (see registry.py).
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable

import pandas as pd

from optimizer.assignment import solve_assignment
from optimizer.backups import assign_backups
from optimizer.cancellation import CancellationPlan, handle_cancellation
from optimizer.data import Data, set_show_availability

SOLVE_TIME_LIMIT_S = 20
ASSIGNMENT_COLS = ["show_id", "musician_id", "songs"]
BACKUP_COLS = ["show_id", "musician_id", "rank", "is_pianist"]


class WorkspaceError(ValueError):
    """A request the workspace can't honor, worded for a coordinator — becomes an HTTP 400."""


@dataclass(frozen=True)
class Schedule:
    """Treated as immutable: every change builds new DataFrames, so a schedule can be shared
    between workspaces (a fresh playground session starts from the same solved one) safely."""
    assignments: pd.DataFrame
    backups: pd.DataFrame


def _pairs(df: pd.DataFrame) -> set[tuple[str, str]]:
    return set(zip(df.musician_id, df.show_id))


class Workspace:
    def __init__(self, data: Data,
                 save_data: Callable[[Data], None] | None = None,
                 save_state: Callable[["Workspace"], None] | None = None):
        self.data = data
        self.draft: Schedule | None = None
        self.published: Schedule | None = None
        self.locks: set[tuple[str, str]] = set()               # (musician_id, show_id)
        self.bans: set[tuple[str, str, str]] = set()           # (musician_id, "show" | "facility", target_id)
        self.needs_resolve: str | None = None                  # why the draft is out of date, if it is
        self.last_resolve_changes: list[dict] = []
        # People taken off shows by an edit (a musician or show deleted) since the last solve. The
        # edit prunes them from the draft straight away, so the next solve's diff can't see them —
        # they're kept here, already named, so its summary can still say who came off and why.
        self.pending_removals: list[dict] = []
        self.lock = threading.RLock()
        self.last_used = time.monotonic()
        self._save_data = save_data
        self._save_state = save_state

    # ------------------------------------------------------------------ derived state

    def upcoming_show_ids(self) -> list[str]:
        return list(self.data.shows[self.data.shows.period == "upcoming"].index)

    def banned_pairs(self) -> set[tuple[str, str]]:
        """Every (musician, show) pair a ban rules out, with facility bans expanded to shows."""
        shows = self.data.shows
        pairs = set()
        for musician_id, scope, target in self.bans:
            if scope == "show":
                pairs.add((musician_id, target))
            else:
                pairs.update((musician_id, s) for s in shows.index[shows.facility_id == target])
        return pairs

    def require_draft(self) -> Schedule:
        if self.draft is None:
            self.solve()
        return self.draft

    def has_unpublished_changes(self) -> bool:
        """Compares everything a coordinator would care about — who's on each show, how many
        songs they play, and the ranked backups — not just who's on which show."""
        if self.draft is None:
            return False
        if self.published is None:
            return True

        def signature(schedule: Schedule) -> tuple[set, set]:
            return ({(r.show_id, r.musician_id, int(r.songs)) for r in schedule.assignments.itertuples()},
                    {(r.show_id, r.musician_id, int(r.rank)) for r in schedule.backups.itertuples()})
        return signature(self.draft) != signature(self.published)

    def unpublished_roster_changes(self) -> list[dict]:
        if self.draft is None or self.published is None:
            return []
        return self._diff(self.published.assignments, self.draft.assignments)

    # ------------------------------------------------------------------ solve / publish

    def solve(self) -> list[dict]:
        previous = self.draft.assignments if self.draft is not None else None
        result = solve_assignment(
            self.data, time_limit_s=SOLVE_TIME_LIMIT_S, locked=self.locks,
            banned={(m, t) for m, scope, t in self.bans if scope == "show"},
            banned_facilities={(m, t) for m, scope, t in self.bans if scope == "facility"},
            previous=previous)
        if result.status not in ("OPTIMAL", "FEASIBLE"):
            if self.locks:
                raise WorkspaceError(
                    "Couldn't build a schedule with the current locks. The usual cause is one musician "
                    "locked onto two shows on the same day — remove one of those locks and try again.")
            raise WorkspaceError("Couldn't build a schedule in time. Try again, or with fewer changes at once.")
        backups = assign_backups(self.data, result.assignments, excluded=self.banned_pairs()).backups
        changes = (self._diff(previous, result.assignments, self.pending_removals)
                   if previous is not None else [])
        self.pending_removals = []
        self.draft = Schedule(result.assignments, backups)
        self.needs_resolve = None
        self.last_resolve_changes = changes
        self._persist(state=True)
        return changes

    def publish(self) -> None:
        self.published = self.require_draft()
        self._persist(state=True)

    def _name(self, musician_id: str) -> str:
        m = self.data.musicians
        return str(m.at[musician_id, "display_name"]) if musician_id in m.index else "a removed musician"

    def _diff(self, old: pd.DataFrame, new: pd.DataFrame, removed_before: list[dict] = ()) -> list[dict]:
        old_pairs, new_pairs = _pairs(old), _pairs(new)
        banned = self.banned_pairs()
        changes = list(removed_before)
        for m, s in sorted(old_pairs - new_pairs, key=lambda p: (p[1], p[0])):
            if m not in self.data.musicians.index:
                reason = "musician was removed from the roster"
            elif s not in self.data.shows.index:
                reason = "show was removed"
            elif (m, s) in banned:
                reason = "banned from this show"
            elif not self.data.is_available(m, s):
                reason = "no longer available for this show"
            else:
                reason = "moved to rebalance the schedule"
            changes.append(dict(change="removed", musician_id=m, show_id=s, reason=reason))
        old_shows = {s for _, s in old_pairs} | {c["show_id"] for c in removed_before}
        removed_by_show: dict[str, list[str]] = {}
        for c in changes:
            removed_by_show.setdefault(c["show_id"], []).append(c.get("musician_name") or self._name(c["musician_id"]))
        for m, s in sorted(new_pairs - old_pairs, key=lambda p: (p[1], p[0])):
            if s not in old_shows:
                reason = "new show that needed musicians"
            elif s in removed_by_show:
                reason = "replacing " + ", ".join(removed_by_show[s])
            else:
                reason = "fills a gap in songs or headcount"
            changes.append(dict(change="added", musician_id=m, show_id=s, reason=reason))
        return changes

    # ------------------------------------------------------------------ roster edits

    def mutate_data(self, fn: Callable[[Data], Data], stale_reason: str | Callable[[], str]) -> None:
        """Apply a validated roster edit (data.py's CRUD functions raise before anything changes).
        The draft is kept — only pruned of rows pointing at things that no longer exist — and
        marked stale, so the coordinator decides when to re-solve. `stale_reason` may be a function,
        called after the edit, when the wording depends on the edited data."""
        old_data = self.data
        before = _pairs(self.draft.assignments) if self.draft is not None else set()
        self.data = fn(old_data)
        self._prune()
        if self.draft is not None:
            self._note_removals(old_data, before - _pairs(self.draft.assignments))
        if self.draft is not None:
            self.needs_resolve = stale_reason() if callable(stale_reason) else stale_reason
        self._persist(data=True, state=True)

    def _note_removals(self, old_data: Data, dropped: set[tuple[str, str]]) -> None:
        """Name the pairs an edit just pruned, from the data as it was before the edit."""
        for m, s in sorted(dropped, key=lambda p: (p[1], p[0])):
            show = old_data.shows.loc[s]
            self.pending_removals.append(dict(
                change="removed", musician_id=m, show_id=s,
                reason=("removed from the roster" if m not in self.data.musicians.index else "show was removed"),
                musician_name=str(old_data.musicians.at[m, "display_name"]),
                date=str(show.date), start_time=str(show.start_time),
                facility_name=str(old_data.facilities.at[show.facility_id, "display_name"])))

    def _prune(self) -> None:
        musicians = set(self.data.musicians.index)
        upcoming = set(self.upcoming_show_ids())
        facilities = set(self.data.facilities.index)

        def keep(df: pd.DataFrame) -> pd.DataFrame:
            return df[df.musician_id.isin(musicians) & df.show_id.isin(upcoming)].reset_index(drop=True)

        if self.draft is not None:
            self.draft = Schedule(keep(self.draft.assignments), keep(self.draft.backups))
        if self.published is not None:
            self.published = Schedule(keep(self.published.assignments), keep(self.published.backups))
        self.locks = {(m, s) for m, s in self.locks if m in musicians and s in upcoming}
        self.bans = {(m, scope, t) for m, scope, t in self.bans
                     if m in musicians and (t in upcoming if scope == "show" else t in facilities)}

    # ------------------------------------------------------------------ locks / bans

    def add_lock(self, musician_id: str, show_id: str) -> None:
        if (musician_id, show_id) not in _pairs(self.require_draft().assignments):
            raise WorkspaceError("Only a musician who's already on this show can be locked to it.")
        if (musician_id, show_id) in self.banned_pairs():
            raise WorkspaceError("That musician is banned from this show — remove the ban first.")
        self.locks.add((musician_id, show_id))
        self._persist(state=True)

    def remove_lock(self, musician_id: str, show_id: str) -> None:
        self.locks.discard((musician_id, show_id))
        self._persist(state=True)

    def add_ban(self, musician_id: str, scope: str, target_id: str) -> None:
        if scope not in ("show", "facility"):
            raise WorkspaceError("A ban is either for one show or for a whole location.")
        if musician_id not in self.data.musicians.index:
            raise WorkspaceError(f"No musician {musician_id}.")
        valid_targets = self.upcoming_show_ids() if scope == "show" else list(self.data.facilities.index)
        if target_id not in valid_targets:
            raise WorkspaceError("That location doesn't exist." if scope == "facility" else "That show isn't upcoming.")

        if scope == "show":
            affected = {(musician_id, target_id)}
        else:
            shows = self.data.shows
            affected = {(musician_id, s) for s in shows.index[shows.facility_id == target_id]}
        if affected & self.locks:
            raise WorkspaceError("That musician is locked onto a show this ban covers — unlock it first.")

        self.bans.add((musician_id, scope, target_id))
        draft = self.require_draft()
        if affected & (_pairs(draft.assignments) | _pairs(draft.backups)):
            self.needs_resolve = "A new ban covers someone already scheduled — re-solve to apply it."
        self._persist(state=True)

    def remove_ban(self, musician_id: str, scope: str, target_id: str) -> None:
        self.bans.discard((musician_id, scope, target_id))
        self._persist(state=True)

    # ------------------------------------------------------------------ cancellations

    def plan_cancellation(self, show_id: str, musician_id: str, backup_choice: str = "auto") -> CancellationPlan:
        draft = self.require_draft()
        if (musician_id, show_id) not in _pairs(draft.assignments):
            raise WorkspaceError("That musician isn't on this show.")
        banned = self.banned_pairs()
        backups = draft.backups[[(m, s) not in banned for m, s in zip(draft.backups.musician_id, draft.backups.show_id)]]
        try:
            return handle_cancellation(self.data, draft.assignments, backups, show_id, musician_id, backup_choice)
        except ValueError as e:
            raise WorkspaceError(str(e)) from e

    def apply_cancellation(self, show_id: str, musician_id: str, backup_choice: str,
                           accept_extra_songs: bool, add_suggested_musician: bool) -> CancellationPlan:
        plan = self.plan_cancellation(show_id, musician_id, backup_choice)
        a = self.draft.assignments
        a = a[~((a.show_id == show_id) & (a.musician_id == musician_id))].copy()

        added = [plan.activated_backup_id] if plan.activated_backup_id else []
        if add_suggested_musician and plan.additional_backup_id:
            added.append(plan.additional_backup_id)
        for new_id in added:
            typical = int(self.data.musicians.at[new_id, "typical_songs"])
            a = pd.concat([a, pd.DataFrame([dict(show_id=show_id, musician_id=new_id, songs=typical)])],
                          ignore_index=True)
        if accept_extra_songs:
            for extra_id, add in plan.extra_song_requests:
                a.loc[(a.show_id == show_id) & (a.musician_id == extra_id), "songs"] += add

        # Record the dropout in the roster itself, so no later re-solve puts them back.
        self.data = set_show_availability(self.data, musician_id, show_id, False)
        self.locks.discard((musician_id, show_id))
        a = a.reset_index(drop=True)
        self.draft = Schedule(a, self._refill_backups(show_id, a))
        self._persist(data=True, state=True)
        return plan

    def _refill_backups(self, show_id: str, assignments: pd.DataFrame) -> pd.DataFrame:
        """Re-rank just this show's backups (someone may have just been promoted off the list),
        without reshuffling any other show's — only honoring that nobody backs up two shows the
        same day."""
        backups = self.draft.backups
        others = backups[backups.show_id != show_id]
        date = self.data.shows.at[show_id, "date"]
        same_day = set(self.data.shows.index[self.data.shows.date == date])
        already = {date: set(others[others.show_id.isin(same_day)].musician_id)}
        fresh = assign_backups(self.data, assignments, show_ids=[show_id], excluded=self.banned_pairs(),
                               already_backing=already).backups
        return pd.concat([others, fresh], ignore_index=True)[BACKUP_COLS]

    # ------------------------------------------------------------------ persistence

    def _persist(self, data: bool = False, state: bool = False) -> None:
        if data and self._save_data:
            self._save_data(self.data)
        if state and self._save_state:
            self._save_state(self)
