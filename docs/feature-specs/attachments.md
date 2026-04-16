# Attachments — Design Specification

Status: **Design-only**. Implementation is a follow-on commission.

Tracking click: `c-mo1uudrr-31227f89d49c`
Motivating case study: `c-mo1uucfo-85bb90ad6357`

---

## 1. Purpose

Give rich, long-form content generated during design work a durable home inside the Stacks substrate. Today, material that doesn't fit a click's atomic `goal + conclusion` (YAML sketches, open-question enumerations, evidence snippets, extended rationale, reference material, discarded-idea detail) lives either on the filesystem (`.scratch/`, `docs/design-notes/`) where it drifts and isn't queryable, or in archived writ bodies (`docs/archive/quests/`) where it's orphaned from the click graph that replaced it. Neither home inherits the substrate properties the rest of the guild relies on: versioning, CDC propagation, queryability, concrete entity identity.

The **attachment primitive** is a sibling concept alongside clicks and writs. It is not an extension of either record. It is a standalone, addressable, Stacks-resident record with its own lifecycle and its own tooling, linked to host records (clicks, writs, and — in the future — others) through an explicit typed link table.

**What an attachment is:** a named, kinded blob of text with a concrete ID, an author session, timestamps, and one or more links back to host records.

**What an attachment is not:** a binary file store (no images, PDFs, compiled artifacts), a generic CMS (no rich formatting beyond Markdown), a replacement for either click conclusions or writ bodies.

---

## 2. Positioning and Constraints

### Sibling, not extension

The click schema (`goal`, `conclusion`, four statuses, immutable on create) and the writ schema (`title`, `body`, lifecycle) are intentionally lean. Growing either to hold rich material would bloat the decision graph and obligation ledger at exactly the edges where leanness pays off. Attachments are a separate book with their own CRUD surface; host records reference attachments by link, not by embedded field.

### Reuses existing infrastructure

- **Persistence:** attachments live in two new Stacks books owned by a new apparatus. No parallel store.
- **CDC:** attachment writes fire standard Stacks CDC events. The Oculus and Clockworks consume them through the same handler registry that observes clicks and writs.
- **ID format:** `a-{base36_timestamp}{hex_random}` via `generateId('a', 6)`, matching the click/writ scheme.

### Tier-of-decision notes

Per the commission, Tier 1-3 decisions are made here with defaults. Tier 4 (value-laden) decisions are flagged for ratification in §13.

---

## 3. Data Model

Two books, owned by a new apparatus:

### 3.1 `attachments` book

| Field | Type | Mutable | Description |
|-------|------|---------|-------------|
| `id` | `string` | no | `a-{...}` generated at create time |
| `kind` | `string` | yes | Domain semantic tag: `design-sketch`, `open-questions`, `evidence`, `rationale`, `reference`, `scratch`, or kit-contributed values. Free-form string; apparatus does not enforce a closed set but recommends the MVP vocabulary. |
| `title` | `string` | yes | Short human-readable label (required, trimmed to 1-200 chars) |
| `body` | `string` | yes | The content. See §6 for format and size bounds. |
| `contentType` | `string` | yes | MIME-style content type. Default: `text/markdown`. Other recommended: `application/yaml`, `text/plain`, `application/json`. |
| `frozen` | `boolean` | yes | See §5.3. Default false. |
| `createdSessionId` | `string?` | no | Session that created the attachment (for join key to transcripts). |
| `lastEditSessionId` | `string?` | yes | Session of the most recent mutation. |
| `createdAt` | `ISO string` | no | |
| `updatedAt` | `ISO string` | yes | Bumped on every mutation. |

### 3.2 `attachment_hosts` book

The link table that binds attachments to host records. This is a separate book (not an inlined field on the attachment) so the same attachment can live under multiple hosts — e.g., an evidence snippet that motivated both a click and the mandate commissioned from it.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Composite: `{attachmentId}:{hostType}:{hostId}:{relation}` |
| `attachmentId` | `string` | FK into `attachments` |
| `hostType` | `string` | `click`, `writ`, or another value contributed by a kit (see §4) |
| `hostId` | `string` | The host record's ID |
| `relation` | `string` | Typed relationship. MVP set: `attached`, `supersedes-body-of`, `migrated-from`. Default: `attached`. |
| `createdAt` | `ISO string` | |

