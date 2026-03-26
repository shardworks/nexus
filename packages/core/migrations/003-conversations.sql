-- Conversations — multi-turn interaction tracking for consult and convene sessions.
-- Conversations group multiple sessions (turns) into a single logical interaction.

-- ════════════════════════════════════════════════════════════════════════
-- New: conversations table
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active', 'concluded', 'abandoned')),
    kind        TEXT NOT NULL
                CHECK(kind IN ('consult', 'convene')),
    topic       TEXT,
    turn_limit  INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    event_id    TEXT
);

-- ════════════════════════════════════════════════════════════════════════
-- New: conversation_participants table
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE conversation_participants (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES conversations(id),
    kind              TEXT NOT NULL CHECK(kind IN ('anima', 'human')),
    name              TEXT NOT NULL,
    anima_id          TEXT,
    claude_session_id TEXT
);

CREATE INDEX idx_conv_participants_conv ON conversation_participants(conversation_id);

-- ════════════════════════════════════════════════════════════════════════
-- Extend sessions for conversation tracking
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE sessions ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
ALTER TABLE sessions ADD COLUMN turn_number     INTEGER;

CREATE INDEX idx_sessions_conversation ON sessions(conversation_id);
