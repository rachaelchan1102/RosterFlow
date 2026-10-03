"""Regressions from a tester's walkthrough of the live demo.

The first group needs no database. The shared-session test needs TEST_DSN (see
test_coordinator_login.py) and is skipped without it.
"""
import os
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

from backend.registry import Registry
from optimizer.backups import assign_backups
from optimizer.data import add_show

SAMPLE = Path(__file__).resolve().parent.parent / "sample_data"
DSN = os.environ.get("TEST_DSN")


@pytest.fixture
def ws():
    return Registry(SAMPLE, dsn=None, password=None).playground("test")


def next_saturday() -> str:
    d = date.today() + timedelta(days=14)
    while d.weekday() != 5:
        d += timedelta(days=1)
    return d.isoformat()


def test_a_new_show_starts_with_availability_from_weekly_patterns(ws):
    data = add_show(ws.data, dict(show_id="S9001", facility_id="LOC1", date=next_saturday(),
                                  start_time="14:00", duration_min=60, period="upcoming"))
    rows = data.availability[data.availability.show_id == "S9001"]
    assert len(rows) == len(data.musicians)          # everyone has an answer, not a blank
    assert rows.available.sum() > 0                  # and the usual Saturday crowd is free


def test_the_seat_picker_and_add_agree(ws):
    show = ws.upcoming_show_ids()[0]
    from backend.views import _seat_candidates
    lists = _seat_candidates(ws, show)
    if lists["free_ids"]:
        ws.add_to_show(show, lists["free_ids"][0])   # offered as free, so it must be accepted
    if lists["unmarked_ids"]:
        ws.add_to_show(show, lists["unmarked_ids"][0], mark_available=True)
        assert ws.data.is_available(lists["unmarked_ids"][0], show)


def test_someone_on_another_show_that_day_is_never_offered(ws):
    a = ws.draft.assignments
    shows = ws.data.shows.loc[ws.upcoming_show_ids()]
    day = shows.date.value_counts().index[0]
    s1, s2 = shows[shows.date == day].index[:2]
    busy = a[a.show_id == s1].musician_id.iloc[0]
    from backend.views import _seat_candidates
    lists = _seat_candidates(ws, s2)
    assert busy not in lists["free_ids"] and busy not in lists["unmarked_ids"]


def test_backups_at_their_monthly_limit_are_ranked_last(ws):
    d, a = ws.data, ws.draft.assignments
    month = pd.to_datetime(d.shows["date"]).dt.to_period("M")
    played = a.assign(month=a.show_id.map(month)).groupby(["musician_id", "month"]).size()
    b = assign_backups(d, a).backups
    for show_id, rows in b.groupby("show_id"):
        at_cap = [played.get((m, month[show_id]), 0) >= d.musicians.at[m, "max_shows_per_month"]
                  for m in rows.sort_values("rank").musician_id]
        # Once someone at their limit appears, nobody under it may come after them — except the
        # pianist swap, which can put an under-limit pianist last.
        first = at_cap.index(True) if True in at_cap else len(at_cap)
        assert sum(not x for x in at_cap[first:-1]) == 0, (show_id, at_cap)


@pytest.mark.skipif(not DSN, reason="set TEST_DSN to a throwaway Postgres to run this")
def test_a_visitors_sample_data_is_shared_between_backend_copies():
    a, b = Registry(SAMPLE, dsn=DSN, password="pw"), Registry(SAMPLE, dsn=DSN, password="pw")
    sid = f"shared-{date.today()}-{os.getpid()}"
    b.playground(sid)                      # b has its own copy in memory first
    a.playground(sid).set_mileage_rate(9.99)
    a.save_playground(sid)
    assert b.playground(sid).mileage_rate == pytest.approx(9.99)
