"""Coordinator login: persisted sessions, expiry, password rotation, and wrong-password throttling.

Needs a throwaway Postgres with a roster loaded, e.g.

    docker run -d --rm --name rf-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
    NEON_DSN=postgresql://postgres:pw@localhost:55432/postgres python -m backend.seed_db --csv-dir sample_data
    TEST_DSN=postgresql://postgres:pw@localhost:55432/postgres pytest tests/test_coordinator_login.py

Skipped when TEST_DSN isn't set. Never point it at the real coordinator database: these tests
delete every login in it.
"""
import os
from pathlib import Path

import psycopg
import pytest

from backend import persistence
from backend.registry import LOGIN_MAX_FAILURES, Registry, TooManyAttemptsError

DSN = os.environ.get("TEST_DSN")
SAMPLE = Path(__file__).resolve().parent.parent / "sample_data"
PASSWORD = "correct horse battery staple"

pytestmark = pytest.mark.skipif(not DSN, reason="set TEST_DSN to a throwaway Postgres to run these")


@pytest.fixture
def registry() -> Registry:
    persistence.apply_schema(DSN)
    persistence.delete_all_coordinator_sessions(DSN)
    with psycopg.connect(DSN) as conn:
        conn.execute("DELETE FROM login_failures")
        conn.commit()
    return Registry(SAMPLE, dsn=DSN, password=PASSWORD)


def test_wrong_password_is_refused(registry):
    with pytest.raises(PermissionError):
        registry.login("Sam", "nope", client="1.2.3.4")


def test_login_survives_a_restart(registry):
    token, login = registry.login("Sam", PASSWORD, client="1.2.3.4")
    restarted = Registry(SAMPLE, dsn=DSN, password=PASSWORD)
    assert restarted.session(token) == login


def test_login_remembers_the_name_typed(registry):
    token, _ = registry.login("  Rachael   C ", PASSWORD, client="1.2.3.4")
    assert Registry(SAMPLE, dsn=DSN, password=PASSWORD).session(token).name == "Rachael C"


def test_a_name_is_required(registry):
    with pytest.raises(ValueError):
        registry.login("   ", PASSWORD, client="1.2.3.4")


def test_token_is_not_stored_in_the_database(registry):
    token, _ = registry.login("Sam", PASSWORD, client="1.2.3.4")
    with psycopg.connect(DSN) as conn:
        keys = [r[0] for r in conn.execute("SELECT key FROM coordinator_sessions")]
    assert keys and token not in keys


def test_logout_ends_only_that_login(registry):
    a, _ = registry.login("Sam", PASSWORD, client="1.2.3.4")
    b, _ = registry.login("Sam", PASSWORD, client="1.2.3.4")
    registry.logout(a)
    assert not registry.is_valid_token(a)
    assert registry.is_valid_token(b)


def test_logout_everywhere(registry):
    a, _ = registry.login("Sam", PASSWORD, client="1.2.3.4")
    b, _ = registry.login("Sam", PASSWORD, client="5.6.7.8")
    registry.logout_everywhere()
    assert not registry.is_valid_token(a)
    assert not registry.is_valid_token(b)


def test_changing_the_password_ends_existing_logins(registry):
    token, _ = registry.login("Sam", PASSWORD, client="1.2.3.4")
    rotated = Registry(SAMPLE, dsn=DSN, password="a brand new shared password")
    assert not rotated.is_valid_token(token)


def test_expired_login_is_refused(registry):
    token, _ = registry.login("Sam", PASSWORD, client="1.2.3.4")
    with psycopg.connect(DSN) as conn:
        conn.execute("UPDATE coordinator_sessions SET expires_at = now() - interval '1 minute'")
        conn.commit()
    assert not Registry(SAMPLE, dsn=DSN, password=PASSWORD).is_valid_token(token)


def test_repeated_wrong_passwords_are_throttled_per_client(registry):
    for _ in range(LOGIN_MAX_FAILURES):
        with pytest.raises(PermissionError):
            registry.login("Sam", "nope", client="1.2.3.4")
    # Locked out now, even with the right password...
    with pytest.raises(TooManyAttemptsError):
        registry.login("Sam", PASSWORD, client="1.2.3.4")
    # ...but only from that client.
    token, _ = registry.login("Sam", PASSWORD, client="5.6.7.8")
    assert registry.is_valid_token(token)


def test_throttling_is_shared_between_copies_of_the_backend(registry):
    for _ in range(LOGIN_MAX_FAILURES):
        with pytest.raises(PermissionError):
            registry.login("Sam", "nope", client="1.2.3.4")
    other_copy = Registry(SAMPLE, dsn=DSN, password=PASSWORD)
    with pytest.raises(TooManyAttemptsError):
        other_copy.login("Sam", PASSWORD, client="1.2.3.4")


def test_unconfigured_server_has_no_logins():
    reg = Registry(SAMPLE, dsn=None, password=None)
    assert not reg.coordinator_configured
    assert not reg.is_valid_token("anything")
