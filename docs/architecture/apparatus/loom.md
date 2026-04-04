# The Loom — API Contract

Status: **Active — Layers 1, 4, 5**

Package: `@shardworks/loom-apparatus` · Plugin id: `loom`

---

## Purpose

The Loom weaves anima identity into session contexts. Given a role name, it produces an `AnimaWeave` — the composed identity context that The Animator uses to launch a session. The work prompt (what the anima should do) is not the Loom's concern — it bypasses the Loom and goes directly from the caller to the session provider.

System prompt composition is active for layers 1 (guild charter), 4 (role instructions), and 5 (tool instructions). The Loom reads charter and role instruction files at startup and caches them; tool instructions come from the Instrumentarium's pre-loaded tool definitions. Layers 2 (curriculum) and 3 (temperament) remain future work.

---

## Dependencies

```
requires: ['tools']    — needs the Instrumentarium for tool resolution and tool instructions
```

---

## `LoomApi` Interface (`provides`)

```typescript
interface LoomApi {
  /**
   * Weave an anima's session context.
   *
   * Given a role name, produces an AnimaWeave with a composed system prompt,
   * resolved tool set, and git identity environment variables.
   */
  weave(request: WeaveRequest): Promise<AnimaWeave>
}

interface WeaveRequest {
  /**
   * The role to weave context for (e.g. 'artificer', 'scribe').
   * Determines tool resolution and role instructions. When omitted,
   * only charter content is included in the system prompt.
   */
  role?: string
}

/**
 * The output of The Loom's weave() — the composed anima identity context.
 * Contains the system prompt, resolved tool set, and environment variables.
 * The work prompt is not part of the weave.
 */
interface AnimaWeave {
  /**
   * The system prompt for the AI process. Composed from guild charter,
   * tool instructions, and role instructions. Undefined when no
   * composition layers produce content.
   */
  systemPrompt?: string
  /** The resolved tool set for this role. Undefined when no role is specified or no tools match. */
  tools?: ResolvedTool[]
  /**
   * Environment variables for the session process.
   * Derived from role configuration. The Animator merges these with
   * any per-request environment overrides (request overrides weave).
   *
   * Default: git identity derived from the role name.
   *   GIT_AUTHOR_NAME = capitalized role (e.g. "Artificer")
   *   GIT_AUTHOR_EMAIL = role@nexus.local
   */
  environment?: Record<string, string>
}
```

The `environment` field is active at MVP: the Loom derives git identity from the role name and populates `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`. The committer identity is intentionally left to the system default so that commit signatures remain verified on GitHub. The Animator merges these into the spawned process environment, giving each role a distinct author identity. Orchestrators (e.g. the Dispatch) can override specific variables per-request — for example, setting the email to a writ ID for per-commission attribution.

---

## What The Loom does NOT do

- **Compose curricula or temperaments** — layers 2 and 3 remain future work.
- **Look up anima identity** — no identity records exist yet.
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

### Composition order

The system prompt is woven by combining active layers in order:

1. **Guild charter** ✅ active — `charter.md` or `charter/*.md` at the guild root
2. **Curriculum** — future work (what the anima knows)
3. **Temperament** — future work (who the anima is)
4. **Role instructions** ✅ active — `roles/{role}.md` relative to the guild root
5. **Tool instructions** ✅ active — `definition.instructions` from resolved tools, formatted as `## Tool: {name}`
6. **Writ context** — future work (the specific work being done)

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
