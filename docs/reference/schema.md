# Schema Reference

The guild's Books database (``.nexus/nexus.db``) — SQLite, WAL mode, foreign keys enforced. All entity IDs are TEXT using prefixed hex format.

---

## Entity Relationship Diagram

```
                            ┌─────────────────────┐
                            │    commissions       │
                            │─────────────────────│
                            │ id (c-)              │
                            │ content              │
                            │ status               │
                            │ workshop             │
                            └──────┬──────┬────────┘
                                   │      │
                    ┌──────────────┘      └──────────────┐
                    │                                    │
        ┌───────────┴──────────┐          ┌──────────────┴──────────┐
        │ commission_assignments│          │  commission_sessions    │
        │──────────────────────│          │─────────────────────────│
        │ commission_id ←──────│          │ commission_id ←─────────│
        │ anima_id ────────────│──┐       │ session_id ─────────────│──┐
        └──────────────────────┘  │       └─────────────────────────┘  │
                                  │                                    │
        ┌─────────────────────────┘                                    │
        │                                                              │
   ┌────┴──────────────┐                                ┌──────────────┴──────┐
   │     animas        │                                │      sessions       │
   │───────────────────│                                │─────────────────────│
   │ id (a-)           │                                │ id (ses-)           │
   │ name (unique)     │                                │ anima_id ───────────│──→ animas
   │ status            │                                │ provider, model     │
   └────┬──────────────┘                                │ trigger, workshop   │
        │                                               │ token usage, cost   │
        │                                               └─────────────────────┘
   ┌────┴──────────────────┐
   │  anima_compositions   │     ┌───────────────┐
   │───────────────────────│     │    roster      │
   │ anima_id (unique) ────│     │───────────────│
   │ curriculum snapshot   │     │ anima_id ──────│──→ animas
   │ temperament snapshot  │     │ role           │
   └───────────────────────┘     └───────────────┘


   ┌─────────────────────┐
   │       writs         │
   │─────────────────────│
   │ id (wrt-)           │
   │ type, title         │
   │ status              │
   │ parent_id ──────────│──→ writs (self-ref, optional)
   │ session_id          │
   └─────────────────────┘
        ↑                    ↑
        │                    │
   commissions.writ_id   sessions.writ_id


   ┌─────────────────────┐          ┌──────────────────────┐
   │      events         │          │   event_dispatches   │
   │─────────────────────│          │──────────────────────│
   │ id (evt-)           │          │ id (ed-)             │
   │ name, payload       │←─────────│ event_id             │
   │ emitter, fired_at   │          │ handler_type/name    │
   │ processed           │          │ target_role          │
   └─────────────────────┘          │ status, error        │
                                    └──────────────────────┘

   ┌─────────────────────┐
   │    audit_log        │
   │─────────────────────│
   │ id (aud-)           │
   │ actor, action       │
   │ target_type/id      │
   │ detail, timestamp   │
   └─────────────────────┘
```

---

## Table-by-Table Reference

### `animas`

The Register — anima identity records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (a-) |
| `name` | TEXT | NOT NULL, UNIQUE | Human-readable name |
| `status` | TEXT | NOT NULL, CHECK | One of: `aspirant`, `active`, `retired` |
| `created_at` | TEXT | NOT NULL, DEFAULT now | ISO-8601 timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | ISO-8601 timestamp |

### `anima_compositions`

Frozen snapshots of an anima's training content at instantiation time.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID |
| `anima_id` | TEXT | NOT NULL, UNIQUE, FK → animas | One composition per anima |
| `curriculum_name` | TEXT | NOT NULL | Curriculum name at instantiation |
| `curriculum_version` | TEXT | NOT NULL | Curriculum version at instantiation |
| `temperament_name` | TEXT | NOT NULL | Temperament name at instantiation |
| `temperament_version` | TEXT | NOT NULL | Temperament version at instantiation |
| `curriculum_snapshot` | TEXT | NOT NULL | Full curriculum content (frozen) |
| `temperament_snapshot` | TEXT | NOT NULL | Full temperament content (frozen) |
| `composed_at` | TEXT | NOT NULL, DEFAULT now | When the composition was created |

### `roster`

Role assignments — which animas hold which roles.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID |
| `anima_id` | TEXT | NOT NULL, FK → animas | The anima |
| `role` | TEXT | NOT NULL | Role name (must match guild.json roles) |
| `standing` | INTEGER | NOT NULL, DEFAULT 0 | Reserved for future use |
| `assigned_at` | TEXT | NOT NULL, DEFAULT now | When the role was assigned |

### `commissions`

Patron-posted work orders.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (c-) |
| `content` | TEXT | NOT NULL | The commission specification |
| `status` | TEXT | NOT NULL, CHECK | One of: `posted`, `assigned`, `in_progress`, `completed`, `failed` |
| `workshop` | TEXT | NOT NULL | Target workshop name |
| `status_reason` | TEXT | | Human-readable reason for current status |
| `writ_id` | TEXT | FK → writs | The commission's mandate writ (set on posting) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | |

