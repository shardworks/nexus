-- Remove commissions — writs become the sole work primitive.
--
-- Adds workshop, source_type, source_id to writs. Drops commission tables
-- and the commission linkage columns. Existing commission/mandate data need
-- not be preserved; active guilds should be treated as starting fresh.

-- ════════════════════════════════════════════════════════════════════════
-- Enrich writs with workshop and source tracking
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE writs ADD COLUMN workshop TEXT;
ALTER TABLE writs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'engine'
    CHECK(source_type IN ('patron', 'anima', 'engine'));
ALTER TABLE writs ADD COLUMN source_id TEXT;

CREATE INDEX idx_writs_workshop ON writs(workshop);

-- ════════════════════════════════════════════════════════════════════════
-- Drop commission tables and linkage
-- ════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS commission_assignments;
DROP TABLE IF EXISTS commissions;
