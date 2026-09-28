"""Routes each request to the right workspace (see workspace.py).

- No valid login → a playground workspace keyed by the browser's session id. The frontend makes
  a new id on every page load, so a refresh starts over on the synthetic dataset — by design, so
  anyone can click around with no consequence. Idle sessions are dropped from memory.
- A valid login token → the single shared coordinator workspace, loaded from and saved to
  Postgres (Neon) on every change.

The synthetic dataset is solved once and every new playground session starts from a copy of that
solved state, so a visitor doesn't wait on a fresh 15-20s solve every time they refresh.
"""
from __future__ import annotations

import secrets
import threading
import time
from pathlib import Path

from backend import persistence
from backend.workspace import Workspace
from optimizer.data import load_from_csv, load_from_db, save_to_db

PLAYGROUND_IDLE_TTL_S = 2 * 60 * 60
MAX_PLAYGROUND_SESSIONS = 200


class NotConfiguredError(RuntimeError):
    pass


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
        self._coordinator_lock = threading.Lock()
        self._tokens: set[str] = set()

    @property
    def coordinator_configured(self) -> bool:
        return bool(self._dsn and self._password)

    @property
    def dsn(self) -> str | None:
        return self._dsn

    # ------------------------------------------------------------------ playground

    def warm_up(self) -> None:
        self._get_pristine()

    def _get_pristine(self) -> Workspace:
        with self._pristine_lock:
            if self._pristine is None:
                ws = Workspace(load_from_csv(self._sample_data_dir))
                ws.solve()
                ws.last_resolve_changes = []
                self._pristine = ws
            return self._pristine

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

    def login(self, password: str) -> str:
        if not self.coordinator_configured:
            raise NotConfiguredError("The coordinator workspace isn't set up on this server (no database configured).")
        if not secrets.compare_digest(password, self._password):
            raise PermissionError("Wrong password.")
        token = secrets.token_urlsafe(32)
        self._tokens.add(token)
        return token

    def logout(self, token: str) -> None:
        self._tokens.discard(token)

    def is_valid_token(self, token: str | None) -> bool:
        return bool(token) and token in self._tokens

    def coordinator(self) -> Workspace:
        with self._coordinator_lock:
            if self._coordinator is None:
                dsn = self._dsn
                persistence.apply_schema(dsn)
                if persistence.roster_is_empty(dsn):
                    raise NotConfiguredError(
                        "The coordinator database has no roster yet. Load one first — see "
                        "`python -m backend.seed_db --help`.")
                ws = Workspace(load_from_db(dsn),
                               save_data=lambda data: save_to_db(data, dsn),
                               save_state=lambda w: persistence.save_state(dsn, w),
                               save_audit=lambda entry: persistence.append_audit_entry(dsn, entry))
                persistence.load_state(dsn, ws)
                persistence.load_audit_log(dsn, ws)
                self._coordinator = ws
            self._coordinator.last_used = time.monotonic()
            return self._coordinator