### `commission_assignments`

Join table — which animas are assigned to which commissions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | |
| `commission_id` | TEXT | NOT NULL, FK → commissions | |
| `anima_id` | TEXT | NOT NULL, FK → animas | |
| `assigned_at` | TEXT | NOT NULL, DEFAULT now | |

UNIQUE constraint on `(commission_id, anima_id)`.

### `writs`

Tracked work items — the Ledger's core table. Writs are typed, tree-structured obligations that replace the earlier four-level hierarchy (works, pieces, jobs, strokes).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (wrt-) |
| `type` | TEXT | NOT NULL | Writ type — guild-defined (e.g. `task`, `feature`) or built-in (`mandate`, `summon`) |
| `title` | TEXT | NOT NULL | Human-readable summary |
| `description` | TEXT | | Full description, acceptance criteria, etc. |
| `status` | TEXT | NOT NULL, DEFAULT 'ready', CHECK | One of: `ready`, `active`, `pending`, `completed`, `failed`, `cancelled` |
| `parent_id` | TEXT | FK → writs | Parent writ (null for root writs) |
| `session_id` | TEXT | | Currently bound session (cleared on completion/interruption) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | |

Indexes: `idx_writs_parent`, `idx_writs_status`, `idx_writs_type_status`.

**Cross-references:** `commissions.writ_id` points to the commission's mandate writ. `sessions.writ_id` points to the writ the session is working on.

### `audit_log`

The Daybook audit trail — records of all significant actions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (aud-) |
| `actor` | TEXT | NOT NULL | Who did it: `patron`, `operator`, `framework`, `instantiate`, anima name |
| `action` | TEXT | NOT NULL | What happened: `commission_posted`, `anima_updated`, `writ_created`, etc. |
| `target_type` | TEXT | | Entity type: `commission`, `anima`, `writ`, `session`, `conversation` |
| `target_id` | TEXT | | Entity ID |
| `detail` | TEXT | | JSON-encoded additional context |
| `timestamp` | TEXT | NOT NULL, DEFAULT now | |

### `events`

The Clockworks event queue.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (evt-) |
| `name` | TEXT | NOT NULL | Event name (e.g. `commission.posted`, `code.reviewed`) |
| `payload` | TEXT | | JSON-encoded event data |
| `emitter` | TEXT | NOT NULL | Who signaled it |
| `fired_at` | TEXT | NOT NULL, DEFAULT now | |
| `processed` | INTEGER | NOT NULL, DEFAULT 0 | 0 = pending, 1 = processed |

### `event_dispatches`

Dispatch records — what happened when a standing order executed.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (ed-) |
| `event_id` | TEXT | NOT NULL, FK → events | The triggering event |
| `handler_type` | TEXT | NOT NULL | `engine` or `anima` |
| `handler_name` | TEXT | NOT NULL | Engine name or anima name |
| `target_role` | TEXT | | Role name (for anima dispatches) |
| `notice_type` | TEXT | | `summon` or `brief` (for anima dispatches) |
| `started_at` | TEXT | | |
| `ended_at` | TEXT | | |
| `status` | TEXT | | `success` or `error` |
| `error` | TEXT | | Error message if status is error |

### `sessions`

Session records — every session launched through the funnel.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (ses-) |
| `anima_id` | TEXT | NOT NULL, FK → animas | |
| `provider` | TEXT | NOT NULL | Session provider name (e.g. `claude-code`) |
| `model` | TEXT | | Model identifier |
| `trigger` | TEXT | NOT NULL | `consult`, `summon`, `brief`, or `convene` |
| `workshop` | TEXT | | Workshop name (null for guildhall sessions) |
| `workspace_kind` | TEXT | NOT NULL | `guildhall`, `workshop-temp`, or `workshop-managed` |
| `curriculum_name` | TEXT | | |
| `curriculum_version` | TEXT | | |
| `temperament_name` | TEXT | | |
| `temperament_version` | TEXT | | |
| `roles` | TEXT | | JSON array of role names |
| `started_at` | TEXT | NOT NULL | |
| `ended_at` | TEXT | | Null while session is active |
| `exit_code` | INTEGER | | |
| `input_tokens` | INTEGER | | |
| `output_tokens` | INTEGER | | |
| `cache_read_tokens` | INTEGER | | |
| `cache_write_tokens` | INTEGER | | |
| `cost_usd` | REAL | | |
| `duration_ms` | INTEGER | | |
| `provider_session_id` | TEXT | | Provider's own session identifier |
| `record_path` | TEXT | | Path to the SessionRecord JSON file (relative to guild root) |
| `conversation_id` | TEXT | FK → conversations | Conversation this turn belongs to (null for standalone sessions) |
| `turn_number` | INTEGER | | Position within the conversation (1-indexed) |
| `writ_id` | TEXT | FK → writs | Bound writ (set by clockworks for writ-driven sessions; null for conversations) |