**Composite ID rationale:** makes the link inherently idempotent — re-creating the same `(attachment, host, relation)` tuple is a no-op. Matches the pattern already used by `ClickLinkDoc.id` in the Ratchet (`${sourceId}:${targetId}:${linkType}`).

**Indexes:**

```typescript
attachments: {
  indexes: [
    'kind',
    'createdAt',
    'updatedAt',
    'createdSessionId',
    'frozen',
    ['kind', 'updatedAt'],
  ],
},
attachment_hosts: {
  indexes: [
    'attachmentId',
    'hostId',
    'hostType',
    'relation',
    ['hostType', 'hostId'],
    ['hostId', 'relation'],
    ['attachmentId', 'relation'],
  ],
},
```

---

## 4. Apparatus Boundary

**Default decision (Tier 3):** introduce a new apparatus — `@shardworks/attachments-apparatus`, plugin id `attachments`. It owns both books, exposes an `AttachmentsApi`, and contributes CLI/MCP tools.

Rationale for a new apparatus rather than baking into the Stacks:

- Stacks must stay domain-neutral. Adding an `AttachmentsApi` to Stacks would couple storage to a specific content concept.
- The cascade rules (freeze on host terminal state, see §5) are domain-specific behavior that belongs alongside the domain type, not in the generic persistence layer.
- Keeps the apparatus dependency graph explicit: `stacks <- attachments <- ratchet|clerk consumers`.

Rationale for a new apparatus rather than letting each host-owning apparatus own its own attachments book:

- Attachments would then fragment by host type, defeating the many-to-many property (same attachment referenced by a click and the writ it commissioned).
- Migration and cross-host queries ("all attachments authored by session X regardless of host") become cross-book joins.
- Tool/CLI surface would duplicate across host apparatus.

**Host-type registration via kit contribution.** Apparatus that host attachments declare a `hostsAttachments` kit contribution:

```typescript
// Inside the Ratchet or Clerk's supportKit
hostsAttachments: {
  click: {
    // Apparatus that resolves host IDs to validate existence on link.
    resolvedBy: 'ratchet',
  },
},
```

```typescript
// Inside the Clerk's supportKit
hostsAttachments: {
  writ: {
    resolvedBy: 'clerk',
  },
},
```

At startup the attachments apparatus reads all `hostsAttachments` contributions and builds a host-type registry. When a link is created, the apparatus checks whether `hostType` is registered and (optionally) validates host existence by calling the registered resolver's API. Unknown host types are rejected at link time.

**Extensibility.** Sessions, ethnography artifacts, or other substrates gain attachment support simply by contributing a `hostsAttachments` entry — no schema change, no core changes. This satisfies the commission's requirement that the design accommodate extension beyond clicks and writs.

---

## 5. Lifecycle

### 5.1 Create

`attachments.create({ kind, title, body, contentType?, sessionId?, attachTo? })` — creates the attachment, and if `attachTo` is provided, creates the corresponding `attachment_hosts` link atomically in the same transaction. The common case (create-and-attach in one step) is a single API call. `attachTo` accepts either a single `{ hostType, hostId, relation? }` or an array for multi-host attachment at birth.

### 5.2 Update

`attachments.update(id, patch)` — partially updates mutable fields. Writes bump `updatedAt`. Rejected if the attachment is `frozen` (see §5.3).

Updates are **in-place mutations**, not new versions. History-level auditability is provided by the CDC event stream (every `update` event carries `prev`), not by in-database version records. This is the same policy used by clicks and writs — they don't version their own records either; the CDC log + session transcripts + git are the change history.

