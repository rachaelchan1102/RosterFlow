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
from datetime import datetime, timezone
from typing import Callable

import pandas as pd

from optimizer.assignment import solve_assignment
from optimizer.backups import assign_backups
from optimizer.cancellation import CancellationPlan, handle_cancellation
from optimizer.data import Data, record_attendance, set_show_availability

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


@dataclass
class Snapshot:
    """Everything needed to fully restore a workspace to one point in time. `Data`, a `Schedule`
    and a completed edit's resulting sets are never mutated in place after being produced — every
    change builds a new object — so holding onto these references costs nothing extra; only the
    still-live, in-place-mutated `locks`/`bans` sets need an actual copy at snapshot time."""
    data: Data
    draft: Schedule | None
    locks: frozenset[tuple[str, str]]
    bans: frozenset[tuple[str, str, str]]
    pending_calls: frozenset[tuple[str, str]]      # (show_id, musician_id) — asked, waiting to hear back
    confirmed: frozenset[tuple[str, str]]          # (musician_id, show_id) — said yes
    song_titles: frozenset[tuple[str, str, str]]   # (musician_id, show_id, title)
    needs_resolve: str | None


@dataclass
class AuditEntry:
    """One entry in the workspace's version history — a "commit," not a single Ctrl+Z step.
    `snapshot` is the state as it was immediately BEFORE this entry's action ran, so "revert to
    before this" is just "restore `snapshot`." """
    id: int
    at: str                        # ISO 8601 UTC
    description: str
    fill_seconds: float | None     # time from noticing to resolving, for a cancellation entry
    snapshot: Snapshot


