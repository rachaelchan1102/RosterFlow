-- Schema for the real deployment's Neon (Postgres) database. Mirrors the sample_data/ CSVs
-- exactly, column for column, so load_from_db and load_from_csv build identical Data objects.
-- Foreign keys use the default NO ACTION (no ON DELETE CASCADE) on purpose — optimizer/data.py's
-- delete_musician/delete_show already do the cascading explicitly and validate the result before
-- committing anything; the database enforcing the same constraint again is a backstop against a
-- write that bypasses that Python layer, not something meant to silently cascade on its own.

CREATE TABLE IF NOT EXISTS facilities (
    facility_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    region TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    show_duration_min INTEGER NOT NULL,
    songs_per_show INTEGER NOT NULL,
    target_musicians INTEGER NOT NULL,
    min_musicians INTEGER NOT NULL,
    max_musicians INTEGER NOT NULL,
    has_piano_onsite BOOLEAN NOT NULL,
    preferred_slot TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    parking_notes TEXT NOT NULL DEFAULT '',
    piano_notes TEXT NOT NULL DEFAULT ''
);
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS parking_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS piano_notes TEXT NOT NULL DEFAULT '';
-- How long before start musicians should arrive to load in — informational, shown on the show
-- panel, not something the solver schedules around.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS load_in_buffer_min INTEGER NOT NULL DEFAULT 15;
-- A parking-constrained override of the org-wide car capacity (optimizer/carpool.py's
-- CAR_CAPACITY) — a tight lot might only fit 2 per car even though the org default is 3.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS max_per_car INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS musicians (
    musician_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    age INTEGER NOT NULL,
    instrument TEXT NOT NULL,
    home_region TEXT NOT NULL,
    home_lat DOUBLE PRECISION NOT NULL,
    home_lng DOUBLE PRECISION NOT NULL,
    transport TEXT NOT NULL,
    can_drive BOOLEAN NOT NULL,
    years_with_org DOUBLE PRECISION NOT NULL,
    max_shows_per_month INTEGER NOT NULL,
    min_songs INTEGER NOT NULL,
    typical_songs INTEGER NOT NULL,
    max_songs INTEGER NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    guardian_name TEXT NOT NULL DEFAULT '',
    guardian_phone TEXT NOT NULL DEFAULT ''
);
-- ADD COLUMN IF NOT EXISTS instead of only relying on CREATE TABLE IF NOT EXISTS above, so a
-- coordinator database that was already set up before contact info existed picks these up too,
-- not just a brand new one.
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS guardian_name TEXT NOT NULL DEFAULT '';
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS guardian_phone TEXT NOT NULL DEFAULT '';
-- A pianist who owns and brings their own keyboard can still play a show at a facility with no
-- piano onsite; one who doesn't, can't — see optimizer/assignment.py's hard piano-in-room constraint.
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS brings_keyboard BOOLEAN NOT NULL DEFAULT FALSE;
-- Two musicians sharing a non-blank household_id are family (a set sibling group, or a minor and
-- their own guardian who's also a roster musician) — the ONLY thing that lets a minor ride in a
-- car another musician drives, an explicit, coordinator-confirmed link rather than an automatic
-- "nearby adult" guess (see optimizer/carpool.py's _match_households).
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS household_id TEXT NOT NULL DEFAULT '';
-- Comma-separated "also plays" list — informational only. `instrument` (above) stays the one the
-- solver, pianist-coverage checks and carpool instrument-matching all read; this just gives a
-- multi-instrument player (piano + voice is common) somewhere to record it, without threading a
-- second instrument through every one of those existing single-instrument assumptions.
ALTER TABLE musicians ADD COLUMN IF NOT EXISTS secondary_instruments TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS shows (
    show_id TEXT PRIMARY KEY,
    facility_id TEXT NOT NULL REFERENCES facilities(facility_id),
    date DATE NOT NULL,
    start_time TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    period TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability (
    musician_id TEXT NOT NULL REFERENCES musicians(musician_id),
    show_id TEXT NOT NULL REFERENCES shows(show_id),
    available SMALLINT NOT NULL CHECK (available IN (0, 1)),
    PRIMARY KEY (musician_id, show_id)
);

CREATE TABLE IF NOT EXISTS weekly_availability (
    id SERIAL PRIMARY KEY,
    musician_id TEXT NOT NULL REFERENCES musicians(musician_id),
    weekday TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distances (
    musician_id TEXT NOT NULL REFERENCES musicians(musician_id),
    facility_id TEXT NOT NULL REFERENCES facilities(facility_id),
    distance_km DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (musician_id, facility_id)
);

CREATE TABLE IF NOT EXISTS musician_distances (
    m1 TEXT NOT NULL REFERENCES musicians(musician_id),
    m2 TEXT NOT NULL REFERENCES musicians(musician_id),
    km DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (m1, m2)
);

CREATE TABLE IF NOT EXISTS history_assignments (
    show_id TEXT NOT NULL REFERENCES shows(show_id),
    musician_id TEXT NOT NULL REFERENCES musicians(musician_id),
    planned_set_min INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('attended', 'late_cancel', 'no_show')),
    actual_set_min INTEGER NOT NULL,
    PRIMARY KEY (show_id, musician_id)
);

-- Workspace state for the real deployment: the draft and published schedules, plus the
-- coordinator's locks and bans. No foreign keys here on purpose — these reference musicians and
-- shows that a coordinator can delete, and the backend prunes stale rows itself rather than
-- letting a delete of a musician fail because an old published schedule still mentions them.

CREATE TABLE IF NOT EXISTS schedule_assignments (
    kind TEXT NOT NULL CHECK (kind IN ('draft', 'published')),
    show_id TEXT NOT NULL,
    musician_id TEXT NOT NULL,
    songs INTEGER NOT NULL,
    PRIMARY KEY (kind, show_id, musician_id)
);

CREATE TABLE IF NOT EXISTS schedule_backups (
    kind TEXT NOT NULL CHECK (kind IN ('draft', 'published')),
    show_id TEXT NOT NULL,
    musician_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    PRIMARY KEY (kind, show_id, musician_id)
);

CREATE TABLE IF NOT EXISTS schedule_locks (
    musician_id TEXT NOT NULL,
    show_id TEXT NOT NULL,
    PRIMARY KEY (musician_id, show_id)
);

-- Whether a musician on the draft has actually told the coordinator they're coming — being on
-- the draft only ever meant the solver (or a coordinator) put them there.
CREATE TABLE IF NOT EXISTS schedule_confirmations (
    musician_id TEXT NOT NULL,
    show_id TEXT NOT NULL,
    PRIMARY KEY (musician_id, show_id)
);

-- What a musician is actually bringing to a specific show, in their own words — a coordinator's
-- note, not something the solver reads (songs are still just a count everywhere else).
CREATE TABLE IF NOT EXISTS schedule_song_titles (
    musician_id TEXT NOT NULL,
    show_id TEXT NOT NULL,
    title TEXT NOT NULL,
    PRIMARY KEY (musician_id, show_id)
);

-- One unguessable link per musician for their self-service availability page (no login — the
-- token itself is the credential, like an unsubscribe link). Generated lazily, the first time a
-- coordinator asks for that musician's link. Deliberately NOT a foreign key to musicians: every
-- roster edit does a full TRUNCATE ... CASCADE resync of the roster tables (see save_to_db), and
-- a real FK here would wipe out every musician's link on the next unrelated edit. A token whose
-- musician_id no longer exists is simply treated as an expired link, in code, not by the schema.
CREATE TABLE IF NOT EXISTS musician_tokens (
    musician_id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_bans (
    musician_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('show', 'facility')),
    target_id TEXT NOT NULL,
    PRIMARY KEY (musician_id, scope, target_id)
);

CREATE TABLE IF NOT EXISTS schedule_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Version history for the workspace: one row per action that changed anything, oldest first
-- (id order). Append-only — a revert adds a new row rather than deleting old ones, the same way
-- `git revert` works. `snapshot` is a full serialized Workspace state (roster + draft + locks +
-- bans) as it was immediately before that row's action ran; simple full snapshots rather than a
-- diff format, since the dataset here is small enough (dozens of shows, tens of musicians) that
-- diffing would only add risk of a bad replay without saving meaningful space.
CREATE TABLE IF NOT EXISTS schedule_audit (
    id INTEGER PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL,
    description TEXT NOT NULL,
    fill_seconds DOUBLE PRECISION,
    snapshot JSONB NOT NULL
);