**Rationale for in-place over versioned records:** the substrate already provides change history through CDC `prev`. Adding an in-band version table would double storage for content whose typical edit pattern is "draft, refine once or twice, then freeze when host terminalizes." If a use case emerges for point-in-time recall of prior attachment states (e.g., "show me the attachment as it existed when the host was concluded"), that is future work — see §11.

### 5.3 Freeze (cascade from host terminal state)

When a host record reaches a terminal state (click: `concluded`/`dropped`; writ: `completed`/`failed`/`cancelled`), all attachments linked to it by `attached` relation are **frozen**: `frozen` set to true, further `update()` calls are rejected. Frozen attachments can still be read, linked to new hosts, or deleted.

Implementation: the attachments apparatus registers a Phase-1 CDC handler on each host book (discovered through the `hostsAttachments` kit registry). When it sees a transition to a terminal state, it patches all non-frozen attachments linked to that host. This is the canonical example of a cross-apparatus cascade — the kind the Stacks' transactional CDC was designed for.

**Why freeze rather than full immutability?** A design sketch attached to a concluded click should not be silently editable six months later, because the decision record says "this is what we had in hand when we concluded." But the same sketch may also be linked to a still-live mandate that hasn't been executed. An attachment's freeze status is per-attachment (not per-link), so once *any* linked host terminalizes, the attachment is frozen regardless of other live hosts. The conservative rule avoids accidental history revision.

If editability post-freeze is required (e.g., typo fix), the answer is: delete the frozen attachment and create a new one linked to the relevant hosts, with a `supersedes` link from the new to the old. Explicit trail, no silent revision.

### 5.4 Delete

`attachments.delete(id, opts?)` — deletes the attachment record.

Two modes:
- **Soft detach (default).** If the attachment has live host links, refuse unless `force: true`. Instead, the caller should use `unlink()` to remove the specific link and leave the attachment with its other hosts. If the final link is unlinked, the attachment remains in the book (orphan, queryable by `hostless` predicate) rather than being silently garbage-collected.
- **Force delete (`force: true`).** Removes the attachment record and all `attachment_hosts` rows pointing at it, atomically. Frozen attachments require `force: true` by definition.

**Why not auto-GC orphans?** The CDC event from the last `unlink` is a legible "this attachment is now orphaned" signal that external observers (Oculus, audit tooling) can act on. Automatic deletion inside an `unlink` handler would hide that signal and also block scenarios like "detach now, attach to something else later."

### 5.5 Host deletion

Host records are rarely deleted in the current substrate (clicks and writs both lean on terminal statuses rather than deletion). But the attachments apparatus must handle the case: a Phase-1 CDC handler on each host book watches for `delete` events and cascades by removing the corresponding `attachment_hosts` rows. Attachment records are **not** deleted in this cascade — they become orphaned (see §5.4). The host's `prev` field carries the ID, so the cascade is just a `find({ where: [['hostId', '=', prev.id], ['hostType', '=', 'click']] })` + `delete` loop, atomic with the host's deletion.

---

## 6. Content Format and Size Bounds

### 6.1 Format

Default content type: `text/markdown`. The apparatus does not parse or render — it stores the string verbatim. Rendering is a consumer concern (Oculus, CLI extract).

Other recommended content types, all textual:
- `application/yaml` — for structured design sketches
- `application/json` — for machine-readable references (e.g., captured tool outputs)
- `text/plain` — for raw logs or excerpts

**Why not opaque bytes?** Keeping content textual keeps `LIKE`-based search viable, keeps the SQLite row size within sane bounds, and avoids base64 bloat. If a future use case needs binary blobs (images, PDFs), that is a separate primitive — the `attachments` book should not absorb it, because the query and size tradeoffs are different.

### 6.2 Size bounds

- **Soft warning:** 32 KB per attachment body. Tooling should surface the warning at CLI, but the write succeeds.
- **Hard limit:** 256 KB per attachment body. Writes above this are rejected with a descriptive error.
- **Enforcement:** pre-validated in the apparatus's `create`/`update` methods before the Stacks write.

