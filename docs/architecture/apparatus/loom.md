# The Loom — API Contract

Status: **Draft — MVP**

Package: `@shardworks/loom` · Plugin id: `loom`

> **⚠️ MVP scope.** This spec describes the thinnest viable Loom — just enough to get sessions running. It accepts a raw system prompt and passes it through. Role resolution, tool instructions, anima identity, curricula, temperaments, and charter composition are all future work. See [Future: Full Composition](#future-full-composition) for the target design.

---

## Purpose

The Loom weaves session contexts. In its MVP form, it is essentially a pass-through: callers provide the system prompt and initial prompt directly, and The Loom packages them into a `WovenContext` that The Animator can consume.

The Loom exists as a separate apparatus even at MVP so that The Animator never assembles prompts itself. As composition grows more sophisticated, The Loom's internals change but its output shape stays the same — The Animator is unaffected.

---

## Dependencies

```
requires: []    — MVP has no apparatus dependencies
```

---

## `LoomApi` Interface (`provides`)

```typescript
interface LoomApi {
  /**
   * Weave a session context.
   *
   * MVP: packages the caller-provided system prompt and initial prompt
   * into a WovenContext. No composition logic — the caller is responsible
   * for assembling the prompt content.
   */
  weave(request: WeaveRequest): Promise<WovenContext>
}

interface WeaveRequest {
  /** The system prompt to deliver to the AI process. */
  systemPrompt: string
  /** Optional initial user message (e.g. writ description, standing order payload). */
  prompt?: string
}

interface WovenContext {
  /** The system prompt for the AI process. */
  systemPrompt: string
  /** The initial user message, if any. */
  initialPrompt?: string
}
```

That's it. The MVP Loom is a data object factory — it takes strings in and returns a structured context out. The value is in the seam, not the logic.

---

## What The Loom does NOT do (MVP)

- **Resolve roles or tools** — the caller provides the prompt content; The Loom doesn't read guild config.
- **Read files from disk** — no role instructions, no tool instructions, no charter.
- **Look up anima identity** — no identity records exist in MVP.
- **Launch sessions** — that's The Animator's job.

---

## Future: Full Composition

When the session infrastructure matures, The Loom becomes the system's composition engine. The API shape (`weave(request) → WovenContext`) remains stable; the request gains fields and the internals gain logic.

### Future `WeaveRequest`

```typescript
interface WeaveRequest {
  /** The role to compose for. Determines tool set and role instructions. */
  role: string
  /** Optional anima id. Resolves identity → curriculum → temperament. */
  animaId?: string
  /** Optional initial prompt. */
  prompt?: string
  /** Optional writ id. The Loom reads writ context from The Stacks. */
  writId?: string
}
```

### Future `WovenContext`

```typescript
interface WovenContext {
  systemPrompt: string
  initialPrompt?: string
  /** The resolved tool set for this role. */
  tools: ResolvedTool[]
  /** The role this context was woven for. */
  role: string
}
```

### Future composition order

The system prompt is woven by combining, in order:

1. **Guild charter** — institutional policy, applies to all animas
2. **Curriculum** — what the anima knows (versioned, immutable per version)
3. **Temperament** — who the anima is (versioned, immutable per version)
4. **Role instructions** — read from the path in `guild.json` roles config
5. **Tool instructions** — per-tool `instructions.md` for the resolved tool set
6. **Writ context** — the specific work being done

### Future: System Prompt Appendix

The legacy session system supports a `systemPromptAppendix` — additional content appended to the system prompt after manifest assembly. This is used by clockworks to inject session protocol (e.g. writ completion requirements) without modifying the manifest itself.

**Open question:** Does this belong in The Loom or in the caller? Two options:

1. **Loom owns it** — `WeaveRequest` gains an `appendix?: string` field. The Loom appends it after composing the system prompt. Clean: all prompt assembly happens in one place.
2. **Caller owns it** — the caller (summon relay) concatenates the appendix to `WovenContext.systemPrompt` before passing to The Animator. Simple: no Loom changes needed.

The answer depends on whether the appendix is a *composition concern* (part of building the prompt) or a *dispatch concern* (context that only the caller knows). Writ protocol feels like dispatch — the Loom shouldn't need to know about writ lifecycle. But if other appendix use cases emerge (e.g. guild-wide policies injected per-session), it may belong in the Loom.

No decision required for MVP — the appendix feature is not needed until clockworks-driven sessions exist.

### Role Ownership and Permission Grants

The Loom is the owner of role definitions. Roles map to permission grants that the Instrumentarium uses to resolve tool sets. Role configuration lives in `guild.json` under the Loom's plugin id:

```json
{
  "loom": {
    "roles": {
      "artificer": {
        "permissions": ["stdlib:read", "stdlib:write", "stacks:read", "stacks:write"],
        "strict": false
      },
      "scribe": {
        "permissions": ["stdlib:read", "animator:read"],
        "strict": true
      },
      "admin": {
        "permissions": ["*:*"]
      }
    }
  }
}
```

Each role definition contains:

- **`permissions`** — an array of `plugin:level` grant strings. The Instrumentarium uses these to resolve which tools are available. See [The Instrumentarium § Permission Model](./instrumentarium.md#permission-model) for grant format and matching rules.
- **`strict`** (optional, default `false`) — when true, permissionless tools are excluded unless the role has `plugin:*` or `*:*` for that tool's plugin. Useful for locked-down roles that should only see explicitly granted tools.

The Loom resolves an anima's assigned roles into a flat permissions array (union across all roles), then passes it to `instrumentarium.resolve()`. The Instrumentarium is role-agnostic — it never sees role names, only permissions.

### Future dependencies

```
requires: ['stacks', 'tools']
```

- **The Stacks** — reads anima identity records, writ context
- **The Instrumentarium** — resolves the permission-gated tool set and reads tool instructions
