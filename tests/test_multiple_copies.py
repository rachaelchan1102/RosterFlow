"""Several copies of the backend sharing one coordinator database, as on Vercel: a change saved
by one copy must be picked up by another, never overwritten by its stale in-memory state.

Same setup as test_coordinator_login.py (TEST_DSN pointing at a throwaway, seeded Postgres).
"""
import os
from pathlib import Path

import pytest

from backend import persistence
from backend.registry import Registry

DSN = os.environ.get("TEST_DSN")
SAMPLE = Path(__file__).resolve().parent.parent / "sample_data"

pytestmark = pytest.mark.skipif(not DSN, reason="set TEST_DSN to a throwaway Postgres to run these")


def copies() -> tuple[Registry, Registry]:
    persistence.apply_schema(DSN)
    return Registry(SAMPLE, dsn=DSN, password="pw"), Registry(SAMPLE, dsn=DSN, password="pw")


def test_a_change_from_one_copy_reaches_the_other():
    a, b = copies()
    b.coordinator()   # b loads now, then goes stale
    rate = a.coordinator().mileage_rate + 0.01
    a.coordinator().set_mileage_rate(rate)
    assert b.coordinator().mileage_rate == pytest.approx(rate)


def test_a_stale_copy_does_not_overwrite_the_other_copys_change():
    a, b = copies()
    b.coordinator()
    musician = a.coordinator().data.musicians.index[0]
    facility = a.coordinator().data.facilities.index[0]
    rate = a.coordinator().mileage_rate + 0.01
    a.coordinator().set_mileage_rate(rate)
    b.coordinator().add_ban(musician, "facility", facility)   # a separate change, made on the other copy
    fresh = Registry(SAMPLE, dsn=DSN, password="pw").coordinator()
    assert fresh.mileage_rate == pytest.approx(rate)
    assert (musician, "facility", facility) in fresh.bans
    b.coordinator().remove_ban(musician, "facility", facility)


def test_an_unchanged_copy_keeps_its_workspace():
    a, _ = copies()
    assert a.coordinator() is a.coordinator()


def test_playground_starts_from_the_saved_solve_without_solving():
    reg = Registry(SAMPLE, dsn=None, password=None)
    assert reg._saved_playground_draft() is not None, "run `python -m backend.build_playground_draft`"
    assert not reg.playground("s1").draft.assignments.empty