**What falls out of scope:** any single piece of content larger than 256 KB. If a design note needs multi-megabyte artifacts (captured screenshots, compiled traces, large data dumps), the correct home is the filesystem (or a dedicated blob store in a future primitive), referenced from an attachment via URL or relative path. The attachment body holds the narrative; the bulky reference is external.

**Why these numbers?** The typical `docs/archive/quests/*.json` body is 4-40 KB. 64 KB covers the long tail of design prose. 256 KB is the point at which a single SQLite row starts to feel heavy and at which `LIKE` scans degrade noticeably. These are not load-tested numbers; they are informed defaults that the implementation commission should validate. See §13 for the Tier-4 lift.

### 6.3 Multiple attachments as the composition primitive

A design session generates several distinct artifacts — sketch, open questions, evidence, rationale — and the natural model is several attachments linked to the same host, not one omnibus attachment. The `kind` field carries the semantic role. This keeps individual attachments within size bounds, keeps queries like "show me all open-questions attachments across the guild" trivial, and keeps freezing granularity per-artifact.

---

## 7. Query Surface

Canonical queries and their indexes:

| Query | Mechanism | Indexed fields |
|-------|-----------|----------------|
| All attachments for a host | `attachment_hosts.find(where: [['hostType','=','click'], ['hostId','=',id]])` → `attachments.get(id)` per link | `['hostType','hostId']` |
| All hosts for an attachment | `attachment_hosts.find(where: [['attachmentId','=',id]])` | `attachmentId` |
| Attachments by kind | `attachments.find(where: [['kind','=','open-questions']], orderBy: [['updatedAt','desc']])` | `['kind','updatedAt']` |
| Recently updated | `attachments.find(orderBy: [['updatedAt','desc']], limit: 20)` | `updatedAt` |
| Attachments authored by session | `attachments.find(where: [['createdSessionId','=',sid]])` | `createdSessionId` |
| Orphaned (no links) | `attachments.find(...)` + counter on `attachment_hosts` (two-query) | composite |
| Text search | `attachments.find(where: [['body','LIKE','%term%']])` — full scan | — |

**Dedicated text search index?** Not for MVP. `LIKE` is adequate for a book expected to stay in the low thousands for years. SQLite FTS5 is a natural upgrade path — implementable behind the same `find()` surface by routing `LIKE` patterns containing wildcards to an FTS virtual table. Deferred. See §11.

---

## 8. CDC Propagation

Attachments use standard Stacks CDC — no parallel event stream. Writes to both books fire `create` / `update` / `delete` events through the same two-phase model clicks and writs use.

### 8.1 Phase-1 handlers (owned by this apparatus)

- **Host terminal-state cascade (freeze).** On each host book, watch for status transitions into terminal states, patch all linked attachments to `frozen: true`. Atomic with the host write.
- **Host delete cascade (unlink).** On each host book, watch `delete` events, remove `attachment_hosts` rows pointing at the deleted host. Atomic with the host delete.
- **Attachment delete cascade (unlink).** On the `attachments` book, watch `delete` events, remove all `attachment_hosts` rows with that `attachmentId`. Atomic with the attachment delete.

### 8.2 Phase-2 handlers (emitted externally)

Clockworks events emitted by the apparatus's Phase-2 observers, using the standard `book.{owner}.{name}.{verb}` pattern the Oculus already consumes:

- `book.attachments.attachments.created|updated|deleted`
- `book.attachments.attachment_hosts.created|deleted`

Plus domain-level events suitable for standing orders:

- `attachment.attached` — fired when an `attachment_hosts` row is created.
- `attachment.detached` — fired when an `attachment_hosts` row is deleted.
- `attachment.frozen` — fired when `frozen` transitions false→true.

### 8.3 Oculus propagation

No Oculus changes required for the base propagation — Oculus's standard book-change event subscription picks up attachment writes automatically. A future Oculus view that renders attachments alongside clicks/writs is separate work.

---

## 9. `AttachmentsApi` Interface (`provides`)

