"""Routes each request to the right workspace (see workspace.py).

- No valid login → a playground workspace keyed by the browser's session id. The frontend makes
  a new id on every page load, so a refresh starts over on the synthetic dataset — by design, so
  anyone can click around with no consequence. Idle sessions are dropped from memory.
- A valid login token → the single shared coordinator workspace, loaded from and saved to
  Postgres (Neon) on every change. Logins are stored in Postgres too (coordinator_sessions), so a
  restart or redeploy doesn't log anyone out; they expire after SESSION_TTL.

The synthetic dataset is solved once and every new playground session starts from a copy of that
solved state, so a visitor doesn't wait on a fresh 15-20s solve every time they refresh. That solve
is saved in the repo (PLAYGROUND_DRAFT_FILE, built by `python -m backend.build_playground_draft`),
so a fresh copy of the backend — which on Vercel is every cold start — skips it entirely.

Several copies of the backend can run at once (Vercel starts them on demand). Anything that has to
be shared between them lives in Postgres: logins, wrong-password counts, and a version number for
the coordinator workspace, which each copy checks so it reloads after another copy changed it.
Playground sessions are the exception — they live only in the copy that created them, so a visitor
whose request lands on a different copy starts over on fresh sample data. That's the playground's
normal "resets on refresh" behavior arriving early, never a loss of real data.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from backend import persistence
from backend.workspace import ASSIGNMENT_COLS, BACKUP_COLS, Schedule, Workspace
from optimizer.data import load_from_csv, load_from_db, save_to_db

PLAYGROUND_IDLE_TTL_S = 2 * 60 * 60
MAX_PLAYGROUND_SESSIONS = 200

SESSION_TTL = timedelta(days=30)
# How long a login already checked against the database is trusted from memory, so every API call
# isn't a Neon round trip. It's also how long a logout on another copy of the backend can take to
# reach this one.
SESSION_RECHECK_S = 60
LOGIN_MAX_FAILURES = 5
LOGIN_FAILURE_WINDOW_S = 15 * 60


class NotConfiguredError(RuntimeError):
    pass


PLAYGROUND_DRAFT_FILE = "solved_draft.json"


def sample_data_fingerprint(sample_data_dir: Path) -> str:
    """Changes whenever any sample CSV does, so a saved solve of an older sample set is ignored."""
    h = hashlib.sha256()
    for path in sorted(sample_data_dir.glob("*.csv")):
        h.update(path.name.encode())
        h.update(path.read_bytes())
    return h.hexdigest()


class TooManyAttemptsError(RuntimeError):
    def __init__(self, retry_after_s: int):
        minutes = max(1, round(retry_after_s / 60))
        super().__init__(f"Too many wrong passwords from this device. Try again in {minutes} "
                         f"minute{'s' if minutes != 1 else ''}.")
        self.retry_after_s = retry_after_s


class Registry:
    def __init__(self, sample_data_dir: Path, dsn: str | None, password: str | None):
        self._sample_data_dir = sample_data_dir
        self._dsn = dsn
        self._password = password
        self._pristine: Workspace | None = None
        self._pristine_lock = threading.Lock()
        self._sessions: dict[str, Workspace] = {}
        self._sessions_lock = threading.Lock()
        self._coordinator: Workspace | None = None
        self._coordinator_version: int | None = None
        self._schema_applied = False
        self._coordinator_lock = threading.Lock()
        self._auth_lock = threading.Lock()
        self._session_cache: dict[str, tuple[datetime, float]] = {}   # key -> (expires_at, checked at)

    @property
    def coordinator_configured(self) -> bool:
        return bool(self._dsn and self._password)

    @property
    def dsn(self) -> str | None:
        return self._dsn

    def _ensure_schema(self) -> None:
        """Once per copy of the backend, so tables added since the database was seeded (logins,
        wrong-password counts, ...) exist before anything queries them."""
        if not self._schema_applied:
            persistence.apply_schema(self._dsn)
            self._schema_applied = True

    # ------------------------------------------------------------------ playground

    def warm_up(self) -> None:
        self._get_pristine()

    def _get_pristine(self) -> Workspace:
        with self._pristine_lock:
            if self._pristine is None:
                ws = Workspace(load_from_csv(self._sample_data_dir))
                saved = self._saved_playground_draft()
                if saved is not None:
                    ws.draft = saved
                else:
                    ws.solve()
                    ws.last_resolve_changes = []
                self._pristine = ws
            return self._pristine

    def _saved_playground_draft(self) -> Schedule | None:
        path = self._sample_data_dir / PLAYGROUND_DRAFT_FILE
        if not path.exists():
            return None
        raw = json.loads(path.read_text())
        if raw.get("fingerprint") != sample_data_fingerprint(self._sample_data_dir):
            return None   # the sample CSVs changed since this was built — solve fresh instead
        return Schedule(pd.DataFrame(raw["assignments"], columns=ASSIGNMENT_COLS),
                        pd.DataFrame(raw["backups"], columns=BACKUP_COLS))

    def playground(self, session_id: str) -> Workspace:
        pristine = self._get_pristine()
        now = time.monotonic()
        with self._sessions_lock:
            for sid in [sid for sid, ws in self._sessions.items() if now - ws.last_used > PLAYGROUND_IDLE_TTL_S]:
                del self._sessions[sid]
            ws = self._sessions.get(session_id)
            if ws is None:
                if len(self._sessions) >= MAX_PLAYGROUND_SESSIONS:
                    oldest = min(self._sessions, key=lambda sid: self._sessions[sid].last_used)
                    del self._sessions[oldest]
                ws = Workspace(pristine.data)
                ws.draft = pristine.draft
                self._sessions[session_id] = ws
            ws.last_used = now
            return ws

    # ------------------------------------------------------------------ coordinator

    def login(self, password: str, client: str) -> tuple[str, datetime]:
        """Check the shared password and start a login for `client` (an IP address, used only to
        throttle guessing). Returns the new token and when it expires."""
        if not self.coordinator_configured:
            raise NotConfiguredError("The coordinator workspace isn't set up on this server (no database configured).")
        self._ensure_schema()
        self._check_throttle(client)
        if not secrets.compare_digest(password.encode(), self._password.encode()):
            self._record_failure(client)
            raise PermissionError("Wrong password.")
        persistence.clear_login_failures(self._dsn, client)
        # Load the workspace before minting a token, so an unreachable database or an empty roster
        # is reported at login instead of as a login that works and then fails on every page.
        self.coordinator()
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + SESSION_TTL
        key = self._session_key(token)
        persistence.create_coordinator_session(self._dsn, key, expires_at)
        with self._auth_lock:
            self._session_cache[key] = (expires_at, time.monotonic())
        return token, expires_at

    def logout(self, token: str) -> None:
        if not self.coordinator_configured:
            return
        key = self._session_key(token)
        with self._auth_lock:
            self._session_cache.pop(key, None)
        persistence.delete_coordinator_session(self._dsn, key)

    def logout_everywhere(self) -> None:
        """End every coordinator login, on every device — for a lost laptop, or someone who
        shouldn't have the password anymore (though changing the password does this too)."""
        with self._auth_lock:
            self._session_cache.clear()
        persistence.delete_all_coordinator_sessions(self._dsn)

    def session_expiry(self, token: str | None) -> datetime | None:
        """When this token's login expires, or None if it isn't a live login."""
        if not token or not self.coordinator_configured:
            return None
        key = self._session_key(token)
        now = time.monotonic()
        with self._auth_lock:
            cached = self._session_cache.get(key)
        if cached and now - cached[1] < SESSION_RECHECK_S and cached[0] > datetime.now(timezone.utc):
            return cached[0]
        self._ensure_schema()
        expires_at = persistence.coordinator_session_expiry(self._dsn, key)
        with self._auth_lock:
            if expires_at is None:
                self._session_cache.pop(key, None)
            else:
                self._session_cache[key] = (expires_at, now)
        return expires_at

    def is_valid_token(self, token: str | None) -> bool:
        return self.session_expiry(token) is not None

    def _session_key(self, token: str) -> str:
        return hmac.new(self._password.encode(), token.encode(), hashlib.sha256).hexdigest()

    def _check_throttle(self, client: str) -> None:
        recent = persistence.recent_login_failures(self._dsn, client, LOGIN_FAILURE_WINDOW_S)
        if len(recent) >= LOGIN_MAX_FAILURES:
            unlocks_at = recent[0] + timedelta(seconds=LOGIN_FAILURE_WINDOW_S)
            raise TooManyAttemptsError(int((unlocks_at - datetime.now(timezone.utc)).total_seconds()) + 1)

    def _record_failure(self, client: str) -> None:
        persistence.record_login_failure(self._dsn, client, LOGIN_FAILURE_WINDOW_S)

    def coordinator(self) -> Workspace:
        """The shared coordinator workspace — reloaded from the database first if another copy of
        the backend has saved a change since this copy last loaded it."""
        dsn = self._dsn
        with self._coordinator_lock:
            if self._coordinator is not None and persistence.workspace_version(dsn) == self._coordinator_version:
                self._coordinator.last_used = time.monotonic()
                return self._coordinator
            self._ensure_schema()
            if persistence.roster_is_empty(dsn):
                raise NotConfiguredError(
                    "The coordinator database has no roster yet. Load one first — see "
                    "`python -m backend.seed_db --help`.")
            # Read before loading, not after: if another copy saves mid-load, this copy ends up
            # remembering the older number and reloads again next time, rather than the reverse.
            version = persistence.workspace_version(dsn)
            ws = Workspace(load_from_db(dsn),
                           save_data=self._then_bump(lambda data: save_to_db(data, dsn)),
                           save_state=self._then_bump(lambda w: persistence.save_state(dsn, w)),
                           save_audit=self._then_bump(lambda entry: persistence.append_audit_entry(dsn, entry)))
            persistence.load_state(dsn, ws)
            persistence.load_audit_log(dsn, ws)
            self._coordinator, self._coordinator_version = ws, version
            return ws

    def _then_bump(self, save: Callable[[Any], None]) -> Callable[[Any], None]:
        """Wraps a save so the shared version number moves right after it, telling every other
        copy of the backend that its in-memory workspace is now out of date."""
        def wrapped(arg: Any) -> None:
            save(arg)
            self._coordinator_version = persistence.bump_workspace_version(self._dsn)
        return wrapped
