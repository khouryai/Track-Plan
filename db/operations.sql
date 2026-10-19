-- Operational data (SQLite): accounts, the four-week look-ahead and the track
-- access work requests (TAWRs) raised from it.
--
-- Kept in its own file, db/operations.db, apart from the map database
-- (db/trackmap.db), because the map database is deleted and rebuilt from the
-- drawing whenever the extraction runs. Nothing here is ever regenerated.
--
-- Every statement is re-runnable: server.py applies this file on every start.

PRAGMA foreign_keys = ON;

-- ── Accounts ────────────────────────────────────────────────────────────────
-- requester  raises TAWRs from the look-ahead and submits them
-- manager    the Track Allocation Manager: approves, rejects and consolidates
-- viewer     reads everything, changes nothing
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('requester', 'manager', 'viewer')),
    password_hash TEXT NOT NULL,             -- pbkdf2_sha256$iterations$salt$hash
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,            -- sha256 of the cookie; the cookie itself is never stored
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- ── The look-ahead ──────────────────────────────────────────────────────────
-- Rows and cells exactly as web/js/lookahead.js holds them; every change
-- arrives as ops (/api/lookahead/ops). `link` is the track plan link: JSON
-- {location_id, location_name, location_kind, limits, geometry}.
CREATE TABLE IF NOT EXISTS la_rows (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('section', 'activity', 'resource')),
    parent_id   TEXT,
    sort        REAL NOT NULL DEFAULT 0,
    activity_id TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    sswp        TEXT NOT NULL DEFAULT '',
    party       TEXT NOT NULL DEFAULT '',
    work_hours  TEXT NOT NULL DEFAULT '',
    link        TEXT,
    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS la_cells (
    row_id  TEXT NOT NULL REFERENCES la_rows(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,                  -- YYYY-MM-DD
    color   TEXT,                           -- RRGGBB, a legend colour
    text    TEXT NOT NULL DEFAULT '',       -- support codes ("X.WIT") or, on a Resource row, names
    PRIMARY KEY (row_id, day)
);
CREATE INDEX IF NOT EXISTS la_cells_day ON la_cells(day);

-- The shift colours, and the support code register: JSON arrays in `meta`
-- under 'legend' and 'codes', replaced whole when edited.

-- ── TAWRs ───────────────────────────────────────────────────────────────────
-- One per place and shift per week (or per consolidation). `fields` is what the
-- form says now, `generated` what the look-ahead said when it was last read;
-- the difference is what somebody changed by hand. `source` is what it was read
-- from: activities with their track plan links, days, support, flags.
-- After approval, `bart` is what happened with BART (sent on, BART's reference,
-- its answer, the track released after a cancellation) and `access` whether
-- each day's access was used. An older database is rebuilt to this shape on
-- start (operations.init_db): SQLite cannot change a CHECK constraint.
CREATE TABLE IF NOT EXISTS tawrs (
    id            INTEGER PRIMARY KEY,
    week_start    TEXT NOT NULL,
    group_key     TEXT NOT NULL,
    shift         TEXT NOT NULL,
    location_name TEXT NOT NULL DEFAULT '',
    first_day     TEXT,
    status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'denied', 'cancelled',
                                    'superseded', 'consolidated')),
    status_before TEXT,                     -- what a consolidated request was, so a split puts it back
    fields        TEXT NOT NULL DEFAULT '{}',
    generated     TEXT NOT NULL DEFAULT '{}',
    source        TEXT NOT NULL DEFAULT '{}',
    supersedes    INTEGER REFERENCES tawrs(id) ON DELETE SET NULL,
    merged_into   INTEGER REFERENCES tawrs(id) ON DELETE SET NULL,
    decision_note TEXT,
    history       TEXT NOT NULL DEFAULT '[]', -- [{at, by, action, note}]
    bart          TEXT,                     -- {sent_on, ref, answer, answered_on, note, released_on, by}
    access        TEXT,                     -- {days: {YYYY-MM-DD: used?}, note, on, by}
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at    TEXT,
    submitted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    submitted_at  TEXT,
    decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS tawrs_week ON tawrs(week_start);
-- One live request per place and shift in a week; revisions and consolidations
-- replace, never pile up.
CREATE UNIQUE INDEX IF NOT EXISTS tawrs_current ON tawrs(week_start, group_key)
    WHERE status NOT IN ('superseded', 'consolidated');

-- The requests the track allocation manager made one: `keys` is the JSON list
-- of the group keys merged, and the merged request's key is 'merge:' || id.
CREATE TABLE IF NOT EXISTS tawr_merges (
    id          TEXT PRIMARY KEY,
    week_start  TEXT NOT NULL,
    shift       TEXT NOT NULL,
    keys        TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The contacts on every request, the requester's name, phone and signature,
-- the shift hours and the rest of TAWR → Setup.
CREATE TABLE IF NOT EXISTS tawr_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT
);

-- "IXL SIM Testing" → what the work description says about it.
CREATE TABLE IF NOT EXISTS tawr_descriptions (
    id          INTEGER PRIMARY KEY,
    activity    TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
);

-- The learning memory (web/js/learn.js): a request's answers when it was
-- submitted or approved, a rejection's reason, which predictions a request
-- kept, a location linked on the look-ahead. `data` is the JSON the browser
-- wrote; the server only keeps it, and forgets an entry when asked.
CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('form', 'link', 'reject', 'outcome')),
    tawr_id     INTEGER,
    data        TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS memory_kind ON memory(kind, created_at);