```typescript
type AttachmentKind = string  // e.g. 'design-sketch' | 'open-questions' | 'evidence' | 'rationale' | 'reference' | 'scratch'
type AttachmentRelation = 'attached' | 'supersedes-body-of' | 'migrated-from' | string

interface AttachmentDoc {
  id: string
  kind: AttachmentKind
  title: string
  body: string
  contentType: string
  frozen: boolean
  createdSessionId?: string
  lastEditSessionId?: string
  createdAt: string
  updatedAt: string
}

interface AttachmentHostDoc {
  id: string
  attachmentId: string
  hostType: string
  hostId: string
  relation: AttachmentRelation
  createdAt: string
}

interface HostRef {
  hostType: string
  hostId: string
  relation?: AttachmentRelation  // default 'attached'
}

interface CreateAttachmentRequest {
  kind: AttachmentKind
  title: string
  body: string
  contentType?: string             // default 'text/markdown'
  sessionId?: string
  attachTo?: HostRef | HostRef[]
}

interface UpdateAttachmentRequest {
  kind?: AttachmentKind
  title?: string
  body?: string
  contentType?: string
  sessionId?: string               // becomes lastEditSessionId
}

interface AttachmentFilters {
  kind?: AttachmentKind | AttachmentKind[]
  hostType?: string                // requires scanning attachment_hosts first
  hostId?: string
  createdSessionId?: string
  frozen?: boolean
  limit?: number
  offset?: number
}

interface AttachmentsApi {
  /** Create a new attachment. If attachTo is provided, also creates the link(s) atomically. */
  create(params: CreateAttachmentRequest): Promise<AttachmentDoc>

  /** Fetch a single attachment. Throws if not found. */
  get(id: string): Promise<AttachmentDoc>

  /** List attachments with filters. */
  list(filters?: AttachmentFilters): Promise<AttachmentDoc[]>

  /** Update mutable fields. Rejected if frozen. */
  update(id: string, params: UpdateAttachmentRequest): Promise<AttachmentDoc>

  /** Delete an attachment. Requires force:true when links exist or when frozen. */
  delete(id: string, opts?: { force?: boolean }): Promise<void>

  /** Freeze an attachment explicitly (idempotent). */
  freeze(id: string): Promise<AttachmentDoc>

  /** Create a host link. Idempotent via composite ID. */
  attach(params: {
    attachmentId: string
    hostType: string
    hostId: string
    relation?: AttachmentRelation
  }): Promise<AttachmentHostDoc>

  /** Remove a host link. */
  detach(params: {
    attachmentId: string
    hostType: string
    hostId: string
    relation?: AttachmentRelation  // default 'attached'
  }): Promise<void>

  /** List attachments for a given host, ordered by createdAt asc. */
  forHost(hostType: string, hostId: string): Promise<AttachmentDoc[]>

  /** List hosts for a given attachment. */
  hostsOf(attachmentId: string): Promise<AttachmentHostDoc[]>

  /** Resolve a short-ID prefix, matching the Ratchet pattern. */
  resolveId(prefix: string): Promise<string>
}
```

---

## 10. Tools (Support Kit)

MCP and CLI tools, following the noun-verb convention. All accept short-ID prefixes where an ID is expected.

| Tool | Purpose |
|------|---------|
| `attachment-create` | Create an attachment. Accepts `--body` inline or `--body-file path` for larger content. Optional `--attach-to host-ref` (repeatable). |
| `attachment-show` | Print a single attachment with metadata and hosts list. |
| `attachment-list` | List attachments with filters (`--kind`, `--host-id`, `--session`, `--frozen`, `--limit`). |
| `attachment-update` | Partial update; rejected if frozen. `--body-file` supported. |
| `attachment-delete` | Delete; requires `--force` when linked or frozen. |
| `attachment-attach` | Add a host link. |
| `attachment-detach` | Remove a host link. |
| `attachment-for-host` | List attachments bound to a given host (convenience). |
| `attachment-extract` | Print an attachment's body verbatim to stdout (pipe-friendly). |

---

## 11. Migration Path

### 11.1 Scope

The commission's acceptance signal calls for a described migration path, not executed migration. The target content is:

