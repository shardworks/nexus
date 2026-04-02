# The Loom — API Contract

Status: **Draft — MVP**

Package: `@shardworks/loom-apparatus` · Plugin id: `loom`

> **⚠️ MVP scope.** This spec covers the seam only — the Loom accepts a role name and returns an `AnimaWeave`, but does not yet compose a system prompt. Role resolution, tool instructions, anima identity, curricula, temperaments, and charter composition are all future work. See [Future: Full Composition](#future-full-composition) for the target design.

---

## Purpose

The Loom weaves anima identity into session contexts. Given a role name, it produces an `AnimaWeave` — the composed identity context that The Animator uses to launch a session. The work prompt (what the anima should do) is not the Loom's concern — it bypasses the Loom and goes directly from the caller to the session provider.

MVP: system prompt composition is not yet implemented — `weave()` returns an empty `AnimaWeave` (systemPrompt undefined). The role is accepted on the API surface but not yet used. The seam exists so The Animator never assembles prompts itself; as composition is built out, The Loom's internals change but its output shape stays the same.

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
   * Weave an anima's session context.
   *
   * Given a role name, produces an AnimaWeave containing the composed
   * system prompt. MVP: returns undefined for systemPrompt.
   */
  weave(request: WeaveRequest): Promise<AnimaWeave>
}

interface WeaveRequest {
  /**
   * The role to weave context for (e.g. 'artificer', 'scribe').
   * MVP: accepted but not used. Future: resolves role instructions,
   * curriculum, temperament, and composes the system prompt.
   */
  role?: string
}

/**
 * The output of The Loom's weave() — the composed anima identity context.
 * Contains the system prompt produced from the anima's identity layers,
 * and environment variables for the session process.
 * The work prompt is not part of the weave.
 */
interface AnimaWeave {
  /** The system prompt for the AI process. Undefined until composition is implemented. */
  systemPrompt?: string
  /**
   * Environment variables for the session process.
   * Derived from role configuration. The Animator merges these with
   * any per-request environment overrides (request overrides weave).
   *
   * Default: git identity derived from the role name.
   *   GIT_AUTHOR_NAME / GIT_COMMITTER_NAME = capitalized role (e.g. "Artificer")
   *   GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL = role@nexus.local
   */
  environment?: Record<string, string>
}
```

The MVP Loom is a stub for system prompt composition — the value is in the seam, not the logic. The contract is stable: as composition is built out, `systemPrompt` gains a value but the shape doesn't change.

The `environment` field is active at MVP: the Loom derives git identity from the role name and populates `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL`. The Animator merges these into the spawned process environment, giving each role a distinct git identity. Orchestrators (e.g. the Dispatch) can override specific variables per-request — for example, setting the email to a writ ID for per-commission attribution.

---

## What The Loom does NOT do (MVP)

- **Compose system prompts** — the role is accepted but not used; systemPrompt is undefined.
- **Resolve roles or tools** — no role instructions, no tool instructions, no charter.
- **Read files from disk** — no file I/O at all.
- **Look up anima identity** — no identity records exist in MVP.
- **Handle work prompts** — the work prompt bypasses the Loom entirely.
- **Launch sessions** — that's The Animator's job.

---

## Future: Full Composition

When the session infrastructure matures, The Loom becomes the system's composition engine. The API shape (`weave(request) → AnimaWeave`) remains stable; the request may gain fields and the internals gain logic.

### Future `WeaveRequest`

```typescript
interface WeaveRequest {
  /** The role to compose for. Determines tool set and role instructions. */
  role: string
  /** Optional anima id. Resolves identity → curriculum → temperament. */
  animaId?: string
  /** Optional writ id. The Loom reads writ context from The Stacks. */
  writId?: string
}
```

### Future `AnimaWeave`

```typescript
interface AnimaWeave {
  systemPrompt: string
  /** The resolved tool set for this role. */
  tools: ResolvedTool[]
  /** Environment variables for the session process. */
  environment?: Record<string, string>
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
2. **Caller owns it** — the caller (summon relay) concatenates the appendix to `AnimaWeave.systemPrompt` before passing to The Animator. Simple: no Loom changes needed.

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

The Loom resolves an anima's assigned roles into a flat permissions array (union across all roles), then passes it to `instrumentarium.resolve()` with `caller: 'anima'` — since the Loom only weaves anima sessions, this is a constant, not a parameter. The Instrumentarium is role-agnostic — it never sees role names, only permissions.

The resolved tool set is returned on the `AnimaWeave` so the Animator can pass it to the session provider for MCP server configuration. The Loom also reads each resolved tool's `instructions.md` and weaves them into the system prompt (see [Future composition order](#future-composition-order)).

### Future dependencies

```
requires: ['stacks', 'tools']
```

- **The Stacks** — reads anima identity records, writ context
- **The Instrumentarium** — resolves the permission-gated tool set and reads tool instructions
