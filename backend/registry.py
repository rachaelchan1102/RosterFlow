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
Playground sessions are shared the same way when a database is configured (playground_sessions),
so a visitor's sample-data edits don't vanish when a request lands on a different copy.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import pickle
import secrets
import threading
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
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


MAX_NAME_LENGTH = 40


@dataclass(frozen=True)
class Login:
    expires_at: datetime
    name: str


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
        self._session_versions: dict[str, int | None] = {}   # playground_sessions version each was loaded at
        self._sessions_lock = threading.Lock()
        self._coordinator: Workspace | None = None
        self._coordinator_version: int | None = None
        self._schema_applied = False
        self._coordinator_lock = threading.Lock()
        self._auth_lock = threading.Lock()
        self._session_cache: dict[str, tuple[Login, float]] = {}   # key -> (login, checked at)

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
        """This visitor's sample-data copy. With a database configured it's shared through
        playground_sessions, so whichever backend copy a request lands on sees the same state —
        reloaded here when another copy has saved a newer version since this one last looked."""
        pristine = self._get_pristine()
        shared = self._dsn is not None
        db_version = None
        if shared:
            self._ensure_schema()
            db_version = persistence.playground_version(self._dsn, session_id)

        with self._sessions_lock:
            ws = self._sessions.get(session_id)
            known = self._session_versions.get(session_id)
        if db_version is not None and (ws is None or known != db_version):
            row = persistence.load_playground(self._dsn, session_id)
            if row is not None:
                known, blob = row
                ws = pickle.loads(zlib.decompress(blob))
        elif shared and db_version is None and known is not None:
            ws = None   # its saved row aged out: start over, same as a refresh would
        if ws is None:
            ws, known = Workspace(pristine.data), None
            ws.draft = pristine.draft

        now = time.monotonic()
        with self._sessions_lock:
            for sid in [sid for sid, w in self._sessions.items() if now - w.last_used > PLAYGROUND_IDLE_TTL_S]:
                del self._sessions[sid]
                self._session_versions.pop(sid, None)
            existing = self._sessions.get(session_id)
            if existing is not None and self._session_versions.get(session_id) == known:
                ws = existing   # another request on this copy got here first with the same state
            else:
                if session_id not in self._sessions and len(self._sessions) >= MAX_PLAYGROUND_SESSIONS:
                    oldest = min(self._sessions, key=lambda sid: self._sessions[sid].last_used)
                    del self._sessions[oldest]
                    self._session_versions.pop(oldest, None)
                self._sessions[session_id] = ws
                self._session_versions[session_id] = known
            ws.last_used = now
            return ws

    def save_playground(self, session_id: str) -> None:
        """Write this visitor's sample-data copy back to the database after a change, so other
        backend copies pick it up. A no-op without a database (one process, nothing to share)."""
        if self._dsn is None:
            return
        with self._sessions_lock:
            ws = self._sessions.get(session_id)
        if ws is None:
            return
        with ws.lock:
            blob = zlib.compress(pickle.dumps(ws, protocol=pickle.HIGHEST_PROTOCOL), 6)
        version = persistence.save_playground(self._dsn, session_id, blob, PLAYGROUND_IDLE_TTL_S)
        with self._sessions_lock:
            if self._sessions.get(session_id) is ws:
                self._session_versions[session_id] = version

    # ------------------------------------------------------------------ coordinator

    def login(self, name: str, password: str, client: str) -> tuple[str, Login]:
        """Check the shared password and start a login for `client` (an IP address, used only to
        throttle guessing). `name` is whatever the person typed as their name — everyone shares
        the password, so it only labels their changes, it isn't checked against anything."""
        name = " ".join(name.split())
        if not name:
            raise ValueError("Type your name, so your changes show who made them.")
        if len(name) > MAX_NAME_LENGTH:
            raise ValueError(f"Keep your name under {MAX_NAME_LENGTH} characters.")
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
        login = Login(expires_at, name)
        persistence.create_coordinator_session(self._dsn, key, name, expires_at)
        with self._auth_lock:
            self._session_cache[key] = (login, time.monotonic())
        return token, login

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

    def session(self, token: str | None) -> Login | None:
        """This token's live login, or None if it isn't one (never was, expired, or logged out)."""
        if not token or not self.coordinator_configured:
            return None
        key = self._session_key(token)
        now = time.monotonic()
        with self._auth_lock:
            cached = self._session_cache.get(key)
        if cached and now - cached[1] < SESSION_RECHECK_S and cached[0].expires_at > datetime.now(timezone.utc):
            return cached[0]
        self._ensure_schema()
        row = persistence.coordinator_session(self._dsn, key)
        login = Login(*row) if row else None
        with self._auth_lock:
            if login is None:
                self._session_cache.pop(key, None)
            else:
                self._session_cache[key] = (login, now)
        return login

    def session_expiry(self, token: str | None) -> datetime | None:
        login = self.session(token)
        return login.expires_at if login else None

    def is_valid_token(self, token: str | None) -> bool:
        return self.session(token) is not None

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