- `docs/archive/quests/*.json` — archived writ bodies that contain exactly the kind of rich design content attachments serve.
- `docs/design-notes/*` and ad-hoc `.scratch/` files — off-substrate content that should move onto the substrate.

### 11.2 Approach

A one-shot migration tool (`attachment-migrate` or a kit-contributed apparatus tool) reads source files, creates attachments, and links them to a designated host:

1. **Identify target host.** For each archived quest file, the click that supersedes it (the commission provides the worked example: archived quest `w-mo0v636y-41c8aeff857f.json` → click `c-mo1mq93f-a8d85ce47baf`).
2. **Decompose the body into attachments.** A single archived writ body typically contains: the original commission brief, open-question enumerations, design sketches, rationale, and possibly diffs or captured output. Rather than dumping the entire JSON as one attachment, split by section where the structure is obvious and by whole-document otherwise.
3. **Assign `kind` per section.** The MVP kind vocabulary (`design-sketch`, `open-questions`, `evidence`, `rationale`, `reference`, `scratch`) covers the common cases.
4. **Create with `relation: 'migrated-from'`.** This is a first-class relation type so the migration provenance stays queryable. The original file path is embedded in the attachment title or as a `references` attachment-of-attachments (out of scope for MVP — a future `attachment_links` book, or a convention encoded in the body).
5. **Leave the source file in place.** Migration is additive — the archived JSON stays on disk for provenance; it is also preserved in git history regardless. A future pass can archive the files under a `migrated/` subdirectory once the substrate is the canonical home.

### 11.3 Worked example: `w-mo0v636y-41c8aeff857f.json` → click `c-mo1mq93f-a8d85ce47baf`

