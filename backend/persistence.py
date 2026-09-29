"""Postgres (Neon) persistence for the coordinator workspace's scheduling state — the draft and
published schedules, locks, bans, and whether the draft is stale. The roster itself (musicians,
shows, availability, ...) goes through optimizer/data.py's load_from_db / save_to_db.

Every save is a full rewrite of these small tables inside one transaction, same approach as
save_to_db: at tens of musicians and ~30 shows, rewriting is instant and far harder to get wrong
than tracking row-level diffs.
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime
from pathlib import Path

import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from backend.workspace import ASSIGNMENT_COLS, BACKUP_COLS, AuditEntry, Schedule, Snapshot, Workspace
from optimizer.data import from_tables, to_tables

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "optimizer" / "schema.sql"


def apply_schema(dsn: str) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute(SCHEMA_PATH.read_text())
        conn.commit()


def roster_is_empty(dsn: str) -> bool:
    with psycopg.connect(dsn) as conn:
        return conn.execute("SELECT count(*) FROM musicians").fetchone()[0] == 0


STATE_TABLES = ("schedule_assignments", "schedule_backups", "schedule_locks", "schedule_bans",
                "schedule_confirmations", "schedule_song_titles", "schedule_meta")


def clear_state(dsn: str) -> None:
    """Used by `seed_db --replace` before loading a whole new roster. Clears the audit log too —
    its snapshots reference musicians and shows that are about to stop existing, so a full reseed
    is where the version history honestly starts over."""
    with psycopg.connect(dsn) as conn:
        for table in (*STATE_TABLES, "schedule_audit"):
            conn.execute(f"DELETE FROM {table}")
        conn.commit()


def save_state(dsn: str, ws: Workspace) -> None:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        for table in STATE_TABLES:
            cur.execute(f"DELETE FROM {table}")
        for kind, schedule in (("draft", ws.draft), ("published", ws.published)):
            if schedule is None:
                continue
            cur.executemany(
                "INSERT INTO schedule_assignments (kind, show_id, musician_id, songs) VALUES (%s, %s, %s, %s)",
                [(kind, r.show_id, r.musician_id, int(r.songs)) for r in schedule.assignments.itertuples()])
            cur.executemany(
                "INSERT INTO schedule_backups (kind, show_id, musician_id, rank) VALUES (%s, %s, %s, %s)",
                [(kind, r.show_id, r.musician_id, int(r.rank)) for r in schedule.backups.itertuples()])
        cur.executemany("INSERT INTO schedule_locks (musician_id, show_id) VALUES (%s, %s)", list(ws.locks))
        cur.executemany("INSERT INTO schedule_bans (musician_id, scope, target_id) VALUES (%s, %s, %s)", list(ws.bans))
        cur.executemany("INSERT INTO schedule_confirmations (musician_id, show_id) VALUES (%s, %s)", list(ws.confirmed))
        cur.executemany("INSERT INTO schedule_song_titles (musician_id, show_id, title) VALUES (%s, %s, %s)",
                       [(m, s, t) for (m, s), t in ws.song_titles.items()])
        if ws.needs_resolve:
            cur.execute("INSERT INTO schedule_meta (key, value) VALUES ('needs_resolve', %s)", (ws.needs_resolve,))
        if ws.pending_calls:
            cur.execute("INSERT INTO schedule_meta (key, value) VALUES ('pending_calls', %s)",
                       (json.dumps(ws.pending_calls),))
        cur.execute("INSERT INTO schedule_meta (key, value) VALUES ('mileage_rate', %s)",
                   (str(ws.mileage_rate),))
        conn.commit()


def load_state(dsn: str, ws: Workspace) -> None:
    """Restore a coordinator workspace's scheduling state onto `ws` (whose roster is already loaded)."""
    pianist_ids = set(ws.data.musicians[ws.data.musicians.instrument == "piano"].musician_id)
    with psycopg.connect(dsn) as conn:
        assignments = conn.execute("SELECT kind, show_id, musician_id, songs FROM schedule_assignments").fetchall()
        backups = conn.execute("SELECT kind, show_id, musician_id, rank FROM schedule_backups").fetchall()
        ws.locks = {(m, s) for m, s in conn.execute("SELECT musician_id, show_id FROM schedule_locks").fetchall()}
        ws.bans = {tuple(r) for r in conn.execute("SELECT musician_id, scope, target_id FROM schedule_bans").fetchall()}
        ws.confirmed = {(m, s) for m, s in conn.execute("SELECT musician_id, show_id FROM schedule_confirmations").fetchall()}
        ws.song_titles = {(m, s): t for m, s, t in
                          conn.execute("SELECT musician_id, show_id, title FROM schedule_song_titles").fetchall()}
        meta = dict(conn.execute("SELECT key, value FROM schedule_meta").fetchall())

    for kind in ("draft", "published"):
        a_rows = [dict(show_id=s, musician_id=m, songs=n) for k, s, m, n in assignments if k == kind]
        b_rows = [dict(show_id=s, musician_id=m, rank=r, is_pianist=m in pianist_ids)
                  for k, s, m, r in backups if k == kind]
        if not a_rows:
            continue
        schedule = Schedule(pd.DataFrame(a_rows, columns=ASSIGNMENT_COLS),
                            pd.DataFrame(b_rows, columns=BACKUP_COLS).sort_values(["show_id", "rank"],
                                                                                  ignore_index=True))
        setattr(ws, kind, schedule)
    ws.needs_resolve = meta.get("needs_resolve")
    ws.pending_calls = json.loads(meta["pending_calls"]) if "pending_calls" in meta else {}
    ws.mileage_rate = float(meta["mileage_rate"]) if "mileage_rate" in meta else ws.mileage_rate


