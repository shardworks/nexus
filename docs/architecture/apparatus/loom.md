# The Loom — API Contract

Status: **Draft — MVP**

Package: `@shardworks/loom` · Plugin id: `loom`

---

## Purpose

The Loom weaves session contexts. Given a role (and eventually an anima identity), it assembles the complete system prompt that an AI process receives at session launch: role instructions, tool instructions, and (in future) curricula, temperaments, and the guild charter.

The Loom is a deterministic composition step — no AI, no network, no side effects. It reads files and config, combines them, and returns a structured context object.

---

## Dependencies

```
requires: ['instrumentarium']   — resolves the tool set and reads tool instructions
```

No dependency on The Stacks in MVP (no anima identity records). Will add `requires: ['stacks']` when anima identity is introduced.

---

## `LoomApi` Interface (`provides`)

### MVP

```typescript
interface LoomApi {
  /**
   * Weave a session context for the given role.
   *
   * MVP: returns a fixed composition per role — role instructions file +
   * tool instructions for the resolved tool set. No anima identity,
   * no curriculum, no temperament.
   *
   * Future: accepts an anima id, resolves identity → curriculum →
   * temperament → charter, and weaves all threads into the context.
   */
  weave(request: WeaveRequest): Promise<WovenContext>
}

interface WeaveRequest {
  /** The role to compose for. Determines tool set and role instructions. */
  role: string
  /** Optional initial prompt (e.g. the writ description or standing order payload). */
  prompt?: string
  /** Optional writ context to include. */
  writId?: string
}

interface WovenContext {
  /** The assembled system prompt — everything the AI process needs to know. */
  systemPrompt: string
  /** The initial user message, if any. */
  initialPrompt?: string
  /** The resolved tool set for this role. */
  tools: ResolvedTool[]
  /** The role this context was woven for. */
  role: string
}
```

### Composition order (MVP)

The system prompt is assembled by concatenating, in order:

1. **Role instructions** — read from the file path in `guild.json` roles config (`roles[role].instructions`). If no instructions file is specified, this section is omitted.
2. **Tool instructions** — for each tool in the resolved set that has an `instructions.md`, read the file and append it as a tool-specific section.

### Future composition threads

When anima identity and training content are introduced, the weaving order becomes:

1. Guild charter (institutional policy — applies to all animas)
2. Curriculum content (what the anima knows — versioned, immutable)
3. Temperament content (who the anima is — versioned, immutable)
4. Role instructions (role-specific guidance)
5. Tool instructions (per-tool craft guidance)
6. Writ context (the specific work being done)

The Loom's API shape (`weave(request) → WovenContext`) does not change when these threads are added — the caller always receives a complete context regardless of how many threads were woven.

---

## What The Loom does NOT do

- **Launch sessions** — that's The Animator's job.
- **Resolve tools** — that's The Instrumentarium's job. The Loom calls `instrumentarium.resolve()` to get the tool set.
- **Manage anima identity** — future work. MVP has no identity records.
- **Make judgment calls** — The Loom is purely mechanical. Same inputs always produce the same output.

---

## Open Questions

- **Writ context.** How does the writ's description/context get into the woven prompt? Does The Loom read it from The Stacks directly, or does the caller pass it in the `WeaveRequest`? MVP: caller passes it as `prompt`. Future: The Loom may read writ details from The Stacks if a `writId` is provided.
- **Charter location.** Where does the guild charter live on disk? Currently unspecified. Likely a well-known path in the guild root (e.g. `charter.md`), read by The Loom at weave time.
- **Caching.** Should The Loom cache role instructions and tool instructions between weave calls? Probably yes for performance, with invalidation on guild config change. Not needed for MVP.