### `conversations`

Multi-turn interactions grouping multiple sessions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (conv-) |
| `status` | TEXT | NOT NULL, DEFAULT 'active', CHECK | One of: `active`, `concluded`, `abandoned` |
| `kind` | TEXT | NOT NULL, CHECK | `consult` or `convene` |
| `topic` | TEXT | | Seeding prompt or subject |
| `turn_limit` | INTEGER | | Maximum total turns (null = unlimited) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | |
| `ended_at` | TEXT | | |
| `event_id` | TEXT | | For convene: the triggering event ID |

### `conversation_participants`

Participants in a conversation — human or anima.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed hex ID (cpart-) |
| `conversation_id` | TEXT | NOT NULL, FK → conversations | |
| `kind` | TEXT | NOT NULL, CHECK | `anima` or `human` |
| `name` | TEXT | NOT NULL | Anima name or `'patron'` |
| `anima_id` | TEXT | | FK to animas (null for humans) |
| `claude_session_id` | TEXT | | Provider session ID for `--resume` threading |

### `commission_sessions`

Join table — which sessions are linked to which commissions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `commission_id` | TEXT | NOT NULL, FK → commissions | |
| `session_id` | TEXT | NOT NULL, FK → sessions | |

PRIMARY KEY on `(commission_id, session_id)`.

### `_migrations`

Internal tracking table for the migration system. Not part of the regular schema.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `sequence` | INTEGER | PRIMARY KEY | Migration sequence number |
| `filename` | TEXT | NOT NULL | Migration filename |
| `applied_at` | TEXT | NOT NULL, DEFAULT now | |
| `bundle` | TEXT | | Bundle that delivered this migration |
| `original_name` | TEXT | | Original filename before renumbering |

---

## Status Lifecycles

### Anima

```
aspirant → active → retired
```

- **aspirant** — created but not yet activated (not currently used by `instantiate()`, which creates directly as `active`)
- **active** — manifested for sessions, holds roles, can be dispatched
- **retired** — removed from service, roster entries deleted

### Commission

```
posted → assigned → in_progress → completed
                                → failed
```

- **posted** — created by patron, waiting for dispatch. A mandate writ is created and linked.
- **assigned** — (manual transition) an anima has been assigned
- **in_progress** — the Clockworks has summoned an anima (automatic on `summon` dispatch)
- **completed** — the mandate writ is fulfilled
- **failed** — manually set when the commission cannot be completed

### Writ

```
ready → active → completed
               → failed → cancelled (cascade)
               → pending → ready (when children complete)
                         → completed (auto, if no standing order)
ready → cancelled
```

- **ready** — available for dispatch. Signals `{type}.ready` (e.g. `mandate.ready`, `task.ready`)
- **active** — an anima is working on it (session bound)
- **pending** — the anima called `complete-session` but child writs are still incomplete. Automatically transitions back to `ready` (or auto-completes) when all children finish.
- **completed** — obligation fulfilled. Signals `{type}.completed`. Triggers completion rollup on parent.
- **failed** — unrecoverable failure. Signals `{type}.failed`. Cascades cancellation to incomplete children.
- **cancelled** — withdrawn, either directly or by cascade from a failed parent.

### Conversation

```
active → concluded
       → abandoned
```

- **active** — conversation is in progress, turns can be taken
- **concluded** — conversation ended normally (turn limit reached or explicitly concluded)
- **abandoned** — conversation ended abnormally (browser disconnect, timeout)

---

## ID Conventions

All entity IDs use the format `{prefix}-{8 hex chars}` where the hex is generated from 4 random bytes (`crypto.randomBytes(4)`).

| Prefix | Entity | Example |
|--------|--------|---------|
| `a-` | Anima | `a-5e6f7a8b` |
| `c-` | Commission | `c-a3f7b2c1` |
| `conv-` | Conversation | `conv-1a2b3c4d` |
| `cpart-` | Conversation participant | `cpart-5e6f7a8b` |
| `evt-` | Event | `evt-1a2b3c4d` |
| `ses-` | Session | `ses-deadbeef` |
| `wrt-` | Writ | `wrt-12345678` |
| `aud-` | Audit log entry | `aud-aabbccdd` |
| `ed-` | Event dispatch | `ed-55667788` |
| `r-` | Roster entry | `r-99aabbcc` |
| `ac-` | Anima composition | `ac-ddeeff00` |
| `ca-` | Commission assignment | `ca-11223344` |

8 hex characters = 4 random bytes ≈ 4.3 billion possibilities per prefix. Sufficient for a single-guild system.

Generation: `generateId(prefix)` from `@shardworks/nexus-core`.