# ---------------------------------------------------------------------------
# Version history (schedule_audit) — see workspace.py's AuditEntry/Snapshot and schema.sql's
# comment on schedule_audit for the append-only, full-snapshot design.
# ---------------------------------------------------------------------------

def _snapshot_to_json(snap: Snapshot) -> dict:
    tables = {name: df.to_dict(orient="records") for name, df in to_tables(snap.data).items()}
    draft = None
    if snap.draft is not None:
        draft = dict(assignments=snap.draft.assignments.to_dict(orient="records"),
                    backups=snap.draft.backups.to_dict(orient="records"))
    return dict(tables=tables, draft=draft, locks=[list(p) for p in snap.locks],
               bans=[list(b) for b in snap.bans], pending_calls=[list(p) for p in snap.pending_calls],
               confirmed=[list(p) for p in snap.confirmed], song_titles=[list(t) for t in snap.song_titles],
               needs_resolve=snap.needs_resolve)


def _snapshot_from_json(raw: dict) -> Snapshot:
    tables = {name: pd.DataFrame(rows) for name, rows in raw["tables"].items()}
    data = from_tables(tables)
    draft = None
    if raw["draft"] is not None:
        draft = Schedule(pd.DataFrame(raw["draft"]["assignments"], columns=ASSIGNMENT_COLS),
                         pd.DataFrame(raw["draft"]["backups"], columns=BACKUP_COLS))
    return Snapshot(data=data, draft=draft,
                    locks=frozenset(tuple(p) for p in raw["locks"]),
                    bans=frozenset(tuple(b) for b in raw["bans"]),
                    pending_calls=frozenset(tuple(p) for p in raw.get("pending_calls", [])),
                    confirmed=frozenset(tuple(p) for p in raw.get("confirmed", [])),
                    song_titles=frozenset(tuple(t) for t in raw.get("song_titles", [])),
                    needs_resolve=raw["needs_resolve"])


def append_audit_entry(dsn: str, entry: AuditEntry) -> None:
    """One INSERT per entry, never a rewrite — the log only ever grows, so there's no reason to
    re-save history that hasn't changed every time one new thing happens."""
    with psycopg.connect(dsn) as conn:
        conn.execute(
            "INSERT INTO schedule_audit (id, at, description, fill_seconds, snapshot) VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO NOTHING",
            (entry.id, entry.at, entry.description, entry.fill_seconds, Jsonb(_snapshot_to_json(entry.snapshot))))
        conn.commit()