This file is referenced by the commission as a representative archived quest. Its typical shape (inferred from the archive convention and the spec's description) is a JSON object with a writ's `title`, `body`, `resolution`, and some timestamps. The body is the rich material; the wrapper metadata is disposable once the content is attached.

Expressed as attachments under the target click:

```
attachment a-XXXXXXX1
  kind:         reference
  title:        "Original commission brief — w-mo0v636y"
  contentType:  text/markdown
  body:         <writ.body, verbatim, possibly trimmed of boilerplate>
  frozen:       true (click c-mo1mq93f is concluded)
  links:
    - attachment_hosts:
        hostType: click
        hostId:   c-mo1mq93f-a8d85ce47baf
        relation: migrated-from

attachment a-XXXXXXX2        (only if the body had a distinct open-questions section)
  kind:         open-questions
  title:        "Open questions carried forward from w-mo0v636y"
  contentType:  text/markdown
  body:         <extracted questions section>
  frozen:       true
  links:
    - attachment_hosts:
        hostType: click
        hostId:   c-mo1mq93f-a8d85ce47baf
        relation: attached

attachment a-XXXXXXX3        (only if the body had a distinct resolution/rationale section)
  kind:         rationale
  title:        "Resolution rationale from w-mo0v636y"
  contentType:  text/markdown
  body:         <writ.resolution, or the rationale section of the body>
  frozen:       true
  links:
    - attachment_hosts:
        hostType: click
        hostId:   c-mo1mq93f-a8d85ce47baf
        relation: attached
```

After migration:
- `ratchet click-show c-mo1mq93f` reports `Attachments: 3` via an optional Oculus/CLI enhancement that reads `attachments.forHost('click', id)`.
- `attachments.forHost('click', 'c-mo1mq93f-a8d85ce47baf')` returns the three attachments in `createdAt` order.
- The full content is queryable: `attachments.list({ kind: 'open-questions' })` surfaces this entry alongside all other open-questions attachments across the guild.

### 11.4 Migration tool surface (sketch)

```
attachment-migrate --source <path-or-glob> --host-type click --host-id <id> \
                   [--kind <default-kind>] [--split-on h1|h2|sections|none] \
                   [--dry-run]
```

- `--split-on` controls whether the migrator splits a single source into multiple attachments. Default `none` (one attachment per source file).
- `--dry-run` prints the attachments it would create without writing.

Implementation: parse source → compute attachment(s) → `attachments.transaction(tx => ...)` with create+attach per attachment. Transactional so a partial migration never leaves orphan links.

**Implementation is out of scope** for this commission; tooling-level work lands with or after the attachments apparatus.

---

## 12. Acceptance-Test Outline

Scenarios the implementation commission must cover. Each is a separate test or test group; all run against both the SQLite and in-memory Stacks backends via the conformance harness.

### 12.1 CRUD fundamentals

- **Create & read.** Create an attachment; `get` returns it with all fields present and correctly typed.
- **Create with host.** Create with `attachTo`; verify both the attachment and the `attachment_hosts` row exist atomically (drop the transaction mid-create and verify neither is persisted).
- **Update mutable fields.** Patch `title`, `body`, `kind`; verify `updatedAt` is bumped and `createdAt` is unchanged.
- **Delete unlinked.** Delete an attachment with no links; succeeds without `force`.
- **Delete linked without force.** Throws. Attachment and links remain.
- **Delete linked with force.** Removes both the attachment and all its `attachment_hosts` rows atomically.

### 12.2 Links (many-to-many)

- **Attach same attachment to multiple hosts.** Verify `hostsOf` returns all links; `forHost` on each host returns the attachment.
- **Detach one host.** Verify the attachment persists with remaining links; `forHost` on detached host returns nothing.
- **Idempotent attach.** Re-creating the same `(attachment, host, relation)` tuple is a no-op and returns the existing record.
- **Unknown host type.** `attach` with a `hostType` not registered by any kit is rejected.

### 12.3 Freeze cascade

- **Concluding a click freezes its attachments.** Create a click, attach two attachments, conclude the click; verify both attachments have `frozen: true`.
- **Frozen attachment rejects updates.** `update()` on a frozen attachment throws a descriptive error.
- **Frozen attachment still accepts new links.** A frozen attachment can be attached to a new (non-terminal) host.
- **Freeze is per-attachment, not per-link.** An attachment linked to both a concluded click and a live writ is frozen.
- **Transaction atomicity.** If the freeze cascade fails mid-way (simulated), the host transition rolls back.

### 12.4 Host delete cascade

- **Deleting a host removes links.** Delete a click with two attached attachments; verify the `attachment_hosts` rows are gone and the attachments are orphaned (not deleted).

### 12.5 Size bounds

- **Under 32 KB.** Creates silently.
- **Between 32 KB and 256 KB.** Creates; verify a warning is surfaced at the CLI tool layer (not an exception).
- **Over 256 KB.** Rejected with a size-limit error.

### 12.6 CDC propagation

- **Phase-2 events fire.** Register a test observer on `book.attachments.attachments.created`; verify it receives the expected event with the new entry.
- **Coalescing.** Create + update in one transaction produces a single `create` event with the final state.
- **Domain events.** `attachment.attached` and `attachment.frozen` fire at the right moments.

### 12.7 Query surface

- **By host.** `forHost` returns exactly the attachments linked to the host, in `createdAt` ascending order.
- **By kind.** `list({ kind: 'open-questions' })` returns only those attachments.
- **Text search.** `list({ bodyLike: '%term%' })` — if/when exposed as a filter — returns matches.
- **Orphaned.** A helper query for `attachments with no links` returns the expected set.

### 12.8 Migration

- **Single-file migration.** Run `attachment-migrate --source X --host-type click --host-id Y` with a fixture file; verify one attachment with `relation: migrated-from` is created and linked.
- **Dry run.** `--dry-run` produces no writes.

---

## 13. Open Questions (Tier-4 — surface for ratification)

These decisions involve guild vocabulary or policy that benefits from patron input. Implementation should proceed with the stated defaults; patron can retune before stabilization.

- **Apparatus name.** Default: `attachments`. Alternatives considered: `vellum`, `folio`, `exhibits`, `marginalia`. `attachments` is plain and matches the commission's vocabulary; a more evocative name (matching the guild metaphor) could be adopted later via rename if preferred.
- **Kind vocabulary.** Default MVP set: `design-sketch`, `open-questions`, `evidence`, `rationale`, `reference`, `scratch`. Field is free-form, so this is guidance not enforcement. Patron may prefer a tighter or looser set.
- **Size bounds.** Default: 32 KB warning / 256 KB hard. These are informed guesses; no load testing yet. A patron priority on larger design artifacts could shift the ceiling.
- **Freeze policy.** Default: auto-freeze when *any* linked host terminalizes. Alternative: only freeze when *all* linked hosts terminalize, or never auto-freeze (explicit freeze only). The conservative default errs toward history preservation; a less strict policy might be preferred in practice.
- **Host deletion policy.** Default: cascade unlink only; attachments survive as orphans. Alternative: hard-delete orphaned attachments in the same transaction. The default is conservative.

---

## 14. Deferred — Post-MVP

Known future work not blocking v1.

- **Version history as a first-class record.** A second book `attachment_versions` that captures full pre-update snapshots. Useful if "show the attachment as it existed at host conclusion" becomes a concrete requirement. Deferred — CDC `prev` covers current needs.
- **SQLite FTS5 index on `body`.** Drop-in improvement when attachment counts grow large or when `LIKE` scans become the bottleneck.
- **Binary blob primitive.** A separate `artifacts` book (or filesystem-blob primitive) for images, PDFs, traces, large data. Deliberately not attachments, because the query/size/format tradeoffs differ.
- **Oculus attachments view.** Render attachments alongside click and writ detail views. Uses the same book-change event subscription the Oculus already relies on.
- **Attachment-to-attachment links.** If attachments need to reference each other (e.g., "this evidence attachment supports that rationale attachment"), add a small `attachment_links` book mirroring `click_links`.
- **Content-type-aware rendering.** The Oculus or CLI could render `application/yaml` attachments with syntax highlighting, `application/json` with pretty-printing, etc. Apparatus stays dumb; rendering is a consumer concern.
- **Quota and retention policy.** If attachment volume outgrows expectations, a per-guild size cap or per-host retention policy would be natural. No signal yet that this is needed.

---

## 15. References

- Tracking click: `c-mo1uudrr-31227f89d49c`
- Motivating case study (backfill): `c-mo1uucfo-85bb90ad6357`
- Current click schema: `packages/plugins/ratchet/src/types.ts`
- Stacks spec: `packages/plugins/stacks/docs/specification.md`, `docs/architecture/apparatus/stacks.md`
- Clerk (writ) spec: `docs/architecture/apparatus/clerk.md`
- Ratchet (click) spec: `docs/architecture/apparatus/ratchet.md`
- Archive exemplar: `docs/archive/quests/w-mo0v636y-41c8aeff857f.json`
- Feature-spec conventions: `docs/feature-specs/`
- Apparatus template: `docs/architecture/apparatus/_template.md`

---

## 16. Summary for the Follow-on Implementation Commission

**Build an `@shardworks/attachments-apparatus` package** providing:

1. Two books (`attachments`, `attachment_hosts`) with the declared indexes.
2. `AttachmentsApi` as specified in §9.
3. Phase-1 CDC handlers for host freeze cascade, host delete cascade, and attachment delete cascade (§5, §8).
4. Phase-2 event emission for the domain events in §8.2.
5. Support-kit tools enumerated in §10.
6. Host-type registration via `hostsAttachments` kit contribution (§4), consumed from the Ratchet and Clerk support kits (those two packages gain a small `hostsAttachments` declaration as part of the same commission).
7. Unit and conformance tests covering §12.
8. Package README following `docs/DEVELOPERS.md` standards.
9. An architecture spec at `docs/architecture/apparatus/attachments.md`, extracted from this design document.

**Not in the implementation commission:** migrating existing archive content (§11 is descriptive), Oculus attachment views (§14), attachment-to-attachment links (§14), binary blob support (§14).

Any Tier-4 deviations from the defaults in §13 should be surfaced to the patron before implementation begins. Otherwise, proceed with the defaults as stated.
