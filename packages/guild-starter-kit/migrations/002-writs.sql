-- Writs — unified work tracking, replacing the rigid four-level hierarchy
-- (works, pieces, jobs, strokes) with a single flexible typed model.

-- ════════════════════════════════════════════════════════════════════════
-- New: writs table
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE writs (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'ready'
                CHECK(status IN ('ready', 'active', 'pending', 'completed', 'failed', 'cancelled')),
    parent_id   TEXT REFERENCES writs(id),
    session_id  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_writs_parent ON writs(parent_id);
CREATE INDEX idx_writs_status ON writs(status);
CREATE INDEX idx_writs_type_status ON writs(type, status);

-- ════════════════════════════════════════════════════════════════════════
-- Link commissions to their mandate writ
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE commissions ADD COLUMN writ_id TEXT REFERENCES writs(id);

-- ════════════════════════════════════════════════════════════════════════
-- Link sessions to their bound writ
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE sessions ADD COLUMN writ_id TEXT REFERENCES writs(id);

-- ════════════════════════════════════════════════════════════════════════
-- Drop old hierarchy tables (never populated in production)
-- ════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS strokes;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS pieces;
DROP TABLE IF EXISTS works;