def load_audit_log(dsn: str, ws: Workspace) -> None:
    """Restores the whole version history onto `ws` at startup, and picks up the id counter where
    it left off so new entries never collide with ones from a previous run of the server."""
    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT id, at, description, fill_seconds, snapshot FROM schedule_audit ORDER BY id").fetchall()
    ws.restore_audit_log([
        AuditEntry(id=r[0], at=r[1].isoformat(), description=r[2], fill_seconds=r[3],
                  snapshot=_snapshot_from_json(r[4] if isinstance(r[4], dict) else json.loads(r[4])))
        for r in rows
    ])


# ---------------------------------------------------------------------------
# Self-service links (see schema.sql's musician_tokens comment for why this isn't a foreign key)
# ---------------------------------------------------------------------------

def get_or_create_musician_token(dsn: str, musician_id: str) -> str:
    with psycopg.connect(dsn) as conn:
        row = conn.execute("SELECT token FROM musician_tokens WHERE musician_id = %s", (musician_id,)).fetchone()
        if row:
            return row[0]
        token = secrets.token_urlsafe(24)
        conn.execute("INSERT INTO musician_tokens (musician_id, token) VALUES (%s, %s)", (musician_id, token))
        conn.commit()
        return token


def musician_id_for_token(dsn: str, token: str) -> str | None:
    with psycopg.connect(dsn) as conn:
        row = conn.execute("SELECT musician_id FROM musician_tokens WHERE token = %s", (token,)).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Coordinator logins (see schema.sql's coordinator_sessions comment for what `key` is)
# ---------------------------------------------------------------------------

def create_coordinator_session(dsn: str, key: str, expires_at: datetime) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute("DELETE FROM coordinator_sessions WHERE expires_at <= now()")
        conn.execute("INSERT INTO coordinator_sessions (key, expires_at) VALUES (%s, %s)", (key, expires_at))
        conn.commit()


def coordinator_session_expiry(dsn: str, key: str) -> datetime | None:
    """When this login expires, or None if it doesn't exist or already has."""
    with psycopg.connect(dsn) as conn:
        row = conn.execute("SELECT expires_at FROM coordinator_sessions WHERE key = %s AND expires_at > now()",
                           (key,)).fetchone()
    return row[0] if row else None


def delete_coordinator_session(dsn: str, key: str) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute("DELETE FROM coordinator_sessions WHERE key = %s", (key,))
        conn.commit()


def delete_all_coordinator_sessions(dsn: str) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute("DELETE FROM coordinator_sessions")
        conn.commit()


# ---------------------------------------------------------------------------
# Wrong-password throttling (see schema.sql's login_failures comment)
# ---------------------------------------------------------------------------

def recent_login_failures(dsn: str, client: str, window_s: int) -> list[datetime]:
    with psycopg.connect(dsn) as conn:
        return [r[0] for r in conn.execute(
            "SELECT at FROM login_failures WHERE client = %s AND at > now() - make_interval(secs => %s) ORDER BY at",
            (client, window_s)).fetchall()]


def record_login_failure(dsn: str, client: str, window_s: int) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute("DELETE FROM login_failures WHERE at <= now() - make_interval(secs => %s)", (window_s,))
        conn.execute("INSERT INTO login_failures (client) VALUES (%s)", (client,))
        conn.commit()


def clear_login_failures(dsn: str, client: str) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute("DELETE FROM login_failures WHERE client = %s", (client,))
        conn.commit()


# ---------------------------------------------------------------------------
# Keeping several copies of the backend in step (see schema.sql's workspace_version comment)
# ---------------------------------------------------------------------------

# Arbitrary, but fixed: every copy of the backend must agree on it.
WRITE_LOCK_ID = 7_310_422


def workspace_version(dsn: str) -> int:
    with psycopg.connect(dsn) as conn:
        return conn.execute("SELECT version FROM workspace_version WHERE id = 1").fetchone()[0]


def bump_workspace_version(dsn: str) -> int:
    with psycopg.connect(dsn) as conn:
        version = conn.execute(
            "UPDATE workspace_version SET version = version + 1 WHERE id = 1 RETURNING version").fetchone()[0]
        conn.commit()
        return version