class Workspace:
    def __init__(self, data: Data,
                 save_data: Callable[[Data], None] | None = None,
                 save_state: Callable[["Workspace"], None] | None = None,
                 save_audit: Callable[[AuditEntry], None] | None = None):
        self.data = data
        self.draft: Schedule | None = None
        self.published: Schedule | None = None
        self.locks: set[tuple[str, str]] = set()               # (musician_id, show_id)
        self.bans: set[tuple[str, str, str]] = set()           # (musician_id, "show" | "facility", target_id)
        # A backup who's been asked to fill in but hasn't confirmed yet — not on the show, not
        # counted in any coverage number, until confirm_pending moves them into the draft.
        self.pending_calls: dict[str, str] = {}                 # show_id -> musician_id
        # Being on the draft only means the solver (or a coordinator) put someone on a show — it
        # never meant they'd actually said yes. This is that separate, explicit "they told me
        # they're coming" mark, one the coordinator sets by hand per person per show; nothing
        # clears it automatically except that person coming off the show.
        self.confirmed: set[tuple[str, str]] = set()           # (musician_id, show_id)
        # What a musician is actually bringing to a specific show, in their own words — songs
        # were always just a count everywhere else (the solver only ever needs how many, never
        # which), so this is a coordinator-facing note layered on top, not something the solver
        # reads. Set to "" to clear.
        self.song_titles: dict[tuple[str, str], str] = {}      # (musician_id, show_id) -> title
        self.needs_resolve: str | None = None                  # why the draft is out of date, if it is
        self.last_resolve_changes: list[dict] = []
        # $/km reimbursed for car travel — a coordinator-set figure, not something the solver reads;
        # it only turns the car-km KPIs already computed into a dollar figure for the control tower.
        self.mileage_rate: float = 0.68
        # People taken off shows by an edit (a musician or show deleted) since the last solve. The
        # edit prunes them from the draft straight away, so the next solve's diff can't see them —
        # they're kept here, already named, so its summary can still say who came off and why.
        self.pending_removals: list[dict] = []
        # Version history: one entry per action that changed anything, oldest first. Append-only —
        # a revert adds a new "Reverted: ..." entry rather than deleting what it undoes, the same
        # way `git revert` works. See revert() below.
        self.audit_log: list[AuditEntry] = []
        self._audit_seq = 0
        self.lock = threading.RLock()
        self.last_used = time.monotonic()
        self._save_data = save_data
        self._save_state = save_state
        self._save_audit = save_audit

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
        # Captured before the solve, not after — an entry's snapshot is always "state right
        # before this action," so reverting an update restores exactly what was there first.
        before = self._snapshot() if previous is not None else None
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
        # A full re-solve starts the draft over from the optimizer's own output — any call still
        # waiting on an answer no longer has a place to land, so it's cleared rather than risking
        # a confirm later double-booking whoever the solver put in that slot instead.
        self.pending_calls = {}
        self.draft = Schedule(result.assignments, backups)
        # Same reasoning as locks staying locked across a resolve: someone still on the show keeps
        # their confirmation, someone the solver moved off it doesn't carry it to whatever show
        # they landed on instead.
        self.confirmed &= _pairs(result.assignments)
        still_on = _pairs(result.assignments)
        self.song_titles = {(m, s): t for (m, s), t in self.song_titles.items() if (m, s) in still_on}
        self.needs_resolve = None
        self.last_resolve_changes = changes
        if before is not None:
            n = len(changes)
            desc = f"Schedule updated — {n} change{'s' if n != 1 else ''}" if n else "Schedule updated — no one needed to move"
            self._record(desc, before)
        self._persist(state=True)
        return changes

    def publish(self) -> None:
        self.published = self.require_draft()
        self._persist(state=True)

    def _name(self, musician_id: str) -> str:
        m = self.data.musicians
        return str(m.at[musician_id, "display_name"]) if musician_id in m.index else "a removed musician"

    def _show_label(self, show_id: str) -> str:
        show = self.data.shows.loc[show_id]
        fac_name = self.data.facilities.at[show.facility_id, "display_name"]
        return f"{fac_name} ({show.date})"

    def _was_short(self, show_id: str, old_roster: pd.DataFrame | None) -> bool:
        """Whether this show was genuinely below target headcount or songs BEFORE this batch of
        changes — the honest test for "fills a gap," instead of assuming every addition to an
        existing show must be covering one."""
        if show_id not in self.data.shows.index:
            return False
        fac = self.data.facilities.loc[self.data.shows.at[show_id, "facility_id"]]
        roster = old_roster if old_roster is not None else pd.DataFrame(columns=["musician_id", "songs"])
        return len(roster) < int(fac.target_musicians) or int(roster.songs.sum()) < int(fac.songs_per_show)

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
        old_roster_by_show: dict[str, pd.DataFrame] = {s: old[old.show_id == s] for s in old.show_id.unique()} if len(old) else {}
        for m, s in sorted(new_pairs - old_pairs, key=lambda p: (p[1], p[0])):
            if s not in old_shows:
                reason = "new show that needed musicians"
            elif s in removed_by_show:
                reason = "replacing " + ", ".join(removed_by_show[s])
            elif self._was_short(s, old_roster_by_show.get(s)):
                reason = "fills a gap in songs or headcount"
            else:
                # The show was already at target before this — the solver still reassigned
                # people to improve fairness, travel, or rotation, not to cover a real shortfall.
                reason = "improves workload balance, travel, or rotation on this show"
            changes.append(dict(change="added", musician_id=m, show_id=s, reason=reason))
        return changes

    # ------------------------------------------------------------------ roster edits

    def mutate_data(self, fn: Callable[[Data], Data], stale_reason: str | Callable[[], str]) -> None:
        """Apply a validated roster edit (data.py's CRUD functions raise before anything changes).
        The draft is kept — only pruned of rows pointing at things that no longer exist — and
        marked stale, so the coordinator decides when to re-solve. `stale_reason` may be a function,
        called after the edit, when the wording depends on the edited data — the same plain-language
        text doubles as this action's audit log description, since it's already worded for a
        coordinator to read."""
        before = self._snapshot()
        old_data = self.data
        old_pairs = _pairs(self.draft.assignments) if self.draft is not None else set()
        self.data = fn(old_data)
        self._prune()
        if self.draft is not None:
            self._note_removals(old_data, old_pairs - _pairs(self.draft.assignments))
        description = stale_reason() if callable(stale_reason) else stale_reason
        if self.draft is not None:
            self.needs_resolve = description
        self._record(description, before)
        self._persist(data=True, state=True)

    def check_in_attendance(self, show_id: str, records: list[dict]) -> None:
        """Who actually showed up, recorded after the fact — deliberately NOT routed through
        mutate_data: it changes history, not the roster or the current draft, so it has no
        business marking the schedule stale the way editing a musician or a show does."""
        if show_id not in self.data.shows.index:
            raise WorkspaceError("That show doesn't exist.")
        before = self._snapshot()
        self.data = record_attendance(self.data, show_id, records)
        n = len(records)
        self._record(f"Attendance recorded for {self._show_label(show_id)} — {n} musician{'s' if n != 1 else ''}.", before)
        self._persist(data=True, state=True)

    def self_service_respond(self, musician_id: str, responses: list[tuple[str, bool]]) -> None:
        """A musician's own yes/no answers, submitted through their self-service link with no
        login — goes through the exact same path (mutate_data) a coordinator's own availability
        edit would, so it's staleness-flagged and audited the same way, and never silently
        reshuffles anyone already on a show; a re-solve is still the coordinator's call."""
        if musician_id not in self.data.musicians.index:
            raise WorkspaceError("No such musician.")
        valid = set(self.upcoming_show_ids())
        if any(show_id not in valid for show_id, _ in responses):
            raise WorkspaceError("One of those shows is no longer upcoming — refresh the page and try again.")

        def apply(d: Data) -> Data:
            for show_id, available in responses:
                d = set_show_availability(d, musician_id, show_id, available)
            return d

        n = len(responses)
        self.mutate_data(apply, f"{self._name(musician_id)} updated their availability for {n} "
                                f"show{'s' if n != 1 else ''} through their self-service link.")

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
        self.pending_calls = {s: m for s, m in self.pending_calls.items() if m in musicians and s in upcoming}
        # Being confirmed only means something while actually on the show — an edit or re-solve
        # that moves someone off it drops the mark rather than letting it silently point at a
        # show they're no longer playing.
        still_on = _pairs(self.draft.assignments) if self.draft is not None else set()
        self.confirmed = {(m, s) for m, s in self.confirmed if (m, s) in still_on}
        self.song_titles = {(m, s): t for (m, s), t in self.song_titles.items() if (m, s) in still_on}

    # ------------------------------------------------------------------ locks / bans

    def add_lock(self, musician_id: str, show_id: str) -> None:
        if (musician_id, show_id) not in _pairs(self.require_draft().assignments):
            raise WorkspaceError("Only a musician who's already on this show can be locked to it.")
        if (musician_id, show_id) in self.banned_pairs():
            raise WorkspaceError("That musician is banned from this show — remove the ban first.")
        before = self._snapshot()
        self.locks.add((musician_id, show_id))
        self._record(f"Locked {self._name(musician_id)} to {self._show_label(show_id)}", before)
        self._persist(state=True)

    def remove_lock(self, musician_id: str, show_id: str) -> None:
        if (musician_id, show_id) not in self.locks:
            return
        before = self._snapshot()
        self.locks.discard((musician_id, show_id))
        self._record(f"Unlocked {self._name(musician_id)} from {self._show_label(show_id)}", before)
        self._persist(state=True)

    def confirm_musician(self, musician_id: str, show_id: str) -> None:
        if (musician_id, show_id) not in _pairs(self.require_draft().assignments):
            raise WorkspaceError("Only a musician who's already on this show can be marked confirmed.")
        before = self._snapshot()
        self.confirmed.add((musician_id, show_id))
        self._record(f"{self._name(musician_id)} confirmed for {self._show_label(show_id)}", before)
        self._persist(state=True)

    def unconfirm_musician(self, musician_id: str, show_id: str) -> None:
        if (musician_id, show_id) not in self.confirmed:
            return
        before = self._snapshot()
        self.confirmed.discard((musician_id, show_id))
        self._record(f"{self._name(musician_id)} un-confirmed for {self._show_label(show_id)}", before)
        self._persist(state=True)

    def set_song_title(self, musician_id: str, show_id: str, title: str) -> None:
        if (musician_id, show_id) not in _pairs(self.require_draft().assignments):
            raise WorkspaceError("Only a musician who's already on this show can have a song noted.")
        before = self._snapshot()
        title = title.strip()
        if title:
            self.song_titles[(musician_id, show_id)] = title
        else:
            self.song_titles.pop((musician_id, show_id), None)
        shown = repr(title) if title else "blank"
        self._record(f"{self._name(musician_id)}'s song for {self._show_label(show_id)} set to {shown}", before)
        self._persist(state=True)

    def set_mileage_rate(self, rate: float) -> None:
        """A coordinator preference, not an edit to the schedule itself — no audit entry, no undo."""
        if rate < 0:
            raise WorkspaceError("Mileage rate can't be negative.")
        self.mileage_rate = rate
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

        before = self._snapshot()
        target_label = self._show_label(target_id) if scope == "show" else self.data.facilities.at[target_id, "display_name"]
        self.bans.add((musician_id, scope, target_id))
        draft = self.require_draft()
        if affected & (_pairs(draft.assignments) | _pairs(draft.backups)):
            self.needs_resolve = "A new ban covers someone already scheduled — re-solve to apply it."
        self._record(f"Banned {self._name(musician_id)} from {target_label}", before)
        self._persist(state=True)

    def remove_ban(self, musician_id: str, scope: str, target_id: str) -> None:
        if (musician_id, scope, target_id) not in self.bans:
            return
        before = self._snapshot()
        target_label = self._show_label(target_id) if scope == "show" and target_id in self.data.shows.index \
            else self.data.facilities.at[target_id, "display_name"] if target_id in self.data.facilities.index else target_id
        self.bans.discard((musician_id, scope, target_id))
        self._record(f"Removed {self._name(musician_id)}'s ban on {target_label}", before)
        self._persist(state=True)

    # ------------------------------------------------------------------ cancellations

    def plan_cancellation(self, show_id: str, musician_id: str, backup_choice: str = "auto") -> CancellationPlan:
        draft = self.require_draft()
        if (musician_id, show_id) not in _pairs(draft.assignments):
            raise WorkspaceError("That musician isn't on this show.")
        if show_id in self.pending_calls and backup_choice != "none":
            raise WorkspaceError(f"{self._name(self.pending_calls[show_id])} is already waiting to hear back for "
                                 f"this show — confirm or decline them first.")
        banned = self.banned_pairs()
        backups = draft.backups[[(m, s) not in banned for m, s in zip(draft.backups.musician_id, draft.backups.show_id)]]
        try:
            return handle_cancellation(self.data, draft.assignments, backups, show_id, musician_id, backup_choice)
        except ValueError as e:
            raise WorkspaceError(str(e)) from e

    def apply_cancellation(self, show_id: str, musician_id: str, backup_choice: str,
                           accept_extra_songs: bool, add_suggested_musician: bool,
                           fill_seconds: float | None = None) -> CancellationPlan:
        """The chosen backup (`plan.activated_backup_id`) is never added to the show here — being
        picked isn't the same as having said yes. It goes into `pending_calls` instead, and only
        joins the draft once `confirm_pending` is called for real, after the coordinator's heard
        back. The suggested extra musician and the extra-song asks are different: ticking their
        checkboxes already IS the coordinator saying they've confirmed it, so those apply now."""
        before = self._snapshot()
        plan = self.plan_cancellation(show_id, musician_id, backup_choice)
        a = self.draft.assignments
        a = a[~((a.show_id == show_id) & (a.musician_id == musician_id))].copy()

        if add_suggested_musician and plan.additional_backup_id:
            typical = int(self.data.musicians.at[plan.additional_backup_id, "typical_songs"])
            a = pd.concat([a, pd.DataFrame([dict(show_id=show_id, musician_id=plan.additional_backup_id, songs=typical)])],
                          ignore_index=True)
        if accept_extra_songs:
            for extra_id, add in plan.extra_song_requests:
                a.loc[(a.show_id == show_id) & (a.musician_id == extra_id), "songs"] += add

        # Record the dropout in the roster itself, so no later re-solve puts them back.
        show_label = self._show_label(show_id)
        cancelled_name = self._name(musician_id)
        self.data = set_show_availability(self.data, musician_id, show_id, False)
        self.locks.discard((musician_id, show_id))
        a = a.reset_index(drop=True)
        self.draft = Schedule(a, self._refill_backups(show_id, a))
        if plan.activated_backup_id:
            self.pending_calls[show_id] = plan.activated_backup_id
            backup_part = f"{self._name(plan.activated_backup_id)} asked to fill in — waiting to hear back"
        else:
            backup_part = "no backup was available to call"
        if add_suggested_musician and plan.additional_backup_id:
            backup_part += f", {self._name(plan.additional_backup_id)} added too"
        self._record(f"{cancelled_name} cancelled for {show_label} — {backup_part}", before, fill_seconds=fill_seconds)
        self._persist(data=True, state=True)
        return plan

    def confirm_pending(self, show_id: str) -> None:
        if show_id not in self.pending_calls:
            raise WorkspaceError("There's no one waiting to hear back for this show.")
        before = self._snapshot()
        musician_id = self.pending_calls.pop(show_id)
        typical = int(self.data.musicians.at[musician_id, "typical_songs"])
        a = pd.concat([self.draft.assignments,
                      pd.DataFrame([dict(show_id=show_id, musician_id=musician_id, songs=typical)])],
                     ignore_index=True).reset_index(drop=True)
        self.draft = Schedule(a, self._refill_backups(show_id, a))
        self._record(f"{self._name(musician_id)} confirmed for {self._show_label(show_id)}", before)
        self._persist(state=True)

    def decline_pending(self, show_id: str) -> None:
        if show_id not in self.pending_calls:
            raise WorkspaceError("There's no one waiting to hear back for this show.")
        before = self._snapshot()
        musician_id = self.pending_calls.pop(show_id)
        self._record(f"{self._name(musician_id)} said no for {self._show_label(show_id)} — pick someone else", before)
        self._persist(state=True)

    def add_to_show(self, show_id: str, musician_id: str) -> None:
        """A direct "put this person on this show" — for filling an open seat that isn't the
        result of anyone cancelling (an understaffed show from the start, or a coordinator who
        just knows someone who'd say yes). Goes straight onto the draft, no pending step: unlike
        a cancellation's backup call, the coordinator picking a specific free person here already
        implies they've squared it with them."""
        draft = self.require_draft()
        if show_id not in self.data.shows.index:
            raise WorkspaceError("That show doesn't exist.")
        if musician_id not in self.data.musicians.index:
            raise WorkspaceError("That musician doesn't exist.")
        if (musician_id, show_id) in _pairs(draft.assignments):
            raise WorkspaceError(f"{self._name(musician_id)} is already on this show.")
        if (musician_id, show_id) in self.banned_pairs():
            raise WorkspaceError(f"{self._name(musician_id)} is banned from this show.")
        if not self.data.is_available(musician_id, show_id):
            raise WorkspaceError(f"{self._name(musician_id)} isn't free for this show.")
        date = self.data.shows.at[show_id, "date"]
        same_day = set(self.data.shows.index[self.data.shows.date == date])
        busy = set(draft.assignments.loc[draft.assignments.show_id.isin(same_day), "musician_id"])
        if musician_id in busy:
            raise WorkspaceError(f"{self._name(musician_id)} is already playing another show that day.")
        facility_id = self.data.shows.at[show_id, "facility_id"]
        if not self.data.within_guardian_range(musician_id, facility_id):
            raise WorkspaceError(f"{self._name(musician_id)} is a minor who needs a guardian nearby — "
                                 f"this location is too far from home.")
        row = self.data.musicians.loc[musician_id]
        if (row.instrument == "piano" and not self.data.facilities.at[facility_id, "has_piano_onsite"]
                and not row.brings_keyboard):
            raise WorkspaceError(f"{self._name(musician_id)} plays piano but doesn't bring a keyboard, "
                                 f"and this location has no piano in the room.")

        before = self._snapshot()
        typical = int(self.data.musicians.at[musician_id, "typical_songs"])
        a = pd.concat([draft.assignments, pd.DataFrame([dict(show_id=show_id, musician_id=musician_id, songs=typical)])],
                      ignore_index=True).reset_index(drop=True)
        self.draft = Schedule(a, self._refill_backups(show_id, a))
        self._record(f"{self._name(musician_id)} added to {self._show_label(show_id)}", before)
        self._persist(state=True)

    def swap_across_shows(self, show_a: str, musician_a: str, show_b: str, musician_b: str) -> None:
        """Trade two musicians between two same-day shows — the fix for a "crossing flow" (each
        is closer to the OTHER show than their own, so their routes cross on the map instead of
        each heading toward their own side of town). Headcount and pianist coverage on both shows
        are unchanged (a straight 1-for-1 swap); each plays their own usual song count at the new
        location, same as any other add. No re-solve — this is a routing fix, not a staffing one."""
        draft = self.require_draft()
        for show_id, musician_id in ((show_a, musician_a), (show_b, musician_b)):
            if show_id not in self.data.shows.index:
                raise WorkspaceError("That show doesn't exist.")
            if musician_id not in self.data.musicians.index:
                raise WorkspaceError("That musician doesn't exist.")
            if (musician_id, show_id) not in _pairs(draft.assignments):
                raise WorkspaceError(f"{self._name(musician_id)} isn't on {self._show_label(show_id)}.")
        if self.data.shows.at[show_a, "date"] != self.data.shows.at[show_b, "date"]:
            raise WorkspaceError("A swap only makes sense between shows on the same date.")
        if show_a == show_b:
            raise WorkspaceError("Pick two different shows to swap between.")

        for show_id, musician_id in ((show_a, musician_b), (show_b, musician_a)):
            if (musician_id, show_id) in self.banned_pairs():
                raise WorkspaceError(f"{self._name(musician_id)} is banned from {self._show_label(show_id)}.")
            if not self.data.is_available(musician_id, show_id):
                raise WorkspaceError(f"{self._name(musician_id)} isn't free for {self._show_label(show_id)}.")
            facility_id = self.data.shows.at[show_id, "facility_id"]
            if not self.data.within_guardian_range(musician_id, facility_id):
                raise WorkspaceError(f"{self._name(musician_id)} is a minor who needs a guardian nearby — "
                                     f"{self._show_label(show_id)} is too far from home.")
            row = self.data.musicians.loc[musician_id]
            if (row.instrument == "piano" and not self.data.facilities.at[facility_id, "has_piano_onsite"]
                    and not row.brings_keyboard):
                raise WorkspaceError(f"{self._name(musician_id)} plays piano but doesn't bring a keyboard, "
                                     f"and {self._show_label(show_id)} has no piano in the room.")

        before = self._snapshot()
        a = draft.assignments.copy()
        typical_a = int(self.data.musicians.at[musician_a, "typical_songs"])
        typical_b = int(self.data.musicians.at[musician_b, "typical_songs"])
        a.loc[(a.show_id == show_a) & (a.musician_id == musician_a), ["show_id", "songs"]] = [show_b, typical_a]
        a.loc[(a.show_id == show_b) & (a.musician_id == musician_b), ["show_id", "songs"]] = [show_a, typical_b]
        a = a.reset_index(drop=True)
        # Both shows' backups need re-ranking in one pass (not two separate _refill_backups
        # calls) — each reads self.draft.backups fresh, so a second call would silently discard
        # the first one's update instead of building on it.
        backups = self.draft.backups
        others = backups[~backups.show_id.isin([show_a, show_b])]
        date = self.data.shows.at[show_a, "date"]
        same_day = set(self.data.shows.index[self.data.shows.date == date])
        already = {date: set(others[others.show_id.isin(same_day)].musician_id)}
        fresh = assign_backups(self.data, a, show_ids=[show_a, show_b], excluded=self.banned_pairs(),
                               already_backing=already).backups
        b = pd.concat([others, fresh], ignore_index=True)[BACKUP_COLS]
        self.draft = Schedule(a, b)
        self._record(f"{self._name(musician_a)} and {self._name(musician_b)} swapped between "
                     f"{self._show_label(show_a)} and {self._show_label(show_b)} — a shorter drive for both", before)
        self._persist(state=True)

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

    # ------------------------------------------------------------------ version history / revert

    def _snapshot(self) -> Snapshot:
        return Snapshot(self.data, self.draft, frozenset(self.locks), frozenset(self.bans),
                        frozenset(self.pending_calls.items()), frozenset(self.confirmed),
                        frozenset((m, s, t) for (m, s), t in self.song_titles.items()), self.needs_resolve)

    def _record(self, description: str, snapshot: Snapshot, fill_seconds: float | None = None) -> None:
        self._audit_seq += 1
        entry = AuditEntry(id=self._audit_seq, at=datetime.now(timezone.utc).isoformat(),
                           description=description, fill_seconds=fill_seconds, snapshot=snapshot)
        self.audit_log.append(entry)
        if self._save_audit:
            self._save_audit(entry)

    def restore_audit_log(self, entries: list[AuditEntry]) -> None:
        """Used once, at coordinator startup, to load history saved from a previous run — new
        entries then continue the id sequence rather than colliding with old ones."""
        self.audit_log = entries
        self._audit_seq = max((e.id for e in entries), default=0)

    def _find_entry(self, entry_id: int) -> int:
        for i, e in enumerate(self.audit_log):
            if e.id == entry_id:
                return i
        raise WorkspaceError("That change is no longer in the history — it may have been superseded by a revert.")

    def revert_preview(self, entry_id: int) -> list[str]:
        """Descriptions of every entry that happened after `entry_id` — reverting to before it
        discards their effect too, even though their own record stays in the log."""
        idx = self._find_entry(entry_id)
        return [e.description for e in self.audit_log[idx + 1:]]

    def entry_changes(self, entry_id: int) -> list[dict]:
        """The roster diff this ONE entry actually made — its "before" snapshot compared against
        whatever ran next (the following entry's "before", or the current draft if this is the
        latest entry). Lets the Activity page show the same per-show/per-musician breakdown the
        update bar shows right after a live resolve, for any past entry, not just the most recent.
        Reason text (why a change happened) is built against CURRENT bans/availability/roster,
        same as a live diff — for an old entry that can be slightly stale (a since-lifted ban
        would no longer explain a removal the way it did at the time), but the added/removed
        facts themselves come straight from the real snapshots either side, so those are exact."""
        idx = self._find_entry(entry_id)
        before = self.audit_log[idx].snapshot.draft
        after = self.audit_log[idx + 1].snapshot.draft if idx + 1 < len(self.audit_log) else self.draft
        before_a = before.assignments if before is not None else pd.DataFrame(columns=ASSIGNMENT_COLS)
        after_a = after.assignments if after is not None else pd.DataFrame(columns=ASSIGNMENT_COLS)
        return self._diff(before_a, after_a)

    def revert(self, entry_id: int) -> None:
        """Restores the state as it was immediately before `entry_id` ran — closer to `git
        revert` than a single undo: it doesn't erase what happened, it adds a new entry that
        moves the workspace back to an earlier point. Call revert_preview first and confirm with
        the coordinator if it isn't empty; this doesn't ask on its own."""
        idx = self._find_entry(entry_id)
        entry = self.audit_log[idx]
        current = self._snapshot()
        self.data, self.draft = entry.snapshot.data, entry.snapshot.draft
        self.locks, self.bans = set(entry.snapshot.locks), set(entry.snapshot.bans)
        self.pending_calls = dict(entry.snapshot.pending_calls)
        self.confirmed = set(entry.snapshot.confirmed)
        self.song_titles = {(m, s): t for m, s, t in entry.snapshot.song_titles}
        self.needs_resolve = entry.snapshot.needs_resolve
        self._record(f"Reverted: {entry.description}", current)
        self._persist(data=True, state=True)

    # ------------------------------------------------------------------ persistence

    def _persist(self, data: bool = False, state: bool = False) -> None:
        if data and self._save_data:
            self._save_data(self.data)
        if state and self._save_state:
            self._save_state(self)
