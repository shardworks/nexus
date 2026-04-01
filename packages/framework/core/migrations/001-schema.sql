-- Nexus Mk 2.1 — consolidated schema.
-- All entity IDs are TEXT using prefixed hex format (e.g. a-3f7b2c1e).
-- No auto-increment IDs anywhere in the system.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ════════════════════════════════════════════════════════════════════════
-- Register — anima identity and composition
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE animas (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL CHECK(status IN ('aspirant', 'active', 'retired')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE anima_compositions (
    id                    TEXT PRIMARY KEY,
    anima_id              TEXT NOT NULL UNIQUE REFERENCES animas(id),
    curriculum_name       TEXT NOT NULL,
    curriculum_version    TEXT NOT NULL,
    temperament_name      TEXT NOT NULL,
    temperament_version   TEXT NOT NULL,
    curriculum_snapshot   TEXT NOT NULL,
    temperament_snapshot  TEXT NOT NULL,
    composed_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE roster (
    id          TEXT PRIMARY KEY,
    anima_id    TEXT NOT NULL REFERENCES animas(id),
    role        TEXT NOT NULL,
    standing    INTEGER NOT NULL DEFAULT 0,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════════════════
-- Ledger — commissions and work decomposition
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE commissions (
    id            TEXT PRIMARY KEY,
    content       TEXT NOT NULL,
    status        TEXT NOT NULL CHECK(status IN ('posted', 'assigned', 'in_progress', 'completed', 'failed')),
    workshop      TEXT NOT NULL,
    status_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE commission_assignments (
    id              TEXT PRIMARY KEY,
    commission_id   TEXT NOT NULL REFERENCES commissions(id),
    anima_id        TEXT NOT NULL REFERENCES animas(id),
    assigned_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(commission_id, anima_id)
);

CREATE TABLE works (
    id            TEXT PRIMARY KEY,
    commission_id TEXT REFERENCES commissions(id),
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'active', 'completed', 'cancelled')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pieces (
    id          TEXT PRIMARY KEY,
    work_id     TEXT REFERENCES works(id),
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'active', 'completed', 'cancelled')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    piece_id    TEXT REFERENCES pieces(id),
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'active', 'completed', 'failed', 'cancelled')),
    assignee    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE strokes (
    id         TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL REFERENCES jobs(id),
    kind       TEXT NOT NULL,
    content    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'complete', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════════════════
-- Daybook — audit trail
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    detail      TEXT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════════════════
-- Clockworks — event queue and dispatch tracking
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE events (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    payload    TEXT,
    emitter    TEXT NOT NULL,
    fired_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE event_dispatches (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES events(id),
    handler_type TEXT NOT NULL,
    handler_name TEXT NOT NULL,
    target_role  TEXT,
    notice_type  TEXT,
    started_at   TEXT,
    ended_at     TEXT,
    status       TEXT,
    error        TEXT
);

-- ════════════════════════════════════════════════════════════════════════
-- Sessions — session tracking and commission linkage
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    anima_id            TEXT NOT NULL REFERENCES animas(id),
    provider            TEXT NOT NULL,
    model               TEXT,
    trigger             TEXT NOT NULL,
    workshop            TEXT,
    workspace_kind      TEXT NOT NULL,
    curriculum_name     TEXT,
    curriculum_version  TEXT,
    temperament_name    TEXT,
    temperament_version TEXT,
    roles               TEXT,
    started_at          TEXT NOT NULL,
    ended_at            TEXT,
    exit_code           INTEGER,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cache_read_tokens   INTEGER,
    cache_write_tokens  INTEGER,
    cost_usd            REAL,
    duration_ms         INTEGER,
    provider_session_id TEXT,
    record_path         TEXT
);

CREATE TABLE commission_sessions (
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    session_id    TEXT NOT NULL REFERENCES sessions(id),
    PRIMARY KEY (commission_id, session_id)
);
